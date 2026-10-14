/**
 * Ошибка Orchestrator (SPEC §10.2): одна форма для HTTP-ответа и для SSE-события
 * `error`. Тело — `{error: true, code, message, retryable, detail?}`.
 *
 * Коды: bad_request 400 · not_found 404 · method_not_allowed 405 · too_large 413 ·
 * busy 429 · llm_failed 502 · document_failed 502 · llm_down 503 · document_down 503 ·
 * shutting_down 503 · worker_failed 500 · timeout 504 · engine 426 · cancelled (только SSE).
 */

export class OrchError extends Error {
  /**
   * @param {number} status HTTP-статус
   * @param {string} code машинный код
   * @param {string} message для человека, по-русски
   * @param {{retryable?: boolean, detail?: any, retryAfter?: number}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'OrchError';
    this.status = status;
    this.code = code;
    this.retryable = extra.retryable !== undefined ? !!extra.retryable : status === 429 || status >= 500;
    if (extra.detail !== undefined) this.detail = extra.detail;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
  }

  /** Тело ответа и SSE-события `error`. */
  body() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

export const badRequest = (message, detail) => new OrchError(400, 'bad_request', message, { retryable: false, detail });
export const notFound = (message) => new OrchError(404, 'not_found', message, { retryable: false });
export const documentDown = (message = 'Сервис документов недоступен — команда не выполнена. Правки не потеряны; попробуйте через несколько секунд.') =>
  new OrchError(503, 'document_down', message, { retryAfter: 5 });
export const llmDown = (message = 'Модель недоступна — команда не выполнена. Попробуйте позже или проверьте, что сервер модели запущен.') =>
  new OrchError(503, 'llm_down', message, { retryAfter: 10 });
export const llmUnconfigured = () => new OrchError(503, 'llm_down',
  'Модель не подключена: на сервере агента не задан адрес модели (LLM_BASE_URL). Команды оболочки работают, правки агентом — нет.',
  { retryAfter: 60 });
export const cancelled = () => new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false });

/** Всё, что не OrchError, — внутренний сбой: наружу общая фраза, подробности — в лог. */
export function toOrchError(e) {
  if (e instanceof OrchError) return e;
  return new OrchError(500, 'internal', 'Внутренняя ошибка агента', { retryable: true });
}
