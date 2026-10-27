# `server/document/storage/committed.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Общая для адаптеров pg и памяти форма записи журнала `Committed` (SPEC §9.1), якорь цепочки и выжимка `dropped` (§9.8). Всё здесь обязано совпадать у адаптеров байт в байт — тесты сравнивают их deepEqual.

## Главное
- `chainNext(prev, txId, seq)` — sha256(prev + tx_id + seq); `newEpoch()` — случайная эпоха.
- `toCommitted(row)` — строка базы → Committed; пустые необязательные поля (`OPTIONAL`: undo_of, redo_of, author, client, title, command_id, command_author) не отдаются вовсе; подписи (`META_FIELDS`) чистятся и при чтении старых записей.
- `txColumns(tx)` — транзакция → колонки записи; `jsonBytes(v)` — байты JSON.
- `compactDropped(list)` / `droppedCount` — выжимка отброшенных операций (`DROPPED_KEEP`, `DROPPED_OP_BYTES`, превью).
- Надгробия: `tombstonesObject`, `splitTombstones` / `joinTombstones` (раскладка по колонкам migrations/007: parents, meta, metaChain).
- `pgRejects({json, text})` — заранее найти строки, которые jsonb не примет (одиночные суррогаты, U+0000).
- `codePointSlice(s, n)` — обрезка, не рвущая суррогатную пару (иначе 22P02 и падение всей записи).
- `projectSummary(p)`, `headSummary(p)` — краткие формы проекта для ответов/hello.

## Инварианты
`undo_of: null` и отсутствие `undo_of` — одно и то же для клиента; не начинать отдавать null-поля.

## Отладка
`node --test test/server/storage.test.mjs test/server/coldload.test.mjs test/server/migrations.test.mjs`.

## Ссылки
- SPEC: §9.1, §9.2, §9.3, §9.8, §9.11
- Тесты: `test/server/storage`, `coldload`, `hardening`, `migrations`
