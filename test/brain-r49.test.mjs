/**
 * Круг 49 (SPEC §16): фактуры на стороне агента — pattern(…) в дереве и правках.
 * Плюс долги круга 48 по замечаниям критиков: $theme только от арт-директора, имя экрана,
 * снятие темы, слова о теме в истории, контраст темы экрана.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand, themeToOps, treeToOps, describeChange, artPattern, applyDirection, normalizeDirection } from '../src/brain.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const empty = () => quiet(() => core.createDoc());

function fake(script) {
  const calls = [];
  return {
    name: 'fake', calls,
    async ready() { return true; },
    async complete(messages, schema) {
      const name = schema && schema.name;
      calls.push({ schema: name, messages });
      let v = script[name];
      if (Array.isArray(v)) v = v.shift();
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}

function twoScreens() {
  const doc = empty();
  const mk = (id, name, x) => [
    core.ops.create({ id, type: 'frame', name, parent: doc.root, pos: { x, y: 0 }, size: { w: { mode: 'fixed', value: 320 }, h: { mode: 'hug' } }, fill: 'canvas',
      layout: { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 }, align: 'stretch', justify: 'start', wrap: false }, children: [] }),
    core.ops.create({ id: id + '_t', type: 'text', name: 'Заголовок ' + name, parent: id, characters: name, style: 'title', color: 'text', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
  ];
  return core.applyOps(doc, [...mk('sum', 'Сводка', 0), ...mk('pay', 'Оплата', 400)]).doc;
}

test('круг49: pattern(…) словами модели — фактура ядра', () => {
  const doc = empty();
  const p = artPattern('pattern(dots, accent, 12, canvas)', { doc }).pattern;
  assert.equal(p.kind, 'dots');
  assert.equal(p.size, 12);
  assert.ok(p.color && p.bg);
  assert.equal(core.patternProblem(p, 'fill'), null);
  assert.equal(artPattern('pattern(горошек, accent)', { doc }).pattern.kind, 'dots', 'русские имена видов');
  assert.equal(artPattern('pattern(звёзды, accent)', { doc }), undefined, 'неизвестный вид — не фактура');
  assert.equal(artPattern('#ff0000', { doc }), undefined);
});

test('круг49: фактура в дереве ложится заливкой слоя', () => {
  const doc = empty();
  const tree = { type: 'frame', name: 'Карточка', fill: 'pattern(lines, line, 8, surface, angle=45)', children: [{ type: 'text', text: 'Привет', style: 'body' }] };
  const { ops } = treeToOps({ doc, tree, parentId: doc.root, engine: core, warn: () => {}, asArtboard: true });
  const root = ops.find((o) => o.op === 'create' && o.node.name === 'Карточка');
  assert.ok(root.node.fill && root.node.fill.pattern, JSON.stringify(root.node.fill));
  assert.equal(root.node.fill.pattern.kind, 'lines');
  assert.equal(root.node.fill.pattern.angle, 45);
  const r = core.applyOps(doc, ops);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
});

test('круг48 (долг): $theme от модели не принимается — только тема арт-директора', () => {
  const doc = empty();
  const tree = { type: 'frame', name: 'Экран', $theme: { colors: { canvas: '#000000' } }, children: [{ type: 'text', text: 'x', style: 'body' }] };
  const { ops } = treeToOps({ doc, tree, parentId: doc.root, engine: core, warn: () => {}, asArtboard: true });
  assert.equal(ops[0].node.theme, undefined, 'тема из ответа модели снята');
  const dir = normalizeDirection({
    concept: 'Ночь', mood: ['тихо'], palette: { bg: '#15171c', surface: '#20242c', text: '#f2f4f7', muted: '#9aa3b2', accent: '#c6ff3d', accent2: '#ff4f6d' },
    fonts: { display: 'Russo One', text: 'Exo 2' },
  });
  const dressed = applyDirection(clone(tree), dir, doc, { asArtboard: true });
  const { ops: ops2 } = treeToOps({ doc, tree: dressed.tree, parentId: doc.root, engine: core, warn: () => {}, asArtboard: true });
  assert.ok(ops2[0].node.theme && ops2[0].node.theme.colors.canvas, 'тема арт-директора — на доске');
});

test('круг48 (долг): экран по имени, снятие темы словами, отказ на выделении двух экранов', async () => {
  const doc = twoScreens();
  const named = themeToOps({ doc, theme: { board: true, boardName: 'экран «Оплата»', colors: [{ name: 'canvas', value: '#101418' }, { name: 'text', value: '#e8eaf0' }] }, engine: core, warn: () => {} });
  assert.deepEqual(named.map((o) => [o.id, o.path]), [['pay', 'theme']]);
  assert.throws(() => themeToOps({ doc, theme: { board: true, boardName: 'Профиль', colors: [{ name: 'canvas', value: '#101418' }] }, engine: core, warn: () => {} }), /Экран «Профиль» не найден/);
  assert.throws(() => themeToOps({ doc, theme: { board: true, colors: [{ name: 'canvas', value: '#101418' }] }, engine: core, warn: () => {}, scope: { ids: ['sum_t', 'pay_t'] } }), /нескольких экранах/);
  const after = core.applyOps(doc, named).doc;
  // слова истории
  assert.match(describeChange(named, doc, after, core), /^Своя тема экрана «Оплата»: .*#101418/);
  const reset = themeToOps({ doc: after, theme: { board: true, reset: true }, engine: core, warn: () => {}, scope: { ids: ['pay'] } });
  assert.match(describeChange(reset, after, null, core), /Экран «Оплата» вернулся к оформлению документа/);
  // «верни экрану общее оформление» через весь конвейер: ответ без списков — тоже правка
  const provider = fake({ plan: { intent: 'theme', title: 'Общее оформление', summary: 'Верну', steps: ['Тема'] }, theme: { board: true, reset: true } });
  const res = await runCommand({ doc: after, selection: ['pay_t'], utterance: 'верни этому экрану общее оформление', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => [o.op, o.id, o.path]), [['set', 'pay', 'theme']]);
  assert.equal(res.preview.doc.nodes.pay.theme, undefined);
});

test('круг48 (долг): тёмный фон без светлого текста — предупреждение о контрасте, кегль — пропущен понятными словами', () => {
  const doc = twoScreens();
  const said = [];
  themeToOps({ doc, theme: { board: true, colors: [{ name: 'canvas', value: '#101418' }], type: [{ name: 'title', fontSize: 40 }, { name: 'body', font: 'Prata' }] }, engine: core, warn: (w) => said.push(w), scope: { ids: ['pay'] } });
  const all = said.join(' | ');
  assert.match(all, /На экране «Оплата» текст на фоне читается плохо: контраст/);
  assert.match(all, /кегль — общее для документа, пропущено/);
});
