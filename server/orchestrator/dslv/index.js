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
 *
 * Круг 29:
 *   • соседи упавшего воркера не страдают за чужую вину. Воркер вышел за память или его
 *     пришлось снять (счёт соседа, застрявший «стоп») — задания, которые в этот миг ЖДАЛИ
 *     модель, в падении не виноваты: они встают в начало очереди пула и идут заново на
 *     свежем воркере (один раз). Вызов модели при этом не повторяется: ответы (и ещё не
 *     пришедшие ответы) хранятся у задания по слепку запроса, и повторный прогон получает
 *     тот же ответ без нового обращения. Виновник (задание, которое считало) получает
 *     «не уложился в память»; сосед, которому не помог и повтор, — правду: расчёт пришлось
 *     перезапустить, повторите.
 *   • о коротком ожидании воркера не говорим, и ожидание, пока свежий воркер стартует
 *     (загрузка модулей и первый, «холодный» прогон), коротким считается всегда: часы
 *     извещения заводятся заново, когда воркер прогрелся (не дольше `COLD_GRACE_MS`). Сам порог
 *     — `QUEUED_NOTICE_MS`, но не меньше измеренного старта воркера: под нагрузкой медленнее всё.
 */

import os from 'node:os';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { OrchError, shuttingDown } from '../errors.js';
import { WORKER_MAX_OLD_MB, WORKER_TIMEOUT_MS, WORKER_JOBS_MAX, POOL_QUEUE_MAX, POOL_QUEUE_WAIT_MS } from '../limits.js';
import { SCHEMAS, modelDataProblem } from '../../../src/brain.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
/**
 * Ожидание воркера короче этого клиенту не объявляется событием `queued`. Круг 29: порог —
 * не меньше, чем последний старт воркера (`noticeMs()`): под нагрузкой медленнее и старт, и
 * чужой счёт до модели, и ожидание короче старта воркера — короткое. Не больше COLD_GRACE_MS.
 */
const QUEUED_NOTICE_MS = 400;
/**
 * Сколько ожидание извиняется стартом воркера: от его создания до первого обращения к модели
 * (или конца первого задания). Дольше — это уже очередь, и о ней говорим.
 */
const COLD_GRACE_MS = 3000;
/** Сколько раз задание, чей воркер упал не по его вине, идёт заново. */
const RESTARTS_MAX = 1;

/** Круг 31: ответ модели не той формы (глубже/больше предела) — до передачи в воркер. */
const BAD_SHAPE = Object.freeze({ kind: 'model', code: 'llm_bad_response', message: 'Ответ модели не той формы (слишком глубокий или большой) — попробуйте ещё раз' });
/** Круг 31: ответ модели не удалось передать воркеру. */
const BAD_TRANSFER = Object.freeze({ kind: 'model', code: 'llm_bad_response', message: 'Ответ модели не удалось передать расчёту — попробуйте ещё раз' });

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
  const stats = {
    spawned: 0, crashed: 0, timedOut: 0, queued: 0, queueRejected: 0, queueExpired: 0, peakJobs: 0,
    // круг 29: перезапуски соседей упавшего воркера, ответы модели без повторного вызова,
    // отложенные из-за старта воркера извещения об очереди, сделанные извещения, старт воркера
    restarted: 0, llmReused: 0, noticeDeferred: 0, announced: 0, lastWarmMs: 0, maxWarmMs: 0,
  };

  const cancelled = () => new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false });

  function spawn() {
    const worker = new Worker(WORKER_URL, {
      workerData: { testHooks: !!o.testHooks, ...(o.testHooks && o.testStartDelayMs ? { startDelayMs: o.testStartDelayMs } : {}) },
      resourceLimits: { maxOldGenerationSizeMb: maxOldMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.round(maxOldMb / 8))) },
      // NODE_OPTIONS родителя (например, --max-old-space-size) воркеру не передаём: он ломает resourceLimits
      execArgv: [],
      // круг 25: окружение — только безопасный минимум: ключ модели, INTERNAL_TOKEN и
      // адреса с учётными данными воркеру не нужны (модель зовёт главный поток)
      env: workerEnv(process.env),
    });
    // warm — воркер уже дошёл до модели (или закончил задание): старт и «холодный» прогон позади
    const slot = { worker, jobs: new Map(), dead: false, stuck: null, ready: false, warm: false, spawnedAt: Date.now() };
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

  /**
   * Снять воркер; его незавершённые задания получают ошибку `err(job)` — кроме тех, кого
   * `innocent(job)` признаёт непричастными: они (один раз) встают в начало очереди пула.
   */
  function drop(slot, err, innocent = null) {
    if (slot.dead) return;
    slot.dead = true;
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    if (slot.stuck) { clearTimeout(slot.stuck.timer); slot.stuck = null; }
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    const again = [];
    for (const job of jobs) {
      if (job.settled) continue;
      job.slot = null;
      if (innocent && innocent(job)) {
        if (job.restarts < RESTARTS_MAX) { again.push(job); continue; }
        finish(job, null, restartFailed());
        continue;
      }
      finish(job, null, err(job));
    }
    // в прежнем порядке и впереди всех: они ждали дольше остальных
    for (const job of again.reverse()) requeue(job);
    rearmCold();
  }

  const restartFailed = () => new OrchError(500, 'worker_failed',
    'Расчёт макета пришлось перезапустить из-за соседней команды, и повтор тоже не удался. Повторите команду.',
    { retryable: true });

  /** Задание — заново, на другом воркере: всё, кроме ответов модели, начинается с нуля. */
  function requeue(job) {
    disarm(job);
    job.restarts++;
    job.gen++;
    job.spent = 0;
    job.llmPending = 0;
    job.used = new Map();
    // стадии повторного прогона те же, что уже ушли клиенту: второй раз их не шлём
    job.stageSkip = job.stagesSent;
    stats.restarted++;
    log.warn(`[orchestrator/dslv] задание ${job.id} перезапускается на другом воркере (соседнее задание уронило воркер)`);
    waiting.unshift(job);
    armNotice(job, noticeMs());
  }

  function onDeath(slot, err) {
    if (slot.dead) return;
    const oom = err && (err.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory|heap/i.test(String(err.message)));
    if ([...slot.jobs.values()].some((j) => !j.settled)) {
      stats.crashed++;
      log.warn(`[orchestrator/dslv] воркер упал${oom ? ' (память)' : ''}: ${err ? err.code || err.message : 'выход'}`);
    }
    /* Круг 29: виноват тот, кто СЧИТАЛ (поток у воркера один, новые задания считающему не
       даются); кто ждал модель, — сосед и идёт заново. Не считал никто — виновника не знаем,
       и заново идут все (один раз: второе падение — уже ошибка). */
    const live = [...slot.jobs.values()].filter((j) => !j.settled);
    const anyComputing = live.some((j) => !j.llmPending);
    drop(slot, () => new OrchError(500, 'worker_failed', oom
      ? 'Расчёт макета не уложился в память — команда не выполнена. Попробуйте команду поменьше.'
      : 'Расчёт макета прервался сбоем — команда не выполнена. Попробуйте ещё раз.', { retryable: true }),
    (job) => !anyComputing || job.llmPending > 0);
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

  /**
   * Воркер снимается принудительно (таймаут счёта, застрявший «стоп»): виновник уже получил
   * свою ошибку, остальные задания на нём ни при чём и идут заново (круг 29).
   */
  function kill(slot) {
    if (slot.dead) return;
    drop(slot, () => restartFailed(), () => true);
    slot.worker.terminate().catch(() => {});
    pump();
  }

  function finish(job, result, error) {
    if (job.settled) return;
    job.settled = true;
    disarm(job);
    if (job.queueTimer) { clearTimeout(job.queueTimer); job.queueTimer = null; }
    if (job.noticeTimer) { clearTimeout(job.noticeTimer); job.noticeTimer = null; }
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    const slot = job.slot;
    if (slot && slot.jobs.get(job.id) === job) slot.jobs.delete(job.id);
    if (error) job.reject(error);
    else job.resolve(result);
    if (slot && !slot.dead) pump();
  }

  async function onMessage(slot, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      /* Круг 29: загрузка модулей воркера — не счёт задания. Часы заданий, отданных воркеру до
         его готовности, начинаются заново (зависший на загрузке воркер всё равно снимается:
         до готовности часы шли). */
      slot.ready = true;
      for (const job of slot.jobs.values()) {
        if (job.settled || !job.timer) continue;
        disarm(job);
        job.spent = 0;
        arm(job);
      }
      return;
    }
    if (!slot.warm && (msg.type === 'llm' || msg.type === 'done')) {
      // воркер стартовал и прогрелся; ждавшим из-за его старта часы извещения — заново
      slot.warm = true;
      stats.lastWarmMs = Date.now() - slot.spawnedAt;
      if (stats.lastWarmMs > stats.maxWarmMs) stats.maxWarmMs = stats.lastWarmMs;
      queueMicrotask(rearmCold);
    }
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
      if (job.stageSkip > 0) { job.stageSkip--; return; }
      job.stagesSent++;
      try { job.onStage && job.onStage(msg.rec); } catch { /* интерфейс не роняет прогон */ }
      return;
    }
    if (msg.type === 'done') {
      finish(job, msg.result, null);
      return;
    }
    /* Круг 47 (SPEC §14.4): снимок доски для критика ждёт сеть (шрифты) — это не счёт: часы
       задания стоят, воркер свободен для соседей, как во время вызова модели. */
    if (msg.type === 'io') {
      if (msg.on) { disarm(job); job.llmPending++; pump(); }
      else if (job.llmPending > 0) { job.llmPending--; if (!job.llmPending && !job.settled) arm(job); }
      return;
    }
    if (msg.type === 'llm') {
      disarm(job);
      job.llmPending++;
      // задание ждёт модель — воркер свободен для следующего (круг 27)
      pump();
      const gen = job.gen;
      const answer = await modelCall(job, msg);
      // задание ушло на другой воркер (этот упал): ответ дождётся его повторный прогон
      if (job.gen !== gen) return;
      job.llmPending--;
      const reply = { type: 'llm-reply', callId: msg.callId, ...answer };
      if (job.settled || slot.dead) return;
      if (!job.llmPending) arm(job);
      try {
        slot.worker.postMessage(reply);
      } catch (e) {
        /* Круг 31: ответ не передался воркеру (structuredClone: переполнение стека на глубоком
           JSON, неклонируемое значение). Раньше ошибка глоталась, воркер ждал ответа до таймаута
           счёта (60 с) и заменялся. Теперь — сразу ответ-ошибка `llm_bad_response`: воркер
           цел, задание быстро кончается. */
        log.warn(`[orchestrator/dslv] ответ модели не передался воркеру: ${e && e.message ? e.message : e}`);
        const bad = { type: 'llm-reply', callId: msg.callId, ok: false, usage: [], error: { ...BAD_TRANSFER } };
        try {
          slot.worker.postMessage(bad);
        } catch {
          finish(job, null, new OrchError(502, 'llm_bad_response', BAD_TRANSFER.message, { retryable: true }));
        }
      }
    }
  }

  /**
   * Вызов модели задания. Круг 29: ответы хранятся у задания по слепку запроса (и порядковому
   * номеру одинаковых запросов), чтобы повторный прогон после падения воркера получил тот же
   * ответ — в том числе ещё не пришедший — без второго обращения к модели.
   * @returns {Promise<{ok: boolean, data?: any, error?: object, usage: object[]}>} без отказа
   */
  function modelCall(job, msg) {
    const key = createHash('sha1').update(JSON.stringify([msg.messages, msg.schema, msg.opts])).digest('base64');
    const k = job.used.get(key) || 0;
    job.used.set(key, k + 1);
    let list = job.calls.get(key);
    if (!list) { list = []; job.calls.set(key, list); }
    if (list[k]) { stats.llmReused++; return list[k]; }
    const usage = [];
    const p = (async () => {
      try {
        const schema = msg.schema && msg.schema.ref ? SCHEMAS[msg.schema.ref] : msg.schema;
        const data = await job.onLlm(msg.messages, schema, { ...msg.opts, onUsage: (u) => usage.push(u) });
        /* Круг 31: глубина и размер данных модели — до передачи в воркер (structuredClone
           рекурсивен: глубокий JSON роняет стек главного потока). */
        const bad = modelDataProblem(data);
        if (bad) {
          log.warn(`[orchestrator/dslv] ответ модели не той формы: ${bad}`);
          return { ok: false, usage, error: { ...BAD_SHAPE } };
        }
        return { ok: true, data, usage };
      } catch (e) {
        return {
          ok: false, usage,
          error: {
            kind: (e && e.kind) || 'model', message: (e && e.message) || 'Сбой модели', ...(e && e.code ? { code: e.code } : {}),
            // круг 47: статус отказа модели — brain по нему решает, видит ли модель картинки
            ...(e && Number.isInteger(e.status) ? { status: e.status } : {}),
          },
        };
      }
    })();
    list[k] = p;
    return p;
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
      if (!job.queuedAt) stats.announced++;
      job.queuedAt = i + 1;
      try { job.onQueued({ position: i + 1 }); } catch { /* ignore */ }
    });
  }

  /** Порог извещения об очереди: 0,4 с, но не меньше последнего старта воркера (до 3 с). */
  const noticeMs = () => Math.min(COLD_GRACE_MS, Math.max(QUEUED_NOTICE_MS, stats.lastWarmMs));

  /** До какого мига ожидание извиняется стартом воркера (0 — холодных воркеров нет). */
  function coldUntil() {
    let t = 0;
    for (const s of slots) if (!s.dead && !s.warm) t = Math.max(t, s.spawnedAt + COLD_GRACE_MS);
    return t;
  }

  /**
   * Часы извещения об очереди. Задание обычно ждёт воркер доли секунды — пока соседнее дойдёт
   * до модели; о таком ожидании человеку не говорим (в ленте мигало бы «в очереди»). Пока
   * какой-то воркер стартует, ожидание — из-за старта, и часы ждут его прогрева (круг 29).
   */
  function armNotice(job, ms) {
    if (job.noticeTimer) clearTimeout(job.noticeTimer);
    job.noticeTimer = setTimeout(() => {
      job.noticeTimer = null;
      if (job.settled || job.slot || job.announced) return;
      const until = coldUntil();
      if (until > Date.now()) {
        if (!job.coldWait) stats.noticeDeferred++;
        job.coldWait = true;
        armNotice(job, until - Date.now());
        return;
      }
      // сообщения воркеров, пришедшие, пока часы ждали своей очереди в цикле событий (главный
      // поток под нагрузкой отстаёт), — сначала: может быть, место уже освободилось
      setImmediate(() => {
        if (job.settled || job.slot || job.announced) return;
        job.announced = true;
        announce();
      });
    }, Math.max(1, ms));
    if (job.noticeTimer.unref) job.noticeTimer.unref();
  }

  /** Воркер прогрелся или снят: ждавшим из-за старта — свежие часы извещения. */
  function rearmCold() {
    for (const job of waiting) {
      if (job.coldWait && !job.settled && !job.slot && !job.announced) {
        job.coldWait = false;
        armNotice(job, noticeMs());
      }
    }
  }

  function start(slot, job) {
    if (job.queueTimer) { clearTimeout(job.queueTimer); job.queueTimer = null; }
    if (job.noticeTimer) { clearTimeout(job.noticeTimer); job.noticeTimer = null; }
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
        noticeTimer: null, announced: false, coldWait: false,
        // круг 29: перезапуск на другом воркере — ответы модели (calls), их счёт в прогоне (used),
        // поколение (ответ, пришедший прежнему прогону, ему уже не нужен) и отосланные стадии
        restarts: 0, gen: 0, calls: new Map(), used: new Map(), stagesSent: 0, stageSkip: 0,
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
          // о долгом ожидании клиент узнаёт до отказа за него, даже если порог извещения не прошёл
          if (!job.announced && job.onQueued) {
            stats.announced++;
            try { job.onQueued({ position: i + 1 }); } catch { /* ignore */ }
          }
          job.announced = true;
          waiting.splice(i, 1);
          stats.queueExpired++;
          // круг 45 (arch-r44): причина в detail — как у очереди чтений (`cause:'agent'`)
          finish(job, null, new OrchError(503, 'busy', `Агент перегружен: команда ждала расчёта дольше ${Math.round(queueWaitMs / 1000)} с и не выполнена. Повторите чуть позже.`, { retryAfter: 10, detail: { cause: 'agent', queue: 'workers' } }));
          pump();
        }, queueWaitMs);
        if (job.queueTimer.unref) job.queueTimer.unref();
        armNotice(job, noticeMs());
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
