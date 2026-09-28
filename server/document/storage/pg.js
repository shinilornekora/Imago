/**
 * Адаптер хранилища: PostgreSQL (SPEC §8.1 «База», §9.4; схема — docs/06).
 *
 * Интерфейс общий с ./memory.js — секвенсор и DSLR не знают, что под ними:
 *   init() · close()
 *   createProject({name, kind, doc, engine}) → Project   (снимок при seq 0 — сразу)
 *   listProjects() → Project[] · getProject(id) → Project|null · renameProject(id, name)
 *   latestSnapshot(projectId) → {seq, doc, engine, created_at}|null
 *   txsAfter(projectId, seq, limit) → Committed[]
 *   commitTx(projectId, tx, {expectSeq}) → {status:'committed'|'existing'|'stale'|'missing', …}
 *   writeSnapshot(projectId, seq, doc, engine) · findTx(projectId, txId) → Committed|null
 *
 * Все запросы параметризованы; JSON в jsonb-колонки уходит строкой через
 * JSON.stringify — node-pg превращает массив-параметр в литерал массива
 * Postgres (`{…}`), и `ops` без явной сериализации в jsonb не ложится.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { toCommitted, txColumns } from './committed.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ключ advisory-lock миграций: два экземпляра на старте не должны мигрировать одновременно. */
const MIGRATION_LOCK = 728208;

/**
 * bigint (oid 20) node-pg отдаёт строкой, чтобы не терять точность; seq и
 * head_seq нужны числом, а до 2^53 они не дорастут. Переопределение — только
 * для этого пула, глобальный setTypeParser трогал бы чужие подключения.
 */
const types = {
  getTypeParser(oid, format) {
    if (oid === 20 && format !== 'binary') return (v) => (v === null ? null : Number(v));
    return pg.types.getTypeParser(oid, format);
  }
};

const OP_COLUMNS = 'project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, engine, created_at';

/** Проект из строки таблицы: даты — ISO-строками, как всё остальное в контракте. */
function projectOf(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, kind: row.kind, head_seq: Number(row.head_seq), engine: row.engine,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

/**
 * @param {{connectionString?: string, pool?: import('pg').Pool, log?: {warn:Function, info:Function}}} opts
 */
export function createPgStorage(opts = {}) {
  const log = opts.log || console;
  const pool = opts.pool || new pg.Pool({
    connectionString: opts.connectionString,
    types,
    max: opts.max || 10,
    // сервер без базы должен отвечать 503, а не висеть: ждём подключения не дольше 5 с
    connectionTimeoutMillis: opts.connectionTimeoutMillis || 5000
  });
  // ошибка простаивающего соединения (база перезапустилась) без обработчика роняет процесс
  pool.on('error', (err) => log.warn('[document/pg] соединение потеряно:', err.message));

  /**
   * Миграции: файлы каталога по алфавиту, все неприменённые — одной транзакцией,
   * учёт в schema_migrations. Под сессионным advisory-lock целиком, включая
   * создание самой таблицы учёта: два экземпляра, стартующие одновременно на
   * пустой базе, иначе сталкиваются уже на CREATE TABLE IF NOT EXISTS.
   */
  async function migrate() {
    const client = await pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      locked = true;
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await client.query('BEGIN');
      const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        log.info(`[document/pg] миграция ${file} применена`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      client.release();
    }
  }

  return {
    kind: 'pg',
    /** Пул наружу — тестам, чтобы чистить таблицы; сервису он не нужен. */
    pool,

    async init() {
      await migrate();
    },

    async close() {
      await pool.end();
    },

    async createProject({ name = '', kind = 'design', doc, engine }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          'INSERT INTO projects (name, kind, engine) VALUES ($1, $2, $3) RETURNING *',
          [name, kind, engine]
        );
        const project = projectOf(ins.rows[0]);
        // документ = снимок при seq 0: открытие проекта всегда начинается со снимка
        await client.query(
          'INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, 0, $2::jsonb, $3)',
          [project.id, JSON.stringify(doc), engine]
        );
        await client.query('COMMIT');
        return project;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async listProjects() {
      const res = await pool.query('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC');
      return res.rows.map(projectOf);
    },

    async getProject(id) {
      // не-uuid — это «нет такого проекта» (404), а не ошибка базы «invalid input syntax» (503)
      if (!UUID_RE.test(String(id))) return null;
      const res = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
      return projectOf(res.rows[0]);
    },

    async renameProject(id, name) {
      if (!UUID_RE.test(String(id))) return null;
      const res = await pool.query(
        'UPDATE projects SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, name]
      );
      return projectOf(res.rows[0]);
    },

    async latestSnapshot(projectId) {
      if (!UUID_RE.test(String(projectId))) return null;
      const res = await pool.query(
        'SELECT seq, doc, engine, created_at FROM snapshots WHERE project_id = $1 ORDER BY seq DESC LIMIT 1',
        [projectId]
      );
      const row = res.rows[0];
      if (!row) return null;
      return { seq: Number(row.seq), doc: row.doc, engine: row.engine, created_at: row.created_at.toISOString() };
    },

    async txsAfter(projectId, seq, limit = 500) {
      if (!UUID_RE.test(String(projectId))) return [];
      const res = await pool.query(
        `SELECT ${OP_COLUMNS} FROM operations WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [projectId, seq, limit]
      );
      return res.rows.map(toCommitted);
    },

    /**
     * Запись транзакции — в одной транзакции базы (SPEC §9.4, п.3):
     * UPDATE head_seq + 1 RETURNING → INSERT … ON CONFLICT (project_id, tx_id) DO NOTHING.
     * Конфликт по tx_id → откат (номер головы не должен уйти вперёд без записи) и
     * существующая запись. `expectSeq` — номер, которого ждёт голова в памяти;
     * выданный номер другой → писал другой экземпляр: откат и `stale`, секвенсор
     * перечитает хвост и повторит слияние.
     */
    async commitTx(projectId, tx, { expectSeq } = {}) {
      if (!UUID_RE.test(String(projectId))) return { status: 'missing' };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const up = await client.query(
          'UPDATE projects SET head_seq = head_seq + 1, updated_at = now() WHERE id = $1 RETURNING head_seq',
          [projectId]
        );
        if (!up.rowCount) {
          await client.query('ROLLBACK');
          return { status: 'missing' };
        }
        const seq = Number(up.rows[0].head_seq);
        const c = txColumns(tx);
        const ins = await client.query(
          `INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, engine)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (project_id, tx_id) DO NOTHING
           RETURNING ${OP_COLUMNS}`,
          [projectId, seq, c.tx_id, c.base_seq, JSON.stringify(c.ops), JSON.stringify(c.dropped), JSON.stringify(c.notes),
            c.undo_of, c.redo_of, c.author, c.author_kind, c.client, c.title, c.engine]
        );
        if (!ins.rowCount) {
          await client.query('ROLLBACK');
          const ex = await client.query(
            `SELECT ${OP_COLUMNS} FROM operations WHERE project_id = $1 AND tx_id = $2`,
            [projectId, c.tx_id]
          );
          return { status: 'existing', committed: toCommitted(ex.rows[0]) };
        }
        if (expectSeq !== undefined && seq !== expectSeq) {
          await client.query('ROLLBACK');
          return { status: 'stale', head_seq: seq - 1 };
        }
        await client.query('COMMIT');
        return { status: 'committed', committed: toCommitted(ins.rows[0]) };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async writeSnapshot(projectId, seq, doc, engine) {
      await pool.query(
        'INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (project_id, seq) DO NOTHING',
        [projectId, seq, JSON.stringify(doc), engine]
      );
    },

    async findTx(projectId, txId) {
      if (!UUID_RE.test(String(projectId))) return null;
      const res = await pool.query(
        `SELECT ${OP_COLUMNS} FROM operations WHERE project_id = $1 AND tx_id = $2`,
        [projectId, String(txId)]
      );
      return res.rows[0] ? toCommitted(res.rows[0]) : null;
    }
  };
}
