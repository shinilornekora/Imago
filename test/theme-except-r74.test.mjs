/**
 * Круг 74 (SPEC §15.11): «все экраны, кроме «Оплата»» — та же правка темой всем экранам страницы,
 * кроме названных (exceptBoards); исключённый экран и библиотека не тронуты; токены документа — тоже.
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
    mk('pay', 'Оплата', 0, { colors: { canvas: '#101418' } }),
    mk('sum', 'Итог', 400, null),
    mk('plain', 'Профиль', 800, null),
    mk('lib', 'Компоненты', 1200, null, 'library'),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const ACCENT = [{ name: 'accent', value: '#ff4f6d' }];
const run = (doc, theme, notes = [], ids = []) => themeToOps({ doc, theme, engine: core, warn: (m) => notes.push(m), scope: { ids } });

test('круг74: все экраны, кроме «Оплата», — правка остальным; библиотека и токены документа не тронуты', () => {
  const doc = screens();
  const ops = run(doc, { board: true, exceptBoards: ['Оплата'], colors: ACCENT });
  assert.deepEqual(ops.map((o) => [o.id, o.path]), [['sum', 'theme'], ['plain', 'theme']]);
  assert.ok(!ops.some((o) => o.op === 'setToken'));
  // и без board:true — список экранов значит экраны
  assert.deepEqual(run(doc, { exceptBoards: ['экран «Оплата»'], colors: ACCENT }).map((o) => o.id), ['sum', 'plain']);
  // выделение не сужает «все, кроме»
  assert.deepEqual(run(doc, { board: true, exceptBoards: ['Итог'], colors: ACCENT }, [], ['sum']).map((o) => o.id), ['pay', 'plain']);
  assert.ok(SCHEMAS.theme.schema.properties.exceptBoards);
  assert.match(PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'всё' }), /exceptBoards/);
});

test('круг74: исключение из списка имён; не найдено — заметка; исключены все — отказ', () => {
  const doc = screens();
  assert.deepEqual(run(doc, { boardNames: ['Итог', 'Профиль'], exceptBoards: ['Профиль'], colors: ACCENT }).map((o) => o.id), ['sum']);
  // исключение не найдено — отказ: иначе исключённый экран перекрасился бы
  assert.throws(() => run(doc, { exceptBoards: ['Склад'], colors: ACCENT }), /«Склад» не найден — не знаю, какой не трогать/);
  assert.throws(() => run(doc, { exceptBoards: ['Оплата', 'Итог', 'Профиль'], colors: ACCENT }), /Исключены все экраны правки/);
  assert.throws(() => run(doc, { boardNames: ['Итог'], exceptBoards: ['Итог'], colors: ACCENT }), /Исключены все экраны правки/);
});

test('круг74: сквозь команду — одна фраза на два экрана, «Оплата» как была', async () => {
  const doc = screens();
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Акцент', summary: 'Акцент', steps: ['Тема'] },
      theme: { board: true, exceptBoards: ['Оплата'], colors: ACCENT } }[schema.name]));
  } };
  const res = await runCommand({ doc, selection: [], utterance: 'сделай все экраны, кроме оплаты, с розовым акцентом', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.preview.doc.nodes.pay.theme, doc.nodes.pay.theme);
  assert.equal(res.preview.doc.nodes.lib.theme, undefined);
  assert.equal(res.preview.doc.tokens.colors.accent, doc.tokens.colors.accent);
  assert.match(res.changeSummary, /своя тема экранов «Итог», «Профиль»: акцент #ff4f6d/i);
});

test('круг74, критики: «кроме Оплаты» по основе слова, все совпавшие, библиотека, образец, reset без board', async () => {
  const doc = screens();
  assert.deepEqual(run(doc, { exceptBoards: ['Оплаты'], colors: ACCENT }).map((o) => o.id), ['sum', 'plain']);
  // вхождением — все совпавшие, с заметкой
  const two = core.applyOps(doc, [core.ops.set('pay', 'name', 'Оплата картой'), core.ops.set('plain', 'name', 'Оплата СБП')]).doc;
  const notes = [];
  assert.deepEqual(run(two, { exceptBoards: ['Оплата'], colors: ACCENT }, notes).map((o) => o.id), ['sum']);
  assert.ok(notes.some((m) => /не тронуты экраны «Оплата картой», «Оплата СБП»/.test(m)), notes.join(' | '));
  // библиотеку исключать незачем — молча
  const n2 = [];
  assert.equal(run(doc, { exceptBoards: ['Компоненты'], colors: ACCENT }, n2).length, 3);
  assert.equal(n2.length, 0, n2.join(' | '));
  // «все, кроме Профиля, как «Оплата»» — образец не в правке, без заметки
  const n3 = [];
  assert.deepEqual(run(doc, { exceptBoards: ['Профиль'], likeBoard: 'Оплата' }, n3).map((o) => o.id), ['sum']);
  assert.ok(!n3.some((m) => /образец/.test(m)), n3.join(' | '));
  // на странице только библиотека
  const empty = core.applyOps(doc, [core.ops.remove('pay'), core.ops.remove('sum'), core.ops.remove('plain')]).doc;
  assert.throws(() => run(empty, { exceptBoards: ['Итог'], colors: ACCENT }), /нет экранов — только библиотека/);
  // boardNames без board:true — по-прежнему не повод уйти от темы документа
  const docOps = run(doc, { boardNames: ['все экраны'], colors: ACCENT });
  assert.ok(docOps.every((o) => o.op === 'setToken'), JSON.stringify(docOps));
  // reset с «все, кроме» без board:true — правка, а не «ничего не предложила»
  const withThemes = core.applyOps(doc, [core.ops.set('sum', 'theme', { colors: { accent: '#00aa55' } })]).doc;
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Сброс', summary: 'Сброс', steps: ['Тема'] },
      theme: { exceptBoards: ['Профиль'], reset: true } }[schema.name]));
  } };
  const res = await runCommand({ doc: withThemes, selection: [], utterance: 'верни всем экранам, кроме профиля, общее оформление', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.preview.doc.nodes.sum.theme, undefined);
  assert.equal(res.preview.doc.nodes.pay.theme, undefined);
});
