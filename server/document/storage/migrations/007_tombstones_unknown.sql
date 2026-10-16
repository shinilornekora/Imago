-- 007_tombstones_unknown.sql — надгробия с номером удаления; «неизвестно» — NULL (круг 27, I1).
--
-- Снимок отдаёт надгробия в формате v2 `{v:2, parents:{id → родитель}, seq:{id → seq удаления}}`
-- или null — «неизвестно» (снимок записал экземпляр прежней версии): Document service тогда
-- восстанавливает их от ближайшего более раннего снимка с известными надгробиями
-- (`snapshotBefore`) и `remove` журнала между ними.
--
-- Раскладка по колонкам — ради смешанных версий (SPEC §9.11):
--   tombstones        — `parents` (v1: объект id → родитель), как и прежде. Его читают
--                       экземпляры кругов 25–26: положи сюда v2 целиком — они приняли бы
--                       ключи `v`/`parents`/`seq` за id узлов и потеряли все надгробия.
--   tombstones_meta   — остальное из v2 (`{v:2, seq:{…}}`); NULL — номеров нет (записали v1).
--   tombstones_chain  — chain снимка, для которого надгробия записаны этим кругом или
--                       новее (NULL — неизвестно; совпадает с chain — известны). Экземпляр
--                       прежней версии этих колонок не знает: его INSERT оставляет их NULL,
--                       его `ON CONFLICT DO UPDATE` (снимок с тем же seq, другой цепочкой)
--                       меняет chain и tombstones, а tombstones_chain остаётся прежней —
--                       несовпадение = «неизвестно». Ни триггера, ни сравнения документов.
-- Умолчание tombstones — NULL (прежде '{}'): экземпляр до круга 25, который колонку не
-- пишет, больше не записывает «надгробий нет» там, где они просто неизвестны. Экземпляры
-- кругов 25–26 читают NULL как {} — для них ничего не меняется.
--
-- Всё — правка каталога без перезаписи и проверки таблицы (DROP NOT NULL, SET DEFAULT,
-- ADD COLUMN без умолчания): эксклюзивный замок на миг, раннер ждёт его не дольше
-- lock_timeout и повторяет.

ALTER TABLE snapshots ALTER COLUMN tombstones DROP NOT NULL;
ALTER TABLE snapshots ALTER COLUMN tombstones SET DEFAULT NULL;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tombstones_meta jsonb;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tombstones_chain text;
