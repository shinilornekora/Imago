#!/usr/bin/env bash
# Сброс документа к снимку генератора: scripts/reset.sh [docId] (по умолчанию doc-acc-50x500).
# Использует тестовый хук API, если API запущен; иначе — напрямую через генератор.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DOC="${1:-doc-acc-50x500}"
if curl -fsS -o /dev/null "http://127.0.0.1:$STAND_PORT/api/health" 2>/dev/null; then
  curl -fsS -X POST "http://127.0.0.1:$STAND_PORT/api/test/reset" -H 'content-type: application/json' \
       -H "x-stand-test-secret: ${STAND_TEST_HOOKS_SECRET:-}" -d "{\"docId\":\"$DOC\"}"
  echo
else
  cd "$STAND_ROOT/packages/generator"
  npx tsx src/cli.ts reset "$DOC"
fi
