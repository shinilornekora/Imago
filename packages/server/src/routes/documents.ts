/**
 * Чтение (SPEC §2.2): список документов, метаданные документа, страница (REPEATABLE READ).
 */
import type { FastifyInstance } from 'fastify';
import type { DocumentListItem, DocumentMeta, PageResponse, Shape } from '@stand/shared';
import { beginRepeatableRead, type Sql, type TransactionSql } from '../db/sql.js';
import { forbidden, notFound } from '../errors.js';

const docParamsSchema = {
  type: 'object',
  required: ['docId'],
  properties: { docId: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const pageParamsSchema = {
  type: 'object',
  required: ['docId', 'pageId'],
  properties: {
    docId: { type: 'string', minLength: 1, maxLength: 256 },
    pageId: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

/** Проверка владения документом: 404 если нет, 403 если чужой. Возвращает ревизию и имя. */
export async function requireOwnedDocument(
  sql: Sql | TransactionSql,
  docId: string,
  userId: string,
): Promise<{ id: string; name: string; revision: number }> {
  const rows = await sql<{ id: string; name: string; revision: number; ownerId: string }[]>`
    SELECT id, name, revision, owner_id AS "ownerId" FROM documents WHERE id = ${docId}
  `;
  const doc = rows[0];
  if (!doc) throw notFound(`document "${docId}" not found`);
  if (doc.ownerId !== userId) throw forbidden('document belongs to another user');
  return { id: doc.id, name: doc.name, revision: doc.revision };
}

export function registerDocumentRoutes(app: FastifyInstance, sql: Sql): void {
  app.get<{ Reply: DocumentListItem[] }>(
    '/api/documents',
    { onRequest: [app.authenticate] },
    async (request) => {
      const rows = await sql<DocumentListItem[]>`
        SELECT d.id, d.name, d.revision,
               (SELECT count(*)::int FROM pages p WHERE p.document_id = d.id)  AS "pageCount",
               (SELECT count(*)::int FROM shapes s WHERE s.document_id = d.id) AS "shapeCount"
        FROM documents d
        WHERE d.owner_id = ${request.authUser.userId}
        ORDER BY d.name, d.id
      `;
      return rows;
    },
  );

  app.get<{ Params: { docId: string }; Reply: DocumentMeta }>(
    '/api/documents/:docId',
    { onRequest: [app.authenticate], schema: { params: docParamsSchema } },
    async (request) => {
      const { docId } = request.params;
      const doc = await requireOwnedDocument(sql, docId, request.authUser.userId);
      const pages = await sql<{ id: string; index: number; name: string }[]>`
        SELECT id, "index", name FROM pages WHERE document_id = ${docId} ORDER BY "index", id
      `;
      return { id: doc.id, name: doc.name, revision: doc.revision, pages };
    },
  );

  app.get<{ Params: { docId: string; pageId: string }; Reply: PageResponse }>(
    '/api/documents/:docId/pages/:pageId',
    { onRequest: [app.authenticate], schema: { params: pageParamsSchema } },
    async (request) => {
      const { docId, pageId } = request.params;
      const userId = request.authUser.userId;
      // Ревизия и фигуры — из одного снимка REPEATABLE READ (SPEC §2.2).
      return beginRepeatableRead(sql, async (tx) => {
        const doc = await requireOwnedDocument(tx, docId, userId);
        const pageRows = await tx<{ id: string }[]>`
          SELECT id FROM pages WHERE id = ${pageId} AND document_id = ${docId}
        `;
        if (pageRows.length === 0) throw notFound(`page "${pageId}" not found in document "${docId}"`);
        const shapes = await tx<Shape[]>`
          SELECT id, document_id AS "documentId", page_id AS "pageId", kind, x, y, w, h, z, text, fill,
                 is_source AS "isSource", source_id AS "sourceId", fill_overridden AS "fillOverridden"
          FROM shapes
          WHERE page_id = ${pageId} AND document_id = ${docId}
          ORDER BY z, id
        `;
        return { documentId: docId, pageId, revision: doc.revision, shapes };
      });
    },
  );
}
