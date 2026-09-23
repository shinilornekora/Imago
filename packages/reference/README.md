# packages/reference — независимый эталон (oracle)

Python‑пакет, который по JSON документа (экспорт генератора) и списку команд
вычисляет **ожидаемое** состояние документа и сверяет его с фактическим —
в PostgreSQL и в снимках страниц клиента (`window.__stand.getPageSnapshot`).
Реализует SPEC §1 и §2.3 заново, **без общих модулей с сервером** (§6, §10):
это оракул, а не переиспользование серверной логики.

## Установка

```bash
cd packages/reference
pip install -r requirements.txt          # psycopg[binary] 3.3.2, pytest 9.1.1
python -m pytest                         # 22 теста; интеграционные — на локальном PostgreSQL
```

Интеграционные тесты:

* `tests/test_db_integration.py` — создаёт собственную БД `stand_reference_test` на кластере
  `127.0.0.1:5432` (`postgres`/`postgres`), прогоняет оба бэкенда чтения (psycopg и `psql --csv`)
  и удаляет её после прогона;
* `tests/test_editor_db.py` — реальная БД стенда `editor` и экспорт генератора `data/acceptance.json`
  (50 × 500, источник S* со 100 экземплярами на 10 страницах): строгая валидация экспорта,
  сверка нетронутой БД с экспортом, затем приёмочная команда `setSourceFill(S*)` + локальная заливка,
  применённые server‑like SQL **в транзакции с откатом** (в `editor` ничего не остаётся) и сверенные
  по БД, по таблице `operations` (с имитацией повтора `opId`) и по снимку страницы 50.

При недоступном кластере/документе/файле тесты пропускаются. Переменные:
`STAND_DB_DSN`, `STAND_ACCEPTANCE_JSON`, `STAND_TEST_ADMIN_DSN`.

## Предметные правила, которые реализует модель (`reference/model.py`)

* `setSourceFill(targetId, fill)` — цель обязана быть источником; меняется `fill`
  источника **и всех экземпляров** с `sourceId == target` и `fillOverridden == false`
  на **всех** страницах (загруженных клиентом и нет). `affectedPages` — отсортированный
  список уникальных страниц изменённых фигур (включая страницу источника),
  `affectedShapes` — источник + все непереопределённые экземпляры.
* `setLocalFill(targetId, fill)` — цель: экземпляр или обычная фигура (не источник);
  ставит `fill` и `fillOverridden = true`. Совпадение локального цвета с цветом
  источника переопределение **не снимает** (§1.1). `affectedPages = [страница цели]`,
  `affectedShapes = 1`.
* Ревизия документа: начальная — из `document.revision`, `+1` за каждую применённую команду.
* Команда над отсутствующей (в т. ч. чужой) фигурой → `TargetNotFoundError`;
  команда от имени не‑владельца (`actorId ≠ document.ownerId`) → `ForbiddenTargetError`;
  `expectedRevision ≠ текущая` → `RevisionMismatchError`; неверный тип/заливка/вид
  цели → `InvalidCommandError`. При ошибке состояние не меняется.
* Модель применяет **ровно то, что ей передали**: две одинаковые команды = две ревизии.
  Идемпотентность повтора с тем же `opId` — свойство таблицы `operations` сервера
  и проверяется отдельно (`reference/operations.py`), а CLI по умолчанию схлопывает
  повторы `opId` в одну логическую операцию (`--no-dedupe` отключает).
* При загрузке документ валидируется: уникальные id, ссылки на страницы и источники,
  инвариант «непереопределённый экземпляр имеет заливку источника».

Выход модели: `expected_state()` → `{docId, revision, shapes:{id:{fill, fillOverridden, pageId}}}`;
`expected_page(pageId)` → `{pageId, revision, shapes:[{id,fill,fillOverridden}]}`;
`expected_results()` → ожидаемые `CommandResult` (`revision`, `affectedPages`, `affectedShapes`)
для каждой команды.

## Форматы входа

* Документ — `data/<name>.json`: `{meta, document:{id, ownerId, name, revision}, pages:[{id,index,name}], shapes:[Shape…]}`,
  `Shape` — как в `packages/shared/src/index.ts` (camelCase).
* Команды — JSON‑массив (или `{commands:[...]}`) объектов
  `{type:'setSourceFill'|'setLocalFill', targetId, fill:'#rrggbb', opId?, expectedRevision?, actorId?}`.
* Снимки клиента — каталог `*.json`; каждый файл: объект `{pageId, revision, shapes:[{id,fill,fillOverridden}]}`,
  список таких объектов или `{snapshots:[...]}`. Необязательное поле `afterCommands:n`
  сверяет снимок с состоянием после первых `n` команд (по умолчанию — после всех).

## CLI (`python -m reference.compare …`)

| Команда | Что делает |
|---|---|
| `compare-db --doc data/x.json --commands cmds.json --db postgres://postgres:postgres@127.0.0.1:5432/editor [--check-operations] [--out report.json]` | читает `documents.revision` и `shapes` из БД (psycopg, либо `psql --csv` при `--backend psql`), сравнивает `fill`/`fill_overridden`/`page_id` каждой фигуры, ревизию, наличие лишних/недостающих фигур; с `--check-operations` — ещё и таблицу `operations` |
| `compare-snapshots --doc … --commands … --snapshots dir/ [--require-pages p1,p2] [--require-visits visits.json] [--out report.json]` | снимки страниц клиента против ожидаемого состояния: множества id совпадают точно (ни лишних, ни недостающих), `fill`/`fillOverridden` равны, `revision` снимка ≥ ожидаемой. Снимок с полем `error` — расхождение, а не пропуск |
| `check-operations --doc … --commands … --db DSN` | ровно одна строка на логический `opId`, `result.revision` образует ожидаемую последовательность, `affectedPages`/`affectedShapes` совпадают с эталоном, лишних строк нет (`--allow-extra-ops` смягчает) |
| `expected --doc … --commands … [--out expected.json]` | выгрузить ожидаемое состояние и ожидаемые результаты команд |
| `dump-db --db DSN --doc-id <id> --out dump.json` | «psql → JSON»: дамп ревизии, фигур и операций; далее можно сравнивать офлайн через `--db-dump dump.json` вместо `--db` |

### `--require-visits` — сверка КАЖДОГО посещения страницы (дефект A11)

`--require-pages` требует наличия снимков перечисленных страниц. Этого мало для режима P: снимки
снимались в конце прогона, к этому моменту все страницы кроме последней вытеснены из окна кеша,
и обязательной оказывалась одна последняя страница маршрута — промежуточные «поздние переходы»
(§1.2, таблица 1) предметно не проверялись.

`--require-visits <file.json>` принимает **журнал посещений прогона** и требует, чтобы у каждого
посещения был свой снимок, снятый пока страница ещё в окне:

```json
{"visits": [{"seq": 0, "step": 0, "pageIndex": 1, "pageId": "doc-…-p1", "afterCommands": 0}]}
```

Снимок, покрывающий посещение, обязан нести `visitSeq` = `seq` того же посещения, тот же `pageId`
и тот же `afterCommands` (число команд прогона, завершившихся к моменту снимка — по нему выбирается
состояние эталонной модели). Проверяются четыре класса расхождений: `visit_snapshot_missing`,
`visit_page_mismatch`, `visit_moment_mismatch`, `snapshot_error`; плюс обычная сверка содержимого.
Пустой журнал — ошибка входа (код 2), а не «нечего проверять».

Оболочка передаёт журнал через `STAND_RUN_VISITS` (`scripts/reference-check.sh`, там же — полный
формат, который обязан писать сценарий). Тесты: `tests/test_compare.py`,
`test_visit_coverage_requires_a_snapshot_per_visit` и `test_cli_require_visits`.

После `pip install -e .` доступны также точки входа `compare-db`, `compare-snapshots`, `stand-reference`.

Код возврата: `0` — расхождений нет, `1` — есть расхождения, `2` — ошибка входных данных/БД.

## Отчёт (`--out report.json`)

```json
{
  "ok": false, "kind": "db", "docId": "…", "expectedRevision": 2, "actualRevision": 2,
  "counts": {"shapesExpected": 25000, "shapesActual": 25000, "compared": 25000,
             "fill": 1, "fillOverridden": 0, "pageId": 0, "missingInDb": 0, "extraInDb": 0, "revision": 0},
  "mismatchTotal": 1, "truncated": false,
  "mismatches": [{"kind": "fill", "shapeId": "…", "pageId": "…", "expected": "#ff0000", "actual": "#123456"}],
  "expectedResults": [{"index": 0, "opId": "…", "revision": 1, "affectedPages": ["…"], "affectedShapes": 101}],
  "operations": {"ok": true, "counts": {"logicalOps": 1, "rows": 1, "missing": 0, "duplicates": 0, "...": 0}}
}
```

Список `mismatches` ограничен `--max-mismatches` (по умолчанию 200); полное число — в `mismatchTotal`.
Любое расхождение = провал допуска конфигурации (SPEC §6).

## Допущения

* `affectedShapes` считает все затронутые командой фигуры (источник + непереопределённые
  экземпляры), даже если их заливка уже совпадала с новой — как `UPDATE … RETURNING` на сервере.
* Заливка в командах — строго `#rrggbb` в нижнем регистре (как `HEX_COLOR_RE` в `shared`).
* Функции `reference.db.read_document_state/read_operations/dump_db` принимают необязательное
  `conn` (открытое соединение psycopg) — чтение внутри чужой транзакции, как в тестах.
* `setLocalFill` над источником считается недопустимой командой (SPEC §2.3: цель — экземпляр
  или обычная фигура).
