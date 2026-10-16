/**
 * Надгробия переживают снимок (SPEC §9.10, круг 25): голова, загруженная со снимка,
 * знает удалённые до него узлы — из `snapshot.tombstones`, а не только из `remove` в
 * хвосте. Иначе одна и та же офлайн-транзакция (create в группе, удалённой до снимка)
 * давала в долгоживущей голове `reparented`, а в свежей — `orphan`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { artboards, uid, ENGINE_VERSION, createDoc } from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createSequencer, readTombstones, flatTombstones } from '../../server/document/dslts.js';
import { TOMB_MAX } from '../../server/document/limits.js';
import { backends, startFor, startTwin, api, quiet } from './helpers.mjs';

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
      // круг 27: v2 — родитель и seq удаления
      assert.equal(snap.tombstones && snap.tombstones.v, 2, 'надгробия снимка — v2');
      assert.equal(snap.tombstones.parents[g.id], board.id, 'надгробие группы — в снимке');
      assert.equal(snap.tombstones.seq[g.id], 2, 'с номером удаления');
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
      assert.equal(opened.body.snapshot.tombstones[g.id], board.id, 'клиенту — плоско {id: parent}');
      assert.equal(opened.body.snapshot.tombstones.v, undefined);
    });

    /** Снимок «как от экземпляра прежней версии»: надгробия неизвестны (null). */
    async function forget(storage, id, seq) {
      if (storage.kind === 'memory') assert.ok(storage.forgetTombstones(id, seq));
      else await storage.pool.query('UPDATE snapshots SET tombstones_chain = NULL WHERE project_id = $1 AND seq = $2', [id, seq]);
      assert.equal((await storage.latestSnapshot(id)).tombstones, null, 'надгробия снимка — неизвестны');
    }

    it('I1: снимок с tombstones:null от прежнего экземпляра — свежая голова восстанавливает надгробия журналом и сливает так же, как голова в памяти', async () => {
      const { id, board, g } = await removedBeforeSnapshot();
      await forget(A.storage, id, 50);
      assert.equal(B.dslts.isLoaded(id), false);
      const viaA = await api(A.url).post(`/api/projects/${id}/tx`, tx(1, [child(g.id)]));
      const viaB = await api(B.url).post(`/api/projects/${id}/tx`, tx(1, [child(g.id)]));
      for (const [name, r] of [['A (в памяти)', viaA], ['B (со снимка null)', viaB]]) {
        assert.equal(r.status, 201, name);
        assert.deepEqual(r.body.dropped, [], `${name}: не orphan`);
        assert.equal(r.body.ops[0].node.parent, board.id, `${name}: переприкреплено к доске`);
        assert.deepEqual(r.body.notes.map((n) => n.note), ['reparented'], name);
      }
      const ha = await A.dslts.headOf(id);
      const hb = await B.dslts.headOf(id);
      assert.deepEqual([...hb.tombstones], [...ha.tombstones], 'надгробия те же');
      assert.deepEqual([...hb.tombSeq], [...ha.tombSeq], 'и номера удаления те же');
      // восстановленные надгробия записаны свежим снимком: следующей загрузке переигрывать нечего
      await B.dslts.flush();
      const snap = await B.storage.latestSnapshot(id);
      assert.ok(snap.seq > 50, 'свежий снимок после восстановления');
      assert.equal(snap.tombstones.parents[g.id], board.id);
    });
  });
}

/* ------------------------- прореживание и предел (I1) ------------------------- */

const frameNode = (id, parent) => ({
  type: 'frame', id, name: 'Пачка', parent, children: [], radius: 0, size: HUG,
  layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
});
const textNode = (id, parent) => ({ type: 'text', id, name: 't', parent, characters: 'x', style: { token: 'body' }, align: 'left', color: '#14161C', size: HUG });

async function seqStack(opts = {}) {
  const storage = createMemoryStorage();
  await storage.init();
  const p = await storage.createProject({ name: 'Надгробия', kind: 'design', doc: createDoc(), engine: E });
  const board = artboards((await storage.latestSnapshot(p.id)).doc)[0];
  const seqr = createSequencer({ storage, verifyMs: 0, snapshotEvery: 50, log: quiet, ...opts });
  return { storage, id: p.id, board, seqr };
}

describe('надгробия: прореживание по номеру и предел числа (I1)', () => {
  it('readTombstones: v2, v1 (seq = номер снимка), null — неизвестно; flatTombstones — плоско', () => {
    const v2 = readTombstones({ v: 2, parents: { b: 'p', a: null }, seq: { a: 3, b: 7 } }, 50);
    assert.deepEqual([...v2.parents], [['a', null], ['b', 'p']], 'по порядку удаления');
    assert.deepEqual([...v2.seq], [['a', 3], ['b', 7]]);
    const v1 = readTombstones({ x: 'p' }, 50);
    assert.deepEqual([...v1.seq], [['x', 50]]);
    assert.equal(readTombstones(null), null);
    assert.deepEqual(flatTombstones({ v: 2, parents: { a: 'p' }, seq: { a: 1 } }), { a: 'p' });
  });

  it(`60 циклов «создать 5000 / удалить»: надгробия не растут без предела (≤ ${TOMB_MAX}) — ни в голове, ни в снимке`, async () => {
    const { storage, id, board, seqr } = await seqStack();
    try {
      let base = 0;
      for (let c = 0; c < 60; c++) {
        const f = `f_${c}`;
        const list = [{ op: 'create', node: frameNode(f, board.id) }];
        for (let i = 0; i < 4999; i++) list.push({ op: 'create', node: textNode(`n_${c}_${i}`, f) });
        const made = await seqr.commit(id, tx(base, list));
        assert.equal(made.committed.ops.length, 5000);
        const gone = await seqr.commit(id, tx(made.committed.seq, [{ op: 'remove', id: f }]));
        base = gone.committed.seq;
      }
      const head = await seqr.headOf(id);
      assert.equal(head.head_seq, 120);
      assert.ok(head.tombstones.size <= TOMB_MAX, `в голове ${head.tombstones.size}`);
      assert.ok(head.tombstones.size >= TOMB_MAX - 5000, 'предел — самые новые, а не всё подряд');
      assert.ok(head.tombstones.has('n_59_4998') && head.tombstones.has('f_59'), 'последнее удаление помнится');
      assert.ok(!head.tombstones.has('n_0_0'), 'самое старое вытеснено');
      await seqr.flush();
      const snap = await storage.latestSnapshot(id);
      assert.equal(snap.seq, 100);
      assert.ok(Object.keys(snap.tombstones.parents).length <= TOMB_MAX, 'в снимке — тоже не больше предела');
    } finally {
      await seqr.close();
    }
  });

  it('прореживание по номеру детерминировано: голова в памяти и поднятая со снимка на одном seq знают одно и то же', async () => {
    const opts = { tombKeepSeq: 20, tombPruneEvery: 10 };
    const { storage, id, board, seqr } = await seqStack({ ...opts, snapshotEvery: 7 });
    const fresh = createSequencer({ storage, verifyMs: 0, snapshotEvery: 0, log: quiet, ...opts });
    try {
      let base = 0;
      for (let k = 0; k < 30; k++) {
        const n = `t_${k}`;
        const made = await seqr.commit(id, tx(base, [{ op: 'create', node: textNode(n, board.id) }]));
        const gone = await seqr.commit(id, tx(made.committed.seq, [{ op: 'remove', id: n }]));
        base = gone.committed.seq;
        if (k % 4 === 3) {
          await seqr.flush();
          await fresh.unload(id);
          const a = await seqr.headOf(id);
          const b = await fresh.headOf(id);
          assert.equal(b.head_seq, a.head_seq);
          assert.deepEqual([...b.tombSeq], [...a.tombSeq], `seq ${a.head_seq}: те же надгробия`);
        }
      }
      const a = await seqr.headOf(id);
      const bound = Math.floor(a.head_seq / 10) * 10 - 20;
      assert.ok([...a.tombSeq.values()].every((s) => s >= bound), 'старше окна — прорежены');
      assert.ok(a.tombSeq.size > 0 && a.tombSeq.size <= 15, `осталось ${a.tombSeq.size}`);
      assert.equal(a.tombSeq.get('t_29'), 60);
    } finally {
      await fresh.close();
      await seqr.close();
    }
  });
});
