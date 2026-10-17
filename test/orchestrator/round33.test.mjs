/**
 * Круг 33, Orchestrator и brain:
 *   • потолок SSE-потока модели (путь браузерного агента с onText) действует — мутант Q05b;
 *   • `content` ответа модели не текстом (объект) — сразу `llm_bad_response`, без повтора
 *     «по схеме» — и целиком (мутант Q19), и куском потока;
 *   • id модели из `/models` — строкой, чищенный, с пределом длины;
 *   • свои таймауты приёма запроса: медленное тело — 408 timeout, медленные заголовки —
 *     обрыв node; длинный поток SSE под requestTimeout не попадает;
 *   • `/agent/stop` и `/agent/apply` — только своей команды (тот же `client`); чужая
 *     неотличима от неизвестной.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, journal, call, cid, waitFor,
  PLAN_CREATE, TREE_OK,
} from './helpers.mjs';
import { makeProvider, cleanModelId, contentText, MODEL_ID_MAX } from '../../src/brain.js';
import { createLlm } from '../../server/orchestrator/llm/index.js';
import { BODY_TIMEOUT_MS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../../server/orchestrator/limits.js';

const enc = new TextEncoder();
const sseChunk = (content) => enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');

function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open: () => open() };
}

/* ── Q05b: потолок потока ──────────────────────────────────────────────────── */

test('brain (мутант Q05b): поток SSE с onText — с потолком: сверх него llm_bad_response, чтение оборвано', async () => {
  const CHUNK = 64 * 1024;
  const TOTAL = 64;                       // 4 МБ, если читать до конца
  let pulled = 0;
  let cancelled = false;
  let posts = 0;
  const texts = [];
  const provider = makeProvider({
    kind: 'openai', baseUrl: 'http://model.test/v1', model: 'm', retryDelay: 0, maxBodyBytes: 256 * 1024,
    fetch: async () => {
      posts++;
      const body = new ReadableStream({
        pull(c) {
          if (pulled >= TOTAL) { c.close(); return; }
          pulled++;
          // кусок ровно CHUNK байт: строка SSE с дельтой текста
          const head = sseChunk('');
          const pad = CHUNK - head.byteLength;
          c.enqueue(sseChunk('a'.repeat(Math.max(1, pad))));
        },
        cancel() { cancelled = true; },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await assert.rejects(
    provider.complete([{ role: 'user', content: 'x' }], null, { onText: (t) => texts.push(t.length) }),
    (e) => e.kind === 'model' && e.code === 'llm_bad_response' && /больше/.test(e.message),
  );
  assert.equal(posts, 1, 'большой ответ — не повод повторять');
  assert.ok(texts.length > 0, 'шёл именно путь потока (onText звался)');
  assert.ok(pulled <= 8, `чтение оборвано у потолка: прочитано ${pulled} кусков из ${TOTAL}`);
  assert.ok(cancelled, 'поток отменён (соединение закрывается)');
});

/* ── Q19: content не текстом ───────────────────────────────────────────────── */

test('brain (мутант Q19): content объектом — llm_bad_response с первого раза, и целиком, и в потоке', async () => {
  assert.equal(contentText('abc'), 'abc');
  assert.equal(contentText(null), '');
  assert.equal(contentText([{ type: 'text', text: 'a' }, 'b']), 'ab');
  for (const bad of [{ a: 1 }, 5, true, [1], [{ type: 'image' }]]) {
    assert.throws(() => contentText(bad), (e) => e.code === 'llm_bad_response', JSON.stringify(bad));
  }

  const cases = [
    ['целиком', false, () => new Response(JSON.stringify({ choices: [{ message: { content: { intent: 'create' } } }] }), { headers: { 'content-type': 'application/json' } })],
    ['целиком, просили поток', true, () => new Response(JSON.stringify({ choices: [{ message: { content: { intent: 'create' } } }] }), { headers: { 'content-type': 'application/json' } })],
    ['кусок потока', true, () => new Response(new ReadableStream({
      start(c) { c.enqueue(sseChunk('{"a":')); c.enqueue(sseChunk({ intent: 'create' })); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } })],
  ];
  for (const [what, stream, make] of cases) {
    let posts = 0;
    const provider = makeProvider({ kind: 'openai', baseUrl: 'http://model.test/v1', model: 'm', retryDelay: 0, fetch: async () => { posts++; return make(); } });
    const retries = [];
    await assert.rejects(
      provider.complete([{ role: 'user', content: 'x' }], null, { ...(stream ? { onText: () => {} } : {}), onRetry: (r) => retries.push(r.reason) }),
      (e) => e.kind === 'model' && e.code === 'llm_bad_response' && e.retryable === true,
      what,
    );
    assert.equal(posts, 1, `${what}: без повтора «по схеме»`);
    assert.deepEqual(retries, [], what);
  }

  // кусок потока массивом частей — склеивается, как и целый ответ
  const parts = makeProvider({
    kind: 'openai', baseUrl: 'http://model.test/v1', model: 'm', retryDelay: 0,
    fetch: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(sseChunk([{ type: 'text', text: '{"answer":' }])); c.enqueue(sseChunk('"да"}')); c.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.deepEqual(await parts.complete([{ role: 'user', content: 'x' }], null, { onText: () => {} }), { answer: 'да' });
});

test('Orchestrator (Q19): модель отдаёт content объектом — error llm_bad_response, модель зовётся один раз', async (t) => {
  let posts = 0;
  const llmSrv = http.createServer(async (req, res) => {
    for await (const _ of req) { /* дочитать */ }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"m"}]}'); return; }
    posts++;
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: PLAN_CREATE } }] }));
  });
  await new Promise((r) => llmSrv.listen(0, '127.0.0.1', r));
  const document = await startDocument();
  const orch = await startOrch({ document, llm: { baseUrl: `http://127.0.0.1:${llmSrv.address().port}/v1` } });
  t.after(async () => { await orch.close(); await document.close(); llmSrv.closeAllConnections(); await new Promise((r) => llmSrv.close(r)); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('q19'), project: p.id, text: 'собери экран тарифов' });
  const e = r.events.find((x) => x.event === 'error');
  assert.ok(e, r.text);
  assert.equal(e.data.code, 'llm_bad_response', JSON.stringify(e.data));
  assert.equal(posts, 1, 'не «нет JSON» с повтором, а сразу негодный ответ');
  assert.equal((await call(orch.url, 'GET', '/agent/health')).body.llm, 'up');
});

/* ── id модели из /models ──────────────────────────────────────────────────── */

test('id модели из /models: строкой, без управляющих знаков, не длиннее предела', async () => {
  assert.equal(cleanModelId('fake-model'), 'fake-model');
  assert.equal(cleanModelId(' \u0000qwen‮/7b​ '), 'qwen/7b');
  assert.equal(cleanModelId('a\ud800b'), 'ab');
  assert.equal(cleanModelId('A'.repeat(MODEL_ID_MAX)), 'A'.repeat(MODEL_ID_MAX));
  for (const bad of ['A'.repeat(MODEL_ID_MAX + 1), { a: 1 }, ['x'], null, '', '\u0000‮', NaN]) {
    assert.equal(cleanModelId(bad), '', JSON.stringify(bad));
  }

  const models = (id) => async (url) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id }] }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  // Orchestrator: health
  for (const [id, want] of [['A'.repeat(100000), undefined], [{ toString: 'x' }, undefined], ['\u0000fake‮-model', 'fake-model'], [42, '42']]) {
    const llm = createLlm({ baseUrl: 'http://model.test/v1', fetch: models(id) });
    const h = await llm.health();
    assert.equal(h.llm, 'up');
    assert.equal(h.model, want, `id ${JSON.stringify(id).slice(0, 40)}`);
    assert.equal(llm.model || undefined, want);
    assert.equal(llm.provider.model || undefined, want);
  }
  // brain (браузер): ready() — тот же предел, запрос идёт с моделью по умолчанию
  const seen = [];
  const provider = makeProvider({
    kind: 'openai', baseUrl: 'http://model.test/v1', retryDelay: 0,
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) return models('B'.repeat(5000))(url);
      seen.push(JSON.parse(init.body).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(await provider.ready(), true);
  assert.equal(provider.model, null);
  await provider.complete([{ role: 'user', content: 'x' }], null);
  assert.deepEqual(seen, ['local-model']);
});

/* ── таймауты приёма запроса ───────────────────────────────────────────────── */

/** Сырой запрос: заголовки и часть тела, дальше — тишина. → {status, text, closed} */
function slowRequest(port, { head, body = '', waitMs = 8000 }) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    const t0 = Date.now();
    const timer = setTimeout(() => { sock.destroy(); resolve({ data, closed: false, ms: Date.now() - t0 }); }, waitMs);
    sock.on('data', (d) => { data += d; });
    sock.on('close', () => { clearTimeout(timer); resolve({ data, closed: true, ms: Date.now() - t0 }); });
    sock.on('error', () => {});
    sock.write(head + body);
  });
}

test('таймауты: медленное тело — 408 timeout и закрытие; медленные заголовки — обрыв; поток SSE дольше requestTimeout не режется', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK }, { delayMs: 700 });
  const orch = await startOrch({
    document, llm: { baseUrl: llm.base },
    bodyTimeoutMs: 400, headersTimeoutMs: 300, requestTimeoutMs: 600, connectionsCheckingIntervalMs: 100,
  });
  const dflt = await startOrch({ document });
  t.after(async () => { await orch.close(); await dflt.close(); await document.close(); await llm.close(); });

  // умолчания — свои, а не node (300 с на запрос)
  assert.equal(dflt.server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(dflt.server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.ok(BODY_TIMEOUT_MS < REQUEST_TIMEOUT_MS, 'свой таймер тела срабатывает раньше node и отвечает JSON');
  assert.ok(REQUEST_TIMEOUT_MS <= 60000);

  // тело заявлено на 100 байт, пришло 10 — 408 с кодом timeout, соединение закрыто
  const slow = await slowRequest(orch.port, {
    head: 'POST /agent/stop HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n',
    body: '{"command_',
  });
  assert.match(slow.data, /^HTTP\/1\.1 408/, slow.data);
  assert.match(slow.data, /"code":"timeout"/);
  assert.match(slow.data, /"limit":"body_timeout"/);
  assert.ok(slow.closed, 'соединение закрыто');
  assert.ok(slow.ms < 5000, `${slow.ms} мс`);

  // заголовки не дошли — node закрывает соединение (408) по headersTimeout
  const heads = await slowRequest(orch.port, { head: 'POST /agent/stop HTTP/1.1\r\nHost: x\r\n' });
  assert.ok(heads.closed, 'медленные заголовки не держат сокет');
  assert.ok(heads.ms < 5000, `${heads.ms} мс`);

  // команда идёт дольше requestTimeout (модель отвечает 0,7 с × 2) — поток не обрывается
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('long'), project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result'), r.text);
  assert.equal(r.events[r.events.length - 1].event, 'done');
});

/* ── чья команда ───────────────────────────────────────────────────────────── */

test('stop и apply — только своей команды: чужой client неотличим от неизвестного id', async (t) => {
  const document = await startDocument();
  const g = gate();
  let gated = true;
  const llm = await startFakeLlm({
    plan: PLAN_CREATE,
    tree: () => ({ ...TREE_OK, name: `Экран ${llm.completions().length}` }),
  });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { g.open(); await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  // стоп: команда вкладки tab_A ждёт модель
  llm.state.gate = g.promise;
  const id = cid('own');
  const s = commandStream(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', client: 'tab_A' });
  await waitFor(() => llm.completions().length === 1);
  for (const body of [{ command_id: id, client: 'tab_B' }, { command_id: id }, { command_id: id, client: null }]) {
    const r = await call(orch.url, 'POST', '/agent/stop', body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { stopped: false }, JSON.stringify(body));
  }
  const unknown = await call(orch.url, 'POST', '/agent/stop', { command_id: 'nope', client: 'tab_B' });
  assert.deepEqual(unknown.body, { stopped: false }, 'тот же ответ, что у неизвестной');
  assert.equal((await call(orch.url, 'POST', '/agent/stop', { command_id: id, client: 'A'.repeat(129) })).status, 400);
  assert.equal((await call(orch.url, 'POST', '/agent/stop', { command_id: id, client: 5 })).status, 400);
  assert.ok(!s.events.some((e) => e.event === 'error'), 'чужой стоп команду не тронул');
  const mine = await call(orch.url, 'POST', '/agent/stop', { command_id: id, client: 'tab_A' });
  assert.deepEqual(mine.body, { stopped: true });
  assert.equal((await s.until((e) => e.event === 'error')).data.code, 'cancelled');
  await s.until((e) => e.event === 'done');
  llm.state.gate = null;
  g.open();
  gated = false;

  // команда без client — останавливается только запросом без client
  const g2 = gate();
  llm.state.gate = g2.promise;
  const id2 = cid('anon');
  const s2 = commandStream(orch.url, { command_id: id2, project: p.id, text: 'собери экран тарифов' });
  await waitFor(() => llm.completions().length >= 2);
  assert.deepEqual((await call(orch.url, 'POST', '/agent/stop', { command_id: id2, client: 'tab_X' })).body, { stopped: false });
  assert.deepEqual((await call(orch.url, 'POST', '/agent/stop', { command_id: id2 })).body, { stopped: true });
  await s2.until((e) => e.event === 'done');
  llm.state.gate = null;
  g2.open();

  // apply: варианты вкладки tab_A
  const vid = cid('v');
  const r = await command(orch.url, { command_id: vid, project: p.id, text: 'собери экран тарифов', mode: 'variants', n: 2, client: 'tab_A' });
  const v = r.events.find((e) => e.event === 'variants');
  assert.ok(v, r.text);
  const none = await call(orch.url, 'POST', '/agent/apply', { command_id: 'nope', variant: 0, client: 'tab_B' });
  assert.equal(none.status, 404);
  for (const body of [{ command_id: vid, variant: 0, client: 'tab_B' }, { command_id: vid, variant: 0 }]) {
    const a = await call(orch.url, 'POST', '/agent/apply', body);
    assert.equal(a.status, 404, JSON.stringify(body));
    assert.deepEqual(a.body, none.body, 'чужой — слово в слово как неизвестный');
  }
  assert.equal((await journal(document, p.id)).head_seq, 0, 'чужой apply ничего не записал');
  const ok = await call(orch.url, 'POST', '/agent/apply', { command_id: vid, variant: 0, client: 'tab_A' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.seq, 1);
  const j = await journal(document, p.id);
  assert.equal(j.txs[0].client, 'tab_A');
  // и повтор чужим после записи — всё так же 404, без чужого result
  const after = await call(orch.url, 'POST', '/agent/apply', { command_id: vid, variant: 0, client: 'tab_B' });
  assert.equal(after.status, 404);
  assert.ok(!gated);
});
