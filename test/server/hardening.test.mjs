/**
 * Укрепление Document service (SPEC §9.8): пределы, единое тело ошибки, якорь
 * цепочки и эпоха, страницы журнала в байтах, ?head=1 и lean=1, семафор тяжёлых
 * чтений, прореживание снимков, выжимка dropped, трассы агента, NOTIFY между
 * экземплярами. Память — всегда, Postgres — когда база доступна.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, artboards, ops, uid, hashDoc, applyOps, ENGINE_VERSION } from '../../src/core.js';
import { LIMITS as CLIENT_SIDE } from '../../src/sync.js';
import * as limits from '../../server/document/limits.js';
import { chainNext, compactDropped } from '../../server/document/storage/committed.js';
import { mergeIntoHead } from '../../server/document/dslts.js';
import { createSemaphore } from '../../server/document/dslr.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { start } from '../../server/document/index.js';
import { backends, startFor, startTwin, api, connect, wsUrl, takeBackup, restoreBackup, waitFor, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const text = (parent, characters) => ({
  type: 'text', id: uid('n'), name: characters, parent, characters,
  style: { token: 'body' }, align: 'left', color: '#14161C'
});

/** Типы сообщений, пришедших до тишины. */
async function drainTypes(sock, ms = 150) {
  const out = [];
  while (!(await sock.silence(ms))) out.push((await sock.next()).type);
  return out;
}

/** Тело ошибки по SPEC §9.8. */
function isErrorBody(body, code) {
  assert.equal(body.error, true, JSON.stringify(body));
  assert.equal(body.code, code);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
  assert.equal(typeof body.retryable, 'boolean');
}

/* ------------------------------ без хранилища ------------------------------ */

describe('пределы и выжимки', () => {
  it('числа клиента (src/sync.js LIMITS) совпадают с сервером (limits.js CLIENT_LIMITS)', () => {
    assert.deepEqual({ ...CLIENT_SIDE }, { ...limits.CLIENT_LIMITS });
    assert.equal(limits.MAX_BODY_BYTES, 4 * 1024 * 1024);
    assert.equal(limits.MAX_OPS_PER_TX, 5000);
    assert.equal(limits.MAX_DOC_BYTES, 24 * 1024 * 1024);
    assert.equal(limits.MAX_DOC_NODES, 20000);
    assert.equal(limits.SNAPSHOT_KEEP, 5);
    assert.equal(limits.DB_TIMEOUT_MS, 8000);
    assert.equal(limits.MAX_TRACE_BYTES, 64 * 1024);
  });

  it('chainNext — sha256(prev + tx_id + seq), hex', () => {
    const c1 = chainNext('', 'tx_a', 1);
    assert.match(c1, /^[0-9a-f]{64}$/);
    assert.equal(chainNext(c1, 'tx_b', 2), chainNext(c1, 'tx_b', 2));
    assert.notEqual(chainNext(c1, 'tx_b', 2), chainNext(c1, 'tx_c', 2));
    assert.notEqual(chainNext(c1, 'tx_b', 2), chainNext(c1, 'tx_b', 3));
  });

  it('compactDropped: не больше 50 записей + {more}, большие значения — valueBytes/preview, идемпотентна', () => {
    const big = 'x'.repeat(5000);
    const list = Array.from({ length: 60 }, (_, i) => ({ index: i, op: ops.set('n' + i, 'name', i === 0 ? big : 'v'), reason: 'removed' }));
    const out = compactDropped(list);
    assert.equal(out.length, 51);
    assert.deepEqual(out[50], { more: 10 });
    assert.equal(out[1].op.value, 'v', 'малые операции — как есть');
    const first = out[0].op;
    assert.equal(first.op, 'set');
    assert.equal(first.id, 'n0');
    assert.equal(first.path, 'name');
    assert.equal('value' in first, false);
    assert.ok(first.valueBytes > 5000);
    assert.equal(typeof first.preview, 'string');
    assert.ok(first.preview.length <= limits.DROPPED_PREVIEW_CHARS);
    assert.deepEqual(compactDropped(out), out, 'вторая выжимка ничего не меняет');
    const node = compactDropped([{ index: 0, op: ops.create({ type: 'text', id: 'n1', name: 'T', parent: 'p', characters: big }), reason: 'exists' }])[0].op;
    assert.deepEqual(node.node, { id: 'n1', type: 'text', name: 'T', parent: 'p' });
    assert.ok(node.valueBytes > 5000);
  });

  it('mergeIntoHead: бюджет времени кончился — подозрительный остаток отброшен с limit merge_budget', () => {
    const doc = createDoc();
    const board = artboards(doc)[0];
    // rebase отдаёт применимое (по контракту), поэтому «строгий applyOps не принял» — подменой:
    // движок, который не принимает операции с пометкой `poison`
    const strict = (d, list) => (list.some((op) => op.poison) ? { doc: d, error: { message: 'яд' } } : applyOps(d, list));
    const good = ops.set(board.id, 'name', 'Ок');
    const bad = { ...ops.set(board.id, 'name', 'плохо'), poison: true };
    const t = tx(0, [good, bad, ops.set(board.id, 'name', 'Ещё'), { ...bad }]);
    const normal = mergeIntoHead({ doc, tombstones: new Map() }, t, { applyOps: strict });
    assert.deepEqual(normal.dropped.map((d) => [d.index, d.reason, d.limit]), [[1, 'invalid', undefined], [3, 'invalid', undefined]]);
    assert.equal(normal.ops.length, 2);
    const starved = mergeIntoHead({ doc, tombstones: new Map() }, t, { applyOps: strict, mergeBudgetMs: -1 });
    assert.deepEqual(starved.dropped.map((d) => [d.index, d.reason, d.limit]), [[1, 'invalid', 'merge_budget'], [2, 'invalid', 'merge_budget'], [3, 'invalid', 'merge_budget']]);
    assert.deepEqual(starved.ops, [good]);
  });

  it('семафор тяжёлых чтений: max одновременно, очередь, переполнение → 503 busy + retry_after', async () => {
    const sem = createSemaphore({ max: 1, queue: 1, retryAfter: 3 });
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = sem.run(() => gate);
    const second = sem.run(async () => 'второй');
    await assert.rejects(sem.run(async () => 'третий'), (e) => e.status === 503 && e.code === 'busy' && e.retryable === true && e.retryAfter === 3);
    release('первый');
    assert.equal(await first, 'первый');
    assert.equal(await second, 'второй');
    assert.equal(sem.active, 0);
  });
});

/* ------------------------------ сервис ------------------------------ */

const list = await backends();

for (const backend of list) {
  describe(`укрепление · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let svc;
    let http;
    before(async () => {
      svc = await startFor(backend.name, { snapshotEvery: 0, verifyMs: 0, internalToken: 'тайный-токен-1' });
      http = api(svc.url);
    });
    after(async () => {
      await svc.close();
    });

    async function fresh(name = 'Проба') {
      const created = await http.post('/api/projects', { name, demo: true });
      assert.equal(created.status, 201);
      const opened = await http.get('/api/projects/' + created.body.id);
      return { id: created.body.id, doc: opened.body.snapshot.doc, board: artboards(opened.body.snapshot.doc)[0], epoch: created.body.epoch };
    }

    it('единое тело ошибки: 400 · 404 · 405 · 413 · 426 — {error:true, code, message, retryable}', async () => {
      const { id, board } = await fresh();
      isErrorBody((await http.get('/api/nope')).body, 'not_found');
      isErrorBody((await http.get('/api/projects/00000000-0000-4000-8000-000000000000')).body, 'not_found');
      const del = await http.raw('DELETE', '/api/projects/' + id);
      assert.equal(del.status, 405);
      isErrorBody(del.body, 'method_not_allowed');
      isErrorBody((await http.post(`/api/projects/${id}/tx`, { foo: 1 })).body, 'bad_request');
      const old = await http.post(`/api/projects/${id}/tx`, tx(0, [], { engine: E + 1 }));
      assert.equal(old.status, 426);
      isErrorBody(old.body, 'engine');
      assert.deepEqual(old.body.detail, { engine: E });
      // операций больше предела — 413 с пометкой предела
      const many = tx(0, Array.from({ length: limits.MAX_OPS_PER_TX + 1 }, () => ops.set(board.id, 'name', 'x')));
      const r = await http.post(`/api/projects/${id}/tx`, many);
      assert.equal(r.status, 413);
      isErrorBody(r.body, 'too_large');
      assert.equal(r.body.detail.limit, 'ops_per_tx');
      assert.equal(r.body.retryable, false);
      const body = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.set(board.id, 'name', 'x'.repeat(limits.MAX_BODY_BYTES))]));
      assert.equal(body.status, 413);
      isErrorBody(body.body, 'too_large');
    });

    it('якорь: chain каждой записи = sha256(prev + tx_id + seq); голова, снимок, hello и ops несут epoch и tip', async () => {
      const { id, board, epoch } = await fresh();
      assert.match(epoch, /^[0-9a-f]{12}$/);
      let prev = '';
      const committed = [];
      for (let i = 0; i < 3; i++) {
        const r = await http.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'т' + i))]));
        assert.equal(r.status, 201);
        prev = chainNext(prev, r.body.tx_id, r.body.seq);
        assert.equal(r.body.chain, prev);
        committed.push(r.body);
      }
      const head = await http.get(`/api/projects/${id}?head=1`);
      assert.equal(head.status, 200);
      assert.deepEqual(Object.keys(head.body).sort(), ['epoch', 'head_seq', 'id', 'kind', 'name', 'tip', 'updated_at']);
      assert.equal(head.body.head_seq, 3);
      assert.equal(head.body.tip, prev);
      assert.equal(head.body.epoch, epoch);
      const full = await http.get(`/api/projects/${id}`);
      assert.equal(full.body.tip, prev);
      assert.equal(full.body.epoch, epoch);
      assert.equal(full.body.snapshot.chain, '', 'затравка seq 0 — пустой якорь');
      assert.equal(full.body.more, false);
      assert.deepEqual(full.body.tail.map((t) => t.chain), committed.map((t) => t.chain));
      const ws = connect(wsUrl(svc, id, { since: 3, client: 'A' }));
      await ws.opened;
      const hello = await ws.next();
      assert.equal(hello.type, 'hello');
      assert.equal(hello.epoch, epoch);
      assert.equal(hello.tip, prev);
      await ws.close();
    });

    it('lean=1: без документа снимка, хвост после since; since впереди головы → 410', async () => {
      const { id, board } = await fresh();
      for (let i = 0; i < 3; i++) await http.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'л' + i))]));
      const lean = await http.get(`/api/projects/${id}?lean=1`);
      assert.equal(lean.status, 200);
      assert.equal(lean.body.snapshot.seq, 0);
      assert.equal('doc' in lean.body.snapshot, false);
      assert.deepEqual(lean.body.tail.map((t) => t.seq), [1, 2, 3]);
      const after2 = await http.get(`/api/projects/${id}?lean=1&since=2`);
      assert.deepEqual(after2.body.tail.map((t) => t.seq), [3]);
      assert.equal(after2.body.head_seq, 3);
      const ahead = await http.get(`/api/projects/${id}?lean=1&since=9`);
      assert.equal(ahead.status, 410);
      isErrorBody(ahead.body, 'gone');
      assert.equal(ahead.body.snapshot.seq, 0);
    });

    it('страницы журнала в байтах: more:true, дочитывание по since даёт всё по порядку', async () => {
      const small = await start({ port: 0, storage: svc.storage, pageBytes: 1500, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        const h = api(small.url);
        const { id, board } = await fresh();
        for (let i = 0; i < 8; i++) await h.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'с'.repeat(200) + i))]));
        const first = await h.get(`/api/projects/${id}/ops?since=0&limit=500`);
        assert.equal(first.body.more, true);
        assert.ok(first.body.txs.length >= 1 && first.body.txs.length < 8, 'страница ограничена байтами: ' + first.body.txs.length);
        const seen = [];
        let since = 0;
        for (let guard = 0; guard < 20; guard++) {
          const r = await h.get(`/api/projects/${id}/ops?since=${since}`);
          seen.push(...r.body.txs.map((t) => t.seq));
          if (!r.body.more) break;
          since = r.body.txs[r.body.txs.length - 1].seq;
        }
        assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
        const opened = await h.get(`/api/projects/${id}`);
        assert.equal(opened.body.more, true, 'открытие — тоже первой страницей');
        assert.equal(opened.body.head_seq, 8);
        // сокет дочитывает всё сам
        const ws = connect(wsUrl(small, id, { since: 0, client: 'W' }));
        await ws.opened;
        await ws.next();
        const got = [];
        for (let i = 0; i < 8; i++) got.push((await ws.next()).tx.seq);
        assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8]);
        await ws.close();
      } finally {
        await small.close({ closeStorage: false });
      }
    });

    it('семафор: полные снимки сверх очереди → 503 busy с Retry-After; голова и lean — мимо семафора', async () => {
      const { id } = await fresh();
      const busy = await start({ port: 0, storage: svc.storage, heavyConcurrency: 1, heavyQueue: 0, retryAfter: 2, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        // занять единственное место тяжёлым чтением, которое не кончается, пока не отпустим
        let release;
        const hold = busy.dslr.heavy.run(() => new Promise((r) => { release = r; }));
        const h = api(busy.url);
        const r = await h.get('/api/projects/' + id);
        assert.equal(r.status, 503);
        isErrorBody(r.body, 'busy');
        assert.equal(r.body.retryable, true);
        assert.equal(r.headers.get('retry-after'), '2');
        assert.equal((await h.get(`/api/projects/${id}?head=1`)).status, 200);
        assert.equal((await h.get(`/api/projects/${id}?lean=1`)).status, 200);
        // сокет, которому нужен снимок, получает error busy и закрытие 4503
        const ws = connect(wsUrl(busy, id, { since: -1 }));
        await ws.opened;
        const hello = await ws.next();
        assert.equal(hello.type, 'hello');
        const err = await ws.next();
        assert.equal(err.type, 'error');
        assert.equal(err.code, 'busy');
        assert.equal(err.retry_after, 2);
        assert.equal((await ws.closed).code, 4503);
        release();
        await hold;
        assert.equal((await h.get('/api/projects/' + id)).status, 200);
      } finally {
        await busy.close({ closeStorage: false });
      }
    });

    it('снимки: раз в N, хранятся последние 5, затравка seq 0 — никогда не удаляется', async () => {
      const snap = await start({ port: 0, storage: svc.storage, snapshotEvery: 1, snapshotKeep: 5, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        const h = api(snap.url);
        const { id, board, doc } = await fresh();
        for (let i = 0; i < 9; i++) {
          await h.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'с' + i))]));
          await snap.dslts.flush();
        }
        assert.deepEqual(await svc.storage.snapshotSeqs(id), [0, 5, 6, 7, 8, 9]);
        const opened = await h.get('/api/projects/' + id);
        assert.equal(opened.body.snapshot.seq, 9);
        // журнал с начала по-прежнему переигрывается: затравка на месте
        const seed = await svc.storage.chainAt(id, 0);
        assert.equal(seed, '');
        const all = await h.get(`/api/projects/${id}/ops?since=0`);
        let cur = doc;
        for (const t of all.body.txs) cur = applyOps(cur, t.ops).doc;
        assert.equal(hashDoc(cur), hashDoc(opened.body.snapshot.doc));
      } finally {
        await snap.close({ closeStorage: false });
      }
    });

    it('снимок по журналу, которого уже нет (откат), не пишется и не отдаётся', async () => {
      const { id, board } = await fresh();
      await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'до'))]));
      const backup = await takeBackup(svc.storage, id);
      await http.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'пропадёт'))]));
      const oldChain = await svc.storage.chainAt(id, 2);
      const oldDoc = (await svc.dslts.headOf(id)).doc;
      await restoreBackup(svc.storage, id, backup);
      // другая транзакция под тем же seq 2
      await svc.dslts.verify();
      const r = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.set(board.id, 'name', 'новое')]));
      assert.equal(r.body.seq, 2);
      // запоздалый снимок старого журнала — мимо
      assert.equal(await svc.storage.writeSnapshot(id, 2, oldDoc, E, oldChain), false);
      const snap = await svc.storage.latestSnapshot(id);
      assert.equal(snap.seq, 0);
    });

    it('предел документа: транзакция, которая раздула бы документ, ложится без create/set (dropped invalid + limit), remove проходит', async () => {
      const { id, board, doc } = await fresh();
      const nodes = Object.keys(doc.nodes).length;
      const tight = await start({ port: 0, storage: svc.storage, maxDocNodes: nodes + 2, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        const h = api(tight.url);
        const one = await h.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'влезет'))]));
        assert.deepEqual(one.body.dropped, []);
        const victim = board.children[0];
        const three = [ops.create(text(board.id, 'a')), ops.create(text(board.id, 'b')), ops.remove(victim), ops.create(text(board.id, 'c'))];
        // после remove поддерева узлов станет меньше — проверяем на том, что действительно раздувает
        const grow = await h.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'a')), ops.create(text(board.id, 'b')), ops.create(text(board.id, 'c'))]));
        assert.equal(grow.status, 201);
        assert.equal(grow.body.seq, 2, 'транзакция получила номер — автору нужен ответ');
        assert.deepEqual(grow.body.ops, []);
        assert.deepEqual(grow.body.dropped.map((d) => [d.reason, d.limit]), [['invalid', 'doc_nodes'], ['invalid', 'doc_nodes'], ['invalid', 'doc_nodes']]);
        const mixed = await h.post(`/api/projects/${id}/tx`, tx(2, three));
        assert.equal(mixed.status, 201);
        assert.ok(mixed.body.ops.some((o) => o.op === 'remove'), 'remove уменьшает документ — проходит');
      } finally {
        await tight.close({ closeStorage: false });
      }
      const bytes = Buffer.byteLength(JSON.stringify((await svc.dslts.headOf(id)).doc));
      const heavy = await start({ port: 0, storage: svc.storage, maxDocBytes: bytes + 300, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        await svc.dslts.unload(id);
        const h = api(heavy.url);
        const head = await h.get(`/api/projects/${id}?head=1`);
        const r = await h.post(`/api/projects/${id}/tx`, tx(head.body.head_seq, [ops.create(text(board.id, 'ж'.repeat(2000)))]));
        assert.equal(r.status, 201);
        assert.deepEqual(r.body.dropped.map((d) => d.limit), ['doc_bytes']);
      } finally {
        await heavy.close({ closeStorage: false });
      }
    });

    it('предел документа в байтах — точный (§9.10): узлы с длинными id не проскакивают за предел по оценке', async () => {
      const { id, board } = await fresh();
      await svc.dslts.unload(id);
      const bytes0 = Buffer.byteLength(JSON.stringify((await svc.dslts.headOf(id)).doc));
      const max = bytes0 + 20000;
      const tight = await start({ port: 0, storage: svc.storage, maxDocBytes: max, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        const h = api(tight.url);
        // id длинный, узел короткий: документ растёт втрое быстрее, чем JSON операции (ключ, id, ребёнок родителя)
        const longText = () => ({ ...text(board.id, 'т'), id: 'n_' + 'x'.repeat(118) + uid('') });
        let seq = (await h.get(`/api/projects/${id}?head=1`)).body.head_seq;
        let limited = false;
        for (let i = 0; i < 200 && !limited; i++) {
          const r = await h.post(`/api/projects/${id}/tx`, tx(seq, [ops.create(longText())]));
          assert.equal(r.status, 201);
          seq = r.body.seq;
          limited = r.body.dropped.some((d) => d.limit === 'doc_bytes');
          const head = await tight.dslts.headOf(id);
          const real = Buffer.byteLength(JSON.stringify(head.doc));
          assert.ok(real <= max, `документ ${real} > предела ${max} после seq ${seq}`);
        }
        assert.ok(limited, 'предел достигнут');
      } finally {
        await tight.close({ closeStorage: false });
      }
    });

    it('dropped в журнале — выжимкой: 50 записей + {more}, большие значения без самого значения', async () => {
      const { id, board } = await fresh();
      await http.post(`/api/projects/${id}/tx`, tx(0, [ops.remove(board.id)]));
      const list = Array.from({ length: 60 }, (_, i) => ops.set(board.id, 'name', i === 0 ? 'я'.repeat(4000) : 'и' + i));
      const r = await http.post(`/api/projects/${id}/tx`, tx(0, list));
      assert.equal(r.status, 201);
      assert.equal(r.body.dropped.length, 51);
      assert.deepEqual(r.body.dropped[50], { more: 10 });
      assert.equal('value' in r.body.dropped[0].op, false);
      assert.ok(r.body.dropped[0].op.valueBytes > 4000);
      const stored = (await http.get(`/api/projects/${id}/ops?since=1`)).body.txs[0];
      assert.deepEqual(stored.dropped, r.body.dropped, 'в журнале — та же выжимка');
    });

    it('трассы: POST /api/internal/traces только с X-Internal-Token; ≤ 64 КБ; GET …/traces — последние', async () => {
      const { id } = await fresh();
      const trace = (n) => ({ project: id, command_id: 'cmd_' + n, steps: [{ key: 'llm', ms: 10 * n }], calls: 1 });
      const no = await http.post('/api/internal/traces', trace(0));
      assert.equal(no.status, 403);
      isErrorBody(no.body, 'forbidden');
      assert.equal((await http.post('/api/internal/traces', trace(0), { 'x-internal-token': 'wrong-token' })).status, 403);
      assert.equal((await http.post('/api/internal/traces', trace(0), { 'x-internal-token': 'change-me' })).status, 403);
      const tok = { 'x-internal-token': encodeURIComponent('тайный-токен-1') };
      // заголовок — latin1: токен по-русски не годится, поэтому сервис с ASCII-токеном ниже
      assert.equal((await http.post('/api/internal/traces', trace(0), tok)).status, 403);
      const ascii = await start({ port: 0, storage: svc.storage, internalToken: 'secret-token-1', snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      const empty = await start({ port: 0, storage: svc.storage, internalToken: '', snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      const placeholder = await start({ port: 0, storage: svc.storage, internalToken: 'change-me', snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
      try {
        const h = api(ascii.url);
        const good = { 'x-internal-token': 'secret-token-1' };
        for (let i = 1; i <= 3; i++) {
          const r = await h.post('/api/internal/traces', trace(i), good);
          assert.equal(r.status, 201, JSON.stringify(r.body));
          assert.ok(r.body.id);
        }
        const huge = await h.post('/api/internal/traces', { ...trace(9), blob: 'x'.repeat(limits.MAX_TRACE_BYTES) }, good);
        assert.equal(huge.status, 413);
        isErrorBody(huge.body, 'too_large');
        assert.equal((await h.post('/api/internal/traces', { ...trace(1), project: '00000000-0000-4000-8000-000000000000' }, good)).status, 404);
        assert.equal((await h.post('/api/internal/traces', { project: id }, good)).status, 400);
        // без env и с заглушкой — закрыто даже для «правильного» заголовка
        assert.equal((await api(empty.url).post('/api/internal/traces', trace(1), { 'x-internal-token': '' })).status, 403);
        assert.equal((await api(placeholder.url).post('/api/internal/traces', trace(1), { 'x-internal-token': 'change-me' })).status, 403);
        const got = await http.get(`/api/projects/${id}/traces?limit=2`);
        assert.equal(got.status, 200);
        assert.deepEqual(got.body.traces.map((t) => t.command_id), ['cmd_3', 'cmd_2']);
        assert.equal(got.body.traces[0].body.calls, 1);
        assert.ok(got.body.traces[0].created_at);
        assert.equal((await http.get(`/api/projects/${id}/traces`)).body.traces.length, 3);
        assert.equal((await http.get('/api/projects/00000000-0000-4000-8000-000000000000/traces')).status, 404);
        assert.equal((await http.get(`/api/projects/${id}/traces?limit=0`)).status, 400);
      } finally {
        for (const s of [ascii, empty, placeholder]) await s.close({ closeStorage: false });
      }
    });

    it('tip клиента: совпал — хвост; не совпал при нынешней эпохе — снимок и смена эпохи один раз; впереди головы — зажим без смены', async () => {
      const { id, board, epoch } = await fresh();
      const r1 = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'раз'))]));
      const r2 = await http.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'два'))]));

      // совпал: хвост
      const ok = connect(wsUrl(svc, id, { since: 1, tip: r1.body.chain, epoch, client: 'ok' }));
      await ok.opened;
      const helloOk = await ok.next();
      assert.equal(helloOk.type, 'hello');
      assert.equal(helloOk.gone, false, 'hello говорит: снимка не будет');
      assert.equal((await ok.next()).tx.seq, 2);

      // впереди головы: снимок, эпоха та же, никого не закрыли
      const ahead = connect(wsUrl(svc, id, { since: 7, tip: 'f'.repeat(64), epoch, client: 'ahead' }));
      await ahead.opened;
      const h1 = await ahead.next();
      assert.equal(h1.epoch, epoch);
      assert.equal((await ahead.next()).type, 'gone');
      await ahead.close();
      assert.deepEqual(await ok.next(), { type: 'left', client: 'ahead' });
      assert.ok(await ok.silence(100), 'зажим никого не закрывает');
      assert.equal((await http.get(`/api/projects/${id}?head=1`)).body.epoch, epoch);

      // не совпал при нынешней эпохе: снимок этому, эпоха меняется, остальные — 4410
      const bad = connect(wsUrl(svc, id, { since: 2, tip: '0'.repeat(64), epoch, client: 'bad' }));
      await bad.opened;
      const helloBad = await bad.next();
      assert.notEqual(helloBad.epoch, epoch);
      assert.equal(helloBad.gone, true, 'hello говорит: следом снимок');
      const goneBad = await bad.next();
      assert.equal(goneBad.type, 'gone');
      assert.equal(goneBad.epoch, helloBad.epoch);
      assert.equal(goneBad.tip, goneBad.snapshot.chain);
      assert.equal((await bad.until((m) => m.type === 'tx')).tx.seq, 1, 'за снимком — хвост до головы');
      assert.equal((await bad.until((m) => m.type === 'tx')).tx.seq, 2);
      const closedOk = await ok.until((m) => m.type === 'error');
      assert.equal(closedOk.code, 'epoch');
      assert.equal((await ok.closed).code, 4410);
      const epoch1 = helloBad.epoch;

      // тот же неисправный клиент снова, уже в новой эпохе: снимок — да, новая смена — нет
      const again = connect(wsUrl(svc, id, { since: 2, tip: '0'.repeat(64), epoch: epoch1, client: 'bad2' }));
      await again.opened;
      assert.equal((await again.next()).epoch, epoch1);
      assert.equal((await again.next()).type, 'gone');
      await again.close();
      const seen = await drainTypes(bad);
      assert.ok(!seen.includes('error'), 'смены эпохи нет — живой сокет не закрыт: ' + seen.join(','));
      assert.equal(bad.ws.readyState, bad.ws.OPEN);
      // эпоха, которой база не знает, — тоже след, но эпоха, начатая клиентом, клиентом не меняется
      const ghost = connect(wsUrl(svc, id, { since: 2, tip: r2.body.chain, epoch: 'abcdefabcdef', client: 'ghost' }));
      await ghost.opened;
      assert.equal((await ghost.next()).epoch, epoch1);
      assert.ok(await ghost.silence(100), 'tip совпал — догонять нечего, снимок не нужен');
      assert.equal((await http.get(`/api/projects/${id}?head=1`)).body.epoch, epoch1);
      const epochs = await svc.storage.epochs(id);
      assert.deepEqual(epochs.map((e) => e.cause), ['init', 'client']);

      // старая известная эпоха с неверным tip: снимок без смены
      const old = connect(wsUrl(svc, id, { since: 2, tip: '1'.repeat(64), epoch, client: 'old' }));
      await old.opened;
      assert.equal((await old.next()).epoch, epoch1);
      assert.equal((await old.next()).type, 'gone');
      // HTTP: тот же разбор — 410 со снимком и эпохой
      const ops410 = await http.get(`/api/projects/${id}/ops?since=1&tip=${'2'.repeat(64)}&epoch=${epoch1}`);
      assert.equal(ops410.status, 410);
      isErrorBody(ops410.body, 'gone');
      assert.equal(ops410.body.epoch, epoch1);
      assert.equal(ops410.body.snapshot.seq, 0);
      const opsOk = await http.get(`/api/projects/${id}/ops?since=1&tip=${r1.body.chain}&epoch=${epoch}`);
      assert.equal(opsOk.status, 200, 'старая эпоха, но tip сошёлся — хвост');
      assert.deepEqual(opsOk.body.txs.map((t) => t.seq), [2]);
      assert.equal((await svc.storage.epochs(id)).length, 2);
      for (const s of [bad, ghost, old]) await s.close();
    });

    it('без tip и epoch (прежний клиент) — только по номерам, как раньше', async () => {
      const { id, board } = await fresh();
      await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'раз'))]));
      const ws = connect(wsUrl(svc, id, { since: 0, client: 'old' }));
      await ws.opened;
      const hello = await ws.next();
      assert.equal(hello.head_seq, 1);
      assert.equal((await ws.next()).tx.seq, 1);
      await ws.close();
      const r = await http.get(`/api/projects/${id}/ops?since=0`);
      assert.deepEqual(r.body.txs.map((t) => t.seq), [1]);
    });

    it('два экземпляра: транзакция через один доходит до сокета другого (NOTIFY), голова второго догоняет', async () => {
      const twin = await startTwin(backend.name, svc, { verifyMs: 0 });
      try {
        const { id, board } = await fresh();
        const ws = connect(wsUrl(twin, id, { since: 0, client: 'T' }));
        await ws.opened;
        assert.equal((await ws.next()).type, 'hello');
        const r = await http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'через первый'))]));
        const got = await ws.next();
        assert.equal(got.type, 'tx');
        assert.deepEqual(got.tx, r.body);
        await waitFor(async () => (await twin.dslts.headOf(id)).head_seq === 1, 'голова второго экземпляра');
        // и обратно
        const back = await api(twin.url).post(`/api/projects/${id}/tx`, tx(1, [ops.set(board.id, 'name', 'Через второй')]));
        assert.equal(back.body.seq, 2);
        assert.equal((await ws.next()).tx.seq, 2);
        const [a, b] = await Promise.all([svc.dslts.headOf(id), twin.dslts.headOf(id)]);
        assert.equal(hashDoc(a.doc), hashDoc(b.doc));
        await ws.close();
      } finally {
        await twin.close();
      }
    });
  });
}

/* ------------------------------ голова читается страницами ------------------------------ */

describe('голова секвенсора: хвост короткими страницами', () => {
  it('загрузка и догон головы читают до пустой страницы, а не до «страница короче предела»', async () => {
    const mem = createMemoryStorage();
    // хранилище, которое отдаёт не больше двух записей за раз (как страница, упёршаяся в байты)
    const stingy = { ...mem, txsAfter: (id, seq, limit, o) => mem.txsAfter(id, seq, Math.min(limit, 2), o) };
    const a = await start({ port: 0, storage: stingy, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
    const b = await start({ port: 0, storage: stingy, snapshotEvery: 0, verifyMs: 0, pingInterval: 0, log: quiet });
    try {
      const h = api(a.url);
      const created = await h.post('/api/projects', { name: 'Страницы', demo: true });
      const id = created.body.id;
      const board = artboards((await h.get('/api/projects/' + id)).body.snapshot.doc)[0];
      await b.dslts.headOf(id);   // второй экземпляр загрузил голову на seq 0
      for (let i = 0; i < 7; i++) await h.post(`/api/projects/${id}/tx`, tx(i, [ops.create(text(board.id, 'п' + i))]));
      await a.dslts.unload(id);
      const head = await a.dslts.headOf(id);
      assert.equal(head.head_seq, 7, 'загрузка дочитала весь хвост');
      const other = await b.dslts.headOf(id);
      assert.equal(other.head_seq, 7, 'догон второго экземпляра — тоже');
      assert.equal(hashDoc(head.doc), hashDoc(other.doc));
    } finally {
      await b.close({ closeStorage: false });
      await a.close();
    }
  });
});

/* ------------------------------ память: адаптер ------------------------------ */

describe('хранилище в памяти: бэкап и restore', () => {
  it('restore возвращает журнал, снимки и эпохи к бэкапу', async () => {
    const s = createMemoryStorage();
    const p = await s.createProject({ name: 'Б', kind: 'design', doc: createDoc('empty'), engine: E });
    const rec = (base) => ({ tx_id: uid('tx'), base_seq: base, ops: [], dropped: [], notes: [], author_kind: 'human', engine: E });
    await s.commitTx(p.id, rec(0));
    const b = s.backup();
    await s.commitTx(p.id, rec(1));
    await s.bumpEpoch(p.id, p.epoch, 'instance', 'x');
    s.restore(b);
    assert.equal((await s.getProject(p.id)).head_seq, 1);
    assert.equal((await s.getProject(p.id)).epoch, p.epoch);
    assert.equal((await s.epochs(p.id)).length, 1);
  });
});
