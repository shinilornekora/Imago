/**
 * Hub — рассылка транзакций и присутствия по WebSocket (SPEC §8.1, §9.3, §9.8).
 *
 * `/ws?project=<id>&since=<seq>&client=<clientId>[&author=<имя>][&tip=<chain>][&epoch=<эпоха>]`:
 *   сервер → клиент: hello {epoch, tip} → догон (tx для каждой seq > since, либо
 *   gone со снимком) → живой поток tx; ack на повтор уже полученной; presence/left
 *   чужих; error (тело — как у HTTP: {error:true, code, message, retryable, detail?}).
 *   клиент → сервер: tx (то же, что POST …/tx; ответ — рассылкой tx, автору тоже),
 *   presence (эфемерно, не чаще 10/с — лишнее отбрасывается).
 *
 * Гарантия порядка по одному сокету: tx с возрастающим seq без пропусков.
 * Догон и живой поток сшиваются так: сокет входит в комнату ДО чтения хвоста,
 * живые транзакции, пришедшие во время чтения, копятся в буфере и досылаются
 * после хвоста с фильтром `seq > последнего отправленного`; дыра в живом потоке
 * (не должна случаться, но) закрывается дочитыванием из базы.
 *
 * Эпоха (§9.8): каждый сокет помнит эпоху своего hello. Секвенсор сообщает о
 * смене эпохи (откат базы увидел этот экземпляр, другой — по NOTIFY, или клиент
 * прислал чужой tip) — сокеты проекта со старой эпохой закрываются кодом 4410,
 * кеш кадров проекта чистится. Кеш кадров — по ключу `seq:chain`: после отката
 * тот же seq называет другую транзакцию, и старый кадр не должен уйти никому.
 *
 * `author` на сокете: браузер не ставит заголовков при upgrade, поэтому имя —
 * из query `author`, из поля `author` в presence или из последней tx сокета.
 */

import { WebSocketServer } from 'ws';
import { ENGINE_VERSION } from '../../src/core.js';
import { DocError, badRequest, internalBody } from './errors.js';
import { projectSummary } from './storage/committed.js';
import { MAX_BODY_BYTES, WS_ENVELOPE_BYTES } from './limits.js';

/** Предел сообщения — тело транзакции (4 МБ) плюс конверт; больше — ws закрывает сокет кодом 1009. */
export const MAX_MESSAGE = MAX_BODY_BYTES + WS_ENVELOPE_BYTES;
/** Присутствие: не чаще стольких сообщений в секунду на сокет. */
export const PRESENCE_PER_SECOND = 10;
/** Предел выделения в presence — чтобы одно сообщение не раздувало рассылку. */
const MAX_SELECTION = 1000;
/** Кадров на проект в кеше (сериализованная tx — один JSON.stringify на всех подписчиков). */
const FRAME_CACHE = 256;
/** Коды закрытия: 4400 форма запроса, 4404 нет проекта, 4410 эпоха сменилась, 4503 хранилище/занято. */
export const CLOSE = { bad: 4400, notFound: 4404, epoch: 4410, unavailable: 4503 };

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
  /** @type {Map<string, {sockets: Set<import('ws').WebSocket>, frames: Map<string, string>}>} */
  const rooms = new Map();
  let clientCounter = 0;
  let tokenCounter = 0;

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };

  /** Кадр `{type:'tx', tx}` из кеша комнаты: ключ — seq и chain. */
  function frameOf(projectId, committed) {
    const room = rooms.get(projectId);
    const key = `${committed.seq}:${committed.chain || ''}`;
    if (room) {
      const hit = room.frames.get(key);
      if (hit) return hit;
    }
    const text = JSON.stringify({ type: 'tx', tx: committed });
    if (room) {
      room.frames.set(key, text);
      while (room.frames.size > FRAME_CACHE) room.frames.delete(room.frames.keys().next().value);
    }
    return text;
  }

  function sendTx(ws, committed) {
    ws.lastSeq = committed.seq;
    send(ws, frameOf(ws.projectId, committed));
  }

  /** Отправить tx сокету, если он её ещё не получал; во время догона — в буфер; дыра — дочитать. */
  function deliverTx(ws, committed) {
    if (ws.catchingUp) {
      ws.buffer.push(committed);
      return;
    }
    if (committed.seq <= ws.lastSeq) return;
    if (committed.seq > ws.lastSeq + 1) {
      ws.catchingUp = true;
      ws.buffer.push(committed);
      pump(ws).catch((e) => fail(ws, e));
      return;
    }
    sendTx(ws, committed);
  }

  function relay(projectId, from, msg) {
    const room = rooms.get(projectId);
    if (!room) return;
    for (const ws of room.sockets) if (ws !== from && ws.ready) send(ws, msg);
  }

  function onEvent(ev) {
    const room = rooms.get(ev.projectId);
    if (!room) return;
    if (ev.kind === 'tx') {
      for (const ws of room.sockets) deliverTx(ws, ev.committed);
      return;
    }
    if (ev.kind === 'epoch') {
      room.frames.clear();
      for (const ws of [...room.sockets]) {
        if (ev.token !== undefined && ws.token === ev.token) continue;
        if (ws.deciding) {
          ws.epochMoved = true;
          continue;
        }
        if (ws.epoch !== ev.epoch) closeEpoch(ws, ev.epoch);
      }
    }
  }

  function closeEpoch(ws, epoch) {
    send(ws, { type: 'error', error: true, code: 'epoch', message: 'журнал проекта сменил эпоху (база откатилась) — переоткройте проект', retryable: true, epoch });
    ws.close(CLOSE.epoch, 'epoch');
  }

  const unsubscribe = dslts.subscribe(onEvent);
  dslts.setWatcher((projectId) => rooms.has(projectId));

  function join(projectId, ws) {
    let room = rooms.get(projectId);
    if (!room) {
      room = { sockets: new Set(), frames: new Map() };
      rooms.set(projectId, room);
    }
    room.sockets.add(ws);
  }

  function leave(projectId, ws) {
    const room = rooms.get(projectId);
    if (!room) return;
    room.sockets.delete(ws);
    if (!room.sockets.size) rooms.delete(projectId);
  }

  function errorMessage(e, txId) {
    let body;
    if (e instanceof DocError) {
      body = e.body();
    } else {
      log.warn('[document/hub] сбой:', e && e.stack ? e.stack : e);
      body = internalBody();
    }
    const out = { type: 'error', ...body };
    if (txId !== undefined && out.tx_id === undefined) out.tx_id = txId;
    return out;
  }

  /** Сбой посреди догона: сказать и закрыть (клиент переподключится). */
  function fail(ws, e) {
    send(ws, errorMessage(e));
    const code = e instanceof DocError ? (e.status === 404 ? CLOSE.notFound : e.status >= 500 ? CLOSE.unavailable : CLOSE.bad) : CLOSE.unavailable;
    ws.close(code, e instanceof DocError ? e.code : 'internal');
  }

  /**
   * Дочитать из базы всё после ws.lastSeq (страницами), затем буфер живого потока.
   * Дыра в журнале посреди догона — gone со снимком и дальше от него.
   */
  async function pump(ws) {
    const projectId = ws.projectId;
    for (let guard = 0; guard < 100000; guard++) {
      if (ws.readyState !== ws.OPEN) return;
      const view = await dslr.since(projectId, ws.lastSeq);
      if (view.gone) {
        sendGone(ws, view);
        continue;
      }
      for (const tx of view.txs) {
        if (tx.seq <= ws.lastSeq) continue;
        sendTx(ws, tx);
      }
      if (!view.more || !view.txs.length) break;
    }
    const buffered = ws.buffer;
    ws.buffer = [];
    ws.catchingUp = false;
    for (const tx of buffered) deliverTx(ws, tx);
  }

  function sendGone(ws, view) {
    send(ws, { type: 'gone', snapshot: view.snapshot, head_seq: view.head_seq, epoch: ws.epoch, tip: view.snapshot.chain || '' });
    ws.lastSeq = view.snapshot.seq;
  }

  async function onTx(ws, projectId, raw) {
    const txId = raw && typeof raw.tx_id === 'string' ? raw.tx_id : undefined;
    try {
      if (raw && typeof raw === 'object' && typeof raw.author === 'string' && raw.author) ws.author = raw.author;
      const { committed, existing } = await dslts.commit(projectId, raw, { author: ws.author });
      // новая транзакция уже разослана подпиской (автору тоже); сохранённая — повтор
      // после разрыва: досылаем автору, если этот сокет её ещё не видел, иначе — ack
      // (кадры до lastSeq уже ушли этим сокетом раньше ack — порядок клиенту виден)
      if (existing) {
        if (committed.seq <= ws.lastSeq) send(ws, { type: 'ack', tx_id: committed.tx_id, seq: committed.seq, chain: committed.chain || '', existing: true });
        else deliverTx(ws, committed);
      }
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
    const tip = url.searchParams.get('tip') || undefined;
    const epoch = url.searchParams.get('epoch') || undefined;
    ws.isAlive = true;
    ws.projectId = projectId;
    ws.token = ++tokenCounter;
    ws.clientId = url.searchParams.get('client') || ('c_' + (++clientCounter).toString(36) + '_' + Date.now().toString(36));
    ws.author = url.searchParams.get('author') || undefined;
    ws.lastSeq = -1;
    ws.catchingUp = true;
    ws.deciding = true;
    ws.ready = false;
    ws.buffer = [];
    ws.presenceWindow = 0;
    ws.presenceCount = 0;
    ws.on('pong', () => { ws.isAlive = true; });

    const refuse = (msg, reason) => {
      send(ws, errorMessage(badRequest(msg)));
      ws.close(CLOSE.bad, reason);
    };
    if (!projectId) return refuse('нужен параметр project', 'project');
    if (since !== undefined && (!Number.isInteger(since) || since < -1)) return refuse('since: целое ≥ 0 (или -1 — «ничего не знаю»)', 'since');
    if ((tip && tip.length > 128) || (epoch && epoch.length > 64)) return refuse('tip/epoch: слишком длинные', 'tip');

    let joined = false;
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        send(ws, errorMessage(badRequest('сообщение не JSON')));
        return;
      }
      if (!msg || typeof msg !== 'object') {
        send(ws, errorMessage(badRequest('сообщение должно быть объектом')));
        return;
      }
      if (!ws.ready) return;   // до hello сообщения не принимаем: проект ещё не проверен
      switch (msg.type) {
        case 'tx':
          onTx(ws, projectId, msg.tx);
          break;
        case 'presence':
          onPresence(ws, projectId, msg);
          break;
        default:
          send(ws, errorMessage(badRequest(`неизвестный тип сообщения «${msg.type}»`)));
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
      // голова загружена и сверена с базой: откат, о котором экземпляр не знал, ловится здесь
      let head = await dslts.attach(projectId);
      let decision = 'live';
      if (since !== undefined) decision = await dslr.classify(projectId, { since, tip, epoch }, head);
      if (decision === 'evidence') head = await dslts.clientEvidence(projectId, { token: ws.token });
      ws.deciding = false;
      if (ws.epochMoved) {
        // эпоха сменилась, пока решали: начинать заново
        closeEpoch(ws, head.epoch);
        return;
      }
      ws.epoch = head.epoch;
      ws.ready = true;
      const head_seq = Math.max(head.head_seq, project.head_seq);
      // gone: за hello сразу придёт снимок — клиент по этому знает, цело ли его подтверждённое
      send(ws, {
        type: 'hello',
        project: projectSummary({ ...project, head_seq }),
        head_seq, engine: ENGINE_VERSION, epoch: head.epoch, tip: head.chain || '',
        gone: decision !== 'live' && decision !== 'tail'
      });
      if (decision === 'live') {
        // без since — только живой поток: клиент открыл проект по HTTP и знает голову
        ws.lastSeq = head.head_seq;
      } else if (decision === 'tail') {
        ws.lastSeq = since;
      } else {
        // снимок — не конец догона: за ним могут лежать транзакции до головы
        sendGone(ws, await dslr.gone(projectId));
      }
      await pump(ws);
    })().catch((e) => {
      fail(ws, e);
      if (joined) leave(projectId, ws);
      joined = false;
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
      return room ? room.sockets.size : 0;
    },
    /** Кадров в кеше проекта (тестам). */
    cachedFrames(projectId) {
      const room = rooms.get(projectId);
      return room ? [...room.frames.keys()] : [];
    },
    /** Закрыть все сокеты кодом 1001 («уходим») и снять таймеры. */
    async close() {
      unsubscribe();
      dslts.setWatcher(null);
      if (pinger) clearInterval(pinger);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise((resolve) => wss.close(() => resolve()));
      rooms.clear();
    }
  };
}
