/**
 * Круг 32 — реплика и оболочка: части большой правки сводятся в «Истории» точно — по
 * `undo_part {i, n}` и общему `undo_of`/`redo_of` от одной вкладки (сервер их теперь хранит и
 * отдаёт в рассылке и /history), а не по подписи; health Orchestrator с `document_reason:
 * 'schema'` — своими словами.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as core from '../src/core.js';
import * as SHELL from '../src/shell.js';
import { createSync, memoryStorage } from '../src/sync.js';
import { start } from '../server/document/index.js';
import { createMemoryStorage } from '../server/document/storage/memory.js';

const { uid, ENGINE_VERSION: E } = core;
const quiet = { info() {}, warn() {}, error() {} };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'условие', ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(10); }
  assert.fail(`не дождались: ${what}`);
}

const row = (seq, extra = {}) => ({ seq, tx_id: 'tx' + seq, client: 'A', author: 'Аня', author_kind: 'human', title: 'Правка', ops_count: 1, dropped_count: 0, ...extra });

test('shell r32: collapseParts — части одной правки по undo_part и undo_of, а не по подписи', () => {
  // новые первыми; между частями — чужие записи
  const list = [
    row(9, { title: 'Отменил: загрузил «Б» · часть 3 из 3', undo_of: 'txI', undo_part: { i: 2, n: 3 }, ops_count: 10 }),
    row(8, { client: 'B', author: 'Борис', title: 'Переименовал «X» в «Y»' }),
    row(7, { title: 'Отменил: загрузил «Б» · часть 2 из 3', undo_of: 'txI', undo_part: { i: 1, n: 3 }, ops_count: 5000, dropped_count: 2 }),
    row(6, { title: 'Отменил: загрузил «Б» · часть 1 из 3', undo_of: 'txI', undo_part: { i: 0, n: 3 }, ops_count: 5000 }),
    // два импорта подряд из одной вкладки (без undo_of) — две строки, а не одна
    row(5, { title: 'Загрузил «Б» · часть 2 из 2', undo_part: { i: 1, n: 2 }, ops_count: 7 }),
    row(4, { title: 'Загрузил «Б» · часть 1 из 2', undo_part: { i: 0, n: 2 }, ops_count: 5000 }),
    row(3, { title: 'Загрузил «А» · часть 2 из 2', undo_part: { i: 1, n: 2 }, ops_count: 3 }),
    row(2, { title: 'Загрузил «А» · часть 1 из 2', undo_part: { i: 0, n: 2 }, ops_count: 5000 }),
    // подпись как у части, а undo_part нет (сервер прежней версии) — строка как есть
    row(1, { title: 'Загрузил «В» · часть 2 из 2' }),
  ];
  const out = SHELL.collapseParts(list);
  assert.deepEqual(out.map((t) => t.title), [
    'Отменил: загрузил «Б»', 'Переименовал «X» в «Y»', 'Загрузил «Б»', 'Загрузил «А»', 'Загрузил «В» · часть 2 из 2',
  ]);
  assert.deepEqual(out[0].parts, ['tx9', 'tx7', 'tx6']);
  assert.equal(out[0].ops_count, 10010);
  assert.equal(out[0].dropped_count, 2);
  assert.equal(out[0].seq, 9, 'время и номер — новейшей части');
  assert.deepEqual(out[2].parts, ['tx5', 'tx4']);
  assert.deepEqual(out[3].parts, ['tx3', 'tx2']);
  assert.equal(out[4].parts, undefined);

  // части одной правки из РАЗНЫХ вкладок с одинаковой подписью — не сводятся
  const two = SHELL.collapseParts([
    row(2, { client: 'B', title: 'Загрузил «А» · часть 2 из 2', undo_part: { i: 1, n: 2 } }),
    row(1, { client: 'A', title: 'Загрузил «А» · часть 1 из 2', undo_part: { i: 0, n: 2 } }),
  ]);
  assert.equal(two.length, 2);
  // разные отмены (разный undo_of) — тоже
  const three = SHELL.collapseParts([
    row(2, { undo_of: 'tx_b', undo_part: { i: 1, n: 2 } }),
    row(1, { undo_of: 'tx_a', undo_part: { i: 0, n: 2 } }),
  ]);
  assert.equal(three.length, 2);
  // окно журнала обрезало старые части — сводится то, что есть, подпись без хвоста
  const cut = SHELL.collapseParts([
    row(5, { title: 'Вернул: удалил «Доска» · часть 3 из 3', redo_of: 'tx_r', undo_part: { i: 2, n: 3 } }),
    row(4, { title: 'Вернул: удалил «Доска» · часть 2 из 3', redo_of: 'tx_r', undo_part: { i: 1, n: 3 } }),
  ]);
  assert.equal(cut.length, 1);
  assert.equal(cut[0].title, 'Вернул: удалил «Доска»');
  // пустота: строка пустая, только если пусты все части
  const empty = SHELL.collapseParts([
    row(2, { undo_part: { i: 1, n: 2 }, ops_count: 0, empty: true }),
    row(1, { undo_part: { i: 0, n: 2 }, ops_count: 3 }),
  ]);
  assert.equal(empty[0].empty, false);
  assert.equal(SHELL.undoPartOf({ undo_part: { i: 2, n: 2 } }), null);
  assert.equal(SHELL.undoPartOf({ undo_part: { i: 0, n: 1 } }), null);
  assert.deepEqual(SHELL.undoPartOf({ undo_part: { i: 1, n: 2, x: 1 } }), { i: 1, n: 2 });
});

test('shell r32: health Orchestrator с document_reason schema — «сервер обновляет базу данных»', () => {
  const n = SHELL.agentHealthNotice({ ok: true, document: 'up', llm: 'up' }, { ok: true, document: 'down', document_reason: 'schema', llm: 'up' });
  assert.match(n.text, /сервер обновляет базу данных/);
  assert.equal(SHELL.schemaReason({ document_reason: 'schema' }), true);
  assert.equal(SHELL.storageReason({ document_reason: 'schema' }), true, 'schema — тоже хранилище: команда не выполнится');
  const w = SHELL.agentErrorWords({ code: 'document_down', detail: { document_reason: 'schema' } });
  assert.match(w.title, /Сервер обновляет базу данных/);
  const s = SHELL.agentHealthNotice({ ok: true, document: 'up', llm: 'up' }, { ok: true, document: 'down', document_reason: 'storage', llm: 'up' });
  assert.match(s.text, /база данных сервера недоступна/);
});

test('sync r32: части большой отмены — в журнале реплики с undo_part и undo_of, живые и из /history; одна строка', { timeout: 60000 }, async () => {
  const svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), log: quiet, staticDir: '' });
  const base = `http://127.0.0.1:${svc.port}`;
  const mk = (clientId, author) => createSync({
    core, baseUrl: base, projectId: pid, clientId, author, storage: memoryStorage(),
    WebSocketImpl: WebSocket, fetchImpl: fetch, reconnectMin: 20, reconnectMax: 200,
  });
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const pid = (await post('/api/projects', { name: 'части' })).id;
  const A = mk('A', 'Аня');
  const B = mk('B', 'Борис');
  try {
    await A.open();
    await B.open();
    await until(() => A.status.online && B.status.online, 'обе в сети');
    const root = A.view.root;
    const first = A.commit([{ op: 'create', node: { id: 'x1', type: 'frame', name: 'Доска', parent: root } }], { title: 'Создал «Доска»' });
    await until(() => A.pending.length === 0, 'первая подтверждена');
    // отмена «частями»: две транзакции с общим undo_of и undo_part
    const meta = (i) => ({ title: SHELL.partTitle('Отменил: создал «Доска»', i, 2), undo_of: first.tx.tx_id, undo_part: { i, n: 2 } });
    A.commit([{ op: 'set', id: 'x1', path: 'name', value: 'Д' }], meta(0));
    A.commit([{ op: 'remove', id: 'x1' }], meta(1));
    await until(() => A.pending.length === 0 && B.confirmed.seq === A.confirmed.seq, 'части подтверждены и дошли до Бориса');
    const live = B.journal(10);
    const parts = live.filter((t) => t.undo_part);
    assert.equal(parts.length, 2, 'живые записи несут undo_part');
    assert.deepEqual(parts.map((t) => t.undo_part), [{ i: 1, n: 2 }, { i: 0, n: 2 }]);
    assert.ok(parts.every((t) => t.undo_of === first.tx.tx_id));
    const rowsB = SHELL.collapseParts(live);
    assert.equal(rowsB.length, 2, 'Создал + одна отмена');
    assert.equal(rowsB[0].title, 'Отменил: создал «Доска»');
    // новая вкладка Бориса — журнал из /history
    const C = mk('C', 'Борис');
    try {
      await C.open();
      await until(() => C.status.online && C.journal(10).length >= 3, 'история подгружена');
      const hist = C.journal(10);
      assert.deepEqual(hist.filter((t) => t.undo_part).map((t) => t.undo_part), [{ i: 1, n: 2 }, { i: 0, n: 2 }]);
      assert.equal(SHELL.collapseParts(hist).length, 2);
    } finally {
      C.close();
    }
  } finally {
    A.close();
    B.close();
    await svc.close();
  }
});
