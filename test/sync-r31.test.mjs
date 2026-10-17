/**
 * Реплика (src/sync.js) и оболочка без DOM (src/shell.js), круг 31.
 *  • K1: отмена удаления доски на 8000+ узлов — несколько транзакций с общим undo_of и
 *    undo_part {i, n}; живой Document service (память) принимает каждую, документ
 *    возвращается целиком — у этой реплики и у свежей.
 *  • UX Д1: импорт большого JSON в серверном режиме — replaceDocOps + части; 19 000 узлов
 *    ложатся, > 20 000 — словами с числом.
 *  • UX Д5: оболочка получила 503 «хранилище недоступно» — статус реплики тот же
 *    (storageFailed), health снимает его.
 *  • m7: whoChanged — кто чужой переписал лист после нашей правки.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as core from '../src/core.js';
import * as SHELL from '../src/shell.js';
import { createSync, memoryStorage, LIMITS, statusLine } from '../src/sync.js';
import { start } from '../server/document/index.js';
import { createMemoryStorage } from '../server/document/storage/memory.js';

const { createDoc, applyOps, invertOps, hashDoc, uid, ENGINE_VERSION: E } = core;
const quiet = { info() {}, warn() {}, error() {} };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'условие', ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(10); }
  assert.fail(`не дождались: ${what}`);
}

async function service() {
  const svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), log: quiet, staticDir: '' });
  const base = `http://127.0.0.1:${svc.port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { svc, base, post };
}

function replica(base, projectId, clientId = 'A', extra = {}) {
  const log = { errors: [], statuses: [], changes: [] };
  const sync = createSync({
    core, baseUrl: base, projectId, clientId, author: extra.author || 'Аня', storage: memoryStorage(),
    WebSocketImpl: WebSocket, fetchImpl: fetch, reconnectMin: 20, reconnectMax: 200,
    onError: (e) => log.errors.push(e), onStatus: (s) => log.statuses.push(s),
    onChange: (view, info) => log.changes.push(info),
  });
  return { sync, log };
}

async function opened(r, base, projectId) {
  await r.sync.open();
  const hs = (await fetch(`${base}/api/projects/${projectId}?head=1`).then((x) => x.json())).head_seq;
  await until(() => r.sync.status.online && r.sync.confirmed.seq >= hs, 'реплика догнала сервер');
}

/** Проект с доской: blocks × texts узлов (по транзакции ≤ 4000 операций). */
async function bigProject(post, blocks, texts) {
  const pr = (await post('/api/projects', { name: 'Большая доска' })).body;
  const snap = await fetch(post.base + `/api/projects/${pr.id}`).then((r) => r.json());
  let seq = snap.head_seq || 0;
  const tx = async (ops) => {
    const r = await post(`/api/projects/${pr.id}/tx`, { tx_id: uid('tx'), base_seq: seq, engine: E, ops });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body).slice(0, 200));
    assert.equal((r.body.dropped || []).length, 0, 'генератор: ничего не выпало');
    seq = r.body.seq;
  };
  const root = snap.snapshot.doc.root;
  await tx([{ op: 'create', node: { id: 'board', type: 'frame', name: 'Большая доска', parent: root, layout: { mode: 'column' } } }]);
  let ops = [];
  for (let b = 0; b < blocks; b++) {
    ops.push({ op: 'create', node: { id: `blk${b}`, type: 'frame', name: `Блок ${b}`, parent: 'board', layout: { mode: 'row', wrap: true } } });
    for (let t = 0; t < texts; t++) ops.push({ op: 'create', node: { id: `t${b}_${t}`, type: 'text', name: `Текст ${b}.${t}`, parent: `blk${b}`, characters: `т${t} — строка` } });
    if (ops.length >= 4000) { await tx(ops); ops = []; }
  }
  if (ops.length) await tx(ops);
  return pr.id;
}

/** Как оболочка (serverCommit, K1): части по пределу — каждая своей транзакцией с общими метаданными. */
function commitParts(sync, list, meta) {
  const parts = SHELL.needsParts(list) ? SHELL.splitOpsForServer(list, { splitOps: core.splitOps }) : [list];
  const txs = [];
  parts.forEach((part, i) => {
    const m = { ...meta };
    if (parts.length > 1) { m.undo_part = { i, n: parts.length }; m.title = SHELL.partTitle(meta.title, i, parts.length); }
    const r = sync.commit(part, m);
    assert.ok(r.tx, `часть ${i + 1} из ${parts.length} принята репликой`);
    txs.push(r.tx);
  });
  return txs;
}

test('shell r31: splitOpsForServer — подряд, без потерь, в пределах; своя резка = ядро', () => {
  const doc = createDoc('empty');
  const list = [];
  for (let i = 0; i < 12345; i++) list.push({ op: 'create', node: { id: 'n' + i, type: 'text', parent: doc.root, characters: 'ж'.repeat(i % 7 === 0 ? 400 : 3) } });
  const mine = SHELL.splitOpsForServer(list);
  const viaCore = SHELL.splitOpsForServer(list, { splitOps: core.splitOps });
  for (const parts of [mine, viaCore]) {
    assert.ok(parts.length >= 3);
    assert.equal(parts.flat().length, list.length, 'все операции на месте');
    assert.deepEqual(parts.flat().map((o) => o.node.id), list.map((o) => o.node.id), 'порядок тот же');
    for (const p of parts) {
      assert.ok(p.length <= LIMITS.opsPerTx);
      assert.ok(Buffer.byteLength(JSON.stringify(p)) <= SHELL.PART_MAX_BYTES);
    }
  }
  assert.equal(SHELL.needsParts(list.slice(0, 10)), false);
  assert.equal(SHELL.needsParts(list), true);
  // мелкая правка не режется вовсе
  assert.deepEqual(SHELL.splitOpsForServer(list.slice(0, 3)).length, 1);
  // ядро ответило ерундой — режем сами
  assert.equal(SHELL.splitOpsForServer(list, { splitOps: () => [[list[0]]] }).flat().length, list.length);
  assert.deepEqual(SHELL.partBase(SHELL.partTitle('Отменил: удалил «Доска»', 1, 3)), { base: 'Отменил: удалил «Доска»', i: 1, n: 3 });
  assert.equal(SHELL.partBase('Удалил «X»'), null);
});

test('sync r31 (K1): удаление доски на 8000+ узлов и отмена частями с общим undo_of — документ целиком, одним шагом', { timeout: 120000 }, async () => {
  const { svc, base, post } = await service();
  post.base = base;
  try {
    const pid = await bigProject(post, 80, 100);
    const a = replica(base, pid, 'A');
    await opened(a, base, pid);
    assert.equal(Object.keys(a.sync.view.nodes).length >= 8081, true);
    const beforeDoc = a.sync.view;
    const before = hashDoc(beforeDoc);
    const del = a.sync.commit([{ op: 'remove', id: 'board' }], { title: 'Удалил «Большая доска»' });
    assert.ok(del.tx);
    await until(() => !a.sync.pending.length, 'удаление записано');
    // инверсия — по документу до удаления, как у оболочки: invertOps(prevDoc, applied)
    const inv = invertOps(beforeDoc, del.applied);
    assert.ok(inv.length > LIMITS.opsPerTx, `инверсия больше предела: ${inv.length}`);
    // одна транзакцией реплика бы её не взяла — честный отказ, а не молчание
    const refused = a.sync.commit(inv, { undo_of: del.tx.tx_id });
    assert.equal(refused.tx, null);
    assert.ok(a.log.errors.some((e) => e.code === 'too_large'));
    const txs = commitParts(a.sync, inv, { title: 'Отменил: удалил «Большая доска»', undo_of: del.tx.tx_id });
    assert.ok(txs.length >= 2);
    for (const t of txs) {
      assert.equal(t.undo_of, del.tx.tx_id, 'общий undo_of');
      assert.equal(t.undo_part.n, txs.length);
    }
    await until(() => !a.sync.pending.length, 'части записаны', 60000);
    assert.equal(hashDoc(a.sync.view), before, 'доска вернулась целиком');
    assert.equal(a.log.errors.filter((e) => e.code !== 'too_large').length, 0, JSON.stringify(a.log.errors.slice(0, 2)));
    // свежая реплика (другой браузер) видит то же — сервер принял все части
    const b = replica(base, pid, 'B', { author: 'Борис' });
    await opened(b, base, pid);
    assert.equal(hashDoc(b.sync.view), before, 'на сервере документ тот же');
    const undos = b.sync.journal(10).filter((e) => e.title.startsWith('Отменил'));
    assert.equal(undos.length, txs.length, 'частей в журнале столько же');
    a.sync.close(); b.sync.close();
  } finally { await svc.close(); }
});

test('sync r31 (UX Д1): импорт 19 000 узлов в серверном режиме — replaceDocOps частями, документ ровно как в файле', { timeout: 120000 }, async () => {
  const { svc, base, post } = await service();
  post.base = base;
  try {
    const pr = (await post('/api/projects', { name: 'Импорт' })).body;
    const a = replica(base, pr.id, 'A');
    await opened(a, base, pr.id);
    // файл: другой документ с 19 000 узлов (доски, блоки, тексты), своя библиотека
    let file = createDoc('empty');
    const add = (list) => { const r = applyOps(file, list); assert.equal(r.error, undefined, r.error && r.error.message); file = r.doc; };
    const ops = [];
    for (let d = 0; d < 4; d++) {
      ops.push({ op: 'create', node: { id: `ab${d}`, type: 'frame', name: `Доска ${d}`, parent: file.root, pos: { x: d * 500, y: 0 }, layout: { mode: 'column' } } });
      for (let b = 0; b < 45; b++) {
        ops.push({ op: 'create', node: { id: `f${d}_${b}`, type: 'frame', name: `Блок ${b}`, parent: `ab${d}`, layout: { mode: 'row' } } });
        for (let t = 0; t < 104; t++) ops.push({ op: 'create', node: { id: `x${d}_${b}_${t}`, type: 'text', name: `Т ${t}`, parent: `f${d}_${b}`, characters: 'текст' } });
      }
    }
    add(ops);
    const count = Object.keys(file.nodes).length;
    assert.ok(count > 18900 && count <= LIMITS.docNodes, `узлов в файле: ${count}`);
    const list = SHELL.replaceDocOps(a.sync.view, file);
    assert.ok(list.length > LIMITS.opsPerTx);
    // одним куском реплика бы отказала (так падал импорт: r.tx.id у {ok:false})
    assert.equal(a.sync.commit(list, { title: 'Импорт' }).tx, null);
    const txs = commitParts(a.sync, list, { title: 'Загрузил «Файл» вместо «Импорт»' });
    assert.ok(txs.length >= 4);
    await until(() => !a.sync.pending.length, 'импорт записан', 90000);
    const b = replica(base, pr.id, 'B');
    await opened(b, base, pr.id);
    const got = b.sync.view;
    // узлы файла — на месте (корень свой: у детей корня файла родитель — корень проекта)
    for (const id of Object.keys(file.nodes)) {
      if (id === file.root) continue;
      assert.ok(got.nodes[id], `узел ${id} есть`);
    }
    assert.deepEqual(got.nodes[got.root].children.filter((id) => id.startsWith('ab')), ['ab0', 'ab1', 'ab2', 'ab3'], 'доски по порядку');
    assert.deepEqual(got.nodes.f2_7.children.length, 104);
    // больше предела — словами, с числом
    assert.equal(SHELL.importTooBigWords(25004, LIMITS.docNodes), 'Файл слишком большой: 25 004 узла, предел 20 000');
    a.sync.close(); b.sync.close();
  } finally { await svc.close(); }
});

test('sync r31 (UX Д5): 503 «хранилище недоступно» у оболочки — статус реплики «сервер не может сохранить», health снимает', async () => {
  const health = { body: { ok: true, engine: E, storage: 'up' }, status: 200, calls: 0 };
  const fetchImpl = async (u) => {
    const url = new URL(String(u));
    if (url.pathname === '/api/health') { health.calls += 1; return new Response(JSON.stringify(health.body), { status: health.status, headers: { 'content-type': 'application/json' } }); }
    return new Response('{}', { status: 404 });
  };
  const statuses = [];
  const sync = createSync({ core, baseUrl: 'http://test', projectId: 'p1', clientId: 'A', storage: memoryStorage(), fetchImpl, WebSocketImpl: class { constructor() { this.readyState = 0; } close() {} send() {} }, reconnectMin: 5, reconnectMax: 20, onStatus: (s) => statuses.push(s) });
  assert.equal(typeof sync.storageFailed, 'function');
  health.status = 503;
  health.body = { error: true, code: 'unavailable', retryable: true, detail: { storage: 'down' } };
  sync.storageFailed();
  assert.equal(sync.status.storage, 'down');
  assert.equal(statusLine(sync.status), 'сервер не может сохранить');
  health.status = 200;
  health.body = { ok: true, engine: E, storage: 'up' };
  await until(() => sync.status.storage === 'up', 'health снял «не может сохранить»', 5000);
  assert.ok(health.calls >= 1);
  sync.close();
});

test('sync r31 (m7): whoChanged — кто чужой переписал лист после нашей правки', { timeout: 60000 }, async () => {
  const { svc, base, post } = await service();
  try {
    const pr = (await post('/api/projects', { name: 'Шапка' })).body;
    const a = replica(base, pr.id, 'A');
    const b = replica(base, pr.id, 'B', { author: 'Борис' });
    await opened(a, base, pr.id); await opened(b, base, pr.id);
    const lib = a.sync.view.nodes[a.sync.view.root].children[0];
    const mine = a.sync.commit([{ op: 'set', id: lib, path: 'name', value: 'Шапка А' }], { title: 'Переименовал' });
    await until(() => !a.sync.pending.length, 'A записала');
    const seqA = a.sync.confirmed.seq;
    b.sync.commit([{ op: 'set', id: lib, path: 'name', value: 'Шапка Б' }], { title: 'Переименовал' });
    await until(() => a.sync.confirmed.seq > seqA, 'A увидела правку B');
    const who = a.sync.whoChanged({ op: 'set', id: lib, path: 'name' }, seqA);
    assert.equal(who && who.author, 'Борис');
    assert.equal(a.sync.whoChanged({ op: 'set', id: lib, path: 'name' }, a.sync.confirmed.seq), null, 'позже — никого');
    assert.equal(a.sync.whoChanged({ op: 'set', id: lib, path: 'fill' }, seqA), null, 'другой лист — никого');
    void mine;
    a.sync.close(); b.sync.close();
  } finally { await svc.close(); }
});
