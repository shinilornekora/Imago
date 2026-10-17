/**
 * Реплика (src/sync.js), круг 29: надгробия подтверждённых прореживаются тем же правилом,
 * что голова сервера, и view-надгробия — наложение, а не копия на каждый кадр; «История»
 * переживает перезагрузку (`/history` после hello и после снимка, J3); хранилище сервера
 * недоступно — «сервер не может сохранить — правки ждут» (J4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { createSync, memoryStorage, statusLine, LIMITS, STORAGE_DOWN_LABEL } from '../src/sync.js';
import * as SERVER_LIMITS from '../server/document/limits.js';
import { createMemoryStorage } from '../server/document/storage/memory.js';
import { createSequencer } from '../server/document/dslts.js';

const { createDoc, applyOps, ops, uid, artboards, ENGINE_VERSION: E } = core;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'условие', ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(5); }
  assert.fail(`не дождались: ${what}`);
}
const quiet = { info() {}, warn() {}, error() {} };

const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const frameNode = (id, parent) => ({
  type: 'frame', id, name: 'Пачка', parent, children: [], radius: 0, size: HUG,
  layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false },
});
const textNode = (id, parent) => ({ type: 'text', id, name: 't', parent, characters: 'x', style: { token: 'body' }, align: 'left', color: '#14161C', size: HUG });
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

/** Сокет и fetch по сценарию (как в sync-r27): onOpen(ws) — что сказать при открытии; fetch(u) → {status, body}. */
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
  const log = { changes: [], errors: [], statuses: [], journals: [] };
  const sync = createSync({
    core, baseUrl: 'http://test', projectId: extra.projectId || 'p1', clientId: extra.clientId || 'A', author: 'Аня',
    storage: extra.storage || memoryStorage(), WebSocketImpl: h.WS, fetchImpl: h.fetchImpl,
    reconnectMin: 5, reconnectMax: 40, epochReopenMs: 5,
    onChange: (view, info) => log.changes.push({ ...info, view }),
    onError: (e) => log.errors.push(e),
    onStatus: (s) => log.statuses.push(s),
    onJournal: (list) => log.journals.push(list),
    ...extra.opts,
  });
  return { sync, log };
}

/* ------------------------------ надгробия ------------------------------ */

test('sync r29: числа прореживания надгробий реплики = числа сервера (limits.js)', () => {
  assert.equal(LIMITS.tombKeepSeq, SERVER_LIMITS.TOMB_KEEP_SEQ);
  assert.equal(LIMITS.tombPruneEvery, SERVER_LIMITS.TOMB_PRUNE_EVERY);
  assert.equal(LIMITS.tombMax, SERVER_LIMITS.TOMB_MAX);
});

test('sync r29: реплика прореживает надгробия как голова сервера — после каждой транзакции, со снимка и из журнала', { timeout: 60000 }, async () => {
  const lim = { tombKeepSeq: 20, tombPruneEvery: 10, tombMax: 30 };
  const storage = createMemoryStorage();
  await storage.init();
  const p = await storage.createProject({ name: 'Надгробия', kind: 'design', doc: createDoc(), engine: E });
  const snap0 = await storage.latestSnapshot(p.id);
  const board = artboards(snap0.doc)[0];
  const seqr = createSequencer({ storage, verifyMs: 0, snapshotEvery: 25, log: quiet, ...lim });
  const committed = [];
  const h = harness();
  h.fetch = async (u) => {
    if (u.pathname === `/api/projects/${p.id}`) return { status: 200, body: { id: p.id, snapshot: snap0, tail: [] } };
    return { status: 404, body: {} };
  };
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E });
  const journal = memoryStorage();
  const a = replica(h, { projectId: p.id, storage: journal, opts: lim });
  await a.sync.open();
  await until(() => a.sync.status.online, 'в сети');
  const ws = h.sockets[0];
  const feed = async (list) => {
    const r = await seqr.commit(p.id, { tx_id: uid('tx'), base_seq: committed.length ? committed[committed.length - 1].seq : 0, ops: list, engine: E });
    committed.push(r.committed);
    ws.in({ type: 'tx', tx: r.committed });
  };
  const same = async (what) => {
    const head = await seqr.headOf(p.id);
    assert.deepEqual(a.sync.tombstoneIds(), [...head.tombSeq], `${what}: надгробия и номера удаления — как у головы сервера`);
  };
  for (let c = 0; c < 45; c++) {
    const f = `f_${c}`;
    const list = [ops.create(frameNode(f, board.id))];
    for (let i = 0; i < 3; i++) list.push(ops.create(textNode(`t_${c}_${i}`, f)));
    await feed(list);
    if (c % 4 === 1) await feed([ops.remove(`t_${c}_0`)]);   // потомок — отдельно, потом ещё раз в поддереве не будет
    await feed([ops.remove(f)]);
    await same(`цикл ${c}`);
  }
  assert.ok(a.sync.tombstoneIds().length <= lim.tombMax, 'не больше предела');
  assert.equal(a.sync.confirmed.seq, committed.length);

  // журнал: перезагрузка вкладки — те же надгробия (тройки [id, parent, seq])
  await a.sync.close();
  const h2 = harness();
  h2.fetch = h.fetch;
  h2.onOpen = (w) => w.in({ type: 'hello', head_seq: committed.length, engine: E });
  const b = replica(h2, { projectId: p.id, storage: journal, opts: lim });
  await b.sync.open();
  await same('после перезагрузки из журнала');
  await b.sync.close();

  // снимок v2 с номерами удаления + хвост после него — те же надгробия
  await seqr.flush();
  const snap = await storage.latestSnapshot(p.id);
  assert.ok(snap.seq > 0 && snap.seq < committed.length, 'снимок посередине');
  const h3 = harness();
  h3.fetch = async (u) => (u.pathname === `/api/projects/${p.id}`
    ? { status: 200, body: { id: p.id, snapshot: { ...snap, tombstones: snap.tombstones }, tail: committed.filter((x) => x.seq > snap.seq) } }
    : { status: 404, body: {} });
  h3.onOpen = (w) => w.in({ type: 'hello', head_seq: committed.length, engine: E });
  const c3 = replica(h3, { projectId: p.id, opts: lim });
  await c3.sync.open();
  await same('со снимка');
  await c3.sync.close();
  await seqr.close();
});

/** Снимок с `count` надгробиями (узлов в документе нет — удалены давно) и одна своя ожидающая. */
async function tombReplica(count, opts = {}) {
  const doc0 = seedDoc();
  const parents = {};
  const seq = {};
  for (let i = 0; i < count; i++) { parents['gone_' + i] = 'ab'; seq['gone_' + i] = 1000 + Math.floor(i / 10); }
  const snapSeq = 1000 + Math.ceil(count / 10);
  const h = harness();
  h.fetch = async (u) => (u.pathname === '/api/projects/p1'
    ? { status: 200, body: { id: 'p1', snapshot: { seq: snapSeq, doc: doc0, chain: 'c', tombstones: { v: 2, parents, seq } }, tail: [], epoch: 'e1' } }
    : { status: 404, body: {} });
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: snapSeq, engine: E, epoch: 'e1', gone: false });
  const a = replica(h, { opts });
  await a.sync.open();
  await until(() => a.sync.status.online, 'в сети');
  a.sync.commit([ops.set('r1', 'name', 'своя')]);   // в полёте, без ответа: очередь переигрывается на каждый чужой кадр
  return { a, h, snapSeq };
}
async function remoteFrames(a, h, from, n) {
  const ws = h.sockets[0];
  const t0 = performance.now();
  for (let i = 1; i <= n; i++) ws.in({ type: 'tx', tx: { tx_id: 'tx_b' + i, seq: from + i, ops: [ops.set('ab', 'name', 'B' + i)], client: 'B', dropped: [] } });
  const ms = performance.now() - t0;
  assert.equal(a.sync.confirmed.seq, from + n);
  assert.equal(a.sync.view.nodes.r1.name, 'своя');
  return ms;
}

test('sync r29: 196 тыс. надгробий — чужие кадры при ожидающей не копируют словарь (наложение), замер', { timeout: 60000 }, async () => {
  // лучшая из трёх пачек по 20 кадров: пауза сборщика мусора под нагрузкой не делает замер
  // ложным, а копия словаря на кадр (прежний код: 2,5 с на пачку) — в каждой пачке
  const best = async (r) => {
    await remoteFrames(r.a, r.h, r.snapSeq, 5);   // прогрев
    let min = Infinity;
    for (let k = 0; k < 3; k++) min = Math.min(min, await remoteFrames(r.a, r.h, r.snapSeq + 5 + k * 20, 20));
    return min;
  };
  const base = await tombReplica(0);
  const t0 = await best(base);
  await base.a.sync.close();
  // предел снят опцией: все 196 тыс. остаются — проверяется именно переигрывание без копии
  const big = await tombReplica(196000, { tombMax: 1e9, tombKeepSeq: 1e9 });
  assert.equal(big.a.sync.tombstoneIds().length, 196000);
  const t1 = await best(big);
  // прогноз по надгробиям жив: create в удалённого давно — к живому предку (reparented)
  const r = big.a.sync.commit([ops.create(rect('kid', 'gone_77'))]);
  assert.equal(r.applied[0].node.parent, 'ab');
  await big.a.sync.close();
  console.log(`# 20 чужих кадров при 1 ожидающей (лучшая из трёх пачек): без надгробий ${t0.toFixed(1)} мс, 196 тыс. надгробий ${t1.toFixed(1)} мс`);
  // прежняя копия Map на кадр: 196 тыс. × 20 — сотни мс и больше; наложение — как без надгробий
  assert.ok(t1 < t0 * 4 + 150, `196 тыс. надгробий: ${t1.toFixed(1)} мс против ${t0.toFixed(1)} мс без них`);
});

test('sync r29: снимок со 196 тыс. надгробий — у реплики не больше TOMB_MAX, самые новые', { timeout: 60000 }, async () => {
  const { a } = await tombReplica(196000);
  const ids = a.sync.tombstoneIds();
  assert.ok(ids.length <= LIMITS.tombMax, `надгробий ${ids.length}`);
  assert.ok(ids.length >= LIMITS.tombMax - 10, 'предел — самые новые, а не всё подряд');
  assert.equal(ids[ids.length - 1][0], 'gone_195999', 'последнее удалённое помнится');
  assert.ok(!ids.some(([id]) => id === 'gone_0'), 'самое старое вытеснено');
  await a.sync.close();
});

test('sync r29: прореживание по номеру — давно удалённые уходят на границе, create в них — orphan, как на сервере', async () => {
  const doc0 = seedDoc();
  const h = harness();
  h.fetch = async (u) => (u.pathname === '/api/projects/p1'
    ? { status: 200, body: { id: 'p1', snapshot: { seq: 0, doc: doc0, chain: 'c0' }, tail: [] } }
    : { status: 404, body: {} });
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E });
  const a = replica(h, { opts: { tombKeepSeq: 5, tombPruneEvery: 5 } });
  await a.sync.open();
  await until(() => a.sync.status.online, 'в сети');
  const ws = h.sockets[0];
  ws.in({ type: 'tx', tx: { tx_id: 't1', seq: 1, ops: [ops.remove('r1')], client: 'B', dropped: [] } });
  assert.deepEqual(a.sync.tombstoneIds(), [['r1', 1]]);
  for (let s = 2; s <= 9; s++) ws.in({ type: 'tx', tx: { tx_id: 't' + s, seq: s, ops: [ops.set('ab', 'name', 'n' + s)], client: 'B', dropped: [] } });
  assert.deepEqual(a.sync.tombstoneIds(), [['r1', 1]], 'граница 5 − 5 = 0: ещё помнится');
  ws.in({ type: 'tx', tx: { tx_id: 't10', seq: 10, ops: [ops.set('ab', 'name', 'n10')], client: 'B', dropped: [] } });
  assert.deepEqual(a.sync.tombstoneIds(), [], 'граница 10 − 5 = 5: удалённое на seq 1 ушло');
  const r = a.sync.commit([ops.create(rect('kid', 'r1'))]);
  assert.equal(r.dropped[0] && r.dropped[0].reason, 'orphan');
  await a.sync.close();
});

/* ------------------------------ «История» (J3) ------------------------------ */

const item = (seq, extra = {}) => ({ seq, tx_id: 'tx_' + seq, author: 'Борис', author_kind: 'human', title: 'Правка ' + seq, created_at: '2026-10-16T10:00:00Z', client: 'B', command_id: '', ops_count: 1, dropped_count: 0, ...extra });

test('sync r29 (J3): после hello — /history с сервера в журнал; без дублей по seq; новее confirmed — не берётся; onJournal', async () => {
  const doc0 = seedDoc();
  const h = harness();
  h.fetch = async (u) => {
    if (u.pathname === '/api/projects/p1') return { status: 200, body: { id: 'p1', snapshot: { seq: 5, doc: doc0, chain: 'c5' }, tail: [], epoch: 'e1' } };
    if (u.pathname === '/api/projects/p1/history') {
      assert.equal(u.searchParams.get('limit'), '100');
      return { status: 200, body: { items: [item(6), item(5), item(4, { client: 'A', title: 'Своя' }), item(3), item(2, { author_kind: 'agent', author: 'Агент' })], more: true } };
    }
    return { status: 404, body: {} };
  };
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 5, engine: E, epoch: 'e1', gone: false });
  const a = replica(h);
  await a.sync.open();
  await until(() => a.sync.journal().length === 4, 'история с сервера');
  const j = a.sync.journal();
  assert.deepEqual(j.map((e) => e.seq), [5, 4, 3, 2], 'новые первыми; seq 6 (новее confirmed) — не взят');
  assert.equal(j[1].mine, true, 'своя по client');
  assert.equal(j[1].title, 'Своя');
  assert.equal(j[3].author_kind, 'agent');
  assert.ok(a.log.journals.length >= 1 && a.log.journals[a.log.journals.length - 1].length === 4, 'onJournal позван');
  // живая 6-я — одна запись, не две
  h.sockets[0].in({ type: 'tx', tx: { ...item(6), ops: [ops.set('ab', 'name', 'X')], dropped: [] } });
  assert.deepEqual(a.sync.journal().map((e) => e.seq), [6, 5, 4, 3, 2]);
  assert.equal(h.fetches.filter((f) => f.includes('/history')).length, 1, 'после открытия — один раз');
  // переподключение — история уже есть, второй раз не просим
  h.sockets[0].close();
  await until(() => h.sockets.length === 2 && a.sync.status.online, 'переподключился');
  await tick(20);
  assert.equal(h.fetches.filter((f) => f.includes('/history')).length, 1);
  await a.sync.close();
});

test('sync r29 (J3): «История» переживает перезагрузку вкладки — журнал из локальной копии, история с сервера', async () => {
  const doc0 = seedDoc();
  const storage = memoryStorage();
  const h = harness();
  let history = [];
  h.fetch = async (u) => {
    if (u.pathname === '/api/projects/p1') return { status: 200, body: { id: 'p1', snapshot: { seq: 0, doc: doc0, chain: 'c0' }, tail: [], epoch: 'e1' } };
    if (u.pathname === '/api/projects/p1/history') return { status: 200, body: { items: history, more: false } };
    return { status: 404, body: {} };
  };
  let head = 0;
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: head, engine: E, epoch: 'e1', gone: false });
  const a = replica(h, { storage });
  await a.sync.open();
  await until(() => a.sync.status.online, 'в сети');
  const ws = h.sockets[0];
  ws.in({ type: 'tx', tx: { ...item(1), ops: [ops.set('ab', 'name', 'Шапка Ани')], client: 'B', dropped: [] } });
  ws.in({ type: 'tx', tx: { ...item(2), ops: [ops.set('r1', 'name', 'Плашка 2')], client: 'B', dropped: [] } });
  assert.equal(a.sync.journal().length, 2);
  await a.sync.close();
  // перезагрузка: журнала в IndexedDB нет — он с сервера
  history = [item(2), item(1)];
  head = 2;
  const b = replica(h, { storage });
  await b.sync.open();
  assert.equal(b.sync.journal().length, 0, 'до hello журнал пуст');
  await until(() => b.sync.journal().length === 2, 'история после перезагрузки');
  assert.deepEqual(b.sync.journal().map((e) => [e.seq, e.title]), [[2, 'Правка 2'], [1, 'Правка 1']]);
  await b.sync.close();
});

test('sync r29 (J3): после gone — история заново; смена эпохи очищает журнал, ответ на прежний запрос не берётся', async () => {
  const doc0 = seedDoc();
  const h = harness();
  const calls = [];
  let hold = null;
  h.fetch = async (u) => {
    if (u.pathname === '/api/projects/p1') return { status: 200, body: { id: 'p1', snapshot: { seq: 3, doc: doc0, chain: 'c3' }, tail: [], epoch: 'e1' } };
    if (u.pathname === '/api/projects/p1/history') {
      calls.push(u.search);
      if (calls.length === 1) return new Promise((r) => { hold = r; });   // первый ответ задержан
      return { status: 200, body: { items: [item(9, { title: 'новая эпоха' }), item(8)] } };
    }
    return { status: 404, body: {} };
  };
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 3, engine: E, epoch: 'e1', gone: false });
  const a = replica(h);
  await a.sync.open();
  await until(() => calls.length === 1, 'первый запрос истории');
  // база откатилась: новая эпоха, снимок на 9
  h.sockets[0].in({ type: 'gone', snapshot: { seq: 9, doc: doc0, chain: 'n9', tombstones: { v: 2, parents: {}, seq: {} } }, head_seq: 9, epoch: 'e2' });
  await until(() => a.sync.journal().length === 2, 'история после снимка');
  assert.deepEqual(a.sync.journal().map((e) => e.seq), [9, 8]);
  hold({ status: 200, body: { items: [item(3, { title: 'прежняя эпоха' }), item(2)] } });
  await tick(20);
  assert.deepEqual(a.sync.journal().map((e) => e.title), ['новая эпоха', 'Правка 8'], 'ответ про прежнюю историю не смешан');
  await a.sync.close();
});

test('sync r29 (J3): сервис без /history (404) — журнал как раньше, повторно не просим', async () => {
  const doc0 = seedDoc();
  const h = harness();
  h.fetch = async (u) => (u.pathname === '/api/projects/p1'
    ? { status: 200, body: { id: 'p1', snapshot: { seq: 0, doc: doc0, chain: 'c0' }, tail: [] } }
    : { status: 404, body: { error: true, code: 'not_found' } });
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E });
  const a = replica(h);
  await a.sync.open();
  await until(() => a.sync.status.online, 'в сети');
  await tick(20);
  h.sockets[0].in({ type: 'tx', tx: { ...item(1), ops: [ops.set('ab', 'name', 'X')], dropped: [] } });
  assert.deepEqual(a.sync.journal().map((e) => e.seq), [1]);
  assert.equal(a.sync.status.error, null, 'не ошибка и не «проект не найден»');
  h.sockets[0].close();
  await until(() => h.sockets.length === 2 && a.sync.status.online, 'переподключился');
  await tick(20);
  assert.equal(h.fetches.filter((f) => f.includes('/history')).length, 1);
  await a.sync.close();
});

/* ------------------------------ хранилище недоступно (J4) ------------------------------ */

const storageErr = (txId) => ({ type: 'error', error: true, code: 'unavailable', message: 'хранилище недоступно', retryable: true, retry_after: 0, detail: { cause: 'storage' }, ...(txId ? { tx_id: txId } : {}) });

test('sync r29 (J4): statusLine — «сервер не может сохранить — правки ждут» поверх «синхронизации» и «не в сети»', () => {
  assert.equal(statusLine({ online: true, pending: 2, syncing: true, storage: 'down' }), STORAGE_DOWN_LABEL);
  assert.equal(statusLine({ online: false, pending: 1, syncing: false, storage: 'down' }), STORAGE_DOWN_LABEL);
  assert.equal(STORAGE_DOWN_LABEL, 'сервер не может сохранить — правки ждут');
  assert.equal(statusLine({ online: true, pending: 0, syncing: false, storage: 'down' }), 'сервер не может сохранить');
  assert.equal(statusLine({ online: true, pending: 0, syncing: false, storage: 'up' }), 'в сети · всё сохранено');
  assert.equal(statusLine({ online: true, pending: 1, storage: 'down', error: 'engine' }), 'версия движка устарела — обновите страницу');
});

test('sync r29 (J4): две вкладки при лежащем хранилище говорят одно и то же; правка не снимается; health вернулось — уходит сразу', { timeout: 20000 }, async () => {
  const doc0 = seedDoc();
  let storageUp = false;
  let health = 0;
  let seq = 0;
  const commits = [];
  const mk = (clientId) => {
    const h = harness();
    h.fetch = async (u) => {
      if (u.pathname === '/api/projects/p1') return { status: 200, body: { id: 'p1', snapshot: { seq: 0, doc: doc0, chain: 'c0' }, tail: [], epoch: 'e1' } };
      if (u.pathname === '/api/health') {
        health += 1;
        return storageUp
          ? { status: 200, body: { ok: true, engine: E, storage: 'up' } }
          : { status: 503, body: { error: true, code: 'unavailable', retryable: true, detail: { storage: 'down' } } };
      }
      return { status: 404, body: {} };
    };
    return h;
  };
  // вкладка A: сокет живой, правка получает отказ хранилища
  const hA = mk('A');
  const sockets = [];
  const onSend = (ws, m) => {
    if (m.type !== 'tx') return;
    if (!storageUp) { setTimeout(() => ws.in(storageErr(m.tx.tx_id)), 0); return; }
    seq += 1;
    const c = { ...m.tx, seq, dropped: [], chain: 'c' + seq };
    commits.push(c);
    setTimeout(() => { for (const s of sockets) s.in({ type: 'tx', tx: c }); }, 0);
  };
  hA.onSend = onSend;
  hA.onOpen = (ws) => { sockets.push(ws); ws.in({ type: 'hello', head_seq: 0, engine: E, epoch: 'e1', gone: false }); };
  const A = replica(hA, { clientId: 'A' });
  await A.sync.open();
  await until(() => A.sync.status.online, 'A в сети');
  A.sync.commit([ops.set('r1', 'name', 'без базы')], { title: 'Переименовал' });
  await until(() => A.sync.status.storage === 'down', 'A: хранилище лежит');
  assert.equal(A.sync.status.label, STORAGE_DOWN_LABEL);

  // вкладка B открывается при лежащей базе: сервер говорит error (cause: storage) и закрывает 4503
  const hB = mk('B');
  hB.onSend = onSend;
  hB.onOpen = (ws) => {
    if (storageUp) {
      sockets.push(ws);
      ws.in({ type: 'hello', head_seq: seq, engine: E, epoch: 'e1', gone: false });
      for (const c of commits) ws.in({ type: 'tx', tx: c });
      return;
    }
    ws.in(storageErr());
    ws.close(4503);
  };
  const B = replica(hB, { clientId: 'B' });
  await B.sync.open();
  B.sync.commit([ops.set('ab', 'name', 'Доска B')]);
  await until(() => B.sync.status.storage === 'down', 'B: хранилище лежит');
  assert.equal(B.sync.status.online, false);
  assert.equal(B.sync.status.label, A.sync.status.label, 'обе вкладки — одними словами');

  // много отказов подряд: правка не «отравлена», не снята в «не сохранено»
  await tick(600);
  assert.ok(hA.sent.filter((m) => m.type === 'tx').length >= 3, 'A повторяла');
  assert.equal(A.sync.pending.length, 1, 'правка ждёт');
  assert.deepEqual(A.sync.unsaved, []);
  assert.ok(!A.log.errors.some((e) => e.code === 'not_saved'), 'не «не сохранено»');
  assert.ok(health >= 1, 'пока лежит — спрашивает health');

  // хранилище вернулось: health 200 — статус снят, правки ушли
  storageUp = true;
  await until(() => A.sync.pending.length === 0 && B.sync.pending.length === 0, 'правки записаны', 5000);
  assert.equal(A.sync.status.storage, 'up');
  assert.equal(B.sync.status.storage, 'up');
  assert.equal(A.sync.status.label, 'в сети · всё сохранено');
  assert.equal(B.sync.status.label, 'в сети · всё сохранено');
  assert.equal(A.sync.confirmed.doc.nodes.r1.name, 'без базы');
  await A.sync.close();
  await B.sync.close();
});

test('sync r29 (J4): 503 unavailable от хранилища по HTTP при открытии — storage: down; busy — не про хранилище', async () => {
  const doc0 = seedDoc();
  const h = harness();
  let n = 0;
  let healthUp = false;
  h.fetch = async (u) => {
    if (u.pathname === '/api/health') return healthUp ? { status: 200, body: { ok: true, storage: 'up' } } : { status: 503, body: { error: true, code: 'unavailable', detail: { storage: 'down' } } };
    if (u.pathname !== '/api/projects/p1') return { status: 404, body: {} };
    n += 1;
    if (n <= 5) return { status: 503, body: { error: true, code: 'unavailable', message: 'хранилище недоступно', retryable: true, detail: { cause: 'storage' } } };
    return { status: 200, body: { id: 'p1', snapshot: { seq: 0, doc: doc0, chain: 'c0' }, tail: [] } };
  };
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E });
  const a = replica(h);
  const keep = setInterval(() => {}, 20);   // паузы open() — unref-таймеры: процесс не должен выйти, пока ждём
  const opened = a.sync.open();
  await until(() => a.log.statuses.some((s) => s.storage === 'down'), 'storage: down при открытии');
  healthUp = true;
  await opened;
  await until(() => a.sync.status.online && a.sync.status.storage === 'up', 'hello + health — хранилище живо');
  clearInterval(keep);
  await a.sync.close();

  // busy (очередь полна) — повторяемо, но хранилище живо: статус «синхронизация», не «не может сохранить»
  const h2 = harness();
  h2.fetch = async (u) => (u.pathname === '/api/projects/p1'
    ? { status: 200, body: { id: 'p1', snapshot: { seq: 0, doc: doc0, chain: 'c0' }, tail: [] } }
    : { status: 404, body: {} });
  h2.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 0, engine: E });
  h2.onSend = (ws, m) => { if (m.type === 'tx') setTimeout(() => ws.in({ type: 'error', error: true, code: 'busy', retryable: true, retry_after: 0, tx_id: m.tx.tx_id }), 0); };
  const b = replica(h2);
  await b.sync.open();
  await until(() => b.sync.status.online, 'в сети');
  b.sync.commit([ops.set('r1', 'name', 'x')]);
  await until(() => h2.sent.filter((m) => m.type === 'tx').length >= 2, 'повтор после busy');
  assert.equal(b.sync.status.storage, 'up');
  assert.equal(b.sync.status.label, 'синхронизация…');
  await b.sync.close();
});

/* ------- круг 30: command_author и empty — в журнале реплики (живые и из /history) ------- */

test('sync r30: журнал несёт command_author и empty — из /history и из живой рассылки', async () => {
  const doc0 = seedDoc();
  const h = harness();
  h.fetch = async (u) => {
    if (u.pathname === '/api/projects/p1') return { status: 200, body: { id: 'p1', snapshot: { seq: 4, doc: doc0, chain: 'c4' }, tail: [], epoch: 'e1' } };
    if (u.pathname === '/api/projects/p1/history') {
      return { status: 200, body: { items: [
        item(4, { author_kind: 'agent', author: 'Агент', command_author: 'Аня', client: 'X' }),
        item(3, { ops_count: 0, dropped_count: 2, empty: true }),
        item(2, { command_author: null }),
      ], more: false } };
    }
    return { status: 404, body: {} };
  };
  h.onOpen = (ws) => ws.in({ type: 'hello', head_seq: 4, engine: E, epoch: 'e1', gone: false });
  const a = replica(h);
  await a.sync.open();
  await until(() => a.sync.journal().length === 3, 'история с сервера');
  let j = a.sync.journal();
  assert.equal(j[0].command_author, 'Аня');
  assert.equal(j[0].empty, false);
  assert.equal(j[1].empty, true, 'пустая запись помечена');
  assert.equal(j[2].command_author, '', 'null — пустая строка');
  // живая правка агента с именем и живая пустая (все операции выпали)
  h.sockets[0].in({ type: 'tx', tx: { ...item(5, { author_kind: 'agent', author: 'Агент', command_author: 'Борис', client: 'Y' }), ops: [ops.set('ab', 'name', 'X')], dropped: [] } });
  h.sockets[0].in({ type: 'tx', tx: { ...item(6), ops: [], dropped: [{ index: 0, reason: 'stale' }] } });
  j = a.sync.journal();
  assert.deepEqual(j.map((e) => [e.seq, e.command_author, e.empty]), [[6, '', true], [5, 'Борис', false], [4, 'Аня', false], [3, '', true], [2, '', false]]);
  await a.sync.close();
});
