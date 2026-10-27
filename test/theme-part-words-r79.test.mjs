/**
 * Круг 79 (SPEC §15.16): «верни экрану Итог цвета документа» — агент снимает с экрана только свои цвета
 * (или только шрифты: resetPart), другая часть остаётся; без модели такие фразы — оформление.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeToOps, themeStageLine, runCommand, classifyUtterance, SCHEMAS, PROMPTS } from '../src/brain.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const BOTH = { colors: { canvas: '#101418', text: '#e8eaf0' }, type: { title: { font: 'Prata' } } };
function screens() {
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x, theme) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', ...(theme ? { theme } : {}), children: [] });
  const r = core.applyOps(base, [
    mk('pay', 'Оплата', 0, BOTH),
    mk('sum', 'Итог', 400, { colors: { accent: '#ff4f6d' } }),
    mk('plain', 'Профиль', 800, null),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}
const run = (doc, theme, notes = []) => themeToOps({ doc, theme: { board: true, reset: true, ...theme }, engine: core, warn: (m) => notes.push(m), scope: { ids: [] } });

test('круг79: resetPart — снимается одна часть, другая остаётся; последняя — вся тема', () => {
  const doc = screens();
  assert.deepEqual(run(doc, { boardName: 'Оплата', resetPart: 'colors' }).map((o) => [o.id, o.path, o.value]), [['pay', 'theme.colors', undefined]]);
  assert.deepEqual(run(doc, { boardName: 'Оплата', resetPart: 'type' }).map((o) => [o.path, o.value]), [['theme.type', undefined]]);
  assert.deepEqual(run(doc, { boardName: 'Итог', resetPart: 'colors' }).map((o) => [o.path, o.value]), [['theme', undefined]], 'последняя часть');
  assert.throws(() => run(doc, { boardName: 'Итог', resetPart: 'type' }), /своих шрифтов и так нет/);
  assert.throws(() => run(doc, { boardName: 'Профиль', resetPart: 'colors' }), /своей темы и так нет/);
  // неизвестная часть — как reset целиком
  assert.deepEqual(run(doc, { boardName: 'Оплата', resetPart: 'spacing' }).map((o) => o.path), ['theme']);
  assert.ok(SCHEMAS.theme.schema.properties.resetPart);
  assert.match(PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'всё' }), /resetPart/);
});

test('круг79: несколько экранов — у кого нет своих цветов, тот пропущен заметкой', () => {
  const doc = core.applyOps(screens(), [core.ops.set('plain', 'theme', { type: { body: { fontWeight: 500 } } })]).doc;
  const notes = [];
  const ops = run(doc, { boardNames: ['Оплата', 'Итог', 'Профиль'], resetPart: 'colors' }, notes);
  assert.deepEqual(ops.map((o) => [o.id, o.path]), [['pay', 'theme.colors'], ['sum', 'theme']]);
  assert.ok(notes.some((m) => /«Профиль» пропущен: своих цветов и так нет/.test(m)), notes.join(' | '));
});

test('круг79: строка хода работы — «цвета документа» / «шрифты документа»', () => {
  const doc = screens();
  assert.equal(themeStageLine({ board: true, reset: true, resetPart: 'colors', boardName: 'Итог' }, doc), 'Возвращаю экрану «Итог» цвета документа');
  assert.equal(themeStageLine({ board: true, reset: true, resetPart: 'type', boardNames: ['Итог', 'Оплата'] }, doc), 'Возвращаю экранам «Итог», «Оплата» шрифты документа');
  assert.equal(themeStageLine({ board: true, reset: true, boardName: 'Итог' }, doc), 'Возвращаю экрану «Итог» общее оформление');
});

test('круг79: сквозь команду — итог «цвета — как в документе», шрифты остались', async () => {
  const doc = screens();
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Цвета', summary: 'Цвета документа', steps: ['Тема'] },
      theme: { board: true, boardName: 'Оплата', reset: true, resetPart: 'colors' } }[schema.name]));
  } };
  const res = await runCommand({ doc, selection: [], utterance: 'верни экрану Оплата цвета документа', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.preview.doc.nodes.pay.theme.colors, undefined);
  assert.deepEqual(res.preview.doc.nodes.pay.theme.type, BOTH.type);
  assert.match(res.changeSummary, /экран «Оплата»: цвета — как в документе/i);
});

test('круг79: без модели — «верни экрану цвета документа» оформление; цвет слоя — нет', () => {
  for (const u of ['верни экрану Итог цвета документа', 'верни экрану общие цвета', 'сбрось свои цвета экрана',
    'цвета экрана Итог — как в документе', 'верни экрану «Итог» цвета как в документе', 'сними свои цвета у этого экрана',
    'сбрось цвета экранов оплаты']) assert.equal(classifyUtterance(u).intent, 'theme', u);
  for (const u of ['верни кнопке цвет как в документе', 'верни кнопке на экране цвет', 'сбрось цвета кнопки', 'верни экрану Итог кнопку синей'])
    assert.notEqual(classifyUtterance(u).intent, 'theme', u);
});

test('круг79, критик: «прежние цвета» — не тема; несколько экранов и «кроме» — тема; повреждённая тема — заметка', () => {
  for (const u of ['верни экрану Итог прежние цвета', 'верни экрану Итог старые цвета'])
    assert.notEqual(classifyUtterance(u).intent, 'theme', u);
  for (const u of ['верни экранам Оплата и Итог цвета документа', 'верни всем экранам, кроме Оплаты, цвета документа', 'верни экрану Старт цвета документа'])
    assert.equal(classifyUtterance(u).intent, 'theme', u);
  const doc = structuredClone(screens());
  doc.nodes.plain.theme = { colors: { accent: 'не цвет' }, type: { title: { font: 'Prata' } } };   // как из старого файла
  assert.equal(core.boardTheme(doc.nodes.plain), null);
  const notes = [];
  assert.deepEqual(run(doc, { boardName: 'Профиль', resetPart: 'colors' }, notes).map((o) => o.path), ['theme']);
  assert.ok(notes.some((m) => /«Профиль» была повреждена — снята целиком/.test(m)), notes.join(' | '));
});
