# `server/document/dslr.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
DSLR — DSL Reader (SPEC §8.1, §9.8): чтение проекта = снимок + хвост журнала. Читает только хранилище, к голове секвенсора (dslts.js) не прикасается: клиент и Orchestrator получают ровно записанное и переигрывают хвост своим движком (§8.3 «журнал — источник истины»).

## Главное
- `createSemaphore({max, queue, retryAfter, message})` — семафор тяжёлых чтений; очередь полна → 503 `busy` + Retry-After. Им же пользуется http.js для записи.
- `createReader({storage, heavy, pageBytes, snapshotCacheBytes, engine})` → объект:
  - `head(id)` — строка проекта (head_seq, chain, epoch);
  - `open(id, opts)` — снимок + хвост (`GET /api/projects/:id`), проверка версии движка (`engineUnreadable` → 503 cause engine);
  - `classify(id, {since, tip, epoch}, head)` — можно ли догонять хвостом, нужен снимок, или это след отката базы;
  - `since(id, since, limit)` — страница хвоста `{head_seq, txs, more}`; дыра или since вне диапазона → `gone(...)`;
  - `gone(id, p)` — `{gone:true, head_seq, snapshot, project}` для 410 / сокетного gone (под семафором).
- Внутри: кеш JSON снимков по байтам (`snapPut`/`snapshotJson`), `noSnapshotOr404`.
- `MAX_LIMIT` — реэкспорт для совместимости.

## Поток данных
http.js (`GET /api/projects/:id`, `…/ops`) и hub.js (догон сокета) → reader → storage (pg.js / memory.js). Надгробия снимка — через `flatTombstones` (dslts.js).

## Инварианты
- Хвост отдаётся страницами по числу записей и (мягко) байтам; `more:true` — есть ещё.
- Первая запись страницы должна быть ровно `since+1`, иначе — снимок (дыра в журнале не маскируется).

## Подводные камни
- Полный снимок большого проекта — тяжёлое чтение; именно здесь появляются 503 busy под нагрузкой (test/server/backpressure).
- Эпоха и tip в `classify` — защита от отката базы (§9.8): тот же seq после отката называет другую транзакцию.

## Отладка
`node --test test/server/backpressure.test.mjs test/server/round27.test.mjs test/server/round31.test.mjs`.

## Ссылки
- SPEC: §8.1, §8.3, §9.2, §9.3, §9.8, §9.10
- Тесты: `test/server/backpressure`, `hardening`, `round27`, `round29`, `round31`
