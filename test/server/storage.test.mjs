/**
 * Адаптеры хранилища (server/document/storage): один контракт — память и
 * Postgres. Главное здесь — семантика commitTx (SPEC §9.4, п.3): номер головы
 * не уходит вперёд без записи, повтор tx_id отдаёт сохранённое, чужой номер
 * головы даёт stale, а не запись «не туда».
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, ENGINE_VERSION, uid, ops } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createPgStorage } from '../../server/document/storage/pg.js';
import { backends, DB_URL } from './helpers.mjs';

const E = ENGINE_VERSION;
const record = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, dropped: [], notes: [], author_kind: 'human', engine: E, ...extra });

const list = await backends();

for (const backend of list) {
  describe(`storage · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let storage;
    before(async () => {
      storage = backend.name === 'pg'
        ? createPgStorage({ connectionString: DB_URL, log: { info() {}, warn() {} } })
        : createMemoryStorage();
      await storage.init();
      if (backend.name === 'pg') await storage.pool.query('TRUNCATE projects, operations, snapshots, library_versions, project_imports CASCADE');
    });
    after(async () => {
      await storage.close();
    });

    it('createProject пишет снимок seq 0; getProject/listProjects/renameProject', async () => {
      const doc = createDoc('empty');
      const p = await storage.createProject({ name: 'Один', kind: 'design', doc, engine: E });
      assert.match(p.id, /^[0-9a-f-]{36}$/);
      assert.equal(p.head_seq, 0);
      assert.equal(p.engine, E);
      assert.equal(typeof p.updated_at, 'string');
      const snap = await storage.latestSnapshot(p.id);
      assert.equal(snap.seq, 0);
      assert.equal(snap.doc.root, doc.root);
      assert.equal(snap.engine, E);
      assert.deepEqual(await storage.txsAfter(p.id, 0), []);

      assert.equal((await storage.getProject(p.id)).name, 'Один');
      assert.equal(await storage.getProject('00000000-0000-4000-8000-000000000000'), null);
      assert.equal(await storage.getProject('мусор'), null);
      assert.ok((await storage.listProjects()).some((x) => x.id === p.id));
      assert.equal((await storage.renameProject(p.id, 'Два')).name, 'Два');
      assert.equal(await storage.renameProject('00000000-0000-4000-8000-000000000000', 'x'), null);
      // снимок хранится копией: правка документа снаружи её не трогает
      doc.root = 'подмена';
      assert.equal((await storage.latestSnapshot(p.id)).doc.root, snap.doc.root);
    });

    it('commitTx: номера подряд, повтор tx_id → existing без сдвига головы, stale при чужом номере, missing без проекта', async () => {
      const p = await storage.createProject({ name: 'Ж', kind: 'design', doc: createDoc('empty'), engine: E });
      const a = record(0, [ops.setToken('colors.accent', '#000000')], { author: 'А', title: 'первая', undo_of: 'tx_prev' });
      const r1 = await storage.commitTx(p.id, a, { expectSeq: 1 });
      assert.equal(r1.status, 'committed');
      assert.equal(r1.committed.seq, 1);
      assert.equal(r1.committed.tx_id, a.tx_id);
      assert.equal(r1.committed.undo_of, 'tx_prev');
      assert.equal(r1.committed.author, 'А');
      assert.equal(r1.committed.title, 'первая');
      assert.equal('redo_of' in r1.committed, false, 'пустые необязательные поля не отдаются');
      assert.equal('client' in r1.committed, false);
      assert.match(r1.committed.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);

      const again = await storage.commitTx(p.id, a, { expectSeq: 2 });
      assert.equal(again.status, 'existing');
      assert.deepEqual(again.committed, r1.committed);
      assert.equal((await storage.getProject(p.id)).head_seq, 1, 'повтор не двигает голову');

      const stale = await storage.commitTx(p.id, record(1, []), { expectSeq: 5 });
      assert.equal(stale.status, 'stale');
      assert.equal(stale.head_seq, 1);
      assert.equal((await storage.getProject(p.id)).head_seq, 1, 'stale откатывает номер');
      assert.deepEqual((await storage.txsAfter(p.id, 0)).map((t) => t.seq), [1]);

      const b = await storage.commitTx(p.id, record(1, []));
      assert.equal(b.status, 'committed');
      assert.equal(b.committed.seq, 2);
      assert.equal((await storage.findTx(p.id, b.committed.tx_id)).seq, 2);
      assert.equal(await storage.findTx(p.id, 'нет такой'), null);

      assert.equal((await storage.commitTx('00000000-0000-4000-8000-000000000000', record(0, []))).status, 'missing');
      assert.equal((await storage.commitTx('мусор', record(0, []))).status, 'missing');
    });

    it('txsAfter: с seq, с пределом; writeSnapshot идемпотентен и latestSnapshot отдаёт старший', async () => {
      const p = await storage.createProject({ name: 'Х', kind: 'library', doc: createDoc('empty'), engine: E });
      for (let i = 0; i < 5; i++) await storage.commitTx(p.id, record(i, [ops.setToken('spacing', [i + 1])]));
      assert.deepEqual((await storage.txsAfter(p.id, 2)).map((t) => t.seq), [3, 4, 5]);
      assert.deepEqual((await storage.txsAfter(p.id, 0, 2)).map((t) => t.seq), [1, 2]);
      assert.deepEqual((await storage.txsAfter(p.id, 5)), []);
      const doc = createDoc('empty');
      await storage.writeSnapshot(p.id, 3, doc, E);
      await storage.writeSnapshot(p.id, 3, createDoc('empty'), E);   // повтор — DO NOTHING
      const snap = await storage.latestSnapshot(p.id);
      assert.equal(snap.seq, 3);
      assert.equal(snap.doc.root, doc.root);
      assert.equal((await storage.getProject(p.id)).kind, 'library');
    });

    it('параллельные commitTx с разными tx_id получают разные номера подряд', async () => {
      const p = await storage.createProject({ name: 'П', kind: 'design', doc: createDoc('empty'), engine: E });
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => storage.commitTx(p.id, record(0, [], { title: 'п' + i }))));
      assert.deepEqual(results.map((r) => r.status), Array(6).fill('committed'));
      assert.deepEqual(results.map((r) => r.committed.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
      assert.equal((await storage.getProject(p.id)).head_seq, 6);
    });
  });
}
