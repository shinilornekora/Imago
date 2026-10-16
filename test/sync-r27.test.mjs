/**
 * Реплика (src/sync.js), круг 27: сокет и HTTP «по сценарию» — тест сам решает, какой
 * кадр и когда придёт. Догон и ack (мутант `!catchingUp`), пропавший проект (I3),
 * живое имя (I4), base_seq переигрываемой (I5), надгробия снимка v2/v1/null (I1),
 * журнал в двух записях (документ реже очереди, хвост подтверждённых).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { createSync, memoryStorage, WIRE, statusLine } from '../src/sync.js';

const { createDoc, applyOps, ops, hashDoc, ENGINE_VERSION: E } = core;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'условие', ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(5); }
  assert.fail(`не дождались: ${what}`);
}

const rect = (id, parent, name = id) => ({ type: 'rect', id, name, parent, radius: 0, fill: '#cccccc', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } });
function seedDoc() {
  let doc = createDoc('empty');
  const push = (list) => { const r = applyOps(doc, list); assert.equal(r.error, undefined); doc = r.doc; };
  push([ops.create({
    type: 'frame', id: 'ab', name: 'Доска', parent: doc.root, children: [], pos: { x: 0, y: 0 }, radius: 0,
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } },
    layout: { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'start', justify: 'start', wrap: false }, fill: '#ffffff',
  })]);
  push([ops.create(rect('r1', 'ab', 'Плашка'))]);
  return doc;
}
const apply = (doc, list) => { const r = applyOps(doc, list); assert.equal(r.error, undefined); return r.doc; };

/** Сокет и fetch по сценарию: onOpen(ws) — что сказать при открытии; fetch — обработчик теста. */
function harness() {
  const h = { sockets: [], sent: [], onOpen: null, onSend: null, fetch: null, fetches: [] };
  h.WS = class {
    constructor(url) {
      this.url = new URL(url); this.readyState = 0; this.sent = [];
      h.sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        if (h.onOpen) h.onOpen(this);
      }, 0);
    }
    in(msg) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
    send(d) { const m = JSON.parse(d); this.sent.push(m); h.sent.push(m); if (h.onSend) h.onSend(this, m); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({ code }); }
  };
  h.fetchImpl = async (url) => {
    const u = new URL(url);
    h.fetches.push(u.pathname + u.search);
    const r = h.fetch ? await h.fetch(u) : { status: 404, body: {} };
    return { ok: r.status < 300, status: r.status, json: async () => r.body, headers: { get: () => null } };
  };
  return h;
}

function replica(h, extra = {}) {
  const log = { changes: [], errors: [], projects: [], statuses: [] };
  const sync = createSync({
    core, baseUrl: 'http://test', projectId: 'p1', clientId: 'A', author: 'Аня',
    storage: extra.storage || memoryStorage(), WebSocketImpl: h.WS, fetchImpl: h.fetchImpl,
    reconnectMin: 5, reconnectMax: 20, epochReopenMs: 5,
    onChange: (view, info) => log.changes.push({ ...info, view }),
    onError: (e) => log.errors.push(e),
    onProject: (p) => log.projects.push(p),
    onStatus: (s) => log.statuses.push(s),
    ...extra.opts,
  });
  return { sync, log };
}

/** Журнал прежнего формата (одна запись с документом) — его реплика обязана читать. */
async function legacyJournal(rec) {
  const st = memoryStorage();
  await st.set('p1', { clientId: 'A', updatedAt: Date.now(), tombstones: [], mine: [], mineEvicted: [], unsaved: [], pending: [], ...rec });
  return st;
}

test('sync r27: ack во время догона не снимает правку с холста — разбирается после догона (мутант !catchingUp)', async () => {
  const doc0 = seedDoc();
  const X = { tx_id: 'tx_X', base_seq: 10, ops: [ops.set('r1', 'name', 'X')], engine: E, client: 'A', author_kind: 'human' };
  const storage = await legacyJournal({ seq: 10, doc: doc0, epoch: 'e1', tip: 'c10', pending: [X] });
  const h = harness();
  let release = null;
  h.fetch = (u) => {
    assert.match(u.pathname, /\/ops$/);
    return new Promise((r) => { release = r; });
  };
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 12, engine: E, epoch: 'e1', tip: 'c10', gone: false });
  const a = replica(h, { storage });
  await a.sync.open();
  await until(() => h.sent.some((m) => m.type === 'tx' && m.tx.tx_id === 'tx_X'), 'X ушла после hello');
  const ws = h.sockets[0];
  // пропуск (11 нет) — догон по HTTP; ответ задерживаем
  ws.in({ type: 'tx', tx: { tx_id: 'tx_f', seq: 12, ops: [ops.set('ab', 'fill', '#000000')], client: 'Z', dropped: [] } });
  await until(() => !!release, 'догон начался');
  // сервер (уже новой истории) говорит: X у него под номером 9 — меньше нашего confirmed (10, прежняя история)
  ws.in({ type: 'ack', tx_id: 'tx_X', seq: 9, existing: true });
  await tick(20);
  assert.equal(a.sync.pending.length, 1, 'пока идёт догон, ack не разобран');
  assert.equal(a.sync.view.nodes.r1.name, 'X');
  // догон: снимок новой эпохи, в нём X уже есть
  const snap = apply(apply(doc0, X.ops), [ops.set('ab', 'fill', '#000000')]);
  release({ status: 410, body: { snapshot: { seq: 12, doc: snap, chain: 'n12', tombstones: { v: 2, parents: {}, seq: {} } }, head_seq: 12, epoch: 'e2' } });
  await until(() => a.sync.pending.length === 0, 'после догона ack разобран — правка снята с очереди');
  for (const c of a.log.changes) assert.equal(c.view.nodes.r1.name, 'X', `правка не мигает (${c.reason})`);
  assert.ok(a.log.changes.some((c) => c.reason === 'ack'));
  assert.equal(a.sync.confirmed.seq, 12);
  assert.equal(a.sync.epoch, 'e2');
  assert.ok(a.sync.mine.some((m) => m.tx_id === 'tx_X' && m.seq === 9));
  await a.sync.close();
});

test('sync r27 (I3): проекта нет на сервере — not_found, очередь цела, view на месте, редкие попытки; вернулся — работа дошла', async () => {
  const doc0 = seedDoc();
  const storage = await legacyJournal({ seq: 3, doc: doc0, epoch: 'e1' });
  const h = harness();
  let mode = 'gone';
  h.onOpen = (ws) => {
    if (mode === 'gone') {
      ws.in({ type: 'error', error: true, code: 'not_found', message: 'проекта больше нет на сервере', retryable: false });
      ws.close(4404);
    } else {
      ws.in({ type: 'hello', head_seq: 3, engine: E, epoch: 'e1', tip: '', gone: false });
    }
  };
  h.onSend = (ws, m) => {
    if (m.type === 'tx' && mode === 'gone') ws.in({ type: 'error', error: true, code: 'not_found', retryable: false, tx_id: m.tx.tx_id });
    if (m.type === 'tx' && mode === 'back') setTimeout(() => ws.in({ type: 'tx', tx: { ...m.tx, seq: 4, dropped: [] } }), 0);
  };
  const a = replica(h, { storage, opts: { notFoundRetryMs: 300 } });
  await a.sync.open();
  const r = a.sync.commit([ops.set('r1', 'name', 'моя работа')]);
  assert.ok(r.tx);
  await until(() => a.sync.status.error === 'not_found', 'статус not_found');
  assert.equal(a.sync.status.label, 'проект не найден на сервере');
  assert.equal(statusLine({ online: false, pending: 1, error: 'not_found' }), 'проект не найден на сервере');
  assert.equal(a.sync.pending.length, 1, 'очередь не снята');
  assert.equal(a.sync.view.nodes.r1.name, 'моя работа', 'view — с работой');
  const n = h.sockets.length;
  await tick(220);
  assert.equal(h.sockets.length, n, 'не долбит сервер: следующая попытка не раньше notFoundRetryMs');
  await until(() => h.sockets.length > n, 'попытка через 300–600 мс', 2000);
  await until(() => a.sync.status.error === 'not_found');
  assert.equal(a.log.errors.filter((e) => e.code === 'not_found').length, 1, 'человеку сказано один раз');
  assert.equal(a.sync.pending.length, 1);
  assert.equal(WIRE.closeNotFound, 4404);
  mode = 'back';
  await until(() => a.sync.status.online && a.sync.pending.length === 0, 'проект вернулся — правка дошла', 3000);
  assert.equal(a.sync.status.error, null);
  await a.sync.close();
});

test('sync r27 (I4): onProject — сводка из hello и из рассылки project; чужой id — мимо', async () => {
  const h = harness();
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E, epoch: 'e1', tip: '', gone: false, project: { id: 'p1', name: 'Лендинг', kind: 'design', head_seq: 0, updated_at: '2026-10-15T00:00:00Z' } });
  const a = replica(h, { storage: await legacyJournal({ seq: 0, doc: seedDoc(), epoch: 'e1' }) });
  await a.sync.open();
  await until(() => a.log.projects.length === 1, 'сводка из hello');
  assert.equal(a.log.projects[0].name, 'Лендинг');
  h.sockets[0].in({ type: 'project', project: { id: 'p1', name: 'Лендинг 2', kind: 'design', head_seq: 0, updated_at: '2026-10-15T00:01:00Z' } });
  h.sockets[0].in({ type: 'project', project: { id: 'другой', name: 'Чужой' } });
  await tick(10);
  assert.deepEqual(a.log.projects.map((p) => p.name), ['Лендинг', 'Лендинг 2']);
  await a.sync.close();
});

test('sync r28 (I4): рассылка project разбирается в любой момент после hello — во время догона, после gone, при правке в полёте, на новом сокете', async () => {
  const doc0 = seedDoc();
  const h = harness();
  let release = null;
  h.fetch = (u) => {
    assert.match(u.pathname, /\/ops$/);
    return new Promise((r) => { release = r; });
  };
  let opened = 0;
  h.onOpen = (ws) => {
    opened += 1;
    ws.in({ type: 'hello', head_seq: 0, engine: E, epoch: 'e1', tip: '', gone: false, project: { id: 'p1', name: 'Имя 0', kind: 'design' } });
  };
  const a = replica(h, { storage: await legacyJournal({ seq: 0, doc: doc0, epoch: 'e1' }) });
  await a.sync.open();
  await until(() => a.log.projects.length === 1, 'сводка из hello');
  const ws = h.sockets[0];
  const names = () => a.log.projects.map((p) => p.name);

  // 1. правка в полёте (подтверждения ещё нет)
  a.sync.commit([ops.set('r1', 'name', 'в полёте')]);
  await until(() => h.sent.some((m) => m.type === 'tx'), 'правка ушла');
  ws.in({ type: 'project', project: { id: 'p1', name: 'Имя 1' } });
  assert.deepEqual(names(), ['Имя 0', 'Имя 1'], 'при правке в полёте');
  const mineTx = h.sent.find((m) => m.type === 'tx').tx;
  ws.in({ type: 'tx', tx: { ...mineTx, seq: 1, dropped: [] } });
  await until(() => a.sync.pending.length === 0, 'подтверждение');

  // 2. во время догона по HTTP (живые транзакции копятся в буфер — project нет)
  ws.in({ type: 'tx', tx: { tx_id: 'tx_f', seq: 3, ops: [ops.set('ab', 'fill', '#000000')], client: 'Z', dropped: [] } });
  await until(() => !!release, 'догон начался');
  ws.in({ type: 'project', project: { id: 'p1', name: 'Имя 2', kind: 'design', head_seq: 3 } });
  assert.deepEqual(names(), ['Имя 0', 'Имя 1', 'Имя 2'], 'во время догона — сразу, не после');
  release({ status: 200, body: { head_seq: 3, epoch: 'e1', tip: '', more: false, txs: [
    { tx_id: 'tx_e', seq: 2, ops: [ops.set('r1', 'name', 'чужое')], client: 'Z', dropped: [] },
    { tx_id: 'tx_f', seq: 3, ops: [ops.set('ab', 'fill', '#000000')], client: 'Z', dropped: [] },
  ] } });
  await until(() => a.sync.confirmed.seq === 3, 'догон закончился');

  // 3. сразу после gone (снимок принят)
  ws.in({ type: 'gone', snapshot: { seq: 5, doc: doc0, chain: 'c5', tombstones: { v: 2, parents: {}, seq: {} } }, head_seq: 5, epoch: 'e1', tip: 'c5' });
  ws.in({ type: 'project', project: { id: 'p1', name: 'Имя 3' } });
  await until(() => a.sync.confirmed.seq === 5, 'снимок');
  assert.equal(names().at(-1), 'Имя 3', 'после gone');

  // 4. разрыв и новый сокет: hello с прежним именем, потом рассылка
  ws.close(1006);
  await until(() => opened === 2 && a.sync.status.online, 'переподключились');
  h.sockets.at(-1).in({ type: 'project', project: { id: 'p1', name: 'Имя 4' } });
  assert.equal(names().at(-1), 'Имя 4', 'на новом сокете');
  // чужой id и мусор — мимо, реплика жива
  h.sockets.at(-1).in({ type: 'project', project: { id: 'другой', name: 'Чужой' } });
  h.sockets.at(-1).in({ type: 'project', project: null });
  h.sockets.at(-1).in({ type: 'project' });
  assert.equal(names().at(-1), 'Имя 4');
  assert.ok(!names().includes('Чужой'));
  assert.equal(a.sync.status.online, true);
  await a.sync.close();
});

test('sync r28: same подтверждения — ленивое и запоминаемое; верно и при предсказанной, и при другой форме; дешевле hashDoc', async () => {
  // документ побольше, чтобы сравнить цену с hashDoc
  let doc0 = seedDoc();
  const many = [];
  for (let i = 0; i < 3000; i++) many.push(ops.create(rect('n' + i, 'ab')));
  doc0 = apply(doc0, many);
  const h = harness();
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E, epoch: 'e1', tip: '', gone: false });
  const infos = [];
  const a = replica(h, { storage: await legacyJournal({ seq: 0, doc: doc0, epoch: 'e1' }), opts: { onChange: (v, info) => { if (info.reason === 'confirmed') infos.push(info); } } });
  await a.sync.open();
  await until(() => a.sync.status.online, 'в сети');
  const ws = h.sockets[0];
  let seq = 0;
  async function roundTrip(name, serverOps) {
    h.sent.length = 0;
    a.sync.commit([ops.set('r1', 'name', name)]);
    await until(() => h.sent.some((m) => m.type === 'tx'), 'ушла ' + name);
    const tx = h.sent.find((m) => m.type === 'tx').tx;
    seq += 1;
    const applied = serverOps ? serverOps(tx) : tx.ops;
    const t0 = performance.now();
    ws.in({ type: 'tx', tx: { ...tx, seq, ops: applied, dropped: applied.length ? [] : [{ index: 0, op: tx.ops[0], reason: 'invalid' }] } });
    const took = performance.now() - t0;
    await until(() => a.sync.pending.length === 0, 'подтверждена');
    return { info: infos.at(-1), took };
  }
  // 1. предсказанная форма — true сразу (обычное свойство)
  const fast = await roundTrip('A');
  assert.equal(Object.getOwnPropertyDescriptor(fast.info, 'same').value, true);
  // 2. форма другая, документ тот же (лишний set тем же значением) — true по сравнению
  const eq = await roundTrip('B', (tx) => [...tx.ops, ops.set('r1', 'fill', '#cccccc')]);
  assert.equal(typeof Object.getOwnPropertyDescriptor(eq.info, 'same').get, 'function', 'не посчитано заранее');
  // 3. сервер отбросил правку — view вернулся к confirmed: same = false
  const diff = await roundTrip('C', () => []);
  assert.equal(diff.info.same, false);
  assert.equal(a.sync.view.nodes.r1.name, 'B');
  assert.equal({ ...diff.info }.same, false, 'перечисляемое: копия оболочки видит его');
  // отложенное сравнение — над теми документами, что были при подтверждении (прочитано
  // только сейчас, после ещё двух подтверждений), и запоминается
  const later = await roundTrip('D', (tx) => [...tx.ops, ops.set('r1', 'fill', '#cccccc')]);
  assert.equal(eq.info.same, true);
  assert.equal(eq.info.same, true, 'запомнено');
  assert.equal(later.info.same, true);
  // цена подтверждения без чтения same — меньше одного hashDoc документа (было два на каждое)
  let th = performance.now();
  for (let i = 0; i < 3; i++) hashDoc(a.sync.view);
  th = (performance.now() - th) / 3;
  const slow = await roundTrip('E', (tx) => [...tx.ops, ops.set('r1', 'fill', '#cccccc')]);
  assert.ok(slow.took < th * 4 + 20, `подтверждение ${slow.took.toFixed(1)} мс при hashDoc ${th.toFixed(1)} мс`);
  await a.sync.close();
});

test('sync r27 (I5): после отката переигрываемая несёт base_seq полученного снимка и replay_of_epoch', async () => {
  const doc0 = seedDoc();
  const X = { tx_id: 'tx_old', base_seq: 4, ops: [ops.set('r1', 'name', 'до отката')], engine: E, client: 'A', author_kind: 'human' };
  const storage = await legacyJournal({ seq: 5, doc: apply(doc0, X.ops), epoch: 'e1', tip: 'c5', mine: [{ tx: X, seq: 5, epoch: 'e1', at: new Date().toISOString(), bytes: 100 }] });
  const h = harness();
  h.onOpen = (ws) => {
    ws.in({ type: 'hello', head_seq: 3, engine: E, epoch: 'e2', tip: 'n3', gone: true });
    ws.in({ type: 'gone', snapshot: { seq: 3, doc: doc0, chain: 'n3', tombstones: { v: 2, parents: {}, seq: {} } }, head_seq: 3, epoch: 'e2' });
  };
  const a = replica(h, { storage });
  await a.sync.open();
  await until(() => h.sent.some((m) => m.type === 'tx'), 'переигрываемая ушла');
  const sent = h.sent.find((m) => m.type === 'tx').tx;
  assert.equal(sent.tx_id, 'tx_old');
  assert.equal(sent.base_seq, 3, 'base_seq — номер снимка новой эпохи');
  assert.equal(sent.replay_of_epoch, 'e1');
  assert.equal(a.sync.view.nodes.r1.name, 'до отката');
  await a.sync.close();
});

/** Снимок с надгробиями в данной форме; реплика сама видела удаление r1 до снимка. */
async function tombCase(tombstones) {
  const doc0 = seedDoc();
  const noR1 = apply(doc0, [ops.remove('r1')]);
  const storage = await legacyJournal({ seq: 1, doc: noR1, epoch: 'e1', tip: 'c1', tombstones: [['r1', 'ab']] });
  const h = harness();
  h.onOpen = (ws) => {
    ws.in({ type: 'hello', head_seq: 2, engine: E, epoch: 'e1', tip: 'c2', gone: true });
    ws.in({ type: 'gone', snapshot: { seq: 2, doc: apply(noR1, [ops.set('ab', 'name', 'Б')]), chain: 'c2', tombstones }, head_seq: 2, epoch: 'e1' });
  };
  const a = replica(h, { storage });
  await a.sync.open();
  await until(() => a.log.changes.some((c) => c.reason === 'gone'), 'снимок');
  const r = a.sync.commit([ops.create(rect('kid', 'r1'))]);
  await a.sync.close();
  return r;
}

test('sync r27 (I1): надгробия снимка v2 / v1 / null — реплика понимает все; null не сбрасывает свои', async () => {
  for (const [name, t] of [['v2', { v: 2, parents: { r1: 'ab' }, seq: { r1: 1 } }], ['v1', { r1: 'ab' }], ['null', null], ['нет поля', undefined]]) {
    const r = await tombCase(t);
    assert.deepEqual(r.dropped, [], name);
    assert.equal(r.applied[0].node.parent, 'ab', `${name}: create в удалённого родителя — к живому предку`);
  }
  // v2 без r1 (сервер проредил) — надгробия заменены снимком: orphan, как сделает сервер
  const pruned = await tombCase({ v: 2, parents: {}, seq: {} });
  assert.equal(pruned.dropped[0].reason, 'orphan');
  // неизвестная версия — как null: свои остаются
  const future = await tombCase({ v: 3, whatever: true });
  assert.equal(future.applied[0].node.parent, 'ab');
});

/** memoryStorage со счётчиком записей документа (structuredClone большого документа — дорогая часть). */
function countingStorage() {
  const st = memoryStorage();
  const counts = { doc: 0, queue: 0 };
  const note = (k) => { if (k.endsWith('#doc')) counts.doc += 1; else counts.queue += 1; };
  const set0 = st.set;
  const many0 = st.setMany;
  st.set = async (k, v) => { note(k); return set0(k, v); };
  st.setMany = async (entries) => { for (const [k] of entries) note(k); return many0(entries); };
  st.counts = counts;
  return st;
}

test('sync r27: журнал — очередь пишется сразу, документ — не чаще раза в 1,5 с; хвост подтверждённых восстанавливает confirmed', async () => {
  const doc0 = seedDoc();
  const storage = countingStorage();
  const h = harness();
  h.fetch = async (u) => ({ status: 200, body: { id: 'p1', name: 'Т', snapshot: { seq: 0, doc: doc0, chain: 'c0', tombstones: { v: 2, parents: {}, seq: {} } }, tail: [], epoch: 'e1' } });
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E, epoch: 'e1', tip: 'c0', gone: false });
  const a = replica(h, { storage });
  await a.sync.open();
  await until(() => a.sync.status.online && storage.counts.doc === 1, 'первая запись — с документом (новая основа)');
  let doc = doc0;
  for (let k = 1; k <= 40; k++) {
    const t = { tx_id: 'tx_f' + k, seq: k, ops: [ops.set('r1', 'name', 'чужое ' + k)], client: 'Z', chain: 'c' + k, dropped: [] };
    doc = apply(doc, t.ops);
    h.sockets[0].in({ type: 'tx', tx: t });
    if (k % 10 === 0) await tick(60);
  }
  a.sync.offline();
  a.sync.commit([ops.set('ab', 'name', 'своё офлайн')]);
  await until(() => storage.map.get('p1').pending.length === 1, 'очередь записана сразу (≤ 200 мс)');
  assert.ok(storage.counts.doc <= 2, `документ не пишется на каждую транзакцию: ${storage.counts.doc}`);
  const q = storage.map.get('p1');
  assert.equal(q.doc, undefined);
  assert.equal(q.seq, 40);
  // «вкладка упала» — без flush: новая реплика поднимает confirmed из документа + хвоста
  const h2 = harness();
  const b = replica(h2, { storage, opts: { WebSocketImpl: class { constructor() { this.readyState = 0; } close() {} send() {} } } });
  await b.sync.open();
  assert.equal(b.sync.confirmed.seq, 40, 'confirmed — из документа и хвоста');
  assert.equal(hashDoc(b.sync.confirmed.doc), hashDoc(doc));
  assert.equal(b.sync.view.nodes.ab.name, 'своё офлайн');
  assert.equal(b.sync.tip, 'c40');
  await b.sync.close();
  await a.sync.close();
  // close — flush: документ дописан
  assert.equal(storage.map.get('p1#doc').seq, 40);
});

test('sync r27: журнал прежнего формата (документ в той же записи) читается и переписывается в новый', async () => {
  const doc0 = seedDoc();
  const P = { tx_id: 'tx_p', base_seq: 2, ops: [ops.set('r1', 'name', 'ждёт')], engine: E, client: 'A', author_kind: 'human' };
  const storage = await legacyJournal({ seq: 2, doc: doc0, epoch: 'e1', tip: 'c2', pending: [P], extra: { chat: ['привет'] } });
  const h = harness();
  const a = replica(h, { storage, opts: { WebSocketImpl: class { constructor() { this.readyState = 0; } close() {} send() {} } } });
  await a.sync.open();
  assert.equal(a.log.changes[0].from, 'local');
  assert.deepEqual(a.log.changes[0].extra, { chat: ['привет'] });
  assert.equal(a.sync.view.nodes.r1.name, 'ждёт');
  assert.equal(a.sync.confirmed.seq, 2);
  await a.sync.close();
  assert.equal(storage.map.get('p1').doc, undefined, 'запись очереди — без документа');
  assert.equal(storage.map.get('p1#doc').seq, 2);
  assert.equal(storage.map.get('p1').pending.length, 1);
});
