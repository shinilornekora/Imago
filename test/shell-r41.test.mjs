/**
 * Круг 41 (SHELL): отступ свободной рамки в «обернуть»/«разгруппировать» (код D4), предел
 * раскрытия словами (UX Д5) и при импорте (UX Д6), спасение проекта после перезагрузки
 * (арх. Н2), подпись «обернуть» после слияния, «нет сети» вместо «сервер не отвечает»,
 * скорость «/выделить …» на 20 тыс. слоёв, перестановка без недостижимого пути.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';
import { DROP_WORDS } from '../src/sync.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const sz = (w, h) => ({ w: { mode: 'fixed', value: w }, h: { mode: 'fixed', value: h } });
const apply = (d, ops) => {
  const r = core.applyOps(d, ops);
  assert.ok(!r.error, r.error && r.error.message);
  return r.doc;
};
const box = (geo, id) => {
  const r = geo.rects[id];
  return [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100) / 100);
};

/* ------------------------------ D4: отступ свободной рамки ------------------------------ */

for (const pad of [10, { t: 12, r: 4, b: 6, l: 20 }]) {
  test(`r41 (D4): обернуть и разгруппировать в свободной рамке с отступом ${JSON.stringify(pad)} — слои не сдвигаются`, () => {
    let doc = core.createDoc();
    const ab = core.artboards(doc)[0];
    const padding = typeof pad === 'number' ? { t: pad, r: pad, b: pad, l: pad } : pad;
    doc = apply(doc, [
      core.ops.create({ type: 'frame', id: 'f_free', name: 'Свободная', parent: ab.id, children: [], layout: { mode: 'none', padding }, size: sz(300, 200) }),
      core.ops.create({ type: 'rect', id: 'r_a', name: 'А', parent: 'f_free', pos: { x: 20, y: 30 }, size: sz(40, 40) }),
      core.ops.create({ type: 'rect', id: 'r_b', name: 'Б', parent: 'f_free', pos: { x: 100, y: 80 }, size: sz(30, 20) }),
    ]);
    const L = core.resolveLayout(doc, doc.nodes.f_free.layout);
    assert.ok(L.padding.l > 0 && L.padding.t > 0, 'отступ действительно есть');
    const g0 = core.solve(doc);
    const before = { a: box(g0, 'r_a'), b: box(g0, 'r_b') };
    const w = SHELL.wrapOps(doc, ['r_a', 'r_b'], { rects: g0.rects });
    assert.ok(w.ops, w.error);
    const d1 = apply(doc, w.ops);
    const g1 = core.solve(d1);
    assert.deepEqual(box(g1, 'r_a'), before.a, 'А на месте после «обернуть»');
    assert.deepEqual(box(g1, 'r_b'), before.b, 'Б на месте после «обернуть»');
    // рамка — ровно по общим границам
    const fr = box(g1, w.id);
    assert.deepEqual(fr.slice(0, 2), [Math.min(before.a[0], before.b[0]), Math.min(before.a[1], before.b[1])]);
    const u = SHELL.ungroupOps(d1, [w.id], { rects: g1.rects });
    assert.ok(u.ops, u.error);
    const d2 = apply(d1, u.ops);
    const g2 = core.solve(d2);
    assert.deepEqual(box(g2, 'r_a'), before.a, 'А на месте после «разгруппировать»');
    assert.deepEqual(box(g2, 'r_b'), before.b, 'Б на месте после «разгруппировать»');
    assert.deepEqual(d2.nodes.r_a.pos, { x: 20, y: 30 }, 'pos как был');
  });
}

/* ------------------------------ Д5: предел раскрытия словами ------------------------------ */

test('r41 (UX Д5): отброшенное по пределу раскрытия — словами реплики, с советом; «она» не про «Добавление»', () => {
  const op = core.ops.create({ type: 'instance', id: 'i_x', name: 'Тяжёлый 48 копия', parent: 'f_x', of: 'm_x' });
  const w = SHELL.droppedWords({ dropped: [{ index: 0, op, reason: 'invalid', limit: 'expand_nodes' }] });
  assert.equal(w.title, `Добавление «Тяжёлый 48 копия» не применилось — ${DROP_WORDS.expand_nodes}`);
  assert.match(w.note, /Удалите лишние экземпляры или разберите тяжёлый компонент/);
  assert.match(w.note, new RegExp(SHELL.countWords(core.MAX_EXPANDED_NODES)));
  const many = SHELL.droppedWords({ dropped: [{ index: 0, op, reason: 'invalid', limit: 'expand_nodes' }, { index: 1, op, reason: 'invalid', limit: 'expand_nodes' }], agent: true });
  assert.match(many.title, /^2 правки агента не применились — слишком много вложенных экземпляров$/);
  // запасная причина — без местоимения
  const mv = SHELL.droppedWords({ dropped: [{ index: 0, op: { op: 'move', id: 'x' }, reason: 'invalid' }] });
  assert.equal(mv.title, `Перенос не применился — ${DROP_WORDS.invalid}`);
  for (const reason of ['merge_budget', 'ops_per_tx', 'tx_bytes', 'doc_nodes', 'doc_bytes', 'invalid', 'expand_nodes', 'stale']) {
    const t = SHELL.droppedWords({ dropped: [{ index: 0, op: { op: 'create', node: { id: 'n_1', name: 'Слой' } }, reason: reason === 'stale' ? 'stale' : 'invalid', limit: reason === 'stale' || reason === 'invalid' ? undefined : reason }] }).title;
    assert.doesNotMatch(t, /— (она|её|в ней)\b/, `${reason}: ${t}`);
    if (DROP_WORDS[reason] && reason !== 'stale') assert.ok(t.endsWith(DROP_WORDS[reason]), `${reason}: слова — из DROP_WORDS`);
  }
  assert.equal(SHELL.countWords(52008), '52 008');
});

/* ------------------------------ Д6: импорт сверх предела ------------------------------ */

test('r41 (UX Д6): импорт в оболочке проверяет предел раскрытия до записи и отказывает словами', () => {
  const w = SHELL.expandLimitWords({ cost: 52008, max: 50000 });
  assert.equal(w.title, 'Файл не загружен: слишком много вложенных экземпляров');
  assert.match(w.note, /52 008 слоёв — больше предела 50 000/);
  assert.match(w.note, /Документ остался прежним/);
  const app = read('app.js');
  const imp = app.slice(app.indexOf('const taken = adoptDoc(raw);'), app.indexOf('const taken = adoptDoc(raw);') + 900);
  assert.match(imp, /CORE\.expandProblem\(taken\.doc\)/);
  assert.match(imp, /SHELL\.expandLimitWords\(over\)[\s\S]{0,300}return;/);
  // проверка — раньше commitDoc: документ не меняется
  assert.ok(imp.indexOf('expandProblem') < (app.indexOf('commitDoc(taken.doc') - app.indexOf('const taken = adoptDoc(raw);')));
});

/* ------------------------------ Н2: спасение после перезагрузки ------------------------------ */

test('r41 (арх. Н2): «Сохранить как новый» — тот же create_id только с тем же телом; 409 — новый ключ; слова без текста сервера', () => {
  const e409 = Object.assign(new Error('create_id уже занят проектом, созданным другим телом запроса — для нового проекта нужен новый create_id'), { status: 409, code: 'conflict', detail: { cause: 'create_id' } });
  const w = SHELL.rescueFailWords(e409);
  assert.doesNotMatch(w, /create_id|тел[оа] запроса/);
  assert.match(SHELL.rescueFailWords(new TypeError('Failed to fetch')), /нет связи/);
  assert.match(SHELL.rescueFailWords({ status: 503, detail: { cause: 'storage' } }), /база данных/);
  assert.match(SHELL.rescueFailWords({ status: 400, detail: { limit: 'expand_nodes' } }), /вложенных экземпляров/);
  assert.equal(SHELL.rescueFailWords({ status: 500, message: 'TypeError: x is undefined' }), 'сервер не ответил как надо');
  const app = read('app.js');
  // отпечаток тела рядом с create_id в sessionStorage
  assert.match(app, /create_id: job\.createId \|\| '', body_sig: job\.bodySig \|\| ''/);
  // после перезагрузки: другое тело — новый ключ
  assert.match(app, /createId: same \? createId : newCreateId\(\)/);
  // 409 — новый ключ один раз, а не тот же повтор
  assert.match(app, /if \(!\(e && e\.status === 409\)\) throw e;\s*job\.createId = newCreateId\(\);/);
  // в тостах спасения — слова оболочки
  const save = app.slice(app.indexOf('async function saveAsNewProject'), app.indexOf('const RESCUE_KEY'));
  assert.doesNotMatch(save, /afterColon\(humanError\(e\)\)/);
  assert.match(save, /SHELL\.rescueFailWords\(e\)/);
});

/* ------------------------------ подпись «обернуть» после слияния ------------------------------ */

test('r41 (UX): «Обернуть», где соавтор успел удалить часть слоёв, — подпись по тому, что легло', () => {
  const doc = core.ensureLibrary(core.createDoc());
  const frame = Object.values(doc.nodes).find((n) => n.type === 'frame' && (n.children || []).length >= 3 && !core.isArtboard(doc, n.id) && !n.component);
  const sel = [frame.children[1], frame.children[2]];
  const w = SHELL.wrapOps(doc, sel, { rects: core.solve(doc).rects });
  assert.match(w.words, /^Обернул 2 слоя в рамку «Группа»$/);
  const theirs = [core.ops.remove(sel[0])];
  const head = apply(doc, theirs);
  const tomb = new Map();
  core.collectTombstones(doc, theirs, tomb);
  const m = core.rebase(head, w.ops, { tombstones: tomb });
  const after = apply(head, m.ops);
  const s = SHELL.wrapSettledWords(after, m.ops, w.id, sel);
  assert.ok(s);
  assert.equal(s.lost, 1);
  assert.equal(s.words, SHELL.wrapWords(after, [sel[1]], 'Группа'));
  assert.match(s.words, /^Обернул «.+» в рамку «Группа»$/);
  assert.equal(SHELL.wrapSettledWords(apply(doc, w.ops), w.ops, w.id, sel), null, 'легло как просили — подпись прежняя');
  const app = read('app.js');
  assert.match(app, /wrapOf: r\.id, wrapKids:/);
  assert.match(app, /function settleWrapWords[\s\S]{0,500}SHELL\.wrapSettledWords\(/);
});

/* ------------------------------ офлайн ------------------------------ */

test('r41 (UX): нет сети у компьютера — «Нет сети», а не «Сервер агента не отвечает»; возврат — «Сеть вернулась»', () => {
  const up = { ok: true, document: 'up', llm: 'up' };
  const off = { ok: false, reason: 'offline' };
  const down = SHELL.agentHealthNotice(up, off);
  assert.match(down.text, /^Нет сети — агент недоступен\./);
  assert.match(down.text, /ждут во вкладке/);
  assert.equal(SHELL.agentHealthNotice(off, up).text, 'Сеть вернулась — агент снова на связи.');
  assert.match(SHELL.agentHealthNotice(up, { ok: false, reason: 'network' }).text, /^Сервер агента не отвечает/, 'сеть есть — прежние слова');
  assert.match(SHELL.agentModeTitle('off', off), /^Нет сети/);
  assert.match(SHELL.agentHealthNotice(up, { ok: false, reason: 'network' }, { editsWait: true }).text, /Правки руками ждут во вкладке/);
  const app = read('app.js');
  assert.match(app, /reason: browserOffline\(\) \? 'offline' : 'network'/);
});

/* ------------------------------ «/выделить …» на 20 тыс. слоёв ------------------------------ */

test('r41 (код): «/выделить заг» на 20 тыс. слоёв — быстрее 30 мс (основы имён — заранее, в простое)', () => {
  let doc = core.createDoc();
  const b = core.artboards(doc)[0].id;
  const ops = [];
  for (let i = 0; i < 19800; i++) ops.push(core.ops.create({ type: 'rect', id: `r${i}`, name: `Заголовок ${i}`, parent: b, size: sz(5, 5) }));
  doc = apply(doc, ops);
  // как оболочка в простое: частями
  let r = { next: 0, ids: null };
  do r = SHELL.warmNameStems(doc, { from: r.next, count: 1500, ids: r.ids }); while (r.next < r.ids.length);
  const ctx = { doc, activeArtboardId: b };
  for (const q of ['/выделить заг', 'выдели заголовок 5']) {
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      const hit = SHELL.shellIntent(q, ctx);
      best = Math.min(best, performance.now() - t);
      assert.equal(hit.kind, 'select');
    }
    assert.ok(best < 30, `«${q}»: ${best.toFixed(1)} мс`);
  }
  // внутри активной доски — выше: слой другой доски с тем же именем идёт после
  const other = core.artboards(doc)[1].id;
  const d2 = apply(doc, [core.ops.create({ type: 'rect', id: 'r_other', name: 'Печенька', parent: other, size: sz(5, 5) }),
    core.ops.create({ type: 'rect', id: 'r_here', name: 'Печенька', parent: b, size: sz(5, 5) })]);
  assert.equal(SHELL.nodesByName(d2, 'печенька', { activeId: b })[0].id, 'r_here');
  assert.equal(SHELL.nodesByName(d2, 'печенька', { activeId: other })[0].id, 'r_other');
  const app = read('app.js');
  assert.match(app, /function renderAll\(opts = \{\}\) \{\s*markHeavy\(\);\s*warmNamesSoon\(\);/);
});

/* ------------------------------ перестановка ------------------------------ */

test('r41 (код): перестановка — два пути ходов, недостижимого третьего нет; случайные выделения сходятся', () => {
  const src = read('src/shell.js');
  assert.doesNotMatch(src, /tryOrder\(target\.slice\(\)\)/);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let doc = core.createDoc();
  const ab = core.artboards(doc)[0];
  const kids = [];
  for (let i = 0; i < 9; i++) kids.push(core.ops.create({ type: 'rect', id: `r_${i}`, name: `К${i}`, parent: ab.id, size: sz(5, 5) }));
  doc = apply(doc, kids);
  const order = (d) => d.nodes[ab.id].children.slice();
  for (let n = 0; n < 3000; n++) {
    const all = order(doc);
    const sel = all.filter((k) => k.startsWith('r_') && rnd() < 0.35);
    if (!sel.length) continue;
    const to = ['up', 'down', 'first', 'last'][Math.floor(rnd() * 4)];
    const r = SHELL.reorderOps(doc, sel, to);
    if (r.error) continue;
    const next = apply(doc, r.ops);
    const got = order(next);
    const cur = all;
    const isSel = new Set(sel);
    let want = cur.slice();
    if (to === 'first') want = [...cur.filter((c) => isSel.has(c)), ...cur.filter((c) => !isSel.has(c))];
    else if (to === 'last') want = [...cur.filter((c) => !isSel.has(c)), ...cur.filter((c) => isSel.has(c))];
    else if (to === 'up') { for (let i = 1; i < want.length; i++) if (isSel.has(want[i]) && !isSel.has(want[i - 1])) [want[i - 1], want[i]] = [want[i], want[i - 1]]; }
    else for (let i = want.length - 2; i >= 0; i--) if (isSel.has(want[i]) && !isSel.has(want[i + 1])) [want[i + 1], want[i]] = [want[i], want[i + 1]];
    assert.deepEqual(got, want, `${to} ${sel.join(',')}`);
    doc = next;
  }
});

/* ------------------------------ мелочи оболочки ------------------------------ */

test('r41 (UX): мелочи — справка дока гаснет к следующей команде, «нулевой размер» словами, одно время в «Проектах», версия на 503', () => {
  const app = read('app.js');
  assert.match(app, /function applyShellIntent\(intent, said\) \{\s*if \(!intent\) return false;\s*dropStaleInfoCard\(\);/);
  assert.match(app, /function dropStaleInfoCard\(\) \{[\s\S]{0,200}msgUndoTx \|\| msgTransient \|\| h\.dataset\.role/);
  assert.match(app, /нулевой размер/);
  assert.match(app, /пустой слой — ни ширины, ни высоты/);
  assert.doesNotMatch(app, /exactWhen\(/);
  assert.match(app, /const whenLine = when \? `менялся \$\{when\}\$\{exact \? `, \$\{exact\}` : ''\}`/);
  // версии разошлись: команда агенту не уходит, знак агента не зелёный, без «Обновить страницу» при старом сервере
  assert.match(app, /if \(server && engineHalted\(\)\) \{ engineCommandMsg\(utterance\); return; \}/);
  assert.match(app, /actions: w\.newer \? \[\{ label: 'Обновить страницу'/);
  assert.match(app, /if \(engineHalted\(\)\) \{[\s\S]{0,300}dot\.dataset\.state = 'error'/);
  // догон без промежуточных кадров
  assert.match(app, /if \(info\.more === true && !\(info\.tx && info\.tx\.author_kind === 'agent'\)\) \{[\s\S]{0,80}holdCatchup\(\);/);
});

/* ------------------------------ 426 engine от Orchestrator ------------------------------ */

test('r41 (ORCH 426): команда и вариант несут версию движка; 426 engine — слова про версию, без повтора', async () => {
  const AG = await import('../src/agent.js');
  const sent = [];
  let cause = 'client_old';
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const body = { error: true, code: 'engine', retryable: false, message: 'версия движка клиента 1, сервер агента работает с 2', detail: { engine: core.ENGINE_VERSION, found: core.ENGINE_VERSION - 1, cause } };
    return { ok: false, status: 426, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
  };
  let err = null;
  try { await AG.runServerCommand({ fetch: fetchImpl, baseUrl: '', project: 'p1', text: 'сделай заголовок крупнее' }); } catch (e) { err = e; }
  assert.ok(err, '426 — исключение');
  assert.equal(sent.length, 1, 'без автоматического повтора');
  assert.equal(sent[0].body.engine, core.ENGINE_VERSION, 'engine в теле команды');
  assert.equal(sent[0].headers['x-engine'], String(core.ENGINE_VERSION), 'и в заголовке X-Engine');
  assert.equal(AG.engineCause(err), 'client_old');
  const wc = SHELL.agentErrorWords(err);
  assert.equal(wc.title, 'Вышла новая версия редактора — обновите страницу');
  assert.doesNotMatch(wc.note, /повтор/i);
  cause = 'server_old';
  let err2 = null;
  try { await AG.apply('cmd_x', 'a', { fetch: fetchImpl, baseUrl: '' }); } catch (e) { err2 = e; }
  assert.equal(sent[1].body.engine, core.ENGINE_VERSION, 'engine в теле apply');
  assert.equal(sent[1].headers['x-engine'], String(core.ENGINE_VERSION));
  assert.equal(AG.engineCause(err2), 'server_old');
  const ws = SHELL.agentErrorWords(err2);
  assert.match(ws.title, /^Сервер агента ещё не обновился/);
  assert.equal(ws.waitMs, 0);
  // прежний смысл engine (сервер агента и сервис документов) — прежние слова
  assert.equal(AG.engineCause({ code: 'engine', detail: { engine: 2 } }), '');
  assert.match(SHELL.agentErrorWords({ code: 'engine' }).title, /Сервер агента и сервер документов/);
  // оболочка: без «Повторить», вкладка старее — «Обновить страницу»
  const app = read('app.js');
  const fn = app.slice(app.indexOf('const cause = AGENT.engineCause(e);'), app.indexOf('const cause = AGENT.engineCause(e);') + 700);
  assert.match(fn, /restoreCommand\(utterance\)/);
  assert.match(fn, /cause === 'client_old' \? \[\{ label: 'Обновить страницу'/);
  assert.doesNotMatch(fn, /Повторить/);
});
