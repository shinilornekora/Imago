/**
 * DSLV (SPEC §10.1, стрелки 10/11): патч → операции на копии стейта, раскладка, `validate`,
 * круг починки — в пуле `worker_threads`.
 *
 * Пул: min(2, CPU) воркеров, создаются лениво. Круг 27: воркер ведёт НЕСКОЛЬКО заданий
 * (до `WORKER_JOBS_MAX`): пока задание ждёт модель, воркер берёт следующее — раньше он стоял
 * всё время ответа модели, и шесть команд в шесть проектов при двух воркерах отвечали
 * парами (15/30/45 с при модели 5 с). Новое задание воркер получает, только когда ни одно
 * из его заданий не считает. Места нет — очередь пула (`POOL_QUEUE_MAX` заданий, не дольше
 * `POOL_QUEUE_WAIT_MS`), вызывающему — `onQueued({position})`.
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
import { OrchError, shuttingDown } from '../errors.js';
import { WORKER_MAX_OLD_MB, WORKER_TIMEOUT_MS, WORKER_JOBS_MAX, POOL_QUEUE_MAX, POOL_QUEUE_WAIT_MS } from '../limits.js';
import { SCHEMAS } from '../../../src/brain.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
/** Ожидание воркера короче этого клиенту не объявляется событием `queued`. */
const QUEUED_NOTICE_MS = 400;

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
 * @param {{size?: number, maxOldMb?: number, timeoutMs?: number, jobsPerWorker?: number,
 *   queueMax?: number, queueWaitMs?: number, testHooks?: boolean, log?: object}} [o]
 */
export function createDslv(o = {}) {
  const size = Math.max(1, o.size || Math.min(2, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1));
  const maxOldMb = o.maxOldMb || WORKER_MAX_OLD_MB;
  const timeoutMs = o.timeoutMs || WORKER_TIMEOUT_MS;
  const perWorker = Math.max(1, o.jobsPerWorker || WORKER_JOBS_MAX);
  const queueMax = o.queueMax == null ? POOL_QUEUE_MAX : Math.max(0, o.queueMax);
  const queueWaitMs = o.queueWaitMs || POOL_QUEUE_WAIT_MS;
  const log = o.log || console;
  const slots = [];            // {worker, jobs: Map<id, job>, dead, stuck}
  const waiting = [];          // задания, ждущие воркер
  let jobSeq = 0;
  let closed = false;
  const stats = { spawned: 0, crashed: 0, timedOut: 0, queued: 0, queueRejected: 0, queueExpired: 0, peakJobs: 0 };

  const cancelled = () => new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false });

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
    const slot = { worker, jobs: new Map(), dead: false, stuck: null };
    stats.spawned++;
    worker.on('message', (msg) => onMessage(slot, msg));
    worker.on('error', (e) => onDeath(slot, e));
    worker.on('exit', (code) => onDeath(slot, code ? new Error(`воркер завершился с кодом ${code}`) : null));
    slots.push(slot);
    return slot;
  }

  /**
   * Считает ли воркер прямо сейчас: есть задание, которое не ждёт модель (или задание,
   * снятое «стопом», но ещё не отпущенное воркером). Такому новых заданий не даём —
   * поток у воркера один, и новое ждало бы чужого счёта.
   */
  const computing = (slot) => !!slot.stuck || [...slot.jobs.values()].some((j) => !j.llmPending);

  /** Снять воркер; его незавершённые задания получают ошибку (кроме `except`). */
  function drop(slot, err, except = null) {
    if (slot.dead) return;
    slot.dead = true;
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    if (slot.stuck) { clearTimeout(slot.stuck.timer); slot.stuck = null; }
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    for (const job of jobs) {
      if (job === except || job.settled) continue;
      job.slot = null;
      finish(job, null, err(job));
    }
  }

  function onDeath(slot, err) {
    if (slot.dead) return;
    const oom = err && (err.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory|heap/i.test(String(err.message)));
    if ([...slot.jobs.values()].some((j) => !j.settled)) {
      stats.crashed++;
      log.warn(`[orchestrator/dslv] воркер упал${oom ? ' (память)' : ''}: ${err ? err.code || err.message : 'выход'}`);
    }
    drop(slot, () => new OrchError(500, 'worker_failed', oom
      ? 'Расчёт макета не уложился в память — команда не выполнена. Попробуйте команду поменьше.'
      : 'Расчёт макета прервался сбоем — команда не выполнена. Попробуйте ещё раз.', { retryable: true }));
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

  /** Воркер снимается принудительно (таймаут счёта): соседние задания — повторяемая ошибка. */
  function kill(slot) {
    if (slot.dead) return;
    drop(slot, () => new OrchError(500, 'worker_failed',
      'Расчёт макета прервался: соседняя команда считала слишком долго, и расчёт пришлось перезапустить. Повторите команду.',
      { retryable: true }));
    slot.worker.terminate().catch(() => {});
    pump();
  }

  function finish(job, result, error) {
    if (job.settled) return;
    job.settled = true;
    disarm(job);
    if (job.queueTimer) { clearTimeout(job.queueTimer); job.queueTimer = null; }
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    const slot = job.slot;
    if (slot && slot.jobs.get(job.id) === job) slot.jobs.delete(job.id);
    if (error) job.reject(error);
    else job.resolve(result);
    if (slot && !slot.dead) pump();
  }

  async function onMessage(slot, msg) {
    if (!msg || typeof msg !== 'object') return;
    // воркер отпустил задание, снятое «стопом»: он снова свободен
    if (msg.type === 'done' && slot.stuck && slot.stuck.id === msg.id) {
      clearTimeout(slot.stuck.timer);
      slot.stuck = null;
      pump();
      return;
    }
    const job = slot.jobs.get(msg.id);
    if (!job) return;
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
      // задание ждёт модель — воркер свободен для следующего (круг 27)
      pump();
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

  /** Куда поставить задание: свободный воркер → новый воркер → воркер, чьи задания ждут модель. */
  function pickSlot() {
    const alive = slots.filter((s) => !s.dead);
    const empty = alive.find((s) => !s.jobs.size && !s.stuck);
    if (empty) return empty;
    if (slots.length < size) return spawn();
    let best = null;
    for (const s of alive) {
      if (s.jobs.size >= perWorker || computing(s)) continue;
      if (!best || s.jobs.size < best.jobs.size) best = s;
    }
    return best;
  }

  function pump() {
    if (closed) return;
    while (waiting.length) {
      if (waiting[0].settled) { waiting.shift(); continue; }
      const slot = pickSlot();
      if (!slot) break;
      const job = waiting.shift();
      start(slot, job);
    }
    announce();
  }

  /** Номер в очереди пула — тем, кто ждёт дольше QUEUED_NOTICE_MS (и при каждой его смене). */
  function announce() {
    waiting.forEach((job, i) => {
      if (!job.announced || job.settled || !job.onQueued || job.queuedAt === i + 1) return;
      job.queuedAt = i + 1;
      try { job.onQueued({ position: i + 1 }); } catch { /* ignore */ }
    });
  }

  function start(slot, job) {
    if (job.queueTimer) { clearTimeout(job.queueTimer); job.queueTimer = null; }
    slot.jobs.set(job.id, job);
    job.slot = slot;
    let n = 0;
    for (const s of slots) n += s.jobs.size;
    if (n > stats.peakJobs) stats.peakJobs = n;
    arm(job);
    try {
      slot.worker.postMessage({ type: 'run', id: job.id, job: job.payload });
    } catch (e) {
      finish(job, null, new OrchError(500, 'worker_failed', 'Не удалось передать задание расчёту: документ слишком сложен для передачи', { retryable: false }));
    }
  }

  /**
   * @param {object} payload {mode, doc, selection, selectionBy, utterance, activeArtboardId, history, library, n, test?}
   * @param {{signal?: AbortSignal, onStage?: Function, onLlm: Function, onQueued?: (q: {position: number}) => void}} hooks
   *   onQueued — задание ждёт свободный воркер (номер в очереди пула); зовётся при каждой смене номера
   * @returns {Promise<object>} результат brain без превью
   */
  function run(payload, hooks) {
    if (closed) return Promise.reject(shuttingDown());
    return new Promise((resolve, reject) => {
      const job = {
        id: `j${++jobSeq}`, payload, resolve, reject, settled: false, slot: null,
        onStage: hooks.onStage, onLlm: hooks.onLlm, onQueued: hooks.onQueued, signal: hooks.signal,
        timer: null, spent: 0, armedAt: 0, llmPending: 0, onAbort: null, queueTimer: null, queuedAt: 0,
      };
      if (hooks.signal) {
        if (hooks.signal.aborted) { reject(cancelled()); return; }
        job.onAbort = () => {
          const slot = job.slot;
          if (slot && !slot.dead) {
            try { slot.worker.postMessage({ type: 'abort', id: job.id }); } catch { /* ignore */ }
            // brain отвечает на отмену сразу; не ответил — воркер занят счётом
            setTimeout(() => {
              if (job.settled || slot.dead || slot.jobs.get(job.id) !== job) return;
              const others = [...slot.jobs.values()].some((j) => j !== job && !j.settled);
              finish(job, null, cancelled());
              if (!others) { kill(slot); return; }
              // круг 27: на воркере есть чужие задания — не снимаем его сразу, а ждём, пока он
              // отпустит это задание; не отпустил за остаток счётного времени — снимаем
              const left = Math.max(1, timeoutMs - job.spent);
              slot.stuck = { id: job.id, timer: setTimeout(() => { if (slot.stuck && slot.stuck.id === job.id) kill(slot); }, left) };
              if (slot.stuck.timer.unref) slot.stuck.timer.unref();
            }, 2000).unref();
          } else {
            finish(job, null, cancelled());
          }
        };
        hooks.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      // освободившиеся места — сначала тем, кто ждёт дольше
      pump();
      const live = waiting.filter((j) => !j.settled).length;
      const free = slots.length < size || slots.some((s) => !s.dead && s.jobs.size < perWorker && !computing(s));
      if (live >= queueMax && (live > 0 || !free)) {
        // места нет и очередь пула полна — сразу отказ, а не бесконечное ожидание
        stats.queueRejected++;
        finish(job, null, new OrchError(429, 'busy', 'Агент сейчас считает много команд сразу — повторите через несколько секунд.', { retryAfter: 5 }));
        return;
      }
      waiting.push(job);
      pump();
      if (!job.slot && !job.settled) {
        stats.queued++;
        job.queueTimer = setTimeout(() => {
          const i = waiting.indexOf(job);
          if (i < 0 || job.settled) return;
          waiting.splice(i, 1);
          stats.queueExpired++;
          finish(job, null, new OrchError(503, 'busy', `Агент перегружен: команда ждала расчёта дольше ${Math.round(queueWaitMs / 1000)} с и не выполнена. Повторите чуть позже.`, { retryAfter: 10 }));
          pump();
        }, queueWaitMs);
        if (job.queueTimer.unref) job.queueTimer.unref();
        /* Задание обычно ждёт воркер доли секунды — пока соседнее дойдёт до модели. О таком
           ожидании человеку не говорим (в ленте мигало бы «в очереди»): только о долгом. */
        const notice = setTimeout(() => {
          if (job.settled || job.slot) return;
          job.announced = true;
          announce();
        }, QUEUED_NOTICE_MS);
        if (notice.unref) notice.unref();
      }
    });
  }

  async function close() {
    closed = true;
    for (const job of waiting.splice(0)) finish(job, null, shuttingDown());
    const all = slots.splice(0);
    for (const s of all) drop(s, shuttingDown);
    await Promise.all(all.map((s) => s.worker.terminate().catch(() => {})));
  }

  return {
    run, close, stats,
    get size() { return size; },
    get alive() { return slots.length; },
    /** Для тестов и отладки: заданий на воркерах и в очереди пула. */
    get load() { return { running: slots.reduce((n, s) => n + s.jobs.size, 0), waiting: waiting.filter((j) => !j.settled).length }; },
  };
}
