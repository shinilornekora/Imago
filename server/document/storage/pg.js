/**
 * Адаптер хранилища: PostgreSQL (SPEC §8.1 «База», §9.4, §9.8; схема — docs/06).
 *
 * Интерфейс общий с ./memory.js — секвенсор и DSLR не знают, что под ними:
 *   init() · close() · kind
 *   createProject({name, kind, doc, engine}) → Project   (снимок при seq 0 — сразу, эпоха — новая)
 *   listProjects() → Project[] · getProject(id) → Project|null · renameProject(id, name)
 *     Project = {id, name, kind, head_seq, head_chain, epoch, epoch_cause, engine, created_at, updated_at}
 *   latestSnapshot(projectId) → {seq, doc, engine, chain, created_at}|null   (только снимок, чей chain совпадает с журналом)
 *   txsAfter(projectId, seq, limit, {maxBytes}?) → Committed[]   (первая — всегда, дальше — пока влезает в maxBytes)
 *   chainAt(projectId, seq) → string|null   (seq 0 → '')
 *   commitTx(projectId, tx, {expectSeq, expectChain, origin}) → {status:'committed'|'existing'|'stale'|'missing', …}
 *   writeSnapshot(projectId, seq, doc, engine, chain) → boolean · pruneSnapshots(projectId, keep)
 *   findTx(projectId, txId) → Committed|null
 *   knownEpoch(projectId, epoch) → boolean · bumpEpoch(projectId, fromEpoch, cause, origin) → {status:'bumped'|'moved', epoch, cause}
 *   addTrace({projectId, commandId, body}) → {id, created_at}|null · listTraces(projectId, limit) → Trace[]
 *   onNotify(fn) → отписка: {k:'tx', p, s, c, e, i} · {k:'epoch', p, e, i} · {k:'resync'}
 *
 * Уведомления: запись транзакции и смена эпохи шлют `pg_notify` В ТОЙ ЖЕ транзакции
 * базы — уведомление уходит ровно тогда, когда запись видна. Каждый экземпляр
 * слушает канал отдельным соединением (LISTEN); после его переподключения
 * слушатели получают `{k:'resync'}` — уведомления за время разрыва потеряны,
 * головы надо сверить с базой.
 *
 * Дедлайны: обычные запросы — statement_timeout и query_timeout = DB_TIMEOUT_MS;
 * миграции — отдельным соединением без дедлайна (`SET LOCAL statement_timeout = 0`),
 * под advisory-lock, каждая в своей транзакции; `.mjs`-миграции сами режут работу
 * на пачки-транзакции.
 *
 * Все запросы параметризованы; JSON в jsonb-колонки уходит строкой через
 * JSON.stringify — node-pg превращает массив-параметр в литерал массива
 * Postgres (`{…}`), и `ops` без явной сериализации в jsonb не ложится.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { toCommitted, txColumns, newEpoch } from './committed.js';
import { DB_TIMEOUT_MS, PAGE_BYTES } from '../limits.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ключ advisory-lock миграций: два экземпляра на старте не должны мигрировать одновременно. */
const MIGRATION_LOCK = 728208;
/** Имя файла миграции: номер, имя, .sql или .mjs. */
const MIGRATION_RE = /^\d{3,}_[\w.-]+\.(sql|mjs)$/;
const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/;

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

const OP_COLUMNS = 'project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, engine, chain, created_at';

const isoOf = (v) => (v instanceof Date ? v.toISOString() : v);

/** Проект из строки таблицы: даты — ISO-строками, как всё остальное в контракте. */
function projectOf(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, kind: row.kind, head_seq: Number(row.head_seq), engine: row.engine,
    head_chain: row.head_chain || '', epoch: row.epoch, epoch_cause: row.epoch_cause || 'init',
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at)
  };
}

/**
 * @param {{
 *   connectionString?: string,
 *   pool?: import('pg').Pool,
 *   options?: string,              // параметры сеанса (например, `-c search_path=x` — тестам)
 *   max?: number,
 *   connectionTimeoutMillis?: number,
 *   dbTimeoutMs?: number,          // дедлайн обычного запроса (DB_TIMEOUT_MS)
 *   migrationsDir?: string,
 *   channel?: string,              // канал LISTEN/NOTIFY (imago_doc)
 *   listen?: boolean,              // слушать уведомления (по умолчанию — да, если есть connectionString)
 *   log?: {warn:Function, info:Function}
 * }} opts
 */
export function createPgStorage(opts = {}) {
  const log = opts.log || console;
  const dbTimeoutMs = opts.dbTimeoutMs !== undefined ? opts.dbTimeoutMs : Number(process.env.DB_TIMEOUT_MS || DB_TIMEOUT_MS);
  const migrationsDir = opts.migrationsDir || MIGRATIONS_DIR;
  const channel = opts.channel || 'imago_doc';
  if (!CHANNEL_RE.test(channel)) throw new Error('channel: имя канала NOTIFY — [a-z_][a-z0-9_]*');
  const base = {
    connectionString: opts.connectionString,
    types,
    ...(opts.options ? { options: opts.options } : {}),
    // сервер без базы должен отвечать 503, а не висеть: ждём подключения не дольше 5 с
    connectionTimeoutMillis: opts.connectionTimeoutMillis || 5000
  };
  const pool = opts.pool || new pg.Pool({
    ...base,
    max: opts.max || 10,
    ...(dbTimeoutMs > 0 ? { statement_timeout: dbTimeoutMs, query_timeout: dbTimeoutMs + 1000 } : {})
  });
  // ошибка простаивающего соединения (база перезапустилась) без обработчика роняет процесс
  pool.on('error', (err) => log.warn('[document/pg] соединение потеряно:', err.message));

  /* ------------------------------ уведомления ------------------------------ */

  const listeners = new Set();
  const canListen = opts.listen !== undefined ? !!opts.listen : !!opts.connectionString;
  let listener = null;
  let listenTimer = null;
  let listenAttempt = 0;
  let closing = false;
  let initing = null;

  function dispatch(msg) {
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch (e) {
        log.warn('[document/pg] слушатель уведомлений упал:', e && e.message);
      }
    }
  }

  async function connectListener(isRetry) {
    if (closing) return;
    const client = new pg.Client(base);
    const retry = () => {
      if (closing || listenTimer) return;
      if (listener === client) listener = null;
      const delay = Math.min(10000, 200 * Math.pow(2, Math.min(listenAttempt++, 6)));
      listenTimer = setTimeout(() => {
        listenTimer = null;
        connectListener(true).catch(() => {});
      }, delay);
      if (listenTimer.unref) listenTimer.unref();
    };
    client.on('notification', (m) => {
      if (m.channel !== channel || !m.payload) return;
      let msg;
      try {
        msg = JSON.parse(m.payload);
      } catch (_) {
        return;
      }
      if (msg && typeof msg === 'object') dispatch(msg);
    });
    client.on('error', (e) => {
      log.warn('[document/pg] слушатель NOTIFY потерял соединение:', e && e.message);
      client.end().catch(() => {});
      retry();
    });
    client.on('end', () => { if (!closing) retry(); });
    try {
      await client.connect();
      await client.query(`LISTEN ${channel}`);
    } catch (e) {
      client.end().catch(() => {});
      if (!isRetry) throw e;
      retry();
      return;
    }
    if (closing) {
      await client.end().catch(() => {});
      return;
    }
    listener = client;
    listenAttempt = 0;
    // пока соединения не было, уведомления терялись: головы сверяются с базой
    if (isRetry) dispatch({ k: 'resync' });
  }

  async function notify(client, msg) {
    await client.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(msg)]);
  }

  /* -------------------------------- миграции -------------------------------- */

  /**
   * Миграции (SPEC §9.8): файлы каталога `NNN_имя.sql|mjs` по порядку, учёт в
   * schema_migrations. Отдельное соединение без дедлайна обычных запросов;
   * сессионный advisory-lock на всё время (включая создание таблицы учёта — два
   * экземпляра на пустой базе иначе столкнутся уже на CREATE TABLE). Каждая
   * `.sql` — своя транзакция с `SET LOCAL statement_timeout = 0`; `.mjs` получает
   * соединение и сама режет тяжёлую работу на пачки-транзакции.
   */
  async function migrate() {
    const client = new pg.Client(base);
    await client.connect();
    let locked = false;
    try {
      await client.query('SET statement_timeout = 0');
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      locked = true;
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = (await readdir(migrationsDir)).filter((f) => MIGRATION_RE.test(f)).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        const full = path.join(migrationsDir, file);
        const started = Date.now();
        if (file.endsWith('.sql')) {
          const sql = await readFile(full, 'utf8');
          await client.query('BEGIN');
          try {
            await client.query('SET LOCAL statement_timeout = 0');
            await client.query('SET LOCAL lock_timeout = 0');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            e.message = `миграция ${file}: ${e.message}`;
            throw e;
          }
        } else {
          const mod = await import(pathToFileURL(full).href);
          if (typeof mod.up !== 'function') throw new Error(`миграция ${file}: нет export up()`);
          try {
            await mod.up({ client, log });
          } catch (e) {
            e.message = `миграция ${file}: ${e.message}`;
            throw e;
          }
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        }
        log.info(`[document/pg] миграция ${file} применена за ${Date.now() - started} мс`);
      }
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      await client.end().catch(() => {});
    }
  }

  /** Запрос в транзакции базы на соединении из пула. */
  async function inTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      if (out && out.__rollback) {
        await client.query('ROLLBACK');
        return out.value;
      }
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  const rollback = (value) => ({ __rollback: true, value });

  const okId = (id) => UUID_RE.test(String(id));

  return {
    kind: 'pg',
    /** Пул наружу — тестам, чтобы чистить таблицы; сервису он не нужен. */
    pool,
    channel,
    migrate,

    /** Миграции и слушатель уведомлений; повторный вызов (второй экземпляр на том же адаптере) — тот же промис. */
    init() {
      if (!initing) {
        initing = (async () => {
          await migrate();
          if (canListen) await connectListener(false);
        })();
        initing.catch(() => { initing = null; });
      }
      return initing;
    },

    async close() {
      closing = true;
      if (listenTimer) clearTimeout(listenTimer);
      listenTimer = null;
      if (listener) {
        const l = listener;
        listener = null;
        await l.end().catch(() => {});
      }
      listeners.clear();
      await pool.end();
    },

    onNotify(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async createProject({ name = '', kind = 'design', doc, engine }) {
      const epoch = newEpoch();
      return inTx(async (client) => {
        const ins = await client.query(
          'INSERT INTO projects (name, kind, engine, epoch, epoch_cause) VALUES ($1, $2, $3, $4, \'init\') RETURNING *',
          [name, kind, engine, epoch]
        );
        const project = projectOf(ins.rows[0]);
        // документ = снимок при seq 0: открытие проекта всегда начинается со снимка; его не удаляет прореживание
        await client.query(
          'INSERT INTO snapshots (project_id, seq, doc, engine, chain) VALUES ($1, 0, $2::jsonb, $3, \'\')',
          [project.id, JSON.stringify(doc), engine]
        );
        await client.query('INSERT INTO project_epochs (project_id, epoch, seq, cause) VALUES ($1, $2, 0, \'init\')', [project.id, epoch]);
        return project;
      });
    },

    async listProjects() {
      const res = await pool.query('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC');
      return res.rows.map(projectOf);
    },

    async getProject(id) {
      // не-uuid — это «нет такого проекта» (404), а не ошибка базы «invalid input syntax» (503)
      if (!okId(id)) return null;
      const res = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
      return projectOf(res.rows[0]);
    },

    async renameProject(id, name) {
      if (!okId(id)) return null;
      const res = await pool.query(
        'UPDATE projects SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, name]
      );
      return projectOf(res.rows[0]);
    },

    /**
     * Последний снимок, которому можно верить: seq 0 (затравка) или снимок, чей
     * chain совпадает с журналом на его seq. Снимок, записанный по журналу, которого
     * после отката базы уже нет, не годится — с него клиент тихо разошёлся бы.
     */
    async latestSnapshot(projectId) {
      if (!okId(projectId)) return null;
      const res = await pool.query(
        `SELECT s.seq, s.doc, s.engine, s.chain, s.created_at FROM snapshots s
          WHERE s.project_id = $1
            AND (s.seq = 0 OR EXISTS (SELECT 1 FROM operations o WHERE o.project_id = s.project_id AND o.seq = s.seq AND o.chain = s.chain))
          ORDER BY s.seq DESC LIMIT 1`,
        [projectId]
      );
      const row = res.rows[0];
      if (!row) return null;
      return { seq: Number(row.seq), doc: row.doc, engine: row.engine, chain: row.chain || '', created_at: isoOf(row.created_at) };
    },

    /** Номера снимков проекта (тестам и отладке). */
    async snapshotSeqs(projectId) {
      if (!okId(projectId)) return [];
      const res = await pool.query('SELECT seq FROM snapshots WHERE project_id = $1 ORDER BY seq', [projectId]);
      return res.rows.map((r) => Number(r.seq));
    },

    /**
     * Хвост после seq: не больше limit записей и — мягко — maxBytes JSON (первая
     * запись входит всегда, даже если одна больше предела).
     */
    async txsAfter(projectId, seq, limit = 500, { maxBytes = PAGE_BYTES } = {}) {
      if (!okId(projectId)) return [];
      const res = await pool.query(
        `SELECT ${OP_COLUMNS} FROM (
           SELECT ${OP_COLUMNS},
                  octet_length(ops::text) + octet_length(dropped::text) AS row_bytes,
                  sum(octet_length(ops::text) + octet_length(dropped::text)) OVER (ORDER BY seq) AS run_bytes
             FROM operations WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3
         ) t WHERE run_bytes - row_bytes < $4 ORDER BY seq`,
        [projectId, seq, limit, maxBytes]
      );
      return res.rows.map(toCommitted);
    },

    async chainAt(projectId, seq) {
      if (!okId(projectId)) return null;
      if (seq === 0) {
        const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
        return p.rowCount ? '' : null;
      }
      const res = await pool.query('SELECT chain FROM operations WHERE project_id = $1 AND seq = $2', [projectId, seq]);
      return res.rows[0] ? res.rows[0].chain : null;
    },

    /**
     * Запись транзакции — в одной транзакции базы (SPEC §9.4, п.3; §9.8):
     * UPDATE head_seq + 1, head_chain = sha256(head_chain + tx_id + seq) RETURNING →
     * INSERT … ON CONFLICT (project_id, tx_id) DO NOTHING → pg_notify.
     * Конфликт по tx_id → откат (номер головы не уходит вперёд без записи) и
     * существующая запись. `expectSeq`/`expectChain` — чего ждёт голова в памяти:
     * другой номер или другая цепочка → откат и `stale` (head_seq — голова базы до
     * нашей попытки; `reason:'chain'` — номер тот же, а журнал под ним другой).
     */
    async commitTx(projectId, tx, { expectSeq, expectChain, origin } = {}) {
      if (!okId(projectId)) return { status: 'missing' };
      const c = txColumns(tx);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const up = await client.query(
          `UPDATE projects SET head_seq = head_seq + 1,
                  head_chain = encode(sha256(convert_to(head_chain || $2 || (head_seq + 1)::text, 'UTF8')), 'hex'),
                  updated_at = now()
            WHERE id = $1 RETURNING head_seq, head_chain, epoch`,
          [projectId, c.tx_id]
        );
        if (!up.rowCount) {
          await client.query('ROLLBACK');
          return { status: 'missing' };
        }
        const seq = Number(up.rows[0].head_seq);
        const chain = up.rows[0].head_chain;
        const epoch = up.rows[0].epoch;
        const ins = await client.query(
          `INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, engine, chain)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (project_id, tx_id) DO NOTHING
           RETURNING ${OP_COLUMNS}`,
          [projectId, seq, c.tx_id, c.base_seq, JSON.stringify(c.ops), JSON.stringify(c.dropped), JSON.stringify(c.notes),
            c.undo_of, c.redo_of, c.author, c.author_kind, c.client, c.title, c.engine, chain]
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
          return { status: 'stale', head_seq: seq - 1, epoch };
        }
        if (expectChain !== undefined && chain !== expectChain) {
          await client.query('ROLLBACK');
          return { status: 'stale', reason: 'chain', head_seq: seq - 1, epoch };
        }
        await notify(client, { k: 'tx', p: projectId, s: seq, c: chain, e: epoch, i: origin || '' });
        await client.query('COMMIT');
        return { status: 'committed', committed: toCommitted(ins.rows[0]), epoch };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Снимок пишется, только если журнал на его seq — тот же (chain совпадает):
     * снимок, посчитанный до отката базы и дописанный после, иначе отравил бы
     * открытие проекта. Снимок с тем же seq, но другой цепочкой, заменяется.
     * @returns {Promise<boolean>} записан ли
     */
    async writeSnapshot(projectId, seq, doc, engine, chain = '') {
      const res = await pool.query(
        `INSERT INTO snapshots (project_id, seq, doc, engine, chain)
         SELECT $1, $2, $3::jsonb, $4, $5
          WHERE EXISTS (SELECT 1 FROM operations WHERE project_id = $1 AND seq = $2 AND chain = $5)
         ON CONFLICT (project_id, seq) DO UPDATE SET doc = EXCLUDED.doc, engine = EXCLUDED.engine, chain = EXCLUDED.chain, created_at = now()
          WHERE snapshots.chain IS DISTINCT FROM EXCLUDED.chain`,
        [projectId, seq, JSON.stringify(doc), engine, chain]
      );
      return res.rowCount > 0;
    },

    /** Прореживание: последние `keep` снимков; seq 0 (затравка) не удаляется никогда. */
    async pruneSnapshots(projectId, keep) {
      if (!okId(projectId) || !(keep > 0)) return 0;
      const res = await pool.query(
        `DELETE FROM snapshots WHERE project_id = $1 AND seq <> 0
            AND seq NOT IN (SELECT seq FROM snapshots WHERE project_id = $1 AND seq <> 0 ORDER BY seq DESC LIMIT $2)`,
        [projectId, keep]
      );
      return res.rowCount;
    },

    async findTx(projectId, txId) {
      if (!okId(projectId)) return null;
      const res = await pool.query(
        `SELECT ${OP_COLUMNS} FROM operations WHERE project_id = $1 AND tx_id = $2`,
        [projectId, String(txId)]
      );
      return res.rows[0] ? toCommitted(res.rows[0]) : null;
    },

    async knownEpoch(projectId, epoch) {
      if (!okId(projectId) || typeof epoch !== 'string' || !epoch) return false;
      const res = await pool.query('SELECT 1 FROM project_epochs WHERE project_id = $1 AND epoch = $2', [projectId, epoch]);
      return res.rowCount > 0;
    },

    /**
     * Сменить эпоху, если она всё ещё `fromEpoch` (compare-and-set: два экземпляра,
     * увидевшие один откат, меняют её один раз). Уведомление — в той же транзакции.
     */
    async bumpEpoch(projectId, fromEpoch, cause, origin) {
      if (!okId(projectId)) return { status: 'missing' };
      const epoch = newEpoch();
      return inTx(async (client) => {
        const up = await client.query(
          'UPDATE projects SET epoch = $3, epoch_cause = $4 WHERE id = $1 AND epoch = $2 RETURNING head_seq',
          [projectId, fromEpoch, epoch, cause]
        );
        if (!up.rowCount) {
          const cur = await client.query('SELECT epoch, epoch_cause FROM projects WHERE id = $1', [projectId]);
          if (!cur.rowCount) return rollback({ status: 'missing' });
          return rollback({ status: 'moved', epoch: cur.rows[0].epoch, cause: cur.rows[0].epoch_cause });
        }
        await client.query(
          'INSERT INTO project_epochs (project_id, epoch, seq, cause) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [projectId, epoch, Number(up.rows[0].head_seq), cause]
        );
        await notify(client, { k: 'epoch', p: projectId, e: epoch, i: origin || '' });
        return { status: 'bumped', epoch, cause };
      });
    },

    /** Эпохи проекта по порядку (тестам и отладке). */
    async epochs(projectId) {
      if (!okId(projectId)) return [];
      const res = await pool.query('SELECT epoch, seq, cause, created_at FROM project_epochs WHERE project_id = $1 ORDER BY created_at, seq', [projectId]);
      return res.rows.map((r) => ({ epoch: r.epoch, seq: Number(r.seq), cause: r.cause, created_at: isoOf(r.created_at) }));
    },

    async addTrace({ projectId, commandId, body }) {
      if (!okId(projectId)) return null;
      const res = await pool.query(
        `INSERT INTO traces (project_id, command_id, body)
         SELECT $1, $2, $3::jsonb WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1)
         RETURNING id, created_at`,
        [projectId, String(commandId), JSON.stringify(body)]
      );
      const row = res.rows[0];
      return row ? { id: String(row.id), created_at: isoOf(row.created_at) } : null;
    },

    async listTraces(projectId, limit) {
      if (!okId(projectId)) return [];
      const res = await pool.query(
        'SELECT id, command_id, created_at, body FROM traces WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
        [projectId, limit]
      );
      return res.rows.map((r) => ({ id: String(r.id), command_id: r.command_id, created_at: isoOf(r.created_at), body: r.body }));
    }
  };
}
