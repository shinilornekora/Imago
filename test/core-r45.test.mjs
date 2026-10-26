import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, artboards, checkImportDoc, formatBehavior } = core;

/* Круг 45, CORE: границы, которые раньше не держал ни один тест (мутанты T03, T13),
   и свойства поведенческого корпуса отпечатка формата. */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

function base() {
  const d = createDoc('demo');
  const board = artboards(d)[0];
  return { d, board: board.id, kid: board.children[0] };
}

test('круг45: opacity — ровно [0, 1]: границы принимаются, сразу за ними — отказ (set, create, импорт)', () => {
  const { d, kid } = base();
  for (const v of [0, 0.0001, 0.5, 0.9999, 1]) {
    assert.equal(quiet(() => applyOps(d, [{ op: 'set', id: kid, path: 'opacity', value: v }])).error, undefined, `opacity ${v}`);
  }
  for (const v of [-0.0001, 1.0001, 1.5, 2, -1, '0.5', null, true, NaN, Infinity]) {
    const r = quiet(() => applyOps(d, [{ op: 'set', id: kid, path: 'opacity', value: v }]));
    assert.ok(r.error, `opacity ${String(v)} отклонена`);
    assert.equal(r.error.code, 'bad-node');
  }
  const board = artboards(d)[0].id;
  const mk = (opacity) => ({ op: 'create', node: { type: 'rect', id: 'n_o', parent: board, size: { w: { mode: 'fixed', value: 4 }, h: { mode: 'fixed', value: 4 } }, opacity } });
  assert.equal(quiet(() => applyOps(d, [mk(1)])).error, undefined);
  assert.ok(quiet(() => applyOps(d, [mk(1.01)])).error);
  const raw = clone(d);
  raw.nodes[kid].opacity = 1.01;
  assert.ok(checkImportDoc(raw), 'импорт с opacity 1.01 — отказ');
  raw.nodes[kid].opacity = 1;
  assert.equal(checkImportDoc(raw), null);
});

test('круг45: pos — обе оси обязательны и числами (set, create, override, импорт)', () => {
  const { d, kid, board } = base();
  assert.equal(quiet(() => applyOps(d, [{ op: 'set', id: board, path: 'pos', value: { x: 5, y: 6 } }])).error, undefined);
  for (const v of [{ x: 5 }, { y: 5 }, { x: 5, y: '6' }, { x: 5, y: null }, {}, [5, 6], 5, null]) {
    const r = quiet(() => applyOps(d, [{ op: 'set', id: board, path: 'pos', value: v }]));
    assert.ok(r.error, `pos ${JSON.stringify(v)} отклонён`);
  }
  // снять ось по пути — тоже нельзя оставить pos без y
  assert.ok(quiet(() => applyOps(d, [{ op: 'set', id: board, path: 'pos.y', value: undefined }])).error, 'pos без y через снятие оси');
  const mk = (pos) => ({ op: 'create', node: { type: 'rect', id: 'n_p', parent: board, pos, size: { w: { mode: 'fixed', value: 4 }, h: { mode: 'fixed', value: 4 } } } });
  assert.equal(quiet(() => applyOps(d, [mk({ x: 1, y: 2 })])).error, undefined);
  assert.ok(quiet(() => applyOps(d, [mk({ x: 1 })])).error);
  assert.ok(quiet(() => applyOps(d, [{ op: 'set', id: kid, path: 'override', value: { x: 1 } }])).error, 'override без y');
  const raw = clone(d);
  raw.nodes[board].pos = { x: 1 };
  assert.ok(checkImportDoc(raw), 'импорт pos без y — отказ');
});

test('круг45: поведенческий корпус детерминирован и не зависит от того, что уже делал процесс', async () => {
  const a = formatBehavior();
  // отдельный экземпляр модуля: сначала нагрузим его кеши (пути, раскрытие, журнал), потом прогон
  const fresh = await import('../src/core.js?r45=' + Date.now());
  const doc = fresh.createDoc('demo');
  quiet(() => {
    for (let i = 0; i < 50; i++) fresh.applyOps(doc, [{ op: 'set', id: fresh.artboards(doc)[0].id, path: 'name', value: 'x' + i }]);
    fresh.solve(doc);
    fresh.validate(doc, fresh.solve(doc));
    fresh.applyOps(doc, [{ op: 'set', id: 'nope', path: 'x', value: 1 }]);
  });
  const b = fresh.formatBehavior();
  for (const k of Object.keys(a)) assert.equal(b[k], a[k], `behavior.${k} зависит от состояния процесса`);
  assert.equal(fresh.FORMAT_SIGNATURE.hash, core.FORMAT_SIGNATURE.hash);
  const sizes = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length]));
  assert.ok(sizes.fields > 100000 && sizes.nested > 20000 && sizes.tokens > 20000 && sizes.ops > 1000, JSON.stringify(sizes));
});

/* Круг 45, проход 2 (arch-r45b Д1′): правка «сохранения формы» при set меняет отпечаток.
   Мутант — копия src/core.js с одной заменой (ядро без импортов, грузится само). */
test('круг45: мутанты keepFieldForm и ветвей отмены (exact) меняют отпечаток формата', { timeout: 60000 }, async () => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const src = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
  const mutants = {
    'строка поверх объекта заменяет объект': ["if (typeof value === 'string' && cur && typeof cur === 'object') return cur;", ''],
    'radius без keepRadiusForm': ["if (field === 'radius') return keepRadiusForm(doc, node.radius, value);", ''],
    'layout.gap без keepScaleForm': ["if (parts.length === 2 && parts[1] === 'gap') return keepScaleForm(doc, cur.gap, value, 'spacing');", ''],
    // круг 45, проход 3 (arch-r45c): массив скругления другой длины и ветви отмены (exact)
    'radius-массив без проверки длины': ['if (!Array.isArray(cur) || cur.length !== value.length) return value;', 'if (!Array.isArray(cur)) return value;'],
    'exact всё равно сохраняет форму': ['const value = !op.exact ? keepFieldForm(node, path, op.value, draft) : op.value;', 'const value = keepFieldForm(node, path, op.value, draft);'],
    'create с exact проверяет ссылки шкал': ['      if (!op.exact) {', '      if (true) {'],
    'set с exact проверяет ссылки шкал': ["if (!op.exact && (parts[0] === 'layout'", "if ((parts[0] === 'layout'"],
    'checkNode всегда строгий': ['checkNode(node, draft, !!op.exact)', 'checkNode(node, draft, false)']
  };
  const dir = mkdtempSync(join(tmpdir(), 'imago-mut-'));
  try {
    for (const [name, [from, to]] of Object.entries(mutants)) {
      assert.ok(src.split(from).length >= 2, `${name}: строка мутации есть в ядре`);
      const file = join(dir, name.replace(/\W+/g, '_') + '.mjs');
      writeFileSync(file, src.split(from).join(to));
      const m = await import(pathToFileURL(file).href);
      assert.notEqual(m.FORMAT_SIGNATURE.hash, core.FORMAT_SIGNATURE.hash, `${name}: отпечаток должен измениться`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
