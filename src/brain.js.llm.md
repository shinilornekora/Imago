# `src/brain.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
«Мозг» Imago (≈16 тыс. строк): провайдеры моделей, схемы ответов, промпты, распознавание реплик без модели, контекст документа для промптов, материализация ответа модели в операции `core.ops`, конвейер команды (план → генерация → материализация → проверка → починка), варианты, живой дизайн (арт-директор, критик, образец). Без DOM и без мутаций; движок `core.js` подключается лениво (`loadEngine`) и подменяется в тестах (`runCommand({engine})`). Работает и в браузере, и в воркере Orchestrator (`server/orchestrator/dslv/worker.js`). Шапка файла — расширенный контракт §1.6 по кругам; читать её, когда непонятно поле результата.

## Контракт (SPEC §1.6)
- `makeProvider(cfg) → {name, kind, ready(), complete(messages, schema, opts)}`
- `runCommand({doc, selection, utterance, provider, onStage, signal, engine?, persona?, plan?, history?, geo?, activeArtboardId?, selectionBy?, library?, direction?/critic?/render?/imageColors?/…})` → `{ops, preview:{doc,geo}, plan, answer?, clarify?, cannot?, action?, warnings, usage, stages, art?…}` | `{error:{kind,message}}`
- `runVariants({..., n})` → `[{key, label, description, ops, preview, plan, warnings, error?}]`
- `SCHEMAS`: plan, tree, patch, theme, answer, illustration, direction, critique. `PROMPTS`: planner, tree, patch, theme, answer, illustration, repair, direction, critic, revise.

## Карта файла (разделы помечены рамками `/* ──── N. … */`, ≈ строки)
| Раздел | Строки | Что там |
|---|---|---|
| 0. Движок | 72 | `ENGINE_MEMBERS`, `loadEngine` |
| 1. Ошибки | 104 | `BrainError(kind, message)`, `MODEL_REJECTED`, потолки ответа модели (круг 31: `MODEL_BODY_MAX_BYTES`, глубина, число значений), `readBodyCapped`, `toErrorInfo`, `INTERNAL_MESSAGE`, `isInternalError` |
| 2. Разбор ответа | 443 | `extractJson` (`<think>`, ограждения, первый сбалансированный объект), `parseModelJson` |
| 3. Схемы | 514 | пределы дерева (`MAX_TREE_*`), `cutText`/`cleanText`, `TOKEN_PATH_RE`, **`SCHEMAS`** (≈1046; тема — `board`, `likeBoard` круг 71), `downgradeSchema` |
| 4. Провайдеры | 1509 | `makeProvider` (≈1513): Claude-артефакт (`claude.use("sample")`) и LM Studio / OpenAI-совместимый (≈1701), `raceAbort`, повторы и бюджет |
| 5. Промпты | 1975 | `formatSchemaInstruction`, **`PROMPTS`** (≈2069), `PERSONAS`, `variantInstruction` |
| 6. Классификация | 2561 | `RE_IMAGE_REF` (образец, круг 55), `looksIllustration`, `recognizeUndoDoubt`, `recognizeAction` (отмена/возврат без модели), `recognizeVariants`, `recognizeComponentIntent`, `classifyUtterance` (вид работы → промпт) |
| 7. Контекст документа | 3291 | `resolveScope`, `describeTokens` |
| 6a. Компоненты | 3569 | `describeLibrary` — библиотека как словарь агента (§5) |
| 6b. Шкалы | 3813 | ссылки на шаги шкал (§6) |
| 6c. Микроанимации | 4161 | `STATE_*`, `MOTION_*`, `normalizeMotionPath`, `recognizeMotionClear` (§11) |
| 6b'. Иллюстрации | 5015 | `ART_LIMITS`, `parseArtPath`/`formatArtPath` (зеркало `core.parsePath`), тона и узоры, `compileIllustration` (спецификация → свободная рамка с векторами), `mergeIllustration`, правка иллюстраций (§12) |
| Выжимка документа | ≈6540 | `DIGEST_LIMIT`, легенды, **`describeDoc`** (≈6816), `describeHistory` |
| 8. Материализация | 7157 | `parsePx`, `colorFromWord`, `normalizeTree`, **`treeToOps`** (≈8143), разрешение целей (`resolveRef(s)`, ≈8177–8700), пути (`normalizePath`, `adjustSetPath`, `ALLOWED_PATH_HEADS`), `coerceValue`, `sameAsNow`, **`patchToOps`** (≈10116), **`themeToOps`** (≈10795; тема доски по путям — круг 69, копия с другого экрана `likeBoard` — круг 71; несколько экранов — `boardThemeOps` → `oneBoardThemeOps` на каждый, `boardNames`/выделение, круг 72; «все, кроме» — `exceptBoards`, круг 74: не найденное исключение — отказ; имена по словам и падежам — `boardsByName`, «все экраны оплаты» — `boardGroup`, круг 75) |
| 7a. Названия по-русски | 9148 | `PATH_RU`, `ruPath`, `ruToken`, `ruEnum`; зеркала `core.keepFieldForm` (≈9560, ≈9620) |
| 9. Конвейер | 11171 | `warningRank`, `CALL_TIMEOUT_MS`, `overflowWords`, `describeViolations`; внешняя библиотека DUIL (≈11702: `libraryDocOf`, `externalLibraryPlan`, `withExternalLibrary`) |
| 13. Живой дизайн | 11979 | арт-направление (`normalizeDirection`, `directionBrief`, `readDirection` §17.1, `directionTheme`, `applyDirection`), критик (`templateSignals`, `normalizeCritique`, `visionRefusal`, `imageTurn`, `recheckVerdict` — второй взгляд §19), образец (`referenceImage` §22, снимок мудборда `MOODBOARD_SHOT_*` §22.1–§22.2), цвета картинок (`IMAGE_COLORS_MS` §20) |
| Вход | 12951 | **`runCommand`** → `runCommandCore` (≈12972), `runVariants` → `runVariantsCore` (≈15813) |
| Куда вставлять | ≈14005 | `asksNewScreen`, `stemRu`, `mentionsExistingLayer`, `findInsertTarget` («добавь X в Y») |
| 9a. Палитра | 14758 | починка негодной палитры; `expandOverflow` (≈14949, предел раскрытия) |
| Итог | ≈15231 | `checkOutcome` (итог против просьбы), `describeChange` (что сделано словами → `title`) |
| 10. Варианты | 15792 | `runVariantsCore` |

## Поток данных одной команды
`classifyUtterance`/`recognize*` (без модели: отмена, варианты, переспрос) → план (`PROMPTS.planner`, `SCHEMAS.plan`) → [арт-направление `direction`, круг 47] → генерация (`tree` | `patch` | `theme` | `illustration` | `answer`) → материализация (`treeToOps` / `patchToOps` / `themeToOps`) → `core.applyOps` на копии + `solve` + `validate` → починка (`repair`, ≤ 1) → [критик `critique` со снимком доски `render`, доработка `revise`, второй взгляд] → `checkOutcome` / `describeChange` → результат. Стадии — через `onStage` (plan, generate, retry, variant, materialize, validate, repair, direct, critic, revise; Orchestrator сводит их к ключам §10.3).

## Инварианты
- Входной `doc` не мутируется; `ops` — обычные операции ядра, id новых узлов — `core.uid`.
- `clarify` и `cannot` — ответ агента, не ошибка: `error` нет, `ops` пуст (или `cannot` рядом с выполнимой частью).
- `geometryUnchanged` — только доказуемо невидимое, без догадок.
- Строки результата чистятся (`cleanResult`, круг 25) — пригодны к записи в журнал.
- Зеркала ядра (`parseArtPath` ↔ `core.parsePath`, `keepFieldForm`) должны совпадать с core.js: поменял там — поменяй здесь.

## Подводные камни
- Модель без зрения картинок не видит: для образца и цветов — строка цветов (`swatches.js`); критик без зрения не зовётся вовсе (§14.3), это не баг.
- Новая схема/поле схемы → `SCHEMAS`, промпт в `PROMPTS`, `tools/stub.js` (заглушка отвечает формой), тест `test/brain-r*.test.mjs`.
- Тема нескольких экранов (круг 72): отказ одного экрана — заметка «пропущен», заметки «правка легла» — только если хоть одна операция вышла; выделение, оставленное агентом (`selectionBy:'agent'`), — не список экранов.
- `RE.theme` (круг 76): «сделай эти экраны тёмными» и т. п. — оформление, только если экран — прямое дополнение глагола и между ним и цветом одно имя экрана (части — `R76`); `\b` в регулярках с кириллицей не работает (ASCII) — границы через `(?<!\p{L})`, а `rx()` уже ставит `WB` в начало.
- `downgradeSchema` — для провайдеров, которые не принимают полную JSON Schema (LM Studio): проверяй оба пути.

## Отладка
`node --test test/brain.test.mjs test/brain-r36.test.mjs test/brain-r47.test.mjs test/brain-r52.test.mjs`; темы — `test/theme-paths-r69`, `theme-like-r71`, `theme-many-r72`, `theme-except-r74`, `board-names-r75`, `theme-words-r76`; образец — `reference-r56`, `moodboard-shot-r60`. В браузере — `dev.html` с `tools/stub.js`.

## Ссылки
- SPEC: §1.6, §5, §6, §7, §10.6, §11, §12, §14, §15.3, §17, §19, §20, §21, §22
- Тесты: `test/brain*.test.mjs`, `test/theme-*.test.mjs`, `test/reference-r56`, `moodboard-*`, `image-insert-r55`, `command-image-r58`, `test/orchestrator/llm`
