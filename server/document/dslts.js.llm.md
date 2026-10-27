# `server/document/dslts.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
DSLTS — DSL Transaction Sequencer (SPEC §8.1, §9.4, §9.8): единственный писатель журнала. Держит в памяти голову каждого открытого проекта, сливает транзакцию поверх головы тем же `core.rebase`, что и клиент, нумерует через базу, отдаёт `Committed` в Hub, раз в N транзакций пишет снимок. Самый «опасный» серверный файл: здесь живут гонки экземпляров и откаты.

## Главное (≈ строки)
- `validateTx(raw, ctx, engine)` (≈118) — форма транзакции и операций (`opShapeError`): типы полей, чистые id (§9.10), `OP_KINDS` create/remove/set/move/setToken, `AUTHOR_KINDS` human/agent/system, версия движка → 426.
- `mergeIntoHead(head, tx, lim)` (≈277) — чистое слияние: заранее отброшенные `stale` → `rebase` с бюджетом времени `MERGE_BUDGET_MS` → пределы документа (узлы счётом, байты точно через `docBytesDelta`) → предел раскрытия (expand.js). Всё отброшенное — в `dropped` с `reason`/`limit`.
- Надгробия: `readTombstones`, `tombstonesOf`, `flatTombstones`, `tombstonesV2` — id удалённого узла → последний родитель (+ seq).
- `createSequencer({...})` (≈500) → API: `commit(id, raw, ctx)`, `attach/attachFast` (сокет подключается без мьютекса записи), `peek`, `headOf`, `clientEvidence`, `projectChanged`, `deleteEmpty`, `unload`, `verify`, `flush`, `close`, `stats/queueStats/attachStats`, `outdatedOf/isHoley/legacySkipsOf`, `subscribe`, `setWatcher`.
- Внутри фабрики: `withLock` (мьютекс проекта с очередью по байтам → 503 busy), `ensureHead` (загрузка: снимок + хвост, `absorbPage`), `syncHead`/`rollback`/`onEpochNotice`/`verifyAll` (сверка с базой), `commitQueued` (≈1088, путь записи), `staleOps` (переигрывание после отката не затирает более новое чужое), `scheduleSnapshot`, `pruneTombs`, `trimHeads` (выгрузка по `HEADS_BYTES`), `goOutdated` (проект записан движком новее).

## Поток данных
http.js `POST …/tx` и hub.js (tx по сокету) → `commit` → `commitQueued` под `withLock` → `mergeIntoHead` → `storage.append` (+ NOTIFY в той же транзакции базы) → событие подписчикам (Hub) → снимок раз в `SNAPSHOT_EVERY`. Другие экземпляры по NOTIFY дочитывают хвост (`syncHead`).

## Инварианты
- Слияние не отказывает (§8.3): транзакция целиком не отклоняется никогда; отказ только у формы (400), размера (413), версии (426).
- Голова = `{doc, head_seq, chain, epoch, tombstones, recent}`; `chain = sha256(prev + tx_id + seq)`.
- Сверка головы с базой: база впереди и цепочка продолжается → дочитать; база позади или цепочка другая → откат: смена эпохи (compare-and-set, один раз), голова выбрасывается, Hub закрывает сокеты 4410.
- Повтор `tx_id` → тот же Committed (идемпотентность через `recent` и `knownTx`).
- `base_seq` клиента дальше головы → сначала `syncHead`; база всё ещё позади → зажим base_seq, не отказ.
- Голова, где не применилась запись своей/неизвестной версии движка, снимков не пишет («дырявая» голова, `isHoley`).

## Подводные камни
- `MAX_RETRIES` 12 + случайная пауза: гонка двух экземпляров за одну голову; трёх попыток на всплеске не хватало.
- Мусор в несуществующий проект — 404, а не 400; проект проверяется только на пути отказа (экономия запроса).
- После `close()` очередь мьютекса может дождаться — голову не загружаем, 503.
- Движок круга 39 сам проверяет предел раскрытия в rebase/applyOps; тогда сервис не пересчитывает (`ENGINE_GUARDS_EXPAND`).

## Отладка
`node --test test/server/tombstones.test.mjs test/server/coldload.test.mjs test/server/round30.test.mjs test/server/rollback.test.mjs`; многоэкземплярные сценарии — с Postgres (`service postgresql start`, DATABASE_URL), `test/server/round29/round31`.

## Ссылки
- SPEC: §8.1, §8.3, §9.1, §9.4, §9.6, §9.7, §9.8, §9.10 (и «Круг N» подразделы §9.9–§9.20)
- Тесты: `test/server/backpressure`, `coldload`, `expand-legacy-r39`, `hardening`, `round27…round39`, `strings`, `tombstones`, `test/sync-r29`
