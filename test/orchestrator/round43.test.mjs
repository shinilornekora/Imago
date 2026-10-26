/**
 * Круг 43 — Orchestrator:
 *   • событие `error` в потоке несёт безопасные поля detail (белый список, SPEC §10.13);
 *   • `engine` в теле и `X-Engine` расходятся — 400;
 *   • 503 `cause:'engine'` от Document service (проект «устарел» на экземпляре) и экземпляр другой
 *     версии движка — свой код `engine` («Сервер документов ещё не обновился…»), а не document_down;
 *     `/agent/health` — `document_reason:'engine'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ENGINE_VERSION } from '../../src/core.js';
import { safeDetail, DOCUMENT_ENGINE_MESSAGE, AGENT_READ_QUEUE_MESSAGE } from '../../server/orchestrator/errors.js';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, call, cid, PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

/** Прокси перед Document service; `ctl.intercept(req)` → {status, body, headers} или null (пропустить). */
async function proxyDocument(document, ctl) {
  const target = `http://127.0.0.1:${document.port}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hit = ctl.intercept ? ctl.intercept(req) : null;
    if (hit) {
      res.writeHead(hit.status, { 'content-type': 'application/json', ...(hit.headers || {}) }).end(JSON.stringify(hit.body));
      return;
    }
    try {
      const r = await fetch(target + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
      let text = await r.text();
      if (ctl.rewrite) text = ctl.rewrite(req, text);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(text);
    } catch {
      try { res.destroy(); } catch { /* закрыт */ }
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const STALE = (engine, found) => ({
  status: 503, headers: { 'retry-after': '30' },
  body: { error: true, code: 'unavailable', message: `проект записан более новой версией редактора (движок ${found})`, retryable: true, retry_after: 30, detail: { cause: 'engine', engine, found } },
});

test('круг 43: safeDetail — белый список полей и безопасные значения', () => {
  assert.deepEqual(safeDetail({ cause: 'agent', queue: 'wait', extra: 'x' }), { cause: 'agent', queue: 'wait' });
  assert.deepEqual(safeDetail({ cause: 'server_old', server: 'document', engine: 2, found: 3 }), { cause: 'server_old', server: 'document', engine: 2, found: 3 });
  assert.deepEqual(safeDetail({ hint: 'name_layer' }), { hint: 'name_layer' });
  assert.equal(safeDetail({ cause: 'Document service ответил 503: база недоступна', status: 503 }), undefined, 'сырые причины сети — нет');
  assert.equal(safeDetail({ engine: '2', limit: 'Expand nodes!' }), undefined);
  assert.equal(safeDetail(null), undefined);
  // круг 45 (мутант O05): только неотрицательные целые
  assert.equal(safeDetail({ engine: -1 }), undefined);
  assert.equal(safeDetail({ found: 1.5, max: -3 }), undefined);
  assert.deepEqual(safeDetail({ engine: 0, found: -1 }), { engine: 0 });
});

test('круг 43: отказ своей очереди чтений после открытия потока — в событии error есть detail {cause:"agent", queue}', async (t) => {
  const document = await startDocument();
  let open;
  const gate = new Promise((r) => { open = r; });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK }, { gate });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, dslr: { fullBytes: 1, queueWaitMs: 300 } });
  t.after(async () => { open(); await orch.close(); await document.close(); await llm.close(); });
  const p1 = await createProject(document, { name: 'Первый' });
  const p2 = await createProject(document, { name: 'Второй' });
  const s1 = commandStream(orch.url, { command_id: cid('a'), project: p1.id, text: 'собери экран тарифов', client: 'c1' });
  await s1.until((e) => e.event === 'stage' && e.data.key === 'llm');
  const r2 = await command(orch.url, { command_id: cid('b'), project: p2.id, text: 'собери экран тарифов', client: 'c2' });
  const err = r2.events.find((e) => e.event === 'error');
  assert.ok(err, r2.text);
  assert.equal(err.data.message, AGENT_READ_QUEUE_MESSAGE);
  assert.deepEqual(err.data.detail, { cause: 'agent', queue: 'wait' });
  open();
  await s1.done();
});

test('круг 43: engine в теле и X-Engine расходятся — 400; совпадают — как обычно', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const send = (engine, header) => fetch(orch.url + '/agent/command', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-engine': String(header) },
    body: JSON.stringify({ command_id: cid('x'), project: p.id, text: 'собери экран тарифов', client: 'c', engine }),
  });
  const bad = await send(ENGINE_VERSION, ENGINE_VERSION - 1);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /X-Engine/);
  const bad2 = await send(ENGINE_VERSION - 1, ENGINE_VERSION);
  assert.equal(bad2.status, 400, 'и в обратную сторону — не 426 и не молча');
  await bad2.text();
  const ok = await send(ENGINE_VERSION, ENGINE_VERSION);
  assert.equal(ok.status, 200);
  await ok.text();
  const ap = await call(orch.url, 'POST', '/agent/apply', { command_id: cid('none'), variant: 0, client: 'c', engine: ENGINE_VERSION }, { 'x-engine': String(ENGINE_VERSION + 1) });
  assert.equal(ap.status, 400);
});

test('круг 43: проект «устарел» на экземпляре (503 cause:"engine" при чтении) — error engine «Сервер документов ещё не обновился», без повторов', async (t) => {
  const document = await startDocument();
  let reads = 0;
  const proxy = await proxyDocument(document, {
    intercept: (req) => (req.method === 'GET' && /^\/api\/projects\/[^/?]+$/.test(req.url) ? (reads++, STALE(ENGINE_VERSION, ENGINE_VERSION + 1)) : null),
  });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document: { port: proxy.port }, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await proxy.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid('st'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  assert.equal(r.status, 200);
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, r.text);
  assert.equal(err.data.code, 'engine');
  assert.equal(err.data.message, DOCUMENT_ENGINE_MESSAGE);
  assert.equal(err.data.retryable, true);
  assert.equal(err.data.retry_after, 30);
  assert.deepEqual(err.data.detail, { cause: 'server_old', server: 'document', engine: ENGINE_VERSION, found: ENGINE_VERSION + 1 });
  assert.equal(reads, 1, 'повтор ничего не даст — не повторяем');
});

test('круг 43: запись агента получила 503 cause:"engine" — error engine сразу, без повторов записи', async (t) => {
  const document = await startDocument();
  let posts = 0;
  const proxy = await proxyDocument(document, {
    intercept: (req) => (req.method === 'POST' && /\/tx$/.test(req.url) ? (posts++, STALE(ENGINE_VERSION, ENGINE_VERSION + 1)) : null),
  });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document: { port: proxy.port }, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await proxy.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const t0 = Date.now();
  const r = await command(orch.url, { command_id: cid('wr'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, r.text);
  assert.equal(err.data.code, 'engine');
  assert.equal(err.data.detail.cause, 'server_old');
  assert.equal(posts, 1);
  assert.ok(Date.now() - t0 < 10000, 'не ждали бюджет повторов записи');
});

test('круг 43: сервис документов другой версии движка — /agent/health document_reason "engine", команда — 503 engine до потока', async (t) => {
  const document = await startDocument();
  let docEngine = ENGINE_VERSION - 1;
  const proxy = await proxyDocument(document, {
    rewrite: (req, text) => (req.url === '/api/health' ? JSON.stringify({ ...JSON.parse(text), engine: docEngine }) : text),
  });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document: { port: proxy.port }, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await proxy.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const h = await call(orch.url, 'GET', '/agent/health');
  assert.equal(h.body.document, 'down');
  assert.equal(h.body.document_reason, 'engine');
  const r = await command(orch.url, { command_id: cid('h1'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  assert.equal(r.status, 503, r.text);
  assert.equal(r.body.code, 'engine');
  assert.equal(r.body.message, DOCUMENT_ENGINE_MESSAGE);
  assert.equal(r.body.detail.cause, 'server_old');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  docEngine = ENGINE_VERSION + 1;
  const r2 = await command(orch.url, { command_id: cid('h2'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  assert.equal(r2.status, 503);
  assert.equal(r2.body.detail.cause, 'agent_old', 'агент старее сервиса документов');
  docEngine = ENGINE_VERSION;
  const r3 = await command(orch.url, { command_id: cid('h3'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  assert.ok(r3.events.some((e) => e.event === 'result'), r3.text);
});
