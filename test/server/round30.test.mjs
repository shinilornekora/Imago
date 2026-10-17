/**
 * Круг 30 — Document service: чтения журнала самого секвенсора идут мимо предела чтений
 * анонимов (`internal: true`), импорт документа — `checkImportDoc(d, {maxNodes})` с 400 и
 * `detail: {limit, max}`, имя автора команды агента (`command_author`) — в журнале,
 * рассылке и `/history`; миграция 010 — безопасно для смешанных версий.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDoc, uid, ENGINE_VERSION } from '../../src/core.js';
import { createSequencer } from '../../server/document/dslts.js';
import { createPgStorage, MIGRATIONS_DIR } from '../../server/document/storage/pg.js';
import { backends, startFor, api, pgAvailable, pgStorage, DB_URL, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });

const list = await backends();
const pgOk = await pgAvailable();

describe('круг 30: чтения журнала секвенсора — мимо предела чтений анонимов', () => {
  it('шторм журнальных чтений: загрузка головы и её сверка не ждут места (DB_TIMEOUT_MS) · pg', { skip: !pgOk }, async () => {
    // одно место под журнальные чтения и долгое ожидание: прежде голова секвенсора вставала
    // в эту очередь за анонимами и ждала до journalReadWaitMs (затем 503 busy)
    const WAIT = 8000;
    const s = pgStorage({ max: 10, listen: false, journalReads: 1, journalReadQueue: 64, journalReadWaitMs: WAIT });
    await s.init();
    const a = createSequencer({ storage: s, verifyMs: 0, log: quiet });
    const b = createSequencer({ storage: s, verifyMs: 0, log: quiet });
    let release;
    const stalled = new Promise((r) => { release = r; });
    const q = s.pool.query.bind(s.pool);
    try {
      const p = await s.createProject({ name: 'шторм', kind: 'design', doc: createDoc('empty'), engine: E });
      const root = (await s.latestSnapshot(p.id)).doc.root;
      const set = (base, v) => tx(base, [{ op: 'set', id: root, path: 'name', value: v }]);
      for (let i = 0; i < 3; i++) await a.commit(p.id, set(i, 'a' + i));

      // аноним занял единственное место (история повисла в базе) и ещё пятеро ждут
      s.pool.query = (sql, ...rest) => (typeof sql === 'string' && sql.includes('dropped_count')
        ? stalled.then(() => q(sql, ...rest)) : q(sql, ...rest));
      const hold = s.recentTxMeta(p.id).catch((e) => e);
      await sleep(30);
      assert.equal(s.journalReads.active, 1);
      const anon = Array.from({ length: 5 }, () => s.txsAfter(p.id, 0).then((x) => x.length, (e) => e.code));
      await sleep(30);
      assert.equal(s.journalReads.waiting, 5, 'анонимы ждут места');

      // b — голова не загружена: загрузка читает журнал от снимка
      let t = Date.now();
      const rb = await b.commit(p.id, set(3, 'b'));
      const loadMs = Date.now() - t;
      assert.equal(rb.committed.seq, 4);
      assert.ok(loadMs < WAIT / 2, `загрузка головы не ждёт за анонимами: ${loadMs} мс`);

      // a — голова отстала (b записал мимо неё): сверка догоняет журнал
      t = Date.now();
      const ra = await a.commit(p.id, set(4, 'a-again'));
      const syncMs = Date.now() - t;
      assert.equal(ra.committed.seq, 5);
      assert.ok(syncMs < WAIT / 2, `сверка головы не ждёт за анонимами: ${syncMs} мс`);
      assert.equal(s.journalReads.waiting, 5, 'анонимы всё ещё ждут — секвенсор прошёл мимо них');

      release();
      const meta = await hold;
      assert.ok(Array.isArray(meta), 'история дождалась');
      assert.deepEqual(await Promise.all(anon), [5, 5, 5, 5, 5], 'анонимы дочитали после');
    } finally {
      release();
      s.pool.query = q;
      await a.close();
      await b.close();
      await s.close();
    }
  });
});

describe('круг 30: импорт документа — checkImportDoc с пределом сервиса, 400 и detail {limit, max}', () => {
  const chain = (depth) => {
    const d = createDoc('empty');
    const nodes = JSON.parse(JSON.stringify(d.nodes));
    let par = d.root;
    for (let i = 0; i < depth; i++) {
      const id = 'd' + i;
      nodes[id] = { id, type: 'frame', name: id, parent: par, children: [] };
      nodes[par].children = [...(nodes[par].children || []), id];
      par = id;
    }
    return { ...d, nodes };
  };
  for (const b of list) {
    it(`глубина — limit:depth, max; форма поля — limit:import; годный документ — 201 · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const deep = await h.post('/api/projects', { name: 'deep', doc: chain(300) });
        assert.equal(deep.status, 400, deep.text.slice(0, 300));
        assert.equal(deep.body.code, 'bad_request');
        assert.deepEqual(deep.body.detail, { limit: 'depth', max: 256 });
        assert.match(deep.body.message, /вложенность глубже 256/);

        // объект в style.token: прежде ответ движка {code, message} считался «годен»
        const demo = createDoc();
        const bad = JSON.parse(JSON.stringify(demo));
        const text = Object.values(bad.nodes).find((n) => n.type === 'text');
        text.style = { token: { toString: 1 } };
        const r = await h.post('/api/projects', { name: 'bad', doc: bad });
        assert.equal(r.status, 400, r.text.slice(0, 300));
        assert.equal(r.body.detail.limit, 'import');
        assert.match(r.body.message, new RegExp(text.id));

        // id внутри узла не совпадает с ключом — тоже отказ движка
        const mism = JSON.parse(JSON.stringify(demo));
        const any = Object.keys(mism.nodes).find((k) => k !== mism.root);
        mism.nodes[any].id = 'другой';
        assert.equal((await h.post('/api/projects', { name: 'mism', doc: mism })).status, 400);

        // документ самого движка (демо, экспорт JSON) проходит
        const ok = await h.post('/api/projects', { name: 'ok', doc: demo });
        assert.equal(ok.status, 201, ok.text.slice(0, 300));
        assert.equal((await h.post('/api/projects', { name: 'ok200', doc: chain(200) })).status, 201);
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 30: command_author — имя автора команды агента в журнале и истории', () => {
  for (const b of list) {
    it(`пишется, рассылается, отдаётся /history; негодное — без поля; длинное — 200 знаков · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'кто' })).body;
        const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
        const set = (base, v, extra) => tx(base, [{ op: 'set', id: root, path: 'name', value: v }], extra);
        let r = await h.post(`/api/projects/${p.id}/tx`, set(0, 'a', { author: 'Агент', author_kind: 'agent', command_id: 'cmd_1', command_author: 'Аня' }));
        assert.equal(r.status, 201, r.text);
        assert.equal(r.body.command_author, 'Аня', 'Committed несёт имя');
        r = await h.post(`/api/projects/${p.id}/tx`, set(1, 'b', { author: 'Борис' }));
        assert.equal(r.body.command_author, undefined, 'у человеческой правки поля нет');
        r = await h.post(`/api/projects/${p.id}/tx`, set(2, 'c', { author_kind: 'agent', command_author: { toString: 1 } }));
        assert.equal(r.status, 201, 'негодное имя не губит правку');
        assert.equal(r.body.command_author, undefined);
        r = await h.post(`/api/projects/${p.id}/tx`, set(3, 'd', { author_kind: 'agent', command_author: '   ' }));
        assert.equal(r.body.command_author, undefined, 'пустое — без поля');
        r = await h.post(`/api/projects/${p.id}/tx`, set(4, 'e', { author_kind: 'agent', command_author: 'я'.repeat(300) + '\u0000' }));
        assert.equal(r.status, 201);
        assert.equal(r.body.command_author, 'я'.repeat(200), 'обрезано до 200 и очищено');

        const ops = (await h.get(`/api/projects/${p.id}/ops?since=0`)).body;
        assert.deepEqual(ops.txs.map((t) => t.command_author), ['Аня', undefined, undefined, undefined, 'я'.repeat(200)]);
        const hist = (await h.get(`/api/projects/${p.id}/history`)).body;
        assert.deepEqual(hist.items.map((t) => t.command_author), ['я'.repeat(200), null, null, null, 'Аня']);
        assert.equal(hist.items[4].command_id, 'cmd_1');

        // повтор того же tx_id — та же запись с тем же именем
        const again = await h.post(`/api/projects/${p.id}/tx`, { ...ops.txs[0], base_seq: 0, engine: E, ops: ops.txs[0].ops });
        assert.equal(again.body.seq, 1);
        assert.equal(again.body.command_author, 'Аня');
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 30: миграция 010 (command_author) — смешанные версии · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  let admin;
  const schemas = [];
  before(async () => { admin = new pg.Pool({ connectionString: DB_URL, max: 2 }); });
  after(async () => {
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
    await admin.end();
  });
  const storageIn = (name, opts = {}) => createPgStorage({ connectionString: DB_URL, options: `-c search_path=${name}`, listen: false, log: quiet, ...opts });

  it('экземпляр без 010 пишет и читает; после 010 — имя пишется; старый экземпляр после 010 не ломается', async () => {
    const name = 'mig30_' + Math.random().toString(36).slice(2, 10);
    await admin.query(`CREATE SCHEMA ${name}`);
    schemas.push(name);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-mig30-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (!f.startsWith('010_')) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));

    const old = storageIn(name, { migrationsDir: dir });
    await old.init();
    const neu = storageIn(name);
    try {
      const p = await old.createProject({ name: 'смесь', kind: 'design', doc: createDoc('empty'), engine: E });
      const c1 = await old.commitTx(p.id, tx(0, [], { author_kind: 'agent', command_author: 'Аня' }));
      assert.equal(c1.status, 'committed');
      assert.equal(c1.committed.command_author, undefined, 'схема без 010 — имени нет, отказа нет');
      assert.equal((await old.recentTxMeta(p.id))[0].command_author, null);

      await neu.init();   // 010 ложится при живом старом экземпляре
      const cols = await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'operations' AND column_name = 'command_author'`, [name]);
      assert.equal(cols.rowCount, 1, 'колонка есть');
      const c2 = await neu.commitTx(p.id, tx(1, [], { author_kind: 'agent', command_author: 'Борис' }));
      assert.equal(c2.committed.command_author, 'Борис');
      assert.equal((await neu.findTx(p.id, c2.committed.tx_id)).command_author, 'Борис');
      // старый экземпляр (колонку не знает) пишет после миграции — запись без имени, без отказа
      const c3 = await old.commitTx(p.id, tx(2, [], { author_kind: 'agent', command_author: 'Вера' }));
      assert.equal(c3.status, 'committed');
      const page = await neu.txsAfter(p.id, 0);
      assert.deepEqual(page.map((t) => t.command_author), [undefined, 'Борис', undefined]);
      assert.deepEqual((await neu.recentTxMeta(p.id)).map((m) => m.command_author), [null, 'Борис', null]);
      // и старый читает журнал, в котором имя уже есть
      assert.deepEqual((await old.txsAfter(p.id, 0)).map((t) => t.seq), [1, 2, 3]);
    } finally {
      await old.close();
      await neu.close();
    }
  });
});
