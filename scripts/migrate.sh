#!/usr/bin/env bash
# Идемпотентная миграция схемы + тестовые пользователи.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$STAND_ROOT/packages/server"
if [[ -f dist/db/migrate.js ]]; then
  node dist/db/migrate.js
else
  npx tsx src/db/migrate.ts
fi
