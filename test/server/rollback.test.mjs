/**
 * Откат базы под работающим сервисом (SPEC §9.8): два экземпляра Document service
 * над одной базой, настоящие реплики src/sync.js (в node: настоящий WebSocket из
 * пакета ws, журнал — memoryStorage вместо IndexedDB).
 *
 * Сценарий: записи → бэкап → ещё записи (в том числе транзакция офлайн-клиента,
 * которая дошла до сервера, а подтверждение — нет) → restore к бэкапу → агент
 * пишет новую транзакцию под тем же seq, что раньше занимала другая → офлайн-клиент
 * возвращается и досылает ту же транзакцию. Проверка: у всех клиентов hashDoc =
 * переигрыванию журнала с затравки, эпоха сменилась ровно один раз, ни одна
 * своя правка не потеряна и не записана дважды.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as core from '../../src/core.js';
import { createSync, memoryStorage } from '../../src/sync.js';
import { backends, startFor, startTwin, api, takeBackup, restoreBackup, waitFor } from './helpers.mjs';

const { applyOps, hashDoc, artboards, ops, uid, ENGINE_VERSION: E } = core;

const text = (parent, characters) => ({
  type: 'text', id: uid('n'), name: characters, parent, characters,
  style: { token: 'body' }, align: 'left', color: '#14161C'
});

/** Сокет, который «нет сети»: сразу закрывается. */
class DeadSocket {
  constructor() {
    this.readyState = 0;
    setTimeout(() => { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); }, 0);
  }
  send() {}
  close() {}
}
const deadFetch = async () => { throw new Error('ECONNREFUSED'); };

/** Реплика к экземпляру сервиса. */
function replica(svc, projectId, clientId, storage = memoryStorage(), extra = {}) {
  const log = { gone: [], errors: [], changes: [] };
  const sync = createSync({
    core, baseUrl: svc.url, projectId, clientId, author: 'Имя ' + clientId, storage,
    WebSocketImpl: WebSocket, fetchImpl: (...a) => fetch(...a),
    reconnectMin: 20, reconnectMax: 200, epochReopenMs: 150,
    onGone: (s) => log.gone.push(s),
    onError: (e) => log.errors.push(e),
    onChange: (v, info) => log.changes.push(info.reason),
    ...extra
  });
  return { sync, log, storage };
}

/** Журнал целиком (страницами) и переигрывание с затравки seq 0. */
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
function replay(doc, txs) {
  let cur = doc;
  for (const t of txs) {
    const res = applyOps(cur, t.ops);
    assert.equal(res.error, undefined, `seq ${t.seq} обязана применяться`);
    cur = res.doc;
  }
  return cur;
}

const list = await backends();

for (const backend of list) {
  describe(`откат базы под работающим сервисом · ${backend.name}`, { skip: backend.available ? false : 'нет базы (TEST_DATABASE_URL)' }, () => {
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

    it('два экземпляра, реплики sync.js: restore → запись агентом под тем же seq → досылка офлайн-клиентом — все сходятся, эпоха сменилась один раз', async () => {
      const h1 = api(i1.url);
      const h2 = api(i2.url);
      const created = await h1.post('/api/projects', { name: 'Откат', demo: true });
      assert.equal(created.status, 201);
      const id = created.body.id;
      const epoch0 = created.body.epoch;
      const seed = (await h1.get('/api/projects/' + id)).body.snapshot.doc;
      const board = artboards(seed)[0];

      const A = replica(i1, id, 'A');
      const B = replica(i2, id, 'B');
      const cStorage = memoryStorage();
      const C = replica(i1, id, 'C', cStorage);
      await Promise.all([A.sync.open(), B.sync.open(), C.sync.open()]);
      await waitFor(() => A.sync.status.online && B.sync.status.online && C.sync.status.online, 'все в сети');

      // 1–2: обычная работа, общий журнал
      const na = text(board.id, 'от A');
      A.sync.commit([ops.create(na)]);
      await waitFor(() => A.sync.status.pending === 0, 'A записал');
      B.sync.commit([ops.set(board.id, 'name', 'Доска B')]);
      const all2 = () => [A, B, C].every((r) => r.sync.confirmed.seq === 2 && r.sync.status.pending === 0);
      await waitFor(all2, 'у всех seq 2');
      assert.equal(A.sync.epoch, epoch0, 'клиент знает эпоху');
      assert.equal(typeof A.sync.tip, 'string');
      assert.equal(A.sync.tip, B.sync.tip, 'tip — общий якорь');

      // бэкап на seq 2
      const backup = await takeBackup(i1.storage, id);

      // 3: A пишет — эта правка пропадёт при restore (A её уже считает подтверждённой)
      const tA = A.sync.commit([ops.set(na.id, 'characters', 'A после бэкапа')]).tx;
      await waitFor(() => [A, B, C].every((r) => r.sync.confirmed.seq === 3), 'seq 3 у всех');

      // 4: C уходит из сети; его правка дошла до сервера, а подтверждение — нет
      await C.sync.close();
      const Coff = replica({ url: 'http://127.0.0.1:1' }, id, 'C', cStorage, { WebSocketImpl: DeadSocket, fetchImpl: deadFetch });
      await Coff.sync.open();
      const t3 = Coff.sync.commit([ops.create(text(board.id, 'от C офлайн'))]).tx;
      assert.ok(t3);
      await Coff.sync.close();
      assert.equal(cStorage.map.get(id).pending.length, 1, 'правка C в очереди журнала');
      const sent = await h1.post(`/api/projects/${id}/tx`, t3);
      assert.equal(sent.status, 201);
      assert.equal(sent.body.seq, 4);
      await waitFor(() => A.sync.confirmed.seq === 4 && B.sync.confirmed.seq === 4, 'seq 4 у A и B');
      const oldSeq3 = (await journal(h1, id)).find((t) => t.seq === 3);
      assert.equal(oldSeq3.tx_id, tA.tx_id);

      // кадры в кеше Hub — по ключу seq:chain
      assert.ok(i1.hub.cachedFrames(id).includes(`3:${oldSeq3.chain}`), 'кадр seq 3 в кеше с chain');

      // 5: restore к бэкапу под работающими экземплярами
      await restoreBackup(i1.storage, id, backup);

      // 6: агент пишет через второй экземпляр, опираясь на то, что знает (seq 2)
      const agent = await h2.post(`/api/projects/${id}/tx`, {
        tx_id: uid('tx'), base_seq: 2, engine: E, author: 'Агент', author_kind: 'agent',
        ops: [ops.set(board.id, 'name', 'Доска агента')]
      });
      assert.equal(agent.status, 201, JSON.stringify(agent.body));
      assert.equal(agent.body.seq, 3, 'новая запись под тем же seq, что раньше занимала правка A');
      assert.notEqual(agent.body.chain, oldSeq3.chain, 'якорь отличает её от прежней');

      // 7: офлайн-клиент возвращается и досылает ту же транзакцию
      const C2 = replica(i1, id, 'C', cStorage);
      await C2.sync.open();
      assert.equal(C2.sync.pending.length, 1);

      // 8: все сходятся — сначала все узнали новую эпоху, потом догнали голову
      const head = async () => (await h1.get(`/api/projects/${id}?head=1`)).body;
      const epoch1 = (await head()).epoch;
      assert.notEqual(epoch1, epoch0);
      await waitFor(() => [A, B, C2].every((r) => r.sync.epoch === epoch1), 'все реплики в новой эпохе', 10000);
      await waitFor(async () => (await journal(h1, id)).some((t) => t.tx_id === tA.tx_id), 'правка A переиграна', 10000);
      await waitFor(async () => {
        const h = await head();
        return [A, B, C2].every((r) => r.sync.status.online && r.sync.status.pending === 0 && r.sync.confirmed.seq === h.head_seq);
      }, 'все реплики догнали голову без очереди', 10000);

      const log = await journal(h1, id);
      const ids = log.map((t) => t.tx_id);
      assert.equal(new Set(ids).size, ids.length, 'ни одна транзакция не записана дважды');
      assert.ok(ids.includes(tA.tx_id), 'правка A, потерянная при restore, переиграна (mine)');
      assert.ok(ids.includes(t3.tx_id), 'правка офлайн-клиента дослана');
      assert.equal(log.find((t) => t.seq === 3).tx_id, agent.body.tx_id);
      assert.deepEqual(log.map((t) => t.seq), log.map((_, i) => i + 1), 'номера без дыр');

      const truth = hashDoc(replay(seed, log));
      for (const r of [A, B, C2]) assert.equal(hashDoc(r.sync.view), truth, 'реплика = переигрывание журнала');
      const [g1, g2] = await Promise.all([i1.dslts.headOf(id), i2.dslts.headOf(id)]);
      assert.equal(hashDoc(g1.doc), truth);
      assert.equal(hashDoc(g2.doc), truth);

      // эпоха сменилась ровно один раз
      const epochs = await i1.storage.epochs(id);
      assert.equal(epochs.length, 2, JSON.stringify(epochs));
      assert.equal(epochs[1].cause, 'instance');
      const now = (await head()).epoch;
      assert.notEqual(now, epoch0);
      for (const r of [A, B, C2]) assert.equal(r.sync.epoch, now, 'реплика знает новую эпоху');
      assert.ok(A.log.gone.length >= 1 && B.log.gone.length >= 1, 'A и B получили снимок после 4410');

      // в кеше кадров — только кадры нынешнего журнала
      const byChain = new Map(log.map((t) => [t.seq, t.chain]));
      for (const svc of [i1, i2]) {
        for (const key of svc.hub.cachedFrames(id)) {
          const [seq, chain] = key.split(':');
          assert.equal(chain, byChain.get(Number(seq)), `кадр ${key} из нынешнего журнала`);
        }
      }

      await Promise.all([A.sync.close(), B.sync.close(), C2.sync.close()]);
    });

    it('откат без записей: сверка головы с базой меняет эпоху, сокеты закрываются 4410, реплика переоткрывается', async () => {
      const h1 = api(i1.url);
      const created = await h1.post('/api/projects', { name: 'Тихий откат', demo: true });
      const id = created.body.id;
      const board = artboards((await h1.get('/api/projects/' + id)).body.snapshot.doc)[0];
      const A = replica(i1, id, 'A');
      const B = replica(i2, id, 'B');
      await Promise.all([A.sync.open(), B.sync.open()]);
      await waitFor(() => A.sync.status.online && B.sync.status.online);
      const backup = await takeBackup(i1.storage, id);
      const lost = A.sync.commit([ops.set(board.id, 'name', 'Пропадёт')]).tx;
      await waitFor(() => A.sync.confirmed.seq === 1 && B.sync.confirmed.seq === 1);
      await restoreBackup(i1.storage, id, backup);
      // никто не пишет: откат ловит сверка (таймер; здесь — вручную)
      await i2.dslts.verify();
      await waitFor(async () => (await i1.storage.epochs(id)).length === 2, 'эпоха сменилась');
      // A переоткрывается со снимком (его база ушла вперёд головы) и переигрывает свою правку;
      // B, если переподключится уже после неё, снимка может не получить: та же транзакция
      // на том же месте даёт тот же chain — его подтверждённое цело
      await waitFor(() => A.log.gone.length >= 1, 'A получил снимок после 4410', 8000);
      await waitFor(async () => (await journal(h1, id)).length === 1 && A.sync.status.online && B.sync.status.online && A.sync.status.pending === 0 && B.sync.confirmed.seq === 1 && A.sync.confirmed.seq === 1, 'переоткрылись и дослали', 8000);
      const log = await journal(h1, id);
      assert.deepEqual(log.map((t) => t.tx_id), [lost.tx_id], 'правка A переиграна в новой эпохе');
      assert.equal(hashDoc(A.sync.view), hashDoc(B.sync.view));
      assert.equal((await i1.storage.epochs(id)).length, 2, 'и только один раз');
      await Promise.all([A.sync.close(), B.sync.close()]);
    });

    /* ------------------------------ круг 25 (SPEC §9.10) ------------------------------ */

    /** Проект с доской, реплики в сети, бэкап — общее начало сценариев отката. */
    async function rolloutStart(name, clients) {
      const h1 = api(i1.url);
      const created = await h1.post('/api/projects', { name, demo: true });
      const id = created.body.id;
      const seed = (await h1.get('/api/projects/' + id)).body.snapshot.doc;
      const board = artboards(seed)[0];
      const reps = clients.map(([svc, cid, storage]) => replica(svc, id, cid, storage || memoryStorage()));
      await Promise.all(reps.map((r) => r.sync.open()));
      await waitFor(() => reps.every((r) => r.sync.status.online), 'все в сети');
      return { h1, id, seed, board, reps };
    }
    /** Откат: restore + сверка (эпоха меняется, сокеты закрываются 4410). */
    async function rollTo(id, backup) {
      await restoreBackup(i1.storage, id, backup);
      await i2.dslts.verify();
      await i1.dslts.verify();
      await waitFor(async () => (await i1.storage.epochs(id)).length >= 2, 'эпоха сменилась');
    }

    it('(а) транзакция агента по команде вкладки — тоже «своя»: после отката реплика её переигрывает', async () => {
      const { h1, id, board, reps: [A] } = await rolloutStart('Агент и откат', [[i1, 'A']]);
      const backup = await takeBackup(i1.storage, id);
      // Orchestrator пишет по команде вкладки A: client — её clientId
      const agentTx = { tx_id: uid('tx'), base_seq: 0, engine: E, author: 'Агент', author_kind: 'agent', client: 'A', title: 'Агент: заголовок', command_id: 'cmd_1', ops: [ops.set(board.id, 'name', 'Доска агента')] };
      const r = await api(i2.url).post(`/api/projects/${id}/tx`, agentTx);
      assert.equal(r.status, 201);
      await waitFor(() => A.sync.confirmed.seq === 1, 'A увидел транзакцию агента');
      assert.ok(A.sync.mine.some((m) => m.tx_id === agentTx.tx_id && m.author_kind === 'agent'), 'агентная транзакция вкладки — в mine');
      assert.equal(A.sync.journal()[0].command_id, 'cmd_1', 'журнал реплики несёт command_id');
      await rollTo(id, backup);
      await waitFor(async () => (await journal(h1, id)).some((t) => t.tx_id === agentTx.tx_id) && A.sync.status.pending === 0 && A.sync.status.online, 'правка агента переиграна', 10000);
      const log = await journal(h1, id);
      assert.deepEqual(log.map((t) => t.tx_id), [agentTx.tx_id]);
      assert.equal(log[0].author_kind, 'agent');
      assert.equal(A.sync.view.nodes[board.id].name, 'Доска агента');
      await A.sync.close();
    });

    it('(б) окно переигрывания 200: 120 своих правок после бэкапа переиграны все и по порядку', async () => {
      const { h1, id, board, reps: [A] } = await rolloutStart('Окно', [[i1, 'A']]);
      const backup = await takeBackup(i1.storage, id);
      const mineTx = [];
      for (let k = 0; k < 120; k++) mineTx.push(A.sync.commit([ops.set(board.id, 'name', 'Имя ' + k)], { title: 'шаг ' + k }).tx.tx_id);
      await waitFor(() => A.sync.confirmed.seq === 120 && A.sync.status.pending === 0, 'все 120 подтверждены', 20000);
      const before = hashDoc(A.sync.view);
      await rollTo(id, backup);
      await waitFor(async () => (await journal(h1, id)).length === 120 && A.sync.status.pending === 0 && A.sync.status.online, 'все 120 переиграны', 20000);
      const log = await journal(h1, id);
      assert.deepEqual(log.map((t) => t.tx_id), mineTx, 'тот же набор и тот же порядок');
      assert.equal(log.reduce((n, t) => n + t.dropped.length, 0), 0, 'своё по порядку не устаревает');
      assert.equal(hashDoc(A.sync.view), before, 'документ — как до отката');
      assert.equal(A.sync.view.nodes[board.id].name, 'Имя 119');
      await A.sync.close();
    });

    it('(в) вкладка, закрытая до restore, не затирает своим старым значением более новое чужое: set → stale', async () => {
      const s5 = memoryStorage();
      const { h1, id, board, reps: [R5, R2] } = await rolloutStart('Старое против нового', [[i1, 'R5', s5], [i2, 'R2']]);
      const node = text(board.id, 'исходное');
      R5.sync.commit([ops.create(node)]);
      await waitFor(() => R5.sync.status.pending === 0 && R2.sync.confirmed.seq === 1, 'узел у обоих');
      const backup = await takeBackup(i1.storage, id);
      // вторая правка R5 — заодно и лист, которого никто больше не трогал: он должен вернуться
      R5.sync.commit([ops.set(node.id, 'characters', 'СТАРОЕ (до restore)'), ops.set(node.id, 'name', 'имя от R5')], { title: 'Правка R5' });
      await waitFor(() => R5.sync.status.pending === 0 && R2.sync.confirmed.seq === 2, 'правка R5 подтверждена');
      await R5.sync.close();   // вкладка закрыта, журнал остался
      await rollTo(id, backup);
      await waitFor(() => R2.sync.status.online && R2.sync.confirmed.seq === 1 && R2.sync.status.pending === 0, 'R2 в новой эпохе на seq 1', 10000);
      R2.sync.commit([ops.set(node.id, 'characters', 'НОВОЕ (после restore)')]);
      await waitFor(() => R2.sync.status.pending === 0 && R2.sync.confirmed.seq === 2, 'R2 записал новое');
      // R5 открывается позже со старым журналом
      const dropped = [];
      const R5b = replica(i1, id, 'R5', s5, { onDropped: (c) => dropped.push(c) });
      await R5b.sync.open();
      await waitFor(async () => (await journal(h1, id)).length === 3 && R5b.sync.status.pending === 0 && R5b.sync.status.online, 'R5 переиграл', 10000);
      const log = await journal(h1, id);
      const last = log[2];
      assert.deepEqual(last.dropped.map((d) => [d.index, d.reason]), [[0, 'stale']], 'старое значение устарело');
      assert.equal(last.ops.length, 1, 'лист, которого никто не трогал, вернулся');
      await waitFor(() => R2.sync.confirmed.seq === 3);
      for (const r of [R5b, R2]) {
        assert.equal(r.sync.view.nodes[node.id].characters, 'НОВОЕ (после restore)', 'новое не затёрто');
        assert.equal(r.sync.view.nodes[node.id].name, 'имя от R5');
      }
      await waitFor(() => dropped.length === 1, 'R5 узнал, что правка устарела');
      assert.equal(dropped[0].label, 'Правка R5');
      assert.equal(dropped[0].dropped[0].reason, 'stale');
      assert.equal(dropped[0].dropped[0].by && dropped[0].dropped[0].by.author, 'Имя R2', 'кто переписал');
      await Promise.all([R5b.sync.close(), R2.sync.close()]);
    });

    it('(в) предел давности: своё старше суток после отката не переигрывается — человеку «N правок … не восстановлены»', async () => {
      const s5 = memoryStorage();
      const { h1, id, board, reps: [R5] } = await rolloutStart('Давность', [[i1, 'R5', s5]]);
      const backup = await takeBackup(i1.storage, id);
      R5.sync.commit([ops.set(board.id, 'name', 'позавчера')]);
      R5.sync.commit([ops.set(board.id, 'fill', '#ff0000')]);
      await waitFor(() => R5.sync.confirmed.seq === 2 && R5.sync.status.pending === 0);
      await R5.sync.close();
      // первая правка — двухдневной давности
      const rec = s5.map.get(id);
      rec.mine[0].at = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
      await rollTo(id, backup);
      const R5b = replica(i1, id, 'R5', s5);
      await R5b.sync.open();
      await waitFor(async () => (await journal(h1, id)).length === 1 && R5b.sync.status.pending === 0 && R5b.sync.status.online, 'свежая переиграна', 10000);
      const log = await journal(h1, id);
      assert.equal(log[0].tx_id, rec.mine[1].tx.tx_id);
      const err = R5b.log.errors.find((e) => e.code === 'replay_expired');
      assert.ok(err, JSON.stringify(R5b.log.errors));
      assert.equal(err.count, 1);
      assert.match(err.message, /1 правка из прошлой версии не восстановлена/);
      // сервер сам тоже не принимает переигрывание старше суток
      const stale = await h1.post(`/api/projects/${id}/tx`, { tx_id: uid('tx'), base_seq: 0, engine: E, client: 'X', replay_of_epoch: 'old', replay_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), ops: [ops.set(board.id, 'name', 'древнее')] });
      assert.equal(stale.status, 201);
      assert.deepEqual(stale.body.dropped.map((d) => d.reason), ['stale']);
      await R5b.sync.close();
    });
  });
}
