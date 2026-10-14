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

/** Числа, которые обязан знать клиент (сверяются тестом с `LIMITS` из src/sync.js). */
export const CLIENT_LIMITS = Object.freeze({
  txBytes: MAX_BODY_BYTES,
  opsPerTx: MAX_OPS_PER_TX,
  docBytes: MAX_DOC_BYTES,
  docNodes: MAX_DOC_NODES,
});
