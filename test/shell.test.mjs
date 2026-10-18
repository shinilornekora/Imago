/**
 * Таблица команд оболочки — одна, в клиенте (круг 24; круг 38, SPEC §13).
 *
 * Таблица «фраза → намерение» проверяется `shellIntent` из src/shell.js — его зовёт app.js.
 * Закрытого классификатора на сервере больше нет (круг 38): команды оболочки узнаёт и
 * исполняет клиент; без документа (`isShellCommandText` — так спрашивает Orchestrator)
 * формы с именами слоёв и досок молчат. Событие `shell {action, args}` сервера прежней
 * версии оболочка ещё понимает (`shellIntentFromServer`) — круг туда-обратно проверяется.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shellIntent, shellEventOf, shellIntentFromServer, historyForServer, tooLargeWords,
  stoppedWriteWords, normSaid, numSaid, isShellCommandText, SHELL_COMMANDS, helpGroups,
} from '../src/shell.js';
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
  // круг 36 (SPEC §11.3): режим «Просмотр» — без модели
  ['просмотр', { kind: 'preview', on: true }],
  ['режим просмотра', { kind: 'preview', on: true }],
  ['Включи просмотр', { kind: 'preview', on: true }],
  ['покажи просмотр', { kind: 'preview', on: true }],
  ['выйди из просмотра', { kind: 'preview', on: false }],
  ['выключи режим просмотра', { kind: 'preview', on: false }],
  ['вернись к правке', { kind: 'preview', on: false }],
  ['закрой варианты', { kind: 'variants-close' }],
  ['покажи второй экран', { kind: 'artboard', index: 1 }],
  ['покажи следующую доску', { kind: 'artboard', step: 1 }],
  ['вернись на предыдущий', { kind: 'artboard', step: -1 }],
  // нужны имена из документа клиента: без него (isShellCommandText) — не команда
  ['покажи сводку недели', { kind: 'artboard', id: week.id }, true],
  ['открой маршрут дня', { kind: 'artboard', id: route.id }, true],
  ['выдели заголовок экрана', { kind: 'select', ids: [titleId], name: 'Заголовок экрана' }, true],
  // работа для модели
  ['повтори шапку три раза', null],
  ['добавь сводку недели', null],
  ['покажи три варианта шапки', null],
  ['сделай тёмную тему', null],
  ['добавь стоп-кран', null],
  ['добавь экран просмотра', null],
  ['сделай кнопку просмотра', null],
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

test('без документа: те же фразы — те же намерения; формы с именами молчат (isShellCommandText)', () => {
  for (const [said, want, needsDoc] of TABLE) {
    if (!want || needsDoc) {
      assert.equal(isShellCommandText(said), false, `«${said}» без документа стал командой оболочки`);
      continue;
    }
    assert.equal(isShellCommandText(said), true, `«${said}»`);
    assert.deepEqual(shellIntent(said), want, `«${said}» без документа`);
  }
});

test('слэш-формы: точные, на русском и латиницей, неизвестное имя — тоже команда оболочки', () => {
  const SLASH = [
    ['/масштаб 150', { kind: 'zoom', to: 1.5 }],
    ['/zoom 150', { kind: 'zoom', to: 1.5 }],
    ['/Масштаб 75 %', { kind: 'zoom', to: 0.75 }],
    ['/тема тёмная', { kind: 'theme', mode: 'dark' }],
    ['/тема', { kind: 'theme', mode: 'cycle' }],
    ['/удалить', { kind: 'delete' }],
    ['/выровнять влево', { kind: 'align', how: 'left' }],
    ['/отменить 3', { kind: 'undo', times: 3 }],
    ['/undo', { kind: 'undo', times: 1 }],
    ['/вписать всё', { kind: 'fit', all: true }],
    ['/вписать', { kind: 'fit' }],
    ['/доска 2', { kind: 'artboard', index: 1 }],
    ['/экспорт png', { kind: 'export', what: 'png' }],
    ['/помощь', { kind: 'help' }],
    ['/', { kind: 'palette' }],
  ];
  for (const [said, want] of SLASH) {
    assert.deepEqual(shellIntent(said, CTX), want, said);
    assert.equal(isShellCommandText(said), true, said);
  }
  // по имени — с документом
  assert.deepEqual(shellIntent('/доска сводка недели', CTX), { kind: 'artboard', id: week.id });
  assert.deepEqual(shellIntent('/выделить заголовок экрана', CTX), { kind: 'select', ids: [titleId], name: 'Заголовок экрана' });
  // ошибки набора — честно, агенту не уходят
  assert.equal(shellIntent('/масштаб много', CTX).kind, 'slash-bad');
  assert.equal(shellIntent('/масштаб 5000', CTX).kind, 'slash-bad');
  assert.equal(shellIntent('/дублировать 2', CTX).kind, 'slash-bad');
  assert.deepEqual(shellIntent('/взлетай', CTX), { kind: 'slash-unknown', name: 'взлетай' });
  assert.equal(isShellCommandText('/взлетай'), true);
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

test('одна таблица: ни app.js, ни сервер не держат своей копии регулярок; справка — из SHELL_COMMANDS', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  const NAMES = ['RE_UNDO_BARE', 'RE_REDO_N', 'RE_STOP_BARE', 'RE_STOP', 'RE_THEME_DARK', 'RE_PICK', 'RE_SHOW', 'RE_NEW_BOARD', 'RE_PREVIEW_ON', 'NATURAL', 'SLASH_NAMES'];
  for (const name of NAMES) assert.ok(!new RegExp(`const ${name}\\b`).test(app), `app.js снова держит ${name}`);
  assert.match(app, /SHELL\.shellIntent\(/);
  // сервер: ни одного своего словаря оболочки (закрытого классификатора больше нет)
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
  for (const f of walk(join(root, 'server'))) {
    const src = readFileSync(f, 'utf8');
    for (const name of NAMES) assert.ok(!new RegExp(`const ${name}\\b`).test(src), `${f} держит ${name}`);
    assert.ok(!/впиши вс[её]|отмени два раза|сними выделение/.test(src), `${f} держит фразы оболочки`);
  }
  // справка и палитра строятся из таблицы: в app.js нет ручного списка команд
  assert.match(app, /SHELL\.helpGroups\(\)/);
  assert.match(app, /SHELL\.paletteRows\(/);
  for (const c of SHELL_COMMANDS) {
    if (!c.edit) continue;
    assert.ok(!app.includes(`'${c.hint}'`), `app.js дублирует подсказку команды ${c.id}`);
  }
  assert.deepEqual(helpGroups().map((g) => g.group), ['Вид', 'Выделение', 'Правка', 'Доски', 'Панели', 'Файл', 'История', 'Агент', 'Справка']);
  // таблица без DOM и без состояния оболочки
  const shell = readFileSync(join(root, 'src/shell.js'), 'utf8');
  assert.ok(!/\b(document|window|state)\./.test(shell), 'src/shell.js обращается к DOM или state');
  // круг 38: о закрытом классификаторе в оболочке больше ни слова
  assert.ok(!/JEV/.test(shell), 'src/shell.js упоминает JEV');
  assert.ok(!/JEV/.test(app), 'app.js упоминает JEV');
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
  assert.match(tooLargeWords({ detail: { limit: 'doc_nodes' } }, lim).note, /20 000 слоёв/);
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

/* ------------------------------ круг 25 ------------------------------ */

test('dropped словами: что не применилось, почему и кто помешал', async () => {
  const { droppedWords, whoDid } = await import('../src/shell.js');
  const rename = { op: 'set', id: 'card', path: 'name', value: 'Новая' };
  const one = droppedWords({
    dropped: [{ index: 0, op: rename, reason: 'removed', by: { author: 'Аня', author_kind: 'human' } }],
    nameOf: (id) => (id === 'card' ? 'Карточка встречи' : ''),
  });
  assert.equal(one.title, 'Переименование «Карточка встречи» не применилось — Аня удалила этот слой');
  // применять было нечего — «остальное применено» не говорим
  assert.equal(one.note, '');
  // кто помешал — из реплики (whoRemoved), если сервер by не прислал; часть правки легла
  const two = droppedWords({
    dropped: [{ index: 1, op: { op: 'move', id: 'a' }, reason: 'removed' }, { index: 2, op: { op: 'set', id: 'b', path: 'fill' }, reason: 'removed' }],
    applied: 3,
    whoOf: () => ({ author: 'Борис', author_kind: 'human' }),
  });
  assert.equal(two.title, '2 правки не применились — Борис удалил эти слои');
  assert.equal(two.note, 'Остальное в правке применено.');
  // агент удалил; никто не известен
  assert.match(droppedWords({ dropped: [{ index: 0, op: { op: 'set', id: 'x', path: 'fill' }, reason: 'removed', by: { author: 'Агент', author_kind: 'agent' } }] }).title, /— агент удалил этот слой$/);
  assert.match(droppedWords({ dropped: [{ index: 0, op: { op: 'set', id: 'x', path: 'fill' }, reason: 'removed' }] }).title, /— этот слой уже удалён$/);
  // родитель удалён
  assert.match(droppedWords({ dropped: [{ index: 0, op: { op: 'create', node: { id: 'n', name: 'Кнопка', parent: 'p' } }, reason: 'orphan', by: { author: 'Вера' } }] }).title,
    /^Добавление «Кнопка» не применилось — Вера удалила слой, куда он добавлялся$/);
  // правка устарела после восстановления базы — свои слова
  const stale = droppedWords({ dropped: [{ index: 0, op: rename, reason: 'stale' }], nameOf: () => 'Шапка' });
  assert.ok(stale.stale);
  assert.match(stale.title, /^Переименование «Шапка» не применилось — правка сделана до восстановления базы/);
  assert.match(stale.note, /заново/);
  assert.match(droppedWords({ dropped: [{ index: 0, op: rename, reason: 'stale', by: { author: 'Аня' } }], nameOf: () => 'Шапка' }).title,
    /не применилось — с тех пор Аня изменила то же самое, а эта правка сделана до восстановления базы/);
  // своё переименование уже в имени слоя — говорим, во что переименовывали
  assert.equal(droppedWords({ dropped: [{ index: 0, op: rename, reason: 'removed', by: { author: 'Аня' } }], nameOf: () => 'Новая' }).title,
    'Переименование в «Новая» не применилось — Аня удалила этот слой');
  // выжимка журнала {more: N} — в счёт, не в причины
  assert.match(droppedWords({ dropped: [{ index: 0, op: rename, reason: 'removed' }, { more: 4 }] }).title, /^5 правок не применились/);
  // правка агента
  assert.match(droppedWords({ dropped: [{ index: 0, op: rename, reason: 'removed', by: { author: 'Аня' } }], agent: true, nameOf: () => 'Шапка' }).title,
    /^Переименование «Шапка» от агента не применилось — Аня удалила/);
  // род по имени: где не угадать — «удалил(а)»
  assert.equal(whoDid({ author: 'Никита' }, 'удалил'), 'Никита удалил');
  assert.equal(whoDid({ author: 'Саша' }, 'удалил'), 'Саша удалил(а)');
  assert.equal(whoDid({ author: 'Мария Петрова' }, 'удалил'), 'Мария Петрова удалила');
  assert.equal(whoDid(null, 'удалил'), 'кто-то удалил');
  assert.equal(whoDid({ author: '  ' }, 'удалил'), 'кто-то удалил');
});

test('строки по кодовым точкам и без служебного', async () => {
  const { cutText, cleanText, isJargon } = await import('../src/shell.js');
  assert.equal(cutText('ab😀cd', 3), 'ab😀');
  assert.equal(cutText('абвгдеж', 4, { ellipsis: true }), 'абв…');
  assert.equal(cutText('коротко', 40), 'коротко');
  assert.equal(Array.from(cutText('😀'.repeat(50), 40)).length, 40);
  assert.equal(cleanText('  а\u0001б \n в\u200b '), 'а б в');
  // \u0000 core.cleanText выбрасывает вовсе (jsonb его не принимает)
  assert.equal(cleanText('а\u0000б'), 'аб');
  for (const bad of ['Failed to fetch', 'http://localhost:1234/v1', 'сервер ответил 503', 'ответ не JSON', 'tx_abc123def456']) {
    assert.ok(isJargon(bad), bad);
  }
  for (const ok of ['Правка слишком большая: 6000 операций', 'Модель на сервере не отвечает']) assert.ok(!isJargon(ok), ok);
});

test('серверная сборка: модель браузера по умолчанию выключена, соло — включена', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../tools/build.mjs', import.meta.url), 'utf8');
  const m = /const defaultsFor = \(serverMode\) => \(serverMode\s*\?\s*`([\s\S]*?)`\s*:\s*`([\s\S]*?)`\);/.exec(src);
  assert.ok(m, 'defaultsFor не найден');
  assert.match(m[1], /server: true/);
  assert.match(m[1], /enabled: false/);
  assert.match(m[2], /server: false/);
  assert.match(m[2], /enabled: true/);
});

/* ------------------------------ круг 27 ------------------------------ */
import {
  arrivedTxOf, detachedVerdict, stoppedRunVerdict, userNodeCount, shuttingDownWords,
  OFFLINE_WORDS, PROJECT_GONE_WORDS, DETACHED_TIMES,
} from '../src/shell.js';

test('круг 27, п.1: транзакция команды, пришедшая до обрыва потока, находится по command_id', () => {
  const arrived = new Map([
    ['tx_other', { tx: { tx_id: 'tx_other', command_id: 'cmd_b' }, mine: true, at: 5 }],
    ['tx_mine', { tx: { tx_id: 'tx_mine', command_id: 'cmd_a' }, mine: true, at: 6 }],
  ]);
  assert.equal(arrivedTxOf(arrived, { commandId: 'cmd_a', startedAt: 0 }), 'tx_mine');
  assert.equal(arrivedTxOf(arrived, { commandId: 'cmd_z', startedAt: 0 }), null);
  // Orchestrator без command_id: своя транзакция агента после начала команды
  const old = new Map([
    ['tx_before', { tx: { tx_id: 'tx_before' }, mine: true, at: 10 }],
    ['tx_alien', { tx: { tx_id: 'tx_alien' }, mine: false, at: 30 }],
    ['tx_after', { tx: { tx_id: 'tx_after' }, mine: true, at: 30 }],
  ]);
  assert.equal(arrivedTxOf(old, { commandId: 'cmd_a', startedAt: 20 }), 'tx_after');
  assert.equal(arrivedTxOf(null, { commandId: 'cmd_a' }), null);
});

test('круг 27, п.1: пришедшая транзакция главнее нового instance — «не выполнена» не говорим', () => {
  const T = DETACHED_TIMES;
  // вход: транзакция уже пришла — health не спрашиваем
  const d0 = { at: 0, instance: 'orch_1', wasDown: false, downSince: 0 };
  assert.deepEqual(detachedVerdict(d0, { health: undefined, arrivedId: 'tx_1' }), { verdict: 'arrived', txId: 'tx_1' });
  assert.deepEqual(detachedVerdict(d0, { health: undefined, arrivedId: null }), { verdict: 'wait' });
  // шаг: ответил другой процесс, но транзакция среди пришедших — это успех, а не потеря
  const d1 = { at: 0, instance: 'orch_1', wasDown: false, downSince: 0 };
  const h2 = { ok: true, instance: 'orch_2' };
  assert.deepEqual(detachedVerdict(d1, { health: h2, now: 1000, arrivedId: 'tx_1' }), { verdict: 'arrived', txId: 'tx_1' });
  assert.deepEqual(detachedVerdict(d1, { health: h2, now: 1000, arrivedId: null }), { verdict: 'lost', why: 'restarted' });
  // тот же процесс — ждём полный срок
  const d2 = { at: 0, instance: 'orch_1', wasDown: false, downSince: 0 };
  assert.deepEqual(detachedVerdict(d2, { health: { ok: true, instance: 'orch_1' }, now: 1000 }), { verdict: 'wait' });
  assert.deepEqual(detachedVerdict(d2, { health: { ok: true, instance: 'orch_1' }, now: T.waitMs }), { verdict: 'lost', why: 'silent' });
  // instance неизвестен: был недоступен и вернулся — перезапуск; лежит дольше grace — down
  const d3 = { at: 0, instance: '', wasDown: false, downSince: 0 };
  assert.deepEqual(detachedVerdict(d3, { health: { ok: false }, now: 100 }), { verdict: 'wait' });
  assert.deepEqual(detachedVerdict(d3, { health: { ok: true }, now: 200 }), { verdict: 'lost', why: 'restarted' });
  const d4 = { at: 0, instance: '', wasDown: false, downSince: 0 };
  detachedVerdict(d4, { health: { ok: false }, now: 100 });
  assert.deepEqual(detachedVerdict(d4, { health: { ok: false }, now: 100 + T.downGraceMs }), { verdict: 'lost', why: 'down' });
  // сеть пропала у всей вкладки — ждём полный срок, даже если health молчит
  const d5 = { at: 0, instance: '', wasDown: false, downSince: 0 };
  assert.deepEqual(detachedVerdict(d5, { health: { ok: false }, netDown: true, now: 100 + T.downGraceMs }), { verdict: 'wait' });
  assert.deepEqual(detachedVerdict(d5, { health: { ok: false }, netDown: true, now: T.waitMs }), { verdict: 'lost', why: 'down' });
});

test('круг 27, п.2: «стоп» после записи — «успел записать» не затирается «остановлена»', () => {
  assert.equal(stoppedRunVerdict({ settled: true }), 'settled');
  assert.equal(stoppedRunVerdict({ settled: true, replacing: true }), 'settled');
  assert.equal(stoppedRunVerdict({ replacing: true }), 'replaced');
  assert.equal(stoppedRunVerdict({}), 'cancelled');
  // оболочка проводит признак: noteStoppedCommand → e.settled → catch runUtterance
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  assert.match(app, /if \(noteStoppedCommand\(commandId, utterance, \{ startedAt \}\)\) e\.settled = true;/);
  assert.match(app, /stoppedRunVerdict\(\{ settled: !!e\.settled, replacing: replacingRun \}\)/);
});

test('круг 27, I7: пустой проект — без пользовательских узлов', () => {
  assert.equal(userNodeCount(core.createDoc('empty')), 0);
  const lib = core.ensureLibrary ? core.ensureLibrary(core.createDoc('empty')) : null;
  if (lib && lib.nodes) assert.equal(userNodeCount(lib), 0);
  assert.ok(userNodeCount(core.createDoc()) > 5);
  assert.equal(userNodeCount(null), 0);
});

test('круг 27: слова — перезапуск агента с очередью, офлайн, пропавший проект', () => {
  const one = shuttingDownWords();
  assert.equal(one.title, 'Сервер агента перезапускается — команда не выполнена');
  assert.doesNotMatch(one.note, /очеред/);
  const more = shuttingDownWords(['собери экран оплаты', 'сделай заголовок крупнее']);
  assert.match(more.note, /«собери экран оплаты», «сделай заголовок крупнее»/);
  assert.match(more.note, /Повторить/);
  assert.match(OFFLINE_WORDS.title, /^Нет сети/);
  assert.doesNotMatch(OFFLINE_WORDS.title + OFFLINE_WORDS.note, /сервер агента/i);
  assert.equal(PROJECT_GONE_WORDS.action, 'Сохранить как новый проект');
  assert.match(PROJECT_GONE_WORDS.note, /цела в этом браузере/);
  assert.match(PROJECT_GONE_WORDS.note, /перезагрузки/);
});

/* ------------------------------ круг 29 ------------------------------ */

test('круг 29, Д2: «Сохранить как новый» для документа больше 4 МБ — остов и пачки ≤ 3,5 МБ, hashDoc совпадает', async () => {
  const { rescuePlan, utf8Bytes, RESCUE_TX_BYTES } = await import('../src/shell.js');
  let doc = core.createDoc();
  const board = core.artboards(doc)[0].id;
  // вложенность: рамки в рамках, в каждой — длинные тексты (кириллица — по 2 байта)
  const list = [];
  let n = 0;
  for (let f = 0; f < 40; f++) {
    const fid = `f_big_${f}`;
    list.push(core.ops.create({ type: 'frame', id: fid, name: `Рамка ${f}`, parent: board, layout: { mode: 'column', gap: 8 }, size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }));
    const inner = `f_in_${f}`;
    list.push(core.ops.create({ type: 'frame', id: inner, name: `Внутри ${f}`, parent: fid, size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }));
    for (let i = 0; i < 60; i++) {
      list.push(core.ops.create({ type: 'text', id: `t_${n++}`, name: `т${f}_${i}`, parent: i % 2 ? inner : fid, characters: 'текст '.repeat(220), style: { token: 'body' }, color: 'muted', align: 'left' }));
    }
  }
  const r0 = core.applyOps(doc, list);
  assert.ok(!r0.error, r0.error && r0.error.message);
  doc = r0.doc;
  const want = core.hashDoc(doc);
  const bytes = utf8Bytes(JSON.stringify({ name: 'спасённый', doc }));
  assert.ok(bytes > 6 * 1024 * 1024, `документ ${bytes} байт`);

  const plan = rescuePlan(doc, { name: 'спасённый' });
  assert.equal(plan.whole, false);
  assert.ok(plan.batches.length >= 2, `пачек ${plan.batches.length}`);
  assert.deepEqual(plan.oversize, []);
  assert.ok(utf8Bytes(JSON.stringify(plan.body)) < 64 * 1024, 'остов маленький');
  for (const b of plan.batches) {
    assert.ok(utf8Bytes(JSON.stringify(b)) <= RESCUE_TX_BYTES, 'пачка не больше 3,5 МБ');
    assert.ok(b.length <= 5000);
  }
  // сервер: createDoc(остов) → пачки по порядку applyOps — тот же документ
  let got = core.createDoc(plan.body.doc);
  for (const b of plan.batches) {
    const r = core.applyOps(got, b);
    assert.ok(!r.error, r.error && r.error.message);
    got = r.doc;
  }
  assert.equal(core.hashDoc(got), want);
  assert.equal(Object.keys(got.nodes).length, Object.keys(doc.nodes).length);

  // библиотека — в остове (миграция у того, кто откроет проект посреди досылки, не заведёт вторую)
  const lib = core.libraryNode(doc);
  assert.ok(lib && plan.body.doc.nodes[lib.id], 'библиотеки нет в остове');
  // библиотека посередине детей корня — порядок тот же
  const root = doc.nodes[doc.root];
  const mid = { ...doc, nodes: { ...doc.nodes, [doc.root]: { ...root, children: [root.children[0], lib.id, ...root.children.filter((id) => id !== lib.id).slice(1)] } } };
  const plan2 = rescuePlan(mid, { maxBytes: 1024 * 1024 });
  let got2 = core.createDoc(plan2.body.doc);
  for (const b of plan2.batches) { const r = core.applyOps(got2, b); assert.ok(!r.error, r.error && r.error.message); got2 = r.doc; }
  assert.deepEqual(got2.nodes[doc.root].children, mid.nodes[doc.root].children);
  assert.equal(core.hashDoc(got2), core.hashDoc(mid));

  // небольшой документ — одним телом, как прежде
  const small = rescuePlan(core.createDoc(), { name: 'малый' });
  assert.equal(small.whole, true);
  assert.equal(small.batches.length, 0);
  assert.equal(core.hashDoc(core.createDoc(small.body.doc)), core.hashDoc(core.createDoc(small.body.doc)));
});

test('круг 29, J5/J6/п.7: слова not_applied, пропавшего проекта, подписей и кодов', async () => {
  const { agentErrorWords, txTitleWords, errorCodeWords, isModelError } = await import('../src/shell.js');
  const na = agentErrorWords({ code: 'not_applied', message: 'Ни одну правку не удалось применить: слой «Шапка» не найден', detail: { hint: 'name_layer' } });
  assert.equal(na.title, 'Не получилось применить правку: слой «Шапка» не найден');
  assert.match(na.note, /Назовите слой/);
  // круг 31: совет — только по hint (сервер — detail.hint, brain — hint); «нет раскладки» — без совета
  assert.match(agentErrorWords({ code: 'not_applied', message: 'слой «Шапка» не найден', hint: 'name_layer' }).note, /Назовите слой/);
  assert.equal(agentErrorWords({ code: 'not_applied', message: 'у текста «Заголовок» нет раскладки' }).note, '');
  assert.equal(agentErrorWords({ code: 'not_applied', message: 'invalid_ops: bad' }).title, 'Не получилось применить правку');
  assert.equal(isModelError({ code: 'not_applied' }), false);
  const nf = agentErrorWords({ code: 'not_found', message: 'проект не найден' });
  assert.doesNotMatch(nf.title + nf.note, /Откройте проект заново/);
  assert.match(nf.note, /новым проектом/);
  const vnf = agentErrorWords({ code: 'not_found', message: 'Варианты этой команды не найдены или устарели — попросите их заново' });
  assert.equal(vnf.title, 'Варианты этой команды не найдены или устарели');
  assert.equal(vnf.note, 'попросите их заново');
  assert.equal(txTitleWords('Свойство'), 'Изменил свойство');
  assert.equal(txTitleWords('Удалить «Ярлыки»'), 'Удалил «Ярлыки»');
  assert.equal(txTitleWords('Отмена: Удалить «Ярлыки»'), 'Отменил: удалил «Ярлыки»');
  assert.equal(txTitleWords('Переименовал «Шапка» в «Шапка Ани»'), 'Переименовал «Шапка» в «Шапка Ани»');
  assert.equal(errorCodeWords('llm_failed'), 'модель ответила ошибкой');
  assert.doesNotMatch(errorCodeWords('whatever_code'), /[a-z]/);
  assert.doesNotMatch(stoppedWriteWords({ title: 'x' }).note, /ниже/);
});

/* ------------------------------ круг 31 ------------------------------ */

test('shell r31 (K2): база данных лежит — «База данных сервера недоступна — команда не выполнена»', async () => {
  const S = await import('../src/shell.js');
  const w = S.agentErrorWords({ code: 'document_down', document_reason: 'storage', retryAfterMs: 5000 });
  assert.equal(w.title, 'База данных сервера недоступна — команда не выполнена');
  assert.equal(w.waitMs, 5000);
  assert.doesNotMatch(w.note, /сервер документа не отвечает/);
  // причина в detail (как её может прислать Orchestrator) — те же слова
  assert.equal(S.agentErrorWords({ code: 'document_down', detail: { document_reason: 'storage' } }).title, w.title);
  // без причины — прежние слова
  assert.equal(S.agentErrorWords({ code: 'document_down' }).title, 'Сервер агента не видит документ');
  const n = S.agentHealthNotice({ ok: true, document: 'up', llm: 'up' }, { ok: true, document: 'down', document_reason: 'storage', llm: 'up' });
  assert.match(n.text, /база данных сервера недоступна/);
  assert.doesNotMatch(n.text, /сервер документа не отвечает/);
  assert.match(S.retryLabel(5000, 'document_down', { document_reason: 'storage' }), /^База данных сервера недоступна — повторю через 5 с$/);
  assert.match(S.agentModeTitle('server', { ok: true, document: 'down', document_reason: 'storage', llm: 'up' }), /база данных/);
});

test('shell r31 (K3): внутренняя ошибка, непонятный ответ модели — свои слова', async () => {
  const S = await import('../src/shell.js');
  assert.equal(S.agentErrorWords({ code: 'internal', message: 'TypeError: x is undefined' }).title, 'Внутренняя ошибка агента — сообщите администратору');
  assert.doesNotMatch(S.agentErrorWords({ code: 'internal', message: 'TypeError: x is undefined' }).note, /TypeError/);
  assert.equal(S.agentErrorWords({ code: 'llm_bad_response', message: 'ответ модели не JSON' }).title, 'Ответ модели не удалось разобрать — попробуйте ещё раз');
});

test('shell r31 (m7): чья правка — в родительном падеже; несклоняемое — в скобках', async () => {
  const S = await import('../src/shell.js');
  assert.equal(S.editOf({ author: 'Борис' }), 'правки Бориса');
  assert.equal(S.editOf({ author: 'Аня' }), 'правки Ани');
  assert.equal(S.editOf({ author: 'Ольга' }), 'правки Ольги');
  assert.equal(S.editOf({ author: 'Андрей' }), 'правки Андрея');
  assert.equal(S.editOf({ author: 'Вера' }), 'правки Веры');
  assert.equal(S.editOf({ author: 'Анна Ковалёва' }), 'правки (Анна Ковалёва)');
  assert.equal(S.editOf({ author: 'Bob' }), 'правки (Bob)');
  assert.equal(S.editOf({ author_kind: 'agent' }), 'правки агента');
  assert.equal(S.editOf(null), 'чужой правки');
});

test('shell r31: оболочка — слова круга 31 на месте (корень без базы, «Проекты», вторая вкладка, импорт)', () => {
  const app = readFileSync(join(root, 'app.js'), 'utf8');
  for (const s of ['База данных сервера недоступна', 'Попробовать снова', 'эта правка сделана в другой вкладке — отменить её можно там',
    'Список не пришёл — база данных сервера недоступна', 'Агент не нашёл, что поменять', 'importTooBigWords']) {
    assert.ok(app.includes(s), `в app.js нет «${s}»`);
  }
  // r.tx.id после commitDoc — только после проверки r.ok (круг 31, UX Д1)
  const imp = app.slice(app.indexOf('function importJson()'), app.indexOf('function docName('));
  assert.ok(imp.indexOf('!r.ok') > 0 && imp.indexOf('!r.ok') < imp.indexOf('undoTx(r.tx.id)'), 'импорт проверяет r.ok до r.tx.id');
  // демо-макет в серверной сборке не показывается, пока сервер не ответил
  assert.match(app, /function serverBuild\(\)/);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /id="net-pill"/);
});
