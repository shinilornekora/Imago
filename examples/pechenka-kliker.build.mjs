import * as core from '../src/core.js';
import { treeToOps } from '../src/brain.js';
import fs from 'node:fs';
const OUT = process.argv[2];
const warns = [];
const warn = (m) => warns.push(m);
let doc = core.createDoc('empty');
doc.meta = { ...(doc.meta || {}), name: 'Печенька-кликер' };
const apply = (ops, what) => { const r = core.applyOps(doc, ops); if (r.error) throw new Error(what + ': ' + JSON.stringify(r.error)); doc = r.doc; };

// тёплая палитра
const palette = { canvas: '#FFF4E6', surface: '#FFFFFF', surfaceAlt: '#FBEBD7', line: '#F0DCC2', text: '#2B1A0E', muted: '#8C6A4F',
  accent: '#E2742E', accentSoft: '#FFE3C8', accentInk: '#A04A13', onAccent: '#FFFFFF', good: '#2F9E6E', warn: '#E0A23A' };
apply(Object.entries(palette).map(([k, v]) => core.ops.setToken(`colors.${k}`, v)), 'palette');

const chips = [[150,118,15],[214,104,12],[262,150,14],[132,196,13],[206,186,16],[170,252,12],[250,232,13],[300,206,10],[118,262,9],[226,286,11]];
const crumbs = [[86,318,5],[318,296,4],[332,330,6],[70,280,4],[104,346,3]];
const blob = (cx, cy, r) => `M${cx-r} ${cy}C${cx-r} ${cy-r*0.9} ${cx+r*0.9} ${cy-r} ${cx+r} ${cy-r*0.2}C${cx+r} ${cy+r*0.8} ${cx} ${cy+r} ${cx-r*0.6} ${cy+r*0.7}C${cx-r} ${cy+r*0.5} ${cx-r} ${cy+r*0.2} ${cx-r} ${cy}Z`;
const cookieArt = {
  name: 'Печенька', canvas: { w: 400, h: 400 }, background: 'none',
  palette: [{ name: 'dough', color: '#E3A85F' }, { name: 'choc', color: '#5B3A29' }, { name: 'ink', color: '#6B3E17' }],
  parts: [
    { name: 'Тень', kind: 'ellipse', x: 84, y: 330, w: 236, h: 34, fill: '#6B3E17', opacity: 0.16 },
    { name: 'Тесто', kind: 'path', d: 'M200 52C262 46 322 86 342 150C362 216 334 290 272 324C214 356 136 350 88 302C44 258 40 186 70 128C96 80 146 56 200 52Z',
      gradient: { kind: 'radial', cx: 0.4, cy: 0.35, r: 0.7, stops: [{ at: 0, color: '#F6CE8D' }, { at: 0.7, color: '#DDA055' }, { at: 1, color: '#C1803A' }] }, stroke: '#8A5523', strokeWidth: 5 },
    { name: 'Подрумяненный край', kind: 'path', d: 'M74 236C96 296 160 336 228 330C286 324 330 284 340 228C318 282 266 312 210 314C150 316 98 286 74 236Z', fill: '#B06F2C', opacity: 0.55 },
    { name: 'Трещинки', kind: 'path', d: 'M104 196C114 186 126 182 138 184M268 104C280 112 286 124 284 136M236 300C248 292 262 290 274 294', fill: 'none', stroke: '#B5772F', strokeWidth: 4 },
    ...chips.map(([cx, cy, r], i) => ({ name: `Шоколад ${i+1}`, kind: 'path', d: blob(cx, cy, r), fill: 'choc', group: 'Шоколадная крошка' })),
    ...chips.slice(0, 6).map(([cx, cy, r], i) => ({ name: `Блик шоколада ${i+1}`, kind: 'ellipse', x: cx - r*0.55, y: cy - r*0.6, w: r*0.6, h: r*0.4, fill: '#8D5A3C', group: 'Блики шоколада' })),
    ...crumbs.map(([cx, cy, r], i) => ({ name: `Крошка ${i+1}`, kind: 'path', d: blob(cx, cy, r), fill: '#D49A55', group: 'Крошки' })),
    { name: 'Блик', kind: 'path', d: 'M120 112C150 84 194 72 232 78C196 90 160 110 136 140C126 134 118 124 120 112Z', fill: '#FFF3DC', opacity: 0.8 },
  ],
};

// ноль — тоже шаг шкалы (SPEC §6): в документе нет чисел отступов и скруглений, только ссылки
const P0 = (n) => { if (n && n.layout && n.layout.padding === undefined) n.layout.padding = 'spacing.0'; if (n && n.children) n.children.forEach(P0); return n; };
const T = (text, style, extra = {}) => ({ type: 'text', text, style, size: { w: 'hug', h: 'hug' }, ...extra });
const row = (children, extra = {}) => ({ type: 'frame', layout: { mode: 'row', gap: 'spacing.5', align: 'center', justify: 'start', wrap: false }, size: { w: 'fill', h: 'hug' }, children, ...extra });
const col = (children, extra = {}) => ({ type: 'frame', layout: { mode: 'column', gap: 'spacing.3', align: 'start', justify: 'start', wrap: false }, size: { w: 'fill', h: 'hug' }, children, ...extra });
const live = { states: { hover: { lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.97, shadow: 'shadow.sm' } }, motion: { duration: 'motion.fast', easing: 'spring' } };

const header = (sub, boost = '🔥 буст ×2 · 0:42') => row([
  col([T('Печенька-кликер', 'title', { name: 'Название' }), T(sub, 'caption', { color: 'muted', name: 'Подзаголовок' })], { name: 'Шапка · текст', layout: { mode: 'column', gap: 'spacing.2', align: 'start', justify: 'start', wrap: false } }),
  { type: 'frame', name: 'Буст', layout: { mode: 'row', gap: 'spacing.2', padding: ['spacing.3', 'spacing.5'], align: 'center', justify: 'center', wrap: false }, size: { w: 'hug', h: 'hug' }, fill: 'accentSoft', radius: 'radii.7',
    children: [T(boost, 'caption', { color: 'accentInk', name: 'Буст · текст' })], ...live },
], { name: 'Шапка', layout: { mode: 'row', gap: 'spacing.5', align: 'center', justify: 'between', wrap: false } });

const counter = (big) => ({ type: 'frame', name: 'Счётчик', layout: { mode: 'column', gap: 'spacing.2', padding: 'spacing.7', align: 'center', justify: 'center', wrap: false },
  size: { w: 'fill', h: 'hug' }, fill: 'surface', radius: 'radii.5', shadow: 'shadow.sm', children: [
    T('1 284', 'display', { name: 'Печенек', align: 'center' }),
    T('печенек в банке', 'body', { color: 'muted', name: 'Подпись счётчика', align: 'center' }),
    { type: 'frame', name: 'Скорость', layout: { mode: 'row', gap: 'spacing.2', padding: ['spacing.2', 'spacing.4'], align: 'center', justify: 'center', wrap: false }, size: { w: 'hug', h: 'hug' }, fill: 'surfaceAlt', radius: 'radii.7',
      children: [T('▲ +12,4 в секунду', 'caption', { color: 'good', name: 'Скорость · текст' })] },
  ] });

const cookie = (sz) => ({ type: 'frame', name: 'Сцена печеньки', layout: { mode: 'column', gap: 'spacing.4', padding: 'spacing.4', align: 'center', justify: 'center', wrap: false }, size: { w: 'fill', h: 'hug' },
  children: [
    { type: 'illustration', name: 'Печенька', size: { w: sz, h: sz }, art: cookieArt,
      states: { hover: { scale: 1.04, lift: 'spacing.2' }, press: { scale: 0.93 } }, motion: { duration: 'motion.fast', easing: 'spring' } },
    T('Нажми на печеньку · +2 за клик', 'caption', { color: 'muted', name: 'Подсказка клика', align: 'center' }),
  ] });

const progress = (w) => col([
  row([T('До уровня 8', 'caption', { color: 'muted', name: 'Прогресс · подпись' }), T('1 284 / 2 000', 'caption', { name: 'Прогресс · число' })], { name: 'Прогресс · строка', layout: { mode: 'row', gap: 'spacing.4', align: 'center', justify: 'between', wrap: false } }),
  { type: 'frame', name: 'Полоса', layout: { mode: 'row', gap: 'spacing.0', align: 'center', justify: 'start', wrap: false }, size: { w: 'fill', h: 10 }, fill: 'surfaceAlt', radius: 'radii.7',
    children: [{ type: 'rect', name: 'Заполнение', size: { w: Math.round(w * 0.64), h: 10 }, fill: 'accent', radius: 'radii.7' }] },
], { name: 'Прогресс уровня' });

const upgrades = [
  ['👆', 'Курсор', '×12 · +1,2 в секунду', '15', true],
  ['👵', 'Бабушка', '×3 · +3 в секунду', '100', true],
  ['🌾', 'Ферма', '×1 · +8 в секунду', '1 100', false],
  ['🏭', 'Фабрика', 'откроется на уровне 10', '12 000', false],
];
const upgradeCard = ([icon, name, sub, price, ok]) => ({
  type: 'frame', name: `Улучшение · ${name}`, layout: { mode: 'row', gap: 'spacing.5', padding: 'spacing.5', align: 'center', justify: 'start', wrap: false }, size: { w: 'fill', h: 'hug' },
  fill: 'surface', radius: 'radii.4', stroke: 'line', ...(ok ? live : { opacity: 0.7 }),
  children: [
    { type: 'frame', name: `${name} · значок`, layout: { mode: 'row', gap: 'spacing.0', align: 'center', justify: 'center', wrap: false }, size: { w: 48, h: 48 }, fill: ok ? 'accentSoft' : 'surfaceAlt', radius: 'radii.3', children: [T(icon, 'heading', { name: `${name} · эмодзи` })] },
    col([T(name, 'body', { name: `${name} · имя`, size: { w: 'fill', h: 'hug' } }), T(sub, 'caption', { color: 'muted', name: `${name} · уровень`, size: { w: 'fill', h: 'hug' } })], { name: `${name} · текст`, layout: { mode: 'column', gap: 'spacing.1', align: 'start', justify: 'start', wrap: false } }),
    { type: 'frame', name: `${name} · купить`, layout: { mode: 'row', gap: 'spacing.2', padding: ['spacing.3', 'spacing.5'], align: 'center', justify: 'center', wrap: false }, size: { w: 'hug', h: 'hug' },
      fill: ok ? 'accent' : 'surfaceAlt', radius: 'radii.7',
      ...(ok ? { states: { hover: { fill: 'accentInk', lift: 'spacing.1' }, press: { scale: 0.94 } }, motion: { duration: 'motion.fast', easing: 'spring' } } : {}),
      children: [T(`${price} 🍪`, 'caption', { color: ok ? 'onAccent' : 'muted', name: `${name} · цена` })] },
  ],
});
const shop = () => col([
  row([T('Улучшения', 'heading', { name: 'Улучшения · заголовок' }), T('куплено 16', 'caption', { color: 'muted', name: 'Улучшения · счёт' })], { name: 'Улучшения · шапка', layout: { mode: 'row', gap: 'spacing.4', align: 'center', justify: 'between', wrap: false } }),
  ...upgrades.map(upgradeCard),
], { name: 'Магазин улучшений', layout: { mode: 'column', gap: 'spacing.4', align: 'stretch', justify: 'start', wrap: false } });

const achievement = () => ({ type: 'frame', name: 'Достижение', layout: { mode: 'row', gap: 'spacing.4', padding: 'spacing.5', align: 'center', justify: 'start', wrap: false }, size: { w: 'fill', h: 'hug' }, fill: 'accentSoft', radius: 'radii.4',
  children: [T('🏆', 'heading', { name: 'Кубок' }), col([T('Тысяча крошек', 'body', { color: 'accentInk', name: 'Достижение · имя' }), T('испекли первые 1 000 печенек', 'caption', { color: 'accentInk', name: 'Достижение · описание' })], { name: 'Достижение · текст', layout: { mode: 'column', gap: 'spacing.1', align: 'start', justify: 'start', wrap: false } })] });

// доска 1: телефон
const mobile = { type: 'frame', name: 'Кликер · телефон', fill: 'canvas', radius: 'radii.6',
  layout: { mode: 'column', gap: 'spacing.7', padding: ['spacing.8', 'spacing.7'], align: 'stretch', justify: 'start', wrap: false }, size: { w: 390, h: 'hug' },
  children: [header('Пекарня Ани · уровень 7', '🔥 ×2'), counter(), cookie(250), progress(350), shop(), achievement()] };
P0(mobile);
let r = treeToOps({ doc, tree: mobile, parentId: doc.root, engine: core, warn, asArtboard: true, artboardSize: { w: 390 } });
apply(r.ops, 'mobile');

// доска 2: компьютер
const desktop = { type: 'frame', name: 'Кликер · компьютер', fill: 'canvas', radius: 'radii.6',
  layout: { mode: 'row', gap: 'spacing.9', padding: 'spacing.9', align: 'start', justify: 'start', wrap: false }, size: { w: 1200, h: 'hug' },
  children: [
    col([header('Пекарня Ани · уровень 7 · 3 ч 12 мин в игре'), counter(), cookie(380), progress(640)], { name: 'Левая колонка', layout: { mode: 'column', gap: 'spacing.8', align: 'stretch', justify: 'start', wrap: false } }),
    col([shop(), achievement()], { name: 'Правая колонка', size: { w: 400, h: 'hug' }, layout: { mode: 'column', gap: 'spacing.8', align: 'stretch', justify: 'start', wrap: false } }),
  ] };
P0(desktop);
r = treeToOps({ doc, tree: desktop, parentId: doc.root, engine: core, warn, asArtboard: true, artboardSize: { w: 1200 } });
apply(r.ops, 'desktop');

const ill = Object.values(doc.nodes).filter((n) => n.role === 'illustration');
apply(ill.flatMap((n) => [core.ops.set(n.id, 'states', { hover: { scale: 1.04, lift: 'spacing.2' }, press: { scale: 0.93 } }), core.ops.set(n.id, 'motion', { duration: 'motion.fast', easing: 'spring' })]), 'cookie states');
/* Круг 39 (N6г): рамку иллюстрации brain мог собрать числами (gap/padding/radius 0) — переводим
   на ссылки здесь же, иначе первое открытие примера делало «Миграцию формата» и говорило
   «файл из прежней версии». После перевода переводить нечего — проверяем. */
apply(core.ensureScaleRefsOps(doc), 'scale refs');
if (core.ensureScaleRefsOps(doc).length) throw new Error('числа мимо ссылок шкал остались');
if (core.ensureLibraryOps(doc).length) throw new Error('библиотеки нет — импорт завёл бы её миграцией');
const issues = core.validate(doc).filter((v) => v.severity !== 'info');
console.log('warns:', warns);
console.log('validate:', issues.map((v) => `${v.severity} ${v.code} ${v.message}`).slice(0, 20));
console.log('nodes:', Object.keys(doc.nodes).length, 'import:', core.checkImportDoc(doc));
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
