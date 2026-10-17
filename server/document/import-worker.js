/**
 * Поток подготовки импорта (круг 33): байты тела `POST /api/projects` → разбор JSON и
 * `prepareProject` (importer.js) вне цикла событий сервиса. Ответ — `{id, ok, out}` или
 * `{id, ok:false, error:{status, code, message, retryable, detail}}`.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { prepareProject, errorOut } from './importer.js';

const opts = (workerData && workerData.opts) || {};

parentPort.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  const { id, buf } = m;
  let body;
  try {
    body = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch (_) {
    parentPort.postMessage({ id, ok: false, error: { status: 400, code: 'bad_request', message: 'тело не JSON', retryable: false } });
    return;
  }
  const warns = [];
  try {
    const out = prepareProject(body, { ...opts, onWarn: (w) => warns.push(String(w).slice(0, 300)) });
    parentPort.postMessage({ id, ok: true, out, warns });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: errorOut(e), warns });
  }
});
