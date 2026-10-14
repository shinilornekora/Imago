/**
 * DSLTS-клиент (SPEC §10.1, стрелки 12/13): запись транзакции агента в Document service.
 *
 * `POST /api/projects/:id/tx`; при сетевой ошибке или 5xx — повтор с ТЕМ ЖЕ `tx_id`
 * (ограниченно): сервер идемпотентен по `(project, tx_id)` и на повтор отвечает
 * `200` с уже записанным `Committed` (§8.3) — двойной записи не бывает.
 */

import { OrchError, notFound, documentDown } from '../errors.js';
import { WRITE_ATTEMPTS } from '../limits.js';

/**
 * @param {{doc: ReturnType<import('../docclient.js').createDocClient>, attempts?: number, backoffMs?: number, log?: object}} o
 */
export function createDsltsClient({ doc: net, attempts = WRITE_ATTEMPTS, backoffMs = 300, log = console }) {
  /**
   * @param {string} projectId
   * @param {object} tx Tx (§9.1)
   * @returns {Promise<object>} Committed
   */
  async function commit(projectId, tx) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, backoffMs * i));
      let r;
      try {
        r = await net.post(`/api/projects/${encodeURIComponent(projectId)}/tx`, tx);
      } catch (e) {
        last = e;
        log.warn(`[orchestrator/dslts] запись ${tx.tx_id} не дошла (попытка ${i + 1} из ${attempts}): ${e.detail && e.detail.cause ? e.detail.cause : e.message}`);
        continue;
      }
      if (r.status === 201 || r.status === 200) return r.body;
      if (r.status === 404) throw notFound('Проект не найден — записывать некуда');
      if (r.status === 426) {
        throw new OrchError(426, 'engine', 'Версия движка агента и сервиса документов разошлась — нужно обновить сервер агента', {
          retryable: false, detail: { engine: r.body && r.body.engine },
        });
      }
      throw new OrchError(502, 'document_failed', `Сервис документов не принял правку агента (${r.status})${r.body && r.body.message ? ': ' + String(r.body.message).slice(0, 300) : ''}`, { retryable: false });
    }
    throw last || documentDown();
  }

  return { commit };
}
