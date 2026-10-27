/**
 * Тесты «мозга». Движок core.js может быть ещё не готов, поэтому все тесты
 * передают в runCommand/runVariants заглушку движка через опцию engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeProvider, runCommand, runVariants, SCHEMAS, PROMPTS, PERSONAS,
  classifyUtterance, describeDoc, describeTokens, extractJson, parseModelJson,
  downgradeSchema, normalizeTree, resolveScope, coerceValue, BrainError, DIGEST_LIMIT,
  // круг 3
  recognizeAction, looksGroupWide, findInsertTarget, adjustSetPath, describeViolations,
  refCandidates, textDescendants, fmtDuration, clampPx, safeSrc, ALLOWED_PATH_HEADS,
  // круг 5
  recognizeVariants, looksUniformColumn, sortWarnings, warningRank, MAX_CHARS,
  // круг 7
  variantInstruction, mentionsExistingLayer,
  // круг 9 / круг 11
  parsePx, DIGEST_LEGEND, recognizeUndoDoubt,
  // круг 13: «снять свойство» отдельным значением
  UNSET,
  // круг 16: человеческие названия полей и токенов, служебная запись без совета
  ruPath, ruPathGen, ruToken, ruEnum, factOnly,
  // круг 19: библиотека как словарь агента
  describeLibrary, recognizeComponentIntent,
  // круг 24: внешняя библиотека (DUIL)
  libraryDocOf,
  // круг 16, п.1: сравнение форм значения — сверяется с настоящим core.applyOps
  sameAsNow,
} from '../src/brain.js';

/* ── заглушка движка ─────────────────────────────────────────────────────── */

const clone = (v) => JSON.parse(JSON.stringify(v));

function makeStubEngine({ violations = () => [] } = {}) {
  const setPath = (obj, path, value) => {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    if (value === undefined) delete cur[parts[parts.length - 1]];
    else cur[parts[parts.length - 1]] = value;
  };

  const engine = {
    createDoc: (seed) => clone(seed || { id: 'd', version: 0, root: 'p', nodes: {}, tokens: {}, meta: {} }),

    ops: {
      create: (o) => ({ op: 'create', ...o }),
      remove: (o) => ({ op: 'remove', ...o }),
      set: (o) => ({ op: 'set', ...o }),
      move: (o) => ({ op: 'move', ...o }),
      setToken: (o) => ({ op: 'setToken', ...o }),
    },

    applyOps(doc, ops) {
      const d = clone(doc);
      for (const op of ops) {
        if (op.op === 'create') {
          const node = clone(op.node);
          if (d.nodes[node.id]) return { doc, error: `дубликат id ${node.id}` };
          const parent = d.nodes[node.parent];
          if (!parent) return { doc, error: `нет родителя ${node.parent}` };
          if (node.type === 'frame') node.children = [];
          d.nodes[node.id] = node;
          parent.children = parent.children || [];
          const at = op.index == null ? parent.children.length : Math.max(0, Math.min(op.index, parent.children.length));
          parent.children.splice(at, 0, node.id);
        } else if (op.op === 'remove') {
          const node = d.nodes[op.id];
          if (!node) return { doc, error: `нет узла ${op.id}` };
          const kill = (id) => { for (const k of d.nodes[id].children || []) kill(k); delete d.nodes[id]; };
          const parent = d.nodes[node.parent];
          if (parent) parent.children = (parent.children || []).filter((x) => x !== op.id);
          kill(op.id);
        } else if (op.op === 'set') {
          const node = d.nodes[op.id];
          if (!node) return { doc, error: `нет узла ${op.id}` };
          if (['id', 'type', 'parent', 'children'].includes(op.path.split('.')[0])) {
            return { doc, error: `путь ${op.path} защищён` };
          }
          setPath(node, op.path, op.value);
        } else if (op.op === 'move') {
          const node = d.nodes[op.id];
          const next = d.nodes[op.parent];
          if (!node || !next) return { doc, error: 'move: нет узла или родителя' };
          const prev = d.nodes[node.parent];
          if (prev) prev.children = (prev.children || []).filter((x) => x !== op.id);
          next.children = next.children || [];
          next.children.splice(Math.max(0, Math.min(op.index, next.children.length)), 0, op.id);
          node.parent = op.parent;
        } else if (op.op === 'setToken') {
          setPath(d.tokens, op.path, op.value);
        } else {
          return { doc, error: `неизвестная операция ${op.op}` };
        }
      }
      d.version = (d.version || 0) + 1;
      return { doc: d };
    },

    invertOps: (doc, ops) => ops.map((o) => ({ op: 'noop', of: o.op })),
    solve: (doc) => ({
      rects: Object.fromEntries(Object.keys(doc.nodes).map((id, i) => [id, { x: 0, y: i * 20, w: 100, h: 20 }])),
      lines: {}, order: Object.keys(doc.nodes),
    }),
    validate: (doc, geo) => violations(doc, geo),
    resolveTarget(doc, ref) {
      const raw = String(ref || '').replace(/^#/, '');
      if (doc.nodes[raw]) return raw;
      return Object.keys(doc.nodes).find((id) => doc.nodes[id].name === raw) || null;
    },
    isArtboard: (doc, id) => !!doc.nodes[id] && doc.nodes[id].parent === doc.root,
    cloneSubtree(doc, id) {
      const out = [];
      let seq = 0;
      const walk = (nid, parent) => {
        const src = doc.nodes[nid];
        if (!src) return null;
        const copy = clone(src);
        copy.id = `${nid}_copy${seq++ || ''}`;
        if (parent) copy.parent = parent;
        out.push(copy);
        copy.children = (src.children || []).map((k) => walk(k, copy.id)).filter(Boolean);
        return copy.id;
      };
      const rootId = walk(id, doc.nodes[id] && doc.nodes[id].parent);
      return { rootId, nodes: out };
    },
  };
  return engine;
}

function makeDoc() {
  const frameLayout = (over = {}) => ({
    mode: 'column', gap: 16, padding: { t: 24, r: 24, b: 24, l: 24 },
    align: 'stretch', justify: 'start', wrap: false, ...over,
  });
  return {
    id: 'doc1', version: 3, root: 'page1',
    nodes: {
      page1: { type: 'page', id: 'page1', name: 'Страница', parent: null, children: ['ab1'] },
      ab1: {
        type: 'frame', id: 'ab1', name: 'Экран заказа', parent: 'page1', children: ['t1', 'btn'],
        layout: frameLayout(), size: { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } },
        fill: 'bg', radius: 0, pos: { x: 0, y: 0 },
      },
      t1: {
        type: 'text', id: 't1', name: 'Заголовок', parent: 'ab1', characters: 'Ваш заказ готов',
        style: 'h2', align: 'start', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
      },
      btn: {
        type: 'frame', id: 'btn', name: 'Кнопка оформить', parent: 'ab1', children: [],
        layout: frameLayout({ mode: 'row', gap: 8, padding: { t: 12, r: 24, b: 12, l: 24 }, align: 'center', justify: 'center' }),
        size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'accent', radius: 8,
      },
    },
    tokens: {
      colors: { bg: '#ffffff', text: '#111111', muted: '#888888', accent: '#ff6b3d' },
      type: { h1: { fontSize: 32, fontWeight: 700, lineHeight: 1.2 }, h2: { fontSize: 24, fontWeight: 600, lineHeight: 1.3 }, body: { fontSize: 16, fontWeight: 400, lineHeight: 1.5 } },
      spacing: [4, 8, 12, 16, 24, 32, 48],
      radii: [0, 4, 8, 16],
    },
    meta: { name: 'Тест', createdAt: 0 },
  };
}

/** Провайдер с заранее записанными ответами: ключ — имя схемы. */
function makeFakeProvider(script) {
  const calls = [];
  return {
    name: 'fake', kind: 'fake', calls,
    async ready() { return true; },
    async complete(messages, schema, opts = {}) {
      const name = schema && schema.name;
      calls.push({ schema: name, messages, opts });
      if (opts.signal && opts.signal.aborted) throw new BrainError('cancelled', 'Команда отменена');
      let value = script[name];
      if (Array.isArray(value)) value = script[name].shift();
      if (value === undefined) throw new BrainError('model', `нет записанного ответа для схемы ${name}`);
      if (typeof value === 'function') value = await value({ messages, opts, calls });
      if (value instanceof Error) throw value;
      if (opts.onText) opts.onText(JSON.stringify(value), JSON.stringify(value));
      return value;
    },
  };
}

const PLAN_CREATE = { intent: 'create', title: 'Собрал экран тарифов', summary: 'Новый артборд с тремя тарифами.', steps: ['Каркас', 'Карточки'], targets: [] };
const PLAN_EDIT = { intent: 'edit', title: 'Укрупнил заголовок', summary: 'Ставлю стиль h1.', steps: ['Найти заголовок', 'Поставить h1'], targets: ['Заголовок'] };

const TREE_OK = {
  type: 'frame', name: 'Экран тарифов',
  layout: { mode: 'column', gap: 16, padding: [24, 20], align: 'stretch', justify: 'start' },
  size: { w: 390, h: 'hug' }, fill: 'bg',
  children: [
    { type: 'text', name: 'Заголовок', text: 'Выберите тариф', style: 'h1', size: { w: 'fill', h: 'hug' } },
    {
      type: 'frame', name: 'Карточка «Базовый»', layout: { mode: 'column', gap: 8 }, fill: 'bg', radius: 8,
      children: [
        { type: 'text', name: 'Название', text: 'Базовый', style: 'h2' },
        { type: 'text', name: 'Цена', text: '490 ₽ в месяц', style: 'body', color: 'muted' },
      ],
    },
  ],
};

/* ── 1. Классификация ────────────────────────────────────────────────────── */

test('классификация: создание, правка, оформление, вопрос', () => {
  assert.equal(classifyUtterance('Собери экран оформления заказа').intent, 'create');
  assert.equal(classifyUtterance('создай карточку товара', { hasSelection: true }).intent, 'create');
  assert.equal(classifyUtterance('сделай заголовок крупнее', { hasSelection: true }).intent, 'edit');
  assert.equal(classifyUtterance('замени кнопку на две', { hasSelection: true }).intent, 'edit');
  assert.equal(classifyUtterance('сделай тёмную тему').intent, 'theme');
  assert.equal(classifyUtterance('поменяй палитру на холодную').intent, 'theme');
  assert.equal(classifyUtterance('сколько карточек в этом экране?').intent, 'ask');
  assert.equal(classifyUtterance('что тут не так с отступами').intent, 'ask');
});

test('классификация: выделение решает спор при отсутствии глаголов', () => {
  assert.equal(classifyUtterance('покрупнее', { hasSelection: true }).intent, 'edit');
  assert.equal(classifyUtterance('тарифы', { hasSelection: false }).intent, 'create');
});

/* ── 2. Материализация дерева в операции ─────────────────────────────────── */

test('создание: дерево превращается в операции create новым артбордом', async () => {
  const doc = makeDoc();
  const before = JSON.stringify(doc);
  const engine = makeStubEngine();
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: TREE_OK });
  const seen = [];

  const res = await runCommand({
    doc, selection: [], utterance: 'собери экран тарифов', provider, engine,
    onStage: (s) => seen.push(s.stage),
  });

  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 5, 'корень + заголовок + карточка + 2 текста');
  assert.ok(res.ops.every((o) => o.op === 'create'));

  const root = res.ops[0].node;
  assert.equal(root.type, 'frame');
  assert.equal(root.parent, doc.root, 'новый артборд лежит в корне');
  assert.deepEqual(root.size.w, { mode: 'fixed', value: 390 });
  assert.deepEqual(root.size.h, { mode: 'hug' });
  // круг 20 (SPEC §6.6): 24 — шаг шкалы [4,8,12,16,24,…] → ссылка; 20 — ровно между 16 и 24, остаётся числом
  assert.deepEqual(root.layout.padding, { t: 'spacing.4', r: 20, b: 'spacing.4', l: 20 }, 'padding [v,h] развёрнут, вертикаль на шкале');
  assert.ok(res.warnings.some((w) => /20 — мимо шкалы отступов/.test(w)), 'про 20 мимо шкалы сказано: ' + res.warnings.join(' | '));
  assert.ok(root.pos && root.pos.x > 0, 'артборд встал правее существующих');
  assert.deepEqual(root.children, [], 'дети приходят своими операциями');

  const ids = res.ops.map((o) => o.node.id);
  assert.equal(new Set(ids).size, ids.length, 'id уникальны');
  assert.ok(ids.every((id) => !doc.nodes[id]), 'нет коллизий с существующими id');

  const title = res.ops[1].node;
  assert.equal(title.type, 'text');
  assert.equal(title.characters, 'Выберите тариф');
  assert.equal(title.style, 'h1');
  assert.equal(title.parent, root.id);

  assert.ok(res.preview && res.preview.doc && res.preview.geo, 'есть превью с геометрией');
  assert.equal(res.preview.doc.nodes[root.id].parent, doc.root);
  assert.deepEqual(res.preview.doc.nodes[root.id].children, [title.id, res.ops[2].node.id]);
  assert.equal(JSON.stringify(doc), before, 'входной документ не мутирован');
  const order = seen.filter((s, i) => s !== seen[i - 1]);   // partial-обновления идут той же стадией
  // круг 47 (SPEC §14): арт-направление до раскладки и критик после неё — свои стадии
  assert.deepEqual(order, ['classify', 'plan', 'direct', 'generate', 'materialize', 'critic', 'validate', 'done']);
  assert.equal(res.plan.title, PLAN_CREATE.title);
  assert.ok(res.usage.calls >= 2);
});

test('создание: при выделенном фрейме дерево вкладывается внутрь него', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_CREATE,
    tree: { type: 'text', name: 'Сноска', text: 'Цена указана за месяц', style: 'body' },
  });
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'добавь подпись', provider, engine });
  assert.equal(res.error, undefined);
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].node.parent, 'btn');
  assert.equal(res.ops[0].node.characters, 'Цена указана за месяц');
});

/* ── 3. Патч по имени цели ───────────────────────────────────────────────── */

test('правка: patch по имени цели превращается в set с разрешённым id', async () => {
  const doc = makeDoc();
  const before = JSON.stringify(doc);
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT,
    patch: {
      summary: 'крупнее',
      edits: [
        { op: 'set', target: 'Заголовок', path: 'style', value: 'h1' },
        { op: 'set', target: 'selection', path: 'layout.gap', value: '24' },
        { op: 'set', target: 'Кнопка оформить', path: 'size.w', value: 'hug' },
        { op: 'set', target: 'Заголовок', path: 'type', value: 'frame' },
        { op: 'set', target: 'Несуществующий слой', path: 'fill', value: 'accent' },
      ],
    },
  });

  const res = await runCommand({ doc, selection: ['ab1'], utterance: 'сделай заголовок крупнее', provider, engine });

  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 3, 'защищённый путь и ненайденная цель отброшены');
  assert.deepEqual(res.ops[0], { op: 'set', id: 't1', path: 'style', value: 'h1' });
  // круг 20 (SPEC §6.6): число, равное шагу шкалы отступов, становится ссылкой на этот шаг
  assert.deepEqual(res.ops[1], { op: 'set', id: 'ab1', path: 'layout.gap', value: 'spacing.4' }, 'строка «24» стала ссылкой на шаг 24');
  assert.deepEqual(res.ops[2], { op: 'set', id: 'btn', path: 'size.w', value: { mode: 'hug' } });
  // круг 16, п.9: поле названо человеческим словом, а «type» — слово МОДЕЛИ, его и показываем
  assert.ok(res.warnings.some((w) => /Служебное поле «type» менять нельзя/.test(w)), 'предупреждение про служебное поле: ' + res.warnings.join(' | '));
  assert.ok(res.warnings.some((w) => /не найден/i.test(w)), 'предупреждение про ненайденную цель');
  assert.equal(res.preview.doc.nodes.t1.style, 'h1');
  assert.equal(JSON.stringify(doc), before, 'входной документ не мутирован');
});

test('правка: remove и move по имени', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { ...PLAN_EDIT, title: 'Убрал кнопку' },
    patch: { edits: [{ op: 'move', target: 'Кнопка оформить', parent: 'Экран заказа', index: 0 }, { op: 'remove', target: '#t1' }] },
  });
  const res = await runCommand({ doc, selection: ['ab1'], utterance: 'убери заголовок', provider, engine });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.ops[0], { op: 'move', id: 'btn', parent: 'ab1', index: 0 });
  assert.deepEqual(res.ops[1], { op: 'remove', id: 't1' });
  assert.equal(res.preview.doc.nodes.t1, undefined);
});

/* ── 4. Отбрасывание невалидных узлов ────────────────────────────────────── */

test('невалидные узлы отбрасываются, валидные соседи остаются', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_CREATE,
    tree: {
      type: 'frame', name: 'Экран', size: { w: 390, h: 'hug' },
      children: [
        { type: 'blob', name: 'Неведомое' },
        { type: 'text', name: 'Живой', text: 'Осталось 3 места', style: 'h2' },
        null,
        { type: 'text', name: 'Без текста' },
        { type: 'text', text: 'Lorem ipsum dolor sit amet', style: 'нет-такого-токена' },
        { type: 'rect', name: 'Полоса', fill: 'нетакогоцвета' },
      ],
    },
  });

  const res = await runCommand({ doc, selection: [], utterance: 'собери экран', provider, engine });

  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const created = res.ops.map((o) => o.node);
  const names = created.map((n) => n.name);
  assert.ok(names.includes('Живой'));
  assert.ok(names.includes('Полоса'));
  assert.ok(!names.includes('Неведомое'), 'узел с неизвестным типом отброшен');
  assert.equal(created.filter((n) => n.type === 'text').length, 3, 'текст без содержимого подставил имя, Lorem остался, но с предупреждением');
  assert.ok(res.warnings.some((w) => /неизвестен|отброшен/i.test(w)));
  assert.ok(res.warnings.some((w) => /Lorem/i.test(w)));
  assert.ok(res.warnings.some((w) => /неизвестный цвет/i.test(w)));
  // круг 16, п.9: «нет стиля «h9» — поставил «текст»», без внутренних имён токенов
  assert.ok(res.warnings.some((w) => /стиля «[^»]+» в документе нет/i.test(w)), res.warnings.join(' | '));
  assert.equal(created.find((n) => n.name === 'Полоса').fill, undefined, 'неизвестный цвет не попал в узел');
});

test('normalizeTree: ограничения глубины и числа детей', () => {
  const doc = makeDoc();
  const warnings = [];
  const warn = (m) => warnings.push(m);
  let deep = { type: 'text', name: 'Дно', text: 'дно', style: 'body' };
  for (let i = 0; i < 8; i++) deep = { type: 'frame', name: `Уровень ${8 - i}`, children: [deep] };
  const spec = normalizeTree(deep, { doc, warn });
  let depth = 0, cur = spec;
  while (cur && cur.children && cur.children.length) { depth++; cur = cur.children[0]; }
  assert.ok(depth < 8, 'дерево обрезано по глубине');
  assert.ok(warnings.some((w) => /Глубина/i.test(w)));

  const wide = { type: 'frame', name: 'Список', children: Array.from({ length: 40 }, (_, i) => ({ type: 'text', text: `Пункт ${i + 1}`, style: 'body' })) };
  const wideSpec = normalizeTree(wide, { doc, warn: (m) => warnings.push(m) });
  assert.equal(wideSpec.children.length, 24);
  assert.ok(warnings.some((w) => /оставлено 24/i.test(w)));
});

/* ── 5. Оформление и вопрос ──────────────────────────────────────────────── */

test('оформление: изменения токенов превращаются в setToken', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Сделал тёмную тему', summary: 'Инвертировал палитру.', steps: ['Фон', 'Текст'] },
    theme: {
      summary: 'тёмная',
      colors: [{ name: 'bg', value: '#0D0E12' }, { name: 'text', value: '#E8EAF0' }, { name: 'плохой', value: 'чёрный' }],
      type: [{ name: 'h1', fontSize: 34 }],
      spacing: [8, 4, 16],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай тёмную тему', provider, engine });

  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops[0], { op: 'setToken', path: 'colors.bg', value: '#0d0e12' });
  assert.equal(res.ops.filter((o) => o.path === 'colors.плохой').length, 0, 'не-#rrggbb отброшен');
  assert.ok(res.ops.some((o) => o.path === 'type.h1' && o.value.fontSize === 34 && o.value.fontWeight === 700), 'токен типографики слит с прежним');
  assert.ok(res.ops.some((o) => o.path === 'spacing' && o.value[0] === 4), 'шкала отсортирована');
  assert.equal(res.preview.doc.tokens.colors.bg, '#0d0e12');
});

test('вопрос: текстовый ответ без операций', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'ask', title: 'Ответил про структуру', summary: 'Вопрос о макете.', steps: ['Посмотреть'] },
    answer: { answer: 'В экране два слоя: заголовок и кнопка.' },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сколько слоёв в экране?', provider, engine });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.ops, []);
  assert.match(res.answer, /два слоя/);
  assert.ok(res.preview.geo, 'превью показывает текущий документ');
});

/* ── 6. Починка ──────────────────────────────────────────────────────────── */

test('одна попытка починки по нарушениям валидатора', async () => {
  const doc = makeDoc();
  // нарушение появляется только у непочиненного дерева
  const engine = makeStubEngine({
    violations: (d) => Object.values(d.nodes)
      .filter((n) => n.name === 'Экран тарифов')
      .map((n) => ({ code: 'overflow', nodeId: n.id, message: 'текст вылез за границы фрейма', severity: 'error' })),
  });
  const provider = makeFakeProvider({
    plan: PLAN_CREATE,
    tree: [TREE_OK, { ...TREE_OK, name: 'Экран тарифов (чинёный)' }],
  });
  const seen = [];
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine, onStage: (s) => seen.push(s.stage) });

  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(seen.includes('repair'), 'была стадия починки');
  assert.equal(provider.calls.filter((c) => c.schema === 'tree').length, 2, 'ровно одна попытка починки');
  assert.equal(res.ops[0].node.name, 'Экран тарифов (чинёный)');
  const repairTurn = provider.calls.filter((c) => c.schema === 'tree')[1].messages.at(-1).content;
  assert.match(repairTurn, /вылез за границы/, 'нарушения ушли в сообщение модели');
  /* Круг 15, п.5: «первый ответ пришлось чинить» — служебная бухгалтерия, и её место теперь
   * не в ленте предупреждений человека, а в отдельном поле serviceNotes. */
  assert.ok((res.serviceNotes || []).some((w) => /чинить/i.test(w)), JSON.stringify(res.serviceNotes));
  assert.ok(!res.warnings.some((w) => /чинить/i.test(w)), res.warnings.join(' | '));
});

test('нарушения после починки не теряются: операции возвращаются с предупреждениями', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine({
    violations: (d) => Object.values(d.nodes)
      .filter((n) => /Карточка/.test(n.name || ''))
      .map((n) => ({ code: 'overlap', nodeId: n.id, message: 'перекрытие соседей', severity: 'error' })),
  });
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: [TREE_OK, TREE_OK] });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine });
  assert.equal(res.error, undefined);
  assert.ok(res.ops.length > 0, 'результат не выброшен');
  assert.ok(res.warnings.some((w) => /перекрытие соседей/.test(w)));
});

test('нарушения, бывшие в документе до команды, агенту не вменяются', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine({
    violations: (d) => (d.nodes.t1 ? [{ code: 'off-scale', nodeId: 't1', message: 'отступ вне шкалы', severity: 'error' }] : []),
  });
  const seen = [];
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: TREE_OK });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine, onStage: (s) => seen.push(s.stage) });
  assert.equal(res.error, undefined);
  assert.ok(!seen.includes('repair'), 'старое нарушение не запускает починку');
  assert.ok(!res.warnings.some((w) => /отступ вне шкалы/.test(w)));
});

test('замечание уровня warn не запускает починку, но попадает в warnings', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine({
    violations: (d) => Object.values(d.nodes)
      .filter((n) => n.name === 'Экран тарифов')
      .map((n) => ({ code: 'off-scale', nodeId: n.id, message: 'отступ 20 вне шкалы', severity: 'warn' })),
  });
  const seen = [];
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: TREE_OK });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine, onStage: (s) => seen.push(s.stage) });
  assert.equal(res.error, undefined);
  assert.ok(!seen.includes('repair'));
  assert.ok(res.ops.length > 0);
  assert.ok(res.warnings.some((w) => /отступ 20 вне шкалы/.test(w)));
});

/* ── 7. Путь ошибки и отмена ─────────────────────────────────────────────── */

test('сетевая ошибка модели становится понятным результатом', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({ plan: new BrainError('network', 'Нет связи с моделью (http://localhost:1234/v1)') });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine });

  assert.deepEqual(res.ops, []);
  assert.equal(res.error.kind, 'network');
  assert.match(res.error.message, /Нет связи/);
  assert.ok(res.preview && res.preview.doc === doc, 'превью — текущий документ');
  assert.equal(res.stages.at(-1).stage, 'error');
});

test('ошибка sample-способности превращается в kind model с человеческим текстом', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = {
    name: 'claude-like', kind: 'claude', async ready() { return true; },
    async complete() { throw { code: 'not_granted', message: 'sampling not granted' }; },
  };
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран', provider, engine });
  assert.equal(res.error.kind, 'model');
  assert.match(res.error.message, /не разрешили/i);
});

test('нечитаемый ответ модели даёт kind schema', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: [{ nonsense: true }, { nonsense: true }] });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine });
  assert.deepEqual(res.ops, []);
  assert.equal(res.error.kind, 'schema');
});

test('отмена по signal до запуска', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const ctl = new AbortController();
  ctl.abort();
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: TREE_OK });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран', provider, engine, signal: ctl.signal });
  assert.equal(res.error.kind, 'cancelled');
  assert.deepEqual(res.ops, []);
  assert.equal(provider.calls.length, 0, 'модель не вызывалась');
});

test('отмена по signal посреди конвейера', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const ctl = new AbortController();
  const provider = makeFakeProvider({
    plan: () => { ctl.abort(); return PLAN_CREATE; },
    tree: TREE_OK,
  });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine, signal: ctl.signal });
  assert.equal(res.error.kind, 'cancelled');
  assert.deepEqual(res.ops, []);
  assert.equal(provider.calls.filter((c) => c.schema === 'tree').length, 0, 'генерация не запускалась');
});

/* ── 8. Варианты ─────────────────────────────────────────────────────────── */

test('варианты: n генераций с разными характерами и своими превью', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_CREATE,
    tree: ({ messages }) => {
      const sys = messages[0].content;
      const persona = PERSONAS.find((p) => sys.includes(p.hint));
      return { ...TREE_OK, name: `Экран тарифов — ${persona ? persona.label : '?'}` };
    },
  });

  const variants = await runVariants({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine, n: 3 });

  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((v) => v.label), ['Строгий', 'Просторный', 'Плотный']);
  for (const v of variants) {
    assert.equal(v.error, undefined, JSON.stringify(v.error));
    assert.ok(v.ops.length >= 5);
    assert.ok(v.preview.doc && v.preview.geo);
    assert.match(v.ops[0].node.name, new RegExp(v.label));
    assert.ok(v.description);
  }
  const gaps = variants.map((v) => v.ops.find((o) => o.node.name === 'Карточка «Базовый»').node.layout.padding.t);
  assert.notEqual(gaps[0], gaps[1], 'характеры дают разные умолчания отступов');
  // круг 13, п.8: план общий для всех вариантов — один вызов вместо трёх, различие даёт персона
  assert.equal(provider.calls.filter((c) => c.schema === 'plan').length, 1, 'план считается один раз');
  assert.equal(JSON.stringify(doc), JSON.stringify(makeDoc()), 'документ не мутирован');
});

/* ── 9. Схемы ────────────────────────────────────────────────────────────── */

test('схемы пригодны для strict json_schema: без $ref и рекурсии, глубина 6', () => {
  for (const key of ['plan', 'tree', 'patch', 'theme', 'answer']) {
    const entry = SCHEMAS[key];
    assert.equal(entry.name, key);
    assert.ok(entry.hint, `${key}: есть текстовая форма для sample.json`);
    const text = JSON.stringify(entry.schema);
    assert.ok(!text.includes('$ref'), `${key}: без $ref`);
    assert.ok(!text.includes('"additionalProperties"'), `${key}: без additionalProperties`);
  }
  let depth = 0, node = SCHEMAS.tree.schema;
  while (node.properties && node.properties.children) { depth++; node = node.properties.children.items; }
  assert.equal(depth, 5, 'дерево развёрнуто до 6 уровней узлов');
  assert.equal(SCHEMAS.tree.schema.properties.children.maxItems, 24);
  const sizeUnion = SCHEMAS.tree.schema.properties.size.properties.w.anyOf;
  assert.equal(sizeUnion.length, 2);
  assert.ok(sizeUnion.every((b) => !b.anyOf && !b.oneOf), 'объединения только на одном уровне');
});

test('downgradeSchema разворачивает $ref и схлопывает вложенные объединения', () => {
  const src = {
    $defs: { node: { type: 'object', properties: { kid: { $ref: '#/$defs/node' } }, additionalProperties: false, description: 'рекурсия' } },
    type: 'object',
    properties: {
      root: { $ref: '#/$defs/node' },
      weird: { oneOf: [{ type: 'string' }, { anyOf: [{ type: 'number' }, { type: 'boolean' }] }] },
    },
  };
  const out = downgradeSchema(src, { maxDepth: 3 });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('$ref'));
  assert.ok(!text.includes('$defs'));
  assert.ok(!text.includes('additionalProperties'));
  assert.ok(!text.includes('description'));
  assert.equal(out.properties.weird.anyOf.length, 3, 'вложенное объединение поднято на первый уровень');
  let n = out.properties.root, d = 0;
  while (n && n.properties && n.properties.kid) { d++; n = n.properties.kid; }
  assert.ok(d <= 3, 'рекурсия ограничена глубиной');
});

/* ── 10. Разбор ответа ───────────────────────────────────────────────────── */

test('extractJson: рассуждения, ограждения, обрыв генерации', () => {
  assert.equal(extractJson('<think>подумаю</think>\n{"a":1}'), '{"a":1}');
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('Вот ответ: {"a":{"b":[1,2]}} — готово'), '{"a":{"b":[1,2]}}');
  assert.equal(extractJson('<think>не закрыл рассуждение {"a":1}'), null);
  assert.deepEqual(parseModelJson('{"a":"фигурная } в строке"}'), { a: 'фигурная } в строке' });
  assert.deepEqual(parseModelJson('{"a":1,"b":{"c":2}'), { a: 1, b: { c: 2 } }, 'оборванная генерация дозакрывается');
  assert.throws(() => parseModelJson('совсем не json'), /нет JSON/);
});

test('coerceValue: строки модели приводятся к типам узла', () => {
  const doc = makeDoc();
  assert.deepEqual(coerceValue('fill', 'size.w', doc), { mode: 'fill' });
  assert.deepEqual(coerceValue('320', 'size.h', doc), { mode: 'fixed', value: 320 });
  // круг 20 (SPEC §6.6): числа, равные шагам шкалы [4,8,12,16,24,…], становятся ссылками на шаги
  assert.deepEqual(coerceValue('[12,24]', 'layout.padding', doc), { t: 'spacing.2', r: 'spacing.4', b: 'spacing.2', l: 'spacing.4' });
  assert.equal(coerceValue('true', 'layout.wrap', doc), true);
  assert.equal(coerceValue('#FFF', 'fill', doc), '#ffffff');
  assert.equal(coerceValue('accent', 'fill', doc), 'accent');
  assert.equal(coerceValue('Купить за 1 490 ₽', 'characters', doc), 'Купить за 1 490 ₽');
  assert.equal(coerceValue('12', 'layout.gap', doc), 'spacing.2');
  // ссылка от модели идёт как есть; в документе без шкалы число остаётся числом
  assert.equal(coerceValue('spacing.3', 'layout.gap', doc), 'spacing.3');
  const bare = { ...doc, tokens: { ...doc.tokens, spacing: [] } };
  assert.equal(coerceValue('12', 'layout.gap', bare), 12);
  assert.deepEqual(coerceValue('[12,24]', 'layout.padding', bare), { t: 12, r: 24, b: 12, l: 24 });
});

/* ── 11. Провайдеры ──────────────────────────────────────────────────────── */

test('провайдер lmstudio: strict json_schema, вырезание <think>, учёт usage', async () => {
  const seen = [];
  const provider = makeProvider({
    kind: 'lmstudio', model: 'qwen', retryDelay: 0,
    fetch: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true, status: 200,
        async json() {
          return {
            choices: [{ message: { content: '<think>надо ответить</think>\n```json\n{"answer":"готово"}\n```' } }],
            usage: { prompt_tokens: 120, completion_tokens: 9 },
          };
        },
      };
    },
  });

  const usage = [];
  const data = await provider.complete(
    [{ role: 'system', content: 'системная часть' }, { role: 'user', content: 'вопрос' }],
    SCHEMAS.answer,
    { onUsage: (u) => usage.push(u) },
  );

  assert.deepEqual(data, { answer: 'готово' });
  assert.equal(provider.kind, 'lmstudio');
  assert.match(seen[0].url, /\/chat\/completions$/);
  assert.equal(seen[0].body.model, 'qwen');
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.equal(seen[0].body.response_format.json_schema.name, 'answer');
  assert.equal(seen[0].body.response_format.json_schema.strict, true);
  assert.equal(seen[0].body.stream, false);
  assert.ok(seen[0].body.messages.some((m) => m.role === 'system' && /ФОРМАТ ОТВЕТА/.test(m.content)), 'форма схемы продублирована словами');
  assert.equal(usage[0].promptTokens, 120);
});

test('провайдер lmstudio: повтор при невалидном JSON и при сетевой ошибке', async () => {
  let n = 0;
  const provider = makeProvider({
    kind: 'lmstudio', model: 'q', retryDelay: 0,
    fetch: async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'я не умею json' } }] }; } };
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"answer":"со второй попытки"}' } }] }; } };
    },
  });
  const data = await provider.complete([{ role: 'user', content: 'x' }], SCHEMAS.answer, {});
  assert.deepEqual(data, { answer: 'со второй попытки' });
  assert.equal(n, 3, 'один сетевой повтор и один повтор по невалидному JSON');
});

test('провайдер lmstudio: 4xx не повторяется и даёт kind model', async () => {
  let n = 0;
  const provider = makeProvider({
    kind: 'lmstudio', retryDelay: 0,
    fetch: async () => { n++; return { ok: false, status: 400, async text() { return 'bad schema'; } }; },
  });
  await assert.rejects(
    () => provider.complete([{ role: 'user', content: 'x' }], SCHEMAS.answer, {}),
    // круг 29 (J5): статус и тело отказа — полями (для журнала), в тексте — человеческие слова
    (e) => e.kind === 'model' && e.status === 400 && e.detail === 'bad schema'
      && /не приняла запрос/.test(e.message) && !/400|bad schema/.test(e.message),
  );
  assert.equal(n, 1);
});

test('провайдер lmstudio: ready() находит модель и переживает отсутствие сервера', async () => {
  const ok = makeProvider({ kind: 'lmstudio', fetch: async () => ({ ok: true, async json() { return { data: [{ id: 'local-qwen' }] }; } }) });
  assert.equal(await ok.ready(), true);
  assert.equal(ok.model, 'local-qwen');
  const dead = makeProvider({ kind: 'lmstudio', fetch: async () => { throw new TypeError('ECONNREFUSED'); } });
  assert.equal(await dead.ready(), false);
});

test('провайдер claude: отсутствие способности и коды ошибок', async () => {
  const absent = makeProvider({ kind: 'claude', claude: { use: async () => null } });
  assert.equal(await absent.ready(), false);
  await assert.rejects(
    () => absent.complete([{ role: 'user', content: 'x' }], SCHEMAS.plan, {}),
    (e) => e.kind === 'model' && /sample/.test(e.message),
  );

  let capturedInput = null, capturedOpts = null;
  const sample = { json: async (input, opts) => { capturedInput = input; capturedOpts = opts; return { ...PLAN_CREATE }; } };
  const ok = makeProvider({ kind: 'claude', sample });
  assert.equal(await ok.ready(), true);
  const plan = await ok.complete(
    [{ role: 'system', content: 'инструкция' }, { role: 'user', content: 'команда' }],
    SCHEMAS.plan,
    { modelTier: 'quick' },
  );
  assert.equal(plan.intent, 'create');
  assert.ok(Array.isArray(capturedInput));
  assert.equal(capturedInput[0].role, 'user', 'системной роли нет — инструкции идут ведущим user-турном');
  assert.equal(capturedInput.at(-1).role, 'user', 'список турнов заканчивается на user');
  assert.match(capturedInput[0].content, /ФОРМАТ ОТВЕТА/);
  assert.match(capturedInput[0].content, /"intent"/, 'пример ответа вшит в промпт');
  assert.equal(capturedOpts.modelTier, 'quick');
  assert.equal(capturedOpts.cache, false, 'кэш выключен: каждая команда должна считаться заново');

  const rate = makeProvider({ kind: 'claude', sample: { json: async () => { throw { code: 'rate_limited', message: 'slow down' }; } } });
  await assert.rejects(() => rate.complete([{ role: 'user', content: 'x' }], SCHEMAS.plan, {}), (e) => e.kind === 'network');
  const cancelled = makeProvider({ kind: 'claude', sample: { json: async () => { throw { code: 'cancelled', message: 'stop' }; } } });
  await assert.rejects(() => cancelled.complete([{ role: 'user', content: 'x' }], SCHEMAS.plan, {}), (e) => e.kind === 'cancelled');
});

/* ── 12. Контекст и промпты ──────────────────────────────────────────────── */

test('выжимка документа компактна и содержит id, имена, тексты, размеры', () => {
  const doc = makeDoc();
  const scope = resolveScope(doc, [], null);
  assert.deepEqual(scope.ids, ['ab1']);
  assert.equal(scope.kind, 'artboard');
  const digest = describeDoc(doc, scope.ids);
  assert.match(digest, /#ab1 frame "Экран заказа" column gap=16/);
  assert.match(digest, /#t1 text "Заголовок".*text="Ваш заказ готов".*style=h2/);
  assert.match(digest, /w=fixed|w=390/);
  assert.ok(digest.length < 3000);

  const huge = makeDoc();
  for (let i = 0; i < 400; i++) {
    huge.nodes[`x${i}`] = { type: 'text', id: `x${i}`, name: `Строка ${i}`, parent: 'ab1', characters: 'Довольно длинный текст пункта списка ' + i, style: 'body', align: 'start', size: { w: { mode: 'fill' }, h: { mode: 'hug' } } };
    huge.nodes.ab1.children.push(`x${i}`);
  }
  const big = describeDoc(huge, ['ab1']);
  assert.ok(big.length <= 21000, 'выжимка ограничена ~20000 знаками');
  assert.match(big, /свёрн|сверн|скрыт/i, 'свёрнутое помечено в тексте');
  assert.match(big, /#btn/, 'кнопка экрана не потеряна: сворачиваются повторы, а не хвост');
});

test('промпты несут правила DSL, токены, выжимку и требование JSON', () => {
  const doc = makeDoc();
  const scope = resolveScope(doc, ['ab1'], null);
  const ctx = {
    tokens: describeTokens(doc), digest: describeDoc(doc, scope.ids), scopeLabel: 'выделенная область',
    guess: 'edit (глагол изменения)', personaHint: PERSONAS[0].hint, placement: 'внутрь выделенного фрейма',
  };
  const tree = PROMPTS.tree(ctx);
  assert.match(tree, /Координат НЕТ/);
  assert.match(tree, /"hug"/);
  assert.match(tree, /colors: bg=#ffffff/);
  // круг 20 (SPEC §6.6): шкалы печатаются с номерами шагов — модель отвечает ссылкой на номер
  assert.match(tree, /spacing \(номер шага=значение px\): 0=4 1=8 2=12/);
  assert.match(tree, /Lorem ipsum/, 'запрет заглушек');
  assert.match(tree, /ДОСЛОВНО/, 'запрет выдумывать поверх заданного');
  assert.match(tree, /строго один JSON-объект/);
  assert.match(tree, /#ab1 frame/, 'выжимка документа подставлена');
  assert.match(tree, /Строгий/, 'характер варианта подставлен');

  const patch = PROMPTS.patch(ctx);
  assert.match(patch, /value всегда СТРОКА/);
  assert.match(patch, /Нельзя менять id, type, parent, children/);
  assert.match(PROMPTS.planner(ctx), /edit \(глагол изменения\)/);
  assert.match(PROMPTS.theme(ctx), /контраст/i);
  assert.match(PROMPTS.answer(ctx), /ничего не меняя/);
  assert.match(PROMPTS.repair(['текст вылез'], {}, SCHEMAS.tree), /текст вылез/);
});

/* ── 13. Ревью: наблюдаемость и степени свободы ──────────────────────────── */

/** Документ поближе к демо: экран с заголовком, карточкой встречи и кнопкой + второй артборд. */
function makeDoc2() {
  const L = (over = {}) => ({ mode: 'column', gap: 16, padding: { t: 24, r: 24, b: 24, l: 24 }, align: 'stretch', justify: 'start', wrap: false, ...over });
  const text = (id, name, characters, style, parent) => ({
    type: 'text', id, name, parent, characters, style, align: 'left',
    size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
  });
  return {
    id: 'doc2', version: 1, root: 'page1',
    nodes: {
      page1: { type: 'page', id: 'page1', name: 'Страница', parent: null, children: ['ab1', 'ab2'] },
      ab1: {
        type: 'frame', id: 'ab1', name: 'Маршрут дня', parent: 'page1', children: ['title', 'card', 'cta'],
        layout: L(), size: { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } }, fill: 'bg', radius: 0, pos: { x: 0, y: 0 },
      },
      title: text('title', 'Заголовок', 'Маршрут дня', 'h1', 'ab1'),
      card: {
        type: 'frame', id: 'card', name: 'Карточка встречи', parent: 'ab1', children: ['cardTitle', 'cardTime'],
        layout: L({ gap: 8 }), size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'bg', radius: 8,
      },
      cardTitle: text('cardTitle', 'Заголовок карточки', 'Встреча с командой', 'h2', 'card'),
      cardTime: text('cardTime', 'Время', '10:00 — 11:00', 'body', 'card'),
      cta: {
        type: 'frame', id: 'cta', name: 'Кнопка добавить', parent: 'ab1', children: ['ctaText'],
        layout: L({ mode: 'row', gap: 8, align: 'center', justify: 'center' }),
        size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'accent', radius: 8,
      },
      ctaText: text('ctaText', 'Надпись кнопки', 'Добавить пункт', 'body', 'cta'),
      ab2: {
        type: 'frame', id: 'ab2', name: 'Сводка недели', parent: 'page1', children: [],
        layout: L(), size: { w: { mode: 'fixed', value: 1200 }, h: { mode: 'hug' } }, fill: 'bg', radius: 0, pos: { x: 500, y: 0 },
      },
    },
    tokens: {
      colors: { bg: '#ffffff', text: '#111111', muted: '#888888', accent: '#ff6b3d' },
      type: { h1: { fontSize: 32, fontWeight: 700, lineHeight: 1.2 }, h2: { fontSize: 24, fontWeight: 600, lineHeight: 1.3 }, body: { fontSize: 16, fontWeight: 400, lineHeight: 1.5 } },
      spacing: [4, 8, 12, 16, 24, 32, 48],
      radii: [0, 4, 8, 16],
    },
    meta: { name: 'Тест 2', createdAt: 0 },
  };
}

const PLAN_EDIT2 = { intent: 'edit', title: 'Поправил выделенное', summary: 'Точечная правка.', steps: ['Найти', 'Поправить'], targets: [] };

/* п.1 — выделение правится само, а не его родитель */

test('п.1: selection в set разворачивается в сами выделенные узлы, а не в родителя', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'selection', path: 'style', value: 'h1' }] },
  });
  const res = await runCommand({ doc, selection: ['cardTitle'], utterance: 'сделай заголовок крупнее', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.deepEqual(res.ops[0], { op: 'set', id: 'cardTitle', path: 'style', value: 'h1' }, 'правка ушла в выделенный текст');
  assert.equal(res.preview.doc.nodes.cardTitle.style, 'h1');
  assert.equal(res.preview.doc.nodes.card.style, undefined, 'фрейм-родитель не тронут');
});

test('п.1: несколько выделенных узлов — несколько операций', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'selection', path: 'align', value: 'center' }] },
  });
  const res = await runCommand({ doc, selection: ['title', 'cardTitle'], utterance: 'выровняй всё по центру', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['title', 'cardTitle']);
});

test('п.1: scope различает ids (что править) и containerId (куда вставлять)', () => {
  const doc = makeDoc2();
  const scope = resolveScope(doc, ['cardTitle'], null);
  assert.deepEqual(scope.ids, ['cardTitle'], 'править — сам выделенный узел');
  assert.equal(scope.containerId, 'card', 'вставлять — в ближайший фрейм');
  assert.equal(scope.kind, 'selection');
});

/* п.2 — агент видит посчитанные размеры */

test('п.2: выжимка печатает посчитанный прямоугольник каждого узла', () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const geo = engine.solve(doc);
  const digest = describeDoc(doc, ['ab1'], { engine, geo });
  assert.match(digest, /#ab1 frame[^\n]*→ 100×20 @\d+,\d+/, 'есть посчитанный прямоугольник');
  assert.match(digest, /#cardTitle text[^\n]*→ \d+×\d+ @\d+,\d+/);
  const auto = describeDoc(doc, ['ab1'], { engine });
  assert.match(auto, /→ \d+×\d+/, 'без готовой геометрии считает сам');
});

test('п.2: формат прямоугольника объяснён в промпте', () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const ctx = {
    tokens: describeTokens(doc), digest: describeDoc(doc, ['ab1'], { engine }),
    scopeLabel: 'активный артборд', guess: 'edit', personaHint: '', placement: '',
  };
  assert.match(PROMPTS.patch(ctx), /→\s*ширина×высота/i);
  assert.match(PROMPTS.patch(ctx), /результат раскладки/i);
});

/* п.3 — большая выжимка со сворачиванием повторов */

test('п.3: выжимка сворачивает однотипные повторы, а не рубит хвост', () => {
  const doc = makeDoc2();
  for (let i = 0; i < 40; i++) {
    const id = `p${i}`;
    doc.nodes[id] = {
      type: 'text', id, name: `Пункт ${i + 1}`, parent: 'card', characters: `Пункт списка номер ${i + 1}`,
      style: 'body', align: 'left', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    };
    doc.nodes.card.children.push(id);
  }
  const digest = describeDoc(doc, ['page1'], { limit: 1300 });
  assert.match(digest, /ещё \d+ таких же/i, 'повторы свёрнуты с пометкой');
  assert.match(digest, /#cta/, 'узлы после длинного списка не потеряны');
  assert.match(digest, /#ab2/, 'второй артборд виден');
  assert.ok(digest.length <= 1400);
});

test('п.3: предел выжимки поднят до ~20000 знаков', () => {
  const doc = makeDoc2();
  const words = ['альфа', 'бета', 'гамма', 'дельта', 'эпсилон', 'дзета', 'эта'];
  for (let i = 0; i < 300; i++) {                      // соседи разные — сворачивать нечего
    const id = `q${i}`;
    doc.nodes[id] = {
      type: 'text', id, name: `Блок ${words[i % words.length]}`, parent: 'ab1',
      characters: `Довольно длинный текст пункта списка ${words[i % words.length]} ${i}`,
      style: i % 2 ? 'body' : 'h2', align: 'left', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    };
    doc.nodes.ab1.children.push(id);
  }
  const digest = describeDoc(doc, ['page1']);
  assert.ok(digest.length <= 21000);
  assert.ok(digest.length > 3000, 'выжимка больше не обрезана до 3000');
});

/* п.4 и п.5 — «добавь» не рождает артборд, активный артборд доходит до агента */

test('п.4: «добавь снизу панель» кладёт узлы в активный артборд, а не в новый', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Добавил панель', summary: 'Панель с тремя кнопками.', steps: ['Панель'] },
    tree: {
      type: 'frame', name: 'Нижняя панель', layout: { mode: 'row', gap: 8 }, fill: 'bg',
      children: [
        { type: 'text', name: 'Домой', text: 'Домой', style: 'body' },
        { type: 'text', name: 'Планы', text: 'Планы', style: 'body' },
        { type: 'text', name: 'Профиль', text: 'Профиль', style: 'body' },
      ],
    },
  });
  const res = await runCommand({
    doc, selection: [], utterance: 'добавь снизу панель с тремя кнопками',
    provider, engine, activeArtboardId: 'ab1',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const root = res.ops[0].node;
  assert.equal(root.parent, 'ab1', 'панель внутри активного артборда');
  assert.equal(root.pos, undefined, 'это не артборд — координат нет');
  assert.equal(res.ops.length, 4);
});

test('п.4: локальный разбор не перебивает план модели на create', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Добавил строку', summary: 'Новая строка.', steps: ['Строка'] },
    tree: { type: 'text', name: 'Строка', text: 'Новая строка', style: 'body' },
  });
  // локальный классификатор при выделении уверенно ставит edit — раньше это перебивало план
  const res = await runCommand({ doc, selection: ['card'], utterance: 'убери отсюда лишнее и добавь строку', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.plan.intent, 'create');
  assert.ok(res.ops.every((o) => o.op === 'create'), 'выполнено намерение модели');
});

test('п.4: артборд создаётся только по явным словам', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал новый экран', summary: 'Отдельный экран.', steps: ['Экран'] },
    tree: { type: 'frame', name: 'Экран оплаты', layout: { mode: 'column', gap: 16 }, size: { w: 390, h: 'hug' }, children: [{ type: 'text', name: 'Заголовок', text: 'Оплата', style: 'h1' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай новый экран оплаты', provider, engine, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].node.parent, doc.root);
  assert.ok(res.ops[0].node.pos, 'у артборда есть координаты');
});

test('п.5: активный артборд приходит параметром и становится областью по умолчанию', () => {
  const doc = makeDoc2();
  const scope = resolveScope(doc, [], null, { activeArtboardId: 'ab2' });
  assert.deepEqual(scope.ids, ['ab2']);
  assert.equal(scope.containerId, 'ab2');
  assert.equal(scope.kind, 'artboard');
  const fallback = resolveScope({ ...doc, meta: { ...doc.meta, activeArtboard: 'ab2' } }, [], null);
  assert.deepEqual(fallback.ids, ['ab2'], 'doc.meta.activeArtboard — запасной источник');
});

/* п.6 — порядок разрешения целей */

test('п.6: цель ищется сначала внутри выделения', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'заголовок', path: 'style', value: 'h1' }] },
  });
  const res = await runCommand({ doc, selection: ['card'], utterance: 'сделай заголовок карточки крупнее', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].id, 'cardTitle', 'частичное совпадение внутри выделения важнее глобального точного');
});

test('п.6: попадание вне выделения сопровождается предупреждением', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'Кнопка добавить', path: 'fill', value: 'accent' }] },
  });
  const res = await runCommand({ doc, selection: ['card'], utterance: 'перекрась кнопку', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].id, 'cta');
  assert.ok(res.warnings.some((w) => /вне выделения/i.test(w)), 'предупреждение о выходе за область: ' + res.warnings.join(' | '));
});

/* п.7 — словарь цветов */

test('п.7: «зелёный» понимается, а не выбрасывает правку', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'Кнопка добавить', path: 'fill', value: 'зелёный' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'перекрась кнопку в зелёный', provider, engine, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.match(String(res.ops[0].value), /^#[0-9a-f]{6}$/, 'цвет стал hex');
  assert.equal(res.preview.doc.nodes.cta.fill, res.ops[0].value);
});

test('п.7: словарь знает русские и английские названия, неизвестный цвет только предупреждает', () => {
  const doc = makeDoc2();
  const warns = [];
  const w = (m) => warns.push(m);
  assert.match(String(coerceValue('синий', 'fill', doc, w)), /^#[0-9a-f]{6}$/);
  assert.match(String(coerceValue('green', 'fill', doc, w)), /^#[0-9a-f]{6}$/);
  assert.match(String(coerceValue('тёмно-серый', 'fill', doc, w)), /^#[0-9a-f]{6}$/);
  assert.equal(coerceValue('буряковый', 'fill', doc, w), undefined);
  assert.ok(warns.some((m) => /буряковый/.test(m)));
  assert.equal(coerceValue('accent', 'fill', doc, w), 'accent', 'токен документа по-прежнему в приоритете');
});

test('п.7: непонятный цвет не уносит с собой остальные правки', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: {
      edits: [
        { op: 'set', target: 'Кнопка добавить', path: 'fill', value: 'буряковый' },
        { op: 'set', target: 'Заголовок', path: 'style', value: 'h2' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'перекрась кнопку и уменьши заголовок', provider, engine, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].id, 'title');
});

/* п.8 — белый список путей */

test('п.8: посторонние пути не проходят', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: {
      edits: [
        { op: 'set', target: 'Карточка встречи', path: 'visible', value: 'false' },
        { op: 'set', target: 'Карточка встречи', path: 'locked', value: 'true' },
        { op: 'set', target: 'Карточка встречи', path: 'onclick', value: 'alert(1)' },
        { op: 'set', target: 'Карточка встречи', path: 'layout.gap', value: '24' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: ['card'], utterance: 'сделай отступ больше', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  // круг 20: 24 — шаг шкалы отступов документа, число становится ссылкой на него
  assert.deepEqual(res.ops[0], { op: 'set', id: 'card', path: 'layout.gap', value: 'spacing.4' });
  assert.equal(res.preview.doc.nodes.card.visible, undefined);
  assert.equal(res.preview.doc.nodes.card.onclick, undefined);
  assert.ok(res.warnings.some((w) => /visible/.test(w)));
  assert.ok(res.warnings.some((w) => /onclick/.test(w)));
});

/* п.9 — создать контейнер и перенести в него существующий узел одной командой */

test('п.9: «оберни в карточку» — create и move в одном патче', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: {
      edits: [
        { op: 'create', target: 'selection', parent: 'selection', node: { type: 'frame', name: 'Карточка', layout: { mode: 'column', gap: 8 }, fill: 'bg', radius: 8 } },
        { op: 'move', target: 'selection', parent: 'Карточка', index: 0 },
      ],
    },
  });
  const res = await runCommand({ doc, selection: ['title'], utterance: 'оберни это в карточку', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const created = res.ops.find((o) => o.op === 'create');
  const moved = res.ops.find((o) => o.op === 'move');
  assert.ok(created && moved, 'обе операции на месте');
  assert.equal(moved.parent, created.node.id, 'move ссылается на только что созданный фрейм');
  assert.equal(moved.id, 'title');
  assert.equal(res.preview.doc.nodes.title.parent, created.node.id);
});

/* п.10 — память о разговоре */

test('п.10: history попадает в контекст модели', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'Кнопка добавить', path: 'fill', value: 'синий' }] },
  });
  const res = await runCommand({
    doc, selection: [], utterance: 'а теперь то же, но синее', provider, engine, activeArtboardId: 'ab1',
    history: [
      { utterance: 'перекрась кнопку в зелёный', summary: 'Кнопка стала зелёной' },
      { utterance: 'сделай заголовок крупнее', summary: 'Заголовок h1' },
    ],
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const all = provider.calls.map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
  assert.match(all, /перекрась кнопку в зелёный/);
  assert.match(all, /Кнопка стала зелёной/);
});

/* п.11 — ветка «не понял» */

test('п.11: непонятная команда возвращает clarify без операций', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'clarify', title: 'Не понял', summary: 'Команда неразборчива.', steps: ['Переспросить'], clarify: 'Что именно поменять на экране?' },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'ну это самое', provider, engine, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, []);
  assert.ok(res.clarify && /поменять/i.test(res.clarify), 'есть переспрос: ' + res.clarify);
  assert.ok(res.preview && res.preview.doc === doc);
});

test('п.11: бессмысленная реплика не материализуется даже при create от модели', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал экран', summary: 'Новый экран.', steps: ['Экран'] },
    tree: { type: 'frame', name: 'Экран', children: [{ type: 'text', name: 'Т', text: 'Текст', style: 'body' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай', provider, engine, activeArtboardId: 'ab1' });
  assert.deepEqual(res.ops, []);
  assert.ok(res.clarify, 'вместо артборда — переспрос');
});

test('п.11: схема плана знает про clarify', () => {
  assert.ok(SCHEMAS.plan.schema.properties.intent.enum.includes('clarify'));
  assert.match(SCHEMAS.plan.hint, /clarify/);
  const doc = makeDoc2();
  const ctx = { tokens: describeTokens(doc), digest: '(выжимка)', scopeLabel: 'активный артборд', guess: 'create', personaHint: '', placement: '' };
  assert.match(PROMPTS.planner(ctx), /clarify/);
});

/* п.12 и п.13 — варианты */

test('п.12: у вариантов разная температура, свой план и разные оси вариации', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал блок', summary: 'Блок.', steps: ['Блок'] },
    tree: () => ({ type: 'frame', name: 'Блок', layout: { mode: 'column', gap: 16 }, children: [{ type: 'text', name: 'Т', text: 'Текст', style: 'body' }] }),
  });
  const variants = await runVariants({ doc, selection: [], utterance: 'собери блок статистики', provider, engine, n: 3, activeArtboardId: 'ab1' });
  assert.equal(variants.length, 3);
  const treeCalls = provider.calls.filter((c) => c.schema === 'tree');
  const temps = treeCalls.map((c) => c.opts.temperature);
  assert.equal(new Set(temps).size, 3, 'температуры различаются: ' + temps.join(','));
  // круг 13, п.8: план один на всех (1 вызов вместо 3), а различие несут разведённые заранее оси
  assert.equal(provider.calls.filter((c) => c.schema === 'plan').length, 1, 'план считается один раз');
  const prompts = treeCalls.map((c) => c.messages.map((m) => m.content).join('\n'));
  assert.ok(prompts.every((t) => /ОСИ СОСЕДНИХ ВАРИАНТОВ/.test(t)), 'каждому названы оси соседей');
  assert.ok(prompts.every((t) => /не\s+повторяй|не\s+твоё\s+задание/i.test(t)), 'и помечены как чужие');
  const axes = treeCalls.map((c) => c.messages[0].content);
  assert.equal(new Set(axes).size, 3, 'у вариантов разные характеры в промпте');
});

test('п.13: runVariants зовёт onStage с нумерацией', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал блок', summary: 'Блок.', steps: ['Блок'] },
    tree: { type: 'frame', name: 'Блок', children: [{ type: 'text', name: 'Т', text: 'Текст', style: 'body' }] },
  });
  const seen = [];
  await runVariants({ doc, selection: [], utterance: 'собери блок', provider, engine, n: 3, onStage: (s) => seen.push(s), activeArtboardId: 'ab1' });
  assert.ok(seen.length > 0, 'стадии дошли до интерфейса');
  assert.ok(seen.some((s) => /вариант 2 из 3/i.test(String(s.label))), 'есть нумерация: ' + seen.map((s) => s.label).join(' | '));
  // круг 13, п.8: стадии общего плана номера варианта не имеют — они помечены variantShared
  assert.ok(seen.every((s) => s.variantCount === 3), seen.map((s) => s.label).join(' | '));
  assert.ok(seen.every((s) => s.variantIndex >= 1 || s.variantShared === true), seen.map((s) => s.label).join(' | '));
  assert.ok(seen.some((s) => s.variantShared === true), 'общий план в ленте виден');
});

/* п.14 — plan.title не теряется */

test('п.14: стадия плана несёт и заголовок, и подробность', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'Заголовок', path: 'style', value: 'h2' }] },
  });
  const seen = [];
  await runCommand({ doc, selection: [], utterance: 'уменьши заголовок', provider, engine, onStage: (s) => seen.push(s), activeArtboardId: 'ab1' });
  const planStage = seen.find((s) => s.stage === 'plan' && s.detail);
  assert.ok(planStage, 'стадия плана есть');
  assert.match(String(planStage.label), new RegExp(PLAN_EDIT2.title), 'заголовок в label');
  assert.match(String(planStage.detail), new RegExp(PLAN_EDIT2.summary), 'подробность в detail');
});

/* п.15 — отмена зависшего провайдера */

test('п.15: зависший провайдер отменяется сигналом, а не ждёт вечно', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const ctl = new AbortController();
  const provider = {
    name: 'hung', kind: 'fake', async ready() { return true; },
    complete: () => new Promise(() => {}),
  };
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 30);
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine, signal: ctl.signal });
  assert.equal(res.error.kind, 'cancelled');
  assert.ok(Date.now() - t0 < 3000, 'вернулись сразу после отмены');
});

test('п.15: у claude-провайдера есть собственный дедлайн', async () => {
  const provider = makeProvider({ kind: 'claude', timeout: 60, sample: { json: () => new Promise(() => {}) } });
  const t0 = Date.now();
  await assert.rejects(
    () => provider.complete([{ role: 'user', content: 'x' }], SCHEMAS.plan, {}),
    (e) => e.kind === 'network' || e.kind === 'cancelled',
  );
  assert.ok(Date.now() - t0 < 3000);
});

/* п.16 — бюджет повторов LM Studio */

test('п.16: повторы ограничены и видны через onRetry', async () => {
  let n = 0;
  const notes = [];
  const provider = makeProvider({
    kind: 'lmstudio', model: 'q', retryDelay: 0,
    fetch: async () => { n++; throw new TypeError('fetch failed'); },
  });
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'x' }], SCHEMAS.answer, { onRetry: (i) => notes.push(i) }));
  assert.ok(n <= 3, `запросов не больше трёх, а было ${n}`);
  assert.ok(notes.length >= 1, 'о повторах сообщено');
  assert.match(String(notes[0].text || ''), /повтор/i);
});

/* п.17 — низкий контраст чинится, но результат не теряется */

test('п.17: низкий контраст запускает починку и остаётся понятным предупреждением', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine({
    violations: (d) => (d.nodes.title && d.nodes.title.color === 'muted'
      ? [{ code: 'low-contrast', nodeId: 'title', message: 'контраст 1.10:1 при норме 3:1 (#888888 на #ffffff)', severity: 'warn' }]
      : []),
  });
  const provider = makeFakeProvider({
    plan: { intent: 'edit', title: 'Приглушил заголовок', summary: 'Ставлю приглушённый цвет.', steps: ['Цвет'] },
    patch: [
      { edits: [{ op: 'set', target: 'Заголовок', path: 'color', value: 'muted' }] },
      { edits: [{ op: 'set', target: 'Заголовок', path: 'color', value: 'muted' }] },
    ],
  });
  const seen = [];
  /* Круг 16, п.2: реплика НЕ называет цвет («поправь заголовок»), поэтому низкий контраст —
   * промах модели, и починка обязана запуститься. Когда цвет назван («сделай приглушённым»),
   * замечание считается следствием просьбы — это проверяет отдельный тест круга 16. */
  const res = await runCommand({ doc, selection: [], utterance: 'поправь заголовок', provider, engine, onStage: (s) => seen.push(s.stage), activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(seen.includes('repair'), 'контраст запустил починку');
  assert.ok(res.ops.length > 0, 'результат всё равно применён');
  const w = res.warnings.join(' | ');
  assert.match(w, /контраст/i);
  assert.match(w, /Заголовок/, 'в предупреждении имя слоя, а не id: ' + w);
  assert.ok(!/#title/.test(w), 'без технического id');
});

/* п.18 — дублирование через cloneSubtree */

test('п.18: «продублируй карточку» копирует поддерево движком', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'edit', title: 'Продублировал карточку', summary: 'Копия карточки.', steps: ['Копия'] },
    patch: { edits: [{ op: 'duplicate', target: 'Карточка встречи' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'продублируй карточку встречи', provider, engine, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.ops.length >= 3, 'поддерево скопировано целиком: ' + res.ops.length);
  assert.ok(res.ops.every((o) => o.op === 'create'));
  const root = res.ops[0].node;
  assert.equal(root.parent, 'ab1');
  assert.equal(root.type, 'frame');
  const texts = res.ops.filter((o) => o.node.type === 'text').map((o) => o.node.characters);
  assert.ok(texts.includes('Встреча с командой'), 'оформление и тексты не пересказаны моделью, а скопированы');
  assert.ok(res.preview.doc.nodes.ab1.children.length > doc.nodes.ab1.children.length);
});

test('п.18: схема патча знает про duplicate', () => {
  assert.ok(SCHEMAS.patch.schema.properties.edits.items.properties.op.enum.includes('duplicate'));
  assert.match(SCHEMAS.patch.hint, /duplicate/);
});

/* п.19 — общий предел на число узлов */

test('п.19: общий счётчик узлов ограничивает разбор', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const wide = (depth) => (depth === 0
    ? { type: 'text', name: 'Лист', text: 'Текст', style: 'body' }
    : { type: 'frame', name: `Ур${depth}`, children: Array.from({ length: 5 }, () => wide(depth - 1)) });
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал', summary: 'Большое дерево.', steps: ['Дерево'] },
    tree: wide(5),
  });
  const res = await runCommand({ doc, selection: [], utterance: 'собери новый экран каталога', provider, engine, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.ops.length <= 400, `узлов не больше 400, а было ${res.ops.length}`);
  assert.ok(res.warnings.some((w) => /сло[ёе]в/i.test(w) && /400|предел|ограничен/i.test(w)), 'внятное предупреждение: ' + res.warnings.join(' | '));
  assert.ok(res.warnings.length < 200, 'без потока одинаковых предупреждений');
});

/* geo снаружи */

test('переданная геометрия используется и не пересчитывается', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  let solves = 0;
  const wrapped = { ...engine, solve: (d) => { solves++; return engine.solve(d); } };
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'Заголовок', path: 'style', value: 'h2' }] },
  });
  const geo = engine.solve(doc);
  const res = await runCommand({ doc, selection: [], utterance: 'уменьши заголовок', provider, engine: wrapped, geo, activeArtboardId: 'ab1' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(solves <= 2, `геометрия исходного документа не пересчитывается лишний раз (${solves})`);
  assert.ok(res.preview.geo, 'превью со своей геометрией');
});

test('п.9: «сгруппируй эти три» — обёртка встаёт рядом с выделенным, а не внутрь него', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: {
      edits: [
        { op: 'create', parent: 'selection', node: { type: 'frame', name: 'Группа', layout: { mode: 'column', gap: 8 } } },
        { op: 'move', target: 'selection', parent: 'Группа', index: 0 },
      ],
    },
  });
  // среди выделенного есть фрейм «Карточка встречи» — раньше обёртка создавалась ВНУТРИ него и move зацикливался
  const res = await runCommand({ doc, selection: ['title', 'card', 'cta'], utterance: 'сгруппируй эти три', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const created = res.ops.find((o) => o.op === 'create');
  assert.equal(created.node.parent, 'ab1', 'группа создана рядом с выделенным');
  assert.deepEqual(res.ops.filter((o) => o.op === 'move').map((o) => o.id), ['title', 'card', 'cta']);
  assert.equal(res.preview.doc.nodes.card.parent, created.node.id);
});

test('выжимка печатает style/fill вида {token:"body"} как имя токена', () => {
  const doc = makeDoc2();
  doc.nodes.title.style = { token: 'h1' };
  doc.nodes.cta.fill = { token: 'accent' };
  const digest = describeDoc(doc, ['ab1']);
  assert.match(digest, /style=h1/);
  assert.match(digest, /fill=accent/);
});

/* ══ Круг 2: весь документ в запросе, порядок move, пустая команда ═════════ */

/** Все id поддерева. */
function subtreeIds(doc, id) {
  const out = [];
  const walk = (x) => { if (!doc.nodes[x]) return; out.push(x); for (const k of doc.nodes[x].children || []) walk(k); };
  walk(id);
  return out;
}
const seenIds = (digest, ids) => ids.filter((id) => digest.includes(`#${id} `));

/** Документ из 400+ узлов на двух артбордах: проверка бюджета и «дальних» поддеревьев. */
function makeBigDoc() {
  const doc = makeDoc2();
  const add = (parent, id, name, chars, style) => {
    doc.nodes[id] = {
      type: 'text', id, name, parent, characters: chars, style, align: 'left',
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    };
    doc.nodes[parent].children.push(id);
  };
  const words = ['альфа', 'бета', 'гамма', 'дельта', 'эпсилон', 'дзета', 'эта', 'тета'];
  // 200 разных (несворачиваемых как повторы) узлов на первом артборде
  for (let i = 0; i < 200; i++) {
    const id = `m${i}`;
    doc.nodes[id] = {
      type: 'frame', id, name: `Блок ${words[i % words.length]} ${i}`, parent: 'ab1', children: [],
      layout: { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'stretch', justify: 'start', wrap: false },
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'bg', radius: 8,
    };
    doc.nodes.ab1.children.push(id);
    add(id, `m${i}t`, `Подпись ${words[(i + 1) % words.length]}`, `Довольно длинный текст блока ${words[i % words.length]} номер ${i}`, i % 2 ? 'body' : 'h2');
  }
  // и столько же на втором
  doc.nodes.ab2.children.length = 0;
  for (let i = 0; i < 200; i++) {
    const id = `s${i}`;
    doc.nodes[id] = {
      type: 'frame', id, name: `Строка сводки ${words[i % words.length]} ${i}`, parent: 'ab2', children: [],
      layout: { mode: 'row', gap: 16, padding: { t: 12, r: 16, b: 12, l: 16 }, align: 'center', justify: 'start', wrap: false },
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'bg', radius: 0,
    };
    doc.nodes.ab2.children.push(id);
    add(id, `s${i}t`, `Ячейка ${words[(i + 3) % words.length]}`, `Значение строки ${words[i % words.length]} ${i} за неделю`, 'body');
  }
  return doc;
}

test('круг2 п.1: без выделения выжимка описывает ВЕСЬ документ, оба артборда', () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const scope = resolveScope(doc, [], engine, { activeArtboardId: 'ab1' });
  const digest = describeDoc(doc, scope.ids, { engine, scopeKind: scope.kind });

  const all = Object.keys(doc.nodes);
  assert.deepEqual(seenIds(digest, all).sort(), all.sort(), 'в выжимке все узлы документа');
  assert.match(digest, /#ab2 frame "Сводка недели"/, 'второй артборд на месте');
  assert.match(digest, /#ab1[^\n]*АКТИВНЫЙ АРТБОРД/, 'активный артборд помечен');
  assert.match(digest, /^РАБОТАЕМ С:.*Маршрут дня/m, 'есть строка «РАБОТАЕМ С»');
  assert.ok(digest.length <= 21000);
});

test('круг2 п.1: при выделении одного узла виден весь документ, выделенное помечено', () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const scope = resolveScope(doc, ['cardTitle'], engine);
  const digest = describeDoc(doc, scope.ids, { engine, scopeKind: scope.kind });

  const all = Object.keys(doc.nodes);
  assert.equal(seenIds(digest, all).length, all.length, 'выделение не сужает выжимку до одного узла');
  assert.match(digest, /#cardTitle[^\n]*ВЫДЕЛЕНО/, 'строка выделенного узла помечена');
  assert.match(digest, /#card frame "Карточка встречи"/, 'родитель виден');
  assert.match(digest, /#cardTime/, 'сосед виден');
  assert.match(digest, /#ab2 frame "Сводка недели"/, 'второй экран виден');
  assert.match(digest, /^РАБОТАЕМ С:[^\n]*Заголовок карточки/m);
});

test('круг2 п.1: документ из 400+ узлов влезает в бюджет, но оба артборда видны', () => {
  const doc = makeBigDoc();
  const engine = makeStubEngine();
  assert.ok(Object.keys(doc.nodes).length > 400, 'документ действительно большой');

  const scope = resolveScope(doc, ['card'], engine, { activeArtboardId: 'ab1' });
  const digest = describeDoc(doc, scope.ids, { engine, scopeKind: scope.kind });
  assert.ok(digest.length <= 20000, `бюджет не превышен: ${digest.length}`);
  assert.match(digest, /#ab1 frame "Маршрут дня"/);
  assert.match(digest, /#ab2 frame "Сводка недели"/, 'второй артборд не потерян при сворачивании');
  assert.match(digest, /#card frame "Карточка встречи"[^\n]*ВЫДЕЛЕНО/);
  // область работы подробна: дети выделенного узла на месте
  assert.match(digest, /#cardTitle/);
  assert.match(digest, /#cardTime/);
  assert.match(digest, /свёрн|сверн|скрыт/i, 'дальние поддеревья свёрнуты с пометкой');
  // дальние поддеревья свёрнуты сильнее, чем область работы
  const far = seenIds(digest, subtreeIds(doc, 'ab2')).length;
  assert.ok(far >= 1 && far < subtreeIds(doc, 'ab2').length, `второй артборд показан выборочно: ${far}`);
});

test('круг2 п.1: в запрос к модели уходят узлы второго артборда', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: { edits: [{ op: 'set', target: 'Заголовок карточки', path: 'style', value: 'h1' }] },
  });
  const res = await runCommand({
    doc, selection: ['cardTitle'], utterance: 'сделай эту надпись как в сводке недели',
    provider, engine, activeArtboardId: 'ab1',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const sent = provider.calls.map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
  assert.match(sent, /Сводка недели/, 'имя второго артборда дошло до модели');
  assert.match(sent, /РАБОТАЕМ С:/, 'область работы разметена');
  assert.match(sent, /ВЫДЕЛЕНО/);
});

test('круг2 п.2: последовательные move без index сохраняют порядок правок', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: {
      edits: [
        { op: 'create', parent: 'selection', node: { type: 'frame', name: 'Группа', layout: { mode: 'column', gap: 8 } } },
        { op: 'move', target: 'Заголовок', parent: 'Группа' },
        { op: 'move', target: 'Карточка встречи', parent: 'Группа' },
        { op: 'move', target: 'Кнопка добавить', parent: 'Группа' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: ['ab1'], utterance: 'сгруппируй эти три', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const group = res.ops.find((o) => o.op === 'create').node.id;
  const moves = res.ops.filter((o) => o.op === 'move');
  assert.deepEqual(moves.map((o) => o.id), ['title', 'card', 'cta']);
  assert.deepEqual(moves.map((o) => o.index), [0, 1, 2], 'счётчик вставок на нового родителя');
  assert.deepEqual(res.preview.doc.nodes[group].children, ['title', 'card', 'cta'], 'порядок не перевёрнут');
});

test('круг2 п.2: move без index в существующий родитель дописывает в конец', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT2,
    patch: {
      edits: [
        { op: 'move', target: 'Заголовок', parent: 'Сводка недели' },
        { op: 'move', target: 'Кнопка добавить', parent: 'Сводка недели' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: ['ab1'], utterance: 'перенеси заголовок и кнопку в сводку', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.index), [0, 1], 'пустой родитель: 0, затем 1');
  assert.deepEqual(res.preview.doc.nodes.ab2.children, ['title', 'cta']);
});

test('круг2 п.3: пустая команда — вежливый переспрос, а не ошибка', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({});
  // ни одного слова: переспрашиваем сразу, не тратя обращение к модели
  for (const utterance of ['', '   ', '\n\t ', '...', '???', undefined]) {
    const res = await runCommand({ doc, selection: [], utterance, provider, engine, activeArtboardId: 'ab1' });
    assert.equal(res.error, undefined, `«${utterance}»: ${JSON.stringify(res.error)}`);
    assert.deepEqual(res.ops, [], `«${utterance}»: операций нет`);
    assert.ok(res.clarify && res.clarify.length > 5, `«${utterance}»: есть переспрос — ${res.clarify}`);
    assert.ok(res.preview && res.preview.doc === doc, `«${utterance}»: превью документа на месте`);
    assert.ok(res.stages.some((st) => st.stage === 'clarify'), `«${utterance}»: стадия clarify в ленте`);
    assert.ok(res.stages.some((st) => st.stage === 'done'), `«${utterance}»: лента закрыта`);
  }
  assert.equal(provider.calls.length, 0, 'модель по бессловесной команде не вызывается');
});

test('круг2 п.3: мусор со словами по-прежнему переспрашивает через планировщик', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  for (const utterance of ['ммм', 'ну это самое', 'сделай']) {
    const provider = makeFakeProvider({
      plan: { intent: 'clarify', title: 'Не понял', summary: 'Неразборчиво.', steps: ['Переспросить'], clarify: 'Что именно поменять?' },
    });
    const res = await runCommand({ doc, selection: [], utterance, provider, engine, activeArtboardId: 'ab1' });
    assert.equal(res.error, undefined, `«${utterance}»: ${JSON.stringify(res.error)}`);
    assert.deepEqual(res.ops, []);
    assert.ok(res.clarify, `«${utterance}»: есть переспрос`);
    assert.equal(provider.calls.length, 1, 'план запрошен, генерация — нет');
  }
});

test('круг2 п.3: пустой команде не мешает отсутствие документа', async () => {
  const provider = makeFakeProvider({});
  const res = await runCommand({ doc: null, selection: [], utterance: '', provider, engine: makeStubEngine() });
  assert.ok(res.error, 'без документа это по-прежнему ошибка');
});

test('круг2 п.1: бюджет держится и на патологически глубоком документе', () => {
  const doc = makeDoc2();
  let parent = 'card';
  for (let i = 0; i < 300; i++) {                    // цепочка предков длиннее любого бюджета
    const id = `deep${i}`;
    doc.nodes[id] = {
      type: 'frame', id, name: `Уровень ${i}`, parent, children: [],
      layout: { mode: 'column', gap: 4, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'stretch', justify: 'start', wrap: false },
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    };
    doc.nodes[parent].children.push(id);
    doc.nodes[`${id}t`] = {
      type: 'text', id: `${id}t`, name: `Текст ${i}`, parent: id, characters: `Довольно длинная строка уровня ${i}`,
      style: 'body', align: 'left', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    };
    doc.nodes[id].children.push(`${id}t`);
    parent = id;
  }
  const engine = makeStubEngine();
  const scope = resolveScope(doc, ['deep299t'], engine, { activeArtboardId: 'ab1' });
  const digest = describeDoc(doc, scope.ids, { engine, scopeKind: scope.kind });
  assert.ok(digest.length <= DIGEST_LIMIT, `бюджет не превышен: ${digest.length}`);
  assert.match(digest, /#ab1 frame "Маршрут дня"/, 'первый артборд назван');
  assert.match(digest, /#ab2 frame "Сводка недели"/, 'второй артборд назван даже при глубокой цепочке');
  assert.match(digest, /#deep299t[^\n]*ВЫДЕЛЕНО/, 'выделенный узел напечатан');
  assert.match(digest, /^РАБОТАЕМ С:/m);
});

test('круг2 п.1: промпт правок объясняет, что чужие артборды — образец, а не цель', () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const scope = resolveScope(doc, ['cardTitle'], engine);
  const ctx = {
    tokens: describeTokens(doc), digest: describeDoc(doc, scope.ids, { engine, scopeKind: scope.kind }),
    scopeLabel: 'выделенная область', guess: 'edit', personaHint: '', placement: '',
  };
  const patch = PROMPTS.patch(ctx);
  assert.match(patch, /РАБОТАЕМ С:/, 'правило ссылается на разметку области работы');
  assert.match(patch, /весь документ/i, 'сказано, что виден весь документ');
  assert.match(patch, /сводке недели|образц/i, 'разрешено сравнивать и копировать с чужих экранов');
  assert.match(PROMPTS.tree(ctx), /весь документ/i);
});

/* п.6 приёмки: команды, невозможные до полной выжимки */

/** Патч возвращается только если в промпте есть нужные имена — как у настоящей модели. */
function makePeekingProvider(plan, patchFrom) {
  const calls = [];
  return {
    calls,
    async complete(messages, schema) {
      const text = messages.map((m) => m.content).join('\n');
      calls.push({ schema: schema.name, text });
      if (schema.name === 'plan') return plan;
      const out = patchFrom(text);
      if (out === null) throw new BrainError('model', 'в промпте нет нужных данных');
      return out;
    },
  };
}

test('круг2 п.6: «сделай как в сводке недели» — оформление берётся с другого артборда', async () => {
  const doc = makeDoc2();
  doc.nodes.ab2.children.push('sumTitle');
  doc.nodes.sumTitle = {
    type: 'text', id: 'sumTitle', name: 'Заголовок сводки', parent: 'ab2', characters: 'Сводка недели',
    style: 'h1', align: 'center', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
  };
  const engine = makeStubEngine();
  const provider = makePeekingProvider(
    { intent: 'edit', title: 'Как в сводке', summary: 'Стиль как у заголовка сводки.', steps: ['Найти сводку'], targets: ['selection'] },
    (text) => {
      const line = text.split('\n').find((l) => l.includes('"Заголовок сводки"'));
      const m = line && line.match(/style=(\w+)/);
      return m ? { summary: 'как в сводке', edits: [{ op: 'set', target: 'selection', path: 'style', value: m[1] }] } : null;
    },
  );
  const res = await runCommand({
    doc, selection: ['cardTitle'], utterance: 'сделай эту надпись как в сводке недели',
    provider, engine, activeArtboardId: 'ab1',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [{ op: 'set', id: 'cardTitle', path: 'style', value: 'h1' }]);
});

test('круг2 п.6: «повтори шапку со второго экрана» — duplicate через артборды', async () => {
  const doc = makeDoc2();
  doc.nodes.ab2.children.push('sumHead');
  doc.nodes.sumHead = {
    type: 'frame', id: 'sumHead', name: 'Шапка сводки', parent: 'ab2', children: ['sumHeadText'],
    layout: { mode: 'row', gap: 16, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'center', justify: 'between', wrap: false },
    size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'bg', radius: 0,
  };
  doc.nodes.sumHeadText = {
    type: 'text', id: 'sumHeadText', name: 'Надпись шапки', parent: 'sumHead', characters: 'Сводка недели',
    style: 'h2', align: 'left', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
  };
  const engine = makeStubEngine();
  const provider = makePeekingProvider(
    { intent: 'edit', title: 'Повторил шапку', summary: 'Копия шапки со второго экрана.', steps: ['Скопировать'], targets: ['Шапка сводки'] },
    (text) => (text.includes('"Шапка сводки"')
      ? { summary: 'копия шапки', edits: [{ op: 'duplicate', target: 'Шапка сводки', parent: 'Маршрут дня', index: 0 }] }
      : null),
  );
  const res = await runCommand({
    doc, selection: [], utterance: 'повтори шапку со второго экрана', provider, engine, activeArtboardId: 'ab1',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.ops.length >= 2, 'копия вместе с содержимым: ' + res.ops.length);
  assert.ok(res.ops.every((o) => o.op === 'create'));
  assert.equal(res.preview.doc.nodes.ab1.children.length, 4, 'копия встала в первый артборд');
  // круг 5, п.8: у копии своё имя, иначе в документе две «Шапки сводки» и по имени уже не адресуешь
  assert.equal(res.preview.doc.nodes[res.ops[0].node.id].name, 'Шапка сводки (копия)');
  assert.ok(res.warnings.some((w) => /вне/.test(w)), 'человека предупредили, что цель из другого места');
});

test('круг2 п.6: «выровняй по ширине таблицы» — посчитанная ширина чужого узла', async () => {
  const doc = makeDoc2();
  doc.nodes.ab2.children.push('tbl');
  doc.nodes.tbl = {
    type: 'frame', id: 'tbl', name: 'Таблица проектов', parent: 'ab2', children: [],
    layout: { mode: 'column', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'stretch', justify: 'start', wrap: false },
    size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, radius: 16,
  };
  const engine = makeStubEngine();
  // таблица широкая, всё остальное — по 100
  const geo = { rects: { ...engine.solve(doc).rects, tbl: { x: 500, y: 40, w: 896, h: 260 } } };
  const provider = makePeekingProvider(
    { intent: 'edit', title: 'По ширине таблицы', summary: 'Ширина карточки равна ширине таблицы.', steps: ['Прочитать ширину'], targets: ['selection'] },
    (text) => {
      const line = text.split('\n').find((l) => l.includes('"Таблица проектов"'));
      const m = line && line.match(/→ (\d+)×/);
      return m ? { summary: 'по ширине', edits: [{ op: 'set', target: 'selection', path: 'size.w', value: m[1] }] } : null;
    },
  );
  const res = await runCommand({
    doc, selection: ['card'], utterance: 'выровняй карточку по ширине таблицы', provider, engine, geo, activeArtboardId: 'ab1',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [{ op: 'set', id: 'card', path: 'size.w', value: { mode: 'fixed', value: 896 } }]);
});

test('круг2 п.6: «назови все экраны одинаково» — правка по каждому артборду', async () => {
  const doc = makeDoc2();
  const engine = makeStubEngine();
  const provider = makePeekingProvider(
    { intent: 'edit', title: 'Переименовал экраны', summary: 'Единые имена артбордов.', steps: ['Переименовать'], targets: ['Маршрут дня', 'Сводка недели'] },
    (text) => (text.includes('"Маршрут дня"') && text.includes('"Сводка недели"')
      ? { summary: 'единые имена', edits: [
        { op: 'set', target: '#ab1', path: 'name', value: 'Экран · 1' },
        { op: 'set', target: '#ab2', path: 'name', value: 'Экран · 2' },
      ] }
      : null),
  );
  const res = await runCommand({
    doc, selection: [], utterance: 'назови все экраны одинаково', provider, engine, activeArtboardId: 'ab1',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['ab1', 'ab2']);
  assert.equal(res.preview.doc.nodes.ab1.name, 'Экран · 1');
  assert.equal(res.preview.doc.nodes.ab2.name, 'Экран · 2');
});

test('круг2 п.1: предел выжимки соблюдён на любой форме документа и любом бюджете', () => {
  const shapes = [{ depth: 2, breadth: 3 }, { depth: 4, breadth: 4 }, { depth: 3, breadth: 12 }, { depth: 40, breadth: 1 }, { depth: 2, breadth: 120 }];
  for (const shape of shapes) {
    const doc = { id: 'd', version: 1, root: 'p', nodes: { p: { type: 'page', id: 'p', name: 'Страница', parent: null, children: [] } }, tokens: {}, meta: {} };
    let n = 0;
    const grow = (parent, depth) => {
      if (!depth) return;
      for (let i = 0; i < shape.breadth; i++) {
        const id = `n${n++}`;
        doc.nodes[id] = {
          type: 'frame', id, name: `Узел с довольно длинным именем ${id}`, parent, children: [],
          layout: { mode: 'column', gap: 8, padding: { t: 8, r: 8, b: 8, l: 8 }, align: 'stretch', justify: 'start', wrap: false },
          size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
        };
        doc.nodes[parent].children.push(id);
        grow(id, depth - 1);
      }
    };
    grow('p', shape.depth);
    const ids = Object.keys(doc.nodes);
    for (const limit of [200, 900, 2000, 20000]) {
      for (const sel of [[], [ids[1]], [ids[ids.length - 1]], ['p'], ['нет-такого'], ids.slice(1, 5)]) {
        const d = describeDoc(doc, sel, { limit });
        assert.ok(d.length <= limit, `${JSON.stringify(shape)} limit=${limit} sel=${sel.length} → ${d.length}`);
      }
    }
  }
});

/* ══ Круг 3: адресация по типу узла, «ничего не изменилось», отмена голосом ═══ */

/** Документ вплотную к демо core.js: шапка с аватаром, список пунктов, кнопка-фрейм, второй экран с показателями. */
function makeDoc3() {
  const nodes = {};
  const L = (over = {}) => ({ mode: 'column', gap: 16, padding: { t: 16, r: 16, b: 16, l: 16 }, align: 'stretch', justify: 'start', wrap: false, ...over });
  const push = (n) => { nodes[n.id] = n; const p = nodes[n.parent]; if (p && p.children) p.children.push(n.id); return n.id; };
  const F = (id, name, parent, o = {}) => push({
    type: 'frame', id, name, parent, children: [], layout: L(o.layout || {}),
    size: o.size || { w: { mode: 'fill' }, h: { mode: 'hug' } },
    radius: o.radius == null ? 8 : o.radius,
    ...(o.fill ? { fill: o.fill } : {}), ...(o.pos ? { pos: o.pos } : {}),
  });
  const T = (id, name, parent, chars, style = 'body', color = null) => push({
    type: 'text', id, name, parent, characters: chars, style, align: 'left',
    size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, ...(color ? { color } : {}),
  });

  nodes.page = { type: 'page', id: 'page', name: 'Страница', parent: null, children: [] };
  F('screen', 'Маршрут дня', 'page', { size: { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } }, pos: { x: 0, y: 0 }, fill: 'bg', radius: 0 });
  F('head', 'Шапка', 'screen', { layout: { mode: 'row', gap: 12, align: 'center', justify: 'between' } });
  T('headTitle', 'Заголовок экрана', 'head', 'Маршрут дня', 'h1');
  push({
    type: 'ellipse', id: 'avatar', name: 'Аватар', parent: 'head', fill: 'muted', radius: 999,
    size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 40 } },
  });
  F('list', 'Список пунктов', 'screen', { layout: { mode: 'column', gap: 8 } });
  [['12:00', 'Обед с командой'], ['15:30', 'Ревью макетов'], ['18:40', 'Тренировка']].forEach(([time, title], i) => {
    F(`item${i}`, `Пункт · ${title}`, 'list', { layout: { mode: 'row', gap: 12, align: 'center' }, fill: 'bg', radius: 12 });
    T(`time${i}`, 'Время', `item${i}`, time, 'body', 'muted');
    T(`name${i}`, 'Название пункта', `item${i}`, title);
  });
  F('btn', 'Кнопка «Добавить пункт»', 'screen', { layout: { mode: 'row', gap: 8, align: 'center', justify: 'center' }, fill: 'accent', radius: 16 });
  T('btnText', 'Подпись кнопки', 'btn', 'Добавить пункт', 'body', 'bg');

  F('summary', 'Сводка недели', 'page', { size: { w: { mode: 'fixed', value: 960 }, h: { mode: 'hug' } }, pos: { x: 470, y: 0 }, fill: 'bg', radius: 0 });
  F('sumHead', 'Шапка сводки', 'summary', { layout: { mode: 'row', gap: 16, align: 'center' } });
  T('sumTitle', 'Заголовок сводки', 'sumHead', 'Сводка недели', 'h1');
  F('metrics', 'Показатели', 'summary', { layout: { mode: 'row', gap: 16, align: 'stretch' } });
  [['Задач закрыто', '48'], ['Средний цикл', '2,4 дня'], ['Правок от агента', '312']].forEach(([label, value], i) => {
    F(`m${i}`, `Показатель · ${label}`, 'metrics', { fill: 'bg', radius: 12 });
    T(`mLabel${i}`, 'Подпись показателя', `m${i}`, label, 'body', 'muted');
    T(`mValue${i}`, 'Значение показателя', `m${i}`, value, 'h1');
  });

  return {
    id: 'doc3', version: 1, root: 'page', nodes,
    tokens: {
      colors: { bg: '#ffffff', text: '#111111', muted: '#888888', accent: '#ff6b3d' },
      type: { h1: { fontSize: 32, fontWeight: 700, lineHeight: 1.2 }, h2: { fontSize: 24, fontWeight: 600, lineHeight: 1.3 }, body: { fontSize: 16, fontWeight: 400, lineHeight: 1.5 } },
      spacing: [4, 8, 12, 16, 24, 32, 48], radii: [0, 4, 8, 12, 16, 20],
    },
    meta: { name: 'Демо 3', createdAt: 0 },
  };
}

const PLAN_EDIT3 = { intent: 'edit', title: 'Поправил макет', summary: 'Точечная правка.', steps: ['Найти', 'Поправить'], targets: [] };

/* п.1 — путь сверяется с типом цели */

test('круг3 п.1: текстовый путь на фрейме уходит в его единственный текст (кнопка = фрейм + текст)', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'style', value: 'h2' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай кнопку жирнее', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [{ op: 'set', id: 'btnText', path: 'style', value: 'h2' }], 'правка ушла в текст внутри кнопки');
  assert.equal(res.preview.doc.nodes.btnText.style, 'h2');
  assert.ok(res.warnings.some((w) => /единственный текст/i.test(w)), res.warnings.join(' | '));
});

test('круг3 п.1: fill на тексте не применяется молча, а объясняется', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: {
      edits: [
        { op: 'set', target: 'Значение показателя', path: 'fill', value: 'accent' },
        { op: 'set', target: 'Показатель · Задач закрыто', path: 'radius', value: '20' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: ['m0'], utterance: 'сделай значение акцентным', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  // круг 20: 20 — шаг шкалы скруглений документа, число становится ссылкой на него
  assert.deepEqual(res.ops, [{ op: 'set', id: 'm0', path: 'radius', value: 'radii.5' }], 'заливка текста отброшена, остальное применено');
  const w = res.warnings.join(' | ');
  // круг 16, п.9: поле названо словами инспектора, «fill»/«color» человек не читает
  assert.match(w, /У текста «Значение показателя» нет заливки/, w);
  assert.match(w, /цвет текста/, 'подсказан правильный путь: ' + w);
  assert.ok(!/«fill»|«color»/.test(w), 'внутренних имён нет: ' + w);
});

test('круг3 п.1: путь без единственного текста не применяется, а объясняется по имени слоя', () => {
  const doc = makeDoc3();
  const seen = [];
  // в пункте два текста — молча править один из них нельзя
  assert.equal(adjustSetPath(doc, 'item0', 'characters', (m) => seen.push(m)), null);
  assert.match(seen.join(' '), /Пункт · Обед с командой/);
  assert.match(seen.join(' '), /текстовых слоёв — 2/);
  // у пустого фрейма текста нет вовсе
  doc.nodes.empty = { type: 'frame', id: 'empty', name: 'Пустой', parent: 'screen', children: [], layout: doc.nodes.head.layout, size: doc.nodes.head.size, radius: 0 };
  const seen2 = [];
  assert.equal(adjustSetPath(doc, 'empty', 'style', (m) => seen2.push(m)), null);
  assert.match(seen2.join(' '), /нет текста/);
  // align без единственного текста — это выравнивание содержимого
  const seen3 = [];
  assert.deepEqual(adjustSetPath(doc, 'item0', 'align', (m) => seen3.push(m)), { id: 'item0', path: 'layout.align' });
  // круг 16, п.9: человеку говорим «выравнивание содержимого», а не «layout.align»
  assert.match(seen3.join(' '), /выравнивание содержимого/);
  assert.ok(!/layout\.align/.test(seen3.join(' ')), seen3.join(' '));
});

test('круг3 п.1: правка, которая ничего не изменила, не рапортует «Готово»', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const same = { edits: [{ op: 'set', target: 'Показатель · Задач закрыто', path: 'radius', value: '12' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай у карточки скругление 12', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.ops.length, 'операции всё равно возвращаются');
  assert.ok(res.warnings.some((w) => /ни на что не повлияла/i.test(w)), res.warnings.join(' | '));
});

/* п.2 — нулевой размер блокирует */

test('круг3 п.2: zero-size запускает починку и остаётся понятным предупреждением', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine({
    violations: (d) => Object.values(d.nodes)
      .filter((n) => n.name === 'Карточка')
      .map((n) => ({ code: 'zero-size', nodeId: n.id, message: `«${n.name}»: нулевой размер (440×0)`, severity: 'warn' })),
  });
  const tree = { type: 'frame', name: 'Карточка', layout: { mode: 'row', gap: 8, wrap: true }, children: [{ type: 'text', name: 'Подпись', text: 'Итого 440 ₽', style: 'body' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Добавил карточку', summary: 'Карточка с итогом.', steps: ['Карточка'] },
    tree: [tree, tree],
  });
  const seen = [];
  const res = await runCommand({
    doc, selection: [], utterance: 'собери карточку с итогом', provider, engine,
    activeArtboardId: 'screen', onStage: (s) => seen.push(s.stage),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(seen.includes('repair'), 'нулевой размер обязан запускать починку');
  assert.ok(res.ops.length, 'если починить не вышло — результат всё равно применяется');
  const w = res.warnings.join(' | ');
  assert.match(w, /Карточка/, 'имя слоя в предупреждении: ' + w);
  assert.match(w, /не виден/, w);
  assert.ok(!/#f\d/.test(w.replace(/«[^»]*»/g, '')), 'без технических id: ' + w);
});

/* п.3 — «добавь X в Y» кладёт X именно в Y */

test('круг3 п.3: контейнер из команды находится на разных формулировках', () => {
  const doc = makeDoc3();
  const scope = resolveScope(doc, [], null, { activeArtboardId: 'screen' });
  const at = (u) => findInsertTarget(doc, u, scope, null);
  assert.equal(at('добавь в список пункт на 20:00').parentId, 'list');
  assert.equal(at('добавь в шапку кнопку выхода').parentId, 'head');
  const under = at('добавь под заголовком плашку с датой');
  assert.equal(under.parentId, 'head', 'плашка встаёт на уровень заголовка');
  assert.equal(under.index, 1, 'сразу после заголовка');
  assert.equal(at('добавь снизу экрана панель').parentId, 'screen');
  assert.equal(at('добавь сверху полоску').index, 0);
  const near = at('добавь ещё одну карточку рядом с показателем «Средний цикл»');
  assert.equal(near.parentId, 'metrics', 'рядом с показателем — внутрь «Показатели»');
  assert.equal(at('собери новый экран оплаты'), null, 'без глагола добавления вставки нет');
  assert.equal(at('добавь пункт'), null, 'место не названо — решает область по умолчанию');
});

test('круг3 п.3: «добавь в список пункт» кладёт узел в список и через дерево, и через патч', async () => {
  const engine = makeStubEngine();
  const node = { type: 'frame', name: 'Пункт · Ужин', layout: { mode: 'row', gap: 12 }, children: [{ type: 'text', name: 'Время', text: '20:00', style: 'body' }] };

  const viaTree = await runCommand({
    doc: makeDoc3(), selection: [], utterance: 'добавь в список пункт на 20:00', engine, activeArtboardId: 'screen',
    provider: makeFakeProvider({ plan: { intent: 'create', title: 'Добавил пункт', summary: 'Пункт на 20:00.', steps: ['Пункт'] }, tree: node }),
  });
  assert.equal(viaTree.error, undefined, JSON.stringify(viaTree.error));
  assert.equal(viaTree.ops[0].node.parent, 'list', 'дерево легло в «Список пунктов»');
  assert.equal(viaTree.ops[0].node.pos, undefined, 'это не артборд');

  const viaPatch = await runCommand({
    doc: makeDoc3(), selection: [], utterance: 'добавь в список пункт на 20:00', engine, activeArtboardId: 'screen',
    provider: makeFakeProvider({ plan: PLAN_EDIT3, patch: { edits: [{ op: 'create', target: 'selection', node }] } }),
  });
  assert.equal(viaPatch.error, undefined, JSON.stringify(viaPatch.error));
  assert.equal(viaPatch.ops[0].node.parent, 'list', 'патч без parent тоже лёг в список');
  assert.equal(viaPatch.preview.doc.nodes.list.children.length, 4);
});

test('круг3 п.3: локальный классификатор больше не ставит create на любое «добавь»', () => {
  assert.equal(classifyUtterance('добавь в список пункт на 20:00').intent, 'edit');
  assert.equal(classifyUtterance('добавь под заголовком плашку').intent, 'edit');
  assert.equal(classifyUtterance('добавь новый экран оплаты').intent, 'create');
  assert.equal(classifyUtterance('добавь карточку тарифа').intent, 'create', 'без места — по-прежнему создание');
});

/* п.4 — групповая правка */

test('круг3 п.4: «во всех карточках показателей» правит все три, а не самую короткую по имени', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Показатель', path: 'radius', value: '20' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'во всех карточках показателей скругление 20', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['m0', 'm1', 'm2']);
  assert.ok(res.warnings.some((w) => /подходит слоёв — 3/.test(w)), res.warnings.join(' | '));
});

test('круг3 п.4: одиночная формулировка правит один узел, но говорит о кандидатах', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Показатель', path: 'radius', value: '20' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай у карточки показателя скругление 20', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['m0'], 'первый в порядке документа, а не самый короткий по имени');
  const w = res.warnings.join(' | ');
  assert.match(w, /подходит слоёв — 3/);
  assert.match(w, /во всех/, 'человеку сказано, как поправить все: ' + w);
  assert.equal(looksGroupWide('сделай у карточки показателя скругление 20'), false);
});

/* п.5 — агент видит замечания валидатора ДО правки */

test('круг3 п.5: замечания проверки попадают в шапку контекста для ask/edit/theme', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine({
    violations: () => [
      { code: 'low-contrast', nodeId: 'mLabel0', message: 'контраст 2.10:1 при норме 4.5:1 (#888888 на #ffffff)', severity: 'warn' },
      { code: 'zero-size', nodeId: 'm1', message: '«Показатель · Средний цикл»: нулевой размер (440×0)', severity: 'warn' },
      { code: 'off-scale', nodeId: 'list', message: 'вне шкалы отступов: gap 10', severity: 'info' },
    ],
  });
  const provider = makeFakeProvider({
    plan: { intent: 'ask', title: 'Ответил про макет', summary: 'Проверка.', steps: ['Ответить'] },
    answer: { answer: 'Низкий контраст подписи и нулевая высота карточки.' },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'проверь макет, что не так?', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const sys = provider.calls.map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
  assert.match(sys, /ЗАМЕЧАНИЯ ПРОВЕРКИ \(до правки\)/);
  assert.match(sys, /Плохо читается текст «Подпись показателя»: контраст 2\.10:1 при норме 4\.5:1/);
  assert.match(sys, /Слой «Показатель · Средний цикл» не виден/);
  assert.ok(!/«Показатель · Средний цикл»: «Показатель/.test(sys), 'имя слоя не печатается дважды');

  const created = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал экран', summary: 'Новый экран.', steps: ['Экран'] },
    tree: { type: 'frame', name: 'Экран', size: { w: 390, h: 'hug' }, children: [{ type: 'text', name: 'Заголовок', text: 'Оплата', style: 'h1' }] },
  });
  await runCommand({ doc, selection: [], utterance: 'собери новый экран оплаты', provider: created, engine });
  const sysCreate = created.calls.map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
  assert.ok(!/ЗАМЕЧАНИЯ ПРОВЕРКИ/.test(sysCreate), 'при создании нового экрана старые замечания не нужны');
});

test('круг3 п.5: сводка замечаний схлопывает однотипные', () => {
  const doc = makeDoc3();
  const list = ['m0', 'm1', 'm2', 'mLabel0', 'mLabel1'].map((id) => ({
    code: 'low-contrast', nodeId: id, severity: 'warn', message: 'контраст 2.00:1 при норме 4.5:1',
  }));
  const text = describeViolations(list, doc);
  assert.equal(text.split('\n').length, 4, text);
  assert.match(text, /и ещё 2 замечани/);
  assert.equal(describeViolations([], doc), '');
});

/* п.6 — относительный сдвиг */

test('круг3 п.6: «сдвинь аватар на 10 пикселей влево» считается от текущего прямоугольника', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const geo = engine.solve(doc);
  const provider = makeFakeProvider({
    plan: { intent: 'edit', title: 'Сдвинул аватар', summary: 'Сдвиг влево.', steps: ['Сдвиг'] },
    patch: { edits: [{ op: 'nudge', target: 'Аватар', dx: -10, dy: 0 }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сдвинь аватар на 10 пикселей влево', provider, engine, geo, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  const op = res.ops[0];
  assert.equal(op.op, 'set');
  assert.equal(op.id, 'avatar');
  assert.equal(op.path, 'override');
  const r = geo.rects.avatar, pr = geo.rects.head;
  assert.deepEqual(op.value, { x: r.x - pr.x - 10, y: r.y - pr.y, w: r.w, h: r.h }, 'смещение относительно родителя, а не холста');
  assert.ok(res.warnings.some((w) => /влево/.test(w) && /отсоединён/.test(w)), res.warnings.join(' | '));
});

test('круг3 п.6: артборд сдвигается через pos, координаты напрямую модель задать не может', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: {
      edits: [
        { op: 'nudge', target: 'Сводка недели', dx: -20, dy: 5 },
        { op: 'set', target: 'Аватар', path: 'pos', value: '{"x":330,"y":30}' },
        { op: 'set', target: 'Аватар', path: 'override', value: '{"x":1,"y":2}' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сдвинь сводку левее', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [{ op: 'set', id: 'summary', path: 'pos', value: { x: 450, y: 5 } }]);
  const w = res.warnings.join(' | ');
  assert.match(w, /Задать положение напрямую/);
  assert.ok(!ALLOWED_PATH_HEADS.has('pos') && !ALLOWED_PATH_HEADS.has('override'), 'координаты закрыты в белом списке');
  assert.match(PROMPTS.patch({ tokens: '', digest: '', scopeLabel: '', placement: '' }), /nudge/);
});

/* п.7 — зажимы вместо потерянной команды */

test('круг3 п.7: padding -12 и размер 500000 зажимаются, команда не пропадает', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал блок', summary: 'Блок с текстом.', steps: ['Блок'] },
    tree: {
      type: 'frame', name: 'Блок', layout: { mode: 'column', gap: -8, padding: [-12, 500000] },
      size: { w: 500000, h: -20 },
      children: [{ type: 'text', name: 'Строка', text: 'Всё на месте', style: 'body' }],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'собери блок с текстом', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const root = res.ops[0].node;
  /* Круг 20 (SPEC §6.6): зажатый ноль остаётся нулём («без отступа» — не число мимо шкалы), а
   * зажатые 100000 — число, которого человек не называл, мимо шкалы: приводится к ближайшему
   * шагу (48 = spacing.6), и об этом сказано. Команда всё равно не пропадает. */
  assert.deepEqual(root.layout.padding, { t: 0, r: 'spacing.6', b: 0, l: 'spacing.6' });
  assert.equal(root.layout.gap, 0);
  assert.ok(res.warnings.some((w) => /100000 — мимо шкалы отступов, взял ближайший шаг 48/.test(w)), res.warnings.join(' | '));
  assert.deepEqual(root.size.w, { mode: 'fixed', value: 100000 });
  assert.deepEqual(root.size.h, { mode: 'hug' }, 'фиксированный нулевой размер — всегда невидимый слой, лучше «по содержимому»');
  assert.equal(clampPx(-12), 0);
  assert.equal(clampPx(500000), 100000);
  // круг 9, п.2: значение без числа больше не становится нулём — правку пропускают со словами
  assert.equal(clampPx('не число'), undefined);
  assert.equal(coerceValue('-30', 'layout.gap'), 0);
  assert.equal(coerceValue('900000', 'radius'), 100000);           // без документа шкалы нет — число как есть
});

/* п.8 — поток модели не копится в stages */

test('круг3 п.8: partial не копится в stages', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const answer = JSON.stringify({ edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h2' }] });
  const provider = {
    name: 'stream', kind: 'fake', async ready() { return true; },
    async complete(messages, schema, opts = {}) {
      const value = schema.name === 'plan' ? PLAN_EDIT3 : JSON.parse(answer);
      if (opts.onText) for (let i = 1; i <= answer.length; i++) opts.onText(answer.slice(0, i), answer[i - 1]);
      return value;
    },
  };
  const seen = [];
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок меньше', provider, engine, activeArtboardId: 'screen', onStage: (s) => seen.push(s) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.stages.length <= 8, `в истории стадий ${res.stages.length} записей`);
  assert.ok(res.stages.every((s) => s.partial === undefined), 'ни одна запись не тащит текст ответа');
  assert.ok(seen.some((s) => s.partial), 'в ленту интерфейса поток всё-таки уходит');
  const bytes = JSON.stringify(res.stages).length;
  assert.ok(bytes < 4000, `stages весят ${bytes} знаков`);
});

/* п.10 — формулировка про цель вне области */

test('круг3 п.10: предупреждение о цели вне области называет экран, а не повторяет имя', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'fill', value: 'accent' }] },
  });
  const res = await runCommand({ doc, selection: ['m0'], utterance: 'перекрась кнопку', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.find((x) => /вне выделения/.test(x)) || '';
  assert.match(w, /на экране «Маршрут дня»/, w);
  assert.equal(w.match(/Кнопка «Добавить пункт»/g).length, 1, 'имя слоя не повторяется дважды: ' + w);
});

/* п.11 — src фильтруется на входе */

test('круг3 п.11: небезопасный src не попадает в документ', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Добавил картинку', summary: 'Картинка.', steps: ['Картинка'] },
    tree: {
      type: 'frame', name: 'Галерея', layout: { mode: 'row', gap: 8 },
      children: [
        { type: 'image', name: 'Плохая', src: 'javascript:alert(1)' },
        { type: 'image', name: 'Тоже плохая', src: 'data:text/html;base64,PHNjcmlwdD4=' },
        { type: 'image', name: 'Хорошая', src: 'https://example.com/a.png' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'добавь галерею из трёх картинок', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const images = res.ops.filter((o) => o.node.type === 'image').map((o) => o.node);
  assert.equal(images.length, 3);
  assert.equal(images[0].src, undefined);
  assert.equal(images[1].src, undefined);
  assert.equal(images[2].src, 'https://example.com/a.png');
  assert.ok(res.warnings.some((w) => /не похож на картинку/.test(w)), res.warnings.join(' | '));
  assert.equal(safeSrc('data:image/png;base64,iVBOR', () => {}), 'data:image/png;base64,iVBOR');
});

/* Новое в контракте: action — отмена и возврат делает оболочка */

test('круг3 контракт: «отмени» возвращает action undo и не трогает модель', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  let calls = 0;
  const provider = {
    name: 'never', kind: 'fake', async ready() { return true; },
    async complete() { calls++; throw new BrainError('model', 'модель не должна была понадобиться'); },
  };
  for (const u of ['отмени', 'Отмени, пожалуйста!', 'верни как было', 'назад', 'не так', 'откати последнюю правку']) {
    const res = await runCommand({ doc, selection: [], utterance: u, provider, engine });
    assert.equal(res.error, undefined, `${u}: ${JSON.stringify(res.error)}`);
    assert.equal(res.action, 'undo', u);
    assert.deepEqual(res.ops, [], u);
    assert.ok(res.plan && res.plan.title, 'есть что показать человеку');
    assert.ok(res.preview && res.preview.doc === doc, 'документ не меняется');
    assert.equal(res.stages.at(-1).stage, 'done');
  }
  for (const u of ['вернуть', 'верни отменённое', 'вперёд', 'отмени отмену']) {
    const res = await runCommand({ doc, selection: [], utterance: u, provider, engine });
    assert.equal(res.action, 'redo', u);
  }
  assert.equal(calls, 0, 'к модели не обращались ни разу');
});

test('круг3 контракт: похожие по словам правки уходят в модель, а не в отмену', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'color', value: 'muted' }] },
  });
  assert.equal(recognizeAction('поменяй обратно цвет кнопки'), null);
  assert.equal(recognizeAction('верни заголовок на место'), null);
  assert.equal(recognizeAction('отмени скидку в подписи'), null);
  const res = await runCommand({ doc, selection: [], utterance: 'поменяй обратно цвет кнопки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.action, undefined, 'это обычная правка');
  assert.ok(res.ops.length);
});

test('круг3 контракт: промпт больше не обещает того, чего нет', () => {
  const ctx = { tokens: '', digest: '', scopeLabel: 'весь документ', history: '1. «синее» → сделал' };
  const planner = PROMPTS.planner(ctx);
  assert.ok(!/верни как было/.test(planner), 'обещание отката из промпта убрано');
  assert.match(planner, /ПРЕДЫДУЩИЕ КОМАНДЫ/);
});

test('круг3 п.12: длительность для человека, а не «за 0 с»', () => {
  assert.equal(fmtDuration(200), '200 мс');
  assert.equal(fmtDuration(1500), '1.5 с');
  assert.equal(fmtDuration(120000), '120 с');
  assert.equal(fmtDuration(0), '1 мс');
});

test('круг3: refCandidates отдаёт всех кандидатов и способ поиска', () => {
  const doc = makeDoc3();
  const scope = resolveScope(doc, ['summary'], null);
  const partial = refCandidates(null, doc, 'Показатель', scope);
  assert.deepEqual(partial.ids, ['m0', 'm1', 'm2']);
  assert.equal(partial.how, 'partial');
  assert.equal(partial.inScope, true);
  const exact = refCandidates(null, doc, 'Показатели', scope);
  assert.deepEqual(exact.ids, ['metrics']);
  assert.equal(exact.how, 'exact');
  const outside = refCandidates(null, doc, 'Аватар', scope);
  assert.deepEqual(outside.ids, ['avatar']);
  assert.equal(outside.inScope, false);
  assert.deepEqual(refCandidates(null, doc, 'нет такого', scope).ids, []);
  assert.deepEqual(textDescendants(doc, 'btn'), ['btnText']);
  assert.deepEqual(textDescendants(doc, 'item0'), ['time0', 'name0']);
});

test('круг3 контракт: runVariants не гоняет модель за отменой', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  let calls = 0;
  const provider = { name: 'never', kind: 'fake', async ready() { return true; }, async complete() { calls++; throw new BrainError('model', 'не должно'); } };
  const list = await runVariants({ doc, selection: [], utterance: 'верни как было', provider, engine, n: 3 });
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'undo');
  assert.deepEqual(list[0].ops, []);
  assert.equal(calls, 0);
});

/* ── 14. Круг 5: колонки одноимённых слоёв, свежие узлы, варианты голосом ──── */

/** Документ демо: у «Времени», «Статуса», «Подписи показателя» имя общее с соседями. */
function makeDoc5() {
  const doc = makeDoc3();
  const L = (over = {}) => ({ mode: 'column', gap: 16, padding: { t: 12, r: 16, b: 12, l: 16 }, align: 'stretch', justify: 'start', wrap: false, ...over });
  const push = (n) => { doc.nodes[n.id] = n; const p = doc.nodes[n.parent]; if (p && p.children) p.children.push(n.id); return n.id; };
  push({
    type: 'frame', id: 'table', name: 'Таблица проектов', parent: 'summary', children: [],
    layout: L({ mode: 'column', gap: 0 }), size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, radius: 16,
  });
  [['Проект', 'Статус', 'Владелец', 'Срок'], ['Редактор макетов', 'в работе', 'Аня', '26 сен'],
    ['Голосовой ввод', 'на ревью', 'Пётр', '27 сен'], ['Экспорт в SVG', 'готово', 'Лиза', '24 сен'],
    ['Библиотека токенов', 'в плане', 'Марк', '1 окт']].forEach((cells, i) => {
    const rid = push({
      type: 'frame', id: `row${i}`, name: i === 0 ? 'Заголовок таблицы' : `Строка · ${cells[0]}`, parent: 'table',
      children: [], layout: L({ mode: 'row', gap: 16, align: 'center' }), size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, radius: 0,
    });
    ['Проект', 'Статус', 'Владелец', 'Срок'].forEach((nm, j) => push({
      type: 'text', id: `c${i}_${j}`, name: nm, parent: rid, characters: cells[j], style: 'body', align: 'left',
      size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    }));
  });
  // «Место» лежит глубже: Пункт → Текст пункта → Место (проверка конгруэнтных цепочек)
  [0, 1, 2].forEach((i) => {
    const col = push({
      type: 'frame', id: `col${i}`, name: 'Текст пункта', parent: `item${i}`, children: [],
      layout: L({ mode: 'column', gap: 2 }), size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, radius: 0,
    });
    push({
      type: 'text', id: `place${i}`, name: 'Место', parent: col, characters: `место ${i}`, style: 'body',
      align: 'left', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
    });
  });
  return doc;
}

/* п.1 — точное совпадение имени у нескольких узлов */

test('круг5 п.1: «выровняй время по правому краю» правит все три «Времени» и говорит об этом', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Время', path: 'align', value: 'right' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'выровняй время по правому краю', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['time0', 'time1', 'time2'], 'колонка поправлена целиком');
  const w = res.warnings.join(' | ');
  assert.match(w, /подходит слоёв — 3/, w);
  assert.match(w, /все/, w);
});

test('круг5 п.1: «сделай статусы серыми» красит всю колонку таблицы (5 строк)', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Статус', path: 'color', value: 'muted' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай статусы серыми', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['c0_1', 'c1_1', 'c2_1', 'c3_1', 'c4_1']);
  assert.match(res.warnings.join(' | '), /подходит слоёв — 5/);
});

test('круг5 п.1: колонка узнаётся и на глубине («Место» внутри «Текста пункта»)', () => {
  const doc = makeDoc5();
  assert.equal(looksUniformColumn(doc, ['place0', 'place1', 'place2']), true);
  assert.equal(looksUniformColumn(doc, ['time0', 'time1', 'time2']), true);
  assert.equal(looksUniformColumn(doc, ['c0_1', 'c1_1', 'c2_1', 'c3_1', 'c4_1']), true);
  // разные имена и разные роли — не колонка
  assert.equal(looksUniformColumn(doc, ['headTitle', 'sumTitle']), false);
  assert.equal(looksUniformColumn(doc, ['time0', 'name0']), false);
  assert.equal(looksUniformColumn(doc, ['time0']), false);
  assert.equal(looksUniformColumn(doc, ['item0', 'c1_1']), false);
});

test('круг5 п.1: содержимое оптом не переписывается — правится один узел и звучит подсказка', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Время', path: 'characters', value: '09:00' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'напиши во времени 09:00', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['time0'], 'текст — вещь личная, оптом не меняем');
  const w = res.warnings.join(' | ');
  assert.match(w, /подходит слоёв — 3/, w);
  assert.match(w, /во всех/, 'подсказка есть и при точном совпадении: ' + w);
});

test('круг5 п.1: выделение — выход из групповой правки', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Время', path: 'align', value: 'right' }] },
  });
  const res = await runCommand({ doc, selection: ['item1'], utterance: 'выровняй время по правому краю', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['time1'], 'в выделенном пункте «Время» ровно одно');
});

/* п.2 — свежесозданный узел не перебивает существующий */

test('круг5 п.2: remove по одноимённому узлу берёт существующий, а не созданный этим же патчем', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: {
      edits: [
        { op: 'create', parent: 'Маршрут дня', node: { type: 'frame', name: 'Кнопка «Добавить пункт»', children: [{ type: 'text', name: 'Подпись новой кнопки', text: 'Добавить' }] } },
        { op: 'remove', target: 'Кнопка «Добавить пункт»' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'замени кнопку на две, одна из них та же', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const removed = res.ops.filter((o) => o.op === 'remove').map((o) => o.id);
  assert.deepEqual(removed, ['btn'], 'удалена старая кнопка, а не только что созданная');
  assert.equal(res.preview.doc.nodes.btn, undefined, 'старой кнопки на экране больше нет');
  assert.match(res.warnings.join(' | '), /существующ/i);
});

test('круг5 п.2: move.target тоже предпочитает существующий узел, а move.parent — созданный', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: {
      edits: [
        { op: 'create', parent: 'Маршрут дня', node: { type: 'frame', name: 'Обёртка', children: [] } },
        { op: 'create', parent: 'Обёртка', node: { type: 'frame', name: 'Шапка', children: [] } },
        { op: 'move', target: 'Шапка', parent: 'Обёртка' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'оберни шапку в контейнер', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const move = res.ops.find((o) => o.op === 'move');
  assert.equal(move.id, 'head', 'переносим существующую «Шапку»');
  assert.equal(res.preview.doc.nodes.head.parent, move.parent);
  assert.equal(res.preview.doc.nodes[move.parent].name, 'Обёртка', 'а родитель — только что созданный');
});

/* п.3 — варианты голосом */

test('круг5 п.3: «покажи три варианта» распознаётся локально, без модели', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  let calls = 0;
  const provider = { name: 'never', kind: 'fake', async ready() { return true; }, async complete() { calls++; throw new BrainError('model', 'не должно'); } };
  const res = await runCommand({ doc, selection: [], utterance: 'покажи три варианта', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.action, 'variants');
  assert.equal(res.variantsOf, '');
  assert.deepEqual(res.ops, []);
  assert.equal(calls, 0, 'модель не звали');
  assert.equal(res.plan.intent, 'variants');
  assert.ok(res.preview && res.preview.doc && res.preview.geo, 'превью — текущий документ');
  assert.equal(res.error, undefined);
});

test('круг5 п.3: «три варианта: <команда>» отдаёт команду в variantsOf', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = { name: 'never', kind: 'fake', async ready() { return true; }, async complete() { throw new BrainError('model', 'не должно'); } };
  const res = await runCommand({ doc, selection: [], utterance: 'три варианта: сделай шапку компактнее', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.action, 'variants');
  assert.equal(res.variantsOf, 'сделай шапку компактнее');
});

test('круг5 п.3: распознавание вариантов консервативно', () => {
  assert.deepEqual(recognizeVariants('покажи три варианта'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('дай варианты'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('а если иначе'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('по-другому'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('ещё варианты'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('покажи ещё три варианта'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('варианты этого же'), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('три варианта: сделай шапку компактнее'), { variantsOf: 'сделай шапку компактнее' });
  assert.deepEqual(recognizeVariants('покажи 3 варианта сделай кнопку шире'), { variantsOf: 'сделай кнопку шире' });
  // не перехватываем содержательные команды про «вариант»
  assert.equal(recognizeVariants('добавь вариант оплаты картой'), null);
  assert.equal(recognizeVariants('в этом варианте поменяй цвет кнопки'), null);
  assert.equal(recognizeVariants('сколько вариантов у кнопки?'), null);
  assert.equal(recognizeVariants('покажи варианты оплаты'), null);
  assert.equal(recognizeVariants('напиши в подписи «вариант Б»'), null);
  assert.equal(recognizeVariants(''), null);
  assert.equal(recognizeVariants('отмени'), null, 'отмена остаётся отменой');
});

test('круг5 п.3: runVariants берёт команду из «три варианта: …»', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const seen = [];
  const provider = makeFakeProvider({
    plan: () => { return PLAN_EDIT3; },
    patch: ({ messages }) => {
      seen.push(messages[1].content);
      return { edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '4' }] };
    },
  });
  const list = await runVariants({ doc, selection: [], utterance: 'три варианта: сделай шапку компактнее', provider, engine, n: 2, activeArtboardId: 'screen' });
  assert.equal(list.length, 2);
  assert.ok(seen.every((t) => /сделай шапку компактнее/.test(t) && !/три варианта/.test(t)), seen.join(' || '));
});

/* п.4 — «источник взят там» при копировании и переносе */

test('круг5 п.4: «повтори шапку со второго экрана» — про источник, а не «правка ушла туда»', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'duplicate', target: 'Шапка сводки', parent: 'Маршрут дня', index: 0 }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'повтори шапку со второго экрана', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /источник взят/, w);
  assert.ok(!/правка ушла/.test(w), 'копия легла сюда, а не «туда»: ' + w);
});

/* п.5 — порядок предупреждений */

test('круг5 п.5: содержательные предупреждения идут раньше служебных', () => {
  const list = [
    'Починка не помогла — оставил первый вариант',
    'Проверка макета: контраст 2.10:1 при норме 4.5:1',
    'Слой «Шапка сводки» найден вне активной области — на экране «Сводка недели»; источник взят оттуда',
    'Первый ответ модели пришлось чинить',
    'Правка color: неизвестный цвет «буряковый» — пропущен',
  ];
  const sorted = sortWarnings(list);
  // круг 9, п.9: «правка пропущена» теперь ВЫШЕ «нашлось вне области» — это разные ранги
  assert.match(sorted[0], /буряковый/);
  assert.match(sorted[1], /найден вне/);
  assert.match(sorted[2], /Проверка макета/);
  assert.match(sorted[3], /Починка|Первый ответ/);
  assert.match(sorted[4], /Починка|Первый ответ/);
});

/* п.6 — служебные имена токенов */

test('круг5 п.6: colors.__proto__ и type.constructor отбрасываются, исправная правка доходит', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Затемнил', summary: 'Тёмная тема.', steps: ['Цвета'], targets: [] },
    theme: {
      colors: [{ name: '__proto__', value: '#000000' }, { name: 'constructor', value: '#010101' }, { name: 'bg', value: '#101418' }],
      type: [{ name: 'constructor', fontSize: 20 }, { name: 'body', fontSize: 15, lineHeight: 22 }],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай тёмную тему', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.path), ['colors.bg', 'type.body'], 'служебные имена отброшены, транзакция цела');
  assert.match(res.warnings.join(' | '), /служебн/i);
});

/* п.7 — предел длины текста */

test('круг5 п.7: текст обрезается по пределу и при создании, и при правке', () => {
  const doc = makeDoc5();
  const warns = [];
  const spec = normalizeTree({ type: 'text', name: 'Огромный', text: 'я'.repeat(300000) }, { doc, warn: (m) => warns.push(m) });
  assert.equal(spec.characters.length, MAX_CHARS);
  assert.ok(warns.some((w) => /обрез/i.test(w)), warns.join(' | '));
  const v = coerceValue('ю'.repeat(9000), 'characters', doc, (m) => warns.push(m));
  assert.equal(v.length, MAX_CHARS);
  assert.equal(coerceValue('коротко', 'characters', doc, () => {}), 'коротко');
});

/* п.8 — у копии отличимое имя */

test('круг5 п.8: «продублируй пункт про тренировку» даёт копии своё имя', async () => {
  const doc = makeDoc5();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'duplicate', target: 'Пункт · Тренировка' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'продублируй пункт про тренировку', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const root = res.ops[0].node;
  assert.equal(root.name, 'Пункт · Тренировка (копия)');
  const names = Object.values(res.preview.doc.nodes).map((n) => n.name);
  assert.equal(names.filter((n) => n === 'Пункт · Тренировка').length, 1, 'одноимённых пунктов не завелось');
});

/* п.9 — словарь глаголов правки */

test('круг5 п.9: «мельче», «поуже», «воздушнее» — это правка, а не создание', () => {
  for (const s of ['сделай подписи мельче', 'мельче', 'поуже', 'пониже', 'воздушнее', 'плотнее',
    'просторнее', 'сделай карточку поуже', 'сделай шапку воздушнее', 'покрупнее', 'потоньше']) {
    assert.equal(classifyUtterance(s).intent, 'edit', s);
  }
  assert.equal(classifyUtterance('собери экран тарифов').intent, 'create');
  assert.equal(classifyUtterance('создай карточку').intent, 'create');
});

/* п.10 — placement виден и редактору */

test('круг5 п.10: промпт правок показывает вычисленное «куда класть»', () => {
  const place = 'кладу в «Строка статуса», позиция 2';
  const patch = PROMPTS.patch({ tokens: '', digest: '', scopeLabel: 'активный артборд', placement: place });
  assert.match(patch, /Строка статуса/);
  assert.match(patch, /КУДА КЛАДЁМ НОВОЕ/);
  assert.ok(!/Строка статуса/.test(PROMPTS.patch({ tokens: '', digest: '', scopeLabel: 'x', placement: '' })));
});

/* п.11 — lineHeight в выжимке токенов */

test('круг5 п.11: выжимка токенов показывает интерлиньяж, а промпт темы — его единицы', () => {
  const doc = makeDoc5();
  doc.tokens.type.caption = { fontSize: 13, fontWeight: 400, lineHeight: 18 };
  const t = describeTokens(doc);
  assert.match(t, /caption\(13\/400\/18\)/, t);
  assert.match(PROMPTS.theme({ tokens: t, digest: '', scopeLabel: 'x' }), /lineHeight.*пиксел/i);
});

/* п.12 — мелочи */

test('круг5 п.12: svg из ответа модели со скриптом не попадает в документ', () => {
  const warns = [];
  const push = (m) => warns.push(m);
  assert.equal(safeSrc('data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E', push), undefined);
  assert.equal(safeSrc('data:image/svg+xml;base64,' + Buffer.from('<svg onload="x()"></svg>').toString('base64'), push), undefined);
  assert.ok(warns.length >= 2, warns.join(' | '));
  const plain = 'data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2010%2010%22%3E%3Crect%2F%3E%3C%2Fsvg%3E';
  assert.equal(safeSrc(plain, () => {}), plain, 'обычная картинка проходит');
  assert.equal(safeSrc('data:image/png;base64,iVBOR', () => {}), 'data:image/png;base64,iVBOR');
});

/* ══ Круг 7: честная подстановка значений, место вставки, «на экране не сдвинулось» ═══════ */

/**
 * Документ с СЛУЖЕБНОЙ ОБЁРТКОЙ, как в демо core.js: «Шапка» (строка) → «Дата и заголовок»
 * (колонка по содержимому, уже экрана) → «Дата» и «Заголовок экрана». Именно на такой обёртке
 * ломалось «добавь под заголовком плашку с погодой».
 */
function makeDoc7() {
  const doc = makeDoc5();
  const L = (over = {}) => ({ mode: 'column', gap: 4, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'stretch', justify: 'start', wrap: false, ...over });
  doc.nodes.headCol = {
    type: 'frame', id: 'headCol', name: 'Дата и заголовок', parent: 'head', children: ['headDate', 'headTitle'],
    layout: L(), size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, radius: 0,
  };
  doc.nodes.headDate = {
    type: 'text', id: 'headDate', name: 'Дата', parent: 'headCol', characters: 'вторник, 23 сентября',
    style: 'body', color: 'muted', align: 'left', size: { w: { mode: 'hug' }, h: { mode: 'hug' } },
  };
  doc.nodes.headTitle.parent = 'headCol';
  doc.nodes.headTitle.size = { w: { mode: 'hug' }, h: { mode: 'hug' } };
  doc.nodes.head.children = ['headCol', 'avatar'];
  return doc;
}

/** Посчитанная геометрия: экран 390, шапка 350, обёртка 153 — как на демо. */
function geo7(doc) {
  const w = {
    screen: 390, head: 350, headCol: 153, headDate: 153, headTitle: 153, avatar: 40,
    list: 350, btn: 350, summary: 960, metrics: 896, table: 896,
  };
  const rects = {};
  Object.keys(doc.nodes).forEach((id, i) => {
    rects[id] = { x: 0, y: i * 20, w: w[id] == null ? 300 : w[id], h: 20 };
  });
  return { rects, lines: {}, order: Object.keys(doc.nodes) };
}

/* п.1 — значение вне перечисления не подменяется молча */

test('круг7 п.1: значение вне перечисления пропускается с объяснением, синоним — с предупреждением', () => {
  const doc = makeDoc7();
  const w = [];
  const note = (m) => w.push(m);
  // очевидные синонимы CSS подставляются, но об этом говорят словами
  assert.equal(coerceValue('space-between', 'layout.justify', doc, note), 'between');
  assert.equal(coerceValue('flex-start', 'layout.align', doc, note), 'start');
  assert.equal(coerceValue('horizontal', 'layout.mode', doc, note), 'row');
  assert.equal(coerceValue('start', 'align', doc, note), 'left');
  assert.ok(w.length >= 4, w.join(' | '));
  assert.ok(w.every((m) => /понял как/.test(m)), w.join(' | '));

  // а вот это — не синонимы: правка пропускается, «column»/«stretch»/«start» не подставляются
  const w2 = [];
  const note2 = (m) => w2.push(m);
  assert.equal(coerceValue('grid', 'layout.mode', doc, note2), undefined);
  assert.equal(coerceValue('baseline', 'layout.align', doc, note2), undefined);
  assert.equal(coerceValue('space-around', 'layout.justify', doc, note2), undefined);
  assert.equal(coerceValue('justify', 'align', doc, note2), undefined);
  assert.equal(coerceValue('наискосок', 'layout.mode', doc, note2), undefined);
  assert.equal(w2.length, 5, w2.join(' | '));
  assert.ok(w2.every((m) => /пропущена/.test(m)), w2.join(' | '));
  // круг 16, п.9: подсказка объясняет ЧЕМ собрать сетку, но без внутренних имён полей
  assert.match(w2.join(' | '), /строкой с переносом/, 'про сетку сказано, чем её собрать: ' + w2.join(' | '));
  assert.ok(!/layout\.|\bwrap\b|"row"/.test(w2.join(' | ')), 'внутренних имён в подсказке нет: ' + w2.join(' | '));
});

test('круг7 п.1: «justify: space-between» на шапке применяется как between и объясняется', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Шапка', path: 'layout.justify', value: 'space-between' }] },
  });
  const res = await runCommand({ doc, selection: ['head'], utterance: 'раздвинь блоки в шапке по краям', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [{ op: 'set', id: 'head', path: 'layout.justify', value: 'between' }]);
  // круг 16, п.9: чужое слово из CSS показываем как есть, своё значение — по-русски
  assert.match(res.warnings.join(' | '), /space-between.*понял как «с промежутками»/, res.warnings.join(' | '));
});

test('круг7 п.1: «layout.mode: grid» не превращает строку в колонку молча', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Показатели', path: 'layout.mode', value: 'grid' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['metrics'], utterance: 'разложи показатели сеткой', provider, engine });
  assert.ok(!res.ops.some((o) => o.value === 'column'), 'колонка не подставлена: ' + JSON.stringify(res.ops));
  assert.equal(res.preview.doc.nodes.metrics.layout.mode, 'row', 'строка осталась строкой');
  const w = res.warnings.join(' | ');
  assert.match(w, /grid/);
  assert.match(w, /пропущена/);
});

test('круг7 п.1: дерево из ответа модели тоже не подменяет раскладку молча', () => {
  const doc = makeDoc7();
  const w = [];
  const spec = normalizeTree(
    { type: 'frame', name: 'Плитки', layout: { mode: 'grid', align: 'flex-start', justify: 'space-between' }, children: [] },
    { doc, warn: (m) => w.push(m) },
  );
  assert.equal(spec.layout.mode, 'column', 'узел всё равно создаётся — но со словами');
  assert.equal(spec.layout.align, 'start');
  assert.equal(spec.layout.justify, 'between');
  const text = w.join(' | ');
  assert.match(text, /grid/);
  assert.match(text, /оставил «столбец»/);
  assert.match(text, /flex-start.*понял как «по началу»/);
});

/* п.2 — формулировка плана не уводит в новый артборд */

test('круг7 п.2: план «Создал новый экран» не создаёт артборд, если человек про экран не говорил', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Создал новый экран отзывов', summary: 'Новый экран с тремя отзывами.', steps: ['Каркас'] },
    tree: {
      type: 'frame', name: 'Блок отзывов', layout: { mode: 'column', gap: 12 }, size: { w: 'fill', h: 'hug' },
      children: [{ type: 'text', name: 'Отзыв', text: 'Очень удобно', style: 'body' }],
    },
  });
  const res = await runCommand({
    doc, selection: [], utterance: 'добавь блок отзывов из трёх карточек', provider, engine, activeArtboardId: 'screen',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].node.parent, 'screen', 'блок лёг внутрь текущего экрана');
  assert.equal(res.ops[0].node.pos, undefined, 'это не артборд');
  assert.equal(Object.values(res.preview.doc.nodes).filter((n) => n.parent === 'page').length, 2, 'артбордов по-прежнему два');
  const w = res.warnings.join(' | ');
  assert.match(w, /план/i);
  assert.match(w, /экран не назван/i);

  // а когда про экран сказал ЧЕЛОВЕК — по-прежнему новый артборд и без предупреждения
  const doc2 = makeDoc7();
  const p2 = makeFakeProvider({
    plan: { intent: 'create', title: 'Добавил блок отзывов', summary: 'Блок.', steps: ['Каркас'] },
    tree: { type: 'frame', name: 'Экран отзывов', size: { w: 390, h: 'hug' }, children: [{ type: 'text', name: 'Отзыв', text: 'Очень удобно', style: 'body' }] },
  });
  const res2 = await runCommand({ doc: doc2, selection: [], utterance: 'сделай новый экран отзывов', provider: p2, engine, activeArtboardId: 'screen' });
  assert.equal(res2.ops[0].node.parent, 'page', 'явная просьба человека — новый артборд');
  assert.ok(!/экран не назван/i.test(res2.warnings.join(' | ')), res2.warnings.join(' | '));
});

/* п.3 — «добавь под заголовком» не кладёт блок во всю ширину в узкую обёртку */

test('круг7 п.3: findInsertTarget предлагает уровень выше для блока во всю ширину', () => {
  const doc = makeDoc7();
  const scope = resolveScope(doc, [], null, { activeArtboardId: 'screen' });
  const under = findInsertTarget(doc, 'добавь под заголовком плашку с погодой', scope, null, geo7(doc));
  assert.equal(under.parentId, 'headCol', 'сам якорь по-прежнему определяется точно');
  assert.ok(under.wide, 'для блока во всю ширину есть уровень выше');
  assert.equal(under.wide.parentId, 'screen', 'узкая обёртка и строка пропущены, это уровень экрана');
  assert.equal(under.wide.index, 1, 'сразу после шапки');
  assert.match(under.wide.why, /Дата и заголовок/);

  // «рядом с» — просили соседа, наверх не поднимаемся
  const near = findInsertTarget(doc, 'добавь рядом с аватаром иконку', scope, null, geo7(doc));
  assert.equal(near.parentId, 'head');
  assert.equal(near.wide, undefined);
});

test('круг7 п.3: плашка во всю ширину ложится уровнем выше, а узкая остаётся в обёртке', async () => {
  const engine = makeStubEngine();
  const wide = {
    type: 'frame', name: 'Плашка погоды', layout: { mode: 'row', gap: 8, padding: 12 }, size: { w: 'fill', h: 'hug' },
    children: [{ type: 'text', name: 'Погода', text: '+14 °C, облачно', style: 'body' }],
  };
  const doc = makeDoc7();
  const res = await runCommand({
    doc, selection: [], utterance: 'добавь под заголовком плашку с погодой', engine, activeArtboardId: 'screen', geo: geo7(doc),
    provider: makeFakeProvider({ plan: { intent: 'create', title: 'Добавил плашку', summary: 'Плашка с погодой.', steps: ['Плашка'] }, tree: wide }),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].node.parent, 'screen', 'во всю ширину — на уровень экрана');
  assert.equal(res.preview.doc.nodes.screen.children[1], res.ops[0].node.id, 'сразу после шапки');
  assert.match(res.warnings.join(' | '), /уровнем выше/, res.warnings.join(' | '));

  // тот же запрос, но узел по содержимому — остаётся там, где якорь
  const doc2 = makeDoc7();
  const res2 = await runCommand({
    doc: doc2, selection: [], utterance: 'добавь под заголовком значок погоды', engine, activeArtboardId: 'screen', geo: geo7(doc2),
    provider: makeFakeProvider({
      plan: { intent: 'create', title: 'Добавил значок', summary: 'Значок.', steps: ['Значок'] },
      tree: { type: 'text', name: 'Значок погоды', text: '+14 °C', style: 'body', size: { w: 'hug', h: 'hug' } },
    }),
  });
  assert.equal(res2.ops[0].node.parent, 'headCol', 'узкий узел остаётся в обёртке');
  assert.ok(!/уровнем выше/.test(res2.warnings.join(' | ')), res2.warnings.join(' | '));
});

test('круг7 п.3: патч с op:"create" тоже уходит уровнем выше', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: {
      edits: [{
        op: 'create', target: 'selection',
        node: { type: 'frame', name: 'Плашка погоды', layout: { mode: 'row', gap: 8 }, size: { w: 'fill', h: 'hug' }, children: [{ type: 'text', name: 'Погода', text: '+14 °C', style: 'body' }] },
      }],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'добавь под заголовком плашку с погодой', provider, engine, activeArtboardId: 'screen', geo: geo7(doc) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].node.parent, 'screen');
  assert.match(res.warnings.join(' | '), /уровнем выше/);
});

/* п.4 — реплика без глагола */

test('круг7 п.4: реплика без глагола, но про существующий слой — правка, а не создание', () => {
  const doc = makeDoc7();
  for (const s of ['сделай у кнопки радиус восемь', 'сделай фон карточки такой же, как у кнопки',
    'повтори шапку со второго экрана здесь', 'сделай таблицу по ширине как показатели']) {
    const g = classifyUtterance(s, { doc });
    assert.equal(g.intent, 'edit', `${s} → ${g.intent} (${g.reason})`);
    assert.ok(g.unsure, 'уверенность признаётся невысокой: ' + s);
  }
  // незнакомое слово — намерение не определено, но это не create «по умолчанию молча»
  const unknown = classifyUtterance('тарифы', { doc });
  assert.ok(unknown.unsure, JSON.stringify(unknown));
  assert.ok(unknown.confidence <= 0.3, JSON.stringify(unknown));
});

test('круг7 п.4: при неопределённом намерении промпт просит модель решить сама', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'radius', value: '8' }] },
  });
  await runCommand({ doc, selection: [], utterance: 'сделай у кнопки радиус восемь', provider, engine, activeArtboardId: 'screen' });
  const planner = provider.calls.find((c) => c.schema === 'plan').messages[0].content;
  assert.match(planner, /намерение не определено/);
  assert.ok(!/предполагает: create/.test(planner), 'create модели больше не подсказывается');
});

/* п.5 — в документе поменялось, на экране нет */

test('круг7 п.5: зазор, который раскладка не использует, признаётся словами', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();               // solve заглушки не зависит от layout
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: [{ edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '8' }] },
      { edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '8' }] }],
  });
  const res = await runCommand({ doc, selection: ['head'], utterance: 'сделай шапку компактнее', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  // круг 20: 8 — шаг 1 шкалы отступов документа → в документе ссылка на него
  assert.equal(res.preview.doc.nodes.head.layout.gap, 'spacing.1', 'в документе значение поменялось');
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  // круг 16, п.9: причина названа словами инспектора, без «justify "between"»
  assert.match(w, /с промежутками/, 'названа причина: ' + w);
  assert.ok(!/between|layout\.gap/.test(w), 'внутренних имён нет: ' + w);
  assert.ok(!/ни на что не повлияла/.test(w), 'это другое состояние, не «совсем ничего»: ' + w);
});

test('круг7 п.5: выключка текста по содержимому тоже объясняется', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'align', value: 'center' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  doc.nodes.btnText.size = { w: { mode: 'hug' }, h: { mode: 'hug' } };
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'выровняй подпись кнопки по центру', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  assert.match(w, /hug|по содержимому/, w);
});

test('круг7 п.5: правка, которую видно, предупреждения не вызывает', async () => {
  const doc = makeDoc7();
  // геометрия заглушки зависит от числа узлов — создание меняет её, значит, предупреждения быть не должно
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'create', parent: 'Список пунктов', node: { type: 'text', name: 'Сноска', text: 'и ещё', style: 'body' } }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'добавь в список сноску', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(!/на экране — нет/.test(res.warnings.join(' | ')), res.warnings.join(' | '));
});

/* п.6 — выбранный кандидат называется так же, как остальные */

test('круг7 п.6: при трёх одноимённых выбранный называется с родителем', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { edits: [{ op: 'set', target: 'Текст пункта', path: 'name', value: 'Строки пункта' }] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'назови текст пункта иначе', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const line = res.warnings.find((w) => /подходит слоёв/.test(w)) || '';
  assert.match(line, /правлю «Текст пункта» в «Пункт · /, line);
});

/* п.7 — правка, совпавшая с текущим значением */

test('круг7 п.7: правка «как уже есть» отмечается предупреждением', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: {
      edits: [
        { op: 'set', target: 'Дата', path: 'color', value: 'muted' },      // уже muted
        { op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h2' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: ['headCol'], utterance: 'сделай дату серой и заголовок поменьше', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 2, 'операции остаются: отчёт человеку строит оболочка');
  const w = res.warnings.join(' | ');
  // круг 16, п.9: поле и токен названы словами человека, а не «color» и «muted»
  assert.match(w, /«Дата»: цвет текста уже «приглушённый»/, w);
  assert.ok(!/"?«?color»?"?|muted/.test(w), 'внутренних имён в предупреждении нет: ' + w);
  assert.ok(!/«Заголовок экрана»: стиль текста уже/.test(w), 'о настоящей правке так не говорим: ' + w);
});

/* п.8 — абсурдное число */

test('круг7 п.8: размер на порядки больше родителя отклоняется, а не зажимается', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Список пунктов', path: 'size.w', value: '999999999' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['list'], utterance: 'сделай список пошире', provider, engine, geo: geo7(doc) });
  assert.ok(!res.ops.some((o) => o.path === 'size.w'), 'зажатого 100000 в операциях нет: ' + JSON.stringify(res.ops));
  const w = res.warnings.join(' | ');
  assert.match(w, /пропущена/);
  assert.match(w, /999999999|1000000000/, w);

  // разумное значение по-прежнему применяется
  const doc2 = makeDoc7();
  const p2 = makeFakeProvider({ plan: PLAN_EDIT3, patch: { edits: [{ op: 'set', target: 'Список пунктов', path: 'size.w', value: '320' }] } });
  const res2 = await runCommand({ doc: doc2, selection: ['list'], utterance: 'сделай список шириной 320', provider: p2, engine, geo: geo7(doc2) });
  assert.deepEqual(res2.ops.map((o) => o.value), [{ mode: 'fixed', value: 320 }]);
});

test('круг7 п.8: coerceValue сам отклоняет абсурд и говорит про невидимый слой', () => {
  const doc = makeDoc7();
  const w = [];
  const note = (m) => w.push(m);
  assert.equal(coerceValue('999999999', 'size.w', doc, note, { id: 'list', geo: geo7(doc) }), undefined);
  assert.equal(coerceValue('60000', 'size.h', doc, note), undefined, 'без родителя спасает абсолютный предел');
  assert.deepEqual(coerceValue('0', 'size.w', doc, note), { mode: 'hug' });
  assert.match(w.join(' | '), /невидимый слой/);
  assert.deepEqual(coerceValue('740', 'size.w', doc, () => {}, { id: 'list', geo: geo7(doc) }), { mode: 'fixed', value: 740 });
});

/* п.9 — промпт варианта не путает свой характер с чужим */

test('круг7 п.9: инструкция варианта не подмешивает метки характеров соседей', () => {
  const text = variantInstruction(PERSONAS[2], 3, 3, ['Укрупнил заголовок. Добавил воздуха (4 операц.)']);
  assert.match(text, /ТВОЙ ВАРИАНТ — 3-Й ИЗ 3/);
  assert.match(text, /чужие решения, а не твоё задание/i);
  assert.ok(!/Просторный|Строгий|Плотный:/.test(text), 'меток характеров соседей в тексте нет: ' + text);
  const sys = PROMPTS.patch({ tokens: '', digest: '', scopeLabel: 'x', personaHint: PERSONAS[2].patchHint, variantHint: text });
  assert.match(sys, /ХАРАКТЕР — ТВОЙ И ТОЛЬКО ТВОЙ/);
});

/* п.10 — просьбы о вариантах: падежи и вежливые хвосты */

test('круг7 п.10: «два варианта шапки», «а по-другому можно», вежливые хвосты', () => {
  const doc = makeDoc7();
  assert.deepEqual(recognizeVariants('два варианта шапки', { doc }), { variantsOf: '', subject: 'Шапка' });
  assert.deepEqual(recognizeVariants('покажи пару вариантов таблицы', { doc }), { variantsOf: '', subject: 'Таблица проектов' });
  assert.deepEqual(recognizeVariants('а по-другому можно', { doc }), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('а можно как-то по-другому?', { doc }), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('покажи пару вариантов, пожалуйста', { doc }), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('варианты, пожалуйста', { doc }), { variantsOf: '' });
  assert.deepEqual(recognizeVariants('три варианта: сделай шапку компактнее', { doc }), { variantsOf: 'сделай шапку компактнее' });
});

test('круг7 п.10: ловушки по-прежнему уходят в модель — ложных срабатываний ноль', () => {
  const doc = makeDoc7();
  const traps = [
    'отмени скидку в подписи', 'верни заголовок на место', 'повтори шапку со второго экрана',
    'покажи варианты оплаты', 'дай выбор тарифов', 'иначе кнопка не видна', 'добавь вариант оплаты картой',
    'два варианта оплаты добавь в карточку', 'в этом варианте поменяй цвет кнопки', 'сколько вариантов у кнопки?',
    'напиши в подписи «вариант Б»', 'сделай вариант с картой', 'вариант оплаты', 'другой экран сделай',
    'покажи варианты доставки', 'иначе не влезет', 'по другому поводу добавь кнопку',
    'два пункта добавь в список', 'три карточки тарифов собери', 'верни как было',
  ];
  for (const t of traps) assert.equal(recognizeVariants(t, { doc }), null, t);
  // предмет, которого в документе нет, — тоже не просьба о вариантах
  assert.equal(recognizeVariants('два варианта оплаты', { doc }), null);
});

/* п.1 (продолжение) — прочие молчаливые подстановки */

test('круг7 п.1: зажатые числа, проценты прозрачности и «да/нет» больше не молчат', () => {
  const doc = makeDoc7();
  const w = [];
  const note = (m) => w.push(m);
  // круг 20: зажатые 100000 — число, которого человек не называл, мимо шкалы скруглений → ближайший шаг (20 = radii.5), со словами
  assert.equal(coerceValue('900000', 'radius', doc, note), 'radii.5', 'зажатие осталось — но со словами');
  assert.equal(coerceValue('-30', 'layout.gap', doc, note), 0);
  assert.equal(coerceValue('50', 'opacity', doc, note), 0.5, '50 понято как проценты');
  assert.equal(coerceValue('300', 'opacity', doc, note), undefined);
  assert.equal(coerceValue('наверное', 'layout.wrap', doc, note), undefined);
  assert.equal(coerceValue('да', 'clip', doc, () => {}), true);
  const text = w.join(' | ');
  assert.match(text, /зажал до 100000/);
  assert.match(text, /100000 — мимо шкалы скруглений, взял ближайший шаг 20/);
  assert.match(text, /отрицательного размера не бывает/);
  assert.match(text, /50%/);
  assert.match(text, /от 0 до 1/);
  assert.match(text, /не «да» и не «нет»/);
});

test('круг7 п.1: нечитаемый размер в дереве подставляется со словами', () => {
  const doc = makeDoc7();
  const w = [];
  const spec = normalizeTree(
    { type: 'frame', name: 'Полоса', size: { w: '100vh', h: 'высокая' }, children: [] },
    { doc, warn: (m) => w.push(m) },
  );
  assert.deepEqual(spec.size.w, { mode: 'fill' });
  assert.match(w.join(' | '), /100vh.*не размер/);
  assert.match(w.join(' | '), /высокая.*не размер/);
});

test('круг7 п.1: когда отклонены все правки, причина стоит в самой ошибке', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Показатели', path: 'layout.mode', value: 'grid' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['metrics'], utterance: 'разложи показатели сеткой', provider, engine });
  assert.ok(res.error, 'правок не осталось — это ошибка команды');
  assert.match(res.error.message, /grid/, res.error.message);
  // круг 29 (J5): свой код и текст — сама причина, без служебной шапки
  assert.equal(res.error.code, 'not_applied');
  assert.doesNotMatch(res.error.message, /Ни одну правку/);
  const repair = provider.calls.filter((c) => c.schema === 'patch').pop().messages.map((m) => m.content).join('\n');
  assert.match(repair, /grid/, 'на починку модель получает причину, а не только «не удалось»');
});

/* п.5 (продолжение) — поле для оболочки */

test('круг7 п.5: правки, не видные на экране, приходят оболочке отдельным полем', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '8' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['head'], utterance: 'сделай шапку компактнее', provider, engine });
  assert.deepEqual(res.geometryUnchanged, [{ id: 'head', path: 'layout.gap' }]);
});

test('круг7 п.4: mentionsExistingLayer видит названный слой и не выдумывает', () => {
  const doc = makeDoc7();
  // круг 9, п.6: возвращается {name, id, strength} — слабое совпадение человеку не показывают
  assert.equal(mentionsExistingLayer(doc, 'сделай у кнопки радиус восемь').name, 'Кнопка «Добавить пункт»');
  assert.equal(mentionsExistingLayer(doc, 'шапку компактнее').name, 'Шапка');
  assert.equal(mentionsExistingLayer(doc, 'сделай тарифы из трёх колонок'), null);
  assert.equal(mentionsExistingLayer(null, 'шапка'), null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Круг 9. Приложение перестаёт говорить неправду о результате
 * ──────────────────────────────────────────────────────────────────────────── */

/** Демо с колонками разной ширины: fill, фиксированная и «по содержимому». */
function makeDoc9() {
  const doc = makeDoc5();
  // «Владелец» — колонка фиксированной ширины (как в демо core.js: w: 180)
  for (let i = 0; i < 5; i++) doc.nodes[`c${i}_2`].size = { w: { mode: 'fixed', value: 180 }, h: { mode: 'hug' } };
  // «Подпись кнопки» — по содержимому: выключке действительно некуда двигать строку
  doc.nodes.btnText.size = { w: { mode: 'hug' }, h: { mode: 'hug' } };
  return doc;
}

/* п.1 — выключка текста: правда о том, видно ли её */

test('круг9 п.1: выключка в тексте фиксированной ширины не объявляется пустой правкой', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Владелец', path: 'align', value: 'right' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: [], utterance: 'выровняй владельцев по правому краю',
    provider, engine, activeArtboardId: 'summary',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 5, 'колонка поправлена целиком');
  assert.equal(res.preview.doc.nodes.c1_2.align, 'right');
  const w = res.warnings.join(' | ');
  assert.ok(!/на экране — нет/.test(w), 'текст внутри своего бокса уехал — это видимая правка: ' + w);
  assert.equal(res.geometryUnchanged, undefined, JSON.stringify(res.geometryUnchanged));
});

test('круг9 п.1: выключка в тексте «fill» тоже видимая', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Проект', path: 'align', value: 'center' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: [], utterance: 'выровняй названия проектов по центру',
    provider, engine, activeArtboardId: 'summary',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.ok(!/на экране — нет/.test(w), w);
  assert.equal(res.geometryUnchanged, undefined, JSON.stringify(res.geometryUnchanged));
});

test('круг9 п.1: выключка в тексте «по содержимому» по-прежнему признаётся невидимой', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'align', value: 'right' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'выровняй подпись кнопки по правому краю', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  assert.match(w, /hug|по содержимому/, w);
  assert.deepEqual(res.geometryUnchanged, [{ id: 'btnText', path: 'align' }]);
});

/* п.2 — «8px» больше не превращается в ноль */

test('круг9 п.2: «8px» в скруглении, зазоре и отступах читается как 8, а не как 0', () => {
  const notes = [];
  const n = (m) => notes.push(m);
  assert.equal(coerceValue('8px', 'radius', {}, n), 8);
  assert.equal(coerceValue('8px', 'layout.gap', {}, n), 8);
  assert.deepEqual(coerceValue('24px', 'layout.padding', {}, n), { t: 24, r: 24, b: 24, l: 24 });
  assert.equal(coerceValue('8 px', 'layout.gap', {}, n), 8);
  assert.equal(coerceValue('12пкс', 'radius', {}, n), 12);
  assert.equal(coerceValue('2,5', 'layout.gap', {}, n), 2.5);
  assert.deepEqual(coerceValue('370px', 'size.w', { nodes: {} }, n), { mode: 'fixed', value: 370 });
  assert.equal(notes.length, 0, 'обычные единицы — не повод для предупреждения: ' + notes.join(' | '));
});

test('круг9 п.2: непонятное число ПРОПУСКАЕТ правку, а не подставляет 0', () => {
  const notes = [];
  const n = (m) => notes.push(m);
  assert.equal(coerceValue('восемь', 'radius', {}, n), undefined);
  assert.equal(coerceValue('побольше', 'layout.gap', {}, n), undefined);
  assert.equal(coerceValue('как у кнопки', 'radius', {}, n), undefined);
  assert.equal(clampPx('не число'), undefined);
  assert.equal(clampPx('8px'), 8);
  assert.equal(clampPx(-12), 0);
  assert.equal(clampPx(500000), 100000);
  const joined = notes.join(' | ');
  assert.match(joined, /правка пропущена/, joined);
  assert.ok(!/взял 0/.test(joined), 'ноль здесь — порча макета под видом выполнения: ' + joined);
});

test('круг9 п.2: «сделай у пунктов скругление восемь» ставит 8, а не обнуляет углы', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Пункт · Тренировка', path: 'radius', value: '8px' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай у пунктов скругление восемь', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  // круг 20: 8 — шаг 2 шкалы скруглений документа → ссылка; главное — не ноль
  assert.equal(res.ops[0].value, 'radii.2', 'скругление 8 (шаг шкалы), а не 0');
  assert.ok(!/взял 0/.test(res.warnings.join(' | ')), res.warnings.join(' | '));
});

test('круг9 п.2: «8px» в дереве от модели тоже читается числом', () => {
  const doc = makeDoc9();
  const w = [];
  const spec = normalizeTree(
    { type: 'frame', name: 'Плашка', radius: '8px', layout: { mode: 'column', gap: '12px', padding: '16px' }, children: [] },
    { doc, warn: (m) => w.push(m) },
  );
  // круг 20: единицы сняты, числа на шагах шкал → ссылки на эти шаги (8 = radii.2, 12 = spacing.2, 16 = spacing.3)
  assert.equal(spec.radius, 'radii.2');
  assert.equal(spec.layout.gap, 'spacing.2');
  assert.deepEqual(spec.layout.padding, { t: 'spacing.3', r: 'spacing.3', b: 'spacing.3', l: 'spacing.3' });
  assert.equal(w.length, 0, w.join(' | '));
});

/* п.3 — ошибка без кода не объявляется сбоем связи */

test('круг9 п.3: ошибка провайдера без кода — это ошибка модели со своим текстом', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const provider = {
    name: 'fake', kind: 'fake',
    async ready() { return true; },
    async complete() { throw new Error('локальный сервер вернул 500 на /v1/chat/completions'); },
  };
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок крупнее', provider, engine });
  assert.ok(res.error, 'ошибка есть');
  assert.equal(res.error.kind, 'model', JSON.stringify(res.error));
  assert.ok(!/Сбой связи/.test(res.error.message), res.error.message);
  assert.match(res.error.message, /500/, 'текст ошибки провайдера сохранён: ' + res.error.message);
  assert.equal(res.error.code, undefined, 'кода не было — не выдумываем: ' + JSON.stringify(res.error));
});

test('круг9 п.3: не-JSON от провайдера диагностируется как не-JSON', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const provider = {
    name: 'fake', kind: 'fake',
    async ready() { return true; },
    async complete() { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
  };
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок крупнее', provider, engine });
  assert.ok(res.error);
  assert.ok(!/Сбой связи/.test(res.error.message), res.error.message);
  assert.match(res.error.message, /не JSON/, res.error.message);
});

test('круг9 п.3: настоящий код upstream_error по-прежнему сбой связи', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const provider = {
    name: 'fake', kind: 'fake',
    async ready() { return true; },
    async complete() { const e = new Error('boom'); e.code = 'upstream_error'; throw e; },
  };
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок крупнее', provider, engine });
  assert.equal(res.error.kind, 'network');
  assert.match(res.error.message, /Сбой связи/);
});

/* п.4 — «в этой модели документа так нельзя» */

test('круг9 п.4: патч с cannot — это ответ агента, а не авария', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: { cannot: 'Поворота в этом редакторе нет: узлы не умеют вращаться.', edits: [] },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'поверни аватар на 15 градусов', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, []);
  assert.match(res.cannot, /Поворота/, res.cannot);
  assert.ok(res.preview && res.preview.doc, 'документ остался прежним');
  assert.equal(res.preview.doc, doc);
  const stages = res.stages.map((s) => s.stage);
  assert.ok(stages.includes('cannot'), stages.join(','));
  assert.ok(!stages.includes('error'), stages.join(','));
});

test('круг9 п.4: план с intent "refuse" не зовёт модель второй раз', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: {
      intent: 'refuse', title: 'Поворот невозможен',
      summary: 'В модели документа нет поворота.', steps: ['Объяснить'],
      cannot: 'Повернуть слой нельзя: в этом редакторе у узлов нет угла поворота.',
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'поверни аватар на 15 градусов', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.match(res.cannot, /нет угла поворота/, res.cannot);
  assert.equal(provider.calls.length, 1, 'после отказа генерация не нужна');
});

test('круг9 п.4: cannot можно вернуть и на починке, вместо выдуманного поля', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  // круг 37: поворот (rotate) в модели документа ЕСТЬ — выдуманное поле теперь «blur»
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: [
      { edits: [{ op: 'set', target: 'Аватар', path: 'blur', value: '8' }] },
      { cannot: 'Размытия у узлов нет — просить бесполезно.', edits: [] },
    ],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'размой аватар', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.match(res.cannot, /Размытия/, res.cannot);
  assert.deepEqual(res.ops, []);
});

test('круг9 п.4: промпт правок и схема прямо разрешают отказ', () => {
  const doc = makeDoc9();
  const ctx = { digest: describeDoc(doc, { engine: null }), tokens: '', checks: '', scope: 'весь документ', placement: '' };
  const text = PROMPTS.patch({ ...ctx });
  assert.match(text, /cannot/, 'в промпте есть форма отказа');
  assert.match(text, /поворот/i, 'перечислено, чего в модели нет');
  assert.ok(SCHEMAS.patch.schema.properties.cannot, 'cannot есть в схеме патча');
  assert.match(SCHEMAS.patch.hint, /cannot/);
});

/* п.5 — агентское выделение не порождает «правка ушла туда» */

test('круг9 п.5: при агентском выделении «правка ушла туда» не появляется', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Статус', path: 'color', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: ['headTitle'], selectionBy: 'agent',
    utterance: 'покрась статусы в акцентный', provider, engine, activeArtboardId: 'screen',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.ok(!/правка ушла/.test(w), 'выделение сделал агент — это не область работы человека: ' + w);
  assert.ok(!/найден\S* вне выделения/.test(w), w);
  assert.match(w, /подходит слоёв — 5/, 'важное предупреждение на месте: ' + w);
});

test('круг9 п.5: человеческое выделение по-прежнему даёт «правка ушла туда»', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Статус', path: 'color', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: ['headTitle'], selectionBy: 'human',
    utterance: 'покрась статусы в акцентный', provider, engine, activeArtboardId: 'screen',
  });
  const w = res.warnings.join(' | ');
  assert.match(w, /правка ушла/, w);
});

/* п.6 — слабое совпадение имени не показывается человеку */

test('круг9 п.6: «переключись на второй экран» не выдаёт «назван слой «Заголовок экрана»»', () => {
  const doc = makeDoc9();
  const got = classifyUtterance('переключись на второй экран', { doc });
  assert.ok(!/Заголовок экрана/.test(got.reason), got.reason);
});

test('круг9 п.6: из одноимённых выбирается тот, чьё имя названо целиком', () => {
  const doc = makeDoc9();
  const hit = mentionsExistingLayer(doc, 'в таблице покрась статус в зелёный');
  assert.ok(hit, 'слой найден');
  assert.equal(hit.name, 'Статус', JSON.stringify(hit));
  assert.equal(hit.strength, 'strong', JSON.stringify(hit));
  const weak = mentionsExistingLayer(doc, 'сделай у кнопки радиус восемь');
  assert.equal(weak.name, 'Кнопка «Добавить пункт»', JSON.stringify(weak));
  assert.equal(weak.strength, 'weak', 'одно слово из трёх — слабое совпадение');
  assert.ok(!/Кнопка/.test(classifyUtterance('у кнопки радиус восемь', { doc }).reason),
    'слабое совпадение человеку не показывают: ' + classifyUtterance('у кнопки радиус восемь', { doc }).reason);
  const got = classifyUtterance('у кнопки радиус восемь', { doc });
  assert.equal(got.intent, 'edit');
});

test('круг9 п.6: узлы активной области выигрывают у одноимённых с чужого экрана', () => {
  const doc = makeDoc9();
  // «Время» носят три узла в разных пунктах: побеждает тот, что в области работы
  assert.equal(mentionsExistingLayer(doc, 'время правее', { prefer: new Set(['item2', 'time2']) }).id, 'time2');
  assert.equal(mentionsExistingLayer(doc, 'время правее', { prefer: new Set(['item0', 'time0']) }).id, 'time0');
  // а названное ЦЕЛИКОМ имя сильнее предпочтения: «шапку» — это «Шапка», а не «Шапка сводки»
  assert.equal(mentionsExistingLayer(doc, 'покрупнее шапку', { prefer: new Set(['sumHead']) }).name, 'Шапка');
});

test('круг9 п.6: общие слова («экран», «макет», «слой») сами слоя не называют', () => {
  const doc = makeDoc9();
  assert.equal(mentionsExistingLayer(doc, 'на этом экране'), null);
  assert.equal(mentionsExistingLayer(doc, 'поправь макет'), null);
  assert.equal(mentionsExistingLayer(doc, 'сделай тарифы из трёх колонок'), null);
  assert.equal(mentionsExistingLayer(null, 'шапка'), null);
  assert.equal(mentionsExistingLayer(doc, 'шапку компактнее').name, 'Шапка');
});

/* п.7 — «why» места вставки по-русски */

test('круг9 п.7: объяснение места вставки грамматично', () => {
  const doc = makeDoc7();
  const scope = resolveScope(doc, [], null, { activeArtboardId: 'screen' });
  const after = findInsertTarget(doc, 'добавь под заголовком плашку с погодой', scope, null, geo7(doc));
  assert.ok(after, 'место найдено');
  assert.match(after.why, /вставляю после слоя «Заголовок экрана»/, after.why);
  assert.ok(!/сказано «после заголовком/.test(after.why), after.why);
  const into = findInsertTarget(doc, 'добавь в пункт тренировка иконку', scope, null, geo7(doc));
  assert.ok(into, 'место найдено');
  assert.match(into.why, /вставляю внутрь слоя «Пункт · Тренировка»/, into.why);
  assert.ok(!/сказано «в пункт/.test(into.why), into.why);
  const before = findInsertTarget(doc, 'добавь над кнопкой разделитель', scope, null, geo7(doc));
  assert.match(before.why, /^вставляю перед слоем «.+», внутрь «.+»$/, before.why);
  const near = findInsertTarget(doc, 'добавь рядом с аватаром значок', scope, null, geo7(doc));
  assert.match(near.why, /^вставляю рядом со слоем «Аватар», внутрь «Шапка»$/, near.why);
  const first = findInsertTarget(doc, 'добавь сверху баннер', scope, null, geo7(doc));
  assert.match(first.why, /^вставляю первым элементом в «.+»: в команде сказано «сверху»$/, first.why);
  const last = findInsertTarget(doc, 'добавь снизу подпись', scope, null, geo7(doc));
  assert.match(last.why, /^дописываю последним элементом в «.+»: в команде сказано «снизу»$/, last.why);
});

/* п.8 — объяснение про stretch честное */

test('круг9 п.8: про растяжение говорится только там, где родитель и правда решает', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  // «Список пунктов» лежит в колонке с align:"stretch" — своя ширина "hug" ему не поможет
  const hugPatch = { edits: [{ op: 'set', target: 'Список пунктов', path: 'size.w', value: 'hug' }] };
  let provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [hugPatch, hugPatch] });
  let res = await runCommand({ doc, selection: [], utterance: 'сделай список по содержимому', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  // круг 16, п.9: «align "stretch"» человеку не говорим — говорим «растянуть»
  assert.match(res.warnings.join(' | '), /растягивает детей|растянуть/, res.warnings.join(' | '));
  assert.ok(!/stretch|"hug"/.test(res.warnings.join(' | ')), 'внутренних имён нет: ' + res.warnings.join(' | '));

  // а фиксированную ширину родитель уважает — врать про stretch нельзя
  const doc2 = makeDoc9();
  const fixPatch = { edits: [{ op: 'set', target: 'Список пунктов', path: 'size.w', value: '320' }] };
  provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [fixPatch, fixPatch] });
  res = await runCommand({ doc: doc2, selection: [], utterance: 'сделай список шириной 320', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.ok(!/своя ширина узла не применяется/.test(w), 'фиксированную ширину core уважает: ' + w);
});

/* п.9 — ранжирование предупреждений */

test('круг9 п.9: «пропущено» и «ничего не изменилось» важнее «нашлось вне выделения»', () => {
  const skipped = 'Правка radius: «восемь» — не число: правка пропущена';
  const nothing = 'Правка ни на что не повлияла: в макете ничего не изменилось — скажите точнее, что и где поправить';
  const outside = 'Слой «Статус» найден вне выделения — на экране «Сводка недели»; правка ушла туда';
  const many = 'Под «Статус» подходит слоёв — 5: правлю все';
  assert.ok(warningRank(skipped) < warningRank(outside), `${warningRank(skipped)} < ${warningRank(outside)}`);
  assert.ok(warningRank(nothing) < warningRank(outside), `${warningRank(nothing)} < ${warningRank(outside)}`);
  assert.ok(warningRank(outside) < warningRank('Проверка макета: контраст 2.10:1'), 'макет ниже адресации');
  assert.ok(warningRank('Проверка макета: контраст 2.10:1') < warningRank('Починка не помогла — оставил первый вариант'));
  const sorted = sortWarnings([outside, many, 'Починка не помогла — оставил первый вариант', nothing, skipped]);
  assert.match(sorted[0], /пропущена|ничего не изменилось/, sorted.join(' | '));
  assert.match(sorted[1], /пропущена|ничего не изменилось/, sorted.join(' | '));
  assert.match(sorted[2] + sorted[3], /вне выделения|подходит слоёв/, sorted.join(' | '));
  assert.match(sorted[4], /Починка/);
});

/* п.2 (продолжение) — все числовые пути согласованы */

test('круг9 п.2: единицы снимаются и в сдвиге, и в токенах темы', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const nudge = { edits: [{ op: 'nudge', target: 'Аватар', dx: '-10px', dy: '0' }] };
  let provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [nudge, nudge] });
  let res = await runCommand({ doc, selection: [], utterance: 'подвинь аватар влево на десять', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1, JSON.stringify(res.warnings));
  assert.match(res.warnings.join(' | '), /10 px влево/, res.warnings.join(' | '));

  const theme = { type: [{ name: 'body', fontSize: '15px', lineHeight: '22px' }], radii: ['8px', 0, 16] };
  provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Шкалы', summary: 'Поправил шкалы.', steps: ['Токены'], targets: [] },
    theme: [theme, theme],
  });
  res = await runCommand({ doc: makeDoc9(), selection: [], utterance: 'сделай основной текст 15 пикселей', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const body = res.ops.find((o) => o.path === 'type.body');
  assert.equal(body.value.fontSize, 15);
  assert.equal(body.value.lineHeight, 22);
  assert.deepEqual(res.ops.find((o) => o.path === 'radii').value, [0, 8, 16], 'ноль в шкале не теряется');
});

test('круг9 п.2: непонятный сдвиг пропускается со словами, а не сдвигает на ноль', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'nudge', target: 'Аватар', dx: 'влево' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'подвинь аватар влево', provider, engine, activeArtboardId: 'screen' });
  assert.ok(res.error, 'правок не осталось');
  assert.match(res.error.message, /влево.*не число/, res.error.message);
});

/* п.1 (продолжение) — многострочный текст по содержимому выключку всё-таки показывает */

test('круг9 п.1: у многострочного текста «по содержимому» выключка видна', async () => {
  const doc = makeDoc9();
  const base = makeStubEngine();
  // решатель, который переносит подпись кнопки на две строки разной длины: короткой есть куда поехать
  const engine = { ...base, solve: (d) => ({ ...base.solve(d), lines: { btnText: ['Добавить', 'пункт'] } }) };
  const patch = { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'align', value: 'right' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'выровняй подпись по правому краю', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.geometryUnchanged, undefined, JSON.stringify(res.geometryUnchanged));
});

/* п.5 (продолжение) — признак доходит до вариантов */

test('круг9 п.5: runVariants тоже принимает selectionBy', async () => {
  const doc = makeDoc9();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Статус', path: 'color', value: 'accent' }] };
  const provider = makeFakeProvider({
    plan: [PLAN_EDIT3, PLAN_EDIT3], patch: [patch, patch, patch, patch],
  });
  const got = await runVariants({
    doc, selection: ['headTitle'], selectionBy: 'agent', n: 2,
    utterance: 'покрась статусы в акцентный', provider, engine, activeArtboardId: 'screen',
  });
  const w = got.flatMap((v) => v.warnings || []).join(' | ');
  assert.ok(!/правка ушла/.test(w), w);
});

/* ══ круг 11 ══════════════════════════════════════════════════════════════ */

/* п.1 — «N вариантов: <команда>» одной фразой */

test('круг11 п.1: при явном разделителе хвост — это команда, словарь глаголов не нужен', () => {
  const doc = makeDoc7();
  const live = [
    ['три варианта: сделай шапку аккуратнее', 'сделай шапку аккуратнее'],
    ['три варианта: сделай карточку интереснее', 'сделай карточку интереснее'],
    ['покажи три варианта: оформи кнопку', 'оформи кнопку'],
    ['два варианта: сделай экран живее', 'сделай экран живее'],
    ['три варианта: переделай шапку', 'переделай шапку'],
    ['дай три варианта: как лучше расположить показатели', 'как лучше расположить показатели'],
    ['три варианта: сделай список читабельнее', 'сделай список читабельнее'],
    ['три варианта: сделай карточку компактнее', 'сделай карточку компактнее'],
    ['два варианта — сделай шапку выразительнее', 'сделай шапку выразительнее'],
    ['покажи 3 варианта: подбери цвет кнопке', 'подбери цвет кнопке'],
    ['дай пару вариантов: как подать показатели', 'как подать показатели'],
    ['несколько вариантов: оживи карточку', 'оживи карточку'],
    ['покажи два варианта: шапка поинтереснее', 'шапка поинтереснее'],
    ['три варианта: сделай кнопку заметнее', 'сделай кнопку заметнее'],
    ['варианты: сделай экран строже', 'сделай экран строже'],
    ['покажи 3 варианта сделай кнопку шире', 'сделай кнопку шире'],
  ];
  for (const [said, want] of live) {
    assert.deepEqual(recognizeVariants(said, { doc }), { variantsOf: want }, said);
    assert.deepEqual(recognizeVariants(said), { variantsOf: want }, said + ' (без документа)');
  }
});

test('круг11 п.1: ловушки по-прежнему уходят в модель — ложных срабатываний ноль', () => {
  const doc = makeDoc7();
  const traps = [
    'добавь вариант оплаты картой', 'покажи варианты оплаты', 'два варианта оплаты добавь в карточку',
    'в этом варианте поменяй цвет', 'отмена заказа — это текст кнопки', 'сколько вариантов у кнопки?',
    'напиши в подписи «вариант Б»', 'сделай вариант с картой', 'вариант оплаты', 'дай выбор тарифов',
    'покажи варианты доставки', 'иначе кнопка не видна', 'иначе не влезет', 'верни как было',
    'по другому поводу добавь кнопку', 'два пункта добавь в список', 'три карточки тарифов собери',
    'другой экран сделай', 'два варианта оплаты', 'отмени скидку в подписи',
    'вариант с подпиской — основной', 'другие решения не подходят',
  ];
  for (const t of traps) assert.equal(recognizeVariants(t, { doc }), null, t);
});

/* п.2 — create без parent не уезжает в чужой узел */

test('круг11 п.2: create без parent не кладёт узел внутрь похожего по имени текста', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = {
    edits: [{
      op: 'create', target: 'подпись',
      node: { type: 'text', name: 'Версия', text: 'версия 1.2', style: 'body', color: 'muted' },
    }],
  };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: [], utterance: 'добавь в самый низ экрана подпись «версия 1.2»',
    provider, engine, activeArtboardId: 'screen',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const made = res.ops.find((o) => o.op === 'create');
  assert.ok(made, JSON.stringify(res.ops));
  assert.equal(made.node.parent, 'screen', 'узел лёг в экран, а не в кнопку: ' + made.node.parent);
  assert.match(res.warnings.join(' | '), /Маршрут дня/, res.warnings.join(' | '));
});

test('круг11 п.2: контейнер, названный в target точно, по-прежнему слушается', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = {
    edits: [{
      op: 'create', target: 'Список пунктов',
      node: { type: 'frame', name: 'Пункт · Новый', children: [{ type: 'text', name: 'Время', text: '20:00' }] },
    }],
  };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'заведи ещё один пункт', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const made = res.ops.find((o) => o.op === 'create');
  assert.equal(made.node.parent, 'list', JSON.stringify(res.warnings));
});

/* п.3 — тема меняет весь документ, и об этом говорят */

test('круг11 п.3: правка токенов честно сообщает, что перекрасились все артборды', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const theme = { colors: [{ name: 'bg', value: '#101418' }, { name: 'text', value: '#f2f5f8' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Затемнил', summary: 'Тёмная тема.', steps: ['Токены'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({
    doc, selection: [], utterance: 'сделай только этот экран тёмным, сводку не трогай',
    provider, engine, activeArtboardId: 'screen',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /оформление документа общее/i, w);
  assert.match(w, /Сводка недели/, w);
});

test('круг11 п.3: промпт темы и описание намерения предупреждают о глобальности токенов', () => {
  const sys = PROMPTS.theme({ tokens: '', digest: '', scopeLabel: 'экран' });
  assert.match(sys, /ОБЩИЕ ДЛЯ\s+ВСЕГО ДОКУМЕНТА/i, sys);
  assert.match(sys, /cannot/i, sys);
  const planner = PROMPTS.planner({ tokens: '', digest: '', scopeLabel: 'экран', guess: 'edit' });
  assert.match(planner, /ОБЩИЕ ДЛЯ\s+ВСЕГО документа/i, planner);
  assert.match(planner, /только этот экран/i, planner);
});

/* п.4 — заведомо невидимые правки */

test('круг11 п.4: скругление у эллипса — доказуемо невидимая правка', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Аватар', path: 'radius', value: '0' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай аватар квадратным', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  assert.match(w, /эллипс|овал/i, w);
  assert.deepEqual(res.geometryUnchanged, [{ id: 'avatar', path: 'radius' }]);
});

test('круг11 п.4: цвет пустого текста тоже ничего не рисует', async () => {
  const doc = makeDoc3();
  doc.nodes.btnText.characters = '';
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'color', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'сделай подпись акцентной', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  assert.match(w, /нет текста/i, w);
  assert.deepEqual(res.geometryUnchanged, [{ id: 'btnText', path: 'color' }]);
});

test('круг11 п.4: видимую правку цвета по-прежнему не объявляют пустой', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'color', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'сделай подпись акцентной', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.geometryUnchanged, undefined, JSON.stringify(res.geometryUnchanged));
  assert.ok(!/на экране — нет/.test(res.warnings.join(' | ')), res.warnings.join(' | '));
});

/* п.5 — «12,5px» */

test('круг11 п.5: десятичная запятая читается и вместе с единицей', () => {
  assert.deepEqual(parsePx('12,5px'), { n: 12.5, unit: 'px', scaled: false });
  assert.deepEqual(parsePx('2,5'), { n: 2.5, unit: '', scaled: false });
  assert.equal(parsePx('1,5rem').n, 24);
  assert.deepEqual(parsePx('12.5px'), { n: 12.5, unit: 'px', scaled: false });
  assert.equal(parsePx('12,5%'), null, 'проценты по-прежнему не пиксели');
  assert.equal(clampPx('12,5px'), 12.5);
});

/* п.6 — живые формулировки отмены и честный переспрос на двусмысленных */

test('круг11 п.6: «убери последнюю правку» — отмена, «убери последнее» — переспрос', () => {
  assert.equal(recognizeAction('убери последнюю правку'), 'undo');
  assert.equal(recognizeAction('сотри последнюю правку'), 'undo');
  assert.equal(recognizeAction('убери изменения'), 'undo');
  assert.equal(recognizeAction('сотри то что сделал'), 'undo');
  assert.equal(recognizeAction('отмени это'), 'undo');
  // двусмысленное угадывать нельзя
  assert.equal(recognizeAction('убери последнее'), null);
  assert.equal(recognizeAction('сотри последнее'), null);
  assert.ok(/отмен/i.test(recognizeUndoDoubt('убери последнее') || ''), recognizeUndoDoubt('убери последнее'));
  assert.ok(recognizeUndoDoubt('сотри последнее'));
  assert.equal(recognizeUndoDoubt('убери последний пункт'), null);
  assert.equal(recognizeUndoDoubt('убери последнюю правку'), null);
});

test('круг11 п.6: двусмысленная отмена доходит до оболочки переспросом, без модели', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({});
  const res = await runCommand({ doc, selection: [], utterance: 'убери последнее', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, []);
  assert.ok(res.clarify && /отмен/i.test(res.clarify), res.clarify);
  assert.equal(provider.calls.length, 0, 'модель не звалась');
});

/* п.7 — ещё живые просьбы о вариантах */

test('круг11 п.7: «покажи другие решения», «а как ещё можно», «покажи по-разному»', () => {
  const doc = makeDoc7();
  for (const s of [
    'покажи другие решения', 'а как ещё можно', 'как ещё можно', 'покажи по-разному',
    'сделай по-разному', 'дай другие решения', 'покажи три решения', 'предложи другие версии',
    'а как ещё можно?', 'покажи ещё решения',
  ]) assert.deepEqual(recognizeVariants(s, { doc }), { variantsOf: '' }, s);
});

/* п.8 — легенда объясняет override */

test('круг11 п.8: легенда выжимки объясняет пометку override', () => {
  assert.match(DIGEST_LEGEND, /override/);
  assert.match(DIGEST_LEGEND, /вручную|руками|человек/i, DIGEST_LEGEND);
});

/* п.9 — служебное «починка не помогла» не шумит в ошибке */

test('круг11 п.9: при провале прогона служебного «починка не помогла» в warnings нет', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const bad = { edits: [{ op: 'set', target: 'Такого слоя нет', path: 'radius', value: '8' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [bad, bad] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай скругление восемь', provider, engine, activeArtboardId: 'screen' });
  assert.ok(res.error, 'прогон закончился ошибкой');
  const w = (res.warnings || []).join(' | ');
  assert.ok(!/Починка не помогла/.test(w), w);
});

/* п.10 — шаги плана доходят до второй стадии */

test('круг11 п.10: plan.steps уходят в промпт второй стадии', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Аватар', path: 'size.w', value: '56' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'edit', title: 'Укрупнил аватар', summary: 'Шире.', steps: ['Найти аватар', 'Поставить 56'], targets: ['Аватар'] },
    patch: [patch, patch],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай аватар крупнее', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const call = provider.calls.find((c) => c.schema === 'patch');
  const turn = call.messages[call.messages.length - 1].content;
  assert.match(turn, /Шаги: 1\) Найти аватар 2\) Поставить 56/, turn);
});

/* ── 15. Круг 13: снятие свойств, вложенное выделение, дешёвые варианты ────── */

/** Демо-документ круга 13: у «Аватара» есть обводка, у кнопки — заливка, карточка с фоном. */
function makeDoc13() {
  const doc = makeDoc3();
  doc.nodes.avatar.stroke = 'muted';
  doc.nodes.item0.fill = 'accent';
  doc.nodes.item0.radius = 12;
  doc.nodes.item0.opacity = 0.9;
  doc.nodes.btnText.color = 'bg';
  return doc;
}

/* п.1 — снять заливку, обводку, цвет: восемь написаний «пусто» */

test('круг13 п.1: coerceValue на «пусто» просит СНЯТЬ свойство, а не пропускает правку', () => {
  const doc = makeDoc13();
  for (const v of ['', 'none', 'нет', 'прозрачный', 'transparent', 'null', '0', 'убрать']) {
    for (const p of ['fill', 'stroke', 'color']) {
      assert.equal(coerceValue(v, p, doc, () => {}), UNSET, `${p} = ${JSON.stringify(v)}`);
    }
  }
  // у числовых полей ноль — настоящее значение, а не «снять»
  // круг 20: ноль скругления и зазора — это шаг 0 шкалы (миграция ядра переводит нули в ссылки,
  // §6.5), а прозрачность шкалы не имеет и остаётся числом
  assert.equal(coerceValue('0', 'radius', doc, () => {}), 'radii.0');
  assert.equal(coerceValue('0', 'opacity', doc, () => {}), 0);
  // зазор 0 мозг оставляет числом («без отступа»); ядро при записи поверх spacing.0 сохранит ссылку (keepFieldForm)
  assert.equal(coerceValue('0', 'layout.gap', doc, () => {}), 0);
  // а словами — снять
  assert.equal(coerceValue('убрать', 'radius', doc, () => {}), UNSET);
  assert.equal(coerceValue('нет', 'opacity', doc, () => {}), UNSET);
  assert.equal(coerceValue('none', 'src', doc, () => {}), UNSET);
  assert.equal(coerceValue('без обводки', 'stroke', doc, () => {}), UNSET);
  assert.equal(coerceValue('снять', 'style', doc, () => {}), UNSET);
  assert.equal(coerceValue('', 'align', doc, () => {}), UNSET);
});

test('круг13 п.1: содержимое и размеры снять нельзя — об этом говорят словами', () => {
  const doc = makeDoc13();
  // пустая строка в тексте — законное значение, а не «снять»
  assert.equal(coerceValue('', 'characters', doc, () => {}), '');
  assert.equal(coerceValue('', 'name', doc, () => {}), '');
  const said = [];
  assert.equal(coerceValue('none', 'size.w', doc, (m) => said.push(m)), undefined);
  assert.match(said.join(' | '), /hug|содержимому/i, said.join(' | '));
});

test('круг13 п.1: «убери фон у карточки» снимает заливку, а не роняет команду', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Пункт · Обед с командой', path: 'fill', value: '' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери фон у карточки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].op, 'set');
  assert.equal(res.ops[0].id, 'item0');
  assert.equal(res.ops[0].path, 'fill');
  assert.equal(res.ops[0].value, undefined, 'операция без value — это «снять»');
  assert.equal(res.preview.doc.nodes.item0.fill, undefined, 'заливки в документе больше нет');
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 1, 'починка не понадобилась');
});

test('круг13 п.1: «сделай кнопку без заливки» и «сними обводку» — то же самое', async () => {
  for (const [target, path, value, id] of [
    ['Кнопка «Добавить пункт»', 'fill', 'нет', 'btn'],
    ['Аватар', 'stroke', 'убрать', 'avatar'],
    ['Подпись кнопки', 'color', 'прозрачный', 'btnText'],
    ['Пункт · Обед с командой', 'radius', 'без скругления', 'item0'],
    ['Пункт · Обед с командой', 'opacity', 'none', 'item0'],
  ]) {
    const doc = makeDoc13();
    const engine = makeStubEngine();
    const patch = { edits: [{ op: 'set', target, path, value }] };
    const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
    const res = await runCommand({ doc, selection: [], utterance: `сними ${path}`, provider, engine, activeArtboardId: 'screen' });
    assert.equal(res.error, undefined, `${path}: ${JSON.stringify(res.error)}`);
    assert.equal(res.ops.length, 1, path);
    assert.equal(res.ops[0].value, undefined, path);
    assert.equal(res.preview.doc.nodes[id][path], undefined, `${path} снят`);
  }
});

test('круг13 п.1: снять то, чего и так нет, — не ошибка, но об этом говорят', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Шапка', path: 'fill', value: 'нет' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери фон у шапки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.match(res.warnings.join(' | '), /и так нет|уже нет/i, res.warnings.join(' | '));
});

test('круг13 п.1: снятие описано в промпте патча и в подсказке схемы', () => {
  const doc = makeDoc13();
  const text = PROMPTS.patch({
    digest: describeDoc(doc, ['screen']), tokens: '', scope: 'активный артборд', engine: 'core',
    guess: 'edit', placement: 'в «Маршрут дня»', checks: '',
  });
  assert.match(text, /снять|убрать/i, 'в правилах путей сказано, как снять свойство');
  assert.match(text, /"none"|«none»|value\s*(отсутству|не\s*указ)/i, text.slice(0, 200));
  assert.match(SCHEMAS.patch.hint, /снять/i, SCHEMAS.patch.hint);
});

/* п.2 — remove с path не сносит узел */

test('круг13 п.1: правка вовсе без value — это тоже «снять», и об этом говорят', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Пункт · Обед с командой', path: 'fill' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери фон у карточки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].value, undefined);
  assert.equal(res.preview.doc.nodes.item0.fill, undefined);
  assert.match(res.warnings.join(' | '), /значения в ней не было/, res.warnings.join(' | '));
});

test('круг13 п.2: {op:"remove", path:"fill"} снимает заливку, а не удаляет узел', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const was = Object.keys(doc.nodes).length;
  const patch = { edits: [{ op: 'remove', target: 'Пункт · Обед с командой', path: 'fill' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери фон у карточки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(!res.ops.some((o) => o.op === 'remove'), JSON.stringify(res.ops));
  assert.equal(Object.keys(res.preview.doc.nodes).length, was, 'ни одного узла не потеряли');
  assert.equal(res.preview.doc.nodes.item0.fill, undefined);
});

test('круг13 п.2: remove с путём, который снять нельзя, отклоняется, а не сносит узел', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'remove', target: 'Заголовок экрана', path: 'characters' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери текст заголовка', provider, engine, activeArtboardId: 'screen' });
  assert.ok(!res.ops.some((o) => o.op === 'remove' && o.id === 'headTitle'), JSON.stringify(res.ops));
  const all = [res.error && res.error.message, ...(res.warnings || [])].join(' | ');
  // круг 16, п.9: поле названо словом «текст», внутреннего «characters» человек не видит
  assert.match(all, /текст слоя снять нельзя/, all);
  assert.ok(!/characters/.test(all), 'внутреннего имени поля нет: ' + all);
});

test('круг13 п.1: в новом узле fill:"none" — это «без заливки», а не неизвестный цвет', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Собрал плашку', summary: 'Плашка.', steps: ['Плашка'], targets: [] },
    tree: {
      type: 'frame', name: 'Плашка', fill: 'none', stroke: 'прозрачный', size: { w: 'fill', h: 'hug' },
      layout: { mode: 'column', gap: 8 },
      children: [{ type: 'text', name: 'Строка', text: 'Готово', style: 'body', color: 'нет' }],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'добавь плашку без фона', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const made = res.ops.map((o) => o.node);
  assert.equal(made[0].fill, undefined, 'заливки нет');
  assert.equal(made[0].stroke, undefined, 'обводки нет');
  assert.equal(made[1].color, undefined, 'цвета текста нет');
  assert.ok(!/неизвестный цвет/i.test(res.warnings.join(' | ')), res.warnings.join(' | '));
});

/* п.3 — вложенное выделение */

test('круг13 п.3: выделение фрейма и его же текста — это один узел области', () => {
  const doc = makeDoc13();
  const scope = resolveScope(doc, ['btn', 'btnText'], null, { selectionBy: 'agent' });
  assert.deepEqual(scope.ids, ['btn'], 'потомок выделенного отброшен');
  assert.deepEqual(scope.nested, ['btnText'], 'но названо, что именно отброшено');
  // одиночное выделение и несколько несвязанных узлов работают как раньше
  assert.deepEqual(resolveScope(doc, ['btnText'], null).ids, ['btnText']);
  assert.deepEqual(resolveScope(doc, ['head', 'btn'], null).ids, ['head', 'btn']);
});

test('круг13 п.3: кандидат не задваивается и «подходит слоёв — 2» больше не врёт', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const scope = resolveScope(doc, ['btn', 'btnText'], engine, { selectionBy: 'agent' });
  assert.deepEqual(refCandidates(engine, doc, 'Подпись кнопки', scope, {}).ids, ['btnText']);

  const patch = { edits: [{ op: 'set', target: 'Подпись кнопки', path: 'style', value: 'h2' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: ['btn', 'btnText'], utterance: 'а надпись сделай крупнее',
    provider, engine, activeArtboardId: 'screen', selectionBy: 'agent',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(!/подходит слоёв/.test(res.warnings.join(' | ')), res.warnings.join(' | '));
  assert.equal(res.ops.length, 1);
});

test('круг13 п.3: групповая правка вложенного выделения не даёт двух одинаковых операций', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'nudge', target: 'Подпись кнопки', dx: 4 }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: ['btn', 'btnText'], utterance: 'сдвинь все надписи вправо',
    provider, engine, activeArtboardId: 'screen', selectionBy: 'agent',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1, JSON.stringify(res.ops));
});

test('круг13 п.3: duplicate «selection» не делает лишнюю копию ребёнка', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'duplicate', target: 'selection' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: ['btn', 'btnText'], utterance: 'продублируй это',
    provider, engine, activeArtboardId: 'screen', selectionBy: 'agent',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const creates = res.ops.filter((o) => o.op === 'create');
  assert.equal(creates.length, 2, 'копия кнопки и копия её подписи: ' + JSON.stringify(creates.map((o) => o.node.name)));
  assert.equal(Object.keys(res.preview.doc.nodes).length, Object.keys(doc.nodes).length + 2);
});

/* п.4 — текст для модели не утекает в ленту стадий */

test('круг13 п.4: стадия «Чиню» не показывает человеку команду, адресованную модели', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  /* Круг 15, п.6: пустой правкой тут был set, совпавший с текущим значением, — а такую
   * правку починка больше не трогает (документ не мог измениться, чинить нечего). Берём
   * другое «ничего не изменилось»: перенос узла туда, где он и так лежит. */
  const same = { edits: [{ op: 'move', target: 'Заголовок экрана', parent: 'Шапка', index: 0 }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const stages = [];
  await runCommand({
    doc, selection: [], utterance: 'напиши в заголовке то же самое', provider, engine,
    activeArtboardId: 'screen', onStage: (s) => stages.push(s),
  });
  const repair = stages.filter((s) => s.stage === 'repair');
  assert.ok(repair.length, 'стадия починки была');
  const text = repair.map((s) => `${s.label} ${s.detail || ''}`).join(' | ');
  assert.ok(!/Выбери|по id из выжимки/i.test(text), text);
  assert.match(text, /\p{L}{4}/u, text);
  // а модель по-прежнему получает свой текст
  const repairTurn = provider.calls[provider.calls.length - 1].messages.map((m) => m.content).join('\n');
  assert.match(repairTurn, /документ не изменился/i, repairTurn.slice(-400));
});

/* п.5 — remove родителя и потомка в одном патче */

test('круг13 п.5: «убери шапку и заголовок» не валит транзакцию сырым id', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = {
    edits: [
      { op: 'remove', target: 'Шапка' },
      { op: 'remove', target: 'Заголовок экрана' },
    ],
  };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери шапку и заголовок', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['head'], JSON.stringify(res.ops));
  const w = res.warnings.join(' | ');
  assert.match(w, /Шапка/, w);
  assert.equal(warningRank(res.warnings[0]), 0, 'о пропущенной правке человек узнаёт первым: ' + w);
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 1, 'починка не понадобилась');
});

test('круг13 п.5: один и тот же узел в двух remove — одна операция', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'remove', target: 'Аватар' }, { op: 'remove', target: '#avatar' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери аватар', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['avatar']);
});

/* п.6 — бесконечность в clampPx */

test('круг13 п.6: clampPx о бесконечности и NaN говорит по-русски, а не «null»', () => {
  for (const bad of [Infinity, -Infinity, NaN]) {
    const said = [];
    assert.equal(clampPx(bad, (m) => said.push(m), 'Правка radius'), undefined);
    assert.ok(!/null/.test(said.join(' ')), `${bad}: ${said.join(' ')}`);
    assert.match(said.join(' '), /\p{L}{4}/u, String(bad));
  }
  const said = [];
  clampPx(undefined, (m) => said.push(m), 'Правка radius');
  assert.ok(!/undefined/.test(said.join(' ')), said.join(' '));
  // строка по-прежнему называется как есть
  const s2 = [];
  clampPx('восемь', (m) => s2.push(m), 'Правка radius');
  assert.match(s2.join(' '), /«восемь» — не число/, s2.join(' '));
});

/* п.7 — «варианты шапки» без числа */

test('круг13 п.7: «варианты шапки» и «покажи варианты кнопки» перехватываются локально', () => {
  const doc = makeDoc13();
  for (const [s, subj] of [
    ['варианты шапки', 'Шапка'],
    ['покажи варианты кнопки', 'Кнопка «Добавить пункт»'],
    ['варианты шапки сводки', 'Шапка сводки'],
    ['дай варианты аватара', 'Аватар'],
    ['варианты шапки, пожалуйста', 'Шапка'],
    ['два варианта шапки', 'Шапка'],
  ]) {
    const got = recognizeVariants(s, { doc });
    assert.ok(got, s);
    assert.equal(got.variantsOf, '', s);
    assert.equal(got.subject, subj, s);
  }
});

test('круг13 п.7: ловушки локального распознавания вариантов — ни одного срабатывания', () => {
  const doc = makeDoc13();
  const traps = [
    'покажи варианты оплаты',
    'добавь вариант оплаты картой',
    'в этом варианте поменяй цвет',
    'вариант с подпиской — основной',
    'сколько вариантов?',
    'варианты доставки перечисли в списке',
    'напиши варианты ответов',
    'добавь варианты в карточку',
    'убери варианты из списка',
    'этот вариант мне нравится',
    'вариант оплаты нужен второй',
    'подпиши варианты цифрами',
    'варианты оплаты сделай крупнее',
    'сделай текст варианта жирным',
    'в вариантах доставки поменяй порядок',
    'вариантность тут не нужна',
    'поменяй вариант на первый',
    'вариант доставки курьером добавь',
    'покажи мне карточку',
    'сделай шапку компактнее',
    'перекрась кнопку в зелёный',
    'убери фон у карточки',
    'иначе кнопка не видна',
    'разные способы оплаты добавь',
    'три пункта добавь в список',
    'покажи два аватара',
    'варианты',
  ];
  for (const s of traps) {
    const got = recognizeVariants(s, { doc });
    if (s === 'варианты') { assert.deepEqual(got, { variantsOf: '' }, s); continue; }
    assert.equal(got, null, `ложное срабатывание: ${s} → ${JSON.stringify(got)}`);
  }
});

/* п.8 — три варианта дешевле шести вызовов */

test('круг13 п.8: три варианта — один план и три генерации, а не шесть вызовов', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  // значения заведомо ОТЛИЧНЫЕ от текущего зазора (8): иначе правка «ничего не меняет» и
  // честно уходит в починку — а тест считает вызовы модели
  const patch = (gap) => ({ edits: [{ op: 'set', target: 'Список пунктов', path: 'layout.gap', value: String(gap) }] });
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: [patch(4), patch(12), patch(24), patch(16), patch(20), patch(32)],
  });
  const list = await runVariants({ doc, selection: [], utterance: 'сделай список плотнее', provider, engine, n: 3, activeArtboardId: 'screen' });
  assert.equal(list.length, 3);
  const plans = provider.calls.filter((c) => c.schema === 'plan').length;
  const gens = provider.calls.filter((c) => c.schema === 'patch').length;
  assert.equal(plans, 1, `план считается один раз, а не ${plans}`);
  assert.equal(gens, 3, `генераций ровно по числу вариантов, а не ${gens}`);
  assert.ok(list.every((v) => v.plan && v.plan.title), 'у каждого варианта есть план для карточки');
  assert.ok(list.every((v) => !v.error), JSON.stringify(list.map((v) => v.error)));
});

test('круг13 п.8: оси вариантов разведены заранее — «сделай иначе» больше не нужно', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Список пунктов', path: 'layout.gap', value: '24' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch, patch, patch, patch, patch] });
  await runVariants({ doc, selection: [], utterance: 'сделай список плотнее', provider, engine, n: 3, activeArtboardId: 'screen' });
  const gen = provider.calls.filter((c) => c.schema === 'patch');
  assert.equal(gen.length, 3);
  const prompts = gen.map((c) => c.messages.map((m) => m.content).join('\n'));
  // у каждого своя ось и упомянуты чужие — но как чужие
  for (let i = 0; i < 3; i++) {
    assert.match(prompts[i], new RegExp(`ТВОЙ ВАРИАНТ — ${i + 1}-Й`), prompts[i].slice(0, 300));
    assert.match(prompts[i], /чуж|не\s+повторяй|а не твоё задание/i, 'чужие оси помечены чужими');
  }
  assert.notEqual(prompts[0], prompts[1]);
  assert.notEqual(prompts[1], prompts[2]);
});

test('круг13 п.8: переспрос и «так нельзя» на общем плане не множатся на три', async () => {
  const doc = makeDoc13();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: { intent: 'clarify', title: 'Не разобрал', summary: 'Непонятно', steps: ['спросить'], targets: [], clarify: 'Что именно поменять?' },
  });
  const list = await runVariants({ doc, selection: [], utterance: 'ну это самое с этим', provider, engine, n: 3, activeArtboardId: 'screen' });
  assert.equal(list.length, 1, 'один переспрос, а не три');
  assert.equal(list[0].clarify, 'Что именно поменять?');
  assert.equal(provider.calls.length, 1, 'и ровно один вызов модели');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Круг 15
 * ──────────────────────────────────────────────────────────────────────────── */

/** Демо круга 15: к документу круга 13 добавлена «Карточка встречи» — по ней ловятся
 *  просьбы, в которых «карточку» назвали МЕСТОМ, а не предметом вариантов. */
function makeDoc15() {
  const doc = makeDoc13();
  doc.nodes.card = {
    type: 'frame', id: 'card', name: 'Карточка встречи', parent: 'screen', children: ['cardTitle'],
    layout: { mode: 'column', gap: 12, padding: { t: 12, r: 12, b: 12, l: 12 }, align: 'stretch', justify: 'start', wrap: false },
    size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, fill: 'bg', radius: 12,
  };
  doc.nodes.cardTitle = {
    type: 'text', id: 'cardTitle', name: 'Название встречи', parent: 'card', characters: 'Встреча с командой',
    style: 'h2', align: 'left', size: { w: { mode: 'fill' }, h: { mode: 'hug' } },
  };
  doc.nodes.screen.children = doc.nodes.screen.children.concat(['card']);
  return doc;
}

/* п.1 — живые просьбы о вариантах, которые уходили обычной правкой */

test('круг15 п.1: «покажи варианты оформления кнопки» и родня — это просьба о вариантах', () => {
  const doc = makeDoc15();
  for (const s of [
    'покажи варианты оформления кнопки',
    'предложи три идеи для кнопки',
    'покажи альтернативы',
    'какие есть варианты?',
  ]) {
    const got = recognizeVariants(s, { doc });
    assert.ok(got, `не распознано: ${s}`);
    assert.equal(got.variantsOf, '', s);
  }
});

test('круг15 п.1: двадцать три живые формулировки просьбы о вариантах — все локально', () => {
  const doc = makeDoc15();
  const said = [
    'покажи три варианта', 'дай варианты', 'ещё варианты', 'покажи ещё три варианта',
    'варианты этого же', 'покажи пару вариантов, пожалуйста', 'варианты, пожалуйста',
    'а если иначе', 'по-другому', 'а по-другому можно', 'а можно как-то по-другому?',
    'покажи другие решения', 'дай другие решения', 'покажи три решения', 'предложи другие версии',
    'а как ещё можно', 'покажи по-разному', 'варианты шапки', 'покажи варианты кнопки',
    'покажи варианты оформления кнопки', 'предложи три идеи для кнопки', 'покажи альтернативы',
    'какие есть варианты?',
  ];
  assert.equal(said.length, 23, 'проверяем ровно 23 формулировки');
  for (const s of said) assert.ok(recognizeVariants(s, { doc }), `не распознано: ${s}`);
});

/* п.2 — предлог места в предмете: «три варианта оплаты в карточку» */

test('круг15 п.2: «три варианта оплаты в карточку» — не просьба о вариантах «Карточки встречи»', () => {
  const doc = makeDoc15();
  assert.equal(recognizeVariants('три варианта оплаты в карточку', { doc }), null);
  assert.equal(recognizeVariants('два варианта оплаты в карточке', { doc }), null);
  assert.equal(recognizeVariants('покажи варианты оплаты в карточке', { doc }), null);
});

test('круг15 п.2: тридцать пять ловушек локального распознавания — ни одного срабатывания', () => {
  const doc = makeDoc15();
  const traps = [
    'три варианта оплаты в карточку', 'добавь вариант оплаты картой', 'покажи варианты оплаты',
    'в этом варианте поменяй цвет', 'вариант с подпиской — основной', 'сколько вариантов?',
    'варианты доставки перечисли в списке', 'напиши варианты ответов', 'добавь варианты в карточку',
    'убери варианты из списка', 'этот вариант мне нравится', 'вариант оплаты нужен второй',
    'подпиши варианты цифрами', 'варианты оплаты сделай крупнее', 'сделай текст варианта жирным',
    'в вариантах доставки поменяй порядок', 'вариантность тут не нужна', 'поменяй вариант на первый',
    'вариант доставки курьером добавь', 'покажи мне карточку', 'сделай шапку компактнее',
    'перекрась кнопку в зелёный', 'убери фон у карточки', 'иначе кнопка не видна',
    'разные способы оплаты добавь', 'три пункта добавь в список', 'покажи два аватара',
    'два варианта оплаты добавь в карточку', 'сколько вариантов у кнопки?', 'дай выбор тарифов',
    'покажи варианты доставки', 'иначе не влезет', 'верни как было', 'другой экран сделай',
    'напиши в подписи «вариант Б»',
  ];
  assert.ok(traps.length >= 35, `ловушек ${traps.length}`);
  for (const s of traps) {
    assert.equal(recognizeVariants(s, { doc }), null, `ложное срабатывание: ${s} → ${JSON.stringify(recognizeVariants(s, { doc }))}`);
  }
});

/* п.3 — «в документе поменялось, а на экране — нет» не выдумывает механизм */

test('круг15 п.3: «в две колонки» при детях «fill» объясняется детьми, а не «раскладка не использует»', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = {
    edits: [
      { op: 'set', target: 'Список пунктов', path: 'layout.mode', value: 'row' },
      { op: 'set', target: 'Список пунктов', path: 'layout.wrap', value: 'true' },
    ],
  };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай список в две колонки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  assert.match(w, /fill|во всю ширину/i, 'причина — растянутые дети: ' + w);
  assert.ok(!/такое значение не использует/.test(w), 'догадка про раскладку убрана: ' + w);
});

test('круг15 п.3: без доказанной причины механизм не выдумывается', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Аватар', path: 'size.w', value: '56' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: ['avatar'], utterance: 'сделай аватар шире', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /на экране — нет/, w);
  assert.ok(!/такое значение не использует/.test(w), 'механизма мы не знаем — и не называем: ' + w);
  assert.ok(!/раскладка/i.test(w), w);
  assert.match(w, /скажите иначе/i, w);
});

/* п.6 — заведомо пустая правка не тратит вызов на починку */

test('круг15 п.6: правка, совпавшая с текущим значением, не зовёт модель второй раз', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const same = { edits: [{ op: 'set', target: 'Показатель · Задач закрыто', path: 'radius', value: '12' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const res = await runCommand({ doc, selection: [], utterance: 'поставь скругление 12', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 1, 'починки не было');
  const w = res.warnings.join(' | ');
  assert.match(w, /ни на что не повлияла/i, w);
  assert.match(w, /уже/i, 'сказано, что значение уже такое: ' + w);
});

test('круг15 п.6: «убери фон у шапки», когда фона и не было, — тоже один вызов', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Шапка', path: 'fill', value: 'нет' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'убери фон у шапки', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 1, 'починки не было');
  assert.match(res.warnings.join(' | '), /и так нет|уже нет/i, res.warnings.join(' | '));
});

/* п.7 — групповая правка раскрывается на однотипных соседей */

test('круг15 п.7: «сделай все пункты акцентными» правит все три, хотя модель назвала один', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Пункт · Обед с командой', path: 'fill', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай все пункты акцентными', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id).sort(), ['item0', 'item1', 'item2']);
  assert.match(res.warnings.join(' | '), /так(ие|их) же|все три|правлю все/i, res.warnings.join(' | '));
});

test('круг15 п.7: без групповой формулировки один названный узел остаётся один', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Пункт · Обед с командой', path: 'fill', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай первый пункт акцентным', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['item0']);
});

test('круг15 п.7: «сделай все заголовки крупнее» не красит соседний текст другого рода', async () => {
  const doc = makeDoc7();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h2' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай все заголовки мельче', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(!res.ops.some((o) => o.id === 'headDate'), '«Дата» — не заголовок: ' + JSON.stringify(res.ops));
});

/* п.4 — предупреждение про общую тему говорит про то, что поменялось */

test('круг15 п.4: чисто типографическая тема не советует «менять заливку узлов»', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const theme = { type: [{ name: 'h1', font: 'Georgia' }, { name: 'body', font: 'Georgia' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Сменил шрифт', summary: 'Georgia.', steps: ['Токены'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'поменяй шрифт на Georgia', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /оформление документа общее/i, w);
  assert.match(w, /шрифт/i, 'сказано, что поменялась типографика: ' + w);
  assert.ok(!/заливку/i.test(w), 'про заливку речи не было: ' + w);
  assert.ok(!/перекрасить/i.test(w), w);
});

test('круг15 п.4 (с круга 48 — совет про тему экрана): цветовая тема документа советует, как перекрасить один экран', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const theme = { colors: [{ name: 'bg', value: '#101418' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Затемнил', summary: 'Тёмная.', steps: ['Токены'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай только этот экран тёмным', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /цвета/i, w);
  assert.match(w, /сделай только этот экран[\s\S]*собственную тему/i, w);
});

test('круг15 п.4: шкала отступов не притворяется перекраской', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const theme = { spacing: [4, 8, 16, 24, 40] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Шкала', summary: 'Отступы.', steps: ['Токены'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай шкалу отступов просторнее', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  assert.match(w, /шкала отступов/i, w);
  assert.ok(!/перекрасить/i.test(w), w);
});

/* п.5 — лишняя починка на последствиях просьбы человека */

/** Валидатор-заглушка: белый текст на акцентном фоне — низкий контраст. */
const contrastEngine = () => makeStubEngine({
  violations: (d) => Object.keys(d.nodes)
    .filter((id) => {
      const n = d.nodes[id];
      if (!n || n.type !== 'text' || n.color !== 'bg') return false;
      const p = d.nodes[n.parent];
      return !!p && p.fill === 'accent';
    })
    .map((id) => ({ code: 'low-contrast', nodeId: id, message: 'контраст 2.10:1 при норме 4.5:1', severity: 'warn' })),
});

test('круг15 п.5: «сделай кнопку зелёной» не тратит вызов на починку контраста', async () => {
  const doc = makeDoc3();
  delete doc.nodes.btn.fill;                       // нарушение появится только от нашей правки
  const engine = contrastEngine();
  const patch = { edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'fill', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай кнопку зелёной', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 1, 'починки не было');
  assert.equal(res.preview.doc.nodes.btn.fill, 'accent', 'просьбу выполнили как просили');
  const w = res.warnings.join(' | ');
  assert.match(w, /контраст/i, 'про контраст человеку всё равно сказали: ' + w);
  assert.ok(!/Починка/i.test(w), 'служебных строк о починке в ленте нет: ' + w);
  assert.equal(res.serviceNotes, undefined, JSON.stringify(res.serviceNotes));
});

test('круг15 п.5: контраст НЕ по просьбе человека по-прежнему чинится', async () => {
  const doc = makeDoc3();
  delete doc.nodes.btn.fill;
  const engine = contrastEngine();
  // человек просил про размер, а модель заодно перекрасила — это промах, его чинят
  const patch = { edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'fill', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай кнопку выше', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 2, 'починка была');
});

test('круг15 п.5: не про контраст — чинится даже при просьбе о цвете', async () => {
  const doc = makeDoc3();
  delete doc.nodes.btn.fill;                       // нарушение появится только от нашей правки
  const engine = makeStubEngine({
    violations: (d) => (d.nodes.btn && d.nodes.btn.fill === 'accent'
      ? [{ code: 'zero-size', nodeId: 'btn', message: 'нулевой размер (0×0)', severity: 'warn' }] : []),
  });
  const patch = { edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'fill', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'перекрась кнопку в зелёный', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 2, 'нулевой размер — не следствие просьбы о цвете');
});

/* п.8 — выжимка не обещает того, чего нет */

test('круг15 п.8: свёрнутые узлы не обещают «спроси подробности»', () => {
  const doc = makeDoc5();
  const digest = describeDoc(doc, ['screen'], { limit: 900 });
  assert.ok(/свёрнуто|скрыто/.test(digest), digest.slice(-300));
  assert.ok(!/спроси/i.test(digest), 'обещания несуществующей операции нет: ' + digest.slice(-400));
  assert.match(digest, /по имени|по всему документу/i, digest.slice(-400));
});

/* п.9 — style строкой стирает надстройки */

test('круг15 п.9: подмена style строкой предупреждает о потерянных надстройках', async () => {
  const doc = makeDoc3();
  doc.nodes.headTitle.style = { token: 'h1', fontWeight: 600, letterSpacing: 0.4 };
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h2' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок мельче', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const w = res.warnings.join(' | ');
  // круг 16, п.9: надстройки названы словами инспектора — «жирность», «трекинг»
  assert.match(w, /жирность/, w);
  assert.match(w, /трекинг/, w);
  assert.ok(!/fontWeight|letterSpacing/.test(w), 'внутренних имён нет: ' + w);
  assert.match(w, /снимаются|снимутся|теряются/i, w);
});

test('круг15 п.9: style без надстроек меняется молча', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h2' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок мельче', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(!/жирность|fontWeight/.test(res.warnings.join(' | ')), res.warnings.join(' | '));
});

/* п.10 — размер съедает отступ контейнера */

test('круг15 п.10: ширина больше внутренней области родителя признаётся словами', () => {
  const doc = makeDoc3();
  doc.nodes.screen.layout.padding = { t: 20, r: 20, b: 20, l: 20 };
  const geo = { rects: { screen: { x: 0, y: 0, w: 390, h: 800 }, btn: { x: 20, y: 400, w: 350, h: 48 } }, lines: {}, order: [] };
  const said = [];
  const got = coerceValue('370', 'size.w', doc, (m) => said.push(m), { id: 'btn', geo });
  assert.deepEqual(got, { mode: 'fixed', value: 370 }, 'правка применяется — решать за человека нельзя');
  const w = said.join(' | ');
  assert.match(w, /350/, 'названа свободная ширина: ' + w);
  assert.match(w, /отступ/i, w);
  assert.match(w, /Маршрут дня/, 'назван контейнер: ' + w);
});

test('круг15 п.10: ширина ровно по внутренней области молчит', () => {
  const doc = makeDoc3();
  doc.nodes.screen.layout.padding = { t: 20, r: 20, b: 20, l: 20 };
  const geo = { rects: { screen: { x: 0, y: 0, w: 390, h: 800 }, btn: { x: 20, y: 400, w: 350, h: 48 } }, lines: {}, order: [] };
  const said = [];
  coerceValue('350', 'size.w', doc, (m) => said.push(m), { id: 'btn', geo });
  assert.deepEqual(said, [], said.join(' | '));
  // и у родителя, который обнимает содержимое, предупреждать не о чем
  const hug = makeDoc3();
  hug.nodes.screen.size = { w: { mode: 'hug' }, h: { mode: 'hug' } };
  hug.nodes.screen.layout.padding = { t: 20, r: 20, b: 20, l: 20 };
  const s2 = [];
  coerceValue('370', 'size.w', hug, (m) => s2.push(m), { id: 'btn', geo });
  assert.deepEqual(s2, [], s2.join(' | '));
});

test('круг15 п.6: «менять нечего» приходит оболочке отдельным полем', async () => {
  const doc = makeDoc3();
  const engine = makeStubEngine();
  const same = { edits: [{ op: 'set', target: 'Показатель · Задач закрыто', path: 'radius', value: '12' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const res = await runCommand({ doc, selection: [], utterance: 'поставь скругление 12', provider, engine, activeArtboardId: 'summary' });
  assert.equal(res.nothingToChange, true);
  // а «правка легла не туда» этим полем не помечается
  const doc2 = makeDoc3();
  const move = { edits: [{ op: 'move', target: 'Заголовок экрана', parent: 'Шапка', index: 0 }] };
  const p2 = makeFakeProvider({ plan: PLAN_EDIT3, patch: [move, move] });
  const res2 = await runCommand({ doc: doc2, selection: [], utterance: 'перенеси заголовок в шапку', provider: p2, engine, activeArtboardId: 'screen' });
  assert.equal(res2.nothingToChange, undefined, JSON.stringify(res2.warnings));
});

/* ────────────────────────────────────────────────────────────────────────────
 * 18. Круг 16: пустая правка в двух формах, лишний круг починки, негодная палитра,
 *     отличимость вариантов, время заголовка плана, служебные записи, сужение цели,
 *     «повторять нечего» и человеческие слова вместо внутренних имён
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Демо круга 16: у текстов стиль лежит ОБЪЕКТОМ ({token}), как его хранит core, у аватара —
 * объектная обводка. Второй такой же документ, но с уже нормализованными строками, строится
 * функцией ниже: проверять надо ОБА состояния (ядро в этом круге правят параллельно).
 */
function makeDoc16() {
  const doc = makeDoc13();
  doc.nodes.sumTitle.style = { token: 'h1' };
  doc.nodes.headTitle.style = { token: 'h1', fontWeight: 600, letterSpacing: 0.4 };
  doc.nodes.avatar.stroke = { color: 'muted', width: 1 };
  doc.nodes.time0.color = 'muted';
  /* Отдельный токен для подписи на акценте — как в настоящем демо-документе. Один и тот же
   * токен и заливкой, и цветом текста агент сознательно не чинит: он двигал бы обе стороны
   * контраста сразу (см. repairPalette). */
  doc.tokens.colors.onAccent = '#ffffff';
  doc.nodes.btnText.color = 'onAccent';
  return doc;
}
/** Тот же документ, но оформление уже строками — как его отдаёт «старое» ядро. */
function makeDoc16Flat() {
  const doc = makeDoc16();
  doc.nodes.sumTitle.style = 'h1';
  doc.nodes.avatar.stroke = 'muted';
  return doc;
}

/* п.1 — заведомо пустая правка в другой ФОРМЕ значения */

test('круг16 п.1: set style="h1" при style {token:"h1"} — это «менять нечего», в любой форме узла', async () => {
  for (const [what, make] of [['объект', makeDoc16], ['строка', makeDoc16Flat]]) {
    const doc = make();
    const engine = makeStubEngine();
    const same = { edits: [{ op: 'set', target: 'Заголовок сводки', path: 'style', value: 'h1' }] };
    const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
    const res = await runCommand({
      doc, selection: [], utterance: 'сделай заголовок сводки крупным', provider, engine, activeArtboardId: 'summary',
    });
    assert.equal(res.error, undefined, what + ': ' + JSON.stringify(res.error));
    assert.equal(res.nothingToChange, true, what + ': ' + res.warnings.join(' | '));
    /* Поле должно приходить и тогда, когда ядро оставило значение строкой: отпечаток
     * документа при этом расходится, и без поля оболочка примет пустую правку за работу. */
    assert.equal(res.nothingChanged, true, what + ': оболочке нужен факт, а не отпечаток');
    assert.equal(provider.calls.filter((c) => c.schema === 'patch').length, 1, what + ': починки быть не должно');
    const w = res.warnings.join(' | ');
    assert.match(w, /стиль текста уже/, what + ': ' + w);
    assert.match(w, /менять нечего/, what + ': ' + w);
  }
});

test('круг16 п.1: обводка строкой при объектной обводке той же ширины — тоже пустая правка', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine();
  const same = { edits: [{ op: 'set', target: 'Аватар', path: 'stroke', value: 'muted' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const res = await runCommand({ doc, selection: [], utterance: 'обведи аватар тонкой линией', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.nothingToChange, true, res.warnings.join(' | '));
  assert.match(res.warnings.join(' | '), /обводка уже/, res.warnings.join(' | '));

  /* Круг 16, поправка: при том же цвете строка НЕ сбрасывает толщину — ядро оставляет поле
   * байт в байт (core.keepFieldForm), поэтому и при width 3 менять нечего. */
  const doc15 = makeDoc16();
  doc15.nodes.avatar.stroke = { color: 'muted', width: 3 };
  const p15 = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const res15 = await runCommand({ doc: doc15, selection: [], utterance: 'обведи аватар тонкой линией', provider: p15, engine, activeArtboardId: 'screen' });
  assert.equal(res15.nothingToChange, true, 'толщина цела, имя цвета то же: ' + res15.warnings.join(' | '));

  // а ДРУГОЙ цвет — настоящая правка
  const doc2 = makeDoc16();
  const other = { edits: [{ op: 'set', target: 'Аватар', path: 'stroke', value: 'accent' }] };
  const p2 = makeFakeProvider({ plan: PLAN_EDIT3, patch: [other, other] });
  const res2 = await runCommand({ doc: doc2, selection: [], utterance: 'обведи аватар акцентом', provider: p2, engine, activeArtboardId: 'screen' });
  assert.equal(res2.nothingToChange, undefined, res2.warnings.join(' | '));
  assert.ok(!/обводка уже/.test(res2.warnings.join(' | ')), res2.warnings.join(' | '));
});

test('круг16 п.1: тот же токен поверх надстроек — пустая правка, и о потере молчим', async () => {
  /* Ядро при совпадающем имени токена оставляет поле байт в байт: надстройки fontWeight и
   * letterSpacing целы. Значит менять нечего — и говорить «они снимаются» нельзя, это ложь. */
  const doc = makeDoc16();                         // headTitle: {token:"h1", fontWeight, letterSpacing}
  const engine = makeStubEngine();
  const same = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h1' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
  const res = await runCommand({ doc, selection: [], utterance: 'поставь заголовку стиль h1', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.nothingToChange, true, 'надстройки целы, токен тот же: ' + res.warnings.join(' | '));
  const w = res.warnings.join(' | ');
  assert.match(w, /стиль текста уже/, w);
  assert.ok(!/снимаются/.test(w), 'надстройки не снялись — говорить о потере нельзя: ' + w);
  assert.ok(!/жирность/.test(w), w);
});

test('круг16 п.1: ДРУГОЙ токен поверх надстроек — настоящая правка, и о потере говорим', async () => {
  const doc = makeDoc16();                         // headTitle: {token:"h1", fontWeight, letterSpacing}
  const engine = makeStubEngine();
  const other = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h2' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [other, other] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай заголовок мельче', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.nothingToChange, undefined, 'токен другой — правка настоящая');
  const w = res.warnings.join(' | ');
  assert.ok(!/стиль текста уже/.test(w), 'о пустой правке говорить нельзя: ' + w);
  assert.match(w, /жирность/, 'о потере надстроек сказано: ' + w);
  assert.match(w, /снимаются/, w);
});

test('круг16 п.1: значение по умолчанию равно отсутствию поля — прозрачность 1 и обрезка «нет»', async () => {
  const engine = makeStubEngine();
  const cases = [
    ['Список пунктов', 'opacity', 1],
    ['Список пунктов', 'clip', false],
  ];
  for (const [target, path, value] of cases) {
    const doc = makeDoc16();
    delete doc.nodes.list.opacity;
    delete doc.nodes.list.clip;
    const same = { edits: [{ op: 'set', target, path, value }] };
    const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [same, same] });
    const res = await runCommand({ doc, selection: [], utterance: 'сделай список как есть', provider, engine, activeArtboardId: 'screen' });
    assert.equal(res.nothingToChange, true, `${path}: ` + res.warnings.join(' | '));
  }
  // а прозрачность 0.5 у узла без прозрачности — настоящая правка
  const doc = makeDoc16();
  delete doc.nodes.list.opacity;
  const real = { edits: [{ op: 'set', target: 'Список пунктов', path: 'opacity', value: 0.5 }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [real, real] });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай список полупрозрачным', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.nothingToChange, undefined, res.warnings.join(' | '));
});

/* п.2 — «акцентными» — это просьба о цвете */

test('круг16 п.2: «все пункты сделай акцентными» не тратит круг починки', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine({
    violations: (d) => Object.keys(d.nodes)
      .filter((id) => d.nodes[id].name === 'Время' && d.nodes[d.nodes[id].parent] && d.nodes[d.nodes[id].parent].fill === 'accent')
      .map((id) => ({ code: 'low-contrast', nodeId: id, message: 'контраст 2.17:1 при норме 4.5:1', severity: 'warn' })),
  });
  const patch = { edits: [{ op: 'set', target: 'Пункт · Обед с командой', path: 'fill', value: 'accent' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'все пункты сделай акцентными', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(provider.calls.length, 2, 'ровно два вызова: план и правка — ' + provider.calls.map((c) => c.schema).join('+'));
  assert.ok(!(res.serviceNotes || []).some((n) => /Починка/.test(n)), JSON.stringify(res.serviceNotes));
  assert.match(res.warnings.join(' | '), /контраст/i, 'замечание человеку всё равно сказано');
});

test('круг16 п.2: модель покрасила СВОИМ цветом больше, чем просили — починка обязана быть', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine({
    violations: (d) => (d.nodes.btnText.color === '#fdfdfd'
      ? [{ code: 'low-contrast', nodeId: 'btnText', message: 'контраст 1.20:1 при норме 4.5:1', severity: 'warn' }]
      : []),
  });
  const patch = {
    edits: [
      { op: 'set', target: 'Пункт · Обед с командой', path: 'fill', value: 'accent' },
      { op: 'set', target: 'Подпись кнопки', path: 'color', value: '#fdfdfd' },
    ],
  };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const seen = [];
  const res = await runCommand({
    doc, selection: [], utterance: 'сделай пункты акцентными', provider, engine,
    activeArtboardId: 'screen', onStage: (s) => seen.push(s.stage),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(seen.includes('repair'), 'лишний цвет — промах модели, его чиним: ' + seen.join(','));
});

test('круг16 п.2: два названных цвета — два цвета в ответе, починка не нужна', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine({
    violations: () => [{ code: 'low-contrast', nodeId: 'btnText', message: 'контраст 1.20:1 при норме 4.5:1', severity: 'warn' }],
  });
  const patch = {
    edits: [
      { op: 'set', target: 'Подпись кнопки', path: 'color', value: '#ffffff' },
      { op: 'set', target: 'Время', path: 'color', value: '#9a9a9a' },
    ],
  };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const seen = [];
  const res = await runCommand({
    doc, selection: [], utterance: 'подпись кнопки сделай белой, а время серым', provider, engine,
    activeArtboardId: 'screen', onStage: (s) => seen.push(s.stage),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(!seen.includes('repair'), 'оба цвета назвал человек: ' + seen.join(','));
});

/* п.3 — негодная палитра */

/** Заглушка валидатора с настоящим контрастом по палитре документа. */
function contrastViolations(doc) {
  const hex = (ref) => {
    const c = (doc.tokens && doc.tokens.colors) || {};
    const v = String(c[ref] != null ? c[ref] : ref);
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  };
  const lum = (h) => {
    const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((s) => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const bgOf = (node) => {
    let cur = node;
    let g = 0;
    while (cur && g++ < 64) {
      const h = cur.fill ? hex(typeof cur.fill === 'string' ? cur.fill : cur.fill.token || cur.fill.color) : null;
      if (h) return h;
      cur = cur.parent ? doc.nodes[cur.parent] : null;
    }
    return hex('canvas') || '#ffffff';
  };
  const out = [];
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n || n.type !== 'text' || !String(n.characters || '').trim()) continue;
    const fg = hex(typeof n.color === 'string' ? n.color : (n.color && (n.color.token || n.color.color)) || 'text');
    const bg = bgOf(n.parent ? doc.nodes[n.parent] : n);
    if (!fg || !bg) continue;
    const r = ratio(fg, bg);
    if (r < 4.5) out.push({ code: 'low-contrast', nodeId: id, message: `контраст ${r.toFixed(2)}:1 при норме 4.5:1`, severity: 'warn' });
  }
  return out;
}

test('круг16 п.3: белое по белому агент чинит сам, без лишнего вызова модели', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine({ violations: contrastViolations });
  const theme = { colors: [{ name: 'bg', value: '#ffffff' }, { name: 'text', value: '#f2f4f8' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Тёмная палитра', summary: 'Тёмные цвета.', steps: ['Цвета'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай тёмную тему', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.cannot, undefined, 'палитра починена, отказывать не за что');
  assert.equal(provider.calls.length, 2, 'ровно два вызова: ' + provider.calls.map((c) => c.schema).join('+'));
  assert.ok(res.ops.some((o) => o.op === 'setToken' && o.path === 'colors.text' && o.value !== '#f2f4f8'),
    'цвет текста подобран заново: ' + JSON.stringify(res.ops));
  assert.deepEqual(contrastViolations(res.preview.doc), [], 'в итоговом документе текст читается');
  assert.match(res.warnings.join(' | '), /подобрал читаемые цвета сам/, res.warnings.join(' | '));
});

test('круг16 п.3: палитру «всё одним цветом» тоже чинит сам', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine({ violations: contrastViolations });
  const one = '#223344';
  const theme = { colors: Object.keys(doc.tokens.colors).map((k) => ({ name: k, value: one })) };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Одна краска', summary: 'Один цвет.', steps: ['Цвета'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай тёмную тему', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(contrastViolations(res.preview.doc), [], 'текст читается');
  assert.equal(provider.calls.length, 2, provider.calls.map((c) => c.schema).join('+'));
});

test('круг16 п.3: палитру, которую починить нельзя, агент НЕ применяет и говорит почему', async () => {
  const doc = makeDoc16();
  // у части текстов цвет вписан в сам узел кодом — палитрой их не спасти
  for (const id of Object.keys(doc.nodes)) {
    if (doc.nodes[id].type === 'text') doc.nodes[id].color = '#101418';
  }
  const engine = makeStubEngine({ violations: contrastViolations });
  const theme = { colors: [{ name: 'bg', value: '#101418' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Тёмная палитра', summary: 'Тёмные цвета.', steps: ['Цвета'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай тёмную тему', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [], 'нечитаемое оформление не применяется');
  assert.match(String(res.cannot), /нечитаема/, String(res.cannot));
  assert.match(String(res.cannot), /документ остался прежним/, String(res.cannot));
});

test('круг16 п.3: пара плохо читаемых подписей тему не отменяет', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine({
    // одно замечание из многих текстов — это придирка, а не негодная палитра
    violations: () => [{ code: 'low-contrast', nodeId: 'time0', message: 'контраст 3.17:1 при норме 4.5:1', severity: 'warn' }],
  });
  const theme = { colors: [{ name: 'bg', value: '#101418' }, { name: 'text', value: '#e8eaf0' }] };
  const provider = makeFakeProvider({
    plan: { intent: 'theme', title: 'Тёмная палитра', summary: 'Тёмные цвета.', steps: ['Цвета'], targets: [] },
    theme: [theme, theme],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай тёмную тему', provider, engine, activeArtboardId: 'screen' });
  assert.equal(res.cannot, undefined, String(res.cannot));
  assert.ok(res.ops.length, 'оформление применено');
});

/* п.4 — варианты отличимы для оболочки */

test('круг16 п.4: варианты, разошедшиеся только скруглением, имеют разные отпечатки', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine();
  const radii = [4, 12, 28];
  let i = 0;
  const provider = makeFakeProvider({
    plan: { intent: 'edit', title: 'Скругление кнопки', summary: 'Три скругления.', steps: ['Скругление'], targets: [] },
    patch: () => ({ edits: [{ op: 'set', target: 'Кнопка «Добавить пункт»', path: 'radius', value: radii[i++ % 3] }] }),
  });
  const list = await runVariants({
    doc, selection: [], utterance: 'поиграй со скруглением кнопки', provider, engine, n: 3, activeArtboardId: 'screen',
  });
  assert.equal(list.length, 3);
  const prints = list.map((v) => v.fingerprint);
  assert.equal(new Set(prints).size, 3, 'отпечатки различны: ' + JSON.stringify(prints));
  // геометрия у заглушки одинаковая — именно поэтому оболочке нужен отпечаток документа
  assert.equal(new Set(list.map((v) => JSON.stringify(v.ops))).size, 3, 'и операции различны');
});

/* п.5 — заголовок плана не в прошедшем времени */

test('круг16 п.5: планировщик просит название работы, а не отчёт в прошедшем времени', () => {
  const doc = makeDoc16();
  const text = PROMPTS.planner({
    doc, intent: 'edit', guess: 'edit — правка', scope: { kind: 'artboard', ids: [], containerId: 'screen' },
    digest: '', checks: '', tokens: '',
  });
  assert.match(text, /БЕЗ прошедшего времени/, 'инструкция прямо это запрещает');
  assert.ok(!/в прошедшем времени/.test(text.replace(/БЕЗ прошедшего времени/g, '')), text.slice(0, 400));
  assert.ok(!/^Увеличил|Собрал |Поставил /.test(String(SCHEMAS.plan.example.title)), SCHEMAS.plan.example.title);
});

/* п.6 — служебная запись без совета человеку */

test('круг16 п.6: «Починка не удалась» — отчёт без совета «попробуйте ещё раз»', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine();
  const provider = makeFakeProvider({
    plan: PLAN_EDIT3,
    patch: [
      { edits: [{ op: 'set', target: 'Список пунктов', path: 'layout.gap', value: 8 }] },
      new BrainError('network', 'Сбой связи с моделью. Попробуйте ещё раз.'),
    ],
  });
  const res = await runCommand({ doc, selection: [], utterance: 'сделай список плотнее', provider, engine, activeArtboardId: 'screen' });
  const notes = (res.serviceNotes || []).join(' | ');
  if (notes) {
    assert.match(notes, /Сбой связи с моделью/, notes);
    assert.ok(!/Попробуйте/i.test(notes), 'совет человеку в служебной записи не живёт: ' + notes);
  }
});

test('круг16 п.6: factOnly оставляет причину и снимает советы', () => {
  assert.equal(factOnly('Сбой связи с моделью. Попробуйте ещё раз.'), 'Сбой связи с моделью.');
  assert.equal(factOnly('Модель вернула не JSON. Попробуйте ещё раз или упростите команду.'), 'Модель вернула не JSON.');
  // если кроме совета ничего нет — причину терять нельзя
  assert.equal(factOnly('Попробуйте ещё раз.'), 'Попробуйте ещё раз.');
  assert.equal(factOnly(''), '');
});

/* п.7 — названный человеком вмещающий слой сужает цель */

test('круг16 п.7: «в пункте про обед сделай время серым» правит один пункт, а не три', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'set', target: 'Время', path: 'color', value: 'text' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({
    doc, selection: [], utterance: 'в пункте про обед сделай время потемнее', provider, engine, activeArtboardId: 'screen',
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => o.id), ['time0'], JSON.stringify(res.ops));
  assert.match(res.warnings.join(' | '), /в команде назван вмещающий слой/, res.warnings.join(' | '));
});

test('круг16 п.7: без различающего слова правятся все — ловушки не срабатывают', async () => {
  const engine = makeStubEngine();
  const traps = [
    'сделай время потемнее',
    'в пунктах сделай время потемнее',
    'во всех пунктах сделай время потемнее',
    'в списке сделай время потемнее',
    'в маршруте дня сделай время потемнее',
    'сделай макет плотнее',
    'сделай время в каждом пункте потемнее',
  ];
  for (const said of traps) {
    const doc = makeDoc16();
    const patch = { edits: [{ op: 'set', target: 'Время', path: 'color', value: 'text' }] };
    const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
    const res = await runCommand({ doc, selection: [], utterance: said, provider, engine, activeArtboardId: 'screen' });
    assert.equal(res.error, undefined, said + ': ' + JSON.stringify(res.error));
    assert.equal(res.ops.length, 3, said + ': ' + JSON.stringify(res.ops.map((o) => o.id)));
  }
});

/* п.8 — «повторять нечего»: слоя в документе нет */

test('круг16 п.8: цели, которой в документе нет, помечают ошибку как «повторять нечего»', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine();
  const patch = { edits: [{ op: 'remove', target: 'Скидка' }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'отмени скидку', provider, engine, activeArtboardId: 'screen' });
  assert.ok(res.error, 'правок не собралось');
  assert.equal(res.error.retryable, false, JSON.stringify(res.error));
  assert.match(res.error.message, /не найден/, res.error.message);
});

test('круг16 п.8: выдуманное ПОЛЕ у существующего слоя — повтор может и помочь', async () => {
  const doc = makeDoc16();
  const engine = makeStubEngine();
  // круг 37: rotation — уже не выдумка (это rotate), выдуманное поле — «blur»
  const patch = { edits: [{ op: 'set', target: 'Аватар', path: 'blur', value: 15 }] };
  const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
  const res = await runCommand({ doc, selection: [], utterance: 'размой аватар', provider, engine, activeArtboardId: 'screen' });
  assert.ok(res.error, 'правок не собралось');
  assert.equal(res.error.retryable, undefined, JSON.stringify(res.error));
});

/* п.9 — человеческие слова вместо внутренних имён */

test('круг16 п.9: у каждого поля из ALLOWED_PATH_HEADS есть человеческое название', () => {
  const nested = [
    'size.w', 'size.h', 'layout.gap', 'layout.padding', 'layout.padding.t', 'layout.mode',
    'layout.align', 'layout.justify', 'layout.wrap', 'style.token', 'style.fontSize',
    'style.fontWeight', 'style.lineHeight', 'style.letterSpacing', 'style.font',
    'stroke.color', 'stroke.width',
  ];
  for (const p of [...ALLOWED_PATH_HEADS, ...nested]) {
    const ru = ruPath(p);
    const gen = ruPathGen(p);
    assert.notEqual(ru, p, `у «${p}» нет человеческого названия`);
    assert.ok(!/[A-Za-z]/.test(ru), `в названии «${p}» осталась латиница: ${ru}`);
    assert.ok(!/[A-Za-z]/.test(gen), `в родительном «${p}» осталась латиница: ${gen}`);
  }
});

test('круг16 п.9: имена токенов человек читает словами — «крупный», а не «display»', () => {
  assert.equal(ruToken('type', 'display'), 'крупный');
  assert.equal(ruToken('type', 'caption'), 'подпись');
  assert.equal(ruToken('colors', 'muted'), 'приглушённый');
  assert.equal(ruToken('colors', 'accent'), 'акцент');
  // придуманный моделью токен переводить не из чего — показываем как есть
  assert.equal(ruToken('colors', 'brandBlue'), 'brandBlue');
});

test('круг16 п.9: в предупреждениях по всем полям узла нет внутренних имён', async () => {
  const engine = makeStubEngine();
  /* Для каждого поля — правка, которая ГАРАНТИРОВАННО вызывает объяснение: либо «уже так»,
   * либо «такого поля у этого типа нет», либо «значение непригодно». */
  const cases = [
    ['Заголовок сводки', 'characters', ''],
    ['Заголовок сводки', 'style', 'h1'],
    ['Заголовок сводки', 'align', 'наискосок'],
    ['Время', 'color', 'muted'],
    ['Заголовок сводки', 'fill', 'accent'],
    ['Заголовок сводки', 'stroke', 'accent'],
    ['Заголовок сводки', 'radius', 12],
    ['Список пунктов', 'size.w', 'пошире'],
    ['Список пунктов', 'layout.mode', 'наискосок'],
    ['Список пунктов', 'layout.justify', 'space-around'],
    ['Список пунктов', 'layout.wrap', 'наверное'],
    ['Список пунктов', 'layout.gap', 'восемь'],
    ['Заголовок сводки', 'opacity', 'полупрозрачно'],
    ['Заголовок сводки', 'src', 'картинка.png'],
    ['Заголовок сводки', 'clip', 'наверное'],
    ['Список пунктов', 'name', ''],
  ];
  const leaks = [];
  for (const [target, path, value] of cases) {
    const doc = makeDoc16();
    const patch = { edits: [{ op: 'set', target, path, value }, { op: 'set', target: 'Список пунктов', path: 'layout.gap', value: 24 }] };
    const provider = makeFakeProvider({ plan: PLAN_EDIT3, patch: [patch, patch] });
    const res = await runCommand({ doc, selection: [], utterance: 'поправь макет', provider, engine, activeArtboardId: 'summary' });
    for (const w of res.warnings || []) {
      /* Латиница допустима ровно там, где это СЛОВО МОДЕЛИ или человека: значение из ответа
       * («space-around», «картинка.png») и шестнадцатеричный код цвета. Внутренние имена наших
       * полей и токенов — нет. */
      const cleaned = String(w)
        .replace(/#[0-9a-zA-Z_]+/g, '')
        .replace(/«[^»]*»/g, (m) => (/[A-Za-z]/.test(m) && String(value).length && m.includes(String(value)) ? '' : m));
      const bad = cleaned.match(/[A-Za-z][A-Za-z.]{2,}/g) || [];
      if (bad.length) leaks.push(`${path}: ${w} → ${bad.join(',')}`);
    }
  }
  assert.deepEqual(leaks, [], 'внутренние имена в предупреждениях:\n' + leaks.join('\n'));
});

/**
 * Круг 16, п.1, поправка по замечанию координатора: КОНТРАКТ С ЯДРОМ, а не догадка о нём.
 *
 * `sameAsNow` отвечает на вопрос «правка ничего не меняет?», и от её ответа зависят и
 * `nothingToChange` (оболочка убирает «Повторить»), и предупреждение «надстройки снимаются».
 * Первая версия исходила из предположения, что строка поверх объекта снимает надстройки, —
 * ядро выбрало путь без потери данных, и человек читал ложь.
 *
 * Здесь проверяется ИНВАРИАНТ на настоящем `core.applyOps`: «sameAsNow говорит „то же“ ровно
 * тогда, когда applyOps оставил поле байт в байт» — для каждого поля-обёртки и каждой пары
 * форм (строка/объект, совпадающий токен/другой, с надстройками/без). Если ядро поменяет
 * правило формы, упадёт этот тест, а не выйдет к человеку ложная строка.
 */
test('круг16 п.1: sameAsNow совпадает с настоящим applyOps на всех формах полей-обёрток', async () => {
  const core = await import('../src/core.js');
  const base = core.createDoc();
  const byName = (n) => Object.keys(base.nodes).find((k) => base.nodes[k].name === n);
  const TEXT = byName('Заголовок сводки');
  const FRAME = byName('Список пунктов');
  const ELL = byName('Аватар');
  assert.ok(TEXT && FRAME && ELL, 'демо-документ ядра на месте');

  const cases = [
    // [путь, узел, что в узле, что присылает модель]
    ['style', TEXT, { token: 'caption' }, 'caption'],
    ['style', TEXT, { token: 'caption', fontWeight: 600, letterSpacing: 0.6 }, 'caption'],
    ['style', TEXT, { token: 'caption', fontWeight: 600 }, 'display'],
    ['style', TEXT, 'caption', 'caption'],
    ['style', TEXT, 'caption', 'display'],
    ['style', TEXT, 'caption', { token: 'caption' }],
    ['style', TEXT, 'caption', { token: 'caption', fontWeight: 600 }],
    ['style', TEXT, { token: 'caption' }, { token: 'caption' }],
    ['style', TEXT, { token: 'caption' }, { token: 'caption', fontWeight: 600 }],
    ['style', TEXT, { token: 'caption' }, 'display'],
    ['fill', FRAME, { token: 'surface' }, 'surface'],
    ['fill', FRAME, { token: 'surface', alpha: 0.5 }, 'surface'],
    ['fill', FRAME, 'surface', { token: 'surface' }],
    ['fill', FRAME, 'surface', 'surface'],
    ['fill', FRAME, 'surface', 'accent'],
    ['fill', FRAME, { token: 'surface' }, 'accent'],
    ['fill', FRAME, { token: 'surface', alpha: 0.5 }, 'accent'],
    ['color', TEXT, 'muted', 'muted'],
    ['color', TEXT, { token: 'muted' }, 'muted'],
    ['color', TEXT, { color: 'muted' }, 'muted'],
    ['color', TEXT, 'muted', 'text'],
    ['color', TEXT, { token: 'muted' }, 'text'],
    ['stroke', ELL, { color: 'line', width: 1 }, 'line'],
    ['stroke', ELL, { color: 'line', width: 3 }, 'line'],
    ['stroke', ELL, { color: 'line', width: 1 }, { color: 'line', width: 3 }],
    ['stroke', ELL, { color: 'line', width: 1 }, { color: 'line', width: 1 }],
    ['stroke', ELL, 'line', { color: 'line' }],
    ['stroke', ELL, 'line', { color: 'line', width: 3 }],
    ['stroke', ELL, { color: 'line', width: 1 }, 'accent'],
    // вложенные пути ядро пишет напрямую: «то же» там значит буквальное совпадение
    ['stroke.color', ELL, { color: 'line', width: 1 }, 'line'],
    ['stroke.color', ELL, { color: 'line', width: 1 }, 'accent'],
  ];

  const wrong = [];
  for (const [path, id, cur, next] of cases) {
    const doc = JSON.parse(JSON.stringify(base));
    const field = path.split('.')[0];
    doc.nodes[id][field] = JSON.parse(JSON.stringify(cur));
    const before = JSON.stringify(doc.nodes[id][field]);
    const applied = core.applyOps(doc, [core.ops.set(id, path, next)]);
    assert.equal(applied.error, undefined, `${path}: ${JSON.stringify(applied.error)}`);
    const kept = JSON.stringify(applied.doc.nodes[id][field]) === before;
    // значение на ПУТИ (для stroke.color это stroke.color, а не весь stroke)
    let atPath = doc.nodes[id];
    for (const part of path.split('.')) atPath = atPath == null ? undefined : atPath[part];
    const said = sameAsNow(atPath, next, path);
    if (said !== kept) {
      wrong.push(`${path}: в узле ${JSON.stringify(cur)} ← ${JSON.stringify(next)}`
        + ` — ядро ${kept ? 'оставило байт в байт' : 'записало новое'}, а sameAsNow сказал ${said}`);
    }
  }
  assert.deepEqual(wrong, [], 'расхождения с ядром:\n' + wrong.join('\n'));
});

/* ── 19. Компоненты: библиотека как словарь агента (круг 19, SPEC §5) ──────────
 *
 * Здесь тесты идут на НАСТОЯЩЕМ ядре, а не на заглушке: компоненты — это его функции
 * (components, instanceSummary, makeComponentOps, detachInstanceOps) и его проверки схемы.
 * Заглушка их не знает, и проверять на ней было бы нечего: мозг нарочно работает без них
 * как до круга 19 (движок без компонентов остаётся законным, см. componentList).
 */

let _core = null;
const realCore = async () => (_core || (_core = await import('../src/core.js')));
const nameOf = (doc, name) => Object.keys(doc.nodes).find((id) => doc.nodes[id].name === name);
const instIds = (doc) => Object.keys(doc.nodes).filter((id) => doc.nodes[id].type === 'instance');
const instOfComp = (core, doc, comp) => instIds(doc).find((id) => core.instanceSummary(doc, id).startsWith(comp));
const PLAN19 = { intent: 'edit', title: 'Правка', summary: 'Правлю.', steps: ['раз'], targets: [] };

/** Прогон одной команды на настоящем ядре с заранее записанным ответом модели. */
async function run19(core, utterance, patch, opts = {}) {
  const doc = opts.doc || core.createDoc();
  const provider = makeFakeProvider({ plan: opts.plan || PLAN19, patch: [patch, patch], tree: opts.tree });
  const res = await runCommand({
    doc, selection: opts.selection || [], utterance, provider, engine: core,
    activeArtboardId: opts.activeArtboardId === undefined ? nameOf(doc, 'Маршрут дня') : opts.activeArtboardId,
  });
  return { doc, res, provider };
}

/** Тот же документ, но собранный БЕЗ компонентов: экземпляры отсоединены, библиотеки нет. */
function flatten19(core, doc) {
  let d = doc;
  for (;;) {
    const inst = instIds(d)[0];
    if (!inst) break;
    const got = core.applyOps(d, core.detachInstanceOps(d, inst));
    assert.equal(got.error, undefined, JSON.stringify(got.error));
    d = got.doc;
  }
  const lib = core.libraryNode(d);
  if (lib) d = core.applyOps(d, [core.ops.remove(lib.id)]).doc;
  return d;
}

test('круг19 п.1: библиотека — отдельный блок ПЕРЕД документом, узлов библиотеки в выжимке нет', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  const scope = resolveScope(doc, [], core, {});
  const block = describeLibrary(doc, core, { selected: scope.ids });
  assert.match(block, /^БИБЛИОТЕКА ПРОДУКТА/, 'блок начинается словарём');
  for (const info of core.components(doc)) {
    assert.ok(block.includes(core.componentSignature(info)), `в словаре нет «${info.name}»`);
  }
  const digest = describeDoc(doc, scope.ids, { engine: core, geo: core.solve(doc), scopeKind: scope.kind });
  const lib = core.libraryNode(doc);
  assert.ok(!digest.includes(`#${lib.id}`), 'страница библиотеки попала в выжимку документа');
  for (const info of core.components(doc)) {
    assert.ok(!digest.includes(`#${info.id}`), `мастер «${info.name}» попал в выжимку документа`);
    for (const p of info.props) assert.ok(!digest.includes(`#${p.target}`), 'внутренность мастера попала в выжимку');
  }
  // и наоборот: доски и их узлы на месте
  assert.ok(digest.includes(`#${nameOf(doc, 'Маршрут дня')}`) && digest.includes('"Шапка"'));
});

test('круг19 п.1: экземпляр в выжимке — одна строка со свойствами, без внутренностей', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  const digest = describeDoc(doc, [], { engine: core, geo: core.solve(doc) });
  for (const id of instIds(doc)) {
    const line = digest.split('\n').find((l) => l.includes(`#${id} `));
    assert.ok(line, `экземпляра ${id} нет в выжимке`);
    assert.ok(line.includes('экземпляр'), `строка без слова «экземпляр»: ${line}`);
    assert.ok(line.includes(core.instanceSummary(doc, id)), `строка без подписи экземпляра: ${line}`);
    // раскрытое содержимое живёт в решателе — в выжимке его нет
    const ex = core.expandInstance(doc, id);
    for (const sid of Object.keys(ex.nodes)) {
      if (sid === id) continue;
      assert.ok(!digest.includes(`#${sid}`), `внутренность экземпляра в выжимке: ${sid}`);
    }
  }
});

test('круг19 п.1: выжимка усыхает — тот же макет без компонентов длиннее', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  const stat = core.components(doc).find((c) => c.name === 'Карточка показателя');
  // доска-каталог: сто экземпляров одного компонента
  const board = {
    type: 'frame', id: 'board100', name: 'Каталог', parent: doc.root, children: [],
    layout: { mode: 'row', gap: 12, padding: { t: 24, r: 24, b: 24, l: 24 }, align: 'start', justify: 'start', wrap: true },
    size: { w: { mode: 'fixed', value: 1200 }, h: { mode: 'hug' } }, fill: 'surface', radius: 20, pos: { x: 2000, y: 0 },
  };
  let big = core.applyOps(doc, [core.ops.create(board)]).doc;
  const ops = [];
  for (let i = 0; i < 100; i++) {
    ops.push(...core.instanceOps(big, {
      of: stat.id, parent: board.id,
      props: { 'заголовок': `Показатель ${i + 1}`, 'значение': String(i) },
    }));
  }
  const grown = core.applyOps(big, ops);
  assert.equal(grown.error, undefined, JSON.stringify(grown.error));
  big = grown.doc;

  const size = (d) => {
    const body = describeDoc(d, [], { engine: core, geo: core.solve(d), limit: 1e9 });
    const head = describeLibrary(d, core, {});
    return (head ? head.length + 2 : 0) + body.length;
  };
  const withComp = size(big);
  const flat = size(flatten19(core, big));
  assert.ok(withComp < flat * 0.6, `усыхания нет: ${withComp} против ${flat}`);
  // и главное: без компонентов документ в бюджет выжимки не влезает, а с ними влезает
  const seen = (d) => describeDoc(d, [], { engine: core, geo: core.solve(d) });
  assert.ok(!/скрыто|свёрнуто/.test(seen(big)), 'с компонентами выжимка что-то прячет');
  assert.match(seen(flatten19(core, big)), /скрыто|свёрнуто/, 'без компонентов всё влезло — сравнение нечестное');
});

test('круг19 п.2: правила компонентов уходят модели только при живой библиотеке', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  const seen = {};
  const provider = {
    name: 'fake', async ready() { return true; },
    async complete(messages, schema) {
      seen[schema.name] = String((messages.find((m) => m.role === 'system') || {}).content || '');
      return schema.name === 'plan' ? PLAN19 : { edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '16' }] };
    },
  };
  await runCommand({ doc, selection: [], utterance: 'поправь шапку', provider, engine: core, activeArtboardId: nameOf(doc, 'Маршрут дня') });
  assert.match(seen.patch, /БИБЛИОТЕКА ПРОДУКТА/);
  assert.match(seen.patch, /op:"master"/, 'модели не сказали, чем правят компонент целиком');
  assert.match(seen.patch, /props\.<имя свойства>/, 'модели не сказали, как менять свойство экземпляра');
  assert.match(seen.plan, /библиотека компонентов/i);
  // тот же документ без библиотеки: обещать компоненты нельзя — их нет
  const lib = core.libraryNode(doc);
  const bare = core.applyOps(doc, [core.ops.remove(lib.id)]).doc;
  const seen2 = {};
  const provider2 = {
    name: 'fake', async ready() { return true; },
    async complete(messages, schema) {
      seen2[schema.name] = String((messages.find((m) => m.role === 'system') || {}).content || '');
      return schema.name === 'plan' ? PLAN19 : { edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '16' }] };
    },
  };
  await runCommand({ doc: bare, selection: [], utterance: 'поправь шапку', provider: provider2, engine: core, activeArtboardId: nameOf(bare, 'Маршрут дня') });
  assert.ok(!/БИБЛИОТЕКА ПРОДУКТА/.test(seen2.patch), 'библиотеки нет, а блок в промпте есть');
  assert.ok(!/op:"master"/.test(seen2.patch), 'библиотеки нет, а правка компонента обещана');
});

test('круг19 п.3: экземпляр создаётся ссылкой на компонент, одной операцией', async () => {
  const core = await realCore();
  const { doc, res } = await run19(core, 'добавь в шапку кнопку «Войти»', {
    edits: [{
      op: 'create', parent: 'Шапка',
      node: { type: 'instance', of: 'Кнопка', props: [{ name: 'текст', value: 'Войти' }, { name: 'вид', value: 'accent' }] },
    }],
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1, 'экземпляр — один узел, а не поддерево');
  const node = res.ops[0].node;
  assert.equal(node.type, 'instance');
  assert.equal(node.of, core.components(doc).find((c) => c.name === 'Кнопка').id, 'ссылка на мастер по id');
  assert.deepEqual(node.props, { 'текст': 'Войти', 'вид': 'accent' });
  assert.equal(node.parent, nameOf(doc, 'Шапка'));
  assert.ok(!node.children, 'у экземпляра нет детей');
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.equal(core.instanceSummary(next.doc, node.id), 'Кнопка "Войти" вид=accent');
  assert.deepEqual(core.validate(next.doc, core.solve(next.doc)).filter((v) => v.severity === 'error'), []);
});

test('круг19 п.3: выдуманный компонент отсекается там же, где выдуманный слой, и с перечнем', async () => {
  const core = await realCore();
  const { res } = await run19(core, 'поставь тут переключатель', {
    edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Переключатель' } }],
  });
  assert.equal(res.ops.length, 0);
  const said = (res.warnings || []).concat(res.error ? [res.error.message] : []).join(' | ');
  assert.match(said, /такого компонента в библиотеке нет/);
  assert.match(said, /Кнопка, Метка, Карточка показателя/, 'человеку не сказали, что есть взамен');
});

test('круг19 п.3: свойство экземпляра правится по «props.имя», необъявленное — нет', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Кнопка');
  const { doc, res } = await run19(core, 'поменяй у кнопки надпись и цвет', {
    edits: [
      { op: 'set', target: `#${inst}`, path: 'props.текст', value: 'Поехали' },
      { op: 'set', target: `#${inst}`, path: 'props.цвет', value: 'красный' },
    ],
  }, { doc: doc0 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops, [{ op: 'set', id: inst, path: 'props.текст', value: 'Поехали' }]);
  const said = res.warnings.join(' | ');
  assert.match(said, /нет свойства «цвет»/);
  assert.match(said, /есть «текст», «вид»/, 'не перечислили объявленные свойства');
  const next = core.applyOps(doc, res.ops);
  assert.equal(core.instanceSummary(next.doc, inst), 'Кнопка "Поехали" вид=surface');
});

test('круг19 п.3: значение свойства сверяется по виду и списку значений', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Кнопка');
  const { res } = await run19(core, 'сделай кнопку изумрудной', {
    edits: [{ op: 'set', target: `#${inst}`, path: 'props.вид', value: 'изумрудный' }],
  }, { doc: doc0 });
  assert.equal(res.ops.length, 0, 'негодное значение перечисления не должно пройти');
  const said = (res.warnings || []).concat(res.error ? [res.error.message] : []).join(' | ');
  assert.match(said, /значения только/);
  assert.ok(!/[A-Za-z]{3,}/.test(said.replace(/«[^»]*»/g, '')), `латиница в тексте человеку: ${said}`);
});

test('круг19 п.2: правка внутренности экземпляра уходит в объявленное свойство, а не в пустоту', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Кнопка');
  const { doc, res } = await run19(core, 'поменяй текст кнопки на «Купить»', {
    edits: [{ op: 'set', target: `#${inst}`, path: 'characters', value: 'Купить' }],
  }, { doc: doc0 });
  assert.deepEqual(res.ops, [{ op: 'set', id: inst, path: 'props.текст', value: 'Купить' }]);
  assert.match(res.warnings.join(' | '), /правка ушла в его свойство «текст»/);
  const next = core.applyOps(doc, res.ops);
  assert.equal(core.instanceSummary(next.doc, inst), 'Кнопка "Купить" вид=surface');
});

test('круг19 п.2: поле, которого у экземпляра нет, отклоняется словами — без молчаливой записи', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Метка');
  const { res } = await run19(core, 'поставь метке обводку', {
    edits: [{ op: 'set', target: `#${inst}`, path: 'stroke', value: 'line' }],
  }, { doc: doc0 });
  assert.equal(res.ops.length, 0);
  const said = (res.warnings || []).concat(res.error ? [res.error.message] : []).join(' | ');
  assert.match(said, /внутренности экземпляра не правятся/);
  assert.match(said, /можно менять свойства: «текст», «тон»/);
});

test('круг19 п.6: op:"master" правит компонент и человеку сказано, что задело все экземпляры', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const btn = core.components(doc0).find((c) => c.name === 'Кнопка');
  const { doc, res } = await run19(core, 'сделай все кнопки крупнее', {
    edits: [{ op: 'master', target: 'Кнопка', path: 'size.h', value: '64' }],
  }, { doc: doc0 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].id, btn.id, 'правка ушла в мастер компонента');
  const first = res.warnings[0];
  assert.match(first, /Это правка компонента «Кнопка», а не одного слоя/);
  assert.match(first, /все его экземпляры на досках — их 1/);
  // и она правда меняет экземпляр на доске: у него своей высоты нет
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const inst = instOfComp(core, next.doc, 'Кнопка');
  assert.equal(core.solve(next.doc).rects[inst].h, 64, 'экземпляр не подхватил высоту компонента');
});

test('круг19 п.6: правка по ИМЕНИ не заходит в библиотеку — «кнопка» это кнопка на доске', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const libIds = new Set();
  (function walk(id) { libIds.add(id); for (const k of (doc0.nodes[id].children || [])) walk(k); })(core.libraryNode(doc0).id);
  /* Подметание: имена, которые человек называет вслух и которые ЕСТЬ и в библиотеке, и на доске.
   * Ни одна такая правка не имеет права уйти в мастер: иначе точечная правка молча меняет все
   * экземпляры — ровно то, из-за чего ядро убрало библиотеку из resolveTarget. */
  const said = [
    'Кнопка', 'кнопка', 'кнопку', 'Метка', 'метка', 'метку', 'Карточка показателя',
    'карточка показателя', 'Подпись кнопки', 'Текст метки', 'Подпись показателя', 'Значение показателя',
  ];
  const leaks = [];
  for (const target of said) {
    const { res } = await run19(core, `поправь ${target}`, {
      edits: [{ op: 'set', target, path: 'radius', value: '12' }],
    }, { doc: core.createDoc(JSON.parse(JSON.stringify(doc0))) });
    for (const o of res.ops || []) if (o.id && libIds.has(o.id)) leaks.push(`«${target}» → ${o.id}`);
  }
  assert.deepEqual(leaks, [], 'правка по имени утекла в библиотеку: ' + leaks.join(', '));
});

test('круг19 п.6: выдуманный компонент в op:"master" отсекается с перечнем, а имя слоя — не компонент', async () => {
  const core = await realCore();
  for (const target of ['Переключатель', 'Шапка', 'Кнопка «Добавить пункт»']) {
    const { res } = await run19(core, 'поправь компонент', {
      edits: [{ op: 'master', target, path: 'radius', value: '24' }],
    });
    assert.equal(res.ops.length, 0, `«${target}» не должен считаться компонентом`);
    const said = (res.warnings || []).concat(res.error ? [res.error.message] : []).join(' | ');
    assert.match(said, /в библиотеке нет — есть Кнопка, Метка, Карточка показателя/);
  }
});

test('круг19 п.5: op:"detach" превращает экземпляр в настоящую копию поддерева', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Метка');
  const before = core.solve(doc0).rects[inst];
  /* Реплика нарочно НЕ из тех, что мозг распознаёт локально: op:"detach" от МОДЕЛИ нужен
   * там, где просят поправить именно эту копию не через свойства, и решает это она. */
  const { doc, res } = await run19(core, 'поправь первый ярлык по-своему', {
    edits: [{ op: 'detach', target: `#${inst}` }],
  }, { doc: doc0 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].op, 'remove');
  assert.ok(res.ops.slice(1).every((o) => o.op === 'create'), 'остальное — создание копии');
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.equal(instIds(next.doc).length, instIds(doc).length - 1);
  const copy = res.ops[1].node.id;
  assert.equal(next.doc.nodes[copy].type, 'frame', 'на месте экземпляра — обычный фрейм');
  const after = core.solve(next.doc).rects[copy];
  assert.deepEqual({ w: after.w, h: after.h }, { w: before.w, h: before.h }, 'копия встала на то же место');
  // отсоединять то, что не экземпляр, — отказ словами
  const { res: no } = await run19(core, 'поправь шапку по-своему', { edits: [{ op: 'detach', target: 'Шапка' }] });
  assert.equal(no.ops.length, 0);
  assert.match((no.warnings || []).concat(no.error ? [no.error.message] : []).join(' | '),
    /не экземпляр компонента, отсоединять нечего/);
});

test('круг19 п.4: op:"component" уносит узел в библиотеку и оставляет на доске экземпляр', async () => {
  const core = await realCore();
  // и тут реплика не из локально распознаваемых: так op:"component" присылает МОДЕЛЬ
  const { doc, res } = await run19(core, 'карточка встречи пусть переиспользуется', {
    edits: [{ op: 'component', target: 'Карточка встречи', name: 'Плитка дня' }],
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  const made = core.components(next.doc).find((c) => c.name === 'Плитка дня');
  assert.ok(made, 'компонента в библиотеке нет');
  assert.ok(made.props.length >= 3, 'свойства не предложены: ' + JSON.stringify(made.props));
  assert.equal(made.instances, 1, 'на доске не осталось экземпляра');
  assert.match(res.warnings.join(' | '), /Компонент «Плитка дня» добавлен в библиотеку/);
  assert.match(res.warnings.join(' | '), /Менять у экземпляров можно/);
  assert.deepEqual(core.validate(next.doc, core.solve(next.doc)).filter((v) => v.severity === 'error'), []);
});

test('круг19 п.4-5: «сделай из этого компонент» и «отсоедини» стоят НОЛЬ вызовов модели', async () => {
  const core = await realCore();
  const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };
  const doc = core.createDoc();
  const card = nameOf(doc, 'Карточка встречи');
  const made = await runCommand({ doc, selection: [card], utterance: 'сделай из этого компонент', provider: dead, engine: core });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal(made.usage.calls, 0, 'модель всё-таки позвали');
  assert.equal(made.local, 'component');
  const next = core.applyOps(doc, made.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.ok(core.components(next.doc).some((c) => c.name === 'Карточка встречи'), 'компонент не появился');

  const doc2 = core.createDoc();
  const inst = instIds(doc2)[0];
  const off = await runCommand({ doc: doc2, selection: [inst], utterance: 'отсоедини этот экземпляр', provider: dead, engine: core });
  assert.equal(off.error, undefined, JSON.stringify(off.error));
  assert.equal(off.usage.calls, 0);
  assert.equal(off.local, 'detach');
  const next2 = core.applyOps(doc2, off.ops);
  assert.equal(next2.error, undefined, JSON.stringify(next2.error));
  assert.equal(instIds(next2.doc).length, instIds(doc2).length - 1);
});

test('круг19 п.4: без цели — переспрос с готовыми командами, а не догадка', async () => {
  const core = await realCore();
  const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };
  const doc = core.createDoc();
  const res = await runCommand({
    doc, selection: [], utterance: 'сделай из этого компонент', provider: dead, engine: core,
    activeArtboardId: nameOf(doc, 'Маршрут дня'),
  });
  assert.equal(res.usage.calls, 0);
  assert.equal(res.ops.length, 0);
  assert.match(res.clarify, /из чего делать компонент/);
  assert.ok(res.clarifyOptions.length >= 1 && res.clarifyOptions.length <= 3);
  for (const opt of res.clarifyOptions) {
    const name = /«([^»]+)»/.exec(opt);
    assert.ok(name && nameOf(doc, name[1]), `в готовой команде слой не из документа: ${opt}`);
  }
});

test('круг19 п.4: доску компонентом не сделать — это «нельзя», а не авария', async () => {
  const core = await realCore();
  const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };
  const doc = core.createDoc();
  const res = await runCommand({
    doc, selection: [nameOf(doc, 'Маршрут дня')], utterance: 'сделай из этого компонент', provider: dead, engine: core,
  });
  assert.equal(res.error, undefined, 'отказ не должен быть аварией');
  assert.equal(res.ops.length, 0);
  assert.match(res.cannot, /доска компонентом не станет/);
});

test('круг19 п.4: «назови это компонентом X» на экземпляре переименовывает компонент', async () => {
  const core = await realCore();
  const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };
  const doc = core.createDoc();
  const inst = instOfComp(core, doc, 'Кнопка');
  const res = await runCommand({
    doc, selection: [inst], utterance: 'назови это компонентом Главная кнопка', provider: dead, engine: core,
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.usage.calls, 0);
  assert.equal(res.local, 'componentRename');
  assert.match(res.warnings.join(' | '), /теперь называется «Главная кнопка»/);
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.ok(core.components(next.doc).some((c) => c.name === 'Главная кнопка'));
  // без нового имени та же фраза — честное «это уже компонент», а не второй компонент в библиотеке
  const again = await runCommand({ doc, selection: [inst], utterance: 'сделай из этого компонент', provider: dead, engine: core });
  assert.equal(again.ops.length, 0);
  assert.match(again.cannot, /это компонент «Кнопка»/);
});

test('круг19 п.5: «отсоедини экземпляры метки» отсоединяет все экземпляры компонента', async () => {
  const core = await realCore();
  const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };
  const doc = core.createDoc();
  const tags = core.components(doc).find((c) => c.name === 'Метка').instances;
  const res = await runCommand({ doc, selection: [], utterance: 'отсоедини экземпляры метки', provider: dead, engine: core });
  assert.equal(res.usage.calls, 0);
  assert.equal(res.ops.filter((o) => o.op === 'remove').length, tags, 'отсоединились не все');
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.equal(core.components(next.doc).find((c) => c.name === 'Метка').instances, 0);
});

test('круг19 п.5: мягкая формулировка без экземпляра под рукой уходит в модель, а не угадывается', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  let asked = 0;
  const provider = {
    name: 'fake', async ready() { return true; },
    async complete(messages, schema) {
      asked++;
      return schema.name === 'plan' ? PLAN19 : { edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '8' }] };
    },
  };
  const res = await runCommand({
    doc, selection: [nameOf(doc, 'Шапка')], utterance: 'сделай его обычным', provider, engine: core,
  });
  assert.ok(asked >= 1, 'реплику не отдали модели');
  assert.equal(res.local, undefined);
  assert.equal(res.error, undefined, JSON.stringify(res.error));
});

test('круг19 п.4-5: подметание распознавания — просьбы и ловушки', () => {
  const ASK = [
    ['сделай из этого компонент', 'make'], ['сделай компонент', 'make'], ['сделай компонент из этого', 'make'],
    ['сделай из карточки встречи компонент', 'make'], ['собери из этого компонент', 'make'],
    ['оформи это компонентом', 'make'], ['создай компонент из этого', 'make'],
    ['преврати это в компонент', 'make'], ['вынеси это в компонент', 'make'], ['вынеси это в библиотеку', 'make'],
    ['добавь кнопку в библиотеку', 'make'], ['добавь это в библиотеку', 'make'], ['положи это в библиотеку', 'make'],
    ['закинь это в библиотеку', 'make'], ['сохрани это в библиотеку', 'make'], ['помести это в библиотеку', 'make'],
    ['назови это компонентом Карточка', 'make'], ['назови карточку компонентом Плитка', 'make'],
    ['сделай это компонентом', 'make'], ['сделай это компонентом Карточка', 'make'], ['пусть это будет компонентом', 'make'],
    ['сделай карточку встречи компонентом', 'make'], ['ну сделай из этого компонент, пожалуйста', 'make'],
    ['отсоедини', 'detach'], ['отсоедини этот экземпляр', 'detach'], ['отсоедини экземпляр', 'detach'],
    ['отсоедини метку', 'detach'], ['отсоедини экземпляры метки', 'detach'], ['отвяжи этот экземпляр', 'detach'],
    ['отцепи это', 'detach'], ['отлепи это', 'detach'], ['разорви связь', 'detach'], ['разорви связь с компонентом', 'detach'],
    ['сделай его обычным', 'detach'], ['сделай это обычным', 'detach'], ['сделай его независимым', 'detach'],
    ['сделай его отдельным', 'detach'], ['сделай его самостоятельным', 'detach'], ['сделай это простым', 'detach'],
    ['преврати его в обычный', 'detach'], ['отсоедини, пожалуйста', 'detach'],
  ];
  const TRAPS = [
    'сделай все кнопки крупнее', 'сделай кнопку крупнее', 'сделай компонент кнопки крупнее',
    'поправь компонент кнопка', 'у всех меток другой фон', 'сделай метки помельче',
    'добавь кнопку на экран', 'добавь кнопку в шапку', 'добавь кнопку из библиотеки на экран',
    'добавь метку в ярлыки', 'поставь сюда карточку показателя', 'собери экран из библиотеки',
    'покажи компоненты', 'что в библиотеке?', 'сколько компонентов в библиотеке',
    'какие свойства у кнопки', 'убери компонент из библиотеки', 'удали компонент кнопка',
    'отсоедини от раскладки', 'открепи от сетки', 'верни в поток раскладки',
    'сделай его обычным текстом', 'сделай заголовок обычным текстом', 'сделай шапку обычной строкой',
    'сделай заголовок крупнее', 'создай экран тарифов', 'собери карточку товара', 'сделай тёмную тему',
    'покажи три варианта', 'отмени', 'верни как было', 'убери последнее', 'продублируй карточку',
    'скопируй кнопку', 'сделай из карточки две', 'сделай отступы компактнее', 'выровняй по центру',
  ];
  const bad = [];
  for (const [said, kind] of ASK) {
    const got = recognizeComponentIntent(said);
    if (!got || got.kind !== kind) bad.push(`«${said}» → ${JSON.stringify(got)}, ждали ${kind}`);
  }
  for (const said of TRAPS) {
    const got = recognizeComponentIntent(said);
    if (got) bad.push(`ловушка сработала: «${said}» → ${JSON.stringify(got)}`);
  }
  assert.deepEqual(bad, [], `расхождений ${bad.length} на ${ASK.length + TRAPS.length} репликах:\n` + bad.join('\n'));
  // имя компонента сохраняет регистр, как сказал человек
  assert.equal(recognizeComponentIntent('назови это компонентом Плитка дня').name, 'Плитка дня');
  // и прежние локальные намерения целы
  assert.equal(recognizeAction('верни как было'), 'undo');
  assert.ok(recognizeVariants('покажи три варианта'));
  assert.ok(recognizeUndoDoubt('убери последнее'));
});

test('круг19 п.7: новые замечания проверки человек читает словами, без латиницы', async () => {
  const core = await realCore();
  const base = core.createDoc();
  const btn = core.components(base).find((c) => c.name === 'Кнопка');
  const inst = instOfComp(core, base, 'Кнопка');
  const cases = {
    'мёртвая ссылка': (d) => { d.nodes[inst].of = 'нет-такого-узла'; },
    'ссылка вне библиотеки': (d) => { d.nodes[inst].of = nameOf(d, 'Шапка'); },
    'необъявленное свойство': (d) => { d.nodes[inst].props = { 'текст': 'Вперёд', 'цвет': 'красный' }; },
    'компонент внутри себя': (d) => {
      const self = { type: 'instance', id: 'iself', parent: btn.id, of: btn.id, props: {} };
      d.nodes[self.id] = self;
      d.nodes[btn.id].children = (d.nodes[btn.id].children || []).concat([self.id]);
    },
  };
  for (const [what, mutate] of Object.entries(cases)) {
    // мимо createDoc: он лишние свойства чинит сам, а нам нужен документ «как из файла»
    const doc = JSON.parse(JSON.stringify(base));
    mutate(doc);
    const list = core.validate(doc, core.solve(doc));
    assert.ok(list.length, `${what}: валидатор молчит`);
    const text = describeViolations(list, doc);
    assert.ok(text, `${what}: замечаний нет`);
    const clean = text.replace(/«[^»]*»/g, '').replace(/#[0-9a-zA-Z_-]+/g, '');
    assert.ok(!/[A-Za-z]{3,}/.test(clean), `${what}: латиница в тексте человеку — ${text}`);
    assert.ok(!/пропс/i.test(text), `${what}: внутреннее слово «пропс» ушло человеку — ${text}`);
  }
  // и словами именно про то, что случилось
  const dead = JSON.parse(JSON.stringify(base));
  dead.nodes[inst].of = 'нет-такого-узла';
  assert.match(describeViolations(core.validate(dead, core.solve(dead)), dead),
    /ссылается на компонент, которого в библиотеке нет/);
});

test('круг19: выделен мастер — правка идёт в компонент, и об этом сказано', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const btn = core.components(doc0).find((c) => c.name === 'Кнопка');
  const { res } = await run19(core, 'сделай крупнее', {
    edits: [{ op: 'set', target: 'selection', path: 'radius', value: '28' }],
  }, { doc: doc0, selection: [btn.id] });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  // круг 20: 28 модель придумала сама (в реплике этого числа нет) — мимо шкалы скруглений,
  // поэтому берётся ближайший шаг (24 = radii.6), и человеку об этом сказано
  assert.deepEqual(res.ops, [{ op: 'set', id: btn.id, path: 'radius', value: 'radii.6' }]);
  assert.ok(res.warnings.some((w) => /мимо шкалы|ближайш|шаг/i.test(String(w))), 'о подмене числа шагом сказано словами');
  assert.match(res.warnings[0], /Это правка компонента «Кнопка»/);
  // и модель видит, что выделен компонент, а не слой на доске
  const scope = resolveScope(doc0, [btn.id], core, {});
  const digest = describeDoc(doc0, scope.ids, { engine: core, geo: core.solve(doc0), scopeKind: scope.kind });
  assert.match(digest, /РАБОТАЕМ С: компонент «Кнопка» из библиотеки/);
  assert.match(describeLibrary(doc0, core, { selected: scope.ids }), /Кнопка\(.*ВЫДЕЛЕНО/);
});

test('круг19: экземпляры в сгенерированном дереве становятся узлами-экземплярами', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  const tree = {
    type: 'frame', name: 'Показатели недели', size: { w: 390, h: 'hug' }, fill: 'surface',
    layout: { mode: 'column', gap: 16, padding: [24, 20], align: 'stretch' },
    children: [
      { type: 'text', name: 'Заголовок', text: 'Показатели недели', style: 'title' },
      { type: 'instance', of: 'Карточка показателя', props: [{ name: 'заголовок', value: 'Задач закрыто' }, { name: 'значение', value: '48' }] },
      { type: 'instance', of: 'Кнопка', props: [{ name: 'текст', value: 'Открыть отчёт' }] },
    ],
  };
  const provider = makeFakeProvider({
    plan: { intent: 'create', title: 'Экран показателей', summary: 'Собираю из библиотеки.', steps: ['раз'], targets: [] },
    tree,
  });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран с показателями', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 4, 'доска + заголовок + два экземпляра, без поддеревьев компонентов');
  const kinds = res.ops.map((o) => o.node.type);
  assert.deepEqual(kinds, ['frame', 'text', 'instance', 'instance']);
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.deepEqual(core.validate(next.doc, core.solve(next.doc)).filter((v) => v.severity === 'error'), []);
  const ids = res.ops.filter((o) => o.node.type === 'instance').map((o) => o.node.id);
  assert.equal(core.instanceSummary(next.doc, ids[0]), 'Карточка показателя "Задач закрыто" "48"');
  assert.equal(core.instanceSummary(next.doc, ids[1]), 'Кнопка "Открыть отчёт"');
});

test('круг19 п.7: правка компонента, перекрытая свойством экземпляра, не выдаётся за сделанную', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const btn = core.components(doc0).find((c) => c.name === 'Кнопка');
  const label = btn.props.find((p) => p.name === 'текст').target;
  // экземпляр на доске задал свой «текст» — значит правка текста ВНУТРИ компонента его не тронет
  const { doc, res } = await run19(core, 'пусть все кнопки говорят «Дальше»', {
    edits: [{ op: 'master', target: 'Кнопка', path: 'characters', value: 'Дальше' }],
  }, { doc: doc0 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].id, label, 'правка ушла в текст внутри компонента');
  const said = res.warnings.join(' | ');
  assert.match(said, /на досках ничего не изменит/);
  assert.match(said, /свойство «текст» задано своим значением/);
  assert.ok(!/разом меняет все его экземпляры/.test(said),
    'сказали и «меняет все экземпляры», и «ничего не изменит» — одно из двух неправда');
  // и это правда: у экземпляра остаётся своя надпись
  const next = core.applyOps(doc, res.ops);
  const inst = instOfComp(core, next.doc, 'Кнопка');
  const ex = core.expandInstance(next.doc, inst);
  const texts = Object.values(ex.nodes).filter((n) => n.type === 'text').map((n) => n.characters);
  assert.deepEqual(texts, ['Открыть день'], 'свойство экземпляра перестало быть сильнее');
});

test('круг19 п.3: свойство, которое уже такое, — «менять нечего», без «Повторить»', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Кнопка');
  const { res } = await run19(core, 'поставь кнопке простой вид', {
    edits: [{ op: 'set', target: `#${inst}`, path: 'props.вид', value: 'surface' }],
  }, { doc: doc0 });
  assert.equal(res.nothingChanged, true);
  assert.equal(res.nothingToChange, true, 'оболочка предложит «Повторить» там, где повтор бесполезен');
  assert.match(res.warnings.join(' | '), /свойство «вид» уже «карточка»/);
});

test('круг19 п.3: свойство можно снять — тогда значение берётся у компонента', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Кнопка');
  const { doc, res } = await run19(core, 'пусть у кнопки будет обычный вид', {
    edits: [{ op: 'set', target: `#${inst}`, path: 'props.вид', value: 'none' }],
  }, { doc: doc0 });
  // снятие — та же операция, что у кнопки инспектора «Без заливки»: set без значения
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].op, 'set');
  assert.equal(res.ops[0].id, inst);
  assert.equal(res.ops[0].path, 'props.вид');
  assert.equal(res.ops[0].value, undefined);
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.equal(core.instanceSummary(next.doc, inst), 'Кнопка "Открыть день"');
  const ex = core.expandInstance(next.doc, inst);
  assert.equal(ex.nodes[inst].fill, 'accent', 'заливка не вернулась к заливке компонента');
});

test('круг19 п.7: в словах про компоненты нет латиницы и внутренних имён', async () => {
  const core = await realCore();
  const doc0 = core.createDoc();
  const inst = instOfComp(core, doc0, 'Кнопка');
  const cases = [
    ['поставь тут переключатель', { edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Переключатель' } }] }],
    ['поправь компонент', { edits: [{ op: 'master', target: 'Шапка', path: 'radius', value: '8' }] }],
    ['покрась кнопку', { edits: [{ op: 'set', target: `#${inst}`, path: 'props.цвет', value: 'красный' }] }],
    ['сделай кнопку изумрудной', { edits: [{ op: 'set', target: `#${inst}`, path: 'props.вид', value: 'изумрудный' }] }],
    ['поставь кнопке обводку', { edits: [{ op: 'set', target: `#${inst}`, path: 'stroke', value: 'line' }] }],
    ['поменяй текст кнопки', { edits: [{ op: 'set', target: `#${inst}`, path: 'characters', value: 'Купить' }] }],
    ['сделай все кнопки крупнее', { edits: [{ op: 'master', target: 'Кнопка', path: 'size.h', value: '70' }] }],
    ['поправь шапку по-своему', { edits: [{ op: 'detach', target: 'Шапка' }] }],
    ['карточка встречи пусть переиспользуется', { edits: [{ op: 'component', target: 'Карточка встречи', name: 'Плитка' }] }],
  ];
  const leaks = [];
  for (const [said, patch] of cases) {
    const { res } = await run19(core, said, patch, { doc: core.createDoc(JSON.parse(JSON.stringify(doc0))) });
    const texts = (res.warnings || []).concat([res.cannot, res.clarify].filter(Boolean));
    for (const w of texts) {
      /* Латиница допустима только там, где это СЛОВО МОДЕЛИ или человека — его мы печатаем
       * в кавычках («изумрудный», «line»). Внутренние имена наших полей, операций и id — нет. */
      const cleaned = String(w).replace(/«[^»]*»/g, '').replace(/#[0-9a-zA-Z_-]+/g, '');
      const bad = cleaned.match(/[A-Za-z][A-Za-z.]{2,}/g) || [];
      if (bad.length) leaks.push(`«${said}»: ${w} → ${bad.join(',')}`);
      if (/артборд/i.test(w)) leaks.push(`«${said}»: «артборд» вместо «доска» — ${w}`);
      if (/пропс|мастер/i.test(w)) leaks.push(`«${said}»: внутреннее слово — ${w}`);
    }
  }
  assert.deepEqual(leaks, [], 'внутренние имена в словах человеку:\n' + leaks.join('\n'));
});

test('круг19: компоненты не ломают работу без них — движок и документ без библиотеки', async () => {
  const core = await realCore();
  const doc = core.createDoc();
  const lib = core.libraryNode(doc);
  const bare = core.applyOps(doc, [core.ops.remove(lib.id)]).doc;
  assert.deepEqual(core.components(bare), []);
  // 1. выжимка без словаря и без слова «экземпляр»
  assert.equal(describeLibrary(bare, core, {}), '');
  // 2. обычная правка работает как до круга 19
  const { res } = await run19(core, 'сделай шапку просторнее', {
    edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '20' }],
  }, { doc: bare, activeArtboardId: nameOf(bare, 'Маршрут дня') });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  // 3. просьба про компонент — честное «нечем», а не авария
  const { res: no } = await run19(core, 'добавь кнопку в шапку', {
    edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Кнопка' } }],
  }, { doc: bare, activeArtboardId: nameOf(bare, 'Маршрут дня') });
  assert.match((no.warnings || []).concat(no.error ? [no.error.message] : []).join(' | '),
    /библиотеки компонентов в документе нет/i);
  // 4. движок без компонентных функций (заглушка прошлых кругов) — мозг работает как раньше
  const stub = makeStubEngine();
  const patched = { edits: [{ op: 'set', target: 'Заголовок', path: 'style', value: 'h1' }] };
  const stubRes = await runCommand({
    doc: makeDoc(), selection: [], utterance: 'сделай заголовок крупнее',
    provider: makeFakeProvider({ plan: PLAN_EDIT, patch: patched }), engine: stub,
  });
  assert.equal(stubRes.error, undefined, JSON.stringify(stubRes.error));
  assert.equal(stubRes.ops.length, 1);
});

test('круг19 п.4-5: у механической просьбы вариантов не бывает — один прогон, ноль вызовов', async () => {
  const core = await realCore();
  const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };
  const doc = core.createDoc();
  const inst = instIds(doc)[0];
  const list = await runVariants({
    doc, selection: [inst], utterance: 'покажи два варианта: отсоедини этот экземпляр',
    provider: dead, engine: core, n: 2,
  });
  assert.equal(list.length, 1, 'три копии одного и того же действия человеку не нужны');
  assert.equal(list[0].usage.calls, 0);
  assert.equal(list[0].local, 'detach');
  assert.ok(list[0].ops.length >= 2, 'операций отсоединения нет');
});

/* ── 24. Круг 24: глобальные id, внешняя библиотека (DUIL), «верни обратно» ──
 *
 * SPEC §10.6. id новых узлов brain берёт у движка (core.uid) — переименование перед записью
 * в Orchestrator (globalizeIds) для свежих id становится пустым. Внешний словарь компонентов
 * дополняет библиотеку документа (имена документа главнее), а мастер, на который правка
 * сослалась, переносится в документ теми же операциями.
 */

const GLOBAL_ID = /^[a-z]+_[0-9a-z]{12,}$/;

test('круг24: id новых узлов — глобальные (core.uid); globalizeIds для них пуст', async () => {
  const core = await realCore();
  const { globalizeIds } = await import('../server/orchestrator/pipeline.js');
  const doc = core.createDoc();
  const provider = makeFakeProvider({ plan: PLAN_CREATE, tree: TREE_OK });
  const res = await runCommand({ doc, selection: [], utterance: 'собери экран тарифов', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const creates = res.ops.filter((o) => o.op === 'create');
  assert.ok(creates.length >= 4);
  for (const o of creates) assert.match(o.node.id, GLOBAL_ID, `короткий id: ${o.node.id}`);
  assert.deepEqual(globalizeIds(res.ops), res.ops, 'страховка Orchestrator ничего не переименовала');
  // и на заглушке движка без uid — та же форма (свой генератор brain)
  const stub = await runCommand({
    doc: makeDoc(), selection: [], utterance: 'собери экран тарифов',
    provider: makeFakeProvider({ plan: PLAN_CREATE, tree: TREE_OK }), engine: makeStubEngine(),
  });
  assert.equal(stub.error, undefined, JSON.stringify(stub.error));
  for (const o of stub.ops.filter((x) => x.op === 'create')) assert.match(o.node.id, GLOBAL_ID);
  assert.deepEqual(globalizeIds(stub.ops), stub.ops);
});

test('круг24: id, предложенный моделью, — только псевдоним: узел получает uid, ссылки на него сходятся', async () => {
  const core = await realCore();
  const { res, doc } = await run19(core, 'добавь в шапку блок с подписью', {
    edits: [
      { op: 'create', parent: 'Шапка', node: { type: 'frame', id: 'box', name: 'Блок акции', layout: { mode: 'column', gap: 8 },
        children: [{ type: 'frame', id: 'inner_slot', name: 'Слот подписи', layout: { mode: 'row' } }] } },
      { op: 'create', parent: 'inner_slot', node: { type: 'text', text: 'Скидка 10%' } },
    ],
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const creates = res.ops.filter((o) => o.op === 'create');
  assert.equal(creates.length, 3, JSON.stringify(res.warnings));
  for (const o of creates) assert.match(o.node.id, GLOBAL_ID);
  assert.ok(!creates.some((o) => o.node.id === 'box' || o.node.id === 'inner_slot'), 'id модели взят как есть');
  const slot = creates.find((o) => o.node.name === 'Слот подписи');
  const text = creates.find((o) => o.node.type === 'text');
  assert.equal(text.node.parent, slot.node.id, 'ссылка по id модели нашла созданный узел');
  assert.equal(core.applyOps(doc, res.ops).error, undefined);
});

/** Документ-библиотека «ДС»: в нём есть свой «Кнопка» (как в демо) и новый «Плашка». */
async function libraryProject(core) {
  let lib = core.createDoc();
  const board = core.artboards(lib)[0];
  const frame = { type: 'frame', id: core.uid('f'), name: 'Плашка', parent: board.id, children: [],
    layout: { mode: 'row', gap: 8, padding: { t: 8, r: 12, b: 8, l: 12 }, align: 'center', justify: 'start' },
    size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, fill: 'accent', radius: 8 };
  const label = { type: 'text', id: core.uid('t'), name: 'Подпись', parent: frame.id, characters: 'Новинка', style: { token: 'body' }, align: 'left', color: '#FFFFFF' };
  lib = core.applyOps(lib, [core.ops.create(frame), core.ops.create(label)]).doc;
  const made = core.applyOps(lib, core.makeComponentOps(lib, frame.id, {
    name: 'Плашка', props: [{ name: 'текст', kind: 'text', target: label.id, path: 'characters' }],
  }));
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  return made.doc;
}

test('круг24: внешняя библиотека — словарь в промпте, мастер переносится в документ, имена документа главнее', async () => {
  const core = await realCore();
  const ext = await libraryProject(core);
  const doc = core.createDoc();
  const seen = {};
  const patch = { edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Плашка', props: [{ name: 'текст', value: 'Акция' }] } }] };
  const provider = {
    name: 'fake', async ready() { return true; },
    async complete(messages, schema) {
      seen[schema.name] = String((messages.find((m) => m.role === 'system') || {}).content || '');
      return schema.name === 'plan' ? PLAN19 : patch;
    },
  };
  const res = await runCommand({
    doc, selection: [], utterance: 'добавь в шапку плашку «Акция»', provider, engine: core,
    activeArtboardId: nameOf(doc, 'Маршрут дня'), library: [{ name: 'ДС', id: 'p_lib', doc: ext }],
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.match(seen.patch, /Плашка\(текст\)/, 'внешнего компонента нет в словаре модели');
  assert.equal((seen.patch.match(/Кнопка\(/g) || []).length, 1, 'одноимённый компонент попал в словарь дважды');
  assert.deepEqual(res.libraryAdded, [{ name: 'Плашка', source: 'ДС' }]);
  const libId = core.libraryNode(doc).id;
  const [master, ...rest] = res.ops;
  assert.equal(master.op, 'create');
  assert.equal(master.node.parent, libId, 'мастер ложится в библиотеку документа');
  assert.match(master.node.id, GLOBAL_ID);
  assert.ok(!ext.nodes[master.node.id], 'у переносимого мастера id свежий, а не из чужого проекта');
  const inst = rest.find((o) => o.op === 'create' && o.node.type === 'instance');
  assert.equal(inst.node.of, master.node.id);
  const next = core.applyOps(doc, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.deepEqual(core.validate(next.doc, core.solve(next.doc)).filter((v) => v.severity === 'error'), []);
  assert.equal(core.instanceSummary(next.doc, inst.node.id), 'Плашка "Акция"');
  assert.equal(core.components(next.doc).filter((c) => c.name === 'Кнопка').length, 1);
  assert.equal(res.preview.doc.nodes[inst.node.id].of, master.node.id, 'превью — настоящий документ после правки');
  // «Кнопка» есть и в документе, и во внешней: берётся мастер документа, ничего не переносится
  const viaLib = await runCommand({
    doc, selection: [], utterance: 'добавь в шапку кнопку', engine: core, activeArtboardId: nameOf(doc, 'Маршрут дня'),
    provider: makeFakeProvider({ plan: PLAN19, patch: [{ edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Кнопка', props: [{ name: 'текст', value: 'Войти' }] } }] }] }),
    library: [{ name: 'ДС', doc: ext }],
  });
  assert.equal(viaLib.ops.length, 1, 'перенесено лишнее');
  assert.equal(viaLib.ops[0].node.of, core.components(doc).find((c) => c.name === 'Кнопка').id);
  assert.equal(viaLib.libraryAdded, undefined);
});

test('круг24: внешняя библиотека — без своей библиотеки страница заводится; неиспользованное не переносится', async () => {
  const core = await realCore();
  const ext = core.applyOps(await libraryProject(core), []).doc;
  const full = core.createDoc();
  const bare = flatten19(core, full);   // экземпляры отсоединены, библиотеки нет
  const board = nameOf(bare, 'Маршрут дня');
  const res = await runCommand({
    doc: bare, selection: [], utterance: 'добавь в шапку кнопку «Купить»', engine: core, activeArtboardId: board,
    provider: makeFakeProvider({ plan: PLAN19, patch: [{ edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Кнопка', props: [{ name: 'текст', value: 'Купить' }] } }] }] }),
    library: [{ name: 'ДС', doc: libraryDocOf(ext, core) }],
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].node.type, 'page');
  assert.equal(res.ops[0].node.role, 'library');
  assert.deepEqual(res.libraryAdded.map((x) => x.name), ['Кнопка']);
  const next = core.applyOps(bare, res.ops);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.deepEqual(core.components(next.doc).map((c) => c.name), ['Кнопка'], 'перенесён только использованный');
  assert.deepEqual(core.validate(next.doc, core.solve(next.doc)).filter((v) => v.severity === 'error'), []);
  // правка, которая библиотеку не трогает, — без единой лишней операции
  const plain = await runCommand({
    doc: bare, selection: [], utterance: 'поправь шапку', engine: core, activeArtboardId: board,
    provider: makeFakeProvider({ plan: PLAN19, patch: [{ edits: [{ op: 'set', target: 'Шапка', path: 'layout.gap', value: '12' }] }] }),
    library: [{ name: 'ДС', doc: ext }],
  });
  assert.equal(plain.error, undefined, JSON.stringify(plain.error));
  assert.ok(plain.ops.length >= 1 && plain.ops.every((o) => o.op === 'set'), JSON.stringify(plain.ops));
  assert.equal(plain.libraryAdded, undefined);
  assert.equal(core.libraryNode(plain.preview.doc), null, 'в превью нет «временной» библиотеки');
  // выжимка библиотеки для передачи: только корень, страница библиотеки и мастера
  const slim = libraryDocOf(ext, core);
  assert.ok(Object.keys(slim.nodes).length < Object.keys(ext.nodes).length);
  assert.deepEqual(core.components(slim).map((c) => c.name), core.components(ext).map((c) => c.name));
  assert.equal(libraryDocOf(bare, core), null);
});

test('круг24: варианты с внешней библиотекой — у каждого варианта свой перенос мастера', async () => {
  const core = await realCore();
  const ext = await libraryProject(core);
  const doc = core.createDoc();
  const patch = { edits: [{ op: 'create', parent: 'Шапка', node: { type: 'instance', of: 'Плашка', props: [{ name: 'текст', value: 'Хит' }] } }] };
  const list = await runVariants({
    doc, selection: [], utterance: 'добавь в шапку плашку', engine: core, n: 2, activeArtboardId: nameOf(doc, 'Маршрут дня'),
    provider: makeFakeProvider({ plan: PLAN19, patch: [patch, patch, patch, patch] }),
    library: [{ name: 'ДС', doc: ext }],
  });
  assert.equal(list.length, 2);
  for (const v of list) {
    assert.equal(v.error, undefined, JSON.stringify(v.error));
    const next = core.applyOps(doc, v.ops);
    assert.equal(next.error, undefined, JSON.stringify(next.error));
    assert.ok(core.components(next.doc).some((c) => c.name === 'Плашка'));
    assert.deepEqual(v.libraryAdded, [{ name: 'Плашка', source: 'ДС' }]);
  }
});

test('круг24: «верни обратно» — повтор, как в оболочке (app.js shellIntent); «верни назад» и «как было» — отмена', () => {
  assert.equal(recognizeAction('верни обратно'), 'redo');
  assert.equal(recognizeAction('Верни обратно, пожалуйста'), 'redo');
  assert.equal(recognizeAction('верни назад'), 'undo');
  assert.equal(recognizeAction('верни как было'), 'undo');
  assert.equal(recognizeAction('поменяй обратно цвет кнопки'), null);
});

/* ── круг 25: строки в документ — по кодовым точкам, без \u0000 и одиночных суррогатов ── */

const wellFormed = (s) => typeof s === 'string' && s.isWellFormed() && !s.includes('\u0000');

test('круг 25: cutText/cleanText brain — те же, что у core (сверка на случайных строках)', async () => {
  const brain = await import('../src/brain.js');
  const core = await import('../src/core.js');
  const parts = ['a', 'я', '😀', '👍🏽', '\ud800', '\udfff', '\u0000', ' ', '𝒜', 'é'];
  let s = 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 2000; i++) {
    let str = '';
    const len = Math.floor(rnd() * 40);
    for (let k = 0; k < len; k++) str += parts[Math.floor(rnd() * parts.length)];
    const n = Math.floor(rnd() * 45);
    assert.equal(brain.cutText(str, n), core.cutText(str, n), JSON.stringify([str, n]));
    assert.equal(brain.cleanText(str), core.cleanText(str));
    assert.ok([...brain.cutText(str, n)].length <= n);
    assert.ok(str.startsWith(brain.cutText(str, n)));
    assert.ok(wellFormed(brain.cleanText(str)));
    // целая пара не рвётся: из корректной строки — корректная
    if (str.isWellFormed()) assert.ok(brain.cutText(str, n).isWellFormed(), JSON.stringify([str, n]));
  }
  assert.equal(brain.cutText('😀😀😀', 2), '😀😀');
  assert.equal(brain.cutText(null, 3), '');
  assert.equal(brain.cutText(12345, 3), '123');
  assert.equal(brain.cleanText('a\u0000b\ud83d'), 'ab�');
  assert.equal(brain.cleanText(5), 5);
});

test('круг 25: имя по тексту из эмодзи режется по кодовым точкам — пара не рвётся, запись в базу не падает', async () => {
  const core = await import('../src/core.js');
  const { treeToOps } = await import('../src/brain.js');
  const doc = core.createDoc();
  const board = core.artboards(doc)[0].id;
  const characters = '🚀'.repeat(13) + ' Запуск';   // граница 24 единиц UTF-16 — между парами
  const odd = 'ж' + '🚀'.repeat(30);                // граница 24 единиц — посреди пары: slice(0, 24) оставлял одиночный суррогат
  const { ops } = treeToOps({
    doc, engine: core, parentId: board, warn: () => {},
    tree: { type: 'frame', children: [{ type: 'text', text: odd }, { type: 'text', text: characters }, { type: 'instance', compName: '🎉'.repeat(40) }] },
  });
  const names = ops.map((o) => o.node.name).filter(Boolean);
  assert.ok(names.length >= 2, JSON.stringify(names));
  for (const n of names) {
    assert.ok(wellFormed(n), 'имя валидно: ' + JSON.stringify(n));
    assert.ok([...n].length <= 80);
  }
  const textName = ops.find((o) => o.node.characters === odd).node.name;
  assert.equal(textName, 'ж' + '🚀'.repeat(23), 'ровно 24 кодовые точки');
  assert.equal(core.applyOps(doc, ops).error, undefined);
});

test('круг 25: результат runCommand без \u0000 и одиночных суррогатов — в операциях, заголовке, предупреждениях', async () => {
  const doc = makeDoc();
  const engine = makeStubEngine();
  const dirty = 'Цена\u0000 \ud83d за месяц';
  const provider = makeFakeProvider({
    plan: { ...PLAN_CREATE, title: 'План\u0000 ' + '😀'.repeat(70) },
    tree: { type: 'text', name: 'Сноска\ud800', text: dirty, style: 'body' },
  });
  const res = await runCommand({ doc, selection: ['btn'], utterance: 'добавь подпись', provider, engine });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].node.characters, 'Цена � за месяц');
  assert.equal(res.ops[0].node.name, 'Сноска�');
  const walk = (v) => {
    if (typeof v === 'string') assert.ok(wellFormed(v), 'строка результата: ' + JSON.stringify(v));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) if (k !== 'preview') walk(v[k]);
  };
  walk(res);
  assert.ok(wellFormed(res.plan.title) && [...res.plan.title].length <= 120);
});

/* ── Круг 27 ─────────────────────────────────────────────────────────────── */

const core27 = await import('../src/core.js');
const { asksNewScreen, checkOutcome, describeChange } = await import('../src/brain.js');
const PLAN_EDIT27 = { intent: 'edit', title: 'Укрупнил заголовок', summary: 'Ставлю стиль h1.', steps: ['Поставить h1'], targets: ['Заголовок экрана'] };
const demo27 = () => core27.createDoc();
const byName27 = (doc, name) => Object.values(doc.nodes).find((n) => n.name === name);

test('круг27 п.4: «h1» в документе без h1 → крупнейший стиль, а не «текст»; заголовок стал крупнее', async () => {
  const doc = demo27();
  const title = byName27(doc, 'Заголовок экрана');
  const patch = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'h1' }] };
  const res = await runCommand({
    doc, selection: [], utterance: 'сделай заголовок крупнее', engine: core27,
    provider: makeFakeProvider({ plan: PLAN_EDIT27, patch: [patch, patch] }),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const op = res.ops.find((o) => o.id === title.id);
  assert.ok(op, JSON.stringify(res.ops));
  const token = typeof op.value === 'object' ? op.value.token : op.value;
  assert.equal(token, 'display', 'крупный — крупнейший стиль документа');
  assert.ok(!res.warnings.some((w) => /^Проверка макета: просили крупнее/.test(w)), res.warnings.join(' | '));
  assert.ok(res.warnings.some((w) => /«h1».*понял как «крупный»/.test(w)), res.warnings.join(' | '));
  // подпись для истории — что сделано, словами инспектора, без «h1»
  assert.match(res.changeSummary, /Стиль текста «Заголовок экрана»: «заголовок» → «крупный»/);
  assert.doesNotMatch(res.changeSummary, /h1|Ставлю/);
});

test('круг27 п.4: смысловые имена стилей — h2/h3/caption/mono/24px; незнакомое в правке не подменяется «текстом»', () => {
  const doc = demo27();
  const id = byName27(doc, 'Заголовок экрана').id;
  const ctx = { id };
  const pick = (v) => coerceValue(v, 'style', doc, () => {}, ctx);
  assert.equal(pick('h1'), 'display');
  assert.equal(pick('Heading-1'), 'display');
  assert.equal(pick('h2'), 'title');
  assert.equal(pick('h3'), 'heading');
  assert.equal(pick('subtitle'), 'heading');
  assert.equal(pick('small'), 'caption');
  assert.equal(pick('paragraph'), 'body');
  assert.equal(pick('code'), 'mono');
  assert.equal(pick('крупный'), 'display');
  assert.equal(pick(33), 'display', 'кегль — ближайший по размеру');
  assert.deepEqual(pick({ token: 'h1', fontWeight: 700 }), { token: 'display', fontWeight: 700 });
  assert.equal(coerceValue('h1', 'style.token', doc, () => {}, ctx), 'display');
  const warns = [];
  assert.equal(coerceValue('brandFancy', 'style', doc, (w) => warns.push(w), ctx), undefined, 'правка пропущена');
  assert.match(warns.join(' | '), /стиля «brandFancy» в документе нет.*правка пропущена, стиль остался «заголовок»/);
});

test('круг27 п.4: незнакомый стиль у стилизованного узла — правка пропущена, а не «текст»; успеха нет', async () => {
  const doc = demo27();
  const patch = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'brandFancy' }] };
  const res = await runCommand({
    doc, selection: [], utterance: 'сделай заголовок крупнее', engine: core27,
    provider: makeFakeProvider({ plan: PLAN_EDIT27, patch: [patch, patch] }),
  });
  assert.ok(!res.ops.some((o) => o.op === 'set' && (o.value === 'body' || (o.value && o.value.token === 'body'))), JSON.stringify(res.ops));
  assert.ok(!res.ops.length || res.error, 'применять нечего');
  assert.ok(res.warnings.some((w) => /правка пропущена/.test(w)) || res.error, res.warnings.join(' | '));
});

test('круг27 п.4: «крупнее», а стиль поставлен мельче — замечание «Проверка макета», а не успех', async () => {
  const doc = demo27();
  const patch = { edits: [{ op: 'set', target: 'Заголовок экрана', path: 'style', value: 'caption' }] };
  const res = await runCommand({
    doc, selection: [], utterance: 'сделай заголовок крупнее', engine: core27,
    provider: makeFakeProvider({ plan: PLAN_EDIT27, patch: [patch, patch] }),
  });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.ok(res.warnings.some((w) => /^Проверка макета: просили крупнее, а «Заголовок экрана» стал мельче: 24 → 13 px/.test(w)), res.warnings.join(' | '));
  // и прямой вызов: тот же размер — тоже замечание
  const t = byName27(doc, 'Заголовок экрана');
  const after = core27.applyOps(doc, [{ op: 'set', id: t.id, path: 'style', value: 'title' }]).doc;
  const same = checkOutcome({ doc, after, ops: [{ op: 'set', id: t.id, path: 'style', value: 'title' }], utterance: 'сделай заголовок крупнее' });
  assert.match(same.join(' | '), /не изменился \(24 px\)/);
  assert.deepEqual(checkOutcome({ doc, after, ops: [], utterance: 'сделай заголовок крупнее' }), []);
});

test('круг27 п.5: «новой доской», «на новом экране», «отдельной доской» — просьба о новом экране', () => {
  for (const s of ['собери экран тарифов новой доской', 'сделай это на новом экране', 'новый экран', 'заведи новую доску',
    'положи отдельной доской', 'ещё одним экраном', 'на отдельном макете', 'собери экран тарифов', 'создай доску настроек']) {
    assert.equal(asksNewScreen(s), true, s);
  }
  for (const s of ['собери в этом экране отзывы', 'добавь отзывы', 'сделай заголовок крупнее', 'собери здесь экран кнопок']) {
    assert.equal(asksNewScreen(s), false, s);
  }
});

test('круг27 п.5: второй «собери экран …» при выделении агента — новой доской, а не внутрь первого', async () => {
  const doc = demo27();
  const first = doc.nodes[doc.root].children[0];
  const run = (selectionBy) => runCommand({
    doc, selection: [first], selectionBy, utterance: 'собери экран тарифов', engine: core27, activeArtboardId: first,
    provider: makeFakeProvider({ plan: PLAN_CREATE, tree: [TREE_OK, TREE_OK] }),
  });
  const byAgent = await run('agent');
  assert.equal(byAgent.error, undefined, JSON.stringify(byAgent.error));
  const top = byAgent.ops.find((o) => o.op === 'create');
  assert.equal(top.node.parent, doc.root, 'новой доской на холсте');
  assert.match(byAgent.changeSummary, /новой доской/);
  // выделение человека — его решение: внутрь, но со словами об этом
  const byHuman = await run('human');
  const top2 = byHuman.ops.find((o) => o.op === 'create');
  assert.equal(top2.node.parent, first);
  assert.ok(byHuman.warnings.some((w) => /Собираю внутри выделенного/.test(w)), byHuman.warnings.join(' | '));
  // а явное «новой доской» перебивает и выделение человека
  const said = await runCommand({
    doc, selection: [first], selectionBy: 'human', utterance: 'собери экран тарифов новой доской', engine: core27,
    provider: makeFakeProvider({ plan: PLAN_CREATE, tree: [TREE_OK, TREE_OK] }),
  });
  assert.equal(said.ops.find((o) => o.op === 'create').node.parent, doc.root);
});

test('круг27 п.5: размещение «новый экран», а результат лёг внутрь — замечание', () => {
  const doc = demo27();
  const first = doc.nodes[doc.root].children[0];
  const ops = [{ op: 'create', node: { id: 'f_x1', type: 'frame', name: 'Экран тарифов', parent: first } }];
  const w = checkOutcome({ doc, after: doc, ops, placement: { asArtboard: true } });
  assert.match(w.join(' | '), /^Проверка макета: просили отдельную доску, а «Экран тарифов» лёг внутрь «Маршрут дня»/);
  assert.deepEqual(checkOutcome({ doc, after: doc, ops: [{ ...ops[0], node: { ...ops[0].node, parent: doc.root } }], placement: { asArtboard: true } }), []);
});

test('круг27 п.6: describeChange — что сделано словами', () => {
  const doc = demo27();
  const t = byName27(doc, 'Заголовок экрана');
  const d = byName27(doc, 'Дата');
  assert.equal(describeChange([], doc), '');
  assert.equal(describeChange([{ op: 'remove', id: d.id }], doc), 'Удалил «Дата»');
  const two = describeChange([
    { op: 'set', id: t.id, path: 'style', value: 'display' },
    { op: 'create', node: { id: 't_new', type: 'text', name: 'Подзаголовок', parent: t.parent } },
  ], doc, null, core27);
  assert.match(two, /^Добавил «Подзаголовок» в «.+»; стиль текста «Заголовок экрана»: «заголовок» → «крупный»$/);
});

/* ── Круг 30: описания не бросают на документе, отравленном до исправления ядра ────────
   Документ, записанный до того, как ядро проверяло форму каждого поля (круг 29), может нести
   объект `{toString: 1}` в name, characters, radius, of, children, токенах. Шаблон строки и
   String() на нём бросают TypeError — выжимка для модели, описание правки и проверки падали
   целиком, и команда агента над таким проектом не выполнялась вовсе. */
test('круг30: describeDoc/describeChange/describeViolations/describeTokens не бросают на отравленных полях', () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const base = core27.createDoc();
    const EVIL = [{ toString: 1 }, [{ toString: 1 }], { token: { toString: 1 } }, { mode: { toString: 1 }, value: { toString: 1 } }, 'constructor'];
    const FIELDS = ['name', 'characters', 'style', 'fill', 'color', 'stroke', 'radius', 'align', 'of', 'props', 'layout', 'layout.mode', 'layout.gap', 'size', 'size.w', 'pos', 'children', 'parent', 'type'];
    const setRaw = (obj, path, v) => {
      const ps = path.split('.');
      let cur = obj;
      for (let i = 0; i < ps.length - 1; i++) {
        if (!cur[ps[i]] || typeof cur[ps[i]] !== 'object') cur[ps[i]] = {};
        cur = cur[ps[i]];
      }
      cur[ps[ps.length - 1]] = v;
    };
    const byType = {};
    for (const n of Object.values(base.nodes)) byType[n.type] = byType[n.type] || n;
    const master = Object.values(base.nodes).find((n) => n.component);
    if (master) byType.master = master;
    const fails = [];
    const tryAll = (label, d, id) => {
      let geo = null;
      try { geo = core27.solve(d); } catch { /* решатель — не предмет этого теста */ }
      let list = [];
      try { list = core27.validate(d, geo); } catch { /* так же */ }
      const ops = [
        [{ op: 'set', id, path: 'name', value: 'x' }], [{ op: 'remove', id }],
        [{ op: 'set', id, path: 'size.w', value: { mode: 'fixed', value: 100 } }],
        [{ op: 'setToken', path: 'colors.accent', value: '#ff0000' }]
      ];
      const steps = [
        ['describeDoc', () => describeDoc(d)],
        ['describeDoc+engine', () => describeDoc(d, [id], { engine: core27, geo, scopeKind: 'selection' })],
        ['describeTokens', () => describeTokens(d)],
        ['describeViolations', () => describeViolations(list, d)],
        ...ops.map((o) => ['describeChange ' + o[0].op, () => describeChange(o, d, null, core27)])
      ];
      for (const [name, fn] of steps) {
        try {
          const out = fn();
          assert.equal(typeof out, 'string', name + ' — строка');
        } catch (e) {
          fails.push(`${name} @ ${label}: ${e.message.slice(0, 60)}`);
        }
      }
    };
    for (const [t, n] of Object.entries(byType)) {
      for (const f of FIELDS) {
        for (const v of EVIL) {
          const d = JSON.parse(JSON.stringify(base));
          setRaw(d.nodes[n.id], f, v);
          tryAll(`${t}.${f}=${JSON.stringify(v)}`, d, n.id);
        }
      }
    }
    for (const path of ['colors', 'colors.accent', 'type', 'type.body.fontSize', 'spacing', 'spacing.3', 'radii']) {
      for (const v of EVIL) {
        const d = JSON.parse(JSON.stringify(base));
        setRaw(d.tokens, path, v);
        tryAll(`tokens.${path}=${JSON.stringify(v)}`, d, d.root);
      }
    }
    assert.deepEqual(fails, []);

    // и смысл не теряется: годные соседи описаны, отравленное поле — без мусора
    const d = JSON.parse(JSON.stringify(base));
    const text = Object.values(d.nodes).find((n) => n.type === 'text');
    text.name = { toString: 1 };
    text.characters = { toString: 1 };
    d.tokens.colors.accent = { toString: 1 };
    const digest = describeDoc(d);
    assert.match(digest, new RegExp(`#${text.id} text w=\\S+ h=\\S+ text="" `));
    assert.match(describeTokens(d), /accent=\?/);
    assert.equal(describeChange([{ op: 'set', id: text.id, path: 'opacity', value: 0.5 }], d, null, core27).includes('[object'), false);
  } finally {
    console.warn = quiet;
  }
});
