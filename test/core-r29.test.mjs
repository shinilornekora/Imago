import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const {
  createDoc, applyOps, rebase, invertOps, hashDoc, solve, validate, ops, Stage,
  checkImportDoc, fieldProblem, MAX_DEPTH, MAX_IMPORT_NODES, makeComponentOps, instanceOps,
  displayName, resolveTarget, components, instanceSummary, expandDoc, ensureScaleRefsOps,
  resolveTextStyle, resolveColor, artboards
} = core;

/* Круг 29, CORE. (1) Форма КАЖДОГО поля узла и стиля: значение не того вида —
   операция bad-node (в rebase — dropped invalid), ключи Object.prototype в данных
   запрещены, setToken проверяет то, что пишет. (2) Решатель, валидатор, хэш,
   отрисовка не приводят чужие значения неявно: документ, отравленный до
   исправления, открывается. (3) checkImportDoc (J7): глубина, циклы, форма,
   предел узлов. Основа фаззинга — сценарии критика (poison, corefuzz2, deep3). */

const M = { measureText: (t, s) => String(t).length * s.fontSize * 0.5 };
const HUG = { w: { mode: 'hug' }, h: { mode: 'hug' } };
const FIX = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });
const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 1) / 0x7fffffff; }; };
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Небольшая сцена со всеми типами узлов, мастером и экземпляром — solve на ней дешёвый. */
function sceneDoc() {
  let doc = createDoc('empty');
  const step = (list) => { const r = applyOps(doc, list); assert.equal(r.error, undefined, JSON.stringify(r.error)); doc = r.doc; };
  step([
    ops.create({ type: 'frame', id: 'ab', name: 'Доска', parent: doc.root, children: [], size: FIX(390, 600), pos: { x: 0, y: 0 }, fill: 'surface', layout: { mode: 'column', gap: 8, padding: 16 }, clip: true }),
    ops.create({ type: 'frame', id: 'card', name: 'Карточка', parent: 'ab', children: [], size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, layout: { mode: 'row', gap: 'spacing.4', padding: 8 }, fill: { token: 'surfaceAlt' }, stroke: { color: 'line', width: 1 }, radius: 'radii.2' }),
    ops.create({ type: 'text', id: 't', name: 'Заголовок', parent: 'card', characters: 'Привет', style: { token: 'title', fontSize: 20 }, color: 'text', size: HUG }),
    ops.create({ type: 'text', id: 't2', name: 'Подпись', parent: 'card', characters: 'мелко', style: 'caption', size: HUG, align: 'left' }),
    ops.create({ type: 'rect', id: 'r', name: 'Плашка', parent: 'ab', size: FIX(40, 20), fill: 'accent', radius: 4 }),
    ops.create({ type: 'ellipse', id: 'e', name: 'Точка', parent: 'ab', size: FIX(10, 10), fill: '#123456' }),
    ops.create({ type: 'image', id: 'img', name: 'Фото', parent: 'ab', size: FIX(60, 40), src: 'https://example.invalid/a.png' }),
    ops.create({ type: 'frame', id: 'btn', name: 'Кнопка', parent: 'ab', children: [], size: HUG, layout: { mode: 'row', padding: 8 }, fill: 'accent' }),
    ops.create({ type: 'text', id: 'bt', name: 'Надпись', parent: 'btn', characters: 'Ок', style: 'body', size: HUG })
  ]);
  step(makeComponentOps(doc, 'btn', { name: 'Кнопка', props: [{ name: 'label', kind: 'text', target: 'bt', path: 'characters' }] }));
  step(instanceOps(doc, { of: 'btn', parent: 'ab', props: { label: 'Оплатить' } }));
  return doc;
}

const EVILS = [
  { toString: 1 }, { valueOf: 1, toString: 1 }, [{ toString: 1 }], { token: { toString: 1 } },
  { color: { toString: 1 }, width: { toString: 1 } }, { mode: { toString: 1 } }, { a: { b: { toString: 1 } } },
  [], [1, 2], {}, null, 0, -1, 1e308, 0.5, true, false, 'x', '', 'constructor', '__proto__', 'toString',
  'spacing.3', 'radii.99', { mode: 'fixed', value: 'x' }, { w: 'fill', h: { toString: 1 } }, { x: 1, y: { toString: 1 } },
  { token: 'accent' }, { token: 'display', fontSize: 'big' }, { '0': '#', toString: 1 }, ['spacing.1', 8]
];
const PATHS = [
  'name', 'characters', 'style', 'style.token', 'style.font', 'style.fontFamily', 'style.fontSize', 'style.fontWeight',
  'style.lineHeight', 'style.letterSpacing', 'style.size', 'style.a.b', 'fill', 'fill.token', 'fill.color', 'color',
  'color.token', 'stroke', 'stroke.color', 'stroke.width', 'stroke.token', 'opacity', 'visible', 'clip', 'locked',
  'src', 'role', 'radius', 'radius.0', 'align', 'of', 'props', 'props.label', 'component', 'component.name',
  'component.props', 'layout', 'layout.mode', 'layout.gap', 'layout.padding', 'layout.padding.t', 'layout.align',
  'layout.justify', 'layout.wrap', 'size', 'size.w', 'size.w.mode', 'size.w.value', 'pos', 'pos.x', 'override',
  'override.w', 'text', 'tokens', 'zzz', 'zzz.deep'
];
const TYPES = ['frame', 'text', 'rect', 'ellipse', 'image', 'instance', 'page', 'zzz'];

/** Всё, что читает документ, обязано отработать без исключения. */
function readsEverything(doc, why) {
  const geo = solve(doc, M);
  assert.ok(geo && geo.rects, why + ': solve дал геометрию');
  for (const [id, r] of Object.entries(geo.rects)) {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(r[k]), `${why}: ${id}.${k} = ${r[k]}`);
  }
  validate(doc, geo);
  hashDoc(doc);
  components(doc);
  expandDoc(doc);
  ensureScaleRefsOps(doc);
  resolveTarget(doc, 'Заголовок');
  for (const id of Object.keys(doc.nodes)) {
    displayName(doc, id);
    instanceSummary(doc, id);
    const n = doc.nodes[id];
    if (n && n.type === 'text') resolveTextStyle(doc, n);
    if (n) { resolveColor(doc, n.fill); resolveColor(doc, n.color); }
  }
  return geo;
}

/** Минимальный DOM для toSVG(): атрибуты, дети, сериализация. */
function withSvgDom(fn) {
  const had = globalThis.document;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const mk = (name) => ({
    nodeName: name, attrs: new Map(), children: [], text: '',
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    setAttributeNS(_ns, k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    removeAttribute(k) { this.attrs.delete(k); },
    appendChild(c) { this.children.push(c); return c; },
    get outerHTML() {
      if (this.nodeName === '#text') return esc(this.text);
      return `<${this.nodeName}${[...this.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${this.children.map((c) => c.outerHTML).join('')}</${this.nodeName}>`;
    }
  });
  globalThis.document = { createElementNS: (_ns, name) => mk(name), createElement: (name) => mk(name), createTextNode: (t) => { const n = mk('#text'); n.text = t; return n; } };
  try { return fn(); } finally { globalThis.document = had; }
}

/** SVG доски без ошибок отрисовки. */
function svgOk(doc, geo, why) {
  withSvgDom(() => {
    const st = Object.create(Stage.prototype);
    st.el = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
    st.doc = doc;
    st.geo = geo;
    st.view = { zoom: 1, pan: { x: 0, y: 0 } };
    st.errors = [];
    st.opts = { onError: (i) => st.errors.push(i.where + ': ' + (i.error && i.error.message)) };
    for (const ab of artboards(doc)) {
      st.toSVG(ab.id, undefined, undefined, { fonts: false });
      assert.deepEqual(st.errors, [], why + ': toSVG без ошибок');
    }
  });
}

test('круг29: критик — set style.token = {toString:1} и родня отклоняются, холст живёт', () => {
  const doc = sceneDoc();
  const cases = [
    ['style.token', { toString: 1 }], ['style.token', [{ toString: 1 }]], ['style', { token: { toString: 1 } }],
    ['style', { toString: 1 }], ['style.font', { toString: 1 }], ['style.size', { toString: 1 }], ['fill', { toString: 1 }],
    ['color', { token: { toString: 1 } }], ['stroke', { color: { toString: 1 } }], ['layout.padding', { toString: 1 }], ['layout.mode', { toString: 1 }],
    ['name', { toString: 1 }], ['characters', ['a']], ['clip', 1], ['visible', 'false'], ['role', 5], ['src', {}]
  ];
  for (const [path, value] of cases) {
    const id = path === 'clip' || path === 'layout.padding' ? 'card' : path === 'src' ? 'img' : 't';
    const r = quiet(() => applyOps(doc, [{ op: 'set', id, path, value }]));
    assert.ok(r.error, `${path}=${JSON.stringify(value)} отклонена`);
    assert.equal(r.error.code, 'bad-node', `${path}: код bad-node, а не исключение: ${r.error.message}`);
    assert.doesNotMatch(r.error.message, /негодное значение/, 'причина названа словами');
    // слияние на сервере — тот же отказ: dropped invalid, голова цела
    const m = quiet(() => rebase(doc, [{ op: 'set', id, path, value }], { tombstones: new Map() }));
    assert.equal(m.ops.length, 0, path);
    assert.equal(m.dropped[0].reason, 'invalid', path);
  }
  // законные формы тех же полей проходят
  for (const [id, path, value] of [['t', 'style.token', 'display'], ['t', 'style', 'body'], ['t', 'style', { token: 'title', letterSpacing: -0.2 }],
    ['card', 'fill', { token: 'accent' }], ['card', 'stroke', { color: { token: 'line' }, width: 2 }], ['card', 'clip', false],
    ['t', 'role', 'title'], ['t', 'style.a.b', 1], ['r', 'fill', null], ['card', 'layout.padding', [4, 8]]]) {
    const r = applyOps(doc, [ops.set(id, path, value)]);
    assert.equal(r.error, undefined, `${id}.${path}=${JSON.stringify(value)}: ${r.error && r.error.message}`);
    readsEverything(r.doc, path);
  }
});

test('круг29: ключи Object.prototype — ни в пути set/setToken, ни в данных узла', () => {
  const doc = sceneDoc();
  for (const op of [ops.set('t', 'style.toString', 1), ops.set('t', 'valueOf', 1), ops.setToken('colors.toString', '#fff'), ops.setToken('type.hasOwnProperty', {})]) {
    const r = applyOps(doc, [op]);
    assert.equal(r.error && r.error.code, 'protected-path', JSON.stringify(op));
  }
  const bad = quiet(() => applyOps(doc, [ops.create({ type: 'rect', id: 'x', parent: 'ab', size: HUG, meta: { valueOf: 2 } })]));
  assert.equal(bad.error && bad.error.code, 'bad-node');
  assert.match(bad.error.message, /valueOf/);
  const deep = { v: 1 };
  let cur = deep;
  for (let i = 0; i < 40; i++) { cur.n = { v: i }; cur = cur.n; }
  const tooDeep = quiet(() => applyOps(doc, [ops.set('r', 'meta', deep)]));
  assert.equal(tooDeep.error && tooDeep.error.code, 'bad-node', 'значение глубже PLAIN_DEPTH — не данные макета');
  // нечисловое число — тоже не данные: после JSON это null, отпечатки бы разошлись
  const nan = quiet(() => applyOps(doc, [ops.set('r', 'meta', { k: NaN })]));
  assert.equal(nan.error && nan.error.code, 'bad-node');
});

test('круг29: setToken проверяет записываемое значение', () => {
  const doc = sceneDoc();
  const bad = [
    ['colors.accent', { toString: 1 }], ['colors.accent', 5], ['colors', { a: {} }], ['colors.accent.x', '#fff'],
    ['type.body', 'x'], ['type.body.font', { toString: 1 }], ['type.body.fontSize', 'big'], ['type.body.fontWeight', 50],
    ['type', { body: { font: 3 } }], ['spacing', 'не массив'], ['spacing', [0, 'x']], ['spacing.3', 'x'],
    ['spacing.99', 4], ['spacing.x', 4], ['radii.1'], ['spacing.2.3', 1], ['radii', [0, -1]], ['zzz', { a: NaN }]
  ];
  for (const [path, value] of bad) {
    const r = quiet(() => applyOps(doc, [ops.setToken(path, value)]));
    assert.ok(r.error, `${path}=${JSON.stringify(value)} отклонена`);
    assert.equal(r.error.code, 'bad-op', path);
  }
  const good = [
    ['colors.accent', '#ff0000'], ['colors.fresh', '#123456'], ['colors.accent'], ['type.body.fontSize', 16],
    ['type.hero', { font: 'Inter', fontSize: 48, fontWeight: 700, lineHeight: 52 }], ['type.body.font', 'Inter'],
    ['spacing.6', 18], ['spacing.' + doc.tokens.spacing.length, 80], ['spacing', [0, 4, 8]], ['radii', [0, 2]],
    ['zzz', { any: ['data', 1, true, null] }]
  ];
  for (const [path, value] of good) {
    const r = applyOps(doc, [ops.setToken(path, value)]);
    assert.equal(r.error, undefined, `${path}: ${r.error && r.error.message}`);
    readsEverything(r.doc, path);
  }
});

test('круг29: фаззинг — тысячи set/create с чужими значениями; что легло, ничего не ломает', () => {
  const rnd = lcg(29029);
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
  let doc = sceneDoc();
  const base = doc;
  const stats = { applied: 0, rejected: 0, txs: 0 };
  const N = 2500;
  for (let i = 0; i < N; i++) {
    const ids = Object.keys(doc.nodes);
    const list = [];
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const roll = rnd();
      if (roll < 0.55) list.push({ op: 'set', id: pick(ids), path: pick(PATHS), value: rnd() < 0.85 ? pick(EVILS) : undefined });
      else if (roll < 0.85) {
        const node = { type: pick(TYPES), id: 'z' + i + '_' + k, parent: pick(ids) };
        if (node.type === 'text') node.characters = 'z';
        for (let j = Math.floor(rnd() * 4); j > 0; j--) {
          const p = pick(PATHS).split('.');
          let cur = node;
          for (let q = 0; q < p.length - 1; q++) { if (!cur[p[q]] || typeof cur[p[q]] !== 'object') cur[p[q]] = {}; cur = cur[p[q]]; }
          cur[p[p.length - 1]] = pick(EVILS);
        }
        list.push({ op: 'create', node });
      } else list.push({ op: 'setToken', path: pick(['colors.accent', 'colors.x', 'type.body', 'type.body.font', 'type.body.fontSize', 'spacing.3', 'radii', 'zzz']), value: pick(EVILS) });
    }
    const sent = clone(list.map((op) => (op.value === undefined && op.op !== 'create' ? { ...op, value: null } : op)));
    // и через сеть (JSON), и напрямую — оба входа проверяются
    for (const input of [sent, list]) {
      stats.txs += 1;
      const m = quiet(() => rebase(doc, clone(input), { tombstones: new Map() }));
      if (!m.ops.length) { stats.rejected += 1; continue; }
      const strict = quiet(() => applyOps(doc, m.ops));
      assert.equal(strict.error, undefined, 'применённая форма проходит строго: ' + JSON.stringify(strict.error) + ' ' + JSON.stringify(m.ops).slice(0, 300));
      const next = strict.doc;
      // простые данные: JSON туда и обратно не меняет отпечаток
      assert.equal(hashDoc(clone(next)), hashDoc(next), 'документ переживает JSON: ' + JSON.stringify(m.ops).slice(0, 300));
      const geo = quiet(() => readsEverything(next, JSON.stringify(m.ops).slice(0, 200)));
      if (i % 50 === 0) quiet(() => svgOk(next, geo, 'фаззинг ' + i));
      // отмена ложится и возвращает прежний документ
      const inv = invertOps(doc, m.ops);
      const back = quiet(() => applyOps(next, inv));
      assert.equal(back.error, undefined, 'отмена ложится: ' + JSON.stringify(back.error));
      assert.equal(hashDoc(back.doc), hashDoc(doc), 'отмена возвращает документ');
      // каждый узел нового документа — по схеме
      for (const node of Object.values(next.nodes)) {
        for (const k of Object.keys(node)) assert.equal(fieldProblem(node, k), null, `${node.id}.${k} = ${JSON.stringify(node[k]).slice(0, 80)}`);
      }
      doc = next;
      stats.applied += 1;
    }
    if (Object.keys(doc.nodes).length > 200) doc = base;
  }
  assert.ok(stats.applied > 500, 'фаззинг действительно что-то применял: ' + JSON.stringify(stats));
  assert.ok(stats.rejected > 500, 'и действительно отклонял: ' + JSON.stringify(stats));
});

test('круг29: документ, отравленный до исправления, открывается, правится и чинится', () => {
  const base = sceneDoc();
  const evilFields = [
    ['t', 'style', { token: { toString: 1 }, font: { toString: 1 }, fontSize: { valueOf: 1 } }], ['t', 'style', [{ toString: 1 }]],
    ['t', 'style', 'constructor'], ['t', 'characters', { toString: 1 }], ['t', 'name', { toString: 1 }], ['t', 'color', { '0': '#', toString: 1 }],
    ['card', 'fill', { token: { toString: 1 } }], ['card', 'stroke', { color: { toString: 1 }, width: { toString: 1 } }],
    ['card', 'layout', { mode: { toString: 1 }, gap: { toString: 1 }, padding: { toString: 1 } }], ['card', 'clip', 1],
    ['card', 'radius', { toString: 1 }], ['card', 'size', { w: { mode: { toString: 1 } }, h: 3 }], ['card', 'opacity', { toString: 1 }],
    ['card', 'children', [{ toString: 1 }, 't', 't2']], ['card', 'parent', { toString: 1 }], ['card', 'type', { toString: 1 }],
    ['img', 'src', { toString: 1 }], ['r', 'pos', { x: { toString: 1 }, y: 1 }], ['r', 'override', { x: 1, y: { toString: 1 } }],
    ['r', 'role', { toString: 1 }], ['r', 'visible', 'false']
  ];
  const instId = Object.values(base.nodes).find((n) => n.type === 'instance').id;
  evilFields.push([instId, 'of', { toString: 1 }], [instId, 'props', { label: { toString: 1 } }], [instId, 'type', { toString: 1 }]);
  const tokenEvils = [['colors', 'accent', { toString: 1 }], ['colors', 'surface', { '0': '#', toString: 1 }], ['type', 'body', { font: { toString: 1 }, fontSize: { toString: 1 } }],
    ['type', 'title', 'x'], ['type', 'caption', null]];
  const poisoned = [];
  for (const [id, k, v] of evilFields) { const d = clone(base); d.nodes[id][k] = v; poisoned.push([`${id}.${k}`, d, id]); }
  for (const [g, k, v] of tokenEvils) { const d = clone(base); d.tokens[g][k] = v; poisoned.push([`tokens.${g}.${k}`, d, 't']); }
  // всё разом
  const all = clone(base);
  for (const [id, k, v] of evilFields) if (k !== 'type' && k !== 'parent') all.nodes[id][k] = v;
  for (const [g, k, v] of tokenEvils) all.tokens[g][k] = v;
  poisoned.push(['всё разом', all, 't']);

  for (const [why, doc, id] of poisoned) {
    // как из снимка/журнала прежней версии: прямо в документ, мимо операций
    const geo = quiet(() => readsEverything(doc, why));
    quiet(() => svgOk(doc, geo, why));
    // правка другого поля того же узла не запирается соседним мусором
    const other = quiet(() => applyOps(doc, [ops.set(id, 'name', 'Новое имя')]));
    if (!/type|parent|children/.test(why) || why === 'всё разом') {
      assert.equal(other.error, undefined, `${why}: имя правится: ${other.error && other.error.message}`);
      quiet(() => readsEverything(other.doc, why + ' после правки'));
    } else assert.ok(!other.error || other.error.code !== 'bad-op' || /children/.test(why), `${why}: ${other.error && other.error.message}`);
    // createDoc (открытие файла, восстановление) чинит форму: дальше документ строгий
    const opened = quiet(() => createDoc(clone(doc)));
    quiet(() => readsEverything(opened, why + ' после createDoc'));
    for (const node of Object.values(opened.nodes)) {
      for (const k of Object.keys(node)) assert.equal(fieldProblem(node, k), null, `${why}: createDoc оставил ${node.id}.${k}`);
    }
  }

  // само отравленное поле чинится обычной правкой, а мусор той же «причиной» не входит
  const d = clone(base);
  d.nodes.t.style = { token: { toString: 1 } };
  assert.ok(quiet(() => applyOps(d, [ops.set('t', 'style.token', { toString: 2 })])).error, 'новый мусор в то же поле не входит');
  const fixed = applyOps(d, [ops.set('t', 'style', 'display')]);
  assert.equal(fixed.error, undefined);
  assert.equal(resolveTextStyle(fixed.doc, fixed.doc.nodes.t).fontSize, 34);
  const flag = clone(base);
  flag.nodes.card.clip = 1;
  assert.equal(applyOps(flag, [ops.set('card', 'name', 'x')]).error, undefined, 'clip: 1 из старого документа не запирает узел');
  assert.ok(quiet(() => applyOps(flag, [ops.set('card', 'clip', 1)])).error, 'но записать clip: 1 нельзя');
  assert.equal(applyOps(flag, [ops.set('card', 'clip', true)]).error, undefined);
});

/** Цепочка фреймов глубиной n под доской: d0 на глубине 2. */
function chainDoc(n) {
  const d = clone(sceneDoc());
  let par = 'ab';
  for (let i = 0; i < n; i++) {
    const id = 'd' + i;
    d.nodes[id] = { id, type: 'frame', name: id, parent: par, children: [], size: HUG };
    d.nodes[par].children.push(id);
    par = id;
  }
  return d;
}

test('круг29 (J7): checkImportDoc — глубина, циклы, форма полей, предел узлов', () => {
  assert.equal(checkImportDoc(createDoc()), null, 'демо-документ годен');
  assert.equal(checkImportDoc(createDoc('empty')), null, 'пустой годен');
  assert.equal(checkImportDoc(clone(sceneDoc())), null, 'сцена с компонентом годна');
  // глубина: у доски 1, d0 — 2, d{k} — k+2
  assert.equal(checkImportDoc(chainDoc(MAX_DEPTH - 1)), null, 'ровно MAX_DEPTH — годен');
  for (const n of [MAX_DEPTH, 1000, 19000]) {
    const t0 = Date.now();
    const r = checkImportDoc(chainDoc(n));
    assert.equal(r && r.code, 'bad-doc', 'цепочка ' + n);
    assert.equal(r.limit, 'depth');
    assert.equal(r.max, MAX_DEPTH);
    assert.equal(r.id, 'd' + (MAX_DEPTH - 1));
    assert.ok(Date.now() - t0 < 10000, 'проверка линейная');
  }
  // createDoc по-прежнему открывает глубокий документ (прежние версии, SPEC §9.13) — это не импорт
  assert.ok(quiet(() => createDoc(chainDoc(1000))).nodes.d999);

  // циклы
  const cyc = clone(sceneDoc());
  cyc.nodes.card.parent = 't';
  cyc.nodes.t.parent = 'card';
  assert.match(checkImportDoc(cyc).message, /цикл/);
  const edge = clone(sceneDoc());
  edge.nodes.card.children.push('ab');
  assert.match(checkImportDoc(edge).message, /цикл/, 'ребро children на предка');
  const self = clone(sceneDoc());
  self.nodes.card.children.push('card');
  assert.match(checkImportDoc(self).message, /цикл/);

  // форма полей — как в checkNode
  const shape = [
    (d) => { d.nodes.t.style = { token: { toString: 1 } }; }, (d) => { d.nodes.t.style.token = ['x']; },
    (d) => { d.nodes.card.layout.mode = { toString: 1 }; }, (d) => { d.nodes.card.clip = 'yes'; },
    (d) => { d.nodes.t.characters = 5; }, (d) => { d.nodes.r.fill = { token: 3 }; }, (d) => { d.nodes.r.meta = { toString: 1 }; },
    (d) => { d.nodes.r.size = { w: { mode: 'fixed', value: 'x' }, h: { mode: 'hug' } }; }, (d) => { d.nodes.r.type = 'zzz'; },
    (d) => { d.nodes.r.id = 'other'; }, (d) => { d.tokens.colors.accent = { toString: 1 }; }, (d) => { d.tokens.type.body.font = 7; },
    (d) => { d.tokens.spacing = ['x']; }, (d) => { d.tokens = 'x'; }, (d) => { d.nodes.r = null; },
    (d) => { d.nodes[d.root].parent = 'ab'; }
  ];
  for (const f of shape) {
    const d = clone(sceneDoc());
    f(d);
    const r = checkImportDoc(d);
    assert.ok(r && r.code === 'bad-doc' && typeof r.message === 'string', f.toString() + ' → ' + JSON.stringify(r));
  }
  // предел узлов
  const big = chainDoc(10);
  assert.equal(checkImportDoc(big, { maxNodes: 5 }).limit, 'nodes');
  assert.ok(MAX_IMPORT_NODES >= 20000);
  // вход вне любых ожиданий — ответ, а не исключение
  for (const x of [null, 5, 'doc', [], {}, { nodes: [] }, { nodes: {}, root: 'x' }, { nodes: { a: 1 }, root: 'a' }]) {
    const r = checkImportDoc(x);
    assert.equal(r && r.code, 'bad-doc', JSON.stringify(x));
  }
  const trap = clone(sceneDoc());
  Object.defineProperty(trap.nodes.r, 'name', { enumerable: true, get() { throw new Error('ловушка'); } });
  assert.equal(quiet(() => checkImportDoc(trap)).message, 'документ не читается');
  // то, что вернул createDoc, — годный импорт (починка доводит до строгой схемы)
  const dirty = clone(sceneDoc());
  dirty.nodes.t.style = { token: { toString: 1 }, fontSize: 18 };
  dirty.nodes.card.clip = 1;
  dirty.nodes.r.role = 4;
  assert.ok(checkImportDoc(dirty));
  assert.equal(checkImportDoc(quiet(() => createDoc(dirty))), null);
});

test('круг29: сообщения об отказе не приводят чужое значение к строке', () => {
  const doc = sceneDoc();
  const E = { toString: 1 };
  const list = [
    { op: 'set', id: E, path: 'name', value: 'x' }, { op: 'remove', id: E }, { op: 'move', id: 't', parent: E },
    { op: 'move', id: E, parent: 'ab' }, { op: E }, { op: 'set', id: 't', path: E, value: 1 }, { op: 'setToken', path: [E], value: 1 },
    { op: 'create', node: { type: E, id: 'q', parent: 'ab' } }, { op: 'create', node: { type: 'rect', id: 'q', parent: E } },
    { op: 'create', node: { type: 'frame', id: 'q', parent: 'ab', children: [], layout: { mode: E } } }
  ];
  for (const op of list) {
    const r = quiet(() => applyOps(doc, [op]));
    assert.ok(r.error, JSON.stringify(op));
    assert.doesNotMatch(r.error.message, /негодное значение/, 'причина названа, а не «исключение»: ' + r.error.message);
  }
});
