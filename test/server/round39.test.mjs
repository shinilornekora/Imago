/**
 * Круг 39 — Document service и хранилище (перенос и проверка частичной работы круга 35 + новое):
 *   N1) версия формата движка: запись журнала или снимок движка новее экземпляра — не пропускаются:
 *       проект на этом экземпляре «устарел» (503 cause:'engine' на чтение и запись, голова не держится,
 *       снимков не пишет, в лог — одна строка); голова, где запись не применилась, снимков не пишет;
 *       два экземпляра разных версий на одной базе; база не принимает снимок старше записей под ним (014);
 *   N2) предел раскрытия экземпляров: транзакция сверх предела — dropped invalid/expand_nodes, импорт — 400;
 *   N4а) восстановление «в ту же базу» под записью (pg_restore и psql < dump.sql): пока база пуста или в
 *       неё идёт восстановление, ЛЮБОЙ запрос к хранилищу — 503 schema; «устоялась» — с ключами,
 *       триггерами и без чужого COPY; pg_restore/psql — без ошибок, первичные ключи на месте;
 *   N4б) дозаполнение 009 ведёт другой экземпляр — второй здоров (health 200, backfill.by) и замка не
 *       ждёт; тот умер посреди — второй дозаполняет сам; на старте процесса — DDL сразу, дозаполнение фоном;
 *   N4в) бюджет тел записи — по прочитанным байтам; молчащее тело — 408 через 5 с (первый байт);
 *   N4г) create_id с другим телом — 409 {code:'conflict', detail:{cause:'create_id'}} (013);
 *   N4д) бюджет голов считает выжимки последних транзакций и надгробия, а не только документ;
 *   N4е) мутанты R02 (очередь пула импорта), R03 (упавший поток), R08 (частота присутствия),
 *       R19 (кеш снимков по времени) — тесты, которые их ловят.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, copyFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import * as core from '../../src/core.js';
import { uid, ENGINE_VERSION, createDoc } from '../../src/core.js';
import { MIGRATIONS_DIR, FILL_BY_OTHER } from '../../server/document/storage/pg.js';
import { CODE_ENGINE, ENGINE_MIN_READ } from '../../server/document/engine.js';
import { createHashOf } from '../../server/document/importer.js';
import { createImportPool } from '../../server/document/import-pool.js';
import { tombstonesV2 } from '../../server/document/dslts.js';
import { start } from '../../server/document/index.js';
import { backends, startFor, startTwin, api, connect, wsUrl, waitFor, pgAvailable, pgStorage, DB_URL, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });

const list = await backends();
const pgOk = await pgAvailable();
const has = (cmd) => spawnSync(cmd, ['--version']).status === 0;
const tools = has('pg_dump') && has('pg_restore') && has('psql') && has('dropdb') && has('createdb');

/** Внешняя команда — асинхронно: сервис в этом же процессе должен отвечать, пока она идёт. */
function run(cmd, args, env) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    ch.on('error', (e) => resolve({ code: -1, out: String(e && e.message) }));
    ch.on('exit', (code) => resolve({ code, out }));
  });
}

/* ------------------------------ 1. восстановление под записью ------------------------------ */

describe('круг 39: восстановление в ту же базу под записью — запросы ждут (503 schema), восстановление без ошибок · pg', { skip: pgOk && tools ? false : 'нет базы или pg_dump/pg_restore/psql' }, () => {
  const TOKEN = 'token-round35-restore';

  /** Нагрузка: транзакция, новый проект и трасса — по кругу, каждый ответ с временем. */
  function load(h, P, root) {
    const events = [];
    let stop = false;
    const loop = (async () => {
      let n = 0;
      while (!stop) {
        const t0 = Date.now();
        const reqs = [
          h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'w' + (n++) }])),
          h.post('/api/projects', { name: 'во время восстановления' }),
          h.post('/api/internal/traces', { project: P, command_id: 'cmd_load', stages: [] }, { 'x-internal-token': TOKEN })
        ];
        const rs = await Promise.all(reqs.map((p) => p.catch((e) => ({ status: 0, body: null, text: String(e && e.message) }))));
        const t1 = Date.now();
        rs.forEach((r, i) => events.push({ kind: ['tx', 'create', 'trace'][i], t0, t1, status: r.status, cause: r.body && r.body.detail ? r.body.detail.cause : undefined, text: r.text }));
        await sleep(25);
      }
    })();
    return { events, stop: async () => { stop = true; await loop; } };
  }

  /** Сервис над базой файла, проект со снимками и трассами, копия базы. */
  async function prepare(format) {
    const storage = pgStorage({ listenRetryMs: 50 });
    const svc = await start({ port: 0, storage, snapshotEvery: 5, pingInterval: 0, log: quiet, verifyMs: 0, internalToken: TOKEN });
    await storage.pool.query('TRUNCATE projects, operations, snapshots, project_epochs, traces CASCADE');
    const h = api(svc.url);
    const P = (await h.post('/api/projects', { name: 'копия', demo: true })).body.id;
    const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
    for (let i = 0; i < 12; i++) assert.equal((await h.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'в копии ' + i }]))).status, 201);
    for (let i = 0; i < 5; i++) assert.equal((await h.post('/api/internal/traces', { project: P, command_id: 'cmd_' + i, stages: [] }, { 'x-internal-token': TOKEN })).status, 201);
    await waitFor(async () => (await storage.snapshotSeqs(P)).includes(10), 'снимки записаны', 10000);
    const url = new URL(DB_URL);
    const db = url.pathname.slice(1);
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
    delete env.NODE_OPTIONS;
    const conn = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-restore35-'));
    const dump = path.join(dir, format === 'plain' ? 'backup.sql' : 'backup.dump');
    const d = await run('pg_dump', [...conn, format === 'plain' ? '-Fp' : '-Fc', '-f', dump, db], env);
    assert.equal(d.code, 0, d.out);
    return { svc, storage, h, P, root, db, env, conn, dump };
  }

  /** Окно восстановления: ни одного 2xx; отказы — 503 (schema; в миг dropdb — storage); schema — было. */
  function checkWindow(events, from, to) {
    const inside = events.filter((e) => e.t0 >= from && e.t1 <= to);
    assert.ok(inside.length >= 6, 'нагрузка шла во время восстановления: ' + inside.length);
    const ok = inside.filter((e) => e.status >= 200 && e.status < 300);
    assert.deepEqual(ok.map((e) => `${e.kind} ${e.status}`), [], 'во время восстановления в базу не пишет никто');
    const bad = inside.filter((e) => !(e.status === 503 && (e.cause === 'schema' || e.cause === 'storage')));
    assert.deepEqual(bad.map((e) => `${e.kind} ${e.status} ${e.text.slice(0, 120)}`), [], 'отказы — 503 schema');
    for (const kind of ['tx', 'create', 'trace']) {
      assert.ok(inside.some((e) => e.kind === kind && e.status === 503 && e.cause === 'schema'), `${kind}: 503 schema`);
    }
  }

  async function checkAfter(db, P, h) {
    const probe = new pg.Client({ connectionString: DB_URL });
    await probe.connect();
    try {
      const keys = (await probe.query(
        `SELECT string_agg(conrelid::regclass::text, ',' ORDER BY conrelid::regclass::text) AS t FROM pg_constraint
          WHERE contype = 'p' AND conrelid::regclass::text IN ('traces', 'operations', 'snapshots', 'projects', 'project_epochs', 'schema_migrations')`
      )).rows[0].t;
      assert.equal(keys, 'operations,project_epochs,projects,schema_migrations,snapshots,traces', 'первичные ключи на месте');
      const tr = (await probe.query('SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM traces')).rows[0];
      assert.equal(tr.n, tr.d, 'трассы без дублей');
      const names = (await probe.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3,}_/.test(f)).sort();
      assert.deepEqual(names, files, 'учёт миграций — ровно каталог');
      const dup = (await probe.query('SELECT count(*)::int AS n FROM (SELECT project_id, seq FROM operations GROUP BY 1, 2 HAVING count(*) > 1) x')).rows[0].n;
      assert.equal(dup, 0);
    } finally {
      await probe.end();
    }
    const opened = await h.get(`/api/projects/${P}`);
    assert.equal(opened.status, 200, opened.text);
    assert.ok(opened.body.head_seq >= 12);
  }

  it('dropdb; createdb; pg_restore — под нагрузкой: pg_restore с кодом 0, в окне — только 503 schema, после — ключи и запись', async () => {
    const { svc, h, P, root, db, env, conn, dump } = await prepare('custom');
    let L = null;
    try {
      L = load(h, P, root);
      await sleep(300);
      const drop = await run('dropdb', [...conn, '--force', db], env);
      assert.equal(drop.code, 0, drop.out);
      const created = await run('createdb', [...conn, db], env);
      assert.equal(created.code, 0, created.out);
      const from = Date.now();
      await sleep(700);   // пустая база под нагрузкой
      const res = await run('pg_restore', [...conn, '-d', db, dump], env);
      const to = Date.now();
      assert.equal(res.code, 0, 'pg_restore без ошибок: ' + res.out);
      assert.doesNotMatch(res.out, /error/i);
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'после pg_restore — здоров', 20000);
      await sleep(300);
      await L.stop();
      checkWindow(L.events, from, to);
      assert.ok(L.events.some((e) => e.kind === 'tx' && e.status === 201 && e.t0 > to), 'после восстановления запись идёт');
      await checkAfter(db, P, h);
    } finally {
      if (L) await L.stop();
      await svc.close();
    }
  });

  it('psql < dump.sql с долгим COPY посреди (учёт миграций уже лёг, ключей ещё нет) — в окне только 503 schema, psql без ошибок', async () => {
    const { svc, h, P, root, db, env, conn, dump } = await prepare('plain');
    let L = null;
    try {
      // окно критика: учёт миграций уже в базе, таблицы без ключей, psql «думает» перед COPY снимков
      const sql = await readFile(dump, 'utf8');
      assert.ok(/^COPY public\.snapshots /m.test(sql), 'в копии есть COPY снимков');
      await writeFile(dump, sql.replace(/^COPY public\.snapshots /m, 'SELECT pg_sleep(1.5);\nCOPY public.snapshots '));
      L = load(h, P, root);
      await sleep(300);
      assert.equal((await run('dropdb', [...conn, '--force', db], env)).code, 0);
      assert.equal((await run('createdb', [...conn, db], env)).code, 0);
      const from = Date.now();
      await sleep(500);
      const res = await run('psql', [...conn, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', dump], env);
      const to = Date.now();
      assert.equal(res.code, 0, 'psql без ошибок: ' + res.out);
      assert.doesNotMatch(res.out, /ERROR|ОШИБКА/);
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'после psql — здоров', 20000);
      await sleep(300);
      await L.stop();
      checkWindow(L.events, from, to);
      await checkAfter(db, P, h);
    } finally {
      if (L) await L.stop();
      await svc.close();
    }
  });
});

describe('круг 39: фаза restore без пересоздания базы — каждый запрос к хранилищу 503 schema · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  it('к базе подключён pg_restore: транзакция, новый проект, трасса, список, открытие — 503 schema, в базу не пишется; отключился — запись идёт', async () => {
    const svc = await startFor('pg', { verifyMs: 0, internalToken: 'token-round35-phase' });
    const restorer = new pg.Client({ connectionString: DB_URL, application_name: 'pg_restore' });
    const admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'до' })).body.id;
      const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
      await restorer.connect();
      // переподключение слушателя (восстановление рвёт соединения) — сверка находит pg_restore
      await admin.query('SELECT pg_terminate_backend($1)', [svc.storage.listenerPid]);
      await waitFor(async () => (await h.get('/api/health')).status === 503, 'фаза restore', 10000);
      const before = (await admin.query('SELECT (SELECT count(*) FROM projects)::int AS p, (SELECT count(*) FROM traces)::int AS t, (SELECT count(*) FROM operations)::int AS o')).rows[0];
      const rs = await Promise.all([
        h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }])),
        h.post('/api/projects', { name: 'во время' }),
        h.post('/api/internal/traces', { project: P, command_id: 'cmd_x', stages: [] }, { 'x-internal-token': 'token-round35-phase' }),
        h.get('/api/projects'),
        h.get(`/api/projects/${P}?lean=1`),
        h.get(`/api/projects/${P}/ops?since=0`)
      ]);
      for (const r of rs) {
        assert.equal(r.status, 503, r.text);
        assert.equal(r.body.detail.cause, 'schema', r.text);
        assert.equal(r.body.detail.phase, 'restore');
      }
      const after = (await admin.query('SELECT (SELECT count(*) FROM projects)::int AS p, (SELECT count(*) FROM traces)::int AS t, (SELECT count(*) FROM operations)::int AS o')).rows[0];
      assert.deepEqual(after, before, 'в базу во время восстановления не пишется');
      await restorer.end();
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'pg_restore отключился — здоров', 15000);
      const w = await h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'после' }]));
      assert.equal(w.status, 201, w.text);
    } finally {
      await restorer.end().catch(() => {});
      await admin.end();
      await svc.close();
    }
  });
});

/* ------------------------------ 2. дозаполнение другого экземпляра ------------------------------ */

const DRIFT = `DROP TRIGGER IF EXISTS operations_size ON operations;
  ALTER TABLE operations DROP COLUMN IF EXISTS command_author, DROP COLUMN IF EXISTS ops_bytes, DROP COLUMN IF EXISTS ops_count, DROP COLUMN IF EXISTS undo_part;
  DELETE FROM schema_migrations WHERE name IN ('009_ops_size.mjs', '010_command_author.sql', '011_undo_part.sql')`;

describe('круг 39: дозаполнение 009 ведёт другой экземпляр — второй здоров и замка не ждёт · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  let admin;
  let dir;
  before(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 3 });
    // каталог миграций, где дозаполнение 009 ждёт сигнала теста (долгое дозаполнение)
    dir = await mkdtemp(path.join(os.tmpdir(), 'imago-mig35-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (f !== '009_ops_size.mjs') await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const real = pathToFileURL(path.join(MIGRATIONS_DIR, '009_ops_size.mjs')).href;
    await writeFile(path.join(dir, '009_ops_size.mjs'), `export * from ${JSON.stringify(real)};
import { ddlUp, fillUp as realFill } from ${JSON.stringify(real)};
export async function fillUp(ctx) { await (globalThis.__imagoFillGate35 || Promise.resolve()); return realFill(ctx); }
export async function up(ctx) { await ddlUp(ctx); await fillUp(ctx); }
`);
  });
  after(async () => {
    globalThis.__imagoFillGate35 = undefined;
    await admin.end();
  });
  const gate = () => {
    let open;
    globalThis.__imagoFillGate35 = new Promise((r) => { open = r; });
    return open;
  };
  const count009 = async () => (await admin.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = '009_ops_size.mjs'")).rows[0].n;

  it('сверка: A дозаполняет — B health 200 {backfill.by}, пишет с command_author; A закончил — B видит; A умер посреди — B дозаполняет сам', { timeout: 90000 }, async () => {
    let open = null;
    const A = await startFor('pg', { verifyMs: 0 }, { migrationsDir: dir });
    const B = await startTwin('pg', A, { verifyMs: 0 }, { migrationsDir: dir });
    try {
      const hA = api(A.url);
      const hB = api(B.url);
      const p = (await hA.post('/api/projects', { name: 'двое' })).body;
      const root = (await hA.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      await admin.query(DRIFT);
      open = gate();
      A.storage.recheckSchema('тест: A').catch(() => {});
      await waitFor(() => A.storage.backfillState && A.storage.migrationState && A.storage.migrationState.phase === 'fill', 'A дозаполняет', 10000);
      const t0 = Date.now();
      // не дольше 5 с: регрессия (B ждёт замка всё дозаполнение) — провал, а не зависание
      await Promise.race([B.storage.recheckSchema('тест: B'), sleep(5000)]);
      assert.ok(Date.now() - t0 < 3000, `B не ждал замка: ${Date.now() - t0} мс`);
      assert.equal(B.storage.schemaState, null);
      assert.equal(B.storage.backfillState.by, FILL_BY_OTHER);
      assert.equal(B.storage.schemaFlags.commandAuthor, true);
      const hb = await hB.get('/api/health');
      assert.equal(hb.status, 200, hb.text);
      assert.equal(hb.body.detail.backfill.migration, '009_ops_size.mjs');
      assert.equal(hb.body.detail.backfill.by, FILL_BY_OTHER);
      const ha = await hA.get('/api/health');
      assert.equal(ha.status, 200, ha.text);
      assert.equal(ha.body.detail.backfill.by, undefined, 'A ведёт сам');
      const w = await hB.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'b' }], { author_kind: 'agent', command_author: 'Аня', undo_of: 'tx_u', undo_part: { i: 0, n: 2 } }));
      assert.equal(w.status, 201, w.text);
      assert.equal(w.body.command_author, 'Аня');
      assert.deepEqual(w.body.undo_part, { i: 0, n: 2 });
      open();
      await waitFor(async () => (await hB.get('/api/health')).body.detail === undefined && B.storage.backfillState === null, 'B увидел конец дозаполнения', 15000);
      assert.equal(await count009(), 1);

      // A умирает посреди дозаполнения — B берёт замок и дозаполняет сам
      await admin.query(DRIFT);
      open = gate();
      A.storage.recheckSchema('тест: A снова').catch(() => {});
      await waitFor(() => A.storage.migrationState && A.storage.migrationState.phase === 'fill', 'A дозаполняет снова', 10000);
      await Promise.race([B.storage.recheckSchema('тест: B снова'), sleep(5000)]);
      assert.equal(B.storage.backfillState.by, FILL_BY_OTHER);
      await A.close();
      await waitFor(async () => {
        await hB.get('/api/health');
        return B.storage.backfillState && !B.storage.backfillState.by;
      }, 'B ведёт дозаполнение сам', 15000);
      open();
      await waitFor(async () => (await hB.get('/api/health')).status === 200 && B.storage.backfillState === null, 'B дозаполнил', 15000);
      assert.equal(await count009(), 1);
      const nulls = (await admin.query('SELECT count(*)::int AS n FROM operations WHERE ops_bytes IS NULL OR ops_count IS NULL')).rows[0].n;
      assert.equal(nulls, 0);
    } finally {
      if (open) open();
      await B.close();
      await A.close();
    }
  });

  it('старт процесса: DDL — сразу, дозаполнение — фоном (health 200 backfill); второй стартует, не дожидаясь замка', { timeout: 90000 }, async () => {
    let open = null;
    const C0 = await startFor('pg', { verifyMs: 0 }, { migrationsDir: dir });
    await C0.close();
    await admin.query(DRIFT);
    open = gate();
    const t0 = Date.now();
    const C = await start({ port: 0, storage: pgStorage({ migrationsDir: dir }), pingInterval: 0, log: quiet, verifyMs: 0 });
    let D = null;
    let dStart = null;
    try {
      assert.ok(Date.now() - t0 < 5000, `старт не ждал дозаполнения: ${Date.now() - t0} мс`);
      const hc = await api(C.url).get('/api/health');
      assert.equal(hc.status, 200, hc.text);
      assert.equal(hc.body.detail.backfill.migration, '009_ops_size.mjs');
      assert.equal(hc.body.detail.backfill.by, undefined);
      assert.equal(C.storage.schemaFlags.undoPart, true, 'DDL 011 — до готовности');
      const t1 = Date.now();
      dStart = start({ port: 0, storage: pgStorage({ migrationsDir: dir }), pingInterval: 0, log: quiet, verifyMs: 0 });
      D = await Promise.race([dStart, sleep(8000).then(() => null)]);
      assert.ok(D && Date.now() - t1 < 5000, `второй стартовал, не дожидаясь замка: ${Date.now() - t1} мс`);
      const hd = await api(D.url).get('/api/health');
      assert.equal(hd.status, 200, hd.text);
      assert.equal(hd.body.detail.backfill.by, FILL_BY_OTHER);
      const p = await api(D.url).post('/api/projects', { name: 'на старте' });
      assert.equal(p.status, 201, p.text);
      open();
      await waitFor(async () => (await api(C.url).get('/api/health')).body.detail === undefined, 'C дозаполнил', 15000);
      await waitFor(async () => (await api(D.url).get('/api/health')).body.detail === undefined, 'D увидел конец', 15000);
      assert.equal(await count009(), 1);
    } finally {
      if (open) open();
      if (!D && dStart) D = await dStart.catch(() => null);
      if (D) await D.close();
      await C.close();
    }
  });
});

/* ------------------------------ 3. бюджет голов: выжимки и надгробия ------------------------------ */

describe('круг 39: бюджет голов считает выжимки последних транзакций', () => {
  it('документы малы, правки большие — сверх бюджета выгружаются давние; вес голов — под бюджетом · memory', async () => {
    let doc = createDoc('empty');
    const page = doc.nodes[doc.root].children[0];
    const board = uid('f');
    const ids = [];
    const ops = [{ op: 'create', node: { type: 'frame', id: board, parent: page, name: 'B', role: 'artboard', layout: { mode: 'column' } } }];
    for (let i = 0; i < 150; i++) {
      const id = uid('t');
      ids.push(id);
      ops.push({ op: 'create', node: { type: 'text', id, parent: board, characters: 'x' } });
    }
    doc = core.applyOps(doc, ops).doc;
    const docBytes = Buffer.byteLength(JSON.stringify(doc));
    // бюджет — на 8 документов: по одним документам 6 проектов в него влезают
    const budget = docBytes * 8;
    const svc = await startFor('memory', { headsBytes: budget, verifyMs: 0, snapshotEvery: 0 });
    try {
      const h = api(svc.url);
      const projects = [];
      for (let p = 0; p < 6; p++) {
        const id = (await h.post('/api/projects', { name: 'выжимки ' + p, doc })).body.id;
        projects.push(id);
        for (let t = 0; t < 12; t++) {
          const r = await h.post(`/api/projects/${id}/tx`, tx(t, ids.map((n, k) => ({ op: 'set', id: n, path: k % 2 ? 'characters' : 'name', value: 'v' + t }))));
          assert.equal(r.status, 201, r.text);
        }
      }
      const st = svc.dslts.stats();
      assert.ok(st.headsDocBytes <= docBytes * 7, 'по одним документам бюджет не кончился бы: ' + JSON.stringify(st));
      assert.ok(st.evicted >= 1, 'выжимки в бюджете — давние выгружены: ' + JSON.stringify(st));
      assert.ok(st.headsBytes <= budget, `вес голов под бюджетом: ${JSON.stringify(st)} при ${budget}`);
      assert.equal(svc.dslts.isLoaded(projects[5]), true, 'последняя — в памяти');
      assert.equal(svc.dslts.isLoaded(projects[0]), false, 'давняя — выгружена');
      // выгруженная поднимается и пишет дальше
      const r = await h.post(`/api/projects/${projects[0]}/tx`, tx(12, [{ op: 'set', id: ids[0], path: 'name', value: 'после' }]));
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.seq, 13);
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 4. бюджет тел — по прочитанным байтам ------------------------------ */

describe('круг 39: медленные тела с большим Content-Length не держат бюджет тел записи', () => {
  it('16 соединений объявляют по 4 МБ и шлют по байту — честная запись проходит сразу · memory', async () => {
    const svc = await startFor('memory', { verifyMs: 0, writes: { bodyBytes: 8 * 1024 * 1024, bodyTimeoutMs: 20000 } });
    const socks = [];
    let drip = null;
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'медленно' })).body.id;
      const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
      for (let i = 0; i < 16; i++) {
        const s = net.connect(svc.port, '127.0.0.1');
        s.on('error', () => {});
        s.write(`POST /api/projects/${P}/tx HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${4 * 1024 * 1024}\r\n\r\n{`);
        socks.push(s);
      }
      drip = setInterval(() => { for (const s of socks) if (!s.destroyed) s.write(' '); }, 200);
      await sleep(500);
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const r = await h.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'честно ' + i }]));
        assert.equal(r.status, 201, r.text);
        assert.ok(Date.now() - t0 < 3000, `без ожидания медленных: ${Date.now() - t0} мс`);
      }
    } finally {
      if (drip) clearInterval(drip);
      for (const s of socks) s.destroy();
      await svc.close();
    }
  });
});

/* ------------------------------ 5. пул импорта ------------------------------ */

describe('круг 39: пул импорта — очередь с пределом, упавший поток, срок задачи', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'imago-imp35-'));
    // поток: тело «hang» — молчит, «crash» — падает, иначе отвечает готовым
    await writeFile(path.join(dir, 'worker.mjs'), `import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  const text = Buffer.from(m.buf).toString('utf8');
  if (text.includes('hang')) return;
  if (text.includes('crash')) process.exit(3);
  parentPort.postMessage({ id: m.id, ok: true, out: { name: 'готово', kind: 'design', docJson: '{}', docBytes: 2 } });
});
`);
  });
  const body = (word) => Buffer.from(JSON.stringify({ name: word, pad: 'x'.repeat(64) }));

  it('очередь полна — 503 busy import_queue сразу, не ждать', async () => {
    const pool = createImportPool({ size: 1, queue: 1, inlineBytes: 0, taskMs: 20000, workerUrl: pathToFileURL(path.join(dir, 'worker.mjs')), log: quiet });
    try {
      const first = pool.run(body('hang'));
      first.catch(() => {});
      await waitFor(() => pool.stats().busy === 1, 'первая в потоке');
      const second = pool.run(body('hang'));
      second.catch(() => {});
      const t0 = Date.now();
      await assert.rejects(pool.run(body('ok')), (e) => e.status === 503 && e.code === 'busy' && e.detail && e.detail.limit === 'import_queue');
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(pool.stats().refused, 1);
    } finally {
      await pool.close();
    }
  });

  it('поток упал — его задача получает 503 import_worker сразу (а не по сроку); следующий — новый поток', async () => {
    const pool = createImportPool({ size: 1, queue: 4, inlineBytes: 0, taskMs: 20000, workerUrl: pathToFileURL(path.join(dir, 'worker.mjs')), log: quiet });
    try {
      const t0 = Date.now();
      await assert.rejects(pool.run(body('crash')), (e) => e.status === 503 && e.detail && e.detail.cause === 'import_worker');
      assert.ok(Date.now() - t0 < 5000, `отказ сразу: ${Date.now() - t0} мс`);
      assert.equal(pool.stats().crashed, 1);
      const ok = await pool.run(body('ok'));
      assert.equal(ok.name, 'готово');
    } finally {
      await pool.close();
    }
  });

  it('поток завис — задача по сроку получает 503 import_timeout, поток заменяется, следующая проходит', async () => {
    const pool = createImportPool({ size: 1, queue: 4, inlineBytes: 0, taskMs: 400, workerUrl: pathToFileURL(path.join(dir, 'worker.mjs')), log: quiet });
    try {
      const t0 = Date.now();
      await assert.rejects(pool.run(body('hang')), (e) => e.status === 503 && e.detail && e.detail.cause === 'import_timeout');
      assert.ok(Date.now() - t0 < 3000);
      assert.equal(pool.stats().timedOut, 1);
      const ok = await pool.run(body('ok'));
      assert.equal(ok.name, 'готово', 'зависший поток заменён новым');
    } finally {
      await pool.close();
    }
  });

  it('HTTP: импорт при упавшем потоке — 503 import_worker, а не вечное ожидание · memory', async () => {
    const svc = await startFor('memory', { verifyMs: 0, importInlineBytes: 0, importWorkerUrl: pathToFileURL(path.join(dir, 'worker.mjs')) });
    try {
      const r = await api(svc.url).post('/api/projects', { name: 'crash' });
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.detail.cause, 'import_worker');
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 6. присутствие: предел частоты ------------------------------ */

describe('круг 39: присутствие — не чаще 10/с от сокета', () => {
  it('30 сообщений разом — до соседа доходит последнее из первых десяти · memory', async () => {
    // тик сводки длинный: в тик попадает последнее ПРИНЯТОЕ от сокета
    const svc = await startFor('memory', { verifyMs: 0, presence: { tickMs: 1500 } });
    try {
      const id = (await api(svc.url).post('/api/projects', { name: 'частота', demo: true })).body.id;
      const open = async (client) => {
        const s = connect(wsUrl(svc, id, { client }));
        await s.opened;
        assert.equal((await s.next()).type, 'hello');
        return s;
      };
      const A = await open('A');
      const B = await open('B');
      for (let i = 0; i < 30; i++) A.send({ type: 'presence', selection: ['s' + i] });
      const got = await B.until((m) => m.type === 'presence' && m.client === 'A', 4000);
      assert.deepEqual(got.selection, ['s9'], 'сверх 10 в секунду — отброшено');
      await Promise.all([A.close(), B.close()]);
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 7. кеш снимков ------------------------------ */

describe('круг 39: кеш снимков полного открытия — переписанный на том же seq снимок не устаревает', () => {
  it('снимок seq 1 переписан с надгробиями (та же цепочка) — открытие отдаёт новый · memory', async () => {
    const svc = await startFor('memory', { verifyMs: 0, snapshotEvery: 0 });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'кеш' })).body.id;
      const first = (await h.get(`/api/projects/${P}`)).body;
      const root = first.snapshot.doc.root;
      const w = await h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'кеш 1' }]));
      assert.equal(w.status, 201, w.text);
      const doc = (await svc.dslts.headOf(P)).doc;
      assert.equal(await svc.storage.writeSnapshot(P, 1, doc, E, w.body.chain, null), true);
      const a = await h.get(`/api/projects/${P}`);
      assert.equal(a.body.snapshot.seq, 1);
      assert.equal(a.body.snapshot.tombstones, undefined);
      await sleep(5);
      // тот же seq и цепочка, надгробия прибавились — снимок переписан (новое created_at)
      const tomb = tombstonesV2(new Map([['ghost', root]]), new Map([['ghost', 1]]));
      assert.equal(await svc.storage.writeSnapshot(P, 1, doc, E, w.body.chain, tomb), true);
      const b = await h.get(`/api/projects/${P}`);
      assert.equal(b.body.snapshot.seq, 1);
      assert.deepEqual(b.body.snapshot.tombstones, { ghost: root }, 'не устаревший снимок из кеша');
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 8. create_id с другим телом ------------------------------ */

describe('круг 39 (N4г): create_id с другим телом — 409 conflict, cause create_id', () => {
  it('отпечаток — нормализованного тела: порядок ключей, create_id и лишние поля не в счёт; имя, вид, документ, demo — в счёт', () => {
    const doc = { root: 'r', nodes: { r: { id: 'r', type: 'frame', children: [] } } };
    const a = createHashOf({ name: 'Имя', doc, create_id: 'x1234567' });
    assert.equal(a, createHashOf({ doc: { nodes: { r: { children: [], type: 'frame', id: 'r' } }, root: 'r' }, name: 'Имя', create_id: 'другой_id', лишнее: 1 }));
    assert.equal(createHashOf({ name: 'Имя' }), createHashOf({ name: 'Имя', kind: 'design', demo: false }));
    for (const other of [{ name: 'Имя 2', doc }, { name: 'Имя', doc, kind: 'library' }, { name: 'Имя', doc, demo: true }, { name: 'Имя' }]) {
      assert.notEqual(createHashOf(other), a, JSON.stringify(Object.keys(other)));
    }
  });

  for (const b of list) {
    it(`то же тело — 200 тот же проект; другое имя, вид, документ — 409 · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name, { verifyMs: 0 });
      try {
        const h = api(svc.url);
        const cid = 'conf_' + Math.random().toString(36).slice(2, 12);
        const doc = createDoc();
        const r1 = await h.post('/api/projects', { name: 'спасение', doc, create_id: cid });
        assert.equal(r1.status, 201, r1.text);
        const same = await h.post('/api/projects', { name: 'спасение', doc, create_id: cid });
        assert.equal(same.status, 200, same.text);
        assert.equal(same.body.id, r1.body.id);
        // тот же документ с ключами в другом порядке — то же тело
        const same2 = await h.post('/api/projects', { create_id: cid, doc: reverseKeys(doc), name: 'спасение' });
        assert.equal(same2.status, 200, same2.text);
        for (const other of [
          { name: 'спасение', doc, demo: true },
          { name: 'другое имя', doc },
          { name: 'спасение', doc, kind: 'library' },
          { name: 'спасение' },
          { name: 'спасение', doc: createDoc() }
        ]) {
          const r = await h.post('/api/projects', { ...other, create_id: cid });
          assert.equal(r.status, 409, JSON.stringify(Object.keys(other)) + ' ' + r.text);
          assert.equal(r.body.code, 'conflict');
          assert.equal(r.body.retryable, false);
          assert.equal(r.body.detail.cause, 'create_id');
          assert.equal(r.body.detail.id, undefined, 'чужой id проекта наружу не отдаётся');
        }
        const all = (await h.get('/api/projects?limit=1000')).body.projects;
        assert.equal(all.filter((p) => p.id === r1.body.id).length, 1);
        assert.equal(all.length, 1, 'второго проекта нет');
        // одновременные одинаковые — один проект, все 200/201
        const cid2 = 'conf2_' + Math.random().toString(36).slice(2, 12);
        const rs = await Promise.all(Array.from({ length: 5 }, () => h.post('/api/projects', { name: 'вместе', create_id: cid2 })));
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
      } finally {
        await svc.close();
      }
    });
  }

  it('проект без отпечатка (создан до 013 / прежним экземпляром) — сверка только по виду · pg', { skip: pgOk ? false : 'нет базы' }, async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    try {
      const h = api(svc.url);
      const cid = 'old_' + Math.random().toString(36).slice(2, 12);
      const r1 = await h.post('/api/projects', { name: 'старый', create_id: cid });
      assert.equal(r1.status, 201);
      assert.ok((await svc.storage.pool.query('SELECT create_hash FROM projects WHERE id = $1', [r1.body.id])).rows[0].create_hash);
      await svc.storage.pool.query('UPDATE projects SET create_hash = NULL WHERE id = $1', [r1.body.id]);
      const renamed = await h.post('/api/projects', { name: 'имя могли сменить', create_id: cid });
      assert.equal(renamed.status, 200, renamed.text);
      const lib = await h.post('/api/projects', { name: 'старый', kind: 'library', create_id: cid });
      assert.equal(lib.status, 409, lib.text);
      assert.equal(lib.body.detail.cause, 'create_id');
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ N2. предел раскрытия экземпляров ------------------------------ */

describe('круг 39 (N2): предел раскрытия экземпляров — импорт 400, транзакция dropped expand_nodes', () => {
  const can = typeof core.libraryNode === 'function'
    && (typeof core.expandCost === 'function' || typeof core.expandProblem === 'function');
  const MAX = Number.isFinite(core.MAX_EXPANDED_NODES) ? core.MAX_EXPANDED_NODES : 50000;
  const cost = (doc) => (typeof core.expandCost === 'function' ? core.expandCost(doc) : core.expandProblem(doc) ? Infinity : 0);

  it('документ сверх предела раскрытия — 400 detail.limit expand_nodes; в пределе — 201 · memory', { skip: can ? false : 'движок без expandCost' }, async () => {
    const svc = await startFor('memory', { verifyMs: 0 });
    try {
      const doc = expandBomb();
      assert.ok(cost(doc) > MAX, 'документ сверх предела раскрытия');
      const r = await api(svc.url).post('/api/projects', { name: 'бомба', doc });
      assert.equal(r.status, 400, r.text);
      assert.equal(r.body.detail.limit, 'expand_nodes');
      assert.equal(r.body.detail.max, MAX, 'предел назван');
      assert.doesNotMatch(r.body.message, /f_q|i_q/, 'без id в словах');
      // большой документ — через поток импорта — тот же ответ
      const big = expandBomb();
      big.meta = { pad: 'x'.repeat(300 * 1024) };
      const rb = await api(svc.url).post('/api/projects', { name: 'бомба большая', doc: big });
      assert.equal(rb.status, 400, rb.text);
      assert.equal(rb.body.detail.limit, 'expand_nodes');
      // поуже — в пределе: импортируется
      const ok = await api(svc.url).post('/api/projects', { name: 'обычный', doc: expandBomb(9, 3) });
      assert.equal(ok.status, 201, ok.text);
    } finally {
      await svc.close();
    }
  });

  for (const b of list) {
    it(`транзакция, раздувающая раскрытие сверх предела, — её экземпляры dropped invalid expand_nodes, прочее ложится · ${b.name}`, { skip: !b.available || !can ? (can ? 'нет базы' : 'движок без expandCost') : false }, async () => {
      const svc = await startFor(b.name, { verifyMs: 0 });
      try {
        const h = api(svc.url);
        const base = expandBomb(9, 3);
        const before = cost(base);
        assert.ok(before <= MAX && before > 0, 'исходный — в пределе: ' + before);
        const P = (await h.post('/api/projects', { name: 'почти бомба', doc: base })).body.id;
        const snap = (await h.get(`/api/projects/${P}`)).body.snapshot.doc;
        const page = snap.nodes[snap.root].children[0];
        // каждый экземпляр верхнего мастера стоит ~cost(до)/… — десять таких — далеко за пределом
        const ops = [{ op: 'set', id: page, path: 'name', value: 'Страница после' }];
        for (let i = 0; i < 10; i++) ops.push({ op: 'create', node: { type: 'instance', id: 'i_top' + i, parent: page, of: 'f_q0' } });
        const r = await h.post(`/api/projects/${P}/tx`, tx(0, ops));
        assert.equal(r.status, 201, r.text);
        const dropped = r.body.dropped || [];
        assert.ok(dropped.length >= 1, 'часть экземпляров отброшена: ' + r.text);
        for (const d of dropped) {
          assert.equal(d.reason, 'invalid', JSON.stringify(d));
          assert.equal(d.limit, 'expand_nodes', JSON.stringify(d));
        }
        assert.ok(!dropped.some((d) => d.index === 0), 'правка имени не отброшена');
        const head = (await svc.dslts.headOf(P)).doc;
        assert.equal(head.nodes[page].name, 'Страница после');
        assert.ok(cost(head) <= MAX, `раскрытие головы в пределе: ${cost(head)}`);
        // документ у читателя — тот же (журнал + снимок), раскрытие в пределе
        const opened = (await h.get(`/api/projects/${P}`)).body;
        let doc = opened.snapshot.doc;
        for (const t of opened.tail) doc = core.applyOps(doc, t.ops, { checkExpand: false }).doc;
        assert.ok(cost(doc) <= MAX);
        // удалять из такого документа можно всегда
        const rm = await h.post(`/api/projects/${P}/tx`, tx(1, [{ op: 'remove', id: 'i_top0' }]));
        assert.equal(rm.status, 201, rm.text);
        assert.deepEqual(rm.body.dropped || [], []);
      } finally {
        await svc.close();
      }
    });
  }
});

/* ------------------------------ N1. версия формата движка ------------------------------ */

/** Лог, собирающий предупреждения (строкой). */
function logBox() {
  const lines = [];
  return { lines, log: { info() {}, warn: (...a) => lines.push(a.map(String).join(' ')) } };
}

describe('круг 39 (N1): версия движка экземпляра — опция, 426 для чужой версии клиента', () => {
  it('версию можно понизить (не ниже ENGINE_MIN_READ), но не поднять выше движка; health и hello — версия экземпляра · memory', { skip: CODE_ENGINE - 1 >= ENGINE_MIN_READ ? false : 'движок одной версии' }, async () => {
    const box = logBox();
    const up = await startFor('memory', { verifyMs: 0, engine: CODE_ENGINE + 1, log: box.log });
    try {
      assert.equal((await api(up.url).get('/api/health')).body.engine, CODE_ENGINE, 'выше движка — нельзя');
      assert.ok(box.lines.some((l) => /не годится/.test(l)));
    } finally {
      await up.close();
    }
    const old = await startFor('memory', { verifyMs: 0, engine: CODE_ENGINE - 1 });
    try {
      const h = api(old.url);
      assert.equal((await h.get('/api/health')).body.engine, CODE_ENGINE - 1);
      const P = (await h.post('/api/projects', { name: 'прежний' })).body;
      assert.equal(P.engine, CODE_ENGINE - 1, 'проект записан версией экземпляра');
      const s = connect(wsUrl(old, P.id));
      await s.opened;
      const hello = await s.next();
      assert.equal(hello.type, 'hello');
      assert.equal(hello.engine, CODE_ENGINE - 1);
      await s.close();
      const root = (await h.get(`/api/projects/${P.id}`)).body.snapshot.doc.root;
      const newer = await h.post(`/api/projects/${P.id}/tx`, { ...tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }]), engine: CODE_ENGINE });
      assert.equal(newer.status, 426, 'клиент новее экземпляра — 426');
      assert.equal(newer.body.engine, CODE_ENGINE - 1);
      const same = await h.post(`/api/projects/${P.id}/tx`, { ...tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }]), engine: CODE_ENGINE - 1 });
      assert.equal(same.status, 201, same.text);
      assert.equal(same.body.engine, CODE_ENGINE - 1);
    } finally {
      await old.close();
    }
  });

  it('клиент или агент прежней версии на новом экземпляре — 426 (HTTP и сокет) · memory', async () => {
    const svc = await startFor('memory', { verifyMs: 0 });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'новый' })).body.id;
      const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
      for (const engine of [CODE_ENGINE - 1, CODE_ENGINE + 1, undefined]) {
        const r = await h.post(`/api/projects/${P}/tx`, { ...tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }]), engine });
        assert.equal(r.status, 426, String(engine));
        assert.equal(r.body.code, 'engine');
        assert.equal(r.body.engine, CODE_ENGINE);
      }
      const s = connect(wsUrl(svc, P));
      await s.opened;
      assert.equal((await s.next()).type, 'hello');
      s.send({ type: 'tx', tx: { ...tx(0, [{ op: 'set', id: root, path: 'name', value: 'y' }]), engine: CODE_ENGINE - 1 } });
      const e = await s.until((m) => m.type === 'error');
      assert.equal(e.code, 'engine');
      await s.close();
    } finally {
      await svc.close();
    }
  });
});

describe('круг 39 (N1): два экземпляра разных версий движка на одной базе — запись новее не пропускается', { skip: CODE_ENGINE - 1 >= ENGINE_MIN_READ ? false : 'движок одной версии — смешанных версий нет' }, () => {
  const NEW = CODE_ENGINE;
  const OLD = CODE_ENGINE - 1;
  for (const b of list) {
    it(`новый пишет запись своей версии — прежний: 503 engine на чтение и запись, сокеты 4503, одна строка в лог, снимков без неё нет · ${b.name}`, { skip: !b.available, timeout: 60000 }, async () => {
      const box = logBox();
      const A = await startFor(b.name, { verifyMs: 0, snapshotEvery: 10 });
      const C = await startTwin(b.name, A, { verifyMs: 0, snapshotEvery: 10, engine: OLD, log: box.log });
      try {
        const hA = api(A.url);
        const hC = api(C.url);
        assert.equal((await hC.get('/api/health')).body.engine, OLD);
        // проект создан прежним экземпляром, прежний клиент правит
        const P = (await hC.post('/api/projects', { name: 'смешанные версии' })).body.id;
        const snap0 = (await hC.get(`/api/projects/${P}`)).body.snapshot;
        assert.equal(snap0.engine, OLD);
        const root = snap0.doc.root;
        const page = snap0.doc.nodes[root].children[0];
        const old = (base, value) => hC.post(`/api/projects/${P}/tx`, { ...tx(base, [{ op: 'set', id: root, path: 'name', value }]), engine: OLD });
        for (let i = 0; i < 3; i++) assert.equal((await old(i, 'прежний ' + i)).status, 201);
        const sC = connect(wsUrl(C, P, { since: '3' }));
        await sC.opened;
        assert.equal((await sC.next()).type, 'hello');
        // новый клиент на новом экземпляре — слой новой версии
        const V = 'f_new_v';
        const w = await hA.post(`/api/projects/${P}/tx`, { ...tx(3, [{ op: 'create', node: { type: 'frame', id: V, parent: page, name: 'Слой новой версии' } }]), engine: NEW });
        assert.equal(w.status, 201, w.text);
        assert.equal(w.body.seq, 4);
        // прежний экземпляр: живого потока нет — честный 503 engine и закрытие 4503
        const err = await sC.until((m) => m.type === 'error', 8000);
        assert.equal(err.code, 'unavailable');
        assert.equal(err.detail.cause, 'engine');
        assert.equal((await sC.closed).code, 4503);
        // чтение и запись проекта на прежнем — 503 cause engine
        const tries = [
          old(3, 'после'), old(4, 'после'),
          hC.get(`/api/projects/${P}`), hC.get(`/api/projects/${P}?lean=1`), hC.get(`/api/projects/${P}/ops?since=0`)
        ];
        for (const r of await Promise.all(tries)) {
          assert.equal(r.status, 503, r.text);
          assert.equal(r.body.code, 'unavailable');
          assert.equal(r.body.detail.cause, 'engine');
          assert.equal(r.body.detail.found, NEW);
        }
        assert.equal(C.dslts.isLoaded(P), false, 'голова не держится');
        assert.ok(C.dslts.outdatedOf(P));
        const s2 = connect(wsUrl(C, P));
        await s2.opened.catch(() => {});
        const e2 = await s2.until((m) => m.type === 'error', 5000);
        assert.equal(e2.detail.cause, 'engine');
        // прежний клиент на новом — 426
        const r426 = await hA.post(`/api/projects/${P}/tx`, { ...tx(4, [{ op: 'set', id: root, path: 'name', value: 'x' }]), engine: OLD });
        assert.equal(r426.status, 426);
        // новый пишет дальше — снимки (10, 20) только его версии
        for (let i = 4; i < 20; i++) assert.equal((await hA.post(`/api/projects/${P}/tx`, { ...tx(i, [{ op: 'set', id: page, path: 'name', value: 'новая ' + i }]), engine: NEW })).status, 201);
        await A.dslts.flush();
        await C.dslts.flush();
        // прежний ещё раз — тот же отказ; строка в логе одна
        for (let i = 0; i < 5; i++) assert.equal((await old(20, 'снова')).status, 503);
        const lines = box.lines.filter((l) => l.includes(P) && /а этот экземпляр работает с/.test(l));
        assert.equal(lines.length, 1, 'одна строка в лог: ' + lines.join(' | '));
        const seqs = await A.storage.snapshotSeqs(P);
        assert.ok(seqs.includes(10) && seqs.includes(20), 'снимки нового: ' + seqs);
        if (b.name === 'pg') {
          const rows = (await A.storage.pool.query('SELECT seq, engine FROM snapshots WHERE project_id = $1 ORDER BY seq', [P])).rows;
          assert.deepEqual(rows.filter((x) => Number(x.seq) >= 4 && x.engine !== NEW), [], 'снимков прежней версии поверх новой записи нет: ' + JSON.stringify(rows));
          // и база сама не примет снимок прежнего движка поверх записи новой версии (014)
          const head = await A.dslts.headOf(P);
          await assert.rejects(A.storage.writeSnapshot(P, 20, head.doc, OLD, head.chain, null), (e) => e && e.code === 'IE426');
        }
        // открыть через новый — слой на месте
        const fresh = (await hA.get(`/api/projects/${P}`)).body;
        let doc = fresh.snapshot.doc;
        for (const t of fresh.tail) doc = core.applyOps(doc, t.ops).doc;
        assert.ok(doc.nodes[V], 'слой новой версии у всех, кто открывает через новый');
      } finally {
        await C.close();
        await A.close();
      }
    });
  }

  it('снимок новой версии — прежний не поднимает с него голову: 503 engine (а не «предупреждение») · memory', async () => {
    const A = await startFor('memory', { verifyMs: 0, snapshotEvery: 2 });
    const C = await startTwin('memory', A, { verifyMs: 0, engine: OLD });
    try {
      const hA = api(A.url);
      const P = (await hA.post('/api/projects', { name: 'снимок новой' })).body.id;
      const root = (await hA.get(`/api/projects/${P}`)).body.snapshot.doc.root;
      for (let i = 0; i < 2; i++) assert.equal((await hA.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'n' + i }]))).status, 201);
      await A.dslts.flush();
      assert.ok((await A.storage.snapshotSeqs(P)).includes(2));
      const r = await api(C.url).post(`/api/projects/${P}/tx`, { ...tx(2, [{ op: 'set', id: root, path: 'name', value: 'old' }]), engine: OLD });
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.detail.cause, 'engine');
      const g = await api(C.url).get(`/api/projects/${P}`);
      assert.equal(g.status, 503);
      assert.equal(g.body.detail.cause, 'engine');
    } finally {
      await C.close();
      await A.close();
    }
  });
});

describe('круг 39 (N1): запись движка новее экземпляра и голова с пропуском', () => {
  for (const b of list) {
    it(`запись журнала движка новее — 503 engine, голова не держится; снимок не пишется · ${b.name}`, { skip: !b.available }, async () => {
      const box = logBox();
      const svc = await startFor(b.name, { verifyMs: 0, snapshotEvery: 3, log: box.log });
      try {
        const h = api(svc.url);
        const P = (await h.post('/api/projects', { name: 'будущее' })).body.id;
        const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
        assert.equal((await h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'a' }]))).status, 201);
        // запись «из будущего» (экземпляр новее этого кода) — прямо в журнал
        const fut = await svc.storage.commitTx(P, { tx_id: uid('tx'), base_seq: 1, ops: [{ op: 'set', id: root, path: 'name', value: 'из будущего' }], dropped: [], notes: [], engine: CODE_ENGINE + 1, author_kind: 'human' });
        assert.equal(fut.status, 'committed');
        await svc.dslts.unload(P);
        for (const r of await Promise.all([
          h.post(`/api/projects/${P}/tx`, tx(2, [{ op: 'set', id: root, path: 'name', value: 'b' }])),
          h.get(`/api/projects/${P}`),
          h.get(`/api/projects/${P}/ops?since=1`)
        ])) {
          assert.equal(r.status, 503, r.text);
          assert.equal(r.body.detail.cause, 'engine');
          assert.equal(r.body.detail.found, CODE_ENGINE + 1);
          assert.ok(Number(r.headers.get('retry-after')) > 0);
        }
        assert.equal(svc.dslts.isLoaded(P), false);
        assert.deepEqual(await svc.storage.snapshotSeqs(P), [0], 'снимков нет');
        assert.equal(box.lines.filter((l) => l.includes(P) && /а этот экземпляр работает с/.test(l)).length, 1);
        // ops до записи «из будущего» читаются (догон прежней части)
        const early = await h.get(`/api/projects/${P}/ops?since=0&limit=1`);
        assert.equal(early.status, 200, early.text);
      } finally {
        await svc.close();
      }
    });

    it(`запись, которую движок не применяет, — голова «с пропуском» снимков не пишет никогда · ${b.name}`, { skip: !b.available }, async () => {
      const box = logBox();
      const svc = await startFor(b.name, { verifyMs: 0, snapshotEvery: 4, log: box.log });
      try {
        const h = api(svc.url);
        const P = (await h.post('/api/projects', { name: 'пропуск' })).body.id;
        const root = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.root;
        const page = (await h.get(`/api/projects/${P}`)).body.snapshot.doc.nodes[root].children[0];
        assert.equal((await h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'a' }]))).status, 201);
        // та же версия, а движок запись не применяет (журнал разошёлся с движком)
        const bad = await svc.storage.commitTx(P, { tx_id: uid('tx'), base_seq: 1, ops: [{ op: 'create', node: { type: 'нет_такого_типа', id: 'z_bad', parent: page } }], dropped: [], notes: [], engine: CODE_ENGINE, author_kind: 'human' });
        assert.equal(bad.status, 'committed');
        for (let i = 2; i < 13; i++) {
          const r = await h.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'v' + i }]));
          assert.equal(r.status, 201, r.text);
        }
        await svc.dslts.flush();
        assert.equal(svc.dslts.isHoley(P), true);
        assert.deepEqual(await svc.storage.snapshotSeqs(P), [0], 'снимков с головы с пропуском нет (4, 8, 12)');
        // голова поднята заново из журнала — снова с пропуском, снова без снимков
        await svc.dslts.unload(P);
        for (let i = 13; i < 17; i++) assert.equal((await h.post(`/api/projects/${P}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'w' + i }]))).status, 201);
        await svc.dslts.flush();
        assert.equal(svc.dslts.isHoley(P), true);
        assert.deepEqual(await svc.storage.snapshotSeqs(P), [0]);
        assert.ok(box.lines.some((l) => /голова с пропуском/.test(l)));
        // работа идёт: чтение и запись
        assert.equal((await h.get(`/api/projects/${P}`)).status, 200);
      } finally {
        await svc.close();
      }
    });
  }
});

/* ------------------------------ N4в. первый байт тела ------------------------------ */

describe('круг 39 (N4в): тело объявлено и молчит — 408 по сроку первого байта', () => {
  it('Content-Length без тела — 408 body_first_byte за ~срок, а не за срок всего тела · memory', async () => {
    const svc = await startFor('memory', { verifyMs: 0, writes: { firstByteMs: 400, bodyTimeoutMs: 20000 } });
    try {
      const P = (await api(svc.url).post('/api/projects', { name: 'молчит' })).body.id;
      const t0 = Date.now();
      const text = await new Promise((resolve) => {
        const s = net.connect(svc.port, '127.0.0.1');
        let out = '';
        s.on('data', (d) => { out += d; });
        s.on('close', () => resolve(out));
        s.on('error', () => resolve(out));
        s.write(`POST /api/projects/${P}/tx HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`);
        setTimeout(() => s.destroy(), 5000);
      });
      assert.match(text, /^HTTP\/1\.1 408/, text.slice(0, 200));
      assert.match(text, /body_first_byte/);
      assert.ok(Date.now() - t0 < 3000, `по сроку первого байта: ${Date.now() - t0} мс`);
      // тело, которое начало приходить, этим сроком не обрывается
      const s = net.connect(svc.port, '127.0.0.1');
      const slow = new Promise((resolve) => {
        let out = '';
        s.on('data', (d) => { out += d; if (/\r\n\r\n/.test(out)) resolve(out); });
        s.on('error', () => resolve(out));
      });
      const body = JSON.stringify(tx(0, []));
      s.write(`POST /api/projects/${P}/tx HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n` + body.slice(0, 5));
      await sleep(700);
      s.write(body.slice(5));
      assert.match(await slow, /^HTTP\/1\.1 201/);
      s.destroy();
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ N4а. «устоялась»: триггеры и чужой COPY ------------------------------ */

describe('круг 39 (N4а): схема «устоялась» — только с триггерами и без чужого COPY … FROM stdin · pg', { skip: pgOk && tools ? false : 'нет базы или psql' }, () => {
  it('нет триггера учтённой миграции — 503 schema (restore); вернули — работа идёт', async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    const admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'триггер' })).body.id;
      await admin.query('DROP TRIGGER snapshots_engine ON snapshots');
      await admin.query('SELECT pg_terminate_backend($1)', [svc.storage.listenerPid]);
      await waitFor(async () => {
        const hb = await h.get('/api/health');
        return hb.status === 503 && hb.body.detail.phase === 'restore';
      }, 'фаза restore', 10000);
      const r = await h.get(`/api/projects/${P}`);
      assert.equal(r.status, 503);
      assert.equal(r.body.detail.cause, 'schema');
      await admin.query('CREATE TRIGGER snapshots_engine BEFORE INSERT ON snapshots FOR EACH ROW EXECUTE FUNCTION imago_snapshots_engine()');
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'триггер вернули — здоров', 15000);
      assert.equal((await h.get(`/api/projects/${P}`)).status, 200);
    } finally {
      await admin.query('CREATE TRIGGER snapshots_engine BEFORE INSERT ON snapshots FOR EACH ROW EXECUTE FUNCTION imago_snapshots_engine()').catch(() => {});
      await admin.end();
      await svc.close();
    }
  });

  it('чужой сеанс льёт COPY … FROM stdin — restore, сколько бы ни длился; кончил — здоров', async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    const admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    let ch = null;
    try {
      const h = api(svc.url);
      await admin.query('CREATE TABLE IF NOT EXISTS copy_probe (x int)');
      const url = new URL(DB_URL);
      const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
      delete env.NODE_OPTIONS;
      ch = spawn('psql', ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-q', '-c', 'COPY copy_probe FROM STDIN'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
      ch.stdin.write('1\n');
      await waitFor(async () => (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query ILIKE 'COPY copy_probe%'")).rows[0].n === 1, 'COPY идёт', 5000);
      await admin.query('SELECT pg_terminate_backend($1)', [svc.storage.listenerPid]);
      const restoring = async () => {
        const r = await h.get('/api/health');
        return r.status === 503 && r.body.detail && r.body.detail.phase === 'restore';
      };
      await waitFor(restoring, 'фаза restore', 10000);
      await sleep(2500);
      assert.ok(await restoring(), 'пока COPY идёт — restore');
      ch.stdin.end('2\n\\.\n');
      await new Promise((r) => ch.on('exit', r));
      ch = null;
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'COPY кончился — здоров', 15000);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM copy_probe')).rows[0].n, 2);
    } finally {
      if (ch) ch.kill();
      await admin.query('DROP TABLE IF EXISTS copy_probe').catch(() => {});
      await admin.end();
      await svc.close();
    }
  });
});

/** Копия с ключами объектов в обратном порядке (тот же JSON по смыслу). */
function reverseKeys(v) {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).reverse()) out[k] = reverseKeys(v[k]);
  return out;
}

/**
 * Документ, чьё раскрытие экземпляров больше предела движка (core.expandCost): цепочка 9
 * мастеров библиотеки по 5 экземпляров следующего — 6 КБ JSON, 610 тыс. узлов раскрытия.
 */
function expandBomb(L = 9, W = 5) {
  const d = JSON.parse(JSON.stringify(createDoc('empty')));
  const lib = core.libraryNode(d).id;
  for (let i = 0; i < L; i++) {
    const c = 'f_q' + i;
    d.nodes[c] = { type: 'frame', id: c, parent: lib, component: { name: 'K' + i, props: [] }, children: [], layout: { mode: 'column' } };
    d.nodes[lib].children.push(c);
    if (i < L - 1) {
      for (let s = 0; s < W; s++) {
        const n = 'i_q' + i + '_' + s;
        d.nodes[n] = { type: 'instance', id: n, parent: c, of: 'f_q' + (i + 1) };
        d.nodes[c].children.push(n);
      }
    }
  }
  return d;
}
