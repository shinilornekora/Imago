/**
 * Общее для тестов Document service: поднять сервис на случайном порту с
 * адаптером в памяти или с Postgres (когда база доступна), HTTP-клиент на
 * fetch, WebSocket-клиент с очередью сообщений.
 *
 * База берётся из TEST_DATABASE_URL или DATABASE_URL; нет переменной или нет
 * подключения — pg-прогоны помечаются skip, memory идут всегда.
 *
 * Изоляция (круг 25): каждый тестовый файл (node --test — процесс на файл) работает в
 * СВОЕЙ временной базе `<база>_t<pid>_<случайное>` на том же кластере: создаётся при
 * первой проверке доступности, удаляется после всех тестов файла (DROP … WITH FORCE).
 * Так параллельные прогоны `npm test` с одной TEST_DATABASE_URL не чистят друг другу
 * таблицы, не слышат чужих NOTIFY и не делят advisory-lock миграций; базы прогонов,
 * чей процесс умер, убираются при следующем старте. Нет права CREATE DATABASE — своя
 * схема в указанной базе (`search_path` в адресе) и свой канал NOTIFY.
 * `DB_URL` — адрес этой временной базы (живая привязка: заполнен после pgAvailable()).
 */

import { after } from 'node:test';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import { start } from '../../server/document/index.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createPgStorage } from '../../server/document/storage/pg.js';

/** База, которую назвал прогон (в ней ничего не трогаем, кроме создания своей). */
export const BASE_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
/** Адрес базы этого тестового файла; '' — базы нет. */
export let DB_URL = '';
/** Метка прогона: application_name, имена схем, канал NOTIFY в режиме схемы. */
export const RUN_ID = process.pid.toString(36) + randomBytes(3).toString('hex');
/** Канал NOTIFY экземпляров этого файла (свой только в режиме схемы; во временной базе — обычный). */
let channel;
const quiet = { info() {}, warn() {} };

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Временная база (или схема) этого файла. */
async function isolate() {
  const admin = new pg.Client({ connectionString: BASE_DB_URL, connectionTimeoutMillis: 2000 });
  await admin.connect();
  try {
    await admin.query('SELECT 1');
    const baseName = (await admin.query('SELECT current_database() AS d')).rows[0].d;
    const prefix = (baseName.replace(/[^a-z0-9_]/gi, '_').slice(0, 30) + '_t').toLowerCase();
    // базы прогонов, чей процесс умер (упал, убит по таймауту), — убрать
    const stale = (await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [prefix + '%'])).rows;
    for (const { datname } of stale) {
      const m = datname.startsWith(prefix) ? /^([0-9a-z]+)([0-9a-f]{6})_x$/.exec(datname.slice(prefix.length)) : null;
      const pid = m ? parseInt(m[1], 36) : NaN;
      if (Number.isFinite(pid) && !alive(pid)) await admin.query(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => {});
    }
    const name = `${prefix}${process.pid.toString(36)}${randomBytes(3).toString('hex')}_x`;
    const url = new URL(BASE_DB_URL);
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = '/' + name;
      after(async () => {
        const c = new pg.Client({ connectionString: BASE_DB_URL });
        await c.connect().catch(() => {});
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        await c.end().catch(() => {});
      });
      return url.toString();
    } catch (e) {
      if (e.code !== '42501') throw e;
      // нет права создавать базы — своя схема в указанной базе и свой канал NOTIFY
      const schema = 'tst_' + RUN_ID;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      channel = 'imago_doc_' + RUN_ID;
      url.searchParams.set('options', `-c search_path=${schema}`);
      after(async () => {
        const c = new pg.Client({ connectionString: BASE_DB_URL });
        await c.connect().catch(() => {});
        await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await c.end().catch(() => {});
      });
      return url.toString();
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

let pgProbe;
/** Есть ли база: проверяется (и создаётся своя) один раз на процесс. */
export function pgAvailable() {
  if (!pgProbe) {
    pgProbe = (async () => {
      if (!BASE_DB_URL) return false;
      try {
        DB_URL = await isolate();
        return true;
      } catch (_) {
        DB_URL = '';
        return false;
      }
    })();
  }
  return pgProbe;
}

/** Адаптеры для прогона: memory всегда, pg — если база отвечает. */
export async function backends() {
  const list = [{ name: 'memory', available: true }];
  list.push({ name: 'pg', available: await pgAvailable() });
  return list;
}

/** Хранилище pg этого файла (своя база; в режиме схемы — свой канал NOTIFY). */
export function pgStorage(storageOpts = {}) {
  return createPgStorage({ connectionString: DB_URL, log: quiet, ...(channel ? { channel } : {}), ...storageOpts });
}

/** Чистая база перед прогоном: таблицы этого круга, каскадом (база — своя, чужое не трогаем). */
async function resetPg(storage) {
  await storage.pool.query('TRUNCATE projects, operations, snapshots, library_versions, project_imports, project_epochs, traces CASCADE');
}

/**
 * Поднять сервис. `opts` — как у start(); `storageOpts` — адаптеру pg; `warn` — куда писать предупреждения
 * (по умолчанию глушим, тесты о них не спрашивают).
 */
export async function startFor(backend, opts = {}, storageOpts = {}) {
  if (backend === 'pg' && !DB_URL) await pgAvailable();
  const storage = backend === 'pg' ? pgStorage(storageOpts) : createMemoryStorage();
  const svc = await start({ port: 0, storage, snapshotEvery: 50, pingInterval: 0, log: quiet, ...opts });
  if (backend === 'pg') await resetPg(storage);
  return svc;
}

/** HTTP-клиент: {status, body, headers}. Тело — JSON, если разбирается. */
export function api(base) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return {
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, body, headers) => call('POST', path, body, headers),
    patch: (path, body, headers) => call('PATCH', path, body, headers),
    options: (path) => call('OPTIONS', path),
    raw: call
  };
}

/**
 * WebSocket-клиент с очередью: next() — следующее сообщение, until(pred) —
 * первое подходящее, silence(ms) — что за ms ничего не пришло.
 */
export function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason ? reason.toString() : '' }));
  });
  const next = (timeout = 3000) => new Promise((resolve, reject) => {
    if (queue.length) {
      resolve(queue.shift());
      return;
    }
    const t = setTimeout(() => {
      const i = waiters.indexOf(take);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('сообщение не пришло за ' + timeout + ' мс'));
    }, timeout);
    const take = (msg) => {
      clearTimeout(t);
      resolve(msg);
    };
    waiters.push(take);
  });
  const until = async (pred, timeout) => {
    for (;;) {
      const msg = await next(timeout);
      if (pred(msg)) return msg;
    }
  };
  const silence = (ms = 150) => new Promise((resolve) => {
    if (queue.length) {
      resolve(false);
      return;
    }
    const t = setTimeout(() => {
      const i = waiters.indexOf(take);
      if (i >= 0) waiters.splice(i, 1);
      resolve(true);
    }, ms);
    const take = (msg) => {
      clearTimeout(t);
      queue.unshift(msg);
      resolve(false);
    };
    waiters.push(take);
  });
  return {
    ws, opened, closed, next, until, silence,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => {
      ws.close();
      return closed;
    }
  };
}

/** Адрес сокета для проекта. */
export function wsUrl(svc, projectId, params = {}) {
  const q = new URLSearchParams({ project: projectId, ...params });
  return `ws://127.0.0.1:${svc.port}/ws?${q}`;
}

/* --------------------- откат базы под работающим сервисом --------------------- */

const PG_TABLES = [
  ['projects', 'id'],
  ['operations', 'project_id'],
  ['snapshots', 'project_id'],
  ['project_epochs', 'project_id'],
  ['traces', 'project_id']
];

/**
 * «Бэкап» одного проекта: память — копия всего хранилища, pg — строки проекта во
 * всех таблицах. Вернуть его — restoreBackup (restore из бэкапа: уведомлений нет).
 */
export async function takeBackup(storage, projectId) {
  if (storage.kind === 'memory') return storage.backup();
  const out = {};
  for (const [table, key] of PG_TABLES) {
    out[table] = (await storage.pool.query(`SELECT * FROM ${table} WHERE ${key} = $1`, [projectId])).rows;
  }
  return out;
}

export async function restoreBackup(storage, projectId, backup) {
  if (storage.kind === 'memory') {
    storage.restore(backup);
    return;
  }
  const client = await storage.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    for (const [table] of PG_TABLES) {
      for (const row of backup[table]) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => {
          const v = row[c];
          return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
        });
        await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`, vals);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Второй экземпляр сервиса над той же базой: память — то же хранилище, pg — свой пул и свой LISTEN. */
export async function startTwin(backend, first, opts = {}, storageOpts = {}) {
  const storage = backend === 'pg' ? pgStorage(storageOpts) : first.storage;
  const svc = await start({ port: 0, storage, snapshotEvery: 50, pingInterval: 0, log: quiet, ...opts });
  const close = () => svc.close({ closeStorage: backend === 'pg' });
  return { ...svc, close };
}

/** Ждать, пока условие не станет истинным. */
export async function waitFor(fn, what = 'условие', ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('не дождались: ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export { quiet };
