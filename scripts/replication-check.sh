#!/usr/bin/env bash
# Предсерийная проверка состояния репликации и задержки доставки (глава 1, §1.7;
# docs/PASSPORT.md §8.1–8.2).
#
# §1.7: «остановка потребителя изменений способна увеличить сохраняемый журнал базы… За диском,
# состоянием репликации и задержкой доставки ведётся наблюдение. При занятии 80 % дискового
# бюджета серия останавливается и сохраняет диагностику, переполнение не устраняется молчаливым
# увеличением ресурсов».
#
# Проверяется:
#   1) слот репликации zero-cache (<app>_0_a) в рабочей базе существует и АКТИВЕН;
#   2) задержка доставки (sent/write/flush/replay lag по pg_stat_replication) ≤ порога;
#   3) удержанный слотом WAL ≤ порога — по КАЖДОМУ слоту кластера, включая чужие и брошенные:
#      неактивный слот пиннит restart_lsn и растит pg_wal всего кластера, а не своей базы;
#   4) фактический размер каталога pg_wal ≤ порога;
#   5) диск под реплику/кластер/журналы ≤ 80 % бюджета (§1.7, порог 32 ГиБ из 40);
#   6) zero-cache отвечает по HTTP (запущен ≠ готов обслуживать чтение).
#
#   scripts/replication-check.sh                 # перед серией
#   scripts/replication-check.sh --label after   # тот же снимок после серии (для сверки в отчёте)
#   STAND_REPL_LAG_MB=64 STAND_RETAINED_WAL_GIB=4 STAND_DISK_BUDGET_GIB=32 scripts/replication-check.sh
#
# Код возврата: 0 — все пороги соблюдены; 1 — порог нарушен (серия не запускается); 2 — ошибка вызова.
# Вывод пригоден для вставки в docs/PASSPORT.md §8 и в results/<series>/pre-series-checks.txt.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LABEL="before"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="${2:?--label requires a value}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

APP="${STAND_ZERO_APP_ID:-stand}"
SLOT="${APP}_0_a"
LAG_MB="${STAND_REPL_LAG_MB:-64}"
WAL_GIB="${STAND_RETAINED_WAL_GIB:-4}"
DISK_GIB="${STAND_DISK_BUDGET_GIB:-32}"
ZERO_URL="${STAND_ZERO_URL:-http://127.0.0.1:4848/}"
REPLICA_DIR="${STAND_ZERO_REPLICA_DIR:-$STAND_ROOT/results/zero-replica}"
PGDATA_DIR="${STAND_PGDATA_DIR:-/var/lib/postgresql/16/main}"

fail=0
note() { printf '  %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; fail=1; }
ok() { printf '  ✅ %s\n' "$*"; }

echo "=== replication-check [$LABEL] ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
echo "база $PGDATABASE @ $PGHOST:$PGPORT | app '$APP' → слот '$SLOT'"
echo "пороги: задержка доставки ≤ ${LAG_MB} МиБ, удержанный WAL ≤ ${WAL_GIB} ГиБ на слот, диск ≤ ${DISK_GIB} ГиБ"
echo

# --- 1. Слоты репликации (весь кластер) ---------------------------------------------------------
echo "[1] Слоты репликации кластера"
SLOTS="$(psql -qtAX -d "$PGDATABASE" -F'|' -c "
  SELECT slot_name, coalesce(database, '-'), slot_type, active::text,
         coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::bigint,
         coalesce(restart_lsn::text, '-')
    FROM pg_replication_slots ORDER BY slot_name;" 2>/dev/null)" || {
  bad "не удалось прочитать pg_replication_slots (PostgreSQL недоступен?)"
  echo; echo "ВЕРДИКТ [$LABEL]: ПРОВАЛ"; exit 1
}
if [[ -z "$SLOTS" ]]; then
  bad "слотов репликации нет вовсе — zero-cache не реплицирует (слот '$SLOT' обязан существовать)"
else
  # Заголовки — латиницей: bash printf считает БАЙТЫ, и кириллица ломает выравнивание колонок.
  printf '  %-18s %-12s %-8s %-8s %11s\n' slot database type active 'WAL, GiB'
  found_slot=0
  while IFS='|' read -r name db typ act bytes lsn; do
    [[ -n "$name" ]] || continue
    gib="$(awk "BEGIN{printf \"%.2f\", $bytes/1073741824}")"
    printf '  %-18s %-12s %-8s %-8s %11s\n' "$name" "$db" "$typ" "$act" "$gib"
    [[ "$name" == "$SLOT" && "$db" == "$PGDATABASE" ]] && found_slot=1
    if [[ "$act" != "t" && "$act" != "true" ]]; then
      bad "слот '$name' (база $db) НЕАКТИВЕН и удерживает $gib ГиБ WAL всего кластера — потребитель изменений остановлен (§1.7)"
      note "   удалить, если слот брошен: psql -d $db -c \"SELECT pg_drop_replication_slot('$name');\""
    fi
    if awk "BEGIN{exit !($bytes > $WAL_GIB * 1073741824)}"; then
      bad "слот '$name' удерживает $gib ГиБ WAL > порога ${WAL_GIB} ГиБ"
    fi
  done <<<"$SLOTS"
  if [[ "$found_slot" -eq 1 ]]; then
    ok "слот стенда '$SLOT' в базе $PGDATABASE присутствует"
  else
    bad "слота стенда '$SLOT' в базе $PGDATABASE нет — прогоны Z пойдут без репликации; см. scripts/start-zero.sh"
  fi
fi

# --- 2. Задержка доставки -----------------------------------------------------------------------
echo
echo "[2] Задержка доставки (pg_stat_replication)"
REPL="$(psql -qtAX -d "$PGDATABASE" -F'|' -c "
  SELECT coalesce(application_name, '-'), coalesce(state, '-'),
         coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn), 0)::bigint,
         coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn), 0)::bigint,
         coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::bigint
    FROM pg_stat_replication ORDER BY application_name;")"
if [[ -z "$REPL" ]]; then
  bad "нет ни одного подключения walsender — zero-cache не читает поток изменений"
else
  printf '  %-24s %-12s %12s %12s %12s\n' consumer state 'sent, MiB' 'flush, MiB' 'replay, MiB'
  while IFS='|' read -r app state sent flush replay; do
    [[ -n "$app" ]] || continue
    printf '  %-24s %-12s %12s %12s %12s\n' "$app" "$state" \
      "$(awk "BEGIN{printf \"%.2f\", $sent/1048576}")" \
      "$(awk "BEGIN{printf \"%.2f\", $flush/1048576}")" \
      "$(awk "BEGIN{printf \"%.2f\", $replay/1048576}")"
    if awk "BEGIN{exit !($replay > $LAG_MB * 1048576)}"; then
      bad "отставание доставки у '$app' > ${LAG_MB} МиБ — прогон Z показал бы это как медленную команду"
    fi
    [[ "$state" == "streaming" ]] || bad "состояние '$app' = '$state', ожидалось 'streaming'"
  done <<<"$REPL"
  awk "BEGIN{exit !(1)}" && ok "отставание в пределах порога ${LAG_MB} МиБ"
fi

# --- 3. pg_wal и дисковый бюджет ----------------------------------------------------------------
echo
echo "[3] Журнал WAL и дисковый бюджет (§1.7, 80 % от 40 ГиБ = ${DISK_GIB} ГиБ)"
WAL_BYTES="$(du -sb "$PGDATA_DIR/pg_wal" 2>/dev/null | awk '{print $1}')"
if [[ -n "$WAL_BYTES" ]]; then
  printf '  pg_wal: %.2f ГиБ (%s)\n' "$(awk "BEGIN{print $WAL_BYTES/1073741824}")" "$PGDATA_DIR/pg_wal"
  if awk "BEGIN{exit !($WAL_BYTES > $WAL_GIB * 1073741824)}"; then
    bad "каталог pg_wal превысил ${WAL_GIB} ГиБ — освобождать пересозданием реплики (scripts/zero-reset-replication.sh), а не увеличением диска"
  fi
else
  note "pg_wal: размер недоступен (нет прав на $PGDATA_DIR) — проверить вручную"
fi
USED=0
for d in "$REPLICA_DIR" "$PGDATA_DIR" "$STAND_LOG_DIR"; do
  b="$(du -sb "$d" 2>/dev/null | awk '{print $1}')"
  [[ -n "$b" ]] || { note "$d: недоступен для du"; continue; }
  USED=$((USED + b))
  printf '  %-46s %8.2f ГиБ\n' "$d" "$(awk "BEGIN{print $b/1073741824}")"
done
printf '  ИТОГО: %.2f ГиБ из бюджета %s ГиБ\n' "$(awk "BEGIN{print $USED/1073741824}")" "$DISK_GIB"
if awk "BEGIN{exit !($USED > $DISK_GIB * 1073741824)}"; then
  bad "занято ≥ ${DISK_GIB} ГиБ — серия не запускается, идущая останавливается (scripts/stop-all.sh), диагностика сохраняется"
else
  ok "дисковый бюджет соблюдён"
fi
df -h --output=source,size,used,avail,pcent "$PGDATA_DIR" 2>/dev/null | sed 's/^/  /'

# --- 4. zero-cache обслуживает чтение -----------------------------------------------------------
echo
echo "[4] zero-cache"
CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$ZERO_URL" 2>/dev/null || echo 000)"
if [[ "$CODE" == "000" ]]; then
  bad "zero-cache не отвечает на $ZERO_URL — запущенный процесс ещё не означает готовую реплику (§1.9)"
else
  ok "zero-cache отвечает на $ZERO_URL: HTTP $CODE"
fi
if [[ -f "$REPLICA_DIR/zero.db" ]]; then
  printf '  реплика: %s, %.1f МиБ\n' "$REPLICA_DIR/zero.db" "$(awk "BEGIN{print $(stat -c %s "$REPLICA_DIR/zero.db")/1048576}")"
else
  note "реплика $REPLICA_DIR/zero.db отсутствует (будет создана при первом старте zero-cache)"
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "ВЕРДИКТ [$LABEL]: ПРОЙДЕНА — слот активен, отставание и диск в пределах порогов."
  exit 0
fi
echo "ВЕРДИКТ [$LABEL]: ПРОВАЛ — порог §1.7 нарушен; серия не запускается до устранения."
exit 1
