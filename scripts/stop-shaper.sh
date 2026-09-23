#!/usr/bin/env bash
# Остановка сетевого шейпера по pidfile results/logs/shaper.pid.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
stop_pidfile "$STAND_LOG_DIR/shaper.pid" "shaper"
log "shaper stopped"
