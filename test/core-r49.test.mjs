/**
 * Круг 49 (SPEC §16): фактуры — заливка {pattern:{kind, color, bg?, size?, weight?, angle?, opacity?}}.
 * Плюс долги круга 48: запись прежнего движка с темой (liftOps), тема вложенного кадра не действует.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, ops, solve, validate, renderSVG, resolvePaint, resolveColor, paintCss, patternProblem, liftOps, docAt, PATTERN_KINDS } = core;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

const DOTS = { pattern: { kind: 'dots', color: 'accent', bg: 'canvas', size: 12 } };

/** Доска с прямоугольником в фактуре; theme — тема доски (по желанию). */
function boardWith(fill, theme) {
  const doc = quiet(() => createDoc());
  const r = applyOps(doc, [
    ops.create({ id: 'b', type: 'frame', name: 'Экран', parent: doc.root, pos: { x: 0, y: 0 }, size: { w: { mode: 'fixed', value: 320 }, h: { mode: 'fixed', value: 240 } },
      fill: 'canvas', layout: { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 }, align: 'stretch', justify: 'start', wrap: false },
      children: [], ...(theme ? { theme } : {}) }),
    ops.create({ id: 'r', type: 'rect', name: 'Плашка', parent: 'b', fill, size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 80 } } }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг49: форма фактуры — шесть видов, поля и пределы', () => {
  assert.deepEqual([...PATTERN_KINDS], ['dots', 'lines', 'grid', 'checks', 'waves', 'grain']);
  assert.equal(patternProblem({ kind: 'dots', color: 'accent' }, 'fill'), null);
  assert.equal(patternProblem({ kind: 'grain', color: '#000000', bg: '#ffffff', size: 40, weight: 1, angle: 45, opacity: 0.3 }, 'fill'), null);
  assert.match(patternProblem({ kind: 'stars', color: 'accent' }, 'fill'), /kind/);
  assert.match(patternProblem({ kind: 'dots' }, 'fill'), /color/);
  assert.match(patternProblem({ kind: 'dots', color: 'accent', size: 2 }, 'fill'), /size/);
  assert.match(patternProblem({ kind: 'dots', color: 'accent', angle: 400 }, 'fill'), /angle/);
  assert.match(patternProblem({ kind: 'dots', color: 'accent', spin: 1 }, 'fill'), /spin/);
});

test('круг49: фактура только в заливке — цвет текста и обводка её не берут', () => {
  const doc = boardWith(DOTS);
  const bad = applyOps(doc, [ops.create({ id: 't', type: 'text', parent: 'b', characters: 'x', style: 'body', color: DOTS })]);
  assert.ok(bad.error, 'цвет текста — не фактура');
  const stroke = applyOps(doc, [ops.set('r', 'stroke', { color: DOTS, width: 1 })]);
  assert.ok(stroke.error, 'обводка — не фактура');
});

test('круг49: краска фактуры — цвета по токенам, подложка — цвет для контраста', () => {
  const doc = boardWith(DOTS);
  const p = resolvePaint(doc, DOTS);
  assert.equal(p.type, 'pattern');
  assert.equal(p.color, doc.tokens.colors.accent.toLowerCase());
  assert.equal(resolveColor(doc, DOTS), resolveColor(doc, 'canvas'), 'фактура «видится» цветом подложки');
  assert.match(paintCss(doc, DOTS) || '', /radial-gradient|gradient/);
});

test('круг49: сцена — <pattern> в defs, узел ссылается на него, тема доски красит узор', () => {
  const theme = { colors: { accent: '#c6ff3d' } };
  const doc = boardWith(DOTS, theme);
  const svg = renderSVG(doc, 'b').svg;
  assert.match(svg, /<pattern[^>]*patternUnits="userSpaceOnUse"/);
  assert.match(svg, /fill="url\(#/);
  assert.match(svg.toLowerCase(), /#c6ff3d/, 'цвет узора — из темы доски');
  for (const kind of PATTERN_KINDS) {
    const d = boardWith({ pattern: { kind, color: 'text', size: 16, angle: 30 } });
    assert.match(renderSVG(d, 'b').svg, /<pattern/, kind);
  }
  assert.equal(validate(doc, solve(doc)).filter((i) => i.severity === 'error').length, 0);
});

test('круг48 (долг): запись прежнего движка с темой — тема снимается при чтении (liftOps)', () => {
  const list = [
    ops.set('b', 'theme', { colors: { canvas: '#000000' } }),
    ops.set('b', 'theme.colors.canvas', '#000000'),
    ops.create({ id: 'x', type: 'frame', parent: 'root', theme: { colors: {} }, children: [] }),
    ops.set('b', 'name', 'Экран'),
  ];
  const old = liftOps(list, 2);
  assert.equal(old.length, 2);
  assert.equal(old[0].node.theme, undefined);
  assert.equal(old[1].path, 'name');
  assert.equal(list[2].node.theme !== undefined, true, 'исходник не тронут');
  assert.equal(liftOps(list, 3), list, 'своя версия — как есть');
  assert.equal(liftOps(list, undefined), list);
});

test('круг48 (долг): тема вложенного кадра не действует нигде — ни в цветах, ни в сцене', () => {
  const doc0 = boardWith('surface');
  const r = applyOps(doc0, [
    ops.create({ id: 'in', type: 'frame', parent: 'b', fill: 'canvas', theme: { colors: { canvas: '#ff0000' } }, size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 40 } }, children: [] }),
  ]);
  const doc = r.doc || doc0;
  if (r.error) return;   // ядро вправе отказать вложенному кадру в теме — тогда и действовать нечему
  assert.equal(docAt(doc, 'in'), doc);
  assert.doesNotMatch(renderSVG(doc, 'b').svg.toLowerCase(), /#ff0000/);
});
