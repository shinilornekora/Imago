/**
 * Круг 71 (SPEC §15.8): «сделай этот экран как «Оплата»» — тематизатор берёт тему экрана-образца
 * копией (likeBoard); образец в оформлении документа — «верни общее»; поверх — сказанные цвета.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeToOps, runCommand, SCHEMAS, PROMPTS } from '../src/brain.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens({ sumTheme } = {}) {
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x, theme) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] });
  const r = core.applyOps(base, [
    mk('pay', 'Оплата', 0, { colors: { canvas: '#101418', text: '#e8eaf0' }, type: { title: { font: 'Prata' } } }),
    mk('sum', 'Итог', 400, sumTheme || null),
    mk('plain', 'Профиль', 800, null),
    core.ops.create({ id: 'sum_t', type: 'text', name: 'Сумма', parent: 'sum', characters: '1 990 ₽', style: 'title' }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const run = (doc, theme, ids = ['sum_t'], notes = []) => themeToOps({ doc, theme: { board: true, ...theme }, engine: core, warn: (m) => notes.push(m), scope: { ids } });

test('круг71: likeBoard — тема образца копией одной операцией; поверх — сказанное', () => {
  const doc = screens();
  const ops = run(doc, { likeBoard: 'экран «Оплата»' });
  assert.deepEqual(ops.map((o) => [o.id, o.path]), [['sum', 'theme']]);
  assert.deepEqual(ops[0].value, doc.nodes.pay.theme);
  assert.notEqual(ops[0].value, doc.nodes.pay.theme, 'копия, не ссылка');
  const more = run(doc, { likeBoard: 'Оплата', colors: [{ name: 'accent', value: '#ff4f6d' }] });
  assert.deepEqual(more[0].value.colors, { canvas: '#101418', text: '#e8eaf0', accent: '#ff4f6d' });
  assert.ok(SCHEMAS.theme.schema.properties.likeBoard);
  assert.match(PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'всё' }), /likeBoard/);
});

test('круг71: своя тема заменена — сказано; образец без темы — вернуть общее; ошибки словами', () => {
  const notes = [];
  const doc = screens({ sumTheme: { colors: { accent: '#ff4f6d' } } });
  run(doc, { likeBoard: 'Оплата' }, ['sum_t'], notes);
  assert.ok(notes.some((m) => /Своя тема экрана «Итог» заменена оформлением экрана «Оплата»/.test(m)), notes.join(' | '));
  const reset = run(doc, { likeBoard: 'Профиль' });
  assert.deepEqual(reset.map((o) => [o.path, o.value]), [['theme', undefined]]);
  assert.throws(() => run(screens(), { likeBoard: 'Профиль' }), /в оформлении документа, и этот тоже/);
  assert.throws(() => run(doc, { likeBoard: 'Итог' }), /и есть образец/);
  assert.throws(() => run(doc, { likeBoard: 'Склад' }), /«Склад» не найден/);
  const same = screens({ sumTheme: { type: { title: { font: 'Prata' } }, colors: { text: '#E8EAF0', canvas: '#101418' } } });
  assert.throws(() => run(same, { likeBoard: 'Оплата' }), /уже в оформлении экрана «Оплата»/);
});

test('круг71: сквозь команду — экран становится как образец, соседи не тронуты', async () => {
  const doc = screens();
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Как «Оплата»', summary: 'Как оплата', steps: ['Тема'] }, theme: { board: true, likeBoard: 'Оплата' } }[schema.name]));
  } };
  const res = await runCommand({ doc, selection: ['sum_t'], utterance: 'сделай этот экран как «Оплата»', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  assert.deepEqual(after.nodes.sum.theme, doc.nodes.pay.theme);
  assert.equal(after.nodes.plain.theme, undefined);
  assert.match(res.changeSummary, /Своя тема экрана «Итог»/);
});

test('круг71, критики: имя не срезается, board:true не обязателен, reset уступает образцу, тема образца повреждена', async () => {
  const { classifyUtterance } = await import('../src/brain.js');
  // «Экранная форма» — не «форма»
  let doc = screens();
  doc = core.applyOps(doc, [core.ops.set('plain', 'name', 'Форма'), core.ops.set('pay', 'name', 'Экранная форма')]).doc;
  assert.deepEqual(run(doc, { likeBoard: 'Экранная форма' })[0].value, doc.nodes.pay.theme);
  assert.deepEqual(run(doc, { likeBoard: 'экрана «Экранная форма»' })[0].value, doc.nodes.pay.theme);
  // без board:true — всё равно экран
  const base = screens();
  const ops = themeToOps({ doc: base, theme: { likeBoard: 'Оплата' }, engine: core, warn: () => {}, scope: { ids: ['sum_t'] } });
  assert.deepEqual(ops.map((o) => [o.id, o.path]), [['sum', 'theme']]);
  // reset вместе с образцом — побеждает образец
  assert.deepEqual(run(base, { likeBoard: 'Оплата', reset: true })[0].value, base.nodes.pay.theme);
  // тема образца не по форме — словами
  const broken = { ...base, nodes: { ...base.nodes, pay: { ...base.nodes.pay, theme: { colors: { canvas: 'red' } } } } };
  assert.throws(() => run(broken, { likeBoard: 'Оплата' }), /Тема экрана «Оплата» повреждена/);
  // копия задевает цвета — контраст проверен
  const dim = core.applyOps(screens(), [core.ops.set('pay', 'theme', { colors: { canvas: '#14161c' } })]).doc;
  const notes = [];
  run(dim, { likeBoard: 'Оплата' }, ['sum_t'], notes);
  assert.ok(notes.some((m) => /контраст/.test(m)), notes.join(' | '));
  // без модели — оформление, а не правка или создание
  for (const u of ['сделай этот экран как «Оплата»', 'оформи так же, как экран «Оплата»', 'экран такой же, как у экрана "Оплата"']) {
    assert.equal(classifyUtterance(u, { hasSelection: true }).intent, 'theme', u);
  }
});
