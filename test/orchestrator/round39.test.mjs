/**
 * Круг 39 — Orchestrator (N2, N5):
 *   • N5а: семафор и бюджет байт полных чтений DSLR (событие `queued {scope:'read'}`);
 *     таймаут из-за занятости своего цикла событий и молчание перегруженного сервиса — не
 *     `document_down`;
 *   • N5б: `intentOf` линейно (5000 знаков «а а а…» — быстро);
 *   • N5в/д: рисунок агента пишет нули шкал ссылками; `result.title` — что сделано, план — `plan`;
 *   • N2: DSLV не принимает патч сверх предела раскрытия экземпляров (круг починки, затем
 *     not_applied), журнал не трогается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as core from '../../src/core.js';
import { intentOf, RECOGNIZE_MAX } from '../../server/orchestrator/pipeline.js';
import { createReadGate, createDslrClient } from '../../server/orchestrator/dslr/index.js';
import { createDocClient } from '../../server/orchestrator/docclient.js';
import { DOCUMENT_BUSY_MESSAGE, AGENT_READ_QUEUE_MESSAGE } from '../../server/orchestrator/errors.js';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, journal, call, cid, quiet,
  PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const busyWait = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* держим поток */ } };

/** Заглушка Document service: обработчик на путь; остальное — 404. */
async function stubDocument(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/* ── N5б: intentOf ─────────────────────────────────────────────────────── */

test('круг 39 N5б: intentOf линейно — 5000 знаков «а а а…» и прочие длинные реплики быстрее 20 мс', () => {
  const samples = [
    'а '.repeat(2500), 'ну '.repeat(1250) + 'отмени ' + 'же '.repeat(1250), 'выдели '.repeat(700), 'отмени '.repeat(700),
    'сделай '.repeat(700) + 'кнопку', 'а '.repeat(900) + 'сделай компонентом ' + 'а '.repeat(900),
  ];
  for (const s of samples) intentOf(s, { hasSelection: true });   // прогрев
  for (const s of samples) {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      intentOf(s, { hasSelection: true });
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < 20, `${JSON.stringify(s.slice(0, 16))}… (${s.length} зн.): ${best.toFixed(1)} мс`);
  }
});

test('круг 39 N5б: короткие реплики распознаются как прежде; длинная — работа модели, слэш-форма — команда редактора', () => {
  assert.equal(intentOf('ну отмени, пожалуйста').kind, 'editor');
  assert.equal(intentOf('не так').kind, 'editor');
  assert.equal(intentOf('верни обратно').kind, 'editor');
  assert.equal(intentOf('покажи три варианта').kind, 'variants');
  assert.equal(intentOf('убери последнее').needsModel, false, 'двусмысленная отмена — переспрос без модели');
  assert.equal(intentOf('сделай карточку компонентом').needsModel, false);
  const long = 'Сделай экран оплаты: ' + 'поле, '.repeat(Math.ceil(RECOGNIZE_MAX / 6) + 10);
  assert.ok(long.length > RECOGNIZE_MAX);
  const v = intentOf(long);
  assert.equal(v.kind, 'model');
  assert.equal(v.needsModel, true);
  assert.equal(intentOf('/масштаб ' + '1'.repeat(RECOGNIZE_MAX)).kind, 'editor');
  assert.equal(intentOf('а '.repeat(2500)).kind, 'model', 'одни затычки — не отмена');
  assert.equal(intentOf(' '.repeat(4000) + 'отмени').kind, 'editor', 'пробелы по краям не делают реплику длинной');
  assert.equal(intentOf('x'.repeat(3000), { mode: 'variants', n: 2 }).kind, 'variants');
});

/* ── N5а: семафор полных чтений ────────────────────────────────────────── */

test('круг 39 N5а: семафор полных чтений — число, байты, строгий порядок, документ больше предела — один', async () => {
  const gate = createReadGate({ max: 2, bytes: 100, queue: 8 });
  const a = await gate.acquire(60);
  const b = await gate.acquire(30);
  assert.equal(gate.active, 2);
  const pos = [];
  const cP = gate.acquire(5, { onQueued: (p) => pos.push(['c', p]) });   // мест нет
  let c = null;
  cP.then((t) => { c = t; });
  a.done();                                   // место есть, байтов 90 + 5 ≤ 100
  c = await cP;
  assert.deepEqual(pos, [['c', 1]]);
  assert.equal(gate.held, 95);
  // байтов не хватает: ждём, пока документ отпустят, хотя мест чтения хватает
  b.done();
  c.done();
  const order = [];
  const dP = gate.acquire(50, { onQueued: (p) => order.push(['d', p]) }).then((t) => { order.push('d+'); return t; });
  const eP = gate.acquire(1, { onQueued: (p) => order.push(['e', p]) }).then((t) => { order.push('e+'); return t; });
  await new Promise((r) => setImmediate(r));
  assert.equal(gate.waiting, 2);
  assert.deepEqual(order, [['d', 1], ['e', 2]], 'мелкий не обгоняет большой');
  a.free();                                   // 35 → d (50) влезает, затем e
  const d = await dP;
  const e = await eP;
  assert.deepEqual(order.slice(2), ['d+', 'e+']);
  assert.equal(gate.held, 30 + 5 + 50 + 1);
  b.free(); c.free(); d.free(); e.free();
  assert.equal(gate.held, 0);
  // документ больше всего предела — читается, когда байтов не держит никто
  const x = await gate.acquire(1000);
  const yP = gate.acquire(1);
  let y = null;
  yP.then((t) => { y = t; });
  x.done();
  await new Promise((r) => setImmediate(r));
  assert.equal(y, null, 'пока огромный документ нужен команде, байтов нет');
  x.free();
  y = await yP;
  y.free();
  // чтение без байтов (библиотека) обходит ждущих байтов: команда не ждёт чтения своей библиотеки
  const big = await gate.acquire(90);
  big.done();
  const wantBytes = gate.acquire(50);
  const lib = await gate.acquire(0);
  lib.free();
  big.free();
  (await wantBytes).free();
  assert.equal(gate.held, 0);
  assert.equal(gate.active, 0);
});

test('круг 39 N5а: семафор — срок ожидания и «стоп»: busy (перегружен) и cancelled, место не теряется', async () => {
  const gate = createReadGate({ max: 1, bytes: 10, queue: 1 });
  const a = await gate.acquire(5);
  await assert.rejects(gate.acquire(1, { deadline: Date.now() + 50 }), (e) => e.code === 'busy' && e.status === 503 && e.message === AGENT_READ_QUEUE_MESSAGE && e.detail.cause === 'agent');
  const ctl = new AbortController();
  const p = gate.acquire(1, { signal: ctl.signal });
  await assert.rejects(gate.acquire(1), (e) => e.code === 'busy' && e.detail.cause === 'agent', 'ждущих больше предела — сразу busy (агент)');
  ctl.abort();
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.equal(gate.waiting, 0);
  a.free();
  const b = await gate.acquire(1);
  b.free();
  assert.equal(gate.active, 0);
});

test('круг 39 N5а: DSLR — полные чтения не больше fullConcurrency, размер проекта запоминается, байты держит lease', async (t) => {
  const document = await startDocument();
  t.after(() => document.close());
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(await createProject(document, { name: 'П' + i }));
  const dslr = createDslrClient({ doc: createDocClient({ baseUrl: `http://127.0.0.1:${document.port}` }), log: quiet, fullConcurrency: 2 });
  const queued = [];
  const leases = ps.map(() => ({}));
  await Promise.all(ps.map((p, i) => dslr.read(p.id, { lease: leases[i], onQueued: (pos) => queued.push(pos) })));
  assert.ok(dslr.gate.stats.peak <= 2, `одновременно ${dslr.gate.stats.peak}`);
  assert.ok(queued.length >= 1, 'кто-то ждал своей очереди');
  assert.equal(dslr.gate.active, 0);
  assert.ok(dslr.gate.held > 0, 'байты прочитанных документов держатся, пока нужны командам');
  for (const l of leases) { assert.equal(typeof l.release, 'function'); l.release(); l.release(); }
  assert.equal(dslr.gate.held, 0);
  // из кеша — без семафора и без lease
  const again = {};
  await dslr.read(ps[0].id, { lease: again });
  assert.equal(again.release, undefined);
});

test('круг 39 N5а: команда, чей документ ждёт байтов, получает queued {scope:"read"} и выполняется после соседа', async (t) => {
  const document = await startDocument();
  let open;
  const gate = new Promise((r) => { open = r; });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK }, { gate });
  // байтов — на один документ: вторая команда ждёт, пока первая досчитает
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, dslr: { fullBytes: 1 } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p1 = await createProject(document, { name: 'Первый' });
  const p2 = await createProject(document, { name: 'Второй' });
  const s1 = commandStream(orch.url, { command_id: cid('r1'), project: p1.id, text: 'собери экран тарифов', client: 'c1' });
  await s1.until((e) => e.event === 'stage' && e.data.key === 'llm');
  const s2 = commandStream(orch.url, { command_id: cid('r2'), project: p2.id, text: 'собери экран тарифов', client: 'c2' });
  const q = await s2.until((e) => e.event === 'queued');
  assert.deepEqual(q.data, { position: 1, scope: 'read' });
  open();
  await s1.done();
  await s2.done();
  const r1 = s1.events.find((e) => e.event === 'result');
  const r2 = s2.events.find((e) => e.event === 'result');
  assert.ok(r1 && r2, JSON.stringify(s2.events.map((e) => e.event)));
  // после очереди — снова «Читаю документ», и лишь потом модель
  const keys = s2.events.map((e) => (e.event === 'stage' ? e.data.key : e.event));
  assert.ok(keys.indexOf('queued') < keys.lastIndexOf('read') && keys.lastIndexOf('read') < keys.indexOf('llm'), keys.join(','));
  assert.equal(orch.dslr.gate.held, 0, 'байты отпущены');
  assert.ok(orch.traces.recent().some((tr) => tr.read_queued), 'в трассе — ожидание чтения');
});

/* ── N5а: занятость своего цикла событий и перегруженный сервис — не document_down ── */

test('круг 39 N5а: главный поток агента занят дольше срока проверки — ответ сервиса не теряется («up», а не «недоступен»)', async (t) => {
  const stub = await stubDocument((req, res) => {
    if (req.url === '/api/health') setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'), 20);
    else res.writeHead(404).end();
  });
  t.after(() => stub.close());
  const doc = createDocClient({ baseUrl: stub.base });
  const p = doc.healthDetail();
  // запрос ушёл (или вот-вот уйдёт), а поток занят дольше DOC_HEALTH_TIMEOUT_MS (1,5 с)
  await new Promise((r) => setTimeout(r, 5));
  busyWait(1800);
  const h = await p;
  assert.deepEqual(h, { document: 'up' });
  assert.ok(doc.stats.lagExtended >= 1, 'срок продлён из-за своей занятости');
});

test('круг 39 N5а: сервис принял запрос и молчит дольше обоих сроков — 503 busy «перегружен», а не document_down', async (t) => {
  const stub = await stubDocument(() => { /* не отвечаем */ });
  const orch = await startOrch({ document: { port: stub.port } });
  t.after(async () => { await orch.close(); await stub.close(); });
  const t0 = Date.now();
  const r = await command(orch.url, { command_id: cid('slow'), project: 'p_x', text: 'отмени', client: 'c' });
  // команда редактора проверки не требует — проверяем работу агента
  assert.equal(r.status, 200);
  const r2 = await command(orch.url, { command_id: cid('slow2'), project: 'p_x', text: 'добавь карточку оплаты', client: 'c' });
  assert.equal(r2.status, 503, r2.text);
  assert.equal(r2.body.code, 'busy', r2.text);
  assert.equal(r2.body.message, DOCUMENT_BUSY_MESSAGE);
  assert.ok(r2.body.retry_after > 0);
  assert.ok(Date.now() - t0 < 15000);
});

test('круг 39 N5а: полное чтение не дождалось ответа живого сервиса — busy (перегружен), повтор после таймаута', async (t) => {
  const document = await startDocument();
  const target = `http://127.0.0.1:${document.port}`;
  let fullReads = 0;
  const stub = await stubDocument(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (/^\/api\/projects\/[^/?]+$/.test(req.url) && req.method === 'GET') { fullReads++; return; }   // молчим
    const r = await fetch(target + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
  });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({
    document: { port: stub.port }, llm: { baseUrl: llm.base },
    dslr: { fullTimeoutMs: 400, readBudgetMs: 3000, timeoutRetries: 1 },
  });
  t.after(async () => { await orch.close(); await stub.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('rd'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  assert.equal(r.status, 200);
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, JSON.stringify(r.events.map((e) => e.event)));
  assert.equal(err.data.code, 'busy', JSON.stringify(err.data));
  assert.equal(err.data.retryable, true);
  assert.equal(fullReads, 2, 'одно чтение и один повтор');
  assert.equal(orch.dslr.gate.active, 0);
  assert.equal(orch.dslr.gate.held, 0);
});

/* ── N5в, N5д: рисунок — нули шкал ссылками; итог — что сделано ───────────── */

const COOKIE = {
  name: 'Печенька', canvas: { w: 400, h: 400 },
  parts: [
    { name: 'Печенье', kind: 'ellipse', x: 70, y: 56, w: 260, h: 260, fill: '#e3a85f' },
    { name: 'Крошка 1', kind: 'ellipse', x: 318, y: 318, w: 12, h: 9, fill: '#5b3a1e', rotate: 30, group: 'Крошки' },
    { name: 'Крошка 2', kind: 'ellipse', x: 92, y: 322, w: 9, h: 7, fill: '#5b3a1e', group: 'Крошки' },
    { name: 'Крошка 3', kind: 'ellipse', x: 292, y: 338, w: 7, h: 6, fill: '#5b3a1e', group: 'Крошки' },
  ],
};
const PLAN_ART = { intent: 'illustration', title: 'Печенька', summary: 'Рисую печеньку с шоколадной крошкой.', steps: ['Нарисовать'] };

test('круг 39 N5в/N5д: «нарисуй печеньку» — в журнале нули шкал ссылками (миграции не нужно), title — что сделано, plan — отдельно', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_ART, illustration: COOKIE });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('art'), project: p.id, text: 'нарисуй печеньку', client: 'c' });
  const result = r.events.find((e) => e.event === 'result');
  assert.ok(result, r.text);
  assert.match(result.data.title, /^Нарисовал «Печенька»: \d+ детал/);
  assert.equal(result.data.summary, result.data.title);
  assert.equal(result.data.plan, PLAN_ART.summary);
  const j = await journal(document, p.id);
  assert.equal(j.txs[0].title, result.data.title, 'подпись записи — то же');
  const read = await call(`http://127.0.0.1:${document.port}`, 'GET', `/api/projects/${p.id}`);
  const after = core.applyBatches(read.body.snapshot.doc, (read.body.tail || []).map((tx) => tx.ops)).doc;
  assert.deepEqual(core.ensureScaleRefsOps(after), [], 'свежий рисунок не требует миграции формата');
  const frame = Object.values(after.nodes).find((n) => n.role === 'illustration');
  assert.equal(frame.layout.gap, 'spacing.0');
  assert.equal(frame.radius, 'radii.0');
  const names = frame.children.map((id) => after.nodes[id].name.toLowerCase());
  assert.equal(new Set(names).size, names.length, `имена слоёв рисунка: ${names}`);
});

/* ── N2: предел раскрытия экземпляров ─────────────────────────────────── */

/** Документ: доска и цепочка мастеров K0…K(L−1), в каждом W экземпляров следующего. */
function chainDoc(L, W) {
  const d = clone(core.createDoc('empty'));
  const lib = core.libraryNode(d).id;
  d.nodes.b0 = { type: 'frame', id: 'b0', parent: d.root, name: 'Доска', children: [], size: { w: { mode: 'fixed', value: 800 }, h: { mode: 'fixed', value: 600 } }, layout: { mode: 'column' } };
  d.nodes[d.root].children.unshift('b0');
  for (let i = 0; i < L; i++) {
    const c = 'f_q' + i;
    d.nodes[c] = { type: 'frame', id: c, parent: lib, name: 'K' + i, component: { name: 'K' + i, props: [] }, children: [], layout: { mode: 'column' } };
    d.nodes[lib].children.push(c);
    if (i < L - 1) {
      for (let s = 0; s < W; s++) {
        const n = 'i_q' + i + '_' + s;
        d.nodes[n] = { type: 'instance', id: n, parent: c, of: 'f_q' + (i + 1) };
        d.nodes[c].children.push(n);
      }
    }
  }
  return d;
}
const grid = (n) => ({ type: 'frame', name: 'Сетка', layout: { mode: 'row', gap: 8 }, children: Array.from({ length: n }, () => ({ type: 'instance', of: 'K0' })) });
const PLAN_GRID = { intent: 'create', title: 'Сетка', summary: 'Добавлю сетку экземпляров.', steps: ['Собрать'] };

test('круг 39 N2: патч сверх предела раскрытия — нарушение для круга починки; починка помогла — записан', async (t) => {
  if (typeof core.expandProblem !== 'function') { t.skip('ядро без expandProblem'); return; }
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_GRID, tree: [grid(14), grid(3)] });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document, { name: 'Цепочка', doc: chainDoc(6, 5) });
  const r = await command(orch.url, { command_id: cid('exp'), project: p.id, text: 'добавь сетку из экземпляров K0', client: 'c', board: 'b0' });
  const result = r.events.find((e) => e.event === 'result');
  assert.ok(result, r.text);
  assert.equal(result.data.seq, 1);
  const repair = llm.completions().find((c) => JSON.stringify(c.body.messages).includes('expand-limit'));
  assert.ok(repair, 'модель получила нарушение expand-limit в круге починки');
  const repairs = r.events.filter((e) => e.event === 'stage' && e.data.key === 'repair');
  assert.ok(repairs.length >= 1);
  assert.doesNotMatch(JSON.stringify(repairs), /expand-limit|Не вкладывай/, 'человеку — не текст для модели');
});

test('круг 39 N2: починка не помогла — 422 not_applied словами, журнал не тронут', async (t) => {
  if (typeof core.expandProblem !== 'function') { t.skip('ядро без expandProblem'); return; }
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_GRID, tree: grid(14) });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document, { name: 'Цепочка', doc: chainDoc(6, 5) });
  const r = await command(orch.url, { command_id: cid('exp2'), project: p.id, text: 'добавь сетку из экземпляров K0', client: 'c', board: 'b0' });
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, r.text);
  assert.equal(err.data.code, 'not_applied');
  assert.match(err.data.message, /вложенных экземпляров/);
  assert.match(err.data.message, /Правка не записана/);
  assert.doesNotMatch(err.data.message, /expand-limit|операция \d+/);
  const j = await journal(document, p.id);
  assert.equal(j.head_seq, 0, 'ничего не записано');
});
