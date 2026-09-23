/**
 * DomainTx поверх транзакции postgres.js (`sql.begin(tx => ...)`).
 * Тип транзакции задан структурно (любая tagged-template функция), чтобы тот же класс работал и с
 * `tx.dbTransaction.wrappedTransaction` из zeroPostgresJS (в дереве может быть другая копия postgres.js).
 */
import type { CommandResult } from '@stand/shared';
import type { DocumentRevision, DomainTx, ShapeOwner, SourceUpdateResult, StoredOperation } from './types.js';

/** Минимальный контракт postgres.js `Sql`/`TransactionSql`: tagged template → thenable со строками. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlTag = (strings: TemplateStringsArray, ...params: any[]) => any;

export class PgDomainTx implements DomainTx {
  constructor(private readonly sql: SqlTag) {}

  /** Выполняет tagged-template запрос и типизирует строки результата. */
  private q<T>(strings: TemplateStringsArray, ...params: unknown[]): Promise<T[]> {
    return Promise.resolve(this.sql(strings, ...params) as PromiseLike<T[]>);
  }

  async readRevision(docId: string): Promise<DocumentRevision | null> {
    const rows = await this.q<{ ownerId: string; revision: number }>`
      SELECT owner_id AS "ownerId", revision
      FROM documents
      WHERE id = ${docId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async readShapeOwner(shapeId: string): Promise<ShapeOwner | null> {
    const rows = await this.q<ShapeOwner>`
      SELECT s.document_id AS "documentId", d.owner_id AS "ownerId", s.page_id AS "pageId",
             s.is_source AS "isSource", s.source_id AS "sourceId"
      FROM shapes s
      JOIN documents d ON d.id = s.document_id
      WHERE s.id = ${shapeId}
    `;
    return rows[0] ?? null;
  }

  async updateSourceAndInstances(sourceId: string, fill: string): Promise<SourceUpdateResult> {
    const rows = await this.q<{ pageId: string }>`
      UPDATE shapes
      SET fill = ${fill}
      WHERE (id = ${sourceId} AND is_source)
         OR (source_id = ${sourceId} AND NOT fill_overridden)
      RETURNING page_id AS "pageId"
    `;
    const pages = new Set<string>();
    for (const r of rows) pages.add(r.pageId);
    return { affectedPages: [...pages].sort(), affectedShapes: rows.length };
  }

  async updateShapeFill(shapeId: string, fill: string): Promise<{ pageId: string }> {
    const rows = await this.q<{ pageId: string }>`
      UPDATE shapes
      SET fill = ${fill}, fill_overridden = true
      WHERE id = ${shapeId}
      RETURNING page_id AS "pageId"
    `;
    const row = rows[0];
    if (!row) throw new Error(`updateShapeFill: shape "${shapeId}" vanished inside transaction`);
    return row;
  }

  async bumpRevision(docId: string): Promise<number> {
    const rows = await this.q<{ revision: number }>`
      UPDATE documents SET revision = revision + 1 WHERE id = ${docId} RETURNING revision
    `;
    const row = rows[0];
    if (!row) throw new Error(`bumpRevision: document "${docId}" vanished inside transaction`);
    return row.revision;
  }

  async readOperation(opId: string): Promise<StoredOperation | null> {
    const rows = await this.q<{ opId: string; documentId: string; paramsHash: string; result: CommandResult }>`
      SELECT op_id AS "opId", document_id AS "documentId", params_hash AS "paramsHash", result
      FROM operations
      WHERE op_id = ${opId}
    `;
    return rows[0] ?? null;
  }

  async writeOperation(op: StoredOperation): Promise<void> {
    // Объект передаётся как есть: postgres.js по типу параметра (jsonb) сериализует его сам.
    // Передавать JSON.stringify(...) нельзя — строка была бы закодирована в jsonb дважды.
    await this.q`
      INSERT INTO operations (op_id, document_id, params_hash, result, created_at)
      VALUES (${op.opId}, ${op.documentId}, ${op.paramsHash}, ${op.result}::jsonb, now())
    `;
  }
}
