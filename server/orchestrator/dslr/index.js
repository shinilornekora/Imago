/**
 * DSLR-клиент (SPEC §10.1, стрелки 4a/5a): стейт проекта и номер головы у Document service.
 *
 * Кеш на проект: `{seq, doc, chain, epoch}` — документ на своей голове, якорь этой головы
 * (`chain` её записи, §9.8) и эпоха, в которой он прочитан. Первый раз — `GET
 * /api/projects/:id` (снимок + первая страница хвоста; `more:true` — дочитываем хвост),
 * дальше — `GET …/ops?since=<seq>&tip=<chain>&epoch=<epoch>`: сервис сам сверяет якорь и
 * отдаёт хвост только тому, чей журнал цел. Страницы читаются, пока `more` (страница режется
 * и по числу, и по байтам — её длина ничего не говорит о конце).
 *
 * Каждая пришедшая запись проверяется: `seq` подряд, `chain = sha256(prev + tx_id + seq)`
 * от нашего якоря, строгий `applyOps` на кешированный документ (журнал хранит применённую
 * форму, движок один, §8.3). `410`, другая эпоха в ответе, чужой chain, голова позади кеша
 * или отказ applyOps — значит, журнал под нами переписан (откат базы, restore): кеш проекта
 * выбрасывается и стейт читается целиком заново. Иначе агент строил бы патч по документу,
 * которого в журнале больше нет.
 *
 * Чтения одного проекта идут по одному (цепочка промисов): параллельные DUIL и команда не
 * затирают кеш более старым стейтом.
 */

import { createHash } from 'node:crypto';
import { applyOps } from '../../../src/core.js';
import { notFound, OrchError } from '../errors.js';
import { DSLR_CACHE_PROJECTS, DOC_PAGE_LIMIT, DSLR_MAX_PAGES, DSLR_FULL_ATTEMPTS, DOC_RETRY_AFTER_MAX_S } from '../limits.js';

/** Якорь записи журнала (SPEC §9.8): sha256(prev_chain + tx_id + seq), hex. */
export function chainNext(prev, txId, seq) {
  return createHash('sha256').update(String(prev || '') + String(txId) + String(seq), 'utf8').digest('hex');
}

/** Сигнал «журнал под кешем переписан — читать заново». */
class Reset extends Error {
  constructor(why) {
    super(why);
    this.reset = true;
  }
}

/**
 * @param {{doc: ReturnType<import('../docclient.js').createDocClient>, log?: object, cacheSize?: number, pageLimit?: number}} o
 */
export function createDslrClient({ doc: net, log = console, cacheSize = DSLR_CACHE_PROJECTS, pageLimit = DOC_PAGE_LIMIT }) {
  /** id → {seq, doc, chain, epoch, project}; порядок вставки = давность использования. */
  const cache = new Map();
  /** id → хвост цепочки чтений этого проекта. */
  const lanes = new Map();
  const stats = { full: 0, incremental: 0, hits: 0, resets: 0, pages: 0 };

  const remember = (id, entry) => {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  };

  const path = (id) => `/api/projects/${encodeURIComponent(id)}`;

  /**
   * Хвост поверх состояния. Записи обязаны идти подряд от `st.seq`, их chain — продолжать
   * наш якорь (если он известен: сервис до §9.8 chain не отдавал), а операции — ложиться
   * строгим applyOps. Иначе — Reset.
   * @param {{seq:number, doc:object, chain:string|null}} st
   */
  function replay(st, txs) {
    let { seq, doc, chain } = st;
    for (const tx of txs) {
      if (!tx || tx.seq !== seq + 1) throw new Reset(`дыра в номерах журнала: ждали ${seq + 1}, пришла ${tx && tx.seq}`);
      if (typeof tx.chain === 'string' && tx.chain) {
        if (chain !== null && chainNext(chain, tx.tx_id, tx.seq) !== tx.chain) {
          throw new Reset(`запись ${tx.seq} не продолжает якорь кеша (журнал переписан)`);
        }
        chain = tx.chain;
      } else {
        chain = null;   // сверять дальше нечем
      }
      const res = applyOps(doc, Array.isArray(tx.ops) ? tx.ops : []);
      if (res.error) throw new Reset(`журнал не лёг на кеш (seq ${tx.seq}): ${res.error.message || res.error}`);
      doc = res.doc;
      seq = tx.seq;
    }
    return { seq, doc, chain };
  }

  /** Ответ, который не 200 и не 404/410, — сбой чтения. */
  const failed = (what, r) => new OrchError(502, 'document_failed', `Document service ответил на ${what} ${r.status}`);

  /** GET с ограниченным ожиданием по Retry-After при 503 (семафор тяжёлых чтений, §9.8). */
  async function get(url, opts) {
    for (let i = 0; ; i++) {
      try {
        return await net.get(url, opts);
      } catch (e) {
        const wait = e && e.docStatus === 503 && e.docRetryAfter ? Math.min(e.docRetryAfter, DOC_RETRY_AFTER_MAX_S) : 0;
        if (!wait || i >= 2 || (opts.signal && opts.signal.aborted)) throw e;
        await sleep(wait * 1000, opts.signal);
      }
    }
  }

  /**
   * Дочитать хвост страницами `ops?since=&tip=&epoch=` до конца (`more:false`).
   * @param {string} id
   * @param {{seq:number, doc:object, chain:string|null, epoch:string|null}} st
   */
  async function catchUp(id, st, opts) {
    let cur = { ...st };
    for (let page = 0; page < DSLR_MAX_PAGES; page++) {
      const q = new URLSearchParams({ since: String(cur.seq), limit: String(pageLimit) });
      if (cur.chain) q.set('tip', cur.chain);
      if (cur.epoch) q.set('epoch', cur.epoch);
      const r = await get(`${path(id)}/ops?${q}`, opts);
      stats.pages++;
      if (r.status === 404) throw notFound('Проект не найден');
      if (r.status === 410) throw new Reset('сервис документов ответил 410 — журнал с нашего места не догнать');
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.txs)) throw failed('чтение журнала', r);
      const b = r.body;
      if (cur.epoch && b.epoch && b.epoch !== cur.epoch) throw new Reset(`эпоха проекта сменилась (${cur.epoch} → ${b.epoch})`);
      const txs = b.txs;
      const head = Number.isInteger(b.head_seq) ? b.head_seq : null;
      if (!txs.length) {
        if (head !== null && head < cur.seq) throw new Reset(`голова журнала (${head}) позади кеша (${cur.seq})`);
        if (b.more === true || (head !== null && head > cur.seq)) throw new Reset('журнал обещает записи, но страница пуста');
        // голова на нашем месте — якорь обязан совпасть
        if (cur.chain && typeof b.tip === 'string' && b.tip && b.tip !== cur.chain) throw new Reset('якорь головы не совпал с кешем');
        return { ...cur, epoch: cur.epoch || b.epoch || null };
      }
      const got = replay(cur, txs);
      cur = { ...got, epoch: cur.epoch || b.epoch || null };
      // конец — по флагу `more` (страница режется и по байтам); сервис до §9.8 флага не знал
      const more = typeof b.more === 'boolean' ? b.more : head !== null && cur.seq < head;
      if (!more) return cur;
    }
    throw new OrchError(502, 'document_failed', 'Журнал проекта не дочитался: слишком много страниц');
  }

  /** Полное чтение: снимок + хвост (+ дочитывание по `more`). */
  async function full(id, opts) {
    const r = await get(path(id), opts);
    if (r.status === 404) throw notFound('Проект не найден');
    if (r.status !== 200 || !r.body || !r.body.snapshot || !r.body.snapshot.doc) throw failed('чтение проекта', r);
    const { snapshot, tail = [], more, ...project } = r.body;
    const base = {
      seq: snapshot.seq,
      doc: snapshot.doc,
      chain: typeof snapshot.chain === 'string' ? snapshot.chain : null,
      epoch: typeof project.epoch === 'string' && project.epoch ? project.epoch : null,
    };
    let st = { ...replay(base, Array.isArray(tail) ? tail : []), epoch: base.epoch };
    const head = Number.isInteger(project.head_seq) ? project.head_seq : st.seq;
    if (more === true || (more === undefined && st.seq < head)) st = await catchUp(id, st, opts);
    stats.full++;
    return { ...st, meta: project };
  }

  /** Прочитать заново целиком (ограниченно: журнал может переписываться прямо сейчас). */
  async function fresh(id, opts) {
    let last = null;
    for (let i = 0; i < DSLR_FULL_ATTEMPTS; i++) {
      try {
        const st = await full(id, opts);
        return { ...st, project: summary(st.meta, st.seq) };
      } catch (e) {
        if (!(e instanceof Reset)) throw e;
        last = e;
        stats.resets++;
        log.warn(`[orchestrator/dslr] ${id}: ${e.message} — читаю заново`);
      }
    }
    throw new OrchError(502, 'document_failed', `Стейт проекта не собрался: ${last ? last.message : 'журнал меняется под чтением'}`);
  }

  async function readNow(id, opts) {
    const hit = cache.get(id);
    let entry;
    if (!hit) {
      entry = await fresh(id, opts);
    } else {
      try {
        const st = await catchUp(id, hit, opts);
        if (st.seq === hit.seq) stats.hits++;
        else stats.incremental++;
        entry = { ...st, project: { ...hit.project, head_seq: st.seq } };
      } catch (e) {
        if (e && e.code === 'not_found') cache.delete(id);
        if (!(e instanceof Reset)) throw e;
        // журнал под кешем переписан: кеш проекта — вон, стейт — заново
        cache.delete(id);
        stats.resets++;
        log.warn(`[orchestrator/dslr] ${id}: ${e.message} — кеш выброшен, читаю целиком`);
        entry = await fresh(id, opts);
      }
    }
    remember(id, entry);
    return entry;
  }

  /**
   * Стейт проекта на голове журнала.
   * @param {string} id
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{seq: number, doc: object, chain: string|null, epoch: string|null, project: {id, name, kind, head_seq}}>}
   */
  function read(id, opts = {}) {
    const prev = lanes.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => readNow(id, opts)).catch((e) => {
      if (e && e.code === 'not_found') cache.delete(id);
      throw e;
    });
    const tail = run.catch(() => {});
    lanes.set(id, tail);
    tail.then(() => { if (lanes.get(id) === tail) lanes.delete(id); });
    return run;
  }

  /** Список проектов: [{id, name, kind, head_seq, updated_at}]. */
  async function list(opts = {}) {
    const r = await net.get('/api/projects', opts);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.projects)) throw failed('список проектов', r);
    return r.body.projects;
  }

  return {
    read, list, stats,
    forget: (id) => cache.delete(id),
    /** Для тестов и отладки: что лежит в кеше (без документа). */
    peek: (id) => { const e = cache.get(id); return e ? { seq: e.seq, chain: e.chain, epoch: e.epoch, doc: e.doc } : null; },
  };
}

function summary(p, seq) {
  return { id: p.id, name: p.name, kind: p.kind || 'design', head_seq: seq };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}
