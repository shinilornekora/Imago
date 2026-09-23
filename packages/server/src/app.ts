/**
 * Сборка Fastify-приложения. Отдельно от запуска — чтобы тесты поднимали приложение in-process.
 */
import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { OPERATION_TTL_HOURS } from '@stand/shared';
import { registerJwt } from './auth/jwt.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createSql, type Sql } from './db/sql.js';
import { registerErrorHandling } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatic } from './routes/static.js';
import { registerTestRoutes } from './routes/test.js';
import { registerZeroRoutes } from './zero/index.js';

export interface BuildAppOptions {
  config?: Partial<ServerConfig>;
  /** Готовое соединение (тесты); иначе создаётся по config.dbUrl. */
  sql?: Sql;
  /** Периодическая очистка operations старше 24 ч (по умолчанию включена). */
  operationsCleanup?: boolean;
}

export interface StandApp {
  app: FastifyInstance;
  sql: Sql;
  config: ServerConfig;
  close(): Promise<void>;
}

/**
 * `Cache-Control: no-store` на КАЖДЫЙ ответ API (`/api/**`, включая `/api/zero/*` и ошибки).
 *
 * Зачем (критик A, дефект A14 / методика §1.2, §1.8): измеряется стоимость чтения страницы по сети.
 * Сегодня ответы чтения не несут ни `ETag`, ни `Last-Modified`, ни `Expires`, поэтому браузер
 * переиспользовать их не может и каждое чтение — реальный сетевой запрос (проверено по 180 прогонам
 * `results/archive/old-semantics-partial/main`: число запросов, посчитанных клиентом, совпадает с
 * числом запросов, увиденных шейпером, во всех 180 прогонах). Но это свойство держится на ОТСУТСТВИИ
 * валидаторов: любой будущий `ETag`/`Last-Modified` (или обратный прокси, который их добавит) молча
 * превратил бы повторное чтение вытесненной страницы в попадание в HTTP-кеш — нулевые байты и нулевая
 * задержка у H и Q и мнимое преимущество HTTP-адаптеров над Z. `no-store` делает запрет явным.
 *
 * Заголовок ставится в `onRequest`, то есть ДО обработчика: он попадает и в успешные ответы, и в 401
 * от `authenticate`, и в ответы обработчика ошибок, и в 404 `setNotFoundHandler`. Статика клиента
 * (`/`, `/assets/*`) не затрагивается — у неё своя политика в `routes/static.ts`.
 */
export function registerNoStore(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url ?? request.url;
    if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) {
      reply.header('cache-control', 'no-store');
    }
  });
}

/** Привязка только к петле: 127.0.0.0/8, ::1, localhost. Всё остальное считается открытым контуром. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<StandApp> {
  const config: ServerConfig = { ...loadConfig(), ...opts.config };
  const sql = opts.sql ?? createSql(config.dbUrl, { max: config.dbPoolSize });
  const ownsSql = !opts.sql;

  const app = Fastify({
    logger: { level: config.logLevel },
    // Отключаем автогенерацию request-id заголовков не нужно; оставляем стандарт Fastify.
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  if (config.jwtSecretIsDefault) {
    app.log.warn('STAND_JWT_SECRET is not set — using built-in development secret');
  }

  await app.register(fastifyCors, { origin: true, credentials: false });
  await registerJwt(app, config.jwtSecret);
  registerErrorHandling(app);
  registerNoStore(app);

  registerHealthRoutes(app, sql, config.testHooks, config.logLevel);
  registerAuthRoutes(app, sql);
  registerDocumentRoutes(app, sql);
  registerCommandRoutes(app, sql);
  registerZeroRoutes(app, { sql });
  if (config.testHooks) {
    // §1.6: открытые тестовые хуки на НЕлокальной привязке — это сброс чужого документа без токена.
    // Пустой секрет допустим только на петле (песочница: scripts/lib.sh секрет всё равно создаёт);
    // при любой другой привязке (в том числе 0.0.0.0 контура Compose) сервер не поднимается.
    if (!config.testHooksSecret && !isLoopbackHost(config.host)) {
      throw new Error(
        `STAND_TEST_HOOKS=1 with STAND_HOST=${config.host} requires a non-empty STAND_TEST_HOOKS_SECRET ` +
          '(otherwise POST /api/test/reset is open to everyone who can reach the port). ' +
          'Set STAND_TEST_HOOKS=0 or generate a secret: openssl rand -hex 24',
      );
    }
    registerTestRoutes(app, sql, config.testHooksSecret);
    app.log.warn(
      config.testHooksSecret
        ? 'test hooks enabled under /api/test/* (STAND_TEST_HOOKS=1), header x-stand-test-secret required'
        : 'test hooks enabled under /api/test/* (STAND_TEST_HOOKS=1) WITHOUT a shared secret — loopback binding only',
    );
  }

  const staticOk = await registerStatic(app, config.clientDist);
  app.log.info({ clientDist: config.clientDist, enabled: staticOk }, 'static client serving');

  // Очистка журнала операций: записи живут 24 ч (SPEC §2.3).
  let cleanupTimer: NodeJS.Timeout | null = null;
  if (opts.operationsCleanup !== false) {
    const run = async () => {
      try {
        const r = await sql`DELETE FROM operations WHERE created_at < now() - make_interval(hours => ${OPERATION_TTL_HOURS})`;
        if (r.count > 0) app.log.info({ deleted: r.count }, 'operations cleanup');
      } catch (err) {
        app.log.warn({ err }, 'operations cleanup failed');
      }
    };
    cleanupTimer = setInterval(run, 10 * 60 * 1000);
    cleanupTimer.unref();
    app.addHook('onReady', run);
  }

  const close = async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await app.close();
    if (ownsSql) await sql.end({ timeout: 5 });
  };

  return { app, sql, config, close };
}
