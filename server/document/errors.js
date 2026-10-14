/**
 * Ошибка сервиса (SPEC §9.8): одно тело для всех ответов и обоих транспортов —
 * `{error: true, code, message, retryable, detail?}`. HTTP кладёт его в тело
 * (и `Retry-After`, когда ошибку стоит повторить позже), сокет — в
 * `{type:'error', …то же…}`. Всё, что не DocError, — сбой, а не ответ:
 * транспорт отвечает 500 `internal` и пишет в лог.
 *
 * Коды: bad_request 400 · forbidden 403 · not_found 404 · method_not_allowed 405 ·
 * gone 410 · too_large 413 · engine 426 · internal 500 · unavailable 503 · busy 503.
 *
 * `compat` — поля, которые прежние клиенты читали с верхнего уровня тела
 * (`engine` у 426, `snapshot`/`head_seq` у 410, `tx_id`): они остаются там же.
 */
export class DocError extends Error {
  /**
   * @param {number} status HTTP-статус
   * @param {string} code машинный код (snake_case)
   * @param {string} message для человека
   * @param {{retryable?: boolean, detail?: any, retryAfter?: number, compat?: object}} [opts]
   */
  constructor(status, code, message, opts = {}) {
    super(message);
    this.name = 'DocError';
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable !== undefined ? !!opts.retryable : status >= 500 || status === 429;
    this.detail = opts.detail;
    this.retryAfter = opts.retryAfter;
    this.compat = opts.compat || null;
  }

  /** Тело ответа. */
  body() {
    const out = { error: true, code: this.code, message: this.message, retryable: this.retryable };
    if (this.detail !== undefined) out.detail = this.detail;
    if (this.retryAfter !== undefined) out.retry_after = this.retryAfter;
    return { ...(this.compat || {}), ...out };
  }
}

export const badRequest = (message, opts) => new DocError(400, 'bad_request', message, { retryable: false, ...opts });
export const notFound = (message = 'проект не найден') => new DocError(404, 'not_found', message, { retryable: false });
export const tooLarge = (message, opts) => new DocError(413, 'too_large', message, { retryable: false, ...opts });
export const unavailable = (message, opts) => new DocError(503, 'unavailable', message, { retryable: true, retryAfter: 1, ...opts });

/** Тело для не-DocError: внутренняя ошибка. */
export function internalBody() {
  return { error: true, code: 'internal', message: 'внутренняя ошибка', retryable: true };
}

/**
 * Сбой хранилища → 503 «хранилище недоступно» (клиент держит очередь, SPEC §9.2).
 * DocError проходит как есть — это уже ответ, а не сбой. Дедлайн запроса
 * (statement_timeout / query_timeout) — тоже 503, с `detail.cause = 'timeout'`.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<T>}
 */
export async function viaStorage(p) {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DocError) throw e;
    const msg = e && e.message ? e.message : String(e);
    const timeout = (e && e.code === '57014') || /timeout/i.test(msg);
    throw unavailable('хранилище недоступно' + (timeout ? ': запрос не уложился в дедлайн' : ''), { detail: { cause: timeout ? 'timeout' : 'storage' } });
  }
}
