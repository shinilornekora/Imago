/**
 * Транспорт до Document service (SPEC §9.2): fetch с дедлайном, JSON туда и обратно.
 * Общий для DSLR-клиента, DSLTS-клиента, трасс и проверки здоровья.
 *
 * Сетевая ошибка, дедлайн и ответ 5xx — `document_down` (503, повторяемо): Document
 * service — единственный арбитр, без него агент правок не делает (CP, §8.3).
 * У ошибки 5xx есть `docStatus` (статус сервиса), `docCode` (его код: `busy`,
 * `unavailable`…) и `docRetryAfter` (секунды из `Retry-After` или `retry_after` тела) —
 * вызывающий решает, ждать ли. Наружу (тело ошибки агента) они не уходят.
 * Остальные статусы возвращаются вызывающему как есть: он знает, что значит 404 или 410.
 */

import { documentDown } from './errors.js';
import { DOC_TIMEOUT_MS, DOC_HEALTH_TIMEOUT_MS } from './limits.js';
import { cutText } from '../../src/core.js';

/** Retry-After: секунды (целое ≥ 0) или HTTP-дата; null — не задан или не разобрался. */
export function parseRetryAfter(header, body) {
  const fromBody = body && Number.isFinite(body.retry_after) && body.retry_after >= 0 ? body.retry_after : null;
  if (header === null || header === undefined || header === '') return fromBody;
  const s = String(header).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return fromBody;
}

/**
 * @param {{baseUrl: string, fetch?: typeof fetch, timeoutMs?: number}} o
 */
export function createDocClient(o) {
  const base = new URL(o.baseUrl);
  const fetchImpl = o.fetch || ((...a) => globalThis.fetch(...a));
  const timeoutMs = o.timeoutMs || DOC_TIMEOUT_MS;

  /** Путь `/api/...` относительно базы (база может стоять не в корне). */
  function urlOf(path) {
    const u = new URL(base.href);
    const head = u.pathname.replace(/\/+$/, '');
    const [p, q] = String(path).split('?');
    u.pathname = head + p;
    u.search = q ? '?' + q : '';
    return u;
  }

  /**
   * @returns {Promise<{status: number, body: any, headers: Headers}>}
   */
  async function call(method, path, body, { headers = {}, timeout = timeoutMs, signal } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onOuter = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onOuter, { once: true });
    let res;
    try {
      res = await fetchImpl(urlOf(path), {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.status >= 500) {
        const why = json && json.message ? `: ${cutText(json.message, 200)}` : '';
        const after = parseRetryAfter(res.headers.get('retry-after'), json);
        const err = Object.assign(documentDown(), { detail: { status: res.status, cause: `Document service ответил ${res.status}${why}` } });
        err.docStatus = res.status;
        err.docCode = json && typeof json.code === 'string' ? json.code : null;
        err.docRetryAfter = after;
        if (after !== null && after > (err.retryAfter || 0)) err.retryAfter = Math.min(after, 60);
        throw err;
      }
      return { status: res.status, body: json, headers: res.headers };
    } catch (e) {
      if (e && e.code === 'document_down') throw e;
      // сетевой сбой или дедлайн; внешняя отмена — тоже «не дошли», вызывающий проверит signal
      throw Object.assign(documentDown(), {
        detail: { cause: ctl.signal.aborted && !(signal && signal.aborted) ? `нет ответа за ${timeout} мс` : 'нет связи' },
        network: true,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuter);
    }
  }

  /** 'up' | 'down' — GET /api/health с коротким дедлайном. */
  async function health() {
    try {
      const r = await call('GET', '/api/health', undefined, { timeout: DOC_HEALTH_TIMEOUT_MS });
      return r.status === 200 && r.body && r.body.ok ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  return {
    base: base.origin + base.pathname.replace(/\/+$/, ''),
    get: (path, opts) => call('GET', path, undefined, opts),
    post: (path, body, opts) => call('POST', path, body, opts),
    health,
  };
}
