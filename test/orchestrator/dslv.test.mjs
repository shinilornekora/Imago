/**
 * DSLV: пул worker_threads. Воркер упал (память) или считал слишком долго — команда
 * получает ошибку, процесс и пул живут, следующая команда проходит. И останов процесса
 * по SIGTERM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDocument, startFakeLlm, startOrch, command, createProject, call, cid, PLAN_CREATE, TREE_OK } from './helpers.mjs';

const SCRIPT = { plan: PLAN_CREATE, tree: TREE_OK };

test('воркер вышел за память — ошибка worker_failed, процесс живёт, следующая команда проходит', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerMaxMb: 64 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', __test: 'oom' });
  assert.equal(r.status, 200);
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, JSON.stringify(r.events));
  assert.equal(err.data.code, 'worker_failed');
  assert.equal(err.data.retryable, true);
  assert.match(err.data.message, /памят/);
  assert.equal(r.events[r.events.length - 1].event, 'done');
  assert.equal(orch.dslv.stats.crashed, 1);

  const ok = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(ok.events.some((e) => e.event === 'result'), JSON.stringify(ok.events));
  assert.equal((await call(orch.url, 'GET', '/agent/health')).status, 200);
});

test('воркер считает дольше таймаута — ошибка timeout, воркер заменён', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerTimeoutMs: 800 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);

  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', __test: 'spin' });
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, JSON.stringify(r.events));
  assert.equal(err.data.code, 'timeout');
  assert.equal(orch.dslv.stats.timedOut, 1);
  const ok = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(ok.events.some((e) => e.event === 'result'), JSON.stringify(ok.events));
});

test('ожидание модели не съедает счётное время воркера', async (t) => {
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT, { delayMs: 900 });
  // таймаут счёта меньше, чем два ответа модели вместе: прогон всё равно обязан пройти
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1, workerTimeoutMs: 1500 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  // прогрев: первый прогон грузит движок в свежем воркере
  await command(orch.url, { command_id: cid(), project: p.id, text: 'убери последнее' });
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов' });
  assert.ok(r.events.some((e) => e.event === 'result'), JSON.stringify(r.events));
});

test('процесс: SIGTERM — аккуратный выход с кодом 0', async () => {
  const entry = fileURLToPath(new URL('../../server/orchestrator/index.js', import.meta.url));
  const env = { ...process.env, PORT: '8711', HOST: '127.0.0.1', DOCUMENT_URL: 'http://127.0.0.1:9', LLM_BASE_URL: '' };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !/слушаю/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /слушаю http:\/\/127\.0\.0\.1:8711/);
  const h = await call('http://127.0.0.1:8711', 'GET', '/agent/health');
  assert.equal(h.body.llm, 'unconfigured');
  assert.equal(h.body.document, 'down');
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0, out);
  assert.match(out, /SIGTERM/);
});

test('круг 25: воркер не видит секретов окружения — ключа модели, INTERNAL_TOKEN, адресов с учётными данными', async (t) => {
  const { workerEnv } = await import('../../server/orchestrator/dslv/index.js');
  const env = workerEnv({
    PATH: '/usr/bin', LANG: 'ru_RU.UTF-8', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'production', HOME: '/root',
    LLM_API_KEY: 'sk-1', INTERNAL_TOKEN: 't', LLM_BASE_URL: 'https://u:p@h/v1', DATABASE_URL: 'postgres://x', NODE_OPTIONS: '--max-old-space-size=8000',
    AWS_SECRET_ACCESS_KEY: 'a', SOMETHING: 'b',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'TZ']);
  assert.equal(env.NODE_OPTIONS, '');

  // и на деле: воркер, запущенный при ключе в окружении процесса, его не видит
  const saved = { k: process.env.LLM_API_KEY, t: process.env.INTERNAL_TOKEN };
  process.env.LLM_API_KEY = 'sk-test-worker-env-0123456789';
  process.env.INTERNAL_TOKEN = 'internal-test-token-0123456789';
  t.after(() => {
    if (saved.k === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = saved.k;
    if (saved.t === undefined) delete process.env.INTERNAL_TOKEN; else process.env.INTERNAL_TOKEN = saved.t;
  });
  const document = await startDocument();
  const llm = await startFakeLlm(SCRIPT);
  const orch = await startOrch({ document, llm: { baseUrl: llm.base }, workers: 1 });
  t.after(async () => { await orch.close(); await document.close(); await llm.close(); });
  const p = await createProject(document);
  const r = await command(orch.url, { command_id: cid(), project: p.id, text: 'собери экран тарифов', __test: 'env' });
  const err = r.events.find((e) => e.event === 'error');
  assert.ok(err, JSON.stringify(r.events));
  assert.match(err.data.message, /env .*PATH/);
  assert.doesNotMatch(err.data.message, /LLM_API_KEY|INTERNAL_TOKEN|LLM_BASE_URL/);
});
