#!/usr/bin/env bash
# Функциональные проверки (SPEC §6, таблица 1 + безопасность) против реального стека.
#
#   scripts/run-functional.sh [--adapters H,Q[,Z]] [--port 3005] [--base http://host:port] [--zero-url URL]
#                             [--keep-api] [--no-api] [-- любые аргументы run.mjs, напр. --only 6-retry --configs H:P:1]
#
# По умолчанию поднимает СОБСТВЕННЫЙ экземпляр API на --port (3005; pidfile results/logs/api-functional.pid,
# лог results/logs/api-functional.log) с STAND_TEST_HOOKS=1 против той же БД, прогоняет проверки на документе
# --doc (по умолчанию data/small-10x200.json, alice) и doc-bob-5x50 (bob) и останавливает свой API.
# ДОКУМЕНТ — ПАРАМЕТР: допуск §1.7 обязан выполняться и на том документе, который измеряет серия, например
#   scripts/run-functional.sh --adapters H,Q --doc data/acceptance.json --only 1-open,2-local-fill,…
# --base задаёт готовый стенд (например, шейпер http://127.0.0.1:8080 для Z: /api → API, /zero → zero-cache);
# тогда API не запускается. --zero-url передаётся клиенту как ?zero=<url> (адрес zero-cache для адаптера Z),
# если zero-cache не доступен по <base>/zero.
# Прочие аргументы (--doc, --caches, --configs, --only, --label, --stamp, --zero-query-api, --out) уходят в run.mjs.
# Результат: results/functional/<timestamp>/summary.{json,md}.
# Код возврата: 0 — все конфигурации получили «допуск»; 1 — есть провал/непройденная конфигурация;
# 3 — провалов нет, но есть пропущенные проверки или частичный набор («допуск с оговоркой»); 2 — фатальная ошибка.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

PORT="${STAND_FUNCTIONAL_PORT:-3005}"
BASE=""
ADAPTERS="${STAND_FUNCTIONAL_ADAPTERS:-H,Q}"
ZERO_URL="${STAND_FUNCTIONAL_ZERO_URL:-}"
KEEP_API=0
NO_API=0
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --adapters) ADAPTERS="$2"; shift 2 ;;
    --adapters=*) ADAPTERS="${1#*=}"; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --base) BASE="$2"; NO_API=1; shift 2 ;;
    --base=*) BASE="${1#*=}"; NO_API=1; shift ;;
    --zero-url) ZERO_URL="$2"; shift 2 ;;
    --zero-url=*) ZERO_URL="${1#*=}"; shift ;;
    --keep-api) KEEP_API=1; shift ;;
    --no-api) NO_API=1; shift ;;
    --) shift; EXTRA+=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done
[[ -n "$BASE" ]] || BASE="http://127.0.0.1:$PORT"

# pidfile/лог зависят от порта: параллельные прогоны на разных портах не должны останавливать чужой API
PIDFILE="$STAND_LOG_DIR/api-functional-$PORT.pid"
LOGFILE="$STAND_LOG_DIR/api-functional-$PORT.log"
STARTED_API=0

stop_own_api() {
  if [[ "$STARTED_API" == 1 && "$KEEP_API" == 0 ]]; then
    stop_pidfile "$PIDFILE" "functional api"
  fi
}
trap stop_own_api EXIT

if [[ "$NO_API" == 0 ]]; then
  cd "$STAND_ROOT"
  if [[ ! -f packages/client/dist/index.html ]]; then
    log "client dist missing → npm run build -w packages/client"
    npm run build -w packages/client --silent
  fi
  if [[ ! -f packages/server/dist/index.js ]]; then
    log "server dist missing → npm run build -w packages/server"
    npm run build -w packages/server --silent
  fi
  if pid_alive "$PIDFILE" && curl -fsS -o /dev/null "$BASE/api/health" 2>/dev/null; then
    log "functional api already running on :$PORT (pid $(cat "$PIDFILE")) — reusing"
  elif curl -fsS -o /dev/null "$BASE/api/health" 2>/dev/null; then
    log "port :$PORT already serves an API (not ours) — reusing, will not stop it"
  else
    rm -f "$PIDFILE"
    log "starting functional api on :$PORT (test hooks on) → $LOGFILE"
    (
      cd "$STAND_ROOT/packages/server"
      STAND_PORT="$PORT" STAND_TEST_HOOKS=1 STAND_CLIENT_DIST="$STAND_ROOT/packages/client/dist" \
        nohup node dist/index.js >>"$LOGFILE" 2>&1 &
      echo $! >"$PIDFILE"
    )
    STARTED_API=1
    if ! wait_http "$BASE/api/health" 30; then
      log "functional api failed to start; tail of log:"; tail -20 "$LOGFILE" >&2; exit 1
    fi
    log "functional api ready: $(curl -s "$BASE/api/health")"
  fi
fi

cd "$STAND_ROOT"
ARGS=(--base "$BASE" --adapters "$ADAPTERS")
if [[ -n "$ZERO_URL" ]]; then export STAND_FUNCTIONAL_ZERO_URL="$ZERO_URL"; fi
log "running functional checks: adapters=$ADAPTERS base=$BASE ${EXTRA[*]:-}"
set +e
node packages/bench/src/functional/run.mjs "${ARGS[@]}" "${EXTRA[@]}"
CODE=$?
set -e
LATEST="$(ls -1dt "$STAND_ROOT"/results/functional/*/ 2>/dev/null | head -1)"
if [[ -n "$LATEST" ]]; then
  log "summary: ${LATEST}summary.md"
  # машиночитаемый путь для оркестратора (scripts/run-all-series.sh собирает по нему покрытие допуска)
  [[ -n "${STAND_FUNCTIONAL_SUMMARY_OUT:-}" ]] && printf '%s\n' "${LATEST}summary.json" >>"$STAND_FUNCTIONAL_SUMMARY_OUT"
fi
case "$CODE" in
  0) log "все конфигурации получили допуск" ;;
  3) log "ВНИМАНИЕ: провалов нет, но есть пропущенные проверки или частичный набор — см. вердикты в summary.md" ;;
  *) log "функциональный допуск НЕ пройден (код $CODE)" ;;
esac
exit "$CODE"
