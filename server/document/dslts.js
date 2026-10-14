/**
 * DSLTS — DSL Transaction Sequencer (SPEC §8.1, §9.4, §9.8): единственный писатель.
 * Держит голову каждого открытого проекта в памяти, сливает транзакцию поверх
 * головы тем же `core.rebase`, что и клиент, нумерует через базу, отдаёт
 * `Committed` в Hub, раз в N транзакций пишет снимок.
 *
 * Слияние не отказывает (§8.3): транзакция целиком не отклоняется никогда,
 * отдельная операция отбрасывается только по правилам §9.6 (и пределам §9.8) —
 * и автору об этом сказано в `dropped`. Отказ бывает только у формы (400),
 * размера (413) и версии движка (426).
 *
 * Голова = {doc, head_seq, chain, epoch, tombstones, recent}. Надгробия — id
 * удалённых узлов → последний родитель (восстанавливаются из `remove` в хвосте
 * после снимка). `chain` — якорь последней записи: sha256(prev + tx_id + seq).
 *
 * Несколько экземпляров на одной базе (§9.8): экземпляр, записавший транзакцию,
 * шлёт NOTIFY (в той же транзакции базы); остальные по уведомлению дочитывают
 * хвост и отдают его Hub. Голова в памяти сверяется с базой (head_seq,
 * head_chain, epoch) — по уведомлению, при подключении сокета, по таймеру и при
 * «чужом» номере на записи:
 *   база впереди, цепочка продолжается  → дочитать хвост;
 *   база позади или цепочка другая      → база откатилась: эпоха меняется
 *                                         (compare-and-set — один раз на откат),
 *                                         голова выбрасывается, Hub закрывает
 *                                         сокеты проекта кодом 4410;
 *   эпоха в базе другая                 → её сменил кто-то ещё: голова выбрасывается.
 */

import { applyOps, rebase, collectTombstones, ENGINE_VERSION } from '../../src/core.js';
import { DocError, badRequest, notFound, tooLarge, unavailable, viaStorage } from './errors.js';
import { chainNext, compactDropped, jsonBytes } from './storage/committed.js';
import {
  MAX_OPS_PER_TX, MAX_DOC_BYTES, MAX_DOC_NODES, MERGE_BUDGET_MS,
  SNAPSHOT_EVERY, SNAPSHOT_KEEP, VERIFY_MS, PAGE_TXS
} from './limits.js';

/** Предел операций в транзакции (совместимость: прежде экспортировался отсюда). */
export const MAX_OPS = MAX_OPS_PER_TX;
/** Сколько последних транзакций голова помнит (быстрая идемпотентность). */
export const RECENT_LIMIT = 500;
/** Выгрузка головы по бездействию. */
export const IDLE_MS = 10 * 60 * 1000;
/**
 * Сколько раз пересливать, если голову двигает другой экземпляр. Проигрыш
 * гонки стоит один круг до базы, а очередь соседа может быть длинной — трёх
 * попыток на всплеске не хватает; после третьей ждём случайные миллисекунды,
 * чтобы два экземпляра не били в одну голову в такт.
 */
const MAX_RETRIES = 12;
const RETRY_BACKOFF_MS = 15;
/** Страница чтения хвоста внутри сервиса (загрузка и догон головы): байтами шире, чем наружу. */
const INTERNAL_PAGE_BYTES = 16 * 1024 * 1024;
const OP_KINDS = new Set(['create', 'remove', 'set', 'move', 'setToken']);
const AUTHOR_KINDS = new Set(['human', 'agent', 'system']);
const MAX_ID = 128;
const MAX_NAME = 200;
const MAX_TITLE = 500;

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Проверка формы транзакции (SPEC §9.1). Возвращает нормализованную копию с
 * известными полями; форма негодна → 400, операций больше предела → 413,
 * версия движка не наша → 426. Сами операции глубоко не проверяются: их судит
 * rebase (`dropped: invalid`), иначе транзакция с одной битой операцией
 * отклонялась бы целиком — против §8.3.
 * @param {any} raw
 * @param {{author?: string}} [ctx] автор из заголовка X-Author, если в теле нет
 * @returns {object}
 */
export function validateTx(raw, ctx = {}) {
  const txId = raw && isStr(raw.tx_id, MAX_ID) ? { tx_id: raw.tx_id } : {};
  const bad = (msg) => badRequest(msg, { compat: txId });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('транзакция должна быть объектом');
  if (!isStr(raw.tx_id, MAX_ID)) throw bad('tx_id: непустая строка до 128 символов');
  if (!Number.isInteger(raw.base_seq) || raw.base_seq < 0) throw bad('base_seq: целое ≥ 0');
  if (!Array.isArray(raw.ops)) throw bad('ops: массив операций');
  if (raw.ops.length > MAX_OPS_PER_TX) {
    throw tooLarge(`ops: не больше ${MAX_OPS_PER_TX} операций в транзакции — разбейте правку`, { compat: txId, detail: { limit: 'ops_per_tx', max: MAX_OPS_PER_TX, got: raw.ops.length } });
  }
  for (let i = 0; i < raw.ops.length; i++) {
    const op = raw.ops[i];
    if (!op || typeof op !== 'object' || Array.isArray(op) || !OP_KINDS.has(op.op)) throw bad(`ops[${i}]: неизвестная операция`);
  }
  for (const k of ['undo_of', 'redo_of']) {
    if (raw[k] !== undefined && raw[k] !== null && !isStr(raw[k], MAX_ID)) throw bad(`${k}: строка tx_id`);
  }
  for (const [k, max] of [['author', MAX_NAME], ['client', MAX_ID], ['title', MAX_TITLE]]) {
    if (raw[k] !== undefined && raw[k] !== null && (typeof raw[k] !== 'string' || raw[k].length > max)) throw bad(`${k}: строка до ${max} символов`);
  }
  if (raw.author_kind !== undefined && raw.author_kind !== null && !AUTHOR_KINDS.has(raw.author_kind)) throw bad('author_kind: human · agent · system');
  // версия движка — после формы: у мусора нет версии, у старого клиента есть, и ему нужен именно 426
  if (raw.engine !== ENGINE_VERSION) {
    throw new DocError(426, 'engine', `версия движка ${raw.engine === undefined ? 'не указана' : raw.engine}, сервер работает с ${ENGINE_VERSION} — обновите клиент`, {
      retryable: false, detail: { engine: ENGINE_VERSION }, compat: { engine: ENGINE_VERSION, ...txId }
    });
  }
  const tx = { tx_id: raw.tx_id, base_seq: raw.base_seq, ops: raw.ops, engine: ENGINE_VERSION };
  if (raw.undo_of) tx.undo_of = raw.undo_of;
  if (raw.redo_of) tx.redo_of = raw.redo_of;
  const author = raw.author || ctx.author;
  if (author) tx.author = String(author).slice(0, MAX_NAME);
  tx.author_kind = raw.author_kind || 'human';
  if (raw.client) tx.client = raw.client;
  if (raw.title) tx.title = raw.title;
  return tx;
}

/**
 * Первый индекс, на котором строгий applyOps ломается: двоичный поиск по
 * префиксам (префикс ломается тогда и только тогда, когда содержит первую
 * виноватую). log₂(n) применений вместо n — на 5000 операциях поверх большого
 * документа это разница между миллисекундами и секундами.
 */
function firstFailing(doc, list, apply = applyOps) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (apply(doc, list.slice(0, mid + 1)).error) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const nodeCount = (doc) => (doc && doc.nodes ? Object.keys(doc.nodes).length : 0);

/**
 * Слияние транзакции с головой (SPEC §9.4, п.2; §9.8): rebase → строгий applyOps;
 * не прошло — виноватая операция в `dropped` с `reason:'invalid'`, повтор (в
 * пределах бюджета времени — дальше подозрительный остаток отбрасывается целиком,
 * `limit:'merge_budget'`). Документ после транзакции больше предела (узлы, байты)
 * и больше, чем был, — отбрасываются все операции, кроме `remove`
 * (`limit:'doc_nodes'|'doc_bytes'`). Надгробия считаются по применённой форме ДО
 * применения (collectTombstones смотрит на родителей удаляемых узлов в документе,
 * где они ещё есть).
 * @param {{doc:object, tombstones:Map, docBytes?:number}} head
 * @param {object} tx
 * @param {{mergeBudgetMs?:number, maxDocNodes?:number, maxDocBytes?:number, applyOps?:Function}} [lim]
 *   `applyOps` — подмена строгого применения (тестам: по контракту rebase отдаёт
 *   применимое, и ветку «applyOps не принял» иначе не достать)
 * @returns {{ops:object[], dropped:object[], notes:object[], doc:object, tombstones:[string, string|null][], docBytes:number}}
 */
export function mergeIntoHead(head, tx, lim = {}) {
  const budget = lim.mergeBudgetMs !== undefined ? lim.mergeBudgetMs : MERGE_BUDGET_MS;
  const maxNodes = lim.maxDocNodes || MAX_DOC_NODES;
  const maxBytes = lim.maxDocBytes || MAX_DOC_BYTES;
  const apply = typeof lim.applyOps === 'function' ? lim.applyOps : applyOps;
  const started = Date.now();
  const src = tx.ops;
  const rb = rebase(head.doc, src, { tombstones: head.tombstones });
  const dropped = rb.dropped.slice();
  let notes = rb.notes.slice();
  let kept = rb.ops.slice();
  // исходные индексы оставленных операций: rebase сохраняет порядок, минуя отброшенные
  const droppedIdx = new Set(dropped.map((d) => d.index));
  let keptIdx = [];
  for (let i = 0; i < src.length; i++) if (!droppedIdx.has(i)) keptIdx.push(i);

  const drop = (i, extra) => {
    const at = keptIdx[i];
    dropped.push({ index: at, op: src[at], reason: 'invalid', ...(extra || {}) });
    droppedIdx.add(at);
  };
  const settle = () => {
    for (;;) {
      const res = apply(head.doc, kept);
      if (!res.error) return res.doc;
      const bad = firstFailing(head.doc, kept, apply);
      if (Date.now() - started > budget) {
        // бюджет кончился: виноватую и всё после неё — в dropped, дальше не ищем
        for (let i = bad; i < kept.length; i++) drop(i, { limit: 'merge_budget' });
        kept = kept.slice(0, bad);
        keptIdx = keptIdx.slice(0, bad);
        continue;
      }
      drop(bad);
      kept = kept.filter((_, i) => i !== bad);
      keptIdx = keptIdx.filter((_, i) => i !== bad);
    }
  };
  let doc = settle();

  // пределы документа: считаем узлы всегда (дёшево), байты — по оценке, точно — у границы
  const beforeNodes = nodeCount(head.doc);
  const beforeBytes = Number.isFinite(head.docBytes) ? head.docBytes : jsonBytes(head.doc);
  let afterNodes = nodeCount(doc);
  let afterBytes = beforeBytes + (kept.length ? jsonBytes(kept) : 0);
  let exact = false;
  if (afterBytes > maxBytes) {
    afterBytes = jsonBytes(doc);
    exact = true;
  }
  let limit = null;
  if (afterNodes > maxNodes && afterNodes > beforeNodes) limit = 'doc_nodes';
  else if (afterBytes > maxBytes && afterBytes > beforeBytes) limit = 'doc_bytes';
  if (limit) {
    const keepRemoves = [];
    const keepRemovesIdx = [];
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].op === 'remove') {
        keepRemoves.push(kept[i]);
        keepRemovesIdx.push(keptIdx[i]);
      } else {
        drop(i, { limit });
      }
    }
    kept = keepRemoves;
    keptIdx = keepRemovesIdx;
    doc = settle();
    afterNodes = nodeCount(doc);
    afterBytes = jsonBytes(doc);
    exact = true;
  }
  dropped.sort((a, b) => a.index - b.index);
  notes = notes.filter((n) => !droppedIdx.has(n.index));
  return {
    ops: kept, dropped, notes, doc,
    tombstones: collectTombstones(head.doc, kept),
    docBytes: exact ? afterBytes : Math.max(0, afterBytes)
  };
}

/**
 * @param {{
 *   storage: object,
 *   instanceId?: string,
 *   snapshotEvery?: number,
 *   snapshotKeep?: number,
 *   idleMs?: number,
 *   verifyMs?: number,
 *   mergeBudgetMs?: number,
 *   maxDocNodes?: number,
 *   maxDocBytes?: number,
 *   log?: {warn:Function, info:Function}
 * }} opts
 */
export function createSequencer({
  storage, instanceId = 'i', snapshotEvery = SNAPSHOT_EVERY, snapshotKeep = SNAPSHOT_KEEP,
  idleMs = IDLE_MS, verifyMs = VERIFY_MS, mergeBudgetMs, maxDocNodes, maxDocBytes, log = console
}) {
  const lim = { mergeBudgetMs, maxDocNodes, maxDocBytes };
  /** @type {Map<string, object>} projectId → голова */
  const heads = new Map();
  /** @type {Map<string, Promise>} projectId → хвост очереди (мьютекс) */
  const locks = new Map();
  /** @type {Set<Function>} слушатели событий (Hub): {kind:'tx'|'epoch', …} */
  const listeners = new Set();
  /** @type {Set<Promise>} снимки и сверки в полёте — close() их дожидается */
  const inflight = new Set();
  /** проекты, для которых сверка уже стоит в очереди (уведомления сливаются) */
  const syncQueued = new Set();
  /** Hub говорит, кого он держит открытым: такие головы по бездействию не выгружаются */
  let watched = () => false;
  let closed = false;
  /** круги заново из-за гонки с другим экземпляром и исчерпанные попытки (тестам, отладке) */
  let staleRetries = 0;
  let exhausted = 0;

  /**
   * Мьютекс проекта: очередь промисов. Отказ одной транзакции не должен запирать
   * очередь, поэтому хвост всегда резолвится, а ошибка уходит только вызвавшему.
   */
  function withLock(projectId, fn) {
    const prev = locks.get(projectId) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.catch(() => {}).then(() => gate);
    locks.set(projectId, tail);
    return prev.catch(() => {}).then(fn).finally(() => {
      release();
      if (locks.get(projectId) === tail) locks.delete(projectId);
    });
  }

  const track = (p) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  function emit(event) {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (e) {
        log.warn('[document/dslts] слушатель упал:', e && e.message);
      }
    }
  }

  function remember(head, committed) {
    head.recent.push(committed);
    head.byTx.set(committed.tx_id, committed);
    while (head.recent.length > RECENT_LIMIT) {
      const old = head.recent.shift();
      if (head.byTx.get(old.tx_id) === old) head.byTx.delete(old.tx_id);
    }
  }

  /** Применить записанную транзакцию к голове (загрузка хвоста, догон за другим экземпляром). */
  function absorb(head, projectId, committed) {
    for (const [id, parent] of collectTombstones(head.doc, committed.ops)) head.tombstones.set(id, parent);
    const res = applyOps(head.doc, committed.ops);
    if (res.error) {
      // применённая форма обязана проходить строго; если нет — журнал и движок разошлись,
      // молчать нельзя, но и вставать нельзя: голова идёт дальше по номерам
      log.warn(`[document/dslts] ${projectId}: seq ${committed.seq} не применяется: ${res.error.message}`);
    } else {
      head.doc = res.doc;
      head.docBytes += jsonBytes(committed.ops);
    }
    head.head_seq = committed.seq;
    if (typeof committed.chain === 'string') head.chain = committed.chain;
    remember(head, committed);
  }

  function dropHead(projectId) {
    const head = heads.get(projectId);
    if (head && head.timer) clearTimeout(head.timer);
    heads.delete(projectId);
  }

  function touch(projectId, head) {
    head.lastUsed = Date.now();
    if (head.timer) clearTimeout(head.timer);
    if (idleMs > 0) {
      head.timer = setTimeout(() => {
        withLock(projectId, () => {
          const cur = heads.get(projectId);
          if (cur !== head) return;
          // открытый сокетом проект держим: его сверяет таймер и будят уведомления
          if (watched(projectId)) { touch(projectId, head); return; }
          if (Date.now() - head.lastUsed >= idleMs) heads.delete(projectId);
        }).catch(() => {});
      }, idleMs);
      if (head.timer.unref) head.timer.unref();
    }
  }

  /** Голова проекта: ленивая загрузка снимка и хвоста. Звать под мьютексом. */
  async function ensureHead(projectId) {
    let head = heads.get(projectId);
    if (!head) {
      const project = await viaStorage(storage.getProject(projectId));
      if (!project) throw notFound();
      const snap = await viaStorage(storage.latestSnapshot(projectId));
      if (!snap) throw unavailable('у проекта нет снимка — журнал не с чего переигрывать');
      if (snap.engine !== ENGINE_VERSION) {
        // миграция формата — системная транзакция (§8.3), а не тихая правка; пока её нет — предупреждаем
        log.warn(`[document/dslts] ${projectId}: снимок seq ${snap.seq} записан движком ${snap.engine}, сервер работает с ${ENGINE_VERSION}`);
      }
      head = {
        doc: snap.doc, head_seq: snap.seq, chain: snap.chain || '', epoch: project.epoch,
        tombstones: new Map(), recent: [], byTx: new Map(), lastUsed: 0, timer: null,
        docBytes: jsonBytes(snap.doc)
      };
      // страница ограничена и числом, и байтами: конец — только пустая страница
      for (;;) {
        const page = await viaStorage(storage.txsAfter(projectId, head.head_seq, PAGE_TXS, { maxBytes: INTERNAL_PAGE_BYTES }));
        if (!page.length) break;
        for (const tx of page) absorb(head, projectId, tx);
      }
      heads.set(projectId, head);
    }
    touch(projectId, head);
    return head;
  }

  /**
   * База откатилась под головой (SPEC §9.8): сменить эпоху, если её ещё никто не
   * сменил (compare-and-set), выбросить голову, сказать Hub. Звать под мьютексом.
   */
  async function rollback(projectId, head, project, why) {
    let epoch = project.epoch;
    if (project.epoch === head.epoch) {
      const r = await viaStorage(storage.bumpEpoch(projectId, head.epoch, 'instance', instanceId));
      if (r.status === 'missing') {
        dropHead(projectId);
        throw notFound();
      }
      epoch = r.epoch;
      if (r.status === 'bumped') log.warn(`[document/dslts] ${projectId}: база откатилась (${why}; в памяти seq ${head.head_seq}, в базе ${project.head_seq}) — новая эпоха ${epoch}`);
    }
    dropHead(projectId);
    emit({ kind: 'epoch', projectId, epoch });
    return epoch;
  }

  /**
   * Сверить голову с базой и догнать её (SPEC §9.8). Звать под мьютексом.
   * @returns {Promise<'none'|'ok'|'caught-up'|'epoch'|'rollback'>}
   */
  async function syncHead(projectId) {
    const head = heads.get(projectId);
    if (!head) return 'none';
    const p = await viaStorage(storage.getProject(projectId));
    if (!p) {
      dropHead(projectId);
      return 'none';
    }
    if (p.epoch !== head.epoch) {
      // эпоху сменил кто-то ещё (или база вернулась к эпохе, которой голова не знает)
      dropHead(projectId);
      emit({ kind: 'epoch', projectId, epoch: p.epoch });
      return 'epoch';
    }
    if (p.head_seq < head.head_seq) {
      await rollback(projectId, head, p, 'голова базы позади');
      return 'rollback';
    }
    if (p.head_seq === head.head_seq) {
      if (p.head_chain !== head.chain) {
        await rollback(projectId, head, p, 'цепочка на голове другая');
        return 'rollback';
      }
      return 'ok';
    }
    for (;;) {
      const page = await viaStorage(storage.txsAfter(projectId, head.head_seq, PAGE_TXS, { maxBytes: INTERNAL_PAGE_BYTES }));
      if (!page.length) break;
      for (const tx of page) {
        const expected = chainNext(head.chain, tx.tx_id, tx.seq);
        if (tx.seq !== head.head_seq + 1 || (typeof tx.chain === 'string' && tx.chain !== expected)) {
          await rollback(projectId, head, p, `цепочка рвётся на seq ${tx.seq}`);
          return 'rollback';
        }
        absorb(head, projectId, tx);
        emit({ kind: 'tx', projectId, committed: tx });
      }
    }
    return 'caught-up';
  }

  /** Сверка по уведомлению: одна в очереди на проект, остальные сливаются в неё. */
  function scheduleSync(projectId) {
    if (closed || syncQueued.has(projectId)) return;
    syncQueued.add(projectId);
    track(withLock(projectId, async () => {
      syncQueued.delete(projectId);
      if (closed) return;
      const r = await syncHead(projectId);
      // проект открыт сокетами — голова нужна им для живого потока: загрузить заново
      if ((r === 'epoch' || r === 'rollback') && watched(projectId)) await ensureHead(projectId);
    }).catch((e) => log.warn(`[document/dslts] ${projectId}: сверка с базой не удалась: ${e && e.message}`)));
  }

  function onEpochNotice(projectId, epoch) {
    track(withLock(projectId, async () => {
      const head = heads.get(projectId);
      if (head && head.epoch === epoch) return;
      dropHead(projectId);
      emit({ kind: 'epoch', projectId, epoch });
      if (watched(projectId) && !closed) await ensureHead(projectId);
    }).catch(() => {}));
  }

  /** Сверить все головы (таймер; переподключение слушателя — уведомления за разрыв потеряны). */
  function verifyAll() {
    for (const projectId of heads.keys()) scheduleSync(projectId);
  }

  const unlisten = typeof storage.onNotify === 'function' ? storage.onNotify((msg) => {
    if (!msg || closed) return;
    if (msg.k === 'resync') { verifyAll(); return; }
    if (typeof msg.p !== 'string' || msg.i === instanceId) return;
    if (msg.k === 'tx') {
      if (heads.has(msg.p)) scheduleSync(msg.p);
    } else if (msg.k === 'epoch') {
      onEpochNotice(msg.p, msg.e);
    }
  }) : () => {};

  const verifier = verifyMs > 0 ? setInterval(verifyAll, verifyMs) : null;
  if (verifier && verifier.unref) verifier.unref();

  function scheduleSnapshot(projectId, seq, doc, chain) {
    // после ответа: setImmediate отпускает текущий тик, запись идёт следующим
    track(new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        const written = await storage.writeSnapshot(projectId, seq, doc, ENGINE_VERSION, chain);
        if (written && snapshotKeep > 0) await storage.pruneSnapshots(projectId, snapshotKeep);
      })
      .catch((e) => log.warn(`[document/dslts] ${projectId}: снимок seq ${seq} не записан: ${e && e.message}`)));
  }

  const info = (head) => ({ head_seq: head.head_seq, chain: head.chain, epoch: head.epoch });

  return {
    /** Подписка на события: `{kind:'tx', projectId, committed}` в порядке seq · `{kind:'epoch', projectId, epoch, token?}`. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Hub сообщает, какие проекты у него открыты (их головы не выгружаются по бездействию). */
    setWatcher(fn) {
      watched = typeof fn === 'function' ? fn : () => false;
    },

    /**
     * Голова проекта загружена и сверена с базой — для сокета, который
     * подключается: {head_seq, chain, epoch}. Тут же ловится откат базы, если
     * экземпляр ещё не знал о нём.
     */
    async attach(projectId) {
      return withLock(projectId, async () => {
        let head = await ensureHead(projectId);
        const r = await syncHead(projectId);
        if (r === 'epoch' || r === 'rollback') head = await ensureHead(projectId);
        return info(head);
      });
    },

    /**
     * Клиент прислал след отката (SPEC §9.8): tip не совпал с журналом при
     * нынешней эпохе или эпоху, которой база не знает. Эпоха меняется не чаще
     * раза на эпоху: эпоху, начатую по слову клиента, клиент же сменить не может —
     * один неисправный клиент иначе закрывал бы всем сокеты по кругу.
     * @param {string} projectId
     * @param {{token?: any}} [opts] метка, по которой Hub узнает «своё» событие
     * @returns {Promise<{bumped: boolean, head_seq: number, chain: string, epoch: string}>}
     */
    async clientEvidence(projectId, opts = {}) {
      return withLock(projectId, async () => {
        const p = await viaStorage(storage.getProject(projectId));
        if (!p) throw notFound();
        let bumped = false;
        if (p.epoch_cause !== 'client') {
          const r = await viaStorage(storage.bumpEpoch(projectId, p.epoch, 'client', instanceId));
          if (r.status === 'bumped') {
            bumped = true;
            log.warn(`[document/dslts] ${projectId}: клиент прислал журнал, которого нет в базе — новая эпоха ${r.epoch}`);
            dropHead(projectId);
            emit({ kind: 'epoch', projectId, epoch: r.epoch, token: opts.token });
          }
        }
        const head = await ensureHead(projectId);
        await syncHead(projectId);
        return { bumped, ...info(heads.get(projectId) || head) };
      });
    },

    /**
     * Зафиксировать транзакцию (SPEC §9.4).
     * @param {string} projectId
     * @param {any} raw транзакция как пришла
     * @param {{author?: string}} [ctx]
     * @returns {Promise<{committed: object, existing: boolean}>}
     */
    async commit(projectId, raw, ctx = {}) {
      let tx;
      try {
        tx = validateTx(raw, ctx);
      } catch (e) {
        // мусор в несуществующий проект — это 404, а не 400: проект проверяем только
        // на пути отказа, чтобы не платить запросом к базе за каждую годную транзакцию
        if (!(await viaStorage(storage.getProject(projectId)))) throw notFound();
        throw e;
      }
      if (closed) throw unavailable('сервис останавливается');
      return withLock(projectId, async () => {
        // очередь мьютекса могла дождаться остановки: голову после close() не загружаем
        if (closed) throw unavailable('сервис останавливается');
        let head = await ensureHead(projectId);
        // tx_id известен → сохранённое (идемпотентность, §8.3). Здесь только память:
        // всё старше RECENT_LIMIT ловит UNIQUE(project_id, tx_id) в commitTx, а лишний
        // запрос к базе на каждую новую транзакцию — это круг ожидания на горячем пути
        const known = head.byTx.get(tx.tx_id);
        if (known) return { committed: known, existing: true };
        if (tx.base_seq > head.head_seq) {
          // клиент видел голову дальше нашей: возможно, писал другой экземпляр — сначала сверка
          const r = await syncHead(projectId);
          if (r === 'epoch' || r === 'rollback') head = await ensureHead(projectId);
          if (tx.base_seq > head.head_seq) {
            // база позади клиента (откат или пересоздание): зажим, а не отказ — слияние не отказывает
            tx = { ...tx, base_seq: head.head_seq };
          }
        }
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          head = await ensureHead(projectId);
          const again = head.byTx.get(tx.tx_id);
          if (again) return { committed: again, existing: true };
          const merged = mergeIntoHead(head, tx, lim);
          const record = { ...tx, ops: merged.ops, dropped: compactDropped(merged.dropped), notes: merged.notes };
          const expectSeq = head.head_seq + 1;
          const expectChain = chainNext(head.chain, tx.tx_id, expectSeq);
          const res = await viaStorage(storage.commitTx(projectId, record, { expectSeq, expectChain, origin: instanceId }));
          if (res.status === 'missing') throw notFound();
          if (res.status === 'existing') {
            // записал другой экземпляр (или гонка мимо памяти): голова могла отстать
            if (res.committed.seq > head.head_seq) await syncHead(projectId);
            return { committed: res.committed, existing: true };
          }
          if (res.status === 'stale') {
            staleRetries += 1;
            if (res.reason === 'chain' || res.head_seq < head.head_seq) {
              // номер тот же, а журнал под ним другой, или база позади: откат базы
              await rollback(projectId, head, { epoch: res.epoch, head_seq: res.head_seq }, res.reason === 'chain' ? 'цепочка на записи другая' : 'номер записи позади головы');
            } else {
              // номер ушёл вперёд — писал другой экземпляр: перечитать хвост, слить заново
              await syncHead(projectId);
            }
            if (attempt >= 2) await new Promise((r) => setTimeout(r, Math.random() * RETRY_BACKOFF_MS * attempt));
            continue;
          }
          // надгробия пополняются ДО обновления документа — считались по прежней голове
          for (const [id, parent] of merged.tombstones) head.tombstones.set(id, parent);
          head.doc = merged.doc;
          head.docBytes = merged.docBytes;
          head.head_seq = res.committed.seq;
          head.chain = res.committed.chain;
          remember(head, res.committed);
          // бездействие считается от конца записи, а не от её начала: долгая запись
          // (медленная база, длинная очередь) не должна выгружать голову сразу после себя
          touch(projectId, head);
          emit({ kind: 'tx', projectId, committed: res.committed });
          if (snapshotEvery > 0 && res.committed.seq % snapshotEvery === 0) scheduleSnapshot(projectId, res.committed.seq, head.doc, head.chain);
          return { committed: res.committed, existing: false };
        }
        exhausted += 1;
        throw unavailable('голову проекта двигает другой экземпляр — повторите позже');
      });
    },

    /**
     * Голова проекта (документ и номер) — тестам и отладке; загружает, если не
     * загружена, и сверяет с базой.
     */
    async headOf(projectId) {
      return withLock(projectId, async () => {
        await ensureHead(projectId);
        await syncHead(projectId);
        const head = await ensureHead(projectId);
        return { doc: head.doc, head_seq: head.head_seq, chain: head.chain, epoch: head.epoch, tombstones: new Map(head.tombstones), recent: head.recent.slice() };
      });
    },

    /** Гонки с другими экземплярами: сколько кругов заново, сколько раз попытки кончились (503). */
    stats() {
      return { staleRetries, exhausted, heads: heads.size };
    },

    /** Загружена ли голова (после выгрузки по бездействию — нет). */
    isLoaded(projectId) {
      return heads.has(projectId);
    },

    /** Выгрузить голову сейчас (тесты выгрузки по бездействию не ждут 10 минут). */
    async unload(projectId) {
      return withLock(projectId, () => dropHead(projectId));
    },

    /** Сверить все головы с базой сейчас и дождаться (тестам; в работе — таймер и уведомления). */
    async verify() {
      verifyAll();
      await Promise.all([...inflight]);
    },

    /** Дождаться снимков и сверок в полёте. */
    async flush() {
      while (inflight.size) await Promise.all([...inflight]);
    },

    /** Остановка: новые транзакции — 503, снимки дописываются, таймеры сняты. */
    async close() {
      closed = true;
      unlisten();
      if (verifier) clearInterval(verifier);
      for (const head of heads.values()) if (head.timer) clearTimeout(head.timer);
      await Promise.all([...locks.values()]);
      await Promise.all([...inflight]);
      heads.clear();
    }
  };
}
