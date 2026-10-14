/**
 * Словарь оболочки — один на клиент и сервер (круг 24, SPEC §7, §10.5).
 *
 * Таблица «фраза → намерение» проверяется дважды: словарём оболочки (`shellIntent` из
 * src/shell.js — его зовёт app.js) и JEV сервера (`classify` из server/orchestrator/jev),
 * чьё событие `shell {action, args}` оболочка переводит обратно `shellIntentFromServer`.
 * Ответ обязан совпасть: фраза значит одно и то же по обе стороны сети.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shellIntent, shellEventOf, shellIntentFromServer, historyForServer, tooLargeWords,
  stoppedWriteWords, normSaid, numSaid,
} from '../src/shell.js';
import { classify } from '../server/orchestrator/jev/index.js';
import * as core from '../src/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const doc = core.createDoc();
const [route, week] = core.artboards(doc);
const titleId = Object.values(doc.nodes).find((n) => n.name === 'Заголовок экрана').id;

/** [фраза, намерение или null («работа для модели»), нужен ли документ клиента]. */
const TABLE = [
  ['стоп', { kind: 'stop' }],
  ['Стоп!', { kind: 'stop' }],
  ['хватит', { kind: 'stop' }],
  ['отмени', { kind: 'undo', times: 1 }],
  ['Отмени, пожалуйста', { kind: 'undo', times: 1 }],
  ['отмени последнюю правку', { kind: 'undo', times: 1 }],
  ['не так', { kind: 'undo', times: 1 }],
  ['отмени три раза', { kind: 'undo', times: 3 }],
  ['откати на 2 шага назад', { kind: 'undo', times: 2 }],
  ['отмени последние 30 раз', { kind: 'undo', times: 20 }],
  ['верни обратно', { kind: 'redo', times: 1 }],
  ['повтори правку', { kind: 'redo', times: 1 }],
  ['вперёд два раза', { kind: 'redo', times: 2 }],
  ['впиши', { kind: 'fit' }],
  ['впиши всё', { kind: 'fit', all: true }],
  ['вписать экран', { kind: 'fit', all: false }],
  ['приблизь', { kind: 'zoom', by: 1.25 }],
  ['отдали', { kind: 'zoom', by: 1 / 1.25 }],
  ['масштаб 150%', { kind: 'zoom', to: 1.5 }],
  ['сто процентов', { kind: 'zoom', to: 1 }],
  ['сними выделение', { kind: 'select', ids: [] }],
  ['история', { kind: 'sheet', what: 'history', tab: 'edits' }],
  ['покажи диалог', { kind: 'sheet', what: 'history', tab: 'chat' }],
  ['настройки', { kind: 'sheet', what: 'settings' }],
  ['покажи слои', { kind: 'rail', on: true }],
  ['спрячь слои', { kind: 'rail', on: false }],
  ['экспорт png', { kind: 'export', what: 'png' }],
  ['экспортируй в svg', { kind: 'export', what: 'svg' }],
  ['экспортируй', { kind: 'export', what: '' }],
  ['тёмная тема интерфейса', { kind: 'theme', mode: 'dark' }],
  ['светлый интерфейс', { kind: 'theme', mode: 'light' }],
  ['как в системе', { kind: 'theme', mode: 'auto' }],
  ['переключи тему', { kind: 'theme', mode: 'ask' }],
  ['новая доска', { kind: 'new-board' }],
  ['закрой варианты', { kind: 'variants-close' }],
  ['покажи второй экран', { kind: 'artboard', index: 1 }],
  ['покажи следующую доску', { kind: 'artboard', step: 1 }],
  ['вернись на предыдущий', { kind: 'artboard', step: -1 }],
  // нужны имена из документа клиента: сервер без него отдаёт их модели
  ['покажи сводку недели', { kind: 'artboard', id: week.id }, true],
  ['открой маршрут дня', { kind: 'artboard', id: route.id }, true],
  ['выдели заголовок экрана', { kind: 'select', ids: [titleId], name: 'Заголовок экрана' }, true],
  // работа для модели — по обе стороны
  ['повтори шапку три раза', null],
  ['добавь сводку недели', null],
  ['покажи три варианта шапки', null],
  ['сделай тёмную тему', null],
  ['добавь стоп-кран', null],
  ['открой вторник', null],
  ['покажи вторую кнопку', null],
  ['отмени скидку', null],
  ['', null],
];

const CTX = { doc, activeArtboardId: route.id };

test('словарь оболочки: таблица фраз → намерение (клиент)', () => {
  for (const [said, want] of TABLE) {
    assert.deepEqual(shellIntent(said, CTX), want, `«${said}»`);
  }
});

test('JEV сервера понимает те же фразы так же — через событие shell {action, args}', () => {
  for (const [said, want, needsDoc] of TABLE) {
    const v = classify(said, {});
    if (!want || needsDoc) {
      // без документа клиента формы с именами молчат: оболочка узнаёт их сама до сети
      assert.notEqual(v.kind, 'shell', `«${said}» на сервере стал командой оболочки: ${JSON.stringify(v)}`);
      continue;
    }
    assert.equal(v.kind, 'shell', `«${said}»: ${JSON.stringify(v)}`);
    assert.deepEqual(shellIntentFromServer({ action: v.action, args: v.args }), want, `«${said}» через сервер`);
    // и без документа клиент даёт то же самое
    assert.deepEqual(shellIntent(said), want, `«${said}» без документа`);
  }
});

test('JEV с документом узнаёт и формы с именами — тем же словарём', () => {
  for (const [said, want, needsDoc] of TABLE) {
    if (!needsDoc) continue;
    const v = classify(said, { doc, board: route.id });
    assert.equal(v.kind, 'shell', `«${said}»`);
    assert.deepEqual(shellIntentFromServer({ action: v.action, args: v.args }), want, `«${said}»`);
  }
});

test('JEV: режим вариантов и варианты словами — мимо словаря оболочки', () => {
  assert.equal(classify('стоп', { mode: 'variants' }).kind, 'variants');
  const v = classify('покажи два варианта шапки', {});
  assert.equal(v.kind, 'variants');
  assert.equal(v.n, 2);
  assert.equal(classify('покажи варианты', {}).kind, 'variants');
});

test('намерение → событие → намерение: круг без потерь для всей таблицы', () => {
  for (const [said, want] of TABLE) {
    if (!want) continue;
    const ev = shellEventOf(want);
    assert.equal(ev.action, want.kind);
    assert.ok(!('kind' in ev.args), 'kind в args не дублируется');
    assert.deepEqual(shellIntentFromServer(JSON.parse(JSON.stringify(ev))), want, `«${said}»`);
  }
  assert.equal(shellEventOf(null), null);
});

test('один словарь: ни app.js, ни JEV не держат своей копии регулярок', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  const jev = readFileSync(join(root, 'server/orchestrator/jev/index.js'), 'utf8');
  for (const name of ['RE_UNDO_BARE', 'RE_REDO_N', 'RE_STOP_BARE', 'RE_STOP', 'RE_THEME_DARK', 'RE_PICK', 'RE_SHOW']) {
    assert.ok(!new RegExp(`const ${name}\\b`).test(app), `app.js снова держит ${name}`);
    assert.ok(!new RegExp(`const ${name}\\b`).test(jev), `JEV снова держит ${name}`);
  }
  assert.match(app, /SHELL\.shellIntent\(/);
  assert.match(jev, /from '\.\.\/\.\.\/\.\.\/src\/shell\.js'/);
  // словарь без DOM и без состояния оболочки
  const shell = readFileSync(join(root, 'src/shell.js'), 'utf8');
  assert.ok(!/\b(document|window|state)\./.test(shell), 'src/shell.js обращается к DOM или state');
});

test('normSaid и numSaid: числа словом, цифрой и порядковые без ложных основ', () => {
  assert.equal(normSaid('  Покажи, «Сводку»!  '), 'покажи сводку');
  assert.equal(numSaid('три'), 3);
  assert.equal(numSaid('12'), 12);
  assert.equal(numSaid('второй'), 2);
  assert.equal(numSaid('вторник'), null);
  assert.equal(numSaid('пятница'), null);
});

test('память разговора для сервера: пять последних пар, строки до 500 символов', () => {
  const pairs = Array.from({ length: 8 }, (_, i) => ({ utterance: `команда ${i}`, summary: `итог ${i}` }));
  pairs.push({ utterance: '  ', summary: 'без реплики' });
  pairs.push({ utterance: 'д'.repeat(700), summary: 'и'.repeat(900) });
  const h = historyForServer(pairs);
  assert.equal(h.length, 5);
  assert.equal(h[0].utterance, 'команда 4');
  assert.ok(h.every((p) => p.utterance.length <= 500 && p.summary.length <= 500));
  assert.equal(h[4].utterance.length, 500);
  assert.deepEqual(historyForServer(null), []);
  assert.deepEqual(historyForServer([{ utterance: 'а' }]), [{ utterance: 'а', summary: '' }]);
});

test('слишком большая правка: понятная строка и что делать — по каждому пределу', () => {
  const lim = { txBytes: 4 * 1024 * 1024, opsPerTx: 5000, docNodes: 20000, docBytes: 24 * 1024 * 1024 };
  for (const limit of ['tx_bytes', 'ops_per_tx', 'doc_nodes', 'doc_bytes', undefined]) {
    const w = tooLargeWords({ code: 'too_large', limit }, lim);
    assert.match(w.title, /слишком большая/);
    assert.match(w.title, /не сохранена/);
    assert.ok(w.note.length > 20, `${limit}: что делать — не сказано`);
  }
  assert.match(tooLargeWords({ limit: 'tx_bytes' }, lim).note, /4 МБ/);
  assert.match(tooLargeWords({ limit: 'ops_per_tx' }, lim).note, /5 000 операций/);
  assert.match(tooLargeWords({ detail: { limit: 'doc_nodes' } }, lim).note, /20 000 узлов/);
  // отказ сервера без limit (413 body_bytes) — тоже понятная строка
  assert.match(tooLargeWords({}).note, /по частям/);
});

test('«стоп» после записи: строка честная и зовёт отменить', () => {
  const w = stoppedWriteWords({ title: 'Крупнее заголовок' }, 'сделай заголовок крупнее');
  assert.equal(w.title, 'Агент успел записать правку до остановки — можно отменить');
  assert.match(w.note, /Крупнее заголовок/);
  assert.match(w.note, /Ctrl\+Z/);
  assert.match(stoppedWriteWords(null, 'сделай синим').note, /сделай синим/);
});
