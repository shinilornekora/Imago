import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, applyBatches, rebase, collectTombstones, invertOps, hashDoc, artboards, uid
} = core;

/* Круг 25: слияние и применение на большом документе.
   Раньше rebase, collectTombstones и invertOps звали applyOps(cur, [op]) на каждую
   операцию, и каждый вызов копировал словарь узлов: O(операций × узлов). На
   документе в 19 500 узлов транзакция из 4900 set сливалась 90 с, холодная загрузка
   хвоста — 187 с. Теперь один черновик на пачку с откатом не легшей операции.

   Здесь: (1) эталон — прежние реализации поверх applyOps, дословно — и сравнение с
   ним на случайных пачках (выход должен совпасть ТОЧНО); (2) фаззинг кривыми
   пачками — ни rebase, ни applyOps после него не бросают; (3) бюджет слияния;
   (4) масштаб: 20 000 узлов, 5000 set и 5000 create, хвост 50×1000. Пороги по
   времени — с большим запасом (прежнее — десятки секунд, нынешнее — десятки мс). */

/* ---------------------------- эталон (круг 24) --------------------------- */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function refAncestorIds(doc, id) {
  const out = new Set();
  let cur = id ? doc.nodes[id] : null;
  let guard = 0;
  while (cur && guard++ < 256) {
    out.add(cur.id);
    cur = cur.parent ? doc.nodes[cur.parent] : null;
  }
  return out;
}

function refWithIndex(op, parent, selfId) {
  const kids = (parent && Array.isArray(parent.children) ? parent.children : []).filter((c) => c !== selfId);
  let index;
  if (op.after === null) index = 0;
  else if (typeof op.after === 'string') {
    const at = kids.indexOf(op.after);
    index = at >= 0 ? at + 1 : (isNum(op.index) ? op.index : kids.length);
  } else index = isNum(op.index) ? op.index : kids.length;
  const next = { ...op, index: clamp(Math.round(index), 0, kids.length) };
  delete next.after;
  return next;
}

/** rebase круга 24 — applyOps на каждую операцию. */
function refRebase(doc, list, tomb) {
  const out = { ops: [], dropped: [], notes: [] };
  let cur = doc;
  const liveAncestor = (id) => {
    let p = id;
    const seen = new Set();
    let guard = 0;
    while (p && guard++ < 256 && !seen.has(p)) {
      if (cur.nodes[p]) return p;
      seen.add(p);
      p = tomb.has(p) ? tomb.get(p) : null;
    }
    return null;
  };
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const drop = (reason) => out.dropped.push({ index: i, op: raw, reason });
    if (!raw || typeof raw !== 'object') { drop('invalid'); continue; }
    let op = raw;
    const hasId = typeof op.id === 'string' && op.id !== '';
    switch (op.op) {
      case 'set':
      case 'remove':
        if (!hasId) { drop('invalid'); continue; }
        if (!cur.nodes[op.id]) { drop('removed'); continue; }
        break;
      case 'setToken':
        break;
      case 'create': {
        const node = op.node;
        if (!node || typeof node !== 'object') { drop('invalid'); continue; }
        if (typeof node.id !== 'string' || !node.id) { drop('invalid'); continue; }
        if (cur.nodes[node.id]) { drop('exists'); continue; }
        const needsParent = node.type !== 'page' || !!node.parent;
        if (needsParent) {
          let parentId = node.parent;
          if (!cur.nodes[parentId]) {
            const alt = liveAncestor(parentId);
            if (!alt) { drop('orphan'); continue; }
            op = { ...op, node: { ...node, parent: alt } };
            delete op.after;
            delete op.index;
            out.notes.push({ index: i, note: 'reparented' });
            parentId = alt;
          }
          if (Array.isArray(op.node.children)) {
            const chain = refAncestorIds(cur, parentId);
            const kids = op.node.children.filter((c) => cur.nodes[c] && !chain.has(c));
            // круг 39: группа, у которой вычеркнуты все дети, — отброшена, если пачка дальше ничего в неё не кладёт
            const filled = list.slice(i + 1).some((x) => x && ((x.op === 'create' && x.node && x.node.parent === node.id) || (x.op === 'move' && x.parent === node.id)));
            if (!kids.length && op.node.children.length && !filled) {
              const was = op.node.children;
              const junk = was.some((c) => typeof c !== 'string' || !c || Object.prototype.hasOwnProperty.call(Object.prototype, c));
              drop(junk ? 'invalid' : was.some((c) => cur.nodes[c]) ? 'cycle' : 'removed');
              continue;
            }
            if (kids.length !== op.node.children.length) op = { ...op, node: { ...op.node, children: kids } };
          }
          op = refWithIndex(op, cur.nodes[parentId], null);
        } else if (op.after !== undefined) {
          op = { ...op };
          delete op.after;
        }
        break;
      }
      case 'move': {
        if (!hasId) { drop('invalid'); continue; }
        if (!cur.nodes[op.id]) { drop('removed'); continue; }
        let parentId = op.parent;
        if (!cur.nodes[parentId]) {
          const alt = liveAncestor(parentId);
          if (!alt) { drop('orphan'); continue; }
          op = { ...op, parent: alt };
          delete op.after;
          delete op.index;
          out.notes.push({ index: i, note: 'reparented' });
          parentId = alt;
        }
        if (parentId === op.id || refAncestorIds(cur, parentId).has(op.id)) { drop('cycle'); continue; }
        op = refWithIndex(op, cur.nodes[parentId], op.id);
        break;
      }
      default:
        drop('invalid');
        continue;
    }
    const res = applyOps(cur, [op]);
    if (res.error) { drop('invalid'); continue; }
    cur = res.doc;
    out.ops.push(op);
  }
  return out;
}

/** collectTombstones круга 24. */
function refCollect(doc, list) {
  const out = [];
  let cur = doc;
  for (const op of list) {
    if (op && op.op === 'remove' && cur && cur.nodes && cur.nodes[op.id]) {
      for (const id of core.subtreeIds(cur, op.id)) {
        const n = cur.nodes[id];
        out.push([id, n && n.parent ? n.parent : null]);
      }
    }
    const res = applyOps(cur, [op]);
    if (res.error) break;
    cur = res.doc;
  }
  return out;
}

/** invertOps круга 24: инверсия по одной операции поверх состояния перед ней. */
function refInvert(doc, list) {
  const chunks = [];
  let cur = doc;
  for (const op of list) {
    chunks.push(invertOps(cur, [op]));
    const res = applyOps(cur, [op]);
    if (res.error) break;
    cur = res.doc;
  }
  const out = [];
  for (let i = chunks.length - 1; i >= 0; i--) out.push(...chunks[i]);
  return out;
}

/* ------------------------------ генераторы ------------------------------ */

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const text = (id, parent) => ({ type: 'text', id, name: id, parent, characters: 'т ' + id, color: 'text', align: 'left', style: { token: 'body' }, size: HUG });
const frame = (id, parent, children = []) => ({
  type: 'frame', id, name: id, parent, children, size: HUG,
  layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start' }
});

/** Документ: доска и `blocks` фреймов по `per` текстов. */
function bigDoc(blocks, per) {
  let doc = createDoc();
  const board = artboards(doc)[0].id;
  const list = [];
  for (let b = 0; b < blocks; b++) {
    const f = 'f' + b;
    list.push({ op: 'create', node: frame(f, board) });
    for (let k = 0; k < per; k++) list.push({ op: 'create', node: text(`t${b}_${k}`, f) });
  }
  const res = applyOps(doc, list);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  return res.doc;
}

/**
 * Случайная правильно типизированная пачка: id из живых, удалённых и выдуманных;
 * часть операций не ляжет (негодное значение, цикл, страница не туда) — так
 * проверяется откат черновика.
 */
function genBatch(doc, rnd, n, gone, tag) {
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
  const chance = (p) => rnd() < p;
  const ids = Object.keys(doc.nodes);
  const containers = ids.filter((id) => doc.nodes[id].type === 'frame' || doc.nodes[id].type === 'page');
  const any = () => (chance(0.15) && gone.length ? pick(gone) : chance(0.05) ? 'нет_' + Math.floor(rnd() * 5) : pick(ids));
  const place = () => {
    const out = {};
    if (chance(0.5)) out.after = chance(0.2) ? null : any();
    if (chance(0.4)) out.index = Math.floor(rnd() * 8) - 1;
    return out;
  };
  const list = [];
  for (let i = 0; i < n; i++) {
    const roll = rnd();
    if (roll < 0.35) {
      const v = rnd();
      if (v < 0.4) list.push({ op: 'set', id: any(), path: 'name', value: 'n' + i });
      else if (v < 0.6) list.push({ op: 'set', id: any(), path: 'layout.gap', value: pick([0, 4, 'spacing.4', 'spacing.99', -1]) });
      else if (v < 0.8) list.push({ op: 'set', id: any(), path: 'opacity', value: pick([0.5, 1, 2]) });
      else list.push({ op: 'set', id: any(), path: pick(['id', 'children', 'fill']), value: 'x' });
    } else if (roll < 0.62) {
      const id = `${tag}_${i}`;
      const parent = chance(0.8) ? pick(containers) : any();
      const node = chance(0.6) ? text(id, parent) : frame(id, parent, chance(0.4) ? [...new Set([any(), any()])] : []);
      if (chance(0.05)) node.id = pick(ids);              // повтор — exists
      if (chance(0.05)) node.size = { w: { mode: 'zzz' } }; // не ляжет — invalid
      list.push({ op: 'create', node, ...place() });
    } else if (roll < 0.74) {
      list.push({ op: 'remove', id: any() });
    } else if (roll < 0.94) {
      list.push({ op: 'move', id: any(), parent: chance(0.85) ? pick(containers) : any(), ...place() });
    } else {
      list.push(chance(0.7)
        ? { op: 'setToken', path: 'colors.accent', value: pick(['#ff0000', '#00ff00']) }
        : { op: 'setToken', path: 'spacing', value: 'не массив' });
    }
  }
  return list;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/* --------------------------- сравнение с эталоном --------------------------- */

test('rebase, collectTombstones, invertOps, applyBatches = прежние реализации на 400 случайных пачках', () => {
  const rnd = lcg(250925);
  let doc = bigDoc(6, 5);
  const tomb = new Map();
  const gone = [];
  let total = 0;
  const reasons = {};
  const txs = [];
  const start = doc;
  const startHash = hashDoc(start);
  const startJSON = JSON.stringify(start);
  for (let round = 0; round < 400; round++) {
    const list = genBatch(doc, rnd, 1 + Math.floor(rnd() * 12), gone, 'r' + round);
    const a = rebase(doc, clone(list), { tombstones: tomb });
    const b = refRebase(doc, clone(list), tomb);
    assert.deepEqual(a, b, 'rebase, раунд ' + round);
    for (const d of a.dropped) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
    const tA = collectTombstones(doc, a.ops);
    assert.deepEqual(tA, refCollect(doc, a.ops), 'collectTombstones, раунд ' + round);
    // сырые операции (часть не ляжет): обрыв на первой негодной — как прежде
    assert.deepEqual(collectTombstones(doc, list), refCollect(doc, list), 'collectTombstones сырых, раунд ' + round);
    assert.deepEqual(invertOps(doc, a.ops), refInvert(doc, a.ops), 'invertOps, раунд ' + round);
    assert.deepEqual(invertOps(doc, list), refInvert(doc, list), 'invertOps сырых, раунд ' + round);
    const res = applyOps(doc, a.ops);
    assert.equal(res.error, undefined, 'после rebase строгий applyOps обязан пройти: ' + JSON.stringify(res.error));
    // отмена возвращает документ
    const back = applyOps(res.doc, invertOps(doc, a.ops));
    assert.equal(back.error, undefined);
    assert.equal(hashDoc(back.doc), hashDoc(doc), 'отмена, раунд ' + round);
    for (const [id, p] of tA) { tomb.set(id, p); gone.push(id); }
    doc = res.doc;
    total += a.ops.length;
    txs.push(a.ops);
    // и сырые пачки — тоже в журнал: часть из них не ляжет целиком
    if (round % 7 === 0) txs.push(list);
  }
  assert.ok(total > 1000, 'операций легло: ' + total);
  for (const r of ['removed', 'exists', 'orphan', 'cycle', 'invalid']) assert.ok(reasons[r] > 0, 'встретилась причина ' + r + ': ' + JSON.stringify(reasons));

  // хвост одним черновиком = collectTombstones + applyOps на каждую транзакцию
  let d = start;
  const tb = [];
  const results = [];
  for (const ops of txs) {
    for (const x of collectTombstones(d, ops)) tb.push(x);
    const r = applyOps(d, ops);
    results.push(r.error ? { error: r.error } : null);
    if (!r.error) d = r.doc;
  }
  const got = applyBatches(start, txs);
  assert.equal(hashDoc(got.doc), hashDoc(d));
  assert.equal(got.doc.version, d.version);
  assert.deepEqual(got.tombstones, tb);
  assert.deepEqual(got.results.map((x) => !!x), results.map((x) => !!x));
  assert.ok(results.some(Boolean) && results.some((x) => !x), 'в хвосте есть и легшие, и отказавшие пачки');
  assert.equal(hashDoc(start), startHash, 'вход не изменён');
  assert.equal(JSON.stringify(start), startJSON, 'вход не изменён (вплоть до порядка ключей)');
});

/**
 * Круг 27: пачка, бьющая по длинным спискам детей: переезды внутри списка и
 * между списками (after/index), вставки, вырезание листьев, токены; часть
 * операций не ложится (негодный размер, родитель-текст, цикл, мёртвый after).
 */
function genListBatch(doc, rnd, n, gone, tag) {
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
  const chance = (p) => rnd() < p;
  const ids = Object.keys(doc.nodes);
  // длинные списки — фреймы bigDoc (f0, f1…); фреймы демо-досок короткие
  const frames = ids.filter((id) => /^f\d+$/.test(id) && doc.nodes[id].type === 'frame');
  const texts = ids.filter((id) => doc.nodes[id].type === 'text');
  const sib = (f) => {
    const kids = doc.nodes[f] && doc.nodes[f].children;
    return kids && kids.length ? pick(kids) : pick(texts);
  };
  const place = (f) => {
    const out = {};
    const r = rnd();
    if (r < 0.45) out.after = chance(0.1) ? null : chance(0.1) && gone.length ? pick(gone) : sib(f);
    else if (r < 0.8) out.index = chance(0.5) ? 0 : Math.floor(rnd() * 90) - 2;
    return out;
  };
  const list = [];
  for (let i = 0; i < n; i++) {
    const roll = rnd();
    const f = pick(frames);
    if (roll < 0.4) {
      list.push({ op: 'move', id: chance(0.9) ? pick(texts) : pick(frames), parent: chance(0.95) ? f : pick(texts), ...place(f) });
    } else if (roll < 0.65) {
      const node = text(`${tag}_${i}`, f);
      if (chance(0.05)) node.size = { w: { mode: 'zzz' } };
      list.push({ op: 'create', node, ...place(f) });
    } else if (roll < 0.85) {
      list.push({ op: 'remove', id: chance(0.9) ? pick(texts) : chance(0.5) && gone.length ? pick(gone) : 'нет' });
    } else if (roll < 0.92) {
      list.push({ op: 'set', id: pick(texts), path: chance(0.8) ? 'name' : 'size.w', value: chance(0.8) ? 'n' + i : { mode: 'qq' } });
    } else {
      const k = Math.floor(rnd() * 6);
      list.push(k === 0 ? { op: 'setToken', path: 'colors.c' + Math.floor(rnd() * 30), value: '#0' + i }
        : k === 1 ? { op: 'setToken', path: 'colors.c' + Math.floor(rnd() * 30) }
        : k === 2 ? { op: 'setToken', path: 'spacing.' + Math.floor(rnd() * 12), value: i }
        : k === 3 ? { op: 'setToken', path: 'spacing', value: 'не массив' }
        : k === 4 ? { op: 'setToken', path: 'extra.deep.k' + i, value: { v: i } }
        : { op: 'setToken', path: 'colors', value: null });
    }
  }
  return list;
}

test('круг 27: то же сравнение с эталоном на длинных списках (индекс позиций, правка children на месте)', () => {
  // bigDoc(6, 5) выше не доходит до индекса позиций (он строится со списков от 48
  // детей): здесь фреймы по 60–90 детей, и пачки длиннее — вставки, вырезания и
  // переезды внутри одного списка идут десятками подряд, часть операций не ложится
  // и откатывается по журналу посреди пачки
  const rnd = lcg(271027);
  let doc = bigDoc(4, 90);
  const tomb = new Map();
  const gone = [];
  const start = doc;
  const startJSON = JSON.stringify(start);
  const txs = [];
  let total = 0;
  for (let round = 0; round < 120; round++) {
    const list = genListBatch(doc, rnd, 20 + Math.floor(rnd() * 60), gone, 'q' + round);
    const a = rebase(doc, clone(list), { tombstones: tomb });
    const b = refRebase(doc, clone(list), tomb);
    assert.deepEqual(a, b, 'rebase, раунд ' + round);
    const tA = collectTombstones(doc, a.ops);
    assert.deepEqual(tA, refCollect(doc, a.ops), 'collectTombstones, раунд ' + round);
    assert.deepEqual(collectTombstones(doc, list), refCollect(doc, list), 'collectTombstones сырых, раунд ' + round);
    assert.deepEqual(invertOps(doc, a.ops), refInvert(doc, a.ops), 'invertOps, раунд ' + round);
    const res = applyOps(doc, a.ops);
    assert.equal(res.error, undefined);
    // порядок детей — ровно как у поштучного применения
    let step = doc;
    for (const op of a.ops) step = applyOps(step, [op]).doc;
    assert.equal(JSON.stringify(res.doc.nodes), JSON.stringify(step.nodes), 'пачка = поштучно, раунд ' + round);
    const back = applyOps(res.doc, invertOps(doc, a.ops));
    assert.equal(hashDoc(back.doc), hashDoc(doc), 'отмена, раунд ' + round);
    for (const [id, p] of tA) { tomb.set(id, p); gone.push(id); }
    doc = res.doc;
    total += a.ops.length;
    txs.push(a.ops);
    if (round % 5 === 0) txs.push(list);
  }
  assert.ok(total > 3000, 'операций легло: ' + total);
  let d = start;
  const tb = [];
  for (const ops of txs) {
    for (const x of collectTombstones(d, ops)) tb.push(x);
    const r = applyOps(d, ops);
    if (!r.error) d = r.doc;
  }
  const got = applyBatches(start, txs);
  assert.equal(hashDoc(got.doc), hashDoc(d));
  // откат отказавшей пачки возвращает и порядок ключей палитры (снятый ключ — не в конец)
  assert.equal(JSON.stringify(got.doc.tokens), JSON.stringify(d.tokens));
  assert.deepEqual(got.tombstones, tb);
  assert.equal(JSON.stringify(start), startJSON, 'вход не изменён');
});

test('откат черновика: операция, бросившая на полпути, не оставляет следа — как у прежнего applyOps', () => {
  // фрейм с битым children (null): move сначала снимает узел со старого родителя,
  // потом падает на целевом списке — прежде это ловил applyOps и возвращал исходный doc
  let doc = bigDoc(2, 2);
  doc = { ...doc, nodes: { ...doc.nodes, f1: { ...doc.nodes.f1, children: null } } };
  const list = [
    { op: 'move', id: 't0_0', parent: 'f1' },
    { op: 'set', id: 't0_0', path: 'name', value: 'жив' },
    { op: 'move', id: 't0_1', parent: 'f0', index: 0 }
  ];
  const a = rebase(doc, list, { tombstones: new Map() });
  assert.deepEqual(a, refRebase(doc, list, new Map()));
  assert.deepEqual(a.dropped.map((d) => [d.index, d.reason]), [[0, 'invalid']]);
  const res = applyOps(doc, a.ops);
  assert.equal(res.error, undefined);
  assert.deepEqual(res.doc.nodes.f0.children, ['t0_1', 't0_0'], 't0_0 остался у старого родителя');
  assert.deepEqual(invertOps(doc, list), refInvert(doc, list));
  const batches = applyBatches(doc, [list, list.slice(1)]);
  assert.ok(batches.results[0] && batches.results[0].error, 'первая пачка отказала целиком');
  assert.equal(batches.results[1], null);
  assert.equal(hashDoc(batches.doc), hashDoc(applyOps(doc, list.slice(1)).doc));
});

/* -------------------------------- фаззинг -------------------------------- */

test('фаззинг: 4000 кривых пачек — rebase, applyOps, collectTombstones, invertOps, applyBatches не бросают', () => {
  const rnd = lcg(777);
  const r = (a) => a[Math.floor(rnd() * a.length) % a.length];
  let doc = bigDoc(3, 3);
  const ids = Object.keys(doc.nodes);
  const evil = { toString: 1 };
  const junk = () => r([null, undefined, 0, -1, 1e308, NaN, Infinity, '', 'x', [], {}, [1, 2], { a: { b: 1 } }, true,
    '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', r(ids), 'a'.repeat(5000), { mode: 'fill' },
    [null], evil, { toString: () => { throw new Error('бум'); } }, Symbol('s'), 10n, () => 1, [evil]]);
  const kinds = ['create', 'remove', 'set', 'move', 'setToken', 'zzz', junk()];
  let kept = 0;
  const tomb = new Map([['constructor', 'toString'], ['gone', { toString: 1 }]]);
  for (let it = 0; it < 4000; it++) {
    const list = [];
    for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) {
      if (rnd() < 0.05) { list.push(junk()); continue; }
      const op = { op: r(kinds) };
      if (rnd() < 0.9) op.id = rnd() < 0.6 ? r(ids) : junk();
      if (rnd() < 0.5) op.parent = rnd() < 0.6 ? r(ids) : junk();
      if (rnd() < 0.5) op.path = r(['name', 'characters', 'layout.gap', 'size.w', 'fill', 'children', 'parent', 'id', 'type', '', 'a..b', '__proto__.x', 'style.constructor', junk()]);
      if (rnd() < 0.5) op.value = junk();
      if (rnd() < 0.3) op.index = junk();
      if (rnd() < 0.3) op.after = rnd() < 0.5 ? r(ids) : junk();
      if (op.op === 'create') {
        op.node = rnd() < 0.7
          ? { type: r(['text', 'frame', 'rect', 'instance', 'page', 'zzz', junk()]), id: rnd() < 0.7 ? uid('n') : junk(),
            parent: rnd() < 0.7 ? r(ids) : junk(), name: junk(), children: rnd() < 0.3 ? [r(ids), junk()] : rnd() < 0.1 ? junk() : undefined,
            characters: 'x', layout: rnd() < 0.3 ? junk() : undefined, size: rnd() < 0.3 ? junk() : HUG }
          : junk();
      }
      if (op.op === 'setToken') { op.path = r(['colors.accent', 'spacing.4', '', junk()]); op.value = junk(); }
      list.push(op);
    }
    let m;
    try {
      m = rebase(doc, list, { tombstones: tomb });
    } catch (e) {
      assert.fail('rebase бросил: ' + e.stack);
    }
    assert.equal(m.ops.length + m.dropped.length, list.length, 'каждая операция — либо применена, либо отброшена');
    const res = applyOps(doc, m.ops);
    assert.equal(res.error, undefined, 'после rebase строгий applyOps обязан пройти: ' + JSON.stringify(res.error));
    assert.doesNotThrow(() => applyOps(doc, list));
    assert.doesNotThrow(() => collectTombstones(doc, list));
    assert.doesNotThrow(() => invertOps(doc, m.ops));
    assert.doesNotThrow(() => applyBatches(doc, [list, m.ops]));
    for (const id of ['__proto__', 'constructor', 'toString']) {
      assert.equal(Object.prototype.hasOwnProperty.call(res.doc.nodes, id), false, 'узел с id-ключом прототипа: ' + id);
    }
    assert.equal(Object.getPrototypeOf(res.doc.nodes), Object.prototype, 'прототип словаря узлов цел');
    kept += m.ops.length;
    if (rnd() < 0.3) {
      for (const [id, p] of collectTombstones(doc, m.ops)) tomb.set(id, p);
      doc = res.doc;
    }
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).x, undefined);
  assert.ok(kept > 100, 'часть операций легла: ' + kept);
});

test('id-ключи прототипа: create/remove/move/set с constructor, __proto__, toString — invalid, документ цел', () => {
  const doc = createDoc();
  const board = artboards(doc)[0].id;
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const list = [
      { op: 'create', node: text(id, board) },
      { op: 'remove', id },
      { op: 'set', id, path: 'name', value: 'x' },
      { op: 'move', id, parent: board },
      { op: 'move', id: board, parent: id },
      { op: 'create', node: text(uid('t'), id) },
      { op: 'create', node: frame(uid('f'), board, [id]) }
    ];
    const m = rebase(doc, list, { tombstones: new Map([[id, board]]) });
    assert.deepEqual(m.dropped.map((d) => [d.index, d.reason]).slice(0, 6),
      [[0, 'invalid'], [1, 'invalid'], [2, 'invalid'], [3, 'invalid'], [4, 'invalid'], [5, 'invalid']], id);
    // create фрейма с ребёнком-ключом прототипа: ребёнок вычеркнут, а группировать больше
    // нечего — фрейм отброшен (круг 39: пустая группа не создаётся), причина — мусор в списке
    assert.deepEqual(m.dropped[6] && [m.dropped[6].index, m.dropped[6].reason], [6, 'invalid'], id);
    assert.equal(m.ops.length, 0, id);
    // с живым соседом по списку фрейм создаётся, ключ прототипа вычеркнут
    const kid = artboards(doc)[0].children[0];
    const m2 = rebase(doc, [{ op: 'create', node: frame(uid('f'), board, [id, kid]) }], { tombstones: new Map([[id, board]]) });
    assert.equal(m2.dropped.length, 0, id);
    assert.deepEqual(m2.ops[0].node.children, [kid], id);
    assert.deepEqual(collectTombstones(doc, [{ op: 'remove', id }]), [], 'надгробий нет: ' + id);
    // строгий applyOps — тоже не принимает
    for (const op of list.slice(0, 6)) assert.ok(applyOps(doc, [op]).error, id + ' ' + JSON.stringify(op));
  }
});

/* --------------------------------- бюджет --------------------------------- */

test('rebase: бюджет слияния — остаток операций в dropped с invalid и limit merge_budget', () => {
  const doc = bigDoc(4, 10);
  const texts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text');
  const list = texts.map((id) => ({ op: 'set', id, path: 'name', value: 'z' }));
  const past = rebase(doc, list, { deadline: Date.now() - 1 });
  assert.equal(past.ops.length, 0);
  assert.equal(past.dropped.length, list.length);
  for (const [i, d] of past.dropped.entries()) {
    assert.deepEqual(d, { index: i, op: list[i], reason: 'invalid', limit: 'merge_budget' });
  }
  const none = rebase(doc, list, { budgetMs: 60000 });
  assert.equal(none.ops.length, list.length, 'бюджета хватило — всё легло');
  assert.deepEqual(none, rebase(doc, list), 'с бюджетом, которого хватило, выход тот же');

  // на середине: большой документ, бюджет меньше времени слияния
  const big = bigDoc(40, 150);
  const many = Object.keys(big.nodes).filter((id) => big.nodes[id].type === 'text').slice(0, 5000)
    .map((id, i) => (i % 2 ? { op: 'set', id, path: 'name', value: 'q' } : { op: 'move', id, parent: 'f0', index: 0 }));
  let cut = null;
  for (const ms of [2, 5, 10, 20]) {
    const m = rebase(big, many, { budgetMs: ms });
    const lim = m.dropped.filter((d) => d.limit === 'merge_budget');
    if (lim.length && m.ops.length) { cut = m; break; }
  }
  if (cut) {
    const lim = cut.dropped.filter((d) => d.limit === 'merge_budget');
    const first = lim[0].index;
    assert.equal(lim.length, many.length - first, 'отброшен непрерывный хвост');
    assert.ok(lim.every((d, k) => d.index === first + k && d.reason === 'invalid'));
    assert.equal(applyOps(big, cut.ops).error, undefined, 'принятая часть ложится строго');
  }
});

/* --------------------------------- масштаб --------------------------------- */

test('масштаб: 20 000 узлов — 5000 set и 5000 create через rebase + applyOps, хвост 50×1000 — сотни мс, не минуты', () => {
  const doc = bigDoc(133, 149);   // 1 + 1 доска + 133 × 150 ≈ 20 000 узлов
  const n = Object.keys(doc.nodes).length;
  assert.ok(n >= 19900 && n <= 20100, 'узлов ' + n);
  const texts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text');
  const time = (fn) => { const s = performance.now(); const r = fn(); return [r, performance.now() - s]; };

  // точка отсчёта: один applyOps на 5000 операций (одна копия словаря на пачку)
  const sets = texts.slice(0, 5000).map((id, i) => ({ op: 'set', id, path: 'characters', value: 'строка ' + i }));
  const [, tApply] = time(() => applyOps(doc, sets));
  const [rs, tRebaseSet] = time(() => rebase(doc, sets, { tombstones: new Map() }));
  assert.equal(rs.ops.length, 5000);
  const [, tCollect] = time(() => collectTombstones(doc, rs.ops));
  const [, tInvert] = time(() => invertOps(doc, rs.ops));
  const after = applyOps(doc, rs.ops);
  assert.equal(after.error, undefined);

  const board = artboards(doc)[0].id;
  const creates = [];
  for (let b = 0; b < 50; b++) {
    const f = 'nf' + b;
    creates.push({ op: 'create', node: frame(f, board), after: null });
    for (let k = 0; k < 99; k++) creates.push({ op: 'create', node: text(`nt${b}_${k}`, f), after: k ? `nt${b}_${k - 1}` : null });
  }
  const [rc, tRebaseCreate] = time(() => rebase(doc, creates, { tombstones: new Map() }));
  assert.equal(rc.ops.length, 5000);
  const [ac, tApplyCreate] = time(() => applyOps(doc, rc.ops));
  assert.equal(ac.error, undefined);
  assert.equal(Object.keys(ac.doc.nodes).length, n + 5000);

  // холодная голова: снимок + хвост 50 транзакций по 1000 операций (set, 1% remove)
  const tail = [];
  let k = 0;
  for (let x = 0; x < 50; x++) {
    const ops = [];
    for (let i = 0; i < 1000; i++, k++) {
      ops.push(k % 100 === 99
        ? { op: 'remove', id: texts[texts.length - 1 - Math.floor(k / 100)] }
        : { op: 'set', id: texts[k % 9000], path: 'name', value: 'v' + k });
    }
    tail.push(ops);
  }
  const [cold, tBatches] = time(() => applyBatches(doc, tail));
  assert.ok(cold.results.every((r) => r === null), 'весь хвост лёг');
  const [, tPerTx] = time(() => {
    let d = doc;
    const tb = [];
    for (const ops of tail) {
      for (const x of collectTombstones(d, ops)) tb.push(x);
      d = applyOps(d, ops).doc;
    }
    assert.equal(hashDoc(d), hashDoc(cold.doc));
    assert.deepEqual(tb, cold.tombstones);
  });

  const report = { nodes: n, tApply, tRebaseSet, tCollect, tInvert, tRebaseCreate, tApplyCreate, tBatches, tPerTx };
  const msg = JSON.stringify(report, (key, v) => (typeof v === 'number' ? Math.round(v) : v));
  // прежде: rebase 5000 set ≈ 45 с, collectTombstones ≈ 42 с, invertOps ≈ 42 с, хвост ≈ 190 с.
  // Теперь каждое — в пределах нескольких applyOps той же пачки; абсолютные пороги — с запасом в разы
  const unit = Math.max(tApply, 5);
  assert.ok(tRebaseSet < Math.max(20 * unit, 2000), 'rebase 5000 set: ' + msg);
  assert.ok(tCollect < Math.max(5 * unit, 500), 'collectTombstones без remove: ' + msg);
  assert.ok(tInvert < Math.max(20 * unit, 2000), 'invertOps 5000 set: ' + msg);
  assert.ok(tRebaseCreate < Math.max(20 * unit, 3000), 'rebase 5000 create: ' + msg);
  assert.ok(tBatches < Math.max(30 * unit, 3000), 'хвост 50×1000 одним черновиком: ' + msg);
  assert.ok(tPerTx < Math.max(200 * unit, 15000), 'хвост 50×1000 по транзакциям: ' + msg);
  assert.ok(tBatches < tPerTx, 'один черновик быстрее поштучного: ' + msg);
});

test('масштаб: стоимость rebase растёт с числом операций, а не с произведением операций на узлы', () => {
  const small = bigDoc(13, 149);    // ≈ 2000 узлов
  const large = bigDoc(133, 149);   // ≈ 20 000 узлов
  const setsOf = (doc) => Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text').slice(0, 1900)
    .map((id) => ({ op: 'set', id, path: 'name', value: 'x' }));
  const best = (fn) => { let m = Infinity; for (let i = 0; i < 3; i++) { const s = performance.now(); fn(); m = Math.min(m, performance.now() - s); } return m; };
  const a = setsOf(small);
  const b = setsOf(large);
  const tSmall = best(() => rebase(small, a));
  const tLarge = best(() => rebase(large, b));
  // прежняя реализация: ×10 узлов → ×10 времени. Теперь разница — одна копия словаря
  assert.ok(tLarge < 4 * tSmall + 100, `2000 узлов: ${Math.round(tSmall)} мс, 20 000 узлов: ${Math.round(tLarge)} мс`);
});
