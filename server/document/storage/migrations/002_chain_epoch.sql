-- 002_chain_epoch.sql — якорь цепочки журнала и эпоха проекта (SPEC §9.8).
--
-- chain = sha256(prev_chain || tx_id || seq) — у каждой записи журнала; у проекта —
-- head_chain (chain записи head_seq; '' у пустого журнала). Клиент держит tip = chain
-- своей последней подтверждённой и присылает его при переподключении: несовпадение
-- с журналом значит, что база откатилась (бэкап/restore), и номер seq больше не
-- называет ту же транзакцию.
--
-- epoch — случайная метка проекта; меняется, когда откат обнаружен (экземпляром или
-- клиентом). Счётчик не годится: после restore он вернулся бы к старому значению и
-- совпал бы с эпохой, которая была уже после бэкапа. project_epochs — все эпохи,
-- которые знает эта база: эпоха клиента, которой база не знает, — тоже след отката.
--
-- Колонка chain у старых записей заполняется следующей миграцией (003, пачками);
-- «не пусто» на неё ставит 006 (CHECK NOT VALID → VALIDATE: без долгого эксклюзивного
-- замка). Всё здесь — без перезаписи таблиц: колонки без умолчания или с постоянным
-- умолчанием (Postgres 11+ хранит его в каталоге).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS head_chain text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS epoch text NOT NULL DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 12);
-- кто начал эпоху: init · instance (экземпляр увидел откат) · client (клиент прислал чужой tip)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS epoch_cause text NOT NULL DEFAULT 'init';

ALTER TABLE operations ADD COLUMN IF NOT EXISTS chain text;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS chain text;

CREATE TABLE IF NOT EXISTS project_epochs (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epoch       text NOT NULL,
  -- голова, на которой эпоха началась
  seq         bigint NOT NULL DEFAULT 0,
  cause       text NOT NULL DEFAULT 'init',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, epoch)
);

INSERT INTO project_epochs (project_id, epoch, seq, cause)
SELECT id, epoch, head_seq, 'init' FROM projects
ON CONFLICT DO NOTHING;

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
