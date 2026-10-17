/**
 * Круг 29 — Document service: чужие значения не роняют процесс (фаззинг HTTP и WS
 * значениями-объектами во всех полях), кадр рассылки сериализуется один раз на событие,
 * подключение сокета не встаёт в очередь записи (attach без мьютекса), здоровье хранилища
 * (J1), журнал «Истории» без операций (J2), `error unavailable` по сокету при сбое
 * хранилища (J4), проверка импорта документа (J7), страховка процесса.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createDoc, uid, ENGINE_VERSION } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createReader } from '../../server/document/dslr.js';
import { createSequencer } from '../../server/document/dslts.js';
import { createHub } from '../../server/document/hub.js';
import { createRequestHandler } from '../../server/document/http.js';
import { installCrashGuard } from '../../server/document/index.js';
import { showValue } from '../../server/document/limits.js';
import { backends, startFor, api, connect, wsUrl, waitFor, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });

/** Стек над данным хранилищем без start(): хранилище можно обернуть. */
async function stackOn(storage, { internalToken } = {}) {
  const dslr = createReader({ storage });
  const dslts = createSequencer({ storage, verifyMs: 0, log: quiet });
  const server = http.createServer(createRequestHandler({ dslr, dslts, storage, log: quiet, internalToken }));
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

/**
 * Значения-ловушки (как пришли бы из JSON): объекты с toString/valueOf не функциями —
 * их шаблон строки и String() превращают в TypeError.
 */
const EVIL_JSON = [
  '{"toString":1}', '{"toString":1,"valueOf":1}', '{"toString":{},"valueOf":{}}', '[{"toString":1}]',
  '{"__proto__":{"toString":1}}', '[]', '{}', 'null', 'true', '-1', '1e308', '"\\u0000"', '"\\ud800"',
  JSON.stringify('я'.repeat(600)), '['.repeat(90) + ']'.repeat(90)
];
const EVIL = EVIL_JSON.map((t) => JSON.parse(t));

/** Тело с подменой: значение по пути `a.b.0.c` (массивы — числом). */
function withValue(base, pathList, v) {
  const out = JSON.parse(JSON.stringify(base));
  let cur = out;
  for (let i = 0; i < pathList.length - 1; i++) cur = cur[pathList[i]];
  cur[pathList[pathList.length - 1]] = v;
  return out;
}

const list = await backends();

describe('круг 29: чужие значения-объекты не роняют процесс', () => {
  it('showValue: строка — обрезанная, объект — только тип; шаблон с {toString:1} больше не бросает', () => {
    assert.equal(showValue('abc'), 'abc');
    assert.equal(showValue('x'.repeat(100)).length, 40);
    assert.equal(showValue(JSON.parse('{"toString":1}')), 'объект');
    assert.equal(showValue([1]), 'массив');
    assert.equal(showValue(null), 'null');
    assert.equal(showValue(3), '3');
    assert.doesNotThrow(() => `«${showValue(JSON.parse('{"toString":1,"valueOf":1}'))}»`);
  });

  for (const b of list) {
    it(`WS: {"type":{"toString":1}} — ответ bad_request, сокет и сервис живы · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'crash' })).body;
        const c = connect(wsUrl(svc, p.id, { since: 0, proto: 2 }));
        await c.opened;
        assert.equal((await c.until((m) => m.type === 'hello')).type, 'hello');
        c.ws.send('{"type":{"toString":1}}');
        const err = await c.until((m) => m.type === 'error');
        assert.equal(err.code, 'bad_request');
        assert.match(err.message, /объект/);
        // после ловушки сокет работает дальше: транзакция проходит
        const open = (await h.get(`/api/projects/${p.id}`)).body;
        const t = tx(0, [{ op: 'set', id: open.snapshot.doc.root, path: 'name', value: 'жив' }]);
        c.send({ type: 'tx', tx: t });
        const got = await c.until((m) => m.type === 'tx');
        assert.equal(got.tx.tx_id, t.tx_id);
        assert.equal((await h.get('/api/health')).status, 200);
        await c.close();
      } finally {
        await svc.close();
      }
    });

    it(`HTTP: engine/name/kind — объекты дают 4xx, а не 500 · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'e' })).body;
        const r1 = await h.post(`/api/projects/${p.id}/tx`, '{"tx_id":"t1","base_seq":0,"ops":[],"engine":{"toString":1}}');
        assert.equal(r1.status, 426);
        assert.equal(r1.body.code, 'engine');
        const r2 = await h.post('/api/projects', '{"name":{"toString":1}}');
        assert.equal(r2.status, 400);
        const r3 = await h.post('/api/projects', '{"kind":{"toString":1}}');
        assert.equal(r3.status, 400);
      } finally {
        await svc.close();
      }
    });

    it(`фаззинг HTTP: каждое поле тел и запросов — каждой ловушкой; ни одного 5xx, сервис жив · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name, { internalToken: 'fuzz-token-29' });
      const statuses = {};
      const count = (s) => { statuses[s] = (statuses[s] || 0) + 1; };
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'fz' })).body;
        const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
        const kid = uid('n');
        const base = {
          tx_id: 'x', base_seq: 0, engine: E, undo_of: 'u', redo_of: 'r', client: 'c', author: 'a', title: 't',
          author_kind: 'human', command_id: 'cmd', replay_of_epoch: 'ep', replay_at: new Date().toISOString(),
          ops: [
            { op: 'create', node: { type: 'frame', id: kid, name: 'n', parent: root, children: [] }, parent: root, index: 0, after: null },
            { op: 'set', id: kid, path: 'name', value: 'v' },
            { op: 'move', id: kid, parent: root, index: 0, after: null },
            { op: 'setToken', path: 'color.x', value: '#fff' },
            { op: 'remove', id: kid }
          ]
        };
        const txPaths = [
          ['tx_id'], ['base_seq'], ['engine'], ['ops'], ['undo_of'], ['redo_of'], ['client'], ['author'], ['title'],
          ['author_kind'], ['command_id'], ['replay_of_epoch'], ['replay_at'],
          ['ops', 0], ['ops', 0, 'op'], ['ops', 0, 'node'], ['ops', 0, 'node', 'id'], ['ops', 0, 'node', 'type'],
          ['ops', 0, 'node', 'parent'], ['ops', 0, 'node', 'children'], ['ops', 0, 'node', 'name'], ['ops', 0, 'parent'],
          ['ops', 0, 'index'], ['ops', 0, 'after'], ['ops', 1, 'id'], ['ops', 1, 'path'], ['ops', 1, 'value'],
          ['ops', 2, 'parent'], ['ops', 2, 'index'], ['ops', 3, 'path'], ['ops', 3, 'value'], ['ops', 4, 'id']
        ];
        let n = 0;
        for (const path of txPaths) {
          for (const v of EVIL) {
            const body = withValue(base, path, v);
            body.tx_id = path[0] === 'tx_id' ? v : 'fz' + (n++);
            const r = await h.post(`/api/projects/${p.id}/tx`, body);
            count(r.status);
            assert.ok(r.status < 500, `tx ${path.join('.')} = ${JSON.stringify(v).slice(0, 40)} → ${r.status} ${r.text.slice(0, 200)}`);
          }
        }
        const doc = createDoc('empty');
        const projBase = { name: 'n', kind: 'design', demo: false, doc };
        const projPaths = [['name'], ['kind'], ['demo'], ['doc'], ['doc', 'nodes'], ['doc', 'root'], ['doc', 'tokens'], ['doc', 'meta'],
          ['doc', 'nodes', doc.root], ['doc', 'nodes', doc.root, 'children'], ['doc', 'nodes', doc.root, 'type'], ['doc', 'nodes', doc.root, 'name']];
        for (const path of projPaths) {
          for (const v of EVIL) {
            const r = await h.post('/api/projects', withValue(projBase, path, v));
            count(r.status);
            assert.ok(r.status < 500, `project ${path.join('.')} = ${JSON.stringify(v).slice(0, 40)} → ${r.status} ${r.text.slice(0, 200)}`);
          }
        }
        for (const v of EVIL) {
          const r1 = await h.patch(`/api/projects/${p.id}`, { name: v });
          const r2 = await h.raw('POST', '/api/internal/traces', { project_id: v, command_id: 'c' }, { 'x-internal-token': 'fuzz-token-29' });
          const r3 = await h.raw('POST', '/api/internal/traces', { project_id: p.id, command_id: v, body: v }, { 'x-internal-token': 'fuzz-token-29' });
          for (const r of [r1, r2, r3]) {
            count(r.status);
            assert.ok(r.status < 500, `patch/traces ${JSON.stringify(v).slice(0, 40)} → ${r.status} ${r.text.slice(0, 200)}`);
          }
          // тело-ловушка целиком
          for (const path of [`/api/projects/${p.id}/tx`, '/api/projects', `/api/projects/${p.id}`]) {
            const r = await h.raw(path.endsWith(p.id) ? 'PATCH' : 'POST', path, JSON.stringify(v));
            count(r.status);
            assert.ok(r.status < 500, `тело ${path} = ${JSON.stringify(v).slice(0, 40)} → ${r.status}`);
          }
        }
        const q = ['[object Object]', '%00', '-0', '1e3', '0x10', '99999999999999999999', '%ED%A0%80', '', 'null', '-1'];
        for (const v of q) {
          for (const path of [
            `/api/projects/${p.id}/ops?since=${v}&limit=${v}`, `/api/projects/${p.id}/ops?since=0&tip=${v}&epoch=${v}`,
            `/api/projects/${p.id}?lean=1&since=${v}`, `/api/projects/${p.id}?head=${v}`, `/api/projects/${p.id}/history?limit=${v}&before=${v}`,
            `/api/projects?kind=${v}&limit=${v}&after=${v}`, `/api/projects/${v}`, `/api/projects/${v}/history`, `/api/projects/${p.id}/traces?limit=${v}`
          ]) {
            const r = await h.get(path, { 'x-author': v });
            count(r.status);
            assert.ok(r.status < 500, `GET ${path} → ${r.status} ${r.text.slice(0, 200)}`);
          }
        }
        assert.equal((await h.get('/api/health')).status, 200);
        assert.ok(statuses[400] > 0 && !Object.keys(statuses).some((s) => Number(s) >= 500), JSON.stringify(statuses));
      } finally {
        await svc.close();
      }
    });

    it(`фаззинг WS: адрес, тип, поля tx и presence — ловушками; сокет не закрывается, сервис жив · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'wsf' })).body;
        const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
        // адрес: негодные параметры — отказ закрытием, не падение
        for (const v of ['[object Object]', '%00', '%ED%A0%80', '1e9', '-5', 'x'.repeat(300)]) {
          for (const params of [{ project: v }, { project: p.id, since: v }, { project: p.id, since: '0', tip: v, epoch: v }, { project: p.id, client: v, author: v }]) {
            const c = connect(`ws://127.0.0.1:${svc.port}/ws?${new URLSearchParams(params)}`);
            await c.opened.catch(() => {});
            const first = await Promise.race([c.next(3000).catch(() => null), c.closed]);
            assert.ok(first, 'сокет ответил или закрылся');
            c.ws.terminate();
          }
        }
        const c = connect(wsUrl(svc, p.id, { since: 0, proto: 2 }));
        await c.opened;
        await c.until((m) => m.type === 'hello');
        const errors = [];
        let closedEarly = false;
        c.closed.then(() => { closedEarly = true; });
        const send = (text) => c.ws.send(text);
        const baseTx = { tx_id: 'w', base_seq: 0, engine: E, author: 'a', title: 't', client: 'c', ops: [{ op: 'set', id: root, path: 'name', value: 'v' }] };
        let n = 0;
        for (const t of EVIL_JSON) {
          send(`{"type":${t}}`);
          send(t);
          send(`{"type":"tx","tx":${t}}`);
          for (const f of ['tx_id', 'base_seq', 'engine', 'ops', 'author', 'title', 'client', 'author_kind', 'undo_of', 'command_id']) {
            const body = { ...baseTx, tx_id: 'w' + (n++) };
            send(JSON.stringify({ type: 'tx', tx: body }).replace(`"${f}":${JSON.stringify(body[f])}`, `"${f}":${t}`));
          }
          for (const f of ['selection', 'author', 'board', 'busy', 'queued']) send(`{"type":"presence","${f}":${t}}`);
          send(`{"type":"presence","selection":[${t},${t}]}`);
          // не забивать сокет: WS_INFLIGHT — 2, лишнее получает busy (тоже ответ, но не то, что проверяем)
          await sleep(5);
        }
        // дождаться, пока сокет ответит на всё: после ловушек — годная транзакция доходит
        const ok = tx(0, [{ op: 'set', id: root, path: 'name', value: 'итог' }]);
        await sleep(200);
        c.send({ type: 'tx', tx: ok });
        for (;;) {
          const m = await c.next(5000);
          if (m.type === 'error') errors.push(m);
          if (m.type === 'tx' && m.tx.tx_id === ok.tx_id) break;
        }
        assert.equal(closedEarly, false, 'сокет не закрыт');
        assert.ok(errors.length > 0);
        for (const e of errors) {
          assert.ok(['bad_request', 'engine', 'too_large', 'busy'].includes(e.code), `код ${e.code}: ${e.message}`);
        }
        assert.equal((await h.get('/api/health')).status, 200);
        await c.close();
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 29: кадр рассылки сериализуется один раз на событие', () => {
  it('транзакция 1,5 МБ на 40 сокетов: одна сериализация, все получили её целиком', async () => {
    const svc = await startFor('memory');
    try {
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'fan' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      const socks = [];
      for (let i = 0; i < 40; i++) {
        const c = connect(wsUrl(svc, p.id, { since: 0, proto: 2 }));
        await c.opened;
        await c.until((m) => m.type === 'hello');
        socks.push(c);
      }
      const before = svc.hub.framesSerialized();
      const big = 'q'.repeat(1_500_000);
      const t = tx(0, [{ op: 'set', id: root, path: 'name', value: big }]);
      assert.equal((await h.post(`/api/projects/${p.id}/tx`, t)).status, 201);
      for (const c of socks) {
        const m = await c.until((x) => x.type === 'tx', 10000);
        assert.equal(m.tx.tx_id, t.tx_id);
        assert.equal(m.tx.ops[0].value.length, big.length);
      }
      assert.equal(svc.hub.framesSerialized() - before, 1, 'кадр сериализован один раз');
      // и маленькие — один раз на событие
      const t2 = tx(1, [{ op: 'set', id: root, path: 'name', value: 'мал' }]);
      await h.post(`/api/projects/${p.id}/tx`, t2);
      for (const c of socks) await c.until((x) => x.type === 'tx' && x.tx.tx_id === t2.tx_id);
      assert.equal(svc.hub.framesSerialized() - before, 2);
      for (const c of socks) c.ws.terminate();
    } finally {
      await svc.close();
    }
  });
});

describe('круг 29: подключение сокета не ждёт мьютекса записи', () => {
  /** Хранилище, у которого запись ждёт ворот. */
  function gatedStorage() {
    const storage = createMemoryStorage();
    let open = true;
    let release = () => {};
    let gate = Promise.resolve();
    const commitTx = storage.commitTx.bind(storage);
    storage.commitTx = async (...a) => {
      await gate;
      return commitTx(...a);
    };
    return {
      storage,
      close() { open = false; gate = new Promise((r) => { release = r; }); },
      open() { open = true; release(); },
      get isOpen() { return open; }
    };
  }

  it('запись висит под мьютексом — hello приходит сразу; потом все сокеты видят её ровно раз и по порядку', async () => {
    const g = gatedStorage();
    const st = await stackOn(g.storage);
    try {
      const h = api(st.url);
      const p = (await h.post('/api/projects', { name: 'att' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      // голова загружена (первая запись)
      assert.equal((await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'a' }]))).status, 201);
      g.close();
      const pending = h.post(`/api/projects/${p.id}/tx`, tx(1, [{ op: 'set', id: root, path: 'name', value: 'b' }]));
      await sleep(50);
      const t0 = Date.now();
      const socks = [];
      for (let i = 0; i < 60; i++) {
        socks.push(connect(wsUrl(st, p.id, { since: i % 2 ? 0 : 1, proto: 2 })));
      }
      for (const c of socks) {
        await c.opened;
        const hello = await c.until((m) => m.type === 'hello', 3000);
        assert.equal(hello.head_seq, 1);
      }
      assert.ok(g.isOpen === false, 'запись всё ещё висит, а hello уже пришли');
      assert.ok(Date.now() - t0 < 3000);
      assert.ok(st.dslts.attachStats().fast >= 60, JSON.stringify(st.dslts.attachStats()));
      g.open();
      assert.equal((await pending).status, 201);
      for (const t of [2, 3]) await h.post(`/api/projects/${p.id}/tx`, tx(t, [{ op: 'set', id: root, path: 'name', value: 'v' + t }]));
      for (let i = 0; i < socks.length; i++) {
        const seen = [];
        while (seen[seen.length - 1] !== 4) seen.push((await socks[i].until((m) => m.type === 'tx', 3000)).tx.seq);
        assert.deepEqual(seen, i % 2 ? [1, 2, 3, 4] : [2, 3, 4], `сокет ${i}`);
        assert.equal(await socks[i].silence(30), true);
      }
      for (const c of socks) c.ws.terminate();
    } finally {
      g.open();
      await st.close();
    }
  });

  it('голова не загружена: сокеты одного проекта ждут первую загрузку, а не встают в мьютекс по одному', async () => {
    const storage = createMemoryStorage();
    const st = await stackOn(storage);
    try {
      const h = api(st.url);
      const p = (await h.post('/api/projects', { name: 'cold' })).body;
      const socks = Array.from({ length: 30 }, () => connect(wsUrl(st, p.id, { since: 0, proto: 2 })));
      for (const c of socks) await c.until((m) => m.type === 'hello', 3000);
      const s = st.dslts.attachStats();
      assert.ok(s.slow <= 3, `под мьютексом — единицы (${JSON.stringify(s)})`);
      for (const c of socks) c.ws.terminate();
    } finally {
      await st.close();
    }
  });
});

describe('круг 29: здоровье хранилища (J1)', () => {
  it('GET /api/health: storage.ping → up/down; без ping — своё чтение с дедлайном', async () => {
    const storage = createMemoryStorage();
    let up = true;
    storage.ping = async () => up;
    const st = await stackOn(storage);
    try {
      const h = api(st.url);
      let r = await h.get('/api/health');
      assert.equal(r.status, 200);
      assert.deepEqual({ ok: r.body.ok, storage: r.body.storage, engine: r.body.engine }, { ok: true, storage: 'up', engine: E });
      up = false;
      r = await h.get('/api/health');
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'unavailable');
      assert.equal(r.body.retryable, true);
      assert.deepEqual(r.body.detail, { storage: 'down' });
      storage.ping = async () => { throw new Error('нет связи'); };
      assert.equal((await h.get('/api/health')).status, 503);
    } finally {
      await st.close();
    }
    // хранилище без ping: чтение висит — 503 за дедлайн
    const s2 = createMemoryStorage();
    delete s2.ping;
    const getProject = s2.getProject.bind(s2);
    let hang = false;
    s2.getProject = (...a) => (hang ? new Promise(() => {}) : getProject(...a));
    const st2 = await stackOn(s2);
    try {
      const h = api(st2.url);
      assert.equal((await h.get('/api/health')).status, 200);
      hang = true;
      await sleep(1100);   // кеш ответа — 1 с
      const t0 = Date.now();
      const r = await h.get('/api/health');
      assert.equal(r.status, 503);
      assert.ok(Date.now() - t0 < 3000);
      hang = false;
      await sleep(1100);
      assert.equal((await h.get('/api/health')).status, 200);
    } finally {
      await st2.close();
    }
  });

  it('pg без базы (порт закрыт): /api/health — 503 storage down, а не 200', async () => {
    const { createPgStorage } = await import('../../server/document/storage/pg.js');
    const storage = createPgStorage({ connectionString: 'postgres://imago:imago@127.0.0.1:1/nope', log: quiet, connectionTimeoutMillis: 500 });
    const st = await stackOn(storage);
    try {
      const r = await api(st.url).get('/api/health');
      assert.equal(r.status, 503);
      assert.deepEqual(r.body.detail, { storage: 'down' });
    } finally {
      await st.close();
      await storage.close().catch(() => {});
    }
  });
});

describe('круг 29: журнал «Истории» без операций (J2)', () => {
  for (const b of list) {
    for (const hide of [false, true]) {
      it(`GET …/history: новые первыми, страницы по before, empty у пустых, пределы · ${b.name}${hide ? ' · хранилище без recentTxMeta' : ''}`, { skip: !b.available }, async () => {
        const svc = await startFor(b.name);
        if (hide) {
          // хранилище прежней версии: страницы txsAfter с конца
          svc.storage.recentTxMeta = undefined;
        }
        try {
          const h = api(svc.url);
          const p = (await h.post('/api/projects', { name: 'hist' })).body;
          const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
          await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'a' }], { author: 'Аня', title: 'Переименовал', client: 'cl1', command_id: 'cmd1' }));
          await h.post(`/api/projects/${p.id}/tx`, tx(1, [], { author_kind: 'agent', title: 'пустая' }));
          // все операции выпали — запись есть, пустая
          await h.post(`/api/projects/${p.id}/tx`, tx(2, [{ op: 'remove', id: 'нет-такого' }, { op: 'set', id: 'и-такого', path: 'name', value: 'x' }]));
          for (let i = 3; i < 8; i++) await h.post(`/api/projects/${p.id}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'v' + i }]));
          let r = await h.get(`/api/projects/${p.id}/history`);
          assert.equal(r.status, 200);
          assert.deepEqual(r.body.items.map((x) => x.seq), [8, 7, 6, 5, 4, 3, 2, 1]);
          assert.equal(r.body.more, false);
          const first = r.body.items.find((x) => x.seq === 1);
          assert.equal(first.author, 'Аня');
          assert.equal(first.title, 'Переименовал');
          assert.equal(first.client, 'cl1');
          assert.equal(first.command_id, 'cmd1');
          assert.equal(first.ops_count, 1);
          assert.equal(first.dropped_count, 0);
          assert.equal(first.empty, undefined);
          assert.ok(typeof first.tx_id === 'string' && typeof first.created_at === 'string');
          assert.equal(first.ops, undefined, 'операций в ответе нет');
          const two = r.body.items.find((x) => x.seq === 2);
          assert.equal(two.empty, true);
          assert.equal(two.author_kind, 'agent');
          const three = r.body.items.find((x) => x.seq === 3);
          assert.equal(three.empty, true);
          assert.equal(three.ops_count, 0);
          assert.equal(three.dropped_count, 2);
          r = await h.get(`/api/projects/${p.id}/history?limit=3`);
          assert.deepEqual(r.body.items.map((x) => x.seq), [8, 7, 6]);
          assert.equal(r.body.more, true);
          r = await h.get(`/api/projects/${p.id}/history?limit=3&before=6`);
          assert.deepEqual(r.body.items.map((x) => x.seq), [5, 4, 3]);
          assert.equal(r.body.more, true);
          r = await h.get(`/api/projects/${p.id}/history?limit=3&before=3`);
          assert.deepEqual(r.body.items.map((x) => x.seq), [2, 1]);
          assert.equal(r.body.more, false);
          r = await h.get(`/api/projects/${p.id}/history?before=1`);
          assert.deepEqual(r.body, { items: [], more: false });
          assert.equal((await h.get(`/api/projects/${p.id}/history?limit=201`)).status, 400);
          assert.equal((await h.get(`/api/projects/${p.id}/history?limit=200`)).status, 200);
          assert.equal((await h.get(`/api/projects/${p.id}/history?before=0`)).status, 400);
          assert.equal((await h.get('/api/projects/nope/history')).status, 404);
          assert.equal((await h.post(`/api/projects/${p.id}/history`, {})).status, 405);
        } finally {
          await svc.close();
        }
      });
    }
  }
});

describe('круг 29: хранилище недоступно — по сокету error unavailable, сокет живёт (J4)', () => {
  it('сбой записи: error {code:unavailable, retryable, detail.cause:storage, tx_id}; повтор после — tx', async () => {
    const storage = createMemoryStorage();
    const commitTx = storage.commitTx.bind(storage);
    let fail = 0;
    storage.commitTx = async (...a) => {
      if (fail > 0) { fail--; throw new Error('connection terminated'); }
      return commitTx(...a);
    };
    const st = await stackOn(storage);
    try {
      const h = api(st.url);
      const p = (await h.post('/api/projects', { name: 'down' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      const c = connect(wsUrl(st, p.id, { since: 0, proto: 2 }));
      await c.until((m) => m.type === 'hello');
      fail = 1;
      const t = tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }]);
      c.send({ type: 'tx', tx: t });
      const e = await c.until((m) => m.type === 'error');
      assert.equal(e.code, 'unavailable');
      assert.equal(e.retryable, true);
      assert.equal(e.detail.cause, 'storage');
      assert.equal(e.tx_id, t.tx_id);
      c.send({ type: 'tx', tx: t });
      assert.equal((await c.until((m) => m.type === 'tx')).tx.tx_id, t.tx_id);
      await c.close();
    } finally {
      await st.close();
    }
  });

  it('догон после hello не дочитался — error unavailable, догон повторяется, сокет не закрыт', async () => {
    const storage = createMemoryStorage();
    const txsAfter = storage.txsAfter.bind(storage);
    let fail = 0;
    storage.txsAfter = async (...a) => {
      if (fail > 0) { fail--; throw new Error('connection terminated'); }
      return txsAfter(...a);
    };
    const st = await stackOn(storage);
    try {
      const h = api(st.url);
      const p = (await h.post('/api/projects', { name: 'pump' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      for (let i = 0; i < 3; i++) await h.post(`/api/projects/${p.id}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'v' + i }]));
      fail = 2;
      const c = connect(wsUrl(st, p.id, { since: 0, proto: 2 }));
      let closed = false;
      c.closed.then(() => { closed = true; });
      await c.until((m) => m.type === 'hello');
      const e = await c.until((m) => m.type === 'error', 3000);
      assert.equal(e.code, 'unavailable');
      assert.equal(e.detail.cause, 'storage');
      const seqs = [];
      while (seqs.length < 3) {
        const m = await c.next(5000);
        if (m.type === 'tx') seqs.push(m.tx.seq);
      }
      assert.deepEqual(seqs, [1, 2, 3]);
      assert.equal(closed, false);
      await c.close();
    } finally {
      await st.close();
    }
  });
});

describe('круг 29: импорт документа — предел глубины (J7)', () => {
  const chain = (depth) => {
    const d = createDoc('empty');
    const nodes = JSON.parse(JSON.stringify(d.nodes));
    let par = d.root;
    for (let i = 0; i < depth; i++) {
      const id = 'd' + i;
      nodes[id] = { id, type: 'frame', name: id, parent: par, children: [] };
      nodes[par].children = [...(nodes[par].children || []), id];
      par = id;
    }
    return { ...d, nodes };
  };
  for (const b of list) {
    it(`POST /api/projects с doc глубже предела — 400; в пределе — 201 · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const bad = await h.post('/api/projects', { name: 'deep', doc: chain(400) });
        assert.equal(bad.status, 400, bad.text.slice(0, 300));
        assert.equal(bad.body.code, 'bad_request');
        const ok = await h.post('/api/projects', { name: 'ok', doc: chain(200) });
        assert.equal(ok.status, 201, ok.text.slice(0, 300));
        const huge = await h.post('/api/projects', { name: 'deeper', doc: chain(19000) });
        assert.equal(huge.status, 400);
        assert.equal((await h.get('/api/health')).status, 200);
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 29: страховка процесса от необработанных ошибок', () => {
  it('обычная ошибка — лог и дальше; системный код, не готов, шторм — фатально (один раз)', () => {
    const target = new EventEmitter();
    const lines = [];
    let fatal = 0;
    let ready = true;
    const off = installCrashGuard({ target, log: { warn: (...a) => lines.push(a.join(' ')) }, onFatal: () => { fatal++; }, isReady: () => ready, stormMax: 5, stormWindowMs: 60000 });
    target.emit('uncaughtException', new TypeError('Cannot convert object to primitive value'));
    target.emit('unhandledRejection', new Error('отказ'));
    assert.equal(fatal, 0);
    assert.match(lines[0], /продолжает работу/);
    assert.match(lines[0], /Cannot convert/);
    target.emit('uncaughtException', Object.assign(new Error('listen'), { code: 'EADDRINUSE' }));
    assert.equal(fatal, 1);
    assert.match(lines[2], /фатально/);
    for (let i = 0; i < 10; i++) target.emit('uncaughtException', new Error('ещё'));
    assert.equal(fatal, 1, 'фатальное — один раз');
    off();
    assert.equal(target.listenerCount('uncaughtException'), 0);
    // не готов — фатально; шторм — фатально
    let f2 = 0;
    ready = false;
    const off2 = installCrashGuard({ target, log: { warn() {} }, onFatal: () => { f2++; }, isReady: () => ready });
    target.emit('uncaughtException', new Error('до готовности'));
    assert.equal(f2, 1);
    off2();
    let f3 = 0;
    const off3 = installCrashGuard({ target, log: { warn() {} }, onFatal: () => { f3++; }, stormMax: 3 });
    for (let i = 0; i < 3; i++) target.emit('uncaughtException', new Error('e' + i));
    assert.equal(f3, 0);
    target.emit('uncaughtException', new Error('e4'));
    assert.equal(f3, 1);
    off3();
  });
});
