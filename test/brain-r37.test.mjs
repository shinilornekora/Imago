/**
 * Круг 37 (SPEC §12): агент рисует векторные иллюстрации.
 * Жалоба: «качественная фигурка 2D-монстра» выходила стопкой прямоугольников в колонке,
 * «виджет печеньки» — плоским кругом с точками. Модель поддельная, движок — настоящий core.js:
 * каждая деталь обязана пройти ядро (parsePath, applyOps, validate).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import {
  runCommand, PROMPTS, SCHEMAS, downgradeSchema, classifyUtterance, describeDoc, describeChange,
  compileIllustration, mergeIllustration, parseArtPath, formatArtPath, artPaint, artTone, isArtFrame,
  normalizePath, ruPath, ruPathGen, coerceValue, ALLOWED_PATH_HEADS, ART_LEGEND, ART_LIMITS, looksIllustration,
} from '../src/brain.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
/** Разбор пути ядром, если ядро его уже экспортирует, иначе — зеркалом мозга. */
const corePath = (d) => (typeof core.parsePath === 'function' ? core.parsePath(d) : parseArtPath(d));

/** Круг 47: вызовы модели без арт-директора и критика — их проверяет test/brain-r47. */
const MAIN = (c) => c.schema !== 'direction' && c.schema !== 'critique';

/** Поддельная модель: ответы по имени схемы, массив — по очереди. */
function fake(script) {
  const calls = [];
  return {
    name: 'fake', calls,
    async ready() { return true; },
    async complete(messages, schema, opts = {}) {
      const name = schema && schema.name;
      if (MAIN({ schema: name })) calls.push({ schema: name, messages, opts });
      let v = script[name];
      if (Array.isArray(v)) v = v.shift();
      if (typeof v === 'function') v = v(messages);
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}

const byName = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name);
const boardOf = (doc) => Object.values(doc.nodes).find((n) => n.parent === doc.root && n.type === 'frame' && n.role !== 'library');
const MONSTER = SCHEMAS.illustration.example;

/** Печенька — как отвечает хорошая модель (неровный край, шоколад, крошки, тень, блик). */
const COOKIE = {
  name: 'Печенька', canvas: { w: 400, h: 400 }, background: 'none',
  palette: [{ name: 'dough', color: '#e3a85f' }, { name: 'choco', color: '#4a2a14' }],
  parts: [
    { name: 'Тень', kind: 'ellipse', x: 86, y: 304, w: 228, h: 30, fill: '#5b3a1e', opacity: 0.2 },
    { name: 'Печенье', kind: 'path', d: 'M200 56 C225 57 253 73 274 88 C296 103 321 124 329 148 C337 172 331 204 323 230 C315 255 302 287 281 302 C261 316 227 318 200 317 C173 316 141 312 122 298 C102 283 91 253 82 228 C73 203 63 172 70 148 C77 124 102 100 124 85 C145 70 175 55 200 56 Z', fill: 'dough' },
    { name: 'Тень печенья', kind: 'path', d: 'M321 178 C324 236 296 290 238 306 C222 310 206 310 192 308 C258 296 304 248 321 178 Z', fill: 'dough-shade' },
    { name: 'Блик', kind: 'path', d: 'M96 160 C104 118 140 86 182 74 C150 96 124 124 112 160 C108 172 94 172 96 160 Z', fill: 'dough-light', opacity: 0.85 },
    { name: 'Кусочек шоколада 1', kind: 'path', d: 'M140 120 L166 112 L174 136 L156 150 L134 140 Z', fill: 'choco', group: 'Кусочки шоколада' },
    { name: 'Кусочек шоколада 2', kind: 'path', d: 'M226 104 L250 110 L246 132 L222 130 Z', fill: 'choco', group: 'Кусочки шоколада' },
    { name: 'Кусочек шоколада 3', kind: 'path', d: 'M266 170 L292 164 L298 190 L276 200 L262 188 Z', fill: 'choco', group: 'Кусочки шоколада' },
    { name: 'Крошка 1', kind: 'ellipse', x: 318, y: 318, w: 12, h: 9, fill: 'dough-shade' },
    { name: 'Крошка 2', kind: 'ellipse', x: 92, y: 322, w: 9, h: 7, fill: 'dough-shade' },
    { name: 'Крошка 3', kind: 'ellipse', x: 292, y: 338, w: 7, h: 6, fill: 'dough' },
  ],
};

/** Ответ слабой модели «по-старому»: персонаж из прямоугольников в колонку. */
const STICKS = {
  name: 'Монстр', canvas: { w: 400, h: 400 },
  parts: [
    { name: 'Рожок левый', kind: 'rect', x: 150, y: 20, w: 12, h: 50, fill: '#ffd400' },
    { name: 'Рожок правый', kind: 'rect', x: 238, y: 20, w: 12, h: 50, fill: '#ffd400' },
    { name: 'Голова', kind: 'rect', x: 140, y: 70, w: 120, h: 100, fill: '#ff6fb5' },
    { name: 'Тело', kind: 'rect', x: 130, y: 170, w: 140, h: 120, fill: '#ff6fb5' },
    { name: 'Рука', kind: 'rect', x: 90, y: 180, w: 40, h: 14, fill: '#ff6fb5' },
    { name: 'Нога', kind: 'rect', x: 150, y: 290, w: 30, h: 60, fill: '#ff6fb5' },
  ],
};

const PLAN_CREATE = { intent: 'create', title: 'Монстр', summary: 'Соберу фигурку монстра', steps: ['Собрать'] };
const PLAN_ART = { intent: 'illustration', title: 'Милый монстр', summary: 'Нарисую монстра', steps: ['Нарисовать'] };

function demo() {
  const doc = quiet(() => core.createDoc());
  return { doc, board: boardOf(doc).id };
}

/** Документ с уже нарисованным монстром (как после «нарисуй милого 2D-монстра»). */
async function withMonster() {
  const { doc, board } = demo();
  const res = await runCommand({
    doc, selection: [], utterance: 'нарисуй милого 2D-монстра', engine: core, activeArtboardId: board,
    provider: fake({ plan: PLAN_ART, illustration: MONSTER }),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const frame = Object.values(after.nodes).find((n) => n.role === 'illustration');
  return { doc: after, frame, board };
}

/** Все пути всех векторов поддерева проходят ядро. */
function assertPathsPassCore(doc, rootId) {
  const walk = (id) => {
    const n = doc.nodes[id];
    if (n.type === 'vector') {
      assert.ok(Array.isArray(n.paths) && n.paths.length, `у «${n.name}» нет контуров`);
      for (const p of n.paths) {
        const r = corePath(p.d);
        assert.ok(r && r.ok !== false, `контур «${n.name}» не прошёл ядро: ${r && r.error}`);
      }
      assert.ok(n.viewBox && n.viewBox.w > 0 && n.viewBox.h > 0, `у «${n.name}» нет viewBox`);
    }
    for (const k of n.children || []) walk(k);
  };
  walk(rootId);
}

/* ── 1. Классификатор и схема ─────────────────────────────────────────────── */

test('круг 37: «нарисуй», «персонаж», «маскот», «фигурка» — иллюстрация; «виджет печеньки» — интерфейс с картинкой', () => {
  for (const u of ['нарисуй милого 2D-монстра', 'качественная фигурка 2D-монстра', 'иллюстрация котика',
    'маскот для приложения', 'нарисуй кота', 'персонаж-дракончик', 'иконка с печенькой']) {
    assert.equal(classifyUtterance(u).intent, 'illustration', u);
  }
  const w = classifyUtterance('виджет печеньки');
  assert.equal(w.intent, 'create');
  assert.equal(w.art, true, 'виджет с картинкой внутри');
  assert.equal(classifyUtterance('нарисуй экран входа').intent, 'create', 'экран — интерфейс, не рисунок');
  assert.ok(!classifyUtterance('нарисуй экран входа').art);
  assert.equal(classifyUtterance('сделай иконки крупнее').intent, 'edit');
  assert.equal(classifyUtterance('который час').intent !== 'illustration', true, '«кот» внутри слова — не котик');
  assert.ok(looksIllustration('нарисуй дракона') && !looksIllustration('собери экран профиля'));
});

test('круг 37: правка уже нарисованного — edit («сделай монстра зелёным», «добавь рожки» при выделенном рисунке)', async () => {
  const { doc, frame } = await withMonster();
  const kids = new Set([frame.id, ...frame.children]);
  const g = classifyUtterance('сделай монстрика зелёным', { doc, prefer: kids });
  assert.equal(g.intent, 'edit', JSON.stringify(g));
  assert.equal(g.art, true);
  const h = classifyUtterance('добавь рожки', { doc, hasSelection: true, prefer: kids });
  assert.equal(h.intent, 'edit', JSON.stringify(h));
  assert.equal(classifyUtterance('увеличь глаза', { doc, prefer: kids }).intent, 'edit');
  assert.equal(classifyUtterance('нарисуй ещё одного монстрика', { doc, prefer: kids }).intent, 'illustration');
});

test('круг 37: схема иллюстрации простая для локальной грамматики; план знает вид illustration', () => {
  const e = SCHEMAS.illustration;
  assert.equal(e.name, 'illustration');
  assert.deepEqual(e.schema.required, ['name', 'canvas', 'parts']);
  const part = e.schema.properties.parts.items;
  for (const k of ['name', 'kind', 'd', 'x', 'y', 'w', 'h', 'fill', 'gradient', 'stroke', 'strokeWidth', 'rotate', 'opacity', 'group']) {
    assert.ok(part.properties[k], `у детали нет поля ${k}`);
  }
  assert.deepEqual(part.properties.kind.enum, ['path', 'ellipse', 'rect']);
  // fill — строка, градиент — отдельным полем: вложенных объединений нет (п.2 правил схем)
  assert.equal(part.properties.fill.type, 'string');
  const flat = JSON.stringify(downgradeSchema(e.schema));
  assert.doesNotMatch(flat, /anyOf/, 'в схеме иллюстрации нет объединений вовсе');
  assert.ok(SCHEMAS.plan.schema.properties.intent.enum.includes('illustration'));
  const treeTypes = SCHEMAS.tree.schema.properties.type.enum;
  assert.ok(treeTypes.includes('illustration') && treeTypes.includes('vector'));
  assert.ok(SCHEMAS.tree.schema.properties.draw && SCHEMAS.patch.schema.properties.edits.items.properties.node.properties.d);
  assert.match(e.hint, /СНИЗУ ВВЕРХ/);
  assert.match(e.hint, /-shade/);
});

test('круг 37: образец ответа (few-shot) сам проходит компилятор и ядро — 22 детали без потерь', () => {
  const warns = [];
  const got = compileIllustration(MONSTER, { engine: core, warn: (m) => warns.push(m) });
  assert.deepEqual(warns, []);
  assert.equal(got.parts, MONSTER.parts.length);
  assert.equal(got.dropped.length, 0);
  assert.deepEqual(got.blocking, []);
  for (const k of got.spec.children) for (const p of k.$vector.paths) assert.ok(corePath(p.d).ok !== false, p.d);
  // глаз — одна деталь из трёх контуров (белок, зрачок, блик)
  const eye = got.spec.children.find((c) => c.name === 'Левый глаз');
  assert.ok(eye, 'группа «Левый глаз» стала одним слоем');
  assert.equal(eye.$vector.paths.length, 3);
  assert.deepEqual(eye.$vector.paths.map((p) => p.name), ['Белок левого глаза', 'Зрачок левого глаза', 'Блик левого глаза']);
});

/* ── 2. Промпт иллюстратора ──────────────────────────────────────────────── */

test('круг 37: промпт иллюстратора учит технике и даёт образцы (тело-капля, глаз с бликом, печенька)', () => {
  const text = PROMPTS.illustration({ subject: 'милый 2D-монстр', canvas: { w: 400, h: 400 }, where: 'отдельной доской', colors: 'accent #2a6fdb' });
  for (const re of [/СНИЗУ ВВЕРХ/, /силуэт/i, /C, Q/, /перекрыва/i, /тень.*блик|основа.*тень.*блик/is, /сверху-слева/,
    /мягкая тень/i, /контур/i, /белок/i, /зрачок/i, /блик/i, /4–6/, /20–60/, /прямоугольник/i, /Не копируй/,
    /accent #2a6fdb/, /милый 2D-монстр/, /400×400/, /ось y/]) {
    assert.match(text, re, String(re));
  }
  for (const s of ['Тело-капля', 'Блик левого глаза', 'Печенька', 'Кусочек шоколада', 'Крошка', 'radial']) assert.ok(text.includes(s), s);
  // каждая деталь-образец из промпта сама проходит ядро
  const ds = [...text.matchAll(/"d":"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ds.length >= 5, 'образцов путей хватает');
  for (const d of ds) assert.ok(corePath(d).ok !== false, d);
});

test('круг 37: правила DSL больше не говорят «поворота и градиента нет» и учат узлу illustration', () => {
  const ctx = { tokens: '', digest: '', scopeLabel: 'активная доска', guess: 'create', personaHint: '', placement: '', scales: null };
  const all = [PROMPTS.tree(ctx), PROMPTS.patch(ctx), PROMPTS.planner(ctx)].join('\n');
  assert.doesNotMatch(all, /НЕТ ВООБЩЕ: поворота/);
  assert.doesNotMatch(all, /просят поворот, градиент/);
  assert.match(PROMPTS.tree(ctx), /type:"illustration"/);
  assert.match(PROMPTS.tree(ctx), /НЕ собирай из rect и ellipse/);
  assert.match(PROMPTS.planner(ctx), /- illustration —/);
  assert.match(PROMPTS.patch(ctx), /rotate/);
  // правила правки рисунков — только если в документе есть рисунки
  assert.doesNotMatch(PROMPTS.patch(ctx), /ПРАВКА ИЛЛЮСТРАЦИЙ/);
  assert.match(PROMPTS.patch({ ...ctx, art: true }), /ПРАВКА ИЛЛЮСТРАЦИЙ/);
});

/* ── 3. «Нарисуй милого 2D-монстра» ───────────────────────────────────────── */

test('круг 37: «нарисуй милого 2D-монстра» — свободная рамка с векторами новой доской, пути проходят ядро, колонки нет', async () => {
  const { doc, board } = demo();
  // план «по старой привычке» говорит create — классификатор уверен, что это рисунок
  const provider = fake({ plan: PLAN_CREATE, illustration: MONSTER });
  const res = await runCommand({ doc, selection: [], utterance: 'нарисуй милого 2D-монстра', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'illustration'], 'дерево раскладки не строилось');
  assert.ok(provider.calls[1].opts.maxTokens >= 8000, 'иллюстратору — запас токенов');
  const after = res.preview.doc;
  const frames = Object.values(after.nodes).filter((n) => n.role === 'illustration');
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.parent, after.root, 'картинка сама по себе — отдельной доской');
  assert.equal(f.layout.mode, 'none', 'свободная рамка, не колонка');
  assert.equal(f.clip, true);
  assert.equal(f.size.w.mode, 'fixed');
  assert.ok(f.pos, 'у доски есть место на холсте');
  const kids = f.children.map((id) => after.nodes[id]);
  assert.ok(kids.length >= 10, `слоёв ${kids.length}`);
  assert.ok(kids.every((k) => k.type === 'vector'), 'все детали — векторы, ни одного rect/frame-кирпичика');
  assertPathsPassCore(after, f.id);
  // не стопка: детали стоят по своим pos, а не в одну вертикаль
  const xs = new Set(kids.map((k) => Math.round(k.pos.x)));
  assert.ok(xs.size >= 6, 'детали расставлены по рисунку, а не колонкой');
  const errs = core.validate(after, core.solve(after)).filter((v) => (v.nodeId === f.id || f.children.includes(v.nodeId)) && v.level !== 'info');
  assert.deepEqual(errs.map((v) => v.code), [], 'ядро не нашло ошибок');
  assert.equal(res.changeSummary, `Нарисовал «${MONSTER.name}»: ${MONSTER.parts.length} детали`);
  const body = kids.find((k) => k.name === 'Тело');
  assert.ok(body && body.paths[0].stroke === '#2e1065', 'контур — один тёмный цвет у крупных форм');
  assert.ok(!kids.find((k) => k.name === 'Тень').paths[0].stroke, 'у тени контура нет');
  // тон «body-shade» посчитан из основы: темнее
  const shade = kids.find((k) => k.name === 'Тень на теле').paths[0].fill;
  assert.equal(shade, artTone('#8b5cf6', 'shade'));
});

test('круг 37: ответ «стопкой прямоугольников» отправляется на одну починку и перерисовывается кривыми', async () => {
  const { doc, board } = demo();
  const provider = fake({ plan: PLAN_ART, illustration: [STICKS, MONSTER] });
  const res = await runCommand({ doc, selection: [], utterance: 'качественная фигурка 2D-монстра', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'illustration', 'illustration']);
  const repairTurn = provider.calls[2].messages[provider.calls[2].messages.length - 1].content;
  assert.match(repairTurn, /прямоугольник/);
  assert.match(repairTurn, /кривыми/);
  const repairStage = res.stages.find((s) => s.stage === 'repair');
  assert.match(repairStage.detail, /из прямоугольников — прошу модель перерисовать/, 'человеку — словами, а не текстом для модели');
  const f = Object.values(res.preview.doc.nodes).find((n) => n.role === 'illustration');
  assert.equal(f.name, MONSTER.name, 'взят исправленный рисунок');
});

test('круг 37: прямоугольники и после починки — рисунок остаётся, человеку сказано, что вышло угловато', async () => {
  const { doc, board } = demo();
  const provider = fake({ plan: PLAN_ART, illustration: [STICKS, STICKS] });
  const res = await runCommand({ doc, selection: [], utterance: 'нарисуй монстра', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined);
  assert.ok(res.warnings.some((w) => /угловат/.test(w)), res.warnings.join('\n'));
  assert.equal(provider.calls.length, 3, 'круг починки один');
});

test('круг 37: битый путь — деталь отброшена с предупреждением, починка просит только её, ответ встаёт на место', async () => {
  const { doc, board } = demo();
  const broken = clone(MONSTER);
  const at = broken.parts.findIndex((p) => p.name === 'Левый рожок');
  broken.parts[at].d = 'M150 122 C134 92 132 62 Z';                // C без чисел
  const fixedPart = clone(MONSTER.parts[at]);
  const provider = fake({ plan: PLAN_ART, illustration: [broken, { name: MONSTER.name, canvas: MONSTER.canvas, parts: [fixedPart] }] });
  const res = await runCommand({ doc, selection: [], utterance: 'нарисуй милого монстра', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.length, 3, 'одна починка');
  const repairTurn = provider.calls[2].messages[provider.calls[2].messages.length - 1].content;
  assert.match(repairTurn, /«Левый рожок»/);
  assert.match(repairTurn, /только исправленные детали/);
  const after = res.preview.doc;
  const f = Object.values(after.nodes).find((n) => n.role === 'illustration');
  const names = f.children.map((id) => after.nodes[id].name);
  assert.ok(names.includes('Левый рожок'), 'исправленная деталь на месте');
  assert.equal(names.indexOf('Левый рожок'), 1, 'и на своём слое — сразу над тенью');
  assert.ok(!res.warnings.some((w) => /отброшен/.test(w)), 'после починки терять нечего');
  assert.match(res.changeSummary, /22 детали/);
});

test('круг 37: битый путь и неудачная починка — рисунок без этой детали и предупреждение словами', async () => {
  const { doc, board } = demo();
  const broken = clone(MONSTER);
  broken.parts[1].d = 'нарисуй рожок';
  const provider = fake({ plan: PLAN_ART, illustration: [broken, broken] });
  const res = await runCommand({ doc, selection: [], utterance: 'нарисуй монстра', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined);
  assert.ok(res.warnings.some((w) => /1 деталь отброшена.*«Левый рожок».*контур не разобран/.test(w)), res.warnings.join('\n'));
  assert.equal(provider.calls.length, 3);
  assert.match(res.changeSummary, /21 деталь/);
});

test('круг 37: внутри выделенного блока картинка вписывается в его ширину, фон холста — без подложки', async () => {
  const { doc, board } = demo();
  const card = Object.values(doc.nodes).find((n) => n.type === 'frame' && n.parent === board);
  const provider = fake({ plan: PLAN_ART, illustration: COOKIE });
  const res = await runCommand({ doc, selection: [card.id], utterance: 'нарисуй печеньку', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const f = Object.values(after.nodes).find((n) => n.role === 'illustration');
  assert.equal(f.parent, card.id);
  assert.ok(f.size.w.value <= 240, 'рамка не шире 240');
  assert.match(provider.calls[1].messages[0].content, /"none"/, 'иллюстратору сказали про фон');
  assertPathsPassCore(after, f.id);
  // серия «Крошка 1…3» — один слой
  const crumbs = f.children.map((id) => after.nodes[id]).find((n) => /^Крошка/.test(n.name));
  assert.equal(crumbs.paths.length, 3);
  assert.equal(crumbs.name, 'Крошка ×3');
});

/* ── 4. «Виджет печеньки» ─────────────────────────────────────────────────── */

const WIDGET_TREE = {
  type: 'frame', name: 'Виджет печеньки', fill: 'surface', radius: 'radii.4',
  layout: { mode: 'column', gap: 'spacing.4', padding: 'spacing.6', align: 'center' },
  size: { w: 300, h: 'hug' },
  children: [
    { type: 'illustration', name: 'Печенька', size: { w: 160, h: 160 }, draw: 'печенька с шоколадной крошкой, вид сверху' },
    { type: 'text', name: 'Заголовок', text: 'Печенька дня', style: 'title' },
    { type: 'text', name: 'Подпись', text: 'Овсяная с тёмным шоколадом', style: 'body', color: 'muted' },
  ],
};

test('круг 37: «виджет печеньки» — карточка раскладкой, внутри свободная рамка с нарисованной печенькой', async () => {
  const { doc, board } = demo();
  // демо-доска фиксированной высоты: новый виджет вылезает за неё, и макет уходит на починку
  // раскладки — второй ответ дерева приходит с тем же местом под картинку, и она НЕ перерисовывается
  const provider = fake({ plan: { intent: 'create', title: 'Виджет печеньки', summary: 'Карточка с печенькой', steps: ['Собрать'] }, tree: [WIDGET_TREE, WIDGET_TREE], illustration: [COOKIE] });
  const res = await runCommand({ doc, selection: [], utterance: 'виджет печеньки', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'tree', 'illustration', 'tree'], 'на починке картинка взята из готового');
  assert.match(provider.calls[2].messages[0].content, /печенька с шоколадной крошкой/);
  assert.match(provider.calls[1].messages[0].content, /КАРТИНКА: в команде просят рисунок/, 'дереву прямо сказано про узел illustration');
  const after = res.preview.doc;
  const widget = byName(after, 'Виджет печеньки');
  assert.equal(widget.layout.mode, 'column', 'виджет — обычная раскладка');
  const art = after.nodes[widget.children[0]];
  assert.equal(art.role, 'illustration');
  assert.equal(art.layout.mode, 'none');
  assert.equal(art.size.w.value, 160);
  assert.ok(isArtFrame(after, art.id, core));
  assertPathsPassCore(after, art.id);
  assert.ok(art.children.every((id) => after.nodes[id].type === 'vector'));
  assert.equal(after.nodes[widget.children[1]].characters, 'Печенька дня');
  assert.match(res.changeSummary, /нарисовал «Печенька»: 10 деталей/);
});

test('круг 37: модель собрала печеньку кругом с точками — место под картинку ставится само, печенька рисуется', async () => {
  const { doc, board } = demo();
  const flat = {
    type: 'frame', name: 'Виджет печеньки', layout: { mode: 'column', gap: 12, padding: 16 }, size: { w: 300, h: 'hug' },
    children: [
      { type: 'ellipse', name: 'Печенька', size: { w: 140, h: 140 }, fill: '#c68642' },
      { type: 'text', name: 'Заголовок', text: 'Печенька дня', style: 'title' },
    ],
  };
  const provider = fake({ plan: { intent: 'create', title: 'Виджет', summary: 'Виджет', steps: ['Собрать'] }, tree: [flat, flat], illustration: [COOKIE] });
  const res = await runCommand({ doc, selection: [], utterance: 'виджет печеньки', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema).slice(0, 3), ['plan', 'tree', 'illustration']);
  assert.equal(provider.calls.filter((c) => c.schema === 'illustration').length, 1, 'печенька рисуется один раз');
  const after = res.preview.doc;
  const widget = byName(after, 'Виджет печеньки');
  const first = after.nodes[widget.children[0]];
  assert.equal(first.role, 'illustration', 'плоский круг заменён рисунком');
  assert.equal(first.size.w.value, 140, 'того же размера');
  assert.ok(!Object.values(after.nodes).some((n) => n.type === 'ellipse' && n.name === 'Печенька'));
  assert.ok(res.serviceNotes.some((n) => /место под иллюстрацию/.test(n)));
});

test('круг 37: в виджете вовсе нет картинки — место встаёт первым, имя даёт иллюстратор', async () => {
  const { doc, board } = demo();
  const bare = {
    type: 'frame', name: 'Виджет печеньки', layout: { mode: 'column', gap: 8, padding: 12 }, size: { w: 260, h: 'hug' },
    children: [{ type: 'text', name: 'Заголовок', text: 'Печенька дня', style: 'title' }],
  };
  const provider = fake({ plan: { intent: 'illustration', title: 'Виджет', summary: 'Виджет', steps: ['Собрать'] }, tree: [bare, bare], illustration: [COOKIE] });
  const res = await runCommand({ doc, selection: [], utterance: 'виджет печеньки', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls[1].schema, 'tree', 'план «illustration» уступил виджету: это интерфейс с картинкой');
  const after = res.preview.doc;
  const widget = byName(after, 'Виджет печеньки');
  const pic = after.nodes[widget.children[0]];
  assert.equal(pic.role, 'illustration');
  assert.equal(pic.name, 'Печенька');
  assert.equal(after.nodes[widget.children[1]].characters, 'Печенька дня');
});

test('круг 37: «добавь в карточку иконку котика» — правка кладёт узел illustration, иллюстратор его рисует', async () => {
  const { doc, board } = demo();
  const card = Object.values(doc.nodes).find((n) => n.name === 'Карточка встречи');
  const guess = classifyUtterance('добавь в карточку встречи иконку котика', { doc });
  assert.equal(guess.intent, 'edit');
  assert.equal(guess.art, true);
  const kitty = { name: 'Котик', canvas: { w: 400, h: 400 }, parts: [
    { name: 'Тень', kind: 'ellipse', x: 110, y: 330, w: 180, h: 26, fill: '#000000', opacity: 0.15 },
    { name: 'Голова', kind: 'path', d: 'M200 110 C270 110 316 160 316 224 C316 292 264 330 200 330 C136 330 84 292 84 224 C84 160 130 110 200 110 Z', fill: '#f59e0b' },
  ] };
  const provider = fake({
    plan: { intent: 'edit', title: 'Котик', summary: 'Котик', steps: ['Добавить'] },
    patch: { edits: [{ op: 'create', target: 'Карточка встречи', parent: 'Карточка встречи', index: 0,
      node: { type: 'illustration', name: 'Котик', size: { w: 48, h: 48 }, draw: 'рыжий котик, иконка' } }] },
    illustration: kitty,
  });
  const res = await runCommand({ doc, selection: [], utterance: 'добавь в карточку встречи иконку котика', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(provider.calls.map((c) => c.schema), ['plan', 'patch', 'illustration']);
  assert.match(provider.calls[1].messages[0].content, /КАРТИНКА: в команде просят рисунок/);
  const after = res.preview.doc;
  const pic = after.nodes[after.nodes[card.id].children[0]];
  assert.equal(pic.role, 'illustration');
  assert.equal(pic.size.w.value, 48);
  assertPathsPassCore(after, pic.id);
  // холст 400 вписан в рамку 48: детали уменьшены, viewBox прежний
  const head = after.nodes[pic.children[1]];
  assert.ok(head.size.w.value < 40 && head.viewBox.w > 200, JSON.stringify({ s: head.size, vb: head.viewBox }));
});

/* ── 5. Правка иллюстраций ────────────────────────────────────────────────── */

test('круг 37: выжимка показывает рисунок деталями — место, цвета, без полных путей; путь — только у выделенной', async () => {
  const { doc, frame } = await withMonster();
  const body = Object.values(doc.nodes).find((n) => n.name === 'Тело' && n.parent === frame.id);
  const plain = describeDoc(doc, [frame.id], { engine: core });
  assert.match(plain, /"Монстрик" free .*\[иллюстрация: 22 детали\] background=#f3f0ff/);
  assert.match(plain, /vector "Тело" .*at=77,88 fill=#8b5cf6 stroke=#2e1065\/5/);
  assert.match(plain, /vector "Левый глаз" .*fill=#ffffff,#1e1b4b .*контуров: 3/);
  assert.doesNotMatch(plain, /d="M/, 'полных путей в выжимке нет');
  const sel = describeDoc(doc, [body.id], { engine: core });
  assert.match(sel, /vector "Тело" .*d="M200 90 C272 90 318 150 320 228/, 'у выделенной детали — её контур в координатах рамки');
  // модель знает, как читать рисунок, — легенда только при векторах в документе
  const prov = fake({ plan: { intent: 'edit', title: 'x', summary: 'x', steps: ['x'] }, patch: { edits: [{ op: 'set', target: 'Тело', path: 'fill', value: '#30a46c' }] } });
  await runCommand({ doc, selection: [], utterance: 'перекрась тело в зелёный', provider: prov, engine: core });
  assert.ok(prov.calls[0].messages[0].content.includes(ART_LEGEND));
  assert.match(prov.calls[1].messages[0].content, /ПРАВКА ИЛЛЮСТРАЦИЙ/);
});

const hsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};

test('круг 37: «сделай монстра зелёным» — перекрашен материал целиком с тенями и бликами; глаза, контур и фон — прежние', async () => {
  const { doc, frame } = await withMonster();
  const provider = fake({
    plan: { intent: 'edit', title: 'Зелёный монстр', summary: 'Перекрашу', steps: ['Перекрасить'] },
    patch: { edits: [{ op: 'set', target: 'Монстрик', path: 'fill', value: 'зелёный' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай монстрика зелёным', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const node = (name) => Object.values(after.nodes).find((n) => n.name === name && n.parent === frame.id);
  const bodyFill = node('Тело').paths[0].fill;
  assert.equal(bodyFill, '#30a46c', 'основа — ровно названный цвет');
  const [h, , l] = hsl(node('Тень на теле').paths[0].fill);
  assert.ok(h > 120 && h < 170, `тень тела зелёная: ${node('Тень на теле').paths[0].fill}`);
  assert.ok(l < hsl(bodyFill)[2], 'тень темнее основы');
  assert.ok(hsl(node('Пузико').paths[0].fill)[2] > hsl(bodyFill)[2], 'блик/пузико светлее основы');
  assert.equal(node('Левый рожок').paths[0].fill, '#fcd34d', 'жёлтые рожки — другой материал');
  const eye = node('Левый глаз').paths;
  assert.deepEqual(eye.map((p) => p.fill), ['#ffffff', '#1e1b4b', '#ffffff'], 'глаза не тронуты');
  assert.equal(node('Тело').paths[0].stroke, '#2e1065', 'контур не тронут');
  assert.equal(after.nodes[frame.id].fill, '#f3f0ff', 'фон рамки не тронут');
  assert.ok(res.ops.every((o) => o.op === 'set' && (o.path === 'paths' || o.path === 'fill')), JSON.stringify(res.ops.map((o) => o.path)));
  assert.match(res.changeSummary, /^Перекрасил «Монстрик»: \d+ детал\S*, #8b5cf6 → #30a46c$/);
  assert.ok(res.warnings.some((w) => /тени и блики подстроены/.test(w)));
  // отмена возвращает как было
  const inv = core.invertOps(doc, res.ops);
  const back = core.applyOps(after, inv);
  assert.equal(core.hashDoc(back.doc), core.hashDoc(doc));
});

test('круг 37: «перекрась тело» — деталь вместе с её тенью и бликом; соседние детали того же цвета — нет', async () => {
  const { doc, frame } = await withMonster();
  const provider = fake({
    plan: { intent: 'edit', title: 'Тело', summary: 'Тело', steps: ['Перекрасить'] },
    patch: { edits: [{ op: 'set', target: 'Тело', path: 'fill', value: '#e5484d' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'перекрась тело в красный', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const node = (name) => Object.values(after.nodes).find((n) => n.name === name && n.parent === frame.id);
  assert.equal(node('Тело').paths[0].fill, '#e5484d');
  const [h] = hsl(node('Тень на теле').paths[0].fill);
  assert.ok(h < 15 || h > 340, `тень тела стала красной: ${node('Тень на теле').paths[0].fill}`);
  assert.notEqual(node('Блик на теле').paths[0].fill, Object.values(doc.nodes).find((n) => n.name === 'Блик на теле').paths[0].fill);
  assert.equal(node('Левая лапка').paths[0].fill, '#8b5cf6', 'о лапках не просили');
  assert.equal(node('Левый рожок').paths[0].fill, '#fcd34d');
  assert.ok(res.warnings.some((w) => /«Тень на теле», «Блик на теле»/.test(w)), res.warnings.join('\n'));
});

test('круг 37: «сделай фон монстра голубым» — фон рамки, а не персонаж', async () => {
  const { doc, frame } = await withMonster();
  const provider = fake({
    plan: { intent: 'edit', title: 'Фон', summary: 'Фон', steps: ['Фон'] },
    patch: { edits: [{ op: 'set', target: 'Монстрик', path: 'background', value: '#dbeafe' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай фон монстрика голубым', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.preview.doc.nodes[frame.id].fill, '#dbeafe');
  const body = Object.values(res.preview.doc.nodes).find((n) => n.name === 'Тело');
  assert.equal(body.paths[0].fill, '#8b5cf6');
});

test('круг 37: «увеличь глаза» — детали растут от своего центра и без искажения', async () => {
  const { doc, frame } = await withMonster();
  const eyeBefore = Object.values(doc.nodes).find((n) => n.name === 'Левый глаз' && n.parent === frame.id);
  const provider = fake({
    plan: { intent: 'edit', title: 'Крупнее глаза', summary: 'Глаза', steps: ['Увеличить'] },
    patch: { edits: [
      { op: 'set', target: 'Левый глаз', path: 'size', value: '130%' },
      { op: 'set', target: 'Правый глаз', path: 'size', value: '130%' },
    ] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'увеличь глаза', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const eye = res.preview.doc.nodes[eyeBefore.id];
  const w0 = eyeBefore.size.w.value, h0 = eyeBefore.size.h.value;
  assert.ok(Math.abs(eye.size.w.value - w0 * 1.3) < 0.02 && Math.abs(eye.size.h.value - h0 * 1.3) < 0.02);
  const c0 = [eyeBefore.pos.x + w0 / 2, eyeBefore.pos.y + h0 / 2];
  const c1 = [eye.pos.x + eye.size.w.value / 2, eye.pos.y + eye.size.h.value / 2];
  assert.ok(Math.abs(c0[0] - c1[0]) < 0.02 && Math.abs(c0[1] - c1[1]) < 0.02, 'центр на месте');
  // размер детали — с половиной обводки (контур 5 px): 58×64 + 5
  assert.match(res.changeSummary, /^Размер «Левый глаз»: 63×69 → 82×90 px; размер «Правый глаз»/);
});

test('круг 37: «добавь рожки» — новая деталь в рисунок по контуру в координатах рамки, на нужный слой', async () => {
  const { doc, frame } = await withMonster();
  const provider = fake({
    plan: { intent: 'edit', title: 'Рожки', summary: 'Рожки', steps: ['Добавить'] },
    patch: { edits: [{ op: 'create', target: 'Монстрик', parent: 'Монстрик', index: 1,
      node: { type: 'vector', name: 'Третий рожок', d: 'M196 96 C190 70 196 50 206 36 C214 56 214 78 208 96 Z', fill: '#fcd34d' } }] },
  });
  const res = await runCommand({ doc, selection: [frame.id], utterance: 'добавь рожки', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const f = after.nodes[frame.id];
  const horn = after.nodes[f.children[1]];
  assert.equal(horn.name, 'Третий рожок');
  assert.equal(horn.type, 'vector');
  // место — по bbox самой кривой (её левый край ≈193.6) с половиной контура (2.5), а не по контрольным точкам
  assert.ok(Math.abs(horn.pos.x - 191.1) < 0.6 && Math.abs(horn.pos.y - 33.5) < 0.6, JSON.stringify(horn.pos));
  assertPathsPassCore(after, frame.id);
  assert.equal(horn.paths[0].stroke, '#2e1065', 'новая деталь — с тем же контуром, что у соседей');
  assert.equal(horn.paths[0].strokeWidth, 5);
  assert.match(res.changeSummary, /^Дорисовал «Третий рожок» в «Монстрик»$/);
});

test('круг 37: новая форма детали (d), поворот и место детали — правками по координатам рамки', async () => {
  const { doc, frame } = await withMonster();
  const hornId = Object.values(doc.nodes).find((n) => n.name === 'Левый рожок' && n.parent === frame.id).id;
  const provider = fake({
    plan: { intent: 'edit', title: 'Рожок', summary: 'Рожок', steps: ['Править'] },
    patch: { edits: [
      { op: 'set', target: 'Левый рожок', path: 'd', value: 'M150 122 C120 80 120 30 140 10 C160 50 176 90 182 114 Z' },
      { op: 'set', target: 'Правый рожок', path: 'rotation', value: '15°' },
      { op: 'set', target: 'Тень', path: 'pos', value: '100,340' },
    ] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай левый рожок длиннее, правый поверни', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const horn = after.nodes[hornId];
  assert.ok(horn.viewBox.h > 100, 'рожок стал длиннее');
  assert.ok(horn.pos.y < 12 && horn.pos.y > 5, `и вырос вверх: ${horn.pos.y}`);
  assert.equal(horn.paths[0].fill, '#fcd34d', 'цвет остался');
  assertPathsPassCore(after, frame.id);
  assert.equal(byName(after, 'Правый рожок').rotate, 15);
  assert.deepEqual(byName(after, 'Тень').pos, { x: 100, y: 340 });
  assert.match(res.changeSummary, /^Новая форма «Левый рожок»; положение «Тень» в «Монстрик»: 100,340/);
});

test('круг 37: масштаб всей иллюстрации — рамка и детали разом', async () => {
  const { doc, frame } = await withMonster();
  const provider = fake({
    plan: { intent: 'edit', title: 'Больше', summary: 'Больше', steps: ['Больше'] },
    patch: { edits: [{ op: 'set', target: 'Монстрик', path: 'size.w', value: '200' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай монстрика меньше, шириной 200', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  assert.equal(after.nodes[frame.id].size.h.value, 200, 'пропорции рамки сохранены');
  const body0 = Object.values(doc.nodes).find((n) => n.name === 'Тело');
  const body1 = after.nodes[body0.id];
  assert.ok(Math.abs(body1.pos.x - body0.pos.x / 2) < 0.02 && Math.abs(body1.size.w.value - body0.size.w.value / 2) < 0.02);
  assert.match(res.changeSummary, /^Рисунок «Монстрик»: 400×400 → 200×200 px$/);
});

/* ── 6. Пути, краски, словари ─────────────────────────────────────────────── */

test('круг 37: разбор пути — относительные команды, S/T/H/V и неявные повторы приводятся к абсолютным', () => {
  const r = parseArtPath('m10 10 h20 v20 l-5 5 10 0 c0 10 10 10 10 0 s10 -10 10 0 q5 10 10 0 t10 0 a5 5 0 0 1 10 0 z');
  assert.ok(r.ok, r.error);
  const d = formatArtPath(r.cmds);
  assert.match(d, /^M10 10 L30 10 L30 30 L25 35 L35 35 C35 45 45 45 45 35 C/);
  assert.doesNotMatch(d, /[hvstHVST]/);
  assert.ok(corePath(d).ok !== false);
  for (const bad of ['', 'L10 10', 'M10', 'M0 0 C1 2 3', 'M0 0 X5 5', 'M0 0 A5 5 0 2 1 10 10', 'M1e9 0 L1 1', 'M0 0']) {
    assert.equal(parseArtPath(bad).ok, false, bad);
  }
});

test('круг 37: краски — палитра с тонами, токен документа, CSS-градиент и градиент-объект', () => {
  const { doc } = demo();
  const palette = new Map([['body', '#8b5cf6']]);
  assert.equal(artPaint('body', { doc, palette }), '#8b5cf6');
  assert.equal(artPaint('body-shade', { doc, palette }), artTone('#8b5cf6', 'shade'));
  assert.equal(artPaint('accent', { doc }), 'accent', 'токен документа — ссылкой');
  assert.equal(artPaint('none', { doc }), null);
  assert.equal(artPaint('rgb(255, 0, 0)', { doc }), '#ff0000');
  assert.deepEqual(artPaint('linear-gradient(to right, #ffd166, #f4a261 80%)', { doc }),
    { gradient: { kind: 'linear', stops: [{ at: 0, color: '#ffd166' }, { at: 0.8, color: '#f4a261' }], angle: 90 } });
  const radial = artPaint({ kind: 'radial', cx: 0.3, cy: '30%', stops: [{ at: 0, color: '#fff' }, { at: 1, color: 'accent' }] }, { doc });
  assert.deepEqual(radial, { gradient: { kind: 'radial', stops: [{ at: 0, color: '#ffffff' }, { at: 1, token: 'accent' }], cx: 0.3, cy: 0.3 } });
  assert.equal(artPaint('непонятно', { doc }), undefined);
  // градиент в детали доходит до ядра и принимается им
  const got = compileIllustration({ canvas: { w: 200, h: 200 }, parts: [{ name: 'Шар', kind: 'ellipse', x: 40, y: 40, w: 120, h: 120, gradient: { kind: 'radial', stops: [{ at: 0, color: '#fde68a' }, { at: 1, color: '#f59e0b' }] } }] }, { engine: core });
  const vec = got.spec.children[0].$vector;
  assert.equal(vec.paths[0].fill.gradient.kind, 'radial');
  const { doc: d2, board } = demo();
  const r = core.applyOps(d2, [{ op: 'create', node: { type: 'vector', id: 'v_ball', name: 'Шар', parent: board, ...vec } }]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
});

test('круг 37: градиент и поворот в обычной правке и в дереве', () => {
  const { doc } = demo();
  const w = [];
  assert.deepEqual(coerceValue('linear-gradient(180deg, #ffd166, #f4a261)', 'fill', doc, (m) => w.push(m)),
    { gradient: { kind: 'linear', stops: [{ at: 0, color: '#ffd166' }, { at: 1, color: '#f4a261' }], angle: 180 } });
  assert.equal(coerceValue('-15°', 'rotate', doc, (m) => w.push(m)), -15);
  assert.equal(coerceValue('400', 'rotate', doc, (m) => w.push(m)), undefined);
  assert.ok(w.some((m) => /от −360 до 360/.test(m)));
  assert.equal(normalizePath('rotation'), 'rotate');
  assert.equal(normalizePath('strokeWidth'), 'stroke.width');
  for (const p of ['rotate', 'paths', 'viewBox', 'd']) {
    assert.ok(ALLOWED_PATH_HEADS.has(p), p);
    assert.ok(!/[A-Za-z]/.test(ruPath(p)) && !/[A-Za-z]/.test(ruPathGen(p)), p);
  }
});

test('круг 37: поворот обычного слоя — правкой rotate, а не отказом', async () => {
  const { doc, board } = demo();
  const target = Object.values(doc.nodes).find((n) => n.type === 'frame' && n.parent === board);
  const provider = fake({
    plan: { intent: 'edit', title: 'Поворот', summary: 'Поворот', steps: ['Повернуть'] },
    patch: { edits: [{ op: 'set', target: `#${target.id}`, path: 'rotate', value: '12' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'поверни блок на 12 градусов', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.preview.doc.nodes[target.id].rotate, 12);
  assert.match(res.changeSummary, /^Поворот «.+»: 0° → 12°$/);
});

test('круг 37: план отказал «рисовать не умею» по старой памяти — рисунок всё равно рисуется', async () => {
  const { doc, board } = demo();
  const provider = fake({
    plan: { intent: 'refuse', title: 'Нельзя', summary: 'Нельзя', steps: ['—'], cannot: 'Рисовать иллюстрации кривыми в этом редакторе нельзя.' },
    illustration: MONSTER,
  });
  const res = await runCommand({ doc, selection: [], utterance: 'нарисуй монстра', provider, engine: core, activeArtboardId: board });
  assert.equal(res.error, undefined);
  assert.equal(res.cannot, undefined);
  assert.ok(Object.values(res.preview.doc.nodes).some((n) => n.role === 'illustration'));
});

test('круг 37: мелочи сливаются — слоёв не больше предела, контуры не теряются', () => {
  const parts = [];
  for (let i = 0; i < 70; i++) parts.push({ name: `Звезда ${i % 2 ? 'a' : 'b'}${i}`, kind: 'ellipse', x: (i * 5) % 380, y: (i * 7) % 380, w: 6, h: 6, fill: '#fde68a' });
  const got = compileIllustration({ canvas: { w: 400, h: 400 }, parts }, { engine: core });
  assert.equal(got.parts, 70);
  assert.ok(got.layers <= ART_LIMITS.layers, `слоёв ${got.layers}`);
  assert.equal(got.spec.children.reduce((n, c) => n + c.$vector.paths.length, 0), 70);
});

test('круг 37: починка по деталям — mergeIllustration ставит исправленное на место, полный ответ заменяет целиком', () => {
  const prev = { name: 'A', canvas: { w: 100, h: 100 }, parts: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  assert.deepEqual(mergeIllustration(prev, { parts: [{ name: 'b', d: 'M0 0 L1 1 Z' }] }).parts.map((p) => p.d || p.name), ['a', 'M0 0 L1 1 Z', 'c']);
  const full = { name: 'B', canvas: { w: 100, h: 100 }, parts: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] };
  assert.equal(mergeIllustration(prev, full), full);
  const foreign = { parts: [{ name: 'q' }] };
  assert.equal(mergeIllustration(prev, foreign), foreign, 'незнакомое имя — это новый рисунок');
});

test('круг 37: describeChange рисунка — словами: нарисовал, сколько деталей', () => {
  const { doc, board } = demo();
  const got = compileIllustration(COOKIE, { engine: core });
  const frameNode = { type: 'frame', id: 'f_art', name: 'Печенька', parent: board, layout: got.spec.layout, size: got.spec.size, radius: 0, clip: true, role: 'illustration', children: [] };
  const ops = [{ op: 'create', node: frameNode }];
  got.spec.children.forEach((c, i) => ops.push({ op: 'create', node: { type: 'vector', id: `v_${i}`, name: c.name, parent: 'f_art', ...c.$vector } }));
  assert.equal(describeChange(ops, doc), `Нарисовал «Печенька» в «${doc.nodes[board].name}»: 10 деталей`);
});
