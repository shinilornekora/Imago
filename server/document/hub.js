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
 *
 * Присутствие (SPEC §9.9) — между экземплярами через эфемерную шину хранилища
 * (pg: NOTIFY отдельного канала `<channel>_presence`, память — общий слушатель):
 *   {k:'presence', p, i, c, a, s, b?, t?, busy?, queued?, at} · {k:'left', p, i, c} · {k:'bye', i}
 * где `i` — id экземпляра (своё эхо отбрасывается). Выделение режется до 200 id и
 * так, чтобы полезная нагрузка уложилась в предел NOTIFY (< 8000 байт); обрезанное —
 * `truncated: true` (одинаково своим сокетам и чужим экземплярам). `left`: при
 * закрытии сокета (если у того же clientId нет другого присутствия — вкладки одного
 * браузера делят clientId), по TTL (нет вестей PRESENCE_TTL_MS — клиент шлёт
 * сердцебиение раз в 15 с), при остановке экземпляра (`bye`) и при его падении
 * (у чужих экземпляров истекает TTL записей упавшего).
 *
 * Прежний клиент (без `tip`, `epoch` и `proto` в адресе — круг 22) не знает `ack`:
 * ему повтор уже полученной вместо `ack` — `error {code:'duplicate', retryable:false}`,
 * по которому он снимает транзакцию с очереди (иначе очередь вставала навсегда).
 *
 * Круг 27: `{type:'project', project:{id,name,kind,head_seq,updated_at}}` — проект
 * переименован (здесь или на другом экземпляре, I4); проекта не стало в базе (I3) —
 * `error {code:'not_found', retryable:false}` всем сокетам проекта и закрытие 4404.
 *
 * Круг 29: чужие значения в тексты ошибок — только через showValue; обработчики
 * `message`/`connection` — под try. Кадр tx — один Buffer на событие для всех сокетов.
 * Подключение: не больше maxConnecting сокетов одновременно до hello; attach — без
 * мьютекса записи (dslts.peek до чтения строки проекта). Сбой хранилища в догоне после
 * hello — `error unavailable` и повтор догона, а не закрытие (J4).
 *
 * Медленный читатель: больше MAX_BUFFERED байт неотправленного — сокет закрывается
 * (4503), клиент переподключится с since и догонит из базы, а память экземпляра не
 * копит кадры для вкладки, которая не читает.
 */

import { WebSocketServer } from 'ws';
import { ENGINE_VERSION } from '../../src/core.js';
import { DocError, badRequest, internalBody } from './errors.js';
import { projectSummary } from './storage/committed.js';
import { applyServerTimeouts } from './http.js';
import {
  MAX_BODY_BYTES, WS_ENVELOPE_BYTES, PRESENCE_PER_SECOND as PRESENCE_RATE, PRESENCE_SELECTION, PRESENCE_ID_CHARS,
  PRESENCE_PAYLOAD_BYTES, PRESENCE_TTL_MS, FRAME_CACHE_FRAMES, FRAME_CACHE_ROOM_BYTES, FRAME_CACHE_TOTAL_BYTES,
  WS_INFLIGHT, WS_CONNECTING, BUSY_RETRY_S, PRESENCE_TICK_MS, PRESENCE_ROOM_FRAMES, PRESENCE_BATCH_BYTES, PRESENCE_BUS_PER_TICK,
  isCleanText, cleanText, cleanMeta, cutText, showValue
} from './limits.js';

/** Предел сообщения — тело транзакции (4 МБ) плюс конверт; больше — ws закрывает сокет кодом 1009. */
export const MAX_MESSAGE = MAX_BODY_BYTES + WS_ENVELOPE_BYTES;
/** Присутствие: не чаще стольких сообщений в секунду на сокет. */
export const PRESENCE_PER_SECOND = PRESENCE_RATE;
/** Неотправленного в сокет больше этого — читатель не успевает: закрыть, пусть догоняет из базы. */
export const MAX_BUFFERED = 32 * 1024 * 1024;
const MAX_AUTHOR = 200;
/**
 * Имя для показа: без U+0000 и одиночных суррогатов (уходит в NOTIFY и в jsonb), без управляющих
 * и bidi-символов (круг 31, метаданные), не длиннее MAX_AUTHOR кодовых точек.
 */
const nameOf = (v) => (typeof v === 'string' && v ? cutText(cleanMeta(v), MAX_AUTHOR) : undefined);
const isFlag = (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const utf8 = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
/** Коды закрытия: 4400 форма запроса, 4404 нет проекта, 4410 эпоха сменилась, 4503 хранилище/занято. */
export const CLOSE = { bad: 4400, notFound: 4404, epoch: 4410, unavailable: 4503 };
/**
 * Догон после hello не дочитался из-за хранилища (503, retryable): сокет не закрывается
 * сразу (J4, круг 29) — ему `error unavailable`, и догон повторяется через 0,5 · 2^k с
 * (не дольше 8 с); столько неудач подряд — закрытие 4503, клиент переподключится.
 */
const PUMP_RETRIES = 5;
const PUMP_RETRY_MS = 500;

/**
 * @param {{
 *   server: import('node:http').Server,
 *   dslr: object,
 *   dslts: object,
 *   bus?: {publish: (msg: object) => boolean, subscribe: (fn: Function) => Function} | null,
 *   instanceId?: string,
 *   pingInterval?: number,
 *   presenceTtlMs?: number,
 *   maxBuffered?: number,
 *   maxInflight?: number,
 *   frameCache?: {frames?: number, roomBytes?: number, totalBytes?: number},
 *   maxConnecting?: number,
 *   presence?: {tickMs?: number, roomFrames?: number, batchBytes?: number, busPerTick?: number},
 *   log?: {warn:Function, info:Function}
 * }} opts `maxConnecting` — сокетов, одновременно идущих от upgrade до hello; `presence` — сводка
 *   присутствия по тикам (круг 33)
 */
export function createHub({
  server, dslr, dslts, bus = null, instanceId = 'i', pingInterval = 30000,
  presenceTtlMs = PRESENCE_TTL_MS, maxBuffered = MAX_BUFFERED, maxInflight = WS_INFLIGHT, frameCache = {}, log = console,
  maxConnecting = WS_CONNECTING, presence: presenceOpts = {}
}) {
  const tickMs = presenceOpts.tickMs > 0 ? presenceOpts.tickMs : PRESENCE_TICK_MS;
  const roomFrames = presenceOpts.roomFrames > 0 ? presenceOpts.roomFrames : PRESENCE_ROOM_FRAMES;
  const batchBytes = presenceOpts.batchBytes > 0 ? presenceOpts.batchBytes : PRESENCE_BATCH_BYTES;
  const busPerTick = presenceOpts.busPerTick > 0 ? presenceOpts.busPerTick : PRESENCE_BUS_PER_TICK;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE });
  // таймауты приёма запроса (круг 27, медленное тело): Hub — единственный модуль, которому
  // вход отдаёт сам http.Server; index.js может поставить их и сам — то же значение
  applyServerTimeouts(server);
  const cacheFrames = frameCache.frames > 0 ? frameCache.frames : FRAME_CACHE_FRAMES;
  const cacheRoomBytes = frameCache.roomBytes > 0 ? frameCache.roomBytes : FRAME_CACHE_ROOM_BYTES;
  const cacheTotalBytes = frameCache.totalBytes > 0 ? frameCache.totalBytes : FRAME_CACHE_TOTAL_BYTES;
  /**
   * @type {Map<string, {
   *   sockets: Set<import('ws').WebSocket>,
   *   frames: Map<string, {text: string, size: number}>, frameBytes: number,
   *   remote: Map<string, {i: string, c: string, until: number}>
   * }>}
   */
  const rooms = new Map();
  let cachedBytes = 0;
  let clientCounter = 0;
  let busyRefused = 0;
  let tokenCounter = 0;
  let closing = false;

  /** Кадр — объект, строка или готовый Buffer (один на всех получателей: ws не копирует его без маски). */
  const send = (ws, msg) => {
    if (ws.readyState !== ws.OPEN) return;
    if (Buffer.isBuffer(msg)) ws.send(msg, { binary: false });
    else ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    // читатель не успевает: неотправленное копится в памяти экземпляра — закрыть, догонит из базы
    if (ws.bufferedAmount > maxBuffered && !ws.slowClosed) {
      ws.slowClosed = true;
      log.warn(`[document/hub] ${ws.projectId}: клиент ${ws.clientId} не успевает читать (${ws.bufferedAmount} байт в очереди) — закрываю`);
      ws.close(CLOSE.unavailable, 'slow');
      // мягкое закрытие ждёт, пока уйдёт очередь; если клиент так и не прочтёт — оборвать
      const t = setTimeout(() => ws.terminate(), 5000);
      if (t.unref) t.unref();
      ws.once('close', () => clearTimeout(t));
    }
  };

  /* ------------------------------ кеш кадров ------------------------------ */

  function evictOldest(room) {
    const first = room.frames.keys().next();
    if (first.done) return false;
    const entry = room.frames.get(first.value);
    room.frames.delete(first.value);
    room.frameBytes -= entry.size;
    cachedBytes -= entry.size;
    return true;
  }

  function clearFrames(room) {
    cachedBytes -= room.frameBytes;
    room.frameBytes = 0;
    room.frames.clear();
  }

  /**
   * Кадр `{type:'tx', tx}` (Buffer UTF-8) из кеша комнаты: ключ — seq и chain. Кеш
   * ограничен числом кадров и байтами — на комнату и на экземпляр; кадр больше четверти
   * предела комнаты не кешируется вовсе (одна большая вставка вытеснила бы всё).
   *
   * Круг 29: кадр одного события сериализуется один раз на событие, а не на сокет —
   * `frameMemo` по самому объекту Committed (рассылка отдаёт всем сокетам один и тот же
   * объект). Раньше кадр больше предела кеша (транзакция 1–4 МБ) сериализовался заново
   * на каждый сокет: 300 сокетов — цикл событий стоял секунды. Память — пока жив объект
   * (рассылка, буфер догона), WeakMap держит не дольше.
   */
  const frameMemo = new WeakMap();
  let framesSerialized = 0;
  function frameOf(projectId, committed) {
    const memo = frameMemo.get(committed);
    if (memo) return memo;
    const room = rooms.get(projectId);
    const key = `${committed.seq}:${committed.chain || ''}`;
    if (room) {
      const hit = room.frames.get(key);
      if (hit) return hit.text;
    }
    const text = Buffer.from(JSON.stringify({ type: 'tx', tx: committed }), 'utf8');
    framesSerialized += 1;
    frameMemo.set(committed, text);
    if (room) {
      const size = text.length;
      if (size <= cacheRoomBytes / 4) {
        room.frames.set(key, { text, size });
        room.frameBytes += size;
        cachedBytes += size;
        while (room.frames.size > cacheFrames || room.frameBytes > cacheRoomBytes) evictOldest(room);
        // экземпляр целиком: место освобождает тот, кто его занимает сейчас
        while (cachedBytes > cacheTotalBytes && evictOldest(room)) { /* вытесняем своё */ }
      }
    }
    return text;
  }

  function sendTx(ws, committed) {
    ws.lastSeq = committed.seq;
    send(ws, frameOf(ws.projectId, committed));
  }

  /** Отправить tx сокету, если он её ещё не получал; во время догона — в буфер; дыра — дочитать. */
  function deliverTx(ws, committed) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.catchingUp) {
      ws.buffer.push(committed);
      return;
    }
    if (committed.seq <= ws.lastSeq) return;
    if (committed.seq > ws.lastSeq + 1) {
      ws.catchingUp = true;
      ws.buffer.push(committed);
      runPump(ws);
      return;
    }
    sendTx(ws, committed);
  }

  /* ---------------------- присутствие: сводка по тикам (круг 33) ---------------------- */

  /**
   * Прежде каждое присутствие сразу расходилось всем сокетам комнаты: K сокетов по 10/с — K²·10
   * кадров в секунду (150 сокетов — 220 тыс./с, строка JSON превращалась в Buffer на каждый
   * сокет), и запись в проект вставала на 12–17 с. Теперь присутствие комнаты копится до тика
   * (tickMs): от каждого источника (свой сокет, клиент чужого экземпляра) — только последнее,
   * `left` — по клиенту (отменяет его ждущие presence, presence — его ждущий left). На тике:
   *   — сокету прежнего вида (без `presence=batch`) — по кадру на запись, каждый кадр
   *     сериализуется один раз (один Buffer на всех); записей за тик — столько, чтобы
   *     кадров вышло не больше roomFrames (получатели × записи), остальное ждёт следующего
   *     тика в том же порядке (давние — первыми): в большой комнате присутствие приходит
   *     реже, но запись и рассылка правок не встают;
   *   — сокету с `presence=batch` — одним кадром `{type:'presence_batch', items:[…]}` (до
   *     batchBytes, своё присутствие в нём тоже есть — клиент отбрасывает его по client);
   *   — шине между экземплярами — последнее от каждого своего сокета, не больше busPerTick
   *     сообщений за тик на комнату (`left` уходит в шину сразу).
   */
  let presenceFramesSent = 0;
  let presenceTicks = 0;

  function schedulePresence(projectId, room) {
    if (room.presTimer || closing) return;
    room.presTimer = setTimeout(() => {
      room.presTimer = null;
      try {
        flushPresence(projectId, room);
      } catch (e) {
        log.warn('[document/hub] присутствие:', e && e.stack ? e.stack : e);
      }
    }, tickMs);
    if (room.presTimer.unref) room.presTimer.unref();
  }

  /** Поставить сообщение присутствия комнаты в очередь тика. */
  function relay(projectId, from, msg, instance = '') {
    const room = rooms.get(projectId);
    if (!room) return;
    const client = msg.client;
    let key;
    if (msg.type === 'left') {
      key = 'L\u0000' + client;
      for (const [k, e] of room.pres) if (e.client === client) room.pres.delete(k);
    } else {
      key = from ? 'S\u0000' + from.token : 'R\u0000' + instance + '\u0000' + client;
      room.pres.delete('L\u0000' + client);
      room.pres.delete(key);
    }
    room.pres.set(key, { msg, from, client });
    schedulePresence(projectId, room);
  }

  function flushPresence(projectId, room) {
    if (rooms.get(projectId) !== room) return;
    presenceTicks += 1;
    // шина: последнее от каждого своего сокета, не больше busPerTick за тик
    if (room.bus.size) {
      let n = 0;
      for (const [token, body] of room.bus) {
        if (n >= busPerTick) break;
        room.bus.delete(token);
        publish(body);
        n += 1;
      }
    }
    if (room.pres.size) {
      const plain = [];
      const batch = [];
      for (const ws of room.sockets) {
        if (!ws.ready || ws.readyState !== ws.OPEN) continue;
        (ws.presenceBatch ? batch : plain).push(ws);
      }
      if (!plain.length && !batch.length) {
        room.pres.clear();
      } else {
        // записей за тик: кадров у прежних сокетов — не больше roomFrames
        const limit = plain.length ? Math.max(1, Math.floor(roomFrames / plain.length)) : Infinity;
        const take = [];
        for (const [k, e] of room.pres) {
          if (take.length >= limit) break;
          room.pres.delete(k);
          take.push(e);
        }
        const texts = take.map((e) => JSON.stringify(e.msg));
        if (plain.length) {
          for (let i = 0; i < take.length; i++) {
            const buf = Buffer.from(texts[i], 'utf8');
            const from = take[i].from;
            for (const ws of plain) {
              if (ws === from) continue;
              send(ws, buf);
              presenceFramesSent += 1;
            }
          }
        }
        if (batch.length) {
          const head = '{"type":"presence_batch","items":[';
          let parts = [];
          let size = head.length + 2;
          const flush = () => {
            if (!parts.length) return;
            const buf = Buffer.from(head + parts.join(',') + ']}', 'utf8');
            for (const ws of batch) {
              send(ws, buf);
              presenceFramesSent += 1;
            }
            parts = [];
            size = head.length + 2;
          };
          for (const t of texts) {
            if (parts.length && size + t.length + 1 > batchBytes) flush();
            parts.push(t);
            size += t.length + 1;
          }
          flush();
        }
      }
    }
    if (room.pres.size || room.bus.size) schedulePresence(projectId, room);
  }

  function onEvent(ev) {
    const room = rooms.get(ev.projectId);
    if (!room) return;
    if (ev.kind === 'tx') {
      for (const ws of room.sockets) deliverTx(ws, ev.committed);
      return;
    }
    if (ev.kind === 'missing') {
      // I3: проекта в базе больше нет (например, базу восстановили из копии без него) —
      // всем сокетам проекта not_found и 4404: переподключаться к нему бесполезно
      clearFrames(room);
      const text = JSON.stringify({ type: 'error', error: true, code: 'not_found', message: 'проекта больше нет на сервере', retryable: false });
      for (const ws of [...room.sockets]) {
        send(ws, text);
        ws.close(CLOSE.notFound, 'not_found');
      }
      return;
    }
    if (ev.kind === 'project') {
      // I4: имя (и сводка) проекта изменились — здесь или на другом экземпляре
      const text = JSON.stringify({ type: 'project', project: ev.project });
      // сокет ещё решает (его hello, возможно, несёт прежнее имя) — дошлём сразу за hello
      for (const ws of room.sockets) {
        if (ws.ready) send(ws, text);
        else ws.pendingProject = text;
      }
      return;
    }
    if (ev.kind === 'epoch') {
      clearFrames(room);
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
      room = { sockets: new Set(), frames: new Map(), frameBytes: 0, remote: new Map(), pres: new Map(), bus: new Map(), presTimer: null };
      rooms.set(projectId, room);
    }
    room.sockets.add(ws);
  }

  function leave(projectId, ws) {
    const room = rooms.get(projectId);
    if (!room) return;
    room.sockets.delete(ws);
    if (!room.sockets.size) {
      clearFrames(room);
      if (room.presTimer) clearTimeout(room.presTimer);
      room.presTimer = null;
      room.pres.clear();
      room.bus.clear();
      rooms.delete(projectId);
    }
  }

  /* ------------------------------ присутствие ------------------------------ */

  /** Есть ли у clientId присутствие, кроме этого сокета / этой записи чужого экземпляра. */
  function presentElsewhere(room, clientId, exceptWs, exceptKey) {
    if (!room) return false;
    for (const s of room.sockets) if (s !== exceptWs && s.clientId === clientId && s.announced) return true;
    for (const [k, e] of room.remote) if (k !== exceptKey && e.c === clientId) return true;
    return false;
  }

  /** Сообщение сокету из выжимки шины — одна форма для своих и чужих. */
  function presenceMessage(b) {
    // имя от экземпляра прежней версии могло прийти нечищеным (шина) — чистится и здесь
    const msg = { type: 'presence', client: b.c, author: nameOf(b.a), selection: b.s, at: b.at };
    if (typeof b.b === 'string') msg.board = b.b;
    if (b.t) msg.truncated = true;
    if (isFlag(b.busy)) msg.busy = b.busy;
    if (isFlag(b.queued)) msg.queued = b.queued;
    return msg;
  }

  /**
   * Выжимка присутствия для шины и сокетов: выделение — не больше PRESENCE_SELECTION
   * id не длиннее PRESENCE_ID_CHARS и столько, чтобы JSON уложился в
   * PRESENCE_PAYLOAD_BYTES (полезная нагрузка NOTIFY < 8000 байт).
   */
  function presenceBody(ws, raw, now) {
    const b = { k: 'presence', p: ws.projectId, i: instanceId, c: ws.clientId, a: nameOf(ws.author), s: [], at: new Date(now).toISOString() };
    if (typeof raw.board === 'string' && raw.board.length <= PRESENCE_ID_CHARS && isCleanText(raw.board)) b.b = raw.board;
    if (isFlag(raw.busy)) b.busy = raw.busy;
    if (isFlag(raw.queued)) b.queued = raw.queued;
    const src = Array.isArray(raw.selection) ? raw.selection : [];
    let budget = PRESENCE_PAYLOAD_BYTES - utf8({ ...b, t: 1 });
    let truncated = false;
    for (const id of src) {
      if (typeof id !== 'string') continue;
      if (id.length > PRESENCE_ID_CHARS || !isCleanText(id)) { truncated = true; continue; }
      if (b.s.length >= PRESENCE_SELECTION) { truncated = true; break; }
      const cost = utf8(id) + (b.s.length ? 1 : 0);
      if (cost > budget) { truncated = true; break; }
      budget -= cost;
      b.s.push(id);
    }
    if (truncated) b.t = 1;
    return b;
  }

  const publish = (msg) => {
    if (!bus) return;
    try {
      bus.publish(msg);
    } catch (e) {
      log.warn('[document/hub] шина присутствия:', e && e.message);
    }
  };

  /** Сокет больше не присутствует (закрыт или замолчал): сказать своим и чужим экземплярам. */
  function withdraw(ws, { closed = false } = {}) {
    const room = rooms.get(ws.projectId);
    const had = ws.announced;
    ws.announced = false;
    // его ждущее тика присутствие — уже не нужно (ни сокетам, ни шине)
    if (room) {
      room.pres.delete('S\u0000' + ws.token);
      room.bus.delete(ws.token);
    }
    // закрытие сообщается своим всегда (как прежде); молчание — только если о нём знали
    if ((closed || had) && !presentElsewhere(room, ws.clientId, ws)) relay(ws.projectId, ws, { type: 'left', client: ws.clientId });
    if (ws.published) {
      ws.published = false;
      publish({ k: 'left', p: ws.projectId, i: instanceId, c: ws.clientId });
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
    if (typeof raw.author === 'string' && raw.author) ws.author = nameOf(raw.author);
    const body = presenceBody(ws, raw, now);
    ws.announced = true;
    ws.presenceAt = now;
    relay(projectId, ws, presenceMessage(body));
    const room = rooms.get(projectId);
    if (bus && room) {
      // в шину — на тике (последнее от сокета); left потом уйдёт сразу
      ws.published = true;
      room.bus.delete(ws.token);
      room.bus.set(ws.token, body);
      schedulePresence(projectId, room);
    }
  }

  /** Сообщение шины от другого экземпляра. */
  function onBus(m) {
    if (!m || typeof m !== 'object' || m.i === instanceId || closing) return;
    if (m.k === 'bye') {
      for (const [projectId, room] of rooms) {
        for (const [key, e] of [...room.remote]) {
          if (e.i !== m.i) continue;
          room.remote.delete(key);
          if (!presentElsewhere(room, e.c)) relay(projectId, null, { type: 'left', client: e.c });
        }
      }
      return;
    }
    if (typeof m.p !== 'string' || typeof m.c !== 'string' || typeof m.i !== 'string') return;
    const room = rooms.get(m.p);
    if (!room) return;   // проект здесь никто не открыл — и помнить незачем
    const key = m.i + '\u0000' + m.c;
    if (m.k === 'presence') {
      if (!Array.isArray(m.s)) return;
      room.remote.set(key, { i: m.i, c: m.c, until: Date.now() + presenceTtlMs });
      relay(m.p, null, presenceMessage(m), m.i);
    } else if (m.k === 'left') {
      if (!room.remote.delete(key)) return;   // не видели — и уходить некому
      if (!presentElsewhere(room, m.c)) relay(m.p, null, { type: 'left', client: m.c });
    }
  }
  const unbus = bus ? bus.subscribe((m) => {
    if (m && (m.k === 'presence' || m.k === 'left' || m.k === 'bye')) onBus(m);
  }) : () => {};

  /** TTL присутствия: свои замолчавшие и чужие без сердцебиения — ушли. */
  function sweepPresence() {
    const now = Date.now();
    for (const [projectId, room] of rooms) {
      for (const ws of room.sockets) {
        if (ws.announced && now - ws.presenceAt > presenceTtlMs) withdraw(ws);
      }
      for (const [key, e] of [...room.remote]) {
        if (e.until > now) continue;
        room.remote.delete(key);
        if (!presentElsewhere(room, e.c)) relay(projectId, null, { type: 'left', client: e.c });
      }
    }
  }
  const sweeper = presenceTtlMs > 0 ? setInterval(sweepPresence, Math.max(50, Math.min(5000, Math.floor(presenceTtlMs / 3)))) : null;
  if (sweeper && sweeper.unref) sweeper.unref();

  /* ------------------------------ ошибки и догон ------------------------------ */

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
   * Дыра в журнале посреди догона — gone со снимком и дальше от него; дыра и за
   * снимком (тот же снимок второй раз) — журнал повреждён: сказать и закрыть, а не
   * читать снимок по кругу.
   */
  async function pump(ws) {
    const projectId = ws.projectId;
    let goneAt = -1;
    for (let guard = 0; guard < 100000; guard++) {
      if (ws.readyState !== ws.OPEN) return;
      const view = await dslr.since(projectId, ws.lastSeq);
      if (ws.readyState !== ws.OPEN) return;
      if (view.gone) {
        if (view.snapshot.seq === goneAt) {
          throw new DocError(503, 'unavailable', 'журнал проекта не дочитывается за снимком — повторите позже', { retryable: true });
        }
        goneAt = view.snapshot.seq;
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

  /**
   * Догон с повтором (J4, круг 29): сбой хранилища после hello — сокету `error unavailable`
   * (`detail.cause` — как у HTTP), догон повторяется позже; живое тем временем копится в
   * буфере. Не хранилище, не после hello или неудач больше PUMP_RETRIES — закрытие (fail).
   */
  function runPump(ws) {
    if (ws.pumping) return Promise.resolve();
    ws.pumping = true;
    return pump(ws).then(() => {
      ws.pumping = false;
      ws.pumpFails = 0;
      // буфер досылался внутри pump и нашёл дыру — догон снова (повторный вызов там отбит флагом)
      if (ws.catchingUp && ws.readyState === ws.OPEN) runPump(ws);
    }, (e) => {
      ws.pumping = false;
      if (ws.readyState !== ws.OPEN) return;
      // повторяется только сбой хранилища (viaStorage: cause storage|timeout) и занятость его
      // чтений (busy); журнал, который не дочитывается за снимком, — не сбой связи: закрыть
      // сразу, а не читать снимок по кругу
      const cause = e instanceof DocError && e.detail && typeof e.detail === 'object' ? e.detail.cause : undefined;
      const transient = ws.ready && e instanceof DocError
        && (e.code === 'busy' || (e.code === 'unavailable' && (cause === 'storage' || cause === 'timeout')));
      ws.pumpFails = (ws.pumpFails || 0) + 1;
      if (!transient || ws.pumpFails > PUMP_RETRIES) {
        fail(ws, e);
        return;
      }
      send(ws, errorMessage(e));
      const t = setTimeout(() => {
        if (ws.readyState === ws.OPEN) runPump(ws);
      }, Math.min(8000, PUMP_RETRY_MS * 2 ** (ws.pumpFails - 1)));
      if (t.unref) t.unref();
      ws.once('close', () => clearTimeout(t));
    });
  }

  function sendGone(ws, view) {
    send(ws, { type: 'gone', snapshot: view.snapshot, head_seq: view.head_seq, epoch: ws.epoch, tip: view.snapshot.chain || '' });
    ws.lastSeq = view.snapshot.seq;
  }

  /**
   * Транзакция с сокета. «В полёте» на сокет — не больше maxInflight (§9.10): на
   * пределе чтение сокета ставится на паузу (TCP держит остальное у клиента), а то,
   * что уже прочитано сверх предела, получает `error busy` (retryable) — клиент
   * пришлёт позже. Без этого каждое сообщение сразу шло в очередь мьютекса, и
   * поток транзакций по 4 МБ съедал память экземпляра.
   */
  async function onTx(ws, projectId, raw, bytes) {
    const txId = raw && typeof raw.tx_id === 'string' && raw.tx_id.length <= 128 && isCleanText(raw.tx_id) ? raw.tx_id : undefined;
    if (ws.inflight >= maxInflight) {
      busyRefused += 1;
      send(ws, errorMessage(new DocError(503, 'busy', 'с этого сокета уже пишется — пришлите позже', { retryable: true, retryAfter: BUSY_RETRY_S, detail: { limit: 'socket_inflight' } }), txId));
      return;
    }
    ws.inflight += 1;
    if (ws.inflight >= maxInflight && !ws.isPaused) ws.pause();
    try {
      if (raw && typeof raw === 'object' && typeof raw.author === 'string' && raw.author) ws.author = nameOf(raw.author);
      const { committed, existing } = await dslts.commit(projectId, raw, { author: ws.author, bytes });
      // новая транзакция уже разослана подпиской (автору тоже); сохранённая — повтор
      // после разрыва: досылаем автору, если этот сокет её ещё не видел, иначе — ack
      // (кадры до lastSeq уже ушли этим сокетом раньше ack — порядок клиенту виден)
      if (existing) {
        if (committed.seq <= ws.lastSeq) {
          if (ws.knowsAck) {
            send(ws, { type: 'ack', tx_id: committed.tx_id, seq: committed.seq, chain: committed.chain || '', existing: true });
          } else {
            // клиент круга 22 ack не знает, а кадр с seq ≤ подтверждённого пропустит — без
            // этого он ждал бы подтверждения вечно и держал за ней всю очередь
            send(ws, {
              type: 'error', error: true, code: 'duplicate', retryable: false, existing: true,
              tx_id: committed.tx_id, seq: committed.seq,
              message: 'правка уже записана — она в снимке, который пришёл раньше'
            });
          }
        } else {
          deliverTx(ws, committed);
        }
      }
    } catch (e) {
      send(ws, errorMessage(e, txId));
    } finally {
      ws.inflight -= 1;
      if (ws.inflight < maxInflight && ws.isPaused) ws.resume();
    }
  }

  /* ------------------------------ подключение ------------------------------ */

  /**
   * Очередь подключений (круг 29): до hello сокет читает базу 1–3 раза (проект, якорь, эпоха);
   * 2000 сокетов разом занимали весь пул, и запись ждала соединения секундами. Одновременно
   * решают не больше maxConnecting, остальные ждут своей очереди в памяти (закрытый,
   * пока ждал, места не занимает).
   */
  let connecting = 0;
  const connectQueue = [];
  function acquireConnecting(ws) {
    if (connecting < maxConnecting) {
      connecting += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => connectQueue.push({ ws, resolve }));
  }
  function releaseConnecting() {
    connecting -= 1;
    while (connectQueue.length && connecting < maxConnecting) {
      const next = connectQueue.shift();
      connecting += 1;
      next.resolve();
    }
  }

  /** Одно сообщение сокета. Чужие значения в текст — только через showValue. */
  function onMessage(ws, projectId, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      send(ws, errorMessage(badRequest('сообщение не JSON')));
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      send(ws, errorMessage(badRequest('сообщение должно быть объектом')));
      return;
    }
    if (!ws.ready) return;   // до hello сообщения не принимаем: проект ещё не проверен
    switch (msg.type) {
      case 'tx':
        onTx(ws, projectId, msg.tx, data.length).catch((e) => log.warn('[document/hub] tx сокета:', e && e.stack ? e.stack : e));
        break;
      case 'presence':
        onPresence(ws, projectId, msg);
        break;
      default:
        send(ws, errorMessage(badRequest(`неизвестный тип сообщения «${showValue(msg.type)}»`)));
    }
  }

  wss.on('connection', (ws, req) => {
    try {
      onConnection(ws, req);
    } catch (e) {
      log.warn('[document/hub] подключение:', e && e.stack ? e.stack : e);
      try { fail(ws, e); } catch (_) { ws.terminate(); }
    }
  });

  function onConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('project') || '';
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw === null || sinceRaw === '' ? undefined : Number(sinceRaw);
    const tip = url.searchParams.get('tip') || undefined;
    const epoch = url.searchParams.get('epoch') || undefined;
    const proto = Number(url.searchParams.get('proto') || 0);
    ws.isAlive = true;
    ws.projectId = projectId;
    ws.token = ++tokenCounter;
    ws.clientId = cutText(cleanText(url.searchParams.get('client') || ('c_' + (++clientCounter).toString(36) + '_' + Date.now().toString(36))), PRESENCE_ID_CHARS);
    ws.author = nameOf(url.searchParams.get('author'));
    ws.inflight = 0;
    ws.knowsAck = !!(tip || epoch || proto >= 2);
    // круг 33: клиент умеет `presence_batch` — присутствие комнаты одним кадром на тик
    ws.presenceBatch = url.searchParams.get('presence') === 'batch';
    ws.lastSeq = -1;
    ws.catchingUp = true;
    ws.deciding = true;
    ws.ready = false;
    ws.buffer = [];
    ws.presenceWindow = 0;
    ws.presenceCount = 0;
    ws.presenceAt = 0;
    ws.announced = false;
    ws.published = false;
    ws.on('pong', () => { ws.isAlive = true; });

    const refuse = (msg, reason) => {
      send(ws, errorMessage(badRequest(msg)));
      ws.close(CLOSE.bad, reason);
    };
    if (closing) {
      ws.close(1001, 'server shutting down');
      return;
    }
    if (!projectId || !isCleanText(projectId)) return refuse('нужен параметр project', 'project');
    if (since !== undefined && (!Number.isSafeInteger(since) || since < -1 || !/^-?\d{1,17}$/.test(sinceRaw))) return refuse(`since: целое от 0 до ${Number.MAX_SAFE_INTEGER} (или -1 — «ничего не знаю»)`, 'since');
    if ((tip && tip.length > 128) || (epoch && epoch.length > 64)) return refuse('tip/epoch: слишком длинные', 'tip');

    let joined = false;
    let gone = false;
    // круг 29: обработчик целиком под try — ошибка разбора одного сообщения (чужое
    // значение в шаблоне строки, `{"type":{"toString":1}}`) роняла процесс со всеми сокетами
    ws.on('message', (data) => {
      try {
        onMessage(ws, projectId, data);
      } catch (e) {
        log.warn('[document/hub] сообщение сокета:', e && e.stack ? e.stack : e);
        try { send(ws, errorMessage(badRequest('сообщение не разобрано'))); } catch (_) { /* сокет уже не годен */ }
      }
    });
    ws.on('close', () => {
      gone = true;
      ws.buffer = [];
      if (!joined) return;
      joined = false;
      leave(projectId, ws);
      if (!closing) withdraw(ws, { closed: true });
    });
    ws.on('error', (e) => log.warn('[document/hub] сокет:', e && e.message));

    let slot = false;
    const freeSlot = () => {
      if (!slot) return;
      slot = false;
      releaseConnecting();
    };
    (async () => {
      // шторм подключений (круг 29): решают одновременно не больше maxConnecting сокетов —
      // их чтения не забирают у записи пул базы; ждут здесь, а не в мьютексе записи
      await acquireConnecting(ws);
      slot = true;
      if (gone || ws.readyState !== ws.OPEN) return;
      // снимок головы — до чтения строки проекта: тогда attach обходится без второго чтения
      const peek = typeof dslts.peek === 'function' ? dslts.peek(projectId) : null;
      // проверяем проект до подписки: в комнате не должно быть сокетов чужих id
      const project = await dslr.project(projectId);
      // сокет закрылся, пока проверяли: в комнату его не пускать — иначе он остался бы
      // в ней навсегда (close уже прошёл), держал голову от выгрузки и кеш кадров
      if (gone || ws.readyState !== ws.OPEN) return;
      join(projectId, ws);
      joined = true;
      // голова загружена и согласна с базой (без мьютекса записи, если можно): откат, о
      // котором экземпляр не знал, ловится здесь
      let head = await dslts.attach(projectId, peek ? { peek, project } : undefined);
      let decision = 'live';
      if (since !== undefined) decision = await dslr.classify(projectId, { since, tip, epoch }, head);
      if (decision === 'evidence') head = await dslts.clientEvidence(projectId, { token: ws.token });
      ws.deciding = false;
      if (gone) return;
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
      if (ws.pendingProject) {
        send(ws, ws.pendingProject);
        ws.pendingProject = null;
      }
      if (decision === 'live') {
        // без since — только живой поток: клиент открыл проект по HTTP и знает голову
        ws.lastSeq = head.head_seq;
      } else if (decision === 'tail') {
        ws.lastSeq = since;
      } else {
        // снимок — не конец догона: за ним могут лежать транзакции до головы. Его шлёт сам
        // догон (since -1 → gone), чтобы и чтение снимка повторялось при сбое хранилища
        ws.lastSeq = -1;
      }
      // место в очереди подключений — до hello: догон длинного журнала не должен держать
      // чужие hello (чтения журнала ограничивает хранилище, journalReads)
      freeSlot();
      // после hello догон повторяется при сбое хранилища, а не закрывает сокет (J4)
      runPump(ws);
    })().catch((e) => {
      // комнату покинет обработчик close (он же скажет left, если присутствие было)
      fail(ws, e);
    }).finally(freeSlot);
  }

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
    /** Число открытых комнат (тестам: утечки). */
    roomCount() {
      return rooms.size;
    },
    /** Кадров в кеше проекта (тестам). */
    cachedFrames(projectId) {
      const room = rooms.get(projectId);
      return room ? [...room.frames.keys()] : [];
    },
    /** Байты кеша кадров: всего и по комнате (тестам). */
    cacheBytes(projectId) {
      if (projectId === undefined) return cachedBytes;
      const room = rooms.get(projectId);
      return room ? room.frameBytes : 0;
    },
    /** Клиенты чужих экземпляров, о которых помнит комната (тестам). */
    remotePresence(projectId) {
      const room = rooms.get(projectId);
      return room ? [...room.remote.values()].map((e) => ({ instance: e.i, client: e.c })) : [];
    },
    /** Сколько кадров tx сериализовано (тестам: один раз на событие, а не на сокет). */
    framesSerialized: () => framesSerialized,
    /** Присутствие (круг 33, тестам): кадров разослано, тиков, ждут в комнате (сокетам и шине). */
    presenceStats(projectId) {
      const room = projectId !== undefined ? rooms.get(projectId) : null;
      return { framesSent: presenceFramesSent, ticks: presenceTicks, pending: room ? room.pres.size : 0, busPending: room ? room.bus.size : 0 };
    },
    /** Сколько транзакций сокеты получили `busy` сверх предела «в полёте» (тестам). */
    busyRefused: () => busyRefused,
    /** Прогнать TTL присутствия сейчас (тестам). */
    sweepPresence,
    /** Закрыть все сокеты кодом 1001 («уходим») и снять таймеры; чужим экземплярам — bye. */
    async close() {
      if (closing) return;
      closing = true;
      unsubscribe();
      unbus();
      dslts.setWatcher(null);
      if (pinger) clearInterval(pinger);
      if (sweeper) clearInterval(sweeper);
      // остальные экземпляры: все клиенты этого — ушли (не ждать TTL)
      publish({ k: 'bye', i: instanceId });
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise((resolve) => wss.close(() => resolve()));
      for (const room of rooms.values()) {
        clearFrames(room);
        if (room.presTimer) clearTimeout(room.presTimer);
        room.presTimer = null;
      }
      rooms.clear();
    }
  };
}
