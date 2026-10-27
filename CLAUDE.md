# Imago Studio — подсказки агенту

Правила проекта — `.specify/memory/constitution.md` (Spec Kit); нормативная спецификация — `SPEC.md`;
запуск — `ЗАПУСК.md`; схемы — `docs/`.

## Перед правкой файла
- Прочитай заметку рядом с ним: `<файл>.llm.md` (или `README.llm.md` каталога) — назначение, карта
  разделов, инварианты, ловушки, какие тесты гонять.
- **Меняешь файл — обнови его заметку в том же коммите** (конституция, принцип VII). Шаблон —
  `.specify/templates/sidecar-template.md`. Проверка: `node tools/sidecars.mjs`, перед PR —
  `node tools/sidecars.mjs --changed origin/<база>`.

## Тесты
- `npm test`; с Postgres — `service postgresql start` и `TEST_DATABASE_URL=postgres://…/<своя_база>`
  (без базы pg-тесты пропускаются). Не используй базу `imago_rehearsal`.
- Смена формата документа → `ENGINE_VERSION` в `src/core.js` + строка в `FORMAT_HISTORY`
  (`test/core-r43.test.mjs` печатает её сам).

## Новый круг
`/speckit-specify` с номером круга → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`
(навыки в `.claude/skills/speckit-*`), черновики в `specs/`; итог — в раздел `SPEC.md`. См. `specs/README.md`.

## Нельзя
- Текст диплома — в репозиторий (он публичный).
- Сливать `handoff-from-cowork`; сливать PR без решения человека; переписывать историю чужих веток.
