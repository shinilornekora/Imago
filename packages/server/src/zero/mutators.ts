/**
 * Серверная реализация мутаторов Zero (SPEC §2.4): та же предметная логика, что и у HTTP-команды.
 *
 * `tx.dbTransaction.wrappedTransaction` из `zeroPostgresJS` — транзакция postgres.js (`sql.begin`),
 * в которой PushProcessor уже записал `lastMutationID` клиента. Поверх неё строится `PgDomainTx`
 * (структурная типизация SqlTag), и `executeCommand` делает всё то же, что и `POST /api/documents/:docId/commands`:
 * права → идемпотентность по opId → expectedRevision → изменение → revision+1 → запись в `operations`.
 * Ошибка предметного модуля превращается в `ApplicationError` с `details:{code,status,currentRevision?}` —
 * откат транзакции, клиент получает `.server → {type:'error', error:{type:'app', message, details}}`.
 */
import { ApplicationError } from '@rocicorp/zero/server';
import { DomainError, executeCommand, PgDomainTx, type SqlTag } from '../domain/index.js';
import { type FillArgs, type FillCommandType, makeMutators, type ServerFillImpl, type ZeroCtx } from './schema.js';

/** Форма `details` в ApplicationError (клиент Z отображает её в те же коды ошибок, что у HTTP). */
export type ZeroAppErrorDetails = {
  code: DomainError['code'];
  status: number;
  message: string;
  currentRevision?: number;
};

export function domainErrorToApplicationError(err: DomainError): ApplicationError<ZeroAppErrorDetails> {
  const details: ZeroAppErrorDetails = { code: err.code, status: err.statusCode, message: err.message };
  if (err.currentRevision !== undefined) details.currentRevision = err.currentRevision;
  return new ApplicationError(err.code, { details, cause: err });
}

export const serverFillImpl: ServerFillImpl = async (type: FillCommandType, tx, args: FillArgs, ctx: ZeroCtx) => {
  if (tx.location !== 'server') throw new Error('serverFillImpl called outside of a server transaction');
  const pg = tx.dbTransaction.wrappedTransaction as SqlTag;
  const domainTx = new PgDomainTx(pg);
  try {
    await executeCommand(domainTx, ctx.userID, args.documentId, {
      opId: args.opId,
      type,
      targetId: args.targetId,
      fill: args.fill,
      expectedRevision: args.expectedRevision,
    });
  } catch (err) {
    if (err instanceof DomainError) throw domainErrorToApplicationError(err);
    throw err;
  }
};

/** Реестр мутаторов с серверной реализацией (для PushProcessor). */
export const serverMutators = makeMutators(serverFillImpl);
