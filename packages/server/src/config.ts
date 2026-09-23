/**
 * Конфигурация сервера из переменных среды (SPEC §2.1: секрет — только из среды).
 *
 * Безопасность (§1.6: «служебные порты базы закрыты от браузера, административные
 * интерфейсы zero-cache доступны только внутри контура»):
 *
 * * `STAND_HOST` по умолчанию **`127.0.0.1`**, а не `0.0.0.0`. API обслуживает
 *   только локальный контур: браузер ходит через шейпер (песочница) или Caddy
 *   (Compose), оба — на той же машине. Открытая привязка вместе с
 *   `STAND_TEST_HOOKS=1` означала бы, что любой, кто видит порт 3000, может
 *   сбросить чужой документ (`POST /api/test/reset`) без токена.
 * * В Compose контейнер API не публикует порт наружу (`expose`, не `ports`), но
 *   внутри сети Compose должен слушать все интерфейсы — там `STAND_HOST`
 *   задаётся явно (`infra/docker-compose.yml`).
 * * Секрет подписи берётся только из среды и в клиентскую сборку не попадает
 *   (проверено: `grep -r STAND_JWT_SECRET packages/client/dist` — нет вхождений).
 *   Токен живёт 15 минут (`@stand/shared` → `TOKEN_TTL_SECONDS`), хранится
 *   только в памяти клиента и при выходе удаляется вместе с хранилищем
 *   приложения; продления/refresh нет — сценарий короче времени жизни токена.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  dbUrl: string;
  port: number;
  host: string;
  jwtSecret: string;
  jwtSecretIsDefault: boolean;
  testHooks: boolean;
  /**
   * Общий секрет заголовка `x-stand-test-secret` для `/api/test/*`.
   * Пусто — хуки не требуют секрета (прежнее поведение, только для локального
   * контура). Непусто — обработчики хуков обязаны сверять заголовок.
   */
  testHooksSecret: string;
  logLevel: string;
  /** Каталог production-сборки клиента (SPA); если не существует — статика не отдаётся. */
  clientDist: string;
  /** Размер пула соединений postgres.js. */
  dbPoolSize: number;
}

export const DEFAULT_DB_URL = 'postgres://postgres:postgres@127.0.0.1:5432/editor';
export const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_JWT_SECRET = 'stand-dev-secret-do-not-use-in-prod';

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be an integer, got "${raw}"`);
  return n;
}

function envBool(name: string, def = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/config.ts → packages/server ; dist/config.js → packages/server
  const packageRoot = path.resolve(here, '..');
  const defaultClientDist = path.resolve(packageRoot, '..', 'client', 'dist');
  const secret = env.STAND_JWT_SECRET && env.STAND_JWT_SECRET !== '' ? env.STAND_JWT_SECRET : DEFAULT_JWT_SECRET;
  return {
    dbUrl: env.STAND_DB_URL && env.STAND_DB_URL !== '' ? env.STAND_DB_URL : DEFAULT_DB_URL,
    port: envInt('STAND_PORT', 3000),
    host: env.STAND_HOST && env.STAND_HOST !== '' ? env.STAND_HOST : DEFAULT_HOST,
    jwtSecret: secret,
    jwtSecretIsDefault: secret === DEFAULT_JWT_SECRET,
    testHooks: envBool('STAND_TEST_HOOKS'),
    testHooksSecret: env.STAND_TEST_HOOKS_SECRET ?? '',
    logLevel: env.STAND_LOG_LEVEL && env.STAND_LOG_LEVEL !== '' ? env.STAND_LOG_LEVEL : 'info',
    clientDist: env.STAND_CLIENT_DIST && env.STAND_CLIENT_DIST !== '' ? path.resolve(env.STAND_CLIENT_DIST) : defaultClientDist,
    dbPoolSize: envInt('STAND_DB_POOL', 10),
  };
}
