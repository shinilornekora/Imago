/**
 * DSLR-клиент (SPEC §10.1, стрелки 4a/5a): стейт проекта и номер головы у Document service.
 *
 * Кеш на проект: `{seq, doc, chain, epoch}` — документ на своей голове, якорь этой головы
 * (`chain` её записи, §9.8) и эпоха, в которой он прочитан. Первый раз — `GET
 * /api/projects/:id` (снимок + первая страница хвоста; `more:true` — дочитываем хвост),
 * дальше — `GET …/ops?since=<seq>&tip=<chain>&epoch=<epoch>`: сервис сам сверяет якорь и
 * отдаёт хвост только тому, чей журнал цел. Страницы читаются, пока `more` (страница режется
 * и по числу, и по байтам — её длина ничего не говорит о конце).
 *
 * Каждая пришедшая запись проверяется: `seq` подряд, `chain = sha256(prev + tx_id + seq)`
 * от нашего якоря, строгий `applyOps` на кешированный документ (журнал хранит применённую
 * форму, движок один, §8.3). `410`, другая эпоха в ответе, чужой chain, голова позади кеша
 * или отказ applyOps — значит, журнал под нами переписан (откат базы, restore): кеш проекта
 * выбрасывается и стейт читается целиком заново. Иначе агент строил бы патч по документу,
 * которого в журнале больше нет.
 *
 * Чтения одного проекта идут по одному (цепочка промисов): параллельные DUIL и команда не
 * затирают кеш более старым стейтом.
 *
 * Круг 39 (N5а) — шторм команд в большие проекты (30 × 14 тыс. узлов разом): полные чтения шли
 * все сразу, пик памяти агента ~0,9 ГБ, а таймауты занятого главного потока становились
 * «Сервис документов недоступен». Теперь:
 *   • полные чтения — под семафором (`createReadGate`): одновременно не больше `fullConcurrency`,
 *     и документы, прочитанные целиком и ещё нужные командам, — не больше `fullBytes` (длина JSON;
 *     команда держит свою долю до конца расчёта — `lease`); ждущим — `onQueued(position)`
 *     (событие `queued {scope:'read'}`); ждущих больше `fullQueue` — сразу 503 `busy`;
 *   • всё чтение — в бюджете `readBudgetMs` (очередь, повтор после таймаута, Retry-After);
 *     503 busy сервиса ждётся по его Retry-After; сервис так и не ответил в срок — 503 `busy`
 *     («перегружен, повторите»). `document_down` остаётся для «нет связи» и 5xx без признаков
 *     перегрузки.
 */

import { createHash } from 'node:crypto';
import { applyBatches } from '../../../src/core.js';
import { notFound, OrchError, documentBusy, cancelled } from '../errors.js';
import {
  DSLR_CACHE_PROJECTS, DSLR_CACHE_BYTES, DOC_PAGE_LIMIT, DSLR_MAX_PAGES, DSLR_FULL_ATTEMPTS, DOC_RETRY_AFTER_MAX_S,
  DOC_TIMEOUT_MS, DOC_FULL_TIMEOUT_MS, DSLR_FULL_CONCURRENCY, DSLR_FULL_BYTES, DSLR_FULL_QUEUE, DSLR_READ_BUDGET_MS,
  DSLR_TIMEOUT_RETRIES, DSLR_READ_ESTIMATE_BYTES, DSLR_SIZE_MEMO,
} from '../limits.js';

/**
 * Круг 39 (N5а): семафор полных чтений — по числу одновременных и по байтам.
 *
 * Очередь по порядку (большой документ не обгоняется мелкими и не голодает): чтение с байтами
 * проходит, когда занято меньше `max` чтений и его оценка помещается в `bytes` — или когда
 * байтов не держит никто (документ больше всего предела читается один). Пропуск (`grant`)
 * отпускает место чтения (`done()`) и байты (`free()`) порознь: байты команда держит, пока ей
 * нужен документ. `resize(n)` — фактический размер вместо оценки.
 * Чтение без байтов (`need` 0: библиотеки DUIL — документ уходит в кеш, команда его не
 * держит) ждёт только места и обходит чтения, которые ждут байтов: иначе команда, держащая
 * байты своего документа, ждала бы чтения своей же библиотеки за чужой спиной.
 * @param {{max?: number, bytes?: number, queue?: number}} [o]
 */
export function createReadGate({ max = DSLR_FULL_CONCURRENCY, bytes = DSLR_FULL_BYTES, queue = DSLR_FULL_QUEUE } = {}) {
  let active = 0;
  let held = 0;
  const waiting = [];
  const stats = { peak: 0, peakBytes: 0, waited: 0, refused: 0, expired: 0 };

  const fits = (need) => active < max && (need === 0 || held === 0 || held + need <= bytes);

  function grant(need) {
    active++;
    held += need;
    if (active > stats.peak) stats.peak = active;
    if (held > stats.peakBytes) stats.peakBytes = held;
    let reading = true;
    let size = need;
    return {
      /** Чтение кончилось: место — следующему (байты остаются за документом). */
      done() {
        if (!reading) return;
        reading = false;
        active--;
        pump();
      },
      /** Фактический размер вместо оценки. */
      resize(n) {
        if (size === null || !Number.isFinite(n) || n < 0) return;
        held += n - size;
        size = n;
        if (held > stats.peakBytes) stats.peakBytes = held;
        pump();
      },
      /** Документ больше не нужен: байты — следующим. */
      free() {
        this.done();
        if (size === null) return;
        held -= size;
        size = null;
        pump();
      },
    };
  }

  function pump() {
    let byteHead = true;   // среди ждущих байтов — только первый (строгий порядок)
    for (let i = 0; i < waiting.length && active < max;) {
      const w = waiting[i];
      if ((w.need === 0 || byteHead) && fits(w.need)) {
        waiting.splice(i, 1);
        w.take();
        continue;
      }
      // первый ждущий байтов не прошёл — следующие за ним ждут (порядок), без байтов — нет
      if (w.need > 0) byteHead = false;
      i++;
    }
    waiting.forEach((w, i) => w.at(i + 1));
  }

  /**
   * @param {number} need оценка размера (байтов JSON)
   * @param {{signal?: AbortSignal, deadline?: number, onQueued?: (position: number) => void}} [o]
   * @returns {Promise<{done: Function, resize: Function, free: Function}>}
   */
  function acquire(need, { signal, deadline, onQueued } = {}) {
    const n = Math.max(0, Number(need) || 0);
    if (signal && signal.aborted) return Promise.reject(cancelled());
    if ((n === 0 ? !waiting.some((w) => w.need === 0) : !waiting.some((w) => w.need > 0)) && fits(n)) return Promise.resolve(grant(n));
    if (waiting.length >= queue) {
      stats.refused++;
      return Promise.reject(documentBusy(5, { cause: 'очередь полных чтений агента полна' }));
    }
    stats.waited++;
    return new Promise((resolve, reject) => {
      let told = 0;
      const w = { need: n };
      const off = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        const i = waiting.indexOf(w);
        if (i >= 0) { waiting.splice(i, 1); waiting.forEach((x, k) => x.at(k + 1)); }
      };
      const onAbort = () => { off(); reject(cancelled()); };
      const timer = setTimeout(() => {
        off();
        stats.expired++;
        reject(documentBusy(5, { cause: 'полное чтение не дождалось очереди' }));
      }, Math.max(1, (deadline || Date.now() + DSLR_READ_BUDGET_MS) - Date.now()));
      w.take = () => { off(); resolve(grant(n)); };
      w.at = (pos) => {
        if (pos === told || !onQueued) return;
        told = pos;
        try { onQueued(pos); } catch { /* интерфейс не роняет чтение */ }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(w);
      w.at(waiting.length);
    });
  }

  return {
    acquire, stats,
    get active() { return active; },
    get held() { return held; },
    get waiting() { return waiting.length; },
  };
}

/** Круг 39: пауза перед единственным повтором чтения после обрыва соединения. */
const NET_RETRY_PAUSE_MS = 150;

/** Якорь записи журнала (SPEC §9.8): sha256(prev_chain + tx_id + seq), hex. */
export function chainNext(prev, txId, seq) {
  return createHash('sha256').update(String(prev || '') + String(txId) + String(seq), 'utf8').digest('hex');
}

/** Сигнал «журнал под кешем переписан — читать заново». */
class Reset extends Error {
  constructor(why) {
    super(why);
    this.reset = true;
  }
}

/**
 * Оценка размера документа в байтах JSON — без сериализации: строки и числа обходом.
 * Для кеша достаточно порядка величины (точный JSON 24-мегабайтного документа — сотни мс).
 */
export function estimateBytes(value) {
  let bytes = 0;
  const stack = [value];
  let guard = 0;
  while (stack.length && guard++ < 5e6) {
    const v = stack.pop();
    if (typeof v === 'string') bytes += v.length + 2;
    else if (typeof v === 'number' || typeof v === 'boolean') bytes += 8;
    else if (v === null || v === undefined) bytes += 4;
    else if (Array.isArray(v)) { bytes += 2 + v.length; for (const x of v) stack.push(x); }
    else if (typeof v === 'object') {
      bytes += 2;
      for (const k of Object.keys(v)) { bytes += k.length + 4; stack.push(v[k]); }
    }
  }
  return bytes;
}

/**
 * @param {{doc: ReturnType<import('../docclient.js').createDocClient>, log?: object, cacheSize?: number, cacheBytes?: number, pageLimit?: number}} o
 */
export function createDslrClient({
  doc: net, log = console, cacheSize = DSLR_CACHE_PROJECTS, cacheBytes = DSLR_CACHE_BYTES, pageLimit = DOC_PAGE_LIMIT,
  fullConcurrency = DSLR_FULL_CONCURRENCY, fullBytes = DSLR_FULL_BYTES, fullQueue = DSLR_FULL_QUEUE,
  fullTimeoutMs = DOC_FULL_TIMEOUT_MS, pageTimeoutMs = DOC_TIMEOUT_MS, readBudgetMs = DSLR_READ_BUDGET_MS,
  timeoutRetries = DSLR_TIMEOUT_RETRIES, retryAfterMaxS = DOC_RETRY_AFTER_MAX_S, estimateBytes: estimateDefault = DSLR_READ_ESTIMATE_BYTES,
}) {
  /** Круг 39: семафор полных чтений (число и байты). */
  const gate = createReadGate({ max: fullConcurrency, bytes: fullBytes, queue: fullQueue });
  /** Круг 39: проект → последний известный размер JSON (оценка до чтения); порядок — давность. */
  const sizes = new Map();
  const noteSize = (id, n) => {
    if (!Number.isFinite(n) || n <= 0) return;
    sizes.delete(id);
    sizes.set(id, n);
    while (sizes.size > DSLR_SIZE_MEMO) sizes.delete(sizes.keys().next().value);
  };
  /** id → {seq, doc, chain, epoch, project, bytes}; порядок вставки = давность использования. */
  const cache = new Map();
  let cachedBytes = 0;
  /** id → хвост цепочки чтений этого проекта. */
  const lanes = new Map();
  const stats = { full: 0, incremental: 0, hits: 0, resets: 0, pages: 0, evicted: 0, busyWaits: 0, timeoutRetries: 0, overloaded: 0, netRetries: 0 };

  const drop = (id) => {
    const e = cache.get(id);
    if (!e) return;
    cache.delete(id);
    cachedBytes -= e.bytes || 0;
  };

  /**
   * Круг 25: предел кеша — и число проектов, и байты (оценка JSON документов). Самый
   * давний вытесняется, пока сумма больше; только что прочитанный остаётся всегда (он
   * нужен команде сейчас), даже если один больше предела.
   */
  const remember = (id, entry) => {
    drop(id);
    cache.set(id, entry);
    cachedBytes += entry.bytes || 0;
    while (cache.size > 1 && (cache.size > cacheSize || cachedBytes > cacheBytes)) {
      const oldest = cache.keys().next().value;
      if (oldest === id) break;
      drop(oldest);
      stats.evicted++;
    }
  };

  const path = (id) => `/api/projects/${encodeURIComponent(id)}`;

  /**
   * Хвост поверх состояния. Записи обязаны идти подряд от `st.seq`, их chain — продолжать
   * наш якорь (если он известен: сервис до §9.8 chain не отдавал), а операции — ложиться
   * строгим applyOps. Иначе — Reset.
   * @param {{seq:number, doc:object, chain:string|null}} st
   */
  function replay(st, txs, id = '') {
    let { seq, chain } = st;
    const batches = [];
    const verified = [];   // круг 31: запись сверена с нашим якорем — журнал под нами не переписан
    for (const tx of txs) {
      if (!tx || tx.seq !== seq + 1) throw new Reset(`дыра в номерах журнала: ждали ${seq + 1}, пришла ${tx && tx.seq}`);
      if (typeof tx.chain === 'string' && tx.chain) {
        if (chain !== null && chainNext(chain, tx.tx_id, tx.seq) !== tx.chain) {
          throw new Reset(`запись ${tx.seq} не продолжает якорь кеша (журнал переписан)`);
        }
        verified.push(chain !== null);
        chain = tx.chain;
      } else {
        verified.push(false);
        chain = null;   // сверять дальше нечем
      }
      batches.push(Array.isArray(tx.ops) ? tx.ops : []);
      seq = tx.seq;
    }
    // круг 25: вся страница — одним черновиком (applyBatches), а не копией словаря узлов
    // на каждую транзакцию; каждая транзакция по-прежнему строгая и атомарная
    const res = applyBatches(st.doc, batches);
    for (let i = 0; i < res.results.length; i++) {
      const r = res.results[i];
      if (!r || !r.error) continue;
      const e = r.error;
      /* Круг 31: запись сверена якорем — журнал цел, а не лёг она потому, что движок строже
         того, что её когда-то принял (документ прежней версии, §9.14). Секвенсор в этом
         случае пропускает её с предупреждением и идёт дальше (dslts, «не применяется»);
         так же и здесь — иначе перечитывание целиком упиралось бы в ту же запись, и проект
         навсегда оставался без агента («Стейт проекта не собрался»). Не сверена — как
         прежде: журнал мог быть переписан, читаем заново. */
      if (!verified[i]) throw new Reset(`журнал не лёг на кеш (seq ${txs[i].seq}): ${e.message || e}`);
      log.warn(`[orchestrator/dslr] ${id}: seq ${txs[i].seq} не применяется текущим движком — пропущена, как у секвенсора: ${e.message || e}`);
    }
    // размер — прибавкой операций (remove его не уменьшает); набежало больше половины
    // от последнего обхода — обходим документ заново, чтобы оценка не уплывала вверх
    const grown = batches.reduce((n, ops) => n + (ops.length ? estimateBytes(ops) : 0), 0);
    let bytes = (st.bytes || 0) + grown;
    let bytesAt = st.bytesAt || st.bytes || 0;
    if (grown && bytes - bytesAt > bytesAt / 2) bytes = bytesAt = estimateBytes(res.doc);
    return { seq, doc: res.doc, chain, bytes, bytesAt };
  }

  /** Ответ, который не 200 и не 404/410, — сбой чтения. */
  const failed = (what, r) => new OrchError(502, 'document_failed', `Document service ответил на ${what} ${r.status}`);

  /**
   * GET с ожиданием по Retry-After при 503 (семафор тяжёлых чтений сервиса, §9.8) и, круг 39,
   * в бюджете всего чтения (`opts.deadline`):
   *   • 503 busy — ждём его Retry-After (не дольше `retryAfterMaxS` за раз), пока бюджет есть;
   *     не дождались — 503 `busy` агента;
   *   • 503 с Retry-After по другой причине (база сервиса недоступна) — как прежде, два ожидания,
   *     потом его ошибка (`document_down`);
   *   • нет ответа в срок (`timedOut`) — повтор (`timeoutRetries` раз), пока бюджет есть; потом
   *     `busy`: сервис принял запрос и молчит под очередью — это перегрузка, а не «недоступен»;
   *   • нет связи и прочие 5xx — `document_down`, как прежде.
   * @param {string} url
   * @param {{signal?: AbortSignal, deadline?: number}} opts
   * @param {number} [timeout] срок одного запроса, мс
   */
  async function get(url, opts, timeout = pageTimeoutMs) {
    const deadline = opts.deadline || Date.now() + readBudgetMs;
    let unavailableWaits = 0;
    let timeouts = 0;
    let resets = 0;
    let lastBusy = null;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw overloaded(lastBusy, url);
      try {
        return await net.get(url, { signal: opts.signal, timeout: Math.max(1, Math.min(timeout, left)) });
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw e;
        if (!e || e.code !== 'document_down') throw e;
        if (e.docStatus === 503 && (e.docCode === 'busy' || e.docRetryAfter)) {
          const busy = e.docCode === 'busy';
          const wait = Math.max(1, Math.min(e.docRetryAfter || 1, retryAfterMaxS)) * 1000;
          if (busy) {
            lastBusy = e;
            if (Date.now() + wait >= deadline) throw overloaded(e, url);
          } else if (unavailableWaits++ >= 2 || Date.now() + wait >= deadline) {
            throw e;
          }
          stats.busyWaits++;
          await sleep(wait, opts.signal);
          continue;
        }
        if (e.timedOut) {
          lastBusy = e;
          if (timeouts++ >= timeoutRetries || deadline - Date.now() < 1000) throw overloaded(e, url);
          stats.timeoutRetries++;
          log.warn(`[orchestrator/dslr] ${url}: ${e.detail && e.detail.cause ? e.detail.cause : 'нет ответа'} — повторяю`);
          continue;
        }
        /* Круг 39: соединение оборвалось (под нагрузкой — сокет keep-alive, который сервис как раз
           закрыл) — чтение безопасно повторить: один раз, после короткой паузы. Не помогло —
           сервис и правда недоступен. */
        if (e.network && !resets && deadline - Date.now() > NET_RETRY_PAUSE_MS) {
          resets++;
          stats.netRetries++;
          await sleep(NET_RETRY_PAUSE_MS, opts.signal);
          continue;
        }
        log.warn(`[orchestrator/dslr] ${url}: ${e.detail && e.detail.cause ? e.detail.cause : e.message} — сервис документов недоступен`);
        throw e;
      }
    }
  }

  /** Круг 39: сервис жив, но перегружен (busy/таймаут сверх бюджета) — 503 `busy` агента. */
  function overloaded(e, url) {
    stats.overloaded++;
    const cause = e && e.detail && e.detail.cause ? e.detail.cause : 'бюджет чтения исчерпан';
    log.warn(`[orchestrator/dslr] ${url}: сервис документов перегружен (${cause}) — команде busy`);
    return documentBusy(e && e.docRetryAfter ? e.docRetryAfter : 5, { cause: e && e.ownLag ? 'agent' : 'document' });
  }

  /**
   * Дочитать хвост страницами `ops?since=&tip=&epoch=` до конца (`more:false`).
   * @param {string} id
   * @param {{seq:number, doc:object, chain:string|null, epoch:string|null}} st
   */
  async function catchUp(id, st, opts) {
    let cur = { ...st };
    for (let page = 0; page < DSLR_MAX_PAGES; page++) {
      const q = new URLSearchParams({ since: String(cur.seq), limit: String(pageLimit) });
      if (cur.chain) q.set('tip', cur.chain);
      if (cur.epoch) q.set('epoch', cur.epoch);
      const r = await get(`${path(id)}/ops?${q}`, opts);
      stats.pages++;
      if (r.status === 404) throw notFound('Проект не найден');
      if (r.status === 410) throw new Reset('сервис документов ответил 410 — журнал с нашего места не догнать');
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.txs)) throw failed('чтение журнала', r);
      const b = r.body;
      if (cur.epoch && b.epoch && b.epoch !== cur.epoch) throw new Reset(`эпоха проекта сменилась (${cur.epoch} → ${b.epoch})`);
      const txs = b.txs;
      const head = Number.isInteger(b.head_seq) ? b.head_seq : null;
      if (!txs.length) {
        if (head !== null && head < cur.seq) throw new Reset(`голова журнала (${head}) позади кеша (${cur.seq})`);
        if (b.more === true || (head !== null && head > cur.seq)) throw new Reset('журнал обещает записи, но страница пуста');
        // голова на нашем месте — якорь обязан совпасть
        if (cur.chain && typeof b.tip === 'string' && b.tip && b.tip !== cur.chain) throw new Reset('якорь головы не совпал с кешем');
        return { ...cur, epoch: cur.epoch || b.epoch || null };
      }
      const got = replay(cur, txs, id);
      cur = { ...got, epoch: cur.epoch || b.epoch || null };
      // конец — по флагу `more` (страница режется и по байтам); сервис до §9.8 флага не знал
      const more = typeof b.more === 'boolean' ? b.more : head !== null && cur.seq < head;
      if (!more) return cur;
    }
    throw new OrchError(502, 'document_failed', 'Журнал проекта не дочитался: слишком много страниц');
  }

  /** Полное чтение: снимок + хвост (+ дочитывание по `more`). */
  async function full(id, opts, ticket) {
    const r = await get(path(id), opts, fullTimeoutMs);
    if (r.status === 404) throw notFound('Проект не найден');
    if (r.status !== 200 || !r.body || !r.body.snapshot || !r.body.snapshot.doc) throw failed('чтение проекта', r);
    // круг 39: фактический размер — в семафор (вместо оценки) и в память на следующий раз
    if (Number.isFinite(r.chars) && r.chars > 0) {
      noteSize(id, r.chars);
      if (ticket) ticket.resize(r.chars);
    }
    const { snapshot, tail = [], more, ...project } = r.body;
    const base = {
      seq: snapshot.seq,
      doc: snapshot.doc,
      // круг 39: размер — длиной пришедшего JSON (он и есть оценка), без обхода документа
      bytes: Number.isFinite(r.chars) && r.chars > 0 ? r.chars : estimateBytes(snapshot.doc),
      chain: typeof snapshot.chain === 'string' ? snapshot.chain : null,
      epoch: typeof project.epoch === 'string' && project.epoch ? project.epoch : null,
    };
    let st = { ...replay(base, Array.isArray(tail) ? tail : [], id), epoch: base.epoch };
    const head = Number.isInteger(project.head_seq) ? project.head_seq : st.seq;
    if (more === true || (more === undefined && st.seq < head)) st = await catchUp(id, st, opts);
    stats.full++;
    return { ...st, meta: project };
  }

  /**
   * Прочитать заново целиком (ограниченно: журнал может переписываться прямо сейчас).
   * Круг 39: под семафором полных чтений. Место чтения отпускается, как только документ собран;
   * байты — когда документ больше не нужен: `opts.lease` (команда держит их до конца расчёта и
   * отпускает `lease.release()`), без него — сразу.
   */
  async function fresh(id, opts) {
    const leased = !!(opts.lease && typeof opts.lease === 'object');
    const need = leased ? sizes.get(id) || estimateDefault : 0;
    const ticket = await gate.acquire(need, { signal: opts.signal, deadline: opts.deadline, onQueued: opts.onQueued });
    let kept = false;
    try {
      if (opts.onStart) { try { opts.onStart(); } catch { /* ignore */ } }
      let last = null;
      for (let i = 0; i < DSLR_FULL_ATTEMPTS; i++) {
        try {
          const st = await full(id, opts, leased ? ticket : null);
          if (leased) {
            opts.lease.release = () => ticket.free();
            kept = true;
          }
          return { ...st, project: summary(st.meta, st.seq) };
        } catch (e) {
          if (!(e instanceof Reset)) throw e;
          last = e;
          stats.resets++;
          log.warn(`[orchestrator/dslr] ${id}: ${e.message} — читаю заново`);
        }
      }
      throw new OrchError(502, 'document_failed', `Стейт проекта не собрался: ${last ? last.message : 'журнал меняется под чтением'}`);
    } finally {
      if (kept) ticket.done();
      else ticket.free();
    }
  }

  async function readNow(id, opts) {
    const hit = cache.get(id);
    let entry;
    if (!hit) {
      entry = await fresh(id, opts);
    } else {
      try {
        const st = await catchUp(id, hit, opts);
        if (st.seq === hit.seq) stats.hits++;
        else stats.incremental++;
        entry = { ...st, project: { ...hit.project, head_seq: st.seq } };
      } catch (e) {
        if (e && e.code === 'not_found') drop(id);
        if (!(e instanceof Reset)) throw e;
        // журнал под кешем переписан: кеш проекта — вон, стейт — заново
        drop(id);
        stats.resets++;
        log.warn(`[orchestrator/dslr] ${id}: ${e.message} — кеш выброшен, читаю целиком`);
        entry = await fresh(id, opts);
      }
    }
    remember(id, entry);
    return entry;
  }

  /**
   * Стейт проекта на голове журнала.
   * @param {string} id
   * @param {{signal?: AbortSignal, onQueued?: (position: number) => void, onStart?: () => void,
   *   lease?: {release?: Function}}} [opts] круг 39: onQueued — полное чтение ждёт семафора (номер
   *   в очереди); onStart — дождалось; lease — документ прочитан целиком: его байты в семафоре
   *   держатся до `lease.release()` (иначе отпускаются сразу); кеш или дочитывание хвоста —
   *   `lease.release` не задаётся
   * @returns {Promise<{seq: number, doc: object, chain: string|null, epoch: string|null, project: {id, name, kind, head_seq}}>}
   */
  function read(id, opts = {}) {
    const prev = lanes.get(id) || Promise.resolve();
    // круг 39: бюджет всего чтения считается с его начала (с очередью проекта и семафором)
    const o = { ...opts, deadline: opts.deadline || Date.now() + readBudgetMs };
    const run = prev.catch(() => {}).then(() => readNow(id, o)).catch((e) => {
      if (e && e.code === 'not_found') drop(id);
      throw e;
    });
    const tail = run.catch(() => {});
    lanes.set(id, tail);
    tail.then(() => { if (lanes.get(id) === tail) lanes.delete(id); });
    return run;
  }

  /** Список проектов: [{id, name, kind, head_seq, updated_at}]. */
  async function list(opts = {}) {
    const { query, ...rest } = opts;
    const r = await net.get(query ? `/api/projects?${query}` : '/api/projects', rest);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.projects)) throw failed('список проектов', r);
    return r.body.projects;
  }

  return {
    read, list, stats,
    /** Круг 39: семафор полных чтений (тестам и отладке). */
    gate,
    forget: (id) => drop(id),
    /** Сколько байтов (оценка) и проектов в кеше. */
    usage: () => ({ projects: cache.size, bytes: cachedBytes }),
    /** Для тестов и отладки: что лежит в кеше (без документа). */
    peek: (id) => { const e = cache.get(id); return e ? { seq: e.seq, chain: e.chain, epoch: e.epoch, doc: e.doc } : null; },
  };
}

function summary(p, seq) {
  return { id: p.id, name: p.name, kind: p.kind || 'design', head_seq: seq };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}
