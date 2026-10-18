/**
 * Круг 36 (SPEC §11): микроанимации в оболочке — режим «Просмотр», раздел «Состояния» в
 * инспекторе, значок у слоя, подписи правок словами, пометка экспорта, подсказка.
 *
 * Чистые части живут в src/shell.js и проверяются напрямую; разметка оболочки (app.js,
 * index.html, styles.css) — по исходникам: браузерный прогон — tools/ и Playwright.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

/** Применить пути оболочки к узлу так же, как это сделает set ядра. */
function fold(node, list) {
  let n = node;
  for (const o of list) n = SHELL.setLocal(n, o.path, o.value);
  return n;
}

test('r36: «просмотр» — команда оболочки из таблицы (§13), без модели; слэш-форма — тоже', () => {
  for (const [said, on] of [
    ['просмотр', true], ['режим просмотра', true], ['включи режим просмотра', true],
    ['выйди из просмотра', false], ['выйти из режима просмотра', false], ['закрой просмотр', false],
    ['/просмотр', true], ['/просмотр выкл', false], ['/preview вкл', true],
  ]) {
    assert.deepEqual(SHELL.shellIntent(said), { kind: 'preview', on }, `«${said}»`);
    // явная команда редактора и без документа: Orchestrator модели её не отдаёт
    assert.equal(SHELL.isShellCommandText(said), true, `«${said}»`);
    assert.equal(SHELL.commandIdOf(SHELL.shellIntent(said)), 'preview');
  }
  // работа для модели — не перехватывается
  for (const said of ['добавь экран просмотра', 'оживи кнопки', 'добавь микроанимации']) {
    assert.equal(SHELL.shellIntent(said), null, `«${said}»`);
    assert.equal(SHELL.isShellCommandText(said), false, `«${said}»`);
  }
  // сервер без args — включить; on:false — выключить
  assert.deepEqual(SHELL.shellIntentFromServer({ action: 'preview' }), { kind: 'preview', on: true });
  assert.deepEqual(SHELL.shellIntentFromServer({ action: 'preview', args: { on: false } }), { kind: 'preview', on: false });
});

test('r36: запись поля состояния — наименьшей правкой, снятие не оставляет пустых объектов', () => {
  const bare = { id: 'b', type: 'frame' };
  // нет states — пишется states целиком
  let ops = SHELL.stateWriteOps(bare, 'hover', 'lift', 'spacing.1');
  assert.deepEqual(ops, [{ path: 'states', value: { hover: { lift: 'spacing.1' } } }]);
  let n = fold(bare, ops);
  // есть states.hover — поле
  ops = SHELL.stateWriteOps(n, 'hover', 'shadow', 'shadow.md');
  assert.deepEqual(ops, [{ path: 'states.hover.shadow', value: 'shadow.md' }]);
  n = fold(n, ops);
  // есть states, нет press — пишется states.press
  ops = SHELL.stateWriteOps(n, 'press', 'scale', 0.97);
  assert.deepEqual(ops, [{ path: 'states.press', value: { scale: 0.97 } }]);
  n = fold(n, ops);
  // снятие последнего поля press — уходит states.press целиком
  ops = SHELL.stateWriteOps(n, 'press', 'scale', undefined);
  assert.deepEqual(ops, [{ path: 'states.press', value: undefined }]);
  n = fold(n, ops);
  assert.deepEqual(n.states, { hover: { lift: 'spacing.1', shadow: 'shadow.md' } });
  // снятие одного из полей — только поле
  assert.deepEqual(SHELL.stateWriteOps(n, 'hover', 'lift', undefined), [{ path: 'states.hover.lift', value: undefined }]);
  // снимать нечего — правки нет
  assert.deepEqual(SHELL.stateWriteOps(n, 'focus', 'lift', undefined), []);
  assert.deepEqual(SHELL.stateWriteOps(n, 'nope', 'lift', 2), []);
  // «Убрать состояние» последнего — уносит states
  assert.deepEqual(SHELL.stateRemoveOps(n, 'hover'), [{ path: 'states', value: undefined }]);
  assert.equal(fold(n, SHELL.stateRemoveOps(n, 'hover')).states, undefined);
  assert.deepEqual(SHELL.stateRemoveOps(bare, 'hover'), []);
  // движение — той же дисциплиной
  assert.deepEqual(SHELL.motionWriteOps(bare, 'duration', 'motion.fast'), [{ path: 'motion', value: { duration: 'motion.fast' } }]);
  const m = fold(bare, SHELL.motionWriteOps(bare, 'duration', 'motion.fast'));
  assert.deepEqual(SHELL.motionWriteOps(m, 'easing', 'spring'), [{ path: 'motion.easing', value: 'spring' }]);
  assert.deepEqual(SHELL.motionWriteOps(m, 'duration', undefined), [{ path: 'motion', value: undefined }]);
});

test('r36: правка состояний словами — «Наведение «Кнопка»: подъём 2 px, тень средняя, 120 мс»', () => {
  const tokens = { spacing: [0, 2, 4, 6, 8], motion: { fast: 120, base: 200, slow: 320 } };
  const ctx = { tokens, colorWord: (v) => ({ accent: 'акцент', accentInk: 'акцент тёмный' }[v && v.token ? v.token : v] || '') };
  const btn = { id: 'b', type: 'frame', name: 'Кнопка' };
  const after = { ...btn, states: { hover: { lift: 'spacing.1', shadow: 'shadow.md' } }, motion: { duration: 'motion.fast' } };
  assert.deepEqual(SHELL.stateEditPhrases(btn, after, 'Кнопка', ctx), ['Наведение «Кнопка»: подъём 2 px, тень средняя, 120 мс']);
  // одно поле — «было → стало»
  const a2 = SHELL.setLocal(after, 'states.hover.lift', 'spacing.2');
  assert.deepEqual(SHELL.stateEditPhrases(after, a2, 'Кнопка', ctx), ['Наведение «Кнопка»: подъём 2 px → 4 px']);
  // цвет — словами палитры, масштаб и непрозрачность — процентами
  const a3 = SHELL.setLocal(after, 'states.press', { fill: { token: 'accentInk' }, scale: 0.97, opacity: 0.8 });
  assert.deepEqual(SHELL.stateEditPhrases(after, a3, 'Кнопка', ctx), ['Нажатие «Кнопка»: масштаб 97 %, непрозрачность 80 %, заливка акцент тёмный']);
  // снятие состояния и поля
  assert.deepEqual(SHELL.stateEditPhrases(after, SHELL.setLocal(after, 'states', undefined), 'Кнопка', ctx), ['Наведение «Кнопка»: убрано']);
  assert.deepEqual(SHELL.stateEditPhrases(after, SHELL.setLocal(after, 'states.hover.shadow', undefined), 'Кнопка', ctx), ['Наведение «Кнопка»: тень убрана']);
  // только движение — своей фразой
  assert.deepEqual(SHELL.stateEditPhrases(after, SHELL.setLocal(after, 'motion.easing', 'spring'), 'Кнопка', ctx), ['Движение «Кнопка»: кривая «пружина»']);
  assert.deepEqual(SHELL.stateEditPhrases(after, SHELL.setLocal(after, 'motion.duration', 'motion.slow'), 'Кнопка', ctx), ['Движение «Кнопка»: 120 мс → 320 мс']);
  // тени «нет» — «без тени»; ничего не поменялось — ничего не сказано
  assert.deepEqual(SHELL.stateEditPhrases(after, SHELL.setLocal(after, 'states.hover.shadow', 'none'), 'К', ctx), ['Наведение «К»: без тени']);
  assert.deepEqual(SHELL.stateEditPhrases(after, after, 'Кнопка', ctx), []);
  // без токенов документа — умолчания ядра
  assert.equal(SHELL.motionMs('motion.base', null), 200);
  assert.equal(SHELL.motionMs(90, null), 90);
  assert.equal(SHELL.motionMs('motion.huge', null), undefined);
});

test('r36: где состояния бывают, есть ли они у слоя и в доске', () => {
  for (const t of ['frame', 'text', 'rect', 'ellipse', 'image', 'instance']) assert.ok(SHELL.canHaveStates({ type: t }), t);
  assert.equal(SHELL.canHaveStates({ type: 'page' }), false);
  assert.equal(SHELL.hasStates({ type: 'frame' }), false);
  assert.equal(SHELL.hasStates({ type: 'frame', states: { hover: {} } }), false);
  assert.equal(SHELL.hasStates({ type: 'frame', states: { press: { scale: 0.97 } } }), true);
  assert.deepEqual(SHELL.statesOf({ states: { focus: { lift: 2 }, hover: { lift: 2 } } }), ['hover', 'focus']);
  const doc = {
    nodes: {
      ab: { id: 'ab', type: 'frame', children: ['c'] },
      c: { id: 'c', type: 'frame', children: ['i'] },
      i: { id: 'i', type: 'instance', of: 'm' },
      m: { id: 'm', type: 'frame', children: [], states: { hover: { lift: 2 } } },
      ab2: { id: 'ab2', type: 'frame', children: [] },
    },
  };
  assert.equal(SHELL.subtreeHasStates(doc, 'ab'), true, 'экземпляр компонента с состояниями');
  assert.equal(SHELL.subtreeHasStates(doc, 'ab2'), false);
});

test('r36: оболочка — просмотр, раздел «Состояния», значок, экспорт и подсказка на месте', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('styles.css');
  // кнопка в панели масштаба и плашка
  const viewbar = html.slice(html.indexOf('id="viewbar"'), html.indexOf('id="dock"'));
  assert.match(viewbar, /id="btn-preview"[^>]*aria-pressed="false"/);
  assert.match(viewbar, /Просмотр/);
  assert.match(html, /id="previewbar"[^>]*hidden/);
  assert.match(html, /Просмотр — наведите на элементы/);
  // P и Esc, сцена — через проверку наличия
  assert.match(app, /e\.key\.toLowerCase\(\) === 'p' && bare/);
  assert.match(app, /e\.key === 'Escape' && previewOn\(\)/);
  assert.match(app, /typeof stage\.setPreview !== 'function'/);
  assert.match(app, /typeof stage\.playState !== 'function'/);
  assert.match(app, /PLAY_STATE_MS = 1500/);
  // команды оболочки и в занятом агенте
  assert.match(app, /case 'preview':/);
  assert.match(app, /SHELL_WHILE_BUSY = new Set\([^)]*'preview'/);
  // инспектор: вкладки, поля, «Проиграть», «Убрать состояние» — всё через set-транзакции
  for (const w of ['Состояния', 'Скорость', 'Кривая', 'Подъём', 'Масштаб', 'Тень', 'Проиграть', 'Убрать состояние']) {
    assert.ok(app.includes(`'${w}'`), `в инспекторе нет «${w}»`);
  }
  assert.match(app, /SHELL\.stateWriteOps\(node, key, field, value\)/);
  // история: фразы состояний
  assert.match(app, /SHELL\.stateEditPhrases\(/);
  // слой с состояниями — метка; экспорт — пометка
  assert.match(app, /tagpill motion/);
  assert.match(app, /с микроанимациями \(откройте в браузере\)/);
  // подсказка
  assert.match(app, /оживи кнопки: подъём и тень при наведении/);
  // стили — в обеих темах через токены, без своих цветов
  const block = css.slice(css.indexOf('круг 36 (SPEC §11)'), css.indexOf('адаптивность'));
  assert.ok(block.length > 200, 'нет блока стилей круга 36');
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, 'цвета круга 36 — только токенами темы');
});

/* Ядро круга 36 приходит параллельно: когда оно знает `states`, правки инспектора
   проверяются им по-настоящему — применяются, отменяются точно и описываются словами. */
const doc0 = core.createDoc();
const anyFrame = Object.values(doc0.nodes).find((n) => n.type === 'frame' && !core.isArtboard(doc0, n.id) && n.type !== 'page');
const probe = anyFrame ? core.applyOps(doc0, [core.ops.set(anyFrame.id, 'states', { hover: { lift: 2 } })]) : { error: 'нет рамки' };
const coreKnowsStates = !probe.error && typeof core.Stage.prototype.setPreview === 'function';

test('r36: правки инспектора проходят ядро, отмена точная', { skip: coreKnowsStates ? false : 'ядро ещё без states (CORE круга 36)' }, () => {
  let doc = doc0;
  const id = anyFrame.id;
  const steps = [
    SHELL.stateWriteOps(doc.nodes[id], 'hover', 'lift', 'spacing.1'),
  ];
  const before = core.hashDoc ? core.hashDoc(doc) : JSON.stringify(doc.nodes[id]);
  const list = steps[0].map((o) => core.ops.set(id, o.path, o.value));
  const inv = core.invertOps(doc, list);
  const r = core.applyOps(doc, list);
  assert.ok(!r.error, JSON.stringify(r.error));
  doc = r.doc;
  assert.deepEqual(doc.nodes[id].states, { hover: { lift: 'spacing.1' } });
  const more = SHELL.stateWriteOps(doc.nodes[id], 'hover', 'shadow', 'shadow.md').map((o) => core.ops.set(id, o.path, o.value));
  const r2 = core.applyOps(doc, more);
  assert.ok(!r2.error, JSON.stringify(r2.error));
  const rm = SHELL.stateRemoveOps(r2.doc.nodes[id], 'hover').map((o) => core.ops.set(id, o.path, o.value));
  const r3 = core.applyOps(r2.doc, rm);
  assert.ok(!r3.error);
  assert.equal(r3.doc.nodes[id].states, undefined);
  const back = core.applyOps(doc, inv);
  assert.ok(!back.error);
  const after = core.hashDoc ? core.hashDoc(back.doc) : JSON.stringify(back.doc.nodes[id]);
  assert.equal(after, before, 'отмена возвращает документ как был');
});
