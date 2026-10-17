/**
 * Круг 33 — реплика:
 *  • п.3: догоняющая загрузка при открытии (хвост длиннее первой страницы, с отменами и
 *    повторами) помечена `backlog` в onChange — оболочка не показывает новичку тостов
 *    «Аня отменила правку»; правка, пришедшая после открытия, — уже не догон.
 *  • п.4: база легла в простое, правок нет — реплика сама спрашивает /api/health и говорит
 *    storage:'down'; база вернулась — 'up'.
 *  • L2: серия частей, у которой пришла не последняя часть, видна как «в пути» / «не завершена».
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as core from '../src/core.js';
import * as SHELL from '../src/shell.js';
import { createSync, memoryStorage } from '../src/sync.js';
import { start } from '../server/document/index.js';
import { createMemoryStorage } from '../server/document/storage/memory.js';

const quiet = { info() {}, warn() {}, error() {} };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'условие', ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await tick(10); }
  assert.fail(`не дождались: ${what}`);
}

test('sync r33 (п.3): хвост длиннее первой страницы с отменами — у новичка всё `backlog`, новая правка — нет', { timeout: 60000 }, async () => {
  // страница хвоста — 2 КБ, снимок только при создании: хвост приходит несколькими страницами
  const svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), log: quiet, staticDir: '', pageBytes: 2048, snapshotEvery: 0 });
  const base = `http://127.0.0.1:${svc.port}`;
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const pid = (await post('/api/projects', { name: 'догон' })).id;
  const mk = (clientId, author, onChange) => createSync({
    core, baseUrl: base, projectId: pid, clientId, author, storage: memoryStorage(),
    WebSocketImpl: WebSocket, fetchImpl: fetch, reconnectMin: 20, reconnectMax: 200, onChange,
  });
  const A = mk('A', 'Аня');
  let B = null;
  try {
    await A.open();
    await until(() => A.status.online, 'Аня в сети');
    const root = A.view.root;
    const made = A.commit([{ op: 'create', node: { id: 'x1', type: 'frame', name: 'Доска', parent: root } }], { title: 'Создал «Доска»' });
    for (let i = 0; i < 40; i++) A.commit([{ op: 'set', id: 'x1', path: 'name', value: `Доска ${i} ${'·'.repeat(60)}` }], { title: `Переименовал ${i}` });
    // отмена и повтор — транзакции с undo_of / redo_of
    const u = A.commit([{ op: 'set', id: 'x1', path: 'name', value: 'Доска 38' }], { title: 'Отменил: переименовал 39', undo_of: made.tx.tx_id });
    A.commit([{ op: 'set', id: 'x1', path: 'name', value: 'Доска 39' }], { title: 'Вернул: переименовал 39', redo_of: made.tx.tx_id });
    assert.ok(u.tx);
    await until(() => A.pending.length === 0, 'всё подтверждено');
    const head = A.confirmed.seq;
    // первая страница при открытии меньше хвоста — остальное придёт уже не «молча»
    const first = await (await fetch(`${base}/api/projects/${pid}`)).json();
    assert.ok(first.tail.length < head, `первая страница (${first.tail.length}) короче хвоста (${head})`);

    const seen = [];
    B = mk('B', 'Борис', (view, info) => seen.push(info));
    await B.open();
    await until(() => B.confirmed.seq === head && B.status.online, 'Борис догнал');
    const remote = seen.filter((i) => i.reason === 'remote');
    assert.ok(remote.length > 0, 'хвост сверх первой страницы пришёл транзакциями');
    assert.ok(remote.some((i) => i.tx.undo_of || i.tx.redo_of), 'среди догоняемых — отмена и повтор');
    assert.ok(remote.every((i) => i.backlog === true), 'всё до головы на момент открытия — догон');
    assert.deepEqual(B.view.nodes.x1.name, A.view.nodes.x1.name);

    // правка после открытия — новость, а не догон
    A.commit([{ op: 'set', id: 'x1', path: 'name', value: 'Доска 38' }], { title: 'Отменил: вернул', undo_of: made.tx.tx_id });
    await until(() => B.confirmed.seq === head + 1, 'новая правка дошла');
    const fresh = seen.filter((i) => i.reason === 'remote' && i.tx.seq === head + 1);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].backlog, undefined, 'новая правка — не догон');
  } finally {
    A.close();
    if (B) B.close();
    await svc.close();
  }
});

test('sync r33 (п.4): база легла в простое — storage:down без единой правки; вернулась — up', { timeout: 30000 }, async () => {
  const svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), log: quiet, staticDir: '' });
  const base = `http://127.0.0.1:${svc.port}`;
  const pid = (await (await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"простой"}' })).json()).id;
  let down = false;
  let asked = 0;
  // /api/health отвечает так, как ответил бы сервис при лежащей базе
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/health')) {
      asked += 1;
      if (down) return new Response(JSON.stringify({ code: 'unavailable', message: 'хранилище недоступно', retryable: true, detail: { storage: 'down' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, init);
  };
  const statuses = [];
  const R = createSync({
    core, baseUrl: base, projectId: pid, clientId: 'R', author: 'Вера', storage: memoryStorage(),
    WebSocketImpl: WebSocket, fetchImpl, reconnectMin: 20, reconnectMax: 200, idleHealthMs: 80,
    onStatus: (s) => statuses.push(s),
  });
  try {
    await R.open();
    await until(() => R.status.online && R.status.storage === 'up', 'в сети');
    const before = asked;
    await tick(400);
    assert.ok(asked > before, 'в простое реплика сама спрашивает /api/health');
    down = true;
    await until(() => R.status.storage === 'down', 'storage:down без правок', 5000);
    assert.equal(R.pending.length, 0);
    assert.match(statuses.at(-1).label, /не может сохранить/);
    down = false;
    await until(() => R.status.storage === 'up', 'база вернулась', 5000);
  } finally {
    R.close();
    await svc.close();
  }
  // закрытая реплика больше не спрашивает
  const after = asked;
  await tick(300);
  assert.equal(asked, after);
});

test('shell r33 (L2): незавершённая серия частей — «в пути (1 из 3)», через срок — «не завершена»', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const rows = SHELL.collapseParts([
    { seq: 4, tx_id: 't4', client: 'B', author: 'Борис', title: 'Переименовал «X»', created_at: at(5) },
    { seq: 3, tx_id: 't3', client: 'A', author: 'Аня', title: 'Загрузил «Б» · часть 1 из 3', undo_part: { i: 0, n: 3 }, created_at: at(10) },
    { seq: 2, tx_id: 't2', client: 'C', author: 'Борис', title: 'Удалил «Д» · часть 2 из 2', undo_part: { i: 1, n: 2 }, created_at: at(20) },
    { seq: 1, tx_id: 't1', client: 'C', author: 'Борис', title: 'Удалил «Д» · часть 1 из 2', undo_part: { i: 0, n: 2 }, created_at: at(21) },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(SHELL.partSeriesWords(rows[0], { now }), null, 'не серия');
  const w = SHELL.partSeriesWords(rows[1], { now });
  assert.equal(w.text, 'правка Ани в пути (1 из 3)');
  assert.equal(w.state, 'transit');
  assert.equal(SHELL.partSeriesWords(rows[2], { now }), null, 'серия целая');
  const late = SHELL.partSeriesWords(rows[1], { now: now + SHELL.PART_STALE_MS + 1000 });
  assert.equal(late.text, 'правка Ани не завершена (1 из 3)');
  assert.equal(SHELL.partSeriesWords({ ...rows[1], author_kind: 'agent' }, { now }).text, 'правка агента в пути (1 из 3)');
  assert.equal(SHELL.partSeriesWords(rows[1], { now, mine: true }).text, 'ваша правка в пути (1 из 3)');
  // вторая часть пришла — «в пути (2 из 3)»
  const two = SHELL.collapseParts([
    { seq: 5, tx_id: 't5', client: 'A', author: 'Аня', title: 'Загрузил «Б» · часть 2 из 3', undo_part: { i: 1, n: 3 }, created_at: at(1) },
    { seq: 3, tx_id: 't3', client: 'A', author: 'Аня', title: 'Загрузил «Б» · часть 1 из 3', undo_part: { i: 0, n: 3 }, created_at: at(10) },
  ]);
  assert.equal(two.length, 1);
  assert.equal(SHELL.partSeriesWords(two[0], { now }).text, 'правка Ани в пути (2 из 3)');
});

test('shell r33 (п.7): глагол подписи в роде автора, невидимые изоляторы направления', () => {
  assert.equal(SHELL.agreeVerb({ author: 'Аня' }, 'Загрузил «Б» вместо «А»'), 'Загрузила «Б» вместо «А»');
  assert.equal(SHELL.agreeVerb({ author: 'Борис' }, 'загрузил «Б»'), 'загрузил «Б»');
  assert.equal(SHELL.agreeVerb({ author: 'Аня' }, 'Текст «А» → «Б»'), 'Текст «А» → «Б»');
  assert.equal(SHELL.cleanText('А⁦б⁧в⁨г⁩д؜е'), 'А б в г д е');
  assert.equal(SHELL.importTooBigWords(25004, 20000), 'Файл слишком большой: 25 004 слоя, предел 20 000');
});

test('sync r33 (DOC): присутствие кадром presence_batch — участники видны, своё отброшено, уход виден', { timeout: 30000 }, async () => {
  const svc = await start({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), log: quiet, staticDir: '' });
  const base = `http://127.0.0.1:${svc.port}`;
  const pid = (await (await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"присутствие"}' })).json()).id;
  const urls = [];
  class WS extends WebSocket { constructor(u, ...r) { urls.push(String(u)); super(u, ...r); } }
  const seenB = [];
  const mk = (clientId, author, onPresence) => createSync({
    core, baseUrl: base, projectId: pid, clientId, author, storage: memoryStorage(),
    WebSocketImpl: WS, fetchImpl: fetch, reconnectMin: 20, reconnectMax: 200, onPresence,
  });
  const A = mk('A', 'Аня');
  const B = mk('B', 'Борис', (list) => seenB.push(list));
  const C = mk('C', 'Вера');
  try {
    await A.open(); await B.open(); await C.open();
    await until(() => A.status.online && B.status.online && C.status.online, 'все в сети');
    assert.ok(urls.every((u) => /[?&]presence=batch(&|$)/.test(u)), 'сокет просит presence=batch');
    A.presence({ selection: ['n1'], board: 'b1' });
    C.presence({ selection: ['n2'], board: 'b1' });
    await until(() => { const l = seenB.at(-1) || []; return l.some((p) => p.client === 'A' && p.selection[0] === 'n1') && l.some((p) => p.client === 'C'); }, 'Борис видит Аню и Веру');
    assert.ok(seenB.every((l) => l.every((p) => p.client !== 'B')), 'своего присутствия в списке нет');
    C.close();
    await until(() => !(seenB.at(-1) || []).some((p) => p.client === 'C'), 'уход Веры виден');
  } finally {
    A.close(); B.close(); C.close();
    await svc.close();
  }
});
