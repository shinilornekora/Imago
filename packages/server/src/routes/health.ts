/** GET /api/health — без аутентификации; проверяет доступность БД. */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db/sql.js';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  uptimeSec: number;
  testHooks: boolean;
  /** уровень логов pino (STAND_LOG_LEVEL): в сериях измерений ожидается 'warn' — лог каждого запроса входит в server_api_cpu_ms */
  logLevel: string;
  now: string;
}

export function registerHealthRoutes(app: FastifyInstance, sql: Sql, testHooks: boolean, logLevel: string = 'info'): void {
  const startedAt = Date.now();
  app.get<{ Reply: HealthResponse }>('/api/health', async (_request, reply) => {
    let db: 'ok' | 'error' = 'ok';
    try {
      await sql`SELECT 1`;
    } catch (err) {
      _request.log.warn({ err }, 'health: db check failed');
      db = 'error';
    }
    const body: HealthResponse = {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      testHooks,
      logLevel,
      now: new Date().toISOString(),
    };
    return reply.status(db === 'ok' ? 200 : 503).send(body);
  });
}
