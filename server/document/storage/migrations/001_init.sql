-- 001_init.sql — журнал операций как источник истины (SPEC §8.3, §9; docs/06-схема-базы).
-- Только таблицы этого круга: PROJECTS, OPERATIONS, SNAPSHOTS и пустые LIBRARY_VERSIONS,
-- PROJECT_IMPORTS. AGENT_RUNS, WORKSPACES, USERS, MEMBERSHIPS, ASSETS — фаза 2, их здесь нет.
-- gen_random_uuid() встроен в PostgreSQL с 13-й версии, расширение pgcrypto не нужно.

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'design' CHECK (kind IN ('design', 'library')),
  -- номер последней транзакции — точка сериализации: UPDATE … head_seq + 1 RETURNING
  -- в одной транзакции базы с INSERT в operations делает «единственного писателя»
  -- инвариантом базы, а не процесса (SPEC §9.4, п.3)
  head_seq    bigint NOT NULL DEFAULT 0,
  engine      int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operations (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  -- ключ идемпотентности вместе с project_id: повтор tx_id возвращает сохранённое (SPEC §8.3)
  tx_id       text NOT NULL,
  base_seq    bigint NOT NULL,
  -- ПРИМЕНЁННАЯ форма после слияния — переигрывание журнала идёт строгим applyOps
  ops         jsonb NOT NULL,
  dropped     jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  undo_of     text,
  redo_of     text,
  author      text,
  author_kind text NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human', 'agent', 'system')),
  client      text,
  title       text,
  engine      int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, tx_id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- документ ПОСЛЕ этой транзакции; seq 0 — документ только что созданного проекта
  seq         bigint NOT NULL,
  -- root · nodes · tokens · meta — целиком (ревью, D7: без токенов снимок бесполезен)
  doc         jsonb NOT NULL,
  engine      int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq)
);

-- Фаза 3 (SPEC §8.3, «библиотека = проект вида library»): помеченные снимки.
-- Заведены по схеме сейчас, чтобы следующей миграции не менять ключи operations/snapshots.
CREATE TABLE IF NOT EXISTS library_versions (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag         text NOT NULL,
  seq         bigint NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, tag)
);

CREATE TABLE IF NOT EXISTS project_imports (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- библиотеку, на которую кто-то прибит, удалить нельзя — импорт живёт в чужом журнале
  library_id  uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version_tag text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, library_id),
  FOREIGN KEY (library_id, version_tag) REFERENCES library_versions(project_id, tag)
);
