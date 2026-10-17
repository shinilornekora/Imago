/**
 * Круг 29, Orchestrator:
 *   • пул воркеров: задание не ставится на считающий воркер (обещание круга 27) и часы счёта
 *     снова идут после ответа модели — зависание после ответа ловится таймаутом;
 *   • ожидание, пока свежий воркер стартует, не объявляется событием `queued`, а долгое
 *     ожидание за чужим счётом — объявляется;
 *   • воркер упал за память — соседи, ждавшие модель, идут заново на свежем воркере, и модель
 *     второй раз не зовётся; сосед зависшего задания — тоже;
 *   • J1: Document service ответил на /api/health 503 (хранилище лежит) — document 'down';
 *   • J5: «ни одна правка не применилась» — `not_applied` с честным текстом; тело отказа
 *     модели — в лог, человеку — нейтральные слова;
 *   • «собери экран» при выделенном мелком узле — новой доской, если экран туда не влезает.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, journal, call, cid, waitFor,
  PLAN_CREATE, TREE_OK, quiet, captureLog,
} from './helpers.mjs';
import { createDslv } from '../../server/orchestrator/dslv/index.js';
import { failureReasons, overflowWords, MODEL_REJECTED } from '../../src/brain.js';

const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };

function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

/** Срок: тест, который без исправления завис бы, падает, а не висит до таймаута раннера. */
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${ms} мс`)), ms); }),
  ]);
}

const llmOk = async () => ({ ok: true });

test('пул: задание не ставится на воркер, который сейчас считает; ждущий модель — принимает', async (t) => {
  const dslv = createDslv({ size: 1, jobsPerWorker: 4, testHooks: true, log: quiet });
  t.after(() => dslv.close());
  await dslv.run({ test: { busyMs: 1 } }, { onLlm: llmOk });          // прогрев: воркер создан

  const order = [];
  const a = dslv.run({ test: { busyMs: 1200 } }, { onLlm: llmOk }).then(() => order.push('a'));
  const b = dslv.run({ test: { busyMs: 1 } }, { onLlm: llmOk }).then(() => order.push('b'));
  // воркер занят счётом a: b ждёт в очереди пула, а не встаёт в очередь его потока
  assert.deepEqual(dslv.load, { running: 1, waiting: 1 });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);

  // задание ждёт модель — воркер свободен для следующего (круг 27)
  const g = gate();
  let asked = 0;
  const c = dslv.run({ test: { llm: true } }, { onLlm: async () => { asked++; await g.promise; return { ok: 1 }; } });
  await waitFor(() => asked === 1);
  const d = dslv.run({ test: { busyMs: 1 } }, { onLlm: llmOk });
  assert.deepEqual(dslv.load, { running: 2, waiting: 0 });
  await within(d, 10000, 'задание рядом с ждущим модель');
  g.open();
  const rc = await c;
  assert.deepEqual(rc.test.answer, { ok: 1 });
});

test('пул: после ответа модели часы счёта снова идут — зависание после ответа ловится таймаутом', async (t) => {
  const dslv = createDslv({ size: 1, timeoutMs: 1000, testHooks: true, log: quiet });
  t.after(() => dslv.close());
  // ответ модели дольше таймаута счёта: ожидание модели часы не ест
  const slow = async () => { await new Promise((r) => setTimeout(r, 1300)); return { ok: 1 }; };
  const ok = await within(dslv.run({ test: { llm: true } }, { onLlm: slow }), 15000, 'обычный прогон');
  assert.deepEqual(ok.test.answer, { ok: 1 });
  // а после ответа воркер завис — таймаут обязан сработать
  const t0 = Date.now();
  await assert.rejects(
    within(dslv.run({ test: { llm: true, spinAfterLlm: true } }, { onLlm: llmOk }), 15000, 'зависший после модели'),
    (e) => e.code === 'timeout',
  );
  assert.ok(Date.now() - t0 >= 900, 'таймаут — по счётному времени');
  assert.equal(dslv.stats.timedOut, 1);
  // пул жив: воркер заменён
  const again = await within(dslv.run({ test: { busyMs: 1 } }, { onLlm: llmOk }), 15000, 'после замены воркера');
  assert.ok(again);
});

test('очередь пула: старт воркера не объявляется «в очереди», долгий чужой счёт — объявляется', async (t) => {
  // воркер стартует ~1 с (как загрузка модулей под нагрузкой); второе задание ждёт его старта
  const dslv = createDslv({ size: 1, jobsPerWorker: 1, testHooks: true, testStartDelayMs: 1000, log: quiet });
  t.after(() => dslv.close());
  const queued = [];
  const a = dslv.run({ test: { busyMs: 10 } }, { onLlm: llmOk });
  const b = dslv.run({ test: { busyMs: 10 } }, { onLlm: llmOk, onQueued: (q) => queued.push(q) });
  await within(Promise.all([a, b]), 15000, 'два задания на стартующем воркере');
  assert.deepEqual(queued, [], `ожидание старта воркера — не очередь (воркер прогрелся за ${dslv.stats.lastWarmMs} мс)`);
  assert.ok(dslv.stats.noticeDeferred >= 1, 'извещение отложено стартом');
  assert.ok(dslv.stats.lastWarmMs >= 900, `старт измерен: ${dslv.stats.lastWarmMs} мс`);

  // воркер прогрет; соседнее задание считает 4 с (дольше любого порога извещения: тот не
  // больше 3 с) — это уже очередь, и о ней говорим
  const late = [];
  const c = dslv.run({ test: { busyMs: 4000 } }, { onLlm: llmOk });
  const d = dslv.run({ test: { busyMs: 1 } }, { onLlm: llmOk, onQueued: (q) => late.push(q) });
  await within(Promise.all([c, d]), 15000, 'задание за долгим счётом');
  assert.deepEqual(late, [{ position: 1 }]);
  assert.equal(dslv.stats.announced, 1);
});

test('воркер вышел за память: сосед, ждавший модель, идёт заново, и модель второй раз не зовётся', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT, { gate: g.promise });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerMaxMb: 96 });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const [pa, pb] = [await createProject(document), await createProject(document)];

  const a = commandStream(orch.url, { command_id: cid('a'), project: pa.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === 1);                 // a ждёт модель
  const b = await command(orch.url, { command_id: cid('b'), project: pb.id, text: 'собери экран тарифов', __test: 'oom' });
  const be = b.events.find((e) => e.event === 'error');
  assert.ok(be, b.text);
  assert.equal(be.data.code, 'worker_failed');
  assert.match(be.data.message, /памят/, 'виновнику — правда о памяти');

  g.open();
  const res = await a.until((e) => e.event === 'result' || e.event === 'error');
  assert.equal(res.event, 'result', JSON.stringify(res.data));
  await a.done();
  assert.ok(!a.events.some((e) => e.event === 'error'), 'соседу «не уложился в память» не говорим');
  // план (уже ушедший в модель) и дерево — по разу: повторный прогон взял ответ, а не позвал снова
  assert.deepEqual(llm.completions().map((c) => c.schema), ['plan', 'tree']);
  assert.equal(orch.dslv.stats.restarted, 1);
  assert.ok(orch.dslv.stats.llmReused >= 1);
  // стадии повторного прогона второй раз в ленту не идут
  const plans = a.events.filter((e) => e.event === 'stage' && /^Планирую/.test(e.data.label));
  assert.equal(plans.length, 1, JSON.stringify(a.events.map((e) => e.data && e.data.label)));
  assert.equal((await journal(document, pa.id)).head_seq, 1, 'записано один раз');
});

test('сосед зависшего задания: воркер снят по таймауту — сосед идёт заново, а не получает ошибку', async (t) => {
  const document = await startDocument();
  const g = gate();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerTimeoutMs: 2000 });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const [pa, pb] = [await createProject(document), await createProject(document)];
  // прогрев: «холодный» первый прогон под нагрузкой сам мог бы не уложиться в таймаут счёта
  const warm = await command(orch.url, { command_id: cid('w'), project: pb.id, text: 'собери экран тарифов' });
  assert.ok(warm.events.some((e) => e.event === 'result'), warm.text);
  llm.state.gate = g.promise;
  const before = llm.completions().length;
  const a = commandStream(orch.url, { command_id: cid('a'), project: pa.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length === before + 1);
  const b = await command(orch.url, { command_id: cid('b'), project: pb.id, text: 'собери экран тарифов', __test: 'spin' });
  assert.equal(b.events.find((e) => e.event === 'error').data.code, 'timeout');
  g.open();
  const res = await a.until((e) => e.event === 'result' || e.event === 'error');
  assert.equal(res.event, 'result', JSON.stringify(res.data));
  assert.deepEqual(llm.completions().slice(before).map((c) => c.schema), ['plan', 'tree']);
  assert.equal(orch.dslv.stats.restarted, 1);
});

test('J1: Document service отвечает на /api/health 503 (хранилище лежит) — document down', async (t) => {
  let storage = 'down';
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/health' && storage === 'down') {
      res.writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: true, code: 'unavailable', retryable: true, detail: { storage: 'down' } }));
      return;
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, engine: 1, storage: 'up' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const orch = await startOrch({ document: { port: fake.address().port } });
  t.after(async () => { await orch.close(); fake.closeAllConnections(); await new Promise((r) => fake.close(r)); });
  const down = await call(orch.url, 'GET', '/agent/health');
  assert.equal(down.status, 200, 'сам агент отвечает');
  assert.equal(down.body.document, 'down');
  storage = 'up';
  assert.equal((await call(orch.url, 'GET', '/agent/health')).body.document, 'up');
});

test('J5: ни одна правка не применилась — not_applied, текст без «правлю …» и обещаний', async (t) => {
  const document = await startDocument();
  const plan = { intent: 'edit', title: 'Укрупнил заголовок', summary: 'Ставлю стиль h1.', steps: ['Найти', 'Поставить'], targets: ['Заголовок'] };
  const patch = { summary: 'Укрупнил заголовок', edits: [{ op: 'set', target: 'Заголовок', path: 'style', value: 'h1' }] };
  const llm = await startFakeLlm({ plan, patch });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const { doc } = await orch.dslr.read(p.id);
  const summary = Object.keys(doc.nodes).find((id) => doc.nodes[id].name === 'Сводка недели');
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'сделай заголовок крупнее', selection: [summary], board: summary });
  const e = r.events.find((x) => x.event === 'error');
  assert.ok(e, r.text);
  assert.equal(e.data.code, 'not_applied');
  assert.equal(e.data.retryable, true);
  // причина — словами: какие узлы подошли и почему не вышло
  assert.match(e.data.message, /подходит слоёв — 3/);
  assert.match(e.data.message, /^Внутри «Заголовок и период» .*непонятно, какому/, 'причина — первой');
  // круг 31: совет «назовите слой» — не в тексте, а полем для оболочки (она даёт свой)
  assert.doesNotMatch(e.data.message, /назовите слой/);
  assert.equal(e.data.detail.hint, 'name_layer');
  // и без противоречий: «правлю», «скажите «во всех…»» — о правке, которой нет
  assert.doesNotMatch(e.data.message, /правлю|во всех…|Ни одну правку/);
  assert.equal((await journal(document, p.id)).head_seq, 0);
});

test('J5: тело отказа модели (400 {"error":…}) — в лог, человеку нейтральные слова', async (t) => {
  const document = await startDocument();
  const plan = { intent: 'edit', title: 'Правка', summary: 'Правлю.', steps: ['a'], targets: ['Заголовок'] };
  const llm = await startFakeLlm({ plan });                       // на patch — 400 с JSON-телом
  const log = captureLog();
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, log });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'сделай заголовок крупнее' });
  const e = r.events.find((x) => x.event === 'error');
  assert.ok(e, r.text);
  assert.equal(e.data.code, 'llm_failed');
  assert.equal(e.data.message, MODEL_REJECTED);
  assert.doesNotMatch(e.data.message, /[{}"]|400|error/);
  assert.ok(log.lines.some((l) => /отвергла запрос \(400\).*нет ответа для patch/.test(l)), log.lines.join('\n'));
});

test('«собери экран» при выделенном мелком узле: экран не влезает — новой доской, с пояснением', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const { doc } = await orch.dslr.read(p.id);
  const chips = Object.keys(doc.nodes).find((id) => doc.nodes[id].name === 'Ярлыки');
  assert.ok(chips, 'в демо есть ряд «Ярлыки»');
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', selection: [chips], board: doc.nodes[doc.root].children[0] });
  const res = r.events.find((e) => e.event === 'result');
  assert.ok(res, r.text);
  const top = (await journal(document, p.id)).txs[0].ops.find((o) => o.op === 'create');
  assert.equal(top.node.parent, doc.root, 'новой доской, а не в ряд ярлыков');
  const w = res.data.warnings.join(' | ');
  assert.match(w, /не влезает в выделенный «Ярлыки» \(390 px против \d+ px\) — собрал его новой доской/);
  assert.doesNotMatch(w, /Собираю внутри выделенного|вылез за рамки/);
  assert.ok(!r.events.some((e) => e.event === 'stage' && /^Чиню/.test(e.data.label)), 'круга починки нет');
  assert.deepEqual(llm.completions().map((c) => c.schema), ['plan', 'tree'], 'модель не зовётся лишний раз');
});

test('единые слова: выход за рамки — «на 40 px по ширине», а не «на 40×0»; причины отказа без обещаний', () => {
  assert.equal(overflowWords('выходит за «Ярлыки» на 40×0'), 'выходит за «Ярлыки» на 40 px по ширине');
  assert.equal(overflowWords('на 0×12.4'), 'на 12 px по высоте');
  assert.equal(overflowWords('на 3×4'), 'на 3 px по ширине и 4 px по высоте');
  assert.equal(overflowWords('на 0×0'), 'на доли пикселя');
  assert.deepEqual(failureReasons([
    'Под «Цена» подходит слоёв — 3 («Цена» в «А», «Цена» в «Б», «Цена» в «В»); правлю «Цена» в «А». Скажите «во всех…», чтобы поправить сразу все.',
    'Слой «Цена» найден вне выделения — правка ушла туда',
    'Поле «rotation» у текста не поддерживается — правка пропущена',
  ]), [
    // причина — первой (оболочка показывает начало), адресация — фактом, без «правлю»;
    // круг 31: короче — без «правка пропущена» (это говорит заголовок) и без перечня имён
    'Поле «rotation» у текста не поддерживается.',
    'Под «Цена» подходит слоёв — 3; пробовал «Цена» в «А».',
  ]);
  assert.deepEqual(failureReasons(['Под «Время» подходит слоёв — 2: правлю все («Время» в «А», «Время» в «Б»)']),
    ['Под «Время» подходит слоёв — 2.']);
});

test('стадия «Чиню» и предупреждение говорят о выходе за рамки одними словами', async (t) => {
  const document = await startDocument();
  // блок (не экран) фиксированной ширины 600 — в узкий ряд: остаётся внутри, вылезает
  const plan = { intent: 'create', title: 'Добавил плашку', summary: 'Плашка.', steps: ['Плашка'], targets: [] };
  const tree = { type: 'frame', name: 'Плашка', size: { w: 600, h: 40 }, layout: { mode: 'row', gap: 8, padding: [8, 8] }, children: [] };
  const llm = await startFakeLlm({ plan, tree });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const { doc } = await orch.dslr.read(p.id);
  const chips = Object.keys(doc.nodes).find((id) => doc.nodes[id].name === 'Ярлыки');
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'добавь плашку', selection: [chips], board: doc.nodes[doc.root].children[0] });
  const texts = r.events.filter((e) => e.event === 'stage').map((e) => `${e.data.label} ${e.data.detail || ''}`)
    .concat(((r.events.find((e) => e.event === 'result') || {}).data || { warnings: [] }).warnings);
  const over = texts.filter((s) => /вылез за рамки/.test(s));
  assert.ok(over.length >= 1, texts.join('\n'));
  for (const s of over) {
    assert.match(s, /px по ширине/, s);
    assert.doesNotMatch(s, /\d\s*×\s*\d/, s);
  }
});
