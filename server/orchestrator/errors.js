/**
 * Ошибка Orchestrator (SPEC §10.2): одна форма для HTTP-ответа и для SSE-события
 * `error`. Тело — `{error: true, code, message, retryable, detail?}`.
 *
 * Коды: bad_request 400 · not_found 404 · method_not_allowed 405 · timeout 408 (тело запроса не пришло,
 * круг 33) · too_large 413 ·
 * busy 429 (503 — перегрузка: сервис документов или сам агент, круг 39) · not_applied 422 (правка модели к документу не приложилась, круг 29) · llm_failed 502 ·
 * llm_bad_response 502 (ответ модели слишком большой, глубокий или не JSON — круг 31) · document_failed 502 ·
 * llm_down 503 · document_down 503 · shutting_down 503 · worker_failed 500 ·
 * internal 500 (исключение кода агента, не модели; повтор не поможет — круг 31) · timeout 504 · engine 426 ·
 * cancelled (только SSE).
 *
 * Круг 31: `detail.hint` — подсказка оболочке, какой совет дать (`name_layer` у not_applied:
 * причина в выборе слоя). Без неё совета нет.
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

  /** Тело ответа и SSE-события `error`; `retry_after` (с) — когда срок повтора известен (круг 26). */
  body() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(Number.isFinite(this.retryAfter) && this.retryAfter > 0 ? { retry_after: this.retryAfter } : {}),
    };
  }
}

export const badRequest = (message, detail) => new OrchError(400, 'bad_request', message, { retryable: false, detail });
export const notFound = (message) => new OrchError(404, 'not_found', message, { retryable: false });
export const documentDown = (message = 'Сервис документов недоступен — команда не выполнена. Правки не потеряны; попробуйте через несколько секунд.') =>
  new OrchError(503, 'document_down', message, { retryAfter: 5 });
/**
 * Круг 39 (N5а): Document service жив, но перегружен (его очередь тяжёлых чтений полна — 503 busy, —
 * или он не ответил в срок под очередью), либо очередь полных чтений самого агента полна. Это не
 * «недоступен»: повторяемо, срок — Retry-After.
 */
export const DOCUMENT_BUSY_MESSAGE = 'Сервис документов перегружен — команда не выполнена. Правки не потеряны; повторите через несколько секунд.';
export const documentBusy = (retryAfter = 5, detail) =>
  new OrchError(503, 'busy', DOCUMENT_BUSY_MESSAGE, { retryable: true, retryAfter: Math.max(1, Math.min(60, Math.ceil(retryAfter || 5))), ...(detail ? { detail } : {}) });
/**
 * Круг 41 (D5): полное чтение не дождалось СВОЕЙ очереди агента (семафор полных чтений полон или
 * ожидание в нём вышло за свой срок). Document service при этом отвечал — это перегрузка агента,
 * а не «сервис документов перегружен».
 */
export const AGENT_READ_QUEUE_MESSAGE = 'Агент занят чтением других документов — команда не выполнена. Правки не потеряны; повторите через несколько секунд.';
export const agentReadBusy = (retryAfter = 10, detail = {}) =>
  new OrchError(503, 'busy', AGENT_READ_QUEUE_MESSAGE, { retryable: true, retryAfter: Math.max(1, Math.min(60, Math.ceil(retryAfter || 10))), detail: { cause: 'agent', ...detail } });
/**
 * Круг 43: Document service отказал проекту по версии движка (503 `cause:'engine'`: проект
 * записан движком новее этого экземпляра — «устарел») или сам работает с другой версией, чем
 * агент (его /api/health). Это не «недоступен»: экземпляр жив, его нужно обновить.
 * `detail.cause` — чья версия старее: `server_old` (сервер документов), `agent_old` (агент);
 * `detail.server: 'document'` — о каком сервере речь (у 426 `server_old` от самого агента его нет).
 * @param {{engine?: number, found?: number, retryAfter?: number}} [o] engine — версия сервера
 *   документов, found — версия записи проекта (или агента)
 */
export const DOCUMENT_ENGINE_MESSAGE = 'Сервер документов ещё не обновился — команда не выполнена. Правки не потеряны; повторите, когда его обновят.';
export const AGENT_ENGINE_MESSAGE = 'Сервер агента ещё не обновился до версии сервера документов — команда не выполнена. Правки не потеряны; повторите чуть позже.';
export function documentEngine({ engine, found, retryAfter, agentOld = false } = {}) {
  return new OrchError(503, 'engine', agentOld ? AGENT_ENGINE_MESSAGE : DOCUMENT_ENGINE_MESSAGE, {
    retryable: true,
    retryAfter: Math.max(1, Math.min(300, Math.ceil(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30))),
    detail: {
      cause: agentOld ? 'agent_old' : 'server_old', server: 'document',
      ...(Number.isInteger(engine) ? { engine } : {}), ...(Number.isInteger(found) ? { found } : {}),
    },
  });
}

/**
 * Круг 43: что из `detail` ошибки можно отдать наружу — в событие `error` потока и в тело ответа
 * (SPEC §10.13): только белый список полей и только безопасные значения — короткие коды
 * (`[a-z_]`) и целые. Сырые причины сети («Document service ответил 503: …») сюда не попадают.
 * @returns {object|undefined}
 */
const DETAIL_CODES = ['hint', 'cause', 'queue', 'limit', 'document_reason', 'server'];
const DETAIL_INTS = ['engine', 'found', 'max'];
export function safeDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const out = {};
  for (const k of DETAIL_CODES) {
    const v = detail[k];
    if (typeof v === 'string' && /^[a-z][a-z_]{0,39}$/.test(v)) out[k] = v;
  }
  for (const k of DETAIL_INTS) {
    const v = detail[k];
    if (Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Круг 39 (N5а): занят главный поток самого агента (опаздывают его таймеры) — не сервис документов. */
export const AGENT_BUSY_MESSAGE = 'Агент перегружен — команда не выполнена. Правки не потеряны; повторите через несколько секунд.';
export const agentBusy = (retryAfter = 5) =>
  new OrchError(503, 'busy', AGENT_BUSY_MESSAGE, { retryable: true, retryAfter, detail: { cause: 'agent' } });
/* Круг 26: текст `llm_down` — для человека в браузере, без советов администратору
   («проверьте, что сервер модели запущен», имя переменной окружения): их пишет в лог
   pipeline (`adminHint`). */
export const LLM_DOWN_MESSAGE = 'Модель сейчас недоступна — команда не выполнена. Повторите чуть позже.';
export const LLM_UNCONFIGURED_MESSAGE = 'Модель на сервере пока не подключена — команды оболочки работают, правки агентом — нет.';
export const llmDown = (message = LLM_DOWN_MESSAGE) =>
  new OrchError(503, 'llm_down', message, { retryAfter: 10 });
export const llmUnconfigured = () => new OrchError(503, 'llm_down', LLM_UNCONFIGURED_MESSAGE,
  { retryAfter: 60, detail: { cause: 'unconfigured' } });
export const cancelled = () => new OrchError(499, 'cancelled', 'Команда остановлена', { retryable: false });
/** Круг 27 (I6): команду прервал останов процесса агента — не человек; её можно повторить. */
export const SHUTTING_DOWN_MESSAGE = 'Сервер агента перезапускается — команда не выполнена. Повторите через несколько секунд.';
export const shuttingDown = () => new OrchError(503, 'shutting_down', SHUTTING_DOWN_MESSAGE, { retryable: true, retryAfter: 5 });

/** Круг 31 (K3): человеку о внутренней ошибке агента — общая фраза (оболочка добавит свои слова). */
export const INTERNAL_MESSAGE = 'Внутренняя ошибка агента';

/**
 * Всё, что не OrchError, — внутренний сбой: наружу общая фраза, подробности — в лог.
 * Круг 31 (K3): `retryable: false` — исключение кода повтором не лечится.
 */
export function toOrchError(e) {
  if (e instanceof OrchError) return e;
  return new OrchError(500, 'internal', INTERNAL_MESSAGE, { retryable: false });
}
