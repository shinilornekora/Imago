# `server/document/storage/pg.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Адаптер хранилища PostgreSQL (SPEC §8.1 «База», §9.4, §9.8, §9.11; схема — `docs/06-схема-базы.mermaid`): пул с дедлайнами, LISTEN/NOTIFY, раннер миграций, защита от восстановления базы из старой копии. Шапка файла — нормативный перечень методов интерфейса хранилища (общий с memory.js).

## Главное (≈ строки)
- `createPgStorage(opts)` (≈344) → интерфейс: `init`, `close`, `kind`, `createProject`, `projectByCreateId`, `listProjects(Page)`, `getProject`, `renameProject`, `deleteEmptyProject`, `latestSnapshot(Meta)`, `snapshotBefore`, `snapshotSeqs`, `txsAfter`, `recentTxMeta`, `chainAt`, `commitTx` (≈1673; статусы committed / existing / stale / missing), `writeSnapshot`/`saveSnapshot`/`pruneSnapshots`, `findTx`, `knownEpoch`/`bumpEpoch`/`epochs`, `addTrace`/`listTraces`, `onNotify`, `publish`, `ping`, `schemaState`, `migrationState`, `checkRestore`, `recheckSchema`.
- Пределы тяжёлых чтений: `createLimiter` (≈183) — снимки (`snapshotReads`), журнал (`journalReads`), вместе `heavyReads` = max − 4; сверх — 503 busy `cause:'snapshot_reads'|'journal_reads'`. Чтение секвенсора (`internal:true`) — мимо пределов.
- Слушатель: `connectListener` (≈431), одно соединение, запросы по одному (`createSerial`), пинг; после переподключения — `{k:'resync'}`.
- Миграции: `migrate` (≈569) — отдельное соединение без дедлайна, advisory-lock опросом, каждая миграция в своей транзакции, `.mjs` режут работу на пачки и сообщают прогресс; DDL с `lock_timeout` 1 с и повтором; долгие дозаполнения (`ddlUp` + `fillUp`) — после DDL, фоном (круг 33). `MIGRATION_RE = /^\d{3,}_[\w.-]+\.(sql|mjs)$/`.
- Восстановление из копии: `refreshFlags`, `restoreGuard`, `reschema`, `checkSchema`, `withSchema`, `enterWaiting` → `schemaState` и ошибка `IMAGO_SCHEMA_WAIT` (errors.js → 503 cause schema).

## Инварианты
- `pg_notify` о записи и о смене эпохи — В ТОЙ ЖЕ транзакции базы: уведомление уходит ровно тогда, когда запись видна.
- Соединение с истёкшим query_timeout или оборванное в пул не возвращается (`release(err)`).
- Все запросы параметризованы; JSON в jsonb — строкой (`JSON.stringify`): node-pg превращает массив-параметр в литерал массива Postgres.
- bigint → число только для этого пула (свой type parser), глобальный не трогать.
- Схема годится для смешанных версий (§9.11): старый экземпляр, пишущий без chain, работает во время и после миграций.

## Подводные камни
- Сайдкары и прочие файлы в `migrations/` не должны попадать под `MIGRATION_RE`: `001_init.sql.llm.md` — не попадает (кончается на .md), а вот имя на `.sql`/`.mjs` стало бы миграцией.
- Присутствие идёт через соединение слушателя, не через пул — поток выделений не отнимает соединения у записи; очередь длиннее PUBLISH_QUEUE — сообщение теряется (так задумано).
- Триггеры схемы ставятся последними при pg_dump: миграция учтена, а триггера нет → схема неполна (`restore`).

## Отладка
`service postgresql start`; `node --test test/server/migrations.test.mjs test/server/round30.test.mjs test/server/round32.test.mjs test/server/presence.test.mjs`. Для тестов — своё имя базы (не `imago_rehearsal`, её держит поток диплома).

## Ссылки
- SPEC: §8.1, §9.4, §9.8, §9.9, §9.11, §9.14–§9.17; docs/06-схема-базы.mermaid
- Тесты: `test/server/migrations`, `presence`, `round29`, `round30`, `round32`, `round33`, `round39`, `helpers.mjs`
