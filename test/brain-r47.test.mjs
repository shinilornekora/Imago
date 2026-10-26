/**
 * Круг 47 (SPEC §14): живой дизайн. Жалоба: агент собирал шаблон — белые карточки, шрифт по
 * умолчанию, акцент документа, всё по центру. Теперь: арт-направление до раскладки (образ,
 * палитра из материалов, пара шрифтов из набора, мотивы), шрифты ставит приложение, визуальный
 * критик смотрит снимок доски и даёт один круг доработки. Модель поддельная, движок — core.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import {
  runCommand, runVariants, SCHEMAS, PROMPTS, downgradeSchema, makeProvider,
  normalizeDirection, directionBrief, applyDirection, templateSignals, normalizeCritique, imageTurn,
  CRITIC_PASS, DIRECTION_ROLES,
} from '../src/brain.js';
import { FONT_CATALOG, FONT_PAIRS, catalogFont, fontStylesheetUrl, fontsInDoc, nearestWeight, DEFAULT_FONT, fontMenu } from '../src/fonts.js';
import { artSummary } from '../src/shell.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

/** Поддельная модель: ответы по имени схемы, массив — по очереди, функция — от реплик. */
function fake(script, extra = {}) {
  const calls = [];
  return {
    name: 'fake', calls, ...extra,
    async ready() { return true; },
    async complete(messages, schema, opts = {}) {
      const name = schema && schema.name;
      calls.push({ schema: name, messages, opts, entry: schema });
      let v = script[name];
      if (Array.isArray(v)) v = v.shift();
      if (typeof v === 'function') v = v(messages, calls);
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}

const PLAN = { intent: 'create', title: 'Экран кофейни', summary: 'Соберу экран меню кофейни', steps: ['Шапка', 'Меню'] };
const DIRECTION = {
  concept: 'Утренняя кофейня: крафтовый пакет, эмалированная кружка, мел на доске',
  mood: ['тепло', 'неторопливо', 'ремесленно'],
  materials: [{ name: 'крафт-бумага', hex: '#c9a77c' }, { name: 'эспрессо', hex: '#3b2418' }, { name: 'молочная пенка', hex: '#f4ead8' }, { name: 'эмаль', hex: '#2f6f62' }],
  palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' },
  fonts: { display: 'Prata', text: 'Golos Text' },
  motifs: ['круглый штамп с надписью', 'крупные цифры цены', 'зерно кофе иллюстрацией'],
  composition: 'асимметрия: крупный заголовок слева, меню колонкой справа, цены выносом',
  avoid: ['белые карточки в ряд', 'синий акцент'],
};
const TREE = {
  type: 'frame', name: 'Кофейня', size: { w: 390, h: 'hug' },
  layout: { mode: 'column', gap: 16, padding: 24 },
  children: [
    { type: 'text', name: 'Заголовок', text: 'Утро в Зерне', style: 'display' },
    { type: 'text', name: 'Подзаголовок', text: 'Обжариваем сами, по четвергам', style: 'body' },
    { type: 'frame', name: 'Позиция', layout: { mode: 'row', gap: 8 }, fill: '#fffaf1', children: [
      { type: 'text', name: 'Название', text: 'Флэт уайт', style: 'heading' },
      { type: 'text', name: 'Цена', text: '240 ₽', style: 'title', color: '#2f6f62' },
    ] },
  ],
};
const TREE_BETTER = clone(TREE);
TREE_BETTER.children.unshift({ type: 'ellipse', name: 'Штамп', size: { w: 96, h: 96 }, fill: '#2f6f62', rotate: -12 });
const CRIT_BAD = { score: 4, generic: true, verdict: 'revise', issues: ['Шапка — просто текст по левому краю, без образа'], fixes: ['Добавить круглый штамп «с 2019» поворотом -12°'] };
const CRIT_OK = { score: 8.5, generic: false, verdict: 'ok', issues: [], fixes: [], praise: 'Палитра крафта читается' };
const PNG = { mime: 'image/png', data: 'iVBORw0KGgo=', width: 390, height: 600 };

function empty() {
  const doc = quiet(() => core.createDoc());
  return doc;
}
const boardOf = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name && n.parent === doc.root);
const byName = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name);

/* ── набор шрифтов ─────────────────────────────────────────────────────── */

test('круг 47: набор шрифтов — у каждой пары оба семейства из каталога, имена уникальны, умолчание в каталоге', () => {
  const names = FONT_CATALOG.map((f) => f.family);
  assert.equal(new Set(names).size, names.length, 'имена не повторяются');
  assert.ok(catalogFont(DEFAULT_FONT), 'шрифт по умолчанию — в каталоге');
  for (const p of FONT_PAIRS) {
    assert.ok(catalogFont(p.display), `${p.display} — в каталоге`);
    assert.ok(catalogFont(p.text), `${p.text} — в каталоге`);
    assert.ok(['sans', 'serif', 'slab', 'mono'].includes(catalogFont(p.text).kind), `${p.text} годится для набора`);
  }
  for (const f of FONT_CATALOG) {
    assert.ok(f.weights.length && f.weights.every((w) => Number.isInteger(w) && w >= 100 && w <= 900), f.family);
    assert.deepEqual(f.weights, f.weights.slice().sort((a, b) => a - b));
  }
  // без кириллицы — не в наборе: заголовок по-русски вышел бы системным шрифтом
  for (const latin of ['Bebas Neue', 'DM Sans', 'Space Grotesk', 'Work Sans']) assert.equal(catalogFont(latin), null, latin);
  assert.equal(catalogFont('  "prata" ').family, 'Prata', 'регистр, кавычки и пробелы не важны');
  assert.equal(nearestWeight('Prata', 600), 400, 'у Prata одно начертание');
  assert.equal(nearestWeight('Manrope', 650), 600);
  assert.match(fontMenu(), /Prata \+ Golos Text/);
});

test('круг 47: адрес стилей — только семейства набора и их начертания, без повторов', () => {
  const url = fontStylesheetUrl(['Prata', 'Выдумка', 'prata', 'Golos Text']);
  assert.equal(url, 'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700;800&family=Prata:wght@400&display=swap');
  assert.equal(fontStylesheetUrl(['Comic Sans MS']), '');
  const doc = empty();
  const txt = Object.values(doc.nodes).find((n) => n.type === 'text');
  doc.nodes[txt.id] = { ...txt, style: { token: 'body', font: 'Prata' } };
  assert.deepEqual(fontsInDoc(doc), ['IBM Plex Mono', 'IBM Plex Sans', 'Prata']);
});

/* ── арт-направление: нормализация ─────────────────────────────────────── */

test('круг 47: решение арт-директора — годное проходит как есть', () => {
  const d = normalizeDirection(DIRECTION);
  assert.equal(d.concept, DIRECTION.concept);
  assert.deepEqual(d.fonts, { display: 'Prata', text: 'Golos Text' });
  for (const k of DIRECTION_ROLES) assert.match(d.palette[k], /^#[0-9a-f]{6}$/, k);
  assert.equal(d.palette.bg, '#f4ead8');
  assert.equal(d.materials.length, 4);
  assert.deepEqual(d.notes, [], 'чинить было нечего');
  assert.match(directionBrief(d), /Образ: Утренняя кофейня/);
  assert.match(directionBrief(d), /фон доски #f4ead8/);
  assert.match(directionBrief(d), /Шрифты: заголовки — Prata, текст — Golos Text/);
  assert.match(directionBrief(d), /сильнее правила 4/, 'генератору прямо сказано: токены цвета документа здесь не пишем');
  const forCritic = directionBrief(d, { forCritic: true });
  assert.doesNotMatch(forCritic, /пиши|Ставит/, 'критику — только решение, без указаний генератору');
});

test('круг 47: нечитаемая палитра и чужие шрифты чинятся — с записью, что починено', () => {
  const d = normalizeDirection({
    concept: 'Ночной велопрокат',
    materials: [{ name: 'мокрый асфальт', hex: '#1b1e24' }, { name: 'неон', hex: '#39ff88' }],
    palette: { bg: '#1b1e24', text: '#23262c', muted: '#2a2d33', accent: 'неоновый' },
    fonts: { display: 'Bebas Neue', text: 'Pacifico' },
  });
  const ratio = (a, b) => core.contrastRatio(a, b);
  assert.ok(ratio(d.palette.text, d.palette.bg) >= 4.5, `текст читается: ${d.palette.text}`);
  assert.ok(ratio(d.palette.text, d.palette.surface) >= 4.5, 'и на плашке');
  assert.ok(ratio(d.palette.muted, d.palette.bg) >= 3, 'подписи — от 3:1');
  assert.equal(d.palette.accent, '#39ff88', 'акцент — самый яркий материал');
  assert.ok(ratio(d.palette.onAccent, d.palette.accent) >= 4.5, 'текст на акценте читается');
  assert.ok(catalogFont(d.fonts.display), 'заголовки — из набора');
  assert.ok(['sans', 'serif', 'slab', 'mono'].includes(catalogFont(d.fonts.text).kind), 'рукописный шрифт для текста заменён');
  assert.ok(d.notes.some((n) => /Bebas Neue.*не из набора/.test(n)));
  assert.ok(d.notes.some((n) => /не читался/.test(n)));
  assert.ok(d.notes.some((n) => /Pacifico не для набора/.test(n)));
});

test('круг 47: пустой ответ арт-директора — null; одно названное семейство — пара к нему', () => {
  assert.equal(normalizeDirection(null), null);
  assert.equal(normalizeDirection({ mood: ['тепло'] }), null);
  assert.equal(normalizeDirection([1, 2]), null);
  const d = normalizeDirection({ concept: 'Пекарня', fonts: { display: 'Kelly Slab' } });
  assert.deepEqual(d.fonts, { display: 'Kelly Slab', text: 'Bitter' });
  // одинаковый образ — одинаковая пара (детерминированно)
  const a = normalizeDirection({ concept: 'Морской клуб' });
  const b = normalizeDirection({ concept: 'Морской клуб' });
  assert.deepEqual(a.fonts, b.fonts);
});

test('круг 47: схемы direction и critique понижаются для локальной грамматики', () => {
  for (const s of [SCHEMAS.direction, SCHEMAS.critique]) {
    const flat = downgradeSchema(s.schema);
    assert.equal(flat.type, 'object');
    assert.ok(s.hint && s.example);
  }
  assert.deepEqual(normalizeDirection(SCHEMAS.direction.example).fonts, { display: 'Old Standard TT', text: 'PT Serif' });
  assert.doesNotMatch(JSON.stringify(SCHEMAS.direction.example), /кофе/i, 'образец формы — не о самой частой теме');
  assert.equal(normalizeCritique(SCHEMAS.critique.example).verdict, 'revise');
});

test('круг 47: фон — спокойный материал, акцент — отличимый от фона (мёд не становится и тем, и другим)', () => {
  const ratio = (a, b) => core.contrastRatio(a, b);
  const honey = normalizeDirection({ concept: 'Пасека', materials: [{ name: 'мёд', hex: '#f2b705' }, { name: 'воск', hex: '#3b2f2f' }, { name: 'дерево', hex: '#8b5a2b' }] });
  assert.notEqual(honey.palette.bg, honey.palette.accent);
  assert.ok(ratio(honey.palette.accent, honey.palette.bg) >= 3, `акцент виден на фоне: ${honey.palette.accent} на ${honey.palette.bg}`);
  const one = normalizeDirection({ concept: 'Ночь', materials: [{ name: 'индиго', hex: '#123456' }] });
  assert.ok(ratio(one.palette.accent, one.palette.bg) >= 3, 'и с одним материалом');
  const same = normalizeDirection({ concept: 'x', palette: { bg: '#f4ead8', text: '#222222', accent: '#f0e6d2' } });
  assert.ok(ratio(same.palette.accent, same.palette.bg) >= 3);
  assert.ok(same.notes.some((n) => /сливался с фоном/.test(n)));
});

/* ── воплощение решения ────────────────────────────────────────────────── */

test('круг 47: шрифты решения — заголовкам display, прочим text (heading — жирным текстом), ближайшее начертание', () => {
  const doc = empty();
  const d = normalizeDirection(DIRECTION);
  const { tree, fonts } = applyDirection(TREE, d, doc, { asArtboard: true });
  assert.equal(fonts, 4, 'все четыре текста');
  const [title, sub, row] = tree.children;
  assert.deepEqual(title.style, { token: 'display', font: 'Prata', fontWeight: 400 }, 'у Prata только 400 — стоит 400, а не синтетический жирный');
  assert.deepEqual(sub.style, { token: 'body', font: 'Golos Text' });
  assert.equal(row.children[0].style.font, 'Golos Text', 'heading 18px — текстом: акцидентный на мелком подзаголовке читается плохо');
  assert.equal(row.children[1].style.font, 'Prata', 'title — заголовочный');
  assert.equal(title.color, d.palette.text, 'тексту без цвета — текст палитры');
  assert.equal(row.children[1].color, '#2f6f62', 'цвет модели не трогаем');
  assert.equal(tree.fill, '#f4ead8', 'новой доске без фона — фон палитры');
  assert.equal(TREE.children[0].style, 'display', 'исходное дерево не тронуто');
  const own = applyDirection({ type: 'text', text: 'x', style: { token: 'display', font: 'Unbounded' } }, d, doc);
  assert.equal(own.tree.style.font, 'Unbounded');
  assert.equal(own.fonts, 0);
  assert.equal(applyDirection(TREE, d, doc, { asArtboard: false }).tree.fill, undefined);
  // крупный заголовок без токена — тоже заголовок
  assert.equal(applyDirection({ type: 'text', text: '56', style: { fontSize: 56, fontWeight: 800 } }, d, doc).tree.style.font, 'Prata');
  // рукописный акцидентный — только на самом крупном
  const script = normalizeDirection({ concept: 'Пляж', fonts: { display: 'Pacifico', text: 'Nunito' } });
  const two = applyDirection({ type: 'frame', children: [
    { type: 'text', text: 'a', style: 'display' }, { type: 'text', text: 'b', style: 'title' }] }, script, doc);
  assert.equal(two.tree.children[0].style.font, 'Pacifico');
  assert.equal(two.tree.children[1].style.font, 'Nunito');
});

test('круг 47: токены цвета документа → роли палитры; текст на акценте — читаемым цветом', () => {
  const doc = empty();
  const dark = normalizeDirection({ concept: 'Ночная дорожка', palette: { bg: '#15171c', surface: '#20242c', text: '#f2f4f7', muted: '#9aa3b2', accent: '#c6ff3d', accent2: '#ff4f6d' }, fonts: { display: 'Russo One', text: 'Exo 2' } });
  const tree = {
    type: 'frame', name: 'Тренировки', fill: 'canvas', children: [
      { type: 'text', name: 'Заголовок', text: 'Темп', style: 'display', color: 'text' },
      { type: 'text', name: 'Подпись', text: 'за неделю', style: 'caption', color: 'muted' },
      { type: 'frame', name: 'Кнопка', fill: 'accent', children: [{ type: 'text', name: 'Надпись', text: 'Старт', style: 'body' }] },
      { type: 'frame', name: 'Карточка', fill: { token: 'surface' }, children: [] },
    ],
  };
  const { tree: t } = applyDirection(tree, dark, doc, { asArtboard: true });
  assert.equal(t.fill, '#15171c');
  assert.equal(t.children[0].color, '#f2f4f7');
  assert.equal(t.children[1].color, '#9aa3b2');
  assert.equal(t.children[2].fill, '#c6ff3d');
  const label = t.children[2].children[0];
  assert.equal(label.color, dark.palette.onAccent, 'надпись на акценте — текст на акценте');
  assert.ok(core.contrastRatio(label.color, '#c6ff3d') >= 4.5);
  assert.equal(t.children[3].fill, '#20242c');
});

/* ── конвейер ───────────────────────────────────────────────────────────── */

test('круг 47: «собери экран» — образ до раскладки, раскладка по образу, критик со снимком доволен', async () => {
  const doc = empty();
  const shots = [];
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE, critique: CRIT_OK }, { vision: true });
  const stages = [];
  const res = await runCommand({
    doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core,
    onStage: (s) => stages.push(s),
    render: async (a) => { shots.push(a); return PNG; },
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'direction', 'tree', 'critique']);
  const treeSys = provider.calls[2].messages[0].content;
  assert.match(treeSys, /АРТ-НАПРАВЛЕНИЕ/);
  assert.match(treeSys, /фон доски #f4ead8/);
  // решение — в ответе и в стадии (оболочка показывает образ, пока идёт раскладка)
  assert.equal(res.direction.concept, DIRECTION.concept);
  assert.equal(res.direction.notes, undefined, 'служебные пометки наружу не идут');
  assert.ok(stages.some((s) => s.stage === 'direct' && s.direction && s.direction.fonts.display === 'Prata'));
  // шрифты — на слоях документа
  const after = res.preview.doc;
  const board = boardOf(after, 'Кофейня');
  assert.equal(after.nodes[board.id].fill, '#f4ead8');
  assert.equal(byName(after, 'Заголовок').style.font, 'Prata');
  assert.equal(core.resolveTextStyle(after, byName(after, 'Подзаголовок')).font, 'Golos Text');
  // критик видел снимок именно новой доски
  assert.equal(shots.length, 1);
  assert.equal(shots[0].artboardId, board.id);
  assert.equal(shots[0].doc.nodes[board.id].name, 'Кофейня', 'снимок — черновик этой правки');
  // решение — полем самой доски: роли палитры живут вместе с правкой (§14.1)
  assert.deepEqual(after.nodes[board.id].direction, { concept: DIRECTION.concept, palette: res.direction.palette, fonts: res.direction.fonts });
  assert.ok(res.ops.some((o) => o.op === 'set' && o.path === 'direction' && o.id === board.id));
  assert.equal(core.checkImportDoc(after), null, 'документ с полем direction проходит строгую проверку');
  const crit = provider.calls[3].messages[1].content;
  assert.ok(Array.isArray(crit), 'реплика критика — с картинкой');
  assert.deepEqual(crit[1], { type: 'image', mime: 'image/png', data: PNG.data });
  assert.match(provider.calls[3].messages[0].content, /РЕШЕНИЕ АРТ-ДИРЕКТОРА/);
  assert.match(provider.calls[3].messages[0].content, /СЛОИ МАКЕТА[\s\S]*Заголовок/, 'со снимком — и имена слоёв');
  assert.equal(res.critique.score, 8.5);
  assert.equal(res.critique.seen, 'image');
  assert.equal(res.critique.revised, undefined);
  assert.ok(stages.some((s) => s.stage === 'critic' && /8\.5\/10/.test(s.detail || '')));
});

test('круг 47: критик недоволен — один круг доработки, принимается доработанное', async () => {
  const doc = empty();
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER], critique: [CRIT_BAD] }, { vision: true });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render: async () => PNG });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'direction', 'tree', 'critique', 'tree'], 'критик — один раз, доработка — один раз');
  const revise = provider.calls[4].messages;
  assert.equal(revise[revise.length - 2].role, 'assistant', 'модель видит своё прежнее дерево');
  assert.match(revise[revise.length - 1].content, /4\/10, выглядит шаблонно/);
  assert.doesNotThrow(() => JSON.parse(revise[revise.length - 2].content), 'прежнее дерево — целым JSON');
  assert.match(revise[revise.length - 1].content, /круглый штамп/);
  assert.ok(byName(res.preview.doc, 'Штамп'), 'доработка на макете');
  assert.equal(byName(res.preview.doc, 'Штамп').rotate, -12);
  assert.equal(res.critique.revised, true);
  assert.equal(artSummary(res.direction, res.critique).verdict, 'Первая сборка — 4 из 10 → доработал: шапка — просто текст по левому краю, без образа');
});

test('круг 47: доработка собралась хуже (отказ, пустое дерево) — остаётся собранное', async () => {
  for (const second of [{ cannot: 'не могу' }, { type: 'frame', name: 'Пусто', children: [{ type: 'whatever' }] }]) {
    const doc = empty();
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, second], critique: [CRIT_BAD] }, { vision: true });
    const res = await runCommand({ doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render: async () => PNG });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.ok(boardOf(res.preview.doc, 'Кофейня'), 'первый вариант на месте');
    assert.notEqual(res.critique.revised, true);
  }
});

test('круг 47: модель отвергла снимок (400) или сеть упала — самопроверка по приметам, зрение остаётся', async () => {
  const { BrainError, visionRefusal } = await import('../src/brain.js');
  assert.equal(visionRefusal(new BrainError('model', 'x', { status: 400 })), true);
  assert.equal(visionRefusal(new BrainError('model', 'x', { status: 500 })), false);
  assert.equal(visionRefusal(new BrainError('model', 'x', { status: 400, code: 'llm_bad_response' })), false);
  assert.equal(visionRefusal(new BrainError('network', 'x', { status: 400 })), false);
  for (const err of [new BrainError('model', 'Модель не приняла запрос', { status: 400 }), new BrainError('network', 'Нет связи')]) {
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER], critique: [err] }, { vision: true });
    const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render: async () => PNG });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.equal(provider.calls.filter((c) => c.schema === 'critique').length, 1, 'второго вызова критика без картинки нет');
    assert.equal(res.critique.seen, 'signals');
    assert.equal(provider.vision, true, 'зрение заявлено — снимок снимается только у этой команды');
    assert.ok(res.serviceNotes.some((n) => /не приняла снимок/.test(n)));
  }
});

test('круг 47: без зрения или без снимка модель-критика не зовут — решают приметы шаблона', async () => {
  for (const [render, vision] of [[null, true], [async () => null, true], [async () => { throw new Error('canvas'); }, true],
    [async () => ({ mime: 'image/png', data: '' }), true], [async () => PNG, undefined], [async () => PNG, false]]) {
    let shots = 0;
    const r = render ? async (a) => { shots++; return render(a); } : null;
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, TREE_BETTER] }, { vision });
    const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render: r });
    assert.equal(res.error, undefined);
    assert.equal(provider.calls.filter((c) => c.schema === 'critique').length, 0);
    assert.equal(res.critique.seen, 'signals');
    assert.equal(res.critique.score, null, 'цифры без снимка нет — её нечем обосновать');
    if (vision !== true) assert.equal(shots, 0, 'модели без заявленного зрения снимок и не делается');
  }
  const plain = { type: 'frame', name: 'Плоско', children: [
    { type: 'text', name: 'А', text: 'Один', style: 'body', align: 'center' }, { type: 'text', name: 'Б', text: 'Два', style: 'body', align: 'center' },
    { type: 'text', name: 'В', text: 'Три', style: 'body', align: 'center' }, { type: 'text', name: 'Г', text: 'Четыре', style: 'body', align: 'center' },
  ] };
  const better = { ...clone(plain), children: [...clone(plain).children.map((c) => ({ ...c, align: 'left' })), { type: 'ellipse', name: 'Пятно', size: { w: 40, h: 40 }, fill: '#ff0000' }] };
  const provider = fake({ plan: PLAN, tree: [plain, better] });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, direction: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.critique.verdict, 'revise', res.critique.signals.join(' | '));
  assert.ok(res.critique.signals.length >= 2);
  assert.ok(res.critique.fixes.length);
  assert.equal(res.critique.revised, true);
  assert.match(provider.calls[provider.calls.length - 1].messages.at(-1).content, /Самопроверка нашла/);
  assert.match(artSummary(null, res.critique).verdict, /^Самопроверка: [а-яё ,]+ → доработал$/);
  assert.ok(res.critique.short.length && res.critique.short.every((x) => x.length <= 40), 'человеку — короткие формы примет');
});

test('круг 47: арт-директор сломался — команда как раньше; критик без оценки — собранное остаётся', async () => {
  const provider = fake({ plan: PLAN, tree: TREE, direction: new Error('500') });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(boardOf(res.preview.doc, 'Кофейня'));
  assert.equal(res.direction, undefined);
  assert.doesNotMatch(provider.calls.find((c) => c.schema === 'tree').messages[0].content, /АРТ-НАПРАВЛЕНИЕ/);
  assert.ok(res.serviceNotes.some((n) => /Арт-направление не получилось/.test(n)));
  assert.equal(res.warnings.some((w) => /Арт|Критик/.test(w)), false, 'человеку о внутренней кухне не говорим');
  const p2 = fake({ plan: PLAN, direction: DIRECTION, tree: TREE, critique: { score: null, verdict: 'ok' } }, { vision: true });
  const r2 = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider: p2, engine: core, render: async () => PNG });
  assert.equal(r2.critique, undefined);
  assert.ok(r2.serviceNotes.some((n) => /без оценки/.test(n)));
});

test('круг 47: вставка в существующую доску — ни образа, ни критика: держим её оформление', async () => {
  const doc = empty();
  const board = Object.values(doc.nodes).find((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
  const provider = fake({ plan: { intent: 'create', title: 'Плашка', summary: 'Добавлю плашку', steps: ['Плашка'] },
    tree: { type: 'frame', name: 'Плашка', children: [{ type: 'text', name: 'Т', text: 'Привет', style: 'body' }] } });
  const res = await runCommand({ doc, selection: [board.id], utterance: 'добавь сюда плашку с приветствием', provider, engine: core, activeArtboardId: board.id });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.filter((c) => c.schema === 'direction' || c.schema === 'critique').length, 0);
  assert.equal(res.direction, undefined);
});

test('круг 47: варианты — у каждого свой образ (с характером варианта), критика нет', async () => {
  const doc = empty();
  const provider = fake({ plan: PLAN, direction: () => DIRECTION, tree: () => TREE });
  const list = await runVariants({ doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, n: 2 });
  assert.equal(list.length, 2);
  const dirs = provider.calls.filter((c) => c.schema === 'direction');
  assert.equal(dirs.length, 2);
  assert.match(dirs[0].messages[0].content, /ХАРАКТЕР ЭТОГО ВАРИАНТА/);
  assert.equal(provider.calls.filter((c) => c.schema === 'critique').length, 0, 'варианты судит человек');
  assert.ok(list.every((v) => v.direction && v.direction.fonts.display === 'Prata'));
});

/* ── приметы шаблона ───────────────────────────────────────────────────── */

test('круг 47: приметы шаблона считаются без модели', () => {
  const doc = empty();
  const board = Object.values(doc.nodes).find((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
  const facts = templateSignals(core, doc, board.id);
  assert.ok(facts.some((f) => /шрифтом по умолчанию \(IBM Plex Sans\)/.test(f)), facts.join(' | '));
  // по решению: шрифта заголовков нет, цвета не те
  const d = normalizeDirection(DIRECTION);
  const withDir = templateSignals(core, doc, board.id, { dir: d });
  assert.ok(withDir.some((f) => /Цвета решения арт-директора почти не использованы/.test(f)), withDir.join(' | '));
});

test('круг 47: вердикт критика — оценка в 0…10, вердикт по оценке, «доработать нечем» — ok', () => {
  assert.equal(normalizeCritique({ score: 15, generic: false, verdict: 'ok', issues: [], fixes: [] }).score, 10);
  assert.equal(normalizeCritique({ score: '5', generic: false, issues: ['a'], fixes: [] }).verdict, 'revise', 'оценка ниже порога — доработать');
  assert.equal(normalizeCritique({ score: CRITIC_PASS, generic: false, issues: [], fixes: [] }).verdict, 'ok');
  assert.equal(normalizeCritique({ score: 3, generic: true, verdict: 'revise', issues: [], fixes: [] }).verdict, 'ok', 'без замечаний дорабатывать нечем');
  assert.equal(normalizeCritique({ score: 'плохо' }), null);
  assert.equal(normalizeCritique('ok'), null);
});

/* ── картинка в реплике: провайдеры ────────────────────────────────────── */

test('круг 47: OpenAI-совместимый провайдер шлёт картинку как image_url с data:', async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(CRIT_OK) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = makeProvider({ kind: 'openai', baseUrl: 'http://x/v1', model: 'm', fetch: fetchImpl });
  assert.equal(p.vision, undefined, 'зрение неизвестно, пока не попробовали');
  const data = await p.complete([
    { role: 'system', content: 'критик' },
    { role: 'user', content: imageTurn('Оцени', PNG) },
  ], SCHEMAS.critique, {});
  assert.equal(data.score, 8.5);
  const user = body.messages.find((m) => m.role === 'user');
  assert.deepEqual(user.content, [{ type: 'text', text: 'Оцени' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.data}` } }]);
  // чужой тип картинки не уходит
  await p.complete([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', mime: 'text/html', data: 'x' }] }], SCHEMAS.critique, {});
  assert.deepEqual(body.messages.find((m) => m.role === 'user').content, [{ type: 'text', text: 'a' }]);
});

test('круг 47: провайдер вида claude (Messages API) — картинка частью image/base64, текст не режется вместе с ней', async () => {
  let turns = null;
  const p = makeProvider({ kind: 'claude', vision: true, sample: { json: async (t) => { turns = t; return CRIT_OK; } } });
  assert.equal(p.vision, true);
  await p.complete([{ role: 'system', content: 'критик' }, { role: 'user', content: imageTurn('Оцени', PNG) }], SCHEMAS.critique, {});
  const last = turns[turns.length - 1];
  assert.deepEqual(last.content, [{ type: 'text', text: 'Оцени' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.data } }]);
  assert.equal(makeProvider({ kind: 'claude', sample: { json: async () => ({}) } }).vision, false, 'способность sample артефакта картинок не берёт');
});

/* ── снимок доски без браузера ─────────────────────────────────────────── */

test('круг 47: renderSVG — та же отрисовка сцены без страницы: текст, заливки, шрифты доски', () => {
  assert.equal(typeof document, 'undefined', 'тест идёт без DOM');
  const doc = empty();
  const d = normalizeDirection(DIRECTION);
  const { tree } = applyDirection(TREE, d, doc, { asArtboard: true });
  const res = quiet(() => runCommandSync(doc, tree));
  const board = boardOf(res, 'Кофейня');
  const out = core.renderSVG(res, board.id);
  assert.ok(out && out.svg.startsWith('<?xml'));
  assert.match(out.svg, /<svg [^>]*viewBox="0 0 390 /);
  assert.match(out.svg, /Утро в Зерне/);
  assert.match(out.svg, /fill="#f4ead8"/i);
  assert.match(out.svg, /font-family="Prata/);
  assert.doesNotMatch(out.svg, /undefined|\[object/);
  assert.deepEqual(out.families.sort(), ['Golos Text', 'Prata']);
  assert.equal(out.width, 390);
  // спецсимволы экранируются
  const t = byName(res, 'Подзаголовок');
  const res2 = core.applyOps(res, [core.ops.set(t.id, 'characters', 'A & B <c> "d"')]).doc;
  const svg2 = core.renderSVG(res2, board.id).svg;
  assert.match(svg2, /A &amp; B &lt;c&gt; &quot;d&quot;/);
  assert.equal(core.renderSVG(res, 'нет-такого'), null);
});

/** Дерево → документ через materialize настоящего прогона (без модели). */
function runCommandSync(doc, tree) {
  const r = core.applyOps(doc, [core.ops.create({ id: 'b1', type: 'frame', name: tree.name, parent: doc.root, pos: { x: 0, y: 0 },
    size: { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } }, fill: tree.fill,
    layout: { mode: 'column', gap: 16, padding: { t: 24, r: 24, b: 24, l: 24 }, align: 'stretch', justify: 'start', wrap: false }, children: [] })]);
  let cur = r.doc;
  let i = 0;
  for (const c of tree.children.filter((x) => x.type === 'text')) {
    const out = core.applyOps(cur, [core.ops.create({ id: `t${i++}`, type: 'text', name: c.name, parent: 'b1', characters: c.text, style: c.style, color: c.color,
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, align: 'left' })]);
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    cur = out.doc;
  }
  return cur;
}

/* ── карточка итога ────────────────────────────────────────────────────── */

test('круг 47: карточка итога — образ, образцы палитры, шрифты, оценка; мусор с сервера мимо', () => {
  const a = artSummary(normalizeDirection(DIRECTION), { score: 8.5, verdict: 'ok', seen: 'image' });
  assert.equal(a.swatches.length, 6);
  assert.deepEqual(a.swatches[0], { role: 'bg', hex: '#f4ead8', label: 'фон' });
  assert.equal(a.fonts, 'Prata + Golos Text');
  assert.deepEqual(a.families, ['Prata', 'Golos Text']);
  assert.equal(a.verdict, 'Взгляд со стороны: 8,5 из 10');
  assert.match(a.line, /^Образ: Утренняя кофейня.* · Prata \+ Golos Text · Взгляд со стороны: 8,5 из 10$/);
  const b = artSummary({ palette: { bg: 'url(javascript:1)', text: '#ABCDEF' }, fonts: { display: 7 } }, { score: 'x' });
  assert.deepEqual(b.swatches, [{ role: 'text', hex: '#abcdef', label: 'текст' }]);
  assert.equal(b.verdict, '');
  assert.equal(artSummary(null, null), null);
  assert.equal(artSummary({}, {}), null);
  assert.match(artSummary(null, { score: 5, verdict: 'revise' }).verdict, /доработка не легла/);
  assert.equal(artSummary(null, { score: null, verdict: 'ok', seen: 'image' }), null, 'оценки нет — нечего показывать');
  // при нечитаемом тексте оценка вида не показывается
  assert.equal(artSummary(normalizeDirection(DIRECTION), { score: 9, verdict: 'ok', seen: 'image' }, { blocked: true }).verdict, '');
  assert.equal(artSummary(null, { seen: 'signals', signals: [], verdict: 'ok' }).verdict, 'Самопроверка: шаблонных ходов не нашёл');
  assert.equal(artSummary(null, { seen: 'signals', signals: ['Почти весь текст по центру'], issues: ['Почти весь текст по центру'], verdict: 'ok' }).verdict,
    'Самопроверка: в целом не шаблонно; почти весь текст по центру');
  assert.equal(artSummary(null, { seen: 'signals', signals: ['x'], short: ['всё по центру'], verdict: 'ok' }).verdict, 'Самопроверка: в целом не шаблонно; всё по центру');
  assert.match(artSummary(null, { seen: 'signals', signals: ['a', 'b'], verdict: 'revise' }).verdict, /доработка не легла/);
  assert.deepEqual(artSummary({ fonts: { display: 'Prata', text: 'Prata' } }, null).families, ['Prata'], 'один шрифт — один образец');
});

test('круг 47: промпт критика — со снимком, слоями, замечаниями проверки и пометками о снимке', () => {
  const t = PROMPTS.critic({ subject: 'x', signals: '- a', problems: '- контраст 1.2', layers: 'Шапка', notes: 'Снимок показывает верх доски' });
  assert.match(t, /снимок только что собранного макета/);
  assert.match(t, /ЗАМЕЧАНИЯ ПРОВЕРКИ[\s\S]*контраст/);
  assert.match(t, /СЛОИ МАКЕТА[\s\S]*Шапка/);
  assert.match(t, /О СНИМКЕ: Снимок показывает верх/);
});

test('круг 47: снимок — доска с картинкой, высокая доска обрезается сверху, моно и эмодзи-безопасность', () => {
  const doc = empty();
  const b = Object.values(doc.nodes).find((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
  const t = Object.values(doc.nodes).find((n) => n.type === 'text');
  const r = core.applyOps(doc, [
    core.ops.create({ id: 'im1', type: 'image', name: 'Фото', parent: b.id, src: 'data:image/png;base64,iVBORw0KGgo=', size: { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 80 } } }),
    core.ops.set(t.id, 'characters', 'a\u0001b © 2026'),
  ]);
  assert.equal(r.error, undefined);
  const out = quiet(() => core.renderSVG(r.doc, b.id, { maxHeight: 300 }));
  assert.ok(out, 'доска с картинкой снимается');
  assert.match(out.svg, /xlink:href="data:image\/png/);
  assert.doesNotMatch(out.svg, /\u0001/, 'управляющих знаков в XML нет');
  assert.match(out.svg, /© 2026/);
  assert.equal(out.cropped, true);
  assert.equal(out.height, 300);
  assert.ok(out.fullHeight > 300);
  assert.match(out.svg, /^<\?xml[^>]*>\s*<svg [^>]*height="300"[^>]*viewBox="0 0 \d+ 300"/);
  // «Rubik Mono One» — акцидентный, не моно; «JetBrains Mono» — моно, но своим шрифтом
  assert.equal(core.resolveTextStyle(doc, { style: { token: 'body', font: 'Rubik Mono One' } }).mono, false);
  assert.match(core.resolveTextStyle(doc, { style: { token: 'body', font: 'JetBrains Mono' } }).fontFamily, /^JetBrains Mono, IBM Plex Mono/);
});

test('круг 47: тема документа при досках в своей палитре — об этом сказано', async () => {
  const doc = empty();
  const b = Object.values(doc.nodes).find((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
  const d2 = core.applyOps(doc, [core.ops.set(b.id, 'fill', '#15171c')]).doc;
  const provider = fake({ plan: { intent: 'theme', title: 'Тёмная', summary: 'Тёмная тема', steps: ['Цвета'] },
    theme: { summary: 'Тёмная', colors: [{ name: 'canvas', value: '#101418' }, { name: 'text', value: '#f2f4f8' }] } });
  const res = await runCommand({ doc: d2, selection: [], utterance: 'сделай тёмную тему', provider, engine: core });
  assert.ok(res.warnings.some((w) => /собран в собственной палитре/.test(w)), res.warnings.join(' | '));
});

test('круг 47: доработка по приметам принимается, только если примет стало меньше', async () => {
  const plain = { type: 'frame', name: 'Плоско', children: [
    { type: 'text', name: 'А', text: 'Один', style: 'body', align: 'center' }, { type: 'text', name: 'Б', text: 'Два', style: 'body', align: 'center' },
    { type: 'text', name: 'В', text: 'Три', style: 'body', align: 'center' }, { type: 'text', name: 'Г', text: 'Четыре', style: 'body', align: 'center' },
  ] };
  const provider = fake({ plan: PLAN, tree: [plain, clone(plain)] });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, direction: false });
  assert.equal(res.error, undefined);
  assert.equal(provider.calls.filter((c) => c.schema === 'tree').length, 2, 'доработку попросили');
  assert.notEqual(res.critique.revised, true, 'примет столько же — оставлен первый вариант');
  assert.ok(res.serviceNotes.some((n) => /собралась хуже/.test(n)));
});

test('круг 47: при арт-направлении правила 4 и 5 переписаны — без противоречия «предпочитай токены»', async () => {
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE });
  await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core });
  const sys = provider.calls.find((c) => c.schema === 'tree').messages[0].content;
  assert.match(sys, /4\. Цвета \(fill, stroke, color\) — #rrggbb из палитры АРТ-НАПРАВЛЕНИЯ/);
  assert.doesNotMatch(sys, /Предпочитай токены/);
  assert.match(sys, /fontSize:<до 96>/);
  // без направления — как раньше
  const p2 = fake({ plan: PLAN, tree: TREE });
  await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider: p2, engine: core, direction: false, critic: false });
  assert.match(p2.calls.find((c) => c.schema === 'tree').messages[0].content, /Предпочитай токены/);
  // при образе схема дерева — с полем кегля акцента; без образа модель его не видит вовсе
  const withDir = provider.calls.find((c) => c.schema === 'tree').entry;
  assert.ok(JSON.stringify(withDir.schema).includes('"fontSize"'));
  assert.match(withDir.hint, /fontSize\?: number/);
  assert.ok(!JSON.stringify(p2.calls.find((c) => c.schema === 'tree').entry.schema).includes('"fontSize"'));
  assert.doesNotMatch(SCHEMAS.tree.hint, /fontSize\?/);
});

test('круг 47: кегль акцента — отдельным полем fontSize (12…96) только при образе; мусорные числа стиля не роняют команду', async () => {
  const doc = empty();
  const d = normalizeDirection(DIRECTION);
  const { tree } = applyDirection({ type: 'frame', children: [
    { type: 'text', text: '240', style: 'display', fontSize: 300 },
    { type: 'text', text: 'мало', style: 'body', fontSize: 2 },
  ] }, d, doc, { asArtboard: true });
  assert.equal(tree.children[0].style.fontSize, 96);
  assert.equal(tree.children[0].style.font, 'Prata');
  assert.equal(tree.children[0].fontSize, undefined);
  assert.equal(tree.children[1].style.fontSize, 12);
  assert.deepEqual(SCHEMAS.tree.schema.properties.style, { type: 'string' }, 'style в схеме — снова строка: без объектов внутри anyOf');
  // мусор в style от модели (объект с негодным кеглем) — команда не падает
  for (const bad of ['x', -5, null, 1e9]) {
    const t = clone(TREE);
    t.children[0].style = { token: 'display', fontSize: bad };
    const provider = fake({ plan: PLAN, tree: t });
    const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, direction: false, critic: false });
    assert.equal(res.error, undefined, `${bad}: ${JSON.stringify(res.error)}`);
    const st = byName(res.preview.doc, 'Заголовок').style;
    if (typeof st === 'object' && 'fontSize' in st) assert.ok(st.fontSize >= 6 && st.fontSize <= 400);
  }
  // без образа поле fontSize ничего не меняет
  const t2 = clone(TREE);
  t2.children[0].fontSize = 80;
  const p2 = fake({ plan: PLAN, tree: t2 });
  const r2 = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider: p2, engine: core, direction: false, critic: false });
  assert.equal(r2.error, undefined);
  assert.equal(core.resolveTextStyle(r2.preview.doc, byName(r2.preview.doc, 'Заголовок')).fontSize, 34);
});

test('круг 47: подпись стадии — шрифты первыми, образ режется по слову; тема при своей палитре — без «ВСЕ доски»', async () => {
  const stages = [];
  const provider = fake({ plan: PLAN, direction: { ...DIRECTION, concept: 'Очень длинный образ ночной беговой дорожки со светоотражателями и табло секундомера на мокром асфальте' }, tree: TREE });
  await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, onStage: (s) => stages.push(s), critic: false });
  const gen = stages.find((s) => s.stage === 'generate');
  assert.match(gen.detail, /^Prata \+ Golos Text · /);
  assert.match(gen.detail, /[а-яё]…$/, 'обрезано по слову и с многоточием');
  const doc = empty();
  const boards = Object.values(doc.nodes).filter((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
  const d2 = core.applyOps(doc, [core.ops.set(boards[0].id, 'fill', '#15171c')]).doc;
  const p2 = fake({ plan: { intent: 'theme', title: 'Тёмная', summary: 'Тёмная', steps: ['Цвета'] }, theme: { summary: 'Тёмная', colors: [{ name: 'text', value: '#f2f4f8' }] } });
  const res = await runCommand({ doc: d2, selection: [], utterance: 'сделай тёмную тему', provider: p2, engine: core });
  const all = res.warnings.join(' | ');
  assert.doesNotMatch(all, /ВСЕ доски/);
  assert.match(all, /поменялись все доски на цветах документа/);
  assert.match(all, /его не перекрасят/);
});
