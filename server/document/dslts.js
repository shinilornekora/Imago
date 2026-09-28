/**
 * DSLTS — DSL Transaction Sequencer (SPEC §8.1, §9.4): единственный писатель.
 * Держит голову каждого открытого проекта в памяти, сливает транзакцию поверх
 * головы тем же `core.rebase`, что и клиент, нумерует через базу, отдаёт
 * `Committed` в Hub, раз в N транзакций пишет снимок.
 *
 * Слияние не отказывает (§8.3): транзакция целиком не отклоняется никогда,
 * отдельная операция отбрасывается только по правилам §9.6 — и автору об этом
 * сказано в `dropped`. Отказ бывает только у формы (400) и версии движка (426).
 *
 * Голова = {doc, head_seq, tombstones, recent}. Надгробия — id удалённых узлов
 * → последний родитель: по ним rebase ищет живого предка узлу, чей родитель
 * удалён. Восстанавливаются из `remove` в хвосте после снимка; удаления
 * старше снимка забыты — клиенту с такой старой базой create даст `orphan`, а не
 * `reparented`, и это по спецификации («восстанавливаются из remove в хвосте»).
 */

import { applyOps, rebase, collectTombstones, ENGINE_VERSION } from '../../src/core.js';
import { DocError, viaStorage } from './errors.js';

/** Предел операций в транзакции: перетаскивание без коалесинга не должно раздувать журнал. */
export const MAX_OPS = 5000;
/** Сколько последних транзакций голова помнит (concurrent + быстрая идемпотентность). */
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
/** Страница чтения хвоста при загрузке головы. */
const PAGE = 500;
const OP_KINDS = new Set(['create', 'remove', 'set', 'move', 'setToken']);
const AUTHOR_KINDS = new Set(['human', 'agent', 'system']);
const MAX_ID = 128;
const MAX_NAME = 200;
const MAX_TITLE = 500;

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Проверка формы транзакции (SPEC §9.1). Возвращает нормализованную копию с
 * известными полями; форма негодна → 400, версия движка не наша → 426.
 * Сами операции глубоко не проверяются: их судит rebase (`dropped: invalid`),
 * иначе транзакция с одной битой операцией отклонялась бы целиком — против §8.3.
 * @param {any} raw
 * @param {{author?: string}} [ctx] автор из заголовка X-Author, если в теле нет
 * @returns {object}
 */
export function validateTx(raw, ctx = {}) {
  const bad = (msg, extra) => new DocError(400, 'bad-request', msg, { ...(extra || {}), ...(raw && isStr(raw.tx_id, MAX_ID) ? { tx_id: raw.tx_id } : {}) });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('транзакция должна быть объектом');
  if (!isStr(raw.tx_id, MAX_ID)) throw bad('tx_id: непустая строка до 128 символов');
  if (!Number.isInteger(raw.base_seq) || raw.base_seq < 0) throw bad('base_seq: целое ≥ 0');
  if (!Array.isArray(raw.ops)) throw bad('ops: массив операций');
  if (raw.ops.length > MAX_OPS) throw bad(`ops: не больше ${MAX_OPS} операций`);
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
    throw new DocError(426, 'engine', `версия движка ${raw.engine === undefined ? 'не указана' : raw.engine}, сервер работает с ${ENGINE_VERSION} — обновите клиент`, { engine: ENGINE_VERSION, tx_id: raw.tx_id });
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
 * Индекс, на котором строгий applyOps ломается: применяем по одной. Нужен
 * только когда rebase дал операции, которые целиком не проходят, — по
 * контракту такого не бывает, но виноватую надо назвать, а не отклонить всё.
 */
function firstFailing(doc, list) {
  let cur = doc;
  for (let i = 0; i < list.length; i++) {
    const res = applyOps(cur, [list[i]]);
    if (res.error) return i;
    cur = res.doc;
  }
  return -1;
}

/**
 * Слияние транзакции с головой (SPEC §9.4, п.2): rebase → строгий applyOps;
 * не прошло — виноватая операция в `dropped` с `reason:'invalid'`, повтор.
 * Надгробия считаются по применённой форме ДО применения (collectTombstones
 * смотрит на родителей удаляемых узлов в документе, где они ещё есть).
 * @returns {{ops:object[], dropped:object[], notes:object[], doc:object, tombstones:[string, string|null][]}}
 */
export function mergeIntoHead(head, tx) {
  const src = tx.ops;
  const rb = rebase(head.doc, src, { tombstones: head.tombstones });
  const dropped = rb.dropped.slice();
  let notes = rb.notes.slice();
  let kept = rb.ops.slice();
  // исходные индексы оставленных операций: rebase сохраняет порядок, минуя отброшенные
  const droppedIdx = new Set(dropped.map((d) => d.index));
  let keptIdx = [];
  for (let i = 0; i < src.length; i++) if (!droppedIdx.has(i)) keptIdx.push(i);
  let doc;
  for (;;) {
    const res = applyOps(head.doc, kept);
    if (!res.error) { doc = res.doc; break; }
    let bad = firstFailing(head.doc, kept);
    if (bad < 0) bad = kept.length - 1;   // по одной проходят, вместе нет — виновата последняя
    const at = keptIdx[bad];
    dropped.push({ index: at, op: src[at], reason: 'invalid' });
    droppedIdx.add(at);
    kept = kept.filter((_, i) => i !== bad);
    keptIdx = keptIdx.filter((_, i) => i !== bad);
  }
  dropped.sort((a, b) => a.index - b.index);
  notes = notes.filter((n) => !droppedIdx.has(n.index));
  return { ops: kept, dropped, notes, doc, tombstones: collectTombstones(head.doc, kept) };
}

/**
 * @param {{
 *   storage: object,
 *   snapshotEvery?: number,
 *   idleMs?: number,
 *   log?: {warn:Function, info:Function}
 * }} opts
 */
export function createSequencer({ storage, snapshotEvery = 50, idleMs = IDLE_MS, log = console }) {
  /** @type {Map<string, object>} projectId → голова */
  const heads = new Map();
  /** @type {Map<string, Promise>} projectId → хвост очереди (мьютекс) */
  const locks = new Map();
  /** @type {Set<Function>} слушатели зафиксированных транзакций (Hub) */
  const listeners = new Set();
  /** @type {Set<Promise>} снимки в полёте — close() их дожидается */
  const pendingSnapshots = new Set();
  let closed = false;

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
    }
    head.head_seq = committed.seq;
    remember(head, committed);
  }

  /**
   * Догнать хранилище: прочитать всё после головы в памяти. `knownHeadSeq` —
   * номер из базы, если он известен; хвост короче него — дыра в журнале
   * (в норме не бывает: номер и запись ложатся одной транзакцией базы), голова
   * принимает номер, чтобы не крутиться на «stale» вечно.
   */
  async function catchUp(head, projectId, knownHeadSeq) {
    for (;;) {
      const page = await viaStorage(storage.txsAfter(projectId, head.head_seq, PAGE));
      for (const tx of page) absorb(head, projectId, tx);
      if (page.length < PAGE) break;
    }
    if (Number.isInteger(knownHeadSeq) && knownHeadSeq > head.head_seq) {
      log.warn(`[document/dslts] ${projectId}: в журнале нет записей ${head.head_seq + 1}..${knownHeadSeq} — голова принимает номер ${knownHeadSeq}`);
      head.head_seq = knownHeadSeq;
    }
  }

  function touch(projectId, head) {
    head.lastUsed = Date.now();
    if (head.timer) clearTimeout(head.timer);
    if (idleMs > 0) {
      head.timer = setTimeout(() => {
        withLock(projectId, () => {
          const cur = heads.get(projectId);
          if (cur === head && Date.now() - head.lastUsed >= idleMs) heads.delete(projectId);
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
      if (!project) throw new DocError(404, 'not-found', 'проект не найден');
      const snap = await viaStorage(storage.latestSnapshot(projectId));
      if (!snap) throw new DocError(503, 'unavailable', 'у проекта нет снимка — журнал не с чего переигрывать');
      if (snap.engine !== ENGINE_VERSION) {
        // миграция формата — системная транзакция (§8.3), а не тихая правка; пока её нет — предупреждаем
        log.warn(`[document/dslts] ${projectId}: снимок seq ${snap.seq} записан движком ${snap.engine}, сервер работает с ${ENGINE_VERSION}`);
      }
      head = { doc: snap.doc, head_seq: snap.seq, tombstones: new Map(), recent: [], byTx: new Map(), lastUsed: 0, timer: null };
      await catchUp(head, projectId, project.head_seq);
      heads.set(projectId, head);
    }
    touch(projectId, head);
    return head;
  }

  function scheduleSnapshot(projectId, seq, doc) {
    // после ответа: setImmediate отпускает текущий тик, запись идёт следующим
    const p = new Promise((resolve) => setImmediate(resolve))
      .then(() => storage.writeSnapshot(projectId, seq, doc, ENGINE_VERSION))
      .catch((e) => log.warn(`[document/dslts] ${projectId}: снимок seq ${seq} не записан: ${e && e.message}`))
      .finally(() => pendingSnapshots.delete(p));
    pendingSnapshots.add(p);
  }

  function emit(projectId, committed) {
    for (const fn of listeners) {
      try {
        fn(projectId, committed);
      } catch (e) {
        log.warn('[document/dslts] слушатель упал:', e && e.message);
      }
    }
  }

  return {
    /** Подписка на зафиксированные транзакции: `fn(projectId, Committed)` в порядке seq. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
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
        if (!(await viaStorage(storage.getProject(projectId)))) throw new DocError(404, 'not-found', 'проект не найден');
        throw e;
      }
      if (closed) throw new DocError(503, 'unavailable', 'сервис останавливается');
      return withLock(projectId, async () => {
        const head = await ensureHead(projectId);
        // tx_id известен → сохранённое (идемпотентность, §8.3). Здесь только память:
        // всё старше RECENT_LIMIT ловит UNIQUE(project_id, tx_id) в commitTx, а лишний
        // запрос к базе на каждую новую транзакцию — это круг ожидания на горячем пути
        const known = head.byTx.get(tx.tx_id);
        if (known) return { committed: known, existing: true };
        if (tx.base_seq > head.head_seq) {
          // клиент видел голову дальше нашей: возможно, писал другой экземпляр — сначала догоняем
          await catchUp(head, projectId);
          if (tx.base_seq > head.head_seq) {
            throw new DocError(400, 'bad-request', `base_seq ${tx.base_seq} впереди головы ${head.head_seq} — откройте проект заново`, { tx_id: tx.tx_id, head_seq: head.head_seq });
          }
        }
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          const merged = mergeIntoHead(head, tx);
          const record = { ...tx, ops: merged.ops, dropped: merged.dropped, notes: merged.notes };
          const res = await viaStorage(storage.commitTx(projectId, record, { expectSeq: head.head_seq + 1 }));
          if (res.status === 'missing') throw new DocError(404, 'not-found', 'проект не найден');
          if (res.status === 'existing') {
            // записал другой экземпляр (или гонка мимо памяти): голова могла отстать
            if (res.committed.seq > head.head_seq) await catchUp(head, projectId);
            return { committed: res.committed, existing: true };
          }
          if (res.status === 'stale') {
            // номер ушёл вперёд — писал другой экземпляр: перечитать хвост, слить заново
            await catchUp(head, projectId, res.head_seq);
            if (attempt >= 2) await new Promise((r) => setTimeout(r, Math.random() * RETRY_BACKOFF_MS * attempt));
            continue;
          }
          // надгробия пополняются ДО обновления документа — считались по прежней голове
          for (const [id, parent] of merged.tombstones) head.tombstones.set(id, parent);
          head.doc = merged.doc;
          head.head_seq = res.committed.seq;
          remember(head, res.committed);
          emit(projectId, res.committed);
          if (snapshotEvery > 0 && res.committed.seq % snapshotEvery === 0) scheduleSnapshot(projectId, res.committed.seq, head.doc);
          return { committed: res.committed, existing: false };
        }
        throw new DocError(503, 'unavailable', 'голову проекта двигает другой экземпляр — повторите позже');
      });
    },

    /**
     * Голова проекта (документ и номер) — тестам и отладке; загружает, если не
     * загружена, и догоняет хранилище: между записями другой экземпляр мог уйти
     * вперёд, а голова в памяти узнаёт об этом только на своей следующей записи.
     */
    async headOf(projectId) {
      return withLock(projectId, async () => {
        const head = await ensureHead(projectId);
        await catchUp(head, projectId);
        return { doc: head.doc, head_seq: head.head_seq, tombstones: new Map(head.tombstones), recent: head.recent.slice() };
      });
    },

    /** Загружена ли голова (после выгрузки по бездействию — нет). */
    isLoaded(projectId) {
      return heads.has(projectId);
    },

    /** Выгрузить голову сейчас (тесты выгрузки по бездействию не ждут 10 минут). */
    async unload(projectId) {
      return withLock(projectId, () => {
        const head = heads.get(projectId);
        if (head && head.timer) clearTimeout(head.timer);
        heads.delete(projectId);
      });
    },

    /** Дождаться снимков в полёте. */
    async flush() {
      await Promise.all([...pendingSnapshots]);
    },

    /** Остановка: новые транзакции — 503, снимки дописываются, таймеры сняты. */
    async close() {
      closed = true;
      for (const head of heads.values()) if (head.timer) clearTimeout(head.timer);
      await Promise.all([...locks.values()]);
      await Promise.all([...pendingSnapshots]);
      heads.clear();
    }
  };
}
