# @stand/server — API стенда (Fastify 5 + PostgreSQL)

Серверный контракт по SPEC §2, §3. ESM, TypeScript strict, SQL явный (postgres.js 3.4.9, без ORM).

## Запуск

```bash
export PATH=/opt/node24/bin:$PATH
npm install                                  # из корня репозитория (workspaces)
scripts/start-db.sh                          # PostgreSQL 16, wal_level=logical, БД editor
scripts/migrate.sh                           # схема + пользователи alice/bob (идемпотентно)
scripts/gen-all.sh                           # документы в data/ + загрузка в БД (+ shapes_baseline)
scripts/start-api.sh --build                 # API в фоне: results/logs/api.pid, results/logs/api.log
scripts/stop-all.sh
```

Внутри пакета: `npm run dev` (tsx watch), `npm run build`, `npm start`, `npm run migrate`, `npm test`.

## Переменные среды

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `STAND_DB_URL` | `postgres://postgres:postgres@127.0.0.1:5432/editor` | строка подключения |
| `STAND_PORT` / `STAND_HOST` | `3000` / **`127.0.0.1`** | адрес API. Умолчание локальное намеренно (§1.6): служебные порты закрыты от браузера. В Compose задаётся `0.0.0.0` явно — там порт наружу не публикуется |
| `STAND_JWT_SECRET` | dev-секрет (с предупреждением в логе) | секрет HS256; тот же для zero-cache (`ZERO_AUTH_SECRET`). Только из среды, в клиентскую сборку не попадает |
| `STAND_TEST_HOOKS` | `0` | `1` — включить `/api/test/*` |
| `STAND_TEST_HOOKS_SECRET` | пусто | общий секрет заголовка `x-stand-test-secret` для `/api/test/*`. **Реализовано** (`src/routes/test.ts`): при непустом значении хук `onRequest` сверяет заголовок сравнением постоянного времени до разбора тела, иначе 401. Пусто — хуки открыты (только для привязки к `127.0.0.1`). В песочнице секрет генерируется `scripts/lib.sh` в `results/logs/.test-secret` (0600) |
| `STAND_LOG_LEVEL` | `info` | уровень pino (лог запросов в stdout); в сериях измерений API запускается с `warn` (`docs/DEVIATIONS.md` 4.1), значение видно в `GET /api/health` |
| `STAND_CLIENT_DIST` | `packages/client/dist` | каталог production-сборки клиента (SPA с корня, если существует) |
| `STAND_DB_POOL` | `10` | размер пула соединений |

> `scripts/lib.sh` задаёт `STAND_HOST=${STAND_HOST:-127.0.0.1}`, то есть повторяет умолчание кода
> (раньше переопределял на `0.0.0.0` — исправлено 2026‑09‑13, `docs/DEVIATIONS.md` §5.2).
> Фактическую привязку запущенного API всё равно стоит проверять `ss -ltnp | grep :3000` и писать
> в паспорт серии.

## Безопасность (§1.2, §1.6)

* Все маршруты, кроме `GET /api/health` и `POST /api/auth/login`, требуют `Authorization: Bearer`.
  Пользователь определяется по токену; `documentId` из браузера доказательством доступа не является
  (чтение чужого документа → 403, команда над чужой фигурой → 403).
* Токен — JWT HS256, **15 минут** (`expiresIn: 900`), claim `sub` = userId. Продления и refresh нет:
  приёмочный сценарий короче времени жизни токена в десятки раз; при истечении клиент выпускает событие
  `error`, и прогон учитывается как ошибочный, а не переавторизуется молча. Клиент держит токен только в
  памяти и при `logout` очищает `localStorage`/`sessionStorage`/IndexedDB приложения.
* Тот же токен передаётся zero-cache и проверяется **дважды**: самим zero-cache (`ZERO_AUTH_SECRET`,
  HS256 и `sub === userID`) и заново в `/api/zero/{query,mutate}`.
* Секрет подписи читается только здесь (`src/config.ts`) и в клиентскую сборку не попадает —
  проверка: `grep -rn 'STAND_JWT_SECRET\|jwtSecret' packages/client/dist` даёт 0 вхождений.
* Хуки `/api/test/*` включаются только при `STAND_TEST_HOOKS=1`, в измеряемый путь не входят и при
  непустом `STAND_TEST_HOOKS_SECRET` требуют заголовок `x-stand-test-secret` (сравнение постоянного
  времени, 401 до разбора тела). В песочнице секрет генерируется автоматически, поэтому хуки закрыты
  и при локальной привязке.

## Кеширование ответов API (§1.2, §1.8; дефект A14)

**Каждый** ответ `/api/**` несёт `Cache-Control: no-store`. Ставится в `onRequest`
(`registerNoStore`, `src/app.ts`), поэтому заголовок есть и у успешных ответов, и у 401 от
`authenticate`, и у ответов обработчика ошибок, и у 404 `setNotFoundHandler`, и у
`/api/zero/{query,mutate}`. Валидаторы (`ETag`, `Last-Modified`, `Expires`) не выставляются нигде.

Зачем: стенд измеряет стоимость чтения страницы **по сети**. Если бы браузер отдал повторное чтение
вытесненной страницы из своего HTTP‑кеша, у H и Q такое чтение стоило бы ноль байт и ноль времени, и
разница с Z читалась бы как преимущество HTTP‑адаптеров. До этого изменения переиспользования не
происходило (валидаторов не было), но держалось это на их **отсутствии**, а не на запрете: любой
будущий `ETag` молча изменил бы и байты, и времена. Проверено по уже снятым 180 прогонам основной
серии: число запросов API, посчитанное клиентом, совпало с числом запросов на шейпере в 180 из 180.

Статика клиента не затронута — своя политика в `src/routes/static.ts` (`index.html` — `no-cache`,
хешированные ассеты — `public, max-age=31536000, immutable`).

Проверка: `packages/server/test/integration.test.ts`, блок «кеширование (A14)».

## Маршруты

Все ответы JSON. Ошибки в едином формате `{error, message, currentRevision?}` (`ApiError` из `@stand/shared`):
`unauthorized` 401, `forbidden` 403, `not_found` 404, `bad_request` 400 (в т. ч. ошибки JSON-схем),
`revision_mismatch` 409 (+`currentRevision`), `op_conflict` 409, `internal` 500.

| Метод и путь | Auth | Описание |
|---|---|---|
| `GET /api/health` | нет | `{status, db, uptimeSec, testHooks, logLevel, now}`; 503 если БД недоступна |
| `POST /api/auth/login` `{login,password}` | нет | `{token, userId, expiresIn:900}`; JWT HS256 15 мин, claim `sub`=userId, `login` |
| `GET /api/documents` | Bearer | свои документы `{id,name,revision,pageCount,shapeCount}` |
| `GET /api/documents/:docId` | Bearer | `{id,name,revision,pages:[{id,index,name}]}`; чужой → 403 |
| `GET /api/documents/:docId/pages/:pageId` | Bearer | `{documentId,pageId,revision,shapes[]}` — ревизия и фигуры читаются в одной транзакции `REPEATABLE READ READ ONLY`, порядок `z, id` |
| `POST /api/documents/:docId/commands` | Bearer | тело `CommandRequest`; ответ `CommandResult`; повтор из журнала помечается заголовком `x-stand-replayed: 1` |
| `GET /api/operations/:opId` | Bearer | `{opId,status:'done',result}`; 404 если нет; чужая → 403 |
| `POST /api/zero/query` | Bearer | endpoint synced queries zero-cache: трансформация запросов `docMeta`, `docPages`, `shapesByPage`, `shapesByDocument` с проверкой владельца документа (`documents.owner_id = sub`), иначе `forbidden`/`not_found` (`src/zero/index.ts`, `src/zero/schema.ts`) |
| `POST /api/zero/mutate` (алиас `POST /api/zero/push`) | Bearer | push-endpoint custom mutators zero-cache: `PushProcessor` над `zeroPostgresJS(schema, sql)` (тот же пул postgres.js), мутаторы `setSourceFill`/`setLocalFill` вызывают общий `executeCommand` в транзакции — права, идемпотентность по `opId`, `expectedRevision`, `revision+1`, строка `operations` идентичны HTTP-пути; ошибки предметной области → `ApplicationError(code, details)` (`src/zero/mutators.ts`). Подробности — `docs/ZERO_SPIKE.md` §11.3 |
| `GET /*` | нет | статика клиента + SPA-fallback на `index.html` (кроме `/api/*`, `/zero/*`) |

Тело команды валидируется схемой: `opId` — строка `[A-Za-z0-9._:-]{1,128}` (UUID подходит), `type` ∈ {`setSourceFill`,`setLocalFill`},
`fill` — `#rrggbb` в нижнем регистре, `expectedRevision` — целое ≥ 0, лишние поля запрещены.

### Семантика команд (SPEC §1.1, §2.3)

* `setSourceFill` — target обязан быть источником (`is_source`), иначе 400. Меняется `fill` источника и всех
  экземпляров с `source_id = target` и `fill_overridden = false` на всех страницах. `affectedShapes` — число
  затронутых строк (источник + непереопределённые экземпляры, независимо от того, совпал ли цвет);
  `affectedPages` — уникальные страницы, отсортированы.
* `setLocalFill` — target: экземпляр или обычная фигура (источник → 400). `fill := fill`, `fill_overridden := true`
  (буквально по SPEC — и для обычной фигуры тоже). `affectedPages = [страница]`, `affectedShapes = 1`.
* Совпадение локального цвета с цветом источника переопределение не снимает.

### Тестовые хуки (`STAND_TEST_HOOKS=1`, заголовок `x-stand-test-secret`, не в измеряемом пути)

* `POST /api/test/delay {pathPattern, ms, count?, durationMs?, method?}` — задержка ответов, чей `request.url`
  совпал с регулярным выражением `pathPattern`. По умолчанию только `GET` (`method:'*'` — любые), действует
  `count` совпадений (по умолчанию 1) либо `durationMs`. Задержка выполняется в `onSend`: обработчик уже
  прочитал данные, ответ лишь доставляется позже — ровно сценарий «ответ старого чтения» (§6, п. 5).
  `GET /api/test/delay` — активные правила, `DELETE /api/test/delay` — снять все.
* `POST /api/test/reset {docId}` — восстановление `fill`/`fill_overridden` из `shapes_baseline`
  (снимок генератора, заполняется при `load`), `revision := 0`, удаление `operations` документа. Одна транзакция,
  обновляются только изменившиеся строки: ~90 мс для 25 000 фигур.
* `POST /api/test/clear-operations {docId?}` — очистка журнала операций.

## Предметный модуль (`src/domain/`, SPEC §2.3, §1.6)

```ts
interface DomainTx {
  readRevision(docId): Promise<{ownerId, revision} | null>;       // блокирует строку документа (FOR UPDATE)
  readShapeOwner(shapeId): Promise<{documentId, ownerId, pageId, isSource, sourceId} | null>;
  updateSourceAndInstances(sourceId, fill): Promise<{affectedPages, affectedShapes}>;
  updateShapeFill(shapeId, fill): Promise<{pageId}>;
  bumpRevision(docId): Promise<number>;
  readOperation(opId): Promise<StoredOperation | null>;
  writeOperation(op: StoredOperation): Promise<void>;
}
executeCommand(tx, userId, docId, cmd): Promise<{ result: CommandResult; replayed: boolean }>  // бросает DomainError
```

Порядок в `executeCommand`: права на документ (404/403) → права и семантика целевой фигуры (404/403/400) →
идемпотентность (`sha256` канонических параметров с `docId`; совпало → сохранённый результат, иначе `op_conflict`) →
`expectedRevision === revision` (иначе `revision_mismatch` с `currentRevision`) → изменение → `revision+1` →
`writeOperation`. Так как `readRevision` берёт `FOR UPDATE`, команды и их повторы по одному документу
сериализуются; параллельные команды с одной `expectedRevision` дают ровно один успех (проверено тестом).

### Ключ идемпотентности (§1.2; дефект B16)

`paramsHash` = `sha256` от `{docId, type, targetId, fill}`. **`expectedRevision` в ключ не входит**
(изменено 2026‑09‑13): это предусловие оптимистичной блокировки, а не часть логического смысла
операции. Семантика §1.2 («повтор с теми же параметрами возвращает ранее полученный результат,
повтор с иными параметрами отклоняется»):

| Случай | Результат |
|---|---|
| тот же `opId`, те же `docId/type/targetId/fill`, **любой** `expectedRevision` | 200 + сохранённый результат, `x-stand-replayed: 1`, второго изменения нет |
| тот же `opId`, иной `fill` / `targetId` / `type` / документ | 409 `op_conflict` |
| новый `opId`, `expectedRevision != revision` | 409 `revision_mismatch` + `currentRevision` |

Возврат сохранённого результата выполняется **до** проверки ревизии, поэтому честный повтор после
того, как ревизия ушла вперёд (ответ оборвался → `GET /api/operations/:opId` дал 404 → клиент
обновил метаданные → повторный POST), даёт 200, а не 409. Раньше `expectedRevision` входил в хеш и
такой повтор получал `op_conflict` — реализация была тоньше контракта.
Проверено: `test/domain.test.ts` (блок «идемпотентность», случаи B16) и `test/integration.test.ts`
(блок «идемпотентность по HTTP (B16)»). Путь Zero использует тот же `executeCommand`.

`PgDomainTx(sql)` — реализация над транзакцией postgres.js (`sql.begin(tx => executeCommand(new PgDomainTx(tx), …))`).
Тип `sql` структурный (любая tagged-template функция), поэтому Zero-мутатор может передать
`tx.dbTransaction.wrappedTransaction` из `zeroPostgresJS`. Экспорт: `@stand/server/domain`, `@stand/server/db`, `@stand/server`.

Очистка `operations` старше 24 ч — раз в 10 минут и при старте.

## Схема БД (`src/db/schema.sql`)

`users`, `documents(revision)`, `pages("index")`, `shapes` (индексы `page_id`, `source_id`, `document_id`), `operations`
(`created_at` индекс), `shapes_baseline(shape_id, document_id, fill, fill_overridden)` — снимок генератора для reset.
FK с `ON DELETE CASCADE` (перезагрузка документа генератором = `DELETE FROM documents`). Пароли — scrypt (`node:crypto`).

## Тесты

```bash
npm test -w packages/server            # оба набора
npm run test:unit -w packages/server   # domain на in-memory DomainTx: идемпотентность, конфликт, ревизия, переопределения
npm run test:integration -w packages/server   # реальная БД: поднимает приложение на случайном порту, свой документ doc-itest
```

## Проверка вручную

```bash
T=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"login":"alice","password":"alice-pass"}' | jq -r .token)
S=$(cat results/logs/.test-secret)                    # секрет хуков, генерируется scripts/lib.sh
curl -s localhost:3000/api/documents/doc-acc-50x500 -H "authorization: Bearer $T" | jq '.pages | length'
curl -s localhost:3000/api/documents/doc-acc-50x500/pages/doc-acc-50x500-p1 -H "authorization: Bearer $T" | jq '.shapes | length'
curl -s -D- -o /dev/null localhost:3000/api/documents/doc-acc-50x500 -H "authorization: Bearer $T" | grep -i cache-control   # no-store
curl -s -X POST localhost:3000/api/documents/doc-acc-50x500/commands -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"opId":"11111111-1111-4111-8111-111111111111","type":"setSourceFill","targetId":"doc-acc-50x500-src-1","fill":"#ff0000","expectedRevision":0}'
# повтор того же opId с уже сдвинувшейся ревизией → 200 и x-stand-replayed: 1 (B16), а не 409
curl -s -D- -X POST localhost:3000/api/documents/doc-acc-50x500/commands -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"opId":"11111111-1111-4111-8111-111111111111","type":"setSourceFill","targetId":"doc-acc-50x500-src-1","fill":"#ff0000","expectedRevision":1}' | head -3
curl -s -X POST localhost:3000/api/test/reset -H "x-stand-test-secret: $S" -H 'content-type: application/json' -d '{"docId":"doc-acc-50x500"}'
```
