/**
 * Круг 33 — Document service и хранилище:
 *   1) статика STATIC_DIR — только файлы клиента (белый список), `.env`, `.git`, server/, node_modules — 404;
 *   2) присутствие сводится по тикам: 150 сокетов × 10/с не останавливают запись (p99 < 1 с);
 *   3) импорт 20 тыс. узлов готовится в потоках — соседняя запись не ждёт;
 *   4) головы секвенсора в памяти — под бюджетом байт (LRU), открытые сокетами не выгружаются;
 *   5) восстановление «в ту же базу» под работающим экземпляром — без DDL, пока база пуста или
 *      к ней подключён pg_restore (503 storage:'schema' phase 'empty'|'restore');
 *   6) долгое дозаполнение 009 при сверке — после DDL 010/011: запись с command_author/undo_part,
 *      health 200 с detail.backfill;
 *   7) L1: create_id — повтор создания проекта отдаёт тот же проект (миграция 012);
 *   8) догон (`ops?since`, сокет) чистит подписи старых записей;
 *   9) снимок полного открытия сериализуется один раз на (проект, seq, chain).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, copyFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import * as core from '../../src/core.js';
import { uid, ENGINE_VERSION, createDoc } from '../../src/core.js';
import { MIGRATIONS_DIR } from '../../server/document/storage/pg.js';
import { prepareProject } from '../../server/document/importer.js';
import { backends, startFor, api, connect, wsUrl, waitFor, pgAvailable, pgStorage, DB_URL, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const q = (a, p) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const list = await backends();
const pgOk = await pgAvailable();

/** Документ в ~20 тыс. узлов (как у критика: доска, 1990 строк по 9 текстов). */
function bigDoc(rows = 1990) {
  let doc = core.createDoc();
  const page = doc.nodes[doc.root].children[0];
  const board = core.uid('f');
  const ops = [{ op: 'create', node: { type: 'frame', id: board, parent: page, name: 'B', role: 'artboard', layout: { mode: 'column', gap: 'spacing.1' } } }];
  for (let b = 0; b < rows; b++) {
    const f = core.uid('f');
    ops.push({ op: 'create', node: { type: 'frame', id: f, parent: board, layout: { mode: 'row' } } });
    for (let k = 0; k < 9; k++) ops.push({ op: 'create', node: { type: 'text', id: core.uid('t'), parent: f, characters: 'т' + b + '.' + k } });
  }
  doc = core.applyOps(doc, ops).doc;
  return { doc, board };
}

/* ------------------------------ 1. статика ------------------------------ */

describe('круг 33: STATIC_DIR раздаёт только файлы клиента', () => {
  let svc;
  let http;
  before(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-static33-'));
    for (const d of ['src', '.git', 'server/document', 'node_modules/x', 'tools', 'dist/web']) await mkdir(path.join(dir, d), { recursive: true });
    const files = {
      'index.html': '<!doctype html><title>Imago</title>', 'app.js': 'export {};', 'styles.css': 'body{}',
      'src/core.js': 'export {};', 'src/sync.js': 'export {};', 'src/.hidden.js': 'секрет',
      '.env': 'DATABASE_URL=postgres://u:секрет@h/db', '.git/config': '[remote] url=секрет',
      'server/document/index.js': 'секрет', 'node_modules/x/index.js': 'секрет', 'package.json': '{}',
      'ЗАПУСК.md': 'док', 'tools/build.mjs': 'секрет', 'dist/web/index.html': 'x', 'src/x.mjs': 'x'
    };
    for (const [f, text] of Object.entries(files)) await writeFile(path.join(dir, f), text);
    svc = await startFor('memory', { staticDir: dir });
    http = api(svc.url);
  });
  after(async () => { await svc.close(); });

  it('index.html, app.js, styles.css, src/*.js — 200; .env, .git, server/, node_modules, прочее — 404 без содержимого', async () => {
    for (const p of ['/', '/index.html', '/app.js', '/styles.css', '/src/core.js', '/src/sync.js']) {
      const r = await http.get(p);
      assert.equal(r.status, 200, p);
    }
    for (const p of ['/.env', '/.git/config', '/server/document/index.js', '/node_modules/x/index.js', '/package.json',
      '/%D0%97%D0%90%D0%9F%D0%A3%D0%A1%D0%9A.md', '/tools/build.mjs', '/dist/web/index.html', '/src/.hidden.js', '/src/x.mjs',
      '/%2Eenv', '/src/..%2F.env', '/./.env', '/src/%2E%2E/.env', '/.git/', '/src/', '/app.js/', '/src/core.js%00']) {
      const r = await http.get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /секрет/, p);
    }
    const head = await http.raw('HEAD', '/.env');
    assert.equal(head.status, 404);
  });
});

/* ------------------------------ 2. присутствие ------------------------------ */

describe('круг 33: присутствие K² — сводка по тикам', () => {
  for (const b of list) {
    it(`150 сокетов по 10/с: запись p99 < 1 с, присутствие доходит, кадров — под бюджетом · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name, { verifyMs: 0 });
      const socks = [];
      try {
        const h = api(svc.url);
        const P = (await h.post('/api/projects', { name: 'буря присутствия', demo: true })).body.id;
        const doc = (await h.get(`/api/projects/${P}`)).body.snapshot.doc;
        const ids = Object.keys(doc.nodes);
        const K = 150;
        let recvd = 0;
        for (let i = 0; i < K; i++) {
          const ws = new WebSocket(wsUrl(svc, P, { client: 'c' + i, author: 'a' + i, proto: '2' }));
          ws.on('message', () => { recvd += 1; });
          ws.on('error', () => {});
          socks.push(ws);
        }
        await Promise.all(socks.map((ws) => new Promise((r) => { ws.once('open', r); ws.once('error', r); })));
        await waitFor(() => svc.hub.roomSize(P) === K, 'все сокеты в комнате', 10000);
        // наблюдатель нового вида — присутствие одним кадром на тик
        const watcher = connect(wsUrl(svc, P, { client: 'W', proto: '2', presence: 'batch' }));
        await watcher.opened;
        assert.equal((await watcher.next()).type, 'hello');
        const plain = connect(wsUrl(svc, P, { client: 'V', proto: '2' }));
        await plain.opened;
        assert.equal((await plain.next()).type, 'hello');

        const timers = socks.map((ws, i) => setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'presence', selection: ids.slice(i % 20, i % 20 + 5), board: null }));
        }, 100));
        const lat = [];
        let run = true;
        const writer = (async () => {
          let n = 0;
          while (run) {
            const t = Date.now();
            const r = await h.post(`/api/projects/${P}/tx`, tx(0, [{ op: 'set', id: doc.root, path: 'name', value: 'n' + (n++) }]));
            assert.equal(r.status, 201, r.text);
            lat.push(Date.now() - t);
            await sleep(100);
          }
        })();
        const SECS = 4;
        await sleep(SECS * 1000);
        run = false;
        timers.forEach(clearInterval);
        await writer;
        const st = svc.hub.presenceStats(P);
        // присутствие дошло: нового вида — кадром presence_batch, прежнего — по записи
        const batch = await watcher.until((m) => m.type === 'presence_batch' && m.items.some((x) => x.type === 'presence' && /^c\d+$/.test(x.client)), 3000);
        assert.ok(batch.items.length >= 1);
        const one = await plain.until((m) => m.type === 'presence' && /^c\d+$/.test(m.client), 3000);
        assert.ok(Array.isArray(one.selection));
        const p99 = q(lat, 0.99);
        assert.ok(lat.length >= 10, 'записей ' + lat.length);
        assert.ok(p99 < 1000, `запись p99 ${p99} мс (${lat.length} записей)`);
        // кадров присутствия — не больше бюджета комнаты на тик (с запасом на наблюдателя нового вида)
        assert.ok(st.framesSent <= st.ticks * (3000 + K + 10), `кадров ${st.framesSent} за ${st.ticks} тиков`);
        assert.ok(st.framesSent < K * K * 10 * SECS / 4, `кадров ${st.framesSent} — не K²`);
        await watcher.close();
        await plain.close();
      } finally {
        for (const ws of socks) ws.terminate();
        await svc.close();
      }
    });
  }

  it('сводка: от источника — последнее, left отменяет ждущее присутствие, две вкладки одного клиента — обе · memory', async () => {
    const svc = await startFor('memory', { presence: { tickMs: 150 } });
    try {
      const h = api(svc.url);
      const P = (await h.post('/api/projects', { name: 'тик' })).body.id;
      const open = async (client, extra = {}) => {
        const s = connect(wsUrl(svc, P, { client, proto: '2', ...extra }));
        await s.opened;
        assert.equal((await s.next()).type, 'hello');
        return s;
      };
      const A = await open('A');
      const B = await open('B');
      const W = await open('W', { presence: 'batch' });
      for (let i = 0; i < 5; i++) A.send({ type: 'presence', selection: ['n' + i] });
      const got = await B.until((m) => m.type === 'presence' && m.client === 'A');
      assert.deepEqual(got.selection, ['n4'], 'за тик — только последнее');
      assert.ok(await B.silence(250), 'и ничего больше');
      const w = await W.until((m) => m.type === 'presence_batch');
      assert.deepEqual(w.items.filter((x) => x.client === 'A').map((x) => x.selection), [['n4']]);
      // присутствие и сразу закрытие — в том же тике: только left, без призрака
      const C = await open('C');
      C.send({ type: 'presence', selection: ['c1'] });
      await C.close();
      const tail = [];
      for (;;) {
        if (await B.silence(400)) break;
        tail.push(await B.next());
      }
      assert.deepEqual(tail.filter((m) => m.client === 'C').map((m) => m.type), ['left']);
      // вкладки одного клиента (общий clientId) — обе выделения доходят
      const X1 = await open('X');
      const X2 = await open('X');
      X1.send({ type: 'presence', selection: ['x1'] });
      X2.send({ type: 'presence', selection: ['x2'] });
      const seen = new Set();
      while (seen.size < 2) seen.add((await B.until((m) => m.type === 'presence' && m.client === 'X')).selection[0]);
      await Promise.all([A.close(), B.close(), W.close(), X1.close(), X2.close()]);
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 3. импорт ------------------------------ */

describe('круг 33: импорт 20 тыс. узлов — в потоках, соседняя запись не ждёт', () => {
  for (const b of list) {
    it(`6 импортов разом: соседняя запись max < 1 с и меньше счёта одного импорта; импорт цел · ${b.name}`, { skip: !b.available }, async () => {
      const { doc } = bigDoc();
      const body = JSON.stringify({ name: 'буря импорта', doc });
      // сколько стоит подготовка одного такого документа в цикле событий (как было до круга 33)
      const t0 = Date.now();
      prepareProject(JSON.parse(body));
      const inlineMs = Date.now() - t0;
      const svc = await startFor(b.name, { verifyMs: 0 });
      try {
        const h = api(svc.url);
        const other = (await h.post('/api/projects', { name: 'сосед' })).body.id;
        const oroot = (await h.get(`/api/projects/${other}`)).body.snapshot.doc.root;
        let probe = true;
        const nl = [];
        const pr = (async () => {
          let n = 0;
          while (probe) {
            const t = Date.now();
            const r = await h.post(`/api/projects/${other}/tx`, tx(0, [{ op: 'set', id: oroot, path: 'name', value: 'p' + (n++) }]));
            assert.equal(r.status, 201, r.text);
            nl.push(Date.now() - t);
            await sleep(20);
          }
        })();
        await sleep(100);
        const K = 6;
        const rs = await Promise.all(Array.from({ length: K }, () => h.post('/api/projects', body)));
        await sleep(200);
        probe = false;
        await pr;
        for (const r of rs) assert.equal(r.status, 201, r.text.slice(0, 200));
        const st = svc.importer.stats();
        assert.ok(st.worker >= K, 'импорты готовились в потоках: ' + JSON.stringify(st));
        const max = Math.max(...nl);
        assert.ok(max < 1000, `соседняя запись max ${max} мс (подготовка одного импорта в цикле — ${inlineMs} мс)`);
        // проект импорта — тот же документ
        const opened = (await h.get(`/api/projects/${rs[0].body.id}`)).body;
        assert.equal(Object.keys(opened.snapshot.doc.nodes).length, Object.keys(doc.nodes).length);
        assert.equal(opened.snapshot.doc.meta.name, 'буря импорта');
        // ошибки из потока — те же коды, что прежде
        const bad = await h.post('/api/projects', JSON.stringify({ name: 'x', doc: { ...doc, root: 'нет' } }));
        assert.equal(bad.status, 400, bad.text.slice(0, 200));
        assert.equal(bad.body.code, 'bad_request');
        const junk = await h.post('/api/projects', '{"name":"x","doc":' + JSON.stringify(doc).slice(0, 300000));
        assert.equal(junk.status, 400);
        assert.match(junk.body.message, /не JSON/);
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 33: пределы из окружения', () => {
  it('HEADS_BYTES, IMPORT_CONCURRENCY, IMPORT_QUEUE, SNAPSHOT_CACHE_BYTES — окружение, опция главнее, негодное — умолчание', async () => {
    const { limitsFrom } = await import('../../server/document/index.js');
    const L = await import('../../server/document/limits.js');
    const warns = [];
    const log = { warn: (m) => warns.push(String(m)) };
    const c = limitsFrom({ importQueue: 3 }, { HEADS_BYTES: '2097152', IMPORT_CONCURRENCY: '1', IMPORT_QUEUE: '5', SNAPSHOT_CACHE_BYTES: 'много' }, log);
    assert.equal(c.headsBytes, 2097152);
    assert.equal(c.importConcurrency, 1);
    assert.equal(c.importQueue, 3, 'опция главнее окружения');
    assert.equal(c.snapshotCacheBytes, L.SNAPSHOT_CACHE_BYTES);
    assert.equal(warns.length, 1);
    assert.equal(limitsFrom({}, { HEADS_BYTES: '1000' }, log).headsBytes, L.HEADS_BYTES, 'меньше 1 МиБ — умолчание');
  });
});

/* ------------------------------ 4. головы ------------------------------ */

describe('круг 33: головы секвенсора — под бюджетом байт (LRU)', () => {
  it('сверх бюджета выгружаются давние; открытая сокетом не выгружается; выгруженная поднимается со снимка · memory', async () => {
    const one = Buffer.byteLength(JSON.stringify(createDoc()));
    const svc = await startFor('memory', { headsBytes: Math.floor(one * 2.5), verifyMs: 0 });
    try {
      const h = api(svc.url);
      const ids = [];
      for (let i = 0; i < 6; i++) ids.push((await h.post('/api/projects', { name: 'г' + i, demo: true })).body.id);
      const roots = {};
      for (const id of ids) roots[id] = (await h.get(`/api/projects/${id}`)).body.snapshot.doc.root;
      // первый открыт сокетом — его голова держится
      const S = connect(wsUrl(svc, ids[0], { client: 'S', proto: '2' }));
      await S.opened;
      assert.equal((await S.next()).type, 'hello');
      for (const id of ids) {
        const r = await h.post(`/api/projects/${id}/tx`, tx(0, [{ op: 'set', id: roots[id], path: 'name', value: 'x' }]));
        assert.equal(r.status, 201, r.text);
      }
      const st = svc.dslts.stats();
      assert.ok(st.evicted >= 3, JSON.stringify(st));
      assert.ok(st.heads <= 3, JSON.stringify(st));
      assert.equal(svc.dslts.isLoaded(ids[0]), true, 'открытый сокетом — в памяти');
      assert.equal(svc.dslts.isLoaded(ids[5]), true, 'последний тронутый — в памяти');
      assert.equal(svc.dslts.isLoaded(ids[1]), false, 'давний — выгружен');
      // выгруженная голова поднимается, запись идёт дальше по номерам
      const r = await h.post(`/api/projects/${ids[1]}/tx`, tx(1, [{ op: 'set', id: roots[ids[1]], path: 'name', value: 'y' }]));
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.seq, 2);
      const head = await svc.dslts.headOf(ids[1]);
      assert.equal(head.doc.nodes[roots[ids[1]]].name, 'y');
      await S.close();
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 5–6. схема под работающим экземпляром ------------------------------ */

const DRIFT = `DROP TRIGGER IF EXISTS operations_size ON operations;
  ALTER TABLE operations DROP COLUMN IF EXISTS command_author, DROP COLUMN IF EXISTS ops_bytes, DROP COLUMN IF EXISTS ops_count, DROP COLUMN IF EXISTS undo_part;
  DELETE FROM schema_migrations WHERE name IN ('009_ops_size.mjs', '010_command_author.sql', '011_undo_part.sql')`;
const COLS_SQL = `SELECT coalesce(string_agg(attname, ',' ORDER BY attname), '') AS c FROM pg_attribute
  WHERE attrelid = to_regclass('operations') AND attnum > 0 AND NOT attisdropped AND attname IN ('ops_bytes', 'ops_count', 'command_author', 'undo_part')`;
const ALL_COLS = 'command_author,ops_bytes,ops_count,undo_part';

describe('круг 33: восстановление под работающим экземпляром — без DDL в пустую базу и во время pg_restore · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  let admin;
  before(async () => { admin = new pg.Pool({ connectionString: DB_URL, max: 3 }); });
  after(async () => { await admin.end().catch(() => {}); });
  const cols = async () => (await admin.query(COLS_SQL)).rows[0].c;

  it('к базе подключён pg_restore — phase restore, миграций нет; отключился — догнали', async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    const restorer = new pg.Client({ connectionString: DB_URL, application_name: 'pg_restore' });
    await restorer.connect();
    try {
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'до' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      await admin.query(DRIFT);
      const r = await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }]));
      assert.equal(r.status, 201, r.text);
      await sleep(1500);
      const health = await h.get('/api/health');
      assert.equal(health.status, 503, health.text);
      assert.equal(health.body.detail.storage, 'schema');
      assert.equal(health.body.detail.phase, 'restore');
      assert.equal(await cols(), '', 'пока идёт pg_restore — ни одной миграции');
      await restorer.end();
      await waitFor(async () => (await h.get('/api/health')).status === 200 && svc.storage.backfillState === null, 'догнали после pg_restore', 15000);
      assert.equal(await cols(), ALL_COLS);
    } finally {
      await restorer.end().catch(() => {});
      await svc.close();
    }
  });

  it('в учёте нет 001 (база пустая/чужая) — phase empty, DDL нет; учёт появился — догнали', async () => {
    const svc = await startFor('pg', { verifyMs: 0 });
    try {
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'пусто' })).body;
      await admin.query(DRIFT + `; DELETE FROM schema_migrations WHERE name = '001_init.sql'`);
      const r = await h.get(`/api/projects/${p.id}/ops?since=0`);
      assert.equal(r.status, 200, r.text);
      await sleep(1500);
      const health = await h.get('/api/health');
      assert.equal(health.status, 503, health.text);
      assert.equal(health.body.detail.phase, 'empty');
      assert.equal(await cols(), '', 'в пустую базу миграции не идут');
      await admin.query(`INSERT INTO schema_migrations (name) VALUES ('001_init.sql')`);
      await waitFor(async () => (await h.get('/api/health')).status === 200 && svc.storage.backfillState === null, 'догнали', 15000);
      assert.equal(await cols(), ALL_COLS);
    } finally {
      await svc.close();
    }
  });

  const tools = spawnSync('pg_restore', ['--version']).status === 0 && spawnSync('pg_dump', ['--version']).status === 0;
  it('dropdb; createdb; pg_restore в ту же базу: пока пусто — 503 empty и ни одной таблицы; pg_restore без ошибок; потом — всё на месте', { skip: tools ? false : 'нет pg_dump/pg_restore' }, async () => {
    const storage = pgStorage({ listenRetryMs: 50 });
    const { start } = await import('../../server/document/index.js');
    const svc = await start({ port: 0, storage, snapshotEvery: 50, pingInterval: 0, log: quiet, verifyMs: 0 });
    const url = new URL(DB_URL);
    const db = url.pathname.slice(1);
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
    const conn = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-restore33-'));
    const dump = path.join(dir, 'backup.dump');
    try {
      const h = api(svc.url);
      await storage.pool.query('TRUNCATE projects, operations, snapshots, project_epochs, traces CASCADE');
      const p = (await h.post('/api/projects', { name: 'копия', demo: true })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      assert.equal((await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'в копии' }]))).status, 201);
      await admin.end();
      execFileSync('pg_dump', [...conn, '-Fc', '-f', dump, db], { env });
      execFileSync('dropdb', [...conn, '--force', db], { env });
      execFileSync('createdb', [...conn, db], { env });
      // пустая база под работающим экземпляром: запросы идут, DDL — нет
      for (let i = 0; i < 10; i++) {
        await h.get(`/api/projects/${p.id}`);
        await h.get('/api/projects');
        await sleep(150);
      }
      const health = await h.get('/api/health');
      assert.equal(health.status, 503, health.text);
      assert.equal(health.body.detail.storage, 'schema');
      assert.ok(['empty', 'restore'].includes(health.body.detail.phase), health.text);
      const probe = new pg.Client({ connectionString: DB_URL });
      await probe.connect();
      const tables = (await probe.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
      await probe.end();
      assert.equal(tables, 0, 'в пустую базу экземпляр ничего не создал');
      const res = spawnSync('pg_restore', [...conn, '-d', db, dump], { env, encoding: 'utf8' });
      assert.equal(res.status, 0, 'pg_restore без ошибок: ' + res.stderr);
      await waitFor(async () => (await h.get('/api/health')).status === 200, 'после pg_restore — здоров', 20000);
      const opened = await h.get(`/api/projects/${p.id}`);
      assert.equal(opened.status, 200, opened.text);
      assert.equal(opened.body.head_seq, 1);
      const w = await h.post(`/api/projects/${p.id}/tx`, tx(1, [{ op: 'set', id: root, path: 'name', value: 'после' }], { author_kind: 'agent', command_author: 'Аня' }));
      assert.ok(w.status === 201, w.text);
      assert.equal(w.body.command_author, 'Аня');
      const check = new pg.Client({ connectionString: DB_URL });
      await check.connect();
      const names = (await check.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
      await check.end();
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3,}_/.test(f)).sort();
      assert.deepEqual(names, files, 'учёт миграций — ровно каталог, без дублей');
    } finally {
      admin = new pg.Pool({ connectionString: DB_URL, max: 3 });
      await svc.close();
    }
  });
});

describe('круг 33: дозаполнение 009 при сверке — после DDL 010/011 · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  let admin;
  let dir;
  before(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 3 });
    // каталог миграций, где дозаполнение 009 ждёт сигнала теста (долгое дозаполнение)
    dir = await mkdtemp(path.join(os.tmpdir(), 'imago-mig33-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (f !== '009_ops_size.mjs') await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const real = new URL('file://' + path.join(MIGRATIONS_DIR, '009_ops_size.mjs')).href;
    await writeFile(path.join(dir, '009_ops_size.mjs'), `export * from ${JSON.stringify(real)};
import { ddlUp, fillUp as realFill } from ${JSON.stringify(real)};
export async function fillUp(ctx) { await (globalThis.__imagoFillGate || Promise.resolve()); return realFill(ctx); }
export async function up(ctx) { await ddlUp(ctx); await fillUp(ctx); }
`);
  });
  after(async () => {
    globalThis.__imagoFillGate = undefined;
    await admin.end();
  });

  it('запись во время дозаполнения — с command_author и undo_part; health 200 с detail.backfill; потом учёт полон', async () => {
    globalThis.__imagoFillGate = undefined;
    const svc = await startFor('pg', { verifyMs: 0 }, { migrationsDir: dir });
    let open;
    try {
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'дозаполнение' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      await admin.query(DRIFT);
      globalThis.__imagoFillGate = new Promise((r) => { open = r; });
      const r = await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'x' }], { author_kind: 'agent', command_author: 'Аня', undo_of: 'tx_u', undo_part: { i: 0, n: 2 } }));
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.command_author, 'Аня', 'колонка 010 легла до дозаполнения 009');
      assert.deepEqual(r.body.undo_part, { i: 0, n: 2 });
      const health = await h.get('/api/health');
      assert.equal(health.status, 200, health.text);
      assert.equal(health.body.detail.backfill.migration, '009_ops_size.mjs');
      const applied = (await admin.query('SELECT name FROM schema_migrations WHERE name IN ($1, $2, $3) ORDER BY name', ['009_ops_size.mjs', '010_command_author.sql', '011_undo_part.sql'])).rows.map((x) => x.name);
      assert.deepEqual(applied, ['010_command_author.sql', '011_undo_part.sql'], '009 учтётся после дозаполнения');
      const r2 = await h.post(`/api/projects/${p.id}/tx`, tx(1, [{ op: 'set', id: root, path: 'name', value: 'y' }], { author_kind: 'agent', command_author: 'Борис' }));
      assert.equal(r2.body.command_author, 'Борис');
      open();
      await waitFor(() => svc.storage.backfillState === null, 'дозаполнение кончилось', 10000);
      const health2 = await h.get('/api/health');
      assert.equal(health2.status, 200);
      assert.equal(health2.body.detail, undefined);
      const all = (await admin.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1', ['009_ops_size.mjs'])).rows[0].n;
      assert.equal(all, 1);
      const nulls = (await admin.query('SELECT count(*)::int AS n FROM operations WHERE ops_bytes IS NULL OR ops_count IS NULL')).rows[0].n;
      assert.equal(nulls, 0);
      const authors = (await admin.query('SELECT command_author FROM operations WHERE project_id = $1 ORDER BY seq', [p.id])).rows.map((x) => x.command_author);
      assert.deepEqual(authors, ['Аня', 'Борис'], 'ни одна запись не потеряла command_author');
    } finally {
      if (open) open();
      await svc.close();
    }
  });
});

/* ------------------------------ 7. create_id ------------------------------ */

describe('круг 33 (L1): create_id — идемпотентное создание проекта', () => {
  for (const b of list) {
    it(`повтор с тем же create_id — 200 и тот же проект; одновременные — один; негодный — 400 · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const cid = 'rescue_' + uid('c').replace(/[^A-Za-z0-9_-]/g, '');
        const doc = createDoc();
        const r1 = await h.post('/api/projects', { name: 'спасение', doc, create_id: cid });
        assert.equal(r1.status, 201, r1.text);
        assert.equal(r1.body.existing, undefined);
        const r2 = await h.post('/api/projects', { name: 'спасение', doc, create_id: cid });
        assert.equal(r2.status, 200, r2.text);
        assert.equal(r2.body.id, r1.body.id);
        assert.equal(r2.body.existing, true);
        assert.equal(r2.body.epoch, r1.body.epoch);
        // голова проекта ушла вперёд — повтор отдаёт нынешнюю
        const root = (await h.get(`/api/projects/${r1.body.id}`)).body.snapshot.doc.root;
        const w = await h.post(`/api/projects/${r1.body.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'z' }]));
        const r3 = await h.post('/api/projects', { name: 'другое имя', create_id: cid });
        assert.equal(r3.status, 200);
        assert.equal(r3.body.head_seq, 1);
        assert.equal(r3.body.tip, w.body.chain || '');
        assert.equal(r3.body.name, 'спасение');
        // одновременные с новым create_id — ровно один проект
        const cid2 = 'import_' + Math.random().toString(36).slice(2, 12);
        const rs = await Promise.all(Array.from({ length: 6 }, () => h.post('/api/projects', { name: 'импорт', doc, create_id: cid2 })));
        assert.deepEqual([...new Set(rs.map((r) => r.body.id))].length, 1, rs.map((r) => r.status).join(','));
        assert.equal(rs.filter((r) => r.status === 201).length, 1);
        const all = (await h.get('/api/projects?limit=1000')).body.projects;
        assert.equal(all.filter((p) => p.name === 'спасение').length, 1);
        assert.equal(all.filter((p) => p.name === 'импорт').length, 1);
        // без create_id — как прежде, каждый раз новый
        const a = await h.post('/api/projects', { name: 'обычный' });
        const c = await h.post('/api/projects', { name: 'обычный' });
        assert.notEqual(a.body.id, c.body.id);
        for (const bad of ['short', 'с кириллицей_12', 'x'.repeat(65), 12345678, { a: 1 }, 'has space 123', 'a/b/c/d/e/f']) {
          const r = await h.post('/api/projects', { name: 'x', create_id: bad });
          assert.equal(r.status, 400, JSON.stringify(bad));
          assert.equal(r.body.detail.param, 'create_id');
        }
      } finally {
        await svc.close();
      }
    });
  }

  it('схема без 012 (экземпляр новой версии до миграции) — create_id не учитывается, отказа нет · pg', { skip: pgOk ? false : 'нет базы' }, async () => {
    const admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    const name = 'mig33_' + Math.random().toString(36).slice(2, 10);
    await admin.query(`CREATE SCHEMA ${name}`);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-mig33b-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (!f.startsWith('012_')) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const { createPgStorage } = await import('../../server/document/storage/pg.js');
    const old = createPgStorage({ connectionString: DB_URL, options: `-c search_path=${name}`, listen: false, log: quiet, migrationsDir: dir });
    try {
      await old.init();
      assert.equal(old.schemaFlags.createId, false);
      const a = await old.createProject({ name: 'a', kind: 'design', doc: createDoc('empty'), engine: E, createId: 'same_id_123' });
      const b = await old.createProject({ name: 'b', kind: 'design', doc: createDoc('empty'), engine: E, createId: 'same_id_123' });
      assert.notEqual(a.id, b.id);
      assert.equal(b.existing, undefined);
      const neu = createPgStorage({ connectionString: DB_URL, options: `-c search_path=${name}`, listen: false, log: quiet });
      try {
        await neu.init();
        assert.equal(neu.schemaFlags.createId, true);
        const c = await neu.createProject({ name: 'c', kind: 'design', docJson: JSON.stringify(createDoc('empty')), engine: E, createId: 'same_id_123' });
        const d = await neu.createProject({ name: 'd', kind: 'design', doc: createDoc('empty'), engine: E, createId: 'same_id_123' });
        assert.equal(d.id, c.id);
        assert.equal(d.existing, true);
        // старый экземпляр (колонку не знает) создаёт после 012 — без create_id, без отказа
        const e = await old.createProject({ name: 'e', kind: 'design', doc: createDoc('empty'), engine: E });
        assert.ok(e.id);
      } finally {
        await neu.close();
      }
    } finally {
      await old.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
      await admin.end();
    }
  });
});

/* ------------------------------ 8. догон чистит подписи ------------------------------ */

describe('круг 33: догон (ops?since, сокет) — подписи старых записей чистые', () => {
  it('author/title/command_author с RLO и BEL, записанные до чистки, — чистыми в ops?since и в сокете · memory', async () => {
    const svc = await startFor('memory');
    try {
      const h = api(svc.url);
      const p = (await h.post('/api/projects', { name: 'старое' })).body;
      const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
      const c = await h.post(`/api/projects/${p.id}/tx`, tx(0, [{ op: 'set', id: root, path: 'name', value: 'a‮b' }], { author: 'Аня' }));
      assert.equal(c.status, 201);
      // запись прежней версии: подписи нечищеные прямо в хранилище
      const b = svc.storage.backup();
      const row = b.journals.get(p.id).bySeq[0];
      row.author = 'Ст‮арый\u0007';
      row.title = 'Т⁦итул';
      row.command_author = '‮\u0007';
      svc.storage.restore(b);
      const ops = (await h.get(`/api/projects/${p.id}/ops?since=0`)).body.txs[0];
      assert.equal(ops.author, 'Старый');
      assert.equal(ops.title, 'Титул');
      assert.equal('command_author' in ops, false, 'пустое после чистки — поля нет');
      assert.equal(ops.ops[0].value, 'a‮b', 'содержимое документа не трогается');
      const s = connect(wsUrl(svc, p.id, { client: 'k', since: '0', proto: '2' }));
      await s.opened;
      assert.equal((await s.next()).type, 'hello');
      const t = await s.until((m) => m.type === 'tx');
      assert.equal(t.tx.author, 'Старый');
      assert.equal(t.tx.title, 'Титул');
      assert.equal('command_author' in t.tx, false);
      await s.close();
    } finally {
      await svc.close();
    }
  });
});

/* ------------------------------ 9. кеш снимков ------------------------------ */

describe('круг 33: снимок полного открытия — одна сериализация на (проект, seq, chain)', () => {
  for (const b of list) {
    it(`30 одновременных открытий — одно чтение; новый снимок — новое чтение; ответ тот же · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name, { snapshotEvery: 2 });
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'кеш', demo: true })).body;
        const s0 = svc.dslr.snapshotCacheStats();
        const rs = await Promise.all(Array.from({ length: 30 }, () => h.get(`/api/projects/${p.id}`)));
        for (const r of rs) assert.equal(r.status, 200);
        const s1 = svc.dslr.snapshotCacheStats();
        assert.equal(s1.loads - s0.loads, 1, JSON.stringify(s1));
        assert.equal(rs[0].text, rs[29].text);
        const body = rs[0].body;
        assert.equal(body.id, p.id);
        assert.equal(body.snapshot.seq, 0);
        assert.deepEqual(Object.keys(body).slice(-3), ['snapshot', 'tail', 'more']);
        const root = body.snapshot.doc.root;
        for (let i = 0; i < 2; i++) {
          const r = await h.post(`/api/projects/${p.id}/tx`, tx(i, [{ op: 'set', id: root, path: 'name', value: 'v' + i }]));
          assert.equal(r.status, 201);
        }
        await svc.dslts.flush();
        const after = (await h.get(`/api/projects/${p.id}`)).body;
        assert.equal(after.snapshot.seq, 2);
        assert.equal(after.snapshot.doc.nodes[root].name, 'v1');
        assert.equal(after.tail.length, 0);
        assert.equal(svc.dslr.snapshotCacheStats().loads - s0.loads, 2);
        // и lean не трогает кеш
        const lean = (await h.get(`/api/projects/${p.id}?lean=1`)).body;
        assert.equal(lean.snapshot.doc, undefined);
      } finally {
        await svc.close();
      }
    });
  }
});
