# `server/document/index.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Вход Document service (SPEC §8.1: DSLR + DSLTS + Hub в одном процессе): `node server/document/index.js`. Читает окружение, выбирает хранилище, открывает порт сразу (до готовности — 503 migrating), гоняет миграции, собирает модули, ставит защиту от падений. Полный список переменных окружения — в шапке файла.

## Главное
- `ENV_LIMITS` — переменная окружения → [ключ, по умолчанию, минимум]; `limitsFrom(opts, env, log)` — опция → env → по умолчанию (негодное — предупреждение и default).
- `start(opts)` — `launch` + ожидание `ready`.
- `launch(opts)` (≈205): storage = опция | `createPgStorage(DATABASE_URL)` | `createMemoryStorage()` (с предупреждением) → `server.listen` → до готовности всё (и upgrade) получает 503 `migrating` с `{phase, migration, progress}` → `ready`: миграции, `createReader`, `createSequencer`, `createHub`, `createImportPool`, `createRequestHandler` → `state='ready'`. `close({closeStorage})` — hub, сервер, импорт, dslts, хранилище.
- `installCrashGuard({log, onFatal, isReady, stormMax, stormWindowMs})` — неперехваченные исключения: `FATAL_CODES` (EADDRINUSE, ENOMEM, …) — выход; шторм ошибок — выход; прочее — лог.
- `isMain` — запуск как программы.

## Поток данных
Окружение → config → модули. Версия движка — `resolveEngine` (engine.js), id экземпляра `doc_<hex>`.

## Инварианты
- Без DATABASE_URL данные живут до перезапуска — для тестов и демо, не для продакшена.
- Порт открыт раньше готовности: health-check nginx/compose видит 503 migrating, а не отказ соединения.

## Подводные камни
Тесты запускают сервис через `start({port:0, storage, …})`; новые опции добавляй и в `limitsFrom`, и в test/server/config.test.mjs.

## Отладка
`DATABASE_URL=postgres://… PORT=8080 node server/document/index.js`; тесты: `test/server/config.test.mjs`, `document.test.mjs`, `migrations.test.mjs`, `resilience.test.mjs` (Postgres: `service postgresql start`).

## Ссылки
- SPEC: §8.1, §9.9, §9.11
- Тесты: почти весь `test/server/`, `test/orchestrator/helpers.mjs`, `test/deploy.test.mjs`
