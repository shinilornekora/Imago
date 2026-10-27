# `server/document/storage/migrations/` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Миграции схемы Postgres. Каталог описан одной заметкой (а не сайдкаром на файл): каждая миграция короткая, и её шапка — сама по себе описание. Раннер — `pg.js` `migrate()`; применённые — в таблице `schema_migrations`.

## Файлы
| Файл | Круг / § | Что делает |
|---|---|---|
| 001_init.sql | 22 | projects, operations, snapshots, пустые library_versions и project_imports |
| 002_chain_epoch.sql | 23 | chain у записи (sha256(prev ‖ tx_id ‖ seq)), head_chain, эпоха проекта (§9.8) |
| 003_chain_backfill.mjs | §9.8, §9.11 | chain у записей до 002, пачками |
| 004_traces_notnull.sql | 25 | трассы агента (§10.4); имя историческое — NOT NULL вынесен в 006 |
| 005_tombstones_command.sql | 25 | надгробия в снимке, command_id у записи (без перезаписи таблицы) |
| 006_chain_check.mjs | §9.11 | «у каждой записи есть chain» — безопасно для смешанных версий |
| 007_tombstones_unknown.sql | 27 | надгробия v2 с номером удаления; NULL — «неизвестно» |
| 008_projects_page_index.mjs | 27 | индекс (updated_at, id) для страниц списка проектов |
| 009_ops_size.mjs | 29 | ops_bytes, ops_count — вес записи без чтения jsonb (BYTES_SQL/COUNT_SQL импортирует pg.js) |
| 010_command_author.sql | 30 | command_author — кто дал команду агенту |
| 011_undo_part.sql | 32 | undo_part — часть большой правки |
| 012_create_id.sql | 33 | идемпотентное создание проекта |
| 013_create_hash.sql | 35 | отпечаток тела создания рядом с create_id |
| 014_snapshot_engine.sql | 39 | база не принимает снимок движка старше записей под ним |

## Инварианты
- Имя миграции — `NNN_имя.sql|mjs` (`MIGRATION_RE` в pg.js); порядок — по имени. Применённую миграцию не менять: новая правка — новый файл.
- Каждая миграция обязана работать при живом экземпляре прежней версии (§9.11): без перезаписи больших таблиц, DDL с коротким lock_timeout.
- `.mjs` экспортирует функцию(и) up / ddlUp + fillUp, получает ctx (`client`, `log`, `progress`, `closing`, lock-хелперы).
- Новая миграция → строка в эту таблицу, в шапку pg.js (если меняется интерфейс), в docs/06-схема-базы.mermaid и в `server/document/README.md`.

## Отладка
`service postgresql start`; `node --test test/server/migrations.test.mjs` (копирует каталог с фильтром — проверь, что фильтр не цепляет .md).

## Ссылки
- SPEC: §9.8, §9.11, §9.14–§9.17
- Тесты: `test/server/migrations.test.mjs`, `round32.test.mjs`
