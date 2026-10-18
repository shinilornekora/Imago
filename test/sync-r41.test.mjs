/**
 * Круг 41 (SHELL): реплика и версия движка сервера.
 *  • арх. Н1 — скользящее обновление: реплика попала на экземпляр прежней версии (hello с
 *    движком старее), правки ждут; экземпляр обновился — перепроверка /api/health видит наш
 *    движок, сокет переподключается, hello с нашим движком снимает отказ, очередь уходит.
 *  • UX Д7 — проект записан движком новее экземпляра: 503 `cause:'engine'` при открытии и по
 *    сокету — «сервер ещё на прежней версии — правки ждут», а не вечное «подключаюсь…» и не
 *    «сервер недоступен»; сервер обновился — проект открывается сам.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { createSync, memoryStorage, engineWords } from '../src/sync.js';

const OWN = core.ENGINE_VERSION;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(10); }
  assert.fail(`не дождались: ${what}`);
}

/** Сервис документов в памяти, у которого можно сменить версию движка «на лету». */
function stand({ engine = OWN, stale = false } = {}) {
  const srv = { engine, stale, seq: 0, doc: core.createDoc('empty'), sockets: new Set(), received: [], health: 0, log: [], down: false };
  srv.fetch = async (url) => {
    const u = new URL(url, 'http://t');
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
    if (u.pathname === '/api/health') { srv.health += 1; return json(200, { ok: true, engine: srv.engine, storage: 'up' }); }
    if (/\/api\/projects\/p1$/.test(u.pathname)) {
      if (srv.stale && srv.engine < OWN) {
        return json(503, { error: true, code: 'unavailable', retryable: true, message: 'проект записан более новой версией редактора',
          detail: { cause: 'engine', engine: srv.engine, found: OWN } });
      }
      return json(200, { id: 'p1', name: 'Т', kind: 'design', head_seq: srv.seq, snapshot: { seq: srv.seq, doc: srv.doc, engine: OWN }, tail: [] });
    }
    if (/\/ops$/.test(u.pathname)) return json(200, { head_seq: srv.seq, txs: [] });
    return json(404, {});
  };
  srv.WS = class {
    constructor(url) {
      this.url = url; this.readyState = 0;
      setTimeout(() => {
        if (srv.down) { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); return; }
        this.readyState = 1; srv.sockets.add(this);
        if (this.onopen) this.onopen({});
        this.deliver({ type: 'hello', project: 'p1', head_seq: srv.seq, engine: srv.engine });
        const since = Number(new URL(url).searchParams.get('since') || 0);
        for (const c of srv.log) if (c.seq > since) this.deliver({ type: 'tx', tx: c });
        if (srv.stale && srv.engine < OWN) {
          this.deliver({ type: 'error', error: true, code: 'unavailable', retryable: true, message: 'проект записан более новой версией',
            detail: { cause: 'engine', engine: srv.engine, found: OWN } });
          setTimeout(() => this.close(4503), 5);
        }
      }, 0);
    }
    deliver(m) { setTimeout(() => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }, 0); }
    send(data) {
      const m = JSON.parse(data);
      if (m.type !== 'tx') return;
      srv.received.push(m.tx.tx_id);
      if (m.tx.engine !== srv.engine) {
        this.deliver({ type: 'error', error: true, code: 'engine', retryable: false, tx_id: m.tx.tx_id, engine: srv.engine, detail: { engine: srv.engine } });
        return;
      }
      const r = core.applyOps(srv.doc, m.tx.ops);
      srv.doc = r.doc;
      const c = { ...m.tx, seq: ++srv.seq, dropped: [], created_at: new Date().toISOString() };
      srv.log.push(c);
      for (const s of srv.sockets) s.deliver({ type: 'tx', tx: c });
    }
    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3; srv.sockets.delete(this);
      if (this.onclose) this.onclose({ code });
    }
  };
  return srv;
}

function replica(srv, extra = {}) {
  const seen = [];
  const errors = [];
  const sync = createSync({
    core, baseUrl: 'http://t', projectId: 'p1', clientId: 'c_r41', storage: memoryStorage(),
    WebSocketImpl: srv.WS, fetchImpl: srv.fetch, idleHealthMs: 0, reconnectMin: 20, reconnectMax: 60,
    engineRecheckMs: 40, onStatus: (s) => seen.push(s), onError: (e) => errors.push(e), ...extra,
  });
  return { sync, seen, errors };
}

const addRect = (doc, id) => [core.ops.create({ type: 'rect', id, name: 'Квадрат', parent: core.artboards(doc)[0] ? core.artboards(doc)[0].id : doc.root, size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } })];

test('r41 (арх. Н1): сервер старее — правки ждут; экземпляр обновился — очередь уходит без перезагрузки', { skip: OWN < 2 && 'нужен движок ≥ 2' }, async () => {
  const srv = stand({ engine: OWN - 1 });
  const { sync, errors } = replica(srv);
  await sync.open();
  await until(() => sync.status.error === 'engine', 'отказ по версии');
  assert.equal(sync.status.label, 'сервер ещё на прежней версии редактора', 'ждать пока нечему');
  assert.equal(errors.filter((e) => e.code === 'engine').length, 1, 'оболочке сказано один раз');
  const r = sync.commit(addRect(sync.view, 'r_wait'), { title: 'Квадрат' });
  assert.ok(r.tx);
  await tick(80);
  assert.equal(sync.pending.length, 1, 'правка ждёт');
  assert.equal(sync.status.label, engineWords(OWN - 1, OWN).status);
  assert.match(sync.status.label, /сервер ещё на прежней версии — правки ждут/);
  assert.deepEqual(srv.received, [], 'прежнему экземпляру её не шлём');
  // экземпляр обновили: тот же адрес, наш движок
  srv.engine = OWN;
  await until(() => sync.status.error !== 'engine', 'отказ по версии снят', 3000);
  await until(() => sync.pending.length === 0, 'очередь доставлена', 3000);
  assert.ok(srv.health >= 1, 'обновление замечено по /api/health');
  assert.ok(srv.doc.nodes.r_wait, 'правка на сервере');
  await until(() => sync.status.label === 'в сети · всё сохранено', 'статус «в сети · всё сохранено»');
  await sync.close();
});

test('r41 (арх. Н1): 426 на правку от прежнего экземпляра — правка в очереди, не «в полёте»; после обновления уходит', { skip: OWN < 2 && 'нужен движок ≥ 2' }, async () => {
  // hello без версии (прежний Hub), а запись отказывает 426
  const srv = stand({ engine: OWN - 1 });
  const WS0 = srv.WS;
  srv.oldHub = true;
  srv.WS = class extends WS0 {
    deliver(m) { if (m.type === 'hello' && srv.oldHub) m = { ...m, engine: undefined }; super.deliver(m); }
  };
  const { sync } = replica(srv);
  await sync.open();
  await until(() => sync.status.online, 'в сети');
  sync.commit(addRect(sync.view, 'r_426'), { title: 'Квадрат' });
  await until(() => sync.status.error === 'engine', 'отказ 426');
  assert.equal(sync.pending.length, 1);
  srv.engine = OWN;
  srv.oldHub = false;
  for (const s of [...srv.sockets]) s.close();   // экземпляр перезапущен новым
  await until(() => sync.pending.length === 0, 'очередь доставлена после обновления', 3000);
  assert.ok(srv.doc.nodes.r_426);
  await sync.close();
});

test('r41 (UX Д7): проект записан движком новее экземпляра — «сервер ещё на прежней версии», не вечное «подключаюсь…»', { skip: OWN < 2 && 'нужен движок ≥ 2' }, async () => {
  const srv = stand({ engine: OWN - 1, stale: true });
  const { sync, seen } = replica(srv);
  const opening = sync.open();
  await until(() => sync.status.error === 'engine', 'отказ по версии при открытии');
  assert.equal(sync.status.connecting, undefined, 'не «подключаюсь…»');
  assert.match(sync.status.label, /сервер ещё на прежней версии/);
  assert.ok(!seen.some((s) => s.error === 'unreachable'), 'не «сервер недоступен»');
  // клиент старее проекта — «вышла новая версия»
  assert.equal(engineWords(OWN + 1, OWN).newer, true);
  // экземпляр обновили — проект открывается сам
  srv.engine = OWN;
  srv.stale = false;
  await until(() => sync.status.online && !sync.status.error, 'проект открыт', 3000);
  await opening;
  assert.ok(sync.view);
  await sync.close();
});

test('r41 (UX): догон после разрыва — промежуточные транзакции помечены `more`, последняя до головы — нет', async () => {
  const srv = stand({ engine: OWN });
  const changes = [];
  const { sync } = replica(srv, { onChange: (view, info) => { if (info.reason === 'remote') changes.push({ seq: info.tx.seq, more: info.more === true }); } });
  await sync.open();
  await until(() => sync.status.online, 'в сети');
  // связь пропала; соавтор тем временем сделал три правки
  srv.down = true;
  for (const s of [...srv.sockets]) s.close();
  await until(() => !sync.status.online, 'не в сети');
  for (let k = 0; k < 3; k++) {
    const d = srv.doc;
    const ops = [core.ops.create({ type: 'rect', id: `r_far${k}`, name: `Карточка ${k}`, parent: d.root, pos: { x: 0, y: 0 }, size: { w: { mode: 'fixed', value: 5 }, h: { mode: 'fixed', value: 5 } } })];
    srv.doc = core.applyOps(d, ops).doc;
    srv.log.push({ tx_id: `tx_far${k}`, client: 'c_other', author: 'Аня', ops, seq: ++srv.seq, dropped: [], base_seq: srv.seq - 1, engine: OWN, created_at: new Date().toISOString() });
  }
  srv.down = false;
  sync.reconnect();
  await until(() => changes.length >= 3, 'догон', 3000);
  assert.deepEqual(changes.map((c) => [c.seq, c.more]), [[1, true], [2, true], [3, false]]);
  assert.ok(sync.view.nodes.r_far2);
  await sync.close();
});
