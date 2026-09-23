#!/usr/bin/env bash
# Проверка прогона эталоном (packages/reference) — вызывается измерительной оболочкой как
# `referenceCommand` ПОСЛЕ каждого прогона и ДО сброса документа перед следующим.
# Вход (переменные среды от packages/bench/src/series/run.mjs):
#   STAND_DOC_JSON          экспорт генератора (data/<name>.json)
#   STAND_RUN_COMMANDS      JSON команд прогона (одна setSourceFill с фактическим opId)
#   STAND_RUN_SNAPSHOTS_DIR каталог снимков страниц клиента (по файлу на страницу)
#   STAND_REQUIRE_PAGES     pageId через запятую, снимки которых обязаны присутствовать (ПУСТОЙ = ошибка 3)
#   STAND_RUN_VISITS        JSON-журнал посещений страниц прогона: по записи на каждое посещение,
#                           дошедшее до `page-ready` (см. ниже). ОБЯЗАТЕЛЕН (ошибка 5), если только
#                           STAND_REF_VISITS_REQUIRED=0
#   STAND_REF_DIR           куда писать отчёты (report-snapshots.json, report-db.json, reference.log)
#   STAND_DB_URL            DSN PostgreSQL (по умолчанию postgres://postgres:postgres@127.0.0.1:5432/editor)
# Код возврата 0 — все проверки прошли; 1 — расхождение с эталоном; 3 — пустой STAND_REQUIRE_PAGES
# (сверка снимков была бы вакуозной); 4 — в прогоне нет команд (сверка с БД тривиальна);
# 5 — нет журнала посещений (в P сверялась бы только последняя страница маршрута — дефект A11).
# Иначе ≠ 0 → reference_ok=false.
#
# --- Дефект A11: что обязан записывать сценарий ------------------------------------------------
# Раньше в режиме P эталону была обязательна ТОЛЬКО последняя страница маршрута: снимки снимались
# в конце прогона, а к этому моменту все прочие страницы уже вытеснены из окна кеша, поэтому
# промежуточные «поздние переходы» предметно не проверялись вовсе. Чтобы сверять все загруженные
# страницы, снимок каждой надо снимать, ПОКА она ещё в окне.
#
# Сценарий (`packages/bench/src/scenario/acceptance.mjs`) обязан для КАЖДОГО посещения страницы,
# дошедшего до `page-ready`, записать снимок в момент, когда страница ещё удерживается клиентом
# (сразу после `page-ready` и/или непосредственно перед уходом с неё), и вести журнал посещений.
#
#   снимок  →  $STAND_RUN_SNAPSHOTS_DIR/v<seq:3>-<pageId>.json
#     {"pageId": "<pageId>", "revision": <int>, "shapes": [{"id","fill","fillOverridden"}, …],
#      "visitSeq": <seq>, "afterCommands": <сколько команд прогона ЗАВЕРШИЛОСЬ к этому моменту>}
#     `shapes` — ПОЛНЫЙ набор фигур страницы (множества id сверяются точно).
#     Не снявшийся снимок пишется как {"pageId":…, "visitSeq":…, "error":"<причина>"} — это провал
#     прогона, а не пропуск.
#
#   журнал  →  $STAND_RUN_VISITS  (например <refDir>/visits.json)
#     {"visits": [{"seq":0, "step":0, "pageIndex":1, "pageId":"…", "afterCommands":0}, …]}
#     по записи на посещение, в порядке прогона; `seq` уникален и совпадает с `visitSeq` снимка.
#
# `afterCommands` нужен, чтобы страницу, посещённую ДО команды, сверять с состоянием до команды:
# приёмочный сценарий подаёт одну команду после 5-го перехода, поэтому у ранних посещений это 0,
# у поздних — 1. Эталон проверяет: (а) у каждого посещения есть свой снимок, (б) снимок относится
# к той же странице и к тому же моменту, (в) содержимое совпадает с эталонной моделью.
set -uo pipefail
export PATH=/opt/node24/bin:$PATH
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_URL="${STAND_DB_URL:-postgres://postgres:postgres@127.0.0.1:5432/editor}"
REF_DIR="${STAND_REF_DIR:?STAND_REF_DIR is required}"
DOC_JSON="${STAND_DOC_JSON:?STAND_DOC_JSON is required}"
CMDS="${STAND_RUN_COMMANDS:?STAND_RUN_COMMANDS is required}"
SNAPS="${STAND_RUN_SNAPSHOTS_DIR:?STAND_RUN_SNAPSHOTS_DIR is required}"
mkdir -p "$REF_DIR"
LOG="$REF_DIR/reference.log"
: >"$LOG"

cd "$ROOT/packages/reference"
rc=0

# Пустой STAND_REQUIRE_PAGES означал бы вызов compare-snapshots БЕЗ --require-pages, то есть сверку,
# которая проходит на нуле снимков (критик B, п. 13). Это не «эталон совпал», а отсутствие сверки.
if [[ -z "${STAND_REQUIRE_PAGES:-}" ]]; then
  echo "FATAL: STAND_REQUIRE_PAGES пуст — сверять нечего, эталон НЕ подтверждён" >>"$LOG"
  echo "reference-check: STAND_REQUIRE_PAGES пуст (в прогоне не определилась ни одна обязательная страница) — reference_ok=false" >&2
  cat "$LOG" >&2
  exit 3
fi
req=(--require-pages "$STAND_REQUIRE_PAGES")

# Журнал посещений (дефект A11). Без него сверяются только страницы из STAND_REQUIRE_PAGES, а в P
# это одна последняя страница маршрута — то есть промежуточные переходы не проверяются.
VISITS_REQUIRED="${STAND_REF_VISITS_REQUIRED:-1}"
if [[ -n "${STAND_RUN_VISITS:-}" && -s "${STAND_RUN_VISITS}" ]]; then
  req+=(--require-visits "$STAND_RUN_VISITS")
  echo "visits: $STAND_RUN_VISITS ($(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d.get("visits",d) if isinstance(d,dict) else d))' "$STAND_RUN_VISITS" 2>/dev/null || echo '?') посещений)" >>"$LOG"
elif [[ "$VISITS_REQUIRED" == "1" ]]; then
  {
    echo "FATAL: STAND_RUN_VISITS не задан (или файл пуст) — сверяются только страницы из"
    echo "       STAND_REQUIRE_PAGES ('${STAND_REQUIRE_PAGES}'), а в режиме P это одна последняя"
    echo "       страница маршрута: предметная правильность промежуточных переходов не проверена."
    echo "       Сценарий обязан писать снимок на КАЖДОЕ посещение страницы и журнал посещений —"
    echo "       формат описан в шапке scripts/reference-check.sh (дефект A11)."
    echo "       Осознанно отключить: STAND_REF_VISITS_REQUIRED=0 (это ослабление эталона, и оно"
    echo "       должно быть названо в отчёте серии)."
  } >>"$LOG"
  echo "reference-check: нет журнала посещений (STAND_RUN_VISITS) — reference_ok=false (A11)" >&2
  cat "$LOG" >&2
  exit 5
else
  echo "ВНИМАНИЕ: STAND_REF_VISITS_REQUIRED=0 — сверяются только STAND_REQUIRE_PAGES (дефект A11 не закрыт для этого прогона)" >>"$LOG"
fi

# Команда обязана быть: прогон без команды даёт тривиально истинный compare-db (БД == исходное состояние).
CMD_COUNT="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$CMDS" 2>/dev/null || echo 0)"
if [[ "$CMD_COUNT" == "0" ]]; then
  echo "FATAL: список команд прогона пуст — сверка с эталоном тривиальна (БД совпала бы с исходным состоянием)" >>"$LOG"
  echo "reference-check: команд в прогоне нет — reference_ok=false (прогон оборвался до команды)" >&2
  cat "$LOG" >&2
  exit 4
fi

echo "== compare-snapshots ($(ls "$SNAPS" 2>/dev/null | wc -l) files; require ${STAND_REQUIRE_PAGES}; команд ${CMD_COUNT})" >>"$LOG"
python3 -m reference.compare compare-snapshots --doc "$DOC_JSON" --commands "$CMDS" --snapshots "$SNAPS" "${req[@]}" \
  --out "$REF_DIR/report-snapshots.json" >>"$LOG" 2>&1
r=$?; echo "exit $r" >>"$LOG"; [[ $r -eq 0 ]] || rc=1

echo "== compare-db (+operations)" >>"$LOG"
python3 -m reference.compare compare-db --doc "$DOC_JSON" --commands "$CMDS" --db "$DB_URL" --check-operations \
  --out "$REF_DIR/report-db.json" >>"$LOG" 2>&1
r=$?; echo "exit $r" >>"$LOG"; [[ $r -eq 0 ]] || rc=1

python3 - "$REF_DIR" >>"$LOG" 2>&1 <<'EOF'
import json, sys, os
d = sys.argv[1]
for name in ("report-snapshots.json", "report-db.json"):
    p = os.path.join(d, name)
    if not os.path.exists(p):
        print(f"{name}: (no report)"); continue
    r = json.load(open(p))
    print(f"{name}: ok={r.get('ok')} expectedRevision={r.get('expectedRevision')} actualRevision={r.get('actualRevision')} counts={r.get('counts')} mismatchTotal={r.get('mismatchTotal')}")
    for m in (r.get("mismatches") or [])[:5]:
        print("  ", m)
    ops = r.get("operations")
    if ops is not None:
        print(f"  operations: ok={ops.get('ok')} counts={ops.get('counts')}")
EOF
echo "result: $([[ $rc -eq 0 ]] && echo OK || echo FAIL)" >>"$LOG"
[[ $rc -eq 0 ]] || cat "$LOG" >&2
exit $rc
