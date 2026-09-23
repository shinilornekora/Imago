#!/usr/bin/env bash
# Предсерийная проверка восстановления резервной копии (глава 1, §1.7; docs/PASSPORT.md §8.3).
#
# §1.7: «Перед миграцией проверяется восстановление резервной копии. Восстановленный документ
# сравнивается по идентификаторам, числу фигур и переопределениям. Наличие файла резервной копии
# без пробного восстановления не считается достаточной мерой».
#
# Что делает: pg_dump рабочей базы → восстановление В ОТДЕЛЬНУЮ проверочную базу → сверка каждого
# документа по ревизии, числу страниц, числу фигур, числу переопределений и КОНТРОЛЬНЫМ СУММАМ
# состава (md5 по страницам, по фигурам, по переопределениям) → отчёт. Рабочая база не трогается:
# восстановление идёт в `editor_restore_check` (имя задаётся STAND_RESTORE_DB), которая в конце
# удаляется (--keep-db оставляет её для разбора).
#
#   scripts/backup-restore-check.sh                 # все документы, дамп в results/backup/
#   scripts/backup-restore-check.sh --doc doc-acc-50x500
#   scripts/backup-restore-check.sh --keep-dump --keep-db
#
# Код возврата: 0 — восстановление проверено и совпало; 1 — расхождение или сбой восстановления;
# 2 — ошибка вызова/нет инструментов. Вывод (пригодный для вставки в PASSPORT §8 и в
# results/<series>/pre-series-checks.txt) идёт в stdout, ход работы — в stderr.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ONLY_DOC=""
KEEP_DUMP=0
KEEP_DB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --doc) ONLY_DOC="${2:?--doc requires a document id}"; shift 2 ;;
    --keep-dump) KEEP_DUMP=1; shift ;;
    --keep-db) KEEP_DB=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

RESTORE_DB="${STAND_RESTORE_DB:-editor_restore_check}"
BACKUP_DIR="${STAND_BACKUP_DIR:-$STAND_ROOT/results/backup}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/editor-$STAMP.dump"
mkdir -p "$BACKUP_DIR"

for bin in pg_dump pg_restore psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FATAL: $bin не найден" >&2; exit 2; }
done
[[ "$RESTORE_DB" != "$PGDATABASE" ]] || { echo "FATAL: проверочная база совпадает с рабочей ($PGDATABASE)" >&2; exit 2; }

cleanup() {
  if [[ "$KEEP_DB" -eq 0 ]]; then
    psql -qX -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_DUMP" -eq 0 ]]; then rm -f "$DUMP"; fi
}
trap cleanup EXIT

echo "=== backup-restore-check ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
echo "источник: $PGDATABASE @ $PGHOST:$PGPORT | проверочная база: $RESTORE_DB"

# 1. Копия рабочей базы -------------------------------------------------------------------------
log "pg_dump $PGDATABASE → $DUMP"
t0=$(date +%s%3N)
pg_dump -Fc -d "$PGDATABASE" -f "$DUMP" || { echo "ВЕРДИКТ: ПРОВАЛ — pg_dump не выполнился"; exit 1; }
t1=$(date +%s%3N)
DUMP_BYTES=$(stat -c %s "$DUMP")
printf 'дамп: %s байт (%.1f МиБ) за %s мс, pg_dump %s\n' \
  "$DUMP_BYTES" "$(awk "BEGIN{print $DUMP_BYTES/1048576}")" "$((t1 - t0))" "$(pg_dump --version | awk '{print $3}')"

# 2. Восстановление в отдельную базу -------------------------------------------------------------
log "restore → $RESTORE_DB"
psql -qX -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" >/dev/null
psql -qX -d postgres -c "CREATE DATABASE \"$RESTORE_DB\";" >/dev/null
t2=$(date +%s%3N)
if ! pg_restore --no-owner --exit-on-error -d "$RESTORE_DB" "$DUMP" >/dev/null 2>"$STAND_LOG_DIR/restore-check.log"; then
  echo "ВЕРДИКТ: ПРОВАЛ — pg_restore завершился с ошибкой (см. $STAND_LOG_DIR/restore-check.log)"
  tail -20 "$STAND_LOG_DIR/restore-check.log"
  exit 1
fi
t3=$(date +%s%3N)
echo "восстановление: $((t3 - t2)) мс"

# 3. Сверка документов ---------------------------------------------------------------------------
# Сравниваются не только счётчики, но и контрольные суммы состава: счётчики совпали бы и при
# перепутанных заливках, а md5 по (id, fill, fill_overridden) — нет.
FILTER=""
[[ -n "$ONLY_DOC" ]] && FILTER="WHERE d.id = '$ONLY_DOC'"
read -r -d '' SQL <<SQL || true
SELECT d.id
     || '|' || d.revision
     || '|' || (SELECT count(*) FROM pages  p WHERE p.document_id = d.id)
     || '|' || (SELECT count(*) FROM shapes s WHERE s.document_id = d.id)
     || '|' || (SELECT count(*) FROM shapes s WHERE s.document_id = d.id AND s.fill_overridden)
     || '|' || (SELECT count(*) FROM shapes s WHERE s.document_id = d.id AND s.is_source)
     || '|' || coalesce((SELECT md5(string_agg(p.id || ':' || p."index" || ':' || p.name, ',' ORDER BY p.id))
                           FROM pages p WHERE p.document_id = d.id), '-')
     || '|' || coalesce((SELECT md5(string_agg(s.id || ':' || s.page_id || ':' || s.fill || ':' || s.fill_overridden
                                               || ':' || coalesce(s.source_id, '-') || ':' || s.is_source,
                                               ',' ORDER BY s.id))
                           FROM shapes s WHERE s.document_id = d.id), '-')
     || '|' || d.owner_id
  FROM documents d $FILTER
 ORDER BY d.id;
SQL

SRC_ROWS="$(psql -qtAX -d "$PGDATABASE"  -c "$SQL")"
DST_ROWS="$(psql -qtAX -d "$RESTORE_DB" -c "$SQL")"

# операции и снимок генератора — тоже часть восстановленного состояния
COUNT_SQL="SELECT (SELECT count(*) FROM documents) || '|' || (SELECT count(*) FROM pages) || '|' ||
                  (SELECT count(*) FROM shapes) || '|' || (SELECT count(*) FROM shapes_baseline) || '|' ||
                  (SELECT count(*) FROM users);"
SRC_TOTALS="$(psql -qtAX -d "$PGDATABASE"  -c "$COUNT_SQL")"
DST_TOTALS="$(psql -qtAX -d "$RESTORE_DB" -c "$COUNT_SQL")"

echo
printf '%-22s %9s %7s %8s %9s %8s %-34s %-34s\n' документ ревизия страниц фигур переопр источн 'md5(страницы)' 'md5(фигуры)'
fail=0
docs=0
while IFS= read -r src; do
  [[ -n "$src" ]] || continue
  docs=$((docs + 1))
  id="${src%%|*}"
  dst="$(printf '%s\n' "$DST_ROWS" | awk -F'|' -v id="$id" '$1 == id')"
  IFS='|' read -r _ rev pg sh ov so mp ms own <<<"$src"
  printf '%-22s %9s %7s %8s %9s %8s %-34s %-34s\n' "$id" "$rev" "$pg" "$sh" "$ov" "$so" "${mp:0:32}" "${ms:0:32}"
  if [[ -z "$dst" ]]; then
    echo "  ❌ документа нет в восстановленной базе"
    fail=1
  elif [[ "$dst" != "$src" ]]; then
    echo "  ❌ расхождение:"
    echo "     источник:      $src"
    echo "     восстановлено: $dst"
    fail=1
  fi
done <<<"$SRC_ROWS"

extra="$(comm -13 <(printf '%s\n' "$SRC_ROWS" | cut -d'|' -f1 | sort) <(printf '%s\n' "$DST_ROWS" | cut -d'|' -f1 | sort))"
if [[ -n "$extra" ]]; then
  echo "  ❌ лишние документы в восстановленной базе: $(echo "$extra" | tr '\n' ' ')"
  fail=1
fi

echo
echo "итоги таблиц (documents|pages|shapes|shapes_baseline|users):"
echo "  источник:      $SRC_TOTALS"
echo "  восстановлено: $DST_TOTALS"
[[ "$SRC_TOTALS" == "$DST_TOTALS" ]] || { echo "  ❌ итоги не совпали"; fail=1; }

echo
if [[ "$fail" -eq 0 ]]; then
  echo "ВЕРДИКТ: ПРОЙДЕНА — $docs документ(ов) восстановлены и совпали по ревизии, страницам, фигурам,"
  echo "         переопределениям, источникам и контрольным суммам состава; итоги таблиц совпали."
  exit 0
fi
echo "ВЕРДИКТ: ПРОВАЛ — восстановленная копия отличается от рабочей базы; серия не запускается (§1.7)."
exit 1
