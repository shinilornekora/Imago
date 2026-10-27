# `test/` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Тесты на `node:test` без фреймворков: `npm test` = `node --test "test/**/*.test.mjs"` (процесс на файл, файлы идут параллельно). Каталог описан одной заметкой: имя файла уже говорит, что он проверяет, а сайдкар на каждый из ~110 файлов был бы шумом.

## Как устроено
- Имя `<область>-r<круг>.test.mjs` (или `round<круг>`) — тесты конкретного круга; без номера — базовые тесты области. Круг ↔ раздел SPEC: см. оглавление SPEC.md («Круг N» в заголовках).
- `test/*.test.mjs` — клиентские модули: `core*` (движок), `brain*` (мозг), `shell*` (таблица команд и слова), `sync*` (реплика), `agent` (клиент агента), `merge`, `scale`, `theme-*-r67…r71` (тема доски), картинки и образец (`image-insert-r55`, `reference-r56`, `command-image-r58`, `moodboard-r59`, `moodboard-shot-r60`, `canvas-multi-r63`, `moodboard-shrink-r65`), `swatches-r53`, `bench-r66`, `deploy` (Dockerfile, nginx, build), `smoke-r45`, `sidecars` (правило заметок).
- `test/server/` — Document service: `helpers.mjs` (сервис на случайном порту с памятью или Postgres, HTTP- и WS-клиенты), `load.mjs` (нагрузка), темы: backpressure, coldload, config, document, hardening, migrations, presence, projects, resilience, rollback, storage, strings, tombstones, `round27…round45`.
- `test/orchestrator/` — агент: `helpers.mjs` (Document service в памяти + поддельный OpenAI-совместимый сервер модели + Orchestrator + SSE-клиент), contract, dslr, dslts, dslv, llm, orchestrator, process, `round25…round64`.

## Postgres
- База — `TEST_DATABASE_URL` или `DATABASE_URL`; нет — pg-прогоны помечаются skip (memory идут всегда). Значит «зелёный» прогон без базы проверил не всё.
- Каждый файл работает в своей временной базе `<база>_t<pid>_<случайное>` (создаётся и удаляется сам; без права CREATE DATABASE — своя схема).
- В облачной среде: `service postgresql start`, затем, например, `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/imago_test npm test` (имя базы — своё; `imago_rehearsal` занята потоком диплома).

## Инварианты
- Тест не отключают и не пропускают ради зелёного прогона.
- `test/core-r43.test.mjs` держит `FORMAT_HISTORY`: смена формата без подъёма `ENGINE_VERSION` — падение; при подъёме тест печатает строку, которую надо вставить.
- Тесты читают `app.js`, `index.html`, `styles.css` текстом (тексты интерфейса, отсутствие своих перечней команд) — переименования в оболочке ловятся здесь.

## Отладка
Один файл: `node --test test/<файл>.test.mjs`; один тест: `--test-name-pattern "<часть имени>"`.
