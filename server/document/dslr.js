/**
 * DSLR — DSL Reader (SPEC §8.1): чтение проекта — снимок + хвост журнала = стейт
 * и номер головы. Читает только из хранилища, к голове секвенсора не
 * прикасается: клиент и Orchestrator получают ровно то, что записано, и
 * переигрывают хвост своим движком (§8.3 «журнал — источник истины»).
 */

import { DocError, viaStorage } from './errors.js';
import { projectSummary } from './storage/committed.js';

/** Страница чтения хвоста: длинный хвост (снимок не записался) читается кусками. */
const PAGE = 500;
/** Верхняя граница `limit` в `ops?since=`. */
export const MAX_LIMIT = 5000;

export function createReader({ storage }) {
  /** Хвост журнала после `seq` целиком, страницами. */
  async function tailAfter(projectId, seq) {
    const out = [];
    let from = seq;
    for (;;) {
      const page = await viaStorage(storage.txsAfter(projectId, from, PAGE));
      for (const tx of page) out.push(tx);
      if (page.length < PAGE) break;
      from = page[page.length - 1].seq;
    }
    return out;
  }

  async function project(projectId) {
    const p = await viaStorage(storage.getProject(projectId));
    if (!p) throw new DocError(404, 'not-found', 'проект не найден');
    return p;
  }

  return {
    /**
     * Открыть проект (SPEC §9.2 `GET /api/projects/:id`): последний снимок и все
     * транзакции после него. `head_seq` — не меньше последнего seq хвоста: между
     * чтением проекта и чтением хвоста могла лечь новая транзакция, и хвост
     * длиннее объявленной головы сбил бы клиента с толку.
     */
    async open(projectId) {
      const p = await project(projectId);
      const snapshot = await viaStorage(storage.latestSnapshot(projectId));
      if (!snapshot) throw new DocError(503, 'unavailable', 'у проекта нет снимка — журнал не с чего переигрывать');
      const tail = await tailAfter(projectId, snapshot.seq);
      const head_seq = Math.max(p.head_seq, tail.length ? tail[tail.length - 1].seq : snapshot.seq);
      return {
        project: { ...projectSummary(p), head_seq },
        snapshot: { seq: snapshot.seq, doc: snapshot.doc, engine: snapshot.engine },
        tail
      };
    },

    /**
     * Догон (SPEC §9.2 `ops?since=`, §9.3 `hello` → `tx`…): транзакции с
     * `seq > since`. `gone` — когда с `since` догнать нельзя и клиенту нужен
     * снимок: `since < 0` (клиент ничего не знает), `since` впереди головы
     * (проект пересоздан под тем же id — у клиента номера, которых сервер не
     * выдавал) или хвост не начинается сразу за `since` (операции старше
     * унесены чисткой — §8.3; в этом круге чистки нет, ветка заложена).
     * @param {string} projectId
     * @param {number} since
     * @param {number} [limit]
     * @returns {Promise<{head_seq:number, txs:object[]}|{gone:true, head_seq:number, snapshot:object}>}
     */
    async since(projectId, since, limit = PAGE) {
      const p = await project(projectId);
      const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || PAGE));
      const gone = async () => {
        const snapshot = await viaStorage(storage.latestSnapshot(projectId));
        if (!snapshot) throw new DocError(503, 'unavailable', 'у проекта нет снимка');
        return {
          gone: true,
          head_seq: Math.max(p.head_seq, snapshot.seq),
          snapshot: { seq: snapshot.seq, doc: snapshot.doc, engine: snapshot.engine }
        };
      };
      if (since < 0 || since > p.head_seq) return gone();
      const txs = await viaStorage(storage.txsAfter(projectId, since, lim));
      if (txs.length && txs[0].seq !== since + 1) return gone();
      const head_seq = Math.max(p.head_seq, txs.length ? txs[txs.length - 1].seq : since);
      return { head_seq, txs };
    },

    /** Сводка проекта или 404. */
    project
  };
}
