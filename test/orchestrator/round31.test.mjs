/**
 * Круг 31, Orchestrator и brain:
 *   • brain обходит детей узла только массивом — документ, отравленный до исправления ядра
 *     (`children` объектом или строкой), не роняет команду;
 *   • K3: исключение кода — `internal` (retryable:false, стек в лог), а не «сбой модели»;
 *     пустой патч — `result` с `nothingChanged`, без записи; ответ модели слишком большой,
 *     глубокий или не JSON — `llm_bad_response` (retryable), без глобального «модель недоступна»;
 *   • DSLV: ответ модели, который не передаётся воркеру, — быстрый `llm_bad_response`, воркер цел;
 *     потолок кучи воркера закреплён (мутант P13);
 *   • K2: `/agent/health` — `document_reason` ('storage' | 'unreachable');
 *   • слова: стадия «Прикладываю к макету» вместо «Собираю операции — Перевожу ответ в операции»;
 *     not_applied — короче, без «правка пропущена» и без своего совета; совет «назовите слой» —
 *     полем `detail.hint: 'name_layer'` и только когда причина в выборе слоя.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as core from '../../src/core.js';
import {
  startDocument, startFakeLlm, startOrch, command, createProject, journal, call, cid, captureLog, quiet,
  PLAN_CREATE, TREE_OK,
} from './helpers.mjs';
import { createDslv } from '../../server/orchestrator/dslv/index.js';
import { createDslrClient, chainNext } from '../../server/orchestrator/dslr/index.js';
import { WORKER_MAX_OLD_MB } from '../../server/orchestrator/limits.js';
import {
  runCommand, makeProvider, readBodyCapped, parseBodyJson, completionText, modelDataProblem,
  failureReasons, failureHint, toErrorInfo, isInternalError, MODEL_DATA_MAX_DEPTH,
} from '../../src/brain.js';

const PLAN_EDIT = { intent: 'edit', title: 'Правка', summary: 'Правлю.', steps: ['Найти', 'Поправить'], targets: ['Заголовок'] };
const nest = (n) => '['.repeat(n) + ']'.repeat(n);
function deepArray(n) { let v = []; for (let i = 0; i < n; i++) v = [v]; return v; }

/** Срок: тест, который без исправления завис бы, падает, а не висит до таймаута раннера. */
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: дольше ${ms} мс`)), ms); }),
  ]);
}

/** Поддельная модель «по-плохому»: mode — что отдать на chat/completions. */
async function startBadLlm() {
  const st = { mode: 'ok', posts: 0, sent: 0 };
  const wrap = (content) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* дочитать */ }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"m"}]}'); return; }
    st.posts++;
    switch (st.mode) {
      case 'ok': res.writeHead(200, { 'content-type': 'application/json' }).end(wrap(JSON.stringify(PLAN_CREATE))); return;
      case 'nested-content': res.writeHead(200, { 'content-type': 'application/json' }).end(wrap(nest(200000))); return;
      case 'nested-body': res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[{"message":{"content":' + nest(300000) + '}}]}'); return;
      case 'not-json': res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices": [ это не json'); return;
      case 'huge': {
        // тело без content-length, потоком: 200 МБ, если читать до конца
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"choices":[{"message":{"role":"assistant","content":"');
        const chunk = 'x'.repeat(1 << 20);
        let i = 0;
        const pump = () => {
          while (i < 200) {
            if (res.destroyed) return;
            i++; st.sent++;
            if (!res.write(chunk)) { res.once('drain', pump); return; }
          }
          res.end('"}}]}');
        };
        res.on('error', () => {});
        pump();
        return;
      }
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    st, base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/* ── п.1: дети узла — только массивом ─────────────────────────────────────── */

test('brain: документ с children объектом и строкой — команды проходят, а не падают «сбоем модели»', async () => {
  const doc = core.createDoc();
  const art = core.artboards(doc)[0];
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && n.parent === art.id);
  doc.nodes.ip1 = { type: 'image', id: 'ip1', parent: frame.id, name: 'Картинка', children: '#ff0000', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } };
  doc.nodes.tp1 = { type: 'text', id: 'tp1', parent: art.id, name: 'Яд', characters: 'z', style: { token: 'body' }, children: { 0: 'a', length: 1 } };
  frame.children.push('ip1');
  art.children.push('tp1');
  const provider = {
    name: 'f', kind: 'fake', async ready() { return true; },
    async complete(m, s) {
      if (s.name === 'plan') return PLAN_EDIT;
      if (s.name === 'patch') return { summary: 'x', edits: [{ op: 'set', target: 'Яд', path: 'fill', value: '#000000' }, { op: 'set', target: frame.name, path: 'fill', value: '#111111' }] };
      if (s.name === 'tree') return { type: 'frame', name: 'X', children: [{ type: 'text', name: 'a', text: 'b' }] };
      throw new Error('нет ответа ' + s.name);
    },
  };
  for (const [utterance, selection] of [['сделай фон темнее', []], ['сделай фон темнее', [art.id]], ['сделай текст крупнее', ['tp1']], ['удали всё', [art.id]], ['переименуй в Главная', ['tp1']]]) {
    const r = await runCommand({ doc, selection, utterance, provider, engine: core });
    assert.ok(!r.error || r.error.kind !== 'model' && r.error.kind !== 'internal', `${utterance}: ${JSON.stringify(r.error)}`);
  }
});

/* ── K3: внутренняя ошибка ─────────────────────────────────────────────────── */

test('K3: исключение кода — internal, retryable:false, со стеком; ошибки модели — как были', () => {
  const info = toErrorInfo(new TypeError("Cannot read properties of null (reading 'children')"));
  assert.equal(info.kind, 'internal');
  assert.equal(info.code, 'internal');
  assert.equal(info.retryable, false);
  assert.match(info.stack, /TypeError/);
  assert.doesNotMatch(info.message, /children|null/, 'человеку — общая фраза, не текст исключения');
  assert.equal(isInternalError(new RangeError('Maximum call stack size exceeded')), true);
  assert.equal(isInternalError(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })), true);
  // не исключения кода: ответ/отказ модели, отмена, коды способности sample
  assert.equal(toErrorInfo(new Error('модель сказала ерунду')).kind, 'model');
  assert.equal(toErrorInfo(Object.assign(new Error('x'), { code: 'rate_limited' })).kind, 'network');
  assert.equal(toErrorInfo(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind, 'cancelled');
});

test('K3: исключение в воркере — SSE error internal, retryable:false, стек — в лог, не человеку', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const log = captureLog();
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, log, workers: 1 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', __test: 'throw' });
  const e = r.events.find((x) => x.event === 'error');
  assert.ok(e, r.text);
  assert.equal(e.data.code, 'internal');
  assert.equal(e.data.retryable, false);
  assert.doesNotMatch(e.data.message, /children|TypeError|at /);
  assert.ok(log.lines.some((l) => /внутренняя ошибка агента.*TypeError.*children/s.test(l)), log.lines.join('\n'));
  assert.equal(orch.dslv.stats.crashed, 0, 'воркер не падал');
  // модель при этом жива: следующая команда проходит
  const ok = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(ok.events.some((x) => x.event === 'result'), ok.text);
});

/* ── K3: пустой патч ───────────────────────────────────────────────────────── */

test('K3: модель вернула пустой список правок — result с nothingChanged, без записи и без починки', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_EDIT, patch: { summary: 'Ничего', edits: [] } });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'поменяй что-нибудь в заголовке' });
  assert.ok(!r.events.some((e) => e.event === 'error'), r.text);
  const res = r.events.find((e) => e.event === 'result');
  assert.ok(res, r.text);
  assert.equal(res.data.nothingChanged, true);
  assert.equal(res.data.applied, 0);
  assert.equal(res.data.tx_id, null);
  assert.equal(res.data.summary, 'Агент не нашёл, что поменять');
  assert.equal((await journal(document, p.id)).head_seq, 0, 'ничего не записано');
  assert.deepEqual(llm.completions().map((c) => c.schema), ['plan', 'patch'], 'модель не спрашивают второй раз');
});

/* ── K3: негодный ответ модели ─────────────────────────────────────────────── */

test('K3: ответ модели глубокий, не JSON, слишком большой — llm_bad_response быстро; модель не объявлена недоступной', async (t) => {
  const document = await startDocument();
  const llm = await startBadLlm();
  const orch = await startOrch({ document, llm: { baseUrl: llm.base, maxBodyBytes: 1024 * 1024 }, workers: 1 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  for (const mode of ['nested-content', 'nested-body', 'not-json', 'huge']) {
    llm.st.mode = mode;
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const t0 = Date.now();
    const r = await within(command(orch.url, { command_id: cid(mode), project: p.id, text: 'собери экран тарифов' }), 20000, mode);
    clearInterval(iv);
    const ms = Date.now() - t0;
    const e = r.events.find((x) => x.event === 'error');
    assert.ok(e, `${mode}: ${r.text}`);
    assert.equal(e.data.code, 'llm_bad_response', `${mode}: ${JSON.stringify(e.data)}`);
    assert.equal(e.data.retryable, true);
    assert.ok(ms < 10000, `${mode}: ${ms} мс — без ожидания таймаута воркера`);
    if (mode === 'huge') {
      assert.ok(peak - rss0 < 150 * 1024 * 1024, `тело читается с потолком: прирост ${Math.round((peak - rss0) / 1048576)} МБ`);
      assert.ok(llm.st.sent < 200, 'чтение оборвано, а не дочитано до конца');
    }
    // глобального «модель недоступна» нет: здоровье — up, следующая команда идёт к модели
    const h = await call(orch.url, 'GET', '/agent/health');
    assert.equal(h.body.llm, 'up', `${mode}: ${JSON.stringify(h.body)}`);
  }
  assert.equal(orch.dslv.stats.timedOut, 0, 'воркер не ждал 60 с');
  assert.equal(orch.dslv.stats.crashed, 0);
  assert.equal(orch.dslv.stats.spawned, 1, 'воркер не заменялся');
});

test('brain: тело ответа — потоком с потолком; не JSON и не той формы — llm_bad_response, а не «сеть»', async () => {
  const big = new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); },
  }));
  await assert.rejects(readBodyCapped(big, 2 * 1024 * 1024), (e) => e.code === 'llm_bad_response' && e.kind === 'model');
  const declared = new Response('x', { headers: { 'content-length': String(50 * 1024 * 1024) } });
  await assert.rejects(readBodyCapped(declared, 1024), (e) => e.code === 'llm_bad_response');
  assert.equal(await readBodyCapped(new Response('{"a":1}'), 1024), '{"a":1}');
  assert.throws(() => parseBodyJson('{oops'), (e) => e.code === 'llm_bad_response');
  assert.equal(completionText({ choices: [{ message: { content: 'abc' } }] }), 'abc');
  assert.equal(completionText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.throws(() => completionText({ choices: [{ message: { content: deepArray(1000) } }] }), (e) => e.code === 'llm_bad_response');
  assert.equal(modelDataProblem({ a: [{ b: 1 }] }), null);
  assert.match(modelDataProblem(deepArray(200000)), new RegExp(`глубже ${MODEL_DATA_MAX_DEPTH}`));

  // провайдер целиком: не JSON на 200 — ошибка модели с кодом, без повторов «по сети»
  let posts = 0;
  const provider = makeProvider({
    kind: 'openai', baseUrl: 'http://model.test/v1', model: 'm', retryDelay: 0,
    fetch: async () => { posts++; return new Response('<html>502 Bad Gateway</html>', { status: 200 }); },
  });
  await assert.rejects(provider.complete([{ role: 'user', content: 'x' }], null), (e) => e.kind === 'model' && e.code === 'llm_bad_response');
  assert.equal(posts, 1, 'негодный ответ — не повод для сетевого повтора');

  // просили поток, а сервер ответил обычным JSON — читается как JSON, а не «нет JSON»
  const plain = makeProvider({
    kind: 'openai', baseUrl: 'http://model.test/v1', model: 'm', retryDelay: 0,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"да"}' } }] }), { headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(await plain.complete([{ role: 'user', content: 'x' }], null, { onText: () => {} }), { answer: 'да' });
});

/* ── DSLV: передача ответа воркеру ─────────────────────────────────────────── */

test('DSLV: ответ модели не передаётся воркеру — llm_bad_response < 2 с, воркер не заменён', async (t) => {
  const dslv = createDslv({ size: 1, testHooks: true, log: quiet });
  t.after(() => dslv.close());
  await dslv.run({ test: { busyMs: 1 } }, { onLlm: async () => ({ ok: 1 }) });   // прогрев
  for (const [what, answer] of [['неклонируемое значение', () => ({ f: () => 1 })], ['глубокий JSON', () => deepArray(200000)]]) {
    const t0 = Date.now();
    // воркер получает ответ-ошибку и сам заканчивает прогон: результат brain с error
    const r = await within(dslv.run({ test: { llm: true } }, { onLlm: async () => answer() }), 10000, what);
    assert.equal(r.error && r.error.code, 'llm_bad_response', `${what}: ${JSON.stringify(r)}`);
    assert.ok(Date.now() - t0 < 2000, `${what}: ${Date.now() - t0} мс`);
  }
  const ok = await dslv.run({ test: { llm: true } }, { onLlm: async () => ({ ok: 2 }) });
  assert.deepEqual(ok.test.answer, { ok: 2 });
  assert.equal(dslv.stats.spawned, 1, 'воркер тот же');
  assert.equal(dslv.stats.timedOut, 0);
  assert.equal(dslv.stats.crashed, 0);
});

test('DSLV (мутант P13): воркер запущен с потолком кучи — по умолчанию и заданным', async (t) => {
  for (const maxOldMb of [undefined, 64]) {
    const dslv = createDslv({ size: 1, testHooks: true, log: quiet, ...(maxOldMb ? { maxOldMb } : {}) });
    t.after(() => dslv.close());
    const r = await dslv.run({ test: 'heap' }, { onLlm: async () => ({}) });
    const want = maxOldMb || WORKER_MAX_OLD_MB;
    // heap_size_limit = старое поколение + молодое (у нас ≤ 64 МБ, ×3 полупространства)
    assert.ok(r.test.heapLimitMb >= want, `потолок ${r.test.heapLimitMb} МБ при заданных ${want}`);
    assert.ok(r.test.heapLimitMb <= want * 1.25 + 200, `потолок ${r.test.heapLimitMb} МБ при заданных ${want} — завышен`);
    await dslv.close();
  }
});

/* ── K2: причина «документ недоступен» ────────────────────────────────────── */

test('K2: /agent/health — document_reason storage (база сервиса) и unreachable (сервис молчит)', async (t) => {
  let storage = 'down';
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/health' && storage === 'down') {
      res.writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: true, code: 'unavailable', retryable: true, detail: { storage: 'down' } }));
      return;
    }
    if (req.url === '/api/health' && storage === 'broken') {
      res.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway');
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
  const lost = await startOrch({ documentUrl: 'http://127.0.0.1:9' });
  t.after(async () => { await orch.close(); await lost.close(); fake.closeAllConnections(); await new Promise((r) => fake.close(r)); });

  let h = (await call(orch.url, 'GET', '/agent/health')).body;
  assert.equal(h.document, 'down');
  assert.equal(h.document_reason, 'storage');
  // и команда до потока — тем же: 503 document_down с причиной
  const c = await command(orch.url, { command_id: cid(), project: 'p_x', text: 'собери экран тарифов' });
  assert.equal(c.status, 503);
  assert.equal(c.body.code, 'document_down');
  assert.equal(c.body.detail.document_reason, 'storage');

  storage = 'broken';
  h = (await call(orch.url, 'GET', '/agent/health')).body;
  assert.equal(h.document_reason, 'unreachable');

  h = (await call(lost.url, 'GET', '/agent/health')).body;
  assert.equal(h.document, 'down');
  assert.equal(h.document_reason, 'unreachable');

  storage = 'up';
  h = (await call(orch.url, 'GET', '/agent/health')).body;
  assert.equal(h.document, 'up');
  assert.equal('document_reason' in h, false);
});

/* ── слова ─────────────────────────────────────────────────────────────────── */

test('стадия сборки — человеческими словами, без «операций»', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  const stages = r.events.filter((e) => e.event === 'stage').map((e) => `${e.data.label} — ${e.data.detail || ''}`);
  assert.ok(stages.some((s) => /^Прикладываю к макету/.test(s)), stages.join('\n'));
  assert.ok(!stages.some((s) => /операци/i.test(s)), stages.join('\n'));
});

test('not_applied: коротко, без «правка пропущена» и своего совета; hint name_layer — только когда дело в выборе слоя', async (t) => {
  const document = await startDocument();
  const patches = [
    // несколько текстов внутри — непонятно, какому: совет назвать слой уместен
    { edits: [{ op: 'set', target: 'Сводка недели', path: 'style', value: 'h1' }] },
    // слоя нет — тоже
    { edits: [{ op: 'remove', target: 'Подвал сайта' }] },
    // у текста нет раскладки — имя слоя ни при чём
    { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'layout.gap', value: 5 }] },
  ];
  let i = 0;
  const llm = await startFakeLlm({ plan: PLAN_EDIT, patch: () => patches[Math.floor(i++ / 2)] });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const got = [];
  for (let k = 0; k < patches.length; k++) {
    i = k * 2;
    const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'поменяй заголовок' });
    const e = r.events.find((x) => x.event === 'error');
    assert.ok(e, r.text);
    assert.equal(e.data.code, 'not_applied', JSON.stringify(e.data));
    assert.doesNotMatch(e.data.message, /назовите слой|правка пропущена/i, e.data.message);
    assert.ok(e.data.message.length <= 140, `${e.data.message.length}: ${e.data.message}`);
    got.push(e.data);
  }
  assert.match(got[0].message, /^Внутри «Сводка недели» текстовых слоёв — \d+, непонятно, какому задать «стиль текста»\./);
  assert.equal(got[0].detail.hint, 'name_layer');
  assert.equal(got[1].message, 'Слой «Подвал сайта» не найден.');
  assert.equal(got[1].detail.hint, 'name_layer');
  assert.equal(got[1].retryable, false);
  assert.equal(got[2].message, 'У текста «Заголовок экрана» нет зазора.');
  assert.equal(got[2].detail, undefined, 'у текста нет раскладки — совета про имя слоя нет');
});

test('failureReasons/failureHint: без перечня имён и без «пробовал X», если X уже в причине', () => {
  const said = [
    'Внутри «Заголовок и период» текстовых слоёв — 2, непонятно, какому задать «стиль текста»: правка пропущена, назовите слой по имени',
    'Под «Заголовок» подходит слоёв — 3 («Заголовок и период», «Заголовок сводки», «Заголовок таблицы»); правлю «Заголовок и период». Скажите «во всех…», чтобы поправить сразу все.',
  ];
  assert.deepEqual(failureReasons(said), [
    'Внутри «Заголовок и период» текстовых слоёв — 2, непонятно, какому задать «стиль текста».',
    'Под «Заголовок» подходит слоёв — 3.',
  ]);
  assert.equal(failureHint(said), 'name_layer');
  assert.deepEqual(failureReasons(['Внутри «Шапка» нет текста — правка «размер текста» пропущена: назовите слой, который надо поменять']),
    ['Внутри «Шапка» нет текста — «размер текста» задать некому.']);
  assert.equal(failureHint(['У текста «Заголовок экрана» нет раскладки — правка пропущена']), null);
  assert.equal(failureHint(['Поля «fontSize» у узлов этого редактора нет — правка пропущена']), null);
});

/* ── DSLR: запись, которую текущий движок не принимает ───────────────────────── */

test('DSLR: запись, сверенная якорем, но не применимая текущим движком, — пропускается, как у секвенсора', async () => {
  const doc = core.createDoc('empty');
  const page = doc.nodes[doc.root].children[0] || doc.root;
  const txs = [];
  let chain = 'c0';
  const push = (ops) => {
    const seq = txs.length + 1;
    const tx_id = `tx_r31_${seq}`;
    chain = chainNext(chain, tx_id, seq);
    txs.push({ seq, tx_id, chain, ops });
  };
  // запись прежней версии: движок её больше не примет (цели нет) — журнал при этом цел
  push([{ op: 'set', id: 'nope_r31', path: 'name', value: 'x' }]);
  push([{ op: 'create', node: { type: 'frame', id: 'f_r31', name: 'Доска', parent: page, children: [] } }]);
  const net = (withChain) => ({
    async get(path) {
      if (/\/ops\?/.test(path)) return { status: 200, body: { txs: [], more: false, head_seq: 2, tip: chain, epoch: 'e1' } };
      return {
        status: 200,
        body: {
          id: 'p1', name: 'П', kind: 'design', head_seq: 2, epoch: 'e1', more: false,
          snapshot: { seq: 0, doc, ...(withChain ? { chain: 'c0' } : {}) }, tail: txs,
        },
      };
    },
  });
  const log = captureLog();
  const dslr = createDslrClient({ doc: net(true), log });
  const st = await dslr.read('p1');
  assert.equal(st.seq, 2);
  assert.ok(st.doc.nodes.f_r31, 'запись после негодной легла');
  assert.ok(log.lines.some((l) => /seq 1 не применяется текущим движком — пропущена/.test(l)), log.lines.join('\n'));
  assert.equal(dslr.stats.resets, 0, 'без перечитываний по кругу');

  // якоря нет — сверить нечем: как прежде, журнал считается переписанным
  const blind = createDslrClient({ doc: net(false), log: quiet });
  await assert.rejects(blind.read('p1'), (e) => e.code === 'document_failed');
});
