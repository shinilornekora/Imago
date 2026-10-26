/**
 * Конвейер одной команды (SPEC §8.2 шаги 3–13, §10): intent → DSLR → DUIL → (LLM ↔ DSLV) → DSLTS.
 *
 * Круг 38: JEV (классификатор «оболочка или модель») из архитектуры исключён. Команды
 * оболочки — открытая таблица в клиенте (`src/shell.js`, SHELL_COMMANDS): клиент исполняет их
 * сам, без сети. Orchestrator их не узнаёт для исполнения и событие `shell` не шлёт. Первая
 * стадия — `intent` («Разбираю запрос»): вид работы для выбора промпта (`classifyUtterance`
 * brain), варианты (`recognizeVariants`), местные ответы brain без модели. Реплика, которая
 * всё же оказалась явной командой редактора (старый клиент, внешний вызов API), получает
 * `result` без записи с честным текстом — без модели, очереди и чтения документа.
 *
 * Очередь на проект: команды агента одного проекта выполняются по одной (модель
 * рассуждает над стейтом, который вторая команда уже меняет, §8.3); ждущих не больше
 * `maxQueue`, дальше — 429 busy. Ручные правки идут мимо очереди (прямо в Document service).
 *
 * События — в `sink` (SSE §10.3). Разрыв потока команды не отменяет: sink просто
 * перестаёт писать, команда доводится до записи, клиент получит транзакцию по сокету Hub.
 * «Стоп» — AbortSignal команды: снимает её из очереди, прерывает вызов модели и счёт в
 * воркере; если запись уже ушла в Document service, она доводится (повтор по tx_id).
 */

import * as core from '../../src/core.js';
import { OrchError, toOrchError, INTERNAL_MESSAGE, notFound, badRequest, llmDown, llmUnconfigured, documentBusy, agentBusy, documentEngine, safeDetail, cancelled as cancelledErr, shuttingDown as shuttingDownErr } from './errors.js';
import { MAX_QUEUE_PER_PROJECT, VARIANTS_TTL_MS, MAX_VARIANT_SETS, SHUTDOWN_GRACE_MS, SHUTDOWN_ABORT_WAIT_MS } from './limits.js';
import {
  visionRefusal,
  isInternalError, recognizeAction, recognizeVariants, recognizeUndoDoubt, recognizeComponentIntent,
  classifyUtterance, hasWords,
} from '../../src/brain.js';
import * as shell from '../../src/shell.js';

const { ENGINE_VERSION, uid, cutText, cleanText } = core;
/** Круг 39 (N5б): реплика длиннее (знаков) — не команда редактора; вид работы — по её началу. */
export const RECOGNIZE_MAX = 2000;
/** Длина `command_id` транзакции, которую хранит Document service (круг 25). */
const TX_COMMAND_ID_MAX = 64;

/** Круг 47: есть ли в репликах картинка (запрос со снимком доски для критика). */
const hasImage = (messages) => Array.isArray(messages)
  && messages.some((m) => m && Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image'));

/** Стадии brain → ключи §10.3. Не названные — не показываются (их смысл несёт result). */
const BRAIN_STAGE = {
  plan: 'llm', generate: 'llm', retry: 'llm', variant: 'llm',
  materialize: 'validate', validate: 'validate', repair: 'repair',
  // круг 47 (SPEC §14): образ — шаг модели, критик — проверка, доработка — починка
  direct: 'llm', critic: 'validate', revise: 'repair', 'direct-off': 'llm', 'critic-off': 'validate',
};

const LABELS = {
  intent: 'Разбираю запрос',
  read: 'Читаю документ',
  library: 'Смотрю библиотеки',
  llm: 'Думаю',
  validate: 'Проверяю',
  repair: 'Чиню',
  write: 'Записываю правку',
};

const AGENT_AUTHOR = 'Агент';
/** /agent/apply: вариантов нет, устарели или команда чужая (круг 33) — одни и те же слова. */
const VARIANTS_GONE = 'Варианты этой команды не найдены или устарели — попросите их заново';

const INTENT_RU = { create: 'создание', edit: 'правка', theme: 'оформление', ask: 'вопрос', clarify: 'уточнение', illustration: 'иллюстрация' };

/** Круг 38: ответ на явную команду редактора, пришедшую агенту (её исполняет клиент сам). */
export const EDITOR_COMMAND_TEXT = 'Это команда редактора — выполните её в строке команд';

/** Сколько вариантов просят словами: «покажи два варианта» → 2. */
function variantsCount(text) {
  const m = /(\d|один|одну|два|две|три|четыре|пять|шесть)\s+вариант/.exec(shell.normSaid(text));
  const n = m ? shell.numSaid(m[1]) : null;
  return n ? Math.max(1, Math.min(6, n)) : null;
}

/**
 * Явная команда редактора по одной лишь фразе (без документа): отмена/возврат (`recognizeAction`
 * brain), слэш-форма («/zoom 100», «/тема тёмная») или фраза из открытой таблицы оболочки
 * (`isShellCommandText` из src/shell.js; у прежней оболочки — `shellIntent(text, {})`).
 * Только проверка: исполнять команду Orchestrator не умеет и не должен.
 * @param {string} text
 */
export function isEditorCommand(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (recognizeAction(s)) return true;
  // слэш-форма — синтаксис строки команд, а не речь для модели (даже неизвестное имя)
  if (/^\/\p{L}/u.test(s)) return true;
  try {
    if (typeof shell.isShellCommandText === 'function') return !!shell.isShellCommandText(s);
    return !!shell.shellIntent(s, {});
  } catch {
    return false;
  }
}

/**
 * Стадия `intent` (круг 38, вместо JEV): какую работу просят — это выбор пути и промпта
 * агента, а не привратник «оболочка или модель».
 *   {kind:'editor'}                       — явная команда редактора: ответ без модели и записи;
 *   {kind:'variants', n, of}              — режим вариантов или «покажи три варианта»;
 *   {kind:'model', needsModel, intent}    — работа агента; `needsModel:false` — brain ответит
 *                                           сам (пустая реплика, двусмысленная отмена, «сделай
 *                                           компонент»), проверка модели перед стартом не нужна.
 * Порядок: отмена/возврат → просьба о вариантах → команда редактора → режим вариантов → модель.
 * @param {string} text
 * @param {{hasSelection?: boolean, mode?: 'run'|'variants', n?: number}} [ctx]
 */
export function intentOf(text, ctx = {}) {
  const full = String(text == null ? '' : text).trim();
  /* Круг 39 (N5б): стадия intent идёт на главном потоке до очереди — длинная реплика не должна
     его держать. Команды редактора, отмена, просьба о вариантах и о компоненте — короткие фразы:
     реплика длиннее RECOGNIZE_MAX ни одной из них не бывает (кроме слэш-формы — её видно по
     первому знаку), а вид работы для промпта читается по её началу. */
  if (full.length > RECOGNIZE_MAX) {
    if (/^\/\p{L}/u.test(full)) return { kind: 'editor' };
    if (ctx.mode === 'variants') return { kind: 'variants', n: ctx.n || 3, of: '' };
    const head = full.slice(0, RECOGNIZE_MAX);
    const guess = classifyUtterance(head, { hasSelection: !!ctx.hasSelection });
    return { kind: 'model', needsModel: hasWords(head), intent: guess.intent };
  }
  if (recognizeAction(full)) return { kind: 'editor' };
  const wantVariants = recognizeVariants(full);
  if (wantVariants || (ctx.mode === 'variants' && !isEditorCommand(full))) {
    return {
      kind: 'variants',
      n: ctx.n || variantsCount(full) || 3,
      of: wantVariants ? wantVariants.variantsOf || '' : '',
    };
  }
  if (isEditorCommand(full)) return { kind: 'editor' };
  const local = !hasWords(full) || !!recognizeUndoDoubt(full) || !!recognizeComponentIntent(full);
  const guess = classifyUtterance(full, { hasSelection: !!ctx.hasSelection });
  return { kind: 'model', needsModel: !local, intent: guess.intent };
}

/** Итог без записи на команду редактора (событие `result`, §10.5 «result без записи»). */
function editorReply() {
  return {
    tx_id: null, seq: null, applied: 0, dropped: [],
    summary: EDITOR_COMMAND_TEXT, warnings: [], editorCommand: true,
  };
}

/**
 * Глобальные id для узлов, созданных агентом (§8.3: id генерирует клиент, глобально
 * уникальные). С круга 24 brain сам выдаёт `core.uid` (§10.6), и для его операций это
 * переименование пусто; оно осталось страховкой от коротких id (`f1`, `t2` — уникальных
 * лишь в документе): после чужого удаления такой id мог бы вернуться к жизни и
 * столкнуться с отменой этого удаления. Переименовываются только узлы, созданные в этой
 * же пачке и не похожие на `core.uid`; ссылки — во всех полях-указателях: `id`, `parent`,
 * `after`, `children`, `of`, `component.props[].target`, а также `set` путей `of` и
 * `component…`. Пачка, где ссылки не найдены, переписывается так же — лишнего не трогаем.
 */
export function globalizeIds(ops) {
  const list = Array.isArray(ops) ? ops : [];
  const map = new Map();
  for (const op of list) {
    const id = op && op.op === 'create' && op.node && op.node.id;
    if (typeof id === 'string' && !id.includes('_') && !map.has(id)) {
      map.set(id, uid(op.node.type === 'frame' ? 'f' : op.node.type === 'text' ? 't' : op.node.type === 'instance' ? 'i' : 'n'));
    }
  }
  if (!map.size) return list;
  const re = (v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v);
  const comp = (c) => {
    if (!c || typeof c !== 'object' || !Array.isArray(c.props)) return c;
    return { ...c, props: c.props.map((p) => (p && typeof p === 'object' && 'target' in p ? { ...p, target: re(p.target) } : p)) };
  };
  const node = (n) => {
    if (!n || typeof n !== 'object') return n;
    const out = { ...n, id: re(n.id), parent: re(n.parent) };
    if (Array.isArray(n.children)) out.children = n.children.map(re);
    if ('of' in n) out.of = re(n.of);
    if (n.component) out.component = comp(n.component);
    return out;
  };
  return list.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const out = { ...op };
    if ('id' in op) out.id = re(op.id);
    if ('parent' in op) out.parent = re(op.parent);
    if ('after' in op) out.after = re(op.after);
    if (op.node) out.node = node(op.node);
    if (op.op === 'set' && op.path === 'of') out.value = re(op.value);
    if (op.op === 'set' && op.path === 'component') out.value = comp(op.value);
    return out;
  });
}

/**
 * @param {{
 *   dslr: object, dslts: object, duil: object, dslv: object, llm: object, traces: object,
 *   docHealth: () => Promise<'up'|'down'>,
 *   maxQueue?: number, variantsTtlMs?: number, log?: object, instance?: string, startedAt?: string
 * }} deps
 */
export function createPipeline(deps) {
  const { dslr, dslts, duil, dslv, llm, traces, docHealth } = deps;
  /* Круг 31 (K2): здоровье документа с причиной; без docHealthDetail — из docHealth, причина
     тогда неизвестна (unreachable). */
  const docHealthDetail = deps.docHealthDetail || (async () => {
    const d = await docHealth();
    return d === 'up' ? { document: 'up' } : { document: 'down', reason: 'unreachable' };
  });
  const log = deps.log || console;
  const maxQueue = deps.maxQueue == null ? MAX_QUEUE_PER_PROJECT : deps.maxQueue;
  const variantsTtl = deps.variantsTtlMs || VARIANTS_TTL_MS;
  const instance = deps.instance || '';
  const startedAt = deps.startedAt || new Date().toISOString();
  // круг 47 (SPEC §14): арт-направление и визуальный критик (AGENT_DIRECTION, AGENT_CRITIC, AGENT_RENDER)
  const art = {
    direction: deps.art ? deps.art.direction !== false : true,
    critic: deps.art ? deps.art.critic !== false : true,
    render: deps.art ? deps.art.render !== false : true,
    // проверка: готовый снимок вместо рендера (действует только у воркеров с testHooks)
    ...(deps.art && typeof deps.art.fakeShot === 'string' ? { fakeShot: deps.art.fakeShot } : {}),
  };

  /* Круг 26: совет администратору — в лог, а не человеку в браузер; одна строка на
     причину не чаще раза в минуту (модель лежит — каждая команда скажет то же). */
  const hinted = new Map();
  function adminHint(key, text) {
    const now = Date.now();
    if (now - (hinted.get(key) || 0) < 60000) return;
    hinted.set(key, now);
    log.warn(`[orchestrator] ${text}`);
  }
  const where = () => {
    const d = typeof llm.describe === 'function' ? llm.describe() : {};
    return d && d.base ? `${d.kind || 'openai'} ${d.base}` : 'адрес не задан';
  };
  const hintUnconfigured = () => adminHint('unconfigured', 'модель не подключена: задайте LLM_BASE_URL (и LLM_MODEL, LLM_API_KEY) в окружении Orchestrator — пока правки агентом не выполняются');
  const hintDown = (why) => adminHint('down', `модель не отвечает (${where()})${why ? `: ${why}` : ''} — проверьте, что сервер модели запущен и доступен из контейнера Orchestrator`);

  const queues = new Map();     // project → {running: Task|null, waiting: Task[]}
  const active = new Map();     // command_id → Task (ждёт или выполняется)
  const variantSets = new Map(); // command_id → {project, base_seq, items, author, client, text, expires, applied?, applying?}
  let closing = false;

  /* ── очередь проекта ─────────────────────────────────────────────────── */

  /**
   * Поставить задачу в очередь проекта. Синхронно: либо принято, либо OrchError (429).
   * @returns {{position: number, finished: Promise<void>}}
   */
  function admit(task) {
    if (closing) throw shuttingDownErr();
    let q = queues.get(task.project);
    if (!q) { q = { running: null, waiting: [] }; queues.set(task.project, q); }
    if (q.running && q.waiting.length >= maxQueue) {
      throw new OrchError(429, 'busy', `Агент занят командами этого проекта (в очереди ${q.waiting.length}) — повторите, когда он освободится`, { retryAfter: 5 });
    }
    let done;
    task.finished = new Promise((r) => { done = r; });
    task.markDone = done;
    if (!q.running) {
      q.running = task;
      queueMicrotask(() => runTask(q, task));
      return { position: 0, finished: task.finished };
    }
    q.waiting.push(task);
    return { position: q.waiting.length, finished: task.finished };
  }

  async function runTask(q, task) {
    try {
      await task.run();
    } catch (e) {
      log.warn(`[orchestrator] задача ${task.id} упала: ${e && e.stack ? e.stack : e}`);
    } finally {
      task.markDone();
      next(q, task);
    }
  }

  function next(q, finished) {
    if (q.running === finished) q.running = null;
    while (!q.running && q.waiting.length) {
      const t = q.waiting.shift();
      if (t.dropped) continue;
      q.running = t;
      queueMicrotask(() => runTask(q, t));
    }
    q.waiting.forEach((t, i) => { if (t.onPosition) t.onPosition(i + 1); });
    if (!q.running && !q.waiting.length) queues.delete(finished.project);
  }

  /** Снять ждущую задачу (она не начнётся). */
  function unqueue(task) {
    const q = queues.get(task.project);
    if (!q) return false;
    const i = q.waiting.indexOf(task);
    if (i < 0) return false;
    q.waiting.splice(i, 1);
    task.dropped = true;
    q.waiting.forEach((t, j) => { if (t.onPosition) t.onPosition(j + 1); });
    task.markDone();
    if (!q.running && !q.waiting.length) queues.delete(task.project);
    return true;
  }

  /* ── проверка перед стартом ──────────────────────────────────────────── */

  /** Document service и (если нужна) модель живы — иначе 503 до открытия потока. */
  async function preflight({ needsModel }) {
    const [doc, model] = await Promise.all([
      // круг 39 (N5а): терпеливо — короткий срок не уложился, спрашиваем ещё раз подольше
      docHealthDetail({ patient: true }),
      needsModel ? llm.health() : Promise.resolve(null),
    ]);
    /* Круг 39 (N5а): сервис принял запрос, но не ответил и за долгий срок — он перегружен, а не
       «недоступен»; опаздывал при этом наш собственный цикл событий — перегружен агент. */
    if (doc.document !== 'up' && doc.slow) {
      if (doc.ownLag) {
        adminHint('lag', 'главный поток агента перегружен: проверка Document service не уложилась в срок из-за своей очереди — команде busy');
        throw agentBusy(5);
      }
      throw documentBusy(5, { document_reason: 'slow' });
    }
    /* Круг 43: сервис документов работает с другой версией движка — не «недоступен», а «ещё не
       обновился» (или агент старее его): код `engine`, повторяемо. */
    if (doc.document !== 'up' && doc.reason === 'engine') {
      throw documentEngine({ engine: doc.engine, found: ENGINE_VERSION, agentOld: Number.isInteger(doc.engine) && doc.engine > ENGINE_VERSION });
    }
    if (doc.document !== 'up') {
      // круг 32: 'schema' — база сервиса догоняет схему после восстановления из копии (секунды)
      const text = doc.reason === 'schema'
        ? 'Сервер обновляет базу данных — команда не выполнена. Правки не потеряны; повторите через несколько секунд.'
        : 'Сервис документов недоступен — команда не выполнена. Правки не потеряны; попробуйте через несколько секунд.';
      throw new OrchError(503, 'document_down', text, { retryAfter: 5, detail: { document_reason: doc.reason || 'unreachable' } });
    }
    if (model && model.llm === 'unconfigured') { hintUnconfigured(); throw llmUnconfigured(); }
    if (model && model.llm === 'down') { hintDown(''); throw llmDown(); }
  }

  /* ── команда ─────────────────────────────────────────────────────────── */

  /**
   * Принять команду: стадия intent, проверка, очередь. Ошибки до открытия потока — исключением
   * (HTTP-ответ с кодом); дальше всё идёт событиями в sink.
   * @param {object} cmd проверенное тело команды
   * @param {() => {send: Function, end: Function}} openSink открыть поток (вызывается один раз, когда команда принята)
   * @returns {Promise<{finished: Promise<void>}>}
   */
  async function command(cmd, openSink) {
    if (active.has(cmd.command_id)) throw badRequest('Команда с таким command_id уже выполняется');
    const t0 = Date.now();
    const verdict = intentOf(cmd.text, { hasSelection: cmd.selection.length > 0, mode: cmd.mode, n: cmd.n });

    /* Круг 38: явная команда редактора — не работа агента. Её исполняет клиент по своей
       таблице; здесь — честный ответ без модели, без очереди и без чтения документа. */
    if (verdict.kind === 'editor') {
      const sink = openSink();
      sink.send('stage', { key: 'intent', label: LABELS.intent, at: Date.now(), detail: 'команда редактора' });
      sink.send('result', editorReply());
      sink.send('done', {});
      sink.end();
      traces.record({
        command_id: cmd.command_id, project: cmd.project, mode: cmd.mode, kind: 'editor', status: 'ok',
        started_at: new Date(t0).toISOString(), ms: Date.now() - t0, steps: [{ key: 'intent', ms: Date.now() - t0 }],
        engine: ENGINE_VERSION,
      });
      return { finished: Promise.resolve() };
    }

    const needsModel = verdict.kind === 'variants' || verdict.needsModel;
    await preflight({ needsModel });
    if (active.has(cmd.command_id)) throw badRequest('Команда с таким command_id уже выполняется');

    const ctrl = new AbortController();
    const task = {
      id: cmd.command_id, project: cmd.project, ctrl, cmd, verdict, sink: null, t0,
      run: () => execute(task),
    };
    const { position, finished } = admit(task);
    active.set(cmd.command_id, task);
    task.sink = openSink();
    task.onPosition = (p) => task.sink.send('queued', { position: p, scope: 'project' });
    if (position > 0) task.sink.send('queued', { position, scope: 'project' });
    finished.then(() => { if (active.get(cmd.command_id) === task) active.delete(cmd.command_id); });
    return { finished };
  }

  async function execute(task) {
    const { cmd, ctrl, sink } = task;
    let { verdict } = task;
    const signal = ctrl.signal;
    const steps = [];
    let curStep = null;
    const usage = { calls: 0, ms: 0, promptTokens: 0, completionTokens: 0 };
    const trace = {
      command_id: cmd.command_id, project: cmd.project, mode: verdict.kind === 'variants' ? 'variants' : 'run',
      kind: verdict.kind, started_at: new Date(task.t0).toISOString(), engine: ENGINE_VERSION,
      llm_kind: llm.kind, model: llm.model || undefined,
    };
    const step = (key, label, detail) => {
      if (!curStep || curStep.key !== key) {
        if (curStep) steps.push({ key: curStep.key, ms: Date.now() - curStep.at });
        curStep = { key, at: Date.now() };
      }
      sink.send('stage', { key, label: label || LABELS[key], at: Date.now(), ...(detail ? { detail: llm.redact(detail) } : {}) });
    };
    const guard = () => { if (signal.aborted) throw cancelledErr(); };
    /** Круг 39: доля семафора полных чтений, которую держит документ этой команды. */
    const lease = {};
    const unlease = () => { const r = lease.release; lease.release = null; if (typeof r === 'function') r(); };

    try {
      guard();
      step('intent', LABELS.intent, verdict.kind === 'variants' ? 'варианты' : INTENT_RU[verdict.intent] || '');
      guard();
      step('read');
      /* Круг 39 (N5а): полное чтение ждёт семафора агента — событие `queued {scope:'read'}` с номером;
         дождалось — снова «Читаю документ». Байты прочитанного целиком документа держатся в
         семафоре, пока он нужен команде (до конца расчёта, `lease`). */
      let readQueued = false;
      const st = await dslr.read(cmd.project, {
        signal, lease,
        onQueued: (position) => { readQueued = true; sink.send('queued', { position, scope: 'read' }); },
        onStart: () => { if (readQueued) step('read'); },
      });
      if (readQueued) trace.read_queued = true;
      guard();
      /* Круг 38: просьбу о вариантах, которую видно только по документу (предмет назван
         именем слоя), brain раньше отдавал оболочке действием `variants`. События `shell`
         больше нет — Orchestrator сам переходит в режим вариантов. */
      if (verdict.kind === 'model' && verdict.needsModel) {
        const want = recognizeVariants(cmd.text, { doc: st.doc });
        if (want) {
          verdict = { kind: 'variants', n: cmd.n || variantsCount(cmd.text) || 3, of: want.variantsOf || '' };
          task.verdict = verdict;
          trace.mode = 'variants';
          trace.kind = 'variants';
        }
      }
      step('library');
      const lib = await duil.slice({ exclude: cmd.project, signal });
      trace.libraries = lib.libraries.length;
      trace.library_components = lib.libraries.reduce((n, l) => n + (l.components || 0), 0);
      guard();

      const onLlm = async (messages, schema, opts) => {
        if (!llm.provider) throw Object.assign(new Error(llmUnconfigured().message), { kind: 'network', code: 'llm_unconfigured' });
        const t = Date.now();
        try {
          return await llm.provider.complete(messages, schema, {
            ...opts,
            signal,
            onUsage: (u) => {
              usage.calls += 1;
              usage.promptTokens += u.promptTokens || 0;
              usage.completionTokens += u.completionTokens || 0;
              if (opts.onUsage) opts.onUsage(u);
            },
          });
        } catch (e) {
          // круг 31 (K3): исключение нашего кода в главном потоке — не модель: стек в лог, internal
          if (isInternalError(e)) {
            log.warn(`[orchestrator] команда ${cmd.command_id}: внутренняя ошибка при вызове модели: ${llm.redact(e.stack || e.message)}`);
            throw Object.assign(new Error(INTERNAL_MESSAGE), { kind: 'internal', code: 'internal' });
          }
          if (e && e.kind === 'network' && !signal.aborted) llm.markDown();
          // круг 29 (J5): тело отказа модели («{"error":…}») — администратору в лог, не человеку
          if (e && e.detail) {
            log.warn(`[orchestrator] команда ${cmd.command_id}: модель отвергла запрос${e.status ? ` (${e.status})` : ''}: ${llm.redact(String(e.detail))}`);
          }
          // круг 47: модель отвергла запрос со снимком — картинок она не видит, больше не шлём
          if (hasImage(messages) && visionRefusal(e)) {
            adminHint('vision', 'модель отвергла запрос со снимком доски — самопроверка идёт по приметам шаблона; если модель картинок не видит, задайте LLM_VISION=0');
          }
          // наружу из главного потока — только очищенный текст
          throw Object.assign(new Error(llm.redact(e && e.message ? e.message : 'Сбой модели')), {
            kind: (e && e.kind) || 'model', code: e && e.code, ...(e && Number.isInteger(e.status) ? { status: e.status } : {}),
          });
        } finally {
          usage.ms += Date.now() - t;
        }
      };

      const payload = {
        mode: verdict.kind === 'variants' ? 'variants' : 'run',
        doc: st.doc,
        selection: cmd.selection,
        // круг 27 (I6): выделение, поставленное агентом, — не граница, назначенная человеком
        selectionBy: cmd.selection_by === 'agent' ? 'agent' : 'human',
        // «покажи варианты» без команды — к предыдущей команде из истории диалога
        utterance: verdict.kind === 'variants' && !verdict.of && cmd.mode !== 'variants' && cmd.history.length
          ? cmd.history[cmd.history.length - 1].utterance
          : cmd.text,
        activeArtboardId: cmd.board || null,
        history: cmd.history.length ? cmd.history : null,
        // внешний словарь компонентов (DUIL, §10.6): brain дополняет им библиотеку документа
        library: lib.docs && lib.docs.length ? lib.docs : null,
        n: verdict.kind === 'variants' ? verdict.n : undefined,
        // круг 47 (SPEC §14): арт-направление и критик; видит ли модель картинки (узнаётся по отказу)
        // круг 50: выключить у команды можно, включить выключенное у сервиса — нет
        art: {
          ...art, vision: llm.provider ? llm.provider.vision : false,
          ...(cmd.art && cmd.art.direction === false ? { direction: false } : {}),
          ...(cmd.art && cmd.art.critic === false ? { critic: false } : {}),
          ...(cmd.art && cmd.art.webFonts === false ? { webFonts: false } : {}),
        },
        ...(cmd.test ? { test: cmd.test } : {}),
      };
      step('llm');
      const res = await dslv.run(payload, {
        signal,
        onLlm,
        // круг 27: все воркеры считают — команда ждёт расчёта (не очереди проекта)
        onQueued: ({ position }) => sink.send('queued', { position, scope: 'workers' }),
        onStage: (rec) => {
          const key = BRAIN_STAGE[rec.stage];
          if (key) step(key, rec.label, rec.detail);
        },
      });
      // круг 39: документ команде больше не нужен (расчёт кончился) — его байты другим чтениям
      unlease();
      guard();
      trace.model_calls = usage.calls;

      if (payload.mode === 'variants') {
        await finishVariants(task, st, res.variants || [], trace, step);
      } else {
        await finishRun(task, st, res, trace, step);
      }
    } catch (e) {
      let err = toOrchError(e);
      // сеть, оборванная «стопом», — это остановка, а не авария сервиса
      if (signal.aborted && (err.code === 'internal' || (e && e.network))) err = cancelledErr();
      // круг 27 (I6): прервал не человек, а останов процесса — команда не выполнена, её можно повторить
      if (task.shutdown && (err.code === 'cancelled' || signal.aborted)) err = shuttingDownErr();
      if (!(e instanceof OrchError)) log.warn(`[orchestrator] команда ${cmd.command_id}: ${llm.redact(e && e.stack ? e.stack : e)}`);
      // retry_after (с) — когда срок повтора известен: клиент считает его на кнопке «Повторить»
      sink.send('error', {
        code: err.code, message: llm.redact(err.message), retryable: err.retryable,
        /* Круг 31: подсказка оболочке (`hint`); круг 43 (§10.13): и прочие безопасные поля detail
           (cause, queue, limit, engine/found…) — белым списком `safeDetail`, без сырых причин сети */
        ...(safeDetail(err.detail) ? { detail: safeDetail(err.detail) } : {}),
        ...(Number.isFinite(err.retryAfter) && err.retryAfter > 0 ? { retry_after: err.retryAfter } : {}),
      });
      trace.status = err.code === 'cancelled' ? 'cancelled' : 'error';
      if (task.shutdown) trace.shutdown = true;
      trace.code = err.code;
    } finally {
      unlease();
      if (curStep) steps.push({ key: curStep.key, ms: Date.now() - curStep.at });
      sink.send('done', {});
      sink.end();
      trace.steps = steps;
      trace.ms = Date.now() - task.t0;
      trace.model_calls = usage.calls;
      trace.model_ms = usage.ms;
      trace.prompt_tokens = usage.promptTokens;
      trace.completion_tokens = usage.completionTokens;
      trace.model = llm.model || undefined;
      if (!trace.status) trace.status = 'ok';
      traces.record(trace);
    }
  }

  /** Ошибка brain → OrchError (§10.2). */
  function brainError(error) {
    const msg = llm.redact(error && error.message ? error.message : 'Сбой модели');
    if (!error) return new OrchError(502, 'llm_failed', msg);
    if (error.kind === 'cancelled') return cancelledErr();
    if (error.code === 'llm_unconfigured') { hintUnconfigured(); return llmUnconfigured(); }
    if (error.kind === 'network') {
      // подробности сети (адрес, ECONNREFUSED) — администратору в лог, человеку — нейтрально
      hintDown(msg);
      return llmDown();
    }
    /* Круг 31 (K3): исключение кода агента — не сбой модели: `internal`, повтор не поможет;
       стек — администратору в лог (человеку — общая фраза). */
    if (error.kind === 'internal' || error.code === 'internal') {
      log.warn(`[orchestrator] внутренняя ошибка агента: ${llm.redact(String(error.stack || error.message || ''))}`);
      return new OrchError(500, 'internal', INTERNAL_MESSAGE, { retryable: false });
    }
    // круг 31 (K3): ответ модели слишком большой, глубокий или не JSON — модель жива, повтор может помочь
    if (error.code === 'llm_bad_response') return new OrchError(502, 'llm_bad_response', msg, { retryable: true });
    // круг 29 (J5): ответ модели разобран, но к документу не приложился — это не сбой модели
    if (error.code === 'not_applied') {
      return new OrchError(422, 'not_applied', msg, {
        retryable: error.retryable !== false,
        // круг 31: совет «назовите слой» — только когда причина в выборе слоя (оболочке)
        ...(error.hint ? { detail: { hint: error.hint } } : {}),
      });
    }
    if (error.detail) log.warn(`[orchestrator] ошибка модели: ${llm.redact(String(error.detail))}`);
    return new OrchError(502, 'llm_failed', msg, { retryable: error.retryable !== false });
  }

  /** Круг 31 (K3): итог команды, на которую модель не предложила ни одной правки. */
  const NOTHING_FOUND = 'Агент не нашёл, что поменять';

  /** То, что агент сказал, не трогая документ: переспрос, ответ, отказ, «нечего менять». */
  function replyOf(res, fallback) {
    const plan = res.plan || {};
    return {
      tx_id: null, seq: null, applied: 0, dropped: [],
      // круг 31 (K3): пустой патч — «не нашёл, что поменять», а не план, которого не было
      summary: llm.redact(res.emptyPatch ? NOTHING_FOUND : res.clarify || res.answer || res.cannot || plan.summary || plan.title || fallback || ''),
      warnings: (res.warnings || []).map((w) => llm.redact(w)),
      ...(res.clarify ? { clarify: res.clarify, clarifyOptions: res.clarifyOptions || [] } : {}),
      ...(res.answer ? { answer: res.answer } : {}),
      ...(res.followups ? { followups: res.followups } : {}),
      ...(res.cannot ? { cannot: res.cannot } : {}),
      ...(res.nothingChanged ? { nothingChanged: true } : {}),
      ...(res.nothingToChange ? { nothingToChange: true } : {}),
    };
  }

  async function finishRun(task, st, res, trace, step) {
    const { sink, cmd } = task;
    if (res.error) throw brainError(res.error);
    // круг 38: отмену/возврат brain узнаёт сам, без модели; исполняет их редактор, не агент
    if (res.action) {
      sink.send('result', editorReply());
      trace.kind = 'editor';
      return;
    }
    // «менять нечего» / «правка ни на что не повлияла» (§10.5): brain возвращает и сами
    // пустые операции — писать их в общий журнал незачем, это ответ, а не правка
    if (!res.ops || !res.ops.length || res.nothingChanged || res.nothingToChange) {
      sink.send('result', replyOf(res, 'Агент не нашёл, что изменить'));
      return;
    }
    const out = await write(task, {
      project: cmd.project, base_seq: st.seq, ops: globalizeIds(res.ops), client: cmd.client,
      title: historyTitle(res, cmd.text), command_id: cmd.command_id, command_author: cmd.author,
    }, step);
    const result = resultOf(out, res, historyTitle(res, cmd.text));
    Object.assign(trace, { tx_id: out.tx_id, seq: out.seq, ops: result.applied, dropped: result.dropped.length });
    /* Круг 47 (SPEC §14.5): решение арт-директора — в трассу при записи (роль → #rrggbb, шрифты): цвета
       образа лежат в узлах без роли, и теме на доску (круг 48) понадобится, какой hex какой роли. */
    if (result.direction) trace.art = { tx_id: out.tx_id, palette: result.direction.palette, fonts: result.direction.fonts };
    if (result.critique) trace.critique = { seen: result.critique.seen, score: result.critique.score, revised: !!result.critique.revised };
    sink.send('result', result);
  }

  async function finishVariants(task, st, list, trace, step) {
    const { sink, cmd } = task;
    const all = list.filter(Boolean);
    const act = all.find((v) => v.action === 'undo' || v.action === 'redo');
    if (act) { sink.send('result', editorReply()); trace.kind = 'editor'; return; }
    const talk = all.find((v) => v.clarify || ((v.answer || v.cannot) && (!v.ops || !v.ops.length)));
    if (talk) { sink.send('result', replyOf(talk)); return; }
    const ok = all.filter((v) => v.ops && v.ops.length && !v.error);
    if (!ok.length) {
      const bad = all.find((v) => v.error);
      if (bad) throw brainError(bad.error);
      sink.send('result', replyOf({ warnings: (all[0] && all[0].warnings) || [] }, 'Варианты ничего не меняют'));
      return;
    }
    const items = ok.map((v, i) => ({
      key: String(v.key || `v${i + 1}`),
      label: v.label || `Вариант ${i + 1}`,
      description: v.description || (v.plan && v.plan.summary) || '',
      ops: globalizeIds(v.ops),
      title: historyTitle(v, cmd.text, v.label || `Вариант ${i + 1}`),
      libraryAdded: Array.isArray(v.libraryAdded) ? v.libraryAdded : [],
      summary: (v.plan && (v.plan.summary || v.plan.title)) || '',
      warnings: (v.warnings || []).map((w) => llm.redact(w)),
    }));
    remember(cmd.command_id, {
      project: cmd.project, base_seq: st.seq, client: cmd.client, author: cmd.author, text: cmd.text, items,
      expires: Date.now() + variantsTtl,
    });
    trace.variants = items.length;
    sink.send('variants', {
      base_seq: st.seq,
      items: items.map((v) => ({
        key: v.key, label: v.label, description: v.description, ops_count: v.ops.length,
        // превью — сами операции: клиент накладывает их своим движком на свой стейт (§8.3)
        preview: { ops: v.ops, summary: v.summary, warnings: v.warnings },
      })),
    });
  }

  /**
   * Круг 27: подпись записи агента в истории — что сделано, словами по операциям (brain:
   * `changeSummary`), а не пересказ модели («Ставлю стиль h1.»). Вариант — «Вариант «…»: …».
   * Нет описания — заголовок плана, затем сама команда.
   */
  function historyTitle(res, text, variantLabel = null) {
    const done = res && typeof res.changeSummary === 'string' ? res.changeSummary.trim() : '';
    const base = done || (res && res.plan && res.plan.title) || String(text || '').trim() || DONE_FALLBACK;
    return variantLabel ? `Вариант «${cutText(String(variantLabel), 60)}»: ${base}` : base;
  }

  function remember(id, entry) {
    const now = Date.now();
    for (const [k, v] of variantSets) if (v.expires < now) variantSets.delete(k);
    variantSets.delete(id);
    variantSets.set(id, entry);
    while (variantSets.size > MAX_VARIANT_SETS) variantSets.delete(variantSets.keys().next().value);
  }

  /** Имя автора команды для `command_author`: строка, чистый текст, ≤ 200 символов; иначе ''. */
  function commandAuthorOf(v) {
    return typeof v === 'string' ? cleanText(cutText(v.trim(), 200)) : '';
  }

  /** Запись транзакции агента (шаг 12/13). */
  async function write(task, { project, base_seq, ops, client, title, command_id: commandId, command_author: commandAuthor }, step) {
    if (task.ctrl && task.ctrl.signal.aborted) throw cancelledErr();
    if (step) step('write');
    const tx = {
      tx_id: uid('tx'),
      base_seq,
      ops,
      author: AGENT_AUTHOR,
      author_kind: 'agent',
      // client — вкладка автора команды: её реплика узнаёт транзакцию как свою (§10.5)
      ...(client ? { client } : {}),
      // круг 25: команда, из которой родилась правка, — история и трассы связываются по
      // ней. Document service хранит поле до 64 знаков; длиннее (контракт /agent/command
      // допускает 128) не шлём вовсе — лучше без связи, чем отказ записи
      ...(typeof commandId === 'string' && commandId && commandId.length <= TX_COMMAND_ID_MAX ? { command_id: commandId } : {}),
      title: cleanText(cutText(String(title || ''), 200)),
      // круг 30: кто дал команду (имя из /agent/command) — история подписывает «Агент · Аня» по
      // записи, а не по памяти вкладки о присутствии; пустое — поля нет
      ...(commandAuthorOf(commandAuthor) ? { command_author: commandAuthorOf(commandAuthor) } : {}),
      engine: ENGINE_VERSION,
    };
    // с этого места «стоп» запись не отменяет: она уже ушла, повтор идёт по тому же tx_id
    return dslts.commit(project, tx, {
      // круг 27: сервис документов перезапускается — говорим, что ждём его, а не висим молча
      onWait: ({ restarting }) => {
        if (step && restarting) step('write', 'Жду сервис документов, чтобы записать правку');
      },
    });
  }

  /** Круг 39: подпись записи, если ни операции, ни план, ни команда её не дали. */
  const DONE_FALLBACK = 'Правка агента';

  /** Committed → событие result. */
  function resultOf(committed, res, title = '') {
    const plan = (res && res.plan) || {};
    const created = new Set();
    const select = [];
    for (const op of committed.ops || []) {
      if (op.op === 'create' && op.node && op.node.id) {
        created.add(op.node.id);
        if (!created.has(op.node.parent)) select.push(op.node.id);
      } else if ((op.op === 'set' || op.op === 'move') && op.id && !created.has(op.id) && !select.includes(op.id)) {
        select.push(op.id);
      }
    }
    /* Круг 39 (N5д): `title` — что сделано (подпись записи в истории, tx.title: «Нарисовал
       «Печенька»: 6 деталей»), есть всегда, когда правка записана; оболочка берёт из него
       заголовок итога. `summary` — то же «что сделано» (прежние оболочки берут заголовок из
       него), а пересказ ПЛАНА («Рисую печеньку…», написан до работы) — отдельным полем `plan`. */
    const done = cleanText(cutText(String(committed.title || title || plan.title || ''), 200)).trim() || DONE_FALLBACK;
    const planText = String(plan.summary || '').trim() || (res && typeof res.summary === 'string' ? res.summary.trim() : '');
    return {
      tx_id: committed.tx_id,
      seq: committed.seq,
      applied: (committed.ops || []).length,
      dropped: committed.dropped || [],
      title: llm.redact(done),
      summary: llm.redact(done),
      ...(planText && planText !== done ? { plan: llm.redact(cutText(planText, 500)) } : {}),
      warnings: ((res && res.warnings) || []).map((w) => llm.redact(w)),
      ...(res && res.cannot ? { cannot: res.cannot } : {}),
      // компоненты внешней библиотеки, перенесённые этой правкой в библиотеку документа (§10.6)
      ...(res && Array.isArray(res.libraryAdded) && res.libraryAdded.length ? { libraryAdded: res.libraryAdded } : {}),
      ...(select.length ? { select: select.slice(0, 50) } : {}),
      // круг 47 (SPEC §14): решение арт-директора и вердикт критика — строки через redact
      ...(res && res.direction ? { direction: artOut(res.direction) } : {}),
      ...(res && res.critique ? { critique: artOut(res.critique) } : {}),
    };
  }

  /** Решение и вердикт наружу: строки — через redact и не длиннее 300 знаков, числа и булевы — как есть. */
  function artOut(v, depth = 0) {
    if (typeof v === 'string') return llm.redact(cutText(v, 300));
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth > 3 || !v || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => artOut(x, depth + 1)).filter((x) => x !== undefined);
    const out = {};
    for (const k of Object.keys(v).slice(0, 16)) { const x = artOut(v[k], depth + 1); if (x !== undefined) out[k] = x; }
    return out;
  }

  /* ── стоп и выбор варианта ──────────────────────────────────────────── */

  /**
   * @param {string} commandId
   * @param {{shutdown?: boolean, client?: string|null}} [o] shutdown — снимает останов процесса,
   *   а не человек (круг 27, I6); client — кто просит (круг 33: HTTP всегда передаёт поле):
   *   не тот, что прислал команду, — false, как у неизвестной
   */
  function stop(commandId, o = {}) {
    const task = active.get(commandId);
    if (!task || task.ctrl.signal.aborted) return false;
    if ('client' in o && !sameClient(task.cmd.client, o.client)) return false;
    if (o.shutdown) task.shutdown = true;
    task.ctrl.abort();
    if (unqueue(task)) {
      // не начиналась: событие и done пишем сами
      const err = task.shutdown ? shuttingDownErr() : cancelledErr();
      task.sink.send('error', err.body ? stripErr(err.body()) : { code: 'cancelled', message: 'Команда остановлена', retryable: false });
      task.sink.send('done', {});
      task.sink.end();
      active.delete(commandId);
      traces.record({
        command_id: task.cmd.command_id, project: task.project, mode: task.cmd.mode, kind: task.verdict.kind,
        status: task.shutdown ? 'error' : 'cancelled', code: err.code, started_at: new Date(task.t0).toISOString(), ms: Date.now() - task.t0,
        steps: [], engine: ENGINE_VERSION,
      });
    }
    return true;
  }

  /** Круг 33: тот же клиент? Нет поля у обоих — тоже «тот же». */
  function sameClient(own, asked) {
    return (own || null) === (asked || null);
  }

  /** Тело ошибки для события `error` потока (без служебного `error: true`). */
  function stripErr(body) {
    const { error: _e, detail, ...rest } = body;
    // круг 43: безопасные поля detail — и здесь (белый список, как у события error выполняемой команды)
    const safe = safeDetail(detail);
    return safe ? { ...rest, detail: safe } : rest;
  }

  /**
   * Записать выбранный вариант. Повтор того же выбора возвращает ту же запись.
   * @param {string} commandId
   * @param {string|number} variant ключ варианта или номер (с 0)
   */
  async function apply(commandId, variant, o = {}) {
    const entry = variantSets.get(commandId);
    if (!entry || entry.expires < Date.now()) {
      variantSets.delete(commandId);
      throw notFound(VARIANTS_GONE);
    }
    // круг 33: выбрать вариант может только автор команды (тот же client) — чужой видит 404
    if ('client' in o && !sameClient(entry.client, o.client)) throw notFound(VARIANTS_GONE);
    const item = typeof variant === 'number'
      ? entry.items[variant]
      : entry.items.find((v) => v.key === variant) || (/^\d+$/.test(String(variant)) ? entry.items[Number(variant)] : undefined);
    if (!item) throw badRequest(`Нет такого варианта: ${cutText(String(variant), 40)}. Есть: ${entry.items.map((v) => v.key).join(', ')}`);
    if (entry.applied) {
      if (entry.applied.key === item.key) return entry.applied.result;
      throw badRequest(`Уже выбран вариант «${entry.applied.label}» — второй поверх него не записываю`);
    }
    if (entry.applying) {
      if (entry.applying.key === item.key) return entry.applying.promise;
      throw badRequest('Другой вариант этой команды уже записывается');
    }
    const t0 = Date.now();
    let resolve;
    let reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    promise.catch(() => {});
    entry.applying = { key: item.key, promise };
    const task = {
      id: `${commandId}#apply`, project: entry.project, ctrl: null, t0,
      run: async () => {
        const trace = {
          command_id: commandId, project: entry.project, mode: 'apply', kind: 'apply',
          started_at: new Date(t0).toISOString(), engine: ENGINE_VERSION,
        };
        try {
          const out = await write(task, {
            project: entry.project, base_seq: entry.base_seq, ops: item.ops, client: entry.client, title: item.title,
            command_id: commandId, command_author: entry.author,
          });
          const result = resultOf(out, { summary: item.summary, warnings: item.warnings, libraryAdded: item.libraryAdded }, item.title);
          entry.applied = { key: item.key, label: item.label, result };
          Object.assign(trace, { status: 'ok', tx_id: out.tx_id, seq: out.seq, ops: result.applied, dropped: result.dropped.length });
          resolve(result);
        } catch (e) {
          const err = toOrchError(e);
          Object.assign(trace, { status: 'error', code: err.code });
          reject(err);
        } finally {
          entry.applying = null;
          trace.ms = Date.now() - t0;
          trace.steps = [{ key: 'write', ms: trace.ms }];
          traces.record(trace);
        }
      },
    };
    try {
      admit(task);
    } catch (e) {
      entry.applying = null;
      throw e;
    }
    return promise;
  }

  /* ── здоровье и останов ─────────────────────────────────────────────── */

  async function health() {
    const [doc, model] = await Promise.all([docHealthDetail(), llm.health()]);
    const document = doc.document;
    return {
      // ok — сам агент отвечает; что с документами и моделью — в полях document и llm
      ok: true,
      engine: ENGINE_VERSION,
      // круг 26: id процесса и время старта — смена instance значит «перезапустился»
      instance,
      started_at: startedAt,
      llm: model.llm,
      document,
      // круг 31 (K2): почему документ недоступен — 'storage' (база сервиса) | 'unreachable';
      // круг 32 — ещё 'schema' (база догоняет схему после восстановления из копии)
      ...(document !== 'up' ? { document_reason: doc.reason || 'unreachable' } : {}),
      ...(model.model ? { model: model.model } : {}),
    };
  }

  /**
   * Перестать принимать; выполняемым — дедлайн `graceMs` (успели — записаны), потом
   * отмена и не дольше `abortWaitMs` на то, чтобы свернуться (круг 25: весь останов —
   * в 8 с, Docker убивает через 10). Ждущие в очереди отменяются сразу: начинать их
   * незачем. Возвращает, сколько команд пришлось прервать.
   * @returns {Promise<{aborted: number}>}
   */
  async function close(graceMs = SHUTDOWN_GRACE_MS, abortWaitMs = SHUTDOWN_ABORT_WAIT_MS) {
    closing = true;
    for (const t of [...active.values()]) {
      if (t.ctrl && !t.ctrl.signal.aborted && queues.get(t.project) && queues.get(t.project).waiting.includes(t)) {
        // круг 27 (I6): ждущим — shutting_down (повторяемо), а не «остановлена»
        stop(t.cmd.command_id, { shutdown: true });
      }
    }
    const all = () => [...active.values()].map((t) => t.finished).filter(Boolean);
    const wait = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); });
    await Promise.race([Promise.allSettled(all()), wait(graceMs)]);
    let aborted = 0;
    for (const t of active.values()) {
      if (t.ctrl && !t.ctrl.signal.aborted) {
        aborted++;
        log.warn(`[orchestrator] останов: команда ${t.id} не уложилась в ${graceMs} мс — прерываю`);
        t.shutdown = true;
        t.ctrl.abort();
      }
    }
    await Promise.race([Promise.allSettled(all()), wait(abortWaitMs)]);
    return { aborted };
  }

  return {
    command, stop, apply, health, close,
    get busy() { return active.size; },
    /** Для тестов и отладки. */
    queueOf: (project) => { const q = queues.get(project); return q ? { running: q.running && q.running.id, waiting: q.waiting.map((t) => t.id) } : null; },
  };
}
