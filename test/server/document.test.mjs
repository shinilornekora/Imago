/**
 * Document service (server/document): HTTP по §9.2, WebSocket по §9.3,
 * секвенсор по §9.4, слияние по §9.6. Один и тот же набор гоняется над
 * адаптером в памяти (всегда) и над Postgres (когда доступна база — иначе skip).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDoc, applyOps, hashDoc, artboards, ops, uid, ENGINE_VERSION } from '../../src/core.js';
import { backends, startFor, api, connect, wsUrl } from './helpers.mjs';

const E = ENGINE_VERSION;

/** Транзакция с умолчаниями контракта. */
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });

/** Текстовый узел в доске — как строит клиент (id — клиентский). */
const text = (parent, characters, extra = {}) => ({
  type: 'text', id: uid('n'), name: characters, parent, characters,
  style: { token: 'body' }, align: 'left', color: '#14161C', ...extra
});
const frame = (parent, name, extra = {}) => ({
  type: 'frame', id: uid('f'), name, parent, children: [], radius: 0,
  size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, ...extra
});

/** Переигрывание журнала с нуля строгим applyOps — как клиент и DSLV. */
function replay(doc, txs) {
  let cur = doc;
  for (const t of txs) {
    const res = applyOps(cur, t.ops);
    assert.equal(res.error, undefined, `seq ${t.seq} должна применяться: ${JSON.stringify(res.error)}`);
    cur = res.doc;
  }
  return cur;
}

const list = await backends();

for (const backend of list) {
  describe(`document service · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let svc;
    let http;
    before(async () => {
      svc = await startFor(backend.name, { snapshotEvery: 3 });
      http = api(svc.url);
    });
    after(async () => {
      await svc.close();
    });

    /** Новый проект с демо-документом; возвращает id и первую доску. */
    async function fresh(name = 'Проба') {
      const created = await http.post('/api/projects', { name });
      assert.equal(created.status, 201);
      const opened = await http.get('/api/projects/' + created.body.id);
      const board = artboards(opened.body.snapshot.doc)[0];
      return { id: created.body.id, doc: opened.body.snapshot.doc, board };
    }

    /* ------------------------------ HTTP (§9.2) ------------------------------ */

    it('health: ok и версия движка', async () => {
      const r = await http.get('/api/health');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, engine: E });
    });

    it('OPTIONS → 204; неизвестный маршрут → 404', async () => {
      assert.equal((await http.options('/api/projects')).status, 204);
      assert.equal((await http.get('/api/nope')).status, 404);
      assert.equal((await http.get('/nope')).status, 404);
    });

    it('создать → открыть: снимок seq 0, пустой хвост, документ createDoc()', async () => {
      const created = await http.post('/api/projects', { name: 'Первый' });
      assert.equal(created.status, 201);
      assert.equal(created.body.head_seq, 0);
      assert.equal(created.body.kind, 'design');
      assert.equal(created.body.name, 'Первый');
      assert.match(created.body.id, /^[0-9a-f-]{36}$/);

      const opened = await http.get('/api/projects/' + created.body.id);
      assert.equal(opened.status, 200);
      assert.equal(opened.body.id, created.body.id);
      assert.equal(opened.body.head_seq, 0);
      assert.deepEqual(opened.body.tail, []);
      assert.equal(opened.body.snapshot.seq, 0);
      assert.equal(opened.body.snapshot.engine, E);
      const doc = opened.body.snapshot.doc;
      assert.ok(doc.nodes[doc.root], 'корень среди узлов');
      assert.ok(doc.tokens && doc.tokens.colors && Array.isArray(doc.tokens.spacing), 'снимок несёт токены целиком');
      assert.ok(artboards(doc).length >= 1, 'демо-документ с досками');

      const listed = await http.get('/api/projects');
      assert.equal(listed.status, 200);
      const mine = listed.body.projects.find((p) => p.id === created.body.id);
      assert.ok(mine);
      assert.deepEqual(Object.keys(mine).sort(), ['head_seq', 'id', 'kind', 'name', 'updated_at']);
    });

    it('создать с переданным документом: он и есть снимок; негодный doc и kind → 400', async () => {
      const seed = createDoc('empty');
      const created = await http.post('/api/projects', { name: 'Свой', kind: 'library', doc: seed });
      assert.equal(created.status, 201);
      assert.equal(created.body.kind, 'library');
      const opened = await http.get('/api/projects/' + created.body.id);
      assert.equal(opened.body.snapshot.doc.root, seed.root);
      assert.equal(hashDoc(opened.body.snapshot.doc), hashDoc(seed));

      assert.equal((await http.post('/api/projects', { doc: { nodes: {} } })).status, 400);
      assert.equal((await http.post('/api/projects', { doc: 'x' })).status, 400);
      assert.equal((await http.post('/api/projects', { kind: 'other' })).status, 400);
      assert.equal((await http.post('/api/projects', '{oops')).status, 400);
    });

    it('PATCH переименовывает; 404 на чужой id везде', async () => {
      const { id } = await fresh();
      const renamed = await http.patch('/api/projects/' + id, { name: 'Новое имя' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.name, 'Новое имя');
      assert.equal(renamed.body.head_seq, 0);
      assert.equal((await http.patch('/api/projects/' + id, { name: '' })).status, 400);

      const ghost = '00000000-0000-4000-8000-000000000000';
      assert.equal((await http.get('/api/projects/' + ghost)).status, 404);
      assert.equal((await http.get('/api/projects/not-a-uuid')).status, 404);
      assert.equal((await http.patch('/api/projects/' + ghost, { name: 'x' })).status, 404);
      assert.equal((await http.get(`/api/projects/${ghost}/ops?since=0`)).status, 404);
      assert.equal((await http.post(`/api/projects/${ghost}/tx`, tx(0, []))).status, 404);
      // мусор в несуществующий проект — тоже 404, а не 400
      assert.equal((await http.post(`/api/projects/${ghost}/tx`, { foo: 1 })).status, 404);
    });

    it('POST tx: создать текст в первой доске → 201, seq 1, применённая форма; повтор → 200 с тем же', async () => {
      const { id, board } = await fresh();
      const node = text(board.id, 'Привет');
      const t = tx(0, [{ ...ops.create(node), after: board.children[board.children.length - 1] }], { author: 'Аня', client: 'tab-1', title: 'Текст' });
      const r1 = await http.post(`/api/projects/${id}/tx`, t);
      assert.equal(r1.status, 201);
      const c = r1.body;
      assert.equal(c.seq, 1);
      assert.equal(c.tx_id, t.tx_id);
      assert.equal(c.base_seq, 0);
      assert.equal(c.engine, E);
      assert.equal(c.author, 'Аня');
      assert.equal(c.author_kind, 'human');
      assert.equal(c.client, 'tab-1');
      assert.equal(c.title, 'Текст');
      assert.deepEqual(c.dropped, []);
      assert.deepEqual(c.notes, []);
      assert.match(c.created_at, /^\d{4}-\d{2}-\d{2}T/);
      // применённая форма: after разрешён в index, самого after в журнале нет
      assert.equal(c.ops.length, 1);
      assert.equal(c.ops[0].op, 'create');
      assert.equal(c.ops[0].node.id, node.id);
      assert.equal(c.ops[0].index, board.children.length);
      assert.equal('after' in c.ops[0], false);

      const r2 = await http.post(`/api/projects/${id}/tx`, t);
      assert.equal(r2.status, 200);
      assert.deepEqual(r2.body, c);

      const opened = await http.get('/api/projects/' + id);
      assert.equal(opened.body.head_seq, 1);
      assert.equal(opened.body.tail.length, 1);
      assert.deepEqual(opened.body.tail[0], c);
      const head = replay(opened.body.snapshot.doc, opened.body.tail);
      assert.equal(head.nodes[node.id].characters, 'Привет');
      assert.equal(head.nodes[board.id].children[head.nodes[board.id].children.length - 1], node.id);
    });

    it('автор из X-Author, если в теле нет; author_kind agent сохраняется', async () => {
      const { id, board } = await fresh();
      const r = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'x'))], { author_kind: 'agent' }), { 'x-author': encodeURIComponent('Агент Смит') });
      assert.equal(r.status, 201);
      assert.equal(r.body.author, 'Агент Смит');
      assert.equal(r.body.author_kind, 'agent');
    });

    it('ops?since: хвост, head_seq; 410 со снимком, когда догнать нельзя', async () => {
      const { id, board } = await fresh();
      const a = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'a'))]));
      const b = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'b'))]));
      assert.equal(a.body.seq, 1);
      assert.equal(b.body.seq, 2);

      const all = await http.get(`/api/projects/${id}/ops?since=0`);
      assert.equal(all.status, 200);
      assert.equal(all.body.head_seq, 2);
      assert.deepEqual(all.body.txs.map((t) => t.seq), [1, 2]);

      const one = await http.get(`/api/projects/${id}/ops?since=1`);
      assert.deepEqual(one.body.txs.map((t) => t.seq), [2]);
      const none = await http.get(`/api/projects/${id}/ops?since=2`);
      assert.deepEqual(none.body, { head_seq: 2, txs: [] });
      const limited = await http.get(`/api/projects/${id}/ops?since=0&limit=1`);
      assert.deepEqual(limited.body.txs.map((t) => t.seq), [1]);
      assert.equal(limited.body.head_seq, 2);

      // клиент впереди сервера (проект пересоздан) или ничего не знает → снимок
      for (const since of [-1, 99]) {
        const gone = await http.get(`/api/projects/${id}/ops?since=${since}`);
        assert.equal(gone.status, 410);
        assert.equal(gone.body.head_seq, 2);
        assert.equal(gone.body.snapshot.seq, 0);
        assert.ok(gone.body.snapshot.doc.nodes);
      }
      assert.equal((await http.get(`/api/projects/${id}/ops?since=abc`)).status, 400);
      assert.equal((await http.get(`/api/projects/${id}/ops?since=0&limit=0`)).status, 400);
    });

    it('неверный engine → 426 {engine}; мусор → 400; base_seq впереди головы → 400', async () => {
      const { id, board } = await fresh();
      const old = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'x'))], { engine: E + 1 }));
      assert.equal(old.status, 426);
      assert.equal(old.body.engine, E);
      assert.equal(old.body.error, 'engine');
      const noEngine = await http.post(`/api/projects/${id}/tx`, { tx_id: 'tx_x', base_seq: 0, ops: [] });
      assert.equal(noEngine.status, 426);

      for (const body of [{ foo: 1 }, [], 'строка', { tx_id: '', base_seq: 0, ops: [], engine: E }, { tx_id: 'a', base_seq: -1, ops: [], engine: E },
        { tx_id: 'a', base_seq: 0, ops: 'x', engine: E }, { tx_id: 'a', base_seq: 0, ops: [{ op: 'explode' }], engine: E },
        { tx_id: 'a', base_seq: 0, ops: [], engine: E, author_kind: 'robot' }]) {
        const r = await http.post(`/api/projects/${id}/tx`, body);
        assert.equal(r.status, 400, 'мусор: ' + JSON.stringify(body));
        assert.equal(r.body.error, 'bad-request');
      }
      assert.equal((await http.raw('POST', `/api/projects/${id}/tx`, '{oops', { 'content-type': 'application/json' })).status, 400);
      assert.equal((await http.post(`/api/projects/${id}/tx`, tx(5, []))).status, 400);
      // после всех отказов голова не сдвинулась
      assert.equal((await http.get('/api/projects/' + id)).body.head_seq, 0);
    });

    it('тело больше 4 МБ → 413', async () => {
      const { id, board } = await fresh();
      const big = tx(0, [ops.create(text(board.id, 'x'.repeat(4 * 1024 * 1024 + 10)))]);
      const r = await http.post(`/api/projects/${id}/tx`, big);
      assert.equal(r.status, 413);
    });

    /* ------------------------------ слияние (§9.6) ------------------------------ */

    it('set по удалённому узлу → dropped removed; транзакция целиком не отклоняется', async () => {
      const { id, board } = await fresh();
      const victim = board.children[0];
      const r1 = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.remove(victim)]));
      assert.equal(r1.status, 201);
      const late = tx(0, [ops.set(victim, 'name', 'поздно'), ops.set(board.id, 'name', 'Доска')]);
      const r2 = await http.post(`/api/projects/${id}/tx`, late);
      assert.equal(r2.status, 201);
      assert.equal(r2.body.seq, 2);
      assert.equal(r2.body.ops.length, 1);
      assert.equal(r2.body.ops[0].id, board.id);
      assert.deepEqual(r2.body.dropped, [{ index: 0, op: late.ops[0], reason: 'removed' }]);
    });

    it('два конкурентных create с одним after: оба остаются, порядок детерминирован и равен переигрыванию', async () => {
      const { id, board } = await fresh();
      const anchor = board.children[0];
      const a = text(board.id, 'A');
      const b = text(board.id, 'B');
      const ra = await http.post(`/api/projects/${id}/tx`, tx(0, [{ ...ops.create(a), after: anchor }]));
      const rb = await http.post(`/api/projects/${id}/tx`, tx(0, [{ ...ops.create(b), after: anchor }]));
      assert.equal(ra.body.seq, 1);
      assert.equal(rb.body.seq, 2);
      assert.deepEqual(rb.body.dropped, []);

      const opened = await http.get('/api/projects/' + id);
      const head = replay(opened.body.snapshot.doc, opened.body.tail);
      const kids = head.nodes[board.id].children;
      const at = kids.indexOf(anchor);
      // оба «после якоря»; поздняя по seq встаёт ближе к якорю — так решает rebase, и так же решит клиент
      assert.deepEqual(kids.slice(at, at + 3), [anchor, b.id, a.id]);
      const server = await svc.dslts.headOf(id);
      assert.equal(hashDoc(server.doc), hashDoc(head));
    });

    it('create под удалённым родителем → reparented к живому предку; move в цикл → cycle', async () => {
      const { id, board } = await fresh();
      const inner = frame(board.id, 'Группа');
      const r0 = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(inner)]));
      assert.equal(r0.status, 201);
      const r1 = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.remove(inner.id)]));
      assert.equal(r1.status, 201);
      // клиент ещё видел группу (база 1) и положил в неё текст
      const child = text(inner.id, 'сирота');
      const r2 = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.create(child)]));
      assert.equal(r2.status, 201);
      assert.deepEqual(r2.body.dropped, []);
      assert.deepEqual(r2.body.notes, [{ index: 0, note: 'reparented' }]);
      assert.equal(r2.body.ops[0].node.parent, board.id);

      const outer = frame(board.id, 'Внешний');
      const nested = frame(outer.id, 'Вложенный');
      const r3 = await http.post(`/api/projects/${id}/tx`, tx(3, [ops.create(outer), ops.create(nested)]));
      assert.equal(r3.status, 201);
      const cyc = tx(4, [ops.move(outer.id, nested.id, 0)]);
      const r4 = await http.post(`/api/projects/${id}/tx`, cyc);
      assert.equal(r4.status, 201);
      assert.deepEqual(r4.body.ops, []);
      assert.equal(r4.body.dropped[0].reason, 'cycle');
    });

    it('битая операция → dropped invalid, остальные ложатся', async () => {
      const { id, board } = await fresh();
      const bad = { op: 'set', id: board.id, path: 'id', value: 'другой' };   // защищённый путь
      const good = ops.set(board.id, 'name', 'Ок');
      const r = await http.post(`/api/projects/${id}/tx`, tx(0, [bad, good]));
      assert.equal(r.status, 201);
      assert.equal(r.body.ops.length, 1);
      assert.deepEqual(r.body.dropped, [{ index: 0, op: bad, reason: 'invalid' }]);
    });

    /* ------------------------------ секвенсор (§9.4) ------------------------------ */

    it('снимок раз в SNAPSHOT_EVERY=3: открытие отдаёт снимок seq 3 с пустым хвостом; переигрывание = голова', async () => {
      const { id, board } = await fresh();
      for (let i = 0; i < 3; i++) {
        const r = await http.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'т' + i))]));
        assert.equal(r.body.seq, i + 1);
      }
      await svc.dslts.flush();
      const snap = await svc.storage.latestSnapshot(id);
      assert.equal(snap.seq, 3);
      assert.equal(snap.engine, E);

      const opened = await http.get('/api/projects/' + id);
      assert.equal(opened.body.snapshot.seq, 3);
      assert.deepEqual(opened.body.tail, []);
      assert.equal(opened.body.head_seq, 3);

      // журнал остался целиком: догон с нуля по-прежнему возможен
      const log = (await http.get(`/api/projects/${id}/ops?since=0`)).body.txs;
      assert.deepEqual(log.map((t) => t.seq), [1, 2, 3]);
      // снимок = голова в памяти
      const head = await svc.dslts.headOf(id);
      assert.equal(head.head_seq, 3);
      assert.equal(hashDoc(opened.body.snapshot.doc), hashDoc(head.doc));

      // после четвёртой транзакции хвост — одна запись поверх снимка 3
      const r4 = await http.post(`/api/projects/${id}/tx`, tx(3, [ops.set(board.id, 'name', 'Четыре')]));
      assert.equal(r4.body.seq, 4);
      const again = await http.get('/api/projects/' + id);
      assert.equal(again.body.snapshot.seq, 3);
      assert.deepEqual(again.body.tail.map((t) => t.seq), [4]);
    });

    it('переигрывание журнала с seq 0 даёт тот же hashDoc, что голова', async () => {
      const { id, board, doc } = await fresh();
      const n = text(board.id, 'раз');
      const r1 = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(n)]));
      const r2 = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.set(n.id, 'characters', 'два'), ops.setToken('colors.accent', '#123456')]));
      const r3 = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.remove(board.children[0])]));
      const r4 = await http.post(`/api/projects/${id}/tx`, tx(3, [ops.move(n.id, board.id, 0)]));
      for (const r of [r1, r2, r3, r4]) assert.equal(r.status, 201);
      const log = (await http.get(`/api/projects/${id}/ops?since=0`)).body.txs;
      assert.deepEqual(log.map((t) => t.seq), [1, 2, 3, 4]);
      const replayed = replay(doc, log);
      const head = await svc.dslts.headOf(id);
      assert.equal(hashDoc(replayed), hashDoc(head.doc));
      assert.equal(replayed.nodes[n.id].characters, 'два');
      assert.equal(replayed.tokens.colors.accent, '#123456');
      // снимок seq 3 (SNAPSHOT_EVERY=3) — тот же документ, что переигрывание до 3
      await svc.dslts.flush();
      const snap = await svc.storage.latestSnapshot(id);
      assert.equal(snap.seq, 3);
      assert.equal(hashDoc(snap.doc), hashDoc(replay(doc, log.slice(0, 3))));
    });

    it('идемпотентность при гонке: два параллельных POST с одним tx_id → один seq, равные ответы', async () => {
      const { id, board } = await fresh();
      const t = tx(0, [ops.create(text(board.id, 'гонка'))]);
      const [a, b] = await Promise.all([
        http.post(`/api/projects/${id}/tx`, t),
        http.post(`/api/projects/${id}/tx`, t)
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 201]);
      assert.deepEqual(a.body, b.body);
      assert.equal(a.body.seq, 1);
      assert.equal((await http.get('/api/projects/' + id)).body.head_seq, 1);
    });

    it('параллельные транзакции разных авторов: номера без дыр, все применены', async () => {
      const { id, board } = await fresh();
      const batch = Array.from({ length: 8 }, (_, i) => tx(0, [ops.create(text(board.id, 'п' + i))]));
      const results = await Promise.all(batch.map((t) => http.post(`/api/projects/${id}/tx`, t)));
      for (const r of results) assert.equal(r.status, 201);
      assert.deepEqual(results.map((r) => r.body.seq).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
      const opened = await http.get('/api/projects/' + id);
      const head = replay(opened.body.snapshot.doc, opened.body.tail);
      for (const t of batch) assert.ok(head.nodes[t.ops[0].node.id], 'узел создан');
    });

    it('другой писатель: запись мимо памяти → следующая транзакция перечитывает хвост и ложится со своим номером', async () => {
      const { id, board } = await fresh();
      const mine = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'моё'))]));
      assert.equal(mine.body.seq, 1);
      // «другой экземпляр»: пишет в хранилище напрямую, голова в памяти этого не видела
      const foreign = text(board.id, 'чужое');
      const direct = await svc.storage.commitTx(id, { tx_id: uid('tx'), base_seq: 1, ops: [ops.create(foreign, 0)], dropped: [], notes: [], author: 'другой', author_kind: 'human', engine: E });
      assert.equal(direct.status, 'committed');
      assert.equal(direct.committed.seq, 2);
      assert.equal((await svc.storage.getProject(id)).head_seq, 2);

      // set по чужому узлу проходит только если хвост перечитан
      const next = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.set(foreign.id, 'characters', 'чужое, поправлено')]));
      assert.equal(next.status, 201);
      assert.equal(next.body.seq, 3);
      assert.deepEqual(next.body.dropped, []);
      const head = await svc.dslts.headOf(id);
      assert.equal(head.head_seq, 3);
      assert.equal(head.doc.nodes[foreign.id].characters, 'чужое, поправлено');
      const opened = await http.get('/api/projects/' + id);
      assert.equal(hashDoc(replay(opened.body.snapshot.doc, opened.body.tail)), hashDoc(head.doc));
    });

    it('два экземпляра сервиса над одним хранилищем: головы сходятся, номера без дыр', async () => {
      const { id, board } = await fresh();
      const { start } = await import('../../server/document/index.js');
      const twin = await start({ port: 0, storage: svc.storage, snapshotEvery: 3, pingInterval: 0, log: { info() {}, warn() {} } });
      const other = api(twin.url);
      try {
        const seqs = [];
        for (let i = 0; i < 6; i++) {
          const via = i % 2 ? other : http;
          const r = await via.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'э' + i))]));
          assert.equal(r.status, 201, JSON.stringify(r.body));
          seqs.push(r.body.seq);
        }
        assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
        const [h1, h2] = await Promise.all([svc.dslts.headOf(id), twin.dslts.headOf(id)]);
        assert.equal(h1.head_seq, 6);
        assert.equal(h2.head_seq, 6);
        assert.equal(hashDoc(h1.doc), hashDoc(h2.doc));
        // и параллельно через оба — журнал всё равно один и без дыр
        const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? other : http).post(`/api/projects/${id}/tx`, tx(6, [ops.create(text(board.id, 'в' + i))]))));
        assert.deepEqual(burst.map((r) => r.body.seq).sort((a, b) => a - b), [7, 8, 9, 10, 11, 12]);
        const opened = await http.get('/api/projects/' + id);
        const replayed = replay(opened.body.snapshot.doc, opened.body.tail);
        const [g1, g2] = await Promise.all([svc.dslts.headOf(id), twin.dslts.headOf(id)]);
        assert.equal(hashDoc(g1.doc), hashDoc(replayed));
        assert.equal(hashDoc(g2.doc), hashDoc(replayed));
      } finally {
        // хранилище общее — закрывать его должен только владелец
        await twin.hub.close();
        await new Promise((resolve) => twin.server.close(() => resolve()));
        await twin.dslts.close();
      }
    });

    it('выгрузка головы: после перезагрузки надгробия восстановлены из хвоста', async () => {
      const { id, board } = await fresh();
      const inner = frame(board.id, 'Группа');
      await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(inner)]));
      await http.post(`/api/projects/${id}/tx`, tx(1, [ops.remove(inner.id)]));
      await svc.dslts.unload(id);
      assert.equal(svc.dslts.isLoaded(id), false);
      const child = text(inner.id, 'после перезагрузки');
      const r = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.create(child), ops.set(inner.id, 'name', 'x')]));
      assert.equal(r.status, 201);
      assert.equal(r.body.seq, 3);
      assert.deepEqual(r.body.notes, [{ index: 0, note: 'reparented' }]);
      assert.equal(r.body.ops[0].node.parent, board.id);
      assert.equal(r.body.dropped.length, 1);
      assert.equal(r.body.dropped[0].reason, 'removed');
      assert.equal(svc.dslts.isLoaded(id), true);
    });

    /* ------------------------------ WebSocket (§9.3) ------------------------------ */

    it('WS: hello и догон с since, затем живой поток обоим с одним seq; своя tx приходит автору', async () => {
      const { id, board } = await fresh();
      const first = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'до сокета'))]));
      assert.equal(first.body.seq, 1);

      const a = connect(wsUrl(svc, id, { since: 0, client: 'A', author: 'Аня' }));
      const b = connect(wsUrl(svc, id, { since: 1, client: 'B', author: 'Боря' }));
      await Promise.all([a.opened, b.opened]);

      const helloA = await a.next();
      assert.equal(helloA.type, 'hello');
      assert.equal(helloA.project.id, id);
      assert.equal(helloA.head_seq, 1);
      assert.equal(helloA.engine, E);
      const catchA = await a.next();
      assert.equal(catchA.type, 'tx');
      assert.equal(catchA.tx.seq, 1);
      assert.deepEqual(catchA.tx, first.body);

      const helloB = await b.next();
      assert.equal(helloB.type, 'hello');
      assert.ok(await b.silence(100), 'B с since=1 догонять нечего');

      const t = tx(1, [ops.create(text(board.id, 'по сокету'))], { client: 'A' });
      a.send({ type: 'tx', tx: t });
      const [gotA, gotB] = await Promise.all([a.next(), b.next()]);
      assert.equal(gotA.type, 'tx');
      assert.equal(gotB.type, 'tx');
      assert.equal(gotA.tx.seq, 2);
      assert.equal(gotB.tx.seq, 2);
      assert.equal(gotA.tx.tx_id, t.tx_id);
      assert.equal(gotA.tx.author, 'Аня', 'автор — из query сокета');
      assert.deepEqual(gotA.tx, gotB.tx);

      // повтор своей tx после «разрыва» — ответ есть, но не второй раз тем же сокетом
      a.send({ type: 'tx', tx: t });
      assert.ok(await a.silence(100), 'сокет, уже получивший seq 2, второй раз её не получает');
      assert.ok(await b.silence(50));

      await Promise.all([a.close(), b.close()]);
    });

    it('WS: set по узлу, удалённому другим клиентом, → dropped removed у автора и у всех', async () => {
      const { id, board } = await fresh();
      const a = connect(wsUrl(svc, id, { since: 0, client: 'A' }));
      const b = connect(wsUrl(svc, id, { since: 0, client: 'B' }));
      await Promise.all([a.opened, b.opened]);
      assert.equal((await a.next()).type, 'hello');
      assert.equal((await b.next()).type, 'hello');

      const victim = board.children[0];
      a.send({ type: 'tx', tx: tx(0, [ops.remove(victim)]) });
      const [ra, rb] = await Promise.all([a.next(), b.next()]);
      assert.equal(ra.tx.seq, 1);
      assert.equal(rb.tx.seq, 1);

      const late = tx(0, [ops.set(victim, 'name', 'поздно')], { client: 'B' });
      b.send({ type: 'tx', tx: late });
      const [la, lb] = await Promise.all([a.next(), b.next()]);
      assert.equal(lb.tx.seq, 2);
      assert.equal(lb.tx.tx_id, late.tx_id);
      assert.deepEqual(lb.tx.ops, []);
      assert.equal(lb.tx.dropped[0].reason, 'removed');
      assert.deepEqual(la.tx, lb.tx);

      await Promise.all([a.close(), b.close()]);
    });

    it('WS: presence доходит до другого, не до себя; left при закрытии; лишнее сверх 10/с отбрасывается', async () => {
      const { id } = await fresh();
      const a = connect(wsUrl(svc, id, { since: 0, client: 'A', author: 'Аня' }));
      const b = connect(wsUrl(svc, id, { since: 0, client: 'B' }));
      await Promise.all([a.opened, b.opened]);
      await a.next();
      await b.next();

      a.send({ type: 'presence', selection: ['n1', 'n2'], board: 'f1' });
      const p = await b.next();
      assert.equal(p.type, 'presence');
      assert.equal(p.client, 'A');
      assert.equal(p.author, 'Аня');
      assert.deepEqual(p.selection, ['n1', 'n2']);
      assert.equal(p.board, 'f1');
      assert.match(p.at, /^\d{4}-/);
      assert.ok(await a.silence(100), 'своё присутствие не возвращается');

      // 30 подряд в одну секунду: до B доходит не больше лимита (10, одно уже потрачено выше)
      for (let i = 0; i < 30; i++) a.send({ type: 'presence', selection: ['n' + i] });
      let got = 0;
      for (;;) {
        if (await b.silence(150)) break;
        await b.next();
        got++;
      }
      assert.ok(got >= 1 && got <= 9, 'дошло ' + got);

      await a.close();
      const left = await b.next();
      assert.deepEqual(left, { type: 'left', client: 'A' });
      assert.equal(svc.hub.roomSize(id), 1);
      await b.close();
      assert.equal(svc.hub.roomSize(id), 0);
    });

    it('WS: переподключение с since даёт догон; since ниже хранимого → gone со снимком', async () => {
      const { id, board } = await fresh();
      const a = connect(wsUrl(svc, id, { since: 0, client: 'A' }));
      await a.opened;
      await a.next();
      a.send({ type: 'tx', tx: tx(0, [ops.create(text(board.id, 'один'))]) });
      assert.equal((await a.next()).tx.seq, 1);
      await a.close();

      // пока A не в сети — ещё две транзакции
      await http.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'два'))]));
      await http.post(`/api/projects/${id}/tx`, tx(2, [ops.create(text(board.id, 'три'))]));

      const again = connect(wsUrl(svc, id, { since: 1, client: 'A' }));
      await again.opened;
      const hello = await again.next();
      assert.equal(hello.type, 'hello');
      assert.equal(hello.head_seq, 3);
      assert.equal((await again.next()).tx.seq, 2);
      assert.equal((await again.next()).tx.seq, 3);
      assert.ok(await again.silence(100));
      await again.close();

      // четвёртая — поверх снимка seq 3: после gone должен прийти и этот хвост
      await svc.dslts.flush();
      await http.post(`/api/projects/${id}/tx`, tx(3, [ops.create(text(board.id, 'четыре'))]));
      for (const since of [-1, 42]) {
        const lost = connect(wsUrl(svc, id, { since, client: 'C' }));
        await lost.opened;
        const hello = await lost.next();
        assert.equal(hello.type, 'hello');
        assert.equal(hello.head_seq, 4);
        const gone = await lost.next();
        assert.equal(gone.type, 'gone');
        assert.equal(gone.head_seq, 4);
        assert.equal(gone.snapshot.seq, 3, 'SNAPSHOT_EVERY=3 — снимок уже есть');
        assert.equal((await lost.next()).tx.seq, 4);
        assert.ok(await lost.silence(100));
        await lost.close();
      }

      // без since — только живой поток
      const live = connect(wsUrl(svc, id, { client: 'D' }));
      await live.opened;
      assert.equal((await live.next()).head_seq, 4);
      assert.ok(await live.silence(100));
      await live.close();
    });

    it('WS: ошибки — старый движок → error с tx_id; чужой проект → error и закрытие 4404; не JSON → error', async () => {
      const { id } = await fresh();
      const a = connect(wsUrl(svc, id, { since: 0, client: 'A' }));
      await a.opened;
      await a.next();
      const stale = tx(0, [], { engine: E + 1 });
      a.send({ type: 'tx', tx: stale });
      const err = await a.next();
      assert.equal(err.type, 'error');
      assert.equal(err.code, 'engine');
      assert.equal(err.tx_id, stale.tx_id);
      assert.equal(err.engine, E);
      a.send({ type: 'tx', tx: { foo: 1 } });
      assert.equal((await a.next()).code, 'bad-request');
      a.ws.send('не json');
      assert.equal((await a.next()).code, 'bad-request');
      a.send({ type: 'what' });
      assert.equal((await a.next()).code, 'bad-request');
      await a.close();

      const ghost = connect(wsUrl(svc, '00000000-0000-4000-8000-000000000000', { since: 0 }));
      await ghost.opened;
      const e = await ghost.next();
      assert.equal(e.type, 'error');
      assert.equal(e.code, 'not-found');
      assert.equal((await ghost.closed).code, 4404);

      const noProject = connect(`ws://127.0.0.1:${svc.port}/ws`);
      await noProject.opened;
      assert.equal((await noProject.next()).code, 'bad-request');
      assert.equal((await noProject.closed).code, 4400);
    });

    it('WS: транзакция, легшая во время догона, не теряется и не дублируется', async () => {
      const { id, board } = await fresh();
      // длинный хвост, чтобы догон занял время
      for (let i = 0; i < 6; i++) await http.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'х' + i))]));
      const a = connect(wsUrl(svc, id, { since: 0, client: 'A' }));
      // сразу после открытия — новая транзакция по HTTP, пока сокет ещё догоняет
      await a.opened;
      const racing = http.post(`/api/projects/${id}/tx`, tx(6, [ops.create(text(board.id, 'во время догона'))]));
      const seen = [];
      const hello = await a.next();
      assert.equal(hello.type, 'hello');
      await racing;
      for (;;) {
        const m = await a.next();
        seen.push(m.tx.seq);
        if (m.tx.seq === 7) break;
      }
      assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
      assert.ok(await a.silence(100));
      await a.close();
    });
  });
}

/* ------------------------------ статика без nginx ------------------------------ */

describe('статика из STATIC_DIR', () => {
  let svc;
  let http;
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'imago-static-'));
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Imago</title>');
    await writeFile(path.join(dir, 'app.js'), 'export const x = 1;');
    await writeFile(path.join(dir, 'styles.css'), 'body{margin:0}');
    await writeFile(path.join(dir, 'src', 'core.js'), 'export {};');
    svc = await startFor('memory', { staticDir: dir });
    http = api(svc.url);
  });
  after(async () => {
    await svc.close();
  });

  it('раздаёт index.html, app.js, styles.css, src/*.js с верным MIME', async () => {
    const root = await http.get('/');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /^text\/html/);
    assert.match(root.text, /Imago/);
    assert.match((await http.get('/index.html')).headers.get('content-type'), /^text\/html/);
    assert.match((await http.get('/app.js')).headers.get('content-type'), /^text\/javascript/);
    assert.match((await http.get('/styles.css')).headers.get('content-type'), /^text\/css/);
    assert.match((await http.get('/src/core.js')).headers.get('content-type'), /^text\/javascript/);
    assert.equal((await http.get('/nope.js')).status, 404);
    assert.equal((await http.get('/src/')).status, 404);
    assert.equal((await http.get('/..%2F..%2Fetc%2Fpasswd')).status, 404);
  });

  it('API живёт рядом со статикой', async () => {
    assert.equal((await http.get('/api/health')).status, 200);
  });
});
