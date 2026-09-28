# Document service

Процесс «документ» из SPEC §8.1: модули **DSLR** (чтение), **DSLTS** (секвенсор — единственный
писатель) и **Hub** (рассылка по WebSocket) в одном процессе Node 22, без фреймворков.
Контракт — SPEC §9: он нормативен и для клиента `src/sync.js`.

```
server/document/
  index.js              вход: окружение, сборка модулей, graceful shutdown; export start(opts)
  http.js               маршруты §9.2 (node:http), статика клиента для прогонов без nginx
  hub.js                WebSocket §9.3 (пакет ws): hello → догон → живой поток, presence, ping/pong
  dslr.js               чтение: open (снимок + хвост), since (догон или gone со снимком)
  dslts.js              секвенсор §9.4: голова в памяти, мьютекс, rebase → applyOps → commitTx → снимок
  errors.js             DocError {status, code, message} — один вид ошибки для обоих транспортов
  storage/pg.js         PostgreSQL (pg.Pool), миграции из storage/migrations/*.sql
  storage/memory.js     тот же интерфейс в памяти — тесты и заготовка соло-режима
  storage/committed.js  форма записи журнала, общая для адаптеров
```

Движок — `src/core.js` без изменений: `rebase`, `applyOps`, `collectTombstones`, `hashDoc`,
`createDoc`, `ENGINE_VERSION`. Тот же модуль исполняется на клиенте, поэтому картинка
совпадает (§8.3 «движок один»).

## Запуск

```sh
npm install                       # pg, ws
DATABASE_URL=postgres://imago:imago@127.0.0.1:5432/imago node server/document/index.js
# или: npm run server
```

| переменная | по умолчанию | что |
|---|---|---|
| `PORT` | `8080` | HTTP и WebSocket на одном порту (`/api`, `/ws`); `0` — случайный |
| `HOST` | `0.0.0.0` | адрес |
| `DATABASE_URL` | — | Postgres; не задан — хранилище в памяти (данные живут до перезапуска) |
| `SNAPSHOT_EVERY` | `50` | снимок раз в N транзакций (асинхронно, после ответа); `0` — только при создании |
| `STATIC_DIR` | — | каталог клиента (`index.html`, `app.js`, `styles.css`, `src/*.js`) — раздаётся с верными MIME, чтобы гонять без nginx: `STATIC_DIR=. node server/document/index.js` из корня репозитория |

Миграции применяются при старте (таблица `schema_migrations`, под advisory-lock — два
экземпляра на одной базе не мешают друг другу). Останов по `SIGTERM`/`SIGINT`: сокеты
закрываются кодом 1001, новые транзакции получают 503, снимки в полёте дописываются, пул
закрывается.

Несколько экземпляров над одной базой работают: номер выдаёт `UPDATE projects SET head_seq =
head_seq + 1 … RETURNING` в одной транзакции базы с `INSERT` в журнал; экземпляр, чья голова
в памяти отстала, получает «не тот» номер, откатывает, перечитывает хвост и сливает заново
(до 12 попыток, дальше 503 — клиент держит очередь). Присутствие (`presence`) между
экземплярами не ретранслируется — это pub/sub следующего круга.

## Быстрая проверка

```sh
curl -s localhost:8080/api/health
curl -s -X POST localhost:8080/api/projects -H 'content-type: application/json' -d '{"name":"Проба"}'
curl -s localhost:8080/api/projects/<id> | head -c 300
curl -s -X POST localhost:8080/api/projects/<id>/tx -H 'content-type: application/json' -H 'X-Author: Аня' \
  -d '{"tx_id":"tx_1","base_seq":0,"engine":1,"ops":[{"op":"set","id":"<id доски>","path":"name","value":"Главная"}]}'
curl -s 'localhost:8080/api/projects/<id>/ops?since=0'
```

Имя в `X-Author` не-ASCII шлите в percent-encoding (`encodeURIComponent`): заголовки —
latin1, а `fetch` в браузере не-latin1 значение отвергает.

## Что важно знать клиенту (уточнения к §9)

* `hello.project` — сводка `{id, name, kind, head_seq, updated_at}`, не строка-id.
* Сокет без `since` — только живой поток (клиент открыл проект по HTTP и знает голову).
  `since=-1` — «ничего не знаю»: придёт `gone` со снимком. После `gone` по сокету сразу
  идёт хвост за снимком до головы; после HTTP `410` клиент сам просит `ops?since=snapshot.seq`.
* `gone`/`410` в этом круге — только когда `since < 0`, `since` впереди головы (проект
  пересоздан под тем же id) или хвост не начинается сразу за `since` (заготовка под чистку
  журнала, §8.3). Чистки нет, журнал хранится целиком.
* Повтор своей `tx` по сокету (после разрыва) отвечает рассылкой `tx` только если этот
  сокет её ещё не получал — гарантия «seq по одному сокету возрастает без пропусков»
  важнее второго подтверждения.
* Автор на сокете: query `author=`, поле `author` в `tx` или `presence`; тело `tx` без
  автора берёт автора сокета.
* Тело больше 4 МБ — `413` (сокет: ws закрывает соединение кодом 1009), транзакция с
  более чем 5000 операций — `400`. Неизвестный вид операции — `400`; операция известного
  вида, которую строгий `applyOps` не принял, — `dropped: invalid`, остальные ложатся.
* Мусор в несуществующий проект — `404`, а не `400`.
* Транзакция, у которой отброшены все операции, всё равно получает `seq` и пишется
  (`ops: []`): автору нужен ответ с `dropped`, идемпотентности — запись.

## Тесты

```sh
npm run test:server                                   # только сервер: memory всегда, pg — если база отвечает
TEST_DATABASE_URL=postgres://imago:imago@127.0.0.1:5432/imago_test npm run test:server
npm test                                              # весь репозиторий, серверные тесты входят
```

Без `TEST_DATABASE_URL`/`DATABASE_URL` (или если база не отвечает) прогоны над Postgres
помечаются `skip`, над памятью идут всегда. Перед прогоном с базой таблицы очищаются
(`TRUNCATE … CASCADE`) — не указывайте рабочую базу. Полный прогон — около 5 с.

Что покрыто (`test/server/document.test.mjs`, `test/server/storage.test.mjs`): маршруты и
коды §9.2, идемпотентность (в том числе два параллельных `POST` с одним `tx_id`), 426/400/404/413,
слияние §9.6 (`removed`, `reparented`, `cycle`, `invalid`, два `create` с одним `after`),
снимок раз в N и переигрывание журнала (`hashDoc` совпадает), «другой писатель» (запись мимо
памяти → перечитан хвост), два экземпляра над одним хранилищем, выгрузка головы и
восстановление надгробий, WebSocket (догон, живой поток обоим, `dropped` у всех, `presence`
не себе и не чаще 10/с, `left`, `gone` + хвост, транзакция во время догона), статика.
