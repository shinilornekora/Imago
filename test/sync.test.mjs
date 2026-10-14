import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { createSync, memoryStorage, droppedLine, statusLine, LIMITS } from '../src/sync.js';

const { createDoc, applyOps, ops, hashDoc, rebase, collectTombstones, ENGINE_VERSION } = core;

/* ------------------------------ фальшивый сервер ------------------------------ */

/**
 * Document service в памяти (SPEC §9.4 в сорок строк): принимает tx, делает
 * rebase + applyOps, нумерует, рассылает подписчикам — своим тоже. Помнит tx_id
 * (идемпотентность), умеет «уронить» сокеты, «забыть» хвост (gone) и придержать
 * отправку клиента, чтобы между его правкой и подтверждением успела чужая.
 */
class FakeServer {
  constructor(doc) {
    this.doc = doc; this.seq = 0; this.log = []; this.byId = new Map(); this.tomb = new Map();
    this.sockets = new Set(); this.down = false; this.hold = false; this.held = [];
    this.snapshot = { seq: 0, doc, engine: ENGINE_VERSION }; this.floor = 0; this.received = [];
    this.failNext = null; this.busy = 0; this.httpCalls = [];
  }
  commit(tx) {
    this.received.push(tx.tx_id);
    if (this.byId.has(tx.tx_id)) return this.byId.get(tx.tx_id);
    const m = rebase(this.doc, tx.ops, { tombstones: this.tomb });
    for (const [id, p] of collectTombstones(this.doc, m.ops)) this.tomb.set(id, p);
    const res = applyOps(this.doc, m.ops);
    if (res.error) throw new Error('сервер: применённая форма не применилась: ' + res.error.message);
    this.doc = res.doc;
    const c = { ...tx, seq: ++this.seq, ops: m.ops, dropped: m.dropped, notes: m.notes, created_at: new Date().toISOString() };
    this.log.push(c); this.byId.set(tx.tx_id, c);
    for (const s of this.sockets) s.deliver({ type: 'tx', tx: c });
    return c;
  }
  since(seq) { return this.log.filter((c) => c.seq > seq); }
  broadcast(msg, except) { for (const s of this.sockets) if (s !== except) s.deliver(msg); }
  release() { const list = this.held; this.held = []; this.hold = false; for (const tx of list) this.commit(tx); }
  dropAll() { for (const s of [...this.sockets]) s.close(); }
  /** хвост ушёл в холод: клиент со старым since получает снимок (gone / 410) */
  forget() { this.snapshot = { seq: this.seq, doc: this.doc, engine: ENGINE_VERSION }; this.floor = this.seq; }
  fetch = async (url) => {
    if (this.down) throw new Error('ECONNREFUSED');
    const u = new URL(url, 'http://test');
    const json = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
    this.httpCalls.push({ at: Date.now(), path: u.pathname + u.search });
    if (this.busy > 0) {
      this.busy -= 1;
      return json(503, { error: true, code: 'busy', message: 'занято', retryable: true, retry_after: 0.08 }, { 'retry-after': '0.08' });
    }
    let m;
    if ((m = /^\/api\/projects\/([^/]+)\/ops$/.exec(u.pathname))) {
      const since = Number(u.searchParams.get('since') || 0);
      if (since < this.floor) return json(410, { snapshot: this.snapshot, head_seq: this.seq });
      return json(200, { head_seq: this.seq, txs: this.since(since) });
    }
    if ((m = /^\/api\/projects\/([^/]+)$/.exec(u.pathname))) {
      if (m[1] !== 'p1') return json(404, { error: 'not found' });
      return json(200, { id: m[1], name: 'Тест', kind: 'design', head_seq: this.seq, snapshot: this.snapshot, tail: this.since(this.snapshot.seq) });
    }
    return json(404, {});
  };
  /** Класс сокета, привязанный к этому серверу: new WS(url) как в браузере. */
  socketClass() {
    const server = this;
    return class FakeSocket {
      constructor(url) {
        this.url = new URL(url); this.readyState = 0; this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this.client = this.url.searchParams.get('client');
        setTimeout(() => {
          if (server.down) { this.readyState = 3; if (this.onclose) this.onclose({}); return; }
          this.readyState = 1; server.sockets.add(this);
          if (this.onopen) this.onopen({});
          const since = Number(this.url.searchParams.get('since') || 0);
          if (since < server.floor) {
            this.deliver({ type: 'gone', snapshot: server.snapshot, head_seq: server.seq });
            for (const c of server.since(server.snapshot.seq)) this.deliver({ type: 'tx', tx: c });
          } else {
            this.deliver({ type: 'hello', project: this.url.searchParams.get('project'), head_seq: server.seq, engine: ENGINE_VERSION });
            for (const c of server.since(since)) this.deliver({ type: 'tx', tx: c });
          }
        }, 0);
      }
      deliver(msg) {
        if (this.readyState !== 1) return;
        setTimeout(() => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }, 0);
      }
      send(data) {
        const msg = JSON.parse(data);
        if (msg.type === 'tx') {
          if (server.failNext) {
            const f = server.failNext; server.failNext = null; server.received.push(msg.tx.tx_id);
            this.deliver({ type: 'error', error: true, tx_id: msg.tx.tx_id, ...f });
            return;
          }
          if (server.hold) { server.held.push(msg.tx); return; }
          // повтор уже записанной, которую этот сокет уже видел (она в снимке) — ack, как Hub круга 23
          const known = server.byId.get(msg.tx.tx_id);
          if (known && known.seq <= server.floor) { server.received.push(msg.tx.tx_id); this.deliver({ type: 'ack', tx_id: known.tx_id, seq: known.seq, existing: true }); return; }
          setTimeout(() => server.commit(msg.tx), 0);
        } else if (msg.type === 'presence') {
          server.broadcast({ type: 'presence', client: this.client, author: msg.author, selection: msg.selection, board: msg.board, at: Date.now() }, this);
        }
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3; server.sockets.delete(this);
        server.broadcast({ type: 'left', client: this.client });
        if (this.onclose) this.onclose({});
      }
    };
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
/** ждать, пока условие не станет истинным (до 2 с) */
async function until(fn, what = 'условие') {
  for (let i = 0; i < 200; i++) { if (fn()) return; await tick(10); }
  assert.fail(`не дождались: ${what}`);
}

/** Документ: страница + доска + прямоугольник. */
function seedDoc() {
  let doc = createDoc('empty');
  const push = (list) => { const r = applyOps(doc, list); assert.equal(r.error, undefined, JSON.stringify(r.error)); doc = r.doc; };
  push([ops.create({
    type: 'frame', id: 'ab', name: 'Доска', parent: doc.root, children: [], pos: { x: 0, y: 0 }, radius: 0,
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } },
    layout: { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'start', justify: 'start', wrap: false }, fill: '#ffffff',
  })]);
  push([ops.create({ type: 'rect', id: 'r1', name: 'Плашка', parent: 'ab', radius: 0, fill: '#cccccc', size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 40 } } })]);
  return doc;
}

/** Клиент к серверу: все колбэки копятся в списки, чтобы их было чем проверять. */
function client(server, id, extra = {}) {
  const log = { changes: [], statuses: [], dropped: [], presence: [], gone: [], errors: [] };
  const sync = createSync({
    core, baseUrl: 'http://test', projectId: 'p1', clientId: id, author: 'Имя ' + id,
    storage: extra.storage || memoryStorage(),
    WebSocketImpl: server.socketClass(), fetchImpl: server.fetch,
    reconnectMin: 5, reconnectMax: 20,
    onChange: (view, info) => log.changes.push({ ...info, view }),
    onStatus: (s) => log.statuses.push(s),
    onDropped: (tx) => log.dropped.push(tx),
    onPresence: (list) => log.presence.push(list),
    onGone: (s) => log.gone.push(s),
    onError: (e) => log.errors.push(e),
    ...extra.opts,
  });
  return { sync, log };
}

/* ---------------------------------- тесты ---------------------------------- */

test('sync: оптимистичное применение — view меняется до подтверждения', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online, 'сокет открыт');
  server.hold = true;   // подтверждение задерживается
  const r = a.sync.commit([ops.set('r1', 'name', 'Кнопка')], { title: 'Переименовать' });
  assert.ok(r.tx && r.tx.tx_id.startsWith('tx_'));
  assert.equal(r.tx.base_seq, 0);
  assert.equal(r.tx.engine, ENGINE_VERSION);
  assert.equal(a.sync.view.nodes.r1.name, 'Кнопка', 'правка видна сразу');
  assert.equal(a.sync.status.pending, 1);
  assert.equal(server.doc.nodes.r1.name, 'Плашка', 'сервер её ещё не видел');
  await tick();
  assert.equal(a.sync.status.pending, 1, 'без подтверждения очередь не пустеет');
  server.release();
  await until(() => a.sync.status.pending === 0, 'подтверждение');
  assert.equal(server.doc.nodes.r1.name, 'Кнопка');
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  assert.equal(a.sync.confirmed.seq, 1);
  await a.sync.close();
});

test('sync: подтверждение снимает транзакцию из pending и отдаёт инверсию', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  const r = a.sync.commit([ops.set('r1', 'name', 'Кнопка')]);
  await until(() => a.sync.status.pending === 0);
  const conf = a.log.changes.find((c) => c.reason === 'confirmed');
  assert.ok(conf, 'onChange(confirmed)');
  assert.equal(conf.tx.tx_id, r.tx.tx_id);
  assert.equal(conf.tx.seq, 1);
  assert.equal(conf.same, true, 'сервер применил ровно то, что мы предсказали');
  assert.deepEqual(conf.inverse.map((op) => [op.op, op.value]), [['set', 'Плашка']], 'инверсия — от подтверждённого состояния');
  assert.equal(a.sync.pending.length, 0);
  const st = a.log.statuses[a.log.statuses.length - 1];
  assert.deepEqual({ online: st.online, pending: st.pending, syncing: st.syncing }, { online: true, pending: 0, syncing: false });
  await a.sync.close();
});

test('sync: чужая транзакция применяется, а pending переигрывается поверх неё', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  const b = client(server, 'B');
  await a.sync.open(); await b.sync.open();
  await until(() => a.sync.status.online && b.sync.status.online);
  server.hold = true;
  a.sync.commit([ops.set('r1', 'name', 'От A')]);
  server.hold = false;
  b.sync.commit([ops.set('r1', 'fill', '#ff0000')]);
  await until(() => a.log.changes.some((c) => c.reason === 'remote'), 'A получил чужую');
  const remote = a.log.changes.find((c) => c.reason === 'remote');
  assert.equal(remote.tx.client, 'B');
  assert.equal(a.sync.view.nodes.r1.fill, '#ff0000', 'чужая правка в view');
  assert.equal(a.sync.view.nodes.r1.name, 'От A', 'своя ожидающая — поверх неё');
  assert.equal(a.sync.confirmed.doc.nodes.r1.name, 'Плашка', 'confirmed без своей ожидающей');
  assert.equal(a.sync.status.pending, 1);
  server.release();
  await until(() => a.sync.status.pending === 0 && b.sync.confirmed.seq === 2, 'обе зафиксированы');
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  assert.equal(hashDoc(b.sync.view), hashDoc(server.doc));
  assert.equal(b.sync.view.nodes.r1.name, 'От A');
  await a.sync.close(); await b.sync.close();
});

test('sync: dropped своей транзакции доходит в onDropped, view пересчитан по применённой форме', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.hold = true;
  a.sync.commit([ops.set('r1', 'name', 'Поздно'), ops.set('ab', 'name', 'Доска 2')]);
  // кто-то успел удалить r1 раньше, чем сервер увидел нашу правку
  server.commit({ tx_id: 'tx_other', base_seq: 1, ops: [ops.remove('r1')], engine: ENGINE_VERSION, client: 'Z' });
  await until(() => a.sync.confirmed.seq === 1, 'чужое удаление дошло');
  assert.equal(a.sync.view.nodes.r1, undefined, 'локальный прогноз: set по удалённому отброшен');
  assert.equal(a.sync.view.nodes.ab.name, 'Доска 2');
  server.release();
  await until(() => a.sync.status.pending === 0);
  assert.equal(a.log.dropped.length, 1);
  assert.equal(a.log.dropped[0].dropped[0].reason, 'removed');
  assert.equal(a.log.dropped[0].dropped[0].index, 0);
  assert.equal(a.log.dropped[0].ops.length, 1, 'в журнале — применённая форма');
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  await a.sync.close();
});

test('sync: локальный прогноз dropped при commit — узел уже удалён', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  a.sync.commit([ops.remove('r1')]);
  const r = a.sync.commit([ops.set('r1', 'name', 'Нет такого')]);
  assert.equal(r.tx, null, 'транзакция без применимых операций не заводится');
  assert.equal(r.dropped[0].reason, 'removed');
  await until(() => a.sync.status.pending === 0);
  assert.equal(server.log.length, 1);
  await a.sync.close();
});

test('sync: обрыв — правки копятся, журнал пишется, после open() с тем же storage очередь досылается', async () => {
  const server = new FakeServer(seedDoc());
  const storage = memoryStorage();
  const a = client(server, 'A', { storage });
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.down = true;
  server.dropAll();
  await until(() => !a.sync.status.online, 'офлайн');
  a.sync.commit([ops.set('r1', 'name', 'Офлайн 1')]);
  a.sync.commit([ops.set('r1', 'fill', '#00ff00')]);
  assert.equal(a.sync.status.pending, 2);
  const st = a.log.statuses[a.log.statuses.length - 1];
  assert.deepEqual({ online: st.online, pending: st.pending }, { online: false, pending: 2 });
  await until(() => storage.map.get('p1') && storage.map.get('p1').pending.length === 2, 'журнал записан (≤200 мс)');
  const rec = storage.map.get('p1');
  assert.equal(rec.seq, 0);
  assert.equal(rec.clientId, 'A');
  assert.equal(rec.doc.nodes.r1.name, 'Плашка', 'в журнале confirmed, а не view');
  await a.sync.close();

  // «перезагрузка вкладки»: новая реплика на том же журнале, сервер вернулся
  server.down = false;
  const a2 = client(server, 'A', { storage });
  await a2.sync.open();
  const opened = a2.log.changes[0];
  assert.equal(opened.reason, 'open');
  assert.equal(opened.from, 'local');
  assert.equal(a2.sync.view.nodes.r1.name, 'Офлайн 1', 'view из журнала сразу, до сокета');
  assert.equal(a2.sync.status.pending, 2);
  await until(() => a2.sync.status.pending === 0, 'очередь дослана');
  assert.equal(server.log.length, 2);
  assert.equal(server.log[0].ops[0].value, 'Офлайн 1');
  assert.equal(hashDoc(a2.sync.view), hashDoc(server.doc));
  assert.equal(a2.sync.confirmed.seq, 2);
  await a2.sync.close();
});

test('sync: gone — снимок становится confirmed, очередь переигрывается поверх', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.down = true;
  server.dropAll();
  await until(() => !a.sync.status.online);
  // пока A не в сети: чужие правки, снимок, хвост ушёл в холод
  server.commit({ tx_id: 'tx_z1', base_seq: 0, ops: [ops.set('ab', 'name', 'Чужая доска')], engine: ENGINE_VERSION, client: 'Z' });
  server.commit({ tx_id: 'tx_z2', base_seq: 1, ops: [ops.create({ type: 'rect', id: 'r2', name: 'Второй', parent: 'ab', radius: 0, fill: '#000000', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } })], engine: ENGINE_VERSION, client: 'Z' });
  server.forget();
  a.sync.commit([ops.set('r1', 'name', 'Своё')]);
  server.down = false;
  a.sync.reconnect();
  await until(() => a.log.gone.length === 1, 'gone');
  await until(() => a.sync.status.pending === 0, 'своя дослана поверх снимка');
  assert.equal(a.sync.confirmed.seq, 3);
  assert.equal(a.sync.view.nodes.ab.name, 'Чужая доска');
  assert.ok(a.sync.view.nodes.r2);
  assert.equal(a.sync.view.nodes.r1.name, 'Своё');
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  assert.ok(a.log.changes.some((c) => c.reason === 'gone'));
  await a.sync.close();
});

test('sync: undo_of / redo_of и author уходят в транзакции', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  const r1 = a.sync.commit([ops.set('r1', 'name', 'Раз')], { title: 'Переименовать' });
  const r2 = a.sync.commit([ops.set('r1', 'name', 'Плашка')], { undo_of: r1.tx.tx_id, title: 'Отмена' });
  const r3 = a.sync.commit([ops.set('r1', 'name', 'Раз')], { redo_of: r1.tx.tx_id, author_kind: 'agent' });
  await until(() => a.sync.status.pending === 0);
  assert.equal(server.log[1].undo_of, r1.tx.tx_id);
  assert.equal(server.log[1].tx_id, r2.tx.tx_id);
  assert.equal(server.log[2].redo_of, r1.tx.tx_id);
  assert.equal(server.log[2].author_kind, 'agent');
  assert.equal(server.log[0].author_kind, 'human');
  assert.equal(server.log[0].author, 'Имя A');
  assert.equal(server.log[0].client, 'A');
  assert.equal(server.log[0].title, 'Переименовать');
  assert.equal(r3.tx.base_seq, 0, 'база — подтверждённая голова, а не оптимистичная');
  await a.sync.close();
});

test('sync: идемпотентность — дубликат по tx_id даёт одно подтверждение и одну запись', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.hold = true;
  const r = a.sync.commit([ops.set('r1', 'name', 'Дважды')]);
  // сокет рвётся сразу после отправки: сервер транзакцию получил, а подтверждение не дошло
  server.dropAll();
  await until(() => !a.sync.status.online);
  server.release();
  assert.equal(server.log.length, 1);
  assert.equal(a.sync.status.pending, 1, 'клиент о фиксации не знает');
  // переподключение: pending досылается с начала — сервер отдаёт сохранённое
  await until(() => a.sync.status.pending === 0, 'подтверждение после переподключения');
  await tick(30);
  assert.equal(server.received.filter((id) => id === r.tx.tx_id).length, 2, 'сервер видел tx_id дважды');
  assert.equal(server.log.length, 1, 'а записал один раз');
  assert.equal(a.log.changes.filter((c) => c.reason === 'confirmed').length, 1, 'подтверждение одно');
  assert.equal(a.sync.confirmed.seq, 1);
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  await a.sync.close();
});

test('sync: без локальной копии — снимок с сервера, потом сокет; проекта нет — onError(not-found)', async () => {
  const server = new FakeServer(seedDoc());
  server.commit({ tx_id: 'tx_z1', base_seq: 0, ops: [ops.set('ab', 'name', 'Хвост')], engine: ENGINE_VERSION, client: 'Z' });
  const a = client(server, 'A');
  await a.sync.open();
  assert.equal(a.log.changes[0].reason, 'open');
  assert.equal(a.log.changes[0].from, 'server');
  assert.equal(a.sync.view.nodes.ab.name, 'Хвост', 'снимок + хвост');
  assert.equal(a.sync.confirmed.seq, 1);
  await until(() => a.sync.status.online);
  await a.sync.close();

  const missing = createSync({
    core, baseUrl: 'http://test', projectId: 'нет-такого', clientId: 'B', storage: memoryStorage(),
    WebSocketImpl: server.socketClass(), fetchImpl: server.fetch, reconnectMin: 5, reconnectMax: 10,
    onError: (e) => missingErrors.push(e),
  });
  const missingErrors = [];
  const v = await missing.open();
  assert.equal(v, null);
  assert.equal(missingErrors[0].code, 'not-found');
  await missing.close();
});

test('sync: присутствие — чужие выделения приходят по клиенту, уход убирает', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  const b = client(server, 'B');
  await a.sync.open(); await b.sync.open();
  await until(() => a.sync.status.online && b.sync.status.online);
  // при подключении каждый объявляет себя пустым выделением — так о нём узнают остальные
  await until(() => a.log.presence.some((l) => l.some((p) => p.client === 'B')), 'B объявился у A');
  await until(() => b.log.presence.some((l) => l.some((p) => p.client === 'A')), 'A ответил B своим присутствием');
  b.sync.presence({ selection: ['r1'], board: 'ab' });
  const last = () => a.log.presence[a.log.presence.length - 1];
  await until(() => last().length === 1 && last()[0].selection.length === 1, 'выделение B у A');
  const seen = last()[0];
  assert.equal(seen.client, 'B');
  assert.equal(seen.author, 'Имя B');
  assert.deepEqual(seen.selection, ['r1']);
  assert.equal(seen.board, 'ab');
  await b.sync.close();
  await until(() => a.log.presence[a.log.presence.length - 1].length === 0, 'left');
  await a.sync.close();
});

test('sync: сходимость — два клиента, встречные правки, одинаковый документ', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  const b = client(server, 'B');
  await a.sync.open(); await b.sync.open();
  await until(() => a.sync.status.online && b.sync.status.online);
  server.hold = true;
  a.sync.commit([ops.create({ type: 'rect', id: 'ra', name: 'A', parent: 'ab', radius: 0, fill: '#111111', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } }, 0)]);
  b.sync.commit([ops.remove('r1')]);
  a.sync.commit([ops.set('r1', 'name', 'A после')]);
  b.sync.commit([ops.create({ type: 'rect', id: 'rb', name: 'B', parent: 'ab', radius: 0, fill: '#222222', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } }, 0)]);
  server.release();
  await until(() => a.sync.status.pending === 0 && b.sync.status.pending === 0 && a.sync.confirmed.seq === 4 && b.sync.confirmed.seq === 4, 'всё зафиксировано');
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  assert.equal(hashDoc(b.sync.view), hashDoc(server.doc));
  assert.deepEqual(server.doc.nodes.ab.children, ['rb', 'ra']);
  assert.equal(a.log.dropped.length, 1, 'set по удалённому r1 отброшен, автору сказано');
  await a.sync.close(); await b.sync.close();
});

test('sync: extra оболочки пишется в журнал и возвращается при открытии', async () => {
  const server = new FakeServer(seedDoc());
  const storage = memoryStorage();
  const a = client(server, 'A', { storage, opts: { extra: () => ({ chat: ['привет'] }) } });
  await a.sync.open();
  await until(() => a.sync.status.online);
  a.sync.commit([ops.set('r1', 'name', 'Журнал')]);
  await until(() => a.sync.status.pending === 0);
  await a.sync.close();
  assert.deepEqual(storage.map.get('p1').extra, { chat: ['привет'] });
  const a2 = client(server, 'A', { storage });
  await a2.sync.open();
  assert.deepEqual(a2.log.changes[0].extra, { chat: ['привет'] });
  assert.deepEqual(a2.sync.extra, { chat: ['привет'] });
  await a2.sync.close();
});

test('sync: open() без сети — журнал есть → view из журнала сразу, status.online=false; сервер вернулся → очередь дошла', async () => {
  const server = new FakeServer(seedDoc());
  const storage = memoryStorage();
  // прошлый сеанс: правка ушла в очередь, журнал записан, вкладка закрыта
  const a = client(server, 'A', { storage });
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.down = true;
  server.dropAll();
  await until(() => !a.sync.status.online);
  a.sync.commit([ops.set('r1', 'name', 'Из журнала')]);
  await a.sync.close();
  assert.equal(storage.map.get('p1').pending.length, 1);

  // новый сеанс без сети: сервер молчит и на HTTP, и на сокете
  const a2 = client(server, 'A', { storage });
  const v = await a2.sync.open();
  assert.ok(v, 'view есть без единого ответа сервера');
  assert.equal(a2.log.changes[0].reason, 'open');
  assert.equal(a2.log.changes[0].from, 'local');
  assert.equal(a2.sync.view.nodes.r1.name, 'Из журнала', 'очередь переиграна поверх confirmed');
  await tick(40);
  const st = a2.sync.status;
  assert.equal(st.online, false);
  assert.equal(st.pending, 1);
  assert.equal(st.syncing, false, 'без живого сокета «синхронизации» нет');
  assert.equal(st.error, null, 'локальная копия есть — это не «недоступен без копии»');
  // сервер вернулся: переподключение по паузе, очередь досылается
  server.down = false;
  await until(() => a2.sync.status.online && a2.sync.status.pending === 0, 'дослано после возвращения сервера');
  assert.equal(server.doc.nodes.r1.name, 'Из журнала');
  assert.equal(hashDoc(a2.sync.view), hashDoc(server.doc));
  await a2.sync.close();
});

test('sync: open() без сети и без журнала — status.error=unreachable, снимок приходит, когда сервер появился', async () => {
  const server = new FakeServer(seedDoc());
  server.down = true;
  const a = client(server, 'A');
  const opening = a.sync.open();
  await until(() => a.log.statuses.some((s) => s.error === 'unreachable'), 'статус «недоступен»');
  assert.equal(a.sync.view, null, 'показывать нечего — и view нет');
  server.down = false;
  a.sync.reconnect();   // «Повторить сейчас» будит ожидание раньше паузы
  const v = await opening;
  assert.ok(v && v.nodes.r1);
  assert.equal(a.log.changes[0].from, 'server');
  await until(() => a.sync.status.online);
  assert.equal(a.sync.status.error, null);
  await a.sync.close();
});

test('sync: потеря сокета обнуляет чужое присутствие, «в сети» — только после hello', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  const b = client(server, 'B');
  await a.sync.open(); await b.sync.open();
  await until(() => a.sync.status.online && a.log.presence.some((l) => l.some((p) => p.client === 'B')));
  a.sync.offline();
  const last = a.log.presence[a.log.presence.length - 1];
  assert.deepEqual(last, [], 'присутствие протухло вместе с сокетом');
  assert.equal(a.sync.status.online, false);
  await until(() => a.sync.status.online, 'переподключился');
  await a.sync.close(); await b.sync.close();
});

/* ------------------------------ круг 23 (SPEC §9.8) ------------------------------ */

test('sync: droppedLine — одна строка; запись {more:N} не причина, но прибавляет к счёту', () => {
  assert.equal(droppedLine([{ index: 0, reason: 'removed' }, { index: 1, reason: 'removed' }]), '2 правки не применились: узел уже удалён');
  const many = [...Array.from({ length: 50 }, (_, i) => ({ index: i, reason: i % 2 ? 'cycle' : 'removed' })), { more: 13 }];
  assert.equal(droppedLine(many), '63 правки не применились: узел уже удалён, перемещение создало бы цикл');
  assert.equal(droppedLine([{ index: 0, reason: 'invalid', limit: 'doc_nodes' }]), '1 правка не применилась: документ упёрся в предел числа узлов');
  assert.equal(droppedLine([{ index: 0, reason: 'странное' }, { more: 4 }]), '5 правок не применились: правка не подошла к документу');
  assert.equal(droppedLine(null), '0 правок не применились');
});

test('sync: statusLine и status.label — «в сети · всё сохранено» / «не в сети · N правок ждут» / «синхронизация…»', async () => {
  assert.equal(statusLine({ online: true, pending: 0, syncing: false }), 'в сети · всё сохранено');
  assert.equal(statusLine({ online: false, pending: 3, syncing: false }), 'не в сети · 3 правки ждут');
  assert.equal(statusLine({ online: false, pending: 1, syncing: false }), 'не в сети · 1 правка ждёт');
  assert.equal(statusLine({ online: false, pending: 5, syncing: false }), 'не в сети · 5 правок ждут');
  assert.equal(statusLine({ online: false, pending: 0, syncing: false }), 'не в сети');
  assert.equal(statusLine({ online: true, pending: 1, syncing: true }), 'синхронизация…');
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online && !a.sync.status.syncing);
  assert.equal(a.sync.status.label, 'в сети · всё сохранено');
  assert.equal(a.log.statuses[a.log.statuses.length - 1].label, 'в сети · всё сохранено');
  await a.sync.close();
});

test('sync: LIMITS — больше операций, чем примет сервер, транзакция не заводится; onError too_large', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  const r = a.sync.commit(Array.from({ length: LIMITS.opsPerTx + 1 }, () => ops.set('r1', 'name', 'x')));
  assert.equal(r.tx, null);
  assert.equal(r.dropped.length, LIMITS.opsPerTx + 1);
  assert.equal(r.dropped[0].limit, 'ops_per_tx');
  assert.equal(a.sync.status.pending, 0);
  assert.equal(a.log.errors[0].code, 'too_large');
  const big = a.sync.commit([ops.set('r1', 'name', 'x'.repeat(LIMITS.txBytes))]);
  assert.equal(big.tx, null);
  assert.equal(big.dropped[0].limit, 'tx_bytes');
  assert.equal(a.sync.view.nodes.r1.name, 'Плашка', 'view не тронут');
  await a.sync.close();
});

test('sync: повторяемая ошибка сервера (503 unavailable) не снимает транзакцию — она уходит снова', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.failNext = { code: 'unavailable', message: 'хранилище недоступно', retryable: true, retry_after: 0.02 };
  const r = a.sync.commit([ops.set('r1', 'name', 'Переживёт')]);
  await until(() => a.sync.status.pending === 0, 'дослана после паузы');
  assert.equal(server.received.filter((id) => id === r.tx.tx_id).length, 2);
  assert.equal(server.doc.nodes.r1.name, 'Переживёт');
  assert.equal(a.log.errors.length, 0, 'человеку не о чем сообщать');
  // неповторяемая — снимается, как раньше
  server.failNext = { code: 'bad_request', message: 'форма', retryable: false };
  const bad = a.sync.commit([ops.set('r1', 'name', 'Не возьмут')]);
  await until(() => a.sync.status.pending === 0);
  assert.equal(a.log.errors[0].tx.tx_id, bad.tx.tx_id);
  assert.equal(a.sync.view.nodes.r1.name, 'Переживёт');
  await a.sync.close();
});

test('sync: ack — своя транзакция уже в снимке (gone), повтор получает ack и уходит из очереди', async () => {
  const server = new FakeServer(seedDoc());
  const a = client(server, 'A');
  await a.sync.open();
  await until(() => a.sync.status.online);
  server.hold = true;
  const r = a.sync.commit([ops.set('r1', 'name', 'В снимке')]);
  server.down = true;
  server.dropAll();
  await until(() => !a.sync.status.online);
  server.release();          // записана, а подтверждение не дошло
  server.forget();           // и ушла в снимок: хвост с seq 0 не догнать
  server.down = false;
  a.sync.reconnect();
  await until(() => a.log.gone.length === 1, 'gone');
  await until(() => a.sync.status.pending === 0, 'ack снял её с очереди');
  assert.ok(a.log.changes.some((c) => c.reason === 'ack'));
  assert.equal(server.log.length, 1, 'вторая запись не появилась');
  assert.equal(a.sync.confirmed.seq, 1);
  assert.equal(hashDoc(a.sync.view), hashDoc(server.doc));
  assert.equal(server.received.filter((id) => id === r.tx.tx_id).length, 2);
  await a.sync.close();
});

test('sync: 503 с Retry-After при открытии — ждёт срок и повторяет, а не долбит сервер', async () => {
  const server = new FakeServer(seedDoc());
  server.busy = 2;
  const a = client(server, 'A');
  const t0 = Date.now();
  const v = await a.sync.open();
  assert.ok(v && v.nodes.r1);
  assert.ok(Date.now() - t0 >= 150, 'дважды подождал Retry-After (0.08 с)');
  const gets = server.httpCalls.filter((c) => c.path.startsWith('/api/projects/p1') && !c.path.includes('/ops'));
  assert.equal(gets.length, 3);
  for (let i = 1; i < gets.length; i++) assert.ok(gets[i].at - gets[i - 1].at >= 75, 'пауза не меньше Retry-After');
  await a.sync.close();
});
