#!/usr/bin/env bash
# Запуск zero-cache 1.9.0 (self-hosted, prod-режим, один процесс-runner + воркеры) в фоне.
#   pidfile: results/logs/zero-cache.pid (дубликат results/logs/zero.pid для stop-all.sh)
#   лог:     results/logs/zero-cache.log
#   реплика: results/zero-replica/zero.db (каталог замеряет bench: zero_replica_bytes)
#
# Переменные (все необязательные; значения по умолчанию из scripts/lib.sh):
#   STAND_DB_URL            upstream PostgreSQL (postgres://postgres:postgres@127.0.0.1:5432/editor)
#   STAND_API_PORT          порт API, куда zero-cache шлёт /api/zero/{mutate,query} (по умолчанию STAND_PORT → 3000)
#   STAND_ZERO_PORT         порт zero-cache (4848)
#   STAND_JWT_SECRET        тот же секрет HS256, что у API (ZERO_AUTH_SECRET)
#   STAND_ZERO_APP_ID       app id (stand) → схемы stand_0, "stand_0/cvr", "stand_0/cdc", слот stand_0_a
#   STAND_ZERO_PUBLICATION  публикация (stand_zero: documents, pages, shapes) — создаётся, если нет
#   STAND_ZERO_REPLICA_DIR  каталог реплики (results/zero-replica)
#   STAND_ZERO_LOG_LEVEL    уровень логов zero-cache (warn)
#   ZERO_ADMIN_PASSWORD     пароль административных интерфейсов /statz, /heapz, inspector (§1.6).
#                           Значения по умолчанию в репозитории НЕТ. Если переменная не задана,
#                           скрипт генерирует случайный пароль в results/logs/.zero-admin (режим 600)
#                           и переиспользует его при следующих запусках; файл в .gitignore.
#                           Прочитать: `cat results/logs/.zero-admin`.
#   STAND_ZERO_BIND_HOST    интерфейс, на который zero-ipv4-shim.mjs отображает '::' (127.0.0.1)
#
# Порядок: API должен быть запущен ДО zero-cache (иначе первые /query → TransformFailed, клиент переподключится).
# После пересоздания БД / перезаливки документов генератором: scripts/zero-reset-replication.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export STAND_API_PORT="${STAND_API_PORT:-$STAND_PORT}"
export STAND_ZERO_PORT="${STAND_ZERO_PORT:-4848}"
export STAND_ZERO_APP_ID="${STAND_ZERO_APP_ID:-stand}"
export STAND_ZERO_PUBLICATION="${STAND_ZERO_PUBLICATION:-stand_zero}"
export STAND_ZERO_REPLICA_DIR="${STAND_ZERO_REPLICA_DIR:-$STAND_ROOT/results/zero-replica}"
export STAND_ZERO_LOG_LEVEL="${STAND_ZERO_LOG_LEVEL:-warn}"

# §1.6: /statz, /heapz и inspector закрыты паролем, у которого НЕТ значения по умолчанию в коде.
# Совместимость: STAND_ZERO_ADMIN_PASSWORD, если задана, считается тем же секретом.
ADMIN_PW_FILE="$STAND_LOG_DIR/.zero-admin"
if [[ -z "${ZERO_ADMIN_PASSWORD:-}" && -n "${STAND_ZERO_ADMIN_PASSWORD:-}" ]]; then
  ZERO_ADMIN_PASSWORD="$STAND_ZERO_ADMIN_PASSWORD"
fi
if [[ -z "${ZERO_ADMIN_PASSWORD:-}" ]]; then
  if [[ ! -s "$ADMIN_PW_FILE" ]]; then
    (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$ADMIN_PW_FILE")
    log "ZERO_ADMIN_PASSWORD не задан — сгенерирован в $ADMIN_PW_FILE (режим 600)"
  fi
  chmod 600 "$ADMIN_PW_FILE" 2>/dev/null || true
  ZERO_ADMIN_PASSWORD="$(cat "$ADMIN_PW_FILE")"
fi
[[ -n "$ZERO_ADMIN_PASSWORD" ]] || { log "ZERO_ADMIN_PASSWORD пуст — административные интерфейсы zero-cache были бы открыты; запуск отменён"; exit 1; }
export ZERO_ADMIN_PASSWORD
export STAND_ZERO_ADMIN_PASSWORD="$ZERO_ADMIN_PASSWORD"

PIDFILE="$STAND_LOG_DIR/zero-cache.pid"
PIDFILE_ALIAS="$STAND_LOG_DIR/zero.pid"
LOGFILE="${STAND_ZERO_LOG:-$STAND_LOG_DIR/zero-cache.log}"

if pid_alive "$PIDFILE"; then
  log "zero-cache already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

mkdir -p "$STAND_ZERO_REPLICA_DIR"

# Публикация только для таблиц Zero-схемы (SPEC §2.4): без users / operations / shapes_baseline в реплике.
# Смена набора публикаций → zero-cache пересинхронизирует реплику (см. zero-reset-replication.sh).
if ! psql -qtAX -c "SELECT 1 FROM pg_publication WHERE pubname = '$STAND_ZERO_PUBLICATION'" | grep -q 1; then
  log "creating publication $STAND_ZERO_PUBLICATION (documents, pages, shapes)"
  psql -qX -c "CREATE PUBLICATION $STAND_ZERO_PUBLICATION FOR TABLE documents, pages, shapes"
fi

export ZERO_UPSTREAM_DB="$STAND_DB_URL"
export ZERO_REPLICA_FILE="$STAND_ZERO_REPLICA_DIR/zero.db"
export ZERO_PORT="$STAND_ZERO_PORT"
export ZERO_MUTATE_URL="http://127.0.0.1:$STAND_API_PORT/api/zero/mutate"
export ZERO_QUERY_URL="http://127.0.0.1:$STAND_API_PORT/api/zero/query"
export ZERO_AUTH_SECRET="$STAND_JWT_SECRET"      # deprecated в 1.9, но работает: zero-cache сам проверяет JWT и sub === userID
# ZERO_ADMIN_PASSWORD уже экспортирован выше (из среды или results/logs/.zero-admin)
export ZERO_APP_ID="$STAND_ZERO_APP_ID"
export ZERO_APP_PUBLICATIONS="$STAND_ZERO_PUBLICATION"
export ZERO_NUM_SYNC_WORKERS="${ZERO_NUM_SYNC_WORKERS:-1}"   # 2 vCPU
export ZERO_ENABLE_CRUD_MUTATIONS=false
export ZERO_LOG_LEVEL="$STAND_ZERO_LOG_LEVEL"
export ZERO_LOG_FORMAT=text
export ZERO_ENABLE_TELEMETRY=false
export DO_NOT_TRACK=1
# Песочница без IPv6: zero-cache слушает '::' → shim подменяет на 0.0.0.0 (во всех воркерах через NODE_OPTIONS).
export NODE_OPTIONS="${NODE_OPTIONS:-} --import=$STAND_ROOT/scripts/zero-ipv4-shim.mjs"

ZERO_BIN="$STAND_ROOT/node_modules/@rocicorp/zero/out/zero/src/cli.js"
[[ -f "$ZERO_BIN" ]] || { log "zero-cache binary not found: $ZERO_BIN (npm install?)"; exit 1; }

log "starting zero-cache :$STAND_ZERO_PORT (app=$STAND_ZERO_APP_ID, api :$STAND_API_PORT, replica $ZERO_REPLICA_FILE) → $LOGFILE"
{
  echo "=== $(date -Is) start zero-cache app=$STAND_ZERO_APP_ID port=$STAND_ZERO_PORT api=$STAND_API_PORT db=$STAND_DB_URL"
} >>"$LOGFILE"
# Запуск напрямую через node (без npx/sh-обёрток): pid = runner, SIGTERM ему останавливает все воркеры.
nohup node "$ZERO_BIN" >>"$LOGFILE" 2>&1 &
ZPID=$!
echo "$ZPID" >"$PIDFILE"
echo "$ZPID" >"$PIDFILE_ALIAS"

# Готовность: GET / → OK появляется после старта воркеров и начальной репликации (~10 с с готовой репликой,
# больше при первой синхронизации). /keepalive для опроса не использовать (включает heartbeat-мониторинг).
for i in $(seq 1 180); do
  if ! kill -0 "$ZPID" 2>/dev/null; then
    log "zero-cache exited early; tail of log:"; tail -30 "$LOGFILE" >&2; rm -f "$PIDFILE" "$PIDFILE_ALIAS"; exit 1
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:$STAND_ZERO_PORT/" 2>/dev/null; then
    log "zero-cache ready after ~${i}s (pid $ZPID)"
    exit 0
  fi
  sleep 1
done
log "zero-cache did not become ready in 180 s; tail of log:"; tail -30 "$LOGFILE" >&2
exit 1
