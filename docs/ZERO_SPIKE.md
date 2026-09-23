# ZERO_SPIKE — Rocicorp Zero 1.9.0 в песочнице стенда (адаптер Z)

Дата: 2026‑09‑12. Рабочий код спайка: `/home/claude/spike-zero/` (README там же).
Проверено на: Node 24.21.0, PostgreSQL 16.13 (`wal_level=logical`), `@rocicorp/zero@1.9.0`,
`fastify@5.12.4`, `postgres@3.4.9`, `playwright@1.56.0` + Chromium 1194, `esbuild@0.28.2`.

## Вердикт

**Z‑адаптер в песочнице реализуем: ДА.** Полный цикл работает: zero‑cache (self‑hosted) →
synced queries с проверкой владельца по JWT → серверные мутаторы через push‑endpoint в Fastify 5 →
синхронизация изменений на все подписанные страницы, включая страницу, открытую позже.

Ограничения / отклонения (для `DEVIATIONS.md`):
1. **Нет IPv6 в песочнице**, а zero‑cache 1.9.0 жёстко слушает `host: '::'` → нужен shim
   (`NODE_OPTIONS=--import=.../ipv4-shim.mjs`). В Docker/обычном Linux не нужен.
   *Уточнение 2026‑09‑13:* в спайке shim подменял `'::'` на `'0.0.0.0'`; в стенде
   (`scripts/zero-ipv4-shim.mjs`) подмена идёт на **`127.0.0.1`**, иначе :4848 вместе с `/statz`,
   `/heapz` и inspector виден снаружи (§1.6, `docs/DEVIATIONS.md` §5.2). Интерфейс переопределяется
   `STAND_ZERO_BIND_HOST` (в сети Compose — `0.0.0.0`).
2. Модель прав в 1.9 — **synced queries** (`defineQuery` + `ZERO_QUERY_URL`), а не `definePermissions`.
   Старая модель (`definePermissions` + `zero-deploy-permissions` + `enableLegacyQueries:true`) ещё
   присутствует в пакете, но по умолчанию выключена и в документации 1.9 не описана. Мы используем synced queries.
3. `ZERO_AUTH_SECRET` (проверка JWT самим zero‑cache) помечен deprecated, но работает; в 1.9
   «правильный» путь — токен как непрозрачная строка, проверка только на нашем API. Мы включили оба
   уровня (zero‑cache проверяет `sub === userID`, API проверяет подпись и владельца).
4. zero‑cache = 6 процессов Node (runner, main, change‑streamer, replicator, reaper, syncer),
   суммарно ≈ 650 МБ RSS при `ZERO_NUM_SYNC_WORKERS=1` — учитывать в серверном бюджете.
5. Production‑режим по умолчанию (не `NODE_ENV=development`) требует `ZERO_ADMIN_PASSWORD`.

## 1. Что реально есть в 1.9.0 (по установленным `.d.ts`, а не по устаревшим статьям)

| Тема | 1.9.0 |
|---|---|
| Схема | `createSchema({tables, relationships, enableLegacyQueries?, enableLegacyMutators?})`, `table('x').from('server_name').columns({...}).primaryKey()`, `string().from('owner_id').optional()` — маппинг snake_case→camelCase есть. |
| Запросы | `createBuilder(schema)` → `zql.shapes.where(...)`; синхронизируемые запросы — `defineQueries({name: defineQuery(validator?, ({args, ctx}) => zql...)})`; выполнение `zero.materialize(q, {ttl})`, `zero.run(q, {type:'unknown'\|'complete', ttl})`, `zero.preload(q, {ttl})`. Ad‑hoc запросы `zero.query.shapes.where()` доступны **только** при `enableLegacyQueries:true` (иначе `zero.query` = `undefined`, а `materialize(zql.shapes...)` не отправляется на сервер). |
| Права | Серверный endpoint `ZERO_QUERY_URL` (`handleQueryRequest`) переписывает запрос по имени+аргументам с `ctx` из JWT; клиент не может повлиять на `ctx`. `definePermissions` — legacy. |
| Мутаторы | `defineMutators({setSourceFill: defineMutator(validator, async ({tx, args, ctx}) => ...)})`; вызов `zero.mutate(mutators.setSourceFill(args))` → `{client: Promise, server: Promise}`. Серверная сторона: `PushProcessor(db, ctx).process(mutators, query, body)` или `handleMutateRequest({dbProvider, handler, query, body, userID})`. БД: `zeroPostgresJS(schema, sql)` = `ZQLDatabase(new PostgresJSConnection(sql), schema)` (`@rocicorp/zero/server/adapters/postgresjs`, требует **`postgres` v3**). Внутри мутатора сырой SQL: `tx.dbTransaction.wrappedTransaction` — это `postgres.TransactionSql`. |
| Транзакция | `tx.location` `'client'|'server'`, `tx.reason` `'optimistic'|'rebase'|'authoritative'`, `tx.clientID`, `tx.mutationID`, `tx.mutate.<table>.insert/update/upsert/delete`, `tx.run(zql...)`. |
| Клиент | `new Zero({cacheURL, userID, auth, schema, mutators, context, kvStore:'mem'|'idb', logLevel, mutateURL?, queryURL?, onUpdateNeeded, onClientStateNotFound})`; `server` — deprecated‑алиас `cacheURL`. |
| Готовность | `GET http://127.0.0.1:4848/` → `OK` (появляется только после того, как все воркеры готовы и начальная репликация завершена). **Не** использовать `/keepalive` для опроса — он включает HeartbeatMonitor и при прекращении опроса zero‑cache уходит в graceful shutdown. `/statz`, `/heapz` — Basic‑auth с `ZERO_ADMIN_PASSWORD` (`curl -u :spike-admin .../statz`). |
| Протокол | WebSocket `ws://host:4848[/prefix]/sync/v51/connect?...`; заголовок `Sec-WebSocket-Protocol` несёт initConnection + токен; **проверок Origin/Host нет** — TCP‑прокси и префикс пути (`cacheURL: 'http://host:port/zero'`, URL‑шаблон zero‑cache `(/:base)/:worker/v:version/:action`) работают. |

## 2. Схема (общая для клиента и сервера) — `src/schema.mjs`

```js
import {createSchema, table, string, number, boolean, relationships, createBuilder,
        defineQueries, defineQuery, defineMutators, defineMutator} from '@rocicorp/zero';

const documents = table('documents').columns({
  id: string(), ownerId: string().from('owner_id'), name: string(), revision: number(),
}).primaryKey('id');
const pages = table('pages').columns({
  id: string(), documentId: string().from('document_id'), index: number(), name: string(),
}).primaryKey('id');
const shapes = table('shapes').columns({
  id: string(), documentId: string().from('document_id'), pageId: string().from('page_id'),
  kind: string(), x: number(), y: number(), w: number(), h: number(), z: number(),
  text: string().optional(), fill: string(), isSource: boolean().from('is_source'),
  sourceId: string().from('source_id').optional(), fillOverridden: boolean().from('fill_overridden'),
}).primaryKey('id');

export const schema = createSchema({
  tables: [documents, pages, shapes],
  relationships: [
    relationships(pages, ({many, one}) => ({
      shapes: many({sourceField: ['id'], destField: ['pageId'], destSchema: shapes}),
      document: one({sourceField: ['documentId'], destField: ['id'], destSchema: documents}),
    })),
    relationships(shapes, ({one}) => ({
      document: one({sourceField: ['documentId'], destField: ['id'], destSchema: documents}),
    })),
  ],
});
export const zql = createBuilder(schema);
```

Таблица `operations` в Zero‑схему не включена (серверная). zero‑cache всё равно реплицирует **все**
таблицы `public` (`CREATE PUBLICATION _zero_public_0 FOR TABLES IN SCHEMA public`) — чтобы
ограничить, задать `ZERO_APP_PUBLICATIONS` со своей публикацией. Все таблицы должны иметь PK.

## 3. Права: synced queries + `ctx.userID` из JWT

```js
// Standard-Schema валидатор без zod (можно zod/mini):
const std = (check) => ({'~standard': {version: 1, vendor: 'stand',
  validate: (v) => { const e = check(v); return e ? {issues: [{message: e}]} : {value: v}; }}});
const pageArgs = std((v) => (v && typeof v.pageId === 'string') ? null : 'pageId required');

export const queries = defineQueries({
  myDocuments: defineQuery(({ctx}) => zql.documents.where('ownerId', ctx.userID)),
  docPages: defineQuery(docArgs, ({args, ctx}) =>
    zql.pages.where('documentId', args.documentId)
      .whereExists('document', (q) => q.where('ownerId', ctx.userID)).orderBy('index', 'asc')),
  pageShapes: defineQuery(pageArgs, ({args, ctx}) =>
    zql.shapes.where('pageId', args.pageId)
      .whereExists('document', (q) => q.where('ownerId', ctx.userID))),
});
```

Одно и то же определение исполняется на клиенте (локальный IVM, `ctx` = `context` из конструктора
Zero — недоверенный) и на сервере (`ctx.userID` из проверенного JWT — именно он определяет,
какие строки zero‑cache отдаст клиенту). Проверено: bob с `pageShapes(alice‑p2)` получает
**0 строк и `resultType:'complete'`**.

## 4. Мутаторы — общее определение, серверная реализация инжектируется

```js
export function makeMutators(serverImpl) {
  return defineMutators({
    setSourceFill: defineMutator(fillArgs, async ({tx, args, ctx}) => {
      if (tx.location !== 'server') return;          // без оптимистичной части (SPEC §1.6)
      await serverImpl.setSourceFill(tx, args, ctx);
    }),
    setLocalFill: defineMutator(fillArgs, async ({tx, args, ctx}) => {
      if (tx.location !== 'server') return;
      await serverImpl.setLocalFill(tx, args, ctx);
    }),
  });
}
export const mutators = makeMutators({setSourceFill: async () => {}, setLocalFill: async () => {}}); // клиент
```
`fillArgs` = `{opId, documentId, targetId, fill:'#rrggbb', expectedRevision:int}`.
Оптимистичная версия (если понадобится): в ветке `client` — `const rows = await tx.run(zql.shapes.where('sourceId', args.targetId).where('fillOverridden', false)); for (r of rows) await tx.mutate.shapes.update({id: r.id, fill: args.fill});` — клиентский мутатор должен быть идемпотентным (rebase).

## 5. Push‑endpoint и query‑endpoint в Fastify 5 — `src/server.mjs`

```js
import Fastify from 'fastify';
import postgres from 'postgres';
import jwt from 'jsonwebtoken';
import {PushProcessor, handleQueryRequest, ApplicationError} from '@rocicorp/zero/server';
import {zeroPostgresJS} from '@rocicorp/zero/server/adapters/postgresjs';
import {mustGetQuery} from '@rocicorp/zero';
import {schema, queries, makeMutators} from './schema.mjs';

const sql = postgres(process.env.ZERO_UPSTREAM_DB, {max: 10});
const db = zeroPostgresJS(schema, sql);       // Database для PushProcessor; tx = sql.begin(...)

const serverMutators = makeMutators({
  setSourceFill: (tx, args, ctx) => runFillCommand('setSourceFill', tx, args, ctx),
  setLocalFill:  (tx, args, ctx) => runFillCommand('setLocalFill',  tx, args, ctx),
});

async function runFillCommand(type, tx, args, ctx) {
  const pg = tx.dbTransaction.wrappedTransaction;   // postgres.js TransactionSql — сырой SQL
  const prev = await domain.readOperation(pg, args.opId);            // идемпотентность
  if (prev) { if (prev.params_hash !== hash) throw new ApplicationError('op_conflict', {details: {code: 409}}); return prev.result; }
  const doc = await pg`SELECT owner_id, revision FROM documents WHERE id = ${args.documentId} FOR UPDATE`;
  if (!doc[0] || doc[0].owner_id !== ctx.userID) throw new ApplicationError('forbidden', {details: {code: 403}});
  if (doc[0].revision !== args.expectedRevision) throw new ApplicationError('revision_mismatch', {details: {code: 409, revision: doc[0].revision}});
  const rows = type === 'setSourceFill'
    ? await pg`UPDATE shapes SET fill = ${args.fill} WHERE document_id = ${args.documentId}
               AND (id = ${args.targetId} OR (source_id = ${args.targetId} AND fill_overridden = false)) RETURNING id, page_id`
    : await pg`UPDATE shapes SET fill = ${args.fill}, fill_overridden = true WHERE document_id = ${args.documentId} AND id = ${args.targetId} RETURNING id, page_id`;
  const [{revision}] = await pg`UPDATE documents SET revision = revision + 1 WHERE id = ${args.documentId} RETURNING revision`;
  const result = {opId: args.opId, revision, affectedPages: [...new Set(rows.map(r => r.page_id))], affectedShapes: rows.length};
  await pg`INSERT INTO operations ${pg({op_id: args.opId, document_id: args.documentId, params_hash: hash, result: pg.json(result)})}`;
  return result;
}

function verifyJwt(req) {                       // Authorization: Bearer <auth из new Zero({auth})>
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  try { return m && jwt.verify(m[1], process.env.JWT_SECRET, {algorithms: ['HS256']}); } catch { return null; }
}

const app = Fastify({logger: true});
app.post('/api/zero/push', async (req, reply) => {     // ZERO_MUTATE_URL; ?schema=zero_0&appID=zero
  const claims = verifyJwt(req);
  if (!claims) return reply.code(401).send({error: 'unauthorized'});   // 401/403 -> клиент 'needs-auth'
  const ctx = {userID: claims.sub};
  const result = await new PushProcessor(db, ctx, 'warn').process(serverMutators, req.query, req.body);
  return {...result, userID: ctx.userID};      // zero-cache сверяет userID с соединением
});
app.post('/api/zero/query', async (req, reply) => {    // ZERO_QUERY_URL
  const claims = verifyJwt(req);
  if (!claims) return reply.code(401).send({error: 'unauthorized'});
  const ctx = {userID: claims.sub};
  return handleQueryRequest({schema, userID: ctx.userID, query: req.query, body: req.body, logLevel: 'warn',
    handler: (name, args) => mustGetQuery(queries, name).fn({args, ctx})});
});
await app.listen({port: 3100, host: '127.0.0.1'});
```

Как это работает внутри (важно для домена/транзакций стенда):
* `PushProcessor` для каждой мутации открывает `sql.begin()` (READ COMMITTED), в той же транзакции
  делает `INSERT ... zero_0.clients ("clientGroupID","clientID","lastMutationID")` (проверка порядка
  мутаций), вызывает мутатор, коммитит. Ошибка мутатора (`ApplicationError` или любая другая)
  → откат, **повторная транзакция без мутатора**, чтобы записать `lastMutationID` и результат‑ошибку
  в `zero_0.mutations`; клиент получает `.server → {type:'error', error:{type:'app', message, details}}`.
  Успех → `{type:'success'}` (полезная нагрузка результата на клиент **не** возвращается —
  `affectedPages`/`revision` клиент узнаёт из синхронизированных данных или через `GET /api/operations/:opId`).
* Повтор мутации с тем же `mutationID` → `alreadyProcessed` (обрабатывает сам PushProcessor);
  наша идемпотентность по `opId` — второй слой для повторного `runCommand` из UI.
* Изоляция `REPEATABLE READ` для мутатора недоступна через `zeroPostgresJS`; если нужна —
  свой `DBConnection` (`transaction(fn) { return sql.begin('isolation level repeatable read', tx => fn(new PostgresJsTransactionInternal(tx))) }`) → `new ZQLDatabase(conn, schema)`.
* `ZQLDatabase.transaction` кэширует `serverSchema` (первая транзакция читает information_schema).

## 6. zero‑cache: переменные среды (`/home/claude/spike-zero/zero.env`)

```bash
ZERO_UPSTREAM_DB=postgresql://postgres:postgres@127.0.0.1:5432/editor   # CVR/CDC по умолчанию там же (схемы zero, zero_0, "zero_0/cvr", "zero_0/cdc")
ZERO_REPLICA_FILE=/абс/путь/replica/zero.db      # SQLite (wal2); 1200 фигур -> 0.35 MB + WAL ~1 MB
ZERO_PORT=4848
ZERO_MUTATE_URL=http://127.0.0.1:3100/api/zero/push     # 1.9: MUTATE (PUSH_URL — deprecated-алиас); URLPattern!
ZERO_QUERY_URL=http://127.0.0.1:3100/api/zero/query     # 1.9: QUERY (GET_QUERIES_URL — deprecated-алиас)
ZERO_AUTH_SECRET=<secret>            # deprecated, но работает: HS256, требует token.sub === userID
ZERO_ADMIN_PASSWORD=<pwd>            # обязателен, если NODE_ENV != development
ZERO_APP_ID=zero                     # схема zero_0, публикация _zero_public_0, слот zero_0_a
ZERO_NUM_SYNC_WORKERS=1              # 2 vCPU
ZERO_ENABLE_CRUD_MUTATIONS=false     # legacy CRUD не нужен
ZERO_LOG_LEVEL=info  ZERO_LOG_FORMAT=text  ZERO_ENABLE_TELEMETRY=false  DO_NOT_TRACK=1
NODE_OPTIONS=--import=/абс/путь/ipv4-shim.mjs   # только в этой песочнице (нет IPv6)
```
Запуск: `set -a; source zero.env; set +a; npx zero-cache` (prod‑режим; `zero-cache-dev` — dev‑обёртка
с watch схемы). Готовность: `curl -fsS http://127.0.0.1:4848/` → `OK` (в песочнице ≈ 9–12 с при старте
с существующей репликой; первая начальная синхронизация 1200 строк — доли секунды). Остановка: SIGTERM
runner’у (`kill $(cat logs/zero-cache.pid)`); дочерние процессы — `pkill -f "zero/out/zero-cache/src/server"`.
Порядок: **API до zero‑cache** (иначе первые `/query` дадут `TransformFailed: fetch failed`, клиент
переподключится, но ≈ 1 с задержки). После пересоздания БД (`seed`) удалять схемы `zero*`,
публикации `_zero*`, слот `zero_0_a` и файл реплики, иначе zero‑cache ресинхронизируется с ошибками.

Побочные объекты в upstream: схемы `zero` (`zero.permissions`, `zero.schemaVersions`), `zero_0`
(`clients`, `mutations`, `publishedSchema`, `replicas`, `shardConfig`, `versionHistory`),
`zero_0/cvr`, `zero_0/cdc`; event‑триггеры на DDL; replication slot `zero_0_a` (superuser или REPLICATION).

## 7. Клиент — конструирование, materialize, 'complete', mutate

```js
import {Zero} from '@rocicorp/zero';
const z = new Zero({
  cacheURL: 'http://127.0.0.1:4848',   // через шейпер: 'http://127.0.0.1:<shaper>/zero' (один сегмент префикса)
  userID, auth: jwt, schema, mutators,
  context: {userID},                    // для локального исполнения synced query
  kvStore: 'idb',                       // 'mem' | 'idb' | StoreProvider; в Node — 'mem' (в Node 24 клиент работает без правок: WebSocket, BroadcastChannel есть)
  logLevel: 'error',
  onUpdateNeeded: () => {}, onClientStateNotFound: () => {},   // иначе location.reload()
});
z.connection.state.subscribe((s) => /* 'connecting'|'connected'|'needs-auth'|'error'|'closed'|'disconnected' */);

// Страница: materialize + ожидание полного набора (SPEC §4.2 — 'unknown' готовностью не считается)
const view = z.materialize(queries.pageShapes({pageId}), {ttl: 'none'});
const off = view.addListener((rows, resultType /* 'unknown'|'complete'|'error' */, err) => {
  if (resultType === 'complete') cb({shapes: rows});   // rows — immutable snapshot; view.data — текущие
});
// ВНИМАНИЕ: addListener вызывает слушателя синхронно с текущим состоянием.
// Отписка/освобождение: off(); view.destroy();  view.updateTTL(ttl) — только УВЕЛИЧИВАЕТ ttl.

// Команда
const r = z.mutate(mutators.setSourceFill({opId, documentId, targetId, fill, expectedRevision}));
await r.client;   // {type:'success'} за 1–3 мс: локальная транзакция применена (у нас no-op)
await r.server;   // {type:'success'} | {type:'error', error:{type:'app'|'zero', message, details}}
```
Наблюдаемый порядок событий при успехе: `.client` → **обновление view серверными данными**
(poke после коммита) → `.server` (в нашей серии `.server` разрешался в ту же/следующую миллисекунду
после обновления view). Для `command-acked` брать `.server`; для `command-drawn` — момент, когда
`view.data` активной страницы содержит новые заливки (+ rAF).

Ревизия документа синхронизируется той же покой: `documents.revision` в view `myDocuments` растёт на 1
сразу после команды — можно использовать как «ревизия ≥ последней подтверждённой команды».

## 8. Память клиента: destroy / ttl / что удерживается / IDB

* `view.destroy()` → счётчик запроса на клиенте −1; при 0 клиент шлёт `changeDesiredQueries: del`.
  zero‑cache помечает запрос **inactive** и держит его строки ещё `ttl`; по истечении удаляет из CVR,
  клиент получает удаления строк.
* `ttl` задаётся при первом `materialize/run/preload` данного хеша запроса; по умолчанию **`'5m'`**
  (`materialize`, `run`), `'none'` у `preload`; максимум 10m (`clampTTL`); `updateTTL` только увеличивает.
  Измерено: `ttl:'none'` + `destroy()` → строки страницы исчезли из клиентского хранилища через
  **76–194 мс** (Node) / **99 мс** (Chromium). `ttl:'5m'` → строки остаются (запрос «inactive» на сервере).
* **Подсчёт удерживаемых строк** (для `getRetained()`), без обращения к серверу:
  ```js
  const insp = await z.inspector;                // ленивый импорт, без пароля для локальных операций
  const shapes = await insp.client.rows('shapes'); // читает локальный b-tree по префиксу "e/shapes/"
  const all = await insp.client.map();             // вся KV-карта (можно оценить байты JSON.stringify)
  // серверный список запросов клиента (нужен ZERO_ADMIN_PASSWORD): await insp.authenticate(pwd); await insp.client.queries()
  //   -> [{name, args, ttl, rowCount, inactivatedAt, got, ...}]; в браузере без authenticate() откроется <dialog> с промптом.
  ```
  Имена колонок в `rows()` — клиентские (camelCase: `pageId`), ключи карты — `e/<table>/<pk>`
  (плюс пара служебных `d/...`); 200 фигур + 1 документ ≈ 49 КБ в JSON (оценка `bytesEstimate`).
* Ловушка: `zero.run(q, {type:'unknown'})` = `materialize()` + `destroy()` с **ttl по умолчанию 5m**:
  запрос регистрируется на сервере, строки приезжают в фоне и остаются 5 минут. Для одноразового чтения
  без удержания: `z.run(q, {type:'complete', ttl:'none'})` (проверено: строки не остаются).
* `kvStore:'idb'`: база `rep:zero-<userID>-<hash(storageKey,mutateURL,queryURL)>:<fmt>:<schemaHash>` + реестр
  `replicache-dbs-v0`. `navigator.storage.estimate().usage` растёт (≈ 84 КБ при 400 фигурах, ≈ 150 КБ после
  `close()`), `z.idbName` даёт имя. Logout: `await z.close(); await dropAllDatabases()` (экспорт `@rocicorp/zero`)
  → удаляет `rep:zero-*`; реестр `replicache-dbs-v0` остаётся (можно `indexedDB.deleteDatabase('replicache-dbs-v0')`).
  Новый browser context в Playwright = пустой IDB.
* `z.close()` закрывает WS и ставит состояние `closed`; `z.delete()` — удаляет и хранилище этого инстанса.

## 9. Измерения (песочница, 2 vCPU, localhost без шейпера, 200 фигур/страница)

| Метрика | Значение |
|---|---|
| `materialize(pageShapes)` до `'complete'`, первая подписка | 40–140 мс (Node), 67–104 мс (Chromium) |
| `'unknown'` (локальный пустой результат) | ≈ 1 мс |
| `mutate()` → `.client` | 1–3 мс |
| `mutate()` → view с серверными данными (setLocalFill, N=10) | **медиана 27 мс** (25–49) |
| `mutate()` → `.server` | медиана 28 мс; setSourceFill (12 фигур на 2 страницах): 68–320 мс |
| Страница без подписки после команды | `'complete'` через 59–124 мс, все непереопределённые экземпляры уже с новой заливкой |
| bob → alice p2 | 0 строк, `'complete'` за ≈ 40 мс |
| Байты через TCP‑прокси для первой подписки 200 фигур | ≈ 55 КБ вход, ≈ 2 КБ выход (сжатие WS выключено по умолчанию, `ZERO_WEBSOCKET_COMPRESSION`) |
| Реплика | `zero.db` 0.35 МБ + WAL ≈ 1 МБ (1200 фигур) |
| zero‑cache RSS | ≈ 650 МБ (6 процессов) |
| API push‑обработка | 3–6 мс на мутацию |

## 10. Прочие gotchas

* `PushProcessor.process(mutators, req.query, req.body)` — Fastify‑объекты подходят напрямую (`query` = plain object).
  В ответ `userID` не добавляется — добавляем сами (`handleMutateRequest({userID})` добавляет).
* Валидатор в `defineQuery/defineMutator` — любой Standard Schema (zod, valibot или ручной объект `'~standard'`).
* Клиентский мутатор `defineMutator` вызывается и при `reason:'rebase'` — должен быть идемпотентным.
* Заголовок `Authorization` на push/query — токен из `new Zero({auth})`; при 401/403 от API клиент → `needs-auth`,
  тогда `z.connection.connect({auth: newToken})`. Смена `auth` при живом соединении делает re‑transform запросов.
* Ошибка сервера 5xx → zero‑cache повторяет до 4 раз с backoff; 4xx (кроме 401/403) — ошибка мутации сразу.
* `zero-cache` нельзя убить по `pkill -f zero-cache`, если в командной строке скрипта есть это слово; по pid runner’а — корректный SIGTERM.
* Первое `/query` для нового client group — `TransformFailed`, если API ещё не поднят: клиент переподключается сам.
* Логи zero‑cache многословны (`syncQueryPipelineSet` на каждое изменение запросов) — `ZERO_LOG_LEVEL=warn` для серий.
* PostgreSQL 16 и Node 24: несовместимостей не обнаружено (`@rocicorp/zero-sqlite3` использует prebuild linux‑x64, install‑script не нужен).

## 11. Интеграция в стенд (адаптер Z, дата 2026‑09‑12)

Код: `packages/server/src/zero/{schema,mutators,index}.ts`, `packages/client/src/adapters/z.ts`,
`scripts/{start-zero,stop-zero,zero-reset-replication}.sh` + `scripts/zero-ipv4-shim.mjs`,
проверки `packages/server/test/zero.test.ts` и `packages/client/test/z.spec.mjs`.

### 11.1 Запуск и переменные

```bash
export PATH=/opt/node24/bin:$PATH
scripts/start-api.sh --build                 # API (:3000, STAND_TEST_HOOKS=1) — ДО zero-cache
scripts/start-zero.sh                        # zero-cache :4848 → results/logs/zero-cache.{log,pid}, реплика results/zero-replica/zero.db
STAND_API_PORT=3002 scripts/start-zero.sh    # zero-cache, шлющий push/query на другой порт API
scripts/stop-zero.sh                         # SIGTERM runner'у + добивание воркеров по пути модуля
scripts/zero-reset-replication.sh            # после пересоздания БД/перезаливки документов: схемы stand_0*, слот, публикации, файл реплики
```

| Переменная zero-cache | Значение в стенде | Откуда |
|---|---|---|
| `ZERO_UPSTREAM_DB` | `postgres://postgres:postgres@127.0.0.1:5432/editor` | `STAND_DB_URL` |
| `ZERO_REPLICA_FILE` | `results/zero-replica/zero.db` (bench: `zero_replica_bytes`) | `STAND_ZERO_REPLICA_DIR` |
| `ZERO_PORT` | 4848 | `STAND_ZERO_PORT` |
| `ZERO_MUTATE_URL` / `ZERO_QUERY_URL` | `http://127.0.0.1:${STAND_API_PORT:-3000}/api/zero/mutate` / `.../query` (`/api/zero/push` — алиас mutate) | `STAND_API_PORT` |
| `ZERO_AUTH_SECRET` | = `STAND_JWT_SECRET` (zero-cache сам проверяет HS256 и `sub === userID`; API — второй раз) | `STAND_JWT_SECRET` |
| `ZERO_APP_ID` | `stand` → схемы `stand`, `stand_0`, `"stand_0/cvr"`, `"stand_0/cdc"`, слот `stand_0_a` (не пересекается со спайком `zero_0_a`) | `STAND_ZERO_APP_ID` |
| `ZERO_APP_PUBLICATIONS` | `stand_zero` = `FOR TABLE documents, pages, shapes` (создаётся скриптом; без неё реплицировались бы `users`, `operations`, `shapes_baseline`) | `STAND_ZERO_PUBLICATION` |
| `ZERO_ADMIN_PASSWORD` | `stand-admin` (/statz, /heapz, inspector.authenticate) | `STAND_ZERO_ADMIN_PASSWORD` |
| прочее | `ZERO_NUM_SYNC_WORKERS=1`, `ZERO_ENABLE_CRUD_MUTATIONS=false`, `ZERO_LOG_LEVEL=warn`, telemetry off, `NODE_OPTIONS=--import=scripts/zero-ipv4-shim.mjs` (только песочница) | |

Готовность: `GET :4848/` → `OK` (≈ 10–12 с с готовой репликой; первая репликация 128 k строк всех документов — ещё ≈ 5 с).
Реплика всех документов стенда: 27 МБ; zero-cache = 6 процессов, ≈ 730 МБ RSS суммарно (входит в серверный бюджет).

### 11.2 Маршрут через шейпер / Caddy

Клиент Z открывает WebSocket на `cacheURL = ${location.origin}/zero` (константа `ZERO_PATH`); zero-cache принимает
один сегмент префикса пути (`/zero/sync/v51/connect` — шаблон `(/:base)/:worker/v:version/:action`), поэтому
префикс **не** срезается. Точная строка маршрутов netshaper (`scripts/start-shaper.sh` уже такая):

```
--routes '/api=127.0.0.1:3000,/zero=127.0.0.1:4848,/=127.0.0.1:3000'      # без ;strip
```

Проверено: `GET /stats` шейпера показывает `byRoute['/zero'].upgrades = 1` на сеанс, весь объём страниц идёт по
этому маршруту (P/1: ≈ 1.9 МБ за сценарий с 6 переходами; F: ≈ 7.1 МБ за 50 страниц). Caddyfile (`/zero/*` →
`zero-cache:4848` без rewrite) совместим. Для прямого режима без шейпера клиент принимает `?zero=http://127.0.0.1:4848`.

### 11.3 Сервер

* `schema.ts` — ЕДИНЫЙ модуль схемы/запросов/мутаторов: сервер импортирует `./schema.js`, клиент — исходник
  по относительному пути (`../../../server/src/zero/schema`), поэтому в нём только `@rocicorp/zero`.
* Synced queries: `docMeta(documentId)`, `docPages(documentId)`, `shapesByPage(documentId, pageId)`,
  `shapesByDocument(documentId)`. **Права проверяются при трансформации** (`POST /api/zero/query`, `assertOwnedDocument`:
  `documents.owner_id = ctx.userID` из JWT, иначе ошибка запроса `forbidden`/`not_found` — клиентский view получает
  `resultType:'error'` и ни одной строки; проверено для bob). Обработчик `handleQueryRequest` ждёт промис
  (тип объявлен синхронным).
* **Отклонение от рецепта спайка (§3):** фильтр владельца через `whereExists('document', …)` убран из запросов страниц.
  Причина — измерение на 50×500: при таком join серверный IVM пересчитывает условие для всех строк каждого
  зарегистрированного запроса при каждом изменении строки `documents` (а `revision` меняется каждой командой):
  mutate→`.server` = **1.5 с** при 50 материализованных страницах (0.11 с при 1, ≈ 30 мс на запрос), загрузка 50 страниц
  3.6 с. Без join: **0.10 с** при 50 страницах, загрузка 0.65–2.7 с. Функционально то же: строки отдаются только владельцу.
* Мутаторы `setSourceFill`/`setLocalFill` с аргументами `{opId, documentId, targetId, fill, expectedRevision}`:
  серверная часть (`mutators.ts`) = `executeCommand(new PgDomainTx(tx.dbTransaction.wrappedTransaction), ctx.userID, documentId, cmd)`
  внутри транзакции PushProcessor (`zeroPostgresJS(schema, sql)` над тем же пулом postgres.js 3.4.9) —
  права, идемпотентность по `opId`, `expectedRevision`, `revision+1`, строка `operations` идентичны HTTP-пути.
  `DomainError` → `ApplicationError(code, {details:{code, status, message, currentRevision?}})` → откат, клиент получает
  `.server → {type:'error', error:{type:'app', message, details}}`; клиент Z отображает `details` в `ApiHttpError`
  с теми же кодами (403 `forbidden`, 409 `revision_mismatch` + `currentRevision`, 409 `op_conflict`, 404, 400).
  Клиентская часть мутатора — оптимистичная перекраска локальных строк (источник + непереопределённые экземпляры
  среди имеющихся; `setLocalFill` — `fill` + `fillOverridden`), идемпотентна (rebase); ревизию не трогает.
* Маршруты: `POST /api/zero/mutate` (+ алиас `/api/zero/push`), `POST /api/zero/query`; 401 без валидного Bearer.
  Регистрация — `registerZeroRoutes(app, {sql})` в `app.ts` (как и раньше). Обработка push в API: 1–6 мс.

### 11.4 Клиент: что значат ready / acked / drawn для Z

* `open()` — метаданные по HTTP `GET /api/documents/:id` (как у H/Q, чужой документ → 403 там же), затем
  `new Zero({cacheURL, userID, auth: token, schema, mutators, context:{userID}, kvStore:'idb', logLevel:'error',
  onUpdateNeeded/onClientStateNotFound → событие error (не reload)})` и materialized `docMeta` (ttl 'none').
* **Страница готова**: materialized `shapesByPage` (ttl `'none'`) отдал `resultType === 'complete'`; снимок несёт
  **синхронизированную** ревизию документа (строка `documents` приходит той же покой, что и строки фигур; все строки
  клиентского хранилища — одной версии). До первого `complete` снимка нет (`'unknown'` = локальные/частичные данные).
  `page-ready` — после отрисовки (двойной rAF в `stand.ts`) с ревизией ≥ последней подтверждённой команды.
* **command-sent** — вызов `zero.mutate(...)`; **command-acked** — `.server` разрешился успехом **и** результат операции
  получен через `GET /api/operations/:opId` (протокол Zero не возвращает клиенту результат мутатора: zero-cache отдаёт
  только success/error — см. `MutationTracker#settleMutation`; `affectedPages/affectedShapes` нужны в `command-acked`
  для функциональных проверок и результата `runCommand`). Момент `.server` сохраняется в
  `adapter.commandTimings[].serverAt` (диагностика, `window.__standController.adapter`).
  **Ошибка мутатора** → `ApiHttpError` с теми же кодами; `revision_mismatch` → контроллер делает `refreshMeta()` и один
  повтор с тем же `opId` (общая логика `stand.ts`).
* **command-drawn** — активная страница отрисована со снимком, чья синхронизированная ревизия ≥ ревизии команды:
  для затронутой страницы это пока с новыми заливками, для незатронутой — та же пока с бампом `documents.revision`
  (снимок переиздаётся с новой ревизией без запроса). Оптимистичная окраска не меняет ревизию снимка и завершением
  не считается. `runCommand` разрешается после acked **и** достижения ревизии синхронизацией.
* **F**: все страницы материализуются при `open()` — активная первой, остальные через ограничитель параллелизма 4
  (тот же, что у H/Q); все view остаются. Измерено (Node, localhost, 25 000 строк): c=4 — 0.65–2.6 с (первый прогон
  холоднее), c=8 — 0.84 с, все 49 сразу — 3.8 с при задержке активной до 1.8 с, один запрос `shapesByDocument` — 1.9 с.
  Разница «страницами c=4» / «один запрос» не драматична → оставлены per-page запросы (P/F различаются только
  набором подписок). **P**: активная + LRU-окно `cache`; незавершённая прежняя активная и страницы вне окна —
  `view.destroy()` (ttl 'none' → zero-cache снимает запрос, строки удаляются из хранилища за ≈ 0.1–0.25 с).
* **`getRetained()`** — реальные строки `shapes` в клиентском хранилище: `zero.inspector.client.rows('shapes')`
  (скан локального b-tree, без сервера; `pages` = число различных `pageId` среди строк + пустые полные страницы,
  `bytesEstimate` = 200 Б/фигуру как у H/Q). Метод синхронный по контракту, поэтому отдаёт кеш, который
  пересчитывается: P — сразу при `complete`/после команды + повторы через 150 и 450 мс после вытеснения
  (скан 1000 строк ≈ 40 мс); F — с задержкой 300 мс после последнего изменения (скан 25 000 строк ≈ 0.3 с main-thread,
  во время фоновой загрузки не должен конкурировать с IVM). Точное значение «сейчас» —
  `window.__standController.adapter.getRetainedAsync()` (скан начинается после вызова). В измерениях после `page-ready`
  кеш отстаёт только если общее число строк изменилось в тот же момент (первые шаги заполнения окна).
* **logout**: `view.destroy()` всех, `zero.close()`, `dropAllDatabases()` (`rep:zero-*`), затем `stand.ts` чистит
  localStorage/sessionStorage/все базы IndexedDB → `getRetained() = {0,0}`, `indexedDB.databases() = []` (проверено).

### 11.5 Измерения интеграции (Chromium 1194, 50×500, 2 vCPU; `npm run test:z`)

| Метрика | P/1 напрямую | P/3 напрямую | F напрямую | P/1 через шейпер (25 мс, 20 Мбит/с) | F через шейпер |
|---|---|---|---|---|---|
| first-ready (от navigation start) | 0.34 с | 0.31 с | 0.47 с | 0.72 с | 0.96 с |
| переход на новую страницу | 100–120 мс | ≈ 100 мс | 19–33 мс (уже локально) | 140–190 мс | ≈ 20 мс |
| F: все 50 страниц загружены | — | — | ≈ 3.6 с от открытия | — | ≈ 5.9 с (7.1 МБ по WS) |
| setSourceFill (81 фигур, 10 страниц): `.server` / acked / drawn | 57 / 67 / 67 мс | 54 / 64 / 78 мс | 125 / 133 / 136 мс | 111 / 170 / 170 мс | 153 / 214 / 214 мс |
| setLocalFill: `.server` / acked / drawn | 41 / 59 / 67 мс | 30 / 37 / 62 мс | 38 / 59 / 59 мс | 78 / 136 / 136 мс | 98 / 159 / 159 мс |
| retained после сценария | 2 стр. / 1000 фигур | 4 / 2000 | 50 / 25 000 | 2 / 1000 | 50 / 25 000 |
| IndexedDB (`storage.estimate`) | ≈ 215 КБ | ≈ 356 КБ | 1.8–3.7 МБ | ≈ 214 КБ | ≈ 1.8 МБ |

Разница acked − `.server` (≈ 10 мс localhost, ≈ 60 мс через шейпер) — HTTP-чтение результата операции. Время
`.server` растёт с числом живых запросов клиента (≈ 1–2 мс на запрос на стороне zero-cache): F ≈ +70 мс к P.

### 11.6 Известные ограничения / что записать в DEVIATIONS

1. Права чтения — проверка владельца документа при трансформации synced query (по JWT), а не row-level join
   (причина и цифры — §11.3). Смена владельца во время сеанса (в стенде не бывает) потребовала бы
   переподключения клиента.
2. `command-acked` для Z включает `GET /api/operations/:opId` после `.server` (+1 RTT), т. к. Zero не отдаёт
   результат мутатора; момент `.server` доступен в диагностике адаптера.
3. `getRetained()` — асинхронно обновляемый кеш реальных строк; точное значение — `getRetainedAsync()`.
4. Оптимистичная часть мутатора включена (SPEC §2.4 допускает), но на готовность не влияет.
5. Песочница: IPv4-shim (нет IPv6); `ZERO_AUTH_SECRET` deprecated в 1.9, но используется (двойная проверка JWT).
6. Реплика zero-cache содержит все опубликованные таблицы целиком (документы всех пользователей) — свойство Zero;
   публикация `stand_zero` ограничивает набор таблиц, но не строк.
7. Токен 15 мин: при `needs-auth` адаптер пишет событие `error`, повторный login не делает (сценарий < 1 мин).
   Скрытая вкладка: клиент Zero отключается через 5 с (`hiddenTabDisconnectDelay` по умолчанию) — в headless
   Playwright вкладка «видима», проблем не наблюдалось.
8. `test/smoke.spec.mjs`: прежний кейс «Z — заглушка» заменён реальными проверками против мока — разделение bundle по адаптерам
   (H/Q не грузят `z-*.js`, Z не грузит `q-*.js`; Z без `/zero` остаётся `loading`) и `getRetainedAsync()` у H/Q; поведение Z — в `test/z.spec.mjs`.
