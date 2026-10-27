/**
 * Круг 69 (SPEC §15.4): тематизатор у экрана с темой пишет правку по путям (theme.colors.<имя>,
 * theme.type.<стиль>) — правка человека в инспекторе (§15.6) другого цвета той же доски за время
 * команды не затирается; история говорит одной фразой на экран.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeToOps, runCommand } from '../src/brain.js';
import { themeColorOps } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function board(theme) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, [
    core.ops.create({ id: 'pay', type: 'frame', name: 'Оплата', parent: base.root, pos: { x: 0, y: 0 }, size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] }),
    core.ops.create({ id: 'pay_t', type: 'text', name: 'Итог', parent: 'pay', characters: 'Итого', style: 'title' }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг69: тематизатор поверх темы — пути; правка человека другого цвета остаётся', () => {
  const doc = board({ colors: { canvas: '#101418' } });
  const agent = themeToOps({ doc, theme: { board: true, colors: [{ name: 'accent', value: '#FF4F6D' }], type: [{ name: 'title', font: 'Prata' }] }, engine: core, warn: () => {}, scope: { ids: ['pay_t'] } });
  assert.deepEqual(agent.map((o) => o.path), ['theme.colors.accent', 'theme.type.title.font']);
  // пока агент думал, человек поменял текст в инспекторе
  const human = themeColorOps(doc, doc.nodes.pay, 'text', '#e8eaf0');
  const mine = core.applyOps(doc, human.ops).doc;
  const both = core.applyOps(mine, agent).doc;
  assert.deepEqual(both.nodes.pay.theme, { colors: { canvas: '#101418', text: '#e8eaf0', accent: '#ff4f6d' }, type: { title: { font: 'Prata' } } });
  // без темы — как раньше, одной темой
  const fresh = board(null);
  const first = themeToOps({ doc: fresh, theme: { board: true, colors: [{ name: 'accent', value: '#ff4f6d' }] }, engine: core, warn: () => {}, scope: { ids: ['pay'] } });
  assert.deepEqual(first.map((o) => o.path), ['theme']);
});

test('круг69: история — одной фразой на экран по путям', async () => {
  const doc = board({ colors: { canvas: '#101418' } });
  const theme = { board: true, summary: 'Акцент', colors: [{ name: 'accent', value: '#ff4f6d' }, { name: 'text', value: '#e8eaf0' }] };
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Акцент', summary: 'Акцент', steps: ['Цвета'] }, theme }[schema.name]));
  } };
  const res = await runCommand({ doc, selection: ['pay_t'], utterance: 'сделай только этот экран с розовым акцентом', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.path), ['theme.colors.accent', 'theme.colors.text']);
  assert.equal(res.changeSummary, 'Своя тема экрана «Оплата»: акцент #ff4f6d, текст #e8eaf0', 'одна фраза, без путей');
});

test('круг69: по полям стиля — насыщенность человека остаётся; тот же цвет — не правка; контраст — только задетых', () => {
  const doc = board({ colors: { canvas: '#101418', text: '#e8eaf0' } });
  const agent = themeToOps({ doc, theme: { board: true, type: [{ name: 'title', font: 'Prata' }] }, engine: core, warn: () => {}, scope: { ids: ['pay'] } });
  assert.deepEqual(agent.map((o) => o.path), ['theme.type.title.font']);
  const mine = core.applyOps(doc, [core.ops.set('pay', 'theme.type', { title: { font: 'Inter Tight', fontWeight: 700 } })]).doc;
  assert.deepEqual(core.applyOps(mine, agent).doc.nodes.pay.theme.type.title, { font: 'Prata', fontWeight: 700 });
  // тот же цвет — ни операции, ни строки; ничего нового — честный отказ
  const same = themeToOps({ doc, theme: { board: true, colors: [{ name: 'canvas', value: '#101418' }, { name: 'accent', value: '#ff4f6d' }] }, engine: core, warn: () => {}, scope: { ids: ['pay'] } });
  assert.deepEqual(same.map((o) => o.path), ['theme.colors.accent']);
  assert.throws(() => themeToOps({ doc, theme: { board: true, colors: [{ name: 'canvas', value: '#101418' }] }, engine: core, warn: () => {}, scope: { ids: ['pay'] } }), /уже в этих цветах и шрифтах/);
  // плохой контраст фона и текста темы уже был; правка шрифта о нём не говорит
  const dark = board({ colors: { canvas: '#101418', text: '#101418' } });
  const notes = [];
  themeToOps({ doc: dark, theme: { board: true, type: [{ name: 'title', font: 'Prata' }] }, engine: core, warn: (m) => notes.push(m), scope: { ids: ['pay'] } });
  assert.ok(!notes.some((m) => /контраст/.test(m)), notes.join(' | '));
  const notes2 = [];
  themeToOps({ doc: dark, theme: { board: true, colors: [{ name: 'canvas', value: '#111111' }] }, engine: core, warn: (m) => notes2.push(m), scope: { ids: ['pay'] } });
  assert.ok(notes2.some((m) => /контраст/.test(m)), 'задетый фон — проверен');
});

test('круг69: тема не по форме — агент пишет тему целиком и заменяет её', () => {
  const doc = board(null);
  const bad = { ...doc, nodes: { ...doc.nodes, pay: { ...doc.nodes.pay, theme: { colors: { canvas: 'red' } } } } };
  assert.equal(core.boardTheme(bad.nodes.pay), null);
  const ops = themeToOps({ doc: bad, theme: { board: true, colors: [{ name: 'accent', value: '#ff4f6d' }] }, engine: core, warn: () => {}, scope: { ids: ['pay'] } });
  assert.deepEqual(ops.map((o) => [o.path, o.value]), [['theme', { colors: { accent: '#ff4f6d' } }]]);
});
