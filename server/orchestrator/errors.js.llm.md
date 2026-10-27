# `server/orchestrator/errors.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Ошибка Orchestrator (SPEC §10.2): одна форма для HTTP-ответа и SSE-события `error` — `{error:true, code, message, retryable, detail?}`; сообщения человеку — по-русски, здесь же.

## Главное
- `class OrchError(status, code, message, {retryable, detail, retryAfter})`; `toOrchError(e)` — всё прочее → `internal` 500 (исключение кода агента, не модели).
- Конструкторы: `badRequest`, `notFound`, `documentDown`, `documentBusy`, `agentReadBusy`, `documentEngine` (426/503 по версии движка, круги 41/43), `agentBusy`, `llmDown`, `llmUnconfigured`, `cancelled` (499, только SSE), `shuttingDown`.
- `safeDetail(detail)` — белый список полей `detail` наружу: коды `hint, cause, queue, limit, document_reason, server`, целые `engine, found, max` (круг 43).

## Коды
bad_request 400 · not_found 404 · 405 · timeout 408/504 · too_large 413 · not_applied 422 · busy 429/503 · llm_failed / llm_bad_response / document_failed 502 · llm_down / document_down / shutting_down 503 · worker_failed / internal 500 · engine 426 · cancelled.

## Подводные камни
`detail.hint:'name_layer'` у not_applied — оболочка по нему даёт совет (круг 31); новые подсказки добавляй и в `safeDetail`, иначе они не дойдут.

## Ссылки
- SPEC: §10.2, §10.10, §10.13, §10.14
- Тесты: `test/orchestrator/round26`, `round39`, `round41`, `round43`
