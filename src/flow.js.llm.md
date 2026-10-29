# `src/flow.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Длинные задачи (круг 110, SPEC §25): сценарий из многих экранов одной командой — «сделай полный воркфлоу игрового сценария». Здесь только чистые части без модели и без DOM; сам прогон (вызовы модели, сборка экранов, одна правка) — `runFlowCore` в `src/brain.js` (раздел 14).

## Главное
- `recognizeFlow(utterance)` → `null | {screens?}` — глагол построения + слово сценария (воркфлоу, флоу, user flow, сценарий, путь пользователя, прототип, развёртка) или «N экранов» при N ≥ 3; вопрос — нет.
- `SCHEMA_FLOW` (= `SCHEMAS.flow` в brain), `flowPrompt(ctx)` (= `PROMPTS.flow`), `FLOW_LIMITS` (экранов 2–12, переходов ≤ 40, зазоры 320/200, отступ от старых досок 400), `FLOW_DEVICE`, `flowDevice(device)`.
- `normalizeFlow(raw, {screens})` → `{title, summary, device, size, screens [{key, name, purpose}], links [{from, to, label}], notes}` | null (< 2 экранов).
- `screenBrief(flow, screen, i)` — команда экрана для обычного конвейера «собери экран» (кнопки переходов словами trigger: `actionWords`).
- `flowColumns(flow)` (шаг пути, поиск в ширину), `layoutFlow(flow, boards, origin)` → Map key → {x, y}.
- `triggerNode(doc, boardId, label)` — слой-кнопка перехода по словам trigger; `flowSummary(title, screens, links)` — «Сценарий «…»: 6 экранов, 7 переходов».

## Инварианты
- Переход — поле доски `flow: [{to, label?, from?}]`, простые данные: ENGINE_VERSION не меняется; читает его `core.boardFlow`, рисует `Stage._renderFlow`.
- Модуль без импортов: его зовут brain (браузер и воркер Orchestrator) и тесты.

## Подводные камни
- `\b` с кириллицей не работает — границы слов через `(?<![\p{L}\p{N}])`.
- Бриф экрана читают заглушка (`tools/stub.js`, `screenFromBrief`) и тест (`screenTree`): меняешь формулировки «Собери новым экраном «…»» и «Переходы с экрана … кнопка «X» → …» — поправь и их.
- Повтор ключа модели в `links` — за первым экраном с этим ключом.

## Отладка
`node --test test/longtask-r110.test.mjs`; в браузере — `dev.html` и команда «сделай полный воркфлоу игрового сценария».

## Ссылки
- SPEC: §25
- Соседи: `src/brain.js` (`runFlowCore`), `src/core.js` (`boardFlow`, `_renderFlow`), `tools/stub.js`
- Тесты: `test/longtask-r110.test.mjs`
