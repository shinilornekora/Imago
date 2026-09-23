/**
 * POST /api/documents/:docId/commands (SPEC §2.3) — всё в одной транзакции через предметный модуль.
 * GET  /api/operations/:opId — статус операции после неопределённого сетевого ответа.
 */
import type { FastifyInstance } from 'fastify';
import type { CommandRequest, CommandResult, OperationStatus } from '@stand/shared';
import { beginReadWrite, type Sql } from '../db/sql.js';
import { executeCommand, PgDomainTx } from '../domain/index.js';
import { forbidden, notFound } from '../errors.js';

const commandBodySchema = {
  type: 'object',
  required: ['opId', 'type', 'targetId', 'fill', 'expectedRevision'],
  additionalProperties: false,
  properties: {
    // SPEC: uuid; принимаем любой безопасный идентификатор (UUID проходит), чтобы не ломать тестовые вызовы.
    opId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    type: { type: 'string', enum: ['setSourceFill', 'setLocalFill'] },
    targetId: { type: 'string', minLength: 1, maxLength: 256 },
    fill: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
    expectedRevision: { type: 'integer', minimum: 0 },
  },
} as const;

const docParamsSchema = {
  type: 'object',
  required: ['docId'],
  properties: { docId: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const opParamsSchema = {
  type: 'object',
  required: ['opId'],
  properties: { opId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

export function registerCommandRoutes(app: FastifyInstance, sql: Sql): void {
  app.post<{ Params: { docId: string }; Body: CommandRequest; Reply: CommandResult }>(
    '/api/documents/:docId/commands',
    { onRequest: [app.authenticate], schema: { params: docParamsSchema, body: commandBodySchema } },
    async (request, reply) => {
      const { docId } = request.params;
      const userId = request.authUser.userId;
      const outcome = await beginReadWrite(sql, (tx) => executeCommand(new PgDomainTx(tx), userId, docId, request.body));
      if (outcome.replayed) {
        request.log.info({ opId: request.body.opId, docId }, 'command replayed from operations log');
        reply.header('x-stand-replayed', '1');
      }
      return outcome.result;
    },
  );

  app.get<{ Params: { opId: string }; Reply: OperationStatus }>(
    '/api/operations/:opId',
    { onRequest: [app.authenticate], schema: { params: opParamsSchema } },
    async (request) => {
      const { opId } = request.params;
      const rows = await sql<{ opId: string; result: CommandResult; ownerId: string | null }[]>`
        SELECT o.op_id AS "opId", o.result, d.owner_id AS "ownerId"
        FROM operations o
        LEFT JOIN documents d ON d.id = o.document_id
        WHERE o.op_id = ${opId}
      `;
      const op = rows[0];
      if (!op) throw notFound(`operation "${opId}" not found`);
      if (op.ownerId !== request.authUser.userId) throw forbidden('operation belongs to another user');
      return { opId: op.opId, status: 'done', result: op.result };
    },
  );
}
