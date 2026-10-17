/**
 * 009_ops_size — вес и число операций записи журнала без чтения jsonb (круг 29, J2).
 *
 * Страница журнала (`txsAfter`) режется по байтам: прежде окно считало
 * `octet_length(ops::text)` у ВСЕХ записей после LIMIT (до 500) — при транзакциях по 4 МБ
 * одна страница перегоняла ~2 ГБ jsonb (9 с, 503, голодание пула). Теперь вес лежит в колонке:
 *   ops_bytes — байты JSON-текста `ops` и `dropped`: вес записи на странице журнала;
 *   ops_count — число операций: истории (`recentTxMeta`).
 *
 * Смешанные версии (SPEC §9.11): экземпляр прежней версии колонок не знает и пишет без них —
 * триггер BEFORE INSERT считает их, когда NULL (`octet_length(ops::text) +
 * octet_length(dropped::text)`, `jsonb_array_length(ops)`; так же — дозаполнение). Экземпляр
 * этой версии передаёт их сам — байты JSON, который он и так отправляет (JSON.stringify, как
 * у адаптера в памяти): `::text` 4 МБ jsonb в триггере стоил бы ~65 мс на каждую запись. Меры
 * отличаются пробелами jsonb::text (после `:` и `,`) — на проценты; окно страницы мягкое,
 * этого достаточно. Старый читает журнал явным списком колонок — новые ему не мешают.
 *
 * Порядок:
 *   1. короткая транзакция: ADD COLUMN без умолчания (правка каталога, без перезаписи), функция
 *      и триггер; замок ждётся не дольше lock_timeout и повторяется — с этого мига каждая новая
 *      запись получает вес сама;
 *   2. дозаполнение старых записей — без замка таблицы: ключом (project_id, seq) по первичному
 *      индексу, пачками-транзакциями; пачка — не больше BATCH_BYTES хранимого jsonb (по
 *      pg_column_size, без детоаста) и подстраивается так, чтобы транзакция шла ~0,5 с
 *      (записи по 4 МБ — единицы-десятки строк, мелкие — тысячи). UPDATE не трогает TOAST
 *      `ops` (значение не меняется — указатель тот же) и не мешает записи: новые строки — другие.
 * Идемпотентна: прерванная (SIGTERM, обрыв) продолжает с первой записи без веса.
 * NOT NULL не ставится: код читает `coalesce(ops_bytes, …)` — запись без веса (если бы такая
 * нашлась) обошлась бы чтением jsonb, а не ошибкой.
 */

const BATCH_MIN = 10;
const BATCH_MAX = 5000;
const BATCH_TARGET_MS = 500;
/** Пачка — не больше стольких байт хранимого `ops` (pg_column_size читает только заголовок TOAST). */
const BATCH_BYTES = 32 * 1024 * 1024;

/** Вес записи — одно выражение для триггера, дозаполнения и запасного пути чтения. */
export const BYTES_SQL = (t) => `octet_length(${t}.ops::text) + octet_length(coalesce(${t}.dropped, '[]'::jsonb)::text)`;
export const COUNT_SQL = (t) => `CASE WHEN jsonb_typeof(${t}.ops) = 'array' THEN jsonb_array_length(${t}.ops) ELSE 0 END`;

const DDL = `
ALTER TABLE operations ADD COLUMN IF NOT EXISTS ops_bytes int;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS ops_count int;
CREATE OR REPLACE FUNCTION imago_operations_size() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.ops_bytes IS NULL THEN
    NEW.ops_bytes := ${BYTES_SQL('NEW')};
  END IF;
  IF NEW.ops_count IS NULL THEN
    NEW.ops_count := ${COUNT_SQL('NEW')};
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS operations_size ON operations;
CREATE TRIGGER operations_size BEFORE INSERT ON operations
  FOR EACH ROW WHEN (NEW.ops_bytes IS NULL OR NEW.ops_count IS NULL) EXECUTE FUNCTION imago_operations_size();
`;

async function ddl(ctx) {
  const { client, log } = ctx;
  const lockTimeoutMs = ctx.lockTimeoutMs > 0 ? ctx.lockTimeoutMs : 1000;
  const lockTries = ctx.lockTries > 0 ? ctx.lockTries : 60;
  const isLockTimeout = ctx.isLockTimeout || ((e) => e && (e.code === '55P03' || e.code === '40P01'));
  for (let attempt = 1; ; attempt++) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`);
      await client.query(DDL);
      await client.query('COMMIT');
      return;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (isLockTimeout(e) && attempt < lockTries && !ctx.closing) {
        if (attempt === 1 || attempt % 10 === 0) log.warn(`[document/pg] 009: журнал занят, повтор ${attempt}`);
        await new Promise((r) => setTimeout(r, Math.min(2000, 100 * attempt)));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Дозаполнить вес у записей без него; пачки — свои транзакции.
 * @param {import('pg').Client} client
 * @param {{closing?: () => boolean, onBatch?: (updated: number, seen: number) => void, batch?: number, batchBytes?: number}} [o]
 * @returns {Promise<number>} сколько записей посчитано
 */
export async function backfill(client, { closing = () => false, onBatch = () => {}, batch: first = 500, batchBytes = BATCH_BYTES } = {}) {
  let batch = Math.max(BATCH_MIN, Math.min(BATCH_MAX, first));
  let after = null;   // [project_id, seq] последней просмотренной
  let total = 0;
  for (;;) {
    if (closing()) throw new Error('остановка посреди заполнения');
    const t0 = Date.now();
    await client.query('BEGIN');
    let res;
    try {
      // ключи пачки — по первичному индексу (без прохода всей таблицы на каждой пачке);
      // считаются только строки без веса
      res = await client.query(
        `WITH k0 AS (
           SELECT project_id, seq, pg_column_size(ops) AS sz FROM operations
            ${after ? 'WHERE (project_id, seq) > ($3::uuid, $4::bigint)' : ''}
            ORDER BY project_id, seq LIMIT $1
         ), k AS (
           SELECT project_id, seq FROM (
             SELECT project_id, seq, row_number() OVER (ORDER BY project_id, seq) AS rn,
                    sum(sz) OVER (ORDER BY project_id, seq ROWS UNBOUNDED PRECEDING) AS run
               FROM k0) x
            WHERE rn = 1 OR run <= $2
         ), u AS (
           UPDATE operations o SET ops_bytes = coalesce(o.ops_bytes, ${BYTES_SQL('o')}), ops_count = coalesce(o.ops_count, ${COUNT_SQL('o')})
             FROM k WHERE o.project_id = k.project_id AND o.seq = k.seq AND (o.ops_bytes IS NULL OR o.ops_count IS NULL)
           RETURNING 1
         )
         SELECT (SELECT count(*)::int FROM u) AS updated,
                (SELECT count(*)::int FROM k) AS seen,
                (SELECT project_id FROM k ORDER BY project_id DESC, seq DESC LIMIT 1) AS last_p,
                (SELECT seq FROM k ORDER BY project_id DESC, seq DESC LIMIT 1) AS last_s`,
        after ? [batch, batchBytes, after[0], after[1]] : [batch, batchBytes]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    const row = res.rows[0];
    if (!row.seen) break;
    after = [row.last_p, row.last_s];
    total += row.updated;
    onBatch(row.updated, row.seen);
    const ms = Date.now() - t0;
    if (row.updated && ms > BATCH_TARGET_MS * 2) batch = Math.max(BATCH_MIN, Math.floor(batch / 2));
    else if (ms < BATCH_TARGET_MS / 2) batch = Math.min(BATCH_MAX, batch * 2);
  }
  return total;
}

export async function up(ctx) {
  const { client, log } = ctx;
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  progress({ step: 'ddl' });
  await ddl(ctx);
  // оценка для 503 migrating: без прохода таблицы (reltuples), дальше — по просмотренным
  const est = (await client.query("SELECT greatest(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'operations'::regclass")).rows[0];
  const total = Number(est && est.n) || 0;
  let seen = 0;
  progress({ step: 'fill', done: 0, total });
  const t0 = Date.now();
  const filled = await backfill(client, {
    closing: () => !!ctx.closing,
    onBatch: (_, n) => {
      seen += n;
      progress({ step: 'fill', done: seen, total: Math.max(total, seen) });
    }
  });
  if (filled) log.info(`[document/pg] 009: вес и число операций посчитаны у ${filled} записей журнала за ${Date.now() - t0} мс`);
}
