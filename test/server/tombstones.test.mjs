/**
 * Надгробия переживают снимок (SPEC §9.10, круг 25): голова, загруженная со снимка,
 * знает удалённые до него узлы — из `snapshot.tombstones`, а не только из `remove` в
 * хвосте. Иначе одна и та же офлайн-транзакция (create в группе, удалённой до снимка)
 * давала в долгоживущей голове `reparented`, а в свежей — `orphan`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { artboards, uid, ENGINE_VERSION } from '../../src/core.js';
import { backends, startFor, startTwin, api } from './helpers.mjs';

const E = ENGINE_VERSION;
const tx = (base_seq, list, extra = {}) => ({ tx_id: uid('tx'), base_seq, ops: list, engine: E, ...extra });
const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const group = (parent) => ({
  type: 'frame', id: uid('f'), name: 'Группа', parent, children: [], radius: 0, size: HUG,
  layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
});
const child = (parent) => ({ op: 'create', node: { type: 'text', id: uid('n'), name: 'офлайн', parent, characters: 'из офлайна', style: { token: 'body' }, align: 'left', color: '#14161C', size: HUG } });

const list = await backends();

for (const backend of list) {
  describe(`надгробия в снимке · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let A;
    let B;
    before(async () => {
      A = await startFor(backend.name, { verifyMs: 0 });
      B = await startTwin(backend.name, A, { verifyMs: 0 });
    });
    after(async () => {
      await B.close();
      await A.close();
    });

    /** Группа создана (seq 1), удалена (seq 2), потом 55 транзакций — снимок на seq 50 уже без группы. */
    async function removedBeforeSnapshot() {
      const h = api(A.url);
      const created = await h.post('/api/projects', { name: 'Надгробия', demo: true });
      const id = created.body.id;
      const board = artboards((await h.get('/api/projects/' + id)).body.snapshot.doc)[0];
      const g = group(board.id);
      const c = await h.post(`/api/projects/${id}/tx`, tx(0, [{ op: 'create', node: g }]));
      assert.equal(c.status, 201);
      const r = await h.post(`/api/projects/${id}/tx`, tx(1, [{ op: 'remove', id: g.id }]));
      assert.equal(r.body.seq, 2);
      for (let i = 0; i < 55; i++) {
        const t = await h.post(`/api/projects/${id}/tx`, tx(0, [{ op: 'setToken', path: 'colors.x', value: '#00000' + (i % 10) }]));
        assert.equal(t.status, 201);
      }
      await A.dslts.flush();
      const snap = await A.storage.latestSnapshot(id);
      assert.equal(snap.seq, 50, 'снимок после удаления');
      assert.equal(snap.doc.nodes[g.id], undefined);
      assert.equal(snap.tombstones && snap.tombstones[g.id], board.id, 'надгробие группы — в снимке');
      return { id, board, g };
    }

    it('одна и та же офлайн-транзакция даёт один исход в долгоживущей голове (A) и в загруженной со снимка (B)', async () => {
      const { id, board, g } = await removedBeforeSnapshot();
      assert.equal(B.dslts.isLoaded(id), false, 'у B головы ещё нет — загрузит со снимка');
      const viaA = await api(A.url).post(`/api/projects/${id}/tx`, tx(1, [child(g.id)]));
      // B ещё не загружал голову: загрузит снимок seq 50 + хвост — remove группы в хвосте нет
      const viaB = await api(B.url).post(`/api/projects/${id}/tx`, tx(1, [child(g.id)]));
      for (const [name, r] of [['A', viaA], ['B', viaB]]) {
        assert.equal(r.status, 201, name);
        assert.deepEqual(r.body.dropped, [], `${name}: не orphan`);
        assert.equal(r.body.ops.length, 1, name);
        assert.equal(r.body.ops[0].node.parent, board.id, `${name}: переприкреплено к доске`);
        assert.deepEqual(r.body.notes.map((n) => n.note), ['reparented'], name);
      }
    });

    it('голова, выгруженная и загруженная заново со снимка, сливает так же', async () => {
      const { id, board, g } = await removedBeforeSnapshot();
      await A.dslts.unload(id);
      assert.equal(A.dslts.isLoaded(id), false);
      const r = await api(A.url).post(`/api/projects/${id}/tx`, tx(1, [child(g.id)]));
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.dropped, []);
      assert.equal(r.body.ops[0].node.parent, board.id);
      const head = await A.dslts.headOf(id);
      assert.equal(head.tombstones.get(g.id), board.id, 'надгробие в загруженной голове');
    });

    it('снимок отдаёт надгробия клиенту (GET /api/projects/:id) — прогноз реплики совпадает с сервером', async () => {
      const { id, g, board } = await removedBeforeSnapshot();
      const opened = await api(A.url).get('/api/projects/' + id);
      assert.equal(opened.body.snapshot.seq, 50);
      assert.equal(opened.body.snapshot.tombstones[g.id], board.id);
    });
  });
}
