/**
 * Клиент Orchestrator (src/agent.js) и словарь оболочки (src/shell.js) — SPEC §10.
 * Сервер агента здесь поддельный: node:http на случайном порту отдаёт SSE так, как
 * его отдаёт настоящий, — кусками, с разрывами, с ошибками единого формата.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createSSEParser, parseRetryAfter, runServerCommand, stop, apply, health,
  newCommandId, AgentError, isUpstreamDown, createAgentClient,
} from '../src/agent.js';
import {
  decideAgentMode, serverStageRec, shellIntentFromServer, normalizeResult,
  variantsFromServer, agentErrorWords, isModelError, queuedLabel, AGENT_MODE_WORDS,
  agentHealthNotice, agentModeTitle, AGENT_DOWN_WORDS, detachedLostWords, droppedWords, whoDid,
  presenceAgentWords, cutText, cleanText, isJargon,
} from '../src/shell.js';
import * as core from '../src/core.js';

/* ------------------------------ поддельный сервер ------------------------------ */

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Сервер с маршрутами: handler(req, body, res). Пишет журнал запросов. */
async function fakeServer(routes) {
  const log = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const path = req.url.split('?')[0];
    log.push({ method: req.method, path, body, headers: req.headers });
    const h = routes[`${req.method} ${path}`];
    if (!h) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: true, code: 'not_found', message: 'нет', retryable: false }));
      return;
    }
    await h(req, body, res, log);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl, log,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

function streamHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------ SSE ------------------------------------ */

test('SSE: куски как угодно, CRLF и CR, многострочный data, комментарии', () => {
  const got = [];
  const p = createSSEParser((e) => got.push(e));
  const text = ': пульс\r\nevent: stage\r\ndata: {"key":"jev"}\r\n\r\n'
    + 'event: result\rdata: {"a":1,\rdata: "b":2}\r\r'
    + 'data: просто\n\n'
    + 'event: done\ndata: {}\n\n';
  // режем по одному знаку — разбор не должен зависеть от границ кусков
  for (const ch of text) p.push(ch);
  assert.deepEqual(got.map((e) => e.event), ['stage', 'result', 'message', 'done']);
  assert.equal(got[0].data, '{"key":"jev"}');
  assert.equal(got[1].data, '{"a":1,\n"b":2}');
  assert.equal(got[2].data, 'просто');
});

test('SSE: недописанное событие без пустой строки не отдаётся', () => {
  const got = [];
  const p = createSSEParser((e) => got.push(e));
  p.push('event: stage\ndata: {}\n');
  p.end();
  assert.equal(got.length, 0);
});

test('Retry-After: секунды, дата, мусор', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('0.5'), 500);
  const now = Date.parse('2026-10-14T10:00:00Z');
  assert.equal(parseRetryAfter('Wed, 14 Oct 2026 10:00:07 GMT', now), 7000);
  assert.equal(parseRetryAfter('потом'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('id команды: префикс и 12 знаков base36, без повторов', () => {
  const a = new Set();
  for (let i = 0; i < 500; i++) a.add(newCommandId());
  assert.equal(a.size, 500);
  for (const id of a) assert.match(id, /^cmd_[0-9a-z]{12}$/);
});

/* ------------------------------ команда целиком ------------------------------ */

test('команда: тело по контракту, стадии по порядку, итог и done', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('queued', { position: 1 }));
      await wait(10);
      for (const key of ['jev', 'read', 'llm', 'validate', 'write']) {
        // кусками: событие пополам
        const s = sse('stage', { key, label: key, at: new Date().toISOString() });
        res.write(s.slice(0, 7));
        await wait(2);
        res.write(s.slice(7));
      }
      res.write(sse('result', { tx_id: 'tx_abc', seq: 7, applied: 3, dropped: [], summary: 'Готово', warnings: ['w'], select: ['n1'] }));
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  const events = [];
  const out = await runServerCommand({
    baseUrl: srv.baseUrl, project: 'p1', text: 'сделай кнопку синей', selection: ['n1'], board: 'ab1',
    base_seq: 6, client: 'c1', author: 'Аня', mode: 'run', onEvent: (e) => events.push(e.type),
  });
  assert.equal(out.status, 'done');
  assert.equal(out.result.tx_id, 'tx_abc');
  assert.deepEqual(out.result.select, ['n1']);
  assert.equal(out.queued, 1);
  assert.deepEqual(out.stages.map((s) => s.key), ['jev', 'read', 'llm', 'validate', 'write']);
  assert.deepEqual(events, ['queued', 'stage', 'stage', 'stage', 'stage', 'stage', 'result', 'done']);
  const req = srv.log[0];
  assert.equal(req.body.project, 'p1');
  assert.equal(req.body.text, 'сделай кнопку синей');
  assert.deepEqual(req.body.selection, ['n1']);
  assert.equal(req.body.board, 'ab1');
  assert.equal(req.body.base_seq, 6);
  assert.equal(req.body.client, 'c1');
  assert.equal(req.body.mode, 'run');
  assert.match(req.body.command_id, /^cmd_/);
  assert.equal(out.command_id, req.body.command_id);
  // кириллица в заголовке — только процентно закодированной (§9.7)
  assert.equal(decodeURIComponent(req.headers['x-author']), 'Аня');
  assert.match(req.headers.accept, /text\/event-stream/);
});

test('варианты и команда оболочки — итоговые события', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      if (body.mode === 'variants') {
        res.write(sse('variants', { items: [{ key: 'a', label: 'Строгий', description: 'd', ops_count: 2, preview: null }] }));
      } else {
        res.write(sse('shell', { action: 'undo', args: { times: 2 } }));
      }
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  const v = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'три варианта', mode: 'variants', n: 3 });
  assert.equal(v.status, 'done');
  assert.equal(v.variants.length, 1);
  assert.equal(srv.log[0].body.n, 3);
  const s = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'отмени два раза' });
  assert.deepEqual(s.shell, { action: 'undo', args: { times: 2 } });
});

test('память разговора уходит в /agent/command: до пяти пар, строки до 500 символов', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('result', { tx_id: null, seq: null, applied: 0, summary: 'ok' }));
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  const history = Array.from({ length: 7 }, (_, i) => ({ utterance: `реплика ${i}`, summary: `итог ${i}` }));
  history.push({ utterance: 'ж'.repeat(800), summary: 'и'.repeat(800) });
  history.push({ summary: 'без реплики' });
  await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'а теперь синее', history, command_id: 'cmd_h' });
  const sent = srv.log[0].body;
  assert.equal(sent.command_id, 'cmd_h');
  assert.equal(sent.history.length, 5);
  assert.equal(sent.history[0].utterance, 'реплика 3');
  assert.ok(sent.history.every((h) => h.utterance.length <= 500 && h.summary.length <= 500));
  assert.equal(sent.history[4].utterance.length, 500);
  // без памяти поле не шлётся вовсе
  await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'сделай', history: [] });
  assert.ok(!('history' in srv.log[1].body));
});

test('разрыв потока — не провал: исход detached, без исключения', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('stage', { key: 'llm', label: 'Думаю' }));
      await wait(20);
      res.socket.destroy();   // nginx перезапустили посреди команды
    },
  });
  t.after(() => srv.close());
  const out = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x' });
  assert.equal(out.status, 'detached');
  assert.equal(out.stages.length, 1);
  assert.equal(out.result, null);
});

test('итог пришёл, а done — нет: команда всё равно выполнена', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('result', { tx_id: 't', seq: 1, applied: 1, dropped: [], summary: 's', warnings: [] }));
      await wait(10);
      res.socket.destroy();
    },
  });
  t.after(() => srv.close());
  const out = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x' });
  assert.equal(out.status, 'done');
  assert.equal(out.result.tx_id, 't');
});

test('тишина в потоке дольше idleMs — разрыв, исход detached', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('stage', { key: 'llm' }));
      // дальше молчим
    },
  });
  t.after(() => srv.close());
  const out = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x', idleMs: 150 });
  assert.equal(out.status, 'detached');
});

test('событие error — исход error, команда принята', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('stage', { key: 'llm' }));
      res.write(sse('error', { code: 'llm_failed', message: 'модель вернула мусор', retryable: true }));
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  const out = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x' });
  assert.equal(out.status, 'error');
  assert.ok(out.error instanceof AgentError);
  assert.equal(out.error.code, 'llm_failed');
  assert.equal(out.error.accepted, true);
  assert.equal(out.error.retryable, true);
});

test('503 с коротким Retry-After — повтор сам, событие retry', async (t) => {
  let n = 0;
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      n += 1;
      if (n === 1) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: true, code: 'document_down', message: 'документ недоступен', retryable: true }));
        return;
      }
      streamHead(res);
      res.write(sse('result', { tx_id: 't', seq: 1, applied: 1, dropped: [], summary: 's', warnings: [] }));
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  const types = [];
  const out = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x', onEvent: (e) => types.push(e.type) });
  assert.equal(out.status, 'done');
  assert.equal(n, 2);
  assert.equal(types[0], 'retry');
  // повтор — с тем же command_id
  assert.equal(srv.log[0].body.command_id, srv.log[1].body.command_id);
});

test('429 с долгим Retry-After — ошибка с паузой, без повтора, команда не принята', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: true, code: 'busy', message: 'очередь проекта полна', retryable: true }));
    },
  });
  t.after(() => srv.close());
  await assert.rejects(
    runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x' }),
    (e) => e instanceof AgentError && e.code === 'busy' && e.status === 429 && e.retryAfterMs === 30000
      && e.accepted === false && !isUpstreamDown(e),
  );
  assert.equal(srv.log.length, 1);
});

test('апстрим лежит (ответ nginx) — upstream orchestrator, без повтора', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      res.writeHead(502, { 'content-type': 'application/json', 'x-imago-upstream': 'down', 'retry-after': '0' });
      res.end(JSON.stringify({ error: true, code: 'upstream_down', message: 'сервис агента недоступен', retryable: true, upstream: 'orchestrator' }));
    },
  });
  t.after(() => srv.close());
  await assert.rejects(
    runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x' }),
    (e) => e.upstream === 'orchestrator' && isUpstreamDown(e) && e.accepted === false,
  );
  assert.equal(srv.log.length, 1);
});

test('502 без тела, только заголовок X-Imago-Upstream — тоже «апстрим лежит»', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      res.writeHead(502, { 'content-type': 'text/html', 'x-imago-upstream': 'down' });
      res.end('<html>bad gateway</html>');
    },
  });
  t.after(() => srv.close());
  await assert.rejects(runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x' }), (e) => isUpstreamDown(e) && e.status === 502);
});

test('сервер не слушает — network, команда не принята', async () => {
  const srv = await fakeServer({});
  const base = srv.baseUrl;
  await srv.close();
  await assert.rejects(
    runServerCommand({ baseUrl: base, project: 'p', text: 'x' }),
    (e) => e.code === 'network' && e.accepted === false && isUpstreamDown(e),
  );
});

test('«стоп» посреди потока — /agent/stop с тем же command_id и исключение cancelled', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('stage', { key: 'llm' }));
      // дальше думает долго
    },
    'POST /agent/stop': async (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stopped: true }));
    },
  });
  t.after(() => srv.close());
  const ctrl = new AbortController();
  const p = runServerCommand({
    baseUrl: srv.baseUrl, project: 'p', text: 'x', signal: ctrl.signal,
    onEvent: (e) => { if (e.type === 'stage') setTimeout(() => ctrl.abort(), 10); },
  });
  await assert.rejects(p, (e) => e.code === 'cancelled' && e.name === 'AbortError' && e.kind === 'cancelled');
  const cmd = srv.log.find((r) => r.path === '/agent/command');
  const st = srv.log.find((r) => r.path === '/agent/stop');
  assert.ok(st, 'стоп ушёл на сервер');
  assert.equal(st.body.command_id, cmd.body.command_id);
});

test('«стоп» до отправки — исключение сразу, сеть не трогается', async (t) => {
  const srv = await fakeServer({});
  t.after(() => srv.close());
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(runServerCommand({ baseUrl: srv.baseUrl, project: 'p', text: 'x', signal: ctrl.signal }), (e) => e.code === 'cancelled');
  assert.equal(srv.log.length, 0);
});

test('stop(): ответ сервера и сбой связи не бросают', async (t) => {
  const srv = await fakeServer({
    'POST /agent/stop': async (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stopped: body.command_id === 'cmd_1' }));
    },
  });
  t.after(() => srv.close());
  assert.deepEqual(await stop('cmd_1', { baseUrl: srv.baseUrl }), { stopped: true });
  assert.deepEqual(await stop('cmd_2', { baseUrl: srv.baseUrl }), { stopped: false });
  const r = await stop('cmd_1', { baseUrl: 'http://127.0.0.1:1' });
  assert.equal(r.stopped, false);
  assert.ok(r.error);
});

test('apply(): итог — голым JSON или обёрнутым; ошибка — исключением', async (t) => {
  const srv = await fakeServer({
    'POST /agent/apply': async (req, body, res) => {
      if (body.variant === 'bad') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: true, code: 'not_found', message: 'вариантов этой команды нет', retryable: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const r = { tx_id: 'tx_v', seq: 3, applied: 2, dropped: [], summary: 'вариант', warnings: [] };
      res.end(JSON.stringify(body.variant === 'wrapped' ? { event: 'result', data: r } : r));
    },
  });
  t.after(() => srv.close());
  const a = await apply('cmd_x', 'a', { baseUrl: srv.baseUrl });
  assert.equal(a.tx_id, 'tx_v');
  const b = await apply('cmd_x', 'wrapped', { baseUrl: srv.baseUrl });
  assert.equal(b.tx_id, 'tx_v');
  assert.deepEqual(srv.log[0].body, { command_id: 'cmd_x', variant: 'a' });
  await assert.rejects(apply('cmd_x', 'bad', { baseUrl: srv.baseUrl }), (e) => e.code === 'not_found' && e.retryable === false);
});

test('health(): ответ агента, чужая страница, апстрим лежит, нет сервера', async (t) => {
  let mode = 'ok';
  const srv = await fakeServer({
    'GET /agent/health': async (req, body, res) => {
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, engine: 5, llm: 'up', document: 'up', model: 'qwen' }));
      } else if (mode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>не агент</title>');
      } else {
        res.writeHead(502, { 'content-type': 'application/json', 'x-imago-upstream': 'down' });
        res.end(JSON.stringify({ error: true, code: 'upstream_down', message: 'нет', retryable: true, upstream: 'orchestrator' }));
      }
    },
  });
  t.after(() => srv.close());
  assert.deepEqual(await health({ baseUrl: srv.baseUrl }), { ok: true, engine: 5, llm: 'up', document: 'up', model: 'qwen' });
  mode = 'html';
  assert.equal((await health({ baseUrl: srv.baseUrl })).ok, false);
  mode = 'down';
  const d = await health({ baseUrl: srv.baseUrl });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'upstream-down');
  const n = await health({ baseUrl: 'http://127.0.0.1:1' });
  assert.equal(n.ok, false);
});

test('createAgentClient: автор берётся при каждом вызове', async (t) => {
  const srv = await fakeServer({
    'POST /agent/stop': async (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"stopped":true}');
    },
  });
  t.after(() => srv.close());
  let who = 'Иван';
  const c = createAgentClient({ baseUrl: srv.baseUrl, author: () => who });
  await c.stop('cmd_1');
  who = 'Мария';
  await c.stop('cmd_1');
  assert.deepEqual(srv.log.map((r) => decodeURIComponent(r.headers['x-author'])), ['Иван', 'Мария']);
});

/* --------------------------------- shell.js --------------------------------- */

test('режим агента: решает /agent/health, а не сокет документа; модель браузера — только своя', () => {
  const up = { ok: true, llm: 'up', document: 'up' };
  assert.equal(decideAgentMode({ inProject: true, health: up, hasProvider: false }), 'server');
  assert.equal(decideAgentMode({ inProject: true, health: up, hasProvider: true }), 'server');
  // проект открыт локально (артефакт) — прежний путь
  assert.equal(decideAgentMode({ inProject: false, health: up, hasProvider: true }), 'browser');
  assert.equal(decideAgentMode({ inProject: false, health: up, hasProvider: false }), 'off');
  // круг 25 (ревью Д5): реплика переподключается к Hub — Orchestrator жив, агент остаётся на сервере
  assert.equal(decideAgentMode({ inProject: true, online: false, health: up, hasProvider: true }), 'server');
  assert.equal(decideAgentMode({ inProject: true, online: false, health: up, hasProvider: false }), 'server');
  // Orchestrator молчит: своей модели нет — «недоступен», а не «в браузере» (п.1)
  assert.equal(decideAgentMode({ inProject: true, health: { ok: false }, hasProvider: false }), 'off');
  assert.equal(decideAgentMode({ inProject: true, health: null, hasProvider: false }), 'off');
  assert.equal(decideAgentMode({ inProject: true, health: { ok: false }, hasProvider: true }), 'browser');
  // у сервера лежит модель или документ: своя модель выручит, без неё — пусть скажет сервер
  assert.equal(decideAgentMode({ inProject: true, health: { ...up, document: 'down' }, hasProvider: true }), 'browser');
  assert.equal(decideAgentMode({ inProject: true, health: { ...up, document: 'down' }, hasProvider: false }), 'server');
  assert.equal(decideAgentMode({ inProject: true, health: { ...up, llm: 'unconfigured' }, hasProvider: true }), 'browser');
  assert.equal(decideAgentMode({ inProject: true, health: { ...up, llm: 'down' }, hasProvider: true }), 'browser');
  assert.equal(decideAgentMode({ inProject: true, health: { ...up, llm: 'down' }, hasProvider: false }), 'server');
  assert.equal(AGENT_MODE_WORDS.server, 'агент: сервер');
  assert.equal(AGENT_MODE_WORDS.browser, 'агент: в браузере');
  assert.equal(AGENT_MODE_WORDS.off, 'агент недоступен');
  // подсказки — без адресов и советов администратору
  for (const t of [
    agentModeTitle('server', up), agentModeTitle('server', { ...up, llm: 'down' }), agentModeTitle('server', { ...up, document: 'down' }),
    agentModeTitle('browser', { ok: false }, 'LM Studio'), agentModeTitle('off', { ok: false }),
  ]) {
    assert.ok(!/LM Studio запущ|https?:|localhost|\d{3}/.test(t), t);
  }
  assert.match(agentModeTitle('off', { ok: false }), /Правки руками сохраняются/);
});

test('смена ответа /agent/health — слова только по нему и с верным сервисом', () => {
  const up = { ok: true, llm: 'up', document: 'up' };
  // первый ответ и смена проекта (тот же ответ) — молчим
  assert.equal(agentHealthNotice(null, up), null);
  assert.equal(agentHealthNotice(up, { ...up }), null);
  assert.equal(agentHealthNotice({ ok: false }, { ok: false, reason: 'timeout' }), null);
  assert.match(agentHealthNotice(up, { ok: false }).text, /^Сервер агента не отвечает/);
  assert.match(agentHealthNotice(up, { ok: false }, { hasProvider: true }).text, /в браузере/);
  // документ лежит — так и сказано, а не «сервер агента недоступен»
  const nodoc = agentHealthNotice(up, { ...up, document: 'down' }).text;
  assert.match(nodoc, /сервер документа/);
  assert.ok(!/агента не отвечает/.test(nodoc));
  assert.match(agentHealthNotice(up, { ...up, llm: 'down' }).text, /Модель на сервере не отвечает — попробуйте позже/);
  const back = agentHealthNotice({ ok: false }, up);
  assert.ok(back.back);
  assert.match(back.text, /снова/);
  assert.match(AGENT_DOWN_WORDS.title, /^Сервер агента не отвечает — команда не выполнена$/);
  assert.match(AGENT_DOWN_WORDS.note, /Правки руками сохраняются/);
});

test('поток оборвался, транзакции нет — команда не выполнена, и почему', () => {
  assert.equal(detachedLostWords('собери экран тарифов', 'restarted').title, 'Команда «собери экран тарифов» не выполнена — сервер агента перезапустился');
  assert.match(detachedLostWords('x', 'down').title, /сервер агента не отвечает$/);
  assert.match(detachedLostWords('x', 'silent').title, /ответа от сервера агента нет$/);
  assert.match(detachedLostWords('x').note, /вернулся в строку/);
  const long = detachedLostWords('😀'.repeat(100)).title;
  assert.ok(!/\uD83D(?!\uDE00)/.test(long), 'эмодзи разрезан пополам');
});

test('стадии и очередь словами', () => {
  assert.deepEqual(serverStageRec({ key: 'llm', label: 'Спрашиваю модель' }), { stage: 'srv:llm', label: 'Спрашиваю модель' });
  assert.equal(serverStageRec({ key: 'validate' }).label, 'Проверяю раскладку');
  assert.equal(serverStageRec({}).label, 'Агент работает');
  assert.equal(queuedLabel(0), 'В очереди проекта');
  assert.equal(queuedLabel(2), 'В очереди проекта: впереди 2 команды');
  assert.equal(queuedLabel(5), 'В очереди проекта: впереди 5 команд');
  // круг 25: чья команда впереди — по присутствию
  assert.equal(queuedLabel(1, ['Аня']), 'В очереди проекта: впереди 1 команда (Аня)');
  assert.equal(queuedLabel(3, ['Аня', 'Борис', 'Вера']), 'В очереди проекта: впереди 3 команды (Аня, Борис и ещё 1)');
  assert.equal(queuedLabel(0, ['Аня']), 'В очереди проекта: впереди команда (Аня)');
  // круг 27: ждём свободного исполнителя агента — не очередь проекта
  assert.equal(queuedLabel(3, ['Аня'], 'workers'), 'Ждёт свободного исполнителя агента…');
  assert.equal(queuedLabel(2, [], 'project'), 'В очереди проекта: впереди 2 команды');
  assert.equal(presenceAgentWords({ author: 'Аня', queued: 2 }), 'Аня ждёт агента…');
  assert.equal(presenceAgentWords({ author: 'Аня', busy: true }), 'Аня: агент работает…');
  assert.equal(presenceAgentWords({ author: 'Аня', busy: false, queued: false }), '');
  assert.equal(presenceAgentWords({ busy: true, queued: true }), 'Без имени ждёт агента…');
});

test('команды оболочки от JEV — в намерения оболочки', () => {
  assert.deepEqual(shellIntentFromServer({ action: 'undo', args: { times: 3 } }), { kind: 'undo', times: 3 });
  assert.deepEqual(shellIntentFromServer({ action: 'redo' }), { kind: 'redo', times: 1 });
  assert.deepEqual(shellIntentFromServer({ action: 'select', args: { ids: ['a', 1, 'b'] } }), { kind: 'select', ids: ['a', 'b'] });
  assert.deepEqual(shellIntentFromServer({ action: 'zoom', args: { to: 100 } }), { kind: 'zoom', to: 1 });
  assert.deepEqual(shellIntentFromServer({ action: 'fit', args: { all: true } }), { kind: 'fit', all: true });
  assert.deepEqual(shellIntentFromServer({ action: 'new_board' }), { kind: 'new-board' });
  assert.deepEqual(shellIntentFromServer({ action: 'export', args: { format: 'PNG' } }), { kind: 'export', what: 'png' });
  assert.deepEqual(shellIntentFromServer({ action: 'board', args: { index: 1 } }), { kind: 'artboard', index: 1 });
  assert.equal(shellIntentFromServer({ action: 'взлетай' }), null);
  assert.equal(shellIntentFromServer(null), null);
});

test('итог сервера: applied и dropped числом и списком', () => {
  const a = normalizeResult({ tx_id: 't', seq: 2, applied: [{}, {}], dropped: [{ index: 0, reason: 'removed' }], summary: ' s ', warnings: ['w', ''], select: ['x', 3] });
  assert.equal(a.applied, 2);
  assert.equal(a.droppedCount, 1);
  assert.equal(a.summary, 's');
  assert.deepEqual(a.warnings, ['w']);
  assert.deepEqual(a.select, ['x']);
  const b = normalizeResult({ applied: 0, dropped: 0, summary: 'это кнопка' });
  assert.equal(b.txId, '');
  assert.equal(b.applied, 0);
  // круг 27: title — что сделано (tx.title), отдельно от пересказа модели
  assert.equal(b.title, '');
  assert.equal(normalizeResult({ tx_id: 't', summary: 'Готово, сделал', title: ' Добавил «Экран тарифов» новой доской ' }).title, 'Добавил «Экран тарифов» новой доской');
  assert.equal(normalizeResult({ title: 5 }).title, '');
});

test('варианты сервера: превью своим движком из операций или документа', () => {
  const doc = core.createDoc();
  const ab = core.artboards(doc)[0];
  const ops = [core.ops.set(ab.id, 'name', 'Новое имя')];
  const list = variantsFromServer([
    { key: 'a', label: 'Первый', description: 'имя', ops_count: 1, preview: { ops } },
    { key: 'b', label: 'Второй', ops_count: 0, preview: { doc } },
    { label: 'Без превью', ops_count: 4 },
    { key: 'd', label: 'Негодный', preview: { ops: [{ op: 'remove', id: 'нет-такого' }] } },
  ], { doc, core, commandId: 'cmd_1' });
  assert.equal(list.length, 4);
  assert.equal(list[0].preview.doc.nodes[ab.id].name, 'Новое имя');
  assert.ok(list[0].preview.geo.rects[ab.id]);
  assert.deepEqual(list[0].server, { command_id: 'cmd_1', key: 'a' });
  assert.ok(list[1].preview.geo);
  assert.equal(list[2].preview, null);
  assert.equal(list[2].opsCount, 4);
  assert.equal(list[2].server.key, 2);
  assert.equal(list[3].preview, null);
});

test('ошибки сервера агента словами', () => {
  const busy = agentErrorWords({ code: 'busy', message: 'очередь полна', retryAfterMs: 12000 });
  assert.match(busy.title, /занят/);
  assert.equal(busy.waitMs, 12000);   // срок считает кнопка «Повторить через N с»
  // круг 25, п.7: человеку в браузере — не советы администратору и не служебное
  const llm = agentErrorWords({ code: 'llm_down', message: 'Модель не отвечает — команда не выполнена. Проверьте, что сервер модели запущен, и повторите.', retryAfterMs: 10000 });
  assert.equal(llm.title, 'Модель на сервере не отвечает');
  assert.ok(!/LM Studio|запущ/.test(llm.title + llm.note), llm.note);
  assert.equal(llm.waitMs, 10000);
  assert.match(llm.note, /^Попробуйте позже$/);
  // пауза nginx за упавшим сервисом — не предохранитель: ждать нечего
  assert.equal(agentErrorWords({ code: 'upstream_down', retryAfterMs: 5000 }).waitMs, 0);
  assert.match(agentErrorWords({ code: 'llm_down' }).note, /Попробуйте позже/);
  for (const code of ['upstream_down', 'network']) {
    const w = agentErrorWords({ code, message: 'Failed to fetch' });
    assert.equal(w.title, AGENT_DOWN_WORDS.title);
    assert.ok(!/fetch|orchestrator|контейнер/i.test(w.title + w.note), w.note);
  }
  // неизвестный код со служебным текстом — свои слова
  const odd = agentErrorWords({ code: 'weird', message: 'TypeError: Failed to fetch http://127.0.0.1:8090/agent/command 503' });
  assert.ok(!/fetch|http|503/i.test(odd.title + odd.note), odd.title);
  // человеческое объяснение сервера у знакомого кода сохраняется
  assert.match(agentErrorWords({ code: 'too_large', message: 'Правка слишком большая: 6000 операций при пределе 5000' }).note, /6000 операций/);
  assert.ok(isModelError({ code: 'llm_down' }));
  assert.ok(!isModelError({ code: 'busy' }));
  assert.equal(agentErrorWords({ code: 'странное', message: 'своё сообщение' }).title, 'своё сообщение');
});

/* ------------------------------ круг 27 ------------------------------ */

test('круг 27, I6: selection_by уходит серверу, мусор — нет', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('result', { tx_id: 'tx_s', seq: 1, applied: 1, dropped: [], summary: 'ок' }));
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  await runServerCommand({ baseUrl: srv.baseUrl, project: 'p1', text: 'а теперь синее', selection: ['n1'], selection_by: 'agent' });
  await runServerCommand({ baseUrl: srv.baseUrl, project: 'p1', text: 'а теперь синее', selection: ['n1'], selectionBy: 'human' });
  await runServerCommand({ baseUrl: srv.baseUrl, project: 'p1', text: 'а теперь синее', selection: ['n1'], selection_by: 'robot' });
  assert.equal(srv.log[0].body.selection_by, 'agent');
  assert.equal(srv.log[1].body.selection_by, 'human');
  assert.equal('selection_by' in srv.log[2].body, false);
});

test('круг 27, I6: shutting_down в потоке — «перезапускается — команда не выполнена», повторяемо', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('queued', { position: 2 }));
      res.write(sse('error', { code: 'shutting_down', message: 'Сервер агента перезапускается', retryable: true, retry_after: 5 }));
      res.write(sse('done', {}));
      res.end();
    },
  });
  t.after(() => srv.close());
  const out = await runServerCommand({ baseUrl: srv.baseUrl, project: 'p1', text: 'собери экран' });
  assert.equal(out.error.code, 'shutting_down');
  assert.equal(out.error.retryable, true);
  assert.equal(out.error.retryAfterMs, 5000);
  const w = agentErrorWords(out.error);
  assert.equal(w.title, 'Сервер агента перезапускается — команда не выполнена');
  assert.doesNotMatch(w.title + w.note, /остановлен/i);
});

test('круг 33, L3: health() пробрасывает document_reason — «база данных», а не «сервер документа»', async () => {
  const reply = (body) => async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  const up = { ok: true, engine: 1, llm: 'up', document: 'up', instance: 'orch_a' };
  const prev = await health({ fetch: reply(up) });
  assert.equal('document_reason' in prev, false);
  const db = await health({ fetch: reply({ ...up, document: 'down', document_reason: 'storage' }) });
  assert.equal(db.document, 'down');
  assert.equal(db.document_reason, 'storage');
  assert.match(agentHealthNotice(prev, db).text, /база данных сервера недоступна/);
  const schema = await health({ fetch: reply({ ...up, document: 'down', document_reason: 'schema' }) });
  assert.match(agentHealthNotice(prev, schema).text, /сервер обновляет базу данных/);
  const svc = await health({ fetch: reply({ ...up, document: 'down', document_reason: 'unreachable' }) });
  assert.equal(svc.document_reason, 'unreachable');
  assert.match(agentHealthNotice(prev, svc).text, /сервер документа не отвечает/);
  // чужая строка в текст человеку не попадает, у живого документа причины нет
  const odd = await health({ fetch: reply({ ...up, document: 'down', document_reason: '<b>что-то</b>' }) });
  assert.equal('document_reason' in odd, false);
  const stale = await health({ fetch: reply({ ...up, document_reason: 'storage' }) });
  assert.equal('document_reason' in stale, false);
  // клиент агента (createAgentClient) — тот же ответ
  const client = createAgentClient({ fetch: reply({ ...up, document: 'down', document_reason: 'storage' }) });
  assert.equal((await client.health()).document_reason, 'storage');
});

test('круг 33 (ORCH): stop и apply несут client той вкладки, что дала команду', async (t) => {
  const srv = await fakeServer({
    'POST /agent/command': async (req, body, res) => {
      streamHead(res);
      res.write(sse('stage', { key: 'llm' }));
    },
    'POST /agent/stop': async (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stopped: true }));
    },
    'POST /agent/apply': async (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tx_id: 'tx_v', seq: 1, applied: 1, dropped: [], summary: 'вариант', warnings: [] }));
    },
  });
  t.after(() => srv.close());
  // «стоп» посреди потока — с client команды
  const ctrl = new AbortController();
  const p = runServerCommand({
    baseUrl: srv.baseUrl, project: 'p', text: 'x', client: 'c_tab', signal: ctrl.signal,
    onEvent: (e) => { if (e.type === 'stage') setTimeout(() => ctrl.abort(), 10); },
  });
  await assert.rejects(p, (e) => e.code === 'cancelled');
  const cmd = srv.log.find((r) => r.path === '/agent/command');
  const st = srv.log.find((r) => r.path === '/agent/stop');
  assert.equal(cmd.body.client, 'c_tab');
  assert.equal(st.body.client, 'c_tab');
  // клиент с умолчаниями: client — функцией, как у оболочки (clientId реплики)
  let cid = 'c_tab';
  const client = createAgentClient({ baseUrl: srv.baseUrl, client: () => cid });
  await client.apply('cmd_v', 'a');
  await client.stop('cmd_v');
  const ap = srv.log.filter((r) => r.path === '/agent/apply').at(-1);
  const st2 = srv.log.filter((r) => r.path === '/agent/stop').at(-1);
  assert.deepEqual(ap.body, { command_id: 'cmd_v', variant: 'a', client: 'c_tab' });
  assert.deepEqual(st2.body, { command_id: 'cmd_v', client: 'c_tab' });
  // нет client — поля нет (сервер сверит с null)
  cid = '';
  await client.stop('cmd_w');
  assert.equal('client' in srv.log.filter((r) => r.path === '/agent/stop').at(-1).body, false);
  await apply('cmd_w', 'b', { baseUrl: srv.baseUrl, client: 'x'.repeat(200) });
  assert.equal('client' in srv.log.filter((r) => r.path === '/agent/apply').at(-1).body, false);
});
