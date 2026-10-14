-- 004_traces_notnull.sql — трассы агента (SPEC §10.4) и NOT NULL на chain после заполнения (003).

-- После 003 у каждой записи журнала есть chain; новые пишет DSLTS (storage/pg.js commitTx).
ALTER TABLE operations ALTER COLUMN chain SET NOT NULL;
-- снимок без chain (не должно остаться после 003) — переигрывать его не с чем сверять
UPDATE snapshots SET chain = '' WHERE chain IS NULL AND seq = 0;
DELETE FROM snapshots WHERE chain IS NULL;
ALTER TABLE snapshots ALTER COLUMN chain SET NOT NULL;

-- Трасса команды агента: шаги, длительности, число вызовов модели — без ключей и без
-- полных промптов (их не кладёт Orchestrator). Тело ≤ 64 КБ (limits.js MAX_TRACE_BYTES).
CREATE TABLE IF NOT EXISTS traces (
  id          bigserial PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  command_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  body        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_project_created ON traces (project_id, created_at DESC, id DESC);
