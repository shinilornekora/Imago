/**
 * Запуск Orchestrator процессом напрямую через `node` (как в Docker: CMD ["node",
 * "server/orchestrator/index.js"], без npm) и выход по SIGTERM с кодом 0 — при любом
 * написании пути: относительный от рабочего каталога, через символическую ссылку, каталогом.
 * Порт — 0 (случайный), настоящий — из строки «слушаю» (круг 26: параллельные прогоны).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, spawnOrchestrator } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function runAndStop(args, { cwd = ROOT } = {}) {
  const proc = spawnOrchestrator(args, { cwd, env: { DOCUMENT_URL: 'http://127.0.0.1:9', LLM_BASE_URL: '' } });
  const port = await proc.port;
  assert.ok(port > 0, proc.out());
  const h = await call(`http://127.0.0.1:${port}`, 'GET', '/agent/health');
  assert.equal(h.status, 200);
  proc.child.kill('SIGTERM');
  const res = await proc.exited;
  return { ...res, out: proc.out() };
}

test('node с относительным путём из корня проекта (как CMD в Docker) — SIGTERM, код 0', async () => {
  const { code, signal, out } = await runAndStop(['server/orchestrator/index.js']);
  assert.equal(signal, null, out);
  assert.equal(code, 0, out);
  assert.match(out, /SIGTERM: останавливаюсь/);
});

test('запуск через символическую ссылку и каталогом — сервис поднимается (а не молча выходит)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imago-orch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'orchestrator.js');
  fs.symlinkSync(path.join(ROOT, 'server/orchestrator/index.js'), link);
  const viaLink = await runAndStop([link]);
  assert.equal(viaLink.code, 0, viaLink.out);
  const viaDir = await runAndStop(['server/orchestrator']);
  assert.equal(viaDir.code, 0, viaDir.out);
});
