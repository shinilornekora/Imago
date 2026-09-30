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
 * проекта; запись `{seq, doc, pending, tombstones, clientId, updatedAt, extra}`.
 * Пишется после каждого изменения, но не чаще раза в 200 мс; перед уходом со
 * страницы оболочка зовёт flush().
 */

const WRITE_DELAY = 200;          // пауза между изменением и записью журнала
const PRESENCE_GAP = 100;         // присутствие — не чаще 10 раз в секунду (§9.3)
const PRESENCE_TTL = 90 * 1000;   // чужое присутствие без вестей столько — считаем ушедшим
const ACK_TIMEOUT = 8 * 1000;     // подтверждение не пришло — дослать (идемпотентно), потом переподключиться
const OPS_PAGE = 500;             // сколько транзакций просить за один GET …/ops
const HELLO_TIMEOUT = 8 * 1000;   // сокет открыт, а hello нет — это не сервер (или зомби): закрыть и подключиться заново

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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
 * @param {Function} [o.onChange]   (view, info) — view изменился не по своему commit: open · confirmed · remote · gone · error
 * @param {Function} [o.onStatus]   ({online, pending, syncing, error, head})
 * @param {Function} [o.onDropped]  (committed) — сервер отбросил часть операций своей транзакции
 * @param {Function} [o.onPresence] (list) — кто в сети с их выделениями
 * @param {Function} [o.onGone]     (snapshot) — база ушла за хвост: пришёл снимок
 * @param {Function} [o.onError]    ({code, message, tx?})
 * @param {Function} [o.extra]      () => object — что оболочка кладёт в журнал рядом с документом
 * @param {number} [o.reconnectMin] пауза перед первым переподключением, мс (1000)
 * @param {number} [o.reconnectMax] потолок паузы, мс (30000)
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

  let catchingUp = false;      // идёт GET …/ops: живые транзакции копим в буфер
  let buffer = [];

  let writeTimer = null;
  let dirty = false;
  let writing = null;

  // последнее своё присутствие: уходит при подключении (так о нас узнают остальные) и при
  // смене имени; пустое выделение — тоже присутствие
  let presenceLast = { selection: [], board: null };
  let presenceTimer = null;
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
  function emitStatus() {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastStatus) return;
    lastStatus = key;
    call(o.onStatus, s);
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

  async function http(path, init) {
    if (!fetchImpl) throw new Error('fetch недоступен');
    const res = await fetchImpl(baseUrl + path, { ...(init || {}), headers: { 'content-type': 'application/json', 'x-author': encodeURIComponent(author || ''), ...((init && init.headers) || {}) } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  }

  /** Снимок + хвост с сервера → confirmed (очередь переигрывается поверх). */
  async function loadFromServer() {
    const r = await http(`/api/projects/${encodeURIComponent(projectId)}`);
    if (r.status === 404) { error = 'not-found'; emitStatus(); call(o.onError, { code: 'not-found', message: 'проект не найден' }); return false; }
    if (!r.ok || !r.body || !r.body.snapshot || !r.body.snapshot.doc) throw new Error(`GET /api/projects: ${r.status}`);
    adoptSnapshot(r.body.snapshot, r.body.tail);
    return true;
  }

  /** Снимок как confirmed, надгробия с нуля, хвост — по порядку, своя очередь — поверх. */
  function adoptSnapshot(snapshot, tail) {
    confirmed = { seq: isNum(snapshot.seq) ? snapshot.seq : 0, doc: snapshot.doc };
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
        const r = await http(`/api/projects/${encodeURIComponent(projectId)}/ops?since=${confirmed.seq}&limit=${OPS_PAGE}`);
        if (r.status === 410 && r.body && r.body.snapshot) {
          gone(r.body.snapshot, r.body.head_seq);
          if (!(isNum(r.body.head_seq) && r.body.head_seq > confirmed.seq)) break;
          continue;
        }
        if (!r.ok || !r.body) throw new Error(`GET …/ops: ${r.status}`);
        const txs = Array.isArray(r.body.txs) ? r.body.txs.slice().sort((a, b) => a.seq - b.seq) : [];
        for (const c of txs) if (isNum(c.seq) && c.seq > confirmed.seq) takeCommitted(c);
        const head = isNum(r.body.head_seq) ? r.body.head_seq : confirmed.seq;
        if (confirmed.seq >= head || !txs.length) break;
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

  function gone(snapshot, headSeq) {
    if (!snapshot || !snapshot.doc) return;
    adoptSnapshot(snapshot, []);
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
      pending.splice(i, 1);
      if (inflight === c.tx_id) clearInflight();
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

  /* ---- отправка ---- */

  function clearInflight() {
    inflight = null;
    inflightRetries = 0;
    if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
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
    if (halted || inflight || !pending.length || !socketOpen() || !ready) return;
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
      + (author ? `&author=${encodeURIComponent(author)}` : '');
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
    ws.onclose = () => {
      if (ws !== socket) return;
      socket = null;
      dropSocketState();
      if (!closed) scheduleReconnect();
    };
  }

  /** Сокет потерян: не в сети, ничего не в полёте, чужое присутствие протухло вместе с ним. */
  function dropSocketState() {
    online = false;
    ready = false;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    clearInflight();
    if (others.size) { others.clear(); emitPresence(); }
    emitStatus();
  }

  /** Экспоненциальная пауза: 1 с → 2 → 4 … → 30 с. Сбрасывается по hello. */
  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(attempt, 12)));
    attempt += 1;
    reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, delay);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello': {
        attempt = 0;
        ready = true;
        online = true;
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        helloHead = isNum(msg.head_seq) ? msg.head_seq : -1;
        // сервер ответил — «недоступен» и «разошлись» больше не про него; отказ по версии остаётся
        if (!halted) error = null;
        if (isNum(msg.engine) && msg.engine !== core.ENGINE_VERSION) {
          halted = true;
          error = 'engine';
          call(o.onError, { code: 'engine', message: 'версия движка на сервере другая — обновите страницу', engine: msg.engine });
        }
        // журнал впереди сервера (базу пересоздали): своя копия ничего не стоит — берём снимок
        if (helloHead >= 0 && helloHead < confirmed.seq) {
          loadFromServer().then(() => {
            call(o.onChange, view, { reason: 'gone', head: helloHead });
            emitStatus();
          }).catch((e) => report('resync', e));
        }
        emitStatus();
        // очередь и присутствие — только теперь: до hello Hub их выбрасывает
        sendNext();
        sendPresence();
        break;
      }
      case 'tx':
        handleTx(msg.tx);
        break;
      case 'gone':
        if (!ready) { ready = true; online = true; if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; } }
        gone(msg.snapshot, msg.head_seq);
        if (isNum(msg.head_seq) && msg.head_seq > confirmed.seq) catchUp();
        else sendNext();
        break;
      case 'error': {
        const code = String(msg.code || 'error');
        const i = msg.tx_id ? pending.findIndex((p) => p.tx_id === msg.tx_id) : -1;
        const tx = i >= 0 ? pending[i] : null;
        if (/engine|426/i.test(code)) { halted = true; error = 'engine'; }
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
        others.set(String(msg.client), {
          client: String(msg.client),
          author: String(msg.author || ''),
          selection: Array.isArray(msg.selection) ? msg.selection.filter((x) => typeof x === 'string').slice(0, 200) : [],
          board: typeof msg.board === 'string' ? msg.board : null,
          at: isNum(msg.at) ? msg.at : Date.now(),
        });
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

  function emitPresence() {
    const now = Date.now();
    for (const [k, p] of others) if (now - p.at > PRESENCE_TTL) others.delete(k);
    call(o.onPresence, [...others.values()].map((p) => ({ ...p, selection: p.selection.slice() })));
  }

  function sendPresence() {
    if (!presenceLast || !socketOpen() || !ready) return;
    presenceSentAt = Date.now();
    presenceSentKey = JSON.stringify([presenceLast, author]);
    sendJson({ type: 'presence', selection: presenceLast.selection, board: presenceLast.board, author });
  }

  /**
   * Своё выделение и доска — эфемерно, не чаще 10 раз в секунду; последнее всегда доходит.
   * Оболочка зовёт это на каждой перерисовке, поэтому то же самое, что уже ушло, не шлём.
   */
  function presence(p, force = false) {
    const next = {
      selection: Array.isArray(p && p.selection) ? p.selection.filter((x) => typeof x === 'string').slice(0, 200) : [],
      board: p && typeof p.board === 'string' ? p.board : null,
    };
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
    const m = core.rebase(view, list, { tombstones: viewTomb });
    if (!m.ops.length) return { tx: null, view, applied: [], dropped: m.dropped };
    const tx = {
      tx_id: core.uid('tx'),
      base_seq: confirmed.seq,
      ops: list,
      engine: core.ENGINE_VERSION,
      client: clientId,
      author_kind: meta.author_kind === 'agent' || meta.author_kind === 'system' ? meta.author_kind : 'human',
    };
    if (author) tx.author = author;
    if (meta.title) tx.title = String(meta.title).slice(0, 200);
    if (meta.undo_of) tx.undo_of = String(meta.undo_of);
    if (meta.redo_of) tx.redo_of = String(meta.redo_of);
    pending.push(tx);
    // инкрементально — ровно то, что сделало бы полное переигрывание последним шагом
    for (const [id, p] of core.collectTombstones(view, m.ops)) viewTomb.set(id, p);
    const res = core.applyOps(view, m.ops);
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
        const delay = Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(guard++, 12)));
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
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
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
    get status() { return status(); },
    get extra() { return extraLoaded; },
    get clientId() { return clientId; },
    get projectId() { return projectId; },
    get author() { return author; },
    get others() { return [...others.values()]; },
  };
}
