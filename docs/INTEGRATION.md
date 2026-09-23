# INTEGRATION — сборка стенда из процессов и дымовые прогоны H/Q

Как поднять весь стенд в песочнице (без Docker), как запустить один сценарий и серию, куда
попадают результаты, и какие числа дали дымовые прогоны адаптеров H и Q через шейпер.
Дата: 2026‑09‑12, порядок запуска и пути выверены 2026‑09‑14 (по программе 2).
Все команды — из корня репозитория, `export PATH=/opt/node24/bin:$PATH`.

> **Статус чисел в этом документе.** Разделы 1–4 и 6 — процедурные (команды, порты, пути, группы
> процессов), они актуальны для программы 2. **Все измеренные величины в §5 получены в ПРЕЖНИХ
> условиях стенда** — другая ёмкость token bucket (40 мс вместо 20), клиентская сборка без
> разделения bundle по адаптерам и прежняя (дефектная) семантика `t_cmd_drawn` у Z, когда
> `command-drawn` выпускался из обработчика `command-acked`. Сравнивать их с числами программы 2
> **нельзя**: они оставлены как история решения о разделении bundle, а не как результат. Опорные
> числа стенда — в `docs/DEVIATIONS.md` 2.2 (моменты команды), 3.1 (размеры сборки и разложение
> обмена), 4.3–4.4 (кеш, `docMeta`), план серий — `docs/PASSPORT.md` §7, результаты —
> `docs/results/FINDINGS.md` и `docs/results/RESULTS_<серия>.md`.

## 1. Порядок запуска и порты

| Шаг | Команда | Порт | pid / лог |
|---|---|---|---|
| 0 | `npm install && npm run build` (shared → server → client; клиент можно отдельно: `npm run build -w packages/client`) | — | — |
| 1 | `scripts/start-db.sh` (+ первый раз `scripts/migrate.sh`, `scripts/gen-all.sh`) | 5432 | кластер `16/main`, БД `editor` |
| 2 | `scripts/start-api.sh --build` — Fastify API, `STAND_TEST_HOOKS=1`, отдаёт `packages/client/dist` с `/` | 3000 | `results/logs/api.pid`, `api.log` |
| 3 | `scripts/start-zero.sh` — zero‑cache 1.9.0 (только для адаптера Z; API должен быть уже запущен) | 4848 | `results/logs/zero.pid` (= `zero-cache.pid`), `zero-cache.log`, реплика `results/zero-replica/` |
| 4 | `scripts/start-shaper.sh` — сетевой шейпер: `/api` → :3000, `/zero` → :4848, `/` → :3000 (статика) | 8080 (клиент), 8081 (статистика) | `results/logs/shaper.pid`, `shaper.log` |

Остановка: `scripts/stop-shaper.sh`, `scripts/stop-zero.sh`, `scripts/stop-all.sh` (api, zero, shaper; PostgreSQL не трогает).

Важно:

* API читает каталог `packages/client/dist` **при старте** — если клиент собран после запуска API,
  корень `/` отвечает 404 (`static client serving … enabled:false` в `api.log`). Пересобрали клиент → перезапустите API.
* Шейпер: `--delay-ms 25` (RTT 50 мс), `--bandwidth-mbit 20`, token bucket `--bucket-ms 20` (≈50 КБ
  всплеска; до 2026‑09‑12 вечера было 40 мс ≈ 100 КБ — числа §5 ниже получены при 40 мс, `docs/DEVIATIONS.md` 1.5). Параметры серии оболочка выставляет сама через `POST :8081/config` перед каждым прогоном
  (серия `rtt150` → 75 мс), счётчики обнуляет `POST :8081/reset`. Переменные `start-shaper.sh`:
  `STAND_SHAPER_PORT`, `STAND_SHAPER_STATS_PORT`, `STAND_SHAPER_DELAY_MS`, `STAND_SHAPER_BANDWIDTH_MBIT`, `STAND_ZERO_PORT`.
* Браузер открывает только `http://127.0.0.1:8080/?adapter=H|Q|Z&mode=F|P&cache=1|3|10&doc=<id>&page=1&autologin=alice`;
  порт 3000 напрямую нужен оболочке лишь для хуков (`/api/auth/login`, `/api/test/reset`).
  **Пароль в URL не передаётся**: измерительная оболочка кладёт `{login, password}` в контекст
  страницы (`page.addInitScript` → `window.__standCredentials`) до загрузки документа, и это
  записано в каждый прогон (`credentialsVia = "page-context"`; дефект N9). `?pass=<пароль>` остался
  запасным каналом для функциональных проверок, которые идут мимо шейпера.
* Сброс документа между прогонами: `POST /api/test/reset {docId}` (оболочка делает это сама; вручную — `scripts/reset.sh [docId]`).
* На 2 vCPU не запускайте серию параллельно с другой тяжёлой работой (сборка, тесты, другой Chromium).

Документы в БД (`data/*.json` → `scripts/gen-all.sh`) — **девять**: `doc-acc-50x500` (приёмочный,
источник `doc-acc-50x500-src-1` — 100 экземпляров на страницах 2,7,12,17,22,28,33,38,43,50;
библиотека — страница 50), `doc-cmd-50x500` (документ серии `command-shape`: те же 50×500 и тот же
seed 50500, источники 1…20 совпадают с приёмочным побайтно, сверх них — три источника заданного
размещения `src-21`/`src-22`/`src-23`; `docs/DEVIATIONS.md` §4.12), **`doc-frac-25x500` и
`doc-frac-100x500`** (документы контролируемой оси размера `size-fraction-*`, пресеты `frac-25x500`
и `frac-100x500`; `docs/DEVIATIONS.md` §4.13), `doc-small-5x100`, `doc-small-10x200`,
`doc-large-100x500`, `doc-dense-50x1000`, `doc-bob-5x50`.
Страницы `doc-…-p<index>`, индексы с 1; источник S1 всегда `<docId>-src-1`. Состав всех девяти
сверяется предсерийной проверкой восстановления (`docs/PASSPORT.md` §8.4: 395 страниц,
215 250 фигур). `doc-large-100x500` и `doc-small-10x200` остаются в базе, но **в программе 2 не
измеряются**: серии `doc100x500` и `doc10x200` сняты с производства (§3).

## 2. Один сценарий (отладка)

```bash
export PATH=/opt/node24/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
scripts/reset.sh doc-acc-50x500
node packages/bench/src/scenario/cli.mjs --base http://127.0.0.1:8080 --adapter H --mode P --cache 1 \
     --doc doc-acc-50x500 --source doc-acc-50x500-src-1 --fill '#1e90ff' --out /tmp/run.json
```

Печатает сводку (`t_first_ready`, `t_nav[10]`, `t_cmd_ack/drawn`, `t_scenario`, JS‑куча, Chromium, CDP‑байты, retained).
Одиночный прогон не сбрасывает документ и не вызывает эталон.

Контракт `window.__stand` (SPEC §4.2) проверен через шейпер: кнопки `button[data-page-index][data-page-id]`,
события `page-select {pageId,index,seq}`, `page-ready {pageId,revision,shapeCount,seq}`,
`command-sent/acked/drawn {opId,…}`, `waitFor(type, predicate, timeoutMs, since)`, `getRetained()`,
`getPageSnapshot(pageId)`, `getLoadedPages()`, `transfer`. Оболочка сопоставляет страницу по `detail.pageId`
(индекс берёт из DOM `data-page-id`), поэтому отсутствие `pageIndex` в `detail` не мешает. Изменений в клиенте не потребовалось.

## 3. Серия

```bash
export PATH=/opt/node24/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
node packages/bench/src/series/run.mjs --config packages/bench/series/main.json --dry-run   # план + какие процессы попали в группы
node packages/bench/src/series/run.mjs --config packages/bench/series/main.json             # 6 конфигураций × 30
node packages/bench/src/series/run.mjs --config packages/bench/series/main.json --only H:P:1,Q:F:1 --repetitions 3
node packages/bench/src/series/run.mjs --config packages/bench/series/smoke.json --repetitions 2        # дымовая всех 6 конфигураций → results/smoke (каталог не хранится: перед измерениями удалён)
# smoke-hq.json — УСТАРЕВШАЯ дымовая H/Q (прежняя сборка без разделения bundle, ведро 40 мс).
# В SERIES_ORDER (scripts/run-all-series.sh) не входит, к текущим сериям не сравнима; см. §5.
node packages/bench/src/series/harness-check.mjs packages/bench/series/*.json                            # ОБЯЗАТЕЛЬНО перед программой: код 1 → рядом каталог, снятый ДРУГОЙ оболочкой
scripts/run-all-series.sh --estimate                                                                    # оценка времени всех серий
scripts/run-all-series.sh                                                                               # ПРОГРАММА 2 ЦЕЛИКОМ: 11 серий, 1 014 прогонов (packages/bench/README.md §4.3)
# --with-optional ДОБАВЛЯЕТ снятые серии cache10, doc10x200, doc100x500 — для программы 2 флаг НЕ нужен
node packages/bench/src/series/run.mjs --config packages/bench/series/size-fraction-25x500.json --only H,Q --repetitions 1
python3 -m analysis.report --series results/main --validate-only              # из packages/analysis: схема runs.csv (136 колонок)
python3 -m analysis.report --series results/main --out docs/results/RESULTS_main.md --figs docs/results/figs/main
```

Серия возобновляется тем же вызовом (уже выполненные `run_id` пропускаются) — но **только если её
каталог снят той же оболочкой**: `harness-check.mjs` даёт код 1, когда рядом лежит каталог с другим
`harness_id`, и такой каталог надо перенести в `results/archive/`, а не дописывать к нему прогоны
(`docs/PASSPORT.md` §7.2).

Конфигурации серий — `packages/bench/series/*.json`. **Программа 2** — это весь `SERIES_ORDER`
оркестратора: `main`, `size-fraction-25x500`, `size-fraction-50x500`, `size-fraction-100x500`,
`route-repeat`, `command-shape`, `route-full`, `rtt150`, `doc50x1000`, `doc5x100`, `cache3` —
одиннадцать серий, 1 014 прогонов, **один вызов `scripts/run-all-series.sh` без флагов**. Плюс
`smoke` и устаревший `smoke-hq` (см. §5).

**Сняты с программы окончательно:** `cache10`, `doc10x200`, `doc100x500`. Их конфигурации оставлены
в репозитории и составляют теперь `SERIES_OPTIONAL`, то есть **`--with-optional` добавляет именно
их**, а не что‑либо из программы 2; для воспроизведения программы 2 этот флаг не нужен. Данные лежат
в `results/archive/programme-1`, в отчётах программы 2 не участвуют (`docs/DEVIATIONS.md` §0, §4.7).

Во всех конфигурациях подставлены реальные `doc`/`sourceId`/`docJson`, маршрут (приёмочный
`[2,3,1,4,2,5,1,6,3,50]`; для документа из 5 страниц `[2,3,1,4,2,5,1,3,2,5]`; `route-full` —
`[2,3,4,…,50]`; `route-repeat` — `[2,3,4,2,5,6,7,5,2,8,9,10,8,11,12,50,4,6]`; ось `size-fraction-*`
— `[2,3,1,2,3]`, `[2,3,4,5,6,1,2,3,4,5,6]`, `[2…12,1,2…12]`), заливка `#1e90ff`, группы процессов и
`referenceCommand: scripts/reference-check.sh`. Собственный бюджет сценария
(`scenario.budgets.scenarioMs`) задан у `size-fraction-50x500` (30 200), `route-repeat` (40 000),
`size-fraction-100x500` (56 600) и `route-full` (70 000); у `size-fraction-*` шаг команды —
`scenario.cmdAfterStep = 1`, у остальных 5; у `command-shape` — четыре `variants` команды.

Группы серверных процессов (`procGroups`): `api` — по pidfile `results/logs/api.pid` (+потомки; командная
строка API — `node dist/index.js`, по ней процесс не отличить); `pg` — `postgres … 16/main` и
`postgres: 16/main: …` кроме backend'ов чужого клиента `zerospike`; `zero` — pidfile `results/logs/zero.pid`
и `stand/node_modules/**/zero-cache` (посторонний `spike-zero` исключён), каталог реплики `results/zero-replica`.
Группа `zero` сэмплируется **в каждом** прогоне: в H/Q её расход — измеренный фон
(`server_zero_applicable=false`, ≈ 40 мс CPU и ≈ 755 МиБ частной памяти в программе 2), к бюджету
H/Q он не прибавляется; прежнего «в H/Q `server_zero_* = 0`» больше нет (`docs/DEVIATIONS.md` 4.2).
Пики памяти всех групп публикуются и **без окон измерительной пробы**
(`server_*_mem_peak_excl_probe_mib`, `chromium_private_peak_excl_probe_mib`) — `docs/DEVIATIONS.md` §0.

Каждый прогон: login → `POST /api/test/reset` → ожидание догона реплики (`waitForReplica()`,
`docs/DEVIATIONS.md` §4.11) → параметры/сброс шейпера → новый процесс Chromium + новый
контекст → сэмплеры `/proc` (250 мс) и CDP → сценарий → статистика шейпера → `runs/<run_id>.json`,
строка `runs.csv` → эталон **до** следующего сброса: `scripts/reference-check.sh` получает
`reference/<run_id>/commands.json` (команда с фактическим `opId`) и `snapshots/*.json` (снимки посещённых
страниц; в P вытесненные страницы отсутствуют, обязательна последняя страница маршрута; в F — все посещённые),
выполняет `python -m reference.compare compare-snapshots --require-visits` и
`compare-db --check-operations`; код 0 → `reference_ok=true` (в программе 2 — во всех **1 014**
прогонах одиннадцати серий; посещений и покрытых снимков — по длине маршрута + 1: 11 на маршруте
§7.2, 6 / 12 / 24 на оси `size-fraction-*`, 19 в `route-repeat`, 50 в `route-full`). Отчёты —
`report-snapshots.json`, `report-db.json`, `reference.log`.
С 2026‑09‑13 `reference-check.sh` дополнительно требует `STAND_RUN_VISITS` — журнал посещений
страниц прогона, по которому сверяется снимок **каждого** посещения, а не только последней страницы
маршрута (дефект A11; формат — в шапке скрипта, код возврата 5 при отсутствии журнала,
`STAND_REF_VISITS_REQUIRED=0` отключает требование).

## 4. Где результаты

```
results/<series>/runs.csv                 одна строка на прогон (схема packages/analysis/COLUMNS.md; 136 колонок)
results/<series>/runs/<run_id>.json       шаги, снимки, журнал событий, сэмплы сервера/Chromium, CDP, шейпер, эталон
results/<series>/reference/<run_id>/      commands.json, snapshots/, report-*.json, reference.log
results/<series>/passport.json            паспорт серии (хост, версии, шейпер, план, harness, preSeriesChecks)
results/<series>/pre-series-checks.txt    дословный вывод предсерийных проверок §1.7 (копия файла программы)
results/logs/                             api.log, shaper.log, zero-cache.log, *.pid,
                                          pre-series-checks-<программа>.txt, run-all-series.log, programme-2.log
results/archive/programme-1/              программа 1 (834 прогона, 100 колонок) — с текущими сериями не смешивать
```

## 5. Дымовые прогоны H/Q — УСТАРЕВШИЕ (каталог `results/smoke-hq` удалён, 2 повторения, шейпер 25 мс / 20 Мбит/с, ведро 40 мс, bundle без разделения)

> Раздел оставлен как история решения о разделении bundle. Числа отсюда **не сравнимы** с текущими
> сериями: другая ёмкость ведра, другая сборка клиента и прежняя (дефектная) семантика `t_cmd_drawn`
> у Z. `packages/bench/series/smoke-hq.json` в `SERIES_ORDER` не входит.

> Актуальная дымовая серия всех 6 конфигураций (ведро 20 мс, bundle разделён по адаптерам, retained через `getRetainedAsync`) —
> `packages/bench/series/smoke.json`. **Каталог `results/smoke` перед измерениями удалён**
> (остался журнал `results/logs/smoke.log`), поэтому ссылаться на него как на существующие данные
> нельзя — воспроизводится командой выше. Числа ниже — предыдущее состояние стенда.

Все 8 прогонов: `outcome=ok`, `reference_ok=true` (снимки, БД и журнал `operations` совпали с эталоном),
`python3 -m analysis.report --validate-only` → OK. Медианы по двум повторениям; время — мс.

| Конфигурация | t_first_ready | nav новая / возврат (медианы) | t_cmd_ack | t_cmd_drawn | t_scenario | bytes_in | bytes_out | JS heap peak, МБ | chromium_private_peak, МиБ | retained_pages_end / shapes | API CPU, мс | PG CPU, мс |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| H/F | 675 | 27 / 13 | 69 | 182 | 12 330 | 7 663 044 | 53 375 | 12.9 | 211.8 | 50 / 25 000 | 380 | 110 |
| H/P(1) | 653 | 92 / 83 | 73 | 153 | 12 901 | 2 006 525 | 14 687 | 5.5 | 184.5 | 2 / 1 000 | 105 | 30 |
| Q/F | 686 | 24 / 14 | 65 | 149 | 12 227 | 7 663 044 | 53 375 | 12.0 | 212.6 | 50 / 25 000 | 415 | 110 |
| Q/P(1) | 643 | 95 / 86 | 71 | 153 | 12 846 | 2 006 525 | 14 687 | 6.2 | 182.3 | 2 / 1 000 | 105 | 20 |

Разбор чисел:

* Страница из 500 фигур — ≈117 КБ JSON. F: 4 статических запроса + login + метаданные + 50 страниц +
  команда + 10 перечитываний затронутых страниц = 67 запросов; 60 × 117 КБ + 0.6 МБ статики = 7.66 МБ.
  P: 12 чтений страниц (7 уникальных + возвраты после вытеснения при `cache=1` + перечитывание активной после команды)
  = 19 запросов, 2.0 МБ. Байты шейпера совпадают с CDP (`cdp_bytes_in`) до байта.
* Первая готовность ≈ 650–690 мс в обоих режимах: страница 1 в F идёт первой в очереди (параллелизм 4),
  а token bucket шейпера (40 мс ≈ 100 КБ) пропускает почти всю страницу всплеском — ограничение 20 Мбит/с
  проявляется на массовой загрузке F, а не на одиночном переходе. Переход в P ≈ RTT + сервер ≈ 90 мс;
  в F — только отрисовка (10–30 мс).
* `retained` в P ровно `cache + 1` страниц (окно реально освобождается), в F — все 50.
* `t_cmd_drawn` в H/F выше (≈180–200 мс): после команды H/F перечитывает активную страницу и ещё 9
  затронутых через общий ограничитель, конкурируя за полосу.
* Первая версия серии (`results/archive/smoke-hq-bundle287k/`) шла на сборке клиента без Zero (bundle 287 КБ);
  после добавления адаптера Z bundle вырос до 594 КБ (+lazy‑чанк) — `bytes_in` +0.31 МБ и `t_first_ready`
  +≈150 мс во всех конфигурациях. Статика общая для всех адаптеров, но сравнивать серии можно только на
  одной сборке клиента (версия bundle → в паспорт).
* `js_heap_peak == js_heap_end` и `chromium_private_peak == chromium_private_end` — не артефакт: за 12 с
  сценария память растёт монотонно (Chromium 130 → 210 МиБ по 50 сэмплам), GC не срабатывает.

Отладочный заход на малом документе `doc-small-10x200` (`--only H,Q --repetitions 1`, маршрут
`[2,3,1,4,2,5,1,6,3,10]`, источник `doc-small-10x200-src-1`, 83 затронутые фигуры на 9 страницах):
H/F 632 / nav 12 / cmd 145 / 1.52 МБ; H/P 648 / 83 / 143 / 1.18 МБ; Q/F 622 / 14 / 162 / 1.52 МБ;
Q/P 655 / 87 / 165 / 1.18 МБ — все `ok`, `reference_ok=true`, валидатор OK. **Серии `doc10x200`
в программе 2 нет**, каталога `results/doc10x200` тоже — эти числа относятся к программе 1
(`results/archive/programme-1/doc10x200`) и оставлены как проверка параметризуемости: маршрут,
`docJson`, `docPages`, `docShapesPerPage` берутся из конфигурации, в коде оболочки ничего не
захардкожено.

## 6. Известные особенности / что учесть при следующей программе

* API пишет лог каждого запроса (`STAND_LOG_LEVEL=info`) — это входит в `server_api_cpu_ms`; **решение:**
  серии идут на `warn` (`STAND_LOG_LEVEL=warn scripts/start-api.sh`; `scripts/run-all-series.sh` проверяет
  `GET /api/health → logLevel` и перезапускает API при необходимости) — `docs/DEVIATIONS.md` 4.1, `docs/PASSPORT.md` §4.
* Пока zero‑cache запущен, его backend'ы PostgreSQL (`postgres editor …`, walsender) попадают в группу `pg`
  и в H/Q‑прогонах. **Решение:** оставить (остановка/запуск zero‑cache на каждую смену конфигурации — 10 с и
  сброс кешей), фон квантифицирован: ≤ 5–10 мс CPU на прогон H/Q при измеренных 20–990 мс (медиана 40) — `docs/DEVIATIONS.md` 4.2.
* В списке страниц клиента подпись кнопки — `index + 1` (для мок‑сервера с индексами от 0); на реальных
  документах отображается «2 Page 1». На контракт (`data-page-index` = реальный индекс) не влияет.
* **Всю программу запускать одним вызовом оркестратора.** Программа 1 распалась на серии, снятые
  разными версиями измерительной оболочки (100 против 115 колонок), и часть её данных оказалась
  несопоставимой. Теперь это ловится машинно: `passport.harness.benchId` обязан совпадать у всех
  серий программы, `harness_id` дублируется в каждую строку CSV, а `harness-check.mjs` отказывается
  дописывать прогоны в каталог, снятый другой оболочкой (`docs/PASSPORT.md` §7.2).
* **Идентификатора версии в системе контроля версий нет** (`commit = null`, каталог не репозиторий
  git): опознать код серии можно только по `code.codeId` / `client.buildId` / `serverDistSha256` и
  по `harness.*`. Это надо называть прямо в отчёте, а не подменять «идентификатором сборки»
  (`docs/PASSPORT.md` §2.2).
