/**
 * Круг 91 (ОТЧЁТ §3, п.4): экран, названный в команде по имени, — просьба человека, а не промах модели:
 * «Слой … найден вне активной области» об этом экране не пишется. Не назван — пишется, как раньше.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand } from '../src/brain.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens() {
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', children: [] });
  const r = core.applyOps(base, [
    mk('pay', 'Оплата картой', 0),
    mk('sum', 'Итог', 400),
    core.ops.create({ id: 'pay_t', type: 'text', name: 'Цена', parent: 'pay', characters: '1 990 ₽', style: 'title' }),
    core.ops.create({ id: 'sum_t', type: 'text', name: 'Сумма', parent: 'sum', characters: '1 990 ₽', style: 'title' }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
  const out = {
    plan: { intent: 'edit', title: 'Цвет цены', summary: 'Цена акцентом', steps: ['Цвет'] },
    patch: { edits: [{ op: 'set', target: 'Цена', path: 'color', value: 'accent' }] },
  }[schema.name];
  return JSON.parse(JSON.stringify(out || {}));
} };
const run = (utterance) => runCommand({ doc: screens(), selection: [], utterance, provider, engine: core, activeArtboardId: 'sum' });

test('круг91: экран назван по имени (в падеже) — без «найден вне активной области»', async () => {
  for (const u of ['на экране «Оплата картой» сделай цену акцентом', 'на экране оплаты картой покрась цену в акцент']) {
    const res = await run(u);
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.equal(res.preview.doc.nodes.pay_t.color, 'accent', u);
    assert.ok(!res.warnings.some((w) => /вне активной области/.test(w)), `${u}: ${res.warnings.join(' | ')}`);
  }
});

test('круг91: экран не назван или назван не весь — предупреждение остаётся', async () => {
  for (const u of ['сделай цену акцентом', 'на экране оплаты сделай цену акцентом']) {
    const res = await run(u);
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.ok(res.warnings.some((w) => /Слой «Цена» найден вне активной области — на экране «Оплата картой»/.test(w)), `${u}: ${res.warnings.join(' | ')}`);
  }
});

function pair(nameA, nameB, target = 'Цена') {
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', children: [] });
  return core.applyOps(base, [mk('pay', nameA, 0), mk('sum', nameB, 400),
    core.ops.create({ id: 'pay_t', type: 'text', name: target, parent: 'pay', characters: '1 990 ₽', style: 'title' })]).doc;
}
const warned = async (doc, utterance, target = 'Цена', selection = []) => {
  const p = { ...provider, async complete(m, schema) {
    const out = { plan: { intent: 'edit', title: 'Цвет', summary: 'Цвет', steps: ['Цвет'] },
      patch: { edits: [{ op: 'set', target, path: 'color', value: 'accent' }] } }[schema.name];
    return JSON.parse(JSON.stringify(out || {}));
  } };
  const res = await runCommand({ doc, selection, utterance, provider: p, engine: core, activeArtboardId: 'sum' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  return res.warnings.some((w) => /найден вне (?:активной области|выделения)/.test(w));
};

test('круг91, критик: имя — только там, где называют экран; числа различают; выделение человека — граница', async () => {
  // «Экран 1» / «Экран 2»: назван другой — предупреждение; назван этот — нет
  assert.equal(await warned(pair('Экран 1', 'Экран 2'), 'на экране 2 сделай цену акцентом'), true);
  assert.equal(await warned(pair('Экран 1', 'Экран 2'), 'на экране 1 сделай цену акцентом'), false);
  // слово имени как обычное слово команды — не название экрана
  assert.equal(await warned(pair('Кнопки', 'Итог', 'Кнопка'), 'сделай кнопку акцентом', 'Кнопка'), true);
  assert.equal(await warned(pair('Главная', 'Итог', 'Заголовок'), 'сделай главный заголовок акцентом', 'Заголовок'), true);
  // в кавычках и за словом «экран» — названо
  assert.equal(await warned(pair('Главная', 'Итог', 'Заголовок'), 'на экране главной сделай заголовок акцентом', 'Заголовок'), false);
  assert.equal(await warned(pair('Главная', 'Итог', 'Заголовок'), 'в «Главной» сделай заголовок акцентом', 'Заголовок'), false);
  // выделение, которое задал человек, — о нём говорим и при названном экране
  assert.equal(await warned(pair('Оплата картой', 'Итог'), 'на экране оплаты картой сделай цену акцентом', 'Цена', ['sum']), true);
});
