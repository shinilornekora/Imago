# SPEC — экспериментальный стенд «Управление клиентским состоянием веб‑редактора макетов при частичной загрузке»

Единый источник требований для всех исполнителей. Извлечён из введения и главы 1 диссертации
(Орлов А. В., «Проектирование системы управления клиентским состоянием веб‑редактора макетов при
частичной загрузке данных»). Ссылки вида «§1.2» указывают на разделы главы 1. Всё, что здесь
записано, обязательно; отклонения фиксируются в `docs/DEVIATIONS.md` с причиной.

Язык кода и идентификаторов — английский; README, отчёты, комментарии к решениям — русский.

---

## 0. Среда песочницы (уже проверено оркестратором)

| Компонент | Есть | Примечание |
|---|---|---|
| Node.js 24 LTS | `/opt/node24/bin/node` (v24.21.0) | использовать его: `export PATH=/opt/node24/bin:$PATH`. Системный node 22 не использовать для стенда |
| PostgreSQL 16 | кластер `16/main`, порт 5432, `wal_level=logical`, пользователь `postgres`/`postgres`, БД `editor` | глава просит 17; Zero требует ≥15 — отклонение фиксируется |
| Docker | клиент есть, демона нет | compose‑файлы и Caddyfile создаём, но в песочнице сервисы запускаются процессами через `scripts/` |
| Playwright | Chromium build 1194 в `/opt/pw-browsers` → npm‑пакет **`playwright@1.56.0`** (pin!) | не запускать `playwright install` |
| tc/netem | недоступен (ядро без sch_netem) | сетевые условия эмулируются собственным TCP‑шейпером `packages/netshaper` |
| @rocicorp/zero | latest = **1.9.0** (линия из §1.4) | pin точной версии |
| Python 3.11 | есть | эталон и анализ |
| CPU/RAM | 2 vCPU, 7 ГиБ | клиент и сервер на одной машине — отклонение от §1.2 |

## 1. Предметная модель (§1.1)

```
Document { id, ownerId, name, revision:int }
Page     { id, documentId, index:int, name }
Shape    { id, documentId, pageId, kind:'rect'|'ellipse'|'text', x,y,w,h, z:int, text:string|null,
           fill:string(#rrggbb), isSource:boolean, sourceId:string|null, fillOverridden:boolean }
```

* `isSource=true` — фигура‑источник компонента (лежит на какой‑то странице, обычно на странице «библиотека»).
* `sourceId≠null` — экземпляр источника. Экземпляр без переопределения (`fillOverridden=false`) всегда имеет `fill` источника.
* Локальная заливка экземпляра ставит `fill` и `fillOverridden=true`. Совпадение локального цвета с цветом источника **не** снимает переопределение (§1.1).
* Команда «общая заливка источника» меняет `fill` источника и всех экземпляров с `sourceId=источник` и `fillOverridden=false` — на всех страницах, включая незагруженные клиентом (§1.1, рис. 2).
* Состав фигур и принадлежность страницам во время опыта фиксированы; команд создания/удаления нет.
* Идентификаторы устойчивы (UUID или детерминированные строки из генератора) — интерфейс обращается к документу только через них.

## 2. Серверный контракт (§1.2, §1.6)

Общий для всех адаптеров. HTTP — Fastify 5, JSON‑схемы на вход/выход. Все SQL — явные (без ORM).

### 2.1 Аутентификация (§1.2, §1.6)
* `POST /api/auth/login {login,password}` → `{token, userId, expiresIn}`; токен короткоживущий (15 мин, JWT HS256), хранится **только в памяти клиента**.
* Две тестовые учётные записи: `alice`/`alice-pass`, `bob`/`bob-pass`. У каждой свои документы.
* Все маршруты, кроме login и health, требуют `Authorization: Bearer`. Сервер определяет пользователя по токену; `documentId` из браузера не является доказательством доступа. Чтение чужого документа → 403; команда над чужим источником/экземпляром → 403.
* Тот же токен передаётся Zero (`auth` в конструкторе Zero) и проверяется на сервере в обработчиках query/push.
* Секрет подписи — только из переменных среды сервера.

### 2.2 Чтение
* `GET /api/documents` → список своих документов `{id,name,revision,pageCount,shapeCount}`.
* `GET /api/documents/:docId` → `{id,name,revision,pages:[{id,index,name}]}` — метаданные страниц доступны с начала сеанса (§1.1).
* `GET /api/documents/:docId/pages/:pageId` → `{documentId,pageId,revision,shapes:[Shape…]}` — ревизия и фигуры читаются **в одной транзакции** (`REPEATABLE READ`), чтобы снимок был согласован.
* `GET /api/operations/:opId` → `{opId,status:'done', result}` либо 404 — проверка после неопределённого сетевого ответа (§1.2).
* `GET /api/health`.

### 2.3 Команды (§1.2)
`POST /api/documents/:docId/commands`
```
{ opId:uuid, type:'setSourceFill'|'setLocalFill', targetId:shapeId, fill:'#rrggbb', expectedRevision:int }
→ 200 { opId, revision:int, affectedPages:[pageId…], affectedShapes:int }
```
* Сервер: проверяет права → проверяет `expectedRevision == document.revision` (иначе 409 `revision_mismatch`) → выполняет изменение → `revision+1` → пишет запись в `operations` — **всё в одной транзакции**.
* Идемпотентность: таблица `operations(op_id PK, document_id, params_hash, result jsonb, created_at)`. Повтор с тем же `opId` и теми же параметрами → тот же результат (200, без второго изменения). Тот же `opId` с иными параметрами → 409 `op_conflict`. Записи живут 24 ч (`created_at` + очистка).
* `setSourceFill`: target — источник; затрагиваются источник + непереопределённые экземпляры. `affectedPages` — уникальные страницы изменённых фигур.
* `setLocalFill`: target — экземпляр (или обычная фигура); ставит `fill`, `fillOverridden=true`; `affectedPages=[его страница]`.
* Предметный модуль `packages/server/src/domain/` имеет **малый интерфейс транзакции** (§1.6): `readRevision()`, `updateSourceAndInstances()`, `updateShapeFill()`, `writeOperation()`. HTTP‑обработчик и Zero‑мутатор подключают к нему свои транзакционные контексты. Эталон этот модуль **не использует**.
* Тестовый хук для проверок (только при `STAND_TEST_HOOKS=1`): `POST /api/test/delay {pathPattern, ms}` — задержка ответа чтения (для проверки «ответ старого чтения»), и `POST /api/test/reset {docId}` — восстановление исходных заливок и ревизии из снимка генератора (для сброса между прогонами). Хуки не входят в измеряемый путь.

### 2.4 Zero (§1.4, §1.6)
* Схема Zero: таблицы `documents`, `pages`, `shapes` (те же колонки, snake_case в БД → camelCase в схеме).
* Права чтения: пользователь видит только свои документы/страницы/фигуры (permissions по `owner_id` через JWT `sub`).
* Мутаторы `setSourceFill`, `setLocalFill` — **серверная реализация** через push‑endpoint `POST /api/zero/push` в том же Fastify, вызывающая общий предметный модуль внутри транзакции и записывающая результат операции. Клиентская (оптимистичная) часть мутатора допустима, но **завершение команды в основной серии — только по актуальному холсту после серверных данных** (§1.6).
* zero‑cache самостоятельный, в одной машине с API и PostgreSQL; его CPU/память/диск входят в серверный бюджет (§1.2).

## 3. Схема БД (§1.5)

```sql
users(id text pk, login text unique, password_hash text)
documents(id text pk, owner_id text→users, name text, revision int not null default 0)
pages(id text pk, document_id text→documents, index int, name text)          -- индекс (document_id, index)
shapes(id text pk, document_id text, page_id text→pages, kind text, x,y,w,h double, z int,
       text text, fill text, is_source bool, source_id text null, fill_overridden bool)
       -- индексы: (page_id), (source_id), (document_id)
operations(op_id text pk, document_id text, params_hash text, result jsonb, created_at timestamptz)
```
Все таблицы — с `PRIMARY KEY` (нужно Zero). Ревизия документа — единственный источник истины о версии.

## 4. Клиент (§1.5, §1.6)

* Vite + React 19 + TypeScript (strict). Сборка `vite build`; измерения — на production‑сборке, отдаваемой сервером/шейпером (dev‑сервер не участвует).
* Интерфейс хранит выбранную страницу, выделение и неподтверждённый ввод; адаптер — данные. Панель страниц, панель заливки (локальная / источника), индикаторы состояния (loading / ready / error / pending‑command), логин/выход.
* Один модуль Canvas 2D рисует **только активную страницу** (rect/ellipse/text). Одинаков для всех адаптеров.
* Конфигурация через query‑параметры: `?adapter=H|Q|Z&mode=F|P&cache=1|3|10&doc=<id>`.

### 4.1 Общий интерфейс адаптера
```ts
interface DataAdapter {
  open(docId): Promise<DocMeta>;                 // метаданные страниц; в F запускает загрузку всех страниц (активная — приоритет)
  selectPage(pageId): void;                      // переключение; в P — загрузка при отсутствии, LRU‑окно cache для неактивных
  subscribePage(pageId, cb:(snap:PageSnapshot|null)=>void): Unsubscribe; // снимок {revision, shapes} или null пока нет полного набора
  runCommand(cmd): Promise<CommandResult>;       // через HTTP (H,Q) или мутатор (Z)
  getRetained(): {pages:number, shapes:number, bytesEstimate?:number}; // ФАКТИЧЕСКИ удерживаемые записи во внутреннем хранилище
  logout(): Promise<void>;                       // очистка памяти и постоянного хранилища
}
```
* **H**: `fetch` + `Map<pageId, {status, revision, shapes, generation}>`; дедупликация одновременных запросов; отмена (AbortController) при смене страницы; поздний ответ прежней страницы не активирует её (поколения загрузки); индекс `shapeId→shape`; уведомление подписчиков по странице. После команды — обновление затронутых страниц из `affectedPages` (активная — немедленно; неактивные в кеше — пометка «устарела» и перечитывание при следующем открытии; в F — перечитывание всех затронутых).
* **Q**: TanStack Query 5, ключ `['doc', docId, 'page', pageId]`; `staleTime`, `gcTime`, `retry`, `refetchOnWindowFocus:false`, `refetchOnReconnect:false` заданы **явно** и зафиксированы в `docs/PASSPORT`; после команды `invalidateQueries` по `affectedPages` (включая неактивные); в P окно кеша обеспечивается явным `removeQueries` сверх LRU‑окна и проверяется через `getRetained()` (queryCache).
* **Z**: `@rocicorp/zero` 1.9.0, `kvStore` задан явно (по умолчанию `idb` — постоянное хранилище учитывается в метриках; при отсутствии возможности измерить — `mem`, с записью в DEVIATIONS); запрос страницы `shapes.where('pageId', id)`; в P — materialized view активной + LRU‑окно; `ttl` запросов задан явно; после серверной команды данные приходят синхронизацией; готовность команды — когда снимок активной страницы содержит новые заливки **и** результат операции получен.
* Режим **F**: при открытии запрашиваются все страницы; активная получает приоритет; параллелизм фиксирован (например, 4) и одинаков для H/Q; для Z — подписки на все страницы.
* Режим **P**: активная страница + LRU‑окно `cache` недавно посещённых; освобождение данных выполняется реально (H — `Map.delete`, Q — `removeQueries`, Z — уничтожение view + `ttl`) и наблюдается через `getRetained()`.
* Предварительная загрузка в основной серии отключена.

### 4.2 Контракт готовности (для Playwright, §1.5)
Глобальный объект `window.__stand`:
```ts
{
  config: {adapter, mode, cache, docId},
  state: 'idle'|'loading'|'ready'|'error',
  activePageId, activeRevision,
  drawn: {pageId, revision, shapeCount, at: performance.now()}, // после фактической отрисовки (rAF после draw)
  pendingCommands: number,
  events: Array<{t:number, type:string, detail}>,            // журнал: page-select, page-ready, command-sent, command-acked, command-drawn, error
  waitFor(type, predicate?, timeoutMs?): Promise<event>,
  getRetained(), getPageSnapshot(pageId): {revision, shapes:[{id,fill,fillOverridden}]}|null,
  getLoadedPages(): pageId[], logout(), transfer: {bytesIn, bytesOut} // если измеримо на клиенте
}
```
* «Страница готова» = получен **полный** набор фигур страницы с ревизией ≥ последней подтверждённой команды **и** холст отрисован (§1.2, рис. 3). Пустая страница тоже может быть готова. Предварительный/частичный результат (например, `type:'unknown'` в Zero или пустой набор во время загрузки) готовностью не считается.
* «Команда завершена» = сервер подтвердил (`command-acked`) **и** активная страница отрисована с новыми значениями (`command-drawn`). Оба момента пишутся отдельно.

## 5. Генератор документов (§1.2, введение)

`packages/generator`: параметры `--pages --shapesPerPage --sources --instancesPerSource --overrideShare --seed --owner --name`; детерминированно (seed). Приёмочный документ: **50 страниц × 500 фигур**; источники живут на странице «library»; есть источник `S*`, у которого **100 экземпляров на 10 страницах** (в т. ч. на странице 50 — и изменяемые, и локально переопределённые). Экспорт документа в JSON (`data/<name>.json`) с контрольной суммой и версией; загрузка в PostgreSQL; снимок исходных заливок для `reset`. Также малые документы (например, 5×100, 10×200), 100×500, 50×1000.

## 6. Эталон и функциональные проверки (§1.2, §1.7, §1.8)

* `packages/reference` (Python, без общих модулей с сервером): по JSON документа и списку команд вычисляет ожидаемое состояние (fill/fillOverridden всех фигур, ревизию). Сравнение: (а) с БД (`psql` → JSON), (б) со снимками страниц клиента (`getPageSnapshot`) для посещённых страниц. Любое расхождение = провал допуска конфигурации.
* Playwright‑проверки по таблице 1, для **каждой из 6 конфигураций**:
  1. Открытие страницы — все фигуры доступны и отображены; предварительный набор не считается полным.
  2. Локальная заливка — цвет изменён, переопределение сохранено; повторная загрузка страницы (переход туда‑обратно, а в P — вытеснение из окна) не отменяет настройку.
  3. Общая заливка источника — все непереопределённые экземпляры изменены, включая незагруженные страницы (проверка по эталону через БД и через поздний переход).
  4. Поздний переход — открытая позже страница уже учитывает команду.
  5. Ответ старого чтения — задержанный ответ чтения (тестовый хук/route delay), пришедший после команды, не восстанавливает устаревший цвет.
  6. Повтор команды — при обрыве ответа (Playwright `route.abort` после отправки) клиент повторяет с тем же `opId`, в журнале одна операция, ревизия +1, один результат.
* Безопасность: чтение чужого документа → 403 (HTTP и через Zero — чужие данные не приходят); команда над чужим источником → 403/отклонение; после `logout` — память адаптера пуста, `localStorage/sessionStorage/IndexedDB` данного приложения очищены.
* Критерий допуска к измерениям (§1.7): все проверки пройдены; конфигурация с воспроизводимой ошибкой к серии не допускается.

## 7. Измерения (§1.2, §1.8)

### 7.1 Сеть
`packages/netshaper` — TCP‑прокси: задержка **25 мс в каждую сторону (RTT 50 мс)**, полоса **20 Мбит/с** (token bucket) в каждую сторону, потерь нет; отдельная серия RTT 150 мс. Через него проходит **весь** трафик клиента: статика, HTTP API и WebSocket zero‑cache. Клиент открывает `http://127.0.0.1:<shaperPort>`; шейпер направляет на Caddy‑подобный маршрутизатор (или напрямую: `/api` → Fastify, `/zero` → zero‑cache, остальное → статика). Байты считаются на шейпере per‑run (in/out) — это «объём обмена».

### 7.2 Приёмочный сценарий (§1.2)
Документ 50×500. Холодный клиент (новый browser context, пустое хранилище). Открыть документ на странице 1; десять переходов: **2, 3, 1, 4, 2, 5, 1, 6, 3, 50**; **после пятого перехода** (прибытие на страницу 2 второй раз) — `setSourceFill` источника со 100 экземплярами на 10 страницах; на странице 50 проверяются изменённые и переопределённые экземпляры (снимок сверяется с эталоном). Между действиями пауза **1 с** (после готовности предыдущего действия).

### 7.3 Метрики на прогон
* `t_first_ready` — от navigation start до готовности страницы 1.
* `t_nav[i]` — от клика по странице до готовности (10 значений; отдельно «новая страница» и «возврат»).
* `t_cmd_ack`, `t_cmd_drawn` — от отправки команды до подтверждения и до актуального холста.
* `t_scenario` — общее время, включая объявленные паузы; успех = `t_scenario ≤ 30 с` и все проверки эталона прошли.
* `bytes_in/out` — по шейперу; дополнительно по CDP (`Network.*`) для перекрёстной проверки.
* `js_heap_peak`, `js_heap_end` (CDP `Runtime`/`performance.memory`), `client_storage_bytes` (IDB/localStorage оценка).
* `chromium_private_peak` — сумма частной памяти **всех процессов** выделенного экземпляра Chromium (`/proc/<pid>/smaps_rollup` → Private_Clean+Private_Dirty, опрос 250 мс); бюджет 768 МиБ.
* `server_cpu_ms` и `server_mem_integral` (МиБ·с) по процессам API, PostgreSQL, zero‑cache (`/proc`, 250 мс); диск реплики zero‑cache.
* `retained_pages`, `retained_shapes` после каждого шага (`getRetained()`), плюс `loaded_pages`.
* Ошибки/прерывания фиксируются как отдельные исходы, не отбрасываются молча.

### 7.4 План серий
* Основная: 6 конфигураций (H/Q/Z × F/P, cache=1), **≥30 повторений**, порядок конфигураций перемешан (seed), сброс состояния перед каждым прогоном (`reset` документа + новый контекст браузера + очистка кешей; для Z — новый контекст → пустое IDB).
* Дополнительные (могут быть с меньшим числом повторений, но ≥10; указать): cache=3 и 10 (P‑конфигурации); малые документы; 100 страниц; 1000 фигур/страницу; RTT 150 мс.
* Бюджеты (§1.2): first‑ready ≤ 2 с, переход ≤ 1 с, команда до холста ≤ 2 с (медианы), сценарий ≤ 30 с в ≥95 % прогонов (с интервалом Уилсона), Chromium ≤ 768 МиБ, сервер ≤ 4 vCPU/8 ГиБ/40 ГиБ.
* Паспорт серии (`docs/PASSPORT.md` + `results/<series>/passport.json`): CPU, ОС, ядро, версии Node/PostgreSQL/Chromium/пакетов (из lock‑файла), параметры шейпера, настройки адаптеров (staleTime/gcTime/ttl…), seed, дата.

### 7.5 Анализ
`packages/analysis` (Python): медианы, p95, интервалы (бутстреп), доля успеха с интервалом Уилсона, изменение метрики **внутри адаптера** (P−F и P/F) и сопоставление этого изменения **между адаптерами** (§1.8); графики (matplotlib, PNG); таблицы Markdown; сравнение удерживаемых записей с объявленным окном кеша; выводы об условиях применимости частичной загрузки. Результат — `docs/results/RESULTS_<серия>.md` и сырые `results/**/*.csv|json`.

## 8. Инфраструктура (§1.5, §1.9)

* `infra/docker-compose.yml` с профилями `h`, `q`, `z` (api, postgres, zero‑cache, caddy), `infra/Caddyfile`, `.env.example`, закреплённые образы. В песочнике не запускается (нет демона) — но должен быть валиден (`docker compose config`).
* `scripts/`: `start-db.sh`, `start-api.sh`, `start-zero.sh`, `start-shaper.sh`, `reset.sh`, `run-functional.sh`, `run-series.sh` — запуск всего стенда процессами.
* Root `README.md` (рус.): воспроизведение с нуля; `docs/DEVIATIONS.md`; `docs/PASSPORT.md`.

## 9. Структура репозитория

```
stand/
  package.json            # npm workspaces, engines node>=24
  packages/shared/        # типы, протокол, константы
  packages/server/        # Fastify 5, pg, domain/, routes/, zero/ (schema, push)
  packages/client/        # Vite+React, adapters/{h,q,z}, canvas/, stand.ts (window.__stand)
  packages/generator/     # генерация/загрузка/экспорт документов
  packages/netshaper/     # TCP‑шейпер + маршрутизатор
  packages/bench/         # Playwright: functional/, scenario/, series/, sampling (proc), results/
  packages/reference/     # Python‑эталон
  packages/analysis/      # Python‑анализ и графики
  infra/                  # compose, Caddyfile
  scripts/                # запуск в песочнице
  docs/                   # DEVIATIONS, PASSPORT, RESULTS, REPORT
  data/                   # сгенерированные документы (json + checksum)
  results/                # сырые измерения по сериям
```

## 10. Что нельзя делать
* Не подменять Zero/Query «своей реализацией ради показателя» (§1.7). Не менять требования задним числом (§1.2).
* Не считать команду завершённой по оптимистичной окраске (§1.6).
* Не использовать серверный предметный модуль в эталоне (§1.6).
* Не обновлять зависимости между сериями; версии — pin в lock‑файле.
