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
 *   STATIC_DIR       каталог клиента (index.html, app.js, styles.css, src/*.js) — для прогонов без nginx
 *
 * Останов по SIGTERM/SIGINT: сокеты закрываются кодом 1001, новых транзакций
 * нет, снимки в полёте дописываются, пул базы закрывается.
 *
 * Экспорт `start(opts)` — тот же сервис программно (тесты поднимают его на
 * PORT=0 с любым адаптером; два `start` над одним хранилищем — два экземпляра).
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
import { SNAPSHOT_EVERY, SNAPSHOT_KEEP, HEAVY_CONCURRENCY, HEAVY_QUEUE, RETRY_AFTER_S, PAGE_BYTES, VERIFY_MS } from './limits.js';

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
 *   log?: {info:Function, warn:Function}
 * }} [opts] всё необязательно — умолчания из окружения и limits.js
 */
export async function start(opts = {}) {
  const env = process.env;
  const log = opts.log || console;
  const num = (v, d) => (v !== undefined ? v : d);
  const port = opts.port !== undefined ? opts.port : Number(env.PORT || 8080);
  const host = opts.host || env.HOST || '0.0.0.0';
  const snapshotEvery = num(opts.snapshotEvery, Number(env.SNAPSHOT_EVERY || SNAPSHOT_EVERY));
  const snapshotKeep = num(opts.snapshotKeep, Number(env.SNAPSHOT_KEEP || SNAPSHOT_KEEP));
  const staticDir = opts.staticDir !== undefined ? opts.staticDir : (env.STATIC_DIR || undefined);
  const databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : env.DATABASE_URL;
  const internalToken = opts.internalToken !== undefined ? opts.internalToken : (env.INTERNAL_TOKEN || '');
  const instanceId = opts.instanceId || 'doc_' + randomBytes(5).toString('hex');

  let storage = opts.storage;
  if (!storage) {
    if (databaseUrl) {
      storage = createPgStorage({ connectionString: databaseUrl, log });
    } else {
      log.warn('[document] DATABASE_URL не задан — хранилище в памяти, данные не переживут перезапуск');
      storage = createMemoryStorage();
    }
  }
  await storage.init();

  const heavy = createSemaphore({
    max: num(opts.heavyConcurrency, HEAVY_CONCURRENCY),
    queue: num(opts.heavyQueue, HEAVY_QUEUE),
    retryAfter: num(opts.retryAfter, RETRY_AFTER_S)
  });
  const dslr = createReader({ storage, heavy, pageBytes: num(opts.pageBytes, PAGE_BYTES) });
  const dslts = createSequencer({
    storage, instanceId, snapshotEvery, snapshotKeep, idleMs: opts.idleMs,
    verifyMs: num(opts.verifyMs, VERIFY_MS),
    mergeBudgetMs: opts.mergeBudgetMs, maxDocNodes: opts.maxDocNodes, maxDocBytes: opts.maxDocBytes, log
  });
  const server = http.createServer(createRequestHandler({ dslr, dslts, storage, staticDir, internalToken, log }));
  const hub = createHub({ server, dslr, dslts, pingInterval: opts.pingInterval, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  log.info(`[document] слушаю http://${host}:${actualPort} · движок ${ENGINE_VERSION} · хранилище ${storage.kind} · экземпляр ${instanceId}${staticDir ? ` · статика ${path.resolve(staticDir)}` : ''}`);

  let closing = null;
  /** Остановить сервис; хранилище закрывается, только если `closeStorage` (по умолчанию — да). */
  const close = ({ closeStorage = true } = {}) => {
    if (closing) return closing;
    closing = (async () => {
      await hub.close();
      await new Promise((resolve) => server.close(() => resolve()));
      await dslts.close();
      if (closeStorage) await storage.close();
    })();
    return closing;
  };

  return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}`, storage, dslr, dslts, hub, instanceId, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().then((svc) => {
    const stop = (signal) => {
      console.info(`[document] ${signal} — останавливаюсь`);
      // на второй сигнал — сразу; на зависшее закрытие — через 10 с
      const hard = setTimeout(() => process.exit(1), 10000);
      hard.unref();
      svc.close().then(() => process.exit(0), (e) => {
        console.error('[document] не удалось остановиться чисто:', e);
        process.exit(1);
      });
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  }).catch((e) => {
    console.error('[document] не запустился:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
