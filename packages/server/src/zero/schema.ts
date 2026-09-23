/**
 * Zero-схема стенда (SPEC §2.4): таблицы `documents`, `pages`, `shapes` (snake_case в БД → camelCase),
 * синхронизируемые запросы (synced queries, права по `ctx.userID` из JWT) и мутаторы
 * `setSourceFill` / `setLocalFill`.
 *
 * ЕДИНЫЙ модуль для сервера и клиента: сервер импортирует его как `./schema.js`, клиент
 * (packages/client/src/adapters/z.ts) — по относительному пути к исходнику. Поэтому здесь нет
 * ничего, кроме `@rocicorp/zero`: ни Node-, ни DOM-зависимостей. Серверная реализация мутаторов
 * инжектируется через `makeMutators(serverImpl)` (см. ./mutators.ts), клиентская часть —
 * оптимистичная перекраска ЛОКАЛЬНЫХ строк (SPEC §1.6: завершение команды по ней не считается).
 *
 * Таблица `operations` в схему НЕ входит (серверная, SPEC §2.3).
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  boolean,
  createBuilder,
  createSchema,
  defineMutatorsWithType,
  defineMutatorWithType,
  defineQueriesWithType,
  defineQueryWithType,
  number,
  relationships,
  string,
  table,
  type Transaction,
} from '@rocicorp/zero';

// ---------------------------------------------------------------- таблицы

const documents = table('documents')
  .columns({
    id: string(),
    ownerId: string().from('owner_id'),
    name: string(),
    revision: number(),
  })
  .primaryKey('id');

const pages = table('pages')
  .columns({
    id: string(),
    documentId: string().from('document_id'),
    index: number(),
    name: string(),
  })
  .primaryKey('id');

const shapes = table('shapes')
  .columns({
    id: string(),
    documentId: string().from('document_id'),
    pageId: string().from('page_id'),
    kind: string(),
    x: number(),
    y: number(),
    w: number(),
    h: number(),
    z: number(),
    text: string().optional(),
    fill: string(),
    isSource: boolean().from('is_source'),
    sourceId: string().from('source_id').optional(),
    fillOverridden: boolean().from('fill_overridden'),
  })
  .primaryKey('id');

const documentsRelationships = relationships(documents, ({ many }) => ({
  pages: many({ sourceField: ['id'], destField: ['documentId'], destSchema: pages }),
  shapes: many({ sourceField: ['id'], destField: ['documentId'], destSchema: shapes }),
}));

const pagesRelationships = relationships(pages, ({ many, one }) => ({
  shapes: many({ sourceField: ['id'], destField: ['pageId'], destSchema: shapes }),
  document: one({ sourceField: ['documentId'], destField: ['id'], destSchema: documents }),
}));

const shapesRelationships = relationships(shapes, ({ one }) => ({
  page: one({ sourceField: ['pageId'], destField: ['id'], destSchema: pages }),
  document: one({ sourceField: ['documentId'], destField: ['id'], destSchema: documents }),
}));

export const schema = createSchema({
  tables: [documents, pages, shapes],
  relationships: [documentsRelationships, pagesRelationships, shapesRelationships],
  // Legacy ad-hoc запросы (zero.query.*) и CRUD-мутаторы выключены (по умолчанию в 1.9): только
  // synced queries + custom mutators, права проверяет сервер.
});

export type ZeroSchema = typeof schema;
export const zql = createBuilder(schema);

/** Контекст запросов/мутаторов: на сервере — из проверенного JWT (`sub`), на клиенте — `context` конструктора Zero. */
export interface ZeroCtx {
  userID: string;
}

/** Строка `shapes` в клиентских именах (то, что отдаёт materialize / inspector). */
export interface ShapeRow {
  id: string;
  documentId: string;
  pageId: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  text: string | null;
  fill: string;
  isSource: boolean;
  sourceId: string | null;
  fillOverridden: boolean;
}

export interface DocumentRow {
  id: string;
  ownerId: string;
  name: string;
  revision: number;
}

// ---------------------------------------------------------------- валидаторы (Standard Schema без zod)

function stdSchema<T>(check: (v: unknown) => string | null): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'stand',
      validate(value: unknown) {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export type DocArgs = {
  documentId: string;
};
export type PageArgs = {
  documentId: string;
  pageId: string;
};
/** Аргументы мутаторов: те же поля, что у CommandRequest (SPEC §2.3) + documentId (как у HTTP-маршрута). */
export type FillArgs = {
  opId: string;
  documentId: string;
  targetId: string;
  /** #rrggbb в нижнем регистре */
  fill: string;
  expectedRevision: number;
};

const HEX = /^#[0-9a-f]{6}$/;
const OP_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const docArgs = stdSchema<DocArgs>((v) => (isRec(v) && isStr(v.documentId) ? null : 'documentId required'));
export const pageArgs = stdSchema<PageArgs>((v) =>
  isRec(v) && isStr(v.documentId) && isStr(v.pageId) ? null : 'documentId and pageId required',
);
export const fillArgs = stdSchema<FillArgs>((v) => {
  if (!isRec(v)) return 'args must be an object';
  if (typeof v.opId !== 'string' || !OP_ID.test(v.opId)) return 'opId must match [A-Za-z0-9._:-]{1,128}';
  if (!isStr(v.documentId)) return 'documentId required';
  if (!isStr(v.targetId)) return 'targetId required';
  if (typeof v.fill !== 'string' || !HEX.test(v.fill)) return 'fill must match #rrggbb (lowercase)';
  if (!Number.isInteger(v.expectedRevision) || (v.expectedRevision as number) < 0) {
    return 'expectedRevision must be a non-negative integer';
  }
  return null;
});

// ---------------------------------------------------------------- synced queries

const defineQuery = defineQueryWithType<ZeroSchema, ZeroCtx>();
const defineQueries = defineQueriesWithType<ZeroSchema>();

/**
 * Одно и то же определение выполняется на клиенте (локальный IVM над уже полученными строками) и на
 * сервере (`POST /api/zero/query`). Права: сервер ПЕРЕД трансформацией проверяет в PostgreSQL, что
 * `args.documentId` принадлежит `ctx.userID` из JWT (см. ./index.ts, `assertOwnedDocument`), и для чужого
 * документа отвечает ошибкой запроса (`forbidden`) — zero-cache не отдаёт ни одной строки.
 *
 * Почему не `whereExists('document', q => q.where('ownerId', ctx.userID))` (рецепт спайка): такой join
 * заставляет серверный IVM пересчитывать условие для ВСЕХ строк каждого зарегистрированного запроса
 * при каждом изменении строки `documents` (а `revision` меняется каждой командой). Измерено на 50×500:
 * mutate→ack 1.5 с при 50 материализованных страницах против ~0.1 с без join (docs/ZERO_SPIKE.md, §11).
 */
export const queries = defineQueries({
  /** Строка документа (ревизия) — только своя (фильтр по ownerId дешёвый: одна строка, без join). */
  docMeta: defineQuery(docArgs, ({ args, ctx }) =>
    zql.documents.where('id', args.documentId).where('ownerId', ctx.userID),
  ),
  /** Страницы документа по индексу. */
  docPages: defineQuery(docArgs, ({ args }) => zql.pages.where('documentId', args.documentId).orderBy('index', 'asc')),
  /** Фигуры одной страницы (запрос страницы для режимов F и P). */
  shapesByPage: defineQuery(pageArgs, ({ args }) =>
    zql.shapes.where('documentId', args.documentId).where('pageId', args.pageId),
  ),
  /** Все фигуры документа одним запросом (альтернатива для F; в стенде не используется — см. docs/ZERO_SPIKE.md). */
  shapesByDocument: defineQuery(docArgs, ({ args }) => zql.shapes.where('documentId', args.documentId)),
});

/** Имена запросов, у которых аргумент `documentId` обязан принадлежать пользователю (проверяется сервером). */
export const DOCUMENT_SCOPED_QUERIES: ReadonlySet<string> = new Set(['docMeta', 'docPages', 'shapesByPage', 'shapesByDocument']);

export type ZeroQueries = typeof queries;

// ---------------------------------------------------------------- мутаторы

export type FillCommandType = 'setSourceFill' | 'setLocalFill';

/** Серверная реализация (инжектируется сервером): вызывает предметный модуль внутри транзакции push-обработчика. */
export type ServerFillImpl = (
  type: FillCommandType,
  tx: Transaction<ZeroSchema, unknown>,
  args: FillArgs,
  ctx: ZeroCtx,
) => Promise<void>;

/**
 * Оптимистичная (клиентская) часть: перекрашивает строки, которые есть в ЛОКАЛЬНОМ хранилище
 * (источник + непереопределённые экземпляры с тем же sourceId). Идемпотентна (вызывается и при rebase).
 * Ревизию документа не трогает — снимок страницы остаётся на прежней ревизии, поэтому стенд не
 * считает команду завершённой по оптимистичной окраске (SPEC §1.6, §4.1).
 */
async function applyOptimistic(type: FillCommandType, tx: Transaction<ZeroSchema, unknown>, args: FillArgs): Promise<void> {
  if (type === 'setSourceFill') {
    const sources = await tx.run(zql.shapes.where('id', args.targetId));
    for (const s of sources) {
      if (s.isSource && s.fill !== args.fill) await tx.mutate.shapes.update({ id: s.id, fill: args.fill });
    }
    const instances = await tx.run(zql.shapes.where('sourceId', args.targetId).where('fillOverridden', false));
    for (const s of instances) {
      if (s.fill !== args.fill) await tx.mutate.shapes.update({ id: s.id, fill: args.fill });
    }
  } else {
    const targets = await tx.run(zql.shapes.where('id', args.targetId));
    for (const s of targets) {
      if (!s.isSource) await tx.mutate.shapes.update({ id: s.id, fill: args.fill, fillOverridden: true });
    }
  }
}

export function makeMutators(serverImpl?: ServerFillImpl) {
  const defineMutator = defineMutatorWithType<ZeroSchema, ZeroCtx>();
  const defineMutators = defineMutatorsWithType<ZeroSchema>();
  const fill = (type: FillCommandType) =>
    defineMutator(fillArgs, async ({ tx, args, ctx }) => {
      if (tx.location === 'server') {
        if (!serverImpl) throw new Error(`server implementation of ${type} is not configured`);
        await serverImpl(type, tx, args, ctx);
        return;
      }
      await applyOptimistic(type, tx, args);
    });
  return defineMutators({
    setSourceFill: fill('setSourceFill'),
    setLocalFill: fill('setLocalFill'),
  });
}

/** Клиентский реестр мутаторов (серверная часть отсутствует — на клиенте она никогда не вызывается). */
export const mutators = makeMutators();
export type ZeroMutators = ReturnType<typeof makeMutators>;
