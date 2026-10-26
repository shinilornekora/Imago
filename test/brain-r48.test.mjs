/**
 * Круг 48 (SPEC §15): тема доски на стороне агента. Решение арт-директора новой доски — её темой
 * (узлы держат токены); «сделай только этот экран тёмным» — тема этой доски вместо отказа.
 * Модель поддельная, движок — core.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand, normalizeDirection, applyDirection, directionTheme, themeToOps, templateSignals, PROMPTS, SCHEMAS } from '../src/brain.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

function fake(script, extra = {}) {
  const calls = [];
  return {
    name: 'fake', calls, ...extra,
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

const PLAN = { intent: 'create', title: 'Экран тренировок', summary: 'Соберу экран тренировок', steps: ['Шапка'] };
const DIRECTION = {
  concept: 'Ночная беговая дорожка: светоотражатель, табло секундомера, мокрый асфальт',
  mood: ['собранно', 'ночь'],
  materials: [{ name: 'асфальт', hex: '#15171c' }, { name: 'светоотражатель', hex: '#c6ff3d' }],
  palette: { bg: '#15171c', surface: '#20242c', text: '#f2f4f7', muted: '#9aa3b2', accent: '#c6ff3d', accent2: '#ff4f6d' },
  fonts: { display: 'Russo One', text: 'Exo 2' },
  motifs: ['полоса разметки'], composition: 'табло слева', avoid: ['белые карточки'],
};
const TREE = {
  type: 'frame', name: 'Тренировки', size: { w: 390, h: 'hug' }, layout: { mode: 'column', gap: 16, padding: 24 },
  children: [
    { type: 'text', name: 'Заголовок', text: 'Темп недели', style: 'display' },
    { type: 'text', name: 'Подпись', text: 'за семь дней', style: 'caption', color: 'muted' },
    { type: 'frame', name: 'Кнопка', fill: '#c6ff3d', layout: { mode: 'row', padding: 12 }, children: [{ type: 'text', name: 'Надпись', text: 'Старт', style: 'body' }] },
    { type: 'rect', name: 'Разметка', size: { w: 'fill', h: 4 }, fill: 'primary', rotate: -3 },
  ],
};
const empty = () => quiet(() => core.createDoc());
const byName = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name);
const boards = (doc) => Object.values(doc.nodes).filter((n) => n && n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
const seen = (doc, n, k) => core.resolveColor(core.docAt(doc, n.id), n[k]);

test('круг48: решение арт-директора — темой новой доски, слои — токенами документа', async () => {
  const doc = empty();
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тренировок', provider, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const board = Object.values(after.nodes).find((n) => n.name === 'Тренировки' && n.parent === after.root);
  assert.ok(board.theme, 'у доски своя тема');
  assert.equal(core.themeProblem(board.theme), null, 'тема по форме ядра');
  assert.equal(board.theme.colors.canvas, '#15171c');
  assert.equal(board.theme.colors.onAccent, res.direction.palette.onAccent);
  assert.equal(board.theme.type.display.font, 'Russo One');
  assert.equal(board.theme.type.body.font, 'Exo 2');
  // слои — токенами: доску перекрашивает тема
  assert.equal(board.fill, 'canvas');
  assert.equal(byName(after, 'Кнопка').fill, 'accent', '#c6ff3d палитры — её токен');
  assert.equal(byName(after, 'Разметка').fill, 'accent', 'имя-привычка primary — токен документа');
  assert.equal(byName(after, 'Надпись').color, 'onAccent');
  assert.equal(seen(after, byName(after, 'Надпись'), 'color'), res.direction.palette.onAccent);
  assert.equal(core.resolveTextStyle(core.docAt(after, byName(after, 'Заголовок').id), byName(after, 'Заголовок')).font, 'Russo One');
  assert.equal(byName(after, 'Заголовок').style, 'display', 'без переопределения шрифта');
  // проверка видит тему: тёмный текст не считается нечитаемым
  const issues = core.validate(after, core.solve(after));
  assert.ok(!issues.some((i) => i.code === 'low-contrast'), JSON.stringify(issues.filter((i) => i.code === 'low-contrast')));
  // в самом create — тема и решение; журнал = экран
  const create = res.ops.find((o) => o.op === 'create' && o.node.id === board.id);
  assert.deepEqual(create.node.theme, board.theme);
  assert.ok(create.node.direction);
  assert.deepEqual(core.applyOps(doc, res.ops).doc.nodes[board.id].theme, board.theme);
  // приметы шаблона считаются по теме: шрифт решения стоит, цвета решения использованы
  const sig = templateSignals(core, after, board.id, { dir: res.direction });
  assert.ok(!sig.some((s) => /шрифтом по умолчанию|Шрифт заголовков из решения|Цвета решения/.test(s)), sig.join(' | '));
});

test('круг48: тема по решению — роли палитры на токены документа, «капризный» акцидентный — самому крупному стилю', () => {
  const doc = empty();
  const d = normalizeDirection(DIRECTION);
  const t = directionTheme(d, doc);
  for (const [name, role] of [['canvas', 'bg'], ['surface', 'surface'], ['surfaceAlt', 'surface'], ['text', 'text'], ['muted', 'muted'], ['line', 'muted'], ['accent', 'accent'], ['accentSoft', 'accent2'], ['onAccent', 'onAccent']]) {
    assert.equal(t.colors[name], d.palette[role], name);
  }
  assert.equal(t.colors.agent, undefined, 'служебные цвета приложения тема не трогает');
  assert.equal(t.type.mono, undefined, 'моно — как в документе');
  assert.equal(t.type.heading.font, 'Exo 2');
  assert.ok(t.type.heading.fontWeight === undefined || t.type.heading.fontWeight >= 600, 'heading — жирным текстом');
  const script = normalizeDirection({ concept: 'Пляж', fonts: { display: 'Pacifico', text: 'Nunito' } });
  const big = directionTheme(script, doc, { biggest: 34 });
  assert.equal(big.type.display.font, 'Pacifico');
  assert.equal(big.type.title.font, 'Nunito', 'рукописный — не на втором по величине стиле');
  // вставка не новой доской — темы нет
  const flat = applyDirection(TREE, d, doc, { asArtboard: false });
  assert.equal(flat.theme, null);
  assert.equal(flat.tree.children[2].fill, '#c6ff3d');
  // $theme от модели в глубине дерева — снимается
  const sneaky = clone(TREE);
  sneaky.children[2].$theme = { colors: { text: '#000000' } };
  const r = applyDirection(sneaky, d, doc, { asArtboard: true });
  assert.equal(r.tree.children[2].$theme, undefined);
  assert.deepEqual(r.tree.$theme, r.theme);
});

/** Документ с двумя досками: «Сводка» и «Оплата». */
function twoScreens() {
  let doc = empty();
  const mk = (id, name, x) => [
    core.ops.create({ id, type: 'frame', name, parent: doc.root, pos: { x, y: 0 }, size: { w: { mode: 'fixed', value: 320 }, h: { mode: 'hug' } }, fill: 'canvas',
      layout: { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 }, align: 'stretch', justify: 'start', wrap: false }, children: [] }),
    core.ops.create({ id: id + '_t', type: 'text', name: 'Заголовок ' + name, parent: id, characters: name, style: 'title', color: 'text', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
  ];
  return core.applyOps(doc, [...mk('sum', 'Сводка', 0), ...mk('pay', 'Оплата', 400)]).doc;
}

test('круг48: «сделай только этот экран тёмным» — тема этой доски, остальные не тронуты', async () => {
  const doc = twoScreens();
  const theme = { board: true, summary: 'Тёмная оплата', colors: [{ name: 'canvas', value: '#101418' }, { name: 'text', value: '#E8EAF0' }, { name: 'nope', value: '#000' }],
    type: [{ name: 'title', font: 'Prata', fontSize: 40 }] };
  const provider = fake({ plan: { intent: 'theme', title: 'Тёмная оплата', summary: 'Тёмная', steps: ['Цвета'] }, theme });
  const res = await runCommand({ doc, selection: ['pay_t'], utterance: 'сделай только этот экран тёмным', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => [o.op, o.id, o.path]), [['set', 'pay', 'theme']]);
  const after = res.preview.doc;
  assert.deepEqual(after.nodes.pay.theme, { colors: { canvas: '#101418', text: '#e8eaf0' }, type: { title: { font: 'Prata' } } });
  assert.equal(after.nodes.sum.theme, undefined);
  assert.equal(seen(after, after.nodes.pay_t, 'color'), '#e8eaf0');
  assert.equal(seen(after, after.nodes.sum_t, 'color'), core.resolveColor(doc, 'text'), 'соседняя доска — в оформлении документа');
  assert.deepEqual(after.tokens, doc.tokens, 'токены документа не тронуты');
  const all = res.warnings.join(' | ');
  assert.match(all, /«nope»: такого токена в документе нет/);
  assert.match(all, /свои только цвета и шрифты: кегль/);
  assert.doesNotMatch(all, /поменялись ВСЕ доски/);
  // в промптах — тема доски в выжимке и правило board:true
  assert.match(provider.calls[1].messages[0].content, /board:true/);
  // повтор поверх — новая тема на основе прежней; сброс — снимает
  const again = themeToOps({ doc: after, theme: { board: true, colors: [{ name: 'accent', value: '#ff4f6d' }] }, engine: core, warn: () => {}, scope: { ids: ['pay_t'] } });
  assert.deepEqual(again[0].value.colors, { canvas: '#101418', text: '#e8eaf0', accent: '#ff4f6d' });
  const reset = themeToOps({ doc: after, theme: { board: true, reset: true }, engine: core, warn: () => {}, scope: { ids: ['pay'] } });
  assert.equal(reset[0].path, 'theme');
  assert.equal(reset[0].value, undefined);
  assert.throws(() => themeToOps({ doc, theme: { board: true, reset: true }, engine: core, warn: () => {}, scope: { ids: ['sum'] } }), /своей темы и так нет/);
  // доска непонятна (две доски, ничего не выделено) — честный отказ, а не перекраска всего
  assert.throws(() => themeToOps({ doc, theme: { board: true, colors: [{ name: 'text', value: '#000000' }] }, engine: core, warn: () => {} }), /непонятно, какого/);
});

test('круг48: выжимка печатает тему доски, тема документа говорит о досках в своей теме', async () => {
  const doc = core.applyOps(twoScreens(), [core.ops.set('pay', 'theme', { colors: { canvas: '#101418' }, type: { title: { font: 'Prata' } } })]).doc;
  const provider = fake({ plan: { intent: 'theme', title: 'Шрифт', summary: 'Цвет', steps: ['Цвета'] }, theme: { colors: [{ name: 'text', value: '#222222' }] } });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай текст темнее', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const sys = provider.calls[0].messages[0].content;
  assert.match(sys, /тема\{canvas=#101418 title=Prata\}/);
  assert.match(sys, /«тема\{…\}» у доски/);
  const all = res.warnings.join(' | ');
  assert.match(all, /«Оплата» собран в собственной палитре/);
  assert.match(all, /сделай только этот экран/);
  assert.ok(SCHEMAS.theme.schema.properties.board, 'в схеме тематизатора есть board');
  assert.match(PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'всё' }), /СВОЯ ТЕМА/);
});
