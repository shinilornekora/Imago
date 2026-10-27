# `server/document/http.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
HTTP-маршруты Document service (SPEC §9.2, §9.8) на голом `node:http`: JSON, коды как в таблице §9.2, тело любой ошибки — `{error:true, code, message, retryable, detail?}`. Плюс раздача статики клиента для прогонов без nginx.

## Главное
- `createRequestHandler({dslr, dslts, storage, staticDir, internalToken, log, writes, importer})` → `(req, res)`; внутри `route` (≈440) и `route2` (≈672).
- Маршруты: `GET /api/health`; `GET|POST /api/projects`; `GET|PATCH|DELETE /api/projects/:id`; `GET …/ops?since=&limit=`; `GET …/history?limit=&before=`; `POST …/tx`; `POST /api/internal/traces` (по `INTERNAL_TOKEN`, сравнение `timingSafeEqual`; `change-me` или пусто → 403); `OPTIONS` → 204.
- `readBody` — тело с пределом байт, сроком (408), сроком первого байта и простоя; `readJSON`, `parseBody`.
- `intParam` — только десятичные цифры в [min, 2^53−1] → иначе 400 до всякого SQL (круг 31); курсоры страниц — base64url `[at, id]`.
- `authorOf(req)` — имя автора из заголовка; `historyItem` — строка «Истории» без операций.
- `applyServerTimeouts(server)` — headers/request timeouts (используется и hub.js).
- `staticAllowed(rel)` — белый список: `/index.html`, `/app.js`, `/styles.css`, `/src/<имя>.js`; всё прочее и сегменты на точку — 404 (круг 33).

## Поток данных
index.js создаёт обработчик → чтения в dslr.js, запись в dslts.js (под семафором записи `HTTP_WRITE_CONCURRENCY/QUEUE` и бюджетом тел `WRITE_BODY_BYTES`), импорт в import-pool.js, трассы в storage.

## Инварианты
- CORS не нужен: nginx держит /api, /ws и статику на одном origin.
- Запись по HTTP (POST projects, POST tx, PATCH, DELETE) — под одним семафором и бюджетом тел.
- `409` на tx не бывает: конкуренция решается слиянием.

## Подводные камни
- Сайдкары `*.llm.md` под `src/` статикой не отдаются (белый список только `.js`) — так и должно остаться.
- `DELETE` — только пустой проект design своего создания (`create_id`, круг 45).

## Отладка
`node --test test/server/document.test.mjs test/server/projects.test.mjs test/server/round27.test.mjs test/server/round31.test.mjs`.

## Ссылки
- SPEC: §9.2 (таблица маршрутов), §9.8, §9.10, §9.13, §9.15, §9.16, §9.19, §9.20
- Тесты: `test/server/backpressure`, `document`, `projects`, `round27`, `round29`, `round31`
