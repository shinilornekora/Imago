/**
 * Запуск Orchestrator процессом напрямую через `node` (как в Docker: CMD ["node",
 * "server/orchestrator/index.js"], без npm) и выход по SIGTERM с кодом 0 — при любом
 * написании пути: относительный от рабочего каталога, через символическую ссылку, каталогом.
 * Порты — из выданного кругу диапазона 8700–8719.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function runAndStop(args, { port, cwd = ROOT }) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DOCUMENT_URL: 'http://127.0.0.1:9', LLM_BASE_URL: '' };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !/слушаю/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, new RegExp(`слушаю http://127\\.0\\.0\\.1:${port}`), out);
  const h = await call(`http://127.0.0.1:${port}`, 'GET', '/agent/health');
  assert.equal(h.status, 200);
  child.kill('SIGTERM');
  const res = await exited;
  return { ...res, out };
}

test('node с относительным путём из корня проекта (как CMD в Docker) — SIGTERM, код 0', async () => {
  const { code, signal, out } = await runAndStop(['server/orchestrator/index.js'], { port: 8712 });
  assert.equal(signal, null, out);
  assert.equal(code, 0, out);
  assert.match(out, /SIGTERM: останавливаюсь/);
});

test('запуск через символическую ссылку и каталогом — сервис поднимается (а не молча выходит)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imago-orch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'orchestrator.js');
  fs.symlinkSync(path.join(ROOT, 'server/orchestrator/index.js'), link);
  const viaLink = await runAndStop([link], { port: 8713 });
  assert.equal(viaLink.code, 0, viaLink.out);
  const viaDir = await runAndStop(['server/orchestrator'], { port: 8714 });
  assert.equal(viaDir.code, 0, viaDir.out);
});
