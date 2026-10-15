/**
 * DSLV (SPEC §10.1, стрелки 10/11): патч → операции на копии стейта, раскладка, `validate`,
 * круг починки — в пуле `worker_threads`.
 *
 * Пул: min(2, CPU) воркеров, создаются лениво; задания сверх пула ждут в очереди пула.
 * Каждый воркер — с `resourceLimits` (потолок кучи) и таймаутом СЧЁТНОГО времени: часы
 * идут, пока воркер считает, и стоят, пока он ждёт ответа модели (модель меряет свой
 * бюджет сама, в провайдере brain). Воркер упал, превысил память или время — задание
 * получает ошибку `worker_failed`/`timeout`, воркер заменяется, процесс живёт.
 *
 * Вызовы модели воркер шлёт сообщением сюда (см. worker.js); их исполняет `onLlm`
 * вызывающего — в главном потоке, с общим AbortSignal команды.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { OrchError } from '../errors.js';
import { WORKER_MAX_OLD_MB, WORKER_TIMEOUT_MS } from '../limits.js';
import { SCHEMAS } from '../../../src/brain.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

/** Что из окружения процесса видит воркер: язык, часовой пояс, пути — и больше ничего. */
const WORKER_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TZ', 'NODE_ENV', 'TMPDIR', 'TEMP', 'TMP']);

/**
 * Окружение воркера по белому списку (SPEC §10.1: ключ — только в главном потоке).
 * Раньше воркер получал `{...process.env}` целиком — с LLM_API_KEY, INTERNAL_TOKEN и
 * LLM_BASE_URL (в нём бывают userinfo и ?key=). NODE_OPTIONS — пустой: он ломает resourceLimits.
 * @param {Record<string, string|undefined>} src
 * @returns {Record<string, string>}
 */
export function workerEnv(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (typeof v !== 'string') continue;
    if (WORKER_ENV_KEYS.has(k) || /^LC_[A-Z_]+$/.test(k)) out[k] = v;
  }
  out.NODE_OPTIONS = '';
  return out;
}

/**
 * @param {{size?: number, maxOldMb?: number, timeoutMs?: number, testHooks?: boolean, log?: object}} [o]
 */
export function createDslv(o = {}) {
  const size = Math.max(1, o.size || Math.min(2, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1));
  const maxOldMb = o.maxOldMb || WORKER_MAX_OLD_MB;
  const timeoutMs = o.timeoutMs || WORKER_TIMEOUT_MS;
  const log = o.log || console;
  const slots = [];            // {worker, job|null, dead}
  const waiting = [];          // задания, ждущие свободный воркер
  let jobSeq = 0;
  let closed = false;
  const stats = { spawned: 0, crashed: 0, timedOut: 0 };

  function spawn() {
    const worker = new Worker(WORKER_URL, {
      workerData: { testHooks: !!o.testHooks },
      resourceLimits: { maxOldGenerationSizeMb: maxOldMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.round(maxOldMb / 8))) },
      // NODE_OPTIONS родителя (например, --max-old-space-size) воркеру не передаём: он ломает resourceLimits
      execArgv: [],
      // круг 25: окружение — только безопасный минимум: ключ модели, INTERNAL_TOKEN и
      // адреса с учётными данными воркеру не нужны (модель зовёт главный поток)
      env: workerEnv(process.env),
    });
    const slot = { worker, job: null, dead: false };
    stats.spawned++;
    worker.on('message', (msg) => onMessage(slot, msg));
    worker.on('error', (e) => onDeath(slot, e));
    worker.on('exit', (code) => onDeath(slot, code ? new Error(`воркер завершился с кодом ${code}`) : null));
    slots.push(slot);
    return slot;
  }

  function onDeath(slot, err) {
    if (slot.dead) return;
    slot.dead = true;
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    const job = slot.job;
    slot.job = null;
    if (job && !job.settled) {
      stats.crashed++;
      const oom = err && (err.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory|heap/i.test(String(err.message)));
      log.warn(`[orchestrator/dslv] воркер упал${oom ? ' (память)' : ''}: ${err ? err.code || err.message : 'выход'}`);
      finish(job, null, new OrchError(500, 'worker_failed', oom
        ? 'Расчёт макета не уложился в память — команда не выполнена. Попробуйте команду поменьше.'
        : 'Расчёт макета прервался сбоем — команда не выполнена. Попробуйте ещё раз.', { retryable: true }));
    }
    pump();
  }

  function arm(job) {
    disarm(job);
    if (job.settled) return;
    job.timer = setTimeout(() => {
      stats.timedOut++;
      const slot = job.slot;
      log.warn(`[orchestrator/dslv] прогон превысил ${timeoutMs} мс счёта — воркер заменяется`);
      finish(job, null, new OrchError(504, 'timeout', 'Расчёт макета занял слишком долго — команда прервана.', { retryable: true }));
      if (slot) kill(slot);
    }, Math.max(1, timeoutMs - job.spent));
    job.armedAt = Date.now();
  }

  function disarm(job) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
      job.spent += Date.now() - job.armedAt;
    }
  }

  function kill(slot) {
    if (slot.dead) return;
    slot.dead = true;
    slot.job = null;
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    slot.worker.terminate().catch(() => {});
    pump();
  }

  function finish(job, result, error) {
    if (job.settled) return;
    job.settled = true;
    disarm(job);
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (job.slot && job.slot.job === job) job.slot.job = null;
    if (error) job.reject(error);
    else job.resolve(result);
    if (job.slot && !job.slot.dead) pump();
  }

  async function onMessage(slot, msg) {
    const job = slot.job;
    if (!msg || !job || msg.id !== job.id) return;
    if (msg.type === 'stage') {
      try { job.onStage && job.onStage(msg.rec); } catch { /* интерфейс не роняет прогон */ }
      return;
    }
    if (msg.type === 'done') {
      finish(job, msg.result, null);
      return;
    }
    if (msg.type === 'llm') {
      disarm(job);
      job.llmPending++;
      const usage = [];
      let reply;
      try {
        const schema = msg.schema && msg.schema.ref ? SCHEMAS[msg.schema.ref] : msg.schema;
        const data = await job.onLlm(msg.messages, schema, { ...msg.opts, onUsage: (u) => usage.push(u) });
        reply = { type: 'llm-reply', callId: msg.callId, ok: true, data, usage };
      } catch (e) {
        reply = {
          type: 'llm-reply', callId: msg.callId, ok: false, usage,
          error: { kind: (e && e.kind) || 'model', message: (e && e.message) || 'Сбой модели', ...(e && e.code ? { code: e.code } : {}) },
        };
      }
      job.llmPending--;
      if (job.settled || slot.dead) return;
      if (!job.llmPending) arm(job);
      try { slot.worker.postMessage(reply); } catch { /* воркер уже ушёл */ }
    }
  }

  function pump() {
    if (closed) return;
    while (waiting.length) {
      let slot = slots.find((s) => !s.job && !s.dead);
      if (!slot && slots.length < size) slot = spawn();
      if (!slot) return;
      const job = waiting.shift();
      if (job.settled) continue;
      start(slot, job);
    }
  }

  function start(slot, job) {
    slot.job = job;
    job.slot = slot;
    arm(job);
    try {
      slot.worker.postMessage({ type: 'run', id: job.id, job: job.payload });
    } catch (e) {
      finish(job, null, new OrchError(500, 'worker_failed', 'Не удалось передать задание расчёту: документ слишком сложен для передачи', { retryable: false }));
    }
  }

  /**
   * @param {object} payload {mode, doc, selection, utterance, activeArtboardId, history, library, n, test?}
   * @param {{signal?: AbortSignal, onStage?: Function, onLlm: Function}} hooks
   * @returns {Promise<object>} результат brain без превью
   */
  function run(payload, hooks) {
    if (closed) return Promise.reject(new OrchError(503, 'shutting_down', 'Агент останавливается', { retryAfter: 5 }));
    return new Promise((resolve, reject) => {
      const job = {
        id: `j${++jobSeq}`, payload, resolve, reject, settled: false, slot: null,
        onStage: hooks.onStage, onLlm: hooks.onLlm, signal: hooks.signal,
        timer: null, spent: 0, armedAt: 0, llmPending: 0, onAbort: null,
      };
      if (hooks.signal) {
        if (hooks.signal.aborted) { reject(new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false })); return; }
        job.onAbort = () => {
          if (job.slot && !job.slot.dead) {
            try { job.slot.worker.postMessage({ type: 'abort', id: job.id }); } catch { /* ignore */ }
            // brain отвечает на отмену сразу; не ответил — воркер занят счётом, снимаем его
            const slot = job.slot;
            setTimeout(() => { if (!job.settled && slot.job === job) { finish(job, null, new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false })); kill(slot); } }, 2000).unref();
          } else {
            finish(job, null, new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false }));
          }
        };
        hooks.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      waiting.push(job);
      pump();
    });
  }

  async function close() {
    closed = true;
    for (const job of waiting.splice(0)) finish(job, null, new OrchError(503, 'shutting_down', 'Агент останавливается', { retryAfter: 5 }));
    await Promise.all(slots.splice(0).map((s) => { s.dead = true; return s.worker.terminate().catch(() => {}); }));
  }

  return { run, close, stats, get size() { return size; }, get alive() { return slots.length; } };
}
