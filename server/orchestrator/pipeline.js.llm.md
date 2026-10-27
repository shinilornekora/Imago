# `server/orchestrator/pipeline.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Конвейер одной команды агента (SPEC §8.2 шаги 3–13, §10): intent → DSLR (чтение) → DUIL (библиотеки) → LLM ↔ DSLV (прогон brain в воркере) → DSLTS (запись). Очередь на проект, стоп, режим вариантов и `apply`, здоровье, остановка.

## Главное (≈ строки)
- Экспорт: `RECOGNIZE_MAX` 2000, `EDITOR_COMMAND_TEXT`, `isEditorCommand(text)` (реплика — команда редактора из `src/shell.js`: ответ без модели и записи), `intentOf(text, ctx)` (≈109; `classifyUtterance`, `recognizeVariants`, местные ответы brain → `{kind, needsModel, intent}`), `globalizeIds(ops)` (≈155), `createPipeline(deps)` (≈198).
- Внутри `createPipeline`: `admit`/`runTask`/`next`/`unqueue` (очередь проекта, `MAX_QUEUE_PER_PROJECT` → 429), `preflight` (модель и сервис живы), `command` (≈346), `execute` (≈385 — сам прогон, стадии `step()`, трасса, `lease` семафора полного чтения), `brainError`, `finishRun`/`finishVariants`, `write` (≈717, транзакция с `author:'Агент'`, `command_author`), `resultOf`, `stop` (≈807), `apply` (≈847), `health` (≈912), `close` (≈938).
- `BRAIN_STAGE` — стадии brain → ключи §10.3 (`direct`→llm, `critic`→validate, `revise`→repair — круг 47); `LABELS` — подписи по-русски.

## Поток данных
http.js → `command` → очередь → `execute`: dslr.read → duil → dslv.run (вызовы модели воркер шлёт сюда, их исполняет llm) → dslts.write → `result` в sink; трасса в traces.js.

## Инварианты
- Команды агента одного проекта — по одной (модель рассуждает над стейтом, который вторая уже меняет, §8.3); ручные правки идут мимо очереди.
- Разрыв SSE команду не отменяет: она доводится до записи, клиент получит транзакцию по сокету Hub.
- «Стоп» — AbortSignal: снимает из очереди, прерывает модель и счёт; ушедшая запись доводится (повтор по tx_id).
- С круга 38 JEV нет: команды оболочки исполняет клиент, событие `shell` не шлётся.
- У записанной правки `title` есть всегда, `summary = title`, пересказ — в `plan` (круг 39).

## Подводные камни
- `command_id` в транзакции режется до 64 (`TX_COMMAND_ID_MAX`) — так хранит Document service.
- Варианты живут `VARIANTS_TTL_MS` и `MAX_VARIANT_SETS` в памяти — после рестарта агента `apply` даст 404.

## Отладка
`node --test test/orchestrator/orchestrator.test.mjs test/orchestrator/round38.test.mjs test/orchestrator/round39.test.mjs test/brain.test.mjs`; `queueOf(project)` — состояние очереди.

## Ссылки
- SPEC: §8.2, §8.3, §10.3, §10.5–§10.14, §13.5, §14.5
- Тесты: `test/orchestrator/orchestrator`, `llm`, `round38`, `round39`, `round47`; `test/brain.test.mjs`
