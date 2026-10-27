# `src/sync.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Клиент-реплика Document service (круг 22, SPEC §8.3, §9.5): полная реплика с локальным журналом. Свои правки применяются сразу, переживают перезагрузку вкладки и досылаются при воссоединении; сервер — единственный арбитр порядка. Без DOM, без решателя и отрисовки: исполняется и в Node (тесты с фальшивым сервером и сокетом). Шапка файла — хронология правил по кругам 22–41, читать её при любом расхождении реплики с сервером.

## Модель состояния
- `confirmed = {seq, doc}` — что подтвердил сервер; `pending = Tx[]` — свои, ещё без номера; `view = replay(confirmed.doc, pending)` — теми же `rebase` + `applyOps`, что в DSLTS.
- `tip` (chain последней подтверждённой) и `epoch` уходят серверу при переподключении (`?since=&tip=&epoch=`, круг 23).
- `mine` — свои подтверждённые (окно `MINE_KEEP`/`MINE_BYTES`) — для переигрывания после отката базы; `unsaved` — снятые «не сохранено» после `RETRY_POISON` одинаковых ошибок.
- Надгробия: подтверждённые с номером удаления (прореживание правилом сервера `LIMITS.tomb*`) + наложение ожидающих (`TombOverlay`).

## Главное (≈ строки)
- Экспорт: `WIRE`, `LIMITS` (≈112 — числа сервера, сверяются тестом с `server/document/limits.js`), `DROP_WORDS`, `engineWords`, `cleanText`, `plural`, `droppedLine`, `STORAGE_DOWN_LABEL`, `statusLine`, `idbStorage` (IndexedDB `imago`/`projects`), `memoryStorage`, `createSync(o)` (≈578).
- `createSync({core, projectId, clientId, author, storage, WebSocketImpl, fetchImpl, baseUrl, …, on*})` → `{open, close, commit, presence, reconnect, offline, flush, touch, setAuthor, retryUnsaved, journal, whoRemoved, whoChanged, storageFailed, tombstoneIds}` + геттеры `view, confirmed, pending, status, tip, epoch, mine, unsaved, extra, clientId, projectId, author, others`.
- Внутри: локальный журнал (`loadLocal` ≈1112, `scheduleWrite`/`writeNow`/`flush`; две записи: `<id>` — очередь и хвост раз в 200 мс, `<id>#doc` — документ не чаще 1,5 с); сеть (`http` с повторами 503/429, `checkHealth`, `loadFromServer`, `catchUp` ≈1384, `gone`, `adoptSnapshot`); сокет (`connect` ≈1785, `handleMessage` ≈1977 — hello/tx/ack/gone/error/presence/project, `takeCommitted` ≈1486, `takeAck`, `sendNext`/`armInflight` — одна транзакция в полёте, `ACK_TIMEOUT`); переигрывание (`replayAll`, `replayGroup`, `applyConfirmed`, `requeueMine`); «кто помешал» (`journalAdd`, `whoFor`, `explainDropped`); присутствие (`presence`, сердцебиение 15 с, `sweepOthers`); `commit(opsList, meta)` ≈2234.

## Инварианты
- Правки не теряются: при смене эпохи (4410) реплика берёт снимок и переигрывает очередь и `mine` прежней эпохи с `replay_of_epoch`/`replay_at`; сервер узнаёт уцелевшие по tx_id, потерянные пишет заново, старое не затирает новое чужое (`dropped: stale`); старше суток — не переигрываются, человеку сказано.
- Подтверждение своей в предсказанной форме — без переигрывания (быстрый путь круга 27).
- Строки правки чистятся (U+0000, одиночные суррогаты), глубина значений ≤ 64, `command_id` ≤ 128 — как на сервере, иначе транзакция «отравит» очередь.
- Хранилище сервера недоступно — `status.storage:'down'`, правка ждёт, не снимается как отравленная.

## Подводные камни
- Числа в `LIMITS` — копия серверных; менять вместе с `server/document/limits.js`.
- Сокет открыт, а hello нет за `HELLO_TIMEOUT` — это не сервер (или зомби): закрыть и переподключиться.
- Прежний сервер вместо `ack` шлёт `error duplicate` — реплика понимает оба.

## Отладка
`node --test test/sync.test.mjs test/sync-r27.test.mjs test/sync-r29.test.mjs test/sync-r31.test.mjs test/sync-r33.test.mjs test/sync-r41.test.mjs`; с живым сервисом — `test/server/resilience.test.mjs`, `rollback.test.mjs` (Postgres).

## Ссылки
- SPEC: §8.3, §9.1, §9.3, §9.5, §9.8, §9.9, §9.10, §9.13–§9.18
- Тесты: `test/sync*.test.mjs`, `test/shell-r39/r41/r43`, `test/server/hardening`, `presence`, `resilience`, `rollback`, `load.mjs`
