/**
 * Ошибка сервиса (SPEC §9.8): одно тело для всех ответов и обоих транспортов —
 * `{error: true, code, message, retryable, detail?}`. HTTP кладёт его в тело
 * (и `Retry-After`, когда ошибку стоит повторить позже), сокет — в
 * `{type:'error', …то же…}`. Всё, что не DocError, — сбой, а не ответ:
 * транспорт отвечает 500 `internal` и пишет в лог.
 *
 * Коды: bad_request 400 · forbidden 403 · not_found 404 · method_not_allowed 405 ·
 * gone 410 · too_large 413 · engine 426 · internal 500 · unavailable 503 · busy 503 ·
 * migrating 503 (идут миграции базы, SPEC §9.11).
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
/** Сервис занят (очередь полна или не дождались места) — повторить чуть позже. */
export const busy = (message, opts) => new DocError(503, 'busy', message, { retryable: true, retryAfter: 1, ...opts });

/** Тело для не-DocError: внутренняя ошибка. */
export function internalBody() {
  return { error: true, code: 'internal', message: 'внутренняя ошибка', retryable: true };
}

/** Куда viaStorage пишет причину 503 (и 400 от данных): index.js ставит лог сервиса. */
let storageLog = console;
/** @param {{warn: Function}} log */
export function setStorageLog(log) {
  storageLog = log && typeof log.warn === 'function' ? log : console;
}

/** Одна строка лога: без переводов строк и не длиннее 200 символов (данные пользователя целиком не пишем). */
function oneLine(s) {
  const t = String(s || '').replace(/[\r\n\t]+/g, ' ');
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}

/** Одинаковые строки лога — не чаще раза в секунду, остальные считаются и называются следующей. */
const lastLine = { text: '', at: 0, skipped: 0 };
function logOnce(text) {
  const now = Date.now();
  if (text === lastLine.text && now - lastLine.at < 1000) {
    lastLine.skipped++;
    return;
  }
  const skipped = lastLine.skipped;
  lastLine.text = text;
  lastLine.at = now;
  lastLine.skipped = 0;
  try {
    storageLog.warn(text + (skipped ? ` (и ещё ${skipped} таких за секунду до этого)` : ''));
  } catch (_) { /* лог — не наша забота */ }
}

/**
 * Данные, которые база не хранит (класс SQLSTATE 22 — data exception): ответ
 * клиенту, а не сбой хранилища. Повтор той же транзакции дал бы ту же ошибку, поэтому
 * `retryable: false` — клиент снимает её с очереди, а не держит за ней всю очередь.
 */
const DATA_ERRORS = {
  '22P05': 'строка содержит символ, который база не хранит (\\u0000)',
  '22021': 'строка содержит недопустимый символ (NUL или битый UTF-8)',
  '22P02': 'значение в неверном для базы формате (битая строка или число не того вида)',
  '22003': 'число вне допустимого диапазона',
  '22001': 'строка длиннее допустимого'
};

/** Код ошибки Postgres — класс 22 (data exception)? */
export function isDataError(e) {
  return !!(e && typeof e.code === 'string' && /^22[0-9A-Z]{3}$/.test(e.code));
}

/**
 * Сбой хранилища → 503 «хранилище недоступно» (клиент держит очередь, SPEC §9.2).
 * DocError проходит как есть — это уже ответ, а не сбой. Дедлайн запроса
 * (statement_timeout / query_timeout) — тоже 503, с `detail.cause = 'timeout'`.
 * Данные, которых база не примет (SQLSTATE 22xxx), — 400 `bad_request`,
 * `retryable: false` (SPEC §9.11). Причина 503 и 400 — в лог одной строкой.
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
    const code = e && e.code ? String(e.code) : '';
    if (isDataError(e)) {
      logOnce(`[document] хранилище отвергло данные → 400 (${code}): ${oneLine(msg)}`);
      throw badRequest('данные не принимаются: ' + (DATA_ERRORS[code] || 'значение не подходит базе'), { detail: { cause: 'data', sqlstate: code } });
    }
    const timeout = code === '57014' || /timeout/i.test(msg);
    // круг 31: схема базы не та, что ждёт код (восстановили из копии до миграций) — хранилище
    // уже сверяет миграции; повтор запроса не помог — 503 с причиной `schema`
    const schema = code === '42703' || code === '42P01';
    const cause = timeout ? 'timeout' : schema ? 'schema' : 'storage';
    logOnce(`[document] хранилище → 503 (${cause}${code ? ' ' + code : ''}): ${oneLine(msg)}`);
    throw unavailable('хранилище недоступно' + (timeout ? ': запрос не уложился в дедлайн' : schema ? ': схема базы не согласована с кодом, идёт сверка миграций' : ''), { detail: { cause } });
  }
}

/**
 * Сервис ещё применяет миграции базы (SPEC §9.11): HTTP уже открыт, но данных нет.
 * `detail` — что идёт: `{phase, migration, progress}`.
 */
export const migrating = (detail, retryAfter = 5) => new DocError(503, 'migrating', 'идут миграции базы, сервис скоро ответит', { retryable: true, retryAfter, detail });
