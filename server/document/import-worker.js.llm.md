# `server/document/import-worker.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Тело потока (worker_threads) пула импорта (круг 33): байты тела `POST /api/projects` → `JSON.parse` → `prepareProject` из importer.js, вне цикла событий сервиса.

## Главное
Один обработчик `parentPort.on('message', {id, buf})` → ответ `{id, ok:true, out, warns}` или `{id, ok:false, error:{status, code, message, retryable, detail}}` (через `errorOut`). Опции (`maxNodes`, `maxDocBytes`) — из `workerData.opts`.

## Поток данных
import-pool.js шлёт задачу → этот поток → ответ простым объектом; http.js/import-pool.js превращают `error` обратно в DocError.

## Инварианты
- Ошибка — только простой объект (DocError через границу потока не проходит как класс).
- Предупреждения движка копятся в `warns` (обрезка 300 символов) и пишутся в лог главным потоком.

## Подводные камни
Не импортировать сюда ничего с побочными эффектами на старте (pg, сокеты): поток заводится по требованию и должен быть лёгким.

## Отладка
Через пул: `node --test test/server/round33.test.mjs test/server/round39.test.mjs`.

## Ссылки
- SPEC: §9.16 (круг 33)
- Соседи: `import-pool.js`, `importer.js`
