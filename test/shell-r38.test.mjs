/**
 * Круг 38 (SPEC §13): JEV исключён — команды оболочки стали открытой таблицей в клиенте.
 *
 * Проверяется: таблица `SHELL_COMMANDS` (форма, уникальные слэш-имена, группы), что каждая
 * фраза и каждая слэш-форма из таблицы узнаётся как своя команда, что явная команда без
 * документа узнаётся `isShellCommandText` (так спрашивает Orchestrator) и что работа для
 * агента ею не считается; правки новых команд — операции ядра: проходят `applyOps`, документ
 * остаётся годным, отмена одной инверсией точна; палитра и справка строятся из таблицы;
 * разметка палитры доступна с клавиатуры. Браузерный прогон — Playwright (scratchpad/s38).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';
import { STAGE_KEYS } from '../src/agent.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const doc = core.createDoc();
const [route, week] = core.artboards(doc);
const byName = (d, name) => Object.values(d.nodes).find((n) => n.name === name);
const CTX = { doc, activeArtboardId: route.id };

/** Пример аргумента для слэш-формы команды. */
function sampleArg(c) {
  const a = c.args && c.args[0];
  if (!a || a.optional) return '';
  if (a.values) return ` ${a.values[0]}`;
  if (a.kind === 'number') return ' 150';
  if (c.id === 'board') return ' 2';
  return c.id === 'rename' ? ' Новое имя' : ' заголовок экрана';
}

/** Применить правку и проверить: документ годен, отмена одной инверсией — как было. */
function roundtrip(d, r, msg) {
  assert.ok(r && !r.error, `${msg}: ${r && r.error}`);
  assert.ok(Array.isArray(r.ops) && r.ops.length, `${msg}: операций нет`);
  const inv = core.invertOps(d, r.ops);
  const res = core.applyOps(d, r.ops);
  assert.ok(!res.error, `${msg}: ${res.error && res.error.message}`);
  if (typeof core.checkImportDoc === 'function') {
    const chk = core.checkImportDoc(res.doc);
    assert.ok(!chk || chk.ok !== false, `${msg}: документ после правки негоден ${JSON.stringify(chk && chk.error)}`);
  }
  const back = core.applyOps(res.doc, inv);
  assert.ok(!back.error, `${msg}: отмена ${back.error && back.error.message}`);
  assert.equal(core.hashDoc(back.doc), core.hashDoc(d), `${msg}: отмена не вернула документ`);
  return res.doc;
}

test('r38: таблица — замороженная, id и слэш-имена уникальны, группы по порядку, у записей нужные поля', () => {
  assert.ok(Object.isFrozen(SHELL.SHELL_COMMANDS));
  assert.ok(SHELL.SHELL_COMMANDS.length >= 45, `команд всего ${SHELL.SHELL_COMMANDS.length}`);
  const ids = new Set();
  const slashes = new Map();
  for (const c of SHELL.SHELL_COMMANDS) {
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.slash) && Object.isFrozen(c.phrases), c.id);
    assert.ok(!ids.has(c.id), `id ${c.id} дважды`);
    ids.add(c.id);
    assert.ok(SHELL.SHELL_GROUPS.includes(c.group), `${c.id}: группа ${c.group}`);
    assert.equal(typeof c.title, 'string');
    assert.ok(c.title.length > 1, c.id);
    assert.equal(typeof c.edit, 'boolean', c.id);
    for (const s of c.slash) {
      const k = s.toLowerCase().replace(/ё/g, 'е');
      assert.ok(!slashes.has(k), `слэш «${s}» у ${c.id} и ${slashes.get(k)}`);
      slashes.set(k, c.id);
    }
    if (c.inPalette !== false) assert.ok(c.slash.length, `${c.id}: без слэш-формы`);
    for (const a of c.args || []) assert.ok(['number', 'text', 'enum'].includes(a.kind), `${c.id}: аргумент ${a.kind}`);
  }
  const groups = SHELL.helpGroups();
  assert.deepEqual(groups.map((g) => g.group), [...SHELL.SHELL_GROUPS]);
  assert.equal(groups.reduce((n, g) => n + g.commands.length, 0), SHELL.SHELL_COMMANDS.length, 'справка теряет команды');
  // новые команды круга на месте
  for (const id of ['select-all', 'select-parent', 'select-children', 'select-next', 'select-prev', 'delete', 'duplicate',
    'rename', 'hide', 'show', 'lock', 'unlock', 'raise', 'lower', 'to-start', 'to-end', 'wrap', 'ungroup', 'align',
    'direction', 'gap-more', 'gap-less', 'fit-selection', 'inspector', 'scales', 'import', 'help']) {
    assert.ok(SHELL.shellCommand(id), `нет команды ${id}`);
  }
  // правки помечены, у правок выделенного — needs
  for (const id of ['duplicate', 'wrap', 'align', 'gap-more', 'rename']) {
    assert.equal(SHELL.shellCommand(id).edit, true, id);
    assert.equal(SHELL.shellCommand(id).needs, 'selection', id);
  }
});

test('r38: каждая фраза и каждая слэш-форма таблицы узнаётся как своя команда', () => {
  const bad = [];
  for (const c of SHELL.SHELL_COMMANDS) {
    if (!c.byAgent) {
      for (const p of c.phrases) {
        const got = SHELL.commandIdOf(SHELL.shellIntent(p, CTX));
        if (got !== c.id) bad.push(`фраза «${p}» → ${got}, ждали ${c.id}`);
      }
    }
    const forms = c.slash.map((s) => `/${s}${sampleArg(c)}`);
    if (c.example) forms.push(c.example);
    for (const f of forms) {
      const got = SHELL.commandIdOf(SHELL.shellIntent(f, CTX));
      if (got !== c.id) bad.push(`«${f}» → ${got}, ждали ${c.id}`);
      if (!SHELL.isShellCommandText(f)) bad.push(`«${f}»: isShellCommandText false`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  // варианты считает агент: фразы ему, слэш-форма — команда оболочки, которая их запускает
  assert.equal(SHELL.shellIntent('покажи три варианта шапки', CTX), null);
  assert.deepEqual(SHELL.shellIntent('/варианты', CTX), { kind: 'variants' });
});

test('r38: явная команда без документа — да; работа для агента — нет', () => {
  for (const said of ['отмени', 'впиши всё', '/zoom 100', '/масштаб 150', '/тема тёмная', '/удалить',
    '/выровнять влево', 'дублируй', 'сгруппируй', 'переименуй в «Шапка»', 'расположи в колонку', 'зазор больше',
    'выдели всё', 'команды', 'что ты умеешь', '/что-то-незнакомое']) {
    assert.equal(SHELL.isShellCommandText(said), true, `«${said}»`);
  }
  for (const said of ['сделай кнопку синей', 'удали шапку', 'удали всё', 'продублируй карточку встречи', 'выровняй по центру',
    'выровняй подпись кнопки по центру', 'переименуй заголовок в Привет', 'открепи от сетки', 'сделай тёмную тему',
    'скопируй кнопку', 'покажи три варианта', 'нарисуй милого монстра', 'подними кнопку выше', 'добавь зазор между карточками',
    'выдели заголовок экрана', 'покажи сводку недели', '', '   ', 'путь /usr/bin']) {
    assert.equal(SHELL.isShellCommandText(said), false, `«${said}»`);
  }
});

test('r38: слэш-форма точна — регистр, «ё», проценты, аргументы; ошибки набора честные', () => {
  assert.deepEqual(SHELL.shellIntent('/МАСШТАБ 150%'), { kind: 'zoom', to: 1.5 });
  assert.deepEqual(SHELL.shellIntent('  /zoom 200 %'), { kind: 'zoom', to: 2 });
  assert.deepEqual(SHELL.shellIntent('/вписать все'), { kind: 'fit', all: true });
  assert.deepEqual(SHELL.shellIntent('/тема темная'), { kind: 'theme', mode: 'dark' });
  assert.deepEqual(SHELL.shellIntent('/тема системная'), { kind: 'theme', mode: 'auto' });
  assert.deepEqual(SHELL.shellIntent('/просмотр выкл'), { kind: 'preview', on: false });
  assert.deepEqual(SHELL.shellIntent('/слои скрыть'), { kind: 'rail', on: false });
  assert.deepEqual(SHELL.shellIntent('/инспектор'), { kind: 'inspector', on: true });
  assert.deepEqual(SHELL.shellIntent('/отменить три'), { kind: 'undo', times: 3 });
  assert.deepEqual(SHELL.shellIntent('/повторить 50'), { kind: 'redo', times: 20 });
  assert.deepEqual(SHELL.shellIntent('/выровнять по центру'), { kind: 'align', how: 'center' });
  assert.deepEqual(SHELL.shellIntent('/выровнять растянуть'), { kind: 'align', how: 'stretch' });
  assert.deepEqual(SHELL.shellIntent('/направление колонка'), { kind: 'direction', mode: 'column' });
  assert.deepEqual(SHELL.shellIntent('/зазор+'), { kind: 'gap', step: 1 });
  assert.deepEqual(SHELL.shellIntent('/переименовать «Шапка экрана»'), { kind: 'rename', name: 'Шапка экрана' });
  // регистр имени сохраняется, как набран
  assert.deepEqual(SHELL.shellIntent('переименуй в Главная Страница'), { kind: 'rename', name: 'Главная Страница' });
  assert.deepEqual(SHELL.shellIntent('/доска 2'), { kind: 'artboard', index: 1 });
  assert.deepEqual(SHELL.shellIntent('/доска второй', CTX), { kind: 'artboard', index: 1 });
  assert.deepEqual(SHELL.shellIntent('/экспорт'), { kind: 'export', what: '' });
  for (const [said, id] of [['/масштаб', 'zoom'], ['/масштаб 9', 'zoom'], ['/выровнять куда-то', 'align'], ['/направление', 'direction'],
    ['/экспорт gif', 'export'], ['/переименовать', 'rename'], ['/удалить всё', 'delete'], ['/доска Луна', 'board']]) {
    const r = SHELL.shellIntent(said, CTX);
    assert.equal(r.kind, 'slash-bad', said);
    assert.equal(r.id, id, said);
    assert.ok(r.say && r.usage.startsWith('Например: /'), said);
  }
  assert.deepEqual(SHELL.shellIntent('/зазор', CTX), { kind: 'slash-unknown', name: 'зазор' });
  assert.equal(SHELL.shellIntent('/').kind, 'palette');
});

test('r38: команды выделения — ids без правки документа', () => {
  const card = byName(doc, 'Карточка встречи');
  const titleText = byName(doc, 'Название встречи');
  const place = byName(doc, 'Время и место');
  assert.deepEqual(SHELL.relatedIds(doc, [titleText.id], 'parent'), { ids: [card.id] });
  assert.deepEqual(SHELL.relatedIds(doc, [card.id], 'children'), { ids: card.children });
  assert.deepEqual(SHELL.relatedIds(doc, [titleText.id], 'next'), { ids: [place.id] });
  assert.ok(SHELL.relatedIds(doc, [place.id], 'next').error);
  assert.ok(SHELL.relatedIds(doc, [route.id], 'parent').error, 'у доски нет родителя-слоя');
  assert.deepEqual(SHELL.relatedIds(doc, [route.id], 'next'), { ids: [week.id] });
  assert.ok(SHELL.relatedIds(doc, [titleText.id], 'children').error);
  assert.ok(SHELL.relatedIds(doc, [], 'parent').error);
  const all = SHELL.selectAllIds(doc, route.id);
  assert.deepEqual(all, route.children.filter((k) => doc.nodes[k].visible !== false && !doc.nodes[k].locked));
  assert.deepEqual(SHELL.selectAllIds(doc, null), core.artboards(doc).map((a) => a.id));
  assert.equal(SHELL.needsSelection({ kind: 'duplicate' }), true);
  assert.equal(SHELL.needsSelection({ kind: 'select-all' }), false);
});

test('r38: правки команд — операции ядра, документ годен, отмена одним шагом точна', () => {
  const card = byName(doc, 'Карточка встречи');
  const row = byName(doc, 'Строка статуса');
  const head = byName(doc, 'Дата и заголовок');
  const sub = byName(doc, 'Подзаголовок списка');
  const place = byName(doc, 'Время и место');

  // дублировать: копия рядом, выделяется она
  let r = SHELL.duplicateOps(doc, [card.id]);
  let d = roundtrip(doc, r, 'дублировать');
  assert.equal(d.nodes[r.ids[0]].name, 'Карточка встречи копия');
  assert.equal(d.nodes[route.id].children.indexOf(r.ids[0]), route.children.indexOf(card.id) + 1);
  assert.equal(core.subtreeIds(d, r.ids[0]).length, core.subtreeIds(doc, card.id).length);

  // переименовать, скрыть/показать, закрепить/открепить
  d = roundtrip(doc, SHELL.renameOps(doc, [card.id], '  Карточка  дня '), 'переименовать');
  assert.equal(d.nodes[card.id].name, 'Карточка дня');
  assert.ok(SHELL.renameOps(doc, [card.id], 'Карточка встречи').error);
  d = roundtrip(doc, SHELL.visibleOps(doc, [sub.id], false), 'скрыть');
  assert.equal(d.nodes[sub.id].visible, false);
  const d2 = roundtrip(d, SHELL.visibleOps(d, [sub.id], true), 'показать');
  assert.notEqual(d2.nodes[sub.id].visible, false);
  assert.ok(SHELL.visibleOps(doc, [sub.id], true).error, 'видимое не «показывается» правкой');
  d = roundtrip(doc, SHELL.lockOps(doc, [sub.id], true), 'закрепить');
  assert.equal(d.nodes[sub.id].locked, true);
  roundtrip(d, SHELL.lockOps(d, [sub.id], false), 'открепить');
  assert.ok(SHELL.lockOps(doc, [sub.id], false).error);

  // порядок: выше, ниже, в начало, в конец — и несколько соседей разом
  const kids = card.children.slice();
  const order = (dd) => dd.nodes[card.id].children;
  d = roundtrip(doc, SHELL.reorderOps(doc, [place.id], 'up'), 'выше');
  assert.deepEqual(order(d), [kids[0], kids[2], kids[1]]);
  d = roundtrip(doc, SHELL.reorderOps(doc, [place.id], 'first'), 'в начало');
  assert.deepEqual(order(d), [kids[2], kids[0], kids[1]]);
  d = roundtrip(doc, SHELL.reorderOps(doc, [kids[0]], 'last'), 'в конец');
  assert.deepEqual(order(d), [kids[1], kids[2], kids[0]]);
  d = roundtrip(doc, SHELL.reorderOps(doc, [kids[0], kids[1]], 'last'), 'двое в конец');
  assert.deepEqual(order(d), [kids[2], kids[0], kids[1]]);
  d = roundtrip(doc, SHELL.reorderOps(doc, [kids[0], kids[1]], 'down'), 'двое ниже');
  assert.deepEqual(order(d), [kids[2], kids[0], kids[1]]);
  assert.ok(SHELL.reorderOps(doc, [kids[0]], 'up').error, 'первый выше не поднимается');
  assert.ok(SHELL.reorderOps(doc, [place.id], 'last').error);

  // обернуть в рамку: в потоке — на место первого, поток родителя, размер по содержимому
  r = SHELL.wrapOps(doc, [...row.children].reverse());
  d = roundtrip(doc, r, 'обернуть в потоке');
  const g = d.nodes[r.id];
  assert.equal(g.parent, row.id);
  assert.deepEqual(g.children, row.children, 'порядок детей в рамке — как был');
  assert.deepEqual(d.nodes[row.id].children, [r.id]);
  assert.equal(g.layout.mode, 'row');
  assert.equal(g.layout.gap, core.normalizeLayout(row.layout).gap);
  assert.equal(g.size.w.mode, 'hug');
  assert.ok(SHELL.wrapOps(doc, [route.id]).error, 'доску не оборачиваем');
  assert.ok(SHELL.wrapOps(doc, [place.id, row.children[0]]).error, 'разные родители');

  // разгруппировать: дети на место рамки, рамки нет
  r = SHELL.ungroupOps(doc, [head.id]);
  d = roundtrip(doc, r, 'разгруппировать');
  assert.equal(d.nodes[head.id], undefined);
  const hdr = byName(doc, 'Шапка');
  assert.deepEqual(d.nodes[hdr.id].children.slice(0, head.children.length), head.children);
  assert.ok(SHELL.ungroupOps(doc, [route.id]).error);
  assert.ok(SHELL.ungroupOps(doc, [sub.id]).error, 'текст не разгруппировать');

  // выровнять детей: колонка — влево/вправо поперёк, вверх/вниз вдоль; строка — наоборот
  d = roundtrip(doc, SHELL.alignOps(doc, [card.id], 'center'), 'по центру (колонка)');
  assert.equal(d.nodes[card.id].layout.align, 'center');
  d = roundtrip(doc, SHELL.alignOps(doc, [card.id], 'bottom'), 'вниз (колонка)');
  assert.equal(d.nodes[card.id].layout.justify, 'end');
  d = roundtrip(doc, SHELL.alignOps(doc, [row.id], 'right'), 'вправо (строка)');
  assert.equal(d.nodes[row.id].layout.justify, 'end');
  d = roundtrip(doc, SHELL.alignOps(doc, [row.id], 'top'), 'вверх (строка)');
  assert.equal(d.nodes[row.id].layout.align, 'start');
  assert.ok(SHELL.alignOps(doc, [card.id], 'left').error, 'уже влево');
  assert.ok(SHELL.alignOps(doc, [sub.id], 'center').error, 'у текста нет детей');

  // направление и зазор (ссылкой на шкалу)
  d = roundtrip(doc, SHELL.directionOps(doc, [card.id], 'row'), 'в строку');
  assert.equal(d.nodes[card.id].layout.mode, 'row');
  assert.ok(SHELL.directionOps(doc, [card.id], 'column').error);
  d = roundtrip(doc, SHELL.gapStepOps(doc, [card.id], 1), 'зазор больше');
  assert.equal(d.nodes[card.id].layout.gap, 'spacing.5');
  d = roundtrip(doc, SHELL.gapStepOps(doc, [card.id], -1), 'зазор меньше');
  assert.equal(d.nodes[card.id].layout.gap, 'spacing.3');
  // число «мимо шкалы» — к соседнему шагу
  const off = core.applyOps(doc, [core.ops.set(card.id, 'layout.gap', 10)]).doc;
  assert.equal(core.applyOps(off, SHELL.gapStepOps(off, [card.id], 1).ops).doc.nodes[card.id].layout.gap, 'spacing.5');
  assert.equal(core.applyOps(off, SHELL.gapStepOps(off, [card.id], -1).ops).doc.nodes[card.id].layout.gap, 'spacing.4');
  const top = core.applyOps(doc, [core.ops.set(card.id, 'layout.gap', `spacing.${core.scaleSteps(doc, 'spacing').length - 1}`)]).doc;
  assert.ok(SHELL.gapStepOps(top, [card.id], 1).error, 'выше шкалы не бывает');
});

test('r38: свободная рамка — обернуть и разгруппировать сохраняют места на холсте', () => {
  const free = core.ops.create({
    type: 'frame', id: 'free', name: 'Холст', parent: route.id, children: [], layout: { mode: 'none' },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, radius: 0,
  });
  const a = core.ops.create({ type: 'rect', id: 'ra', name: 'А', parent: 'free', pos: { x: 20, y: 30 }, size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 40 } }, radius: 0 });
  const b = core.ops.create({ type: 'rect', id: 'rb', name: 'Б', parent: 'free', pos: { x: 100, y: 80 }, size: { w: { mode: 'fixed', value: 20 }, h: { mode: 'fixed', value: 30 } }, radius: 0 });
  const base = core.applyOps(doc, [free, a, b]);
  assert.ok(!base.error, base.error && base.error.message);
  const d0 = base.doc;
  const geo = core.solve(d0);
  const r = SHELL.wrapOps(d0, ['ra', 'rb'], { rects: geo.rects });
  const d1 = roundtrip(d0, r, 'обернуть в свободной рамке');
  const g = d1.nodes[r.id];
  assert.deepEqual(g.pos, { x: 20, y: 30 });
  assert.deepEqual([g.size.w.value, g.size.h.value], [100, 80]);
  assert.deepEqual(d1.nodes.ra.pos, { x: 0, y: 0 });
  assert.deepEqual(d1.nodes.rb.pos, { x: 80, y: 50 });
  const geo1 = core.solve(d1);
  for (const k of ['ra', 'rb']) assert.deepEqual(geo1.rects[k], geo.rects[k], `${k} сдвинулся`);
  assert.ok(SHELL.wrapOps(d0, ['ra', 'rb']).error, 'без геометрии свободную рамку не оборачиваем');
  // и обратно — дети там же
  const u = SHELL.ungroupOps(d1, [r.id], { rects: geo1.rects });
  const d2 = roundtrip(d1, u, 'разгруппировать в свободной рамке');
  const geo2 = core.solve(d2);
  for (const k of ['ra', 'rb']) assert.deepEqual(geo2.rects[k], geo.rects[k], `${k} сдвинулся после разгруппировки`);
  assert.ok(SHELL.alignOps(d0, ['free'], 'center').error, 'у свободной рамки выравнивания нет');
});

test('r38: палитра — из таблицы, поиск по названию, слэшу, фразам и значениям; набранное целиком — первой строкой', () => {
  const all = SHELL.paletteRows('');
  const shown = new Set(all.map((r) => r.id));
  for (const c of SHELL.SHELL_COMMANDS) {
    if (c.inPalette === false) assert.ok(!shown.has(c.id), c.id);
    else assert.ok(shown.has(c.id), `палитра без ${c.id}`);
  }
  // группы идут по порядку таблицы
  const seenGroups = [...new Set(all.map((r) => r.group))];
  assert.deepEqual(seenGroups, SHELL.SHELL_GROUPS.filter((g) => seenGroups.includes(g)));
  for (const r of all) {
    assert.ok(r.title && (r.run || r.fill), r.key);
    if (r.run) assert.ok(SHELL.isShellCommandText(r.run), r.run);
  }
  // каждая строка исполняет свою команду
  for (const r of all.filter((x) => x.run)) assert.equal(SHELL.commandIdOf(SHELL.shellIntent(r.run, CTX)), r.id, r.run);
  const first = (q) => SHELL.paletteRows(q, CTX)[0];
  assert.equal(first('/зум').id, 'zoom');
  assert.equal(first('zoom').id, 'zoom');
  assert.equal(first('копия').id, 'duplicate');
  assert.equal(first('что менялось').id, 'history');
  assert.equal(first('/выровнять вл').key, 'align:влево');
  assert.equal(first('/тема').id, 'theme');
  assert.ok(SHELL.paletteRows('png').some((r) => r.key === 'export:png'));
  assert.deepEqual(SHELL.paletteRows('/фывапролд'), []);
  const typed = first('/масштаб 150');
  assert.equal(typed.typed, true);
  assert.equal(typed.run, '/масштаб 150');
  assert.equal(SHELL.paletteRows('/масштаб')[0].fill, '/масштаб ', 'команде нужен аргумент — строка дописывает «/масштаб »');
  assert.equal(first('/переименовать Шапка').run, '/переименовать Шапка');
  assert.ok(SHELL.commandExample(SHELL.shellCommand('zoom')).includes('/масштаб 150'));
});

test('r38: оболочка — палитра и справка в разметке, клавиатура, одна таблица', () => {
  const html = read('index.html');
  assert.match(html, /id="palette"[^>]*hidden/);
  assert.match(html, /id="palette-list"[^>]*role="listbox"/);
  assert.match(html, /id="command"[\s\S]*?role="combobox"[\s\S]*?aria-controls="palette-list"[\s\S]*?aria-expanded="false"/);
  const app = read('app.js');
  // Ctrl/⌘+K и «/» — палитра; Enter, Esc, стрелки — её
  assert.match(app, /e\.key\.toLowerCase\(\) === 'k'[\s\S]{0,200}openPalette\(\)/);
  assert.match(app, /e\.key === '\/' && !typing[^\n]*openPalette\(\)/);
  assert.match(app, /aria-activedescendant/);
  assert.match(app, /if \(paletteKey\(e\)\) return;/);
  assert.match(app, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closePalette\(\)/);
  // справка и палитра — из таблицы; в app.js нет своего перечня команд
  assert.match(app, /SHELL\.helpGroups\(\)/);
  assert.match(app, /SHELL\.paletteRows\(/);
  for (const t of ['Вписать выделенное', 'Выделить родителя', 'Обернуть в рамку', 'Зазор больше']) {
    assert.ok(!app.includes(`'${t}'`) && !app.includes(`«${t}»`), `app.js держит название команды «${t}» сам`);
  }
  // правки — обычной транзакцией (commit), без выделения — подсказка
  assert.match(app, /function commitTableEdit[\s\S]{0,400}commit\(r\.ops, label, 'human', \{ human: r\.words/);
  assert.match(app, /Сначала выделите слой/);
  const css = read('styles.css');
  for (const k of ['.palette {', '.pal-row[aria-selected="true"]', '.cmd-help {']) assert.ok(css.includes(k), k);
  assert.match(css, /\.palette\[hidden\] \{ display: none; \}/);
});

test('r38: стадия intent вместо jev; ни слова о JEV в оболочке, ЗАПУСК.md и docs', () => {
  assert.equal(STAGE_KEYS[0], 'intent');
  assert.ok(!STAGE_KEYS.includes('jev'));
  assert.equal(SHELL.STAGE_WORDS.intent, 'Разбираю запрос');
  assert.deepEqual(SHELL.serverStageRec({ key: 'jev' }), { stage: 'srv:intent', label: 'Разбираю запрос' }, 'старый сервер: jev — это intent');
  for (const f of ['app.js', 'index.html', 'styles.css', 'src/shell.js', 'src/agent.js', 'ЗАПУСК.md', 'docs/README.md',
    ...readdirSync(join(root, 'docs')).filter((n) => n.startsWith('04-')).map((n) => `docs/${n}`)]) {
    const src = read(f);
    const hits = src.split('\n').filter((l) => /\bJEV\b/.test(l) && !/совместим|прежн/i.test(l));
    assert.deepEqual(hits, [], `${f}: упоминает JEV`);
  }
  assert.ok(!existsSync(join(root, 'docs/04-целевая-архитектура.mermaid')) || !/JEV/.test(read('docs/04-целевая-архитектура.mermaid')));
});
