/**
 * Публичный вход предметного модуля (SPEC §2.3, §1.6).
 * Используется HTTP-маршрутом команд и Zero push-обработчиком (`src/zero/`).
 */
export { executeCommand, paramsHash } from './executeCommand.js';
export { PgDomainTx, type SqlTag } from './pgTx.js';
export {
  DomainError,
  DOMAIN_ERROR_STATUS,
  type CommandOutcome,
  type CommandRequest,
  type CommandResult,
  type DocumentRevision,
  type DomainErrorCode,
  type DomainTx,
  type ShapeOwner,
  type SourceUpdateResult,
  type StoredOperation,
} from './types.js';
