/**
 * Zero (SPEC §2.4): push-endpoint и query-endpoint в том же Fastify.
 *
 *   POST /api/zero/mutate  ← ZERO_MUTATE_URL (zero-cache; ?schema=<app>_0&appID=<app>) — custom mutators
 *   POST /api/zero/push    ← то же самое (имя из SPEC §2.4 / compose; deprecated-алиас ZERO_PUSH_URL)
 *   POST /api/zero/query   ← ZERO_QUERY_URL — synced queries: {name,args} → AST с ctx.userID из JWT
 *
 * Токен клиента (`new Zero({auth})`) приходит от zero-cache в `Authorization: Bearer` и проверяется
 * тем же секретом, что и HTTP-маршруты (`app.verifyToken`). Пользователь определяется ТОЛЬКО по JWT (`sub`);
 * 401 при отсутствии/невалидности токена → zero-cache переводит клиента в `needs-auth`.
 *
 * Мутации выполняет `PushProcessor` над `zeroPostgresJS(schema, sql)` — тем же пулом postgres.js, что и
 * HTTP-маршруты: каждая мутация — `sql.begin(...)`, внутри — учёт lastMutationID клиента (`<app>_0.clients`),
 * серверный мутатор (`executeCommand` над `PgDomainTx`), коммит; ошибка → откат и запись результата-ошибки.
 *
 * Дополнительно `/zero/*` (HTTP + WebSocket) проксируется на zero-cache (`STAND_ZERO_UPSTREAM`, по умолчанию
 * http://127.0.0.1:4848; пустая строка — выключить), чтобы клиент Z работал с origin самого API (функциональные
 * проверки без шейпера). Измеряемый путь — шейпер/Caddy, где `/zero` идёт на zero-cache напрямую.
 */
import fastifyHttpProxy from '@fastify/http-proxy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZERO_PATH } from '@stand/shared';
import { mustGetQuery } from '@rocicorp/zero';
import { ApplicationError, handleQueryRequest, PushProcessor } from '@rocicorp/zero/server';
import { zeroPostgresJS } from '@rocicorp/zero/server/adapters/postgresjs';
import type { Sql } from '../db/sql.js';
import { sendApiError } from '../errors.js';
import { serverMutators, type ZeroAppErrorDetails } from './mutators.js';
import { DOCUMENT_SCOPED_QUERIES, queries, schema, type ZeroCtx } from './schema.js';

export interface ZeroRoutesOptions {
  sql: Sql;
  /** Уровень логирования PushProcessor/handleQueryRequest (по умолчанию 'warn'). */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Адрес zero-cache для прокси `/zero/*` (по умолчанию env STAND_ZERO_UPSTREAM или http://127.0.0.1:4848; '' — без прокси). */
  zeroUpstream?: string;
}

export const DEFAULT_ZERO_UPSTREAM = 'http://127.0.0.1:4848';

export const ZERO_MUTATE_PATH = '/api/zero/mutate';
export const ZERO_PUSH_PATH = '/api/zero/push';
export const ZERO_QUERY_PATH = '/api/zero/query';

function bearer(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] as string) : null;
}

/** Контекст из JWT или null (→ 401). */
function authContext(app: FastifyInstance, request: FastifyRequest): ZeroCtx | null {
  const token = bearer(request);
  if (!token) return null;
  try {
    const user = app.verifyToken(token);
    return user.userId ? { userID: user.userId } : null;
  } catch {
    return null;
  }
}

type JsonObject = Record<string, unknown>;

/**
 * Права чтения (SPEC §2.1, §2.4): документ из аргументов запроса обязан принадлежать пользователю из JWT.
 * Проверяется при трансформации запроса (один раз на запрос/клиент-группу); чужой или несуществующий
 * документ → ошибка запроса `forbidden`/`not_found` (клиентский view получает resultType 'error', строк нет).
 */
export async function assertOwnedDocument(sql: Sql, ctx: ZeroCtx, args: unknown): Promise<void> {
  const documentId =
    typeof args === 'object' && args !== null && typeof (args as { documentId?: unknown }).documentId === 'string'
      ? (args as { documentId: string }).documentId
      : null;
  const deny = (code: ZeroAppErrorDetails['code'], status: number, message: string) =>
    new ApplicationError(code, { details: { code, status, message } satisfies ZeroAppErrorDetails });
  if (!documentId) throw deny('bad_request', 400, 'documentId is required');
  const rows = await sql<{ ownerId: string }[]>`SELECT owner_id AS "ownerId" FROM documents WHERE id = ${documentId}`;
  const doc = rows[0];
  if (!doc) throw deny('not_found', 404, `document "${documentId}" not found`);
  if (doc.ownerId !== ctx.userID) throw deny('forbidden', 403, 'document belongs to another user');
}

export function registerZeroRoutes(app: FastifyInstance, opts: ZeroRoutesOptions): void {
  const logLevel = opts.logLevel ?? 'warn';
  // Один ZQLDatabase на приложение (кэширует serverSchema после первой транзакции).
  // Тип postgres.Sql структурно совместим между копиями postgres 3.4.x (server 3.4.9 / зависимость zero 3.4.7).
  const db = zeroPostgresJS(schema, opts.sql as unknown as Parameters<typeof zeroPostgresJS>[1]);

  const unauthorized = (reply: FastifyReply) =>
    sendApiError(reply, 401, { error: 'unauthorized', message: 'missing or invalid bearer token' });

  const mutate = async (request: FastifyRequest<{ Querystring: Record<string, string>; Body: JsonObject }>, reply: FastifyReply) => {
    const ctx = authContext(app, request);
    if (!ctx) return unauthorized(reply);
    const t0 = performance.now();
    // PushProcessor на запрос: ctx (userID) — per-user; dbProvider общий.
    const processor = new PushProcessor(db, ctx, logLevel);
    const result = await processor.process(serverMutators, request.query, request.body as never);
    const mutations = Array.isArray((request.body as { mutations?: unknown[] })?.mutations)
      ? (request.body as { mutations: unknown[] }).mutations.length
      : 0;
    request.log.info({ ms: Math.round(performance.now() - t0), mutations, user: ctx.userID }, 'zero push processed');
    // zero-cache сверяет userID ответа с userID соединения (PushProcessor сам его не добавляет).
    return { ...result, userID: ctx.userID };
  };

  app.post(ZERO_MUTATE_PATH, mutate);
  app.post(ZERO_PUSH_PATH, mutate);

  app.post(
    ZERO_QUERY_PATH,
    async (request: FastifyRequest<{ Querystring: Record<string, string>; Body: JsonObject }>, reply: FastifyReply) => {
      const ctx = authContext(app, request);
      if (!ctx) return unauthorized(reply);
      return handleQueryRequest({
        schema,
        userID: ctx.userID,
        query: request.query,
        body: request.body as never,
        logLevel,
        // Имя + аргументы от zero-cache → Query с ctx из JWT; клиент повлиять на ctx не может.
        // (handleQueryRequest ждёт промис обработчика, хотя тип объявлен синхронным.)
        handler: ((name: string, args: unknown) => {
          const q = mustGetQuery(queries, name);
          const build = () => q.fn({ args: args as never, ctx });
          return DOCUMENT_SCOPED_QUERIES.has(name) ? assertOwnedDocument(opts.sql, ctx, args).then(build) : build();
        }) as never,
      });
    },
  );

  // Прокси /zero/* → zero-cache (HTTP и WebSocket); префикс сохраняется (zero-cache принимает один сегмент base).
  const upstream = opts.zeroUpstream ?? process.env.STAND_ZERO_UPSTREAM ?? DEFAULT_ZERO_UPSTREAM;
  if (upstream) {
    void app.register(fastifyHttpProxy, {
      upstream,
      prefix: ZERO_PATH,
      rewritePrefix: ZERO_PATH,
      websocket: true,
      wsServerOptions: { perMessageDeflate: false },
    });
  }

  app.log.info(
    { mutate: [ZERO_MUTATE_PATH, ZERO_PUSH_PATH], query: ZERO_QUERY_PATH, zeroProxy: upstream || null },
    'zero routes registered',
  );
}

export { schema, queries, mutators, makeMutators, zql } from './schema.js';
export type { ZeroSchema, ZeroCtx, FillArgs, FillCommandType, ShapeRow, DocumentRow } from './schema.js';
export { serverMutators, serverFillImpl, domainErrorToApplicationError, type ZeroAppErrorDetails } from './mutators.js';
export { executeCommand, PgDomainTx, DomainError } from '../domain/index.js';
export { beginReadWrite, createSql } from '../db/sql.js';
