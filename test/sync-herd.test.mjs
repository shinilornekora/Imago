/**
 * «Стадо» после отката базы (круг 27, дефект 1 и I5): десять настоящих реплик src/sync.js
 * над двумя экземплярами Document service правят после бэкапа, база восстанавливается из
 * него под открытыми вкладками. Раньше переигрывала только первая переподключившаяся: у
 * остальных gone приходил с головой дальше снимка (первая уже записала своё), реплика
 * догоняла по HTTP — и очередь так и стояла до следующей правки человека. Теперь все
 * правки — в журнале сервера без новых правок, у всех один документ.
 *
 * И пропавший проект (I3): откат к бэкапу, где проекта ещё нет, — реплика не теряет
 * работу: статус not_found, очередь цела, вид — с работой.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as core from '../src/core.js';
import { createSync, memoryStorage } from '../src/sync.js';
import { backends, startFor, startTwin, api, takeBackup, restoreBackup, waitFor } from './server/helpers.mjs';

const { applyOps, hashDoc, artboards, ops, uid } = core;
const HERD = 10;

const text = (parent, characters) => ({
  type: 'text', id: uid('n'), name: characters, parent, characters,
  style: { token: 'body' }, align: 'left', color: '#14161C'
});

function replica(svc, projectId, clientId, extra = {}) {
  const log = { errors: [] };
  const sync = createSync({
    core, baseUrl: svc.url, projectId, clientId, author: 'Имя ' + clientId, storage: memoryStorage(),
    WebSocketImpl: WebSocket, fetchImpl: (...a) => fetch(...a),
    reconnectMin: 20, reconnectMax: 300, epochReopenMs: 150,
    onError: (e) => log.errors.push(e),
    ...extra
  });
  return { sync, log };
}

async function journal(http, id) {
  const txs = [];
  let since = 0;
  for (;;) {
    const r = await http.get(`/api/projects/${id}/ops?since=${since}&limit=500`);
    assert.equal(r.status, 200);
    txs.push(...r.body.txs);
    if (!r.body.more || !r.body.txs.length) break;
    since = r.body.txs[r.body.txs.length - 1].seq;
  }
  return txs;
}

const list = await backends();

for (const backend of list) {
  describe(`реплики после отката базы · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
    let i1;
    let i2;
    before(async () => {
      i1 = await startFor(backend.name, { verifyMs: 0 });
      i2 = await startTwin(backend.name, i1, { verifyMs: 0 });
    });
    after(async () => {
      await i2.close();
      await i1.close();
    });

    async function rollTo(id, backup) {
      await restoreBackup(i1.storage, id, backup);
      await i2.dslts.verify();
      await i1.dslts.verify();
    }

    it(`стадо из ${HERD} реплик: все правки после бэкапа переиграны без новых правок, документы сошлись`, { timeout: 60000 }, async () => {
      const h1 = api(i1.url);
      const created = await h1.post('/api/projects', { name: 'Стадо', demo: true });
      assert.equal(created.status, 201);
      const id = created.body.id;
      const seed = (await h1.get('/api/projects/' + id)).body.snapshot.doc;
      const board = artboards(seed)[0];
      const R = [];
      for (let k = 0; k < HERD; k++) R.push(replica(k % 2 ? i2 : i1, id, 'h' + k));
      await Promise.all(R.map((r) => r.sync.open()));
      await waitFor(() => R.every((r) => r.sync.status.online), 'все в сети', 10000);
      const backup = await takeBackup(i1.storage, id);
      const mine = R.map((r, k) => r.sync.commit([ops.create(text(board.id, 'после бэкапа ' + k))], { title: 'h' + k }).tx.tx_id);
      await waitFor(() => R.every((r) => r.sync.status.pending === 0 && r.sync.confirmed.seq === HERD), 'все подтверждены', 15000);

      await rollTo(id, backup);
      const t0 = Date.now();
      // никто ничего не правит: переиграть обязаны сами
      await waitFor(async () => {
        const log = await journal(h1, id);
        return log.length === HERD && R.every((r) => r.sync.status.online && r.sync.status.pending === 0 && r.sync.confirmed.seq === HERD);
      }, 'все десять правок снова в журнале', 30000);
      const log = await journal(h1, id);
      assert.deepEqual(new Set(log.map((t) => t.tx_id)), new Set(mine), 'каждая — ровно один раз');
      let doc = seed;
      for (const t of log) { const r = applyOps(doc, t.ops); assert.equal(r.error, undefined); doc = r.doc; }
      for (const r of R) assert.equal(hashDoc(r.sync.view), hashDoc(doc), 'у всех документ журнала');
      assert.equal(Object.values(doc.nodes).filter((n) => /^после бэкапа/.test(n.name)).length, HERD);
      console.log(`# стадо ${HERD} (${backend.name}): переиграно за ${Date.now() - t0} мс`);
      await Promise.all(R.map((r) => r.sync.close()));
    });

    it('проект пропал после отката (бэкап до его создания): not_found, очередь и работа на месте', { timeout: 30000 }, async () => {
      const h1 = api(i1.url);
      const other = await h1.post('/api/projects', { name: 'Был до бэкапа', demo: true });
      const backup = await takeBackup(i1.storage, other.body.id);
      const created = await h1.post('/api/projects', { name: 'После бэкапа', demo: true });
      const id = created.body.id;
      const board = artboards((await h1.get('/api/projects/' + id)).body.snapshot.doc)[0];
      let sockets = 0;
      const A = replica(i1, id, 'L', {
        notFoundRetryMs: 400,
        WebSocketImpl: class extends WebSocket { constructor(...a) { super(...a); sockets += 1; } }
      });
      await A.sync.open();
      await waitFor(() => A.sync.status.online, 'в сети');
      const node = text(board.id, 'работа');
      A.sync.commit([ops.create(node)]);
      await waitFor(() => A.sync.status.pending === 0, 'записано');
      // откат к бэкапу, где проекта нет: в базе его больше нет
      await restoreBackup(i1.storage, other.body.id, backup);
      if (i1.storage.kind !== 'memory') await i1.storage.pool.query('DELETE FROM projects WHERE id = $1', [id]);
      await i2.dslts.verify();
      await i1.dslts.verify();
      A.sync.commit([ops.set(node.id, 'characters', 'после отката')]);
      await waitFor(() => A.sync.status.error === 'not_found', 'статус not_found', 15000);
      assert.equal(A.sync.status.label, 'проект не найден на сервере');
      assert.equal(A.sync.view.nodes[node.id].characters, 'после отката', 'работа в виде');
      assert.ok(A.sync.status.pending >= 1, 'очередь не снята');
      const n0 = sockets;
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(sockets - n0 <= 3, `переподключения редкие: ${sockets - n0} за 1,5 с`);
      assert.equal(A.log.errors.filter((e) => e.code === 'not_found').length, 1);
      assert.ok(A.sync.status.pending >= 1);
      await A.sync.close();
    });
  });
}
