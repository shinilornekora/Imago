/**
 * Точка входа API стенда. Env: STAND_DB_URL, STAND_PORT, STAND_HOST, STAND_JWT_SECRET,
 * STAND_TEST_HOOKS, STAND_LOG_LEVEL, STAND_CLIENT_DIST (см. README.md).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

export { buildApp, type BuildAppOptions, type StandApp } from './app.js';
export { loadConfig, type ServerConfig } from './config.js';
export * from './domain/index.js';
export { createSql, beginReadWrite, beginRepeatableRead, type Sql, type TransactionSql } from './db/sql.js';
export { resetDocument } from './db/reset.js';
export { migrate } from './db/migrate.js';
export { registerZeroRoutes } from './zero/index.js';

async function main(): Promise<void> {
  const stand = await buildApp();
  const { app, config } = stand;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await stand.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, host: config.host, testHooks: config.testHooks, node: process.version },
    'stand api started',
  );
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (isMain) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
