/**
 * Фабрика соединения postgres.js (единственный драйвер стенда, SPEC §2: SQL явный, без ORM).
 * Тот же helper используется Zero push-обработчиком (zeroPostgresJS оборачивает этот же `Sql`).
 */
import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type TransactionSql = postgres.TransactionSql<{}>;

export interface CreateSqlOptions {
  max?: number;
  /** Имя приложения в pg_stat_activity. */
  applicationName?: string;
}

export function createSql(url: string, opts: CreateSqlOptions = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    // Prepared statements ускоряют повторяющиеся запросы (страницы, команды).
    prepare: true,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { application_name: opts.applicationName ?? 'stand-api' },
    onnotice: () => {
      /* NOTICE от IF NOT EXISTS не нужны в логе */
    },
  });
}

/** Транзакция REPEATABLE READ READ ONLY — согласованный снимок для чтения страницы (SPEC §2.2). */
export function beginRepeatableRead<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', fn) as Promise<T>;
}

/** Обычная транзакция READ COMMITTED READ WRITE (команды, сброс). */
export function beginReadWrite<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(fn) as Promise<T>;
}
