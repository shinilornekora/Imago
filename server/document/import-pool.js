/**
 * Пул потоков подготовки импорта (круг 33): `run(buf)` → то же, что `prepareProject` из
 * importer.js, но разбор и проверка большого документа идут в отдельном потоке — цикл
 * событий сервиса (запись соседних проектов, сокеты, статика) их не ждёт.
 *
 * Потоков — не больше `size` (IMPORT_CONCURRENCY; заводятся по требованию и живут дальше),
 * в очереди — не больше `queue` (IMPORT_QUEUE), сверх — 503 busy. Тело меньше `inlineBytes`
 * готовится сразу в главном потоке (миллисекунды — передача в поток дороже). Поток упал (нет
 * памяти, сбой) — его задача получает 503, на его место заводится новый. Поток завести не
 * удалось вовсе (среда без worker_threads) — подготовка в главном потоке, по одной (тот же
 * семафор), как предупреждение в лог. Круг 35: у задачи — срок `taskMs` (IMPORT_TASK_MS, очередь и
 * подготовка вместе): не уложилась — 503 `cause:'import_timeout'`, поток с ней останавливается и
 * заменяется (зависший поток не держит запрос и место в пуле вечно).
 */

import { Worker } from 'node:worker_threads';
import { DocError, badRequest, busy, unavailable } from './errors.js';
import { prepareProject } from './importer.js';
import { IMPORT_CONCURRENCY, IMPORT_QUEUE, IMPORT_INLINE_BYTES, IMPORT_TASK_MS, BUSY_RETRY_S } from './limits.js';

const WORKER_URL = new URL('./import-worker.js', import.meta.url);
/** Куча потока: документ в 4 МБ JSON (20 тыс. узлов) — сотни МБ объектов на пике; с запасом. */
const WORKER_HEAP_MB = 1024;

/**
 * @param {{size?: number, queue?: number, inlineBytes?: number, taskMs?: number, workerUrl?: URL, opts?: object, log?: {warn: Function}}} [o]
 *   `opts` — пределы prepareProject (maxNodes, maxDocBytes); `taskMs` — срок задачи (очередь +
 *   подготовка, круг 35; 0 — без срока); `workerUrl` — модуль потока (тестам: падающий, зависающий)
 */
export function createImportPool({ size = IMPORT_CONCURRENCY, queue = IMPORT_QUEUE, inlineBytes = IMPORT_INLINE_BYTES, taskMs = IMPORT_TASK_MS, workerUrl = WORKER_URL, opts = {}, log = console } = {}) {
  const max = Math.max(1, Math.floor(size));
  /** @type {{w: Worker, task: object|null}[]} */
  const workers = [];
  const waiting = [];
  let seq = 0;
  let closed = false;
  let noWorkers = false;
  let inlineActive = 0;
  const stats = { inline: 0, worker: 0, refused: 0, crashed: 0, timedOut: 0, peakWaiting: 0 };

  const toError = (err) => new DocError(err.status || 500, err.code || 'internal', err.message || 'импорт не подготовлен', {
    retryable: err.retryable, detail: err.detail
  });

  function spawn() {
    const slot = { w: null, task: null };
    const w = new Worker(workerUrl, { workerData: { opts }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    w.unref();
    slot.w = w;
    w.on('message', (m) => {
      const t = slot.task;
      if (!t || !m || m.id !== t.id) return;
      slot.task = null;
      t.slot = null;
      for (const warn of m.warns || []) log.warn(warn);
      if (m.ok) t.resolve(m.out);
      else t.reject(toError(m.error || {}));
      next();
    });
    let gone = false;
    const dead = (why) => {
      if (gone) return;
      gone = true;
      const i = workers.indexOf(slot);
      if (i >= 0) workers.splice(i, 1);
      const t = slot.task;
      slot.task = null;
      if (t) {
        t.slot = null;
        stats.crashed += 1;
        log.warn(`[document/import] поток подготовки импорта упал (${why}) — запрос получает 503`);
        t.reject(unavailable('импорт не подготовлен: поток подготовки упал — повторите позже', { detail: { cause: 'import_worker' } }));
      }
      next();
    };
    slot.dead = dead;
    w.on('error', (e) => dead((e && (e.code || e.message)) || 'ошибка'));
    w.on('exit', (code) => { if (!closed) dead(`выход ${code}`); });
    workers.push(slot);
    return slot;
  }

  /** Свободный поток (или новый, если есть место) — следующей задаче из очереди. */
  function next() {
    while (waiting.length && !closed) {
      let slot = workers.find((s) => !s.task);
      if (!slot && workers.length < max && !noWorkers) {
        try {
          slot = spawn();
        } catch (e) {
          noWorkers = true;
          log.warn('[document/import] поток подготовки импорта не заводится — готовлю в главном потоке:', e && e.message);
        }
      }
      if (noWorkers) {
        if (inlineActive >= max) return;
        const t = waiting.shift();
        inlineActive += 1;
        // по одному в тике: отпустить цикл между задачами
        setImmediate(() => {
          try {
            t.resolve(runInline(t.buf));
          } catch (e) {
            t.reject(e);
          } finally {
            inlineActive -= 1;
            next();
          }
        });
        continue;
      }
      if (!slot) return;
      const t = waiting.shift();
      slot.task = t;
      t.slot = slot;
      stats.worker += 1;
      // байты тела — передачей (без копии); Buffer из пула node копируется в свой ArrayBuffer
      const ab = t.buf.byteOffset === 0 && t.buf.byteLength === t.buf.buffer.byteLength ? t.buf.buffer : t.buf.buffer.slice(t.buf.byteOffset, t.buf.byteOffset + t.buf.byteLength);
      try {
        slot.w.postMessage({ id: t.id, buf: ab }, [ab]);
      } catch (e) {
        slot.task = null;
        t.reject(unavailable('импорт не подготовлен: ' + (e && e.message)));
      }
    }
  }

  function runInline(buf) {
    let body;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      throw badRequest('тело не JSON');
    }
    return prepareProject(body, { ...opts, onWarn: (w) => log.warn(w) });
  }

  return {
    /**
     * Тело запроса (байты) → `{name, kind, createId?, docJson, docBytes}`; ошибки — DocError.
     * @param {Buffer|null} buf
     */
    run(buf) {
      if (closed) return Promise.reject(unavailable('сервис останавливается'));
      if (!buf || buf.length < inlineBytes) {
        stats.inline += 1;
        try {
          return Promise.resolve(buf ? runInline(buf) : prepareProject({}, { ...opts, onWarn: (w) => log.warn(w) }));
        } catch (e) {
          return Promise.reject(e);
        }
      }
      if (waiting.length >= queue) {
        stats.refused += 1;
        return Promise.reject(busy('сервер готовит много импортов сразу — повторите чуть позже', { retryAfter: BUSY_RETRY_S, detail: { limit: 'import_queue' } }));
      }
      return new Promise((resolve, reject) => {
        let timer = null;
        const settle = (fn) => (v) => {
          if (task.settled) return;
          task.settled = true;
          if (timer) clearTimeout(timer);
          fn(v);
        };
        const task = { id: ++seq, buf, resolve: settle(resolve), reject: settle(reject), slot: null, settled: false };
        // круг 35: у задачи есть срок — запрос не висит вечно, что бы ни случилось с потоком
        if (taskMs > 0) {
          timer = setTimeout(() => {
            if (task.settled) return;
            stats.timedOut += 1;
            const i = waiting.indexOf(task);
            if (i >= 0) waiting.splice(i, 1);
            const slot = task.slot;
            log.warn(`[document/import] подготовка импорта не уложилась в ${taskMs} мс — запрос получает 503${slot ? ', поток заменяется' : ''}`);
            task.reject(unavailable(`импорт не подготовлен за ${Math.round(taskMs / 1000)} с — повторите позже`, { detail: { cause: 'import_timeout' } }));
            if (slot) {
              // поток занят чужой (уже отвеченной) задачей — останавливаем, на его место — новый
              slot.task = null;
              slot.dead('срок задачи');
              slot.w.terminate().catch(() => {});
            }
          }, taskMs);
          // таймер не unref: задача в полёте — работа, её ответ должен дождаться процесс
        }
        waiting.push(task);
        if (waiting.length > stats.peakWaiting) stats.peakWaiting = waiting.length;
        next();
      });
    },
    /** Счёт подготовок (тестам): сколько в главном потоке, в потоках, отказов, падений; потоков сейчас. */
    stats() {
      return { ...stats, workers: workers.length, busy: workers.filter((s) => s.task).length, waiting: waiting.length };
    },
    async close() {
      closed = true;
      for (const t of waiting.splice(0)) t.reject(unavailable('сервис останавливается'));
      await Promise.all(workers.splice(0).map((s) => {
        if (s.task) s.task.reject(unavailable('сервис останавливается'));
        return s.w.terminate().catch(() => {});
      }));
    }
  };
}
