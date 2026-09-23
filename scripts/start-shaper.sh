#!/usr/bin/env bash
# Запуск сетевого шейпера (packages/netshaper) в фоне: pidfile results/logs/shaper.pid, лог results/logs/shaper.log.
# Через него идёт весь трафик клиента: http://127.0.0.1:$STAND_SHAPER_PORT → /api → API, /zero → zero-cache, / → статика API.
# Переменные: STAND_SHAPER_PORT (8080), STAND_SHAPER_STATS_PORT (8081), STAND_SHAPER_DELAY_MS (25),
#             STAND_SHAPER_BANDWIDTH_MBIT (20), STAND_SHAPER_BUCKET_MS (20 — ёмкость token bucket в мс передачи, ≈50 КБ),
#             STAND_PORT (3000, upstream API), STAND_ZERO_PORT (4848, upstream zero-cache),
#             STAND_SHAPER_HANDSHAKE_RTT (1 — эмулировать RTT установления соединения; 0 — выключить).
# Эмуляция TCP-рукопожатия ВКЛЮЧЕНА по умолчанию: без неё новое соединение бесплатно, и конфигурации,
# открывающие больше соединений (H/Q в F — ~8 на прогон против одного WebSocket у Z), получают
# незаслуженное преимущество (дефект A6/B22). Серии дополнительно выставляют флаг через POST /config.
# Дополнительные аргументы передаются netshaper как есть.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PIDFILE="$STAND_LOG_DIR/shaper.pid"
LOGFILE="${STAND_SHAPER_LOG:-$STAND_LOG_DIR/shaper.log}"

SHAPER_PORT="${STAND_SHAPER_PORT:-8080}"
STATS_PORT="${STAND_SHAPER_STATS_PORT:-8081}"
DELAY_MS="${STAND_SHAPER_DELAY_MS:-25}"
BANDWIDTH="${STAND_SHAPER_BANDWIDTH_MBIT:-20}"
BUCKET_MS="${STAND_SHAPER_BUCKET_MS:-20}"
HANDSHAKE="${STAND_SHAPER_HANDSHAKE_RTT:-1}"
HANDSHAKE_FLAG=(--handshake-rtt)
[[ "$HANDSHAKE" == 0 || "$HANDSHAKE" == "false" ]] && HANDSHAKE_FLAG=(--no-handshake-rtt)
ZERO_PORT="${STAND_ZERO_PORT:-4848}"
ROUTES="${STAND_SHAPER_ROUTES:-/api=127.0.0.1:$STAND_PORT,/zero=127.0.0.1:$ZERO_PORT,/=127.0.0.1:$STAND_PORT}"

if pid_alive "$PIDFILE"; then
  log "shaper already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

cd "$STAND_ROOT"
log "starting shaper on :$SHAPER_PORT (stats :$STATS_PORT, delay $DELAY_MS ms, $BANDWIDTH Mbit/s, bucket $BUCKET_MS ms, handshake-rtt ${HANDSHAKE_FLAG[0]#--}, routes $ROUTES) → $LOGFILE"
nohup node packages/netshaper/bin/netshaper.mjs \
  --listen "$SHAPER_PORT" --routes "$ROUTES" \
  --delay-ms "$DELAY_MS" --bandwidth-mbit "$BANDWIDTH" --bucket-ms "$BUCKET_MS" --stats-port "$STATS_PORT" \
  "${HANDSHAKE_FLAG[@]}" "$@" \
  >>"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
if wait_http "http://127.0.0.1:$STATS_PORT/health" 15; then
  log "shaper ready: $(curl -s "http://127.0.0.1:$STATS_PORT/config")"
else
  log "shaper failed to start; tail of log:"
  tail -20 "$LOGFILE" >&2
  exit 1
fi
