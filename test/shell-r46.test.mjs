/**
 * Круг 46 (SHELL): проекты без сервера (соло-режим: артефакт, dist/local). Хранилище проектов
 * (тела в IndexedDB, запасной путь localStorage, последний — память вкладки), перенос прежнего
 * документа первым проектом, переключение без потери правок, удаление и «Вернуть», две вкладки,
 * команды таблицы группы «Файл» и их проводка в app.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as SHELL from '../src/shell.js';
import * as core from '../src/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'app.js'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');

/* --------------------------------- поддельное окружение --------------------------------- */

/** localStorage в памяти; quota — предел суммы длин значений (как «≈5 МБ на сайт»). */
function fakeLocalStorage({ quota = Infinity, broken = false } = {}) {
  const m = new Map();
  const used = () => [...m.values()].reduce((s, v) => s + v.length, 0);
  return {
    getItem(k) { if (broken) throw new Error('SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) {
      if (broken) throw new Error('SecurityError');
      const s = String(v);
      if (used() - (m.get(k) || '').length + s.length > quota) throw new Error('QuotaExceededError');
      m.set(k, s);
    },
    removeItem(k) { if (broken) throw new Error('SecurityError'); m.delete(k); },
    get size() { return m.size; },
    keys() { return [...m.keys()]; },
  };
}

/** IndexedDB ровно настолько, насколько её зовёт idbBodies: open/upgrade, одна таблица, get/put/delete. */
function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) {
          const stores = new Map();
          db = {
            stores,
            objectStoreNames: { contains: (n) => stores.has(n) },
            createObjectStore: (n) => { stores.set(n, new Map()); },
            transaction(n) {
              const data = stores.get(n);
              const tx = { oncomplete: null, onerror: null, onabort: null };
              const reqOf = (fn) => {
                const r = { result: undefined, onsuccess: null };
                later(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); later(() => tx.oncomplete && tx.oncomplete()); });
                return r;
              };
              tx.objectStore = () => ({
                get: (k) => reqOf(() => (data.has(k) ? data.get(k) : undefined)),
                put: (v, k) => reqOf(() => { data.set(k, v); return k; }),
                delete: (k) => reqOf(() => { data.delete(k); }),
              });
              return tx;
            },
          };
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    dbs,
  };
}

/** BroadcastChannel: общая шина по имени, своё сообщение себе не приходит. */
function fakeBus() {
  const subs = new Map();
  return class Chan {
    constructor(name) { this.name = name; this.onmessage = null; if (!subs.has(name)) subs.set(name, new Set()); subs.get(name).add(this); }
    postMessage(data) { for (const c of subs.get(this.name)) if (c !== this) setTimeout(() => c.onmessage && c.onmessage({ data: JSON.parse(JSON.stringify(data)) }), 0); }
    close() { subs.get(this.name).delete(this); }
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const clock = (start = Date.parse('2026-10-22T10:00:00Z')) => { let t = start; return () => (t += 1000); };

/** Документ с именем и N пустыми досками (доска — копия доски демо-документа без детей). */
const demo = core.createDoc();
const demoBoard = demo.nodes[demo.nodes[demo.root].children.find((id) => demo.nodes[id].type === 'frame')];
function docNamed(name, boards = 1) {
  const d = core.createDoc('empty');
  const nodes = { ...d.nodes };
  const root = { ...nodes[d.root], children: [...(nodes[d.root].children || [])] };
  for (let i = 0; i < boards; i++) {
    const id = `ab_${i + 1}`;
    nodes[id] = { ...demoBoard, id, name: `Доска ${i + 1}`, parent: d.root, children: [] };
    root.children.push(id);
  }
  nodes[d.root] = root;
  return { ...d, nodes, meta: { ...(d.meta || {}), name } };
}
const payloadOf = (doc, extra = {}) => ({ doc, chat: [], pairs: [], history: [], cursor: 0, savedAt: 1, ...extra });

/* ----------------------------------------- слова ----------------------------------------- */

test('r46: имена новых проектов и копий, строка списка, поиск, проект по имени', () => {
  assert.equal(SHELL.freshSoloName([]), 'Новый проект');
  assert.equal(SHELL.freshSoloName([{ name: 'Новый проект' }]), 'Новый проект 2');
  assert.equal(SHELL.freshSoloName([{ name: 'Новый проект' }, { name: 'Новый проект 2' }]), 'Новый проект 3');
  assert.equal(SHELL.copySoloName([{ name: 'Лендинг' }], 'Лендинг'), 'Лендинг копия');
  assert.equal(SHELL.copySoloName([{ name: 'Лендинг' }, { name: 'Лендинг копия' }], 'Лендинг'), 'Лендинг копия 2');
  assert.equal(SHELL.soloMetaLine({ boards: 2, nodes: 48 }, '5 минут назад'), '2 доски · 48 слоёв · менялся 5 минут назад');
  assert.equal(SHELL.soloMetaLine({ boards: 0, nodes: 0 }), 'без досок · 0 слоёв');
  const list = [{ id: 'a', name: 'Лендинг весна' }, { id: 'b', name: 'Лендинг осень' }, { id: 'c', name: 'Ёлка' }];
  assert.deepEqual(SHELL.filterSoloProjects(list, 'лендинг').map((p) => p.id), ['a', 'b']);
  assert.deepEqual(SHELL.filterSoloProjects(list, 'елка').map((p) => p.id), ['c'], 'ё и е не различаются');
  assert.equal(SHELL.filterSoloProjects(list, '').length, 3);
  assert.equal(SHELL.findSoloProject(list, 'Лендинг осень').one.id, 'b');
  const two = SHELL.findSoloProject(list, 'лендинг');
  assert.equal(two.one, null);
  assert.equal(two.many.length, 2, 'похожих несколько — шторка с отбором');
  assert.deepEqual(SHELL.findSoloProject(list, 'Сайт'), { one: null, many: [] });
});

/* -------------------------------------- хранилище -------------------------------------- */

test('r46: хранилище на IndexedDB — создать, прочитать, записать (имя и сводка в индексе), переименовать', async () => {
  const ls = fakeLocalStorage();
  const store = await SHELL.openSoloStore({ indexedDB: fakeIndexedDB(), localStorage: ls, now: clock() });
  assert.equal(store.mode, 'idb');
  assert.equal(store.warn, '', 'IndexedDB есть — предупреждать не о чем');
  const a = await store.create({ name: 'Лендинг', payload: payloadOf(docNamed('что угодно', 1)) });
  assert.equal(a.name, 'Лендинг');
  assert.equal(a.boards, 1);
  const body = await store.read(a.id);
  assert.equal(body.doc.meta.name, 'Лендинг', 'имя проекта — и в теле документа');
  assert.ok(!ls.keys().some((k) => k.startsWith(SHELL.SOLO_BODY_PREFIX)), 'тело — в IndexedDB, не в localStorage');
  assert.ok(ls.getItem(SHELL.SOLO_INDEX_KEY), 'индекс — в localStorage');

  const w = await store.write(a.id, payloadOf(docNamed('Лендинг 2.0', 2)), { base: a.updated_at });
  assert.ok(w.ok);
  assert.equal(w.entry.name, 'Лендинг 2.0', 'имя из шапки (meta.name) уходит в список');
  assert.equal(w.entry.boards, 2);
  assert.ok(w.entry.updated_at > a.updated_at);

  const r = await store.rename(a.id, '  Сайт  ');
  assert.equal(r.name, 'Сайт');
  assert.equal((await store.read(a.id)).doc.meta.name, 'Сайт');
  const b = await store.create({ name: 'Второй', payload: payloadOf(docNamed('x', 0)) });
  assert.deepEqual(store.list().map((p) => p.id), [b.id, a.id], 'свежие сверху');
});

test('r46: переключение не теряет правок: у каждого проекта своё тело, вид — в индексе', async () => {
  const store = await SHELL.openSoloStore({ indexedDB: fakeIndexedDB(), localStorage: fakeLocalStorage(), now: clock() });
  const a = await store.create({ name: 'A', payload: payloadOf(docNamed('A', 1)) });
  const b = await store.create({ name: 'B', payload: payloadOf(docNamed('B', 0)) });
  // правка A с историей и разговором, уход к B, правка B, возврат к A
  await store.write(a.id, payloadOf(docNamed('A', 3), { chat: [{ role: 'you', text: 'три доски' }], history: [{ id: 't1' }], cursor: 1 }), { base: a.updated_at });
  store.setView(a.id, { zoom: 0.5, pan: { x: 10, y: 20 } }, 'ab_2');
  store.setCurrent(b.id);
  await store.write(b.id, payloadOf(docNamed('B', 1)), { base: b.updated_at });
  store.setCurrent(a.id);
  const back = await store.read(a.id);
  assert.equal(SHELL.soloDocStats(back.doc).boards, 3);
  assert.equal(back.chat[0].text, 'три доски', 'разговор — у своего проекта');
  assert.equal(back.cursor, 1, 'история — у своего проекта');
  assert.equal(SHELL.soloDocStats((await store.read(b.id)).doc).boards, 1);
  assert.deepEqual(store.entry(a.id).view, { zoom: 0.5, pan: { x: 10, y: 20 } });
  assert.equal(store.entry(a.id).board, 'ab_2', 'активная доска — в индексе');
  assert.equal(store.current(), a.id);
});

test('r46: удалить и «Вернуть»; копия — отдельный проект без истории', async () => {
  const store = await SHELL.openSoloStore({ indexedDB: fakeIndexedDB(), localStorage: fakeLocalStorage(), now: clock() });
  const a = await store.create({ name: 'Лендинг', payload: payloadOf(docNamed('Лендинг', 2), { history: [{ id: 't' }], cursor: 1 }) });
  const c = await store.duplicate(a.id);
  assert.equal(c.name, 'Лендинг копия');
  assert.notEqual(c.id, a.id);
  const cb = await store.read(c.id);
  assert.equal(cb.history.length, 0);
  assert.equal(SHELL.soloDocStats(cb.doc).boards, 2);
  store.setCurrent(a.id);
  const tomb = await store.remove(a.id);
  assert.equal(tomb.entry.name, 'Лендинг');
  assert.ok(tomb.payload && tomb.payload.doc, 'тело держим до закрытия тоста');
  assert.equal(store.entry(a.id), null);
  assert.equal(await store.read(a.id), null);
  assert.equal(store.current(), null, 'удалённый не остаётся текущим');
  await store.restore(tomb);
  assert.equal(store.entry(a.id).name, 'Лендинг');
  assert.equal(SHELL.soloDocStats((await store.read(a.id)).doc).boards, 2, '«Вернуть» — с телом');
  await store.restore(tomb);
  assert.equal(store.list().filter((p) => p.id === a.id).length, 1, 'повторный «Вернуть» не дублирует');
});

test('r46: запасные пути — localStorage с честным предупреждением о размере, закрытое хранилище — память', async () => {
  const ls = fakeLocalStorage();
  const local = await SHELL.openSoloStore({ indexedDB: null, localStorage: ls, now: clock() });
  assert.equal(local.mode, 'local');
  assert.equal(local.warn, 'local');
  const p = await local.create({ name: 'Большой', payload: payloadOf(docNamed('x', 0)) });
  const big = await local.write(p.id, payloadOf(docNamed('x', 0), { pad: 'x'.repeat(SHELL.SOLO_LOCAL_WARN_BYTES + 10) }), { base: p.updated_at });
  assert.ok(big.ok && big.big, 'большое тело в localStorage — предупреждение');
  assert.ok(ls.getItem(SHELL.SOLO_BODY_PREFIX + p.id));

  // IndexedDB бросает при открытии — тоже запасной путь
  const throwing = { open() { throw new Error('denied'); } };
  const viaLs = await SHELL.openSoloStore({ indexedDB: throwing, localStorage: fakeLocalStorage(), now: clock() });
  assert.equal(viaLs.mode, 'local');

  // приватный режим: localStorage бросает — всё в памяти, «проекты не сохраняются»
  const mem = await SHELL.openSoloStore({ indexedDB: fakeIndexedDB(), localStorage: fakeLocalStorage({ broken: true }), now: clock() });
  assert.equal(mem.mode, 'memory');
  assert.equal(mem.warn, 'memory');
  const m = await mem.create({ name: 'В памяти', payload: payloadOf(docNamed('x', 1)) });
  assert.equal((await mem.read(m.id)).doc.meta.name, 'В памяти', 'работать можно, пока открыта вкладка');
  assert.equal(mem.saveOnExit(m.id, payloadOf(docNamed('x', 1))), false);

  // место кончилось — запись бросает, а не делает вид, что сохранила
  const tight = fakeLocalStorage({ quota: 4000 });
  const t = await SHELL.openSoloStore({ localStorage: tight, now: clock() });
  const tp = await t.create({ name: 'T', payload: payloadOf(docNamed('x', 0)) });
  await assert.rejects(() => t.write(tp.id, payloadOf(docNamed('x', 0), { pad: 'x'.repeat(5000) }), { base: tp.updated_at }));
});

test('r46: запись при уходе — синхронно в localStorage, при следующем открытии переносится в тело (и только новее)', async () => {
  const ls = fakeLocalStorage();
  const idb = fakeIndexedDB();
  const now = clock();
  const s1 = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, now });
  const a = await s1.create({ name: 'A', payload: payloadOf(docNamed('A', 1)) });
  assert.equal(s1.saveOnExit(a.id, payloadOf(docNamed('A', 4))), true);
  const s2 = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, now });
  assert.equal(await s2.adoptExit(), a.id);
  assert.equal(SHELL.soloDocStats((await s2.read(a.id)).doc).boards, 4, 'последняя правка перед закрытием вкладки цела');
  assert.equal(ls.getItem(SHELL.SOLO_EXIT_KEY), null, 'запись ухода снята');
  // запись ухода старее тела (тело записали позже) — не откатывает
  s2.saveOnExit(a.id, payloadOf(docNamed('A', 0)));
  const rec = JSON.parse(ls.getItem(SHELL.SOLO_EXIT_KEY));
  rec.at = '2000-01-01T00:00:00.000Z';
  ls.setItem(SHELL.SOLO_EXIT_KEY, JSON.stringify(rec));
  const s3 = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, now });
  assert.equal(await s3.adoptExit(), null);
  assert.equal(SHELL.soloDocStats((await s3.read(a.id)).doc).boards, 4);
});

test('r46: две вкладки — список обновляется по каналу; запись поверх более новой чужой — конфликт, не молча', async () => {
  const ls = fakeLocalStorage();
  const idb = fakeIndexedDB();
  const Bus = fakeBus();
  const now = clock();
  const A = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, BroadcastChannel: Bus, now });
  const B = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, BroadcastChannel: Bus, now });
  assert.notEqual(A.tab, B.tab);
  const heardB = [];
  B.onRemote((m) => heardB.push(m));
  const p = await A.create({ name: 'Общий', payload: payloadOf(docNamed('Общий', 1)) });
  await tick(10);
  assert.ok(heardB.some((m) => m.type === 'list'), 'B узнал о новом проекте');
  assert.equal(B.list()[0].name, 'Общий');

  // обе открыли проект с одной и той же версией
  const baseA = p.updated_at;
  const baseB = p.updated_at;
  const wb = await B.write(p.id, payloadOf(docNamed('Общий', 2)), { base: baseB });
  assert.ok(wb.ok);
  await tick(10);
  const heardA = [];
  A.onRemote((m) => heardA.push(m));
  const wb2 = await B.write(p.id, payloadOf(docNamed('Общий', 3)), { base: wb.entry.updated_at });
  await tick(10);
  assert.ok(heardA.some((m) => m.type === 'saved' && m.id === p.id && m.updated_at === wb2.entry.updated_at), 'A узнал, что проект сохранён новее');
  // A пишет со своей старой версией — отказ без записи
  const wa = await A.write(p.id, payloadOf(docNamed('Общий', 9)), { base: baseA });
  assert.equal(wa.ok, false);
  assert.equal(wa.conflict, true);
  assert.equal(SHELL.soloDocStats((await A.read(p.id)).doc).boards, 3, 'чужая свежая версия не затёрта');
  // «Оставить мою» — запись с force
  const forced = await A.write(p.id, payloadOf(docNamed('Общий', 9)), { force: true });
  assert.ok(forced.ok);
  assert.equal(SHELL.soloDocStats((await B.read(p.id)).doc).boards, 9);
  // своя же предыдущая запись конфликтом не считается
  const again = await A.write(p.id, payloadOf(docNamed('Общий', 8)), { base: baseA });
  assert.ok(again.ok, 'последней писала эта же вкладка — не конфликт');
  A.close(); B.close();
});

test('r46: без канала — событие storage на индексе говорит о чужой записи', async () => {
  const ls = fakeLocalStorage();
  const idb = fakeIndexedDB();
  const now = clock();
  const A = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, now });
  const B = await SHELL.openSoloStore({ indexedDB: idb, localStorage: ls, now });
  const p = await A.create({ name: 'P', payload: payloadOf(docNamed('P', 1)) });
  A.list();   // A знает версию
  await B.write(p.id, payloadOf(docNamed('P', 2)), { base: p.updated_at });
  const heard = [];
  A.onRemote((m) => heard.push(m));
  A.storageEvent({ key: 'что-то другое' });
  assert.equal(heard.length, 0);
  A.storageEvent({ key: SHELL.SOLO_INDEX_KEY });
  assert.ok(heard.some((m) => m.type === 'saved' && m.id === p.id));
  assert.ok(heard.some((m) => m.type === 'list'));
});

/* --------------------------------------- команды --------------------------------------- */

test('r46: команды «Файл» — фразы, слэш-формы, имя аргументом, номер в таблице', () => {
  const cases = [
    ['покажи проекты', { kind: 'projects' }],
    ['/проекты', { kind: 'projects' }],
    ['/новый проект', { kind: 'project-new' }],
    ['/новый проект Лендинг', { kind: 'project-new', name: 'Лендинг' }],
    ['создай новый проект', { kind: 'project-new' }],
    ['новый документ', { kind: 'project-new' }],
    ['новый файл', { kind: 'project-new' }],
    ['/открыть Лендинг', { kind: 'project-open', name: 'Лендинг' }],
    ['открой проект Лендинг', { kind: 'project-open', name: 'Лендинг' }],
    ['/переименовать проект Сайт', { kind: 'project-rename', name: 'Сайт' }],
    ['переименуй проект в «Лендинг»', { kind: 'project-rename', name: 'Лендинг' }],
    ['/дублировать проект', { kind: 'project-duplicate' }],
    ['сделай копию проекта', { kind: 'project-duplicate' }],
  ];
  for (const [said, want] of cases) {
    const got = SHELL.shellIntent(said, {});
    assert.deepEqual(got, want, said);
    assert.equal(SHELL.commandIdOf(got), want.kind, `commandIdOf: ${said}`);
  }
  // прежние команды не перехвачены
  assert.equal(SHELL.shellIntent('переименуй слой в Шапка', {}).kind, 'rename');
  assert.equal(SHELL.shellIntent('новая доска', {}).kind, 'new-board');
  assert.equal(SHELL.shellIntent('/открыть', {}).kind, 'slash-bad', 'без имени — как набирать');
  const row = SHELL.SHELL_COMMANDS.find((c) => c.id === 'projects');
  assert.equal(row.group, 'Файл');
  assert.equal(row.keys, 'Mod+O');
  for (const id of ['project-new', 'project-open', 'project-rename', 'project-duplicate']) {
    const c = SHELL.SHELL_COMMANDS.find((x) => x.id === id);
    assert.ok(c && c.group === 'Файл', id);
    assert.ok(!/сервер/i.test(`${c.title} ${c.hint}`), `${id}: слова без «сервер»`);
  }
});

/* ------------------------------------ проводка в app.js ------------------------------------ */

const fn = (name) => {
  const at = app.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `нет функции ${name}`);
  const next = app.indexOf('\nfunction ', at + 10);
  const nextA = app.indexOf('\nasync function ', at + 10);
  const end = Math.min(...[next, nextA].filter((x) => x > 0));
  return app.slice(at, end);
};

test('r46 (app): без сервера — хранилище проектов; перенос прежнего документа один раз', () => {
  const init = fn('initCapabilities');
  assert.match(init, /await initSoloProjects\(\)/);
  assert.doesNotMatch(init, /db \? await restoreFromDb\(\) : await restoreFromLocal\(\)/, 'прежний путь — только внутри переноса');
  const solo = fn('initSoloProjects');
  assert.match(solo, /SOLO_MIGRATED_KEY/, 'метка переноса — повторный перенос не дублирует');
  assert.match(solo, /if \(list\.length\)/, 'проекты есть — прежний документ не трогаем');
  assert.match(solo, /!migrated && !list\.length\) restored = db \? await restoreFromDb\(\) : await restoreFromLocal\(\)/);
  assert.match(solo, /docName\(state\.doc\)/, 'первый проект — с именем прежнего документа');
  assert.match(solo, /state\.saveBlocked\) return false/, 'непрочитанный документ — сперва решение человека');
});

test('r46 (app): сохранение и уход — в хранилище проектов; конфликт вкладок — плашкой', () => {
  const save = fn('saveNow');
  assert.match(save, /if \(solo && solo\.current\) \{ await saveSoloNow\(payload, done\); return; \}/);
  assert.ok(save.indexOf('saveSoloNow') < save.indexOf("db.doc('docs/current')"), 'прежние ключи при проектах не пишутся');
  const exit = fn('saveOnExit');
  assert.match(exit, /solo\.store\.saveOnExit\(solo\.current, savePayload\(\)\)/);
  assert.match(exit, /solo\.store\.setView/);
  const ss = fn('saveSoloNow');
  assert.match(ss, /base: solo\.base/);
  assert.match(ss, /r\.conflict\) \{ soloConflict\(\)/);
  const c = fn('soloConflict');
  assert.match(c, /Проект изменён в другой вкладке/);
  assert.match(c, /Открыть свежую версию/);
  assert.match(c, /Оставить мою/);
  assert.match(c, /force: true/);
  const remote = fn('onSoloRemote');
  assert.match(remote, /!state\.dirty/, 'правок здесь нет — свежая версия без вопроса');
});

test('r46 (app): переключение — сперва останавливаем агента и дожидаемся, потом сохраняем', () => {
  const o = fn('openSoloProject');
  const stop = o.indexOf('stopAgent()');
  const wait = o.indexOf('state.running; i++) await');
  const flush = o.indexOf('flushSoloSave()');
  const load = o.indexOf('loadSoloProject(id)');
  assert.ok(stop > 0 && wait > stop && flush > wait && load > flush, 'стоп → ждём → сохраняем → открываем');
  assert.match(o, /Агент ещё заканчивает команду/);
  assert.match(o, /Проект не сохранился — другой не открываю/);
  assert.match(o, /solo\.sessions\.set\(solo\.current/, 'выделение, история и разговор — на проект');
  const l = fn('loadSoloProject');
  assert.match(l, /entry\.view && viewIsSane\(entry\.view\)/, 'вид — из индекса');
  assert.match(l, /entry\.board/, 'активная доска — из индекса');
});

test('r46 (app): шторка, удаление в строке, «Вернуть», Ctrl/⌘+O, импорт — новым проектом', () => {
  assert.match(fn('openProjects'), /if \(!server\) \{ if \(solo\) openSoloProjects\(\); return; \}/);
  const item = fn('soloProjectItem');
  assert.match(item, /pconfirm/);
  assert.doesNotMatch(item, /\bconfirm\(\s*[`'"]/, 'confirm() в артефакте не работает');
  assert.match(fn('deleteSoloProject'), /'Вернуть'/);
  assert.match(fn('deleteSoloProject'), /Удалил «/);
  assert.match(fn('fillSoloProjects'), /all\.length > 8/, 'поиск — когда проектов больше восьми');
  const mod = fn('onModKeyCapture');
  assert.match(mod, /KeyO/);
  assert.match(mod, /applyProjectCommand\(\{ kind: 'projects' \}\)/);
  const imp = fn('importJson');
  assert.match(imp, /if \(!server && solo\) \{ await importAsSoloProject\(taken, f\.name\); return; \}/);
  assert.ok(imp.indexOf('importAsSoloProject') < imp.indexOf('commitDoc('), 'новый проект — вместо замены открытого');
  const shellCase = fn('applyShellIntent');
  for (const k of ['projects', 'project-new', 'project-open', 'project-rename', 'project-duplicate']) assert.ok(shellCase.includes(`case '${k}':`), k);
  assert.match(css, /\.pconfirm \{/);
  assert.match(css, /button\.t-action \{/);
});
