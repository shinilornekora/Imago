/**
 * Круг 26: голова DSLTS поднимается из снимка и хвоста (и догоняет запись другого
 * экземпляра) одним черновиком на страницу — `core.applyBatches` — вместо пары
 * collectTombstones + applyOps на каждую транзакцию. Итог обязан совпасть с
 * поштучным путём: документ (hashDoc), надгробия, номер, chain, байты документа.
 * Замер: снимок в 20 000 узлов и хвост 50 транзакций по 1000 операций.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc, applyOps, collectTombstones, hashDoc, artboards, uid, ENGINE_VERSION
} from '../../src/core.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createSequencer, mergeIntoHead } from '../../server/document/dslts.js';
import { jsonBytes } from '../../server/document/storage/committed.js';

const E = ENGINE_VERSION;
const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const text = (id, parent) => ({ type: 'text', id, name: id, parent, characters: 'т ' + id, color: 'text', align: 'left', style: { token: 'body' }, size: HUG });
const frame = (id, parent, children = []) => ({
  type: 'frame', id, name: id, parent, children, size: HUG,
  layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start' }
});

function bigDoc(blocks, per) {
  const doc = createDoc();
  const board = artboards(doc)[0].id;
  const list = [];
  for (let b = 0; b < blocks; b++) {
    list.push({ op: 'create', node: frame('f' + b, board) });
    for (let k = 0; k < per; k++) list.push({ op: 'create', node: text(`t${b}_${k}`, 'f' + b) });
  }
  const res = applyOps(doc, list);
  assert.equal(res.error, undefined);
  return res.doc;
}

/** Хвост: 50 × 1000 — set, move, create и 1% remove; одна транзакция журнала «не ложится». */
function makeTail(doc, count = 50) {
  const texts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text');
  const frames = Object.keys(doc.nodes).filter((id) => /^f\d+$/.test(id)).length;
  // set и move — по первой половине текстов, remove — с конца: друг другу не мешают
  const half = Math.min(9000, Math.floor(texts.length / 2));
  const tail = [];
  let k = 0;
  for (let x = 0; x < count; x++) {
    const ops = [];
    for (let i = 0; i < 1000; i++, k++) {
      if (k % 100 === 99) ops.push({ op: 'remove', id: texts[texts.length - 1 - Math.floor(k / 100)] });
      else if (k % 50 === 7) ops.push({ op: 'move', id: texts[k % half], parent: 'f' + (k % Math.min(13, frames)), index: 0 });
      else if (k % 50 === 11) ops.push({ op: 'create', node: text(`n${k}`, 'f' + (k % Math.min(17, frames))) });
      else ops.push({ op: 'set', id: texts[k % half], path: 'name', value: 'v' + k });
    }
    tail.push(ops);
  }
  // журнал и движок разошлись: эта транзакция строго не применяется — голова идёт дальше
  tail[20] = [{ op: 'set', id: texts[1], path: 'name', value: 'ляжет?' }, { op: 'set', id: 'нет_такого', path: 'name', value: 'x' }];
  return tail;
}

/** Поштучный путь (до круга 26): collectTombstones + applyOps на каждую транзакцию. */
function perTx(doc, tail) {
  let d = doc;
  const tomb = new Map();
  for (const ops of tail) {
    for (const [id, p] of collectTombstones(d, ops)) tomb.set(id, p);
    const r = applyOps(d, ops);
    if (!r.error) d = r.doc;
  }
  return { doc: d, tomb };
}

async function journal(storage, projectId, tail) {
  for (const ops of tail) {
    const r = await storage.commitTx(projectId, { tx_id: uid('tx'), base_seq: 0, ops, dropped: [], notes: [], engine: E });
    assert.equal(r.status, 'committed');
  }
}

const warns = [];
const log = { info() {}, warn: (...a) => warns.push(a.join(' ')) };

test('холодная загрузка хвоста 50×1000 на 20 000 узлах одним черновиком = поштучный путь', async () => {
  const doc = bigDoc(133, 149);
  assert.ok(Object.keys(doc.nodes).length >= 19900);
  const tail = makeTail(doc);
  const storage = createMemoryStorage();
  await storage.init();
  const p = await storage.createProject({ name: 'Большой', kind: 'design', doc, engine: E });
  await journal(storage, p.id, tail);

  const t0 = performance.now();
  const ref = perTx(doc, tail);
  const tRef = performance.now() - t0;

  const dslts = createSequencer({ storage, verifyMs: 0, idleMs: 0, log });
  warns.length = 0;
  const t1 = performance.now();
  const head = await dslts.headOf(p.id);
  const tCold = performance.now() - t1;
  assert.equal(head.head_seq, 50);
  assert.equal(hashDoc(head.doc), hashDoc(ref.doc), 'документ тот же');
  assert.deepEqual([...head.tombstones].sort(), [...ref.tomb].sort(), 'надгробия те же');
  const prj = await storage.getProject(p.id);
  assert.equal(head.chain, prj.head_chain, 'chain головы — журнала');
  const bad = warns.filter((w) => w.includes('не применяется'));
  assert.equal(bad.length, 1, 'не легла ровно одна запись: ' + bad.join('; '));
  assert.ok(bad[0].includes('seq 21 '), bad[0]);
  assert.equal(head.recent.length, 50);

  // байты документа в голове точны: следующая транзакция у предела документа решается по ним
  const exact = jsonBytes(head.doc);
  const m = mergeIntoHead({ doc: head.doc, tombstones: head.tombstones, docBytes: exact }, { ops: [{ op: 'set', id: 't0_0', path: 'name', value: 'q' }] }, { maxDocBytes: exact });
  assert.equal(m.dropped.length, 0);
  const grow = mergeIntoHead({ doc: head.doc, tombstones: head.tombstones, docBytes: exact }, { ops: [{ op: 'set', id: 't0_0', path: 'name', value: 'длиннее'.repeat(10) }] }, { maxDocBytes: exact });
  assert.equal(grow.dropped[0] && grow.dropped[0].limit, 'doc_bytes');

  console.log(`# холодная загрузка 50×1000 на ${Object.keys(doc.nodes).length} узлах: голова DSLTS ${Math.round(tCold)} мс (applyBatches по страницам), поштучный путь ${Math.round(tRef)} мс`);
  // порог с запасом: поштучный путь — секунды, черновик на страницу — десятки-сотни мс
  assert.ok(tCold < Math.max(tRef, 3000), `голова ${tCold} мс, поштучно ${tRef} мс`);
  await dslts.close();
});

test('догон за другим экземпляром (сверка) — той же пачкой; сокетам уходят все записи по порядку', async () => {
  const doc = bigDoc(20, 49);
  const storage = createMemoryStorage();
  await storage.init();
  const p = await storage.createProject({ name: 'Догон', kind: 'design', doc, engine: E });
  const dslts = createSequencer({ storage, verifyMs: 0, idleMs: 0, log });
  await dslts.headOf(p.id);
  const seen = [];
  dslts.subscribe((ev) => { if (ev.kind === 'tx') seen.push(ev.committed.seq); });
  const tail = makeTail(doc, 30);
  await journal(storage, p.id, tail);   // пишет «другой экземпляр» — мимо этой головы
  const ref = perTx(doc, tail);
  await dslts.verify();
  const head = await dslts.headOf(p.id);
  assert.equal(head.head_seq, 30);
  assert.equal(hashDoc(head.doc), hashDoc(ref.doc));
  assert.deepEqual([...head.tombstones].sort(), [...ref.tomb].sort());
  assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => i + 1));
  await dslts.close();
});

test('mergeIntoHead: бюджет действует внутри rebase — исчерпан до слияния, все операции merge_budget, транзакция цела', () => {
  const doc = bigDoc(4, 10);
  const ops = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text').map((id) => ({ op: 'set', id, path: 'name', value: 'z' }));
  // applyOps-подмена не зовётся до rebase: отрицательный бюджет режет уже само слияние
  let applyCalls = 0;
  const apply = (d, list) => { applyCalls++; return applyOps(d, list); };
  const m = mergeIntoHead({ doc, tombstones: new Map() }, { ops }, { mergeBudgetMs: -1, applyOps: apply });
  assert.equal(m.ops.length, 0);
  assert.equal(m.dropped.length, ops.length);
  assert.ok(m.dropped.every((d, i) => d.index === i && d.reason === 'invalid' && d.limit === 'merge_budget'));
  assert.equal(m.doc, doc, 'документ не тронут');
  assert.ok(applyCalls <= 1);
  const ok = mergeIntoHead({ doc, tombstones: new Map() }, { ops });
  assert.equal(ok.ops.length, ops.length, 'с обычным бюджетом всё легло');
});
