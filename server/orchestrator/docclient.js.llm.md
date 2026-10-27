# `server/orchestrator/docclient.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Транспорт агента до Document service (SPEC §9.2): fetch с дедлайном, JSON туда и обратно. Общий для DSLR-, DSLTS-клиента, трасс и проверки здоровья.

## Главное
- `createDocClient({baseUrl, fetch, …})` → `{base, get, post, health, healthDetail, stats}`.
- `parseRetryAfter(header, body)` — секунды из `Retry-After` или `retry_after` тела.
- Ошибка сети, дедлайн, 5xx → `document_down` (503, повторяемо) с `docStatus`, `docCode`, `docRetryAfter` (наружу не уходят). Прочие статусы — вызывающему как есть (он знает, что значит 404 или 410).

## Инварианты
Document service — единственный арбитр: без него агент правок не делает (CP, §8.3).

## Подводные камни
Круг 39 (N5а): таймер дедлайна — таймер нашего же цикла событий. Опоздал больше `LOOP_LAG_GRACE_MS` — это занятость главного потока, срок продлевается (до `LOOP_LAG_EXTENSIONS` раз). Без этого живой сервис выглядел «недоступным» под нагрузкой.

## Ссылки
- SPEC: §8.3, §9.2, §10.12
- Тесты: `test/orchestrator/dslr`, `dslts`, `round25`, `round27`, `round39`
