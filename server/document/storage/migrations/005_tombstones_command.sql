-- 005_tombstones_command.sql — надгробия в снимке и команда агента у записи журнала (SPEC §9.11).
--
-- Обе колонки добавляются без перезаписи таблицы: tombstones — с постоянным умолчанием
-- (Postgres 11+ хранит его в каталоге, старые строки читаются как '{}'), command_id —
-- без умолчания. ALTER берёт эксклюзивный замок на миг; раннер ставит lock_timeout и
-- повторяет — в очереди за долгой транзакцией ALTER не стоит. Экземпляры прежних версий
-- этих колонок не пишут и не читают — им ничего не мешает.

-- надгробия снимка: id удалённого узла → его родитель (снимок seq N + хвост восстанавливают
-- те же надгробия, что у головы в памяти; без них слияние после выгрузки головы — другое)
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tombstones jsonb NOT NULL DEFAULT '{}'::jsonb;

-- команда агента (Orchestrator), породившая транзакцию: связь журнала с трассой
ALTER TABLE operations ADD COLUMN IF NOT EXISTS command_id text;

-- Те же триггеры, что в 002: базе, где 002 легла до круга 25, их ещё нет.
-- Смешанные версии (SPEC §9.11): экземпляр до круга 23 пишет журнал без chain и не
-- двигает head_chain. Триггер считает chain за него — от chain предыдущей записи
-- (sha256 — встроенная функция Postgres с 11-й версии) — и двигает head_chain проекта
-- в той же транзакции. Предыдущая без chain (старый журнал ещё не заполнен 003) —
-- запись остаётся без chain, её заполнит 003/006: заполненное — всегда префикс журнала.
-- Новые экземпляры пишут chain сами: WHEN (NEW.chain IS NULL) их не касается.
CREATE OR REPLACE FUNCTION imago_operations_chain() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  prev text;
BEGIN
  IF NEW.seq = 1 THEN
    prev := '';
  ELSE
    SELECT o.chain INTO prev FROM operations o WHERE o.project_id = NEW.project_id AND o.seq = NEW.seq - 1;
  END IF;
  IF prev IS NOT NULL THEN
    NEW.chain := encode(sha256(convert_to(prev || NEW.tx_id || NEW.seq::text, 'UTF8')), 'hex');
    UPDATE projects SET head_chain = NEW.chain WHERE id = NEW.project_id AND head_seq = NEW.seq;
  END IF;
  RETURN NEW;
END
$fn$;

-- снимок старого экземпляра — с chain своей записи журнала (seq 0 — '')
CREATE OR REPLACE FUNCTION imago_snapshots_chain() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.seq = 0 THEN
    NEW.chain := '';
  ELSE
    SELECT o.chain INTO NEW.chain FROM operations o WHERE o.project_id = NEW.project_id AND o.seq = NEW.seq;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS operations_chain ON operations;
CREATE TRIGGER operations_chain BEFORE INSERT ON operations
  FOR EACH ROW WHEN (NEW.chain IS NULL) EXECUTE FUNCTION imago_operations_chain();
DROP TRIGGER IF EXISTS snapshots_chain ON snapshots;
CREATE TRIGGER snapshots_chain BEFORE INSERT ON snapshots
  FOR EACH ROW WHEN (NEW.chain IS NULL) EXECUTE FUNCTION imago_snapshots_chain();
