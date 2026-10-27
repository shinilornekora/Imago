/**
 * Круг 54 (SPEC §18.5): раскладка по месту правки и для документов с экземплярами компонентов.
 * Главное свойство то же, что в круге 51: результат solveAfter побитно равен полному solve(nextDoc).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, solve, solveAfter, solveCarry, hashGeometry, artboards, libraryNode, expandDoc } = core;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const measureText = (text, style) => String(text || '').length * (style.fontSize || 16) * 0.52;
const OPTS = { measureText };
const KEPT = { ...OPTS, incremental: true };
// эталон — полная раскладка без образцов экземпляров: и по месту правки, и образцы сверяются с ней
const PLAIN = { ...OPTS, shapes: false };
const hug = { w: { mode: 'hug' }, h: { mode: 'hug' } };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WORDS = ['Коротко', 'Заголовок карточки', 'Длинная подпись, которая переносится в узкой карточке на несколько строк', ''];

/**
 * Библиотека: «Значок» B (строка с текстом, пропс «текст») и «Карточка» M (колонка: заголовок с пропсом,
 * прямоугольник, вложенный экземпляр значка). Доска: сетка G из экземпляров M и обычные слои рядом.
 */
function instanceDoc(count) {
  const d = quiet(() => createDoc());
  const board = artboards(d)[0].id;
  const lib = libraryNode(d).id;
  const list = [
    { op: 'create', node: { type: 'frame', id: 'B', parent: lib, name: 'Значок', children: [], layout: { mode: 'row', gap: 2, padding: { t: 2, r: 4, b: 2, l: 4 } }, size: hug } },
    { op: 'create', node: { type: 'text', id: 'bt', parent: 'B', characters: 'Новое', size: hug } },
    { op: 'set', id: 'B', path: 'component', value: { name: 'Значок', props: [{ name: 'текст', kind: 'text', target: 'bt', path: 'characters' }] } },
    { op: 'create', node: { type: 'frame', id: 'M', parent: lib, name: 'Карточка', children: [], layout: { mode: 'column', gap: 4 }, size: { w: { mode: 'fixed', value: 180 }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'text', id: 'mt', parent: 'M', characters: 'Заголовок', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'rect', id: 'mr', parent: 'M', size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 6 } } } },
    { op: 'create', node: { type: 'instance', id: 'mb', parent: 'M', of: 'B' } },
    { op: 'set', id: 'M', path: 'component', value: { name: 'Карточка', props: [
      { name: 'заголовок', kind: 'text', target: 'mt', path: 'characters' },
      { name: 'полоса', kind: 'bool', target: 'mr', path: 'visible' },
    ] } },
    { op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', wrap: true, gap: 8 }, size: { w: { mode: 'fixed', value: 1200 }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'text', id: 'note', parent: board, characters: 'Подпись доски', size: hug } },
  ];
  for (let i = 0; i < count; i++) list.push({ op: 'create', node: { type: 'instance', id: 'I' + i, parent: 'G', of: 'M' } });
  const res = applyOps(d, list, { checkExpand: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  return res.doc;
}

function randomOp(r, doc, step) {
  const insts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'instance' && doc.nodes[id].parent === 'G');
  const inst = () => insts[Math.floor(r() * insts.length)];
  const word = () => WORDS[Math.floor(r() * WORDS.length)] + step;
  const k = r();
  if (k < 0.15) return [{ op: 'set', id: 'mt', path: 'characters', value: word() }];               // мастер — все экземпляры
  if (k < 0.22) return [{ op: 'set', id: 'bt', path: 'characters', value: word() }];               // вложенный мастер
  if (k < 0.27) return [{ op: 'set', id: 'M', path: 'layout', value: { mode: 'column', gap: Math.floor(r() * 12) } }];
  if (k < 0.45 && insts.length) return [{ op: 'set', id: inst(), path: 'props', value: { заголовок: word(), полоса: r() < 0.5 } }];
  if (k < 0.52 && insts.length) return [{ op: 'set', id: inst(), path: 'size', value: { w: { mode: 'fixed', value: 120 + Math.floor(r() * 120) }, h: { mode: 'hug' } } }];
  if (k < 0.58 && insts.length) return [{ op: 'set', id: inst(), path: 'visible', value: r() < 0.5 }];
  if (k < 0.66) return [{ op: 'create', node: { type: 'instance', id: 'x' + step, parent: 'G', of: 'M' } }];
  if (k < 0.72 && insts.length > 1) return [{ op: 'remove', id: inst() }];
  if (k < 0.78 && insts.length > 1) return [{ op: 'move', id: inst(), parent: 'G', index: Math.floor(r() * insts.length) }];
  // круг 61: настоящие узлы среди экземпляров — быстрый путь (раскрытие то же)
  const reals = Object.keys(doc.nodes).filter((id) => /^r\d/.test(id));
  if (k < 0.82) return [{ op: 'create', node: { type: 'text', id: 'r' + step, parent: 'G', characters: word() } }];
  if (k < 0.85 && reals.length) return [{ op: 'remove', id: reals[Math.floor(r() * reals.length)] }];
  if (k < 0.88 && reals.length) return [{ op: 'move', id: reals[0], parent: 'G', index: Math.floor(r() * 5) }];
  if (k < 0.92) return [{ op: 'set', id: 'note', path: 'characters', value: word() }];               // вне экземпляров
  return [{ op: 'set', id: 'G', path: 'size', value: { w: { mode: 'fixed', value: 800 + Math.floor(r() * 800) }, h: { mode: 'hug' } } }];
}

test('круг54: экземпляры — по месту правки та же геометрия, что у полной раскладки (случайные правки)', () => {
  let reused = 0;
  let steps = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed);
    let doc = instanceDoc(12 + Math.floor(r() * 20));
    let geo = solve(doc, KEPT);
    for (let step = 0; step < 40; step++) {
      const op = randomOp(r, doc, step);
      const res = applyOps(doc, op, { checkExpand: false });
      if (res.error) continue;
      const next = res.doc;
      const inc = solveAfter(geo, doc, next, op, OPTS);
      const full = solve(next, PLAIN);
      assert.equal(hashGeometry(solve(next, OPTS)), hashGeometry(full), `образцы, зерно ${seed}, шаг ${step}`);
      assert.equal(hashGeometry(inc), hashGeometry(full), `зерно ${seed}, шаг ${step}: ${JSON.stringify(op).slice(0, 200)}`);
      assert.deepEqual(inc.order, full.order);
      assert.deepEqual(Object.keys(inc.expanded).sort(), Object.keys(full.expanded).sort());
      steps++;
      if (Object.keys(inc.rects).some((id) => inc.rects[id] === geo.rects[id])) reused++;
      doc = next;
      geo = inc;
    }
  }
  assert.ok(reused > steps / 2, `по месту правки — ${reused} из ${steps} шагов`);
});

test('круг54: правка вне экземпляров не трогает их раскрытие; правка пропса — только свой экземпляр', () => {
  const doc = instanceDoc(30);
  const geo = solve(doc, KEPT);
  const op = [{ op: 'set', id: 'note', path: 'characters', value: 'Другая подпись' }];
  const next = applyOps(doc, op).doc;
  const inc = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)));
  // раскрытый узел экземпляра — тот же прямоугольник: поддерево перенесено, а не разложено заново
  assert.equal(inc.rects['I7/mt'], geo.rects['I7/mt']);
  assert.equal(inc.rects['I7/mb/bt'], geo.rects['I7/mb/bt']);

  const op2 = [{ op: 'set', id: 'I3', path: 'props', value: { заголовок: 'Длинная подпись, которая переносится в узкой карточке на несколько строк' } }];
  const next2 = applyOps(next, op2).doc;
  const inc2 = solveAfter(inc, next, next2, op2, OPTS);
  assert.equal(hashGeometry(inc2), hashGeometry(solve(next2, PLAIN)));
  assert.notEqual(inc2.lines['I3/mt'], inc.lines['I3/mt']);
  // экземпляр до правленого (в той же строке сетки, не сдвинутый) — тем же объектом
  assert.equal(inc2.rects['I0/mt'], inc.rects['I0/mt']);
});

test('круг54: вложенные экземпляры и правка вложенного мастера', () => {
  const doc = instanceDoc(8);
  let geo = solve(doc, KEPT);
  const op = [{ op: 'set', id: 'bt', path: 'characters', value: 'Значок длиннее прежнего' }];
  const next = applyOps(doc, op).doc;
  geo = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(geo), hashGeometry(solve(next, PLAIN)));
  assert.equal(geo.lines['I5/mb/bt'].join(' '), 'Значок длиннее прежнего');
});

test('круг54: одинаковые экземпляры раскладываются один раз, остальные — копией образца', () => {
  const doc = instanceDoc(2100);   // 5 раскрытых узлов на экземпляр
  assert.ok(Object.keys(expandDoc(doc).nodes).length > 10000);
  const before = core.solveShapeCopies();
  const geo = solve(doc, KEPT);
  // в сетке 2100 одинаковых экземпляров одного размера: разложен первый, остальные скопированы
  assert.ok(core.solveShapeCopies() - before >= 2099, `копий ${core.solveShapeCopies() - before}`);
  // разные пропсы — разные формы: копий нет, геометрия та же, что у раскладки без образцов
  const plain = applyOps(doc, Array.from({ length: 2100 }, (_, i) => ({ op: 'set', id: 'I' + i, path: 'props', value: { заголовок: 'Т' + (i % 3) } }))).doc;
  const mid = core.solveShapeCopies();
  const g2 = solve(plain, OPTS);
  assert.ok(core.solveShapeCopies() - mid >= 2097, 'три формы — три образца');
  assert.equal(g2.lines['I4/mt'].join(' '), 'Т1');
  assert.equal(hashGeometry(g2), hashGeometry(solve(plain, PLAIN)));
  assert.equal(hashGeometry(geo), hashGeometry(solve(doc, PLAIN)));
  // правка вне экземпляров по месту: экземпляр далеко от правки — тот же объект прямоугольника
  const op = [{ op: 'set', id: 'note', path: 'characters', value: 'Подпись 2' }];
  const next = applyOps(doc, op).doc;
  const after = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(after.rects['I1100/mt'], geo.rects['I1100/mt']);
  assert.equal(hashGeometry(after), hashGeometry(solve(next, PLAIN)));
});

test('круг54: образцы не переходят между досками с разной темой; отсоединённый экземпляр', () => {
  const doc = instanceDoc(6);
  const lib = libraryNode(doc).id;
  const root = doc.root;
  const list = [
    { op: 'create', node: { type: 'frame', id: 'T', parent: root, name: 'Тёмная', pos: { x: 3000, y: 0 }, children: [],
      layout: { mode: 'row', wrap: true, gap: 8 }, size: { w: { mode: 'fixed', value: 1200 }, h: { mode: 'hug' } } } },
    { op: 'set', id: 'T', path: 'theme', value: { type: { body: { fontWeight: 700 } } } },
  ];
  for (let i = 0; i < 6; i++) list.push({ op: 'create', node: { type: 'instance', id: 'K' + i, parent: 'T', of: 'M' } });
  list.push({ op: 'create', node: { type: 'instance', id: 'D', parent: 'G', of: 'M', override: { x: 40, y: 500, w: 260 } } });
  const res = applyOps(doc, list, { checkExpand: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(lib);
  // измеритель видит насыщенность: тема доски меняет ширину текстов
  const heavy = (text, style) => String(text || '').length * (style.fontSize || 16) * (style.fontWeight >= 600 ? 0.6 : 0.52);
  const geo = solve(res.doc, { measureText: heavy });
  assert.equal(hashGeometry(geo), hashGeometry(solve(res.doc, { measureText: heavy, shapes: false })));
  assert.notEqual(geo.rects['K0/mb/bt'].w, geo.rects['I0/mb/bt'].w);
  assert.equal(geo.rects.D.w, 260);
});

/** Критик круга 54: две доски и библиотека; мастера по заданному списку операций. */
function libDoc(build) {
  const d = quiet(() => createDoc());
  const res = quiet(() => applyOps(d, build(artboards(d)[0].id, libraryNode(d).id), { checkExpand: false }));
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  return res.doc;
}
const fx = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });

test('круг54: id со «/» — экземпляр «a/x» перетирает раскрытого потомка «a/x»: такой экземпляр не образец', () => {
  for (const order of ['a/x между', 'a/x после']) {
    const doc = libDoc((board, lib) => {
      const list = [
        { op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'row' }, size: hug } },
        { op: 'create', node: { type: 'rect', id: 'x', parent: 'M', size: fx(10, 10) } },
        { op: 'set', id: 'M', path: 'component', value: { name: 'M' } },
        { op: 'create', node: { type: 'frame', id: 'K', parent: lib, children: [], layout: { mode: 'row' }, size: hug } },
        { op: 'create', node: { type: 'rect', id: 'y', parent: 'K', size: fx(50, 50) } },
        { op: 'set', id: 'K', path: 'component', value: { name: 'K' } },
        { op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', gap: 5 }, size: hug } },
        { op: 'create', node: { type: 'instance', id: 'a', parent: 'G', of: 'M' } },
      ];
      const ax = { op: 'create', node: { type: 'instance', id: 'a/x', parent: 'G', of: 'K' } };
      const c = { op: 'create', node: { type: 'instance', id: 'c', parent: 'G', of: 'M' } };
      return list.concat(order === 'a/x между' ? [ax, c] : [c, ax]);
    });
    const geo = solve(doc, KEPT);
    const plain = solve(doc, PLAIN);
    assert.equal(hashGeometry(geo), hashGeometry(plain), order);
    assert.deepEqual(geo.rects.c, plain.rects.c);
    assert.equal(geo.rects['c/x/y'], undefined, `${order}: узел-призрак`);
    const op = [{ op: 'set', id: 'G', path: 'layout', value: { mode: 'row', gap: 9 } }];
    const next = applyOps(doc, op, { checkExpand: false }).doc;
    assert.equal(hashGeometry(solveAfter(geo, doc, next, op, OPTS)), hashGeometry(solve(next, PLAIN)), order);
  }
});

test('круг54: образец не переносится туда, где поддерево упрётся в предел глубины', () => {
  for (const depth of [236, 245]) {
    const doc = libDoc((board, lib) => {
      const L = [{ op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'row', padding: 1 }, size: hug } }];
      let p = 'M';
      for (let i = 0; i < 20; i++) { L.push({ op: 'create', node: { type: 'frame', id: 'm' + i, parent: p, children: [], layout: { mode: 'row', padding: 1 }, size: hug } }); p = 'm' + i; }
      L.push({ op: 'create', node: { type: 'rect', id: 'leaf', parent: p, size: fx(10, 10) } },
        { op: 'set', id: 'M', path: 'component', value: { name: 'M' } },
        { op: 'create', node: { type: 'frame', id: 'sh', parent: board, children: [], layout: { mode: 'row' }, size: { w: { mode: 'fixed', value: 350 }, h: { mode: 'hug' } } } },
        { op: 'create', node: { type: 'instance', id: 'A', parent: 'sh', of: 'M' } });
      p = board;
      for (let i = 0; i < depth; i++) {
        L.push({ op: 'create', node: { type: 'frame', id: 'f' + i, parent: p, children: [], layout: { mode: 'row' },
          size: i === depth - 1 ? { w: { mode: 'fixed', value: 350 }, h: { mode: 'hug' } } : hug } });
        p = 'f' + i;
      }
      L.push({ op: 'create', node: { type: 'instance', id: 'B', parent: p, of: 'M' } });
      return L;
    });
    const geo = quiet(() => solve(doc, OPTS));
    const plain = quiet(() => solve(doc, PLAIN));
    assert.equal(hashGeometry(geo), hashGeometry(plain), `глубина ${depth}`);
    assert.deepEqual(geo.rects.B, plain.rects.B);
  }
});

test('круг54: копия образца несёт отрезки — после правки соседа она переносится тем же объектом', () => {
  const doc = instanceDoc(30);
  const geo = solve(doc, KEPT);
  const op = [{ op: 'set', id: 'I3', path: 'props', value: { заголовок: 'Длинная подпись, которая переносится в узкой карточке на несколько строк' } }];
  const next = applyOps(doc, op).doc;
  const inc = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)));
  // I1 разложен копией образца I0; в той же строке, до правленого — без сдвига
  assert.equal(inc.rects['I1/mt'], geo.rects['I1/mt']);
  assert.equal(inc.rects['I1/mb/bt'], geo.rects['I1/mb/bt']);
});

test('круг54: заглушка сверх предела берёт размер от текущего мастера, а не из прошлого раскрытия', () => {
  const doc = libDoc((board, lib) => {
    const L = [{ op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'column' }, size: fx(120, 40) } }];
    for (let i = 0; i < 59; i++) L.push({ op: 'create', node: { type: 'rect', id: 'r' + i, parent: 'M', size: fx(4, 4) } });
    L.push({ op: 'set', id: 'M', path: 'component', value: { name: 'M' } },
      { op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', wrap: true, gap: 4 }, size: { w: { mode: 'fixed', value: 4000 }, h: { mode: 'hug' } } } });
    for (let i = 0; i < 1000; i++) L.push({ op: 'create', node: { type: 'instance', id: 'I' + i, parent: 'G', of: 'M' } });
    return L;
  });
  quiet(() => solve(doc, OPTS));
  const next = applyOps(doc, [{ op: 'set', id: 'M', path: 'size', value: fx(200, 70) }], { checkExpand: false }).doc;
  const a = quiet(() => solve(next, OPTS));
  const fresh = quiet(() => solve(structuredClone(next), OPTS));
  assert.ok(Object.keys(a.expanded).some((id) => a.expanded[id].stub), 'есть заглушки');
  assert.equal(hashGeometry(a), hashGeometry(fresh));
});

test('круг54: коллизия раскрытого id с узлом документа — нет образцов, solveAfter раскладывает полностью', () => {
  const master = (lib) => [
    { op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'row' }, size: hug } },
    { op: 'create', node: { type: 'rect', id: 'x', parent: 'M', size: fx(10, 10) } },
    { op: 'set', id: 'M', path: 'component', value: { name: 'M' } },
  ];
  // прямоугольник «a/x» раньше экземпляра «a»; «c» той же формы
  const doc = libDoc((board, lib) => master(lib).concat([
    { op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', gap: 5 }, size: hug } },
    { op: 'create', node: { type: 'rect', id: 'a/x', parent: 'G', size: fx(70, 70) } },
    { op: 'create', node: { type: 'instance', id: 'a', parent: 'G', of: 'M' } },
    { op: 'create', node: { type: 'instance', id: 'c', parent: 'G', of: 'M' } },
  ]));
  assert.ok(expandDoc(doc).collide);
  const geo = solve(doc, KEPT);
  assert.equal(hashGeometry(geo), hashGeometry(solve(doc, PLAIN)));
  assert.ok(geo.rects['c/x'], 'у копии не потерян потомок');
  // по месту правки и без образцов: «a» чист, но его прежний отрезок — без «a/x»
  const op = [{ op: 'remove', id: 'a/x' }];
  const next = applyOps(doc, op).doc;
  const plainGeo = solve(doc, { ...PLAIN, incremental: true });
  assert.equal(hashGeometry(solveAfter(plainGeo, doc, next, op, PLAIN)), hashGeometry(solve(next, PLAIN)));
  const inc = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)));
  assert.deepEqual(inc.rects['a/x'], solve(next, PLAIN).rects['a/x']);
  // и обратно — к документу с коллизией
  assert.equal(hashGeometry(solveAfter(inc, next, doc, [], OPTS)), hashGeometry(solve(doc, PLAIN)));
});

test('круг54: вложенный экземпляр под чужим id («I/mb/bt» настоящий) — в любом порядке создания', () => {
  for (const order of ['коллизия первой', 'коллизия последней']) {
    const doc = libDoc((board, lib) => {
      const L = [
        { op: 'create', node: { type: 'frame', id: 'B', parent: lib, children: [], layout: { mode: 'row', gap: 2 }, size: hug } },
        { op: 'create', node: { type: 'text', id: 'bt', parent: 'B', characters: 'бэйдж', size: hug } },
        { op: 'create', node: { type: 'rect', id: 'br', parent: 'B', size: fx(7, 7) } },
        { op: 'set', id: 'B', path: 'component', value: { name: 'B', props: [{ name: 'label', kind: 'text', target: 'bt', path: 'characters' }] } },
        { op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'column', gap: 3 }, size: hug } },
        { op: 'create', node: { type: 'text', id: 'mt', parent: 'M', characters: 'заголовок', size: hug } },
        { op: 'create', node: { type: 'instance', id: 'mb', parent: 'M', of: 'B', props: { label: 'внутр' } } },
        { op: 'set', id: 'M', path: 'component', value: { name: 'M' } },
        { op: 'create', node: { type: 'frame', id: 'G', parent: board, children: [], layout: { mode: 'row', gap: 5 }, size: hug } },
      ];
      const I = [{ op: 'create', node: { type: 'instance', id: 'I', parent: 'G', of: 'M' } }, { op: 'create', node: { type: 'instance', id: 'I2', parent: 'G', of: 'M' } }];
      const C = [{ op: 'create', node: { type: 'instance', id: 'I/mb/bt', parent: 'G', of: 'B' } }];
      return L.concat(order === 'коллизия первой' ? C.concat(I) : I.concat(C));
    });
    const geo = solve(doc, KEPT);
    assert.equal(hashGeometry(geo), hashGeometry(solve(doc, PLAIN)), order);
    const op = [{ op: 'remove', id: 'I/mb/bt' }];
    const next = applyOps(doc, op).doc;
    const inc = solveAfter(geo, doc, next, op, OPTS);
    assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)), `${order}: удаление`);
    assert.equal(hashGeometry(solveAfter(inc, next, doc, [], OPTS)), hashGeometry(solve(doc, PLAIN)), `${order}: возврат`);
  }
});

test('круг54: предел глубины — по глубине экземпляра в документе, а не по стеку меры (мера при размещении)', () => {
  for (const depth of [235, 245]) {
    const doc = libDoc((board, lib) => {
      const L = [{ op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'row', padding: 1 }, size: hug } }];
      let p = 'M';
      for (let i = 0; i < 20; i++) { L.push({ op: 'create', node: { type: 'frame', id: 'm' + i, parent: p, children: [], layout: { mode: 'row', padding: 1 }, size: hug } }); p = 'm' + i; }
      L.push({ op: 'create', node: { type: 'rect', id: 'leaf', parent: p, size: fx(10, 10) } }, { op: 'set', id: 'M', path: 'component', value: { name: 'M' } });
      // «G (row 400) > P (row, w fill) > [rect 5×80, экземпляр с h fill]»: экземпляр перемеряется при размещении
      const group = (parent, tag) => L.push(
        { op: 'create', node: { type: 'frame', id: 'G' + tag, parent, children: [], layout: { mode: 'row' }, size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'hug' } } } },
        { op: 'create', node: { type: 'frame', id: 'P' + tag, parent: 'G' + tag, children: [], layout: { mode: 'row' }, size: { w: { mode: 'fill' }, h: { mode: 'hug' } } } },
        { op: 'create', node: { type: 'rect', id: 'R' + tag, parent: 'P' + tag, size: fx(5, 80) } },
        { op: 'create', node: { type: 'instance', id: tag, parent: 'P' + tag, of: 'M', size: { w: { mode: 'hug' }, h: { mode: 'fill' } } } });
      group(board, 'A');
      p = board;
      for (let i = 0; i < depth; i++) { L.push({ op: 'create', node: { type: 'frame', id: 'f' + i, parent: p, children: [], layout: { mode: 'row' }, size: hug } }); p = 'f' + i; }
      group(p, 'B');
      return L;
    });
    const geo = quiet(() => solve(doc, OPTS));
    const plain = quiet(() => solve(doc, PLAIN));
    assert.equal(hashGeometry(geo), hashGeometry(plain), `глубина ${depth}`);
    assert.deepEqual(geo.rects.B, plain.rects.B);
  }
});

test('круг54: перенос предка меняет глубину экземпляра у предела — solveAfter раскладывает полностью (вверх и вниз)', () => {
  const doc0 = libDoc((board, lib) => {
    const L = [{ op: 'create', node: { type: 'frame', id: 'M', parent: lib, children: [], layout: { mode: 'row', padding: 1 }, size: hug } }];
    let p = 'M';
    for (let i = 0; i < 20; i++) { L.push({ op: 'create', node: { type: 'frame', id: 'm' + i, parent: p, children: [], layout: { mode: 'row', padding: 1 }, size: hug } }); p = 'm' + i; }
    L.push({ op: 'create', node: { type: 'rect', id: 'leaf', parent: p, size: fx(10, 10) } }, { op: 'set', id: 'M', path: 'component', value: { name: 'M' } });
    p = board;
    for (let i = 0; i < 240; i++) { L.push({ op: 'create', node: { type: 'frame', id: 'f' + i, parent: p, children: [], layout: { mode: 'row' }, size: hug } }); p = 'f' + i; }
    L.push({ op: 'create', node: { type: 'instance', id: 'B', parent: p, of: 'M' } },
      { op: 'create', node: { type: 'frame', id: 'S', parent: 'f10', children: [], layout: { mode: 'row' }, size: hug } });
    return L;
  });
  for (const plain of [false, true]) {
    const opt = plain ? PLAIN : OPTS;
    let doc = doc0;
    let geo = quiet(() => solve(doc, { ...opt, incremental: true }));
    for (const op of [[{ op: 'move', id: 'f40', parent: 'S', index: 0 }], [{ op: 'move', id: 'f40', parent: 'f39', index: 0 }]]) {
      const next = applyOps(doc, op).doc;
      const inc = quiet(() => solveAfter(geo, doc, next, op, opt));
      const full = quiet(() => solve(next, PLAIN));
      assert.equal(hashGeometry(inc), hashGeometry(full), `${plain ? 'без образцов' : 'с образцами'}: ${op[0].parent}`);
      doc = next;
      geo = inc;
    }
  }
});

test('круг61: быстрый путь — правка вне экземпляров не раскрывает заново; новый id, совпавший с раскрытым, и solveCarry — обычный путь', () => {
  const doc = instanceDoc(20);
  const geo = solve(doc, KEPT);
  const op = [{ op: 'set', id: 'note', path: 'characters', value: 'Совсем другая подпись' }];
  const next = applyOps(doc, op).doc;
  const inc = solveAfter(geo, doc, next, op, OPTS);
  assert.equal(hashGeometry(inc), hashGeometry(solve(next, PLAIN)));
  assert.equal(inc.expanded, geo.expanded, 'раскрытие — тот же объект: expandDoc не звали');
  assert.equal(inc.rects['I5/mt'], geo.rects['I5/mt']);
  // настоящий узел с id раскрытого («I2/mr») — коллизия: обычный путь, и тот же результат, что у эталона
  const op2 = [{ op: 'create', node: { type: 'rect', id: 'I2/mr', parent: 'G', size: fx(30, 30) } }];
  const next2 = applyOps(next, op2).doc;
  const inc2 = solveAfter(inc, next, next2, op2, OPTS);
  assert.equal(hashGeometry(inc2), hashGeometry(solve(next2, PLAIN)));
  // имя (без геометрии) через solveCarry, потом правка текста — карта памяти отстала: обычный путь, верно
  const g3 = solve(doc, KEPT);
  const renamed = applyOps(doc, [{ op: 'set', id: 'note', path: 'name', value: 'Подпись' }]).doc;
  solveCarry(g3, doc, renamed);
  const op4 = [{ op: 'set', id: 'note', path: 'characters', value: 'После переименования' }];
  const next4 = applyOps(renamed, op4).doc;
  assert.equal(hashGeometry(solveAfter(g3, renamed, next4, op4, OPTS)), hashGeometry(solve(next4, PLAIN)));
  // новая доска с темой рядом с экземплярами
  const op5 = [{ op: 'create', node: { type: 'frame', id: 'T', parent: doc.root, pos: { x: 3000, y: 0 }, children: [], size: hug, theme: { type: { body: { fontWeight: 700 } } } } }];
  const r5 = applyOps(next, op5);
  if (!r5.error) assert.equal(hashGeometry(solveAfter(solve(next, KEPT), next, r5.doc, op5, OPTS)), hashGeometry(solve(r5.doc, PLAIN)));
});
