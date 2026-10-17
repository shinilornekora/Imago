/**
 * Миграции Document service (SPEC §9.8, §9.11): нумерованные файлы, schema_migrations,
 * каждая — своя транзакция, под advisory-lock, без дедлайна обычных запросов;
 * заполнение chain у старого журнала пачками. Круг 25 — смешанные версии: экземпляр
 * прежней версии пишет журнал без chain во время и после миграций (триггер считает
 * chain за него, «не пусто» — CHECK NOT VALID → VALIDATE без долгого замка), прерванная
 * миграция продолжается со следующего старта, порт открыт во время миграций (503
 * migrating). Только Postgres; каждый тест — в своей схеме (search_path) временной базы
 * этого файла.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDoc, ENGINE_VERSION as E } from '../../src/core.js';
import WebSocket from 'ws';
import { createPgStorage, MIGRATIONS_DIR } from '../../server/document/storage/pg.js';
import { chainNext } from '../../server/document/storage/committed.js';
import { launch } from '../../server/document/index.js';
import { pgAvailable, DB_URL, quiet, api } from './helpers.mjs';

const available = await pgAvailable();

describe('миграции · pg', { skip: available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
  let admin;
  const schemas = [];

  before(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
  });
  after(async () => {
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
    await admin.end();
  });

  /** Новая пустая схема и storage на неё. */
  async function schema() {
    const name = 'mig_' + Math.random().toString(36).slice(2, 10);
    await admin.query(`CREATE SCHEMA ${name}`);
    schemas.push(name);
    return name;
  }
  const storageIn = (name, opts = {}) => createPgStorage({ connectionString: DB_URL, options: `-c search_path=${name}`, listen: false, log: quiet, ...opts });

  /** Каталог миграций: копия настоящих (по фильтру) + свои файлы. */
  async function migrationsDir(filter = () => true, extra = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-mig-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (filter(f)) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    for (const [f, body] of Object.entries(extra)) await writeFile(path.join(dir, f), body);
    return dir;
  }

  it('миграция дольше DB_TIMEOUT_MS проходит; обычный запрос с тем же дедлайном — нет', async () => {
    const name = await schema();
    const dir = await migrationsDir(undefined, { '900_slow.sql': 'SELECT pg_sleep(0.8);\nCREATE TABLE slow_done (x int);' });
    const s = storageIn(name, { migrationsDir: dir, dbTimeoutMs: 200 });
    try {
      const t0 = Date.now();
      await s.init();
      assert.ok(Date.now() - t0 >= 700, 'миграция действительно шла дольше дедлайна');
      const rows = (await s.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
      assert.ok(rows.includes('900_slow.sql'));
      assert.ok(rows.includes('003_chain_backfill.mjs'));
      await s.pool.query('SELECT 1 FROM slow_done');
      await assert.rejects(s.pool.query('SELECT pg_sleep(0.6)'), /timeout|cancel/i, 'обычный запрос упирается в дедлайн');
    } finally {
      await s.close();
    }
  });

  it('два экземпляра стартуют одновременно на пустой схеме: миграции — по одному разу, под advisory-lock', async () => {
    const name = await schema();
    const a = storageIn(name);
    const b = storageIn(name);
    try {
      await Promise.all([a.init(), b.init()]);
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3,}_.*\.(sql|mjs)$/.test(f)).sort();
      const rows = (await a.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
      assert.deepEqual(rows, files);
      const p = await a.createProject({ name: 'После', kind: 'design', doc: createDoc('empty'), engine: E });
      assert.match(p.epoch, /^[0-9a-f]{12}$/);
      assert.equal(p.head_chain, '');
      assert.equal((await b.getProject(p.id)).epoch, p.epoch);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('упавшая миграция откатывается целиком и называет файл; учёт не пополняется', async () => {
    const name = await schema();
    const dir = await migrationsDir(undefined, { '901_broken.sql': 'CREATE TABLE half_done (x int);\nSELECT * FROM нет_такой_таблицы;' });
    const s = storageIn(name, { migrationsDir: dir });
    try {
      await assert.rejects(s.init(), /901_broken\.sql/);
      const rows = (await admin.query(`SELECT name FROM ${name}.schema_migrations`)).rows.map((r) => r.name);
      assert.ok(!rows.includes('901_broken.sql'));
      assert.ok(rows.includes('006_chain_check.mjs'), 'предыдущие легли — каждая своей транзакцией');
      const half = await admin.query(`SELECT to_regclass('${name}.half_done') AS t`);
      assert.equal(half.rows[0].t, null, 'частичная работа упавшей миграции откачена');
    } finally {
      await s.close();
    }
  });

  it('003: chain у журнала, лёгшего до 002, считается пачками и совпадает с chainNext; голова и снимки — тоже', async () => {
    const name = await schema();
    const only001 = await migrationsDir((f) => f.startsWith('001_'));
    const old = storageIn(name, { migrationsDir: only001 });
    await old.init();
    // журнал «старого» сервиса: колонок chain/epoch ещё нет
    const ins = await old.pool.query("INSERT INTO projects (name, kind, engine, head_seq) VALUES ('Старый', 'design', $1, 1203) RETURNING id", [E]);
    const id = ins.rows[0].id;
    await old.pool.query('INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, 0, $2::jsonb, $3)', [id, JSON.stringify(createDoc('empty')), E]);
    // больше одной пачки (по 1000)
    await old.pool.query(
      `INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, engine)
       SELECT $1, g, 'tx_' || g, g - 1, '[]'::jsonb, $2 FROM generate_series(1, 1203) g`,
      [id, E]
    );
    await old.pool.query('INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, 1000, $2::jsonb, $3)', [id, JSON.stringify(createDoc('empty')), E]);
    await old.close();

    const s = storageIn(name);
    try {
      await s.init();
      const rows = (await s.pool.query('SELECT seq, tx_id, chain FROM operations WHERE project_id = $1 ORDER BY seq', [id])).rows;
      let prev = '';
      for (const r of rows) {
        prev = chainNext(prev, r.tx_id, r.seq);
        assert.equal(r.chain, prev, `chain seq ${r.seq}`);
      }
      const p = await s.getProject(id);
      assert.equal(p.head_chain, prev);
      assert.match(p.epoch, /^[0-9a-f]{12}$/);
      assert.equal((await s.epochs(id)).length, 1);
      const snap = await s.latestSnapshot(id);
      assert.equal(snap.seq, 1000);
      assert.equal(snap.chain, rows[999].chain);
      // и запись после миграции продолжает цепочку
      const res = await s.commitTx(id, { tx_id: 'tx_new', base_seq: 1203, ops: [], dropped: [], notes: [], author_kind: 'human', engine: E }, { expectSeq: 1204 });
      assert.equal(res.status, 'committed');
      assert.equal(res.committed.chain, chainNext(prev, 'tx_new', 1204));
    } finally {
      await s.close();
    }
  });
  /* ---------------------------- круг 25: смешанные версии ---------------------------- */

  /**
   * Экземпляр круга 22 (до 002): тот же SQL, что у его pg.js — номер головы, запись
   * журнала без chain, снимок без chain; project_epochs не пишет.
   */
  function oldInstance(name) {
    const pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${name}`, max: 2 });
    pool.on('error', () => {});
    return {
      pool,
      async createProject(title) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const id = (await c.query('INSERT INTO projects (name, kind, engine) VALUES ($1, $2, $3) RETURNING *', [title, 'design', E])).rows[0].id;
          await c.query('INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, 0, $2::jsonb, $3)', [id, JSON.stringify(createDoc('empty')), E]);
          await c.query('COMMIT');
          return id;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      async commit(projectId, txId) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const seq = Number((await c.query('UPDATE projects SET head_seq = head_seq + 1, updated_at = now() WHERE id = $1 RETURNING head_seq', [projectId])).rows[0].head_seq);
          const ins = await c.query(
            `INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, engine)
             VALUES ($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL, NULL, 'старый', 'human', NULL, NULL, $5)
             ON CONFLICT (project_id, tx_id) DO NOTHING RETURNING seq`,
            [projectId, seq, txId, seq - 1, E]
          );
          if (!ins.rowCount) {
            await c.query('ROLLBACK');
            return null;
          }
          await c.query('COMMIT');
          return seq;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      async snapshot(projectId, seq) {
        await pool.query('INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (project_id, seq) DO NOTHING',
          [projectId, seq, JSON.stringify(createDoc('empty')), E]);
      }
    };
  }

  /** База «круга 22»: только 001 и проект с журналом из n записей без chain. */
  async function oldBase(name, n) {
    const only001 = await migrationsDir((f) => f.startsWith('001_'));
    const old = storageIn(name, { migrationsDir: only001 });
    await old.init();
    const id = (await old.pool.query("INSERT INTO projects (name, kind, engine, head_seq) VALUES ('Старый', 'design', $1, $2) RETURNING id", [E, n])).rows[0].id;
    await old.pool.query('INSERT INTO snapshots (project_id, seq, doc, engine) VALUES ($1, 0, $2::jsonb, $3)', [id, JSON.stringify(createDoc('empty')), E]);
    await old.pool.query(
      `INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, engine)
       SELECT $1, g, 'tx_' || g, g - 1, '[]'::jsonb, $2 FROM generate_series(1, $3::int) g`,
      [id, E, n]
    );
    await old.close();
    return id;
  }

  /** Журнал проекта цел: chain у каждой записи = chainNext предыдущей, head_chain — chain головы. */
  async function assertChain(q, id) {
    const rows = (await q.query('SELECT seq, tx_id, chain FROM operations WHERE project_id = $1 ORDER BY seq', [id])).rows;
    let prev = '';
    for (const [k, r] of rows.entries()) {
      assert.equal(Number(r.seq), k + 1, 'журнал без дыр');
      prev = chainNext(prev, r.tx_id, Number(r.seq));
      assert.equal(r.chain, prev, `chain seq ${r.seq}`);
    }
    const p = (await q.query('SELECT head_seq, head_chain FROM projects WHERE id = $1', [id])).rows[0];
    assert.equal(Number(p.head_seq), rows.length);
    assert.equal(p.head_chain, prev, 'head_chain = chain головы');
    return { head: rows.length, chain: prev };
  }

  it('экземпляр прежней версии пишет без chain во время миграций 002–006 и после: всё проходит, chain у всех записей, «не пусто» проверено', async () => {
    const name = await schema();
    const id = await oldBase(name, 20000);
    const old = oldInstance(name);
    const errors = [];
    let stop = false;
    let written = 0;
    const lat = [];
    const others = [];
    // писатель «старого экземпляра»: пишет в большой проект, заводит новые и пишет в них
    const writer = (async () => {
      for (let k = 0; !stop; k++) {
        const t0 = Date.now();
        try {
          if (k % 40 === 0) others.push(await old.createProject('новый ' + k));
          const target = k % 3 === 0 && others.length ? others[k % others.length] : id;
          const seq = await old.commit(target, `old_${k}`);
          if (seq !== null) written++;
          if (seq !== null && seq % 25 === 0) await old.snapshot(target, seq);
        } catch (e) {
          errors.push(e.message);
        }
        lat.push(Date.now() - t0);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const infos = [];
    const s = storageIn(name, { log: { info: (m) => infos.push(String(m)), warn() {} } });
    try {
      await s.init();
      // и после миграций старый экземпляр продолжает писать
      const after = written;
      await new Promise((r) => setTimeout(r, 300));
      stop = true;
      await writer;
      assert.deepEqual(errors, [], 'старый экземпляр не получил ни одной ошибки');
      assert.ok(written - after > 10, 'писал и после миграций');
      assert.equal((await s.pool.query('SELECT count(*)::int AS n FROM operations WHERE chain IS NULL')).rows[0].n, 0, 'chain у всех записей');
      const c = (await s.pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'operations_chain_present' AND conrelid = 'operations'::regclass")).rows[0];
      assert.equal(c && c.convalidated, true, 'CHECK (chain IS NOT NULL) проверен');
      await assert.rejects(s.pool.query("INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, engine, chain) VALUES ($1, 999999, 'x', 0, '[]', 1, NULL)", [id]), /operations_chain_present|check/i,
        'запись без chain, которую триггер не может досчитать (нет предыдущей), отвергается');
      for (const pid of [id, ...others]) await assertChain(s.pool, pid);
      // снимки старого экземпляра — с chain своей записи; затравка — ''
      assert.equal((await s.pool.query('SELECT count(*)::int AS n FROM snapshots WHERE chain IS NULL')).rows[0].n, 0);
      // проект, заведённый старым экземпляром, знает свою эпоху (project_epochs он не писал)
      const fresh = await s.getProject(others[0]);
      assert.equal(await s.knownEpoch(fresh.id, fresh.epoch), true);
      // новый экземпляр продолжает цепочку старого, старый — нового
      const { head, chain } = await assertChain(s.pool, id);
      const res = await s.commitTx(id, { tx_id: 'tx_new', base_seq: head, ops: [], dropped: [], notes: [], author_kind: 'human', engine: E, command_id: 'cmd_1' },
        { expectSeq: head + 1, expectChain: chainNext(chain, 'tx_new', head + 1) });
      assert.equal(res.status, 'committed');
      assert.equal(res.committed.command_id, 'cmd_1');
      assert.equal(await old.commit(id, 'old_after_new'), head + 2);
      await assertChain(s.pool, id);
      const lock = infos.find((m) => /006: chain/.test(m));
      assert.ok(lock, 'замок 006 назван в логе');
      const ms = Number(/замок (\d+) мс/.exec(lock)[1]);
      assert.ok(ms < 3000, `замок короткий: ${ms} мс`);
      lat.sort((a, b) => a - b);
      assert.ok(lat[lat.length - 1] < 5000, `запись старого экземпляра не стояла долго: max ${lat[lat.length - 1]} мс`);
    } finally {
      stop = true;
      await writer.catch(() => {});
      await old.pool.end();
      await s.close();
    }
  });

  it('006: записи без chain, легшие между заполнением и замком, дозаполняются под коротким замком; писатель ждёт, а не падает', async () => {
    const name = await schema();
    const id = await oldBase(name, 5000);
    const upTo005 = storageIn(name, { migrationsDir: await migrationsDir((f) => !f.startsWith('006_')) });
    await upTo005.init();
    await upTo005.close();
    const old = oldInstance(name);
    // гонка «003 кончилась — триггер ещё видел пустую предыдущую»: хвост без chain
    await admin.query(`ALTER TABLE ${name}.operations DISABLE TRIGGER operations_chain`);
    for (let k = 0; k < 30; k++) await old.commit(id, 'tail_' + k);
    await admin.query(`ALTER TABLE ${name}.operations ENABLE TRIGGER operations_chain`);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${name}.operations WHERE chain IS NULL`)).rows[0].n, 30);
    const errors = [];
    let stop = false;
    let max = 0;
    const writer = (async () => {
      for (let k = 0; !stop; k++) {
        const t0 = Date.now();
        try {
          await old.commit(id, 'w_' + k);
        } catch (e) {
          errors.push(e.message);
        }
        max = Math.max(max, Date.now() - t0);
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const { seal } = await import(pathToFileURL(path.join(MIGRATIONS_DIR, '006_chain_check.mjs')).href);
    const c = new pg.Client({ connectionString: DB_URL, options: `-c search_path=${name}` });
    await c.connect();
    try {
      await new Promise((r) => setTimeout(r, 50));
      const r = await seal(c, { log: quiet });
      assert.ok(r.tail >= 30, `под замком дозаполнено ${r.tail}`);
      assert.ok(r.lockedMs < 2000, `замок ${r.lockedMs} мс`);
      await new Promise((r2) => setTimeout(r2, 100));
      stop = true;
      await writer;
      assert.deepEqual(errors, []);
      assert.ok(max < 3000, `писатель ждал не дольше: ${max} мс`);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM operations WHERE chain IS NULL')).rows[0].n, 0);
      await assertChain(c, id);
      const con = (await c.query("SELECT convalidated FROM pg_constraint WHERE conname = 'operations_chain_present' AND conrelid = 'operations'::regclass")).rows[0];
      assert.equal(con.convalidated, false, 'NOT VALID — проверку всей таблицы делает VALIDATE после замка');
      await c.query('ALTER TABLE operations VALIDATE CONSTRAINT operations_chain_present');
    } finally {
      stop = true;
      await writer.catch(() => {});
      await c.end();
      await old.pool.end();
    }
  });

  it('прерванная миграция (остановка посреди 003) — понятная ошибка; следующий старт продолжает и доводит до конца', async () => {
    const name = await schema();
    const id = await oldBase(name, 60000);
    const first = storageIn(name);
    const run = first.init();
    await waitState(first, (m) => m && m.migration === '003_chain_backfill.mjs' && m.progress && m.progress.done > 0, 'заполнение пошло');
    const progress = first.migrationState.progress;
    assert.equal(progress.total, 60000);
    await first.close();
    await assert.rejects(run, (e) => /003_chain_backfill\.mjs/.test(e.message) && /повторный старт продолжит/.test(e.message));
    const half = (await admin.query(`SELECT count(*) FILTER (WHERE chain IS NULL)::int AS empty, count(*)::int AS n FROM ${name}.operations`)).rows[0];
    assert.ok(half.empty > 0 && half.empty < half.n, `заполнено частично: пусто ${half.empty} из ${half.n}`);
    const applied = (await admin.query(`SELECT name FROM ${name}.schema_migrations`)).rows.map((r) => r.name);
    assert.ok(applied.includes('002_chain_epoch.sql') && !applied.includes('003_chain_backfill.mjs'));
    const second = storageIn(name);
    try {
      await second.init();
      await assertChain(second.pool, id);
    } finally {
      await second.close();
    }
  });

  it('база, где прежняя 004 уже поставила NOT NULL: 005 и 006 ложатся, 006 ничего не перепроверяет', async () => {
    const name = await schema();
    const oldDir = await migrationsDir((f) => /^00[1-3]_/.test(f), {
      '004_traces_notnull.sql': `ALTER TABLE operations ALTER COLUMN chain SET NOT NULL;
        CREATE TABLE IF NOT EXISTS traces (id bigserial PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          command_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), body jsonb NOT NULL);`
    });
    const old = storageIn(name, { migrationsDir: oldDir });
    await old.init();
    // проект — как его создавал экземпляр круга 24 (колонки tombstones ещё нет)
    const p = (await old.pool.query("INSERT INTO projects (name, kind, engine) VALUES ('Круг 24', 'design', $1) RETURNING id", [E])).rows[0];
    await old.pool.query("INSERT INTO snapshots (project_id, seq, doc, engine, chain) VALUES ($1, 0, $2::jsonb, $3, '')", [p.id, JSON.stringify(createDoc('empty')), E]);
    await old.close();
    const s = storageIn(name);
    try {
      await s.init();
      const rows = (await s.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
      assert.ok(rows.includes('005_tombstones_command.sql') && rows.includes('006_chain_check.mjs'));
      assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'operations_chain_present' AND conrelid = 'operations'::regclass")).rows[0].n, 0, 'NOT NULL уже есть — CHECK не нужен');
      const snap = await s.latestSnapshot(p.id);
      assert.deepEqual(snap.tombstones, { v: 2, parents: {}, seq: {} }, 'затравка старого — надгробий нет (известно)');
    } finally {
      await s.close();
    }
  });

  /**
   * Снимки так, как их пишет и читает экземпляр круга 26 (коммит 18c7e4f, storage/pg.js) —
   * дословно его SQL: колонок 007 он не знает.
   */
  function round26(pool) {
    return {
      async writeSnapshot(projectId, seq, chain, tombstones) {
        const res = await pool.query(
          `INSERT INTO snapshots (project_id, seq, doc, engine, chain, tombstones)
           SELECT $1, $2, $3::jsonb, $4, $5, $6::jsonb
            WHERE EXISTS (SELECT 1 FROM operations WHERE project_id = $1 AND seq = $2 AND chain = $5)
           ON CONFLICT (project_id, seq) DO UPDATE SET doc = EXCLUDED.doc, engine = EXCLUDED.engine, chain = EXCLUDED.chain,
                  tombstones = EXCLUDED.tombstones, created_at = now()
            WHERE snapshots.chain IS DISTINCT FROM EXCLUDED.chain`,
          [projectId, seq, JSON.stringify(createDoc('empty')), E, chain, JSON.stringify(tombstones)]
        );
        return res.rowCount > 0;
      },
      async latestSnapshot(projectId) {
        const row = (await pool.query(
          `SELECT s.seq, s.doc, s.engine, s.chain, s.tombstones, s.created_at FROM snapshots s
            WHERE s.project_id = $1
              AND (s.seq = 0 OR EXISTS (SELECT 1 FROM operations o WHERE o.project_id = s.project_id AND o.seq = s.seq AND o.chain = s.chain))
            ORDER BY s.seq DESC LIMIT 1`,
          [projectId]
        )).rows[0];
        // как у круга 26: не объект — {}
        return { seq: Number(row.seq), tombstones: row.tombstones && typeof row.tombstones === 'object' && !Array.isArray(row.tombstones) ? row.tombstones : {} };
      },
      async createProject() {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const id = (await c.query("INSERT INTO projects (name, kind, engine, epoch, epoch_cause) VALUES ('Круг 26', 'design', $1, 'e26', 'init') RETURNING id", [E])).rows[0].id;
          await c.query("INSERT INTO snapshots (project_id, seq, doc, engine, chain) VALUES ($1, 0, $2::jsonb, $3, '')", [id, JSON.stringify(createDoc('empty')), E]);
          await c.query("INSERT INTO project_epochs (project_id, epoch, seq, cause) VALUES ($1, 'e26', 0, 'init')", [id]);
          await c.query('COMMIT');
          return id;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      }
    };
  }

  it('007 при работающем экземпляре круга 26: его снимки (до, во время и после) — надгробия null «неизвестно», снимки нового — v2; он читает у нового v1 (parents)', async () => {
    const name = await schema();
    const upTo006 = storageIn(name, { migrationsDir: await migrationsDir((f) => /^00[1-6]_/.test(f)) });
    await upTo006.init();
    const old = round26(upTo006.pool);
    const id = await old.createProject();
    const chains = [];
    for (let i = 0; i < 8; i++) chains.push((await upTo006.commitTx(id, { tx_id: 't' + i, base_seq: i, ops: [], engine: E })).committed.chain);
    assert.equal(await old.writeSnapshot(id, 1, chains[0], { a: 'r' }), true, 'до миграции');
    // экземпляр круга 26 пишет снимки всё время, пока идут 007/008
    let stop = false;
    const errors = [];
    let writes = 0;
    const writer = (async () => {
      while (!stop) {
        try {
          await old.writeSnapshot(id, 2, chains[1], { b: 'r' });
          await old.latestSnapshot(id);
          writes++;
        } catch (e) {
          errors.push(e.message);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const s = storageIn(name);
    try {
      await s.init();
      await new Promise((r) => setTimeout(r, 50));
      stop = true;
      await writer;
      assert.deepEqual(errors, [], 'экземпляр круга 26 пишет и читает снимки без ошибок');
      assert.ok(writes > 0);
      assert.equal(await old.writeSnapshot(id, 3, chains[2], { c: 'r' }), true, 'после миграции — тоже пишет');
      const col = (await s.pool.query('SELECT seq, tombstones, tombstones_meta, tombstones_chain FROM snapshots WHERE project_id = $1 AND seq = 3', [id])).rows[0];
      assert.deepEqual(col.tombstones, { c: 'r' });
      assert.equal(col.tombstones_chain, null, 'колонки 007 он не знает: NULL');
      assert.equal((await s.latestSnapshot(id)).tombstones, null, 'новый читает «неизвестно»');
      assert.equal((await s.snapshotBefore(id, 4)).seq, 0, 'известные — только у затравки');

      // снимок нового: v2; круг 26 читает из него v1 — надгробия не теряются
      const v2 = { v: 2, parents: { d: 'r', e: null }, seq: { d: 4, e: 3 } };
      assert.equal(await s.writeSnapshot(id, 4, createDoc('empty'), E, chains[3], v2), true);
      assert.deepEqual((await s.latestSnapshot(id)).tombstones, v2, 'новый читает своё значение');
      assert.deepEqual(await old.latestSnapshot(id), { seq: 4, tombstones: { d: 'r', e: null } }, 'круг 26 видит parents (v1)');

      // круг 26 переписывает снимок нового на другой цепочке (журнал под seq 5 сменился после отката)
      assert.equal(await s.writeSnapshot(id, 5, createDoc('empty'), E, chains[4], v2), true);
      await s.pool.query("UPDATE operations SET chain = 'после отката' WHERE project_id = $1 AND seq = 5", [id]);
      assert.equal(await old.writeSnapshot(id, 5, 'после отката', { f: 'r' }), true);
      const s5 = await s.latestSnapshot(id);
      assert.equal(s5.seq, 5);
      assert.equal(s5.tombstones, null, 'надгробия нового от прежней цепочки не приписываются чужому снимку');

      // экземпляр до круга 25 колонку tombstones не пишет: умолчание теперь NULL — «неизвестно», не «пусто»
      await s.pool.query('INSERT INTO snapshots (project_id, seq, doc, engine, chain) VALUES ($1, 6, $2::jsonb, $3, $4)', [id, JSON.stringify(createDoc('empty')), E, chains[5]]);
      assert.equal((await s.pool.query('SELECT tombstones FROM snapshots WHERE project_id = $1 AND seq = 6', [id])).rows[0].tombstones, null);
      assert.equal((await s.latestSnapshot(id)).tombstones, null);
      assert.deepEqual(await old.latestSnapshot(id), { seq: 6, tombstones: {} }, 'круг 26 читает NULL как {} — как прежде');

      const before = await s.snapshotBefore(id, 7);
      assert.equal(before.seq, 4, 'ближайший раньше с известными надгробиями');
      assert.deepEqual(before.tombstones, v2);
    } finally {
      stop = true;
      await writer;
      await s.close();
      await upTo006.close();
    }
  });

  it('008: индекс (updated_at DESC, id DESC) — страница списка идёт по нему; недостроенный (INVALID) строится заново', async () => {
    const name = await schema();
    const upTo007 = storageIn(name, { migrationsDir: await migrationsDir((f) => /^00[1-7]_/.test(f)) });
    await upTo007.init();
    for (let i = 0; i < 3; i++) await upTo007.createProject({ name: 'p' + i, kind: 'design', doc: createDoc('empty'), engine: E });
    // прерванный CONCURRENTLY: UNIQUE на повторяющихся значениях падает и оставляет индекс INVALID
    await assert.rejects(upTo007.pool.query('CREATE UNIQUE INDEX CONCURRENTLY projects_updated_id ON projects (kind)'), /could not create unique index|duplicate/);
    const valid = async (q) => (await q.query(
      `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'projects'::regclass AND c.relname = 'projects_updated_id'`)).rows[0];
    assert.equal((await valid(upTo007.pool)).indisvalid, false);
    await upTo007.close();
    const lines = [];
    const s = storageIn(name, { log: { info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)) } });
    try {
      await s.init();
      const idx = await valid(s.pool);
      assert.equal(idx.indisvalid, true);
      assert.match(idx.def, /\(updated_at DESC, id DESC\)/);
      assert.ok(lines.some((l) => /008.*INVALID/.test(l)), lines.join('\n'));
      // план страницы с курсором: индекс, без сортировки всей таблицы
      for (let i = 0; i < 300; i++) await s.createProject({ name: 'q' + i, kind: i % 2 ? 'design' : 'library', doc: {}, engine: E });
      await s.pool.query('ANALYZE projects');
      const page = await s.listProjectsPage({ limit: 50 });
      const c = await s.pool.connect();
      try {
        await c.query('SET enable_seqscan = off');
        const plan = (await c.query(
          `EXPLAIN SELECT * FROM projects WHERE (updated_at, id) < ($1::timestamptz, $2::uuid) ORDER BY updated_at DESC, id DESC LIMIT 51`,
          [page.next.at, page.next.id]
        )).rows.map((r) => r['QUERY PLAN']).join('\n');
        assert.match(plan, /Index Scan using projects_updated_id/, plan);
        assert.doesNotMatch(plan, /Sort/, plan);
      } finally {
        c.release();
      }
    } finally {
      await s.close();
    }
  });

  it('008, когда замок миграций ждёт экземпляр прежней версии (pg_advisory_lock со снимком): не CONCURRENTLY — без взаимной блокировки', async () => {
    const name = await schema();
    let waiter = null;
    let waiting = null;
    globalThis.__imagoStartWaiter = async () => {
      waiter = new pg.Client({ connectionString: DB_URL });
      await waiter.connect();
      waiting = waiter.query('SELECT pg_advisory_lock(728208)');   // как экземпляр круга 26 на старте
      for (let i = 0; i < 200; i++) {
        const n = (await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = 728208`)).rows[0].n;
        if (n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('ждущий замок не появился');
    };
    const dir = await migrationsDir(() => true, {
      '007_zz_waiter.mjs': 'export async function up() { await globalThis.__imagoStartWaiter(); }'
    });
    const lines = [];
    const s = storageIn(name, { migrationsDir: dir, log: { info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)) } });
    try {
      const t0 = Date.now();
      await s.init();
      assert.ok(Date.now() - t0 < 20000);
      assert.ok(lines.some((l) => /008: индекс .* построен .*обычный: замок миграций ждут 1/.test(l)), lines.join('\n'));
      await waiting;   // ждущий получил замок после миграций, а не упал на 40P01
      await waiter.query('SELECT pg_advisory_unlock(728208)');
    } finally {
      delete globalThis.__imagoStartWaiter;
      if (waiter) await waiter.end().catch(() => {});
      await s.close();
    }
  });

  /** Чтение журнала круга 28 (до 009) дословно: окно — по jsonb, явный список колонок. */
  const OLD_COLUMNS = 'project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, command_id, engine, chain, created_at';
  const round28TxsAfter = async (pool, projectId, seq, limit, maxBytes) => (await pool.query(
    `SELECT ${OLD_COLUMNS} FROM (
       SELECT l.*,
              row_number() OVER (ORDER BY l.seq) AS rn,
              sum(octet_length(l.ops::text) + octet_length(l.dropped::text)) OVER (ORDER BY l.seq ROWS UNBOUNDED PRECEDING) AS run_bytes
         FROM (SELECT ${OLD_COLUMNS} FROM operations WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3) l
     ) t WHERE rn = 1 OR run_bytes <= $4 ORDER BY seq`,
    [projectId, seq, limit, maxBytes]
  )).rows.map((r) => r.seq);

  it('009: вес и число операций — дозаполнение пачками при пишущем экземпляре прежней версии; его записи после — триггером; его чтение журнала работает', async () => {
    const name = await schema();
    const upTo008 = storageIn(name, { migrationsDir: await migrationsDir((f) => /^00[1-8]_/.test(f)) });
    await upTo008.init();
    // commitTx этого круга пишет те же колонки, что и круг 28 (ops_bytes/ops_count не передаёт)
    const p = await upTo008.createProject({ name: 'Вес', kind: 'design', doc: createDoc('empty'), engine: E });
    const big = 'ж'.repeat(3000);
    const dropped = [{ index: 0, reason: 'invalid', op: { op: 'remove', id: 'x' } }, { more: 4 }];
    for (let i = 0; i < 40; i++) {
      const list = Array.from({ length: i % 4 }, (_, k) => ({ op: 'set', id: 'n' + k, path: 'name', value: i % 7 === 0 ? big : 'v' + i }));
      await upTo008.commitTx(p.id, { tx_id: 'old' + i, base_seq: i, ops: list, dropped: i % 5 === 0 ? dropped : [], engine: E });
    }
    // экземпляр прежней версии пишет всё время, пока идёт 009
    let stop = false;
    const errors = [];
    let writes = 0;
    const writer = (async () => {
      while (!stop) {
        try {
          const head = (await upTo008.getProject(p.id)).head_seq;
          await upTo008.commitTx(p.id, { tx_id: 'w' + writes, base_seq: head, ops: [{ op: 'set', id: 'n0', path: 'name', value: 'w' }], engine: E });
          writes++;
        } catch (e) {
          errors.push(e.message);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const s = storageIn(name);
    try {
      await s.init();
      await new Promise((r) => setTimeout(r, 50));
      stop = true;
      await writer;
      assert.deepEqual(errors, [], 'прежний экземпляр пишет без ошибок');
      assert.ok(writes > 0);
      const after = 'after';
      await upTo008.commitTx(p.id, { tx_id: after, base_seq: 0, ops: [{ op: 'set', id: 'n0', path: 'name', value: big }, { op: 'remove', id: 'n1' }], engine: E });
      const check = async () => (await s.pool.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE ops_bytes IS DISTINCT FROM octet_length(ops::text) + octet_length(dropped::text))::int AS bad_bytes,
                count(*) FILTER (WHERE ops_count IS DISTINCT FROM jsonb_array_length(ops))::int AS bad_count
           FROM operations WHERE project_id = $1`, [p.id])).rows[0];
      const c = await check();
      assert.equal(c.n, 41 + writes);
      assert.equal(c.bad_bytes, 0, 'вес у всех записей — до, во время и после миграции');
      assert.equal(c.bad_count, 0, 'число операций — тоже');
      const last = (await s.pool.query('SELECT ops_bytes, ops_count FROM operations WHERE project_id = $1 AND tx_id = $2', [p.id, after])).rows[0];
      assert.equal(last.ops_count, 2);
      assert.ok(last.ops_bytes > 6000, 'кириллица — байтами UTF-8: ' + last.ops_bytes);
      // экземпляр этой версии передаёт вес сам — байты своего JSON (как память), близко к jsonb::text
      const mine = { op: 'set', id: 'n0', path: 'name', value: big };
      const head = (await s.getProject(p.id)).head_seq;
      const own = await s.commitTx(p.id, { tx_id: 'own', base_seq: head, ops: [mine, { op: 'remove', id: 'n1' }], dropped, engine: E });
      const ownRow = (await s.pool.query(
        'SELECT ops_bytes, ops_count, octet_length(ops::text) + octet_length(dropped::text) AS pg_bytes FROM operations WHERE project_id = $1 AND seq = $2', [p.id, own.committed.seq])).rows[0];
      assert.equal(ownRow.ops_bytes, Buffer.byteLength(JSON.stringify([mine, { op: 'remove', id: 'n1' }])) + Buffer.byteLength(JSON.stringify(dropped)));
      assert.equal(ownRow.ops_count, 2);
      assert.ok(Math.abs(ownRow.ops_bytes - ownRow.pg_bytes) / ownRow.pg_bytes < 0.1, `меры близки: ${ownRow.ops_bytes} и ${ownRow.pg_bytes}`);
      await s.pool.query('DELETE FROM operations WHERE project_id = $1 AND tx_id = $2', [p.id, 'own']);
      await s.pool.query('UPDATE projects SET head_seq = head_seq - 1 WHERE id = $1', [p.id]);

      // страница журнала: новый режет по колонке так же, как круг 28 по jsonb
      for (const [since, lim, bytes] of [[0, 500, 2e6], [0, 500, 20000], [0, 500, 1], [5, 7, 1e9], [10, 500, 9000]]) {
        assert.deepEqual((await s.txsAfter(p.id, since, lim, { maxBytes: bytes })).map((t) => t.seq), await round28TxsAfter(s.pool, p.id, since, lim, bytes), `since ${since} limit ${lim} maxBytes ${bytes}`);
      }
      const meta = await s.recentTxMeta(p.id, { limit: 200 });
      const m0 = meta.find((t) => t.tx_id === 'old0');
      assert.deepEqual({ ops_count: m0.ops_count, dropped_count: m0.dropped_count }, { ops_count: 0, dropped_count: 5 });
      assert.equal(meta.find((t) => t.tx_id === 'old3').ops_count, 3);

      // дозаполнение пачками (ключом по первичному индексу) — с прерванного места
      await s.pool.query('UPDATE operations SET ops_bytes = NULL, ops_count = NULL WHERE project_id = $1 AND seq % 3 = 0', [p.id]);
      const { backfill } = await import(pathToFileURL(path.join(MIGRATIONS_DIR, '009_ops_size.mjs')).href);
      const client = new pg.Client({ connectionString: DB_URL, options: `-c search_path=${name}` });
      await client.connect();
      try {
        const batches = [];
        const n = await backfill(client, { batch: 10, onBatch: (u, seen) => batches.push(seen) });
        assert.equal(n, Math.floor((41 + writes) / 3));
        assert.ok(batches.length >= 2, 'несколько пачек: ' + batches.join(','));
        assert.equal(await backfill(client, { batch: 10 }), 0, 'повтор — нечего считать');
        let stopped = 0;
        await s.pool.query('UPDATE operations SET ops_bytes = NULL WHERE project_id = $1', [p.id]);
        await assert.rejects(backfill(client, { batch: 10, closing: () => stopped++ > 1 }), /остановка/);
        assert.ok(Number((await s.pool.query('SELECT count(*) FROM operations WHERE project_id = $1 AND ops_bytes IS NULL', [p.id])).rows[0].count) > 0, 'прерванное — не всё');
        await backfill(client, { batch: 10 });
      } finally {
        await client.end();
      }
      const c2 = await check();
      assert.equal(c2.bad_bytes + c2.bad_count, 0);

      // запись без веса (если бы такая нашлась) — страница считает его из jsonb, а не ломается
      await s.pool.query('ALTER TABLE operations DISABLE TRIGGER operations_size');
      await s.pool.query("INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, engine, chain) VALUES ($1, 100000, 'raw', 0, $2::jsonb, $3, 'x')", [p.id, JSON.stringify([{ op: 'remove', id: 'z' }]), E]);
      await s.pool.query('ALTER TABLE operations ENABLE TRIGGER operations_size');
      assert.deepEqual((await s.txsAfter(p.id, 99999, 10)).map((t) => t.tx_id), ['raw']);
      assert.equal((await s.recentTxMeta(p.id, { limit: 1 }))[0].ops_count, 1);
    } finally {
      stop = true;
      await writer;
      await s.close();
      await upTo008.close();
    }
  });

  it('DDL миграции не стоит в очереди за долгой транзакцией: lock_timeout и повтор — читатели ждут не дольше lock_timeout', async () => {
    const name = await schema();
    const base = storageIn(name);
    await base.init();
    await base.close();
    const holder = new pg.Client({ connectionString: DB_URL, options: `-c search_path=${name}` });
    const reader = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${name}`, max: 1 });
    await holder.connect();
    try {
      // долгая транзакция держит ACCESS SHARE на operations 2,5 с
      await holder.query('BEGIN');
      await holder.query('SELECT count(*) FROM operations');
      const released = new Promise((r) => setTimeout(r, 2500)).then(() => holder.query('COMMIT'));
      let stop = false;
      let max = 0;
      const probe = (async () => {
        while (!stop) {
          const t0 = Date.now();
          await reader.query('SELECT count(*) FROM operations');
          max = Math.max(max, Date.now() - t0);
          await new Promise((r) => setTimeout(r, 10));
        }
      })();
      const dir = await migrationsDir(undefined, { '950_alter.sql': 'ALTER TABLE operations ADD COLUMN IF NOT EXISTS extra int;' });
      const warns = [];
      const s = storageIn(name, { migrationsDir: dir, migrationLockTimeoutMs: 300, log: { info() {}, warn: (m) => warns.push(String(m)) } });
      try {
        const t0 = Date.now();
        await s.init();
        assert.ok(Date.now() - t0 >= 2000, 'ALTER дождался конца долгой транзакции');
        assert.ok(warns.some((m) => /950_alter\.sql: замок таблицы занят/.test(m)), 'повтор назван в логе');
        await s.pool.query('SELECT extra FROM operations LIMIT 1');
      } finally {
        stop = true;
        await probe;
        await released;
        await s.close();
      }
      assert.ok(max < 1500, `читатель не стоял за ALTER всю долгую транзакцию: max ${max} мс`);
    } finally {
      await holder.end();
      await reader.end();
    }
  });

  it('порт открыт во время миграций: /api/health и маршруты — 503 migrating с прогрессом, сокет — 503; после — обычная работа', async () => {
    const name = await schema();
    const dir = await migrationsDir(undefined, {
      '900_slow.mjs': `export async function up(ctx) {
        for (let i = 1; i <= 15; i++) { ctx.progress({ done: i, total: 15 }); await new Promise((r) => setTimeout(r, 100)); }
      }`
    });
    const l = await launch({ port: 0, storage: storageIn(name, { migrationsDir: dir }), pingInterval: 0, log: quiet });
    try {
      const http = api(l.url);
      let h;
      for (;;) {
        h = await http.get('/api/health');
        if (h.status === 503 && h.body.detail && h.body.detail.migration === '900_slow.mjs' && h.body.detail.progress) break;
        assert.equal(h.status, 503, 'до готовности — только 503');
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(h.body.code, 'migrating');
      assert.equal(h.body.retryable, true);
      assert.equal(h.body.detail.progress.total, 15);
      assert.ok(Number(h.headers.get('retry-after')) > 0);
      const list = await http.get('/api/projects');
      assert.equal(list.status, 503);
      assert.equal(list.body.code, 'migrating');
      assert.ok(Number(list.headers.get('retry-after')) > 0);
      assert.equal((await http.post('/api/projects', { name: 'рано' })).status, 503);
      const ws = new WebSocket(l.url.replace('http', 'ws') + '/ws?project=x');
      const status = await new Promise((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
        ws.on('open', () => resolve('open'));
        ws.on('error', () => resolve('error'));
      });
      assert.equal(status, 503, 'сокет до готовности — 503 на upgrade');
      assert.equal(l.state, 'starting');
      const svc = await l.ready;
      assert.equal(l.state, 'ready');
      const ok = await http.get('/api/health');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      const created = await http.post('/api/projects', { name: 'после' });
      assert.equal(created.status, 201);
      assert.equal(svc.port, l.port);
    } finally {
      await l.close();
    }
  });

  it('остановка (SIGTERM) посреди миграций: close() обрывает их сразу, ready отвергается, порт закрыт', async () => {
    const name = await schema();
    const dir = await migrationsDir(undefined, { '900_sleep.sql': 'SELECT pg_sleep(30);' });
    const l = await launch({ port: 0, storage: storageIn(name, { migrationsDir: dir }), pingInterval: 0, log: quiet });
    await waitState(l.storage, (m) => m && m.migration === '900_sleep.sql', '900 пошла');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await l.close();
    assert.ok(Date.now() - t0 < 5000, 'не ждали конца миграции');
    await assert.rejects(l.ready);
    const rows = (await admin.query(`SELECT name FROM ${name}.schema_migrations`)).rows.map((r) => r.name);
    assert.ok(!rows.includes('900_sleep.sql'), 'оборванная миграция не записана — следующий старт её повторит');
    await assert.rejects(fetch(l.url + '/api/health'));
  });

  /** Ждать состояния миграций хранилища. */
  async function waitState(storage, pred, what, ms = 20000) {
    const until = Date.now() + ms;
    while (!pred(storage.migrationState)) {
      if (Date.now() > until) throw new Error('не дождались: ' + what);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
});
