# `server/orchestrator/dslv/worker.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Тело воркера DSLV: весь прогон brain (`runCommand` / `runVariants`) вне главного потока — раскладка и проверка идут внутри runCommand между вызовами модели, поэтому в воркере живёт весь прогон.

## Протокол
- главный → воркер: `{type:'run', id, job}` · `{type:'abort', id}` · `{type:'llm-reply', callId, ok, data|error, usage}`
- воркер → главный: `{type:'stage', id, rec}` · `{type:'llm', id, callId, messages, schema, opts}` · `{type:'done', id, result}` · `{type:'ready'}`

## Главное
- `proxyProvider(id, vision)` — провайдер brain, который не зовёт модель сам, а шлёт `llm`-сообщение и ждёт `llm-reply` (ключ не покидает главный поток).
- `run(id, job)` (≈120) — прогон; `guardExpand` — результат сверх предела раскрытия (`expandOverflow`) не уходит; `slim` — ужатый результат для передачи.
- `renderFor(id)` — снимок доски для критика (render.js `createRenderer`), `createImageColors` — цвета картинок.
- `testHooks` (только в тестах): `oom`, `env`, `throw`, `heap`, медленный старт.

- Круг 110 (SPEC §25.3): стадия несёт `progress` и (на плане сценария) `steps` — ход длинной задачи.

## Инварианты
Исключение кода (не модели) → `internal`, а `BrainError('model', …)` → текст до клиента как есть (круг 31).

## Отладка
Через пул: `node --test test/orchestrator/dslv.test.mjs test/orchestrator/round29.test.mjs`.

## Ссылки
- SPEC: §10.1, §14, §14.3, §14.4, §20
