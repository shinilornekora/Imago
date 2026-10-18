/**
 * Круг 41 — Orchestrator:
 *   • D5: ожидание в своей очереди полных чтений — отдельно от бюджета ответа Document service;
 *     отказ из-за своей очереди — `busy` с причиной `agent` («Агент занят чтением…»);
 *   • G03: доля семафора возвращается при любом исходе команды (ошибка модели после чтения, стоп);
 *   • G04: доля держится до конца расчёта DSLV, а не до конца записи;
 *   • вкладка другой версии движка: `/agent/command` и `/agent/apply` → 426 `engine`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ENGINE_VERSION } from '../../src/core.js';
import { AGENT_READ_QUEUE_MESSAGE } from '../../server/orchestrator/errors.js';
import {
  startDocument, startFakeLlm, startOrch, command, commandStream, createProject, call, cid,
  PLAN_CREATE, TREE_OK,
} from './helpers.mjs';

/** Прокси перед настоящим Document service; `delayTxMs` — задержка записи транзакции. */
async function proxyDocument(document, ctl = { delayTxMs: 0 }) {
  const target = `http://127.0.0.1:${document.port}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method === 'POST' && /\/tx$/.test(req.url) && ctl.delayTxMs) await new Promise((r) => setTimeout(r, ctl.delayTxMs));
    if (ctl.delayLibrariesMs && req.method === 'GET' && /^\/api\/projects\?/.test(req.url) && /kind=library/.test(req.url)) {
      await new Promise((r) => setTimeout(r, ctl.delayLibrariesMs));
    }
    try {
      const r = await fetch(target + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
    } catch {
      // сервис уже закрыт (конец теста) — как обрыв
      try { res.destroy(); } catch { /* закрыт */ }
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, ctl, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const outcome = (r) => {
  const e = r.events.find((x) => x.event === 'error' || x.event === 'result');
  return e ? (e.event === 'result' ? 'result' : `error:${e.data.code}:${e.data.detail && e.data.detail.cause}`) : `http:${r.status}`;
};

/* ── D5 ─────────────────────────────────────────────────────────────────── */

test('круг 41 D5: долгая очередь своих чтений не съедает бюджет ответа сервиса — все команды выполнены', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK }, { delayMs: 300 });
  // байтов — на один документ, бюджет ответа сервиса — 400 мс: раньше очередь (секунды) его съедала
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, dslr: { fullBytes: 1, readBudgetMs: 400 } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const ps = [];
  for (let i = 0; i < 4; i++) ps.push(await createProject(document, { name: 'П' + i }));
  const rs = await Promise.all(ps.map((p, i) => command(orch.url, { command_id: cid('d5_' + i), project: p.id, text: 'собери экран тарифов', client: 'c' + i })));
  assert.deepEqual(rs.map(outcome), ['result', 'result', 'result', 'result']);
  assert.ok(rs.some((r) => r.events.some((e) => e.event === 'queued' && e.data.scope === 'read')), 'очередь чтений была');
  assert.equal(orch.dslr.gate.held, 0);
});

test('круг 41 D5: не дождалась своей очереди чтений — «Агент занят чтением…», причина agent, а не «сервис перегружен»', async (t) => {
  const document = await startDocument();
  let open;
  const gate = new Promise((r) => { open = r; });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK }, { gate });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, dslr: { fullBytes: 1, queueWaitMs: 300 } });
  t.after(async () => { open(); await orch.close(); await document.close(); await llm.close(); });
  const p1 = await createProject(document, { name: 'Первый' });
  const p2 = await createProject(document, { name: 'Второй' });
  const s1 = commandStream(orch.url, { command_id: cid('q1'), project: p1.id, text: 'собери экран тарифов', client: 'c1' });
  await s1.until((e) => e.event === 'stage' && e.data.key === 'llm');
  const r2 = await command(orch.url, { command_id: cid('q2'), project: p2.id, text: 'собери экран тарифов', client: 'c2' });
  const err = r2.events.find((e) => e.event === 'error');
  assert.ok(err, r2.text);
  assert.equal(err.data.code, 'busy');
  assert.equal(err.data.message, AGENT_READ_QUEUE_MESSAGE);
  assert.equal(err.data.retryable, true);
  assert.ok(err.data.retry_after > 0);
  open();
  await s1.done();
  assert.equal(outcome({ events: s1.events }), 'result');
  assert.equal(orch.dslr.gate.held, 0);
  assert.equal(orch.dslr.gate.waiting, 0);
});

/* ── G03 / G04 ─────────────────────────────────────────────────────────── */

test('круг 41 G03: команда упала после чтения (модель отказала) — доля семафора возвращена', async (t) => {
  const document = await startDocument();
  let open;
  const gate = new Promise((r) => { open = r; });
  // ответа для tree нет — модель отвечает 400 после плана
  const llm = await startFakeLlm({ plan: PLAN_CREATE }, { gate });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { open(); await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const s = commandStream(orch.url, { command_id: cid('g3'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  await s.until((e) => e.event === 'stage' && e.data.key === 'llm');
  assert.ok(orch.dslr.gate.held > 0, 'документ команды держит долю, пока идёт расчёт');
  open();
  await s.done();
  assert.ok(s.events.some((e) => e.event === 'error'), JSON.stringify(s.events.map((e) => e.event)));
  assert.equal(orch.dslr.gate.held, 0, 'ошибка после чтения — доля возвращена');
});

test('круг 41 G03: команда прервана сразу после чтения (стоп на стадии библиотек, до расчёта) — доля семафора возвращена', async (t) => {
  const document = await startDocument();
  const proxy = await proxyDocument(document, { delayLibrariesMs: 1500 });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document: { port: proxy.port }, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await proxy.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const id = cid('g3l');
  const s = commandStream(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', client: 'c' });
  await s.until((e) => e.event === 'stage' && e.data.key === 'library');
  assert.ok(orch.dslr.gate.held > 0, 'документ прочитан целиком и держит долю');
  assert.equal((await call(orch.url, 'POST', '/agent/stop', { command_id: id, client: 'c' })).body.stopped, true);
  await s.done();
  const keys = s.events.map((e) => (e.event === 'stage' ? e.data.key : e.event));
  assert.ok(!keys.includes('llm') && keys.includes('error'), keys.join(','));
  assert.equal(orch.dslr.gate.held, 0, 'команда кончилась до расчёта — доля возвращена');
});

test('круг 41 G03: «Стоп» во время расчёта — доля семафора возвращена', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK }, { gate: new Promise(() => {}) });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const id = cid('g3s');
  const s = commandStream(orch.url, { command_id: id, project: p.id, text: 'собери экран тарифов', client: 'c' });
  await s.until((e) => e.event === 'stage' && e.data.key === 'llm');
  assert.ok(orch.dslr.gate.held > 0);
  const st = await call(orch.url, 'POST', '/agent/stop', { command_id: id, client: 'c' });
  assert.equal(st.body.stopped, true);
  await s.done();
  assert.ok(s.events.some((e) => e.event === 'error' && e.data.code === 'cancelled'));
  assert.equal(orch.dslr.gate.held, 0);
});

test('круг 41 G04: доля отпускается после расчёта DSLV — запись идёт уже без неё', async (t) => {
  const document = await startDocument();
  const proxy = await proxyDocument(document, { delayTxMs: 800 });
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document: { port: proxy.port }, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await proxy.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const s = commandStream(orch.url, { command_id: cid('g4'), project: p.id, text: 'собери экран тарифов', client: 'c' });
  await s.until((e) => e.event === 'stage' && e.data.key === 'llm');
  assert.ok(orch.dslr.gate.held > 0, 'во время расчёта доля держится');
  await s.until((e) => e.event === 'stage' && e.data.key === 'write');
  assert.equal(orch.dslr.gate.held, 0, 'запись (0,8 с) — уже без доли');
  assert.equal(s.events.some((e) => e.event === 'result'), false, 'запись ещё идёт');
  await s.done();
  assert.ok(s.events.some((e) => e.event === 'result'));
});

/* ── версия движка клиента ─────────────────────────────────────────────── */

test('круг 41: вкладка другой версии движка — /agent/command и /agent/apply → 426 engine; стоп работает всегда', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm({ plan: PLAN_CREATE, tree: TREE_OK });
  const orch = await startOrch({ document, llm: { baseUrl: llm.base } });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const base = { project: p.id, text: 'собери экран тарифов', client: 'c' };

  const old = await command(orch.url, { ...base, command_id: cid('e1'), engine: ENGINE_VERSION - 1 });
  assert.equal(old.status, 426, old.text);
  assert.equal(old.body.code, 'engine');
  assert.equal(old.body.retryable, false);
  assert.deepEqual(old.body.detail, { engine: ENGINE_VERSION, found: ENGINE_VERSION - 1, cause: 'client_old' });
  assert.match(old.body.message, /обновите страницу/);

  const newer = await command(orch.url, { ...base, command_id: cid('e2'), engine: ENGINE_VERSION + 1 });
  assert.equal(newer.status, 426);
  assert.equal(newer.body.detail.cause, 'server_old');
  assert.equal(newer.body.retryable, true);

  const hdr = await fetch(orch.url + '/agent/command', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-engine': String(ENGINE_VERSION - 1) },
    body: JSON.stringify({ ...base, command_id: cid('e3') }),
  });
  assert.equal(hdr.status, 426, 'и заголовком X-Engine');
  await hdr.text();

  const bad = await command(orch.url, { ...base, command_id: cid('e4'), engine: 'два' });
  assert.equal(bad.status, 400);

  const same = await command(orch.url, { ...base, command_id: cid('e5'), engine: ENGINE_VERSION });
  assert.equal(outcome(same), 'result');
  const none = await command(orch.url, { ...base, command_id: cid('e6') });
  assert.equal(outcome(none), 'result', 'без поля — как прежде (внешний вызов API)');

  // apply: варианты посчитаны, выбирает вкладка прежней версии — 426, записи нет
  const vid = cid('e7');
  const v = await command(orch.url, { ...base, command_id: vid, mode: 'variants', n: 2, engine: ENGINE_VERSION });
  assert.ok(v.events.some((e) => e.event === 'variants'), v.text);
  const ap = await call(orch.url, 'POST', '/agent/apply', { command_id: vid, variant: 0, client: 'c', engine: ENGINE_VERSION - 1 });
  assert.equal(ap.status, 426);
  assert.equal(ap.body.code, 'engine');
  const ok = await call(orch.url, 'POST', '/agent/apply', { command_id: vid, variant: 0, client: 'c', engine: ENGINE_VERSION });
  assert.equal(ok.status, 200, ok.text);

  const st = await call(orch.url, 'POST', '/agent/stop', { command_id: cid('none'), client: 'c', engine: 1 });
  assert.equal(st.status, 200);
});
