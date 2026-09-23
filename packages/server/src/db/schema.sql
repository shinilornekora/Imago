-- Схема БД стенда (SPEC §3). Идемпотентна: все выражения IF NOT EXISTS.
-- Все таблицы имеют PRIMARY KEY (требование Zero для логической репликации).

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  password_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id       text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  name     text NOT NULL,
  revision integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS documents_owner_id_idx ON documents (owner_id);

CREATE TABLE IF NOT EXISTS pages (
  id          text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  "index"     integer NOT NULL,
  name        text NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_document_id_index_idx ON pages (document_id, "index");

CREATE TABLE IF NOT EXISTS shapes (
  id              text PRIMARY KEY,
  document_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_id         text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('rect', 'ellipse', 'text')),
  x               double precision NOT NULL,
  y               double precision NOT NULL,
  w               double precision NOT NULL,
  h               double precision NOT NULL,
  z               integer NOT NULL,
  text            text,
  fill            text NOT NULL,
  is_source       boolean NOT NULL DEFAULT false,
  source_id       text,
  fill_overridden boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS shapes_page_id_idx     ON shapes (page_id);
CREATE INDEX IF NOT EXISTS shapes_source_id_idx   ON shapes (source_id);
CREATE INDEX IF NOT EXISTS shapes_document_id_idx ON shapes (document_id);

-- Журнал операций для идемпотентности команд (SPEC §2.3). Записи живут 24 ч.
CREATE TABLE IF NOT EXISTS operations (
  op_id       text PRIMARY KEY,
  document_id text NOT NULL,
  params_hash text NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operations_document_id_idx ON operations (document_id);
CREATE INDEX IF NOT EXISTS operations_created_at_idx  ON operations (created_at);

-- Снимок исходных заливок генератора для быстрого reset (тестовый хук /api/test/reset).
-- Заполняется генератором при load; reset = UPDATE shapes FROM shapes_baseline.
CREATE TABLE IF NOT EXISTS shapes_baseline (
  shape_id        text PRIMARY KEY,
  document_id     text NOT NULL,
  fill            text NOT NULL,
  fill_overridden boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS shapes_baseline_document_id_idx ON shapes_baseline (document_id);
