# `server/document/engine.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Версия формата движка, с которой работает экземпляр Document service, и проверка «прочтёт ли он то, что записано» (SPEC §8.3, круг 39). Сам движок — `src/core.js`; здесь только числа и ошибки вокруг `core.ENGINE_VERSION` / `core.ENGINE_MIN_READ`.

## Главное
- `CODE_ENGINE` — `core.ENGINE_VERSION` (или 1, если поля нет); `ENGINE_MIN_READ` — нижняя читаемая версия, не выше CODE_ENGINE.
- `resolveEngine(opt, env, log)` — версия экземпляра: опция `engine` или `IMAGO_ENGINE`; можно только ПОНИЗИТЬ (стенды смешанных версий), негодное значение → предупреждение и CODE_ENGINE.
- `engineUnreadable(found, engine)` — запись/снимок новее экземпляра или старше ENGINE_MIN_READ. Не целое (хранилище прежней версии) — читается.
- `engineError(found, engine)` — 503 `unavailable`, `detail:{cause:'engine', engine, found}`, Retry-After `ENGINE_RETRY_S` (30 с).
- `OUTDATED_RECHECK_MS` (10 с) — как часто «устаревший» проект перепроверяется (используется в dslts.js).

## Поток данных
Импортируется dslr.js (чтение), dslts.js (голова, снимки), index.js (`resolveEngine` при запуске). Клиент с версией ≠ версии экземпляра получает 426 в `validateTx` (dslts.js), не здесь.

## Инварианты
- Экземпляр никогда не работает с версией выше движка кода: принял бы формат, которого не знает, и записал бы его снимком.
- Голова, где не применилась запись своей/неизвестной версии, снимков не пишет (dslts.js); база сама отвергает снимок движка старше записей под ним (миграция 014).

## Подводные камни
- Подъём `ENGINE_VERSION` в core.js — смена формата: нужна строка в FORMAT_HISTORY (test/core-r43) и, возможно, миграция; см. конституцию, принцип II.
- «Наследная» запись (движок строго ниже своего) пропускается всеми одинаково (круг 41/45) — это не признак поломки.

## Отладка
`node --test test/server/round39.test.mjs test/server/round41.test.mjs test/server/round45.test.mjs`; стенд смешанных версий — `IMAGO_ENGINE=2 node server/document/index.js`.

## Ссылки
- SPEC: §8.3, §9.17 (круг 39), §9.18 (круг 41), §9.20 (круг 45)
- Тесты: `test/server/round39.test.mjs`, `round41.test.mjs`, `round45.test.mjs`, `expand-legacy-r39.test.mjs`; `test/smoke-r45.test.mjs`
