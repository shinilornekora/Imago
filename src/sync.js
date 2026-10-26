/**
 * Imago Studio — клиент-реплика Document service (круг 22, SPEC §8.3, §9.5).
 *
 * Клиент — ПОЛНАЯ реплика с локальным журналом: свои правки применяются всегда и
 * сразу, переживают перезагрузку вкладки и досылаются при воссоединении. Сервер —
 * единственный арбитр порядка; здесь нет ни решателя, ни отрисовки, только
 * состояние и его синхронизация:
 *
 *   confirmed = {seq, doc}   что подтвердил сервер (снимок + применённые транзакции)
 *   pending   = Tx[]         свои транзакции в порядке отправки, ещё без номера
 *   view      = replay(confirmed.doc, pending) — теми же rebase + applyOps, что в DSLTS
 *
 * Поэтому клиент почти всегда угадывает, что сделает сервер, а расхождение (сервер
 * отбросил операцию) видно по `dropped` в подтверждении и пересчитывается по
 * применённой форме. Модуль не трогает DOM: он исполняется и в Node — тесты гоняют
 * его с фальшивым сервером и фальшивым сокетом (test/sync.test.mjs).
 *
 * Локальный журнал (SPEC §9.5): IndexedDB `imago`, хранилище `projects`, ключ — id
 * проекта; запись `{seq, doc, pending, tombstones, clientId, updatedAt, extra, tip,
 * epoch, mine}`. Пишется после каждого изменения, но не чаще раза в 200 мс; перед
 * уходом со страницы оболочка зовёт flush().
 *
 * Круг 23 (SPEC §9.8): якорь `tip` — chain последней подтверждённой транзакции, и
 * эпоха журнала `epoch`; оба уходят серверу при переподключении (`?since=&tip=&epoch=`).
 * Сервер, у которого журнал под этим номером другой (база откатилась из бэкапа),
 * присылает снимок; при смене эпохи сокет закрывается кодом 4410 — реплика сразу
 * переоткрывается, берёт снимок, а свою очередь — и свои транзакции, подтверждённые
 * в прежней эпохе (`mine`), — переигрывает поверх: сервер узнает уцелевшие по tx_id,
 * потерянные запишет заново. Правки не теряются.
 *
 * Круг 24 (SPEC §9.9): присутствие — сердцебиением раз в 15 с (сервер без вестей 45 с
 * объявляет `left`, присутствие ходит между экземплярами сервиса), с полями `busy` /
 * `queued` (агент работает над командой этого человека) — как их дала оболочка;
 * в адресе сокета `proto=2` — клиент знает `ack` (прежнему сервер вместо `ack` шлёт
 * `error {code:'duplicate'}`, его реплика тоже понимает).
 *
 * Круг 25 (SPEC §9.10): после отката базы переигрываются все свои из прежней эпохи (окно
 * 200, и транзакции агента по команде этой вкладки), с `replay_of_epoch`/`replay_at` —
 * сервер не даст старому значению затереть более новое чужое (`dropped: stale`); старше
 * суток — не переигрываются, человеку сказано. Транзакция, на которую сервер раз за разом
 * отвечает одной и той же повторяемой ошибкой, снимается в «не сохранено» (`unsaved`),
 * очередь идёт дальше. Журнал подтверждённых в памяти — `journal()`, `whoRemoved()`, `by` и
 * `label` в `onDropped`. Строки правки чистятся (U+0000, одиночные суррогаты), как на сервере.
 *
 * Круг 27: журнал — две записи (`<id>` — очередь и хвост подтверждённых, пишется через
 * 200 мс; `<id>#doc` — документ, не чаще раза в 1,5 с); переигрывание очереди группами
 * одним черновиком, подтверждение своей в предсказанной форме — без переигрывания; после
 * догона очередь идёт сама (откат базы при многих вкладках); ack во время догона ждёт его
 * конца; пропавший проект — `not_found` без потери очереди; `onProject`; надгробия снимка
 * v2/v1/null.
 *
 * Круг 29: надгробия подтверждённых — с номером удаления и прореживаются правилом сервера
 * (LIMITS.tomb*), надгробия view — наложение ожидающих поверх подтверждённых, без копии на
 * кадр; журнал «Истории» после hello и после снимка подгружается с сервера (`/history`, J3);
 * хранилище сервера недоступно — `status.storage: 'down'`, «сервер не может сохранить —
 * правки ждут», правка не снимается как «отравленная», health снимает статус (J4).
 */

const WRITE_DELAY = 200;          // пауза между изменением и записью журнала (очередь, mine, extra)
const DOC_WRITE_GAP = 1500;       // подтверждённый документ — в журнал не чаще (structuredClone 19 500 узлов ≈ 100 мс)
const DOC_TAIL_MAX = 200;         // столько подтверждённых сверх записанного документа — записать документ сразу
const DOC_TAIL_BYTES = 2 * 1024 * 1024; // …или столько байт их операций
const DOC_SUFFIX = '#doc';        // ключ записи документа в журнале: <projectId>#doc
const NOT_FOUND_RETRY = 30 * 1000; // проекта нет на сервере: следующая попытка через 30–60 с (I3)
const PRESENCE_GAP = 100;         // присутствие — не чаще 10 раз в секунду (§9.3)
const PRESENCE_TTL = 90 * 1000;   // чужое присутствие без вестей столько — считаем ушедшим
const ACK_TIMEOUT = 8 * 1000;     // подтверждение не пришло — дослать (идемпотентно), потом переподключиться
const OPS_PAGE = 500;             // сколько транзакций просить за один GET …/ops
const FIRST_CONNECT_MS = 6 * 1000;
const ENGINE_RECHECK_MS = 15 * 1000;  // круг 41: сервер старее клиента — так часто спрашиваем /api/health, не обновился ли   // круг 39: первое подключение дольше — уже не «подключаюсь», а честное «недоступен»
const HELLO_TIMEOUT = 8 * 1000;   // сокет открыт, а hello нет — это не сервер (или зомби): закрыть и подключиться заново
const MINE_KEEP = 200;            // своих подтверждённых транзакций помним столько — переиграть после отката базы
const MINE_BYTES = 4 * 1024 * 1024; // …и не больше стольких байт JSON (старые вытесняются первыми)
const MINE_EVICTED_KEEP = 5000;   // вытесненных из окна (эпоха, seq) помним столько — сказать, что не переиграно
const JOURNAL_KEEP = 500;         // журнал подтверждённых транзакций в памяти (история, «кто удалил»)
const JOURNAL_LEAVES = 200;       // листьев/узлов на запись журнала для «кто помешал»
const RETRY_POISON = 8;           // столько одинаковых повторяемых ошибок подряд на одну транзакцию при живом сервере — снять её
const UNSAVED_KEEP = 50;          // снятых «не сохранено» помним столько
const HTTP_RETRIES = 4;           // 503/429 с Retry-After: столько повторов, потом — как сбой
const RETRY_AFTER_MAX = 30;       // Retry-After больше этого (с) не ждём — это уже не «чуть позже»
const EPOCH_REOPEN_MS = 250;      // переоткрытие после 4410 — сразу, с разбросом, чтобы вкладки не били в такт
const IDLE_HEALTH_MS = 12000;     // круг 33: /api/health в простое — база могла лечь без единой правки
const PRESENCE_BATCH_MAX = 2000;  // записей в одном presence_batch — больше не разбираем (кадр ≤ 64 КБ)
const CLOSE_EPOCH = 4410;         // сервер: эпоха журнала сменилась (SPEC §9.8)
const CLOSE_NOT_FOUND = 4404;     // сервер: проекта нет (базу восстановили без него) — круг 27, I3
const CLOSE_TOO_BIG = 1009;       // ws: сообщение больше предела
const VALUE_DEPTH = 64;           // вложенность значений: глубже сервер ответит 400 (MAX_VALUE_DEPTH)
const COMMAND_ID_CHARS = 128;     // command_id транзакции: длиннее сервер выбросит (MAX_COMMAND_ID)
const HISTORY_LIMIT = 100;        // «История» после открытия и снимка: столько последних транзакций с сервера (J3)

/**
 * Числа протокола, которые клиент держит рядом с серверными (круг 26): тест
 * `test/server/hardening.test.mjs` сверяет их с server/document (limits.js, hub.js) —
 * равенством там, где клиент обязан совпадать, и неравенством там, где клиент
 * обязан быть не строже/не чаще сервера.
 */
export const WIRE = Object.freeze({
  presenceGapMs: PRESENCE_GAP,       // ≥ 1000 / PRESENCE_PER_SECOND сервера
  presenceTtlMs: PRESENCE_TTL,       // ≥ PRESENCE_TTL_MS сервера (сервер скажет left раньше)
  opsPage: OPS_PAGE,                 // ≤ MAX_LIMIT сервера
  valueDepth: VALUE_DEPTH,           // = MAX_VALUE_DEPTH
  commandIdChars: COMMAND_ID_CHARS,  // = MAX_COMMAND_ID
  closeEpoch: CLOSE_EPOCH,           // = hub CLOSE.epoch
  closeNotFound: CLOSE_NOT_FOUND,    // = hub CLOSE.notFound
});

/**
 * Пределы сервера (server/document/limits.js CLIENT_LIMITS — тест сверяет числа):
 * транзакцию больше этого клиент не заводит — сервер отверг бы её (413), и она
 * крутилась бы в очереди вечно.
 */
export const LIMITS = Object.freeze({
  txBytes: 4 * 1024 * 1024,
  opsPerTx: 5000,
  docBytes: 24 * 1024 * 1024,
  docNodes: 20000,
  presenceSelection: 200,        // id в выделении присутствия — больше сервер обрежет (truncated)
  presenceHeartbeatMs: 15000,    // сердцебиение присутствия: сервер считает ушедшим после 45 с тишины
  replayMaxAgeMs: 24 * 60 * 60 * 1000,   // свои правки старше суток после отката базы не переигрываются (SPEC §9.10)
  /* Надгробия подтверждённых (круг 29): прореживаются тем же правилом, что голова сервера
     (server/document/limits.js TOMB_KEEP_SEQ / TOMB_PRUNE_EVERY / TOMB_MAX — тест сверяет):
     на каждой границе номера, кратной tombPruneEvery, уходят удалённые раньше, чем за
     tombKeepSeq до неё; сверх tombMax остаются самые новые. Без этого реплика копила
     надгробия вечно (196 тыс. — 4,7 с на 20 чужих кадров). */
  tombKeepSeq: 10000,
  tombPruneEvery: 500,
  tombMax: 50000,
});

/** Причины отброшенных операций — словами человека (SPEC §9.1 DropReason, §9.8 limit). */
export const DROP_WORDS = Object.freeze({
  removed: 'слой уже удалён',
  orphan: 'родитель удалён',
  cycle: 'перемещение создало бы цикл',
  exists: 'уже есть',
  invalid: 'правка не подошла к документу',
  doc_nodes: 'документ упёрся в предел числа слоёв',
  doc_bytes: 'документ упёрся в предел размера',
  merge_budget: 'сервер не успел разобрать правку',
  ops_per_tx: 'слишком много операций в одной правке',
  tx_bytes: 'правка слишком большая',
  stale: 'правка устарела — её уже переписали после восстановления базы',
  // круг 39 (N2): раскрытие экземпляров вышло бы за предел ядра
  expand_nodes: 'слишком много вложенных экземпляров',
});

/**
 * Круг 39 (N1): версия движка у сервера другая. Сервер новее — вышла новая версия редактора,
 * её даёт перезагрузка; сервер старее (обновляется позже клиента) — перезагрузка не поможет
 * сразу, правки ждут в очереди вкладки. Версия сервера неизвестна (426 без неё) — считаем,
 * что новее: так отвечает обновлённый сервер старому клиенту.
 * @param {number|null|undefined} serverEngine
 * @param {number} ownEngine
 * @returns {{status: string, title: string, note: string, newer: boolean}}
 */
export function engineWords(serverEngine, ownEngine) {
  const older = isNum(serverEngine) && isNum(ownEngine) && serverEngine < ownEngine;
  if (older) {
    return {
      newer: false,
      status: 'сервер ещё на прежней версии — правки ждут',
      title: 'Сервер ещё не обновился — правки ждут во вкладке',
      // круг 41: обновлять страницу не нужно — реплика сама перепроверяет сервер и отправит правки
      // круг 43: «команды агента подождут» было неправдой — команды не ставятся в очередь, а не отправляются
      note: 'Редактор новее сервера документов. Правки ждут в этой вкладке и уйдут сами, как только сервер обновят, — перезагружать страницу не нужно. Команды агента до тех пор не выполняются: текст остаётся в строке.',
    };
  }
  return {
    newer: true,
    status: 'вышла новая версия редактора — обновите страницу',
    title: 'Вышла новая версия редактора — обновите страницу',
    note: 'Сервер принимает правки только от новой версии. Правки этой вкладки ждут в очереди и уйдут после обновления.',
  };
}

/* ------------------------------ строки (SPEC §9.10) ------------------------------ */

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_G = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Строка годна серверу: без U+0000 и одиночных суррогатных половин. */
function isCleanText(v) {
  if (typeof v !== 'string') return false;
  if (v.indexOf('\u0000') >= 0) return false;
  return typeof v.isWellFormed === 'function' ? v.isWellFormed() : !LONE.test(v);
}
/** U+0000 — вон, одиночная половина — U+FFFD (как делает сервер; так прогноз совпадает с ответом). */
export function cleanText(v) {
  if (typeof v !== 'string' || isCleanText(v)) return v;
  const s = v.replace(/\u0000/g, '');
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(LONE_G, '\ufffd');
}
/** Строки и ключи значения целиком; копия — только там, где есть что чистить. */
function cleanDeep(v, depth = 0) {
  if (typeof v === 'string') return cleanText(v);
  if (!v || typeof v !== 'object' || depth > VALUE_DEPTH) return v;
  if (Array.isArray(v)) {
    let out = null;
    for (let i = 0; i < v.length; i++) {
      const y = cleanDeep(v[i], depth + 1);
      if (y !== v[i]) { if (!out) out = v.slice(); out[i] = y; }
    }
    return out || v;
  }
  let out = null;
  for (const k of Object.keys(v)) {
    const y = cleanDeep(v[k], depth + 1);
    const k2 = cleanText(k);
    if (y !== v[k] || k2 !== k) {
      if (!out) out = { ...v };
      if (k2 !== k) delete out[k];
      out[k2] = y;
    }
  }
  return out || v;
}

/** Склонение: 1 правка, 2 правки, 5 правок. */
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/**
 * `dropped` одной строкой для человека: «3 правки не применились: узел уже удалён».
 * Запись `{more: N}` (сервер хранит не больше 50 записей и остаток числом, SPEC §9.8)
 * в перечень причин не входит, но N прибавляется к счёту.
 * @param {object[]} dropped
 * @returns {string}
 */
export function droppedLine(dropped) {
  const list = Array.isArray(dropped) ? dropped : [];
  let n = 0;
  const why = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.more === 'number' && d.index === undefined && d.reason === undefined) { n += Math.max(0, d.more); continue; }
    n += 1;
    const word = DROP_WORDS[d.limit] || DROP_WORDS[d.reason] || DROP_WORDS.invalid;
    if (!why.includes(word)) why.push(word);
  }
  const head = `${n} ${plural(n, 'правка не применилась', 'правки не применились', 'правок не применились')}`;
  return why.length ? `${head}: ${why.join(', ')}` : head;
}

/** Слова статуса «хранилище сервера недоступно» (J4) — одни для всех вкладок. */
export const STORAGE_DOWN_LABEL = 'сервер не может сохранить — правки ждут';

/**
 * Статус реплики одной строкой (SPEC §9.5): «в сети · всё сохранено» /
 * «не в сети · N правок ждут» / «синхронизация…» / «сервер не может сохранить — правки
 * ждут» (круг 29, J4: хранилище сервера лежит — и при открытом сокете, и при закрытом).
 * @param {{online:boolean, pending:number, syncing:boolean, error?:string|null, storage?:string}} s
 */
export function statusLine(s) {
  if (!s) return '';
  if (s.error === 'engine') {
    const w = engineWords(s.engine, s.ownEngine);
    // сервер старее, а ждать нечему — без «правки ждут» (круг 41)
    return !w.newer && !s.pending ? 'сервер ещё на прежней версии редактора' : w.status;
  }
  if (s.error === 'not_found') return 'проект не найден на сервере';
  if (s.storage === 'down') return s.pending ? STORAGE_DOWN_LABEL : 'сервер не может сохранить';
  if (!s.online) {
    const n = s.pending || 0;
    const wait = n ? ` · ${n} ${plural(n, 'правка ждёт', 'правки ждут', 'правок ждут')}` : '';
    // круг 39 (N6а): первое подключение ещё идёт — это не «не в сети»
    if (s.connecting) return `подключаюсь к проекту…${wait}`;
    return `не в сети${wait}`;
  }
  if (s.syncing) return 'синхронизация…';
  return 'в сети · всё сохранено';
}

/** Пауза с разбросом: половина — фиксированная, половина — случайная (вкладки не бьют в такт). */
function jitter(ms) {
  return Math.round(ms * (0.5 + Math.random() * 0.5));
}

/** Retry-After из ответа (заголовок или поле тела), с; нет — null. */
function retryAfterOf(res, body) {
  let v = null;
  try { v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch { v = null; }
  if (v == null && body && typeof body === 'object') v = body.retry_after;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, RETRY_AFTER_MAX) : null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Ответ сервера говорит, что лежит хранилище (J4): `unavailable` с `detail.cause`
 * 'storage' (или 'timeout' — база не уложилась в дедлайн), либо health
 * `detail.storage: 'down'`. Прочие 503 (busy, migrating) — не про это.
 */
function storageFailure(body) {
  if (!body || typeof body !== 'object') return false;
  const d = body.detail && typeof body.detail === 'object' ? body.detail : null;
  // круг 31 (DOC): 'schema' — схема базы догоняется после восстановления из копии: писать тоже нельзя
  if (d && (d.storage === 'down' || d.storage === 'schema')) return true;
  return String(body.code || '') === 'unavailable' && !!d && (d.cause === 'storage' || d.cause === 'timeout' || d.cause === 'schema');
}
/** busy/queued присутствия (§9.9): булево или число. */
const isFlag = (v) => typeof v === 'boolean' || isNum(v);

/** Глубокая копия JSON-совместимых данных: операции и документ наружу и внутрь не делим. */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * Надгробия в форме для журнала и обратно: Map не переживает JSON. Круг 29: тройки
 * `[id, parent, seq]` — номер удаления нужен прореживанию; пары прежнего журнала
 * читаются, номер у них — `atSeq` (номер документа записи).
 */
function tombToList(map, seqs) {
  const out = [];
  for (const [id, parent] of map) {
    const s = seqs ? seqs.get(id) : undefined;
    out.push(isNum(s) ? [id, parent === undefined ? null : parent, s] : [id, parent === undefined ? null : parent]);
  }
  return out;
}
/** → {parents: Map, seq: Map} в порядке удаления (по номеру; равные — как на входе). */
function tombFromList(list, atSeq = 0, seqObj = null) {
  const rows = [];
  const at = isNum(atSeq) ? atSeq : 0;
  const seqOf = (id, v) => {
    const x = v !== undefined ? v : seqObj && Object.prototype.hasOwnProperty.call(seqObj, id) ? seqObj[id] : undefined;
    return Number.isSafeInteger(x) && x >= 0 ? x : at;
  };
  if (Array.isArray(list)) {
    for (const pair of list) if (Array.isArray(pair) && pair[0]) rows.push([String(pair[0]), pair[1] == null ? null : String(pair[1]), seqOf(String(pair[0]), pair[2])]);
  } else if (list && typeof list === 'object') {
    // снимок сервера (§9.10): объект id → родитель
    for (const [id, p] of Object.entries(list)) rows.push([id, p == null ? null : String(p), seqOf(id, undefined)]);
  }
  let sorted = true;
  for (let k = 1; k < rows.length && sorted; k++) if (rows[k][2] < rows[k - 1][2]) sorted = false;
  if (!sorted) rows.sort((a, b) => a[2] - b[2]);   // sort устойчив: равные — как на входе
  const parents = new Map();
  const seq = new Map();
  for (const [id, p, n] of rows) {
    if (parents.has(id)) { parents.delete(id); seq.delete(id); }
    parents.set(id, p);
    seq.set(id, n);
  }
  return { parents, seq };
}

/**
 * Надгробия view = ожидающие поверх подтверждённых (круг 29): своё — удалённое ожидающими,
 * остальное читается из словаря подтверждённых без копии. Раньше переигрывание копировало
 * словарь подтверждённых целиком на каждый кадр (`new Map(tomb)`). Наследник Map — движок
 * (`core.rebase`) берёт Map как есть и спрашивает только has/get.
 */
class TombOverlay extends Map {
  constructor(base) {
    super();
    this.base = base;
  }
  has(k) { return super.has(k) || this.base.has(k); }
  get(k) { return super.has(k) ? super.get(k) : this.base.get(k); }
  get size() {
    let n = this.base.size;
    for (const k of super.keys()) if (!this.base.has(k)) n += 1;
    return n;
  }
  *entries() {
    for (const e of super.entries()) yield e;
    for (const e of this.base.entries()) if (!super.has(e[0])) yield e;
  }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(fn, thisArg) { for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this); }
}

/**
 * Надгробия снимка сервера (круг 27, I1) → Map или null («неизвестно»):
 *   v2 `{v:2, parents:{id:parent}, seq:{id:seq}}` — родители (номера удаления клиенту не нужны:
 *      прореживает сервер, а свежий снимок приносит уже прореженные);
 *   v1 — плоский объект `{id: parent}`; массив пар — формат локального журнала;
 *   null/нет поля — снимок записан экземпляром прежней версии: каких узлов нет, неизвестно —
 *      своих надгробий вслепую не сбрасывать.
 * Нормализатор движка (`core.normalizeTombstones`), если он есть, — первым: формат его.
 */
function snapshotTombs(core, x, atSeq) {
  if (x == null) return null;
  if (Array.isArray(x)) return tombFromList(x, atSeq);
  if (typeof x !== 'object') return null;
  if (typeof core.normalizeTombstones === 'function') {
    try {
      const n = core.normalizeTombstones(x, { seq: atSeq });
      // null у движка — «формат неизвестен» (чужая версия v): как null снимка
      return n && n.parents && typeof n.parents === 'object' ? tombFromList(n.parents, atSeq, n.seq && typeof n.seq === 'object' ? n.seq : null) : null;
    } catch { /* разберём сами */ }
  }
  if (typeof x.v === 'number' && x.v !== 2) return null;
  if (x.v === 2 || (x.parents && typeof x.parents === 'object' && !Array.isArray(x.parents))) {
    const seqObj = x.seq && typeof x.seq === 'object' && !Array.isArray(x.seq) ? x.seq : null;
    return x.parents && typeof x.parents === 'object' && !Array.isArray(x.parents) ? tombFromList(x.parents, atSeq, seqObj) : null;
  }
  return tombFromList(x, atSeq);
}

/** Есть ли в операциях remove (после него надгробия меняются — граница пачки переигрывания). */
function hasRemove(list) {
  if (!Array.isArray(list)) return false;
  for (const op of list) if (op && op.op === 'remove') return true;
  return false;
}

/** Строка JSON с ключами по порядку — сравнить два узла независимо от порядка полей. */
function stableStr(v) {
  // как stableJSON движка (hashDoc): undefined — null, поля со значением undefined — нет
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
}

/**
 * Тот же документ, что по hashDoc (root, nodes, tokens), но без хэширования целиком:
 * узлы, не тронутые правками, — те же объекты (черновики движка делят их), сравниваются
 * ссылкой; содержимое — только у разных объектов. 19 500 узлов — единицы мс вместо 150.
 */
function sameDoc(a, b) {
  if (a === b) return true;
  if (!a || !b || !a.nodes || !b.nodes) return false;
  if (a.root !== b.root) return false;
  if (a.tokens !== b.tokens && stableStr(a.tokens) !== stableStr(b.tokens)) return false;
  const ka = Object.keys(a.nodes);
  if (ka.length !== Object.keys(b.nodes).length) return false;
  for (const k of ka) {
    const x = a.nodes[k];
    if (!Object.prototype.hasOwnProperty.call(b.nodes, k)) return false;
    const y = b.nodes[k];
    if (x !== y && stableStr(x) !== stableStr(y)) return false;
  }
  return true;
}

/**
 * Сведения подтверждения для onChange. `same` («view не изменился») — ленивое и
 * запоминаемое (круг 28): предсказанная форма — `true` сразу; иначе структурное
 * сравнение `sameDoc` считается при первом чтении поля, а не на каждом подтверждении.
 * Документы неизменяемы (черновики движка запечатаны), поэтому отложенное сравнение
 * видит те же prev/cur, что в момент подтверждения.
 */
function confirmedInfo(tx, inverse, fast, prev, cur) {
  const info = { reason: 'confirmed', tx, inverse };
  if (fast) { info.same = true; return info; }
  let same;
  Object.defineProperty(info, 'same', {
    enumerable: true,
    configurable: true,
    get() {
      if (same === undefined) same = sameDoc(prev, cur);
      return same;
    },
  });
  return info;
}

/** Сколько операций отброшено: запись `{more: N}` прибавляет N. */
function droppedCount(list) {
  let n = 0;
  if (Array.isArray(list)) for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    n += typeof d.more === 'number' && d.index === undefined && d.reason === undefined ? Math.max(0, d.more) : 1;
  }
  return n;
}
/** Пути пересекаются по сегментам: `layout` и `layout.gap`. */
const pathsMeet = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');

/* ------------------------------ хранилища ------------------------------ */

/**
 * Локальный журнал в IndexedDB — для браузера. База `imago`, хранилище `projects`,
 * ключ — id проекта. Все методы возвращают промисы; ошибки (приватный режим,
 * переполнение) наружу не летят дальше промиса — реплика без журнала продолжает
 * работать, просто не переживёт перезагрузку.
 * @param {{name?: string, store?: string, indexedDB?: IDBFactory}} [opts]
 */
export function idbStorage(opts = {}) {
  const name = opts.name || 'imago';
  const store = opts.store || 'projects';
  const factory = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  let dbp = null;
  const openDb = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('IndexedDB недоступна')); return; }
      let req;
      try { req = factory.open(name, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB не открылась'));
      req.onblocked = () => reject(new Error('IndexedDB занята другой вкладкой'));
    });
    // не открылась — следующий вызов попробует снова, а не получит тот же отказ навсегда
    dbp.catch(() => { dbp = null; });
    return dbp;
  };
  const run = (mode, fn) => openDb().then((db) => new Promise((resolve, reject) => {
    let req = null;
    let tx;
    try {
      tx = db.transaction(store, mode);
      req = fn(tx.objectStore(store));
    } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('запись в IndexedDB не прошла'));
    tx.onabort = () => reject(tx.error || new Error('запись в IndexedDB прервана'));
  }));
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    /** Несколько записей одной транзакцией IndexedDB: либо все, либо ни одной. */
    setMany: (entries) => run('readwrite', (s) => { let last = null; for (const [k, v] of entries) last = s.put(v, k); return last; }),
    remove: (key) => run('readwrite', (s) => s.delete(key)),
    keys: () => run('readonly', (s) => s.getAllKeys()),
  };
}

/** Журнал в памяти — для тестов и как запасной вариант, когда IndexedDB нет. */
export function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? clone(map.get(key)) : null),
    set: async (key, value) => { map.set(key, clone(value)); },
    setMany: async (entries) => { const copies = entries.map(([k, v]) => [k, clone(v)]); for (const [k, v] of copies) map.set(k, v); },
    remove: async (key) => { map.delete(key); },
    keys: async () => [...map.keys()],
  };
}

/* -------------------------------- реплика -------------------------------- */

/**
 * @param {object} o
 * @param {object} o.core           модуль движка (`import * as CORE from './core.js'`)
 * @param {string} [o.baseUrl]      корень API; '' — тот же origin (`/api`, `/ws`)
 * @param {string} o.projectId
 * @param {string} o.clientId       id вкладки-браузера: по нему свои транзакции отличаются в рассылке
 * @param {string} [o.author]       отображаемое имя
 * @param {object} [o.storage]      адаптер журнала (idbStorage / memoryStorage)
 * @param {Function} [o.WebSocketImpl]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.onChange]   (view, info) — view изменился не по своему commit: open · confirmed · remote · gone · error · ack
 * @param {Function} [o.onStatus]   ({online, pending, syncing, error, head, storage: 'up'|'down', label})
 * @param {Function} [o.onDropped]  (committed + {label, by}) — сервер отбросил часть операций своей транзакции;
 *                                  у каждой записи dropped — `by` (кто помешал, если узнаётся) и `label` (подпись правки)
 * @param {Function} [o.onJournal]  (list) — журнал подтверждённых изменился (как replica.journal())
 * @param {Function} [o.onPresence] (list) — кто в сети с их выделениями
 * @param {Function} [o.onGone]     (snapshot) — база ушла за хвост: пришёл снимок
 * @param {Function} [o.onProject]  ({id, name, kind, head_seq, updated_at}) — сводка проекта: из hello и рассылки
 *                                  `project` (переименование на любом экземпляре, круг 27 I4)
 * @param {number} [o.notFoundRetryMs] проекта нет на сервере (I3): следующая попытка через столько…2× мс (30000)
 * @param {Function} [o.onError]    ({code, message, tx?}) — code: engine · not-found · diverged · too_large ·
 *                                  not_saved (правку раз за разом не записать — снята с очереди) · replay_expired ·
 *                                  replay_incomplete (после отката базы не всё своё переиграно) · коды сервера
 * @param {Function} [o.extra]      () => object — что оболочка кладёт в журнал рядом с документом
 * @param {number} [o.reconnectMin] пауза перед первым переподключением, мс (1000)
 * @param {number} [o.reconnectMax] потолок паузы, мс (30000)
 * @param {number} [o.epochReopenMs] переоткрытие после 4410 (смена эпохи) — через столько мс с разбросом вниз до половины (250)
 * @param {number} [o.idleHealthMs] пока проект открыт и правок нет — /api/health раз в столько мс с разбросом
 *                                  (12000; 0 — не спрашивать): база могла лечь в простое, а статус — «всё сохранено»
 * @param {number} [o.firstConnectMs] первое подключение сокета: пока оно идёт (до hello, первой неудачи или
 *                                  этого срока, 6000 мс), статус несёт `connecting: true` — «подключаюсь к проекту…»
 */
export function createSync(o) {
  const core = o.core;
  if (!core || typeof core.rebase !== 'function' || typeof core.applyOps !== 'function') {
    throw new Error('createSync: нужен модуль движка с rebase и applyOps');
  }
  const projectId = String(o.projectId || '');
  const clientId = String(o.clientId || core.uid('c'));
  let author = String(o.author || '');
  const storage = o.storage || null;
  const WS = o.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const baseUrl = String(o.baseUrl || '').replace(/\/+$/, '');
  const reconnectMin = isNum(o.reconnectMin) ? o.reconnectMin : 1000;
  const reconnectMax = isNum(o.reconnectMax) ? o.reconnectMax : 30000;
  const epochReopenMs = isNum(o.epochReopenMs) ? o.epochReopenMs : EPOCH_REOPEN_MS;
  const idleHealthMs = isNum(o.idleHealthMs) ? o.idleHealthMs : IDLE_HEALTH_MS;
  const firstConnectMs = isNum(o.firstConnectMs) && o.firstConnectMs > 0 ? o.firstConnectMs : FIRST_CONNECT_MS;
  const engineRecheckMs = isNum(o.engineRecheckMs) && o.engineRecheckMs > 0 ? o.engineRecheckMs : ENGINE_RECHECK_MS;
  const heartbeatMs = isNum(o.presenceHeartbeatMs) ? o.presenceHeartbeatMs : LIMITS.presenceHeartbeatMs;
  const presenceTtl = isNum(o.presenceTtl) ? o.presenceTtl : PRESENCE_TTL;
  // прореживание надгробий (круг 29): числа сервера; опции — для тестов и для сервиса с другими
  const tombKeepSeq = isNum(o.tombKeepSeq) && o.tombKeepSeq >= 0 ? o.tombKeepSeq : LIMITS.tombKeepSeq;
  const tombPruneEvery = isNum(o.tombPruneEvery) && o.tombPruneEvery >= 1 ? o.tombPruneEvery : LIMITS.tombPruneEvery;
  const tombMax = isNum(o.tombMax) && o.tombMax >= 0 ? o.tombMax : LIMITS.tombMax;
  const setT = (fn, ms) => {
    const id = setTimeout(fn, ms);
    // в Node таймер держит процесс: тесты не должны ждать паузу переподключения
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  };

  /* ---- состояние ---- */
  let confirmed = { seq: 0, doc: null };
  let tomb = new Map();        // надгробия подтверждённых: id удалённого → последний родитель (порядок — порядок удаления)
  let tombSeq = new Map();     // …и номер транзакции, которая удалила (прореживание, круг 29)
  let pending = [];            // Tx[] в порядке отправки
  let view = null;
  let viewTomb = new TombOverlay(tomb); // ожидающие поверх подтверждённых (для прогноза следующей правки)
  let extraLoaded = undefined; // что лежало в журнале рядом с документом

  let socket = null;
  let online = false;
  let closed = false;
  let opened = false;
  let helloHead = -1;          // голова по последнему hello: пока не догнали — «синхронизация…»
  /* Круг 33, п.3: голова сервера на момент открытия (снимок с сервера или первый hello).
     Всё до неё — догоняющая загрузка: история, а не новости. Оболочка рисует документ, но
     тостов «Аня отменила правку» новичку не показывает (`info.backlog` в onChange). */
  let openHead = -1;
  let firstHello = true;
  let ready = false;           // hello получен: сервер до него ничего не принимает (Hub), и «в сети» — только с него
  /* Круг 39 (N6а): до первого hello и до первой неудачной попытки сокета — «подключаюсь к
     проекту…», а не «не в сети»/«сервер недоступен»: открытие проекта не краснеет. Попытка
     провалилась (сокет закрылся без hello, сеть пропала) или первое подключение дольше
     FIRST_CONNECT_MS — дальше обычные слова. */
  let everReady = false;
  let connectFailed = false;
  let connectGrace = null;
  let serverEngine = null;     // версия движка сервера из hello (для слов об отказе по версии)
  let engineTimer = null;      // круг 41: перепроверка «сервер обновился?» (/api/health), пока он старее
  let staleOpen = false;       // открытие отказано 503 engine (снимок не отдан) — повтор открытия
  let engineSaid = '';         // о каком отказе по версии уже сказали оболочке (один раз на состояние)
  let helloTimer = null;
  let openRetry = null;        // ожидание повтора в open() без сервера — reconnect() будит его раньше срока
  let inflight = null;         // tx_id отправленной и ещё не подтверждённой транзакции
  let inflightTimer = null;
  let inflightRetries = 0;
  let attempt = 0;             // неудачных подключений подряд — для паузы
  let reconnectTimer = null;
  let halted = false;          // сервер отверг версию движка: слать дальше бессмысленно
  let error = null;            // 'engine' | 'unreachable' | 'not-found' | 'diverged' | null

  let tip = null;              // chain подтверждённой головы (SPEC §9.8); null — сервер его не дал
  let epoch = null;            // эпоха журнала, в которой получено confirmed
  let epochMoved = false;      // hello принёс другую эпоху — снимок, который придёт следом, требует переиграть mine
  let mine = [];               // свои подтверждённые: [{tx, seq, epoch, at, bytes}] — переигрываются после отката базы
  let mineEvicted = [];        // вытесненные из окна mine: [{epoch, seq}] — сказать, что их уже не переиграть
  let unsaved = [];            // снятые «не сохранено»: [{tx, cause, message, at}]
  let poison = null;           // {tx_id, code, n}: одинаковые повторяемые ошибки подряд на одну транзакцию
  let probing = false;         // идёт проверка «сервер жив?» перед тем, как снять транзакцию
  let lastRemoved = [];        // надгробия последней применённой транзакции сервера (для журнала)
  let journalList = [];        // подтверждённые по возрастанию seq: [{pub, created, leaves, removed}]
  const removedBy = new Map(); // id удалённого узла → запись журнала (самая новая)
  let journalNotify = false;
  let serverWait = 0;          // сервер попросил подождать (Retry-After), мс — пауза переподключения не меньше
  let resendTimer = null;      // повтор отправки после повторяемой ошибки

  let catchingUp = false;      // идёт GET …/ops: живые транзакции копим в буфер
  let buffer = [];
  let heldAcks = [];           // ack, пришедшие во время догона: confirmed ещё не окончательный — разобрать после
  let notFound = false;        // проекта нет на сервере (I3): очередь цела, переподключение редкое
  let storageDown = false;     // J4: хранилище сервера недоступно — правки ждут (снимается записью или health)
  let storageTries = 0;        // повторов отправки подряд при лежащем хранилище — для паузы
  let healthTimer = null;      // следующая проверка /api/health, пока хранилище лежит
  let healthTries = 0;
  let healthBusy = false;
  let idleHealthTimer = null;
  let presenceHolding = false; // круг 33: разбираем presence_batch — уведомить оболочку один раз в конце
  let presenceHold = 0;  // круг 33, п.4: проверка хранилища в простое (без правок отказа не увидеть)
  let historyLoaded = false;   // J3: «История» с сервера взята (после открытия; после снимка — снова)
  let historyReq = 0;          // номер последнего запроса истории: ответ на прежний не берётся
  let journalEra = 0;          // журнал очищен (эпоха сменилась) — ответы, запрошенные до, не берутся
  const notFoundRetry = isNum(o.notFoundRetryMs) ? o.notFoundRetryMs : NOT_FOUND_RETRY;

  /* Прогноз (круг 27): применённая форма каждой ожидающей, как её посчитало последнее
     переигрывание поверх confirmed с номером plan.seq. Сервер подтвердил pending[0] ровно
     в этой форме и чужих между не было — view уже верен, переигрывать нечего. */
  let plan = null;             // {seq, doc, ops: (object[]|null)[]} — ops[k] для pending[k]
  let lastDiverged = false;    // последняя транзакция сервера не легла строго (страховочное слияние)

  let writeTimer = null;
  let dirty = false;
  let writing = null;
  /* Журнал в двух записях (круг 27): `<id>` — очередь, mine, extra и хвост подтверждённых
     сверх записанного документа (пишется через 200 мс после изменения); `<id>#doc` —
     подтверждённый документ с надгробиями (не чаще DOC_WRITE_GAP, при смене основы — сразу). */
  let gen = '';                // поколение основы: меняется, когда confirmed заменён снимком
  let docDirty = false;        // документ в журнале отстал от confirmed
  let docUrgent = false;       // …и ждать нельзя (основа сменилась, хвост велик)
  let docWrittenAt = 0;
  let docTimer = null;
  let idleHandle = null;
  let issuedBase = null;       // {gen, seq} — последняя отправленная запись документа
  let savedBase = null;        // {gen, seq} — последняя записанная (успешно)
  let tailLog = [];            // [{seq, ops, chain}] подтверждённые сверх savedBase (того же gen)
  let tailBytes = 0;

  // последнее своё присутствие: уходит при подключении (так о нас узнают остальные) и при
  // смене имени; пустое выделение — тоже присутствие
  let presenceLast = { selection: [], board: null };
  let presenceTimer = null;
  let heartbeatTimer = null;   // сердцебиение присутствия (и уборка протухших чужих)
  let presenceSentAt = 0;
  let presenceSentKey = '';    // что ушло последним: то же самое второй раз не шлём
  const others = new Map();    // client → {client, author, selection, board, at}

  let lastStatus = '';

  /* ---- служебное ---- */

  const call = (fn, ...args) => {
    // закрытая реплика молчит: оболочка уже открыла другой проект, и её колбэки — про него
    if (closed || typeof fn !== 'function') return;
    try { fn(...args); } catch (e) { report('callback', e); }
  };
  function report(where, e) {
    // ошибки подписчиков и транспорта — в консоль, но не наружу: реплика важнее одного колбэка
    try { console.error(`[sync:${where}]`, e); } catch { /* консоли нет */ }
  }

  function status() {
    return {
      online,
      pending: pending.length,
      syncing: online && !halted && (catchingUp || pending.length > 0 || confirmed.seq < helloHead),
      ...(!online && !closed && !halted && !error && !notFound && !storageDown && !everReady && !connectFailed ? { connecting: true } : {}),
      ...(error === 'engine' ? { engine: serverEngine, ownEngine: core.ENGINE_VERSION } : {}),
      error,
      head: confirmed.seq,
      storage: storageDown ? 'down' : 'up',
    };
  }
  function statusFull() {
    const s = status();
    return { ...s, label: statusLine(s) };
  }
  /* ---- версия движка (N1, круг 41) ---- */

  /** Сервер ещё на прежней версии (старее клиента): правки ждут, а не «обновите страницу». */
  function olderServer() {
    return halted && error === 'engine' && isNum(serverEngine) && serverEngine < core.ENGINE_VERSION;
  }

  /**
   * Отказ по версии: 426 / hello с другим движком / 503 `cause:'engine'` (проект записан
   * движком новее этого экземпляра). Очередь стоит; сервер старее — перепроверяем его версию,
   * клиент старее — поможет только перезагрузка. Оболочке — один раз на состояние.
   * @param {number|null} se версия, с которой сравнивать свою: сервера, а для «устаревшего»
   *   проекта — найденная в журнале, если она новее нашей
   */
  function markEngine(se) {
    halted = true;
    error = 'engine';
    if (isNum(se)) serverEngine = se;
    const key = String(serverEngine);
    if (engineSaid !== key) {
      engineSaid = key;
      call(o.onError, { code: 'engine', message: engineWords(serverEngine, core.ENGINE_VERSION).status, engine: serverEngine });
    }
    armEngineCheck();
    emitStatus();
  }

  /** Тело 503 «проект записан более новой версией» → версия для сравнения (см. markEngine). */
  function staleEngineOf(body) {
    const d = body && typeof body === 'object' && body.detail && typeof body.detail === 'object' ? body.detail : null;
    if (!d || d.cause !== 'engine' || String(body.code || 'unavailable') !== 'unavailable') return undefined;
    // проект записан движком новее нас — устарели мы; иначе устарел экземпляр
    if (isNum(d.found) && d.found > core.ENGINE_VERSION) return d.found;
    if (isNum(d.engine)) return Math.min(d.engine, core.ENGINE_VERSION - 1);
    return core.ENGINE_VERSION - 1;
  }

  /** Сервер обновился (hello/health с нашим движком): очередь снова уходит. */
  function engineCaughtUp() {
    if (!halted || error !== 'engine') return false;
    halted = false;
    error = null;
    serverEngine = null;
    engineSaid = '';
    if (engineTimer) { clearTimeout(engineTimer); engineTimer = null; }
    return true;
  }

  function armEngineCheck() {
    if (closed || engineTimer || !olderServer() || !fetchImpl) return;
    engineTimer = setT(async () => {
      engineTimer = null;
      if (closed || !olderServer()) return;
      let r = null;
      try { r = await httpOnce('/api/health'); } catch { r = null; }
      const eng = r && r.body && isNum(r.body.engine) ? r.body.engine : null;
      if (eng === core.ENGINE_VERSION && olderServer()) {
        /* экземпляр обновился: сокет прежнего — закрыть и подключиться заново (hello решит);
           без сокета — разбудить открытие */
        attempt = 0;
        if (openRetry) { const wake = openRetry; openRetry = null; wake(); }
        const ws = socket;
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) { try { ws.close(); } catch { /* уже закрыт */ } }
        else if (opened && view) connect();
      }
      armEngineCheck();
    }, jitter(engineRecheckMs));
  }

  function emitStatus() {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastStatus) return;
    lastStatus = key;
    call(o.onStatus, statusFull());
  }

  /* ---- надгробия подтверждённых (круг 29) ---- */

  /** Надгробие с номером удаления; повторное удаление того же id — в конец (порядок = порядок удаления). */
  function addTomb(id, parent, seq) {
    if (tomb.has(id)) { tomb.delete(id); tombSeq.delete(id); }
    tomb.set(id, parent);
    tombSeq.set(id, isNum(seq) ? seq : confirmed.seq);
  }

  /**
   * Прореживание тем же правилом, что голова сервера (dslts pruneTombs): граница — номер
   * головы, кратный tombPruneEvery, минус tombKeepSeq; сверх tombMax — самые старые.
   * Только по номерам: реплика и сервер на одном seq знают одно и то же (прогноз
   * `reparented`/`orphan` совпадает). Снимает с начала — амортизированно O(1) на кадр.
   */
  function pruneTomb(headSeq = confirmed.seq) {
    if (!tombSeq.size) return;
    const bound = Math.floor(headSeq / tombPruneEvery) * tombPruneEvery - tombKeepSeq;
    for (const [id, seq] of tombSeq) {
      if (seq >= bound && tombSeq.size <= tombMax) break;
      tombSeq.delete(id);
      tomb.delete(id);
    }
  }

  /** Надгробия снимка/журнала вместо своих. */
  function setTombs(t) {
    tomb = t.parents;
    tombSeq = t.seq;
    // id без номера (не должно быть, но журнал мог прийти чужой) — номер документа
    if (tombSeq.size !== tomb.size) for (const id of tomb.keys()) if (!tombSeq.has(id)) tombSeq.set(id, confirmed.seq);
  }

  /**
   * Надгробия пачки подтверждённых (applyBatches отдаёт их подряд за все пачки): номер
   * удаления — по корню (id операции remove) каждой транзакции, потомки идут за корнем.
   * Как absorbPage сервера.
   */
  function addTombsOf(list, tombstones) {
    if (!tombstones.length) return;
    const roots = list.map((e) => {
      let set = null;
      for (const op of e.ops || []) if (op && op.op === 'remove' && typeof op.id === 'string') (set || (set = new Set())).add(op.id);
      return set;
    });
    let k = 0;
    for (const [id, parent] of tombstones) {
      for (let j = k; j < list.length; j++) if (roots[j] && roots[j].has(id)) { k = j; break; }
      addTomb(id, parent, list[k].seq);
    }
  }

  /* ---- переигрывание: view = replay(confirmed.doc, pending) ---- */

  /**
   * Пачки одним черновиком: `core.applyBatches` (одна копия словаря узлов на все пачки),
   * у прежнего движка — поштучно applyOps + collectTombstones. Выход как у applyBatches.
   */
  function applyRun(doc, batches) {
    if (typeof core.applyBatches === 'function') return core.applyBatches(doc, batches);
    const tombstones = [];
    const results = [];
    let cur = doc;
    for (const list of batches) {
      for (const pair of core.collectTombstones(cur, list)) tombstones.push(pair);
      const res = core.applyOps(cur, list);
      if (res.error) results.push({ error: res.error });
      else { cur = res.doc; results.push(null); }
    }
    return { doc: cur, tombstones, results };
  }

  /**
   * Группа ожидающих одним rebase и одним черновиком: операции группы подряд — тот же
   * результат, что поштучно, пока надгробия между транзакциями не меняются, т.е. до первой
   * транзакции с remove включительно (её надгробия нужны только следующим). Применённая
   * форма раскладывается обратно по транзакциям по индексам dropped. Что-то не сошлось —
   * поштучно (как раньше).
   * @returns {{doc: object, ops: (object[]|null)[]}}
   */
  function replayGroup(doc, group, t) {
    if (group.length > 1) {
      const all = [];
      const owner = [];
      group.forEach((tx, k) => { for (const op of tx.ops) { all.push(op); owner.push(k); } });
      const m = core.rebase(doc, all, { tombstones: t });
      const gone = new Set();
      for (const d of m.dropped) if (d && isNum(d.index)) gone.add(d.index);
      const per = group.map(() => []);
      let q = 0;
      for (let x = 0; x < all.length; x++) if (!gone.has(x)) per[owner[x]].push(m.ops[q++]);
      if (q === m.ops.length && all.length - gone.size === m.ops.length) {
        const r = applyRun(doc, per);
        if (r.results.every((e) => !e)) {
          for (const [id, p] of r.tombstones) t.set(id, p);
          return { doc: r.doc, ops: per };
        }
      }
    }
    const out = [];
    for (const tx of group) {
      const m = core.rebase(doc, tx.ops, { tombstones: t });
      const r = applyRun(doc, [m.ops]);
      for (const [id, p] of r.tombstones) t.set(id, p);
      if (r.results[0]) { report('replay', r.results[0].error); out.push(null); }
      else { doc = r.doc; out.push(m.ops); }
    }
    return { doc, ops: out };
  }

  /**
   * view = replay(confirmed.doc, pending). Круг 27: группами одним черновиком — 200
   * ожидающих на 19 000 узлах стоили 3,7 с на каждую входящую чужую транзакцию.
   */
  function replayAll() {
    // круг 29: не копия словаря подтверждённых (десятки тысяч надгробий на каждый кадр), а наложение
    const t = new TombOverlay(tomb);
    let doc = confirmed.doc;
    const ops = [];
    let i = 0;
    while (i < pending.length) {
      let end = i;
      while (end < pending.length && !hasRemove(pending[end].ops)) end++;
      end = Math.min(end + 1, pending.length);
      const r = replayGroup(doc, pending.slice(i, end), t);
      doc = r.doc;
      for (const x of r.ops) ops.push(x);
      i = end;
    }
    view = doc;
    viewTomb = t;
    plan = { seq: confirmed.seq, doc: confirmed.doc, ops };
  }

  /** Прогноз верен для pending[0], и сервер применил её ровно так: view переигрывать не нужно. */
  function predicted(c) {
    if (!plan || plan.doc !== confirmed.doc || plan.seq !== confirmed.seq || c.seq !== confirmed.seq + 1) return false;
    if (plan.ops.length !== pending.length || !pending.length || pending[0].tx_id !== c.tx_id || !plan.ops[0]) return false;
    try { return JSON.stringify(plan.ops[0]) === JSON.stringify(Array.isArray(c.ops) ? c.ops : []); } catch { return false; }
  }

  /** Применённая транзакция сервера — к confirmed. Журнал хранит применённую форму, строгое применение обязано пройти. */
  function applyConfirmed(c) {
    const before = confirmed.doc;
    // круг 48: запись прежнего движка — через liftOps (как на сервере)
    const raw = Array.isArray(c.ops) ? c.ops : [];
    const list = typeof core.liftOps === 'function' ? core.liftOps(raw, c.engine) : raw;
    const run = applyRun(before, [list]);
    let next = run.doc;
    let removed = run.tombstones;
    lastDiverged = !!run.results[0];
    if (run.results[0]) {
      /* Не прошло — движки разошлись (версия, формат). Страховка: слить как чужую базу,
         чтобы не отстать от сервера навсегда; о расхождении — наружу. */
      report('apply', run.results[0].error);
      const m = core.rebase(before, list, { tombstones: tomb });
      const res = core.applyOps(before, m.ops);
      next = res.error ? before : res.doc;
      removed = core.collectTombstones(before, list);
      error = 'diverged';
      call(o.onError, { code: 'diverged', message: 'транзакция сервера не применилась к реплике: ' + (res.error ? res.error.message : ''), tx: c });
      docUrgent = true;   // эту транзакцию из хвоста журнала не переиграть — записать документ
    } else {
      noteTail(c.seq, list, c.chain);
    }
    lastRemoved = [];
    for (const [id, p] of removed) { addTomb(id, p, c.seq); lastRemoved.push(id); }
    confirmed = { seq: c.seq, doc: next };
    pruneTomb(c.seq);
    tip = typeof c.chain === 'string' && c.chain ? c.chain : null;
    docDirty = true;
    return before;
  }

  /* ---- локальный журнал ---- */

  /** Основа сменилась (снимок, легаси-журнал): документ — в журнал при первой же записи. */
  function newGen() {
    gen = core.uid('g');
    tailLog = [];
    tailBytes = 0;
    docDirty = true;
    docUrgent = true;
  }

  /** Подтверждённая транзакция сверх записанного документа — в хвост записи очереди. */
  function noteTail(seq, ops, chain) {
    if (!storage) return;
    let bytes = 0;
    try { bytes = JSON.stringify(ops).length; } catch { bytes = 0; }
    tailLog.push({ seq, ops, chain: typeof chain === 'string' && chain ? chain : null, bytes });
    tailBytes += bytes;
    if (tailLog.length > DOC_TAIL_MAX || tailBytes > DOC_TAIL_BYTES) docUrgent = true;
  }

  /** Запись очереди: всё, кроме документа; `base` — какой документ она дополняет хвостом. */
  function queueRecord(base, tail) {
    let extra;
    try { extra = typeof o.extra === 'function' ? o.extra() : undefined; } catch (e) { report('extra', e); }
    return {
      v: 3, base, tail: tail.map((e) => ({ seq: e.seq, ops: e.ops, chain: e.chain })),
      seq: confirmed.seq, pending, clientId, updatedAt: Date.now(),
      tip, epoch, mine, mineEvicted, unsaved,
      ...(extra !== undefined ? { extra } : {}),
    };
  }
  function docRecord() {
    return { v: 3, gen, seq: confirmed.seq, doc: confirmed.doc, tombstones: tombToList(tomb, tombSeq), tip, epoch, updatedAt: Date.now() };
  }

  function putAll(entries) {
    try {
      if (typeof storage.setMany === 'function') return Promise.resolve(storage.setMany(entries));
      // адаптер без пачки: записи заводятся сразу и по порядку (IndexedDB их так и исполнит)
      return Promise.all(entries.map(([k, v]) => storage.set(k, v)));
    } catch (e) { return Promise.reject(e); }
  }

  function scheduleWrite() {
    dirty = true;
    if (!storage || writeTimer) return;
    writeTimer = setT(() => { writeTimer = null; writeNow(); }, WRITE_DELAY);
  }

  /** Документ отстал, а записать его рано: отложенная запись (в простой браузера, если есть). */
  function armDocTimer() {
    if (!storage || !docDirty || docTimer || idleHandle || closed) return;
    const wait = Math.max(0, DOC_WRITE_GAP - (Date.now() - docWrittenAt));
    docTimer = setT(() => {
      docTimer = null;
      const ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
      if (ric) idleHandle = ric(() => { idleHandle = null; writeNow(); }, { timeout: 1000 });
      else writeNow();
    }, wait);
  }

  /**
   * Запись журнала (круг 27): очередь — всегда, документ — только если он изменился и
   * пора (DOC_WRITE_GAP), основа сменилась или хвост велик; `force` — сейчас (уход со
   * страницы). Документ и очередь при этом — одной транзакцией.
   */
  function writeNow(force = false) {
    if (!storage || !confirmed.doc) return writing || Promise.resolve();
    const docDue = docDirty && (force || docUrgent || Date.now() - docWrittenAt >= DOC_WRITE_GAP);
    if (!dirty && !docDue) { armDocTimer(); return writing || Promise.resolve(); }
    dirty = false;
    let entries;
    let base = null;
    if (docDue) {
      if (docTimer) { clearTimeout(docTimer); docTimer = null; }
      base = { gen, seq: confirmed.seq };
      entries = [[projectId + DOC_SUFFIX, docRecord()], [projectId, queueRecord(base, [])]];
      docDirty = false;
      docUrgent = false;
      docWrittenAt = Date.now();
      issuedBase = base;
    } else {
      const b = issuedBase && issuedBase.gen === gen ? issuedBase : null;
      entries = [[projectId, queueRecord(issuedBase, b ? tailLog.filter((e) => e.seq > b.seq) : [])]];
    }
    const p = putAll(entries);
    writing = p.then(() => {
      if (!base) return;
      savedBase = base;
      if (base.gen === gen) {
        tailLog = tailLog.filter((e) => e.seq > base.seq);
        tailBytes = 0;
        for (const e of tailLog) tailBytes += e.bytes || 0;
      }
    }, (e) => {
      report('journal', e);
      if (base) { issuedBase = savedBase; docDirty = true; dirty = true; }
    }).then(() => { writing = null; armDocTimer(); });
    return writing;
  }
  /** Записать журнал сейчас — перед уходом со страницы. Возвращает промис записи. */
  function flush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (docTimer) { clearTimeout(docTimer); docTimer = null; }
    if (idleHandle && typeof cancelIdleCallback === 'function') { try { cancelIdleCallback(idleHandle); } catch { /* нет */ } }
    idleHandle = null;
    const p = writeNow(true);
    if (storage && typeof storage.flush === 'function') { try { storage.flush(); } catch { /* адаптер без сброса */ } }
    return p;
  }

  /**
   * Журнал → состояние (open). Форматы: v3 (очередь `<id>` + документ `<id>#doc`, хвост
   * подтверждённых сверх документа переигрывается) и прежний — одна запись с doc.
   * @returns {boolean} есть ли локальный документ
   */
  async function loadLocal() {
    let rec = null;
    try { rec = await storage.get(projectId); } catch (e) { report('journal', e); rec = null; }
    if (!rec || typeof rec !== 'object') return false;
    let docRec = null;
    if (rec.doc && rec.doc.nodes) {
      docRec = rec;   // прежний формат: всё в одной записи
    } else {
      try { docRec = await storage.get(projectId + DOC_SUFFIX); } catch (e) { report('journal', e); docRec = null; }
      if (!docRec || !docRec.doc || !docRec.doc.nodes) docRec = null;
    }
    if (closed) return false;
    pending = Array.isArray(rec.pending) ? rec.pending.filter((t) => t && t.tx_id && Array.isArray(t.ops)) : [];
    extraLoaded = rec.extra;
    mine = Array.isArray(rec.mine) ? rec.mine.filter((m) => m && m.tx && m.tx.tx_id && Array.isArray(m.tx.ops) && isNum(m.seq)).slice(-MINE_KEEP) : [];
    mineEvicted = Array.isArray(rec.mineEvicted) ? rec.mineEvicted.filter((e) => e && isNum(e.seq)).slice(-MINE_EVICTED_KEEP) : [];
    unsaved = Array.isArray(rec.unsaved) ? rec.unsaved.filter((u) => u && u.tx && u.tx.tx_id && Array.isArray(u.tx.ops)).slice(-UNSAVED_KEEP) : [];
    if (!docRec) {
      // документа нет (не успел записаться) — очередь цела, снимок возьмём у сервера
      epoch = typeof rec.epoch === 'string' && rec.epoch ? rec.epoch : null;
      return false;
    }
    confirmed = { seq: isNum(docRec.seq) ? docRec.seq : 0, doc: docRec.doc };
    setTombs(tombFromList(docRec.tombstones, confirmed.seq));
    pruneTomb();
    tip = typeof docRec.tip === 'string' && docRec.tip ? docRec.tip : null;
    epoch = typeof docRec.epoch === 'string' && docRec.epoch ? docRec.epoch : null;
    if (docRec === rec || typeof docRec.gen !== 'string' || !docRec.gen) { newGen(); return true; }
    gen = docRec.gen;
    savedBase = issuedBase = { gen, seq: confirmed.seq };
    docWrittenAt = Date.now();
    if (rec.base && rec.base.gen === gen) {
      // хвост: подтверждённые после записанного документа, подряд по номерам
      const tail = [];
      let next = confirmed.seq + 1;
      for (const e of Array.isArray(rec.tail) ? rec.tail : []) {
        if (!e || !isNum(e.seq) || !Array.isArray(e.ops) || e.seq < next) continue;
        if (e.seq !== next) break;
        tail.push(e);
        next += 1;
      }
      if (tail.length) {
        const r = applyRun(confirmed.doc, tail.map((e) => e.ops));
        const bad = r.results.findIndex((x) => !!x);
        if (bad < 0) {   // отказ — хвост не берём целиком: догоним у сервера
          addTombsOf(tail, r.tombstones);
          confirmed = { seq: tail[tail.length - 1].seq, doc: r.doc };
          pruneTomb();
          tip = tail[tail.length - 1].chain || null;
          for (const e of tail) noteTail(e.seq, e.ops, e.chain);
          docDirty = true;
        }
      }
      if (typeof rec.epoch === 'string' && rec.epoch) epoch = rec.epoch;
    }
    return true;
  }

  /* ---- HTTP ---- */

  async function httpOnce(path, init) {
    if (!fetchImpl) throw new Error('fetch недоступен');
    const res = await fetchImpl(baseUrl + path, { ...(init || {}), headers: { 'content-type': 'application/json', 'x-author': encodeURIComponent(author || ''), ...((init && init.headers) || {}) } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body, retryAfter: retryAfterOf(res, body) };
  }

  /**
   * Запрос с уважением к перегрузке: 503/429 → ждать Retry-After (с разбросом) и
   * повторить, не больше HTTP_RETRIES раз; дальше — ответ как есть.
   */
  async function http(path, init) {
    let r = await httpOnce(path, init);
    for (let i = 0; i < HTTP_RETRIES && (r.status === 503 || r.status === 429) && staleEngineOf(r.body) === undefined && !closed; i++) {
      // J4: хранилище лежит — сказать сразу, а не после всех повторов
      if (r.status === 503 && storageFailure(r.body)) markStorageDown();
      // Retry-After — не раньше срока (плюс разброс до половины); без него — экспонента с разбросом
      const wait = r.retryAfter != null ? r.retryAfter * 1000 : reconnectMin * Math.pow(2, i);
      const delay = r.retryAfter != null ? wait + Math.random() * wait * 0.5 : jitter(wait);
      // ожидание, которое кто-то ждёт (await), — обычный таймер: его держать в Node можно
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay)));
      r = await httpOnce(path, init);
    }
    if (r.status === 503 && storageFailure(r.body)) markStorageDown();
    return r;
  }

  /* ---- хранилище сервера (J4) ---- */

  /**
   * Хранилище сервера недоступно: правки остаются в очереди, статус — «сервер не может
   * сохранить — правки ждут» (одинаково во всех вкладках: у той, что с открытым сокетом, и у
   * той, чей сокет сервер закрыл). Снимается успешной записью (подтверждение/ack своей) или
   * health; пока лежит — /api/health с растущей паузой.
   */
  function markStorageDown() {
    if (closed) return;
    const first = !storageDown;
    storageDown = true;
    if (first) { healthTries = 0; emitStatus(); }
    armHealth();
  }
  function storageUp() {
    storageTries = 0;
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    if (!storageDown) return false;
    storageDown = false;
    emitStatus();
    return true;
  }
  function armHealth() {
    if (closed || healthTimer || healthBusy || !fetchImpl) return;
    const wait = jitter(Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(healthTries, 12))));
    healthTries += 1;
    healthTimer = setT(() => { healthTimer = null; checkHealth(); }, Math.max(1, wait));
  }
  /**
   * Круг 33, п.4. База легла, пока никто не правит: записи нет — нет и отказа, и статус
   * оставался «в сети · всё сохранено», хотя следующая правка не сохранится. Пока сокет
   * жив, раз в idleHealthMs (10–15 с) спрашиваем /api/health; лежит — «сервер не может
   * сохранить», дальше ведёт обычная проверка с растущей паузой.
   */
  function armIdleHealth() {
    if (closed || idleHealthTimer || !(idleHealthMs > 0) || !fetchImpl) return;
    const wait = Math.round(idleHealthMs * (0.85 + Math.random() * 0.4));
    idleHealthTimer = setT(() => {
      idleHealthTimer = null;
      if (closed || !ready) return;   // сокета нет — статус и так «не в сети»; новый hello заведёт снова
      if (!storageDown && !healthBusy && !healthTimer) checkHealth();
      armIdleHealth();
    }, Math.max(1, wait));
  }

  /**
   * GET /api/health (J1): 200 — хранилище живо (очередь — сразу, не дожидаясь паузы); 503
   * с `storage: 'down'` — проверить позже. Сервис без health (404) или недоступен вовсе —
   * про хранилище ничего не известно: флаг снимается, дальше решат сокет и запись.
   */
  async function checkHealth() {
    if (closed || healthBusy || !fetchImpl) return;
    healthBusy = true;
    let r = null;
    try { r = await httpOnce('/api/health'); } catch (e) { r = null; }
    healthBusy = false;
    if (closed) return;
    if (r && r.ok) {
      const down = r.body && typeof r.body === 'object' && (r.body.storage === 'down' || r.body.ok === false);
      if (down) { markStorageDown(); return; }
      if (storageUp() && pending.length) {
        if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; }
        sendNext();
      }
      return;
    }
    if (r && r.status === 503 && storageFailure(r.body)) { markStorageDown(); return; }
    if (r && r.status === 503) { if (storageDown) armHealth(); return; }   // занят — спросим позже
    storageUp();
  }

  /* ---- «История» с сервера (J3) ---- */

  /**
   * Последние транзакции проекта без операций (`GET …/history?limit=100`, J2) — в журнал
   * «Истории»: после перезагрузки и после снимка он не пуст. Слияние — по seq, без дублей;
   * живые записи (с листьями и удалёнными узлами для «кто помешал») не заменяются. Номера
   * новее confirmed не берутся — они придут живыми (догон или сокет).
   */
  function loadHistory() {
    if (closed || !fetchImpl) return;
    const req = ++historyReq;
    const era = journalEra;
    const ep = epoch;
    http(`/api/projects/${encodeURIComponent(projectId)}/history?limit=${HISTORY_LIMIT}`).then((r) => {
      if (closed || req !== historyReq) return;
      if (r.status === 404 || r.status === 405) { historyLoaded = true; return; }   // сервис без истории
      if (!r.ok || !r.body) return;   // попробуем при следующем hello
      const items = Array.isArray(r.body.items) ? r.body.items : Array.isArray(r.body) ? r.body : null;
      if (!items) { historyLoaded = true; return; }
      historyLoaded = true;
      if (era !== journalEra || ep !== epoch) return;   // журнал сменил историю, пока шёл запрос
      mergeHistory(items);
    }, (e) => report('history', e));
  }

  function mergeHistory(items) {
    const have = new Set(journalList.map((e) => e.pub.seq));
    const add = [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || !isNum(it.seq) || it.seq <= 0 || it.seq > confirmed.seq || have.has(it.seq)) continue;
      have.add(it.seq);
      const client = typeof it.client === 'string' ? it.client : '';
      add.push({
        pub: {
          seq: it.seq, tx_id: String(it.tx_id || ''), author: typeof it.author === 'string' ? it.author : '',
          author_kind: typeof it.author_kind === 'string' && it.author_kind ? it.author_kind : 'human',
          title: typeof it.title === 'string' ? it.title : '',
          created_at: typeof it.created_at === 'string' ? it.created_at : '', client,
          command_id: typeof it.command_id === 'string' ? it.command_id : '',
          // круг 30: кто дал команду агенту — «Агент · Аня» без памяти о присутствии
          command_author: typeof it.command_author === 'string' ? it.command_author : '',
          // круг 32: отмена/повтор и часть большой правки — оболочка сводит части точно
          ...rewindOf(it),
          ops_count: isNum(it.ops_count) ? it.ops_count : 0, dropped_count: isNum(it.dropped_count) ? it.dropped_count : 0,
          // круг 30: запись без операций (все выпали при слиянии, повтор) — оболочка не рисует пустую строку
          empty: it.empty === true || (isNum(it.ops_count) && it.ops_count === 0),
          mine: !!client && client === clientId,
        },
        created: [], leaves: [], removed: [],
      });
    }
    if (!add.length) return;
    const merged = journalList.concat(add).sort((a, b) => a.pub.seq - b.pub.seq);
    while (merged.length > JOURNAL_KEEP) dropEntry(merged.shift());
    journalList = merged;
    noteJournal();
  }

  /** Запрос `?since=…` с якорем: tip и эпоха, если известны. */
  function anchorQuery() {
    return (tip ? `&tip=${encodeURIComponent(tip)}` : '') + (epoch ? `&epoch=${encodeURIComponent(epoch)}` : '');
  }

  /** Снимок + хвост с сервера → confirmed (очередь переигрывается поверх). */
  async function loadFromServer({ opening = false } = {}) {
    const r = await http(`/api/projects/${encodeURIComponent(projectId)}`);
    if (r.status === 404) { markNotFound(); return false; }
    // круг 41 (UX Д7): проект записан более новой версией редактора, этот сервер её не читает
    const stale = r.status === 503 ? staleEngineOf(r.body) : undefined;
    if (stale !== undefined) throw Object.assign(new Error('проект записан другой версией движка'), { status: 503, engine: stale });
    if (!r.ok || !r.body || !r.body.snapshot || !r.body.snapshot.doc) throw Object.assign(new Error(`GET /api/projects: ${r.status}`), { status: r.status });
    const moved = !!(epoch && typeof r.body.epoch === 'string' && r.body.epoch !== epoch);
    if (notFound) { notFound = false; if (error === 'not_found') error = null; }
    if (opening && isNum(r.body.head_seq)) openHead = Math.max(openHead, r.body.head_seq);
    projectSummary(r.body);
    adoptSnapshot(r.body.snapshot, r.body.tail, r.body.epoch, moved);
    return true;
  }

  /** Сводка проекта (I4) — оболочке: имя могли переименовать на другом экземпляре. */
  function projectSummary(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    if (p.id !== undefined && String(p.id) !== projectId) return;
    const out = {};
    for (const k of ['id', 'name', 'kind', 'head_seq', 'updated_at']) if (p[k] !== undefined) out[k] = p[k];
    if (!Object.keys(out).length) return;
    call(o.onProject, out);
  }

  /**
   * Снимок как confirmed, хвост — по порядку, своя очередь — поверх. Надгробия — из снимка
   * (v2/v1, I1); снимок без надгробий (null — записан прежней версией) — свои не сбрасываются.
   * Журнал: эпоха сменилась — он про другую историю, очищается; иначе остаётся то, что не
   * новее снимка. Эпоха сменилась — свои подтверждённые прежней эпохи встают в очередь (I5).
   */
  function adoptSnapshot(snapshot, tail, nextEpoch, moved = false) {
    confirmed = { seq: isNum(snapshot.seq) ? snapshot.seq : 0, doc: snapshot.doc };
    tip = typeof snapshot.chain === 'string' && snapshot.chain ? snapshot.chain : null;
    if (typeof nextEpoch === 'string' && nextEpoch) epoch = nextEpoch;
    const t = snapshotTombs(core, snapshot.tombstones, confirmed.seq);
    if (t) setTombs(t);
    pruneTomb();
    newGen();
    journalTrim(moved ? -1 : confirmed.seq);
    const list = Array.isArray(tail) ? tail.slice().sort((a, b) => a.seq - b.seq) : [];
    for (const c of list) if (isNum(c.seq) && c.seq > confirmed.seq) takeCommitted(c, { silent: true });
    if (moved) requeueMine(isNum(snapshot.seq) ? snapshot.seq : confirmed.seq);
    replayAll();
    scheduleWrite();
  }

  /** Пропуск в номерах: догоняем по HTTP, живой поток копим в буфер. */
  async function catchUp() {
    if (catchingUp) return;
    catchingUp = true;
    emitStatus();
    try {
      let guard = 0;
      while (guard++ < 100) {
        const r = await http(`/api/projects/${encodeURIComponent(projectId)}/ops?since=${confirmed.seq}&limit=${OPS_PAGE}${anchorQuery()}`);
        if (closed) return;
        if (r.status === 410 && r.body && r.body.snapshot) {
          gone(r.body.snapshot, r.body.head_seq, r.body.epoch);
          if (!(isNum(r.body.head_seq) && r.body.head_seq > confirmed.seq)) break;
          continue;
        }
        if (r.status === 404) { markNotFound(); break; }
        if (!r.ok || !r.body) throw new Error(`GET …/ops: ${r.status}`);
        const txs = Array.isArray(r.body.txs) ? r.body.txs.slice().sort((a, b) => a.seq - b.seq) : [];
        for (const c of txs) if (isNum(c.seq) && c.seq > confirmed.seq) takeCommitted(c);
        const head = isNum(r.body.head_seq) ? r.body.head_seq : confirmed.seq;
        // страница ограничена байтами: `more` — за ней есть ещё (SPEC §9.8)
        if (!txs.length || (confirmed.seq >= head && !r.body.more)) break;
      }
    } catch (e) {
      report('catchUp', e);
      // догнать не вышло — сокет рано или поздно переподключится с since = confirmed.seq
      if (socket) { try { socket.close(); } catch { /* уже закрыт */ } }
    } finally {
      catchingUp = false;
      const held = buffer;
      buffer = [];
      for (const c of held) handleTx(c);
      // ack, пришедшие во время догона, — теперь, когда confirmed окончательный
      const acks = heldAcks;
      heldAcks = [];
      for (const m of acks) takeAck(m);
      emitStatus();
      /* Круг 27 (I5, дефект «стада»): очередь стоит, пока шёл догон, — дальше она обязана
         пойти сама. Раньше после gone с head > снимка переигранная очередь ждала новой
         правки: из десяти вкладок после отката дописывала только первая. */
      if (!closed) sendNext();
    }
  }

  function gone(snapshot, headSeq, nextEpoch) {
    if (!snapshot || !snapshot.doc) return;
    const moved = epochMoved || !!(epoch && typeof nextEpoch === 'string' && nextEpoch && nextEpoch !== epoch);
    epochMoved = false;
    // база откатилась: свои транзакции прежней эпохи могли пропасть вместе с ней — переиграть
    adoptSnapshot(snapshot, [], nextEpoch, moved);
    // J3: журнал «Истории» после снимка — с сервера (эпоха сменилась — он очищен целиком)
    loadHistory();
    call(o.onGone, snapshot);
    call(o.onChange, view, { reason: 'gone', head: headSeq });
    emitStatus();
  }

  /**
   * Проекта нет на сервере (I3: базу восстановили из копии, где его ещё не было): статус
   * `not_found`, очередь НЕ снимается (работа — в view и журнале, оболочка предложит
   * сохранить её новым проектом), сокет закрыт, следующая попытка — через 30–60 с.
   */
  function markNotFound() {
    const first = !notFound;
    notFound = true;
    if (!halted) error = 'not_found';
    if (inflight) clearInflight();
    const ws = socket;
    if (ws) {
      socket = null;
      try { ws.close(); } catch { /* уже закрыт */ }
      dropSocketState();
    }
    emitStatus();
    if (first) call(o.onError, { code: 'not_found', message: 'проект не найден на сервере' });
    if (opened && !closed && view) scheduleNotFoundRetry();
  }
  function scheduleNotFoundRetry() {
    if (closed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, Math.round(notFoundRetry * (1 + Math.random())));
  }

  /* ---- транзакции сервера ---- */

  function handleTx(c) {
    if (!c || !isNum(c.seq)) return;
    if (catchingUp) { buffer.push(c); return; }
    if (c.seq <= confirmed.seq) return;               // уже есть (повтор после переподключения)
    if (c.seq > confirmed.seq + 1) {                  // пропуск: догоняем по HTTP (§9.3)
      buffer.push(c);
      catchUp();
      return;
    }
    takeCommitted(c);
    if (helloHead >= 0 && confirmed.seq >= helloHead) emitStatus();
  }

  /**
   * Зафиксированная транзакция с номером confirmed.seq + 1. Своя (по tx_id) — это
   * подтверждение: уходит из очереди, confirmed = apply(confirmed, tx.ops), следующая
   * отправляется. Чужая — к confirmed, очередь переигрывается поверх.
   */
  function takeCommitted(c, opts = {}) {
    const i = pending.findIndex((p) => p.tx_id === c.tx_id);
    // круг 27: своя pending[0] подтверждена ровно в предсказанной форме, чужих между не было —
    // view уже верен (тот же hashDoc), очередь не переигрывается: дренаж после офлайна O(P), не O(P²)
    const fast = i === 0 && !opts.silent && predicted(c);
    const prevView = view;
    const before = applyConfirmed(c);
    // транзакция агента по команде этой вкладки — тоже своя: после отката базы её переиграет реплика
    const agentMine = i < 0 && !!c.client && c.client === clientId && c.author_kind === 'agent';
    journalAdd(c, lastRemoved, i >= 0 || (!!c.client && c.client === clientId));
    if (agentMine) rememberMine(agentTx(c), c.seq, c.created_at);
    if (i >= 0) {
      const own = pending.splice(i, 1)[0];
      if (inflight === c.tx_id) clearInflight();
      if (poison && poison.tx_id === c.tx_id) poison = null;
      if (!opts.silent) storageUp();   // J4: своя записана — хранилище живо
      rememberMine(own, c.seq, c.created_at);
      if (fast && !lastDiverged) {
        plan.ops.shift();
        plan.seq = confirmed.seq;
        plan.doc = confirmed.doc;
      } else if (!opts.silent) {
        replayAll();
      }
      scheduleWrite();
      emitStatus();
      if (opts.silent) return;   // снимок с хвостом: переиграет adoptSnapshot один раз в конце
      let inverse = [];
      try { inverse = core.invertOps(before, c.ops); } catch (e) { report('invert', e); }
      if (Array.isArray(c.dropped) && c.dropped.length) call(o.onDropped, explainDropped(c, own));
      const info = confirmedInfo(c, inverse, fast, prevView, view);
      if (c.seq <= openHead) info.backlog = true;
      call(o.onChange, view, info);
      sendNext();
      return;
    }
    if (!opts.silent) replayAll();
    scheduleWrite();
    /* круг 31: `before` — подтверждённый документ до этой транзакции (без своих неподтверждённых
       правок): подписи «Аня удалила «Ярлыки»» — по имени на сервере, а не по своему черновику */
    /* круг 41 (UX): догон после разрыва — hello сказал голову, хвост идёт по одной транзакции;
       `more` — за этой ещё будут до головы hello: оболочка может не рисовать промежуточных кадров */
    if (!opts.silent) call(o.onChange, view, { reason: 'remote', tx: c, mine: !!c.client && c.client === clientId, before, ...(c.seq <= openHead ? { backlog: true } : {}), ...(isNum(c.seq) && c.seq < helloHead ? { more: true } : {}) });
  }

  /** Транзакция агента из рассылки — в форме Tx для переигрывания (применённые операции). */
  function agentTx(c) {
    const tx = { tx_id: c.tx_id, base_seq: isNum(c.base_seq) ? c.base_seq : 0, ops: Array.isArray(c.ops) ? c.ops : [], engine: core.ENGINE_VERSION, client: clientId, author_kind: 'agent' };
    for (const k of ['author', 'title', 'command_id', 'command_author', 'undo_of', 'redo_of']) if (typeof c[k] === 'string' && c[k]) tx[k] = c[k];
    return tx;
  }

  /**
   * Своя подтверждённая — в mine: после отката базы её переиграют. Окно — последние
   * MINE_KEEP и не больше MINE_BYTES; вытесненные запоминаются (эпоха, seq), чтобы
   * после отката честно сказать, сколько своего уже не переиграть. `at` — когда правка
   * записана впервые (время сервера; у переигранной — исходное).
   */
  function rememberMine(tx, seq, at) {
    if (!tx || !tx.tx_id) return;
    mine = mine.filter((m) => m.tx.tx_id !== tx.tx_id);
    const when = (typeof tx.replay_at === 'string' && tx.replay_at) || (typeof at === 'string' && at) || new Date().toISOString();
    let bytes = 0;
    try { bytes = JSON.stringify(tx).length; } catch { bytes = 0; }
    mine.push({ tx, seq, epoch, at: when, bytes });
    let total = 0;
    for (const m of mine) total += m.bytes || 0;
    while (mine.length > 1 && (mine.length > MINE_KEEP || total > MINE_BYTES)) {
      const old = mine.shift();
      total -= old.bytes || 0;
      mineEvicted.push({ epoch: old.epoch, seq: old.seq });
    }
    if (mineEvicted.length > MINE_EVICTED_KEEP) mineEvicted = mineEvicted.slice(-MINE_EVICTED_KEEP);
  }

  /**
   * Эпоха сменилась и пришёл снимок (SPEC §9.8, §9.10): свои транзакции, подтверждённые
   * в прежней эпохе, встают в начало очереди — все, в порядке, в котором их
   * подтверждали. Каждая несёт `replay_of_epoch` и `replay_at`: сервер узнает
   * уцелевшие по tx_id, потерянные запишет заново, но `set` на лист, который после
   * неё переписал кто-то другой, отбросит (`stale`) — старое не затирает новое.
   * Старше суток — не переигрываются (человеку — «N правок из прошлой версии не
   * восстановлены»); вытесненные из окна после снимка — тоже сказать.
   */
  function requeueMine(snapSeq) {
    const old = mine.filter((m) => m.epoch !== epoch && !pending.some((p) => p.tx_id === m.tx.tx_id));
    const now = Date.now();
    const fresh = [];
    const expired = [];
    for (const m of old) {
      const t = Date.parse(m.at);
      (Number.isFinite(t) && now - t > LIMITS.replayMaxAgeMs ? expired : fresh).push(m);
    }
    const lost = mineEvicted.filter((e) => e.epoch !== epoch && (!isNum(snapSeq) || e.seq > snapSeq)).length;
    mineEvicted = mineEvicted.filter((e) => e.epoch === epoch);
    if (!old.length && !lost) return;
    mine = mine.filter((m) => !old.includes(m));
    const words = (n) => `${n} ${plural(n, 'правка', 'правки', 'правок')} из прошлой версии не ${plural(n, 'восстановлена', 'восстановлены', 'восстановлены')}`;
    if (expired.length) {
      call(o.onError, { code: 'replay_expired', count: expired.length, message: `${words(expired.length)}: им больше суток — база с тех пор восстановлена из резервной копии`, txs: expired.map((m) => m.tx) });
    }
    if (lost) {
      call(o.onError, { code: 'replay_incomplete', count: lost, message: `${words(lost)}: реплика помнит только последние ${MINE_KEEP}` });
    }
    if (fresh.length) {
      if (inflight) clearInflight();
      // I5: base_seq переигрываемой — номер полученного снимка: старый номер — из другой
      // истории, и окно поиска stale на сервере по нему было бы не то
      pending = [...fresh.map((m) => ({ ...m.tx, ...(isNum(snapSeq) ? { base_seq: snapSeq } : {}), replay_of_epoch: m.epoch || 'none', replay_at: m.at })), ...pending];
    }
    scheduleWrite();   // view переигрывает вызывающий (adoptSnapshot)
  }

  /* ---- журнал в памяти: история и «кто помешал» ---- */

  /**
   * Круг 32: `undo_of`/`redo_of` и часть большой правки `undo_part {i, n}` записи журнала
   * (из рассылки или /history) — пустые строки и null, если их нет.
   */
  function rewindOf(c) {
    const part = c.undo_part;
    const ok = part && typeof part === 'object' && Number.isInteger(part.i) && Number.isInteger(part.n) && part.n > 1 && part.i >= 0 && part.i < part.n;
    return {
      undo_of: typeof c.undo_of === 'string' ? c.undo_of : '',
      redo_of: typeof c.redo_of === 'string' ? c.redo_of : '',
      undo_part: ok ? { i: part.i, n: part.n } : null,
    };
  }

  function journalAdd(c, removedIds, own) {
    const pub = {
      seq: c.seq, tx_id: String(c.tx_id || ''), author: typeof c.author === 'string' ? c.author : '',
      author_kind: c.author_kind || 'human', title: typeof c.title === 'string' ? c.title : '',
      created_at: typeof c.created_at === 'string' ? c.created_at : '', client: typeof c.client === 'string' ? c.client : '',
      command_id: typeof c.command_id === 'string' ? c.command_id : '',
      command_author: typeof c.command_author === 'string' ? c.command_author : '',
      ...rewindOf(c),
      ops_count: Array.isArray(c.ops) ? c.ops.length : 0, dropped_count: droppedCount(c.dropped),
      empty: !Array.isArray(c.ops) || c.ops.length === 0, mine: !!own,
    };
    const created = [];
    const leaves = [];
    for (const op of Array.isArray(c.ops) ? c.ops : []) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'create' && op.node && typeof op.node.id === 'string') { if (created.length < JOURNAL_LEAVES) created.push(op.node.id); }
      else if ((op.op === 'set' || op.op === 'setToken') && typeof op.path === 'string' && leaves.length < JOURNAL_LEAVES) {
        leaves.push({ scope: op.op === 'set' ? 'n:' + op.id : 't:', path: op.path });
      }
    }
    const entry = { pub, created, leaves, removed: Array.isArray(removedIds) ? removedIds : [] };
    const last = journalList.length ? journalList[journalList.length - 1] : null;
    if (!last || last.pub.seq < pub.seq) journalList.push(entry);
    else {
      // запись из «Истории» сервера с тем же номером — живая её заменяет (у неё листья и удалённые)
      const k = journalList.findIndex((e) => e.pub.seq >= pub.seq);
      if (journalList[k].pub.seq === pub.seq) { dropEntry(journalList[k]); journalList[k] = entry; } else journalList.splice(k, 0, entry);
    }
    for (const id of entry.removed) removedBy.set(id, entry);
    while (journalList.length > JOURNAL_KEEP) dropEntry(journalList.shift());
    noteJournal();
  }
  function dropEntry(e) {
    for (const id of e.removed) if (removedBy.get(id) === e) removedBy.delete(id);
  }
  /** Оставить записи не новее seq (-1 — очистить: эпоха сменилась, это другая история). */
  function journalTrim(seq) {
    if (seq < 0) journalEra += 1;
    if (!journalList.length) return;
    const keep = seq < 0 ? [] : journalList.filter((e) => e.pub.seq <= seq);
    if (keep.length === journalList.length) return;
    for (const e of journalList) if (!keep.includes(e)) dropEntry(e);
    journalList = keep;
    noteJournal();
  }
  function noteJournal() {
    if (journalNotify || typeof o.onJournal !== 'function') return;
    journalNotify = true;
    Promise.resolve().then(() => { journalNotify = false; call(o.onJournal, journal()); });
  }
  /** Последние подтверждённые транзакции, новые первыми. */
  function journal(limit = 200) {
    const n = Math.max(0, Math.min(JOURNAL_KEEP, isNum(limit) ? limit : 200));
    return journalList.slice(-n).reverse().map((e) => ({ ...e.pub }));
  }
  const whoOf = (e) => (e ? { author: e.pub.author, author_kind: e.pub.author_kind, seq: e.pub.seq, title: e.pub.title } : null);
  /** Кто удалил узел (сам узел или поддерево с ним) — по недавнему журналу; не знаем — null. */
  function whoRemoved(nodeId) {
    return whoOf(removedBy.get(String(nodeId)) || null);
  }
  function newest(pred, exceptTx) {
    for (let k = journalList.length - 1; k >= 0; k--) {
      const e = journalList[k];
      if (e.pub.tx_id !== exceptTx && pred(e)) return e;
    }
    return null;
  }
  /**
   * Круг 31: кто чужой переписал лист (`set` узла или `setToken`) позже seq — для отмены,
   * которая вернёт своё значение поверх чужой правки. {author, author_kind, seq, title} или null.
   */
  function whoChanged(op, afterSeq = -1) {
    if (!op || typeof op.path !== 'string') return null;
    const scope = op.op === 'setToken' ? 't:' : 'n:' + op.id;
    const since = isNum(afterSeq) ? afterSeq : -1;
    return whoOf(newest((e) => !e.pub.mine && e.pub.seq > since && e.leaves.some((l) => l.scope === scope && pathsMeet(l.path, op.path))));
  }
  /** Кто помешал операции из dropped: удалил узел или родителя, создал тот же id, переписал лист. */
  function whoFor(d, exceptTx) {
    const op = d && d.op && typeof d.op === 'object' ? d.op : {};
    const nodeId = op.op === 'create' ? op.node && op.node.id : op.id;
    switch (d && d.reason) {
      case 'removed': return whoRemoved(nodeId);
      case 'orphan': return whoRemoved(op.op === 'create' ? op.node && op.node.parent : op.parent);
      case 'exists': return whoOf(newest((e) => e.created.includes(nodeId), exceptTx));
      case 'stale': {
        if (typeof op.path !== 'string') return null;
        const scope = op.op === 'setToken' ? 't:' : 'n:' + op.id;
        return whoOf(newest((e) => !e.pub.mine && e.leaves.some((l) => l.scope === scope && pathsMeet(l.path, op.path)), exceptTx));
      }
      default: return null;
    }
  }
  /** Подтверждение с dropped для человека: подпись правки и кто помешал (§9.10). */
  function explainDropped(c, own) {
    const label = (typeof c.title === 'string' && c.title) || (own && typeof own.title === 'string' && own.title) || '';
    let first = null;
    const dropped = c.dropped.map((d) => {
      if (!d || typeof d !== 'object' || d.index === undefined) return d;
      const by = whoFor(d, c.tx_id);
      if (by && !first) first = by;
      return { ...d, by, label };
    });
    return { ...c, dropped, label, by: first };
  }

  /* ---- отправка ---- */

  function clearInflight() {
    inflight = null;
    inflightRetries = 0;
    if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
  }

  /** Повторяемая ошибка сервера: отправить ещё раз позже (Retry-After, с разбросом). */
  function scheduleResend(ms) {
    if (resendTimer) return;
    resendTimer = setT(() => { resendTimer = null; sendNext(); }, jitter(Math.max(ms, reconnectMin)));
  }

  function socketOpen() {
    return !!socket && socket.readyState === 1;
  }

  function sendJson(msg) {
    if (!socketOpen()) return false;
    try { socket.send(JSON.stringify(msg)); return true; } catch (e) { report('send', e); return false; }
  }

  /** pending[0] уходит, как только сокет открыт и ничего не в полёте (§9.5). */
  function sendNext() {
    if (halted || inflight || resendTimer || !pending.length || !socketOpen() || !ready) return;
    const tx = pending[0];
    if (!sendJson({ type: 'tx', tx })) return;
    inflight = tx.tx_id;
    armInflight();
  }

  /** Подтверждение не пришло вовремя: дослать (tx_id идемпотентен), потом переподключиться. */
  function armInflight() {
    if (inflightTimer) clearTimeout(inflightTimer);
    inflightTimer = setT(() => {
      inflightTimer = null;
      if (!inflight) return;
      if (inflightRetries < 1 && socketOpen()) {
        inflightRetries += 1;
        const tx = pending.find((p) => p.tx_id === inflight);
        if (tx && sendJson({ type: 'tx', tx })) { armInflight(); return; }
      }
      // сокет молчит: закрываем сами — onclose назначит переподключение
      if (socket) { try { socket.close(); } catch { /* уже закрыт */ } }
    }, ACK_TIMEOUT);
  }

  /* ---- сокет ---- */

  function wsUrl() {
    // имя — и в query: браузер не ставит заголовков при upgrade, а Hub подписывает им присутствие
    const q = `project=${encodeURIComponent(projectId)}&since=${confirmed.seq}&client=${encodeURIComponent(clientId)}`
      + (author ? `&author=${encodeURIComponent(author)}` : '') + anchorQuery() + '&proto=2'
      // круг 33 (DOC): присутствие комнаты — одним кадром на тик; прежний сервер параметр не знает
      + '&presence=batch';
    if (/^wss?:/i.test(baseUrl)) return `${baseUrl}/ws?${q}`;
    if (/^https?:/i.test(baseUrl)) return `${baseUrl.replace(/^http/i, 'ws')}/ws?${q}`;
    if (typeof location !== 'undefined' && location.host) {
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${baseUrl}/ws?${q}`;
    }
    return `ws://localhost${baseUrl}/ws?${q}`;
  }

  function connect() {
    if (closed || !WS) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    let ws;
    try { ws = new WS(wsUrl()); } catch (e) { report('connect', e); connectFailed = true; emitStatus(); scheduleReconnect(); return; }
    socket = ws;
    ready = false;
    if (!everReady && !connectFailed && !connectGrace) {
      connectGrace = setT(() => { connectGrace = null; if (!everReady) { connectFailed = true; emitStatus(); } }, firstConnectMs);
    }
    ws.onopen = () => {
      if (ws !== socket) return;
      helloHead = -1;
      /* Открытый сокет — ещё не сервер: Hub до hello сообщения не принимает, а прокси
         может принять соединение и без живого сервера за спиной. Поэтому «в сети»,
         отправка очереди и присутствие ждут hello; не пришёл за HELLO_TIMEOUT — закрываем
         сами, переподключение назначит onclose. */
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = setT(() => {
        helloTimer = null;
        if (ws === socket && !ready) { try { ws.close(); } catch { /* уже закрыт */ } }
      }, HELLO_TIMEOUT);
    };
    ws.onmessage = (ev) => {
      if (ws !== socket) return;
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { msg = null; }
      if (msg && typeof msg === 'object') handleMessage(msg);
    };
    ws.onerror = () => { /* за ошибкой всегда идёт close — там и решаем */ };
    ws.onclose = (ev) => {
      if (ws !== socket) return;
      socket = null;
      if (!ready) connectFailed = true;
      const code = ev && isNum(ev.code) ? ev.code : 0;
      const lost = inflight;
      dropSocketState();
      if (code === CLOSE_TOO_BIG && lost) dropTooBig(lost);
      if (closed) return;
      if (code === CLOSE_EPOCH) {
        // эпоха журнала сменилась: переоткрыться сразу — снимок придёт по сокету (since/tip не сойдутся)
        epochMoved = true;
        attempt = 0;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, jitter(epochReopenMs));
        return;
      }
      if (code === CLOSE_NOT_FOUND || notFound) { markNotFound(); return; }
      scheduleReconnect();
    };
  }

  /** Сокет потерян: не в сети, ничего не в полёте, чужое присутствие протухло вместе с ним. */
  function dropSocketState() {
    online = false;
    ready = false;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    stopHeartbeat();
    clearInflight();
    if (others.size) { others.clear(); emitPresence(); }
    emitStatus();
  }

  /**
   * Транзакция больше предела сокета (ws закрыл его кодом 1009): повтор ничего не
   * изменит — снимаем с очереди и говорим (иначе она крутилась бы вечно).
   */
  function dropTooBig(txId) {
    const i = pending.findIndex((p) => p.tx_id === txId);
    if (i < 0) return;
    const tx = pending.splice(i, 1)[0];
    replayAll();
    scheduleWrite();
    call(o.onChange, view, { reason: 'error', tx });
    call(o.onError, { code: 'too_large', message: 'правка слишком большая — сервер её не примет', tx });
    emitStatus();
  }

  /**
   * Экспоненциальная пауза с разбросом: 1 с → 2 → 4 … → 30 с, не меньше, чем
   * просил сервер (Retry-After). Сбрасывается по hello.
   */
  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const base = Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(attempt, 12)));
    const delay = Math.max(jitter(base), serverWait);
    serverWait = 0;
    attempt += 1;
    reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, delay);
  }

  /**
   * Повтор уже записанной транзакции, которую этот сокет уже видел (SPEC §9.8 `ack`,
   * §9.9 `error duplicate`): если она в confirmed — снять с очереди; если впереди —
   * придёт кадром tx.
   */
  function takeAck(msg) {
    /* Во время догона confirmed ещё не окончательный: его номер может быть из прежней
       истории (снимок новой эпохи придёт ответом на …/ops), и «seq ≤ confirmed.seq» ничего
       не доказывает — снять правку сейчас значило бы убрать её с холста до снимка (мигание).
       Разбираем после догона (catchUp/finally). */
    if (catchingUp) { heldAcks.push(msg); return; }
    const i = msg.tx_id ? pending.findIndex((p) => p.tx_id === msg.tx_id) : -1;
    if (i >= 0 && isNum(msg.seq) && msg.seq <= confirmed.seq) {
      const own = pending.splice(i, 1)[0];
      if (inflight === own.tx_id) clearInflight();
      if (poison && poison.tx_id === own.tx_id) poison = null;
      storageUp();
      rememberMine(own, msg.seq);
      replayAll();
      scheduleWrite();
      emitStatus();
      call(o.onChange, view, { reason: 'ack', tx: own, seq: msg.seq });
      sendNext();
    }
  }

  /**
   * Одинаковые повторяемые ошибки подряд на одну транзакцию (§9.10): `busy` не в
   * счёт — это перегрузка, а не правка. Возвращает, который раз подряд.
   */
  function notePoison(tx, code) {
    if (code === 'busy') return 0;
    if (poison && poison.tx_id === tx.tx_id && poison.code === code) poison.n += 1;
    else poison = { tx_id: tx.tx_id, code, n: 1 };
    return poison.n;
  }

  /**
   * RETRY_POISON раз подряд одно и то же — сервер жив (отвечает на чтение головы)?
   * Да — ещё одна попытка: та же ошибка и после неё — правку не записать никогда,
   * снять её в «не сохранено», очередь идёт дальше (пока проверяли, сервер мог и
   * подняться — тогда попытка пройдёт). Нет (хранилище лежит) — ждать и повторять.
   */
  function probePoison(tx) {
    if (probing) return;
    probing = true;
    const later = () => {
      if (poison && poison.tx_id === tx.tx_id) poison.n = RETRY_POISON - 1;
      scheduleResend(reconnectMax);
    };
    http(`/api/projects/${encodeURIComponent(projectId)}?head=1`).then((r) => {
      probing = false;
      if (closed) return;
      if (!pending.some((p) => p.tx_id === tx.tx_id)) { sendNext(); return; }
      if (r.ok && poison && poison.tx_id === tx.tx_id) {
        poison.alive = true;
        scheduleResend(reconnectMin);
      } else {
        later();
      }
    }, (e) => {
      probing = false;
      report('probe', e);
      if (!closed) later();
    });
  }

  /** Снять транзакцию в «не сохранено»: правка не исчезает молча — человеку сказано, она в unsaved. */
  function giveUp(i, code, msg) {
    const tx = pending.splice(i, 1)[0];
    if (inflight === tx.tx_id) clearInflight();
    poison = null;
    unsaved.push({ tx, cause: code, message: String((msg && msg.message) || ''), at: new Date().toISOString() });
    if (unsaved.length > UNSAVED_KEEP) unsaved = unsaved.slice(-UNSAVED_KEEP);
    replayAll();
    scheduleWrite();
    call(o.onChange, view, { reason: 'error', tx });
    const what = tx.title ? `«${tx.title}»` : '';
    call(o.onError, {
      code: 'not_saved', cause: code, tx,
      message: `правка ${what ? what + ' ' : ''}не сохранена: сервер раз за разом не может её записать (${code}) — она снята с очереди, остальные правки идут дальше`,
    });
    emitStatus();
    sendNext();
  }

  /** Вернуть «не сохранённую» правку в очередь (человек попросил повторить). */
  function retryUnsaved(txId) {
    const k = unsaved.findIndex((u) => u.tx.tx_id === txId);
    if (k < 0) return false;
    const { tx } = unsaved.splice(k, 1)[0];
    pending.push(tx);
    replayAll();
    scheduleWrite();
    call(o.onChange, view, { reason: 'retry', tx });
    emitStatus();
    sendNext();
    return true;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello': {
        attempt = 0;
        ready = true;
        everReady = true;
        if (connectGrace) { clearTimeout(connectGrace); connectGrace = null; }
        online = true;
        notFound = false;   // проект снова есть (его вернули): обычная работа
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        helloHead = isNum(msg.head_seq) ? msg.head_seq : -1;
        // круг 33, п.3: первый hello после открытия — до его головы всё «догоняем», не новости
        if (firstHello) { firstHello = false; if (helloHead > openHead) openHead = helloHead; }
        serverWait = 0;
        if (typeof msg.epoch === 'string' && msg.epoch) {
          // другая эпоха: если следом придёт снимок (hello.gone) — свои транзакции прежней эпохи
          // переигрываются, эпоха меняется со снимком; если хвост (tip сошёлся) — подтверждённое
          // цело: эпоха новая сразу, свои подтверждённые числятся за ней
          if (epoch && msg.epoch !== epoch) epochMoved = true;
          if (msg.gone !== true) {
            if (epochMoved && msg.gone === false) { epochMoved = false; for (const m of mine) m.epoch = msg.epoch; for (const e of mineEvicted) e.epoch = msg.epoch; }
            epoch = msg.epoch;
          }
        }
        /* Круг 41 (арх. Н1): сервер с нашим движком — отказ по версии позади (скользящее
           обновление: прежний экземпляр сменился новым), очередь снова уходит */
        if (msg.engine === core.ENGINE_VERSION) engineCaughtUp();
        // сервер ответил — «недоступен» и «разошлись» больше не про него; отказ по версии остаётся
        if (!halted) error = null;
        if (isNum(msg.engine) && msg.engine !== core.ENGINE_VERSION) markEngine(msg.engine);
        // журнал впереди сервера (базу пересоздали): своя копия ничего не стоит — берём снимок.
        // Сервер круга 23 (с эпохой) сам пришлёт gone — второй снимок по HTTP не нужен
        if (helloHead >= 0 && helloHead < confirmed.seq && typeof msg.epoch !== 'string') {
          loadFromServer().then(() => {
            call(o.onChange, view, { reason: 'gone', head: helloHead });
            emitStatus();
          }).catch((e) => report('resync', e));
        }
        // I4: сводка проекта в hello (у прежнего сервера — строка id: её не передаём)
        if (msg.project && typeof msg.project === 'object') projectSummary(msg.project);
        emitStatus();
        // очередь и присутствие — только теперь: до hello Hub их выбрасывает
        sendNext();
        sendPresence();
        startHeartbeat();
        // J3: «История» переживает перезагрузку — после первого hello с сервера
        if (!historyLoaded) loadHistory();
        /* J4: hello не доказывает, что хранилище живо (голова сервера — в памяти), и не
           доказывает обратного: спросить health — вкладка, открытая при лежащей базе, скажет
           то же, что та, у которой правка уже получила отказ */
        if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
        checkHealth();
        armIdleHealth();
        break;
      }
      case 'tx':
        // (прежний сервер без hello.gone) после hello с новой эпохой пошёл хвост, а не снимок
        if (epochMoved && ready) { epochMoved = false; for (const m of mine) m.epoch = epoch; for (const e of mineEvicted) e.epoch = epoch; }
        handleTx(msg.tx);
        break;
      case 'ack':
        takeAck(msg);
        break;
      case 'project':
        // I4: проект переименовали (PATCH на любом экземпляре) — имя в шапке живое
        projectSummary(msg.project);
        break;
      case 'gone':
        if (!ready) { ready = true; online = true; if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; } }
        if (inflight) clearInflight();   // очередь досылается с начала поверх снимка
        gone(msg.snapshot, msg.head_seq, msg.epoch);
        if (isNum(msg.head_seq) && msg.head_seq > confirmed.seq) catchUp();
        else sendNext();
        break;
      case 'error': {
        const code = String(msg.code || 'error');
        // эпоха сменилась — следом сервер закроет сокет кодом 4410, реплика переоткроется сама
        if (code === 'epoch') { epochMoved = true; break; }
        // «уже записана» (сервер считает клиента прежним, §9.9) — то же, что ack
        if (code === 'duplicate' && msg.existing === true) { takeAck(msg); break; }
        // I3: проекта больше нет — очередь не трогаем (ни эту транзакцию), сокет закрываем, редкие попытки
        if (code === 'not_found' || code === 'not-found') { markNotFound(); break; }
        const i = msg.tx_id ? pending.findIndex((p) => p.tx_id === msg.tx_id) : -1;
        const tx = i >= 0 ? pending[i] : null;
        // круг 41 (UX Д7): проект записан движком новее экземпляра — 503 cause:'engine', не «недоступен»
        const stale = staleEngineOf(msg);
        if (stale !== undefined || /engine|426/i.test(code)) {
          // правка не отвергнута, а ждёт версии: в очереди, «в полёте» не числится (уйдёт после)
          if (tx && inflight === tx.tx_id) clearInflight();
          const se = stale !== undefined ? stale
            : isNum(msg.engine) ? msg.engine : msg.detail && isNum(msg.detail.engine) ? msg.detail.engine : null;
          markEngine(se);
          break;
        }
        // прежний сервер не говорил retryable — тогда судим по коду
        const retryable = typeof msg.retryable === 'boolean' ? msg.retryable : /unavailable|busy|internal|timeout/i.test(code);
        const wait = isNum(msg.retry_after) ? Math.min(msg.retry_after, RETRY_AFTER_MAX) * 1000 : 0;
        if (retryable && !halted && storageFailure(msg)) {
          /* J4: хранилище сервера лежит — правка не «отравлена» (в счёт снятия не идёт), ждёт
             в очереди; статус — «сервер не может сохранить»; повтор — с растущей паузой, а
             раньше — как только health скажет, что хранилище вернулось */
          serverWait = Math.max(serverWait, wait);
          if (tx && inflight === tx.tx_id) clearInflight();
          markStorageDown();
          if (tx) {
            if (poison && poison.tx_id === tx.tx_id) poison = null;
            storageTries += 1;
            scheduleResend(Math.max(wait, Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(storageTries - 1, 12)))));
          }
          emitStatus();
          break;
        }
        if (retryable && !halted) {
          // сервер занят или хранилище недоступно: транзакция остаётся в очереди и уйдёт позже
          serverWait = Math.max(serverWait, wait);
          if (tx && inflight === tx.tx_id) clearInflight();
          if (tx) {
            const n = notePoison(tx, code);
            if (n >= RETRY_POISON && poison.alive) giveUp(i, code, msg);
            else if (n >= RETRY_POISON) probePoison(tx);
            else scheduleResend(wait || Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.max(0, n - 1))));
          }
          emitStatus();
          break;
        }
        if (tx && !halted) {
          // форма транзакции негодна — повтор ничего не изменит: снимаем её с очереди
          pending.splice(i, 1);
          if (inflight === tx.tx_id) clearInflight();
          replayAll();
          scheduleWrite();
          call(o.onChange, view, { reason: 'error', tx });
        }
        call(o.onError, { code, message: String(msg.message || ''), tx, ...(error === 'engine' ? { engine: serverEngine } : {}) });
        emitStatus();
        sendNext();
        break;
      }
      case 'presence': {
        if (!msg.client || msg.client === clientId) break;
        // новичок объявился — ответим своим присутствием, иначе он о нас не узнает,
        // пока мы что-нибудь не выделим (сервер списка присутствующих не хранит)
        const newcomer = !others.has(String(msg.client));
        const entry = {
          client: String(msg.client),
          author: String(msg.author || ''),
          selection: Array.isArray(msg.selection) ? msg.selection.filter((x) => typeof x === 'string').slice(0, LIMITS.presenceSelection) : [],
          board: typeof msg.board === 'string' ? msg.board : null,
          // время получения: часы сервера и вкладки не сверены, а TTL считается здесь
          at: Date.now(),
        };
        if (msg.truncated === true) entry.truncated = true;
        if (isFlag(msg.busy)) entry.busy = msg.busy;
        if (isFlag(msg.queued)) entry.queued = msg.queued;
        others.set(String(msg.client), entry);
        emitPresence();
        if (newcomer) presence(presenceLast, true);
        break;
      }
      case 'left':
        if (msg.client && others.delete(String(msg.client))) emitPresence();
        break;
      case 'presence_batch': {
        /* Круг 33 (DOC): присутствие за тик одним кадром — те же presence/left по порядку; своё
           отбрасывается по client, как и в одиночном кадре. Оболочке — одно уведомление на кадр,
           а не по одному на участника (в комнате на 150 это 150 перерисовок рамок). */
        const items = Array.isArray(msg.items) ? msg.items.slice(0, PRESENCE_BATCH_MAX) : [];
        presenceHold = 0;
        presenceHolding = true;
        try {
          for (const it of items) {
            if (it && typeof it === 'object' && (it.type === 'presence' || it.type === 'left')) handleMessage(it);
          }
        } finally {
          presenceHolding = false;
        }
        if (presenceHold) emitPresence();
        break;
      }
      default:
        break;
    }
  }

  /* ---- присутствие ---- */

  /** Чужие без вестей дольше TTL — ушли (сервер скажет left сам; это — на случай, если не сказал). */
  function sweepOthers() {
    const now = Date.now();
    let changed = false;
    for (const [k, p] of others) if (now - p.at > presenceTtl) { others.delete(k); changed = true; }
    return changed;
  }

  function emitPresence() {
    if (presenceHolding) { presenceHold += 1; return; }
    sweepOthers();
    call(o.onPresence, [...others.values()].map((p) => ({ ...p, selection: p.selection.slice() })));
  }

  function sendPresence() {
    if (!presenceLast || !socketOpen() || !ready) return;
    presenceSentAt = Date.now();
    presenceSentKey = JSON.stringify([presenceLast, author]);
    const msg = { type: 'presence', selection: presenceLast.selection, board: presenceLast.board, author };
    if (isFlag(presenceLast.busy)) msg.busy = presenceLast.busy;
    if (isFlag(presenceLast.queued)) msg.queued = presenceLast.queued;
    sendJson(msg);
  }

  /**
   * Сердцебиение: своё присутствие — раз в heartbeatMs, даже если не менялось (сервер
   * без вестей 45 с объявляет нас ушедшими); заодно уборка протухших чужих.
   */
  function startHeartbeat() {
    stopHeartbeat();
    if (!(heartbeatMs > 0)) return;
    const beat = () => {
      heartbeatTimer = setT(beat, heartbeatMs);
      if (Date.now() - presenceSentAt >= heartbeatMs * 0.9 && !presenceTimer) sendPresence();
      if (sweepOthers()) emitPresence();
    };
    heartbeatTimer = setT(beat, heartbeatMs);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  }

  /**
   * Своё выделение и доска — эфемерно, не чаще 10 раз в секунду; последнее всегда доходит.
   * Оболочка зовёт это на каждой перерисовке, поэтому то же самое, что уже ушло, не шлём.
   */
  function presence(p, force = false) {
    const next = {
      selection: Array.isArray(p && p.selection) ? p.selection.filter((x) => typeof x === 'string').slice(0, LIMITS.presenceSelection) : [],
      board: p && typeof p.board === 'string' ? p.board : null,
    };
    // агент работает над командой этого человека (§9.9): как дала оболочка — булево или число
    if (p && isFlag(p.busy)) next.busy = p.busy;
    if (p && isFlag(p.queued)) next.queued = p.queued;
    if (!force && !presenceTimer && JSON.stringify([next, author]) === presenceSentKey) return;
    presenceLast = next;
    if (presenceTimer) return;
    const wait = PRESENCE_GAP - (Date.now() - presenceSentAt);
    if (wait <= 0) { sendPresence(); return; }
    presenceTimer = setT(() => { presenceTimer = null; sendPresence(); }, wait);
  }

  /* ---- своя правка ---- */

  /**
   * Своя транзакция: применяется к view сразу (оптимистично), встаёт в очередь,
   * пишется в журнал и уходит на сервер, если сокет открыт и ничего не в полёте.
   * Операции с несуществующими узлами (кто-то успел удалить) отбрасываются уже здесь
   * теми же правилами, что на сервере, — это прогноз; окончательный ответ в подтверждении.
   * @returns {{tx: object|null, view: object, applied: object[], dropped: object[]}}
   */
  function commit(opsList, meta = {}) {
    // строки — как их запишет сервер (§9.10): без U+0000 и одиночных суррогатов
    const list = cleanDeep(clone(Array.isArray(opsList) ? opsList : opsList ? [opsList] : [])).filter((op) => op && typeof op === 'object');
    if (!view) return { tx: null, view, applied: [], dropped: list.map((op, index) => ({ index, op, reason: 'invalid' })) };
    for (const op of list) {
      // id создаваемых узлов чеканит клиент (§8.3): без него сервер и мы выдали бы разные
      if (op.op === 'create' && op.node && typeof op.node === 'object' && !op.node.id) op.node.id = core.uid(op.node.type === 'frame' ? 'f' : 'n');
    }
    // пределы сервера (SPEC §9.8): больше — сервер отверг бы целиком, и очередь встала бы
    const refuse = (limit, message) => {
      call(o.onError, { code: 'too_large', message, limit });
      return { tx: null, view, applied: [], dropped: list.map((op, index) => ({ index, op, reason: 'invalid', limit })) };
    };
    if (list.length > LIMITS.opsPerTx) return refuse('ops_per_tx', `в одной правке больше ${LIMITS.opsPerTx} операций — сервер её не примет`);
    let sendList = list;
    // применение и надгробия — одним черновиком (applyBatches): на 19 000 узлах это копия словаря
    const applyOne = (ops) => {
      if (!ops.length) return { doc: view, tombstones: [] };
      const r = applyRun(view, [ops]);
      return r.results[0] ? { doc: view, error: r.results[0].error, tombstones: r.tombstones } : { doc: r.doc, tombstones: r.tombstones };
    };
    let m = core.rebase(view, list, { tombstones: viewTomb });
    let res = applyOne(m.ops);
    // документ упёрся бы в предел узлов: как на сервере — остаются только remove
    const nodesOf = (d) => (d && d.nodes ? Object.keys(d.nodes).length : 0);
    // число узлов растёт только от create (Object.keys на 19 000 узлах — не на каждую правку)
    const grows = list.some((op) => op.op === 'create');
    if (grows && !res.error && nodesOf(res.doc) > LIMITS.docNodes && nodesOf(res.doc) > nodesOf(view)) {
      const extra = [];
      sendList = [];
      list.forEach((op, index) => {
        if (op.op === 'remove') sendList.push(op);
        else extra.push({ index, op, reason: 'invalid', limit: 'doc_nodes' });
      });
      m = core.rebase(view, sendList, { tombstones: viewTomb });
      m = { ...m, dropped: [...extra, ...m.dropped] };
      res = applyOne(m.ops);
    }
    if (!m.ops.length) return { tx: null, view, applied: [], dropped: m.dropped };
    const tx = {
      tx_id: core.uid('tx'),
      base_seq: confirmed.seq,
      ops: sendList,
      engine: core.ENGINE_VERSION,
      client: clientId,
      author_kind: meta.author_kind === 'agent' || meta.author_kind === 'system' ? meta.author_kind : 'human',
    };
    if (author) tx.author = cleanText(author);
    if (meta.title) tx.title = cleanText(String(meta.title).slice(0, 200));
    if (typeof meta.command_id === 'string' && meta.command_id && meta.command_id.length <= COMMAND_ID_CHARS && isCleanText(meta.command_id)) tx.command_id = meta.command_id;
    if (meta.undo_of) tx.undo_of = String(meta.undo_of);
    if (meta.redo_of) tx.redo_of = String(meta.redo_of);
    /* Круг 31 (K1): часть большой отмены/повтора — {i, n}. С круга 32 сервер её хранит и
       отдаёт (рассылка, /history): оболочка по ней сводит части одного шага истории, а другие
       участники видят незавершённую серию (круг 33, L2). */
    const part = meta.undo_part;
    if (part && Number.isInteger(part.i) && Number.isInteger(part.n) && part.n > 1 && part.i >= 0 && part.i < part.n) tx.undo_part = { i: part.i, n: part.n };
    let bytes = 0;
    try { bytes = new TextEncoder().encode(JSON.stringify(tx)).length; } catch { bytes = 0; }
    if (bytes > LIMITS.txBytes) return refuse('tx_bytes', 'правка больше 4 МБ — сервер её не примет');
    pending.push(tx);
    // инкрементально — ровно то, что сделало бы полное переигрывание последним шагом
    for (const [id, p] of res.tombstones) viewTomb.set(id, p);
    if (res.error) { report('commit', res.error); replayAll(); } else {
      view = res.doc;
      // прогноз этой транзакции — её применённая форма поверх прежнего view
      if (plan && plan.doc === confirmed.doc && plan.seq === confirmed.seq && plan.ops.length === pending.length - 1) plan.ops.push(m.ops);
      else plan = null;
    }
    scheduleWrite();
    emitStatus();
    sendNext();
    return { tx, view, applied: m.ops, dropped: m.dropped };
  }

  /* ---- открытие и закрытие ---- */

  /**
   * Сначала локальный журнал → onChange(view) сразу, потом сокет. Без локальной
   * копии — снимок с сервера (GET /api/projects/:id) и только потом сокет; сервер
   * недоступен — статус «сервер недоступен», пробуем снова с той же паузой, что и сокет.
   */
  async function open() {
    if (opened) return view;
    opened = true;
    let local = false;
    if (storage) {
      try { local = await loadLocal(); } catch (e) { report('journal', e); local = false; }
    }
    if (closed) return null;
    if (local) {
      replayAll();
      call(o.onChange, view, { reason: 'open', from: 'local', extra: extraLoaded });
      emitStatus();
      scheduleWrite();
      connect();
      return view;
    }
    // локальной копии нет: без снимка сервера показывать нечего
    let guard = 0;
    while (!closed) {
      try {
        const ok = await loadFromServer({ opening: true });
        if (!ok) return null;   // проекта нет — оболочке сказано через onError
        // проект снова читается (экземпляр обновился) — отказ по версии позади; hello подтвердит
        if (error === 'engine' && staleOpen) { engineCaughtUp(); staleOpen = false; }
        error = null;
        break;
      } catch (e) {
        /* круг 31: сервер недоступен или его база лежит — это состояние (о нём говорит статус),
           а не сбой кода: в консоль предупреждением, один раз за серию повторов */
        if (e && (Number.isFinite(e.status) || e instanceof TypeError)) {
          if (!guard) { try { console.warn(`[sync:open] сервер не отдал проект (${e.status || 'нет связи'}) — пробую снова`); } catch { /* консоли нет */ } }
        } else report('open', e);
        // круг 41 (UX Д7): проект записан другой версией движка — это не «недоступен»
        const byEngine = !!(e && e.engine !== undefined);
        if (byEngine) { markEngine(e.engine); staleOpen = true; }
        else error = 'unreachable';
        emitStatus();
        /* версия: сервер старее — перепроверка health разбудит открытие (armEngineCheck), а
           повтор открытия — не чаще раза в engineRecheckMs; клиент старее — так же редко */
        const delay = byEngine ? jitter(engineRecheckMs)
          : Math.max(jitter(Math.min(reconnectMax, reconnectMin * Math.pow(2, Math.min(guard++, 12)))), serverWait);
        serverWait = 0;
        await new Promise((r) => {
          openRetry = () => { openRetry = null; r(); };
          setT(() => { if (openRetry) { openRetry = null; r(); } }, delay);
        });
      }
    }
    if (closed) return null;
    call(o.onChange, view, { reason: 'open', from: 'server' });
    emitStatus();
    connect();
    return view;
  }

  /** Переподключиться сейчас (окно вернулось в сеть) — без ожидания паузы. */
  function reconnect() {
    if (closed) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    attempt = 0;
    // open() ждёт паузу перед новой попыткой взять снимок — не ждать
    if (openRetry) { const wake = openRetry; openRetry = null; wake(); return; }
    if (!socketOpen()) connect();
  }

  /**
   * Сеть пропала (событие offline у окна): открытый сокет об этом узнает не сразу —
   * TCP молчит до таймаута, и всё это время статус врал бы «в сети». Закрываем сами:
   * onclose переведёт в офлайн, правки лягут в очередь, а переподключение начнётся
   * по паузе или по событию online.
   */
  function offline() {
    if (closed) return;
    const ws = socket;
    if (!ws) return;
    connectFailed = true;
    try { ws.close(); } catch { /* уже закрыт */ }
    // некоторые реализации не зовут onclose при закрытии без сети — переводим сами
    if (socket === ws) {
      socket = null;
      dropSocketState();
      scheduleReconnect();
    }
  }

  function close() {
    closed = true;
    if (engineTimer) { clearTimeout(engineTimer); engineTimer = null; }
    if (connectGrace) { clearTimeout(connectGrace); connectGrace = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    if (idleHealthTimer) { clearTimeout(idleHealthTimer); idleHealthTimer = null; }
    if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null; }
    stopHeartbeat();
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; }
    clearInflight();
    const ws = socket;
    socket = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* уже закрыт */ } }
    online = false;
    const p = flush();
    if (docTimer) { clearTimeout(docTimer); docTimer = null; }
    return p;
  }

  return {
    open, close, commit, presence, reconnect, offline, flush,
    /** отметить журнал изменённым (оболочка поменяла то, что кладёт в extra) */
    touch: () => scheduleWrite(),
    setAuthor: (name) => { author = String(name || ''); if (presenceLast) sendPresence(); },
    get view() { return view; },
    get confirmed() { return confirmed; },
    get pending() { return pending.slice(); },
    get status() { return statusFull(); },
    get tip() { return tip; },
    get epoch() { return epoch; },
    get mine() { return mine.map((m) => ({ tx_id: m.tx.tx_id, seq: m.seq, epoch: m.epoch, at: m.at, author_kind: m.tx.author_kind || 'human' })); },
    /** Правки, снятые «не сохранено» (сервер раз за разом не мог записать): {tx_id, title, cause, message, at}. */
    get unsaved() { return unsaved.map((u) => ({ tx_id: u.tx.tx_id, title: u.tx.title || '', cause: u.cause, message: u.message, at: u.at })); },
    retryUnsaved,
    /** Последние подтверждённые транзакции, новые первыми (≤ 500 в памяти). */
    journal,
    /** Кто удалил узел: {author, author_kind, seq, title} или null. */
    whoRemoved,
    /** Кто чужой переписал лист операции позже seq (круг 31): {author, author_kind, seq, title} или null. */
    whoChanged,
    /**
     * Круг 31: оболочка получила от сервера 503 «хранилище недоступно» на своём HTTP-запросе
     * (переименование, список проектов) — статус тот же, что от отказа записи: «сервер не может
     * сохранить», пока health или запись не скажут иное.
     */
    storageFailed: () => markStorageDown(),
    /** Надгробия подтверждённых: [id, seq удаления] в порядке удаления (тесты, отладка; круг 29). */
    tombstoneIds: () => [...tombSeq],
    get extra() { return extraLoaded; },
    get clientId() { return clientId; },
    get projectId() { return projectId; },
    get author() { return author; },
    get others() { return [...others.values()]; },
  };
}
