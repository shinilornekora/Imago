/**
 * Document service — вход (SPEC §8.1: модули DSLR + DSLTS + Hub в одном процессе).
 *
 *   node server/document/index.js
 *
 * Окружение:
 *   PORT            порт HTTP и WebSocket (8080); 0 — случайный (тесты)
 *   DATABASE_URL    postgres://…; не задан — хранилище в памяти (данные живут до перезапуска)
 *   SNAPSHOT_EVERY  снимок раз в N транзакций (50); 0 — только при создании проекта
 *   STATIC_DIR      каталог клиента (index.html, app.js, styles.css, src/*.js) — для прогонов без nginx
 *
 * Останов по SIGTERM/SIGINT: сокеты закрываются кодом 1001, новых транзакций
 * нет, снимки в полёте дописываются, пул базы закрывается.
 *
 * Экспорт `start(opts)` — тот же сервис программно (тесты поднимают его на
 * PORT=0 с любым адаптером).
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../../src/core.js';
import { createPgStorage } from './storage/pg.js';
import { createMemoryStorage } from './storage/memory.js';
import { createReader } from './dslr.js';
import { createSequencer } from './dslts.js';
import { createHub } from './hub.js';
import { createRequestHandler } from './http.js';

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   databaseUrl?: string,
 *   storage?: object,
 *   snapshotEvery?: number,
 *   staticDir?: string,
 *   idleMs?: number,
 *   pingInterval?: number,
 *   log?: {info:Function, warn:Function}
 * }} [opts] всё необязательно — умолчания из окружения
 */
export async function start(opts = {}) {
  const env = process.env;
  const log = opts.log || console;
  const port = opts.port !== undefined ? opts.port : Number(env.PORT || 8080);
  const host = opts.host || env.HOST || '0.0.0.0';
  const snapshotEvery = opts.snapshotEvery !== undefined ? opts.snapshotEvery : Number(env.SNAPSHOT_EVERY || 50);
  const staticDir = opts.staticDir !== undefined ? opts.staticDir : (env.STATIC_DIR || undefined);
  const databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : env.DATABASE_URL;

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

  const dslr = createReader({ storage });
  const dslts = createSequencer({ storage, snapshotEvery, idleMs: opts.idleMs, log });
  const server = http.createServer(createRequestHandler({ dslr, dslts, storage, staticDir, log }));
  const hub = createHub({ server, dslr, dslts, pingInterval: opts.pingInterval, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  log.info(`[document] слушаю http://${host}:${actualPort} · движок ${ENGINE_VERSION} · хранилище ${storage.kind}${staticDir ? ` · статика ${path.resolve(staticDir)}` : ''}`);

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      await hub.close();
      await new Promise((resolve) => server.close(() => resolve()));
      await dslts.close();
      await storage.close();
    })();
    return closing;
  };

  return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}`, storage, dslr, dslts, hub, close };
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
