import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, invertOps, hashDoc, checkImportDoc, rebase, solve, validate, hashGeometry, Stage, ops,
  parsePath, formatPath, pathBounds, fitVector, translatePath, resolvePaint, paintCss, paintProblem, resolveColor,
  vectorSummary, isFreeFrame, sampleIllustration, VECTOR_LIMITS, NODE_TYPES, fieldProblem,
  makeComponentOps, instanceOps, expandInstance
} = core;

/* Круг 37, CORE (SPEC §12): векторные иллюстрации — тип узла vector, разбор путей,
   краски с градиентами, поворот, свободная рамка; решатель (hug = viewBox),
   валидатор §12.1, отрисовка и экспорт (контуры, градиенты в <defs>, поворот),
   пример sampleIllustration. */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const M = { measureText: (t, s) => String(t).length * (s && s.fontSize ? s.fontSize : 15) * 0.55 };
const fixed = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });

function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

/** Правка легла, документ импортируется, отмена и повтор точные, сервер принимает. */
function assertSound(doc, list, what) {
  const r = quiet(() => applyOps(doc, clone(list)));
  assert.equal(r.error, undefined, `${what}: ${r.error && r.error.message}`);
  assert.equal(checkImportDoc(clone(r.doc)), null, `${what}: документ импортируется — ${JSON.stringify(checkImportDoc(clone(r.doc)))}`);
  const inv = clone(invertOps(doc, clone(list)));
  const back = quiet(() => applyOps(r.doc, inv));
  assert.equal(back.error, undefined, `${what}: отмена ложится`);
  assert.equal(hashDoc(back.doc), hashDoc(doc), `${what}: отмена точная`);
  const redo = clone(invertOps(r.doc, clone(inv)));
  const again = quiet(() => applyOps(back.doc, redo));
  assert.equal(again.error, undefined, `${what}: повтор ложится`);
  assert.equal(hashDoc(again.doc), hashDoc(r.doc), `${what}: повтор точный`);
  const m = quiet(() => rebase(doc, clone(list), { tombstones: new Map() }));
  assert.equal(m.ops.length, list.length, `${what}: rebase применяет`);
  return r.doc;
}

function rejected(doc, list, what, code = 'bad-node') {
  const r = quiet(() => applyOps(doc, clone(list)));
  assert.ok(r.error, `${what}: должна быть отклонена`);
  assert.equal(r.error.code, code, `${what}: код ${r.error.code} — ${r.error.message}`);
  const m = quiet(() => rebase(doc, clone(list), { tombstones: new Map() }));
  assert.equal(m.ops.length, 0, `${what}: сервер не применяет`);
  return r.error;
}

const GRAD = { gradient: { kind: 'linear', angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, token: 'accent', opacity: 0.5 }] } };
const RADIAL = { gradient: { kind: 'radial', cx: 0.3, cy: 0.3, r: 0.7, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] } };

/** Доска-иллюстрация (свободная рамка) с вектором, эллипсом и текстом. */
function artDoc() {
  let doc = createDoc('empty');
  const r = applyOps(doc, [
    ops.create({ type: 'frame', id: 'ab', name: 'Экран', parent: doc.root, children: [], pos: { x: 0, y: 0 }, fill: 'surface',
      size: fixed(400, 300), layout: { mode: 'column', padding: 'spacing.4' } }),
    ops.create({ type: 'frame', id: 'art', name: 'Иллюстрация', parent: 'ab', children: [], clip: true, size: fixed(200, 200), layout: { mode: 'none' } }),
    ops.create({ type: 'vector', id: 'v', name: 'Капля', parent: 'art', pos: { x: 20, y: 30 }, size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
      viewBox: { w: 100, h: 50 }, paths: [{ d: 'M0 50C0 0 100 0 100 50Z', fill: GRAD }, { d: 'M10 40h80', stroke: '#112233', strokeWidth: 4, lineCap: 'round' }] }),
    ops.create({ type: 'ellipse', id: 'e', name: 'Глаз', parent: 'art', pos: { x: 40, y: 40 }, size: fixed(20, 20), fill: RADIAL }),
    ops.create({ type: 'text', id: 't', name: 'Подпись', parent: 'art', characters: 'Хо', style: 'body' })
  ]);
  assert.equal(r.error, undefined, r.error && r.error.message);
  return r.doc;
}

/* ----------------------------- parsePath ----------------------------- */

test('круг37: parsePath — годные пути: абсолютные/относительные, неявные повторы, дуги со слитными флагами, экспоненты', () => {
  const ok = (d, want) => {
    const r = parsePath(d);
    assert.equal(r.ok, true, `${d}: ${r.error}`);
    if (want !== undefined) assert.equal(formatPath(r.cmds), want, d);
    return r;
  };
  ok('M10 10l5 5 5-5z', 'M10 10L15 15L20 10Z');
  ok('m1,2,3,4', 'M1 2L4 6');                               // повтор после m — относительная l
  ok('M0 0 10 0 10 10Z', 'M0 0L10 0L10 10Z');
  ok('M0 0h10v10H0V0', 'M0 0H10V10H0V0');
  ok('M0 0c1 2 3 4 5 6s1 1 2 2', 'M0 0C1 2 3 4 5 6S6 7 7 8');
  ok('M0 0q1 1 2 2t3 3', 'M0 0Q1 1 2 2T5 5');
  ok('M0 0a5 5 0 0110 10', 'M0 0A5 5 0 0 1 10 10');           // флаги слитно с числом
  ok('M0 0A5 5 30 1 0 10 10', 'M0 0A5 5 30 1 0 10 10');
  ok('M1e1 .5-1.5.5', 'M10 0.5L-1.5 0.5');                    // экспонента, «.5», знак как разделитель
  ok('  M 1 2 , 3 4 Z m 1 1 2 2 ', 'M1 2L3 4ZM2 3L4 5');      // после Z относительное — от начала подпути
  ok('M0 0ZM5 5Z', 'M0 0ZM5 5Z');
  const r = ok('M0 0L1 1');
  assert.deepEqual(r.cmds, [{ c: 'M', a: [0, 0] }, { c: 'L', a: [1, 1] }]);
  assert.equal(r.count, 2);
  assert.equal(Object.is(parsePath('M-0 -0').cmds[0].a[0], 0), true, 'без -0');
});

test('круг37: parsePath — битые пути: ошибка с позицией, без NaN/Infinity, пределы длины и координат', () => {
  const bad = (d, re) => {
    const r = parsePath(d);
    assert.equal(r.ok, false, `${JSON.stringify(d).slice(0, 60)} должен быть отвергнут`);
    assert.equal(typeof r.error, 'string');
    assert.ok(Number.isInteger(r.at) && r.at >= 0, 'позиция ошибки');
    if (re) assert.match(r.error, re, JSON.stringify(d).slice(0, 60));
  };
  bad('', /пуст/); bad('   ', /пуст/); bad(null); bad(42); bad({ d: 'M0 0' });
  bad('L1 2', /начинается с M/); bad('10 10', /начинается с M/);
  bad('M1 2,', /запят/); bad('M1 2L3 4,,5 6', /запят/); bad('M,1 2');
  bad('M1 2 L', /2 числа/); bad('M1 2 C1 2 3', /6 чисел/); bad('M1');
  bad('M1 2 a1 1 0 2 1 3 3', /флаг/);
  bad('M1 2 x', /неизвестная команда/); bad('M1 2 NaN'); bad('M1 2 Infinity'); bad('M0 0L1e999 0');
  bad('M1e400 2', /вне/); bad('M0 0L1000001 0', /вне/);
  bad('M1 2 Z 3 4', /после Z/);
  bad('M0 1e6' + ' l1e6 0'.repeat(3), /вне пределов/);   // относительные набегают за предел
  bad('M0 0' + 'L1 1'.repeat(6000), /длиннее/);
  const max = 'M0 0' + 'L1 1'.repeat((VECTOR_LIMITS.maxD - 4) / 4);
  assert.equal(max.length, VECTOR_LIMITS.maxD);
  assert.equal(parsePath(max).ok, true, 'ровно предел — годен');
  bad(max + ' ', /длиннее/);
  // огромный годный по длине вход разбирается быстро (линейно)
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) parsePath('M0 0' + 'c1.5 2.5 3.5 4.5 5.5 6.5'.repeat(700));
  assert.ok(Date.now() - t0 < 3000, 'разбор линейный');
});

test('круг37: pathBounds — точно по кривым и дугам, с обводкой; translatePath; fitVector', () => {
  assert.deepEqual(pathBounds('M0 0C0 100 100 100 100 0'), { x: 0, y: 0, w: 100, h: 75 });
  assert.deepEqual(pathBounds('M0 0Q50 100 100 0'), { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(pathBounds('M10 10A10 10 0 1 0 30 10A10 10 0 1 0 10 10Z'), { x: 10, y: 0, w: 20, h: 20 });
  assert.deepEqual(pathBounds('M0 0h10v5'), { x: 0, y: 0, w: 10, h: 5 });
  assert.deepEqual(pathBounds('M0 0C10 0 10 0 10 10S0 20 0 20'), pathBounds('M0 0C10 0 10 0 10 10C10 20 0 20 0 20'), 'S отражает контрольную точку');
  assert.deepEqual(pathBounds([{ d: 'M0 0L10 0', stroke: '#000', strokeWidth: 4 }]), { x: -2, y: -2, w: 14, h: 4 });
  assert.deepEqual(pathBounds([{ d: 'M0 0L10 0', stroke: '#000', strokeWidth: 4 }], { stroke: false }), { x: 0, y: 0, w: 10, h: 0 });
  assert.deepEqual(pathBounds(['M0 0L1 1', 'M5 5L6 9', 'битый']), { x: 0, y: 0, w: 6, h: 9 });
  assert.equal(pathBounds('битый'), null);
  assert.equal(pathBounds([]), null);
  assert.equal(translatePath('m1 1 l2 2 h3 a5 5 0 0 1 10 10z', 10, -5), 'M11 -4L13 -2H16A5 5 0 0 1 26 8Z');
  assert.equal(translatePath('битый', 1, 1), '');
  const fit = fitVector([{ d: 'M50 60L150 60L100 140Z', fill: '#000' }]);
  assert.deepEqual(fit, { viewBox: { x: 50, y: 60, w: 100, h: 80 }, pos: { x: 50, y: 60 }, size: fixed(100, 80) });
  assert.equal(fitVector('M0 0L10 0').viewBox.h, 1, 'вырожденная рамка — не тоньше 1');
  assert.equal(fitVector('битый'), null);
});

/* ----------------------------- схема ----------------------------- */

test('круг37: vector и краски — годные значения ложатся, отмена и повтор точные; vector в NODE_TYPES', () => {
  assert.ok(NODE_TYPES.has('vector'));
  let doc = artDoc();
  assert.equal(checkImportDoc(clone(doc)), null);
  const cases = [
    [{ op: 'set', id: 'v', path: 'paths.0.d', value: 'M0 0L100 0L50 50Z' }],
    [{ op: 'set', id: 'v', path: 'paths.0.fill', value: RADIAL }],
    [{ op: 'set', id: 'v', path: 'paths.0.fill', value: 'accent' }],
    [{ op: 'set', id: 'v', path: 'paths.0.fill', value: null }],
    [{ op: 'set', id: 'v', path: 'paths.0.fill' }],
    [{ op: 'set', id: 'v', path: 'paths.1.strokeWidth', value: 64 }],
    [{ op: 'set', id: 'v', path: 'paths.1.lineJoin', value: 'bevel' }],
    [{ op: 'set', id: 'v', path: 'paths.0.fillRule', value: 'evenodd' }],
    [{ op: 'set', id: 'v', path: 'paths.0.name', value: 'Силуэт' }],
    [{ op: 'set', id: 'v', path: 'paths.2', value: { d: 'M0 0h5', stroke: GRAD } }],   // дописать в конец
    [{ op: 'set', id: 'v', path: 'paths', value: [] }],
    [{ op: 'set', id: 'v', path: 'viewBox', value: { x: -10, y: -10, w: 120, h: 70 } }],
    [{ op: 'set', id: 'v', path: 'viewBox.x', value: 5 }],
    [{ op: 'set', id: 'v', path: 'rotate', value: -45 }],
    [{ op: 'set', id: 'v', path: 'fill', value: GRAD }],
    [{ op: 'set', id: 'v', path: 'stroke', value: { color: RADIAL, width: 2 } }],
    [{ op: 'set', id: 'v', path: 'opacity', value: 0.5 }],
    [{ op: 'set', id: 'v', path: 'states', value: { hover: { scale: 1.05, fill: 'accent' } } }],
    [{ op: 'set', id: 'art', path: 'fill', value: GRAD }],
    [{ op: 'set', id: 'art', path: 'rotate', value: 12.5 }],
    [{ op: 'set', id: 't', path: 'color', value: RADIAL }],
    [{ op: 'set', id: 't', path: 'rotate', value: 360 }],
    [{ op: 'set', id: 'e', path: 'fill.gradient.stops.0.at', value: 0.25 }],
    [{ op: 'set', id: 'e', path: 'fill.gradient.stops.2', value: { at: 0.5, color: '#00ff00' } }],
    [{ op: 'set', id: 'e', path: 'fill.gradient.kind', value: 'linear' }],
    [{ op: 'set', id: 'v', path: 'pos', value: { x: -30, y: 250 } }],
    [ops.create({ type: 'vector', parent: 'art', viewBox: { w: 1, h: 1 }, paths: [] })],
    [ops.create({ type: 'vector', parent: 'art', viewBox: { w: 24, h: 24 }, paths: [{ d: 'M2 2h20v20H2z', fill: { token: 'accent' }, opacity: 0 }], rotate: 30, size: fixed(48, 48) })],
    [ops.create({ type: 'rect', parent: 'art', fill: RADIAL, size: fixed(10, 10), rotate: 5 })],
    [ops.remove('v')]
  ];
  for (const list of cases) assertSound(doc, list, JSON.stringify(list).slice(0, 140));
  // 256 контуров и суммарный предел длины — годны ровно на пределе
  const many = Array.from({ length: VECTOR_LIMITS.maxPaths }, (_, i) => ({ d: `M${i} 0h1` }));
  doc = assertSound(doc, [{ op: 'set', id: 'v', path: 'paths', value: many }], '256 контуров');
  const long = 'M0 0' + 'L1 1'.repeat(4999);   // 20 000 символов
  const five = Array.from({ length: 5 }, () => ({ d: long }));
  assertSound(doc, [{ op: 'set', id: 'v', path: 'paths', value: five }], '5×20 000 = 100 000');
});

test('круг37: негодные векторы, контуры, краски и поворот — bad-node', () => {
  const doc = artDoc();
  const bad = [
    [{ op: 'set', id: 'v', path: 'paths.0.d', value: 'L0 0' }, /начинается с M/],
    [{ op: 'set', id: 'v', path: 'paths.0.d', value: '' }, /пуст/],
    [{ op: 'set', id: 'v', path: 'paths.0.d', value: 5 }, /строкой/],
    [{ op: 'set', id: 'v', path: 'paths.0', value: 'M0 0' }, /контур — объект/],
    [{ op: 'set', id: 'v', path: 'paths.0.color', value: '#fff' }, /поля контура/],
    [{ op: 'set', id: 'v', path: 'paths.0.strokeWidth', value: 65 }, /strokeWidth/],
    [{ op: 'set', id: 'v', path: 'paths.0.opacity', value: 2 }, /opacity/],
    [{ op: 'set', id: 'v', path: 'paths.0.fillRule', value: 'odd' }, /fillRule/],
    [{ op: 'set', id: 'v', path: 'paths.0.lineCap', value: 'flat' }, /lineCap/],
    [{ op: 'set', id: 'v', path: 'paths.0.name', value: 'x'.repeat(201) }, /name/],
    [{ op: 'set', id: 'v', path: 'paths', value: {} }, /массив/],
    [{ op: 'set', id: 'v', path: 'paths', value: Array.from({ length: 257 }, () => ({ d: 'M0 0' })) }, /256/],
    [{ op: 'set', id: 'v', path: 'paths', value: Array.from({ length: 6 }, () => ({ d: 'M0 0' + 'L1 1'.repeat(4999) })) }, /суммарно/],
    [{ op: 'set', id: 'v', path: 'paths' }, /нет paths/],
    [{ op: 'set', id: 'v', path: 'viewBox' }, /нет viewBox/],
    [{ op: 'set', id: 'v', path: 'viewBox.w', value: 0 }, /viewBox.w/],
    [{ op: 'set', id: 'v', path: 'viewBox.h', value: 1e6 }, /viewBox.h/],
    [{ op: 'set', id: 'v', path: 'viewBox.x', value: 'a' }, /viewBox.x/],
    [{ op: 'set', id: 'v', path: 'viewBox.z', value: 1 }, /поля — x, y, w, h/],
    [{ op: 'set', id: 'v', path: 'rotate', value: 361 }, /rotate/],
    [{ op: 'set', id: 'v', path: 'rotate', value: '45' }, /rotate/],
    [{ op: 'set', id: 'e', path: 'viewBox', value: { w: 1, h: 1 } }, /только у vector/],
    [{ op: 'set', id: 'e', path: 'paths', value: [] }, /только у vector/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'conic', stops: [{ at: 0, color: '#fff' }] } } }, /kind/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: [] } } }, /stops/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', angle: 400, stops: [{ at: 0, color: '#fff' }] } } }, /angle/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'radial', r: 2, stops: [{ at: 0, color: '#fff' }] } } }, /\.r/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: Array.from({ length: 17 }, (_, i) => ({ at: i / 16, color: '#fff' })) } } }, /16/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: [{ at: 0, color: '#fff', token: 'accent' }] } } }, /ровно один/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: [{ at: 0 }] } } }, /ровно один/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: [{ at: 1.5, color: '#fff' }] } } }, /at/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: [{ at: 0, color: '#fff', glow: 1 }] } } }, /поля стопа/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', stops: [{ at: 0, color: '#fff' }] }, token: 'accent' } }, /других ключей/],
    [{ op: 'set', id: 'v', path: 'fill', value: { gradient: { kind: 'linear', spin: 1, stops: [{ at: 0, color: '#fff' }] } } }, /поля градиента/],
    [{ op: 'set', id: 'v', path: 'stroke', value: GRAD }, /stroke.color/],
    [{ op: 'set', id: 'v', path: 'states', value: { hover: { fill: GRAD } } }, /градиент недопустим/],
    [{ op: 'set', id: 'v', path: 'states', value: { hover: { stroke: { color: GRAD, width: 1 } } } }, /градиент недопустим/],
    [{ op: 'set', id: doc.root, path: 'rotate', value: 10 }, /страницу/],
    [ops.create({ type: 'vector', parent: 'art', paths: [] }), /нет viewBox/],
    [ops.create({ type: 'vector', parent: 'art', viewBox: { w: 1, h: 1 } }), /нет paths/],
    [ops.create({ type: 'vector', parent: 'art', viewBox: { w: 1, h: 1 }, paths: [], children: ['t'] }), /дети/],
    [ops.create({ type: 'frame', parent: 'v', children: [] }), null, 'bad-parent']
  ];
  for (const [op, re, code] of bad) {
    const err = rejected(doc, [op], JSON.stringify(op).slice(0, 140), code || 'bad-node');
    if (re) assert.match(err.message, re, JSON.stringify(op).slice(0, 140));
  }
  assert.equal(paintProblem(GRAD, 'fill'), null);
  assert.match(paintProblem(GRAD, 'fill', true), /градиент недопустим/);
});

test('круг37: импорт — негодный вектор — bad-doc; createDoc чинит по контурам, viewBox, градиентам', () => {
  const base = artDoc();
  const withNode = (patch) => { const d = clone(base); Object.assign(d.nodes.v, patch); return d; };
  for (const patch of [{ paths: [{ d: 'Q' }] }, { viewBox: { w: -1, h: 1 } }, { rotate: 1000 }, { paths: 'M0 0' },
    { fill: { gradient: { kind: 'linear', stops: [] } } }, { paths: [{ d: 'M0 0', fill: { gradient: { kind: 'x', stops: [{ at: 0, color: '#fff' }] } } }] }]) {
    const err = checkImportDoc(withNode(patch));
    assert.ok(err && err.code === 'bad-doc', JSON.stringify(patch) + ' → ' + JSON.stringify(err));
  }
  const raw = clone(base);
  raw.nodes.e.viewBox = { w: 1, h: 1 };
  assert.match(checkImportDoc(raw).message, /только у vector/);
  // createDoc: битые контуры — прочь, годные остаются; поля контура — по одному
  const broken = withNode({
    viewBox: 'нет',
    paths: [{ d: 'Q1' }, { d: 'M10 10L30 40', stroke: '#000', strokeWidth: 999, junk: 1 }, 'строка',
      { d: 'M0 0h5', fill: { gradient: { kind: 'zzz', angle: 900, stops: [{ at: 0.5, color: '#ff0000', opacity: 7 }, { at: 'x', color: '#fff' }, 5] } } }],
    rotate: 'кругом', fill: { gradient: { kind: 'radial', stops: [{ at: 0, color: '#123456' }, { nope: 1 }] } }
  });
  const fixedDoc = quiet(() => createDoc(broken));
  const v = fixedDoc.nodes.v;
  assert.ok(v, 'узел остался');
  assert.equal(v.paths.length, 2);
  assert.deepEqual(v.paths[0], { d: 'M10 10L30 40', stroke: '#000' });
  assert.deepEqual(v.paths[1].fill, { gradient: { kind: 'linear', stops: [{ at: 0.5, color: '#ff0000', opacity: 1 }] } });
  assert.deepEqual(v.viewBox, { x: 0, y: 0, w: 30.5, h: 40.5 }, 'viewBox — по рамке оставшихся контуров (с половиной обводки)');
  assert.equal(v.rotate, undefined);
  assert.deepEqual(v.fill, { gradient: { kind: 'radial', stops: [{ at: 0, color: '#123456' }] } });
  assert.equal(checkImportDoc(clone(fixedDoc)), null, 'починенный документ импортируется');
  // контуров без рамки — 100×100; viewBox и paths у не-вектора — сняты
  const empty = quiet(() => createDoc(withNode({ viewBox: null, paths: [{ d: 'xx' }] })));
  assert.deepEqual(empty.nodes.v.viewBox, { w: 100, h: 100 });
  const rr = clone(base); rr.nodes.e.paths = [{ d: 'M0 0' }]; rr.nodes.e.viewBox = { w: 2, h: 2 };
  const fe = quiet(() => createDoc(rr)).nodes.e;
  assert.equal(fe.paths, undefined); assert.equal(fe.viewBox, undefined);
  assert.equal(fieldProblem({ type: 'rect', rotate: 3 }, 'rotate'), null);
});

/* ----------------------------- краски ----------------------------- */

test('круг37: resolvePaint / paintCss / resolveColor — цвет, градиенты, мёртвые стопы', () => {
  const doc = artDoc();
  assert.deepEqual(resolvePaint(doc, 'accent'), { type: 'color', color: resolveColor(doc, 'accent') });
  assert.equal(resolvePaint(doc, null), null);
  assert.equal(resolvePaint(doc, 'нет-такого'), null);
  const g = resolvePaint(doc, GRAD);
  assert.deepEqual(g, { type: 'gradient', kind: 'linear', angle: 90, cx: 0.5, cy: 0.5, r: 0.5,
    stops: [{ at: 0, color: '#ff0000', opacity: 1 }, { at: 1, color: resolveColor(doc, 'accent'), opacity: 0.5 }] });
  assert.equal(resolvePaint(doc, { gradient: { kind: 'linear', stops: [{ at: 0, token: 'мёртвый' }] } }), null, 'без живых стопов — краски нет');
  assert.equal(resolvePaint(doc, { gradient: { kind: 'linear', stops: [{ at: 0, color: '#abc' }] } }).angle, 180, 'умолчание угла — сверху вниз');
  assert.equal(paintCss(doc, GRAD), `linear-gradient(90deg, #ff0000 0%, ${cssRgba(resolveColor(doc, 'accent'), 0.5)} 100%)`);
  assert.equal(paintCss(doc, RADIAL), 'radial-gradient(circle at 30% 30%, #ffffff 0%, #000000 100%)');
  assert.equal(paintCss(doc, '#ABC'), '#aabbcc');
  assert.equal(resolveColor(doc, { gradient: { kind: 'linear', stops: [{ at: 0, color: '#111111' }, { at: 0.6, color: '#222222' }, { at: 1, color: '#333333' }] } }), '#222222',
    'градиент для контраста — стоп у середины');
});

function cssRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ----------------------------- решатель ----------------------------- */

test('круг37: решатель — vector как rect (hug = viewBox), свободная рамка по pos, поворот геометрию не меняет', () => {
  let doc = artDoc();
  let geo = solve(doc, M);
  assert.deepEqual(geo.rects.v, { x: 28, y: 38, w: 100, h: 50 }, 'hug = viewBox, pos от рамки (+ отступ доски spacing.4 = 8)');
  assert.deepEqual(geo.rects.t.x, geo.rects.art.x, 'ребёнок без pos — в (0,0) свободной рамки');
  assert.deepEqual(geo.rects.t.y, geo.rects.art.y);
  doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'size', value: { w: { mode: 'fixed', value: 30 }, h: { mode: 'hug' } } }]).doc;
  assert.deepEqual(solve(doc, M).rects.v, { x: 28, y: 38, w: 30, h: 50 });
  doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'size.w', value: { mode: 'fill' } }, { op: 'set', id: 'art', path: 'layout', value: { mode: 'row' } }]).doc;
  geo = solve(doc, M);
  assert.ok(geo.rects.v.w > 0 && geo.rects.v.w < 200, 'fill — остаток по главной оси');
  // свободная рамка по содержимому: max(pos + размер)
  doc = artDoc();
  doc = applyOps(doc, [{ op: 'set', id: 'art', path: 'size', value: { w: { mode: 'hug' }, h: { mode: 'hug' } } }]).doc;
  assert.deepEqual([solve(doc, M).rects.art.w, solve(doc, M).rects.art.h], [120, 80]);
  // поворот и контуры раскладку не меняют
  const g0 = hashGeometry(solve(doc, M));
  const turned = applyOps(doc, [{ op: 'set', id: 'v', path: 'rotate', value: 33 }, { op: 'set', id: 'art', path: 'rotate', value: -90 },
    { op: 'set', id: 'v', path: 'paths.0.d', value: 'M0 0L999 999' }]).doc;
  assert.equal(hashGeometry(solve(turned, M)), g0);
  // ребёнок с override в свободной рамке — по override
  const ov = applyOps(artDoc(), [{ op: 'set', id: 'e', path: 'override', value: { x: 5, y: 6 } }]).doc;
  const go = solve(ov, M);
  assert.deepEqual([go.rects.e.x - go.rects.art.x, go.rects.e.y - go.rects.art.y], [5, 6]);
  assert.ok(isFreeFrame(ov.nodes.art) && !isFreeFrame(ov.nodes.ab) && !isFreeFrame(ov.nodes.v));
});

test('круг37: экземпляр — мастер с вектором раскрывается, поворот экземпляра заменяет поворот мастера', () => {
  let doc = artDoc();
  doc = applyOps(doc, [{ op: 'set', id: 'art', path: 'rotate', value: 10 }]).doc;
  const mk = makeComponentOps(doc, 'art', { name: 'Капелька' });
  doc = applyOps(doc, mk).doc;
  const masterId = Object.values(doc.nodes).find((n) => n.component && n.component.name === 'Капелька').id;
  const inst = instanceOps(doc, { of: masterId, parent: 'ab' });
  doc = applyOps(doc, inst).doc;
  const iid = inst.find((o) => o.op === 'create' && o.node.type === 'instance').node.id;
  let ex = expandInstance(doc, iid);
  const vec = Object.values(ex.nodes).find((n) => n.type === 'vector');
  assert.ok(vec && vec.paths.length === 2, 'вектор мастера в раскрытии');
  assert.equal(ex.root.rotate, 10);
  doc = assertSound(doc, [{ op: 'set', id: iid, path: 'rotate', value: -20 }], 'поворот экземпляра');
  ex = expandInstance(doc, iid);
  assert.equal(ex.root.rotate, -20);
  const geo = solve(doc, M);
  assert.ok(geo.rects[iid] && geo.rects[vec.id], 'геометрия у раскрытого вектора');
});

/* ----------------------------- валидатор ----------------------------- */

test('круг37: валидатор §12.1 — bad-path, vector-empty, path-heavy, dead-color-ref; перекрытия фигур и кадрирование — не нарушения', () => {
  const codes = (doc) => validate(doc, solve(doc, M), M);
  const has = (list, code, id) => list.some((v) => v.code === code && (!id || v.nodeId === id));
  let doc = artDoc();
  let list = codes(doc);
  for (const c of ['bad-path', 'vector-empty', 'path-heavy', 'dead-color-ref', 'overlap', 'out-of-parent']) assert.ok(!has(list, c), `${c} нет: ${JSON.stringify(list)}`);
  // контуры невидимы / нет контуров
  doc = applyOps(artDoc(), [{ op: 'set', id: 'v', path: 'paths', value: [{ d: 'M0 0h5' }] }]).doc;
  assert.ok(has(codes(doc), 'vector-empty', 'v'));
  doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'fill', value: 'accent' }]).doc;
  assert.ok(!has(codes(doc), 'vector-empty', 'v'), 'заливка узла наследуется контуром');
  doc = applyOps(artDoc(), [{ op: 'set', id: 'v', path: 'paths', value: [] }]).doc;
  const ve = codes(doc).find((v) => v.code === 'vector-empty');
  assert.equal(ve.severity, 'warn');
  // path-heavy
  doc = applyOps(artDoc(), [{ op: 'set', id: 'v', path: 'paths', value: [{ d: 'M0 0' + 'L1 1'.repeat(4999), fill: '#000' }, { d: 'M0 0' + 'L1 1'.repeat(10), fill: '#000' }] }]).doc;
  const ph = codes(doc).find((v) => v.code === 'path-heavy');
  assert.ok(ph && ph.severity === 'info' && ph.nodeId === 'v', JSON.stringify(ph));
  // dead-color-ref — в контуре, стопе, заливке узла и состоянии; 'none' — не мёртвая
  doc = applyOps(artDoc(), [
    { op: 'set', id: 'v', path: 'paths.0.fill', value: { gradient: { kind: 'linear', stops: [{ at: 0, token: 'призрак' }, { at: 1, color: '#fff' }] } } },
    { op: 'set', id: 'v', path: 'paths.1.stroke', value: 'тень' },
    { op: 'set', id: 'e', path: 'fill', value: 'none' },
    { op: 'set', id: 't', path: 'color', value: 'нетцвета' }
  ]).doc;
  list = codes(doc);
  const dc = list.find((v) => v.code === 'dead-color-ref' && v.nodeId === 'v');
  assert.ok(dc && dc.severity === 'warn', JSON.stringify(list));
  assert.match(dc.message, /paths\.0\.fill\.gradient\.stops\.0 → «призрак»/);
  assert.match(dc.message, /paths\.1\.stroke → «тень»/);
  assert.ok(has(list, 'dead-color-ref', 't'));
  assert.ok(!has(list, 'dead-color-ref', 'e'));
  // bad-path — только по сырому документу (операции такого не пропускают)
  const raw = clone(artDoc());
  raw.nodes.v.paths[1].d = 'M0 0 L';
  const bp = validate(raw, solve(raw, M), M).find((v) => v.code === 'bad-path');
  assert.ok(bp && bp.severity === 'error' && /paths\.1\.d/.test(bp.message), JSON.stringify(bp));
  // фигуры в свободной рамке перекрываются молча, блоки интерфейса — как прежде
  doc = applyOps(artDoc(), [
    ops.create({ type: 'frame', id: 'f1', parent: 'art', children: [], pos: { x: 0, y: 0 }, size: fixed(50, 50) }),
    ops.create({ type: 'frame', id: 'f2', parent: 'art', children: [], pos: { x: 10, y: 10 }, size: fixed(50, 50) })
  ]).doc;
  list = codes(doc);
  assert.ok(has(list, 'overlap', 'f2'));
  assert.ok(!list.some((v) => v.code === 'overlap' && /Капля|Глаз/.test(v.message)), 'фигуры не в перекрытиях');
  // выход за край: в свободной рамке с обрезкой — кадрирование; без обрезки — out-of-parent
  doc = applyOps(artDoc(), [{ op: 'set', id: 'v', path: 'pos', value: { x: 150, y: 170 } }]).doc;
  assert.ok(!has(codes(doc), 'out-of-parent', 'v'));
  doc = applyOps(doc, [{ op: 'set', id: 'art', path: 'clip', value: false }]).doc;
  assert.ok(has(codes(doc), 'out-of-parent', 'v'));
});

/* ----------------------------- пример ----------------------------- */

test('круг37: sampleIllustration — персонаж из 10–20 контуров с градиентами и бликами; ложится, импортируется, без нарушений', () => {
  let doc = createDoc('empty');
  const list = sampleIllustration({ parent: doc.root, pos: { x: 100, y: 50 } });
  assert.equal(list[0].op, 'create');
  assert.equal(list[0].node.type, 'frame');
  assert.equal(list[0].node.layout.mode, 'none');
  assert.equal(list[0].node.clip, true);
  const vecs = list.slice(1).map((o) => o.node);
  assert.ok(vecs.every((n) => n.type === 'vector' && n.parent === list[0].node.id));
  const paths = vecs.reduce((s, n) => s + n.paths.length, 0);
  assert.ok(paths >= 10 && paths <= 20, `контуров ${paths}`);
  const json = JSON.stringify(list);
  assert.ok(/"radial"/.test(json) && /"linear"/.test(json), 'есть оба вида градиентов');
  assert.ok(vecs.some((n) => /Блик/.test(n.name)), 'есть блики');
  doc = assertSound(doc, list, 'пример ложится');
  const geo = solve(doc, M);
  assert.deepEqual(geo.rects[list[0].node.id], { x: 100, y: 50, w: 240, h: 240 });
  const bad = validate(doc, geo, M).filter((v) => v.severity !== 'info');
  assert.deepEqual(bad, [], 'без ошибок и предупреждений');
  // каждая деталь стоит по своей рамке: viewBox = рамка контуров, pos = её угол
  for (const n of vecs) {
    const b = pathBounds(n.paths);
    assert.ok(Math.abs(b.x - n.viewBox.x) < 0.02 && Math.abs(b.y - n.viewBox.y) < 0.02, n.name);
    assert.deepEqual(n.pos, { x: n.viewBox.x, y: n.viewBox.y }, n.name);
  }
  // id новые на каждый вызов; масштаб; вложение в обычную раскладку
  const again = sampleIllustration({ parent: doc.root });
  assert.notEqual(again[0].node.id, list[0].node.id);
  const card = ops.create({ type: 'frame', parent: doc.root, children: [], pos: { x: 500, y: 0 }, layout: { mode: 'column', padding: 'spacing.4' } });
  doc = applyOps(doc, [card]).doc;
  const small = sampleIllustration({ parent: card.node.id, scale: 0.5 });
  doc = assertSound(doc, small, 'пример в карточке');
  const g2 = solve(doc, M);
  assert.equal(g2.rects[small[0].node.id].w, 120);
  assert.deepEqual(vectorSummary(doc, doc.nodes[small[5].node.id]).paths, 1);
  assert.ok(vectorSummary(doc, doc.nodes[small[5].node.id]).gradients >= 1);
});

/* ----------------------------- фаззер ----------------------------- */

const D_GOOD = ['M0 0L10 10', 'M0 0h10v10H0z', 'm5 5c1 2 3 4 5 6s1 1 2 2', 'M0 0a5 5 0 1 1 10 0z', 'M1 1q2 2 3 3t4 4Z'];
const D_BAD = ['', 'L0 0', 'M0 0 L', 'M1e999 0', 'M0 0 a1 1 0 2 0 1 1', 'Z', 'M0,0,'];
const STOP_GOOD = [{ at: 0, color: '#ff0000' }, { at: 1, token: 'accent' }, { at: 0.5, color: '#00f', opacity: 0.3 }];
const G_GOOD = [GRAD, RADIAL, { gradient: { kind: 'linear', stops: [STOP_GOOD[2]] } }];
const G_BAD = [{ gradient: { kind: 'linear', stops: [] } }, { gradient: { kind: 'x', stops: [STOP_GOOD[0]] } }, { gradient: GRAD.gradient, token: 'a' },
  { gradient: { kind: 'radial', r: 3, stops: [STOP_GOOD[0]] } }, { gradient: { kind: 'linear', stops: [{ at: 0, color: '#fff', token: 'x' }] } }];
const PATHS = ['paths', 'paths.0', 'paths.1', 'paths.2', 'paths.0.d', 'paths.1.d', 'paths.0.fill', 'paths.0.stroke', 'paths.0.strokeWidth', 'paths.0.opacity',
  'paths.0.fillRule', 'paths.0.lineCap', 'paths.0.lineJoin', 'paths.0.name', 'paths.0.junk', 'paths.0.fill.gradient.stops.0.at', 'paths.0.fill.gradient.angle',
  'paths.x', 'viewBox', 'viewBox.w', 'viewBox.h', 'viewBox.x', 'viewBox.z', 'rotate', 'fill', 'fill.gradient', 'fill.gradient.kind', 'fill.gradient.stops',
  'fill.gradient.stops.0', 'fill.gradient.stops.1.token', 'stroke', 'stroke.color', 'color', 'pos', 'pos.x', 'layout.mode', 'clip', 'states.hover.fill', 'opacity'];
const VALUES = [undefined, null, 0, 1, -1, 0.5, 2, 45, -360, 361, 64, 65, 1e6, '', 'x', 'accent', '#ff0000', 'evenodd', 'round', 'none', 'linear', 'radial',
  true, [], {}, ...D_GOOD, ...D_BAD, ...G_GOOD, ...G_BAD, ...STOP_GOOD, { d: D_GOOD[0], fill: GRAD }, { d: D_BAD[1] }, { d: D_GOOD[1], foo: 1 },
  [{ d: D_GOOD[2], stroke: 'accent', strokeWidth: 3 }], [{ d: D_BAD[0] }], { w: 10, h: 10 }, { x: 1, y: 1, w: 5, h: 5 }, { w: 0, h: 1 }, { x: 3, y: 4 },
  { mode: 'none' }, { color: GRAD, width: 2 }, { toString: 1 }];
const GOOD = {
  paths: [[], [{ d: D_GOOD[0], fill: GRAD }], [{ d: D_GOOD[3], fill: 'accent' }, { d: D_GOOD[4], stroke: '#000', strokeWidth: 2 }]],
  'paths.0': [{ d: D_GOOD[1], fill: RADIAL, opacity: 0.5 }, { d: D_GOOD[2] }],
  'paths.1': [{ d: D_GOOD[0], stroke: 'line' }],
  'paths.0.d': D_GOOD, 'paths.1.d': D_GOOD,
  'paths.0.fill': [undefined, null, 'accent', ...G_GOOD],
  'paths.0.stroke': [undefined, '#123456', GRAD],
  'paths.0.strokeWidth': [undefined, 0, 2.5, 64], 'paths.0.opacity': [undefined, 0, 0.4],
  'paths.0.fillRule': [undefined, 'evenodd', 'nonzero'], 'paths.0.lineCap': ['round', 'square'], 'paths.0.lineJoin': ['bevel', 'miter'],
  'paths.0.name': ['Контур', undefined], 'paths.0.fill.gradient.stops.0.at': [0, 0.3, 1], 'paths.0.fill.gradient.angle': [0, 270],
  viewBox: [{ w: 10, h: 10 }, { x: -5, y: 5, w: 100, h: 3 }], 'viewBox.w': [1, 50, 0.5], 'viewBox.h': [2, 200], 'viewBox.x': [undefined, -3, 7],
  rotate: [undefined, 0, 45, -360, 359.5], fill: [undefined, null, 'accent', ...G_GOOD], 'fill.gradient.kind': ['linear', 'radial'],
  'fill.gradient.stops': [[STOP_GOOD[0]], STOP_GOOD], 'fill.gradient.stops.0': STOP_GOOD, 'fill.gradient.stops.1.token': ['accent', 'surface'],
  stroke: [undefined, { color: GRAD, width: 2 }, 'line'], 'stroke.color': [RADIAL, 'accent'], color: [undefined, 'accent', GRAD],
  pos: [{ x: 3, y: 4 }], 'pos.x': [0, 15], 'layout.mode': ['none', 'row'], clip: [true, false], 'states.hover.fill': ['accent', undefined], opacity: [undefined, 0.5]
};

test('круг37: фаззер новых путей и типа — принято → импортируется, переживает JSON, отмена и повтор точные; поворот геометрию не меняет', () => {
  const stats = { set: 0, create: 0, rejected: 0, vectorSet: 0 };
  for (const seed of [37, 3737, 1037]) {
    const { rnd, pick } = rng(seed);
    let doc = artDoc();
    doc = applyOps(doc, sampleIllustration({ parent: doc.root, pos: { x: 500, y: 0 } })).doc;
    const ids = () => Object.keys(doc.nodes);
    const vectors = () => ids().filter((id) => doc.nodes[id].type === 'vector');
    for (let i = 0; i < 700; i++) {
      const list = [];
      for (let k = 1 + Math.floor(rnd() * 2); k > 0; k--) {
        const roll = rnd();
        let op;
        if (roll < 0.8) {
          const vs = vectors();
          op = { op: 'set', id: rnd() < 0.75 && vs.length ? pick(vs) : pick(ids()), path: pick(PATHS) };
          if (rnd() < 0.15) op.exact = true;
          const v = rnd() < 0.65 && GOOD[op.path] ? pick(GOOD[op.path]) : pick(VALUES);
          if (v !== undefined) op.value = v;
        } else {
          const frames = ids().filter((id) => doc.nodes[id].type === 'frame');
          const good = rnd() < 0.6;
          op = { op: 'create', node: { type: rnd() < 0.8 ? 'vector' : pick(['rect', 'ellipse', 'text']), id: 'z' + seed + '_' + i + '_' + k, parent: pick(frames), characters: 'Т',
            viewBox: good ? pick(GOOD.viewBox) : pick(VALUES), paths: good ? pick(GOOD.paths) : pick(VALUES), fill: good ? pick(GOOD.fill) : pick(VALUES),
            rotate: good ? pick(GOOD.rotate) : pick(VALUES), pos: { x: Math.round(rnd() * 100), y: Math.round(rnd() * 100) } } };
          for (const f of ['viewBox', 'paths', 'fill', 'rotate']) if (op.node[f] === undefined) delete op.node[f];
          if (op.node.type !== 'text') delete op.node.characters;
        }
        list.push(op);
      }
      const prev = doc;
      const r = quiet(() => applyOps(prev, clone(list)));
      if (r.error) { stats.rejected++; continue; }
      for (const op of list) { stats[op.op]++; if (op.op === 'set' && prev.nodes[op.id] && prev.nodes[op.id].type === 'vector') stats.vectorSet++; }
      const what = `сид ${seed}, шаг ${i}: ${JSON.stringify(list).slice(0, 400)}`;
      assert.equal(checkImportDoc(clone(r.doc)), null, `${what}\nпринятое не импортируется: ${JSON.stringify(checkImportDoc(clone(r.doc)))}`);
      assert.equal(hashDoc(clone(r.doc)), hashDoc(r.doc), `${what}\nне переживает JSON`);
      const inv = clone(invertOps(prev, clone(list)));
      const back = quiet(() => applyOps(r.doc, inv));
      assert.equal(back.error, undefined, `${what}\nотмена не ложится: ${back.error && back.error.message}`);
      assert.equal(hashDoc(back.doc), hashDoc(prev), `${what}\nотмена не точная`);
      const redo = clone(invertOps(r.doc, clone(inv)));
      const again = quiet(() => applyOps(back.doc, redo));
      assert.equal(again.error, undefined, `${what}\nповтор не ложится`);
      assert.equal(hashDoc(again.doc), hashDoc(r.doc), `${what}\nповтор не точный`);
      if (i % 50 === 0) {
        const geo = solve(r.doc, M);
        validate(r.doc, geo, M);
        // поворот — визуальное поле: без него геометрия та же
        const flat = clone(r.doc);
        for (const n of Object.values(flat.nodes)) delete n.rotate;
        assert.equal(hashGeometry(solve(flat, M)), hashGeometry(geo), `${what}\nповорот изменил геометрию`);
        for (const n of Object.values(r.doc.nodes)) { resolvePaint(r.doc, n.fill); vectorSummary(r.doc, n); }
      }
      doc = r.doc;
    }
  }
  for (const [k, v] of Object.entries(stats)) assert.ok(v > 40, `покрыто ${k}: ${JSON.stringify(stats)}`);
});

/* ----------------------------- сцена и экспорт ----------------------------- */

/** Мини-DOM: атрибуты, дети, style, вставка/замена — для полной сборки и точечного обновления. */
function withDom(fn) {
  const had = globalThis.document;
  const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const esc = (s) => escText(s).replace(/"/g, '&quot;');
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  const mk = (name) => {
    const el = {
      nodeName: name, attrs: new Map(), children: [], text: '', style: {}, parentNode: null,
      setAttribute(k, v) { this.attrs.set(k, String(v)); },
      setAttributeNS(_ns, k, v) { this.attrs.set(k, String(v)); },
      getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
      removeAttribute(k) { this.attrs.delete(k); },
      appendChild(c) {
        if (c.nodeName === '#frag') { for (const x of c.children.slice()) this.appendChild(x); c.children = []; return c; }
        if (c.parentNode) c.parentNode.removeChild(c);
        this.children.push(c); c.parentNode = this; return c;
      },
      insertBefore(c, ref) {
        if (c.parentNode) c.parentNode.removeChild(c);
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        c.parentNode = this; return c;
      },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      replaceChild(n, o) { if (n.parentNode) n.parentNode.removeChild(n); const i = this.children.indexOf(o); this.children[i] = n; n.parentNode = this; o.parentNode = null; return o; },
      get firstChild() { return this.children[0] || null; },
      get outerHTML() {
        if (this.nodeName === '#text') return escText(this.text);
        if (this.nodeName === '#frag') return this.children.map((c) => c.outerHTML).join('');
        const st = Object.entries(this.style).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => `${kebab(k)}: ${v}`).join('; ');
        const attrs = [...this.attrs];
        if (st) attrs.push(['style', st]);
        return `<${this.nodeName}${attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${this.children.map((c) => c.outerHTML).join('')}</${this.nodeName}>`;
      }
    };
    return el;
  };
  globalThis.document = { createElementNS: (_ns, name) => mk(name), createElement: (name) => mk(name), createTextNode: (t) => { const n = mk('#text'); n.text = t; return n; },
    createDocumentFragment: () => mk('#frag') };
  try { return fn(mk); } finally { globalThis.document = had; }
}

function bareStage(doc) {
  const st = Object.create(Stage.prototype);
  st.el = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    classList: { toggle() {}, remove() {}, add() {}, contains: () => false } };
  st.doc = doc;
  st.geo = solve(doc, M);
  st.view = { zoom: 1, pan: { x: 0, y: 0 } };
  st.errors = [];
  st.opts = { onError: (i) => st.errors.push(i.where + ': ' + (i.error && i.error.message)) };
  st._paintUI = () => {};
  st._timers = new Set();
  st._previewOn = false;
  st._ix = { hover: new Set(), press: new Set(), focus: null };
  st._forced = new Map();
  st._forcedTimers = new Map();
  st._stList = null;
  st._exportStates = null;
  st._clipPrefix = 'imago-clip-test1-';
  st._clipSeq = 0;
  st.state = { selection: [] };
  return st;
}

function drawn(doc) {
  const st = bareStage(doc);
  st.svg = document.createElementNS('', 'svg');
  st._renderGrid = () => {};
  st.activeArtboard = 'ab';
  st._renderSVG();
  return st;
}

const find = (el, pred, out = []) => { if (pred(el)) out.push(el); for (const c of el.children || []) find(c, pred, out); return out; };

test('круг37: toSVG — контуры с масштабом viewBox → рамка (meet), градиенты в <defs> с уникальными id, поворот вокруг центра, обрезка свободной рамки', () => {
  withDom(() => {
    let doc = artDoc();
    doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'size', value: fixed(100, 100) }, { op: 'set', id: 'v', path: 'rotate', value: 30 },
      { op: 'set', id: 'v', path: 'fill', value: 'accent' }, { op: 'set', id: 'v', path: 'stroke', value: { color: '#000000', width: 1.5 } }]).doc;
    const st = bareStage(doc);
    const svg = st.toSVG('ab', undefined, undefined, { fonts: false });
    assert.deepEqual(st.errors, []);
    // контуры как есть
    assert.ok(svg.includes('d="M0 50C0 0 100 0 100 50Z"'), 'путь 0');
    assert.ok(svg.includes('d="M10 40h80"'), 'путь 1');
    // вектор 100×50 в рамке 100×100: масштаб 1, по центру по вертикали (+25); рамка — (28, 38)
    assert.match(svg, /<g transform="matrix\(1 0 0 1 28 63\)" fill="#[0-9a-f]{6}" stroke="#000000" stroke-width="1.5" class="imago-shape">/);
    // градиенты: линейный 90° — слева направо, радиальный — доли
    const lg = /<linearGradient id="(imago-paint-[^"]+)" x1="0" y1="0.5" x2="1" y2="0.5"><stop offset="0" stop-color="#ff0000"><\/stop><stop offset="1" stop-color="#[0-9a-f]{6}" stop-opacity="0.5"><\/stop><\/linearGradient>/.exec(svg);
    assert.ok(lg, 'linearGradient:\n' + svg.slice(0, 3000));
    assert.ok(svg.includes(`fill="url(#${lg[1]})"`), 'контур ссылается на градиент');
    const rg = /<radialGradient id="(imago-paint-[^"]+)" cx="0.3" cy="0.3" r="0.7">/.exec(svg);
    assert.ok(rg && svg.includes(`fill="url(#${rg[1]})"`), 'эллипс с радиальным градиентом');
    assert.ok(/<defs><linearGradient/.test(svg), 'градиенты — в <defs>');
    // поворот — обёртка вокруг группы узла, центр — середина рамки
    assert.match(svg, /<g class="imago-rot" transform="rotate\(30 78 88\)"><g class="imago-node" data-id="v">/);
    // обрезка свободной рамки
    assert.match(svg, /<clipPath id="[^"]+"><rect x="8" y="8" width="200" height="200"/);
    // вторая сборка — свои id
    const again = st.toSVG('ab', undefined, undefined, { fonts: false });
    const ids1 = [...svg.matchAll(/id="(imago-paint-[^"]+)"/g)].map((m) => m[1]);
    const ids2 = [...again.matchAll(/id="(imago-paint-[^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids1).size, ids1.length, 'id уникальны внутри сборки');
    assert.ok(ids2.every((id) => !ids1.includes(id)), 'и между сборками');
  });
});

test('круг37: сцена — векторы рисуются; точечное обновление меняет краску и поворот без пересборки чужих веток; сдвиг детали пишет pos', () => {
  withDom(() => {
    let doc = artDoc();
    const st = drawn(doc);
    assert.deepEqual(st.errors, []);
    const vg = st._nodeEls.get('v');
    assert.ok(vg, 'вектор нарисован');
    assert.equal(find(vg, (e) => e.nodeName === 'path').length, 2);
    assert.equal(find(vg, (e) => e.nodeName === 'linearGradient').length, 1);
    const eg = st._nodeEls.get('e');
    // краска контура: фигуры вектора заменены, эллипс тот же элемент
    doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'paths.0.fill', value: '#00ff00' }]).doc;
    st.doc = doc; st.geo = solve(doc, M); st._renderSVG();
    assert.equal(st._nodeEls.get('e'), eg, 'соседа не трогали');
    assert.equal(st._nodeEls.get('v'), vg, 'группа та же — сменились фигуры');
    assert.equal(find(vg, (e) => e.nodeName === 'linearGradient').length, 0, 'старый градиент ушёл вместе с фигурами');
    assert.ok(find(vg, (e) => e.nodeName === 'path' && e.getAttribute('fill') === '#00ff00').length === 1);
    // поворот: появилась обёртка — ветку пересобрали; угол сменился — обёртка та же, атрибут новый
    doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'rotate', value: 15 }]).doc;
    st.doc = doc; st.geo = solve(doc, M); st._renderSVG();
    const c1 = st._drawn.get('v');
    assert.equal(c1.outer.getAttribute('class'), 'imago-rot');
    assert.equal(c1.outer.getAttribute('transform'), 'rotate(15 78 63)');
    assert.equal(c1.outer.parentNode && c1.outer.children[0], c1.el);
    doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'rotate', value: -40 }, { op: 'set', id: 'v', path: 'pos', value: { x: 0, y: 0 } }]).doc;
    st.doc = doc; st.geo = solve(doc, M); st._renderSVG();
    const c2 = st._drawn.get('v');
    assert.equal(c2.outer, c1.outer);
    assert.equal(c2.outer.getAttribute('transform'), 'rotate(-40 58 33)');
    doc = applyOps(doc, [{ op: 'set', id: 'v', path: 'rotate' }]).doc;
    st.doc = doc; st.geo = solve(doc, M); st._renderSVG();
    const c3 = st._drawn.get('v');
    assert.equal(c3.outer, c3.el, 'поворот снят — обёртки нет');
    assert.equal(find(st.svg, (e) => e.getAttribute && e.getAttribute('class') === 'imago-rot').length, 0);
    assert.deepEqual(st.errors, []);
    // перетаскивание детали свободной рамки — pos; стрелки — тоже pos; отсоединённая — override
    const commits = [];
    st._commit = (list, label) => commits.push({ list, label });
    const r0 = { ...st.geo.rects.v };
    st._drag = { mode: 'move', id: 'v', start: { x: r0.x + 5, y: r0.y + 5 }, rect0: r0 };
    st._snap = (t) => ({ x: t.x, y: t.y, guides: [] });
    st._ghost = () => {};
    st._updateMove(st._drag, { x: r0.x + 25, y: r0.y + 15 }, {});
    st._commitMove(st._drag);
    assert.deepEqual(commits.pop().list, [ops.set('v', 'pos', { x: 20, y: 10 })]);
    assert.deepEqual(st._nudgeOps('v', 1, 0), [ops.set('v', 'pos', { x: 1, y: 0 })]);
    doc = applyOps(doc, [{ op: 'set', id: 'e', path: 'override', value: { x: 5, y: 5 } }]).doc;
    st.doc = doc; st.geo = solve(doc, M);
    const re = { ...st.geo.rects.e };
    st._drag = { mode: 'move', id: 'e', start: { x: re.x, y: re.y }, rect0: re };
    st._updateMove(st._drag, { x: re.x + 10, y: re.y }, {});
    assert.equal(st._drag.result.kind, 'override', 'отсоединённый в свободной рамке — через override');
    // сдвиг внутри повёрнутых обёрток — в их координатах
    doc = applyOps(doc, [{ op: 'set', id: 'art', path: 'rotate', value: 90 }]).doc;
    st.doc = doc; st.geo = solve(doc, M);
    assert.deepEqual(st._localDelta('v', 10, 0), { x: 0, y: -10 });
    assert.deepEqual(st._localDelta('ab', 10, 0), { x: 10, y: 0 });
  });
});

test('круг37: хит-тест вектора — без DOM по рамке; поворот доски не рисуется', () => {
  withDom(() => {
    let doc = artDoc();
    const st = drawn(doc);
    const r = st.geo.rects.v;
    const hit = st._topUnder({ x: r.x + 1, y: r.y + 1 });
    assert.equal(hit && hit.id, 'v', 'без isPointInFill — по рамке, как раньше');
    doc = applyOps(doc, [{ op: 'set', id: 'ab', path: 'rotate', value: 45 }]).doc;
    const st2 = drawn(doc);
    assert.equal(st2._drawn.get('ab').rotDeg, 0, 'доску на холсте не поворачиваем');
    assert.deepEqual(st2.errors, []);
  });
});
