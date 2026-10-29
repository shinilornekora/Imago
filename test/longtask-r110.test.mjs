/**
 * Круг 110 (SPEC §25): длинные задачи — «сделай полный воркфлоу игрового сценария» одной командой:
 * план сценария → каждый экран своей доской → колонки шагов → переходы полем доски `flow`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serverStageRec } from '../src/shell.js';
import * as core from '../src/core.js';
import { runCommand, SCHEMAS, PROMPTS } from '../src/brain.js';
import {
  recognizeFlow, normalizeFlow, screenBrief, flowColumns, layoutFlow, triggerNode, flowSummary, FLOW_LIMITS,
} from '../src/flow.js';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

const GAME = {
  title: 'Игра: от запуска до награды',
  summary: 'Заставка, меню, уровни, игра, победа',
  device: 'mobile',
  screens: [
    { key: 'splash', name: 'Заставка', purpose: 'Название и полоса загрузки.' },
    { key: 'menu', name: 'Главное меню', purpose: 'Кнопки «Играть» и «Настройки».' },
    { key: 'levels', name: 'Выбор уровня', purpose: 'Сетка уровней.' },
    { key: 'settings', name: 'Настройки', purpose: 'Звук и язык.' },
    { key: 'game', name: 'Игра', purpose: 'Поле, счёт, пауза.' },
    { key: 'win', name: 'Победа', purpose: 'Звёзды и награда.' },
  ],
  links: [
    { from: 'splash', to: 'menu', trigger: 'Загрузка закончилась' },
    { from: 'menu', to: 'levels', trigger: 'Нажал «Играть»' },
    { from: 'menu', to: 'settings', trigger: 'Нажал «Настройки»' },
    { from: 'settings', to: 'menu', trigger: 'Нажал «Назад»' },
    { from: 'levels', to: 'game', trigger: 'Выбрал уровень' },
    { from: 'game', to: 'win', trigger: 'Собрал все звёзды' },
    { from: 'win', to: 'menu', trigger: 'Нажал «В меню»' },
  ],
};

/** Дерево экрана по брифу: имя из «…», кнопки — по словам в кавычках из строки действий. */
function screenTree(brief) {
  const name = (/экраном «([^»]+)»/.exec(brief) || [])[1] || 'Экран';
  const acts = (/Переходы с экрана[^:]*:\s*(.+)/.exec(brief) || [])[1] || '';
  const buttons = [...acts.matchAll(/кнопка «([^»]+)»/g)].map((m) => m[1]);
  return {
    type: 'frame', name, layout: { mode: 'column', gap: 16, padding: 24 }, size: { w: 390, h: 844 }, fill: 'canvas',
    children: [
      { type: 'text', name: 'Заголовок', text: name, style: 'title', color: 'text' },
      ...buttons.map((b) => ({
        type: 'frame', name: `Кнопка ${b}`, layout: { mode: 'row', padding: [12, 20], justify: 'center' }, size: { w: 'fill', h: 'hug' }, fill: 'accent',
        children: [{ type: 'text', name: 'Надпись', text: b, style: 'body', color: 'onAccent' }],
      })),
    ],
  };
}

function fake(answers = {}, log = []) {
  return {
    name: 'fake', async ready() { return true; },
    async complete(messages, schema) {
      const user = [...messages].reverse().find((m) => m.role === 'user');
      log.push({ schema: schema.name, user: user && user.content, system: messages[0] && messages[0].content });
      const a = answers[schema.name];
      if (a instanceof Error) throw a;
      if (typeof a === 'function') return a(user && user.content, log);
      if (a !== undefined) return JSON.parse(JSON.stringify(a));
      if (schema.name === 'tree') return screenTree(user.content);
      if (schema.name === 'flow') return JSON.parse(JSON.stringify(GAME));
      throw new Error(`нет ответа на ${schema.name}`);
    },
  };
}
const empty = () => quiet(() => core.createDoc('empty'));

test('круг110: распознавание — сценарий, флоу, воркфлоу, N экранов; вопросы и прочее — нет', () => {
  for (const u of ['сделай полный воркфлоу игрового сценария', 'Собери флоу оплаты подписки', 'нарисуй user flow регистрации',
    'спроектируй путь пользователя от корзины до оплаты', 'сделай прототип приложения доставки', 'создай сценарий онбординга',
    'сделай полную развёртку экранов игры', 'собери онбординг из пяти экранов', 'сделай 6 экранов фитнес-приложения']) {
    assert.ok(recognizeFlow(u), u);
  }
  assert.deepEqual(recognizeFlow('собери онбординг из пяти экранов'), { screens: 5 });
  assert.deepEqual(recognizeFlow('сделай флоу из 30 экранов'), { screens: FLOW_LIMITS.maxScreens });
  for (const u of ['собери экран оплаты', 'сделай все экраны оплаты тёмными', 'что такое флоу?', 'как устроен сценарий',
    'покажи сценарий', 'сделай два экрана', 'привяжи цвета всех экранов к палитре', 'назови все экраны одинаково',
    'сделай заголовок крупнее', '']) {
    assert.equal(recognizeFlow(u), null, u);
  }
});

test('круг110: план — ключи, повторы, чужие переходы, предел экранов', () => {
  const f = normalizeFlow({
    title: 'T', screens: [{ key: 'A', name: 'Один', purpose: 'p' }, { key: 'A', name: 'Два' }, { name: 'Один' }, { key: 'c', name: 'Три' }],
    links: [{ from: 'A', to: 'a-2', trigger: 'x' }, { from: 'A', to: 'zzz', trigger: 'y' }, { from: 'c', to: 'c' }, { from: 'Три', to: 'Один', trigger: 'назад' }],
  });
  assert.deepEqual(f.screens.map((s) => s.key), ['a', 'a-2', 'c']);
  assert.deepEqual(f.links, [{ from: 'a', to: 'a-2', label: 'x' }, { from: 'c', to: 'a', label: 'назад' }]);
  assert.ok(f.notes.some((n) => /повторялся/.test(n)) && f.notes.some((n) => /не из плана/.test(n)));
  assert.equal(f.size.w, 390);
  assert.equal(normalizeFlow({ screens: [{ name: 'Один' }] }), null);
  assert.equal(normalizeFlow(GAME, { screens: 3 }).screens.length, 3);
  assert.equal(SCHEMAS.flow.name, 'flow');
  assert.match(PROMPTS.flow({ screens: 5 }), /столько и сделай/);
});

test('круг110: колонки шагов и раскладка', () => {
  const f = normalizeFlow(GAME);
  const cols = flowColumns(f);
  assert.deepEqual(Object.fromEntries(cols), { splash: 0, menu: 1, levels: 2, settings: 2, game: 3, win: 4 });
  const pos = layoutFlow(f, f.screens.map((s) => ({ key: s.key, w: 390, h: 844 })), { x: 100, y: 0 });
  assert.deepEqual(pos.get('splash'), { x: 100, y: 0 });
  assert.deepEqual(pos.get('levels'), { x: 100 + 2 * (390 + FLOW_LIMITS.gapX), y: 0 });
  assert.deepEqual(pos.get('settings'), { x: 100 + 2 * (390 + FLOW_LIMITS.gapX), y: 844 + FLOW_LIMITS.gapY });
  assert.match(screenBrief(f, f.screens[1], 1), /кнопка «Играть» → Выбор уровня; кнопка «Настройки» → Настройки/);
  assert.match(screenBrief(f, f.screens[0], 0), /событие «Загрузка закончилась» → Главное меню/);
  assert.equal(flowSummary('Игра', 6, 7), 'Сценарий «Игра»: 6 экранов, 7 переходов');
  assert.equal(flowSummary('Игра', 1, 2), 'Сценарий «Игра»: 1 экран, 2 перехода');
});

test('круг110: сквозь команду — шесть досок, колонки, переходы от кнопок, одна правка', async () => {
  const log = [];
  const doc = empty();
  const stagesSeen = [];
  const res = await runCommand({ doc, selection: [], utterance: 'сделай полный воркфлоу игрового сценария', provider: fake({}, log), engine: core,
    direction: false, onStage: (r) => stagesSeen.push(r) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const after = res.preview.doc;
  const boards = core.artboards(after);
  assert.equal(boards.length, 6);
  assert.deepEqual(boards.map((b) => b.name), GAME.screens.map((s) => s.name));
  assert.equal(res.plan.intent, 'flow');
  assert.equal(res.changeSummary, 'Сценарий «Игра: от запуска до награды»: 6 экранов, 7 переходов');
  const by = Object.fromEntries(boards.map((b) => [b.name, b]));
  // колонки шагов: настройки под выбором уровня
  assert.equal(by['Настройки'].pos.x, by['Выбор уровня'].pos.x);
  assert.ok(by['Настройки'].pos.y > by['Выбор уровня'].pos.y);
  assert.ok(by['Главное меню'].pos.x > by['Заставка'].pos.x);
  // переходы: от кнопки «Играть» к выбору уровня
  const menu = by['Главное меню'];
  const play = menu.flow.find((l) => l.to === by['Выбор уровня'].id);
  assert.equal(play.label, 'Нажал «Играть»');
  assert.equal(after.nodes[play.from].name, 'Кнопка Играть');
  // без кнопки — переход от доски
  assert.equal(by['Заставка'].flow[0].from, undefined);
  // одна правка = один шаг отмены; ядро её принимает с нуля
  const again = core.applyOps(doc, res.ops);
  assert.equal(again.error, undefined);
  // вызовы: план сценария + по дереву на экран, без критика и арт-директора
  assert.deepEqual(log.map((l) => l.schema), ['flow', ...GAME.screens.map(() => 'tree')]);
  assert.match(log[2].user, /Собери новым экраном «Главное меню»/);
  // прогресс: экран i из n
  const prog = stagesSeen.filter((r) => r.stage === 'flow' && r.progress && r.progress.name);
  assert.deepEqual(prog.map((r) => r.progress.done), [0, 1, 2, 3, 4, 5]);
  assert.ok(stagesSeen.some((r) => /^Экран 3\/6 · /.test(r.label || '')), 'стадии экрана — с префиксом');
  assert.ok(stagesSeen.every((r) => r.stage !== 'plan' || r.plan.intent === 'flow'), 'план экрана не перебивает план сценария');
});

test('круг110: сценарий справа от уже лежащих досок; один образ на все экраны', async () => {
  const base = empty();
  const r = core.applyOps(base, [core.ops.create({ id: 'old', type: 'frame', name: 'Старый', parent: base.root, pos: { x: 0, y: 50 },
    size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 200 } }, children: [] })]);
  const log = [];
  const DIR = { concept: 'Неоновый аркадный автомат', mood: ['драйв'], palette: { bg: '#15171c', surface: '#20242c', text: '#f2f4f7', muted: '#9aa3b2', accent: '#c6ff3d', accent2: '#ff4f6d' },
    fonts: { display: 'Russo One', text: 'Exo 2' }, materials: [], motifs: [], avoid: [] };
  const res = await runCommand({ doc: r.doc, selection: [], utterance: 'собери флоу мобильной игры', provider: fake({ direction: DIR }, log), engine: core });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const boards = core.artboards(res.preview.doc).filter((b) => b.id !== 'old');
  assert.equal(boards.length, 6);
  assert.ok(boards.every((b) => b.pos.x >= 300 + FLOW_LIMITS.offset), 'правее старой доски');
  assert.equal(Math.min(...boards.map((b) => b.pos.y)), 50);
  assert.equal(log.filter((l) => l.schema === 'direction').length, 1, 'арт-директор — один раз на сценарий');
  assert.ok(boards.every((b) => b.direction && b.direction.palette), 'образ лёг на каждую доску');
  assert.match(log.find((l) => l.schema === 'flow').system, /Старый/);
});

test('круг110: экран не собрался — остальные кладутся, переходы на него сняты; отмена и отказ', async () => {
  let n = 0;
  const res = await runCommand({ doc: empty(), selection: [], utterance: 'сделай сценарий игры', engine: core, direction: false,
    provider: fake({ tree: (u) => { n++; if (/экраном «Настройки»/.test(u)) throw new Error('модель упала'); return screenTree(u); } }) });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const boards = core.artboards(res.preview.doc);
  assert.equal(boards.length, 5);
  assert.ok(res.warnings.some((w) => /«Настройки»: экран собрать не вышло/.test(w)), res.warnings.join('\n'));
  assert.deepEqual(res.flow.missing, ['Настройки']);
  assert.equal(res.changeSummary, 'Сценарий «Игра: от запуска до награды»: 5 экранов, 5 переходов');
  assert.ok(n >= 6);

  const none = await runCommand({ doc: empty(), selection: [], utterance: 'сделай сценарий игры', engine: core, direction: false,
    provider: fake({ tree: new Error('нет') }) });
  assert.ok(none.error);
  assert.deepEqual(none.ops, []);

  const ctrl = new AbortController();
  const stopped = await runCommand({ doc: empty(), selection: [], utterance: 'сделай сценарий игры', engine: core, direction: false, signal: ctrl.signal,
    provider: fake({ tree: (u, log) => { if (log.length >= 3) ctrl.abort(); return screenTree(u); } }) });
  assert.equal(stopped.error && stopped.error.kind, 'cancelled');
  assert.deepEqual(stopped.ops, []);

  const no = await runCommand({ doc: empty(), selection: [], utterance: 'сделай сценарий свадьбы', engine: core, direction: false,
    provider: fake({ flow: { title: 'x', screens: [], links: [], cannot: 'Это сценарий праздника, а не экраны интерфейса.' } }) });
  assert.match(no.cannot, /праздника/);
  assert.deepEqual(no.ops, []);
});

test('круг110: triggerNode — слова в кавычках, кнопка-предок, нет совпадения — null', () => {
  const base = empty();
  const r = core.applyOps(base, [
    core.ops.create({ id: 'b', type: 'frame', name: 'B', parent: base.root, pos: { x: 0, y: 0 }, children: [] }),
    core.ops.create({ id: 'btn', type: 'frame', name: 'Кнопка', parent: 'b', children: [] }),
    core.ops.create({ id: 't', type: 'text', name: 'T', parent: 'btn', characters: 'Начать игру' }),
    core.ops.create({ id: 'h', type: 'text', name: 'H', parent: 'b', characters: 'Добро пожаловать' }),
  ]);
  assert.equal(triggerNode(r.doc, 'b', 'Нажал «Начать игру»'), 'btn');
  assert.equal(triggerNode(r.doc, 'b', 'Нажал кнопку начать'), 'btn');
  assert.equal(triggerNode(r.doc, 'b', 'Время вышло'), null);
});

test('круг110: boardFlow — годные переходы, мусор и удалённые цели пропускаются; serverStageRec несёт ход', () => {
  const base = empty();
  const mk = (id, x, flow) => core.ops.create({ id, type: 'frame', name: id, parent: base.root, pos: { x, y: 0 }, children: [], ...(flow ? { flow } : {}) });
  const r = core.applyOps(base, [
    mk('b2', 600),
    mk('b1', 0, [{ to: 'b2', label: 'Дальше', from: 'k' }, { to: 'b1' }, { to: 'nope' }, 'мусор', { to: 'b2', from: 'чужой' }, { to: 'b2', label: 7 }]),
    core.ops.create({ id: 'k', type: 'text', name: 'k', parent: 'b1', characters: 'Дальше' }),
  ]);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const b1 = r.doc.nodes.b1;
  assert.deepEqual(core.boardFlow(r.doc, b1), [{ to: 'b2', label: 'Дальше', from: 'k' }, { to: 'b2', label: '', from: null }, { to: 'b2', label: '', from: null }]);
  const gone = core.applyOps(r.doc, [core.ops.remove('b2')]);
  assert.deepEqual(core.boardFlow(gone.doc, gone.doc.nodes.b1), []);
  assert.deepEqual(core.boardFlow(r.doc, r.doc.nodes.b2), []);
  assert.deepEqual(serverStageRec({ key: 'llm', label: 'Экран 2 из 3: Телефон', progress: { done: 1, total: 3, name: 'Телефон' }, steps: ['А', 'Б', 'В'] }),
    { stage: 'srv:llm', label: 'Экран 2 из 3: Телефон', progress: { done: 1, total: 3, name: 'Телефон' }, steps: ['А', 'Б', 'В'] });
  assert.equal(serverStageRec({ key: 'llm', label: 'x' }).progress, undefined);
});

/* ── в настоящем браузере ───────────────────────────────────────────────── */
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { chromium = null; }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
/* Страница как dev.html (tools/build.mjs): заглушка модели перед разметкой, сервера нет. */
const DEV_TOP = '<script>window.IMAGO_DEFAULTS = { server: false };</script>\n<script src="tools/stub.js"></script>\n';
function serve() {
  const srv = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (/^\/(api|ws|agent)(\/|$)/.test(path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":true,"code":"not_found"}'); return; }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      let body = await readFile(file);
      if (path === '/') body = DEV_TOP + body;
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

test('круг110: в браузере — ход «экран i из n», девять досок со стрелками, одна отмена', { skip: !chromium && 'нет Playwright', timeout: 120000 }, async () => {
  const srv = await serve();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // заглушка отвечает с задержкой — ход работы успевает показаться
    const stub = (await readFile(join(root, 'tools/stub.js'), 'utf8'))
      .replace('async function sampleFn(input, opts = {}) {', 'async function sampleFn(input, opts = {}) { await new Promise((r) => setTimeout(r, 150));');
    await page.route('**/tools/stub.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: stub }));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#command');
    const before = await page.evaluate(() => document.querySelectorAll('.imago-ab').length);
    await page.locator('#command').fill('сделай полный воркфлоу игрового сценария');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#work-progress').hidden, null, { timeout: 20000 });
    await page.waitForFunction(() => /Экран \d\/9/.test(document.querySelector('#work-detail').textContent), null, { timeout: 20000 });
    const mid = await page.evaluate(() => ({
      max: document.querySelector('#work-progress').getAttribute('aria-valuemax'),
      steps: document.querySelectorAll('#work-steps li').length,
      now: document.querySelectorAll('#work-steps li[data-now="on"]').length,
    }));
    assert.equal(mid.max, '9');
    assert.equal(mid.steps, 5, 'окно из пяти экранов');
    assert.equal(mid.now, 1, 'текущий экран выделен');
    await page.waitForFunction(() => document.querySelector('#worklog').hidden, null, { timeout: 90000 });
    const done = await page.evaluate(() => ({
      boards: document.querySelectorAll('.imago-ab').length,
      links: document.querySelectorAll('.imago-flow-link').length,
      heads: document.querySelectorAll('.imago-flow-head').length,
      msg: document.querySelector('#dockmsg').innerText,
      pe: getComputedStyle(document.querySelector('.imago-flow')).pointerEvents,
    }));
    assert.equal(done.boards - before, 9);
    assert.equal(done.links, 14);
    assert.equal(done.heads, 14);
    assert.equal(done.pe, 'none', 'стрелки не мешают щелчкам');
    assert.match(done.msg, /Сценарий «Игра: от запуска до награды»: 9 экранов, 14 переходов/);
    // весь сценарий — одна правка
    await page.locator('#dockmsg button', { hasText: 'Отменить' }).first().click();
    await page.waitForFunction((n) => document.querySelectorAll('.imago-ab').length === n, before, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll('.imago-flow-link').length), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    srv.close();
  }
});
