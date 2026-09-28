/**
 * Ошибка сервиса с HTTP-статусом и кодом (SPEC §9.2, §9.3): одна форма для
 * обоих транспортов — http.js кладёт её в статус и тело, hub.js — в
 * `{type:'error', code, message}`. Всё, что не DocError, — сбой, а не ответ:
 * транспорт отвечает 500 и пишет в лог.
 */
export class DocError extends Error {
  /**
   * @param {number} status HTTP-статус
   * @param {string} code машинный код: not-found · bad-request · engine · unavailable · too-large
   * @param {string} message для человека
   * @param {object} [extra] дополнительные поля тела (например, `engine` для 426)
   */
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'DocError';
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }

  /** Тело ответа: `{error: code, message, …extra}`. */
  body() {
    return { error: this.code, message: this.message, ...(this.extra || {}) };
  }
}

/**
 * Сбой хранилища → 503 «хранилище недоступно» (клиент держит очередь, SPEC §9.2).
 * DocError проходит как есть — это уже ответ, а не сбой.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<T>}
 */
export async function viaStorage(p) {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DocError) throw e;
    throw new DocError(503, 'unavailable', 'хранилище недоступно: ' + (e && e.message ? e.message : String(e)));
  }
}
