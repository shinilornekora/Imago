/**
 * Миграции Document service (SPEC §9.8): нумерованные файлы, schema_migrations,
 * каждая — своя транзакция, под advisory-lock, без дедлайна обычных запросов;
 * заполнение chain у старого журнала пачками. Только Postgres; каждый прогон — в
 * своей схеме (search_path), чтобы не трогать таблицы других тестов.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDoc, ENGINE_VERSION as E } from '../../src/core.js';
import { createPgStorage, MIGRATIONS_DIR } from '../../server/document/storage/pg.js';
import { chainNext } from '../../server/document/storage/committed.js';
import { pgAvailable, DB_URL, quiet } from './helpers.mjs';

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
      assert.ok(rows.includes('004_traces_notnull.sql'), 'предыдущие легли — каждая своей транзакцией');
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
});
