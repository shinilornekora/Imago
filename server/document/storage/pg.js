/**
 * Адаптер хранилища: PostgreSQL (SPEC §8.1 «База», §9.4, §9.8; схема — docs/06).
 *
 * Интерфейс общий с ./memory.js — секвенсор и DSLR не знают, что под ними:
 *   init() · close() · kind
 *   createProject({name, kind, doc, engine}) → Project   (снимок при seq 0 — сразу, эпоха — новая)
 *   listProjects() → Project[] · getProject(id) → Project|null · renameProject(id, name)
 *   listProjectsPage({kind?, limit?, after?: {at, id}}) → {projects, more, next: {at, id}|null}   (круг 26)
 *     Project = {id, name, kind, head_seq, head_chain, epoch, epoch_cause, engine, created_at, updated_at}
 *   latestSnapshot(projectId) → {seq, doc, engine, chain, tombstones, created_at}|null   (только снимок, чей chain совпадает с журналом)
 *   latestSnapshotMeta(projectId) → {seq, chain, engine, epoch, created_at}|null   (круг 27: тот же снимок, без doc и надгробий —
 *     jsonb документа не читается)
 *   snapshotBefore(projectId, seq, {doc?}) → снимок как у latestSnapshot|null   (круг 27: ближайший с seq < данного,
 *     годный по журналу и с известными надгробиями; seq 0 — всегда такой)
 *     `tombstones` снимка (круг 27, I1): v2 `{v:2, parents:{id → родитель}, seq:{id → seq удаления}, …}` или
 *     null — «неизвестно» (снимок записал экземпляр прежней версии); у seq 0 — всегда v2 (пусто)
 *   txsAfter(projectId, seq, limit, {maxBytes, internal}?) → Committed[]   (первая — всегда, дальше — пока влезает в
 *     maxBytes; вес — колонка ops_bytes, jsonb читается только у записей страницы; под пределом чтений журнала,
 *     `internal: true` — чтение секвенсора, мимо предела)
 *   recentTxMeta(projectId, {limit?, beforeSeq?}) → [{seq, tx_id, author, author_kind, title, created_at, client,
 *     command_id, command_author, undo_of, redo_of, undo_part, ops_count, dropped_count}]   (круг 29, J2: от новых к старым, seq < beforeSeq; без чтения ops)
 *   ping({timeoutMs = 1000}?) → boolean   (круг 29, J1: SELECT 1, ответ помнится 1 с; не бросает)
 *   schemaState → null | {reason, since, phase, error?, migration?}   (круг 31: схема отстала от кода — база
 *     восстановлена из копии до миграций; идёт сверка — /api/health 503 `storage:'schema'`)
 *   chainAt(projectId, seq) → string|null   (seq 0 → '')
 *   commitTx(projectId, tx, {expectSeq, expectChain, origin}) → {status:'committed'|'existing'|'stale'|'missing', …}
 *   writeSnapshot(projectId, seq, doc, engine, chain, tombstones?) → boolean · pruneSnapshots(projectId, keep)
 *   saveSnapshot(projectId, {seq, doc, engine, chain, tombstones}) → boolean   (то же, объектом)
 *     `tombstones` на входе — v2 (номера удаления известны), v1 (объект id → родитель, Map, пары —
 *     номеров нет: прочтётся как null) или null; раскладка по колонкам — migrations/007
 *   Committed несёт `command_id` и `command_author` (круг 30, миграция 010) и `undo_part` (круг 32, миграция 011),
 *     если транзакция их прислала (SPEC §9.11, §9.15)
 *   findTx(projectId, txId) → Committed|null
 *   knownEpoch(projectId, epoch) → boolean · bumpEpoch(projectId, fromEpoch, cause, origin) → {status:'bumped'|'moved', epoch, cause}
 *   addTrace({projectId, commandId, body}) → {id, created_at}|null · listTraces(projectId, limit) → Trace[]
 *   onNotify(fn) → отписка: {k:'tx', p, s, c, e, i} · {k:'epoch', p, e, i} · {k:'resync'}
 *     и эфемерное (канал `<channel>_presence`): {k:'presence', p, i, c, …} · {k:'left', p, i, c} · {k:'bye', i}
 *   publish(msg) → boolean   эфемерное сообщение всем экземплярам (присутствие); не записывается,
 *     теряется без слушателя — это не журнал
 *
 * Уведомления: запись транзакции и смена эпохи шлют `pg_notify` В ТОЙ ЖЕ транзакции
 * базы — уведомление уходит ровно тогда, когда запись видна. Каждый экземпляр
 * слушает канал отдельным соединением (LISTEN); после его переподключения
 * слушатели получают `{k:'resync'}` — уведомления за время разрыва потеряны,
 * головы надо сверить с базой.
 *
 * Присутствие (SPEC §9.9) — отдельный канал `<channel>_presence`: эфемерные
 * сообщения уходят через соединение слушателя (`SELECT pg_notify`) — не через
 * пул, чтобы поток выделений не отнимал соединения у записи транзакций; нет
 * слушателя или очередь отправки длиннее PUBLISH_QUEUE — сообщение теряется
 * (следующее сердцебиение его заменит). Полезная нагрузка NOTIFY — меньше 8000 байт;
 * больше — не отправляется (Hub режет выделение заранее).
 *
 * Соединение слушателя — одно на экземпляр, и запросы на нём (эфемерные `pg_notify`, пинг)
 * идут строго по одному, своей очередью (`serial`): node-pg с 8.x предупреждает о запросе
 * поверх выполняющегося и в pg@9 перестанет их копить. Живость слушателя — по движению
 * очереди: запрос, выполняющийся дольше LISTEN_PING_TIMEOUT_MS (`listenPingTimeoutMs`), —
 * соединение мертво (отдельный пинг при занятой очереди не начинается — он встал бы за ним же).
 *
 * Чтение снимков (документ — до десятков МБ jsonb, секунды на соединении) — не больше
 * `snapshotReads` одновременно (по умолчанию min(4, max − 4)), остальные ждут места без
 * соединения: шторм открытий большого проекта не выедает пул, запись транзакций и лёгкие
 * чтения получают соединение. Не дождались за `snapshotReadWaitMs` (DB_TIMEOUT_MS) или
 * очередь длиннее `snapshotReadQueue` (64) — 503 `busy` (`detail.cause: 'snapshot_reads'`).
 * Так же чтения журнала (круг 29: `txsAfter`, `recentTxMeta`) — `journalReads` (min(4, max − 4)),
 * очередь `journalReadQueue` (64), `detail.cause: 'journal_reads'`; и оба вида вместе — не больше
 * `heavyReads` (max − 4): из 10 соединений пула 4 всегда остаются записи и лёгким чтениям.
 * Чтение секвенсора (`internal: true`) — мимо пределов: его ограничивает мьютекс проекта.
 *
 * Дедлайны: обычные запросы — statement_timeout и query_timeout = DB_TIMEOUT_MS;
 * соединение, на котором истёк query_timeout или которое оборвалось, в пул не
 * возвращается (release(err)) — ROLLBACK на нём встал бы в очередь за зависшим запросом.
 * Полуоткрытое соединение (сеть пропала, ответ не дошёл): база сама обрывает сеанс,
 * простаивающий в транзакции дольше `idle_in_transaction_session_timeout` (15 с), —
 * замок строки проекта не висит вечно; TCP keepalive у пула, слушателя и миграций;
 * слушатель ещё и пингуется (SELECT 1 раз в 10 с) — молча умерший LISTEN переподключается.
 *
 * Миграции — отдельным соединением без дедлайна (`SET LOCAL statement_timeout = 0`),
 * под advisory-lock (берётся опросом — см. migrate), каждая в своей транзакции; `.mjs`-миграции сами режут работу
 * на пачки-транзакции и сообщают прогресс (`migrationState` — для 503 migrating).
 * DDL ждёт замок не дольше `lock_timeout` (1 с) и повторяется: ALTER, вставший в
 * очередь за долгой транзакцией, иначе держал бы за собой все запросы к таблице.
 * Схема годится для смешанных версий (SPEC §9.11): старый экземпляр, пишущий без
 * chain, работает и во время, и после миграций.
 *
 * Все запросы параметризованы; JSON в jsonb-колонки уходит строкой через
 * JSON.stringify — node-pg превращает массив-параметр в литерал массива
 * Postgres (`{…}`), и `ops` без явной сериализации в jsonb не ложится.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { toCommitted, txColumns, newEpoch, splitTombstones, joinTombstones } from './committed.js';
import { DB_TIMEOUT_MS, PAGE_BYTES, undoPartOf } from '../limits.js';
import { busy } from '../errors.js';
import { BYTES_SQL, COUNT_SQL } from './migrations/009_ops_size.mjs';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ключ advisory-lock миграций: два экземпляра на старте не должны мигрировать одновременно. */
const MIGRATION_LOCK = 728208;
/** Имя файла миграции: номер, имя, .sql или .mjs. */
const MIGRATION_RE = /^\d{3,}_[\w.-]+\.(sql|mjs)$/;
const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,53}$/;
/** application_name сеансов сервиса по умолчанию (круг 35: свои сеансы отличаются от чужих). */
export const APP_NAME = 'imago-document';
/** Код ошибки «база пуста или в неё идёт восстановление — запросы не идут» (круг 35; viaStorage → 503 schema). */
export const SCHEMA_WAIT = 'IMAGO_SCHEMA_WAIT';
/** Метка дозаполнения, которое ведёт другой экземпляр (health `detail.backfill.by`). */
export const FILL_BY_OTHER = 'другой экземпляр';
/** Таблицы схемы: у каждой есть первичный ключ; нет — схема неполна (восстановление посреди, круг 35). */
const KEYED_TABLES = ['schema_migrations', 'projects', 'operations', 'snapshots', 'project_epochs', 'traces'];
/**
 * Триггеры схемы по миграциям, которые их ставят (круг 39): миграция учтена, а триггера нет —
 * схема неполна (pg_dump ставит триггеры последними, после ключей), `restore`.
 */
const MIGRATION_TRIGGERS = [
  ['002_chain_epoch.sql', 'operations', 'operations_chain'],
  ['002_chain_epoch.sql', 'snapshots', 'snapshots_chain'],
  ['009_ops_size.mjs', 'operations', 'operations_size'],
  ['014_snapshot_engine.sql', 'snapshots', 'snapshots_engine']
];
/** Полезная нагрузка NOTIFY по умолчанию в Postgres — меньше 8000 байт. */
export const NOTIFY_MAX_BYTES = 7999;
/** Эфемерных сообщений в очереди соединения слушателя — больше не копим (база не успевает). */
const PUBLISH_QUEUE = 256;

/**
 * bigint (oid 20) node-pg отдаёт строкой, чтобы не терять точность; seq и
 * head_seq нужны числом, а до 2^53 они не дорастут. Переопределение — только
 * для этого пула, глобальный setTypeParser трогал бы чужие подключения.
 */
const types = {
  getTypeParser(oid, format) {
    if (oid === 20 && format !== 'binary') return (v) => (v === null ? null : Number(v));
    return pg.types.getTypeParser(oid, format);
  }
};

const OP_COLUMNS_BASE = 'project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, command_id, engine, chain, created_at';
/**
 * Колонки журнала: с `command_author` (миграция 010, круг 30) и `undo_part` (011, круг 32) — если
 * они в схеме.
 */
const opColumns = (withAuthor, withPart) => OP_COLUMNS_BASE + (withAuthor ? ', command_author' : '') + (withPart ? ', undo_part' : '');
const opColumnsO = (withAuthor, withPart) => opColumns(withAuthor, withPart).split(', ').map((c) => 'o.' + c).join(', ');

/** Сеанс, простаивающий в транзакции дольше этого, база обрывает сама (замок строки проекта отпускается). */
export const IDLE_IN_TX_MS = 15000;
/** Первая проба TCP keepalive простаивающего соединения. */
const KEEPALIVE_MS = 10000;
/** Пинг слушателя LISTEN: раз в столько, ответ — не дольше LISTEN_PING_TIMEOUT_MS. */
const LISTEN_PING_MS = 10000;
const LISTEN_PING_TIMEOUT_MS = 5000;
/** `ping()` (J1): ответ помнится столько мс — частый /api/health не нагружает базу. */
export const PING_CACHE_MS = 1000;
/** DDL миграции ждёт замок не дольше стольких мс и повторяется (до MIGRATION_LOCK_TRIES раз). */
const MIGRATION_LOCK_TIMEOUT_MS = 1000;
const MIGRATION_LOCK_TRIES = 60;
/** Пул соединений по умолчанию. */
export const POOL_MAX = 10;
/** Чтений снимка одновременно — не больше стольких (и не больше max − 4: запись должна получать соединение). */
export const SNAPSHOT_READS = 4;
/** Ждущих места чтений снимка — не больше; сверх — 503 busy сразу. */
export const SNAPSHOT_READ_QUEUE = 64;
/** Чтений журнала (страницы `txsAfter`, история) одновременно — не больше (и не больше max − 4). */
export const JOURNAL_READS = 4;
/** Ждущих места чтений журнала — не больше; сверх — 503 busy сразу. */
export const JOURNAL_READ_QUEUE = 64;
/** Истории (`recentTxMeta`) за раз — не больше стольких записей. */
export const RECENT_MAX = 1000;

/**
 * Предел одновременных задач с очередью ожидания (чтение снимков, чтение журнала). Место
 * освобождается — передаётся первому ждущему; ждущий дольше waitMs или сверх queue — `busy`
 * (`detail.cause` — чей предел). `parent` — общий предел над несколькими (все тяжёлые чтения
 * вместе): место берётся сначала своё, потом общее, ожидание обоих — в пределах одного waitMs.
 */
function createLimiter({ max, queue, waitMs, what, cause, parent = null }) {
  let active = 0;
  const waiting = [];
  const full = (why) => busy(`${what}: ${why} — повторите чуть позже`, { detail: { cause, active, waiting: waiting.length } });
  const release = () => {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      active--;
    }
  };
  /** null — место взято сразу; промис — ждём (до deadline); бросает — очередь полна. */
  const acquire = (deadline) => {
    if (active < max) {
      active++;
      return null;
    }
    if (waiting.length >= queue) throw full('очередь полна');
    return new Promise((resolve, reject) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        reject(full(`не дождались места за ${waitMs} мс`));
      }, Math.max(0, deadline - Date.now()));
      if (w.timer.unref) w.timer.unref();
      waiting.push(w);
    });
  };
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    max,
    /**
     * @param {() => Promise<any>} fn
     * @param {number} [deadline] срок ожидания места (общему пределу — от дочернего)
     */
    async run(fn, deadline = Date.now() + waitMs) {
      const wait = acquire(deadline);
      if (wait) await wait;
      try {
        return parent ? await parent.run(fn, deadline) : await fn();
      } finally {
        release();
      }
    }
  };
}

/**
 * Очередь запросов одного соединения: следующий — только после ответа на предыдущий
 * (node-pg предупреждает о запросе поверх выполняющегося, pg@9 их не примет).
 * `busyFor()` — сколько мс выполняется текущий запрос (0 — простаивает): мерило живости.
 */
function createSerial(client) {
  let tail = Promise.resolve();
  let pending = 0;
  let startedAt = 0;
  return {
    get pending() { return pending; },
    busyFor() { return startedAt ? Date.now() - startedAt : 0; },
    query(text, params) {
      pending++;
      const run = tail.then(() => {
        startedAt = Date.now();
        return client.query(text, params);
      });
      const done = run.finally(() => {
        startedAt = 0;
        pending--;
      });
      tail = done.catch(() => {});
      return done;
    }
  };
}

/**
 * Ошибка, после которой соединение больше не годится: истёк query_timeout (запрос
 * ещё идёт на сервере, следующий встанет за ним), соединение оборвано.
 */
function fatalForConnection(e) {
  const msg = e && e.message ? e.message : '';
  return msg === 'Query read timeout' || /Connection terminated|connection is closed|Client was closed|ECONNRESET|EPIPE|ETIMEDOUT|not queryable/i.test(msg)
    || (e && (e.code === '57P01' || e.code === '57P02' || e.code === '57P03' || e.code === '08006' || e.code === '08003' || e.code === '25P03'));
}

/** Оборвать соединение сразу, не дожидаясь ответа сервера (полуоткрытое не ответит). */
function destroyClient(client) {
  try {
    if (client.connection && client.connection.stream) client.connection.stream.destroy();
  } catch (_) { /* уже закрыто */ }
  client.end().catch(() => {});
}

const isoOf = (v) => (v instanceof Date ? v.toISOString() : v);

/** Снимок из строки таблицы; надгробия — v2 или null «неизвестно» (committed.joinTombstones). */
function snapshotOf(row) {
  if (!row) return null;
  const out = {
    seq: Number(row.seq), engine: row.engine, chain: row.chain || '',
    tombstones: joinTombstones({ seq: row.seq, chain: row.chain || '', parents: row.tombstones, meta: row.tombstones_meta, metaChain: row.tombstones_chain }),
    created_at: isoOf(row.created_at)
  };
  if ('doc' in row) out.doc = row.doc;
  return out;
}

/** Сводка записи журнала для истории (recentTxMeta, J2). */
function txMetaOf(r) {
  return {
    seq: Number(r.seq), tx_id: String(r.tx_id), author: r.author ?? null, author_kind: r.author_kind || 'human',
    title: r.title ?? null, created_at: isoOf(r.created_at), client: r.client ?? null, command_id: r.command_id ?? null,
    command_author: r.command_author ?? null,
    // круг 32: отмена/повтор и часть большой правки — «История» сводит части точно
    undo_of: r.undo_of ?? null, redo_of: r.redo_of ?? null, undo_part: undoPartOf(r.undo_part),
    ops_count: Number(r.ops_count) || 0, dropped_count: Number(r.dropped_count) || 0
  };
}

/** Проект из строки таблицы: даты — ISO-строками, как всё остальное в контракте. */
function projectOf(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, kind: row.kind, head_seq: Number(row.head_seq), engine: row.engine,
    head_chain: row.head_chain || '', epoch: row.epoch, epoch_cause: row.epoch_cause || 'init',
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at)
  };
}

/**
 * @param {{
 *   connectionString?: string,
 *   pool?: import('pg').Pool,
 *   options?: string,              // параметры сеанса (например, `-c search_path=x` — тестам)
 *   max?: number,
 *   connectionTimeoutMillis?: number,
 *   dbTimeoutMs?: number,          // дедлайн обычного запроса (DB_TIMEOUT_MS)
 *   migrationsDir?: string,
 *   channel?: string,              // канал LISTEN/NOTIFY (imago_doc)
 *   listen?: boolean,              // слушать уведомления (по умолчанию — да, если есть connectionString)
 *   applicationName?: string,      // application_name сеансов (слушатель — с суффиксом «:listen»); видно в pg_stat_activity
 *   listenRetryMs?: number,        // первая пауза переподключения слушателя (200 мс; дальше — вдвое, до 10 с)
 *   listenPingMs?: number,         // пинг слушателя (10 с; 0 — без пинга)
 *   listenPingTimeoutMs?: number,  // запрос на соединении слушателя дольше этого — соединение мертво (5 с)
 *   idleInTxMs?: number,           // idle_in_transaction_session_timeout (15 с)
 *   migrationLockTimeoutMs?: number, // lock_timeout DDL миграций (1 с; дальше — повтор)
 *   snapshotReads?: number,        // чтений снимка одновременно (min(SNAPSHOT_READS, max − 4), не меньше 1)
 *   snapshotReadQueue?: number,    // ждущих места чтений снимка (64); сверх — 503 busy
 *   snapshotReadWaitMs?: number,   // ждать места не дольше (DB_TIMEOUT_MS; 0 — 10 с)
 *   journalReads?: number,         // чтений журнала одновременно (min(JOURNAL_READS, max − 4), не меньше 1)
 *   journalReadQueue?: number,     // ждущих места чтений журнала (64); сверх — 503 busy
 *   journalReadWaitMs?: number,    // ждать места не дольше (как snapshotReadWaitMs)
 *   heavyReads?: number,           // снимков и журнала вместе одновременно (max − 4, не меньше 1)
 *   log?: {warn:Function, info:Function}
 * }} opts
 */
export function createPgStorage(opts = {}) {
  const log = opts.log || console;
  const dbTimeoutMs = opts.dbTimeoutMs !== undefined ? opts.dbTimeoutMs : Number(process.env.DB_TIMEOUT_MS || DB_TIMEOUT_MS);
  const migrationsDir = opts.migrationsDir || MIGRATIONS_DIR;
  const channel = opts.channel || 'imago_doc';
  if (!CHANNEL_RE.test(channel)) throw new Error('channel: имя канала NOTIFY — [a-z_][a-z0-9_]*');
  const presenceChannel = channel + '_presence';
  const listenRetryMs = opts.listenRetryMs > 0 ? opts.listenRetryMs : 200;
  const idleInTxMs = opts.idleInTxMs !== undefined ? opts.idleInTxMs : IDLE_IN_TX_MS;
  const listenPingMs = opts.listenPingMs !== undefined ? opts.listenPingMs : LISTEN_PING_MS;
  const listenPingTimeoutMs = opts.listenPingTimeoutMs > 0 ? opts.listenPingTimeoutMs : LISTEN_PING_TIMEOUT_MS;
  const migrationLockTimeoutMs = opts.migrationLockTimeoutMs > 0 ? opts.migrationLockTimeoutMs : MIGRATION_LOCK_TIMEOUT_MS;
  const base = {
    connectionString: opts.connectionString,
    types,
    // полуоткрытое соединение: база обрывает сеанс, застрявший в транзакции, сама
    ...(idleInTxMs > 0 ? { idle_in_transaction_session_timeout: idleInTxMs } : {}),
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_MS,
    ...(opts.options ? { options: opts.options } : {}),
    // круг 35: свои сеансы видно по имени — сверка схемы во время восстановления отличает их от чужих
    application_name: String(opts.applicationName || APP_NAME).slice(0, 56),
    // сервер без базы должен отвечать 503, а не висеть: ждём подключения не дольше 5 с
    connectionTimeoutMillis: opts.connectionTimeoutMillis || 5000
  };
  const poolMax = opts.max > 0 ? opts.max : POOL_MAX;
  const pool = opts.pool || new pg.Pool({
    ...base,
    max: poolMax,
    ...(dbTimeoutMs > 0 ? { statement_timeout: dbTimeoutMs, query_timeout: dbTimeoutMs + 1000 } : {}),
    // круг 35: новое соединение — в ту же базу? (пересоздали — сверка до первого запроса)
    onConnect: (client) => onPoolConnect(client)
  });
  // ошибка простаивающего соединения (база перезапустилась) без обработчика роняет процесс
  pool.on('error', (err) => log.warn('[document/pg] соединение потеряно:', err.message));
  const readWaitMs = opts.snapshotReadWaitMs > 0 ? opts.snapshotReadWaitMs : (dbTimeoutMs > 0 ? dbTimeoutMs : 10000);
  // тяжёлые чтения вместе (снимки и журнал) — не больше max − 4: запись транзакций и лёгкие
  // чтения (голова, проект, chainAt) всегда находят соединение в пуле
  const heavyReads = createLimiter({
    max: opts.heavyReads > 0 ? Math.floor(opts.heavyReads) : Math.max(1, poolMax - 4),
    queue: Infinity,   // ждут здесь не больше, чем впустили дочерние пределы
    waitMs: readWaitMs,
    what: 'чтение базы занято',
    cause: 'heavy_reads'
  });
  const snapshotReads = createLimiter({
    max: opts.snapshotReads > 0 ? Math.floor(opts.snapshotReads) : Math.max(1, Math.min(SNAPSHOT_READS, poolMax - 4)),
    queue: opts.snapshotReadQueue >= 0 ? Math.floor(opts.snapshotReadQueue) : SNAPSHOT_READ_QUEUE,
    waitMs: readWaitMs,
    what: 'чтение снимков занято',
    cause: 'snapshot_reads',
    parent: heavyReads
  });
  // чтения журнала (круг 29): шторм `ops?since=0` анонимов по большому журналу иначе занимал
  // все соединения пула — запись в другие проекты ждала соединения и получала 503
  const journalReads = createLimiter({
    max: opts.journalReads > 0 ? Math.floor(opts.journalReads) : Math.max(1, Math.min(JOURNAL_READS, poolMax - 4)),
    queue: opts.journalReadQueue >= 0 ? Math.floor(opts.journalReadQueue) : JOURNAL_READ_QUEUE,
    waitMs: opts.journalReadWaitMs > 0 ? opts.journalReadWaitMs : readWaitMs,
    what: 'чтение журнала занято',
    cause: 'journal_reads',
    parent: heavyReads
  });

  /* ------------------------------ уведомления ------------------------------ */

  const listeners = new Set();
  const canListen = opts.listen !== undefined ? !!opts.listen : !!opts.connectionString;
  let listener = null;
  let listenTimer = null;
  let listenAttempt = 0;
  let listenerPid = null;
  /** эфемерные отправки в полёте: close() их дожидается (bye должен успеть уйти) */
  const publishing = new Set();
  let closing = false;
  let initing = null;

  function dispatch(msg) {
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch (e) {
        log.warn('[document/pg] слушатель уведомлений упал:', e && e.message);
      }
    }
  }

  async function connectListener(isRetry) {
    if (closing) return;
    const client = new pg.Client({ ...base, application_name: base.application_name.slice(0, 49) + ':listen' });
    // у соединения одна судьба: error, end и сбой подключения приходят вперемешку, а
    // переподключение должно назначиться один раз — иначе поздний end старого клиента
    // заводил бы второго слушателя (две копии каждого уведомления и утечка соединения)
    let retried = false;
    const retry = () => {
      if (retried) return;
      retried = true;
      if (listener === client) {
        listener = null;
        listenerPid = null;
      }
      if (closing || listenTimer) return;
      const delay = Math.min(10000, listenRetryMs * Math.pow(2, Math.min(listenAttempt++, 6)));
      listenTimer = setTimeout(() => {
        listenTimer = null;
        connectListener(true).catch(() => {});
      }, delay);
      if (listenTimer.unref) listenTimer.unref();
    };
    client.on('notification', (m) => {
      if ((m.channel !== channel && m.channel !== presenceChannel) || !m.payload) return;
      let msg;
      try {
        msg = JSON.parse(m.payload);
      } catch (_) {
        return;
      }
      if (msg && typeof msg === 'object') dispatch(msg);
    });
    client.on('error', (e) => {
      log.warn('[document/pg] слушатель NOTIFY потерял соединение:', e && e.message);
      client.end().catch(() => {});
      retry();
    });
    client.on('end', () => { if (!closing) retry(); });
    // молча умершее соединение (полуоткрытое: ни error, ни end) — пинг; нет ответа — обрыв
    let pingTimer = null;
    const stopPing = () => { if (pingTimer) clearInterval(pingTimer); pingTimer = null; };
    client.once('end', stopPing);
    // все запросы этого соединения — по одному (эфемерные pg_notify, пинг)
    const serial = createSerial(client);
    client.serial = serial;
    try {
      await client.connect();
      await serial.query(`LISTEN ${channel}`);
      await serial.query(`LISTEN ${presenceChannel}`);
    } catch (e) {
      client.end().catch(() => {});
      if (!isRetry) throw e;
      retry();
      return;
    }
    if (closing) {
      await client.end().catch(() => {});
      return;
    }
    if (retried) return;   // соединение умерло, пока мы подписывались: переподключение уже назначено
    if (listenPingMs > 0) {
      let pinging = false;
      const dead = (why) => {
        if (closing || listener !== client) return;
        log.warn('[document/pg] слушатель NOTIFY не отвечает, переподключаюсь:', why);
        stopPing();
        destroyClient(client);
        retry();
      };
      pingTimer = setInterval(() => {
        if (listener !== client) return;
        // очередь движется — соединение живо; запрос висит дольше предела — мёртво
        if (serial.busyFor() > listenPingTimeoutMs) {
          dead(`запрос без ответа ${serial.busyFor()} мс`);
          return;
        }
        if (pinging || serial.pending) return;
        pinging = true;
        let timer;
        Promise.race([
          serial.query('SELECT 1'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('пинг слушателя без ответа')), listenPingTimeoutMs); })
        ]).catch((e) => dead(e && e.message)).finally(() => {
          clearTimeout(timer);
          pinging = false;
        });
      }, listenPingMs);
      if (pingTimer.unref) pingTimer.unref();
    }
    listener = client;
    listenerPid = client.processID || null;
    listenAttempt = 0;
    // пока соединения не было, уведомления терялись: головы сверяются с базой; и схема —
    // базу могли восстановить из копии, снятой до миграций (круг 31)
    if (isRetry) {
      checkSchema('слушатель переподключился').catch(() => {});
      dispatch({ k: 'resync' });
    }
  }

  async function notify(client, msg) {
    await client.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(msg)]);
  }

  /** Эфемерное сообщение (присутствие) через соединение слушателя; не вышло — потеряно. */
  function publish(msg) {
    const l = listener;
    if (!l || closing || publishing.size >= PUBLISH_QUEUE) return false;
    const text = JSON.stringify(msg);
    if (Buffer.byteLength(text, 'utf8') > NOTIFY_MAX_BYTES) return false;
    const p = l.serial.query('SELECT pg_notify($1, $2)', [presenceChannel, text])
      .catch(() => { /* эфемерное: следующее сердцебиение заменит */ })
      .finally(() => publishing.delete(p));
    publishing.add(p);
    return true;
  }

  /* -------------------------------- миграции -------------------------------- */

  /** Что сейчас делают миграции (503 migrating): null — не идут. */
  let migrationState = null;
  /** Соединение миграций в работе: close() обрывает его (SIGTERM во время миграций). */
  let migrationClient = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isLockTimeout = (e) => !!(e && (e.code === '55P03' || e.code === '40P01'));

  /**
   * Миграции (SPEC §9.8, §9.11): файлы каталога `NNN_имя.sql|mjs` по порядку, учёт в
   * schema_migrations. Отдельное соединение без дедлайна обычных запросов;
   * сессионный advisory-lock на всё время (включая создание таблицы учёта — два
   * экземпляра на пустой базе иначе столкнутся уже на CREATE TABLE). Каждая
   * `.sql` — своя транзакция с `SET LOCAL statement_timeout = 0` и коротким
   * `lock_timeout`: не дождалась замка — откат и повтор через паузу (DDL не стоит в
   * очереди за долгой транзакцией, держа за собой всех). `.mjs` получает соединение и
   * сама режет тяжёлую работу на пачки-транзакции; `ctx.progress({done, total})` —
   * прогресс для 503 migrating. Упавшая миграция откатывается и не записывается в
   * учёт: следующий старт начнёт с неё (её работа идемпотентна).
   */
  async function migrate({ deferFill = false, onDdl = null } = {}) {
    migrationState = { phase: 'connect', migration: null, progress: null };
    /** Круг 33: миграции с долгим дозаполнением (`ddlUp` + `fillUp`), отложенные до конца DDL. */
    const deferred = [];
    const client = new pg.Client({ ...base, ...(idleInTxMs > 0 ? { idle_in_transaction_session_timeout: Math.max(idleInTxMs, 60000) } : {}) });
    // разрыв посреди миграции — отказ запроса (и старта), а не необработанный error процесса
    client.on('error', (e) => log.warn('[document/pg] соединение миграций оборвалось:', e && e.message));
    migrationClient = client;
    let locked = false;
    /** Контекст `.mjs`-миграции. */
    const makeCtx = (file) => ({
      client,
      log,
      lockTimeoutMs: migrationLockTimeoutMs,
      lockTries: MIGRATION_LOCK_TRIES,
      /** Ключ advisory-lock миграций (008: кто его ждёт). */
      migrationLock: MIGRATION_LOCK,
      isLockTimeout,
      /** Прогресс для 503 migrating: {done, total} или что-то своё. */
      progress(p) {
        if (migrationState && migrationState.migration === file) migrationState.progress = p;
      },
      get closing() { return closing; }
    });

    try {
      if (closing) throw new Error('хранилище закрывается');
      await client.connect();
      await client.query('SET statement_timeout = 0');
      migrationState = { phase: 'lock', migration: null, progress: null };
      // замок — опросом (pg_try_advisory_lock), а не ожиданием в pg_advisory_lock: ждущий
      // в нём держит снимок, а CREATE INDEX CONCURRENTLY (008) ждёт все старые снимки —
      // взаимная блокировка «ждущий ↔ мигрирующий» (40P01)
      for (let attempt = 0; ; attempt++) {
        if ((await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK])).rows[0].ok) break;
        if (closing) throw new Error('хранилище закрывается');
        // круг 35: замок держит другой экземпляр, а ждут только отложенные дозаполнения, чей DDL
        // уже на месте (он их и заполняет) — схема годна: не ждём замка всё дозаполнение
        if (deferFill && attempt % 4 === 0) {
          const other = await othersFilling(client);
          if (other) {
            const byOther = other.filter((f) => !ownFill.has(f));
            if (onDdl) await onDdl({ deferred: other, byOther: byOther.length > 0 });
            return { byOther: other };
          }
        }
        await sleep(Math.min(500, 50 + 25 * attempt));
      }
      locked = true;
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = (await readdir(migrationsDir)).filter((f) => MIGRATION_RE.test(f)).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        if (closing) throw new Error('хранилище закрывается');
        const full = path.join(migrationsDir, file);
        const started = Date.now();
        migrationState = { phase: 'migrate', migration: file, progress: null, started_at: new Date(started).toISOString() };
        if (file.endsWith('.sql')) {
          const sql = await readFile(full, 'utf8');
          for (let attempt = 1; ; attempt++) {
            await client.query('BEGIN');
            try {
              await client.query('SET LOCAL statement_timeout = 0');
              await client.query(`SET LOCAL lock_timeout = ${Math.floor(migrationLockTimeoutMs)}`);
              await client.query(sql);
              await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
              await client.query('COMMIT');
              break;
            } catch (e) {
              await client.query('ROLLBACK').catch(() => {});
              if (isLockTimeout(e) && attempt < MIGRATION_LOCK_TRIES && !closing) {
                if (attempt === 1 || attempt % 10 === 0) log.warn(`[document/pg] миграция ${file}: замок таблицы занят, повтор ${attempt}`);
                await sleep(Math.min(2000, 100 * attempt));
                continue;
              }
              e.message = `миграция ${file}: ${e.message}`;
              throw e;
            }
          }
        } else {
          const mod = await import(pathToFileURL(full).href);
          if (typeof mod.up !== 'function') throw new Error(`миграция ${file}: нет export up()`);
          const ctx = makeCtx(file);
          // круг 33: под работающим экземпляром долгое дозаполнение — после DDL всех миграций:
          // запись тем временем идёт со всеми колонками (010, 011…), а не без них
          if (deferFill && typeof mod.ddlUp === 'function' && typeof mod.fillUp === 'function') {
            try {
              await mod.ddlUp(ctx);
            } catch (e) {
              e.message = `миграция ${file}: ${e.message}`;
              throw e;
            }
            deferred.push({ file, mod, started });
            log.info(`[document/pg] миграция ${file}: схема применена за ${Date.now() - started} мс, дозаполнение — после остальных миграций`);
            continue;
          }
          try {
            await mod.up(ctx);
          } catch (e) {
            e.message = `миграция ${file}: ${e.message}`;
            throw e;
          }
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        }
        log.info(`[document/pg] миграция ${file} применена за ${Date.now() - started} мс`);
      }
      for (const d of deferred) ownFill.add(d.file);
      if (onDdl) await onDdl({ deferred: deferred.map((d) => d.file), byOther: false });
      for (const d of deferred) {
        if (closing) throw new Error('хранилище закрывается');
        const started = Date.now();
        migrationState = { phase: 'fill', migration: d.file, progress: null, started_at: new Date(started).toISOString() };
        try {
          await d.mod.fillUp(makeCtx(d.file));
        } catch (e) {
          e.message = `миграция ${d.file} (дозаполнение): ${e.message}`;
          throw e;
        }
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [d.file]);
        ownFill.delete(d.file);
        log.info(`[document/pg] миграция ${d.file}: дозаполнение за ${Date.now() - started} мс — применена`);
      }
    } catch (e) {
      const file = migrationState && migrationState.migration;
      if (!/^миграция /.test(e.message || '')) e.message = `миграции${file ? ' (' + file + ')' : ''}: ${e.message}`;
      if (file) e.message += ` — сделанное сохранено, повторный старт продолжит с ${file}`;
      throw e;
    } finally {
      for (const d of deferred) ownFill.delete(d.file);
      migrationState = null;
      if (migrationClient === client) migrationClient = null;
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      await client.end().catch(() => {});
    }
  }

  /**
   * Круг 35: ждут ли миграции только отложенного дозаполнения, чей DDL уже на месте (его ведёт
   * держатель замка). Ждущие файлы — `.mjs` с `ddlUp`, `fillUp` и `ddlApplied(client)`, и
   * `ddlApplied` у каждого — true. Тогда — их список (пусто — ждать нечего: всё учтено); иначе null.
   * @param {import('pg').Client} client
   * @returns {Promise<string[]|null>}
   */
  async function othersFilling(client) {
    try {
      if (!(await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok) return null;
      const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = (await readdir(migrationsDir)).filter((f) => MIGRATION_RE.test(f)).sort();
      // первая миграция не учтена — база не та (пуста/чужая): тут решают замок и сверка
      if (files.length && !applied.has(files[0])) return null;
      const pending = files.filter((f) => !applied.has(f));
      for (const file of pending) {
        if (!file.endsWith('.mjs')) return null;
        const mod = await import(pathToFileURL(path.join(migrationsDir, file)).href);
        if (typeof mod.ddlUp !== 'function' || typeof mod.fillUp !== 'function' || typeof mod.ddlApplied !== 'function') return null;
        if (!(await mod.ddlApplied(client))) return null;
      }
      return pending;
    } catch (_) {
      return null;
    }
  }
  /** Отложенные дозаполнения, которые ведёт этот экземпляр (не «другой»). */
  const ownFill = new Set();

  /**
   * Соединение из пула на время транзакции. Пока соединение выдано, пул его ошибок не
   * слушает (pg-pool снимает свой обработчик), а `error` без обработчика роняет процесс:
   * разрыв между запросами транзакции (pg_terminate_backend, перезапуск базы, сеть)
   * иначе убивал бы экземпляр. Здесь ошибка запоминается, соединение возвращается в
   * пул сломанным (пул его выбросит), а запрос получит отказ → 503, клиент повторит.
   * `client.fail(e)` — запрос упал так, что соединение больше не годится (истёк
   * query_timeout: запрос всё ещё идёт на сервере, ROLLBACK встал бы за ним; обрыв):
   * сокет закрывается сразу, база откатывает транзакцию сама (или по
   * idle_in_transaction_session_timeout, если сеть полуоткрыта).
   */
  async function checkout() {
    const client = await pool.connect();
    let broken = null;
    const onError = (e) => {
      broken = e;
      log.warn('[document/pg] соединение оборвалось посреди транзакции:', e && e.message);
    };
    client.on('error', onError);
    let released = false;
    client.release = ((release) => (err) => {
      if (released) return;
      released = true;
      client.removeListener('error', onError);
      release(err || broken || undefined);
    })(client.release);
    client.fail = (e) => {
      if (!fatalForConnection(e)) return false;
      broken = broken || e;
      destroyClient(client);
      return true;
    };
    return client;
  }

  /** Запрос в транзакции базы на соединении из пула. */
  async function inTx(fn) {
    const client = await checkout();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      if (out && out.__rollback) {
        await client.query('ROLLBACK');
        return out.value;
      }
      await client.query('COMMIT');
      return out;
    } catch (e) {
      if (!client.fail(e)) await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  const rollback = (value) => ({ __rollback: true, value });

  const okId = (id) => UUID_RE.test(String(id));

  /**
   * Хвост после seq — на любом исполнителе запросов (пул или соединение транзакции).
   * Окно байт — по колонке `ops_bytes` (migrations/009): jsonb `ops` читается только у
   * записей, попавших в страницу (прежде окно детоастило все записи после LIMIT — до 500,
   * при транзакциях по 4 МБ ~2 ГБ на страницу). Запись без веса (после 009 таких нет) —
   * вес считается из jsonb, как раньше (coalesce ленив: при весе в колонке jsonb не читается).
   */
  async function txsAfterOn(q, projectId, seq, limit, maxBytes) {
    if (!okId(projectId)) return [];
    const res = await q.query(
      `SELECT ${opColumnsO(hasCommandAuthor, hasUndoPart)} FROM (
         SELECT l.seq,
                row_number() OVER (ORDER BY l.seq) AS rn,
                sum(l.b) OVER (ORDER BY l.seq ROWS UNBOUNDED PRECEDING) AS run_bytes
           FROM (SELECT seq, ${hasOpsSize ? `coalesce(ops_bytes, ${BYTES_SQL('operations')})` : BYTES_SQL('operations')} AS b
                   FROM operations WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3) l
       ) k JOIN operations o ON o.project_id = $1 AND o.seq = k.seq
       WHERE k.rn = 1 OR k.run_bytes <= $4 ORDER BY o.seq`,
      [projectId, seq, limit, maxBytes]
    );
    return res.rows.map(toCommitted);
  }

  /**
   * Колонки 009 есть (обычно — да; нет — каталог миграций без 009, как у тестов прежних
   * версий): без них вес считается из jsonb, запись — без колонок (их посчитал бы триггер).
   */
  let hasOpsSize = true;
  /** Колонка 010 (`command_author`) есть: без неё имя автора команды не пишется и не читается. */
  let hasCommandAuthor = true;
  /** Колонка 011 (`undo_part`, круг 32) есть: без неё часть большой правки не пишется и не читается. */
  let hasUndoPart = true;
  /** Колонка 012 (`projects.create_id`, круг 33) есть: без неё create_id не учитывается. */
  let hasCreateId = true;
  /** Колонка 013 (`projects.create_hash`, круг 35) есть: без неё отпечаток тела не пишется. */
  let hasCreateHash = true;
  async function columnExists(table, column) {
    const r = await pool.query(
      'SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped',
      [table, column]
    );
    return r.rowCount > 0;
  }
  /** Флаги колонок — по тому, что в схеме сейчас. */
  async function refreshFlags() {
    hasOpsSize = await columnExists('operations', 'ops_bytes');
    hasCommandAuthor = await columnExists('operations', 'command_author');
    hasUndoPart = await columnExists('operations', 'undo_part');
    hasCreateId = await columnExists('projects', 'create_id');
    hasCreateHash = await columnExists('projects', 'create_hash');
  }

  /* -------------------- сверка схемы под работающим экземпляром -------------------- */

  /**
   * Круг 31: базу восстановили из копии, снятой до миграций (009/010), — под работающим
   * экземпляром. Флаги колонок, посчитанные на старте, врут, и каждый запрос журнала падал
   * 42703 (нет колонки) — все проекты навсегда 503, а /api/health 200. Теперь: ошибка схемы
   * (42703 нет колонки, 42P01 нет таблицы) или переподключение слушателя (восстановление
   * рвёт соединения) — сверка: флаги по факту (запросы снова идут, пусть без новых колонок),
   * миграции заново под тем же advisory-замком, флаги ещё раз. Упавший запрос повторяется
   * один раз. Пока схема не согласована — `schemaState` (для /api/health: 503,
   * `detail.storage: 'schema'`).
   */
  const SCHEMA_CODES = new Set(['42703', '42P01']);
  const isSchemaError = (e) => !!(e && typeof e.code === 'string' && SCHEMA_CODES.has(e.code));
  /** null — схема согласована; иначе `{reason, since, phase, error?}`. */
  let schemaState = null;
  /** Сверка в полёте: `{flags, done}` — флаги по факту и сверка целиком. */
  let reschemaFlight = null;
  let reschemaFailedAt = 0;
  /**
   * Ждать сверки упавшему запросу — не дольше (дальше — повтор по фактическим флагам): DDL-миграции
   * (010) успевают, и повтор уже пишет новые колонки; долгое дозаполнение (009 на большом журнале)
   * запрос не ждёт — идёт без новых колонок (их посчитает триггер).
   */
  const schemaWaitMs = Math.min(1000, dbTimeoutMs > 0 ? dbTimeoutMs : 1000);
  /** Неудачную сверку /api/health повторяет не чаще. */
  const RESCHEMA_RETRY_MS = 2000;

  /**
   * Круг 33: идёт ли в эту базу восстановление (или она пуста) — тогда DDL нельзя.
   * Восстановление «в ту же базу» под работающим экземпляром (`dropdb; createdb; pg_restore`):
   * прежде сверка видела пустую базу и гнала все миграции с 001 параллельно с pg_restore —
   * дубли объектов и ошибки самого pg_restore. Теперь на работающем экземпляре миграции идут,
   * только если таблица учёта есть и в ней учтена первая миграция (база — та, что создавал
   * код), и к базе не подключён pg_restore (его сеанс виден в pg_stat_activity по
   * application_name). Иначе — `phase: 'empty'` или `'restore'` (health 503 `storage:'schema'`)
   * и проверка заново через EMPTY_RECHECK_MS. На старте процесса (init) — как раньше: пустую
   * базу создают миграции.
   *
   * Круг 35: в фазе empty/restore не идут и ЗАПРОСЫ (кроме /api/health) — запись в базу посреди
   * pg_restore (трасса, новый проект, транзакция) ложилась в таблицы до их первичных ключей, и
   * pg_restore падал на дублях (`traces_pkey`). И признаки восстановления шире:
   *   - у таблицы схемы (KEYED_TABLES) нет первичного ключа — схема неполна: ключи pg_dump
   *     ставит после данных, так ловится и `psql < dump.sql`, и переподключение посреди восстановления;
   *   - после ожидания (`settle`) — к базе подключён чужой сеанс (не сервиса: application_name не
   *     наш), дольше 0,5 с выполняющий запрос или стоящий в транзакции, — psql ещё льёт копию
   *     (короткие запросы экземпляра прежней версии, у которого имени нет, ожидание не держат).
   * @param {boolean} settle только что ждали — схема должна устояться
   * @param {{query: Function}} [q] на чём спрашивать (пул или соединение — onConnect)
   * @returns {Promise<null|{phase: 'empty'|'restore', detail: string}>}
   */
  async function restoreGuard(settle, q = pool) {
    if (!migrationFiles) migrationFiles = (await readdir(migrationsDir)).filter((f) => MIGRATION_RE.test(f)).sort();
    const first = migrationFiles[0];
    const r = (await q.query(
      `SELECT to_regclass('schema_migrations') IS NOT NULL AS has_table,
              (SELECT count(*)::int FROM pg_stat_activity
                WHERE datname = current_database() AND application_name = 'pg_restore' AND pid <> pg_backend_pid()) AS restoring,
              (SELECT count(*)::int FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
                  AND coalesce(state, '') NOT IN ('idle', '')
                  AND now() - coalesce(state_change, now()) > interval '500 milliseconds'
                  AND NOT (application_name = ANY($2::text[]) OR application_name LIKE '${APP_NAME}%')) AS foreign_busy,
              (SELECT count(*)::int FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
                  AND state = 'active' AND query ~* '^\\s*copy\\s.*\\sfrom\\s+stdin'
                  AND NOT (application_name = ANY($2::text[]) OR application_name LIKE '${APP_NAME}%')) AS foreign_copy,
              (SELECT count(*)::int FROM unnest($1::text[]) t(name)
                WHERE to_regclass(t.name) IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass(t.name) AND c.contype = 'p')) AS unkeyed,
              (SELECT count(*)::int FROM pg_class WHERE relnamespace = current_schema()::regnamespace) AS rels,
              (SELECT count(*)::int FROM pg_constraint WHERE connamespace = current_schema()::regnamespace) AS cons,
              (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace) AS trg`,
      [KEYED_TABLES, ownApps]
    )).rows[0];
    if (r.restoring > 0) return { phase: 'restore', detail: 'к базе подключён pg_restore' };
    if (!r.has_table) return { phase: 'empty', detail: 'нет таблицы schema_migrations' };
    const names = (await q.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((x) => x.name);
    if (first && !names.includes(first)) return { phase: 'empty', detail: `в schema_migrations нет ${first}` };
    if (r.unkeyed > 0) return { phase: 'restore', detail: 'схема неполна: у таблиц нет первичного ключа (идёт восстановление?)' };
    // круг 39: чужой сеанс льёт COPY … FROM stdin в эту базу — восстановление идёт, сколько бы он ни
    // длился (COPY … TO stdout — это pg_dump, резервная копия: она запросам не мешает)
    if (r.foreign_copy > 0) return { phase: 'restore', detail: 'чужой сеанс выполняет COPY в эту базу (идёт восстановление?)' };
    // круг 39: учтённые миграции поставили триггеры — их нет, значит схема ещё не долита
    const want = MIGRATION_TRIGGERS.filter(([m]) => names.includes(m));
    if (want.length) {
      const missing = (await q.query(
        `SELECT t.tg FROM unnest($1::text[], $2::text[]) AS t(tbl, tg)
          WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = to_regclass(t.tbl) AND g.tgname = t.tg AND NOT g.tgisinternal)`,
        [want.map((w) => w[1]), want.map((w) => w[2])]
      )).rows.map((x) => x.tg);
      if (missing.length) return { phase: 'restore', detail: `схема неполна: нет триггеров ${missing.join(', ')} (идёт восстановление?)` };
    }
    if (settle && r.foreign_busy > 0) return { phase: 'restore', detail: 'к базе подключён чужой сеанс и выполняет запросы (идёт восстановление?)' };
    // только что ждали (база была пуста или шло восстановление) — схема должна устояться: тот же
    // учёт и то же число объектов (таблицы, индексы, ограничения, триггеры) две проверки подряд —
    // восстановление не через pg_restore (psql < dump.sql) так не застаётся посреди DDL
    const sig = `${names.join(',')}|${r.rels}|${r.cons}|${r.trg}`;
    if (settle && sig !== lastSig) {
      lastSig = sig;
      return { phase: 'restore', detail: 'схема базы ещё меняется (идёт восстановление?)' };
    }
    lastSig = sig;
    return null;
  }
  /** Свои сеансы (пул, слушатель, миграции) — по application_name. */
  const ownApps = [base.application_name, base.application_name.slice(0, 49) + ':listen'];
  let lastSig = '';
  let lastGuardAt = 0;
  const EMPTY_RECHECK_MS = 1000;
  let emptyTimer = null;
  /** Дозаполнение под работающим экземпляром (круг 33): `{migration, since, progress?, by?}` или null. */
  let backfillState = null;
  let fillRetryAt = 0;
  /** Дозаполнение ведёт другой экземпляр (круг 35): проверяем, кончилось ли (или он умер), не чаще. */
  const OTHER_FILL_CHECK_MS = 2000;
  let otherFillCheckAt = 0;
  /** Сверка, попросившая начаться, пока этот экземпляр сам дозаполнял (её начнёт конец дозаполнения). */
  let pendingReschema = null;
  /** oid базы (pg_database): пересоздали базу (`dropdb; createdb`) — oid другой (круг 35). */
  let dbOid = null;
  const OID_SQL = 'SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()';
  const readOid = async (q = pool) => (await q.query(OID_SQL)).rows[0].oid;

  /** База пуста или в неё идёт восстановление — запросы не идут (круг 35). */
  const waitingNow = () => !!(schemaState && (schemaState.phase === 'empty' || schemaState.phase === 'restore'));

  /** Отказ запросу, пока база пуста или восстанавливается: viaStorage → 503 `cause:'schema'`. */
  function schemaWaitError() {
    const st = schemaState || {};
    const e = new Error(`${st.phase === 'empty' ? 'база пуста' : 'в базу идёт восстановление'}${st.wait ? ' (' + st.wait + ')' : ''} — запросы к хранилищу ждут его конца`);
    e.code = SCHEMA_WAIT;
    e.phase = st.phase || 'restore';
    return e;
  }

  /** Перейти в ожидание восстановления (или остаться в нём) и назначить проверку. */
  function enterWaiting(reason, since, guard) {
    const first = !waitingNow();
    schemaState = { reason, since, phase: guard.phase, wait: guard.detail };
    reschemaFailedAt = Date.now();
    if (first) log.warn(`[document/pg] сверка схемы (${reason}): ${guard.detail} — базу восстанавливают? Миграции не запускаю, запросы к хранилищу — 503 schema; проверяю раз в ${EMPTY_RECHECK_MS} мс`);
    if (!emptyTimer && !closing) {
      emptyTimer = setTimeout(() => {
        emptyTimer = null;
        if (!closing && waitingNow()) reschema(schemaState.reason);
      }, EMPTY_RECHECK_MS);
      if (emptyTimer.unref) emptyTimer.unref();
    }
  }

  /**
   * Круг 35: новое соединение пула — в ту же базу? Пересоздали (`dropdb; createdb`, oid
   * другой) — до первого запроса на нём проверить, не пуста ли она и не идёт ли восстановление:
   * иначе запрос, пришедший до переподключения слушателя, писал бы в таблицы посреди pg_restore.
   * Пуста/восстанавливается — отказ (503 schema) и ожидание; годна — сверка схемы.
   * @param {import('pg').Client} client
   */
  async function onPoolConnect(client) {
    if (closing || dbOid === null) return;
    const oid = await readOid(client);
    if (oid === dbOid) return;
    const guard = await restoreGuard(false, client);
    if (!guard) {
      if (dbOid === oid) return;   // соседнее соединение уже сверило ту же новую базу
      dbOid = oid;
      log.warn('[document/pg] база пересоздана (другой oid) — сверяю схему');
      checkSchema('база пересоздана').catch(() => {});
      return;
    }
    // уже ждём — фаза и причина обновляются (пустая база → идёт восстановление), время начала то же
    if (!waitingNow()) enterWaiting('база пересоздана', new Date().toISOString(), guard);
    else enterWaiting(schemaState.reason, schemaState.since, guard);
    throw schemaWaitError();
  }

  /** Пустой полёт сверки (ничего не делаем сейчас). */
  const noFlight = () => {
    const now = Promise.resolve();
    return { flags: now, ddl: now, done: now, ddlSettled: true };
  };

  /** Этот экземпляр дозаполнял и закончил — отложенная сверка, если просили. */
  function afterOwnFill() {
    if (!pendingReschema || ownFill.size || closing) return;
    const r = pendingReschema;
    pendingReschema = null;
    setImmediate(() => { if (!closing) reschema(r); });
  }

  /**
   * Сверка схемы. `quiet` (круг 35) — схема уже годна, нужно только дозаполнение (повтор
   * оборвавшегося или проверка дозаполнения другого экземпляра): health остаётся 200, фаза check/migrate
   * не выставляется.
   * @param {string} reason
   * @param {{quiet?: boolean}} [o]
   */
  function reschema(reason, { quiet = false } = {}) {
    if (reschemaFlight) return reschemaFlight;
    // свой фоновый дозаполнитель держит замок — сверка после него (иначе приняла бы его за «другого»)
    if (ownFill.size) {
      pendingReschema = pendingReschema || reason;
      return noFlight();
    }
    // ждали восстановления (empty/restore) — время начала то же, и в лог второй раз не пишем
    const waiting = waitingNow();
    // пока ждём, каждый упавший запрос не перепроверяет базу: проверка — не чаще EMPTY_RECHECK_MS
    if (waiting && Date.now() - lastGuardAt < EMPTY_RECHECK_MS) return noFlight();
    if (waiting) quiet = false;
    const since = waiting && schemaState.since ? schemaState.since : new Date().toISOString();
    // перепроверка во время ожидания восстановления — фаза та же (empty/restore), а не «check»
    if (!quiet) schemaState = waiting ? { ...schemaState } : { reason, since, phase: 'check' };
    let flagsDone;
    const flags = new Promise((r) => { flagsDone = r; });
    let ddlDone;
    const ddl = new Promise((r) => { ddlDone = r; });
    let ddlReady = false;
    const done = (async () => {
      try {
        // сразу — флаги по факту: запросы снова идут (без новых колонок), пока мигрируем
        if (!quiet) await refreshFlags().catch(() => {});
        flagsDone();
        if (closing) throw new Error('хранилище закрывается');
        // круг 33: пустая база или идёт pg_restore — DDL не трогаем, ждём и проверяем заново
        lastGuardAt = Date.now();
        const guard = await restoreGuard(waiting);
        if (guard) {
          enterWaiting(reason, since, guard);
          ddlDone();
          return;
        }
        dbOid = await readOid().catch(() => dbOid);
        if (!quiet) schemaState = { reason, since, phase: 'migrate' };
        // круг 33: DDL всех ждущих миграций — сначала, долгое дозаполнение (009) — потом: флаги
        // пересчитаны сразу после DDL, сервис здоров (health 200 с detail.backfill)
        await migrate({
          deferFill: true,
          onDdl: async ({ deferred, byOther }) => {
            await refreshFlags();
            ddlReady = true;
            schemaState = null;
            reschemaFailedAt = 0;
            const was = backfillState;
            backfillState = deferred.length
              ? { migration: deferred[0], since: was && was.migration === deferred[0] ? was.since : new Date().toISOString(), ...(byOther ? { by: FILL_BY_OTHER } : {}) }
              : null;
            const changed = !was !== !backfillState || (was && backfillState && (was.by !== backfillState.by || was.migration !== backfillState.migration));
            if (!quiet) {
              log.warn(`[document/pg] схема базы сверена (${reason}): миграции догнаны${deferred.length ? ` (дозаполнение ${deferred.join(', ')} — фоном${byOther ? ', ведёт другой экземпляр' : ''})` : ''}, колонки журнала — ops_bytes ${hasOpsSize ? 'есть' : 'нет'}, command_author ${hasCommandAuthor ? 'есть' : 'нет'}, undo_part ${hasUndoPart ? 'есть' : 'нет'}`);
            } else if (changed) {
              log.info(`[document/pg] дозаполнение: ${backfillState ? `${backfillState.migration} — ${backfillState.by ? 'ведёт другой экземпляр' : 'веду сам'}` : 'завершено (другим экземпляром)'}`);
            }
            ddlDone();
          }
        });
        if (backfillState && !backfillState.by) {
          log.info(`[document/pg] дозаполнение ${backfillState.migration} завершено`);
          backfillState = null;
        }
        fillRetryAt = 0;
      } catch (e) {
        flagsDone();
        ddlDone();
        if (backfillState && !backfillState.by) backfillState = null;
        if (ddlReady || (quiet && !schemaState)) {
          // схема уже годна, не дошло только дозаполнение — сервис здоров; повторит /api/health
          backfillState = null;
          fillRetryAt = Date.now() + RESCHEMA_RETRY_MS;
          if (!closing) log.warn(`[document/pg] дозаполнение после сверки схемы не завершено (${reason}): ${e && e.message} — повторю`);
        } else if (e && e.code === SCHEMA_WAIT && !closing) {
          // круг 39: соединение пула отвергнуто сверкой (база пересоздана и пуста/восстанавливается) —
          // это не «сверка не удалась», а то же ожидание восстановления: фаза остаётся empty/restore
          enterWaiting(reason, since, { phase: e.phase === 'empty' ? 'empty' : 'restore', detail: (schemaState && schemaState.wait) || 'идёт восстановление' });
        } else {
          reschemaFailedAt = Date.now();
          schemaState = { reason, since, phase: 'failed', error: String((e && e.message) || e).slice(0, 200) };
          if (!closing) log.warn(`[document/pg] сверка схемы базы не удалась (${reason}): ${e && e.message} — повторю`);
        }
        throw e;
      } finally {
        reschemaFlight = null;
        afterOwnFill();
      }
    })();
    done.catch(() => {});
    const flight = { flags, ddl, done, ddlSettled: false };
    ddl.then(() => { flight.ddlSettled = true; });
    reschemaFlight = flight;
    return reschemaFlight;
  }

  /**
   * Схема на месте? Дёшево (учёт миграций против каталога): после переподключения слушателя —
   * базу могли подменить. Круг 35: сначала — не пуста ли база и не идёт ли в неё восстановление
   * (restoreGuard всегда: учёт миграций мог уже лечь, а ключи таблиц — ещё нет). Не хватает
   * миграций или таблицы учёта — сверка; иначе только флаги.
   */
  let migrationFiles = null;
  async function checkSchema(reason) {
    if (closing || reschemaFlight) return;
    try {
      if (!migrationFiles) migrationFiles = (await readdir(migrationsDir)).filter((f) => MIGRATION_RE.test(f)).sort();
      if (await restoreGuard(false)) {
        reschema(reason);
        return;
      }
      dbOid = await readOid();
      const r = await pool.query('SELECT name FROM schema_migrations');
      const applied = new Set(r.rows.map((x) => x.name));
      // своё фоновое дозаполнение — не «недостающая» миграция
      const missing = migrationFiles.filter((f) => !applied.has(f) && !ownFill.has(f));
      if (missing.length) {
        log.warn(`[document/pg] ${reason}: в базе не учтены миграции ${missing.join(', ')} — базу восстановили из старой копии? Догоняю`);
        reschema(`${reason}: нет ${missing.join(', ')}`);
        return;
      }
      await refreshFlags();
    } catch (e) {
      if (isSchemaError(e)) reschema(`${reason}: ${e.code}`);
      // база недоступна — скажет ping; сверим при следующем переподключении или ошибке
    }
  }

  /**
   * Запрос с одной попыткой после сверки схемы: ошибка схемы → сверка (флаги, миграции,
   * флаги) — ждём её не дольше schemaWaitMs и повторяем по флагам, какие есть.
   * Круг 35: база пуста или в неё идёт восстановление — запрос не идёт вовсе (SCHEMA_WAIT → 503 schema).
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withSchema(fn) {
    // круг 33: сверка идёт, а DDL ещё нет — флаги уже «без колонок», и запрос молча записал бы
    // без command_author/undo_part; подождать DDL (не дольше schemaWaitMs), как упавший запрос
    const pending = reschemaFlight;
    if (pending && !pending.ddlSettled) {
      let t;
      await Promise.race([pending.ddl, new Promise((r) => {
        t = setTimeout(r, schemaWaitMs);
        if (t.unref) t.unref();
      })]);
      clearTimeout(t);
    }
    if (waitingNow()) throw schemaWaitError();
    try {
      return await fn();
    } catch (e) {
      if (closing || !e || e.code === SCHEMA_WAIT) throw e;
      if (!isSchemaError(e)) {
        // база пуста или восстанавливается, а мы ещё не знали (запрос начался раньше) — та же причина
        if (waitingNow()) throw schemaWaitError();
        throw e;
      }
      log.warn(`[document/pg] схема базы не та, что ждёт код (${e.code}: ${e.message}) — сверяю миграции и повторяю запрос`);
      const flight = reschema(e.code);
      await flight.flags;
      let timer;
      // круг 33: ждём DDL (не дозаполнения): повтор уже пишет новые колонки
      await Promise.race([flight.ddl, new Promise((r) => {
        timer = setTimeout(r, schemaWaitMs);
        if (timer.unref) timer.unref();
      })]);
      clearTimeout(timer);
      if (waitingNow()) throw schemaWaitError();
      return await fn();
    }
  }

  /* --------------------------------- здоровье --------------------------------- */

  let pingCache = null;     // {at, value}
  let pingFlight = null;    // ответ, которого ждут все одновременные ping()
  let probing = null;       // проба базы ещё без ответа (могла пережить свой таймаут)

  /** SELECT 1: из пула; пул выдан весь — на соединении слушателя (база жива, просто занята). */
  function probe() {
    const max = (pool.options && pool.options.max) || poolMax;
    const l = listener;
    const saturated = pool.idleCount === 0 && pool.totalCount >= max;
    if (saturated && l && l.serial && l.serial.busyFor() === 0) return l.serial.query('SELECT 1');
    // круг 35: база пересоздана и пуста/восстанавливается — соединение отвергнуто сверкой, но база
    // отвечает: она жива (health скажет 503 schema по schemaState, а не «down»)
    return pool.query('SELECT 1').catch((e) => {
      if (e && e.code === SCHEMA_WAIT) return null;
      throw e;
    });
  }

  /**
   * Жива ли база (J1): true/false, не бросает. Ответ помнится PING_CACHE_MS; одновременные
   * вызовы ждут одну пробу; нет ответа за timeoutMs — false, и следующая проба не начинается,
   * пока та не ответит (зависшая база не копит пробы в очереди пула). Адаптер закрыт — false.
   * @param {{timeoutMs?: number}} [o]
   * @returns {Promise<boolean>}
   */
  function ping({ timeoutMs = 1000 } = {}) {
    if (closing) return Promise.resolve(false);
    // сверка схемы не удалась (база была недоступна посреди неё) — /api/health её повторяет
    if (schemaState && !reschemaFlight && Date.now() - reschemaFailedAt > RESCHEMA_RETRY_MS) reschema(schemaState.reason);
    // дозаполнение после сверки оборвалось (схема годна) — повторить
    else if (!schemaState && fillRetryAt && !reschemaFlight && Date.now() > fillRetryAt) {
      fillRetryAt = 0;
      reschema('дозаполнение не завершено', { quiet: true });
    }
    // круг 35: дозаполнение ведёт другой экземпляр — кончилось ли (или он умер — тогда ведём сами)
    else if (!schemaState && backfillState && backfillState.by && !reschemaFlight && Date.now() - otherFillCheckAt > OTHER_FILL_CHECK_MS) {
      otherFillCheckAt = Date.now();
      reschema('дозаполнение ведёт другой экземпляр', { quiet: true });
    }
    if (pingCache && Date.now() - pingCache.at < PING_CACHE_MS) return Promise.resolve(pingCache.value);
    if (pingFlight) return pingFlight;
    pingFlight = (async () => {
      let value = false;
      if (!probing) {
        const p = Promise.resolve().then(probe).then(() => true, () => false);
        probing = p;
        p.finally(() => { if (probing === p) probing = null; });
        let timer;
        value = await Promise.race([p, new Promise((r) => {
          timer = setTimeout(() => r(false), Math.max(1, timeoutMs));
          if (timer.unref) timer.unref();
        })]);
        clearTimeout(timer);
      }
      pingCache = { at: Date.now(), value };
      return value;
    })().finally(() => { pingFlight = null; });
    return pingFlight;
  }

  /**
   * Миграции на старте процесса (круг 35): DDL — сразу (до него сервис отвечает 503 migrating), долгое
   * дозаполнение отложенных миграций (`ddlUp` + `fillUp`, это 009) — фоном: сервис готов, /api/health
   * 200 с `detail.backfill`. Дозаполнение ведёт другой экземпляр (держит замок, DDL на месте) — замка не
   * ждём (`by: 'другой экземпляр'`). Промис — до конца DDL; дозаполнение оборвалось — повтор из /api/health.
   */
  const FILL_GRACE_MS = 500;
  function startMigrations() {
    return new Promise((resolve, reject) => {
      let ddl = false;
      const run = migrate({
        deferFill: true,
        onDdl: async ({ deferred, byOther }) => {
          await refreshFlags();
          ddl = true;
          backfillState = deferred.length ? { migration: deferred[0], since: new Date().toISOString(), ...(byOther ? { by: FILL_BY_OTHER } : {}) } : null;
          if (!deferred.length || byOther) {
            if (deferred.length) log.info(`[document/pg] миграции: схема готова, дозаполнение ${deferred.join(', ')} ведёт другой экземпляр`);
            resolve();
            return;
          }
          // малый журнал (новая база) дозаполняется за миллисекунды — тогда старт ждёт его целиком;
          // большой — сервис готов через FILL_GRACE_MS, дозаполнение идёт фоном
          const t = setTimeout(() => {
            if (backfillState) log.info(`[document/pg] миграции: схема готова, дозаполнение ${deferred.join(', ')} — фоном`);
            resolve();
          }, FILL_GRACE_MS);
          if (t.unref) t.unref();
        }
      });
      run.then(() => {
        if (backfillState && !backfillState.by) {
          log.info(`[document/pg] дозаполнение ${backfillState.migration} завершено`);
          backfillState = null;
        }
        resolve();
        afterOwnFill();
      }, (e) => {
        if (!ddl) {
          reject(e);
          return;
        }
        if (backfillState && !backfillState.by) backfillState = null;
        if (!closing) {
          fillRetryAt = Date.now() + RESCHEMA_RETRY_MS;
          log.warn(`[document/pg] дозаполнение на старте не завершено: ${e && e.message} — повторю`);
        }
        afterOwnFill();
      });
    });
  }

  const self = {
    kind: 'pg',
    /** Пул наружу — тестам, чтобы чистить таблицы; сервису он не нужен. */
    pool,
    channel,
    presenceChannel,
    migrate,
    publish,
    ping,
    /** Что делают миграции сейчас (`{phase, migration, progress}`) или null — для 503 migrating. */
    get migrationState() { return migrationState ? { ...migrationState } : null; },
    /** Слушатель уведомлений подключён (тестам и /health-отладке). */
    get listening() { return !!listener; },
    /** pid серверного процесса слушателя (тестам: pg_terminate_backend). */
    get listenerPid() { return listenerPid; },
    /**
     * Схема базы не согласована с кодом (круг 31: базу восстановили из копии до миграций) —
     * `{reason, since, phase: 'check'|'migrate'|'failed', error?, migration?}`; null — согласована.
     */
    get schemaState() {
      if (!schemaState) return null;
      const out = { ...schemaState };
      if (migrationState && migrationState.migration) out.migration = migrationState.migration;
      return out;
    },
    /**
     * Дозаполнение после сверки схемы идёт фоном (круг 33): `{migration, since, progress?}` или null.
     * Сервис здоров (схема годна) — /api/health 200 с `detail.backfill`.
     */
    get backfillState() {
      if (!backfillState) return null;
      const out = { ...backfillState };
      if (migrationState && migrationState.phase === 'fill' && migrationState.migration) {
        out.migration = migrationState.migration;
        if (migrationState.progress) out.progress = migrationState.progress;
      }
      return out;
    },
    /** Круг 35: попутная проверка «не идёт ли восстановление» (у проекта нет снимка и т. п.); не ждёт. */
    checkRestore(reason = 'по запросу') { checkSchema(reason).catch(() => {}); },
    /** Сверить схему сейчас (тестам и отладке): промис сверки. */
    recheckSchema(reason = 'по запросу') { return reschema(reason).done; },
    /** Колонки журнала, которые адаптер сейчас пишет и читает (тестам). */
    get schemaFlags() { return { opsSize: hasOpsSize, commandAuthor: hasCommandAuthor, undoPart: hasUndoPart, createId: hasCreateId, createHash: hasCreateHash }; },

    /** Миграции и слушатель уведомлений; повторный вызов (второй экземпляр на том же адаптере) — тот же промис. */
    init() {
      if (!initing) {
        initing = (async () => {
          await startMigrations();
          await refreshFlags();
          dbOid = await readOid();
          if (canListen) await connectListener(false);
        })();
        initing.catch(() => { initing = null; });
      }
      return initing;
    },

    async close() {
      // последние эфемерные (bye остановки) — до закрытия слушателя, но не дольше секунды
      if (publishing.size) await Promise.race([Promise.allSettled([...publishing]), new Promise((r) => setTimeout(r, 1000).unref())]);
      closing = true;
      // SIGTERM во время миграций: соединение миграций рвётся, база откатывает текущую
      // пачку; сделанное раньше сохранено, следующий старт продолжит
      if (migrationClient) destroyClient(migrationClient);
      if (listenTimer) clearTimeout(listenTimer);
      listenTimer = null;
      if (emptyTimer) clearTimeout(emptyTimer);
      emptyTimer = null;
      if (listener) {
        const l = listener;
        listener = null;
        await l.end().catch(() => {});
      }
      listeners.clear();
      await pool.end();
    },

    onNotify(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Новый проект и его снимок seq 0. `docJson` — документ уже строкой JSON (импорт готовит его
     * вне цикла событий, круг 33) — тогда `doc` не нужен. `createId` (круг 33, L1, миграция 012):
     * проект с таким create_id уже есть — он и возвращается с `existing: true`, второй не
     * создаётся (гонка двух одинаковых запросов — уникальный индекс, ON CONFLICT). Колонки нет
     * (схема до 012) — create_id не учитывается.
     */
    async createProject({ name = '', kind = 'design', doc, docJson, engine, createId, createHash }) {
      const epoch = newEpoch();
      const cid = typeof createId === 'string' && createId && hasCreateId ? createId : null;
      // круг 35: отпечаток тела (013) — повтор с другим телом отличим (409 create_id_conflict)
      const hash = cid && hasCreateHash && typeof createHash === 'string' && createHash ? createHash : null;
      if (cid) {
        const found = await self.projectByCreateId(cid);
        if (found) return { ...found, existing: true };
      }
      const made = await inTx(async (client) => {
        const ins = await client.query(
          cid
            ? `INSERT INTO projects (name, kind, engine, epoch, epoch_cause, create_id${hash ? ', create_hash' : ''}) VALUES ($1, $2, $3, $4, 'init', $5${hash ? ', $6' : ''}) ON CONFLICT (create_id) WHERE create_id IS NOT NULL DO NOTHING RETURNING *`
            : 'INSERT INTO projects (name, kind, engine, epoch, epoch_cause) VALUES ($1, $2, $3, $4, \'init\') RETURNING *',
          cid ? [name, kind, engine, epoch, cid, ...(hash ? [hash] : [])] : [name, kind, engine, epoch]
        );
        // тот же create_id записал одновременный запрос — ничего не создаём
        if (!ins.rows.length) return rollback(null);
        const project = projectOf(ins.rows[0]);
        // документ = снимок при seq 0: открытие проекта всегда начинается со снимка; его не удаляет прореживание
        await client.query(
          'INSERT INTO snapshots (project_id, seq, doc, engine, chain, tombstones) VALUES ($1, 0, $2::jsonb, $3, \'\', \'{}\'::jsonb)',
          [project.id, typeof docJson === 'string' ? docJson : JSON.stringify(doc), engine]
        );
        await client.query('INSERT INTO project_epochs (project_id, epoch, seq, cause) VALUES ($1, $2, 0, \'init\') ON CONFLICT DO NOTHING', [project.id, epoch]);
        return project;
      });
      if (made) return made;
      const found = await self.projectByCreateId(cid);
      if (!found) throw new Error('проект с этим create_id создаётся одновременно — повторите');
      return { ...found, existing: true };
    },

    /**
     * Проект по create_id (круг 33, L1) или null; колонки нет (схема до 012) — null. `create_hash` —
     * отпечаток тела создания (круг 35, 013) или null (неизвестен).
     */
    async projectByCreateId(createId) {
      if (!hasCreateId || typeof createId !== 'string' || !createId) return null;
      const res = await pool.query('SELECT * FROM projects WHERE create_id = $1', [createId]);
      const p = projectOf(res.rows[0]);
      return p ? { ...p, create_hash: res.rows[0].create_hash || null } : null;
    },

    async listProjects() {
      const res = await pool.query('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC');
      return res.rows.map(projectOf);
    },

    /**
     * Страница списка (круг 26), ключом (updated_at, id) по убыванию. Ключ курсора —
     * время с микросекундами (как в базе: ISO projectOf режет до мс, и строки одной
     * миллисекунды на границе страницы терялись бы или повторялись).
     * @param {{kind?: string, limit?: number, after?: {at: string, id: string}}} [o]
     */
    async listProjectsPage({ kind, limit = 200, after } = {}) {
      if (after && !okId(after.id)) return { projects: [], more: false, next: null };
      const res = await pool.query(
        `SELECT *, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM projects
          WHERE ($1::text IS NULL OR kind = $1)
            AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY updated_at DESC, id DESC
          LIMIT $4`,
        [kind || null, after ? after.at : null, after ? after.id : null, limit + 1]
      );
      const more = res.rows.length > limit;
      const rows = more ? res.rows.slice(0, limit) : res.rows;
      const last = rows[rows.length - 1];
      return { projects: rows.map(projectOf), more, next: more && last ? { at: last.cursor_at, id: last.id } : null };
    },

    async getProject(id) {
      // не-uuid — это «нет такого проекта» (404), а не ошибка базы «invalid input syntax» (503)
      if (!okId(id)) return null;
      const res = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
      return projectOf(res.rows[0]);
    },

    async renameProject(id, name) {
      if (!okId(id)) return null;
      const res = await pool.query(
        'UPDATE projects SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, name]
      );
      return projectOf(res.rows[0]);
    },

    /**
     * Последний снимок, которому можно верить: seq 0 (затравка) или снимок, чей
     * chain совпадает с журналом на его seq. Снимок, записанный по журналу, которого
     * после отката базы уже нет, не годится — с него клиент тихо разошёлся бы.
     * Под пределом чтений снимков (шапка): документ — тяжёлое чтение.
     */
    async latestSnapshot(projectId) {
      if (!okId(projectId)) return null;
      return snapshotReads.run(async () => {
        const res = await pool.query(
          `SELECT s.seq, s.doc, s.engine, s.chain, s.tombstones, s.tombstones_meta, s.tombstones_chain, s.created_at FROM snapshots s
            WHERE s.project_id = $1
              AND (s.seq = 0 OR EXISTS (SELECT 1 FROM operations o WHERE o.project_id = s.project_id AND o.seq = s.seq AND o.chain = s.chain))
            ORDER BY s.seq DESC LIMIT 1`,
          [projectId]
        );
        return snapshotOf(res.rows[0]);
      });
    },

    /**
     * Тот же снимок, что у latestSnapshot, — без документа и надгробий (круг 27, I2):
     * `?lean=1`, `?head=1`. Колонки doc и tombstones не названы — их TOAST не
     * читается (замер — в заметках круга); предел чтений снимков не нужен.
     * @returns {Promise<{seq: number, chain: string, engine: number, epoch: string, created_at: string}|null>}
     */
    async latestSnapshotMeta(projectId) {
      if (!okId(projectId)) return null;
      const res = await pool.query(
        `SELECT s.seq, s.engine, s.chain, s.created_at, p.epoch FROM snapshots s JOIN projects p ON p.id = s.project_id
          WHERE s.project_id = $1
            AND (s.seq = 0 OR EXISTS (SELECT 1 FROM operations o WHERE o.project_id = s.project_id AND o.seq = s.seq AND o.chain = s.chain))
          ORDER BY s.seq DESC LIMIT 1`,
        [projectId]
      );
      const row = res.rows[0];
      if (!row) return null;
      return { seq: Number(row.seq), chain: row.chain || '', engine: row.engine, epoch: row.epoch, created_at: isoOf(row.created_at) };
    },

    /**
     * Ближайший снимок раньше `seq` с известными надгробиями (круг 27, I1): годный по
     * журналу (как latestSnapshot) и с `tombstones` ≠ null; seq 0 — всегда такой (его не
     * удаляет прореживание). От него и `remove` журнала после него восстанавливаются
     * надгробия снимка, записанного экземпляром прежней версии.
     * @param {string} projectId
     * @param {number} seq
     * @param {{doc?: boolean}} [o] doc:false — без документа (тогда без предела чтений)
     */
    async snapshotBefore(projectId, seq, { doc = true } = {}) {
      if (!okId(projectId) || !Number.isFinite(Number(seq))) return null;
      const read = async () => {
        const res = await pool.query(
          `SELECT s.seq, ${doc ? 's.doc, ' : ''}s.engine, s.chain, s.tombstones, s.tombstones_meta, s.tombstones_chain, s.created_at FROM snapshots s
            WHERE s.project_id = $1 AND s.seq < $2
              AND (s.seq = 0 OR (s.tombstones_chain = s.chain
                   AND EXISTS (SELECT 1 FROM operations o WHERE o.project_id = s.project_id AND o.seq = s.seq AND o.chain = s.chain)))
            ORDER BY s.seq DESC LIMIT 1`,
          [projectId, Number(seq)]
        );
        return snapshotOf(res.rows[0]);
      };
      return doc ? snapshotReads.run(read) : read();
    },

    /** Предел чтений снимков (тестам и отладке): {max, active, waiting}. */
    get snapshotReads() { return { max: snapshotReads.max, active: snapshotReads.active, waiting: snapshotReads.waiting }; },
    /** Предел чтений журнала (тестам и отладке): {max, active, waiting}. */
    get journalReads() { return { max: journalReads.max, active: journalReads.active, waiting: journalReads.waiting }; },
    /** Общий предел тяжёлых чтений — снимков и журнала (тестам и отладке). */
    get heavyReads() { return { max: heavyReads.max, active: heavyReads.active, waiting: heavyReads.waiting }; },

    /** Номера снимков проекта (тестам и отладке). */
    async snapshotSeqs(projectId) {
      if (!okId(projectId)) return [];
      const res = await pool.query('SELECT seq FROM snapshots WHERE project_id = $1 ORDER BY seq', [projectId]);
      return res.rows.map((r) => Number(r.seq));
    },

    /**
     * Хвост после seq: не больше limit записей и — мягко — maxBytes JSON (первая
     * запись входит всегда, даже если одна больше предела; дальше — только те, с
     * которыми сумма не больше maxBytes; так же режет адаптер в памяти). Окно
     * считается ПОСЛЕ LIMIT: иначе сумма шла бы по всему хвосту проекта, и
     * дочитывание длинного журнала страницами стоило бы квадрат. Вес записи — колонка
     * `ops_bytes` (009): jsonb читается только у записей самой страницы.
     * Под пределом чтений журнала (круг 29): шторм догонов анонимов не выедает пул записи.
     * `internal: true` — чтение самого сервиса (голова секвенсора догоняет журнал на пути
     * записи) — мимо предела: его и так ограничивает мьютекс проекта, а ждать за анонимами
     * запись не должна.
     * @param {{maxBytes?: number, internal?: boolean}} [o]
     */
    async txsAfter(projectId, seq, limit = 500, { maxBytes = PAGE_BYTES, internal = false } = {}) {
      if (internal) return txsAfterOn(pool, projectId, seq, limit, maxBytes);
      return journalReads.run(() => txsAfterOn(pool, projectId, seq, limit, maxBytes));
    },

    /**
     * Сводки последних транзакций — для истории (J2): от новых к старым, без чтения `ops`
     * (`ops_count` — колонка 009; `dropped` мал — выжимка, ≤ DROPPED_KEEP записей).
     * `beforeSeq` — только seq < данного (следующая страница истории). Под пределом чтений журнала.
     * @param {string} projectId
     * @param {{limit?: number, beforeSeq?: number}} [o]
     * @returns {Promise<Array<{seq: number, tx_id: string, author: string|null, author_kind: string, title: string|null,
     *   created_at: string, client: string|null, command_id: string|null, ops_count: number, dropped_count: number}>>}
     */
    async recentTxMeta(projectId, { limit = 50, beforeSeq } = {}) {
      if (!okId(projectId)) return [];
      const lim = Math.max(1, Math.min(RECENT_MAX, Math.floor(Number(limit)) || 50));
      const before = beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(Number(beforeSeq)) ? Math.floor(Number(beforeSeq)) : null;
      return journalReads.run(async () => {
        const res = await pool.query(
          `SELECT seq, tx_id, author, author_kind, title, created_at, client, command_id, undo_of, redo_of,${hasCommandAuthor ? ' command_author,' : ''}${hasUndoPart ? ' undo_part,' : ''}
                  ${hasOpsSize ? `coalesce(ops_count, ${COUNT_SQL('operations')})` : COUNT_SQL('operations')} AS ops_count,
                  (SELECT coalesce(sum(CASE WHEN jsonb_typeof(e) = 'object' AND e ? 'more' AND NOT e ? 'index'
                                                 AND jsonb_typeof(e -> 'more') = 'number'
                                            THEN (e ->> 'more')::numeric ELSE 1 END), 0)::int
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(dropped) = 'array' THEN dropped ELSE '[]'::jsonb END) e) AS dropped_count
             FROM operations
            WHERE project_id = $1 ${before !== null ? 'AND seq < $3' : ''}
            ORDER BY seq DESC LIMIT $2`,
          before !== null ? [projectId, lim, before] : [projectId, lim]
        );
        return res.rows.map(txMetaOf);
      });
    },

    async chainAt(projectId, seq) {
      if (!okId(projectId)) return null;
      if (seq === 0) {
        const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
        return p.rowCount ? '' : null;
      }
      const res = await pool.query('SELECT chain FROM operations WHERE project_id = $1 AND seq = $2', [projectId, seq]);
      return res.rows[0] ? res.rows[0].chain : null;
    },

    /**
     * Запись транзакции — в одной транзакции базы (SPEC §9.4, п.3; §9.8):
     * UPDATE head_seq + 1, head_chain = sha256(head_chain + tx_id + seq) RETURNING →
     * INSERT … ON CONFLICT (project_id, tx_id) DO NOTHING → pg_notify.
     * Конфликт по tx_id → откат (номер головы не уходит вперёд без записи) и
     * существующая запись. `expectSeq`/`expectChain` — чего ждёт голова в памяти:
     * другой номер или другая цепочка → откат и `stale` (head_seq — голова базы до
     * нашей попытки; `reason:'chain'` — номер тот же, а журнал под ним другой).
     */
    async commitTx(projectId, tx, { expectSeq, expectChain, origin } = {}) {
      if (!okId(projectId)) return { status: 'missing' };
      const c = txColumns(tx);
      const client = await checkout();
      try {
        await client.query('BEGIN');
        const up = await client.query(
          `UPDATE projects SET head_seq = head_seq + 1,
                  head_chain = encode(sha256(convert_to(head_chain || $2 || (head_seq + 1)::text, 'UTF8')), 'hex'),
                  updated_at = now()
            WHERE id = $1 RETURNING head_seq, head_chain, epoch`,
          [projectId, c.tx_id]
        );
        if (!up.rowCount) {
          await client.query('ROLLBACK');
          return { status: 'missing' };
        }
        const seq = Number(up.rows[0].head_seq);
        const chain = up.rows[0].head_chain;
        const epoch = up.rows[0].epoch;
        const opsJson = JSON.stringify(c.ops);
        const droppedJson = JSON.stringify(c.dropped);
        const params = [projectId, seq, c.tx_id, c.base_seq, opsJson, droppedJson, JSON.stringify(c.notes),
          c.undo_of, c.redo_of, c.author, c.author_kind, c.client, c.title, c.engine, chain, c.command_id];
        // вес и число операций (009) — из уже готового JSON: триггер (его ::text у 4 МБ — десятки
        // мс на каждую запись) остаётся экземплярам прежней версии
        if (hasOpsSize) params.push(Buffer.byteLength(opsJson, 'utf8') + Buffer.byteLength(droppedJson, 'utf8'), Array.isArray(c.ops) ? c.ops.length : 0);
        // круг 30: имя автора команды агента (010); схема без 010 — не пишется
        if (hasCommandAuthor) params.push(c.command_author);
        // круг 32: часть большой правки {i, n} (011); схема без 011 — не пишется
        if (hasUndoPart) params.push(c.undo_part ? JSON.stringify(c.undo_part) : null);
        const extra = [...(hasOpsSize ? ['ops_bytes', 'ops_count'] : []), ...(hasCommandAuthor ? ['command_author'] : []), ...(hasUndoPart ? ['undo_part'] : [])];
        const ins = await client.query(
          `INSERT INTO operations (project_id, seq, tx_id, base_seq, ops, dropped, notes, undo_of, redo_of, author, author_kind, client, title, engine, chain, command_id${extra.map((x) => ', ' + x).join('')})
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16${extra.map((x, i) => `, $${17 + i}${x === 'undo_part' ? '::jsonb' : ''}`).join('')})
           ON CONFLICT (project_id, tx_id) DO NOTHING
           RETURNING ${opColumns(hasCommandAuthor, hasUndoPart)}`,
          params
        );
        if (!ins.rowCount) {
          await client.query('ROLLBACK');
          const ex = await client.query(
            `SELECT ${opColumns(hasCommandAuthor, hasUndoPart)} FROM operations WHERE project_id = $1 AND tx_id = $2`,
            [projectId, c.tx_id]
          );
          return { status: 'existing', committed: toCommitted(ex.rows[0]) };
        }
        if (expectSeq !== undefined && seq !== expectSeq) {
          await client.query('ROLLBACK');
          return { status: 'stale', head_seq: seq - 1, epoch };
        }
        if (expectChain !== undefined && chain !== expectChain) {
          await client.query('ROLLBACK');
          return { status: 'stale', reason: 'chain', head_seq: seq - 1, epoch };
        }
        await notify(client, { k: 'tx', p: projectId, s: seq, c: chain, e: epoch, i: origin || '' });
        await client.query('COMMIT');
        return { status: 'committed', committed: toCommitted(ins.rows[0]), epoch };
      } catch (e) {
        if (!client.fail(e)) await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Снимок пишется, только если журнал на его seq — тот же (chain совпадает):
     * снимок, посчитанный до отката базы и дописанный после, иначе отравил бы
     * открытие проекта. Снимок с тем же seq, но другой цепочкой, заменяется; с той же
     * цепочкой, но без известных надгробий (записал экземпляр прежней версии), — тоже, если
     * они известны теперь (круг 27).
     * @returns {Promise<boolean>} записан ли
     */
    async writeSnapshot(projectId, seq, doc, engine, chain = '', tombstones = null) {
      if (!okId(projectId)) return false;
      const { parents, meta } = splitTombstones(tombstones);
      // tombstones_chain = chain снимка: надгробия известны для этой цепочки (migrations/007);
      // null на входе («неизвестно») — NULL
      const res = await pool.query(
        `INSERT INTO snapshots (project_id, seq, doc, engine, chain, tombstones, tombstones_meta, tombstones_chain)
         SELECT $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb, CASE WHEN $6::jsonb IS NULL THEN NULL ELSE $5 END
          WHERE EXISTS (SELECT 1 FROM operations WHERE project_id = $1 AND seq = $2 AND chain = $5)
         ON CONFLICT (project_id, seq) DO UPDATE SET doc = EXCLUDED.doc, engine = EXCLUDED.engine, chain = EXCLUDED.chain,
                tombstones = EXCLUDED.tombstones, tombstones_meta = EXCLUDED.tombstones_meta,
                tombstones_chain = EXCLUDED.tombstones_chain, created_at = now()
          WHERE snapshots.chain IS DISTINCT FROM EXCLUDED.chain
             OR (EXCLUDED.tombstones_chain IS NOT NULL AND snapshots.tombstones_chain IS DISTINCT FROM EXCLUDED.tombstones_chain)`,
        [projectId, seq, JSON.stringify(doc), engine, chain, parents === null ? null : JSON.stringify(parents), meta === null ? null : JSON.stringify(meta)]
      );
      return res.rowCount > 0;
    },

    /** Объектная форма writeSnapshot: `{seq, doc, engine, chain, tombstones}`. */
    async saveSnapshot(projectId, { seq, doc, engine, chain = '', tombstones } = {}) {
      return self.writeSnapshot(projectId, seq, doc, engine, chain, tombstones);
    },

    /**
     * Прореживание: последние `keep` снимков; seq 0 (затравка) не удаляется никогда; старший
     * снимок с известными надгробиями — тоже (круг 27: иначе после череды снимков прежней
     * версии восстанавливать надгробия пришлось бы от seq 0 — всем журналом).
     */
    async pruneSnapshots(projectId, keep) {
      if (!okId(projectId) || !(keep > 0)) return 0;
      const res = await pool.query(
        `DELETE FROM snapshots WHERE project_id = $1 AND seq <> 0
            AND seq NOT IN (SELECT seq FROM snapshots WHERE project_id = $1 AND seq <> 0 ORDER BY seq DESC LIMIT $2)
            AND seq IS DISTINCT FROM (SELECT max(seq) FROM snapshots WHERE project_id = $1 AND seq <> 0 AND tombstones_chain = chain)`,
        [projectId, keep]
      );
      return res.rowCount;
    },

    async findTx(projectId, txId) {
      if (!okId(projectId)) return null;
      const res = await pool.query(
        `SELECT ${opColumns(hasCommandAuthor, hasUndoPart)} FROM operations WHERE project_id = $1 AND tx_id = $2`,
        [projectId, String(txId)]
      );
      return res.rows[0] ? toCommitted(res.rows[0]) : null;
    },

    async knownEpoch(projectId, epoch) {
      if (!okId(projectId) || typeof epoch !== 'string' || !epoch) return false;
      // нынешняя эпоха проекта известна всегда — даже если проект создал экземпляр до
      // круга 23, который project_epochs не пишет (смешанные версии, SPEC §9.11)
      const res = await pool.query(
        `SELECT 1 FROM project_epochs WHERE project_id = $1 AND epoch = $2
         UNION ALL SELECT 1 FROM projects WHERE id = $1 AND epoch = $2 LIMIT 1`,
        [projectId, epoch]
      );
      return res.rowCount > 0;
    },

    /**
     * Сменить эпоху, если она всё ещё `fromEpoch` (compare-and-set: два экземпляра,
     * увидевшие один откат, меняют её один раз). Уведомление — в той же транзакции.
     */
    async bumpEpoch(projectId, fromEpoch, cause, origin) {
      if (!okId(projectId)) return { status: 'missing' };
      const epoch = newEpoch();
      return inTx(async (client) => {
        const up = await client.query(
          'UPDATE projects SET epoch = $3, epoch_cause = $4 WHERE id = $1 AND epoch = $2 RETURNING head_seq',
          [projectId, fromEpoch, epoch, cause]
        );
        if (!up.rowCount) {
          const cur = await client.query('SELECT epoch, epoch_cause FROM projects WHERE id = $1', [projectId]);
          if (!cur.rowCount) return rollback({ status: 'missing' });
          return rollback({ status: 'moved', epoch: cur.rows[0].epoch, cause: cur.rows[0].epoch_cause });
        }
        await client.query(
          'INSERT INTO project_epochs (project_id, epoch, seq, cause) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [projectId, epoch, Number(up.rows[0].head_seq), cause]
        );
        await notify(client, { k: 'epoch', p: projectId, e: epoch, i: origin || '' });
        return { status: 'bumped', epoch, cause };
      });
    },

    /** Эпохи проекта по порядку (тестам и отладке). */
    async epochs(projectId) {
      if (!okId(projectId)) return [];
      const res = await pool.query('SELECT epoch, seq, cause, created_at FROM project_epochs WHERE project_id = $1 ORDER BY created_at, seq', [projectId]);
      return res.rows.map((r) => ({ epoch: r.epoch, seq: Number(r.seq), cause: r.cause, created_at: isoOf(r.created_at) }));
    },

    async addTrace({ projectId, commandId, body }) {
      if (!okId(projectId)) return null;
      const res = await pool.query(
        `INSERT INTO traces (project_id, command_id, body)
         SELECT $1, $2, $3::jsonb WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1)
         RETURNING id, created_at`,
        [projectId, String(commandId), JSON.stringify(body)]
      );
      const row = res.rows[0];
      return row ? { id: String(row.id), created_at: isoOf(row.created_at) } : null;
    },

    async listTraces(projectId, limit) {
      if (!okId(projectId)) return [];
      const res = await pool.query(
        'SELECT id, command_id, created_at, body FROM traces WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
        [projectId, limit]
      );
      return res.rows.map((r) => ({ id: String(r.id), command_id: r.command_id, created_at: isoOf(r.created_at), body: r.body }));
    }
  };
  // круг 31: запросы к базе — с одной попыткой после сверки схемы (ошибка 42703/42P01)
  for (const name of ['createProject', 'listProjects', 'listProjectsPage', 'getProject', 'renameProject', 'latestSnapshot',
    'projectByCreateId', 'latestSnapshotMeta', 'snapshotBefore', 'snapshotSeqs', 'txsAfter', 'recentTxMeta', 'chainAt', 'commitTx', 'writeSnapshot',
    'pruneSnapshots', 'findTx', 'knownEpoch', 'bumpEpoch', 'epochs', 'addTrace', 'listTraces']) {
    const fn = self[name];
    self[name] = (...args) => withSchema(() => fn.apply(self, args));
  }
  return self;
}
