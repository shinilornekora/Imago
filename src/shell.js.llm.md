# `src/shell.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Таблица команд оболочки и все «слова оболочки» (SPEC §7, §10, §13; круги 23–24, 38 и далее). Чистые функции без DOM: узнать команду человека без модели, собрать её правку операциями ядра, назвать по-русски стадию/ошибку/итог агента, вести соло-хранилище проектов, собирать мудборды, вставку картинок и правки темы доски. Исполняет команду `app.js`; всё, что таблица не узнала, — работа агента. Orchestrator импортирует этот же модуль (`isShellCommandText`).

## Карта файла (≈ строки)
| Раздел | Строки | Что там |
|---|---|---|
| Текст и жаргон | 39–75 | `cutText`, `cleanText`, `isJargon` (не показывать человеку URL/коды/stack) |
| Режим и здоровье агента | 74–310 | `AGENT_MODE_WORDS`, `decideAgentMode`, `agentBadge`, `agentModeTitle`, `agentHealthNotice`, `STAGE_WORDS`, `serverStageRec`, `queuedLabel/Scope/Stage`, `presenceAgentWords`, `retryLabel` |
| Совместимость | 311 | `shellIntentFromServer` — событие `shell` прежнего сервера |
| Ошибки словами | 392–540 | `ERROR_WORDS`, `errorCodeWords`, `agentErrorWords`, `storageReason`, `schemaReason` |
| Кто сделал (род, падеж) | 541–655 | `nameGenitive`, `editOf`, `whoDid`, `agreeVerb` |
| Спасение проекта и сироты | 654–820 | `rescue*`, `orphanDeleteWords` |
| Итоги, история, dropped | 819–1200 | `appliedLine`, `historyOrder`, `droppedWords`, `expandLimitWords`, `historyForServer`, `tooLargeWords`, `detachedVerdict` (`DETACHED_TIMES`), `stoppedRunVerdict`, `OFFLINE_WORDS`, `PROJECT_GONE_WORDS` |
| Большая правка частями | 1201–1500 | `PART_MAX_OPS` 5000 / `PART_MAX_BYTES` 3,5 МБ, `splitOpsForServer`, `needsParts`, `partTitle`, `undoPartOf`, `collapseParts`, `replaceDocOps`, `rescuePlan` (§9.15) |
| Заголовки и варианты | 1500–1660 | `txTitleWords`, `normalizeResult`, `agentHeadline` (§10.12), `variantsFromServer` |
| Имена слоёв по-русски | 1659–1815 | `normSaid`, основы слов с кешем (`nameStems`, `warmNameStems`, `STEMS_CACHE_MAX`), `nameMatches`, `artboardsByName`, `nodesByName`, `numSaid` |
| Узнавание | 1815–2075 | регулярки фраз (отмена N раз, тема интерфейса, просмотр, зен-режим `RE_ZEN_ON`/`RE_ZEN_OFF` — §24, новая доска…; `RE_THEMED_PICK`/`RE_THEMED_ASK`, `RE_BIND_COLORS`/`RE_BIND_ALL` — здесь же), **`shellIntent(said, ctx)`** (≈1897; слэш-форма — раньше всех), `shellEventOf` |
| Таблица | 2075–2700 | `SHELL_GROUPS`, **`SHELL_COMMANDS`** (≈2090, глубоко заморожена; формат записи — SPEC §13.2), `keyLabel`, `keyPlatform`, `slashIntent`, `SLASH_ARGS`, `naturalIntent`, `isShellCommandText`, `commandIdOf`, `needsSelection`, `helpGroups`, `paletteRows` |
| Правки выделения | 2705–3070 | `duplicateOps` (обёртка над `core.duplicateOps`), `renameOps`, `visibleOps`, `lockOps`, `reorderOps`, `wrapOps`/`ungroupOps`, `alignOps`, `directionOps`, `gapStepOps`, `selectAllIds`, `relatedIds` |
| Состояния и движение | 3072–3330 | `STATE_KEYS`, `stateWriteOps`, `motionWriteOps`, `stateEditPhrases` (§11) |
| Векторы, краски, фактуры | 3330–3800 | `isIllustration`, `paintKind/Css/Hex`, градиенты, `PATTERN_KINDS` (§16), `pathsWriteOps`, `vectorEditPhrases`, `freeModeOps` (§12) |
| Соло-хранилище | 3804–4168 | `SOLO_*` ключи localStorage/IndexedDB, `createSoloStore`, `openSoloStore` |
| Арт-направление | 4168–4245 | `ART_ROLE_WORDS`, `artSummary` (§14.5, §17) |
| Картинки | 4245–4430 | `MOODBOARD`, `moodboardOps`, `moodboardLeftover` (§21.6–§21.7), `REFERENCE_WORDS`, `referenceCommandText` (§21.5), `clipboardTextIsLabel`, `IMAGE_INSERT`, `imageInsertOps` (§21) |
| Тема доски | 4430–конец | `boardColorRows`, `themeColorOps` (§15.6), `boardFontRows`, `themeFontOps`, `fontChoices` (§15.7), `boardStyleFontRows`, `themeStyleFontOps` (§15.10; подобранная насыщенность — `roleWeight`, общая с `themeFontOps`), `themePartResetOps` (снять одну часть темы; последняя — вся тема, §15.15), `boardThemeBadge` (метка своей темы в списке слоёв, §15.17; подсказка зовёт щёлкнуть — §15.18), `boardHexRefs`/`bindBoardColorsOps` (цвета кодом → токены палитры документа, как их видит экран, вид прежний; с круга 95 — и стопы градиентов, и цвет/подложка фактур; рисунок `role:'illustration'` — мимо, §15.29; память `HEX_REFS_MEMO` на документ и `HEX_REFS_LAST` — ответ прошлого документа при тех же узлах поддерева и палитре, §15.21/§15.24), `staleHexRefs`/`staleHexPhrase` (правка сменила цвет палитры — слои с кодом прежнего значения и их привязка, §15.25), `RE_BIND_COLORS` → `{kind:'bind-colors'}` («привяжи цвета к палитре», `/привязать цвета`, §15.22), `bindAllColorsOps` + `RE_BIND_ALL` → `{kind:'bind-colors', all:true}` (все экраны одной правкой, библиотека — нет; команда `bind-colors-all`, §15.23), `themedBoardsIntent` («выдели экраны со своей темой», `/свои темы`; фразы — `RE_THEMED_PICK`/`RE_THEMED_ASK` в `shellIntent`, §15.19), `themeSources`, `copyThemeOps` (§15.8), `colorTokenUsers`/`docColorRows`/`docColorOps`/`newDocColorOps` (шторка «Цвета документа»: кто ссылается на цвет, правка палитры документа с экранами со своим цветом и контрастом, новый цвет латиницей; команда `doc-colors` → `{kind:'sheet', what:'colors'}`, §15.30), `colorTokenRefs` (ссылки на цвет с путём до имени), `renameDocColorOps`/`removeDocColorOps` (переименовать со ссылками и темами экранов; удалить ненужный; роли палитры `SWATCH_ROLE_NAMES` — нет, §15.31) |

## Инварианты
- Функции правок не меняют документ: `(doc, ids, …) → {ops, words, ids?|id?}` или `{error}` словами; правка уходит обычной транзакцией, отмена — одним шагом.
- Команда описана в таблице явно (имя, группа, фразы, слэш, клавиша, аргументы); палитра (Ctrl/⌘+K, «/») и справка строятся из неё — не дублировать списки в app.js.
- Естественная фраза узнаётся только целиком: «добавь стоп-кран» не «стоп».
- Человеку не показывается жаргон (`isJargon`): коды ошибок переводятся в слова.

## Подводные камни
- Новая команда: запись в `SHELL_COMMANDS` + исполнение в app.js + строка в SPEC §13.6 + тест в `test/shell*.test.mjs`.
- Кеш основ имён ограничен `STEMS_CACHE_MAX`; `nameStemsComputed()` — тестам на тёплый кеш.
- Числа частей (`PART_MAX_*`) должны оставаться ниже серверных пределов транзакции (§9.8).

## Отладка
`node --test test/shell.test.mjs test/shell-r3*.test.mjs test/shell-r4*.test.mjs test/shell-r50.test.mjs`; темы — `test/theme-*.test.mjs`; картинки — `test/image-insert-r55`, `command-image-r58`, `moodboard-r59`, `canvas-multi-r63`.

## Ссылки
- SPEC: §7, §10.3, §10.5, §10.12, §11, §12, §13 (§13.2 контракт, §13.6 перечень команд), §15.6–§15.8, §16, §17, §21
- Тесты: `test/shell*.test.mjs`, `test/agent.test.mjs`, `test/theme-*.test.mjs`, тесты картинок кругов 55–65
