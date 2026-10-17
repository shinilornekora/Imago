import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const { createDoc, applyOps, invertOps, hashDoc, checkImportDoc, rebase } = core;

/* Круг 33, CORE. «Дыры формы» в путях set / setToken:
   (1) setToken type.<k>.<поле>.<x> превращал число fontSize в объект {x:16} —
       документ после этого не импортировался; теперь проверяется итоговое поле;
   (2) пустой сегмент пути (`.name`, `layout..gap`, `colors.`, `.`) заводил ключ «»,
       а инверсия выходила с пустым путём и не ложилась; теперь — bad-op;
   (3) фаззер по путям set / setToken с инвариантом «принято → checkImportDoc
       чисто → отмена возвращает hashDoc → повтор возвращает правку». */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

/** Правка легла — и документ годен, и отмена точная. */
function assertSound(doc, ops, what) {
  const r = quiet(() => applyOps(doc, clone(ops)));
  assert.equal(r.error, undefined, `${what}: ${r.error && r.error.message}`);
  assert.equal(checkImportDoc(clone(r.doc)), null, `${what}: документ импортируется`);
  const inv = clone(invertOps(doc, clone(ops)));
  const back = quiet(() => applyOps(r.doc, inv));
  assert.equal(back.error, undefined, `${what}: отмена ложится`);
  assert.equal(hashDoc(back.doc), hashDoc(doc), `${what}: отмена точная`);
  return r.doc;
}

test('круг33: setToken глубже знакомого поля стиля — отказ; незнакомое поле — простые данные', () => {
  const doc = createDoc();
  const fields = ['font', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'];
  for (const f of fields) {
    for (const [tail, value] of [['x', 16], ['x', '#123456'], ['x.y', 1], ['0', 1], ['x', null], ['x', { a: 1 }], ['x', undefined]]) {
      const path = `type.body.${f}.${tail}`;
      const op = { op: 'setToken', path };
      if (value !== undefined) op.value = value;
      const r = quiet(() => applyOps(doc, [op]));
      assert.ok(r.error, `${path} = ${JSON.stringify(value)} отклоняется`);
      assert.equal(r.error.code, 'bad-op');
      // и на сервере (rebase — тот же вход, что у секвенсора): операция отброшена
      const m = quiet(() => rebase(doc, [clone(op)], { tombstones: new Map() }));
      assert.equal(m.ops.length, 0, `${path}: сервер не применяет`);
    }
  }
  // у новой записи стиля (её ещё нет) — так же
  assert.ok(quiet(() => applyOps(doc, [{ op: 'setToken', path: 'type.fresh.fontSize.x', value: 16 }])).error);
  // прямые записи знакомых полей и незнакомые поля любой глубины — как раньше
  let d = assertSound(doc, [{ op: 'setToken', path: 'type.body.fontSize', value: 16 }], 'fontSize');
  assert.equal(d.tokens.type.body.fontSize, 16);
  d = assertSound(d, [{ op: 'setToken', path: 'type.body.meta.x.y', value: 1 }], 'незнакомое поле глубоко');
  assert.deepEqual(d.tokens.type.body.meta, { x: { y: 1 } });
  d = assertSound(d, [{ op: 'setToken', path: 'type.body.meta.x' }], 'снятие внутри незнакомого поля');
  assert.deepEqual(d.tokens.type.body.meta, {});
  assertSound(d, [{ op: 'setToken', path: 'type.body.fontSize' }], 'снятие знакомого поля');
  assertSound(doc, [{ op: 'setToken', path: 'type.fresh.fontSize', value: 12 }], 'новая запись стиля');
});

test('круг33: критик — документ после setToken type.body.fontSize.x больше не портится', () => {
  const doc = createDoc();
  const r = quiet(() => applyOps(doc, [{ op: 'setToken', path: 'type.body.fontSize.x', value: 16 }]));
  assert.ok(r.error);
  assert.match(r.error.message, /fontSize/);
  // стиль цел: число, документ импортируется
  assert.equal(doc.tokens.type.body.fontSize, 15);
  assert.equal(checkImportDoc(clone(doc)), null);
});

test('круг33: пустой сегмент пути в set и setToken — bad-op, ключа «» нет', () => {
  const doc = createDoc();
  const text = Object.values(doc.nodes).find((n) => n.type === 'text');
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && n.layout);
  const setPaths = ['.name', 'name.', '.', '..', 'props..a', 'layout..gap', 'meta.', 'x.y.', '.layout.gap', 'style..token'];
  for (const path of setPaths) {
    for (const id of [text.id, frame.id]) {
      for (const value of ['x', 1, { a: 1 }, undefined]) {
        const op = { op: 'set', id, path };
        if (value !== undefined) op.value = value;
        const r = quiet(() => applyOps(doc, [op]));
        assert.ok(r.error, `set ${JSON.stringify(path)} отклоняется`);
        assert.equal(r.error.code, 'bad-op', path);
        const m = quiet(() => rebase(doc, [clone({ ...op, exact: true })], { tombstones: new Map() }));
        assert.equal(m.ops.length, 0, `set ${JSON.stringify(path)}: сервер не применяет и exact`);
      }
    }
  }
  const tokenPaths = ['.colors', 'colors.', '..', '.x', '.', 'colors..accent', 'type..fontSize', 'type.body.', 'spacing.', 'misc..a', 'other.'];
  for (const path of tokenPaths) {
    for (const value of ['#123456', 1, { a: 1 }, [1], undefined]) {
      const op = { op: 'setToken', path };
      if (value !== undefined) op.value = value;
      const r = quiet(() => applyOps(doc, [op]));
      assert.ok(r.error, `setToken ${JSON.stringify(path)} отклоняется`);
      assert.equal(r.error.code, 'bad-op', path);
      const m = quiet(() => rebase(doc, [clone(op)], { tombstones: new Map() }));
      assert.equal(m.ops.length, 0, `setToken ${JSON.stringify(path)}: сервер не применяет`);
    }
  }
  // отказ в пачке — пачка целиком не ложится, документ прежний
  const r = quiet(() => applyOps(doc, [{ op: 'set', id: text.id, path: 'name', value: 'ok' }, { op: 'setToken', path: '.colors', value: '#000' }]));
  assert.ok(r.error);
  assert.match(r.error.message, /операция 1/);
  assert.ok(!('' in doc.tokens) && !('' in doc.nodes[text.id]));
});

/* ------------------------------------------------------------------ *
 * Фаззер путей set / setToken. Путь — либо существующий в узле/токенах путь
 * с 0..2 случайными сегментами в хвосте (так достаются «глубже знакомого поля»),
 * либо собранный из словаря (в том числе с пустыми сегментами и номерами).
 * Значения — годные и мусор; пачки по 1–3 операции; часть — с exact (так
 * выглядит инверсия). Проверяется только то, что легло.
 * ------------------------------------------------------------------ */

const SEG = ['name', 'characters', 'layout', 'mode', 'gap', 'padding', 'top', 't', 'size', 'w', 'h', 'value', 'fill', 'token', 'color', 'stroke',
  'radius', 'opacity', 'props', 'label', 'component', 'style', 'fontSize', 'font', 'fontWeight', 'lineHeight', 'letterSpacing', 'x', '0', '1', '2', '',
  'meta', 'children', 'parent', 'type', 'id', 'visible', 'of', 'align', 'clip', 'src', 'fit', 'list', 'role', 'overrides', 'shadow',
  'colors', 'spacing', 'radii', 'body', 'accent', 'caption', 'fresh', 'misc', 'k', 'a', '13', '5', 'cross', 'wrap', 'min', 'max',
  /* круг 36 (SPEC §11): состояния, движение, шкалы движения и теней */
  'states', 'hover', 'press', 'focus', 'motion', 'duration', 'easing', 'delay', 'follow', 'lift', 'scale', 'fast', 'base', 'slow', 'sm', 'md', 'lg'];
const NODE_TOP = ['name', 'characters', 'layout', 'size', 'fill', 'color', 'stroke', 'radius', 'opacity', 'props', 'component', 'style', 'meta',
  'visible', 'clip', 'src', 'fit', 'overrides', 'of', 'role', 'shadow', 'list', 'align', 'states', 'motion'];
const TOKEN_TOP = ['colors', 'type', 'spacing', 'radii', 'misc', 'other', 'motion', 'shadow'];
const VALS = [null, 0, -1, 1, 16, 1e9, NaN, '', 'x', 'auto', true, false, [], [1, 2], ['a'], {}, { x: 1 }, { a: { b: 1 } }, '#ff0000', 'fill', 'hug',
  'fixed', { mode: 'fill' }, { mode: 'fixed', value: 40 }, { token: 'spacing.2' }, { token: 'accent' }, 'accent', '$spacing.2', 4, 8, 24,
  undefined, undefined, { font: 'IBM Plex Sans', fontSize: 15, lineHeight: 20 }, [0, 4, 8], { top: 1 }, 'body', 'row', 'column', 0.5,
  [{ name: 'p', type: 'text' }],
  /* круг 36 */
  'shadow.md', 'shadow.xl', 'none', 'motion.fast', 'spacing.1', 'spring', 'parent', 1.05, 120, '0 2 6 rgba(0,0,0,0.2)',
  { hover: { lift: 2, scale: 1.02 } }, { press: { scale: 0.98 }, size: 1 }, { duration: 'motion.base', easing: 'linear' }, { fast: 90 }, { md: '0 1 2 #000' }];

function existingPaths(obj) {
  const out = [];
  const walk = (o, pre, d) => {
    if (!o || typeof o !== 'object' || d > 4) return;
    for (const k of Object.keys(o)) {
      if (k === 'children') continue;
      out.push([...pre, k]);
      walk(o[k], [...pre, k], d + 1);
    }
  };
  walk(obj, [], 0);
  return out;
}

function fuzzPaths(seed, steps) {
  const { rnd, pick } = rng(seed);
  let doc = createDoc();
  assert.equal(checkImportDoc(clone(doc)), null, 'исходный документ годен');
  const stats = { set: 0, setToken: 0, rejected: 0 };
  for (let i = 0; i < steps; i++) {
    const ids = Object.keys(doc.nodes);
    const ops = [];
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const isTok = rnd() < 0.5;
      const id = pick(ids);
      let segs;
      if (rnd() < 0.6) {
        const paths = existingPaths(isTok ? doc.tokens : doc.nodes[id]);
        segs = paths.length ? pick(paths).slice() : [pick(SEG)];
        for (let e = Math.floor(rnd() * 3); e > 0; e--) segs.push(pick(SEG));
      } else {
        segs = [rnd() < 0.85 ? pick(isTok ? TOKEN_TOP : NODE_TOP) : pick(SEG)];
        for (let e = Math.floor(rnd() * 4); e > 0; e--) segs.push(pick(SEG));
      }
      if (rnd() < 0.05) segs[rnd() < 0.5 ? 0 : segs.length] = '';
      const path = segs.join('.');
      const value = pick(VALS);
      const op = isTok ? { op: 'setToken', path } : { op: 'set', id, path };
      if (value !== undefined) op.value = value;
      if (!isTok && rnd() < 0.2) op.exact = true;
      ops.push(op);
    }
    const prev = doc;
    const wire = clone(ops);   // по сети операции идут JSON
    const r = quiet(() => applyOps(prev, wire));
    if (r.error) { stats.rejected++; continue; }
    for (const op of ops) stats[op.op]++;
    const what = `сид ${seed}, шаг ${i}: ${JSON.stringify(ops)}`;
    // инвариант: всё, что ядро приняло, — документ, который импортируется
    const imp = checkImportDoc(clone(r.doc));
    assert.equal(imp, null, `${what}\nпринятое не импортируется: ${JSON.stringify(imp)}`);
    assert.equal(hashDoc(clone(r.doc)), hashDoc(r.doc), `${what}\nдокумент не переживает JSON`);
    assert.ok(!('' in r.doc.tokens), `${what}\nключ «» в токенах`);
    const inv = clone(invertOps(prev, clone(ops)));
    const back = quiet(() => applyOps(r.doc, inv));
    assert.equal(back.error, undefined, `${what}\nотмена не ложится: ${back.error && back.error.message}\n${JSON.stringify(inv).slice(0, 1000)}`);
    assert.equal(hashDoc(back.doc), hashDoc(prev), `${what}\nотмена не точная: ${JSON.stringify(inv).slice(0, 1000)}`);
    const redo = clone(invertOps(r.doc, clone(inv)));
    const again = quiet(() => applyOps(back.doc, redo));
    assert.equal(again.error, undefined, `${what}\nповтор не ложится`);
    assert.equal(hashDoc(again.doc), hashDoc(r.doc), `${what}\nповтор не точный`);
    doc = r.doc;
  }
  return stats;
}

test('круг33: фаззер путей set/setToken — принято → импортируется, отмена и повтор точные', () => {
  const total = { set: 0, setToken: 0, rejected: 0 };
  for (const seed of [33, 333, 2033, 7]) {
    const s = fuzzPaths(seed, 1200);
    for (const k of Object.keys(total)) total[k] += s[k];
  }
  for (const [k, v] of Object.entries(total)) assert.ok(v > 300, `покрыто ${k}: ${v}`);
});

test('круг33: путь пропса компонента — те же правила, что у set: пустой сегмент не проходит', () => {
  const doc = createDoc();
  const master = Object.values(doc.nodes).find((n) => n.component && n.component.props && n.component.props.length);
  assert.ok(master, 'в демо есть мастер с пропсами');
  const p0 = master.component.props[0];
  for (const path of ['.characters', 'characters.', 'style..token']) {
    const props = [{ ...p0, path }, ...master.component.props.slice(1)];
    const r = quiet(() => applyOps(doc, [{ op: 'set', id: master.id, path: 'component.props', value: props }]));
    assert.ok(r.error, `prop path ${JSON.stringify(path)} отклоняется`);
    assert.match(r.error.message, /пустой сегмент/);
    const bad = clone(doc);
    bad.nodes[master.id].component.props = props;
    assert.ok(checkImportDoc(bad), 'и импорт такого документа');
  }
});
