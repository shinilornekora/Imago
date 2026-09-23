#!/usr/bin/env bash
# Запуск API в фоне: pidfile results/logs/api.pid, лог results/logs/api.log.
# Переменные: STAND_PORT (3000), STAND_TEST_HOOKS (1), STAND_JWT_SECRET, STAND_DB_URL, STAND_CLIENT_DIST, STAND_LOG_LEVEL.
# --build: пересобрать пакет сервера перед запуском (иначе используется dist, если есть, или tsx).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PIDFILE="$STAND_LOG_DIR/api.pid"
LOGFILE="${STAND_API_LOG:-$STAND_LOG_DIR/api.log}"

cd "$STAND_ROOT/packages/server"
if [[ "${1:-}" == "--build" ]]; then
  log "building server"
  npm run build --silent
fi

if pid_alive "$PIDFILE"; then
  log "api already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

if [[ -f dist/index.js ]]; then
  CMD=(node dist/index.js)
else
  CMD=(npx tsx src/index.ts)
fi
log "starting api on :$STAND_PORT (test hooks=$STAND_TEST_HOOKS) → $LOGFILE"
nohup "${CMD[@]}" >>"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
if wait_http "http://127.0.0.1:$STAND_PORT/api/health" 30; then
  log "api ready: $(curl -s "http://127.0.0.1:$STAND_PORT/api/health")"
else
  log "api failed to start; tail of log:"
  tail -20 "$LOGFILE" >&2
  exit 1
fi
