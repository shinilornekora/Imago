# `src/fonts.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Подобранный набор шрифтов агента (круг 47, SPEC §14.2): только семейства Google Fonts с кириллицей и проверенными начертаниями, плюс пары «акцидентный + наборный» со словами о характере. Модуль без зависимостей; импортируют brain.js (браузер и сервер), app.js и `server/orchestrator/render.js`.

## Главное
- `DEFAULT_FONT = 'IBM Plex Sans'` — шрифт по умолчанию, признак «шаблонного» экрана для критика (§14.3).
- `FONT_CATALOG` — `{family, kind (sans|serif|display|script|mono|slab), weights, mood}`; `FONT_PAIRS` — пары для арт-директора.
- `catalogFont(name)` (регистр не важен), `nearestWeight(family, weight)` — ближайшее существующее начертание, `fontStylesheetUrl(families)` — css2-адрес, `fontsInDoc(doc)` — семейства документа (`style.font`, `tokens.type.*.font`, темы досок), `fontMenu()` — список для инспектора.

## Инварианты
- Формат документа модуль не меняет: шрифт живёт в `style.font` узла, `tokens.type.<k>.font` или теме доски (§15).
- Запрос css2 с весом, которого у семейства нет, — 400 Bad Request: веса брать только из `weights` через `nearestWeight`.

## Подводные камни
Не добавлять семейства без кириллицы (Bebas Neue, DM Sans, Space Grotesk, Work Sans): русский заголовок выйдет системным шрифтом.

## Ссылки
- SPEC: §14.2, §14.3, §15, §15.7, §17.3 («шрифты из сети»)
- Тесты: `test/brain-r47.test.mjs`, `test/core-r48.test.mjs`, `test/theme-fonts-r68.test.mjs`
