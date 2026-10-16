import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, applyBatches, rebase, collectTombstones, invertOps, hashDoc, subtreeIds,
  normalizeTombstones, pruneTombstones, cleanKey, MAX_DEPTH,
  ensureLibraryOps, ensureScaleRefsOps, libraryNode, artboards, solve, validate
} = core;

/* Круг 27, CORE. (1) плоский родитель: копия children один раз на черновик, место —
   по ленивому индексу позиций, токены — копия-при-записи; (2) предел вложенности и
   обходы без обрыва на MAX_DEPTH; (3) надгробия v1/v2/null и прореживание;
   (4) пустой документ без миграции; (5) cleanKey. Точность (1) против прежнего
   поведения — в scale.test.mjs (сравнение с эталоном на длинных списках). */

const M = { measureText: (t, s) => String(t).length * s.fontSize * 0.5 };
const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const text = (id, parent) => ({ type: 'text', id, name: id, parent, characters: 'x', size: HUG });
const frame = (id, parent) => ({ type: 'frame', id, name: id, parent, children: [], size: HUG });
const time = (fn) => { const s = performance.now(); const r = fn(); return [r, performance.now() - s]; };

/** Пустой документ + рамка F с n детьми (одним черновиком на 5000 операций). */
function flatDoc(n) {
  let doc = createDoc('empty');
  const list = [{ op: 'create', node: frame('F', doc.root) }];
  const kids = [];
  for (let i = 0; i < n; i++) { const id = 'k' + i; kids.push(id); list.push({ op: 'create', node: text(id, 'F') }); }
  for (let i = 0; i < list.length; i += 5000) {
    const r = applyOps(doc, list.slice(i, i + 5000));
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    doc = r.doc;
  }
  return { doc, kids };
}

/** Прежняя модель списка: filter + splice по каждой операции — для сверки порядка детей. */
function refChildren(doc, list) {
  const kids = doc.nodes.F.children.slice();
  for (const op of list) {
    if (op.op === 'remove') { const i = kids.indexOf(op.id); if (i >= 0) kids.splice(i, 1); }
    else if (op.op === 'move') {
      const i = kids.indexOf(op.id);
      if (i >= 0) kids.splice(i, 1);
      kids.splice(Math.min(Math.max(op.index, 0), kids.length), 0, op.id);
    } else if (op.op === 'create') kids.splice(Math.min(Math.max(op.index ?? kids.length, 0), kids.length), 0, op.node.id);
  }
  return kids;
}

test('плоский родитель на 19 000 детей: 5000 remove / move / create / setToken — без отказов по бюджету, каждый проход < 1 с', () => {
  const { doc, kids } = flatDoc(19000);
  const before = JSON.stringify(doc);
  let r = 12345;
  const rnd = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  const pick = () => kids[Math.floor(rnd() * kids.length)];
  const cases = {
    remove: kids.slice(0, 5000).map((id) => ({ op: 'remove', id })),
    removeRandom: Array.from({ length: 5000 }, (_, i) => ({ op: 'remove', id: kids[(i * 7919) % 19000] })),
    moveTop: kids.slice(5000, 10000).map((id) => ({ op: 'move', id, parent: 'F', index: 0 })),
    moveAfter: Array.from({ length: 5000 }, () => ({ op: 'move', id: pick(), parent: 'F', after: pick() })),
    create: Array.from({ length: 5000 }, (_, i) => ({ op: 'create', node: text('n' + i, 'F'), after: pick() })),
    setToken: Array.from({ length: 5000 }, (_, i) => ({ op: 'setToken', path: 'colors.c' + i, value: '#fff' }))
  };
  const report = {};
  for (const [name, list] of Object.entries(cases)) {
    const [m, tRebase] = time(() => rebase(doc, list, { tombstones: new Map(), budgetMs: 2000 }));
    assert.deepEqual(m.dropped, [], name + ': отброшено ' + m.dropped.length);
    assert.equal(m.ops.length, 5000, name);
    const [res, tApply] = time(() => applyOps(doc, m.ops));
    assert.equal(res.error, undefined, name);
    const [tomb, tCollect] = time(() => collectTombstones(doc, m.ops));
    report[name] = [tRebase, tApply, tCollect].map(Math.round);
    // абсолютный порог — с запасом в разы (замер: 30–300 мс на проход; было до 6 с)
    for (const t of [tRebase, tApply, tCollect]) assert.ok(t < 1000, name + ': ' + JSON.stringify(report));
    if (name !== 'setToken') {
      // порядок детей — как у прежнего «filter + splice» поштучно
      assert.deepEqual(res.doc.nodes.F.children, refChildren(doc, m.ops), name + ': порядок детей');
    } else {
      assert.equal(Object.keys(res.doc.tokens.colors).filter((k) => /^c\d+$/.test(k)).length, 5000);
    }
    if (name.startsWith('remove')) assert.equal(tomb.length, 5000);
  }
  assert.equal(JSON.stringify(doc), before, 'вход не изменён');
});

test('черновик запечатан: правка результата applyOps не меняет прежний результат', () => {
  const { doc } = flatDoc(200);
  const r1 = applyOps(doc, [{ op: 'move', id: 'k5', parent: 'F', index: 0 }, { op: 'remove', id: 'k9' }, { op: 'setToken', path: 'colors.x', value: '#000' }]);
  const snap = JSON.stringify(r1.doc);
  const r2 = applyOps(r1.doc, [{ op: 'move', id: 'k7', parent: 'F', index: 0 }, { op: 'remove', id: 'k100' }, { op: 'setToken', path: 'colors.y', value: '#111' }]);
  assert.equal(r2.error, undefined);
  assert.equal(JSON.stringify(r1.doc), snap, 'первый результат цел');
  const b = applyBatches(r1.doc, [[{ op: 'remove', id: 'k1' }]]);
  applyOps(b.doc, [{ op: 'remove', id: 'k2' }]);
  assert.equal(JSON.stringify(r1.doc), snap);
  assert.ok(b.doc.nodes.k2, 'результат applyBatches тоже запечатан');
});

test('откат отказавшей пачки на длинном списке: документ как до неё, порядок детей цел', () => {
  const { doc } = flatDoc(300);
  const bad = [
    { op: 'move', id: 'k10', parent: 'F', index: 0 },
    { op: 'remove', id: 'k20' },
    { op: 'create', node: text('z1', 'F'), index: 5 },
    { op: 'setToken', path: 'colors.accent' },
    { op: 'move', id: 'k30', parent: 'k31' }          // родитель — текст: пачка отказывает
  ];
  const good = [{ op: 'move', id: 'k40', parent: 'F', index: 1 }];
  const res = applyBatches(doc, [bad, good]);
  assert.ok(res.results[0] && res.results[0].error);
  assert.equal(res.results[1], null);
  const ref = applyOps(doc, good).doc;
  assert.equal(JSON.stringify(res.doc.nodes.F.children), JSON.stringify(ref.nodes.F.children));
  assert.equal(JSON.stringify(res.doc.tokens), JSON.stringify(doc.tokens), 'палитра — с accent на прежнем месте');
  // rebase: та же операция отброшена, остальные легли, итог = applyOps принятых
  const m = rebase(doc, [...bad, ...good]);
  assert.deepEqual(m.dropped.map((d) => [d.index, d.reason]), [[4, 'invalid']]);
  const a = applyOps(doc, m.ops);
  let step = doc;
  for (const op of m.ops) step = applyOps(step, [op]).doc;
  assert.equal(JSON.stringify(a.doc.nodes), JSON.stringify(step.nodes));
});

/* ------------------------------- вложенность ------------------------------- */

/** Цепочка фреймов под доской длиной n (n ≤ предела — операциями). */
function chain(doc, n, tag = 'd') {
  const ids = [];
  const list = [{ op: 'create', node: { ...frame(tag + 'ab', doc.root), pos: { x: 0, y: 0 } } }];
  let parent = tag + 'ab';
  for (let i = 0; i < n; i++) { const id = tag + i; ids.push(id); list.push({ op: 'create', node: frame(id, parent) }); parent = id; }
  return { list, ids };
}

test('предел вложенности: create глубже MAX_DEPTH — отказ (limit depth), до предела — можно', () => {
  const doc = createDoc('empty');
  // доска — глубина 1, звено i — глубина i + 2: последнее допустимое — i = MAX_DEPTH − 2
  const ok = chain(doc, MAX_DEPTH - 1);
  const r = applyOps(doc, ok.list);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const deepest = ok.ids[ok.ids.length - 1];
  const more = applyOps(r.doc, [{ op: 'create', node: text('t', deepest) }]);
  assert.equal(more.error.code, 'bad-parent');
  assert.equal(more.error.limit, 'depth');
  const m = rebase(r.doc, [{ op: 'create', node: text('t', deepest) }, { op: 'create', node: text('t2', ok.ids[0]) }]);
  assert.deepEqual(m.dropped.map((d) => [d.index, d.reason, d.limit]), [[0, 'invalid', 'depth']]);
  assert.equal(m.ops.length, 1);
  // move, опускающий поддерево ниже предела, — отказ; move вверх — можно
  const side = applyOps(r.doc, [{ op: 'create', node: frame('s', 'dab') }, { op: 'create', node: frame('s2', 's') }]).doc;
  const down = rebase(side, [{ op: 'move', id: 's', parent: ok.ids[ok.ids.length - 2] }]);
  assert.deepEqual(down.dropped.map((d) => [d.reason, d.limit]), [['invalid', 'depth']]);
  assert.equal(applyOps(side, [{ op: 'move', id: 's', parent: ok.ids[ok.ids.length - 3] }]).error, undefined, 's2 ровно на пределе');
  assert.equal(applyOps(side, [{ op: 'move', id: ok.ids[100], parent: 'dab' }]).error, undefined, 'подъём — всегда');
  // create, усыновляющий поддерево и опускающий его ниже предела, — отказ
  const adopt = applyOps(side, [{ op: 'create', node: { ...frame('g', ok.ids[ok.ids.length - 3]), children: ['s'] } }]);
  assert.equal(adopt.error && adopt.error.limit, 'depth');
});

test('документ глубже предела (прежняя версия): move в цикл — отказ, remove уносит всё, надгробия — все', () => {
  // такой документ операциями не собрать — кладём узлы напрямую
  let doc = createDoc('empty');
  const D = 300;
  const nodes = { ...doc.nodes };
  const ids = [];
  let parent = doc.root;
  for (let i = 0; i < D; i++) {
    const id = 'q' + i;
    ids.push(id);
    nodes[id] = { ...frame(id, parent), children: [] };
    nodes[parent] = { ...nodes[parent], children: [...nodes[parent].children, id] };
    parent = id;
  }
  doc = { ...doc, nodes };
  const mv = { op: 'move', id: ids[0], parent: ids[D - 1], index: 0 };
  assert.equal(applyOps(doc, [mv]).error.code, 'cycle', 'верх под низ цепочки в 300 звеньев — цикл');
  assert.deepEqual(rebase(doc, [mv]).dropped.map((d) => d.reason), ['cycle']);
  // move внутри слишком глубокого поддерева, не опускающий его, — не запрещён
  assert.equal(applyOps(doc, [{ op: 'create', node: frame('w', ids[D - 2]) }]).error.limit, 'depth');
  assert.equal(applyOps(doc, [{ op: 'move', id: ids[D - 1], parent: ids[D - 3] }]).error, undefined);
  assert.equal(subtreeIds(doc, ids[0]).length, D, 'subtreeIds — без обрыва');
  const rm = applyOps(doc, [{ op: 'remove', id: ids[0] }]);
  assert.equal(rm.error, undefined);
  for (const id of ids) assert.equal(rm.doc.nodes[id], undefined, 'сирот нет: ' + id);
  assert.equal(collectTombstones(doc, [{ op: 'remove', id: ids[0] }]).length, D);
  // create под удалённым глубоким узлом находит живого предка по всей цепочке надгробий
  const tomb = new Map(collectTombstones(doc, [{ op: 'remove', id: ids[0] }]));
  const m = rebase(rm.doc, [{ op: 'create', node: text('late', ids[D - 1]) }], { tombstones: tomb });
  assert.deepEqual(m.notes.map((n) => n.note), ['reparented']);
  assert.equal(m.ops[0].node.parent, doc.root);
  // уже лежащий цикл (битый документ) не вешает проверки
  const loop = { ...doc, nodes: { ...doc.nodes, q0: { ...doc.nodes.q0, parent: ids[D - 1] } } };
  assert.equal(applyOps(loop, [{ op: 'move', id: ids[5], parent: ids[D - 1] }]).error.code, 'cycle');
});

/* -------------------------------- надгробия -------------------------------- */

test('normalizeTombstones: v1, v2, null, Map, пары; негодное — вон', () => {
  assert.equal(normalizeTombstones(null), null);
  assert.equal(normalizeTombstones(undefined), null);
  assert.equal(normalizeTombstones({ v: 3, parents: {} }), null, 'неизвестная версия — «неизвестно»');
  assert.equal(normalizeTombstones({ v: 2, parents: 'x' }), null, 'битый v2 — «неизвестно»');
  assert.equal(normalizeTombstones('строка'), null);
  assert.deepEqual(normalizeTombstones({}), { parents: {}, seq: {} });
  assert.deepEqual(normalizeTombstones({ a: 'p', b: null, c: 5, __proto__x: 'p' }), { parents: { a: 'p', b: null, c: null, __proto__x: 'p' }, seq: {} });
  assert.deepEqual(normalizeTombstones({ a: 'p' }, { seq: 7 }), { parents: { a: 'p' }, seq: { a: 7 } }, 'v1 + номер снимка');
  const v1 = JSON.parse('{"a":"p","__proto__":"x","constructor":"y"}');
  assert.deepEqual(normalizeTombstones(v1), { parents: { a: 'p' }, seq: {} }, 'ключи прототипа отброшены');
  const v2 = { v: 2, parents: { a: 'p', b: 'a', c: null }, seq: { a: 10, b: '11', c: -1 } };
  assert.deepEqual(normalizeTombstones(v2), { parents: { a: 'p', b: 'a', c: null }, seq: { a: 10, b: 11 } });
  assert.deepEqual(normalizeTombstones(v2, { seq: 3 }), { parents: { a: 'p', b: 'a', c: null }, seq: { a: 10, b: 11, c: 3 } });
  assert.deepEqual(normalizeTombstones({ parents: { a: 'p' }, seq: { a: 1 } }), { parents: { a: 'p' }, seq: { a: 1 } }, 'нормализованная форма — как v2');
  assert.deepEqual(normalizeTombstones(new Map([['a', 'p'], ['b', undefined]]), { seq: 2 }), { parents: { a: 'p', b: null }, seq: { a: 2, b: 2 } });
  assert.deepEqual(normalizeTombstones([['a', 'p', 4], ['b', null], ['', 'x'], 'мусор']), { parents: { a: 'p', b: null }, seq: { a: 4 } });
  assert.equal(Object.getPrototypeOf(normalizeTombstones(v1).parents), Object.prototype);
});

test('pruneTombstones: по номеру удаления и числу; порядок входа; без номера — самые старые', () => {
  const parents = { a: 'r', b: 'a', c: 'r', d: 'c', e: 'r' };
  const seq = { a: 5, b: 5, c: 9, d: 12 };   // e — без номера
  assert.deepEqual(pruneTombstones(parents, seq, { minSeq: 6 }), { parents: { c: 'r', d: 'c' }, seq: { c: 9, d: 12 } });
  assert.deepEqual(pruneTombstones(parents, seq, { max: 3 }), { parents: { b: 'a', c: 'r', d: 'c' }, seq: { b: 5, c: 9, d: 12 } }, 'при равных — позже записанный');
  assert.deepEqual(pruneTombstones(parents, seq, {}), { parents, seq }, 'без пределов — всё');
  assert.deepEqual(pruneTombstones(new Map(Object.entries(parents)), new Map(Object.entries(seq)), { minSeq: 10 }), { parents: { d: 'c' }, seq: { d: 12 } });
  assert.deepEqual(pruneTombstones({ v: 2, parents, seq }, seq, { minSeq: 12 }), { parents: { d: 'c' }, seq: { d: 12 } }, 'v2 вместо parents');
  assert.deepEqual(pruneTombstones(parents, seq, { max: 0 }), { parents: {}, seq: {} });
  assert.deepEqual(parents, { a: 'r', b: 'a', c: 'r', d: 'c', e: 'r' }, 'вход цел');
});

test('rebase и collectTombstones принимают Map, объект parents, v2 и {parents, seq}', () => {
  const doc = createDoc();
  const board = artboards(doc)[0].id;
  const victim = doc.nodes[board].children[0];
  const kid = subtreeIds(doc, victim)[1] || victim;
  const removeOps = [{ op: 'remove', id: victim }];
  const pairs = collectTombstones(doc, removeOps);
  const after = applyOps(doc, removeOps).doc;
  const intoMap = new Map();
  const intoObj = {};
  const intoV2 = { parents: {}, seq: {} };
  assert.deepEqual(collectTombstones(doc, removeOps, intoMap), pairs);
  collectTombstones(doc, removeOps, intoObj);
  collectTombstones(doc, removeOps, intoV2, 42);
  assert.deepEqual([...intoMap], pairs);
  assert.deepEqual(intoObj, Object.fromEntries(pairs));
  assert.deepEqual(intoV2.parents, Object.fromEntries(pairs));
  assert.ok(Object.values(intoV2.seq).every((s) => s === 42) && Object.keys(intoV2.seq).length === pairs.length);
  const create = [{ op: 'create', node: { type: 'text', id: 'late', parent: kid, characters: 'x' } }];
  const want = rebase(after, create, { tombstones: intoMap });
  assert.deepEqual(want.notes, [{ index: 0, note: 'reparented' }]);
  assert.equal(want.ops[0].node.parent, board);
  for (const t of [intoObj, intoV2, { v: 2, ...intoV2 }, normalizeTombstones({ v: 2, ...intoV2 })]) {
    assert.deepEqual(rebase(after, create, { tombstones: t }), want, JSON.stringify(Object.keys(t)));
  }
  // без надгробий — сирота
  assert.deepEqual(rebase(after, create, { tombstones: {} }).dropped.map((d) => d.reason), ['orphan']);
});

/* ------------------------------ пустой документ ------------------------------ */

test('createDoc("empty") — в нынешнем формате: миграции оболочки (maybeMigrate) делать нечего', () => {
  const doc = createDoc('empty');
  // maybeMigrate (app.js) = ensureLibraryOps + ensureScaleRefsOps: оба пусты — ни транзакции, ни тоста
  assert.deepEqual(ensureLibraryOps(doc), []);
  assert.deepEqual(ensureScaleRefsOps(doc), []);
  const lib = libraryNode(doc);
  assert.ok(lib && lib.parent === doc.root && doc.nodes[doc.root].children.includes(lib.id));
  assert.equal(artboards(doc).length, 0, 'досок нет — пустое состояние оболочки как было');
  assert.deepEqual(validate(doc, solve(doc, M), M).filter((v) => v.severity === 'error'), []);
  // переживает снимок (JSON) и нормализацию сервером/клиентом
  const round = createDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(hashDoc(round), hashDoc(doc));
  assert.deepEqual(ensureLibraryOps(round), []);
  // первая доска и операции на ней — как раньше
  const r = applyOps(doc, [{ op: 'create', node: { ...frame('ab', doc.root), pos: { x: 0, y: 0 } } }]);
  assert.equal(r.error, undefined);
  assert.equal(artboards(r.doc).length, 1);
  assert.equal(invertOps(doc, [{ op: 'remove', id: lib.id }]).length, 1, 'библиотеку можно и удалить, и вернуть отменой');
});

/* --------------------------------- ключи --------------------------------- */

test('cleanKey: чистка как cleanText, опасный ключ после чистки — null', () => {
  assert.equal(cleanKey('name'), 'name');
  assert.equal(cleanKey('a\u0000b'), 'ab');
  assert.equal(cleanKey('\ud800x'), '�x');
  assert.equal(cleanKey('__proto__\u0000'), null);
  assert.equal(cleanKey('\u0000constructor'), null);
  assert.equal(cleanKey('proto\u0000type'), null);
  assert.equal(cleanKey('__proto__'), null);
  assert.equal(cleanKey('toString'), 'toString', 'собственное свойство toString безвредно');
  assert.equal(cleanKey(5), '5');
  // так чистит рекурсивный обход: опасный ключ — вон вместе со значением
  const src = JSON.parse('{"a":1,"__proto__\\u0000":{"polluted":true},"b\\u0000":2}');
  const out = {};
  for (const k of Object.keys(src)) { const k2 = cleanKey(k); if (k2 !== null) out[k2] = src[k]; }
  assert.deepEqual(out, { a: 1, b: 2 });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(({}).polluted, undefined);
});
