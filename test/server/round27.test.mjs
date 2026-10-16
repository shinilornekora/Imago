/**
 * Круг 27 — Document service: память головы о последних транзакциях (выжимки, а не
 * транзакции целиком), запись по HTTP (создание проекта под семафором, слот записи —
 * только после тела, медленное тело — 408), лёгкое чтение головы без документа (I2),
 * пропавший проект (I3), живое имя проекта между экземплярами (I4), окно `stale` при
 * переигрывании после отката — от начала нынешней эпохи (I5), чистка ключей.
 *
 * Стек для пределов собирается из модулей (как в backpressure.test.mjs): так пределы
 * маленькие, а хранилище можно обернуть счётчиками.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createDoc, applyOps, artboards, uid, ENGINE_VERSION } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createReader, createSemaphore } from '../../server/document/dslr.js';
import { createSequencer, validateTx } from '../../server/document/dslts.js';
import { createHub } from '../../server/document/hub.js';
import { createRequestHandler } from '../../server/document/http.js';
import { cleanDeep, cleanKey } from '../../server/document/limits.js';
import { backends, startFor, startTwin, api, connect, wsUrl, takeBackup, restoreBackup, pgStorage, waitFor, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const text = (parent, characters) => ({
  type: 'text', id: uid('n'), name: characters, parent, characters,
  style: { token: 'body' }, align: 'left', color: '#14161C'
});

/** Стек Document service над данным хранилищем, без start(): свои пределы. */
async function stackOn(storage, { seq = {}, writes = {}, heavy } = {}) {
  const dslr = createReader({ storage, ...(heavy ? { heavy } : {}) });
  const dslts = createSequencer({ storage, verifyMs: 0, log: quiet, ...seq });
  const server = http.createServer(createRequestHandler({ dslr, dslts, storage, log: quiet, writes }));
  const hub = createHub({ server, dslr, dslts, pingInterval: 0, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    storage, dslr, dslts, hub, port, url: `http://127.0.0.1:${port}`,
    async close() {
      await hub.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
      await dslts.close();
    }
  };
}

const list = await backends();

/* ------------------------- 1. память головы (recent) ------------------------- */

describe('голова помнит последние транзакции выжимкой, а не целиком (круг 27)', () => {
  it('40 транзакций по 4 МБ: куча не держит их операции; идемпотентность — по-прежнему', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const storage = createMemoryStorage();
    await storage.init();
    // хранилище «как pg»: журнал не в куче (здесь — без операций), ответ — с операциями
    const commitTx = storage.commitTx.bind(storage);
    storage.commitTx = async (projectId, record, o) => {
      const res = await commitTx(projectId, { ...record, ops: [] }, o);
      return res.status === 'committed' ? { ...res, committed: { ...res.committed, ops: record.ops } } : res;
    };
    const p = await storage.createProject({ name: 'Память', kind: 'design', doc: createDoc('empty'), engine: E });
    const root = (await storage.latestSnapshot(p.id)).doc.root;
    const seqr = createSequencer({ storage, verifyMs: 0, snapshotEvery: 0, log: quiet });
    try {
      await seqr.headOf(p.id);
      gc();
      const base = process.memoryUsage().heapUsed;
      const first = [];
      let last = 0;
      for (let i = 0; i < 40; i++) {
        const t = tx(last, [{ op: 'set', id: root, path: 'name', value: String.fromCharCode(97 + (i % 26)).repeat(4 * MB) + i }]);
        if (i === 0) first.push(t);
        const r = await seqr.commit(p.id, t);
        assert.equal(r.committed.ops.length, 1);
        last = r.committed.seq;
      }
      gc();
      const grew = (process.memoryUsage().heapUsed - base) / MB;
      // целиком 40 × 4 МБ — это 160 МБ; документ держит только последнее имя (4 МБ)
      assert.ok(grew < 48, `куча выросла на ${grew.toFixed(0)} МБ`);
      const head = await seqr.headOf(p.id);
      assert.equal(head.recent.length, 40);
      assert.ok(head.recent.every((c) => c.ops === undefined && typeof c.tx_id === 'string' && Number.isInteger(c.seq)), 'в памяти — выжимки без операций');
      assert.ok(head.recentBytes < 64 * 1024, `выжимки — ${head.recentBytes} байт`);
      // повтор старой — сохранённое из базы, второй записи нет
      const again = await seqr.commit(p.id, first[0]);
      assert.equal(again.existing, true);
      assert.equal(again.committed.seq, 1);
      assert.equal((await seqr.headOf(p.id)).head_seq, 40);
    } finally {
      await seqr.close();
    }
  });

  it('предел выжимок — и числом, и байтами', async () => {
    const storage = createMemoryStorage();
    await storage.init();
    const p = await storage.createProject({ name: 'Предел', kind: 'design', doc: createDoc('empty'), engine: E });
    const root = (await storage.latestSnapshot(p.id)).doc.root;
    const seqr = createSequencer({ storage, verifyMs: 0, snapshotEvery: 0, log: quiet, recentTxs: 10, recentBytes: 8 * 1024 });
    try {
      let last = 0;
      for (let i = 0; i < 30; i++) {
        // длинные пути листьев — выжимка тяжелее, предел байт срабатывает раньше числа
        const ops = Array.from({ length: 8 }, (_, k) => ({ op: 'setToken', path: `color.t${'x'.repeat(100)}${k}`, value: '#000000' }));
        last = (await seqr.commit(p.id, tx(last, i % 2 ? ops : [{ op: 'set', id: root, path: 'name', value: 'n' + i }]))).committed.seq;
      }
      const head = await seqr.headOf(p.id);
      assert.ok(head.recent.length <= 10 && head.recent.length >= 1);
      assert.ok(head.recentBytes <= 8 * 1024, `выжимки — ${head.recentBytes} байт`);
      assert.equal(head.recent[head.recent.length - 1].seq, 30, 'последняя помнится');
    } finally {
      await seqr.close();
    }
  });
});

/* ------------------------ 2. запись по HTTP и медленное тело ------------------------ */

/** Документ примерно `bytes` байт (узлы-тексты под корнем). */
function docOf(bytes) {
  const doc = createDoc('empty');
  const nodes = { ...doc.nodes };
  const kids = [];
  const n = Math.max(1, Math.floor(bytes / 300));
  for (let i = 0; i < n; i++) {
    const id = 't_' + i.toString(36);
    kids.push(id);
    nodes[id] = { id, type: 'text', name: 'S' + i, parent: doc.root, characters: 'x'.repeat(200), size: { w: { mode: 'hug' }, h: { mode: 'hug' } } };
  }
  nodes[doc.root] = { ...doc.nodes[doc.root], children: [...(doc.nodes[doc.root].children || []), ...kids] };
  return { ...doc, nodes };
}

describe('запись по HTTP: создание проекта под семафором, медленное тело (круг 27)', () => {
  it('шквал POST /api/projects с документами: одновременно в хранилище — не больше слотов записи, сверх бюджета тел — 503 busy', async () => {
    const storage = createMemoryStorage();
    await storage.init();
    let active = 0;
    let peak = 0;
    const createProject = storage.createProject.bind(storage);
    storage.createProject = async (...a) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep(20);
        return await createProject(...a);
      } finally {
        active -= 1;
      }
    };
    const s = await stackOn(storage, { writes: { max: 2, queue: 4, bodyBytes: 3 * MB } });
    try {
      const body = JSON.stringify({ name: 'шквал', doc: docOf(900 * 1024) });
      const res = await Promise.all(Array.from({ length: 24 }, () => fetch(s.url + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        .then(async (r) => ({ status: r.status, retry: r.headers.get('retry-after'), body: await r.json() }))));
      const ok = res.filter((r) => r.status === 201);
      const busy = res.filter((r) => r.status === 503);
      assert.equal(ok.length + busy.length, res.length, JSON.stringify(res.map((r) => r.status)));
      assert.ok(ok.length >= 1, 'часть создана');
      assert.ok(busy.length >= 1, 'сверх бюджета тел — отказ, а не чтение всех тел в память');
      for (const b of busy) {
        assert.equal(b.body.code, 'busy');
        assert.equal(b.body.retryable, true);
        assert.ok(Number(b.retry) >= 1);
      }
      assert.ok(peak <= 2, `одновременно в хранилище ${peak}`);
      // бюджет и слоты отпущены: следующее создание проходит
      const after = await api(s.url).post('/api/projects', { name: 'после' });
      assert.equal(after.status, 201);
      for (const r of ok) assert.equal((await api(s.url).get(`/api/projects/${r.body.id}?head=1`)).status, 200);
    } finally {
      await s.close();
    }
  });

  it('медленное тело (slowloris) не держит слот записи: законная запись проходит сразу, медленные получают 408', async () => {
    const storage = createMemoryStorage();
    await storage.init();
    const s = await stackOn(storage, { writes: { max: 1, queue: 0, bodyTimeoutMs: 1500 } });
    const p = await storage.createProject({ name: 'Медленно', kind: 'design', doc: createDoc('empty'), engine: E });
    const root = (await storage.latestSnapshot(p.id)).doc.root;
    const socks = [];
    const ticker = setInterval(() => { for (const x of socks) if (!x.destroyed) x.write(' '); }, 100);
    try {
      for (let i = 0; i < 6; i++) {
        const sock = net.connect(s.port, '127.0.0.1');
        sock.on('error', () => {});
        sock.reply = '';
        sock.on('data', (d) => { sock.reply += d.toString(); });
        sock.write(`POST /api/projects/${p.id}/tx HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{`);
        socks.push(sock);
      }
      await sleep(300);
      const t0 = Date.now();
      const r = await api(s.url).post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'законно' }]));
      const took = Date.now() - t0;
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(took < 1000, `законная запись ждала ${took} мс`);
      await waitFor(() => socks.every((x) => x.reply.length > 0), 'ответ медленным', 6000);
      for (const x of socks) assert.match(x.reply, /^HTTP\/1\.1 408/, x.reply.slice(0, 80));
      assert.match(socks[0].reply, /body_timeout/);
    } finally {
      clearInterval(ticker);
      for (const x of socks) x.destroy();
      await s.close();
    }
  });
});

/* ------------------------- 3. лёгкое чтение головы (I2) ------------------------- */

for (const backend of list) {
  describe(`шторм ?lean=1 не мешает записи в другой проект · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    it('60 одновременных ?lean=1 и ?head=1 большого проекта: документ снимка не читается, запись в другой проект идёт сразу', async () => {
      const storage = backend.name === 'pg' ? pgStorage() : createMemoryStorage();
      await storage.init();
      const big = await storage.createProject({ name: 'Большой', kind: 'design', doc: docOf(6 * MB), engine: E });
      const small = await storage.createProject({ name: 'Малый', kind: 'design', doc: createDoc('empty'), engine: E });
      const root = (await storage.latestSnapshot(small.id)).doc.root;
      let fullReads = 0;
      const latest = storage.latestSnapshot.bind(storage);
      storage.latestSnapshot = (id, ...a) => {
        if (id === big.id) fullReads += 1;
        return latest(id, ...a);
      };
      const s = await stackOn(storage);
      try {
        const reads = Promise.all(Array.from({ length: 60 }, (_, i) => fetch(`${s.url}/api/projects/${big.id}?${i % 3 ? 'lean=1' : 'head=1'}`).then(async (r) => {
          await r.arrayBuffer();
          return r.status;
        })));
        const lat = [];
        let base = 0;
        for (let i = 0; i < 10; i++) {
          const t0 = Date.now();
          const r = await api(s.url).post(`/api/projects/${small.id}/tx`, tx(base, [{ op: 'set', id: root, path: 'name', value: 'n' + i }]));
          lat.push(Date.now() - t0);
          assert.equal(r.status, 201, JSON.stringify(r.body));
          base = r.body.seq;
        }
        const statuses = await reads;
        assert.ok(statuses.every((x) => x === 200), JSON.stringify(statuses));
        assert.equal(fullReads, 0, 'lean и head не читают документ снимка');
        assert.ok(Math.max(...lat) < 3000, `задержки записи ${lat.join(',')}`);
        const lean = await api(s.url).get(`/api/projects/${big.id}?lean=1`);
        assert.equal(lean.body.snapshot.doc, undefined);
        assert.equal(lean.body.snapshot.seq, 0);
      } finally {
        await s.close();
        await storage.close();
      }
    });
  });
}

describe('?lean=1 над хранилищем без latestSnapshotMeta — под семафором тяжёлых чтений', () => {
  it('одновременно полных чтений снимка — не больше семафора; сверх очереди — 503 busy', async () => {
    const storage = createMemoryStorage();
    await storage.init();
    const big = await storage.createProject({ name: 'Большой', kind: 'design', doc: docOf(MB), engine: E });
    let active = 0;
    let peak = 0;
    const latest = storage.latestSnapshot.bind(storage);
    // хранилище прежней версии: latestSnapshotMeta нет
    const old = { ...storage, latestSnapshotMeta: undefined };
    old.latestSnapshot = async (...a) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep(15);
        return await latest(...a);
      } finally {
        active -= 1;
      }
    };
    const s = await stackOn(old, { heavy: createSemaphore({ max: 2, queue: 6 }) });
    try {
      const statuses = await Promise.all(Array.from({ length: 30 }, () => fetch(`${s.url}/api/projects/${big.id}?lean=1`).then(async (r) => {
        const b = await r.json();
        if (r.status === 200) assert.equal(b.snapshot.doc, undefined);
        return r.status;
      })));
      assert.ok(statuses.every((x) => x === 200 || x === 503), JSON.stringify(statuses));
      assert.ok(statuses.includes(200) && statuses.includes(503));
      assert.ok(peak <= 2, `одновременно ${peak}`);
    } finally {
      await s.close();
    }
  });
});

/* ----------------------- 4–6. эпоха, пропавший проект, имя ----------------------- */

for (const backend of list) {
  describe(`круг 27: пропавший проект, живое имя, stale от начала эпохи · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    it('I3: проекта не стало в базе — всем сокетам проекта на обоих экземплярах error not_found и 4404; голова выгружена', async () => {
      const A = await startFor(backend.name, { verifyMs: 0 });
      const B = await startTwin(backend.name, A, { verifyMs: 0 });
      try {
        const before = backend.name === 'memory' ? A.storage.backup() : null;
        const created = await api(A.url).post('/api/projects', { name: 'Исчезнет', demo: true });
        const id = created.body.id;
        const socks = [connect(wsUrl(A, id, { since: 0, proto: 2 })), connect(wsUrl(A, id, { since: 0, proto: 2 })), connect(wsUrl(B, id, { since: 0, proto: 2 }))];
        for (const x of socks) await x.until((m) => m.type === 'hello');
        assert.ok(A.dslts.isLoaded(id) && B.dslts.isLoaded(id));
        // «базу восстановили из копии, где проекта ещё нет»
        if (before) A.storage.restore(before);
        else await A.storage.pool.query('DELETE FROM projects WHERE id = $1', [id]);
        await Promise.all([A.dslts.verify(), B.dslts.verify()]);
        for (const x of socks) {
          const err = await x.until((m) => m.type === 'error');
          assert.equal(err.code, 'not_found');
          assert.equal(err.retryable, false);
          assert.equal((await x.closed).code, 4404);
        }
        assert.equal(A.dslts.isLoaded(id), false, 'голова выгружена');
        assert.equal(B.dslts.isLoaded(id), false);
        // новый сокет и запись — тоже 404
        const late = connect(wsUrl(B, id, { since: 0, proto: 2 }));
        const e2 = await late.until((m) => m.type === 'error');
        assert.equal(e2.code, 'not_found');
        assert.equal((await late.closed).code, 4404);
        assert.equal((await api(A.url).post(`/api/projects/${id}/tx`, tx(0, []))).status, 404);
      } finally {
        await B.close();
        await A.close();
      }
    });

    it('I4: PATCH имени — сокетам проекта на обоих экземплярах {type:project}; hello несёт новое имя', async () => {
      const A = await startFor(backend.name, { verifyMs: 0 });
      const B = await startTwin(backend.name, A, { verifyMs: 0 });
      try {
        const id = (await api(A.url).post('/api/projects', { name: 'Старое имя' })).body.id;
        const other = (await api(A.url).post('/api/projects', { name: 'Чужой' })).body.id;
        const sa = connect(wsUrl(A, id, { since: 0, proto: 2 }));
        const sb = connect(wsUrl(B, id, { since: 0, proto: 2 }));
        const so = connect(wsUrl(B, other, { since: 0, proto: 2 }));
        for (const x of [sa, sb, so]) await x.until((m) => m.type === 'hello');
        const r = await api(A.url).patch('/api/projects/' + id, { name: 'Новое имя' });
        assert.equal(r.status, 200);
        for (const [name, x] of [['A', sa], ['B (другой экземпляр)', sb]]) {
          const m = await x.until((msg) => msg.type === 'project', 5000);
          assert.equal(m.project.id, id, name);
          assert.equal(m.project.name, 'Новое имя', name);
          assert.equal(m.project.kind, 'design', name);
          assert.equal(typeof m.project.head_seq, 'number', name);
          assert.equal(typeof m.project.updated_at, 'string', name);
        }
        assert.equal(await so.silence(300), true, 'сокетам другого проекта — ничего');
        const late = connect(wsUrl(B, id, { since: 0, proto: 2 }));
        const hello = await late.until((m) => m.type === 'hello');
        assert.equal(hello.project.name, 'Новое имя');
        await Promise.all([sa, sb, so, late].map((x) => x.close()));
      } finally {
        await B.close();
        await A.close();
      }
    });

    it('I5: переигрывание после отката — окно stale от начала нынешней эпохи: 30 своих правок перед set не прячут чужое новое', async () => {
      const A = await startFor(backend.name, { verifyMs: 0 });
      try {
        const h = api(A.url);
        const id = (await h.post('/api/projects', { name: 'Старое против нового', demo: true })).body.id;
        const board = artboards((await h.get('/api/projects/' + id)).body.snapshot.doc)[0];
        const node = text(board.id, 'исходное');
        const made = await h.post(`/api/projects/${id}/tx`, tx(0, [{ op: 'create', node }], { client: 'R5' }));
        assert.equal(made.status, 201);
        const epoch0 = (await h.get(`/api/projects/${id}?head=1`)).body.epoch;
        const backup = await takeBackup(A.storage, id);
        // R5 после бэкапа: 30 токенов, потом своё значение текста — всё пропадёт при restore
        const mine = [];
        let base = made.body.seq;
        for (let i = 0; i < 30; i++) {
          const t = tx(base, [{ op: 'setToken', path: 'color.r5_' + i, value: '#00000' + (i % 10) }], { client: 'R5' });
          const r = await h.post(`/api/projects/${id}/tx`, t);
          mine.push({ t, created_at: r.body.created_at });
          base = r.body.seq;
        }
        const old = tx(base, [{ op: 'set', id: node.id, path: 'characters', value: 'СТАРОЕ (до restore)' }], { client: 'R5' });
        mine.push({ t: old, created_at: (await h.post(`/api/projects/${id}/tx`, old)).body.created_at });
        await restoreBackup(A.storage, id, backup);
        await A.dslts.verify();
        const epoch1 = (await h.get(`/api/projects/${id}?head=1`)).body.epoch;
        assert.notEqual(epoch1, epoch0, 'откат замечен: новая эпоха');
        await sleep(5);
        const fresh = await h.post(`/api/projects/${id}/tx`, tx(1, [{ op: 'set', id: node.id, path: 'characters', value: 'НОВОЕ (после restore)' }], { client: 'R2' }));
        assert.equal(fresh.body.seq, 2);
        // R5 открылся позже и переигрывает свои — с прежними base_seq (номера журнала, которого нет)
        let last = null;
        for (const m of mine) {
          last = await h.post(`/api/projects/${id}/tx`, { ...m.t, replay_of_epoch: epoch0, replay_at: m.created_at });
          assert.equal(last.status, 201, JSON.stringify(last.body));
        }
        assert.deepEqual(last.body.dropped.map((d) => [d.index, d.reason]), [[0, 'stale']], 'старое значение устарело');
        const opened = (await h.get('/api/projects/' + id)).body;
        let doc = opened.snapshot.doc;
        for (const t of opened.tail) doc = applyOps(doc, t.ops).doc;
        assert.equal(doc.nodes[node.id].characters, 'НОВОЕ (после restore)');
        assert.ok(JSON.stringify(doc.tokens).includes('r5_29'), 'свои токены вернулись');
      } finally {
        await A.close();
      }
    });
  });
}

describe('I3 на уровне секвенсора', () => {
  it('attach и clientEvidence к проекту, которого не стало при загруженной голове, — 404 (а не hello по выгруженной голове), событие missing', async () => {
    const storage = createMemoryStorage();
    await storage.init();
    const before = storage.backup();
    const p = await storage.createProject({ name: 'Был', kind: 'design', doc: createDoc('empty'), engine: E });
    const seqr = createSequencer({ storage, verifyMs: 0, log: quiet });
    const events = [];
    seqr.subscribe((ev) => events.push(ev.kind));
    try {
      await seqr.attach(p.id);
      storage.restore(before);
      await assert.rejects(seqr.attach(p.id), (e) => e.status === 404);
      assert.ok(events.includes('missing'));
      assert.equal(seqr.isLoaded(p.id), false);
      await seqr.attach(p.id).catch(() => {});
      await assert.rejects(seqr.clientEvidence(p.id), (e) => e.status === 404);
    } finally {
      await seqr.close();
    }
  });
});

/* ------------------------------- 7. ключи ------------------------------- */

describe('чистка ключей (круг 27): прототип не меняется, двойники не перетирают данные', () => {
  it('"__proto__\\u0000" отбрасывается вместе со значением; собственное __proto__, constructor, prototype — тоже', () => {
    const raw = JSON.parse('{"__proto__\\u0000":{"characters":"ВЗЛОМ"},"__proto__":{"x":1},"constructor":2,"prototype":3,"ok":"да\\u0000"}');
    const out = cleanDeep(raw);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.characters, undefined, 'ничего не унаследовано');
    assert.deepEqual(Object.keys(out), ['ok']);
    assert.equal(out.ok, 'да');
    assert.equal(cleanKey('__proto__\u0000'), null);
    assert.equal(cleanKey('a\u0000b'), 'ab');
  });

  it('ключи, совпавшие после чистки: исходно чистый главнее, из очищенных — последний; порядок ключей не важен', () => {
    const a = cleanDeep(JSON.parse('{"a":1,"a\\u0000":2}'));
    const b = cleanDeep(JSON.parse('{"a\\u0000":2,"a":1}'));
    assert.deepEqual(a, { a: 1 });
    assert.deepEqual(b, { a: 1 });
    assert.deepEqual(cleanDeep(JSON.parse('{"b\\u0000":1,"b\\u0000\\u0000":2}')), { b: 2 });
    const clean = { x: { y: [1, 'z'] } };
    assert.equal(cleanDeep(clean), clean, 'чистое — без копии');
  });

  it('validateTx: узел с ключом "__proto__\\u0000" — без подменённого прототипа', () => {
    const body = JSON.parse(JSON.stringify(tx(0, [{ op: 'create', node: { type: 'text', id: 'n1', parent: 'p', characters: 'x', ['__proto__\u0000']: { characters: 'ВЗЛОМ', locked: true } } }])));
    const t = validateTx(body);
    const node = t.ops[0].node;
    assert.equal(Object.getPrototypeOf(node), Object.prototype);
    assert.equal(node.locked, undefined);
    assert.equal(node.characters, 'x');
  });
});
