# `server/document/expand.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Предел раскрытия экземпляров компонентов на стороне сервиса (SPEC §5.6, круг 39, долг N2). Маленький документ с цепочкой мастеров может раскрыться в W⁸ узлов и уронить решатель у каждого, кто откроет проект; сервис считает стоимость без раскрытия и не пускает такие документы/правки.

## Главное
- `EXPAND_LIMIT = 'expand_nodes'` — код в `detail.limit` и `dropped[].limit`.
- `expandMax()` — `core.MAX_EXPANDED_NODES` или null.
- `expandCostOf(doc)` — `core.expandCost`, иначе по `expandProblem`/`expandBudgetProblem` (0 — в пределе, cost или Infinity — нет); исключение движка → null («не знаю»).
- `expandOver(doc)` → `{cost, max, message}` | null; слова — движка, если он их даёт.
- `mayGrowExpand(ops)` — может ли транзакция увеличить раскрытие: `create`, `move`, `set` по `of|props|component|role`.
- `expandGrowthOver(before, after)` — сверх предела И больше, чем было (документ, уже бывший сверх, можно править и уменьшать).

## Поток данных
importer.js: импорт сверх предела → 400 `detail.limit:'expand_nodes'` (+ cost/max). dslts.js `mergeIntoHead`: если `mayGrowExpand` и `expandGrowthOver` — операции транзакции (кроме `remove`) уходят в `dropped` с `reason:'invalid'`, как у `doc_nodes`.

## Инварианты
- Транзакция целиком не отклоняется (слияние не отказывает, §8.3) — только операции в `dropped`.
- Движок без expandCost — предела нет (совместимость с прежними версиями движка).

## Подводные камни
- Предел (`MAX_EXPANDED_NODES` = 50 000) НЕ входит в отпечаток формата и не поднимает ENGINE_VERSION (решение PR #4, docs/08-предел-раскрытия.md).
- Дешёвая проверка `mayGrowExpand` стоит перед дорогой `expandCostOf` — не убирать, иначе каждая правка цвета считает раскрытие.

## Отладка
`node --test test/server/expand-legacy-r39.test.mjs test/server/round39.test.mjs`.

## Ссылки
- SPEC: §5.6, §9.17
- Тесты: `test/server/expand-legacy-r39.test.mjs`, `test/server/round39.test.mjs`
