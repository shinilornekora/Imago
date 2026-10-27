# `server/document/import-pool.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Пул потоков подготовки импорта (круг 33, срок задачи — круг 35): `run(buf)` даёт то же, что `prepareProject`, но разбор и проверка большого документа идут в отдельном потоке, чтобы импорт 20 тыс. узлов не держал запись соседних проектов.

## Главное
`createImportPool({size, queue, inlineBytes, taskMs, workerUrl, opts, log})` → `{run(buf), stats(), close()}`.
- Потоков ≤ `size` (IMPORT_CONCURRENCY), заводятся по требованию; в очереди ≤ `queue` (IMPORT_QUEUE), сверх — 503 `busy` `detail.limit:'import_queue'`.
- Тело < `inlineBytes` — готовится сразу в главном потоке (передача дороже).
- Поток упал — его задача 503 `cause:'import_worker'`, на его место новый. Не уложился в `taskMs` — 503 `cause:'import_timeout'`, поток останавливается и заменяется.
- Среда без worker_threads — подготовка в главном потоке по одной, предупреждение в лог.
- Куча потока `WORKER_HEAP_MB` = 1024.

## Поток данных
http.js (`POST /api/projects`) → `importer.run(buf)` → поток `import-worker.js` → `{out, warns}` → хранилище.

## Инварианты
Зависший поток не держит запрос и место в пуле вечно (срок на очередь + подготовку вместе).

## Подводные камни
`stats()` (inline/worker/refused/crashed/timedOut/peakWaiting) — единственный способ увидеть, что пул деградировал до главного потока.

## Отладка
`node --test test/server/round39.test.mjs test/server/round33.test.mjs`; переменные IMPORT_CONCURRENCY, IMPORT_QUEUE, IMPORT_INLINE_BYTES, IMPORT_TASK_MS.

## Ссылки
- SPEC: §9.16
- Соседи: `import-worker.js`, `importer.js`, `limits.js`
