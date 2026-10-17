/**
 * Круг 37 (SPEC §12.3): векторные иллюстрации в оболочке — инспектор вектора (контуры,
 * краска с градиентом, поворот, непрозрачность), X/Y деталей свободной рамки, «Свободно» в
 * раскладке без прыжков, слова «Истории», значки слоёв, подсказки и заглушка dev.html.
 *
 * Чистые части — src/shell.js, проверяются напрямую и вместе с ядром (applyOps/invertOps/
 * solve); разметка оболочки — по исходникам. Браузерный прогон — Playwright (см. отчёт).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

/** Применить пути оболочки к узлу так же, как это сделает set ядра. */
function fold(node, list) {
  let n = node;
  for (const o of list) n = SHELL.setLocal(n, o.path, o.value);
  return n;
}

const VEC = () => ({
  id: 'v1', type: 'vector', name: 'Тело', parent: 'f1',
  size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } },
  viewBox: { w: 100, h: 100 },
  paths: [
    { d: 'M10 10 L90 10 L90 90 Z', fill: '#8BD3C7' },
    { d: 'M20 20 L40 20 L40 40 Z', fill: '#8BD3C7', name: 'Блик' },
    { d: 'M50 50 L60 50 L60 60 Z', fill: '#14161C', stroke: '#FFFFFF', strokeWidth: 2 },
  ],
});

test('r37: вектор и поворот — где они есть; свободная рамка и иллюстрация распознаются', () => {
  assert.ok(SHELL.STATE_NODE_TYPES.includes('vector'), 'состояния §11 у вектора тоже');
  assert.ok(SHELL.canHaveStates({ type: 'vector' }));
  for (const t of ['frame', 'text', 'rect', 'ellipse', 'image', 'instance', 'vector']) assert.ok(SHELL.canRotate({ type: t }), t);
  assert.equal(SHELL.canRotate({ type: 'page' }), false);
  assert.equal(SHELL.canRotate(null), false);

  // решатель: рамка без режима — свободная (DEFAULT_LAYOUT.mode = 'none')
  assert.equal(SHELL.layoutModeOf({ type: 'frame' }), 'none');
  assert.equal(SHELL.layoutModeOf({ type: 'frame', layout: { mode: 'row' } }), 'row');
  assert.equal(SHELL.isFreeFrame({ type: 'frame', layout: { mode: 'none' } }), true);
  assert.equal(SHELL.isFreeFrame({ type: 'frame', layout: { mode: 'column' } }), false);
  assert.equal(SHELL.isFreeFrame({ type: 'rect' }), false);

  const doc = {
    root: 'p', nodes: {
      p: { id: 'p', type: 'page', children: ['ab'] },
      ab: { id: 'ab', type: 'frame', parent: 'p', layout: { mode: 'column' }, children: ['f1', 'f2'] },
      f1: { id: 'f1', type: 'frame', parent: 'ab', layout: { mode: 'none' }, children: ['v1', 'e1'] },
      f2: { id: 'f2', type: 'frame', parent: 'ab', layout: { mode: 'none' }, children: ['r1'] },
      v1: VEC(), e1: { id: 'e1', type: 'ellipse', parent: 'f1' }, r1: { id: 'r1', type: 'rect', parent: 'f2' },
    },
  };
  assert.equal(SHELL.isIllustration(doc, doc.nodes.f1), true, 'свободная рамка с вектором — иллюстрация');
  assert.equal(SHELL.isIllustration(doc, doc.nodes.f2), false, 'без векторов — просто свободная рамка');
  assert.equal(SHELL.isIllustration(doc, doc.nodes.ab), false);
  assert.deepEqual(SHELL.illustrationCounts(doc, doc.nodes.f1), { parts: 4, layers: 2 }, 'деталь — контур: 3 у вектора + эллипс');
  assert.equal(SHELL.freeParentOf(doc, doc.nodes.e1).id, 'f1');
  assert.equal(SHELL.freeParentOf(doc, doc.nodes.f1), null, 'ребёнок колонки — не деталь');
  assert.equal(SHELL.freeParentOf(doc, doc.nodes.ab), null, 'доска на холсте — не деталь');
});

test('r37: краска словами, образцом и для поля цвета — сплошная, токен, градиент', () => {
  const colors = { accent: '#FF6B3D', text: '#14161C' };
  assert.equal(SHELL.paintKind(undefined), 'none');
  assert.equal(SHELL.paintKind(null), 'none');
  assert.equal(SHELL.paintKind('#fff'), 'color');
  assert.equal(SHELL.paintKind('accent'), 'token');
  assert.equal(SHELL.paintKind({ token: 'accent' }), 'token');
  assert.equal(SHELL.paintKind({ color: '#123456' }), 'color');
  assert.equal(SHELL.paintKind({ gradient: { kind: 'linear', stops: [] } }), 'gradient');

  assert.equal(SHELL.toHex6('#abc'), '#aabbcc');
  assert.equal(SHELL.toHex6('#AABBCC'), '#aabbcc');
  assert.equal(SHELL.toHex6('accent'), null);

  assert.equal(SHELL.paintHex({ token: 'accent' }, colors), '#FF6B3D');
  assert.equal(SHELL.paintHex('#f4a261', colors), '#f4a261');
  const g = SHELL.makeGradient('linear', '#FFFFFF', '#000000', 45);
  assert.deepEqual(g, { gradient: { kind: 'linear', angle: 45, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#000000' }] } });
  assert.equal(SHELL.paintHex(g, colors), '#FFFFFF', 'у градиента кружок — первый стоп');
  assert.equal(SHELL.paintCss(g, colors), 'linear-gradient(45deg, #FFFFFF 0%, #000000 100%)');
  const rg = SHELL.makeGradient('radial', '#fff', '#000');
  assert.equal(rg.gradient.angle, undefined, 'у радиального угла нет');
  assert.match(SHELL.paintCss(rg, colors), /^radial-gradient\(circle at 50% 50%, #fff 0%, #000 100%\)$/);
  // токен в стопе — цветом палитры
  assert.match(SHELL.paintCss({ gradient: { kind: 'linear', stops: [{ at: 0, token: 'accent' }, { at: 1, color: '#000' }] } }, colors), /#FF6B3D 0%/);

  const ctx = { colors, colorWord: (v) => ({ accent: 'акцент' })[v && v.token] || '' };
  assert.equal(SHELL.paintWord(undefined, ctx), 'нет');
  assert.equal(SHELL.paintWord('#f4a261', ctx), '#F4A261');
  assert.equal(SHELL.paintWord({ token: 'accent' }, ctx), 'акцент');
  assert.equal(SHELL.paintWord(g, ctx), 'градиент #FFFFFF–#000000, 45°');
  assert.equal(SHELL.paintWord(rg, ctx), 'радиальный градиент #FFF–#000');
  // угол не задан — ядро рисует 180° (сверху вниз), слова те же
  assert.equal(SHELL.paintWord({ gradient: { kind: 'linear', stops: [{ at: 0, color: '#fff' }, { at: 1, color: '#000' }] } }, ctx), 'градиент #FFF–#000, 180°');
  assert.equal(SHELL.rotateWord(-30), '−30°');
  assert.equal(SHELL.rotateWord(12.5), '12,5°');
});

test('r37: редактор градиента — из цвета, смена вида, угла и крайних цветов; средние стопы целы', () => {
  const colors = { accent: '#FF6B3D' };
  const fromColor = SHELL.gradientWith('#F4A261', {}, colors);
  assert.equal(fromColor.gradient.kind, 'linear');
  assert.equal(fromColor.gradient.stops[0].color, '#F4A261', 'начало — прежний цвет');
  assert.notEqual(fromColor.gradient.stops[1].color.toLowerCase(), '#f4a261', 'конец — темнее, переход виден сразу');
  const fromToken = SHELL.gradientWith({ token: 'accent' }, {}, colors);
  assert.equal(fromToken.gradient.stops[0].color, '#FF6B3D', 'токен — значением палитры');

  const three = { gradient: { kind: 'linear', angle: 90, stops: [{ at: 0, token: 'accent' }, { at: 0.5, color: '#888888' }, { at: 1, color: '#000000' }] } };
  const radial = SHELL.gradientWith(three, { kind: 'radial' });
  assert.equal(radial.gradient.kind, 'radial');
  assert.equal(radial.gradient.angle, undefined);
  assert.equal(radial.gradient.stops.length, 3);
  const back = SHELL.gradientWith(radial, { kind: 'linear' });
  assert.equal(back.gradient.angle, SHELL.GRADIENT_ANGLE_DEFAULT);
  const turned = SHELL.gradientWith(three, { angle: 400 });
  assert.equal(turned.gradient.angle, 360, 'угол — в пределах 0…360');
  const recolored = SHELL.gradientWith(three, { from: '#ffffff', to: '#111111' });
  assert.deepEqual(recolored.gradient.stops[0], { at: 0, color: '#ffffff' }, 'токен стопа снят, встал цвет');
  assert.deepEqual(recolored.gradient.stops[1], { at: 0.5, color: '#888888' });
  assert.deepEqual(recolored.gradient.stops[2], { at: 1, color: '#111111' });
  assert.equal(three.gradient.stops[0].token, 'accent', 'исходник не тронут');
});

test('r37: правка контуров — наименьшими set, всех разом и по одному; без пустых правок', () => {
  const v = VEC();
  // все разом: у трёх контуров два одинаковых — пишутся все три (третий другой)
  let ops = SHELL.pathsWriteOps(v, 'all', 'fill', '#F4A261');
  assert.deepEqual(ops.map((o) => o.path), ['paths.0.fill', 'paths.1.fill', 'paths.2.fill']);
  let n = fold(v, ops);
  assert.ok(Array.isArray(n.paths), 'контуры остались массивом');
  assert.equal(n.paths[2].d, v.paths[2].d, 'форма не тронута');
  assert.deepEqual(SHELL.commonPathValue(n, 'fill'), { value: '#F4A261', mixed: false });
  // то же ещё раз — ничего
  assert.deepEqual(SHELL.pathsWriteOps(n, 'all', 'fill', '#F4A261'), []);
  // один контур
  ops = SHELL.pathsWriteOps(n, 1, 'stroke', '#000000');
  assert.deepEqual(ops, [{ path: 'paths.1.stroke', value: '#000000' }]);
  // снятие — только где было
  assert.deepEqual(SHELL.pathsWriteOps(v, 'all', 'stroke', undefined), [{ path: 'paths.2.stroke', value: undefined }]);
  assert.deepEqual(SHELL.pathsWriteOps(v, 7, 'fill', '#000'), [], 'нет такого контура — нет правки');
  assert.deepEqual(SHELL.pathsWriteOps({ type: 'rect' }, 'all', 'fill', '#000'), []);
  assert.deepEqual(SHELL.commonPathValue(v, 'fill'), { value: undefined, mixed: true });
});

test('r37: краска контура на деле — своя или унаследованная от вектора', () => {
  const node = { type: 'vector', fill: '#111111', stroke: { color: '#222222', width: 3 }, paths: [{ d: 'M0 0' }, { d: 'M1 1', fill: '#333333', strokeWidth: 0 }] };
  assert.equal(SHELL.effectivePathValue(node, node.paths[0], 'fill'), '#111111');
  assert.equal(SHELL.effectivePathValue(node, node.paths[1], 'fill'), '#333333');
  assert.equal(SHELL.effectivePathValue(node, node.paths[0], 'stroke'), '#222222');
  assert.equal(SHELL.effectivePathValue(node, node.paths[0], 'strokeWidth'), 3);
  assert.equal(SHELL.effectivePathValue(node, node.paths[1], 'strokeWidth'), 0, 'ноль — свой, не умолчание');
  assert.equal(SHELL.effectivePathValue({ type: 'vector', paths: [] }, { d: 'M0 0' }, 'strokeWidth'), 1, 'умолчание ядра — 1');
  assert.deepEqual(SHELL.commonPathValue(node, 'stroke'), { value: '#222222', mixed: false });
  assert.equal(SHELL.pathLabel(1, { name: 'Блик' }), 'Блик');
  assert.equal(SHELL.pathLabel(2, {}), 'Контур 3');
});

test('r37: «История» словами — всех контуров, один контур, несколько, перерисовка', () => {
  const v = VEC();
  const ctx = { colors: {}, colorWord: () => '' };
  const all = fold(v, SHELL.pathsWriteOps(v, 'all', 'fill', '#F4A261'));
  // «до» у контуров разное — говорим только «стало»
  assert.deepEqual(SHELL.vectorEditPhrases(v, all, 'Тело', ctx), ['Заливка всех контуров в «Тело»: #F4A261']);
  const all2 = fold(all, SHELL.pathsWriteOps(all, 'all', 'fill', '#E76F51'));
  assert.deepEqual(SHELL.vectorEditPhrases(all, all2, 'Тело', ctx), ['Заливка всех контуров в «Тело»: #F4A261 → #E76F51']);
  const one = fold(v, [{ path: 'paths.0.stroke', value: '#14161C' }, { path: 'paths.0.strokeWidth', value: 2 }]);
  assert.deepEqual(SHELL.vectorEditPhrases(v, one, 'Тело', ctx), ['Контур 1 в «Тело»: обводка нет → #14161C, толщина обводки 2']);
  const named = fold(v, [{ path: 'paths.1.fill', value: '#FFFFFF' }]);
  assert.deepEqual(SHELL.vectorEditPhrases(v, named, 'Тело', ctx), ['Контур «Блик» в «Тело»: заливка #8BD3C7 → #FFFFFF'], 'контур с именем — по имени');
  const grad = fold(v, [{ path: 'paths.0.fill', value: SHELL.makeGradient('linear', '#8BD3C7', '#4A9E92', 180) }]);
  assert.deepEqual(SHELL.vectorEditPhrases(v, grad, 'Тело', ctx), ['Контур 1 в «Тело»: заливка #8BD3C7 → градиент #8BD3C7–#4A9E92, 180°']);
  const two = fold(v, [{ path: 'paths.0.fill', value: '#000000' }, { path: 'paths.1.fill', value: '#000000' }]);
  assert.deepEqual(SHELL.vectorEditPhrases(v, two, 'Тело', ctx), ['2 контура в «Тело»: заливка #8BD3C7 → #000000']);
  const redraw = { ...v, paths: v.paths.slice(0, 2) };
  assert.deepEqual(SHELL.vectorEditPhrases(v, redraw, 'Тело', ctx), ['Контуры «Тело» перерисованы: 3 → 2']);
  assert.deepEqual(SHELL.vectorEditPhrases(v, v, 'Тело', ctx), []);
  // один контур — о самом слое
  const solo = { ...v, paths: [v.paths[0]] };
  const solo2 = fold(solo, [{ path: 'paths.0.fill', value: '#3FBF8F' }, { path: 'paths.0.opacity', value: 0.5 }]);
  assert.deepEqual(SHELL.vectorEditPhrases(solo, solo2, 'Животик', ctx), ['Заливка в «Животик»: #8BD3C7 → #3FBF8F, непрозрачность 50 %']);
  assert.ok(SHELL.isVectorPath('paths.0.fill') && SHELL.isVectorPath('paths') && SHELL.isVectorPath('viewBox'));
  assert.equal(SHELL.isVectorPath('pos'), false);
});

test('r37: «Свободно» в раскладке — дети остаются на местах; обратно — X/Y сняты; отмена точная', () => {
  const doc0 = core.createDoc('empty');
  const page = doc0.root;
  const ab = { id: 'ab', type: 'frame', name: 'Доска', pos: { x: 0, y: 0 }, size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 400 } }, layout: { mode: 'column', gap: 0, padding: 0 } };
  const fr = { id: 'fr', type: 'frame', name: 'Рамка', size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 300 } }, layout: { mode: 'column', gap: 12, padding: 16, align: 'center' } };
  const a = { id: 'a', type: 'rect', name: 'А', size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 20 } } };
  const b = { id: 'b', type: 'ellipse', name: 'Б', size: { w: { mode: 'fixed', value: 30 }, h: { mode: 'fixed', value: 30 } } };
  let r = core.applyOps(doc0, [
    core.ops.create({ ...ab, parent: page }), core.ops.create({ ...fr, parent: 'ab' }),
    core.ops.create({ ...a, parent: 'fr' }), core.ops.create({ ...b, parent: 'fr' }),
  ]);
  assert.ok(!r.error, JSON.stringify(r.error));
  const doc1 = r.doc;
  const geo1 = core.solve(doc1);
  const R = core.resolveLayout(doc1, doc1.nodes.fr.layout);
  const list = SHELL.freeModeOps(doc1.nodes.fr, doc1, geo1.rects, R.padding, 'none');
  assert.deepEqual(list.map((o) => `${o.id}:${o.path}`), ['fr:layout.mode', 'a:pos', 'b:pos']);
  const opsList = list.map((o) => core.ops.set(o.id, o.path, o.value));
  const inverse = core.invertOps(doc1, opsList);
  r = core.applyOps(doc1, opsList);
  assert.ok(!r.error, JSON.stringify(r.error));
  const doc2 = r.doc;
  const geo2 = core.solve(doc2);
  for (const id of ['a', 'b']) assert.deepEqual(geo2.rects[id], geo1.rects[id], `«${id}» не сдвинулся`);
  // обратно в столбец: pos снят у всех
  const back = SHELL.freeModeOps(doc2.nodes.fr, doc2, geo2.rects, R.padding, 'column');
  assert.deepEqual(back.map((o) => `${o.id}:${o.path}:${o.value === undefined ? '-' : 'v'}`), ['fr:layout.mode:v', 'a:pos:-', 'b:pos:-']);
  // отмена первой правки — документ как был
  const undone = core.applyOps(doc2, inverse);
  assert.ok(!undone.error);
  assert.deepEqual(undone.doc.nodes.a, doc1.nodes.a);
  assert.deepEqual(undone.doc.nodes.fr, doc1.nodes.fr);
  assert.deepEqual(SHELL.freeModeOps(doc2.nodes.fr, doc2, geo2.rects, R.padding, 'none'), [], 'тот же режим — нет правки');
});

test('r37: правка контуров и поворот через ядро — применяются и отменяются точно (если ядро знает вектор)', (t) => {
  if (typeof core.parsePath !== 'function') { t.skip('ядро ещё без вектора'); return; }
  const doc0 = core.createDoc('empty');
  const page = doc0.root;
  const v = VEC();
  let r = core.applyOps(doc0, [
    core.ops.create({ id: 'ab', type: 'frame', name: 'Доска', parent: page, pos: { x: 0, y: 0 }, size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 300 } }, layout: { mode: 'none' } }),
    core.ops.create({ id: 'f1', type: 'frame', name: 'Иллюстрация', parent: 'ab', size: { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 200 } }, layout: { mode: 'none' } }),
    core.ops.create({ ...v, parent: 'f1', pos: { x: 10, y: 20 } }),
  ]);
  assert.ok(!r.error, JSON.stringify(r.error));
  const doc1 = r.doc;
  const node = doc1.nodes.v1;
  const list = [
    ...SHELL.pathsWriteOps(node, 'all', 'fill', SHELL.makeGradient('radial', '#ffffff', '#000000')),
    ...SHELL.pathsWriteOps(node, 2, 'strokeWidth', 4),
  ].map((o) => core.ops.set('v1', o.path, o.value));
  list.push(core.ops.set('v1', 'rotate', 15), core.ops.set('v1', 'opacity', 0.8), core.ops.set('v1', 'pos', { x: 30, y: 20 }));
  const inv = core.invertOps(doc1, list);
  r = core.applyOps(doc1, list);
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal(r.doc.nodes.v1.paths[1].fill.gradient.kind, 'radial');
  assert.equal(r.doc.nodes.v1.rotate, 15);
  const back = core.applyOps(r.doc, inv);
  assert.ok(!back.error);
  assert.deepEqual(back.doc.nodes.v1, doc1.nodes.v1, 'отмена — узел как был');
});

test('r37: оболочка — инспектор вектора, «Вид», X/Y, «Свободно», значки, подсказки, заглушка', () => {
  const app = read('app.js');
  // инспектор (§12.3)
  for (const s of ["group('Контуры'", "group('Вид'", "row('Поворот'", "row('Непрозр.'", "group('Положение'",
    "['Цвет', 'Градиент']", "['Линейный', 'Радиальный']", 'Выберите контур', 'Заливка всех', 'Обводка всех']) {
    assert.ok(app.includes(s), `в app.js нет ${s}`);
  }
  assert.match(app, /SHELL\.pathsWriteOps\(/, 'контуры пишутся наименьшими set');
  assert.match(app, /SHELL\.freeModeOps\(/, 'смена потока — без прыжков');
  assert.match(app, /none: 'Свободно: каждый слой стоит где поставлен/, 'у «свободно» есть подсказка');
  assert.match(app, /const MODE_LABELS = \{ column: 'столбец', row: 'строка', none: 'свободно' \}/);
  // слова «Истории»
  assert.match(app, /SHELL\.vectorEditPhrases\(/);
  assert.match(app, /opacity: 'Непрозрачность'/);
  assert.match(app, /rotate: 'Поворот'/);
  // перетаскивание: соседняя деталь щелчком, Shift — ось
  assert.match(app, /function initDetailGestures\(/);
  assert.match(app, /commit\(stageOps\(ops\)/);
  // слои: значки вектора и иллюстрации
  assert.match(app, /vector: '<path/);
  assert.match(app, /illustration: '<rect/);
  assert.match(app, /function layerIconFor\(/);
  // подсказки и пустое состояние
  assert.ok((app.match(/'нарисуй милого монстра'/g) || []).length >= 3, 'пример «нарисуй милого монстра» — в пустом документе, на пустой доске и в подсказках');
  // стили — в обеих темах через переменные, без своих цветов
  const css = read('styles.css');
  const block = css.slice(css.indexOf('круг 37 (SPEC §12.3)'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, 'цвета — переменными темы');
  // заглушка dev.html рисует
  const stub = read('tools/stub.js');
  assert.match(stub, /нарису/);
  assert.match(stub, /монстр/);
  assert.match(stub, /печень/);
});
