/**
 * Круг 32 — Document service: часть большой правки `undo_part {i, n}` хранится (миграция 011)
 * и отдаётся в Committed, рассылке, `ops?since` и `/history` вместе с `undo_of`/`redo_of`;
 * негодное значение — не ошибка, поля просто нет; миграция 011 безопасна для смешанных версий.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDoc, uid, ENGINE_VERSION } from '../../src/core.js';
import { createPgStorage, MIGRATIONS_DIR } from '../../server/document/storage/pg.js';
import { undoPartOf, MAX_UNDO_PARTS } from '../../server/document/limits.js';
import { backends, startFor, api, connect, wsUrl, pgAvailable, DB_URL, quiet } from './helpers.mjs';

const E = ENGINE_VERSION;
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });

const list = await backends();
const pgOk = await pgAvailable();

describe('круг 32: undoPartOf — только годная пара {i, n}', () => {
  it('целые, 2 ≤ n ≤ MAX_UNDO_PARTS, 0 ≤ i < n; иначе null', () => {
    assert.deepEqual(undoPartOf({ i: 0, n: 2 }), { i: 0, n: 2 });
    assert.deepEqual(undoPartOf({ i: 2, n: 3, лишнее: 1 }), { i: 2, n: 3 }, 'лишние поля отбрасываются');
    assert.deepEqual(undoPartOf({ i: MAX_UNDO_PARTS - 1, n: MAX_UNDO_PARTS }), { i: MAX_UNDO_PARTS - 1, n: MAX_UNDO_PARTS });
    for (const bad of [null, undefined, 1, 'x', [], [0, 2], { i: 0, n: 1 }, { i: 2, n: 2 }, { i: -1, n: 3 }, { i: 0.5, n: 3 },
      { i: '0', n: 3 }, { i: 0, n: MAX_UNDO_PARTS + 1 }, { i: 0, n: Infinity }, { toString: 1, i: 'x' }, { i: 0, n: 2 ** 60 }]) {
      assert.equal(undoPartOf(bad), null, JSON.stringify(bad));
    }
  });
});

describe('круг 32 (K1): undo_part хранится и отдаётся — Committed, рассылка, ops, /history', () => {
  for (const b of list) {
    it(`части отмены и импорта несут undo_part и undo_of; кривое — без поля · ${b.name}`, { skip: !b.available }, async () => {
      const svc = await startFor(b.name);
      try {
        const h = api(svc.url);
        const p = (await h.post('/api/projects', { name: 'части' })).body;
        const root = (await h.get(`/api/projects/${p.id}`)).body.snapshot.doc.root;
        const set = (seq, v, extra) => tx(seq, [{ op: 'set', id: root, path: 'name', value: v }], extra);
        const first = await h.post(`/api/projects/${p.id}/tx`, set(0, 'a'));
        assert.equal(first.status, 201);
        assert.equal(first.body.undo_part, undefined, 'правка одной транзакцией — без поля');
        const undoOf = first.body.tx_id;
        // сокет слушает рассылку
        const c = connect(wsUrl(svc, p.id, { client: 'cv', proto: '2' }));
        await c.opened;
        await c.until((m) => m.type === 'hello');
        const r1 = await h.post(`/api/projects/${p.id}/tx`, set(1, 'b', { undo_of: undoOf, undo_part: { i: 0, n: 2 } }));
        assert.equal(r1.status, 201, r1.text);
        assert.deepEqual(r1.body.undo_part, { i: 0, n: 2 }, 'Committed несёт часть');
        const live = await c.until((m) => m.type === 'tx' && m.tx.tx_id === r1.body.tx_id);
        assert.deepEqual(live.tx.undo_part, { i: 0, n: 2 }, 'рассылка несёт часть');
        assert.equal(live.tx.undo_of, undoOf);
        const r2 = await h.post(`/api/projects/${p.id}/tx`, set(2, 'c', { undo_of: undoOf, undo_part: { i: 1, n: 2, лишнее: 'x' } }));
        assert.deepEqual(r2.body.undo_part, { i: 1, n: 2 });
        // части импорта: без undo_of, только undo_part
        const r3 = await h.post(`/api/projects/${p.id}/tx`, set(3, 'd', { undo_part: { i: 0, n: 3 } }));
        assert.deepEqual(r3.body.undo_part, { i: 0, n: 3 });
        // кривое — правка принята, поля нет
        for (const [k, bad] of [[4, { i: 3, n: 3 }], [5, { toString: 1 }], [6, 'часть'], [7, { i: 0, n: 1 }]]) {
          const r = await h.post(`/api/projects/${p.id}/tx`, set(k, 'x' + k, { undo_part: bad }));
          assert.equal(r.status, 201, r.text);
          assert.equal(r.body.undo_part, undefined, JSON.stringify(bad));
        }
        // повтор того же tx_id — то же
        const again = await h.post(`/api/projects/${p.id}/tx`, { ...set(1, 'b', { undo_of: undoOf, undo_part: { i: 0, n: 2 } }), tx_id: r1.body.tx_id });
        assert.equal(again.status, 200);
        assert.deepEqual(again.body.undo_part, { i: 0, n: 2 });
        await c.close();

        const ops = (await h.get(`/api/projects/${p.id}/ops?since=0`)).body.txs;
        assert.deepEqual(ops.map((t) => t.undo_part), [undefined, { i: 0, n: 2 }, { i: 1, n: 2 }, { i: 0, n: 3 }, undefined, undefined, undefined, undefined]);
        // догон сокетом — тоже с частью
        const c2 = connect(wsUrl(svc, p.id, { client: 'cw', since: 1, proto: '2' }));
        await c2.opened;
        const caught = await c2.until((m) => m.type === 'tx' && m.tx.seq === 3);
        assert.deepEqual(caught.tx.undo_part, { i: 1, n: 2 });
        await c2.close();

        const hist = (await h.get(`/api/projects/${p.id}/history`)).body.items;
        assert.equal(hist.length, 8);
        const bySeq = new Map(hist.map((t) => [t.seq, t]));
        assert.deepEqual(bySeq.get(2).undo_part, { i: 0, n: 2 });
        assert.equal(bySeq.get(2).undo_of, undoOf, '/history отдаёт undo_of');
        assert.equal(bySeq.get(2).redo_of, null);
        assert.deepEqual(bySeq.get(3).undo_part, { i: 1, n: 2 });
        assert.deepEqual(bySeq.get(4).undo_part, { i: 0, n: 3 });
        assert.equal(bySeq.get(4).undo_of, null);
        assert.equal(bySeq.get(1).undo_part, null, 'нет части — null');
        assert.equal(bySeq.get(5).undo_part, null);
        // повтор (redo_of) — тоже в /history
        const r9 = await h.post(`/api/projects/${p.id}/tx`, set(8, 'r', { redo_of: undoOf, undo_part: { i: 0, n: 2 } }));
        const top = (await h.get(`/api/projects/${p.id}/history?limit=1`)).body.items[0];
        assert.equal(top.tx_id, r9.body.tx_id);
        assert.equal(top.redo_of, undoOf);
        assert.deepEqual(top.undo_part, { i: 0, n: 2 });
      } finally {
        await svc.close();
      }
    });
  }
});

describe('круг 32: миграция 011 (undo_part) — смешанные версии · pg', { skip: pgOk ? false : 'нет базы' }, () => {
  let admin;
  const schemas = [];
  before(async () => { admin = new pg.Pool({ connectionString: DB_URL, max: 2 }); });
  after(async () => {
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
    await admin.end();
  });
  const storageIn = (name, opts = {}) => createPgStorage({ connectionString: DB_URL, options: `-c search_path=${name}`, listen: false, log: quiet, ...opts });

  it('экземпляр без 011 пишет и читает; после 011 — часть пишется; старый экземпляр после 011 не ломается', async () => {
    const name = 'mig32_' + Math.random().toString(36).slice(2, 10);
    await admin.query(`CREATE SCHEMA ${name}`);
    schemas.push(name);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'imago-mig32-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (!f.startsWith('011_')) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));

    const old = storageIn(name, { migrationsDir: dir });
    await old.init();
    assert.equal(old.schemaFlags.undoPart, false, 'схема без 011 — колонки нет');
    const neu = storageIn(name);
    try {
      const p = await old.createProject({ name: 'смесь', kind: 'design', doc: createDoc('empty'), engine: E });
      const c1 = await old.commitTx(p.id, tx(0, [], { undo_of: 'tx_a', undo_part: { i: 0, n: 2 } }));
      assert.equal(c1.status, 'committed');
      assert.equal(c1.committed.undo_part, undefined, 'схема без 011 — части нет, отказа нет');
      assert.equal(c1.committed.undo_of, 'tx_a');
      const m1 = (await old.recentTxMeta(p.id))[0];
      assert.equal(m1.undo_part, null);
      assert.equal(m1.undo_of, 'tx_a', 'undo_of — колонка с круга 22, есть всегда');

      await neu.init();   // 011 ложится при живом старом экземпляре
      assert.equal(neu.schemaFlags.undoPart, true);
      const cols = await admin.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'operations' AND column_name = 'undo_part'`, [name]);
      assert.equal(cols.rowCount, 1, 'колонка есть');
      assert.equal(cols.rows[0].data_type, 'jsonb');
      const c2 = await neu.commitTx(p.id, tx(1, [], { undo_of: 'tx_a', undo_part: { i: 1, n: 2 } }));
      assert.deepEqual(c2.committed.undo_part, { i: 1, n: 2 });
      assert.deepEqual((await neu.findTx(p.id, c2.committed.tx_id)).undo_part, { i: 1, n: 2 });
      // старый экземпляр (колонку не знает) пишет после миграции — без части, без отказа
      const c3 = await old.commitTx(p.id, tx(2, [], { undo_part: { i: 0, n: 2 } }));
      assert.equal(c3.status, 'committed');
      const page = await neu.txsAfter(p.id, 0);
      assert.deepEqual(page.map((t) => t.undo_part), [undefined, { i: 1, n: 2 }, undefined]);
      assert.deepEqual((await neu.recentTxMeta(p.id)).map((m) => m.undo_part), [null, { i: 1, n: 2 }, null]);
      // и старый читает журнал, в котором часть уже есть
      assert.deepEqual((await old.txsAfter(p.id, 0)).map((t) => t.seq), [1, 2, 3]);
      // мусор в колонке (руками) — не роняет чтение, поля нет
      await admin.query(`UPDATE ${name}.operations SET undo_part = '{"i": "x"}'::jsonb WHERE seq = 3`);
      assert.equal((await neu.txsAfter(p.id, 2))[0].undo_part, undefined);
      assert.equal((await neu.recentTxMeta(p.id))[0].undo_part, null);
    } finally {
      await old.close();
      await neu.close();
    }
  });
});
