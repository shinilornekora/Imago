#!/usr/bin/env bash
# Сброс состояния репликации zero-cache в upstream (после пересоздания БД, перезаливки документов
# генератором, смены публикации или app id): останавливает zero-cache, удаляет его схемы
# (<app>, <app>_0, "<app>_0/cvr", "<app>_0/cdc"), слот репликации <app>_0_a, внутренние публикации
# _<app>_* и файл реплики. Публикация стенда (stand_zero) пересоздаётся start-zero.sh.
#   scripts/zero-reset-replication.sh            # app id из STAND_ZERO_APP_ID (stand)
#   STAND_ZERO_APP_ID=zero scripts/zero-reset-replication.sh   # например, для остатков спайка
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
APP="${STAND_ZERO_APP_ID:-stand}"
PUB="${STAND_ZERO_PUBLICATION:-stand_zero}"
REPLICA_DIR="${STAND_ZERO_REPLICA_DIR:-$STAND_ROOT/results/zero-replica}"

"$STAND_ROOT/scripts/stop-zero.sh"

log "dropping zero replication state for app '$APP' in $PGDATABASE"
psql -qX -v ON_ERROR_STOP=0 <<SQL
SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
  WHERE slot_name LIKE '${APP}_0%' AND database = current_database() AND NOT active;
DROP SCHEMA IF EXISTS "${APP}_0/cvr" CASCADE;
DROP SCHEMA IF EXISTS "${APP}_0/cdc" CASCADE;
DROP SCHEMA IF EXISTS "${APP}_0" CASCADE;
DROP SCHEMA IF EXISTS "${APP}" CASCADE;      -- <app>.permissions, <app>.schemaVersions
DO \$\$
DECLARE p record;
BEGIN
  FOR p IN SELECT pubname FROM pg_publication WHERE pubname LIKE '\_${APP}\_%' LOOP
    EXECUTE format('DROP PUBLICATION %I', p.pubname);
  END LOOP;
END \$\$;
DROP PUBLICATION IF EXISTS ${PUB};
SQL
# Event-триггеры Zero на DDL (если остались)
psql -qtAX -c "SELECT evtname FROM pg_event_trigger WHERE evtname LIKE 'zero_%' OR evtname LIKE '%${APP}%'" | while read -r t; do
  [[ -n "$t" ]] && psql -qX -c "DROP EVENT TRIGGER IF EXISTS \"$t\""
done
rm -f "$REPLICA_DIR"/zero.db "$REPLICA_DIR"/zero.db-* 2>/dev/null || true
log "replication state reset (slots: $(psql -qtAX -c "SELECT count(*) FROM pg_replication_slots WHERE database = current_database()"), replica dir: $REPLICA_DIR)"
