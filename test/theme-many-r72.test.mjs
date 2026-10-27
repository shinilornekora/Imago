/**
 * Круг 72 (SPEC §15.9): та же правка темы нескольким экранам — списком имён (boardNames) или
 * выделением на нескольких досках; каждому — по его теме (пути, если тема уже есть); отказ одного
 * экрана — заметкой, а не отказом всей команды; в итоге одинаковое — одной фразой.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeToOps, runCommand, SCHEMAS, PROMPTS } from '../src/brain.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens() {
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x, theme, role) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', ...(theme ? { theme } : {}), ...(role ? { role } : {}), children: [] });
  const r = core.applyOps(base, [
    mk('pay', 'Оплата', 0, { colors: { canvas: '#101418', text: '#e8eaf0' } }),
    mk('sum', 'Итог', 400, null),
    mk('plain', 'Профиль', 800, null),
    core.ops.create({ id: 'pay_t', type: 'text', name: 'Цена', parent: 'pay', characters: '1 990 ₽', style: 'title' }),
    core.ops.create({ id: 'sum_t', type: 'text', name: 'Сумма', parent: 'sum', characters: '1 990 ₽', style: 'title' }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const run = (doc, theme, ids = [], notes = []) => themeToOps({ doc, theme: { board: true, ...theme }, engine: core, warn: (m) => notes.push(m), scope: { ids } });
const ACCENT = [{ name: 'accent', value: '#FF4F6D' }];

test('круг72: boardNames — правка каждому экрану: пути у своей темы, целая тема у прочих', () => {
  const doc = screens();
  const ops = run(doc, { boardNames: ['Оплата', 'экран «Итог»'], colors: ACCENT });
  assert.deepEqual(ops.map((o) => [o.id, o.path, o.value]), [
    ['pay', 'theme.colors.accent', '#ff4f6d'],
    ['sum', 'theme', { colors: { accent: '#ff4f6d' } }],
  ]);
  const after = core.applyOps(doc, ops).doc;
  assert.equal(after.nodes.pay.theme.colors.canvas, '#101418', 'своя тема «Оплаты» не затёрта');
  assert.equal(after.nodes.plain.theme, undefined, 'неназванный экран не тронут');
  // boardName и boardNames вместе, повтор имени — по разу
  assert.equal(run(doc, { boardName: 'Итог', boardNames: ['итог', 'Профиль', 'Итог'], colors: ACCENT }).length, 2);
  assert.ok(SCHEMAS.theme.schema.properties.boardNames);
  assert.match(PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'всё' }), /boardNames/);
});

test('круг72: выделение на нескольких экранах — правка каждому (раньше — отказ)', () => {
  const doc = screens();
  const ops = run(doc, { colors: ACCENT }, ['pay_t', 'sum_t']);
  assert.deepEqual(ops.map((o) => o.id), ['pay', 'sum']);
  // сброс двум экранам: у одного темы нет — он пропущен заметкой, второй сброшен
  const notes = [];
  const reset = run(doc, { reset: true }, ['pay_t', 'sum_t'], notes);
  assert.deepEqual(reset.map((o) => [o.id, o.path, o.value]), [['pay', 'theme', undefined]]);
  assert.ok(notes.some((m) => /Экран «Итог» пропущен: .*своей темы и так нет/.test(m)), notes.join(' | '));
  // всем пропущено — отказ первой причиной
  assert.throws(() => run(doc, { reset: true }, ['sum_t', 'plain']), /своей темы и так нет/);
});

test('круг72: не найдено одно имя — правка остальным и заметка; ни одного — отказ', () => {
  const doc = screens();
  const notes = [];
  const ops = run(doc, { boardNames: ['Итог', 'Склад'], colors: ACCENT }, [], notes);
  assert.deepEqual(ops.map((o) => o.id), ['sum']);
  assert.ok(notes.some((m) => /«Склад» не найден — правка легла на остальные/.test(m)), notes.join(' | '));
  assert.throws(() => run(doc, { boardNames: ['Склад', 'Касса'], colors: ACCENT }), /Экраны «Склад», «Касса» не найдены/);
  assert.throws(() => run(doc, { boardNames: ['Склад'], colors: ACCENT }), /Экран «Склад» не найден/);
});

test('круг72: образец среди экранов правки — пропущен, прочим — копия; заметка о пропущенном одна', () => {
  const doc = screens();
  const notes = [];
  const ops = run(doc, { boardNames: ['Оплата', 'Итог', 'Профиль'], likeBoard: 'Оплата' }, [], notes);
  assert.deepEqual(ops.map((o) => [o.id, o.path]), [['sum', 'theme'], ['plain', 'theme']]);
  assert.ok(notes.some((m) => /«Оплата» пропущен: он сам образец$/.test(m)));
  const more = [];
  run(doc, { boardNames: ['Итог', 'Профиль'], colors: ACCENT, spacing: [1, 2] }, [], more);
  assert.equal(more.filter((m) => /свои только цвета и шрифты/.test(m)).length, 1, more.join(' | '));
});

test('круг72: сквозь команду — одна фраза на одинаковую тему двух экранов', async () => {
  const doc = screens();
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Акцент', summary: 'Акцент', steps: ['Тема'] },
      theme: { board: true, boardNames: ['Итог', 'Профиль'], colors: ACCENT } }[schema.name]));
  } };
  const res = await runCommand({ doc, selection: [], utterance: 'сделай экраны Итог и Профиль с розовым акцентом', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.preview.doc.nodes.sum.theme.colors.accent, '#ff4f6d');
  assert.equal(res.preview.doc.nodes.plain.theme.colors.accent, '#ff4f6d');
  assert.equal(res.preview.doc.nodes.pay.theme.colors.accent, undefined);
  assert.match(res.changeSummary, /своя тема экранов «Итог», «Профиль»: акцент #ff4f6d/i);
});

test('круг72, критики: заметки — только если правка легла; образец проверен один раз; без повторов', () => {
  const doc = screens();
  const n1 = [];
  // имя не найдено, а найденный экран уже такой — отказ без «правка легла на остальные»
  assert.throws(() => run(doc, { boardNames: ['Оплата', 'Склад'], colors: [{ name: 'canvas', value: '#101418' }] }, [], n1), /уже в этих цветах/);
  assert.equal(n1.length, 0, n1.join(' | '));
  // образец не найден — отказ один, без строки на каждый экран
  const n2 = [];
  assert.throws(() => run(doc, { boardNames: ['Итог', 'Профиль'], likeBoard: 'Склад' }, [], n2), /«Склад» не найден/);
  assert.equal(n2.length, 0, n2.join(' | '));
  // все отказали одной причиной — во множественном числе, без «этого экрана»
  assert.throws(() => run(doc, { reset: true }, ['sum_t', 'plain']), /^BrainError: Экраны «Итог», «Профиль»: своей темы и так нет/);
  // пропущенный экран — без повтора имени; заметка о шкалах называет экраны, где правка легла
  const n3 = [];
  run(doc, { boardNames: ['Оплата', 'Итог'], colors: [{ name: 'canvas', value: '#101418' }], spacing: [1] }, [], n3);
  assert.ok(n3.includes('Экран «Оплата» пропущен: уже в этих цветах и шрифтах — менять нечего'), n3.join(' | '));
  assert.ok(n3.some((m) => /на экранах «Итог», скажите/.test(m)) && !n3.some((m) => /на экран\S* «Оплата»/.test(m)), n3.join(' | '));
});

test('круг72, критики: выделение, оставленное агентом, — не список экранов', () => {
  const doc = screens();
  const agent = (meta) => themeToOps({ doc: { ...doc, meta: { ...(doc.meta || {}), ...meta } }, theme: { board: true, colors: ACCENT }, engine: core, warn: () => {},
    scope: { ids: ['pay_t', 'sum_t'], kind: 'selection', selectionBy: 'agent' } });
  assert.deepEqual(agent({ activeArtboard: 'sum' }).map((o) => o.id), ['sum']);
  assert.throws(() => agent({ activeArtboard: 'plain' }), /Выделение прошлой правки — на нескольких экранах/);
});
