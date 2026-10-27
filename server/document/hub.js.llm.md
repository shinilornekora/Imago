# `server/document/hub.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Hub — рассылка транзакций и присутствия по WebSocket (SPEC §8.1, §9.3, §9.8, §9.9). Протокол `/ws?project=&since=&client=[&author=][&tip=][&epoch=]`; шапка файла — подробное описание сообщений, читать её первой.

## Главное
- `createHub({...})` (≈110) → `{wss, roomSize, roomCount, cachedFrames, cacheBytes, remotePresence, presenceStats, framesSerialized, busyRefused, sweepPresence, close}` (≈939).
- Подключение: `onConnection` (≈793) → `acquireConnecting` (не больше maxConnecting сокетов до hello) → `join` → hello `{epoch, tip}` → догон (`pump`/`runPump`, ≈617) → живой поток.
- Сообщения клиента: `onMessage` → `onTx` (≈692, то же, что `POST …/tx`) или `onPresence`.
- Рассылка: `onEvent` (≈357) от секвенсора → `deliverTx`/`sendTx`; кадр tx — один Buffer на событие (`frameOf`, кеш по `seq:chain`, `evictOldest`/`clearFrames`).
- Присутствие: `presenceBody`, `schedulePresence`/`flushPresence`, `relay` (между экземплярами через шину хранилища: pg NOTIFY `<channel>_presence`), `onBus`, `sweepPresence` (TTL), `withdraw` (left/bye).
- Эпоха: `closeEpoch` — сокеты со старой эпохой закрываются 4410, кеш кадров проекта чистится.
- Ошибки: `errorMessage`, `fail`, `sendGone`. Коды закрытия `CLOSE`: 4400 bad, 4404 notFound, 4410 epoch, 4503 unavailable.

## Поток данных
dslts.js (события Committed, смена эпохи) → Hub → сокеты комнаты; клиент (src/sync.js) → tx/presence → dslts / шина присутствия.

## Инварианты
- По одному сокету tx идут с возрастающим seq без пропусков. Сокет входит в комнату ДО чтения хвоста; живые tx во время догона копятся и досылаются с фильтром `seq > последнего отправленного`; дыра закрывается дочитыванием из базы.
- Медленный читатель (> `MAX_BUFFERED` 32 МиБ неотправленного) закрывается 4503 и догоняет сам.
- Сбой хранилища в догоне после hello — `error unavailable` и повтор (`PUMP_RETRIES`), не закрытие.

## Подводные камни
- Прежний клиент без `tip/epoch/proto` не знает `ack`: ему на повтор — `error duplicate`, иначе его очередь вставала.
- `author` — из query, из presence или из последней tx: браузер не ставит заголовки при upgrade.
- Выделение в присутствии режется до 200 id и под предел NOTIFY (< 8000 байт) → `truncated:true`.

## Отладка
`node --test test/server/presence.test.mjs test/server/hardening.test.mjs test/server/backpressure.test.mjs`.

## Ссылки
- SPEC: §8.1, §9.3, §9.8, §9.9, §9.10, §9.13
- Тесты: `test/server/presence`, `backpressure`, `hardening`, `round27`, `round29`, `round31`
