#!/usr/bin/env bash
# Запуск PostgreSQL 16 (кластер 16/main), wal_level=logical, БД editor.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if pg_lsclusters 2>/dev/null | grep -qE '^16\s+main\s+[0-9]+\s+online'; then
  log "postgres 16/main already online"
else
  log "starting postgres 16/main"
  (pg_ctlcluster 16 main start || sudo pg_ctlcluster 16 main start)
  for _ in $(seq 1 50); do
    pg_isready -h "$PGHOST" -p "$PGPORT" -q && break
    sleep 0.2
  done
fi
pg_isready -h "$PGHOST" -p "$PGPORT"

# wal_level=logical (нужен zero-cache); при изменении требуется перезапуск.
wal="$(psql -d postgres -Atc 'show wal_level')"
if [[ "$wal" != "logical" ]]; then
  log "wal_level=$wal → setting logical and restarting"
  psql -d postgres -c "ALTER SYSTEM SET wal_level = 'logical'"
  (pg_ctlcluster 16 main restart || sudo pg_ctlcluster 16 main restart)
  for _ in $(seq 1 50); do
    pg_isready -h "$PGHOST" -p "$PGPORT" -q && break
    sleep 0.2
  done
fi

if [[ "$(psql -d postgres -Atc "select 1 from pg_database where datname='$PGDATABASE'")" != "1" ]]; then
  log "creating database $PGDATABASE"
  psql -d postgres -c "CREATE DATABASE \"$PGDATABASE\""
fi
log "postgres ready: $(psql -d "$PGDATABASE" -Atc 'select version()') wal_level=$(psql -d postgres -Atc 'show wal_level')"
