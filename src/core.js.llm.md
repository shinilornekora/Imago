# `src/core.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Движок Imago (≈13 тыс. строк, один ES-модуль без зависимостей): модель документа, операции и их проверка, слияние транзакций, решатель геометрии (раскладка), валидаторы, цвет и контраст, тема доски, компоненты и раскрытие экземпляров, сцена (SVG + ввод, класс `Stage`) и снимок без браузера. **Один и тот же модуль** исполняют браузер, Document service (DSLTS — `rebase`/`applyOps`), Orchestrator и его воркеры (§8.3 «движок один»). Шапка файла — контракт и правила миграций; экспорт — один блок `export {…}` в конце файла (≈13102) с комментариями по кругам.

## Карта файла (разделы `/* ---- N. … */`, ≈ строки)
| Раздел | Строки | Что там |
|---|---|---|
| 0. Утилиты | 37 | версия формата: `ENGINE_VERSION = 3` (≈122), `ENGINE_MIN_READ`, `engineReadable`; пределы `MAX_EXPANDED_NODES = 50000` (≈68), `MAX_DEPTH = 256`; `cutText`/`cleanText` (по кодовым точкам), `cleanKey`, `isNodeId`, `uid` |
| 1. Токены | 347 | `DEFAULT_TOKENS` (§3) |
| 2. Схема узлов | 380 | `NODE_TYPES`, `normalizeLayout` / раскладка в числах и в форме хранения, `keepFieldForm` («то же самое», §6.4) |
| 2a. Шкалы | 390 | ссылки `spacing.<i>` / `radii.<i>`: `resolveScale`, `resolveLayout`, `resolveRadius`, `parseScaleRef`… (§6) |
| 2.4 Форма полей | 842 | `fieldProblem` — ЕДИНСТВЕННАЯ таблица формы полей узла (проверка, импорт, отпечаток), ключи стиля текста (круг 43) |
| 2.4a Микроанимации | 1021 | состояния и движение (§11) |
| 2.4b Векторы и краски | 1179 | `parsePath`, `formatPath`, `pathBounds`, градиенты, `resolvePaint`, `paintProblem` (§12) |
| 2b. Тема доски | 1753 | `boardTheme` (≈1852), `themedDoc`, `themeScope`, `boardOf`, `themeProblem`, `THEME_LIMITS`, `liftOps` (≈1833 — запись прежнего движка → операции нынешнего) (§15) |
| 2.5 Компоненты | 2161 | библиотека, мастера, экземпляры (§5): `ensureLibrary(Ops)`, `components`, `makeComponentOps`, `instanceOps`, `detachInstanceOps`; раскрытие `expandOne` (≈2482), стоимость `expandCost` (≈2834, без раскрытия, круг 39), `expandProblem`, `expandDoc` (≈2946), `expandInstance` |
| 3. Документ и обход | 3226 | `nodeById`, `ancestors`, `subtreeIds`, `cloneSubtree`, `resolveTarget`, `duplicateOps` (≈3388, единственная реализация, круг 39) |
| 4. Операции | 3554 | `ops` = {create, remove, set, move, setToken}; **`applyOps`** (≈4596; иммутабельно, с проверкой, один черновик на пачку), `applyBatches` (≈4650; хвост журнала одним черновиком), **`invertOps`** (≈4872), `splitOps` (≈4943; большая правка пачками) |
| 4b. Слияние | 4974 | **`rebase(doc, ops, {tombstones})`** (≈5876; правила §9.6), `collectTombstones` (≈5747), `normalizeTombstones`, `pruneTombstones`, `hashDoc` |
| Отпечаток формата | 5022 | `formatSignature`, `FORMAT_SIGNATURE`, `formatBehavior` (круг 43/45 — поведенческий отпечаток, ≈5083) |
| 4a. Шкалы: миграция | 6066 | `ensureScaleRefs(Ops)`, `rewriteScaleRefsOps`, `insertScaleStep` (§6.5) |
| 5. Измерение текста | 6238 | кеш ширин; 5a. эпоха измерений (`resetMeasureCache`, `measureEpoch`, `onMeasureEpoch`) — 6315 |
| 6. Решатель | 6517 | раскладка детей фрейма (≈6639), **`solve(doc, opts)`** (≈6905), **`solveAfter(prevGeo, prevDoc, nextDoc, ops, opts)`** (≈6994, по месту правки, §18), `solveNext` (≈7016, от памяти раскладки, §18.6), `solveCarry`, **`hashGeometry`** (≈7089) |
| 7. Цвет | 7109 | `resolveColor`, `contrastRatio` (WCAG 2.1), фактуры `patternTile` (круг 49, §16) |
| 7a. Движение | 7293 | `resolveMotion`, `resolveState`, `resolveShadow`, `transitionCss` |
| 8. Валидаторы | 7483 | **`validate(doc, geo, opts)`** (≈7780) → Violation[] |
| 9. Документ | 7942 | 9a. пример иллюстрации (`sampleIllustration`, 7959); `checkImportDoc` (≈8704, строгая проверка чужого документа), **`createDoc(seed)`** (≈8801; `'empty'` — пустой в нынешнем формате) |
| 10. Сцена | 8867 | SVG без браузера (`headlessStage`, **`renderSVG`**, `boardPNG` — снимок для критика, круг 47, ≈8992/12989), гарнитуры для экспорта (≈9167), ручки и подписи, **`class Stage`** (≈9593: `render`, `setSelection`, `fitTo`, `zoomAt/By`, `toSVG`, `screenshot`, `prepareFonts`, `setPreview`, `playState`, `destroy`) |

## Поток данных
Документ `Doc = {id, version, root, nodes, tokens, meta}` (§1.2) → `applyOps` (правка) → `solve`/`solveAfter` (геометрия; раскрытые экземпляры — в `geo.expanded`, не в `doc.nodes`) → `validate` → `Stage.render(doc, geo, state)` или `renderSVG`. На сервере: транзакция → `rebase` поверх головы → `applyOps`/`applyBatches` → журнал.

## Инварианты
- Детерминизм: `solve(doc)` — чистая функция документа; все быстрые пути (`solveAfter`, `solveNext`) обязаны давать тот же `hashGeometry`, что полная раскладка (бенч и тесты это сверяют).
- Операций пять и они не растут (§5.2); новые возможности — новые поля/типы, а не новые операции.
- Любое изменение формата документа (новое поле, тип, значение перечисления, поведение отрисовки) — только с подъёмом `ENGINE_VERSION` и строкой в `FORMAT_HISTORY` (`test/core-r43.test.mjs`, тест печатает строку, которую надо вставить); при этом `liftOps` должен поднимать записи прежнего движка.
- Шкалы читаются числом ТОЛЬКО через `resolveScale`/`resolveLayout`/`resolveRadius`; читать `gap`/`padding`/`radius` как числа нельзя.
- Правки компонентов, шкал, дублирования возвращают ОПЕРАЦИИ и документ не меняют.
- Раскрытие не больше `MAX_EXPANDED_NODES`; сверх — заглушки (`DEGRADED_INSTANCE_NODES`).

## Подводные камни
- Ключи вида `constructor`/`__proto__` — не id узла (`isNodeId`, круг 25).
- Кеш измерений текста залипает на системном шрифте, если не сбросить после загрузки гарнитур (`onMeasureEpoch`).
- `brain.js` зеркалит `parsePath` и `keepFieldForm` — меняй вместе.
- Это файл, который правят обе цепочки PR (живой дизайн и раскладка/кеш экземпляров) — конфликты чаще всего в `solveAfter` (см. memory: использовать `memo.doc`).

## Отладка
`node --test test/core.test.mjs test/core-r43.test.mjs test/core-r51.test.mjs test/core-r57.test.mjs test/merge.test.mjs test/scale.test.mjs`; производительность — `node tools/bench-layout.mjs --nodes 1000,5000`.

## Ссылки
- SPEC: §1.1–§1.5, §3, §5, §6, §8.3, §9.6, §11, §12, §14.4, §15, §16, §18
- Тесты: `test/core*.test.mjs`, `test/merge.test.mjs`, `test/scale.test.mjs`; косвенно — почти все тесты (98 файлов импортируют core.js)
