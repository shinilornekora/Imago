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

import { documentDown, documentEngine } from './errors.js';
import { ENGINE_VERSION } from '../../src/core.js';
import { DOC_TIMEOUT_MS, DOC_HEALTH_TIMEOUT_MS, DOC_HEALTH_PATIENT_MS, LOOP_LAG_GRACE_MS, LOOP_LAG_EXTENSIONS, DOC_RECENT_OK_MS } from './limits.js';
import { cutText } from '../../src/core.js';

/**
 * Круг 39 (N5а): дедлайн запроса — таймер нашего же цикла событий. Если главный поток был занят
 * (разбор мегабайтов JSON, передача документа воркеру), таймер срабатывает с опозданием — а ответ
 * сервиса, может быть, уже лежит в сокете и ждёт фазы ввода-вывода, которая идёт ПОСЛЕ таймеров.
 * Раньше такой «таймаут» становился `document_down` («Сервис документов недоступен») при живом
 * сервисе. Теперь: таймер опоздал больше чем на LOOP_LAG_GRACE_MS — это занятость нашего цикла,
 * срок продлевается (не больше LOOP_LAG_EXTENSIONS раз), и ответ успевает прийти.
 */

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
  /** Круг 39: когда сервис последний раз ответил не 5xx (на любой запрос). */
  let lastOk = 0;
  /** Круг 39: сколько раз дедлайн продлевался из-за занятости нашего цикла событий (отладка, тесты). */
  const stats = { lagExtended: 0, lagTimeouts: 0 };

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
   * @returns {Promise<{status: number, body: any, headers: Headers, chars: number}>} chars — длина тела (знаков)
   */
  async function call(method, path, body, { headers = {}, timeout = timeoutMs, signal } = {}) {
    const ctl = new AbortController();
    /* Круг 39 (N5а): дедлайн с поправкой на занятость своего цикла событий (см. выше). `lagged` —
       срок вышел, а наш поток в последний раз опоздал: в причине ошибки это видно (`ownLag`). */
    let lagged = false;
    let extensions = 0;
    let timer = null;
    const arm = (ms) => {
      const due = Date.now() + ms;
      timer = setTimeout(() => {
        const late = Date.now() - due;
        if (late > LOOP_LAG_GRACE_MS && extensions < LOOP_LAG_EXTENSIONS) {
          extensions++;
          stats.lagExtended++;
          lagged = true;
          // ответ мог прийти, пока поток был занят: даём фазе ввода-вывода его отдать
          arm(Math.min(ms, Math.max(LOOP_LAG_GRACE_MS * 2, late)));
          return;
        }
        if (late > LOOP_LAG_GRACE_MS) lagged = true;
        ctl.abort();
      }, ms);
    };
    arm(timeout);
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
      if (res.status < 500) lastOk = Date.now();
      if (res.status >= 500) {
        const why = json && json.message ? `: ${cutText(json.message, 200)}` : '';
        const after = parseRetryAfter(res.headers.get('retry-after'), json);
        const err = Object.assign(documentDown(), { detail: { status: res.status, cause: `Document service ответил ${res.status}${why}` } });
        err.docStatus = res.status;
        err.docCode = json && typeof json.code === 'string' ? json.code : null;
        // круг 31 (K2): подробности сервиса (`detail.storage: 'down'` у /api/health) — для причины
        err.docDetail = json && json.detail && typeof json.detail === 'object' ? json.detail : null;
        err.docRetryAfter = after;
        if (after !== null && after > (err.retryAfter || 0)) err.retryAfter = Math.min(after, 60);
        /* Круг 43: проект «устарел» на этом экземпляре (503 `cause:'engine'`) — не «недоступен»,
           а «сервер документов ещё не обновился»: своим кодом `engine`, без повторов записи. */
        if (err.docDetail && err.docDetail.cause === 'engine') {
          const d = err.docDetail;
          throw Object.assign(documentEngine({ engine: d.engine, found: d.found, retryAfter: after }), { docStatus: res.status });
        }
        throw err;
      }
      return { status: res.status, body: json, headers: res.headers, chars: text.length };
    } catch (e) {
      if (e && (e.code === 'document_down' || e.code === 'engine')) throw e;
      // сетевой сбой или дедлайн; внешняя отмена — тоже «не дошли», вызывающий проверит signal
      const timedOut = ctl.signal.aborted && !(signal && signal.aborted);
      if (timedOut && lagged) stats.lagTimeouts++;
      throw Object.assign(documentDown(), {
        detail: { cause: timedOut ? `нет ответа за ${timeout} мс` : 'нет связи' },
        network: true,
        // круг 39: сервис принял запрос, но не ответил в срок — не «нет связи»; ownLag — наш
        // цикл событий в это время был занят (сервис мог ответить вовремя)
        ...(timedOut ? { timedOut: true } : {}),
        ...(timedOut && lagged ? { ownLag: true } : {}),
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuter);
    }
  }

  /**
   * Круг 31 (K2): здоровье с причиной. `reason` — только у 'down': 'storage' — сервис отвечает,
   * но его база недоступна (503 с `detail.storage: 'down'`); 'schema' (круг 32) — база отвечает,
   * но схема догоняется после восстановления из копии (503 с `detail.storage: 'schema'`, обычно
   * секунды); 'unreachable' — сервис не ответил, ответил не тем или ещё не готов.
   * Круг 43: 'engine' — экземпляр работает с другой версией движка, чем агент (`engine` — его версия).
   * @returns {Promise<{document: 'up'|'down', reason?: 'storage'|'schema'|'unreachable'|'engine', engine?: number}>}
   */
  /** Круг 43: ответ /api/health → здоровье; экземпляр другой версии движка — `reason:'engine'`. */
  const healthOf = (r) => {
    if (!(r.status === 200 && r.body && r.body.ok)) return { document: 'down', reason: 'unreachable' };
    const eng = r.body.engine;
    if (Number.isInteger(eng) && eng !== ENGINE_VERSION) return { document: 'down', reason: 'engine', engine: eng };
    return { document: 'up' };
  };

  async function healthOnce(patient) {
    try {
      const r = await call('GET', '/api/health', undefined, { timeout: DOC_HEALTH_TIMEOUT_MS });
      return healthOf(r);
    } catch (e) {
      if (e && e.code === 'engine') return { document: 'down', reason: 'engine', ...(e.detail && Number.isInteger(e.detail.engine) ? { engine: e.detail.engine } : {}) };
      /* Круг 39 (N5а): не ответил в короткий срок — это ещё не «недоступен». Сервис только что
         ответил на другой запрос — он жив и занят (под нагрузкой его главный поток сериализует
         мегабайты). Иначе терпеливая проверка (перед командой) спрашивает ещё раз, подольше; не
         ответил и тогда — `slow`: вызывающий скажет «перегружен», а не «недоступен». `ownLag` —
         опоздал наш собственный цикл событий: это перегрузка агента, а не сервиса. */
      if (e && e.timedOut) {
        if (Date.now() - lastOk < DOC_RECENT_OK_MS) return { document: 'up' };
        if (patient) {
          try {
            const r = await call('GET', '/api/health', undefined, { timeout: DOC_HEALTH_PATIENT_MS });
            return healthOf(r);
          } catch (e2) {
            if (e2 && e2.timedOut) return { document: 'down', reason: 'unreachable', slow: true, ...(e2.ownLag || e.ownLag ? { ownLag: true } : {}) };
            e = e2;
          }
        } else {
          return { document: 'down', reason: 'unreachable', slow: true, ...(e.ownLag ? { ownLag: true } : {}) };
        }
      }
      if (e && e.code === 'engine') return { document: 'down', reason: 'engine', ...(e.detail && Number.isInteger(e.detail.engine) ? { engine: e.detail.engine } : {}) };
      const storage = e && e.docDetail ? e.docDetail.storage : undefined;
      return { document: 'down', reason: storage === 'down' ? 'storage' : storage === 'schema' ? 'schema' : 'unreachable' };
    }
  }

  /* Круг 39: одновременные проверки (шторм команд) — одним запросом: тридцать команд разом не
     шлют тридцать /api/health. Терпеливая и короткая — разные. */
  const inflight = { quick: null, patient: null };
  /**
   * @param {{patient?: boolean}} [o] patient — перед командой: короткий срок не уложился —
   *   спросить ещё раз подольше (DOC_HEALTH_PATIENT_MS)
   * @returns {Promise<{document: 'up'|'down', reason?: 'storage'|'schema'|'unreachable', slow?: boolean, ownLag?: boolean}>}
   */
  function healthDetail(o = {}) {
    const key = o && o.patient ? 'patient' : 'quick';
    if (inflight[key]) return inflight[key];
    const p = healthOnce(key === 'patient').finally(() => { if (inflight[key] === p) inflight[key] = null; });
    inflight[key] = p;
    return p;
  }

  /** 'up' | 'down' — GET /api/health с коротким дедлайном. */
  async function health() {
    return (await healthDetail()).document;
  }

  return {
    base: base.origin + base.pathname.replace(/\/+$/, ''),
    get: (path, opts) => call('GET', path, undefined, opts),
    post: (path, body, opts) => call('POST', path, body, opts),
    health,
    healthDetail,
    stats,
  };
}
