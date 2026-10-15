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
import { compactDropped } from '../../server/document/storage/committed.js';
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

    it('снимок несёт надгробия (объект id → родитель), старый — {}; запись журнала — command_id (круг 25)', async () => {
      const p = await storage.createProject({ name: 'Н', kind: 'design', doc: createDoc('empty'), engine: E });
      assert.deepEqual((await storage.latestSnapshot(p.id)).tombstones, {}, 'затравка — без надгробий');
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
  });
}

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
