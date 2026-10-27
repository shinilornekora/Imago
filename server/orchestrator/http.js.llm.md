# `server/orchestrator/http.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
HTTP-транспорт агента (SPEC §10.2) и поток событий команды SSE (§10.3) на node:http.

## Главное
- Маршруты (`ROUTES`): `GET /agent/health`, `POST /agent/command` (SSE), `POST /agent/stop`, `POST /agent/apply`.
- `parseCommand(body, {testHooks})` (≈118) — форма команды: `command_id`, `project`, `text` (≤ MAX_TEXT), `selection`, `selection_by`, `board`, `base_seq`, `client`, `author`, `mode` run|variants, `n`, `history`, `engine`, переключатели арт-направления (§17.2: `art` только false).
- `checkClientEngine(req, body)` (≈221) — `engine` тела или `X-Engine` ≠ версии агента → 426, `detail.cause:'client_old'|'server_old'` (круг 41).
- `openSse` — заголовки потока, пинг `SSE_PING_MS`; `readBody`/`readJSON` — 1 МБ (413), 30 с (408).
- `createRequestHandler({pipeline, redact, log, testHooks, bodyTimeoutMs})`; `applyServerTimeouts`.

## Поток данных
Клиент `src/agent.js` → здесь → `pipeline.command(cmd, openSink)` → события `queued/stage/variants/result/error/done` в SSE.

## Инварианты
- Ошибка до старта потока — JSON с кодом; после — событие `error`, последним всегда `done {}`.
- stop/apply сверяют `client` с тем, что пришёл с командой: чужая команда неотличима от неизвестной (`{stopped:false}` / 404, круг 33).
- Всё, что уходит наружу, — через `redact`.

## Отладка
`curl -N -X POST localhost:8090/agent/command -H 'content-type: application/json' -d '{"command_id":"c1","project":"<id>","text":"…"}'`; тесты `test/orchestrator/round27.test.mjs`, `round50.test.mjs`, `contract.test.mjs`.

## Ссылки
- SPEC: §10.2, §10.3, §10.8, §10.11, §10.13, §17.2
- Тесты: `test/orchestrator/round27`, `round50`, `contract`
