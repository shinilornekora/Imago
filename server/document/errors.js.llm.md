# `server/document/errors.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Единое тело ошибки Document service для HTTP и сокета (SPEC §9.8): `{error:true, code, message, retryable, detail?}` (+ Retry-After). Плюс превращение сбоев хранилища в ответы.

## Главное
- `class DocError(status, code, message, {retryable, detail, retryAfter, compat})` — всё, что не DocError, транспорт считает сбоем → 500 `internal` + лог.
- Конструкторы: `badRequest` 400, `notFound` 404, `tooLarge` 413, `unavailable` 503, `busy` 503, `migrating` 503 (§9.11), `internalBody()`.
- `viaStorage(promise)` — сбой хранилища → 503 `unavailable` с `detail.cause`: `timeout` (57014/«timeout»), `schema` (42703/42P01 или IMAGO_SCHEMA_WAIT — база пуста/восстанавливается), `storage`; SQLSTATE 22xxx → 400 `cause:'data'`. Причина — в лог одной строкой (`logOnce` гасит повторы).
- `noSnapshot(storage)` — «у проекта нет снимка»: при несогласованной схеме — `cause:'schema'`.
- `setStorageLog(log)`, `isDataError(e)`.

## Коды
bad_request 400 · forbidden 403 · not_found 404 · method_not_allowed 405 · conflict 409 · gone 410 · too_large 413 · engine 426 · internal 500 · unavailable / busy / migrating 503.

## Инварианты
`compat`-поля (`engine` у 426, `snapshot`/`head_seq` у 410, `tx_id`) остаются на верхнем уровне тела — их читают прежние клиенты.

## Подводные камни
Чужие значения в текст ошибки — только через `showValue` (limits.js), не сырыми (круг 29).

## Отладка
`node --test test/server/storage.test.mjs`; коды ответов проверяют почти все `test/server/*` (через HTTP).

## Ссылки
- SPEC: §9.2, §9.8, §9.11
- Тесты: `test/server/storage.test.mjs` (прямой импорт), косвенно — весь `test/server/`
