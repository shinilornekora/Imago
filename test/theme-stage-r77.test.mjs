/**
 * Круг 77 (SPEC §15.14): строка стадии темы называет, чьё оформление меняется (раньше — всегда
 * «Меняю оформление документа», и у темы одного экрана тоже).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { themeStageLine, runCommand } from '../src/brain.js';

const EMPTY = { nodes: {}, root: 'r' };
test('круг77: документ, экран, экраны, группа, «все, кроме», сброс, образец', () => {
  const cases = [
    [{ colors: [{ name: 'accent', value: '#ff0000' }] }, 'Меняю оформление документа'],
    [{ board: true, boardName: 'Оплата' }, 'Меняю оформление экрана «Оплата»'],
    [{ board: true, boardNames: ['Итог', 'Профиль'] }, 'Меняю оформление экранов «Итог», «Профиль»'],
    [{ boardGroup: 'оплата' }, 'Меняю оформление экранов со словом «оплата»'],
    [{ exceptBoards: ['Оплата'] }, 'Меняю оформление всех экранов, кроме «Оплата»'],
    [{ board: true, reset: true, boardName: 'Итог' }, 'Возвращаю экрану «Итог» общее оформление'],
    [{ board: true, reset: true, exceptBoards: ['Итог'] }, 'Возвращаю всем экранам, кроме «Итог», общее оформление'],
    [{ board: true, likeBoard: 'Оплата', boardName: 'Итог' }, 'Переношу оформление с экрана «Оплата» на экран «Итог»'],
    [{ likeBoard: 'Оплата', exceptBoards: ['Профиль'] }, 'Переношу оформление с экрана «Оплата» на все экраны, кроме «Профиль»'],
    [{ board: true, boardNames: ['a', 'b', 'c', 'd', 'e'] }, 'Меняю оформление экранов «a», «b», «c» и ещё 2'],
  ];
  for (const [d, want] of cases) assert.equal(themeStageLine(d, EMPTY, null), want, JSON.stringify(d));
});

test('круг77: экраны выделения — по именам досок; сквозь команду — стадия с именем экрана', async () => {
  const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
  const base = quiet(() => core.createDoc('empty'));
  const mk = (id, name, x) => core.ops.create({ id, type: 'frame', name, parent: base.root, pos: { x, y: 0 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, fill: 'canvas', children: [] });
  const doc = core.applyOps(base, [mk('pay', 'Оплата', 0), mk('sum', 'Итог', 400)]).doc;
  assert.equal(themeStageLine({ board: true }, doc, { ids: ['pay', 'sum'] }), 'Меняю оформление экранов «Оплата», «Итог»');
  assert.equal(themeStageLine({ board: true }, doc, { ids: ['sum'] }), 'Меняю оформление экрана «Итог»');
  const provider = { name: 'fake', async ready() { return true; }, async complete(m, schema) {
    return JSON.parse(JSON.stringify({ plan: { intent: 'theme', title: 'Тёмный', summary: 'Тёмный', steps: ['Тема'] },
      theme: { board: true, colors: [{ name: 'accent', value: '#ff4f6d' }] } }[schema.name]));
  } };
  const stages = [];
  const res = await runCommand({ doc, selection: ['sum'], utterance: 'сделай этот экран с розовым акцентом', provider, engine: core, onStage: (e) => stages.push(e) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(stages.some((e) => e.stage === 'materialize' && e.detail === 'Меняю оформление экрана «Итог»'), JSON.stringify(stages));
});
