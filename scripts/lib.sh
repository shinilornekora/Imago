#!/usr/bin/env bash
# Общие переменные и функции для scripts/*.sh (подключается через `source`).
set -euo pipefail

export PATH=/opt/node24/bin:$PATH

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export STAND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export STAND_LOG_DIR="${STAND_LOG_DIR:-$STAND_ROOT/results/logs}"
mkdir -p "$STAND_LOG_DIR"

export STAND_DB_URL="${STAND_DB_URL:-postgres://postgres:postgres@127.0.0.1:5432/editor}"
export STAND_PORT="${STAND_PORT:-3000}"
# §1.6: API обслуживает только локальный контур. Открытая привязка вместе с STAND_TEST_HOOKS=1
# означала бы, что любой, кто видит :3000, сбрасывает чужой документ. Внутри сети Compose
# значение задаётся явно (infra/docker-compose.yml).
export STAND_HOST="${STAND_HOST:-127.0.0.1}"
export STAND_JWT_SECRET="${STAND_JWT_SECRET:-stand-sandbox-secret-0123456789}"
export STAND_TEST_HOOKS="${STAND_TEST_HOOKS:-1}"
export STAND_LOG_LEVEL="${STAND_LOG_LEVEL:-info}"

# Секрет заголовка `x-stand-test-secret` для /api/test/* (SPEC §2.3, §1.6). В репозитории значения
# нет: при первом старте генерируется в results/logs/.test-secret (0600) и переиспользуется всеми
# скриптами и оболочкой измерений. Пустая строка в среде = хуки без секрета (прежнее поведение).
stand_test_secret_file() { printf '%s\n' "$STAND_LOG_DIR/.test-secret"; }
if [[ -z "${STAND_TEST_HOOKS_SECRET:-}" ]]; then
  _secret_file="$(stand_test_secret_file)"
  if [[ ! -s "$_secret_file" ]]; then
    (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$_secret_file")
    chmod 600 "$_secret_file"
  fi
  chmod 600 "$_secret_file" 2>/dev/null || true
  export STAND_TEST_HOOKS_SECRET="$(cat "$_secret_file")"
  unset _secret_file
fi

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-editor}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# pid_alive <pidfile> → 0 если процесс из pidfile жив
pid_alive() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# stop_pidfile <pidfile> <name>
stop_pidfile() {
  local f="$1" name="$2"
  if pid_alive "$f"; then
    local pid
    pid="$(cat "$f")"
    log "stopping $name (pid $pid)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}

# wait_http <url> <timeout_sec>
wait_http() {
  local url="$1" timeout="${2:-30}"
  for _ in $(seq 1 $((timeout * 5))); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}
