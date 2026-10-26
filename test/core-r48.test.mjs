/**
 * Круг 48 (SPEC §15): тема доски. Поле `theme` фрейма-доски — свои значения токенов цвета и
 * шрифтов стилей; узлы доски пишут те же имена токенов, а видят значения темы. ENGINE_VERSION 3.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { fontsInDoc } from '../src/fonts.js';

const { createDoc, applyOps, ops, solve, validate, renderSVG, docAt, themeScope, themedDoc, themeProblem, resolveColor, resolveTextStyle, checkImportDoc } = core;
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

const THEME = { colors: { canvas: '#15171c', surface: '#20242c', text: '#f2f4f7', accent: '#c6ff3d' }, type: { display: { font: 'Russo One', fontWeight: 400 }, body: { font: 'Exo 2' } } };

/** Две доски рядом: «Тёмная» в своей теме и «Обычная» — на токенах документа; узлы одинаковые. */
function twoBoards(theme = THEME) {
  let doc = quiet(() => createDoc());
  const mk = (id, name, x, th) => [
    ops.create({ id, type: 'frame', name, parent: doc.root, pos: { x, y: 0 }, size: { w: { mode: 'fixed', value: 320 }, h: { mode: 'hug' } },
      fill: 'canvas', layout: { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 }, align: 'stretch', justify: 'start', wrap: false },
      children: [], ...(th ? { theme: th } : {}) }),
    ops.create({ id: id + '_t', type: 'text', name: 'Заголовок', parent: id, characters: 'Темп недели', style: 'display', color: 'text', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } }),
    ops.create({ id: id + '_b', type: 'frame', name: 'Кнопка', parent: id, fill: { token: 'accent' }, size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
      layout: { mode: 'row', gap: 0, padding: { t: 8, r: 12, b: 8, l: 12 }, align: 'start', justify: 'start', wrap: false }, children: [] }),
    ops.create({ id: id + '_l', type: 'text', name: 'Надпись', parent: id + '_b', characters: 'Старт', style: 'body', color: 'onAccent', size: { w: { mode: 'hug' }, h: { mode: 'hug' } } }),
  ];
  const r = applyOps(doc, [...mk('dark', 'Тёмная', 0, theme), ...mk('plain', 'Обычная', 400, null)]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.doc;
}

test('круг48: ENGINE_VERSION 3 — тема доски поменяла формат', () => {
  assert.equal(core.ENGINE_VERSION, 3);
  assert.equal(core.engineReadable(2), true, 'записи движка 2 читаются как раньше');
  assert.equal(core.engineReadable(4), false);
});

test('круг48: токены узла — по теме его доски, соседняя доска — на токенах документа', () => {
  const doc = twoBoards();
  const dark = docAt(doc, 'dark_l');
  assert.equal(resolveColor(dark, 'text'), '#f2f4f7');
  assert.equal(resolveColor(dark, { token: 'accent' }), '#c6ff3d');
  assert.equal(resolveColor(dark, 'muted'), resolveColor(doc, 'muted'), 'чего тема не задала — от документа');
  assert.equal(resolveTextStyle(dark, doc.nodes.dark_t).font, 'Russo One');
  assert.equal(resolveTextStyle(dark, doc.nodes.dark_t).fontWeight, 400);
  assert.equal(resolveTextStyle(dark, doc.nodes.dark_t).fontSize, resolveTextStyle(doc, doc.nodes.dark_t).fontSize, 'кегль — от документа');
  assert.equal(docAt(doc, 'plain_t'), doc, 'доска без темы — сам документ');
  assert.equal(resolveColor(docAt(doc, 'plain_t'), 'text'), resolveColor(doc, 'text'));
  assert.equal(docAt(doc, 'dark'), docAt(doc, 'dark_l'), 'кеш: тот же вид доски');
  assert.equal(docAt(doc, 'dark').nodes, doc.nodes, 'узлы общие — только токены свои');
  const at = themeScope(doc);
  assert.equal(at('dark_l'), docAt(doc, 'dark_l'));
  assert.equal(at('plain_l'), doc);
  const bare = quiet(() => createDoc());
  assert.equal(themeScope(bare)('x'), bare, 'без тем — сам документ');
});

test('круг48: раскладка меряет текст шрифтом темы, снимок рисует цветами и шрифтами темы', () => {
  const doc = twoBoards();
  const widths = { 'Russo One': 20, 'Exo 2': 9 };
  const measureText = (s, st) => String(s).length * (widths[st.font] || 10);
  const geo = solve(doc, { measureText });
  assert.equal(geo.rects.dark_l.w, 5 * 9, 'надпись — шрифтом темы (Exo 2)');
  assert.equal(geo.rects.plain_l.w, 5 * 10, 'на соседней доске — шрифтом документа');
  const svg = renderSVG(doc, 'dark').svg;
  assert.match(svg, /fill="#15171c"/);
  assert.match(svg, /fill="#c6ff3d"/);
  assert.match(svg, /font-family="Russo One/);
  const plain = renderSVG(doc, 'plain').svg;
  assert.doesNotMatch(plain, /#15171c|#c6ff3d|Russo One/);
  assert.deepEqual(renderSVG(doc, 'dark').families.sort(), ['Exo 2', 'Russo One']);
  assert.deepEqual(fontsInDoc(doc).filter((f) => f !== 'IBM Plex Sans' && f !== 'IBM Plex Mono'), ['Exo 2', 'Russo One'], 'шрифты темы — в загрузку гарнитур');
});

test('круг48: проверка считает контраст и мёртвые цвета по теме доски', () => {
  // тёмный текст документа на тёмном фоне темы — нечитаемо; на своей доске — читаемо
  const bad = twoBoards({ colors: { canvas: '#15171c' } });
  const issues = validate(bad, solve(bad));
  assert.ok(issues.some((i) => i.code === 'low-contrast' && i.nodeId === 'dark_t'), 'тема без своего text — текст документа на тёмном фоне');
  assert.ok(!issues.some((i) => i.code === 'low-contrast' && i.nodeId === 'plain_t'));
  const good = twoBoards();
  assert.ok(!validate(good, solve(good)).some((i) => i.code === 'low-contrast' && i.nodeId === 'dark_t'));
  // имя, которого нет в документе, но есть в теме, — живое только на этой доске
  const named = applyOps(twoBoards({ colors: { brand: '#ff00aa' } }), [ops.set('dark_b', 'fill', 'brand'), ops.set('plain_b', 'fill', 'brand')]).doc;
  const dead = validate(named, solve(named)).filter((i) => i.code === 'dead-color-ref').map((i) => i.nodeId);
  assert.deepEqual(dead, ['plain_b']);
});

test('круг48: форма темы — строгая; тема только у фрейма; не на доске — замечание', () => {
  assert.equal(themeProblem(THEME), null);
  assert.equal(themeProblem({}), null);
  for (const bad of [null, 'x', [], { colors: { text: 'red' } }, { colors: { text: '#12345' } }, { colors: { '1x': '#000' } }, { colors: { constructor: '#000' } },
    { type: { body: { fontSize: 20 } } }, { type: { body: { font: '' } } }, { type: { body: { fontWeight: 50 } } }, { type: { body: 'Prata' } }, { bogus: 1 }]) {
    assert.notEqual(themeProblem(bad), null, JSON.stringify(bad));
  }
  const doc = twoBoards();
  const r1 = quiet(() => applyOps(doc, [ops.set('dark', 'theme.colors.text', 'white')]));
  assert.ok(r1.error, 'не hex — отказ');
  const r2 = quiet(() => applyOps(doc, [ops.set('dark_t', 'theme', { colors: { text: '#000000' } })]));
  assert.ok(r2.error, 'у текста темы не бывает');
  const r3 = applyOps(doc, [ops.set('dark', 'theme.colors.muted', '#9aa3b2')]);
  assert.equal(r3.error, undefined);
  assert.equal(resolveColor(docAt(r3.doc, 'dark_t'), 'muted'), '#9aa3b2');
  // тема на фрейме внутри макета — не действует, и об этом сказано
  const inner = applyOps(doc, [ops.set('plain_b', 'theme', { colors: { accent: '#000000' } })]).doc;
  assert.equal(resolveColor(docAt(inner, 'plain_b'), 'accent'), resolveColor(inner, 'accent'));
  assert.ok(validate(inner, solve(inner)).some((i) => i.code === 'theme-not-board' && i.nodeId === 'plain_b' && i.severity === 'info'));
  // документ с темой проходит строгую проверку импорта; негодная тема — нет
  assert.equal(checkImportDoc(doc), null);
  const broken = JSON.parse(JSON.stringify(doc));
  broken.nodes.dark.theme = { colors: { text: 'javascript:1' } };
  assert.notEqual(checkImportDoc(broken), null);
});

test('круг48: тема-мусор документа прежней версии не действует и чинится при открытии', () => {
  const doc = twoBoards();
  const raw = JSON.parse(JSON.stringify(doc));
  raw.nodes.dark.theme = { colors: { text: 'x'.repeat(5000) }, junk: true };
  // как прочёл бы его рисующий код до починки: тема не по форме — цвета документа
  assert.equal(themedDoc(raw, raw.nodes.dark), raw);
  const opened = quiet(() => createDoc(raw));
  assert.equal(opened.nodes.dark.theme, undefined, 'createDoc снял негодное поле');
  assert.equal(opened.nodes.dark_t.characters, 'Темп недели', 'доска цела');
});

test('круг48: снять тему — доска снова на токенах документа; отмена возвращает тему', () => {
  const doc = twoBoards();
  const r = applyOps(doc, [ops.set('dark', 'theme', undefined)]);
  assert.equal(r.error, undefined);
  assert.equal(r.doc.nodes.dark.theme, undefined);
  assert.equal(resolveColor(docAt(r.doc, 'dark_t'), 'text'), resolveColor(doc, 'text'));
  const back = applyOps(r.doc, core.invertOps(doc, [ops.set('dark', 'theme', undefined)]));
  assert.deepEqual(back.doc.nodes.dark.theme, THEME);
});
