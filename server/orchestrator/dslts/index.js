/**
 * DSLTS-клиент (SPEC §10.1, стрелки 12/13): запись транзакции агента в Document service.
 *
 * `POST /api/projects/:id/tx`. Сервис идемпотентен по `(project, tx_id)` и на повтор
 * отвечает `200` с уже записанным `Committed` (§8.3) — поэтому любой повтор идёт с ТЕМ ЖЕ
 * `tx_id`, двойной записи не бывает:
 *
 *   сеть / 5xx      → повтор (ограниченно, `WRITE_ATTEMPTS`); у 503 с `Retry-After` ждём
 *                     указанный срок (не дольше `DOC_RETRY_AFTER_MAX_S`, всего —
 *                     `WRITE_WAIT_BUDGET_MS`), иначе — короткая пауза с ростом;
 *   413             → `too_large`, без повтора: правка больше предела сервиса;
 *   426             → `engine`: версии движка агента и сервиса разошлись;
 *   404             → `not_found`; прочие 4xx → `document_failed` без повтора.
 *
 * До сети: транзакция больше пределов сервиса (операций > 5000 или тело > 4 МБ, §9.8)
 * не отправляется вовсе — ошибка `too_large` с объяснением человеку. Резать её на части
 * агент не станет: половина правки в журнале хуже, чем никакой (отменяется не целиком,
 * видна другим недоделанной).
 */

import { OrchError, notFound, documentDown } from '../errors.js';
import { WRITE_ATTEMPTS, DOC_RETRY_AFTER_MAX_S, WRITE_WAIT_BUDGET_MS, DOC_MAX_OPS_PER_TX, DOC_MAX_BODY_BYTES } from '../limits.js';
import { cutText } from '../../../src/core.js';

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};

/** Правка больше предела сервиса — ошибка для человека (§10.2 `413 too_large`). */
export function tooLarge(limit, { ops, bytes, max } = {}) {
  const msg = limit === 'ops_per_tx'
    ? `Правка слишком большая: ${ops} ${plural(ops, 'операция', 'операции', 'операций')} при пределе ${max} на одну запись. `
      + 'Ничего не записано. Разбейте команду на части — например, по доскам или по блокам.'
    : limit === 'body_bytes'
      ? `Правка слишком большая: ${Math.ceil(bytes / 1024)} КБ при пределе ${Math.floor(max / 1024)} КБ на одну запись. `
        + 'Ничего не записано. Разбейте команду на части или уберите из неё длинные тексты и картинки.'
      : 'Правка больше, чем сервис документов принимает за один раз. Ничего не записано. Разбейте команду на части.';
  return new OrchError(413, 'too_large', msg, { retryable: false, detail: { limit, ...(max ? { max } : {}) } });
}

/** Проверка пределов до сети. null — годится. */
export function checkTx(tx, { maxOps = DOC_MAX_OPS_PER_TX, maxBytes = DOC_MAX_BODY_BYTES } = {}) {
  const n = Array.isArray(tx && tx.ops) ? tx.ops.length : 0;
  if (n > maxOps) return tooLarge('ops_per_tx', { ops: n, max: maxOps });
  const bytes = Buffer.byteLength(JSON.stringify(tx), 'utf8');
  if (bytes > maxBytes) return tooLarge('body_bytes', { bytes, max: maxBytes });
  return null;
}

/**
 * @param {{doc: ReturnType<import('../docclient.js').createDocClient>, attempts?: number, backoffMs?: number,
 *   retryAfterMaxS?: number, waitBudgetMs?: number, log?: object}} o
 */
export function createDsltsClient({
  doc: net, attempts = WRITE_ATTEMPTS, backoffMs = 300, retryAfterMaxS = DOC_RETRY_AFTER_MAX_S,
  waitBudgetMs = WRITE_WAIT_BUDGET_MS, log = console,
}) {
  const stats = { commits: 0, retries: 0, waitedMs: 0 };

  /**
   * @param {string} projectId
   * @param {object} tx Tx (§9.1)
   * @returns {Promise<object>} Committed
   */
  async function commit(projectId, tx) {
    const big = checkTx(tx);
    if (big) throw big;
    let last = null;
    let waited = 0;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        // 503 с Retry-After — ждём, сколько просили (с потолком); иначе — короткая пауза с ростом
        const asked = last && last.docStatus === 503 && last.docRetryAfter !== null && last.docRetryAfter !== undefined
          ? Math.min(last.docRetryAfter, retryAfterMaxS) * 1000
          : backoffMs * i;
        const ms = Math.max(0, Math.min(asked, waitBudgetMs - waited));
        if (asked > 0 && ms <= 0) break;   // бюджет ожидания исчерпан
        waited += ms;
        stats.retries++;
        stats.waitedMs += ms;
        await new Promise((r) => setTimeout(r, ms));
      }
      let r;
      try {
        r = await net.post(`/api/projects/${encodeURIComponent(projectId)}/tx`, tx);
      } catch (e) {
        last = e;
        const why = e.docStatus ? `ответ ${e.docStatus}${e.docRetryAfter != null ? `, Retry-After ${e.docRetryAfter} с` : ''}` : (e.detail && e.detail.cause) || e.message;
        log.warn(`[orchestrator/dslts] запись ${tx.tx_id} не дошла (попытка ${i + 1} из ${attempts}): ${why}`);
        continue;
      }
      if (r.status === 201 || r.status === 200) { stats.commits++; return r.body; }
      if (r.status === 404) throw notFound('Проект не найден — записывать некуда');
      if (r.status === 413) {
        const d = (r.body && r.body.detail) || {};
        throw tooLarge(d.limit, { ops: (tx.ops || []).length, bytes: Buffer.byteLength(JSON.stringify(tx), 'utf8'), max: d.max });
      }
      if (r.status === 426) {
        throw new OrchError(426, 'engine', 'Версия движка агента и сервиса документов разошлась — нужно обновить сервер агента', {
          retryable: false, detail: { engine: r.body && r.body.engine },
        });
      }
      throw new OrchError(502, 'document_failed', `Сервис документов не принял правку агента (${r.status})${r.body && r.body.message ? ': ' + cutText(r.body.message, 300) : ''}`, { retryable: false });
    }
    if (last && last.code === 'document_down') {
      last.message = 'Сервис документов не подтвердил правку агента — он перегружен или недоступен. Повторите команду через несколько секунд.';
      throw last;
    }
    throw last || documentDown();
  }

  return { commit, stats };
}
