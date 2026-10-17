import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, invertOps, hashDoc, checkImportDoc, rebase, solve, validate, hashGeometry,
  resolveMotion, resolveState, resolveShadow, motionScale, parseShadow, hasStates, expandInstance,
  DEFAULT_MOTION, DEFAULT_SHADOW, EASINGS, Stage, ops, isArtboard, artboards, keepFieldForm,
  makeComponentOps, instanceOps, libraryId
} = core;

/* Круг 36, CORE (SPEC §11): микроанимации — состояния (hover/press/focus),
   движение, базовые opacity/shadow; шкалы tokens.motion / tokens.shadow;
   резолверы; валидатор §11.2; решатель states не читает; сцена: просмотр и
   playState; экспорт SVG несёт состояния как CSS. */

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const M = { measureText: (t, s) => String(t).length * (s && s.fontSize ? s.fontSize : 15) * 0.55 };

function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

/** Правка легла, документ импортируется, отмена и повтор точные. */
function assertSound(doc, list, what) {
  const r = quiet(() => applyOps(doc, clone(list)));
  assert.equal(r.error, undefined, `${what}: ${r.error && r.error.message}`);
  assert.equal(checkImportDoc(clone(r.doc)), null, `${what}: документ импортируется`);
  const inv = clone(invertOps(doc, clone(list)));
  const back = quiet(() => applyOps(r.doc, inv));
  assert.equal(back.error, undefined, `${what}: отмена ложится`);
  assert.equal(hashDoc(back.doc), hashDoc(doc), `${what}: отмена точная`);
  const redo = clone(invertOps(r.doc, clone(inv)));
  const again = quiet(() => applyOps(back.doc, redo));
  assert.equal(again.error, undefined, `${what}: повтор ложится`);
  assert.equal(hashDoc(again.doc), hashDoc(r.doc), `${what}: повтор точный`);
  // сервер (rebase) принимает то же самое
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

/** Документ: доска + кнопка (фрейм с текстом) + прямоугольник, эллипс, картинка. */
function sceneDoc() {
  let doc = createDoc('empty');
  const put = (list) => { const r = applyOps(doc, list); assert.equal(r.error, undefined, r.error && r.error.message); doc = r.doc; };
  put([
    ops.create({ type: 'frame', id: 'ab', name: 'Экран', parent: doc.root, children: [], pos: { x: 0, y: 0 }, fill: 'surface',
      size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, layout: { mode: 'none' } }),
    ops.create({ type: 'frame', id: 'btn', name: 'Кнопка', parent: 'ab', children: [], fill: 'accent', radius: 'radii.2', pos: { x: 20, y: 20 },
      size: { w: { mode: 'fixed', value: 160 }, h: { mode: 'fixed', value: 48 } }, layout: { mode: 'row', padding: 'spacing.4', align: 'center', justify: 'center' } }),
    ops.create({ type: 'text', id: 'lbl', name: 'Подпись', parent: 'btn', characters: 'Оплатить', style: 'body', color: 'onAccent', size: { w: { mode: 'hug' }, h: { mode: 'hug' } } }),
    ops.create({ type: 'rect', id: 'r', name: 'Плашка', parent: 'ab', pos: { x: 20, y: 100 }, size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 40 } } }),
    ops.create({ type: 'ellipse', id: 'e', name: 'Точка', parent: 'ab', pos: { x: 100, y: 100 }, fill: 'line', size: { w: { mode: 'fixed', value: 20 }, h: { mode: 'fixed', value: 20 } } }),
    ops.create({ type: 'image', id: 'img', name: 'Фото', parent: 'ab', pos: { x: 200, y: 100 }, size: { w: { mode: 'fixed', value: 60 }, h: { mode: 'fixed', value: 60 } } })
  ]);
  return doc;
}

/* ----------------------------- схема ----------------------------- */

test('круг36: состояния, движение, opacity, shadow — годные значения ложатся у всех видов узлов, отмена и повтор точные', () => {
  let doc = sceneDoc();
  for (const id of ['btn', 'lbl', 'r', 'e', 'img']) {
    doc = assertSound(doc, [{ op: 'set', id, path: 'states', value: { hover: { opacity: 0.9, scale: 1.02, lift: 'spacing.1', shadow: 'shadow.md' } } }], `states у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.press.scale', value: 0.98 }], `states.press.scale у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.focus', value: { stroke: { color: 'accentInk', width: 2 } } }], `states.focus у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.hover.fill', value: 'accentSoft' }], `states.hover.fill у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.hover.color', value: { token: 'text' } }], `states.hover.color у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.hover.lift', value: -3 }], `lift числом у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'motion', value: { duration: 'motion.fast', easing: 'spring', delay: 40, follow: 'self' } }], `motion у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'motion.duration', value: 250 }], `motion.duration у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'motion.easing', value: 'emphasized' }], `motion.easing у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'opacity', value: 0.5 }], `opacity у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'shadow', value: 'shadow.lg' }], `shadow у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'shadow', value: 'none' }], `shadow none у ${id}`);
    // снятие — путями всех уровней
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.hover.lift' }], `снять lift у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'states.press' }], `снять press у ${id}`);
    doc = assertSound(doc, [{ op: 'set', id, path: 'motion.delay' }], `снять delay у ${id}`);
  }
  // экземпляр — тоже
  let d = createDoc();
  const inst = Object.values(d.nodes).find((n) => n.type === 'instance');
  assert.ok(inst, 'в демо есть экземпляр');
  d = assertSound(d, [{ op: 'set', id: inst.id, path: 'states.hover.lift', value: 'spacing.1' }], 'states у экземпляра');
  assertSound(d, [{ op: 'set', id: inst.id, path: 'motion.duration', value: 'motion.slow' }], 'motion у экземпляра');
  // create с полями сразу
  assertSound(sceneDoc(), [ops.create({ type: 'rect', id: 'new', parent: 'ab', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } },
    shadow: 'shadow.sm', opacity: 0.4, states: { hover: { fill: '#ff0000' }, press: { scale: 0.9 } }, motion: { duration: 0, easing: 'linear' } })], 'create со states');
});

test('круг36: негодные состояния, движение и тень — bad-node; у страницы состояний нет', () => {
  const doc = sceneDoc();
  const bad = [
    ['states', 1], ['states', []], ['states', { active: {} }], ['states', { hover: 1 }], ['states', { hover: [] }],
    ['states.hover', 'accent'], ['states.hover.width', 3], ['states.hover.size', { w: { mode: 'fill' } }], ['states.hover.layout', {}],
    ['states.hover.pos', { x: 1, y: 1 }], ['states.hover.scale', 2], ['states.hover.scale', 0.5], ['states.hover.scale', '1'],
    ['states.hover.lift', 30], ['states.hover.lift', -25], ['states.hover.lift', 'radii.1'], ['states.hover.lift', 'spacing'], ['states.hover.lift', { a: 1 }],
    ['states.hover.opacity', 2], ['states.hover.opacity', -0.1], ['states.hover.opacity', 'x'],
    ['states.hover.fill', 5], ['states.hover.fill', { token: 5 }], ['states.hover.stroke', { width: 'x' }], ['states.hover.color', []],
    ['states.hover.shadow', 'shadow.xl'], ['states.hover.shadow', '0 1 2 #000'], ['states.hover.shadow', 1],
    ['motion', 1], ['motion', { speed: 1 }], ['motion.duration', 3000], ['motion.duration', -1], ['motion.duration', 'motion.turbo'], ['motion.duration', 'fast'],
    ['motion.easing', 'ease-in'], ['motion.easing', 'toString'], ['motion.delay', 2000], ['motion.delay', '10'], ['motion.follow', 'child'], ['motion.follow', true],
    ['shadow', 'shadow.xl'], ['shadow', 'md'], ['shadow', { ref: 'shadow.md' }], ['shadow', 0], ['shadow', '0 4 12 rgba(0,0,0,.2)'],
    ['opacity', 1.5]
  ];
  for (const [path, value] of bad) {
    for (const id of ['btn', 'lbl']) rejected(doc, [{ op: 'set', id, path, value }], `set ${id} ${path}=${JSON.stringify(value)}`);
  }
  rejected(doc, [{ op: 'set', id: 'btn', path: 'states.hover.fill.toString', value: 1 }], 'ключ прототипа', 'protected-path');
  // мёртвый шаг шкалы в подъёме — как §6: операцией не проходит
  rejected(doc, [{ op: 'set', id: 'btn', path: 'states.hover.lift', value: 'spacing.99' }], 'lift spacing.99');
  rejected(doc, [{ op: 'set', id: 'btn', path: 'states', value: { hover: { lift: 'spacing.40' } } }], 'states с мёртвым lift');
  rejected(doc, [ops.create({ type: 'rect', id: 'x', parent: 'ab', states: { hover: { lift: 'spacing.40' } } })], 'create с мёртвым lift');
  // у страницы — ни set, ни create
  rejected(doc, [{ op: 'set', id: doc.root, path: 'states', value: {} }], 'states у корня');
  rejected(doc, [{ op: 'set', id: doc.root, path: 'states.hover.opacity', value: 0.5 }], 'states.hover у корня');
  const lib = libraryId(doc);
  rejected(doc, [{ op: 'set', id: lib, path: 'states', value: { hover: {} } }], 'states у библиотеки');
  // движение и тень у страницы — не запрещены схемой (не рисуются), states — запрещены
  assertSound(doc, [{ op: 'set', id: doc.root, path: 'shadow', value: 'none' }], 'shadow у страницы');
  // exact (инверсия) негодное тоже не пишет
  rejected(doc, [{ op: 'set', id: 'btn', path: 'states.hover.scale', value: 9, exact: true }], 'exact scale 9');
});

test('круг36: setToken motion.* / shadow.* — форма шага, отмена и повтор точные', () => {
  let doc = sceneDoc();
  assert.deepEqual(doc.tokens.motion, DEFAULT_MOTION, 'пустой документ несёт шкалу движения');
  assert.deepEqual(doc.tokens.shadow, DEFAULT_SHADOW, 'и шкалу теней');
  const demo = createDoc();
  assert.deepEqual(demo.tokens.motion, DEFAULT_MOTION, 'демо тоже');
  assert.deepEqual(demo.tokens.shadow, DEFAULT_SHADOW);
  doc = assertSound(doc, [{ op: 'setToken', path: 'motion.fast', value: 100 }], 'motion.fast');
  doc = assertSound(doc, [{ op: 'setToken', path: 'shadow.md', value: '0 2px 8px rgba(0, 0, 0, 0.2)' }], 'shadow.md');
  doc = assertSound(doc, [{ op: 'setToken', path: 'shadow.sm', value: 'none' }], 'shadow.sm none');
  doc = assertSound(doc, [{ op: 'setToken', path: 'shadow.lg', value: '1 1 1 #000' }], 'shadow.lg hex');
  doc = assertSound(doc, [{ op: 'setToken', path: 'motion', value: { fast: 90, base: 180, slow: 300 } }], 'motion целиком');
  doc = assertSound(doc, [{ op: 'setToken', path: 'motion.slow' }], 'снять шаг');
  doc = assertSound(doc, [{ op: 'setToken', path: 'shadow' }], 'снять группу');
  doc = assertSound(doc, [{ op: 'setToken', path: 'shadow.md', value: '0 1 1 #fff' }], 'шаг в отсутствующую группу');
  assert.deepEqual(doc.tokens.shadow, { md: '0 1 1 #fff' });
  const bad = [
    ['motion.fast', -1], ['motion.fast', 2001], ['motion.fast', '120'], ['motion.fast', null], ['motion.turbo', 100], ['motion.fast.x', 1],
    ['motion', { fast: 'x' }], ['motion', { turbo: 1 }], ['motion', 5], ['motion', []],
    ['shadow.md', 'x'], ['shadow.md', '0 1 2'], ['shadow.md', '0 1 2 red'], ['shadow.md', '0 1 -2 #000'], ['shadow.md', '0 1 2 #00'],
    ['shadow.md', '999 1 2 #000'], ['shadow.md', 4], ['shadow.xl', '0 1 2 #000'], ['shadow', { sm: 1 }], ['shadow.md.x', '0 1 2 #000'],
    ['shadow.md', '0 1 2 rgba(0,0,0)x'], ['shadow.md', 'a'.repeat(200)]
  ];
  for (const [path, value] of bad) rejected(doc, [{ op: 'setToken', path, value }], `setToken ${path}=${JSON.stringify(value)}`, 'bad-op');
  // разбор описаний
  assert.deepEqual(parseShadow('0 4px 12 rgba(20, 22, 28, 0.14)'), { dx: 0, dy: 4, blur: 12, color: 'rgba(20, 22, 28, 0.14)' });
  assert.equal(parseShadow('none'), 'none');
  assert.equal(parseShadow('0 4 12'), null);
});

test('круг36: импорт — states у страницы и негодные поля — bad-doc; createDoc чинит по полям', () => {
  const doc = sceneDoc();
  const pageStates = clone(doc);
  pageStates.nodes[doc.root].states = { hover: { opacity: 0.5 } };
  const imp = checkImportDoc(pageStates);
  assert.ok(imp && imp.code === 'bad-doc', 'states у страницы — отказ импорта');
  assert.match(imp.message, /страниц/);
  const opened = quiet(() => createDoc(pageStates));
  assert.equal(opened.nodes[doc.root].states, undefined, 'createDoc снимает states со страницы');
  assert.equal(checkImportDoc(clone(opened)), null);

  const messy = clone(doc);
  messy.nodes.btn.states = { hover: { lift: 2, width: 9, scale: 7 }, active: { opacity: 1 }, press: 'x', focus: { fill: 'accent' } };
  messy.nodes.btn.motion = { duration: 'motion.fast', speed: 3, easing: 'bouncy' };
  messy.nodes.lbl.shadow = 'shadow.xxl';
  messy.tokens.motion = { fast: 'быстро', base: 210, turbo: 5 };
  messy.tokens.shadow = 7;
  assert.ok(checkImportDoc(clone(messy)), 'мусор — отказ импорта');
  const fixed = quiet(() => createDoc(messy));
  assert.deepEqual(fixed.nodes.btn.states, { hover: { lift: 2 }, focus: { fill: 'accent' } }, 'годное в states осталось');
  assert.deepEqual(fixed.nodes.btn.motion, { duration: 'motion.fast' }, 'годное в motion осталось');
  assert.equal(fixed.nodes.lbl.shadow, undefined, 'негодная тень снята');
  assert.deepEqual(fixed.tokens.motion, { base: 210 }, 'негодные шаги снята');
  assert.equal(fixed.tokens.shadow, undefined, 'негодная группа снята');
  assert.equal(checkImportDoc(clone(fixed)), null, 'после починки — импортируется');

  // документ прежней версии без tokens.motion/shadow — работает на умолчаниях, миграции нет
  const legacy = clone(doc);
  delete legacy.tokens.motion;
  delete legacy.tokens.shadow;
  legacy.nodes.btn.motion = { duration: 'motion.slow' };
  legacy.nodes.btn.shadow = 'shadow.md';
  const ld = createDoc(legacy);
  assert.equal(ld.tokens.motion, undefined, 'createDoc шкалу не дописывает');
  assert.equal(checkImportDoc(clone(ld)), null);
  assert.equal(resolveMotion(ld, ld.nodes.btn).durationMs, DEFAULT_MOTION.slow);
  assert.equal(resolveShadow(ld, 'shadow.md').filter, 'drop-shadow(0px 4px 12px rgba(20,22,28,0.14))');
  assert.equal(validate(ld, solve(ld, M)).filter((v) => v.code === 'dead-motion-ref').length, 0, 'без шкалы ссылки не мёртвые');
});

test('круг36: keepFieldForm — подъём числом, равным шагу текущей ссылки, оставляет ссылку (§6.4)', () => {
  let doc = sceneDoc();
  doc = applyOps(doc, [{ op: 'set', id: 'btn', path: 'states', value: { hover: { lift: 'spacing.1', fill: 'accentSoft' } } }]).doc;
  const node = doc.nodes.btn;
  assert.equal(keepFieldForm(node, 'states.hover.lift', 2, doc), 'spacing.1');
  assert.equal(keepFieldForm(node, 'states.hover.lift', 3, doc), 3);
  assert.deepEqual(keepFieldForm(node, 'states.hover', { lift: 2, fill: 'accent' }, doc), { lift: 'spacing.1', fill: 'accent' });
  assert.deepEqual(keepFieldForm(node, 'states', { hover: { lift: 2 } }, doc), { hover: { lift: 'spacing.1' } });
  const same = applyOps(doc, [{ op: 'set', id: 'btn', path: 'states.hover.lift', value: 2 }]).doc;
  assert.equal(hashDoc(same), hashDoc(doc), 'правка тем же значением — документ байт в байт');
  // инверсия пишет как было (exact), не через правило формы
  const num = applyOps(doc, [{ op: 'set', id: 'btn', path: 'states.hover.lift', value: 2, exact: true }]).doc;
  assert.equal(num.nodes.btn.states.hover.lift, 2);
});

/* ----------------------------- резолверы ----------------------------- */

test('круг36: resolveMotion — умолчания, ссылки, числа, мёртвые шаги, кривые', () => {
  const doc = sceneDoc();
  const n = (motion) => ({ id: 'x', type: 'rect', motion });
  assert.deepEqual(resolveMotion(doc, n(undefined)), { durationMs: 200, easing: EASINGS.standard, easingName: 'standard', delayMs: 0, follow: 'self' });
  assert.equal(resolveMotion(doc, n({ duration: 'motion.fast' })).durationMs, 120);
  assert.equal(resolveMotion(doc, n({ duration: 'motion.slow' })).durationMs, 320);
  assert.equal(resolveMotion(doc, n({ duration: 450 })).durationMs, 450);
  assert.equal(resolveMotion(doc, n({ easing: 'spring' })).easing, 'cubic-bezier(0.34, 1.56, 0.64, 1)');
  for (const k of Object.keys(EASINGS)) assert.match(resolveMotion(doc, n({ easing: k })).easing, /^cubic-bezier\(-?[\d.]+, -?[\d.]+, -?[\d.]+, -?[\d.]+\)$/);
  assert.equal(resolveMotion(doc, n({ delay: 80, follow: 'parent' })).delayMs, 80);
  assert.equal(resolveMotion(doc, n({ follow: 'parent' })).follow, 'parent');
  // шкала документа
  const fast = applyOps(doc, [{ op: 'setToken', path: 'motion.fast', value: 90 }]).doc;
  assert.equal(resolveMotion(fast, n({ duration: 'motion.fast' })).durationMs, 90);
  assert.deepEqual(motionScale(fast), { fast: 90, base: 200, slow: 320 });
  // мёртвый шаг — умолчание ядра
  const dead = applyOps(doc, [{ op: 'setToken', path: 'motion.fast' }]).doc;
  assert.equal(resolveMotion(dead, n({ duration: 'motion.fast' })).durationMs, DEFAULT_MOTION.fast);
  // базовая длительность без motion — шаг base документа
  const slowBase = applyOps(doc, [{ op: 'setToken', path: 'motion.base', value: 260 }]).doc;
  assert.equal(resolveMotion(slowBase, n(undefined)).durationMs, 260);
  // мусор не бросает
  for (const junk of [null, 1, 'x', { duration: {}, easing: 5, delay: 'a' }]) assert.equal(typeof resolveMotion(doc, n(junk)).durationMs, 'number');
});

test('круг36: resolveState — цвета через палитру, подъём через шкалу, тень — CSS-фильтр, порядок наложения', () => {
  let doc = sceneDoc();
  doc = applyOps(doc, [
    { op: 'set', id: 'btn', path: 'states', value: {
      hover: { fill: 'accentSoft', lift: 'spacing.2', shadow: 'shadow.md', scale: 1.02 },
      press: { scale: 0.98, fill: '#123' },
      focus: { stroke: { color: 'accentInk', width: 2 } }
    } },
    { op: 'set', id: 'lbl', path: 'states', value: { hover: { color: 'accentInk', opacity: 0.8 } } },
    { op: 'set', id: 'btn', path: 'shadow', value: 'shadow.sm' }
  ]).doc;
  const btn = doc.nodes.btn;
  const base = resolveState(doc, btn, null);
  assert.equal(base.fill, '#ff6b3d');
  assert.equal(base.transform, 'none');
  assert.equal(base.filter, 'drop-shadow(0px 1px 2px rgba(20,22,28,0.12))', 'базовая тень');
  assert.deepEqual(base.changed, []);
  const h = resolveState(doc, btn, 'hover');
  assert.equal(h.fill, '#ffe7de');
  assert.equal(h.lift, 4, 'spacing.2 = 4');
  assert.equal(h.transform, 'translate(0px, -4px) scale(1.02)');
  assert.equal(h.filter, 'drop-shadow(0px 4px 12px rgba(20,22,28,0.14))');
  assert.deepEqual(h.changed.sort(), ['fill', 'lift', 'scale', 'shadow']);
  // нажатие поверх наведения: scale и fill от press, подъём и тень от hover
  const hp = resolveState(doc, btn, ['press', 'hover']);
  assert.deepEqual(hp.states, ['hover', 'press']);
  assert.equal(hp.fill, '#112233');
  assert.equal(hp.scale, 0.98);
  assert.equal(hp.lift, 4);
  const f = resolveState(doc, btn, 'focus');
  assert.equal(f.stroke, '#b03a12');
  assert.equal(f.strokeWidth, 2);
  const t = resolveState(doc, doc.nodes.lbl, 'hover');
  assert.equal(t.color, '#b03a12');
  assert.equal(t.opacity, 0.8);
  // смена шкалы переносит подъём (ссылка, не число) и тень
  const moved = applyOps(doc, [{ op: 'setToken', path: 'spacing.2', value: 6 }, { op: 'setToken', path: 'shadow.md', value: '0 2 4 #000000' }]).doc;
  assert.equal(resolveState(moved, moved.nodes.btn, 'hover').lift, 6);
  assert.equal(resolveState(moved, moved.nodes.btn, 'hover').filter, 'drop-shadow(0px 2px 4px #000000)');
  // состояние, которого нет, — база
  assert.deepEqual(resolveState(doc, doc.nodes.lbl, 'press').changed, []);
  // мусор не бросает
  for (const junk of [null, {}, { type: 'text', states: 5 }, { states: { hover: { fill: { toString: 1 } } } }]) {
    assert.equal(typeof resolveState(doc, junk, 'hover').transform, 'string');
  }
});

test('круг36: решатель states не читает — геометрия та же, states не трогаются', () => {
  const doc = createDoc();
  const geo0 = hashGeometry(solve(doc, M));
  const list = [];
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (n.type === 'page') continue;
    list.push({ op: 'set', id, path: 'states', value: { hover: { scale: 1.2, lift: 24, opacity: 0.1 }, press: { scale: 0.8 } } });
    list.push({ op: 'set', id, path: 'motion', value: { duration: 'motion.slow', follow: 'parent' } });
    list.push({ op: 'set', id, path: 'shadow', value: 'shadow.lg' });
  }
  const r = applyOps(doc, list);
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(hashGeometry(solve(r.doc, M)), geo0, 'геометрия от состояний не зависит');
  assert.equal(checkImportDoc(clone(r.doc)), null);
  // поле, которое бросает при чтении, — решатель (вне мастеров) его не касается
  const plain = sceneDoc();
  const probe = clone(plain);
  let reads = 0;
  for (const id of ['btn', 'lbl', 'r']) {
    Object.defineProperty(probe.nodes[id], 'states', { enumerable: true, get() { reads++; return { hover: { scale: 1.1 } }; } });
  }
  const g1 = solve(probe, M);
  assert.equal(reads, 0, 'solve не читает states');
  assert.equal(hashGeometry(g1), hashGeometry(solve(plain, M)));
});

test('круг36: экземпляр — states/motion мастера раскрываются, свои states экземпляра — поверх', () => {
  let doc = createDoc();
  const inst = Object.values(doc.nodes).find((n) => n.type === 'instance');
  const master = doc.nodes[inst.of];
  doc = applyOps(doc, [
    { op: 'set', id: master.id, path: 'states', value: { hover: { lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.98 } } },
    { op: 'set', id: master.id, path: 'motion', value: { duration: 'motion.fast', easing: 'spring' } },
    { op: 'set', id: master.id, path: 'shadow', value: 'shadow.sm' }
  ]).doc;
  let root = expandInstance(doc, inst.id).root;
  assert.deepEqual(root.states, { hover: { lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.98 } }, 'states мастера раскрыты');
  assert.deepEqual(root.motion, { duration: 'motion.fast', easing: 'spring' });
  assert.equal(root.shadow, 'shadow.sm');
  doc = applyOps(doc, [
    { op: 'set', id: inst.id, path: 'states', value: { hover: { lift: 'spacing.2', fill: 'accentSoft' }, focus: { stroke: 'accent' } } },
    { op: 'set', id: inst.id, path: 'motion', value: { duration: 'motion.slow' } },
    { op: 'set', id: inst.id, path: 'shadow', value: 'none' }
  ]).doc;
  root = expandInstance(doc, inst.id).root;
  assert.deepEqual(root.states, {
    hover: { lift: 'spacing.2', shadow: 'shadow.md', fill: 'accentSoft' }, focus: { stroke: 'accent' }, press: { scale: 0.98 }
  }, 'поля экземпляра поверх мастера, по каждому состоянию');
  assert.deepEqual(root.motion, { duration: 'motion.slow', easing: 'spring' });
  assert.equal(root.shadow, 'none');
  assert.equal(resolveState(doc, root, 'hover').lift, 4);
  // solve отдаёт то же раскрытие сцене
  const geo = solve(doc, M);
  assert.deepEqual(geo.expanded[inst.id].states, root.states);
  // геометрия экземпляра не изменилась
  assert.equal(hashGeometry(geo), hashGeometry(solve(createDoc(clone(doc)), M)));
});

/* ----------------------------- валидатор ----------------------------- */

test('круг36: валидатор §11.2 — коды и уровни', () => {
  let doc = sceneDoc();
  doc = applyOps(doc, [
    { op: 'set', id: 'btn', path: 'states', value: { hover: { fill: 'accent' }, press: { scale: 0.98 } } },   // hover = база → no-effect
    { op: 'set', id: 'btn', path: 'motion', value: { duration: 900 } },                                        // motion-slow + off-scale
    { op: 'set', id: 'lbl', path: 'states', value: { press: { opacity: 0.6 } } },                              // press-without-hover
    { op: 'set', id: 'r', path: 'states', value: { hover: { shadow: 'shadow.md', lift: 3 } } },               // off-scale подъёма
    { op: 'set', id: 'e', path: 'motion', value: { duration: 'motion.base' } },
    { op: 'set', id: 'img', path: 'states', value: { hover: { lift: 'spacing.12' } } }
  ]).doc;
  // мёртвые ссылки: шаг шкалы теней и движения снят, шкала отступов укорочена
  doc = applyOps(doc, [
    { op: 'setToken', path: 'shadow.md' }, { op: 'setToken', path: 'motion.base' }, { op: 'setToken', path: 'spacing', value: [0, 2, 4] }
  ]).doc;
  const raw = clone(doc);
  raw.nodes[doc.root].states = { hover: { opacity: 0.5 } };
  const v = validate(raw, solve(raw, M));
  const got = (code, id) => v.filter((x) => x.code === code && x.nodeId === id);
  const one = (code, id, sev) => {
    const list = got(code, id);
    assert.equal(list.length, 1, `${code} у ${id}: ${JSON.stringify(v.filter((x) => x.nodeId === id))}`);
    assert.equal(list[0].severity, sev, `${code}: уровень`);
    return list[0];
  };
  one('state-no-effect', 'btn', 'info');
  one('motion-slow', 'btn', 'warn');
  assert.match(one('off-scale', 'btn', 'info').message, /900/);
  one('press-without-hover', 'lbl', 'info');
  assert.equal(got('press-without-hover', 'btn').length, 0, 'у кнопки есть наведение');
  assert.match(one('dead-motion-ref', 'r', 'warn').message, /shadow\.md/);
  assert.match(one('off-scale', 'r', 'info').message, /подъём 3/);
  assert.match(one('dead-motion-ref', 'e', 'warn').message, /motion\.base/);
  assert.match(one('dead-motion-ref', 'img', 'warn').message, /spacing\.12/);
  assert.equal(got('dead-scale-ref', 'img').length, 0, 'подъём — не dead-scale-ref');
  one('state-on-page', doc.root, 'error');
  // нет states — нет и замечаний
  const clean = validate(sceneDoc(), solve(sceneDoc(), M)).filter((x) => /state|motion/.test(x.code));
  assert.deepEqual(clean, []);
  // база шкалы движения длиннее предела — медленны все анимированные узлы без своей длительности
  let slow = applyOps(sceneDoc(), [{ op: 'setToken', path: 'motion.base', value: 800 }, { op: 'set', id: 'r', path: 'states.hover.opacity', value: 0.5 }]).doc;
  assert.equal(validate(slow, solve(slow, M)).filter((x) => x.code === 'motion-slow').map((x) => x.nodeId).join(), 'r');
  // ровно 600 — не медленно
  slow = applyOps(sceneDoc(), [{ op: 'set', id: 'r', path: 'motion.duration', value: 600 }]).doc;
  assert.equal(validate(slow, solve(slow, M)).filter((x) => x.code === 'motion-slow').length, 0);
});

/* ----------------------------- фаззер ----------------------------- */

const PATHS = ['states', 'states.hover', 'states.press', 'states.focus', 'states.active', 'states.hover.fill', 'states.hover.color', 'states.hover.stroke',
  'states.hover.stroke.width', 'states.hover.stroke.color', 'states.hover.opacity', 'states.hover.scale', 'states.hover.lift', 'states.hover.shadow',
  'states.press.scale', 'states.focus.fill.token', 'states.hover.size', 'states.hover.lift.x', 'states.0', 'motion', 'motion.duration', 'motion.easing',
  'motion.delay', 'motion.follow', 'motion.speed', 'motion.duration.x', 'shadow', 'shadow.x', 'opacity', 'states.hover.fill.color'];
const TOKEN_PATHS = ['motion', 'motion.fast', 'motion.base', 'motion.slow', 'motion.turbo', 'motion.fast.x', 'shadow', 'shadow.sm', 'shadow.md', 'shadow.lg',
  'shadow.xl', 'shadow.md.0', 'spacing.1', 'spacing'];
const VALUES = [undefined, undefined, null, 0, 1, 0.5, 0.9, 1.05, 0.8, 1.2, 2, -3, 24, 25, 120, 600, 900, 3000, 'accent', 'accentSoft', '#ff0000', 'x', '',
  'spacing.1', 'spacing.4', 'spacing.99', 'radii.1', 'motion.fast', 'motion.base', 'motion.turbo', 'shadow.sm', 'shadow.md', 'shadow.xl', 'none',
  'standard', 'spring', 'ease', 'self', 'parent', '0 2 6 rgba(0,0,0,0.2)', '0 2 6', '1 1 1 #000', true, [], [1], {}, { token: 'accent' },
  { color: 'line', width: 2 }, { width: 'x' }, { fill: 'accent' }, { lift: 'spacing.2', scale: 1.02 }, { hover: { opacity: 0.8 } },
  { hover: { lift: 2 }, press: { scale: 0.98 } }, { duration: 'motion.fast', easing: 'spring' }, { fast: 100 }, { md: '0 1 2 #000' },
  { duration: 50, delay: 2000 }, { toString: 1 }, { hover: { width: 2 } }, [0, 2, 4], [0, 1]];

/** Годные значения по пути — чтобы фаззер не тонул в отказах. */
const GOOD = {
  states: [undefined, {}, { hover: { opacity: 0.8 } }, { hover: { lift: 2 }, press: { scale: 0.98 } }, { focus: { stroke: 'accent' } }],
  'states.hover': [undefined, {}, { fill: 'accent' }, { lift: 'spacing.2', scale: 1.02 }],
  'states.press': [undefined, { scale: 0.96 }],
  'states.focus': [undefined, { stroke: { color: 'line', width: 2 } }],
  'states.hover.fill': [undefined, 'accent', '#ff0000', null, { token: 'accent' }],
  'states.hover.lift': [undefined, 2, -3, 'spacing.1', 'spacing.4'],
  'states.hover.scale': [undefined, 0.8, 1.05, 1.2],
  'states.hover.shadow': [undefined, 'none', 'shadow.sm', 'shadow.lg'],
  'states.press.scale': [undefined, 0.9],
  motion: [undefined, {}, { duration: 'motion.fast', easing: 'spring' }, { follow: 'parent' }, { duration: 50, delay: 10 }],
  'motion.duration': [undefined, 0, 600, 900, 'motion.base', 'motion.slow'],
  'motion.easing': [undefined, 'linear', 'decelerate'],
  'motion.delay': [undefined, 0, 1000],
  'motion.follow': [undefined, 'self', 'parent'],
  shadow: [undefined, 'none', 'shadow.md'],
  opacity: [undefined, 0, 1, 0.3],
  'tok:motion': [undefined, {}, { fast: 100 }, { fast: 90, base: 180, slow: 300 }],
  'tok:shadow': [undefined, {}, { md: '0 1 2 #000' }, { sm: 'none', lg: '0 9 9 rgba(1,2,3,0.5)' }],
  'tok:motion.fast': [undefined, 0, 90, 2000],
  'tok:motion.base': [undefined, 210],
  'tok:motion.slow': [undefined, 400],
  'tok:shadow.sm': [undefined, 'none', '0 1 1 #000'],
  'tok:shadow.md': [undefined, '0 2px 6px rgba(0, 0, 0, 0.2)'],
  'tok:shadow.lg': [undefined, '-1 -1 0 #abcdef80'],
  'tok:spacing.1': [3, 2],
  'tok:spacing': [[0, 2, 4, 6, 8], [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64]]
};

test('круг36: фаззер новых путей — принято → импортируется, отмена и повтор точные, геометрия от состояний не зависит', () => {
  const stats = { set: 0, setToken: 0, create: 0, rejected: 0 };
  for (const seed of [36, 3636, 1036]) {
    const { rnd, pick } = rng(seed);
    let doc = createDoc();
    const ids = () => Object.keys(doc.nodes);
    for (let i = 0; i < 900; i++) {
      const list = [];
      for (let k = 1 + Math.floor(rnd() * 2); k > 0; k--) {
        const roll = rnd();
        let op;
        if (roll < 0.6) {
          op = { op: 'set', id: pick(ids()), path: pick(PATHS) };
          if (rnd() < 0.15) op.exact = true;
        } else if (roll < 0.9) {
          op = { op: 'setToken', path: pick(TOKEN_PATHS) };
        } else {
          const parent = pick(ids().filter((id) => doc.nodes[id].type === 'frame'));
          const good = rnd() < 0.6;
          op = { op: 'create', node: { type: pick(['rect', 'frame', 'text']), id: 'z' + seed + '_' + i + '_' + k, parent, characters: 'Т',
            states: good ? pick(GOOD.states) : pick(VALUES), motion: good ? pick(GOOD.motion) : pick(VALUES), shadow: good ? pick(GOOD.shadow) : pick(VALUES) } };
          for (const f of ['states', 'motion', 'shadow']) if (op.node[f] === undefined) delete op.node[f];
        }
        const key = (op.op === 'setToken' ? 'tok:' : '') + op.path;
        const v = rnd() < 0.6 && GOOD[key] ? pick(GOOD[key]) : pick(VALUES);
        if (op.op !== 'create' && v !== undefined) op.value = v;
        list.push(op);
      }
      const prev = doc;
      const r = quiet(() => applyOps(prev, clone(list)));
      if (r.error) { stats.rejected++; continue; }
      for (const op of list) stats[op.op]++;
      const what = `сид ${seed}, шаг ${i}: ${JSON.stringify(list)}`;
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
      // резолверы и валидатор на любом принятом документе не бросают
      if (i % 25 === 0) {
        const geo = solve(r.doc, M);
        validate(r.doc, geo, M);
        for (const n of Object.values(r.doc.nodes)) { resolveState(r.doc, n, ['hover', 'press', 'focus']); resolveMotion(r.doc, n); }
      }
      doc = r.doc;
    }
  }
  for (const [k, v] of Object.entries(stats)) assert.ok(v > 40, `покрыто ${k}: ${JSON.stringify(stats)}`);
});

/* ----------------------------- сцена и экспорт ----------------------------- */

/** Мини-DOM: атрибуты, дети, style (сериализуется в атрибут), classList. */
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
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      get firstChild() { return this.children[0] || null; },
      get outerHTML() {
        if (this.nodeName === '#text') return escText(this.text);
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
  const cls = new Set();
  st.el = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), remove: (c) => cls.delete(c), add: (c) => cls.add(c), has: (c) => cls.has(c) } };
  st.cls = cls;
  st.doc = doc;
  st.geo = solve(doc, M);
  st.view = { zoom: 1, pan: { x: 0, y: 0 } };
  st.errors = [];
  st.opts = { onError: (i) => st.errors.push(i.where + ': ' + (i.error && i.error.message)) };
  st._paintUI = () => {};
  st._hover = null;
  st._timers = new Set();
  st._previewOn = false;
  st._ix = { hover: new Set(), press: new Set(), focus: null };
  st._forced = new Map();
  st._forcedTimers = new Map();
  st._stList = null;
  st._exportStates = null;
  return st;
}

function animatedDoc() {
  return applyOps(sceneDoc(), [
    { op: 'set', id: 'btn', path: 'states', value: { hover: { fill: 'accentSoft', lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.96 }, focus: { stroke: { color: 'accentInk', width: 2 } } } },
    { op: 'set', id: 'btn', path: 'motion', value: { duration: 'motion.fast', easing: 'spring' } },
    { op: 'set', id: 'lbl', path: 'states', value: { hover: { color: 'accentInk' } } },
    { op: 'set', id: 'lbl', path: 'motion', value: { follow: 'parent' } },
    { op: 'set', id: 'r', path: 'shadow', value: 'shadow.lg' },
    { op: 'set', id: 'r', path: 'opacity', value: 0.5 }
  ]).doc;
}

test('круг36: toSVG — базовые opacity и тень в разметке, состояния — CSS :hover/:active/:focus-visible с transition', () => {
  withDom(() => {
    const doc = animatedDoc();
    const st = bareStage(doc);
    const svg = st.toSVG('ab', undefined, undefined, { fonts: false });
    assert.deepEqual(st.errors, []);
    const css = (/<style type="text\/css">([\s\S]*?)<\/style>/.exec(svg) || [])[1] || '';
    assert.ok(css, 'в SVG есть <style> состояний:\n' + svg.slice(0, 600));
    const plain = css.replace(/&gt;/g, '>');
    const cls = (id) => {
      const m = new RegExp(`class="imago-node imago-anim (im-[0-9a-z]+-s\\d+)" data-id="${id}"`).exec(svg);
      return m && (m[1] || m[2]);
    };
    const b = cls('btn');
    const l = cls('lbl');
    assert.ok(b && l, 'узлы со states помечены классом');
    assert.match(plain, new RegExp(`\\.${b}\\{transform-box:view-box;transform-origin:100px 44px;transition:transform 120ms cubic-bezier\\(0\\.34, 1\\.56, 0\\.64, 1\\) 0ms`));
    assert.match(plain, new RegExp(`\\.${b}:hover\\{transform:translate\\(0px, -2px\\) scale\\(1\\)\\}`));
    assert.match(plain, new RegExp(`\\.${b}:hover>\\.imago-shape\\{filter:drop-shadow\\(0px 4px 12px rgba\\(20,22,28,0\\.14\\)\\);fill:#ffe7de\\}`));
    assert.match(plain, new RegExp(`\\.${b}:active\\{transform:translate\\(0px, -2px\\) scale\\(0\\.96\\)\\}`), 'нажатие — поверх наведения');
    assert.match(plain, new RegExp(`\\.${b}:focus-visible>\\.imago-shape\\{stroke:#b03a12;stroke-width:2\\}`));
    assert.match(svg, new RegExp(`class="imago-node imago-anim ${b}" data-id="btn" tabindex="0"`), 'фокусируемый узел — с tabindex');
    assert.ok(!new RegExp(`data-id="lbl" tabindex`).test(svg), 'без focus — без tabindex');
    // ведомый (follow parent) меняется по наведению ведущего
    assert.match(plain, new RegExp(`\\.${b}:hover \\.${l}>\\.imago-shape\\{fill:#b03a12\\}`));
    assert.match(plain, /prefers-reduced-motion: reduce\)\{\.imago-anim,\.imago-anim>\.imago-shape\{transition:none!important\}\}/);
    // база: прозрачность и тень прямоугольника, прозрачная заливка у живого узла без заливки
    assert.match(svg, /data-id="r" opacity="0.5"/);
    assert.match(svg, /filter: drop-shadow\(0px 12px 28px rgba\(20,22,28,0\.18\)\)/);
    // без состояний — без <style>
    // второй экспорт — свои классы (превью встают инлайном в одну страницу)
    const again = st.toSVG('ab', undefined, undefined, { fonts: false });
    assert.ok(!again.includes(b + '{'), 'классы не повторяются между сборками');
    const st2 = bareStage(sceneDoc());
    const svg2 = st2.toSVG('ab', undefined, undefined, { fonts: false });
    assert.ok(!/<style/.test(svg2), 'документ без состояний не несёт CSS');
  });
});

/** Нарисовать сцену в мини-DOM (полная сборка _renderSVG). */
function drawn(doc) {
  const st = bareStage(doc);
  st.svg = document.createElementNS('', 'svg');
  st.svg.removeChild = function (c) { this.children.splice(this.children.indexOf(c), 1); };
  st._renderGrid = () => {};
  st.activeArtboard = 'ab';
  st._renderSVG();
  return st;
}

test('круг36: сцена — просмотр: наведение и нажатие накладывают состояния, правка — база; playState; без просмотра ничего не меняется', () => {
  withDom(() => {
    const st = drawn(animatedDoc());
    const g = st._drawn.get('btn').el;
    const shape = st._drawn.get('btn').shapes[0];
    const label = st._drawn.get('lbl').shapes[0];
    st._syncStates();
    assert.equal(g.style.transform, '', 'в правке — база');
    assert.match(g.style.transition, /^transform 120ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\) 0ms, opacity/, 'переход по motion узла');
    assert.equal(g.style.transformOrigin, '100px 44px', 'от центра узла');
    assert.match(shape.style.filter || '', /^$/, 'у кнопки базовой тени нет');
    assert.match(st._drawn.get('r').el.style.filter, /drop-shadow\(0px 12px 28px/, 'базовая тень рисуется всегда (у узла без фигур — на группе)');
    // наведение без просмотра — ничего
    st._onPointerMove({ clientX: 50, clientY: 40 });
    assert.equal(g.style.transform, '');
    // просмотр
    assert.equal(st.setPreview(true), true);
    assert.equal(st.previewMode, true);
    assert.ok(st.cls.has('is-preview'));
    st._previewMove({ x: 50, y: 40 });
    assert.equal(g.style.transform, 'translate(0px, -2px) scale(1)', 'наведение поднимает');
    assert.equal(shape.style.fill, '#ffe7de', 'и красит');
    assert.match(shape.style.filter, /drop-shadow\(0px 4px 12px/);
    assert.equal(label.style.fill, '#b03a12', 'подпись (follow parent) следует за кнопкой');
    assert.ok(st.cls.has('is-live'), 'курсор-рука');
    // ведомый берёт движение ведущего
    assert.match(st._drawn.get('lbl').shapes[0].style.transition, /^fill 120ms cubic-bezier\(0\.34/);
    st._previewDown({ x: 50, y: 40 });
    assert.equal(g.style.transform, 'translate(0px, -2px) scale(0.96)', 'нажатие поверх наведения');
    assert.equal(shape.style.stroke, '#b03a12', 'клик даёт фокус');
    st._onPointerUp({});
    assert.equal(g.style.transform, 'translate(0px, -2px) scale(1)', 'отпустили — снова наведение');
    st._previewMove({ x: 390, y: 290 });
    assert.equal(g.style.transform, '', 'ушли — база');
    assert.equal(shape.style.fill, '');
    assert.equal(label.style.fill, '');
    // Tab по фокусируемым, Esc снимает
    st._previewKey({ key: 'Escape' });
    assert.equal(shape.style.stroke, '');
    let prevented = false;
    st._previewKey({ key: 'Tab', preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    assert.equal(shape.style.stroke, '#b03a12', 'Tab — фокус на кнопке');
    // Delete в просмотре не действует
    assert.equal(st._previewKey({ key: 'Delete' }), true);
    // выключили — база и снова правка
    st.setPreview(false);
    assert.equal(g.style.transform, '');
    assert.equal(shape.style.stroke, '');
    assert.ok(!st.cls.has('is-preview'));
    // «Проиграть» в правке: принудительное состояние и снятие
    assert.equal(st.playState('btn', 'hover'), true);
    assert.equal(g.style.transform, 'translate(0px, -2px) scale(1)');
    assert.equal(label.style.fill, '#b03a12', 'ведомый тоже');
    assert.equal(st.playState('btn', null), false);
    assert.equal(g.style.transform, '');
    assert.equal(st.playState('r', 'hover'), false, 'у узла без состояний — false');
    assert.equal(st.playState('btn', 'bogus'), false);
    st.playState('btn', 'press');
    st.playState(null);
    assert.equal(g.style.transform, '', 'playState(null) снимает всё');
    assert.deepEqual(st.errors, []);
  });
});

test('круг36: сцена — prefers-reduced-motion: переходы мгновенные', () => {
  withDom(() => {
    const had = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({ matches: /reduce/.test(q) });
    try {
      const st = drawn(animatedDoc());
      st.setPreview(true);
      st._previewMove({ x: 50, y: 40 });
      const c = st._drawn.get('btn');
      assert.equal(c.el.style.transition, 'none');
      assert.equal(c.shapes[0].style.transition, 'none');
      assert.equal(c.el.style.transform, 'translate(0px, -2px) scale(1)', 'состояние всё равно показывается');
    } finally {
      if (had === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = had;
    }
  });
});

test('круг36: сцена — перерисовка не теряет показанное состояние и не плодит слушателей', () => {
  withDom(() => {
    const doc = animatedDoc();
    const st = drawn(doc);
    st.setPreview(true);
    st._previewMove({ x: 50, y: 40 });
    // полная пересборка (новые элементы) — состояние наложено заново
    st._drawnState = null;
    st._renderSVG();
    st._syncStates();
    const g = st._drawn.get('btn').el;
    assert.equal(g.style.transform, 'translate(0px, -2px) scale(1)');
    // правка цвета кнопки — новые фигуры; наведение держится
    const next = applyOps(doc, [{ op: 'set', id: 'btn', path: 'states.hover.fill', value: '#00ff00' }]).doc;
    st.doc = next;
    st.geo = solve(next, M);
    st._drawnState = null;
    st._renderSVG();
    st._syncStates();
    assert.equal(st._drawn.get('btn').shapes[0].style.fill, '#00ff00');
    // хозяйство слушателей: метод привязки не зовётся из отрисовки
    let binds = 0;
    st._bindEvents = () => { binds++; };
    st._renderSVG();
    st._syncStates();
    assert.equal(binds, 0);
  });
});
