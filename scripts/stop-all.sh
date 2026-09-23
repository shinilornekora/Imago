#!/usr/bin/env bash
# Остановка всех фоновых процессов стенда по pidfile (api, zero-cache, shaper). PostgreSQL не трогаем.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
for name in api zero shaper caddy; do
  stop_pidfile "$STAND_LOG_DIR/$name.pid" "$name"
done
log "all stopped"
