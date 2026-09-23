/**
 * Загрузка документа в PostgreSQL и сброс к снимку (SPEC §5).
 * Генератор не зависит от пакета сервера: SQL сброса продублирован (см. server/src/db/reset.ts).
 */
import postgres from 'postgres';
import type { Shape } from '@stand/shared';
import type { DocumentFile } from './generate.js';

export const DEFAULT_DB_URL = 'postgres://postgres:postgres@127.0.0.1:5432/editor';

export type Sql = postgres.Sql<{}>;

export function createSql(url: string = process.env.STAND_DB_URL || DEFAULT_DB_URL): Sql {
  return postgres(url, { max: 2, prepare: false, connection: { application_name: 'stand-generator' }, onnotice: () => {} });
}

const CHUNK = 2000;

interface ShapeRow {
  id: string;
  document_id: string;
  page_id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  text: string | null;
  fill: string;
  is_source: boolean;
  source_id: string | null;
  fill_overridden: boolean;
}

function toRow(s: Shape): ShapeRow {
  return {
    id: s.id,
    document_id: s.documentId,
    page_id: s.pageId,
    kind: s.kind,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    z: s.z,
    text: s.text,
    fill: s.fill,
    is_source: s.isSource,
    source_id: s.sourceId,
    fill_overridden: s.fillOverridden,
  };
}

export interface LoadResult {
  documentId: string;
  pages: number;
  shapes: number;
  ms: number;
}

/** Полная перезагрузка документа: удаление старого (CASCADE), вставка, снимок shapes_baseline. */
export async function loadDocument(sql: Sql, doc: DocumentFile): Promise<LoadResult> {
  const t0 = performance.now();
  const docId = doc.document.id;
  const owner = await sql`SELECT id FROM users WHERE id = ${doc.document.ownerId}`;
  if (owner.length === 0) {
    throw new Error(`owner "${doc.document.ownerId}" is not in users — run the server migration first (scripts/migrate.sh)`);
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM shapes_baseline WHERE document_id = ${docId}`;
    await tx`DELETE FROM operations WHERE document_id = ${docId}`;
    await tx`DELETE FROM documents WHERE id = ${docId}`; // CASCADE: pages, shapes
    await tx`
      INSERT INTO documents (id, owner_id, name, revision)
      VALUES (${docId}, ${doc.document.ownerId}, ${doc.document.name}, ${doc.document.revision})
    `;
    const pageRows = doc.pages.map((p) => ({ id: p.id, document_id: p.documentId, index: p.index, name: p.name }));
    for (let i = 0; i < pageRows.length; i += CHUNK) {
      await tx`INSERT INTO pages ${tx(pageRows.slice(i, i + CHUNK), 'id', 'document_id', 'index', 'name')}`;
    }
    const rows = doc.shapes.map(toRow);
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx`INSERT INTO shapes ${tx(
        rows.slice(i, i + CHUNK),
        'id', 'document_id', 'page_id', 'kind', 'x', 'y', 'w', 'h', 'z', 'text', 'fill', 'is_source', 'source_id', 'fill_overridden',
      )}`;
    }
    await tx`
      INSERT INTO shapes_baseline (shape_id, document_id, fill, fill_overridden)
      SELECT id, document_id, fill, fill_overridden FROM shapes WHERE document_id = ${docId}
    `;
  });
  await sql`ANALYZE shapes`;
  await sql`ANALYZE shapes_baseline`;
  await sql`ANALYZE pages`;
  return { documentId: docId, pages: doc.pages.length, shapes: doc.shapes.length, ms: Math.round(performance.now() - t0) };
}

export interface ResetResult {
  documentId: string;
  shapesRestored: number;
  operationsDeleted: number;
  revision: number;
  ms: number;
}

/** Сброс: то же, что POST /api/test/reset. */
export async function resetDocument(sql: Sql, docId: string): Promise<ResetResult | null> {
  const t0 = performance.now();
  return sql.begin(async (tx) => {
    const doc = await tx`SELECT id FROM documents WHERE id = ${docId} FOR UPDATE`;
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
  }) as Promise<ResetResult | null>;
}

export interface DbCounts {
  documentId: string;
  revision: number;
  pages: number;
  shapes: number;
  baseline: number;
}

export async function countDocument(sql: Sql, docId: string): Promise<DbCounts | null> {
  const rows = await sql<{ revision: number; pages: number; shapes: number; baseline: number }[]>`
    SELECT d.revision,
           (SELECT count(*)::int FROM pages p WHERE p.document_id = d.id) AS pages,
           (SELECT count(*)::int FROM shapes s WHERE s.document_id = d.id) AS shapes,
           (SELECT count(*)::int FROM shapes_baseline b WHERE b.document_id = d.id) AS baseline
    FROM documents d WHERE d.id = ${docId}
  `;
  const r = rows[0];
  return r ? { documentId: docId, ...r } : null;
}
