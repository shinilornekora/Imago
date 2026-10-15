/**
 * Пределы Document service (SPEC §9.8) — одно место для всех чисел, которые
 * сервер навязывает транзакциям, документам и чтениям. Клиент (`src/sync.js`,
 * `LIMITS`) держит те же числа для того, что он проверяет до отправки; тест
 * `test/server/hardening.test.mjs` сверяет их, чтобы клиент не слал то, что
 * сервер заведомо отвергнет (иначе транзакция крутилась бы в очереди вечно).
 */

/** Тело запроса и сообщение WebSocket: транзакция (или документ проекта) ≤ 4 МБ → иначе 413. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Запас на конверт сообщения сокета `{"type":"tx","tx":…}` поверх тела транзакции. */
export const WS_ENVELOPE_BYTES = 64 * 1024;
/** Операций в одной транзакции — иначе 413 (перетаскивание без коалесинга не должно раздувать журнал). */
export const MAX_OPS_PER_TX = 5000;
/**
 * Документ после транзакции: JSON ≤ 24 МиБ и ≤ 20 000 узлов. Транзакция, после
 * которой документ превысил бы предел, НЕ отклоняется (слияние не отказывает,
 * §8.3): все её операции, кроме `remove`, отбрасываются с `reason:'invalid'` и
 * `limit:'doc_nodes'|'doc_bytes'`; транзакция получает seq — автор видит ответ.
 */
export const MAX_DOC_BYTES = 24 * 1024 * 1024;
export const MAX_DOC_NODES = 20000;
/**
 * Бюджет слияния по времени: поиск виноватой операции (когда строгий applyOps
 * не принимает результат rebase) после бюджета не продолжается — оставшиеся
 * под подозрением операции отбрасываются с `reason:'invalid'`, `limit:'merge_budget'`.
 */
export const MERGE_BUDGET_MS = 2000;
/** `dropped` в журнале: не больше стольких записей, остаток — одной записью `{more: N}`. */
export const DROPPED_KEEP = 50;
/** Операция в `dropped` длиннее стольких байт JSON хранится выжимкой: `valueBytes` + `preview`. */
export const DROPPED_OP_BYTES = 1024;
/** Длина `preview` (символов JSON значения) в выжимке. */
export const DROPPED_PREVIEW_CHARS = 120;
/** Тело трассы агента (`POST /api/internal/traces`). */
export const MAX_TRACE_BYTES = 64 * 1024;
/** Сколько трасс отдаёт `GET …/traces?limit=` — по умолчанию и не больше. */
export const TRACES_DEFAULT = 20;
export const TRACES_MAX = 200;
/** Страница журнала: не больше стольких транзакций и (мягко) стольких байт JSON; первая транзакция — всегда. */
export const PAGE_TXS = 500;
export const MAX_LIMIT = 5000;
export const PAGE_BYTES = 2 * 1024 * 1024;
/**
 * Список проектов (`GET /api/projects?kind=&limit=&after=`, круг 26): страница по
 * умолчанию и наибольшая; дальше — `after` = `next` предыдущей страницы, `more: true`.
 */
export const PROJECTS_PAGE = 200;
export const PROJECTS_PAGE_MAX = 1000;
/** Тяжёлые чтения (полный снимок): одновременно и в очереди; переполнение → 503 busy + Retry-After. */
export const HEAVY_CONCURRENCY = 4;
export const HEAVY_QUEUE = 32;
export const RETRY_AFTER_S = 2;
/** Снимки: раз в N транзакций; хранится последних столько (плюс seq 0 — затравка, никогда не удаляется). */
export const SNAPSHOT_EVERY = 50;
export const SNAPSHOT_KEEP = 5;
/** Дедлайн обычного запроса к базе (DB_TIMEOUT_MS); миграции идут без него. */
export const DB_TIMEOUT_MS = 8000;
/** Сверка голов в памяти с базой (страховка от пропущенных NOTIFY и отката базы). */
export const VERIFY_MS = 5000;

/**
 * Присутствие (SPEC §9.9): выделение — не больше стольких id (длиннее MAX_ID символов
 * не пропускаются), обрезанное помечается `truncated: true`. Между экземплярами
 * присутствие идёт через NOTIFY отдельного канала; полезная нагрузка NOTIFY в Postgres —
 * меньше 8000 байт, своя выжимка держится в PRESENCE_PAYLOAD_BYTES.
 */
export const PRESENCE_SELECTION = 200;
export const PRESENCE_ID_CHARS = 128;
export const PRESENCE_PAYLOAD_BYTES = 7600;
/** Присутствие: не чаще стольких сообщений в секунду на сокет. */
export const PRESENCE_PER_SECOND = 10;
/** Клиент повторяет своё присутствие раз в столько (сердцебиение), даже если ничего не менялось. */
export const PRESENCE_HEARTBEAT_MS = 15000;
/** Без вестей от клиента столько — он считается ушедшим (`left`): три пропущенных сердцебиения. */
export const PRESENCE_TTL_MS = 45000;
/** Кеш кадров Hub: на проект — не больше стольких кадров и байт; на весь экземпляр — байт. */
export const FRAME_CACHE_FRAMES = 256;
export const FRAME_CACHE_ROOM_BYTES = 4 * 1024 * 1024;
export const FRAME_CACHE_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Запись (SPEC §9.10): предел «в полёте» и очередей. На сокет — не больше
 * WS_INFLIGHT необработанных транзакций (сверх — чтение сокета на паузе, а то, что
 * уже прочитано, получает `error busy`). Очередь мьютекса проекта и всего экземпляра
 * ограничена байтами тел транзакций (и числом на проект): сверх — 503 `busy` +
 * Retry-After (HTTP) / `error busy` (WS). HTTP-запись — под семафором.
 */
export const WS_INFLIGHT = 2;
export const QUEUE_PROJECT_BYTES = 32 * 1024 * 1024;
export const QUEUE_PROJECT_TXS = 256;
export const QUEUE_TOTAL_BYTES = 128 * 1024 * 1024;
export const HTTP_WRITE_CONCURRENCY = 8;
export const HTTP_WRITE_QUEUE = 64;
/** Retry-After для «занято» по записи, с. */
export const BUSY_RETRY_S = 1;

/**
 * Переигрывание после отката базы (SPEC §9.10): транзакция с `replay_of_epoch`
 * старше REPLAY_MAX_AGE_MS не переигрывается (клиент показывает человеку, сервер
 * отбрасывает её `set` с `reason:'stale'`); поиск более новых чужих записей тех же
 * листьев — не дальше REPLAY_SCAN_TXS транзакций журнала (дальше — `stale`).
 */
export const REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const REPLAY_SCAN_TXS = 5000;
/** Вложенность значений в операциях и документе: глубже — 400 (jsonb и рекурсия не бесконечны). */
export const MAX_VALUE_DEPTH = 64;
/** id в операциях (узлы, родители, соседи): не длиннее стольких символов. */
export const MAX_OP_ID = 512;
/** command_id транзакции (связь с трассой агента). */
export const MAX_COMMAND_ID = 128;

/* ------------------------------- строки ------------------------------- */

/**
 * Строка годна для jsonb/text Postgres: без U+0000 и без одиночных суррогатных
 * половин (JSON.stringify пишет их как `\ud800`, и jsonb их не принимает).
 * @param {string} s
 */
export function isCleanText(s) {
  return typeof s === 'string' && s.indexOf('\u0000') < 0 && s.isWellFormed();
}

/** U+0000 — вон, одиночные суррогаты — U+FFFD. Чистая строка возвращается как есть. */
export function cleanText(s) {
  if (typeof s !== 'string') return s;
  if (isCleanText(s)) return s;
  return s.replace(/\u0000/g, '').toWellFormed();
}

/**
 * Обрезать до `n` кодовых точек: суррогатная пара не рвётся пополам (иначе
 * обрезок — одиночная половина, и запись в jsonb падает).
 */
export function cutText(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * Очистка значения целиком (строки и ключи объектов, рекурсивно): копия делается
 * только там, где есть что чистить. Глубже `maxDepth` — исключение `depth` (вызывающий
 * отвечает 400).
 * @param {any} v
 * @param {number} [maxDepth]
 */
export function cleanDeep(v, maxDepth = MAX_VALUE_DEPTH) {
  const walk = (x, depth) => {
    if (typeof x === 'string') return cleanText(x);
    if (!x || typeof x !== 'object') return x;
    if (depth > maxDepth) {
      const e = new Error('слишком глубокая вложенность');
      e.code = 'depth';
      throw e;
    }
    if (Array.isArray(x)) {
      let out = null;
      for (let i = 0; i < x.length; i++) {
        const y = walk(x[i], depth + 1);
        if (y !== x[i]) {
          if (!out) out = x.slice();
          out[i] = y;
        }
      }
      return out || x;
    }
    let out = null;
    for (const k of Object.keys(x)) {
      const y = walk(x[k], depth + 1);
      const k2 = isCleanText(k) ? k : cleanText(k);
      if (y !== x[k] || k2 !== k) {
        if (!out) out = { ...x };
        if (k2 !== k) delete out[k];
        out[k2] = y;
      }
    }
    return out || x;
  };
  return walk(v, 0);
}

/** Числа, которые обязан знать клиент (сверяются тестом с `LIMITS` из src/sync.js). */
export const CLIENT_LIMITS = Object.freeze({
  txBytes: MAX_BODY_BYTES,
  opsPerTx: MAX_OPS_PER_TX,
  docBytes: MAX_DOC_BYTES,
  docNodes: MAX_DOC_NODES,
  presenceSelection: PRESENCE_SELECTION,
  presenceHeartbeatMs: PRESENCE_HEARTBEAT_MS,
  replayMaxAgeMs: REPLAY_MAX_AGE_MS,
});
