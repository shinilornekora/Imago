#!/usr/bin/env bash
# Генерация всех пресетов документов в data/ и загрузка в PostgreSQL (с shapes_baseline).
# Использование: scripts/gen-all.sh [--no-load]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$STAND_ROOT/packages/generator"
npx tsx src/cli.ts gen-all "$@"
