# Orchestrator

Процесс «агент» из SPEC §8.1: ведёт команду человека по шагам 3–13 с доски. Контракт —
SPEC §10 (нормативен и для клиента `src/agent.js`). Node 22, `node:http`, без фреймворков и
без новых зависимостей. **К базе не прикасается**: стейт читает у Document service
(`GET /api/projects/:id`, дальше `…/ops?since=`), пишет транзакцией (`POST …/tx`) с
`author_kind:'agent'`. Движок, промпты и компилятор патча — те же `src/core.js` и
`src/brain.js`, что работают в браузере.

```
server/orchestrator/
  index.js        вход: окружение, сборка модулей, SIGTERM/SIGINT; export start(opts)
  http.js         маршруты §10.2, SSE §10.3, лимит тела 1 МБ, единое тело ошибки
  pipeline.js     шаги jev → read → library → llm/validate → write → result; очередь на проект; стоп; варианты + apply
  jev/            «оболочка или модель»: recognizeAction/recognizeVariants из brain + узкий перенос shellIntent из app.js
  dslr/           чтение стейта: кеш {seq, doc, chain, epoch}, хвост ops?since=&tip=&epoch= по `more`, сброс при откате базы
  duil/           срез библиотек: проекты kind=library → внешний словарь в прогон brain (library)
  dslv/           пул worker_threads: прогон brain (план → патч → операции → раскладка → validate → починка)
  llm/            провайдер модели: OpenAI-совместимый или Anthropic; URL-сборка, redact ключей
  dslts/          запись транзакции: пределы до сети (413), повтор с тем же tx_id, 503 + Retry-After, 426
  docclient.js    fetch до Document service с дедлайном; сеть/5xx → document_down
  traces.js       трассы §10.4 → POST /api/internal/traces (X-Internal-Token)
  errors.js       OrchError {status, code, message, retryable, detail?}
  limits.js       пределы и умолчания
```

## Запуск

```sh
# Document service рядом (см. server/document/README.md)
npm run server                                    # :8080

# агент с локальной моделью (LM Studio, Ollama, vLLM — любой OpenAI-совместимый)
LLM_BASE_URL=http://127.0.0.1:1234/v1 npm run orchestrator          # :8090

# агент с Anthropic
LLM_KIND=anthropic LLM_API_KEY=... LLM_MODEL=claude-sonnet-4-5 npm run orchestrator

curl -s localhost:8090/agent/health
curl -N -X POST localhost:8090/agent/command -H 'content-type: application/json' \
  -d '{"command_id":"c1","project":"<id>","text":"собери экран тарифов"}'
```

| переменная | по умолчанию | что |
|---|---|---|
| `PORT` / `HOST` | `8090` / `0.0.0.0` | адрес HTTP |
| `DOCUMENT_URL` | `http://127.0.0.1:8080` | Document service |
| `INTERNAL_TOKEN` | — | заголовок `X-Internal-Token` для трасс; не задан — трассы только в памяти |
| `LLM_KIND` | `openai` | `openai` или `anthropic` |
| `LLM_BASE_URL` | — | адрес API модели; не задан — `llm:'unconfigured'`, команды для модели → `503 llm_down` |
| `LLM_MODEL` | первая из `/models` | имя модели |
| `LLM_API_KEY` | — | ключ; наружу не выводится нигде |
| `LLM_TIMEOUT_MS` | `120000` | дедлайн одного запроса к модели |
| `WORKERS` | `min(2, CPU)` | размер пула DSLV |
| `WORKER_MAX_MB` | `512` | потолок кучи воркера (`resourceLimits`) |
| `WORKER_TIMEOUT_MS` | `60000` | счётное время прогона (ожидание модели не считается) |
| `QUEUE_MAX` | `4` | ждущих команд на проект; больше — `429 busy` |

Адрес модели собирается через `URL`: суффикс (`chat/completions`, `models`, `v1/messages`)
дописывается к пути, query базы идёт после него (`…/v1/chat/completions?api-version=…`).
Учётные данные в адресе (`http://user:pass@host/v1`) вынимаются в `Authorization`
(`Basic`, или `Bearer <user>` без пароля); `LLM_API_KEY` важнее. Всё, что уходит в ответы,
события, трассы и лог, проходит `redact` (ключ, пароль, значения query, любые userinfo).

## Как устроено

* **Порядок команды.** `jev` (без сети) → проверка перед стартом (Document service жив;
  модель жива, если нужна — иначе HTTP `503` с `Retry-After` до открытия потока) → очередь
  проекта (`queued {position}`) → `read` → `library` → `llm`/`validate`/`repair` (стадии brain
  из воркера) → `write` → `result` → `done`. Команда оболочки: `stage jev` → `shell` → `done`,
  модель не зовётся, очередь не занимается.
* **Воркеры.** `runCommand` монолитен (раскладка и проверка между вызовами модели), поэтому
  в воркере идёт весь прогон brain. Модель воркер **не зовёт сам**: его провайдер — посредник,
  вызов уходит сообщением в главный поток, где ключ, сеть, кеш здоровья и общий AbortSignal
  команды. Так ключ не покидает главный поток, упавший воркер не оставляет висящих
  соединений, а таймаут меряет только счёт (часы стоят, пока ждём модель). Воркер упал или
  вышел за память → `error worker_failed`, вышел за время → `error timeout`; воркер
  заменяется, процесс живёт.
* **Стоп.** `POST /agent/stop` → AbortSignal: ждущая команда снимается из очереди, вызов
  модели прерывается сразу (гонка с сигналом в воркере), счёт — через `abort` воркеру (не
  ответил за 2 с — воркер снимается). Если запись уже ушла, она доводится.
* **Разрыв SSE** команду не отменяет: поток просто перестаёт писать, транзакция приходит
  клиенту по сокету Hub.
* **Варианты.** `runVariants` → `variants {base_seq, items}` (превью — сами операции: клиент
  накладывает их своим движком); набор живёт в памяти 15 минут по `command_id`;
  `POST /agent/apply {command_id, variant}` пишет выбранный через ту же очередь проекта.
  Повтор того же выбора — та же запись; другой вариант после выбора — `400`.
* **Чтение (SPEC §10.6).** Кеш стейта хранит chain своей головы и эпоху; хвост —
  `ops?since=&tip=&epoch=` страницами до `more:false`. 410, другая эпоха, чужой chain у
  пришедшей записи, голова позади кеша — кеш проекта выбрасывается, стейт читается целиком:
  после отката базы агент строит патч по новому журналу, а не по закешированному.
* **Запись.** `tx_id = core.uid('tx')`, `base_seq` = голова прочитанного стейта,
  `author:'Агент'`, `author_kind:'agent'`, `client` — вкладка, приславшая команду (её
  `sync.js` пометит транзакцию как «свою»), `title` — заголовок плана, `engine`. Больше 5000
  операций или 4 МБ — `too_large` до сети, без частичной записи. Сеть или 5xx → повтор с тем
  же `tx_id` (до 3 раз; у 503 — по `Retry-After`, не дольше 5 с за раз); 413 — `too_large`,
  426 — `engine`, без повтора. «Менять нечего» (`nothingChanged`) не пишется.
* **Библиотеки.** DUIL отдаёт в прогон brain выжимки проектов `kind:'library'`
  (`runCommand({library})`): имена документа главнее, использованный мастер переносится в
  библиотеку документа той же транзакцией (`result.libraryAdded`).
* **Трассы.** После каждой команды: шаги и длительности, число вызовов и токены модели,
  `tx_id/seq`, код ошибки — без промптов, ответов модели и ключей. Нет эндпойнта (`404`) или
  сети — одна строка в лог, команда не замечает. Последние 100 — в памяти (`svc.traces.recent()`).
* **Останов** (`SIGTERM`/`SIGINT`): новые соединения не принимаются, новые команды — `503
  shutting_down`, выполняемые доводятся до 10 с, потом прерываются; потоки закрываются,
  воркеры снимаются, трассы дописываются.

## Тесты

`test/orchestrator/*.test.mjs` поднимают настоящий Document service в памяти и поддельную
OpenAI-совместимую модель (ответы — заготовки по `SCHEMAS` brain), порты случайные.
