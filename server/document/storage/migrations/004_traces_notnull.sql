-- 004_traces_notnull.sql — трассы агента (SPEC §10.4).
--
-- Имя — историческое: до круга 25 здесь же стоял `ALTER … chain SET NOT NULL`. В одном
-- выпуске с 002/003 он ломал обновление при работающем экземпляре прежней версии
-- (записи без chain после 003 → 004 падала при каждом старте; на большой базе
-- ACCESS EXCLUSIVE держался секунды). «Не пусто» на chain теперь ставит 006 —
-- безопасно для смешанных версий (SPEC §9.11). Базы, где прежняя 004 уже легла, ничего
-- не теряют: NOT NULL у них уже есть, 006 это видит.

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
