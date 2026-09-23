/**
 * Сброс документа к снимку генератора (SPEC §2.3, тестовый хук /api/test/reset).
 * Быстрый путь: UPDATE shapes FROM shapes_baseline только для изменившихся строк,
 * revision := 0, журнал операций документа очищается. Одна транзакция.
 * Та же логика продублирована в packages/generator (команда `reset`) — генератор не зависит от сервера.
 */
import { beginReadWrite, type Sql } from './sql.js';

export interface ResetResult {
  documentId: string;
  shapesRestored: number;
  operationsDeleted: number;
  revision: number;
  ms: number;
}

export async function resetDocument(sql: Sql, docId: string): Promise<ResetResult | null> {
  const t0 = performance.now();
  return beginReadWrite(sql, async (tx) => {
    const doc = await tx<{ id: string }[]>`SELECT id FROM documents WHERE id = ${docId} FOR UPDATE`;
    if (doc.length === 0) return null;
    const restored = await tx`
      UPDATE shapes s
      SET fill = b.fill, fill_overridden = b.fill_overridden
      FROM shapes_baseline b
      WHERE b.shape_id = s.id
        AND b.document_id = ${docId}
        AND (s.fill IS DISTINCT FROM b.fill OR s.fill_overridden IS DISTINCT FROM b.fill_overridden)
    `;
    await tx`UPDATE documents SET revision = 0 WHERE id = ${docId}`;
    const deleted = await tx`DELETE FROM operations WHERE document_id = ${docId}`;
    return {
      documentId: docId,
      shapesRestored: restored.count,
      operationsDeleted: deleted.count,
      revision: 0,
      ms: Math.round(performance.now() - t0),
    };
  });
}
