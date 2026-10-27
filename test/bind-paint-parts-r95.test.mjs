/**
 * Круг 95 (SPEC §15.29): привязка цветов-кодов к палитре (§15.21) — и внутри градиентов и фактур:
 * каждый стоп градиента и цвет узора и подложки фактуры. Вид прежний, прозрачность — своим полем.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { boardHexRefs, bindBoardColorsOps, staleHexRefs } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screen(extra = []) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [
    core.ops.create({ id: 'B', type: 'frame', name: 'Оплата', parent: base.root, fill: 'surface', children: [] }),
    core.ops.create({ id: 'g', type: 'frame', name: 'Градиент', parent: 'B', children: [],
      fill: { gradient: { kind: 'linear', stops: [{ at: 0, color: '#FF6B3D', opacity: 0.5 }, { at: 0.5, color: '#123456' }, { at: 1, token: 'surface' }] } } }),
    core.ops.create({ id: 'p', type: 'frame', name: 'Фактура', parent: 'B', children: [],
      fill: { pattern: { kind: 'dots', color: '#ff6b3d', bg: '#FFFFFF', size: 12, opacity: 0.4 } } }),
    core.ops.create({ id: 'pt', type: 'frame', name: 'Фактура токенами', parent: 'B', children: [],
      fill: { pattern: { kind: 'lines', color: 'accent' } } }),
    core.ops.create({ id: 'v', type: 'vector', name: 'Знак', parent: 'B', viewBox: { w: 10, h: 10 },
      paths: [{ d: 'M0 0 L10 0 L10 10 Z', fill: { gradient: { kind: 'radial', stops: [{ at: 0, color: '#E2DED6' }, { at: 1, color: '#e2ded600' }] } } }] }),
    core.ops.create({ id: 'sg', type: 'frame', name: 'Обводка градиентом', parent: 'B', children: [],
      stroke: { width: 2, color: { gradient: { kind: 'linear', stops: [{ at: 0, color: '#E2DED6' }, { at: 1, color: '#123456' }] } } } }),
    core.ops.create({ id: 'art', type: 'frame', name: 'Рисунок', parent: 'B', role: 'illustration', fill: '#FFFFFF', children: [] }),
    core.ops.create({ id: 'eye', type: 'frame', name: 'Глаз', parent: 'art', children: [],
      fill: { gradient: { kind: 'radial', stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#ff6b3d' }] } } }),
    ...extra,
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг95: стопы градиента и цвета фактуры — к токену; вне палитры, токены и прозрачный код — как были', () => {
  const doc = screen();
  const by = Object.fromEntries(boardHexRefs(doc, doc.nodes.B).refs.map((r) => [`${r.id}:${r.path}`, r.token]));
  assert.deepEqual(by, {
    'g:fill.gradient.stops.0': 'accent',
    'p:fill.pattern.color': 'accent',
    'p:fill.pattern.bg': 'surface',
    'v:paths.0.fill.gradient.stops.0': 'line',
    'sg:stroke.color.gradient.stops.0': 'line',
  });
  const r = bindBoardColorsOps(doc, doc.nodes.B);
  assert.equal(r.label, 'Экран «Оплата»: цвета 4 слоёв привязаны к палитре');
  const after = core.applyOps(doc, r.ops);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  const n = after.doc.nodes;
  assert.deepEqual(n.g.fill.gradient.stops, [{ at: 0, token: 'accent', opacity: 0.5 }, { at: 0.5, color: '#123456' }, { at: 1, token: 'surface' }]);
  assert.deepEqual(n.p.fill.pattern, { kind: 'dots', color: 'accent', bg: 'surface', size: 12, opacity: 0.4 });
  assert.deepEqual(n.pt.fill, doc.nodes.pt.fill);
  assert.deepEqual(n.sg.stroke.color.gradient.stops, [{ at: 0, token: 'line' }, { at: 1, color: '#123456' }], 'градиент в обводке');
  assert.equal(n.art.fill, '#FFFFFF', 'рисунок — цвета художника, мимо');
  assert.deepEqual(n.eye.fill, doc.nodes.eye.fill, 'и всё внутри рисунка');
  assert.deepEqual(n.v.paths[0].fill.gradient.stops[1], { at: 1, color: '#e2ded600' }, 'полупрозрачный код — как был');
  // вид прежний: краска разрешается в те же цвета
  for (const [id, key] of [['g', 'fill'], ['p', 'fill']]) {
    assert.deepEqual(core.resolvePaint(after.doc, n[id][key]), core.resolvePaint(doc, doc.nodes[id][key]), `${id}: вид прежний`);
  }
  assert.equal(bindBoardColorsOps(after.doc, after.doc.nodes.B), null, 'второй раз — нечего');
});

test('круг95: после привязки тема экрана перекрашивает и градиент, и фактуру', () => {
  const doc = screen();
  const bound = core.applyOps(doc, bindBoardColorsOps(doc, doc.nodes.B).ops).doc;
  const themed = core.applyOps(bound, [core.ops.set('B', 'theme', { colors: { accent: '#2255ff' } })]);
  assert.equal(themed.error, undefined, JSON.stringify(themed.error));
  const d = core.themeScope(themed.doc)('B');
  assert.equal(core.resolvePaint(d, themed.doc.nodes.g.fill).stops[0].color, '#2255ff');
  assert.equal(core.resolvePaint(d, themed.doc.nodes.p.fill).color, '#2255ff');
});

test('круг95: правка палитры предлагает перекрасить и стоп градиента, и узор фактуры (§15.25)', () => {
  const doc = screen();
  const next = core.applyOps(doc, [core.ops.setToken('colors.accent', '#00AA55')]);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const nextDoc = next.doc;
  const stale = staleHexRefs(doc, nextDoc);
  assert.ok(stale, 'есть что предложить');
  assert.equal(stale.layers, 2);
  assert.deepEqual(stale.tokens, ['accent']);
  assert.deepEqual(stale.ops.map((o) => o.path).sort(), ['fill.gradient.stops.0', 'fill.pattern.color']);
  const fixed = core.applyOps(nextDoc, stale.ops).doc;
  assert.equal(core.resolvePaint(fixed, fixed.nodes.g.fill).stops[0].color, '#00aa55');
  assert.equal(core.resolvePaint(fixed, fixed.nodes.p.fill).color, '#00aa55');
});
