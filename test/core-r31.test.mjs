import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, applyBatches, invertOps, hashDoc, splitOps, checkImportDoc, validate, solve,
  subtreeIds, artboards, rebase, SPLIT_MAX_OPS, SPLIT_MAX_BYTES, NODE_TYPES
} = core;

/* Круг 31, CORE. (1) children у не-контейнера: create с мусором не ложится, старый
   документ с мусором удаляется и отменяется; (2) всё, что применимо, точно
   отменяемо — и setToken по номеру шага (запись в конец шкалы), и запись через
   массивы в узле; (3) K1: splitOps — большая отмена пачками. */

const M = { measureText: (t, s) => String(t).length * s.fontSize * 0.5 };
const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {}; try { return fn(); } finally { console.warn = w; console.error = e; } };

function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

/** Все виды «детей», которые встречались в чужом вводе. */
const CHILDREN_VALUES = [
  '#ff0000', '', 'abc', 5, 0, -1, true, false, null, {}, { 0: 'a', length: 1 }, { mode: 'fixed' },
  ['x'], [''], [1], [null], [{}], ['a', 'a'], [[]], []
];

/* ------------------------------------------------------------------ *
 * 1. children
 * ------------------------------------------------------------------ */

test('круг31: create с children-не-массивом или непустым массивом у не-контейнера не ложится — для каждого вида узла', () => {
  const doc = createDoc();
  const art = artboards(doc)[0];
  const master = Object.values(doc.nodes).find((n) => n.component);
  const makeNode = (type, id, children) => {
    const node = { type, id, parent: art.id, children };
    if (type === 'text') node.characters = 'hi';
    if (type === 'instance') node.of = master.id;
    if (type === 'page') node.parent = undefined;
    return node;
  };
  let tried = 0;
  for (const type of NODE_TYPES) {
    for (const ch of CHILDREN_VALUES) {
      const id = 'z' + (tried++);
      const r = quiet(() => applyOps(doc, [{ op: 'create', node: makeNode(type, id, ch) }]));
      const container = type === 'frame' || type === 'page';
      const legal = container ? Array.isArray(ch) && ch.length === 0 : ch === undefined || (Array.isArray(ch) && ch.length === 0);
      if (!legal) {
        if (container && !Array.isArray(ch)) {
          // контейнер: мусор вместо списка детей приводится к [] (create рамки так делал всегда)
          if (!r.error) assert.deepEqual(r.doc.nodes[id].children, [], `${type} ${JSON.stringify(ch)}`);
          continue;
        }
        assert.ok(r.error, `${type} children=${JSON.stringify(ch)} — должен быть отказ`);
        assert.equal(r.doc, doc, 'документ не тронут');
        continue;
      }
      if (r.error) continue;   // страница без роли и т. п. — отказ по другой причине
      // легло — значит удаляется и отменяется
      const rm = applyOps(r.doc, [{ op: 'remove', id }]);
      assert.equal(rm.error, undefined, `${type} ${JSON.stringify(ch)}: remove`);
    }
  }
  assert.ok(tried >= NODE_TYPES.size * CHILDREN_VALUES.length);
});

/** Документ «прежней версии»: мусор в children положен в обход операций. */
function poisonedDoc() {
  const doc = clone(createDoc());
  const art = artboards(doc)[0];
  const frameId = art.children.find((c) => doc.nodes[c].type === 'frame');
  const add = (n) => { doc.nodes[n.id] = n; doc.nodes[n.parent].children.push(n.id); };
  add({ type: 'image', id: 'p_img', parent: frameId, children: '#ff0000', size: HUG });
  add({ type: 'text', id: 'p_txt', parent: art.id, characters: 'z', children: { 0: 'a', length: 1 }, size: HUG });
  add({ type: 'rect', id: 'p_rect', parent: art.id, children: ['ghost'], size: HUG });
  add({ type: 'frame', id: 'p_fr', parent: art.id, children: 7, size: HUG });
  return { doc, art, frameId };
}

test('круг31: документ прежней версии с мусором в children — удаляется узел, родитель, доска; отмена удаления применима', () => {
  const { doc, art, frameId } = poisonedDoc();
  for (const id of ['p_img', 'p_txt', 'p_rect', 'p_fr', frameId, art.id]) {
    const ops = [{ op: 'remove', id }];
    const r = applyOps(doc, ops);
    assert.equal(r.error, undefined, `remove ${id}: ${r.error && r.error.message}`);
    assert.equal(r.doc.nodes[id], undefined);
    for (const sid of subtreeIds(doc, id)) assert.equal(r.doc.nodes[sid], undefined, `${sid} из поддерева ${id} удалён`);
    const inv = invertOps(doc, ops);
    const back = applyOps(r.doc, inv);
    assert.equal(back.error, undefined, `отмена remove ${id}: ${back.error && back.error.message}`);
    assert.ok(back.doc.nodes[id], 'узел вернулся');
    // мусор отмена не возвращает: узел встаёт годным
    const n = back.doc.nodes[id];
    if (n.type !== 'frame' && n.type !== 'page') assert.ok(n.children === undefined || (Array.isArray(n.children) && !n.children.length));
    else assert.ok(Array.isArray(n.children));
    // надгробия и пачки — тот же путь, без исключений
    const b = applyBatches(doc, [ops]);
    assert.equal(b.results[0], null);
  }
  // ребёнок рамки с нечитаемым списком детей удаляется (список не трогается)
  const orphanDoc = clone(doc);
  orphanDoc.nodes.p_kid = { type: 'text', id: 'p_kid', parent: 'p_fr', characters: 'k', size: HUG };
  const rk = applyOps(orphanDoc, [{ op: 'remove', id: 'p_kid' }]);
  assert.equal(rk.error, undefined, rk.error && rk.error.message);
  assert.equal(rk.doc.nodes.p_kid, undefined);
  assert.equal(rk.doc.nodes.p_fr.children, 7);
  // класть под такую рамку — отказ словами (не исключение), документ цел
  const c = quiet(() => applyOps(doc, [{ op: 'create', node: { type: 'text', id: 'q1', parent: 'p_fr', characters: 'a' } }]));
  assert.ok(c.error);
  assert.equal(c.doc, doc);
  // правка соседнего поля у узла с мусором не запирается
  const s = applyOps(doc, [{ op: 'set', id: 'p_txt', path: 'characters', value: 'ok' }]);
  assert.equal(s.error, undefined, s.error && s.error.message);
  assert.doesNotThrow(() => solve(doc, M));
  assert.doesNotThrow(() => rebase(doc, [{ op: 'remove', id: 'p_img' }], { tombstones: new Map() }));
});

test('круг31: мусор в children видят checkImportDoc и validate; createDoc его убирает', () => {
  const { doc } = poisonedDoc();
  const imp = checkImportDoc(clone(doc));
  assert.ok(imp && imp.code === 'bad-doc', JSON.stringify(imp));
  assert.match(imp.message, /children|детей|дети/);
  for (const id of ['p_img', 'p_txt', 'p_rect']) {
    const one = clone(createDoc());
    const art = artboards(one)[0];
    const src = doc.nodes[id];
    one.nodes[id] = { ...src, parent: art.id };
    one.nodes[art.id].children.push(id);
    const err = checkImportDoc(one);
    assert.ok(err, `${id}: импорт должен отказать`);
    assert.equal(err.id, id);
  }
  const v = validate(doc, solve(doc, M), M).filter((x) => x.code === 'bad-children').map((x) => x.nodeId).sort();
  assert.deepEqual(v, ['p_img', 'p_rect', 'p_txt']);
  const fixed = quiet(() => createDoc(clone(doc)));
  for (const id of ['p_img', 'p_txt', 'p_rect']) assert.equal(fixed.nodes[id].children, undefined, id);
  assert.deepEqual(fixed.nodes.p_fr.children, []);
  assert.equal(checkImportDoc(clone(fixed)), null);
  assert.deepEqual(validate(fixed, solve(fixed, M), M).filter((x) => x.code === 'bad-children'), []);
});

test('круг31: фаззинг поля children — create/set любым значением на любом виде узла не оставляет неудаляемых узлов', () => {
  const { rnd, pick } = rng(31);
  let doc = createDoc();
  const master = Object.values(doc.nodes).find((n) => n.component);
  for (let i = 0; i < 400; i++) {
    const ids = Object.keys(doc.nodes);
    const containers = ids.filter((id) => doc.nodes[id].type === 'frame');
    const type = pick([...NODE_TYPES]);
    const node = { type, id: 'fz' + i, parent: pick(rnd() < 0.8 ? containers : ids), children: pick(CHILDREN_VALUES) };
    if (rnd() < 0.2) delete node.children;
    if (type === 'text') node.characters = 'x';
    if (type === 'instance') node.of = master.id;
    const ops = rnd() < 0.5
      ? [{ op: 'create', node }]
      : [{ op: 'set', id: pick(ids), path: 'children', value: pick(CHILDREN_VALUES) }];
    const r = quiet(() => applyOps(doc, ops));
    if (r.error) continue;
    const inv = invertOps(doc, ops);
    const back = applyOps(r.doc, inv);
    assert.equal(back.error, undefined);
    assert.equal(hashDoc(back.doc), hashDoc(doc), 'отмена точная: ' + JSON.stringify(ops));
    doc = r.doc;
  }
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'frame' && n.type !== 'page') assert.ok(n.children === undefined || (Array.isArray(n.children) && !n.children.length), JSON.stringify(n));
  }
  for (const id of Object.keys(doc.nodes)) {
    if (id === doc.root) continue;
    const r = applyOps(doc, [{ op: 'remove', id }]);
    assert.equal(r.error, undefined, `remove ${id}`);
  }
  assert.equal(checkImportDoc(clone(doc)), null);
});

/* ------------------------------------------------------------------ *
 * 2. Отмена точная: setToken и массивы
 * ------------------------------------------------------------------ */

test('круг31: setToken в конец шкалы (spacing.N, N = длина) отменяется точно; дальше конца и снятие шага — отказ', () => {
  const doc = createDoc();
  for (const g of ['spacing', 'radii']) {
    const len = doc.tokens[g].length;
    const ops = [{ op: 'setToken', path: `${g}.${len}`, value: 999 }];
    const r = applyOps(doc, ops);
    assert.equal(r.error, undefined);
    assert.equal(r.doc.tokens[g].length, len + 1);
    const inv = invertOps(doc, ops);
    assert.deepEqual(inv, [{ op: 'setToken', path: g, value: doc.tokens[g] }], 'шкала целиком');
    const back = applyOps(r.doc, inv);
    assert.equal(back.error, undefined, back.error && back.error.message);
    assert.equal(hashDoc(back.doc), hashDoc(doc));
    assert.deepEqual(back.doc.tokens[g], doc.tokens[g]);
    // повтор отмены (redo = инверсия инверсии) — тоже точный
    const redo = invertOps(r.doc, inv);
    assert.equal(hashDoc(applyOps(back.doc, redo).doc), hashDoc(r.doc));
    // замена шага — листом, отмена листом
    const rep = [{ op: 'setToken', path: `${g}.1`, value: 3 }];
    assert.deepEqual(invertOps(doc, rep), [{ op: 'setToken', path: `${g}.1`, value: doc.tokens[g][1] }]);
    for (const bad of [[`${g}.${len + 1}`, 1], [`${g}.${len - 1}`, undefined], [`${g}.01`, 1], [`${g}.x`, 1]]) {
      const e = quiet(() => applyOps(doc, [{ op: 'setToken', path: bad[0], value: bad[1] }]));
      assert.ok(e.error, `${bad[0]} = ${bad[1]} — отказ`);
    }
  }
});

test('круг31: токен-массив вне шкал — запись по номеру без дыр, отмена точная', () => {
  let doc = createDoc();
  doc = applyOps(doc, [{ op: 'setToken', path: 'space', value: [] }]).doc;
  // дальше конца — отказ (дыры, в JSON — null)
  assert.ok(quiet(() => applyOps(doc, [{ op: 'setToken', path: 'space.4', value: 'x' }])).error);
  assert.ok(quiet(() => applyOps(doc, [{ op: 'setToken', path: 'space.a', value: 'x' }])).error);
  for (const ops of [
    [{ op: 'setToken', path: 'space.0', value: 'x' }],
    [{ op: 'setToken', path: 'space.0', value: 'x' }, { op: 'setToken', path: 'space.1', value: 'y' }, { op: 'setToken', path: 'space.0', value: 'z' }],
    [{ op: 'setToken', path: 'space.0.deep', value: 1 }]
  ]) {
    const r = applyOps(doc, ops);
    assert.equal(r.error, undefined, JSON.stringify(ops));
    assert.ok(!hasHoles(r.doc.tokens.space), 'без дыр');
    const back = applyOps(r.doc, invertOps(doc, ops));
    assert.equal(back.error, undefined);
    assert.equal(hashDoc(back.doc), hashDoc(doc), JSON.stringify(ops));
    assert.deepEqual(back.doc.tokens.space, []);
  }
  // снятие элемента — отказ, снятие массива целиком — можно
  const two = applyOps(doc, [{ op: 'setToken', path: 'space', value: [1, 2] }]).doc;
  assert.ok(quiet(() => applyOps(two, [{ op: 'setToken', path: 'space.1' }])).error);
  const del = [{ op: 'setToken', path: 'space' }];
  const r = applyOps(two, del);
  assert.equal(r.error, undefined);
  assert.equal(hashDoc(applyOps(r.doc, invertOps(two, del)).doc), hashDoc(two));
});

test('круг31: set через массив в узле — номер не дальше длины, без снятия элемента; отмена точная', () => {
  const doc = createDoc();
  const master = Object.values(doc.nodes).find((n) => n.component && n.component.props && n.component.props.length);
  const n = master.component.props.length;
  const prop = { ...master.component.props[0], name: 'новый' };
  const ok = [{ op: 'set', id: master.id, path: `component.props.${n}`, value: prop }];
  const r = applyOps(doc, ok);
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(r.doc.nodes[master.id].component.props.length, n + 1);
  const inv = invertOps(doc, ok);
  assert.deepEqual(inv.map((o) => o.path), ['component.props'], 'массив целиком');
  assert.equal(hashDoc(applyOps(r.doc, inv).doc), hashDoc(doc));
  for (const [path, value] of [[`component.props.${n + 3}`, prop], ['component.props.0', undefined], ['component.props.name', 'x']]) {
    assert.ok(quiet(() => applyOps(doc, [{ op: 'set', id: master.id, path, value }])).error, path);
  }
});

/** Есть ли где-то в значении массив с дырой (в JSON она станет null, и hashDoc разойдётся с сервером). */
function hasHoles(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 40) return false;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!(i in v) || hasHoles(v[i], depth + 1)) return true;
    return false;
  }
  for (const k of Object.keys(v)) if (hasHoles(v[k], depth + 1)) return true;
  return false;
}

/**
 * Фаззинг «применить → отменить → hashDoc как был» по всем видам операций. Значения —
 * и годные, и мусор (отказ — тоже ответ; проверяется только то, что легло).
 */
function fuzzInverse(seed, steps) {
  const { rnd, pick } = rng(seed);
  let doc = createDoc();
  let made = 0;
  const evil = () => pick([
    null, 0, -1, 1e9, NaN, '', 'x', true, [], [1, 2], {}, { a: { b: 1 } }, '#ff0000', 'fill', 'hug',
    { mode: 'fill' }, { mode: 'fixed', value: 40 }, { token: 'spacing.2' }, '$spacing.2', 4, 8, 24, undefined,
    { font: 'IBM Plex Sans', fontSize: 15, lineHeight: 20 }, [0, 4, 8], ['a'], { x: 1 }
  ]);
  const nodePaths = ['name', 'characters', 'layout', 'layout.mode', 'layout.gap', 'layout.padding', 'layout.padding.top',
    'size', 'size.w', 'size.w.mode', 'size.w.value', 'fill', 'fill.token', 'color', 'stroke', 'radius', 'opacity', 'props',
    'props.label', 'component', 'component.props', 'component.props.0', 'component.props.1', 'component.props.9',
    'component.props.0.name', 'list', 'list.0', 'list.1', 'list.0.a', 'style', 'style.token', 'children', 'of', 'visible'];
  const tokenPaths = () => {
    const sp = doc.tokens.spacing.length; const ra = doc.tokens.radii.length;
    const misc = Array.isArray(doc.tokens.misc) ? doc.tokens.misc.length : 0;
    return ['spacing', `spacing.${sp}`, `spacing.${sp - 1}`, `spacing.${sp + 1}`, 'spacing.0', 'radii', `radii.${ra}`, 'radii.2',
      'colors', 'colors.accent', 'colors.fresh', 'colors.accent.x', 'type', 'type.body', 'type.body.fontSize', 'type.fresh',
      'misc', `misc.${misc}`, 'misc.0', 'misc.0.a', 'misc.k', 'other.a.b'];
  };
  const kinds = { create: 0, remove: 0, set: 0, move: 0, setToken: 0 };
  for (let i = 0; i < steps; i++) {
    const ids = Object.keys(doc.nodes);
    const frames = ids.filter((id) => doc.nodes[id].type === 'frame' || doc.nodes[id].type === 'page');
    const ops = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const kind = pick(['create', 'create', 'remove', 'set', 'set', 'set', 'move', 'move', 'setToken', 'setToken', 'setToken']);
      if (kind === 'create') {
        const type = pick(['frame', 'frame', 'text', 'rect', 'image', 'ellipse']);
        const node = { type, id: 'u' + (made++), parent: pick(frames) };
        if (type === 'text') node.characters = 'привет';
        if (rnd() < 0.3) node.children = pick(CHILDREN_VALUES);
        if (rnd() < 0.3) node[pick(nodePaths).split('.')[0]] = evil();
        const op = { op: 'create', node };
        if (rnd() < 0.3) op.index = pick([0, 1, -1, 1e9, 2.5]);
        ops.push(op);
      } else if (kind === 'remove') {
        if (rnd() < 0.5) ops.push({ op: 'remove', id: pick(ids) });
      } else if (kind === 'set') {
        ops.push({ op: 'set', id: pick(ids), path: pick(nodePaths), value: evil() });
      } else if (kind === 'move') {
        ops.push({ op: 'move', id: pick(ids), parent: pick(frames), index: pick([0, 1, -1, 1e9, 2.5, undefined]) });
      } else {
        const path = pick(tokenPaths());
        let value = evil();
        if (/^(spacing|radii)\.\d+$/.test(path) && rnd() < 0.7) value = pick([0, 4, 12, 999]);
        if (path === 'misc' && rnd() < 0.6) value = pick([[], ['a'], [1, { a: 2 }], { k: 1 }]);
        ops.push({ op: 'setToken', path, value });
      }
    }
    const prev = doc;
    const r = quiet(() => applyOps(prev, ops));
    if (r.error) continue;
    for (const op of ops) kinds[op.op]++;
    // по сети операции идут JSON — инверсию считаем и применяем так же
    const wire = clone(ops);
    const inv = clone(invertOps(prev, wire));
    const back = quiet(() => applyOps(r.doc, inv));
    assert.equal(back.error, undefined, `шаг ${i}: отмена не применилась: ${back.error && back.error.message}\n${JSON.stringify(ops)}\n${JSON.stringify(inv).slice(0, 2000)}`);
    assert.equal(hashDoc(back.doc), hashDoc(prev), `шаг ${i}: отмена не точная\n${JSON.stringify(ops)}\n${JSON.stringify(inv).slice(0, 2000)}`);
    assert.ok(!hasHoles(r.doc.tokens) && !hasHoles(r.doc.nodes), `шаг ${i}: дыра в массиве ${JSON.stringify(ops)}`);
    // круг 33 (инвариант): принятое операцией — годный документ; иначе проект,
    // который ядро вело, нельзя экспортировать и импортировать обратно
    const imp = checkImportDoc(clone(r.doc));
    assert.equal(imp, null, `шаг ${i}: принятая правка дала документ, который не импортируется: ${JSON.stringify(imp)}\n${JSON.stringify(ops)}`);
    // повтор (инверсия инверсии) возвращает документ после правки
    const redo = clone(invertOps(r.doc, clone(inv)));
    const again = quiet(() => applyOps(back.doc, redo));
    assert.equal(again.error, undefined, `шаг ${i}: повтор не применился`);
    assert.equal(hashDoc(again.doc), hashDoc(r.doc), `шаг ${i}: повтор не точный ${JSON.stringify(ops)}`);
    doc = r.doc;
  }
  return kinds;
}

test('круг31: фаззинг «применить → отменить → hashDoc как был» по всем видам операций, включая setToken', () => {
  const total = { create: 0, remove: 0, set: 0, move: 0, setToken: 0 };
  for (const seed of [1, 7, 31, 2026]) {
    const k = fuzzInverse(seed, 500);
    for (const key of Object.keys(total)) total[key] += k[key];
  }
  for (const [kind, n] of Object.entries(total)) assert.ok(n > 30, `вид ${kind} покрыт: ${n}`);
});

/* ------------------------------------------------------------------ *
 * 3. K1: splitOps
 * ------------------------------------------------------------------ */

test('круг31: splitOps — пределы по числу операций и байтам UTF-8, порядок цел, пустой вход', () => {
  assert.deepEqual(splitOps([]), []);
  assert.deepEqual(splitOps(null), []);
  assert.equal(SPLIT_MAX_OPS, 5000);
  assert.equal(SPLIT_MAX_BYTES, 3.5 * 1024 * 1024);
  const list = Array.from({ length: 12001 }, (_, i) => ({ op: 'set', id: 'n' + i, path: 'name', value: 'имя ' + i }));
  const parts = splitOps(list);
  assert.deepEqual(parts.map((p) => p.length), [5000, 5000, 2001]);
  assert.deepEqual(parts.flat(), list, 'те же объекты в том же порядке');
  const bytes = (p) => Buffer.byteLength(JSON.stringify(p));
  const small = splitOps(list, { maxBytes: 20000, maxOps: 100000 });
  assert.ok(small.length > 1);
  for (const p of small) assert.ok(bytes(p) <= 20000, `пачка ${bytes(p)} байт`);
  assert.deepEqual(small.flat(), list);
  // кириллица считается в байтах, а не в символах: «ж» — два байта
  const cyr = Array.from({ length: 10 }, (_, i) => ({ op: 'set', id: 'n' + i, path: 'name', value: 'ж'.repeat(100) }));
  const one = bytes([cyr[0]]);
  for (const p of splitOps(cyr, { maxBytes: one * 3 + 2 })) assert.ok(bytes(p) <= one * 3 + 2);
  // операция больше предела — отдельной пачкой
  const huge = { op: 'set', id: 'h', path: 'characters', value: 'x'.repeat(5000) };
  const mixed = splitOps([cyr[0], huge, cyr[1]], { maxBytes: 1000 });
  assert.deepEqual(mixed.map((p) => p.length), [1, 1, 1]);
  assert.equal(mixed[1][0], huge);
  // create без id получает id до деления
  const c = splitOps([{ op: 'create', node: { type: 'text', parent: 'x', characters: 'a' } }]);
  assert.ok(c[0][0].node.id);
});

test('круг31 (K1): удалить поддерево из 8000+ узлов → инверсия → splitOps → пачки по порядку → hashDoc как до удаления', () => {
  let doc = createDoc('empty');
  const art = Object.values(doc.nodes).find((n) => n.type === 'frame') || doc.nodes[doc.root];
  const host = art.id;
  // ветка: рамка B → 40 рамок → по 200 текстов (8041 узел), длинные русские подписи
  const build = [{ op: 'create', node: { type: 'frame', id: 'B', name: 'Ветка', parent: host, children: [], size: HUG } }];
  for (let f = 0; f < 40; f++) {
    build.push({ op: 'create', node: { type: 'frame', id: 'b' + f, name: 'Блок ' + f, parent: 'B', children: [], size: HUG, layout: { mode: 'column', gap: 4 } } });
    for (let t = 0; t < 200; t++) {
      build.push({ op: 'create', node: { type: 'text', id: `b${f}t${t}`, name: 'Строка', parent: 'b' + f, characters: 'Текст строки номер ' + t + ' — '.repeat(10), size: HUG } });
    }
  }
  for (let i = 0; i < build.length; i += 5000) {
    const r = applyOps(doc, build.slice(i, i + 5000));
    assert.equal(r.error, undefined, r.error && r.error.message);
    doc = r.doc;
  }
  const before = hashDoc(doc);
  const size = subtreeIds(doc, 'B').length;
  assert.ok(size >= 8000, String(size));
  const removeOps = [{ op: 'remove', id: 'B' }];
  const inv = invertOps(doc, removeOps);
  assert.equal(inv.length, size);
  const after = applyOps(doc, removeOps).doc;
  assert.equal(after.nodes.B, undefined);

  // по сети — JSON; пределы — как у сервиса и поменьше (много пачек, мелкие по байтам)
  for (const opts of [undefined, { maxOps: 1000 }, { maxBytes: 256 * 1024 }, { maxOps: 777, maxBytes: 100 * 1024 }]) {
    const parts = splitOps(clone(inv), opts);
    const maxOps = (opts && opts.maxOps) || SPLIT_MAX_OPS;
    const maxBytes = (opts && opts.maxBytes) || SPLIT_MAX_BYTES;
    assert.ok(parts.length >= Math.ceil(size / maxOps), 'пачек ' + parts.length);
    if (opts) assert.ok(parts.length > 1, 'больше одной пачки при ' + JSON.stringify(opts));
    let cur = after;
    for (const [k, part] of parts.entries()) {
      assert.ok(part.length <= maxOps);
      assert.ok(Buffer.byteLength(JSON.stringify(part)) <= maxBytes, `пачка ${k}: байт больше предела`);
      const r = applyOps(cur, clone(part));
      assert.equal(r.error, undefined, `пачка ${k}/${parts.length} при ${JSON.stringify(opts)}: ${r.error && r.error.message}`);
      cur = r.doc;
    }
    assert.equal(hashDoc(cur), before, 'документ как до удаления при ' + JSON.stringify(opts));
    // те же пачки одним черновиком (как сервер поднимает хвост журнала)
    const b = applyBatches(after, splitOps(clone(inv), opts));
    assert.ok(b.results.every((x) => x === null));
    assert.equal(hashDoc(b.doc), before);
  }
});
