# `server/orchestrator/limits.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Пределы и умолчания Orchestrator. Настраиваемое читается из окружения в index.js; здесь — значения по умолчанию и потолки формы запроса.

## Главное (группы)
- Запрос: `MAX_BODY_BYTES` 1 МБ, `BODY_TIMEOUT_MS`, `HEADERS/REQUEST_TIMEOUT_MS`, `MAX_TEXT` 5000, `MAX_ID`, `MAX_SELECTION`, `MAX_HISTORY(_CHARS)`, `MAX_AUTHOR`, `MAX_VARIANTS`.
- Очередь и варианты: `MAX_QUEUE_PER_PROJECT` 4, `VARIANTS_TTL_MS`, `MAX_VARIANT_SETS`.
- Связь с Document service: `DOC_TIMEOUT_MS`, `DOC_HEALTH_*`, `LOOP_LAG_*` (опоздавший таймер своего цикла — не «сервис недоступен», круг 39), `DOC_RETRY_AFTER_MAX_S`, `WRITE_*`, `DOC_MAX_OPS_PER_TX` / `DOC_MAX_BODY_BYTES` (копии пределов сервиса §9.8), `DOC_PAGE_LIMIT`.
- DSLR: `DSLR_FULL_*` (семафор полных чтений по числу и байтам), `DSLR_READ_*`, `DSLR_QUEUE_WAIT_MS`, `DSLR_MAX_PAGES`, `DSLR_CACHE_PROJECTS`, `DSLR_SIZE_MEMO`.
- Модель и воркеры: `LLM_HEALTH_*`, `WORKER_MAX_OLD_MB`, `WORKER_TIMEOUT_MS`, `WORKER_JOBS_MAX`, `POOL_QUEUE_*`.
- Прочее: библиотеки (`MAX_LIBRARIES`, `PROJECT_LIST_*`), трассы (`TRACE_RING`), SSE (`SSE_PING_MS`), остановка (`SHUTDOWN_*`), снимок доски (`RENDER_*`, `FONT_CACHE_FAMILIES`).

## Инварианты
`DOC_MAX_*` обязаны совпадать с `server/document/limits.js` — иначе агент отправит транзакцию, которую сервис отвергнет 413.

## Ссылки
- SPEC: §9.8, §10.2, §10.8, §10.12
- Тесты: `test/orchestrator/dslr`, `dslts`, `round25`, `round31`, `round33`; `test/deploy.test.mjs`
