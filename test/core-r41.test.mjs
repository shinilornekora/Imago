import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, rebase, solve, artboards, ops: OPS, pathCacheStats, PATH_CACHE_CHARS } = core;

/* Круг 41, CORE. Слияние «обернуть»: create с перечисленными детьми, отброшенный
   rebase (cycle/removed/orphan/invalid), тянет за собой операции той же пачки,
   вычисленные относительно него, — set pos/size/override детей, которые он должен
   был принять, set по самому узлу, create/move в него. Ребёнок не прыгает в (0,0)
   (сценарий критика critic-code/w/wrapcycle.mjs). */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const fx = (v) => ({ mode: 'fixed', value: v });

/** Холст X (свободный) → рамка P (свободная) → прямоугольник a и свободная рамка c. */
function base() {
  let d = createDoc();
  const b = artboards(d)[0].id;
  d = applyOps(d, [
    OPS.create({ type: 'frame', id: 'X', name: 'Холст', parent: b, children: [], layout: { mode: 'none' }, size: { w: fx(600), h: fx(400) } }),
    OPS.create({ type: 'frame', id: 'P', name: 'P', parent: 'X', children: [], pos: { x: 10, y: 10 }, layout: { mode: 'none' }, size: { w: fx(300), h: fx(200) } }),
    OPS.create({ type: 'rect', id: 'a', name: 'а', parent: 'P', pos: { x: 20, y: 30 }, size: { w: fx(40), h: fx(40) } }),
    OPS.create({ type: 'frame', id: 'c', name: 'в', parent: 'P', children: [], pos: { x: 100, y: 80 }, layout: { mode: 'none' }, size: { w: fx(250), h: fx(250) } })
  ]).doc;
  return d;
}

/** Правка «обернуть» так, как её пишет оболочка: рамка с детьми и pos детей в координатах рамки. */
function wrap(kids, at = { x: 20, y: 30 }) {
  const list = [{ op: 'create', node: { type: 'frame', id: 'W', name: 'Группа', parent: 'P', children: kids.slice(), layout: { mode: 'none' }, pos: at, size: { w: fx(330), h: fx(300) } } }];
  kids.forEach((k, i) => list.push({ op: 'set', id: k, path: 'pos', value: { x: i * 80, y: i * 50 } }));
  return list;
}

/** Слияние как в DSLTS: rebase → строгий applyOps оставленного. */
function merge(head, list, tomb) {
  const r = quiet(() => rebase(head, clone(list), tomb ? { tombstones: tomb } : undefined));
  const a = quiet(() => applyOps(head, r.ops));
  assert.equal(a.error, undefined, a.error && a.error.message);
  return { r, doc: a.doc };
}

const reasons = (r) => r.dropped.map((x) => [x.op.op, x.op.id || (x.op.node && x.op.node.id), x.reason]);

test('круг41: wrapcycle — create обёртки отброшен как цикл, set pos ребёнка — тоже (cycle), ребёнок остаётся на месте', () => {
  const d = base();
  // соавтор: c на холст X, затем P внутрь c — теперь c предок P
  const head = applyOps(d, [{ op: 'move', id: 'c', parent: 'X', index: 0 }, { op: 'set', id: 'c', path: 'pos', value: { x: 300, y: 100 } },
    { op: 'move', id: 'P', parent: 'c', index: 0 }]).doc;
  const { r, doc } = merge(head, wrap(['c']));
  assert.deepEqual(r.ops, []);
  assert.deepEqual(reasons(r), [['create', 'W', 'cycle'], ['set', 'c', 'cycle']]);
  assert.deepEqual(doc.nodes.c.pos, { x: 300, y: 100 }, 'не прыгнул в (0,0)');
  const g = solve(doc);
  assert.deepEqual(g.rects.c, solve(head).rects.c, 'на холсте — там же');
});

test('круг41: часть детей вычеркнута циклом — обёртка ложится с остальными, pos вычеркнутого отброшен (cycle)', () => {
  const d = base();
  const head = applyOps(d, [{ op: 'move', id: 'c', parent: 'X', index: 0 }, { op: 'set', id: 'c', path: 'pos', value: { x: 300, y: 100 } },
    { op: 'move', id: 'P', parent: 'c', index: 0 }]).doc;
  const { r, doc } = merge(head, wrap(['a', 'c']));
  assert.deepEqual(reasons(r), [['set', 'c', 'cycle']]);
  assert.equal(doc.nodes.a.parent, 'W');
  assert.deepEqual(doc.nodes.a.pos, { x: 0, y: 0 }, 'принятый ребёнок — в координатах рамки');
  assert.deepEqual(doc.nodes.c.pos, { x: 300, y: 100 }, 'вычеркнутый — где был');
});

test('круг41: дети удалены — обёртка и правки по ней отброшены с одной причиной (removed), прочее ложится', () => {
  const d = base();
  const head = applyOps(d, [{ op: 'remove', id: 'c' }]).doc;
  const list = wrap(['c']).concat([
    { op: 'set', id: 'W', path: 'name', value: 'Карточка' },
    { op: 'set', id: 'a', path: 'name', value: 'не связано с рамкой' }
  ]);
  const { r, doc } = merge(head, list, new Map([['c', 'P']]));
  assert.deepEqual(reasons(r), [['create', 'W', 'removed'], ['set', 'c', 'removed'], ['set', 'W', 'removed']]);
  assert.equal(doc.nodes.a.name, 'не связано с рамкой', 'прочее ложится');
  // пачка, которая сама кладёт в рамку что-то ещё, рамку сохраняет (правило круга 39)
  const kept = merge(head, list.concat([{ op: 'create', node: { type: 'text', id: 't', parent: 'W', characters: 'подпись' } }]), new Map([['c', 'P']]));
  assert.equal(kept.doc.nodes.t.parent, 'W');
  assert.equal(kept.doc.nodes.W.name, 'Карточка');
});

test('круг41: родитель обёртки удалён без надгробий (orphan) — pos детей тоже orphan; переложенный той же пачкой ребёнок — считается от нового места', () => {
  const d = base();
  const list = [{ op: 'create', node: { type: 'frame', id: 'W', parent: 'Q', children: ['a'], layout: { mode: 'none' }, pos: { x: 0, y: 0 } } },
    { op: 'set', id: 'a', path: 'pos', value: { x: 5, y: 5 } },
    { op: 'set', id: 'a', path: 'size', value: { w: fx(10), h: fx(10) } },
    { op: 'create', node: { type: 'text', id: 't', parent: 'W', characters: 'подпись' } },
    { op: 'move', id: 'c', parent: 'W', index: 0 },
    { op: 'move', id: 'a', parent: 'X', index: 0 },
    { op: 'set', id: 'a', path: 'pos', value: { x: 7, y: 9 } }];
  const { r, doc } = merge(d, list);
  assert.deepEqual(reasons(r), [['create', 'W', 'orphan'], ['set', 'a', 'orphan'], ['set', 'a', 'orphan'], ['create', 't', 'orphan'], ['move', 'c', 'orphan']]);
  assert.equal(doc.nodes.c.parent, 'P', 'в несозданную рамку не переезжает');
  assert.equal(doc.nodes.a.parent, 'X');
  assert.deepEqual(doc.nodes.a.pos, { x: 7, y: 9 });
});

test('круг41: обёртка легла — правила не мешают; не геометрия детей ложится всегда', () => {
  const d = base();
  const list = wrap(['a', 'c']).concat([{ op: 'set', id: 'c', path: 'name', value: 'ок' }]);
  const { r, doc } = merge(d, list);
  assert.deepEqual(r.dropped, []);
  assert.equal(doc.nodes.c.parent, 'W');
  assert.deepEqual(doc.nodes.c.pos, { x: 80, y: 50 });
  // отброшен create — но set имени ребёнка не про рамку и ложится
  const head = applyOps(d, [{ op: 'move', id: 'c', parent: 'X', index: 0 }, { op: 'move', id: 'P', parent: 'c', index: 0 }]).doc;
  const m = merge(head, wrap(['c']).concat([{ op: 'set', id: 'c', path: 'name', value: 'ок' }]));
  assert.equal(m.doc.nodes.c.name, 'ок');
  assert.deepEqual(reasons(m.r), [['create', 'W', 'cycle'], ['set', 'c', 'cycle']]);
});

test('круг41: фаззинг — отброшенная обёртка никогда не оставляет детям геометрию «в рамке»', () => {
  let s = 41;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let dropped = 0;
  for (let n = 0; n < 400; n++) {
    const d = base();
    // конкурентная правка соавтора
    const other = [];
    for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
      const r = rnd();
      if (r < 0.3) other.push({ op: 'remove', id: pick(['a', 'c']) });
      else if (r < 0.6) other.push({ op: 'move', id: pick(['c', 'a']), parent: 'X', index: 0 });
      else other.push({ op: 'move', id: 'P', parent: pick(['c', 'X']), index: 0 });
    }
    const hb = quiet(() => rebase(d, other));
    const head = applyOps(d, hb.ops).doc;
    const tomb = new Map(core.collectTombstones(d, hb.ops));
    const kids = pick([['a'], ['c'], ['a', 'c']]);
    const { r, doc } = merge(head, wrap(kids), tomb);
    const lostW = r.dropped.some((x) => x.op.op === 'create');
    if (lostW) dropped++;
    for (const k of kids) {
      if (!doc.nodes[k]) continue;
      if (doc.nodes[k].parent !== 'W') {
        assert.deepEqual(doc.nodes[k].pos, head.nodes[k].pos, `ребёнок ${k} не в рамке — pos прежний (${JSON.stringify(other)})`);
      }
    }
  }
  assert.ok(dropped > 30, `обёрток отброшено: ${dropped}`);
});

test('круг41: кеш проверки путей — 4096 длинных и 4096 средних разных путей держат около мегабайта, не десятки', () => {
  const seg = ' l1 1'.repeat(3990);
  let doc = createDoc('empty');
  doc = applyOps(doc, [{ op: 'create', node: { type: 'frame', id: 'f_a', parent: doc.root, layout: { mode: 'none' }, pos: { x: 0, y: 0 } } },
    { op: 'create', node: { type: 'vector', id: 'n_v', parent: 'f_a', viewBox: { x: 0, y: 0, w: 4000, h: 4000 }, paths: [{ d: 'M0 0 L1 1' }] } }]).doc;
  for (let i = 0; i < 4096; i++) applyOps(doc, [{ op: 'set', id: 'n_v', path: 'paths', value: [{ d: `M${i} 0` + seg }] }]);
  for (let i = 0; i < 4096; i++) applyOps(doc, [{ op: 'set', id: 'n_v', path: 'paths', value: [{ d: `M${i} 0` + ' l1 1'.repeat(810) }] }]);
  const st = pathCacheStats();
  // прежний кеш (4096 ключей до 20 000 символов) держал бы ~16 млн символов ключей
  assert.ok(st.chars <= PATH_CACHE_CHARS && PATH_CACHE_CHARS <= 1 << 20, `${st.chars} символов`);
});
