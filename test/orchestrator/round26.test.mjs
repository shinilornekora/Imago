/**
 * Круг 26, Orchestrator: `/agent/health` несёт `instance` (id процесса) и `started_at` —
 * клиент узнаёт перезапуск по смене instance; событие `error` несёт `retry_after` (с),
 * когда срок известен; текст `llm_down` — для человека, совет администратору — в лог.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startDocument, startFakeLlm, startOrch, call, command, createProject, cid, PLAN_CREATE, TREE_OK, captureLog,
} from './helpers.mjs';
import { createAgentClient, runServerCommand, health as agentHealth } from '../../src/agent.js';
import { LLM_DOWN_MESSAGE, LLM_UNCONFIGURED_MESSAGE } from '../../server/orchestrator/errors.js';

const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };
/** Советы администратору и служебное — человеку в браузер не уходят. */
const ADMIN = /запущ|LLM_BASE_URL|LLM_|ECONN|127\.0\.0\.1|localhost|контейнер|fetch failed/i;

test('/agent/health: instance и started_at; у другого процесса — другой instance', async (t) => {
  const document = await startDocument();
  const a = await startOrch({ document });
  const b = await startOrch({ document });
  t.after(async () => { await a.close(); await b.close(); await document.close(); });
  const h1 = (await call(a.url, 'GET', '/agent/health')).body;
  const h2 = (await call(a.url, 'GET', '/agent/health')).body;
  const hb = (await call(b.url, 'GET', '/agent/health')).body;
  assert.equal(typeof h1.instance, 'string');
  assert.ok(h1.instance.length >= 8);
  assert.equal(h1.instance, h2.instance, 'тот же процесс — тот же instance');
  assert.notEqual(h1.instance, hb.instance, 'другой процесс — другой instance');
  assert.ok(Number.isFinite(Date.parse(h1.started_at)));
  assert.ok(Date.parse(h1.started_at) <= Date.now());
  assert.equal(h1.instance, a.instance);
  // клиент передаёт их оболочке
  const viaClient = await agentHealth({ baseUrl: a.url, fetch });
  assert.equal(viaClient.instance, h1.instance);
  assert.equal(viaClient.started_at, h1.started_at);
});

test('llm_down: человеку — нейтрально, администратору — в лог (раз в минуту); событие error несёт retry_after', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const log = captureLog();
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, log });
  t.after(async () => { await orch.close(); await document.close(); await llm.close().catch(() => {}); });
  const p = await createProject(document);
  const ok = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(ok.events.some((e) => e.event === 'result'));

  // модель упала посреди работы (здоровье ещё в кеше «up») — ошибка приходит событием потока
  await llm.close();
  const bad = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  const err = bad.events.find((e) => e.event === 'error');
  assert.ok(err, bad.text);
  assert.equal(err.data.code, 'llm_down');
  assert.equal(err.data.message, LLM_DOWN_MESSAGE);
  assert.doesNotMatch(err.data.message, ADMIN);
  assert.equal(err.data.retry_after, 10);
  const hints = () => log.lines.filter((l) => /модель не отвечает/.test(l));
  assert.equal(hints().length, 1, log.lines.join('\n'));
  assert.match(hints()[0], /проверьте, что сервер модели запущен/);

  // клиент оболочки: после сбоя здоровье модели «down» — отказ до потока, срок — из Retry-After
  const agent = createAgentClient({ baseUrl: orch.url, fetch });
  await assert.rejects(agent.run({ command_id: cid(), project: p.id, text: 'собери экран тарифов' }),
    (e) => e.code === 'llm_down' && e.retryAfterMs === 10000 && !ADMIN.test(e.message));
  assert.equal(hints().length, 1, 'та же причина в лог — не чаще раза в минуту');

  // до потока (здоровье модели уже «down»): тело ошибки — тоже с retry_after и тем же текстом
  orch.llm.markDown();
  const pre = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.equal(pre.status, 503);
  assert.equal(pre.body.message, LLM_DOWN_MESSAGE);
  assert.equal(pre.body.retry_after, 10);
  assert.equal(pre.headers.get('retry-after'), '10');
});

test('модель не подключена: человеку — без имён переменных, администратору — LLM_BASE_URL в лог', async (t) => {
  const document = await startDocument();
  const log = captureLog();
  const orch = await startOrch({ document, log });
  t.after(async () => { await orch.close(); await document.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'llm_down');
  assert.equal(r.body.message, LLM_UNCONFIGURED_MESSAGE);
  assert.doesNotMatch(r.body.message, ADMIN);
  assert.equal(r.body.retry_after, 60);
  assert.ok(log.lines.some((l) => /LLM_BASE_URL/.test(l)), log.lines.join('\n'));
  // события команды без модели (переспрос) ошибок не несут
  const ask = await runServerCommand({ baseUrl: orch.url, fetch, command_id: cid(), project: p.id, text: 'убери последнее' });
  assert.equal(ask.status, 'done');
});

test('клиент: retry_after события error потока → retryAfterMs (обратный отсчёт кнопки «Повторить»)', async () => {
  const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const fake = (text) => async () => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const withWait = await runServerCommand({
    baseUrl: 'http://x', project: 'p', text: 'т',
    fetch: fake(sse([['error', { code: 'busy', message: 'занят', retryable: true, retry_after: 7 }], ['done', {}]])),
  });
  assert.equal(withWait.status, 'error');
  assert.equal(withWait.error.retryAfterMs, 7000);
  const without = await runServerCommand({
    baseUrl: 'http://x', project: 'p', text: 'т',
    fetch: fake(sse([['error', { code: 'llm_failed', message: 'сбой', retryable: true }], ['done', {}]])),
  });
  assert.equal(without.error.retryAfterMs, null);
  // тело ошибки без заголовка Retry-After — срок из retry_after тела
  const noHeader = async () => new Response(JSON.stringify({ error: true, code: 'busy', message: 'занят', retryable: true, retry_after: 30 }), { status: 429, headers: { 'content-type': 'application/json' } });
  await assert.rejects(runServerCommand({ baseUrl: 'http://x', project: 'p', text: 'т', fetch: noHeader }), (e) => e.code === 'busy' && e.retryAfterMs === 30000);
});
