/**
 * Предметный модуль команд (SPEC §2.3, §1.6): малый интерфейс транзакции.
 * HTTP-обработчик и Zero-мутатор подключают к нему свои транзакционные контексты.
 * Эталон (packages/reference) этот модуль НЕ использует.
 */
import type { ApiError, CommandRequest, CommandResult } from '@stand/shared';

/** Ревизия и владелец документа. Реализация ОБЯЗАНА блокировать строку (FOR UPDATE) до конца транзакции. */
export interface DocumentRevision {
  ownerId: string;
  revision: number;
}

/** Принадлежность фигуры: документ, владелец документа, страница, признак источника. */
export interface ShapeOwner {
  documentId: string;
  ownerId: string;
  pageId: string;
  isSource: boolean;
  sourceId: string | null;
}

export interface SourceUpdateResult {
  /** Уникальные страницы изменённых фигур, отсортированы. */
  affectedPages: string[];
  /** Источник + непереопределённые экземпляры (считаются все подходящие, даже если цвет совпал). */
  affectedShapes: number;
}

export interface StoredOperation {
  opId: string;
  documentId: string;
  paramsHash: string;
  result: CommandResult;
}

/**
 * Малый интерфейс транзакции предметного модуля.
 * Все методы вызываются внутри ОДНОЙ транзакции хранилища; порядок вызовов задаёт executeCommand.
 */
export interface DomainTx {
  /** null — документа нет. Строка документа блокируется (сериализация команд по документу). */
  readRevision(docId: string): Promise<DocumentRevision | null>;
  /** null — фигуры нет. */
  readShapeOwner(shapeId: string): Promise<ShapeOwner | null>;
  /** setSourceFill: источник + экземпляры с source_id=sourceId и fill_overridden=false, на всех страницах. */
  updateSourceAndInstances(sourceId: string, fill: string): Promise<SourceUpdateResult>;
  /** setLocalFill: fill := fill, fill_overridden := true. */
  updateShapeFill(shapeId: string, fill: string): Promise<{ pageId: string }>;
  /** revision := revision + 1; возвращает новую ревизию. */
  bumpRevision(docId: string): Promise<number>;
  /** Запись журнала операций по opId (идемпотентность). */
  readOperation(opId: string): Promise<StoredOperation | null>;
  writeOperation(op: StoredOperation): Promise<void>;
}

export type DomainErrorCode = Exclude<ApiError['error'], 'internal'>;

export const DOMAIN_ERROR_STATUS: Record<DomainErrorCode | 'internal', number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  revision_mismatch: 409,
  op_conflict: 409,
  internal: 500,
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly statusCode: number;
  readonly currentRevision: number | undefined;

  constructor(code: DomainErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = DOMAIN_ERROR_STATUS[code];
    this.currentRevision = currentRevision;
  }

  toApiError(): ApiError {
    const e: ApiError = { error: this.code, message: this.message };
    if (this.currentRevision !== undefined) e.currentRevision = this.currentRevision;
    return e;
  }
}

export interface CommandOutcome {
  result: CommandResult;
  /** true — результат взят из журнала операций (повтор с тем же opId и параметрами), изменений не было. */
  replayed: boolean;
}

export type { CommandRequest, CommandResult };
