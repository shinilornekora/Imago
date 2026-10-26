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
      calls.push({ schema: name, messages, opts });
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
const DIRECTION = SCHEMAS.direction.example;
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
  assert.match(directionBrief(d), /заголовки и крупные цифры — Prata, текст — Golos Text/);
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
  assert.deepEqual(normalizeDirection(SCHEMAS.direction.example).fonts, { display: 'Prata', text: 'Golos Text' });
  assert.equal(normalizeCritique(SCHEMAS.critique.example).verdict, 'revise');
});

/* ── воплощение решения ────────────────────────────────────────────────── */

test('круг 47: шрифты решения — заголовочным стилям display, прочим text, с ближайшим начертанием', () => {
  const doc = empty();
  const d = normalizeDirection(DIRECTION);
  const { tree, fonts } = applyDirection(TREE, d, doc, { asArtboard: true });
  assert.equal(fonts, 4, 'все четыре текста');
  const [title, sub, row] = tree.children;
  assert.deepEqual(title.style, { token: 'display', font: 'Prata', fontWeight: 400 }, 'у Prata только 400 — стоит 400, а не синтетический жирный');
  assert.deepEqual(sub.style, { token: 'body', font: 'Golos Text' });
  assert.equal(row.children[0].style.font, 'Prata', 'heading — заголовочный');
  assert.equal(title.color, d.palette.text, 'тексту без цвета — текст палитры');
  assert.equal(row.children[1].color, '#2f6f62', 'цвет модели не трогаем');
  assert.equal(tree.fill, '#f4ead8', 'новой доске без фона — фон палитры');
  assert.equal(TREE.children[0].style, 'display', 'исходное дерево не тронуто');
  // шрифт, который модель уже поставила из набора, — её выбор
  const own = applyDirection({ type: 'text', text: 'x', style: { token: 'display', font: 'Unbounded' } }, d, doc);
  assert.equal(own.tree.style.font, 'Unbounded');
  assert.equal(own.fonts, 0);
  // блок внутри существующей доски фон доски не перекрашивает
  assert.equal(applyDirection(TREE, d, doc, { asArtboard: false }).tree.fill, undefined);
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
  assert.equal(shots[0].doc, after);
  const crit = provider.calls[3].messages[1].content;
  assert.ok(Array.isArray(crit), 'реплика критика — с картинкой');
  assert.deepEqual(crit[1], { type: 'image', mime: 'image/png', data: PNG.data });
  assert.match(provider.calls[3].messages[0].content, /РЕШЕНИЕ АРТ-ДИРЕКТОРА/);
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
  assert.match(revise[revise.length - 1].content, /круглый штамп/);
  assert.ok(byName(res.preview.doc, 'Штамп'), 'доработка на макете');
  assert.equal(byName(res.preview.doc, 'Штамп').rotate, -12);
  assert.equal(res.critique.revised, true);
  assert.equal(artSummary(res.direction, res.critique).verdict, 'критик 4/10 — доработал по замечаниям');
});

test('круг 47: доработка собралась хуже (отказ, пустое дерево) — остаётся собранное', async () => {
  for (const second of [{ cannot: 'не могу' }, { type: 'frame', name: 'Пусто', children: [{ type: 'whatever' }] }]) {
    const doc = empty();
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: [TREE, second], critique: [CRIT_BAD] });
    const res = await runCommand({ doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.ok(boardOf(res.preview.doc, 'Кофейня'), 'первый вариант на месте');
    assert.notEqual(res.critique.revised, true);
  }
});

test('круг 47: модель не приняла картинку — критик смотрит выжимку, провайдер помечен «без зрения»', async () => {
  const { BrainError } = await import('../src/brain.js');
  const doc = empty();
  let renders = 0;
  const render = async () => { renders++; return PNG; };
  const provider = fake({
    plan: [PLAN, PLAN], direction: [DIRECTION, DIRECTION], tree: [TREE, TREE],
    critique: [new BrainError('model', 'Модель не приняла запрос'), CRIT_OK, CRIT_OK],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const crits = provider.calls.filter((c) => c.schema === 'critique');
  assert.equal(crits.length, 2);
  assert.ok(Array.isArray(crits[0].messages[1].content), 'сначала — со снимком');
  assert.equal(typeof crits[1].messages[1].content, 'string', 'потом — без');
  assert.match(crits[1].messages[0].content, /МАКЕТ \(выжимка/);
  assert.match(crits[1].messages[0].content, /Утро в Зерне/, 'в выжимке — новая доска');
  assert.equal(res.critique.seen, 'text');
  assert.equal(provider.vision, false);
  assert.ok(res.serviceNotes.some((n) => /не приняла снимок/.test(n)));
  // следующая команда снимок уже не просит
  await runCommand({ doc, selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render });
  assert.equal(renders, 1);
});

test('круг 47: сеть оборвалась на снимке — по выжимке, но зрение не снимается', async () => {
  const { BrainError } = await import('../src/brain.js');
  const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE, critique: [new BrainError('network', 'Нет связи с моделью'), CRIT_OK] });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render: async () => PNG });
  assert.equal(res.critique.seen, 'text');
  assert.notEqual(provider.vision, false);
});

test('круг 47: снимка нет (render не дан, вернул null или упал) — критик по выжимке, команда цела', async () => {
  for (const render of [null, async () => null, async () => { throw new Error('canvas'); }, async () => ({ mime: 'image/png', data: '' })]) {
    const provider = fake({ plan: PLAN, direction: DIRECTION, tree: TREE, critique: CRIT_OK });
    const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, render });
    assert.equal(res.error, undefined);
    const c = provider.calls.find((x) => x.schema === 'critique');
    assert.equal(typeof c.messages[1].content, 'string');
    assert.equal(res.critique.seen, 'text');
  }
});

test('круг 47: арт-директор и критик сломались — команда выполняется как раньше, без образа', async () => {
  const provider = fake({ plan: PLAN, tree: TREE, direction: new Error('500'), critique: { nonsense: true } });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(boardOf(res.preview.doc, 'Кофейня'));
  assert.equal(res.direction, undefined);
  assert.equal(res.critique, undefined);
  assert.doesNotMatch(provider.calls.find((c) => c.schema === 'tree').messages[0].content, /АРТ-НАПРАВЛЕНИЕ/);
  assert.ok(res.serviceNotes.some((n) => /Арт-направление не получилось/.test(n)));
  assert.ok(res.serviceNotes.some((n) => /без оценки/.test(n)));
  assert.equal(res.warnings.some((w) => /Арт|Критик/.test(w)), false, 'человеку о внутренней кухне не говорим');
});

test('круг 47: direction:false и critic:false — ни одного лишнего вызова; правка — без образа и критика', async () => {
  const provider = fake({ plan: PLAN, tree: TREE });
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'собери экран меню кофейни', provider, engine: core, direction: false, critic: false });
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'tree']);
  assert.equal(res.error, undefined);
  // правка существующего — не «новое оформление»: ни арт-директора, ни критика
  const doc = empty();
  const t = Object.values(doc.nodes).find((n) => n.type === 'text');
  const p2 = fake({ plan: { intent: 'edit', title: 'Крупнее', summary: 'Крупнее', steps: ['Стиль'] }, patch: { edits: [{ op: 'set', target: t.id, path: 'style', value: 'display' }] } });
  await runCommand({ doc, selection: [t.id], utterance: 'сделай крупнее', provider: p2, engine: core });
  assert.equal(p2.calls.filter((c) => c.schema === 'direction' || c.schema === 'critique').length, 0);
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

test('круг 47: карточка итога — образ, образцы палитры, шрифты, критик; мусор с сервера мимо', () => {
  const a = artSummary(normalizeDirection(DIRECTION), { score: 8.5, verdict: 'ok', seen: 'image' });
  assert.equal(a.swatches.length, 6);
  assert.deepEqual(a.swatches[0], { role: 'bg', hex: '#f4ead8', label: 'фон' });
  assert.equal(a.fonts, 'Prata + Golos Text');
  assert.equal(a.verdict, 'критик 8,5/10');
  assert.match(a.line, /^Образ: Утренняя кофейня.* · Prata \+ Golos Text · критик 8,5\/10$/);
  const b = artSummary({ palette: { bg: 'url(javascript:1)', text: '#ABCDEF' }, fonts: { display: 7 } }, { score: 'x' });
  assert.deepEqual(b.swatches, [{ role: 'text', hex: '#abcdef', label: 'текст' }]);
  assert.equal(b.verdict, '');
  assert.equal(artSummary(null, null), null);
  assert.equal(artSummary({}, {}), null);
  assert.match(artSummary(null, { score: 5, verdict: 'revise', seen: 'text' }).verdict, /доработка не легла.*без снимка/);
});

test('круг 47: промпт критика без снимка — с выжимкой, со снимком — без неё', () => {
  const t = PROMPTS.critic({ subject: 'x', seen: 'text', digest: 'ВЫЖИМКА', signals: '- a' });
  assert.match(t, /картинки нет/);
  assert.match(t, /ВЫЖИМКА/);
  const i = PROMPTS.critic({ subject: 'x', seen: 'image', digest: '', signals: '- a' });
  assert.match(i, /снимок приложен/);
  assert.doesNotMatch(i, /МАКЕТ \(выжимка/);
});
