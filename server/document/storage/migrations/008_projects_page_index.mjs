/**
 * 008_projects_page_index — индекс страниц списка проектов (круг 27, I2).
 *
 * `listProjectsPage` идёт ключом `(updated_at, id)` по убыванию: `ORDER BY updated_at DESC,
 * id DESC` и `(updated_at, id) < (…)`. Без индекса каждая страница — полный проход и
 * сортировка таблицы проектов; с ним — Index Scan с условием по ключу курсора и LIMIT.
 *
 * Обычно — `CREATE INDEX CONCURRENTLY`: без замка записи (SHARE UPDATE EXCLUSIVE — чтение
 * и запись проектов идут, в том числе у экземпляров прежней версии). Поэтому файл .mjs:
 * раннер оборачивает .sql в транзакцию, а CONCURRENTLY в транзакции нельзя.
 *
 * CONCURRENTLY ждёт все транзакции со снимком старше начала сборки. Экземпляр круга 26 и
 * раньше ждёт замка миграций в `pg_advisory_lock` — со снимком, а замок держим мы: это
 * взаимная блокировка (база обрывает одну из сторон, 40P01). Поэтому: кто-то ждёт замок
 * миграций — или CONCURRENTLY всё же упал на блокировке/замке — обычный `CREATE INDEX`
 * в короткой транзакции (SHARE: запись проектов ждёт, пока строится индекс по таблице
 * проектов — строка на проект, миллисекунды; замок ждётся не дольше lock_timeout с
 * повтором). Экземпляры этой версии берут замок миграций опросом и не ждут его со снимком.
 *
 * Прерванная сборка CONCURRENTLY (SIGTERM, обрыв, 40P01) оставляет индекс INVALID — такой
 * удаляется и строится заново; готовый — пропускается (миграция идемпотентна).
 */

export const INDEX = 'projects_updated_id';
const DDL = `ON projects (updated_at DESC, id DESC)`;

async function state(client) {
  const row = (await client.query(
    `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'projects'::regclass AND c.relname = $1`,
    [INDEX]
  )).rows[0];
  return row ? (row.indisvalid ? 'valid' : 'invalid') : 'none';
}

/** Сеансы, ждущие замка миграций (pg_advisory_lock одним bigint: classid — старшие 32 бита, objid — младшие). */
async function lockWaiters(client, key) {
  if (!(key >= 0)) return 0;
  return Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1`,
    [Math.floor(key / 2 ** 32), key % 2 ** 32]
  )).rows[0].n);
}

/** Обычный CREATE INDEX: короткая транзакция, замок ждётся не дольше lock_timeout, повтор. */
async function plain(ctx) {
  const { client, log } = ctx;
  const lockTimeoutMs = ctx.lockTimeoutMs > 0 ? ctx.lockTimeoutMs : 1000;
  const lockTries = ctx.lockTries > 0 ? ctx.lockTries : 60;
  const isLockTimeout = ctx.isLockTimeout || ((e) => e && (e.code === '55P03' || e.code === '40P01'));
  for (let attempt = 1; ; attempt++) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`);
      await client.query(`DROP INDEX IF EXISTS ${INDEX}`);   // недостроенный CONCURRENTLY, если был
      await client.query(`CREATE INDEX ${INDEX} ${DDL}`);
      await client.query('COMMIT');
      return;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (isLockTimeout(e) && attempt < lockTries && !ctx.closing) {
        if (attempt === 1 || attempt % 10 === 0) log.warn(`[document/pg] 008: таблица проектов занята, повтор ${attempt}`);
        await new Promise((r) => setTimeout(r, Math.min(2000, 100 * attempt)));
        continue;
      }
      throw e;
    }
  }
}

export async function up(ctx) {
  const { client, log } = ctx;
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const st = await state(client);
  if (st === 'valid') return;
  progress({ step: 'index' });
  const t0 = Date.now();
  let how = 'CONCURRENTLY';
  const waiters = await lockWaiters(client, ctx.migrationLock);
  if (waiters) {
    how = `обычный: замок миграций ждут ${waiters}`;
    await plain(ctx);
  } else {
    try {
      if (st === 'invalid') {
        log.warn(`[document/pg] 008: индекс ${INDEX} остался недостроенным (INVALID) — строю заново`);
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
      }
      await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ${DDL}`);
    } catch (e) {
      if (!(e && (e.code === '40P01' || e.code === '55P03'))) throw e;
      how = `обычный: CONCURRENTLY — ${e.code}`;
      await plain(ctx);
    }
  }
  log.info(`[document/pg] 008: индекс ${INDEX} построен за ${Date.now() - t0} мс (${how})`);
}
