/**
 * Реплика на большом документе (круг 27): чужая транзакция при длинной очереди, дренаж
 * очереди после офлайна, запись журнала. Пороги — относительные: против поштучного
 * переигрывания (прежний replayAll) на тех же данных в том же процессе.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { createSync, memoryStorage } from '../src/sync.js';

const { createDoc, applyOps, rebase, collectTombstones, ops, hashDoc, uid, ENGINE_VERSION: E } = core;
const N = 6000;
const P = 120;

function bigDoc() {
  let doc = createDoc('empty');
  const F = uid('f');
  const list = [ops.create({ type: 'frame', id: F, name: 'flat', parent: doc.root })];
  for (let b = 0; b < N / 100; b++) {
    const f = uid('f');
    list.push(ops.create({ type: 'frame', id: f, name: 'b', parent: F }));
    for (let i = 0; i < 99; i++) list.push(ops.create({ type: 'text', id: uid('t'), name: 's', parent: f, characters: 'x' }));
  }
  for (let i = 0; i < list.length; i += 5000) doc = applyOps(doc, list.slice(i, i + 5000)).doc;
  return { doc, F };
}

/** Прежний replayAll: rebase + collectTombstones + applyOps на каждую ожидающую. */
function replayPerTx(doc, pending, tomb = new Map()) {
  const t = new Map(tomb);
  for (const tx of pending) {
    const m = rebase(doc, tx.ops, { tombstones: t });
    for (const [id, p] of collectTombstones(doc, m.ops)) t.set(id, p);
    const r = applyOps(doc, m.ops);
    if (!r.error) doc = r.doc;
  }
  return doc;
}

/** Сервер в процессе: тот же rebase + applyOps, что в DSLTS. */
function serverOf(doc) {
  const s = { doc, seq: 0, tomb: new Map() };
  s.commit = (tx) => {
    const m = rebase(s.doc, tx.ops, { tombstones: s.tomb });
    for (const [id, p] of collectTombstones(s.doc, m.ops)) s.tomb.set(id, p);
    s.doc = applyOps(s.doc, m.ops).doc;
    s.seq += 1;
    return { ...tx, seq: s.seq, ops: m.ops, dropped: m.dropped, chain: 'c' + s.seq, created_at: new Date().toISOString() };
  };
  return s;
}

function scripted(doc) {
  const h = { ws: null };
  h.WS = class {
    constructor() {
      this.readyState = 0; h.ws = this;
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); this.in({ type: 'hello', head_seq: 0, engine: E, epoch: 'e1', tip: 'c0', gone: false }); }, 0);
    }
    in(m) { this.onmessage({ data: JSON.stringify(m) }); }
    send() {}
    close() { this.readyState = 3; }
  };
  h.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 'p', snapshot: { seq: 0, doc, chain: 'c0' }, tail: [], epoch: 'e1' }), headers: { get: () => null } });
  return h;
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test(`sync perf: ${P} ожидающих на ${N} узлах — чужая транзакция и дренаж очереди без O(очередь × документ) на кадр`, { timeout: 120000 }, async () => {
  const { doc, F } = bigDoc();
  const other = Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'text');
  const h = scripted(doc);
  const storage = memoryStorage();
  const a = createSync({ core, projectId: 'p', clientId: 'me', baseUrl: 'http://x', storage, WebSocketImpl: h.WS, fetchImpl: h.fetchImpl });
  await a.open();
  await new Promise((r) => setTimeout(r, 20));
  // очередь: правки одного листа, создание и (одна) удаление — группы переигрывания
  const victim = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text')[5];
  for (let i = 0; i < P; i++) {
    if (i === 60) a.commit([ops.remove(victim)]);
    else if (i % 20 === 0) a.commit([ops.create({ type: 'text', id: 'mine' + i, name: 'моё', parent: F, characters: 'м' })]);
    else a.commit([ops.set(F, 'name', 'n' + i)]);
  }
  assert.equal(a.pending.length, P);
  const server = serverOf(doc);

  // эталон: прежнее поштучное переигрывание той же очереди поверх того же документа
  const foreign = server.commit({ tx_id: 'tx_f', client: 'other', ops: [ops.set(other, 'characters', 'чужое')] });
  const base1 = applyOps(doc, foreign.ops).doc;
  const refTimes = [];
  let ref = null;
  for (let k = 0; k < 3; k++) { const t = performance.now(); ref = replayPerTx(base1, a.pending); refTimes.push(performance.now() - t); }
  const refMs = median(refTimes);

  let t = performance.now();
  h.ws.in({ type: 'tx', tx: foreign });
  const foreignMs = performance.now() - t;
  assert.equal(hashDoc(a.view), hashDoc(ref), 'переигрывание группами = поштучному');

  // дренаж: сервер подтверждает свои по одной
  const acks = [];
  t = performance.now();
  while (a.pending.length) {
    const c = server.commit(a.pending[0]);
    const t1 = performance.now();
    h.ws.in({ type: 'tx', tx: c });
    acks.push(performance.now() - t1);
  }
  const drainMs = performance.now() - t;
  assert.equal(hashDoc(a.view), hashDoc(server.doc), 'итог = сервер');
  console.log(`# ${N} узлов, ${P} ожидающих: чужая транзакция ${foreignMs.toFixed(0)} мс (поштучно было бы ${refMs.toFixed(0)} мс); дренаж ${drainMs.toFixed(0)} мс, медиана подтверждения ${median(acks).toFixed(1)} мс, худшее ${Math.max(...acks).toFixed(0)} мс`);
  // одна чужая — в разы дешевле поштучного переигрывания очереди (было = ему)
  assert.ok(foreignMs < refMs / 4, `чужая ${foreignMs.toFixed(0)} мс против эталона ${refMs.toFixed(0)} мс`);
  // дренаж всей очереди — порядка одного поштучного переигрывания (O(P)); было ~P/2 таких (O(P²))
  assert.ok(drainMs < refMs * 4, `дренаж ${drainMs.toFixed(0)} мс против эталона ${refMs.toFixed(0)} мс`);
  // ни одно подтверждение не стоит переигрывания всей очереди
  assert.ok(median(acks) < refMs / 10, `медиана подтверждения ${median(acks).toFixed(1)} мс`);
  await a.close();
});

test(`sync perf: журнал на ${N} узлах — документ пишется не на каждую транзакцию`, { timeout: 60000 }, async () => {
  const { doc, F } = bigDoc();
  const h = scripted(doc);
  const counts = { doc: 0, queue: 0, docMs: 0 };
  const inner = memoryStorage();
  // как IndexedDB: структурное клонирование значения при записи
  const storage = {
    get: inner.get, remove: inner.remove, keys: inner.keys,
    set: async (k, v) => { const t = performance.now(); structuredClone(v); if (k.endsWith('#doc')) { counts.doc += 1; counts.docMs += performance.now() - t; } else counts.queue += 1; return inner.set(k, v); },
  };
  const a = createSync({ core, projectId: 'p', clientId: 'me', baseUrl: 'http://x', storage, WebSocketImpl: h.WS, fetchImpl: h.fetchImpl });
  await a.open();
  await new Promise((r) => setTimeout(r, 300));
  const before = counts.doc;
  const server = serverOf(doc);
  // 1 с потока: чужая транзакция каждые 20 мс (50 штук)
  for (let k = 0; k < 50; k++) {
    h.ws.in({ type: 'tx', tx: server.commit({ tx_id: 'tx' + k, client: 'z', ops: [ops.set(F, 'name', 'z' + k)] }) });
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 250));
  const during = counts.doc - before;
  console.log(`# журнал: 50 транзакций за ~1 с — записей документа ${during}, очереди ${counts.queue}; клон документа ${(counts.docMs / Math.max(1, counts.doc)).toFixed(0)} мс`);
  assert.ok(during <= 2, `документ записан ${during} раз — не чаще раза в 1,5 с`);
  assert.ok(counts.queue >= 3, 'очередь пишется по ходу');
  await a.close();
  assert.equal((await inner.get('p#doc')).seq, 50, 'закрытие дописывает документ');
});
