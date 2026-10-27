/**
 * Круг 56 (SPEC §22): модели со зрением арт-директор показывает саму картинку-образец, а не только
 * её цвета (§20). Только когда образец назван словами, только встроенная картинка; модель не приняла
 * картинку — тот же вызов без неё.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';
import { runCommand, runVariants, referenceImage, BrainError, REF_IMAGE_MAX_CHARS } from '../src/brain.js';
import { imageInsertOps } from '../src/shell.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const PLAN = { intent: 'create', title: 'Экран', summary: 'Соберу экран', steps: ['Шапка'] };
const DIRECTION = { concept: 'Зал', mood: ['тепло'], materials: [{ name: 'дерево', hex: '#3b2418' }], palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' }, fonts: { display: 'Prata', text: 'Golos Text' }, motifs: ['x'], composition: 'x', avoid: ['x'] };
const TREE = { type: 'frame', name: 'Кофейня', children: [{ type: 'text', name: 'Заголовок', text: 'Утро', style: 'display' }] };

function withPicture(src = `data:image/png;base64,${DATA}`) {
  const doc = quiet(() => core.createDoc('empty'));
  const r = imageInsertOps(doc, { selection: [], src, width: 300, height: 200, fileName: 'зал.png', at: { x: 0, y: 0 }, ids: { board: 'B', image: 'I' } });
  return { doc: core.applyOps(doc, r.ops).doc, selection: r.select };
}
function fake(script, vision) {
  const calls = [];
  return { name: 'fake', calls, vision,
    async ready() { return true; },
    async complete(messages, schema) {
      calls.push({ schema: schema.name, messages });
      let v = script[schema.name];
      if (Array.isArray(v)) v = v.shift();
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error('нет ответа ' + schema.name);
      return clone(v);
    } };
}
const directUser = (p) => p.calls.filter((c) => c.schema === 'direction').map((c) => c.messages.find((m) => m.role === 'user').content);
const SAID = 'собери экран кофейни в цветах этой картинки';

test('круг56: зрение есть и образец назван — арт-директор видит картинку', async () => {
  const { doc, selection } = withPicture();
  const p = fake({ plan: PLAN, direction: DIRECTION, tree: TREE }, true);
  const stages = [];
  const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false, onStage: (x) => stages.push(x) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const [turn] = directUser(p);
  assert.ok(Array.isArray(turn), 'реплика частями');
  assert.deepEqual(turn[1], { type: 'image', mime: 'image/png', data: DATA });
  assert.match(turn[0].text, /Образец приложен картинкой/);
  assert.ok(stages.some((s) => /Смотрю на образец/.test(s.detail || s.label || '')));
  // раскладчику картинка не уходит — только арт-директору
  assert.ok(p.calls.filter((c) => c.schema !== 'direction').every((c) => c.messages.every((m) => typeof m.content === 'string')));
});

test('круг56: без зрения, без слов об образце, адресная или огромная — без картинки', async () => {
  for (const [vision, said, src] of [
    [false, SAID, undefined], [undefined, SAID, undefined], [true, 'собери экран кофейни', undefined],
    [true, SAID, 'https://example.com/a.png'], [true, SAID, `data:image/png;base64,${'A'.repeat(REF_IMAGE_MAX_CHARS)}`],
  ]) {
    const { doc, selection } = withPicture(src);
    const p = fake({ plan: PLAN, direction: DIRECTION, tree: TREE }, vision);
    const res = await runCommand({ doc, selection, utterance: said, provider: p, engine: core, critic: false });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    for (const t of directUser(p)) assert.equal(typeof t, 'string', `${vision} ${said} ${String(src).slice(0, 30)}`);
  }
  assert.equal(referenceImage(withPicture().doc, ['I'], null, 'просто экран'), null);
  assert.deepEqual(referenceImage(withPicture().doc, ['I'], null, SAID), { mime: 'image/png', data: DATA });
});

test('круг56: модель не приняла картинку — тот же вызов без неё и заметка; другая ошибка — без повтора', async () => {
  const { doc, selection } = withPicture();
  const p = fake({ plan: PLAN, direction: [new BrainError('model', 'image not supported', { status: 400 }), DIRECTION], tree: TREE }, true);
  const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const turns = directUser(p);
  assert.equal(turns.length, 2);
  assert.ok(Array.isArray(turns[0]) && typeof turns[1] === 'string');
  assert.ok(res.direction, 'образ есть — по цветам');
  assert.ok(res.serviceNotes.some((n) => /не приняла картинку-образец/.test(n)), res.serviceNotes.join(' | '));
  const p2 = fake({ plan: PLAN, direction: [new BrainError('network', 'Нет связи'), DIRECTION], tree: TREE }, true);
  const r2 = await runCommand({ doc, selection, utterance: SAID, provider: p2, engine: core, critic: false });
  assert.equal(r2.error, undefined);
  assert.equal(directUser(p2).length, 1, 'сеть — не отказ от картинки: не повторяем');
  assert.equal(r2.direction, undefined, 'без образа, как при любом сбое арт-директора');
});

test('круг56, критики: смотрим только на первый образец — огромный не подменяется иконкой', async () => {
  const big = withPicture(`data:image/png;base64,${'A'.repeat(REF_IMAGE_MAX_CHARS)}`);
  const r = imageInsertOps(big.doc, { selection: [], src: `data:image/png;base64,${DATA}`, width: 16, height: 16, fileName: 'иконка.png', at: { x: 0, y: 400 }, ids: { board: 'B2', image: 'I2' } });
  const doc = core.applyOps(big.doc, r.ops).doc;
  assert.deepEqual(referenceImage(doc, ['I'], null, SAID), { skipped: 'big' });
  const p = fake({ plan: PLAN, direction: DIRECTION, tree: TREE }, true);
  const res = await runCommand({ doc, selection: ['I'], utterance: SAID, provider: p, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  for (const t of directUser(p)) assert.equal(typeof t, 'string');
  assert.ok(res.serviceNotes.some((n) => /слишком большой/.test(n)), res.serviceNotes.join(' | '));
  assert.deepEqual(referenceImage(withPicture('data:image/webp;base64,UklGRg==').doc, ['I'], null, SAID), { mime: 'image/webp', data: 'UklGRg==' });
});

test('круг56, критики: 5xx на картинке — повтор без неё; отказ запоминается для всех вариантов', async () => {
  const { doc, selection } = withPicture();
  const p = fake({ plan: PLAN, direction: [new BrainError('model', 'upstream', { status: 502 }), DIRECTION], tree: TREE }, true);
  const res = await runCommand({ doc, selection, utterance: SAID, provider: p, engine: core, critic: false });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const t = directUser(p);
  assert.equal(t.length, 2);
  assert.ok(Array.isArray(t[0]) && typeof t[1] === 'string');

  // варианты идут параллельно: каждый, кто уже отправил картинку, повторяет сам, но не больше раза
  const no = () => new BrainError('model', 'image not supported', { status: 400 });
  const pv = fake({ plan: PLAN, direction: [no(), no(), DIRECTION, DIRECTION], tree: TREE }, true);
  const list = await runVariants({ doc, selection, utterance: SAID, provider: pv, engine: core, n: 2, critic: false });
  assert.ok(Array.isArray(list) && list.length === 2);
  assert.equal(directUser(pv).length, 4);
  // общее состояние: следующий вызов той же команды картинку уже не предлагает
  const visionState = { refused: false };
  const ps = fake({ plan: PLAN, direction: [no(), DIRECTION, DIRECTION], tree: TREE }, true);
  await runCommand({ doc, selection, utterance: SAID, provider: ps, engine: core, critic: false, visionState });
  assert.equal(visionState.refused, true);
  await runCommand({ doc, selection, utterance: SAID, provider: ps, engine: core, critic: false, visionState });
  const turns = directUser(ps);
  assert.equal(turns.length, 3);
  assert.equal(turns.filter(Array.isArray).length, 1, 'после отказа картинку больше не шлём');
});
