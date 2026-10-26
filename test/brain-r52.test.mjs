/**
 * Круг 52 (SPEC §19): второй взгляд критика. Доработку, сделанную по снимку, критик смотрит ещё раз;
 * остаётся она, только если стала лучше. Второго взгляда нет — доработка остаётся, итог честно говорит
 * «не перепроверил». Доработка — по-прежнему одна. Модель поддельная, движок — core.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand, recheckVerdict, BrainError, RECHECK_STEP } from '../src/brain.js';
import { artSummary } from '../src/shell.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

/** Поддельная модель: ответы по имени схемы, массив — по очереди, функция — от реплик. */
function fake(script, extra = {}) {
  const calls = [];
  return {
    name: 'fake', calls, ...extra,
    async ready() { return true; },
    async complete(messages, schema, opts = {}) {
      const name = schema && schema.name;
      calls.push({ schema: name, messages, opts, entry: schema });
      let v = script[name];
      if (Array.isArray(v)) v = v.shift();
      if (typeof v === 'function') v = v(messages, calls);
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}

const PLAN = { intent: 'create', title: 'Экран кофейни', summary: 'Соберу экран меню кофейни', steps: ['Шапка', 'Меню'] };
const DIRECTION = {
  concept: 'Утренняя кофейня: крафтовый пакет, эмалированная кружка, мел на доске',
  mood: ['тепло', 'неторопливо', 'ремесленно'],
  materials: [{ name: 'крафт-бумага', hex: '#c9a77c' }, { name: 'эспрессо', hex: '#3b2418' }, { name: 'молочная пенка', hex: '#f4ead8' }, { name: 'эмаль', hex: '#2f6f62' }],
  palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' },
  fonts: { display: 'Prata', text: 'Golos Text' },
  motifs: ['круглый штамп с надписью', 'крупные цифры цены', 'зерно кофе иллюстрацией'],
  composition: 'асимметрия: крупный заголовок слева, меню колонкой справа, цены выносом',
  avoid: ['белые карточки в ряд', 'синий акцент'],
};
const TREE = {
  type: 'frame', name: 'Кофейня', size: { w: 390, h: 'hug' },
  layout: { mode: 'column', gap: 16, padding: 24 },
  children: [
    { type: 'text', name: 'Заголовок', text: 'Утро в Зерне', style: 'display' },
    { type: 'text', name: 'Подзаголовок', text: 'Обжариваем сами, по четвергам', style: 'body' },
    { type: 'frame', name: 'Позиция', layout: { mode: 'row', gap: 8 }, fill: '#fffaf1', children: [
      { type: 'text', name: 'Название', text: 'Флэт уайт', style: 'heading' },
      { type: 'text', name: 'Цена', text: '240 ₽', style: 'title', color: '#2f6f62' },
    ] },
  ],
};
const TREE_BETTER = clone(TREE);
TREE_BETTER.children.unshift({ type: 'ellipse', name: 'Штамп', size: { w: 96, h: 96 }, fill: '#2f6f62', rotate: -12 });
const CRIT_BAD = { score: 4, generic: true, verdict: 'revise', issues: ['Шапка — просто текст по левому краю, без образа'], fixes: ['Добавить круглый штамп «с 2019» поворотом -12°'] };
const CRIT_OK = { score: 8.5, generic: false, verdict: 'ok', issues: [], fixes: [], praise: 'Палитра крафта читается' };
const PNG = { mime: 'image/png', data: 'iVBORw0KGgo=', width: 390, height: 600 };

function empty() {
  const doc = quiet(() => core.createDoc());
  return doc;
}
const byName = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name);
const run = (provider, extra = {}) => runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render: async () => PNG, ...extra });

test('круг52: recheckVerdict — лучше, то же (в пределах шума), хуже, не перепроверено', () => {
  assert.equal(RECHECK_STEP, 1);
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 5 }), 'better');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 4, verdict: 'ok' }), 'better', 'та же оценка, но критик доволен');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 4 }), 'same', 'та же оценка — шум, доработка остаётся');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 4.5 }), 'same');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 3.5 }), 'same', 'падение меньше шага — не повод откатывать');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 3.5, verdict: 'ok' }), 'better');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 3 }), 'worse');
  assert.equal(recheckVerdict(CRIT_BAD, { ...CRIT_BAD, score: 3, verdict: 'ok' }), 'worse', 'на шаг ниже — хуже, даже если доволен');
  assert.equal(recheckVerdict(CRIT_BAD, null), 'unchecked');
  assert.equal(recheckVerdict(CRIT_BAD, { score: null }), 'unchecked');
});

test('круг52: доработка вышла хуже — остаётся первая сборка, итог называет обе оценки', async () => {
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER], critique: [CRIT_BAD, { ...CRIT_BAD, score: 3 }] }, { vision: true });
  const stages = [];
  const res = await run(provider, { onStage: (x) => stages.push(x) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(byName(res.preview.doc, 'Штамп'), undefined, 'первая сборка, без доработки');
  assert.notEqual(res.critique.revised, true);
  assert.equal(res.critique.recheck, 'worse');
  assert.equal(res.critique.after.score, 3);
  assert.ok(res.serviceNotes.some((n) => /не стала лучше \(4 → 3 из 10\)/.test(n)));
  assert.equal(artSummary(res.direction, res.critique).verdict, 'Взгляд со стороны: 4 из 10, доработка вышла не лучше (3 из 10) — оставил первую сборку');
  assert.ok(stages.some((x) => x.stage === 'critic' && /оставляю первую сборку/.test(x.detail || '')), 'ход команды говорит, чем кончилось');
  // второй взгляд — со снимком доработки, тем же промптом
  const second = provider.calls.filter((c) => c.schema === 'critique')[1];
  assert.ok(Array.isArray(second.messages[1].content));
  assert.match(second.messages[0].content, /СЛОИ МАКЕТА[\s\S]*Штамп/, 'критик смотрит именно доработку');
});

test('круг52: второго взгляда нет (сеть, снимок, без оценки) — доработка остаётся, «не перепроверил»', async () => {
  const cases = [
    { critique: [CRIT_BAD, new BrainError('network', 'Нет связи')], note: /^Критик не посмотрел на доработку: Нет связи/ },
    { critique: [CRIT_BAD, { score: 'нет' }], note: /^Критик не оценил доработку$/ },
    { critique: [CRIT_BAD], shots: [PNG, null], note: /^Снимка доработки нет/ },
    { critique: [CRIT_BAD], shots: [PNG, new Error('canvas')], note: /^Снимок доски для самопроверки не получился: canvas/ },
  ];
  for (const c of cases) {
    const shots = c.shots ? c.shots.slice() : null;
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER], critique: c.critique }, { vision: true });
    const stages = [];
    const render = shots ? async () => { const v = shots.shift(); if (v instanceof Error) throw v; return v; } : undefined;
    const res = await run(provider, { onStage: (x) => stages.push(x), ...(render ? { render } : {}) });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.ok(res.serviceNotes.some((n) => c.note.test(n)), res.serviceNotes.join(' | '));
    assert.ok(!res.serviceNotes.some((n) => /самопроверка по приметам/.test(n)), 'приметами второй взгляд не подменяется');
    assert.ok(stages.some((x) => x.stage === 'critic' && /не перепроверил/.test(x.detail || '')));
    assert.ok(byName(res.preview.doc, 'Штамп'), 'доработка на макете');
    assert.equal(res.critique.revised, true);
    assert.equal(res.critique.recheck, 'unchecked');
    assert.equal(res.critique.seen, 'image', 'первая оценка не подменена приметами');
    assert.match(artSummary(res.direction, res.critique).verdict, /→ доработал: .* \(доработку не перепроверил\)$/);
    assert.equal(provider.calls.filter((c2) => c2.schema === 'tree').length, 2, 'вторая доработка не просится');
  }
});

test('круг52: доработка по приметам (без зрения) — второго вызова критика нет, как раньше', async () => {
  const plain = { type: 'frame', name: 'Плоско', children: [
    { type: 'text', name: 'А', text: 'Один', style: 'body', align: 'center' }, { type: 'text', name: 'Б', text: 'Два', style: 'body', align: 'center' },
    { type: 'text', name: 'В', text: 'Три', style: 'body', align: 'center' }, { type: 'text', name: 'Г', text: 'Четыре', style: 'body', align: 'center' },
  ] };
  const better = { ...clone(plain), children: [...clone(plain).children.map((c) => ({ ...c, align: 'left' })), { type: 'ellipse', name: 'Пятно', size: { w: 40, h: 40 }, fill: '#ff0000' }] };
  const provider = fake({ plan: PLAN, tree: [plain, better] });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, direction: false });
  assert.equal(res.critique.revised, true);
  assert.equal(res.critique.recheck, undefined);
  assert.equal(provider.calls.filter((c) => c.schema === 'critique').length, 0);
});

test('круг52: старый сервер (без after/recheck) — итог как в круге 47', () => {
  assert.equal(artSummary(null, { ...CRIT_BAD, seen: 'image', revised: true }).verdict, 'Первая сборка — 4 из 10 → доработал: шапка — просто текст по левому краю, без образа');
  assert.equal(artSummary(null, { ...CRIT_BAD, seen: 'image', recheck: 'worse', after: { score: 'x' } }).verdict, 'Взгляд со стороны: 4 из 10, доработка не легла — оставил собранное');
});

test('круг52: та же оценка — доработка остаётся; критик доволен — так и сказано', async () => {
  for (const [second, want] of [[{ ...CRIT_BAD }, /^Первая сборка — 4 из 10 → доработал, оценка та же: шапка/],
    [{ ...CRIT_OK, score: 4 }, /^Первая сборка — 4 из 10 → доработал, критик доволен: шапка/]]) {
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER], critique: [CRIT_BAD, second] }, { vision: true });
    const res = await run(provider);
    assert.ok(byName(res.preview.doc, 'Штамп'));
    assert.equal(res.critique.revised, true);
    assert.match(artSummary(res.direction, res.critique).verdict, want);
  }
});

test('круг52: отмена во время второго взгляда — команда отменена, без лишних вызовов', async () => {
  const ctrl = new AbortController();
  let shots = 0;
  const render = async () => { shots++; if (shots === 2) { ctrl.abort(); await new Promise((r) => setTimeout(r, 5)); } return PNG; };
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER], critique: [CRIT_BAD, CRIT_OK] }, { vision: true });
  const res = await run(provider, { render, signal: ctrl.signal }).catch((e) => ({ thrown: e }));
  const kind = res.thrown ? res.thrown.kind : res.error && res.error.kind;
  assert.equal(kind, 'cancelled', JSON.stringify(res.error || res.thrown));
  assert.equal(provider.calls.filter((c) => c.schema === 'critique').length, 1, 'второй вызов критика не ушёл');
});
