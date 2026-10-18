/**
 * Устойчивость Document service (SPEC §9.9, круг 24):
 *   · обрыв LISTEN-соединения (pg_terminate_backend), пока другой экземпляр пишет, —
 *     экземпляр переподключает слушателя и дочитывает пропущенное без таймера сверки;
 *   · обрыв всех соединений экземпляра под нагрузкой реплик — все сходятся;
 * и находки критического прохода по server/document:
 *   · сокет, закрытый до hello, не остаётся в комнате (утечка комнаты и головы);
 *   · кеш кадров ограничен байтами (на комнату и на экземпляр);
 *   · прежний клиент (без tip/epoch/proto) вместо ack получает error duplicate;
 *   · страница журнала режется по байтам одинаково у pg и памяти; потерянные записи
 *     журнала — 410/gone, а не `more: true` с пустой страницей; догон сокета не
 *     читает снимок по кругу;
 *   · выгрузка головы по бездействию посреди медленных записей ничего не теряет;
 *   · медленный читатель закрывается (4503), а не копит память экземпляра.
 * Круг 25: полуоткрытое соединение посреди транзакции записи (ответ базы не доходит,
 * обрыв база не видит) — замок строки проекта отпускается сам (idle_in_transaction_session_timeout),
 * соединение с истёкшим query_timeout в пул не возвращается.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import * as core from '../../src/core.js';
import { createSync, memoryStorage } from '../../src/sync.js';
import { start } from '../../server/document/index.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { backends, startFor, startTwin, api, connect, wsUrl, waitFor, quiet, RUN_ID, DB_URL } from './helpers.mjs';

const { artboards, ops, uid, hashDoc, applyOps, ENGINE_VERSION: E } = core;
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const text = (parent, characters) => ({
  type: 'text', id: uid('n'), name: characters.slice(0, 40), parent, characters,
  style: { token: 'body' }, align: 'left', color: '#14161C'
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Журнал целиком (страницами). */
async function journal(http, id) {
  const txs = [];
  let since = 0;
  for (;;) {
    const r = await http.get(`/api/projects/${id}/ops?since=${since}&limit=500`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    txs.push(...r.body.txs);
    if (!r.body.more || !r.body.txs.length) break;
    since = r.body.txs[r.body.txs.length - 1].seq;
  }
  return txs;
}
function replay(doc, txs) {
  let cur = doc;
  for (const t of txs) {
    const res = applyOps(cur, t.ops);
    assert.equal(res.error, undefined, `seq ${t.seq} обязана применяться`);
    cur = res.doc;
  }
  return cur;
}

/** Обёртка хранилища: те же методы, часть подменена (замедление, потеря записей). */
function wrap(storage, over) {
  const out = {};
  for (const k of Object.keys(storage)) out[k] = typeof storage[k] === 'function' ? storage[k].bind(storage) : storage[k];
  return Object.assign(out, over);
}

const list = await backends();
const pgUp = list.find((b) => b.name === 'pg').available;

/* ------------------------------ обрыв LISTEN (pg) ------------------------------ */

describe('обрыв LISTEN и соединений · pg', { skip: pgUp ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  let i1;
  let i2;
  // имена сеансов — свои на прогон: параллельный прогон на том же кластере их не считает и не рвёт
  const A1 = 'r24_i1_' + RUN_ID;
  const A2 = 'r24_i2_' + RUN_ID;
  before(async () => {
    // сверка по таймеру выключена: пропущенное обязано прийти именно после переподключения слушателя
    i1 = await startFor('pg', { verifyMs: 0 }, { listenRetryMs: 2500, applicationName: A1 });
    i2 = await startTwin('pg', i1, { verifyMs: 0 }, { applicationName: A2 });
  });
  after(async () => {
    await i2.close();
    await i1.close();
  });

  const listeners = async (name) => (await i2.storage.pool.query(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1', [name]
  )).rows[0].n;

  it('pg_terminate_backend слушателя, другой экземпляр пишет за время обрыва — переподключение и дочитывание (3 круга)', async () => {
    const http2 = api(i2.url);
    const created = await http2.post('/api/projects', { name: 'LISTEN', demo: true });
    const id = created.body.id;
    const seedDoc = (await http2.get('/api/projects/' + id)).body.snapshot.doc;
    const board = artboards(seedDoc)[0];
    const S = connect(wsUrl(i1, id, { since: 0, client: 'S', proto: 2 }));
    await S.opened;
    assert.equal((await S.next()).type, 'hello');
    const P = connect(wsUrl(i2, id, { client: 'P' }));
    await P.opened;
    await P.next();
    assert.equal(await listeners(A1 + ':listen'), 1);

    let seq = 0;
    for (let round = 0; round < 3; round++) {
      const pid = i1.storage.listenerPid;
      assert.ok(pid > 0);
      await i2.storage.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await waitFor(() => !i1.storage.listening, 'слушатель потерян');
      for (let k = 0; k < 15; k++) {
        const r = await http2.post(`/api/projects/${id}/tx`, tx(seq, [ops.create(text(board.id, `круг ${round} · ${k}`))]));
        assert.equal(r.status, 201);
        seq = r.body.seq;
      }
      assert.equal(i1.storage.listening, false, 'все записи — за время обрыва');
      // ни одной пропущенной не пришло до переподключения: сверка выключена
      for (let s = seq - 14; s <= seq; s++) {
        const m = await S.until((x) => x.type === 'tx', 8000);
        assert.equal(m.tx.seq, s, 'по порядку, без дыр');
      }
      assert.equal(i1.storage.listening, true, 'слушатель вернулся');
      assert.equal(i1.storage.listenerPid !== pid, true);
      assert.equal(await listeners(A1 + ':listen'), 1, 'слушатель один (повтор назначается один раз)');
      // шина присутствия тоже вернулась
      P.send({ type: 'presence', selection: ['r' + round] });
      assert.deepEqual((await S.until((x) => x.type === 'presence', 5000)).selection, ['r' + round]);
    }
    const head = await i1.dslts.headOf(id);
    assert.equal(head.head_seq, 45);
    const log = await journal(http2, id);
    assert.equal(hashDoc(head.doc), hashDoc(replay(seedDoc, log)), 'голова i1 = переигрывание журнала');
    await Promise.all([S.close(), P.close()]);
  });

  it('обрыв всех соединений экземпляра (пул и слушатель) под нагрузкой реплик — все сходятся, без дублей и дыр', async () => {
    const http1 = api(i1.url);
    const id = (await http1.post('/api/projects', { name: 'Обрыв', demo: true })).body.id;
    const seedDoc = (await i1.storage.latestSnapshot(id)).doc;
    const board = artboards(seedDoc)[0];
    const mk = (svc, clientId) => createSync({
      core, baseUrl: svc.url, projectId: id, clientId, author: clientId, storage: memoryStorage(),
      WebSocketImpl: WebSocket, fetchImpl: (...a) => fetch(...a), reconnectMin: 20, reconnectMax: 300
    });
    const reps = [mk(i1, 'a1'), mk(i1, 'a2'), mk(i2, 'b1'), mk(i2, 'b2')];
    await Promise.all(reps.map((r) => r.open()));
    await waitFor(() => reps.every((r) => r.status.online), 'в сети');
    const written = [];
    let stop = false;
    const workers = reps.map(async (r, n) => {
      for (let k = 0; !stop && k < 40; k++) {
        const node = text(board.id, `${r.clientId} · ${k}`);
        const res = r.commit([ops.create(node)]);
        if (res.tx) written.push(res.tx.tx_id);
        await delay(10 + n * 3);
      }
    });
    for (let cut = 0; cut < 2; cut++) {
      await delay(120);
      await i2.storage.pool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1 AND pid <> pg_backend_pid()',
        [A1 + '%']
      );
    }
    await Promise.all(workers);
    stop = true;
    await waitFor(async () => {
      const h = (await http1.get(`/api/projects/${id}?head=1`)).body;
      return reps.every((r) => r.status.online && r.status.pending === 0 && r.confirmed.seq === h.head_seq);
    }, 'все догнали голову без очереди', 30000);
    const log = await journal(http1, id);
    const ids = log.map((t) => t.tx_id);
    assert.equal(new Set(ids).size, ids.length, 'ни одна не записана дважды');
    assert.deepEqual(log.map((t) => t.seq), log.map((_, k) => k + 1), 'без дыр');
    for (const t of written) assert.ok(ids.includes(t), 'правка не потеряна');
    const truth = hashDoc(replay(seedDoc, log));
    for (const r of reps) assert.equal(hashDoc(r.view), truth);
    const [h1, h2] = await Promise.all([i1.dslts.headOf(id), i2.dslts.headOf(id)]);
    assert.equal(hashDoc(h1.doc), truth);
    assert.equal(hashDoc(h2.doc), truth);
    await waitFor(() => i1.storage.listening, 'слушатель i1 вернулся', 10000);
    assert.equal(await listeners(A1 + ':listen'), 1);
    await Promise.all(reps.map((r) => r.close()));
  });
});

/* ------------------------------ полуоткрытое соединение (pg) ------------------------------ */

/**
 * TCP-прокси к Postgres: `arm()` — первое соединение, пославшее `INSERT INTO operations`,
 * больше не получает ответов базы, а его закрытие клиентом база не видит (полуоткрытое:
 * как пропавшая сеть). Остальные соединения — как есть.
 */
async function halfOpenProxy(target) {
  const pairs = new Set();
  let armed = false;
  const state = { trappedAt: 0 };
  const server = net.createServer((c) => {
    const s = net.connect(target.port, target.host);
    const pair = { c, s, drop: false };
    pairs.add(pair);
    c.on('data', (d) => {
      if (armed && !pair.drop && d.includes('INSERT INTO operations')) {
        pair.drop = true;
        armed = false;
        state.trappedAt = Date.now();
      }
      if (!s.destroyed) s.write(d);
    });
    s.on('data', (d) => { if (!pair.drop && !c.destroyed) c.write(d); });
    // клиент закрыл — базе не говорим (полуоткрытое), если соединение в ловушке
    c.on('close', () => { if (!pair.drop) s.destroy(); });
    s.on('close', () => { c.destroy(); pairs.delete(pair); });
    c.on('error', () => {});
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state,
    arm() { armed = true; },
    async close() {
      for (const p of pairs) { p.c.destroy(); p.s.destroy(); }
      await new Promise((r) => server.close(r));
    }
  };
}

describe('полуоткрытое соединение посреди записи · pg', { skip: pgUp ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  let proxy;
  let a;
  let b;
  const APP = 'half_a_' + RUN_ID;
  before(async () => {
    const u = new URL(DB_URL);
    proxy = await halfOpenProxy({ host: u.hostname, port: Number(u.port || 5432) });
    const viaProxy = new URL(DB_URL);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);
    // A — через прокси, дедлайн 1,5 с (query_timeout 2,5 с); B — напрямую, ждёт замок сколько надо
    a = await startFor('pg', { verifyMs: 0 }, { connectionString: viaProxy.toString(), dbTimeoutMs: 1500, applicationName: APP });
    b = await startTwin('pg', a, { verifyMs: 0 }, { dbTimeoutMs: 30000 });
  });
  after(async () => {
    await b.close();
    await a.close();
    await proxy.close();
  });

  it('ответ базы на INSERT не дошёл, обрыва база не видит: A — 503 за query_timeout, замок строки проекта отпускается ≤ 20 с, B пишет; пул A цел', async () => {
    const hb = api(b.url);
    const ha = api(a.url);
    const { id } = (await hb.post('/api/projects', { name: 'Полуоткрытое', demo: true })).body;
    const board = artboards((await b.storage.latestSnapshot(id)).doc)[0];
    assert.equal((await ha.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'A0'))]))).status, 201);

    proxy.arm();
    const t0 = Date.now();
    const pa = ha.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'A1'))]));
    await waitFor(() => proxy.state.trappedAt, 'INSERT в ловушке');
    const ra = await pa;
    const aMs = Date.now() - t0;
    assert.equal(ra.status, 503, JSON.stringify(ra.body));
    assert.ok(aMs < 4500, `A ответил за query_timeout, без второго ожидания на ROLLBACK: ${aMs} мс`);

    // строка проекта заперта транзакцией A, которую база считает живой
    const tb = Date.now();
    const rb = await hb.post(`/api/projects/${id}/tx`, tx(1, [ops.create(text(board.id, 'B1'))]));
    const released = Date.now() - proxy.state.trappedAt;
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.ok(released <= 20000, `замок отпущен за ${released} мс`);
    assert.ok(Date.now() - tb > 5000, 'B действительно ждал замок (сценарий не холостой)');
    assert.equal(rb.body.seq, 2, 'запись A откачена базой — номер не потерян');
    const idle = (await b.storage.pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND state LIKE 'idle in transaction%'", [APP]
    )).rows[0].n;
    assert.equal(idle, 0, 'сеанса A, застрявшего в транзакции, нет');

    // пул A: сломанное соединение выброшено, новые запросы идут
    const again = await ha.post(`/api/projects/${id}/tx`, tx(2, [ops.create(text(board.id, 'A2'))]));
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.seq, 3);
  });
});

/* ------------------------------ страница журнала по байтам ------------------------------ */

for (const backend of list) {
  describe(`страница журнала по байтам · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let svc;
    before(async () => { svc = await startFor(backend.name, { verifyMs: 0 }); });
    after(async () => { await svc.close(); });

    it('первая запись — всегда, дальше — пока сумма не больше maxBytes (pg и память режут одинаково)', async () => {
      const http = api(svc.url);
      const { id } = (await http.post('/api/projects', { name: 'Страницы', demo: true })).body;
      const board = artboards((await svc.storage.latestSnapshot(id)).doc)[0];
      for (let k = 0; k < 5; k++) assert.equal((await http.post(`/api/projects/${id}/tx`, tx(k, [ops.set(board.id, 'name', 'x'.repeat(1000) + k)]))).status, 201);
      const seqs = async (limit, maxBytes) => (await svc.storage.txsAfter(id, 0, limit, { maxBytes })).map((t) => t.seq);
      // запись ≈ 1,1 КБ: в 2500 байт входят две, третья перешла бы предел — не входит
      assert.deepEqual(await seqs(500, 2500), [1, 2]);
      assert.deepEqual(await seqs(500, 10), [1], 'первая — даже больше предела');
      assert.deepEqual(await seqs(3, 1e9), [1, 2, 3]);
      assert.deepEqual(await seqs(500, 1e9), [1, 2, 3, 4, 5]);
      assert.deepEqual((await svc.storage.txsAfter(id, 3, 500, { maxBytes: 2500 })).map((t) => t.seq), [4, 5]);
      assert.deepEqual(await svc.storage.txsAfter(id, 5, 500, { maxBytes: 2500 }), []);
    });
  });
}

/* ------------------------------ одновременная запись двух экземпляров ------------------------------ */

for (const backend of list) {
  describe(`одновременная запись двух экземпляров в один проект · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let i1;
    let i2;
    before(async () => {
      i1 = await startFor(backend.name, { verifyMs: 0 });
      i2 = await startTwin(backend.name, i1, { verifyMs: 0 });
    });
    after(async () => {
      await i2.close();
      await i1.close();
    });

    it('2 × 60 параллельных транзакций (в том числе одни и те же tx_id в оба экземпляра) — без дыр, без дублей, головы = журнал', async () => {
      const h1 = api(i1.url);
      const h2 = api(i2.url);
      const { id } = (await h1.post('/api/projects', { name: 'Гонка', demo: true })).body;
      const seed = (await i1.storage.latestSnapshot(id)).doc;
      const board = artboards(seed)[0];
      const same = Array.from({ length: 10 }, (_, k) => tx(0, [ops.create(text(board.id, 'общая ' + k))]));
      const jobs = [];
      for (let k = 0; k < 60; k++) {
        jobs.push(h1.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'i1 · ' + k))])));
        jobs.push(h2.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, 'i2 · ' + k))])));
      }
      // одна и та же транзакция — в оба экземпляра сразу (клиент переключился посреди отправки)
      for (const t of same) jobs.push(h1.post(`/api/projects/${id}/tx`, t), h2.post(`/api/projects/${id}/tx`, t));
      const res = await Promise.all(jobs);
      const statuses = res.map((r) => r.status);
      // 503 допустим (повторяемый: голову двигает другой экземпляр — клиент повторит)
      assert.ok(statuses.every((st) => st === 201 || st === 200 || st === 503), statuses.join(','));
      const log = await journal(h1, id);
      const ids = log.map((t) => t.tx_id);
      assert.equal(new Set(ids).size, ids.length, 'ни одна не записана дважды');
      assert.deepEqual(log.map((t) => t.seq), log.map((_, k) => k + 1), 'без дыр');
      for (const r of res) if (r.status !== 503) assert.ok(ids.includes(r.body.tx_id), 'принятая — в журнале');
      for (const t of same) assert.ok(ids.filter((x) => x === t.tx_id).length <= 1, 'общая записана не больше раза');
      // ответы на одну и ту же транзакцию из двух экземпляров — одна и та же запись
      for (let k = 0; k < same.length; k++) {
        const a = res[120 + 2 * k];
        const b = res[121 + 2 * k];
        if (a.status !== 503 && b.status !== 503) assert.equal(a.body.seq, b.body.seq);
      }
      const truth = hashDoc(replay(seed, log));
      const [g1, g2] = await Promise.all([i1.dslts.headOf(id), i2.dslts.headOf(id)]);
      assert.equal(hashDoc(g1.doc), truth);
      assert.equal(hashDoc(g2.doc), truth);
      const st = [i1.dslts.stats(), i2.dslts.stats()];
      assert.ok(st[0].staleRetries + st[1].staleRetries > 0, 'гонка действительно была: ' + JSON.stringify(st));
    });
  });
}

/* ------------------------------ находки прохода (память) ------------------------------ */

describe('находки прохода по server/document', () => {
  const services = [];
  const boot = async (opts = {}, storage = createMemoryStorage()) => {
    const svc = await start({ port: 0, storage, pingInterval: 0, log: quiet, ...opts });
    services.push(svc);
    return svc;
  };
  after(async () => {
    for (const s of services) await s.close();
  });
  const seedOf = async (svc, id) => (await svc.storage.latestSnapshot(id)).doc;

  it('сокет, закрытый до hello (проект ещё проверяется), не остаётся в комнате и не держит голову', async () => {
    const mem = createMemoryStorage();
    const svc = await boot({}, wrap(mem, { getProject: async (id) => { await delay(150); return mem.getProject(id); } }));
    const { id } = (await api(svc.url).post('/api/projects', { name: 'Утечка', demo: true })).body;
    for (let k = 0; k < 3; k++) {
      const s = connect(wsUrl(svc, id, { since: 0, client: 'z' + k }));
      await s.opened;
      s.ws.terminate();
      await s.closed;
    }
    await delay(400);
    assert.equal(svc.hub.roomCount(), 0, 'комнат нет');
    assert.equal(svc.dslts.isLoaded(id), false, 'голова не загружена ради мёртвого сокета');
    // живой сокет после этого работает как обычно
    const ok = connect(wsUrl(svc, id, { since: 0, client: 'ok' }));
    await ok.opened;
    assert.equal((await ok.next()).type, 'hello');
    assert.equal(svc.hub.roomSize(id), 1);
    await ok.close();
    assert.equal(svc.hub.roomCount(), 0);
  });

  it('кеш кадров ограничен байтами: на комнату и на экземпляр; большой кадр не кешируется, но доходит', async () => {
    const svc = await boot({ frameCache: { roomBytes: 64 * 1024, totalBytes: 96 * 1024 } });
    const http = api(svc.url);
    const p1 = (await http.post('/api/projects', { name: 'К1', demo: true })).body.id;
    const p2 = (await http.post('/api/projects', { name: 'К2', demo: true })).body.id;
    const b1 = artboards(await seedOf(svc, p1))[0];
    const b2 = artboards(await seedOf(svc, p2))[0];
    const s1 = connect(wsUrl(svc, p1, { client: 's1' }));
    const s2 = connect(wsUrl(svc, p2, { client: 's2' }));
    await Promise.all([s1.opened, s2.opened]);
    await s1.next();
    await s2.next();
    for (let k = 0; k < 40; k++) {
      const r = await http.post(`/api/projects/${p1}/tx`, tx(k, [ops.create(text(b1.id, 'x'.repeat(3000) + k))]));
      assert.equal(r.status, 201);
    }
    for (let k = 0; k < 40; k++) assert.equal((await s1.until((m) => m.type === 'tx')).tx.seq, k + 1);
    assert.ok(svc.hub.cacheBytes(p1) <= 64 * 1024, 'комната: ' + svc.hub.cacheBytes(p1));
    assert.ok(svc.hub.cachedFrames(p1).length < 40 && svc.hub.cachedFrames(p1).length > 5);
    for (let k = 0; k < 40; k++) await http.post(`/api/projects/${p2}/tx`, tx(k, [ops.create(text(b2.id, 'y'.repeat(3000) + k))]));
    for (let k = 0; k < 40; k++) await s2.until((m) => m.type === 'tx');
    assert.ok(svc.hub.cacheBytes() <= 96 * 1024, 'экземпляр: ' + svc.hub.cacheBytes());
    assert.equal(svc.hub.cacheBytes(), svc.hub.cacheBytes(p1) + svc.hub.cacheBytes(p2), 'учёт сходится');
    // кадр больше четверти предела комнаты не кешируется, но доходит
    const big = await http.post(`/api/projects/${p1}/tx`, tx(40, [ops.create(text(b1.id, 'z'.repeat(20000)))]));
    const got = await s1.until((m) => m.type === 'tx');
    assert.equal(got.tx.seq, big.body.seq);
    assert.equal(svc.hub.cachedFrames(p1).includes(`${big.body.seq}:${big.body.chain}`), false);
    await Promise.all([s1.close(), s2.close()]);
    assert.equal(svc.hub.cacheBytes(), 0, 'комнаты закрыты — кеш пуст');
  });

  it('повтор уже полученной: клиенту с proto/epoch — ack, прежнему (без них) — error duplicate, retryable:false', async () => {
    const svc = await boot();
    const http = api(svc.url);
    const created = (await http.post('/api/projects', { name: 'ack', demo: true })).body;
    const board = artboards(await seedOf(svc, created.id))[0];
    const t = tx(0, [ops.set(board.id, 'name', 'Один раз')]);
    const r = await http.post(`/api/projects/${created.id}/tx`, t);
    assert.equal(r.status, 201);
    const legacy = connect(wsUrl(svc, created.id, { since: 0, client: 'old' }));
    const modern = connect(wsUrl(svc, created.id, { since: 0, client: 'new', epoch: created.epoch }));
    await Promise.all([legacy.opened, modern.opened]);
    for (const s of [legacy, modern]) {
      assert.equal((await s.next()).type, 'hello');
      assert.equal((await s.next()).tx.seq, 1);
      s.send({ type: 'tx', tx: t });
    }
    const dup = await legacy.next();
    assert.equal(dup.type, 'error');
    assert.equal(dup.code, 'duplicate');
    assert.equal(dup.retryable, false);
    assert.equal(dup.existing, true);
    assert.equal(dup.tx_id, t.tx_id);
    assert.equal(dup.seq, 1);
    assert.deepEqual(await modern.next(), { type: 'ack', tx_id: t.tx_id, seq: 1, chain: r.body.chain, existing: true });
    assert.equal((await http.get(`/api/projects/${created.id}?head=1`)).body.head_seq, 1, 'второй записи нет');
    await Promise.all([legacy.close(), modern.close()]);
  });

  it('потерянные записи журнала: GET ops — 410 со снимком (а не more:true с пустой страницей); догон сокета не читает снимок по кругу', async () => {
    const mem = createMemoryStorage();
    let hide = false;
    let goneReads = 0;
    const svc = await boot({}, wrap(mem, {
      txsAfter: async (id, seq, limit, o) => (await mem.txsAfter(id, seq, limit, o)).filter((t) => !hide || t.seq < 3),
      latestSnapshot: async (id) => { goneReads++; return mem.latestSnapshot(id); }
    }));
    const http = api(svc.url);
    const { id } = (await http.post('/api/projects', { name: 'Дыра', demo: true })).body;
    const board = artboards(await seedOf(svc, id))[0];
    for (let k = 0; k < 5; k++) await http.post(`/api/projects/${id}/tx`, tx(k, [ops.create(text(board.id, 't' + k))]));
    hide = true;   // записи 3..5 «потеряны»: голова базы — 5
    const first = await http.get(`/api/projects/${id}/ops?since=0`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.txs.map((t) => t.seq), [1, 2]);
    assert.equal(first.body.more, true);
    const next = await http.get(`/api/projects/${id}/ops?since=2`);
    assert.equal(next.status, 410, 'дальше догнать нечем — снимок');
    assert.equal(next.body.code, 'gone');
    assert.equal(next.body.head_seq, 5);

    goneReads = 0;
    const s = connect(wsUrl(svc, id, { since: 2, client: 'g' }));
    await s.opened;
    const types = [];
    const closed = await Promise.race([
      (async () => {
        for (;;) {
          let m;
          try { m = await s.next(2000); } catch (_) { break; }
          types.push(m.type === 'error' ? 'error:' + m.code : m.type);
        }
        return s.closed;
      })(),
      delay(4000).then(() => null)
    ]);
    assert.ok(closed, 'сокет закрыт, а не крутится');
    assert.equal(closed.code, 4503);
    assert.ok(types.filter((t) => t === 'gone').length <= 2, types.slice(0, 20).join(','));
    assert.ok(types.includes('error:unavailable'), types.slice(0, 20).join(','));
    assert.ok(goneReads <= 3, 'снимок прочитан ' + goneReads + ' раз');
  });

  it('выгрузка головы по бездействию посреди медленных записей: ничего не потеряно, голова = журнал', async () => {
    const mem = createMemoryStorage();
    const svc = await boot({ idleMs: 5 }, wrap(mem, {
      commitTx: async (...a) => { await delay(30); return mem.commitTx(...a); }
    }));
    const http = api(svc.url);
    const { id } = (await http.post('/api/projects', { name: 'Простой', demo: true })).body;
    const seed = await seedOf(svc, id);
    const board = artboards(seed)[0];
    for (let round = 0; round < 3; round++) {
      const res = await Promise.all(Array.from({ length: 6 }, (_, k) => http.post(`/api/projects/${id}/tx`, tx(0, [ops.create(text(board.id, `r${round}k${k}`))]))));
      for (const r of res) assert.equal(r.status, 201, JSON.stringify(r.body));
      await delay(30);   // голова успевает выгрузиться между кругами
    }
    const log = await journal(http, id);
    assert.deepEqual(log.map((t) => t.seq), Array.from({ length: 18 }, (_, k) => k + 1));
    const head = await svc.dslts.headOf(id);
    assert.equal(head.head_seq, 18);
    assert.equal(hashDoc(head.doc), hashDoc(replay(seed, log)));
  });

  it('медленный читатель: неотправленного больше предела — сокет закрыт 4503, остальные получают всё', async () => {
    const svc = await boot({ maxBuffered: 64 * 1024 });
    const http = api(svc.url);
    const { id } = (await http.post('/api/projects', { name: 'Медленный', demo: true })).body;
    const board = artboards(await seedOf(svc, id))[0];
    const slow = connect(wsUrl(svc, id, { client: 'slow' }));
    const fast = connect(wsUrl(svc, id, { client: 'fast' }));
    await Promise.all([slow.opened, fast.opened]);
    await slow.next();
    await fast.next();
    slow.ws._socket.pause();
    const N = 24;
    for (let k = 0; k < N; k++) {
      const r = await http.post(`/api/projects/${id}/tx`, tx(k, [ops.create(text(board.id, 'w'.repeat(300 * 1024) + k))]));
      assert.equal(r.status, 201);
    }
    for (let k = 0; k < N; k++) assert.equal((await fast.until((m) => m.type === 'tx', 5000)).tx.seq, k + 1);
    slow.ws._socket.resume();
    const res = await Promise.race([slow.closed, delay(8000).then(() => null)]);
    assert.ok(res, 'медленный сокет закрыт');
    assert.equal(res.code, 4503);
    await waitFor(() => svc.hub.roomSize(id) === 1, 'в комнате остался быстрый');
    await fast.close();
  });
});

/* -------------------- соединение слушателя и пул под чтением снимков (круг 27) -------------------- */

describe('соединение слушателя и пул · pg (круг 27)', { skip: pgUp ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  it('параллельные publish и пинг на соединении слушателя — по очереди: нет предупреждения node-pg «already executing», слушатель жив', async () => {
    // предупреждение node-pg — раз на процесс (util.deprecate): проверяем в отдельном процессе
    const { spawn } = await import('node:child_process');
    const pgUrl = new URL('../../server/document/storage/pg.js', import.meta.url).href;
    const code = `
      import { createPgStorage } from ${JSON.stringify(pgUrl)};
      const warnings = [];
      process.on('warning', (w) => warnings.push(String(w && w.message)));
      const s = createPgStorage({ connectionString: process.env.U, listenPingMs: 3, log: { info() {}, warn() {} } });
      await s.init();
      let got = 0, resync = 0;
      s.onNotify((m) => { if (m.k === 'presence') got++; if (m.k === 'resync') resync++; });
      let sent = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 600) {
        for (let i = 0; i < 20; i++) if (s.publish({ k: 'presence', p: 'x', i: 'i', c: 'c' + sent })) sent++;
        await new Promise((r) => setTimeout(r, 1));
      }
      await new Promise((r) => setTimeout(r, 300));
      const listening = s.listening;
      await s.close();
      await new Promise((r) => setImmediate(r));
      console.log(JSON.stringify({ warnings, sent, got, resync, listening }));
    `;
    const out = await new Promise((resolve, reject) => {
      const env = { ...process.env, U: DB_URL };
      delete env.NODE_OPTIONS;
      const ch = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '';
      let se = '';
      ch.stdout.on('data', (d) => { so += d; });
      ch.stderr.on('data', (d) => { se += d; });
      ch.on('error', reject);
      ch.on('exit', (c) => (c === 0 ? resolve(JSON.parse(so.trim().split('\n').pop())) : reject(new Error('процесс: ' + c + ' ' + se))));
    });
    assert.deepEqual(out.warnings.filter((w) => /already executing/.test(w)), [], 'запрос поверх выполняющегося');
    assert.ok(out.sent > 100, 'отправлено ' + out.sent);
    assert.ok(out.got >= out.sent * 0.9, `дошло ${out.got} из ${out.sent}`);
    assert.equal(out.resync, 0, 'слушатель не переподключался (пинг не ложно «мёртв»)');
    assert.equal(out.listening, true);
  });

  it('шторм чтений большого снимка не выедает пул: запись транзакций идёт (без «timeout exceeded when trying to connect»)', async () => {
    const { pgStorage } = await import('./helpers.mjs');
    const s = pgStorage({ max: 10, connectionTimeoutMillis: 1500, listen: false });
    await s.init();
    try {
      // проект с документом ~6 МБ
      const nodes = {};
      for (let i = 0; i < 6000; i++) nodes['n' + i] = { id: 'n' + i, type: 'text', characters: 'x'.repeat(1000) };
      const big = await s.createProject({ name: 'большой', kind: 'design', doc: { root: 'n0', nodes }, engine: E });
      const small = await s.createProject({ name: 'малый', kind: 'design', doc: core.createDoc('empty'), engine: E });
      const t1 = Date.now();
      await s.latestSnapshot(big.id);
      const one = Date.now() - t1;
      let maxActive = 0;
      const reads = Promise.all(Array.from({ length: 60 }, () => s.latestSnapshot(big.id).then((x) => {
        maxActive = Math.max(maxActive, s.snapshotReads.active);
        return x ? 'ok' : 'null';
      }, (e) => e.code || e.message)));
      await delay(100);
      const errors = [];
      const lat = [];
      for (let i = 0; i < 10; i++) {
        const t = Date.now();
        try {
          const r = await s.commitTx(small.id, tx(i, []));
          assert.equal(r.status, 'committed');
        } catch (e) {
          errors.push(e.message);
        }
        lat.push(Date.now() - t);
        assert.ok(s.snapshotReads.active <= s.snapshotReads.max);
      }
      const rs = await reads;
      assert.deepEqual(errors, [], 'запись во время шторма');
      // круг 35: ждать соединения дольше connectionTimeoutMillis запись не может — это была бы ошибка
      // «timeout exceeded when trying to connect» (errors пуст); время — относительно и с запасом: под
      // нагрузкой параллельного прогона отдельная запись бывала 2 с (цикл событий), медиана — нет
      const sorted = lat.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      assert.ok(median < 1500, `запись не ждёт соединения дольше connectionTimeoutMillis (медиана): ${lat.join(',')} (одно чтение ${one} мс)`);
      assert.ok(sorted[sorted.length - 1] < Math.max(6000, 4 * one), `ни одна запись не стоит за всем штормом: ${lat.join(',')} (одно чтение ${one} мс)`);
      assert.deepEqual([...new Set(rs)], ['ok'], 'все чтения дождались места: ' + [...new Set(rs)].join(','));
      assert.ok(maxActive <= 4, 'одновременно не больше предела: ' + maxActive);
      // предел и очередь: сверх очереди — 503 busy сразу
      const tiny = pgStorage({ max: 10, listen: false, snapshotReads: 1, snapshotReadQueue: 0 });
      await tiny.init();
      try {
        const [a, b] = await Promise.allSettled([tiny.latestSnapshot(big.id), tiny.latestSnapshot(big.id)]);
        assert.equal(a.status, 'fulfilled');
        assert.equal(b.status, 'rejected');
        assert.equal(b.reason.status, 503);
        assert.equal(b.reason.code, 'busy');
        assert.equal(b.reason.detail.cause, 'snapshot_reads');
        assert.ok((await tiny.latestSnapshotMeta(big.id)).seq === 0, 'лёгкое чтение — без предела');
      } finally {
        await tiny.close();
      }
    } finally {
      await s.close();
    }
  });
});

/* -------------------- круг 29: страница журнала, чтения журнала, слушатель -------------------- */

/**
 * TCP-прокси к Postgres: соединение, пославшее `marker`, с этого мига больше не получает
 * ответов базы (запросы уходят, ответы теряются) — как зависшее соединение. Остальные — как есть.
 */
async function muteProxy(target, marker) {
  const pairs = new Set();
  const state = { muted: 0 };
  const server = net.createServer((c) => {
    const s = net.connect(target.port, target.host);
    const pair = { c, s, mute: false };
    pairs.add(pair);
    c.on('data', (d) => {
      if (!pair.mute && d.includes(marker)) {
        pair.mute = true;
        state.muted++;
      }
      if (!s.destroyed) s.write(d);
    });
    s.on('data', (d) => { if (!pair.mute && !c.destroyed) c.write(d); });
    c.on('close', () => s.destroy());
    s.on('close', () => { c.destroy(); pairs.delete(pair); });
    c.on('error', () => {});
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state,
    async close() {
      for (const p of pairs) { p.c.destroy(); p.s.destroy(); }
      await new Promise((r) => server.close(r));
    }
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe('журнал и слушатель · pg (круг 29)', { skip: pgUp ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  it('страница журнала над записями по 4 МБ: время и прочитанные буферы не растут с числом записей после since', async () => {
    const { pgStorage } = await import('./helpers.mjs');
    const { randomBytes } = await import('node:crypto');
    const s = pgStorage({ listen: false });
    await s.init();
    try {
      const fill = async (n) => {
        const p = await s.createProject({ name: 'журнал ' + n, kind: 'design', doc: core.createDoc('empty'), engine: E });
        // 4 МБ плохо сжимаемых данных (hex случайных байт): TOAST хранит их почти целиком
        for (let i = 0; i < n; i++) {
          const r = await s.commitTx(p.id, tx(i, [{ op: 'set', id: 'n0', path: 'name', value: randomBytes(2e6).toString('hex') }]));
          assert.equal(r.status, 'committed');
        }
        return p.id;
      };
      const few = await fill(2);
      const many = await fill(14);
      // страница — по умолчанию DSLR (2 МБ): входит только первая запись
      const page = (id) => s.txsAfter(id, 0, 500, { maxBytes: 2 * 1024 * 1024 });
      assert.deepEqual((await page(many)).map((t) => t.seq), [1]);
      assert.deepEqual((await s.txsAfter(many, 0, 500, { maxBytes: 9e6 })).map((t) => t.seq), [1, 2]);
      const timeOf = async (id) => {
        const xs = [];
        for (let k = 0; k < 5; k++) {
          const t0 = process.hrtime.bigint();
          await page(id);
          xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        return median(xs);
      };
      await timeOf(few);
      await timeOf(many);   // прогрев: кеш базы одинаково тёплый у обоих
      const tFew = await timeOf(few);
      const tMany = await timeOf(many);
      // буферы, которые читает сам запрос страницы (EXPLAIN ANALYZE BUFFERS того же текста)
      const buffersOf = async (id) => {
        const q = s.pool.query.bind(s.pool);
        let seen = null;
        s.pool.query = (text, params) => { if (!seen && /FROM operations WHERE project_id = \$1 AND seq > \$2/.test(text)) seen = { text, params }; return q(text, params); };
        try {
          await page(id);
        } finally {
          s.pool.query = q;
        }
        const plan = (await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${seen.text}`, seen.params)).rows[0]['QUERY PLAN'][0];
        // вывод EXPLAIN ANALYZE не детоастится — читаем результат отдельно: он и есть «строки страницы»
        return plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'];
      };
      const bFew = await buffersOf(few);
      const bMany = await buffersOf(many);
      assert.ok(bMany <= bFew * 1.5 + 50, `буферов страницы: 2 записи — ${bFew}, 14 — ${bMany} (окно не читает jsonb записей вне страницы)`);
      assert.ok(tMany < tFew * 2.5 + 40, `страница: 2 записи — ${tFew.toFixed(1)} мс, 14 — ${tMany.toFixed(1)} мс`);
    } finally {
      await s.close();
    }
  });

  it('шторм чтений журнала (ops?since=0 анонимов) не выедает пул: запись идёт, одновременно — не больше предела; сверх очереди — busy journal_reads; чтение сервиса — мимо предела', async () => {
    const { pgStorage } = await import('./helpers.mjs');
    // ждать места — сколько угодно: здесь проверяется предел, а не срок (срок — ниже, очередью)
    const s = pgStorage({ max: 10, connectionTimeoutMillis: 1500, listen: false, journalReadWaitMs: 120000 });
    await s.init();
    try {
      const big = await s.createProject({ name: 'длинный журнал', kind: 'design', doc: core.createDoc('empty'), engine: E });
      const small = await s.createProject({ name: 'малый', kind: 'design', doc: core.createDoc('empty'), engine: E });
      const chunk = 'x'.repeat(200000);
      for (let i = 0; i < 40; i++) await s.commitTx(big.id, tx(i, [{ op: 'set', id: 'n0', path: 'name', value: chunk + i }]));
      let maxActive = 0;
      let maxHeavy = 0;
      const reads = Promise.all(Array.from({ length: 40 }, () => s.txsAfter(big.id, 0, 500, { maxBytes: 16 * 1024 * 1024 }).then((x) => {
        maxActive = Math.max(maxActive, s.journalReads.active);
        maxHeavy = Math.max(maxHeavy, s.heavyReads.active);
        return x.length;
      }, (e) => e.code || e.message)));
      await delay(50);
      const errors = [];
      const lat = [];
      for (let i = 0; i < 10; i++) {
        const t = Date.now();
        try {
          assert.equal((await s.commitTx(small.id, tx(i, []))).status, 'committed');
        } catch (e) {
          errors.push(e.message);
        }
        lat.push(Date.now() - t);
        assert.ok(s.journalReads.active <= s.journalReads.max);
      }
      const rs = await reads;
      assert.deepEqual(errors, [], 'запись во время шторма');
      assert.ok(Math.max(...lat) < 1500, `запись не ждёт соединения: ${lat.join(',')}`);
      assert.deepEqual([...new Set(rs)], [40], 'все чтения дождались места и прочли страницу целиком');
      assert.ok(maxActive <= 4 && s.journalReads.max === 4, 'чтений журнала одновременно ≤ 4: ' + maxActive);
      assert.ok(maxHeavy <= 6, 'тяжёлых чтений вместе ≤ max − 4: ' + maxHeavy);
    } finally {
      await s.close();
    }

    const tiny = pgStorage({ max: 10, listen: false, journalReads: 1, journalReadQueue: 0 });
    await tiny.init();
    try {
      const p = await tiny.createProject({ name: 'т', kind: 'design', doc: core.createDoc('empty'), engine: E });
      await tiny.commitTx(p.id, tx(0, []));
      const [a, b, c, h] = await Promise.allSettled([
        tiny.txsAfter(p.id, 0), tiny.txsAfter(p.id, 0), tiny.txsAfter(p.id, 0, 500, { internal: true }), tiny.recentTxMeta(p.id)
      ]);
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'rejected');
      assert.equal(b.reason.status, 503);
      assert.equal(b.reason.code, 'busy');
      assert.equal(b.reason.detail.cause, 'journal_reads');
      assert.equal(c.status, 'fulfilled', 'чтение сервиса (голова секвенсора) не ждёт за анонимами');
      assert.equal(h.status, 'rejected', 'история — под тем же пределом');
      assert.equal((await tiny.txsAfter(p.id, 0)).length, 1, 'место освободилось');
    } finally {
      await tiny.close();
    }

    // общий предел: снимки и журнал вместе
    const one = pgStorage({ max: 10, listen: false, heavyReads: 1 });
    await one.init();
    try {
      const p = await one.createProject({ name: 'о', kind: 'design', doc: core.createDoc('empty'), engine: E });
      // одновременность — по запросам в полёте на пуле (а не по счётчику самого предела)
      let inflight = 0;
      let peak = 0;
      const q = one.pool.query.bind(one.pool);
      one.pool.query = (...a) => {
        inflight++;
        peak = Math.max(peak, inflight);
        return q(...a).finally(() => { inflight--; });
      };
      const jobs = Array.from({ length: 10 }, (_, i) => (i % 2 ? one.latestSnapshot(p.id) : one.txsAfter(p.id, 0)));
      assert.ok(one.snapshotReads.active + one.journalReads.active >= 2, 'свои пределы впустили больше одного');
      const all = await Promise.all(jobs);
      one.pool.query = q;
      assert.equal(all.length, 10);
      assert.ok(peak <= 1, 'снимков и журнала вместе ≤ heavyReads: ' + peak);
    } finally {
      await one.close();
    }
  });

  it('пинг слушателя при зависшей очереди publish: запрос без ответа дольше предела — соединение мертво, переподключение и resync (мутант N14)', async () => {
    const u = new URL(DB_URL);
    const MARK = 'freeze_' + RUN_ID;
    const proxy = await muteProxy({ host: u.hostname, port: Number(u.port || 5432) }, MARK);
    const via = new URL(DB_URL);
    via.hostname = '127.0.0.1';
    via.port = String(proxy.port);
    const { pgStorage } = await import('./helpers.mjs');
    const s = pgStorage({ connectionString: via.toString(), listenPingMs: 50, listenPingTimeoutMs: 400 });
    try {
      await s.init();
      assert.equal(s.listening, true);
      let resync = 0;
      const got = [];
      s.onNotify((m) => {
        if (m.k === 'resync') resync++;
        if (m.k === 'presence') got.push(m.c);
      });
      // запрос с меткой встаёт в очередь слушателя после пинга (по одному) — и остаётся без ответа:
      // очередь занята, отдельный пинг не начинается; живость — только по времени висящего запроса
      assert.equal(s.publish({ k: 'presence', p: 'x', i: 'i', c: MARK }), true);
      await waitFor(() => proxy.state.muted === 1, 'запрос слушателя без ответа', 3000);
      for (let k = 0; k < 5; k++) s.publish({ k: 'presence', p: 'x', i: 'i', c: 'ждёт' + k });
      const t0 = Date.now();
      await waitFor(() => resync > 0, 'слушатель признан мёртвым и переподключён', 4000);
      assert.ok(Date.now() - t0 < 3000, 'за предел запроса, а не за сетевые таймауты: ' + (Date.now() - t0) + ' мс');
      await waitFor(() => s.listening, 'слушатель вернулся', 4000);
      assert.equal(s.publish({ k: 'presence', p: 'x', i: 'i', c: 'после' }), true);
      await waitFor(() => got.includes('после'), 'новое соединение слушателя доставляет', 3000);
      assert.equal(proxy.state.muted, 1, 'новое соединение — не в ловушке');
    } finally {
      await s.close();
      await proxy.close();
    }
  });
});
