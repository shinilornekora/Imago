# `server/orchestrator/dslts/index.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
DSLTS-клиент агента (SPEC §10.1, стрелки 12/13): запись транзакции агента `POST /api/projects/:id/tx` с повторами.

## Главное
- `createDsltsClient({...})` → `{commit, stats}`; `commit` → Committed.
- `checkTx(tx, {maxOps, maxBytes})` — до сети: операций > 5000 или тело > 4 МБ → `tooLarge(...)` с объяснением человеку (по-русски, `plural`).
- Повторы: отказ связи / 502/504 прокси — паузы 300 мс…2 с в бюджете `WRITE_WAIT_BUDGET_MS` (15 с, переживает перезапуск сервиса); 5xx/дедлайн — до `WRITE_ATTEMPTS`, у 503 ждём Retry-After (≤ `DOC_RETRY_AFTER_MAX_S`); 413 → too_large; 426 → engine; 404 → not_found; прочие 4xx → document_failed.

## Инварианты
- Любой повтор — с ТЕМ ЖЕ `tx_id`: сервис идемпотентен, двойной записи не бывает.
- Большую правку агент не режет: половина правки в журнале хуже, чем никакой.

## Ссылки
- SPEC: §8.3, §9.1, §9.8, §10.1, §10.2
- Тесты: `test/orchestrator/dslts`, `round27`
