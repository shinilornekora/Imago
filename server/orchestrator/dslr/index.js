/**
 * DSLR-клиент (SPEC §10.1, стрелки 4a/5a): стейт проекта и номер головы у Document service.
 *
 * Кеш по `(project, head_seq)`: первый раз — `GET /api/projects/:id` (снимок + хвост),
 * дальше — `GET …/ops?since=<кеш>`: пусто — стейт из кеша; есть транзакции — дотягиваем
 * их строгим `applyOps` (журнал хранит применённую форму, движок один, §8.3). `410`,
 * дыра в номерах или отказ applyOps — полное перечитывание.
 */

import { applyOps } from '../../../src/core.js';
import { notFound, OrchError } from '../errors.js';
import { DSLR_CACHE_PROJECTS } from '../limits.js';

const OPS_PAGE = 1000;

/**
 * @param {{doc: ReturnType<import('../docclient.js').createDocClient>, log?: object, cacheSize?: number}} o
 */
export function createDslrClient({ doc: net, log = console, cacheSize = DSLR_CACHE_PROJECTS }) {
  /** id → {seq, doc, project}; порядок вставки = давность использования. */
  const cache = new Map();
  const stats = { full: 0, incremental: 0, hits: 0 };

  const remember = (id, entry) => {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  };

  /** Хвост транзакций поверх документа; null — не легло (тогда читаем заново). */
  function replay(doc, seq, txs) {
    let cur = doc;
    let at = seq;
    for (const tx of txs) {
      if (!tx || tx.seq !== at + 1) return null;
      const res = applyOps(cur, Array.isArray(tx.ops) ? tx.ops : []);
      if (res.error) {
        log.warn(`[orchestrator/dslr] журнал не лёг на кеш (seq ${tx.seq}): ${res.error.message || res.error}`);
        return null;
      }
      cur = res.doc;
      at = tx.seq;
    }
    return { doc: cur, seq: at };
  }

  async function full(id, opts) {
    const r = await net.get(`/api/projects/${encodeURIComponent(id)}`, opts);
    if (r.status === 404) { cache.delete(id); throw notFound('Проект не найден'); }
    if (r.status !== 200 || !r.body || !r.body.snapshot || !r.body.snapshot.doc) {
      throw new OrchError(502, 'document_failed', `Document service ответил на чтение проекта ${r.status}`);
    }
    const { snapshot, tail = [], ...project } = r.body;
    const got = replay(snapshot.doc, snapshot.seq, tail);
    if (!got) throw new OrchError(502, 'document_failed', 'Стейт проекта не собрался из снимка и хвоста журнала');
    stats.full++;
    const entry = { seq: got.seq, doc: got.doc, project: summary(project, got.seq) };
    remember(id, entry);
    return entry;
  }

  /**
   * @param {string} id
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{seq: number, doc: object, project: {id, name, kind, head_seq}}>}
   */
  async function read(id, opts = {}) {
    const hit = cache.get(id);
    if (!hit) return full(id, opts);
    let { seq, doc } = hit;
    for (let page = 0; page < 100; page++) {
      const r = await net.get(`/api/projects/${encodeURIComponent(id)}/ops?since=${seq}&limit=${OPS_PAGE}`, opts);
      if (r.status === 404) { cache.delete(id); throw notFound('Проект не найден'); }
      if (r.status === 410) return full(id, opts);
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.txs)) return full(id, opts);
      const txs = r.body.txs;
      if (!txs.length) {
        if (r.body.head_seq !== seq) return full(id, opts);
        break;
      }
      const got = replay(doc, seq, txs);
      if (!got) return full(id, opts);
      doc = got.doc;
      seq = got.seq;
      if (txs.length < OPS_PAGE || seq >= r.body.head_seq) break;
    }
    if (seq === hit.seq) stats.hits++;
    else stats.incremental++;
    const entry = { seq, doc, project: { ...hit.project, head_seq: seq } };
    remember(id, entry);
    return entry;
  }

  /** Список проектов: [{id, name, kind, head_seq, updated_at}]. */
  async function list(opts = {}) {
    const r = await net.get('/api/projects', opts);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.projects)) {
      throw new OrchError(502, 'document_failed', `Document service ответил на список проектов ${r.status}`);
    }
    return r.body.projects;
  }

  return { read, list, stats, forget: (id) => cache.delete(id) };
}

function summary(p, seq) {
  return { id: p.id, name: p.name, kind: p.kind || 'design', head_seq: seq };
}
