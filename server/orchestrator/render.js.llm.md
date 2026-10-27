# `server/orchestrator/render.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Снимок доски для критика агента (SPEC §14.4) и цвета картинок документа для арт-директора (§20). SVG — та же отрисовка, что у редактора (`core.renderSVG`), PNG — `@resvg/resvg-js` (необязательная зависимость), шрифты — TTF с Google Fonts. Живёт в воркере DSLV.

## Главное
- `createRenderer(opts)` (≈81) → `render({doc, geo, artboardId, signal, maxWidth?})`: ширина до 768 px (`SHOT_W`), высота до 1536 (`SHOT_H`, дальше `cropped`); шрифты семейств доски — из каталога `src/fonts.js` (`catalogFont`, `nearestWeight`), кеш в памяти воркера (`FONT_CACHE_FAMILIES`), неудача помнится `RENDER_FONT_FAIL_TTL_MS` (10 мин), общий срок `RENDER_DEADLINE_MS` (12 с). `maxWidth` (круг 65) — снимок уже обычного снимка критика, когда снимок мудборда не влез в предел образца; решение о повторе — в brain (`MOODBOARD_SHOT_*`, §22.2).
- `createImageColors(opts)` (≈246) → `(sources, {signal})` → `[{id, colors}]` — только встроенные `data:` png/jpeg/gif (WebP resvg не декодирует; площадь по заголовку ≤ `SWATCH_MAX_PIXELS`), палитра через `paletteFromPixels` (src/swatches.js), кеш по sha1 адреса.
- `EMOJI_RE` — эмодзи вырезаются (цветного шрифта нет, resvg отбрасывал весь кусок текста).

## Инварианты
- Всё, что может не выйти, даёт `null` — критик судит по выжимке: нет resvg, не пришло хоть одно семейство, SVG не собрался.
- Сеть — только fonts.googleapis.com / fonts.gstatic.com, без переадресаций (`redirect:'error'`), только семейства каталога.

## Подводные камни
- Node `fetch` не ходит через HTTPS_PROXY: за прокси снимков не будет (в облачной среде — тоже).
- resvg-js 2.6: пустой `fontBuffers` игнорирует `fitTo` — обход в коде (круг 65), не убирать.

## Отладка
`node --test test/orchestrator/round47.test.mjs test/swatches-r53.test.mjs test/moodboard-shot-r60.test.mjs test/moodboard-shrink-r65.test.mjs`.

## Ссылки
- SPEC: §14.3, §14.4, §20, §22.1, §22.2
- Тесты: перечисленные выше
