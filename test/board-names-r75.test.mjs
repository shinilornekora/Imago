/**
 * Круг 75 (SPEC §15.12): имена экранов в падежах («кроме Оплаты», «экрану Итогу») находятся по
 * основам слов везде — boardName, boardNames, likeBoard, exceptBoards; «все экраны оплаты» —
 * boardGroup: правка всем экранам, в имени которых это слово.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeToOps, runCommand, SCHEMAS, PROMPTS } from '../src/brain.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
function screens(names = ['Оплата картой', 'Оплата СБП', 'Итог', 'Профиль']) {
  const base = quiet(() => core.createDoc('empty'));
  const r = core.applyOps(base, names.map((name, i) => core.ops.create({ id: `b${i}`, type: 'frame', name, parent: base.root, pos: { x: i * 400, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', ...(name === 'Профиль' ? { theme: { colors: { canvas: '#101418' } } } : {}), children: [] })));
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const ACCENT = [{ name: 'accent', value: '#ff4f6d' }];
const run = (doc, theme, notes = []) => themeToOps({ doc, theme: { board: true, ...theme }, engine: core, warn: (m) => notes.push(m), scope: { ids: [] } });

test('круг75: падежи имён — boardName, boardNames, likeBoard', () => {
  const doc = screens();
  assert.deepEqual(run(doc, { boardName: 'экрану Итогу', colors: ACCENT }).map((o) => o.id), ['b2']);
  assert.deepEqual(run(doc, { boardNames: ['Итога', 'Профиля'], colors: ACCENT }).map((o) => o.id), ['b2', 'b3']);
  const like = run(doc, { boardName: 'Итог', likeBoard: 'экрана Профиля' });
  assert.deepEqual(like[0].value, doc.nodes.b3.theme);
  // «Оплатой картой» — по основам каждого слова
  assert.deepEqual(run(doc, { boardName: 'Оплатой картой', colors: ACCENT }).map((o) => o.id), ['b0']);
  // точное имя сильнее основы и вхождения
  const exact = screens(['Форма', 'Экранная форма']);
  assert.deepEqual(run(exact, { boardName: 'Форма', colors: ACCENT }).map((o) => o.id), ['b0']);
});

test('круг75: «все экраны оплаты» — boardGroup, все совпавшие; с исключением; не найдено — отказ', () => {
  const doc = screens();
  assert.deepEqual(run(doc, { boardGroup: 'оплаты', colors: ACCENT }).map((o) => o.id), ['b0', 'b1']);
  assert.deepEqual(run(doc, { boardGroup: 'оплата', exceptBoards: ['Оплаты СБП'], colors: ACCENT }).map((o) => o.id), ['b0']);
  assert.throws(() => run(doc, { boardGroup: 'склад', colors: ACCENT }), /Экранов со словом «склад» в имени нет/);
  // без board:true — тоже экраны
  assert.deepEqual(themeToOps({ doc, theme: { boardGroup: 'оплата', colors: ACCENT }, engine: core, warn: () => {} }).map((o) => o.id), ['b0', 'b1']);
  // образец в группе — не в правке, без заметки
  const notes = [];
  const themed = core.applyOps(doc, [core.ops.set('b0', 'theme', { colors: { canvas: '#202020' } })]).doc;
  const ops = run(themed, { boardGroup: 'оплата', likeBoard: 'Оплата картой' }, notes);
  assert.deepEqual(ops.map((o) => o.id), ['b1']);
  assert.ok(!notes.some((m) => /образец/.test(m)), notes.join(' | '));
  assert.ok(SCHEMAS.theme.schema.properties.boardGroup);
  assert.match(PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'всё' }), /boardGroup/);
});

test('круг75: сквозь команду — «все экраны оплаты тёмными»', async () => {
  const doc = screens();
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Оплата', summary: 'Оплата', steps: ['Тема'] },
      theme: { boardGroup: 'оплаты', colors: ACCENT } }[schema.name]));
  } };
  const res = await runCommand({ doc, selection: [], utterance: 'сделай все экраны оплаты с розовым акцентом', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.preview.doc.nodes.b0.theme.colors.accent, '#ff4f6d');
  assert.equal(res.preview.doc.nodes.b1.theme.colors.accent, '#ff4f6d');
  assert.equal(res.preview.doc.nodes.b2.theme, undefined);
  assert.match(res.changeSummary, /своя тема экранов «Оплата картой», «Оплата СБП»/i);
});
