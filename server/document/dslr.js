/**
 * DSLR — DSL Reader (SPEC §8.1, §9.8): чтение проекта — снимок + хвост журнала =
 * стейт и номер головы. Читает только из хранилища, к голове секвенсора не
 * прикасается: клиент и Orchestrator получают ровно то, что записано, и
 * переигрывают хвост своим движком (§8.3 «журнал — источник истины»).
 *
 * Хвост отдаётся страницами, ограниченными числом записей и (мягко) байтами:
 * `more: true` — за страницей есть ещё. Полный снимок большого проекта — тяжёлое
 * чтение: идёт под семафором; очередь переполнена → 503 `busy` + Retry-After.
 *
 * Проверка якоря (`classify`): клиент присылает `since`, `tip` (chain своей
 * последней подтверждённой) и `epoch`; ответ — можно ли догонять хвостом или
 * нужен снимок, и не след ли это отката базы.
 */

import { DocError, notFound, unavailable, viaStorage, noSnapshot } from './errors.js';
import { headSummary } from './storage/committed.js';
import { flatTombstones } from './dslts.js';
import { CODE_ENGINE, engineUnreadable, engineError } from './engine.js';
import { PAGE_TXS, MAX_LIMIT as LIMIT_MAX, PAGE_BYTES, HEAVY_CONCURRENCY, HEAVY_QUEUE, RETRY_AFTER_S, SNAPSHOT_CACHE_BYTES } from './limits.js';

/** Верхняя граница `limit` в `ops?since=` (совместимость: прежде экспортировалась отсюда). */
export const MAX_LIMIT = LIMIT_MAX;

/**
 * Семафор тяжёлых чтений: `max` одновременно, `queue` ждут, остальным — 503 busy.
 * @param {{max?: number, queue?: number, retryAfter?: number, message?: string}} [o]
 */
export function createSemaphore({ max = HEAVY_CONCURRENCY, queue = HEAVY_QUEUE, retryAfter = RETRY_AFTER_S, message = 'сервер занят чтением больших проектов — повторите чуть позже' } = {}) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  };
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    async run(fn) {
      if (active >= max) {
        if (waiting.length >= queue) {
          throw new DocError(503, 'busy', message, { retryable: true, retryAfter });
        }
        await new Promise((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}

/**
 * @param {{storage: object, heavy?: ReturnType<typeof createSemaphore>, pageBytes?: number, snapshotCacheBytes?: number, engine?: number}} deps
 *   `snapshotCacheBytes` — кеш сериализованных снимков полного открытия (круг 33; 0 — без кеша);
 *   `engine` — версия движка экземпляра (круг 39): снимок или запись журнала движка, которого
 *   экземпляр не читает (новее), не отдаётся — 503 `cause:'engine'`: клиент этой версии
 *   переиграл бы их без чужих слоёв
 */
export function createReader({ storage, heavy = createSemaphore(), pageBytes = PAGE_BYTES, snapshotCacheBytes = SNAPSHOT_CACHE_BYTES, engine = CODE_ENGINE }) {
  /** Записанное движком, которого экземпляр не читает, — 503 engine (круг 39). */
  const guard = (found) => {
    if (engineUnreadable(found, engine)) throw engineError(found, engine);
  };
  const guardTxs = (txs) => {
    for (const t of txs) guard(t && t.engine);
    return txs;
  };

  async function project(projectId) {
    const p = await viaStorage(storage.getProject(projectId));
    if (!p) throw notFound();
    return p;
  }

  /** Страница хвоста после `seq`: не больше `limit` записей и `pageBytes` байт. */
  async function page(projectId, seq, limit = PAGE_TXS) {
    return guardTxs(await viaStorage(storage.txsAfter(projectId, seq, limit, { maxBytes: pageBytes })));
  }

  /** Снимок под семафором тяжёлых чтений. */
  async function snapshotOf(projectId) {
    return heavy.run(async () => {
      const snapshot = await viaStorage(storage.latestSnapshot(projectId));
      if (!snapshot) throw noSnapshot(storage);
      guard(snapshot.engine);
      return snapshot;
    });
  }

  // надгробия снимка (§9.10) — клиенту для прогноза слияния, плоско `{id: parent}` (v1:
  // реплика любой версии читает её; номера удаления клиенту не нужны); пустые и
  // неизвестные (`null`, снимок прежнего экземпляра) не отдаём
  const snapOut = (s) => {
    const out = { seq: s.seq, doc: s.doc, engine: s.engine, chain: s.chain || '' };
    const flat = flatTombstones(s.tombstones);
    if (flat && Object.keys(flat).length) out.tombstones = flat;
    return out;
  };

  /**
   * Кеш сериализованных снимков (круг 33): полное открытие большого проекта читало снимок из
   * базы и сериализовало его в JSON на каждый запрос — 30 одновременных открытий проекта в 20
   * тыс. узлов делали это 30 раз. Ключ — (проект, seq, chain, эпоха) последнего годного снимка
   * (его мета читается без документа); одинаковые открытия в полёте ждут одно чтение. Байты —
   * не больше snapshotCacheBytes на экземпляр (LRU), снимок больше четверти бюджета не
   * кешируется (но одновременные открытия всё равно делят одно чтение).
   */
  const snapCache = new Map();   // ключ → {json, bytes}
  const isoAt = (v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : '');
  let snapCacheBytes = 0;
  const snapLoading = new Map(); // ключ → промис {seq, json}
  const snapStats = { hits: 0, loads: 0, shared: 0 };
  // created_at — переписанный на том же seq снимок (надгробия прибавились) получает новое время
  const snapKey = (projectId, seq, chain, epoch, at) => `${projectId}\u0000${seq}\u0000${chain || ''}\u0000${epoch || ''}\u0000${at || ''}`;
  function snapPut(key, json) {
    const bytes = json.length * 2;
    if (snapshotCacheBytes <= 0 || bytes > snapshotCacheBytes / 4) return;
    const had = snapCache.get(key);
    if (had) { snapCache.delete(key); snapCacheBytes -= had.bytes; }
    snapCache.set(key, { json, bytes });
    snapCacheBytes += bytes;
    for (const [k, v] of snapCache) {
      if (snapCacheBytes <= snapshotCacheBytes) break;
      snapCache.delete(k);
      snapCacheBytes -= v.bytes;
    }
  }
  /** Снимок для полного открытия — `{seq, json}` (json — `snapOut` строкой). */
  async function snapshotJson(projectId) {
    const load = async () => {
      const s = await snapshotOf(projectId);
      snapStats.loads += 1;
      return { seq: s.seq, chain: s.chain || '', at: isoAt(s.created_at), json: JSON.stringify(snapOut(s)) };
    };
    if (snapshotCacheBytes <= 0 || typeof storage.latestSnapshotMeta !== 'function') {
      const r = await load();
      return { seq: r.seq, json: r.json };
    }
    const meta = await viaStorage(storage.latestSnapshotMeta(projectId));
    if (!meta) throw noSnapshot(storage);
    guard(meta.engine);
    const key = snapKey(projectId, meta.seq, meta.chain, meta.epoch, isoAt(meta.created_at));
    const hit = snapCache.get(key);
    if (hit) {
      snapCache.delete(key);
      snapCache.set(key, hit);
      snapStats.hits += 1;
      return { seq: meta.seq, json: hit.json };
    }
    let flight = snapLoading.get(key);
    if (flight) {
      snapStats.shared += 1;
    } else {
      flight = load().then((r) => {
        // ключ — по тому снимку, что прочитан (между метой и чтением мог лечь новый)
        snapPut(snapKey(projectId, r.seq, r.chain, meta.epoch, r.at), r.json);
        return r;
      });
      snapLoading.set(key, flight);
      flight.finally(() => { if (snapLoading.get(key) === flight) snapLoading.delete(key); }).catch(() => {});
    }
    const r = await flight;
    return { seq: r.seq, json: r.json };
  }

  /**
   * Мета последнего снимка без документа (I2): `latestSnapshotMeta` хранилища не читает
   * jsonb документа. Хранилище прежней версии его не знает — полный снимок, но под
   * семафором тяжёлых чтений: шторм `?lean=1` по большому проекту иначе занимал все
   * соединения пула и останавливал запись в другие проекты.
   */
  async function snapshotMeta(projectId) {
    if (typeof storage.latestSnapshotMeta === 'function') {
      const m = await viaStorage(storage.latestSnapshotMeta(projectId));
      if (m) {
        guard(m.engine);
        return m;
      }
      throw noSnapshot(storage, 'у проекта нет снимка');
    }
    return snapshotOf(projectId);
  }

  return {
    heavy,

    /** Кеш снимков (тестам): попадания, чтения, разделённые чтения, байты и записи. */
    snapshotCacheStats() {
      return { ...snapStats, bytes: snapCacheBytes, entries: snapCache.size };
    },

    /** Сводка головы (`?head=1`): {id, name, kind, head_seq, updated_at, epoch, tip}. */
    async head(projectId) {
      return headSummary(await project(projectId));
    },

    /**
     * Открыть проект (SPEC §9.2 `GET /api/projects/:id`): последний снимок и
     * транзакции после него — первой страницей; `more` — дальше ещё есть (клиент
     * дочитывает `ops?since=` или сокетом). `lean` — без документа снимка (только
     * {seq, chain, engine}) и хвост после `since` (по умолчанию — после снимка):
     * тому, у кого стейт уже есть. `head_seq` — не меньше последнего seq хвоста.
     * @param {string} projectId
     * @param {{lean?: boolean, since?: number}} [opts]
     */
    async open(projectId, opts = {}) {
      const p = await project(projectId);
      if (opts.lean) {
        const snap = await snapshotMeta(projectId);
        const from = Number.isInteger(opts.since) ? opts.since : snap.seq;
        const tail = await page(projectId, from);
        const last = tail.length ? tail[tail.length - 1].seq : from;
        const head_seq = Math.max(p.head_seq, last);
        return {
          project: { ...headSummary(p), head_seq },
          snapshot: { seq: snap.seq, engine: snap.engine, chain: snap.chain || '' },
          tail,
          more: last < head_seq
        };
      }
      // круг 33: снимок — готовой строкой JSON из кеша (или одним чтением на все одновременные)
      const snap = await snapshotJson(projectId);
      const tail = await page(projectId, snap.seq);
      const last = tail.length ? tail[tail.length - 1].seq : snap.seq;
      const head_seq = Math.max(p.head_seq, last);
      let parsed;
      return {
        project: { ...headSummary(p), head_seq },
        /** JSON снимка — http.js вставляет его в ответ как есть */
        snapshotJson: snap.json,
        /** объект снимка — по требованию (разбор строки) */
        get snapshot() { return parsed || (parsed = JSON.parse(snap.json)); },
        tail,
        more: last < head_seq
      };
    },

    /**
     * Можно ли догонять клиента хвостом с `since` (SPEC §9.8):
     *   'tail'     — да (tip совпал, или его нет и эпоха не мешает);
     *   'clamp'    — since < 0 или впереди головы: снимок, эпоха не меняется;
     *   'old'      — эпоха клиента известна базе, но не нынешняя, а tip не сверить
     *                или не совпал: снимок, эпоха не меняется;
     *   'evidence' — tip не совпал при нынешней эпохе или эпохи клиента база не
     *                знает: снимок, и это след отката (секвенсор решит, менять ли эпоху).
     * Клиент без tip и без epoch (прежний) — только по номерам, как раньше.
     * @param {string} projectId
     * @param {{since:number, tip?:string, epoch?:string}} q
     * @param {{head_seq:number, epoch:string}} head сверенная голова
     * @returns {Promise<'tail'|'clamp'|'old'|'evidence'>}
     */
    async classify(projectId, { since, tip, epoch }, head) {
      if (since < 0 || since > head.head_seq) return 'clamp';
      const hasTip = typeof tip === 'string' && tip !== '';
      const hasEpoch = typeof epoch === 'string' && epoch !== '';
      if (hasTip && since > 0) {
        const chain = await viaStorage(storage.chainAt(projectId, since));
        if (chain === null) return 'clamp';
        if (chain === tip) return 'tail';
        if (!hasEpoch || epoch === head.epoch) return 'evidence';
        return (await viaStorage(storage.knownEpoch(projectId, epoch))) ? 'old' : 'evidence';
      }
      if (hasEpoch && epoch !== head.epoch) {
        // сверить нечем (since 0 — сверять нечего: с нуля догоняется любой)
        if (since === 0) return 'tail';
        return (await viaStorage(storage.knownEpoch(projectId, epoch))) ? 'old' : 'evidence';
      }
      return 'tail';
    },

    /**
     * Догон (SPEC §9.2 `ops?since=`, §9.3 `hello` → `tx`…): страница транзакций с
     * `seq > since`. `gone` — когда с `since` догнать нельзя и клиенту нужен снимок
     * (since < 0, впереди головы, хвост не начинается сразу за since или пуст при
     * голове впереди since).
     * @param {string} projectId
     * @param {number} since
     * @param {number} [limit]
     * @returns {Promise<{head_seq:number, txs:object[], more:boolean, project:object}|{gone:true, head_seq:number, snapshot:object, project:object}>}
     */
    async since(projectId, since, limit = PAGE_TXS) {
      const p = await project(projectId);
      const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || PAGE_TXS));
      if (since < 0 || since > p.head_seq) return this.gone(projectId, p);
      const txs = await page(projectId, since, lim);
      // хвост не начинается сразу за since — или его нет вовсе, хотя голова впереди
      // (записи журнала потеряны): догнать нечем, только снимок. Иначе `more: true` с
      // пустой страницей — и догоняющий крутился бы на месте
      if (txs.length ? txs[0].seq !== since + 1 : since < p.head_seq) return this.gone(projectId, p);
      const last = txs.length ? txs[txs.length - 1].seq : since;
      const head_seq = Math.max(p.head_seq, last);
      return { head_seq, txs, more: last < head_seq, project: p };
    },

    /** Снимок для `gone`/`410` (под семафором). */
    async gone(projectId, p) {
      const proj = p || await project(projectId);
      const snapshot = await snapshotOf(projectId);
      return { gone: true, head_seq: Math.max(proj.head_seq, snapshot.seq), snapshot: snapOut(snapshot), project: proj };
    },

    /** Сводка проекта или 404. */
    project
  };
}
