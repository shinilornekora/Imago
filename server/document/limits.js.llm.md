# `server/document/limits.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Все числа-пределы Document service в одном месте (SPEC §9.8) и чистка строк/значений (§9.10). Клиент `src/sync.js` держит копию части чисел в `LIMITS`; тест `test/server/hardening.test.mjs` сверяет их.

## Главное
- Тела и транзакции: `MAX_BODY_BYTES` 4 МБ, `WS_ENVELOPE_BYTES`, `MAX_OPS_PER_TX` 5000, `MAX_DOC_BYTES` 24 МиБ, `MAX_DOC_NODES` 20 000, `MERGE_BUDGET_MS`.
- `dropped`: `DROPPED_KEEP`, `DROPPED_OP_BYTES`, `DROPPED_PREVIEW_CHARS`.
- Чтение: `PAGE_TXS`, `MAX_LIMIT`, `PAGE_BYTES`, `PROJECTS_PAGE(_MAX)`, `HEAVY_CONCURRENCY/QUEUE`, `RETRY_AFTER_S`.
- Снимки: `SNAPSHOT_EVERY` 50, `SNAPSHOT_KEEP` 5. База: `DB_TIMEOUT_MS`, `VERIFY_MS`.
- Присутствие: `PRESENCE_*` (200 id выделения, 7600 байт — под предел NOTIFY, 10/с, сердцебиение 15 с, TTL 45 с).
- Сокет и очередь записи: `WS_INFLIGHT`, `QUEUE_PROJECT_*`, `QUEUE_TOTAL_BYTES`, `HTTP_WRITE_*`, `BUSY_RETRY_S`; кеш кадров `FRAME_CACHE_*`.
- Голова: `TOMB_*` (надгробия), `RECENT_*`, `REPLAY_*`, `HEADS_BYTES`; тела HTTP: `WRITE_BODY_BYTES`, `BODY_*_MS`, `HEADERS/REQUEST_TIMEOUT_MS`.
- Значения: `MAX_VALUE_DEPTH` 64, `MAX_OP_ID`, `MAX_COMMAND_ID`, `MAX_UNDO_PARTS`, `undoPartOf`.
- Чистка: `isCleanText`, `cleanText` (U+0000 вон, одиночные суррогаты → U+FFFD), `cleanMeta`, `cutText` (не режет суррогатную пару), `cleanKey` (`core.cleanKey`, если есть), `cleanDeep`, `showValue` (чужое значение в текст ошибки).
- В конце — объект чисел, которые обязан знать клиент (сверка с `LIMITS` из src/sync.js).

## Инварианты
- Поменял число, которое знает клиент, — поменяй и `src/sync.js` `LIMITS`, иначе клиент шлёт то, что сервер заведомо отвергнет, и транзакция крутится в очереди вечно.
- Многие числа переопределяются окружением в index.js (`ENV_LIMITS`, `limitsFrom`) — здесь значения по умолчанию.

## Отладка
`node --test test/server/hardening.test.mjs test/server/strings.test.mjs test/server/config.test.mjs`.

## Ссылки
- SPEC: §8.3, §9.8, §9.9, §9.10, §9.15
- Тесты: `test/server/hardening.test.mjs`, `strings.test.mjs`, `config.test.mjs`
