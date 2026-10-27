# `src/agent.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Клиент Orchestrator в оболочке (SPEC §10, стрелки 3 и 7b): `POST /agent/command` и разбор потока SSE вручную из `fetch` + `ReadableStream` (EventSource не умеет POST). Без DOM — работает в node так же, как в браузере.

## Главное
- `runServerCommand(p)` (≈419) — команда целиком: события `queued/stage/variants/result/error/done` (+ `shell` от сервера прежней версии) → исход.
- `createAgentClient(defaults)` (≈595) — обёртка с настройками оболочки.
- `health(opts)`, `stop(commandId, opts)`, `apply(commandId, variant, opts)`.
- `createSSEParser(onEvent)`, `readError(res, {accepted})`, `parseRetryAfter`, `engineCause` (426: client_old/server_old), `isUpstreamDown` (ошибка nginx за упавший апстрим, `X-Imago-Upstream`), `newCommandId`.
- `AgentError` (`code`, `accepted`, `retryAfterMs`…), `AGENT_EVENTS`, `STAGE_KEYS`, `stageKey` (`jev` прежнего сервера → `intent`), `DOCUMENT_REASONS`.

## Инварианты (§10.3)
- Разрыв потока — не провал: исход `detached`, транзакция придёт по сокету Hub; оболочка ничего не применяет сама.
- Команда, которую сервер НЕ принял (`accepted:false`), безопасно выполнить в браузере; принятую — нельзя (двойная правка).
- `429`/`503` с коротким `Retry-After` (≤ `RETRY_WAIT_MAX_MS`) повторяются сами; длинная пауза — в ошибку, решает оболочка.
- «Стоп» — `POST /agent/stop` и `code:'cancelled'`. Клиент шлёт свою `ENGINE_VERSION` (круг 41).

## Отладка
`node --test test/agent.test.mjs`.

## Ссылки
- SPEC: §9.7, §10.2, §10.3, §10.5, §13
- Тесты: `test/agent.test.mjs`, `test/orchestrator/round26.test.mjs`, `test/shell-r38/r41/r43`
