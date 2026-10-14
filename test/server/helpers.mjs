/**
 * Общее для тестов Document service: поднять сервис на случайном порту с
 * адаптером в памяти или с Postgres (когда база доступна), HTTP-клиент на
 * fetch, WebSocket-клиент с очередью сообщений.
 *
 * База берётся из TEST_DATABASE_URL или DATABASE_URL; нет переменной или нет
 * подключения — pg-прогоны помечаются skip, memory идут всегда.
 */

import pg from 'pg';
import WebSocket from 'ws';
import { start } from '../../server/document/index.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { createPgStorage } from '../../server/document/storage/pg.js';

export const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const quiet = { info() {}, warn() {} };

let pgProbe;
/** Есть ли база: проверяется один раз на процесс. */
export function pgAvailable() {
  if (!pgProbe) {
    pgProbe = (async () => {
      if (!DB_URL) return false;
      const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
      try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
      } catch (_) {
        return false;
      } finally {
        await client.end().catch(() => {});
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

/** Чистая база перед прогоном: таблицы этого круга, каскадом. */
async function resetPg(storage) {
  await storage.pool.query('TRUNCATE projects, operations, snapshots, library_versions, project_imports, project_epochs, traces CASCADE');
}

/**
 * Поднять сервис. `opts` — как у start(); `storageOpts` — адаптеру pg; `warn` — куда писать предупреждения
 * (по умолчанию глушим, тесты о них не спрашивают).
 */
export async function startFor(backend, opts = {}, storageOpts = {}) {
  const storage = backend === 'pg'
    ? createPgStorage({ connectionString: DB_URL, log: quiet, ...storageOpts })
    : createMemoryStorage();
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
  const storage = backend === 'pg'
    ? createPgStorage({ connectionString: DB_URL, log: quiet, ...storageOpts })
    : first.storage;
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
