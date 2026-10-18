-- 014_snapshot_engine.sql — снимок не старше движка записей под ним (круг 39, N1).
--
-- Формат документа менялся (круги 36–37), а экземпляр прежней версии, встретив запись журнала,
-- которую его движок не применяет, пропускал её — и писал снимок со своей «дырявой» головы:
-- снимок — то, с чего открывают все, и пропущенная запись (например, векторный слой) терялась у
-- всех, хотя журнал её хранит. Сервис этой версии такой снимок не пишет сам (голова с пропуском
-- снимков не пишет, запись новее движка — отказ проекту), а триггер страхует от экземпляров
-- ПРЕЖНИХ версий при откате развёртывания и смешанных версиях: снимок движка N не ложится,
--   - если предыдущий снимок проекта (seq не больше) записан движком новее N;
--   - если между предыдущим снимком и этим в журнале есть запись движка новее N.
-- Отказ — ошибка вставки (SQLSTATE IE426): писатель снимка пишет предупреждение и работает дальше,
-- открывают с прежнего снимка и переигрывают журнал — ничего не теряется. Проверка дешёвая:
-- последний снимок по ключу (project_id, seq) и записи журнала от него до нового — обычно не
-- больше SNAPSHOT_EVERY строк по первичному ключу.
--
-- Смешанные версии (SPEC §9.11): триггер только отвергает негодный снимок, ничего не пишет;
-- прежний экземпляр снимков движка своей версии поверх своих же записей пишет как раньше.
-- pg_dump ставит триггеры после данных — восстановление из копии его не задевает.

CREATE OR REPLACE FUNCTION imago_snapshots_engine() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  prev_seq bigint;
  prev_engine int;
  newer int;
BEGIN
  SELECT s.seq, s.engine INTO prev_seq, prev_engine FROM snapshots s
   WHERE s.project_id = NEW.project_id AND s.seq <= NEW.seq
   ORDER BY s.seq DESC LIMIT 1;
  IF prev_engine IS NOT NULL AND prev_engine > NEW.engine THEN
    RAISE EXCEPTION 'снимок seq % движка % старше снимка seq % движка % — не пишется', NEW.seq, NEW.engine, prev_seq, prev_engine
      USING ERRCODE = 'IE426';
  END IF;
  SELECT max(o.engine) INTO newer FROM operations o
   WHERE o.project_id = NEW.project_id AND o.seq > coalesce(prev_seq, 0) AND o.seq <= NEW.seq AND o.engine > NEW.engine;
  IF newer IS NOT NULL THEN
    RAISE EXCEPTION 'снимок seq % движка % — в журнале под ним запись движка % — не пишется', NEW.seq, NEW.engine, newer
      USING ERRCODE = 'IE426';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS snapshots_engine ON snapshots;
CREATE TRIGGER snapshots_engine BEFORE INSERT ON snapshots
  FOR EACH ROW EXECUTE FUNCTION imago_snapshots_engine();
