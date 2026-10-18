/**
 * Круг 39 (SHELL): N1 (слова о версии движка), N3 (дублирование — одна реализация в ядре),
 * N6 (подключение без ложных состояний, итог агента из title, клавиши по платформе, пример
 * без миграции, мелочи UX, выжившие мутанты S02/S03/S05/S07, пустая обёртка после слияния,
 * скорость палитры на большом документе).
 * Браузерная часть — Playwright-сценарии критика UX (scratchpad/critic-ux/r39) на своём стенде.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';
import { createSync, memoryStorage, statusLine, engineWords, DROP_WORDS } from '../src/sync.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const sz = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });
const apply = (d, ops) => {
  const r = core.applyOps(d, ops);
  assert.ok(!r.error, r.error && r.error.message);
  return r.doc;
};

/* ------------------------------ мутанты S02/S03/S05/S07 ------------------------------ */

test('r39 (S02): выделение «родитель + его ребёнок» — корень один, копия одна', () => {
  const doc = core.createDoc();
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && !core.isArtboard(doc, n.id)
    && (n.children || []).length >= 2 && n.parent && doc.nodes[n.parent].type === 'frame' && !n.component);
  const kid = frame.children[0];
  assert.deepEqual(SHELL.selectionRoots(doc, [frame.id, kid]), [frame.id]);
  assert.deepEqual(SHELL.selectionRoots(doc, [kid, frame.id]), [frame.id], 'порядок выделения не важен');
  const r = SHELL.duplicateOps(doc, [frame.id, kid]);
  assert.ok(r.ops, r.error);
  assert.equal(r.ids.length, 1, 'одна новая вершина');
  const size = core.subtreeIds(doc, frame.id).length;
  assert.equal(r.ops.filter((o) => o.op === 'create').length, size, 'ребёнок не скопирован второй раз');
  const after = apply(doc, r.ops);
  assert.equal(Object.keys(after.nodes).length, Object.keys(doc.nodes).length + size);
});

test('r39 (S03): «показать» снимает поле visible (SPEC §1.2: видим — поля нет), а не пишет true', () => {
  const doc = core.createDoc();
  const id = core.artboards(doc)[0].children[0];
  const hidden = apply(doc, SHELL.visibleOps(doc, [id], false).ops);
  assert.equal(hidden.nodes[id].visible, false);
  const r = SHELL.visibleOps(hidden, [id], true);
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].value, undefined, 'значения нет — поле снимается');
  const shown = apply(hidden, r.ops);
  assert.equal(Object.prototype.hasOwnProperty.call(shown.nodes[id], 'visible'), false, 'поля visible в узле нет');
  assert.equal(core.hashDoc(shown), core.hashDoc(doc), 'документ ровно как до «скрыть»');
});

test('r39 (S05): «зазор меньше» при числе, равном шагу шкалы, — на шаг ниже, а не на месте', () => {
  let doc = core.createDoc();
  const ab = core.artboards(doc)[0];
  doc = apply(doc, [core.ops.create({ type: 'frame', id: 'f_gap', name: 'Ряд', parent: ab.id, children: [], layout: { mode: 'row' } })]);
  const steps = core.scaleSteps(doc, 'spacing');
  const k = steps.indexOf(8);
  assert.ok(k > 0, 'на шкале есть 8 и шаг ниже');
  doc = apply(doc, [core.ops.set('f_gap', 'layout.gap', 8)]);
  assert.equal(doc.nodes.f_gap.layout.gap, 8, 'зазор записан числом');
  const less = SHELL.gapStepOps(doc, ['f_gap'], -1);
  assert.ok(less.ops, less.error);
  assert.equal(less.ops[0].value, core.scaleRef('spacing', k - 1));
  assert.match(less.words, new RegExp(`8 → ${steps[k - 1]} px`));
  const more = SHELL.gapStepOps(doc, ['f_gap'], 1);
  assert.equal(more.ops[0].value, core.scaleRef('spacing', k + 1), 'и «больше» — на шаг выше, а не на тот же');
  // мимо шкалы: 10 → ближайший меньший 8, ближайший больший 12
  const d10 = apply(doc, [core.ops.set('f_gap', 'layout.gap', 10)]);
  assert.equal(SHELL.gapStepOps(d10, ['f_gap'], -1).ops[0].value, core.scaleRef('spacing', k));
});

test('r39 (S07): копия в свободной рамке сдвинута вниз-вправо, а не ложится на оригинал', () => {
  let doc = core.createDoc();
  const ab = core.artboards(doc)[0];
  doc = apply(doc, [
    core.ops.create({ type: 'frame', id: 'f_free', name: 'Свободная', parent: ab.id, children: [], layout: { mode: 'none' }, size: sz(300, 200) }),
    core.ops.create({ type: 'rect', id: 'r_a', name: 'Квадрат', parent: 'f_free', pos: { x: 20, y: 30 }, size: sz(40, 40) }),
  ]);
  const r = SHELL.duplicateOps(doc, ['r_a']);
  assert.ok(r.ops, r.error);
  const after = apply(doc, r.ops);
  const copy = after.nodes[r.ids[0]];
  assert.equal(copy.parent, 'f_free');
  const dx = copy.pos.x - 20;
  const dy = copy.pos.y - 30;
  assert.ok(dx > 0 && dy > 0, `копия сдвинута: ${dx}, ${dy}`);
  assert.equal(dx, dy, 'сдвиг по диагонали');
  const geo = core.solve(after);
  assert.notDeepEqual([geo.rects[copy.id].x, geo.rects[copy.id].y], [geo.rects.r_a.x, geo.rects.r_a.y]);
  // в потоке сдвига нет: место задаёт раскладка
  const flowKid = core.artboards(doc)[0].children.find((k) => doc.nodes[k].type !== 'frame' || doc.nodes[k].layout);
  const rf = SHELL.duplicateOps(doc, [flowKid]);
  const c2 = apply(doc, rf.ops).nodes[rf.ids[0]];
  assert.equal(c2.pos, doc.nodes[flowKid].pos, 'у копии в потоке pos как у оригинала');
});

/* ------------------------------ N3: дублирование ------------------------------ */

test('r39 (N3): «Дублировать» — операции ядра (core.duplicateOps), своей копии логики у оболочки нет', () => {
  const src = read('src/shell.js');
  assert.match(src, /CORE_NS\.duplicateOps\(doc, ids, o\)/, 'оболочка зовёт ядро');
  assert.doesNotMatch(src, /cloneSubtree/, 'своей копии поддерева у оболочки нет');
  const app = read('app.js');
  assert.match(app, /case 'duplicate': \{\s*const r = SHELL\.duplicateOps\(/, 'команда таблицы — через SHELL.duplicateOps');
  assert.doesNotMatch(app, /cloneSubtree\(/, 'в app.js своей копии поддерева нет');
  assert.equal(typeof core.duplicateOps, 'function');
});

test('r39 (N3): копия мастера компонента — годный документ, свойства копии указывают внутрь копии', () => {
  const doc = core.ensureLibrary(core.createDoc());
  const masters = Object.values(doc.nodes).filter((n) => n.component);
  assert.ok(masters.length >= 1);
  for (const m of masters) {
    const r = SHELL.duplicateOps(doc, [m.id]);
    assert.ok(r.ops, `${m.name}: ${r.error}`);
    const after = apply(doc, r.ops);
    assert.equal(core.checkImportDoc(after), null, `${m.name}: документ годен`);
    const copy = after.nodes[r.ids[0]];
    assert.ok(copy.component, 'копия мастера — тоже мастер');
    assert.notEqual(copy.component.name, m.component.name, 'у копии своё имя компонента');
    const inside = new Set(core.subtreeIds(after, copy.id));
    for (const p of copy.component.props || []) if (p.target) assert.ok(inside.has(p.target), `свойство «${p.name}» — внутрь копии`);
    assert.doesNotMatch(r.words, /[a-z]_[a-z0-9]{5,}/i, 'слова без id');
  }
});

test('r39 (N3): отказ копии — слова без id и кодов', () => {
  const doc = core.createDoc();
  assert.match(SHELL.duplicateOps(doc, []).error, /^Копировать нечего/);
  assert.match(SHELL.duplicateOps(doc, [doc.root]).error, /^Копировать нечего/);
  for (const bad of [[], [doc.root], ['нет_такого']]) assert.doesNotMatch(SHELL.duplicateOps(doc, bad).error, /[a-z]+_[a-z0-9]{4,}/i);
});

/* ------------------------------ обёртка и слияние ------------------------------ */

test('r39 (N6е): «Обернуть», чьи слои удалил соавтор, не оставляет пустую «Группу»', () => {
  const doc = core.ensureLibrary(core.createDoc());
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && (n.children || []).length >= 3 && !core.isArtboard(doc, n.id) && !n.component);
  const sel = [frame.children[1], frame.children[2]];
  const w = SHELL.wrapOps(doc, sel, { rects: core.solve(doc).rects });
  assert.ok(w.ops, w.error);
  const create = w.ops.find((o) => o.op === 'create');
  assert.deepEqual(create.node.children, sel, 'дети перечислены в самом create — одна операция «сгруппировать»');
  // отмена одной инверсией точна и без сети
  const done = apply(doc, w.ops);
  assert.deepEqual(done.nodes[w.id].children, sel);
  assert.equal(core.hashDoc(apply(done, core.invertOps(doc, w.ops))), core.hashDoc(doc));
  // соавтор удалил оба слоя раньше: слияние отбрасывает и саму рамку (core.rebase, круг 39) —
  // пустой «Группы» нет ни на сервере, ни в реплике, второй транзакции не нужно
  const theirs = sel.map((k) => core.ops.remove(k));
  const head = apply(doc, theirs);
  const tomb = new Map();
  core.collectTombstones(doc, theirs, tomb);
  const m = core.rebase(head, w.ops, { tombstones: tomb });
  assert.deepEqual(m.ops, [], 'транзакция пустая');
  assert.deepEqual(m.dropped.map((d) => d.reason), w.ops.map(() => 'removed'));
  assert.ok(!apply(head, m.ops).nodes[w.id]);
  // человеку — про рамку и её слои, а не «Добавление … этот слой уже удалён»
  const said = SHELL.droppedWords({ dropped: m.dropped.slice(0, 1), whoOf: () => ({ author: 'Аня' }) });
  assert.equal(said.title, 'Рамка «Группа» не создана — Аня удалила слои, которые в неё входили');
  assert.equal(SHELL.droppedWords({ dropped: m.dropped.slice(0, 1) }).title, 'Рамка «Группа» не создана — слоёв, которые в неё входили, уже нет');
  // удалён один из двух — рамка с оставшимся живёт
  const one = [core.ops.remove(sel[0])];
  const head1 = apply(doc, one);
  const t1 = new Map();
  core.collectTombstones(doc, one, t1);
  const m1 = apply(head1, core.rebase(head1, w.ops, { tombstones: t1 }).ops);
  assert.deepEqual(m1.nodes[w.id].children, [sel[1]]);
  // второй транзакции «убрать пустую рамку» у оболочки больше нет
  const app = read('app.js');
  assert.doesNotMatch(app, /dropEmptyWrap|emptyWrapOps|wrapOf/);
  assert.equal(SHELL.emptyWrapOps, undefined);
});

/* ------------------------------ скорость палитры ------------------------------ */

test('r39 (N6е): строки палитры на документе в 20 тыс. слоёв — быстрее кадра на нажатие', () => {
  let doc = core.createDoc();
  const b = core.artboards(doc)[0].id;
  const ops = [];
  for (let i = 0; i < 19800; i++) ops.push(core.ops.create({ type: 'rect', id: `r${i}`, name: `Заголовок ${i}`, parent: b, size: sz(5, 5) }));
  doc = apply(doc, ops);
  const ctx = { doc, activeArtboardId: b };
  for (const q of ['/', '/в', '/выделить', '/выделить заг', '/выделить заголовок 5', 'выдели заголовок 5', '/доска ', '/масштаб 15']) {
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      SHELL.paletteRows(q, ctx);
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < 16, `«${q}»: ${best.toFixed(1)} мс`);
  }
  // набранное целиком по-прежнему первой строкой — и без документа
  assert.equal(SHELL.paletteRows('/выделить заголовок 5', ctx)[0].run, '/выделить заголовок 5');
  // выделение по имени на исполнении находит слой
  const one = apply(doc, [core.ops.create({ type: 'rect', id: 'r_cookie', name: 'Печенька', parent: b, size: sz(5, 5) })]);
  const hit = SHELL.shellIntent('/выделить печеньку', { doc: one, activeArtboardId: b });
  assert.ok(hit && (hit.ids || [])[0] === 'r_cookie', JSON.stringify(hit).slice(0, 200));
});

/* ------------------------------ N6в: клавиши ------------------------------ */

test('r39 (N6в): клавиши в таблице — абстрактные, подпись по платформе, на телефоне — никакой', () => {
  for (const c of SHELL.SHELL_COMMANDS) {
    if (!c.keys) continue;
    assert.doesNotMatch(c.keys, /[⌘⇧⌥]|Ctrl/, `${c.id}: «${c.keys}» — без платформы`);
  }
  const win = { mac: false, touch: false };
  const mac = { mac: true, touch: false };
  const phone = { mac: false, touch: true };
  assert.equal(SHELL.keyLabel('Mod+A', win), 'Ctrl+A');
  assert.equal(SHELL.keyLabel('Mod+A', mac), '⌘A');
  assert.equal(SHELL.keyLabel('Shift+Mod+G', win), 'Ctrl+Shift+G');
  assert.equal(SHELL.keyLabel('Shift+Mod+G', mac), '⇧⌘G');
  assert.equal(SHELL.keyLabel('Esc', mac), 'Esc');
  assert.equal(SHELL.keyLabel('Mod+Z', phone), '');
  assert.equal(SHELL.undoKeyWords(win), 'Ctrl+Z');
  assert.deepEqual(SHELL.keyPlatform({ platform: 'Win32', userAgent: '' }), { mac: false, touch: false });
  assert.deepEqual(SHELL.keyPlatform({ platform: 'Linux x86_64', userAgent: '' }), { mac: false, touch: false });
  assert.equal(SHELL.keyPlatform({ platform: 'MacIntel', userAgent: '' }).mac, true);
  assert.equal(SHELL.keyPlatform({ userAgentData: { platform: 'macOS' }, platform: '' }).mac, true);
  assert.equal(SHELL.keyPlatform({ platform: 'Linux armv8l' }, () => true).touch, true);
  assert.equal(SHELL.keyPlatform(null).mac, false);
  // «стоп» после записи: клавиша по платформе, на телефоне — только кнопка
  assert.match(SHELL.stoppedWriteWords({ title: 'Крупнее' }, '', mac).note, /⌘Z/);
  assert.doesNotMatch(SHELL.stoppedWriteWords({ title: 'Крупнее' }, '', phone).note, /Ctrl|⌘/);
});

test('r39 (N6в): Ctrl/⌘+A и «/выделить всё» — одна команда; Ctrl/⌘+D — и из списка слоёв', () => {
  const app = read('app.js');
  // перехват на окне в фазе захвата — раньше сцены, чтобы у неё не было своей «рамки во весь мир»
  const boot = app.slice(app.indexOf('async function boot()'), app.indexOf('stage = new Stage('));
  assert.match(boot, /addEventListener\('keydown', onModKeyCapture, true\)/);
  const fn = app.slice(app.indexOf('function onModKeyCapture'), app.indexOf('function onModKeyCapture') + 1400);
  assert.match(fn, /stopImmediatePropagation/);
  assert.match(fn, /kind: k === 'a' \? 'select-all' : 'duplicate'/);
  assert.doesNotMatch(fn, /closest\('#canvas'\)|layers/, 'фокус в списке слоёв не исключение');
  assert.doesNotMatch(app, /allSelectableIds/, 'второго «выделить всё» нет');
  // «/выделить всё» и Ctrl+A — одна запись таблицы с одной подписью
  const sa = SHELL.shellCommand('select-all');
  assert.equal(sa.keys, 'Mod+A');
  assert.equal(SHELL.commandIdOf(SHELL.shellIntent('/выделить всё', {})), 'select-all');
  // подписи клавиш в палитре и справке — через keyText
  assert.doesNotMatch(app, /k\.textContent = (r|c)\.keys/);
  assert.doesNotMatch(app, /'[^'\n]*(Ctrl\+[A-ZК]|⌘)[^'\n]*'/, 'в строках оболочки нет зашитых клавиш');
});

test('r39 (UX): голая строка палитры подписана тем, что исполняет', () => {
  for (const r of SHELL.paletteRows('', {})) {
    if (r.run && !r.value && !r.typed) {
      const c = SHELL.shellCommand(r.id);
      if (c.args && c.args.length) assert.equal(r.example, r.run, `${r.title}: подпись «${r.example}», исполняет «${r.run}»`);
    }
  }
  const theme = SHELL.paletteRows('тема', {}).find((r) => r.key === 'theme');
  assert.equal(theme.run, '/тема');
  assert.equal(theme.example, '/тема');
});

/* ------------------------------ N6б: итог агента ------------------------------ */

test('r39 (N6б): заголовок итога — что сделано (title), слова модели — второй строкой, план — нигде', () => {
  assert.deepEqual(SHELL.agentHeadline({ title: 'Нарисовал «Печенька»: 6 деталей', summary: 'Рисую печеньку с шоколадной крошкой.', plan: 'Рисую печеньку с шоколадной крошкой.' }),
    { headline: 'Нарисовал «Печенька»: 6 деталей', aside: '' });
  assert.deepEqual(SHELL.agentHeadline({ title: 'Укрупнил заголовок', summary: 'Заголовок стал крупнее и жирнее' }),
    { headline: 'Укрупнил заголовок', aside: 'Заголовок стал крупнее и жирнее' });
  assert.deepEqual(SHELL.agentHeadline({ title: '', summary: 'Готово: шапка' }), { headline: 'Готово: шапка', aside: '' });
  assert.deepEqual(SHELL.agentHeadline({}), { headline: 'Готово', aside: '' });
  assert.equal(SHELL.agentHeadline({ title: 'А', variant: { label: 'Строгий' } }).headline, 'Принят вариант «Строгий»');
  const n = SHELL.normalizeResult({ title: ' Сделал ', summary: 'план', plan: { summary: 'план' } });
  assert.equal(n.title, 'Сделал');
  assert.equal(n.plan, 'план');
  const app = read('app.js');
  assert.match(app, /SHELL\.agentHeadline\(\{ title: r\.title, summary: r\.summary/);
  assert.doesNotMatch(app, /: \(r\.summary \|\| 'Готово'\)/);
});

/* ------------------------------ N1 и N6а: реплика ------------------------------ */

test('r39 (N1): версия движка — «Вышла новая версия редактора — обновите страницу»', () => {
  const newer = engineWords(3, 2);
  assert.equal(newer.title, 'Вышла новая версия редактора — обновите страницу');
  assert.equal(newer.newer, true);
  assert.equal(engineWords(null, 2).newer, true, '426 без версии — сервер новее');
  const older = engineWords(1, 2);
  assert.equal(older.newer, false);
  assert.match(older.status, /сервер ещё на прежней версии/);
  assert.equal(statusLine({ online: true, error: 'engine', engine: 3, ownEngine: 2 }), 'вышла новая версия редактора — обновите страницу');
  assert.equal(statusLine({ online: true, error: 'engine' }), 'вышла новая версия редактора — обновите страницу');
  assert.equal(DROP_WORDS.expand_nodes, 'слишком много вложенных экземпляров');
  // `engine` от Orchestrator — разошлись сервер агента и сервис документов: страница тут ни при чём
  const ae = SHELL.agentErrorWords({ code: 'engine', message: 'Версия движка агента и сервиса документов разошлась' });
  assert.match(ae.title, /Сервер агента и сервер документов/);
  assert.doesNotMatch(`${ae.title} ${ae.note}`, /обновите страницу/i);
  const app = read('app.js');
  assert.match(app, /if \(e\.code === 'engine'\) \{[\s\S]{0,300}engineWords\(e\.engine, CORE\.ENGINE_VERSION\)/);
});

/** Сокет, которым тест управляет руками: открыть, прислать hello, закрыть. */
function manualSocket() {
  const made = [];
  class S {
    constructor(url) { this.url = url; this.readyState = 0; made.push(this); }
    open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    msg(m) { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); }
  }
  return { S, made };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function syncWith(S, extra = {}) {
  const doc = core.createDoc('empty');
  const fetchImpl = async (url) => {
    const u = new URL(url, 'http://t');
    const body = /\/api\/projects\/p1$/.test(u.pathname)
      ? { id: 'p1', name: 'Т', kind: 'design', head_seq: 0, snapshot: { seq: 0, doc, engine: core.ENGINE_VERSION }, tail: [] }
      : { head_seq: 0, txs: [] };
    return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
  };
  const seen = [];
  const sync = createSync({
    core, baseUrl: 'http://t', projectId: 'p1', clientId: 'c_test', storage: memoryStorage(), WebSocketImpl: S, fetchImpl,
    onStatus: (s) => seen.push(s), idleHealthMs: 0, ...extra,
  });
  return { sync, seen };
}

test('r39 (N6а): до первого hello — «подключаюсь к проекту…», не «не в сети»; после — обычные слова', async () => {
  const { S, made } = manualSocket();
  const { sync, seen } = syncWith(S);
  await sync.open();
  for (let i = 0; i < 50 && !made.length; i++) await tick();
  assert.equal(made.length, 1, 'сокет открывается');
  assert.equal(sync.status.connecting, true);
  assert.equal(sync.status.label, 'подключаюсь к проекту…');
  made[0].open();
  assert.equal(sync.status.connecting, true, 'сокет открыт, hello ещё нет — всё ещё подключаемся');
  made[0].msg({ type: 'hello', project: 'p1', head_seq: 0, engine: core.ENGINE_VERSION });
  await tick();
  assert.equal(sync.status.online, true);
  assert.equal(sync.status.connecting, undefined);
  assert.ok(!seen.some((s) => /не в сети|недоступ/.test(s.label)), `ни одного «не в сети» до hello: ${seen.map((s) => s.label).join(' | ')}`);
  // связь пропала после hello — это уже «не в сети», а не «подключаюсь»
  made[0].close();
  assert.equal(sync.status.connecting, undefined);
  assert.match(sync.status.label, /^не в сети/);
  await sync.close();
});

test('r39 (N6а): первая попытка провалилась или затянулась — честное «не в сети», без вечного «подключаюсь»', async () => {
  {
    const { S, made } = manualSocket();
    const { sync } = syncWith(S, { reconnectMin: 5000 });
    await sync.open();
    for (let i = 0; i < 50 && !made.length; i++) await tick();
    made[0].close();
    assert.equal(sync.status.connecting, undefined, 'сокет закрылся без hello — попытка провалилась');
    assert.match(sync.status.label, /^не в сети/);
    await sync.close();
  }
  {
    const { S, made } = manualSocket();
    const { sync } = syncWith(S, { firstConnectMs: 40 });
    await sync.open();
    for (let i = 0; i < 50 && !made.length; i++) await tick();
    assert.equal(sync.status.connecting, true);
    for (let i = 0; i < 50 && sync.status.connecting; i++) await tick();
    assert.equal(sync.status.connecting, undefined, 'срок первого подключения вышел');
    await sync.close();
  }
});

test('r39 (N6а): оболочка до hello — одно нейтральное состояние', () => {
  const app = read('app.js');
  // нет `server` ещё (ждём /api/health) — ни приглашения, ни «Пустой страницы», ни «Агент не подключён»
  assert.match(app, /serverBooting = serverAnticipated\(\);/);
  assert.match(app, /function docTitle\(\)[\s\S]{0,600}if \(server \|\| serverBooting\) return bootProjectName\(\);/);
  assert.match(app, /function renderLayers\(\)[\s\S]{0,600}if \(serverBooting \|\| \(server && !\(server\.sync && server\.sync\.view\)\)\)/);
  assert.match(app, /function commandReady\(\)[\s\S]{0,200}\|\| serverBooting/);
  assert.match(app, /function renderEmptyState\(\)[\s\S]{0,400}projectConnecting\(\)\) \{ host\.hidden = true; return; \}/);
  // «агент недоступен» — только по ответу /agent/health
  assert.match(app, /function renderAgentStatus\(\)[\s\S]{0,500}if \(!serverAgent\.health && !state\.provider\) \{ host\.hidden = true; return; \}/);
  // статус: до hello — нейтральное busy, а не красное «сервер недоступен»
  assert.match(app, /\(!s\.online && s\.connecting\)\) \{ text = [^;]+; kind = 'busy'; \}/);
});

/* ------------------------------ N6г: пример ------------------------------ */

test('r39 (N6г): примеры открываются без миграции формата — нули шкал ссылками, библиотека на месте', () => {
  const dir = join(root, 'examples');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1);
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.equal(core.checkImportDoc(doc), null, `${f}: годен для импорта`);
    assert.deepEqual(core.ensureScaleRefsOps(doc), [], `${f}: чисел на месте ссылок шкал нет`);
    assert.deepEqual(core.ensureLibraryOps(doc), [], `${f}: библиотека есть`);
    assert.equal(core.ensureScaleRefs(doc), doc, `${f}: миграция шкал — тот же документ`);
  }
  // сборщик сам проверяет, что переводить нечего
  assert.match(read('examples/pechenka-kliker.build.mjs'), /ensureScaleRefsOps\(doc\)\.length\) throw/);
});

/* ------------------------------ N6д: слова и мелочи ------------------------------ */

test('r39 (N6д): слова команд — без «в порядке» и «Выстроил … детей»', () => {
  const doc = core.createDoc();
  const ab = core.artboards(doc)[0];
  const kids = ab.children;
  assert.match(SHELL.reorderOps(doc, [kids[1]], 'up').words, /^Поднял «.+» выше в списке слоёв$/);
  assert.match(SHELL.reorderOps(doc, [kids[0]], 'down').words, /^Опустил «.+» ниже в списке слоёв$/);
  assert.match(SHELL.reorderOps(doc, [kids[1], kids[2]], 'first').words, /^Поставил 2 слоя первыми в списке слоёв$/);
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && !core.isArtboard(doc, n.id) && core.normalizeLayout(n.layout).mode === 'column');
  assert.match(SHELL.directionOps(doc, [frame.id], 'row').words, /^Дети «.+» теперь строкой$/);
});

test('r39 (N6д): оболочка — отмена возвращает выделение, устаревшая «Вернуть» гаснет, тост раскладки снимается, итог не теряется', () => {
  const app = read('app.js');
  assert.match(app, /selBefore: liveSelection\(\)/);
  assert.match(app, /function restoreStepSelection\(tx, back\)/);
  assert.match(app, /if \(!stepHistory\(true\)\) return false;\s*restoreStepSelection\(tx, true\);/);
  assert.match(app, /function dropStaleStepCard\(\) \{ if \(msgTransient && !msgUndoTx\) hideMsg\(\); \}/);
  assert.match(app, /else if \(!service && !extra\.system\) dropStaleStepCard\(\);/);
  assert.match(app, /function dropResolvedIssueToast\(\)/);
  assert.match(app, /runUtterance\(next\.text, \{ variants: next\.variants, keepResult: true \}\)/);
  assert.match(app, /if \(!\(keepResult && msgUndoTx\)\) hideMsg\(\);/);
  // даты в «Проектах» — у всех «менялся … назад»
  assert.match(app, /const when = whenWords\(p\.updated_at \|\| p\.created_at\);/);
  // сеть пропала — знак агента не врёт «агент: сервер»
  assert.match(app, /addEventListener\('offline', \(\) => \{[\s\S]{0,200}markAgentDown\(\)/);
});
