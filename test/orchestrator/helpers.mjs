/**
 * Общее для тестов Orchestrator: настоящий Document service в памяти, поддельный
 * OpenAI-совместимый сервер модели с заготовленными ответами, сам Orchestrator и
 * клиент SSE. Все порты — случайные (0): файлы тестов идут параллельно.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { start as startDocumentService } from '../../server/document/index.js';
import { createMemoryStorage } from '../../server/document/storage/memory.js';
import { start as startOrchestrator } from '../../server/orchestrator/index.js';

export const quiet = { info() {}, warn() {} };

/** Лог, который копит строки (проверить, что ключ туда не попал). */
export function captureLog() {
  const lines = [];
  return { lines, info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
}

export async function startDocument() {
  return startDocumentService({ port: 0, host: '127.0.0.1', storage: createMemoryStorage(), snapshotEvery: 50, pingInterval: 0, log: quiet });
}

/* ── заготовки ответов модели (форма — SCHEMAS brain.js, как в test/brain.test.mjs) ── */

export const PLAN_CREATE = { intent: 'create', title: 'Собрал экран тарифов', summary: 'Новый артборд с тарифом.', steps: ['Каркас', 'Заголовок'], targets: [] };
export const TREE_OK = {
  type: 'frame', name: 'Экран тарифов',
  layout: { mode: 'column', gap: 16, padding: [24, 20], align: 'stretch', justify: 'start' },
  size: { w: 390, h: 'hug' },
  children: [
    { type: 'text', name: 'Заголовок', text: 'Выберите тариф', size: { w: 'fill', h: 'hug' } },
    { type: 'text', name: 'Цена', text: '490 ₽ в месяц' },
  ],
};

/**
 * Поддельная модель. script: {plan, tree, patch, …} — значение, массив (по очереди) или
 * функция(body) → значение. opts.delayMs — задержка ответа; opts.gate — промис, которого
 * ответ ждёт (чтобы держать команду «в модели»).
 */
export async function startFakeLlm(script = {}, opts = {}) {
  const calls = [];
  const state = { down: false, delayMs: opts.delayMs || 0, gate: opts.gate || null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? safeJson(raw) : null };
    calls.push(rec);
    if (state.down) { res.writeHead(503).end('down'); return; }
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.method === 'POST' && u.pathname.endsWith('/chat/completions')) {
      const name = rec.body && rec.body.response_format && rec.body.response_format.json_schema && rec.body.response_format.json_schema.name;
      rec.schema = name;
      if (state.gate) await state.gate;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      let value = script[name];
      if (Array.isArray(value)) value = value.length > 1 ? value.shift() : value[0];
      if (typeof value === 'function') value = await value(rec.body);
      if (value === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `нет ответа для ${name}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(value) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}/v1`,
    calls,
    completions: () => calls.filter((c) => c.method === 'POST'),
    state,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }

export async function startOrch({ document, llm, ...rest } = {}) {
  return startOrchestrator({
    port: 0, host: '127.0.0.1',
    documentUrl: document ? `http://127.0.0.1:${document.port}` : 'http://127.0.0.1:9',
    llm: llm || {},
    log: quiet,
    testHooks: true,
    workers: 2,
    ...rest,
  });
}

/** JSON-клиент: {status, body, headers}. */
export async function call(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text, headers: res.headers };
}

/** Разбор SSE-текста в [{event, data}]. */
export function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (data.length) out.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return out;
}

/**
 * Команда целиком: ждём конца потока. → {status, events, headers, body (если не SSE)}.
 */
export async function command(base, body) {
  const res = await fetch(base + '/agent/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  const sse = (res.headers.get('content-type') || '').startsWith('text/event-stream');
  return {
    status: res.status, headers: res.headers, text,
    events: sse ? parseSse(text) : [],
    body: sse ? null : safeJson(text),
  };
}

/**
 * Команда с ручным управлением потоком: until(pred) — дождаться события; abort() — оборвать.
 */
export function commandStream(base, body) {
  const ctl = new AbortController();
  const events = [];
  const waiters = [];
  let buf = '';
  let finished = false;
  const check = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const hit = events.find(w.pred);
      if (hit) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(hit); }
      else if (finished) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(new Error('поток кончился, события нет: ' + JSON.stringify(events.map((e) => e.event)))); }
    }
  };
  const response = fetch(base + '/agent/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
  }).then(async (res) => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          events.push(...parseSse(buf.slice(0, i + 2)));
          buf = buf.slice(i + 2);
          check();
        }
      }
    } catch { /* оборвали */ }
    finished = true;
    check();
    return res;
  }, () => { finished = true; check(); return null; });
  return {
    events,
    response,
    until: (pred, timeout = 15000) => new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, timer: setTimeout(() => reject(new Error('событие не пришло за ' + timeout + ' мс: ' + JSON.stringify(events.map((e) => e.event)))), timeout) };
      waiters.push(w);
      check();
    }),
    done: () => response,
    abort: () => ctl.abort(),
  };
}

export async function createProject(document, body = { name: 'Проба' }) {
  // круг 25: без `doc` сервис заводит пустой документ, демо — только по `demo: true`;
  // тесты агента строятся на демо-документе (доски «Маршрут дня», «Шапка»…)
  const payload = body && body.doc === undefined && body.demo === undefined ? { ...body, demo: true } : body;
  const r = await call(`http://127.0.0.1:${document.port}`, 'POST', '/api/projects', payload);
  if (r.status !== 201) throw new Error('проект не создан: ' + r.text);
  return r.body;
}

export async function journal(document, project, since = 0) {
  const r = await call(`http://127.0.0.1:${document.port}`, 'GET', `/api/projects/${project}/ops?since=${since}`);
  return r.body;
}

export async function waitFor(fn, timeout = 10000, step = 30) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('условие не наступило за ' + timeout + ' мс');
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Orchestrator отдельным процессом (`node <args>`) на PORT=0 (круг 26: фиксированные порты
 * сталкивались у параллельных прогонов `npm test`). Порт — из строки «слушаю http://…:PORT».
 * → {child, out(), port: Promise<number>, url: Promise<string>, exited: Promise<{code, signal}>}
 */
export function spawnOrchestrator(args, { env = {}, cwd, timeoutMs = 30000 } = {}) {
  const full = { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env };
  delete full.NODE_OPTIONS;
  const child = spawn(process.execPath, args, { env: full, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Orchestrator не сказал «слушаю» за ' + timeoutMs + ' мс: ' + out)), timeoutMs);
    const onData = (d) => {
      out += d;
      const m = /слушаю http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d; });
    exited.then(({ code, signal }) => { clearTimeout(timer); reject(new Error(`Orchestrator вышел до «слушаю» (${code ?? signal}): ${out}`)); });
  });
  port.catch(() => {});
  return { child, out: () => out, port, url: port.then((p) => `http://127.0.0.1:${p}`), exited };
}

let seq = 0;
export const cid = (p = 'cmd') => `${p}_${process.pid}_${Date.now().toString(36)}_${++seq}`;
