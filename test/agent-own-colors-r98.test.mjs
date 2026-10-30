/**
 * Круг 98 (SPEC §15.32): агент и свои цвета человека. Цвета палитры, которых нет среди ролей (их заводят
 * шторкой «Цвета документа», §15.30), — фирменные: модель видит их отдельной строкой, арт-директор —
 * отдельным блоком, а код, равный ровно одному такому цвету, ложится ссылкой на него.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand, describeTokens, ownColors, coerceValue, mentionsColor, namedColorCount } from '../src/brain.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
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
      if (typeof v === 'function') v = v(messages, calls);
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}
const withBrand = (extra = {}) => {
  const d = quiet(() => core.createDoc());
  return core.applyOps(d, [core.ops.setToken('colors.brand', '#7A5CFF'), ...Object.entries(extra).map(([k, v]) => core.ops.setToken(`colors.${k}`, v))]).doc;
};
const sys = (call) => String((call.messages.find((m) => m.role === 'system') || {}).content || '');
const byName = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name);

test('круг98: свои цвета — не роли, только у палитры из ролей; в выжимке токенов — отдельной строкой', () => {
  const d = withBrand({ 'brand-2': '#ffcc00', weird: 'rgba(0,0,0,.5)' });
  assert.deepEqual(ownColors(d), [['brand', '#7a5cff'], ['brand-2', '#ffcc00']]);
  const t = describeTokens(d);
  assert.match(t, /свои цвета человека \(brand, brand-2\): это не роли палитры/);
  assert.doesNotMatch(t, /фирменный — brand\)/, 'два своих — «фирменный» не один');
  assert.match(describeTokens(withBrand()), /\(фирменный — brand\)/);
  assert.doesNotMatch(describeTokens(quiet(() => core.createDoc())), /свои цвета/, 'без своих — строки нет');
  // старая палитра без ролей (bg, ink…) — свои не выделяются
  const legacy = { tokens: { colors: { bg: '#ffffff', ink: '#111111' } } };
  assert.deepEqual(ownColors(legacy), []);
});

test('круг98: код, равный ровно одному своему цвету, — ссылка на него; роли и два одинаковых — код', () => {
  const d = withBrand();
  assert.equal(coerceValue('#7A5CFF', 'fill', d), 'brand');
  assert.equal(coerceValue('#ff6b3d', 'fill', d), '#ff6b3d', 'код акцента-роли — как был');
  const twins = withBrand({ brand2: '#7a5cff' });
  assert.equal(coerceValue('#7a5cff', 'fill', twins), '#7a5cff', 'два своих с этим кодом — не угадываем');
});

const PLAN = { intent: 'create', title: 'Экран акции', summary: 'Соберу экран акции', steps: ['Шапка'] };
const DIRECTION = {
  concept: 'Фирменный лоток: фиолетовая лента, белая бумага', mood: ['ярко'],
  materials: [{ name: 'лента', hex: '#7a5cff' }, { name: 'бумага', hex: '#fbfaff' }],
  palette: { bg: '#fbfaff', surface: '#ffffff', text: '#1b1530', muted: '#5d5675', accent: '#ff3d7f', accent2: '#ffb020' },
  fonts: { display: 'Exo 2', text: 'Exo 2' }, motifs: ['лента'], composition: 'крупная шапка', avoid: ['серое'],
};
const TREE = {
  type: 'frame', name: 'Акция', size: { w: 390, h: 'hug' }, layout: { mode: 'column', gap: 16, padding: 24 },
  children: [
    { type: 'text', name: 'Заголовок', text: 'Неделя скидок', style: 'display' },
    { type: 'frame', name: 'Плашка', fill: '#7A5CFF', layout: { mode: 'row', padding: 12 }, children: [{ type: 'text', name: 'Надпись', text: '−30%', style: 'body' }] },
  ],
};

test('круг98: арт-директор видит фирменные цвета; слой фирменным кодом — ссылкой на свой цвет', async () => {
  const doc = withBrand();
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран акции в фирменном цвете', provider, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const dir = provider.calls.find((c) => c.schema === 'direction');
  assert.match(sys(dir), /ФИРМЕННЫЕ ЦВЕТА ДОКУМЕНТА[^\n]*\n- brand #7a5cff/);
  const tree = provider.calls.find((c) => c.schema === 'tree');
  assert.match(sys(tree), /свои цвета человека \(brand\)/);
  const after = res.preview.doc;
  assert.equal(byName(after, 'Плашка').fill, 'brand', 'правка цвета в палитре потом перекрасит плашку');
  assert.equal(core.resolveColor(core.docAt(after, byName(after, 'Плашка').id), 'brand'), '#7a5cff');
});

test('круг98: без своих цветов — блока у арт-директора нет', async () => {
  const doc = quiet(() => core.createDoc());
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран акции', provider, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.doesNotMatch(sys(provider.calls.find((c) => c.schema === 'direction')), /ФИРМЕННЫЕ ЦВЕТА/);
});

test('круг98: свой цвет совпал с акцентом решения — на новой доске одна ссылка, на роль темы', async () => {
  const doc = withBrand();
  const dir = { ...DIRECTION, palette: { ...DIRECTION.palette, accent: '#7a5cff' } };
  const tree = { ...TREE, children: [...TREE.children, { type: 'frame', name: 'Полоса', fill: 'accent', size: { w: 'fill', h: 4 } }] };
  const provider = fake({ plan: PLAN, direction: dir, tree });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран акции в фирменном цвете', provider, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  assert.equal(byName(after, 'Плашка').fill, 'accent', 'код — как роль темы, не вперемешку с brand');
  assert.equal(byName(after, 'Полоса').fill, 'accent');
});

test('круг98: служебные имена — не свои; код роли и имя из темы экрана — код как был', () => {
  const d = withBrand({ danger: '#d33d3d', primary: '#123456' });
  assert.deepEqual(ownColors(d), [['brand', '#7a5cff']], 'danger/primary заводит и агент — не фирменные');
  const asAccent = withBrand();
  const accent = asAccent.tokens.colors.accent;
  const same = core.applyOps(asAccent, [core.ops.setToken('colors.brand', accent)]).doc;
  assert.equal(coerceValue(accent, 'fill', same), accent.toLowerCase(), 'свой цвет = роль — не связываем');
  const board = Object.values(d.nodes).find((n) => n && n.type === 'frame') || null;
  if (board) {
    const themed = core.applyOps(d, [core.ops.set(board.id, 'theme', { colors: { brand: '#9f88ff' } })]).doc;
    assert.ok(themed.nodes[board.id].theme, 'тема легла');
    assert.equal(coerceValue('#7a5cff', 'fill', themed), '#7a5cff', 'тема экрана переопределяет brand — ссылка соврала бы');
  }
});

test('круг98: «фирменный» — про цвет, кроме шрифта и логотипа; имена с дефисом; «фирменных цветах» — все свои', () => {
  const d = withBrand({ 'brand-2': '#ffcc00' });
  assert.equal(mentionsColor('сделай кнопку в фирменном', d), true);
  assert.equal(mentionsColor('поставь фирменный шрифт', d), false);
  assert.equal(mentionsColor('поставь фирменный логотип', d), false);
  assert.equal(mentionsColor('покрась в Brand-2', d), true);
  assert.equal(namedColorCount('собери в фирменных цветах', d), 2);
  assert.equal(namedColorCount('покрась в brand-2', d), 1);
  assert.equal(mentionsColor('сделай в фирменном', quiet(() => core.createDoc())), false, 'своих нет — не цвет');
});
