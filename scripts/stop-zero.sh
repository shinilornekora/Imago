#!/usr/bin/env bash
# Остановка zero-cache по pidfile results/logs/zero-cache.pid (SIGTERM runner'у → он гасит воркеры),
# плюс добивание осиротевших воркеров по пути модуля (не по слову "zero-cache" — оно есть в командных строках скриптов).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
stop_pidfile "$STAND_LOG_DIR/zero-cache.pid" "zero-cache"
rm -f "$STAND_LOG_DIR/zero.pid"
sleep 0.5
pkill -f "$STAND_ROOT/node_modules/@rocicorp/zero/out/zero/src/cli.js" 2>/dev/null || true
pkill -f "$STAND_ROOT/node_modules/@rocicorp/zero/out/zero-cache/src/server" 2>/dev/null || true
log "zero-cache stopped"
