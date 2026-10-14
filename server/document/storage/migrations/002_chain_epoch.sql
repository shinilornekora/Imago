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
-- NOT NULL на неё ставит 004.

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
