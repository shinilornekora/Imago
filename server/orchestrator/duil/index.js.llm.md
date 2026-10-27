# `server/orchestrator/duil/index.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
DUIL (SPEC §10.1, стрелки 6/7): срез библиотек — проекты вида `library` → внешний словарь компонентов для прогона brain (`runCommand({library})`, §10.6).

## Главное
`createDuil({dslr, log, listTtlMs})` → `{slice, stats, invalidate}`; `slice` (через внутреннюю `libraries(signal)`): список библиотек (`?kind=library&limit=`, живёт `PROJECT_LIST_TTL_MS` 60 с, одно чтение на всех; не прочитался — прежний, пока не старше `PROJECT_LIST_STALE_MS`) → каждая через DSLR (свежесть по журналу) → выжимка `libraryDocOf` + `describeLibrary` из brain, не больше `MAX_LIBRARIES`. `abortable(promise, signal)`.

## Инварианты
Шаг не роковой: библиотека недоступна — команда идёт со словарём из самого документа (мастера в нём brain видит и так, §5.3), в трассе — строка.

## Подводные камни
До круга 25 каждая команда читала весь `GET /api/projects` — не возвращать.

## Ссылки
- SPEC: §5.3, §10.1, §10.6
- Тесты: `test/orchestrator/round25`
