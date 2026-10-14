/**
 * Imago Studio — клиент-реплика Document service (круг 22, SPEC §8.3, §9.5).
 *
 * Клиент — ПОЛНАЯ реплика с локальным журналом: свои правки применяются всегда и
 * сразу, переживают перезагрузку вкладки и досылаются при воссоединении. Сервер —
 * единственный арбитр порядка; здесь нет ни решателя, ни отрисовки, только
 * состояние и его синхронизация:
 *
 *   confirmed = {seq, doc}   что подтвердил сервер (снимок + применённые транзакции)
 *   pending   = Tx[]         свои транзакции в порядке отправки, ещё без номера
 *   view      = replay(confirmed.doc, pending) — теми же rebase + applyOps, что в DSLTS
 *
 * Поэтому клиент почти всегда угадывает, что сделает сервер, а расхождение (сервер
 * отбросил операцию) видно по `dropped` в подтверждении и пересчитывается по
 * применённой форме. Модуль не трогает DOM: он исполняется и в Node — тесты гоняют
 * его с фальшивым сервером и фальшивым сокетом (test/sync.test.mjs).
 *
 * Локальный журнал (SPEC §9.5): IndexedDB `imago`, хранилище `projects`, ключ — id
 * проекта; запись `{seq, doc, pending, tombstones, clientId, updatedAt, extra, tip,
 * epoch, mine}`. Пишется после каждого изменения, но не чаще раза в 200 мс; перед
 * уходом со страницы оболочка зовёт flush().
 *
 * Круг 23 (SPEC §9.8): якорь `tip` — chain последней подтверждённой транзакции, и
 * эпоха журнала `epoch`; оба уходят серверу при переподключении (`?since=&tip=&epoch=`).
 * Сервер, у которого журнал под этим номером другой (база откатилась из бэкапа),
 * присылает снимок; при смене эпохи сокет закрывается кодом 4410 — реплика сразу
 * переоткрывается, берёт снимок, а свою очередь — и свои транзакции, подтверждённые
 * в прежней эпохе (`mine`), — переигрывает поверх: сервер узнает уцелевшие по tx_id,
 * потерянные запишет заново. Правки не теряются.
 *
 * Круг 24 (SPEC §9.9): присутствие — сердцебиением раз в 15 с (сервер без вестей 45 с
 * объявляет `left`, присутствие ходит между экземплярами сервиса), с полями `busy` /
 * `queued` (агент работает над командой этого человека) — как их дала оболочка;
 * в адресе сокета `proto=2` — клиент знает `ack` (прежнему сервер вместо `ack` шлёт
 * `error {code:'duplicate'}`, его реплика тоже понимает).
 */

const WRITE_DELAY = 200;          // пауза между изменением и записью журнала
const PRESENCE_GAP = 100;         // присутствие — не чаще 10 раз в секунду (§9.3)
const PRESENCE_TTL = 90 * 1000;   // чужое присутствие без вестей столько — считаем ушедшим
const ACK_TIMEOUT = 8 * 1000;     // подтверждение не пришло — дослать (идемпотентно), потом переподключиться
const OPS_PAGE = 500;             // сколько транзакций просить за один GET …/ops
const HELLO_TIMEOUT = 8 * 1000;   // сокет открыт, а hello нет — это не сервер (или зомби): закрыть и подключиться заново
const MINE_KEEP = 50;             // своих подтверждённых транзакций помним столько — переиграть после отката базы
const HTTP_RETRIES = 4;           // 503/429 с Retry-After: столько повторов, потом — как сбой
const RETRY_AFTER_MAX = 30;       // Retry-After больше этого (с) не ждём — это уже не «чуть позже»
const EPOCH_REOPEN_MS = 250;      // переоткрытие после 4410 — сразу, с разбросом, чтобы вкладки не били в такт
const CLOSE_EPOCH = 4410;         // сервер: эпоха журнала сменилась (SPEC §9.8)
const CLOSE_TOO_BIG = 1009;       // ws: сообщение больше предела

/**
 * Пределы сервера (server/document/limits.js CLIENT_LIMITS — тест сверяет числа):
 * транзакцию больше этого клиент не заводит — сервер отверг бы её (413), и она
 * крутилась бы в очереди вечно.
 */
export const LIMITS = Object.freeze({
  txBytes: 4 * 1024 * 1024,
  opsPerTx: 5000,
  docBytes: 24 * 1024 * 1024,
  docNodes: 20000,
  presenceSelection: 200,        // id в выделении присутствия — больше сервер обрежет (truncated)
  presenceHeartbeatMs: 15000,    // сердцебиение присутствия: сервер считает ушедшим после 45 с тишины
});

/** Причины отброшенных операций — словами человека (SPEC §9.1 DropReason, §9.8 limit). */
export const DROP_WORDS = Object.freeze({
  removed: 'узел уже удалён',
  orphan: 'родитель удалён',
  cycle: 'перемещение создало бы цикл',
  exists: 'уже есть',
  invalid: 'правка не подошла к документу',
  doc_nodes: 'документ упёрся в предел числа узлов',
  doc_bytes: 'документ упёрся в предел размера',
  merge_budget: 'сервер не успел разобрать правку',
  ops_per_tx: 'слишком много операций в одной правке',
  tx_bytes: 'правка слишком большая',
});

/** Склонение: 1 правка, 2 правки, 5 правок. */
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/**
 * `dropped` одной строкой для человека: «3 правки не применились: узел уже удалён».
 * Запись `{more: N}` (сервер хранит не больше 50 записей и остаток числом, SPEC §9.8)
 * в перечень причин не входит, но N прибавляется к счёту.
 * @param {object[]} dropped
 * @returns {string}
 */
export function droppedLine(dropped) {
  const list = Array.isArray(dropped) ? dropped : [];
  let n = 0;
  const why = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.more === 'number' && d.index === undefined && d.reason === undefined) { n += Math.max(0, d.more); continue; }
    n += 1;
    const word = DROP_WORDS[d.limit] || DROP_WORDS[d.reason] || DROP_WORDS.invalid;
    if (!why.includes(word)) why.push(word);
  }
  const head = `${n} ${plural(n, 'правка не применилась', 'правки не применились', 'правок не применились')}`;
  return why.length ? `${head}: ${why.join(', ')}` : head;
}

/**
 * Статус реплики одной строкой (SPEC §9.5): «в сети · всё сохранено» /
 * «не в сети · N правок ждут» / «синхронизация…».
 * @param {{online:boolean, pending:number, syncing:boolean, error?:string|null}} s
 */
export function statusLine(s) {
  if (!s) return '';
  if (s.error === 'engine') return 'версия движка устарела — обновите страницу';
  if (!s.online) {
    const n = s.pending || 0;
    return n ? `не в сети · ${n} ${plural(n, 'правка ждёт', 'правки ждут', 'правок ждут')}` : 'не в сети';
  }
  if (s.syncing) return 'синхронизация…';
  return 'в сети · всё сохранено';
}

/** Пауза с разбросом: половина — фиксированная, половина — случайная (вкладки не бьют в такт). */
function jitter(ms) {
  return Math.round(ms * (0.5 + Math.random() * 0.5));
}

/** Retry-After из ответа (заголовок или поле тела), с; нет — null. */
function retryAfterOf(res, body) {
  let v = null;
  try { v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch { v = null; }
  if (v == null && body && typeof body === 'object') v = body.retry_after;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, RETRY_AFTER_MAX) : null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** busy/queued присутствия (§9.9): булево или число. */
const isFlag = (v) => typeof v === 'boolean' || isNum(v);

/** Глубокая копия JSON-совместимых данных: операции и документ наружу и внутрь не делим. */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Надгробия в форме для журнала и обратно: Map не переживает JSON. */
function tombToList(map) {
  const out = [];
  for (const [id, parent] of map) out.push([id, parent === undefined ? null : parent]);
  return out;
}
function tombFromList(list) {
  const m = new Map();
  if (Array.isArray(list)) for (const pair of list) if (Array.isArray(pair) && pair[0]) m.set(String(pair[0]), pair[1] == null ? null : String(pair[1]));
  return m;
}

/* ------------------------------ хранилища ------------------------------ */

/**
 * Локальный журнал в IndexedDB — для браузера. База `imago`, хранилище `projects`,
 * ключ — id проекта. Все методы возвращают промисы; ошибки (приватный режим,
 * переполнение) наружу не летят дальше промиса — реплика без журнала продолжает
 * работать, просто не переживёт перезагрузку.
 * @param {{name?: string, store?: string, indexedDB?: IDBFactory}} [opts]
 */
export function idbStorage(opts = {}) {
  const name = opts.name || 'imago';
  const store = opts.store || 'projects';
  const factory = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  let dbp = null;
  const openDb = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('IndexedDB недоступна')); return; }
      let req;
      try { req = factory.open(name, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB не открылась'));
      req.onblocked = () => reject(new Error('IndexedDB занята другой вкладкой'));
    });
    // не открылась — следующий вызов попробует снова, а не получит тот же отказ навсегда
    dbp.catch(() => { dbp = null; });
    return dbp;
  };
  const run = (mode, fn) => openDb().then((db) => new Promise((resolve, reject) => {
    let req = null;
    let tx;
    try {
      tx = db.transaction(store, mode);
      req = fn(tx.objectStore(store));
    } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('запись в IndexedDB не прошла'));
    tx.onabort = () => reject(tx.error || new Error('запись в IndexedDB прервана'));
  }));
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    remove: (key) => run('readwrite', (s) => s.delete(key)),
    keys: () => run('readonly', (s) => s.getAllKeys()),
  };
}

/** Журнал в памяти — для тестов и как запасной вариант, когда IndexedDB нет. */
export function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? clone(map.get(key)) : null),
    set: async (key, value) => { map.set(key, clone(value)); },
    remove: async (key) => { map.delete(key); },
    keys: async () => [...map.keys()],
  };
}

/* -------------------------------- реплика -------------------------------- */

/**
 * @param {object} o
 * @param {object} o.core           модуль движка (`import * as CORE from './core.js'`)
 * @param {string} [o.baseUrl]      корень API; '' — тот же origin (`/api`, `/ws`)
 * @param {string} o.projectId
 * @param {string} o.clientId       id вкладки-браузера: по нему свои транзакции отличаются в рассылке
 * @param {string} [o.author]       отображаемое имя
 * @param {object} [o.storage]      адаптер журнала (idbStorage / memoryStorage)
 * @param {Function} [o.WebSocketImpl]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.onChange]   (view, info) — view изменился не по своему commit: open · confirmed · remote · gone · error · ack
 * @param {Function} [o.onStatus]   ({online, pending, syncing, error, head, label})
 * @param {Function} [o.onDropped]  (committed) — сервер отбросил часть операций своей транзакции
 * @param {Function} [o.onPresence] (list) — кто в сети с их выделениями
 * @param {Function} [o.onGone]     (snapshot) — база ушла за хвост: пришёл снимок
 * @param {Function} [o.onError]    ({code, message, tx?}) — code: engine · not-found · diverged · too_large · коды сервера
 * @param {Function} [o.extra]      () => object — что оболочка кладёт в журнал рядом с документом
 * @param {number} [o.reconnectMin] пауза перед первым переподключением, мс (1000)
 * @param {number} [o.reconnectMax] потолок паузы, мс (30000)
 * @param {number} [o.epochReopenMs] переоткрытие после 4410 (смена эпохи) — через столько мс с разбросом вниз до половины (250)
 */
export function createSync(o) {
  const core = o.core;
  if (!core || typeof core.rebase !== 'function' || typeof core.applyOps !== 'function') {
    throw new Error('createSync: нужен модуль движка с rebase и applyOps');
  }
  const projectId = String(o.projectId || '');
  const clientId = String(o.clientId || core.uid('c'));
  let author = String(o.author || '');
  const storage = o.storage || null;
  const WS = o.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const baseUrl = String(o.baseUrl || '').replace(/\/+$/, '');
  const reconnectMin = isNum(o.reconnectMin) ? o.reconnectMin : 1000;
  const reconnectMax = isNum(o.reconnectMax) ? o.reconnectMax : 30000;
  const epochReopenMs = isNum(o.epochReopenMs) ? o.epochReopenMs : EPOCH_REOPEN_MS;
  const heartbeatMs = isNum(o.presenceHeartbeatMs) ? o.presenceHeartbeatMs : LIMITS.presenceHeartbeatMs;
  const presenceTtl = isNum(o.presenceTtl) ? o.presenceTtl : PRESENCE_TTL;
  const setT = (fn, ms) => {
    const id = setTimeout(fn, ms);
    // в Node таймер держит процесс: тесты не должны ждать паузу переподключения
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  };

  /* ---- состояние ---- */
  let confirmed = { seq: 0, doc: null };
  let tomb = new Map();        // надгробия подтверждённых: id удалённого → последний родитель
  let pending = [];            // Tx[] в порядке отправки
  let view = null;
  let viewTomb = new Map();    // надгробия подтверждённых + ожидающих (для прогноза следующей правки)
  let extraLoaded = undefined; // что лежало в журнале рядом с документом

  let socket = null;
  let online = false;
  let closed = false;
  let opened = false;
  let helloHead = -1;          // голова по последнему hello: пока не догнали — «синхронизация…»
  let ready = false;           // hello получен: сервер до него ничего не принимает (Hub), и «в сети» — только с него
  let helloTimer = null;
  let openRetry = null;        // ожидание повтора в open() без сервера — reconnect() будит его раньше срока
  let inflight = null;         // tx_id отправленной и ещё не подтверждённой транзакции
  let inflightTimer = null;
  let inflightRetries = 0;
  let attempt = 0;             // неудачных подключений подряд — для паузы
  let reconnectTimer = null;
  let halted = false;          // сервер отверг версию движка: слать дальше бессмысленно
  let error = null;            // 'engine' | 'unreachable' | 'not-found' | 'diverged' | null

  let tip = null;              // chain подтверждённой головы (SPEC §9.8); null — сервер его не дал
  let epoch = null;            // эпоха журнала, в которой получено confirmed
  let epochMoved = false;      // hello принёс другую эпоху — снимок, который придёт следом, требует переиграть mine
  let mine = [];               // свои подтверждённые: [{tx, seq, epoch}] — переигрываются после отката базы
  let serverWait = 0;          // сервер попросил подождать (Retry-After), мс — пауза переподключения не меньше
  let resendTimer = null;      // повтор отправки после повторяемой ошибки

  let catchingUp = false;      // идёт GET …/ops: живые транзакции копим в буфер
  let buffer = [];

  let writeTimer = null;
  let dirty = false;
  let writing = null;

  // последнее своё присутствие: уходит при подключении (так о нас узнают остальные) и при
  // смене имени; пустое выделение — тоже присутствие
  let presenceLast = { selection: [], board: null };
  let presenceTimer = null;
  let heartbeatTimer = null;   // сердцебиение присутствия (и уборка протухших чужих)
  let presenceSentAt = 0;
  let presenceSentKey = '';    // что ушло последним: то же самое второй раз не шлём
  const others = new Map();    // client → {client, author, selection, board, at}

  let lastStatus = '';

  /* ---- служебное ---- */

  const call = (fn, ...args) => {
    // закрытая реплика молчит: оболочка уже открыла другой проект, и её колбэки — про него
    if (closed || typeof fn !== 'function') return;
    try { fn(...args); } catch (e) { report('callback', e); }
  };
  function report(where, e) {
    // ошибки подписчиков и транспорта — в консоль, но не наружу: реплика важнее одного колбэка
    try { console.error(`[sync:${where}]`, e); } catch { /* консоли нет */ }
  }

  function status() {
    return {
      online,
      pending: pending.length,
      syncing: online && !halted && (catchingUp || pending.length > 0 || confirmed.seq < helloHead),
      error,
      head: confirmed.seq,
    };
  }
  function statusFull() {
    const s = status();
    return { ...s, label: statusLine(s) };
  }
  function emitStatus() {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastStatus) return;
    lastStatus = key;
    call(o.onStatus, statusFull());
  }

  /* ---- переигрывание: view = replay(confirmed.doc, pending) ---- */

  function replayAll() {
    const t = new Map(tomb);
    let doc = confirmed.doc;
    for (const tx of pending) {
      const m = core.rebase(doc, tx.ops, { tombstones: t });
      for (const [id, p] of core.collectTombstones(doc, m.ops)) t.set(id, p);
      const res = core.applyOps(doc, m.ops);
      if (!res.error) doc = res.doc;
      else report('replay', res.error);
    }
    view = doc;
    viewTomb = t;
  }

  /** Применённая транзакция сервера — к confirmed. Журнал хранит применённую форму, строгий applyOps обязан пройти. */
  function applyConfirmed(c) {
    const before = confirmed.doc;
    let res = core.applyOps(before, c.ops);
    if (res.error) {
      /* Не прошло — движки разошлись (версия, формат). Страховка: слить как чужую базу,
         чтобы не отстать от сервера навсегда; о расхождении — наружу. */
      report('apply', res.error);
      const m = core.rebase(before, c.ops, { tombstones: tomb });
      res = core.applyOps(before, m.ops);
      error = 'diverged';
      call(o.onError, { code: 'diverged', message: 'транзакция сервера не применилась к реплике: ' + (res.error ? res.error.message : ''), tx: c });
    }
    for (const [id, p] of core.collectTombstones(before, c.ops)) tomb.set(id, p);
    confirmed = { seq: c.seq, doc: res.error ? before : res.doc };
    tip = typeof c.chain === 'string' && c.chain ? c.chain : null;
    return before;
  }

  function hashOf(doc) {
    try { return core.hashDoc(doc); } catch { return ''; }
  }

  /* ---- локальный журнал ---- */

  function record() {
    let extra;
    try { extra = typeof o.extra === 'function' ? o.extra() : undefined; } catch (e) { report('extra', e); }
    return {
      seq: confirmed.seq, doc: confirmed.doc, pending,
      tombstones: tombToList(tomb), clientId, updatedAt: Date.now(),
      tip, epoch, mine,
      ...(extra !== undefined ? { extra } : {}),
    };
  }
  function scheduleWrite() {
    dirty = true;
    if (!storage || writeTimer) return;
    writeTimer = setT(() => { writeTimer = null; writeNow(); }, WRITE_DELAY);
  }
  function writeNow() {
    if (!storage || !dirty || !confirmed.doc) return writing || Promise.resolve();
    dirty = false;
    let p;
    try { p = Promise.resolve(storage.set(projectId, record())); } catch (e) { p = Promise.reject(e); }
    writing = p.catch((e) => { report('journal', e); }).then(() => { writing = null; });
    return writing;
  }
  /** Записать журнал сейчас — перед уходом со страницы. Возвращает промис записи. */
  function flush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    const p = writeNow();
    if (storage && typeof storage.flush === 'function') { try { storage.flush(); } catch { /* адаптер без сброса */ } }
    return p;
  }

  /* ---- HTTP ---- */

  async function httpOnce(path, init) {
    if (!fetchImpl) throw new Error('fetch недоступен');
    const res = await fetchImpl(baseUrl + path, { ...(init || {}), headers: { 'content-type': 'application/json', 'x-author': encodeURIComponent(author || ''), ...((init && init.headers) || {}) } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body, retryAfter: retryAfterOf(res, body) };
  }

  /**
   * Запрос с уважением к перегрузке: 503/429 → ждать Retry-After (с разбросом) и
   * повторить, не больше HTTP_RETRIES раз; дальше — ответ как есть.
   */
  async function http(path, init) {
    let r = await httpOnce(path, init);
    for (let i = 0; i < HTTP_RETRIES && (r.status === 503 || r.status === 429) && !closed; i++) {
      // Retry-After — не раньше срока (плюс разброс до половины); без него — экспонента с разбросом
      const wait = r.retryAfter != null ? r.retryAfter * 1000 : reconnectMin * Math.pow(2, i);
      const delay = r.retryAfter != null ? wait + Math.random() * wait * 0.5 : jitter(wait);
      // ожидание, которое кто-то ждёт (await), — обычный таймер: его держать в Node можно
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay)));
      r = await httpOnce(path, init);
    }
    return r;
  }

  /** Запрос `?since=…` с якорем: tip и эпоха, если известны. */
  function anchorQuery() {
    return (tip ? `&tip=${encodeURIComponent(tip)}` : '') + (epoch ? `&epoch=${encodeURIComponent(epoch)}` : '');
  }

  /** Снимок + хвост с сервера → confirmed (очередь переигрывается поверх). */
  async function loadFromServer() {
    const r = await http(`/api/projects/${encodeURIComponent(projectId)}`);
    if (r.status === 404) { error = 'not-found'; emitStatus(); call(o.onError, { code: 'not-found', message: 'проект не найден' }); return false; }
    if (!r.ok || !r.body || !r.body.snapshot || !r.body.snapshot.doc) throw new Error(`GET /api/projects: ${r.status}`);
    const moved = !!(epoch && typeof r.body.epoch === 'string' && r.body.epoch !== epoch);
    adoptSnapshot(r.body.snapshot, r.body.tail, r.body.epoch);
    if (moved) requeueMine();
    return true;
  }

  /** Снимок как confirmed, надгробия с нуля, хвост — по порядку, своя очередь — поверх. */
  function adoptSnapshot(snapshot, tail, nextEpoch) {
    confirmed = { seq: isNum(snapshot.seq) ? snapshot.seq : 0, doc: snapshot.doc };
    tip = typeof snapshot.chain === 'string' && snapshot.chain ? snapshot.chain : null;
    if (typeof nextEpoch === 'string' && nextEpoch) epoch = nextEpoch;
    tomb = new Map();
    const list = Array.isArray(tail) ? tail.slice().sort((a, b) => a.seq - b.seq) : [];
    for (const c of list) if (isNum(c.seq) && c.seq > confirmed.seq) takeCommitted(c, { silent: true });
    replayAll();
    scheduleWrite();
  }

  /** Пропуск в номерах: догоняем по HTTP, живой поток копим в буфер. */
  async function catchUp() {
    if (catchingUp) return;
    catchingUp = true;
    emitStatus();
    try {
      let guard = 0;
      while (guard++ < 100) {
        const r = await http(`/api/projects/${encodeURIComponent(projectId)}/ops?since=${confirmed.seq}&limit=${OPS_PAGE}${anchorQuery()}`);
        if (r.status === 410 && r.body && r.body.snapshot) {
          gone(r.body.snapshot, r.body.head_seq, r.body.epoch);
          if (!(isNum(r.body.head_seq) && r.body.head_seq > confirmed.seq)) break;
          continue;
        }
        if (!r.ok || !r.body) throw new Error(`GET …/ops: ${r.status}`);
        const txs = Array.isArray(r.body.txs) ? r.body.txs.slice().sort((a, b) => a.seq - b.seq) : [];
        for (const c of txs) if (isNum(c.seq) && c.seq > confirmed.seq) takeCommitted(c);
        const head = isNum(r.body.head_seq) ? r.body.head_seq : confirmed.seq;
        // страница ограничена байтами: `more` — за ней есть ещё (SPEC §9.8)
        if (!txs.length || (confirmed.seq >= head && !r.body.more)) break;
      }
    } catch (e) {
      report('catchUp', e);
      // догнать не вышло — сокет рано или поздно переподключится с since = confirmed.seq
      if (socket) { try { socket.close(); } catch { /* уже закрыт */ } }
    } finally {
      catchingUp = false;
      const held = buffer;
      buffer = [];
      for (const c of held) handleTx(c);
      emitStatus();
    }
  }

  function gone(snapshot, headSeq, nextEpoch) {
    if (!snapshot || !snapshot.doc) return;
    const moved = epochMoved || !!(epoch && typeof nextEpoch === 'string' && nextEpoch && nextEpoch !== epoch);
    epochMoved = false;
    adoptSnapshot(snapshot, [], nextEpoch);
    // база откатилась: свои транзакции прежней эпохи могли пропасть вместе с ней — переиграть
    if (moved) requeueMine();
    call(o.onGone, snapshot);
    call(o.onChange, view, { reason: 'gone', head: headSeq });
    emitStatus();
  }

  /* ---- транзакции сервера ---- */

  function handleTx(c) {
    if (!c || !isNum(c.seq)) return;
    if (catchingUp) { buffer.push(c); return; }
    if (c.seq <= confirmed.seq) return;               // уже есть (повтор после переподключения)
    if (c.seq > confirmed.seq + 1) {                  // пропуск: догоняем по HTTP (§9.3)
      buffer.push(c);
      catchUp();
      return;
    }
    takeCommitted(c);
    if (helloHead >= 0 && confirmed.seq >= helloHead) emitStatus();
  }

  /**
   * Зафиксированная транзакция с номером confirmed.seq + 1. Своя (по tx_id) — это
   * подтверждение: уходит из очереди, confirmed = apply(confirmed, tx.ops), следующая
   * отправляется. Чужая — к confirmed, очередь переигрывается поверх.
   */
  function takeCommitted(c, opts = {}) {
    const i = pending.findIndex((p) => p.tx_id === c.tx_id);
    const before = applyConfirmed(c);
    if (i >= 0) {
      const own = pending.splice(i, 1)[0];
      if (inflight === c.tx_id) clearInflight();
      rememberMine(own, c.seq);
      const prevHash = opts.silent ? '' : hashOf(view);
      replayAll();
      scheduleWrite();
      emitStatus();
      if (opts.silent) return;
      let inverse = [];
      try { inverse = core.invertOps(before, c.ops); } catch (e) { report('invert', e); }
      if (Array.isArray(c.dropped) && c.dropped.length) call(o.onDropped, c);
      call(o.onChange, view, { reason: 'confirmed', tx: c, inverse, same: prevHash !== '' && prevHash === hashOf(view) });
      sendNext();
      return;
    }
    replayAll();
    scheduleWrite();
    if (!opts.silent) call(o.onChange, view, { reason: 'remote', tx: c, mine: !!c.client && c.client === clientId });
  }

  /** Своя подтверждённая — в mine (последние MINE_KEEP): после отката базы её переиграют. */
  function rememberMine(tx, seq) {
    if (!tx || !tx.tx_id) return;
    mine = mine.filter((m) => m.tx.tx_id !== tx.tx_id);
    mine.push({ tx, seq, epoch });
    if (mine.length > MINE_KEEP) mine = mine.slice(-MINE_KEEP);
  }

  /**
   * Эпоха сменилась и пришёл снимок: свои транзакции, подтверждённые в прежней
   * эпохе, встают в начало очереди (в порядке seq). Уцелевшие сервер узнает по
   * tx_id и ответит сохранённым (`ack` или `tx`), потерянные запишет заново.
   */
  function requeueMine() {
    const back = mine.filter((m) => m.epoch !== epoch && !pending.some((p) => p.tx_id === m.tx.tx_id))
      .sort((a, b) => a.seq - b.seq);
    if (!back.length) return;
    mine = mine.filter((m) => !back.includes(m));
    if (inflight) clearInflight();
    pending = [...back.map((m) => m.tx), ...pending];
    replayAll();
    scheduleWrite();
  }

  /* ---- отправка ---- */

  function clearInflight() {
    inflight = null;
    inflightRetries = 0;
    if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
  }

  /** Повторяемая ошибка сервера: отправить ещё раз позже (Retry-After, с разбросом). */
  function scheduleResend(ms) {
    if (resendTimer) return;
    resendTimer = setT(() => { resendTimer = null; sendNext(); }, jitter(Math.max(ms, reconnectMin)));
  }

  function socketOpen() {
    return !!socket && socket.readyState === 1;
  }

  function sendJson(msg) {
    if (!socketOpen()) return false;
    try { socket.send(JSON.stringify(msg)); return true; } catch (e) { report('send', e); return false; }
  }

  /** pending[0] уходит, как только сокет открыт и ничего не в полёте (§9.5). */
  function sendNext() {
    if (halted || inflight || resendTimer || !pending.length || !socketOpen() || !ready) return;
    const tx = pending[0];
    if (!sendJson({ type: 'tx', tx })) return;
    inflight = tx.tx_id;
    armInflight();
  }

  /** Подтверждение не пришло вовремя: дослать (tx_id идемпотентен), потом переподключиться. */
  function armInflight() {
    if (inflightTimer) clearTimeout(inflightTimer);
    inflightTimer = setT(() => {
      inflightTimer = null;
      if (!inflight) return;
      if (inflightRetries < 1 && socketOpen()) {
        inflightRetries += 1;
        const tx = pending.find((p) => p.tx_id === inflight);
        if (tx && sendJson({ type: 'tx', tx })) { armInflight(); return; }
      }
      // сокет молчит: закрываем сами — onclose назначит переподключение
      if (socket) { try { socket.close(); } catch { /* уже закрыт */ } }
    }, ACK_TIMEOUT);
  }

  /* ---- сокет ---- */

  function wsUrl() {
    // имя — и в query: браузер не ставит заголовков при upgrade, а Hub подписывает им присутствие
    const q = `project=${encodeURIComponent(projectId)}&since=${confirmed.seq}&client=${encodeURIComponent(clientId)}`
      + (author ? `&author=${encodeURIComponent(author)}` : '') + anchorQuery() + '&proto=2';
    if (/^wss?:/i.test(baseUrl)) return `${baseUrl}/ws?${q}`;
    if (/^https?:/i.test(baseUrl)) return `${baseUrl.replace(/^http/i, 'ws')}/ws?${q}`;
    if (typeof location !== 'undefined' && location.host) {
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${baseUrl}/ws?${q}`;
    }
    return `ws://localhost${baseUrl}/ws?${q}`;
  }

  function connect() {
    if (closed || !WS) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    let ws;
    try { ws = new WS(wsUrl()); } catch (e) { report('connect', e); scheduleReconnect(); return; }
    socket = ws;
    ready = false;
    ws.onopen = () => {
      if (ws !== socket) return;
      helloHead = -1;
      /* Открытый сокет — ещё не сервер: Hub до hello сообщения не принимает, а прокси
         может принять соединение и без живого сервера за спиной. Поэтому «в сети»,
         отправка очереди и присутствие ждут hello; не пришёл за HELLO_TIMEOUT — закрываем
         сами, переподключение назначит onclose. */
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = setT(() => {
        helloTimer = null;
        if (ws === socket && !ready) { try { ws.close(); } catch { /* уже закрыт */ } }
      }, HELLO_TIMEOUT);
    };
    ws.onmessage = (ev) => {
      if (ws !== socket) return;
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { msg = null; }
      if (msg && typeof msg === 'object') handleMessage(msg);
    };
    ws.onerror = () => { /* за ошибкой всегда идёт close — там и решаем */ };
    ws.onclose = (ev) => {
      if (ws !== socket) return;
      socket = null;
      const code = ev && isNum(ev.code) ? ev.code : 0;
      const lost = inflight;
      dropSocketState();
      if (code === CLOSE_TOO_BIG && lost) dropTooBig(lost);
      if (closed) return;
      if (code === CLOSE_EPOCH) {
        // эпоха журнала сменилась: переоткрыться сразу — снимок придёт по сокету (since/tip не сойдутся)
        epochMoved = true;
        attempt = 0;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, jitter(epochReopenMs));
        return;
      }
      scheduleReconnect();
    };
  }

  /** Сокет потерян: не в сети, ничего не в полёте, чужое присутствие протухло вместе с ним. */
  function dropSocketState() {
    online = false;
    ready = false;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    stopHeartbeat();
    clearInflight();
    if (others.size) { others.clear(); emitPresence(); }
    emitStatus();
  }

  /**
   * Транзакция больше предела сокета (ws закрыл его кодом 1009): повтор ничего не
   * изменит — снимаем с очереди и говорим (иначе она крутилась бы вечно).
   */
  function dropTooBig(txId) {
    const i = pending.findIndex((p) => p.tx_id === txId);
    if (i < 0) return;
    const tx = pending.splice(i, 1)[0];
    replayAll();
    scheduleWrite();
    call(o.onChange, view, { reason: 'error', tx });
    call(o.onError, { code: 'too_large', message: 'правка слишком большая — сервер её не примет', tx });
    emitStatus();
  }

  /**
   * Экспоненциальная пауза с разбросом: 1 с → 2 → 4 … → 30 с, не меньше, чем
   * просил сервер (Retry-After). Сбрасывается по hello.
   */
  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const base = Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(attempt, 12)));
    const delay = Math.max(jitter(base), serverWait);
    serverWait = 0;
    attempt += 1;
    reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, delay);
  }

  /**
   * Повтор уже записанной транзакции, которую этот сокет уже видел (SPEC §9.8 `ack`,
   * §9.9 `error duplicate`): если она в confirmed — снять с очереди; если впереди —
   * придёт кадром tx.
   */
  function takeAck(msg) {
    const i = msg.tx_id ? pending.findIndex((p) => p.tx_id === msg.tx_id) : -1;
    if (i >= 0 && isNum(msg.seq) && msg.seq <= confirmed.seq && !catchingUp) {
      const own = pending.splice(i, 1)[0];
      if (inflight === own.tx_id) clearInflight();
      rememberMine(own, msg.seq);
      replayAll();
      scheduleWrite();
      emitStatus();
      call(o.onChange, view, { reason: 'ack', tx: own, seq: msg.seq });
      sendNext();
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello': {
        attempt = 0;
        ready = true;
        online = true;
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        helloHead = isNum(msg.head_seq) ? msg.head_seq : -1;
        serverWait = 0;
        if (typeof msg.epoch === 'string' && msg.epoch) {
          // другая эпоха: если следом придёт снимок (hello.gone) — свои транзакции прежней эпохи
          // переигрываются, эпоха меняется со снимком; если хвост (tip сошёлся) — подтверждённое
          // цело: эпоха новая сразу, свои подтверждённые числятся за ней
          if (epoch && msg.epoch !== epoch) epochMoved = true;
          if (msg.gone !== true) {
            if (epochMoved && msg.gone === false) { epochMoved = false; for (const m of mine) m.epoch = msg.epoch; }
            epoch = msg.epoch;
          }
        }
        // сервер ответил — «недоступен» и «разошлись» больше не про него; отказ по версии остаётся
        if (!halted) error = null;
        if (isNum(msg.engine) && msg.engine !== core.ENGINE_VERSION) {
          halted = true;
          error = 'engine';
          call(o.onError, { code: 'engine', message: 'версия движка на сервере другая — обновите страницу', engine: msg.engine });
        }
        // журнал впереди сервера (базу пересоздали): своя копия ничего не стоит — берём снимок.
        // Сервер круга 23 (с эпохой) сам пришлёт gone — второй снимок по HTTP не нужен
        if (helloHead >= 0 && helloHead < confirmed.seq && typeof msg.epoch !== 'string') {
          loadFromServer().then(() => {
            call(o.onChange, view, { reason: 'gone', head: helloHead });
            emitStatus();
          }).catch((e) => report('resync', e));
        }
        emitStatus();
        // очередь и присутствие — только теперь: до hello Hub их выбрасывает
        sendNext();
        sendPresence();
        startHeartbeat();
        break;
      }
      case 'tx':
        // (прежний сервер без hello.gone) после hello с новой эпохой пошёл хвост, а не снимок
        if (epochMoved && ready) { epochMoved = false; for (const m of mine) m.epoch = epoch; }
        handleTx(msg.tx);
        break;
      case 'ack':
        takeAck(msg);
        break;
      case 'gone':
        if (!ready) { ready = true; online = true; if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; } }
        if (inflight) clearInflight();   // очередь досылается с начала поверх снимка
        gone(msg.snapshot, msg.head_seq, msg.epoch);
        if (isNum(msg.head_seq) && msg.head_seq > confirmed.seq) catchUp();
        else sendNext();
        break;
      case 'error': {
        const code = String(msg.code || 'error');
        // эпоха сменилась — следом сервер закроет сокет кодом 4410, реплика переоткроется сама
        if (code === 'epoch') { epochMoved = true; break; }
        // «уже записана» (сервер считает клиента прежним, §9.9) — то же, что ack
        if (code === 'duplicate' && msg.existing === true) { takeAck(msg); break; }
        const i = msg.tx_id ? pending.findIndex((p) => p.tx_id === msg.tx_id) : -1;
        const tx = i >= 0 ? pending[i] : null;
        if (/engine|426/i.test(code)) { halted = true; error = 'engine'; }
        // прежний сервер не говорил retryable — тогда судим по коду
        const retryable = typeof msg.retryable === 'boolean' ? msg.retryable : /unavailable|busy|internal|timeout/i.test(code);
        const wait = isNum(msg.retry_after) ? Math.min(msg.retry_after, RETRY_AFTER_MAX) * 1000 : 0;
        if (retryable && !halted) {
          // сервер занят или хранилище недоступно: транзакция остаётся в очереди и уйдёт позже
          serverWait = Math.max(serverWait, wait);
          if (tx && inflight === tx.tx_id) clearInflight();
          if (tx) scheduleResend(wait || reconnectMin);
          emitStatus();
          break;
        }
        if (tx && !halted) {
          // форма транзакции негодна — повтор ничего не изменит: снимаем её с очереди
          pending.splice(i, 1);
          if (inflight === tx.tx_id) clearInflight();
          replayAll();
          scheduleWrite();
          call(o.onChange, view, { reason: 'error', tx });
        }
        call(o.onError, { code, message: String(msg.message || ''), tx });
        emitStatus();
        sendNext();
        break;
      }
      case 'presence': {
        if (!msg.client || msg.client === clientId) break;
        // новичок объявился — ответим своим присутствием, иначе он о нас не узнает,
        // пока мы что-нибудь не выделим (сервер списка присутствующих не хранит)
        const newcomer = !others.has(String(msg.client));
        const entry = {
          client: String(msg.client),
          author: String(msg.author || ''),
          selection: Array.isArray(msg.selection) ? msg.selection.filter((x) => typeof x === 'string').slice(0, LIMITS.presenceSelection) : [],
          board: typeof msg.board === 'string' ? msg.board : null,
          // время получения: часы сервера и вкладки не сверены, а TTL считается здесь
          at: Date.now(),
        };
        if (msg.truncated === true) entry.truncated = true;
        if (isFlag(msg.busy)) entry.busy = msg.busy;
        if (isFlag(msg.queued)) entry.queued = msg.queued;
        others.set(String(msg.client), entry);
        emitPresence();
        if (newcomer) presence(presenceLast, true);
        break;
      }
      case 'left':
        if (msg.client && others.delete(String(msg.client))) emitPresence();
        break;
      default:
        break;
    }
  }

  /* ---- присутствие ---- */

  /** Чужие без вестей дольше TTL — ушли (сервер скажет left сам; это — на случай, если не сказал). */
  function sweepOthers() {
    const now = Date.now();
    let changed = false;
    for (const [k, p] of others) if (now - p.at > presenceTtl) { others.delete(k); changed = true; }
    return changed;
  }

  function emitPresence() {
    sweepOthers();
    call(o.onPresence, [...others.values()].map((p) => ({ ...p, selection: p.selection.slice() })));
  }

  function sendPresence() {
    if (!presenceLast || !socketOpen() || !ready) return;
    presenceSentAt = Date.now();
    presenceSentKey = JSON.stringify([presenceLast, author]);
    const msg = { type: 'presence', selection: presenceLast.selection, board: presenceLast.board, author };
    if (isFlag(presenceLast.busy)) msg.busy = presenceLast.busy;
    if (isFlag(presenceLast.queued)) msg.queued = presenceLast.queued;
    sendJson(msg);
  }

  /**
   * Сердцебиение: своё присутствие — раз в heartbeatMs, даже если не менялось (сервер
   * без вестей 45 с объявляет нас ушедшими); заодно уборка протухших чужих.
   */
  function startHeartbeat() {
    stopHeartbeat();
    if (!(heartbeatMs > 0)) return;
    const beat = () => {
      heartbeatTimer = setT(beat, heartbeatMs);
      if (Date.now() - presenceSentAt >= heartbeatMs * 0.9 && !presenceTimer) sendPresence();
      if (sweepOthers()) emitPresence();
    };
    heartbeatTimer = setT(beat, heartbeatMs);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  }

  /**
   * Своё выделение и доска — эфемерно, не чаще 10 раз в секунду; последнее всегда доходит.
   * Оболочка зовёт это на каждой перерисовке, поэтому то же самое, что уже ушло, не шлём.
   */
  function presence(p, force = false) {
    const next = {
      selection: Array.isArray(p && p.selection) ? p.selection.filter((x) => typeof x === 'string').slice(0, LIMITS.presenceSelection) : [],
      board: p && typeof p.board === 'string' ? p.board : null,
    };
    // агент работает над командой этого человека (§9.9): как дала оболочка — булево или число
    if (p && isFlag(p.busy)) next.busy = p.busy;
    if (p && isFlag(p.queued)) next.queued = p.queued;
    if (!force && !presenceTimer && JSON.stringify([next, author]) === presenceSentKey) return;
    presenceLast = next;
    if (presenceTimer) return;
    const wait = PRESENCE_GAP - (Date.now() - presenceSentAt);
    if (wait <= 0) { sendPresence(); return; }
    presenceTimer = setT(() => { presenceTimer = null; sendPresence(); }, wait);
  }

  /* ---- своя правка ---- */

  /**
   * Своя транзакция: применяется к view сразу (оптимистично), встаёт в очередь,
   * пишется в журнал и уходит на сервер, если сокет открыт и ничего не в полёте.
   * Операции с несуществующими узлами (кто-то успел удалить) отбрасываются уже здесь
   * теми же правилами, что на сервере, — это прогноз; окончательный ответ в подтверждении.
   * @returns {{tx: object|null, view: object, applied: object[], dropped: object[]}}
   */
  function commit(opsList, meta = {}) {
    const list = clone(Array.isArray(opsList) ? opsList : opsList ? [opsList] : []).filter((op) => op && typeof op === 'object');
    if (!view) return { tx: null, view, applied: [], dropped: list.map((op, index) => ({ index, op, reason: 'invalid' })) };
    for (const op of list) {
      // id создаваемых узлов чеканит клиент (§8.3): без него сервер и мы выдали бы разные
      if (op.op === 'create' && op.node && typeof op.node === 'object' && !op.node.id) op.node.id = core.uid(op.node.type === 'frame' ? 'f' : 'n');
    }
    // пределы сервера (SPEC §9.8): больше — сервер отверг бы целиком, и очередь встала бы
    const refuse = (limit, message) => {
      call(o.onError, { code: 'too_large', message, limit });
      return { tx: null, view, applied: [], dropped: list.map((op, index) => ({ index, op, reason: 'invalid', limit })) };
    };
    if (list.length > LIMITS.opsPerTx) return refuse('ops_per_tx', `в одной правке больше ${LIMITS.opsPerTx} операций — сервер её не примет`);
    let sendList = list;
    let m = core.rebase(view, list, { tombstones: viewTomb });
    let res = m.ops.length ? core.applyOps(view, m.ops) : { doc: view };
    // документ упёрся бы в предел узлов: как на сервере — остаются только remove
    const nodesOf = (d) => (d && d.nodes ? Object.keys(d.nodes).length : 0);
    if (!res.error && nodesOf(res.doc) > LIMITS.docNodes && nodesOf(res.doc) > nodesOf(view)) {
      const extra = [];
      sendList = [];
      list.forEach((op, index) => {
        if (op.op === 'remove') sendList.push(op);
        else extra.push({ index, op, reason: 'invalid', limit: 'doc_nodes' });
      });
      m = core.rebase(view, sendList, { tombstones: viewTomb });
      m = { ...m, dropped: [...extra, ...m.dropped] };
      res = m.ops.length ? core.applyOps(view, m.ops) : { doc: view };
    }
    if (!m.ops.length) return { tx: null, view, applied: [], dropped: m.dropped };
    const tx = {
      tx_id: core.uid('tx'),
      base_seq: confirmed.seq,
      ops: sendList,
      engine: core.ENGINE_VERSION,
      client: clientId,
      author_kind: meta.author_kind === 'agent' || meta.author_kind === 'system' ? meta.author_kind : 'human',
    };
    if (author) tx.author = author;
    if (meta.title) tx.title = String(meta.title).slice(0, 200);
    if (meta.undo_of) tx.undo_of = String(meta.undo_of);
    if (meta.redo_of) tx.redo_of = String(meta.redo_of);
    let bytes = 0;
    try { bytes = new TextEncoder().encode(JSON.stringify(tx)).length; } catch { bytes = 0; }
    if (bytes > LIMITS.txBytes) return refuse('tx_bytes', 'правка больше 4 МБ — сервер её не примет');
    pending.push(tx);
    // инкрементально — ровно то, что сделало бы полное переигрывание последним шагом
    for (const [id, p] of core.collectTombstones(view, m.ops)) viewTomb.set(id, p);
    if (res.error) { report('commit', res.error); replayAll(); } else view = res.doc;
    scheduleWrite();
    emitStatus();
    sendNext();
    return { tx, view, applied: m.ops, dropped: m.dropped };
  }

  /* ---- открытие и закрытие ---- */

  /**
   * Сначала локальный журнал → onChange(view) сразу, потом сокет. Без локальной
   * копии — снимок с сервера (GET /api/projects/:id) и только потом сокет; сервер
   * недоступен — статус «сервер недоступен», пробуем снова с той же паузой, что и сокет.
   */
  async function open() {
    if (opened) return view;
    opened = true;
    let rec = null;
    if (storage) {
      try { rec = await storage.get(projectId); } catch (e) { report('journal', e); rec = null; }
    }
    if (closed) return null;
    if (rec && rec.doc && rec.doc.nodes) {
      confirmed = { seq: isNum(rec.seq) ? rec.seq : 0, doc: rec.doc };
      tomb = tombFromList(rec.tombstones);
      pending = Array.isArray(rec.pending) ? rec.pending.filter((t) => t && t.tx_id && Array.isArray(t.ops)) : [];
      extraLoaded = rec.extra;
      tip = typeof rec.tip === 'string' && rec.tip ? rec.tip : null;
      epoch = typeof rec.epoch === 'string' && rec.epoch ? rec.epoch : null;
      mine = Array.isArray(rec.mine) ? rec.mine.filter((m) => m && m.tx && m.tx.tx_id && Array.isArray(m.tx.ops) && isNum(m.seq)).slice(-MINE_KEEP) : [];
      replayAll();
      call(o.onChange, view, { reason: 'open', from: 'local', extra: extraLoaded });
      emitStatus();
      connect();
      return view;
    }
    // локальной копии нет: без снимка сервера показывать нечего
    let guard = 0;
    while (!closed) {
      try {
        const ok = await loadFromServer();
        if (!ok) return null;   // проекта нет — оболочке сказано через onError
        error = null;
        break;
      } catch (e) {
        report('open', e);
        error = 'unreachable';
        emitStatus();
        const delay = Math.max(jitter(Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(guard++, 12)))), serverWait);
        serverWait = 0;
        await new Promise((r) => {
          openRetry = () => { openRetry = null; r(); };
          setT(() => { if (openRetry) { openRetry = null; r(); } }, delay);
        });
      }
    }
    if (closed) return null;
    call(o.onChange, view, { reason: 'open', from: 'server' });
    emitStatus();
    connect();
    return view;
  }

  /** Переподключиться сейчас (окно вернулось в сеть) — без ожидания паузы. */
  function reconnect() {
    if (closed) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    attempt = 0;
    // open() ждёт паузу перед новой попыткой взять снимок — не ждать
    if (openRetry) { const wake = openRetry; openRetry = null; wake(); return; }
    if (!socketOpen()) connect();
  }

  /**
   * Сеть пропала (событие offline у окна): открытый сокет об этом узнает не сразу —
   * TCP молчит до таймаута, и всё это время статус врал бы «в сети». Закрываем сами:
   * onclose переведёт в офлайн, правки лягут в очередь, а переподключение начнётся
   * по паузе или по событию online.
   */
  function offline() {
    if (closed) return;
    const ws = socket;
    if (!ws) return;
    try { ws.close(); } catch { /* уже закрыт */ }
    // некоторые реализации не зовут onclose при закрытии без сети — переводим сами
    if (socket === ws) {
      socket = null;
      dropSocketState();
      scheduleReconnect();
    }
  }

  function close() {
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null; }
    stopHeartbeat();
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; }
    clearInflight();
    const ws = socket;
    socket = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* уже закрыт */ } }
    online = false;
    return flush();
  }

  return {
    open, close, commit, presence, reconnect, offline, flush,
    /** отметить журнал изменённым (оболочка поменяла то, что кладёт в extra) */
    touch: () => scheduleWrite(),
    setAuthor: (name) => { author = String(name || ''); if (presenceLast) sendPresence(); },
    get view() { return view; },
    get confirmed() { return confirmed; },
    get pending() { return pending.slice(); },
    get status() { return statusFull(); },
    get tip() { return tip; },
    get epoch() { return epoch; },
    get mine() { return mine.map((m) => ({ tx_id: m.tx.tx_id, seq: m.seq, epoch: m.epoch })); },
    get extra() { return extraLoaded; },
    get clientId() { return clientId; },
    get projectId() { return projectId; },
    get author() { return author; },
    get others() { return [...others.values()]; },
  };
}
