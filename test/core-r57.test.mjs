/**
 * Круг 57 (SPEC §18.5): отмена, повтор и подтверждение сервера — тоже по месту правки (solveNext:
 * прежний документ берётся из памяти раскладки). Результат — тот же, что у полной раскладки.
 * Генератор документов и правок — как в core-r51.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, invertOps, ops, solve, solveNext, solveCarry, hashGeometry } = core;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const measureText = (text, style) => String(text || '').length * (style.fontSize || 16) * 0.52;
const OPTS = { measureText };
const KEPT = { ...OPTS, incremental: true };

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

test('круг57: отмена и повтор по месту — та же геометрия, что у полной (случайные правки, отмены, повторы)', () => {
  let reused = 0;
  let rewinds = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed * 31);
    let doc = randomDoc(r);
    let geo = solve(doc, KEPT);
    const history = [];
    let cursor = 0;
    for (let step = 0; step < 60; step++) {
      const k = r();
      let next = null;
      if (k < 0.3 && cursor > 0) {
        const tx = history[--cursor];
        next = applyOps(doc, tx.inverse).doc;
      } else if (k < 0.45 && cursor < history.length) {
        const tx = history[cursor++];
        next = applyOps(doc, tx.ops).doc;
      } else {
        const op = randomOp(r, doc, step);
        const inverse = invertOps(doc, op);
        const res = applyOps(doc, op);
        if (res.error) continue;
        history.length = cursor;
        history.push({ ops: op, inverse });
        cursor = history.length;
        next = res.doc;
      }
      const rewind = k < 0.45;
      const inc = solveNext(geo, next, OPTS);
      const full = solve(next, OPTS);
      assert.equal(hashGeometry(inc), hashGeometry(full), `зерно ${seed}, шаг ${step}`);
      assert.deepEqual(inc.order, full.order);
      if (rewind) {
        rewinds++;
        if (Object.keys(inc.rects).some((id) => inc.rects[id] === geo.rects[id])) reused++;
      }
      doc = next;
      geo = inc;
    }
  }
  assert.ok(rewinds > 50, `отмен и повторов: ${rewinds}`);
  assert.ok(reused > rewinds / 2, `по месту — ${reused} из ${rewinds} отмен и повторов`);
});

test('круг57: solveNext — тот же документ без пересчёта; без памяти, с другим измерителем или чужим документом — полная', () => {
  const doc = randomDoc(rng(5));
  const geo = solve(doc, KEPT);
  assert.equal(solveNext(geo, doc, OPTS), geo, 'тот же документ — та же геометрия');
  const text = Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'text');
  const next = applyOps(doc, [ops.set(text, 'characters', 'Другое')]).doc;
  const want = hashGeometry(solve(next, OPTS));
  // другой измеритель — полная, но верная
  const other = solveNext(solve(doc, KEPT), next, { measureText: (t) => String(t || '').length * 7 });
  assert.equal(hashGeometry(other), hashGeometry(solve(next, { measureText: (t) => String(t || '').length * 7 })));
  // без памяти (обычная solve) — полная
  const plain = solve(doc, OPTS);
  const p = solveNext(plain, next, OPTS);
  assert.equal(hashGeometry(p), want);
  assert.ok(!Object.keys(p.rects).some((id) => p.rects[id] === plain.rects[id]));
  // документ, собранный заново (те же данные, другие объекты), — верно, хоть и без переноса
  const copy = JSON.parse(JSON.stringify(next));
  assert.equal(hashGeometry(solveNext(solve(doc, KEPT), copy, OPTS)), want);
  assert.equal(hashGeometry(solveNext(null, next, OPTS)), want);
});

test('круг57: подтверждение «как предсказано» переносит память — следующая правка по месту', () => {
  const doc = randomDoc(rng(12));
  const geo = solve(doc, KEPT);
  // сервер прислал тот же документ другими объектами (sameDoc по содержимому): реплика
  // переигрывает свои правки — узлы новые; токены — тот же объект (иначе честно полная)
  const server = { ...JSON.parse(JSON.stringify(doc)), tokens: doc.tokens };
  assert.equal(solveCarry(geo, doc, server), geo);
  const text = Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'text');
  const next = applyOps(server, [ops.set(text, 'characters', 'После подтверждения')]).doc;
  const inc = solveNext(geo, next, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, OPTS)));
  // узлы другие — перенести нечего, но память жива: ещё одна правка снова по месту
  const more = applyOps(next, [ops.set(text, 'characters', 'И ещё раз')]).doc;
  const inc2 = solveNext(inc, more, OPTS);
  assert.equal(hashGeometry(inc2), hashGeometry(solve(more, OPTS)));
  assert.ok(Object.keys(inc2.rects).some((id) => inc2.rects[id] === inc.rects[id]), 'цепочка жива');
});

test('круг57: геометрия отстала на несколько версий (кадр догона) или документ пересобран с теми же узлами — по месту и верно', () => {
  let reused = 0;
  let cases = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const r = rng(seed * 101);
    let doc = randomDoc(r);
    let geo = solve(doc, KEPT);
    for (let step = 0; step < 30; step++) {
      const behind = 1 + Math.floor(r() * 4);
      let next = doc;
      for (let k = 0; k < behind; k++) {
        const res = applyOps(next, randomOp(r, next, `${step}.${k}`));
        if (!res.error) next = res.doc;
      }
      // документ состояния пересобран (новые сведения о документе), узлы те же
      if (r() < 0.3) next = { ...next, meta: { step } };
      const inc = solveNext(geo, next, OPTS);
      assert.equal(hashGeometry(inc), hashGeometry(solve(next, OPTS)), `зерно ${seed}, шаг ${step}, отстала на ${behind}`);
      cases++;
      if (Object.keys(inc.rects).some((id) => inc.rects[id] === geo.rects[id])) reused++;
      doc = next;
      geo = inc;
    }
  }
  assert.ok(reused > cases / 2, `по месту — ${reused} из ${cases}`);
});

test('круг57: короткий путь «тот же документ» не срабатывает с другим измерителем', () => {
  const doc = randomDoc(rng(77));
  const geo = solve(doc, KEPT);
  const narrow = { measureText: (t) => String(t || '').length * 5 };
  const other = solveNext(geo, doc, narrow);
  assert.notEqual(other, geo);
  assert.equal(hashGeometry(other), hashGeometry(solve(doc, narrow)));
  // эпоха шрифтов проверяется тем же условием (memo.epoch); в node ширины не меняются — эпоха не растёт
});
