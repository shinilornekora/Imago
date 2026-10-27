# `server/document/importer.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Подготовка нового проекта для `POST /api/projects` (круг 33): разбор тела, проверка и приведение документа импорта, отпечаток тела для идемпотентного создания по `create_id`. Одна функция работает и в главном потоке, и в потоке пула.

## Главное
- `prepareProject(body, {maxNodes, maxDocBytes, onWarn})` → `{name, kind, createId?, createHash?, docJson, docBytes}`. Шаги: форма тела → `kind` design|library → `create_id` → `cleanBody` (`cleanDeep`, §9.10) → число узлов (413) → `importDocError` (`core.checkImportDoc`, глубина, типы) → `core.createDoc(d)` → `treeDepth` → `expandOver` → байты JSON (413).
- Нет `doc` — пустая страница `createDoc('empty')`; демо — только при `demo:true`.
- `createHashOf(body)` — sha256 нормализованного тела (имя после чистки и trim, вид, demo, документ как прислан), через `canonicalJson` (ключи по порядку). Повтор того же тела → 200 existing; другое → 409 conflict.
- `CREATE_ID_RE` 8–64 `[A-Za-z0-9_-]`; `MAX_TREE_DEPTH` = `core.MAX_DEPTH` или 256; `errorOut(e)` — ошибка в простой объект для потока.

## Поток данных
http.js / import-pool.js → здесь → `docJson` (уже строка: pg кладёт её в jsonb без второго stringify) → storage.createProject.

## Инварианты
- Исключение движка на чужом документе — 400 «документ не разобран», а не 500.
- Отказ за предел раскрытия называет `cost` (круг 41), даже если движок в checkImportDoc его не дал.

## Подводные камни
- У пустого `createDoc` id случайные — поэтому отпечаток считается по присланному телу, а не по приведённому документу.
- Своя проверка глубины нужна для движка прежней версии без `checkImportDoc`.

## Отладка
`node --test test/server/round33.test.mjs test/server/round39.test.mjs`.

## Ссылки
- SPEC: §9.10, §9.16, §9.17
- Тесты: `test/server/round33.test.mjs`, `test/server/round39.test.mjs`
