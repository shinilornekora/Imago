# Критик: 3 — воспроизводимость и качество (K4), функциональные проверки и эталон (K2); K1/K3/K5 — по ходу

Проход 2, финальная реализация. Read-only по репозиторию, кроме этого файла. Серии не запускались,
службы не перезапускались, `scripts/run-all-series.sh` не вызывался ни с какими флагами.

## Оценки

K1: 8.8  K2: 8.2  K3: 9.0  K4: 8.3  K5: 8.8
Итог: 8.6

Оговорка о границах проверки: K1/K3/K5 проверены выборочно (по заданию фокус — K4 и K2), поэтому их
оценки означают «в проверенном объёме замечаний нет», а не полный аудит методики и анализа.

---

## Что подтвердилось запуском (чтобы дефекты ниже читались в масштабе)

* **Генератор детерминирован побитово.** Перегенерация всех семи пресетов в сторонний каталог даёт
  ровно те sha256, что лежат в `data/*.sha256`; `sha256sum -c` по `data/` — 7 из 7 `OK`.
* **Все опубликованные отчёты анализа воспроизводятся из сырых данных.** `analysis.cross` по
  одиннадцати сериям → `RESULTS_cross.md` совпал с опубликованным **побайтно** (0 строк diff);
  `analysis.summary` → `SUMMARY.md` — 0 строк diff; `analysis.report --series main` — 0 строк diff
  (см. дефект K4‑5 о флаге `--compare`). `--validate-only` даёт `OK` на всех 11 сериях.
* **Сырые данные соответствуют заявленному.** 834 строки, `outcome=ok` и `reference_ok=true` в
  834/834, `sampling_incomplete` пуст, `error_message` пуст; `retained_probe_mode` одинаков в
  834/834; `js_heap_gc_count` = 26/42/104 строго по маршруту серии; покрытие сэмплеров `api`, `pg`,
  `zero`, `chromium` = 1.0 во всех 834 прогонах (включая группу `zero` в прогонах H/Q — дефект A8
  прохода 1 закрыт); `credentialsVia = "page-context"` в 834/834 и `pass=` нет ни в одном URL.
* **Эталон не вакуозен.** По всем 834 `report-snapshots.json`: `ok=true`, `mismatchTotal=0`,
  `visits == visitsCovered` (11 / 50 / 19 по маршрутам), 6 500 сверенных фигур на прогон в `main`;
  `report-db.json` — 25 000 сверенных фигур и журнал операций каждый прогон.
* **Тесты и типы.** `npm test -w packages/server -w packages/netshaper -w packages/bench` — 47 + 12
  + 17, 0 fail; `npm test -w packages/client` — 16, 0 fail; `python3 -m pytest` — 24 (reference) и
  39 (analysis); `npm run typecheck --workspaces` — чисто по шести пакетам.
* **Compose валиден.** `docker compose --env-file <заполненный> --profile {h,q,z} config` → код 0 для
  всех трёх профилей.
* **Безопасность вживую.** 403 на чужой документ в обе стороны, 401 без токена и с мусорным токеном,
  401 на `/api/test/*` без секрета, 401 на `/api/zero/{query,mutate}`, 401 на `:4848/statz` и
  `/heapz`, `cache-control: no-store` без валидаторов, `exp − iat = 900` с, всё слушает `127.0.0.1`,
  в `packages/client/dist` нет ни паролей, ни `STAND_JWT_SECRET`, JWT‑токенов в `results/` — 0.
* **Инвариант генератора действительно связывает** (закрытие B19 проверено адверсариально): перенос
  всех экземпляров S1 с одной страницы на другую при сохранении счётчиков и `z` даёт
  `S1 pages: 4 != expected 5 (from p.s1Pages=5, p.pages=6)`; подмена `meta.s1.instances` ловится
  отдельной строкой.

---

## Дефекты (по убыванию серьёзности)

1. **[K4][high‑medium] `packages/bench/src/series/passport.mjs:138` (+ `packages/bench/series/*.json`,
   поле `api.password`) — пароль тестовой учётки записан во ВСЕ одиннадцать опубликованных паспортов,
   хотя документация утверждает обратное.**
   `buildPassport` кладёт в паспорт `seriesConfig: p.series` целиком, а каждая конфигурация серии
   содержит `"api": {"url": …, "login": "alice", "password": "alice-pass"}`
   (`packages/bench/series/main.json` и остальные 14 файлов). В итоге `alice-pass` лежит в
   `results/<серия>/passport.json` всех 11 серий и всего в **421 файле** под `results/`. Это прямо
   противоречит `packages/client/src/config.ts:29` («пароль … не попадает ни в строку запроса, ни в
   журналы доступа, ни в `Referer`, ни в счётчики шейпера, **ни в паспорт серии** (закрытие N9)») и
   `docs/PASSPORT.md:171`. Редактирование при этом в паспорте есть, но только для zero‑cache
   (`passport.mjs:234` `SECRET_ENV`), то есть непоследовательно.
   **Что сделать:** в `buildPassport` пропускать `seriesConfig` через редактор секретов (та же
   `SECRET_ENV` по ключам `password|secret|token`), а из `series/*.json` пароль убрать вовсе, читая
   его из среды (`STAND_ALICE_PASSWORD`) — как уже сделано для `.test-secret` и `.zero-admin`. Пока
   не исправлено, снять утверждение «ни в паспорт серии» из `config.ts` и `PASSPORT.md`.

2. **[K4][medium] Нет идентификатора измерительной оболочки, и она доказуемо менялась ВНУТРИ
   опубликованной программы.** `docs/PASSPORT.md:2.2` честно пишет, что `codeId` покрывает только
   собранные клиент и сервер, а `packages/bench/**`, `scripts/**` и конфигурации серий фиксируются
   лишь «косвенно», и предлагает в качестве гарантии «серии одной программы обязаны запускаться одним
   прогоном оркестратора». **Для программы как она опубликована это неверно:** восемь основных серий
   сняты 09:34–12:06, три дополнительные — 13:19–15:39, а между ними изменены
   `packages/bench/src/scenario/acceptance.mjs` (12:55), `src/series/run.mjs` (12:56),
   `src/series/csv.mjs` (12:55), `src/series/plan.mjs` (12:55),
   `src/sampling/chromium.mjs` (12:52). Следствие видно в данных: у восьми основных серий в
   `runs.csv` 100 колонок, у `route-full`/`route-repeat`/`command-shape` — 115 (добавились
   `route_len`, `nav_cache_hits`, `api_page_reads`, `cmd_variant`, …). Изменение аддитивное и
   описано в `COLUMNS.md`/`schema.py` как `OPTIONAL_COLUMNS`, но **ни один артефакт не говорит,
   какой версией оболочки снята серия**, а `docs/DEVIATIONS.md` §4.8 и §4.12 сопоставляют абсолютные
   величины `command-shape` с `main` — то есть через границу, на которой сценарий и раннер менялись.
   **Что сделать:** считать в `codeIdentity()` ещё и `benchId` — sha256 по `packages/bench/src/**`,
   `packages/bench/series/<этой серии>.json`, `scripts/reference-check.sh` и
   `packages/reference/reference/**` — и писать его в паспорт; в §4.8/§4.12 добавить, что две
   половины программы сняты разными версиями оболочки (перечислив, чем они отличаются).

3. **[K4][medium] `packages/generator/package.json:11` — пакет с `test`‑скриптом и нулём тестов.**
   `npm test -w packages/generator` печатает `pass 0 / fail 0` и выходит с кодом 0; каталога
   `packages/generator/test` нет. Пакет порождает ВСЕ документы, на которых сняты 834 прогона, и
   содержит нетривиальную логику (`generate.ts` 425 строк, `verify.ts` 212, `fileio.ts`
   сериализация, от которой зависит контрольная сумма). Документированная в `README.md:126` проверка
   `npm test --workspaces --if-present` создаёт впечатление покрытия, которого нет. Я проверил
   `checkInvariants` адверсариально вручную (см. выше) — он работает, но в репозитории этой проверки
   нет.
   **Что сделать:** добавить `packages/generator/test/` хотя бы с тремя тестами: (а) детерминизм —
   два вызова с одним seed дают одинаковый `serializeDocument`; (б) негативные тесты `checkInvariants`
   на мутированном документе (перенос экземпляра S1, перекраска непереопределённого экземпляра, ложь
   в `meta`); (в) `readDocumentFile` при несовпадении `.sha256`. Либо убрать `test`‑скрипт, чтобы
   `--if-present` не отчитывался об успехе.

4. **[K4/K1][medium] `infra/.env.example:9-10` + `infra/Caddyfile:24-27` — в контуре Docker тестовые
   хуки открыты без секрета на единственном публикуемом порту.** Пример среды задаёт
   `STAND_TEST_HOOKS=1` и `STAND_TEST_HOOKS_SECRET=` (пусто); compose передаёт пустое значение
   (`docker-compose.yml:91`), а `packages/server/src/routes/test.ts:13-14` при пустом секрете
   сохраняет «прежнее поведение (открытые хуки)». Caddyfile закрывает `403` административные пути
   zero‑cache (`Caddyfile:19-22`), но `/api/*` проксирует целиком, включая `/api/test/reset` и
   `/api/test/delay`. `README.md:138` при этом велит заполнить в `.env` только `STAND_JWT_SECRET` и
   `ZERO_ADMIN_PASSWORD`, а `README.md:143` и `infra/docker-compose.yml:170-173` прямо предусматривают
   `STAND_PUBLIC_BIND=0.0.0.0` для контрольного клиента §1.2 — то есть ровно ту конфигурацию, которую
   требует глава 1. Итог: любой, кто видит порт Caddy, сбрасывает чужой документ без токена.
   **Что сделать:** в `.env.example` поставить `STAND_TEST_HOOKS=0` по умолчанию (а при `=1` —
   обязательный непустой `STAND_TEST_HOOKS_SECRET:?`), и добавить в Caddyfile
   `@test path /api/test/* { respond 403 }` рядом с блоком `@zero_admin`.

5. **[K2][medium] `docs/…Отчёт….cd` §3.5 (`#pasport`) неверно описывает собственную проверку 5 у Z.**
   Отчёт пишет: «строка „ответ старого чтения“ для Z не воспроизводит переупорядочение (тестовый хук
   задержки действует только на HTTP) и сводится к наблюдению за отсутствием отката в течение трёх
   секунд». Реализация (`packages/bench/src/functional/checks/05-stale-read.mjs:14-30`) с некоторого
   момента делает именно переупорядочение: задерживает `POST /api/zero/query` (регистрацию synced
   query), команду подаёт **второй участник** по HTTP, и при недостижении поздней доставки ставит
   `skip`, а не `pass`. Записанные свидетельства это подтверждают: `Z/F` — «данные доставлены через
   4193 мс — на 3768 мс ПОЗЖЕ команды», `Z/P/1..10` — «на 1679–1693 мс ПОЗЖЕ команды», зонд «без
   отката» (`results/functional/admission-2026-09-13_09-25-16-small/summary.json`). Отчёт
   **занижает** качество собственной проверки, но это всё равно фактическая ошибка в описании стенда,
   и рецензент, сверив её с кодом, усомнится в остальных самооценках.
   **Что сделать:** переписать абзац по факту: задержка трансформации synced query + второй участник,
   измеренная поздняя доставка 1.7–3.8 с, `skip` вместо `pass` при несрабатывании механизма.

6. **[K2][medium] Покрытие таблицы 1 на ИЗМЕРЯЕМЫХ документах — частичное, и на документе целой серии
   пропущены три строки из шести.** По `results/functional/*-gate.md`: на `doc-acc-50x500` шли строки
   1–6 + инварианты (8 проверок), без Б1/Б2/Б3; на `doc-cmd-50x500` — документе, на котором сняты все
   **144 прогона** серии `command-shape`, — только `1-open`, `3-source-fill`, `I1`, `I2` плюс
   отдельным заходом `4-late-nav`. Строки **2 (локальная заливка), 5 (ответ старого чтения), 6 (повтор
   команды)** на этом документе не проверялись ни разу; полный набор унаследован с `doc-small-10x200`.
   Политика описана (`README.md:224-230`, `admission-gate.mjs:13-18`) и ворота её соблюдают, но SPEC §6
   и §1.7 требуют таблицу 1 для каждой конфигурации, а «наследование с другого документа» — это
   ослабление, которое в отчёте названо только числом строк («18 строк на документе серии формы
   команды»), без перечня того, что не проверялось.
   **Что сделать:** либо прогнать 2/5/6 на `doc-cmd-50x500` (≈ минуты), либо в `FUNCTIONAL_FINDINGS.md`
   и в §3.5 отчёта явно перечислить, какие строки таблицы 1 на каком измеряемом документе НЕ шли.

7. **[K2][medium] `packages/client/package.json:12` — набор тестов адаптера Z по умолчанию молча
   пропускается, а итог показывает «skipped 0».** `test/z.spec.mjs:22,37` включается только при
   `STAND_Z_E2E=1`, поэтому документированная в `README.md:126` команда
   `npm test --workspaces --if-present` печатает `tests 16 / pass 16 / skipped 0` — при том, что целый
   набор из 403 строк против реального стека не выполнялся (в выводе он виден лишь как строка
   `﹣ адаптер Z … # SKIP`, не попадающая в счётчики). Самый сложный адаптер (`z.ts`, 837 строк)
   документированной «обычной» проверкой не покрыт.
   **Что сделать:** либо печатать явное предупреждение и ненулевой `skipped` (например,
   `t.skip('...')` вместо `describe.skip`), либо в `README.md:126-128` поднять `npm run test:z` из
   скобок в обязательный шаг воспроизведения с пометкой «без него адаптер Z не проверен».

8. **[K4][medium‑low] Команда анализа из README не воспроизводит опубликованный
   `docs/results/RESULTS_main.md`.** `README.md:116-117` предписывает
   `python3 -m analysis.report --series ../../results/main --out … --compare <7 серий>`. Выполнение
   этой команды даёт файл, который **отличается от опубликованного на 200 строк**: появляется раздел
   «## 12. Сравнение серий» и 16 рисунков вместо 11. Опубликованный файл получен **без** `--compare`
   (проверено: та же команда без флага даёт diff в 0 строк). Кроме того, в корневом README вовсе нет
   команды `python3 -m analysis.summary`, которой построен `docs/results/SUMMARY.md` — «числовая опора
   итогового отчёта» (она есть только в `packages/analysis/README.md:61`).
   **Что сделать:** привести `README.md` §7 в соответствие с тем, чем отчёты фактически построены
   (убрать `--compare` или перестроить файл с ним) и добавить туда вызов `analysis.summary` с полным
   списком одиннадцати серий.

9. **[K4][medium‑low] Внутренние противоречия и устаревшие места в документах, которые цитирует
   диссертация.**
   * `docs/DEVIATIONS.md:649` и `:682` до сих пор утверждают, что пароль тестовой учётки передаётся
     `?pass=` и «попадает в журналы доступа и в счётчики шейпера» — это опровергнуто
     `docs/PASSPORT.md:171`, `docs/INTEGRATION.md:40-41`, `README.md:289` и данными
     (`credentialsVia="page-context"` в 834/834). Главный документ отклонений противоречит сам себе.
   * `docs/FUNCTIONAL_FINDINGS.md:5` называет порт `:3007` и сборку клиента «от 00:28 13.09», а
     таблицы §1 ссылаются на прогон `admission-2026-09-13_00-47-*` — это первый, **отладочный** заход
     (сам документ так его и называет в строке 51). Программу же допустил прогон
     `admission-2026-09-13_09-25-16-*` на порту `:3005`. Числа совпадают (112/0/0/20), но читатель
     изучает матрицу не того прогона, который открыл ворота.
   * `scripts/start-zero.sh:85` в комментарии пишет «shim подменяет на `0.0.0.0`», тогда как
     `scripts/zero-ipv4-shim.mjs:6,13` подменяет на `127.0.0.1` (и это принципиально — §1.6).
   **Что сделать:** вычистить три места; в `FUNCTIONAL_FINDINGS.md` перевести шапку и таблицы на
   прогон 09‑25‑16.

10. **[K5/K4][low] Числа в прозе не совпадают с порождёнными отчётами и сырыми данными.**
    `docs/DEVIATIONS.md:482` и `README.md:256`: «467.6 мс … против 242.3 в `main`». По сырым
    `runs.csv` медианы — **467.5** (Z/F `baseline`, n=6) и **242.2** (Z/F `main`, n=30); ровно эти
    значения печатают `RESULTS_command-shape.md:1463`, `RESULTS_main.md:524`, `FINDINGS.md:320,709`
    и сам отчёт (§4.11). Расхождение косметическое, но это именно та сверка, которую требует K5.
    **Что сделать:** привести оба места к 467.5 / 242.2.

11. **[K4][low] `SPEC.md` местами описывает не построенную систему.** `SPEC.md:178` — результат
    анализа «`docs/RESULTS.md`» (такого файла нет, есть `docs/results/*`); `SPEC.md:183` —
    `scripts/run-series.sh` (нет; есть `run-all-series.sh` и `packages/bench/src/series/run.mjs`);
    `SPEC.md:201` — `docs/… RESULTS, REPORT` (`REPORT` не существует); `SPEC.md:105` и `:127`
    объявляют синхронный `getRetained()` контрактом измерения, тогда как оболочка измеряет
    `getRetainedAsync()` у всех адаптеров (`README.md:191`, DEVIATIONS 2.4); `SPEC.md:23` — «7 ГиБ»
    против «8 ГиБ» в `README.md:65` (факт `totalMemMib = 8024`).
    **Что сделать:** либо обновить SPEC под построенное, либо (аккуратнее для диссертации) добавить в
    `DEVIATIONS` раздел «расхождения SPEC ↔ реализация» с этими пятью строками.

12. **[K4][low] Остатки и мусор в измеряемом периметре.**
    * `packages/bench/series/verify-timing.json` не упоминается **нигде** (ни скрипт, ни README, ни
      docs) — мёртвая конфигурация; `verify-final.json` встречается только в прозе
      (`DEVIATIONS.md:67`, `PASSPORT.md:151`) и не перечислен в списке серий
      `packages/bench/README.md:17-19`; `smoke-hq.json` оставлен (помечен «УСТАРЕВШАЯ» — закрытие B21
      осталось частичным).
    * «Комплект воспроизведения» = `results/` весит **1.9 ГиБ** и включает живую реплику zero‑cache
      `results/zero-replica/` (54 МиБ вместе с `-wal`, `-wal2`, `-shm` — это рабочий артефакт, а не
      данные), `results/archive/` 284 МиБ и два файла секретов
      `results/logs/.test-secret`, `.zero-admin` (права 600, в `.gitignore` — но каталог **не**
      является git‑репозиторием, поэтому `.gitignore` сегодня ничего не защищает).
    **Что сделать:** удалить `verify-timing.json` (или внести его в README), вынести `zero-replica`
    из `results/` (например, `var/zero-replica`), и в §9 отчёта / README назвать, что из `results/`
    входит в комплект, а что — нет.

13. **[K4][low] Глушение отказа в измеряемом пути: `packages/client/src/adapters/z.ts:800-802`.**
    `refreshRetained()` при исключении пишет `console.warn` и **сохраняет прежнее значение**
    `this.retained`, которое затем публикуется как измерение `retained_*`. Признака «проба не
    состоялась» в записи прогона нет. Фактически ни разу не сработало (консольных сообщений во всех
    834 прогонах — **0**, проверено по `runs/*.json`), но защита держится на этом, а не на коде.
    Смежно: `stand.ts:599-601` — `deleteAllIndexedDb()` при ошибке молча возвращается, то есть выход
    мог бы не очистить IDB без единого события (ловится только функциональной проверкой Б2);
    `z.ts:431-435` так же глушит `dropAllDatabases()`.
    **Что сделать:** при неудаче пробы ставить `retained = null` и отдельный флаг в запись прогона
    (и в `sampling_incomplete`); в `logout` при ошибке очистки эмитить `error{scope:'logout'}`.

14. **[K4][low] Секрет подписи по умолчанию лежит в репозитории: `scripts/lib.sh:18`
    (`STAND_JWT_SECRET:-stand-sandbox-secret-0123456789`), плюс запасной
    `packages/server/src/config.ts:46`.** §1.2/§1.6 требуют секрет только из среды. Отклонение
    названо честно (`docs/DEVIATIONS.md:696`) и для петлевого стенда безобидно, но любой, кто поднимет
    стенд по `scripts/` вне петли, получит предсказуемый ключ подписи — и он же уходит в
    `ZERO_AUTH_SECRET` (`start-zero.sh:75`).
    **Что сделать:** сделать как с `.test-secret`: при отсутствии переменной генерировать секрет в
    `results/logs/.jwt-secret` (0600) и переиспользовать.

15. **[K2][low] Артефакт «лага реплики» на свежесброшенном документе закрыт наблюдением, а не кодом.**
    `results/functional/gaps-2026-09-13_13-04-39-command-shape` — `fail` у Z/F и Z/P/1
    (`expected revision 1, current is 0`); лечение — разбиение набора на четыре отдельных захода
    (`…13-14-18-cmdshape-{a,b,c,d}`), причём `b/c/d` выполняют ровно одну проверку `4-late-nav`.
    Разбор в `docs/DEVIATIONS.md:541-561` честный и полный — это плюс; но в самом
    `gaps-…-gate.md` строки `command-shape` идут без единого примечания (`notes` пуст), а тезис «в
    сериях не воспроизводился ни разу» опирается на отсутствие отказов в данных, а не на ожидание
    догона реплики между `POST /api/test/reset` и открытием клиента в `run.mjs`.
    **Что сделать:** после сброса у конфигураций Z ждать, пока `documents.revision` из реплики
    совпадёт с серверной (одна дешёвая проверка через `window.__stand` или `GET :4848`), и
    переносить причину разбиения набора в `notes` ворот.

16. **[K1][low] `packages/server/src/domain/pgTx.ts:42-49` — `updateSourceAndInstances` не фильтрует
    по `document_id`.** `UPDATE shapes … WHERE (id = $1 AND is_source) OR (source_id = $1 AND NOT
    fill_overridden)` красит экземпляры по всей таблице. Сегодня безопасно (идентификаторы источников
    уникальны, экземпляры лежат в том же документе по построению генератора, а права проверены на
    целевой фигуре в `executeCommand.ts:72-77`), но предметное правило §1.1 сформулировано в границах
    документа, и защита держится на данных, а не на запросе.
    **Что сделать:** добавить `AND document_id = $2` в оба дизъюнкта и передавать `docId`.

17. **[K5][low] Предупреждение numpy в документированной команде.**
    `python3 -m analysis.summary …` печатает в stderr
    `analysis/stats.py:394: RuntimeWarning: invalid value encountered in divide` (деление на нулевую
    медиану F при расчёте отношения P/F). Результат корректен (`nan` → прочерк в таблице), но в
    воспроизводящей команде такое предупреждение читается как сбой.
    **Что сделать:** считать отношение только при `med(F) > 0`, иначе сразу `nan`, и не трогать numpy.

---

## Что проверено лично (команды)

```bash
# тесты и типы
npm test -w packages/server -w packages/netshaper -w packages/bench     # 47 + 12 + 17, 0 fail
npm test -w packages/client                                            # 16, 0 fail (z.spec.mjs SKIP)
npm test -w packages/generator                                         # pass 0 — тестов нет
npm run typecheck --workspaces                                         # 6 пакетов, чисто
cd packages/reference && python3 -m pytest -q                          # 24 passed
cd packages/analysis  && python3 -m pytest -q                          # 39 passed

# детерминизм генератора (в сторонний каталог, репозиторий не тронут)
for p in acceptance cmd-50x500 small-5x100 small-10x200 large-100x500 dense-50x1000 bob-5x50; do
  npx tsx src/cli.ts preset $p --out <tmp>; done                       # 7/7 sha256 == data/*.sha256
cd data && sha256sum -c *.sha256                                       # 7/7 OK
# адверсариальная проверка checkInvariants (мутации документа в памяти, вне репозитория)

# воспроизведение опубликованного анализа (вывод в сторонний каталог)
python3 -m analysis.report --series ../../results/main --validate-only           # и ещё 10 серий → OK
python3 -m analysis.report --series ../../results/main --out <tmp>              # diff 0 строк
python3 -m analysis.report --series ../../results/main --out <tmp> --compare …  # diff 200 строк (§12)
python3 -m analysis.cross  --series <11 серий> --out <tmp>                      # diff 0 строк
python3 -m analysis.summary --series <11 серий> --out <tmp>                     # diff 0 строк

# сырые данные (только чтение)
python3: 11×runs.csv → 834 строки, outcome/reference_ok/sampling_incomplete/error_message
python3: 834×runs/*.json → consoleErrors, coverage групп, credentialsVia, url
python3: 834×reference/*/report-snapshots.json и report-db.json → ok, counts, visits
python3: 11×passport.json → code/codeId/buildId, preSeriesChecks, shaper.effective, seriesConfig
python3: results/functional/*/summary.json и *-gate.json → checkSet, totals, verdicts, сообщения

# инфраструктура и безопасность (read-only)
docker compose --env-file <tmp> --profile {h,q,z} config                # код 0 для всех трёх
ss -ltnp; ps aux                                                        # 3000/4848/4849/8080/8081/5432 → 127.0.0.1
curl: login alice/bob; GET чужого документа (403 ×2); без токена (401); мусорный токен (401);
      POST /api/test/reset без секрета (401); POST /api/zero/{query,mutate} без токена (401);
      GET :4848/{statz,heapz} (401), / (200); заголовки страницы (no-store, без ETag); exp−iat = 900
psql -Atc: documents.revision (все 0), count(operations) = 0, \dt
grep: alice-pass / bob-pass / STAND_JWT_SECRET по packages/client/dist → 0; по results/ → 421 файл;
      eyJhbGciOiJIUzI1NiI по results/ → 0
mtime‑сверка packages/** против времён серий и сборки client/dist
```

Не запускалось: `scripts/run-all-series.sh` (в том числе с `--dry-run`), серии, `npm run test:z`
(изменил бы состояние БД), перезапуск служб. Файлы репозитория, кроме этого отчёта, не изменялись.

---

```json
{"critic":"3 — воспроизводимость и качество кода, функциональные проверки и эталон","pass":2,"scores":{"K1":8.8,"K2":8.2,"K3":9.0,"K4":8.3,"K5":8.8},"overall":8.6,"defects":[
{"k":"K4","severity":"high-medium","where":"packages/bench/src/series/passport.mjs:138 + packages/bench/series/*.json (api.password)","what":"seriesConfig копируется в паспорт целиком вместе с паролем тестовой учётки: alice-pass лежит во всех 11 results/<серия>/passport.json и в 421 файле под results/, хотя packages/client/src/config.ts:29 и docs/PASSPORT.md:171 утверждают, что пароль в паспорт серии не попадает; ZERO_*-секреты при этом редактируются (passport.mjs:234) — редактирование непоследовательно","fix":"пропускать seriesConfig через тот же редактор секретов и убрать пароль из series/*.json (читать из среды); пока не сделано — снять ложное утверждение из config.ts и PASSPORT.md"},
{"k":"K4","severity":"medium","where":"packages/bench/src/series/passport.mjs:280-292 (codeIdentity), docs/PASSPORT.md §2.2","what":"идентификатор кода покрывает только собранные клиент и сервер; оболочка (acceptance.mjs, run.mjs, csv.mjs, plan.mjs, chromium.mjs) изменена 12:52-12:56 МЕЖДУ прогоном восьми основных серий (09:34-12:06) и трёх дополнительных (13:19-15:39), схема runs.csv выросла со 100 до 115 колонок, и ни один артефакт не говорит, какой версией оболочки снята серия; при этом DEVIATIONS §4.8/§4.12 сопоставляют абсолютные величины command-shape с main через эту границу","fix":"добавить benchId = sha256 по packages/bench/src/**, конфигурации серии, scripts/reference-check.sh и packages/reference/reference/** в паспорт; в §4.8/§4.12 указать, что половины программы сняты разными версиями оболочки"},
{"k":"K4","severity":"medium","where":"packages/generator/package.json:11","what":"пакет, порождающий все измеряемые документы (generate.ts 425 строк, verify.ts 212, сериализация, от которой зависит sha256), имеет test-скрипт и ноль тестов: npm test печатает pass 0 и выходит 0, поэтому документированная README.md:126 проверка `npm test --workspaces --if-present` создаёт видимость покрытия","fix":"добавить packages/generator/test/ (детерминизм по seed, негативные тесты checkInvariants, проверка несовпадения .sha256) либо убрать test-скрипт"},
{"k":"K4","severity":"medium","where":"infra/.env.example:9-10, infra/Caddyfile:24-27, infra/docker-compose.yml:91","what":"в контуре Docker пример среды включает STAND_TEST_HOOKS=1 с пустым STAND_TEST_HOOKS_SECRET, а Caddy проксирует /api/* целиком (403 стоит только на административных путях zero-cache), поэтому POST /api/test/reset и /api/test/delay доступны без аутентификации на единственном публикуемом порту — включая предусмотренный README.md:143 и §1.2 режим STAND_PUBLIC_BIND=0.0.0.0","fix":"в .env.example по умолчанию STAND_TEST_HOOKS=0 (а при =1 требовать непустой секрет через :?), и добавить в Caddyfile respond 403 на /api/test/*"},
{"k":"K2","severity":"medium","where":"docs/…Отчёт….cd §3.5 против packages/bench/src/functional/checks/05-stale-read.mjs:14-30","what":"отчёт утверждает, что проверка 5 у Z «не воспроизводит переупорядочение» и «сводится к наблюдению за отсутствием отката в течение трёх секунд»; реализация задерживает POST /api/zero/query, команду подаёт второй участник по HTTP и помечает skip при несрабатывании, а записанные свидетельства показывают доставку на 1679-3768 мс ПОЗЖЕ команды","fix":"переписать абзац §3.5 по факту (задержка трансформации synced query + второй участник, измеренная поздняя доставка, skip вместо pass)"},
{"k":"K2","severity":"medium","where":"results/functional/gaps-2026-09-13_13-14-18-gate.md:7-10 и admission-2026-09-13_09-25-16-gate.md","what":"на doc-cmd-50x500 (документ всех 144 прогонов серии command-shape) шли только строки 1 и 3 таблицы 1 плюс инварианты и отдельным заходом строка 4; строки 2, 5 и 6 на нём не проверялись ни разу, полный набор унаследован с doc-small-10x200. На doc-acc-50x500 не шли проверки безопасности. Политика документирована, но перечень непроверенного в FUNCTIONAL_FINDINGS и в отчёте не приведён","fix":"прогнать 2/5/6 на doc-cmd-50x500 либо явно перечислить в FUNCTIONAL_FINDINGS.md и §3.5 отчёта, какие строки таблицы 1 на каком измеряемом документе не выполнялись"},
{"k":"K2","severity":"medium","where":"packages/client/package.json:12, packages/client/test/z.spec.mjs:22,37","what":"набор тестов адаптера Z (403 строки против реального стека) включается только при STAND_Z_E2E=1 и пропускается через describe.skip, поэтому документированная README.md:126 команда печатает «tests 16 / pass 16 / skipped 0» и самый сложный адаптер остаётся непроверенным без предупреждения","fix":"сделать пропуск видимым в счётчиках (skipped>0) и поднять npm run test:z в README до обязательного шага с пометкой о последствиях пропуска"},
{"k":"K4","severity":"medium-low","where":"README.md:116-118 против docs/results/RESULTS_main.md и docs/results/SUMMARY.md","what":"команда analysis.report из README указана с --compare, но опубликованный RESULTS_main.md построен БЕЗ него: повтор по README даёт файл на 200 строк больше (раздел «12. Сравнение серий», 16 рисунков вместо 11). Команда analysis.summary, которой построен SUMMARY.md («числовая опора итогового отчёта»), в корневом README отсутствует вовсе","fix":"привести README §7 к тому, чем отчёты фактически построены, и добавить вызов analysis.summary по одиннадцати сериям"},
{"k":"K4","severity":"medium-low","where":"docs/DEVIATIONS.md:649,682; docs/FUNCTIONAL_FINDINGS.md:5,14; scripts/start-zero.sh:85","what":"DEVIATIONS до сих пор утверждает, что пароль идёт через ?pass= и попадает в журналы (опровергнуто PASSPORT.md:171, INTEGRATION.md:40, README.md:289 и данными credentialsVia=page-context в 834/834); FUNCTIONAL_FINDINGS описывает отладочный прогон 00-47 на порту 3007 и «сборку от 00:28», тогда как программу допустил прогон 09-25-16 на порту 3005; комментарий start-zero.sh говорит о подмене :: → 0.0.0.0, а shim подменяет на 127.0.0.1","fix":"вычистить три места; шапку и таблицы FUNCTIONAL_FINDINGS перевести на прогон 09-25-16"},
{"k":"K5","severity":"low","where":"docs/DEVIATIONS.md:482, README.md:256","what":"в прозе 467.6 и 242.3 мс, тогда как сырые runs.csv и все порождённые отчёты (RESULTS_command-shape.md:1463, RESULTS_main.md:524, FINDINGS.md:320,709, сам отчёт §4.11) дают 467.5 и 242.2","fix":"привести оба места к 467.5 / 242.2"},
{"k":"K4","severity":"low","where":"SPEC.md:23,105,127,178,183,201","what":"SPEC описывает несуществующие артефакты (docs/RESULTS.md, scripts/run-series.sh, docs/REPORT), объявляет контрактом измерения синхронный getRetained(), тогда как измеряется getRetainedAsync(), и называет 7 ГиБ там, где README и паспорт дают 8 ГиБ (8024 МиБ)","fix":"обновить SPEC под построенное либо завести в DEVIATIONS раздел «расхождения SPEC ↔ реализация» с этими строками"},
{"k":"K4","severity":"low","where":"packages/bench/series/verify-timing.json, verify-final.json, smoke-hq.json; results/zero-replica/; results/logs/.test-secret, .zero-admin","what":"verify-timing.json не упоминается нигде (мёртвая конфигурация), verify-final.json отсутствует в списке серий packages/bench/README.md:17-19, smoke-hq.json оставлен (закрытие B21 частичное); «комплект воспроизведения» results/ весит 1.9 ГиБ и включает живую реплику zero-cache (54 МиБ с WAL), 284 МиБ архива и два файла секретов, а каталог не является git-репозиторием, поэтому .gitignore ничего не защищает","fix":"удалить или задокументировать verify-timing.json, вынести zero-replica из results/, и назвать в §9 отчёта состав комплекта явно"},
{"k":"K4","severity":"low","where":"packages/client/src/adapters/z.ts:800-802, 431-435; packages/client/src/stand.ts:599-601","what":"отказ пробы удержания у Z глушится console.warn и публикуется прежнее значение retained без признака сбоя (фактически не срабатывало: консольных сообщений в 834 прогонах 0); logout при ошибке очистки IndexedDB молча возвращается — отказ виден только функциональной проверке Б2","fix":"при неудаче пробы писать retained=null и отметку в sampling_incomplete; при ошибке очистки эмитить error{scope:'logout'}"},
{"k":"K4","severity":"low","where":"scripts/lib.sh:18, packages/server/src/config.ts:46, scripts/start-zero.sh:75","what":"в репозитории лежит постоянный секрет подписи по умолчанию (stand-sandbox-secret-…), он же уходит в ZERO_AUTH_SECRET; §1.2/§1.6 требуют секрет только из среды. Отклонение названо в DEVIATIONS.md:696, но умолчание остаётся","fix":"генерировать секрет при первом старте в results/logs/.jwt-secret (0600), как уже сделано для .test-secret и .zero-admin"},
{"k":"K2","severity":"low","where":"results/functional/gaps-2026-09-13_13-04-39-command-shape против …13-14-18-cmdshape-{b,c,d}; packages/bench/src/series/run.mjs (сброс перед прогоном)","what":"отказ Z «expected revision 1, current is 0» на свежесброшенном документе обойдён разбиением набора проверок на отдельные заходы; разбор честный (DEVIATIONS.md:541-561), но в gate-отчёте строки command-shape идут без примечания, а тезис «в сериях не воспроизводился ни разу» опирается на отсутствие отказов, а не на ожидание догона реплики после reset","fix":"после reset у конфигураций Z ждать совпадения ревизии из реплики с серверной перед открытием клиента; причину разбиения набора перенести в notes ворот"},
{"k":"K1","severity":"low","where":"packages/server/src/domain/pgTx.ts:42-49","what":"updateSourceAndInstances красит строки по source_id без фильтра document_id: правило §1.1 сформулировано в границах документа, а запрос опирается на то, что данные так устроены","fix":"добавить AND document_id = $2 в оба дизъюнкта WHERE и передавать docId"},
{"k":"K5","severity":"low","where":"packages/analysis/analysis/stats.py:394","what":"документированная команда analysis.summary печатает RuntimeWarning: invalid value encountered in divide (деление на нулевую медиану F в бутстрепе отношения P/F); результат корректен (nan → прочерк), но в воспроизводящей команде предупреждение читается как сбой","fix":"считать отношение только при med(F)>0, иначе сразу nan"}
]}
```
