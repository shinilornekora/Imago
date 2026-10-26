/**
 * Круг 51 (SPEC §18): раскладка по месту правки (solveAfter). Главное свойство — результат
 * совпадает с полной раскладкой solve(nextDoc) байт в байт (hashGeometry) на любых правках.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, ops, solve, solveAfter, hashGeometry } = core;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const measureText = (text, style) => String(text || '').length * (style.fontSize || 16) * 0.52;
const OPTS = { measureText };

/** Псевдослучайность с зерном — падение воспроизводится. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SIZES = [{ mode: 'hug' }, { mode: 'fill' }, { mode: 'fixed', value: 80 }, { mode: 'fixed', value: 200 }];
const LAYOUTS = [
  { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'stretch', justify: 'start', wrap: false },
  { mode: 'row', gap: 4, padding: { t: 4, r: 4, b: 4, l: 4 }, align: 'center', justify: 'between', wrap: false },
  { mode: 'row', gap: 12, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: true },
  { mode: 'free', gap: 0, padding: { t: 10, r: 10, b: 10, l: 10 }, align: 'start', justify: 'start', wrap: false },
];
const WORDS = ['Короткий', 'Заголовок экрана', 'Длинный текст, который точно переносится на несколько строк в узкой рамке', 'Цена 1 990 ₽', ''];

function randomDoc(r, boards = 2, perBoard = 40) {
  const base = quiet(() => createDoc());
  let doc = { ...base, nodes: { [base.root]: { ...base.nodes[base.root], children: [] } } };
  const list = [];
  const frames = [];
  let n = 0;
  for (let b = 0; b < boards; b++) {
    const id = `b${b}`;
    list.push(ops.create({ id, type: 'frame', name: `Доска ${b}`, parent: doc.root, pos: { x: b * 900, y: 0 },
      size: { w: { mode: 'fixed', value: 640 }, h: { mode: 'hug' } }, layout: LAYOUTS[0], children: [] }));
    const local = [id];
    for (let i = 0; i < perBoard; i++) {
      const parent = local[Math.floor(r() * local.length)];
      const kind = r();
      const nid = `n${n++}`;
      if (kind < 0.35) {
        list.push(ops.create({ id: nid, type: 'frame', parent, layout: LAYOUTS[Math.floor(r() * LAYOUTS.length)],
          size: { w: SIZES[Math.floor(r() * SIZES.length)], h: SIZES[Math.floor(r() * 3) === 2 ? 2 : 0] }, children: [] }));
        local.push(nid);
        frames.push(nid);
      } else if (kind < 0.8) {
        list.push(ops.create({ id: nid, type: 'text', parent, characters: WORDS[Math.floor(r() * WORDS.length)],
          style: ['body', 'title', 'caption'][Math.floor(r() * 3)], size: { w: SIZES[Math.floor(r() * 2)], h: { mode: 'hug' } } }));
      } else {
        list.push(ops.create({ id: nid, type: 'rect', parent, fill: 'accent', size: { w: SIZES[Math.floor(r() * SIZES.length)], h: { mode: 'fixed', value: 12 } } }));
      }
    }
  }
  const res = applyOps(doc, list);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  return res.doc;
}

function randomOp(r, doc, step) {
  const ids = Object.keys(doc.nodes).filter((id) => id !== doc.root);
  const pick = (f) => { const l = ids.filter((id) => f(doc.nodes[id])); return l.length ? l[Math.floor(r() * l.length)] : null; };
  const k = r();
  if (k < 0.25) { const id = pick((x) => x.type === 'text'); if (id) return [ops.set(id, 'characters', WORDS[Math.floor(r() * WORDS.length)] + step)]; }
  if (k < 0.4) { const id = pick((x) => x.parent !== doc.root); if (id) return [ops.set(id, 'size', { w: SIZES[Math.floor(r() * SIZES.length)], h: { mode: 'hug' } })]; }
  if (k < 0.5) { const id = pick((x) => x.type === 'frame' && x.parent !== doc.root); if (id) return [ops.set(id, 'layout', LAYOUTS[Math.floor(r() * LAYOUTS.length)])]; }
  if (k < 0.6) { const id = pick((x) => x.parent !== doc.root); if (id) return [ops.set(id, 'visible', r() < 0.5 ? false : true)]; }
  if (k < 0.7) { const p = pick((x) => x.type === 'frame'); if (p) return [ops.create({ id: `x${step}`, type: 'text', parent: p, characters: 'Новый слой ' + step, style: 'body' })]; }
  if (k < 0.8) { const id = pick((x) => x.parent !== doc.root && !(x.children && x.children.length)); if (id) return [ops.remove(id)]; }
  if (k < 0.9) {
    // перенос внутри той же доски
    const id = pick((x) => x.type !== 'frame' && x.parent !== doc.root);
    if (id) {
      const board = core.ancestors(doc, id).map((a) => (a && a.id ? a.id : a)).find((a) => doc.nodes[a] && doc.nodes[a].parent === doc.root);
      const to = pick((x) => x.type === 'frame' && x.id !== id && core.ancestors(doc, x.id).map((a) => (a && a.id ? a.id : a)).concat([x.id]).includes(board));
      if (to) return [ops.move(id, to, 0)];
    }
  }
  if (k < 0.95) return [ops.set(`b${Math.floor(r() * 2)}`, 'pos', { x: Math.round(r() * 2000), y: Math.round(r() * 300) })];
  // правка, после которой — только полная раскладка
  return r() < 0.5 ? [ops.setToken('type.body.fontSize', 14 + Math.floor(r() * 6))] : [ops.set('b0', 'theme', { colors: { canvas: '#101010' } })];
}

test('круг51: по месту правки — та же геометрия, что у полной раскладки (случайные правки)', () => {
  let reused = 0;
  let steps = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed);
    let doc = randomDoc(r);
    let geo = solve(doc, OPTS);
    for (let step = 0; step < 40; step++) {
      const op = randomOp(r, doc, step);
      const res = applyOps(doc, op);
      if (res.error) continue;
      const next = res.doc;
      const inc = solveAfter(geo, doc, next, op, OPTS);
      const full = solve(next, OPTS);
      assert.equal(hashGeometry(inc), hashGeometry(full), `зерно ${seed}, шаг ${step}: ${JSON.stringify(op).slice(0, 200)}`);
      assert.deepEqual(inc.order, full.order);
      // прямоугольник прежней геометрии тем же объектом — признак, что поддерево перенесено, а не пересчитано
      steps++;
      if (Object.keys(inc.rects).some((id) => inc.rects[id] === geo.rects[id])) reused++;
      doc = next;
      geo = inc;
    }
  }
  assert.ok(reused > steps / 2, `по месту правки — ${reused} из ${steps} шагов`);
});

test('круг51: когда по месту нельзя — честно полная (чужая или использованная геометрия, другой измеритель, экземпляры)', () => {
  const doc = randomDoc(rng(99));
  const geo = solve(doc, OPTS);
  const text = Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'text');
  const op = [ops.set(text, 'characters', 'Другое')];
  const next = applyOps(doc, op).doc;
  const a = solveAfter(geo, doc, next, op, OPTS);
  // второй раз той же прежней геометрией — её кеши уже отданы: полная, но верная
  const b = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(a), hashGeometry(solve(next, OPTS)));
  assert.equal(hashGeometry(b), hashGeometry(a));
  // другой документ как «прежний» — полная
  const c = solveAfter(a, doc, next, op, OPTS);
  assert.equal(hashGeometry(c), hashGeometry(a));
  // без прежней геометрии — полная
  assert.equal(hashGeometry(solveAfter(null, doc, next, op, OPTS)), hashGeometry(a));
});

test('круг51: 1 тыс. слоёв — правка текста по месту заметно быстрее полной', () => {
  const base = quiet(() => createDoc());
  let doc = { ...base, nodes: { [base.root]: { ...base.nodes[base.root], children: [] } } };
  const list = [ops.create({ id: 'b', type: 'frame', parent: doc.root, pos: { x: 0, y: 0 }, size: { w: { mode: 'fixed', value: 1440 }, h: { mode: 'hug' } },
    layout: { mode: 'row', gap: 16, padding: { t: 24, r: 24, b: 24, l: 24 }, align: 'start', justify: 'start', wrap: true }, children: [] })];
  for (let i = 0; i < 250; i++) {
    list.push(ops.create({ id: `c${i}`, type: 'frame', parent: 'b', size: { w: { mode: 'fixed', value: 220 }, h: { mode: 'hug' } }, layout: LAYOUTS[0], children: [] }),
      ops.create({ id: `c${i}t`, type: 'text', parent: `c${i}`, characters: `Заголовок ${i}`, style: 'title', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
      ops.create({ id: `c${i}b`, type: 'text', parent: `c${i}`, characters: WORDS[2], style: 'body', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
      ops.create({ id: `c${i}r`, type: 'rect', parent: `c${i}`, size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 6 } } }));
  }
  doc = applyOps(doc, list).doc;
  let geo = solve(doc, OPTS);
  let full = 0;
  let inc = 0;
  for (let i = 0; i < 20; i++) {
    const op = [ops.set('c125b', 'characters', `${WORDS[2]} ${i % 2 ? '' : WORDS[2]}`)];
    const next = applyOps(doc, op).doc;
    let t = performance.now();
    solve(next, OPTS);
    full += performance.now() - t;
    t = performance.now();
    geo = solveAfter(geo, doc, next, op, OPTS);
    inc += performance.now() - t;
    doc = next;
  }
  assert.ok(inc * 2 < full, `по месту ${inc.toFixed(1)} мс против полной ${full.toFixed(1)} мс`);
});
