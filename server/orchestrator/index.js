/**
 * Orchestrator — вход (SPEC §8.1, §10): второй процесс системы, «агент».
 *
 *   node server/orchestrator/index.js        # или: npm run orchestrator
 *
 * Окружение:
 *   PORT              порт HTTP (8090); 0 — случайный (тесты)
 *   HOST              адрес (0.0.0.0)
 *   DOCUMENT_URL      Document service (http://127.0.0.1:8080)
 *   INTERNAL_TOKEN    токен для POST /api/internal/traces; не задан — трассы только в памяти
 *   LLM_KIND          openai (по умолчанию) | anthropic
 *   LLM_BASE_URL      адрес модели; не задан — модель «не подключена» (команды оболочки работают)
 *   LLM_MODEL         имя модели
 *   LLM_API_KEY       ключ модели (никогда не выводится)
 *   LLM_TIMEOUT_MS    дедлайн одного запроса к модели (120000)
 *   LLM_MAX_BODY_BYTES потолок тела ответа модели, байт (8 МБ); больше — llm_bad_response (круг 31)
 *   WORKERS           воркеров DSLV (min(2, CPU))
 *   WORKER_MAX_MB     потолок кучи воркера (512)
 *   WORKER_TIMEOUT_MS счётное время одного прогона, без ожидания модели (60000)
 *   QUEUE_MAX         ждущих команд на проект (4)
 *   WORKER_JOBS       заданий на воркер одновременно, пока они ждут модель (4)
 *   POOL_QUEUE_MAX    ждущих свободного воркера заданий (32); больше — 429 busy
 *   POOL_QUEUE_WAIT_MS сколько задание ждёт воркер (30000); дольше — busy
 *
 * Приём запроса (круг 33, не настраивается окружением — limits.js): тело не пришло за 30 с —
 * 408 timeout; заголовки — 20 с, запрос целиком — 35 с (таймауты http.Server).
 *
 * Останов по SIGTERM/SIGINT: новые команды — 503, выполняемые доводятся (до 10 с),
 * остальное прерывается, потоки закрываются, воркеры снимаются, трассы дописываются.
 *
 * Экспорт `start(opts)` — тот же сервис программно (тесты поднимают его на PORT=0).
 */

import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../../src/core.js';
import { createDocClient } from './docclient.js';
import { createDslrClient } from './dslr/index.js';
import { createDsltsClient } from './dslts/index.js';
import { createDuil } from './duil/index.js';
import { createDslv } from './dslv/index.js';
import { createLlm } from './llm/index.js';
import { createTraces } from './traces.js';
import { createPipeline } from './pipeline.js';
import { createRequestHandler, applyServerTimeouts } from './http.js';
import jev from './jev/index.js';
import { SHUTDOWN_GRACE_MS, SHUTDOWN_FLUSH_MS, SHUTDOWN_HARD_MS, BODY_TIMEOUT_MS } from './limits.js';

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/**
 * @param {{
 *   port?: number, host?: string, documentUrl?: string, internalToken?: string,
 *   llm?: {kind?: string, baseUrl?: string, model?: string, apiKey?: string, timeout?: number},
 *   workers?: number, workerMaxMb?: number, workerTimeoutMs?: number, queueMax?: number,
 *   workerJobs?: number, poolQueueMax?: number, poolQueueWaitMs?: number,
 *   variantsTtlMs?: number, tracePath?: string, testHooks?: boolean, fetch?: typeof fetch,
 *   bodyTimeoutMs?: number, headersTimeoutMs?: number, requestTimeoutMs?: number,
 *   connectionsCheckingIntervalMs?: number,
 *   log?: {info: Function, warn: Function}
 * }} [opts] всё необязательно — умолчания из окружения
 */
export async function start(opts = {}) {
  const env = process.env;
  const port = opts.port !== undefined ? opts.port : Number(env.PORT || 8090);
  const host = opts.host || env.HOST || '0.0.0.0';
  const documentUrl = opts.documentUrl || env.DOCUMENT_URL || 'http://127.0.0.1:8080';
  const internalToken = opts.internalToken !== undefined ? opts.internalToken : env.INTERNAL_TOKEN || '';
  const llmCfg = opts.llm || {
    kind: env.LLM_KIND, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY,
    timeout: num(env.LLM_TIMEOUT_MS),
    // круг 31: потолок тела ответа модели, байт (умолчание — 8 МБ)
    maxBodyBytes: num(env.LLM_MAX_BODY_BYTES),
  };

  const llm = createLlm({ ...llmCfg, fetch: opts.fetch });
  const rawLog = opts.log || console;
  // всё, что уходит в лог, — через redact: ключ не должен оказаться и там
  const log = {
    info: (...a) => rawLog.info(llm.redact(a.map(String).join(' '))),
    warn: (...a) => rawLog.warn(llm.redact(a.map(String).join(' '))),
  };

  const doc = createDocClient({ baseUrl: documentUrl, fetch: opts.fetch });
  const dslr = createDslrClient({ doc, log });
  const dslts = createDsltsClient({ doc, log });
  const duil = createDuil({ dslr, log });
  const dslv = createDslv({
    size: opts.workers || num(env.WORKERS),
    maxOldMb: opts.workerMaxMb || num(env.WORKER_MAX_MB),
    timeoutMs: opts.workerTimeoutMs || num(env.WORKER_TIMEOUT_MS),
    jobsPerWorker: opts.workerJobs || num(env.WORKER_JOBS),
    queueMax: opts.poolQueueMax !== undefined ? opts.poolQueueMax : num(env.POOL_QUEUE_MAX),
    queueWaitMs: opts.poolQueueWaitMs || num(env.POOL_QUEUE_WAIT_MS),
    testHooks: !!opts.testHooks,
    log,
  });
  const traces = createTraces({ doc, token: internalToken, path: opts.tracePath, redact: llm.redact, log });
  // круг 26: id процесса и время старта — в /agent/health; клиент по смене instance узнаёт,
  // что Orchestrator перезапустился (команда, чей поток оборвался, пропала вместе с процессом)
  const instance = opts.instance || 'orch_' + randomBytes(6).toString('hex');
  const startedAt = new Date().toISOString();
  const pipeline = createPipeline({
    dslr, dslts, duil, dslv, llm, traces, jev, log, instance, startedAt,
    docHealth: () => doc.health(),
    docHealthDetail: () => doc.healthDetail(),
    maxQueue: opts.queueMax !== undefined ? opts.queueMax : num(env.QUEUE_MAX),
    variantsTtlMs: opts.variantsTtlMs,
  });
  // круг 33: свой таймер тела (408) и таймауты приёма запроса — как у Document service
  // (из окружения не читается: тело Orchestrator — до 1 МБ, 30 с хватает с запасом)
  const bodyTimeoutMs = opts.bodyTimeoutMs || BODY_TIMEOUT_MS;
  const handler = createRequestHandler({ pipeline, redact: llm.redact, log, testHooks: !!opts.testHooks, bodyTimeoutMs });
  const server = http.createServer(
    // проверка node идёт раз в connectionsCheckingInterval (30 с): короткие сроки (тесты) — чаще
    opts.connectionsCheckingIntervalMs ? { connectionsCheckingInterval: opts.connectionsCheckingIntervalMs } : {},
    handler,
  );
  server.keepAliveTimeout = 5000;
  applyServerTimeouts(server, { headersTimeoutMs: opts.headersTimeoutMs, requestTimeoutMs: opts.requestTimeoutMs });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const where = llm.describe();
  log.info(`[orchestrator] слушаю http://${host}:${actualPort} · движок ${ENGINE_VERSION} · документы ${doc.base}`
    + ` · модель ${where.base ? `${where.kind} ${where.base}${where.model ? ' ' + where.model : ''}` : 'не подключена'}`
    + ` · воркеров ${dslv.size} · экземпляр ${instance}`);

  let closing = null;
  const close = (graceMs = SHUTDOWN_GRACE_MS) => {
    if (closing) return closing;
    closing = (async () => {
      server.close();
      await pipeline.close(graceMs);
      handler.closeStreams();
      await dslv.close();
      // трассы — не дольше SHUTDOWN_FLUSH_MS: недошедшая трасса не держит останов
      await Promise.race([traces.flush(), new Promise((r) => setTimeout(r, SHUTDOWN_FLUSH_MS).unref())]);
      server.closeAllConnections && server.closeAllConnections();
    })();
    return closing;
  };

  return {
    port: actualPort,
    server,
    close,
    pipeline,
    traces,
    dslr,
    dslts,
    dslv,
    llm,
    instance,
    startedAt,
    url: `http://127.0.0.1:${actualPort}`,
  };
}

/* — запуск как процесс — */

/**
 * Этот файл ли запущен (`node server/orchestrator/index.js`, в Docker — так же, без npm)?
 * Сравнение по настоящим путям: argv[1] Node не разворачивает через символические ссылки,
 * а import.meta.url — разворачивает; запуск через ссылку (или каталогом
 * `node server/orchestrator`) иначе молча ничего бы не поднял и вышел с кодом 0.
 */
function launchedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const self = real(fileURLToPath(import.meta.url));
  const given = real(arg);
  if (given === self) return true;
  try { if (fs.statSync(given).isDirectory()) return real(path.join(given, 'index.js')) === self; } catch { /* нет такого */ }
  return false;
}

if (launchedDirectly()) {
  // обработчики — сразу, ещё до старта: SIGTERM во время запуска (docker stop сразу после
  // up) иначе убивал бы процесс сигналом, без закрытия воркеров и трасс
  let stopping = false;
  let svcRef = null;
  const started = start().then((svc) => { svcRef = svc; return svc; }, (e) => {
    console.error('[orchestrator] не стартовал:', e && e.message ? e.message.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@') : e);
    process.exit(1);
  });
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.info(`[orchestrator] ${sig}: останавливаюсь`);
    // круг 25: Docker шлёт SIGKILL через 10 с — весь останов обязан уложиться в 8
    setTimeout(() => {
      console.warn(`[orchestrator] останов не уложился в ${SHUTDOWN_HARD_MS} мс — выхожу`);
      process.exit(1);
    }, SHUTDOWN_HARD_MS).unref();
    started
      .then((svc) => (svc ? svc.close().then(() => svc) : null))
      .then(() => process.exit(0), (e) => {
        const msg = String(e && e.message ? e.message : e);
        console.warn('[orchestrator] останов с ошибкой:', svcRef ? svcRef.llm.redact(msg) : msg.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@'));
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
