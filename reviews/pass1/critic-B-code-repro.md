# Критик: B — воспроизводимость, качество кода, функциональные проверки и эталон (K4/K2, с K1/K3 по ходу)

## Оценки
K1: 8.7  K2: 7.4  K3: 6.8  K4: 8.0  K5: n/a
Итог: 7.7

Оговорка о среде: во время рецензирования шла измерительная серия (`results/logs/run-all-series.log`),
поэтому **ничего не запускалось**: ни тесты, ни сборка, ни серии, ни запросы через шейпер (:8080/:8081 —
их счётчики принадлежат текущему прогону). Все выводы получены чтением кода, чтением уже записанных
`results/smoke/runs.csv`, `results/smoke/passport.json`, `results/functional/*/summary.md` и разбором
`package-lock.json`; для трёх пунктов это отмечено явно: **«не проверено запуском (идёт серия)»**.

## Дефекты (по убыванию серьёзности)

1. **[K3][high] `packages/client/src/stand.ts:446–461` + `packages/client/src/adapters/z.ts:309–318`; ложное утверждение в `docs/DEVIATIONS.md:84–85`**
   — `command-drawn` по построению не может быть раньше `command-acked`: `checkDrawnCommands()` требует
   `c.acked && c.revision !== null`, а `c.revision` заполняется только в `onAcked`. У Z `onAcked` наступает
   после `await this.fetchOperationResult(...)` — лишнего HTTP‑круга `GET /api/operations/:opId` через шейпер
   (+≥1 RTT ≈ 50 мс + серверное время), которого у H/Q нет (результат приходит в ответе POST). Значит
   `t_cmd_drawn(Z) = max(фактическая отрисовка, t_cmd_ack) = t_cmd_ack`, то есть **метрика «команда до
   актуального холста» §1.2 у Z систематически завышена на артефакт оболочки**. DEVIATIONS 2.2 утверждает
   обратное («`t_cmd_drawn` не затронут»), причём приводимое там доказательство — `t_cmd_ack == t_cmd_drawn`
   в дымовой серии — как раз и является подписью этого ограничения. Подтверждено данными
   `results/smoke/runs.csv`: Z — 226.9/227.0, 293.0/293.0, 379.1/379.2 мс (разница 0.1 мс); H/Q — 73/175.7,
   70.4/181.5 (разница ~100 мс, реальная перерисовка после перечитывания).
   **Что сделать:** фиксировать `command-drawn` независимо от подтверждения — запоминать целевую ревизию
   `expectedRevision + 1` в момент `command-sent` и сравнивать с `drawn.revision` (у Z это уже вычислено в
   `ZAdapter.waitSyncedRevision` / `commandTimings[].syncedAt`); `command-acked` оставить отдельным событием.
   Минимум — вынести `syncedAt`/`serverAt` в `rec.command` (`packages/bench/src/scenario/acceptance.mjs:554–556`),
   чтобы метрику можно было пересчитать по сырым данным: сейчас она невосстановима.

2. **[K3][high] `packages/bench/src/scenario/acceptance.mjs:309–325, 437–441, 492, 560`**
   — `t_scenario` определён как время последнего `page-ready` от navigationStart (строка 560), а между
   готовностью шага и следующим кликом выполняется `noteStep()` → `probe()` (строки 309–325, 178–231), который
   у Z вызывает `getRetainedAsync()` — синхронный скан клиентского хранилища Zero (~0.3 с на 25 000 строк,
   при уже идущем пересчёте — до двух сканов). Пауза `sleep(pauseMs)` (строка 440) добавляется **сверх**
   этого времени, поэтому накладные расходы инструмента попадают внутрь измеряемого `t_scenario`.
   Величина по `results/smoke/runs.csv` (t_scenario − (t_first_ready + Σt_nav + 11·1000 + t_cmd_drawn)):
   H/F 222–251 мс, Q/F 201–224, H/P 130–216, Q/P 178–191, **Z/P 1037–1119, Z/F 6597–6643 мс**. То есть
   ≈ 34 % значения `t_scenario` у Z/F (19.3 с из 19.5) — это работа сэмплера, а не адаптера. Затронуты:
   сравнение `t_scenario` между адаптерами (§1.8), доля «сценарий ≤ 30 с» и её интервал Уилсона (§1.2),
   а косвенно и окно наблюдения серверных `*_mem_integral_mib_s` и `chromium_private_peak`.
   **Что сделать:** держать объявленную паузу от готовности, а не от конца пробы —
   `await sleep(Math.max(0, pauseMs - (performance.now() - tReady)))`, записывая факт превышения; либо
   считать `t_scenario` как `t_first_ready + Σ t_nav + (число пауз)·pauseMs + t_cmd_drawn` и
   отдельной колонкой писать `harness_overhead_ms`. Старые серии пересчитываются по `steps[]` (данные есть).

3. **[K2][high] `packages/bench/src/functional/lib/config.mjs:89`, `scripts/run-functional.sh:9`, `scripts/run-all-series.sh:166,169`**
   — функциональный допуск (§1.7, таблица 1) выполняется на документе `data/small-10x200.json`
   (10 страниц × 200 фигур), а измеряется приёмочный `doc-acc-50x500` (50 × 500). Подтверждено:
   `results/functional/2026-09-12_23-33-41/summary.md` и `…_23-34-40/summary.md` — «документ:
   `doc-small-10x200`». Свойства, зависящие от масштаба (полнота набора на 500 фигурах, LRU‑окно при 50
   страницах, материализация 50 view у Z/F, устаревание `getRetained`), к сериям не допущены.
   **Что сделать:** прогонять допуск на `data/acceptance.json` (хотя бы проверки 1–6 и И1/И2) для всех шести
   конфигураций; малый документ оставить как быструю дымовую матрицу.

4. **[K2][medium] `packages/bench/src/functional/checks/05-stale-read.mjs:82–105`**
   — строка 5 таблицы 1 («ответ старого чтения») для Z не воспроизводится: ветка `isZ` просто выполняет
   команду и 3 с наблюдает зондом отсутствие отката. Ни одного задержанного/переупорядоченного ответа не
   создаётся, поэтому проверка проходит **вакуозно** — она подтвердила бы «нет отката» и на адаптере,
   который вовсе не умеет обрабатывать поздние данные. В `summary.md` это так и записано: «Z: WebSocket,
   3 с наблюдения после command-drawn без отката».
   **Что сделать:** воспроизвести переупорядочение на пути Z: либо отдельный экземпляр шейпера с
   несимметричной задержкой на `/zero` (задержать поток сервер→клиент на время выполнения команды), либо
   `context.setOffline(true)` на подписке страницы в момент команды с последующим восстановлением, либо
   задержка ответа `POST /api/zero/query` тестовым хуком (трансформация запроса идёт по HTTP и хуку
   доступна). Если воспроизвести нельзя — записать строку как `skip` с причиной, а не как `pass`.

5. **[K2][medium] `packages/bench/src/functional/lib/runner.mjs:52–53, 76, 109`**
   — `entry.passed` сбрасывается в `false` только при `fail` (строка 76); `skip` его не трогает, а список
   допущенных строится как `configResults.filter(c => c.passed && !c.skipped)` (строка 109), где `c.skipped`
   — только общий `hooks.skipReason` конфигурации. Проверка, бросившая `SkipCheck` (строки 64–65), даёт
   строку `skip`, но конфигурация всё равно объявляется «**допуск**». Кроме того, `check.applies` (строка 51)
   вообще не создаёт строки — проверка пропадает из таблицы бесследно. Критерий §1.7 — «все проверки
   пройдены», а не «ни одна не провалилась».
   **Что сделать:** допуск = нет `fail` **и** нет `skip` среди применимых проверок; неприменимые (`applies`)
   выводить строкой «n/a» с обоснованием, а не молчаливо опускать.

6. **[K2][medium] `scripts/run-all-series.sh:169` + `packages/bench/series/cache3.json:9–24`, `cache10.json:9–24`**
   — допуск запускается как `--adapters Z --base … --cache3 ''`, а у H/Q `--cache3` берётся по умолчанию
   («H», `lib/config.mjs:68`). В итоге допущены H/F, H/P/1, **H/P/3**, Q/F, Q/P/1, Z/F, Z/P/1
   (`results/functional/*/summary.md`), а серии `cache3` и `cache10` измеряют **Q/P/3, Z/P/3 и H/Q/Z P/10**,
   которые функционально не допускались ни разу. Для P‑конфигураций именно окно кеша — предмет проверки И2.
   **Что сделать:** перед `cache3`/`cache10` прогонять допуск соответствующих конфигураций
   (`--configs H:P:3,Q:P:3,Z:P:3,H:P:10,Q:P:10,Z:P:10`) либо явно записать в отчёт, что дополнительные
   серии идут без допуска, с указанием последствий.

7. **[K1/K3][medium] `packages/client/src/adapters/z.ts:510–518, 520–529`**
   — снимок страницы у Z переиздаётся из `onDocView` (ревизия из строки `documents`) для **всех** страниц,
   при этом `entry.rows` берутся из последнего вызова слушателя view страницы. Корректность момента
   «страница актуальна» держится на недокументированном допущении, что в одном poke Zero слушатель
   `docMeta` не сработает раньше, чем обновятся строки `shapes` соответствующей view (docView создаётся
   **первым**, в `open()`, строка 198). Если порядок обратный, `publish()` (строка 514: сравнение по
   ссылке `prev.shapes === entry.rows`) выпустит снимок с **новой ревизией и старыми заливками**, и
   `command-drawn`/`page-ready` будут зафиксированы раньше фактической актуальности. Ни один
   функциональный тест это не ловит: проверки 2–5 читают снимок уже **после** завершения `runCommand`.
   **Не проверено запуском (идёт серия).**
   **Что сделать:** не выпускать снимок по изменению одной только ревизии — требовать, чтобы после
   поднятия ревизии слушатель страницы подтвердил `complete` (например, помечать entry «ревизия обогнала
   строки» и публиковать при ближайшем `onPageView`), либо добавить в функциональную проверку 3
   контроль «в момент `command-drawn` заливка целевых экземпляров в `getPageSnapshot` уже новая».

8. **[K4][medium] `packages/analysis/analysis/stats.py:476–488`**
   — перекрёстная проверка байтов сравнивает `bytes_in` (шейпер) только с `cdp_bytes_in`, который у Z **не
   включает WebSocket**. В `results/smoke/report.md:152–159` это уже дало ложные провалы: Z/F 92.5 %,
   Z/P 76.6 % расхождения при ✗. Данные для корректного сравнения в CSV есть: 572 272 + 1 875 162 =
   2 447 434 против 2 449 527 у шейпера (0.09 %).
   **Что сделать:** сравнивать `bytes_in` с `cdp_bytes_in + cdp_ws_bytes_in` (и `bytes_out` с
   `cdp_bytes_out + cdp_ws_bytes_out`); иначе итоговый `docs/RESULTS.md` будет содержать заведомо неверную
   строку о некорректности измерения обмена у Z.

9. **[K1/K4][medium] `scripts/lib.sh:14`, `scripts/start-zero.sh:28,54`, `packages/server/src/routes/test.ts:10`; проверено `ss -ltnp`**
   — API слушает `0.0.0.0:3000` с `STAND_TEST_HOOKS=1`, а тестовые хуки **не требуют токена** (комментарий в
   `routes/test.ts:10` это фиксирует как решение): `POST /api/test/reset {docId}` сбрасывает любой документ
   любого пользователя, `POST /api/test/delay` задерживает ответы. zero‑cache слушает `0.0.0.0:4848` с
   административным паролем по умолчанию `stand-admin` (`start-zero.sh:28`, `infra/.env.example:7`,
   `docker-compose.yml:85`). §1.6 требует, чтобы служебные порты и административные интерфейсы zero‑cache
   были доступны только внутри контура (шейпер, в отличие от них, корректно привязан к 127.0.0.1).
   **Что сделать:** `STAND_HOST=127.0.0.1` по умолчанию в `scripts/lib.sh`; привязать zero‑cache к 127.0.0.1
   (в `scripts/zero-ipv4-shim.mjs` подменять `::`→`127.0.0.1`, а не `0.0.0.0`); потребовать
   `ZERO_ADMIN_PASSWORD` из среды без значения по умолчанию; в `infra/Caddyfile` добавить явный
   `respond 403` для `/zero/statz`, `/zero/heapz`, `/zero/inspector*`; закрыть хуки общим секретом заголовка.

10. **[K4][medium] `infra/docker-compose.yml:8,12–14`; `README.md:120`**
    — §1.9 требует «образы закреплены по неизменяемым идентификаторам», а в compose стоят
    плейсхолдеры `# @sha256:<PIN_DIGEST_POSTGRES>` и т. д.; закреплены только теги (`postgres:17-alpine`,
    `caddy:2`). Комментарий в шапке файла («Образы закреплены тегом») и README перекладывают подстановку
    digest'ов на читателя. Для постороннего это значит, что путь Docker невоспроизводим побайтово, и что
    `postgres:17-alpine` завтра будет другим образом.
    **Что сделать:** подставить реальные digest'ы (можно получить из публичного реестра без запуска демона:
    `docker buildx imagetools inspect` или HTTP‑запрос к registry) либо явно записать в DEVIATIONS, что
    закрепление digest'ов не выполнено и почему. Также стоит снять формулировку «образы закреплены» из шапки.

11. **[K4][medium] `packages/bench/src/series/passport.mjs:90–137`; `results/smoke/passport.json`; противоречие `docs/DEVIATIONS.md:135` ↔ `docs/PASSPORT.md:42–44`**
    — SPEC §7.4 требует в паспорте серии «настройки адаптеров (staleTime/gcTime/ttl…)». В
    `results/<series>/passport.json` их нет (проверено: строки `staleTime`/`ttl` в файле отсутствуют),
    нет и никакого идентификатора кода/сборки (`commit` объявлен в `schema.py` как опциональная колонка,
    но `flattenRun` его не пишет; имена chunk'ов не сохраняются). При этом DEVIATIONS 3.1 (строка 135)
    утверждает «версия сборки (имена chunk'ов) фиксируется в паспорте», а PASSPORT.md (строка 42) прямо
    говорит обратное — «в `results/<series>/passport.json` не пишутся».
    **Что сделать:** импортировать `ADAPTER_SETTINGS` и `Z_SETTINGS` в `buildPassport` (или собирать их
    из `window.__stand` первого прогона) и писать в `passport.json`; добавить туда же
    `client.dist` — список файлов `packages/client/dist/assets` с размерами и mtime — и, при появлении git,
    `commit`. Исправить противоречие в DEVIATIONS 3.1.

12. **[K2][medium] `packages/bench/src/functional/checks/07-security.mjs:214–237`**
    — самая сильная часть проверки Б3 (bob напрямую выполняет synced query страницы alice через
    `zero.run(..., {type:'complete'})`) не выполняется: адаптер Z не публикует ни `queries`, ни `zero`
    под ожидаемыми именами (`adapter?.queries` всегда `null`, т.к. `ZAdapter` импортирует `queries`
    модульно), поэтому ветка возвращает `{available:false}` и проверка **проходит**. В `summary.md` это
    видно: «прямой synced query из клиента: пропущен». Остаётся только проверка серверного endpoint
    `POST /api/zero/query`, то есть путь «zero‑cache отдал строки из уже зарегистрированного запроса
    другого клиента» не покрыт вовсе — а именно там и живёт риск §1.7 (кеш трансформаций по (name,args)).
    **Что сделать:** публиковать handle Zero и реестр запросов из `ZAdapter` под тестовым флагом
    (`window.__zero`, `window.__zeroQueries`) и сделать эту ветку обязательной; при её недоступности —
    `fail`, а не молчаливый `pass`.

13. **[K2][medium] `scripts/reference-check.sh:27–28` + `packages/bench/src/series/run.mjs:657`**
    — в P‑режиме `requiredPages = lastPage ? [lastPage] : []`; если `lastPage` не определился,
    `STAND_REQUIRE_PAGES` пуст, `req=()` — и `compare-snapshots` вызывается **без** `--require-pages`,
    то есть проходит на нуле снимков (`reference/compare.py:330` срабатывает только при непустом списке).
    Это единственный канал, которым «эталон совпал» может быть получен вакуозно. Дополнительно: если прогон
    упал до команды, `commands.json` пуст, и `compare-db` сверяет БД с исходным состоянием — тоже
    тривиально истинно (учитывается в `reference_ok_share`, `stats.py:386–392`).
    **Что сделать:** в `reference-check.sh` завершаться с ненулевым кодом, если `STAND_REQUIRE_PAGES` пуст;
    в `run.mjs` при `!lastPage` помечать прогон `outcome:'error'`; для прогонов без команды не считать
    `reference_ok` вовсе (писать пусто), чтобы они не попадали в долю успешных сверок.

14. **[K3][medium] `packages/bench/src/scenario/acceptance.mjs:318, 323, 399–403`**
    — `js_heap_peak_mib` вычисляется как максимум по 11–12 точечным пробам (после каждого шага, после
    команды и в конце), а не по непрерывному наблюдению. SPEC §7.3 требует «JS‑куча (пик)». Для Z/F, где
    основная работа идёт между шагами, реальный пик почти наверняка пропускается.
    **Что сделать:** снимать `Runtime.getHeapUsage` по таймеру (250 мс, как у `chromium_private_*`)
    в отдельном сэмплере CDP, либо честно переименовать колонку в `js_heap_max_sampled_mb` и описать метод
    в `COLUMNS.md`/PASSPORT.

15. **[K3][low] `packages/bench/src/sampling/chromium.mjs:74, 84–85` и `packages/bench/src/series/run.mjs:132, 278`**
    — если `browserPid()` вернул `null`, сэмплер тихо не делает ничего и записывает
    `chromium_private_peak_mib = 0`; аналогично `flattenRun.grp()` отдаёт `0` для серверной группы, в
    которую в течение прогона не попал ни один процесс (предупреждение печатается один раз в начале серии,
    в запись прогона не попадает). Это ровно тот класс «серия молча даёт неверные числа», который надо
    исключить.
    **Что сделать:** писать в запись прогона `chromium.pid` и `server.<group>.pids` (последнее уже есть) и
    считать прогон `outcome:'error'`/помечать `sampling_incomplete`, если `pid === null` или `pids` пуст у
    группы, которая для данного адаптера обязана быть непустой.

16. **[K1][low] `packages/server/src/domain/executeCommand.ts:11–20, 70–77`**
    — `paramsHash` включает `expectedRevision`, поэтому повтор с тем же `opId` после того, как клиент
    перечитал ревизию (сценарий «неопределённый ответ → `GET /api/operations` дал 404 → клиент обновил
    метаданные → повторный POST»), даёт `409 op_conflict` вместо возврата сохранённого результата.
    В текущем клиенте этого не происходит (`commands.ts:22–31` повторяет тот же объект), но контракт §1.2
    («повтор с теми же параметрами возвращает ранее полученный результат») тоньше, чем реализация.
    **Что сделать:** либо исключить `expectedRevision` из хеша (он не часть логического смысла операции),
    либо описать это ограничение в SPEC/README как часть контракта повтора.

17. **[K1][low] `packages/client/src/config.ts:11`**
    — пароли тестовых учётных записей (`alice-pass`, `bob-pass`) захардкожены в клиентском бандле ради
    `?autologin=`. Секрет подписи в бандл не попадает (проверено: `STAND_JWT_SECRET` читается только в
    `packages/server/src/config.ts`), так что §1.6 формально не нарушен, но раздаваемая статика содержит
    учётные данные.
    **Что сделать:** брать пароль из query‑параметра оболочки (`?autologin=alice&pw=…`) или из
    `import.meta.env` с dev‑флагом, чтобы production‑сборка стенда их не содержала.

18. **[K3][low] `packages/client/src/api.ts:96–97`**
    — `transfer.bytesIn` при отсутствии `content-length` прибавляет `text.length`, то есть число кодовых
    единиц UTF‑16, а не байт (и при наличии `content-length` — размер сжатого тела, тогда как `text.length`
    — распакованного); `bytesOut` считается так же (`api.ts:71`). Колонки
    `client_transfer_bytes_in/out` из‑за этого не сопоставимы ни с шейпером, ни с CDP.
    **Что сделать:** считать `new TextEncoder().encode(text).length` (или `Blob` size) и пометить в
    `COLUMNS.md`, что это оценка распакованного объёма, а не трафика.

19. **[K4][low] `packages/generator/src/verify.ts:57–58`**
    — инвариант «S1 лежит на `s1Pages` страницах» проверяется против собственных метаданных документа
    (`s1.pageIds.length`), а не против параметра `p.s1Pages`, поэтому генератор, разложивший экземпляры
    на другое число страниц, проверку пройдёт. Фактические данные корректны (проверено по
    `data/acceptance.json`: 100 экземпляров на 10 страницах, на странице 50 — 10 экземпляров, из них
    2 переопределённых), но инвариант самоподтверждающийся.
    **Что сделать:** сравнивать с `p.s1Pages` и с `p.s1Instances / p.s1Pages` на страницу.

20. **[K4][low] `packages/bench/src/series/csv.mjs:123–139`**
    — `readCsvRunIds` (используется для resume) разбивает файл по `\n` и по `,` без учёта кавычек, тогда как
    `csvCell` корректно экранирует многострочный `error_message`. Многострочное сообщение об ошибке даст
    «лишние» строки и мусорные `run_id` в множестве уже выполненных.
    **Что сделать:** либо минимальный CSV‑парсер с учётом кавычек, либо (проще) заменять `\r?\n` на ` | `
    в `error_message` при записи.

21. **[K4][low] Остатки и рассогласования документации**
    — `packages/bench/series/smoke-hq.json` и `results/smoke-hq/` (6.8 МиБ) — прежняя дымовая серия H/Q на
    сборке без разделения бандла, в `SERIES_ORDER` (`scripts/run-all-series.sh:22`) не входит, но
    `docs/INTEGRATION.md:63,71,97,100` продолжает описывать её как действующую, а `packages/bench/README.md:17`
    перечисляет в списке серий. `.gitignore` (4 строки) не исключает `__pycache__/`, `.pytest_cache/`, `*.pyc`
    — при этом `packages/reference/{reference,tests}/__pycache__`, `packages/analysis/analysis/__pycache__`
    и `packages/reference/.pytest_cache/` лежат в дереве. Исключение `*.log` заодно выбрасывает
    `results/<series>/reference/<run_id>/reference.log` — первичное свидетельство каждой сверки с эталоном.
    **Что сделать:** убрать `smoke-hq.json`, перенести `results/smoke-hq` в `results/archive/` и поправить
    INTEGRATION.md/bench README; дополнить `.gitignore`; для логов эталона сделать исключение
    (`!results/**/reference.log`).
    *Замечание к постановке задачи:* `packages/bench/src/sampling/procs.mjs` и `procfs.mjs` — **не** дубликаты:
    `procfs.mjs` — низкоуровневое чтение `/proc`, `procs.mjs` — сэмплер групп поверх него
    (`procs.mjs:16`, `chromium.mjs:11`, `test/sampling.test.mjs:11`). Удалять нечего.

22. **[K3][low] `packages/bench/series/*.json` → `shaper.handshakeRtt` выключен (`results/smoke/passport.json`, `docs/PASSPORT.md:53`)**
    — RTT TCP‑рукопожатия не эмулируется, а число соединений у адаптеров разное
    (`results/smoke/runs.csv`: H/Q/F — 8 соединений и 70 запросов, Z — 5 и 11). Отсутствие стоимости
    установления соединения слегка выгодно HTTP‑конфигурациям. Отклонение зафиксировано в PASSPORT,
    но его односторонний эффект нигде не оценён.
    **Что сделать:** прогнать контрольную серию с `--handshake-rtt` (хотя бы 10 повторений на main) и
    записать разницу; либо явным абзацем в DEVIATIONS указать направление и порядок смещения.

### Что сделано хорошо (для калибровки оценок, не похвала)
* Эталон `packages/reference` действительно независим: чистая Python‑модель (`reference/model.py`), ни одного
  импорта из `packages/server`; сверка идёт по **всем** фигурам документа (`compare_db_state`) и по множествам
  id в обе стороны (`compare_page_snapshot`), плюс `check_operations` с контролем дублей и финальной ревизии.
* Функциональные проверки 1–4 и 6 непустые: сверяют конкретные значения (`01-open.mjs:50–67` — зонд с шагом
  ~4 мс против частичных снимков; `06-retry.mjs:58–129` — два варианта обрыва, число POST, `x-stand-replayed`,
  409 при иных параметрах); безопасность (`07-security.mjs:37–96, 131–157`) проверяет 403/401 по HTTP и через
  клиент, пустые `localStorage/sessionStorage/IndexedDB` и отсутствие запросов с `Authorization` после выхода.
* Учёт ошибок честный: `acceptance.mjs:328–334` отделяет `timeout` от `error`, `schema.py:325–326` определяет
  `success = ok ∧ ≤30 с ∧ reference_ok`, `stats.py:364–367` считает долю по **всем** прогонам, а не по успешным;
  `ok_runs` исключает ошибочные прогоны только из метрик времени/памяти. Бутстреп детерминирован
  (`stats.py:43–44, 65`), интервал Уилсона реализован верно (`stats.py:101–109`).
* Перемешивание конфигураций воспроизводимо (`plan.mjs:42–62`, mulberry32 + Fisher–Yates от `(seed, repetition)`),
  `run_id` стабильны, resume не перезапускает уже записанные прогоны.
* SQL везде параметризован тегированными шаблонами; `sql.unsafe` применяется только к статическому
  `schema.sql` (`db/migrate.ts:18`). Ревизия блокируется `FOR UPDATE` (`domain/pgTx.ts:21–29`), чтение страницы
  идёт в `REPEATABLE READ READ ONLY` (`db/sql.ts:31–33`), команда и запись `operations` — в одной транзакции.
* Разделение бандла (`adapters/index.ts:15–41`) сделано корректно: загрузка chunk'а стартует в конструкторе
  контроллера (`stand.ts:66`), параллельно с `login`, и не добавляет последовательный запрос в путь открытия;
  эффект измерен и записан (DEVIATIONS 3.1). Замечание: `bytes_in` теперь включает разный по адаптерам бандл
  (H ≈ 253 КБ, Q ≈ 284, Z ≈ 553) — это архитектурное свойство, но в `docs/RESULTS.md` его надо назвать явно,
  иначе разница обмена P‑конфигураций (1.67 / 1.70 / 2.45 МБ) читается как разница в загрузке данных.

## Что проверено лично (команды, которые критик запускал)
Серия шла всё время рецензирования; ничего, что создаёт нагрузку или трафик через шейпер, не запускалось.

```
# чтение и разбор (read-only)
cat SPEC.md; sed -n '150,370p' /home/claude/thesis/thesis.md
cat docs/{CRITIC_RUBRIC,DEVIATIONS,PASSPORT,FUNCTIONAL_FINDINGS}.md README.md packages/*/README.md
node -e '...package-lock.json...'            # точные версии: react 19.3.0, react-dom 19.3.0,
                                             # @tanstack/react-query 5.102.8, @rocicorp/zero 1.9.0,
                                             # fastify 5.12.4, playwright 1.56.0, vite 8.3.0,
                                             # typescript 5.9.3, postgres 3.4.9 (workspace) / 3.4.7 (hoisted),
                                             # lockfileVersion 3, engines node>=24
node --check packages/bench/src/series/run.mjs \
             packages/bench/src/scenario/acceptance.mjs \
             packages/bench/src/sampling/procs.mjs \
             packages/netshaper/src/proxy.mjs          # синтаксис ок

# арифметика по уже записанным сырым данным (без запуска стенда)
python3 - <<'PY'   # results/smoke/runs.csv: t_scenario − модель (first+Σnav+11·1000+drawn)
# H/F 222–251, Q/F 201–224, H/P 130–216, Q/P 178–191, Z/P 1037–1119, Z/F 6597–6643 мс
PY
python3 - <<'PY'   # results/smoke/runs.csv: t_cmd_ack vs t_cmd_drawn
# Z: 226.9/227.0, 293.0/293.0, 379.1/379.2 ; H/Q: 73/175.7, 70.4/181.5, 74.1/184.4
PY
python3 - <<'PY'   # bytes_in (шейпер) vs cdp_bytes_in (+ cdp_ws_bytes_in)
# H/Q: 0.0 % ; Z/P: 76.6 % (572 272 + 1 875 162 = 2 447 434 против 2 449 527 → 0.09 %)
PY
python3 - <<'PY'   # data/acceptance.json: S1 — 100 экземпляров на 10 страницах,
# на странице 50 (library) 10 экземпляров, из них 2 переопределённых
PY
python3 - <<'PY'   # results/smoke/passport.json: нет staleTime/gcTime/ttl, нет commit/имён chunk'ов
PY

ss -ltnp | grep -E '4848|3000|8080|8081'
# 0.0.0.0:4848 (zero-cache), 0.0.0.0:3000 (API с тестовыми хуками),
# 127.0.0.1:8080 и 127.0.0.1:8081 (шейпер) — к шейперу запросов не делалось
```

Не проверено запуском (идёт серия), выводы получены из кода: п. 7 (порядок слушателей Zero в одном poke),
п. 4 (поведение Z при переупорядочении данных синхронизации), п. 12 (доступность `zero.run` из страницы).

```json
{"critic":"B — воспроизводимость, качество кода, функциональные проверки и эталон","pass":1,"scores":{"K1":8.7,"K2":7.4,"K3":6.8,"K4":8.0,"K5":null},"overall":7.7,"defects":[
{"k":"K3","severity":"high","where":"packages/client/src/stand.ts:446-461; packages/client/src/adapters/z.ts:309-318; docs/DEVIATIONS.md:84-85","what":"command-drawn по построению не может опередить command-acked (checkDrawnCommands требует c.acked/c.revision), а у Z ack наступает после лишнего HTTP-круга GET /api/operations/:opId через шейпер; значит t_cmd_drawn(Z) = t_cmd_ack и метрика 'команда до холста' §1.2 завышена на артефакт оболочки. DEVIATIONS 2.2 утверждает обратное, приводя как доказательство ровно подпись этого ограничения (smoke: Z 226.9/227.0, 293.0/293.0, 379.1/379.2 против H/Q 73/175.7)","fix":"фиксировать command-drawn по целевой ревизии expectedRevision+1, известной в момент command-sent, независимо от подтверждения (у Z значение уже есть в waitSyncedRevision/commandTimings.syncedAt); как минимум выгружать syncedAt/serverAt в rec.command, чтобы метрику можно было пересчитать по сырым данным"},
{"k":"K3","severity":"high","where":"packages/bench/src/scenario/acceptance.mjs:309-325,437-441,492,560","what":"t_scenario = момент последнего page-ready и потому включает время пробы noteStep/probe (getRetainedAsync), которое зависит от адаптера: по results/smoke/runs.csv накладные расходы инструмента 130-251 мс у H/Q и 1037-1119 (Z/P) и 6597-6643 мс (Z/F) — до 34 % значения; искажены сравнение t_scenario между адаптерами (§1.8) и доля 'сценарий ≤ 30 с' с интервалом Уилсона (§1.2)","fix":"держать объявленную паузу от готовности (sleep(max(0, pauseMs - elapsed))), либо считать t_scenario = t_first_ready + Σt_nav + пауз·pauseMs + t_cmd_drawn и писать harness_overhead_ms отдельной колонкой; старые серии пересчитать по steps[]"},
{"k":"K2","severity":"high","where":"packages/bench/src/functional/lib/config.mjs:89; scripts/run-all-series.sh:166,169; results/functional/2026-09-12_23-33-41/summary.md","what":"функциональный допуск §1.7 (таблица 1) выполняется на doc-small-10x200 (10x200), тогда как основная серия измеряет doc-acc-50x500 (50x500): свойства, зависящие от масштаба (полнота набора на 500 фигурах, LRU при 50 страницах, 50 view у Z/F, устаревание getRetained), к сериям не допущены","fix":"прогонять допуск на data/acceptance.json для всех шести конфигураций (проверки 1-6, И1/И2); малый документ оставить быстрой дымовой матрицей"},
{"k":"K2","severity":"medium","where":"packages/bench/src/functional/checks/05-stale-read.mjs:82-105","what":"строка 5 таблицы 1 для Z не воспроизводится: ветка isZ просто выполняет команду и 3 с наблюдает отсутствие отката, ни одного задержанного/переупорядоченного ответа не создаётся — проверка проходит вакуозно и прошла бы на адаптере, вовсе не умеющем обрабатывать поздние данные","fix":"воспроизвести переупорядочение на пути Z (несимметричная задержка на /zero в шейпере, setOffline на подписке во время команды или задержка POST /api/zero/query тестовым хуком); если невозможно — записывать строку как skip с причиной, а не pass"},
{"k":"K2","severity":"medium","where":"packages/bench/src/functional/lib/runner.mjs:52-53,76,109","what":"entry.passed сбрасывается только при fail; SkipCheck даёт строку skip, но конфигурация всё равно попадает в 'допущены к измерениям', а check.applies вообще не создаёт строки — критерий §1.7 'все проверки пройдены' подменён на 'ни одна не провалилась'","fix":"допуск = нет fail И нет skip среди применимых проверок; неприменимые выводить строкой n/a с обоснованием"},
{"k":"K2","severity":"medium","where":"scripts/run-all-series.sh:169; packages/bench/series/cache3.json; packages/bench/series/cache10.json","what":"допуск получают H/F, H/P/1, H/P/3, Q/F, Q/P/1, Z/F, Z/P/1, а серии cache3 и cache10 измеряют Q/P/3, Z/P/3 и H/Q/Z P/10, которые не проверялись функционально ни разу — при том что именно окно кеша является предметом проверки И2","fix":"прогонять допуск конфигураций дополнительных серий (--configs H:P:3,Q:P:3,Z:P:3,H:P:10,Q:P:10,Z:P:10) либо явно записать в отчёт, что дополнительные серии идут без допуска"},
{"k":"K1","severity":"medium","where":"packages/client/src/adapters/z.ts:510-518,520-529","what":"снимок страницы у Z переиздаётся из onDocView по ревизии строки documents со старыми entry.rows; корректность момента готовности держится на недокументированном допущении о порядке срабатывания слушателей внутри одного poke Zero (docView создаётся первым). При обратном порядке снимок получит новую ревизию со старыми заливками и command-drawn/page-ready зафиксируются раньше актуальности; ни один функциональный тест этого не ловит (не проверено запуском — идёт серия)","fix":"не публиковать снимок по изменению одной лишь ревизии: помечать entry 'ревизия обогнала строки' и публиковать при ближайшем complete от view страницы; добавить в проверку 3 контроль, что в момент command-drawn заливка целевых экземпляров в getPageSnapshot уже новая"},
{"k":"K4","severity":"medium","where":"packages/analysis/analysis/stats.py:476-488; results/smoke/report.md:152-159","what":"перекрёстная проверка байтов сравнивает bytes_in только с cdp_bytes_in, который у Z не включает WebSocket: в отчёте уже стоят ложные провалы Z/F 92.5 % и Z/P 76.6 %, хотя с cdp_ws_bytes_in расхождение 0.09 %","fix":"сравнивать bytes_in с cdp_bytes_in + cdp_ws_bytes_in (и bytes_out с cdp_bytes_out + cdp_ws_bytes_out)"},
{"k":"K1","severity":"medium","where":"scripts/lib.sh:14; scripts/start-zero.sh:28,54; packages/server/src/routes/test.ts:10; infra/.env.example:7","what":"API слушает 0.0.0.0:3000 с неаутентифицированными тестовыми хуками (POST /api/test/reset сбрасывает любой документ, /api/test/delay задерживает ответы), zero-cache — 0.0.0.0:4848 с административным паролем по умолчанию stand-admin; §1.6 требует закрытых служебных портов и административных интерфейсов zero-cache только внутри контура (подтверждено ss -ltnp)","fix":"STAND_HOST=127.0.0.1 по умолчанию; привязать zero-cache к 127.0.0.1 в zero-ipv4-shim.mjs; требовать ZERO_ADMIN_PASSWORD из среды без значения по умолчанию; добавить в infra/Caddyfile respond 403 для /zero/statz,/zero/heapz,/zero/inspector*; закрыть хуки секретом заголовка"},
{"k":"K4","severity":"medium","where":"infra/docker-compose.yml:8,12-14; README.md:120","what":"§1.9 требует закрепления образов по неизменяемым идентификаторам, но в compose стоят плейсхолдеры @sha256:<PIN_DIGEST_*>, закреплены только теги postgres:17-alpine / rocicorp/zero:1.9.0 / caddy:2, а подстановка digest'ов переложена на читателя — путь Docker невоспроизводим","fix":"подставить реальные digest'ы (их можно получить из реестра без docker-демона) либо явно записать в DEVIATIONS невыполнение требования; убрать из шапки compose формулировку 'образы закреплены'"},
{"k":"K4","severity":"medium","where":"packages/bench/src/series/passport.mjs:90-137; results/smoke/passport.json; docs/DEVIATIONS.md:135 против docs/PASSPORT.md:42-44","what":"в машинном паспорте серии нет требуемых SPEC §7.4 настроек адаптеров (staleTime/gcTime/ttl) и нет идентификатора кода/сборки (commit объявлен в schema.py, но flattenRun его не пишет; имена chunk'ов не сохраняются); DEVIATIONS 3.1 утверждает, что версия сборки фиксируется в паспорте, а PASSPORT.md прямо говорит обратное","fix":"писать ADAPTER_SETTINGS и Z_SETTINGS в passport.json, добавить перечень packages/client/dist/assets с размерами и mtime (и commit при появлении git); исправить противоречие в DEVIATIONS 3.1"},
{"k":"K2","severity":"medium","where":"packages/bench/src/functional/checks/07-security.mjs:214-237","what":"самая сильная часть проверки Б3 (bob напрямую выполняет synced query страницы alice через zero.run) не выполняется, потому что ZAdapter не публикует queries/zero, — ветка возвращает available:false и проверка проходит; остаётся только серверный endpoint /api/zero/query, а путь 'zero-cache отдал строки из уже зарегистрированного запроса другого клиента' не покрыт","fix":"публиковать handle Zero и реестр запросов из ZAdapter под тестовым флагом (window.__zero, window.__zeroQueries) и сделать ветку обязательной: при недоступности — fail, а не pass"},
{"k":"K2","severity":"medium","where":"scripts/reference-check.sh:27-28; packages/bench/src/series/run.mjs:657; packages/reference/reference/compare.py:330","what":"в P-режиме при неопределившемся lastPage STAND_REQUIRE_PAGES пуст, --require-pages не передаётся и compare-snapshots проходит на нуле снимков; отдельно, прогон, упавший до команды, даёт пустой commands.json и тривиально истинный compare-db, который учитывается в reference_ok_share","fix":"в reference-check.sh завершаться ненулевым кодом при пустом STAND_REQUIRE_PAGES; в run.mjs при !lastPage помечать прогон outcome:'error'; для прогонов без команды не писать reference_ok вовсе"},
{"k":"K3","severity":"medium","where":"packages/bench/src/scenario/acceptance.mjs:318,323,399-403","what":"js_heap_peak_mib — максимум по 11-12 точечным пробам между шагами, а не непрерывное наблюдение; для Z/F, где основная работа идёт между шагами, реальный пик почти наверняка пропускается","fix":"снимать Runtime.getHeapUsage по таймеру 250 мс отдельным сэмплером CDP либо переименовать колонку в js_heap_max_sampled_mb и описать метод в COLUMNS.md/PASSPORT"},
{"k":"K3","severity":"low","where":"packages/bench/src/sampling/chromium.mjs:74,84-85; packages/bench/src/series/run.mjs:132,278","what":"при browserPid()===null сэмплер молча пишет chromium_private_peak_mib=0, а flattenRun.grp() отдаёт 0 для серверной группы, в которую за прогон не попал ни один процесс (предупреждение печатается один раз в начале серии и в запись прогона не попадает) — серия может тихо дать нулевые ресурсные числа","fix":"писать chromium.pid и pids групп в запись прогона и помечать прогон sampling_incomplete/outcome error, если pid null или обязательная для адаптера группа пуста"},
{"k":"K1","severity":"low","where":"packages/server/src/domain/executeCommand.ts:11-20,70-77","what":"paramsHash включает expectedRevision, поэтому повтор с тем же opId после перечитывания ревизии клиентом даёт 409 op_conflict вместо возврата сохранённого результата — тоньше, чем контракт §1.2 'повтор с теми же параметрами возвращает ранее полученный результат'","fix":"исключить expectedRevision из хеша либо описать это ограничение контракта повтора в SPEC/README"},
{"k":"K1","severity":"low","where":"packages/client/src/config.ts:11","what":"пароли тестовых учётных записей alice-pass/bob-pass захардкожены в клиентском бандле ради ?autologin (секрет подписи в бандл не попадает, §1.6 формально не нарушен, но раздаваемая статика содержит учётные данные)","fix":"передавать пароль query-параметром оболочки или брать из import.meta.env с dev-флагом, чтобы production-сборка стенда их не содержала"},
{"k":"K3","severity":"low","where":"packages/client/src/api.ts:71,96-97","what":"client_transfer_bytes_in/out считаются как text.length (кодовые единицы UTF-16 распакованного тела) или content-length сжатого тела — величины несопоставимы ни с шейпером, ни с CDP","fix":"считать TextEncoder().encode(text).length и пометить в COLUMNS.md, что это оценка распакованного объёма, а не трафика"},
{"k":"K4","severity":"low","where":"packages/generator/src/verify.ts:57-58","what":"инвариант 'S1 лежит на s1Pages страницах' сверяется с собственными метаданными документа (s1.pageIds.length), а не с параметром p.s1Pages — проверка самоподтверждающаяся (фактические данные корректны: 100 экземпляров на 10 страницах, на странице 50 — 10, из них 2 переопределённых)","fix":"сравнивать с p.s1Pages и с p.s1Instances / p.s1Pages на страницу"},
{"k":"K4","severity":"low","where":"packages/bench/src/series/csv.mjs:123-139","what":"readCsvRunIds (resume) разбивает CSV по \\n и , без учёта кавычек, хотя csvCell корректно экранирует многострочный error_message — многострочная ошибка даст лишние строки и мусорные run_id в множестве выполненных","fix":"использовать парсер с учётом кавычек либо заменять \\r?\\n на ' | ' в error_message при записи"},
{"k":"K4","severity":"low","where":"packages/bench/series/smoke-hq.json; results/smoke-hq/; docs/INTEGRATION.md:63,71,97,100; packages/bench/README.md:17; .gitignore","what":"обсолетная дымовая серия smoke-hq (6.8 МиБ результатов на прежней сборке без разделения бандла) не входит в SERIES_ORDER, но описана в INTEGRATION.md и bench/README как действующая; .gitignore не исключает __pycache__/.pytest_cache/*.pyc (они лежат в дереве) и при этом исключает *.log, то есть reference.log — первичное свидетельство каждой сверки с эталоном. Замечание: procs.mjs и procfs.mjs не дубликаты — это сэмплер и низкоуровневое чтение /proc","fix":"убрать smoke-hq.json, перенести results/smoke-hq в results/archive, поправить INTEGRATION.md и bench/README; дополнить .gitignore и добавить !results/**/reference.log"},
{"k":"K3","severity":"low","where":"packages/bench/series/*.json (shaper); docs/PASSPORT.md:53; results/smoke/passport.json","what":"RTT TCP-рукопожатия не эмулируется (handshakeRtt:false), а число соединений у адаптеров разное (H/Q/F — 8 соединений и 70 запросов, Z — 5 и 11), поэтому отсутствие стоимости установления соединения односторонне выгодно HTTP-конфигурациям; отклонение зафиксировано, но его эффект не оценён","fix":"прогнать контрольную серию с --handshake-rtt (≥10 повторений на main) и записать разницу либо явно указать направление и порядок смещения в DEVIATIONS"}
]}
```
