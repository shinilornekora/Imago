/**
 * Hub — рассылка транзакций и присутствия по WebSocket (SPEC §8.1, §9.3).
 *
 * `/ws?project=<id>&since=<seq>&client=<clientId>[&author=<имя>]`:
 *   сервер → клиент: hello → догон (tx для каждой seq > since, либо gone со
 *   снимком) → живой поток tx; presence/left чужих; error.
 *   клиент → сервер: tx (то же, что POST …/tx; ответ — рассылкой tx, автору тоже),
 *   presence (эфемерно, не чаще 10/с — лишнее отбрасывается).
 *
 * Гарантия порядка по одному сокету: tx с возрастающим seq без пропусков.
 * Догон и живой поток сшиваются так: сокет подписывается на проект ДО чтения
 * хвоста, живые транзакции, пришедшие во время чтения, копятся в буфере и
 * досылаются после хвоста с фильтром `seq > последнего отправленного`. Без этого
 * транзакция, легшая между чтением хвоста и подпиской, терялась бы.
 *
 * `author` на сокете: браузер не ставит заголовков при upgrade, поэтому имя —
 * из query `author`, из поля `author` в presence или из последней tx сокета.
 */

import { WebSocketServer } from 'ws';
import { ENGINE_VERSION } from '../../src/core.js';
import { DocError } from './errors.js';

/** Предел тела сообщения — как у HTTP (4 МБ); больше — ws сам закрывает сокет кодом 1009. */
export const MAX_MESSAGE = 4 * 1024 * 1024;
/** Присутствие: не чаще стольких сообщений в секунду на сокет. */
export const PRESENCE_PER_SECOND = 10;
/** Предел выделения в presence — чтобы одно сообщение не раздувало рассылку. */
const MAX_SELECTION = 1000;
/** Коды закрытия сокета сервером: 4400 форма запроса, 4404 нет проекта, 4503 хранилище. */
const CLOSE = { bad: 4400, notFound: 4404, unavailable: 4503 };

/**
 * @param {{
 *   server: import('node:http').Server,
 *   dslr: object,
 *   dslts: object,
 *   pingInterval?: number,
 *   log?: {warn:Function, info:Function}
 * }} opts
 */
export function createHub({ server, dslr, dslts, pingInterval = 30000, log = console }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE });
  /** @type {Map<string, Set<import('ws').WebSocket>>} projectId → сокеты */
  const rooms = new Map();
  let clientCounter = 0;

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  /** Отправить tx сокету, если он её ещё не получал; во время догона — в буфер. */
  function deliverTx(ws, committed) {
    if (ws.catchingUp) {
      ws.buffer.push(committed);
      return;
    }
    if (committed.seq <= ws.lastSeq) return;
    ws.lastSeq = committed.seq;
    send(ws, { type: 'tx', tx: committed });
  }

  function broadcastTx(projectId, committed) {
    const room = rooms.get(projectId);
    if (!room) return;
    for (const ws of room) deliverTx(ws, committed);
  }

  function relay(projectId, from, msg) {
    const room = rooms.get(projectId);
    if (!room) return;
    for (const ws of room) if (ws !== from) send(ws, msg);
  }

  const unsubscribe = dslts.subscribe(broadcastTx);

  function join(projectId, ws) {
    let room = rooms.get(projectId);
    if (!room) {
      room = new Set();
      rooms.set(projectId, room);
    }
    room.add(ws);
  }

  function leave(projectId, ws) {
    const room = rooms.get(projectId);
    if (!room) return;
    room.delete(ws);
    if (!room.size) rooms.delete(projectId);
  }

  function errorMessage(e, txId) {
    if (e instanceof DocError) {
      const out = { type: 'error', code: e.code, message: e.message, ...(e.extra || {}) };
      if (txId !== undefined && out.tx_id === undefined) out.tx_id = txId;
      return out;
    }
    log.warn('[document/hub] сбой:', e && e.stack ? e.stack : e);
    return { type: 'error', code: 'internal', message: 'внутренняя ошибка', ...(txId !== undefined ? { tx_id: txId } : {}) };
  }

  /** Догон: hello, затем хвост с since (или gone со снимком), затем буфер живого потока. */
  async function catchUp(ws, projectId, project, since) {
    let view = await dslr.since(projectId, since);
    const head_seq = Math.max(project.head_seq, view.head_seq);
    send(ws, { type: 'hello', project: { id: project.id, name: project.name, kind: project.kind, head_seq, updated_at: project.updated_at }, head_seq, engine: ENGINE_VERSION });
    if (view.gone) {
      // снимок — не конец догона: за ним могут лежать транзакции до головы,
      // без них клиент увидел бы дыру на первой же живой tx и пошёл бы за ops?since=
      send(ws, { type: 'gone', snapshot: view.snapshot, head_seq: view.head_seq });
      ws.lastSeq = view.snapshot.seq;
      view = ws.lastSeq < head_seq ? await dslr.since(projectId, ws.lastSeq) : { head_seq, txs: [] };
    } else {
      ws.lastSeq = since;
    }
    // хвост длиннее страницы — читаем дальше, пока не догоним голову
    while (!view.gone) {
      for (const tx of view.txs) {
        if (tx.seq <= ws.lastSeq) continue;
        ws.lastSeq = tx.seq;
        send(ws, { type: 'tx', tx });
      }
      if (!view.txs.length || ws.lastSeq >= view.head_seq) break;
      view = await dslr.since(projectId, ws.lastSeq);
    }
    const buffered = ws.buffer;
    ws.buffer = [];
    ws.catchingUp = false;
    for (const tx of buffered) deliverTx(ws, tx);
  }

  async function onTx(ws, projectId, raw) {
    const txId = raw && typeof raw.tx_id === 'string' ? raw.tx_id : undefined;
    try {
      if (raw && typeof raw === 'object' && typeof raw.author === 'string' && raw.author) ws.author = raw.author;
      const { committed, existing } = await dslts.commit(projectId, raw, { author: ws.author });
      // новая транзакция уже разослана подпиской (автору тоже); сохранённая — повтор
      // после разрыва: досылаем автору, только если этот сокет её ещё не видел
      if (existing) deliverTx(ws, committed);
    } catch (e) {
      send(ws, errorMessage(e, txId));
    }
  }

  function onPresence(ws, projectId, raw) {
    const now = Date.now();
    // окно в секунду: лишнее отбрасываем молча — это эфемерный поток, не журнал
    if (now - ws.presenceWindow >= 1000) {
      ws.presenceWindow = now;
      ws.presenceCount = 0;
    }
    if (++ws.presenceCount > PRESENCE_PER_SECOND) return;
    if (typeof raw.author === 'string' && raw.author) ws.author = raw.author;
    const selection = Array.isArray(raw.selection)
      ? raw.selection.filter((s) => typeof s === 'string').slice(0, MAX_SELECTION)
      : [];
    const msg = { type: 'presence', client: ws.clientId, author: ws.author, selection, at: new Date(now).toISOString() };
    if (typeof raw.board === 'string') msg.board = raw.board;
    relay(projectId, ws, msg);
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('project') || '';
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw === null || sinceRaw === '' ? undefined : Number(sinceRaw);
    ws.isAlive = true;
    ws.clientId = url.searchParams.get('client') || ('c_' + (++clientCounter).toString(36) + '_' + Date.now().toString(36));
    ws.author = url.searchParams.get('author') || undefined;
    ws.lastSeq = -1;
    ws.catchingUp = true;
    ws.buffer = [];
    ws.presenceWindow = 0;
    ws.presenceCount = 0;
    ws.on('pong', () => { ws.isAlive = true; });

    if (!projectId) {
      send(ws, { type: 'error', code: 'bad-request', message: 'нужен параметр project' });
      ws.close(CLOSE.bad, 'project');
      return;
    }
    if (since !== undefined && (!Number.isInteger(since) || since < -1)) {
      send(ws, { type: 'error', code: 'bad-request', message: 'since: целое ≥ 0 (или -1 — «ничего не знаю»)' });
      ws.close(CLOSE.bad, 'since');
      return;
    }

    let joined = false;
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        send(ws, { type: 'error', code: 'bad-request', message: 'сообщение не JSON' });
        return;
      }
      if (!msg || typeof msg !== 'object') {
        send(ws, { type: 'error', code: 'bad-request', message: 'сообщение должно быть объектом' });
        return;
      }
      if (!joined) return;   // до hello сообщения не принимаем: проект ещё не проверен
      switch (msg.type) {
        case 'tx':
          onTx(ws, projectId, msg.tx);
          break;
        case 'presence':
          onPresence(ws, projectId, msg);
          break;
        default:
          send(ws, { type: 'error', code: 'bad-request', message: `неизвестный тип сообщения «${msg.type}»` });
      }
    });
    ws.on('close', () => {
      if (!joined) return;
      leave(projectId, ws);
      relay(projectId, ws, { type: 'left', client: ws.clientId });
    });
    ws.on('error', (e) => log.warn('[document/hub] сокет:', e && e.message));

    (async () => {
      // проверяем проект до подписки: в комнате не должно быть сокетов чужих id
      const project = await dslr.project(projectId);
      join(projectId, ws);
      joined = true;
      // без since — только живой поток: клиент открыл проект по HTTP и знает голову
      await catchUp(ws, projectId, project, since === undefined ? project.head_seq : since);
    })().catch((e) => {
      send(ws, errorMessage(e));
      const code = e instanceof DocError ? (e.status === 404 ? CLOSE.notFound : e.status === 503 ? CLOSE.unavailable : CLOSE.bad) : CLOSE.unavailable;
      if (joined) leave(projectId, ws);
      joined = false;
      ws.close(code, e instanceof DocError ? e.code : 'internal');
    });
  });

  // ping/pong: сокет без pong за интервал считается мёртвым и закрывается —
  // иначе комната копит вкладки, у которых давно отвалилась сеть
  const pinger = pingInterval > 0 ? setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, pingInterval) : null;
  if (pinger && pinger.unref) pinger.unref();

  return {
    wss,
    /** Число сокетов в комнате проекта (тестам). */
    roomSize(projectId) {
      const room = rooms.get(projectId);
      return room ? room.size : 0;
    },
    /** Закрыть все сокеты кодом 1001 («уходим») и снять таймеры. */
    async close() {
      unsubscribe();
      if (pinger) clearInterval(pinger);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise((resolve) => wss.close(() => resolve()));
      rooms.clear();
    }
  };
}
