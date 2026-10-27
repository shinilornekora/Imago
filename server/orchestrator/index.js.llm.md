# `server/orchestrator/index.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Вход Orchestrator — второго процесса системы, «агента» (SPEC §8.1, §10): `node server/orchestrator/index.js` / `npm run orchestrator`. Читает окружение (полный список — в шапке файла: PORT, DOCUMENT_URL, INTERNAL_TOKEN, LLM_*, WORKERS, WORKER_*, QUEUE_MAX, POOL_QUEUE_*, LLM_VISION, AGENT_DIRECTION и др.), собирает модули и ставит остановку по SIGTERM/SIGINT.

## Главное
- `start(opts)` (≈77): `createLlm` → лог через `llm.redact` (ключ модели не попадает и в лог) → `createDocClient` → `createDslrClient`, `createDsltsClient`, `createDuil`, `createDslv`, `createTraces` → `createPipeline` → `createRequestHandler` → `http.createServer` с `applyServerTimeouts`. Возвращает сервер, порт, pipeline, close.
- Остановка: `SHUTDOWN_GRACE_MS` / `SHUTDOWN_FLUSH_MS` / `SHUTDOWN_HARD_MS` — дождаться команд, дослать трассы, жёсткий выход.
- `launchedDirectly()` — запуск как программы.

## Инварианты
- К базе агент не прикасается: читает и пишет только через Document service (README каталога).
- Без LLM_BASE_URL модель «не подключена» — команды оболочки (клиент) работают, команды модели — 503 `llm_down`.

## Подводные камни
Флаги окружения `flag()`: пусто — «по умолчанию провайдера» (например, LLM_VISION у anthropic — да, у openai — нет), а не false.

## Отладка
`DOCUMENT_URL=http://127.0.0.1:8080 LLM_BASE_URL=http://127.0.0.1:1234/v1 npm run orchestrator`; `curl localhost:8090/agent/health`. Тесты: `test/orchestrator/process.test.mjs`, `orchestrator.test.mjs`, `round25.test.mjs`.

## Ссылки
- SPEC: §8.1, §10, §14 (AGENT_DIRECTION, критик)
- Тесты: `test/orchestrator/process`, `dslv`, `round25`, `helpers.mjs`; `test/deploy.test.mjs`
