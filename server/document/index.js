/**
 * Document service — вход (SPEC §8.1: модули DSLR + DSLTS + Hub в одном процессе).
 *
 *   node server/document/index.js
 *
 * Окружение:
 *   PORT             порт HTTP и WebSocket (8080); 0 — случайный (тесты)
 *   DATABASE_URL     postgres://…; не задан — хранилище в памяти (данные живут до перезапуска)
 *   DB_TIMEOUT_MS    дедлайн обычного запроса к базе (8000); миграции идут без него
 *   SNAPSHOT_EVERY   снимок раз в N транзакций (50); 0 — только при создании проекта
 *   SNAPSHOT_KEEP    сколько последних снимков хранить (5); снимок seq 0 не удаляется никогда
 *   INTERNAL_TOKEN   токен внутренних маршрутов (`POST /api/internal/traces`); не задан или
 *                    «change-me» — внутренние маршруты отвечают 403
 *   PRESENCE_TTL_MS  без вестей от клиента столько — он ушёл (45000; клиент шлёт сердцебиение раз в 15 с)
 *   WS_INFLIGHT      необработанных транзакций на сокет (2), сверх — пауза чтения и `error busy`
 *   WS_CONNECTING    сокетов одновременно от upgrade до hello (6), остальные ждут очереди
 *   HTTP_WRITE_CONCURRENCY, HTTP_WRITE_QUEUE   семафор `POST …/tx`: одновременно (8) и в очереди (64)
 *   QUEUE_PROJECT_BYTES, QUEUE_PROJECT_TXS, QUEUE_TOTAL_BYTES   очередь записи: на проект
 *                    (32 МиБ, 256 транзакций) и на экземпляр (128 МиБ); сверх — 503 busy
 *   TOMB_KEEP_SEQ, TOMB_PRUNE_EVERY, TOMB_MAX   прореживание надгробий головы (10000, 500, 50000)
 *   RECENT_TXS, RECENT_BYTES   память головы о последних транзакциях (500 выжимок, 16 МиБ)
 *   WRITE_BODY_BYTES, BODY_TIMEOUT_MS   HTTP-запись: бюджет читаемых тел на экземпляр (64 МиБ;
 *                    сверх — 503 busy) и срок тела (30000 мс; дольше — 408)
 *   HEADS_BYTES      головы секвенсора в памяти — байты документов, выжимок и надгробий (256 МиБ); сверх — выгрузка давно
 *                    не тронутых голов без сокетов и без записи (круг 33)
 *   IMPORT_CONCURRENCY, IMPORT_QUEUE   подготовка импорта (`POST /api/projects` с документом) в потоках:
 *                    одновременно (2) и в очереди (8); сверх — 503 busy (круг 33)
 *   IMPORT_TASK_MS   срок задачи импорта: очередь + подготовка (30000 мс; дольше — 503, круг 35)
 *   SNAPSHOT_CACHE_BYTES   кеш сериализованных снимков полного открытия (128 МиБ; 0 — без кеша, круг 33)
 *   Числа — целые; пустое — умолчание из limits.js; негодное — предупреждение в лог и умолчание
 *   (опечатка в окружении не должна снимать предел). Итог — `svc.config`.
 *   STATIC_DIR       каталог клиента (index.html, app.js, styles.css, src/*.js) — для прогонов без nginx
 *   IMAGO_ENGINE     версия движка экземпляра — ТОЛЬКО для стендов смешанных версий (круг 39): можно
 *                    понизить (не ниже ENGINE_MIN_READ), но не поднять выше версии движка кода
 *
 * Порт открывается СРАЗУ, до миграций базы (SPEC §9.11): пока они идут,
 * `GET /api/health` и все прочие маршруты отвечают 503 `migrating` (`detail:
 * {phase, migration, progress}`, `Retry-After`), сокеты — тем же 503 на upgrade.
 * Так проверка здоровья (compose, балансировщик) видит живой процесс, а не отказ
 * соединения, и знает, что он делает. Миграции упали — понятная ошибка и выход с
 * кодом 1; повторный старт продолжит с упавшей миграции.
 *
 * Останов по SIGTERM/SIGINT (обработчики ставятся до миграций): сокеты закрываются
 * кодом 1001, новых транзакций нет, снимки в полёте дописываются, пул базы
 * закрывается; во время миграций — обрывается соединение миграций (база откатывает
 * текущую пачку, сделанное раньше сохранено).
 *
 * Страховка процесса (круг 29, `installCrashGuard`): необработанное исключение или
 * отказ промиса — строка в лог со стеком, процесс живёт дальше: ошибка одного сокета или
 * запроса не должна обрывать всех остальных. Фатальное — по-прежнему выход с кодом 1
 * (через мягкий останов): до готовности сервиса, системные коды (порт занят, нет памяти)
 * и шторм — больше 20 таких ошибок за минуту (значит, сломано что-то общее).
 *
 * Экспорт `start(opts)` — тот же сервис программно (тесты поднимают его на
 * PORT=0 с любым адаптером; два `start` над одним хранилищем — два экземпляра);
 * промис — когда сервис готов. `launch(opts)` — то же, но промис — когда открыт
 * порт: `{port, url, ready, close, state}`, `ready` — промис готового сервиса.
 */

import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../../src/core.js';
import { createPgStorage } from './storage/pg.js';
import { createMemoryStorage } from './storage/memory.js';
import { createReader, createSemaphore } from './dslr.js';
import { createSequencer } from './dslts.js';
import { createHub } from './hub.js';
import { createRequestHandler } from './http.js';
import { createImportPool } from './import-pool.js';
import { resolveEngine } from './engine.js';
import { migrating, setStorageLog } from './errors.js';
import {
  SNAPSHOT_EVERY, SNAPSHOT_KEEP, HEAVY_CONCURRENCY, HEAVY_QUEUE, RETRY_AFTER_S, PAGE_BYTES, VERIFY_MS, PRESENCE_TTL_MS,
  WS_INFLIGHT, WS_CONNECTING, HTTP_WRITE_CONCURRENCY, HTTP_WRITE_QUEUE, QUEUE_PROJECT_BYTES, QUEUE_PROJECT_TXS, QUEUE_TOTAL_BYTES,
  DB_TIMEOUT_MS, TOMB_KEEP_SEQ, TOMB_PRUNE_EVERY, TOMB_MAX, RECENT_TXS, RECENT_BYTES, WRITE_BODY_BYTES, BODY_TIMEOUT_MS,
  HEADS_BYTES, IMPORT_CONCURRENCY, IMPORT_QUEUE, IMPORT_TASK_MS, SNAPSHOT_CACHE_BYTES
} from './limits.js';

/**
 * Пределы, которые можно задать окружением (круг 26): имя переменной → [опция start(),
 * умолчание из limits.js, наименьшее допустимое]. Опция start() главнее окружения.
 */
export const ENV_LIMITS = Object.freeze({
  SNAPSHOT_EVERY: ['snapshotEvery', SNAPSHOT_EVERY, 0],
  SNAPSHOT_KEEP: ['snapshotKeep', SNAPSHOT_KEEP, 1],
  PRESENCE_TTL_MS: ['presenceTtlMs', PRESENCE_TTL_MS, 1000],
  DB_TIMEOUT_MS: ['dbTimeoutMs', DB_TIMEOUT_MS, 100],
  WS_INFLIGHT: ['maxInflight', WS_INFLIGHT, 1],
  // круг 29: сокетов одновременно от upgrade до hello (шторм подключений не занимает весь пул)
  WS_CONNECTING: ['maxConnecting', WS_CONNECTING, 1],
  HTTP_WRITE_CONCURRENCY: ['writesMax', HTTP_WRITE_CONCURRENCY, 1],
  HTTP_WRITE_QUEUE: ['writesQueue', HTTP_WRITE_QUEUE, 0],
  QUEUE_PROJECT_BYTES: ['queueProjectBytes', QUEUE_PROJECT_BYTES, 1],
  QUEUE_PROJECT_TXS: ['queueProjectTxs', QUEUE_PROJECT_TXS, 1],
  QUEUE_TOTAL_BYTES: ['queueTotalBytes', QUEUE_TOTAL_BYTES, 1],
  // круг 27: надгробия и память головы (секвенсор), бюджет и таймаут тел HTTP-записи
  TOMB_KEEP_SEQ: ['tombKeepSeq', TOMB_KEEP_SEQ, 0],
  TOMB_PRUNE_EVERY: ['tombPruneEvery', TOMB_PRUNE_EVERY, 1],
  TOMB_MAX: ['tombMax', TOMB_MAX, 0],
  RECENT_TXS: ['recentTxs', RECENT_TXS, 1],
  RECENT_BYTES: ['recentBytes', RECENT_BYTES, 1],
  WRITE_BODY_BYTES: ['writesBodyBytes', WRITE_BODY_BYTES, 1],
  BODY_TIMEOUT_MS: ['writesBodyTimeoutMs', BODY_TIMEOUT_MS, 1000],
  // круг 33: головы в памяти (байты документов, LRU), потоки подготовки импорта, кеш снимков
  HEADS_BYTES: ['headsBytes', HEADS_BYTES, 1024 * 1024],
  IMPORT_CONCURRENCY: ['importConcurrency', IMPORT_CONCURRENCY, 1],
  IMPORT_QUEUE: ['importQueue', IMPORT_QUEUE, 0],
  // круг 35: срок задачи импорта (очередь + подготовка в потоке)
  IMPORT_TASK_MS: ['importTaskMs', IMPORT_TASK_MS, 1000],
  SNAPSHOT_CACHE_BYTES: ['snapshotCacheBytes', SNAPSHOT_CACHE_BYTES, 0],
});

/** Опции start(), которые живут внутри `opts.writes` (ключ итога → поле writes). */
const WRITES_KEYS = Object.freeze({
  writesMax: 'max', writesQueue: 'queue', writesBodyBytes: 'bodyBytes', writesBodyTimeoutMs: 'bodyTimeoutMs'
});

/**
 * Итоговые пределы: опция → окружение → умолчание. Негодное в окружении (не целое,
 * меньше допустимого) — строка в лог и умолчание.
 * @param {object} opts опции start()
 * @param {Record<string, string|undefined>} env
 * @param {{warn: Function}} log
 * @returns {Record<string, number>} по именам опций
 */
export function limitsFrom(opts, env, log) {
  const out = {};
  for (const [name, [key, def, min]] of Object.entries(ENV_LIMITS)) {
    const fromOpt = WRITES_KEYS[key] ? opts.writes && opts.writes[WRITES_KEYS[key]] : opts[key];
    if (fromOpt !== undefined) { out[key] = fromOpt; continue; }
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') { out[key] = def; continue; }
    const n = Number(String(raw).trim());
    if (!Number.isSafeInteger(n) || n < min) {
      log.warn(`[document] ${name}=${JSON.stringify(String(raw).slice(0, 40))} — не целое от ${min}; беру ${def}`);
      out[key] = def;
      continue;
    }
    out[key] = n;
  }
  return out;
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   databaseUrl?: string,
 *   storage?: object,
 *   snapshotEvery?: number,
 *   snapshotKeep?: number,
 *   staticDir?: string,
 *   internalToken?: string,
 *   idleMs?: number,
 *   verifyMs?: number,
 *   pingInterval?: number,
 *   heavyConcurrency?: number,
 *   heavyQueue?: number,
 *   retryAfter?: number,
 *   pageBytes?: number,
 *   mergeBudgetMs?: number,
 *   maxDocNodes?: number,
 *   maxDocBytes?: number,
 *   instanceId?: string,
 *   presenceTtlMs?: number,
 *   maxBuffered?: number,
 *   maxInflight?: number,
 *   maxConnecting?: number,
 *   writes?: {max?: number, queue?: number, retryAfter?: number, bodyBytes?: number, bodyTimeoutMs?: number},
 *   tombKeepSeq?: number, tombPruneEvery?: number, tombMax?: number,
 *   recentTxs?: number, recentBytes?: number,
 *   queueProjectBytes?: number,
 *   queueProjectTxs?: number,
 *   queueTotalBytes?: number,
 *   dbTimeoutMs?: number,
 *   frameCache?: {frames?: number, roomBytes?: number, totalBytes?: number},
 *   presence?: {tickMs?: number, roomFrames?: number, batchBytes?: number, busPerTick?: number},
 *   importInlineBytes?: number,
 *   importTaskMs?: number,         // срок задачи импорта (круг 35; IMPORT_TASK_MS)
 *   importWorkerUrl?: URL,         // модуль потока импорта (тестам)
 *   engine?: number,               // версия движка экземпляра (круг 39; тестам смешанных версий — ниже; IMAGO_ENGINE)
 *   log?: {info:Function, warn:Function}
 * }} [opts] всё необязательно — умолчания из окружения и limits.js
 */
export async function start(opts = {}) {
  const l = await launch(opts);
  try {
    return await l.ready;
  } catch (e) {
    await l.close().catch(() => {});
    throw e;
  }
}

/** Повторить через столько секунд, пока идут миграции. */
const MIGRATING_RETRY_S = 5;

/**
 * Открыть порт сразу, хранилище (миграции) — следом. Опции — как у start().
 * @returns {Promise<{server: http.Server, port: number, url: string, storage: object, instanceId: string,
 *   ready: Promise<object>, close: Function, readonly state: 'starting'|'ready'|'failed'|'closed'}>}
 */
export async function launch(opts = {}) {
  const env = process.env;
  const log = opts.log || console;
  const num = (v, d) => (v !== undefined ? v : d);
  const port = opts.port !== undefined ? opts.port : Number(env.PORT || 8080);
  const host = opts.host || env.HOST || '0.0.0.0';
  const config = limitsFrom(opts, env, log);
  const { snapshotEvery, snapshotKeep } = config;
  const staticDir = opts.staticDir !== undefined ? opts.staticDir : (env.STATIC_DIR || undefined);
  const databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : env.DATABASE_URL;
  const internalToken = opts.internalToken !== undefined ? opts.internalToken : (env.INTERNAL_TOKEN || '');
  const instanceId = opts.instanceId || 'doc_' + randomBytes(5).toString('hex');
  // круг 39: версия движка экземпляра — движка; тестам и стендам смешанных версий — ниже (engine.js)
  const engine = resolveEngine(opts.engine, env, log);

  let storage = opts.storage;
  if (!storage) {
    if (databaseUrl) {
      storage = createPgStorage({ connectionString: databaseUrl, log, dbTimeoutMs: config.dbTimeoutMs });
    } else {
      log.warn('[document] DATABASE_URL не задан — хранилище в памяти, данные не переживут перезапуск');
      storage = createMemoryStorage();
    }
  }
  setStorageLog(log);
  let state = 'starting';

  // До готовности — 503 migrating на всё (и на /api/health), после — маршруты http.js.
  const detail = () => {
    const m = storage.migrationState;
    return m ? { phase: m.phase, migration: m.migration, progress: m.progress } : { phase: 'init', migration: null, progress: null };
  };
  let handler = null;
  const notReady = (req, res) => {
    const err = migrating(detail(), MIGRATING_RETRY_S);
    const body = JSON.stringify(err.body());
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(MIGRATING_RETRY_S),
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body)
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const server = http.createServer((req, res) => (handler ? handler(req, res) : notReady(req, res)));
  // сокет до готовности: тот же 503 ответом на upgrade (Hub ещё не создан)
  const earlyUpgrade = (req, socket) => {
    const body = JSON.stringify(migrating(detail(), MIGRATING_RETRY_S).body());
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\nRetry-After: ${MIGRATING_RETRY_S}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  };
  server.on('upgrade', earlyUpgrade);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  // «слушаю …» — только когда сервис готов (по этой строке его ждут скрипты и тесты)
  log.info(`[document] порт http://${host}:${actualPort} открыт · хранилище ${storage.kind} готовится (миграции; до готовности — 503 migrating) · экземпляр ${instanceId}`);

  let svc = null;
  let parts = null;
  let closing = null;

  const ready = (async () => {
    const t0 = Date.now();
    await storage.init();
    if (closing) throw new Error('остановлен до готовности');
    const heavy = createSemaphore({
      max: num(opts.heavyConcurrency, HEAVY_CONCURRENCY),
      queue: num(opts.heavyQueue, HEAVY_QUEUE),
      retryAfter: num(opts.retryAfter, RETRY_AFTER_S)
    });
    const dslr = createReader({ storage, heavy, pageBytes: num(opts.pageBytes, PAGE_BYTES), snapshotCacheBytes: config.snapshotCacheBytes, engine });
    const dslts = createSequencer({
      storage, instanceId, snapshotEvery, snapshotKeep, idleMs: opts.idleMs,
      verifyMs: num(opts.verifyMs, VERIFY_MS),
      mergeBudgetMs: opts.mergeBudgetMs, maxDocNodes: opts.maxDocNodes, maxDocBytes: opts.maxDocBytes, log,
      queueProjectBytes: config.queueProjectBytes, queueProjectTxs: config.queueProjectTxs, queueTotalBytes: config.queueTotalBytes,
      tombKeepSeq: config.tombKeepSeq, tombPruneEvery: config.tombPruneEvery, tombMax: config.tombMax,
      recentTxs: config.recentTxs, recentBytes: config.recentBytes, headsBytes: config.headsBytes,
      engine
    });
    // шина присутствия между экземплярами (SPEC §9.9): эфемерный канал хранилища
    const bus = typeof storage.publish === 'function' && typeof storage.onNotify === 'function'
      ? { publish: (msg) => storage.publish(msg), subscribe: (fn) => storage.onNotify(fn) }
      : null;
    server.off('upgrade', earlyUpgrade);
    const hub = createHub({
      server, dslr, dslts, bus, instanceId, pingInterval: opts.pingInterval,
      presenceTtlMs: config.presenceTtlMs, maxInflight: config.maxInflight, maxConnecting: config.maxConnecting,
      maxBuffered: opts.maxBuffered, frameCache: opts.frameCache, presence: opts.presence, log
    });
    parts = { dslr, dslts, hub, importer: null };
    const writes = {
      ...(opts.writes || {}), max: config.writesMax, queue: config.writesQueue,
      bodyBytes: config.writesBodyBytes, bodyTimeoutMs: config.writesBodyTimeoutMs
    };
    // круг 33: разбор и проверка большого документа импорта — в потоках, не в цикле событий
    const importer = createImportPool({
      // пределы документа — те же, что и прежде у создания (MAX_DOC_*), а не опции секвенсора
      size: config.importConcurrency, queue: config.importQueue, log,
      ...(opts.importInlineBytes !== undefined ? { inlineBytes: opts.importInlineBytes } : {}),
      taskMs: config.importTaskMs,
      ...(opts.importWorkerUrl ? { workerUrl: opts.importWorkerUrl } : {})
    });
    handler = createRequestHandler({ dslr, dslts, storage, staticDir, internalToken, log, writes, importer });
    parts.importer = importer;
    state = 'ready';
    log.info(`[document] слушаю http://${host}:${actualPort} · готов за ${Date.now() - t0} мс · движок ${engine}${engine !== ENGINE_VERSION ? ` (понижен с ${ENGINE_VERSION})` : ''} · хранилище ${storage.kind} · экземпляр ${instanceId}${staticDir ? ` · статика ${path.resolve(staticDir)}` : ''}`);
    svc = { server, port: actualPort, url, storage, dslr, dslts, hub, importer, instanceId, config, close };
    return svc;
  })();
  ready.catch(() => { if (state === 'starting') state = 'failed'; });

  /** Остановить сервис; хранилище закрывается, только если `closeStorage` (по умолчанию — да). */
  function close({ closeStorage = true } = {}) {
    if (closing) return closing;
    closing = (async () => {
      if (parts) await parts.hub.close();
      else server.off('upgrade', earlyUpgrade);
      // во время миграций хранилище закрывается первым: оно обрывает соединение миграций
      if (!parts && closeStorage) await storage.close().catch(() => {});
      await Promise.race([ready.catch(() => {}), new Promise((r) => setTimeout(r, 5000).unref())]);
      await new Promise((resolve) => server.close(() => resolve()));
      if (parts) {
        if (parts.importer) await parts.importer.close();
        await parts.dslts.close();
        if (closeStorage) await storage.close();
      }
      state = 'closed';
    })();
    return closing;
  }

  return {
    server, port: actualPort, url, storage, instanceId, config, ready, close,
    get state() { return state; }
  };
}

/** Коды ошибок, после которых процессу не жить: сеть не поднять, памяти нет. */
const FATAL_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'ENOMEM', 'ERR_WORKER_OUT_OF_MEMORY']);

/**
 * Страховка от необработанных ошибок (круг 29). Возвращает функцию снятия.
 * @param {{
 *   log?: {warn: Function},
 *   onFatal: (e: any) => void,
 *   isReady?: () => boolean,
 *   stormMax?: number, stormWindowMs?: number,
 *   target?: NodeJS.EventEmitter
 * }} o `target` — кого слушать (process; тестам — свой EventEmitter)
 * @returns {() => void}
 */
export function installCrashGuard({ log = console, onFatal, isReady = () => true, stormMax = 20, stormWindowMs = 60000, target = process }) {
  let recent = [];
  let fatal = false;
  const handle = (kind, e) => {
    const now = Date.now();
    recent = recent.filter((t) => now - t < stormWindowMs);
    recent.push(now);
    const code = e && typeof e === 'object' && typeof e.code === 'string' ? e.code : '';
    const why = !isReady() ? 'сервис ещё не готов' : FATAL_CODES.has(code) ? `код ${code}` : recent.length > stormMax ? `${recent.length} ошибок за ${Math.round(stormWindowMs / 1000)} с` : '';
    try {
      log.warn(`[document] ${kind}${why ? ` — фатально (${why}), выхожу` : ' — процесс продолжает работу'}:`, e && e.stack ? e.stack : e);
    } catch (_) { /* лог — не наша забота */ }
    if (why && !fatal) {
      fatal = true;
      onFatal(e);
    }
  };
  const onException = (e) => handle('необработанное исключение', e);
  const onRejection = (e) => handle('необработанный отказ промиса', e);
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.off('uncaughtException', onException);
    target.off('unhandledRejection', onRejection);
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  launch().then((l) => {
    let stopping = false;
    const stop = (signal) => {
      if (stopping) process.exit(1);   // второй сигнал — сразу
      stopping = true;
      console.info(`[document] ${signal} — останавливаюсь${l.state === 'starting' ? ' (посреди миграций: сделанное сохранено)' : ''}`);
      // на зависшее закрытие — через 10 с
      const hard = setTimeout(() => process.exit(1), 10000);
      hard.unref();
      l.close().then(() => process.exit(0), (e) => {
        console.error('[document] не удалось остановиться чисто:', e);
        process.exit(1);
      });
    };
    // обработчики — до миграций: SIGTERM посреди долгой миграции не убивает процесс жёстко
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    installCrashGuard({
      isReady: () => l.state === 'ready',
      onFatal: () => {
        process.exitCode = 1;
        const hard = setTimeout(() => process.exit(1), 5000);
        hard.unref();
        l.close().finally(() => process.exit(1));
      }
    });
    l.ready.catch((e) => {
      if (stopping) return;
      console.error('[document] не запустился:', e && e.message ? e.message : e);
      const hard = setTimeout(() => process.exit(1), 5000);
      hard.unref();
      l.close().finally(() => process.exit(1));
    });
  }).catch((e) => {
    console.error('[document] не запустился:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
