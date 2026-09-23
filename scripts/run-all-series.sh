#!/usr/bin/env bash
# Все серии измерений подряд (SPEC §7.4) с функциональным допуском (§1.7) и файлом прогресса.
#
#   scripts/run-all-series.sh [--estimate] [--dry-run] [--skip-functional] [--only main,cache3,…] [--from doc5x100]
#                             [--with-optional]
#
# ПРОГРАММА 2 (после исправлений по второму проходу критики): все серии снимаются ОДНОЙ версией
# оболочки (passport.harness.harnessId одинаков у всех серий — это и есть проверка сопоставимости),
# повторений 30 у main и 15 у остальных (12 у command-shape, где 24 ячейки), добавлена ось размера
# при ПОСТОЯННОЙ доле посещённого (size-fraction-*), у route-repeat появились F-плечи,
# серия cache10 снята с программы: её окно (10) на приёмочном маршруте не связывает — ту же ось
# закрывает ячейка cache=10 серии route-repeat, где окно связывает.
#
# Порядок: (1) проверка стенда: PostgreSQL, API :3000 (STAND_LOG_LEVEL=warn — иначе перезапуск с warn),
# zero-cache :4848, шейпер :8080/:8081, документы на revision 0, непустые группы процессов для сэмплеров;
# (2) функциональный допуск §1.7 ВСЕХ измеряемых конфигураций (H,Q,Z × F, P/1, P/3, P/10) и на ТЕХ документах,
# которые измеряются: полная матрица на малом документе, проверки 1–6 + инварианты на приёмочном 50×500,
# окна кеша 3/10 и документы прочих серий — сокращёнными наборами; все адаптеры на собственном API :3005
# (Z — WebSocket прямо в zero-cache :4848); затем admission-gate сверяет покрытие; провал = стоп;
# (3) серии по порядку (порядок = убывание важности: прерванная программа даёт полные ранние серии):
# main (30), size-fraction-25x500/50x500/100x500 (15), route-repeat (10, 12 ячеек: F + P×{1,3,10}),
# command-shape (6, 24 ячейки), route-full (10), rtt150 (10; раннер сам переключает шейпер на 75 мс
# и восстанавливает после), doc50x1000 (10), doc5x100 (10), cache3 (10, F + P/3).
# Серии cache10, doc10x200 и doc100x500 сняты с программы окончательно (см. ниже).
# Каждая серия возобновляется (уже выполненные run_id пропускаются) — скрипт можно перезапускать.
# Прогресс: results/progress.json (серия, индекс/всего серий, прогон N/всего, ETA, последний исход);
# лог: results/logs/run-all-series.log.
#   --estimate        только напечатать оценку времени и выйти. Опора — results/smoke/runs.csv, но этот
#                     каталог удалён перед итоговой программой, поэтому фактически берутся встроенные
#                     коэффициенты (fallback ниже). Факт: 8 основных серий — 152 мин, группа из трёх — 140 мин
#   --dry-run         проверки стенда + план серий без запуска прогонов
#   --skip-functional пропустить функциональный допуск (уже пройден сегодня)
#   --only a,b        только перечисленные серии (в заданном выше порядке; имена НЕОБЯЗАТЕЛЬНОЙ группы
#                     распознаются тоже и идут после стандартных)
#   --from name       начать с серии name (пропустить предыдущие)
#   --with-optional   добавить серии ВНЕ программы (cache10, doc10x200) после программного порядка;
#                     без этого флага (и без упоминания в --only) они не запускаются
# Переменные: STAND_ALLOW_MIXED_HARNESS=1 — разрешить дописывать прогоны к каталогу, снятому другой
# версией оболочки (по умолчанию программа останавливается: строки в одном runs.csv были бы
# несопоставимы); STAND_FUNCTIONAL_EXTRA_DOCS=0 — не проверять документы серий doc5x100/doc100x500/doc50x1000/size-fraction-*
# (ограничение фиксируется в отчёте); STAND_ADMISSION_ALLOW_CAVEAT=1 — ослабить ворота допуска до
# «допуска с оговоркой» (по умолчанию СТРОГО: пропущенная строка таблицы 1 = конфигурация к серии
# не допускается, §1.7; дефект N8).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

# ПОРЯДОК ПРОГРАММЫ. Все перечисленные серии входят в один прогон оркестратора (одна версия
# оболочки на всю программу — дефект «оболочка менялась внутри программы»):
#   main                   — приёмочный сценарий §7.2, 6 конфигураций, 30 повторений (§1.8);
#   size-fraction-*        — ось РАЗМЕРА при постоянной доле посещённого (12 % страниц, страница 500
#                            фигур, 25/50/100 страниц): единственная ось, на которой порог по размеру
#                            отделим от порога по доле;
#   route-repeat           — ось окна кеша там, где окно связывает; F-плечи дают P−F внутри адаптера;
#   rtt150                 — §1.2, RTT 150;
#   doc100x500, doc50x1000 — §1.2 «рост числа страниц до 100 и размера страницы до 1000 фигур»;
#   cache3                 — окно 3 на приёмочном маршруте;
#   doc5x100               — предельный случай «маршрут читает документ целиком» (доля 100 %);
#   command-shape          — доля изменённых объектов и их размещение (4 варианта, документ doc-cmd-50x500);
#   route-full             — последовательный просмотр ВСЕГО документа (49 переходов).
# Повторения (§1.8 «не менее 30» выполняется на приёмочной серии; дополнительные серии — §7.4
# «≥10, указать»): main 30; size-fraction-* 15; command-shape 6 (24 ячейки); остальные 10.
# Порядок — по убыванию важности: прерванная программа даёт полные ранние серии.
SERIES_ORDER=(main size-fraction-25x500 size-fraction-50x500 size-fraction-100x500 route-repeat command-shape route-full rtt150 doc50x1000 doc5x100 cache3)
# СНЯТЫ С ПРОГРАММЫ ОКОНЧАТЕЛЬНО (конфигурации оставлены в репозитории, запускаются только явным
# --only, в отчёт программы 2 не входят):
#   cache10    — окно 10 на приёмочном маршруте не связывает (7 разных страниц): ту же ось
#                закрывает ячейка cache=10 серии route-repeat, где окно связывает;
#   doc10x200  — середина СТАРОЙ (спутанной) оси размера: доля посещённого 70 %, заменена
#                серией size-fraction-50x500 (та же ось, доля закреплена);
#   doc100x500 — 100 страниц при доле 7 %: требование §1.2 «рост числа страниц до 100» закрывает
#                size-fraction-100x500 (те же 100 страниц при доле 12 %).
SERIES_OPTIONAL=(cache10 doc10x200 doc100x500)
ESTIMATE_ONLY=0; DRY_RUN=0; SKIP_FUNCTIONAL=0; ONLY=""; FROM=""; WITH_OPTIONAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --estimate) ESTIMATE_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-functional) SKIP_FUNCTIONAL=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --only=*) ONLY="${1#*=}"; shift ;;
    --from) FROM="$2"; shift 2 ;;
    --from=*) FROM="${1#*=}"; shift ;;
    --with-optional) WITH_OPTIONAL=1; shift ;;
    -h|--help) sed -n 2,41p "${BASH_SOURCE[0]}"; exit 0 ;;   # весь блок-шапка: использование, порядок, флаги, переменные
    *) log "unknown argument: $1"; exit 2 ;;
  esac
done

cd "$STAND_ROOT"
# Штамп прогона программы: им помечаются свидетельства предсерийных проверок и допуска, чтобы
# артефакты разных программ не затирали друг друга (дефект «свидетельство перезаписано»).
PROGRAMME_STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
PROGRESS="$STAND_ROOT/results/progress.json"
LOGFILE="$STAND_LOG_DIR/run-all-series.log"
SERIES_DIR="$STAND_ROOT/packages/bench/series"
STATS_URL="${STAND_SHAPER_STATS_URL:-http://127.0.0.1:${STAND_SHAPER_STATS_PORT:-8081}}"
API_URL="http://127.0.0.1:$STAND_PORT"

# ---- выбранные серии ------------------------------------------------------------------------------
SELECTED=()
# необязательная группа участвует в выборе, если запрошена флагом или названа в --only/--from
CANDIDATES=("${SERIES_ORDER[@]}")
if [[ "$WITH_OPTIONAL" == 1 ]]; then
  CANDIDATES+=("${SERIES_OPTIONAL[@]}")
else
  for o in "${SERIES_OPTIONAL[@]}"; do
    if [[ ",$ONLY," == *",$o,"* || "$FROM" == "$o" ]]; then CANDIDATES+=("$o"); fi
  done
fi
skipping=0; [[ -n "$FROM" ]] && skipping=1
for s in "${CANDIDATES[@]}"; do
  if [[ "$skipping" == 1 ]]; then [[ "$s" == "$FROM" ]] && skipping=0 || continue; fi
  if [[ -n "$ONLY" ]]; then [[ ",$ONLY," == *",$s,"* ]] || continue; fi
  SELECTED+=("$s")
done
[[ ${#SELECTED[@]} -gt 0 ]] || { log "no series selected"; exit 2; }

# ---- оценка времени по дымовой серии ---------------------------------------------------------------
# Средняя длительность прогона конфигурации (wall_ms + эталон + cooldown) из results/smoke/runs.csv,
# если этот каталог есть; после его удаления работают встроенные коэффициенты `fallback`;
# для серий с иным документом/RTT — коэффициенты (F грузит больше страниц; RTT 150 удлиняет переходы и загрузку).
estimate() {
  node - "$STAND_ROOT" "${SELECTED[@]}" <<'EOF'
const fs = require('fs'); const path = require('path');
const [root, ...series] = process.argv.slice(2);
const smokeCsv = path.join(root, 'results/smoke/runs.csv');
const per = {}; // 'HF' → avg seconds per run incl. overhead
if (fs.existsSync(smokeCsv)) {
  const lines = fs.readFileSync(smokeCsv, 'utf8').trim().split('\n');
  const cols = lines[0].split(','); const ix = (n) => cols.indexOf(n);
  const acc = {};
  for (const l of lines.slice(1)) { const f = l.split(','); const k = f[ix('adapter')] + f[ix('mode')]; const w = Number(f[ix('wall_ms')]); if (!Number.isFinite(w)) continue; (acc[k] ??= []).push(w); }
  for (const [k, v] of Object.entries(acc)) per[k] = v.reduce((a, b) => a + b, 0) / v.length / 1000 + 1.7; // +эталон ≈0.7 с +cooldown 1 с
}
const fallback = { HF: 15, HP: 15.7, QF: 15, QP: 15.7, ZF: 22.9, ZP: 18 };
for (const k of Object.keys(fallback)) per[k] ??= fallback[k];
// коэффициенты относительно 50×500 при RTT 50: [F-конфигурации, P-конфигурации]
// коэффициенты необязательной группы — по длине маршрута: прогон ≈ (пауз + переходов), а маршрут
// route-full вчетверо длиннее приёмочного, route-repeat — вдвое.
// Коэффициенты относительно приёмочной серии. Для size-fraction-* измерены калибровочными
// прогонами 2026-09-13 (wall_ms + 1.7 с накладных): 25×500 H/F 8.6 с, Z/P 10.7; 50×500 14.6 / 17.8;
// 100×500 27.8 / 32.8 — маршрут длиннее пропорционально числу посещаемых страниц (5/11/23 перехода).
const factor = { main: [1, 1], cache3: [1, 1], cache10: [1, 0.97], doc5x100: [0.85, 0.9], doc10x200: [0.9, 0.92], doc100x500: [1.35, 1.02], doc50x1000: [1.3, 1.08], rtt150: [1.25, 1.15], 'route-full': [4.2, 4.6], 'route-repeat': [1.7, 1.8], 'command-shape': [1.05, 1.05], 'size-fraction-25x500': [0.68, 0.69], 'size-fraction-50x500': [1.09, 1.08], 'size-fraction-100x500': [1.97, 1.92] };
let total = 0; let totalFull = 0; const rows = [];
for (const name of series) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'packages/bench/series', name + '.json'), 'utf8'));
  // варианты команды (command-shape) умножают число конфигураций серии
  if (Array.isArray(cfg.variants) && cfg.variants.length) cfg.configs = cfg.configs.flatMap((c) => cfg.variants.map((v) => ({ ...c, variant: v.name })));
  const runsDir = path.join(root, 'results', name, 'runs');
  const done = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).length : 0;
  const [fF, fP] = factor[name] ?? [1, 1];
  let perRep = 0;
  for (const c of cfg.configs) perRep += per[c.adapter + c.mode] * (c.mode === 'F' ? fF : fP);
  const runs = cfg.configs.length * cfg.repetitions;
  const remaining = Math.max(0, runs - done);
  const sec = (perRep / cfg.configs.length) * remaining;
  const secFull = (perRep / cfg.configs.length) * runs;
  total += sec;
  totalFull += secFull;
  rows.push([name, [...new Set(cfg.configs.map((c) => c.adapter + c.mode + (c.mode === 'P' ? c.cache : '')))].join(' ') + (cfg.variants ? ` ×${cfg.variants.length}var` : ''), cfg.repetitions, runs, done, (secFull / 60).toFixed(1), (sec / 60).toFixed(1)]);
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('series', 22) + pad('configs', 34) + pad('reps', 6) + pad('runs', 6) + pad('done', 6) + pad('est. min (full)', 16) + 'est. min (remaining)');
for (const r of rows) console.log(pad(r[0], 22) + pad(r[1], 34) + pad(r[2], 6) + pad(r[3], 6) + pad(r[4], 6) + pad(r[5], 16) + r[6]);
console.log(`per-run seconds (smoke incl. overhead): ${Object.entries(per).map(([k, v]) => k + '=' + v.toFixed(1)).join(' ')}`);
// ПОЛНАЯ программа — то, что снимается заново одной версией оболочки; «остаток» имеет смысл
// только при возобновлении прерванной программы (уже выполненные run_id пропускаются)
console.log(`ПОЛНАЯ ПРОГРАММА ≈ ${(totalFull / 60).toFixed(0)} min (${(totalFull / 3600).toFixed(1)} h), прогонов ${rows.reduce((a, r) => a + Number(r[3]), 0)}; + функциональный допуск ≈ 5 min`);
console.log(`ОСТАТОК (с учётом уже выполненных) ≈ ${(total / 60).toFixed(0)} min (${(total / 3600).toFixed(1)} h)`);
EOF
}

log "series selected: ${SELECTED[*]}"
estimate
[[ "$ESTIMATE_ONLY" == 1 ]] && exit 0

# ---- прогресс -------------------------------------------------------------------------------------
write_progress() { # <stage> <series|-> <index> <total> <message>
  mkdir -p "$(dirname "$PROGRESS")"
  node -e '
    const [file, stage, series, index, total, message] = process.argv.slice(1);
    const fs = require("fs"); let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const body = { ...prev, updatedAt: new Date().toISOString(), orchestrator: { stage, series: series === "-" ? null : series, series_index: Number(index), series_total: Number(total), message } };
    if (stage !== "series") { body.series = series === "-" ? null : series; body.status = stage; body.run_done = null; body.run_total = null; body.eta_seconds = null; body.current_run = null; }
    fs.writeFileSync(file + ".tmp", JSON.stringify(body, null, 2) + "\n"); fs.renameSync(file + ".tmp", file);
  ' "$PROGRESS" "$@"
}

# ---- проверки стенда -----------------------------------------------------------------------------
preflight() {
  pg_isready -h "$PGHOST" -p "$PGPORT" -q || { log "PostgreSQL is not reachable"; exit 1; }
  local health
  health="$(curl -fsS "$API_URL/api/health" 2>/dev/null || true)"
  if [[ -z "$health" ]]; then
    log "API :$STAND_PORT is not running → starting with STAND_LOG_LEVEL=warn"
    STAND_LOG_LEVEL=warn "$STAND_ROOT/scripts/start-api.sh"
  else
    local level; level="$(node -e 'console.log(JSON.parse(process.argv[1]).logLevel ?? "unknown")' "$health")"
    if [[ "$level" != "warn" ]]; then
      log "API log level is '$level' (expected 'warn' for series, docs/DEVIATIONS.md 4.1) → restarting API"
      stop_pidfile "$STAND_LOG_DIR/api.pid" api
      STAND_LOG_LEVEL=warn "$STAND_ROOT/scripts/start-api.sh"
    fi
  fi
  curl -fsS "$API_URL/api/health" | grep -q '"logLevel":"warn"' || { log "API health does not report logLevel=warn"; exit 1; }
  if ! curl -fsS -o /dev/null "http://127.0.0.1:${STAND_ZERO_PORT:-4848}/" 2>/dev/null; then
    log "zero-cache is not running → starting"
    "$STAND_ROOT/scripts/start-zero.sh"
  fi
  if ! curl -fsS -o /dev/null "$STATS_URL/health" 2>/dev/null; then
    log "shaper is not running → starting"
    "$STAND_ROOT/scripts/start-shaper.sh"
  fi
  log "shaper config: $(curl -fsS "$STATS_URL/config")"
  local revs
  revs="$(psql -qtAX -c "select id||'='||revision from documents where revision <> 0" 2>/dev/null || true)"
  if [[ -n "$revs" ]]; then
    log "documents not at revision 0 (${revs//$'\n'/ }) → reset via test hook"
    for d in $revs; do "$STAND_ROOT/scripts/reset.sh" "${d%%=*}" >/dev/null; done
  fi
  [[ -f packages/client/dist/index.html ]] || { log "client dist missing (npm run build -w packages/client)"; exit 1; }
  # §1.7: при 80 % дискового бюджета серия останавливается и сохраняет диагностику
  local used
  used="$(df --output=pcent "$STAND_ROOT/results" | tail -1 | tr -dc '0-9')"
  log "disk: файловая система results занята ${used}% (порог §1.7 — 80%); реплика zero-cache: $(du -sh "$STAND_ROOT/results/zero-replica" 2>/dev/null | cut -f1 || echo '—')"
  if [[ -n "$used" && "$used" -ge "${STAND_DISK_LIMIT_PCT:-80}" ]]; then
    log "ДИСК: занято ${used}% ≥ ${STAND_DISK_LIMIT_PCT:-80}% — серии не запускаются (§1.7: переполнение не устраняется молчаливым увеличением ресурсов)"
    df -h "$STAND_ROOT/results" >&2
    du -sh "$STAND_ROOT/results"/* 2>/dev/null | sort -h | tail -10 >&2
    exit 1
  fi
  # сэмплеры: группа процессов, которая не сопоставлена ничему, дала бы в CSV нули вместо измерений
  local sfiles=()
  for s in "${SELECTED[@]}"; do sfiles+=("$SERIES_DIR/$s.json"); done
  if ! node packages/bench/src/sampling/preflight.mjs "${sfiles[@]}"; then
    log "preflight сэмплеров провален: объявленная группа процессов пуста — серия записала бы нули (SPEC §7.3)"
    exit 1
  fi
  # Идентичность оболочки: дописать новые прогоны к каталогу, снятому ДРУГОЙ версией оболочки,
  # нельзя — в одном runs.csv оказались бы строки разных версий сценария и разной схемы колонок
  # (в первой программе так и вышло: 100 против 115 колонок). Каталоги прежней программы
  # переносятся в results/archive/ ВРУЧНУЮ — скрипт ничего не удаляет.
  log "harness: сверка идентичности оболочки с уже записанными данными"
  if ! node packages/bench/src/series/harness-check.mjs --out "$STAND_ROOT/results" "${sfiles[@]}"; then
    if [[ "${STAND_ALLOW_MIXED_HARNESS:-0}" == 1 ]]; then
      log "ВНИМАНИЕ: STAND_ALLOW_MIXED_HARNESS=1 — в одном runs.csv окажутся прогоны разных версий оболочки"
    else
      log "ОСТАНОВКА: есть каталог серии, снятый другой версией измерительной оболочки."
      log "  Перенесите каталоги прежней программы: mkdir -p results/archive/programme-1 && mv results/<серия> results/archive/programme-1/"
      log "  (или задайте STAND_ALLOW_MIXED_HARNESS=1, если смешение прогонов сделано осознанно)"
      exit 1
    fi
  fi
  # §1.7: перед серией — проверка репликации/слотов и пробное восстановление резервной копии.
  # Вывод — СВИДЕТЕЛЬСТВО прогона программы, поэтому пишется в СВОЙ файл
  # results/logs/pre-series-checks-<штамп>.txt и НИКОГДА не затирает вывод прошлой программы
  # (прежняя версия делала `: > pre-series-checks.txt`, и свидетельство предыдущей программы
  # терялось). Рядом обновляется симлинк pre-series-checks.txt → последний файл: его ищет паспорт
  # (`preSeriesChecks()` в packages/bench/src/series/passport.mjs) через переменную
  # STAND_PRE_SERIES_CHECKS, а копия кладётся ещё и рядом с каждой серией. Файл прошлой программы
  # остаётся на месте и НЕ выдаётся за свидетельство этой.
  PRE_CHECKS="$STAND_LOG_DIR/pre-series-checks-$PROGRAMME_STAMP.txt"
  PRE_CHECKS_LATEST="$STAND_LOG_DIR/pre-series-checks.txt"
  if [[ "${STAND_SKIP_PRE_CHECKS:-0}" != 1 ]]; then
    : > "$PRE_CHECKS"
    { echo "=== pre-series checks: программа $PROGRAMME_STAMP, серии: ${SELECTED[*]} ==="; echo; } >> "$PRE_CHECKS"
    log "pre-series: replication-check.sh → $PRE_CHECKS"
    if ! "$STAND_ROOT/scripts/replication-check.sh" 2>&1 | tee -a "$PRE_CHECKS"; then
      log "replication-check провален (§1.7: слот/лаг/диск) — серии не запускаются; см. $PRE_CHECKS"; exit 1
    fi
    log "pre-series: backup-restore-check.sh"
    if ! "$STAND_ROOT/scripts/backup-restore-check.sh" 2>&1 | tee -a "$PRE_CHECKS"; then
      log "backup-restore-check провален (§1.7: наличие копии без пробного восстановления не считается мерой) — серии не запускаются; см. $PRE_CHECKS"; exit 1
    fi
    # ручные проверки §8.1–8.3 выполнены ИМЕННО в этом прогоне — на них и указывает паспорт
    export STAND_PRE_SERIES_CHECKS="$PRE_CHECKS"
  else
    # Свидетельство прошлой программы не трогаем и НЕ выдаём за своё: паспорт получит
    # manual.status = not-performed, если файла этого прогона нет.
    log "pre-series проверки пропущены (STAND_SKIP_PRE_CHECKS=1) — ограничение фиксируется в отчёте"
    log "  ВНИМАНИЕ: результат прошлых проверок ($PRE_CHECKS_LATEST) НЕ копируется к сериям этой программы"
    # пустое значение — явный сигнал паспорту: свидетельства ЭТОЙ программы нет, старое не подходит
    export STAND_PRE_SERIES_CHECKS=""
    PRE_CHECKS=""
  fi
  if [[ "$(node -p 'require("os").loadavg()[0].toFixed(2)')" != "" ]]; then log "load average: $(cat /proc/loadavg)"; fi
}

preflight
if [[ "$DRY_RUN" == 1 ]]; then
  for s in "${SELECTED[@]}"; do
    out="$(node packages/bench/src/series/run.mjs --config "$SERIES_DIR/$s.json" --dry-run 2>&1)"
    echo "${out%%$'\n'*}"
  done
  exit 0
fi

exec > >(tee -a "$LOGFILE") 2>&1
log "=== run-all-series start: ${SELECTED[*]} (log $LOGFILE, progress $PROGRESS)"

# ---- функциональный допуск -----------------------------------------------------------------------
# §1.7: конфигурация допускается к измерениям, только если ВСЕ предметные проверки пройдены, причём
# на ТОМ документе, который её измеряет (масштабозависимое поведение: полнота набора на 500 фигурах,
# окно LRU при 50 страницах, материализация 50 view у Z/F). Поэтому допуск идёт в несколько заходов:
#   A. малый документ, ПОЛНЫЙ набор проверок, ВСЕ конфигурации (H,Q,Z × F, P/1, P/3, P/10) — быстрая матрица;
#   B. приёмочный документ 50×500, проверки 1–6 + инварианты, 6 конфигураций серии main;
#   C. приёмочный документ, окна кеша 3 и 10 (серии cache3/cache10) — проверки 2, 4 и инвариант И2;
#   D. документы остальных серий (5×100, 100×500, 50×1000) — проверки 1, 3, 4 + инварианты.
# Затем admission-gate сверяет список измеряемых конфигураций с фактическими вердиктами.
FUNC_PORT="${STAND_FUNCTIONAL_PORT:-3005}"
ZERO_URL="http://127.0.0.1:${STAND_ZERO_PORT:-4848}"
ADMISSION_STAMP="admission-$PROGRAMME_STAMP"
SUMMARY_LIST="$STAND_LOG_DIR/functional-summaries.txt"
ACC_CHECKS="1-open,2-local-fill,3-source-fill,4-late-nav,5-stale-read,6-retry,I1-full-load,I2-window"
WIN_CHECKS="2-local-fill,4-late-nav,I2-window"
DOC_CHECKS="1-open,3-source-fill,4-late-nav,I1-full-load,I2-window"
EXTRA_DOCS="${STAND_FUNCTIONAL_EXTRA_DOCS:-1}"   # 0 — не проверять документы серий doc5x100/doc100x500/doc50x1000

# Все адаптеры идут через СОБСТВЕННЫЙ API :3005 (H/Q — чтение и команды; Z — чтение документа по HTTP и
# WebSocket прямо в zero-cache :4848), поэтому одна матрица «конфигурация × проверка» пишется в один
# summary.md на документ. Шейпер :8080 не используется: его счётчики принадлежат измерительной серии,
# а сетевое ограничение не меняет предметных исходов (каждый прогон серии дополнительно сверяется эталоном).
# Трансформация synced query у zero-cache идёт на общий API :3000 (ZERO_QUERY_URL) — туда же ставится
# задержка в проверке 5, поэтому --zero-query-api указывает на него.
# admit <метка> <adapters> [доп. аргументы run.mjs…]
admit() {
  local label="$1" adapters="$2"; shift 2
  log "functional admission [$label]: adapters=$adapters $*"
  write_progress functional - 0 "${#SELECTED[@]}" "functional admission: $label"
  set +e
  "$STAND_ROOT/scripts/run-functional.sh" --adapters "$adapters" --port "$FUNC_PORT" --zero-url "$ZERO_URL" \
    -- --zero-query-api "$API_URL" --label "$label" --stamp "$ADMISSION_STAMP-$label" "$@"
  local code=$?
  set -e
  case "$code" in
    0) log "  [$label] допуск получен всеми конфигурациями" ;;
    3) log "  [$label] ВНИМАНИЕ: есть пропущенные проверки / частичный набор — вердикты см. в results/functional/$ADMISSION_STAMP-$label/summary.md (строгие ворота ниже такую конфигурацию не пропустят)" ;;
    *) write_progress failed - 0 "${#SELECTED[@]}" "functional admission $label failed (code $code)"
       log "  [$label] функциональный допуск ПРОВАЛЕН (код $code) — серии не запускаются (§1.7)"
       exit 1 ;;
  esac
}

selected_has() { [[ " ${SELECTED[*]} " == *" $1 "* ]]; }

if [[ "$SKIP_FUNCTIONAL" == 0 ]]; then
  : >"$SUMMARY_LIST"
  export STAND_FUNCTIONAL_SUMMARY_OUT="$SUMMARY_LIST"
  # A. полная матрица на малом документе: все 12 конфигураций (H,Q,Z × F, P/1, P/3, P/10), ПОЛНЫЙ набор проверок
  admit small H,Q,Z --caches 1,3,10 --doc data/small-10x200.json --timeout 180000
  # B. приёмочный документ 50×500 (его измеряют main и rtt150): проверки 1–6 + инварианты, 6 конфигураций
  admit acceptance H,Q,Z --caches 1 --doc data/acceptance.json --only "$ACC_CHECKS" --timeout 600000
  # C. окна кеша серий cache3/cache10/route-repeat на приёмочном документе: проверки 2, 4 и инвариант И2
  if selected_has cache3 || selected_has cache10 || selected_has route-repeat; then
    admit acceptance-win H,Q,Z --modes P --caches 3,10 --doc data/acceptance.json --only "$WIN_CHECKS" --timeout 600000
  fi
  # D. документы остальных серий, включая ДВА НОВЫХ документа оси постоянной доли
  #    (size-fraction-25x500 → doc-frac-25x500, size-fraction-100x500 → doc-frac-100x500;
  #     size-fraction-50x500 идёт на приёмочном документе и покрыт шагом B)
  if [[ "$EXTRA_DOCS" == 1 ]]; then
    for pair in "doc5x100:data/small-5x100.json" "doc100x500:data/large-100x500.json" "doc50x1000:data/dense-50x1000.json" \
                "size-fraction-25x500:data/frac-25x500.json" "size-fraction-100x500:data/frac-100x500.json"; do
      sname="${pair%%:*}"; sdoc="${pair#*:}"
      selected_has "$sname" || continue
      admit "$sname" H,Q,Z --caches 1 --doc "$sdoc" --only "$DOC_CHECKS" --timeout 900000
    done
  else
    log "functional admission: документы серий doc5x100/doc100x500/doc50x1000 пропущены (STAND_FUNCTIONAL_EXTRA_DOCS=0) — ограничение фиксируется в отчёте"
  fi
  # E. документ необязательной серии command-shape (doc-cmd-50x500: те же 50×500, но с источниками
  #    заданного размещения) — проверки 1, 3, 4 + инварианты, 6 конфигураций серии.
  #    route-full и route-repeat идут на приёмочном документе и покрыты шагами B и C.
  if selected_has command-shape; then
    admit command-shape H,Q,Z --caches 1 --doc data/cmd-50x500.json --only "$DOC_CHECKS" --timeout 900000
  fi

  # ворота допуска: каждая измеряемая конфигурация обязана иметь допуск на своём документе и полный набор проверок
  SUMMARIES="$(paste -sd, "$SUMMARY_LIST")"
  SERIES_FILES=""
  for s in "${SELECTED[@]}"; do SERIES_FILES="${SERIES_FILES:+$SERIES_FILES,}$SERIES_DIR/$s.json"; done
  GATE_OUT="$STAND_ROOT/results/functional/$ADMISSION_STAMP-gate.md"
  # §1.7: к измерениям допускается конфигурация, прошедшая ВСЕ предметные проверки. «Допуск с
  # оговоркой» (есть пропущенная проверка) по умолчанию считается провалом — иначе усиление в
  # runner.mjs (B5) обнулялось бы на уровне оркестратора (дефект N8). Ослабление — только явным
  # STAND_ADMISSION_ALLOW_CAVEAT=1, и оно видно в логе.
  GATE_FLAGS=()
  if [[ "${STAND_ADMISSION_ALLOW_CAVEAT:-0}" == 1 ]]; then
    GATE_FLAGS+=(--allow-caveat)
    log "ВНИМАНИЕ: ворота допуска ослаблены (STAND_ADMISSION_ALLOW_CAVEAT=1) — «допуск с оговоркой» пропускает серию"
  fi
  node packages/bench/src/functional/admission-gate.mjs --series "$SERIES_FILES" --summaries "$SUMMARIES" --out "$GATE_OUT" "${GATE_FLAGS[@]}" \
    || { write_progress failed - 0 "${#SELECTED[@]}" "admission gate failed"; log "admission-gate: есть конфигурации без допуска — серии не запускаются (§1.7); отчёт $GATE_OUT"; exit 1; }
  log "функциональный допуск: все измеряемые конфигурации допущены; отчёт $GATE_OUT"
  # документ приёмки к сериям — на revision 0
  for d in doc-acc-50x500 doc-cmd-50x500 doc-small-10x200 doc-small-5x100 doc-large-100x500 doc-dense-50x1000 doc-frac-25x500 doc-frac-100x500; do
    "$STAND_ROOT/scripts/reset.sh" "$d" >/dev/null 2>&1 || true
  done
fi

# ---- серии ------------------------------------------------------------------------------------------
T0=$(date +%s)
i=0
for s in "${SELECTED[@]}"; do
  i=$((i + 1))
  cfg="$SERIES_DIR/$s.json"
  [[ -f "$cfg" ]] || { log "missing $cfg"; exit 1; }
  reps="$(node -p "require('$cfg').repetitions")"; seed="$(node -p "require('$cfg').seed")"
  [[ -n "$reps" && "$reps" != "undefined" && -n "$seed" && "$seed" != "undefined" ]] || { log "$s: repetitions/seed missing"; exit 1; }
  write_progress series "$s" "$i" "${#SELECTED[@]}" "series $s ($reps reps, seed $seed)"
  log "--- series $i/${#SELECTED[@]}: $s ($reps repetitions, seed $seed)"
  # §1.7: вывод предсерийных проверок кладётся РЯДОМ С СЕРИЕЙ — там его ищет паспорт
  # (`preSeriesChecks()` в packages/bench/src/series/passport.mjs). Без этой строки серия получала
  # `preSeriesChecks.manual = "not-performed"`, хотя проверки выполнялись и проходили: они лежали
  # только в results/logs/. Одиннадцать паспортов выполненной программы записаны ДО исправления —
  # docs/PASSPORT.md §8.4.
  [[ -n "$PRE_CHECKS" && -f "$PRE_CHECKS" ]] && { mkdir -p "$STAND_ROOT/results/$s"; cp -f "$PRE_CHECKS" "$STAND_ROOT/results/$s/pre-series-checks.txt"; }
  node packages/bench/src/series/run.mjs --config "$cfg" --progress "$PROGRESS" \
       --progress-extra "{\"orchestrator\":{\"stage\":\"series\",\"series\":\"$s\",\"series_index\":$i,\"series_total\":${#SELECTED[@]},\"order\":\"${SELECTED[*]}\"}}" \
    || { write_progress failed "$s" "$i" "${#SELECTED[@]}" "series $s exited with error — rerun to resume"; log "series $s failed/aborted — rerun this script to resume"; exit 1; }
  ( cd packages/analysis && python3 -m analysis.report --series "../../results/$s" --validate-only ) || log "WARNING: validator reported problems for $s"
  log "--- series $s done, elapsed $((($(date +%s) - T0) / 60)) min"
done
"$STAND_ROOT/scripts/reset.sh" doc-acc-50x500 >/dev/null
write_progress done - "${#SELECTED[@]}" "${#SELECTED[@]}" "all series done in $((($(date +%s) - T0) / 60)) min"
log "=== all series done in $((($(date +%s) - T0) / 60)) min; report: cd packages/analysis && python3 -m analysis.report --series ../../results/main --out ../../docs/results/RESULTS_main.md --figs ../../docs/results/figs/main --compare ../../results/cache3,../../results/doc5x100,../../results/doc50x1000,../../results/rtt150,../../results/route-full; перекрёстно (все 11 серий программы): python3 -m analysis.cross --series main=../../results/main,size-fraction-25x500=../../results/size-fraction-25x500,size-fraction-50x500=../../results/size-fraction-50x500,size-fraction-100x500=../../results/size-fraction-100x500,route-repeat=../../results/route-repeat,command-shape=../../results/command-shape,route-full=../../results/route-full,rtt150=../../results/rtt150,doc50x1000=../../results/doc50x1000,doc5x100=../../results/doc5x100,cache3=../../results/cache3 --out ../../docs/results/RESULTS_cross.md --figs ../../docs/results/figs/cross"
