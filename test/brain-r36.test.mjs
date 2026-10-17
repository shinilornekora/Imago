/**
 * Круг 36 (SPEC §11): микроанимации в агенте — состояния (наведение, нажатие, фокус) и движение.
 * Модель поддельная, движок — настоящий core.js: операции мозга обязаны проходить ядро.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import {
  runCommand, PROMPTS, SCHEMAS, downgradeSchema, classifyUtterance, describeDoc, describeTokens,
  coerceValue, normalizePath, ALLOWED_PATH_HEADS, CLEARABLE_PATHS, ruPath, ruPathGen, describeChange,
  recognizeMotionClear, looksMicroAnimation, normalizeMotionPath, themeToOps, normalizeTree,
  adjustSetPath, sameAsNow, describeViolations,
} from '../src/brain.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const dead = { name: 'fake', async ready() { return true; }, async complete() { throw new Error('модель звать не надо'); } };

/** Поддельная модель: ответы по имени схемы, массив — по очереди. */
function fake(script) {
  const calls = [];
  return {
    name: 'fake', calls,
    async ready() { return true; },
    async complete(messages, schema) {
      const name = schema && schema.name;
      calls.push({ schema: name, messages });
      let v = script[name];
      if (Array.isArray(v)) v = v.shift();
      if (typeof v === 'function') v = v(messages);
      if (v === undefined) throw new Error(`нет ответа для схемы ${name}`);
      return clone(v);
    },
  };
}

const byName = (doc, name) => Object.values(doc.nodes).find((n) => n && n.name === name);
const libraryIds = (doc) => {
  const lib = Object.values(doc.nodes).find((n) => n.type === 'page' && n.role === 'library');
  const out = new Set();
  const walk = (id) => { out.add(id); for (const k of (doc.nodes[id] && doc.nodes[id].children) || []) walk(k); };
  if (lib) walk(lib.id);
  return out;
};

/** Демо-документ, где кнопка на доске зовётся «Кнопка оплаты» (как в SPEC §11.4). */
function demo() {
  const doc = quiet(() => core.createDoc());
  const lib = libraryIds(doc);
  const btn = Object.values(doc.nodes).find((n) => n.role === 'button' && !lib.has(n.id));
  const r = core.applyOps(doc, [{ op: 'set', id: btn.id, path: 'name', value: 'Кнопка оплаты' }]);
  assert.equal(r.error, undefined);
  const board = r.doc.nodes[btn.id].parent && Object.values(r.doc.nodes).find((n) => n.role === 'artboard' && n.children.length);
  return { doc: r.doc, btn: btn.id, board: board && board.id };
}

function artboardOf(doc, id) {
  let cur = id;
  while (cur && doc.nodes[cur] && doc.nodes[cur].parent !== doc.root) cur = doc.nodes[cur].parent;
  return cur;
}

/* ── 1. Промпты и схемы: отказ «нет анимаций» снят ─────────────────────────── */

test('круг 36: промпты больше не называют тень и анимацию «тем, чего нет»', () => {
  const ctx = { tokens: '', digest: '', scopeLabel: 'активная доска', guess: 'edit', personaHint: '', placement: '', scales: null };
  const all = [PROMPTS.planner(ctx), PROMPTS.patch(ctx), PROMPTS.tree(ctx), PROMPTS.repair(['x'], {}, SCHEMAS.patch)].join('\n');
  assert.doesNotMatch(all, /тени \(shadow, elevation\)/);
  assert.doesNotMatch(all, /анимации и перехода/);
  assert.doesNotMatch(all, /просят поворот, тень/);
  assert.doesNotMatch(all, /\(поворот, тень,/);
  assert.doesNotMatch(all, /z, shadow, pos/, 'shadow больше не в списке выдуманных путей');
  // и наоборот — модель знает, что это есть и как это писать
  for (const p of [PROMPTS.planner(ctx), PROMPTS.patch(ctx)]) {
    assert.match(p, /МИКРОАНИМАЦИИ/);
    assert.match(p, /states\.hover|наведение/);
  }
  const patch = PROMPTS.patch(ctx);
  for (const s of ['states.hover.lift', 'motion.duration', 'motion.fast', 'shadow.md', 'states.press', 'follow']) {
    assert.ok(patch.includes(s), `в правилах правок нет «${s}»`);
  }
  assert.match(patch, /оживи кнопки/);
  assert.match(patch, /убери анимации/);
  // чего нет и сейчас — остаётся отказом
  assert.match(PROMPTS.planner(ctx), /появлени/);
});

test('круг 36: схемы ответа знают состояния, движение и тень; понижение схемы их не теряет', () => {
  const node = SCHEMAS.tree.schema.properties;
  assert.ok(node.states && node.states.properties.hover && node.states.properties.press && node.states.properties.focus);
  assert.deepEqual(Object.keys(node.states.properties.hover.properties).sort(),
    ['color', 'fill', 'lift', 'opacity', 'scale', 'shadow', 'stroke']);
  assert.deepEqual(node.motion.properties.easing.enum, ['standard', 'emphasized', 'decelerate', 'accelerate', 'linear', 'spring']);
  assert.deepEqual(node.shadow.enum, ['none', 'shadow.sm', 'shadow.md', 'shadow.lg']);
  // и во вложенных уровнях дерева, и в node у правки create
  assert.ok(node.children.items.properties.states);
  assert.ok(SCHEMAS.patch.schema.properties.edits.items.properties.node.properties.motion);
  const low = downgradeSchema(SCHEMAS.tree.schema);
  assert.ok(low.properties.states.properties.hover.properties.lift.anyOf, 'lift — число или ссылка');
  assert.deepEqual(low.properties.motion.properties.follow.enum, ['self', 'parent']);
  assert.match(SCHEMAS.patch.hint, /states\.hover/);
  assert.match(SCHEMAS.tree.hint, /states\?/);
  assert.ok(SCHEMAS.theme.schema.properties.motion && SCHEMAS.theme.schema.properties.shadow);
});

/* ── 2. Пути, значения, слова ────────────────────────────────────────────── */

test('круг 36: пути состояний — в белом списке, приводятся и снимаются; названы по-русски', () => {
  for (const h of ['states', 'motion', 'shadow']) assert.ok(ALLOWED_PATH_HEADS.has(h), h);
  assert.equal(normalizePath('hover.lift'), 'states.hover.lift');
  assert.equal(normalizePath('hover'), 'states.hover');
  assert.equal(normalizePath('states.active.background'), 'states.press.fill');
  assert.equal(normalizePath('states.hover.translateY'), 'states.hover.lift');
  assert.equal(normalizePath('states.hover.boxShadow'), 'states.hover.shadow');
  assert.equal(normalizePath('states.hover.duration'), 'motion.duration');
  assert.equal(normalizePath('transition.duration'), 'motion.duration');
  assert.equal(normalizePath('transition'), 'motion');
  assert.equal(normalizePath('boxShadow'), 'shadow');
  assert.equal(normalizePath('easing'), 'motion.easing');
  assert.equal(normalizeMotionPath('layout.gap'), 'layout.gap', 'чужие пути не трогаем');
  for (const p of ['states', 'states.hover', 'states.press.scale', 'motion', 'motion.duration', 'shadow']) {
    assert.ok(CLEARABLE_PATHS.has(p), `снимается ${p}`);
  }
  assert.equal(ruPath('states.hover.lift'), 'подъём при наведении');
  assert.equal(ruPath('states.press.fill'), 'заливка при нажатии');
  assert.equal(ruPath('states.focus'), 'фокус');
  assert.equal(ruPathGen('states.hover.shadow'), 'тени при наведении');
  for (const p of ['states', 'motion', 'shadow', 'motion.duration', 'motion.easing', 'motion.delay', 'motion.follow', 'states.hover.scale']) {
    assert.ok(!/[A-Za-z]/.test(ruPath(p)), `латиница в «${ruPath(p)}»`);
    assert.ok(!/[A-Za-z]/.test(ruPathGen(p)), `латиница в «${ruPathGen(p)}»`);
  }
});

test('круг 36: значения — ссылки на шкалы движения, тени и отступов, а не числа', () => {
  const { doc } = demo();                                         // spacing: 0 2 4 6 8 12 16 20 24 …
  const notes = [];
  const note = (m) => notes.push(m);
  const cv = (raw, path, said = '') => coerceValue(raw, path, doc, note, { engine: core, said });
  assert.equal(cv('2', 'states.hover.lift'), 'spacing.1');
  assert.equal(cv('4px', 'states.hover.lift'), 'spacing.2');
  assert.equal(cv('spacing.2', 'states.hover.lift'), 'spacing.2');
  assert.equal(cv('-3', 'states.hover.lift'), -3, 'вниз шкалы нет — число');
  assert.equal(cv('40', 'states.hover.lift'), 'spacing.8', 'больше 24 px — зажато до 24 (шаг 8)');
  assert.ok(notes.some((m) => /слишком сильно/.test(m)));
  assert.equal(cv('120', 'motion.duration'), 'motion.fast');
  assert.equal(cv('fast', 'motion.duration'), 'motion.fast');
  assert.equal(cv('медленно', 'motion.duration'), 'motion.slow');
  assert.equal(cv('0.2s', 'motion.duration'), 'motion.base');
  notes.length = 0;
  assert.equal(cv('250', 'motion.duration'), 'motion.base', 'число модели мимо шкалы — ближайшая ступень');
  assert.ok(notes.some((m) => /мимо шкалы движения/.test(m) && !/motion\./.test(m)), notes.join('\n'));
  assert.equal(cv('250', 'motion.duration', 'анимация 250 мс'), 250, 'число, названное человеком, — числом');
  assert.equal(cv('0.97', 'states.press.scale'), 0.97);
  assert.equal(cv('97%', 'states.press.scale'), 0.97);
  assert.equal(cv('md', 'states.hover.shadow'), 'shadow.md');
  assert.equal(cv('средняя', 'shadow'), 'shadow.md');
  assert.equal(cv('none', 'states.hover.shadow'), 'none', 'у тени none — значение «без тени», а не «снять»');
  assert.equal(cv('ease-out', 'motion.easing'), 'decelerate');
  assert.equal(cv('parent', 'motion.follow'), 'parent');
  assert.deepEqual(cv('{"lift":"2","shadow":"md","width":"100"}', 'states.hover'), { lift: 'spacing.1', shadow: 'shadow.md' });
  assert.ok(notes.some((m) => /поля «width» у состояния нет/.test(m)));
  assert.deepEqual(cv('{"duration":"120","easing":"ease"}', 'motion'), { duration: 'motion.fast', easing: 'standard' });
  notes.length = 0;
  assert.equal(cv('2', 'states.hovered.lift'), undefined, 'выдуманное состояние — пропуск со словами');
  assert.ok(notes.some((m) => /наведение, нажатие и фокус/.test(m)));
});

test('круг 36: цвет текста при наведении у кнопки-фрейма уходит её тексту; у страницы состояний нет', () => {
  const { doc, btn } = demo();
  const notes = [];
  const got = adjustSetPath(doc, btn, 'states.hover.color', (m) => notes.push(m));
  assert.ok(got && got.id !== btn && doc.nodes[got.id].type === 'text' && got.follow, JSON.stringify(got));
  const page = adjustSetPath(doc, doc.root, 'states.hover.fill', (m) => notes.push(m));
  assert.equal(page, null);
  assert.ok(notes.some((m) => /страниц/.test(m)));
  const txt = Object.values(doc.nodes).find((n) => n.type === 'text');
  assert.equal(adjustSetPath(doc, txt.id, 'states.hover.fill', () => {}), null, 'заливки у текста нет и при наведении');
});

/* ── 3. Классификатор и выжимка ─────────────────────────────────────────── */

test('круг 36: просьбы о микроанимациях — правка, а не создание и не отказ', () => {
  for (const u of ['оживи кнопки', 'добавь микроанимации', 'добавь кнопкам анимацию при наведении',
    'при наведении карточка приподнимается', 'кнопка темнеет при нажатии', 'сделай анимации медленнее']) {
    assert.ok(looksMicroAnimation(u), u);
    assert.equal(classifyUtterance(u).intent, 'edit', u);
  }
  assert.ok(!looksMicroAnimation('сделай анимацию загрузки'), 'загрузчик — не микроанимация');
  assert.ok(!looksMicroAnimation('добавь анимацию появления карточек'));
  assert.ok(!looksMicroAnimation('сделай заголовок крупнее'));
  assert.equal(classifyUtterance('добавь новый экран оплаты').intent, 'create', 'создание экрана осталось созданием');
  assert.equal(classifyUtterance('сделай шкалу движения медленнее').intent, 'theme', 'шкала движения — оформление');
});

test('круг 36: выжимка показывает состояния кратко и ссылками; токены — ступени движения и тени', () => {
  const { doc, btn } = demo();
  const r = core.applyOps(doc, [
    { op: 'set', id: btn, path: 'states', value: { hover: { lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.97 } } },
    { op: 'set', id: btn, path: 'motion', value: { duration: 'motion.fast', easing: 'standard' } },
  ]);
  assert.equal(r.error, undefined);
  const digest = describeDoc(r.doc, [artboardOf(r.doc, btn)], { engine: core });
  const line = digest.split('\n').find((l) => l.includes('"Кнопка оплаты"'));
  assert.match(line, /hover\{lift=spacing\.1\(2\) shadow=shadow\.md\}/);
  assert.match(line, /press\{scale=0\.97\}/);
  assert.match(line, /motion\{duration=motion\.fast\(120ms\) easing=standard\}/);
  const tokens = describeTokens(r.doc);
  assert.match(tokens, /motion\.fast=120 motion\.base=200 motion\.slow=320/);
  assert.match(tokens, /shadow\.sm shadow\.md shadow\.lg/);
});

/* ── 4. Конвейер на поддельной модели ───────────────────────────────────── */

const PLAN_MICRO = { intent: 'edit', title: 'Живые кнопки', summary: 'Наведение и нажатие у кнопки.', steps: ['Наведение', 'Нажатие'], targets: ['Кнопка оплаты'] };

test('круг 36: «оживи кнопки» — states/motion ложатся в ядро и описаны словами', async () => {
  const { doc, btn } = demo();
  const provider = fake({
    plan: PLAN_MICRO,
    patch: {
      edits: [
        { op: 'set', target: 'Кнопка оплаты', path: 'states.hover', value: '{"lift":"spacing.1","shadow":"shadow.md"}' },
        { op: 'set', target: 'Кнопка оплаты', path: 'states.press', value: '{"scale":"0.97","shadow":"shadow.sm"}' },
        { op: 'set', target: 'Кнопка оплаты', path: 'motion.duration', value: 'motion.fast' },
      ],
    },
  });
  const res = await runCommand({ doc, selection: [], utterance: 'оживи кнопки', provider, engine: core, activeArtboardId: artboardOf(doc, btn) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.cannot, undefined);
  assert.equal(res.ops.length, 3);
  const applied = core.applyOps(doc, res.ops);
  assert.equal(applied.error, undefined, JSON.stringify(applied.error));
  const n = applied.doc.nodes[btn];
  assert.deepEqual(n.states, { hover: { lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.97, shadow: 'shadow.sm' } });
  assert.deepEqual(n.motion, { duration: 'motion.fast' });
  assert.equal(res.changeSummary.split('; ')[0], 'Наведение «Кнопка оплаты»: подъём 2 px, тень средняя, 120 мс', res.changeSummary);
  assert.match(res.changeSummary, /нажатие «Кнопка оплаты»: масштаб 97 %, тень лёгкая/);
  // геометрия та же: состояние раскладку не трогает — и это не «прошло впустую»
  assert.equal(res.nothingChanged, undefined);
  assert.ok(!res.warnings.some((w) => /на экране — нет/.test(w)), res.warnings.join('\n'));
  // модель видела правила микроанимаций
  const sys = provider.calls.find((c) => c.schema === 'patch').messages[0].content;
  assert.match(sys, /СОСТОЯНИЯ И МИКРОАНИМАЦИИ/);
  assert.match(sys, /motion\.fast=120/);
});

test('круг 36: устаревший отказ модели «нет анимаций» больше не доходит до человека', async () => {
  const { doc, btn } = demo();
  const stale = 'В редакторе макетов нет анимаций и микроанимаций: слои хранят только размеры, отступы, цвета и текст.';
  // отказ в плане
  const p1 = fake({
    plan: { intent: 'refuse', title: 'Нельзя', summary: stale, steps: ['—'], cannot: stale },
    patch: { edits: [{ op: 'set', target: 'Кнопка оплаты', path: 'states.hover.lift', value: 'spacing.1' }] },
  });
  const r1 = await runCommand({ doc, selection: [btn], utterance: 'оживи кнопку', provider: p1, engine: core });
  assert.equal(r1.cannot, undefined, r1.cannot);
  assert.equal(r1.ops.length, 1);
  assert.ok(r1.serviceNotes && r1.serviceNotes.some((s) => /старой памяти/.test(s)));
  // отказ в патче — переспрос с напоминанием, и правки есть
  const p2 = fake({
    plan: PLAN_MICRO,
    patch: [{ cannot: stale, edits: [] }, { edits: [{ op: 'set', target: 'Кнопка оплаты', path: 'states.hover.shadow', value: 'shadow.md' }] }],
  });
  const r2 = await runCommand({ doc, selection: [btn], utterance: 'добавь микроанимации', provider: p2, engine: core });
  assert.equal(r2.cannot, undefined, r2.cannot);
  assert.equal(r2.ops.length, 1);
  assert.match(p2.calls[p2.calls.length - 1].messages.at(-1).content, /ЕСТЬ состояния слоя/);
  // а вот анимация загрузки — по-прежнему честное «нельзя»
  const p3 = fake({ plan: { intent: 'refuse', title: 'Нельзя', summary: 'нет', steps: ['—'], cannot: 'Анимаций загрузки в редакторе нет — есть состояния наведения и нажатия.' } });
  const r3 = await runCommand({ doc, selection: [], utterance: 'сделай анимацию загрузки', provider: p3, engine: core });
  assert.match(r3.cannot, /загрузки/);
});

test('круг 36: «убери анимации» снимает states и motion без модели', async () => {
  const { doc, btn } = demo();
  const card = byName(doc, 'Карточка встречи');
  const other = Object.values(doc.nodes).find((n) => n.role === 'metric' && n.type === 'frame' && artboardOf(doc, n.id) !== artboardOf(doc, btn) && !libraryIds(doc).has(n.id));
  const r = core.applyOps(doc, [
    { op: 'set', id: btn, path: 'states', value: { hover: { lift: 'spacing.1' } } },
    { op: 'set', id: btn, path: 'motion', value: { duration: 'motion.fast' } },
    { op: 'set', id: card.id, path: 'states.hover.shadow', value: 'shadow.md' },
    { op: 'set', id: other.id, path: 'states.hover.lift', value: 'spacing.2' },
  ]);
  assert.equal(r.error, undefined);
  const res = await runCommand({ doc: r.doc, selection: [], utterance: 'убери анимации', provider: dead, engine: core, activeArtboardId: artboardOf(doc, btn) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.usage.calls, 0);
  assert.equal(res.local, 'motion-clear');
  assert.equal(res.ops.length, 3, JSON.stringify(res.ops));
  const after = core.applyOps(r.doc, res.ops);
  assert.equal(after.error, undefined);
  assert.equal(after.doc.nodes[btn].states, undefined);
  assert.equal(after.doc.nodes[btn].motion, undefined);
  assert.equal(after.doc.nodes[card.id].states, undefined);
  assert.ok(after.doc.nodes[other.id].states, 'другая доска не тронута');
  assert.match(res.changeSummary, /анимации у 2 слоёв: сняты|Анимации/i);
  // везде — и на другой доске
  const all = await runCommand({ doc: r.doc, selection: [], utterance: 'убери все анимации везде', provider: dead, engine: core, activeArtboardId: artboardOf(doc, btn) });
  assert.equal(all.ops.filter((o) => o.id === other.id).length, 1);
  // снимать нечего — честно, без операций
  const none = await runCommand({ doc, selection: [], utterance: 'убери анимации', provider: dead, engine: core, activeArtboardId: artboardOf(doc, btn) });
  assert.deepEqual(none.ops, []);
  assert.equal(none.nothingToChange, true);
  assert.ok(none.warnings.some((w) => /анимаций нет/.test(w)));
  assert.ok(recognizeMotionClear('сними микроанимации'));
  assert.ok(recognizeMotionClear('отключи эффекты наведения'));
  assert.equal(recognizeMotionClear('убери анимации у кнопки оплаты'), null, 'с предметом — решает модель');
  assert.equal(recognizeMotionClear('убери заголовок'), null);
});

test('круг 36: «убери анимации» от модели (value:none) — тоже снятие', async () => {
  const { doc, btn } = demo();
  const r = core.applyOps(doc, [{ op: 'set', id: btn, path: 'states', value: { hover: { lift: 'spacing.1' } } }, { op: 'set', id: btn, path: 'motion', value: { duration: 'motion.fast' } }]);
  const provider = fake({
    plan: PLAN_MICRO,
    patch: { edits: [{ op: 'set', target: 'Кнопка оплаты', path: 'states', value: 'none' }, { op: 'remove', target: 'Кнопка оплаты', path: 'motion' }] },
  });
  const res = await runCommand({ doc: r.doc, selection: [], utterance: 'убери анимации у кнопки оплаты', provider, engine: core, activeArtboardId: artboardOf(doc, btn) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.ops.map((o) => [o.path, o.value === undefined]), [['states', true], ['motion', true]]);
  assert.match(res.changeSummary, /^Анимации «Кнопка оплаты»: сняты/);
});

test('круг 36: «для всех кнопок» — групповая правка по однотипным слоям', async () => {
  const { doc, btn } = demo();
  // вторая кнопка рядом с первой — копия ядром
  const parent = doc.nodes[btn].parent;
  const copy = core.cloneSubtree(doc, btn);
  const ops = copy.nodes.map((n, i) => ({ op: 'create', node: { ...n, ...(n.children ? { children: [] } : {}), ...(i === 0 ? { parent, name: 'Кнопка отмены' } : {}) } }));
  const r = core.applyOps(doc, ops);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const provider = fake({
    plan: PLAN_MICRO,
    patch: { edits: [
      { op: 'set', target: 'Кнопка', path: 'states.hover', value: '{"lift":"spacing.1","shadow":"shadow.md"}' },
      { op: 'set', target: 'Кнопка', path: 'motion.duration', value: 'motion.fast' },
    ] },
  });
  const res = await runCommand({ doc: r.doc, selection: [], utterance: 'добавь микроанимации для всех кнопок', provider, engine: core, activeArtboardId: artboardOf(doc, btn) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const ids = new Set(res.ops.map((o) => o.id));
  assert.ok(ids.has(btn) && ids.has(copy.rootId), JSON.stringify(res.ops));
  assert.ok(![...ids].some((id) => libraryIds(r.doc).has(id)), 'мастер библиотеки не тронут');
  assert.match(res.changeSummary, /^Наведение у 2 слоёв: подъём 2 px, тень средняя, 120 мс/);
});

test('круг 36: «сделай анимации медленнее» — ступень вверх; не вышло — так и сказано', async () => {
  const { doc, btn } = demo();
  const r = core.applyOps(doc, [{ op: 'set', id: btn, path: 'states.hover.lift', value: 'spacing.1' }, { op: 'set', id: btn, path: 'motion.duration', value: 'motion.fast' }]);
  const slower = fake({ plan: PLAN_MICRO, patch: { edits: [{ op: 'set', target: 'Кнопка оплаты', path: 'motion.duration', value: 'motion.base' }] } });
  const res = await runCommand({ doc: r.doc, selection: [btn], utterance: 'сделай анимации медленнее', provider: slower, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.ops[0].value, 'motion.base');
  assert.equal(res.changeSummary, 'Скорость анимации «Кнопка оплаты»: 120 → 200 мс');
  assert.ok(!res.warnings.some((w) => /Проверка макета: просили/.test(w)), res.warnings.join('\n'));
  const wrong = fake({ plan: PLAN_MICRO, patch: { edits: [{ op: 'set', target: 'Кнопка оплаты', path: 'motion.easing', value: 'linear' }] } });
  const res2 = await runCommand({ doc: r.doc, selection: [btn], utterance: 'сделай анимации медленнее', provider: wrong, engine: core });
  assert.ok(res2.warnings.some((w) => /просили медленнее, а скорость анимации «Кнопка оплаты» не изменилась \(120 мс\)/.test(w)), res2.warnings.join('\n'));
});

test('круг 36: микроанимация дольше 600 мс — предупреждение одной строкой', async () => {
  const { doc, btn } = demo();
  const provider = fake({ plan: PLAN_MICRO, patch: { edits: [
    { op: 'set', target: 'Кнопка оплаты', path: 'states.hover.lift', value: '2' },
    { op: 'set', target: 'Кнопка оплаты', path: 'motion.duration', value: '800' },
  ] } });
  const res = await runCommand({ doc, selection: [btn], utterance: 'при наведении кнопка плавно приподнимается за 800 мс', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const slow = res.warnings.filter((w) => /дольше 600 мс/.test(w));
  assert.equal(slow.length, 1, res.warnings.join('\n'));
  assert.match(slow[0], /«Кнопка оплаты»: микроанимация длится 800 мс/);
  assert.match(res.changeSummary, /Наведение «Кнопка оплаты»: подъём 2 px, 800 мс/);
});

test('круг 36: «цвет текста при наведении» у кнопки — правка тексту и follow parent', async () => {
  const { doc, btn } = demo();
  const provider = fake({ plan: PLAN_MICRO, patch: { edits: [
    { op: 'set', target: 'Кнопка оплаты', path: 'states.hover', value: '{"fill":"accentInk","color":"surface"}' },
  ] } });
  const res = await runCommand({ doc, selection: [btn], utterance: 'кнопка темнеет при наведении, а текст светлеет', provider, engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const applied = core.applyOps(doc, res.ops);
  assert.equal(applied.error, undefined);
  const text = doc.nodes[btn].children.map((id) => applied.doc.nodes[id]).find((n) => n.type === 'text');
  assert.deepEqual(applied.doc.nodes[btn].states, { hover: { fill: 'accentInk' } });
  assert.deepEqual(text.states, { hover: { color: 'surface' } });
  assert.equal(text.motion.follow, 'parent');
});

test('круг 36: новое дерево несёт состояния; тема меняет ступени движения', () => {
  const { doc } = demo();
  const notes = [];
  const spec = normalizeTree({
    type: 'frame', name: 'Кнопка купить', fill: 'accent',
    states: { hover: { lift: 2, shadow: 'md', color: 'surface' }, press: { scale: 0.97 } },
    motion: { duration: 'fast', easing: 'spring' },
    children: [{ type: 'text', name: 'Подпись', text: 'Купить' }],
  }, { doc, warn: (m) => notes.push(m), engine: core });
  assert.deepEqual(spec.states, { hover: { lift: 'spacing.1', shadow: 'shadow.md' }, press: { scale: 0.97 } });
  assert.deepEqual(spec.motion, { duration: 'motion.fast', easing: 'spring' });
  assert.deepEqual(spec.children[0].states, { hover: { color: 'surface' } });
  assert.equal(spec.children[0].motion.follow, 'parent');
  const ops = themeToOps({ doc, theme: { motion: [{ name: 'slow', value: 400 }], shadow: [{ name: 'md', value: '0 4px 12px rgba(0,0,0,.12)' }] }, engine: core, warn: () => {} });
  assert.deepEqual(ops.map((o) => o.path), ['motion.slow', 'shadow.md']);
  const bad = [];
  assert.throws(() => themeToOps({ doc, theme: { motion: [{ name: 'fast', value: 900 }] }, engine: core, warn: (m) => bad.push(m) }));
  assert.ok(bad.some((m) => /ступени перепутаны/.test(m)));
});

test('круг 36: describeChange по операциям — слова, а не motion.fast', () => {
  const { doc, btn } = demo();
  const ops = [
    { op: 'set', id: btn, path: 'states.hover.lift', value: 'spacing.1' },
    { op: 'set', id: btn, path: 'states.hover.shadow', value: 'shadow.md' },
    { op: 'set', id: btn, path: 'motion.duration', value: 'motion.fast' },
  ];
  const after = core.applyOps(doc, ops).doc;
  const text = describeChange(ops, doc, after, core);
  assert.equal(text, 'Наведение «Кнопка оплаты»: подъём 2 px, тень средняя, 120 мс');
  assert.doesNotMatch(text, /motion|shadow|spacing/);
  assert.ok(sameAsNow('spacing.1', 'spacing.1', 'states.hover.lift'));
});

test('круг 36: замечания валидатора о состояниях — словами, без hover/press/motion', () => {
  const { doc, btn } = demo();
  const list = [
    { code: 'motion-slow', nodeId: btn, severity: 'warn', message: '«Кнопка оплаты»: переход 800 мс — для микроанимации дольше 600 мс' },
    { code: 'press-without-hover', nodeId: btn, severity: 'info', message: '«Кнопка оплаты»: есть нажатие, но нет наведения' },
    { code: 'state-no-effect', nodeId: btn, severity: 'info', message: '«Кнопка оплаты»: состояние hover совпадает с базой — ничего не меняет' },
    { code: 'off-scale', nodeId: btn, severity: 'info', message: '«Кнопка оплаты»: подъём 3 px (hover) вне шкалы отступов' },
    { code: 'dead-motion-ref', nodeId: btn, severity: 'warn', message: '«Кнопка оплаты»: motion.duration → «motion.slow»: шага нет' },
  ];
  const text = describeViolations(list, doc);
  assert.doesNotMatch(text, /hover|press|motion\.|Отступы/, text);
  assert.match(text, /наведение ничем не отличается/);
  assert.match(text, /подъём 3 px \(при наведении\)/);
});
