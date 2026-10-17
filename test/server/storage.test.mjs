/**
 * Адаптеры хранилища (server/document/storage): один контракт — память и
 * Postgres. Главное здесь — семантика commitTx (SPEC §9.4, п.3): номер головы
 * не уходит вперёд без записи, повтор tx_id отдаёт сохранённое, чужой номер
 * головы даёт stale, а не запись «не туда».
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, ENGINE_VERSION, uid, ops } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { compactDropped, chainNext } from '../../server/document/storage/committed.js';
import { viaStorage, DocError, setStorageLog } from '../../server/document/errors.js';
import { backends, pgStorage } from './helpers.mjs';

const E = ENGINE_VERSION;
const record = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, dropped: [], notes: [], author_kind: 'human', engine: E, ...extra });

const list = await backends();

for (const backend of list) {
  describe(`storage · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let storage;
    before(async () => {
      // pg — своя временная база этого файла (helpers.mjs): чистить нечего, чужого не трогаем
      storage = backend.name === 'pg' ? pgStorage() : createMemoryStorage();
      await storage.init();
    });
    after(async () => {
      await storage.close();
    });

    it('createProject пишет снимок seq 0; getProject/listProjects/renameProject', async () => {
      const doc = createDoc('empty');
      const p = await storage.createProject({ name: 'Один', kind: 'design', doc, engine: E });
      assert.match(p.id, /^[0-9a-f-]{36}$/);
      assert.equal(p.head_seq, 0);
      assert.equal(p.engine, E);
      assert.equal(typeof p.updated_at, 'string');
      const snap = await storage.latestSnapshot(p.id);
      assert.equal(snap.seq, 0);
      assert.equal(snap.doc.root, doc.root);
      assert.equal(snap.engine, E);
      assert.deepEqual(await storage.txsAfter(p.id, 0), []);

      assert.equal((await storage.getProject(p.id)).name, 'Один');
      assert.equal(await storage.getProject('00000000-0000-4000-8000-000000000000'), null);
      assert.equal(await storage.getProject('мусор'), null);
      assert.ok((await storage.listProjects()).some((x) => x.id === p.id));
      assert.equal((await storage.renameProject(p.id, 'Два')).name, 'Два');
      assert.equal(await storage.renameProject('00000000-0000-4000-8000-000000000000', 'x'), null);
      // снимок хранится копией: правка документа снаружи её не трогает
      doc.root = 'подмена';
      assert.equal((await storage.latestSnapshot(p.id)).doc.root, snap.doc.root);
    });

    it('commitTx: номера подряд, повтор tx_id → existing без сдвига головы, stale при чужом номере, missing без проекта', async () => {
      const p = await storage.createProject({ name: 'Ж', kind: 'design', doc: createDoc('empty'), engine: E });
      const a = record(0, [ops.setToken('colors.accent', '#000000')], { author: 'А', title: 'первая', undo_of: 'tx_prev' });
      const r1 = await storage.commitTx(p.id, a, { expectSeq: 1 });
      assert.equal(r1.status, 'committed');
      assert.equal(r1.committed.seq, 1);
      assert.equal(r1.committed.tx_id, a.tx_id);
      assert.equal(r1.committed.undo_of, 'tx_prev');
      assert.equal(r1.committed.author, 'А');
      assert.equal(r1.committed.title, 'первая');
      assert.equal('redo_of' in r1.committed, false, 'пустые необязательные поля не отдаются');
      assert.equal('client' in r1.committed, false);
      assert.match(r1.committed.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);

      const again = await storage.commitTx(p.id, a, { expectSeq: 2 });
      assert.equal(again.status, 'existing');
      assert.deepEqual(again.committed, r1.committed);
      assert.equal((await storage.getProject(p.id)).head_seq, 1, 'повтор не двигает голову');

      const stale = await storage.commitTx(p.id, record(1, []), { expectSeq: 5 });
      assert.equal(stale.status, 'stale');
      assert.equal(stale.head_seq, 1);
      assert.equal((await storage.getProject(p.id)).head_seq, 1, 'stale откатывает номер');
      assert.deepEqual((await storage.txsAfter(p.id, 0)).map((t) => t.seq), [1]);

      const b = await storage.commitTx(p.id, record(1, []));
      assert.equal(b.status, 'committed');
      assert.equal(b.committed.seq, 2);
      assert.equal((await storage.findTx(p.id, b.committed.tx_id)).seq, 2);
      assert.equal(await storage.findTx(p.id, 'нет такой'), null);

      assert.equal((await storage.commitTx('00000000-0000-4000-8000-000000000000', record(0, []))).status, 'missing');
      assert.equal((await storage.commitTx('мусор', record(0, []))).status, 'missing');
    });

    it('txsAfter: с seq, с пределом; writeSnapshot идемпотентен и latestSnapshot отдаёт старший', async () => {
      const p = await storage.createProject({ name: 'Х', kind: 'library', doc: createDoc('empty'), engine: E });
      for (let i = 0; i < 5; i++) await storage.commitTx(p.id, record(i, [ops.setToken('spacing', [i + 1])]));
      assert.deepEqual((await storage.txsAfter(p.id, 2)).map((t) => t.seq), [3, 4, 5]);
      assert.deepEqual((await storage.txsAfter(p.id, 0, 2)).map((t) => t.seq), [1, 2]);
      assert.deepEqual((await storage.txsAfter(p.id, 5)), []);
      const doc = createDoc('empty');
      const chain3 = await storage.chainAt(p.id, 3);
      assert.equal(await storage.writeSnapshot(p.id, 3, doc, E, 'чужая цепочка'), false, 'снимок не по журналу не пишется');
      assert.equal(await storage.writeSnapshot(p.id, 3, doc, E, chain3), true);
      assert.equal(await storage.writeSnapshot(p.id, 3, createDoc('empty'), E, chain3), false);   // повтор — DO NOTHING
      const snap = await storage.latestSnapshot(p.id);
      assert.equal(snap.seq, 3);
      assert.equal(snap.doc.root, doc.root);
      assert.equal((await storage.getProject(p.id)).kind, 'library');
    });

    it('снимок несёт надгробия (объект id → родитель); запись журнала — command_id (круг 25)', async () => {
      const p = await storage.createProject({ name: 'Н', kind: 'design', doc: createDoc('empty'), engine: E });
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones.parents, {}, 'затравка — без надгробий');
      const r1 = await storage.commitTx(p.id, record(0, [], { command_id: 'cmd_42' }));
      assert.equal(r1.committed.command_id, 'cmd_42');
      const r2 = await storage.commitTx(p.id, record(1, []));
      assert.equal('command_id' in r2.committed, false, 'без команды — поля нет');
      assert.equal((await storage.findTx(p.id, r1.committed.tx_id)).command_id, 'cmd_42');
      assert.deepEqual((await storage.txsAfter(p.id, 0)).map((t) => t.command_id), ['cmd_42', undefined]);
      const doc = createDoc('empty');
      const tomb = new Map([['n_1', 'b_1'], ['n_2', null]]);
      assert.equal(await storage.writeSnapshot(p.id, 1, doc, E, r1.committed.chain, tomb), true, 'Map — тоже годится');
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones, { n_1: 'b_1', n_2: null });
      assert.equal(await storage.saveSnapshot(p.id, { seq: 2, doc, engine: E, chain: r2.committed.chain, tombstones: { n_3: 'b_2' } }), true);
      const snap = await storage.latestSnapshot(p.id);
      assert.equal(snap.seq, 2);
      assert.deepEqual(snap.tombstones, { n_3: 'b_2' });
      assert.equal(await storage.writeSnapshot(p.id, 2, doc, E, r2.committed.chain), false, 'повтор — DO NOTHING');
    });

    it('надгробия v2 (круг 27, I1): v2 — как есть, v1 — как есть, null — «неизвестно»; seq 0 — всегда известны (пусто)', async () => {
      const p = await storage.createProject({ name: 'Н2', kind: 'design', doc: createDoc('empty'), engine: E });
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones, { v: 2, parents: {}, seq: {} }, 'затравка — v2, пусто');
      const c = [];
      for (let i = 0; i < 4; i++) c.push((await storage.commitTx(p.id, record(i, []))).committed.chain);
      const doc = createDoc('empty');
      const v2 = { v: 2, parents: { n_1: 'b_1', n_2: null }, seq: { n_1: 1, n_2: 2 } };
      assert.equal(await storage.writeSnapshot(p.id, 1, doc, E, c[0], v2), true);
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones, v2, 'v2 — туда и обратно');
      assert.equal(await storage.saveSnapshot(p.id, { seq: 2, doc, engine: E, chain: c[1], tombstones: { n_3: 'b_3' } }), true);
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones, { n_3: 'b_3' }, 'v1 — как есть (номеров нет)');
      assert.equal(await storage.writeSnapshot(p.id, 3, doc, E, c[2], null), true);
      const s3 = await storage.latestSnapshot(p.id);
      assert.equal(s3.seq, 3);
      assert.equal(s3.tombstones, null, 'null — неизвестно');
      // та же цепочка, надгробия теперь известны — снимок дописывается (а не DO NOTHING)
      assert.equal(await storage.writeSnapshot(p.id, 3, doc, E, c[2], { v: 2, parents: {}, seq: {} }), true);
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones, { v: 2, parents: {}, seq: {} });
      assert.equal(await storage.writeSnapshot(p.id, 3, doc, E, c[2], { v: 2, parents: {}, seq: {} }), false, 'повтор — DO NOTHING');
      assert.equal(await storage.writeSnapshot(p.id, 3, doc, E, c[2], null), false, 'null известное не затирает');
    });

    it('snapshotBefore (круг 27, I1): ближайший раньше seq с известными надгробиями и годный по журналу; seq 0 — всегда', async () => {
      const p = await storage.createProject({ name: 'SB', kind: 'design', doc: createDoc('empty'), engine: E });
      const c = [];
      for (let i = 0; i < 6; i++) c.push((await storage.commitTx(p.id, record(i, [])).then((r) => r.committed.chain)));
      const doc = createDoc('empty');
      assert.equal(await storage.writeSnapshot(p.id, 2, doc, E, c[1], { v: 2, parents: { a: 'r' }, seq: { a: 2 } }), true);
      assert.equal(await storage.writeSnapshot(p.id, 4, doc, E, c[3], null), true, 'неизвестные надгробия');
      assert.equal(await storage.writeSnapshot(p.id, 5, doc, E, c[4], { b: 'r' }), true, 'v1');
      const at = async (seq, o) => storage.snapshotBefore(p.id, seq, o);
      assert.equal((await at(6)).seq, 5, 'v1 — известны');
      assert.deepEqual((await at(6)).tombstones, { b: 'r' });
      const b5 = await at(5);
      assert.equal(b5.seq, 2, 'seq 4 — неизвестны, пропущен');
      assert.deepEqual(b5.tombstones, { v: 2, parents: { a: 'r' }, seq: { a: 2 } });
      assert.equal(b5.doc.root, doc.root);
      assert.equal(b5.chain, c[1]);
      const lean = await at(5, { doc: false });
      assert.equal(lean.seq, 2);
      assert.equal('doc' in lean, false, 'doc:false — без документа');
      assert.equal((await at(2)).seq, 0, 'строго раньше seq');
      assert.deepEqual((await at(2)).tombstones, { v: 2, parents: {}, seq: {} });
      assert.equal(await at(0), null, 'раньше затравки — ничего');
      assert.equal(await storage.snapshotBefore('00000000-0000-4000-8000-000000000000', 5), null);
      assert.equal(await storage.snapshotBefore('мусор', 5), null);
    });

    it('latestSnapshotMeta (круг 27, I2): тот же снимок, что latestSnapshot, без doc и надгробий, с эпохой', async () => {
      const p = await storage.createProject({ name: 'M', kind: 'design', doc: createDoc('empty'), engine: E });
      const m0 = await storage.latestSnapshotMeta(p.id);
      assert.deepEqual({ ...m0, created_at: undefined }, { seq: 0, chain: '', engine: E, epoch: p.epoch, created_at: undefined });
      const r1 = await storage.commitTx(p.id, record(0, []));
      await storage.commitTx(p.id, record(1, []));
      await storage.writeSnapshot(p.id, 1, createDoc('empty'), E, r1.committed.chain, { v: 2, parents: {}, seq: {} });
      await storage.writeSnapshot(p.id, 2, createDoc('empty'), E, 'чужая', { v: 2, parents: {}, seq: {} });   // не по журналу — не ляжет
      const full = await storage.latestSnapshot(p.id);
      const meta = await storage.latestSnapshotMeta(p.id);
      assert.deepEqual(meta, { seq: full.seq, chain: full.chain, engine: full.engine, epoch: p.epoch, created_at: full.created_at });
      assert.equal(meta.seq, 1);
      assert.equal(await storage.latestSnapshotMeta('мусор'), null);
      assert.equal(await storage.latestSnapshotMeta('00000000-0000-4000-8000-000000000000'), null);
    });

    it('commitTx: expectChain — номер тот же, цепочка другая → stale reason:chain, голова и журнал не сдвинуты (мутант круга 26)', async () => {
      const p = await storage.createProject({ name: 'Ц', kind: 'design', doc: createDoc('empty'), engine: E });
      const first = record(0, []);
      const r1 = await storage.commitTx(p.id, first, { expectSeq: 1, expectChain: chainNext('', first.tx_id, 1) });
      assert.equal(r1.status, 'committed', 'верная цепочка — запись');
      const tx = record(1, []);
      const bad = await storage.commitTx(p.id, tx, { expectSeq: 2, expectChain: chainNext('другой журнал', tx.tx_id, 2) });
      assert.equal(bad.status, 'stale');
      assert.equal(bad.reason, 'chain');
      assert.equal(bad.head_seq, 1);
      assert.equal(bad.epoch, p.epoch);
      const after = await storage.getProject(p.id);
      assert.equal(after.head_seq, 1, 'номер головы не ушёл вперёд');
      assert.equal(after.head_chain, r1.committed.chain, 'цепочка головы та же');
      assert.equal(await storage.findTx(p.id, tx.tx_id), null, 'записи нет');
      assert.deepEqual((await storage.txsAfter(p.id, 0)).map((t) => t.tx_id), [first.tx_id]);
      const ok = await storage.commitTx(p.id, tx, { expectSeq: 2, expectChain: chainNext(r1.committed.chain, tx.tx_id, 2) });
      assert.equal(ok.status, 'committed', 'та же транзакция с верной цепочкой — ложится');
      assert.equal(ok.committed.chain, chainNext(r1.committed.chain, tx.tx_id, 2));
    });

    it('pruneSnapshots: последние keep, seq 0 и старший снимок с известными надгробиями — остаются', async () => {
      const p = await storage.createProject({ name: 'Пр', kind: 'design', doc: createDoc('empty'), engine: E });
      const c = [];
      for (let i = 0; i < 6; i++) c.push((await storage.commitTx(p.id, record(i, []))).committed.chain);
      const doc = createDoc('empty');
      await storage.writeSnapshot(p.id, 1, doc, E, c[0], { v: 2, parents: {}, seq: {} });
      await storage.writeSnapshot(p.id, 2, doc, E, c[1], { v: 2, parents: {}, seq: {} });
      for (const s of [3, 4, 5, 6]) await storage.writeSnapshot(p.id, s, doc, E, c[s - 1], null);
      assert.equal(await storage.pruneSnapshots(p.id, 2), 3);
      assert.deepEqual(await storage.snapshotSeqs(p.id), [0, 2, 5, 6]);
      assert.equal((await storage.snapshotBefore(p.id, 7)).seq, 2);
    });

    it('данные, которых база не хранит (\\u0000 в jsonb — 22P05, половинка суррогата — 22P02, NUL в text — 22021): 400 retryable:false, голова не сдвинута', async () => {
      const p = await storage.createProject({ name: 'Д', kind: 'design', doc: createDoc('empty'), engine: E });
      const cases = [
        [record(0, [ops.setToken('colors.x', 'a\u0000b')]), '22P05'],
        [record(0, [ops.setToken('colors.x', 'a\ud800b')]), '22P02'],
        [record(0, [], { title: 'имя\u0000' }), '22021']
      ];
      for (const [tx, code] of cases) {
        const err = await viaStorage(storage.commitTx(p.id, tx)).then(() => null, (e) => e);
        assert.ok(err instanceof DocError, code + ': DocError');
        assert.equal(err.status, 400, code);
        assert.equal(err.code, 'bad_request');
        assert.equal(err.retryable, false, 'клиент снимает её с очереди');
        assert.equal(err.detail.sqlstate, code);
        assert.match(err.message, /не принимаются/);
      }
      assert.equal((await storage.getProject(p.id)).head_seq, 0, 'номер головы не ушёл вперёд');
      const ok = await storage.commitTx(p.id, record(0, [ops.setToken('colors.x', 'a b 😀')]));
      assert.equal(ok.status, 'committed', 'после отказа соединение и проект в порядке');
      assert.equal(ok.committed.seq, 1);
      const named = await viaStorage(storage.createProject({ name: 'с\u0000NUL', kind: 'design', doc: createDoc('empty'), engine: E })).then(() => null, (e) => e);
      assert.equal(named && named.status, 400);
    });

    it('выжимка dropped: preview режется по кодовым точкам — суррогатная пара не рвётся, запись ложится', async () => {
      const p = await storage.createProject({ name: 'В', kind: 'design', doc: createDoc('empty'), engine: E });
      // JSON значения: '"' + 'a'.repeat(118) + '😀…' — 120-я кодовая точка — эмодзи (две единицы UTF-16)
      for (const pad of [117, 118, 119]) {
        const value = 'a'.repeat(pad) + '😀'.repeat(600);
        const dropped = compactDropped([{ index: 0, reason: 'invalid', op: { op: 'set', id: 'n_1', path: 'name', value } }]);
        const preview = dropped[0].op.preview;
        assert.ok(preview.isWellFormed(), `pad ${pad}: без половинок суррогатов`);
        assert.equal([...preview].length, 120);
        const r = await storage.commitTx(p.id, record((await storage.getProject(p.id)).head_seq, [], { dropped }));
        assert.equal(r.status, 'committed', `pad ${pad}: запись с выжимкой ложится`);
        assert.equal(r.committed.dropped[0].op.preview, preview);
      }
    });

    it('параллельные commitTx с разными tx_id получают разные номера подряд', async () => {
      const p = await storage.createProject({ name: 'П', kind: 'design', doc: createDoc('empty'), engine: E });
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => storage.commitTx(p.id, record(0, [], { title: 'п' + i }))));
      assert.deepEqual(results.map((r) => r.status), Array(6).fill('committed'));
      assert.deepEqual(results.map((r) => r.committed.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
      assert.equal((await storage.getProject(p.id)).head_seq, 6);
    });

    it('recentTxMeta (J2): от новых к старым, beforeSeq — следующая страница; ops_count и dropped_count без ops', async () => {
      const p = await storage.createProject({ name: 'История', kind: 'design', doc: createDoc('empty'), engine: E });
      assert.deepEqual(await storage.recentTxMeta(p.id), []);
      const dropped = compactDropped(Array.from({ length: 60 }, (_, i) => ({ index: i, reason: 'invalid', op: { op: 'remove', id: 'n' + i } })));
      assert.equal(dropped.length, 51, 'выжимка: 50 записей и {more: 10}');
      await storage.commitTx(p.id, record(0, [ops.setToken('colors.accent', '#000000'), ops.setToken('colors.text', '#111111')], { author: 'Аня', title: 'Цвета', client: 'c1' }));
      await storage.commitTx(p.id, record(1, [], { author_kind: 'agent', title: 'Агент', command_id: 'cmd_1', dropped }));
      await storage.commitTx(p.id, record(2, [ops.setToken('colors.bg', '#ffffff')]));
      const all = await storage.recentTxMeta(p.id, { limit: 50 });
      assert.deepEqual(all.map((t) => t.seq), [3, 2, 1]);
      const [c, b, a] = all;
      assert.deepEqual(Object.keys(a).sort(), ['author', 'author_kind', 'client', 'command_author', 'command_id', 'created_at', 'dropped_count', 'ops_count', 'seq', 'title', 'tx_id']);
      assert.equal('ops' in a, false, 'операций в сводке нет');
      assert.deepEqual({ author: a.author, author_kind: a.author_kind, title: a.title, client: a.client, command_id: a.command_id, ops_count: a.ops_count, dropped_count: a.dropped_count },
        { author: 'Аня', author_kind: 'human', title: 'Цвета', client: 'c1', command_id: null, ops_count: 2, dropped_count: 0 });
      assert.deepEqual({ author_kind: b.author_kind, command_id: b.command_id, ops_count: b.ops_count, dropped_count: b.dropped_count, author: b.author },
        { author_kind: 'agent', command_id: 'cmd_1', ops_count: 0, dropped_count: 60, author: null });
      assert.equal(c.ops_count, 1);
      assert.ok(!Number.isNaN(Date.parse(a.created_at)) && typeof a.created_at === 'string');
      assert.equal(a.tx_id, (await storage.txsAfter(p.id, 0, 1))[0].tx_id);
      // страницы истории
      assert.deepEqual((await storage.recentTxMeta(p.id, { limit: 2 })).map((t) => t.seq), [3, 2]);
      assert.deepEqual((await storage.recentTxMeta(p.id, { limit: 2, beforeSeq: 2 })).map((t) => t.seq), [1]);
      assert.deepEqual(await storage.recentTxMeta(p.id, { beforeSeq: 1 }), []);
      assert.deepEqual(await storage.recentTxMeta('00000000-0000-4000-8000-000000000000'), []);
      assert.deepEqual(await storage.recentTxMeta('мусор'), []);
    });

    it('ping (J1): живое хранилище — true', async () => {
      assert.equal(await storage.ping(), true);
      assert.equal(await storage.ping({ timeoutMs: 50 }), true);
    });
  });
}

describe('ping · pg (J1)', { skip: list.find((b) => b.name === 'pg').available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  it('ответ помнится 1 с: частый health не ходит в базу; одновременные — одной пробой', async () => {
    const s = pgStorage({ listen: false });
    await s.init();
    try {
      let probes = 0;
      const q = s.pool.query.bind(s.pool);
      s.pool.query = (...a) => { if (a[0] === 'SELECT 1') probes++; return q(...a); };
      assert.deepEqual(await Promise.all([s.ping(), s.ping(), s.ping()]), [true, true, true]);
      assert.equal(probes, 1, 'одновременные — одна проба');
      for (let i = 0; i < 20; i++) assert.equal(await s.ping(), true);
      assert.equal(probes, 1, 'в пределах секунды — из памяти');
      await new Promise((r) => setTimeout(r, 1100));
      assert.equal(await s.ping(), true);
      assert.equal(probes, 2, 'через секунду — новая проба');
    } finally {
      await s.close();
    }
    assert.equal(await s.ping(), false, 'закрытое хранилище — false');
  });

  it('база не отвечает: false за timeoutMs, а не за connectionTimeout; зависшая проба не копит новые', async () => {
    const net = await import('node:net');
    // «база», которая принимает соединение и молчит (полуоткрытая сеть)
    const sockets = new Set();
    const mute = net.createServer((c) => { sockets.add(c); c.on('error', () => {}); });
    await new Promise((r) => mute.listen(0, '127.0.0.1', r));
    const s = pgStorage({ connectionString: `postgres://imago:imago@127.0.0.1:${mute.address().port}/x`, listen: false, connectionTimeoutMillis: 4000 });
    try {
      const t0 = Date.now();
      assert.equal(await s.ping({ timeoutMs: 300 }), false);
      const ms = Date.now() - t0;
      assert.ok(ms >= 250 && ms < 1500, `ответ за timeoutMs: ${ms} мс`);
      await new Promise((r) => setTimeout(r, 1100));
      const t1 = Date.now();
      assert.equal(await s.ping({ timeoutMs: 300 }), false);
      assert.ok(Date.now() - t1 < 200, 'прежняя проба ещё висит — сразу false, без новой');
      assert.ok(s.pool.totalCount + s.pool.waitingCount <= 1, `проб в пуле: ${s.pool.totalCount} + ${s.pool.waitingCount}`);
      // отказ соединения (порт закрыт) — тоже false, быстро
      const dead = pgStorage({ connectionString: 'postgres://imago:imago@127.0.0.1:1/x', listen: false });
      try {
        assert.equal(await dead.ping({ timeoutMs: 2000 }), false);
      } finally {
        await dead.close().catch(() => {});
      }
    } finally {
      for (const c of sockets) c.destroy();
      await s.close().catch(() => {});
      await new Promise((r) => mute.close(r));
    }
  });
});

describe('viaStorage: причина 503 — в лог одной строкой', () => {
  it('сбой хранилища → 503 и строка лога без переводов строк и не длиннее ~250 символов; повторы — не чаще раза в секунду', async () => {
    const lines = [];
    setStorageLog({ warn: (m) => lines.push(m), info() {} });
    try {
      const boom = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432\n' + 'данные пользователя '.repeat(100)), { code: 'ECONNREFUSED' });
      for (let k = 0; k < 5; k++) {
        const e = await viaStorage(Promise.reject(boom)).then(() => null, (x) => x);
        assert.equal(e.status, 503);
        assert.equal(e.detail.cause, 'storage');
      }
      assert.equal(lines.length, 1, 'одинаковые — одной строкой');
      assert.match(lines[0], /503 \(storage ECONNREFUSED\): connect ECONNREFUSED/);
      assert.ok(!/\n/.test(lines[0]) && lines[0].length < 300, lines[0]);
      const t = await viaStorage(Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).then(() => null, (x) => x);
      assert.equal(t.detail.cause, 'timeout');
      assert.equal(lines.length, 2);
      assert.match(lines[1], /503 \(timeout 57014\)/);
    } finally {
      setStorageLog(console);
    }
  });
});
