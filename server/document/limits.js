/**
 * Пределы Document service (SPEC §9.8) — одно место для всех чисел, которые
 * сервер навязывает транзакциям, документам и чтениям. Клиент (`src/sync.js`,
 * `LIMITS`) держит те же числа для того, что он проверяет до отправки; тест
 * `test/server/hardening.test.mjs` сверяет их, чтобы клиент не слал то, что
 * сервер заведомо отвергнет (иначе транзакция крутилась бы в очереди вечно).
 */

import * as core from '../../src/core.js';

/** `core.cleanKey`, если движок его даёт (круг 27); иначе — своя чистка ключа. */
const coreCleanKey = typeof core.cleanKey === 'function' ? core.cleanKey : null;

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
/**
 * Надгробия (круг 27, I1): id удалённого узла → последний родитель и seq удаления.
 * Прореживаются детерминированно — по номеру, а не по часам, чтобы голова в памяти и
 * голова, поднятая со снимка, на одном seq знали одно и то же: на каждой границе
 * TOMB_PRUNE_EVERY уходят надгробия с seq < граница − TOMB_KEEP_SEQ (окно не меньше
 * окна переигрывания REPLAY_SCAN_TXS); сверх TOMB_MAX остаются самые новые.
 * Последствие: `create` в родителя, удалённого давно, — `dropped: orphan`, а не `reparented`.
 */
export const TOMB_KEEP_SEQ = 10000;
export const TOMB_PRUNE_EVERY = 500;
export const TOMB_MAX = 50000;
/**
 * Память головы о последних транзакциях (идемпотентность, окно `stale`): выжимки
 * (tx_id, seq, chain, client, время, листья set/setToken) — не больше стольких штук и
 * стольких байт; целиком транзакции голова не держит (круг 27: 500 × 3,9 МБ = 2 ГБ).
 */
export const RECENT_TXS = 500;
export const RECENT_BYTES = 16 * 1024 * 1024;
/**
 * HTTP-запись (круг 27): тела записей (`POST …/tx`, `POST /api/projects`) читаются в
 * пределах бюджета байт на экземпляр (заявленный Content-Length или предел тела);
 * сверх — 503 busy без чтения. Слот семафора записи берётся ПОСЛЕ того, как тело
 * дочитано: медленное тело (slowloris) не держит слот. Тело не дочитано за
 * BODY_TIMEOUT_MS — 408, соединение закрывается.
 */
export const WRITE_BODY_BYTES = 64 * 1024 * 1024;
export const BODY_TIMEOUT_MS = 30000;
/** Таймауты http.Server: заголовки и запрос целиком (тело) — node сам отвечает 408. */
export const HEADERS_TIMEOUT_MS = 20000;
export const REQUEST_TIMEOUT_MS = 35000;
/** Вложенность значений в операциях и документе: глубже — 400 (jsonb и рекурсия не бесконечны). */
export const MAX_VALUE_DEPTH = 64;
/** id в операциях (узлы, родители, соседи): не длиннее стольких символов. */
export const MAX_OP_ID = 512;
/** command_id транзакции (связь с трассой агента). */
export const MAX_COMMAND_ID = 128;
/**
 * Круг 32: частей одной большой правки (`undo_part.n`) — не больше. Правка режется по 5000
 * операций (SPEC §9.15): 10 000 частей — 50 млн операций, больше не бывает; больше — поля нет.
 */
export const MAX_UNDO_PARTS = 10000;

/**
 * Часть большой правки `{i, n}` (круг 32, SPEC §9.15): i — номер с 0, n — частей (2…MAX_UNDO_PARTS).
 * Метаданные: негодное значение правку не губит — поля просто нет (null).
 * @param {any} v
 * @returns {{i: number, n: number}|null}
 */
export function undoPartOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { i, n } = v;
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n)) return null;
  if (n < 2 || n > MAX_UNDO_PARTS || i < 0 || i >= n) return null;
  return { i, n };
}

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
 * Управляющие символы и направляющие (bidi) в метаданных: C0 (кроме тех пробельных, что
 * разрешены), DEL, C1, U+061C, U+200E/U+200F, U+202A–U+202E (в том числе RLO), U+2066–U+2069,
 * разделители строк U+2028/U+2029.
 */
const META_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
const META_SPACES = /[\t\n\r]/g;

/**
 * Строка метаданных (круг 31): имя автора, автора команды, подпись транзакции, имя проекта —
 * то, что показывается в «Истории», списке проектов и присутствии. Кроме чистки для базы
 * (cleanText) — без управляющих символов и bidi-переключателей: BEL, RLO (U+202E) и прочие
 * переворачивали и прятали подпись в чужой истории. `\t \n \r` — пробел (подписи однострочные).
 * Содержимое документа (тексты узлов) так не чистится — только метаданные.
 * @param {string} s
 */
export function cleanMeta(s) {
  if (typeof s !== 'string') return s;
  return cleanText(s).replace(META_SPACES, ' ').replace(META_CONTROLS, '');
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
 * Ключи, которые чистка отбрасывает вместе со значением (как `core.cleanKey`, круг 27):
 * имена прототипа. Присваивание `out['__proto__'] = …` меняло бы прототип копии, а
 * `constructor`/`prototype` в данных — приглашение к той же путанице у читающего кода.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Ключ объекта после очистки (§9.10, круг 27): строка чистится, как значение; ключ,
 * который после чистки называет прототип (`__proto__`, в том числе `"__proto__\u0000"`),
 * отбрасывается — `null`. Если `core` даёт свой `cleanKey` — он главнее (одно правило
 * для клиента и сервера); его ответ всё равно проверяется здесь.
 * @param {string} k
 * @returns {string|null}
 */
export function cleanKey(k) {
  const k2 = typeof coreCleanKey === 'function' ? coreCleanKey(k) : cleanText(typeof k === 'string' ? k : String(k));
  return typeof k2 !== 'string' || UNSAFE_KEYS.has(k2) || !isCleanText(k2) ? null : k2;
}

const defineOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/**
 * Очистка значения целиком (строки и ключи объектов, рекурсивно): копия делается
 * только там, где есть что чистить. Глубже `maxDepth` — исключение `depth` (вызывающий
 * отвечает 400).
 *
 * Ключи (круг 27): опасный ключ (`__proto__`, `constructor`, `prototype` — до или после
 * чистки) отбрасывается вместе со значением; копия собирается через defineProperty —
 * присваиванием ключ `__proto__` менял бы прототип. Два ключа, совпавшие после чистки
 * (`"a"` и `"a\u0000"`), не перетирают друг друга как придётся: ключ, который был чистым
 * с самого начала, главнее очищенного (мусорный двойник не подменяет данные), а из
 * нескольких очищенных — последний по порядку ключей (как JSON.parse с повтором).
 * @param {any} v
 * @param {number} [maxDepth]
 * @param {(k: string) => string|null} [keyOf] очистка ключа (по умолчанию cleanKey)
 */
export function cleanDeep(v, maxDepth = MAX_VALUE_DEPTH, keyOf = cleanKey) {
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
    const keys = Object.keys(x);
    let changed = false;
    const ks = new Array(keys.length);
    const vs = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      // собственное свойство `__proto__` (JSON.parse создаёт именно его) читается как данные
      const val = k === '__proto__' ? Object.getOwnPropertyDescriptor(x, k).value : x[k];
      const k2 = isCleanText(k) && !UNSAFE_KEYS.has(k) ? k : keyOf(k);
      ks[i] = k2;
      if (k2 === null || k2 === undefined) {
        // отброшенный ключ: значение не чистим и не проверяем — его не будет
        changed = true;
        continue;
      }
      const y = walk(val, depth + 1);
      vs[i] = y;
      if (k2 !== k || y !== val) changed = true;
    }
    if (!changed) return x;
    const out = {};
    let pure = null;   // исходные ключи — только если есть очищенные (иначе сравнивать не с чем)
    for (let i = 0; i < ks.length; i++) {
      const k2 = ks[i];
      if (k2 === null || k2 === undefined) continue;
      if (k2 !== keys[i]) {
        if (!pure) pure = new Set(keys);
        if (pure.has(k2)) continue;   // чистый двойник есть — он главнее
      }
      defineOwn(out, k2, vs[i]);
    }
    return out;
  };
  return walk(v, 0);
}

/**
 * Чужое значение для текста ошибки или лога (круг 29): строка — чистая и не длиннее
 * `max` кодовых точек, всё прочее — только название типа. Подставлять чужое значение в
 * шаблон строки нельзя: шаблон зовёт toString/valueOf, а у `{"toString":1}` из JSON это
 * TypeError — одно сообщение сокета роняло процесс.
 * @param {any} v
 * @param {number} [max]
 * @returns {string}
 */
export function showValue(v, max = 40) {
  if (typeof v === 'string') return cutText(cleanText(v), max);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return Array.isArray(v) ? 'массив' : typeof v === 'object' ? 'объект' : typeof v;
}

/**
 * Подключение сокета (круг 29): сколько сокетов одновременно идут от upgrade до hello
 * (1–3 чтения базы на каждый). Пул pg — 10 соединений: шторм подключений не должен
 * занимать его весь, иначе запись ждёт соединения.
 */
export const WS_CONNECTING = 6;
/** Журнал «Истории» (`GET …/history`, круг 29): страница по умолчанию и наибольшая. */
export const HISTORY_PAGE = 50;
export const HISTORY_PAGE_MAX = 200;
/** Проверка хранилища в `GET /api/health` (круг 29): дедлайн пинга и сколько помнится ответ. */
export const HEALTH_PING_MS = 1000;
export const HEALTH_CACHE_MS = 1000;

/** Числа, которые обязан знать клиент (сверяются тестом с `LIMITS` из src/sync.js). */
export const CLIENT_LIMITS = Object.freeze({
  txBytes: MAX_BODY_BYTES,
  opsPerTx: MAX_OPS_PER_TX,
  docBytes: MAX_DOC_BYTES,
  docNodes: MAX_DOC_NODES,
  presenceSelection: PRESENCE_SELECTION,
  presenceHeartbeatMs: PRESENCE_HEARTBEAT_MS,
  replayMaxAgeMs: REPLAY_MAX_AGE_MS,
  // надгробия реплики прореживаются по тем же числам, что у головы (круг 29, SYNC)
  tombKeepSeq: TOMB_KEEP_SEQ,
  tombPruneEvery: TOMB_PRUNE_EVERY,
  tombMax: TOMB_MAX,
});
