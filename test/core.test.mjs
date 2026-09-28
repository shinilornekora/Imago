import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc, applyOps, invertOps, solve, validate, ops, hashGeometry,
  nodeById, ancestors, isArtboard, artboards, cloneSubtree, resolveTarget,
  contrastRatio, resolveTextStyle, resolveColor, subtreeIds, Stage,
  resetMeasureCache, measureEpoch, onMeasureEpoch, placeholderName, displayName,
  isLibrary, libraryId, libraryNode, ensureLibrary, ensureLibraryOps,
  components, componentSignature, instanceSummary, isMaster, masterOf,
  canMakeComponent, makeComponentOps, instanceOps, detachInstanceOps,
  expandInstance, MAX_INSTANCE_DEPTH,
  resolveScale, resolveLayout, resolveRadius, parseScaleRef, isScaleRef, scaleRef, scaleIndexOf, scaleSteps,
  keepFieldForm, ensureScaleRefs, ensureScaleRefsOps, scaleRefsIn, rewriteScaleRefsOps, insertScaleStep,
  normalizeLayout, DEFAULT_TOKENS, rebase
} from '../src/core.js';

/* Заглушка измерителя: ширина символа = 0.5 кегля (0.6 для моноширинного). */
const measureText = (text, style) => String(text).length * style.fontSize * (style.mono ? 0.6 : 0.5);
const M = { measureText };

/** Мини-документ: страница + артборд + дети. */
function scene(build) {
  let doc = createDoc('empty');
  const push = (list) => {
    const res = applyOps(doc, list);
    assert.equal(res.error, undefined, 'операции должны применяться: ' + JSON.stringify(res.error));
    doc = res.doc;
  };
  const ab = {
    type: 'frame', id: 'ab', name: 'Артборд', parent: doc.root, children: [],
    pos: { x: 0, y: 0 }, radius: 0,
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 200 } },
    layout: { mode: 'none', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false },
    fill: '#ffffff'
  };
  push([ops.create(ab)]);
  push(build());
  return doc;
}

const rectOf = (doc, id, opts = M) => solve(doc, opts).rects[id];
const box = (id, parent, w, h, extra = {}) => ({
  type: 'rect', id, name: id, parent, radius: 0, fill: '#cccccc',
  size: { w: typeof w === 'number' ? { mode: 'fixed', value: w } : { mode: w }, h: typeof h === 'number' ? { mode: 'fixed', value: h } : { mode: h } },
  ...extra
});
const label = (id, parent, characters, extra = {}) => ({
  type: 'text', id, name: id, parent, characters, color: '#14161C', align: 'left',
  style: { token: 'body' },
  size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
  ...extra
});
const frame = (id, parent, layout, size, extra = {}) => ({
  type: 'frame', id, name: id, parent, children: [], radius: 0,
  layout: { mode: 'none', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false, ...layout },
  size, ...extra
});

/* ------------------------------ операции ------------------------------ */

test('applyOps: create/set/move/remove, иммутабельность, ошибки в {error}', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 10, 10))]);
  const snapshot = JSON.stringify(doc);

  const r1 = applyOps(doc, [ops.set('a', 'fill', '#ff0000')]);
  assert.equal(r1.error, undefined);
  assert.equal(r1.doc.nodes.a.fill, '#ff0000');
  assert.equal(doc.nodes.a.fill, '#cccccc', 'исходный документ не меняется');
  assert.equal(JSON.stringify(doc), snapshot);
  assert.equal(r1.doc.version, doc.version + 1);

  for (const path of ['id', 'type', 'parent', 'children']) {
    const bad = applyOps(doc, [ops.set('a', path, 'x')]);
    assert.match(bad.error.message, /защищён/, 'путь ' + path);
    assert.equal(bad.error.code, 'protected-path');
    assert.equal(bad.doc, doc, 'документ не трогаем при ошибке');
  }
  assert.match(applyOps(doc, [ops.set('a', 'size.w', { mode: 'fixed', value: -1 })]).error.message, /вне диапазона/);
  assert.match(applyOps(doc, [ops.set('нет', 'fill', '#000')]).error.message, /не найден/);
  assert.match(applyOps(doc, [ops.create({ type: 'осьминог', id: 'z', parent: 'ab' })]).error.message, /неизвестный тип/);
  assert.match(applyOps(doc, [ops.create(box('a', 'ab', 5, 5))]).error.message, /уже занят/);
  assert.match(applyOps(doc, [ops.move('ab', 'a', 0)]).error.message, /не контейнер/);
  assert.doesNotThrow(() => applyOps(doc, [null, undefined, { op: 'нет' }]));

  const two = applyOps(doc, [ops.create(box('b', 'ab', 10, 10)), ops.move('b', 'ab', 0)]);
  assert.deepEqual(two.doc.nodes.ab.children, ['b', 'a']);
  const half = applyOps(doc, [ops.create(box('c', 'ab', 10, 10)), ops.set('c', 'radius', -5)]);
  assert.ok(half.error, 'транзакция целиком отклоняется');
  assert.equal(half.doc.nodes.c, undefined);
});

test('setToken меняет токены документа и инвертируется', () => {
  const doc = createDoc();
  const r = applyOps(doc, [ops.setToken('colors.accent', '#0000ff')]);
  assert.equal(r.doc.tokens.colors.accent, '#0000ff');
  assert.equal(doc.tokens.colors.accent, '#FF6B3D');
  const back = applyOps(r.doc, invertOps(doc, [ops.setToken('colors.accent', '#0000ff')]));
  assert.equal(back.doc.tokens.colors.accent, '#FF6B3D');
});

test('invertOps: каждая операция отменяется, порядок обратный', () => {
  const doc = scene(() => [
    ops.create(box('a', 'ab', 10, 10)),
    ops.create(box('b', 'ab', 20, 20))
  ]);
  const tx = [
    ops.set('a', 'fill', '#00ff00'),
    ops.set('a', 'radius', 8),
    ops.move('a', 'ab', 1),
    ops.create(box('c', 'ab', 5, 5), 0),
    ops.remove('b')
  ];
  const inv = invertOps(doc, tx);
  const after = applyOps(doc, tx);
  assert.equal(after.error, undefined);
  const back = applyOps(after.doc, inv);
  assert.equal(back.error, undefined);
  assert.deepEqual(
    Object.keys(back.doc.nodes).sort(),
    Object.keys(doc.nodes).sort()
  );
  for (const id of Object.keys(doc.nodes)) {
    assert.deepEqual(back.doc.nodes[id], doc.nodes[id], 'узел ' + id + ' восстановлен');
  }
  assert.equal(hashGeometry(solve(back.doc, M)), hashGeometry(solve(doc, M)));
});

test('invertOps: remove поддерева пересоздаёт его целиком с индексами', () => {
  const doc = scene(() => [
    ops.create(box('before', 'ab', 8, 8)),
    ops.create(frame('card', 'ab', { mode: 'column', gap: 4 }, { w: { mode: 'hug' }, h: { mode: 'hug' } })),
    ops.create(label('t1', 'card', 'первый')),
    ops.create(label('t2', 'card', 'второй')),
    ops.create(frame('inner', 'card', { mode: 'row' }, { w: { mode: 'hug' }, h: { mode: 'hug' } })),
    ops.create(label('t3', 'inner', 'глубоко')),
    ops.create(box('after', 'ab', 8, 8))
  ]);
  const tx = [ops.remove('card')];
  const inv = invertOps(doc, tx);
  const after = applyOps(doc, tx);
  assert.equal(after.error, undefined);
  for (const id of ['card', 't1', 't2', 'inner', 't3']) assert.equal(after.doc.nodes[id], undefined);
  assert.deepEqual(after.doc.nodes.ab.children, ['before', 'after']);

  const back = applyOps(after.doc, inv);
  assert.equal(back.error, undefined);
  assert.deepEqual(back.doc.nodes.ab.children, ['before', 'card', 'after'], 'индекс сохранён');
  assert.deepEqual(back.doc.nodes.card.children, ['t1', 't2', 'inner']);
  assert.deepEqual(back.doc.nodes.inner.children, ['t3']);
  assert.equal(back.doc.nodes.t3.characters, 'глубоко');
  assert.equal(hashGeometry(solve(back.doc, M)), hashGeometry(solve(doc, M)));
});

test('утилиты: nodeById, ancestors, isArtboard, cloneSubtree, resolveTarget', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column' }, { w: { mode: 'hug' }, h: { mode: 'hug' } }, { role: 'card' })),
    ops.create(label('t1', 'card', 'привет'))
  ]);
  assert.equal(nodeById(doc, 't1').characters, 'привет');
  assert.deepEqual(ancestors(doc, 't1').map((n) => n.id), ['card', 'ab', doc.root]);
  assert.equal(isArtboard(doc, 'ab'), true);
  assert.equal(isArtboard(doc, 'card'), false);
  assert.equal(artboards(doc).length, 1);

  const clone = cloneSubtree(doc, 'card');
  assert.equal(clone.nodes.length, 2);
  assert.notEqual(clone.rootId, 'card');
  assert.equal(clone.nodes[1].parent, clone.rootId, 'дети перецеплены на новые id');
  assert.equal(clone.nodes[0].parent, 'ab');

  assert.equal(resolveTarget(doc, 't1').id, 't1');
  assert.equal(resolveTarget(doc, 'card').id, 'card');
  assert.equal(resolveTarget(doc, 'карточка').id, 'card', 'поиск по роли');
  assert.equal(resolveTarget(doc, 'ничего такого нет'), null);
});

/* ------------------------------ решатель ------------------------------ */

test('solve детерминирован: два вызова дают одинаковый хэш', () => {
  const doc = createDoc();
  const a = solve(doc, M);
  const b = solve(doc, M);
  assert.equal(hashGeometry(a), hashGeometry(b));
  assert.equal(hashGeometry(solve(JSON.parse(JSON.stringify(doc)), M)), hashGeometry(a));
  assert.notEqual(hashGeometry(a), '0');
  const moved = applyOps(doc, [ops.set(artboards(doc)[1].id, 'pos', { x: 500, y: 40 })]);
  assert.notEqual(hashGeometry(solve(moved.doc, M)), hashGeometry(a), 'другой документ — другая геометрия');
  assert.equal(hashGeometry(solve(doc, { measureText, selfTest: true })), hashGeometry(a));
});

test('row: fixed + fill + fixed, gap и padding', () => {
  const doc = scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 10, padding: { t: 20, r: 20, b: 20, l: 20 } },
      { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 100 } })),
    ops.create(box('a', 'row', 50, 40)),
    ops.create(box('b', 'row', 'fill', 40)),
    ops.create(box('c', 'row', 30, 40))
  ]);
  const geo = solve(doc, M);
  assert.deepEqual(geo.rects.a, { x: 20, y: 20, w: 50, h: 40 });
  assert.deepEqual(geo.rects.b, { x: 80, y: 20, w: 260, h: 40 }, '400-40-80-20 = 260');
  assert.deepEqual(geo.rects.c, { x: 350, y: 20, w: 30, h: 40 });
});

test('column: hug по содержимому, align/justify', () => {
  const doc = scene(() => [
    ops.create(frame('col', 'ab', { mode: 'column', gap: 8, padding: { t: 10, r: 10, b: 10, l: 10 }, align: 'center' },
      { w: { mode: 'hug' }, h: { mode: 'hug' } })),
    ops.create(box('a', 'col', 100, 20)),
    ops.create(box('b', 'col', 40, 30))
  ]);
  const geo = solve(doc, M);
  assert.deepEqual(geo.rects.col, { x: 0, y: 0, w: 120, h: 78 }, 'hug = 100+padding, 20+8+30+padding');
  assert.equal(geo.rects.a.x, 10);
  assert.equal(geo.rects.b.x, 10 + (100 - 40) / 2, 'align:center по поперечной оси');
  assert.equal(geo.rects.b.y, 10 + 20 + 8);
});

test('justify: between и end, align: stretch', () => {
  const mk = (justify, align) => scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 0, justify, align },
      { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 60 } })),
    ops.create(box('a', 'row', 50, 20)),
    ops.create(box('b', 'row', 50, 'hug'))
  ]);
  const between = solve(mk('between', 'start'), M).rects;
  assert.equal(between.a.x, 0);
  assert.equal(between.b.x, 250);
  const end = solve(mk('end', 'start'), M).rects;
  assert.equal(end.a.x, 200);
  assert.equal(end.b.x, 250);
  const stretch = solve(mk('start', 'stretch'), M).rects;
  assert.equal(stretch.b.h, 60, 'stretch растягивает hug-ребёнка по поперечной оси');
  assert.equal(stretch.a.h, 20, 'fixed не растягивается');
});

test('wrap переносит детей на новые строки', () => {
  const doc = scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 10, wrap: true },
      { w: { mode: 'fixed', value: 320 }, h: { mode: 'hug' } })),
    ops.create(box('a', 'row', 150, 40)),
    ops.create(box('b', 'row', 150, 40)),
    ops.create(box('c', 'row', 150, 40))
  ]);
  const geo = solve(doc, M);
  assert.equal(geo.rects.a.y, 0);
  assert.equal(geo.rects.b.y, 0);
  assert.equal(geo.rects.b.x, 160);
  assert.equal(geo.rects.c.y, 50, 'третий ушёл на вторую строку');
  assert.equal(geo.rects.c.x, 0);
  assert.equal(geo.rects.row.h, 90);
});

test('перенос текста по словам и hug-высота', () => {
  const style = resolveTextStyle(createDoc('empty'), { style: { token: 'body' } });
  const words = 'редактор макетов собирает экран из простых блоков и проверяет его';
  const doc = scene(() => [
    ops.create(label('t', 'ab', words, { size: { w: { mode: 'fixed', value: 200 }, h: { mode: 'hug' } } }))
  ]);
  const geo = solve(doc, M);
  const lines = geo.lines.t;
  assert.ok(lines.length > 1, 'текст переносится');
  assert.equal(lines.join(' '), words, 'слова не теряются и не дублируются');
  for (const line of lines) {
    assert.ok(measureText(line, style) <= 200 + 0.01, `строка «${line}» помещается в 200`);
  }
  assert.equal(geo.rects.t.h, lines.length * style.lineHeight);
  assert.equal(geo.rects.t.w, 200);

  // hug-ширина = натуральная ширина строки, без переноса
  const hug = scene(() => [ops.create(label('t', 'ab', words))]);
  const g2 = solve(hug, M);
  assert.equal(g2.lines.t.length, 1);
  assert.equal(g2.rects.t.w, measureText(words, style));

  // явные переводы строки уважаются
  const nl = scene(() => [ops.create(label('t', 'ab', 'первая\nвторая'))]);
  assert.deepEqual(solve(nl, M).lines.t, ['первая', 'вторая']);
});

test('кеш измерений не влияет на результат (один инстанс измерителя на solve)', () => {
  let calls = 0;
  const counting = { measureText: (t, s) => { calls++; return measureText(t, s); } };
  const doc = createDoc();
  const a = hashGeometry(solve(doc, counting));
  const first = calls;
  const b = hashGeometry(solve(doc, counting));
  assert.equal(a, b);
  assert.ok(first > 0, 'измеритель действительно вызывался');
  assert.equal(calls, first, 'повторный solve берёт ширины из кеша');
  const other = hashGeometry(solve(doc, { measureText: (t, s) => measureText(t, s) * 2 }));
  assert.notEqual(other, a, 'другой измеритель — другая геометрия, кеши не смешиваются');
});

test('override: узел вне потока, позиционируется абсолютно в родителе', () => {
  const mk = (extra) => scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 10 },
      { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 100 } })),
    ops.create(box('a', 'row', 50, 20)),
    ops.create(box('b', 'row', 50, 20, extra)),
    ops.create(box('c', 'row', 50, 20))
  ]);
  const plain = solve(mk({}), M).rects;
  assert.equal(plain.b.x, 60);
  assert.equal(plain.c.x, 120);

  const doc = mk({ override: { x: 7, y: 9, w: 40, h: 30 } });
  const geo = solve(doc, M);
  assert.deepEqual(geo.rects.b, { x: 7, y: 9, w: 40, h: 30 }, 'абсолютно относительно родителя');
  assert.equal(geo.rects.c.x, 60, 'сосед занял место отсоединённого — тот не участвует в потоке');
  assert.equal(geo.rects.a.x, 0);
});

test('режим none: свободные pos и hug-размер по содержимому', () => {
  const doc = scene(() => [
    ops.create(frame('free', 'ab', { mode: 'none', padding: { t: 5, r: 5, b: 5, l: 5 } },
      { w: { mode: 'hug' }, h: { mode: 'hug' } })),
    ops.create(box('a', 'free', 40, 20, { pos: { x: 10, y: 60 } })),
    ops.create(box('b', 'free', 30, 10, { pos: { x: 100, y: 0 } }))
  ]);
  const geo = solve(doc, M);
  assert.deepEqual(geo.rects.a, { x: 15, y: 65, w: 40, h: 20 });
  assert.deepEqual(geo.rects.b, { x: 105, y: 5, w: 30, h: 10 });
  assert.equal(geo.rects.free.w, 140, 'padding.l + самый правый край + padding.r');
  assert.equal(geo.rects.free.h, 90);
});

test('артборды раскладываются независимо и размещаются по pos', () => {
  const doc = createDoc();
  const [a, b] = artboards(doc);
  const geo = solve(doc, M);
  assert.deepEqual(geo.rects[a.id], { x: 0, y: 0, w: 390, h: 844 });
  assert.equal(geo.rects[b.id].x, 470);
  const moved = applyOps(doc, [ops.set(a.id, 'pos', { x: -200, y: 30 })]).doc;
  const g2 = solve(moved, M);
  assert.equal(g2.rects[a.id].x, -200);
  assert.equal(hashGeometry({ rects: { [b.id]: g2.rects[b.id] }, lines: {}, order: [] }),
    hashGeometry({ rects: { [b.id]: geo.rects[b.id] }, lines: {}, order: [] }),
    'сдвиг одного артборда не трогает другой');
});

/* ------------------------------ валидаторы ------------------------------ */

test('validate: low-contrast по WCAG 2.1 с порогами 4.5 и 3', () => {
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 0.01);
  const mk = (color, style) => scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column' }, { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 100 } }, { fill: '#ffffff' })),
    ops.create(label('t', 'card', 'проверка контраста', { color, style, size: { w: { mode: 'fixed', value: 280 }, h: { mode: 'fixed', value: 80 } } }))
  ]);
  const low = validate(mk('#aaaaaa', { token: 'body' }), solve(mk('#aaaaaa', { token: 'body' }), M), M)
    .filter((v) => v.code === 'low-contrast');
  assert.equal(low.length, 1);
  assert.equal(low[0].nodeId, 't');
  assert.equal(low[0].severity, 'warn');
  assert.match(low[0].message, /контраст/);

  const ok = validate(mk('#14161C', { token: 'body' }), solve(mk('#14161C', { token: 'body' }), M), M);
  assert.equal(ok.filter((v) => v.code === 'low-contrast').length, 0);

  // крупный текст: порог 3 — серый #888 проходит (3.54), но не проходит для мелкого
  const bigStyle = { token: 'body', fontSize: 40, fontWeight: 700 };
  const big = validate(mk('#767676', bigStyle), solve(mk('#767676', bigStyle), M), M);
  assert.equal(big.filter((v) => v.code === 'low-contrast').length, 0, 'крупный текст судится по порогу 3');
  const small = validate(mk('#8a8a8a', { token: 'body' }), solve(mk('#8a8a8a', { token: 'body' }), M), M);
  assert.equal(small.filter((v) => v.code === 'low-contrast').length, 1);
});

test('validate: фон ищется по ближайшему предку с заливкой', () => {
  const doc = scene(() => [
    ops.create(frame('dark', 'ab', { mode: 'column' }, { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 80 } }, { fill: '#101010' })),
    ops.create(frame('inner', 'dark', { mode: 'column' }, { w: { mode: 'fixed', value: 180 }, h: { mode: 'fixed', value: 60 } })),
    ops.create(label('t', 'inner', 'тёмный фон', { color: '#111111', size: { w: { mode: 'fixed', value: 170 }, h: { mode: 'fixed', value: 40 } } }))
  ]);
  const v = validate(doc, solve(doc, M), M).filter((x) => x.code === 'low-contrast');
  assert.equal(v.length, 1, 'фон взят у деда, а не у холста');
  assert.match(v[0].message, /#101010/);
});

test('validate: overflow, out-of-parent, overlap, zero-size, empty-frame, off-scale', () => {
  const doc = scene(() => [
    ops.create(frame('box', 'ab', { mode: 'none', gap: 7 }, { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 30 } }, { fill: '#ffffff' })),
    // текст не помещается по высоте в 20 px при переносе на много строк
    ops.create(label('t', 'box', 'очень длинная строка которая точно не влезет в отведённое место', {
      size: { w: { mode: 'fixed', value: 80 }, h: { mode: 'fixed', value: 20 } }, pos: { x: 0, y: 0 }
    })),
    ops.create(box('wide', 'box', 400, 10, { pos: { x: 0, y: 5 } })),
    ops.create(box('zero', 'box', 0, 0, { pos: { x: 0, y: 0 } })),
    ops.create(frame('empty', 'ab', { mode: 'column', padding: { t: 3, r: 0, b: 0, l: 0 } },
      { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } }))
  ]);
  const geo = solve(doc, M);
  const v = validate(doc, geo, M);
  const codes = (c) => v.filter((x) => x.code === c);
  assert.equal(codes('overflow')[0].nodeId, 't');
  assert.equal(codes('overflow')[0].severity, 'error');
  assert.ok(codes('out-of-parent').some((x) => x.nodeId === 'wide'));
  assert.ok(codes('overlap').length >= 1, 'соседи в режиме none перекрываются');
  assert.ok(codes('overlap').every((x) => x.severity === 'warn'));
  assert.ok(codes('zero-size').some((x) => x.nodeId === 'zero'));
  assert.ok(codes('empty-frame').some((x) => x.nodeId === 'empty'));
  assert.ok(codes('off-scale').some((x) => x.nodeId === 'box'), 'gap 7 вне шкалы');
  assert.ok(codes('off-scale').some((x) => x.nodeId === 'empty'), 'padding 3 вне шкалы');
  for (const item of v) {
    assert.ok(['error', 'warn', 'info'].includes(item.severity));
    assert.equal(typeof item.message, 'string');
    assert.ok(doc.nodes[item.nodeId], 'нарушение указывает на существующий узел');
  }
  // отсортировано по важности
  const ranks = v.map((x) => ({ error: 0, warn: 1, info: 2 })[x.severity]);
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b));
});

test('validate: чистый макет не даёт нарушений', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 } },
      { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } }, { fill: '#ffffff' })),
    ops.create(label('t', 'card', 'всё хорошо', { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }))
  ]);
  assert.deepEqual(validate(doc, solve(doc, M), M).filter((v) => v.nodeId !== 'ab'), []);
});

/* --------------------------- стартовое содержимое --------------------------- */

test('createDoc(): два артборда с настоящим русским содержимым и без ошибок', () => {
  const doc = createDoc();
  const abs = artboards(doc);
  assert.equal(abs.length, 2);
  assert.equal(abs[0].name, 'Маршрут дня');
  assert.equal(abs[1].name, 'Сводка недели');
  assert.deepEqual(abs[0].size.w, { mode: 'fixed', value: 390 });
  assert.deepEqual(abs[1].size.w, { mode: 'fixed', value: 960 });

  const texts = Object.values(doc.nodes).filter((n) => n.type === 'text');
  assert.ok(texts.length >= 20, 'содержимое, а не рыба: ' + texts.length + ' текстовых узлов');
  assert.ok(texts.every((t) => t.characters.trim().length > 0));
  assert.ok(texts.some((t) => /[А-Яа-я]/.test(t.characters)), 'текст по-русски');
  assert.ok(texts.some((t) => t.characters === 'Добавить пункт'), 'кнопка «Добавить пункт»');
  assert.ok(texts.some((t) => /10:30/.test(t.characters)), 'время ближайшей встречи');
  assert.equal(texts.filter((t) => /^\d{2}:\d{2}$/.test(t.characters)).length, 3, 'три пункта со временем');

  assert.equal(doc.tokens.colors.accent, '#FF6B3D');
  assert.equal(doc.tokens.colors.canvas, '#F7F6F3');
  assert.ok(Array.isArray(doc.tokens.spacing) && doc.tokens.spacing.includes(16));

  const geo = solve(doc, M);
  for (const id of Object.keys(doc.nodes)) {
    if (id === doc.root) continue;
    assert.ok(geo.rects[id], 'у каждого узла есть прямоугольник: ' + id);
  }
  const problems = validate(doc, geo, M).filter((v) => v.severity === 'error');
  assert.deepEqual(problems, [], 'демо-документ проходит валидаторы');
  assert.equal(geo.order.length, Object.keys(doc.nodes).length - 1);
});

test('createDoc(seed) принимает готовый документ, createDoc("empty") — пустой', () => {
  const empty = createDoc('empty');
  assert.equal(Object.keys(empty.nodes).length, 1);
  assert.equal(artboards(empty).length, 0);
  const round = createDoc(JSON.parse(JSON.stringify(createDoc())));
  assert.equal(artboards(round).length, 2);
  assert.equal(hashGeometry(solve(round, M)), hashGeometry(solve(createDoc(JSON.parse(JSON.stringify(round))), M)));
});

test('решатель без canvas не падает и остаётся детерминированным', () => {
  const doc = createDoc();
  const a = hashGeometry(solve(doc));
  const b = hashGeometry(solve(doc));
  assert.equal(a, b);
  assert.notEqual(a, '0');
});

/* ------------------------ регрессии по ревью ------------------------ */

const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const fixed = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });
/** Прямоугольник без заливки — чтобы проверять set по отсутствующему ключу. */
const bare = (id, parent, w, h) => ({ type: 'rect', id, name: id, parent, size: fixed(w, h) });

test('applyOps: ошибка — объект {code, message}', () => {
  const doc = scene(() => [
    ops.create(box('a', 'ab', 10, 10)),
    ops.create(frame('card', 'ab', { mode: 'column' }, HUG)),
    ops.create(frame('in', 'card', { mode: 'none' }, HUG))
  ]);
  const cases = [
    [[ops.set('a', 'id', 'x')], 'protected-path', /защищён/],
    [[ops.set('нет', 'fill', '#000')], 'not-found', /не найден/],
    [[ops.remove('нет')], 'not-found', /не найден/],
    [[ops.create({ type: 'осьминог', id: 'z', parent: 'ab' })], 'bad-node', /неизвестный тип/],
    [[ops.create(box('n1', 'нет', 5, 5))], 'bad-parent', /родител/],
    [[ops.move('a', 'нет', 0)], 'bad-parent', /родител/],
    [[ops.move('ab', 'a', 0)], 'bad-parent', /не контейнер/],
    [[ops.move('card', 'in', 0)], 'cycle', /внутрь себя/],
    [[{ op: 'ерунда' }], 'bad-op', /неизвестная операция/],
    [[null], 'bad-op', /не объект/],
    [[ops.setToken('', 1)], 'bad-op', /пустой путь/]
  ];
  for (const [list, code, re] of cases) {
    const res = applyOps(doc, list);
    assert.ok(res.error && typeof res.error === 'object', 'error должен быть объектом: ' + code);
    assert.equal(typeof res.error.message, 'string');
    assert.equal(res.error.code, code, res.error.message);
    assert.match(res.error.message, re);
    assert.equal(res.doc, doc, 'документ не трогаем при ошибке');
  }
  assert.equal(applyOps(null, [ops.set('a', 'fill', '#000')]).error.code, 'not-found');
});

test('invertOps: set по вложенному пути восстанавливает прежнее значение', () => {
  const doc = scene(() => [
    ops.create(label('t', 'ab', 'Привет', { style: 'display' })),
    ops.create(box('b', 'ab', 10, 10, { fill: 'accent' })),
    ops.create(bare('c', 'ab', 10, 10))
  ]);
  const cases = [
    [ops.set('t', 'style.fontSize', 12), 't', 'скаляр style затирается объектом'],
    [ops.set('b', 'fill.token', 'surface'), 'b', 'скаляр fill затирается объектом'],
    [ops.set('c', 'fill.token', 'surface'), 'c', 'fill вовсе не было']
  ];
  for (const [op, id, why] of cases) {
    const inv = invertOps(doc, [op]);
    const after = applyOps(doc, [op]);
    assert.equal(after.error, undefined, JSON.stringify(after.error));
    const back = applyOps(after.doc, inv);
    assert.equal(back.error, undefined, JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes[id], doc.nodes[id], why);
    assert.equal(hashGeometry(solve(back.doc, M)), hashGeometry(solve(doc, M)), 'геометрия вернулась: ' + why);
  }
});

test('create с готовыми children не рвёт документ и отменяется целиком', () => {
  const doc = scene(() => [
    ops.create(box('a', 'ab', 10, 10)),
    ops.create(box('victim', 'ab', 20, 20)),
    ops.create(box('z', 'ab', 5, 5))
  ]);
  const tx = [ops.create(frame('wrap', 'ab', { mode: 'column' }, HUG, { children: ['victim'] }))];
  const after = applyOps(doc, tx);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.deepEqual(after.doc.nodes.ab.children, ['a', 'z', 'wrap'], 'ребёнок снят с прежнего родителя');
  assert.deepEqual(after.doc.nodes.wrap.children, ['victim']);
  assert.equal(after.doc.nodes.victim.parent, 'wrap');
  const geo = solve(after.doc, M);
  assert.equal(geo.order.filter((id) => id === 'victim').length, 1, 'узел размещается один раз');

  const back = applyOps(after.doc, invertOps(doc, tx));
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'отмена возвращает чужое поддерево на место');

  // вставка по индексу: чужой ребёнок возвращается на своё место, а не в начало
  const tx2 = [ops.create(frame('wrap2', 'ab', { mode: 'column' }, HUG, { children: ['victim'] }), 0)];
  const after2 = applyOps(doc, tx2);
  assert.equal(after2.error, undefined, JSON.stringify(after2.error));
  assert.deepEqual(after2.doc.nodes.ab.children, ['wrap2', 'a', 'z']);
  const back2 = applyOps(after2.doc, invertOps(doc, tx2));
  assert.equal(back2.error, undefined, JSON.stringify(back2.error));
  assert.deepEqual(back2.doc.nodes.ab.children, ['a', 'victim', 'z'], 'порядок соседей сохранён');
  assert.deepStrictEqual(back2.doc.nodes, doc.nodes);

  // перевешивание предка запрещено
  const cyc = applyOps(after.doc, [ops.create(frame('w2', 'wrap', { mode: 'none' }, HUG, { children: ['wrap'] }))]);
  assert.equal(cyc.error.code, 'cycle');
  const ghost = applyOps(doc, [ops.create(frame('w3', 'ab', { mode: 'none' }, HUG, { children: ['призрак'] }))]);
  assert.equal(ghost.error.code, 'bad-node');
  const twice = applyOps(doc, [ops.create(frame('w4', 'ab', { mode: 'none' }, HUG, { children: ['a', 'a'] }))]);
  assert.equal(twice.error.code, 'bad-node');
  const notBox = applyOps(doc, [ops.create({ ...box('w5', 'ab', 5, 5), children: ['a'] })]);
  assert.equal(notBox.error.code, 'bad-node', 'дети только у контейнера');
});

test('ops.create выдаёт id сразу — отмена удаляет созданный узел', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 10, 10))]);
  const op = ops.create({ type: 'rect', parent: 'ab', name: 'Новый', size: fixed(8, 8) });
  assert.ok(op.node && typeof op.node.id === 'string' && op.node.id, 'id выдан конструктором');
  const after = applyOps(doc, [op]);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.ok(after.doc.nodes[op.node.id], 'узел создан именно с этим id');
  const inv = invertOps(doc, [op]);
  assert.ok(inv.length, 'инверсия не пустая');
  const back = applyOps(after.doc, inv);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, doc.nodes);
});

test('solve и subtreeIds выдерживают цикл и глубокое дерево', () => {
  const cyclic = () => {
    const doc = createDoc('empty');
    const wrap = (id, parent, children) => ({
      type: 'frame', id, name: id, parent, children, size: HUG, pos: { x: 0, y: 0 },
      layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
    });
    doc.nodes.a = wrap('a', doc.root, ['b']);
    doc.nodes.b = wrap('b', 'a', ['a']);
    doc.nodes[doc.root].children.push('a');
    return doc;
  };
  const doc = cyclic();
  assert.doesNotThrow(() => solve(doc, M), 'solve не должен падать на цикле');
  assert.ok(subtreeIds(doc, 'a').length < 1000, 'subtreeIds завершается');

  const deep = createDoc('empty');
  let prev = deep.root;
  for (let i = 0; i < 2000; i++) {
    const id = 'd' + i;
    deep.nodes[id] = {
      type: 'frame', id, name: id, parent: prev, children: [], size: HUG, pos: { x: 0, y: 0 },
      layout: { mode: 'column', gap: 0, padding: { t: 1, r: 1, b: 1, l: 1 }, align: 'start', justify: 'start', wrap: false }
    };
    deep.nodes[prev].children.push(id);
    prev = id;
  }
  assert.doesNotThrow(() => solve(deep, M), 'solve не должен падать на глубине 2000');
  assert.ok(subtreeIds(deep, deep.root).length < 2100);
});

test('createDoc(seed) разрывает циклические и несходящиеся рёбра', () => {
  const seed = createDoc('empty');
  const wrap = (id, parent, children) => ({
    type: 'frame', id, name: id, parent, children, size: HUG, pos: { x: 0, y: 0 },
    layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
  });
  seed.nodes.a = wrap('a', seed.root, ['b', 'stray']);
  seed.nodes.b = wrap('b', 'a', ['a']);
  seed.nodes.stray = wrap('stray', seed.root, []); // числится ребёнком «a», а parent — корень
  seed.nodes[seed.root].children.push('a', 'stray');

  const doc = createDoc(JSON.parse(JSON.stringify(seed)));
  assert.ok(!doc.nodes.b.children.includes('a'), 'цикл разорван');
  assert.ok(!doc.nodes.a.children.includes('stray'), 'несходящееся ребро отброшено');
  assert.doesNotThrow(() => solve(doc, M));
  const geo = solve(doc, M);
  assert.equal(geo.order.filter((id) => id === 'a').length, 1);
});

test('resolveTarget: имя важнее роли, неоднозначность — null', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column' }, HUG, { name: 'Карточка встречи', role: 'card' })),
    ops.create(label('title', 'card', 'Планёрка', { name: 'Строка названия' })),
    ops.create(label('screenTitle', 'ab', 'Маршрут дня', { name: 'Заголовок экрана', role: 'title' })),
    ops.create(box('btn', 'ab', 100, 40, { name: 'Кнопка добавить', role: 'button' }))
  ]);
  assert.equal(resolveTarget(doc, 'title').id, 'title', 'id');
  assert.equal(resolveTarget(doc, 'Строка названия').id, 'title', 'точное имя важнее роли');
  assert.equal(resolveTarget(doc, 'строка названия').id, 'title', 'регистр не важен');
  assert.equal(resolveTarget(doc, 'Кнопка добавить').id, 'btn');
  assert.equal(resolveTarget(doc, 'кнопка').id, 'btn', 'частичное имя');
  assert.equal(resolveTarget(doc, 'карточка встречи').id, 'card');
  assert.equal(resolveTarget(doc, 'заголовок карточки'), null, 'две роли сразу — неоднозначно');
  assert.equal(resolveTarget(doc, 'ничего такого нет'), null);
});

test('resolveColor понимает {token} наравне со строкой', () => {
  const doc = createDoc('empty');
  assert.equal(resolveColor(doc, { token: 'surface' }), '#ffffff');
  assert.equal(resolveColor(doc, 'surface'), '#ffffff');
  assert.equal(resolveColor(doc, { color: 'accent' }), '#ff6b3d');
  assert.equal(resolveColor(doc, { value: '#ABC' }), '#aabbcc');
  assert.equal(resolveColor(doc, { token: 'нет-такого' }), null);
  assert.equal(resolveColor(doc, null), null);
});

test('setToken: отмена удаления сохраняет порядок ключей палитры', () => {
  const doc = createDoc('empty');
  const before = Object.keys(doc.tokens.colors);
  const tx = [ops.setToken('colors.accent', undefined)];
  const after = applyOps(doc, tx);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.equal(after.doc.tokens.colors.accent, undefined);
  const back = applyOps(after.doc, invertOps(doc, tx));
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepEqual(Object.keys(back.doc.tokens.colors), before, 'порядок свотчей не прыгает');
  assert.deepStrictEqual(back.doc.tokens, doc.tokens);
});

test('Stage: публичный контракт на месте, включая дешёвый setSelection', () => {
  for (const m of ['render', 'setSelection', 'fitTo', 'viewportRect', 'zoomAt', 'zoomBy', 'setZoom', 'toSVG', 'screenshot', 'destroy']) {
    assert.equal(typeof Stage.prototype[m], 'function', 'Stage.' + m);
  }
  assert.equal(Stage.prototype.setSelection.length, 1);
});

test('Stage: подпись артборда прячется на мелком зуме и обрезается по ширине', () => {
  const mk = (text, w) => {
    const el = {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; }
    };
    return { el, node: { nodeValue: text }, text, w };
  };
  const st = Object.create(Stage.prototype);
  st.view = { zoom: 1, pan: { x: 0, y: 0 } };
  const wide = mk('Маршрут дня', 360);
  const narrow = mk('Сводка недели за квартал', 90);
  st._labels = [wide, narrow];

  st._updateLabels();
  assert.equal(wide.el.attrs.display, undefined, 'на 100% подпись видна');
  assert.equal(wide.node.nodeValue, 'Маршрут дня', 'и целиком');
  assert.ok(narrow.node.nodeValue.endsWith('…'), 'узкому артборду подпись обрезана');
  assert.ok(narrow.node.nodeValue.length < narrow.text.length);

  st.view.zoom = 0.1;
  st._updateLabels();
  assert.equal(wide.el.attrs.display, 'none', 'на 10% подписи не рисуются — иначе каша');
  assert.equal(narrow.el.attrs.display, 'none');
  assert.equal(wide.el.attrs['font-size'], '110', 'кегль компенсирует зум');

  st.view.zoom = 4;
  st._updateLabels();
  assert.equal(wide.el.attrs.display, undefined, 'вблизи подпись возвращается');
  assert.equal(narrow.node.nodeValue, narrow.text, 'и текст восстанавливается целиком');
  assert.equal(narrow.el.attrs['font-size'], '2.75');
});

/* --------------------- property-тест отмены --------------------- */

/** mulberry32 — воспроизводимый ГПСЧ с фиксированным сидом. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: любая пятёрка операций отменяется точно (400 прогонов)', () => {
  const rnd = mulberry32(20260923);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const SET_CASES = [
    ['fill', () => pick(['#ff0000', 'accent', 'surface', { token: 'surfaceAlt' }])],
    ['fill.token', () => pick(['surface', 'accent'])],
    ['radius', () => pick([0, 4, 12])],
    ['opacity', () => pick([1, 0.5])],
    ['name', () => pick(['Алиса', 'Боб'])],
    ['style', () => pick(['display', 'caption', { token: 'body', fontSize: 12 }])],
    ['style.fontSize', () => pick([11, 18, 24])],
    ['size.w', () => pick([{ mode: 'hug' }, { mode: 'fill' }, { mode: 'fixed', value: 60 }])],
    ['size', () => ({ w: { mode: 'fixed', value: 80 }, h: { mode: 'hug' } })],
    ['layout.gap', () => pick([0, 8, 16])],
    ['layout', () => ({ mode: 'row', gap: 4, padding: { t: 2, r: 2, b: 2, l: 2 }, align: 'center', justify: 'start', wrap: false })],
    ['pos', () => ({ x: 10, y: 20 })],
    ['characters', () => pick(['Короткий', 'Очень длинный текст, который придётся переносить'])],
    ['color', () => pick(['muted', '#123456'])]
  ];
  const TOKEN_CASES = [
    ['colors.accent', () => pick(['#0000ff', undefined])],
    ['colors.surface', () => '#eeeeee'],
    ['type.body.fontSize', () => pick([13, 17])],
    ['spacing', () => [0, 4, 8, 16]]
  ];
  let seq = 0;
  const genOp = (d) => {
    const ids = Object.keys(d.nodes);
    const containers = ids.filter((id) => d.nodes[id].type === 'frame' || d.nodes[id].type === 'page');
    const notRoot = ids.filter((id) => id !== d.root);
    const roll = rnd();
    if (roll < 0.42) {
      const [path, val] = pick(SET_CASES);
      return ops.set(pick(ids), path, val());
    }
    if (roll < 0.60) return ops.move(pick(notRoot), pick(containers), Math.floor(rnd() * 4));
    if (roll < 0.82) {
      const parent = pick(containers);
      const id = 'g' + (seq++);
      const kind = rnd();
      if (kind < 0.34) {
        return ops.create({ type: 'rect', id, name: 'Новый ' + id, parent, fill: '#00ff00', radius: 4, size: fixed(12, 12) }, Math.floor(rnd() * 3));
      }
      if (kind < 0.67) {
        return ops.create({ type: 'text', id, name: 'Текст ' + id, parent, characters: 'мяу мяу', style: { token: 'body' }, color: 'text', size: HUG });
      }
      return ops.create({
        type: 'frame', id, name: 'Обёртка ' + id, parent, children: [...new Set([pick(notRoot), pick(notRoot)])], size: HUG,
        layout: { mode: 'column', gap: 4, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
      }, rnd() < 0.5 ? Math.floor(rnd() * 4) : undefined);
    }
    if (roll < 0.92) return ops.remove(pick(notRoot));
    const [path, val] = pick(TOKEN_CASES);
    return ops.setToken(path, val());
  };

  let applied = 0;
  for (let run = 0; run < 400; run++) {
    const doc = scene(() => [
      ops.create(frame('card', 'ab', { mode: 'column', gap: 6, padding: { t: 8, r: 8, b: 8, l: 8 } }, fixed(200, 120))),
      ops.create(label('t1', 'card', 'Первый текст', { style: 'heading' })),
      ops.create(label('t2', 'card', 'Второй текст')),
      ops.create(frame('inner', 'card', { mode: 'row', gap: 4 }, { w: { mode: 'fill' }, h: { mode: 'hug' } })),
      ops.create(box('bx', 'inner', 20, 20)),
      ops.create(box('by', 'inner', 30, 10, { fill: 'accent' })),
      ops.create(box('tail', 'ab', 40, 40))
    ]);
    const tx = [];
    let cur = doc;
    for (let guard = 0; tx.length < 5 && guard < 60; guard++) {
      const op = genOp(cur);
      const step = applyOps(cur, [op]);
      if (step.error) continue;
      tx.push(op);
      cur = step.doc;
      applied++;
    }
    if (tx.length < 5) continue;

    const after = applyOps(doc, tx);
    assert.equal(after.error, undefined, 'прогон ' + run + ': ' + JSON.stringify(after.error));
    const back = applyOps(after.doc, invertOps(doc, tx));
    assert.equal(back.error, undefined, 'прогон ' + run + ': ' + JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'прогон ' + run + ': узлы восстановлены\n' + JSON.stringify(tx));
    assert.deepStrictEqual(back.doc.tokens, doc.tokens, 'прогон ' + run + ': токены восстановлены');
    assert.equal(
      hashGeometry(solve(back.doc, M)), hashGeometry(solve(doc, M)),
      'прогон ' + run + ': геометрия восстановлена\n' + JSON.stringify(tx)
    );
  }
  assert.ok(applied >= 1800, 'операции должны в основном применяться, а не отбраковываться: ' + applied);
});

/* ------------------- второй круг приёмки: точечные дефекты ------------------- */

test('resolveTarget: неоднозначная роль не обрывает поиск по содержимому', () => {
  const doc = createDoc();
  // «макет» попадает в роль artboard, артбордов два — раньше это коротило поиск
  const hit = resolveTarget(doc, 'Планёрка по редактору макетов');
  assert.ok(hit, 'узел с таким текстом обязан находиться');
  assert.equal(hit.type, 'text');
  assert.equal(hit.characters, 'Планёрка по редактору макетов');
  assert.equal(resolveTarget(doc, 'переговорная «Север»').name, 'Время и место', 'вхождение в текст');

  // прежние разумные случаи не поехали
  assert.equal(resolveTarget(doc, 'карточка').name, 'Карточка встречи');
  assert.equal(resolveTarget(doc, 'кнопка').name, 'Кнопка «Добавить пункт»');
  assert.equal(resolveTarget(doc, 'Маршрут дня').role, 'artboard');
  assert.equal(resolveTarget(doc, 'заголовок'), null, 'два заголовка — неоднозначно');
  assert.equal(resolveTarget(doc, 'артборд'), null, 'два артборда — неоднозначно');
  assert.equal(resolveTarget(doc, 'метрика'), null, 'четыре показателя — неоднозначно');
  assert.equal(resolveTarget(doc, 'ничего такого нет'), null);
});

test('resolveTarget: роль важнее текста, но уступает ему при неоднозначности', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column' }, HUG, { name: 'Карточка встречи', role: 'card' })),
    ops.create(label('title', 'card', 'Планёрка по редактору макетов', { name: 'Строка названия' })),
    ops.create(frame('ab2', 'ab', { mode: 'column' }, HUG, { name: 'Второй экран', role: 'artboard' })),
    ops.create(frame('ab3', 'ab', { mode: 'column' }, HUG, { name: 'Третий экран', role: 'artboard' })),
    ops.create(frame('act', 'ab', { mode: 'column' }, HUG, { name: 'Действие', role: 'button' })),
    ops.create(label('note', 'ab', 'Обычная заметка', { name: 'Заметка' })),
    ops.create(label('hint', 'ab', 'кнопка тут', { name: 'Подсказка' }))
  ]);
  assert.equal(resolveTarget(doc, 'Строка названия').id, 'title', 'точное имя важнее роли');
  assert.equal(resolveTarget(doc, 'кнопка').id, 'act', 'однозначная роль важнее текста');
  assert.equal(resolveTarget(doc, 'Планёрка по редактору макетов').id, 'title', 'текст, хотя «макет» — роль двух узлов');
  assert.equal(resolveTarget(doc, 'заголовок карточки'), null, 'две роли сразу — неоднозначно');
  assert.equal(resolveTarget(doc, 'Обычная заметка').id, 'note', 'точное совпадение текста');
});

test('createDoc(seed): висячие сироты удаляются вместе с поддеревом', () => {
  const seed = createDoc('empty');
  const wrap = (id, parent, children) => ({
    type: 'frame', id, name: id, parent, children, size: HUG, pos: { x: 0, y: 0 },
    layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
  });
  seed.nodes.orphan = wrap('orphan', 'НЕТ_ТАКОГО', ['kid']);   // parent в никуда, ни у кого в children
  seed.nodes.kid = wrap('kid', 'orphan', []);
  seed.nodes.loose = wrap('loose', seed.root, []);             // parent верный, но родитель его не числит
  seed.nodes.live = wrap('live', seed.root, []);
  seed.nodes[seed.root].children.push('live');

  const doc = createDoc(JSON.parse(JSON.stringify(seed)));
  assert.equal(doc.nodes.orphan, undefined, 'сирота убрана');
  assert.equal(doc.nodes.kid, undefined, 'поддерево сироты убрано');
  assert.equal(doc.nodes.loose, undefined, 'недостижимый узел убран');
  assert.ok(doc.nodes.live, 'живой узел на месте');
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (id === doc.root) continue;
    const parent = doc.nodes[n.parent];
    assert.ok(parent, `у «${id}» родитель «${n.parent}» существует`);
    assert.ok((parent.children || []).includes(id), `«${id}» числится у своего родителя`);
  }
  assert.doesNotThrow(() => solve(doc, M));
});

test('createDoc(): демо-документ переживает нормализацию без потерь', () => {
  const demo = createDoc();
  const again = createDoc(JSON.parse(JSON.stringify(demo)));
  assert.deepEqual(Object.keys(again.nodes).sort(), Object.keys(demo.nodes).sort(), 'ни один узел не потерян');
});

test('сырой {op:"create"} без id отменяется в любом порядке вызовов', () => {
  const rawCreate = (name) => ({
    op: 'create',
    node: {
      type: 'rect', name, parent: 'ab', fill: '#00ff00', radius: 0,
      size: { w: { mode: 'fixed', value: 20 }, h: { mode: 'fixed', value: 20 } }
    }
  });
  const doc = scene(() => [ops.create(box('a', 'ab', 10, 10))]);

  // сначала применили, потом спросили инверсию
  const raw = rawCreate('Сырой');
  const after = applyOps(doc, [raw]);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.ok(raw.node.id, 'applyOps проставил id в самой операции');
  const created = Object.keys(after.doc.nodes).filter((id) => !doc.nodes[id]);
  assert.deepEqual(created, [raw.node.id], 'в документ попал именно этот id');
  const inv = invertOps(doc, [raw]);
  assert.ok(inv.length, 'инверсия не пустая');
  const back = applyOps(after.doc, inv);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'документ восстановлен');

  // и наоборот: инверсию взяли до применения
  const raw2 = rawCreate('Сырой второй');
  const inv2 = invertOps(doc, [raw2]);
  const after2 = applyOps(doc, [raw2]);
  assert.equal(after2.error, undefined, JSON.stringify(after2.error));
  const back2 = applyOps(after2.doc, inv2);
  assert.equal(back2.error, undefined, JSON.stringify(back2.error));
  assert.deepStrictEqual(back2.doc.nodes, doc.nodes, 'документ восстановлен');
});

/** Ненастоящая сцена: прототип Stage с подменёнными отрисовкой и размерами. */
function bareStage({ vw = 1000, vh = 800, rects = {}, box: bb } = {}) {
  const st = Object.create(Stage.prototype);
  const rect = bb || { left: 24, top: 56, width: vw, height: vh };
  st.el = { clientWidth: vw, clientHeight: vh, getBoundingClientRect: () => rect };
  st.opts = {};
  st.doc = null;
  st.geo = { rects, lines: {}, order: [] };
  st.view = { zoom: 1, pan: { x: 0, y: 0 } };
  st._applyView = () => {};
  st._paintUI = () => {};
  return st;
}

test('Stage.fitTo: старый вызов работает, inset и maxZoom учитываются', () => {
  const rects = { big: { x: 0, y: 0, w: 2000, h: 1000 }, tiny: { x: 500, y: 400, w: 20, h: 10 } };

  // старый вызов: вписывание с отступом 48 в весь холст
  const a = bareStage({ rects });
  a.fitTo(['big']);
  assert.ok(Math.abs(a.view.zoom - (1000 - 96) / 2000) < 1e-6, 'зум по ширине: ' + a.view.zoom);
  const ac = a.toScreen(1000, 500);
  assert.ok(Math.abs(ac.x - 500) < 0.5 && Math.abs(ac.y - 400) < 0.5, 'центр холста');

  // inset снизу: док не должен срезать низ макета
  const b = bareStage({ rects });
  b.fitTo(['big'], { inset: { bottom: 150 } });
  const bt = b.toScreen(0, 0);
  const bb2 = b.toScreen(2000, 1000);
  assert.ok(bt.y >= -0.5, 'верх не уехал за холст');
  assert.ok(bb2.y <= 650.5, 'низ макета выше дока: ' + bb2.y);
  assert.ok(Math.abs((bt.y + bb2.y) / 2 - 325) < 0.5, 'центр свободной области');

  // inset слева (панель слоёв)
  const c = bareStage({ rects });
  c.fitTo(['big'], { inset: { left: 260 } });
  const ct = c.toScreen(0, 0);
  const cr = c.toScreen(2000, 1000);
  assert.ok(ct.x >= 259.5, 'левый край правее панели: ' + ct.x);
  assert.ok(Math.abs((ct.x + cr.x) / 2 - 630) < 0.5, 'центр свободной области по X');

  // maxZoom: одинокий мелкий узел не раздувается
  const d = bareStage({ rects });
  d.fitTo(['tiny']);
  assert.equal(d.view.zoom, 2, 'по умолчанию не ближе 2×');
  const dc = d.toScreen(510, 405);
  assert.ok(Math.abs(dc.x - 500) < 0.5 && Math.abs(dc.y - 400) < 0.5, 'узел по центру');
  const e = bareStage({ rects });
  e.fitTo(['tiny'], { maxZoom: 1 });
  assert.equal(e.view.zoom, 1);
  const f = bareStage({ rects });
  f.fitTo(['tiny'], { maxZoom: 99 });
  assert.equal(f.view.zoom, 6, 'жёсткий потолок зума на месте');

  // padding
  const g = bareStage({ rects: { sq: { x: 0, y: 0, w: 1000, h: 800 } } });
  g.fitTo(['sq'], { padding: 0 });
  assert.equal(g.view.zoom, 1);

  // мусор в аргументах не ломает вид
  const h = bareStage({ rects });
  h.fitTo(['нет-такого']);
  assert.equal(h.view.zoom, 1);
  assert.deepEqual(h.view.pan, { x: 0, y: 0 });
  const i = bareStage({ rects });
  assert.doesNotThrow(() => i.fitTo(['big'], { padding: 'ой', inset: null, maxZoom: NaN }));
  assert.ok(i.view.zoom > 0 && i.view.zoom <= 2);
});

test('Stage.viewportRect: видимая область холста в координатах окна', () => {
  const st = bareStage({ vw: 900, vh: 600, box: { left: 24, top: 56, width: 900, height: 600 } });
  const r = st.viewportRect();
  assert.deepEqual(r, { x: 24, y: 56, w: 900, h: 600 });
  // накладку оболочки можно обрезать: экранная точка = viewportRect + toScreen
  st.view = { zoom: 2, pan: { x: 10, y: 20 } };
  const p = st.toScreen(100, 50);
  assert.deepEqual({ x: r.x + p.x, y: r.y + p.y }, { x: 24 + 210, y: 56 + 120 });
});

test('property: сырые операции без фабрики отменяются точно (500 прогонов)', () => {
  const rnd = mulberry32(20260924);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const SET_CASES = [
    ['fill', () => pick(['#ff0000', 'accent', 'surface'])],
    ['radius', () => pick([0, 4, 12])],
    ['opacity', () => pick([1, 0.5])],
    ['name', () => pick(['Алиса', 'Боб'])],
    ['style.fontSize', () => pick([11, 18, 24])],
    ['size.w', () => pick([{ mode: 'hug' }, { mode: 'fill' }, { mode: 'fixed', value: 60 }])],
    ['layout.gap', () => pick([0, 8, 16])],
    ['pos', () => ({ x: 10, y: 20 })],
    ['characters', () => pick(['Короткий', 'Очень длинный текст, который придётся переносить'])],
    ['color', () => pick(['muted', '#123456'])]
  ];
  const TOKEN_CASES = [
    ['colors.accent', () => pick(['#0000ff', undefined])],
    ['type.body.fontSize', () => pick([13, 17])],
    ['spacing', () => [0, 4, 8, 16]]
  ];
  let seq = 0;
  /** Операции собираются вручную, минуя ops.* — ни одного вызова фабрики. */
  const genOp = (d) => {
    const ids = Object.keys(d.nodes);
    const containers = ids.filter((id) => d.nodes[id].type === 'frame' || d.nodes[id].type === 'page');
    const notRoot = ids.filter((id) => id !== d.root);
    const roll = rnd();
    if (roll < 0.40) {
      const [path, val] = pick(SET_CASES);
      return { op: 'set', id: pick(ids), path, value: val() };
    }
    if (roll < 0.56) return { op: 'move', id: pick(notRoot), parent: pick(containers), index: Math.floor(rnd() * 4) };
    if (roll < 0.84) {
      const parent = pick(containers);
      const kind = rnd();
      // id проставляем лишь изредка: главный случай — сырая операция вовсе без id
      const withId = rnd() < 0.2 ? { id: 'raw' + (seq++) } : {};
      const index = rnd() < 0.5 ? { index: Math.floor(rnd() * 3) } : {};
      if (kind < 0.34) {
        return { op: 'create', node: { ...withId, type: 'rect', name: 'Сырой прямоугольник', parent, fill: '#00ff00', radius: 4, size: fixed(12, 12) }, ...index };
      }
      if (kind < 0.67) {
        return { op: 'create', node: { ...withId, type: 'text', name: 'Сырой текст', parent, characters: 'мяу мяу', style: { token: 'body' }, color: 'text', size: HUG }, ...index };
      }
      return {
        op: 'create',
        node: {
          ...withId, type: 'frame', name: 'Сырая обёртка', parent, size: HUG,
          children: [...new Set([pick(notRoot), pick(notRoot)])],
          layout: { mode: 'column', gap: 4, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
        },
        ...index
      };
    }
    if (roll < 0.93) return { op: 'remove', id: pick(notRoot) };
    const [path, val] = pick(TOKEN_CASES);
    return { op: 'setToken', path, value: val() };
  };

  let applied = 0;
  let inverseFirst = 0;
  for (let run = 0; run < 500; run++) {
    const doc = scene(() => [
      ops.create(frame('card', 'ab', { mode: 'column', gap: 6, padding: { t: 8, r: 8, b: 8, l: 8 } }, fixed(200, 120))),
      ops.create(label('t1', 'card', 'Первый текст', { style: 'heading' })),
      ops.create(label('t2', 'card', 'Второй текст')),
      ops.create(frame('inner', 'card', { mode: 'row', gap: 4 }, { w: { mode: 'fill' }, h: { mode: 'hug' } })),
      ops.create(box('bx', 'inner', 20, 20)),
      ops.create(box('by', 'inner', 30, 10, { fill: 'accent' })),
      ops.create(box('tail', 'ab', 40, 40))
    ]);
    const tx = [];
    let cur = doc;
    for (let guard = 0; tx.length < 5 && guard < 60; guard++) {
      const op = genOp(cur);
      const step = applyOps(cur, [op]);
      if (step.error) continue;
      tx.push(op);
      cur = step.doc;
      applied++;
    }
    if (tx.length < 5) continue;

    // половину прогонов спрашиваем инверсию ДО применения — оба порядка обязаны совпадать
    const before = run % 2 === 0;
    if (before) inverseFirst++;
    const inv = before ? invertOps(doc, tx) : null;
    const after = applyOps(doc, tx);
    assert.equal(after.error, undefined, 'прогон ' + run + ': ' + JSON.stringify(after.error));
    const undo = inv || invertOps(doc, tx);
    const back = applyOps(after.doc, undo);
    assert.equal(back.error, undefined, 'прогон ' + run + ': ' + JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'прогон ' + run + ': узлы восстановлены\n' + JSON.stringify(tx));
    assert.deepStrictEqual(back.doc.tokens, doc.tokens, 'прогон ' + run + ': токены восстановлены');
    assert.equal(
      hashGeometry(solve(back.doc, M)), hashGeometry(solve(doc, M)),
      'прогон ' + run + ': геометрия восстановлена\n' + JSON.stringify(tx)
    );
  }
  assert.ok(applied >= 2200, 'сырые операции должны в основном применяться: ' + applied);
  assert.ok(inverseFirst >= 200, 'оба порядка вызовов проверены: ' + inverseFirst);
});

/* ------------------- третий круг приёмки: точечные дефекты ------------------- */

test('wrap + align:stretch: поперечник строки не схлопывается в ноль', () => {
  const wide = { w: { mode: 'fixed', value: 200 }, h: { mode: 'hug' } };
  const mk = (align) => scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 0, wrap: true, align },
      { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } })),
    ops.create(label('a', 'row', 'Первый показатель', { size: wide })),
    ops.create(label('b', 'row', 'Второй показатель', { size: wide }))
  ]);
  const start = solve(mk('start'), M).rects;
  assert.ok(start.a.h > 0, 'высота первого ряда: ' + start.a.h);
  assert.equal(start.b.y, start.a.y + start.a.h, 'дети разложены в две строки');
  for (const align of ['start', 'center', 'end', 'stretch']) {
    const r = solve(mk(align), M).rects;
    assert.equal(r.a.h, start.a.h, `align:${align} — высота первого не должна обнуляться`);
    assert.equal(r.b.h, start.b.h, `align:${align} — высота второго не должна обнуляться`);
    assert.equal(r.row.h, start.row.h, `align:${align} — высота фрейма сохранена`);
  }
});

test('wrap + stretch: у каждой строки свой поперечник', () => {
  const hugCol = (id, h) => [
    ops.create(frame(id, 'row', { mode: 'column' }, { w: { mode: 'fixed', value: 140 }, h: { mode: 'hug' } })),
    ops.create(box(id + '1', id, 20, h))
  ];
  const doc = scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 10, wrap: true, align: 'stretch' },
      { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } })),
    ops.create(box('a', 'row', 140, 30)),
    ...hugCol('b', 60),
    ops.create(box('c', 'row', 140, 20)),
    ...hugCol('d', 12)
  ]);
  const r = solve(doc, M).rects;
  assert.equal(r.a.h, 30, 'fixed по поперечнику остаётся собой');
  assert.equal(r.b.h, 60, 'растянутый получает поперечник своей строки');
  assert.equal(r.b.y, r.a.y, 'a и b — одна строка');
  assert.equal(r.c.y, r.a.y + 60 + 10, 'вторая строка ниже первой на её высоту и gap');
  assert.equal(r.d.h, 20, 'во второй строке поперечник свой (20), а не наследованный (60)');
  assert.equal(r.row.h, 60 + 10 + 20, 'высота фрейма — сумма строк');
});

test('wrap + stretch: вложенный wrap не теряет высоту', () => {
  const inner = (id) => [
    ops.create(frame(id, 'outer', { mode: 'row', gap: 4, wrap: true, align: 'stretch' },
      { w: { mode: 'fixed', value: 120 }, h: { mode: 'hug' } })),
    ops.create(box(id + '1', id, 70, 18)),
    ops.create(box(id + '2', id, 70, 24))
  ];
  const doc = scene(() => [
    ops.create(frame('outer', 'ab', { mode: 'row', gap: 8, wrap: true, align: 'stretch' },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'hug' } })),
    ...inner('p'),
    ...inner('q')
  ]);
  const r = solve(doc, M).rects;
  for (const id of ['p', 'q', 'p1', 'p2', 'q1', 'q2']) {
    assert.ok(r[id].h > 0, `${id} не должен быть нулевой высоты, получили ${r[id].h}`);
  }
  assert.equal(r.p.h, 18 + 4 + 24, 'внутренний wrap: две строки + gap');
  assert.equal(r.q.y, r.p.y + r.p.h + 8, 'внешний wrap положил второй ниже');
});

test('сетка карточек агента (wrap + stretch) остаётся живой и без нарушений', () => {
  const card = (id) => [
    ops.create(frame(id, 'grid', { mode: 'column', gap: 4, padding: { t: 12, r: 12, b: 12, l: 12 } },
      { w: { mode: 'fixed', value: 180 }, h: { mode: 'hug' } }, { fill: '#ffffff' })),
    ops.create(label(id + 'k', id, 'Задач закрыто', { color: '#5B6270' })),
    ops.create(label(id + 'v', id, '48', { style: { token: 'title' } }))
  ];
  const doc = scene(() => [
    ops.create(frame('grid', 'ab', { mode: 'row', gap: 12, wrap: true, align: 'stretch' },
      { w: { mode: 'fixed', value: 380 }, h: { mode: 'hug' } }, { fill: '#ffffff' })),
    ...card('m1'), ...card('m2'), ...card('m3'), ...card('m4')
  ]);
  const geo = solve(doc, M);
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    assert.ok(geo.rects[id].h > 40, `карточка ${id} должна быть высотой по содержимому, а не ${geo.rects[id].h}`);
  }
  assert.equal(geo.rects.m3.y, geo.rects.m1.y + geo.rects.m1.h + 12, 'третья карточка — во второй строке');
  const bad = validate(doc, geo, M).filter((v) => v.code === 'zero-size' || v.code === 'overflow' || v.code === 'out-of-parent');
  assert.deepEqual(bad, [], 'сетка не должна давать нарушений: ' + JSON.stringify(bad));
});

/** Сцена, которой можно звать render(): отрисовка и слой интерфейса подменены. */
function renderStage(rects, doc) {
  const st = bareStage({ rects });
  st.doc = doc;
  st.state = { selection: [] };
  st.activeArtboard = null;
  st._prevRects = {};
  st._nodeEls = new Map();
  st._guides = [];
  st._labels = [];
  st.errors = [];
  st.opts = { onError: (info) => st.errors.push(info.where) };
  st.el.focus = () => {};
  st.el.classList = { add() {}, remove() {} };
  st._renderSVG = () => {};
  st._flip = () => {};
  return st;
}

/** Поддельный элемент SVG-группы: помнит атрибуты. */
function fakeEl() {
  return {
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; }
  };
}

test('Stage.render посреди жеста: устаревший жест снимается, а не коммитит прыжок', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 100, 40))]);
  const before = { ab: { x: 0, y: 0, w: 400, h: 200 }, a: { x: 0, y: 96, w: 100, h: 40 } };
  const st = renderStage(before, doc);
  const ghost = fakeEl();
  ghost.setAttribute('transform', 'translate(0 10)');
  st._ghostEl = ghost;
  st._drag = { mode: 'move', id: 'a', start: { x: 0, y: 96 }, rect0: { ...before.a }, result: { kind: 'override', x: 0, y: 106 } };
  st._guides = [{ x1: 0, y1: 0, x2: 1, y2: 1 }];

  // транзакция агента вставила выше блок высотой 200 — узел уехал под рукой
  const after = { ab: { x: 0, y: 0, w: 400, h: 400 }, a: { x: 0, y: 296, w: 100, h: 40 } };
  st.render(doc, { rects: after, lines: {}, order: [] }, {});
  assert.equal(st._drag, null, 'жест снят');
  assert.deepEqual(st._guides, [], 'направляющие убраны');
  assert.equal(ghost.attrs.transform, undefined, 'призрак вернулся на место');
  assert.deepEqual(st.errors, [], 'без ошибок отрисовки');

  const committed = [];
  st._commit = (list, label) => committed.push(label);
  st._onPointerUp({ clientX: 10, clientY: 10, pointerId: 1 });
  assert.deepEqual(committed, [], 'после отмены жеста ничего не коммитится');

  // геометрия не менялась — жест продолжается
  const keep = renderStage(before, doc);
  keep._drag = { mode: 'move', id: 'a', start: { x: 0, y: 96 }, rect0: { ...before.a }, result: { kind: 'override', x: 0, y: 106 } };
  keep.render(doc, { rects: { ...before }, lines: {}, order: [] }, {});
  assert.ok(keep._drag, 'жест при неизменной геометрии сохраняется');

  // панорама к геометрии узлов не привязана — её не трогаем
  const pan = renderStage(before, doc);
  pan._drag = { mode: 'pan', sx: 0, sy: 0, pan: { x: 0, y: 0 } };
  pan.render(doc, { rects: after, lines: {}, order: [] }, {});
  assert.ok(pan._drag, 'панорама продолжается');
});

test('Stage.render: инлайн-редактор закрывается, если его узел исчез', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 100, 40))]);
  const rects = { ab: { x: 0, y: 0, w: 400, h: 200 }, a: { x: 0, y: 0, w: 100, h: 40 } };
  const st = renderStage(rects, doc);
  const el = { parentNode: null };
  el.parentNode = { removeChild: () => { el.parentNode = null; } };
  st._editing = { id: 'a', el, original: 'было' };
  const gone = applyOps(doc, [ops.remove('a')]);
  assert.equal(gone.error, undefined);
  st.render(gone.doc, { rects: { ab: rects.ab }, lines: {}, order: [] }, {});
  assert.equal(st._editing, null, 'редактор закрыт вместе с узлом');
  assert.equal(el.parentNode, null, 'элемент редактора снят со страницы');
  assert.deepEqual(st.errors, []);
});

/** Поддельный DOM для screenshot(): canvas с пределами, Image и URL. */
function withFakeDom(cfg, fn) {
  const had = { document: globalThis.document, Image: globalThis.Image };
  const hadUrl = { c: URL.createObjectURL, r: URL.revokeObjectURL };
  const made = [];
  const side = cfg.maxSide === undefined ? 65535 : cfg.maxSide;
  const area = cfg.maxArea === undefined ? 268435456 : cfg.maxArea;
  globalThis.document = {
    createElement(name) {
      if (name !== 'canvas') return {};
      const c = {
        width: 0, height: 0,
        getContext: () => ({ fillStyle: '', fillRect() {}, drawImage() {} }),
        toBlob(cb) {
          const over = c.width > side || c.height > side || c.width * c.height > area;
          cb(over || cfg.blobNull ? null : new Blob([new Uint8Array(32)], { type: 'image/png' }));
        }
      };
      made.push(c);
      return c;
    }
  };
  globalThis.Image = class {
    set src(v) { this._src = v; if (cfg.imgFail) setTimeout(() => this.onerror && this.onerror(new Error('нет картинки')), 0); else setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return this._src; }
  };
  URL.createObjectURL = () => 'blob:поддельный';
  URL.revokeObjectURL = () => {};
  const restore = () => {
    globalThis.document = had.document;
    globalThis.Image = had.Image;
    URL.createObjectURL = hadUrl.c;
    URL.revokeObjectURL = hadUrl.r;
  };
  return Promise.resolve()
    .then(() => fn(made))
    .then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

/** Сцена для screenshot(): один артборд заданного размера. */
function shotStage(w, h) {
  const st = Object.create(Stage.prototype);
  st.opts = { onError: (i) => st.errors.push(i.where) };
  st.errors = [];
  st.activeArtboard = 'ab';
  st.geo = { rects: { ab: { x: 0, y: 0, w, h } }, lines: {}, order: ['ab'] };
  st.toSVG = () => '<svg xmlns="http://www.w3.org/2000/svg"/>';
  return st;
}

test('screenshot(): масштаб понижается сам, а провал не выдаётся за успех', async () => {
  // 1200×30000 при 2× влезает — отдаём как просили
  await withFakeDom({}, async (made) => {
    const st = shotStage(1200, 30000);
    const blob = await st.screenshot({ scale: 2 });
    assert.ok(blob && blob.size > 0, 'должен быть непустой PNG');
    assert.deepEqual([made[0].width, made[0].height], [2400, 60000]);
    assert.deepEqual(st.errors, [], 'без ошибок');
  });

  // 1200×46000 при 2× не влезает по стороне — масштаб сам падает до 1×
  await withFakeDom({}, async (made) => {
    const st = shotStage(1200, 46000);
    const blob = await st.screenshot({ scale: 2 });
    assert.ok(blob && blob.size > 0, 'понижение масштаба должно дать настоящий PNG');
    assert.deepEqual([made[0].width, made[0].height], [1200, 46000], 'полотно уже создано в 1×');
    assert.equal(st.lastShot.scale, 1);
    assert.equal(st.lastShot.requested, 2);
    assert.deepEqual(st.errors, [], 'понижение масштаба — не ошибка');
  });

  // артборд, который не влезает даже в минимальном масштабе
  await withFakeDom({}, async () => {
    const st = shotStage(4e6, 4e6);
    const blob = await st.screenshot({ scale: 2 });
    assert.equal(blob, null, 'вместо пустого файла — null');
    assert.deepEqual(st.errors, ['screenshot:size']);
  });

  // toBlob вернул null: это провал, а не «сохранено»
  await withFakeDom({ blobNull: true }, async () => {
    const st = shotStage(400, 600);
    const blob = await st.screenshot({ scale: 2 });
    assert.equal(blob, null, 'пустой blob наружу не уходит');
    assert.equal(st.errors.length, 1, 'об этом сообщено: ' + JSON.stringify(st.errors));
  });

  // картинка не загрузилась — тоже null, а не белый лист
  await withFakeDom({ imgFail: true }, async () => {
    const st = shotStage(400, 600);
    const blob = await st.screenshot({ scale: 2 });
    assert.equal(blob, null);
    assert.deepEqual(st.errors, ['screenshot:image']);
  });

  // ограничение площади: масштаб подбирается плавно
  await withFakeDom({ maxSide: 10000, maxArea: 4e6 }, async (made) => {
    const st = shotStage(3000, 2000);
    const blob = await st.screenshot({ scale: 2, maxSide: 10000, maxArea: 4e6 });
    assert.ok(blob && blob.size > 0, 'должен подобраться допустимый масштаб');
    const last = made[made.length - 1];
    assert.ok(last.width * last.height <= 4e6, 'площадь в пределах: ' + last.width + '×' + last.height);
    assert.ok(st.lastShot.scale < 1 && st.lastShot.scale > 0, 'масштаб дробный: ' + st.lastShot.scale);
  });
});

test('createDoc(seed): узел не по схеме чинится, неисправимый — выбрасывается с поддеревом', () => {
  const seed = {
    root: 'p',
    nodes: {
      p: { type: 'page', id: 'p', name: 'Страница', parent: null, children: ['ab'] },
      ab: {
        type: 'frame', id: 'ab', name: 'Артборд', parent: 'p', children: ['bad', 'gone', 'wild'],
        size: fixed(300, 200), fill: '#ffffff',
        layout: { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'start', justify: 'start', wrap: false }
      },
      bad: { type: 'rect', id: 'bad', name: 'Битый размер', parent: 'ab', size: { w: { mode: 'fixed', value: 'широко' }, h: { mode: 'fixed', value: 40 } } },
      wild: { type: 'text', id: 'wild', name: 'Дикий текст', parent: 'ab', characters: 'ок', size: HUG, pos: { x: 1e308, y: NaN }, opacity: 7 },
      gone: { type: 'осьминог', id: 'gone', name: 'Неизвестный', parent: 'ab', children: ['kid'], size: HUG },
      kid: { type: 'rect', id: 'kid', name: 'Ребёнок', parent: 'gone', size: fixed(10, 10) }
    }
  };
  const doc = createDoc(seed);
  assert.ok(doc.nodes.bad, 'исправимый узел остался в документе');
  assert.deepEqual(doc.nodes.bad.size.w, { mode: 'hug' }, 'негодный размер сброшен к hug');
  assert.equal(doc.nodes.bad.size.h.value, 40, 'годная ось не тронута');
  assert.ok(doc.nodes.wild, 'узел с дикими pos/opacity остался');
  assert.equal(doc.nodes.gone, undefined, 'узел неизвестного типа выброшен');
  assert.equal(doc.nodes.kid, undefined, 'вместе с поддеревом');
  assert.deepEqual(doc.nodes.ab.children, ['bad', 'wild'], 'ребро на выброшенный узел снято');
  const geo = solve(doc, M);
  for (const id of Object.keys(geo.rects)) {
    const r = geo.rects[id];
    for (const k of ['x', 'y', 'w', 'h']) {
      assert.ok(Number.isFinite(r[k]), `${id}.${k} должен быть числом, а не ${r[k]}`);
    }
  }
});

test('solve: враждебные числа не дают NaN и Infinity в геометрии', () => {
  const base = scene(() => [
    ops.create(frame('col', 'ab', { mode: 'column', gap: 8, padding: { t: 4, r: 4, b: 4, l: 4 } },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'hug' } })),
    ops.create(label('t', 'col', 'Текст подписи')),
    ops.create(box('b', 'col', 50, 20)),
    ops.create(frame('row', 'ab', { mode: 'row', gap: 4, wrap: true, align: 'stretch', justify: 'between' },
      { w: { mode: 'fixed', value: 120 }, h: { mode: 'hug' } })),
    ops.create(box('r1', 'row', 70, 10)),
    ops.create(box('r2', 'row', 70, 10))
  ]);
  const HOSTILE = [NaN, Infinity, -Infinity, -1e308, 1e308];
  const spots = [
    ['pos', (d, v) => { d.nodes.b.pos = { x: v, y: v }; }],
    ['size.w.value', (d, v) => { d.nodes.b.size.w = { mode: 'fixed', value: v }; }],
    ['size.h.value', (d, v) => { d.nodes.col.size.h = { mode: 'fixed', value: v }; }],
    ['layout.gap', (d, v) => { d.nodes.col.layout.gap = v; d.nodes.row.layout.gap = v; }],
    ['layout.padding', (d, v) => { d.nodes.col.layout.padding = { t: v, r: v, b: v, l: v }; }],
    ['override', (d, v) => { d.nodes.b.override = { x: v, y: v, w: v, h: v }; }],
    ['style', (d, v) => { d.nodes.t.style = { token: 'body', fontSize: v, lineHeight: v }; }],
    ['radius', (d, v) => { d.nodes.b.radius = v; }]
  ];
  for (const v of HOSTILE) {
    for (const [name, spot] of spots) {
      const d = JSON.parse(JSON.stringify(base));
      spot(d, v);
      const geo = solve(d, M);
      for (const id of Object.keys(geo.rects)) {
        const r = geo.rects[id];
        for (const k of ['x', 'y', 'w', 'h']) {
          assert.ok(Number.isFinite(r[k]), `${name}=${v}: ${id}.${k} = ${r[k]}`);
        }
      }
      assert.ok(Math.abs(geo.rects.b.x) <= 100000, `${name}=${v}: b.x вышел за MAX_SIZE (${geo.rects.b.x})`);
    }
  }
  // clamp тоже не должен пропускать NaN: зум обязан остаться числом
  const st = bareStage({ rects: {} });
  st.opts = {};
  st.zoomAt(100, 100, NaN);
  assert.ok(Number.isFinite(st.view.zoom) && st.view.zoom > 0, 'зум: ' + st.view.zoom);
  assert.ok(Number.isFinite(st.view.pan.x) && Number.isFinite(st.view.pan.y), 'панорама осталась числовой');
});

test('pos ограничен MAX_SIZE, геометрия остаётся конечной', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 10, 10))]);
  for (const bad of [{ x: 1e308, y: 0 }, { x: 0, y: -1e308 }, { x: 200000, y: 0 }]) {
    const res = applyOps(doc, [ops.set('a', 'pos', bad)]);
    assert.ok(res.error, 'pos вне предела не принимаем: ' + JSON.stringify(bad));
    assert.match(res.error.message, /pos/);
    assert.equal(res.doc, doc);
  }
  const ok = applyOps(doc, [ops.set('a', 'pos', { x: 40, y: 40 })]);
  assert.equal(ok.error, undefined, 'нормальный pos по-прежнему принимается');
  const raw = JSON.parse(JSON.stringify(doc));
  raw.nodes.a.pos = { x: 1e308, y: 5 };
  const r = solve(raw, M).rects.a;
  assert.ok(Number.isFinite(r.x) && Math.abs(r.x) <= 100000, 'x = ' + r.x);
});

test('set: __proto__, prototype и constructor защищены на любом уровне пути', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 10, 10))]);
  for (const path of ['__proto__', 'prototype', 'constructor', 'style.__proto__', 'fill.constructor']) {
    const bad = applyOps(doc, [ops.set('a', path, { polluted: 1 })]);
    assert.ok(bad.error, 'путь ' + path + ' должен отклоняться');
    assert.equal(bad.error.code, 'protected-path', 'путь ' + path);
    assert.equal(bad.doc, doc, 'документ не трогаем');
  }
  const t = applyOps(doc, [ops.setToken('__proto__', { polluted: 1 })]);
  assert.ok(t.error, 'setToken тоже не пишет в прототип');
  assert.equal({}.polluted, undefined, 'глобального загрязнения нет');
  const after = applyOps(doc, [ops.set('a', 'fill', '#ff0000')]);
  assert.equal(after.error, undefined);
  assert.equal(Object.getPrototypeOf(after.doc.nodes.a), Object.prototype, 'прототип узла нетронут');

  // импорт: JSON.parse делает «__proto__» собственным ключом — копировать его нельзя
  const seed = JSON.parse('{"root":"p","nodes":{"p":{"type":"page","id":"p","name":"Стр","parent":null,"children":["r"]},'
    + '"r":{"type":"rect","id":"r","name":"Куб","parent":"p","__proto__":{"polluted":1},'
    + '"size":{"w":{"mode":"fixed","value":10},"h":{"mode":"fixed","value":10}}}}}');
  const imported = createDoc(seed);
  assert.equal(imported.nodes.r.polluted, undefined, 'свойство «из ниоткуда» не появилось');
  assert.equal(Object.getPrototypeOf(imported.nodes.r), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('подпись артборда: выбранные цвета проходят 4.5:1 в обеих темах', () => {
  // подпись лежит на холсте (--canvas-bg), кегль 11 → норма 4.5:1
  assert.ok(contrastRatio('#4A505C', '#d9d4cb') >= 4.5, 'светлая: ' + contrastRatio('#4A505C', '#d9d4cb'));
  assert.ok(contrastRatio('#8A92A6', '#0a0b0e') >= 4.5, 'тёмная: ' + contrastRatio('#8A92A6', '#0a0b0e'));
  // прежний жёстко зашитый цвет в светлой теме норму не проходил
  assert.ok(contrastRatio('#8A92A6', '#d9d4cb') < 4.5, 'регрессия: старый цвет снова прошёл бы');
});

test('justify:between при переполнении не даёт отрицательный шаг', () => {
  const doc = scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 4, justify: 'between' },
      { w: { mode: 'fixed', value: 50 }, h: { mode: 'fixed', value: 30 } })),
    ops.create(box('a', 'row', 100, 10)),
    ops.create(box('b', 'row', 100, 10))
  ]);
  const r = solve(doc, M).rects;
  assert.equal(r.a.x, 0);
  assert.equal(r.b.x, r.a.x + 100 + 4, 'шаг не меньше gap');
  assert.ok(r.b.x > r.a.x, 'блоки не расходятся назад');
});

test('Stage._fail: повторная одинаковая ошибка не сыплет тостами', () => {
  const st = Object.create(Stage.prototype);
  const seen = [];
  st.opts = { onError: (i) => seen.push(i.where) };
  const e = new Error('одна и та же беда');
  st._fail('render', e);
  st._fail('render', e);
  st._fail('render', new Error('другая беда'));
  assert.deepEqual(seen, ['render', 'render'], 'одинаковую — один раз, другую — отдельно');
});

/* ------------------- пятый круг: измерения, дерево, фуззинг ------------------- */

test('resetMeasureCache(): смена гарнитур пересчитывает hug-геометрию', () => {
  // кеш ширин живёт при функции измерения и переживает solve: без сброса первая
  // раскладка, померенная системным шрифтом, залипала бы навсегда
  let scale = 1;
  const fn = (t, s) => String(t).length * s.fontSize * 0.5 * scale;
  const doc = createDoc();
  const before = hashGeometry(solve(doc, { measureText: fn }));
  scale = 2;
  assert.equal(hashGeometry(solve(doc, { measureText: fn })), before, 'без сброса берутся прежние ширины');

  const epoch = measureEpoch();
  const seen = [];
  const off = onMeasureEpoch((info) => seen.push(info));
  assert.ok(resetMeasureCache('тест') > epoch, 'эпоха растёт');
  assert.equal(seen.length, 1, 'подписчик узнал о сбросе');
  assert.equal(seen[0].epoch, measureEpoch());

  const after = hashGeometry(solve(doc, { measureText: fn }));
  assert.notEqual(after, before, 'после сброса геометрия пересчитана по новым ширинам');
  const t = Object.values(doc.nodes).find((n) => n.type === 'text' && n.size.w.mode === 'hug');
  const w1 = solve(doc, { measureText: (x, s) => String(x).length * s.fontSize * 0.5 }).rects[t.id].w;
  assert.ok(Math.abs(solve(doc, { measureText: fn }).rects[t.id].w - w1 * 2) < 1, 'hug-текст стал вдвое шире');

  // отписка снимает слушателя — иначе он живёт до конца страницы
  off();
  const n = seen.length;
  resetMeasureCache('после отписки');
  assert.equal(seen.length, n, 'после отписки сообщений нет');
});

/** Инвариант дерева: у каждого узла родитель существует и числит его, и наоборот. */
function assertTree(doc, what) {
  assert.ok(doc && doc.nodes && doc.nodes[doc.root], what + ': корень на месте');
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    assert.equal(n.id, id, what + ': ключ и id совпадают (' + id + ')');
    if (id === doc.root) {
      assert.ok(n.parent === null || n.parent === undefined, what + ': у корня нет родителя');
    } else {
      const p = doc.nodes[n.parent];
      assert.ok(p, what + ': родитель «' + n.parent + '» узла «' + id + '» существует');
      assert.ok((p.children || []).includes(id), what + ': родитель числит «' + id + '» в children');
    }
    for (const c of n.children || []) {
      assert.ok(doc.nodes[c], what + ': ребёнок «' + c + '» узла «' + id + '» существует');
      assert.equal(doc.nodes[c].parent, id, what + ': у «' + c + '» parent = «' + id + '»');
    }
  }
}

test('createDoc(seed): цепочка глубже предела не рвётся — документ остаётся деревом', () => {
  const nodes = { p: { id: 'p', type: 'page', parent: null, children: ['d1'] } };
  const N = 601;
  for (let i = 1; i <= N; i++) {
    nodes['d' + i] = {
      id: 'd' + i, type: 'frame', parent: i === 1 ? 'p' : 'd' + (i - 1),
      children: i < N ? ['d' + (i + 1)] : [],
      size: { w: { mode: 'hug' }, h: { mode: 'hug' } }
    };
  }
  const doc = createDoc({ root: 'p', nodes });
  assertTree(doc, 'глубокая цепочка');
  assert.equal(Object.keys(doc.nodes).length, N + 1, 'ни одного узла не потеряно');
  assert.doesNotThrow(() => solve(doc, M), 'solve не падает на глубоком дереве');
});

test('createDoc(seed): корень-непотомок приводится к странице, solve не падает', () => {
  const seed = {
    root: 'r',
    nodes: {
      r: {
        id: 'r', type: 'rect', parent: 'r', children: { mode: 'fixed' },
        size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } }
      }
    }
  };
  const doc = createDoc(seed);
  const root = doc.nodes[doc.root];
  assert.equal(root.type, 'page', 'корень стал страницей');
  assert.ok(root.parent === null || root.parent === undefined, 'у корня нет родителя');
  assert.ok(Array.isArray(root.children), 'children — массив');
  assertTree(doc, 'корень-прямоугольник');
  assert.doesNotThrow(() => solve(doc, M), 'solve не падает');
  assert.doesNotThrow(() => validate(doc, solve(doc, M), M), 'validate не падает');
});

test('solve: корень с негодными children не бросает исключение', () => {
  for (const children of [{ mode: 'fixed' }, 'd', 7, null]) {
    const raw = { root: 'p', version: 1, tokens: {}, nodes: { p: { id: 'p', type: 'page', parent: null, children } } };
    assert.doesNotThrow(() => solve(raw, M), 'children = ' + JSON.stringify(children));
  }
});

test('property: 1200 мусорных документов проходят весь конвейер без исключений', () => {
  const rnd = mulberry32(20260924);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const junkValues = [
    undefined, null, NaN, Infinity, -Infinity, 0, -1, 1e308, '10', 'hug', true, {}, [],
    { mode: 'fixed' }, { mode: 'fixed', value: NaN }, { mode: 'нет' }, { mode: 'hug', value: 5 },
    { x: NaN, y: 0 }, { x: 1e308, y: -1e308 }, '#zzzzzz', { token: 7 }
  ];
  const types = ['page', 'frame', 'text', 'rect', 'ellipse', 'image', 'хрень', undefined, 7];
  const junkNode = (id, ids) => {
    const n = { id: pick([id, id, id, undefined, 7]), type: pick(types) };
    if (rnd() < 0.85) n.parent = pick(ids.concat([null, undefined, id, 'нет-такого', 7]));
    if (rnd() < 0.7) n.children = pick([ids.slice(0, 2), [pick(ids)], [], 'd', { mode: 'fixed' }, [7, null], undefined]);
    if (rnd() < 0.8) n.size = pick([{ w: pick(junkValues), h: pick(junkValues) }, {}, null, 'большой', 7]);
    if (rnd() < 0.5) n.pos = pick(junkValues);
    if (rnd() < 0.4) n.layout = pick([{ mode: pick(['row', 'column', 'none', 'вбок']), gap: pick(junkValues), padding: pick(junkValues) }, null, 7, 'row']);
    if (rnd() < 0.5) n.characters = pick(['Привет', '', 'строка\nвторая', 7, null, undefined, { a: 1 }]);
    if (rnd() < 0.4) n.style = pick(['body', 'нет', { fontSize: pick(junkValues), lineHeight: pick(junkValues), fontWeight: pick(junkValues) }, 7, null]);
    if (rnd() < 0.4) n.fill = pick(['#ff0000', 'accent', { token: 'surface' }, 7, null, {}]);
    if (rnd() < 0.3) n.override = pick(junkValues);
    if (rnd() < 0.3) n.opacity = pick(junkValues);
    if (rnd() < 0.3) n.radius = pick(junkValues);
    if (rnd() < 0.2) n.visible = pick([true, false, 'да', 0]);
    if (rnd() < 0.2) n.locked = pick([true, false, 1]);
    return n;
  };
  let checked = 0;
  for (let run = 0; run < 1200; run++) {
    const count = 1 + Math.floor(rnd() * 6);
    const ids = [];
    for (let i = 0; i < count; i++) ids.push('n' + i);
    const nodes = {};
    for (const id of ids) nodes[id] = junkNode(id, ids);
    const seed = { root: pick(ids.concat(['нет-такого'])), nodes, tokens: pick([undefined, {}, { colors: 7 }, null]) };
    const doc = createDoc(seed);
    assertTree(doc, 'прогон ' + run);
    const geo = solve(doc, M);
    for (const id of Object.keys(geo.rects)) {
      const r = geo.rects[id];
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.ok(Number.isFinite(r[k]), 'прогон ' + run + ': ' + id + '.' + k + ' = ' + r[k]);
      }
    }
    validate(doc, geo, M);
    // операции: правка первого живого узла и её отмена
    const victim = Object.keys(doc.nodes).find((id) => id !== doc.root);
    if (victim) {
      const list = [ops.set(victim, 'name', 'Проба'), ops.set(victim, 'fill', '#123456')];
      const res = applyOps(doc, list);
      if (!res.error) {
        assertTree(res.doc, 'прогон ' + run + ' после applyOps');
        const back = applyOps(res.doc, invertOps(doc, list));
        assert.equal(back.error, undefined, 'прогон ' + run + ': отмена отклонена');
        assertTree(back.doc, 'прогон ' + run + ' после отмены');
      }
    }
    checked++;
  }
  assert.equal(checked, 1200);
});

test('_updateResize: размер всегда целый, неподвижная кромка на месте', () => {
  const st = Object.create(Stage.prototype);
  st.view = { zoom: 1, pan: { x: 0, y: 0 } };
  const run = (handle, rect0, dx, dy, mods = {}) => {
    const d = { mode: 'resize', id: 'a', handle, rect0, start: { x: 0, y: 0 }, preview: { ...rect0 } };
    st._updateResize(d, { x: dx, y: dy }, { altKey: false, shiftKey: false, ...mods });
    return d.preview;
  };
  const base = { x: 10, y: 20, w: 100, h: 50 };
  const se = run('se', base, 39.37, 18.84);
  assert.equal(se.w, Math.round(se.w), 'ширина целая: ' + se.w);
  assert.equal(se.h, Math.round(se.h), 'высота целая: ' + se.h);
  assert.deepEqual([se.w, se.h], [139, 69]);
  assert.deepEqual([se.x, se.y], [10, 20], 'левый верхний угол не двигался');

  // тянем за левый верх: правая и нижняя кромки остаются точно на месте
  const nw = run('nw', base, -20.6, -10.2);
  assert.equal(nw.w, Math.round(nw.w));
  assert.equal(nw.h, Math.round(nw.h));
  assert.equal(nw.x + nw.w, base.x + base.w, 'правая кромка: ' + (nw.x + nw.w));
  assert.equal(nw.y + nw.h, base.y + base.h, 'нижняя кромка: ' + (nw.y + nw.h));

  // дробный исходный размер приводится к целому сразу
  const hug = run('e', { x: 0, y: 0, w: 151.42, h: 21.7 }, 0, 0);
  assert.deepEqual([hug.w, hug.h], [151, 22]);

  // мелкий зум не «залипает»: каждый следующий пиксель экрана меняет размер
  st.view.zoom = 6;
  const sizes = new Set();
  for (let i = 1; i <= 12; i++) sizes.add(run('se', base, i / 6, 0).w);
  assert.ok(sizes.size >= 2, 'при зуме 600% размер меняется: ' + [...sizes].join(','));
  // минимум — 1 px, а не ноль и не дробь
  const tiny = run('nw', base, 500, 500);
  assert.deepEqual([tiny.w, tiny.h], [1, 1]);
});

test('нажатие внутри выделения тянет выделенное, а не ребёнка под курсором', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 100 } })),
    ops.create(label('title', 'card', 'Название встречи'))
  ]);
  const rects = {
    ab: { x: 0, y: 0, w: 400, h: 200 },
    card: { x: 0, y: 0, w: 200, h: 100 },
    title: { x: 8, y: 8, w: 120, h: 20 }
  };
  const mk = (selection) => {
    const st = bareStage({ rects });
    st.geo = { rects, lines: {}, order: ['ab', 'card', 'title'] };
    st.doc = doc;
    st.state = { selection };
    st.activeArtboard = 'ab';
    st.el.focus = () => {};
    st.el.classList = { add() {}, remove() {} };
    st._emitSelect = (ids) => { st.state = { ...st.state, selection: ids.slice() }; st.selected = ids; };
    st._setHover = () => {};
    return st;
  };
  const ev = (x, y, extra = {}) => ({
    button: 0, clientX: 24 + x, clientY: 56 + y, pointerId: 1,
    altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, target: {}, ...extra
  });

  // выделена карточка, нажали по подписи внутри неё — тянем карточку
  const a = mk(['card']);
  a._onPointerDown(ev(40, 14));
  assert.equal(a._drag.id, 'card', 'тянем выделенное, а не «title»');
  assert.equal(a.selected, undefined, 'выделение не переехало');

  // Cmd/Ctrl-клик углубляется
  for (const mod of ['metaKey', 'ctrlKey', 'altKey']) {
    const b = mk(['card']);
    b._onPointerDown(ev(40, 14, { [mod]: true }));
    assert.equal(b._drag.id, 'title', mod + ' углубляется до ребёнка');
    assert.deepEqual(b.selected, ['title'], mod + ' переносит выделение');
  }

  // двойной клик углубляется
  const c = mk(['card']);
  c._startEdit = () => { c.edited = true; };
  c._onDblClick(ev(40, 14));
  assert.deepEqual(c.selected, ['title'], 'двойной клик углубляется');

  // ничего не выделено — одиночный клик берёт узел под курсором (верхний уровень артборда)
  const d = mk([]);
  d._onPointerDown(ev(40, 14));
  assert.deepEqual(d.selected, ['card'], 'клик по невыделенному выделяет узел под курсором');
  assert.equal(d._drag.id, 'card');

  // клик мимо выделения внутри того же артборда выделяет узел под курсором
  const e = mk(['title']);
  e._onPointerDown(ev(180, 90));
  assert.deepEqual(e.selected, ['card'], 'вне выделения работает обычный хит-тест');

  // артборд выделен — внутри него по-прежнему выбираем содержимое, а не тянем весь артборд
  const f = mk(['ab']);
  f._onPointerDown(ev(40, 14));
  assert.equal(f._drag.id, 'card', 'внутри выделенного артборда берём содержимое');

  // наведение обещает то же, что случится при нажатии
  const g = mk(['card']);
  const hit = g._hitTest({ x: 40, y: 14 }, false);
  assert.equal(hit.id, 'card', 'подсветка наведения совпадает с целью нажатия');
});

test('живой предпросмотр ресайза: содержимое переливается на каждом кадре', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
      { w: { mode: 'fixed', value: 240 }, h: { mode: 'hug' } })),
    ops.create(label('t', 'card', 'Планёрка по редактору макетов', { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }))
  ]);
  const geo = solve(doc, M);
  assert.equal(geo.lines.t.length, 1, 'на 240 текст в одну строку');
  const st = bareStage({ rects: geo.rects });
  st.doc = doc;
  st.geo = geo;
  st.state = { selection: ['card'] };
  st.opts = { measureText };
  const seen = [];
  st._renderSVG = () => seen.push({ doc: st.doc, geo: st.geo });
  st._drag = {
    mode: 'resize', id: 'card', handle: 'e', start: { x: 0, y: 0 },
    rect0: { ...geo.rects.card }, preview: { ...geo.rects.card, w: 120 }
  };

  let views = 0;
  st._applyView = () => { views++; };

  st._paintPreview();
  assert.equal(seen.length, 1, 'кадр предпросмотра нарисован');
  // подписи артбордов держат экранный кегль только после _applyView: без него
  // font-size скакал 20,09 → 11 → 20,09 на каждом жесте
  assert.equal(views, 1, 'кадр предпросмотра приводит подписи артбордов к экрану');
  assert.notEqual(seen[0].doc, doc, 'рисуется черновик жеста, а не документ сцены');
  assert.equal(seen[0].geo.rects.card.w, 120, 'фрейм в предпросмотре уже узкий');
  assert.ok(seen[0].geo.lines.t.length > 1, 'текст внутри переносится сразу, а не после отпускания');
  assert.equal(st.doc, doc, 'документ сцены не подменён');
  assert.equal(st.geo, geo, 'геометрия жеста осталась настоящей');

  /* Предпросмотр и коммит — одна и та же правка. Сверять список операций с новым
     вызовом _resizeOps было нечестно: такая проверка проходит при любой ошибке
     внутри самой _resizeOps (круг 16, п.7). Проверяем поведение: применяем то,
     что ушло в коммит, к настоящему документу и сверяем результат с картинкой,
     которую человек видел на экране во время жеста. */
  const committed = [];
  st._commit = (list) => committed.push(list);
  st._commitResize(st._drag);
  assert.equal(committed.length, 1, 'коммит один');
  const applied = applyOps(doc, committed[0]);
  assert.equal(applied.error, undefined, JSON.stringify(applied.error));
  const afterGeo = solve(applied.doc, M);
  assert.deepEqual(afterGeo.rects, seen[0].geo.rects, 'после коммита макет ровно такой, каким его показывали');
  assert.deepEqual(afterGeo.lines, seen[0].geo.lines, 'и текст переносится так же');
  assert.equal(afterGeo.rects.card.w, 120, 'ширина взята из жеста, а не из прежнего документа');
  assert.equal(applied.doc.nodes.card.size.w.mode, 'fixed', 'ширина стала заданной');
  assert.deepEqual(applied.doc.nodes.card.size.h, doc.nodes.card.size.h, 'вторую ось ручка «e» не трогала');

  // конец жеста возвращает на сцену настоящий документ
  seen.length = 0;
  views = 0;
  st._dropPreview();
  assert.equal(seen.length, 1, 'сцена перерисована по настоящему документу');
  assert.equal(views, 1, 'и подписи артбордов пересчитаны вместе с ней');
  assert.equal(seen[0].doc, doc);
  st._dropPreview();
  assert.equal(seen.length, 1, 'повторный вызов ничего не делает');
});

test('бейдж размера не ложится на содержимое', () => {
  const had = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, textContent: '', className: '' }) };
  try {
    const mk = (vw, vh) => {
      const st = Object.create(Stage.prototype);
      st.ui = { appendChild() {} };
      if (vw) st.el = { clientWidth: vw, clientHeight: vh };
      return st;
    };
    const at = (b) => ({ x: parseFloat(b.style.left), y: parseFloat(b.style.top) });
    // «350 × 108» — 9 знаков по 6 px плюс отбивки 6+6: ширина 66, высота 17
    const W = 66;
    const overlaps = (p, r) => p.x < r.x + r.w && p.x + W > r.x && p.y < r.y + r.h && p.y + 17 > r.y;
    const onScreen = (p, vw, vh) => p.x >= 0 && p.y >= 0 && p.x + W <= vw && p.y + 17 <= vh;

    // обычный случай: слева от узла, по его нижней кромке — там поле артборда или холст
    const st = mk(1000, 700);
    const node = { x: 480, y: 212, w: 192, h: 108 };
    const badge = st._badge('350 × 108', node);
    const a = at(badge);
    assert.ok(a.x + W <= node.x, 'бейдж левее узла: ' + a.x);
    assert.ok(a.y + 17 <= node.y + node.h + 0.01 && a.y >= node.y, 'по нижней кромке: ' + a.y);
    // и прижат к кромке вплотную: с зазором он читался как отдельная плашка,
    // повисшая рядом на холсте, а не как ярлык этого узла
    assert.ok(Math.abs(node.x - (a.x + W)) < 0.51, 'зазора нет: ' + (node.x - (a.x + W)));
    assert.match(badge.className, /\bat-left\b/, 'класс места: ' + badge.className);

    // два бейджа не наезжают друг на друга
    const b = at(st._badge('отсоединён', node, 'is-detached', 1));
    assert.ok(b.y + 17 <= a.y, 'второй бейдж этажом выше: ' + b.y + ' vs ' + a.y);

    // узел прижат к ЛЕВОМУ краю: бейдж уходит вправо от узла, а не внутрь него
    const edge = { x: 4, y: 100, w: 300, h: 200 };
    const c = at(mk(1000, 700)._badge('350 × 108', edge));
    assert.ok(!overlaps(c, edge), 'бейдж не лёг на содержимое узла: ' + JSON.stringify(c));
    assert.ok(onScreen(c, 1000, 700), 'и остался на экране');
    assert.ok(c.x >= edge.x + edge.w, 'справа от узла: ' + c.x);
    assert.ok(Math.abs(c.x - (edge.x + edge.w)) < 0.51, 'и снова вплотную: ' + c.x);

    // узел прижат к левому краю, а справа кончилась область просмотра — бейдж над узлом
    const tightW = edge.x + edge.w + 20;
    const d = at(mk(tightW, 700)._badge('350 × 108', edge));
    assert.ok(!overlaps(d, edge), 'и здесь не на содержимом: ' + JSON.stringify(d));
    assert.ok(onScreen(d, tightW, 700), 'на экране: ' + JSON.stringify(d));
    assert.ok(d.y + 17 <= edge.y, 'над верхней кромкой: ' + d.y);
    assert.ok(Math.abs(edge.y - (d.y + 17)) < 0.51, 'вплотную к ней: ' + (edge.y - (d.y + 17)));

    // узел прижат и к левому, и к ВЕРХНЕМУ краю — остаётся место под ним
    const top = { x: 2, y: 2, w: tightW - 4, h: 200 };
    const e = at(mk(tightW, 700)._badge('350 × 108', top));
    assert.ok(!overlaps(e, top), 'бейдж под узлом, а не на нём: ' + JSON.stringify(e));
    assert.ok(e.y >= top.y + top.h, 'под нижней кромкой: ' + e.y);
    assert.ok(Math.abs(e.y - (top.y + top.h)) < 0.51, 'вплотную: ' + e.y);

    // узел занял всю область просмотра — снаружи места нет, кладём внутрь
    const full = { x: 0, y: 0, w: tightW, h: 300 };
    const f = at(mk(tightW, 300)._badge('350 × 108', full));
    assert.ok(onScreen(f, tightW, 300), 'последний вариант всё равно на экране: ' + JSON.stringify(f));
    assert.ok(f.x >= full.x && f.y + 17 <= full.y + full.h, 'внутри узла: ' + JSON.stringify(f));

    // сцена без размеров (обрезанный стенд) бейдж не ломает
    const g = at(mk(null)._badge('120 × 20', { x: 2, y: 200, w: 120, h: 20 }));
    assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y));
  } finally {
    globalThis.document = had;
  }
});

/* --------------------- круг 7: жесты, выделение, подсветка --------------------- */

/** Сцена с документом и геометрией: жесты гоняем прямо по методам Stage. */
function gestureStage(doc, geo, selection = []) {
  const st = bareStage({ rects: geo.rects });
  st.doc = doc;
  st.geo = geo;
  st.state = { selection: selection.slice() };
  st.activeArtboard = 'ab';
  st.commits = [];
  st.selected = null;
  st.opts = { onCommit: (t) => st.commits.push(t) };
  st._nodeEls = new Map();
  st._prevRects = {};
  st._guides = [];
  st._insertion = null;
  st._marquee = null;
  st._pulses = [];
  st._timers = new Set();
  st._dead = false;
  st._ghost = () => {};
  st._clearGhost = () => {};
  st._emitSelect = (ids) => { st.state = { ...st.state, selection: ids.slice() }; st.selected = ids.slice(); };
  st._setHover = () => {};
  st.el.focus = () => {};
  st.el.classList = { add() {}, remove() {} };
  return st;
}

/** Событие указателя в координатах сцены (её угол на экране — 24,56). */
const pev = (x, y, extra = {}) => ({
  button: 0, clientX: 24 + x, clientY: 56 + y, pointerId: 1,
  altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, target: {}, ...extra
});

/** Колонка [a,b,c] внутри артборда; первый ребёнок при желании отсоединён. */
function columnScene(detachFirst) {
  const doc = scene(() => [
    ops.create(frame('col', 'ab', { mode: 'column', gap: 10 },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 200 } })),
    ops.create(box('a', 'col', 100, 40, detachFirst ? { override: { x: 120, y: 0, w: 100, h: 40 } } : {})),
    ops.create(box('b', 'col', 100, 40)),
    ops.create(box('c', 'col', 100, 40))
  ]);
  return { doc, geo: solve(doc, M) };
}

test('перестановка в потоке: индекс переводится из потокового пространства в полное', () => {
  // без отсоединённых: как было
  {
    const { doc, geo } = columnScene(false);
    const st = gestureStage(doc, geo, ['b']);
    const d = { mode: 'move', id: 'b', start: { x: 50, y: geo.rects.b.y + 20 }, rect0: { ...geo.rects.b } };
    // тянем b ниже середины c
    st._updateMove(d, { x: 50, y: geo.rects.c.y + geo.rects.c.h - 1 }, {});
    st._commitMove(d);
    assert.equal(st.commits.length, 1, 'жест должен что-то закоммитить');
    const res = applyOps(doc, st.commits[0].ops);
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.deepEqual(res.doc.nodes.col.children, ['a', 'c', 'b']);
  }

  // первый ребёнок отсоединён: индекс потока (1) ≠ индексу в children (1) по смыслу
  {
    const { doc, geo } = columnScene(true);
    const st = gestureStage(doc, geo, ['b']);
    const d = { mode: 'move', id: 'b', start: { x: 50, y: geo.rects.b.y + 20 }, rect0: { ...geo.rects.b } };
    st._updateMove(d, { x: 50, y: geo.rects.c.y + geo.rects.c.h - 1 }, {});
    assert.ok(st._insertion, 'маркер вставки показан');
    // c уезжает вверх на высоту b и зазор — маркер стоит в раздвинутой щели за ним
    const cNew = geo.rects.c.y + geo.rects.c.h - (geo.rects.b.h + 10);
    assert.ok(st._insertion.y1 >= cNew && st._insertion.y1 <= cNew + 10,
      'маркер сразу за уехавшим вверх c: ' + st._insertion.y1 + ' при щели от ' + cNew);
    st._commitMove(d);
    assert.equal(st.commits.length, 1, 'жест с показанным маркером не должен молчать');
    const res = applyOps(doc, st.commits[0].ops);
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.deepEqual(res.doc.nodes.col.children, ['a', 'c', 'b'], 'b встаёт после c, а не «никуда»');
  }

  // и обратно: тянем c выше середины b
  {
    const { doc, geo } = columnScene(true);
    const st = gestureStage(doc, geo, ['c']);
    const d = { mode: 'move', id: 'c', start: { x: 50, y: geo.rects.c.y + 20 }, rect0: { ...geo.rects.c } };
    st._updateMove(d, { x: 50, y: geo.rects.b.y + 1 }, {});
    st._commitMove(d);
    assert.equal(st.commits.length, 1);
    const res = applyOps(doc, st.commits[0].ops);
    assert.deepEqual(res.doc.nodes.col.children, ['a', 'c', 'b']);
  }

  // порядок не изменился — коммита нет (сверка тоже в потоковом пространстве)
  {
    const { doc, geo } = columnScene(true);
    const st = gestureStage(doc, geo, ['b']);
    const d = { mode: 'move', id: 'b', start: { x: 50, y: geo.rects.b.y + 20 }, rect0: { ...geo.rects.b } };
    st._updateMove(d, { x: 50, y: geo.rects.b.y + 30 }, {});   // 10 px вниз: свой же слот ближе
    assert.equal(d.result.index, 0, 'место вставки — своё');
    st._commitMove(d);
    assert.deepEqual(st.commits, [], 'b остался между a и c — коммитить нечего');
  }
});

test('подсветка агента не гаснет от лишнего рендера без diff', () => {
  const { doc, geo } = columnScene(false);
  const st = gestureStage(doc, geo);
  const timers = [];
  st._later = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  st._cancelLater = () => {};
  st._paintUI = () => {};

  st._flip({ created: ['b'], changed: [], removed: [] });
  assert.equal(st._pulses.length, 1, 'узел подсвечен');
  const timer = timers.find((t) => t.ms >= 900);
  assert.ok(timer, 'таймер гашения поставлен');

  st._flip(undefined);   // лишний рендер без diff — он подсветку не трогает
  assert.equal(st._pulses.length, 1, 'подсветка живёт до своего таймера');
  st._flip({});          // и пустой diff тоже
  assert.equal(st._pulses.length, 1);

  timer.fn();
  assert.equal(st._pulses.length, 0, 'гаснет по таймеру');
});

test('_duplicate не копирует потомков выделенных узлов дважды', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 4 }, { w: { mode: 'fixed', value: 200 }, h: { mode: 'hug' } })),
    ops.create(label('cap', 'card', 'Подпись'))
  ]);
  const st = gestureStage(doc, solve(doc, M), ['card', 'cap']);
  st._duplicate(['card', 'cap']);
  assert.equal(st.commits.length, 1);
  const res = applyOps(doc, st.commits[0].ops);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const kids = res.doc.nodes.ab.children;
  assert.equal(kids.length, 2, 'на артборде две карточки: ' + kids.length);
  const copy = res.doc.nodes[kids[1]];
  assert.equal(copy.children.length, 1, 'у копии одна подпись, а не две: ' + copy.children.length);
  assert.equal(st.selected.length, 1, 'выделена одна копия');
});

test('рамка выбора и Ctrl+A берут узлы верхнего уровня, включая вложенные', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'none' }, { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 100 } })),
    ops.create(box('cap', 'card', 60, 20, { pos: { x: 20, y: 20 } })),
    ops.create(box('side', 'ab', 40, 40, { pos: { x: 300, y: 0 } }))
  ]);
  const geo = solve(doc, M);
  const st = gestureStage(doc, geo);

  // рамка целиком вокруг карточки — берём карточку, а не её содержимое
  assert.deepEqual(st._marqueePick({ x1: -10, y1: -10, x2: 260, y2: 160 }), ['card']);

  // рамка внутри карточки вокруг подписи — берём вложенный узел
  assert.deepEqual(st._marqueePick({ x1: 10, y1: 10, x2: 120, y2: 60 }), ['cap'],
    'вложенный узел рамкой должен выбираться');

  // рамка по всему артборду — предок и потомок вместе не попадают
  const all = st._marqueePick({ x1: -50, y1: -50, x2: 500, y2: 300 });
  assert.deepEqual(all.slice().sort(), ['card', 'side']);

  // Ctrl+A — то же множество
  const ev = { key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false, shiftKey: false, preventDefault() {}, target: null };
  st._onKey(ev);
  assert.deepEqual(st.selected.slice().sort(), ['card', 'side']);
});

test('Alt/Cmd-клик и двойной клик углубляются по одному уровню', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'none' }, { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 100 } })),
    ops.create(frame('col', 'card', { mode: 'none' }, { w: { mode: 'fixed', value: 160 }, h: { mode: 'fixed', value: 60 } }, { pos: { x: 10, y: 10 } })),
    ops.create(label('cap', 'col', 'Подпись', { pos: { x: 4, y: 4 } }))
  ]);
  const geo = solve(doc, M);
  const at = { x: geo.rects.cap.x + 2, y: geo.rects.cap.y + 2 };
  const step = (selection) => {
    const st = gestureStage(doc, geo, selection);
    return st._hitTest(at, true).id;
  };
  assert.equal(step([]), 'card', 'первый Alt-клик — верхний уровень артборда');
  assert.equal(step(['card']), 'col', 'второй — промежуточный фрейм');
  assert.equal(step(['col']), 'cap', 'третий — самый глубокий');
  assert.equal(step(['cap']), 'cap', 'глубже некуда — остаёмся');

  // двойной клик по НЕтекстовому узлу идёт тем же шагом
  const st = gestureStage(doc, geo, ['card']);
  st._startEdit = () => {};
  st._setActiveArtboardFor = () => {};
  const gap = { x: geo.rects.col.x + geo.rects.col.w - 2, y: geo.rects.col.y + geo.rects.col.h - 2 };
  st._onDblClick({ clientX: 24 + gap.x, clientY: 56 + gap.y });
  assert.deepEqual(st.selected, ['col'], 'двойной клик по фрейму опускается на уровень');

  // а по тексту — сразу правка, без «углубись ещё раз» (SPEC §1.5)
  const txt = gestureStage(doc, geo, ['card']);
  txt._startEdit = (n) => { txt.edited = n.id; };
  txt._setActiveArtboardFor = () => {};
  txt._onDblClick({ clientX: 24 + at.x, clientY: 56 + at.y });
  assert.equal(txt.edited, 'cap', 'правка открывается с первого двойного клика');
  assert.deepEqual(txt.selected, ['cap'], 'и выделение переезжает на текст');
});

test('resetMeasureCache(): без смены метрик эпоха не растёт и подписчиков не будит', () => {
  let scale = 1;
  const fn = (t, s) => String(t).length * s.fontSize * 0.5 * scale;
  const doc = createDoc();
  solve(doc, { measureText: fn });   // есть что забывать: ширины померены и лежат в кеше

  const epoch = measureEpoch();
  const seen = [];
  const off = onMeasureEpoch((i) => seen.push(i));
  try {
    // браузер шлёт loadingdone на каждую гарнитуру; та же метрика — тот же вид
    assert.equal(resetMeasureCache('loadingdone-1'), epoch, 'эпоха не растёт');
    assert.equal(resetMeasureCache('loadingdone-2'), epoch, 'и на втором событии тоже');
    assert.deepEqual(seen, [], 'подписчиков не будим');
    const w = solve(doc, { measureText: fn }).rects;
    assert.ok(Object.keys(w).length > 3, 'геометрия на месте');

    // а настоящая смена метрик по-прежнему растит эпоху
    scale = 1.5;
    assert.ok(resetMeasureCache('шрифт доехал') > epoch, 'изменившиеся ширины эпоху растят');
    assert.equal(seen.length, 1, 'и будят подписчика ровно раз');
  } finally { off(); }
});

/** Сцена со снимком, в которой есть настоящий документ с картинкой. */
function shotSceneStage(src) {
  const doc = scene(() => [ops.create({
    type: 'image', id: 'pic', name: 'Фото', parent: 'ab', src,
    size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } }
  })]);
  const st = shotStage(400, 300);
  st.doc = doc;
  st.geo = { rects: { ab: { x: 0, y: 0, w: 400, h: 300 }, pic: { x: 0, y: 0, w: 100, h: 100 } }, lines: {}, order: ['ab', 'pic'] };
  return st;
}

test('screenshot(): внешняя картинка переводится в data:, а без неё — честный отказ', async () => {
  const hadFetch = globalThis.fetch;
  const hadFR = globalThis.FileReader;
  globalThis.FileReader = undefined;   // идём веткой arrayBuffer + base64
  try {
    // картинка доехала — снимок делается, адрес в разметке подменён
    await withFakeDom({}, async () => {
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        blob: async () => ({ type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer })
      });
      const st = shotSceneStage('https://example.test/ok.png');
      let seen = null;
      let inState = 'не смотрели';
      st.toSVG = function (id, doc, geo, o) {
        seen = o && o.srcMap;
        inState = this._srcMap;
        return '<svg xmlns="http://www.w3.org/2000/svg"/>';
      };
      const blob = await st.screenshot({ scale: 1 });
      assert.ok(blob && blob.size > 0, 'PNG должен получиться');
      assert.ok(seen && seen.get('https://example.test/ok.png').startsWith('data:image/png;base64,'),
        'адрес подменён на data: и пришёл в toSVG параметром');
      assert.equal(st.lastShot.ok, true);
      assert.deepEqual(st.errors, []);
      // подмена не живёт в состоянии сцены — иначе два снимка разом перетрут её
      assert.ok(!inState, 'сам снимок в поле сцены ничего не кладёт: ' + inState);
      assert.ok(!st._srcMap, 'и после снимка поле пустое');
    });

    // картинку не достать — отказ, а не заглушка «битое изображение»
    await withFakeDom({}, async () => {
      globalThis.fetch = async () => { throw new Error('сеть недоступна'); };
      const st = shotSceneStage('https://example.test/dead.png');
      const blob = await st.screenshot({ scale: 1 });
      assert.equal(blob, null, 'форма отказа — null');
      assert.deepEqual(st.errors, ['screenshot:external']);
      assert.equal(st.lastShot.ok, false);
      assert.equal(st.lastShot.blocked, 'external-images', 'оболочка может различить причину');
    });

    // сервер ответил не картинкой — тоже отказ
    await withFakeDom({}, async () => {
      globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => ({ type: 'text/html' }) });
      const st = shotSceneStage('https://example.test/page.html');
      assert.equal(await st.screenshot({ scale: 1 }), null);
      assert.deepEqual(st.errors, ['screenshot:external']);
    });

    // уже переведённый адрес берётся из кеша — сеть второй раз не трогаем
    await withFakeDom({}, async () => {
      globalThis.fetch = async () => { throw new Error('за той же картинкой ходить не должны'); };
      const st = shotSceneStage('https://example.test/ok.png');
      const blob = await st.screenshot({ scale: 1 });
      assert.ok(blob && blob.size > 0, 'второй снимок берёт адрес из кеша');
      assert.deepEqual(st.errors, []);
    });

    // data:-картинка внешней не считается и сеть не трогает
    await withFakeDom({}, async () => {
      globalThis.fetch = async () => { throw new Error('сюда ходить не должны'); };
      const st = shotSceneStage('data:image/png;base64,AAAA');
      assert.deepEqual(st._externalImages('ab'), []);
      const blob = await st.screenshot({ scale: 1 });
      assert.ok(blob && blob.size > 0);
      assert.deepEqual(st.errors, []);
    });
  } finally {
    globalThis.fetch = hadFetch;
    globalThis.FileReader = hadFR;
  }
});

/* --------------------- круг 9: мышь на холсте --------------------- */

/** Сцена «Шапка»: фрейм с фиксированным размером и текстом внутри. */
function headScene() {
  const doc = scene(() => [
    ops.create(frame('head', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
      { w: { mode: 'fixed', value: 350 }, h: { mode: 'fixed', value: 52 } }, { pos: { x: 20, y: 20 } })),
    ops.create(label('cap', 'head', 'вторник, 23 сентября'))
  ]);
  return { doc, geo: solve(doc, M) };
}

test('голый клик по ручке ресайза ничего не коммитит и доводится как обычный клик', () => {
  const { doc, geo } = headScene();
  const r = geo.rects.head;
  // точка в 5 px НИЖЕ нижней кромки: визуально это зазор, но там зона ручки «s»
  const at = { x: r.x + r.w / 2, y: r.y + r.h + 5 };
  const press = (st) => st._onPointerDown(pev(at.x, at.y, { target: { dataset: { handle: 's', id: 'head' } } }));

  const st = gestureStage(doc, geo, ['head']);
  st._schedulePreview = () => {};
  press(st);
  assert.equal(st._drag.mode, 'resize');
  assert.equal(st._drag.preview, undefined, 'до движения предпросмотра нет');
  st._onPointerUp(pev(at.x, at.y));
  assert.deepEqual(st.commits, [], 'голый клик по ручке не пишет в документ');
  // раньше проброс клика выделял то, что нашлось под курсором, — а под курсором
  // в зоне ручки лежит артборд, и выделение уезжало с узла на него (круг 13, п.1)
  assert.deepEqual(st.state.selection, ['head'], 'выделение осталось на узле');
  assert.equal(st.selected, null, 'и не переизлучалось');

  // дрожание руки в пару пикселей — тоже не жест
  const jitter = gestureStage(doc, geo, ['head']);
  jitter._schedulePreview = () => {};
  press(jitter);
  jitter._onPointerMove(pev(at.x + 1, at.y + 1));
  jitter._onPointerUp(pev(at.x + 1, at.y + 1));
  assert.deepEqual(jitter.commits, [], 'сдвиг меньше 3 px жестом не считается');

  // настоящее перетаскивание по-прежнему коммитит размер
  const drag = gestureStage(doc, geo, ['head']);
  drag._schedulePreview = () => {};
  press(drag);
  drag._onPointerMove(pev(at.x, at.y + 20));
  drag._onPointerUp(pev(at.x, at.y + 20));
  assert.equal(drag.commits.length, 1, 'жест с движением коммитит размер');
  assert.match(drag.commits[0].label, /Размер/);
  const res = applyOps(doc, drag.commits[0].ops);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.doc.nodes.head.size.h.value, 52 + 20);
});

test('зона захвата ручки сдвинута наружу узла', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 200, 100, { pos: { x: 50, y: 40 } }))]);
  const geo = solve(doc, M);
  const st = gestureStage(doc, geo, ['a']);
  const sr = st._screenRect('a');
  const list = st._handles('a');
  assert.deepEqual(list.map((h) => h.name).sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'],
    'у крупного узла все восемь ручек');
  // внутрь узла зона заходит не больше чем на 3 px: сжатая на 3 px внутренность
  // узла не должна пересекаться ни с одной зоной захвата
  const inner = { x: sr.x + 3, y: sr.y + 3, w: sr.w - 6, h: sr.h - 6 };
  const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const h of list) {
    assert.ok(!hits(h, inner), `зона ручки «${h.name}» залезает в содержимое узла`);
    assert.equal(h.w, 16, 'зона остаётся 16 px — по ней попадают и пальцем');
    // видимая точка 9×9 стоит на кромке — отодвинутая наружу ровно настолько,
    // чтобы целиком лечь в зону захвата (иначе её внутренняя полоска ловилась
    // обычным хит-тестом и у угловых ручек уводила выделение на артборд)
    const ex = h.name.includes('w') ? sr.x : h.name.includes('e') ? sr.x + sr.w : sr.x + sr.w / 2;
    const ey = h.name.includes('n') ? sr.y : h.name.includes('s') ? sr.y + sr.h : sr.y + sr.h / 2;
    const cx = h.x + h.dx;
    const cy = h.y + h.dy;
    assert.ok(Math.abs(cx - ex) <= 1.51, `точка ручки «${h.name}» по X у кромки: ${cx} при кромке ${ex}`);
    assert.ok(Math.abs(cy - ey) <= 1.51, `точка ручки «${h.name}» по Y у кромки: ${cy} при кромке ${ey}`);
    const dot = { x: cx - 4.5, y: cy - 4.5, w: 9, h: 9 };
    assert.ok(dot.x >= h.x - 0.01 && dot.x + dot.w <= h.x + h.w + 0.01
      && dot.y >= h.y - 0.01 && dot.y + dot.h <= h.y + h.h + 0.01,
      `точка ручки «${h.name}» вылезает за зону захвата: ${JSON.stringify(dot)} при зоне ${JSON.stringify({ x: h.x, y: h.y })}`);
    // и кромку узла точка по-прежнему накрывает — иначе она «отклеится» от узла
    assert.ok(dot.x <= ex + 0.01 && dot.x + dot.w >= ex - 0.01
      && dot.y <= ey + 0.01 && dot.y + dot.h >= ey - 0.01,
      `точка ручки «${h.name}» сошла с кромки узла`);
  }
});

test('у мелкого узла ручки не сливаются, у текста их одна', () => {
  const doc = scene(() => [
    ops.create(box('low', 'ab', 200, 10, { pos: { x: 10, y: 10 } })),
    ops.create(box('tiny', 'ab', 12, 10, { pos: { x: 10, y: 40 } })),
    ops.create(label('t', 'ab', 'Дальше сегодня', { pos: { x: 10, y: 60 } }))
  ]);
  const geo = solve(doc, M);
  const st = gestureStage(doc, geo);
  // узел высотой 10 px: три ряда ручек с шагом 5 px превращались в блок 26 px
  const low = st._handles('low').map((h) => h.name);
  assert.deepEqual(low, ['se', 's', 'sw'].sort((a, b) => low.indexOf(a) - low.indexOf(b)).slice(0, low.length),
    'у низкого узла остаётся один ряд ручек: ' + low.join(','));
  assert.ok(!low.includes('n') && !low.includes('w') && !low.includes('e'),
    'серединные и верхние ручки скрыты: ' + low.join(','));
  assert.deepEqual(st._handles('tiny').map((h) => h.name), ['se'], 'совсем мелкому узлу — одна ручка');
  assert.deepEqual(st._handles('t').map((h) => h.name), ['se'], 'текст размером по содержимому — одна ручка');
});

test('ручки выделения не съедают клики по текстам демо-документа', () => {
  const doc = createDoc();
  const geo = solve(doc, M);
  const texts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text');
  assert.ok(texts.length > 40, 'в демо-документе должно быть много текстов: ' + texts.length);
  for (const zoom of [0.55, 1]) {
    const st = gestureStage(doc, geo);
    st.view.zoom = zoom;
    const bad = [];
    for (const id of texts) {
      const r = geo.rects[id];
      const p = { x: (r.x + r.w / 2) * zoom, y: (r.y + r.h / 2) * zoom };
      for (const owner of [doc.nodes[id], ...ancestors(doc, id)]) {
        if (owner.id === doc.root) continue;
        st.state = { selection: [owner.id] };
        for (const h of st._handles(owner.id)) {
          if (p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h) {
            bad.push(`«${doc.nodes[id].characters}» ← ручка ${h.name} узла «${owner.name}»`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], `зум ${zoom}: центр текста попал в зону ручки — ${bad.join('; ')}`);
  }
});

test('ручки переиспользуют свои элементы между кадрами (иначе браузер теряет dblclick)', () => {
  const had = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      dataset: {}, className: '', parentNode: null,
      style: { setProperty(k, v) { this[k] = v; } }
    })
  };
  try {
    const doc = scene(() => [ops.create(box('a', 'ab', 200, 100, { pos: { x: 10, y: 10 } }))]);
    const geo = solve(doc, M);
    const st = gestureStage(doc, geo, ['a']);
    const kids = [];
    st.ui = {
      children: kids,
      appendChild(el) { el.parentNode = st.ui; kids.push(el); },
      removeChild(el) { el.parentNode = null; kids.splice(kids.indexOf(el), 1); }
    };
    st._layoutHandles(st._handles('a'));
    assert.equal(kids.length, 8, 'восемь ручек на слое интерфейса');
    const first = kids.slice();
    st._layoutHandles(st._handles('a'));
    assert.deepEqual(kids, first, 'второй кадр не пересоздаёт элементы ручек');
    // мелкому узлу ручек нужно меньше — лишние снимаются
    st.geo.rects.a = { x: 10, y: 10, w: 200, h: 10 };
    st._layoutHandles(st._handles('a'));
    assert.ok(kids.length < 8 && kids.length > 0, 'лишние ручки убраны: ' + kids.length);
    assert.ok(kids.every((el) => el.parentNode === st.ui), 'оставшиеся на месте');
  } finally { globalThis.document = had; }
});

test('двойной клик по тексту открывает правку с первого раза', () => {
  const doc = createDoc();
  const geo = solve(doc, M);
  const texts = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'text');
  const miss = [];
  for (const id of texts) {
    const st = gestureStage(doc, geo);
    st._startEdit = (n) => { st.editing = n.id; };
    st._setActiveArtboardFor = () => {};
    const r = geo.rects[id];
    st._onDblClick({ clientX: 24 + r.x + r.w / 2, clientY: 56 + r.y + r.h / 2 });
    if (st.editing !== id) miss.push(doc.nodes[id].characters);
    else assert.deepEqual(st.selected, [id], 'правка идёт вместе с выделением');
  }
  assert.deepEqual(miss, [], `с первого двойного клика не открылись: ${miss.join(' | ')}`);
});

test('пробел не залипает: потеря фокуса окном снимает режим панорамы', () => {
  const hadWin = globalThis.window;
  const hadDoc = globalThis.document;
  const bound = [];
  globalThis.window = {
    addEventListener: (t, fn, c) => bound.push({ t, fn, c }),
    removeEventListener: (t, fn) => {
      const i = bound.findIndex((l) => l.t === t && l.fn === fn);
      if (i >= 0) bound.splice(i, 1);
    }
  };
  globalThis.document = { activeElement: null };
  try {
    const st = Object.create(Stage.prototype);
    st.opts = {};
    st._space = false;
    st._timers = new Set();
    st._pulses = [];
    st._dead = false;
    const cls = new Set();
    st.el = {
      addEventListener() {}, contains: () => false,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) }
    };
    st._bindEvents();
    const blur = bound.find((l) => l.t === 'blur');
    assert.ok(blur, 'на window должен быть слушатель blur');
    st._space = true;
    cls.add('is-space');
    blur.fn();
    assert.equal(st._space, false, 'пробел отпущен за нас');
    assert.equal(cls.has('is-space'), false, 'курсор «рука» снят');
    st.destroy();
    assert.equal(bound.filter((l) => l.t === 'blur').length, 0, 'destroy снимает слушатель blur');
  } finally {
    globalThis.window = hadWin;
    globalThis.document = hadDoc;
  }
});

test('предпросмотр перестановки раздвигает место в потоке', () => {
  const { doc, geo } = columnScene(false);
  const st = gestureStage(doc, geo, ['b']);
  const els = new Map([['a', fakeEl()], ['b', fakeEl()], ['c', fakeEl()]]);
  st._nodeEls = els;
  const d = { mode: 'move', id: 'b', start: { x: 50, y: geo.rects.b.y + 20 }, rect0: { ...geo.rects.b } };

  // тянем b ниже середины c: c должен уступить место на высоту b + gap
  st._updateMove(d, { x: 50, y: geo.rects.c.y + geo.rects.c.h - 1 }, {});
  assert.ok(st._insertion, 'линия вставки показана');
  assert.equal(els.get('c').attrs.transform, 'translate(0 -50)',
    'сосед уступает место: ' + els.get('c').attrs.transform);
  assert.equal(els.get('a').attrs.transform, undefined, 'узлы выше места вставки стоят на месте');

  // вернули на своё место — сдвиг снят
  st._updateMove(d, { x: 50, y: geo.rects.b.y + 1 }, {});
  assert.equal(els.get('c').attrs.transform, undefined, 'порядок не меняется — соседи не двигаются');

  // конец жеста снимает сдвиг тоже
  st._updateMove(d, { x: 50, y: geo.rects.c.y + geo.rects.c.h - 1 }, {});
  st._drag = d;
  st._onPointerUp(pev(50, geo.rects.c.y + geo.rects.c.h - 1));
  assert.equal(els.get('c').attrs.transform, undefined, 'после отпускания соседи вернулись');
});

test('applyOne: create нормализует layout так же, как set layout.*', () => {
  const doc = scene(() => []);
  // сырая операция от агента: padding числом
  const a = applyOps(doc, [{ op: 'create', node: {
    type: 'frame', id: 'f1', name: 'Карточка', parent: 'ab', children: [],
    size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, layout: { padding: 8 }
  } }]);
  assert.equal(a.error, undefined, 'create с layout.padding числом должен применяться: ' + JSON.stringify(a.error));
  assert.deepEqual(a.doc.nodes.f1.layout.padding, { t: 8, r: 8, b: 8, l: 8 });

  // частичный layout доводится до полного
  const b = applyOps(doc, [{ op: 'create', node: {
    type: 'frame', id: 'f2', name: 'Колонка', parent: 'ab', children: [],
    size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, layout: { mode: 'column', gap: 8 }
  } }]);
  assert.equal(b.error, undefined, JSON.stringify(b.error));
  assert.deepEqual(b.doc.nodes.f2.layout, {
    mode: 'column', gap: 8, padding: { t: 0, r: 0, b: 0, l: 0 },
    align: 'start', justify: 'start', wrap: false
  });

  // мусор в layout не роняет и не пролезает в документ
  const c = applyOps(doc, [{ op: 'create', node: {
    type: 'frame', id: 'f3', name: 'Мусор', parent: 'ab', children: [],
    size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, layout: { mode: 'спираль', gap: NaN, align: 42 }
  } }]);
  assert.equal(c.error, undefined, JSON.stringify(c.error));
  assert.deepEqual(c.doc.nodes.f3.layout.mode, 'none');
  assert.equal(c.doc.nodes.f3.layout.gap, 0);

  // без layout поле по-прежнему не появляется
  const d = applyOps(doc, [ops.create(frame('f4', 'ab', { mode: 'row' }, { w: { mode: 'hug' }, h: { mode: 'hug' } }))]);
  assert.equal(d.error, undefined);
  assert.equal(d.doc.nodes.f4.layout.mode, 'row');
});

test('createDoc: частичные токены дополняются по группам, а не заменяют их', () => {
  const doc = createDoc({
    root: 'page', nodes: { page: { type: 'page', id: 'page', name: 'Стр', parent: null, children: [] } },
    tokens: { colors: { accent: '#123456' }, type: { body: { fontSize: 20, lineHeight: 28 } } }
  });
  assert.equal(doc.tokens.colors.accent, '#123456', 'своё значение сохраняется');
  assert.equal(resolveColor(doc, 'surface'), '#ffffff', 'недостающие цвета берутся из умолчаний');
  assert.equal(resolveColor(doc, 'text'), '#14161c');
  assert.ok(Object.keys(doc.tokens.colors).length >= 13, 'цветов столько же, сколько по умолчанию');
  assert.equal(doc.tokens.type.body.fontSize, 20, 'свой тип-токен на месте');
  assert.ok(doc.tokens.type.caption, 'недостающие тип-токены на месте');
  assert.ok(Array.isArray(doc.tokens.spacing) && doc.tokens.spacing.length > 3, 'шкала отступов не потеряна');
  assert.ok(Array.isArray(doc.tokens.radii) && doc.tokens.radii.length > 3, 'шкала радиусов не потеряна');

  // мусор вместо группы не должен обнулять токены
  const junk = createDoc({
    root: 'page', nodes: { page: { type: 'page', id: 'page', name: 'Стр', parent: null, children: [] } },
    tokens: { colors: 'оранжевый', spacing: 'много' }
  });
  assert.equal(resolveColor(junk, 'accent'), '#ff6b3d');
  assert.ok(Array.isArray(junk.tokens.spacing));
});

/* --------------------- круг 11 --------------------- */

test('ресайз за одну кромку не переводит вторую ось в fixed', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
      { w: { mode: 'fill' }, h: { mode: 'hug' } })),
    ops.create(label('t', 'card', 'Планёрка по редактору макетов', { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }))
  ]);
  const geo = solve(doc, M);
  const st = gestureStage(doc, geo, ['card']);
  st.opts = { measureText };

  /** Операции жеста за указанную ручку. */
  const run = (handle, dx, dy, mods = {}) => {
    const d = {
      mode: 'resize', id: 'card', handle, start: { x: 0, y: 0 },
      rect0: { ...geo.rects.card }, preview: { ...geo.rects.card }
    };
    st._updateResize(d, { x: dx, y: dy }, { altKey: false, shiftKey: false, ...mods });
    return st._resizeOps(d);
  };
  const axes = (list) => list.filter((o) => o.op === 'set' && /^size\./.test(o.path)).map((o) => o.path).sort();

  // горизонтальные ручки трогают только ширину
  for (const h of ['e', 'w']) {
    assert.deepEqual(axes(run(h, 20, 0)), ['size.w'], `ручка ${h}: только ширина`);
  }
  // вертикальные — только высоту
  for (const h of ['n', 's']) {
    assert.deepEqual(axes(run(h, 0, 20)), ['size.h'], `ручка ${h}: только высота`);
  }
  // углы трогают обе оси
  for (const h of ['nw', 'ne', 'sw', 'se']) {
    assert.deepEqual(axes(run(h, 20, 20)), ['size.h', 'size.w'], `ручка ${h}: обе оси`);
  }
  // Shift на углу сохраняет пропорцию — значит меняет обе оси
  assert.deepEqual(axes(run('se', 20, 3, { shiftKey: true })), ['size.h', 'size.w'], 'Shift+угол: обе оси');

  // в документе после жеста за «e» высота осталась hug, а ширина стала fixed
  const after = applyOps(doc, run('e', 20, 0));
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.equal(after.doc.nodes.card.size.h.mode, 'hug', 'высота не трогалась — режим прежний');
  assert.equal(after.doc.nodes.card.size.w.mode, 'fixed');
  assert.equal(after.doc.nodes.card.size.w.value, geo.rects.card.w + 20);

  // и наоборот: жест за «s» не фиксирует ширину, оставляя fill
  const down = applyOps(doc, run('s', 0, 20));
  assert.equal(down.error, undefined, JSON.stringify(down.error));
  assert.equal(down.doc.nodes.card.size.w.mode, 'fill', 'ширина не трогалась — fill сохранён');
  assert.equal(down.doc.nodes.card.size.h.mode, 'fixed');

  // карточка с fill по ширине после вертикального жеста по-прежнему тянется
  // за артбордом: это и есть смысл сохранения режима
  const wide = applyOps(down.doc, [ops.set('ab', 'size.w', { mode: 'fixed', value: 600 })]);
  assert.equal(wide.error, undefined);
  assert.equal(solve(wide.doc, M).rects.card.w, 600, 'fill доехал до новой ширины артборда');

  // отсоединённый узел (override) по-прежнему пишется одним прямоугольником
  const off = applyOps(doc, [ops.set('card', 'override', { x: 10, y: 10, w: 100, h: 50 })]);
  assert.equal(off.error, undefined, JSON.stringify(off.error));
  const st2 = gestureStage(off.doc, solve(off.doc, M), ['card']);
  st2.opts = { measureText };
  const d2 = {
    mode: 'resize', id: 'card', handle: 'e', start: { x: 0, y: 0 },
    rect0: { x: 10, y: 10, w: 100, h: 50 }, preview: { x: 10, y: 10, w: 120, h: 50 }
  };
  const list2 = st2._resizeOps(d2);
  assert.equal(list2.length, 1);
  assert.equal(list2[0].path, 'override');
  assert.deepEqual([list2[0].value.w, list2[0].value.h], [120, 50]);
});

test('wrap: строки в geo.lines нельзя испортить снаружи', () => {
  const doc = scene(() => [ops.create(label('t', 'ab', 'Планёрка по редактору макетов',
    { size: { w: { mode: 'fixed', value: 120 }, h: { mode: 'hug' } } }))]);
  const geo = solve(doc, M);
  const lines = geo.lines.t;
  assert.ok(lines.length > 1, 'текст переносится: ' + JSON.stringify(lines));
  const before = lines.slice();
  assert.throws(() => { lines.push('лишняя строка'); }, 'массив строк заморожен');
  assert.throws(() => { lines[0] = 'подмена'; });
  assert.deepEqual(geo.lines.t, before, 'строки не изменились');

  // второй solve той же сцены берёт строки из кеша — и они не отравлены
  const again = solve(doc, M);
  assert.deepEqual(again.lines.t, before, 'кеш измерений не испорчен');
  assert.equal(solve(doc, M).rects.t.h, geo.rects.t.h, 'высота текста та же');
});

/** Минимальный DOM для toSVG(): атрибуты, дети и сериализация через outerHTML. */
function withSvgDom(fn) {
  const had = globalThis.document;
  // как XMLSerializer: в тексте экранируются только & < >, в атрибутах ещё и кавычка
  const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const esc = (s) => escText(s).replace(/"/g, '&quot;');
  const mk = (name) => ({
    nodeName: name, attrs: new Map(), children: [], text: '',
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    setAttributeNS(_ns, k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    removeAttribute(k) { this.attrs.delete(k); },
    appendChild(c) { this.children.push(c); return c; },
    get outerHTML() {
      if (this.nodeName === '#text') return escText(this.text);
      const a = [...this.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
      return `<${this.nodeName}${a}>${this.children.map((c) => c.outerHTML).join('')}</${this.nodeName}>`;
    }
  });
  globalThis.document = {
    createElementNS: (_ns, name) => mk(name),
    createElement: (name) => mk(name),
    createTextNode: (t) => { const n = mk('#text'); n.text = t; return n; }
  };
  const restore = () => { globalThis.document = had; };
  return Promise.resolve().then(() => fn()).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

/** Сцена под toSVG(): артборд с обрезающим фреймом и текстом внутри. */
function svgScene() {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 80 } }, { clip: true })),
    ops.create(label('t', 'card', 'Планёрка', { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }))
  ]);
  const geo = solve(doc, M);
  const st = bareStage({ rects: geo.rects });
  st.doc = doc;
  st.geo = geo;
  st.activeArtboard = 'ab';
  st.opts = { onError: (i) => st.errors.push(i.where) };
  st.errors = [];
  return st;
}

test('toSVG: идентификаторы обрезки уникальны между вызовами', async () => {
  await withSvgDom(() => {
    const st = svgScene();
    const a = st.toSVG('ab');
    const b = st.toSVG('ab');
    assert.deepEqual(st.errors, [], 'без ошибок');
    const ids = (s) => [...s.matchAll(/id="([^"]*clip[^"]*)"/g)].map((m) => m[1]);
    const ia = ids(a);
    const ib = ids(b);
    assert.ok(ia.length >= 1, 'обрезка в разметке есть: ' + a.slice(0, 400));
    assert.deepEqual(ia.length, ib.length);
    for (const id of ia) assert.ok(!ib.includes(id), `id ${id} повторился во втором SVG`);
    // ссылка внутри документа осталась на свой clipPath
    for (const id of ia) assert.ok(a.includes(`url(#${id})`), `ссылка на ${id} на месте`);
    for (const id of ib) assert.ok(b.includes(`url(#${id})`), `ссылка на ${id} на месте`);
  });
});

/** Поддельный Google Fonts: стили с тремя поднаборами и «файлы» начертаний. */
function fontServer(family, cfg = {}) {
  const hits = [];
  const SUBSETS = [
    ['cyrillic', 'U+0301, U+0400-045F', 'cyr'],
    ['greek', 'U+0370-0377, U+037A-037F', 'gre'],
    ['latin', 'U+0000-00FF, U+0131', 'lat']
  ];
  const sheet = (weight) => SUBSETS.map(([name, range, tag]) =>
    `/* ${name} */\n@font-face {\n  font-family: '${family}';\n  font-style: normal;\n`
    + `  font-weight: ${weight};\n  font-stretch: 100%;\n  font-display: swap;\n`
    + `  src: url(https://fonts.gstatic.test/s/${family.replace(/ /g, '')}/${tag}-${weight}.woff2) format('woff2');\n`
    + `  unicode-range: ${range};\n}`).join('\n');
  return {
    hits,
    install() {
      globalThis.fetch = async (url) => {
        hits.push(String(url));
        if (cfg.failCss) throw new Error('стили не отдали');
        if (/css2/.test(String(url))) {
          const m = /wght@([\d;]+)/.exec(String(url));
          return { ok: true, status: 200, text: async () => (m ? m[1].split(';') : ['400']).map(sheet).join('\n') };
        }
        if (cfg.failFile) throw new Error('файл начертания не отдали');
        return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer };
      };
    }
  };
}

/** Артборд с текстом заданной гарнитуры. */
function fontScene(family, characters) {
  const doc = scene(() => [ops.create(label('t', 'ab', characters, {
    style: { token: 'body', font: family, fontWeight: 600 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } }
  }))]);
  const geo = solve(doc, M);
  const st = bareStage({ rects: geo.rects });
  st.doc = doc;
  st.geo = geo;
  st.activeArtboard = 'ab';
  st.opts = { onError: (i) => st.errors.push(i.where) };
  st.errors = [];
  return st;
}

test('экспорт несёт гарнитуру с собой: @font-face с data:woff2', async () => {
  const had = globalThis.fetch;
  try {
    const srv = fontServer('Fake Sans Alpha');
    srv.install();
    await withSvgDom(async () => {
      const st = fontScene('Fake Sans Alpha', 'Планёрка 12');

      // до загрузки встраивать нечего — и об этом честно сказано
      const cold = st.toSVG('ab');
      assert.ok(!/@font-face/.test(cold), 'пока ничего не скачано — правил нет');
      assert.equal(st.lastSVG.fonts, 'missing');
      assert.deepEqual(st.lastSVG.families, ['Fake Sans Alpha']);

      const prep = await st.prepareFonts('ab');
      assert.equal(prep.state, 'embedded', JSON.stringify(prep));
      assert.deepEqual(prep.missing, []);

      const svg = st.toSVG('ab');
      assert.equal(st.lastSVG.fonts, 'embedded');
      assert.ok(/<style[^>]*>/.test(svg), 'стиль в разметке есть');
      assert.ok(svg.includes('@font-face'), 'правило на месте');
      assert.ok(svg.includes('src:url(data:font/woff2;base64,'), 'файл встроен прямо в разметку');
      assert.ok(svg.includes('font-family:"Fake Sans Alpha"'), 'имя семейства то же, что в тексте');
      assert.ok(svg.includes('font-weight:600'), 'начертание то, которым считали макет');
      assert.ok(svg.indexOf('@font-face') < svg.indexOf('<text'), 'шрифт объявлен до текста');

      // тянем только те поднаборы, чьи символы встречаются в тексте
      const files = srv.hits.filter((u) => /\.woff2$/.test(u));
      assert.equal(files.length, 2, 'два поднабора: ' + files.join(', '));
      assert.ok(files.some((u) => u.includes('cyr-600')), 'кириллица нужна');
      assert.ok(files.some((u) => u.includes('lat-600')), 'латиница нужна (цифры)');
      assert.ok(!files.some((u) => u.includes('gre-')), 'греческий не тянем');
      assert.ok(srv.hits.some((u) => u.includes('wght@600')), 'просим ровно то начертание: ' + srv.hits[0]);

      // второй экспорт сети не трогает
      const before = srv.hits.length;
      await st.prepareFonts('ab');
      st.toSVG('ab');
      assert.equal(srv.hits.length, before, 'всё взято из кеша');
      assert.deepEqual(st.errors, []);
    });
  } finally { globalThis.fetch = had; }
});

test('экспорт без гарнитуры: снимок делается, но о расхождении сказано', async () => {
  const had = globalThis.fetch;
  try {
    const srv = fontServer('Fake Sans Beta', { failCss: true });
    srv.install();
    await withSvgDom(async () => {
      const st = fontScene('Fake Sans Beta', 'Планёрка');
      const prep = await st.prepareFonts('ab');
      assert.equal(prep.state, 'missing');
      assert.deepEqual(prep.missing, ['Fake Sans Beta']);
      const svg = st.toSVG('ab');
      assert.ok(!svg.includes('@font-face'), 'встраивать нечего');
      assert.equal(st.lastSVG.fonts, 'missing');
      assert.ok(svg.includes('<text'), 'сам текст в разметке остался');
    });

    // PNG всё равно снимается — но lastShot несёт причину расхождения
    await withFakeDom({}, async () => {
      const st = fontScene('Fake Sans Beta', 'Планёрка');
      st.toSVG = () => '<svg xmlns="http://www.w3.org/2000/svg"/>';
      const blob = await st.screenshot({ scale: 1 });
      assert.ok(blob && blob.size > 0, 'снимок не отменяется из-за шрифта');
      assert.equal(st.lastShot.fonts, 'missing');
      assert.deepEqual(st.lastShot.fontsMissing, ['Fake Sans Beta']);
      assert.deepEqual(st.errors, ['screenshot:fonts'], 'наружу сказано: ' + JSON.stringify(st.errors));
    });
  } finally { globalThis.fetch = had; }
});

test('встраивание гарнитур: чего не надо — не тянем', async () => {
  const had = globalThis.fetch;
  try {
    const srv = fontServer('Fake Sans Gamma');
    srv.install();
    await withFakeDom({}, async () => {
      // системная гарнитура: файла нет, и сети мы не касаемся
      const sys = fontScene('system-ui', 'Планёрка');
      sys.toSVG = () => '<svg xmlns="http://www.w3.org/2000/svg"/>';
      assert.equal((await sys.prepareFonts('ab')).state, 'none');
      const blob = await sys.screenshot({ scale: 1 });
      assert.ok(blob && blob.size > 0);
      assert.equal(sys.lastShot.fonts, 'none');
      assert.equal(sys.lastShot.fontsMissing, undefined);
      assert.deepEqual(srv.hits, [], 'сети не касались');
      assert.deepEqual(sys.errors, []);

      // артборд без текста — тоже нечего встраивать
      const bare = bareStage({ rects: { ab: { x: 0, y: 0, w: 100, h: 100 } } });
      bare.doc = scene(() => [ops.create(box('a', 'ab', 10, 10))]);
      bare.activeArtboard = 'ab';
      bare.geo = { rects: { ab: { x: 0, y: 0, w: 100, h: 100 }, a: { x: 0, y: 0, w: 10, h: 10 } }, lines: {}, order: ['ab', 'a'] };
      assert.equal((await bare.prepareFonts('ab')).state, 'none');

      // оболочка может выключить встраивание совсем
      const off = fontScene('Fake Sans Gamma', 'Планёрка');
      off.opts.embedFonts = false;
      assert.equal((await off.prepareFonts('ab')).state, 'off');
      assert.deepEqual(srv.hits, [], 'выключено — значит без сети');
    });
  } finally { globalThis.fetch = had; }
});

test('гарнитуры подтягиваются после отрисовки: синхронный экспорт SVG не ждёт сеть', async () => {
  const had = globalThis.fetch;
  try {
    const srv = fontServer('Fake Sans Delta');
    srv.install();
    await withSvgDom(async () => {
      const st = fontScene('Fake Sans Delta', 'Планёрка');
      st._timers = new Set();
      st._dead = false;
      // ждём, пока подтяжка уляжется: сперва стили, потом файлы начертаний
      const wait = async (ms = 500) => {
        const until = Date.now() + ms;
        let n = -1;
        while (Date.now() < until && (n !== srv.hits.length || srv.hits.length === 0)) {
          n = srv.hits.length;
          await new Promise((r) => setTimeout(r, 60));
        }
      };

      st._warmFonts();
      st._warmFonts();   // второй вызов до срабатывания ничего не планирует заново
      await wait();
      assert.ok(srv.hits.length >= 2, 'стили и файл скачаны: ' + srv.hits.length);
      const svg = st.toSVG('ab');
      assert.ok(svg.includes('src:url(data:font/woff2;base64,'), 'экспорт уже со шрифтом');
      assert.equal(st.lastSVG.fonts, 'embedded');

      // всё на месте — второй заход в сеть не идёт
      const n = srv.hits.length;
      st._warmFonts();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(srv.hits.length, n, 'повторных запросов нет');
    });

    // если не вышло — за тем же набором второй раз не ходим
    const bad = fontServer('Fake Sans Epsilon', { failCss: true });
    bad.install();
    await withSvgDom(async () => {
      const st = fontScene('Fake Sans Epsilon', 'Планёрка');
      st._timers = new Set();
      st._dead = false;
      const wait = () => new Promise((r) => setTimeout(r, 500));
      st._warmFonts();
      await wait();
      const n = bad.hits.length;
      assert.ok(n >= 1, 'попытка была');
      st._warmFonts();
      await wait();
      assert.equal(bad.hits.length, n, 'вторая попытка за тем же набором не делается');
      assert.equal(st.toSVG('ab').includes('@font-face'), false);
      assert.equal(st.lastSVG.fonts, 'missing');
    });
  } finally { globalThis.fetch = had; }
});

test('превью варианта шрифт с собой не тащит: он и так на странице', async () => {
  const had = globalThis.fetch;
  try {
    const srv = fontServer('Fake Sans Zeta');
    srv.install();
    await withSvgDom(async () => {
      const st = fontScene('Fake Sans Zeta', 'Планёрка');
      await st.prepareFonts('ab');

      // обычный экспорт — со шрифтом
      assert.ok(st.toSVG('ab').includes('@font-face'));
      assert.equal(st.lastSVG.fonts, 'embedded');

      // разметка чужого документа (так рисуются превью вариантов) — без него
      const other = st.toSVG('ab', st.doc, st.geo);
      assert.ok(!other.includes('@font-face'), 'в превью начертаний нет');
      assert.equal(st.lastSVG.fonts, 'skipped');
      assert.ok(!other.includes('data:font/woff2'), 'и файлов начертаний тоже');
      assert.ok(other.length < st.toSVG('ab').length, 'превью легче экспорта');

      // при желании можно и в превью
      assert.ok(st.toSVG('ab', st.doc, st.geo, { fonts: true }).includes('@font-face'));
      // и наоборот — выключить в экспорте
      assert.ok(!st.toSVG('ab', null, null, { fonts: false }).includes('@font-face'));
    });
  } finally { globalThis.fetch = had; }
});

/* --------------------- круг 13 --------------------- */

/**
 * Сцена «Шапка»: фрейм 150×52 в (20,60) внутри артборда 400×200. С `neighbor`
 * справа кромка-в-кромку стоит второй фрейм — он попадает в зону ручки «e»
 * первого, и вот по нему проброс клика как раз и нужен.
 */
function handleScene(neighbor) {
  const doc = scene(() => {
    const list = [
      ops.create(frame('head', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
        { w: { mode: 'fixed', value: 150 }, h: { mode: 'fixed', value: 52 } }, { pos: { x: 20, y: 60 } })),
      ops.create(label('cap', 'head', 'вторник'))
    ];
    if (neighbor) {
      list.push(ops.create(frame('side', 'ab', {},
        { w: { mode: 'fixed', value: 150 }, h: { mode: 'fixed', value: 52 } },
        { pos: { x: 170, y: 60 }, fill: '#eeeeee' })));
    }
    return list;
  });
  return { doc, geo: solve(doc, M) };
}

test('голый клик по ручке ресайза сохраняет выделение', () => {
  const { doc, geo } = handleScene(false);
  /** Нажать и отпустить в точке (px,py), не двигая мышь. */
  const tap = (owner, name, px, py, selection) => {
    const st = gestureStage(doc, geo, selection);
    st._schedulePreview = () => {};
    st._onPointerDown(pev(px, py, { target: { dataset: { handle: name, id: owner } } }));
    assert.equal(st._drag && st._drag.mode, 'resize', `ручка ${name}: нажатие начинает ресайз`);
    st._onPointerUp(pev(px, py));
    return st;
  };

  const zones = gestureStage(doc, geo, ['head'])._handles('head');
  assert.equal(zones.length, 8, 'у узла все восемь ручек');
  for (const z of zones) {
    // по всей зоне захвата, а не только по центру: видимая точка ручки стоит на
    // кромке узла, и три её четверти лежат ВНЕ него
    const pts = [
      [z.x + 0.5, z.y + 0.5],
      [z.x + z.w / 2, z.y + z.h / 2],
      [z.x + z.w - 0.5, z.y + z.h - 0.5],
      [z.x + z.w / 2, z.y + 0.5],
      [z.x + 0.5, z.y + z.h / 2]
    ];
    for (const [px, py] of pts) {
      const st = tap('head', z.name, px, py, ['head']);
      const where = `ручка ${z.name} в (${px.toFixed(1)},${py.toFixed(1)})`;
      assert.deepEqual(st.commits, [], where + ': голый клик не пишет в документ');
      assert.deepEqual(st.state.selection, ['head'], where + ': выделение осталось');
      assert.equal(st.selected, null, where + ': выделение даже не переизлучалось');
    }
  }

  // артборд: снаружи его кромки нет вообще ничего, и выделение не должно сниматься
  const abZones = gestureStage(doc, geo, ['ab'])._handles('ab');
  for (const z of abZones) {
    const st = tap('ab', z.name, z.x + z.w / 2, z.y + z.h / 2, ['ab']);
    assert.deepEqual(st.state.selection, ['ab'], `ручка артборда ${z.name}: выделение на месте`);
    assert.deepEqual(st.commits, []);
  }
});

test('голый клик по ручке всё же пробрасывается на настоящего соседа', () => {
  const { doc, geo } = handleScene(true);
  const st = gestureStage(doc, geo, ['head']);
  st._schedulePreview = () => {};
  // зона ручки «e» выходит за правую кромку head — там уже стоит side
  const zone = st._handles('head').find((h) => h.name === 'e');
  const px = geo.rects.side.x + 5;
  assert.ok(px > zone.x && px < zone.x + zone.w, 'точка внутри зоны ручки: ' + px);
  st._onPointerDown(pev(px, zone.y + zone.h / 2, { target: { dataset: { handle: 'e', id: 'head' } } }));
  st._onPointerUp(pev(px, zone.y + zone.h / 2));
  assert.deepEqual(st.selected, ['side'], 'клик по соседу выделяет соседа');
  assert.deepEqual(st.commits, [], 'и ничего не коммитит');
});

/** Колонка критика: высокий блок 214 px и два соседа по 60. */
function tallColumnScene() {
  const doc = scene(() => [
    ops.create(frame('col', 'ab', { mode: 'column', gap: 10 },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'hug' } })),
    ops.create(box('tall', 'col', 180, 214)),
    ops.create(box('b', 'col', 180, 60)),
    ops.create(box('c', 'col', 180, 60))
  ]);
  return { doc, geo: solve(doc, M) };
}

test('перестановка идёт за призраком, а не за курсором', () => {
  const { doc, geo } = tallColumnScene();
  const grab = geo.rects.tall.y + 20;   // взяли высокий блок за верх
  const drag = (dy) => {
    const st = gestureStage(doc, geo, ['tall']);
    const d = { mode: 'move', id: 'tall', start: { x: 50, y: grab }, rect0: { ...geo.rects.tall } };
    st._updateMove(d, { x: 50, y: grab + dy }, {});
    return { st, d };
  };

  // 120 px вниз: призрак стоит ниже обоих соседей — значит и место вставки там же
  const far = drag(120);
  assert.equal(far.d.result.kind, 'move');
  assert.equal(far.d.result.index, 2, 'блок встаёт последним');
  far.st._commitMove(far.d);
  assert.equal(far.st.commits.length, 1, 'жест не молчит');
  const res = applyOps(doc, far.st.commits[0].ops);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.doc.nodes.col.children, ['b', 'c', 'tall']);

  // 20 px вниз: блок остался в своём слоте — ни линии в чужом месте, ни коммита
  const near = drag(20);
  assert.equal(near.d.result.index, 0, 'место вставки — своё же');
  near.st._commitMove(near.d);
  assert.deepEqual(near.st.commits, [], 'порядок не изменился — коммитить нечего');

  // и дальше крайнего слота призрак не уезжает: вставать там всё равно некуда
  {
    const st = gestureStage(doc, geo, ['tall']);
    const moved = [];
    st._ghost = (id, gx, gy) => moved.push({ gx, gy });
    const d = { mode: 'move', id: 'tall', start: { x: 50, y: grab }, rect0: { ...geo.rects.tall } };
    st._updateMove(d, { x: 50, y: grab + 400 }, {});
    assert.equal(d.result.index, 2, 'место вставки — последнее');
    assert.equal(moved.length, 1);
    assert.ok(moved[0].gy <= 140.01, 'призрак остановился на последнем слоте: ' + moved[0].gy);
    assert.ok(Math.abs(st._insertion.y1 - (geo.rects.tall.y + moved[0].gy)) <= 10,
      'и линия вставки рядом с ним: ' + st._insertion.y1);
  }

  // призрак и линия вставки не расходятся: линия идёт за ведущей кромкой призрака
  for (let dy = 5; dy <= 140; dy += 5) {
    const { st } = drag(dy);
    assert.ok(st._insertion, 'линия вставки показана при dy=' + dy);
    const lead = geo.rects.tall.y + dy;
    assert.ok(Math.abs(st._insertion.y1 - lead) <= 45,
      `dy=${dy}: линия на ${st._insertion.y1}, кромка призрака на ${lead}`);
  }
});

test('перестановка в строке считает слоты по той же оси', () => {
  const doc = scene(() => [
    ops.create(frame('row', 'ab', { mode: 'row', gap: 10 },
      { w: { mode: 'hug' }, h: { mode: 'fixed', value: 60 } })),
    ops.create(box('wide', 'row', 160, 40)),
    ops.create(box('b', 'row', 40, 40)),
    ops.create(box('c', 'row', 40, 40))
  ]);
  const geo = solve(doc, M);
  const grab = geo.rects.wide.x + 20;
  const st = gestureStage(doc, geo, ['wide']);
  const d = { mode: 'move', id: 'wide', start: { x: grab, y: 20 }, rect0: { ...geo.rects.wide } };
  // 90 px вправо: широкий блок прошёл оба соседа, хотя курсор не дотянул до середины первого
  st._updateMove(d, { x: grab + 90, y: 20 }, {});
  assert.equal(d.result.index, 2, 'встаёт последним');
  st._commitMove(d);
  const res = applyOps(doc, st.commits[0].ops);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.doc.nodes.row.children, ['b', 'c', 'wide']);

  // а на 10 px — никуда: свой слот ближе
  const near = gestureStage(doc, geo, ['wide']);
  const d2 = { mode: 'move', id: 'wide', start: { x: grab, y: 20 }, rect0: { ...geo.rects.wide } };
  near._updateMove(d2, { x: grab + 10, y: 20 }, {});
  assert.equal(d2.result.index, 0);
  near._commitMove(d2);
  assert.deepEqual(near.commits, [], 'порядок не изменился — коммита нет');
});

test('бейдж размера не ложится на подпись артборда', () => {
  const had = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, textContent: '', className: '' }) };
  try {
    const doc = scene(() => [ops.create(box('in', 'ab', 100, 40))]);
    const rects = { ab: { x: 0, y: 0, w: 400, h: 200 }, in: { x: 0, y: 0, w: 100, h: 40 } };
    // область просмотра чуть шире артборда: по бокам бейджу места нет, и он идёт наверх
    const mk = () => {
      const st = Object.create(Stage.prototype);
      st.ui = { appendChild() {} };
      st.el = { clientWidth: 420, clientHeight: 700 };
      st.view = { zoom: 1, pan: { x: 0, y: 0 } };
      st.doc = doc;
      st.geo = { rects, lines: {}, order: ['ab', 'in'] };
      return st;
    };
    const at = (b) => ({ x: parseFloat(b.style.left), y: parseFloat(b.style.top) });
    const sr = { x: 10, y: 100, w: 400, h: 200 };

    const st = mk();
    const band = st._labelBand('ab', sr);
    assert.ok(band && band.w > 0, 'над кромкой артборда лежит его имя');
    const p = at(st._badge('960 × 560', sr, '', 0, band));
    const W = 66;   // «960 × 560» — 9 знаков
    const onLabel = p.x < sr.x + band.w && p.x + W > sr.x && p.y < band.y2 && p.y + 17 > band.y1;
    assert.ok(!onLabel, 'бейдж не накрыл подпись: ' + JSON.stringify({ p, band }));
    assert.ok(p.y + 17 <= sr.y || p.y >= sr.y + sr.h, 'и не залез на содержимое макета: ' + p.y);

    // у обычного узла подписи над кромкой нет — бейдж остаётся у левого края
    assert.equal(mk()._labelBand('in', sr), null, 'не артборд — полоса свободна');
    const q = at(mk()._badge('960 × 560', sr, '', 0, null));
    assert.ok(Math.abs(q.x - sr.x) < 0.51, 'без подписи бейдж по левой кромке: ' + q.x);
  } finally {
    globalThis.document = had;
  }
});

test('правка текста не съедает осмысленные неразрывные пробелы', () => {
  const NB = ' ';
  const mk = (original, typed) => {
    const doc = scene(() => [ops.create(label('t', 'ab', original))]);
    const geo = solve(doc, M);
    const st = gestureStage(doc, geo, ['t']);
    st._editing = { id: 't', el: { innerText: typed, parentNode: null }, original };
    st._commitEdit();
    return st.commits;
  };

  // между словами и цифрами неразрывный пробел осмысленный — он остаётся
  const keep = mk(`Итого: 1${NB}240${NB}₽`, `Итого: 1${NB}240${NB}₽ за день`);
  assert.equal(keep.length, 1, 'правка закоммичена');
  assert.equal(keep[0].ops[0].value, `Итого: 1${NB}240${NB}₽ за день`, 'неразрывные пробелы на месте');
  // и даже если такого пробела в исходном тексте не было: его набрали руками
  const typed = mk('5 шагов', `5${NB}шагов`);
  assert.equal(typed[0].ops[0].value, `5${NB}шагов`, 'набранный руками пробел не разжимаем');

  // а что подставил contenteditable вместо схлопнувшегося пробела — разжимаем:
  // это конец строки и второй пробел подряд
  const drop = mk('Планёрка по редактору', `Планёрка ${NB}по редактору${NB}`);
  assert.equal(drop.length, 1);
  assert.equal(drop[0].ops[0].value, 'Планёрка  по редактору ', 'подставленные — обычные пробелы');

  // текст не изменился — коммита нет (и неразрывные пробелы этого не путают)
  assert.deepEqual(mk(`1${NB}240`, `1${NB}240`), [], 'без правок ничего не пишем');
});

test('предел кеша начертаний считается от размера запроса, а не числом 24', async () => {
  const had = globalThis.fetch;
  try {
    const families = [];
    for (let i = 0; i < 9; i++) families.push('Fake Cache ' + 'ABCDEFGHI'[i]);
    const hits = [];
    // сервер как fontServer, но на любое семейство: 3 поднабора на каждое
    const SUBSETS = [
      ['cyrillic', 'U+0301, U+0400-045F', 'cyr'],
      ['greek', 'U+0370-0377, U+037A-037F', 'gre'],
      ['latin', 'U+0000-00FF, U+0131', 'lat']
    ];
    globalThis.fetch = async (url) => {
      const s = String(url);
      hits.push(s);
      if (/css2/.test(s)) {
        const fam = decodeURIComponent(/family=([^:&]+)/.exec(s)[1]).replace(/\+/g, ' ');
        return {
          ok: true, status: 200,
          text: async () => SUBSETS.map(([name, range, tag]) =>
            `/* ${name} */\n@font-face {\n  font-family: '${fam}';\n  font-style: normal;\n`
            + `  font-weight: 600;\n  font-display: swap;\n`
            + `  src: url(https://fonts.gstatic.test/s/${fam.replace(/ /g, '')}/${tag}.woff2) format('woff2');\n`
            + `  unicode-range: ${range};\n}`).join('\n')
        };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer };
    };

    // текст задевает все три поднабора (кириллица, греческий, латиница) — иначе
    // по диапазонам отберётся меньше файлов, и предел кеша не при чём
    const text = 'Планёрка \u0374 ';
    const doc = scene(() => families.map((f, i) => ops.create(label('t' + i, 'ab', text + i, {
      style: { token: 'body', font: f, fontWeight: 600 },
      size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } }
    }))));
    const geo = solve(doc, M);
    const st = bareStage({ rects: geo.rects });
    st.doc = doc;
    st.geo = geo;
    st.activeArtboard = 'ab';
    st.errors = [];
    st.opts = { onError: (i) => st.errors.push(i.where) };

    // 9 гарнитур × 3 поднабора = 27 файлов: при пределе 24 последние вытесняли первые
    const prep = await st.prepareFonts('ab');
    assert.deepEqual(prep.missing, [], 'все девять гарнитур встроены: ' + prep.missing.join(', '));
    assert.equal(prep.state, 'embedded', 'и состояние честное, а не partial');
    assert.deepEqual(st.errors, []);
  } finally {
    globalThis.fetch = had;
  }
});

test('минимумы и максимумы считаются без spread: сотни тысяч элементов не рушат стек', () => {
  const N = 150000;   // выше 130 000 `Math.max(...arr)` роняет стек

  // 1) fitTo по всем артбордам
  const rects = {};
  const ids = [];
  for (let i = 0; i < N; i++) {
    const id = 'a' + i;
    ids.push(id);
    rects[id] = { x: i, y: i * 2, w: 10, h: 5 };
  }
  const st = bareStage({ rects });
  assert.doesNotThrow(() => st.fitTo(ids));
  assert.ok(st.view.zoom > 0 && st.view.zoom <= 2, 'вид посчитан: ' + st.view.zoom);

  // 2) раскладка с переносом: строк столько же, сколько детей
  const nodes = { page: { type: 'page', id: 'page', parent: null, children: ['ab'] } };
  const kids = [];
  for (let i = 0; i < N; i++) {
    const id = 'r' + i;
    kids.push(id);
    nodes[id] = {
      type: 'rect', id, name: id, parent: 'ab', radius: 0, fill: '#cccccc',
      size: { w: { mode: 'fixed', value: 50 }, h: { mode: 'fixed', value: 10 } }
    };
  }
  nodes.ab = {
    type: 'frame', id: 'ab', name: 'Артборд', parent: 'page', children: kids, radius: 0,
    pos: { x: 0, y: 0 }, fill: '#ffffff',
    size: { w: { mode: 'fixed', value: 50 }, h: { mode: 'hug' } },
    layout: { mode: 'row', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: true }
  };
  const big = { root: 'page', nodes, tokens: {}, version: 1 };
  let geo;
  assert.doesNotThrow(() => { geo = solve(big, M); });
  assert.equal(geo.rects.ab.h, N * 10, 'каждый ребёнок на своей строке');

  // 3) отмена удаления фрейма: инверсия — по create-операции на каждый узел
  // поддерева, и `out.push(...chunk)` роняло стек вместе с возможностью отменить
  let back;
  assert.doesNotThrow(() => { back = invertOps(big, [ops.remove('ab')]); });
  assert.equal(back.length, N + 1, 'по операции на каждый узел поддерева');
  assert.equal(back[0].op, 'create');
  assert.equal(back[0].node.id, 'ab', 'фрейм создаётся первым — детям нужен родитель');

  // 4) поиск по частичному имени среди сотен тысяч узнаваемых имён
  const many = { page: { type: 'page', id: 'page', parent: null, children: [] } };
  for (let i = 0; i < N; i++) {
    const id = 'n' + i;
    many.page.children.push(id);
    many[id] = { type: 'rect', id, name: 'Карточка ' + i, parent: 'page' };
  }
  const flat = { root: 'page', nodes: many, tokens: {}, version: 1 };
  assert.doesNotThrow(() => resolveTarget(flat, 'карточка'));
});

test('имя-заглушка узла одно на сцену и на оболочку', () => {
  const doc = scene(() => [
    ops.set('ab', 'name', ''),
    ops.create(frame('grp', 'ab', {}, { w: { mode: 'hug' }, h: { mode: 'hug' } }, { name: '' })),
    ops.create(label('t', 'grp', 'Текст без имени', { name: '' }))
  ]);
  // круг 18: человек называет их досками, и весь интерфейс перешёл на это слово
  assert.equal(placeholderName(doc, doc.nodes.ab), 'Доска', 'доска — «Доска», а не «Группа»');
  assert.equal(placeholderName(doc, doc.nodes.grp), 'Группа', 'фрейм внутри доски — «Группа»');
  assert.equal(placeholderName(doc, 'grp'), 'Группа', 'можно и по id');
  assert.equal(placeholderName(doc, doc.nodes.t), 'Текст');
  assert.equal(displayName(doc, doc.nodes.ab), 'Доска', 'без имени — заглушка');
  assert.equal(displayName(doc, doc.nodes.grp), 'Группа');
  assert.equal(displayName(doc, { id: 'x', type: 'frame', name: 'Карточка встречи' }), 'Карточка встречи');
  assert.equal(placeholderName(null, null), 'Узел', 'мусор на входе не роняет');

  // подпись на холсте берёт то же самое имя
  return withSvgDom(() => {
    globalThis.document.createDocumentFragment = () => ({
      children: [], appendChild(c) { this.children.push(c); return c; }
    });
    const rects = { ab: { x: 0, y: 0, w: 400, h: 200 }, grp: { x: 0, y: 0, w: 10, h: 10 }, t: { x: 0, y: 0, w: 10, h: 10 } };
    const st = bareStage({ rects });
    st.doc = doc;
    st.geo = { rects, lines: { t: [] }, order: ['ab', 'grp', 't'] };
    st.svg = { firstChild: null, appendChild() {}, removeChild() {} };
    st._renderGrid = () => {};
    st._renderSVG();
    assert.equal(st._labels.length, 1);
    assert.equal(st._labels[0].text, displayName(doc, doc.nodes.ab), 'подпись артборда — та же заглушка');
  });
});

test('три параллельных prepareFonts — один запрос стилей (регрессия круга 11)', async () => {
  const had = globalThis.fetch;
  try {
    const srv = fontServer('Fake Sans Parallel');
    srv.install();
    await withSvgDom(async () => {
      const st = fontScene('Fake Sans Parallel', 'Планёрка');
      const res = await Promise.all([st.prepareFonts('ab'), st.prepareFonts('ab'), st.prepareFonts('ab')]);
      for (const r of res) assert.equal(r.state, 'embedded', 'каждый вызов вернул готовое встраивание');
      const css = srv.hits.filter((u) => /css2/.test(u));
      assert.equal(css.length, 1, 'стили скачаны один раз: ' + css.length);
      const files = srv.hits.filter((u) => /\.woff2$/.test(u));
      assert.equal(new Set(files).size, files.length, 'и каждый файл начертания — тоже по одному разу');
    });
  } finally { globalThis.fetch = had; }
});

/* --------------------- круг 15 --------------------- */

test('текст в рамке: прямоугольник и строки согласованы при любых align × size.w', () => {
  const LONG = 'Дальше сегодня и ещё очень длинный хвост, который точно не влезает в мобильный экран';
  const widths = [{ mode: 'hug' }, { mode: 'fill' }, { mode: 'fixed', value: 120 }];
  for (const mode of ['column', 'row']) {
    for (const align of ['start', 'center', 'end', 'stretch']) {
      for (const w of widths) {
        const tag = `${mode}/${align}/${w.mode}`;
        const doc = scene(() => [
          ops.set('ab', 'size', { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } }),
          ops.set('ab', 'layout', { mode, gap: 8, padding: { t: 20, r: 20, b: 20, l: 20 }, align, justify: 'start', wrap: false }),
          ops.create(label('t', 'ab', LONG, { size: { w, h: { mode: 'hug' } } }))
        ]);
        const geo = solve(doc, M);
        const rect = geo.rects.t;
        const lines = geo.lines.t;
        const style = resolveTextStyle(doc, doc.nodes.t);
        const widest = lines.reduce((s, l) => Math.max(s, measureText(l, style)), 0);
        const needH = lines.length * style.lineHeight;
        // главное: рамка не обещает меньше, чем занимают строки — иначе бейдж,
        // хит-тест и экспорт видят одно, а человек другое
        assert.ok(widest <= rect.w + 0.5, `${tag}: строка шире рамки — ${widest} > ${rect.w}`);
        assert.ok(needH <= rect.h + 0.5, `${tag}: ${lines.length} строк не влезают в ${rect.h}`);
        // в колонке высота идёт по главной оси — она всегда по содержимому
        if (mode === 'column') {
          assert.ok(Math.abs(rect.h - needH) < 0.51, `${tag}: высота ${rect.h} не по ${lines.length} строкам`);
        }
        const bad = validate(doc, geo, M).filter((i) => i.nodeId === 't' && i.code === 'overflow');
        assert.deepEqual(bad, [], `${tag}: ${JSON.stringify(bad)}`);
      }
    }
  }
});

test('колонка + stretch: текст «по содержимому» переносится по ширине рамки', () => {
  const LONG = 'Дальше сегодня и ещё очень длинный хвост, который точно не влезает в мобильный экран';
  const doc = scene(() => [
    ops.set('ab', 'size', { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } }),
    ops.set('ab', 'layout', { mode: 'column', gap: 8, padding: { t: 20, r: 20, b: 20, l: 20 }, align: 'stretch', justify: 'start', wrap: false }),
    ops.create(label('hug', 'ab', LONG)),
    ops.create(label('fil', 'ab', LONG, { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }))
  ]);
  const geo = solve(doc, M);
  // 84 знака по 7,5 px — 630 px натуральной ширины, в 350 это две строки
  assert.deepEqual(geo.rects.hug, { x: 20, y: 20, w: 350, h: 44 }, JSON.stringify(geo.rects.hug));
  assert.equal(geo.lines.hug.length, 2, 'строк: ' + JSON.stringify(geo.lines.hug));
  // растянутый hug и fill дают одно и то же: обе схемы означают «во всю ширину»
  assert.equal(geo.rects.fil.w, geo.rects.hug.w);
  assert.equal(geo.rects.fil.h, geo.rects.hug.h);
  assert.deepEqual(geo.lines.fil, geo.lines.hug);
  assert.equal(geo.rects.ab.h, 20 + 44 + 8 + 44 + 20, 'артборд считает высоту по переносам');
  // короткий текст переносить нечего: знаки в geo.lines остаются как набраны
  const short = applyOps(doc, [ops.set('hug', 'characters', 'Итого:  1 240 ₽')]);
  assert.equal(short.error, undefined);
  const g2 = solve(short.doc, M);
  assert.deepEqual(g2.lines.hug, ['Итого:  1 240 ₽'], 'двойной пробел на месте');
  assert.equal(g2.rects.hug.w, 350, 'а рамка всё равно во всю ширину');
});

test('отсоединённый текст: прикреплённая ширина переносит строки, высота идёт за ними', () => {
  const LONG = 'Дальше сегодня и ещё очень длинный хвост, который точно не влезает';
  const doc = scene(() => [
    ops.set('ab', 'layout', { mode: 'column', gap: 8, padding: { t: 10, r: 10, b: 10, l: 10 }, align: 'start', justify: 'start', wrap: false }),
    ops.create(label('t', 'ab', LONG, { override: { x: 20, y: 20, w: 150 } }))
  ]);
  const geo = solve(doc, M);
  const style = resolveTextStyle(doc, doc.nodes.t);
  const rect = geo.rects.t;
  const lines = geo.lines.t;
  assert.equal(rect.w, 150, 'ширина — та, что прикрепили');
  assert.ok(lines.length > 1, 'строки перенесены: ' + JSON.stringify(lines));
  assert.ok(Math.abs(rect.h - lines.length * style.lineHeight) < 0.51, `высота ${rect.h} не по ${lines.length} строкам`);
  const widest = lines.reduce((s, l) => Math.max(s, measureText(l, style)), 0);
  assert.ok(widest <= rect.w + 0.5, 'ни одна строка не шире рамки: ' + widest);
  assert.deepEqual(validate(doc, geo, M).filter((i) => i.nodeId === 't' && i.code === 'overflow'), []);
});

/** Поддельный contenteditable: помнит слушателей, отдаёт innerText и умеет focusout. */
function fakeEditable() {
  return {
    style: {}, className: '', contentEditable: '', spellcheck: true, textContent: '',
    parentNode: null, listeners: new Map(), focused: 0,
    get innerText() { return this.textContent; },
    set innerText(v) { this.textContent = v; },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    contains(n) { return n === this; },
    focus() { this.focused += 1; },
    fire(type, ev) {
      let prevented = false;
      const e = { type, preventDefault: () => { prevented = true; }, stopPropagation: () => {}, ...ev };
      for (const fn of this.listeners.get(type) || []) fn(e);
      return prevented;
    }
  };
}

/** Сцена с живым инлайн-редактором: DOM подменён, _startEdit настоящий. */
function editStage(text = 'Дальше сегодня') {
  const doc = scene(() => [ops.create(label('t', 'ab', text))]);
  const geo = solve(doc, M);
  const st = gestureStage(doc, geo, ['t']);
  st.ui = { children: [], appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; } };
  st.el.focus = () => { st.canvasFocused = (st.canvasFocused || 0) + 1; };
  st._paintUI = () => {};
  st._screenRect = () => ({ x: 10, y: 20, w: 100, h: 22 });
  return st;
}

function withEditDom(fn) {
  const had = globalThis.document;
  globalThis.document = { createElement: () => fakeEditable() };
  try { return fn(); } finally { globalThis.document = had; }
}

test('инлайн-правка текста: Enter применяет, Shift+Enter переносит строку', () => {
  withEditDom(() => {
    const st = editStage();
    st._startEdit(st.doc.nodes.t);
    const ed = st._editing.el;
    assert.ok(ed, 'редактор открыт');
    ed.innerText = 'Дальше сегодня и ещё хвост';

    // Shift+Enter — перенос строки: редактор остаётся открыт, коммита нет
    assert.equal(ed.fire('keydown', { key: 'Enter', shiftKey: true }), false, 'перенос не перехвачен');
    assert.ok(st._editing, 'редактор ещё открыт');
    assert.deepEqual(st.commits, []);

    // Enter во время набора через IME подтверждает подсказку словаря, а не правку
    assert.equal(ed.fire('keydown', { key: 'Enter', isComposing: true }), false, 'IME не перехвачен');
    assert.ok(st._editing, 'редактор открыт');

    // голый Enter — «готово»
    assert.equal(ed.fire('keydown', { key: 'Enter' }), true, 'Enter перехвачен');
    assert.equal(st._editing, null, 'редактор закрыт');
    assert.equal(st.commits.length, 1, 'правка закоммичена: ' + JSON.stringify(st.commits));
    assert.equal(st.commits[0].ops[0].value, 'Дальше сегодня и ещё хвост');
    assert.equal(ed.parentNode, null, 'элемент снят со страницы');
  });
});

test('инлайн-правка текста: Ctrl+Enter применяет, Esc отменяет, подсказка это обещает', () => {
  withEditDom(() => {
    // Ctrl/Cmd+Enter остаётся — мышечная память прошлых кругов
    const a = editStage();
    a._startEdit(a.doc.nodes.t);
    a._editing.el.innerText = 'Через Ctrl';
    assert.equal(a._editing.el.fire('keydown', { key: 'Enter', ctrlKey: true }), true);
    assert.equal(a.commits.length, 1);

    // Esc отменяет — и об этом сказано заранее, подписью у редактора
    const b = editStage();
    b._startEdit(b.doc.nodes.t);
    const hint = b.ui.children.find((c) => c !== b._editing.el);
    assert.ok(hint, 'подпись-подсказка есть: ' + b.ui.children.length);
    assert.match(hint.textContent, /Enter/, 'подсказка про Enter: ' + hint.textContent);
    assert.match(hint.textContent, /Esc/, 'подсказка про Esc: ' + hint.textContent);
    b._editing.el.innerText = 'Набрано и брошено';
    assert.equal(b._editing.el.fire('keydown', { key: 'Escape' }), true);
    assert.equal(b._editing, null, 'редактор закрыт');
    assert.deepEqual(b.commits, [], 'ничего не закоммичено');
    assert.deepEqual(b.ui.children, [], 'подсказка снята вместе с редактором');
  });
});

test('инлайн-правка текста: уход фокуса за холст применяет правку', () => {
  withEditDom(() => {
    const st = editStage();
    st._startEdit(st.doc.nodes.t);
    const ed = st._editing.el;
    ed.innerText = 'Ушли в командную строку';
    // фокус уехал в чужое поле — редактор не должен висеть над макетом
    ed.fire('focusout', { relatedTarget: { tagName: 'INPUT' } });
    assert.equal(st._editing, null, 'редактор закрыт');
    assert.equal(st.commits.length, 1, 'правка не потерялась: ' + JSON.stringify(st.commits));
    assert.equal(st.commits[0].ops[0].value, 'Ушли в командную строку');

    // повторный focusout по уже закрытому редактору ничего не коммитит
    ed.fire('focusout', { relatedTarget: null });
    assert.equal(st.commits.length, 1);

    // фокус остался внутри самого редактора — правка продолжается
    const keep = editStage();
    keep._startEdit(keep.doc.nodes.t);
    const el2 = keep._editing.el;
    el2.fire('focusout', { relatedTarget: el2 });
    assert.ok(keep._editing, 'редактор открыт');
    assert.deepEqual(keep.commits, []);
  });
});

test('toSVG: подмена адресов картинок приходит параметром и живёт один вызов', async () => {
  await withSvgDom(() => {
    const doc = scene(() => [ops.create({
      type: 'image', id: 'pic', name: 'Фото', parent: 'ab', src: 'https://example.test/ok.png',
      size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } }
    })]);
    const geo = solve(doc, M);
    const st = bareStage({ rects: geo.rects });
    st.doc = doc;
    st.geo = geo;
    st.activeArtboard = 'ab';
    st.errors = [];
    st.opts = { onError: (i) => st.errors.push(i.where) };
    const map = new Map([['https://example.test/ok.png', 'data:image/png;base64,AAAA']]);
    const withMap = st.toSVG('ab', undefined, undefined, { srcMap: map });
    assert.match(withMap, /data:image\/png;base64,AAAA/, 'адрес подменён');
    assert.ok(!st._srcMap, 'в состоянии сцены подмена не осталась');
    const plain = st.toSVG('ab');
    assert.match(plain, /https:\/\/example\.test\/ok\.png/, 'без параметра — исходный адрес');
    assert.deepEqual(st.errors, []);
  });
});

test('screenshot(): два снимка подряд не перетирают друг другу отчёт', async () => {
  await withFakeDom({}, async () => {
    const st = Object.create(Stage.prototype);
    st.errors = [];
    st.opts = { onError: (i) => st.errors.push(i.where) };
    st.activeArtboard = 'ab';
    st.geo = { rects: { ab: { x: 0, y: 0, w: 400, h: 300 }, ab2: { x: 0, y: 0, w: 800, h: 300 } }, lines: {}, order: [] };
    const seen = [];
    st.toSVG = function (id) {
      seen.push({ id, shot: this.lastShot });
      return '<svg xmlns="http://www.w3.org/2000/svg"/>';
    };
    const both = await Promise.all([
      st.screenshot({ scale: 1, artboardId: 'ab' }),
      st.screenshot({ scale: 1, artboardId: 'ab2' })
    ]);
    for (const b of both) assert.ok(b && b.size > 0, 'оба снимка сделаны');
    assert.deepEqual(seen.map((s) => s.id), ['ab', 'ab2'], 'вызовы сериализованы');
    assert.notEqual(seen[0].shot, seen[1].shot, 'у каждого снимка свой отчёт');
    assert.deepEqual([seen[0].shot.w, seen[1].shot.w], [400, 800], 'и свой размер');
    assert.equal(seen[0].shot.ok, true, 'успех первого записан в его отчёт');
    assert.equal(seen[1].shot.ok, true);
    assert.equal(st.lastShot, seen[1].shot, 'lastShot — последний снимок');
    assert.deepEqual(st.errors, []);
  });
});

/* ------------------------------ круг 16 ------------------------------ */

/** Узел демо-документа по имени. */
const byName = (doc, name) => doc.nodes[Object.keys(doc.nodes).find((k) => doc.nodes[k].name === name)];
/** Отпечаток видимой части документа — как его считают оболочка и мозг (ключи по алфавиту). */
function fingerprint(doc) {
  const stable = (v) => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  };
  return Object.keys(doc.nodes).sort().map((id) => id + '=' + stable(doc.nodes[id])).join('|')
    + '|tokens=' + stable(doc.tokens);
}

test('круг16 п.1: правка тем же значением не меняет ни форму поля, ни отпечаток документа', () => {
  const doc = createDoc();
  const head = byName(doc, 'Заголовок сводки');
  const avatar = byName(doc, 'Аватар');
  const mark = byName(doc, 'Метка');
  const screen = byName(doc, 'Маршрут дня');
  // в демо-документе одно и то же по-разному: стиль и обводка объектом, заливка строкой
  assert.deepEqual(head.style, { token: 'display' });
  assert.deepEqual(avatar.stroke, { color: 'line', width: 1 });
  assert.equal(screen.fill, 'surface');

  // строка поверх объекта: модель говорит «display», а в узле {token:'display'}
  const same = applyOps(doc, [
    ops.set(head.id, 'style', 'display'),
    ops.set(avatar.id, 'stroke', 'line'),
    ops.set(mark.id, 'style', 'caption'),
    ops.set(screen.id, 'fill', { token: 'surface' })   // объект поверх строки — из инспектора
  ]);
  assert.equal(same.error, undefined, JSON.stringify(same.error));
  assert.equal(fingerprint(same.doc), fingerprint(doc), 'отпечаток документа не изменился');
  assert.deepStrictEqual(same.doc.nodes[head.id].style, { token: 'display' }, 'стиль остался объектом');
  assert.deepStrictEqual(same.doc.nodes[avatar.id].stroke, { color: 'line', width: 1 }, 'толщина обводки цела');
  assert.deepStrictEqual(same.doc.nodes[mark.id].style, mark.style, 'точечные переопределения стиля целы');
  assert.equal(same.doc.nodes[screen.id].fill, 'surface', 'заливка осталась строкой');
  assert.equal(hashGeometry(solve(same.doc, M)), hashGeometry(solve(doc, M)), 'геометрия та же');

  // настоящая смена значения проходит как обычно и отменяется точно
  for (const [id, path, value] of [
    [head.id, 'style', 'title'], [avatar.id, 'stroke', 'accent'],
    [screen.id, 'fill', { token: 'accentSoft' }], [mark.id, 'style', 'display']
  ]) {
    const list = [ops.set(id, path, value)];
    const inv = invertOps(doc, list);
    const after = applyOps(doc, list);
    assert.equal(after.error, undefined, JSON.stringify(after.error));
    assert.notEqual(fingerprint(after.doc), fingerprint(doc), `${path}=${JSON.stringify(value)} — это правка`);
    const back = applyOps(after.doc, inv);
    assert.equal(back.error, undefined, JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes[id], doc.nodes[id], `отмена вернула ${path} в прежней форме`);
  }

  // вложенные пути и снятие поля работают как раньше
  const nested = applyOps(doc, [
    ops.set(head.id, 'style.token', 'title'),
    ops.set(avatar.id, 'stroke.width', 2),
    ops.set(avatar.id, 'stroke.color', 'accent')
  ]);
  assert.equal(nested.error, undefined, JSON.stringify(nested.error));
  assert.deepEqual(nested.doc.nodes[head.id].style, { token: 'title' });
  assert.deepEqual(nested.doc.nodes[avatar.id].stroke, { color: 'accent', width: 2 });
  const unset = applyOps(doc, [ops.set(avatar.id, 'stroke'), ops.set(screen.id, 'fill')]);
  assert.equal(unset.error, undefined, JSON.stringify(unset.error));
  assert.ok(!('stroke' in unset.doc.nodes[avatar.id]), 'обводка снята');
  assert.ok(!('fill' in unset.doc.nodes[screen.id]), 'заливка снята');
  assert.deepEqual(validate(unset.doc, solve(unset.doc, M), M).filter((v) => v.nodeId === avatar.id), [],
    'снятая обводка не даёт нарушений');

  // поле, которого не было, кладётся так, как прислали
  const fresh = applyOps(doc, [ops.set(mark.id, 'color', 'accent')]);
  assert.equal(fresh.doc.nodes[mark.id].color, 'accent');
});

test('круг16 п.3: отмена set layout.* не дописывает раскладку фрейму, у которого её не было', () => {
  let doc = createDoc('empty');
  const r = applyOps(doc, [{
    op: 'create',
    node: {
      type: 'frame', id: 'f', name: 'ф', parent: doc.root, children: [], pos: { x: 0, y: 0 },
      size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } }
    }
  }]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  doc = r.doc;
  assert.equal(doc.nodes.f.layout, undefined, 'у фрейма нет поля layout');

  for (const list of [
    [ops.set('f', 'layout.padding.t', 12)],
    [ops.set('f', 'layout.gap', 8)],
    [ops.set('f', 'layout', { mode: 'row', gap: 4 })]
  ]) {
    const inv = invertOps(doc, list);
    const after = applyOps(doc, list);
    assert.equal(after.error, undefined, JSON.stringify(after.error));
    assert.equal(after.doc.nodes.f.layout.mode, list[0].path === 'layout' ? 'row' : 'none', 'раскладка нормализована');
    const back = applyOps(after.doc, inv);
    assert.equal(back.error, undefined, JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes.f, doc.nodes.f, 'отмена вернула узел ровно как было: ' + JSON.stringify(list));
    assert.ok(!('layout' in back.doc.nodes.f), 'ключа layout снова нет');
  }

  // а у фрейма С раскладкой set layout=<объект> по-прежнему нормализует значение
  const withL = applyOps(doc, [ops.set('f', 'layout', { mode: 'column', padding: 8 })]);
  assert.deepEqual(withL.doc.nodes.f.layout,
    { mode: 'column', gap: 0, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'start', justify: 'start', wrap: false });
  // и явное снятие поля снимает его
  const gone = applyOps(withL.doc, [ops.set('f', 'layout')]);
  assert.ok(!('layout' in gone.doc.nodes.f), 'раскладка снимается, а не восстанавливается по умолчанию');
  assert.equal(solve(gone.doc, M).rects.f.w, 100, 'решатель без layout работает как с DEFAULT_LAYOUT');
});

test('круг16 п.2: ребёнок потока, съевший отступ контейнера, даёт padding-eaten', () => {
  /** Контейнер 100×100 с отступами pad и ребёнок 90×40 внутри (extra — override и т.п.). */
  const boxWith = (pad, extra = {}, layout = 'column') => {
    let doc = createDoc('empty');
    const r = applyOps(doc, [
      {
        op: 'create',
        node: {
          type: 'frame', id: 'A', name: 'Контейнер', parent: doc.root, children: [], pos: { x: 0, y: 0 },
          size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } },
          layout: { mode: layout, gap: 0, padding: pad, align: 'start', justify: 'start', wrap: false }
        }
      },
      ops.create(box('k', 'A', 90, 40, extra))
    ]);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const geo = solve(r.doc, M);
    return { doc: r.doc, geo, v: validate(r.doc, geo, M) };
  };
  const codes = (v) => v.map((x) => x.code + ':' + x.nodeId);

  // съел правый отступ, но из бокса не вышел — раньше здесь было пусто
  const eaten = boxWith({ t: 0, r: 20, b: 20, l: 0 });
  assert.equal(eaten.geo.rects.k.x + eaten.geo.rects.k.w, 90, 'правый край ребёнка 90 при внутренней границе 80');
  const pe = eaten.v.filter((x) => x.code === 'padding-eaten');
  assert.equal(pe.length, 1, 'ровно одно нарушение: ' + JSON.stringify(codes(eaten.v)));
  assert.equal(pe[0].nodeId, 'k');
  assert.equal(pe[0].severity, 'warn', 'тихий код: оболочка и мозг по умолчанию его не поднимают');
  assert.match(pe[0].message, /заходит на отступ «Контейнер»: справа на 10$/, pe[0].message);

  // вылез и за бокс — говорим только out-of-parent, двух строк об одном не даём
  const outside = boxWith({ t: 20, r: 20, b: 20, l: 20 });
  assert.deepEqual(codes(outside.v).filter((c) => /^(out-of-parent|padding-eaten)/.test(c)), ['out-of-parent:k'],
    JSON.stringify(codes(outside.v)));

  // отсоединённый узел: override по SPEC §1.2 считается от БОКСА родителя — не нарушение
  const detached = boxWith({ t: 40, r: 40, b: 40, l: 40 }, { override: { x: 0, y: 0 } });
  assert.deepEqual(codes(detached.v).filter((c) => /padding-eaten/.test(c)), [], JSON.stringify(codes(detached.v)));

  // свободное размещение (mode:none) считается так же: отступ сдвигает начало координат
  const free = boxWith({ t: 0, r: 20, b: 20, l: 0 }, {}, 'none');
  assert.deepEqual(codes(free.v).filter((c) => /padding-eaten/.test(c)), ['padding-eaten:k']);

  // ребёнок ровно по внутренней границе и hug-родитель нарушений не дают
  let doc = createDoc('empty');
  const fit = applyOps(doc, [
    {
      op: 'create',
      node: {
        type: 'frame', id: 'H', name: 'Обнимает', parent: doc.root, children: [], pos: { x: 0, y: 0 },
        size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
        layout: { mode: 'column', gap: 0, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'start', justify: 'start', wrap: false }
      }
    },
    ops.create(box('in', 'H', 90, 40))
  ]);
  assert.equal(fit.error, undefined, JSON.stringify(fit.error));
  assert.deepEqual(validate(fit.doc, solve(fit.doc, M), M).filter((x) => x.code === 'padding-eaten'), []);

  // демо-документ по-прежнему чист
  const demo = createDoc();
  assert.deepEqual(validate(demo, solve(demo, M), M), [], 'демо-документ без нарушений');
});

test('круг16 п.4: узлы глубже предела не молчат — validate говорит, что их нет на холсте', () => {
  // цепочка фреймов глубже MAX_DEPTH (256): решатель обрывает ветку и раньше не сообщал никому
  const nodes = { p: { id: 'p', type: 'page', parent: null, children: ['гл0'] } };
  const DEPTH = 300;
  for (let i = 0; i < DEPTH; i++) {
    nodes['гл' + i] = {
      id: 'гл' + i, type: 'frame', name: 'гл' + i, parent: i === 0 ? 'p' : 'гл' + (i - 1),
      children: i === DEPTH - 1 ? [] : ['гл' + (i + 1)],
      ...(i === 0 ? { pos: { x: 0, y: 0 } } : {}),
      size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 300 } },
      layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
    };
  }
  const doc = createDoc({ id: 'd', version: 1, root: 'p', nodes, meta: { name: 'глубокий' } });
  const geo = solve(doc, M);
  const noRect = Object.keys(doc.nodes).filter((id) => doc.nodes[id].type !== 'page' && !geo.rects[id]);
  assert.ok(noRect.length > 10, 'ветка действительно оборвана: ' + noRect.length);

  const v = validate(doc, geo, M).filter((x) => x.code === 'no-geometry');
  assert.equal(v.length, 1, 'одна строка на всю оборванную ветку, а не на каждый узел: ' + v.length);
  assert.equal(v[0].severity, 'warn');
  assert.equal(v[0].nodeId, noRect[0], 'названа вершина обрыва');
  assert.match(v[0].message, /не попали на холст/, v[0].message);
  assert.match(v[0].message, new RegExp('всего ' + noRect.length + ' узлов'), v[0].message);
  assert.match(v[0].message, /глубже предела 256/, v[0].message);

  // нормальный документ такого не получает
  const demo = createDoc();
  assert.deepEqual(validate(demo, solve(demo, M), M).filter((x) => x.code === 'no-geometry'), []);
});

test('круг16 п.8: сырой текст исключения не уходит человеку', () => {
  const doc = createDoc();
  const id = Object.keys(doc.nodes).find((k) => doc.nodes[k].name === 'Аватар');
  // вход вне контракта: значение, которое движок не может прочитать
  const angry = {};
  Object.defineProperty(angry, 'x', {
    enumerable: true,
    get() { throw new Error('Converting circular structure to JSON --> starting at object with constructor Object'); }
  });
  const circular = {};
  circular.self = circular;
  for (const value of [angry, circular]) {
    const r = applyOps(doc, [{ op: 'set', id, path: 'fill', value }]);
    assert.equal(r.doc, doc, 'документ не тронут');
    assert.equal(r.error.code, 'bad-op', 'код из контракта applyOps');
    assert.ok(!/JSON|stack|Error|-->/i.test(r.error.message), 'без внутренностей движка: ' + r.error.message);
    assert.match(r.error.message, /^правку не удалось применить/, r.error.message);
  }
});

test('круг16 п.8: «отсоединён» и размер стоят у разных кромок узла', () => {
  const had = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, textContent: '', className: '' }) };
  try {
    const mk = (vw, vh) => {
      const st = Object.create(Stage.prototype);
      st.ui = { appendChild() {} };
      if (vw) st.el = { clientWidth: vw, clientHeight: vh };
      return st;
    };
    const at = (b) => ({ x: parseFloat(b.style.left), y: parseFloat(b.style.top), w: 0 });
    const st = mk(1000, 700);
    const node = { x: 480, y: 212, w: 192, h: 108 };
    const size = at(st._badge('350 × 108', node));
    const plate = at(st._badge('отсоединён', node, 'is-detached', 1));
    // размер — у нижней кромки, плашка — у верхней: между ними вся высота узла
    assert.ok(Math.abs(size.y + 17 - (node.y + node.h)) < 0.51, 'размер по нижней кромке: ' + size.y);
    assert.ok(Math.abs(plate.y - node.y) < 0.51, 'плашка по верхней кромке: ' + plate.y);
    assert.ok(plate.y + 17 + 20 <= size.y, 'между ярлыками больше строки пустоты: ' + (size.y - plate.y - 17));

    // низкий узел: разойтись некуда — плашка встаёт этажом выше, как раньше, и не наезжает
    const low = { x: 480, y: 100, w: 192, h: 24 };
    const s2 = at(st._badge('350 × 24', low));
    const p2 = at(st._badge('отсоединён', low, 'is-detached', 1));
    assert.ok(p2.y + 17 <= s2.y + 0.01, 'ярлыки не наезжают друг на друга: ' + p2.y + ' vs ' + s2.y);

    // когда снаружи места нет совсем, оба по-прежнему остаются на экране и внутри узла
    const full = { x: 0, y: 0, w: 320, h: 300 };
    const tight = mk(320, 300);
    for (const slot of [0, 1]) {
      const p = at(tight._badge('350 × 108', full, '', slot));
      assert.ok(p.x >= 0 && p.y >= 0 && p.y + 17 <= 300, 'бейдж на экране: ' + JSON.stringify(p));
    }
  } finally {
    globalThis.document = had;
  }
});

/**
 * Мини-DOM для сцены: того, что есть в withSvgDom, точечному обновлению мало —
 * оно двигает и заменяет элементы, а не только дописывает.
 */
function withStageDom(fn) {
  const had = globalThis.document;
  const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const esc = (s) => escText(s).replace(/"/g, '&quot;');
  const mk = (name) => ({
    nodeName: name, attrs: new Map(), children: [], text: '', parentNode: null, style: {},
    get firstChild() { return this.children[0] || null; },
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    setAttributeNS(_ns, k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    removeAttribute(k) { this.attrs.delete(k); },
    appendChild(c) {
      if (c.nodeName === '#fragment') { for (const k of c.children.slice()) this.appendChild(k); c.children = []; return c; }
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this; this.children.push(c); return c;
    },
    insertBefore(c, before) {
      if (!before) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = this.children.indexOf(before);
      c.parentNode = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    replaceChild(next, old) {
      const i = this.children.indexOf(old);
      if (i < 0) return old;
      if (next.parentNode) next.parentNode.removeChild(next);
      this.children[i] = next; next.parentNode = this; old.parentNode = null; return old;
    },
    get outerHTML() {
      if (this.nodeName === '#text') return escText(this.text);
      const a = [...this.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
      return `<${this.nodeName}${a}>${this.children.map((c) => c.outerHTML).join('')}</${this.nodeName}>`;
    }
  });
  globalThis.document = {
    createElementNS: (_ns, name) => mk(name),
    createElement: (name) => mk(name),
    createTextNode: (t) => { const n = mk('#text'); n.text = t; return n; },
    createDocumentFragment: () => mk('#fragment')
  };
  try { return fn(); } finally { globalThis.document = had; }
}

test('круг16 п.6: точечное обновление сцены даёт ровно то же, что полная пересборка', () => {
  withStageDom(() => {
    const st = bareStage({});
    st.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    st.opts = { measureText };
    st.view = { zoom: 1, pan: { x: 0, y: 0 } };
    st._applyView = () => {};
    st._paintUI = () => {};
    st._warmFonts = () => {};
    st._clipPrefix = 'clip-';
    let doc = createDoc();
    const paint = () => { st.doc = doc; st.geo = solve(doc, M); st._renderSVG(); };
    paint();

    // id обрезок нумеруются подряд, поэтому у точечного пути и у полной сборки
    // они разные: сверяем разметку, приведя их к порядку появления
    const norm = (s) => {
      // defs сверяем как множество: порядок обрезок внутри него на картинку не влияет
      const found = /<defs>[\s\S]*?<\/defs>/.exec(s);
      const defs = found
        ? (found[0].match(/<clipPath[\s\S]*?<\/clipPath>/g) || []).map((x) => x.replace(/id="[^"]*"/, '')).sort().join('')
        : '';
      const map = new Map();
      const body = s.replace(/<defs>[\s\S]*?<\/defs>/, '')
        .replace(/clip-\d+/g, (m) => { if (!map.has(m)) map.set(m, 'CLIP' + map.size); return map.get(m); });
      return defs + '|' + body;
    };

    const id = (name) => Object.keys(doc.nodes).find((k) => doc.nodes[k].name === name);
    const edits = [
      ['цвет', () => [ops.set(id('Аватар'), 'fill', 'accent')]],
      ['текст', () => [ops.set(id('Заголовок экрана'), 'characters', 'Совершенно другой заголовок, длиннее прежнего')]],
      ['скругление', () => [ops.set(id('Карточка встречи'), 'radius', 28)]],
      ['отсоединение', () => [ops.set(id('Аватар'), 'override', { x: 10, y: 10 })]],
      ['сдвиг отсоединённого', () => [ops.set(id('Аватар'), 'override', { x: 11, y: 10 })]],
      ['обрезка включилась', () => [ops.set(id('Карточка встречи'), 'clip', true)]],
      ['обрезка снялась', () => [ops.set(id('Карточка встречи'), 'clip', false)]],
      ['размер', () => [ops.set(id('Список пунктов'), 'size.w', { mode: 'fixed', value: 200 })]],
      ['прозрачность', () => [ops.set(id('Шапка'), 'opacity', 0.5)]],
      ['создание', () => [ops.create(box('новый', id('Список пунктов'), 40, 20))]],
      ['перенос', () => [ops.move('новый', id('Шапка'), 0)]],
      ['удаление', () => [ops.remove('новый')]],
      ['смена токена', () => [ops.setToken('colors.accent', '#00aa55')]],
      ['удаление ветки', () => [ops.remove(id('Карточка встречи'))]]
    ];
    let patched = 0;
    for (const [why, make] of edits) {
      const r = applyOps(doc, make());
      assert.equal(r.error, undefined, why + ': ' + JSON.stringify(r.error));
      doc = r.doc;
      const before = st._drawnState;
      paint();
      if (st._drawnState === before) patched++;
      const got = norm(st.svg.outerHTML);
      // эталон: та же сцена, собранная с нуля
      st._drawnState = null;
      st._clipSeq = 0;
      st._renderSVG();
      assert.equal(got, norm(st.svg.outerHTML), 'после правки «' + why + '» сцена расходится с полной пересборкой');
    }
    assert.ok(patched >= edits.length - 2, 'почти все правки обошлись без пересборки: ' + patched + ' из ' + edits.length);
  });
});

test('круг16 п.6: точечное обновление не трогает элементы неизменившихся узлов', () => {
  withStageDom(() => {
    const st = bareStage({});
    st.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    st.opts = { measureText };
    st.view = { zoom: 1, pan: { x: 0, y: 0 } };
    st._applyView = () => {};
    st._paintUI = () => {};
    st._warmFonts = () => {};
    let doc = createDoc();
    const paint = () => { st.doc = doc; st.geo = solve(doc, M); st._renderSVG(); };
    paint();
    const idOf = (name) => Object.keys(doc.nodes).find((k) => doc.nodes[k].name === name);
    const target = idOf('Аватар');
    const untouched = idOf('Подпись кнопки');
    const before = { hit: st._nodeEls.get(target), keep: st._nodeEls.get(untouched), svg: st.svg.children[0] };

    doc = applyOps(doc, [ops.set(target, 'fill', 'accent')]).doc;
    paint();
    assert.equal(st._nodeEls.get(untouched), before.keep, 'элемент нетронутого узла тот же самый');
    assert.equal(st.svg.children[0], before.svg, 'и сцена не пересобрана целиком');
    assert.equal(st._nodeEls.get(target), before.hit, 'у изменившегося узла заменены только фигуры');
    assert.match(st._nodeEls.get(target).outerHTML, /#ff6b3d/i, 'новая заливка на месте: ' + st._nodeEls.get(target).outerHTML);

    // смена токенов красит всё — тут пересборка законна
    doc = applyOps(doc, [ops.setToken('colors.accent', '#00aa55')]).doc;
    paint();
    assert.notEqual(st._nodeEls.get(untouched), before.keep, 'после смены палитры сцена собрана заново');
  });
});

/* ================================================================== *
 * Круг 19: компоненты (SPEC §5)
 * ================================================================== */

/**
 * Сцена с библиотекой и одним компонентом «Кнопка»:
 * мастер btn (фрейм с подписью lab), пропсы «текст» и «вид».
 * @returns {object} Doc
 */
function libScene(extra) {
  let doc = createDoc('empty');
  const push = (list) => {
    const res = applyOps(doc, list);
    assert.equal(res.error, undefined, 'операции должны применяться: ' + JSON.stringify(res.error));
    doc = res.doc;
  };
  push([ops.create({
    type: 'frame', id: 'ab', name: 'Доска', parent: doc.root, children: [],
    pos: { x: 0, y: 0 }, radius: 0, fill: '#ffffff',
    size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } },
    layout: { mode: 'column', gap: 10, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false }
  })]);
  doc = ensureLibrary(doc);
  const lib = libraryId(doc);
  push([
    ops.create(frame('btn', lib, { mode: 'row', padding: { t: 8, r: 16, b: 8, l: 16 } },
      { w: { mode: 'hug' }, h: { mode: 'hug' } }, { name: 'Кнопка', fill: 'accent', radius: 8 })),
    ops.create(label('lab', 'btn', 'Кнопка', { color: 'onAccent' })),
    ops.set('btn', 'component', {
      name: 'Кнопка',
      props: [
        { name: 'текст', kind: 'text', target: 'lab', path: 'characters' },
        { name: 'вид', kind: 'enum', target: 'btn', path: 'fill', values: ['accent', 'surface'] }
      ]
    })
  ]);
  if (extra) push(extra(doc, lib));
  return doc;
}

/** Экземпляр мастера `of` на доске. */
const inst = (id, parent, of, props, extra = {}) => ({
  type: 'instance', id, name: id, parent, of, props: { ...props }, ...extra
});

test('круг19 п.1: библиотека — потомок корня, но не доска; ensureLibrary идемпотентен', () => {
  const doc = libScene();
  const lib = libraryNode(doc);
  assert.ok(lib, 'библиотека есть');
  assert.equal(lib.type, 'page');
  assert.equal(lib.role, 'library');
  assert.equal(lib.parent, doc.root, 'лежит прямо в корне');
  assert.ok(nodeById(doc, doc.root).children.includes(lib.id), 'и числится его ребёнком');

  // не доска — ни по isArtboard, ни в списке досок
  assert.equal(isArtboard(doc, lib), false);
  assert.equal(isArtboard(doc, lib.id), false);
  assert.ok(isLibrary(doc, lib.id));
  assert.deepEqual(artboards(doc).map((a) => a.id), ['ab'], 'в досках только доска');
  assert.equal(libraryId(doc), lib.id);

  // второй вызов ничего не делает и отдаёт ТОТ ЖЕ документ
  assert.equal(ensureLibrary(doc), doc, 'миграция идемпотентна');
  assert.deepEqual(ensureLibraryOps(doc), []);

  // и подпись-заглушка у неё своя
  assert.equal(placeholderName(doc, lib.id), 'Библиотека');
});

test('круг19 п.1: миграция старого документа — ensureLibrary одним вызовом', () => {
  // документ «до компонентов»: библиотеки нет вовсе
  const old = createDoc(JSON.parse(JSON.stringify(scene(() => [ops.create(box('a', 'ab', 40, 40))]))));
  assert.equal(libraryNode(old), null, 'у старого документа библиотеки нет');
  // и он при этом полностью рабочий: решатель, валидатор и словарь молчат
  const geoBefore = solve(old, M);
  assert.ok(geoBefore.rects.a, 'старый документ считается');
  assert.deepEqual(validate(old, geoBefore, M).filter((v) => v.code.includes('instance')), []);
  assert.deepEqual(components(old), [], 'компонентов нет — словарь пуст, а не сломан');

  // тот же результат транзакцией — её можно отменить (одни и те же операции!)
  const migrate = ensureLibraryOps(old);
  const undo = invertOps(old, migrate);
  const staged = applyOps(old, migrate);
  assert.equal(staged.error, undefined, JSON.stringify(staged.error));
  assert.ok(libraryNode(staged.doc), 'библиотека появилась и так');
  const back = applyOps(staged.doc, undo);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, old.nodes, 'отмена миграции возвращает исходный документ');

  const next = ensureLibrary(old);
  assert.notEqual(next, old, 'вернулся новый документ');
  assert.ok(libraryNode(next), 'библиотека появилась');
  assert.deepEqual(old, JSON.parse(JSON.stringify(old)), 'вход не тронут');
  // доски не поехали: у самой библиотеки прямоугольник свой (пустой), а всё
  // прежнее содержимое стоит там же, где стояло
  const geoAfter = solve(next, M);
  for (const id of Object.keys(geoBefore.rects)) {
    assert.deepEqual(geoAfter.rects[id], geoBefore.rects[id], 'прямоугольник не поехал: ' + id);
  }
  assert.deepEqual(artboards(next).map((a) => a.name), artboards(old).map((a) => a.name));
  assert.equal(geoAfter.order.length, Object.keys(next.nodes).length - 1, 'порядок покрывает узлы документа');
});

test('круг19 п.2: схема мастера — что не по SPEC §5.4, то негодная операция', () => {
  const doc = libScene();
  const bad = (value, why) => {
    const res = applyOps(doc, [ops.set('btn', 'component', value)]);
    assert.ok(res.error, 'должно быть отклонено: ' + why);
    assert.equal(res.error.code, 'bad-node', why + ' → ' + JSON.stringify(res.error));
    assert.equal(res.doc, doc, 'документ не изменился');
  };
  bad('строка', 'component не объект');
  bad({ props: [] }, 'нет имени');
  bad({ name: '   ' }, 'пустое имя');
  bad({ name: 'К', props: {} }, 'props не массив');
  bad({ name: 'К', props: [{ name: 'т', kind: 'wat', target: 'lab', path: 'characters' }] }, 'неизвестный kind');
  bad({ name: 'К', props: [{ name: 'т', kind: 'text', path: 'characters' }] }, 'нет target');
  bad({ name: 'К', props: [{ name: 'т', kind: 'text', target: 'lab' }] }, 'нет path');
  bad({ name: 'К', props: [{ name: 'т', kind: 'text', target: 'ab', path: 'characters' }] }, 'target вне мастера');
  bad({ name: 'К', props: [{ name: 'т', kind: 'text', target: 'нет-такого', path: 'characters' }] }, 'target не найден');
  bad({ name: 'К', props: [{ name: 'т', kind: 'text', target: 'lab', path: 'parent' }] }, 'защищённый путь');
  bad({ name: 'К', props: [{ name: 'т', kind: 'text', target: 'lab', path: 'style.__proto__' }] }, 'ключ прототипа');
  bad({ name: 'К', props: [{ name: 'в', kind: 'enum', target: 'btn', path: 'fill' }] }, 'enum без values');
  bad({ name: 'К', props: [{ name: 'в', kind: 'enum', target: 'btn', path: 'fill', values: [] }] }, 'enum с пустым values');
  bad({
    name: 'К',
    props: [{ name: 'т', kind: 'text', target: 'lab', path: 'characters' },
      { name: 'т', kind: 'text', target: 'lab', path: 'name' }]
  }, 'два пропса с одним именем');

  // а годная схема применяется, и target разрешён на сам мастер
  const ok = applyOps(doc, [ops.set('btn', 'component', {
    name: 'Кнопка', props: [{ name: 'вид', kind: 'enum', target: 'btn', path: 'fill', values: ['accent'] }]
  })]);
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
});

test('круг19 п.3: экземпляр — of, пропсы по схеме, детей нет', () => {
  const doc = libScene();
  const ok = applyOps(doc, [ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить', 'вид': 'accent' }))]);
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.equal(ok.doc.nodes.i1.type, 'instance');
  assert.equal(ok.doc.nodes.i1.size, undefined, 'размер не достроен — берётся у мастера');

  const bad = (node, code, why) => {
    const res = applyOps(doc, [ops.create(node)]);
    assert.ok(res.error, 'должно быть отклонено: ' + why);
    assert.equal(res.error.code, code, why + ' → ' + JSON.stringify(res.error));
  };
  bad(inst('x', 'ab', '', {}), 'bad-node', 'нет of');
  bad({ type: 'instance', id: 'x', parent: 'ab', of: 'x' }, 'bad-node', 'of на себя');
  bad(inst('x', 'ab', 'btn', { 'выдумка': 'ой' }), 'bad-node', 'неизвестное имя пропса');
  bad(inst('x', 'ab', 'btn', { 'вид': 'radioactive' }), 'bad-node', 'значение вне enum');
  bad(inst('x', 'ab', 'btn', { 'текст': 42 }), 'bad-node', 'не строка для text');
  bad({ ...inst('x', 'ab', 'btn', {}), children: ['lab'] }, 'bad-node', 'у экземпляра детей не бывает');
  bad({ ...inst('x', 'ab', 'btn', {}), size: { w: { mode: 'fixed', value: -5 } } }, 'bad-node', 'негодный размер');

  // одна ось размера — законно: ресайз одной кромкой пишет только её
  const oneAxis = applyOps(doc, [ops.create({ ...inst('x', 'ab', 'btn', {}), size: { w: { mode: 'fixed', value: 200 } } })]);
  assert.equal(oneAxis.error, undefined, JSON.stringify(oneAxis.error));
});

test('круг19 п.4: solve раскрывает экземпляр под синтетическими id и детерминирован', () => {
  const doc = libScene((d, lib) => [
    ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' })),
    ops.create(inst('i2', 'ab', 'btn', { 'текст': 'Отменить', 'вид': 'surface' }))
  ]);
  const geo = solve(doc, M);

  // корень мастера лёг под id самого экземпляра, потомки — под «<экз>/<узел мастера>»
  assert.ok(geo.rects.i1, 'у экземпляра есть прямоугольник');
  assert.ok(geo.rects['i1/lab'], 'подпись внутри экземпляра раскрыта: i1/lab');
  assert.ok(geo.rects['i2/lab'], 'и у второго экземпляра своя');
  assert.equal(doc.nodes['i1/lab'], undefined, 'в doc.nodes синтетических узлов нет');
  assert.deepEqual(geo.lines['i1/lab'], ['Оплатить'], 'пропс «текст» применён');
  assert.deepEqual(geo.lines['i2/lab'], ['Отменить']);
  assert.equal(geo.expanded['i2'].fill, 'surface', 'пропс «вид» применён к корню мастера');
  assert.equal(geo.expanded['i1'].fill, 'accent', 'а у соседа — значение мастера');
  assert.equal(geo.expanded['i1/lab'].synthetic, true, 'раскрытый узел помечен');
  assert.equal(geo.expanded['i1/lab'].instance, 'i1', 'и знает, чей он');
  assert.equal(geo.expanded['i1/lab'].master, 'lab', 'и из какого узла мастера сделан');

  // размер экземпляра — размер мастера (hug по содержимому подписи + отступы)
  assert.ok(geo.rects.i1.w > 32, 'экземпляр не нулевой: ' + JSON.stringify(geo.rects.i1));
  assert.equal(geo.rects.i1.h, geo.rects['i1/lab'].h + 16, 'высота = подпись + отступы мастера');
  assert.equal(geo.rects.i1.w, geo.rects['i1/lab'].w + 32, 'ширина = подпись + отступы мастера');

  // порядок отрисовки — только настоящие узлы документа
  assert.ok(!geo.order.some((id) => id.includes('/')), 'синтетических id в order нет: ' + geo.order.join(','));
  assert.ok(geo.order.includes('i1'), 'а сам экземпляр в порядке есть');

  // детерминированность
  assert.equal(hashGeometry(solve(doc, M)), hashGeometry(geo), 'два прохода дают одну геометрию');
  assert.equal(hashGeometry(solve(createDoc(JSON.parse(JSON.stringify(doc))), M)), hashGeometry(geo),
    'и после сериализации тоже');
  resetMeasureCache('тест');
  assert.equal(hashGeometry(solve(doc, M)), hashGeometry(geo), 'сброс кеша измерений геометрию не меняет');
});

test('круг19 п.3: неизвестное имя пропса в документе не применяется', () => {
  // такой документ нельзя СОЗДАТЬ операциями, но он приходит из файла или
  // остаётся после того, как мастер перестал объявлять пропс
  const doc = libScene(() => [ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' }))]);
  const sneaky = JSON.parse(JSON.stringify(doc));
  sneaky.nodes.i1.props['выдумка'] = 'ой';
  const geo = solve(sneaky, M);
  assert.deepEqual(geo.lines['i1/lab'], ['Оплатить'], 'известный пропс применён');
  assert.equal(JSON.stringify(geo.expanded.i1).includes('выдумка'), false, 'выдуманный — нет');
  // и валидатор об этом говорит
  const v = validate(sneaky, geo, M).filter((x) => x.code === 'unknown-prop');
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.equal(v[0].severity, 'error');
  assert.equal(v[0].nodeId, 'i1');
});

test('круг19 п.4: вложенные экземпляры, предел глубины и самовключение не вешают solve', () => {
  // мастер «Полоса» содержит экземпляр «Кнопки» — законная вложенность
  let doc = libScene();
  const lib = libraryId(doc);
  let res = applyOps(doc, [
    ops.create(frame('bar', lib, { mode: 'row', gap: 8 }, { w: { mode: 'hug' }, h: { mode: 'hug' } }, { name: 'Полоса' })),
    ops.create(inst('bar-i', 'bar', 'btn', { 'текст': 'Внутри' })),
    ops.set('bar', 'component', { name: 'Полоса', props: [] }),
    ops.create(inst('top', 'ab', 'bar', {}))
  ]);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  doc = res.doc;
  const geo = solve(doc, M);
  assert.ok(geo.rects['top/bar-i'], 'вложенный экземпляр раскрыт');
  assert.ok(geo.rects['top/bar-i/lab'], 'и его собственное содержимое: ' + Object.keys(geo.rects).join(','));
  assert.deepEqual(geo.lines['top/bar-i/lab'], ['Внутри']);
  assert.deepEqual(validate(doc, geo, M).filter((v) => v.severity === 'error'), [], 'законная вложенность — не нарушение');

  // составной компонент остаётся настраиваемым: пропс внешнего мастера целится в
  // `props.<имя>` вложенного экземпляра и пробрасывается внутрь
  const through = applyOps(doc, [ops.set('bar', 'component', {
    name: 'Полоса',
    props: [{ name: 'подпись', kind: 'text', target: 'bar-i', path: 'props.текст' }]
  })]);
  assert.equal(through.error, undefined, JSON.stringify(through.error));
  const withProp = applyOps(through.doc, [ops.set('top', 'props', { 'подпись': 'Проброшено' })]);
  assert.equal(withProp.error, undefined, JSON.stringify(withProp.error));
  assert.deepEqual(solve(withProp.doc, M).lines['top/bar-i/lab'], ['Проброшено'],
    'значение дошло до текста внутри вложенного экземпляра');
  assert.deepEqual(validate(withProp.doc, solve(withProp.doc, M), M).filter((v) => v.severity === 'error'), []);

  // самовключение: «Полоса» содержит экземпляр самой себя
  const cyc = applyOps(doc, [ops.create(inst('self', 'bar', 'bar', {}))]);
  assert.equal(cyc.error, undefined, JSON.stringify(cyc.error));
  const cgeo = solve(cyc.doc, M);   // не вешается и не бросает
  const cv = validate(cyc.doc, cgeo, M).filter((v) => v.code === 'component-cycle');
  assert.equal(cv.length, 1, JSON.stringify(cv));
  assert.equal(cv[0].severity, 'error');
  assert.equal(cv[0].nodeId, 'bar');
  assert.equal(hashGeometry(solve(cyc.doc, M)), hashGeometry(cgeo), 'и остаётся детерминированным');

  // предел вложенности: цепочка мастеров длиннее MAX_INSTANCE_DEPTH
  let deep = libScene();
  const dlib = libraryId(deep);
  let prev = 'btn';
  for (let i = 0; i < MAX_INSTANCE_DEPTH + 2; i++) {
    const mid = 'm' + i;
    const r = applyOps(deep, [
      ops.create(frame(mid, dlib, { mode: 'row' }, { w: { mode: 'hug' }, h: { mode: 'hug' } }, { name: 'Слой ' + i })),
      ops.create(inst(mid + '-i', mid, prev, {})),
      ops.set(mid, 'component', { name: 'Слой ' + i, props: [] })
    ]);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    deep = r.doc;
    prev = mid;
  }
  const dr = applyOps(deep, [ops.create(inst('deep', 'ab', prev, {}))]);
  assert.equal(dr.error, undefined, JSON.stringify(dr.error));
  const dgeo = solve(dr.doc, M);
  const dv = validate(dr.doc, dgeo, M).filter((v) => v.code === 'instance-too-deep');
  assert.ok(dv.length >= 1, 'о переборе вложенности сказано: ' + JSON.stringify(dv));
  assert.equal(dv[0].severity, 'warn', 'и это предупреждение, а не ошибка');
  assert.ok(dv.some((v) => v.nodeId === 'deep'), 'в том числе про самый верхний экземпляр');
  // раскрытие обрывается на пределе, а не уходит в бесконечность
  const depths = Object.keys(dgeo.rects).map((id) => id.split('/').length);
  assert.ok(Math.max(...depths) <= MAX_INSTANCE_DEPTH + 1,
    'глубже предела ничего не раскрыто: ' + Math.max(...depths));
});

test('круг19 п.7: dead-instance — ссылка в никуда и мастер вне библиотеки', () => {
  const doc = libScene(() => [ops.create(inst('i1', 'ab', 'btn', {}))]);
  // ссылка в никуда
  const ghost = JSON.parse(JSON.stringify(doc));
  ghost.nodes.i2 = { type: 'instance', id: 'i2', name: 'Сирота', parent: 'ab', of: 'нет-такого', props: {} };
  ghost.nodes.ab.children.push('i2');
  let v = validate(ghost, solve(ghost, M), M).filter((x) => x.code === 'dead-instance');
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.equal(v[0].severity, 'error');
  assert.equal(v[0].nodeId, 'i2');

  // мастер вынесли из библиотеки — он перестал быть компонентом
  const moved = applyOps(doc, [ops.move('btn', 'ab', 0)]);
  assert.equal(moved.error, undefined, JSON.stringify(moved.error));
  assert.deepEqual(components(moved.doc), [], 'в словаре его больше нет');
  v = validate(moved.doc, solve(moved.doc, M), M).filter((x) => x.code === 'dead-instance');
  assert.equal(v.length, 1, 'экземпляр остался без компонента: ' + JSON.stringify(v));
  assert.equal(v[0].nodeId, 'i1');
  // и раскрывать нечего — экземпляр виден как нулевой узел, а не как пропавший
  assert.ok(solve(moved.doc, M).rects.i1, 'прямоугольник у него всё равно есть');
});

test('круг19: правка мастера меняет ВСЕ экземпляры разом и отменяется одной отменой', () => {
  const doc = libScene(() => [
    ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Раз' })),
    ops.create(inst('i2', 'ab', 'btn', { 'текст': 'Два' })),
    ops.create(inst('i3', 'ab', 'btn', { 'текст': 'Три' }))
  ]);
  const before = solve(doc, M);
  const h0 = [before.rects.i1.h, before.rects.i2.h, before.rects.i3.h];
  assert.equal(new Set(h0).size, 1, 'все три одной высоты: ' + h0.join(','));

  // ОДНА правка мастера: отступы вдвое больше
  const edit = [ops.set('btn', 'layout.padding', { t: 24, r: 32, b: 24, l: 32 })];
  const undo = invertOps(doc, edit);
  const after = applyOps(doc, edit);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  const geo2 = solve(after.doc, M);
  for (const id of ['i1', 'i2', 'i3']) {
    assert.ok(geo2.rects[id].h > before.rects[id].h + 15,
      `экземпляр ${id} вырос: ${before.rects[id].h} → ${geo2.rects[id].h}`);
    assert.ok(geo2.rects[id].w > before.rects[id].w + 15, `и в ширину: ${id}`);
  }
  // а сам документ не вырос ни на один узел: содержимое экземпляров не в нём
  assert.equal(Object.keys(after.doc.nodes).length, Object.keys(doc.nodes).length);

  // одна отмена возвращает ровно исходное состояние
  const back = applyOps(after.doc, undo);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'документ восстановлен байт в байт');
  assert.equal(hashGeometry(solve(back.doc, M)), hashGeometry(before), 'и геометрия тоже');
});

test('круг19 п.6: отсоединение — настоящая копия поддерева одной отменяемой транзакцией', () => {
  const doc = libScene(() => [
    ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить', 'вид': 'surface' })),
    ops.create(inst('i2', 'ab', 'btn', { 'текст': 'Рядом' }))
  ]);
  const before = solve(doc, M);
  const list = detachInstanceOps(doc, 'i1');
  assert.ok(list.length >= 3, 'remove + create на каждый узел: ' + list.length);
  assert.equal(list[0].op, 'remove');
  assert.equal(list[0].id, 'i1');
  // функция ничего не мутирует
  assert.deepEqual(doc, JSON.parse(JSON.stringify(doc)), 'документ не тронут');

  const undo = invertOps(doc, list);
  const res = applyOps(doc, list);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const next = res.doc;
  assert.equal(next.nodes.i1, undefined, 'экземпляра больше нет');
  // на его месте — настоящие узлы с настоящим содержимым
  const kids = nodeById(next, 'ab').children;
  const copyId = kids[0];
  assert.notEqual(copyId, 'i1');
  const copy = nodeById(next, copyId);
  assert.equal(copy.type, 'frame', 'копия — обычный фрейм, а не экземпляр');
  assert.equal(copy.component, undefined, 'и не мастер');
  assert.equal(copy.fill, 'surface', 'пропс «вид» въелся в копию');
  assert.equal(copy.synthetic, undefined, 'служебных полей раскрытия в документе нет');
  assert.equal(copy.instance, undefined);
  assert.equal(copy.master, undefined);
  const labId = copy.children[0];
  assert.equal(nodeById(next, labId).characters, 'Оплатить', 'пропс «текст» тоже');
  assert.equal(kids.indexOf(copyId), 0, 'копия встала на место экземпляра');
  assert.equal(kids[1], 'i2', 'сосед на месте');

  // геометрия ровно та же, что была у экземпляра
  const geo2 = solve(next, M);
  assert.deepEqual(geo2.rects[copyId], before.rects.i1, 'отсоединение вида не меняет');
  assert.deepEqual(geo2.lines[labId], before.lines['i1/lab']);
  // второй экземпляр по-прежнему связан с мастером, а копия уже нет
  const edited = applyOps(next, [ops.set('btn', 'fill', '#123456')]);
  assert.equal(edited.error, undefined, JSON.stringify(edited.error));
  assert.equal(solve(edited.doc, M).expanded.i2.fill, '#123456', 'экземпляр слушает мастера');
  assert.equal(nodeById(edited.doc, copyId).fill, 'surface', 'а копия живёт своей жизнью');
  // и наоборот: правка копии мастера не касается
  const edited2 = applyOps(next, [ops.set(labId, 'characters', 'Своё')]);
  assert.equal(edited2.error, undefined, JSON.stringify(edited2.error));
  assert.deepEqual(solve(edited2.doc, M).lines['i2/lab'], ['Рядом'], 'экземпляр не поехал');

  // одна отмена
  const back = applyOps(next, undo);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'отмена возвращает исходный документ');
  assert.equal(hashGeometry(solve(back.doc, M)), hashGeometry(before));

  // не экземпляр отсоединить нельзя
  assert.deepEqual(detachInstanceOps(doc, 'ab'), []);
  assert.deepEqual(detachInstanceOps(doc, 'нет-такого'), []);
});

test('круг19 п.8: экспорты для соседей — словарь, проверка и создание компонента', () => {
  const doc = libScene(() => [ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить', 'вид': 'accent' }))]);
  const list = components(doc);
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'instances', 'name', 'props']);
  assert.equal(list[0].id, 'btn');
  assert.equal(list[0].name, 'Кнопка');
  assert.equal(list[0].instances, 1, 'сколько экземпляров стоит');
  assert.deepEqual(list[0].props.map((p) => p.name), ['текст', 'вид']);
  assert.deepEqual(list[0].props[1].values, ['accent', 'surface']);
  assert.equal(list[0].props[0].target, 'lab');
  assert.equal(list[0].props[0].path, 'characters');
  // строка словаря ровно как в SPEC §5.9
  assert.equal(componentSignature(list[0]), 'Кнопка(текст, вид: accent|surface)');
  assert.equal(instanceSummary(doc, 'i1'), 'Кнопка "Оплатить" вид=accent');
  assert.equal(masterOf(doc, 'i1').id, 'btn');
  assert.ok(isMaster(doc, 'btn'));
  assert.equal(isMaster(doc, 'ab'), false);

  // можно ли сделать компонентом
  assert.deepEqual(canMakeComponent(doc, 'ab'), { ok: false, reason: 'доска компонентом не станет' });
  assert.equal(canMakeComponent(doc, doc.root).ok, false);
  assert.equal(canMakeComponent(doc, 'btn').ok, false, 'уже компонент');
  assert.equal(canMakeComponent(doc, 'lab').ok, false, 'внутри компонента');
  assert.equal(canMakeComponent(doc, 'i1').ok, false, 'уже экземпляр');
  assert.equal(canMakeComponent(doc, 'нет-такого').ok, false);

  // сделать компонентом обычный узел
  let d2 = applyOps(doc, [ops.create(frame('card', 'ab', { mode: 'column', gap: 4 },
    { w: { mode: 'fixed', value: 120 }, h: { mode: 'hug' } }, { name: 'Карточка', fill: 'surfaceAlt' }))]).doc;
  d2 = applyOps(d2, [ops.create(label('ctext', 'card', 'Внутри'))]).doc;
  assert.deepEqual(canMakeComponent(d2, 'card'), { ok: true });
  const mk = makeComponentOps(d2, 'card', {
    name: 'Карточка', props: [{ name: 'текст', kind: 'text', target: 'ctext', path: 'characters' }]
  });
  assert.ok(mk.length, 'операции есть');
  const undo = invertOps(d2, mk);
  const made = applyOps(d2, mk);
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal(nodeById(made.doc, 'card').parent, libraryId(made.doc), 'мастер переехал в библиотеку');
  assert.equal(componentSignature(components(made.doc).find((c) => c.id === 'card')), 'Карточка(текст)');
  const newInst = Object.values(made.doc.nodes).find((n) => n.type === 'instance' && n.of === 'card');
  assert.ok(newInst, 'на прежнем месте встал экземпляр');
  assert.equal(newInst.parent, 'ab');
  assert.equal(nodeById(made.doc, 'ab').children.indexOf(newInst.id),
    nodeById(d2, 'ab').children.indexOf('card'), 'на то же место');
  const g = solve(made.doc, M);
  assert.deepEqual(g.rects[newInst.id], solve(d2, M).rects.card, 'вид не изменился');
  assert.deepEqual(validate(made.doc, g, M).filter((v) => v.severity === 'error'), []);
  const back = applyOps(made.doc, undo);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, d2.nodes, 'одна отмена возвращает как было');

  // instanceOps
  const io = instanceOps(doc, { of: 'btn', parent: 'ab', props: { 'текст': 'Ещё' } });
  const placed = applyOps(doc, io);
  assert.equal(placed.error, undefined, JSON.stringify(placed.error));
  assert.equal(components(placed.doc)[0].instances, 2);
  assert.deepEqual(instanceOps(doc, { of: 'lab', parent: 'ab' }), [], 'не мастер — нет операций');
  assert.deepEqual(instanceOps(doc, { of: 'btn', parent: 'lab' }), [], 'родитель не контейнер');

  // раскрытие одного экземпляра — для превью
  const ex = expandInstance(doc, 'i1');
  assert.ok(ex && ex.root, 'раскрытие есть');
  assert.equal(ex.root.id, 'i1');
  assert.equal(ex.root.type, 'frame');
  assert.deepEqual(Object.keys(ex.nodes).sort(), ['i1', 'i1/lab']);
  assert.equal(expandInstance(doc, 'ab'), null, 'не экземпляр — нечего раскрывать');
});

test('круг19 п.5: экземпляр выделяется и таскается как ОДИН узел', () => {
  const doc = libScene(() => [ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' }))]);
  const geo = solve(doc, M);
  const r = geo.rects.i1;
  const inner = geo.rects['i1/lab'];

  // клик по любой точке экземпляра (в том числе по его подписи) выбирает экземпляр
  const st = gestureStage(doc, geo);
  const hit = st._hitTest({ x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 }, false);
  assert.ok(hit, 'узел под курсором есть');
  assert.equal(hit.id, 'i1', 'выбран экземпляр, а не его внутренность');
  // и явное углубление тоже не пускает внутрь
  st.state = { selection: ['i1'] };
  assert.equal(st._hitTest({ x: inner.x + 1, y: inner.y + 1 }, true).id, 'i1',
    'внутренние узлы экземпляра по клику не выделяются');
  // рамка выбора берёт его целиком
  assert.deepEqual(st._marqueePick({ x1: r.x - 5, y1: r.y - 5, x2: r.x + r.w + 5, y2: r.y + r.h + 5 }), ['i1']);
  // двойной клик по подписи внутри экземпляра правку текста НЕ открывает
  const st2 = gestureStage(doc, geo);
  st2.editing = null;
  st2._startEdit = (n) => { st2.editing = n.id; };
  st2._setActiveArtboardFor = () => {};
  st2._onDblClick(pev(inner.x + inner.w / 2, inner.y + inner.h / 2));
  assert.equal(st2.editing, null, 'текст мастера правят через пропс или отсоединение');

  // перетаскивание кладёт override/pos на сам экземпляр, а не на его внутренности
  const st3 = gestureStage(doc, geo, ['i1']);
  st3._onPointerDown(pev(r.x + 2, r.y + 2));
  st3._onPointerMove(pev(r.x + 60, r.y + 40));
  st3._onPointerUp(pev(r.x + 60, r.y + 40));
  assert.equal(st3.commits.length, 1, 'одна правка: ' + JSON.stringify(st3.commits));
  for (const op of st3.commits[0].ops) {
    assert.equal(op.id, 'i1', 'правка адресована экземпляру: ' + JSON.stringify(op));
  }
  const moved = applyOps(doc, st3.commits[0].ops);
  assert.equal(moved.error, undefined, JSON.stringify(moved.error));
  const mg = solve(moved.doc, M);
  assert.ok(mg.rects['i1/lab'], 'после сдвига содержимое экземпляра на месте');
  assert.ok(Math.abs(mg.rects['i1/lab'].x - mg.rects.i1.x) < 0.01 + 16,
    'и переехало вместе с ним');

  // ресайз за одну кромку пишет ТОЛЬКО потянутую ось (регрессия круга 17):
  // вторая у экземпляра остаётся «как у мастера», а не застывает числом
  const st4 = gestureStage(doc, geo, ['i1']);
  const list = st4._resizeOps({
    id: 'i1', handle: 'e', rect0: r, preview: { x: r.x, y: r.y, w: r.w + 40, h: r.h }
  });
  assert.deepEqual(list.map((o) => o.path), ['size.w'], 'записана одна ось: ' + JSON.stringify(list));
  const sized = applyOps(doc, list);
  assert.equal(sized.error, undefined, JSON.stringify(sized.error));
  assert.equal(nodeById(sized.doc, 'i1').size.h, undefined, 'высота по-прежнему от мастера');
  const sg = solve(sized.doc, M);
  assert.equal(sg.rects.i1.w, r.w + 40, 'ширина стала своей');
  assert.equal(sg.rects.i1.h, r.h, 'а высота — прежней, мастерской');
});

test('круг19 п.5: приметы экземпляра на слое интерфейса не спорят с бейджем и «отсоединён»', () => {
  const had = globalThis.document;
  const made = [];
  globalThis.document = {
    createElement: () => {
      const el = { style: {}, textContent: '', className: '', dataset: {}, parentNode: null };
      made.push(el);
      return el;
    },
    createElementNS: () => ({
      attrs: {}, children: [], style: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; }
    })
  };
  try {
    const doc = libScene(() => [
      ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' })),
      ops.create(inst('i2', 'ab', 'btn', { 'текст': 'Отсоединённый' }, { override: { x: 10, y: 120, w: 120, h: 40 } })),
      ops.create(box('plain', 'ab', 40, 40))
    ]);
    const geo = solve(doc, M);
    const paint = (sel) => {
      made.length = 0;
      const st = gestureStage(doc, geo, sel);
      st.ui = { children: [], appendChild(el) { el.parentNode = st.ui; this.children.push(el); }, removeChild(el) { el.parentNode = null; } };
      st.ov = { firstChild: null, setAttribute() {}, appendChild() {}, removeChild() {} };
      st._vp = { w: 1000, h: 800 };
      st._handleEls = new Map();
      st._layoutHandles = () => {};
      st._paintUI = Stage.prototype._paintUI;
      st._paintUI();
      return made;
    };
    const plain = paint(['plain']);
    assert.ok(plain.some((e) => e.className.startsWith('imago-box') && !e.className.includes('is-instance')),
      'у обычного узла рамка обычная');
    assert.ok(plain.every((e) => !String(e.textContent).includes('◇')), 'и ромба в бейдже нет');

    const one = paint(['i1']);
    const boxes = one.filter((e) => e.className.startsWith('imago-box'));
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0].className.includes('is-instance'), 'рамка экземпляра помечена: ' + boxes[0].className);
    assert.ok(!boxes[0].className.includes('is-detached'), 'но не как отсоединённая');
    const badges = one.filter((e) => e.className.startsWith('imago-badge'));
    assert.equal(badges.length, 1, 'бейдж один, третьего этажа у кромки не появилось');
    assert.match(badges[0].textContent, /^◇ Кнопка · \d+ × \d+$/, badges[0].textContent);

    const both = paint(['i2']);
    const box2 = both.filter((e) => e.className.startsWith('imago-box'))[0];
    assert.ok(box2.className.includes('is-instance') && box2.className.includes('is-detached'),
      'экземпляр можно и отсоединить: ' + box2.className);
    const b2 = both.filter((e) => e.className.startsWith('imago-badge'));
    assert.equal(b2.length, 2, 'размер и «отсоединён» — как их развёл круг 16');
    assert.match(b2[0].textContent, /^◇ Кнопка · /);
    assert.equal(b2[1].textContent, 'отсоединён');
  } finally { globalThis.document = had; }
});

test('круг19 п.4: точечная отрисовка держит экземпляры и перерисовывает их на правку мастера', () => {
  withStageDom(() => {
    const st = bareStage({});
    st.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    st.opts = { measureText };
    st.view = { zoom: 1, pan: { x: 0, y: 0 } };
    st._applyView = () => {};
    st._paintUI = () => {};
    st._warmFonts = () => {};
    st._clipPrefix = 'clip-';
    let doc = libScene(() => [
      ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Раз' })),
      ops.create(inst('i2', 'ab', 'btn', { 'текст': 'Два' })),
      ops.create(box('plain', 'ab', 40, 40))
    ]);
    const paint = () => { st.doc = doc; st.geo = solve(doc, M); st._renderSVG(); };
    paint();
    // экземпляр нарисован своим раскрытым поддеревом
    assert.ok(st._nodeEls.get('i1'), 'экземпляр на сцене');
    assert.ok(st._nodeEls.get('i1/lab'), 'и его подпись: ' + [...st._nodeEls.keys()].join(','));
    assert.match(st._nodeEls.get('i1').outerHTML, /Раз/);
    assert.match(st._nodeEls.get('i2').outerHTML, /Два/);

    // чужая правка экземпляры не пересобирает: ссылки раскрытых узлов те же
    const keep = { i1: st._nodeEls.get('i1'), lab: st._nodeEls.get('i1/lab'), svg: st.svg.children[0] };
    doc = applyOps(doc, [ops.set('plain', 'fill', '#00ff00')]).doc;
    paint();
    assert.equal(st.svg.children[0], keep.svg, 'сцена не пересобрана целиком');
    assert.equal(st._nodeEls.get('i1'), keep.i1, 'элемент экземпляра тот же');
    assert.equal(st._nodeEls.get('i1/lab'), keep.lab, 'и его раскрытой подписи тоже');

    // правка мастера перекрашивает ОБА экземпляра — точечно, без полной пересборки
    doc = applyOps(doc, [ops.set('btn', 'fill', '#123456')]).doc;
    paint();
    assert.equal(st.svg.children[0], keep.svg, 'и это по-прежнему не полная пересборка');
    assert.match(st._nodeEls.get('i1').outerHTML, /#123456/i, st._nodeEls.get('i1').outerHTML);
    assert.match(st._nodeEls.get('i2').outerHTML, /#123456/i);

    // и правка текста мастера доходит до обоих
    doc = applyOps(doc, [ops.set('lab', 'style.fontSize', 30)]).doc;
    paint();
    assert.match(st._nodeEls.get('i1/lab').outerHTML, /font-size="30"/);
    assert.match(st._nodeEls.get('i2/lab').outerHTML, /font-size="30"/);

    // точечный путь даёт то же, что полная пересборка
    const got = st.svg.outerHTML.replace(/id="[^"]*"/g, '').replace(/url\(#[^)]*\)/g, '');
    st._drawnState = null;
    st._clipSeq = 0;
    st._renderSVG();
    assert.equal(got, st.svg.outerHTML.replace(/id="[^"]*"/g, '').replace(/url\(#[^)]*\)/g, ''),
      'точечная отрисовка и полная сборка совпадают');
  });
});

test('круг19 п.5: экспорт SVG включает экземпляры', () => {
  withStageDom(() => {
    const st = bareStage({});
    st.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    st.opts = { measureText, embedFonts: false };
    st.view = { zoom: 1, pan: { x: 0, y: 0 } };
    st._applyView = () => {};
    st._paintUI = () => {};
    st._warmFonts = () => {};
    st._clipPrefix = 'clip-';
    const doc = libScene(() => [ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' }))]);
    st.doc = doc;
    st.geo = solve(doc, M);
    st._renderSVG();
    const svg = st.toSVG('ab');
    assert.ok(svg, 'разметка собралась');
    assert.match(svg, /Оплатить/, 'текст экземпляра в экспорте');
    assert.match(svg, /data-id="i1"/, 'и сам экземпляр');
    assert.match(svg, /data-id="i1\/lab"/, 'и его раскрытая подпись');
    // мастера в экспорте доски быть не должно: он лежит в библиотеке
    assert.ok(!svg.includes('data-id="btn"'), 'мастер сам по себе в доску не попал');
    // экспорт самого экземпляра — превью компонента
    const one = st.toSVG('i1');
    assert.match(one, /Оплатить/);
  });
});

test('круг19 п.9: демо-документ — живая библиотека и экземпляры на доске', () => {
  const doc = createDoc();
  const list = components(doc);
  assert.ok(list.length >= 2 && list.length <= 3, 'два-три компонента: ' + list.length);
  assert.deepEqual(list.map((c) => c.name), ['Кнопка', 'Метка', 'Карточка показателя']);
  assert.equal(componentSignature(list[0]), 'Кнопка(текст, вид: accent|surface)');
  assert.ok(list[0].props.some((p) => p.kind === 'text'), 'у кнопки есть пропс текста');
  assert.ok(list[0].props.some((p) => p.kind === 'enum'), 'и пропс вида');

  // экземпляры стоят НА ДОСКЕ
  const instances = Object.values(doc.nodes).filter((n) => n.type === 'instance');
  assert.ok(instances.length >= 1, 'экземпляры есть: ' + instances.length);
  const abs = artboards(doc);
  for (const n of instances) {
    const top = [n, ...ancestors(doc, n.id)].find((a) => isArtboard(doc, a));
    assert.ok(top, `экземпляр «${displayName(doc, n)}» стоит на доске`);
  }
  assert.ok(instances.some((n) => masterOf(doc, n).component.name === 'Кнопка'), 'кнопка среди них');

  // прежние доски целы: две, те же, 49 текстов на них
  assert.equal(abs.length, 2);
  assert.deepEqual(abs.map((a) => a.name), ['Маршрут дня', 'Сводка недели']);
  const libIds = new Set(subtreeIds(doc, libraryId(doc)));
  const boardTexts = Object.values(doc.nodes).filter((n) => n.type === 'text' && !libIds.has(n.id));
  assert.equal(boardTexts.length, 49, 'на досках по-прежнему 49 текстов');
  assert.ok(boardTexts.some((t) => t.characters === 'Добавить пункт'), 'прежняя кнопка на месте');

  // библиотека — не доска и в экспорт «всё» не идёт
  assert.equal(isArtboard(doc, libraryId(doc)), false);
  assert.ok(!abs.some((a) => a.id === libraryId(doc)));

  // здоровый документ: решатель считает всё, валидатор молчит
  const geo = solve(doc, M);
  for (const id of Object.keys(doc.nodes)) {
    if (id === doc.root) continue;
    assert.ok(geo.rects[id], 'у каждого узла есть прямоугольник: ' + id);
  }
  assert.deepEqual(validate(doc, geo, M).filter((v) => v.severity === 'error'), [], 'ошибок нет');
  assert.deepEqual(validate(doc, geo, M).filter((v) => v.code.startsWith('instance') || v.code === 'unknown-prop'
    || v.code === 'dead-instance' || v.code === 'component-cycle'), [], 'и про компоненты тоже');
  assert.equal(hashGeometry(solve(doc, M)), hashGeometry(geo));

  // документ переживает сериализацию вместе с библиотекой
  const round = createDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(components(round).length, list.length, 'компоненты уцелели');
  assert.equal(hashGeometry(solve(round, M)), hashGeometry(geo), 'и геометрия та же');
  // импорт не придумывает узлов: adoptDoc в оболочке сверяет их поштучно
  assert.deepEqual(Object.keys(round.nodes).filter((id) => !doc.nodes[id]), [],
    'createDoc не добавил ни одного узла от себя');
});

test('круг19: импорт чинит битые компоненты, а не выбрасывает мастер', () => {
  const doc = libScene(() => [ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' }))]);
  const raw = JSON.parse(JSON.stringify(doc));
  // пропс целится в узел, которого нет; в экземпляре — выдуманное имя
  raw.nodes.btn.component.props.push({ name: 'призрак', kind: 'text', target: 'нет-такого', path: 'characters' });
  raw.nodes.i1.props['выдумка'] = 'ой';
  const fixed = createDoc(raw);
  assert.ok(nodeById(fixed, 'btn'), 'мастер уцелел');
  assert.ok(nodeById(fixed, 'i1'), 'экземпляр уцелел');
  assert.deepEqual(components(fixed)[0].props.map((p) => p.name), ['текст', 'вид'], 'битый пропс убран');
  assert.equal(nodeById(fixed, 'i1').props['выдумка'], undefined, 'выдуманное имя убрано');
  const geo = solve(fixed, M);
  assert.deepEqual(geo.lines['i1/lab'], ['Оплатить'], 'а живой пропс работает');
  assert.deepEqual(validate(fixed, geo, M).filter((v) => v.severity === 'error'), []);
});

test('круг19: цена раскрытия — сотни экземпляров остаются отзывчивыми', () => {
  const N = 300;
  let doc = libScene();
  const build = [];
  for (let i = 0; i < N; i++) {
    build.push(ops.create(inst('i' + i, 'ab', 'btn', { 'текст': 'Кнопка ' + i })));
  }
  const res = applyOps(doc, build);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  doc = res.doc;

  const t0 = Date.now();
  const geo = solve(doc, M);
  const tSolve = Date.now() - t0;
  const t1 = Date.now();
  validate(doc, geo, M);
  const tValidate = Date.now() - t1;
  assert.equal(Object.keys(geo.rects).length, Object.keys(doc.nodes).length + N,
    'раскрытых узлов ровно по одному на экземпляр (подпись)');
  assert.ok(tSolve < 2000, `solve на ${N} экземплярах: ${tSolve} мс`);
  assert.ok(tValidate < 2000, `validate: ${tValidate} мс`);
  if (process.env.IMAGO_PERF) console.log(`  [перф] ${N} экземпляров: solve ${tSolve} мс, validate ${tValidate} мс`);

  // второй solve того же документа переиспользует раскрытие: узлы — те же объекты
  const geo2 = solve(doc, M);
  assert.equal(geo2.expanded['i7/lab'], geo.expanded['i7/lab'], 'раскрытие переиспользовано по ссылке');
  assert.equal(hashGeometry(geo2), hashGeometry(geo));
  // чужая правка ссылки не рвёт
  const after = applyOps(doc, [ops.set('ab', 'fill', '#eeeeee')]).doc;
  assert.equal(solve(after, M).expanded['i7/lab'], geo.expanded['i7/lab'], 'и чужая правка тоже');
  // а правка мастера — рвёт, и все экземпляры перерисуются
  const master = applyOps(doc, [ops.set('btn', 'radius', 4)]).doc;
  assert.notEqual(solve(master, M).expanded['i7/lab'], geo.expanded['i7/lab'], 'правка мастера обновляет раскрытие');
});

/* ======================= круг 20: шкалы как ссылки (SPEC §6) ======================= */

/** Число → ссылка на шаг (для сборки сцен на ссылках), как это делает миграция. */
const ref20 = (scale, v) => {
  const i = DEFAULT_TOKENS[scale].indexOf(v);
  assert.ok(i >= 0, `${v} должно быть шагом ${scale}`);
  return scaleRef(scale, i);
};
/** Все ссылки документа заменены их числами — «документ, как он считался до круга 20». */
function numericTwin(doc) {
  const twin = JSON.parse(JSON.stringify(doc));
  for (const n of Object.values(twin.nodes)) {
    if (n.layout && typeof n.layout === 'object') {
      n.layout.gap = resolveScale(doc, n.layout.gap, 'spacing');
      for (const k of ['t', 'r', 'b', 'l']) n.layout.padding[k] = resolveScale(doc, n.layout.padding[k], 'spacing');
    }
    if (n.radius !== undefined) n.radius = resolveRadius(doc, n.radius);
  }
  return twin;
}
/** Сколько в документе ссылок и сколько чисел в полях шкал. */
function scaleCensus(doc) {
  let refs = 0;
  let nums = 0;
  for (const n of Object.values(doc.nodes)) {
    const vals = [];
    if (n.layout && typeof n.layout === 'object') vals.push(n.layout.gap, ...Object.values(n.layout.padding));
    if (n.radius !== undefined) vals.push(...(Array.isArray(n.radius) ? n.radius : [n.radius]));
    for (const v of vals) (parseScaleRef(v) ? refs++ : nums++);
  }
  return { refs, nums };
}

test('круг20 п.1: ссылка на шаг — законное значение gap, padding и radius; форма проверяется схемой', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 'spacing.6', padding: { t: 'spacing.8', r: 'spacing.7', b: 'spacing.8', l: 'spacing.7' } },
      { w: { mode: 'fixed', value: 300 }, h: { mode: 'hug' } }, { radius: 'radii.4' })),
    ops.create(box('a', 'card', 40, 20, { radius: ['radii.1', 'radii.2', 0, 4] })),
    ops.create(box('b', 'card', 40, 20))
  ]);
  assert.equal(doc.nodes.card.layout.gap, 'spacing.6', 'ссылка хранится строкой как есть');
  assert.deepEqual(doc.nodes.card.layout.padding, { t: 'spacing.8', r: 'spacing.7', b: 'spacing.8', l: 'spacing.7' });
  assert.equal(doc.nodes.card.radius, 'radii.4');
  assert.deepEqual(doc.nodes.a.radius, ['radii.1', 'radii.2', 0, 4], 'покорнерный массив — тоже со ссылками');

  // геометрия ровно та, что у чисел: gap 16, padding 24/20
  const r = solve(doc, M).rects;
  assert.equal(r.a.x, 20, 'padding.l = spacing.7 = 20');
  assert.equal(r.a.y, 24, 'padding.t = spacing.8 = 24');
  assert.equal(r.b.y, 24 + 20 + 16, 'gap = spacing.6 = 16');
  assert.equal(r.card.h, 24 + 20 + 16 + 20 + 24);

  // краткие записи: строка-ссылка на все стороны, [v,h], [t,r,b,l]
  const short = applyOps(doc, [
    ops.set('card', 'layout.padding', 'spacing.4'),
    ops.create(frame('f2', 'ab', { mode: 'row', padding: ['spacing.2', 'spacing.3'] }, HUG)),
    ops.create(frame('f3', 'ab', { mode: 'row', padding: ['spacing.1', 'spacing.2', 'spacing.3', 'spacing.4'] }, HUG))
  ]);
  assert.equal(short.error, undefined, JSON.stringify(short.error));
  assert.deepEqual(short.doc.nodes.card.layout.padding, { t: 'spacing.4', r: 'spacing.4', b: 'spacing.4', l: 'spacing.4' });
  assert.deepEqual(short.doc.nodes.f2.layout.padding, { t: 'spacing.2', r: 'spacing.3', b: 'spacing.2', l: 'spacing.3' });
  assert.deepEqual(short.doc.nodes.f3.layout.padding, { t: 'spacing.1', r: 'spacing.2', b: 'spacing.3', l: 'spacing.4' });

  // форма: не число и не ссылка — «вне диапазона», как раньше; ссылка не в ту шкалу — своя причина
  const junk = applyOps(doc, [ops.create(frame('j', 'ab', { mode: 'row', gap: 'spacing.x' }, HUG))]);
  assert.equal(junk.error, undefined, 'мусор в gap при create нормализуется в 0, как и раньше');
  assert.equal(junk.doc.nodes.j.layout.gap, 0);
  const wrong = applyOps(doc, [ops.set('card', 'layout.gap', 'radii.3')]);
  assert.equal(wrong.error.code, 'bad-node');
  assert.match(wrong.error.message, /layout\.gap: ссылка «radii\.3» ведёт не в шкалу отступов/);
  const wrongR = applyOps(doc, [ops.set('a', 'radius', 'spacing.3')]);
  assert.equal(wrongR.error.code, 'bad-node');
  assert.match(wrongR.error.message, /spacing\.3/);
  // число с ведущим нулём и отрицательный индекс — не ссылка
  assert.equal(parseScaleRef('spacing.06'), null);
  assert.equal(parseScaleRef('spacing.-1'), null);
  assert.equal(parseScaleRef('spacing.'), null);
  assert.equal(parseScaleRef(16), null);
  assert.deepEqual(parseScaleRef('radii.7'), { scale: 'radii', index: 7 });
  assert.equal(isScaleRef('spacing.6', 'spacing'), true);
  assert.equal(isScaleRef('spacing.6', 'radii'), false);
  assert.equal(isScaleRef('spacing.6'), true);
});

test('круг20 п.1: ссылка на несуществующий шаг отклоняется операцией (bad-node), инверсия проходит всегда', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 'spacing.6' }, HUG, { radius: 'radii.4' })),
    ops.create(box('a', 'card', 40, 20))
  ]);
  const steps = doc.tokens.spacing.length;
  for (const [id, path, value] of [
    ['card', 'layout.gap', 'spacing.' + steps],
    ['card', 'layout.padding.t', 'spacing.99'],
    ['card', 'layout.padding', { t: 'spacing.99', r: 0, b: 0, l: 0 }],
    ['card', 'layout', { mode: 'row', gap: 'spacing.99' }],
    ['card', 'radius', 'radii.99'],
    ['a', 'radius', ['radii.99', 0]]
  ]) {
    const bad = applyOps(doc, [ops.set(id, path, value)]);
    assert.equal(bad.error && bad.error.code, 'bad-node', `${path}: ${JSON.stringify(bad.error)}`);
    assert.match(bad.error.message, /нет/, path);
    assert.match(bad.error.message, /шкале (отступов|скруглений)/, path);
    assert.equal(bad.doc, doc, 'документ не тронут');
  }
  const badCreate = applyOps(doc, [ops.create(frame('f', 'ab', { mode: 'row', gap: 'spacing.99' }, HUG))]);
  assert.equal(badCreate.error.code, 'bad-node');
  assert.match(badCreate.error.message, /create: layout\.gap: шага «spacing\.99» нет/);

  // в одной транзакции порядок важен: сначала удлинить шкалу, потом ссылаться на новый шаг
  const longer = doc.tokens.spacing.concat([80]);
  const ok = applyOps(doc, [ops.setToken('spacing', longer), ops.set('card', 'layout.gap', 'spacing.' + steps)]);
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.equal(solve(ok.doc, M).rects.a.y, 0, 'один ребёнок — зазор не виден, но значение живое');
  const reversed = applyOps(doc, [ops.set('card', 'layout.gap', 'spacing.' + steps), ops.setToken('spacing', longer)]);
  assert.equal(reversed.error.code, 'bad-node', 'ссылка раньше шкалы — транзакция отклоняется целиком');

  // мёртвая ссылка в соседнем поле не запирает узел: правится заливка, имя, другой отступ
  const shortDoc = applyOps(doc, [ops.setToken('spacing', [0, 4, 8])]).doc;
  assert.equal(resolveScale(shortDoc, 'spacing.6', 'spacing'), undefined, 'ссылка умерла');
  for (const [path, value] of [['fill', 'accent'], ['name', 'Карта'], ['layout.padding.t', 'spacing.2'], ['layout.align', 'center']]) {
    const res = applyOps(shortDoc, [ops.set('card', path, value)]);
    assert.equal(res.error, undefined, `${path}: ${JSON.stringify(res.error)}`);
  }
  // а сама мёртвая ссылка новой правкой не пишется
  assert.equal(applyOps(shortDoc, [ops.set('a', 'layout', { mode: 'row', gap: 'spacing.6' })]).error?.code, 'bad-node');

  // отмена после укорочения шкалы: инверсия пишет то, что было, включая мёртвые ссылки
  const tx = [ops.set('card', 'layout.gap', 'spacing.2'), ops.remove('card')];
  const inv = invertOps(shortDoc, tx);
  const after = applyOps(shortDoc, tx);
  assert.equal(after.error, undefined);
  const back = applyOps(after.doc, inv);
  assert.equal(back.error, undefined, 'отмена не отказывает: ' + JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, shortDoc.nodes, 'документ восстановлен со ссылкой spacing.6');
});

test('круг20 п.2: resolveScale — единственная точка разрешения; resolveLayout и resolveRadius идут через неё', () => {
  const doc = createDoc('empty');
  assert.equal(resolveScale(doc, 16), 16, 'число проходит как есть');
  assert.equal(resolveScale(doc, 'spacing.6'), 16);
  assert.equal(resolveScale(doc, 'spacing.6', 'spacing'), 16);
  assert.equal(resolveScale(doc, 'radii.7'), 999);
  assert.equal(resolveScale(doc, 'spacing.6', 'radii'), undefined, 'не та шкала — undefined');
  assert.equal(resolveScale(doc, 'spacing.13'), undefined, 'шага 13 нет — undefined');
  assert.equal(resolveScale(doc, 'spacing.x'), undefined);
  assert.equal(resolveScale(doc, null), undefined);
  assert.equal(resolveScale(doc, { token: 'spacing.6' }), undefined);
  assert.equal(resolveScale(null, 'spacing.6'), 16, 'без документа — шкала по умолчанию');
  assert.equal(resolveScale({ tokens: { spacing: [0, 100] } }, 'spacing.1'), 100, 'своя шкала главнее умолчаний');
  assert.equal(resolveScale({ tokens: { spacing: [0, 'много'] } }, 'spacing.1'), undefined, 'нечисло в шаге — мёртвая');
  assert.equal(scaleIndexOf(doc, 'spacing', 16), 6);
  assert.equal(scaleIndexOf(doc, 'spacing', 7), -1);
  assert.equal(scaleIndexOf(doc, 'radii', 999), 7);
  assert.equal(scaleIndexOf(doc, 'spacing', 'spacing.6'), -1, 'индекс ищется только по числу');
  assert.deepEqual(scaleSteps(doc, 'spacing'), DEFAULT_TOKENS.spacing);

  const L = resolveLayout(doc, { mode: 'row', gap: 'spacing.6', padding: { t: 'spacing.8', r: 4, b: 'spacing.99', l: 'radii.3' } });
  assert.deepEqual(L, { mode: 'row', gap: 16, padding: { t: 24, r: 4, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false },
    'мёртвая и чужая ссылка — 0, число — как есть');
  assert.equal(resolveRadius(doc, 'radii.4'), 16);
  assert.equal(resolveRadius(doc, 12), 12);
  assert.equal(resolveRadius(doc, 'radii.99'), 0);
  assert.equal(resolveRadius(doc, ['radii.4', 'radii.4']), 0, 'покорнерный массив рисуется как прежде — нулём');
  assert.equal(resolveRadius(doc, undefined), 0);
  // normalizeLayout — форма хранения: ссылки остаются строками
  const N = normalizeLayout({ mode: 'row', gap: 'spacing.6', padding: 'spacing.4' });
  assert.equal(N.gap, 'spacing.6');
  assert.deepEqual(N.padding, { t: 'spacing.4', r: 'spacing.4', b: 'spacing.4', l: 'spacing.4' });
});

test('круг20 п.2+п.7: демо-документ целиком на ссылках и считается байт в байт как на числах', () => {
  const doc = createDoc();
  const census = scaleCensus(doc);
  assert.equal(census.nums, 0, 'в демо нет ни одного числа в gap/padding/radius');
  assert.ok(census.refs > 150, 'ссылок много: ' + census.refs);
  // состав не поехал: доски, тексты, библиотека, экземпляры круга 19
  assert.equal(artboards(doc).length, 2);
  assert.ok(libraryNode(doc), 'библиотека на месте');
  assert.equal(components(doc).length, 3, 'три компонента');
  assert.equal(Object.values(doc.nodes).filter((n) => n.type === 'instance').length, 4, 'четыре экземпляра');
  assert.ok(Object.values(doc.nodes).filter((n) => n.type === 'text').length >= 49, 'тексты на месте');

  const twin = numericTwin(doc);
  assert.equal(scaleCensus(twin).refs, 0, 'двойник — целиком на числах');
  const geoRefs = solve(doc, M);
  const geoNums = solve(twin, M);
  assert.equal(hashGeometry(geoRefs), hashGeometry(geoNums), 'геометрия совпадает байт в байт');
  assert.deepStrictEqual(geoRefs.rects, geoNums.rects);
  assert.equal(Object.keys(geoRefs.expanded).length, Object.keys(geoNums.expanded).length, 'раскрытие экземпляров то же');
  for (const id of Object.keys(doc.nodes)) if (id !== doc.root) assert.ok(geoRefs.rects[id], 'прямоугольник у ' + id);
  const errors = validate(doc, geoRefs, M).filter((v) => v.severity === 'error');
  assert.deepEqual(errors, [], 'валидатор молчит на здоровом документе');
  assert.equal(validate(doc, geoRefs, M).filter((v) => v.code === 'off-scale').length, 0, 'ссылки по определению в шкале');
  // JSON-круг через createDoc(seed) ссылки сохраняет
  const round = createDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(scaleCensus(round).nums, 0);
  assert.equal(hashGeometry(solve(round, M)), hashGeometry(geoRefs));
});

test('круг20 п.2: раскрытые экземпляры считаются по ссылкам мастера', () => {
  // мастер на ссылках → экземпляр раскрывается через resolveLayout/resolveRadius с теми же токенами
  let doc = libScene((d, lib) => [
    ops.set('btn', 'layout', { mode: 'row', gap: 'spacing.4', padding: { t: 'spacing.4', r: 'spacing.6', b: 'spacing.4', l: 'spacing.6' } }),
    ops.set('btn', 'radius', 'radii.2'),
    ops.create(inst('i1', 'ab', 'btn', { 'текст': 'Оплатить' }))
  ]);
  const geo = solve(doc, M);
  assert.equal(geo.expanded['i1/lab'].parent, 'i1');
  assert.equal(geo.rects['i1/lab'].x - geo.rects.i1.x, 16, 'padding.l мастера = spacing.6 = 16 внутри экземпляра');
  assert.equal(geo.rects['i1/lab'].y - geo.rects.i1.y, 8, 'padding.t = spacing.4 = 8');
  // смена шага переверстывает экземпляр — без правки узлов
  const wider = applyOps(doc, [ops.setToken('spacing.6', 40)]).doc;
  const geo2 = solve(wider, M);
  assert.equal(geo2.rects['i1/lab'].x - geo2.rects.i1.x, 40, 'экземпляр подхватил новый шаг');
  assert.equal(geo2.rects.i1.w, geo.rects.i1.w + 48, 'ширина кнопки выросла на 2×24');
  // отсоединённая копия несёт те же ссылки
  const det = applyOps(doc, detachInstanceOps(doc, 'i1'));
  assert.equal(det.error, undefined, JSON.stringify(det.error));
  const copy = Object.values(det.doc.nodes).find((n) => n.type === 'frame' && n.parent === 'ab' && n.id !== 'btn');
  assert.equal(copy.layout.gap, 'spacing.4');
  assert.equal(copy.radius, 'radii.2');
});

test('круг20 п.3: keepFieldForm — число, равное значению ссылки, оставляет ссылку; ссылка поверх числа — правка', () => {
  const doc = scene(() => [
    ops.create(frame('r', 'ab', { mode: 'column', gap: 'spacing.6', padding: { t: 'spacing.8', r: 'spacing.7', b: 'spacing.8', l: 'spacing.7' } },
      HUG, { radius: 'radii.4' })),
    ops.create(frame('n', 'ab', { mode: 'column', gap: 16, padding: { t: 24, r: 20, b: 24, l: 20 } }, HUG, { radius: 16 })),
    ops.create(box('arr', 'ab', 10, 10, { radius: ['radii.4', 'radii.2', 0, 'radii.1'] }))
  ]);
  const R = doc.nodes.r;
  const N = doc.nodes.n;
  const same = (path, value, want, msg) => {
    const res = applyOps(doc, [ops.set(R.id, path, value)]);
    assert.equal(res.error, undefined, `${path}: ${JSON.stringify(res.error)}`);
    const got = path.split('.').reduce((o, k) => (o ? o[k] : undefined), res.doc.nodes.r);
    assert.deepStrictEqual(got, want, msg || `${path} = ${JSON.stringify(value)}`);
    return res.doc.nodes.r;
  };
  // число, равное значению ссылки → поле байт в байт
  same('layout.gap', 16, 'spacing.6', 'gap 16 при spacing.6 (16): остаётся ссылка');
  same('layout.padding.t', 24, 'spacing.8');
  same('radius', 16, 'radii.4');
  same('layout.padding', 24, { t: 'spacing.8', r: 24, b: 'spacing.8', l: 24 },
    'краткая запись: совпавшие стороны остаются ссылками, остальные — числа');
  assert.deepStrictEqual(applyOps(doc, [ops.set('r', 'layout.padding', { t: 24, r: 20, b: 24, l: 20 })]).doc.nodes.r.layout.padding,
    R.layout.padding, 'объект с теми же числами — padding байт в байт');
  const whole = applyOps(doc, [ops.set('r', 'layout', { mode: 'column', gap: 16, padding: { t: 24, r: 20, b: 24, l: 20 }, align: 'center', justify: 'start', wrap: false })]);
  assert.equal(whole.error, undefined);
  assert.deepStrictEqual(whole.doc.nodes.r.layout, { ...R.layout, align: 'center' }, 'целый layout: ссылки целы, align сменился');
  // другое число → число (поле становится «мимо шкалы» или другим шагом, но числом)
  same('layout.gap', 20, 20, 'gap 20 при spacing.6 (16): настоящая правка, пишется число');
  same('radius', 12, 12);
  // ссылка поверх числа — настоящая правка
  const overNum = applyOps(doc, [ops.set('n', 'layout.gap', 'spacing.6'), ops.set('n', 'radius', 'radii.4'), ops.set('n', 'layout.padding.t', 'spacing.8')]);
  assert.equal(overNum.error, undefined);
  assert.equal(overNum.doc.nodes.n.layout.gap, 'spacing.6', 'число 16 стало ссылкой — это смена смысла при той же картинке');
  assert.equal(overNum.doc.nodes.n.radius, 'radii.4');
  assert.equal(overNum.doc.nodes.n.layout.padding.t, 'spacing.8');
  assert.equal(hashGeometry(solve(overNum.doc, M)), hashGeometry(solve(doc, M)), 'картинка не изменилась');
  assert.notEqual(JSON.stringify(overNum.doc.nodes.n), JSON.stringify(N), 'а документ — изменился');
  // ссылка поверх ссылки пишется буквально, даже при равных значениях шагов
  const twoSteps = applyOps(doc, [ops.setToken('spacing', [0, 2, 4, 6, 8, 12, 16, 16, 24]), ops.set('r', 'layout.gap', 'spacing.7')]);
  assert.equal(twoSteps.doc.nodes.r.layout.gap, 'spacing.7');
  // exact: true пишет число буквально — так инверсия возвращает исходную форму
  const exact = { ...ops.set('r', 'layout.gap', 16), exact: true };
  assert.equal(applyOps(doc, [exact]).doc.nodes.r.layout.gap, 16);
  // покорнерный массив — поэлементно
  assert.deepStrictEqual(applyOps(doc, [ops.set('arr', 'radius', [16, 8, 0, 4])]).doc.nodes.arr.radius, ['radii.4', 'radii.2', 0, 'radii.1']);
  assert.deepStrictEqual(applyOps(doc, [ops.set('arr', 'radius', [16, 8, 0, 5])]).doc.nodes.arr.radius, ['radii.4', 'radii.2', 0, 5]);
  // инверсия «правки тем же значением» и настоящей правки восстанавливает форму
  for (const tx of [[ops.set('r', 'layout.gap', 16)], [ops.set('r', 'layout.gap', 20)], [ops.set('n', 'layout.gap', 'spacing.6')], [ops.set('r', 'radius', 12)]]) {
    const inv = invertOps(doc, tx);
    const back = applyOps(applyOps(doc, tx).doc, inv);
    assert.deepStrictEqual(back.doc.nodes, doc.nodes, JSON.stringify(tx));
  }
  // и сама функция — экспортирована, чтобы мозг мог звать её, а не догадываться
  assert.equal(keepFieldForm(R, 'layout.gap', 16, doc), 'spacing.6');
  assert.equal(keepFieldForm(R, 'layout.gap', 20, doc), 20);
  assert.equal(keepFieldForm(R, 'layout.gap', 'spacing.6', doc), 'spacing.6');
  assert.equal(keepFieldForm(N, 'layout.gap', 'spacing.6', doc), 'spacing.6');
  assert.equal(keepFieldForm(N, 'layout.gap', 16, doc), 16);
  assert.equal(keepFieldForm(R, 'radius', 16, doc), 'radii.4');
  assert.deepEqual(keepFieldForm(R, 'layout.padding', 24, doc), { t: 'spacing.8', r: 24, b: 'spacing.8', l: 24 });
  assert.equal(keepFieldForm(R, 'layout.padding.l', 20, doc), 'spacing.7');
  assert.equal(keepFieldForm(R, 'layout.mode', 'row', doc), 'row', 'чужие пути — как есть');
  assert.equal(keepFieldForm({ ...R, style: { token: 'body' } }, 'style', 'body', doc).token, 'body', 'круг 16 не сломан');
  assert.equal(keepFieldForm(R, 'layout.gap', undefined, doc), undefined);
});

test('круг20 п.4: валидатор — dead-scale-ref (error) на мёртвую ссылку, off-scale (info) для чисел как был', () => {
  let doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 'spacing.6', padding: { t: 'spacing.8', r: 7, b: 'spacing.8', l: 7 } }, HUG, { radius: 'radii.4' })),
    ops.create(box('a', 'card', 40, 20, { radius: 'radii.7' })),
    ops.create(box('b', 'card', 40, 20))
  ]);
  const codes = (d) => validate(d, solve(d, M), M);
  const healthy = codes(doc);
  assert.deepEqual(healthy.filter((v) => v.code === 'dead-scale-ref'), [], 'живые ссылки не тревожат');
  const off = healthy.filter((v) => v.code === 'off-scale');
  assert.equal(off.length, 1);
  assert.equal(off[0].severity, 'info');
  assert.match(off[0].message, /padding\.r 7, padding\.l 7/, 'число 7 мимо шкалы — info, ссылки не упомянуты');

  // укоротили шкалу — ссылки умерли, решатель считает их нулём, валидатор говорит об этом
  const short = applyOps(doc, [ops.setToken('spacing', [0, 4, 8]), ops.setToken('radii', [0, 4])]).doc;
  const geo = solve(short, M);
  assert.equal(geo.rects.a.y, 0, 'padding.t мёртв → 0');
  assert.equal(geo.rects.b.y, 20, 'gap мёртв → 0');
  const dead = codes(short).filter((v) => v.code === 'dead-scale-ref');
  assert.equal(dead.length, 2, 'по строке на узел: card (gap, padding.t/b, radius) и a (radius)');
  for (const v of dead) assert.equal(v.severity, 'error');
  const card = dead.find((v) => v.nodeId === 'card');
  assert.match(card.message, /layout\.gap → шага «spacing\.6» нет/);
  assert.match(card.message, /layout\.padding\.t/);
  assert.match(card.message, /radius → шага «radii\.4» нет/);
  assert.match(card.message, /в шкале отступов 3 шага \(0\.\.2\)/);
  assert.ok(!/padding\.r/.test(card.message), 'число 7 — не мёртвая ссылка');
  assert.match(dead.find((v) => v.nodeId === 'a').message, /radii\.7/);
  // библиотека — страница, но раскладка у неё есть, и мёртвую ссылку там тоже видно
  const lib = ensureLibrary(doc);
  const libShort = applyOps(lib, [ops.setToken('spacing', [0, 4])]).doc;
  assert.ok(codes(libShort).some((v) => v.code === 'dead-scale-ref' && v.nodeId === libraryId(libShort)), 'зазор библиотеки spacing.8 умер');
  // документ из файла с мёртвой ссылкой: узел остаётся (это не мусор), валидатор говорит
  const raw = JSON.parse(JSON.stringify(doc));
  raw.nodes.card.layout.gap = 'spacing.40';
  raw.nodes.a.radius = 'radii.40';
  raw.nodes.b.radius = 'spacing.2';            // не та шкала — снимается при импорте
  raw.nodes.card.layout.padding.r = 'radii.1';  // не та шкала — ноль при импорте
  const imported = createDoc(raw);
  assert.equal(imported.nodes.card.layout.gap, 'spacing.40', 'мёртвая ссылка сохранена');
  assert.equal(imported.nodes.a.radius, 'radii.40');
  assert.equal(imported.nodes.b.radius, undefined, 'ссылка не в ту шкалу снята');
  assert.equal(imported.nodes.card.layout.padding.r, 0, 'ссылка не в ту шкалу → 0');
  const impDead = codes(imported).filter((v) => v.code === 'dead-scale-ref');
  assert.deepEqual(impDead.map((v) => v.nodeId).sort(), ['a', 'card']);
});

test('круг20 п.5: ensureScaleRefs — идемпотентная миграция без мутации входа, геометрия та же, отменяемая', () => {
  const doc = scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 16, padding: { t: 24, r: 7, b: 24, l: 20 } }, HUG, { radius: 16 })),
    ops.create(box('a', 'card', 40, 20, { radius: 999 })),
    ops.create(box('b', 'card', 40, 20, { radius: [12, 5, 0, 4] })),
    ops.create(label('t', 'card', 'текст')),
    ops.create(frame('plain', 'ab', { mode: 'row', gap: 0 }, HUG))
  ]);
  const snapshot = JSON.stringify(doc);
  const before = solve(doc, M);
  const list = ensureScaleRefsOps(doc);
  assert.ok(list.length >= 4, 'операции есть: ' + list.length);
  assert.ok(list.every((o) => o.op === 'set' && /^(layout\.gap|layout\.padding\.[trbl]|radius(\.\d+)?)$/.test(o.path)),
    'по операции на переводимое поле: ' + JSON.stringify(list.map((o) => o.path)));
  assert.ok(!list.some((o) => o.id === 'card' && o.path === 'layout.padding.r'), '7 мимо шкалы — операции на него нет');
  assert.ok(list.some((o) => o.id === 'b' && o.path === 'radius.3' && o.value === 'radii.1'), 'элемент покорнерного массива — своей операцией');
  const migrated = ensureScaleRefs(doc);
  assert.equal(JSON.stringify(doc), snapshot, 'вход не мутирован');
  assert.notEqual(migrated, doc);
  assert.equal(migrated.nodes.card.layout.gap, 'spacing.6');
  assert.deepEqual(migrated.nodes.card.layout.padding, { t: 'spacing.8', r: 7, b: 'spacing.8', l: 'spacing.7' }, '7 мимо шкалы остаётся числом');
  assert.equal(migrated.nodes.card.radius, 'radii.4');
  assert.equal(migrated.nodes.a.radius, 'radii.7', '999 — шаг «круглый»');
  assert.deepEqual(migrated.nodes.b.radius, ['radii.3', 5, 'radii.0', 'radii.1'], 'покорнерный массив поэлементно');
  assert.equal(migrated.nodes.plain.layout.gap, 'spacing.0', 'ноль — тоже шаг');
  assert.deepEqual(migrated.nodes.plain.layout.padding, { t: 'spacing.0', r: 'spacing.0', b: 'spacing.0', l: 'spacing.0' });
  assert.equal(migrated.nodes.ab.layout.gap, 'spacing.0');
  assert.equal(migrated.nodes.t.radius, undefined, 'у текста скругления не было — не появилось');
  assert.equal(scaleCensus(migrated).nums, 2, 'остались ровно два числа мимо шкалы: 7 и 5');
  assert.equal(hashGeometry(solve(migrated, M)), hashGeometry(before), 'геометрия не изменилась');
  // идемпотентность
  assert.equal(ensureScaleRefs(migrated), migrated, 'второй вызов возвращает тот же объект');
  assert.deepEqual(ensureScaleRefsOps(migrated), []);
  const demo = createDoc();
  assert.equal(ensureScaleRefs(demo), demo, 'демо уже на ссылках');
  // отменяемо как транзакция: инверсия возвращает числа
  const inv = invertOps(doc, list);
  const back = applyOps(applyOps(doc, list).doc, inv);
  assert.equal(back.error, undefined);
  assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'узлы восстановлены с числами');
  // соседнее поле с мёртвой ссылкой (файл, укороченная шкала) миграцию не останавливает
  const raw = JSON.parse(JSON.stringify(doc));
  raw.nodes.card.layout.gap = 'spacing.99';
  const partly = ensureScaleRefs(raw);
  assert.notEqual(partly, raw, 'миграция состоялась');
  assert.equal(partly.nodes.card.layout.gap, 'spacing.99', 'мёртвая ссылка не тронута — о ней скажет валидатор');
  assert.equal(partly.nodes.card.layout.padding.t, 'spacing.8', 'а соседнее число переведено');
  assert.ok(validate(partly, solve(partly, M), M).some((v) => v.code === 'dead-scale-ref' && v.nodeId === 'card'));
  // страница-библиотека из старого файла: раскладка числами → тоже на ссылки (у страницы set layout не нормализуется)
  const withLib = applyOps(doc, [ops.create({ type: 'page', id: 'lib', role: 'library', parent: doc.root, children: [], layout: { mode: 'column', gap: 24, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start', wrap: false } })]).doc;
  const libMigrated = ensureScaleRefs(withLib);
  assert.equal(libMigrated.nodes.lib.layout.gap, 'spacing.8');
  assert.equal(ensureScaleRefs(libMigrated), libMigrated);
  assert.equal(hashGeometry(solve(libMigrated, M)), hashGeometry(solve(withLib, M)));
  // мусорный вход не роняет
  assert.deepEqual(ensureScaleRefsOps(null), []);
  assert.equal(ensureScaleRefs(null), null);
  // неполный документ (без корня) — без операций
  assert.deepEqual(ensureScaleRefsOps({ nodes: {} }), []);
});

test('круг20 п.6: insertScaleStep вставляет шаг и переписывает ссылки — геометрия та же, отмена точная', () => {
  const doc = ensureScaleRefs(scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 16, padding: { t: 24, r: 8, b: 24, l: 8 } }, HUG, { radius: 16 })),
    ops.create(box('a', 'card', 40, 20, { radius: 4 })),
    ops.create(box('b', 'card', 40, 20, { radius: ['radii.7', 'radii.1', 0, 0] })),
    ops.create(frame('loose', 'ab', { mode: 'row', gap: 7 }, HUG))
  ]));
  const before = solve(doc, M);
  const refs = scaleRefsIn(doc, 'spacing');
  assert.ok(refs.some((r) => r.id === 'card' && r.path === 'layout.gap' && r.index === 6 && r.ref === 'spacing.6'), JSON.stringify(refs));
  assert.ok(refs.every((r) => r.scale === 'spacing'));
  assert.ok(scaleRefsIn(doc).some((r) => r.id === 'b' && r.path === 'radius.0' && r.scale === 'radii' && r.index === 7), 'покорнерные элементы перечислены путём radius.<k>');
  assert.equal(scaleRefsIn(doc, 'spacing').filter((r) => r.id === 'loose' && r.path === 'layout.gap').length, 0, 'gap 7 — число, в перечне его нет');
  assert.equal(scaleRefsIn(doc, 'radii').filter((r) => r.path.startsWith('layout')).length, 0, 'фильтр по шкале держится');

  // вставляем 14 между 12 (5) и 16 (6): все ссылки с индексом ≥ 6 сдвигаются на +1
  const list = insertScaleStep(doc, 'spacing', 6, 14);
  assert.equal(list[0].op, 'setToken');
  assert.deepEqual(list[0].value, [0, 2, 4, 6, 8, 12, 14, 16, 20, 24, 32, 40, 48, 64]);
  assert.ok(list.slice(1).every((o) => o.op === 'set'), 'дальше — перепись ссылок');
  const after = applyOps(doc, list);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.equal(after.doc.nodes.card.layout.gap, 'spacing.7', '16 теперь седьмой шаг');
  assert.equal(after.doc.nodes.card.layout.padding.t, 'spacing.9', '24 — девятый');
  assert.equal(after.doc.nodes.card.layout.padding.r, 'spacing.4', '8 — до вставки, не сдвинут');
  assert.equal(after.doc.nodes.loose.layout.gap, 7, 'число мимо шкалы не трогается');
  assert.equal(after.doc.nodes.card.radius, 'radii.4', 'другая шкала не трогается');
  assert.equal(hashGeometry(solve(after.doc, M)), hashGeometry(before), 'картинка не изменилась ни на пиксель');
  assert.deepEqual(validate(after.doc, solve(after.doc, M), M).filter((v) => v.code === 'dead-scale-ref'), []);
  // теперь новый шаг можно взять
  const use = applyOps(after.doc, [ops.set('card', 'layout.gap', 'spacing.6')]);
  assert.equal(use.error, undefined);
  assert.equal(solve(use.doc, M).rects.b.y - solve(use.doc, M).rects.a.y, 20 + 14);
  // отмена: сначала возвращаются ссылки, потом шкала
  const inv = invertOps(doc, list);
  const back = applyOps(after.doc, inv);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.deepStrictEqual(back.doc.nodes, doc.nodes);
  assert.deepStrictEqual(back.doc.tokens, doc.tokens);
  // скругления, включая покорнерный массив
  const radiiList = insertScaleStep(doc, 'radii', 1, 2);
  const r2doc = applyOps(doc, radiiList);
  assert.equal(r2doc.error, undefined, JSON.stringify(r2doc.error));
  assert.equal(r2doc.doc.nodes.card.radius, 'radii.5');
  assert.equal(r2doc.doc.nodes.a.radius, 'radii.2', '4 сдвинулось с 1 на 2');
  assert.deepEqual(r2doc.doc.nodes.b.radius, ['radii.8', 'radii.2', 'radii.0', 'radii.0'], 'нулевой шаг до вставки — на месте');
  assert.equal(hashGeometry(solve(r2doc.doc, M)), hashGeometry(before));
  const rback = applyOps(r2doc.doc, invertOps(doc, radiiList));
  assert.deepStrictEqual(rback.doc.nodes, doc.nodes);
  assert.deepStrictEqual(rback.doc.tokens, doc.tokens);
  // в конец: ссылки не сдвигаются; в начало: сдвигаются все
  const tail = insertScaleStep(doc, 'spacing', doc.tokens.spacing.length, 80);
  assert.equal(tail.length, 1, 'только setToken');
  const head = insertScaleStep(doc, 'spacing', 0, 1);
  assert.equal(head.length - 1, scaleRefsIn(doc, 'spacing').length, 'каждая ссылка переписана');
  assert.equal(applyOps(doc, head).doc.nodes.ab.layout.gap, 'spacing.1', 'нулевой шаг стал первым');
  // негодный вход — пустой список
  assert.deepEqual(insertScaleStep(doc, 'spacing', -1, 5), []);
  assert.deepEqual(insertScaleStep(doc, 'spacing', 99, 5), []);
  assert.deepEqual(insertScaleStep(doc, 'spacing', 1.5, 5), []);
  assert.deepEqual(insertScaleStep(doc, 'spacing', 1, -5), []);
  assert.deepEqual(insertScaleStep(doc, 'spacing', 1, NaN), []);
  assert.deepEqual(insertScaleStep(doc, 'colors', 1, 5), []);
  assert.deepEqual(insertScaleStep(null, 'spacing', 1, 5), []);
  // общая заготовка: любое правило переписи индексов
  const swap = rewriteScaleRefsOps(doc, 'spacing', (i) => (i === 6 ? 8 : i === 8 ? 6 : i));
  assert.equal(applyOps(doc, swap).doc.nodes.card.layout.gap, 'spacing.8');
  assert.equal(applyOps(doc, swap).doc.nodes.card.layout.padding.t, 'spacing.6');
  assert.deepEqual(rewriteScaleRefsOps(doc, 'spacing', () => -1), [], 'правило без ответа ничего не пишет');
});

test('круг20 п.8: setToken spacing.<i> переверстывает всё, что ссылается на шаг, — главное обещание круга', () => {
  const doc = createDoc();
  const geo = solve(doc, M);
  const byName = (name) => Object.values(doc.nodes).filter((n) => n.name === name);
  const card = byName('Карточка встречи')[0];
  assert.equal(card.layout.padding.t, 'spacing.6', 'у карточки отступ 16 — шестой шаг');
  assert.equal(card.layout.gap, 'spacing.4');
  const title = byName('Название встречи')[0];
  const status = byName('Строка статуса')[0];
  // шаг 6: 16 → 20
  const next = applyOps(doc, [ops.setToken('spacing.6', 20)]);
  assert.equal(next.error, undefined);
  assert.deepEqual(next.doc.nodes, doc.nodes, 'ни один узел не тронут — сменился только шаг шкалы');
  const geo2 = solve(next.doc, M);
  assert.equal(geo2.rects[status.id].x - geo2.rects[card.id].x, 20, 'отступ карточки вырос до 20');
  assert.equal(geo.rects[status.id].x - geo.rects[card.id].x, 16);
  assert.equal(geo2.rects[status.id].y - geo2.rects[card.id].y, 20);
  assert.equal(geo2.rects[title.id].y - geo2.rects[status.id].y, geo.rects[title.id].y - geo.rects[status.id].y, 'зазор 8 (шаг 4) не менялся');
  // всё, что ссылается на шаг 6, изменилось; что не ссылается — нет
  let moved = 0;
  let still = 0;
  for (const n of Object.values(doc.nodes)) {
    if (!n.layout || n.type !== 'frame') continue;
    const uses6 = n.layout.gap === 'spacing.6' || Object.values(n.layout.padding).includes('spacing.6');
    const kids = n.children.filter((c) => doc.nodes[c] && !doc.nodes[c].override);
    if (kids.length < 1) continue;
    const a = geo.rects[kids[0].valueOf()];
    const b = geo2.rects[kids[0].valueOf()];
    const pa = geo.rects[n.id];
    const pb = geo2.rects[n.id];
    const same = a.x - pa.x === b.x - pb.x && a.y - pa.y === b.y - pb.y;
    if (uses6 && !same) moved++;
    if (uses6 && same && (n.layout.padding.t === 'spacing.6' || n.layout.padding.l === 'spacing.6')) assert.fail(`«${n.name}» ссылается на шаг 6, но первый ребёнок не сдвинулся`);
    if (!uses6) still++;
  }
  assert.ok(moved >= 5, 'сдвинулись контейнеры со ссылкой на шаг 6: ' + moved);
  assert.ok(still >= 5, 'контейнеры без ссылки проверены: ' + still);
  // экземпляры круга 19: мастер «Метка» (hug) с padding r/l = spacing.5 — правим шаг 5 (12 → 40)
  const tagInst = Object.values(doc.nodes).find((n) => n.type === 'instance' && n.props && n.props['текст'] === 'сегодня');
  const tagMaster = doc.nodes[tagInst.of];
  assert.equal(tagMaster.layout.padding.l, 'spacing.5', 'мастер метки на ссылках');
  const g3 = solve(applyOps(doc, [ops.setToken('spacing.5', 40)]).doc, M);
  const labelId = Object.keys(geo.expanded).find((id) => id.startsWith(tagInst.id + '/') && geo.expanded[id].type === 'text');
  assert.equal(geo.rects[labelId].x - geo.rects[tagInst.id].x, 12, 'до правки подпись стоит на padding.l = 12');
  assert.equal(g3.rects[labelId].x - g3.rects[tagInst.id].x, 40, 'подпись внутри экземпляра отъехала на новый шаг');
  assert.equal(g3.rects[tagInst.id].w, geo.rects[tagInst.id].w + 56, 'метка стала шире на 2×28 — узлы экземпляра не менялись');
  // скругление: шаг 4 шкалы radii (16 → 4) — рисуется по разрешённому значению
  const r4 = applyOps(doc, [ops.setToken('radii.4', 4)]).doc;
  assert.equal(resolveRadius(r4, card.radius), 4);
  assert.equal(resolveRadius(doc, card.radius), 16);
  // отмена возвращает и шкалу, и вёрстку
  const inv = invertOps(doc, [ops.setToken('spacing.6', 20)]);
  assert.equal(hashGeometry(solve(applyOps(next.doc, inv).doc, M)), hashGeometry(geo));
});

test('круг20 п.8: цена разрешения ссылок — solve на сотнях узлов', () => {
  // документ из N карточек с зазорами и отступами: на ссылках и его двойник на числах
  const N = 120;
  const build = [];
  for (let i = 0; i < N; i++) {
    build.push(ops.create(frame('c' + i, 'ab', { mode: 'row', gap: 'spacing.4', padding: { t: 'spacing.5', r: 'spacing.6', b: 'spacing.5', l: 'spacing.6' } },
      { w: { mode: 'fill' }, h: { mode: 'hug' } }, { radius: 'radii.3', fill: 'surfaceAlt' })));
    build.push(ops.create(box('r' + i, 'c' + i, 24, 24, { radius: 'radii.7' })));
    build.push(ops.create(label('t' + i, 'c' + i, 'Пункт ' + i)));
    build.push(ops.create(frame('n' + i, 'c' + i, { mode: 'column', gap: 'spacing.1' }, { w: { mode: 'fill' }, h: { mode: 'hug' } })));
    build.push(ops.create(label('u' + i, 'n' + i, 'подпись ' + i)));
  }
  const doc = scene(() => [
    ops.set('ab', 'layout', { mode: 'column', gap: 'spacing.4', padding: { t: 'spacing.6', r: 'spacing.6', b: 'spacing.6', l: 'spacing.6' }, align: 'stretch' }),
    ops.set('ab', 'size.h', { mode: 'hug' }),
    ...build
  ]);
  const twin = numericTwin(doc);
  assert.equal(Object.keys(doc.nodes).length, 2 + N * 5);
  const time = (d) => {
    const t0 = performance.now();
    let h;
    for (let k = 0; k < 5; k++) h = hashGeometry(solve(d, { measureText: (t, s) => measureText(t, s) }));   // свежая функция — без кеша ширин
    return { ms: (performance.now() - t0) / 5, h };
  };
  time(doc); time(twin);   // прогрев
  const a = time(twin);
  const b = time(doc);
  assert.equal(a.h, b.h, 'геометрия ссылок и чисел совпадает');
  assert.ok(b.ms < 1500, `solve на ссылках: ${b.ms.toFixed(1)} мс`);
  assert.ok(b.ms < Math.max(a.ms * 3, a.ms + 30), `ссылки не должны стоить втрое дороже чисел: ${a.ms.toFixed(1)} → ${b.ms.toFixed(1)} мс`);
  if (process.env.IMAGO_PERF) console.log(`  [перф] ${Object.keys(doc.nodes).length} узлов: числа ${a.ms.toFixed(1)} мс, ссылки ${b.ms.toFixed(1)} мс`);
});

test('круг20 п.9: сцена, экспорт, инлайн-правка, ресайз и сдвиг стрелками работают на ссылках', async () => {
  const doc = ensureScaleRefs(scene(() => [
    ops.create(frame('card', 'ab', { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 } },
      { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 80 } }, { clip: true, radius: 12, fill: 'surfaceAlt' })),
    ops.create(label('t', 'card', 'Планёрка', { size: { w: { mode: 'fill' }, h: { mode: 'hug' } } })),
    ops.create(box('bx', 'card', 20, 20, { radius: 999 })),
    ops.create(frame('free', 'ab', { mode: 'none', padding: { t: 12, r: 12, b: 12, l: 12 } },
      { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } })),
    ops.create(box('p', 'free', 10, 10, { pos: { x: 5, y: 5 } }))
  ]));
  assert.equal(doc.nodes.card.radius, 'radii.3');
  assert.equal(doc.nodes.card.layout.gap, 'spacing.4');
  assert.equal(doc.nodes.free.layout.padding.l, 'spacing.5');
  const geo = solve(doc, M);

  // экспорт SVG: rx — разрешённые числа, ссылок в разметке нет
  await withSvgDom(() => {
    const st = bareStage({ rects: geo.rects });
    st.doc = doc; st.geo = geo; st.activeArtboard = 'ab';
    st.errors = []; st.opts = { onError: (i) => st.errors.push(i.where) };
    const svg = st.toSVG('ab');
    assert.deepEqual(st.errors, []);
    assert.ok(/rx="12"/.test(svg), 'скругление карточки 12 (radii.3): ' + svg.slice(0, 300));
    assert.ok(/rx="999"/.test(svg), 'скругление 999 у квадрата');
    assert.ok(!/radii\.|spacing\./.test(svg), 'в разметке нет ссылок');
    // подложка доски тоже через разрешение
    const st2 = bareStage({ rects: geo.rects });
    const d2 = applyOps(doc, [ops.set('ab', 'radius', 'radii.5')]).doc;
    st2.doc = d2; st2.geo = solve(d2, M); st2.activeArtboard = 'ab';
    st2.errors = []; st2.opts = { onError: (i) => st2.errors.push(i.where) };
    assert.ok(/rx="20"/.test(st2.toSVG('ab')), 'подложка доски: radii.5 = 20');
  });

  // сдвиг стрелками в потоке → override от координат родителя (ссылки не мешают)
  const st = gestureStage(doc, geo, ['t']);
  const nudge = st._nudgeOps('t', 3, 0);
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].path, 'override');
  assert.equal(nudge[0].value.x, geo.rects.t.x - geo.rects.card.x + 3);
  assert.equal(nudge[0].value.x, 8 + 3, 'padding.l = spacing.4 = 8');
  // в свободной раскладке — pos, из которого вычтен разрешённый отступ
  const nudgeFree = st._nudgeOps('p', 0, 2);
  assert.deepEqual(nudgeFree, [ops.set('p', 'pos', { x: 5, y: 7 })]);
  const res = applyOps(doc, nudge.concat(nudgeFree));
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(solve(res.doc, M).rects.p.y, geo.rects.p.y + 2);

  // ресайз с перемещением в свободной раскладке: pos считается от разрешённого padding
  const st3 = gestureStage(doc, geo, ['p']);
  st3.opts = { measureText };
  const d = { mode: 'resize', id: 'p', handle: 'nw', start: { x: 0, y: 0 }, rect0: { ...geo.rects.p }, preview: { ...geo.rects.p } };
  st3._updateResize(d, { x: -4, y: -4 }, { altKey: false, shiftKey: false });
  const rs = st3._resizeOps(d);
  const posOp = rs.find((o) => o.path === 'pos');
  assert.ok(posOp, 'сдвиг ручки nw пишет pos: ' + JSON.stringify(rs));
  assert.equal(posOp.value.x, 1, 'x = (12+5−4) − 12 = 1: padding = spacing.5 = 12 вычтен');
  assert.equal(applyOps(doc, rs).error, undefined);

  // перестановка в потоке: слоты и маркер вставки по разрешённому зазору
  const st4 = gestureStage(doc, geo, ['bx']);
  const mv = { mode: 'move', id: 'bx', start: { x: 50, y: geo.rects.bx.y + 5 }, rect0: { ...geo.rects.bx } };
  st4._updateMove(mv, { x: 50, y: geo.rects.t.y - 1 }, {});
  st4._commitMove(mv);
  assert.equal(st4.commits.length, 1);
  assert.deepEqual(applyOps(doc, st4.commits[0].ops).doc.nodes.card.children, ['bx', 't']);

  // магниты: отступ родителя — разрешённое число
  const snap = st._snap({ x: geo.rects.card.x + 9, y: geo.rects.card.y + 30, w: 20, h: 20 }, doc.nodes.bx);
  assert.equal(snap.x, geo.rects.card.x + 8, 'прилипло к внутренней кромке padding.l = 8');

  // инлайн-правка текста — set characters, ссылки узла-родителя не мешают применению
  const edit = applyOps(doc, [ops.set('t', 'characters', 'Планёрка по редактору')]);
  assert.equal(edit.error, undefined);
  assert.equal(edit.doc.nodes.card.layout.gap, 'spacing.4', 'соседние поля не тронуты');
  // дублирование сохраняет ссылки
  const st5 = gestureStage(doc, geo, ['card']);
  st5._duplicate(['card']);
  const dup = applyOps(doc, st5.commits[0].ops);
  assert.equal(dup.error, undefined, JSON.stringify(dup.error));
  const copy = Object.values(dup.doc.nodes).find((n) => n.name === 'card копия');
  assert.equal(copy.layout.gap, 'spacing.4');
  assert.equal(copy.radius, 'radii.3');
});

test('круг20: property — операции со ссылками отменяются точно, решатель детерминирован (200 прогонов)', () => {
  const rnd = mulberry32(20260927);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const SET_CASES = [
    ['radius', () => pick([0, 4, 12, 'radii.0', 'radii.3', 'radii.7', 'radii.9', ['radii.1', 0, 'radii.2', 8]])],
    ['layout.gap', () => pick([0, 8, 16, 'spacing.0', 'spacing.4', 'spacing.6', 'spacing.12', 'spacing.40'])],
    ['layout.padding', () => pick([8, 'spacing.4', ['spacing.2', 'spacing.3'], { t: 'spacing.1', r: 2, b: 'spacing.99', l: 0 }])],
    ['layout.padding.t', () => pick([0, 12, 'spacing.5', 'spacing.99'])],
    ['layout', () => pick([
      { mode: 'row', gap: 'spacing.2', padding: 'spacing.3', align: 'center', justify: 'start', wrap: false },
      { mode: 'column', gap: 4, padding: { t: 2, r: 2, b: 2, l: 2 }, align: 'start', justify: 'between', wrap: true }
    ])],
    ['fill', () => pick(['#ff0000', 'accent'])],
    ['name', () => pick(['А', 'Б'])]
  ];
  const TOKEN_CASES = [
    ['spacing', () => pick([[0, 4, 8, 16], [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80]])],
    ['spacing.6', () => pick([12, 20, 30])],
    ['radii', () => pick([[0, 4], [0, 4, 8, 12, 16, 20, 24, 999, 1200]])],
    ['radii.3', () => pick([10, 14])]
  ];
  let seq = 0;
  const genOp = (d) => {
    const ids = Object.keys(d.nodes).filter((id) => id !== d.root);
    const roll = rnd();
    if (roll < 0.5) { const [path, val] = pick(SET_CASES); return ops.set(pick(ids), path, val()); }
    if (roll < 0.62) return ops.remove(pick(ids.filter((id) => id !== 'ab')));
    if (roll < 0.78) {
      const id = 'g' + (seq++);
      return ops.create(frame(id, pick(ids.filter((x) => d.nodes[x].type === 'frame')), { mode: 'column', gap: pick([4, 'spacing.3', 'spacing.50']) }, HUG, { radius: pick([2, 'radii.2']) }));
    }
    if (roll < 0.86) { const [scale, index] = pick([['spacing', 6], ['radii', 2], ['spacing', 0]]); return insertScaleStep(d, scale, index, 3); }
    if (roll < 0.92) return ensureScaleRefsOps(d);
    const [path, val] = pick(TOKEN_CASES);
    return ops.setToken(path, val());
  };
  let applied = 0;
  let rejected = 0;
  for (let run = 0; run < 200; run++) {
    const doc = ensureScaleRefs(scene(() => [
      ops.create(frame('card', 'ab', { mode: 'column', gap: 6, padding: { t: 8, r: 8, b: 8, l: 8 } }, fixed(200, 120), { radius: 12 })),
      ops.create(label('t1', 'card', 'Первый текст')),
      ops.create(frame('inner', 'card', { mode: 'row', gap: 4 }, { w: { mode: 'fill' }, h: { mode: 'hug' } }, { radius: [4, 4, 0, 0] })),
      ops.create(box('bx', 'inner', 20, 20, { radius: 999 })),
      ops.create(box('tail', 'ab', 40, 40, { radius: 7 }))
    ]));
    const tx = [];
    let cur = doc;
    for (let guard = 0; tx.length < 6 && guard < 80; guard++) {
      const op = genOp(cur);
      const list = Array.isArray(op) ? op : [op];
      if (!list.length) continue;
      const step = applyOps(cur, list);
      if (step.error) { rejected++; continue; }
      for (const o of list) tx.push(o);
      cur = step.doc;
      applied++;
    }
    if (tx.length < 6) continue;
    const after = applyOps(doc, tx);
    assert.equal(after.error, undefined, 'прогон ' + run + ': ' + JSON.stringify(after.error));
    const geoA = solve(after.doc, M);
    assert.equal(hashGeometry(solve(after.doc, M)), hashGeometry(geoA), 'прогон ' + run + ': детерминизм');
    for (const id of Object.keys(geoA.rects)) for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(geoA.rects[id][k]), `прогон ${run}: ${id}.${k}`);
    // валидатор про ссылки не молчит зря и не врёт: dead-scale-ref ⇔ есть ссылка, которая не разрешается
    const dead = validate(after.doc, geoA, M).filter((v) => v.code === 'dead-scale-ref').map((v) => v.nodeId).sort();
    const expect = Object.keys(after.doc.nodes).filter((id) => {
      const n = after.doc.nodes[id];
      const vals = [];
      const l = n.layout;
      if (l && typeof l === 'object') {
        vals.push(['spacing', l.gap]);
        // у не-фрейма раскладка лежит сырой: padding может быть строкой или отсутствовать
        if (l.padding && typeof l.padding === 'object') for (const v of Object.values(l.padding)) vals.push(['spacing', v]);
        else vals.push(['spacing', l.padding]);
      }
      if (n.radius !== undefined) vals.push(...(Array.isArray(n.radius) ? n.radius : [n.radius]).map((v) => ['radii', v]));
      return vals.some(([s, v]) => parseScaleRef(v) && resolveScale(after.doc, v, s) === undefined);
    }).sort();
    assert.deepEqual(dead, expect, 'прогон ' + run + ': dead-scale-ref ровно там, где мёртвые ссылки');
    const back = applyOps(after.doc, invertOps(doc, tx));
    assert.equal(back.error, undefined, 'прогон ' + run + ': ' + JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes, doc.nodes, 'прогон ' + run + ': узлы восстановлены\n' + JSON.stringify(tx));
    assert.deepStrictEqual(back.doc.tokens, doc.tokens, 'прогон ' + run + ': токены восстановлены');
    assert.equal(hashGeometry(solve(back.doc, M)), hashGeometry(solve(doc, M)), 'прогон ' + run + ': геометрия восстановлена');
  }
  assert.ok(applied >= 800, 'операции в основном применяются: ' + applied);
  assert.ok(rejected >= 20, 'а мёртвые ссылки отклоняются: ' + rejected);
});

/* ------------------- круг 22 (SPEC §8.3): отмена на уровне пути ------------------- */

/** Замораживает объект вглубь: любая запись в него бросит в strict-модуле. */
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

test('круг22: отмена set gap — на уровне пути; параллельно изменённый padding цел', () => {
  const doc = scene(() => [ops.create(frame('card', 'ab', { mode: 'column', gap: 4, padding: { t: 8, r: 8, b: 8, l: 8 } }, HUG))]);
  const tx = [ops.set('card', 'layout.gap', 12)];
  const inv = invertOps(doc, tx);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].path, 'layout.gap', 'обратная операция адресует лист, а не голову');
  assert.equal(inv[0].value, 4);
  assert.equal(inv[0].exact, true);
  const mine = applyOps(doc, tx).doc;
  // чужая правка соседнего листа легла между моей правкой и моей отменой
  const theirs = applyOps(mine, [ops.set('card', 'layout.padding.t', 24), ops.set('card', 'name', 'Чужое имя')]).doc;
  const back = applyOps(theirs, inv);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(back.doc.nodes.card.layout.gap, 4, 'свой gap отменён');
  assert.equal(back.doc.nodes.card.layout.padding.t, 24, 'чужой padding цел');
  assert.equal(back.doc.nodes.card.name, 'Чужое имя');
  // без чужих правок отмена по-прежнему возвращает узел байт в байт
  assert.deepStrictEqual(applyOps(mine, inv).doc.nodes.card, doc.nodes.card);
  // вложенные пути в других полях — то же самое
  const t = scene(() => [ops.create(label('t', 'ab', 'Привет', { style: { token: 'body', fontSize: 15 } }))]);
  const inv2 = invertOps(t, [ops.set('t', 'style.fontSize', 30)]);
  assert.equal(inv2[0].path, 'style.fontSize');
  assert.equal(inv2[0].value, 15);
  const t2 = applyOps(applyOps(t, [ops.set('t', 'style.fontSize', 30)]).doc, [ops.set('t', 'style.fontWeight', 700)]).doc;
  const t3 = applyOps(t2, inv2).doc;
  assert.deepStrictEqual(t3.nodes.t.style, { token: 'body', fontSize: 15, fontWeight: 700 });
});

test('круг22: отмена setToken colors.accent не трогает изменённый colors.surface', () => {
  const doc = createDoc('empty');
  const tx = [ops.setToken('colors.accent', '#0000ff'), ops.setToken('type.body.fontSize', 17)];
  const inv = invertOps(doc, tx);
  assert.deepEqual(inv.map((o) => o.path), ['type.body.fontSize', 'colors.accent'], 'по пути операции, в обратном порядке');
  assert.equal(inv[1].value, '#FF6B3D');
  assert.equal(inv[0].value, 15);
  const mine = applyOps(doc, tx).doc;
  const theirs = applyOps(mine, [ops.setToken('colors.surface', '#000000'), ops.setToken('type.body.lineHeight', 26)]).doc;
  const back = applyOps(theirs, inv);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(back.doc.tokens.colors.accent, '#FF6B3D', 'свой accent отменён');
  assert.equal(back.doc.tokens.colors.surface, '#000000', 'чужой surface цел');
  assert.equal(back.doc.tokens.type.body.fontSize, 15);
  assert.equal(back.doc.tokens.type.body.lineHeight, 26, 'чужой lineHeight цел');
  assert.deepEqual(Object.keys(back.doc.tokens.colors), Object.keys(doc.tokens.colors), 'порядок свотчей не прыгает');
  // отмена снятия ключа возвращает группу целиком — иначе ключ встал бы в конец палитры
  const unset = [ops.setToken('colors.accent')];
  const inv2 = invertOps(doc, unset);
  assert.equal(inv2[0].path, 'colors');
  const back2 = applyOps(applyOps(doc, unset).doc, inv2).doc;
  assert.deepEqual(Object.keys(back2.tokens.colors), Object.keys(doc.tokens.colors));
  // …но не шире объекта, в котором ключ лежал: type.body, а не вся группа type
  const inv3 = invertOps(doc, [ops.setToken('type.body.fontSize')]);
  assert.equal(inv3[0].path, 'type.body');
  assert.deepStrictEqual(inv3[0].value, doc.tokens.type.body);
});

test('круг22: смена формы скаляр→объект (и отсутствие→объект) отменяется головой целиком', () => {
  const doc = scene(() => [
    ops.create(label('t', 'ab', 'Привет', { style: 'display' })),
    ops.create(box('b', 'ab', 10, 10, { fill: 'accent' })),
    ops.create(bare('c', 'ab', 10, 10)),
    ops.create(label('u', 'ab', 'Ещё'))
  ]);
  const cases = [
    [ops.set('t', 'style.fontSize', 12), 'style', 'display', 'строка style стала объектом'],
    [ops.set('b', 'fill.token', 'surface'), 'fill', 'accent', 'строка fill стала объектом'],
    [ops.set('b', 'fill.token', 'accent'), 'fill', 'accent', 'то же имя, но объект поверх строки по вложенному пути — тоже смена формы'],
    [ops.set('c', 'fill.token', 'surface'), 'fill', undefined, 'fill не было — снимается целиком'],
    [ops.set('c', 'layout.padding.t', 12), 'layout', undefined, 'layout не было — снимается целиком'],
    [ops.set('u', 'style.a.b', 1), 'style.a', undefined, 'глубже: снимается тот уровень, которого не было, — пустой объект не остаётся']
  ];
  for (const [op, path, value, why] of cases) {
    const inv = invertOps(doc, [op]);
    assert.equal(inv.length, 1, why);
    assert.equal(inv[0].path, path, why);
    assert.deepStrictEqual(inv[0].value, value, why);
    const after = applyOps(doc, [op]);
    assert.equal(after.error, undefined, why + ': ' + JSON.stringify(after.error));
    const back = applyOps(after.doc, inv);
    assert.equal(back.error, undefined, why + ': ' + JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes[op.id], doc.nodes[op.id], why);
  }
});

test('круг22: листовая инверсия с exact хранит форму — число поверх ссылки на равный шаг возвращает число', () => {
  const doc = scene(() => [
    ops.create(frame('r', 'ab', { mode: 'row', gap: 'spacing.6', padding: { t: 'spacing.4', r: 8, b: 'spacing.4', l: 8 } }, HUG, { radius: 'radii.2' })),
    ops.create(frame('n', 'ab', { mode: 'row', gap: 16 }, HUG))
  ]);
  const cases = [
    [ops.set('r', 'layout.gap', 24), 'layout.gap', 'spacing.6'],
    [ops.set('r', 'layout.gap', 'spacing.8'), 'layout.gap', 'spacing.6'],
    [ops.set('r', 'layout.gap', 16), 'layout.gap', 'spacing.6'],      // «то же самое»: правка пустая, отмена тоже
    [ops.set('r', 'layout.padding.t', 20), 'layout.padding.t', 'spacing.4'],
    [ops.set('r', 'layout.padding.r', 'spacing.5'), 'layout.padding.r', 8],
    [ops.set('r', 'layout.padding', 4), 'layout.padding', { t: 'spacing.4', r: 8, b: 'spacing.4', l: 8 }],
    [ops.set('r', 'radius', 12), 'radius', 'radii.2'],
    // ссылка поверх числа — настоящая правка (§6.4); отмена возвращает ЧИСЛО, хотя
    // 16 равно spacing.6 и без exact keepFieldForm оставил бы ссылку
    [ops.set('n', 'layout.gap', 'spacing.6'), 'layout.gap', 16]
  ];
  for (const [op, path, value] of cases) {
    const why = `${op.id} ${op.path} = ${JSON.stringify(op.value)}`;
    const inv = invertOps(doc, [op]);
    assert.equal(inv[0].path, path, why);
    assert.deepStrictEqual(inv[0].value, value, why);
    assert.equal(inv[0].exact, true, why);
    const after = applyOps(doc, [op]);
    assert.equal(after.error, undefined, why + ': ' + JSON.stringify(after.error));
    const back = applyOps(after.doc, inv);
    assert.equal(back.error, undefined, why + ': ' + JSON.stringify(back.error));
    assert.deepStrictEqual(back.doc.nodes[op.id], doc.nodes[op.id], why);
  }
  // отмена возвращает ссылку и тогда, когда шкалу успели укоротить — exact не проверяет живость
  const shortened = applyOps(applyOps(doc, [ops.set('r', 'layout.gap', 24)]).doc, [ops.setToken('spacing', [0, 4])]).doc;
  const back = applyOps(shortened, invertOps(doc, [ops.set('r', 'layout.gap', 24)]));
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(back.doc.nodes.r.layout.gap, 'spacing.6');
});

test('круг22: undefined по пути = «ключа не было» — инверсия снимает лист, а не пишет undefined', () => {
  const doc = scene(() => [ops.create(label('t', 'ab', 'Привет', { style: { token: 'body' } }))]);
  const tx = [ops.set('t', 'style.fontSize', 20), ops.set('t', 'opacity', 0.5)];
  const inv = invertOps(doc, tx);
  assert.deepEqual(inv.map((o) => o.path), ['opacity', 'style.fontSize']);
  assert.ok(inv.every((o) => o.value === undefined && o.exact === true));
  const after = applyOps(doc, tx).doc;
  const back = applyOps(after, inv);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.ok(!('fontSize' in back.doc.nodes.t.style), 'лист снят, а не записан как undefined');
  assert.ok(!('opacity' in back.doc.nodes.t));
  assert.deepStrictEqual(back.doc.nodes.t, doc.nodes.t);
  assert.equal(JSON.stringify(back.doc.nodes.t), JSON.stringify(doc.nodes.t), 'и через JSON байт в байт');
  // токены: новый ключ снимается, порядок остальных не меняется
  const tk = [ops.setToken('colors.fresh', '#123456'), ops.setToken('type.body.font', 'Inter')];
  const tinv = invertOps(doc, tk);
  assert.deepEqual(tinv.map((o) => o.path), ['type.body.font', 'colors.fresh']);
  const tback = applyOps(applyOps(doc, tk).doc, tinv);
  assert.equal(tback.error, undefined, JSON.stringify(tback.error));
  assert.deepStrictEqual(tback.doc.tokens, doc.tokens);
  assert.equal(JSON.stringify(tback.doc.tokens), JSON.stringify(doc.tokens));
  // снятие существующего листа отменяется объектом, в котором он лежал
  const del = [ops.set('t', 'style.token')];
  const dinv = invertOps(doc, del);
  assert.equal(dinv[0].path, 'style');
  assert.deepStrictEqual(dinv[0].value, { token: 'body' });
  const dafter = applyOps(doc, del);
  assert.equal(dafter.error, undefined, JSON.stringify(dafter.error));
  assert.deepStrictEqual(applyOps(dafter.doc, dinv).doc.nodes.t, doc.nodes.t);
});

test('круг22: applyOps, invertOps и rebase не мутируют входные операции — кроме id у create без id', () => {
  const doc = scene(() => [ops.create(box('a', 'ab', 10, 10)), ops.create(frame('f', 'ab', { mode: 'row' }, HUG))]);
  const list = deepFreeze([
    ops.set('a', 'fill', '#ff0000'), ops.set('f', 'layout.gap', 8), ops.set('f', 'layout.padding', 4),
    ops.move('a', 'f', 0), ops.create(label('t', 'f', 'x')), ops.create(frame('w', 'ab', { mode: 'none' }, HUG, { children: ['f'] })),
    ops.setToken('colors.accent', '#000000'), ops.remove('a')
  ]);
  const before = JSON.stringify(list);
  let res;
  assert.doesNotThrow(() => { res = applyOps(doc, list); });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.doesNotThrow(() => invertOps(doc, list));
  assert.doesNotThrow(() => rebase(doc, list));
  assert.equal(JSON.stringify(list), before);
  // единственная мутация — id у create без id, и только он
  const raw = { op: 'create', node: { type: 'rect', parent: 'ab', size: fixed(5, 5) } };
  const rawBefore = JSON.stringify(raw);
  const r2 = applyOps(doc, [raw]);
  assert.equal(r2.error, undefined, JSON.stringify(r2.error));
  assert.equal(typeof raw.node.id, 'string');
  assert.ok(r2.doc.nodes[raw.node.id], 'узел создан с проставленным id');
  delete raw.node.id;
  assert.equal(JSON.stringify(raw), rawBefore, 'сверх id ничего не изменилось');
});
