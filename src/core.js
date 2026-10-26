/**
 * Imago Studio — core.js
 * Документ, операции, решатель геометрии, валидаторы, сцена (SVG + ввод).
 * Один ES-модуль без зависимостей и сборки. Работает как <script type="module">.
 *
 * Экспортируемый контракт (SPEC §1.1):
 *   createDoc, applyOps, invertOps, solve, validate, Stage, ops
 * Дополнительно (нужно app.js / brain.js):
 *   nodeById, ancestors, isArtboard, cloneSubtree, resolveTarget, hashGeometry,
 *   artboards, resolveColor, resolveTextStyle, contrastRatio, NODE_TYPES, DEFAULT_TOKENS
 *   Компоненты (круг 19, SPEC §5):
 *     ensureLibrary(doc) — МИГРАЦИЯ: документ без библиотеки приводится к нынешнему
 *       виду одним вызовом (идемпотентно, вход не мутируется). Звать после загрузки
 *       из `db` и после импорта JSON; createDoc его не зовёт сам — импорт сверяет
 *       узлы разобранного документа с узлами файла и счёл бы библиотеку чужим узлом.
 *     components(doc) → словарь компонентов (brain строит из него блок «БИБЛИОТЕКА»),
 *       componentSignature / instanceSummary — строки §5.9;
 *     canMakeComponent / makeComponentOps / instanceOps / detachInstanceOps —
 *       возвращают ОПЕРАЦИИ, документ не меняют: оболочка применяет их транзакцией;
 *     solve(doc).expanded — раскрытые узлы экземпляров (в doc.nodes их нет).
 *   Шкалы как ссылки (круг 20, SPEC §6):
 *     layout.gap, layout.padding.* и radius хранятся числом ЛИБО ссылкой на шаг
 *       шкалы — 'spacing.<i>' / 'radii.<i>'. Число даёт ТОЛЬКО resolveScale
 *       (обёртки resolveLayout, resolveRadius); читать поля как числа нельзя.
 *     ensureScaleRefs(doc) — МИГРАЦИЯ: точные совпадения со шкалой → ссылки,
 *       идемпотентно, без мутации входа; звать рядом с ensureLibrary.
 *     keepFieldForm — правило «то же самое» (§6.4), его зеркалит мозг.
 *     insertScaleStep / rewriteScaleRefsOps / scaleRefsIn — правки шкалы со
 *       сдвигом ссылок; возвращают операции, отменяются как всё остальное.
 *   resetMeasureCache, measureEpoch, onMeasureEpoch — кеш измерений текста:
 *     ширины живут между вызовами solve, и без сброса первая раскладка, померенная
 *     системным шрифтом, залипает навсегда. Модуль сбрасывает кеш сам по событиям
 *     загрузки гарнитур; оболочке остаётся пересчитать геометрию — по своему
 *     document.fonts.ready (наш сброс встаёт в очередь раньше) или по onMeasureEpoch.
 */

/* ------------------------------------------------------------------ *
 * 0. Мелкие утилиты
 * ------------------------------------------------------------------ */

/** @type {Set<string>} */
const NODE_TYPES = new Set(['page', 'frame', 'text', 'rect', 'ellipse', 'image', 'instance', 'vector']);
const CONTAINER_TYPES = new Set(['page', 'frame']);
/* Круг 19 (SPEC §5): компоненты. Мастер — узел в библиотеке с полем `component`,
   экземпляр — узел типа `instance` со ссылкой `of` и значениями пропсов. Детей у
   экземпляра нет: его содержимое раскрывает решатель (см. expandDoc). */
/** Роль узла-библиотеки: второй потомок корня, НЕ доска (SPEC §5.3). */
const LIBRARY_ROLE = 'library';
/** Виды пропсов мастера (SPEC §5.4). */
const PROP_KINDS = new Set(['text', 'enum', 'color', 'number', 'bool']);
/**
 * Предел вложенности экземпляров (SPEC §5.6 требует предел и просит его назвать).
 * Восемь: живой словарь — это «кнопка внутри карточки внутри списка внутри экрана»,
 * то есть 3–4 уровня; восемь даёт двойной запас и при этом держит раскрытие
 * конечным, даже если валидатор о цикле почему-то промолчал.
 */
const MAX_INSTANCE_DEPTH = 8;
/**
 * Круг 39 (N2; работа круга 35, перенесена и проверена заново): предел числа
 * РАСКРЫТЫХ узлов на документ — сумма по всем экземплярам, см. expandCost. Одна
 * глубина 8 раскрытие не держит: цепочка из 9 мастеров по W экземпляров
 * следующего даёт W⁸ узлов (документ в 37 КБ — 204 тыс. раскрытых узлов, solve
 * 32 с и 1,4 ГБ; вкладка каждого участника проекта падала). Правка или импорт,
 * после которых раскрытие вышло бы за предел, не проходят
 * (`limit:'expand_nodes'`); документ, уже бывший сверх предела, открывается
 * деградированным: часть экземпляров — заглушки, validate — `expand-limit`.
 */
const MAX_EXPANDED_NODES = 50000;
/**
 * Документ сверх MAX_EXPANDED_NODES: раскрываются только экземпляры не дороже
 * этого (по порядку документа, пока сумма в пределе) — мелочь вроде кнопок
 * видна, а ветки «бомбы» остаются заглушками, и решатель укладывается в доли
 * секунды.
 */
const DEGRADED_INSTANCE_NODES = 2000;
/** Имя нарушенного предела раскрытия — в ошибках applyOps, dropped rebase и отказе импорта. */
const EXPAND_LIMIT = 'expand_nodes';
/** Верхний уровень пути, который set никогда не меняет: на этом стоит дерево. */
const PROTECTED_PATHS = new Set(['id', 'type', 'parent', 'children', '__proto__', 'prototype', 'constructor']);
/** Ключи прототипа: запрещены на любом уровне пути — иначе у узла появляются свойства «из ниоткуда». */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
/**
 * Круг 25: имена свойств Object.prototype (`constructor`, `toString`, `__proto__`…)
 * id узла быть не могут. Словарь `doc.nodes` — обычный объект: `nodes['constructor']`
 * без проверки «своего» свойства находил функцию Object, и `remove constructor`
 * проходил как применённый (с надгробием), а `nodes['__proto__'] = узел` подменял
 * прототип словаря. Поиск узла по чужому id — только через `ownNode`.
 */
const PROTO_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype).concat(['__proto__']));
const hasOwnProp = Object.prototype.hasOwnProperty;
/** Годится ли значение в id узла: непустая строка, не ключ прототипа. */
const isNodeId = (v) => typeof v === 'string' && v !== '' && !PROTO_KEYS.has(v);
/** Узел словаря по id — только собственное свойство и только по строке. */
const ownNode = (nodes, id) => (nodes && typeof id === 'string' && hasOwnProp.call(nodes, id) ? nodes[id] : undefined);
const LAYOUT_MODES = new Set(['none', 'row', 'column']);
const ALIGNS = new Set(['start', 'center', 'end', 'stretch']);
const JUSTIFIES = new Set(['start', 'center', 'end', 'between']);
const SIZE_MODES = new Set(['fixed', 'hug', 'fill']);
const MAX_SIZE = 100000;
/** Предел глубины дерева: страховка от циклов и патологически глубоких документов. */
const MAX_DEPTH = 256;

/**
 * Версия формата движка (SPEC §8.3): в каждой транзакции и снимке. Меняется,
 * когда старый журнал перестаёт применяться без миграции — или когда движок
 * прежней версии уже не может прочесть то, что пишет нынешний.
 *
 * Круг 39: 2. Круги 36–37 расширили формат: тип `vector` (контуры, viewBox),
 * `layout.mode 'none'` с `pos` детей, градиенты в краске, `rotate`, `states` и
 * `motion`. Движок 1 такие документы и операции отвергает (`bad-node`) или,
 * хуже, применяет частично — поэтому запись движка 2 экземпляру с движком 1
 * читать нельзя (сервер переводит проект в «устарел», см. SPEC §9).
 * Обратно — можно: всё, что писал движок 1, движок 2 читает и применяет как
 * раньше (формат только расширялся; миграции записей нет).
 *
 * Круг 48: 3. Поле `theme` доски (SPEC §15) меняет, КАК рисуются её узлы: движок 2
 * принял бы его простыми данными и нарисовал доску цветами документа — молча
 * чужой макет. Круг 49: фактура в заливке (SPEC §16) — та же версия. Записи
 * движков 1–2 движок 3 читает через liftOps: поле `theme` у них было простыми
 * данными без действия — оно снимается, и запись применяется как раньше.
 */
const ENGINE_VERSION = 3;
/**
 * Круг 39: самая старая версия движка, записи и снимки которой этот движок
 * читает без миграции. Документ, транзакция журнала или снимок с `engine` в
 * [ENGINE_MIN_READ, ENGINE_VERSION] — читаются; больше ENGINE_VERSION — нет
 * (записаны новым движком, формат может быть шире); меньше ENGINE_MIN_READ — нет
 * (нужна миграция, которой у этого движка нет).
 */
const ENGINE_MIN_READ = 1;

/**
 * Круг 39: может ли этот движок прочесть запись журнала / снимок с такой
 * версией. `undefined` (записи до введения поля) читается как 1.
 * @param {any} engine
 * @returns {boolean}
 */
function engineReadable(engine) {
  const v = engine === undefined || engine === null ? 1 : engine;
  return Number.isInteger(v) && v >= ENGINE_MIN_READ && v <= ENGINE_VERSION;
}

let uidCounter = 0;
const UID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/**
 * Глобально уникальный идентификатор (SPEC §8.3, круг 22): id узлов и
 * транзакций генерирует клиент, и два клиента не должны столкнуться —
 * 12 случайных символов base36 (~62 бита) из криптографического источника плюс
 * счётчик процесса как страховка от повторов в одном процессе. Длиннее нельзя
 * без причины: id ходят в выжимке документа к модели, и каждый символ — токены
 * на каждой команде. На проект в сто тысяч узлов вероятность столкновения ~10⁻⁹.
 * Префикс — только для читаемости («f_» у фреймов).
 * @param {string} [prefix]
 * @returns {string}
 */
function uid(prefix = 'n') {
  uidCounter += 1;
  let rnd = '';
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(12);
    c.getRandomValues(bytes);
    for (let i = 0; i < 12; i++) rnd += UID_ALPHABET[bytes[i] % 36];
  } else {
    for (let i = 0; i < 12; i++) rnd += UID_ALPHABET[Math.floor(Math.random() * 36)];
  }
  return prefix + '_' + rnd + uidCounter.toString(36);
}

/**
 * Округление до сотых — держит решатель детерминированным.
 * Нечисло и бесконечность превращаются в конечное значение: геометрия с NaN
 * залипает навсегда (вид не восстановить из интерфейса), а ноль и предел видно
 * глазами и можно исправить руками. Через r2 проходит каждое число геометрии.
 */
const r2 = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 0 : (n > 0 ? MAX_SIZE : -MAX_SIZE);
  return Math.round((n + Number.EPSILON) * 100) / 100;
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Зажим в границы. NaN даёт lo, ±Infinity — соответствующую границу: NaN наружу не уходит. */
const clamp = (v, lo, hi) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
};
/** Число в границах либо `fb`: одна точка, где негодная величина становится безопасной. */
const numIn = (v, lo, hi, fb) => (isNum(v) ? clamp(v, lo, hi) : fb);

/**
 * Круг 29: чужое значение — в текст сообщения. `${x}` на объекте `{toString:1}`
 * бросает («Cannot convert object to primitive value»): вместо причины отказа
 * человек получал «негодное значение», а решатель, споткнувшись о такое поле,
 * вставал совсем. Строка — как есть (обрезанная), число и булево — как есть,
 * прочее — словом. Не бросает никогда.
 * @param {any} v @returns {string}
 */
function shown(v) {
  if (typeof v === 'string') return cutText(v, 200);
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return 'массив';
  if (typeof v === 'object') return 'объект';
  return typeof v;
}

/** Строковое поле чужого узла без приведения: не строка — пусто. @returns {string} */
const strOf = (v) => (typeof v === 'string' ? v : '');
/** Текст для измерения и показа: строка, число строкой, прочее — пусто. Не бросает. */
const textOf = (v) => (typeof v === 'string' ? v : isNum(v) ? String(v) : '');

/**
 * Максимум и минимум по списку — без spread. `Math.max(...arr)` раскладывает
 * массив в аргументы и на длине от ~130 000 роняет стек («Maximum call stack size
 * exceeded»): из интерфейса столько узлов в одной строке не набрать, но падать на
 * чужом документе раскладке незачем. Пустой список даёт `seed`.
 * @param {Array} list @param {Function} pick @param {number} seed
 */
function maxOf(list, pick, seed) {
  let m = seed;
  for (let i = 0; i < list.length; i++) {
    const v = pick(list[i], i);
    if (v > m) m = v;
  }
  return m;
}
/** Минимум по списку — зеркало maxOf. */
function minOf(list, pick, seed) {
  let m = seed;
  for (let i = 0; i < list.length; i++) {
    const v = pick(list[i], i);
    if (v < m) m = v;
  }
  return m;
}

/** Глубокая копия простых данных (узлы — только JSON-совместимые значения). */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  // ключи прототипа в документе не бывают осмысленными, а JSON.parse делает их
  // собственными свойствами — копировать их значит подменить прототип узла
  for (const k of Object.keys(value)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = deepClone(value[k]);
  }
  return out;
}

/**
 * Круг 25: строка не длиннее `n` КОДОВЫХ ТОЧЕК. `s.slice(0, n)` режет по
 * UTF-16-единицам и разрывает суррогатную пару (эмодзи) — остаётся одиночный
 * суррогат, невалидный UTF-8: Postgres отказывает в записи jsonb, а на экране «U+FFFD».
 * Не строка — приводится к строке (null/undefined → '').
 * @param {any} s @param {number} n
 * @returns {string}
 */
function cutText(s, n) {
  const str = typeof s === 'string' ? s : s === null || s === undefined ? '' : String(s);
  const max = isNum(n) ? Math.max(0, Math.floor(n)) : Infinity;
  if (str.length <= max) return str;   // кодовых точек не больше, чем единиц UTF-16
  let i = 0;
  let count = 0;
  while (i < str.length && count < max) {
    const c = str.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    i += pair ? 2 : 1;
    count++;
  }
  return str.slice(0, i);
}

const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/**
 * Круг 25: строка, которую можно записать куда угодно (jsonb Postgres, сокет,
 * IndexedDB): без `\u0000` (jsonb его не принимает), одиночные суррогаты → U+FFFD.
 * Не строка возвращается как есть — так её можно звать на любом значении.
 * @template T @param {T} s @returns {T}
 */
function cleanText(s) {
  if (typeof s !== 'string') return s;
  let out = s.indexOf('\u0000') >= 0 ? s.replace(/\u0000/g, '') : s;
  if (typeof out.isWellFormed === 'function') {
    if (!out.isWellFormed()) out = out.toWellFormed();
  } else {
    out = out.replace(LONE_SURROGATE_RE, '\uFFFD');
  }
  return out;
}

/**
 * Круг 27: ключ объекта после чистки (как cleanText) — или `null`, если ключ
 * опасен: `__proto__`, `prototype`, `constructor`. Проверяется ПОСЛЕ чистки:
 * `"__proto__\u0000"` безобиден, пока в нём U+0000, а очищенный становится
 * `__proto__`, и запись `out[k2] = v` в обычный объект подменила бы прототип
 * (вместо данных — чужие свойства «из ниоткуда»). Такой ключ отбрасывается
 * вместе со значением — как deepClone отбрасывает ключи прототипа. Не строка
 * приводится к строке. Одна функция на всех, кто чистит ключи рекурсивно
 * (сервер — limits.cleanDeep, реплика — sync.cleanDeep).
 * @param {any} k
 * @returns {string|null}
 */
function cleanKey(k) {
  const s = cleanText(typeof k === 'string' ? k : String(k));
  return UNSAFE_KEYS.has(s) ? null : s;
}

let loggedOnce = new Set();
/** Предел памяти логгера: ключи включают id узлов, за долгую сессию их набегает сколько угодно. */
const LOG_KEY_LIMIT = 400;
/** Логируем каждую уникальную ошибку один раз — не глотаем и не спамим. */
/** Круг 45: >0 — логгер молчит (прогон проб отпечатка формата: тысячи заведомых отказов). */
let logQuiet = 0;
function logOnce(key, ...args) {
  if (logQuiet > 0 || loggedOnce.has(key)) return;
  // старые ключи вытесняются по одному: множество не растёт, а редкая повторная
  // запись через сотни разных ошибок — меньшее зло, чем утечка на весь сеанс
  while (loggedOnce.size >= LOG_KEY_LIMIT) {
    const oldest = loggedOnce.values().next().value;
    if (oldest === undefined) break;
    loggedOnce.delete(oldest);
  }
  loggedOnce.add(key);
  if (typeof console !== 'undefined' && console.warn) console.warn('[imago/core]', ...args);
}

/** Иммутабельная запись по пути; value === undefined удаляет ключ. */
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  const root = Array.isArray(obj) ? obj.slice() : { ...obj };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    cur[p] = next && typeof next === 'object'
      ? (Array.isArray(next) ? next.slice() : { ...next })
      : {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = deepClone(value);
  return root;
}

/* ------------------------------------------------------------------ *
 * 1. Токены документа (SPEC §3): светлый холст, оранжевый акцент
 * ------------------------------------------------------------------ */

const DEFAULT_TOKENS = Object.freeze({
  colors: {
    canvas: '#F7F6F3',
    surface: '#FFFFFF',
    surfaceAlt: '#F2F0EC',
    line: '#E2DED6',
    text: '#14161C',
    muted: '#5B6270',
    accent: '#FF6B3D',
    accentSoft: '#FFE7DE',
    accentInk: '#B03A12',
    onAccent: '#14161C',
    agent: '#38D6B0',
    good: '#1F7A5A',
    warn: '#F0B429'
  },
  type: {
    display: { font: 'IBM Plex Sans', fontSize: 34, fontWeight: 600, lineHeight: 40, letterSpacing: -0.4 },
    title: { font: 'IBM Plex Sans', fontSize: 24, fontWeight: 600, lineHeight: 30, letterSpacing: -0.2 },
    heading: { font: 'IBM Plex Sans', fontSize: 18, fontWeight: 600, lineHeight: 24 },
    body: { font: 'IBM Plex Sans', fontSize: 15, fontWeight: 400, lineHeight: 22 },
    caption: { font: 'IBM Plex Sans', fontSize: 13, fontWeight: 400, lineHeight: 18 },
    mono: { font: 'IBM Plex Mono', fontSize: 13, fontWeight: 500, lineHeight: 18 },
    monoLg: { font: 'IBM Plex Mono', fontSize: 15, fontWeight: 500, lineHeight: 20 }
  },
  spacing: [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64],
  radii: [0, 4, 8, 12, 16, 20, 24, 999]
});

/* ------------------------------------------------------------------ *
 * 2. Схема и нормализация узлов
 * ------------------------------------------------------------------ */

const DEFAULT_LAYOUT = Object.freeze({
  mode: 'none', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 },
  align: 'start', justify: 'start', wrap: false
});
const PAD_KEYS = ['t', 'r', 'b', 'l'];

/* ------------------------------------------------------------------ *
 * 2a. Шкалы как ссылки (круг 20, SPEC §6)
 *
 * Отступ и скругление в документе — либо число («мимо шкалы»), либо ССЫЛКА
 * на шаг шкалы: строка 'spacing.<i>' для layout.gap и layout.padding.{t,r,b,l},
 * 'radii.<i>' для radius (и его покорнерного массива), где i — позиция в
 * tokens.spacing / tokens.radii. Индекс, а не имя и не значение: индексы
 * устойчивы при самой частой правке шкалы — смене значений шагов (§6.1), и
 * ровно ради этого всё делается: `setToken spacing.6 = 20` переверстывает
 * всё, что ссылается на шестой шаг, без единой правки узлов.
 *
 * Читать layout.gap или radius как число напрямую больше нельзя нигде (§6.3):
 * решатель, валидатор, сцена, экспорт, мозг и оболочка идут через resolveScale
 * либо его обёртки resolveLayout / resolveRadius. Тест на демо-документе, где
 * все отступы и скругления — ссылки, ловит любое прямое чтение.
 *
 * Живость ссылки (есть ли такой шаг) — свойство ДОКУМЕНТА, а не узла: шкалу
 * можно укоротить одним setToken, и ссылки умрут без правки узлов. Поэтому
 * схема (checkNode) проверяет только ФОРМУ ссылки и её шкалу, живость
 * проверяет операция, которая ссылку пишет (create/set → bad-node), а всё,
 * что уже лежит в документе — из файла или после укорочения шкалы, — ловит
 * валидатор кодом dead-scale-ref (error). Так узел с мёртвой ссылкой остаётся
 * правимым (заливка, имя), а решатель считает мёртвый шаг нулём.
 * ------------------------------------------------------------------ */

/** Шкалы, на шаги которых можно ссылаться, и их имена для человека (§6.7). */
const SCALE_NAMES = Object.freeze({ spacing: 'шкала отступов', radii: 'шкала скруглений' });
/** Те же имена в винительном и предложном падежах — для сообщений об ошибках. */
const SCALE_CASES = Object.freeze({
  spacing: { acc: 'шкалу отступов', loc: 'шкале отступов' },
  radii: { acc: 'шкалу скруглений', loc: 'шкале скруглений' }
});
/** Форма ссылки: имя шкалы, точка, неотрицательное целое без ведущих нулей. */
const SCALE_REF_RE = /^(spacing|radii)\.(0|[1-9]\d*)$/;

/**
 * Разбор ссылки на шаг шкалы.
 * @param {any} value
 * @returns {{scale:string, index:number}|null} null — это не ссылка
 */
function parseScaleRef(value) {
  if (typeof value !== 'string') return null;
  // разных строк-ссылок в документе десятки, а разборов на solve — тысячи
  // (по пять на каждый фрейм): результат разбора помним, регулярку не гоняем
  let hit = refParseCache.get(value);
  if (hit === undefined) {
    const m = SCALE_REF_RE.exec(value);
    hit = m ? { scale: m[1], index: Number(m[2]) } : null;
    if (refParseCache.size >= REF_CACHE_LIMIT) refParseCache.clear();
    refParseCache.set(value, hit);
  }
  // наружу — своя копия: соседи вправе менять её, кеш от этого не должен портиться
  return hit && { scale: hit.scale, index: hit.index };
}
/** Кеш разбора ссылок: строка → {scale,index} | null. Чужие строки (мусор) сюда тоже попадают, поэтому предел. */
const refParseCache = new Map();
const REF_CACHE_LIMIT = 512;

/** Ссылка ли это (при заданной шкале — именно на неё). @returns {boolean} */
function isScaleRef(value, scale) {
  const ref = parseScaleRef(value);
  return !!ref && (scale === undefined || ref.scale === scale);
}

/** Строка ссылки: scaleRef('spacing', 6) → 'spacing.6'. @returns {string} */
function scaleRef(scale, index) {
  return scale + '.' + index;
}

/** Шаги шкалы документа; без своей шкалы — умолчания. @returns {number[]} */
function scaleSteps(doc, scale) {
  const own = doc && doc.tokens && doc.tokens[scale];
  return Array.isArray(own) ? own : (DEFAULT_TOKENS[scale] || []);
}

/**
 * ЕДИНСТВЕННАЯ точка, где ссылка становится числом (§6.3).
 * Число возвращается как есть (это значение «мимо шкалы»); ссылка — значением
 * шага; всё остальное — undefined: мёртвая ссылка (шага с таким индексом нет
 * или в нём не число), ссылка не в ту шкалу, мусор. Вызывающий решает, чем
 * заменить undefined: решатель и сцена — нулём, валидатор — ошибкой
 * dead-scale-ref, мозг — предупреждением человеку.
 * @param {object} doc документ (нужны tokens; без них — умолчания)
 * @param {any} value число либо 'spacing.<i>' / 'radii.<i>'
 * @param {string} [scale] какая шкала здесь ожидается ('spacing' | 'radii');
 *   ссылка в другую шкалу — undefined. Без аргумента шкала берётся из ссылки
 * @returns {number|undefined}
 */
function resolveScale(doc, value, scale) {
  if (isNum(value)) return value;
  const ref = parseScaleRef(value);
  if (!ref || (scale !== undefined && ref.scale !== scale)) return undefined;
  const v = scaleSteps(doc, ref.scale)[ref.index];
  return isNum(v) ? v : undefined;
}

/**
 * Индекс шага, ТОЧНО равного числу, или -1 (при дублях — первый). Этим
 * миграция решает, что становится ссылкой (§6.5), а мозг — совпало ли число
 * от модели с шагом шкалы (§6.6).
 * @returns {number}
 */
function scaleIndexOf(doc, scale, value) {
  if (!isNum(value)) return -1;
  return scaleSteps(doc, scale).indexOf(value);
}

/** Отступ или зазор ЧИСЛОМ в границах схемы: ссылка разрешается, мёртвая — 0. */
const scaleNum = (doc, v, scale) => numIn(resolveScale(doc, v, scale), 0, MAX_SIZE, 0);

/**
 * Раскладка узла В ЧИСЛАХ — для решателя, валидатора, сцены и всего, что
 * считает геометрию. Та же форма, что у normalizeLayout, но gap и padding.*
 * здесь всегда числа. Хранить результат в документе нельзя: он теряет ссылки.
 * @param {object} doc
 * @param {any} layout сырое поле layout узла
 * @returns {{mode:string,gap:number,padding:{t:number,r:number,b:number,l:number},align:string,justify:string,wrap:boolean}}
 */
function resolveLayout(doc, layout) {
  const L = normalizeLayout(layout);
  const p = L.padding;
  return {
    ...L,
    gap: scaleNum(doc, L.gap, 'spacing'),
    padding: {
      t: scaleNum(doc, p.t, 'spacing'), r: scaleNum(doc, p.r, 'spacing'),
      b: scaleNum(doc, p.b, 'spacing'), l: scaleNum(doc, p.l, 'spacing')
    }
  };
}

/**
 * Скругление ЧИСЛОМ: ссылка разрешается, мёртвая ссылка и мусор — 0.
 * Покорнерный массив схема принимает, но рисуется он как и прежде — нулём:
 * этот круг форму скругления не меняет, только его запись.
 * @returns {number}
 */
function resolveRadius(doc, radius) {
  return numIn(resolveScale(doc, radius, 'radii'), 0, MAX_SIZE, 0);
}

/**
 * Проверка поля, живущего в шкале: число в границах либо ссылка в НУЖНУЮ
 * шкалу. Живость ссылки здесь не проверяется — см. deadScaleRefs.
 * @returns {string|null} причина или null
 */
function checkScaleValue(v, scale, what) {
  if (isNum(v)) return v < 0 || v > MAX_SIZE ? `${what} вне диапазона` : null;
  const ref = parseScaleRef(v);
  if (!ref) return `${what} вне диапазона`;
  if (ref.scale !== scale) return `${what}: ссылка «${shown(v)}» ведёт не в ${SCALE_CASES[scale].acc} (нужна ${scale}.<шаг>)`;
  return null;
}

/** Скругление по схеме: число, ссылка на radii либо массив таких. @returns {string|null} */
function checkRadiusValue(v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) {
    for (const e of v) {
      const err = checkScaleValue(e, 'radii', 'radius');
      if (err) return err;
    }
    return null;
  }
  return checkScaleValue(v, 'radii', 'radius');
}

/**
 * Ссылки на шкалы в полях ОДНОГО узла: [{path, value, scale}], где scale —
 * шкала, которую это поле ожидает. Числа пропускаются. Единственный перечень
 * «какие поля живут в шкалах и в каких» — им пользуются валидатор
 * (dead-scale-ref), проверка операций и правки шкалы со сдвигом
 * (scaleRefsIn → insertScaleStep); миграция знает те же поля через
 * layoutToRefs / radiusToRefs.
 * @returns {Array<{path:string, value:string, scale:string}>}
 */
function nodeScaleRefs(node) {
  const out = [];
  const take = (path, v, scale) => { if (parseScaleRef(v)) out.push({ path, value: v, scale }); };
  if (!node || typeof node !== 'object') return out;
  const l = node.layout;
  if (l && typeof l === 'object') {
    take('layout.gap', l.gap, 'spacing');
    const p = l.padding;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const k of PAD_KEYS) take('layout.padding.' + k, p[k], 'spacing');
    } else if (Array.isArray(p)) {
      p.forEach((v, i) => take('layout.padding.' + i, v, 'spacing'));
    } else take('layout.padding', p, 'spacing');
  }
  if (Array.isArray(node.radius)) node.radius.forEach((v, i) => take('radius.' + i, v, 'radii'));
  else take('radius', node.radius, 'radii');
  // круг 36 (SPEC §11.1): подъём в состоянии — тоже шаг шкалы отступов. Мёртвый
  // шаг здесь валидатор называет dead-motion-ref (warn), а не dead-scale-ref
  const st = node.states;
  if (st && typeof st === 'object' && !Array.isArray(st)) {
    for (const s of STATE_NAMES) {
      const p = st[s];
      if (p && typeof p === 'object' && !Array.isArray(p)) take('states.' + s + '.lift', p.lift, 'spacing');
    }
  }
  return out;
}

/**
 * Мёртвые ссылки узла: те, что не разрешаются в число для своей шкалы.
 * @param {object} doc @param {object} node
 * @param {string} [under] только пути, равные этому или лежащие под ним ('layout.padding')
 * @returns {Array<{path:string, value:string, scale:string, reason:string}>}
 */
function deadScaleRefs(doc, node, under) {
  const out = [];
  for (const r of nodeScaleRefs(node)) {
    if (under !== undefined && r.path !== under && r.path.indexOf(under + '.') !== 0) continue;
    if (resolveScale(doc, r.value, r.scale) !== undefined) continue;
    const ref = parseScaleRef(r.value);
    const steps = scaleSteps(doc, r.scale);
    const reason = ref.scale !== r.scale
      ? `«${r.value}» — это не ${SCALE_NAMES[r.scale]}`
      : `шага «${r.value}» нет — в ${SCALE_CASES[r.scale].loc} ${steps.length} ${plural(steps.length, 'шаг', 'шага', 'шагов')}`
        + (steps.length ? ` (0..${steps.length - 1})` : '');
    out.push({ ...r, reason });
  }
  return out;
}

/** Склонение по числу: plural(3, 'шаг', 'шага', 'шагов') → 'шага'. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/**
 * Отступы из краткой записи в {t,r,b,l} БЕЗ приведения значений: число или
 * ссылка — на все четыре стороны, [v,h], [t,r,b,l], [v] и объект. Не разобрать —
 * null. Одна функция на normalizeLayout и keepFieldForm: обе должны понимать
 * краткую запись одинаково.
 * @returns {{t:any,r:any,b:any,l:any}|null}
 */
function paddingShorthand(p) {
  if (isNum(p) || parseScaleRef(p)) return { t: p, r: p, b: p, l: p };
  if (Array.isArray(p)) {
    if (p.length === 2) return { t: p[0], r: p[1], b: p[0], l: p[1] };
    if (p.length === 4) return { t: p[0], r: p[1], b: p[2], l: p[3] };
    if (p.length === 1) return { t: p[0], r: p[0], b: p[0], l: p[0] };
    return null;
  }
  if (p && typeof p === 'object') return { t: p.t, r: p.r, b: p.b, l: p.l };
  return null;
}

/**
 * Отступ или зазор в ФОРМЕ ХРАНЕНИЯ: ссылка на шаг (любой шкалы — не в ту
 * шкалу отклонит checkNode, и человек прочтёт причину, а не увидит молчаливый
 * ноль) остаётся ссылкой; число зажимается в границы схемы; мусор → 0.
 */
const spacingField = (v) => (parseScaleRef(v) ? v : numIn(v, 0, MAX_SIZE, 0));

/** @returns {{w:{mode:string,value?:number},h:{mode:string,value?:number}}} */
function sizeSpec(w, h) {
  const one = (v) => {
    if (v === 'hug' || v === undefined || v === null) return { mode: 'hug' };
    if (v === 'fill') return { mode: 'fill' };
    if (isNum(v)) return { mode: 'fixed', value: v };
    if (v && typeof v === 'object' && SIZE_MODES.has(v.mode)) return deepClone(v);
    return { mode: 'hug' };
  };
  return { w: one(w), h: one(h) };
}

/**
 * Раскладка в ФОРМЕ ХРАНЕНИЯ: краткие записи раскрыты, режимы проверены,
 * числа зажаты в границы схемы. Круг 20 (SPEC §6.1): gap и padding.* здесь
 * могут быть ссылками на шаг шкалы — они остаются строками как есть. Числа
 * для геометрии даёт resolveLayout, и только он.
 */
function normalizeLayout(l) {
  const src = l && typeof l === 'object' ? l : {};
  const padding = paddingShorthand(src.padding) || { t: 0, r: 0, b: 0, l: 0 };
  // отступы и зазор приводим к диапазону схемы (0..MAX_SIZE): NaN и 1e308
  // здесь — вторая дверь в нечисловую геометрию, её закрываем на входе
  for (const k of PAD_KEYS) padding[k] = spacingField(padding[k]);
  return {
    mode: LAYOUT_MODES.has(src.mode) ? src.mode : 'none',
    gap: spacingField(src.gap),
    padding,
    align: ALIGNS.has(src.align) ? src.align : 'start',
    justify: JUSTIFIES.has(src.justify) ? src.justify : 'start',
    wrap: !!src.wrap
  };
}

/**
 * Поля, которые узел хранит либо коротким именем токена, либо объектом-обёрткой:
 * `style: 'display'` и `style: {token:'display'}` — одно и то же значение, как и
 * `stroke: 'line'` и `stroke: {color:'line', width:1}`. Ключи перечислены в том
 * порядке, в каком их читают resolveColor/resolveTextStyle.
 */
const WRAPPED_FIELDS = {
  style: ['token'],
  fill: ['token', 'color', 'value'],
  color: ['token', 'color', 'value'],
  stroke: ['color', 'token', 'value']
};

/** Имя токена внутри поля-обёртки (или сама строка). @returns {string|undefined} */
function wrappedName(v, keys) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  for (const k of keys) if (typeof v[k] === 'string') return v[k];
  return undefined;
}

/** Объект, который не несёт ничего сверх обёртки: {token:'x'} — да, {token:'x',fontSize:20} — нет. */
function bareWrapper(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === 1 && keys.indexOf(own[0]) >= 0;
}

/**
 * Круг 16, п.1: одно и то же значение хранилось в документе в двух видах.
 * Модель и инспектор присылают короткое имя токена (`set style='display'`), а в
 * узле значение живёт объектом (`{token:'display'}`) — и запись строки поверх
 * объекта меняла ОТПЕЧАТОК документа там, где по смыслу не менялось ничего.
 * Человек читал об этом две противоречащие строки разом: «Стиль текста display →
 * крупный» и «„style“ уже „display“ — эта правка ничего не меняет».
 *
 * Правило одно и симметричное: если новое значение по смыслу равно текущему
 * (то же имя токена), поле остаётся ровно таким, каким жило, — байт в байт.
 * Настоящая смена значения идёт как раньше, поэтому инверсия любой операции
 * по-прежнему возвращает исходное значение в исходной форме.
 *
 * Круг 20 (SPEC §6.4) — то же правило для шкал, и оно намеренно НЕсимметрично:
 *   • число, РАВНОЕ значению текущей ссылки (`set layout.gap = 16` при
 *     'spacing.6' = 16), — правка тем же значением: остаётся ссылка, байт в байт;
 *   • ссылка поверх числа (`set layout.gap = 'spacing.6'` при 16) — настоящая
 *     правка: число становится ссылкой, это смена смысла при той же картинке;
 *   • ссылка поверх ссылки пишется буквально, даже если шаги равны по значению.
 * Круг 36 (SPEC §11.1): то же для подъёма состояния — пути states, states.<s>,
 * states.<s>.lift (шкала отступов).
 * Действует на путях radius, layout, layout.gap, layout.padding,
 * layout.padding.{t,r,b,l} (и покорнерном массиве radius) — для целого
 * объекта layout / padding правило применяется к каждому полю в отдельности.
 * Мозг зеркалит именно эту функцию (sameAsNow): любое расхождение выходит
 * человеку ложной строкой «правка ничего не меняет».
 *
 * @param {object} node узел ДО правки
 * @param {string} path путь, как в операции set
 * @param {any} value новое значение
 * @param {object} [doc] документ — нужен, чтобы разрешить ссылку в число
 * @returns {any} значение, которое стоит записать по этому пути
 */
function keepFieldForm(node, path, value, doc) {
  if (value === undefined || !node) return value;
  const parts = String(path).split('.');
  const field = parts[0];
  if (parts.length === 1) {
    const keys = WRAPPED_FIELDS[field];
    if (keys) {
      const cur = node[field];
      const a = wrappedName(cur, keys);
      if (a === undefined || a !== wrappedName(value, keys)) return value;
      // строка поверх объекта: объект остаётся (соседние stroke.width, style.fontSize целы)
      if (typeof value === 'string' && cur && typeof cur === 'object') return cur;
      // объект поверх строки: только если объект — голая обёртка и сверх имени ничего не несёт
      if (typeof cur === 'string' && bareWrapper(value, keys)) return cur;
      return value;
    }
    if (field === 'radius') return keepRadiusForm(doc, node.radius, value);
    if (field === 'layout') return keepLayoutForm(doc, node.layout, value);
    if (field === 'states') return keepStatesForm(doc, node.states, value);
    return value;
  }
  // круг 36 (SPEC §11.1): подъём состояния — на шкале отступов, правило то же (§6.4)
  if (field === 'states' && isObj(node.states)) {
    const patch = node.states[parts[1]];
    if (parts.length === 2) return keepPatchForm(doc, patch, value);
    if (parts.length === 3 && parts[2] === 'lift') return keepScaleForm(doc, isObj(patch) ? patch.lift : undefined, value, 'spacing');
  }
  if (field === 'layout' && node.layout && typeof node.layout === 'object') {
    const cur = node.layout;
    if (parts.length === 2 && parts[1] === 'gap') return keepScaleForm(doc, cur.gap, value, 'spacing');
    if (parts[1] === 'padding') {
      const pad = cur.padding && typeof cur.padding === 'object' && !Array.isArray(cur.padding) ? cur.padding : {};
      if (parts.length === 2) return keepPaddingForm(doc, pad, value);
      if (parts.length === 3 && PAD_KEYS.indexOf(parts[2]) >= 0) return keepScaleForm(doc, pad[parts[2]], value, 'spacing');
    }
  }
  return value;
}

/** Патч состояния целиком: подъём — по правилу шкал, остальное как есть (круг 36). */
function keepPatchForm(doc, cur, value) {
  if (!isObj(value) || !isObj(cur) || value.lift === undefined) return value;
  const lift = keepScaleForm(doc, cur.lift, value.lift, 'spacing');
  return lift === value.lift ? value : { ...value, lift };
}

/** Поле states целиком: каждое состояние — как keepPatchForm. */
function keepStatesForm(doc, cur, value) {
  if (!isObj(value) || !isObj(cur)) return value;
  let out = value;
  for (const s of Object.keys(value)) {
    const next = keepPatchForm(doc, cur[s], value[s]);
    if (next === value[s]) continue;
    if (out === value) out = { ...value };
    out[s] = next;
  }
  return out;
}

/** Число, равное значению текущей ссылки, — «то же самое»: остаётся ссылка. */
function keepScaleForm(doc, cur, value, scale) {
  if (!isNum(value) || !isScaleRef(cur, scale)) return value;
  return resolveScale(doc, cur, scale) === value ? cur : value;
}

/** То же для скругления, включая покорнерный массив (поэлементно при равной длине). */
function keepRadiusForm(doc, cur, value) {
  if (Array.isArray(value)) {
    if (!Array.isArray(cur) || cur.length !== value.length) return value;
    const out = value.map((v, i) => keepScaleForm(doc, cur[i], v, 'radii'));
    return out.every((v, i) => v === cur[i]) ? cur : out;
  }
  return keepScaleForm(doc, cur, value, 'radii');
}

/** Отступы: краткая запись раскрывается, каждая сторона решается отдельно. */
function keepPaddingForm(doc, curPad, value) {
  const box = paddingShorthand(value);
  if (!box) return value;
  const cur = curPad && typeof curPad === 'object' ? curPad : {};
  const out = {};
  for (const k of PAD_KEYS) if (box[k] !== undefined) out[k] = keepScaleForm(doc, cur[k], box[k], 'spacing');
  return out;
}

/** Целый объект layout: gap и padding — по правилу шкал, остальное как есть. */
function keepLayoutForm(doc, cur, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!cur || typeof cur !== 'object') return value;
  const out = { ...value };
  if (value.gap !== undefined) out.gap = keepScaleForm(doc, cur.gap, value.gap, 'spacing');
  if (value.padding !== undefined) out.padding = keepPaddingForm(doc, cur.padding, value.padding);
  return out;
}

/* ------------------------------------------------------------------ *
 * 2.4 Форма полей (круг 29)
 *
 * Схема проверяла не все поля и не до конца: `set style.token = {toString:1}`
 * ложился в документ, и resolveTextStyle на первом же solve бросал — пустой
 * холст у всех, навсегда (журнал переигрывается с той же записью). Правило
 * теперь одно: КАЖДОЕ поле узла — значение своего вида (строка / число /
 * булево / перечисление / объект нужной формы), а всё, чего схема не знает, —
 * простые данные (null, булево, конечное число, строка, массив, простой
 * объект) не глубже PLAIN_DEPTH. Значение не той формы — операция `bad-node`
 * (в rebase — `dropped: invalid`).
 * ------------------------------------------------------------------ */

/** Предел вложенности значения поля: глубже — не данные макета, а мусор (или цикл). */
const PLAIN_DEPTH = 32;
/** Поля узла — строки. */
const STRING_FIELDS = new Set(['name', 'characters', 'role', 'src', 'of']);
/** Поля узла — булевы. */
const BOOL_FIELDS = new Set(['clip', 'visible', 'locked']);
/** Поля, которые проверяет структурная часть checkNode, а не форма поля. */
const STRUCT_FIELDS = new Set(['id', 'type', 'parent', 'children']);
const TEXT_ALIGNS = new Set(['left', 'center', 'right']);

/**
 * Простые данные: то, что одинаково переживает JSON, jsonb и IndexedDB.
 * NaN и бесконечность сюда не входят — после JSON это null, и отпечаток
 * документа у клиента и сервера разошёлся бы.
 * @returns {string|null} причина или null
 */
function plainProblem(v, depth) {
  if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'не конечное число';
  if (typeof v !== 'object') return `значение вида ${typeof v}`;
  if (depth >= PLAIN_DEPTH) return `вложенность значения глубже ${PLAIN_DEPTH}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const err = plainProblem(v[i], depth + 1);
      if (err) return err;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return 'не простой объект';
  for (const k of Object.keys(v)) {
    // `{toString: 1}` — данные, которые ломают любое приведение объекта к строке
    if (PROTO_KEYS.has(k)) return `ключ «${k}» зарезервирован`;
    const err = plainProblem(v[k], depth + 1);
    if (err) return err;
  }
  return null;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (o, k) => o[k] === undefined || typeof o[k] === 'string';
const optNum = (o, k, lo, hi) => o[k] === undefined || (isNum(o[k]) && o[k] >= lo && o[k] <= hi);

/**
 * Круг 43: известные ключи стиля текста (поле `style` узла и запись `tokens.type.*`)
 * — таблица, по которой идут И проверка (textStyleFieldsProblem), И отпечаток
 * формата (formatSignature). str — строка; num — число в [min, max] (`gt` —
 * строго больше min); note — хвост сообщения.
 */
const TEXT_STYLE_FIELDS = Object.freeze({
  token: { str: true },
  font: { str: true },
  fontFamily: { str: true },
  fontSize: { min: 0, gt: true, max: 1000 },
  lineHeight: { min: 0, gt: true, max: 1000 },
  fontWeight: { min: 100, max: 900, note: ' 100..900' },
  letterSpacing: { min: -1000, max: 1000 }
});
/** Ключи записи `tokens.type.<имя>` (без token/fontFamily — запись сама и есть токен). */
const TYPE_ENTRY_FIELDS = Object.freeze(['font', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing']);

/** Ключи стиля по таблице TEXT_STYLE_FIELDS. @returns {string|null} */
function textStyleFieldsProblem(v, keys, what) {
  for (const k of keys) {
    const rule = TEXT_STYLE_FIELDS[k];
    const x = v[k];
    if (x === undefined) continue;
    if (rule.str) { if (typeof x !== 'string') return `${what}.${k} должен быть строкой`; continue; }
    const ok = isNum(x) && (rule.gt ? x > rule.min : x >= rule.min) && x <= rule.max;
    if (!ok) return `${what}.${k} вне диапазона${rule.note || ''}`;
  }
  return null;
}

/** Стиль текста: имя токена или объект; известные ключи — своего вида. */
function styleProblem(v) {
  if (typeof v === 'string') return null;
  if (!isObj(v)) return 'text: style — имя токена или объект';
  return textStyleFieldsProblem(v, Object.keys(TEXT_STYLE_FIELDS), 'style');
}


/** Круг 43: ключи обводки-объекта: краска, строки, число в границах (таблица проверки и отпечатка). */
const STROKE_FIELDS = Object.freeze({ color: 'paint', token: 'str', value: 'str', width: Object.freeze([0, 1000]) });

/** Обводка: null, строка или {color|token|value, width}; color — краска (круг 37: и градиент). */
function strokeProblem(v, noGradient) {
  if (v === null || typeof v === 'string') return null;
  if (!isObj(v)) return 'stroke: строка или объект';
  if (v.gradient !== undefined) return 'stroke: градиент обводки — в stroke.color';
  for (const k of Object.keys(STROKE_FIELDS)) {
    const rule = STROKE_FIELDS[k];
    if (v[k] === undefined) continue;
    if (rule === 'paint') {
      const err = paintProblem(v[k], 'stroke.' + k, noGradient, true);
      if (err) return err;
    } else if (rule === 'str') {
      if (typeof v[k] !== 'string') return `stroke.${k} должен быть строкой`;
    } else if (!optNum(v, k, rule[0], rule[1])) return `stroke.${k} вне диапазона ${rule[0]}..${rule[1]}`;
  }
  return null;
}

/** Круг 43: оси размера и рамок (size, override, viewBox — w/h; pos — x/y). */
const SIZE_AXES = Object.freeze(['w', 'h']);
const POS_AXES = Object.freeze(['x', 'y']);
/** Ключи viewBox вектора: x, y необязательны, w, h — обязательны. */
const VIEWBOX_KEYS = Object.freeze(['x', 'y', 'w', 'h']);

/** Размер: объект осей, ось — объект с режимом-строкой и числом. Перечни режимов — в checkNode. */
function sizeShapeProblem(v) {
  if (!isObj(v)) return 'size: нужен объект';
  for (const ax of SIZE_AXES) {
    const s = v[ax];
    if (s === undefined) continue;
    if (!isObj(s)) return `size.${ax}: нужен объект`;
    if (typeof s.mode !== 'string' || !SIZE_MODES.has(s.mode)) return `size.${ax}: неизвестный режим`;
    if (s.value !== undefined && s.value !== null && !isNum(s.value)) return `size.${ax}.value должен быть числом`;
  }
  return null;
}

/** Круг 43: ключи раскладки — перечисления (таблица проверки и отпечатка) и прочие. */
const LAYOUT_ENUMS = Object.freeze({ mode: LAYOUT_MODES, align: ALIGNS, justify: JUSTIFIES });
const LAYOUT_KEYS = Object.freeze(['mode', 'align', 'justify', 'wrap', 'gap', 'padding']);

/** Раскладка: объект; известные ключи — своего вида (у фрейма она к тому же нормализована). */
function layoutShapeProblem(v) {
  if (!isObj(v)) return 'layout должен быть объектом';
  for (const k of Object.keys(LAYOUT_ENUMS)) {
    if (v[k] !== undefined && !LAYOUT_ENUMS[k].has(v[k])) return `layout.${k}: «${shown(v[k])}»`;
  }
  if (v.wrap !== undefined && typeof v.wrap !== 'boolean') return 'layout.wrap: нужно true или false';
  if (v.gap !== undefined && !isNum(v.gap) && !parseScaleRef(v.gap)) return 'layout.gap вне диапазона';
  const p = v.padding;
  if (p !== undefined && !isNum(p) && !parseScaleRef(p)) {
    if (!p || typeof p !== 'object') return 'layout.padding должен быть объектом';
    const vals = Array.isArray(p) ? p : PAD_KEYS.map((k) => p[k]);
    for (const x of vals) if (x !== undefined && !isNum(x) && !parseScaleRef(x)) return 'layout.padding вне диапазона';
  }
  return null;
}

/**
 * Раскладка фрейма ДО нормализации. normalizeLayout молча делает из негодного
 * умолчание (неизвестный режим → 'none', мусор в отступе → 0) — так и было
 * задумано для строк от модели. Но объект там, где ждут строку или число, —
 * не опечатка, а чужие данные: такая операция отклоняется, а не «чинится».
 * @returns {string|null}
 */
function rawLayoutProblem(l) {
  if (l === undefined || l === null || typeof l !== 'object') return null;   // нормализация даст умолчание
  if (Array.isArray(l)) return 'layout должен быть объектом';
  for (const k of LAYOUT_KEYS) {
    if (k === 'padding') continue;
    if (l[k] !== null && typeof l[k] === 'object') return `layout.${k}: нужно простое значение`;
  }
  const p = l.padding;
  if (p && typeof p === 'object') {
    const vals = Array.isArray(p) ? p : PAD_KEYS.map((k) => p[k]);
    for (const x of vals) if (x !== null && typeof x === 'object') return 'layout.padding: стороны — числа или ссылки на шкалу';
  }
  // прочие ключи и негодные скаляры (NaN, 42 в align) нормализация отбрасывает сама
  return null;
}

/* ------------------------------------------------------------------ *
 * 2.4a Микроанимации: состояния и движение (круг 36, SPEC §11)
 *
 * У узла (кроме страницы) — `states` {hover?, press?, focus?}: каждое состояние —
 * патч ТОЛЬКО вида (fill, color, stroke, opacity, scale, lift, shadow); раскладку
 * и геометрию состояние не меняет, поэтому решатель его не читает вовсе. `motion`
 * — как узел переходит между состояниями (длительность, кривая, задержка, следует
 * ли он за предком). `opacity` (было и раньше) и `shadow` — базовый вид.
 *
 * Ссылки — как шкалы §6: длительность 'motion.fast|base|slow', тень
 * 'shadow.sm|md|lg', подъём 'spacing.N'. Число допустимо «мимо шкалы» (валидатор —
 * off-scale, info). Шкалы движения и теней живут в tokens.motion / tokens.shadow;
 * документ без них работает на умолчаниях ядра (DEFAULT_MOTION, DEFAULT_SHADOW) —
 * миграции не нужно. Мёртвая ссылка (шкала есть, шага в ней нет; шага spacing нет)
 * — dead-motion-ref (warn), отрисовка берёт умолчание.
 * ------------------------------------------------------------------ */

/** Имена состояний — в порядке наложения (как в CSS: :hover, :focus, :active). */
const STATE_NAMES = Object.freeze(['hover', 'focus', 'press']);
const STATE_NAME_SET = new Set(STATE_NAMES);
/** Поля патча состояния: только вид. */
const STATE_KEYS = Object.freeze(['fill', 'color', 'stroke', 'opacity', 'scale', 'lift', 'shadow']);
const STATE_KEY_SET = new Set(STATE_KEYS);
const MOTION_KEYS = new Set(['duration', 'easing', 'delay', 'follow']);
/** Значения motion.follow. */
const MOTION_FOLLOW = Object.freeze(['self', 'parent']);
/** Пределы (SPEC §11.1). */
const STATE_LIMITS = Object.freeze({ scale: [0.8, 1.2], lift: [-24, 24], duration: [0, 2000], delay: [0, 1000] });
/** Длительность, выше которой микроанимация уже не «микро» (motion-slow). */
const MOTION_SLOW_MS = 600;
/** Кривые: имя → CSS cubic-bezier. */
const EASINGS = Object.freeze({
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  emphasized: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  decelerate: 'cubic-bezier(0, 0, 0, 1)',
  accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  linear: 'cubic-bezier(0, 0, 1, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
});
/** Умолчания ядра: шкала длительностей, мс. */
const DEFAULT_MOTION = Object.freeze({ fast: 120, base: 200, slow: 320 });
/** Умолчания ядра: тени — «dx dy blur цвет» (px), та же запись, что пишет setToken shadow.<k>. */
const DEFAULT_SHADOW = Object.freeze({
  sm: '0 1 2 rgba(20,22,28,0.12)',
  md: '0 4 12 rgba(20,22,28,0.14)',
  lg: '0 12 28 rgba(20,22,28,0.18)'
});
const MOTION_STEPS = Object.freeze(['fast', 'base', 'slow']);
const SHADOW_STEPS = Object.freeze(['sm', 'md', 'lg']);
const MOTION_REF_RE = /^motion\.(fast|base|slow)$/;
const SHADOW_REF_RE = /^shadow\.(sm|md|lg)$/;
/** Длина описания тени: длиннее — не тень, а мусор. */
const SHADOW_DESC_MAX = 120;
/** Круг 45 (code-r45 Д3): пределы тени — таблицей, чтобы граница попадала в корпус проб отпечатка. */
const SHADOW_LIMITS = Object.freeze({ maxOffset: 200, maxBlur: 200, maxDesc: SHADOW_DESC_MAX });
const SHADOW_LEN_RE = /^-?(\d+(\.\d+)?|\.\d+)(px)?$/;
const SHADOW_COLOR_RE = /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+|1\.0+)\s*)?\))$/;

/**
 * Разбор описания тени «dx dy blur цвет» (длины — px, «px» можно писать или нет;
 * цвет — #hex или rgb()/rgba()). 'none' — тени нет.
 * @param {any} v
 * @returns {{dx:number,dy:number,blur:number,color:string}|'none'|null} null — не тень
 */
function parseShadow(v) {
  if (typeof v !== 'string' || v.length > SHADOW_DESC_MAX) return null;
  const s = v.trim();
  if (s === 'none') return 'none';
  // цвет может содержать пробелы внутри скобок — отрезаем его с конца
  const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(s);
  if (!m) return null;
  const lens = [m[1], m[2], m[3]];
  if (!lens.every((x) => SHADOW_LEN_RE.test(x))) return null;
  const [dx, dy, blur] = lens.map((x) => parseFloat(x));
  if (Math.abs(dx) > SHADOW_LIMITS.maxOffset || Math.abs(dy) > SHADOW_LIMITS.maxOffset || blur < 0 || blur > SHADOW_LIMITS.maxBlur) return null;
  const color = m[4].trim();
  if (!SHADOW_COLOR_RE.test(color)) return null;
  return { dx, dy, blur, color };
}

/** Ссылка на тень (или 'none'). @returns {string|null} причина или null */
function shadowRefProblem(v, what) {
  if (v === 'none' || (typeof v === 'string' && SHADOW_REF_RE.test(v))) return null;
  return `${what}: тень — 'none' или shadow.sm | shadow.md | shadow.lg`;
}

/** Один патч состояния. @returns {string|null} */
function statePatchProblem(v, what) {
  if (!isObj(v)) return `${what}: нужен объект`;
  for (const k of Object.keys(v)) {
    if (!STATE_KEY_SET.has(k)) return `${what}.${k}: состояние меняет только вид (${STATE_KEYS.join(', ')})`;
    const x = v[k];
    if (x === undefined) continue;
    let err = null;
    switch (k) {
      // круг 37: в состоянии — только цвет, градиент не переходит плавно
      case 'fill': case 'color': err = paintProblem(x, `${what}.${k}`, true); break;
      case 'stroke': err = strokeProblem(x, true); if (err) err = `${what}.${err}`; break;
      case 'opacity': err = isNum(x) && x >= 0 && x <= 1 ? null : `${what}.opacity вне 0..1`; break;
      case 'scale':
        err = isNum(x) && x >= STATE_LIMITS.scale[0] && x <= STATE_LIMITS.scale[1] ? null
          : `${what}.scale вне ${STATE_LIMITS.scale[0]}..${STATE_LIMITS.scale[1]}`;
        break;
      case 'lift':
        if (isNum(x)) err = x >= STATE_LIMITS.lift[0] && x <= STATE_LIMITS.lift[1] ? null : `${what}.lift вне ${STATE_LIMITS.lift[0]}..${STATE_LIMITS.lift[1]} px`;
        else err = isScaleRef(x, 'spacing') ? null : `${what}.lift: число px или ссылка spacing.<шаг>`;
        break;
      case 'shadow': err = shadowRefProblem(x, `${what}.shadow`); break;
      default: break;
    }
    if (err) return err;
  }
  const plain = plainProblem(v, 1);
  return plain ? `${what}: ${plain}` : null;
}

/** Поле states узла. @returns {string|null} */
function statesProblem(v) {
  if (!isObj(v)) return 'states: нужен объект {hover?, press?, focus?}';
  for (const s of Object.keys(v)) {
    if (!STATE_NAME_SET.has(s)) return `states.${s}: состояния бывают hover, press, focus`;
    if (v[s] === undefined) continue;
    const err = statePatchProblem(v[s], 'states.' + s);
    if (err) return err;
  }
  return null;
}

/** Поле motion узла. @returns {string|null} */
function motionProblem(v) {
  if (!isObj(v)) return 'motion: нужен объект {duration?, easing?, delay?, follow?}';
  for (const k of Object.keys(v)) {
    if (!MOTION_KEYS.has(k)) return `motion.${k}: поля движения — duration, easing, delay, follow`;
  }
  const d = v.duration;
  if (d !== undefined && !(isNum(d) ? d >= STATE_LIMITS.duration[0] && d <= STATE_LIMITS.duration[1] : typeof d === 'string' && MOTION_REF_RE.test(d))) {
    return `motion.duration: мс ${STATE_LIMITS.duration[0]}..${STATE_LIMITS.duration[1]} или motion.fast | motion.base | motion.slow`;
  }
  if (v.easing !== undefined && !(typeof v.easing === 'string' && hasOwnProp.call(EASINGS, v.easing))) {
    return `motion.easing: одна из ${Object.keys(EASINGS).join(', ')}`;
  }
  if (!optNum(v, 'delay', STATE_LIMITS.delay[0], STATE_LIMITS.delay[1])) return `motion.delay: мс ${STATE_LIMITS.delay[0]}..${STATE_LIMITS.delay[1]}`;
  if (v.follow !== undefined && !MOTION_FOLLOW.includes(v.follow)) return "motion.follow: 'self' или 'parent'";
  return null;
}

/** Шаг шкалы длительностей: мс в пределах. */
const motionStepOk = (x) => isNum(x) && x >= STATE_LIMITS.duration[0] && x <= STATE_LIMITS.duration[1];
/** Шаг шкалы теней: описание тени («dx dy blur цвет») или 'none'. */
const shadowStepOk = (x) => parseShadow(x) !== null;

/** Есть ли у узла хоть одно состояние (непустой объект states). */
function hasStates(node) {
  if (!node || !isObj(node.states)) return false;
  for (const s of STATE_NAMES) if (isObj(node.states[s])) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 2.4b Векторы и краски (круг 37, SPEC §12)
 *
 * Узел `vector` — контуры SVG (`paths`) в собственной системе координат
 * (`viewBox` {x?, y?, w, h}), вписанные в рамку узла с сохранением пропорций
 * (xMidYMid meet). Путь разбирается ядром строго (parsePath): неверный путь —
 * bad-node, импорт — bad-doc. Краска (Paint) — цвет, как раньше, или градиент
 * {gradient:{kind, angle?, cx?, cy?, r?, stops}}; стоп — доля 0…1 и цвет/токен.
 * `rotate` — визуальный поворот вокруг центра у любого не-page узла: решатель его
 * не читает, как и scale состояний (§11).
 * ------------------------------------------------------------------ */

/** Пределы вектора (SPEC §12.1). */
const VECTOR_LIMITS = Object.freeze({
  maxPaths: 256,            // контуров на узел
  maxD: 20000,              // символов в одном d
  maxTotalD: 100000,        // символов d на узел суммарно
  maxStrokeWidth: 64,       // толщина обводки контура, ед. viewBox
  maxStops: 16,             // стопов градиента
  heavyCommands: 5000,      // больше команд на узел — path-heavy (info)
  maxCoord: 1e6,            // |число| в пути
  maxPathName: 200          // символов в имени контура (круг 45: таблицей — для корпуса проб)
});
const GRADIENT_KINDS = Object.freeze(['linear', 'radial']);
const GRADIENT_KIND_SET = new Set(GRADIENT_KINDS);
const GRADIENT_KEYS = new Set(['kind', 'angle', 'cx', 'cy', 'r', 'stops']);
const STOP_KEYS = new Set(['at', 'color', 'token', 'opacity']);
const VPATH_KEYS = new Set(['d', 'name', 'fill', 'stroke', 'strokeWidth', 'opacity', 'fillRule', 'lineCap', 'lineJoin']);
const FILL_RULES = new Set(['nonzero', 'evenodd']);
const LINE_CAPS = new Set(['butt', 'round', 'square']);
const LINE_JOINS = new Set(['miter', 'round', 'bevel']);
const ROTATE_LIMIT = 360;
/** Число аргументов команды пути. */
const PATH_ARGS = Object.freeze({ M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 });
const PATH_NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const isPathWsp = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Градиент. @returns {string|null} */
function gradientProblem(g, what) {
  const w = what + '.gradient';
  if (!isObj(g)) return `${w}: нужен объект {kind, stops, …}`;
  for (const k of Object.keys(g)) if (!GRADIENT_KEYS.has(k)) return `${w}.${k}: поля градиента — kind, angle, cx, cy, r, stops`;
  if (!GRADIENT_KIND_SET.has(g.kind)) return `${w}.kind: 'linear' или 'radial'`;
  if (!optNum(g, 'angle', 0, 360)) return `${w}.angle: градусы 0..360`;
  for (const k of ['cx', 'cy', 'r']) if (!optNum(g, k, 0, 1)) return `${w}.${k}: доля 0..1`;
  const s = g.stops;
  if (!Array.isArray(s) || !s.length) return `${w}.stops: нужен массив стопов`;
  if (s.length > VECTOR_LIMITS.maxStops) return `${w}.stops: не больше ${VECTOR_LIMITS.maxStops} стопов`;
  for (let i = 0; i < s.length; i++) {
    const st = s[i];
    const sw = `${w}.stops.${i}`;
    if (!isObj(st)) return `${sw}: нужен объект {at, color|token, opacity?}`;
    for (const k of Object.keys(st)) if (!STOP_KEYS.has(k)) return `${sw}.${k}: поля стопа — at, color, token, opacity`;
    if (!isNum(st.at) || st.at < 0 || st.at > 1) return `${sw}.at: доля 0..1`;
    const hasC = st.color !== undefined;
    const hasT = st.token !== undefined;
    if (hasC === hasT) return `${sw}: нужен ровно один из color или token`;
    if (hasC && (typeof st.color !== 'string' || !st.color)) return `${sw}.color должен быть строкой`;
    if (hasT && (typeof st.token !== 'string' || !st.token)) return `${sw}.token должен быть строкой`;
    if (!optNum(st, 'opacity', 0, 1)) return `${sw}.opacity вне 0..1`;
  }
  return null;
}

/* Круг 49 (SPEC §16): фактура — повторяющийся узор в заливке: {pattern:{kind, color, bg?, size?,
   weight?, angle?, opacity?}}. color и bg — как любой цвет краски: токен или #hex. Узор — плитка
   size×size в координатах холста (userSpaceOnUse), angle поворачивает плитку. */
const PATTERN_KINDS = Object.freeze(['dots', 'lines', 'grid', 'checks', 'waves', 'grain']);
const PATTERN_KIND_SET = new Set(PATTERN_KINDS);
const PATTERN_KEYS = Object.freeze(['kind', 'color', 'bg', 'size', 'weight', 'angle', 'opacity']);
const PATTERN_LIMITS = Object.freeze({ minSize: 4, maxSize: 200, defaultSize: 12, minWeight: 0.5, maxWeight: 50 });

/** Фактура. @returns {string|null} */
function patternProblem(p, what) {
  const w = what + '.pattern';
  if (!isObj(p)) return `${w}: нужен объект {kind, color, …}`;
  for (const k of Object.keys(p)) if (PATTERN_KEYS.indexOf(k) < 0) return `${w}.${k}: поля фактуры — ${PATTERN_KEYS.join(', ')}`;
  if (!PATTERN_KIND_SET.has(p.kind)) return `${w}.kind: ${PATTERN_KINDS.join(' | ')}`;
  if (typeof p.color !== 'string' || !p.color) return `${w}.color: нужен цвет строкой (токен или #hex)`;
  if (p.bg !== undefined && (typeof p.bg !== 'string' || !p.bg)) return `${w}.bg: цвет подложки строкой`;
  if (!optNum(p, 'size', PATTERN_LIMITS.minSize, PATTERN_LIMITS.maxSize)) return `${w}.size: шаг ${PATTERN_LIMITS.minSize}..${PATTERN_LIMITS.maxSize} px`;
  if (!optNum(p, 'weight', PATTERN_LIMITS.minWeight, PATTERN_LIMITS.maxWeight)) return `${w}.weight: толщина ${PATTERN_LIMITS.minWeight}..${PATTERN_LIMITS.maxWeight} px`;
  if (!optNum(p, 'angle', 0, 360)) return `${w}.angle: градусы 0..360`;
  if (!optNum(p, 'opacity', 0, 1)) return `${w}.opacity вне 0..1`;
  return null;
}

/** Круг 43: ключи обёртки краски-цвета (кроме {gradient}) — строки. */
const PAINT_WRAP_KEYS = Object.freeze(['token', 'color', 'value']);

/**
 * Краска (fill, color, stroke.color, контуры): null, строка, обёртка
 * {token|color|value: строка} или (круг 37) {gradient}. В патчах состояний
 * градиента нет — там переход цвета, а не смена краски.
 * @param {any} v @param {string} what @param {boolean} [noGradient]
 * @returns {string|null}
 */
function paintProblem(v, what, noGradient, noPattern) {
  if (v === null || typeof v === 'string') return null;
  if (!isObj(v)) return `${what}: цвет — строка или объект`;
  // круг 49: фактура — только в заливке (не в цвете текста, обводке и состояниях)
  if (v.pattern !== undefined) {
    if (noGradient || noPattern) return `${what}: здесь фактура недопустима — она бывает только в заливке`;
    if (Object.keys(v).length !== 1) return `${what}: у фактуры других ключей нет — {pattern:{…}}`;
    return patternProblem(v.pattern, what);
  }
  if (v.gradient !== undefined) {
    if (noGradient) return `${what}: здесь градиент недопустим — только цвет`;
    if (Object.keys(v).length !== 1) return `${what}: у градиента других ключей нет — {gradient:{…}}`;
    return gradientProblem(v.gradient, what);
  }
  for (const k of PAINT_WRAP_KEYS) if (!optStr(v, k)) return `${what}.${k} должен быть строкой`;
  return null;
}

/** Есть ли в значении градиент. */
const isGradientPaint = (v) => isObj(v) && isObj(v.gradient);
/** Круг 49: есть ли в значении фактура. */
const isPatternPaint = (v) => isObj(v) && isObj(v.pattern);

/**
 * Кеш проверки путей: d → {err, at, count}. Путь проверяется на каждый set узла.
 * Круг 39: предел не только по числу ключей, но и по их суммарной длине —
 * 4096 ключей-строк до 20 000 символов держали до ~80 МБ на процесс (и в
 * Document service). Длинные пути (больше PATH_CACHE_MAX_KEY) не кешируются
 * вовсе: разбор линеен, а держать мегабайты ради редкого повтора незачем.
 */
const pathCheckCache = new Map();
const PATH_CACHE_LIMIT = 4096;
/** Суммарная длина ключей кеша (символов): ~1 МБ строк в худшем случае. */
const PATH_CACHE_CHARS = 1 << 20;
/** Путь длиннее — не кешируется. */
const PATH_CACHE_MAX_KEY = 4096;
let pathCacheChars = 0;
/** Длинные пути: контур → {d, res}. */
const pathCheckOwned = new WeakMap();

/**
 * Разбор пути SVG. Строгий: первая команда M/m, числа конечные и не больше
 * VECTOR_LIMITS.maxCoord по модулю, флаги дуг — 0 или 1, между числами —
 * пробелы и не больше одной запятой. Неявные повторы раскрываются (лишние пары
 * после M — это L), координаты становятся абсолютными.
 * @param {any} d
 * @returns {{ok:true, cmds:Array<{c:string,a:number[]}>, count:number}|{ok:false, error:string, at:number}}
 */
function parsePath(d) {
  const fail = (error, at) => ({ ok: false, error, at });
  if (typeof d !== 'string') return fail('путь должен быть строкой', 0);
  if (d.length > VECTOR_LIMITS.maxD) return fail(`путь длиннее ${VECTOR_LIMITS.maxD} символов`, VECTOR_LIMITS.maxD);
  const n = d.length;
  let i = 0;
  const cmds = [];
  let cx = 0; let cy = 0; let sx = 0; let sy = 0;
  const skipWsp = () => { while (i < n && isPathWsp(d[i])) i++; };
  /** Разделитель между числами: пробелы и не больше одной запятой. */
  const skipSep = () => {
    skipWsp();
    if (i < n && d[i] === ',') { i++; skipWsp(); return true; }
    return false;
  };
  const readNum = () => {
    PATH_NUM_RE.lastIndex = i;
    const m = PATH_NUM_RE.exec(d);
    if (!m) return null;
    const v = Number(m[0]);
    if (!Number.isFinite(v) || Math.abs(v) > VECTOR_LIMITS.maxCoord) return NaN;
    i += m[0].length;
    return v === 0 ? 0 : v;   // без -0: JSON и хэш его не различают, сравнение — да
  };
  const startsNum = () => {
    const c = d[i];
    return c !== undefined && ((c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.');
  };
  skipWsp();
  if (i >= n) return fail('пустой путь', 0);
  let cmd = null;
  while (true) {
    skipWsp();
    if (i >= n) break;
    const ch = d[i];
    const up = ch.toUpperCase();
    if (!hasOwnProp.call(PATH_ARGS, up)) {
      return fail(startsNum() ? (cmds.length ? 'число без команды (после Z нужна команда)' : 'путь начинается с M') : `неизвестная команда «${ch}»`, i);
    }
    if (!cmds.length && up !== 'M') return fail('путь начинается с M', i);
    cmd = ch;
    i++;
    if (up === 'Z') { cmds.push({ c: 'Z', a: [] }); cx = sx; cy = sy; continue; }
    const argc = PATH_ARGS[up];
    const rel = ch !== up;
    let first = true;
    do {
      if (!first) {
        // повтор: после M неявные пары — это L
        if (up === 'M') { cmd = rel ? 'l' : 'L'; }
      }
      const a = new Array(argc);
      for (let k = 0; k < argc; k++) {
        if (k > 0 && skipSep() && !startsNum() && !(up === 'A' && (k === 3 || k === 4))) return fail('после запятой нужно число', i);
        if (k === 0) skipWsp();
        if (up === 'A' && (k === 3 || k === 4)) {
          if (d[i] !== '0' && d[i] !== '1') return fail('флаг дуги — 0 или 1', i);
          a[k] = d[i] === '1' ? 1 : 0;
          i++;
          continue;
        }
        const v = readNum();
        if (v === null) return fail(`команде ${up} нужно ${argc} ${plural(argc, 'число', 'числа', 'чисел')}`, i);
        if (Number.isNaN(v)) return fail(`число вне ±${VECTOR_LIMITS.maxCoord}`, i);
        a[k] = v;
      }
      const c = (cmd || ch).toUpperCase();
      // в абсолютные
      if (rel) {
        if (c === 'H') a[0] += cx;
        else if (c === 'V') a[0] += cy;
        else if (c === 'A') { a[5] += cx; a[6] += cy; }
        else for (let k = 0; k < argc; k += 2) { a[k] += cx; a[k + 1] += cy; }
      }
      for (let k = 0; k < argc; k++) if (!Number.isFinite(a[k]) || Math.abs(a[k]) > VECTOR_LIMITS.maxCoord * 2) return fail('координата вне пределов', i);
      if (c === 'H') cx = a[0];
      else if (c === 'V') cy = a[0];
      else { cx = a[argc - 2]; cy = a[argc - 1]; }
      if (c === 'M') { sx = cx; sy = cy; }
      cmds.push({ c, a });
      first = false;
      // ещё один набор той же команды? Запятая перед ним допустима
      const save = i;
      const comma = skipSep();
      if (startsNum()) continue;
      if (comma) return fail('после запятой нужно число', i);
      i = save;
      break;
    } while (true);
  }
  return { ok: true, cmds, count: cmds.length };
}

/** Круг 39: состояние кеша проверки путей — для тестов предела памяти. */
function pathCacheStats() {
  return { keys: pathCheckCache.size, chars: pathCacheChars };
}

/**
 * Проверка пути с кешем. Длинный путь (больше PATH_CACHE_MAX_KEY) кешируется
 * не по строке, а по объекту контура `owner` (WeakMap): узлы документа
 * неизменяемы и делятся между версиями, так что повторная проверка того же
 * контура (validate на каждом кадре) бесплатна, а память уходит вместе с
 * документом.
 * @param {any} d @param {object} [owner] контур, которому принадлежит путь
 * @returns {{err:string|null, at:number, count:number}}
 */
function pathCheck(d, owner) {
  if (typeof d !== 'string') return { err: 'путь должен быть строкой', at: 0, count: 0 };
  const long = d.length > PATH_CACHE_MAX_KEY;
  if (long) {
    const own = owner && typeof owner === 'object' ? pathCheckOwned.get(owner) : undefined;
    if (own && own.d === d) return own.res;
  } else {
    const hit = pathCheckCache.get(d);
    if (hit) return hit;
  }
  const r = parsePath(d);
  const res = r.ok ? { err: null, at: 0, count: r.count } : { err: r.error, at: r.at, count: 0 };
  if (long) {
    if (owner && typeof owner === 'object') pathCheckOwned.set(owner, { d, res });
    return res;
  }
  while (pathCheckCache.size && (pathCheckCache.size >= PATH_CACHE_LIMIT || pathCacheChars + d.length > PATH_CACHE_CHARS)) {
    const old = pathCheckCache.keys().next().value;
    pathCheckCache.delete(old);
    pathCacheChars -= old.length;
  }
  pathCheckCache.set(d, res);
  pathCacheChars += d.length;
  return res;
}

/** Один контур вектора. @returns {string|null} */
function vpathProblem(p, what) {
  if (!isObj(p)) return `${what}: контур — объект {d, fill?, stroke?, …}`;
  for (const k of Object.keys(p)) if (!VPATH_KEYS.has(k)) return `${what}.${k}: поля контура — ${[...VPATH_KEYS].join(', ')}`;
  if (typeof p.d !== 'string') return `${what}.d: нужен путь SVG строкой`;
  const pc = pathCheck(p.d, p);
  if (pc.err) return `${what}.d: ${pc.err} (символ ${pc.at})`;
  if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > VECTOR_LIMITS.maxPathName)) return `${what}.name: строка до ${VECTOR_LIMITS.maxPathName} символов`;
  for (const k of ['fill', 'stroke']) {
    if (p[k] === undefined) continue;
    const err = paintProblem(p[k], `${what}.${k}`, false, k === 'stroke');
    if (err) return err;
  }
  if (!optNum(p, 'strokeWidth', 0, VECTOR_LIMITS.maxStrokeWidth)) return `${what}.strokeWidth: 0..${VECTOR_LIMITS.maxStrokeWidth}`;
  if (!optNum(p, 'opacity', 0, 1)) return `${what}.opacity вне 0..1`;
  if (p.fillRule !== undefined && !FILL_RULES.has(p.fillRule)) return `${what}.fillRule: 'nonzero' или 'evenodd'`;
  if (p.lineCap !== undefined && !LINE_CAPS.has(p.lineCap)) return `${what}.lineCap: butt | round | square`;
  if (p.lineJoin !== undefined && !LINE_JOINS.has(p.lineJoin)) return `${what}.lineJoin: miter | round | bevel`;
  return null;
}

/** Поле paths вектора. @returns {string|null} */
function pathsProblem(v) {
  if (!Array.isArray(v)) return 'paths: нужен массив контуров';
  if (v.length > VECTOR_LIMITS.maxPaths) return `paths: не больше ${VECTOR_LIMITS.maxPaths} контуров`;
  let total = 0;
  for (let i = 0; i < v.length; i++) {
    const err = vpathProblem(v[i], 'paths.' + i);
    if (err) return err;
    total += v[i].d.length;
    if (total > VECTOR_LIMITS.maxTotalD) return `paths: суммарно больше ${VECTOR_LIMITS.maxTotalD} символов пути`;
  }
  return null;
}

/** Поле viewBox вектора. @returns {string|null} */
function viewBoxProblem(v) {
  if (!isObj(v)) return 'viewBox: нужен объект {x?, y?, w, h}';
  for (const k of Object.keys(v)) if (!VIEWBOX_KEYS.includes(k)) return `viewBox.${k}: поля — ${VIEWBOX_KEYS.join(', ')}`;
  for (const k of SIZE_AXES) if (!isNum(v[k]) || v[k] <= 0 || v[k] > MAX_SIZE) return `viewBox.${k}: число больше 0 и до ${MAX_SIZE}`;
  for (const k of POS_AXES) if (!optNum(v, k, -MAX_SIZE, MAX_SIZE)) return `viewBox.${k}: число ±${MAX_SIZE}`;
  return null;
}

/** viewBox для отрисовки и решателя: всегда числа (негодный — нулевой). */
function vbOf(node) {
  const v = node && isObj(node.viewBox) ? node.viewBox : null;
  if (!v) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: numIn(v.x, -MAX_SIZE, MAX_SIZE, 0), y: numIn(v.y, -MAX_SIZE, MAX_SIZE, 0),
    w: numIn(v.w, 0, MAX_SIZE, 0), h: numIn(v.h, 0, MAX_SIZE, 0)
  };
}

/** Свободная рамка: фрейм без авто-раскладки (дети по pos). */
function isFreeFrame(node) {
  if (!node || node.type !== 'frame') return false;
  const m = isObj(node.layout) ? node.layout.mode : undefined;
  return m === undefined || m === 'none' || !LAYOUT_MODES.has(m);
}

/* --------------------- геометрия путей: bbox, сдвиг --------------------- */

/** Экстремумы кубической кривой по одной оси: значения в t∈(0,1). */
function cubicExtrema(p0, p1, p2, p3, out) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const at = (t) => {
    const mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) { const t = -c / b; if (t > 0 && t < 1) out.push(at(t)); }
    return;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]) if (t > 0 && t < 1) out.push(at(t));
}

/** Точки дуги (эндпоинт-параметризация SVG → центр), включая концы. */
function arcSamples(x1, y1, rxIn, ryIn, phiDeg, fa, fs, x2, y2, steps) {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9 || (x1 === x2 && y1 === y2)) return [[x1, y1], [x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (fa === fs) k = -k;
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = t1 + (dt * s) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + ccx, sin * ex + cos * ey + ccy]);
  }
  out[0] = [x1, y1];
  out[out.length - 1] = [x2, y2];
  return out;
}

/**
 * bbox разобранного пути (cmds из parsePath). @returns {{x1,y1,x2,y2}|null}
 *
 * Круг 39: M, за которым сразу идёт другой M, в рамку не входит — как в
 * браузере (Skia: moveTo после moveTo заменяет точку, а не начинает пустой
 * контур). Раньше `m11.62 -.5 M0 -175 t-.5 0` давал рамку шириной 12,12 вместо
 * 0,5: viewBox детали шире нарисованного, рамка выделения «пустая». M перед
 * Z, перед рисованием и последний в пути — входит (проверено по getBBox
 * Chromium).
 */
function cmdsBox(cmds) {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  const add = (x, y) => {
    if (x < x1) x1 = x; if (x > x2) x2 = x;
    if (y < y1) y1 = y; if (y > y2) y2 = y;
  };
  let cx = 0; let cy = 0; let sx = 0; let sy = 0;
  let pc = null;   // прошлая контрольная точка (для S/T): {x, y, kind}
  let moved = false;   // последняя команда — M: её точка ждёт, что будет дальше
  for (const { c, a } of cmds) {
    if (c === 'M') { cx = a[0]; cy = a[1]; sx = cx; sy = cy; moved = true; pc = null; continue; }
    if (moved) { add(sx, sy); moved = false; }
    if (c === 'Z') { cx = sx; cy = sy; pc = null; continue; }
    if (c === 'L') { add(a[0], a[1]); cx = a[0]; cy = a[1]; pc = null; continue; }
    if (c === 'H') { add(a[0], cy); cx = a[0]; pc = null; continue; }
    if (c === 'V') { add(cx, a[0]); cy = a[0]; pc = null; continue; }
    if (c === 'C' || c === 'S') {
      let c1x; let c1y; let c2x; let c2y; let ex; let ey;
      if (c === 'C') { [c1x, c1y, c2x, c2y, ex, ey] = a; }
      else {
        c1x = pc && pc.kind === 'C' ? 2 * cx - pc.x : cx;
        c1y = pc && pc.kind === 'C' ? 2 * cy - pc.y : cy;
        [c2x, c2y, ex, ey] = a;
      }
      const xs = []; const ys = [];
      cubicExtrema(cx, c1x, c2x, ex, xs);
      cubicExtrema(cy, c1y, c2y, ey, ys);
      add(ex, ey);
      for (const x of xs) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); }
      for (const y of ys) { y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
      pc = { x: c2x, y: c2y, kind: 'C' };
      cx = ex; cy = ey; continue;
    }
    if (c === 'Q' || c === 'T') {
      let qx; let qy; let ex; let ey;
      if (c === 'Q') { [qx, qy, ex, ey] = a; }
      else {
        qx = pc && pc.kind === 'Q' ? 2 * cx - pc.x : cx;
        qy = pc && pc.kind === 'Q' ? 2 * cy - pc.y : cy;
        [ex, ey] = a;
      }
      add(ex, ey);
      const ext = (p0, p1, p2) => {
        const den = p0 - 2 * p1 + p2;
        if (Math.abs(den) < 1e-12) return null;
        const t = (p0 - p1) / den;
        if (!(t > 0 && t < 1)) return null;
        return (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
      };
      const ex1 = ext(cx, qx, ex);
      const ey1 = ext(cy, qy, ey);
      if (ex1 !== null) { x1 = Math.min(x1, ex1); x2 = Math.max(x2, ex1); }
      if (ey1 !== null) { y1 = Math.min(y1, ey1); y2 = Math.max(y2, ey1); }
      pc = { x: qx, y: qy, kind: 'Q' };
      cx = ex; cy = ey; continue;
    }
    if (c === 'A') {
      for (const [x, y] of arcSamples(cx, cy, a[0], a[1], a[2], a[3], a[4], a[5], a[6], 48)) add(x, y);
      cx = a[5]; cy = a[6]; pc = null; continue;
    }
  }
  if (moved) add(sx, sy);
  if (x1 === Infinity) return null;
  return { x1, y1, x2, y2 };
}

/**
 * Рамка контуров — для «подогнать viewBox». Точная по кривым (экстремумы C/Q,
 * дуги — плотной выборкой). stroke (по умолчанию) — плюс половина толщины
 * обводки у контуров с обводкой.
 * @param {string|Array<string|object>} paths строка d, массив строк или контуров {d, stroke?, strokeWidth?}
 * @param {{stroke?:boolean}} [opts]
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function pathBounds(paths, opts) {
  const withStroke = !(opts && opts.stroke === false);
  const list = typeof paths === 'string' ? [paths] : Array.isArray(paths) ? paths : [];
  let box = null;
  for (const p of list) {
    const d = typeof p === 'string' ? p : isObj(p) ? p.d : null;
    const r = parsePath(d);
    if (!r.ok) continue;
    const b = cmdsBox(r.cmds);
    if (!b) continue;
    let pad = 0;
    if (withStroke && isObj(p) && p.stroke !== undefined && p.stroke !== null) {
      pad = (isNum(p.strokeWidth) ? clamp(p.strokeWidth, 0, VECTOR_LIMITS.maxStrokeWidth) : 1) / 2;
    }
    const bb = { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad };
    box = box ? { x1: Math.min(box.x1, bb.x1), y1: Math.min(box.y1, bb.y1), x2: Math.max(box.x2, bb.x2), y2: Math.max(box.y2, bb.y2) } : bb;
  }
  if (!box) return null;
  return { x: r2(box.x1), y: r2(box.y1), w: r2(box.x2 - box.x1), h: r2(box.y2 - box.y1) };
}

/** Число для d: округление, без «-0» и экспоненты. */
function fmtNum(v, digits) {
  const p = Math.pow(10, digits);
  let x = Math.round((v + (v >= 0 ? Number.EPSILON : -Number.EPSILON)) * p) / p;
  if (Object.is(x, -0) || x === 0) x = 0;
  const s = String(x);
  return /e/i.test(s) ? x.toFixed(digits).replace(/\.?0+$/, '') : s;
}

/**
 * Команды parsePath → строка d (абсолютные команды).
 * @param {Array<{c:string,a:number[]}>} cmds @param {number} [digits=2]
 * @returns {string}
 */
function formatPath(cmds, digits) {
  const dg = isNum(digits) ? clamp(Math.round(digits), 0, 6) : 2;
  const out = [];
  for (const cm of Array.isArray(cmds) ? cmds : []) {
    if (!cm || typeof cm.c !== 'string') continue;
    const a = Array.isArray(cm.a) ? cm.a : [];
    out.push(cm.c + a.map((v, k) => (cm.c === 'A' && (k === 3 || k === 4) ? (v ? '1' : '0') : fmtNum(v, dg))).join(' '));
  }
  return out.join('');
}

/**
 * Сдвиг пути на (dx, dy). Результат — абсолютные команды.
 * @returns {string} '' — путь негоден
 */
function translatePath(d, dx, dy) {
  const r = parsePath(d);
  if (!r.ok) return '';
  const tx = isNum(dx) ? dx : 0;
  const ty = isNum(dy) ? dy : 0;
  for (const cm of r.cmds) {
    const a = cm.a;
    if (cm.c === 'H') a[0] += tx;
    else if (cm.c === 'V') a[0] += ty;
    else if (cm.c === 'A') { a[5] += tx; a[6] += ty; }
    else for (let k = 0; k + 1 < a.length; k += 2) { a[k] += tx; a[k + 1] += ty; }
  }
  return formatPath(r.cmds, 3);
}

/**
 * «Подогнать viewBox»: деталь, нарисованная в координатах холста иллюстрации,
 * становится вектором ровно по своей рамке: viewBox — рамка контуров, pos — её
 * левый верхний угол, размер — фиксированный, 1:1 с координатами холста.
 * @param {Array<string|object>|string} paths
 * @param {{pad?:number}} [opts]
 * @returns {{viewBox:{x:number,y:number,w:number,h:number}, pos:{x:number,y:number}, size:object}|null}
 */
function fitVector(paths, opts) {
  const b = pathBounds(paths);
  if (!b) return null;
  const pad = opts && isNum(opts.pad) ? clamp(opts.pad, 0, 1000) : 0;
  const x = r2(Math.floor((b.x - pad) * 100) / 100);
  const y = r2(Math.floor((b.y - pad) * 100) / 100);
  const w = r2(Math.max(1, Math.ceil((b.x + b.w + pad - x) * 100) / 100));
  const h = r2(Math.max(1, Math.ceil((b.y + b.h + pad - y) * 100) / 100));
  return {
    viewBox: { x, y, w, h },
    pos: { x: clamp(x, -MAX_SIZE, MAX_SIZE), y: clamp(y, -MAX_SIZE, MAX_SIZE) },
    size: sizeSpec(w, h)
  };
}

/* ------------------------------------------------------------------ *
 * 2b. Тема доски (круг 48, SPEC §15)
 *
 * Поле `theme` фрейма-доски: свои значения части токенов документа —
 * `{colors?: {<имя>: '#rrggbb'}, type?: {<имя>: {font?, fontWeight?}}}`.
 * Узлы доски ссылаются на ТЕ ЖЕ имена токенов (`{token:'accent'}`, style
 * 'display'); разрешаются они сначала по теме своей доски, затем по документу.
 * Тема — только у доски (фрейм — ребёнок корня): у фрейма внутри макета поле
 * допустимо по форме, но не действует (validate: theme-not-board).
 * ЕДИНСТВЕННОЕ место, где тема становится токенами, — themedDoc: решатель,
 * валидатор, сцена, экспорт и мозг читают токены узла через docAt/themeScope.
 * ------------------------------------------------------------------ */

/** Пределы темы: число цветов и стилей, длина имени шрифта. */
const THEME_LIMITS = Object.freeze({ colors: 64, type: 32, font: 80 });
/** Ключи темы и ключи стиля в теме (кегль и интерлиньяж — у документа: тема не двигает раскладку шкалой). */
const THEME_KEYS = Object.freeze(['colors', 'type']);
const THEME_TYPE_FIELDS = Object.freeze(['font', 'fontWeight']);
const THEME_HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Имя токена в теме: как имя в палитре — буква, затем буквы, цифры, «-» и «_». */
const THEME_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/**
 * Форма поля theme. Строгая: тему читает отрисовка каждой доски.
 * @returns {string|null}
 */
function themeProblem(v) {
  if (!isObj(v)) return 'theme: нужен объект';
  for (const k of Object.keys(v)) if (THEME_KEYS.indexOf(k) < 0) return `theme: неизвестный ключ «${shown(k)}»`;
  if (v.colors !== undefined) {
    if (!isObj(v.colors)) return 'theme.colors: нужен объект';
    const names = Object.keys(v.colors);
    if (names.length > THEME_LIMITS.colors) return `theme.colors: больше ${THEME_LIMITS.colors} цветов`;
    for (const k of names) {
      if (!THEME_NAME_RE.test(k) || PROTO_KEYS.has(k)) return `theme.colors: имя «${shown(k)}» не годится`;
      const c = v.colors[k];
      if (typeof c !== 'string' || !THEME_HEX_RE.test(c)) return `theme.colors.${k}: нужен цвет #rrggbb`;
    }
  }
  if (v.type !== undefined) {
    if (!isObj(v.type)) return 'theme.type: нужен объект';
    const names = Object.keys(v.type);
    if (names.length > THEME_LIMITS.type) return `theme.type: больше ${THEME_LIMITS.type} стилей`;
    for (const k of names) {
      if (!THEME_NAME_RE.test(k) || PROTO_KEYS.has(k)) return `theme.type: имя «${shown(k)}» не годится`;
      const e = v.type[k];
      if (!isObj(e)) return `theme.type.${k}: нужен объект`;
      for (const f of Object.keys(e)) if (THEME_TYPE_FIELDS.indexOf(f) < 0) return `theme.type.${k}: поле «${shown(f)}» темой не задаётся`;
      if (e.font !== undefined && (typeof e.font !== 'string' || !e.font.trim() || e.font.length > THEME_LIMITS.font)) {
        return `theme.type.${k}.font: имя шрифта — строка до ${THEME_LIMITS.font} знаков`;
      }
      if (e.fontWeight !== undefined && !(isNum(e.fontWeight) && e.fontWeight >= 100 && e.fontWeight <= 900)) {
        return `theme.type.${k}.fontWeight вне диапазона 100..900`;
      }
    }
  }
  return null;
}

/** Доска узла: предок-или-сам, чей родитель — корень (только фрейм). get — карта узлов с раскрытыми. */
function boardOf(doc, id, get) {
  const look = get || ((x) => ownNode(doc.nodes, x));
  let cur = typeof id === 'string' ? look(id) : id;
  for (let guard = 0; cur && guard <= MAX_DEPTH + 1; guard++) {
    if (cur.parent === doc.root) return cur.type === 'frame' ? cur : null;
    if (typeof cur.parent !== 'string') return null;
    cur = look(cur.parent);
  }
  return null;
}

/**
 * Круг 48: запись журнала прежнего движка → операции нынешнего. Движки 1–2 принимали `theme`
 * простыми данными и ничего по нему не рисовали; движок 3 такое поле проверяет строго — запись с
 * `set theme 'dark'` отвергалась бы целиком вместе с соседними правками. Поэтому у записей
 * движка ниже 3 поле `theme` снимается (create — без поля, set/снятие по пути theme — пропуск):
 * вид документа тот же, что у прежнего движка. Своя и неизвестная версия — как есть.
 * @param {any[]} list @param {any} engine версия записи
 * @returns {any[]}
 */
function liftOps(list, engine) {
  if (!Array.isArray(list) || !(Number.isInteger(engine) && engine < 3)) return list;
  let out = null;
  for (let i = 0; i < list.length; i++) {
    const op = list[i];
    let next = op;
    if (op && op.op === 'set' && typeof op.path === 'string' && (op.path === 'theme' || op.path.indexOf('theme.') === 0)) next = null;
    else if (op && op.op === 'create' && isObj(op.node) && hasOwnProp.call(op.node, 'theme')) {
      const node = { ...op.node };
      delete node.theme;
      next = { ...op, node };
    }
    if (next !== op && !out) out = list.slice(0, i);
    if (out && next) out.push(next);
  }
  return out || list;
}

/** Есть ли у доски годная тема (документ прежней версии мог принести мусор — он не действует). */
function boardTheme(board) {
  const t = board && board.theme;
  return t !== undefined && t !== null && !themeProblem(t) ? t : null;
}

const themedCache = new WeakMap();
/**
 * Документ, каким его видит доска: токены документа, поверх — тема доски.
 * Без темы — сам doc. Узлы — общие (копия поверхностная), поэтому результат
 * годится только для ЧТЕНИЯ токенов. Кеш — по объекту темы и токенам документа.
 * @param {object} doc @param {object|null} board
 * @returns {object}
 */
function themedDoc(doc, board) {
  const theme = boardTheme(board);
  if (!theme || !doc) return doc;
  const hit = themedCache.get(theme);
  if (hit && hit.doc === doc) return hit.out;
  const tokens = isObj(doc.tokens) ? doc.tokens : DEFAULT_TOKENS;
  let out;
  if (hit && hit.tokens === tokens) out = { ...doc, tokens: hit.out.tokens };
  else {
    const colors = { ...(isObj(tokens.colors) ? tokens.colors : DEFAULT_TOKENS.colors) };
    if (theme.colors) for (const k of Object.keys(theme.colors)) colors[k] = theme.colors[k];
    const docType = isObj(tokens.type) ? tokens.type : DEFAULT_TOKENS.type;
    const type = { ...docType };
    if (theme.type) {
      for (const k of Object.keys(theme.type)) {
        const base = isObj(ownNode(docType, k)) ? docType[k] : (ownNode(DEFAULT_TOKENS.type, k) || docType.body || DEFAULT_TOKENS.type.body);
        type[k] = { ...base, ...theme.type[k] };
      }
    }
    out = { ...doc, tokens: { ...tokens, colors, type } };
  }
  themedCache.set(theme, { doc, tokens, out });
  return out;
}

/** Документ для токенов узла: тема его доски поверх документа. */
function docAt(doc, id, get) {
  if (!doc || !doc.nodes) return doc;
  return themedDoc(doc, boardOf(doc, id, get));
}

/**
 * Разрешатель «узел → документ его доски» на один проход (validate, сцена):
 * доска каждого узла считается один раз. Без тем в документе — сам doc сразу.
 * @param {object} doc @param {(id:string)=>object|undefined} [get]
 * @returns {(id:string)=>object}
 */
function themeScope(doc, get) {
  if (!doc || !doc.nodes || !doc.nodes[doc.root]) return () => doc;
  const boards = new Map();
  let any = false;
  for (const id of kidsOf(doc.nodes[doc.root])) {
    const b = ownNode(doc.nodes, id);
    if (b && b.type === 'frame' && boardTheme(b)) { boards.set(id, themedDoc(doc, b)); any = true; }
  }
  if (!any) return () => doc;
  const look = get || ((x) => ownNode(doc.nodes, x));
  const memo = new Map();
  return (id) => {
    if (memo.has(id)) return memo.get(id);
    const path = [];
    let cur = look(id);
    let res = doc;
    for (let guard = 0; cur && guard <= MAX_DEPTH + 1; guard++) {
      if (memo.has(cur.id)) { res = memo.get(cur.id); break; }
      path.push(cur.id);
      if (cur.parent === doc.root) { res = boards.get(cur.id) || doc; break; }
      if (typeof cur.parent !== 'string') break;
      cur = look(cur.parent);
    }
    for (const p of path) memo.set(p, res);
    if (!memo.has(id)) memo.set(id, res);
    return res;
  };
}

/**
 * Круг 43: поля узла с собственной формой — ЕДИНСТВЕННАЯ таблица и для проверки
 * (fieldProblem), и для отпечатка формата (formatSignature → тест «формат меняется
 * только вместе с ENGINE_VERSION»). Новое поле, новый тип узла, новое значение
 * перечисления — сюда (или в таблицы, на которые тут ссылаются), и отпечаток
 * изменится сам. Поля вне таблиц — простые данные (plainProblem).
 * only — поле бывает только у этих типов, not — не бывает у этих; typeMsg — отказ.
 */
const FIELD_RULES = Object.freeze({
  style: { check: (v) => styleProblem(v) },
  fill: { check: (v, n, k) => paintProblem(v, k) },
  color: { check: (v, n, k) => paintProblem(v, k, false, true) },
  stroke: { check: (v) => strokeProblem(v) },
  align: {
    check: (v, node) => (node.type === 'text' ? (TEXT_ALIGNS.has(v) ? null : 'text.align') : (typeof v === 'string' ? null : 'align должен быть строкой'))
  },
  opacity: { check: (v) => (isNum(v) && v >= 0 && v <= 1 ? null : 'opacity вне 0..1') },
  radius: { check: (v) => checkRadiusValue(v) },
  size: { check: (v) => sizeShapeProblem(v) },
  layout: { check: (v) => layoutShapeProblem(v) },
  pos: { check: (v) => (isObj(v) && POS_AXES.every((a) => isNum(v[a])) ? null : 'pos: нужны числа x,y') },
  override: {
    check: (v) => {
      if (v !== null && !(isObj(v) && POS_AXES.every((a) => isNum(v[a])))) return 'override: нужны числа x,y';
      if (v && SIZE_AXES.some((a) => !optNum(v, a, 0, MAX_SIZE))) return 'override: w и h — числа';
      return null;
    }
  },
  // круг 36 (SPEC §11): состояния и движение; у страницы состояний нет
  // (state-on-page: на импорт — отказ, create/set — bad-node)
  states: { not: Object.freeze(['page']), typeMsg: 'states: у страницы состояний не бывает', check: (v) => statesProblem(v) },
  motion: { check: (v) => motionProblem(v) },
  shadow: { check: (v) => shadowRefProblem(v, 'shadow') },
  props: { check: (v) => (isObj(v) ? null : 'props экземпляра: нужен объект') },
  component: { check: (v) => (isObj(v) ? null : 'component должен быть объектом') },
  // круг 37 (SPEC §12.1): поворот — у всех, кроме страницы; контуры и viewBox — только у вектора
  rotate: {
    not: Object.freeze(['page']), typeMsg: 'rotate: страницу не поворачивают',
    check: (v) => (isNum(v) && v >= -ROTATE_LIMIT && v <= ROTATE_LIMIT ? null : `rotate: градусы −${ROTATE_LIMIT}..${ROTATE_LIMIT}`)
  },
  viewBox: { only: Object.freeze(['vector']), typeMsg: 'viewBox бывает только у vector', check: (v) => viewBoxProblem(v) },
  paths: { only: Object.freeze(['vector']), typeMsg: 'paths бывают только у vector', check: (v) => pathsProblem(v) },
  // круг 48 (SPEC §15): тема доски — свои значения токенов цвета и шрифтов
  theme: { only: Object.freeze(['frame']), typeMsg: 'theme бывает только у фрейма-доски', check: (v) => themeProblem(v) }
});

/**
 * Форма ОДНОГО поля узла. Структурные поля (id, type, parent, children) — не
 * здесь: их проверяет checkNode. Обязательность поля (size у фрейма,
 * characters у текста) — тоже там.
 * @param {object} node @param {string} k имя поля верхнего уровня
 * @returns {string|null} причина или null
 */
function fieldProblem(node, k) {
  if (STRUCT_FIELDS.has(k)) return null;
  const v = node[k];
  if (v === undefined) return null;
  let err = null;
  if (STRING_FIELDS.has(k)) err = typeof v === 'string' ? null : `${k} должен быть строкой`;
  else if (BOOL_FIELDS.has(k)) err = typeof v === 'boolean' ? null : `${k}: нужно true или false`;
  else if (hasOwnProp.call(FIELD_RULES, k)) {
    const rule = FIELD_RULES[k];
    if (rule.only && !rule.only.includes(node.type)) err = rule.typeMsg;
    else if (rule.not && rule.not.includes(node.type)) err = rule.typeMsg;
    else err = rule.check(v, node, k);
  }
  if (err) return err;
  const plain = plainProblem(v, 0);
  return plain ? `${k}: ${plain}` : null;
}

/**
 * Копия узла без полей негодной формы (кроме `keep`) — для проверки правки на
 * узле из документа прежней версии. Обязательные поля получают заглушку того
 * вида, что требует схема. Нечего снимать — тот же объект.
 */
function withoutBadFields(node, keep) {
  let out = node;
  for (const k of Object.keys(node)) {
    if (k === keep || STRUCT_FIELDS.has(k) || !fieldProblem(node, k)) continue;
    if (out === node) out = { ...node };
    if (k === 'characters' && node.type === 'text') out.characters = '';
    else if (k === 'size' && node.type !== 'page' && node.type !== 'instance') out.size = sizeSpec('hug', 'hug');
    else if (k === 'of' && node.type === 'instance') out.of = '?' + node.id;
    else if (k === 'viewBox' && node.type === 'vector') out.viewBox = { w: 1, h: 1 };
    else if (k === 'paths' && node.type === 'vector') out.paths = [];
    else delete out[k];
  }
  return out;
}

/** Форма всех полей узла: первая причина или null. */
function fieldsProblem(node) {
  for (const k of Object.keys(node)) {
    if (PROTO_KEYS.has(k)) return `поле «${k}» зарезервировано`;
    const err = fieldProblem(node, k);
    if (err) return err;
  }
  return null;
}

/**
 * Проверка узла по схеме. Возвращает строку с ошибкой или null.
 * @param {any} node
 * @param {object} [doc] — для проверки ссылок (необязательно)
 * @returns {string|null}
 */
function checkNode(node, doc, loose) {
  if (!node || typeof node !== 'object') return 'узел должен быть объектом';
  if (typeof node.id !== 'string' || !node.id) return 'нет id';
  if (PROTO_KEYS.has(node.id)) return `id «${node.id}» зарезервирован`;
  if (!NODE_TYPES.has(node.type)) return `неизвестный тип «${shown(node.type)}»`;
  if (node.name !== undefined && typeof node.name !== 'string') return 'name должен быть строкой';
  if (node.type === 'page') {
    /* Круг 19, п.1: страница-библиотека — единственная страница с родителем
       (SPEC §5.3: второй потомок корня). Остальным страницам родитель по-прежнему
       запрещён: на этом стоит «корень — страница без родителя». */
    if (node.parent !== null && node.parent !== undefined) {
      if (node.role !== LIBRARY_ROLE) return 'page не может иметь родителя';
      if (typeof node.parent !== 'string') return 'нет parent';
      if (doc && doc.root && node.parent !== doc.root) return 'библиотека может лежать только в корне';
    }
  } else if (typeof node.parent !== 'string') return 'нет parent';
  if (CONTAINER_TYPES.has(node.type)) {
    if (!Array.isArray(node.children)) return 'children должен быть массивом';
    if (node.children.some((c) => typeof c !== 'string')) return 'children: только id';
  } else if (node.type === 'instance' && node.children !== undefined) {
    // SPEC §5.5: детей у экземпляра нет — его содержимое это мастер
    if (Array.isArray(node.children) ? node.children.length > 0 : true) return 'у экземпляра не бывает детей';
  } else if (node.children !== undefined) {
    /* Круг 31: у не-контейнера children — либо нет, либо пустой массив. Раньше
       `create {type:'text', children:{0:'a',length:1}}` ложился в документ, а
       потом remove бросал TypeError на обходе поддерева — узел (и всё над ним)
       становился неудаляемым. */
    if (!Array.isArray(node.children)) return 'children должен быть массивом';
    if (node.children.length) return 'дети бывают только у контейнера';
  }
  if (node.type === 'instance') {
    const instErr = checkInstance(node, doc);
    if (instErr) return instErr;
  } else if (node.type !== 'page') {
    const s = node.size;
    if (!s || typeof s !== 'object') return 'нет size';
    for (const ax of ['w', 'h']) {
      const spec = s[ax];
      if (!spec || !SIZE_MODES.has(spec.mode)) return `size.${ax}: неизвестный режим`;
      if (spec.mode === 'fixed') {
        if (!isNum(spec.value)) return `size.${ax}.value должен быть числом`;
        if (spec.value < 0 || spec.value > MAX_SIZE) return `size.${ax}.value вне диапазона 0..${MAX_SIZE}`;
      }
    }
  }
  if (node.component !== undefined) {
    const compErr = checkComponent(node, doc, loose);
    if (compErr) return compErr;
  }
  if (node.type === 'frame') {
    const l = node.layout;
    if (l !== undefined) {
      if (!l || typeof l !== 'object') return 'layout должен быть объектом';
      if (!LAYOUT_MODES.has(l.mode)) return `layout.mode: «${shown(l.mode)}»`;
      /* Круг 20 (SPEC §6.1): зазор и отступы — число в границах ЛИБО ссылка на
         шаг шкалы отступов ('spacing.<i>'). Ссылка не в ту шкалу отклоняется
         здесь; есть ли такой шаг — проверяет операция (см. deadScaleRefs). */
      if (l.gap !== undefined) {
        const err = checkScaleValue(l.gap, 'spacing', 'layout.gap');
        if (err) return err;
      }
      if (l.align !== undefined && !ALIGNS.has(l.align)) return `layout.align: «${shown(l.align)}»`;
      if (l.justify !== undefined && !JUSTIFIES.has(l.justify)) return `layout.justify: «${shown(l.justify)}»`;
      if (l.padding !== undefined) {
        if (!l.padding || typeof l.padding !== 'object') return 'layout.padding должен быть объектом';
        for (const k of PAD_KEYS) {
          const v = l.padding[k];
          if (v === undefined) continue;
          const err = checkScaleValue(v, 'spacing', `layout.padding.${k}`);
          if (err) return err;
        }
      }
    }
  }
  if (node.type === 'vector') {
    // круг 37 (SPEC §12.1): viewBox и контуры обязательны; форму проверяет fieldProblem
    if (node.viewBox === undefined) return 'vector: нет viewBox';
    if (node.paths === undefined) return 'vector: нет paths';
  }
  if (node.type === 'text') {
    if (typeof node.characters !== 'string') return 'text: нет characters';
    if (node.style !== undefined && typeof node.style !== 'string' && (typeof node.style !== 'object' || !node.style)) {
      return 'text: style — имя токена или объект';
    }
    if (node.style && typeof node.style === 'object') {
      for (const k of ['fontSize', 'lineHeight']) {
        const v = node.style[k];
        if (v !== undefined && (!isNum(v) || v <= 0 || v > 1000)) return `style.${k} вне диапазона`;
      }
      if (node.style.fontWeight !== undefined) {
        const w = node.style.fontWeight;
        if (!isNum(w) || w < 100 || w > 900) return 'style.fontWeight вне диапазона 100..900';
      }
    }
    if (node.align !== undefined && !['left', 'center', 'right'].includes(node.align)) return 'text.align';
  }
  // круг 20 (SPEC §6.1): скругление — число, ссылка 'radii.<i>' или массив таких
  const radErr = checkRadiusValue(node.radius);
  if (radErr) return radErr;
  if (node.pos !== undefined) {
    if (!node.pos || !isNum(node.pos.x) || !isNum(node.pos.y)) return 'pos: нужны числа x,y';
    // без верхнего предела pos.x = 1e308 превращает геометрию в Infinity — тот же
    // вход в «нечисловой вид», что и битый size.value
    if (Math.abs(node.pos.x) > MAX_SIZE || Math.abs(node.pos.y) > MAX_SIZE) {
      return `pos вне диапазона ±${MAX_SIZE}`;
    }
  }
  if (node.override !== undefined && node.override !== null) {
    const o = node.override;
    if (!o || !isNum(o.x) || !isNum(o.y)) return 'override: нужны числа x,y';
    if (Math.abs(o.x) > MAX_SIZE || Math.abs(o.y) > MAX_SIZE) return `override вне диапазона ±${MAX_SIZE}`;
    if (o.w !== undefined && (!isNum(o.w) || o.w < 0 || o.w > MAX_SIZE)) return 'override.w';
    if (o.h !== undefined && (!isNum(o.h) || o.h < 0 || o.h > MAX_SIZE)) return 'override.h';
  }
  if (node.opacity !== undefined && (!isNum(node.opacity) || node.opacity < 0 || node.opacity > 1)) return 'opacity вне 0..1';
  // круг 29: форма КАЖДОГО поля — строки строками, флаги булевы, обёртки цвета и
  // стиля с полями своего вида, всё незнакомое — простые данные (см. fieldProblem)
  const shapeErr = fieldsProblem(node);
  if (shapeErr) return shapeErr;
  if (doc && node.parent && !ownNode(doc.nodes, node.parent)) return `родитель «${shown(node.parent)}» не найден`;
  return null;
}

/* ------------------------------------------------------------------ *
 * 2.5 Компоненты: библиотека, мастера, экземпляры (круг 19, SPEC §5)
 *
 * Новых операций нет (SPEC §5.2): мастер — это ПОЛЕ `component` на обычном узле
 * библиотеки, экземпляр — узел типа `instance`. Поэтому create/remove/set/move/
 * setToken, иммутабельность applyOps и отмена через invertOps работают как были.
 * Синхронизировать нечего: геометрию экземпляра считает решатель (см. expandDoc).
 * ------------------------------------------------------------------ */

/** Имя компонента для человека и модели. @returns {string} */
function componentName(master) {
  const c = master && master.component;
  const n = c && typeof c.name === 'string' ? c.name.trim() : '';
  return n || 'Компонент';
}

/** Пропсы мастера по имени. Дубли и мусор отбрасываются. @returns {Map<string,object>} */
function propMap(master) {
  const out = new Map();
  const list = master && master.component && Array.isArray(master.component.props) ? master.component.props : [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name) continue;
    if (!out.has(p.name)) out.set(p.name, p);
  }
  return out;
}

/**
 * Значение пропса, приведённое к его виду. `undefined` — значение не годится
 * (такой пропс не применяется, см. SPEC §5.5 и checkInstance).
 */
function propValue(prop, raw) {
  switch (prop && prop.kind) {
    case 'text': return typeof raw === 'string' ? raw : undefined;
    case 'number': return isNum(raw) ? raw : undefined;
    case 'bool': return typeof raw === 'boolean' ? raw : undefined;
    // цвет живёт в узле и строкой ('accent', '#ff0000'), и обёрткой {token} — берём оба вида
    case 'color': return (typeof raw === 'string' && raw) || wrappedName(raw, WRAPPED_FIELDS.fill) !== undefined
      ? deepClone(raw) : undefined;
    case 'enum': return typeof raw === 'string' && Array.isArray(prop.values) && prop.values.indexOf(raw) >= 0
      ? raw : undefined;
    default: return undefined;
  }
}

/**
 * Лежит ли `targetId` в поддереве узла `node`. Идём ВНИЗ по children, а не вверх
 * по parent: в момент `create` заранее перечисленные дети ещё числятся у прежних
 * родителей (их перевешивает applyOne уже после проверки схемы), и подъём по
 * parent отклонял бы законный мастер, созданный одной операцией со своим деревом.
 * @returns {boolean}
 */
function inSubtree(doc, node, targetId) {
  if (!node || !targetId) return false;
  if (node.id === targetId) return true;
  if (!doc || !doc.nodes) return false;
  const seen = new Set([node.id]);
  const stack = kidsOf(node).slice();
  let guard = 0;
  while (stack.length) {
    if (guard++ > 100000) return false;
    const id = stack.pop();
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = doc.nodes[id];
    if (n) for (const c of kidsOf(n)) stack.push(c);
  }
  return false;
}

/**
 * Проверка поля `component` по схеме SPEC §5.4.
 * @returns {string|null} причина или null
 */
function checkComponent(node, doc, loose) {
  const c = node.component;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'component должен быть объектом';
  if (typeof c.name !== 'string' || !c.name.trim()) return 'component.name: нужно непустое имя';
  if (c.props !== undefined && !Array.isArray(c.props)) return 'component.props должен быть массивом';
  const seen = new Set();
  for (const p of (Array.isArray(c.props) ? c.props : [])) {
    if (!p || typeof p !== 'object') return 'component.props: пропс должен быть объектом';
    if (typeof p.name !== 'string' || !p.name.trim()) return 'component.props: нужно непустое имя пропса';
    /* Круг 34: имя пропса — один сегмент пути `props.<имя>` у экземпляра. С точкой
       (`a.b`, `a.`) путь дробился: пустой сегмент (отказ set) или лишний уровень
       (`props.a = {b}` — пропс, которого мастер не объявлял). Ключ прототипа —
       тот же отказ, что у set (`protected-path`). */
    if (p.name.includes('.')) return `component.props: в имени пропса «${p.name}» не бывает точки`;
    if (PROTO_KEYS.has(p.name)) return `component.props: имя пропса «${p.name}» зарезервировано`;
    if (seen.has(p.name)) return `component.props: имя «${p.name}» встречается дважды`;
    seen.add(p.name);
    if (!PROP_KINDS.has(p.kind)) return `component.props «${p.name}»: kind «${shown(p.kind)}» неизвестен`;
    if (typeof p.target !== 'string' || !p.target) return `component.props «${p.name}»: нет target`;
    if (typeof p.path !== 'string' || !p.path) return `component.props «${p.name}»: нет path`;
    // путь — тот же, что понимает set, значит и запреты те же
    const parts = p.path.split('.');
    if (PROTECTED_PATHS.has(parts[0])) return `component.props «${p.name}»: путь «${parts[0]}» защищён`;
    if (parts.some((x) => UNSAFE_KEYS.has(x))) return `component.props «${p.name}»: путь «${p.path}» защищён`;
    // круг 33: и пустой сегмент — как у set
    if (parts.includes('')) return `component.props «${p.name}»: пустой сегмент в пути «${p.path}»`;
    if (p.kind === 'enum') {
      const ok = Array.isArray(p.values) && p.values.length && p.values.every((v) => typeof v === 'string' && v);
      if (!ok) return `component.props «${p.name}»: enum без непустого списка values`;
    }
    // SPEC §5.4: target обязан быть узлом ВНУТРИ этого мастера
    /* Круг 25: инверсия (`exact`) возвращает узел таким, каким он был, и не
       проверяет цели: удаление воссоздаётся родителем раньше детей — цели пропсов
       ещё не созданы, и отмена удаления компонента (и библиотеки целиком) не
       ложилась. Так же — цель, которую чужой move успел вынести из мастера (move
       мастера не перепроверяет): об этом скажет validate, отмена не отказывает. */
    if (!loose && doc && doc.nodes && !inSubtree(doc, node, p.target)) {
      return `component.props «${p.name}»: target «${p.target}» вне мастера`;
    }
  }
  return null;
}

/** Проверка узла-экземпляра по схеме SPEC §5.5. @returns {string|null} */
function checkInstance(node, doc) {
  if (typeof node.of !== 'string' || !node.of) return 'экземпляр: нет ссылки of на мастера';
  if (node.of === node.id) return 'экземпляр: of указывает на сам экземпляр';
  if (node.size !== undefined) {
    if (!node.size || typeof node.size !== 'object' || Array.isArray(node.size)) return 'size экземпляра: нужен объект';
    for (const ax of ['w', 'h']) {
      const spec = node.size[ax];
      if (spec === undefined) continue;   // ось не задана — берётся у мастера
      if (!spec || !SIZE_MODES.has(spec.mode)) return `size.${ax}: неизвестный режим`;
      if (spec.mode === 'fixed') {
        if (!isNum(spec.value)) return `size.${ax}.value должен быть числом`;
        if (spec.value < 0 || spec.value > MAX_SIZE) return `size.${ax}.value вне диапазона 0..${MAX_SIZE}`;
      }
    }
  }
  if (node.props !== undefined) {
    if (!node.props || typeof node.props !== 'object' || Array.isArray(node.props)) return 'props экземпляра: нужен объект';
    const master = doc && doc.nodes ? ownNode(doc.nodes, node.of) : null;
    // мастера может ещё не быть (его создаёт соседняя операция той же транзакции) —
    // тогда имена пропсов проверять нечем, об этом скажет validate (dead-instance)
    if (master && master.component) {
      const known = propMap(master);
      for (const name of Object.keys(node.props)) {
        // SPEC §5.5: неизвестное имя пропса — негодная операция
        if (!known.has(name)) return `props: «${componentName(master)}» не объявлял пропс «${name}»`;
        if (propValue(known.get(name), node.props[name]) === undefined) {
          return `props.${name}: значение не годится для вида «${known.get(name).kind}»`;
        }
      }
    }
  }
  return null;
}

/** Библиотека ли этот узел (SPEC §5.3). @returns {boolean} */
function isLibrary(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  return !!(n && n.type === 'page' && n.role === LIBRARY_ROLE && doc && n.parent === doc.root);
}

/** Узел библиотеки документа или null. @returns {object|null} */
function libraryNode(doc) {
  const root = nodeById(doc, doc && doc.root);
  if (!root) return null;
  for (const id of kidsOf(root)) {
    const n = nodeById(doc, id);
    if (isLibrary(doc, n)) return n;
  }
  return null;
}

/** id библиотеки или null. @returns {string|null} */
function libraryId(doc) {
  const n = libraryNode(doc);
  return n ? n.id : null;
}

/**
 * Мастер ли узел: поле `component` ПЛЮС место — прямой ребёнок библиотеки
 * (SPEC §5.3: «его дети — мастера компонентов»). Поле само по себе мастером не
 * делает: иначе `set component` на карточке внутри доски молча создавал бы
 * компонент, которого нет в словаре агента, и холст с валидатором расходились бы.
 * @returns {boolean}
 */
function isMaster(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  if (!n || !n.component || typeof n.component !== 'object') return false;
  const lib = libraryNode(doc);
  return !!lib && n.parent === lib.id;
}

/** Мастер экземпляра или null (ссылка мёртвая либо ведёт вне библиотеки). */
function masterOf(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  if (!n || n.type !== 'instance' || typeof n.of !== 'string') return null;
  const m = nodeById(doc, n.of);
  return isMaster(doc, m) ? m : null;
}

/**
 * Размер экземпляра: своя ось, если задана, иначе ось мастера. Так экземпляр
 * кнопки 200×48 получает её размер сам, а ресайз одной кромкой (он пишет только
 * потянутую ось — см. Stage._resizeOps) не превращает вторую ось в «по содержимому».
 * @returns {{w:object,h:object}}
 */
function instanceSize(inst, master) {
  const own = inst && inst.size && typeof inst.size === 'object' ? inst.size : null;
  const base = master && master.size && typeof master.size === 'object' ? master.size : null;
  const pick = (ax) => {
    const a = own && own[ax];
    if (a && SIZE_MODES.has(a.mode)) return deepClone(a);
    const b = base && base[ax];
    if (b && SIZE_MODES.has(b.mode)) return deepClone(b);
    return { mode: 'hug' };
  };
  return { w: pick('w'), h: pick('h') };
}

/**
 * Список компонентов документа — производная от детей библиотеки, реестра нет
 * (SPEC §5.4). Это словарь агента: brain строит из него блок «БИБЛИОТЕКА», а
 * оболочка — панель компонентов.
 * @returns {Array<{id:string,name:string,props:Array,instances:number}>}
 */
function components(doc) {
  const lib = libraryNode(doc);
  if (!lib) return [];
  const used = new Map();
  for (const id of Object.keys((doc && doc.nodes) || {})) {
    const n = doc.nodes[id];
    if (n && n.type === 'instance' && typeof n.of === 'string') used.set(n.of, (used.get(n.of) || 0) + 1);
  }
  const out = [];
  for (const id of kidsOf(lib)) {
    const n = nodeById(doc, id);
    if (!n || !n.component || typeof n.component !== 'object') continue;
    const props = [];
    for (const p of propMap(n).values()) {
      props.push({
        name: p.name, kind: p.kind, target: p.target, path: p.path,
        ...(p.kind === 'enum' ? { values: p.values.slice() } : {})
      });
    }
    out.push({ id: n.id, name: componentName(n), props, instances: used.get(n.id) || 0 });
  }
  return out;
}

/**
 * Строка компонента для словаря модели (SPEC §5.9):
 * `Кнопка(текст, вид: accent|surface)`.
 * @param {{name:string,props:Array}} info элемент components()
 * @returns {string}
 */
function componentSignature(info) {
  if (!info) return '';
  const parts = (info.props || []).map((p) => (p.kind === 'enum' && Array.isArray(p.values) && p.values.length
    ? `${p.name}: ${p.values.join('|')}` : p.name));
  return `${info.name}${parts.length ? '(' + parts.join(', ') + ')' : '()'}`;
}

/**
 * Экземпляр одной строкой (SPEC §5.9): `Кнопка "Оплатить" вид=accent`.
 * Без внутренностей — в этом и смысл: выжимка документа схлопывается.
 * @returns {string}
 */
function instanceSummary(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  if (!n || n.type !== 'instance') return '';
  const master = masterOf(doc, n);
  const name = master ? componentName(master) : `?${shown(n.of)}`;
  const known = propMap(master);
  const bits = [];
  for (const [key, p] of known) {
    const raw = n.props ? n.props[key] : undefined;
    if (raw === undefined) continue;
    if (p.kind === 'text') bits.push(`"${shown(raw)}"`);
    else bits.push(`${key}=${typeof raw === 'string' ? raw : wrappedName(raw, WRAPPED_FIELDS.fill) || JSON.stringify(raw)}`);
  }
  return bits.length ? `${name} ${bits.join(' ')}` : name;
}

/* ---------------------- раскрытие экземпляров ---------------------- */

/**
 * Кеш раскрытия: экземпляр → его синтетические узлы и те узлы документа, от
 * которых результат зависит. Нужен НЕ ради скорости, а ради ссылок: точечная
 * отрисовка Stage._patchSVG (круг 16, п.6) сравнивает узлы по ссылке, а у
 * раскрытых узлов своей ссылки в документе нет. Пока экземпляр и поддерево его
 * мастера — те же объекты, раскрытие отдаёт ТЕ ЖЕ объекты, и сцена не
 * пересобирает экземпляры на каждую чужую правку. Правка мастера сразу делает
 * записи негодными — и все его экземпляры перерисовываются разом.
 * @type {WeakMap<object,{deps:Array, nodes:Record<string,object>}>}
 */
const expandCache = new WeakMap();

/**
 * Круг 52: «форма» раскрытого экземпляра — ключ, равный у экземпляров с одним и тем же раскрытым
 * поддеревом с точностью до id: те же объекты мастеров (зависимости раскрытия) и те же поля самого
 * экземпляра, кроме id, родителя, места и имени. По нему solve раскладывает поддерево один раз, а
 * остальные экземпляры той же формы и того же размера получают его копию со сдвигом (placeNode).
 * Ключ висит на объекте раскрытого корня: пока раскрытие берётся из expandCache, ключ тот же.
 */
const expandShape = new WeakMap();
const shapeSerial = new WeakMap();
let shapeSerialNext = 0;
function shapeSig(deps, inst) {
  let s = '';
  for (let i = 0; i < deps.length; i += 2) {
    const o = deps[i + 1];
    let n = 'u';
    if (o && typeof o === 'object') {
      n = shapeSerial.get(o);
      if (n === undefined) { n = ++shapeSerialNext; shapeSerial.set(o, n); }
    }
    s += String(deps[i]) + ':' + n + ',';
  }
  const own = { ...inst };
  delete own.id; delete own.parent; delete own.pos; delete own.name;
  return s + '|' + JSON.stringify(own);
}

/** Свежи ли зависимости записи кеша: те же объекты по тем же id. @returns {boolean} */
function depsFresh(doc, deps) {
  for (let i = 0; i < deps.length; i += 2) {
    if (ownNode(doc.nodes, deps[i]) !== deps[i + 1]) return false;   // круг 29: id из чужого of — не обязательно строка
  }
  return true;
}

/**
 * Раскрывает один экземпляр: кладёт в `out` синтетические узлы поддерева мастера
 * с применёнными пропсами. Корень мастера ложится под id САМОГО экземпляра
 * (он и стоит на его месте), потомки — под `"<id экземпляра>/<id узла мастера>"`
 * (SPEC §5.6). В doc.nodes этих узлов нет и не будет.
 * @param {object} doc
 * @param {object} inst узел-экземпляр (настоящий или уже синтетический)
 * @param {string} rootId id для корня мастера
 * @param {string} ownerId id настоящего экземпляра в документе (для поля instance)
 * @param {number} depth уровень вложенности, 1 — верхний экземпляр
 * @param {string[]} chain мастера, раскрытые выше — защита от самовключения
 * @param {object} out карта синтетических узлов
 * @param {Array} deps плоский список [id, узел, ...] для кеша
 * @param {{left:number}} [budget] круг 39: сколько ещё НОВЫХ узлов можно положить в
 *   `out`; кончился — бросается EXPAND_OVER (раскрытие этого экземпляра
 *   отменяется целиком, вместо него заглушка). Страховка: expandDoc сверяется с
 *   expandAnalysis заранее, и в норме счётчик не срабатывает.
 */
function expandOne(doc, inst, rootId, ownerId, depth, chain, out, deps, budget) {
  const lib = libraryNode(doc);
  deps.push(lib ? lib.id : '', lib || undefined);
  const master = ownNode(doc.nodes, inst.of);
  deps.push(inst.of, master);
  // мёртвая ссылка, мастер вне библиотеки, самовключение и перебор вложенности —
  // не зависание и не исключение, а отсутствие раскрытия: об этом скажет validate
  if (!master || !(lib && master.parent === lib.id) || !master.component) return;
  if (chain.indexOf(master.id) >= 0) return;
  if (depth > MAX_INSTANCE_DEPTH) return;

  const known = propMap(master);
  /** цель → список правок {path, value}: пропсы применяются к узлам мастера */
  const patches = new Map();
  const given = inst.props && typeof inst.props === 'object' ? inst.props : {};
  for (const name of Object.keys(given)) {
    const p = known.get(name);
    if (!p) continue;                                  // неизвестное имя НЕ применяется (SPEC §5.5)
    const v = propValue(p, given[name]);
    if (v === undefined) continue;
    let list = patches.get(p.target);
    if (!list) { list = []; patches.set(p.target, list); }
    list.push({ path: p.path, value: v });
  }

  const synId = (mid) => (mid === master.id ? rootId : rootId + '/' + mid);
  const nested = [];
  for (const mid of subtreeIds(doc, master.id)) {
    const mn = doc.nodes[mid];
    deps.push(mid, mn);
    if (!mn) continue;
    // копия поверхностная: setPath ниже делает свою ветку, а сами узлы никто не правит
    let sn = { ...mn, id: synId(mid), synthetic: true, instance: ownerId, master: mid };
    if (Array.isArray(mn.children)) sn.children = mn.children.map(synId);
    if (mid === master.id) {
      // корень мастера встаёт РОВНО на место экземпляра: его место, размер,
      // видимость и имя — от экземпляра, вид и содержимое — от мастера
      sn.parent = inst.parent;
      delete sn.component;
      // круг 48: тема — поле доски-узла документа; у раскрытого корня мастера её нет (иначе экземпляр
      // прямо на холсте мерился бы темой мастера, а рисовался без неё)
      delete sn.theme;
      sn.size = instanceSize(inst, mn);
      if (inst.name !== undefined) sn.name = inst.name;
      for (const k of ['pos', 'override', 'visible', 'opacity']) {
        if (inst[k] !== undefined) sn[k] = deepClone(inst[k]);
        else delete sn[k];
      }
      if (inst.role !== undefined) sn.role = inst.role;
      if (inst.locked !== undefined) sn.locked = inst.locked;
      /* Круг 36 (SPEC §11): состояния и движение мастера раскрываются в
         экземпляр, свои у экземпляра — поверх (по полям каждого состояния);
         базовая тень экземпляра заменяет тень мастера. */
      if (isObj(inst.states)) sn.states = mergeStates(mn.states, inst.states);
      if (isObj(inst.motion)) sn.motion = { ...(isObj(mn.motion) ? mn.motion : {}), ...inst.motion };
      if (inst.shadow !== undefined) sn.shadow = inst.shadow;
      // круг 37: поворот экземпляра заменяет поворот корня мастера
      if (inst.rotate !== undefined) sn.rotate = inst.rotate;
    } else {
      sn.parent = synId(mn.parent);
    }
    const patch = patches.get(mid);
    if (patch) for (const one of patch) sn = setPath(sn, one.path, one.value);
    if (budget && !hasOwnProp.call(out, sn.id) && --budget.left < 0) throw EXPAND_OVER;
    out[sn.id] = sn;
    if (sn.type === 'instance') nested.push(sn);
  }
  // вложенные экземпляры раскрываем после всего поддерева: запись под тем же id
  // заменяется раскрытым корнем их мастера
  for (const sn of nested) {
    expandOne(doc, sn, sn.id, ownerId, depth + 1, chain.concat(master.id), out, deps, budget);
  }
}

/** Круг 39: сигнал «счётчик раскрытия исчерпан» (не ошибка — заглушка вместо экземпляра). */
const EXPAND_OVER = { expandOver: true };

/* ---------------------- стоимость раскрытия (круг 39) ---------------------- */

/** Голова пути пропса, от которой зависит раскрытие вложенного экземпляра: куда он ведёт и с чем. */
const STRUCT_PROP_HEADS = new Set(['of', 'props']);
const NO_CHAIN = Object.freeze([]);
/** Запись «счёт оборван» — ключей анализа больше предела: стоимость считаем бесконечной. */
const COST_OVER = Object.freeze({ cost: Infinity, kids: NO_CHAIN, d: 0, m: '' });

/**
 * Компоненты сильной связности графа «мастер → мастера его вложенных экземпляров»
 * (итеративный Тарьян: мастеров бывают тысячи, рекурсия положила бы стек).
 * @param {string[]} ids @param {Map<string,string[]>} edges
 * @returns {Map<string,number>} мастер → номер компоненты
 */
function sccMap(ids, edges) {
  const index = new Map();
  const low = new Map();
  const comp = new Map();
  const onStack = new Set();
  const stack = [];
  let next = 0;
  let compNo = 0;
  for (const start of ids) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    index.set(start, next); low.set(start, next); next++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      const out = edges.get(v) || NO_CHAIN;
      if (top[1] < out.length) {
        const w = out[top[1]++];
        if (!edges.has(w)) continue;
        if (!index.has(w)) {
          index.set(w, next); low.set(w, next); next++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low.set(u, Math.min(low.get(u), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          comp.set(w, compNo);
          if (w === v) break;
        }
        compNo++;
      }
    }
  }
  return comp;
}

/**
 * Круг 39: анализ раскрытия документа — сколько узлов даст expandOne каждому
 * экземпляру, ЛИНЕЙНО и без самого раскрытия: мемоизация по мастеру (и глубине —
 * от неё зависит обрыв на MAX_INSTANCE_DEPTH):
 *   cost(m) = |поддерево m| + Σ по экземплярам внутри m (cost(их мастера) − 1)
 * («−1»: раскрытый корень вложенного мастера ложится на место самого экземпляра).
 * Цепочка цикла учитывается точно: от неё зависят только мастера той же
 * компоненты сильной связности, и в ключ памяти входит пересечение цепочки с ней.
 * Пропсы, переписывающие вложенному экземпляру `of`/`props`, тоже входят в ключ
 * (для обычного словаря их нет, и ключ — мастер и глубина). Ссылку, уведённую
 * пропсом назад по цепочке из другой компоненты, счёт не видит и считает дальше —
 * оценка сверху, не снизу. Ключей больше MAX_EXPANDED_NODES (каждый ключ — хотя бы
 * одно настоящее раскрытие) — счёт обрывается бесконечностью.
 *
 * `doc.nodes` читается вживую (стража правок держит анализ над черновиком), а
 * сведения о мастерах кешируются — кто правит библиотеку, заводит анализ заново.
 * @param {object} doc
 * @returns {{instCost:(inst:object)=>number, entry:(inst:object)=>object|null, total:()=>number, heaviest:()=>string|null, multMap:()=>Map<string,number>|null}}
 */
function expandAnalysis(doc) {
  const nodes = doc && doc.nodes && typeof doc.nodes === 'object' ? doc.nodes : {};
  const lib = libraryNode(doc);
  const libId = lib ? lib.id : null;
  /** мастер → {size, nested: id экземпляров поддерева, known, struct: имена структурных пропсов|null} */
  const info = new Map();
  /** ключ → {cost, kids: записи раскрытых вложенных (с повторами), d, m} */
  const memo = new Map();
  let keys = 0;
  let scc = null;
  let totalCache = null;
  let heavy = null;
  let mult = null;
  /** записи верхнего уровня (экземпляры документа) → сколько раз */
  const top = new Map();

  const masterFor = (inst) => {
    const m = ownNode(nodes, inst.of);
    return m && libId !== null && m.parent === libId && m.component ? m : null;
  };
  const infoOf = (m) => {
    let mi = info.get(m.id);
    if (mi) return mi;
    const ids = subtreeIds(doc, m.id);
    const nested = [];
    for (const id of ids) {
      const n = ownNode(nodes, id);
      if (n && n.type === 'instance') nested.push(id);
    }
    const known = propMap(m);
    let struct = null;
    if (nested.length && known.size) {
      const set = new Set(nested);
      for (const p of known.values()) {
        if (typeof p.path !== 'string' || !set.has(p.target)) continue;
        if (!STRUCT_PROP_HEADS.has(p.path.split('.')[0])) continue;
        if (!struct) struct = new Set();
        struct.add(p.name);
      }
    }
    mi = { size: ids.length, nested, known, struct };
    info.set(m.id, mi);
    return mi;
  };
  const sccOf = (id) => {
    if (!scc) {
      const ids = [];
      const edges = new Map();
      for (const mid of kidsOf(lib)) {
        const m = ownNode(nodes, mid);
        if (!m || !m.component || edges.has(mid)) continue;
        ids.push(mid);
        const to = [];
        for (const nid of infoOf(m).nested) {
          const of = nodes[nid] && nodes[nid].of;
          if (typeof of === 'string') to.push(of);
        }
        edges.set(mid, to);
      }
      scc = sccMap(ids, edges);
    }
    return scc.get(id);
  };

  /** запись раскрытия экземпляра на глубине d под мастером pm (цепочка его компоненты — prel) или null */
  const resolve = (inst, d, pm, prel) => {
    if (!inst || d > MAX_INSTANCE_DEPTH) return null;
    const m = masterFor(inst);
    if (!m) return null;
    let rel = NO_CHAIN;
    if (pm) {
      if (m.id === pm.id) return null;                 // самовключение: мастер уже в цепочке
      const a = sccOf(m.id);
      if (a !== undefined && a === sccOf(pm.id)) {
        if (prel.indexOf(m.id) >= 0) return null;      // цикл длиннее: мастер уже в цепочке
        rel = prel.concat(pm.id).sort();
      }
    }
    const mi = infoOf(m);
    let pkey = '';
    let patches = null;
    if (mi.struct) {
      const given = inst.props && typeof inst.props === 'object' ? inst.props : {};
      const parts = [];
      for (const name of Object.keys(given)) {
        if (!mi.struct.has(name)) continue;
        const p = mi.known.get(name);
        const v = propValue(p, given[name]);
        if (v === undefined) continue;
        parts.push(name, v);
        if (!patches) patches = new Map();
        let list = patches.get(p.target);
        if (!list) { list = []; patches.set(p.target, list); }
        list.push({ path: p.path, value: v });
      }
      if (parts.length) pkey = JSON.stringify(parts);
    }
    const key = d + '\u0001' + m.id + '\u0001' + rel.join('\u0002') + '\u0001' + pkey;
    const hit = memo.get(key);
    if (hit) return hit;
    if (++keys > MAX_EXPANDED_NODES) return COST_OVER;
    let cost = mi.size;
    const kids = [];
    for (const nid of mi.nested) {
      let n = ownNode(nodes, nid);
      if (!n) continue;
      const pl = patches && patches.get(nid);
      if (pl) for (const one of pl) n = setPath(n, one.path, one.value);
      if (!n || n.type !== 'instance') continue;
      const e = resolve(n, d + 1, m, rel);
      if (!e) continue;
      cost += e.cost - 1;
      kids.push(e);
    }
    const entry = { cost, kids, d, m: m.id };
    memo.set(key, entry);
    return entry;
  };

  const instCost = (inst) => {
    const e = resolve(inst, 1, null, NO_CHAIN);
    return e ? e.cost : 0;
  };
  const total = () => {
    if (totalCache !== null) return totalCache;
    let sum = 0;
    let best = -1;
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      if (!n || n.type !== 'instance') continue;
      const e = resolve(n, 1, null, NO_CHAIN);
      if (!e) continue;
      sum += e.cost;
      top.set(e, (top.get(e) || 0) + 1);
      if (e.cost > best) { best = e.cost; heavy = id; }
    }
    totalCache = sum;
    return sum;
  };
  /**
   * Сколько раз раскрывается каждый мастер по всему документу (столько узлов
   * даёт новый простой узел в нём). null — счёт оборван (ключей больше предела).
   * @returns {Map<string,number>|null}
   */
  const multMap = () => {
    if (!mult) {
      total();
      const count = new Map(top);
      const byDepth = [];
      for (const e of memo.values()) (byDepth[e.d] || (byDepth[e.d] = [])).push(e);
      for (const layer of byDepth) {
        if (!layer) continue;
        for (const e of layer) {
          const c = count.get(e) || 0;
          if (!c) continue;
          for (const k of e.kids) count.set(k, (count.get(k) || 0) + c);
        }
      }
      mult = new Map();
      for (const [e, c] of count) if (e.m) mult.set(e.m, (mult.get(e.m) || 0) + c);
    }
    return keys > MAX_EXPANDED_NODES ? null : mult;
  };
  /** Запись раскрытия экземпляра верхнего уровня (или null — не раскрывается). */
  const entry = (inst) => resolve(inst, 1, null, NO_CHAIN);
  return { instCost, entry, total, heaviest: () => { total(); return heavy; }, multMap };
}

/**
 * Круг 39: вклад одной записи раскрытия в числа раскрытий мастеров —
 * `mult[m] += sign · (сколько раз m раскрывается внутри e)`. Слоями по глубине:
 * дети записи всегда на уровень глубже. Стоимость — число различных записей под e.
 * @param {object|null} e @param {number} sign @param {(m:string, d:number)=>void} add
 */
function expandContrib(e, sign, add) {
  if (!e || !e.m) return;
  let level = new Map([[e, 1]]);
  for (let guard = 0; level.size && guard <= MAX_INSTANCE_DEPTH + 1; guard++) {
    const next = new Map();
    for (const [x, c] of level) {
      if (x.m) add(x.m, sign * c);
      for (const k of x.kids) next.set(k, (next.get(k) || 0) + c);
    }
    level = next;
  }
}

/**
 * Круг 39 (N2): сколько узлов даст раскрытие всех экземпляров документа (expandDoc
 * без предела) — линейно, по графу мастеров с мемоизацией, без самого раскрытия.
 * Для документа без циклов компонентов, обойдённых пропсом-подменой `of`, число
 * равно числу узлов expandDoc; иначе — оценка сверху. Infinity — счёт оборван
 * (ключей больше предела). Не бросает.
 * @param {object} doc
 * @returns {number}
 */
function expandCost(doc) {
  if (!doc || !doc.nodes) return 0;
  try {
    return expandAnalysis(doc).total();
  } catch (e) {
    logOnce('expandCost:throw', 'expandCost: счёт раскрытия не удался', e);
    return Infinity;
  }
}

const bigCount = (n) => (n === Infinity || n > 1e12 ? 'больше триллиона' : String(Math.round(n)));

/**
 * Круг 39 (N2): превышает ли документ предел раскрытия — для импорта, validate,
 * DSLV и сервера. Не бросает.
 * @param {object} doc
 * @returns {null|{code:'expand-limit', limit:'expand_nodes', cost:number, max:number, nodeId:string|null, message:string}}
 *   nodeId — самый дорогой экземпляр
 */
function expandProblem(doc) {
  if (!doc || !doc.nodes) return null;
  let cost;
  let nodeId = null;
  try {
    const ana = expandAnalysis(doc);
    cost = ana.total();
    if (cost <= MAX_EXPANDED_NODES) return null;
    nodeId = ana.heaviest();
  } catch (e) {
    logOnce('expandProblem:throw', 'expandProblem: счёт раскрытия не удался', e);
    cost = Infinity;
  }
  return {
    code: 'expand-limit', limit: EXPAND_LIMIT, cost, max: MAX_EXPANDED_NODES, nodeId,
    message: `слишком много вложенных экземпляров: раскрытие дало бы ${bigCount(cost)} узлов — больше предела ${MAX_EXPANDED_NODES}`
  };
}

/**
 * Состояния мастера с состояниями экземпляра поверх: по каждому состоянию —
 * поля экземпляра заменяют одноимённые поля мастера (круг 36, SPEC §11).
 * @returns {object}
 */
function mergeStates(base, over) {
  const out = {};
  const a = isObj(base) ? base : {};
  const b = isObj(over) ? over : {};
  for (const s of STATE_NAMES) {
    if (!isObj(a[s]) && !isObj(b[s])) continue;
    out[s] = { ...(isObj(a[s]) ? a[s] : {}), ...(isObj(b[s]) ? b[s] : {}) };
  }
  return out;
}

/** Подпись заглушки экземпляра, не раскрытого из-за предела (видна на холсте). */
const EXPAND_STUB_TEXT = 'слишком много вложенных экземпляров';
/**
 * Заглушки по экземпляру: тот же объект, пока узел экземпляра — тот же
 * (ссылки нужны точечной отрисовке, см. expandCache).
 * @type {WeakMap<object,Record<string,object>>}
 */
const stubCache = new WeakMap();

/**
 * Круг 39 (N2): заглушка вместо экземпляра, не раскрытого из-за предела —
 * рамка на месте экземпляра (его размер, место, видимость) с подписью
 * «слишком много вложенных экземпляров». Два синтетических узла: решатель и
 * сцена их размещают и рисуют как обычные, выделение уходит в экземпляр.
 * @returns {Record<string,object>}
 */
function expandStub(doc, inst) {
  const hit = stubCache.get(inst);
  if (hit) return hit;
  const master = ownNode(doc.nodes, inst.of);
  const tid = inst.id + '/~expand-limit';
  const frame = {
    type: 'frame', id: inst.id, parent: inst.parent, synthetic: true, instance: inst.id, stub: 'expand-limit',
    name: inst.name !== undefined ? inst.name : 'Экземпляр не раскрыт',
    size: instanceSize(inst, master && master.type !== 'instance' ? master : null),
    layout: { mode: 'column', padding: 8, align: 'center', justify: 'center' },
    fill: '#F4F1EA', stroke: { color: '#B4AC9C', width: 1 }, clip: true,
    children: [tid]
  };
  for (const k of ['pos', 'override', 'visible', 'opacity', 'rotate', 'locked']) {
    if (inst[k] !== undefined) frame[k] = deepClone(inst[k]);
  }
  const text = {
    type: 'text', id: tid, parent: inst.id, synthetic: true, instance: inst.id, stub: 'expand-limit',
    characters: EXPAND_STUB_TEXT, color: '#6B6457', size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, align: 'center'
  };
  const out = { [frame.id]: frame, [tid]: text };
  stubCache.set(inst, out);
  return out;
}

/**
 * Раскрытие всех экземпляров документа. Чистая функция от документа — на этом
 * стоит детерминированность решателя (SPEC §5.6).
 *
 * Круг 39 (N2): никогда не больше MAX_EXPANDED_NODES раскрытых узлов. Стоимость
 * каждого экземпляра известна заранее (кеш или expandAnalysis); документ сверх
 * предела (правкой и импортом такой уже не получить — только старым журналом)
 * раскрывается деградированно: только экземпляры не дороже
 * DEGRADED_INSTANCE_NODES, по порядку документа, пока сумма в пределе; прочие —
 * заглушки «слишком много вложенных экземпляров» (`skipped`), validate говорит
 * `expand-limit`. Счётчик в expandOne — страховка на случай ошибки в оценке.
 * Заглушки (по два узла) в предел не входят: их не больше, чем экземпляров в
 * самом документе.
 * @param {object} doc
 * @returns {{nodes:Record<string,object>, count:number, skipped?:string[]}} count — сколько
 *   экземпляров в документе; skipped — не раскрытые из-за предела (только если есть)
 */
function expandDoc(doc) {
  const out = {};
  let count = 0;
  if (!doc || !doc.nodes) return { nodes: out, count };
  const list = [];
  let ana = null;
  let total = 0;
  for (const id of Object.keys(doc.nodes)) {
    const inst = doc.nodes[id];
    if (!inst || inst.type !== 'instance') continue;
    count += 1;
    const hit = expandCache.get(inst);
    const fresh = hit && depsFresh(doc, hit.deps) ? hit : null;
    let need;
    if (fresh) need = fresh.size;
    else {
      try {
        if (!ana) ana = expandAnalysis(doc);
        need = ana.instCost(inst);
      } catch (e) {
        logOnce('expand:cost:' + id, `стоимость раскрытия «${id}» не посчитать`, e);
        need = Infinity;
      }
    }
    total += need;
    list.push(inst, fresh, need);
  }
  const degraded = total > MAX_EXPANDED_NODES;
  let used = 0;
  const skipped = [];
  const skip = (inst) => {
    skipped.push(inst.id);
    Object.assign(out, expandStub(doc, inst));
  };
  for (let k = 0; k < list.length; k += 3) {
    const inst = list[k];
    const hit = list[k + 1];
    const need = list[k + 2];
    if (degraded && (need > DEGRADED_INSTANCE_NODES || used + need > MAX_EXPANDED_NODES)) { skip(inst); continue; }
    if (hit) {
      if (used + hit.size > MAX_EXPANDED_NODES) { skip(inst); continue; }
      Object.assign(out, hit.nodes);
      used += hit.size;
      continue;
    }
    const local = {};
    const deps = [];
    const budget = { left: MAX_EXPANDED_NODES - used };
    try {
      expandOne(doc, inst, inst.id, inst.id, 1, [], local, deps, budget);
      const size = MAX_EXPANDED_NODES - used - budget.left;
      expandCache.set(inst, { deps, nodes: local, size });
      const top = local[inst.id];
      if (top && top.synthetic) expandShape.set(top, shapeSig(deps, inst));
    } catch (e) {
      if (e === EXPAND_OVER) {
        logOnce('expand:over:' + inst.id, `раскрытие «${inst.id}» упёрлось в предел ${MAX_EXPANDED_NODES} узлов — экземпляр не раскрыт`);
        skip(inst);
        continue;
      }
      logOnce('expand:throw:' + inst.id, `раскрытие экземпляра «${inst.id}» не удалось`, e);
    }
    Object.assign(out, local);
    used = MAX_EXPANDED_NODES - budget.left;
  }
  if (skipped.length) {
    logOnce('expand:limit', `раскрытие экземпляров дало бы ${bigCount(total)} узлов — больше предела ${MAX_EXPANDED_NODES}: `
      + `${skipped.length} экземпляров не раскрыты`);
    return { nodes: out, count, skipped };
  }
  return { nodes: out, count };
}

/**
 * Раскрытие одного экземпляра — для оболочки и мозга (превью компонента,
 * разбор «что внутри этого экземпляра»). Круг 39: дороже MAX_EXPANDED_NODES —
 * не раскрывается (`root: null`, `limit: 'expand_nodes'`).
 * @returns {{nodes:Record<string,object>, root:object|null, limit?:string}|null}
 */
function expandInstance(doc, idOrNode) {
  const inst = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  if (!inst || inst.type !== 'instance') return null;
  const nodes = {};
  try {
    if (expandAnalysis(doc).instCost(inst) > MAX_EXPANDED_NODES) throw EXPAND_OVER;
    expandOne(doc, inst, inst.id, inst.id, 1, [], nodes, [], { left: MAX_EXPANDED_NODES });
  } catch (e) {
    if (e !== EXPAND_OVER) throw e;
    logOnce('expandInstance:over:' + inst.id, `раскрытие «${inst.id}» больше предела ${MAX_EXPANDED_NODES} узлов — не раскрыт`);
    return { nodes: {}, root: null, limit: EXPAND_LIMIT };
  }
  return { nodes, root: nodes[inst.id] || null };
}

/* ------------------------- миграция и правки ------------------------- */

/**
 * Где на бесконечном холсте встанет библиотека: ПОД досками, а не правее их.
 * Правее — там, куда оболочка кладёт следующую новую доску (она считает место от
 * последней доски по горизонтали), и библиотека оказалась бы ровно под ней.
 * Снизу пусто всегда.
 */
function libraryPlace(doc) {
  const root = nodeById(doc, doc && doc.root);
  let bottom = 0;
  let left = 0;
  let first = true;
  for (const id of kidsOf(root)) {
    const n = nodeById(doc, id);
    if (!n) continue;
    const pos = nodePos(n);
    const h = n.size && n.size.h && n.size.h.mode === 'fixed' ? numIn(n.size.h.value, 0, MAX_SIZE, 0) : 400;
    bottom = Math.max(bottom, pos.y + h);
    left = first ? pos.x : Math.min(left, pos.x);
    first = false;
  }
  return { x: r2(first ? 0 : left), y: r2(first ? 0 : bottom + 120) };
}

/** Заготовка узла библиотеки. @returns {object} */
function libraryTemplate(doc) {
  return {
    type: 'page', id: uid('lib'), name: 'Библиотека', role: LIBRARY_ROLE,
    parent: doc.root, children: [], pos: libraryPlace(doc),
    // колонкой, а не по pos: мастера не должны наезжать друг на друга;
    // круг 20: зазор — ссылкой на шаг шкалы, как всё в документе
    layout: layoutToRefs(doc, { mode: 'column', gap: 24, align: 'start' })
  };
}

/**
 * Операции, добавляющие документу библиотеку. Пустой массив, если она уже есть.
 * Нужны, когда библиотеку заводят внутри отменяемой транзакции (создание
 * первого компонента) — см. makeComponentOps.
 * @returns {object[]}
 */
function ensureLibraryOps(doc) {
  if (!doc || !doc.nodes || !doc.root || !doc.nodes[doc.root]) return [];
  if (libraryNode(doc)) return [];
  return [ops.create(libraryTemplate(doc))];
}

/**
 * МИГРАЦИЯ (круг 19, п.1). Документы, сохранённые до компонентов, библиотеки не
 * имеют: их приводит к нынешнему виду ровно этот вызов — один, идемпотентный,
 * без мутации входа. Возвращает ТОТ ЖЕ документ, если библиотека уже есть.
 * Оболочке довольно позвать его после загрузки из `db` и после импорта JSON.
 * (createDoc его НЕ зовёт сам намеренно: импорт сверяет узлы разобранного
 * документа с узлами файла и посчитал бы новую библиотеку чужим узлом.)
 * @param {object} doc
 * @returns {object} Doc с библиотекой
 */
function ensureLibrary(doc) {
  const list = ensureLibraryOps(doc);
  if (!list.length) return doc;
  const res = applyOps(doc, list);
  if (res.error) {
    logOnce('ensureLibrary:' + res.error.code, `ensureLibrary: библиотеку не добавить — ${res.error.message}`);
    return doc;
  }
  return res.doc;
}

/**
 * Можно ли сделать компонентом этот узел. Ответ словами — оболочке для кнопки
 * и подсказки, мозгу — чтобы не сочинять невозможную правку.
 * @returns {{ok:boolean, reason?:string}}
 */
function canMakeComponent(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  if (!n) return { ok: false, reason: 'узел не найден' };
  if (n.id === doc.root) return { ok: false, reason: 'корень документа компонентом не станет' };
  if (n.type === 'page') return { ok: false, reason: 'страница компонентом не станет' };
  if (n.type === 'instance') return { ok: false, reason: 'это уже экземпляр компонента' };
  if (isMaster(doc, n)) return { ok: false, reason: 'это уже компонент' };
  if (isArtboard(doc, n)) return { ok: false, reason: 'доска компонентом не станет' };
  if (isLibrary(doc, n.parent)) return { ok: false, reason: 'узел уже лежит в библиотеке' };
  if (ancestors(doc, n.id).some((a) => isLibrary(doc, a) || isMaster(doc, a))) {
    return { ok: false, reason: 'узел внутри другого компонента' };
  }
  return { ok: true };
}

/**
 * Операции: сделать узел компонентом. Узел переезжает в библиотеку (библиотека
 * создаётся, если её нет), получает поле `component`, а на его прежнее место
 * встаёт экземпляр. Документ не меняется — оболочка применяет это транзакцией.
 * @param {object} doc
 * @param {string} id
 * @param {{name?:string, props?:Array}} [opt] props — по схеме SPEC §5.4
 * @returns {object[]} пустой массив, если так нельзя (см. canMakeComponent)
 */
function makeComponentOps(doc, id, opt = {}) {
  const node = nodeById(doc, id);
  if (!canMakeComponent(doc, node).ok) return [];
  const parentId = node.parent;
  const parent = nodeById(doc, parentId);
  const index = parent && Array.isArray(parent.children) ? parent.children.indexOf(id) : -1;
  const list = ensureLibraryOps(doc);
  // библиотеки может ещё не быть — её id знаем из операции создания
  const libId = libraryNode(doc) ? libraryId(doc) : list[0].node.id;
  const name = typeof opt.name === 'string' && opt.name.trim() ? opt.name.trim() : displayName(doc, node);
  list.push(ops.move(id, libId, 0));
  list.push(ops.set(id, 'component', { name, props: Array.isArray(opt.props) ? deepClone(opt.props) : [] }));
  // мастер внутри библиотеки живёт в потоке: pos и override там не про что
  if (node.pos !== undefined) list.push(ops.set(id, 'pos', undefined));
  if (node.override !== undefined) list.push(ops.set(id, 'override', undefined));
  const inst = {
    type: 'instance', id: uid('i'), name: node.name, parent: parentId, of: id, props: {},
    ...(node.pos !== undefined ? { pos: deepClone(node.pos) } : {}),
    ...(node.override !== undefined ? { override: deepClone(node.override) } : {})
  };
  list.push(ops.create(inst, index < 0 ? undefined : index));
  return list;
}

/**
 * Операции: поставить экземпляр компонента.
 * @param {object} doc
 * @param {{of:string, parent:string, index?:number, props?:object, pos?:object, name?:string, size?:object}} spec
 * @returns {object[]} пустой массив, если компонент или родитель не годятся
 */
function instanceOps(doc, spec) {
  if (!spec || typeof spec !== 'object') return [];
  const master = nodeById(doc, spec.of);
  if (!isMaster(doc, master)) return [];
  const parent = nodeById(doc, spec.parent);
  if (!parent || !CONTAINER_TYPES.has(parent.type)) return [];
  const node = {
    type: 'instance', id: uid('i'), parent: parent.id, of: master.id,
    props: spec.props && typeof spec.props === 'object' ? deepClone(spec.props) : {},
    ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
    ...(spec.pos ? { pos: deepClone(spec.pos) } : {}),
    ...(spec.size ? { size: deepClone(spec.size) } : {})
  };
  return [ops.create(node, isNum(spec.index) ? spec.index : undefined)];
}

/**
 * Операции: ОТСОЕДИНИТЬ экземпляр (SPEC §5.7) — настоящая копия поддерева
 * мастера на его месте, одной отменяемой транзакцией `remove` + `create`.
 * Документ не мутируется: оболочка вешает на этот список кнопку, мозг — правку.
 * @param {object} doc
 * @param {string} id
 * @returns {object[]} пустой массив, если это не экземпляр или мастер мёртв
 */
function detachInstanceOps(doc, id) {
  const inst = nodeById(doc, id);
  if (!inst || inst.type !== 'instance') return [];
  const ex = expandInstance(doc, inst);
  if (!ex || !ex.root) return [];
  const parent = nodeById(doc, inst.parent);
  if (!parent || !Array.isArray(parent.children)) return [];
  const index = parent.children.indexOf(id);
  // новые id: копия настоящая, а не вторая ссылка на мастера
  const fresh = new Map();
  const order = [];
  const walk = (sid, depth) => {
    const n = ex.nodes[sid];
    if (!n || depth > MAX_DEPTH || fresh.has(sid)) return;
    fresh.set(sid, uid(n.type === 'frame' ? 'f' : 'n'));
    order.push(sid);
    for (const c of kidsOf(n)) walk(c, depth + 1);
  };
  walk(inst.id, 0);
  const list = [ops.remove(id)];
  for (let i = 0; i < order.length; i++) {
    const sid = order[i];
    const src = ex.nodes[sid];
    const node = deepClone(src);
    delete node.synthetic;
    delete node.instance;
    delete node.master;
    node.id = fresh.get(sid);
    node.parent = i === 0 ? inst.parent : fresh.get(src.parent) || inst.parent;
    // дети создаются своими операциями и встают в родителя сами
    if (Array.isArray(node.children)) node.children = [];
    list.push(i === 0 ? ops.create(node, index < 0 ? undefined : index) : ops.create(node));
  }
  return list;
}

/* ------------------------------------------------------------------ *
 * 3. Документ и утилиты обхода
 * ------------------------------------------------------------------ */

/**
 * Дети узла всегда массивом. Документ мог прийти мимо checkNode (импорт, чужой
 * JSON, черновик от агента), и тогда children бывает объектом или строкой —
 * `for (const id of node.children)` на таком бросает «object is not iterable»,
 * и человек видит сырой текст исключения вместо макета.
 * @param {any} node
 * @returns {string[]}
 */
const kidsOf = (node) => (node && Array.isArray(node.children) ? node.children : []);

/** @param {object} doc @param {string} id @returns {object|undefined} */
function nodeById(doc, id) {
  return doc && doc.nodes ? ownNode(doc.nodes, id) : undefined;
}

/**
 * Цепочка предков от ближайшего к корню.
 * @param {object} doc @param {string} id @returns {object[]}
 */
function ancestors(doc, id) {
  const out = [];
  let cur = nodeById(doc, id);
  let guard = 0;
  while (cur && cur.parent && guard++ < 512) {
    const p = nodeById(doc, cur.parent);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

/** Артборд — фрейм, чей parent === doc.root. @returns {boolean} */
function isArtboard(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  return !!(n && n.type === 'frame' && n.parent === doc.root);
}

/**
 * Имя-заглушка для узла без имени. Одно на всех: холст подписывал безымянный
 * артборд «Артборд», а оболочка в имени файла делала из того же узла «Группу» —
 * человек видел два разных имени одного и того же. Артборд отличается от фрейма
 * внутри макета, поэтому нужен документ.
 * @param {object} doc @param {object|string} idOrNode
 * @returns {string}
 */
function placeholderName(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  if (!n) return 'Узел';
  // Круг 18: человек называет их досками, и весь интерфейс перешёл на это слово. Имя-заглушку
  // рисует и холст, и рельс — расходиться им нельзя, поэтому слово меняется здесь, в одном месте.
  if (doc && isArtboard(doc, n)) return 'Доска';
  if (doc && isLibrary(doc, n)) return 'Библиотека';
  // круг 19: безымянный экземпляр зовут его компонентом — в рельсе слоёв «Узел»
  // ничего не говорил, а имя компонента и есть то, чем человек его называет
  if (n.type === 'instance') {
    const master = doc ? masterOf(doc, n) : null;
    return master ? componentName(master) : 'Экземпляр';
  }
  return (typeof n.type === 'string' && ownNode(PLACEHOLDER_NAMES, n.type)) || 'Узел';
}
const PLACEHOLDER_NAMES = {
  frame: 'Группа', text: 'Текст', rect: 'Прямоугольник', ellipse: 'Эллипс', image: 'Картинка',
  instance: 'Экземпляр', vector: 'Вектор'
};

/**
 * Имя узла для показа человеку: своё, а если его нет — заглушка. Этим подписан
 * артборд на холсте, этим же стоит подписывать узел в рельсе слоёв, в имени
 * файла и в подписи правки.
 * @param {object} doc @param {object|string} idOrNode
 * @returns {string}
 */
function displayName(doc, idOrNode) {
  const n = typeof idOrNode === 'string' ? nodeById(doc, idOrNode) : idOrNode;
  // круг 29: имя из документа прежней версии может быть чем угодно — без приведения
  const raw = n ? n.name : undefined;
  const own = typeof raw === 'string' ? raw.trim() : isNum(raw) ? String(raw) : '';
  return own || placeholderName(doc, n);
}

/** Список артбордов в порядке детей корня. @returns {object[]} */
function artboards(doc) {
  const root = nodeById(doc, doc.root);
  if (!root) return [];
  return kidsOf(root).map((id) => nodeById(doc, id)).filter((n) => n && n.type === 'frame');
}

/**
 * Все id поддерева, родитель раньше детей (прямой порядок обхода). Цикл обходится
 * стороной. Круг 27: без предела глубины и без рекурсии — поддерево глубже
 * MAX_DEPTH (документ прежней версии) раньше обрывалось, и надгробия remove
 * теряли низ цепочки, а applyOps удалял его целиком.
 * @returns {string[]}
 */
function subtreeIds(doc, id) {
  const out = [];
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const nid = stack.pop();
    const n = nodeById(doc, nid);
    if (!n) continue;
    if (seen.has(nid)) { logOnce('subtree:cycle:' + nid, `subtreeIds: узел «${nid}» встречен дважды — ребро пропущено`); continue; }
    seen.add(nid);
    out.push(nid);
    const kids = kidsOf(n);
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

/**
 * Копия поддерева с новыми идентификаторами.
 * @param {object} doc @param {string} id
 * @returns {{rootId:string, nodes:object[]}} узлы в порядке «родитель раньше детей»
 */
function cloneSubtree(doc, id) {
  const src = nodeById(doc, id);
  if (!src) return { rootId: null, nodes: [] };
  const ids = subtreeIds(doc, id);
  const map = new Map(ids.map((old) => [old, uid(src.type === 'frame' ? 'f' : 'n')]));
  const nodes = ids.map((old) => {
    const n = deepClone(nodeById(doc, old));
    n.id = map.get(old);
    if (old !== id && n.parent) n.parent = map.get(n.parent) || n.parent;
    if (n.children) n.children = n.children.map((c) => map.get(c) || c);
    return n;
  });
  return { rootId: map.get(id), nodes };
}

/** Шаг сдвига копии по умолчанию (px): там, где место задаёт pos, копия не ложится на оригинал. */
const DUPLICATE_OFFSET = 16;

/**
 * Круг 39 (N3): ДУБЛИРОВАТЬ — единственная реализация (таблица команд оболочки,
 * ⌘/Ctrl+D на холсте, Stage._duplicate). Копия каждого корня выделения встаёт
 * сразу после оригинала у того же родителя:
 *   • выделение «родитель + его ребёнок» копирует только родителя (ребёнок едет
 *     в его копии); страницы, корень холста и библиотека не копируются;
 *   • внутренние ссылки переписаны по карте старый id → новый: `parent`,
 *     `children`, `of` (если мастер внутри копии) и `component.props[].target`
 *     (раньше копия мастера отказывала: «target … вне мастера»); пропс, чья цель
 *     и в оригинале вне мастера, в копию не переносится;
 *   • копия мастера — новый компонент с новым именем «… копия» (свободным: «…
 *     копия 2» и т.д.); `component` ставится отдельным set ПОСЛЕ детей — цели
 *     пропсов должны уже лежать в мастере;
 *   • там, где место задаёт pos (на холсте, в свободной рамке layout.mode 'none'),
 *     копия сдвинута на `offset` (по умолчанию 16) по обеим осям; в потоке —
 *     просто следующий сосед (а отвязанная от потока override — тоже со сдвигом).
 * Документ не меняет; операции ложатся одной транзакцией applyOps.
 * @param {object} doc
 * @param {string[]|string} ids выделение
 * @param {{offset?:number}} [opts]
 * @returns {{ops:object[], ids:string[], roots:string[], error?:string}} ids — корни
 *   копий (их выделить), roots — что скопировано; error — словами, без id
 */
function duplicateOps(doc, ids, opts) {
  const res = { ops: [], ids: [], roots: [] };
  if (!doc || !doc.nodes) return { ...res, error: 'Документа нет' };
  const off = opts && isNum(opts.offset) ? clamp(opts.offset, -1000, 1000) : DUPLICATE_OFFSET;
  const raw = Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [];
  const lib = libraryNode(doc);
  const picked = [];
  const seen = new Set();
  for (const id of raw) {
    if (!isNodeId(id) || seen.has(id)) continue;
    seen.add(id);
    const n = ownNode(doc.nodes, id);
    if (!n || n.type === 'page' || id === doc.root || (lib && id === lib.id)) continue;
    if (!ownNode(doc.nodes, n.parent)) continue;
    picked.push(id);
  }
  const set = new Set(picked);
  const roots = picked.filter((id) => !ancestors(doc, id).some((a) => set.has(a.id)));
  if (!roots.length) {
    return { ...res, error: raw.length ? 'Копировать нечего: страницу и библиотеку не дублируют' : 'Копировать нечего: ничего не выделено' };
  }
  // имена компонентов — чтобы копия мастера получила свободное
  const names = new Set();
  if (lib) for (const mid of kidsOf(lib)) { const m = ownNode(doc.nodes, mid); if (m && m.component) names.add(componentName(m)); }
  const freeName = (base) => {
    let name = `${base} копия`;
    for (let k = 2; names.has(name); k++) name = `${base} копия ${k}`;
    names.add(name);
    return name;
  };
  // порядок детей по родителям — с учётом уже вставленных копий: две копии у
  // одного родителя встают каждая после СВОЕГО оригинала
  const orders = new Map();
  const orderOf = (pid) => {
    let o = orders.get(pid);
    if (!o) { o = kidsOf(ownNode(doc.nodes, pid)).slice(); orders.set(pid, o); }
    return o;
  };
  for (const id of roots) {
    const node = doc.nodes[id];
    const parent = doc.nodes[node.parent];
    const sub = subtreeIds(doc, id);
    const map = new Map(sub.map((old) => [old, uid(ownNode(doc.nodes, old).type === 'frame' ? 'f' : 'n')]));
    const inside = (v) => typeof v === 'string' && map.has(v);
    let component = null;
    const list = [];
    for (const old of sub) {
      const n = deepClone(doc.nodes[old]);
      n.id = map.get(old);
      if (old !== id) n.parent = map.get(n.parent) || n.parent;
      if (Array.isArray(n.children)) n.children = [];
      if (n.type === 'instance' && inside(n.of)) n.of = map.get(n.of);
      if (isObj(n.component)) {
        const c = n.component;
        const props = (Array.isArray(c.props) ? c.props : [])
          .filter((p) => isObj(p) && inside(p.target))
          .map((p) => ({ ...p, target: map.get(p.target) }));
        const next = { ...c, ...(Array.isArray(c.props) ? { props } : {}) };
        if (old === id && lib && parent.id === lib.id) next.name = freeName(componentName(doc.nodes[old]));
        delete n.component;
        // компонент — после детей: цели пропсов должны уже лежать в поддереве
        if (old === id) component = next;
        else list.push(null, n.id, next);
      }
      if (old === id) {
        n.name = `${typeof node.name === 'string' && node.name.trim() ? node.name : displayName(doc, node)} копия`;
        const L = resolveLayout(doc, parent.layout);
        if (parent.id === doc.root || L.mode === 'none') {
          const pos = isObj(n.pos) ? n.pos : { x: 0, y: 0 };
          n.pos = { x: r2((isNum(pos.x) ? pos.x : 0) + off), y: r2((isNum(pos.y) ? pos.y : 0) + off) };
        } else if (isObj(n.override) && isNum(n.override.x) && isNum(n.override.y)) {
          n.override = { ...n.override, x: r2(n.override.x + off), y: r2(n.override.y + off) };
        }
        const order = orderOf(parent.id);
        const at = order.indexOf(id) + 1;
        order.splice(at, 0, n.id);
        res.ops.push(ops.create(n, at));
      } else {
        res.ops.push(ops.create(n));
      }
    }
    // компоненты вложенных узлов (в норме их нет: мастер — только ребёнок библиотеки)
    for (let k = 0; k < list.length; k += 3) res.ops.push(ops.set(list[k + 1], 'component', list[k + 2]));
    if (component) res.ops.push(ops.set(map.get(id), 'component', component));
    res.ids.push(map.get(id));
    res.roots.push(id);
  }
  return res;
}

const ROLE_PATTERNS = [
  ['button', /кнопк|button|cta|действие/i],
  ['title', /заголов|title|heading|назван/i],
  ['header', /шапк|header|хедер|верхн/i],
  ['card', /карточк|card|плитк/i],
  ['list', /список|list|перечен/i],
  ['item', /пункт|item|строка|row|элемент/i],
  ['table', /таблиц|table|сводк/i],
  ['metric', /показател|метрик|metric|kpi|цифр/i],
  ['caption', /подпис|caption|описан|мелк/i],
  ['artboard', /артборд|доск|экран|макет|artboard|board|screen|frame/i]
];

/** Единственный кандидат или null, если их несколько и они равновесны. */
function onlyOne(list) {
  return list.length === 1 ? list[0] : null;
}

/**
 * Поиск узла по id, имени или роли (для точечных правок из brain.js).
 * Порядок: id → точное имя → частичное имя (самое близкое) → роль → текст.
 * Шаг, не давший ровно одного кандидата, поиск НЕ обрывает: пробуем следующий,
 * и только исчерпав все шаги, возвращаем null — чтобы вызывающий предупредил
 * пользователя, а не правил чужой узел.
 * @param {object} doc @param {string} ref
 * @returns {object|null}
 */
function resolveTarget(doc, ref) {
  if (!doc || !doc.nodes || typeof ref !== 'string') return null;
  const key = ref.trim();
  if (!key) return null;
  if (ownNode(doc.nodes, key)) return doc.nodes[key];
  /* Круг 19: поиск по ИМЕНИ, РОЛИ и ТЕКСТУ не заходит в библиотеку. Мастер
     компонента «Кнопка» иначе перебивал кнопку на доске («кнопка» → мастер), и
     точечная правка от агента молча меняла бы ВСЕ экземпляры там, где человек
     говорил про один узел на экране. Компоненты адресуются отдельным каналом —
     словарём components(doc) и полем `of` экземпляра (SPEC §5.9); по точному id
     мастер по-прежнему находится (проверка выше). */
  const libId = libraryId(doc);
  const hidden = libId ? new Set(subtreeIds(doc, libId)) : null;
  const all = Object.values(doc.nodes).filter((n) => n && typeof n === 'object' && !(hidden && hidden.has(n.id)));
  const low = key.toLowerCase();
  // роль учитываем только тогда, когда запрос указывает ровно на одну роль
  const roles = ROLE_PATTERNS.filter(([role, re]) => role === low || re.test(key));
  const role = roles.length === 1 ? roles[0] : null;

  // Шаги по убыванию точности. Пустой или неоднозначный шаг — не повод
  // возвращать null: неоднозначность роли не должна коротить поиск по тексту.
  const steps = [
    // 1. точное имя
    () => all.filter((n) => strOf(n.name).trim().toLowerCase() === low),
    // 2. частичное имя: ближе тот, чьё имя короче (и тем более начинается с запроса)
    () => {
      const partial = all.filter((n) => strOf(n.name).toLowerCase().includes(low));
      if (!partial.length) return partial;
      const score = (n) => {
        const name = strOf(n.name).toLowerCase();
        return (name.startsWith(low) ? 0 : 1000) + name.length;
      };
      const best = minOf(partial, score, Infinity);
      return partial.filter((n) => score(n) === best);
    },
    // 3. роль: сначала по полю role, затем по имени в духе роли
    () => (role ? all.filter((n) => n.role === role[0]) : []),
    () => (role ? all.filter((n) => role[1].test(strOf(n.name))) : []),
    // 4. содержимое текста: точное совпадение важнее вхождения
    () => all.filter((n) => n.type === 'text' && strOf(n.characters).trim().toLowerCase() === low),
    () => all.filter((n) => n.type === 'text' && strOf(n.characters).toLowerCase().includes(low))
  ];
  for (const step of steps) {
    const hit = onlyOne(step());
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 4. Операции
 * ------------------------------------------------------------------ */

/**
 * Конструкторы операций (SPEC §1.3).
 * create{node,index?} · remove{id} · set{id,path,value?} · move{id,parent,index} · setToken{path,value?}
 */
const ops = Object.freeze({
  /** @param {object} node @param {number} [index] */
  create: (node, index) => {
    const n = node && typeof node === 'object' ? deepClone(node) : node;
    // id выдаём здесь, а не при применении: иначе инверсию нечем адресовать
    if (n && typeof n === 'object' && !n.id) n.id = uid(n.type === 'frame' ? 'f' : 'n');
    return { op: 'create', node: n, ...(isNum(index) ? { index } : {}) };
  },
  /** @param {string} id */
  remove: (id) => ({ op: 'remove', id }),
  /** @param {string} id @param {string} path @param {any} [value] */
  set: (id, path, value) => ({ op: 'set', id, path, value: deepClone(value) }),
  /** @param {string} id @param {string} parent @param {number} index */
  move: (id, parent, index) => ({ op: 'move', id, parent, index }),
  /** @param {string} path @param {any} [value] */
  setToken: (path, value) => ({ op: 'setToken', path, value: deepClone(value) })
});

/** Коды ошибок операций — публичный контракт applyOps, оболочка разбирает их по code. */
const OP_ERRORS = new Set(['not-found', 'protected-path', 'bad-node', 'bad-parent', 'cycle', 'bad-op']);
/**
 * @param {string} code @param {string} message
 * @param {{limit?:string}} [extra] круг 27: `limit` — какой предел нарушен (`'depth'`); rebase
 *   кладёт его в `dropped[].limit`, как `merge_budget`
 * @returns {{code:string, message:string, limit?:string}}
 */
function opErr(code, message, extra) {
  if (!OP_ERRORS.has(code)) logOnce('opErr:' + code, `код ошибки «${code}» вне контракта`);
  return extra && extra.limit ? { code, message, limit: extra.limit } : { code, message };
}

/* Круг 25: черновик пачки. Словарь узлов копируется ОДИН раз на пачку (openDraft),
   операции пишут в него через putNode/delNode. Раньше rebase, collectTombstones и
   invertOps звали applyOps(cur, [op]) на каждую операцию, а он каждый раз копировал
   `{...doc.nodes}` — O(операций × узлов): 4900 set на документе в 19 500 узлов
   сливались 90 с под мьютексом проекта. Журнал `j` (необязательный) — записи для
   отката ОДНОЙ операции, не принятой applyOne: слиянию нужно «операция не легла —
   черновик как до неё», не копируя словарь.

   Круг 27: то же для СПИСКА ДЕТЕЙ и токенов. Раньше каждая операция над ребёнком
   плоского родителя копировала его children (`filter`/`slice`) и искала место
   indexOf — O(детей) на операцию: на рамке с 19 000 детей 5000 remove сливались
   5 с и упирались в бюджет слияния, 5000 setToken копировали растущую палитру
   (квадрат). Теперь:
   • children копируется один раз на черновик (ownKids — копия-при-записи), дальше
     правится на месте (вставка/вырезание через arrInsert/arrRemoveAt — только они);
   • место ребёнка — по ленивому индексу позиций (posOf): словарь id → позиция,
     строится при первом поиске в длинном списке, а сдвиги после вставок и
     вырезаний догоняются по журналу сдвигов, без indexOf по всему списку;
   • токены: контейнеры по пути setToken копируются один раз на черновик.
   Объекты, созданные ЭТИМ черновиком, помнит DRAFT_STATE (по самому черновику, а
   не полем в нём: черновик applyOps — это и есть выходной документ, и поле
   уехало бы в следующий `{...doc}` и разрешило бы править чужие массивы на месте).
   Документ на входе не меняется никогда: на месте правится только то, что
   черновик сам и скопировал. */
const ABSENT = Symbol('absent');
/** Виды записей журнала (по 4 ячейки: вид, цель, ключ, прежнее). */
const J_NODE = 0;     // draft.nodes[ключ] был «прежним» (ABSENT — ключа не было)
const J_TOKENS = 1;   // draft.tokens был «прежним»
const J_INS = 2;      // в массив-цель вставлен элемент на место «ключ»
const J_DEL = 3;      // из массива-цели вырезан «прежний» с места «ключ»
const J_PROP = 4;     // цель[ключ] был «прежним» (контейнер токенов)

/** Черновик → {own: что он скопировал сам, pos: индексы позиций списков}. */
const DRAFT_STATE = new WeakMap();
/** Список короче — indexOf дешевле индекса позиций. */
const POS_MIN = 48;
/** Журнал сдвигов индекса длиннее (пар) — индекс строится заново (баланс догона сдвигов и перестройки). */
const POS_LOG_MAX = 4096;
/** Запись индекса позиций — одно число: позиция + отметка журнала × POS_SPAN (без объекта на ребёнка). */
const POS_SPAN = 2097152;   // 2^21 детей у одного родителя — с запасом выше любых пределов документа

/** Изменяемая копия документа для пачки операций (узлы-объекты общие: applyOne их не мутирует). */
function openDraft(doc) {
  const draft = { ...doc, nodes: { ...doc.nodes }, tokens: doc.tokens };
  DRAFT_STATE.set(draft, { own: new WeakSet(), pos: new WeakMap() });
  return draft;
}

/** Черновик уходит наружу документом — больше ничего в нём на месте не правим. */
function sealDraft(draft) {
  DRAFT_STATE.delete(draft);
  return draft;
}

function putNode(draft, id, node, j) {
  if (j) j.push(J_NODE, null, id, hasOwnProp.call(draft.nodes, id) ? draft.nodes[id] : ABSENT);
  draft.nodes[id] = node;
}

function delNode(draft, id, j) {
  if (!hasOwnProp.call(draft.nodes, id)) return;
  if (j) j.push(J_NODE, null, id, draft.nodes[id]);
  delete draft.nodes[id];
}

/** Запись свойства контейнера токенов с отметкой в журнале. */
function putProp(target, key, value, j) {
  if (j) j.push(J_PROP, target, key, hasOwnProp.call(target, key) ? target[key] : ABSENT);
  target[key] = value;
}

/** Индекс позиций списка: строится заново, если его нет или журнал сдвигов разросся. */
function posIndex(st, arr) {
  let ix = st.pos.get(arr);
  if (ix && ix.log.length <= POS_LOG_MAX * 2) return ix;
  const map = new Map();
  let dup = false;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (map.has(c)) { dup = true; break; }
    map.set(c, i);
  }
  // с повторами (битый документ) индекс не нужен: там нужен ПЕРВЫЙ из повторов
  // и «вычеркнуть все», как делали filter/indexOf, — этим и занимается запасной путь
  ix = { map, log: [], dup };
  st.pos.set(arr, ix);
  return ix;
}

/**
 * Место `id` в списке `arr` — как `arr.indexOf(id)` (первое вхождение, −1 — нет),
 * но в длинном списке черновика — по индексу позиций: запись хранит позицию на
 * момент своей отметки в журнале сдвигов, и до текущей её догоняют только сдвиги,
 * сделанные позже (каждый — «всё, что ≥ p, сдвинулось на d»).
 */
function posOf(draft, arr, id) {
  const st = DRAFT_STATE.get(draft);
  if (!st || arr.length < POS_MIN || arr.length >= POS_SPAN) return arr.indexOf(id);
  const ix = posIndex(st, arr);
  if (ix.dup) return arr.indexOf(id);
  const e = ix.map.get(id);
  if (e === undefined) return -1;
  let p = e % POS_SPAN;
  const log = ix.log;
  for (let k = (e - p) / POS_SPAN; k < log.length; k += 2) if (p >= log[k]) p += log[k + 1];
  if (arr[p] !== id) {
    // не должно случаться (список правят только arrInsert/arrRemoveAt) — но если
    // случилось, честный поиск дешевле неверного места
    logOnce('posOf:stale', 'posOf: индекс позиций разошёлся со списком — перестраиваю');
    st.pos.delete(arr);
    return arr.indexOf(id);
  }
  if (arr.length < POS_SPAN) ix.map.set(id, log.length * POS_SPAN + p);
  return p;
}

/** Вставка в список черновика (только в его собственный, см. ownKids). */
function arrInsert(draft, arr, i, id, j) {
  arr.splice(i, 0, id);
  if (j) j.push(J_INS, arr, i, ABSENT);
  const st = DRAFT_STATE.get(draft);
  const ix = st && st.pos.get(arr);
  if (ix && !ix.dup) {
    if (ix.map.has(id)) ix.dup = true;
    else {
      ix.log.push(i, 1);
      ix.map.set(id, ix.log.length * POS_SPAN + i);
    }
  }
}

/** Вырезание из списка черновика по месту. */
function arrRemoveAt(draft, arr, i, j) {
  const x = arr.splice(i, 1)[0];
  if (j) j.push(J_DEL, arr, i, x);
  const st = DRAFT_STATE.get(draft);
  const ix = st && st.pos.get(arr);
  if (ix && !ix.dup) {
    ix.map.delete(x);
    ix.log.push(i + 1, -1);
  }
  return x;
}

/** Как `arr = arr.filter((c) => c !== id)`, но на месте. */
function arrRemoveAll(draft, arr, id, j) {
  const st = DRAFT_STATE.get(draft);
  if (st && arr.length >= POS_MIN && !posIndex(st, arr).dup) {
    const at = posOf(draft, arr, id);
    if (at >= 0) arrRemoveAt(draft, arr, at, j);
    return;
  }
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === id) arrRemoveAt(draft, arr, i, j);
}

/**
 * Список детей узла `id`, который черновик вправе править на месте: при первом
 * касании — копия (и новый объект узла с ней), дальше — тот же массив.
 * children не массив — исключение, как прежде у `children.filter`/`slice`
 * (applyStep/applyOps превращают его в bad-op). Удаление такого списка не
 * трогает (круг 31, см. applyOne/remove): из нечитаемого списка снимать нечего.
 */
function ownKids(draft, id, j) {
  const node = draft.nodes[id];
  const kids = node.children;
  if (!Array.isArray(kids)) throw new TypeError(`children узла «${id}» — не массив`);
  const st = DRAFT_STATE.get(draft);
  if (st && st.own.has(kids)) return kids;
  const copy = kids.slice();
  if (st) st.own.add(copy);
  putNode(draft, id, { ...node, children: copy }, j);
  return copy;
}

/** Откат черновика к отметке журнала (с конца: одна операция пишет ключ не раз). */
function rollbackDraft(draft, j, mark) {
  for (let i = j.length - 4; i >= mark; i -= 4) {
    const kind = j[i];
    const target = j[i + 1];
    const key = j[i + 2];
    const v = j[i + 3];
    if (kind === J_NODE) {
      if (v === ABSENT) delete draft.nodes[key];
      else draft.nodes[key] = v;
    } else if (kind === J_TOKENS) draft.tokens = v;
    else if (kind === J_INS) arrRemoveAt(draft, target, key, null);
    else if (kind === J_DEL) arrInsert(draft, target, key, v, null);
    else if (kind === J_PROP) {
      if (v === ABSENT) delete target[key];
      else target[key] = v;
    }
  }
  j.length = mark;
}

/**
 * Одна операция в черновик «всё или ничего»: не легла (ошибка или исключение) —
 * черновик откатывается к состоянию до неё. Ошибка — как у applyOne.
 * @returns {{code:string,message:string,limit?:string}|null}
 */
function applyStep(draft, op, j) {
  j.length = 0;
  let err;
  try {
    err = applyOne(draft, op, j);
  } catch (e) {
    logOnce('apply:throw', 'исключение при применении операций', e);
    err = opErr('bad-op', 'правку не удалось применить: в операции негодное значение');
  }
  if (err) rollbackDraft(draft, j, 0);
  j.length = 0;
  return err;
}

/* Круг 39 (N2): стража раскрытия для applyOps и rebase. Операция, после которой
   раскрытие экземпляров превысило бы MAX_EXPANDED_NODES, не проходит
   (`bad-op`, `limit:'expand_nodes'`). Документ, уже бывший сверх предела
   (старым журналом), правке не запирается: предел для него — его же нынешняя
   стоимость (удалять и править можно, раздувать дальше — нет), как doc_nodes у
   DSLTS.

   Полный пересчёт (expandAnalysis().total()) линеен по документу, и на каждую
   операцию пачки в 5000 он был бы квадратом, поэтому стража ведёт стоимость
   (`total`) и числа раскрытий мастеров (`mult`) по приращениям:
   • экземпляр вне мастеров (создан, сменил of/props) — total ± стоимость его
     записи раскрытия, mult ± вклад записи (expandContrib); записи — из анализа,
     заведённого после последней правки мастеров (он ленив и дёшев: считает
     только то, о чём спросили, без обхода документа);
   • простой узел внутри мастера — total + mult(мастер) (каждое раскрытие
     копирует новый узел ровно один раз), mult не меняется, анализ — заново;
   • remove — стоимость только падает: total и mult остаются оценкой сверху
     (exact = false), анализ — заново;
   • setToken и правки полей, кроме of/props/component/role, на раскрытие не влияют;
   • прочее (библиотека, мастера, экземпляры внутри мастеров, move в мастер и из
     него, страницы) — «грязно»: следующий вопрос пересчитывает целиком.
   Решение «за пределом» — только по точной стоимости: оценка сверх предела
   сначала уточняется полным пересчётом. Тест сверяет решения с наивным полным
   пересчётом после каждой операции. */
const EG_DIRTY = { kind: 'dirty' };
const EG_SHRINK = { kind: 'shrink' };

/**
 * @param {object} base документ ДО пачки (не меняется)
 * @param {object} draft черновик, в который пишет applyOne
 */
function expandGuard(base, draft) {
  let lib;                 // id библиотеки черновика (undefined — не искали)
  let ana = null;          // анализ черновика (память записей раскрытия мастеров)
  let anaOk = false;       // анализ заведён после последней правки мастеров
  let total = null;        // стоимость черновика (точно или сверху; null — неизвестна)
  let exact = false;       // total точна
  let mult = null;         // мастер → сколько раз раскрывается (точно или сверху); null — неизвестно
  let log = [];            // правки mult после последней точки сохранения: [мастер, приращение]
  let limit = null;        // max(MAX_EXPANDED_NODES, стоимость base)

  const libId = () => {
    if (lib === undefined) {
      const l = libraryNode(draft);
      lib = l ? l.id : null;
    }
    return lib;
  };
  /** предок-или-сам, лежащий прямо в библиотеке (мастер или его заготовка), иначе null */
  const masterAbove = (id) => {
    const L = libId();
    if (L === null || !isNodeId(id)) return null;
    let cur = ownNode(draft.nodes, id);
    for (let guard = 0; cur && guard < 100000; guard++) {
      if (cur.parent === L) return cur;
      if (cur.id === L || !isNodeId(cur.parent)) return null;
      cur = ownNode(draft.nodes, cur.parent);
    }
    return null;
  };
  const full = () => {
    ana = expandAnalysis(draft);
    anaOk = true;
    total = ana.total();
    exact = true;
    const m = ana.multMap();
    mult = m ? new Map(m) : null;    // null — счёт оборван: total = Infinity
    log = [];
  };
  const known = () => {
    if (total === null || (mult === null && Number.isFinite(total))) full();
  };
  const freshAna = () => {
    if (!anaOk) { ana = expandAnalysis(draft); anaOk = true; }
  };
  const addMult = (m, d) => {
    if (!mult) return;
    mult.set(m, (mult.get(m) || 0) + d);
    log.push(m, d);
  };
  const settle = () => {
    if (!Number.isFinite(total)) { total = Infinity; exact = false; }
  };

  return {
    /** До применения: как операция влияет на раскрытие. @returns {object|null} */
    pre(op) {
      if (!op || typeof op !== 'object') return null;
      switch (op.op) {
        case 'create': {
          const n = op.node;
          if (!n || typeof n !== 'object') return null;
          if (n.type === 'page' || n.component !== undefined || (Array.isArray(n.children) && n.children.length)) return EG_DIRTY;
          if (libId() === null) return null;           // без библиотеки мастеров нет — раскрывать нечего
          const m = masterAbove(n.parent);
          if (n.type === 'instance') {
            if (m) return EG_DIRTY;
            known(); freshAna();
            return { kind: 'inst', oldE: null };
          }
          if (!m || !m.component) return null;
          known();
          return { kind: 'plain', delta: mult ? (mult.get(m.id) || 0) : Infinity };
        }
        case 'set': {
          const n = ownNode(draft.nodes, op.id);
          if (!n) return null;
          const path = typeof op.path === 'string' ? op.path : isNum(op.path) ? String(op.path) : '';
          const head = path.split('.')[0];
          if (head === 'role') return n.type === 'page' ? EG_DIRTY : null;
          if (head !== 'component' && head !== 'of' && head !== 'props') return null;
          const L = libId();
          if (L === null) return null;
          if (head === 'component') return n.parent === L ? EG_DIRTY : null;
          if (n.type !== 'instance') return null;
          if (masterAbove(n.id)) return EG_DIRTY;
          known(); freshAna();
          return { kind: 'inst', oldE: ana.entry(n) };
        }
        case 'remove': {
          const n = ownNode(draft.nodes, op.id);
          if (!n) return null;
          return n.type === 'page' ? EG_DIRTY : EG_SHRINK;
        }
        case 'move': {
          const n = ownNode(draft.nodes, op.id);
          if (!n) return null;
          if (n.type === 'page') return EG_DIRTY;
          const L = libId();
          if (L === null) return null;
          if (n.parent === L || op.parent === L || masterAbove(n.id) || masterAbove(op.parent)) return EG_DIRTY;
          return null;
        }
        default:
          return null;                                  // setToken: раскрытие от токенов не зависит
      }
    },
    /** После применения. @returns {boolean} могла ли стоимость вырасти */
    post(plan, op) {
      if (plan === EG_SHRINK) {
        exact = false;
        anaOk = false;
        return false;
      }
      if (plan === EG_DIRTY || total === null) {
        ana = null; anaOk = false; total = null; mult = null; lib = undefined; log = [];
        return true;
      }
      if (plan.kind === 'plain') {
        total += plan.delta;
        anaOk = false;
        settle();
        return true;
      }
      // 'inst': новый вид экземпляра (create — новый узел, set — он же после правки);
      // мастера не менялись — записи того же анализа годны
      const id = op.op === 'create' ? op.node && op.node.id : op.id;
      const now = ownNode(draft.nodes, id);
      const newE = now && now.type === 'instance' ? ana.entry(now) : null;
      total += (newE ? newE.cost : 0) - (plan.oldE ? plan.oldE.cost : 0);
      expandContrib(plan.oldE, -1, addMult);
      expandContrib(newE, 1, addMult);
      settle();
      return true;
    },
    /** Нарушен ли предел сейчас. @returns {null|{cost:number, max:number}} */
    over() {
      if (total === null) full();
      if (total <= MAX_EXPANDED_NODES) return null;
      if (!exact) {
        full();
        if (total <= MAX_EXPANDED_NODES) return null;
      }
      if (limit === null) limit = Math.max(MAX_EXPANDED_NODES, expandCost(base));
      return total > limit ? { cost: total, max: MAX_EXPANDED_NODES } : null;
    },
    /** Точка сохранения перед операцией (rebase откатывает не легшую). */
    save() {
      return [lib, ana, anaOk, total, exact, mult, log, log.length];
    },
    restore(s) {
      let n;
      [lib, ana, anaOk, total, exact, mult, log, n] = s;
      while (log.length > n) {
        const d = log.pop();
        const m = log.pop();
        if (mult) mult.set(m, mult.get(m) - d);
      }
    },
    /** Операция легла — журнал правок mult больше не нужен. */
    commit() {
      log = [];
    },
    reset() {
      ana = null; anaOk = false; total = null; mult = null; lib = undefined; log = [];
    }
  };
}

/** Ошибка операции «раскрытие за пределом». */
function expandErr(what, over) {
  return opErr('bad-op', `${what}: слишком много вложенных экземпляров — раскрытие дало бы ${bigCount(over.cost)} узлов, предел ${over.max}`,
    { limit: EXPAND_LIMIT });
}

/**
 * applyStep со стражей раскрытия (rebase): операция, после которой раскрытие
 * вышло бы за предел, откатывается, как не легшая.
 */
function applyStepGuarded(draft, op, j, guard) {
  j.length = 0;
  let err;
  let snap = null;
  try {
    const plan = guard.pre(op);
    if (plan) snap = guard.save();
    err = applyOne(draft, op, j);
    if (!err && plan && guard.post(plan, op)) {
      const over = guard.over();
      if (over) err = expandErr(shown(op.op), over);
    }
  } catch (e) {
    logOnce('apply:throw', 'исключение при применении операций', e);
    err = opErr('bad-op', 'правку не удалось применить: в операции негодное значение');
    snap = null;
    guard.reset();
  }
  if (err) {
    rollbackDraft(draft, j, 0);
    if (snap) guard.restore(snap);
  } else if (snap) guard.commit();
  j.length = 0;
  return err;
}

/**
 * Цепочка предков узла в черновике (с ним самим) — для проверки циклов.
 * Круг 27: без предела глубины (раньше обрывалась на MAX_DEPTH, и узел глубже
 * 256 уровней можно было повесить под собственного потомка); от цикла, уже
 * лежащего в документе, — по множеству пройденных.
 */
function ancestorIds(draft, id) {
  const out = new Set();
  let cur = id ? ownNode(draft.nodes, id) : null;
  while (cur && !out.has(cur.id)) {
    out.add(cur.id);
    cur = cur.parent ? ownNode(draft.nodes, cur.parent) : null;
  }
  return out;
}

/** Лежит ли `id` на пути от `fromId` вверх (включая сам `fromId`). Без предела глубины. */
function onPathUp(draft, fromId, id) {
  const seen = new Set();
  let cur = fromId ? ownNode(draft.nodes, fromId) : null;
  while (cur && !seen.has(cur.id)) {
    if (cur.id === id) return true;
    seen.add(cur.id);
    cur = cur.parent ? ownNode(draft.nodes, cur.parent) : null;
  }
  return false;
}

/**
 * Глубина узла (у корня 0). Точная и в документе глубже предела (прежняя версия:
 * там move «вглубь» сравнивает две глубины за пределом); цикл в битом документе —
 * Infinity (множество пройденных заводим только за MAX_DEPTH, обычный путь без него).
 */
function depthOf(draft, id) {
  let d = 0;
  let seen = null;
  let cur = id ? ownNode(draft.nodes, id) : null;
  while (cur && cur.parent) {
    if (d > MAX_DEPTH) {
      if (!seen) seen = new Set();
      if (seen.has(cur.id)) return Infinity;
      seen.add(cur.id);
    }
    cur = ownNode(draft.nodes, cur.parent);
    if (!cur) break;
    d++;
  }
  return d;
}

/** Не глубже ли поддерево узла `limit` уровней под ним (лист — 0). Обход с выходом при первом превышении. */
function heightWithin(draft, id, limit) {
  if (limit < 0) return false;
  const seen = new Set();
  const stack = [id, 0];
  while (stack.length) {
    const d = stack.pop();
    const nid = stack.pop();
    if (seen.has(nid)) continue;
    const n = ownNode(draft.nodes, nid);
    if (!n) continue;
    seen.add(nid);
    if (d > limit) return false;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c, d + 1);
  }
  return true;
}

const depthErr = (what) => opErr('bad-parent', `${what}: вложенность глубже ${MAX_DEPTH} уровней`, { limit: 'depth' });

/** Токены после setToken — той формы, без которой документ не открыть. */
const tokensShapeOk = (t) => !!(t && t.colors && t.type && Array.isArray(t.spacing) && Array.isArray(t.radii));

/** Тип-токен: объект; шрифт — строка, числа — в границах (те же, что у style узла). */
function typeEntryProblem(v, what) {
  if (!isObj(v)) return `${what}: нужен объект`;
  const err = textStyleFieldsProblem(v, TYPE_ENTRY_FIELDS, what);
  if (err) return err;
  const plain = plainProblem(v, 1);
  return plain ? `${what}: ${plain}` : null;
}

/** Шаг шкалы — конечное число в границах схемы. */
const stepOk = (x) => isNum(x) && x >= 0 && x <= MAX_SIZE;

/**
 * Круг 29: форма значения, которое setToken пишет по пути. Проверяется только
 * записываемое (не соседние ключи: мусор, уже лежащий в палитре старого
 * документа, не должен запирать правку другого цвета). Группы colors / type /
 * spacing / radii читаются решателем и сценой — у них форма строгая; прочие
 * группы никто не читает, им достаточно простых данных.
 * @param {string[]} parts путь, разобранный по точкам
 * @param {any} value значение (undefined — снятие ключа)
 * @param {object} tokens токены ДО записи — нужна длина шкалы
 * @returns {string|null}
 */
function tokenColorsProblem(parts, value) {
  const n = parts.length;
  const del = value === undefined;
  if (n === 1) {
    if (del) return null;   // структуру сторожит tokensShapeOk
    if (!isObj(value)) return 'colors: нужен объект';
    for (const k of Object.keys(value)) if (typeof value[k] !== 'string') return `colors.${k} должен быть строкой`;
    return null;
  }
  if (n > 2) return `${parts.slice(0, 2).join('.')}: цвет — строка`;
  return del || typeof value === 'string' ? null : `colors.${parts[1]} должен быть строкой`;
}

function tokenTypeProblem(parts, value, tokens) {
  const n = parts.length;
  const del = value === undefined;
  if (n === 1) {
    if (del) return null;
    if (!isObj(value)) return 'type: нужен объект';
    for (const k of Object.keys(value)) {
      const err = typeEntryProblem(value[k], 'type.' + k);
      if (err) return err;
    }
    return null;
  }
  if (n === 2) return del ? null : typeEntryProblem(value, 'type.' + parts[1]);
  if (n === 3 && del) return null;   // поля стиля необязательны
  if (n > 3) {
    const plain = del ? null : plainProblem(value, n - 1);
    if (plain) return `${parts.join('.')}: ${plain}`;
  }
  /* Круг 33: проверяется ИТОГОВОЕ поле записи, а не только записываемое
     значение. `type.body.fontSize.x = 16` раньше проходило (глубже трёх —
     «простые данные») и превращало число fontSize в объект {x:16}: документ
     после этого не импортировался. Знакомые поля (font, fontSize, …) — скаляры,
     путь глубже них даёт объект и отклоняется typeEntryProblem; незнакомые
     поля — простые данные любой формы. Соседние поля записи не смотрим. */
  const group = tokens && isObj(tokens.type) ? tokens.type : {};
  const entryNow = isObj(group[parts[1]]) ? group[parts[1]] : {};
  const field = n === 3
    ? value
    : setPath(isObj(entryNow[parts[2]]) ? entryNow[parts[2]] : {}, parts.slice(3).join('.'), value);
  return typeEntryProblem({ [parts[2]]: field }, 'type.' + parts[1]);
}

function tokenStepsProblem(parts, value, tokens) {
  const [group] = parts;
  const n = parts.length;
  const del = value === undefined;
  /* Круг 36 (SPEC §11.1): шкалы движения и теней — у них три именованных шага
     (motion: fast/base/slow — мс; shadow: sm/md/lg — «dx dy blur цвет»). Пишут
     шаг или группу целиком; снять можно и шаг (ссылка на него станет мёртвой —
     dead-motion-ref, отрисовка возьмёт умолчание), и группу (документ вернётся
     к умолчаниям ядра). */
  const steps = group === 'motion' ? MOTION_STEPS : SHADOW_STEPS;
  const ok = group === 'motion' ? motionStepOk : shadowStepOk;
  const want = group === 'motion'
    ? `мс ${STATE_LIMITS.duration[0]}..${STATE_LIMITS.duration[1]}`
    : "описание тени «dx dy blur цвет» (px; цвет #hex или rgba()) или 'none'";
  if (n === 1) {
    if (del) return null;
    if (!isObj(value)) return `${group}: нужен объект {${steps.join(', ')}}`;
    for (const k of Object.keys(value)) {
      if (steps.indexOf(k) < 0) return `${group}.${k}: шаги — ${steps.join(', ')}`;
      if (!ok(value[k])) return `${group}.${k}: ${want}`;
    }
    return null;
  }
  if (steps.indexOf(parts[1]) < 0) return `${group}.${parts[1]}: шаги — ${steps.join(', ')}`;
  if (n > 2) return `${group}.${parts[1]}: шаг пишут целиком`;
  if (del) return null;
  return ok(value) ? null : `${group}.${parts[1]}: ${want}`;
}

function tokenScaleProblem(parts, value, tokens) {
  const [group] = parts;
  const n = parts.length;
  const del = value === undefined;
  if (n === 1) {
    if (del) return null;
    if (!Array.isArray(value)) return `${group}: нужен массив чисел`;
    return value.every(stepOk) ? null : `${group}: шаги — числа 0..${MAX_SIZE}`;
  }
  const cur = tokens && Array.isArray(tokens[group]) ? tokens[group] : [];
  if (n > 2 || !/^(0|[1-9]\d*)$/.test(parts[1])) return `${group}: шаг адресуется номером`;
  // снятие шага дало бы дыру в массиве (в JSON — null), запись за концом — тоже
  if (del) return `${group}: шаг не снимают — шкалу пишут целиком`;
  if (Number(parts[1]) > cur.length) return `${group}: шага ${parts[1]} нет — шкала длиной ${cur.length}`;
  return stepOk(value) ? null : `${group}.${parts[1]}: число 0..${MAX_SIZE}`;
}

/**
 * Круг 43: группы токенов со строгой формой — таблица и проверки, и отпечатка
 * формата. Прочие группы — простые данные.
 */
const TOKEN_RULES = Object.freeze({
  colors: tokenColorsProblem, type: tokenTypeProblem,
  motion: tokenStepsProblem, shadow: tokenStepsProblem,
  spacing: tokenScaleProblem, radii: tokenScaleProblem
});

function tokenWriteProblem(parts, value, tokens) {
  const [group] = parts;
  const n = parts.length;
  const del = value === undefined;
  if (hasOwnProp.call(TOKEN_RULES, group)) return TOKEN_RULES[group](parts, value, tokens);
  if (del) return null;
  const plain = plainProblem(value, n);
  return plain ? `${parts.join('.')}: ${plain}` : null;
}

/** Номер элемента массива в пути: каноническая запись неотрицательного целого. */
const INDEX_RE = /^(0|[1-9]\d*)$/;

/**
 * Круг 31: путь записи (set / setToken) через массивы. Запись, которую нельзя
 * точно отменить, не принимается:
 *   • элемент массива адресуется только номером (`list.foo` у массива в JSON
 *     пропадает, а hashDoc его не видит);
 *   • номер — не дальше длины: запись в конец (номер = длина) удлиняет массив
 *     на один, дальше — оставила бы дыры (в JSON — null);
 *   • снятие элемента (value undefined) оставило бы дыру той же длины — массив
 *     пишут целиком.
 * Проверяется только существующее: за первым не-объектом по пути setPath
 * заводит свежие объекты, массивов там нет.
 * @param {object} root узел или tokens ДО записи
 * @param {string[]} parts путь, разобранный по точкам
 * @param {boolean} del снятие ключа
 * @returns {string|null}
 */
function arrayPathProblem(root, parts, del) {
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return null;
    if (Array.isArray(cur)) {
      const where = parts.slice(0, i).join('.');
      if (!INDEX_RE.test(parts[i])) return `${where}: элемент массива адресуется номером`;
      if (Number(parts[i]) > cur.length) return `${where}: элемента ${parts[i]} нет — длина ${cur.length}`;
      if (del && i === parts.length - 1) return `${where}: элемент массива не снимают — массив пишут целиком`;
    }
    cur = cur[parts[i]];
  }
  return null;
}

/**
 * setToken на месте (круг 27): контейнеры по пути копируются один раз на
 * черновик, дальше пишутся на месте — 5000 setToken в палитру больше не копируют
 * её 5000 раз. Результат — тот же, что у `setPath(tokens, path, value)`:
 * • копия контейнера — как у setPath (массив — slice, объект — spread, не объект — {});
 * • массивы не правим на месте никогда (запись по индексу за длиной меняла бы
 *   length, а откат — нет): они маленькие (шкалы), копия на операцию дешева;
 * • снятие ключа (value undefined) — в свежей копии контейнера: откат вернёт
 *   прежний объект целиком, и порядок ключей палитры не съедет.
 */
function setTokenInPlace(draft, st, parts, value, j) {
  const del = value === undefined;
  const last = parts.length - 1;
  const reuse = (obj, level) => !!obj && typeof obj === 'object' && !Array.isArray(obj) && st.own.has(obj) && !(del && level === last);
  let cur = draft.tokens;
  if (!reuse(cur, 0)) {
    const copy = Array.isArray(cur) ? cur.slice() : { ...cur };
    st.own.add(copy);
    if (j) j.push(J_TOKENS, null, null, draft.tokens);
    draft.tokens = copy;
    cur = copy;
  }
  for (let i = 0; i < last; i++) {
    const p = parts[i];
    const next = cur[p];
    if (reuse(next, i + 1)) { cur = next; continue; }
    const copy = next && typeof next === 'object' ? (Array.isArray(next) ? next.slice() : { ...next }) : {};
    st.own.add(copy);
    putProp(cur, p, copy, j);
    cur = copy;
  }
  if (del) delete cur[parts[last]];
  else putProp(cur, parts[last], deepClone(value), j);
}

/** Круг 43: операции формата (SPEC §1): applyOne знает ровно эти. */
const OP_NAMES = Object.freeze(['create', 'remove', 'set', 'move', 'setToken']);
const OP_NAME_SET = new Set(OP_NAMES);

/**
 * Внутреннее применение одной операции к изменяемой копии документа.
 * @returns {{code:string,message:string}|null}
 */
function applyOne(draft, op, j) {
  if (!op || typeof op !== 'object') return opErr('bad-op', 'операция не объект');
  // круг 43: перечень операций — таблица (она же в отпечатке формата)
  if (!OP_NAME_SET.has(op.op)) return opErr('bad-op', `неизвестная операция «${shown(op.op)}»`);
  switch (op.op) {
    case 'create': {
      const node = deepClone(op.node);
      if (!node || typeof node !== 'object') return opErr('bad-node', 'create: нет узла');
      if (!node.id) node.id = uid();
      if (ownNode(draft.nodes, node.id)) return opErr('bad-node', `create: id «${node.id}» уже занят`);
      if (node.type === 'frame' || node.type === 'page') node.children = Array.isArray(node.children) ? node.children.slice() : [];
      if (Array.isArray(node.children)) {
        const st = DRAFT_STATE.get(draft);
        if (st) st.own.add(node.children);   // свой массив нового узла — правится на месте
      }
      // круг 19: у экземпляра размер НЕ достраиваем — незаданная ось берётся у
      // мастера (см. instanceSize). Достроенный hug сделал бы экземпляр кнопки
      // 200×48 размером «по содержимому» и увёл бы его вид от компонента.
      if (node.type !== 'page' && node.type !== 'instance' && !node.size) node.size = sizeSpec('hug', 'hug');
      // layout нормализуем и здесь: `set layout.*` это делал, а `create` — нет,
      // поэтому сырая операция с layout:{padding:8} отклонялась («padding должен
      // быть объектом»), а с {mode,gap} кладла в документ половину объекта.
      // Отсутствующий layout не добавляем — он равносилен DEFAULT_LAYOUT.
      if (node.type === 'frame' && node.layout !== undefined) {
        const rawErr = rawLayoutProblem(node.layout);
        if (rawErr) return opErr('bad-node', `create: ${rawErr}`);
        node.layout = normalizeLayout(node.layout);
      }
      const parent = node.parent ? ownNode(draft.nodes, node.parent) : null;
      /* Круг 19, п.1: родитель нужен всем, кроме страницы БЕЗ родителя (корень).
         Страница-библиотека — тоже ребёнок корня: ей нужен и живой родитель, и
         место в его children, иначе она висела бы в doc.nodes мёртвым грузом
         и pruneBrokenEdges выбросил бы её как недостижимую. */
      const needsParent = node.type !== 'page' || !!node.parent;
      if (needsParent) {
        if (!parent) return opErr('bad-parent', `create: родитель «${shown(node.parent)}» не найден`);
        if (!CONTAINER_TYPES.has(parent.type)) return opErr('bad-parent', 'create: родитель не контейнер');
      }
      const err = checkNode(node, draft, !!op.exact);
      if (err) return opErr('bad-node', `create: ${err}`);
      /* Круг 20 (SPEC §6.1): ссылка на шаг, которого нет в шкале, операцией
         не проходит — как неизвестный пропс в круге 19. Инверсия удаления
         (create с exact) восстанавливает узел таким, каким он был, даже если
         шкалу успели укоротить: об этом скажет валидатор, а отмена не должна
         отказывать. */
      if (!op.exact) {
        const dead = deadScaleRefs(draft, node);
        if (dead.length) return opErr('bad-node', `create: ${dead[0].path}: ${dead[0].reason}`);
      }

      // заранее перечисленные дети: проверяем всё до единой записи в черновик
      const kids = Array.isArray(node.children) ? node.children.slice() : [];
      if (kids.length && !CONTAINER_TYPES.has(node.type)) return opErr('bad-node', 'create: дети бывают только у контейнера');
      const chain = ancestorIds(draft, node.parent);
      const kidSet = new Set();
      for (const c of kids) {
        if (kidSet.has(c)) return opErr('bad-node', `create: ребёнок «${c}» указан дважды`);
        kidSet.add(c);
        if (!ownNode(draft.nodes, c)) return opErr('bad-node', `create: ребёнок «${c}» ещё не создан`);
        if (c === node.id) return opErr('cycle', 'create: узел не может быть своим ребёнком');
        if (chain.has(c)) return opErr('cycle', `create: «${c}» — предок нового узла, перевешивать нельзя`);
        if (draft.nodes[c].type === 'page') return opErr('bad-node', `create: «${c}» — страница, её нельзя вложить`);
      }
      /* Круг 27: предел вложенности. Раньше create глубже MAX_DEPTH проходил, а
         обходы (предки, удаление поддерева) на MAX_DEPTH обрывались: move вешал
         верх цепочки под её низ (цикл), remove оставлял сирот. Узел глубже
         предела операцией не появляется — ни сам, ни усыновлённое поддерево. */
      const depth = needsParent ? depthOf(draft, parent.id) + 1 : 0;
      if (depth > MAX_DEPTH) return depthErr('create');
      for (const c of kids) {
        if (depth + 1 > depthOf(draft, c) && !heightWithin(draft, c, MAX_DEPTH - depth - 1)) return depthErr('create');
      }

      if (needsParent) {
        const list = ownKids(draft, parent.id, j);
        const idx = isNum(op.index) ? clamp(Math.round(op.index), 0, list.length) : list.length;
        arrInsert(draft, list, idx, node.id, j);
      }
      putNode(draft, node.id, node, j);
      // переезд детей: снимаем их с прежних родителей, иначе узел окажется в двух местах
      for (const c of kids) {
        const child = draft.nodes[c];
        const oldParent = child.parent ? ownNode(draft.nodes, child.parent) : null;
        if (oldParent && Array.isArray(oldParent.children)) {
          arrRemoveAll(draft, ownKids(draft, oldParent.id, j), c, j);
        }
        putNode(draft, c, { ...draft.nodes[c], parent: node.id }, j);
      }
      return null;
    }
    case 'remove': {
      const node = ownNode(draft.nodes, op.id);
      if (!node) return opErr('not-found', `remove: узел «${shown(op.id)}» не найден`);
      if (node.id === draft.root) return opErr('protected-path', 'remove: нельзя удалить корень');
      // круг 27: поддерево целиком, без предела глубины (раньше глубже MAX_DEPTH
      // оставались сироты) и без рекурсии (стек); порядок — прежний, сверху вниз
      const ids = [];
      const seen = new Set();
      const stack = [op.id];
      while (stack.length) {
        const nid = stack.pop();
        const n = ownNode(draft.nodes, nid);
        if (!n || seen.has(nid)) continue;
        seen.add(nid);
        ids.push(nid);
        // круг 31: children нечитаемой формы (документ прежней версии) — детей нет;
        // раньше здесь было исключение, и узел с мусором в children не удалялся никогда
        const kids = kidsOf(n);
        for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
      }
      const parent = ownNode(draft.nodes, node.parent);
      // круг 31: у родителя нечитаемый список детей (документ прежней версии) —
      // снимать из него нечего, а исключение запирало удаление ребёнка навсегда
      if (parent && Array.isArray(parent.children)) arrRemoveAll(draft, ownKids(draft, parent.id, j), op.id, j);
      for (const nid of ids) delNode(draft, nid, j);
      return null;
    }
    case 'set': {
      const node = ownNode(draft.nodes, op.id);
      if (!node) return opErr('not-found', `set: узел «${shown(op.id)}» не найден`);
      const path = typeof op.path === 'string' ? op.path : isNum(op.path) ? String(op.path) : '';   // круг 29: без приведения объекта
      if (!path) return opErr('bad-op', 'set: пустой путь');
      const parts = path.split('.');
      // круг 33: пустой сегмент (`.name`, `layout..gap`, `.`) заводил ключ «» — его
      // инверсия выходила с пустым путём и не ложилась
      if (parts.includes('')) return opErr('bad-op', `set «${shown(path)}»: пустой сегмент пути`);
      if (PROTECTED_PATHS.has(parts[0])) return opErr('protected-path', `set: путь «${parts[0]}» защищён`);
      // ключи прототипа — на любом уровне: set(id, 'style.__proto__') так же опасен
      // круг 29: и любые имена Object.prototype — `style.toString = 1` ломает приведение
      const unsafe = parts.find((p) => PROTO_KEYS.has(p));
      if (unsafe) return opErr('protected-path', `set: путь «${unsafe}» защищён`);
      // круг 16, п.1: строка поверх объекта-обёртки (style, stroke, fill, color) не
      // должна плодить второй вид того же значения — см. keepFieldForm; круг 20:
      // там же число, равное значению текущей ссылки на шаг шкалы, оставляет ссылку
      // круг 29: записываемое — простые данные, ДО приведения формы: keepFieldForm
      // раскрывает краткие записи и молча выбросил бы из `{toString:1}` всё лишнее
      const plainErr = plainProblem(op.value, parts.length) || arrayPathProblem(node, parts, op.value === undefined);
      if (plainErr) return opErr('bad-node', `set ${path}: ${plainErr}`);
      const value = !op.exact ? keepFieldForm(node, path, op.value, draft) : op.value;
      let next = setPath(node, path, value);
      // круг 16, п.3: раскладку нормализуем, только если поле осталось в узле.
      // Раньше сюда попадала и инверсия «удалить ключ layout» ({op:'set',path:'layout'}
      // без value) — и вместо удаления в узел ложился полный DEFAULT_LAYOUT: отмена
      // возвращала документ ПОХОЖИМ на исходный, но не равным ему.
      if (next.type === 'frame' && parts[0] === 'layout' && next.layout !== undefined) {
        const rawErr = rawLayoutProblem(next.layout);
        if (rawErr) return opErr('bad-node', `set ${path}: ${rawErr}`);
        next = { ...next, layout: normalizeLayout(next.layout) };
      }
      let err = checkNode(next, draft, !!op.exact);
      /* Круг 29: причина, которая была у узла и ДО правки, — не причина отказать
         этой правке. Схема стала строже (форма каждого поля), а в документах
         прежних версий лежит то, что раньше проходило (`clip: 1`, объект в
         style.token): узел не должен запираться от правки имени из-за соседнего
         поля. Поэтому (1) соседние поля негодной формы на время проверки
         снимаются (обязательные — заглушкой), и записанное проверяется схемой в
         полном объёме; (2) прочая причина, бывшая и до правки, — тоже не повод.
         Само записываемое поле обязано быть годным — так мусор не входит и через
         «ту же самую» причину. */
      if (err && !fieldProblem(next, parts[0])) {
        const probe = withoutBadFields(next, parts[0]);
        const perr = probe === next ? err : checkNode(probe, draft, !!op.exact);
        if (!perr || perr === checkNode(withoutBadFields(node, parts[0]), draft, !!op.exact)) err = null;
      }
      if (err) return opErr('bad-node', `set ${path}: ${err}`);
      /* Круг 20 (SPEC §6.1): ссылка на шаг, которого в шкале нет, операцией не
         проходит. Проверяем только то, что пишет ЭТА операция (путь и всё под
         ним): мёртвая ссылка, уже лежащая в соседнем поле (файл, укороченная
         шкала), не должна запирать узел от правки заливки или имени — о ней
         скажет валидатор. Инверсия (exact) пишет то, что было, без проверки. */
      // круг 36: и подъём состояния (states.<s>.lift = 'spacing.N')
      if (!op.exact && (parts[0] === 'layout' || parts[0] === 'radius' || parts[0] === 'states')) {
        const dead = deadScaleRefs(draft, next, path);
        if (dead.length) return opErr('bad-node', `set ${path}: ${dead[0].reason}`);
      }
      putNode(draft, op.id, next, j);
      return null;
    }
    case 'move': {
      const node = ownNode(draft.nodes, op.id);
      if (!node) return opErr('not-found', `move: узел «${shown(op.id)}» не найден`);
      const parent = ownNode(draft.nodes, op.parent);
      if (!parent) return opErr('bad-parent', `move: родитель «${shown(op.parent)}» не найден`);
      if (!CONTAINER_TYPES.has(parent.type)) return opErr('bad-parent', 'move: родитель не контейнер');
      if (op.id === op.parent) return opErr('cycle', 'move: узел не может быть своим родителем');
      /* Круг 19, п.1: move схемой не перепроверяет узел (он не меняется), поэтому
         единственное правило о странице проверяем здесь: страница живёт только в
         корне, и только если это библиотека. Иначе `move` заводил бы в документе
         страницу внутри фрейма — вид, который checkNode отклоняет, а solve
         раскладывает как контейнер. */
      if (draft.nodes[op.id] && draft.nodes[op.id].type === 'page') {
        if (op.id === draft.root) return opErr('protected-path', 'move: корень не перевешивают');
        if (op.parent !== draft.root) return opErr('bad-parent', 'move: страница живёт только в корне');
        if (draft.nodes[op.id].role !== LIBRARY_ROLE) return opErr('bad-parent', 'move: эту страницу перевешивать нельзя');
      }
      // круг 27: цикл ищем по всей цепочке (раньше — на MAX_DEPTH шагов, и низ
      // цепочки в 300 узлов «не видел» её верх)
      if (onPathUp(draft, parent.id, op.id)) return opErr('cycle', 'move: нельзя переместить узел внутрь себя');
      // предел вложенности: проверяем, только если узел опускается глубже, чем был
      const depth = depthOf(draft, parent.id) + 1;
      if (depth > depthOf(draft, op.id) && !heightWithin(draft, op.id, MAX_DEPTH - depth)) return depthErr('move');
      const old = ownNode(draft.nodes, node.parent);
      if (old) arrRemoveAll(draft, ownKids(draft, old.id, j), op.id, j);
      const list = ownKids(draft, op.parent, j);
      arrRemoveAll(draft, list, op.id, j);
      const idx = isNum(op.index) ? clamp(Math.round(op.index), 0, list.length) : list.length;
      arrInsert(draft, list, idx, op.id, j);
      putNode(draft, op.id, { ...node, parent: op.parent }, j);
      return null;
    }
    case 'setToken': {
      const path = typeof op.path === 'string' ? op.path : isNum(op.path) ? String(op.path) : '';   // круг 29: без приведения объекта
      if (!path) return opErr('bad-op', 'setToken: пустой путь');
      // круг 33: пустой сегмент (`.colors`, `colors.`, `..`) — см. set
      if (path.split('.').includes('')) return opErr('bad-op', `setToken «${shown(path)}»: пустой сегмент пути`);
      const badKey = path.split('.').find((p) => PROTO_KEYS.has(p));
      if (badKey) return opErr('protected-path', `setToken: путь «${badKey}» защищён`);
      const tokErr = tokenWriteProblem(path.split('.'), op.value, draft.tokens)
        || arrayPathProblem(draft.tokens, path.split('.'), op.value === undefined);
      if (tokErr) return opErr('bad-op', `setToken ${path}: ${tokErr}`);
      const st = DRAFT_STATE.get(draft);
      if (!st) {
        const next = setPath(draft.tokens, path, op.value);
        if (!tokensShapeOk(next)) return opErr('bad-op', 'setToken: нарушена структура токенов');
        if (j) j.push(J_TOKENS, null, null, draft.tokens);
        draft.tokens = next;
        return null;
      }
      setTokenInPlace(draft, st, path.split('.'), op.value, j);
      // не легла — откат по журналу (applyStep) или черновик целиком в мусор (applyOps)
      if (!tokensShapeOk(draft.tokens)) return opErr('bad-op', 'setToken: нарушена структура токенов');
      return null;
    }
    default:
      return opErr('bad-op', `неизвестная операция «${shown(op.op)}»`);
  }
}

/**
 * Чеканит id у create-операций прямо в переданных объектах. Это часть контракта
 * applyOps/invertOps: инверсию сырого {op:'create'} без id иначе нечем адресовать —
 * применение и инверсия выдали бы разные id. Фабрика ops.create делает то же раньше.
 * @param {object[]} list изменяется на месте
 */
function stampIds(list) {
  for (const op of list) {
    if (!op || typeof op !== 'object' || op.op !== 'create') continue;
    const n = op.node;
    if (!n || typeof n !== 'object' || n.id) continue;
    try {
      n.id = uid(n.type === 'frame' ? 'f' : 'n');
    } catch (_) {
      // операция заморожена — работаем как раньше, но предупреждаем: отмена будет неполной
      logOnce('stamp:frozen', 'create-операция заморожена, id не проставить — её отмена будет неполной');
    }
  }
}

/**
 * Иммутабельно применяет операции. Никогда не бросает.
 * @param {object} doc
 * @param {object[]} opList
 * @param {{checkExpand?:boolean}} [opts] круг 39: `checkExpand` (по умолчанию true) —
 *   сверять итог пачки с пределом раскрытия экземпляров (MAX_EXPANDED_NODES);
 *   false — только для переигрывания уже принятого (журнал — источник истины)
 * @returns {{doc: object, error?: {code:string, message:string, limit?:string}}} при ошибке возвращается исходный doc.
 *   Коды: not-found · protected-path · bad-node · bad-parent · cycle · bad-op;
 *   `error.limit` — нарушенный предел: 'depth' (вложенность), 'expand_nodes'
 *   (круг 39: раскрытие экземпляров больше MAX_EXPANDED_NODES узлов, см. expandCost)
 */
function applyOps(doc, opList, opts) {
  if (!doc || !doc.nodes) return { doc, error: opErr('not-found', 'нет документа') };
  const list = Array.isArray(opList) ? opList : opList ? [opList] : [];
  if (!list.length) return { doc };
  stampIds(list);   // id создаваемых узлов фиксируем до применения — их увидит invertOps
  const draft = openDraft(doc);
  // круг 39: пачка атомарна — предел раскрытия сверяется с её итогом; виноватой
  // называется последняя операция, которая могла раскрытие увеличить
  const guard = opts && opts.checkExpand === false ? null : expandGuard(doc, draft);
  let grewAt = -1;
  try {
    for (let i = 0; i < list.length; i++) {
      const plan = guard ? guard.pre(list[i]) : null;
      const err = applyOne(draft, list[i]);
      if (err) {
        logOnce('apply:' + err.message, `операция ${i} отклонена: ${err.message}`);
        return { doc, error: opErr(err.code, `операция ${i} (${shown(list[i] && list[i].op)}): ${err.message}`, err) };
      }
      if (plan && guard.post(plan, list[i])) grewAt = i;
    }
    const over = grewAt >= 0 ? guard.over() : null;
    if (over) {
      const err = expandErr(`операция ${grewAt} (${shown(list[grewAt] && list[grewAt].op)})`, over);
      logOnce('apply:expand', err.message);
      return { doc, error: err };
    }
  } catch (e) {
    // круг 16, п.8: наружу — человеческая строка. Сырой текст исключения из движка
    // доходил до экрана целиком («Converting circular structure to JSON --> star…»):
    // вход был вне контракта, но читать это человеку незачем — техническая часть
    // остаётся в консоли, в сообщении только то, что случилось с его правкой.
    logOnce('apply:throw', 'исключение при применении операций', e);
    return { doc, error: opErr('bad-op', 'правку не удалось применить: в операции негодное значение') };
  }
  draft.version = (doc.version || 0) + 1;
  return { doc: sealDraft(draft) };
}

/**
 * Круг 25: несколько пачек (транзакций журнала) подряд ОДНИМ черновиком — то же,
 * что для каждой пачки `collectTombstones(d, ops)` + `applyOps(d, ops)` (как DSLTS
 * поднимает голову из снимка и хвоста, а реплика догоняет журнал), но словарь
 * узлов копируется один раз на весь хвост, а не дважды на транзакцию: холодная
 * загрузка 50 транзакций на документе в 20 000 узлов — десятки мс вместо секунд.
 *
 * Пачка атомарна: не легла — откатывается целиком (results[i].error), документ как
 * до неё; надгробия её remove до места отказа всё равно в выходе — ровно как у
 * пары collectTombstones + applyOps. `version` растёт на 1 за каждую легшую пачку.
 * Единственное отличие от поштучного пути — порядок ключей `nodes` после отката
 * отказавшей пачки (на hashDoc не влияет).
 * @param {object} doc
 * @param {object[][]} batches
 * @returns {{doc: object, tombstones: [string, string|null][], results: ({error: {code:string,message:string}}|null)[]}}
 */
function applyBatches(doc, batches) {
  const all = Array.isArray(batches) ? batches : [];
  const tombstones = [];
  const results = [];
  if (!doc || !doc.nodes) {
    for (let b = 0; b < all.length; b++) results.push({ error: opErr('not-found', 'нет документа') });
    return { doc, tombstones, results };
  }
  const draft = openDraft(doc);
  const j = [];
  let applied = 0;
  for (let b = 0; b < all.length; b++) {
    const raw = all[b];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    stampIds(list);
    j.length = 0;
    let error = null;
    for (let i = 0; i < list.length && !error; i++) {
      const op = list[i];
      if (op && op.op === 'remove' && ownNode(draft.nodes, op.id)) {
        for (const id of subtreeIds(draft, op.id)) {
          const n = ownNode(draft.nodes, id);
          tombstones.push([id, n && n.parent ? n.parent : null]);
        }
      }
      let err;
      try {
        err = applyOne(draft, op, j);
      } catch (e) {
        logOnce('apply:throw', 'исключение при применении операций', e);
        err = opErr('bad-op', 'правку не удалось применить: в операции негодное значение');
      }
      if (err) error = opErr(err.code, `операция ${i} (${op && typeof op.op === 'string' ? op.op : '?'}): ${err.message}`, err);
    }
    if (error) {
      rollbackDraft(draft, j, 0);
      results.push({ error });
    } else {
      if (list.length) applied++;
      results.push(null);
    }
    j.length = 0;
  }
  if (applied) draft.version = (doc.version || 0) + applied;
  sealDraft(draft);
  return { doc: applied ? draft : doc, tombstones, results };
}

/**
 * Путь и прежнее значение для обратной операции set / setToken (SPEC §8.3,
 * круг 22): инверсия считается НА УРОВНЕ ПУТИ операции — `set id a.b.c` ↔
 * `set id a.b.c <было по этому пути>`. Раньше возвращалась голова пути целиком
 * (`set id layout = <весь старый объект>`), и отмена своего «gap» затирала чужой
 * «padding», записанный между правкой и отменой (дефект D1 ревью): на сервере
 * пересечение правок решается по листьям (LWW, §9.6), и отмена обязана быть
 * такой же узкой, как сама правка, — иначе она отменяет не своё.
 *
 * Шире листа — только там, где листовая запись не восстановила бы ФОРМУ:
 *   • по промежуточному сегменту до правки лежал не объект (скаляр, строка,
 *     отсутствие): setPath заменил его объектом, и обратно его вернёт лишь запись
 *     этого уровня целиком — `fill:'accent'` + `set fill.token` ↔ `set fill 'accent'`,
 *     а `set layout.gap` у фрейма без layout ↔ `set layout` без значения;
 *   • операция снимает ключ: лист вернул бы значение, но не его место среди
 *     соседей (порядок свотчей палитры после отмены «удалить accent»), поэтому
 *     возвращается объект, в котором ключ лежал.
 * Значение undefined = «ключа не было»: обратная операция без value снимает
 * лист (setPath с undefined удаляет ключ, а не пишет undefined).
 * @param {object} container узел или tokens ДО правки
 * @param {string} path путь операции
 * @param {any} opValue значение операции (undefined — снятие ключа)
 * @returns {{path:string, value:any}}
 */
function inversePoint(container, path, opValue) {
  const parts = textOf(path).split('.');
  let cur = container && typeof container === 'object' ? container : {};
  for (let i = 0; i < parts.length; i++) {
    /* Круг 31: элемента массива, которого до правки не было (запись в конец
       шкалы `spacing.13`), листовая отмена не вернёт: снятие ключа оставило бы
       массив той же длины с дырой (в JSON — null), а снятие шага шкалы и вовсе
       запрещено. Возвращаем массив целиком — длина и порядок те же, что до правки. */
    if (i > 0 && Array.isArray(cur) && !(INDEX_RE.test(parts[i]) && Number(parts[i]) < cur.length)) {
      return { path: parts.slice(0, i).join('.'), value: cur };
    }
    if (i === parts.length - 1) break;
    const next = cur[parts[i]];
    if (!next || typeof next !== 'object') return { path: parts.slice(0, i + 1).join('.'), value: next };
    cur = next;
  }
  const leaf = cur[parts[parts.length - 1]];
  if (opValue === undefined && leaf !== undefined && parts.length > 1) {
    return { path: parts.slice(0, -1).join('.'), value: cur };
  }
  return { path, value: leaf };
}

/** Инверсия одной операции относительно состояния до неё. @returns {object[]} */
function invertOne(doc, op) {
  switch (op && op.op) {
    case 'create': {
      const node = op.node;
      const id = node && node.id;
      if (!id) return [];
      // сначала возвращаем «усыновлённых» детей прежним родителям, потом убираем сам узел
      const host = nodeById(doc, node.parent);
      // место, которое займёт сам новый узел у своего родителя
      const hostSlot = host && Array.isArray(host.children)
        ? (isNum(op.index) ? clamp(Math.round(op.index), 0, host.children.length) : host.children.length)
        : -1;
      const moves = [];
      // места у родителей считаем по одному разу на родителя: «сгруппировать»
      // создаёт узел, усыновляя всё выделение, и indexOf на каждого ребёнка
      // давал квадрат — на «выделить всё» в большом документе это секунды
      const slots = new Map();
      const slotsOf = (parent) => {
        let idx = slots.get(parent.id);
        if (!idx) {
          idx = new Map();
          for (let i = 0; i < parent.children.length; i++) {
            if (!idx.has(parent.children[i])) idx.set(parent.children[i], i);
          }
          slots.set(parent.id, idx);
        }
        return idx;
      };
      for (const c of (Array.isArray(node.children) ? node.children : [])) {
        const child = nodeById(doc, c);
        if (!child) continue;
        const parent = nodeById(doc, child.parent);
        if (!parent || !Array.isArray(parent.children)) continue;
        const at = slotsOf(parent).has(c) ? slotsOf(parent).get(c) : -1;
        const index = at < 0 ? parent.children.length : at;
        // новый узел ещё стоит в списке, когда ребёнок возвращается — сдвигаем на него
        const shift = host && parent.id === host.id && hostSlot >= 0 && hostSlot <= index ? 1 : 0;
        moves.push({ id: c, parent: parent.id, index, insert: index + shift });
      }
      moves.sort((a, b) => a.index - b.index);
      return [...moves.map((m) => ops.move(m.id, m.parent, m.insert)), ops.remove(id)];
    }
    case 'remove': {
      const node = nodeById(doc, op.id);
      if (!node) return [];
      const ids = subtreeIds(doc, op.id);
      const out = [];
      // место каждого узла у родителя — по одному разу на родителя. indexOf на
      // каждый узел давал квадрат: инверсия удаления фрейма со ста тысячами
      // детей считалась 12 с, и всё это время интерфейс стоял
      const slots = new Map();
      const slotOf = (parent, nid) => {
        let idx = slots.get(parent.id);
        if (!idx) {
          idx = new Map();
          const kids = parent.children || [];
          for (let i = 0; i < kids.length; i++) if (!idx.has(kids[i])) idx.set(kids[i], i);
          slots.set(parent.id, idx);
        }
        const at = idx.get(nid);
        return at === undefined ? -1 : at;
      };
      for (const nid of ids) {
        const n = deepClone(nodeById(doc, nid));
        const parent = nodeById(doc, n.parent);
        // круг 27: место самого удаляемого — по индексу позиций черновика (родитель
        // бывает плоским на 19 000 детей, а remove в пачке — тысячи); места потомков —
        // по словарю на родителя внутри поддерева, как раньше
        const index = !parent ? undefined
          : nid === op.id && Array.isArray(parent.children) ? posOf(doc, parent.children, nid) : slotOf(parent, nid);
        // дети будут воссозданы своими операциями — создаём узел пустым
        // круг 31: мусор в children у не-контейнера (документ прежней версии)
        // отмена не возвращает — create его не примет; узел встаёт без поля
        const node2 = { ...n, children: n.children !== undefined && (Array.isArray(n.children) || CONTAINER_TYPES.has(n.type)) ? [] : undefined };
        if (node2.children === undefined) delete node2.children;
        const back = ops.create(node2, index);
        // круг 20: отмена возвращает узел ровно таким, каким он был, — и с
        // ссылкой на шаг, которого в шкале уже может не быть (см. applyOne/create)
        back.exact = true;
        out.push(back);
      }
      return out;
    }
    case 'set': {
      const node = nodeById(doc, op.id);
      if (!node) return [];
      // круг 22: на уровне пути операции; голова целиком — только когда лист не
      // восстановил бы форму (см. inversePoint). ops.set копирует значение сам
      const at = inversePoint(node, op.path, op.value);
      const back = ops.set(op.id, at.path, at.value);
      // Круг 16, п.1: отмена возвращает значение ровно тем, чем оно было, — включая
      // форму. Приведение формы (keepFieldForm) здесь молча оставило бы объект там,
      // где до правки лежала строка: `set fill.token='accent'` поверх fill:'accent'
      // делает {token:'accent'}, и обратная запись строки «совпала бы по смыслу».
      // Круг 20: то же для шкал — число поверх ссылки на равный шаг оставило бы
      // ссылку, а отмена обязана вернуть число, если до правки лежало число.
      back.exact = true;
      return [back];
    }
    case 'move': {
      const node = nodeById(doc, op.id);
      if (!node) return [];
      const parent = nodeById(doc, node.parent);
      const index = parent ? (Array.isArray(parent.children) ? posOf(doc, parent.children, op.id) : parent.children.indexOf(op.id)) : 0;
      return [ops.move(op.id, node.parent, index < 0 ? 0 : index)];
    }
    case 'setToken': {
      // круг 22: по пути операции — `setToken colors.accent` ↔ прежний accent, чужой
      // surface цел; группу целиком возвращает только отмена снятия ключа, чтобы
      // не съезжал порядок ключей палитры (см. inversePoint)
      const at = inversePoint(doc.tokens, op.path, op.value);
      return [ops.setToken(at.path, at.value)];
    }
    default:
      return [];
  }
}

/**
 * Операции отмены: инверсия каждой относительно состояния перед ней, в обратном порядке.
 * Как и applyOps, проставляет id создаваемым узлам прямо в переданных операциях,
 * поэтому порядок вызовов (сначала применить или сначала спросить отмену) не важен.
 * @param {object} doc состояние ДО применения ops
 * @param {object[]} opList
 * @returns {object[]}
 */
function invertOps(doc, opList) {
  const list = Array.isArray(opList) ? opList : opList ? [opList] : [];
  stampIds(list);   // инверсию могут спросить до применения — id должен быть тот же
  const chunks = [];
  if (!doc || !doc.nodes) return [];
  // круг 25: один черновик на пачку (см. openDraft) — инверсия каждой операции
  // считается по состоянию перед ней, как раньше, но без копии словаря на операцию
  const cur = openDraft(doc);
  const j = [];
  for (const op of list) {
    let back;
    try {
      back = invertOne(cur, op);
    } catch (e) {
      // вход вне контракта (кривые типы) — инверсия обрывается, как на не легшей операции
      logOnce('invert:throw', 'invertOps: исключение на операции, инверсия обрывается', e);
      break;
    }
    chunks.push(back);
    const err = applyStep(cur, op, j);
    if (err) {
      logOnce('invert:' + err.message, 'invertOps: операция не применилась, инверсия обрывается —', err.message);
      break;
    }
  }
  const out = [];
  // без spread: инверсия удаления фрейма — по create-операции на каждый узел
  // поддерева, и `out.push(...chunk)` на сотне тысяч узлов роняет стек
  // («Maximum call stack size exceeded») — вместе с возможностью отменить это
  // удаление. Порядок обратный: последнюю операцию отменяем первой
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    for (let j = 0; j < chunk.length; j++) out.push(chunk[j]);
  }
  return out;
}

/** Пределы одной транзакции по умолчанию для splitOps — те же, что у Document service (5000 операций, тело 4 МБ минус конверт). */
const SPLIT_MAX_OPS = 5000;
const SPLIT_MAX_BYTES = 3.5 * 1024 * 1024;

/** Длина строки в UTF-8 без выделения буфера (в браузере и в Node одинаково). */
function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * Круг 31 (K1): большая правка — несколькими транзакциями. Делит список операций
 * на ПОДРЯД идущие пачки не больше `maxOps` операций и `maxBytes` байт JSON
 * массива (UTF-8) каждая. Порядок операций не меняется: если весь список
 * применим (applyOps), то пачки, применённые одна за другой, применимы каждая
 * и дают тот же документ — операции и так ложатся по одной на состояние после
 * предыдущей. Инверсия удаления поддерева (invertOps) уже идёт сверху вниз —
 * create родителя раньше create детей, — и это свойство пачки сохраняют.
 * Перед делением create без id получают id (как в applyOps/invertOps): иначе
 * пачки и их инверсия выдали бы разные id.
 *
 * Операция, которая одна больше `maxBytes`, уходит отдельной пачкой — делить
 * её нечем; такую транзакцию сервис отклонит как too_large, а не молча.
 * @param {object[]} opList
 * @param {{maxOps?:number, maxBytes?:number}} [opts]
 * @returns {object[][]} пачки; пустой вход — пустой массив
 */
function splitOps(opList, opts) {
  const list = Array.isArray(opList) ? opList : opList ? [opList] : [];
  if (!list.length) return [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxOps = isNum(o.maxOps) && o.maxOps >= 1 ? Math.floor(o.maxOps) : SPLIT_MAX_OPS;
  const maxBytes = isNum(o.maxBytes) && o.maxBytes > 2 ? o.maxBytes : SPLIT_MAX_BYTES;
  stampIds(list);
  const out = [];
  let cur = [];
  let bytes = 2;   // «[» и «]»
  for (const op of list) {
    let size;
    try {
      const json = JSON.stringify(op);
      size = json === undefined ? 4 : utf8Length(json);   // undefined в массиве JSON — null
    } catch (_) {
      size = Infinity;   // не сериализуется (цикл) — отдельной пачкой, сервис скажет сам
    }
    const extra = cur.length ? size + 1 : size;   // запятая между элементами
    if (cur.length && (cur.length >= maxOps || bytes + extra > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 2;
    }
    bytes += cur.length ? size + 1 : size;
    cur.push(op);
  }
  if (cur.length) out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ *
 * 4b. Слияние транзакций (круг 22, SPEC §9.6)
 *
 * rebase(doc, ops, {tombstones}) — операции, построенные относительно более
 * старой базы, превращаются в применимые к голове. Не бросает, детерминирован;
 * после него строгий applyOps обязан пройти. Транзакция целиком не
 * отклоняется никогда: отдельная операция отбрасывается только по правилам
 * таблицы §9.6 — узел удалён (remove побеждает), повтор create, потерянный
 * родитель без живых предков, перемещение в цикл. Одна и та же функция
 * исполняется в DSLTS (перед записью) и на клиенте (view = replay(confirmed,
 * pending)) — поэтому клиент почти всегда угадывает, что сделает сервер.
 * ------------------------------------------------------------------ */

/** JSON с отсортированными ключами — для устойчивых хэшей. */
function stableJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJSON(value[k])).join(',') + '}';
}

/** Два независимых 32-битных счёта (FNV-1a + xxhash-подобный) → 64-битный ключ. */
function fnv64(s) {
  let h = 0x811c9dc5;
  let g = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h ^= c;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    g = Math.imul(g ^ c, 2246822519) >>> 0;
  }
  const hex = (v) => ('00000000' + v.toString(16)).slice(-8);
  return hex(h) + hex(g) + '-' + s.length.toString(36);
}

/**
 * Устойчивый хэш документа без геометрии: корень, узлы, токены. Порядок
 * ключей нормализуется, чтобы одинаковые документы, собранные разными путями
 * (переигрывание журнала, снимок, локальное применение), совпадали. `version`
 * и `meta` не участвуют: это счётчики и служебное, а не содержание.
 * @param {object} doc
 * @returns {string}
 */
function hashDoc(doc) {
  if (!doc || !doc.nodes) return '0';
  return fnv64(stableJSON({ root: doc.root, nodes: doc.nodes, tokens: doc.tokens }));
}

/* ------------------------------------------------------------------ *
 * Отпечаток формата (круг 43)
 *
 * Правило SPEC §8.3: формат документа и операций меняется ТОЛЬКО вместе с
 * ENGINE_VERSION — на нём стоит «запись, которую движок не принял, — наследная»
 * (DSLTS) и 426 для клиента другой версии. formatSignature() собирает из ТЕХ ЖЕ
 * таблиц, по которым идёт проверка (checkNode, fieldProblem, tokenWriteProblem,
 * applyOne, parsePath, checkImportDoc), всё, что решает «принять или отказать»:
 * типы узлов, поля и их ограничения по типам, вложенные ключи, перечисления,
 * группы токенов, операции, команды путей, пределы схемы. Тест сверяет хэш с
 * таблицей «версия движка → отпечаток»: формат изменился без подъёма версии —
 * тест падает и называет изменившиеся разделы.
 *
 * Не входят (не влияют на то, примет ли старый движок запись нового): тексты
 * сообщений, пороги замечаний validate (heavyCommands), пределы, которые журнал
 * не проверяет (MAX_EXPANDED_NODES — applyBatches его не сверяет), умолчания токенов.
 * ------------------------------------------------------------------ */

const sortedList = (it) => [...it].map(String).sort();

/**
 * Отпечаток формата по разделам — простые данные (без функций), порядок
 * перечислений не важен (отсортированы).
 * @returns {Record<string, any>}
 */
function formatSignature() {
  const rules = {};
  for (const k of Object.keys(FIELD_RULES)) {
    const r = FIELD_RULES[k];
    rules[k] = { ...(r.only ? { only: sortedList(r.only) } : {}), ...(r.not ? { not: sortedList(r.not) } : {}) };
  }
  const enums = {};
  for (const k of Object.keys(LAYOUT_ENUMS)) enums['layout.' + k] = sortedList(LAYOUT_ENUMS[k]);
  const vector = { ...VECTOR_LIMITS };
  delete vector.heavyCommands;
  return {
    nodes: { types: sortedList(NODE_TYPES), containers: sortedList(CONTAINER_TYPES), libraryRole: LIBRARY_ROLE },
    fields: { struct: sortedList(STRUCT_FIELDS), string: sortedList(STRING_FIELDS), bool: sortedList(BOOL_FIELDS), rules },
    enums: {
      ...enums, sizeModes: sortedList(SIZE_MODES), textAligns: sortedList(TEXT_ALIGNS), propKinds: sortedList(PROP_KINDS),
      fillRules: sortedList(FILL_RULES), lineCaps: sortedList(LINE_CAPS), lineJoins: sortedList(LINE_JOINS),
      gradientKinds: sortedList(GRADIENT_KINDS), patternKinds: sortedList(PATTERN_KINDS), patternKeys: PATTERN_KEYS.slice(), easings: sortedList(Object.keys(EASINGS)), motionFollow: sortedList(MOTION_FOLLOW),
      states: sortedList(STATE_NAMES)
    },
    keys: {
      textStyle: TEXT_STYLE_FIELDS, typeEntry: sortedList(TYPE_ENTRY_FIELDS), stroke: STROKE_FIELDS,
      layout: sortedList(LAYOUT_KEYS), padding: sortedList(PAD_KEYS), size: sortedList(SIZE_AXES), pos: sortedList(POS_AXES),
      viewBox: sortedList(VIEWBOX_KEYS), paint: sortedList(PAINT_WRAP_KEYS), gradient: sortedList(GRADIENT_KEYS),
      stop: sortedList(STOP_KEYS), vpath: sortedList(VPATH_KEYS), statePatch: sortedList(STATE_KEYS), motion: sortedList(MOTION_KEYS)
    },
    refs: { scale: SCALE_REF_RE.source, motion: MOTION_REF_RE.source, shadow: SHADOW_REF_RE.source, shadowLen: SHADOW_LEN_RE.source, shadowColor: SHADOW_COLOR_RE.source },
    tokens: { groups: sortedList(Object.keys(TOKEN_RULES)), scales: sortedList(Object.keys(SCALE_NAMES)), motionSteps: MOTION_STEPS.slice(), shadowSteps: SHADOW_STEPS.slice() },
    ops: sortedList(OP_NAMES),
    paths: { commands: { ...PATH_ARGS }, number: PATH_NUM_RE.source },
    limits: { maxSize: MAX_SIZE, maxDepth: MAX_DEPTH, plainDepth: PLAIN_DEPTH, rotate: ROTATE_LIMIT, instanceDepth: MAX_INSTANCE_DEPTH, vector, state: STATE_LIMITS, shadow: SHADOW_LIMITS,
      // круг 48: тема доски — пределы, ключи и поля стиля
      pattern: { ...PATTERN_LIMITS },
      theme: { ...THEME_LIMITS, keys: THEME_KEYS.slice(), typeFields: THEME_TYPE_FIELDS.slice(), name: THEME_NAME_RE.source, hex: THEME_HEX_RE.source } }
  };
}

/* ---------------------- поведенческий отпечаток (круг 45) ---------------------- *
 * Таблицы ловят новое поле, тип, значение перечисления. Изменение ВНУТРИ функции
 * проверки (opacity 0..1 → 0..2, pos без y, защищённый путь, любое значение
 * props, угол градиента) таблицы не меняет — его ловит корпус проб: фиксированный
 * детерминированный набор значений, прогнанный через НАСТОЯЩИЕ проверки
 * (fieldProblem, checkNode, tokenWriteProblem, parsePath, applyOps), и вектор
 * «принял/отказал» по семействам хэшируется в раздел `behavior`.
 *
 * Корпус строится из таблиц: каждое поле FIELD_RULES/STRING_FIELDS/BOOL_FIELDS
 * получает всю палитру на каждом типе узла (новое поле — пробы сами), каждый
 * ключ составных полей (pos, override, size, layout, padding, stroke, style,
 * краска, градиент, стоп, viewBox, контур, состояние, motion, пропс компонента) —
 * палитру, снятие и лишний ключ; числа палитры — плотная сетка плюс каждая граница
 * из таблиц пределов ± шаг. Плюс явный список особых проб (структура узла,
 * пути set, операции, пути SVG, токены).
 * ------------------------------------------------------------------------------- */

/** Числа палитры: сетка и границы из таблиц пределов (±0,001 и ±1). */
function probeNumbers() {
  const base = [0, 0.001, 0.01, 0.1, 0.5, 0.79, 0.8, 0.99, 0.999, 1, 1.001, 1.01, 1.2, 1.21, 1.5, 2, 3, 8, 10, 16, 23.99, 24, 24.01,
    100, 99.99, 100.01, 359, 359.99, 360, 360.01, 361, 600, 720, 899, 900, 901, 999, 1000, 1000.01, 1001, 2000, 2001, 1e5, 1e5 + 0.01, 1e6, 1e6 + 1, 1e9];
  const lim = [];
  const walk = (v) => {
    if (isNum(v)) lim.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.keys(v).sort().forEach((k) => walk(v[k]));
  };
  walk([MAX_SIZE, MAX_DEPTH, PLAIN_DEPTH, ROTATE_LIMIT, MAX_INSTANCE_DEPTH, STATE_LIMITS, TEXT_STYLE_FIELDS, STROKE_FIELDS, SHADOW_LIMITS]);
  const vec = { ...VECTOR_LIMITS };
  delete vec.heavyCommands;
  walk(vec);
  const out = new Set();
  for (const n of base.concat(lim)) for (const d of [0, 0.001, -0.001, 1, -1]) { out.add(n + d); out.add(-(n + d)); }
  return [...out].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/** Строки палитры: значения всех перечислений формата и особые строки. */
function probeStrings() {
  const set = new Set(['', 'x', 'bogus', 'accent', 'surface', '#000000', '#ff000080', '#fff', 'rgba(0,0,0,0.5)', 'red',
    'spacing.0', 'spacing.1', 'spacing.99', 'spacing.-1', 'radii.0', 'radii.1', 'radii.99', 'motion.fast', 'motion.bogus',
    'shadow.sm', 'shadow.xl', '0 1px 2px #000000', '0 1 2 rgba(0,0,0,0.5)', 'none', 'M0 0 L1 1', 'M0 0 Q', '10', '1e3', 'true',
    'm_probe', 'pm', 'pmt', 'pt', 'body', 'title']);
  for (const it of [NODE_TYPES, LAYOUT_MODES, ALIGNS, JUSTIFIES, SIZE_MODES, TEXT_ALIGNS, PROP_KINDS, FILL_RULES, LINE_CAPS, LINE_JOINS,
    GRADIENT_KINDS, Object.keys(EASINGS), MOTION_FOLLOW, STATE_NAMES, STATE_KEYS, MOTION_STEPS, SHADOW_STEPS, Object.keys(TOKEN_RULES)]) {
    for (const v of it) set.add(String(v));
  }
  /* Круг 45 (code-r45 Д3): строки на краях пределов длины и тени на краях пределов смещения и
     размытия — из таблиц (литерал внутри проверки граница не получает; поэтому он в таблице). */
  for (const n of [VECTOR_LIMITS.maxPathName, SHADOW_LIMITS.maxDesc]) for (const d of [-1, 0, 1]) set.add('x'.repeat(n + d));
  const { maxOffset: o, maxBlur: b } = SHADOW_LIMITS;
  for (const [dx, dy, bl] of [[o, 0, 0], [o + 1, 0, 0], [-o, 0, 0], [-o - 1, 0, 0], [0, o, 0], [0, o + 1, 0], [0, -o - 1, 0], [0, 0, b], [0, 0, b + 1], [0, 0, -1]]) {
    set.add(`${dx}px ${dy}px ${bl}px #000000`);
    set.add(`${dx} ${dy} ${bl} rgba(0,0,0,0.5)`);
  }
  return [...set].sort();
}

/** Составные значения палитры. */
function probeObjects() {
  const deep = (n) => { let o = 1; for (let i = 0; i < n; i++) o = { a: o }; return o; };
  const grad = { kind: 'linear', stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] };
  return [null, true, false, [], [0], ['x'], [0, 0, 0, 0], [1, 2], [{ d: 'M0 0 L1 1' }], {}, { x: 0 }, { y: 0 }, { x: 0, y: 0 },
    { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: -1 }, { w: 1, h: 1 }, { x: '1', y: 0 }, { mode: 'fixed', value: 10 }, { mode: 'hug' },
    { w: { mode: 'fixed', value: 10 }, h: { mode: 'hug' } }, { w: { mode: 'fill' } }, { color: '#000000' }, { token: 'accent' },
    { value: 'x' }, { color: 1 }, { gradient: grad }, { gradient: { ...grad, kind: 'conic' } }, { hover: { opacity: 0.5 } },
    // круг 49: фактура — годная, чужого вида, без цвета, с шагом вне пределов, с лишним ключом
    { pattern: { kind: 'dots', color: 'accent' } }, { pattern: { kind: 'stars', color: 'accent' } }, { pattern: { kind: 'grid' } },
    { pattern: { kind: 'lines', color: '#000000', size: 2 } }, { pattern: { kind: 'waves', color: 'text', bg: 'canvas', angle: 45, weight: 2, opacity: 0.5 } },
    { pattern: { kind: 'checks', color: 'text' }, x: 1 },
    { duration: 100 }, { name: 'K', props: [] }, { mode: 'row', gap: 8 }, { a: { b: 1 } }, deep(PLAIN_DEPTH - 1), deep(PLAIN_DEPTH + 1)];
}

let probeCache = null;

/** Палитра: строки, числа, составные; детерминированный порядок. */
function probePalette() {
  return probeStrings().concat(probeNumbers(), probeObjects());
}

/** Минимальный годный узел каждого типа (база для проб checkNode). */
function probeNode(type) {
  const sz = { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } };
  switch (type) {
    case 'page': return { id: 'p_page', type, children: [] };
    case 'frame': return { id: 'p_frame', type, parent: 'q', children: [], size: sz, layout: { mode: 'none' } };
    case 'text': return { id: 'p_text', type, parent: 'q', characters: 'a', size: sz };
    case 'instance': return { id: 'p_inst', type, parent: 'q', of: 'm_probe' };
    case 'vector': return { id: 'p_vec', type, parent: 'q', size: sz, viewBox: { w: 1, h: 1 }, paths: [] };
    default: return { id: 'p_' + type, type, parent: 'q', size: sz };
  }
}

/** Документ для проб через applyOps: свободная доска, текст, прямоугольник, вектор, мастер с пропсом, экземпляр. */
function probeDoc() {
  const d = createDoc('empty');
  const lib = libraryNode(d);
  const sz = { w: { mode: 'fixed', value: 100 }, h: { mode: 'fixed', value: 100 } };
  const r = applyOps(d, [
    { op: 'create', node: { type: 'frame', id: 'pb', parent: d.root, name: 'Доска', children: [], layout: { mode: 'none' }, size: sz, pos: { x: 0, y: 0 } } },
    { op: 'create', node: { type: 'text', id: 'pt', parent: 'pb', characters: 'т', pos: { x: 1, y: 1 }, size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'rect', id: 'pr', parent: 'pb', pos: { x: 2, y: 2 }, size: sz } },
    { op: 'create', node: { type: 'vector', id: 'pv', parent: 'pb', pos: { x: 3, y: 3 }, size: sz, viewBox: { w: 10, h: 10 }, paths: [{ d: 'M0 0 L1 1' }, { d: 'M1 1 L2 2' }] } },
    { op: 'create', node: { type: 'frame', id: 'pm', parent: lib.id, name: 'K', children: [], layout: { mode: 'column' }, size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'text', id: 'pmt', parent: 'pm', characters: 'k', size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } },
    { op: 'create', node: { type: 'rect', id: 'pmr', parent: 'pm', size: { w: { mode: 'fixed', value: 10 }, h: { mode: 'fixed', value: 10 } } } },
    /* круг 45 (arch-r45 Д1): пропсы ВСЕХ видов — проверка значения пропса (propValue) в корпусе */
    { op: 'set', id: 'pm', path: 'component', value: { name: 'K', props: [
      { name: 'p', kind: 'text', target: 'pmt', path: 'characters' },
      { name: 'e', kind: 'enum', target: 'pmr', path: 'fill', values: ['accent', 'surface'] },
      { name: 'c', kind: 'color', target: 'pmr', path: 'fill' },
      { name: 'n', kind: 'number', target: 'pmr', path: 'opacity' },
      { name: 'b', kind: 'bool', target: 'pmr', path: 'visible' }
    ] } },
    { op: 'create', node: { type: 'instance', id: 'pi', parent: 'pb', of: 'pm', pos: { x: 4, y: 4 } } }
  ], { checkExpand: false });
  if (r.error) throw new Error('probeDoc: ' + r.error.message);
  return r.doc;
}

/**
 * Прогон корпуса: семейство → строка «1/0» (принял/отказал) по пробам в
 * детерминированном порядке. Считается один раз на процесс (лениво).
 * @returns {Record<string,string>}
 */
function formatBehavior() {
  if (probeCache) return probeCache;
  logQuiet++;
  try {
    const pal = probePalette();
    const types = sortedList(NODE_TYPES);
    const fields = sortedList(new Set([...STRING_FIELDS, ...BOOL_FIELDS, ...Object.keys(FIELD_RULES), 'zz_unknown']));
    const out = {};
    const bit = (fn) => { try { return fn() ? '1' : '0'; } catch (_) { return 'x'; } };

    // 1. каждое поле × каждый тип × палитра: fieldProblem и checkNode
    let a = '';
    for (const t of types) {
      const base = probeNode(t);
      for (const k of fields) {
        for (const v of pal) {
          a += bit(() => fieldProblem({ id: 'p', type: t, parent: 'q', [k]: v }, k) === null);
          a += bit(() => checkNode({ ...base, [k]: v }, null, false) === null);
        }
      }
    }
    out.fields = a;

    // 2. ключи составных полей: палитра в каждый ключ, снятие ключа, лишний ключ
    const grad = (g) => ({ gradient: g });
    const stop1 = { at: 1, color: '#ffffff' };
    const families = [
      ['frame', 'pos', { x: 0, y: 0 }, POS_AXES],
      ['frame', 'override', { x: 0, y: 0, w: 1, h: 1 }, POS_AXES.concat(SIZE_AXES)],
      ['frame', 'size', { w: { mode: 'fixed', value: 1 }, h: { mode: 'hug' } }, SIZE_AXES],
      ['frame', 'size', { mode: 'fixed', value: 1 }, ['mode', 'value'], (o) => ({ w: o, h: { mode: 'hug' } })],
      ['frame', 'layout', { mode: 'row' }, LAYOUT_KEYS],
      ['frame', 'layout', { t: 0, r: 0, b: 0, l: 0 }, PAD_KEYS, (o) => ({ mode: 'row', padding: o })],
      ['rect', 'stroke', { color: '#000000', width: 1 }, Object.keys(STROKE_FIELDS)],
      ['text', 'style', {}, Object.keys(TEXT_STYLE_FIELDS)],
      ['rect', 'fill', { color: '#000000' }, PAINT_WRAP_KEYS.concat(['gradient'])],
      ['rect', 'fill', { kind: 'linear', angle: 0, stops: [{ at: 0, color: '#000000' }, stop1] }, [...GRADIENT_KEYS], grad],
      ['rect', 'fill', { at: 0, color: '#000000' }, [...STOP_KEYS], (o) => grad({ kind: 'linear', stops: [o, stop1] })],
      ['rect', 'fill', { kind: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: [{ at: 0, color: '#000000' }, stop1] }, ['cx', 'cy', 'r'], grad],
      ['vector', 'viewBox', { x: 0, y: 0, w: 1, h: 1 }, VIEWBOX_KEYS],
      ['vector', 'paths', { d: 'M0 0 L1 1' }, [...VPATH_KEYS], (o) => [o]],
      ['rect', 'states', {}, STATE_KEYS, (o) => ({ hover: o })],
      ['rect', 'states', { hover: { opacity: 0.5 } }, STATE_NAMES.concat(['bogus'])],
      ['rect', 'motion', {}, [...MOTION_KEYS]],
      ['frame', 'component', { name: 'p', kind: 'text', target: 't', path: 'characters' }, ['name', 'kind', 'target', 'path', 'values'], (o) => ({ name: 'K', props: [o] })],
      ['frame', 'component', { name: 'p', kind: 'enum', target: 't', path: 'fill', values: ['a'] }, ['values'], (o) => ({ name: 'K', props: [o] })],
      ['frame', 'component', { name: 'K', props: [] }, ['name', 'props']],
      ['instance', 'props', {}, ['p', 'zz']],
      ['instance', 'size', { w: { mode: 'fixed', value: 1 } }, SIZE_AXES]
    ];
    let b = '';
    for (const [t, field, base0, keys, wrap] of families) {
      const node = probeNode(t);
      const run = (o) => bit(() => checkNode({ ...node, [field]: wrap ? wrap(o) : o }, null, false) === null);
      b += run(base0);
      for (const k of keys) {
        const without = { ...base0 };
        delete without[k];
        b += run(without);
        for (const v of pal) b += run({ ...base0, [k]: v });
      }
      b += run({ ...base0, zz_unknown: 1 });
    }
    // счёт: стопов, контуров, длина пути
    for (const n of [0, 1, 2, VECTOR_LIMITS.maxStops, VECTOR_LIMITS.maxStops + 1]) {
      const stops = Array.from({ length: n }, (_, i) => ({ at: n > 1 ? i / (n - 1) : 0, color: '#000000' }));
      b += bit(() => checkNode({ ...probeNode('rect'), fill: { gradient: { kind: 'linear', stops } } }, null, false) === null);
    }
    for (const n of [0, 1, VECTOR_LIMITS.maxPaths, VECTOR_LIMITS.maxPaths + 1]) {
      b += bit(() => checkNode({ ...probeNode('vector'), paths: Array.from({ length: n }, () => ({ d: 'M0 0' })) }, null, false) === null);
    }
    for (const len of [VECTOR_LIMITS.maxD, VECTOR_LIMITS.maxD + 1]) {
      const d = ('M0 0' + ' L1 1'.repeat(Math.ceil(len / 5))).slice(0, len).replace(/[ L.]+$/, '').padEnd(len, ' ');
      b += bit(() => checkNode({ ...probeNode('vector'), paths: [{ d }] }, null, false) === null);
    }
    {
      const d = 'M0 0' + ' L1 1'.repeat(3990);
      const k = Math.ceil(VECTOR_LIMITS.maxTotalD / d.length);
      for (const n of [k - 1, k]) b += bit(() => checkNode({ ...probeNode('vector'), paths: Array.from({ length: n }, () => ({ d })) }, null, false) === null);
    }
    out.nested = b;

    // 3. структура узла (checkNode): особые пробы
    const nodeProbes = [
      { ...probeNode('instance'), children: [] }, { ...probeNode('instance'), children: ['a'] }, { ...probeNode('instance'), children: {} },
      { ...probeNode('instance'), of: 'p_inst' }, { ...probeNode('instance'), of: '' }, { ...probeNode('instance'), of: undefined },
      { ...probeNode('page'), parent: 'r' }, { ...probeNode('page'), parent: 'r', role: LIBRARY_ROLE }, { ...probeNode('page'), parent: 5, role: LIBRARY_ROLE },
      { ...probeNode('page'), parent: null }, { ...probeNode('page'), children: undefined },
      { ...probeNode('text'), children: [] }, { ...probeNode('text'), children: ['a'] }, { ...probeNode('rect'), children: {} },
      { ...probeNode('frame'), children: undefined }, { ...probeNode('frame'), children: [1] }, { ...probeNode('frame'), children: 'a' },
      { ...probeNode('frame'), parent: undefined }, { ...probeNode('frame'), parent: 5 }, { ...probeNode('frame'), id: '' },
      { ...probeNode('frame'), id: 'constructor' }, { ...probeNode('frame'), id: 5 }, { ...probeNode('frame'), type: 'bogus' },
      { ...probeNode('frame'), size: undefined }, { ...probeNode('text'), size: undefined }, { ...probeNode('vector'), size: undefined },
      { ...probeNode('vector'), viewBox: undefined }, { ...probeNode('vector'), paths: undefined }, { ...probeNode('text'), characters: undefined },
      { ...probeNode('frame'), layout: { mode: 'row', align: 'stretch', justify: 'between', gap: 'spacing.1', padding: { t: 'spacing.0' } } },
      { ...probeNode('frame'), layout: { mode: 'row', gap: 'radii.1' } }, { ...probeNode('frame'), radius: [0, 'radii.1', 2, 3] },
      { ...probeNode('frame'), radius: [0, 1, 2] }, { ...probeNode('frame'), radius: 'spacing.1' }
    ];
    for (const t of types) nodeProbes.push(probeNode(t));
    for (const pk of PROTO_KEYS) nodeProbes.push({ ...probeNode('frame'), [pk]: 1 });
    let c = '';
    for (const n of nodeProbes) c += bit(() => checkNode(n, null, false) === null);
    out.nodes = c;

    // 4. токены: каждая группа (и чужая) × пути × палитра
    let tk = '';
    const tokens = DEFAULT_TOKENS;
    const groups = sortedList(Object.keys(TOKEN_RULES)).concat(['zz_other']);
    const seconds = sortedList(new Set(['0', '1', '7', '99', '01', 'body', 'title', 'accent', 'bogus', ...MOTION_STEPS, ...SHADOW_STEPS]));
    const tpal = pal.concat([undefined]);
    for (const g of groups) {
      const paths = [[g]].concat(seconds.map((x) => [g, x]), Object.keys(TEXT_STYLE_FIELDS).map((k) => [g, 'body', k]), [[g, 'body', 'fontSize', 'x']]);
      for (const parts of paths) for (const v of tpal) tk += bit(() => tokenWriteProblem(parts, v, tokens) === null);
    }
    out.tokens = tk;

    // 5. пути SVG: по команде — меньше, ровно и больше аргументов; формы чисел; особые строки
    let ps = '';
    const dList = ['', ' ', 'M', 'M0', 'M0 0', 'm0 0', 'L0 0', 'M0 0 Z', 'M0 0 z m1 1', 'M0 0 Z 1 1', 'M0,0', 'M0,,0', 'M0 0,', 'M.5.5', 'M-.5-.5',
      'M1e3 1E-3', 'M1e 3', 'M+1 +1', 'M1. 1.', 'M0 0 A1 1 0 1 1 2 2', 'M0 0 A1 1 0 11 2 2', 'M0 0 A1 1 0 2 1 2 2', 'M0 0 X1 1', 'M0 0 L1 1 2 2',
      `M${VECTOR_LIMITS.maxCoord} 0`, `M${VECTOR_LIMITS.maxCoord + 1} 0`, `M0 0 l${VECTOR_LIMITS.maxCoord} 0 l${VECTOR_LIMITS.maxCoord} 0 l${VECTOR_LIMITS.maxCoord} 0`, 'M0 0 L1 NaN', 'M0 0 L1 Infinity'];
    for (const c0 of Object.keys(PATH_ARGS).sort()) {
      const n = PATH_ARGS[c0];
      for (const cc of [c0, c0.toLowerCase()]) {
        for (const m of [n - 1, n, n + 1, 2 * n]) {
          if (m < 0) continue;
          const args = Array.from({ length: m }, (_, i) => (c0 === 'A' && (i % 7 === 3 || i % 7 === 4) ? '1' : String(i + 1)));
          dList.push(`M0 0 ${cc}${args.join(' ')}`);
        }
      }
    }
    for (const d of dList) ps += bit(() => parsePath(d).ok);
    out.svg = ps;

    // 5а. круг 48: тема доски — форма поля и разрешение токенов узла доски (сначала тема, затем документ)
    let th = '';
    const themes = [undefined, null, 1, 'x', [], {}, { colors: {} }, { type: {} }, { bogus: {} },
      { colors: { accent: '#abc' } }, { colors: { accent: '#aabbcc' } }, { colors: { accent: '#aabbccdd' } }, { colors: { accent: 'red' } },
      { colors: { accent: 'accent' } }, { colors: { '1a': '#000' } }, { colors: { constructor: '#000' } }, { colors: { brandNew: '#123456' } },
      { colors: Object.fromEntries(Array.from({ length: THEME_LIMITS.colors + 1 }, (_, i) => ['c' + i, '#000'])) },
      { type: { body: { font: 'Prata' } } }, { type: { body: { font: '' } } }, { type: { body: { font: 'x'.repeat(THEME_LIMITS.font + 1) } } },
      { type: { body: { fontWeight: 700 } } }, { type: { body: { fontWeight: 950 } } }, { type: { body: { fontSize: 20 } } },
      { type: { body: 'Prata' } }, { type: { fresh: { font: 'Prata' } } }];
    for (const v of themes) th += bit(() => themeProblem(v) === null);
    const tdocBase = { root: 'r', nodes: { r: { id: 'r', type: 'page', parent: null, children: ['b', 'f'] } }, tokens: DEFAULT_TOKENS };
    for (const v of themes) {
      const b = { id: 'b', type: 'frame', parent: 'r', children: ['n'], theme: v };
      const nn = { id: 'n', type: 'text', parent: 'b', characters: 'a', style: 'display' };
      const d0 = { ...tdocBase, nodes: { ...tdocBase.nodes, b, n: nn, f: { id: 'f', type: 'frame', parent: 'r', children: [] } } };
      // бит — «тема подействовала»: свой цвет, новое имя, шрифт стиля, соседняя доска не задета
      const d1 = () => docAt(d0, 'n');
      const dflt = DEFAULT_TOKENS.colors;
      th += bit(() => resolveColor(d1(), 'accent') !== dflt.accent.toLowerCase());
      th += bit(() => resolveColor(d1(), 'brandNew') !== null);
      th += bit(() => resolveColor(d1(), 'text') !== dflt.text.toLowerCase());
      th += bit(() => resolveTextStyle(d1(), nn).font !== DEFAULT_TOKENS.type.display.font);
      th += bit(() => resolveTextStyle(d1(), { ...nn, style: 'body' }).font !== DEFAULT_TOKENS.type.body.font);
      th += bit(() => resolveTextStyle(d1(), { ...nn, style: 'body' }).fontWeight !== DEFAULT_TOKENS.type.body.fontWeight);
      th += bit(() => resolveColor(docAt(d0, 'f'), 'accent') !== dflt.accent.toLowerCase());
      // тема на фрейме внутри доски не действует; раскладка меряет шрифтом темы
      const nd = { ...d0, nodes: { ...d0.nodes, b: { ...b, theme: undefined, children: ['g'] }, g: { id: 'g', type: 'frame', parent: 'b', children: ['n'], theme: v }, n: { ...nn, parent: 'g' } } };
      th += bit(() => docAt(nd, 'n') !== nd);
      th += bit(() => {
        const sd = { ...d0, nodes: { ...d0.nodes, n: { ...nn, size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } } };
        const g = solve(sd, { measureText: (t, st) => String(t).length * (st.font === DEFAULT_TOKENS.type.display.font ? 10 : 7) });
        return g.rects.n && g.rects.n.w !== 10;
      });
    }
    out.theme = th;

    // 6. настоящие операции (applyOps): пути set, операции, создание, перемещение
    const doc = probeDoc();
    let op = '';
    /* Круг 45 (arch-r45 Д1): кроме «принял/отказал» — и ЧТО получилось: отпечаток документа после
       каждой принятой пробы (семейство `results`). Иначе изменение семантики применения (индекс
       `create` через floor вместо round, иное приведение значения), принимаемое обоими, проходило
       мимо отпечатка, и экземпляры одной версии строили из одного журнала разные документы.
       Хэшируются хранимые `nodes` и `tokens`; раскрытие экземпляров (propValue при показе) в них не
       входит — оно не хранится и журналом не переигрывается (критик кода r45b R2). */
    let res = '';
    const rootId = doc.root;
    const libId = libraryNode(doc).id;
    const tryOps = (list, base = doc) => bit(() => {
      const r = applyOps(base, deepClone(list));
      if (r.error) return false;
      // id корня и библиотеки у документа-пробы случайны (createDoc) — в отпечаток идут именами
      res += fnv64(stableJSON({ nodes: r.doc.nodes, tokens: r.doc.tokens }).split(rootId).join('ROOT').split(libId).join('LIB')).slice(0, 6);
      return true;
    });
    const pathCands = sortedList(new Set([...PROTECTED_PATHS, ...UNSAFE_KEYS, ...PROTO_KEYS, 'name', 'a.b', 'a..b', '.a', 'a.', '',
      'layout.__proto__', 'layout.prototype', 'layout.constructor', 'props.toString', 'props.p', 'props.zz', 'paths.0.d', 'paths.1', 'paths.2',
      'paths.5', 'paths.-1', 'paths.01', 'paths.length', 'paths.0.fill', 'size.w.value', 'pos.x', 'pos.z', 'states.hover.opacity',
      'component.name', 'component.props.0.name', 'of', 'characters', 'style.fontSize', 'layout.padding.t', 'viewBox.w']));
    const setProbes = [];   // те же пробы — ещё раз с exact (семейство exact)
    for (const id of ['pb', 'pt', 'pr', 'pv', 'pm', 'pi']) {
      for (const path of pathCands) for (const v of [1, 'x', 0.5, { x: 1, y: 1 }, undefined]) { const l = [{ op: 'set', id, path, value: v }]; setProbes.push(l); op += tryOps(l); }
    }
    // каждое поле таблиц через set на каждом узле — короткая палитра (applyOps: keepFieldForm, checkNode, черновик)
    const short = [null, true, 'x', '#000000', -1, 0, 0.5, 1, 1.5, 2, 361, 1e9, [], {}, { x: 1 }, { x: 1, y: 1 }, undefined];
    for (const id of ['pb', 'pt', 'pr', 'pv', 'pi']) {
      for (const k of fields) for (const v of short) { const l = [{ op: 'set', id, path: k, value: v }]; setProbes.push(l); op += tryOps(l); }
    }
    const sz = { w: { mode: 'fixed', value: 5 }, h: { mode: 'fixed', value: 5 } };
    const opProbes = [
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pb', size: sz } }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pt', size: sz } }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pi', size: sz } }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pr', size: sz } }],
      [{ op: 'create', node: { type: 'rect', id: 'pt', parent: 'pb', size: sz } }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'nope', size: sz } }],
      [{ op: 'create', node: { type: 'page', id: 'n1', children: [] } }],
      [{ op: 'create', node: { type: 'frame', id: 'n1', parent: 'pb', children: ['pt'], size: sz } }],
      [{ op: 'create', node: { type: 'frame', id: 'n1', parent: 'pb', children: ['nope'], size: sz } }],
      [{ op: 'create', node: { type: 'instance', id: 'n1', parent: 'pb', of: 'pm' } }],
      [{ op: 'create', node: { type: 'instance', id: 'n1', parent: 'pm', of: 'pm' } }],
      [{ op: 'create', node: { type: 'instance', id: 'n1', parent: 'pb', of: 'pr' } }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pb', size: sz }, index: 0 }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pb', size: sz }, index: -1 }],
      [{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pb', size: sz }, index: 99 }],
      [{ op: 'remove', id: 'pt' }], [{ op: 'remove', id: 'nope' }], [{ op: 'remove', id: doc.root }], [{ op: 'remove', id: libraryNode(doc).id }],
      [{ op: 'move', id: 'pt', parent: 'pb', index: 0 }], [{ op: 'move', id: 'pb', parent: 'pt' }], [{ op: 'move', id: 'pt', parent: 'pr' }],
      [{ op: 'move', id: 'pb', parent: 'pb' }], [{ op: 'move', id: 'pt', parent: 'pi' }], [{ op: 'move', id: 'pt', parent: 'pm' }],
      [{ op: 'move', id: doc.root, parent: 'pb' }], [{ op: 'move', id: 'pt', parent: 'pb', index: 'a' }],
      [{ op: 'setToken', path: 'colors.accent', value: '#000000' }], [{ op: 'setToken', path: 'colors', value: 'x' }],
      [{ op: 'setToken', path: '', value: 1 }], [{ op: 'setToken', path: '__proto__.x', value: 1 }], [{ op: 'setToken', path: 'spacing.0', value: 4 }],
      [{ op: 'set', id: 'pm', path: 'component', value: { name: 'K', props: [{ name: 'q', kind: 'text', target: 'pt', path: 'characters' }] } }],
      [{ op: 'set', id: 'pm', path: 'component', value: { name: 'K', props: [{ name: 'q', kind: 'text', target: 'pmt', path: 'id' }] } }],
      [{ op: 'set', id: 'pi', path: 'of', value: 'pi' }], [{ op: 'set', id: 'pi', path: 'of', value: 'nope' }],
      [{ op: 'set', id: 'pb', path: 'layout', value: { mode: 'row', gap: 'spacing.99' } }], [{ op: 'set', id: 'pb', path: 'radius', value: 'radii.99' }]
    ];
    for (const name of sortedList(new Set([...OP_NAMES, 'copy', '', 'SET', 'delete', 'toString']))) {
      opProbes.push([{ op: name, id: 'pt', path: 'name', value: 'x', parent: 'pb', index: 0, node: { type: 'rect', id: 'n2', parent: 'pb', size: sz } }]);
    }
    // круг 45 (code-r45 Д3): путь пропса компонента — те же кандидаты, что у set (ключи прототипа в середине, пустые сегменты)
    for (const path of pathCands.concat(['a.__proto__.b', 'a.prototype', 'a..b', 'fill.', '.fill', 'style.constructor.x'])) {
      opProbes.push([{ op: 'set', id: 'pm', path: 'component', value: { name: 'K', props: [{ name: 'q', kind: 'text', target: 'pmt', path }] } }]);
    }
    // круг 45: значения пропсов экземпляра по видам; дробные и крайние индексы create/move
    const propVals = short.concat(['a', 'accent', 'surface', 'bogus', '#ff0000', { token: 'accent' }, { color: '#000000' }, false, 'true', '1']);
    for (const name of ['p', 'e', 'c', 'n', 'b', 'zz']) for (const v of propVals) opProbes.push([{ op: 'set', id: 'pi', path: 'props.' + name, value: v }]);
    for (const index of [0.4, 0.5, 0.6, 1.5, -0.5, 2.5, 3, 4, -2, 1e9, NaN, '1']) {
      opProbes.push([{ op: 'create', node: { type: 'rect', id: 'n1', parent: 'pb', size: sz }, index }]);
      opProbes.push([{ op: 'move', id: 'pr', parent: 'pb', index }]);
    }
    for (const list of opProbes) op += tryOps(list);
    out.ops = op;

    /* Круг 45, проход 2 (arch-r45b Д1′): «одетые» поля — объект и ссылки на шкалы. На голых узлах
       пробы ветви keepFieldForm (строка поверх объекта, число поверх ссылки радиуса, отступа,
       зазора, подъёма) не исполнялись: правка «сохранения формы» проходила мимо отпечатка. Узлы
       создаются в той же пачке, что и правка: документ-проба и прежние пробы не меняются. */
    let dr = '';
    const dressed = [
      { op: 'create', node: { type: 'frame', id: 'nd', parent: 'pb', children: [], size: sz, stroke: { color: 'accent', width: 3 },
        fill: { token: 'surface', opacity: 0.5 }, radius: 'radii.2', states: { hover: { lift: 'spacing.1' } },
        layout: { mode: 'column', gap: 'spacing.4', padding: { t: 'spacing.2', r: 'spacing.2', b: 'spacing.2', l: 'spacing.2' } } } },
      { op: 'create', node: { type: 'frame', id: 'nq', parent: 'pb', children: [], size: sz, stroke: 'accent', fill: 'surface',
        radius: ['radii.1', 'radii.1', 'radii.2', 'radii.2'], layout: { mode: 'row', gap: 8, padding: 'spacing.2' } } },
      { op: 'create', node: { type: 'text', id: 'nt', parent: 'nd', characters: 'т', style: { token: 'body', fontSize: 20 }, color: { token: 'text' },
        size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } },
      // скругление другой длины, чем у присланного массива: поэлементно — только при равной длине
      { op: 'create', node: { type: 'rect', id: 'nr', parent: 'pb', size: sz, radius: ['radii.1', 'radii.1'] } }
    ];
    const dressedSets = [
      ['stroke', ['accent', 'line', { color: 'accent' }, { color: 'accent', width: 1 }, { token: 'accent' }]],
      ['fill', ['surface', 'accent', { token: 'surface' }, { color: 'surface' }, { value: 'surface' }]],
      ['color', ['text', { token: 'text' }, 'muted']],
      ['style', ['body', { token: 'body' }, 'title']],
      ['radius', [0, 4, 8, 12, 'radii.2', 'radii.99', -1, [4, 4], [4, 20], [4, 4, 20, 20], [4, 4, 8, 8], [4, 4, 8, 9], [8, 8, 8, 8]]],
      ['layout', [{ mode: 'column', gap: 4 }, { mode: 'column', gap: 8, padding: 4 }, { mode: 'column', gap: 6, padding: { t: 4, r: 2 } }]],
      ['layout.gap', [4, 8, 6, 'spacing.3', 'spacing.99', -1]], ['layout.padding', [4, 8, { t: 4 }, [4, 2], [4, 2, 4, 2]]], ['layout.padding.t', [4, 6]],
      ['states', [{ hover: { lift: 2 } }, { hover: { lift: 4, opacity: 0.9 } }]], ['states.hover', [{ lift: 2 }, { lift: 6 }]], ['states.hover.lift', [2, 4]]
    ];
    for (const id of ['nd', 'nq', 'nt', 'nr']) {
      for (const [path, vals] of dressedSets) for (const value of vals) dr += tryOps([...dressed, { op: 'set', id, path, value }]);
    }
    out.dressed = dr;

    /* Круг 45, проход 3 (arch-r45c Д1″): операции отмены (`exact: true`, invertOps) лежат в журнале и
       переигрываются экземплярами — их ветви (без сохранения формы, мягкая проверка узла, мёртвые
       ссылки шкал) тоже в отпечатке. Те же «одетые» правки и пробы set с exact, плюс create с exact. */
    let ex = '';
    for (const id of ['nd', 'nq', 'nt', 'nr']) {
      for (const [path, vals] of dressedSets) for (const value of vals) ex += tryOps([...dressed, { op: 'set', id, path, value, exact: true }]);
    }
    for (const id of ['pb', 'pt', 'pr', 'pi']) {
      for (const path of ['radius', 'layout', 'layout.gap', 'states.hover.lift', 'props.n', 'props.e', 'of', 'name']) {
        for (const v of ['radii.99', 'spacing.99', { mode: 'row', gap: 'spacing.99' }, { hover: { lift: 'spacing.99' } }, 'nope', 2, 'bogus']) {
          ex += tryOps([{ op: 'set', id, path, value: v, exact: true }]);
        }
      }
    }
    const exactCreates = [
      { type: 'rect', id: 'n1', parent: 'pb', size: sz, radius: 'radii.99' },
      { type: 'frame', id: 'n1', parent: 'pb', children: [], size: sz, layout: { mode: 'row', gap: 'spacing.99', padding: { t: 'spacing.99' } } },
      { type: 'frame', id: 'n1', parent: 'pb', children: [], size: sz, states: { hover: { lift: 'spacing.99' } } },
      { type: 'instance', id: 'n1', parent: 'pb', of: 'pm', props: { n: 2, e: 'bogus', zz: 1 } },
      { type: 'instance', id: 'n1', parent: 'pb', of: 'nope' },
      { type: 'frame', id: 'n1', parent: libId, children: [], size: sz, component: { name: 'Z', props: [{ name: 'q', kind: 'text', target: 'n2', path: 'characters' }] } },
      { type: 'rect', id: 'n1', parent: 'pb', size: sz, stroke: { color: 'bogus', width: 3 }, fill: { token: 'nope' } },
      { type: 'rect', id: 'n1', parent: 'nope', size: sz }
    ];
    for (const node of exactCreates) {
      ex += tryOps([{ op: 'create', node, exact: true }]);
      ex += tryOps([{ op: 'create', node }]);
    }
    /* Проход 4 (arch-r45d Д1‴): не выборочно, а ВСЕ пробы set и операций корпуса `ops` — ещё раз с
       exact (мягкая проверка узла в set, ветвь withoutBadFields); и узлы, которые уже негодны до
       правки: цель пропса вынесена из мастера (move его не перепроверяет), поле прежней формы. */
    const withExact = (list) => list.map((o) => (o && typeof o === 'object' ? { ...o, exact: true } : o));
    for (const list of setProbes) ex += tryOps(withExact(list));
    for (const list of opProbes) ex += tryOps(withExact(list));
    const broken = [
      { op: 'create', node: { type: 'frame', id: 'nm', parent: libId, name: 'M', children: [], size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } },
      { op: 'create', node: { type: 'text', id: 'nmt', parent: 'nm', characters: 'x', size: { w: { mode: 'hug' }, h: { mode: 'hug' } } } },
      { op: 'set', id: 'nm', path: 'component', value: { name: 'M', props: [{ name: 'label', kind: 'text', target: 'nmt', path: 'characters' }] } },
      { op: 'move', id: 'nmt', parent: 'pb', index: 0 }
    ];
    const brokenSets = [
      ['nm', 'component', { name: 'M', props: [{ name: 'title', kind: 'text', target: 'nmt', path: 'characters' }] }],
      ['nm', 'component', { name: 'M', props: [] }],
      ['nm', 'component', { name: 'M2', props: [{ name: 'label', kind: 'text', target: 'nmt', path: 'characters' }] }],
      ['nm', 'name', 'M3'], ['nm', 'clip', true], ['nm', 'opacity', 0.5], ['nm', 'opacity', 2]
    ];
    for (const [id, path, value] of brokenSets) {
      ex += tryOps([...broken, { op: 'set', id, path, value }]);
      ex += tryOps([...broken, { op: 'set', id, path, value, exact: true }]);
    }
    /* поля прежней формы у узла (документ прежних кругов: `clip: 1`, объект в style.token — операцией
       их уже не положить, кладём прямо в копию документа-пробы) — правка соседнего поля с exact и без
       (ветвь withoutBadFields) */
    const legacyDoc = deepClone(doc);
    Object.assign(legacyDoc.nodes.pr, { clip: 1, radius: 'radii.99' });
    Object.assign(legacyDoc.nodes.pt, { style: { token: { x: 1 } } });
    for (const id of ['pr', 'pt']) {
      for (const [path, value] of [['name', 'z'], ['opacity', 0.5], ['clip', true], ['clip', 2], ['radius', 4], ['fill', 'accent'], ['opacity', 3], ['style', 'body'], ['characters', 'y']]) {
        ex += tryOps([{ op: 'set', id, path, value }], legacyDoc);
        ex += tryOps([{ op: 'set', id, path, value, exact: true }], legacyDoc);
      }
    }
    /* Проход 5 (arch-r45e): оба условия разом — мастер с целью пропса вне себя (строгая проверка его
       отвергает) и с полем прежней формы. Ветвь «проба без негодных полей» и «прежняя причина» мягкие
       только при exact — правка с exact и без. */
    const rb = applyOps(doc, deepClone(broken));
    if (!rb.error) {
      const comboDoc = deepClone(rb.doc);
      Object.assign(comboDoc.nodes.nm, { clip: 1, opacity: 7 });
      for (const [path, value] of [['name', 'M4'], ['clip', true], ['opacity', 0.5], ['opacity', 3], ['visible', false],
        ['component', { name: 'M', props: [{ name: 'title', kind: 'text', target: 'nmt', path: 'characters' }] }]]) {
        ex += tryOps([{ op: 'set', id: 'nm', path, value }], comboDoc);
        ex += tryOps([{ op: 'set', id: 'nm', path, value, exact: true }], comboDoc);
      }
      /* и причина не по полю (висячий parent, вектор без viewBox — сырой документ: на сервере createDoc
         такие узлы чинит до движка, проба держит ветвь на любом входе ядра): прежний узел негоден
         и мягко, и строго, но по-разному — ветвь «прежняя причина» зависит от строгости (код r45f) */
      // и вектор прежних кругов без viewBox; каждый — с полем прежней формы и без
      for (const bad of [(n) => { n.parent = 'ghost'; }, (n) => { n.parent = 'ghost'; n.clip = 1; },
        (n) => { n.type = 'vector'; delete n.children; n.paths = []; n.clip = 1; }]) {
        const ghostDoc = deepClone(rb.doc);
        bad(ghostDoc.nodes.nm);
        for (const [path, value] of [['name', 'M5'], ['clip', true], ['opacity', 0.5],
          ['component', { name: 'M', props: [{ name: 'title', kind: 'text', target: 'nmt', path: 'characters' }] }]]) {
          ex += tryOps([{ op: 'set', id: 'nm', path, value }], ghostDoc);
          ex += tryOps([{ op: 'set', id: 'nm', path, value, exact: true }], ghostDoc);
        }
      }
    } else ex += 'x';
    out.exact = ex;
    out.results = res;
    probeCache = out;
    return out;
  } finally {
    logQuiet--;
  }
}

/**
 * Хэш отпечатка: целиком и по разделам (по разделам — чтобы тест назвал, ЧТО
 * изменилось); `behavior.<семейство>` — корпус проб (formatBehavior). Считается
 * лениво при первом обращении: корпус — десятки тысяч проверок, загрузке модуля
 * они ни к чему.
 */
let formatSigCache = null;
function formatSignatureHash() {
  if (formatSigCache) return formatSigCache;
  const sig = formatSignature();
  const sections = {};
  for (const k of Object.keys(sig).sort()) sections[k] = fnv64(stableJSON(sig[k]));
  const beh = formatBehavior();
  for (const k of Object.keys(beh).sort()) sections['behavior.' + k] = fnv64(beh[k]);
  formatSigCache = Object.freeze({ hash: fnv64(stableJSON(sections)), sections: Object.freeze(sections) });
  return formatSigCache;
}
const FORMAT_SIGNATURE = Object.freeze({
  get hash() { return formatSignatureHash().hash; },
  get sections() { return formatSignatureHash().sections; },
  toJSON() { return formatSignatureHash(); }
});

/* Надгробия (круг 27, I1). Внутри core — словарь id удалённого узла → его
   последний родитель (Map или объект). В снимке — один из форматов:
   • v1 — плоский объект `{<id>: <parentId|null>}` (круги 25–26);
   • v2 — `{v:2, parents:{<id>:<parent>}, seq:{<id>:<seq удаления>}}`;
   • null/undefined — «неизвестно» (снимок записан экземпляром прежней версии):
     надгробия восстанавливает сервер (ближайший снимок с надгробиями + remove журнала).
   Номер удаления нужен прореживанию (pruneTombstones): надгробие старше окна
   переигрывания больше никому не понадобится, а словарь иначе растёт вечно. */

/** Объект `parents` из v2/нормализованной формы: признак — поле-объект (у v1 значения — строки/null). */
function tombParentsOf(src) {
  if (!src || typeof src !== 'object' || src instanceof Map || Array.isArray(src)) return null;
  if (src.v === 2 || (src.parents && typeof src.parents === 'object')) return src.parents && typeof src.parents === 'object' ? src.parents : {};
  return null;
}

/** Надгробия как Map: id удалённого узла → его последний родитель (или null). Принимает Map, v1, v2 и {parents, seq}. */
function toTombMap(src) {
  if (src instanceof Map) return src;
  const v2 = tombParentsOf(src);
  if (v2) return v2 instanceof Map ? v2 : toTombMap(v2);
  const m = new Map();
  if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) if (isNodeId(k)) m.set(k, src[k] === undefined ? null : src[k]);
  }
  return m;
}

/** Номер журнала: целое ≥ 0 (из jsonb — число; строка цифр — тоже). Иначе undefined. */
function tombSeq(v) {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Пары [id, parent] из Map или объекта (только годные id; родитель — id или null). */
function tombEntries(src) {
  const out = [];
  if (src instanceof Map) {
    for (const [id, p] of src) if (isNodeId(id)) out.push([id, isNodeId(p) ? p : null]);
  } else if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const id of Object.keys(src)) if (isNodeId(id)) out.push([id, isNodeId(src[id]) ? src[id] : null]);
  }
  return out;
}

/** Номер из Map или объекта номеров. */
function tombSeqOf(seqs, id) {
  if (seqs instanceof Map) return tombSeq(seqs.get(id));
  if (seqs && typeof seqs === 'object' && hasOwnProp.call(seqs, id)) return tombSeq(seqs[id]);
  return undefined;
}

/**
 * Надгробия снимка в любом формате → `{parents, seq}` (простые объекты) или
 * `null` — «неизвестно» (null/undefined на входе, неизвестная версия `v`,
 * негодный v2). Принимает v1, v2, уже нормализованную форму, Map и массив пар
 * `[id, parent, seq?]` (выход collectTombstones). Годятся только id-строки, не
 * ключи прототипа; родитель не-id → null; номер — целое ≥ 0.
 * @param {any} x
 * @param {{seq?: number}} [opts] `seq` — номер для записей без номера (v1, Map, пары)
 * @returns {{parents: Record<string, string|null>, seq: Record<string, number>}|null}
 */
function normalizeTombstones(x, opts) {
  if (x === null || x === undefined) return null;
  const fallback = tombSeq(opts && opts.seq);
  const parents = {};
  const seq = {};
  const put = (id, p, s) => {
    parents[id] = p;
    const n = s !== undefined ? s : fallback;
    if (n !== undefined) seq[id] = n;
    else delete seq[id];
  };
  if (Array.isArray(x)) {
    for (const e of x) {
      if (!Array.isArray(e) || !isNodeId(e[0])) continue;
      put(e[0], isNodeId(e[1]) ? e[1] : null, tombSeq(e[2]));
    }
    return { parents, seq };
  }
  if (x instanceof Map) {
    for (const [id, p] of tombEntries(x)) put(id, p, undefined);
    return { parents, seq };
  }
  if (typeof x !== 'object') return null;
  if (typeof x.v === 'number' && x.v !== 2) return null;   // формат, которого этот экземпляр не знает
  if (x.v === 2 || (x.parents && typeof x.parents === 'object')) {
    const ps = x.parents;
    if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return null;
    const ss = x.seq && typeof x.seq === 'object' && !Array.isArray(x.seq) ? x.seq : null;
    for (const [id, p] of tombEntries(ps)) put(id, p, tombSeqOf(ss, id));
    return { parents, seq };
  }
  for (const [id, p] of tombEntries(x)) put(id, p, undefined);
  return { parents, seq };
}

/**
 * Прореживание надгробий: остаются те, чей номер удаления ≥ `minSeq`, и не больше
 * `max` самых свежих (при равных номерах — позже записанные). Запись без номера
 * считается самой старой (номер 0): она из снимка прежней версии. Порядок
 * оставшихся — как на входе. Вход не меняется.
 * Последствие (SPEC, круг 27): `create` в давно удалённого родителя после
 * прореживания даёт `dropped: orphan` вместо `reparented`.
 * @param {Map<string,string|null>|Record<string,string|null>} parents
 * @param {Map<string,number>|Record<string,number>} [seqs]
 * @param {{minSeq?: number, max?: number}} [opts]
 * @returns {{parents: Record<string, string|null>, seq: Record<string, number>}}
 */
function pruneTombstones(parents, seqs, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const minSeq = isNum(o.minSeq) ? o.minSeq : -Infinity;
  const max = isNum(o.max) ? Math.max(0, Math.floor(o.max)) : Infinity;
  const src = tombParentsOf(parents) || parents;
  let rows = tombEntries(src).map(([id, p], order) => {
    const s = tombSeqOf(seqs, id);
    return { id, p, s, key: s === undefined ? 0 : s, order };
  }).filter((r) => r.key >= minSeq);
  if (rows.length > max) {
    rows = rows.slice().sort((a, b) => b.key - a.key || b.order - a.order).slice(0, max).sort((a, b) => a.order - b.order);
  }
  const out = { parents: {}, seq: {} };
  for (const r of rows) {
    out.parents[r.id] = r.p;
    if (r.s !== undefined) out.seq[r.id] = r.s;
  }
  return out;
}

/**
 * Надгробия, которые оставит транзакция: для каждого `remove` — все узлы
 * поддерева с их родителями НА МОМЕНТ ДО применения. Сервер и клиент ведут
 * этим общий словарь, по которому rebase ищет живого предка потерянному узлу.
 * Круг 27: `into` — куда ещё дописать (Map, объект parents или `{parents, seq}`
 * из normalizeTombstones; в последнем случае `seq` — номер удаления).
 * @param {object} doc документ до применения
 * @param {object[]} opList применённая форма операций
 * @param {Map<string,string|null>|Record<string,string|null>|{parents:object, seq:object}} [into]
 * @param {number} [seq] номер транзакции (для `{parents, seq}`)
 * @returns {[string, string|null][]}
 */
function collectTombstones(doc, opList, into, seq) {
  const out = collectTombstonesList(doc, opList);
  if (into && typeof into === 'object') {
    const v2 = tombParentsOf(into);
    const target = v2 || into;
    const n = tombSeq(seq);
    for (const [id, p] of out) {
      if (!isNodeId(id)) continue;
      if (target instanceof Map) target.set(id, p);
      else target[id] = p;
      if (v2 && n !== undefined) {
        if (!into.seq || typeof into.seq !== 'object') into.seq = {};
        if (into.seq instanceof Map) into.seq.set(id, n);
        else into.seq[id] = n;
      }
    }
  }
  return out;
}

function collectTombstonesList(doc, opList) {
  const out = [];
  const list = Array.isArray(opList) ? opList : opList ? [opList] : [];
  // круг 25: без remove надгробий нет — и незачем ничего применять (раньше каждая
  // операция пачки копировала словарь узлов: 4900 set на 19 500 узлах — десятки секунд)
  let last = -1;
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].op === 'remove') last = i;
  if (last < 0 || !doc || !doc.nodes) return out;
  const cur = openDraft(doc);
  const j = [];
  for (let i = 0; i <= last; i++) {
    const op = list[i];
    if (op && op.op === 'remove' && ownNode(cur.nodes, op.id)) {
      for (const id of subtreeIds(cur, op.id)) {
        const n = ownNode(cur.nodes, id);
        out.push([id, n && n.parent ? n.parent : null]);
      }
    }
    if (i === last) break;   // после последнего remove применять нечего
    stampIds([op]);          // как applyOps: id создаваемых узлов — до применения
    if (applyStep(cur, op, j)) break;
  }
  return out;
}

/**
 * `after` → индекс в списке детей родителя (без самого узла, как считает
 * applyOps); соседа уже нет — берётся `index`, иначе конец. `after` из
 * применённой формы убирается: в журнале лежит ровно то, что съел applyOps.
 */
function withIndex(draft, op, parent, selfId) {
  const arr = parent && Array.isArray(parent.children) ? parent.children : [];
  const st = DRAFT_STATE.get(draft);
  let len;
  let at = -1;
  if (st && arr.length >= POS_MIN && !posIndex(st, arr).dup) {
    // круг 27: без копии списка и indexOf — по индексу позиций (см. posOf)
    const self = posOf(draft, arr, selfId);
    len = arr.length - (self >= 0 ? 1 : 0);
    if (typeof op.after === 'string' && op.after !== selfId) {
      const a = posOf(draft, arr, op.after);
      at = a < 0 ? -1 : self >= 0 && self < a ? a - 1 : a;
    }
  } else {
    const kids = arr.filter((c) => c !== selfId);
    len = kids.length;
    if (typeof op.after === 'string') at = kids.indexOf(op.after);
  }
  let index;
  if (op.after === null) index = 0;
  else if (typeof op.after === 'string') {
    index = at >= 0 ? at + 1 : (isNum(op.index) ? op.index : len);
  } else index = isNum(op.index) ? op.index : len;
  const next = { ...op, index: clamp(Math.round(index), 0, len) };
  delete next.after;
  return next;
}

/** Позиция `after`: нет, `null` (первым) или строка-id. Иное — негодная операция. */
const okAfter = (v) => v === undefined || v === null || typeof v === 'string';
/** Позиция `index`: нет, `null` или число (не конечное — как отсутствие, как раньше). */
const okIndex = (v) => v === undefined || v === null || typeof v === 'number';
/** Круг 41: поля, которые «обернуть» пишет ребёнку в координатах новой рамки. */
const LOST_GEOMETRY = new Set(['pos', 'size', 'override']);
/** Голова пути set (строка или число) — '' для мусора. */
const pathHead = (p) => (typeof p === 'string' ? p.split('.')[0] : isNum(p) ? String(p) : '');
/** Сколько операций сливать между взглядами на часы (Date.now не бесплатен). */
const BUDGET_CHECK_EVERY = 32;

/* Круг 39: кто в пачке становится родителем (create node.parent, move parent) → индекс
   последней такой операции — для правила «пустая группа отбрасывается» в rebase.
   Линейно; rebase зовёт один раз на пачку и лениво — только когда такая группа встретилась. */
function lastParentIndex(list) {
  const last = new Map();
  for (let k = 0; k < list.length; k++) {
    const op = list[k];
    if (!op || typeof op !== 'object') continue;
    const p = op.op === 'create' ? (op.node && typeof op.node === 'object' ? op.node.parent : undefined)
      : op.op === 'move' ? op.parent : undefined;
    if (isNodeId(p)) last.set(p, k);
  }
  return last;
}

/**
 * Слияние (SPEC §9.6): операции относительно старой базы → применимые к голове.
 *
 * Круг 25: один изменяемый черновик на всю пачку (openDraft) с откатом не легшей
 * операции по журналу — O(операций + задетых узлов) вместо O(операций × узлов);
 * решения и выход — те же, что у прежнего «applyOps на каждую операцию»
 * (тест сравнивает с ним на случайных пачках). Не бросает ни на каком входе:
 * id/parent/after/index кривого типа и id-ключи прототипа (`constructor`,
 * `__proto__`) — `dropped: invalid`.
 *
 * Бюджет: `deadline` (момент Date.now(), мс) или `budgetMs` (от входа в rebase).
 * Исчерпан — остаток операций в `dropped` с `reason:'invalid'`, `limit:'merge_budget'`
 * (DSLTS: транзакция всё равно получает seq, автор видит, что не легло). Без
 * них — без предела и полностью детерминирован.
 *
 * Круг 39: `create` с перечисленными детьми («сгруппировать»), у которого после
 * вычёркивания не осталось ни одного ребёнка, — `dropped` (`removed`; `cycle`, если
 * живого ребёнка вычеркнул цикл; `invalid`, если в списке не id), если только пачка не
 * кладёт в этот узел что-то ещё.
 * @param {object} doc голова
 * @param {object[]} opList
 * @param {{tombstones?: Map<string,string|null>|Record<string,string|null>, deadline?: number, budgetMs?: number}} [opts]
 * @returns {{ops: object[], dropped: {index:number, op:object, reason:string, limit?:string}[], notes: {index:number, note:string}[]}}
 *   reason: removed · exists · orphan · cycle · invalid
 */
function rebase(doc, opList, opts) {
  const list = Array.isArray(opList) ? opList : opList ? [opList] : [];
  const out = { ops: [], dropped: [], notes: [] };
  if (!doc || !doc.nodes) {
    list.forEach((op, index) => out.dropped.push({ index, op, reason: 'invalid' }));
    return out;
  }
  const o = opts && typeof opts === 'object' ? opts : {};
  let tomb;
  try {
    tomb = toTombMap(o.tombstones);
  } catch (_) {
    tomb = new Map();
  }
  let deadline = Infinity;
  if (isNum(o.deadline)) deadline = o.deadline;
  if (isNum(o.budgetMs)) deadline = Math.min(deadline, Date.now() + Math.max(0, o.budgetMs));
  const cur = openDraft(doc);
  const j = [];
  // круг 39 (N2): операция, после которой раскрытие экземпляров вышло бы за
  // предел, — в dropped с limit 'expand_nodes' (как depth и merge_budget)
  const guard = expandGuard(doc, cur);
  const alive = (id) => ownNode(cur.nodes, id);
  let lastParent = null;
  /** пачка после операции i кладёт что-то в узел id */
  const filledLater = (id, i) => {
    if (!lastParent) lastParent = lastParentIndex(list);
    return lastParent.has(id) && lastParent.get(id) > i;
  };
  /** ближайший живой предок по цепочке надгробий */
  const liveAncestor = (id) => {
    let p = id;
    const seen = new Set();
    // круг 27: без предела глубины — цепочка надгробий удалённого глубокого поддерева
    // длиннее MAX_DEPTH; от цикла в надгробиях бережёт seen
    while (isNodeId(p) && !seen.has(p)) {
      if (alive(p)) return p;
      seen.add(p);
      p = tomb.has(p) ? tomb.get(p) : null;
    }
    return null;
  };
  /* Круг 41: create, отброшенный слиянием, тянет за собой операции той же пачки,
     вычисленные относительно него. «Обернуть» в свободной рамке — это create рамки
     с детьми и set pos/size детей в координатах НОВОЙ рамки; отбросили create
     (cycle/removed/orphan/invalid) — set pos лёг бы в старом родителе, и ребёнок
     прыгал в (0,0). Поэтому:
       lostNodes: id не созданного узла → причина (операции над ним, create/move в
         него — dropped с той же причиной, а не «removed»/«orphan»);
       lostKids: ребёнок, которого такой create должен был принять (или которого
         вычеркнули из списка как цикл), → причина: его set pos/size/override —
         dropped с той же причиной, пока пачка сама не переложит его move. */
  const lostNodes = new Map();
  const lostKids = new Map();
  const loseCreate = (node, why) => {
    if (!node || typeof node !== 'object') return;
    if (isNodeId(node.id) && !alive(node.id)) lostNodes.set(node.id, why);
    if (Array.isArray(node.children)) for (const c of node.children) if (isNodeId(c)) lostKids.set(c, why);
  };
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (deadline !== Infinity && i % BUDGET_CHECK_EVERY === 0 && Date.now() > deadline) {
      for (let k = i; k < list.length; k++) out.dropped.push({ index: k, op: list[k], reason: 'invalid', limit: 'merge_budget' });
      break;
    }
    const drop = (reason) => out.dropped.push({ index: i, op: raw, reason });
    const dropAs = (why) => out.dropped.push({ index: i, op: raw, reason: why.reason, ...(why.limit ? { limit: why.limit } : {}) });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { drop('invalid'); continue; }
    let op = raw;
    // «removed» — про узел, которого больше нет; операция без id — мусор, и
    // автору об этом стоит сказать иначе, чем «узел уже удалён»
    const hasId = isNodeId(op.id);
    if (lostNodes.size || lostKids.size) {
      const why = (op.op === 'set' || op.op === 'remove' || op.op === 'move') && hasId && lostNodes.get(op.id)
        || (op.op === 'move' && isNodeId(op.parent) && lostNodes.get(op.parent))
        || (op.op === 'create' && op.node && typeof op.node === 'object' && isNodeId(op.node.parent) && lostNodes.get(op.node.parent))
        || (op.op === 'set' && hasId && LOST_GEOMETRY.has(pathHead(op.path)) && lostKids.get(op.id));
      if (why) {
        if (op.op === 'create') loseCreate(op.node, why);
        dropAs(why);
        continue;
      }
    }
    switch (op.op) {
      case 'set':
      case 'remove':
        if (!hasId) { drop('invalid'); continue; }
        if (!alive(op.id)) { drop('removed'); continue; }
        break;
      case 'setToken':
        break;
      case 'create': {
        const node = op.node;
        if (!node || typeof node !== 'object' || Array.isArray(node)) { drop('invalid'); continue; }
        // id узла даёт клиент (SPEC §8.3, §9.1): без него create не отличить от
        // повтора и не отменить, а applyOps проставил бы случайный id прямо во
        // входную операцию — два вызова rebase на одном входе разошлись бы
        if (!isNodeId(node.id)) { drop('invalid'); continue; }
        if (!okAfter(op.after) || !okIndex(op.index)) { drop('invalid'); continue; }
        if (alive(node.id)) { drop('exists'); continue; }
        const needsParent = node.type !== 'page' || !!node.parent;
        if (needsParent) {
          let parentId = node.parent;
          if (!isNodeId(parentId)) { drop('invalid'); continue; }
          if (!alive(parentId)) {
            const alt = liveAncestor(parentId);
            if (!alt) { loseCreate(node, { reason: 'orphan' }); drop('orphan'); continue; }
            // место у старого родителя ничего не значит у нового — в конец
            op = { ...op, node: { ...node, parent: alt } };
            delete op.after;
            delete op.index;
            out.notes.push({ index: i, note: 'reparented' });
            parentId = alt;
          }
          if (Array.isArray(op.node.children)) {
            // дети, которых уже нет, вычёркиваются (§9.6). Туда же — ребёнок, который
            // из-за чужого move стал предком родителя (или самим родителем): усыновить
            // его — цикл, и applyOps отказал бы всему create; «сгруппировать» без него —
            // то же, что без удалённого, а не потеря всей правки
            const chain = ancestorIds(cur, parentId);
            const kids = op.node.children.filter((c) => alive(c) && !chain.has(c));
            /* Круг 39: «сгруппировать» (create с перечисленными детьми, оболочка — wrapOps),
               у которого вычеркнуты ВСЕ дети, отбрасывается: пустая рамка — не то, о чём
               просили, а второй транзакцией её убирать — лишняя запись и мигание у всех.
               Причина — 'removed' (детей удалили), 'cycle' — если кто-то из них вычеркнут
               как предок родителя, 'invalid' — в списке не id узла (мусор). Исключение: та же пачка кладёт в этот узел что-то ещё
               (create/move с parent = он) — тогда он не пустой и остаётся (слияние не
               отказывает остальным операциям пачки). */
            if (!kids.length && op.node.children.length && !filledLater(node.id, i)) {
              const was = op.node.children;
              const reason = !was.every(isNodeId) ? 'invalid' : was.some((c) => alive(c)) ? 'cycle' : 'removed';
              loseCreate(node, { reason });
              drop(reason);
              continue;
            }
            if (kids.length !== op.node.children.length) {
              // вычеркнутый как цикл ребёнок остаётся, где был: его геометрия «в новой рамке» не ложится
              for (const c of op.node.children) if (isNodeId(c) && chain.has(c) && alive(c)) lostKids.set(c, { reason: 'cycle' });
              op = { ...op, node: { ...op.node, children: kids } };
            }
          }
          op = withIndex(cur, op, alive(parentId), null);
        } else if (op.after !== undefined) {
          op = { ...op };
          delete op.after;
        }
        break;
      }
      case 'move': {
        if (!hasId) { drop('invalid'); continue; }
        if (!okAfter(op.after) || !okIndex(op.index)) { drop('invalid'); continue; }
        if (!alive(op.id)) { drop('removed'); continue; }
        let parentId = op.parent;
        if (!isNodeId(parentId)) { drop('invalid'); continue; }
        if (!alive(parentId)) {
          const alt = liveAncestor(parentId);
          if (!alt) { drop('orphan'); continue; }
          op = { ...op, parent: alt };
          delete op.after;
          delete op.index;
          out.notes.push({ index: i, note: 'reparented' });
          parentId = alt;
        }
        if (parentId === op.id || onPathUp(cur, parentId, op.id)) { drop('cycle'); continue; }
        op = withIndex(cur, op, alive(parentId), op.id);
        break;
      }
      default:
        drop('invalid');
        continue;
    }
    const err = applyStepGuarded(cur, op, j, guard);
    if (err) {
      // круг 27: нарушенный предел (глубина) — в dropped с limit, как merge_budget
      // (круг 39: и раскрытие экземпляров — limit 'expand_nodes')
      if (op.op === 'create') loseCreate(op.node, err.limit ? { reason: 'invalid', limit: err.limit } : { reason: 'invalid' });
      if (err.limit) out.dropped.push({ index: i, op: raw, reason: 'invalid', limit: err.limit });
      else drop('invalid');
      continue;
    }
    // легло: узел создан или ребёнок переложен — дальше пачка считает от настоящего места
    if (op.op === 'create') {
      lostNodes.delete(op.node.id);
      if (Array.isArray(op.node.children)) for (const c of op.node.children) lostKids.delete(c);
    } else if (op.op === 'move') lostKids.delete(op.id);
    out.ops.push(op);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4a. Шкалы: миграция на ссылки и правки шкалы со сдвигом (круг 20, SPEC §6.5)
 *
 * Всё здесь возвращает ОПЕРАЦИИ или применяет их через applyOps: документ не
 * мутируется, отмена — как у любой транзакции, новых операций нет.
 * ------------------------------------------------------------------ */

const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Число, ТОЧНО равное шагу шкалы, → ссылка на него; иначе значение как есть. */
function toScaleRef(doc, scale, v) {
  if (!isNum(v)) return v;
  const i = scaleIndexOf(doc, scale, v);
  return i < 0 ? v : scaleRef(scale, i);
}

/** Раскладка в форме хранения, где все точные совпадения со шкалой — ссылки. */
function layoutToRefs(doc, layout) {
  const L = normalizeLayout(layout);
  const p = L.padding;
  return {
    ...L,
    gap: toScaleRef(doc, 'spacing', L.gap),
    padding: {
      t: toScaleRef(doc, 'spacing', p.t), r: toScaleRef(doc, 'spacing', p.r),
      b: toScaleRef(doc, 'spacing', p.b), l: toScaleRef(doc, 'spacing', p.l)
    }
  };
}

/** Скругление (или покорнерный массив), где точные совпадения — ссылки. */
function radiusToRefs(doc, radius) {
  if (Array.isArray(radius)) return radius.map((v) => toScaleRef(doc, 'radii', v));
  return toScaleRef(doc, 'radii', radius);
}

/**
 * Операции миграции (SPEC §6.5): число, точно совпадающее с шагом шкалы,
 * становится ссылкой на этот шаг; число мимо шкалы остаётся числом; ссылки не
 * трогаются. Пустой массив — документ уже целиком на ссылках (идемпотентность).
 * По операции на КАЖДОЕ переводимое поле (`set layout.gap`, `set
 * layout.padding.t`, `set radius`, `set radius.<k>`), а не на узел целиком:
 * так миграция пишет ровно то, что переводит, и не спотыкается о соседнее
 * поле с мёртвой ссылкой (её место — в валидаторе, а не в отказе мигрировать).
 * Узлы без layout его не получают: отсутствие раскладки равно умолчанию, а
 * миграция не должна менять форму документа сверх необходимого.
 * @param {object} doc
 * @returns {object[]}
 */
function ensureScaleRefsOps(doc) {
  const list = [];
  if (!doc || !doc.nodes) return list;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n || typeof n !== 'object') continue;
    const l = n.layout;
    if (l && typeof l === 'object' && CONTAINER_TYPES.has(n.type)) {
      const gap = toScaleRef(doc, 'spacing', l.gap);
      if (gap !== l.gap) list.push(ops.set(id, 'layout.gap', gap));
      const p = l.padding;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const k of PAD_KEYS) {
          const v = toScaleRef(doc, 'spacing', p[k]);
          if (v !== p[k]) list.push(ops.set(id, 'layout.padding.' + k, v));
        }
      } else if (p !== undefined) {
        // краткая запись (число, массив) — только у страницы, фреймам её раскрывает схема
        const box = paddingShorthand(p);
        const next = box && { t: toScaleRef(doc, 'spacing', box.t), r: toScaleRef(doc, 'spacing', box.r), b: toScaleRef(doc, 'spacing', box.b), l: toScaleRef(doc, 'spacing', box.l) };
        if (next && !sameJSON(next, p)) list.push(ops.set(id, 'layout.padding', next));
      }
    }
    if (Array.isArray(n.radius)) {
      n.radius.forEach((v, k) => {
        const next = toScaleRef(doc, 'radii', v);
        if (next !== v) list.push(ops.set(id, 'radius.' + k, next));
      });
    } else if (n.radius !== undefined) {
      const next = toScaleRef(doc, 'radii', n.radius);
      if (next !== n.radius) list.push(ops.set(id, 'radius', next));
    }
  }
  return list;
}

/**
 * МИГРАЦИЯ (SPEC §6.5): один вызов, идемпотентный, вход не мутируется.
 * Возвращает ТОТ ЖЕ документ, если переводить нечего. Оболочка зовёт её там
 * же, где ensureLibrary — после загрузки из `db` и после импорта JSON.
 * Демо-документ createDoc() уже на ссылках и в миграции не нуждается.
 * @param {object} doc
 * @returns {object} Doc
 */
function ensureScaleRefs(doc) {
  const list = ensureScaleRefsOps(doc);
  if (!list.length) return doc;
  const res = applyOps(doc, list);
  if (res.error) {
    logOnce('ensureScaleRefs:' + res.error.code, `ensureScaleRefs: отступы не перевести на шкалу — ${res.error.message}`);
    return doc;
  }
  return res.doc;
}

/**
 * Все ссылки на шаги шкал в документе — где какая лежит. Заготовка для любой
 * правки шкалы «со сдвигом»: вставка шага (insertScaleStep), удаление, смена
 * лестницы целиком. Порядок — порядок узлов в doc.nodes, внутри узла — как в
 * nodeScaleRefs.
 * @param {object} doc
 * @param {string} [scale] только эта шкала ('spacing' | 'radii')
 * @returns {Array<{id:string, path:string, scale:string, index:number, ref:string}>}
 */
function scaleRefsIn(doc, scale) {
  const out = [];
  if (!doc || !doc.nodes) return out;
  for (const id of Object.keys(doc.nodes)) {
    for (const r of nodeScaleRefs(doc.nodes[id])) {
      const ref = parseScaleRef(r.value);
      // ссылка не в ту шкалу — не ссылка этой шкалы: её сдвигать нельзя, о ней скажет валидатор
      if (ref.scale !== r.scale) continue;
      if (scale !== undefined && ref.scale !== scale) continue;
      out.push({ id, path: r.path, scale: ref.scale, index: ref.index, ref: r.value });
    }
  }
  return out;
}

/**
 * Операции, переписывающие ссылки одной шкалы по правилу index → mapIndex(index).
 * Правило, вернувшее не целое ≥ 0, оставляет ссылку как есть. Сама шкала здесь
 * не меняется — её меняет вызывающий (setToken), и ПЕРЕД этими операциями:
 * новые индексы должны существовать, когда set их проверяет.
 * @param {object} doc
 * @param {string} scale
 * @param {(index:number)=>number} mapIndex
 * @returns {object[]}
 */
function rewriteScaleRefsOps(doc, scale, mapIndex) {
  const list = [];
  for (const r of scaleRefsIn(doc, scale)) {
    const to = mapIndex(r.index);
    if (!Number.isInteger(to) || to < 0 || to === r.index) continue;
    list.push(ops.set(r.id, r.path, scaleRef(scale, to)));
  }
  return list;
}

/**
 * Вставка шага В СЕРЕДИНУ шкалы (SPEC §6.1): одна транзакция — новая шкала
 * (setToken) плюс перепись всех ссылок с индексом ≥ index на +1, чтобы каждая
 * по-прежнему указывала на прежнее значение. Индекс от 0 до длины шкалы
 * включительно (длина — добавить в конец, ссылки не сдвигаются). Отменяется
 * как всё остальное через invertOps: сначала возвращаются ссылки, затем шкала.
 * @param {object} doc
 * @param {string} scale 'spacing' | 'radii'
 * @param {number} index куда встаёт новый шаг
 * @param {number} value значение шага (0..MAX_SIZE)
 * @returns {object[]} пустой массив, если вход не годится
 */
function insertScaleStep(doc, scale, index, value) {
  if (!doc || !doc.tokens || !SCALE_NAMES[scale]) return [];
  const steps = scaleSteps(doc, scale);
  if (!isNum(value) || value < 0 || value > MAX_SIZE) return [];
  if (!Number.isInteger(index) || index < 0 || index > steps.length) return [];
  const next = steps.slice();
  next.splice(index, 0, value);
  const list = [ops.setToken(scale, next)];
  for (const op of rewriteScaleRefsOps(doc, scale, (i) => (i >= index ? i + 1 : i))) list.push(op);
  return list;
}

/* ------------------------------------------------------------------ *
 * 5. Измерение текста
 * ------------------------------------------------------------------ */

const FALLBACK_FONT = 'IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const FALLBACK_MONO = 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace';

/** Итоговый стиль текста: токен из tokens.type + точечные переопределения узла. */
function resolveTextStyle(doc, node) {
  /* Круг 29: всё, что читается здесь, может прийти из документа прежней версии
     в чужой форме (объект в style.token, число в font, массив вместо токена).
     Ничего не приводим неявно: негодное поле пропускается, берётся запасное. */
  const own = doc && doc.tokens && isObj(doc.tokens.type) ? doc.tokens.type : null;
  const entry = (name) => {
    const e = typeof name === 'string' ? (own ? ownNode(own, name) : ownNode(DEFAULT_TOKENS.type, name)) : undefined;
    return isObj(e) ? e : undefined;
  };
  const raw = node && node.style;
  let base = entry('body') || DEFAULT_TOKENS.type.body;
  let over = {};
  if (typeof raw === 'string') base = entry(raw) || base;
  else if (isObj(raw)) {
    base = entry(raw.token) || base;
    over = raw;
  }
  const font = (typeof over.font === 'string' && over.font) || (typeof base.font === 'string' && base.font) || 'IBM Plex Sans';
  const fontSize = isNum(over.fontSize) ? over.fontSize : (isNum(base.fontSize) ? base.fontSize : 15);
  const fontWeight = isNum(over.fontWeight) ? over.fontWeight : (isNum(base.fontWeight) ? base.fontWeight : 400);
  const lhRaw = isNum(over.lineHeight) ? over.lineHeight : base.lineHeight;
  const lineHeight = isNum(lhRaw) ? (lhRaw <= 4 ? r2(lhRaw * fontSize) : lhRaw) : r2(fontSize * 1.4);
  const letterSpacing = isNum(over.letterSpacing) ? over.letterSpacing
    : (isNum(base.letterSpacing) ? base.letterSpacing : 0);
  // круг 47: моноширинный — семейство, чьё имя КОНЧАЕТСЯ на Mono (JetBrains Mono, Martian Mono);
  // «Rubik Mono One» — акцидентный, и подменять его IBM Plex Mono было нельзя
  const mono = /\bmono$/i.test(font.trim());
  return {
    font, fontSize, fontWeight, lineHeight, letterSpacing, mono,
    fontFamily: mono ? (/^ibm plex mono$/i.test(font.trim()) ? FALLBACK_MONO : font + ', ' + FALLBACK_MONO) : (font + ', ' + FALLBACK_FONT)
  };
}

/** Строка ключа кеша измерений: шрифт + размер + начертание + трекинг. */
function styleKey(style) {
  return style.font + '/' + style.fontSize + '/' + style.fontWeight + '/' + style.letterSpacing;
}

let sharedCanvasCtx;
/** Измерение через offscreen canvas теми же шрифтами, что и отрисовка. */
function canvasMeasure(text, style) {
  if (sharedCanvasCtx === undefined) {
    sharedCanvasCtx = null;
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        sharedCanvasCtx = document.createElement('canvas').getContext('2d');
      } else if (typeof OffscreenCanvas !== 'undefined') {
        sharedCanvasCtx = new OffscreenCanvas(8, 8).getContext('2d');
      }
    } catch (e) {
      logOnce('canvas', 'canvas недоступен, ширина текста считается приближённо', e);
      sharedCanvasCtx = null;
    }
  }
  if (!sharedCanvasCtx) return approxMeasure(text, style);
  sharedCanvasCtx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  const w = sharedCanvasCtx.measureText(text).width;
  if (!Number.isFinite(w)) return approxMeasure(text, style);
  return w + (style.letterSpacing || 0) * Math.max(0, text.length - 1);
}

/** Приближение на случай отсутствия canvas (SSR, тесты без заглушки). */
function approxMeasure(text, style) {
  const k = style.mono ? 0.6 : (style.fontWeight >= 600 ? 0.545 : 0.52);
  let units = 0;
  for (const ch of String(text)) units += /[ .,:;!|'’ilj]/.test(ch) ? 0.42 : /[MWmwШЩЮ]/.test(ch) ? 1.18 : 1;
  return units * style.fontSize * k + (style.letterSpacing || 0) * Math.max(0, text.length - 1);
}

/* ------------------------------------------------------------------ *
 * 5a. Эпоха измерений
 * ------------------------------------------------------------------ */

/**
 * Кеш ширин живёт при функции измерения и переживает вызовы solve — иначе
 * каждая раскладка мерила бы текст заново. Обратная сторона: первая раскладка
 * страницы считается системным шрифтом (веб-гарнитуры приходят позже), и без
 * сброса эти числа залипали бы навсегда — hug-текст на 10–20 % шире правды,
 * бейдж выделения врёт, «hug → фикс.» пишет неверное значение.
 *
 * Поэтому у кеша есть эпоха: она входит в его состояние, и при её смене ширины
 * забываются. Эпоху растит resetMeasureCache() — сам модуль зовёт его, когда
 * браузер сообщает о загрузке шрифтов, так что первый визит чинится без участия
 * оболочки; оболочка может позвать его сама и подписаться через onMeasureEpoch.
 */
let measureEpochValue = 0;
/** Мерили ли что-нибудь после последнего сброса: если нет — сбрасывать нечего. */
let measureDirty = false;
const measureEpochSubs = new Set();
/**
 * Недавние функции измерения — для пробного замера перед сбросом; свежая идёт
 * первой. Список короткий и затирается по кругу, чтобы чужая функция не жила
 * вечно (WeakMap кешей держится за неё).
 */
const activeMeasurers = [];
const PROBE_FN_LIMIT = 4;
/** Сколько образцов на измеритель сверяем: хватает нескольких строк разных стилей. */
const PROBE_SAMPLE_LIMIT = 12;

/** Запомнить измеритель: без этого пробный замер не на чем сделать. */
function rememberMeasurer(fn) {
  const at = activeMeasurers.indexOf(fn);
  if (at === 0) return;
  if (at > 0) activeMeasurers.splice(at, 1);
  activeMeasurers.unshift(fn);
  if (activeMeasurers.length > PROBE_FN_LIMIT) activeMeasurers.length = PROBE_FN_LIMIT;
}

/**
 * Пробный замер: перемерить несколько отложенных образцов теми же функциями и
 * сравнить с тем, что лежит в кеше. Гарнитура может «догрузиться», не изменив
 * ни одной ширины (второй начертание, подмена тем же метричным шрифтом) — тогда
 * пересчитывать весь документ незачем.
 * @returns {boolean} метрики изменились (или проверить нечем — считаем, что да)
 */
function measureMetricsChanged() {
  const fn = activeMeasurers[0];   // тот, которым считают сейчас
  const caches = fn ? measurerCaches.get(fn) : null;
  const probes = caches && caches.probes;
  if (!probes || !probes.length) return true;   // сверять нечем — сбрасываем, как раньше
  for (const p of probes) {
    let raw;
    try { raw = fn(p.text, p.style); } catch (e) { return true; }
    if (!Number.isFinite(raw)) return true;
    if (Math.abs(r2(raw) - p.value) > 0.01) return true;
  }
  return false;
}

/** Текущая эпоха измерений. Растёт при каждом состоявшемся сбросе кеша. */
function measureEpoch() {
  return measureEpochValue;
}

/**
 * Забыть измеренные ширины: следующий solve померит текст заново.
 * Звать, когда изменились условия измерения — загрузились гарнитуры, сменился
 * измеритель. Если после прошлого сброса никто ничего не мерил, эпоха не растёт
 * (забывать нечего, и подписчиков незачем будить дважды).
 * @param {string} [reason] попадает подписчикам — видно, кто разбудил пересчёт
 * @returns {number} текущая эпоха
 */
function resetMeasureCache(reason) {
  if (!measureDirty) return measureEpochValue;
  // «умный» сброс: браузер шлёт loadingdone на каждую гарнитуру, и на документ
  // с тремя начертаниями приходило три полных пересчёта подряд. Если пробный
  // замер даёт прежние ширины — забывать нечего, подписчиков не будим
  if (!measureMetricsChanged()) return measureEpochValue;
  measureEpochValue += 1;
  measureDirty = false;
  const info = { epoch: measureEpochValue, reason: reason || 'reset' };
  for (const cb of Array.from(measureEpochSubs)) {
    try { cb(info); } catch (e) { logOnce('measure:sub', 'подписчик на эпоху измерений бросил исключение', e); }
  }
  return measureEpochValue;
}

/**
 * Подписка на смену эпохи: оболочке — сигнал пересчитать геометрию и перерисовать.
 * @param {(info:{epoch:number, reason:string})=>void} cb
 * @returns {() => void} отписка — без неё слушатель живёт до конца страницы
 */
function onMeasureEpoch(cb) {
  if (typeof cb !== 'function') return () => {};
  measureEpochSubs.add(cb);
  return () => { measureEpochSubs.delete(cb); };
}

/**
 * Подписка на загрузку гарнитур. Делается один раз при загрузке модуля: наш
 * обработчик fonts.ready встаёт в очередь раньше, чем такой же у оболочки,
 * поэтому её пересчёт после шрифтов получает уже свежие ширины, даже если об
 * эпохе она ничего не знает. loadingdone ловит и шрифты, пришедшие позже.
 */
function watchFontLoading() {
  if (typeof document === 'undefined' || !document.fonts) return;
  const fonts = document.fonts;
  try {
    if (fonts.ready && typeof fonts.ready.then === 'function') {
      fonts.ready.then(() => resetMeasureCache('fonts-ready'), () => {});
    }
    if (typeof fonts.addEventListener === 'function') {
      // слушатель модульный: он нужен всю жизнь страницы, снимать его некому
      fonts.addEventListener('loadingdone', () => resetMeasureCache('fonts-loadingdone'));
    }
  } catch (e) {
    logOnce('fonts:watch', 'не удалось подписаться на загрузку шрифтов — меряем тем, что есть', e);
  }
}
watchFontLoading();

/**
 * Готовит измеритель с кешем (ключ: текст + стиль + ширина).
 * Кеш общий для всех вызовов с одной и той же функцией измерения и живёт до
 * смены эпохи измерений (см. resetMeasureCache).
 * @param {{measureText?:(text:string, style:object)=>number}} [opts]
 */
const measurerCaches = new WeakMap();
const MEASURE_CACHE_LIMIT = 20000;

function makeMeasurer(opts) {
  const fn = opts && typeof opts.measureText === 'function' ? opts.measureText : canvasMeasure;
  // кеш живёт при функции измерения — переживает вызовы solve/validate
  let caches = measurerCaches.get(fn);
  if (!caches) { caches = { width: new Map(), wrap: new Map(), probes: [], epoch: measureEpochValue }; measurerCaches.set(fn, caches); }
  rememberMeasurer(fn);
  // эпоха сменилась — прежние ширины померены другими шрифтами, им верить нельзя
  if (caches.epoch !== measureEpochValue) {
    caches.width.clear();
    caches.wrap.clear();
    caches.probes = [];
    caches.epoch = measureEpochValue;
  }
  if (caches.width.size > MEASURE_CACHE_LIMIT) caches.width.clear();
  if (caches.wrap.size > MEASURE_CACHE_LIMIT) caches.wrap.clear();
  const widthCache = caches.width;
  const wrapCache = caches.wrap;
  const width = (text, style) => {
    const key = styleKey(style) + '\u0000' + text;
    let v = widthCache.get(key);
    if (v === undefined) {
      let raw;
      try { raw = fn(text, style); } catch (e) {
        logOnce('measure:throw', 'measureText бросил исключение, беру приближение', e);
        raw = approxMeasure(text, style);
      }
      v = r2(Number.isFinite(raw) ? raw : approxMeasure(text, style));
      widthCache.set(key, v);
      measureDirty = true;   // есть что забывать при смене гарнитур
      // образец для пробного замера: по нему решаем, менялись ли метрики
      if (caches.probes.length < PROBE_SAMPLE_LIMIT && text) caches.probes.push({ text, style, value: v });
    }
    return v;
  };
  /** Перенос по словам. maxWidth === null → без переноса. */
  const wrap = (text, style, maxWidth) => {
    const src = textOf(text);   // круг 29: без неявного приведения чужого значения
    const key = styleKey(style) + '\u0000' + (maxWidth === null || !Number.isFinite(maxWidth) ? '-' : r2(maxWidth)) + '\u0000' + src;
    let cached = wrapCache.get(key);
    if (cached) return cached;
    const out = [];
    for (const para of src.split('\n')) {
      if (maxWidth === null || !Number.isFinite(maxWidth) || maxWidth <= 0) { out.push(para); continue; }
      const words = para.split(/\s+/).filter((w, i, a) => w !== '' || a.length === 1);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (!line || width(test, style) <= maxWidth + 0.01) line = test;
        else { out.push(line); line = word; }
      }
      out.push(line);
    }
    // замораживаем: этот же массив уходит в geo.lines, и правка снаружи
    // отравила бы кеш измерений на всю эпоху
    const res = Object.freeze(out.length ? out : ['']);
    wrapCache.set(key, res);
    measureDirty = true;
    return res;
  };
  const natural = (text, style) => {
    let max = 0;
    // круг 29: не строка (документ прежней версии) — пусто, без неявного приведения
    for (const para of textOf(text).split('\n')) {
      max = Math.max(max, width(para, style));
    }
    return r2(max);
  };
  return { width, wrap, natural };
}

/* ------------------------------------------------------------------ *
 * 6. Решатель
 * ------------------------------------------------------------------ */

const ZERO_BOX = Object.freeze({ w: 0, h: 0 });

/**
 * Заданный размер оси в границах схемы. Документ мог прийти мимо checkNode
 * (импорт, чужой JSON), а NaN в size.value залипает в виде навсегда.
 */
const fixedSize = (spec) => numIn(spec && spec.value, 0, MAX_SIZE, 0);

/** Позиция узла в границах ±MAX_SIZE: pos.x = 1e308 иначе уводит геометрию в Infinity. */
const nodePos = (node) => {
  const p = (node && node.pos) || null;
  return {
    x: numIn(p && p.x, -MAX_SIZE, MAX_SIZE, 0),
    y: numIn(p && p.y, -MAX_SIZE, MAX_SIZE, 0)
  };
};

/**
 * Ширина, по которой переносить строки текста. `null` — без переноса.
 *
 * «По содержимому» (hug) переносить нечего, пока рамка не уже натуральной ширины:
 * так в geo.lines остаются ровно те знаки, что набрал человек (переносчик
 * склеивает слова через один обычный пробел и съел бы и двойной, и неразрывный).
 * Но контейнер умеет задать hug-узлу ширину сам — колонка с align:'stretch'
 * растягивает его во всю свою; тогда рамка главнее натуральной ширины, и
 * переносим по ней. Без этого geo.rects и geo.lines расходились: прямоугольник
 * во всю ширину, а строка одна, вылезает за кромку и срезается обрезкой —
 * бейдж, рамка выделения, хит-тест, инспектор и экспорт врали все сразу.
 * Одно правило на три места: measureNodeInner, placeNode и validate.
 * @param {string} mode size.w.mode узла
 * @param {number} w ширина рамки, которую узел получил
 * @param {number} natural натуральная ширина текста (самый широкий абзац)
 * @returns {number|null}
 */
function textWrapWidth(mode, w, natural) {
  if (mode !== 'hug') return w;
  return isNum(natural) && isNum(w) && w + 0.01 < natural ? w : null;
}

/**
 * @param {'w'|'h'|null} [stretch] ось, которую контейнер растягивает по своей
 *   рамке: hug по этой оси работает как fill (align:'stretch' у родителя).
 */
/* Круг 51 (SPEC §18): кеши мер и потоков — по узлу (id → ключ ограничений → результат), чтобы
   раскладка по месту правки снимала записи ровно изменённых узлов и их предков. */
function cacheGet(cache, id, key) {
  const m = cache.get(id);
  return m ? m.get(key) : undefined;
}
const CACHE_KEYS_PER_NODE = 12;  // цепочка solveAfter несёт кеши дальше: старые ограничения чистых узлов не копятся
function cacheSet(cache, id, key, v) {
  let m = cache.get(id);
  if (!m) { m = new Map(); cache.set(id, m); }
  else if (m.size >= CACHE_KEYS_PER_NODE && !m.has(key)) m.delete(m.keys().next().value);
  m.set(key, v);
}

function measureNode(ctx, node, availW, availH, stretch) {
  const key = (availW === null ? '-' : r2(availW)) + '#' + (availH === null ? '-' : r2(availH))
    + '#' + (stretch || '-');
  const hit = cacheGet(ctx.measCache, node.id, key);
  if (hit) return hit;
  // круг 52: экземпляр той же формы уже мерян с теми же ограничениями — его мера
  const shape = node.synthetic && ctx.shapeMeas ? expandShape.get(node) : undefined;
  if (shape !== undefined) {
    const same = ctx.shapeMeas.get(shape + '|' + key);
    if (same) { cacheSet(ctx.measCache, node.id, key, same); return same; }
  }
  // узел уже меряется выше по стеку (цикл) либо дерево слишком глубокое — не уходим в рекурсию
  if (ctx.stack.has(node.id)) {
    logOnce('solve:cycle:' + node.id, `solve: цикл в дереве на узле «${node.id}» — ветка пропущена`);
    return ZERO_BOX;
  }
  if (ctx.stack.size > MAX_DEPTH) {
    logOnce('solve:deep', `solve: глубже ${MAX_DEPTH} узлов — ветка на «${node.id}» пропущена`);
    return ZERO_BOX;
  }
  ctx.stack.add(node.id);
  try {
    const res = measureNodeInner(ctx, node, availW, availH, key, stretch);
    if (shape !== undefined) ctx.shapeMeas.set(shape + '|' + key, res);
    return res;
  } finally {
    ctx.stack.delete(node.id);
  }
}

function measureNodeInner(ctx, node, availW, availH, key, stretch) {
  const sw = (node.size && node.size.w) || { mode: 'hug' };
  const sh = (node.size && node.size.h) || { mode: 'hug' };
  // растянутую ось контейнер задаёт сам — по ней hug ведёт себя как fill.
  // Меряем по той же ширине, какую узел получит в прямоугольнике: иначе
  // измерение и расстановка расходятся (см. textWrapWidth)
  const byBoxW = (sw.mode === 'fill' || stretch === 'w') && availW !== null;
  const byBoxH = (sh.mode === 'fill' || stretch === 'h') && availH !== null;
  let res;
  if (node.type === 'frame' || node.type === 'page') {
    const boxW = sw.mode === 'fixed' ? fixedSize(sw) : (byBoxW ? availW : null);
    const boxH = sh.mode === 'fixed' ? fixedSize(sh) : (byBoxH ? availH : null);
    const flow = flowLayout(ctx, node, boxW, boxH);
    res = { w: flow.w, h: flow.h };
  } else if (node.type === 'text') {
    const style = resolveTextStyle(ctx.doc, node);
    const natural = ctx.m.natural(node.characters, style);
    let w;
    if (sw.mode === 'fixed') w = fixedSize(sw);
    else if (byBoxW) w = availW;
    else w = natural;
    const lines = ctx.m.wrap(node.characters, style, textWrapWidth(sw.mode, w, natural));
    let h;
    if (sh.mode === 'fixed') h = fixedSize(sh);
    else if (byBoxH) h = availH;
    else h = r2(lines.length * style.lineHeight);
    res = { w: r2(Math.max(0, w)), h: r2(Math.max(0, h)) };
  } else {
    // круг 37 (SPEC §12.1): вектор — как rect, но «по содержимому» — это его viewBox
    const vb = node.type === 'vector' ? vbOf(node) : null;
    const w = sw.mode === 'fixed' ? fixedSize(sw) : (byBoxW ? availW : (vb ? vb.w : 0));
    const h = sh.mode === 'fixed' ? fixedSize(sh) : (byBoxH ? availH : (vb ? vb.h : 0));
    res = { w: r2(Math.max(0, w)), h: r2(Math.max(0, h)) };
  }
  cacheSet(ctx.measCache, node.id, key, res);
  return res;
}

/**
 * Раскладка детей фрейма. boxW/boxH === null означает «размер по содержимому».
 * @returns {{w:number,h:number,items:Array,layout:object}}
 */
function flowLayout(ctx, node, boxW, boxH) {
  const key = (boxW === null ? '-' : r2(boxW)) + '@' + (boxH === null ? '-' : r2(boxH));
  const hit = cacheGet(ctx.flowCache, node.id, key);
  if (hit) return hit;
  // круг 20 (SPEC §6.3): ссылки на шаги шкалы становятся числами здесь, на входе
  // решателя, и только через resolveLayout — раскрытые узлы экземпляров идут
  // тем же путём (мастер на ссылках → экземпляры на ссылках)
  const L = resolveLayout(ctx.doc, node.layout);
  const pad = L.padding;
  // круг 19: детей берём из карты РАСКРЫТОГО документа — у раскрытого узла
  // экземпляра дети синтетические, в doc.nodes их нет (SPEC §5.6)
  const kids = kidsOf(node).map((id) => ownNode(ctx.nodes, id)).filter((n) => n && n.visible !== false);
  const flowKids = kids.filter((k) => !k.override);
  const absKids = kids.filter((k) => k.override);
  const innerW = boxW === null ? null : Math.max(0, r2(boxW - pad.l - pad.r));
  const innerH = boxH === null ? null : Math.max(0, r2(boxH - pad.t - pad.b));
  const items = [];
  let contentW = 0;
  let contentH = 0;

  if (L.mode === 'row' || L.mode === 'column') {
    const isRow = L.mode === 'row';
    const mainInner = isRow ? innerW : innerH;
    const crossInner = isRow ? innerH : innerW;
    // Растягивая hug-ребёнка, контейнер задаёт ему поперечник — и мерить его
    // надо по этому поперечнику, а не «по содержимому»: иначе текст меряется
    // одной строкой в 630 px, а прямоугольник получает 350 и строку срезает.
    // Подсказку даём, только когда поперечник строки точно придёт из рамки:
    // при wrap строк может стать несколько, и тогда каждая живёт своей (ниже
    // растянутых перемеряем ещё раз, когда поперечник строки уже известен).
    const crossAxis = isRow ? 'h' : 'w';
    // то же условие, что у crossFromBox ниже, но известное ДО разбиения на
    // строки: без wrap (или когда главная ось не ограничена) строка заведомо одна
    const crossFromBoxSure = crossInner !== null && (!L.wrap || mainInner === null);
    const metas = flowKids.map((k) => {
      const mainSpec = (isRow ? k.size && k.size.w : k.size && k.size.h) || { mode: 'hug' };
      const crossSpec = (isRow ? k.size && k.size.h : k.size && k.size.w) || { mode: 'hug' };
      const fillMain = mainSpec.mode === 'fill';
      const crossStretch = L.align === 'stretch' && crossSpec.mode === 'hug';
      const crossFill = crossSpec.mode === 'fill' || crossStretch;
      const aW = isRow ? (fillMain ? null : innerW) : (crossFill ? innerW : null);
      const aH = isRow ? (crossFill ? innerH : null) : (fillMain ? null : innerH);
      const m = measureNode(ctx, k, aW, aH, crossStretch && crossFromBoxSure ? crossAxis : null);
      return { node: k, fillMain, crossFill, crossStretch, main: isRow ? m.w : m.h, cross: isRow ? m.h : m.w };
    });
    // разбиение на строки (wrap)
    const rows = [];
    let cur = [];
    let curMain = 0;
    for (const meta of metas) {
      const add = cur.length ? L.gap : 0;
      if (L.wrap && mainInner !== null && cur.length && curMain + add + meta.main > mainInner + 0.01) {
        rows.push({ metas: cur, main: curMain });
        cur = [meta]; curMain = meta.main;
      } else { cur.push(meta); curMain += add + meta.main; }
    }
    rows.push({ metas: cur, main: curMain });
    // Поперечник строке задаёт контейнер только тогда, когда строка одна и её
    // поперечник известен: там растянутый ребёнок получит crossInner целиком.
    // Как только wrap разложил детей на несколько строк, каждая строка живёт
    // своим поперечником — иначе растянутые дети схлопывались в нулевую высоту.
    const crossFromBox = rows.length === 1 && crossInner !== null;
    /**
     * Поперечник, которым ребёнок задаёт высоту своей строки. Растянутого мерим
     * «по содержимому»: size:fill по поперечнику иначе вернул бы весь innerCross
     * и одна строка стала бы во весь фрейм.
     */
    const ownCross = (m) => {
      if (!m.crossFill) return m.cross;
      const m2 = measureNode(ctx, m.node, isRow ? m.main : null, isRow ? null : m.main);
      return isRow ? m2.h : m2.w;
    };
    // распределение fill по главной оси + пересчёт поперечника
    for (const row of rows) {
      const gaps = L.gap * Math.max(0, row.metas.length - 1);
      // поперечник строки теперь известен: растянутых перемеряем по нему. Для
      // текста это меняет и главный размер — в рамке 350 вместо 630 строк
      // становится больше, и высота растёт (при crossFromBoxSure это тот же
      // замер, что выше, и он берётся из кеша)
      if (crossFromBox) {
        for (const m of row.metas) {
          if (!m.crossStretch) continue;
          const aMain = m.fillMain ? null : mainInner;
          const m2 = measureNode(ctx, m.node,
            isRow ? aMain : crossInner,
            isRow ? crossInner : aMain, crossAxis);
          m.main = isRow ? m2.w : m2.h;
          m.cross = isRow ? m2.h : m2.w;
        }
      }
      const fills = row.metas.filter((m) => m.fillMain);
      if (fills.length && mainInner !== null) {
        const used = row.metas.reduce((s, m) => s + m.main, 0) + gaps;
        const extra = mainInner - used;
        if (extra > 0) {
          const share = extra / fills.length;
          for (const m of fills) m.main = r2(m.main + share);
        } else if (extra < 0) {
          const totalFill = fills.reduce((s, m) => s + m.main, 0);
          const scale = totalFill > 0 ? Math.max(0, (totalFill + extra) / totalFill) : 0;
          for (const m of fills) m.main = r2(m.main * scale);
        }
        for (const m of fills) {
          // поперечник берём тот же, каким ребёнок войдёт в строку: при нескольких
          // строках растянутого меряем по содержимому (см. ownCross — попадёт в кеш)
          const aCross = m.crossFill && crossFromBox ? crossInner : null;
          const m2 = measureNode(ctx, m.node,
            isRow ? m.main : aCross,
            isRow ? aCross : m.main,
            m.crossStretch && aCross !== null ? crossAxis : null);
          m.cross = isRow ? m2.h : m2.w;
        }
      }
      row.main = r2(row.metas.reduce((s, m) => s + m.main, 0) + gaps);
      row.cross = crossFromBox
        ? r2(crossInner)
        : r2(row.metas.reduce((s, m) => Math.max(s, ownCross(m)), 0));
    }
    const mainMax = r2(maxOf(rows, (r) => r.main, 0));
    contentW = isRow ? mainMax : 0;
    contentH = isRow ? 0 : mainMax;
    const crossTotal = r2(rows.reduce((s, r) => s + r.cross, 0) + L.gap * Math.max(0, rows.length - 1));
    if (isRow) contentH = crossTotal; else contentW = crossTotal;
    // расстановка
    let crossCursor = 0;
    for (const row of rows) {
      const avail = mainInner !== null ? mainInner : row.main;
      const free = r2(avail - row.main);
      let cursor = 0;
      let step = L.gap;
      if (L.justify === 'center') cursor = free / 2;
      else if (L.justify === 'end') cursor = free;
      else if (L.justify === 'between') {
        // при переполнении free отрицателен: шагу нельзя опускаться ниже gap,
        // иначе «между» разводит блоки назад — второй уезжает в минус
        if (row.metas.length > 1 && free > 0) step = r2(L.gap + free / (row.metas.length - 1));
      }
      for (const meta of row.metas) {
        const itemCross = meta.crossFill ? row.cross : meta.cross;
        let co = 0;
        if (L.align === 'center') co = (row.cross - itemCross) / 2;
        else if (L.align === 'end') co = row.cross - itemCross;
        const mainPos = r2(cursor);
        const crossPos = r2(crossCursor + co);
        items.push({
          node: meta.node,
          x: r2(pad.l + (isRow ? mainPos : crossPos)),
          y: r2(pad.t + (isRow ? crossPos : mainPos)),
          w: r2(isRow ? meta.main : itemCross),
          h: r2(isRow ? itemCross : meta.main)
        });
        cursor = r2(cursor + meta.main + step);
      }
      crossCursor = r2(crossCursor + row.cross + L.gap);
    }
  } else {
    // свободное размещение
    for (const k of flowKids) {
      const m = measureNode(ctx, k, innerW, innerH);
      const pos = nodePos(k);
      const x = r2(pad.l + pos.x);
      const y = r2(pad.t + pos.y);
      items.push({ node: k, x, y, w: m.w, h: m.h });
      contentW = Math.max(contentW, r2(pos.x + m.w));
      contentH = Math.max(contentH, r2(pos.y + m.h));
    }
  }
  // отсоединённые узлы: абсолютно внутри родителя, вне потока
  for (const k of absKids) {
    const o = k.override;
    // переопределения приходят и мимо checkNode — держим их в границах схемы
    const ow = isNum(o.w) ? clamp(o.w, 0, MAX_SIZE) : null;
    const oh = isNum(o.h) ? clamp(o.h, 0, MAX_SIZE) : null;
    // прикреплённый размер — такая же заданная рамка, как растяжение: текст
    // «по содержимому» в ней переносится, и высота считается по переносам
    // (override.w без override.h — «ширина моя, высота по тексту»)
    const m = measureNode(ctx, k, ow === null ? innerW : ow, oh === null ? innerH : oh,
      ow !== null ? 'w' : (oh !== null ? 'h' : null));
    items.push({
      node: k, x: r2(numIn(o.x, -MAX_SIZE, MAX_SIZE, 0)), y: r2(numIn(o.y, -MAX_SIZE, MAX_SIZE, 0)),
      w: r2(ow === null ? m.w : ow), h: r2(oh === null ? m.h : oh), detached: true
    });
  }
  const res = {
    w: boxW === null ? r2(contentW + pad.l + pad.r) : r2(boxW),
    h: boxH === null ? r2(contentH + pad.t + pad.b) : r2(boxH),
    items, layout: L
  };
  cacheSet(ctx.flowCache, node.id, key, res);
  return res;
}

function placeNode(ctx, node, x, y, w, h, depth) {
  const d = depth || 0;
  if (ctx.placed.has(node.id)) {
    logOnce('place:twice:' + node.id, `solve: узел «${node.id}» встречен дважды — размещаем один раз`);
    return;
  }
  if (d > MAX_DEPTH) {
    logOnce('place:deep', `solve: глубже ${MAX_DEPTH} узлов — размещение ветки «${node.id}» остановлено`);
    return;
  }
  // круг 51: чистое поддерево (ни оно, ни потомки не правились) того же размера — прежняя
  // геометрия со сдвигом, без обхода раскладки (см. solveAfter)
  if (ctx.prev && !ctx.dirty.has(node.id)) {
    const pr = ownNode(ctx.prev.rects, node.id);
    const sp = ctx.prevSpan.get(node.id);
    if (pr && sp && pr.w === r2(w) && pr.h === r2(h) && copyPlaced(ctx, sp, r2(x) - pr.x, r2(y) - pr.y)) return;
  }
  // круг 52: экземпляр той же формы и того же размера уже разложен в этой раскладке — копия со сдвигом
  const shape = node.synthetic && ctx.shapePlaced ? expandShape.get(node) : undefined;
  const tkey = shape === undefined ? undefined : shape + '|' + r2(w) + '#' + r2(h);
  if (tkey !== undefined) {
    const t = ctx.shapePlaced.get(tkey);
    if (t && copyShape(ctx, t, node.id, x, y)) return;
  }
  ctx.placed.add(node.id);
  ctx.rects[node.id] = { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
  const start = ctx.seq.length;
  ctx.seq.push(node.id);
  /* Круг 19, п.4: в geo.order только узлы САМОГО документа. Порядок читают
     хит-тест и выбор верхнего узла (Stage._topUnder), а раскрытые узлы выделять
     нельзя — экземпляр берётся и таскается как один узел (SPEC §5, п.5 задания).
     Прямоугольники у раскрытых узлов при этом есть: по ним рисуют и меряют. */
  if (ctx.seq !== ctx.order && ctx.doc.nodes[node.id]) ctx.order.push(node.id);
  if (node.type === 'text') {
    const style = resolveTextStyle(ctx.doc, node);
    const sw = (node.size && node.size.w) || { mode: 'hug' };
    ctx.lines[node.id] = ctx.m.wrap(node.characters, style,
      textWrapWidth(sw.mode, w, ctx.m.natural(node.characters, style)));
  }
  if (node.type === 'frame' || node.type === 'page') {
    const flow = flowLayout(ctx, node, w, h);
    for (const it of flow.items) placeNode(ctx, it.node, x + it.x, y + it.y, it.w, it.h, d + 1);
  }
  // отрезок ctx.seq, занятый поддеревом (узел первым) — по нему solveAfter копирует чистое
  ctx.span.set(node.id, [start, ctx.seq.length]);
  if (tkey !== undefined && !ctx.shapePlaced.has(tkey)) ctx.shapePlaced.set(tkey, shapeOf(ctx, node.id, start));
}

/**
 * Круг 52: разложенное поддерево экземпляра как образец для экземпляров той же формы — хвосты id
 * (после id корня), прямоугольники относительно корня, строки текста, отрезки. null — в поддереве
 * чужой id (не «корень/…»): такой образец не переносится.
 */
function shapeOf(ctx, rootId, start) {
  const end = ctx.seq.length;
  const root = ctx.rects[rootId];
  const pre = rootId + '/';
  const tails = [];
  const rel = [];
  const lines = [];
  const spans = [];
  for (let i = start; i < end; i++) {
    const id = ctx.seq[i];
    if (id !== rootId && !id.startsWith(pre)) return null;
    const r = ctx.rects[id];
    tails.push(id.slice(rootId.length));
    rel.push(r2(r.x - root.x), r2(r.y - root.y), r.w, r.h);
    lines.push(hasOwnProp.call(ctx.lines, id) ? ctx.lines[id] : undefined);
    const sp = ctx.span.get(id);
    spans.push(sp ? sp[0] - start : -1, sp ? sp[1] - start : -1);
  }
  return { tails, rel, lines, spans };
}

let shapeCopies = 0;   // сколько экземпляров разложено копией образца — тестам, без часов
/** Круг 52: счётчик копий образца формы экземпляра (для тестов скорости без часов). */
function solveShapeCopies() { return shapeCopies; }

/** Круг 52: копия образца shapeOf под корнем rootId в точке (x, y). false — копировать нельзя. */
function copyShape(ctx, t, rootId, x, y) {
  const n = t.tails.length;
  const ids = new Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = rootId + t.tails[i];
    if (ctx.placed.has(ids[i])) return false;
  }
  const ox = r2(x);
  const oy = r2(y);
  const base = ctx.seq.length;
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const k = i * 4;
    ctx.placed.add(id);
    ctx.rects[id] = { x: r2(ox + t.rel[k]), y: r2(oy + t.rel[k + 1]), w: t.rel[k + 2], h: t.rel[k + 3] };
    if (t.lines[i] !== undefined) ctx.lines[id] = t.lines[i];
    ctx.seq.push(id);
    if (ctx.seq !== ctx.order && ctx.doc.nodes[id]) ctx.order.push(id);
    if (t.spans[i * 2] >= 0) ctx.span.set(id, [base + t.spans[i * 2], base + t.spans[i * 2 + 1]]);
  }
  shapeCopies++;
  return true;
}

/**
 * Круг 51: поддерево из прежней геометрии — прямоугольники со сдвигом (dx, dy), строки текста,
 * порядок и отрезки. false — копировать нельзя (узел уже размещён: двойной родитель) — тогда
 * обычный обход, он и скажет о беде.
 */
function copyPlaced(ctx, sp, dx, dy) {
  const prev = ctx.prev;
  const seq = ctx.prevSeq;
  const [a, b] = sp;
  for (let i = a; i < b; i++) if (ctx.placed.has(seq[i])) return false;
  const base = ctx.seq.length - a;
  const ddx = r2(dx);
  const ddy = r2(dy);
  for (let i = a; i < b; i++) {
    const id = seq[i];
    const r = prev.rects[id];
    ctx.placed.add(id);
    ctx.rects[id] = ddx || ddy ? { x: r2(r.x + ddx), y: r2(r.y + ddy), w: r.w, h: r.h } : r;
    if (hasOwnProp.call(prev.lines, id)) ctx.lines[id] = prev.lines[id];
    ctx.seq.push(id);
    if (ctx.seq !== ctx.order && ctx.doc.nodes[id]) ctx.order.push(id);
    const s2 = ctx.prevSpan.get(id);
    if (s2) ctx.span.set(id, [s2[0] + base, s2[1] + base]);
  }
  return true;
}

let selfTestState = 0; // 0 — не запускался, 1 — идёт, 2 — пройден
/**
 * Вычисляет геометрию документа. Чистая функция: одинаковый документ → одинаковая геометрия.
 * @param {object} doc
 * @param {{measureText?:Function, selfTest?:boolean}} [opts] measureText(text, style) -> ширина в px
 * @returns {{rects:Record<string,{x:number,y:number,w:number,h:number}>, lines:Record<string,string[]>, order:string[]}}
 */
function solve(doc, opts) {
  return solveWith(doc, opts, null);
}

/** Круг 51: что раскладка оставляет для следующей по месту правки (geo → кеши, отрезки, условия). */
const SOLVE_MEMO = new WeakMap();

/** pre (круг 52) — готовое раскрытие {ex, nodes} от solveAfter, чтобы не раскрывать второй раз. */
function solveWith(doc, opts, seed, pre) {
  const options = opts || {};
  const ctx = {
    doc,
    nodes: (doc && doc.nodes) || {},
    m: makeMeasurer(options),
    measCache: seed ? seed.meas : new Map(),
    flowCache: seed ? seed.flow : new Map(),
    stack: new Set(),   // узлы, которые меряются прямо сейчас — ловит циклы
    placed: new Set(),  // уже размещённые — ловит узел с двумя родителями
    rects: {}, lines: {}, order: [],
    span: new Map(),    // круг 51: id → [начало, конец) отрезка поддерева в seq
    seq: null,          // круг 52: все размещённые узлы по порядку, с раскрытыми; без экземпляров — сам order
    prev: seed ? seed.geo : null,
    prevSpan: seed ? seed.span : null,
    prevSeq: seed ? seed.seq : null,
    // круг 52: форма экземпляра + ограничения → мера; форма + размер → образец раскладки поддерева
    // (на одну доску). shapes:false — без образцов: эталон для тестов
    shapeMeas: options.shapes === false ? null : new Map(),
    shapePlaced: options.shapes === false ? null : new Map(),
    dirty: seed ? seed.dirty : null,
  };
  const geo = { rects: ctx.rects, lines: ctx.lines, order: ctx.order, expanded: {} };
  if (!doc || !doc.nodes || !doc.nodes[doc.root]) {
    logOnce('solve:empty', 'solve: документ пуст или повреждён');
    return geo;
  }
  /* Круг 19, п.4 (SPEC §5.6): экземпляры раскрываются ДО раскладки — один раз,
     чистой функцией от документа. Дальше решатель работает с общей картой
     «документ + раскрытые узлы» и не получает ни одного особого случая: поток,
     hug/fill, перенос текста и обрезка считаются раскрытому поддереву так же,
     как настоящему. Раскрытые узлы наружу отдаются в geo.expanded — по ним
     рисует Stage, в doc.nodes их нет и не будет. */
  const given = seed || pre;
  const ex = given && given.ex ? given.ex : expandDoc(doc);
  geo.expanded = ex.nodes;
  if (ex.count) ctx.nodes = given && given.nodes ? given.nodes : { ...doc.nodes, ...ex.nodes };
  ctx.seq = ex.count ? [] : ctx.order;
  const root = doc.nodes[doc.root];
  ctx.rects[root.id] = { x: 0, y: 0, w: 0, h: 0 };
  for (const id of kidsOf(root)) {
    const child = ownNode(ctx.nodes, id);
    if (!child) continue;
    const pos = nodePos(child);
    // круг 48: шрифты темы доски меняют меры её текстов — доска меряется своими токенами
    const real = ownNode(doc.nodes, id);
    ctx.doc = real && real.type === 'frame' ? themedDoc(doc, real) : doc;
    // образцы экземпляров — внутри одной доски: тема доски меняет меры текстов
    if (ex.count && ctx.shapePlaced) { ctx.shapeMeas.clear(); ctx.shapePlaced.clear(); }
    const m = measureNode(ctx, child, null, null);
    placeNode(ctx, child, r2(pos.x), r2(pos.y), m.w, m.h);
  }
  ctx.doc = doc;
  // круг 51: заготовка для следующей раскладки по месту правки — по просьбе (incremental). Круг 52: и с
  // экземплярами — память держит общую карту «документ + раскрытые», по ней ищутся грязные узлы
  if (options.incremental === true || seed) {
    SOLVE_MEMO.set(geo, { doc, nodes: ctx.nodes, seq: ctx.seq, fn: options.measureText || null, epoch: measureEpochValue, meas: ctx.measCache, flow: ctx.flowCache, span: ctx.span });
  }
  const forced = options.selfTest === true;
  if ((selfTestState === 0 || forced) && !options.__inSelfTest && !seed) {
    const prev = selfTestState;
    selfTestState = 1;
    try {
      const again = solve(doc, { ...options, __inSelfTest: true });
      if (hashGeometry(again) !== hashGeometry(geo)) {
        logOnce('solve:nondet', 'решатель недетерминирован: два прохода дали разную геометрию');
        selfTestState = prev;
      } else selfTestState = 2;
    } catch (e) {
      logOnce('solve:selftest', 'самотест решателя не выполнился', e);
      selfTestState = prev;
    }
  }
  return geo;
}

/**
 * Круг 51 (SPEC §18): раскладка ПО МЕСТУ ПРАВКИ. Полная раскладка после каждой правки держит
 * бюджет кадра (16 мс) лишь до ~750 слоёв (пилот). Здесь пересчитывается
 * только изменённое: узлы правки и их предки (в прежнем и новом документе) теряют записи кешей
 * мер и потоков; остальное меряется из кеша, а чистое поддерево того же размера переносится из
 * прежней геометрии со сдвигом. Что изменилось — по самим документам (dirtyAfter), операции —
 * только для вызывающего. Результат — тот же, что у solve(nextDoc) (тесты на случайных правках).
 * Когда так нельзя — честно полная раскладка:
 *   • prevGeo не от solve этого же prevDoc (или уже использована) или другой измеритель/эпоха шрифтов;
 *   • изменились токены, тема доски, узел перешёл на другую доску.
 * Круг 52: документы с экземплярами — тоже по месту: грязные ищутся по общей карте «документ +
 * раскрытые узлы»; правка мастера пачкает все его экземпляры, правка вне экземпляров — ни одного.
 * prevGeo после этого — использованная: её кеши перешли новой геометрии.
 * @param {object} prevGeo @param {object} prevDoc @param {object} nextDoc @param {object[]} [opsList]
 * @param {{measureText?:Function}} [opts]
 * @returns {object} geo
 */
function solveAfter(prevGeo, prevDoc, nextDoc, opsList, opts) {
  const options = opts || {};
  const memo = prevGeo ? SOLVE_MEMO.get(prevGeo) : null;
  if (!memo || memo.doc !== prevDoc || memo.fn !== (options.measureText || null) || memo.epoch !== measureEpochValue) {
    return solve(nextDoc, { ...options, incremental: true });
  }
  // круг 52: раскрытие кешировано по объекту экземпляра и его зависимостям (expandCache), поэтому у
  // нетронутых экземпляров раскрытые узлы — те же объекты, и сравнение по тождеству видит только правку
  const ex = expandDoc(nextDoc);
  const nodes = ex.count && isObj(nextDoc && nextDoc.nodes) ? { ...nextDoc.nodes, ...ex.nodes } : null;
  // грязного больше половины (правка мастера с тысячами экземпляров) — полная раскладка дешевле:
  // ей не нужно ни снимать записи кешей, ни сверять размеры чистых; раскрытие она берёт готовое
  const half = Math.floor(Object.keys(nodes || nextDoc.nodes).length / 2);
  const dirty = dirtyAfter(prevDoc, nextDoc, memo.nodes, nodes, half);
  if (!dirty || dirty.size > half) return solveWith(nextDoc, { ...options, incremental: true }, null, { ex, nodes });
  SOLVE_MEMO.delete(prevGeo);
  for (const id of dirty) { memo.meas.delete(id); memo.flow.delete(id); }
  return solveWith(nextDoc, { ...options, __inSelfTest: true },
    { meas: memo.meas, flow: memo.flow, geo: prevGeo, span: memo.span, seq: memo.seq, dirty, ex, nodes });
}

/**
 * Круг 51: правка не тронула геометрию (имя, замок…) — та же geo годится и для nextDoc; память
 * раскладки переходит к nextDoc, чтобы следующая правка снова шла по месту, а не полностью.
 * @returns {object} geo
 */
function solveCarry(geo, prevDoc, nextDoc) {
  const memo = geo ? SOLVE_MEMO.get(geo) : null;
  if (memo && memo.doc === prevDoc) memo.doc = nextDoc;
  return geo;
}

/**
 * Узлы, чья раскладка могла измениться, — по самим документам, а не по операциям: applyOps делит
 * неизменённые узлы между версиями, поэтому изменённый узел — тот, чей объект другой (или его нет
 * в одной из версий). Так верно и для чужой транзакции поверх своих неподтверждённых правок, и
 * для починки при применении. Плюс все предки — до и после. null — только полная раскладка.
 * prevNodes/nextNodes (круг 52) — общие карты «документ + раскрытые узлы», если есть экземпляры;
 * maxChanged — изменённых больше: null сразу, без подъёма к предкам.
 */
function dirtyAfter(prevDoc, nextDoc, prevNodes, nextNodes, maxChanged) {
  if (!prevDoc || !nextDoc || !isObj(prevDoc.nodes) || !isObj(nextDoc.nodes)) return null;
  if (prevDoc.tokens !== nextDoc.tokens || prevDoc.root !== nextDoc.root) return null;
  const P = prevNodes || prevDoc.nodes;
  const N = nextNodes || nextDoc.nodes;
  const root = nextDoc.root;
  const boardOfIn = (nodes, id) => {
    let cur = id;
    for (let guard = 0; typeof cur === 'string' && guard <= MAX_DEPTH + 2; guard++) {
      const n = ownNode(nodes, cur);
      if (!n) return null;
      if (n.parent === root) return cur;
      cur = n.parent;
    }
    return null;
  };
  const changed = [];
  for (const id of Object.keys(N)) if (ownNode(P, id) !== N[id]) changed.push(id);
  for (const id of Object.keys(P)) if (!hasOwnProp.call(N, id)) changed.push(id);
  if (isNum(maxChanged) && changed.length > maxChanged) return null;
  const dirty = new Set();
  // круг 52: свой «уже пройден» у каждой версии — правка мастера пачкает тысячи раскрытых узлов, и
  // подъём от каждого до корня прежнего документа стоил бы больше самой раскладки
  const seenP = new Set();
  const seenN = new Set();
  const up = (nodes, id) => {
    const seen = nodes === N ? seenN : seenP;
    let cur = id;
    for (let guard = 0; typeof cur === 'string' && guard <= MAX_DEPTH + 2; guard++) {
      if (seen.has(cur)) return;   // предки уже отмечены этим же проходом
      seen.add(cur);
      dirty.add(cur);
      const n = ownNode(nodes, cur);
      if (!n) return;
      cur = n.parent;
    }
  };
  for (const id of changed) {
    const a = ownNode(P, id);
    const b = ownNode(N, id);
    if (a && b) {
      // тема доски меняет меры всех её текстов — только полная
      if (b.parent === root && JSON.stringify(a.theme) !== JSON.stringify(b.theme)) return null;
      // перенос между досками: поддерево меряется другой темой — только полная
      if (a.parent !== b.parent && boardOfIn(P, id) !== boardOfIn(N, id)) return null;
    }
    up(P, id);
    up(N, id);
  }
  return dirty;
}

/**
 * Устойчивый хэш геометрии (FNV-1a) — для тестов детерминированности и кеша отрисовки.
 * @param {{rects:object, lines:object, order:string[]}} geo
 * @returns {string}
 */
function hashGeometry(geo) {
  if (!geo || !geo.rects) return '0';
  let s = '';
  for (const id of Object.keys(geo.rects).sort()) {
    const r = geo.rects[id];
    s += id + ':' + r2(r.x) + ',' + r2(r.y) + ',' + r2(r.w) + ',' + r2(r.h) + ';';
  }
  s += '|';
  for (const id of Object.keys(geo.lines || {}).sort()) s += id + ':' + (geo.lines[id] || []).join('\u0001') + ';';
  s += '|' + (geo.order || []).join(',');
  /* Круг 16, п.8: два независимых счёта вместо одного — ключ 64 бита, а не 32.
     На этом хэше держится вывод «геометрия не менялась»: совпадение у РАЗНЫХ
     макетов означает молчаливое «ничего не изменилось» там, где изменилось всё.
     Вероятность и на 32 битах ничтожна (2⁻³²), но цена второго счёта — один
     умножитель на символ (на 40 477 узлах +20 мс к 90), а цена ошибки — молчание,
     которого не объяснишь. Сама строка s уже собрана — она и есть дорогая часть.
     Круг 22: тот же счёт вынесен в fnv64 — им же считается hashDoc. */
  return fnv64(s);
}

/* ------------------------------------------------------------------ *
 * 7. Цвет и контраст (WCAG 2.1)
 * ------------------------------------------------------------------ */

/**
 * Значение цвета → '#rrggbb'. Принимает имя токена, hex (#rgb/#rrggbb),
 * а также формы {token}, {color} и {value} — оболочка пишет заливки как {token:'surface'}.
 * @returns {string|null}
 */
function resolveColor(doc, value) {
  let v = value;
  // круг 37: градиент — цвет стопа, ближайшего к середине (контраст, описания, плашка доски)
  if (isGradientPaint(v)) return gradientMidColor(doc, v.gradient);
  // круг 49: фактура как один цвет — её подложка (на ней стоит текст); без подложки — прозрачна
  if (isPatternPaint(v)) return typeof v.pattern.bg === 'string' ? resolveColor(doc, v.pattern.bg) : null;
  if (v && typeof v === 'object') {
    v = v.token !== undefined ? v.token : v.color !== undefined ? v.color : v.value;
  }
  if (typeof v !== 'string' || !v) return null;
  const tokens = (doc && doc.tokens && isObj(doc.tokens.colors) && doc.tokens.colors) || DEFAULT_TOKENS.colors;
  // круг 29: только своё свойство палитры и только строка — `colors.constructor`
  // давал функцию, а объект в палитре старого документа ронял проверку ниже
  const named = ownNode(tokens, v);
  if (named !== undefined) v = named;
  if (typeof v !== 'string' || v[0] !== '#') return null;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7).toLowerCase();
  return null;
}

/** Цвет стопа градиента, ближайшего к середине. @returns {string|null} */
function gradientMidColor(doc, g) {
  const stops = Array.isArray(g.stops) ? g.stops : [];
  let best = null;
  let dist = Infinity;
  for (const st of stops) {
    if (!isObj(st)) continue;
    const c = resolveColor(doc, typeof st.token === 'string' ? st.token : st.color);
    if (!c) continue;
    const dd = Math.abs((isNum(st.at) ? st.at : 0) - 0.5);
    if (dd < dist) { dist = dd; best = c; }
  }
  return best;
}

/**
 * Краска → значение для отрисовки (круг 37, SPEC §12.1). Единственное место, где
 * градиент становится числами: сцена, экспорт, образцы в инспекторе и мозг читают
 * краску только так. Стоп с неразрешимым цветом пропускается (о нём скажет
 * dead-color-ref); градиент без живых стопов — краски нет.
 * @param {object} doc @param {any} paint
 * @returns {null|{type:'color', color:string}|{type:'gradient', kind:string, angle:number, cx:number, cy:number, r:number,
 *   stops:Array<{at:number, color:string, opacity:number}>}}
 */
function resolvePaint(doc, paint) {
  // круг 49 (SPEC §16): фактура — цвет узора обязателен, подложка — по желанию
  if (isPatternPaint(paint)) {
    const pt = paint.pattern;
    const color = resolveColor(doc, pt.color);
    if (!color || !PATTERN_KIND_SET.has(pt.kind)) return null;
    const size = numIn(pt.size, PATTERN_LIMITS.minSize, PATTERN_LIMITS.maxSize, PATTERN_LIMITS.defaultSize);
    return {
      type: 'pattern', kind: pt.kind, color, bg: typeof pt.bg === 'string' ? resolveColor(doc, pt.bg) : null,
      size, weight: numIn(pt.weight, PATTERN_LIMITS.minWeight, PATTERN_LIMITS.maxWeight, patternWeight(pt.kind, size)),
      angle: numIn(pt.angle, 0, 360, 0), opacity: numIn(pt.opacity, 0, 1, 1)
    };
  }
  if (isGradientPaint(paint)) {
    const g = paint.gradient;
    const stops = [];
    for (const st of Array.isArray(g.stops) ? g.stops.slice(0, VECTOR_LIMITS.maxStops) : []) {
      if (!isObj(st)) continue;
      const color = resolveColor(doc, typeof st.token === 'string' ? st.token : st.color);
      if (!color) continue;
      stops.push({ at: numIn(st.at, 0, 1, 0), color, opacity: numIn(st.opacity, 0, 1, 1) });
    }
    if (!stops.length) return null;
    return {
      type: 'gradient', kind: g.kind === 'radial' ? 'radial' : 'linear',
      angle: numIn(g.angle, 0, 360, 180), cx: numIn(g.cx, 0, 1, 0.5), cy: numIn(g.cy, 0, 1, 0.5), r: numIn(g.r, 0, 1, 0.5),
      stops
    };
  }
  const color = resolveColor(doc, paint);
  return color ? { type: 'color', color } : null;
}

/** Круг 49: толщина узора по умолчанию — от шага плитки. */
function patternWeight(kind, size) {
  const w = kind === 'dots' ? size * 0.12 : kind === 'lines' ? size * 0.25 : kind === 'waves' ? size * 0.08
    : kind === 'grain' ? size * 0.05 : 1;
  return clamp(r2(Math.max(kind === 'grain' ? 0.6 : 1, w)), PATTERN_LIMITS.minWeight, PATTERN_LIMITS.maxWeight);
}

/** Круг 49: точки «зерна» в плитке — постоянные доли (детерминированно, без случайности). */
const GRAIN_POINTS = Object.freeze([[0.13, 0.21], [0.62, 0.08], [0.41, 0.47], [0.86, 0.39], [0.24, 0.78], [0.71, 0.69], [0.52, 0.93], [0.93, 0.88]]);

/**
 * Круг 49: плитка фактуры — список фигур {tag, attrs} в координатах плитки size×size.
 * Одна запись и для сцены, и для экспорта SVG, и для снимка без страницы.
 */
function patternTile(p) {
  const s = p.size;
  const w = p.weight;
  const c = p.color;
  const o = p.opacity < 1 ? r2(p.opacity) : undefined;
  const fillShape = (tag, attrs) => ({ tag, attrs: { ...attrs, fill: c, 'fill-opacity': o } });
  switch (p.kind) {
    case 'dots': return [fillShape('circle', { cx: r2(s / 2), cy: r2(s / 2), r: r2(Math.min(w, s / 2)) })];
    case 'lines': return [fillShape('rect', { x: 0, y: 0, width: s, height: r2(Math.min(w, s)) })];
    case 'grid': return [fillShape('rect', { x: 0, y: 0, width: s, height: r2(Math.min(w, s)) }), fillShape('rect', { x: 0, y: 0, width: r2(Math.min(w, s)), height: s })];
    case 'checks': return [fillShape('rect', { x: 0, y: 0, width: r2(s / 2), height: r2(s / 2) }), fillShape('rect', { x: r2(s / 2), y: r2(s / 2), width: r2(s / 2), height: r2(s / 2) })];
    case 'waves': {
      const m = r2(s / 2);
      const a = r2(s / 4);
      return [{ tag: 'path', attrs: { d: `M0 ${m} Q${a} ${r2(m - a)} ${m} ${m} T${s} ${m}`, fill: 'none', stroke: c, 'stroke-width': r2(Math.min(w, s / 2)), 'stroke-opacity': o } }];
    }
    case 'grain': return GRAIN_POINTS.map(([fx, fy]) => fillShape('circle', { cx: r2(fx * s), cy: r2(fy * s), r: r2(Math.min(w, s / 4)) }));
    default: return [];
  }
}

/** '#rrggbb' + прозрачность → CSS. */
function cssColor(hex, opacity) {
  if (!isNum(opacity) || opacity >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${r2(opacity)})`;
}

/**
 * Краска как CSS-фон — для образцов в инспекторе и списке контуров.
 * @returns {string|null} '#hex' | 'linear-gradient(…)' | 'radial-gradient(…)'
 */
function paintCss(doc, paint) {
  const p = resolvePaint(doc, paint);
  if (!p) return null;
  if (p.type === 'color') return p.color;
  if (p.type === 'pattern') return patternCss(p);
  const stops = p.stops.map((s) => `${cssColor(s.color, s.opacity)} ${r2(s.at * 100)}%`).join(', ');
  return p.kind === 'radial'
    ? `radial-gradient(circle at ${r2(p.cx * 100)}% ${r2(p.cy * 100)}%, ${stops})`
    : `linear-gradient(${r2(p.angle)}deg, ${stops})`;
}

/** Круг 49: фактура как CSS-фон образца (приближённо: вид узора, шаг, цвет и подложка). */
function patternCss(p) {
  const c = cssColor(p.color, p.opacity);
  const s = r2(p.size);
  const w = r2(p.weight);
  const tile = `0 0 / ${s}px ${s}px`;
  let layers;
  if (p.kind === 'dots' || p.kind === 'grain') layers = [`radial-gradient(circle, ${c} ${w}px, transparent ${r2(p.weight + 0.5)}px) ${tile}`];
  else if (p.kind === 'lines' || p.kind === 'waves') layers = [`repeating-linear-gradient(${r2((p.angle + 180) % 360)}deg, ${c} 0 ${w}px, transparent ${w}px ${s}px)`];
  else if (p.kind === 'grid') layers = [`linear-gradient(${c} ${w}px, transparent ${w}px) ${tile}`, `linear-gradient(90deg, ${c} ${w}px, transparent ${w}px) ${tile}`];
  else layers = [`conic-gradient(${c} 25%, transparent 0 50%, ${c} 0 75%, transparent 0) ${tile}`];
  if (p.bg) layers.push(p.bg);
  return layers.join(', ');
}

/**
 * Сводка вектора для описаний и слоёв: сколько контуров и команд, какие цвета.
 * @returns {{paths:number, commands:number, colors:string[], gradients:number}}
 */
function vectorSummary(doc, node) {
  const out = { paths: 0, commands: 0, colors: [], gradients: 0 };
  if (!node || node.type !== 'vector' || !Array.isArray(node.paths)) return out;
  const seen = new Set();
  const take = (paint) => {
    if (paint === undefined || paint === null) return;
    if (isGradientPaint(paint)) out.gradients++;
    const c = resolveColor(doc, paint);
    if (c && !seen.has(c)) { seen.add(c); out.colors.push(c); }
  };
  for (const p of node.paths) {
    if (!isObj(p)) continue;
    out.paths++;
    out.commands += pathCheck(p.d, p).count;
    take(p.fill === undefined ? node.fill : p.fill);
    take(p.stroke === undefined ? (isObj(node.stroke) ? node.stroke.color : node.stroke) : p.stroke);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 7a. Движение и состояния: разрешение в значения для отрисовки (круг 36, SPEC §11)
 *
 * ЕДИНСТВЕННОЕ место, где ссылки motion.* / shadow.* и подъём состояния
 * становятся числами и CSS: сцена, экспорт SVG, валидатор, мозг и оболочка
 * читают их только через эти функции.
 * ------------------------------------------------------------------ */

/** Значение шага шкалы движения или теней; undefined — шаг мёртв (шкала есть, шага нет). */
function scaleTokenStep(doc, group, step) {
  const own = doc && doc.tokens && doc.tokens[group];
  const ok = group === 'motion' ? motionStepOk : shadowStepOk;
  const dflt = group === 'motion' ? DEFAULT_MOTION : DEFAULT_SHADOW;
  if (own === undefined || own === null) return dflt[step];   // шкалы нет — умолчания ядра
  if (!isObj(own)) return undefined;
  const v = hasOwnProp.call(own, step) ? own[step] : undefined;
  return ok(v) ? v : undefined;
}

/**
 * Шкала длительностей документа: {fast, base, slow} в мс; мёртвый шаг — умолчание ядра.
 * @returns {{fast:number, base:number, slow:number}}
 */
function motionScale(doc) {
  const out = {};
  for (const k of MOTION_STEPS) {
    const v = scaleTokenStep(doc, 'motion', k);
    out[k] = v === undefined ? DEFAULT_MOTION[k] : v;
  }
  return out;
}

/**
 * Длительность в мс: число — как есть (в пределах), ссылка — шаг шкалы
 * (мёртвый — умолчание ядра), прочее — undefined.
 * @returns {number|undefined}
 */
function resolveDuration(doc, v) {
  if (isNum(v)) return clamp(v, STATE_LIMITS.duration[0], STATE_LIMITS.duration[1]);
  const m = typeof v === 'string' ? MOTION_REF_RE.exec(v) : null;
  if (!m) return undefined;
  const step = scaleTokenStep(doc, 'motion', m[1]);
  return step === undefined ? DEFAULT_MOTION[m[1]] : step;
}

/**
 * Движение узла для отрисовки (SPEC §11.1). Без motion — шаг 'motion.base',
 * кривая 'standard', без задержки, follow 'self'.
 * @param {object} doc
 * @param {object} node
 * @returns {{durationMs:number, easing:string, easingName:string, delayMs:number, follow:'self'|'parent'}}
 *   easing — строка CSS cubic-bezier(…)
 */
function resolveMotion(doc, node) {
  const m = node && isObj(node.motion) ? node.motion : {};
  let durationMs = resolveDuration(doc, m.duration);
  if (durationMs === undefined) durationMs = resolveDuration(doc, 'motion.base');
  const easingName = typeof m.easing === 'string' && hasOwnProp.call(EASINGS, m.easing) ? m.easing : 'standard';
  const delayMs = isNum(m.delay) ? clamp(m.delay, STATE_LIMITS.delay[0], STATE_LIMITS.delay[1]) : 0;
  return { durationMs, easing: EASINGS[easingName], easingName, delayMs, follow: m.follow === 'parent' ? 'parent' : 'self' };
}

/**
 * Тень для отрисовки: ссылка (или 'none') → CSS-фильтр drop-shadow(…).
 * Мёртвый шаг — умолчание ядра (dead: true); мусор — без тени.
 * @param {object} doc
 * @param {any} ref 'none' | 'shadow.sm' | 'shadow.md' | 'shadow.lg'
 * @returns {{ref:string, filter:string, dead:boolean, dx?:number, dy?:number, blur?:number, color?:string}}
 *   filter — значение CSS-свойства filter ('none' либо 'drop-shadow(dx dy blur цвет)')
 */
function resolveShadow(doc, ref) {
  const m = typeof ref === 'string' ? SHADOW_REF_RE.exec(ref) : null;
  if (!m) return { ref: 'none', filter: 'none', dead: false };
  let desc = scaleTokenStep(doc, 'shadow', m[1]);
  const dead = desc === undefined;
  if (dead) desc = DEFAULT_SHADOW[m[1]];
  const sh = parseShadow(desc);
  if (!sh || sh === 'none') return { ref, filter: 'none', dead };
  return {
    ref, dead, dx: sh.dx, dy: sh.dy, blur: sh.blur, color: sh.color,
    filter: `drop-shadow(${r2(sh.dx)}px ${r2(sh.dy)}px ${r2(sh.blur)}px ${sh.color.replace(/\s+/g, '')})`
  };
}

/** Подъём состояния в px: число — в пределах, ссылка на шаг spacing — его значение (мёртвая — 0). */
function resolveLift(doc, v) {
  const x = resolveScale(doc, v, 'spacing');
  return isNum(x) ? clamp(x, STATE_LIMITS.lift[0], STATE_LIMITS.lift[1]) : 0;
}

/** Список состояний к наложению: null/'' — база; строка или массив; порядок — STATE_NAMES. */
function stateList(state) {
  const want = Array.isArray(state) ? state : state ? [state] : [];
  return STATE_NAMES.filter((s) => want.indexOf(s) >= 0);
}

/**
 * Итоговый вид узла в состоянии (SPEC §11.1, §11.3): база узла, поверх —
 * патчи состояний в порядке hover → focus → press (как каскад CSS).
 * Цвета — через resolveColor, подъём — через шкалу отступов, тень — CSS-фильтр.
 * Решатель это не читает: геометрия от состояния не зависит.
 * @param {object} doc
 * @param {object} node узел (для экземпляра — раскрытый корень, см. geo.expanded)
 * @param {'hover'|'press'|'focus'|Array<string>|null} [state] null — базовое состояние
 * @returns {{states:string[], fill:string|null, stroke:string|null, strokeWidth:number,
 *   color:string|null, opacity:number, scale:number, lift:number, shadow:string,
 *   filter:string, transform:string, changed:string[]}}
 *   transform — CSS ('none' либо 'translate(0px, -Npx) scale(k)', от центра узла);
 *   changed — поля, которыми состояние отличается от базы (пусто — state-no-effect)
 */
function resolveState(doc, node, state) {
  const n = node && typeof node === 'object' ? node : {};
  const strokeOf = (v) => {
    if (v === null || v === undefined) return { stroke: null, width: 1 };
    const color = resolveColor(doc, isObj(v) && v.color !== undefined ? v.color : v);
    return { stroke: color, width: isObj(v) && isNum(v.width) ? v.width : 1 };
  };
  const st0 = strokeOf(n.stroke);
  const base = {
    fill: resolveColor(doc, n.fill),
    stroke: st0.stroke,
    strokeWidth: st0.width,
    color: n.type === 'text' ? (resolveColor(doc, n.color) || '#14161c') : resolveColor(doc, n.color),
    opacity: isNum(n.opacity) ? clamp(n.opacity, 0, 1) : 1,
    scale: 1,
    lift: 0,
    shadow: shadowRefProblem(n.shadow, '') ? 'none' : n.shadow
  };
  const out = { ...base };
  const applied = [];
  const states = isObj(n.states) ? n.states : {};
  for (const s of stateList(state)) {
    const p = states[s];
    if (!isObj(p)) continue;
    applied.push(s);
    if (p.fill !== undefined) out.fill = resolveColor(doc, p.fill);
    if (p.color !== undefined) out.color = resolveColor(doc, p.color) || base.color;
    if (p.stroke !== undefined) { const t = strokeOf(p.stroke); out.stroke = t.stroke; out.strokeWidth = t.width; }
    if (isNum(p.opacity)) out.opacity = clamp(p.opacity, 0, 1);
    if (isNum(p.scale)) out.scale = clamp(p.scale, STATE_LIMITS.scale[0], STATE_LIMITS.scale[1]);
    if (p.lift !== undefined) out.lift = resolveLift(doc, p.lift);
    if (p.shadow !== undefined && !shadowRefProblem(p.shadow, '')) out.shadow = p.shadow;
  }
  const changed = [];
  for (const k of ['fill', 'stroke', 'strokeWidth', 'color', 'opacity', 'scale', 'lift', 'shadow']) {
    if (out[k] !== base[k]) changed.push(k);
  }
  out.filter = resolveShadow(doc, out.shadow).filter;
  out.transform = out.lift === 0 && out.scale === 1 ? 'none'
    : `translate(0px, ${r2(-out.lift)}px) scale(${r2(out.scale)})`;
  out.states = applied;
  out.changed = changed;
  return out;
}

/**
 * Строка CSS transition для узла (сцена и экспорт — одна запись).
 * @param {{durationMs:number, easing:string, delayMs:number}} mo результат resolveMotion
 * @param {string[]} props свойства
 * @returns {string}
 */
function transitionCss(mo, props) {
  return props.map((p) => `${p} ${r2(mo.durationMs)}ms ${mo.easing} ${r2(mo.delayMs)}ms`).join(', ');
}

function channelLum(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/**
 * Коэффициент контраста WCAG 2.1 между двумя цветами '#rrggbb'.
 * @returns {number} 1..21
 */
function contrastRatio(hexA, hexB) {
  if (!hexA || !hexB) return 21;
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ *
 * 8. Валидаторы
 * ------------------------------------------------------------------ */

/* Круг 19, п.7 (SPEC §5.8): четыре кода про компоненты. Первые три блокирующие —
   документ с ними нельзя показать как верный; вложенность глубже предела — warn:
   макет при этом рисуется, просто дальше предела не раскрывается. */
/* Круг 20 (SPEC §6.1): dead-scale-ref — ссылка на шаг, которого в шкале нет;
   блокирующая: решатель считает такой шаг нулём, и макет уже не тот, что задуман.
   off-scale для чисел остаётся как был — мягкое замечание. */
const SEVERITY = { overflow: 'error', 'out-of-parent': 'error', 'dead-instance': 'error', 'unknown-prop': 'error', 'component-cycle': 'error', 'dead-scale-ref': 'error', 'bad-children': 'warn', 'padding-eaten': 'warn', 'no-geometry': 'warn', 'zero-size': 'warn', overlap: 'warn', 'low-contrast': 'warn', 'instance-too-deep': 'warn', 'expand-limit': 'error', 'off-scale': 'info', 'empty-frame': 'info',
  /* Круг 36 (SPEC §11.2): состояния и движение */
  'state-on-page': 'error', 'motion-slow': 'warn', 'dead-motion-ref': 'warn', 'state-no-effect': 'info', 'press-without-hover': 'info',
  /* Круг 37 (SPEC §12.1): векторы и краски */
  'bad-path': 'error', 'vector-empty': 'warn', 'dead-color-ref': 'warn', 'path-heavy': 'info',
  /* Круг 48 (SPEC §15): тема доски */
  'theme-not-board': 'info' };
const SEV_RANK = { error: 0, warn: 1, info: 2 };

function nearestFill(doc, node) {
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 512) {
    const hex = resolveColor(doc, cur.fill);
    if (hex) return hex;
    cur = cur.parent ? ownNode(doc.nodes, cur.parent) : null;
  }
  return resolveColor(doc, (doc.tokens && doc.tokens.colors && doc.tokens.colors.canvas) || '#ffffff');
}

/**
 * Проверки компонентов (круг 19, п.7; SPEC §5.8): dead-instance, unknown-prop,
 * component-cycle, instance-too-deep. Считается по СТРУКТУРЕ, без геометрии:
 * мёртвая ссылка и самовключение — свойства документа, а не раскладки.
 * @param {object} doc
 * @param {(code:string,nodeId:string,message:string)=>void} add
 */
function validateComponents(doc, add) {
  const lib = libraryNode(doc);
  /** мастера библиотеки: id → узел, в порядке детей библиотеки */
  const masters = new Map();
  if (lib) {
    for (const id of kidsOf(lib)) {
      const n = nodeById(doc, id);
      if (n && n.component && typeof n.component === 'object') masters.set(id, n);
    }
  }
  const instances = [];
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (n && n.type === 'instance') instances.push(n);
  }
  if (!instances.length && !masters.size) return;

  /** мастер → мастера, чьи экземпляры лежат внутри него */
  const uses = new Map();
  for (const mid of masters.keys()) {
    const set = new Set();
    for (const nid of subtreeIds(doc, mid)) {
      const n = doc.nodes[nid];
      if (n && n.type === 'instance' && typeof n.of === 'string') set.add(n.of);
    }
    uses.set(mid, set);
  }
  // самовключение: от мастера по ссылкам можно вернуться в него же
  const cyclic = new Set();
  for (const mid of masters.keys()) {
    const seen = new Set();
    const stack = [...(uses.get(mid) || [])];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === mid) { cyclic.add(mid); break; }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nx of (uses.get(cur) || [])) stack.push(nx);
    }
  }
  for (const [mid, m] of masters) {
    if (cyclic.has(mid)) {
      add('component-cycle', mid, `компонент «${componentName(m)}» содержит экземпляр самого себя`);
    }
  }
  /** насколько глубоко вкладываются экземпляры, если поставить экземпляр этого мастера */
  const depthOf = new Map();
  const TOO = MAX_INSTANCE_DEPTH + 2;
  const masterDepth = (mid) => {
    if (depthOf.has(mid)) return depthOf.get(mid);
    if (cyclic.has(mid)) { depthOf.set(mid, TOO); return TOO; }
    depthOf.set(mid, 1);   // страховка от повторного входа
    let best = 1;
    for (const nx of (uses.get(mid) || [])) {
      if (!masters.has(nx)) continue;
      best = Math.max(best, 1 + masterDepth(nx));
      if (best >= TOO) break;
    }
    depthOf.set(mid, best);
    return best;
  };

  for (const n of instances) {
    const master = masters.get(n.of);
    if (!master) {
      add('dead-instance', n.id, nodeById(doc, n.of)
        ? `«${displayName(doc, n)}»: «${shown(n.of)}» — не компонент библиотеки`
        : `«${displayName(doc, n)}»: компонента «${shown(n.of)}» в документе нет`);
      continue;
    }
    const known = propMap(master);
    const given = n.props && typeof n.props === 'object' && !Array.isArray(n.props) ? n.props : {};
    for (const key of Object.keys(given).sort()) {
      if (!known.has(key)) {
        add('unknown-prop', n.id, `«${componentName(master)}» не объявлял пропс «${key}»`);
      }
    }
    // о самовключении уже сказано кодом component-cycle — вторую жалобу на те же
    // узлы не шлём, иначе на один цикл сыплется по строке на каждый экземпляр
    if (cyclic.has(master.id)) continue;
    const d = masterDepth(master.id);
    if (d > MAX_INSTANCE_DEPTH) {
      add('instance-too-deep', n.id, `вложенность экземпляров ${Math.min(d, TOO)} глубже предела ${MAX_INSTANCE_DEPTH}`
        + ` — глубже этого «${componentName(master)}» не раскрывается`);
    }
  }
  /* Круг 39 (N2): раскрытие сверх предела (документ из старого журнала — правкой
     и импортом такой не получить). Одна строка на документ — на самом дорогом
     экземпляре: решатель раскрыл не всё, и человек должен прочесть, почему. */
  if (instances.length) {
    const over = expandProblem(doc);
    if (over) {
      add('expand-limit', over.nodeId || doc.root, `${over.message}: часть экземпляров показана заглушкой`
        + ` (раскрываются только не дороже ${DEGRADED_INSTANCE_NODES} узлов) — уберите лишние экземпляры или вложенность`);
    }
  }
}

/**
 * Проверки состояний и движения одного узла (круг 36, SPEC §11.2):
 * state-on-page (error), motion-slow (warn), dead-motion-ref (warn),
 * state-no-effect (info), press-without-hover (info), off-scale (info) для
 * длительности и подъёма числом мимо шкалы. По сырому документу, без геометрии.
 * @param {object} doc @param {object} node
 * @param {(code:string,nodeId:string,message:string)=>void} add
 */
function validateMotion(doc, node, add) {
  if (!node || typeof node !== 'object') return;
  const id = node.id;
  const states = node.states;
  if (node.type === 'page') {
    if (states !== undefined) add('state-on-page', id, `«${displayName(doc, node)}»: у страницы состояний не бывает — states не применяются`);
    return;
  }
  const own = isObj(states) ? states : {};
  const animated = hasStates(node);
  const motion = isObj(node.motion) ? node.motion : null;
  const name = displayName(doc, node);
  const dead = [];
  const off = [];
  // длительность
  if (motion && typeof motion.duration === 'string' && MOTION_REF_RE.test(motion.duration)) {
    const step = motion.duration.slice('motion.'.length);
    if (scaleTokenStep(doc, 'motion', step) === undefined) dead.push(`motion.duration → «${motion.duration}»: шага нет в шкале движения, взято умолчание ${DEFAULT_MOTION[step]} мс`);
  } else if (motion && isNum(motion.duration)) {
    const sc = motionScale(doc);
    if (!MOTION_STEPS.some((k) => sc[k] === motion.duration)) off.push(`длительность ${motion.duration} мс вне шкалы движения`);
  }
  // экземпляр — по раскрытому корню: база вида и движение у него от мастера
  let look = node;
  if (node.type === 'instance' && (animated || motion)) {
    const ex = expandInstance(doc, node);
    if (ex && ex.root) look = ex.root;
  }
  const mo = resolveMotion(doc, look);
  if ((animated || motion) && mo.durationMs > MOTION_SLOW_MS) {
    add('motion-slow', id, `«${name}»: переход ${mo.durationMs} мс — для микроанимации дольше ${MOTION_SLOW_MS} мс`);
  }
  // тени: базовая и в состояниях
  const shadowDead = (ref, where) => {
    const m = typeof ref === 'string' ? SHADOW_REF_RE.exec(ref) : null;
    if (m && scaleTokenStep(doc, 'shadow', m[1]) === undefined) dead.push(`${where} → «${ref}»: шага нет в шкале теней, взята тень по умолчанию`);
  };
  shadowDead(node.shadow, 'shadow');
  const spacing = scaleSteps(doc, 'spacing');
  for (const s of STATE_NAMES) {
    const p = own[s];
    if (!isObj(p)) continue;
    shadowDead(p.shadow, `states.${s}.shadow`);
    if (isScaleRef(p.lift, 'spacing') && resolveScale(doc, p.lift, 'spacing') === undefined) {
      dead.push(`states.${s}.lift → «${p.lift}»: шага нет в шкале отступов, подъём 0`);
    } else if (isNum(p.lift) && p.lift !== 0 && spacing.indexOf(Math.abs(p.lift)) < 0) {
      off.push(`подъём ${p.lift} px (${s}) вне шкалы отступов`);
    }
    if (!resolveState(doc, look, s).changed.length) {
      add('state-no-effect', id, `«${name}»: состояние ${s} совпадает с базой — ничего не меняет`);
    }
  }
  if (dead.length) add('dead-motion-ref', id, `«${name}»: ${dead.join('; ')}`);
  if (off.length) add('off-scale', id, `«${name}»: ${off.join(', ')}`);
  if (isObj(own.press) && !isObj(own.hover)) {
    add('press-without-hover', id, `«${name}»: есть нажатие, но нет наведения — мышью отклик появится только по нажатию`);
  }
}

/**
 * Проверки макета: overflow, out-of-parent, padding-eaten, overlap, low-contrast, off-scale,
 * empty-frame, zero-size, no-geometry.
 * @param {object} doc
 * @param {object} geo результат solve
 * @param {{measureText?:Function}} [opts] тот же измеритель, что и у solve
 * @returns {Array<{code:string,nodeId:string,message:string,severity:string}>}
 */
/** Строки цвета в краске (как их читает resolveColor) — для dead-color-ref. */
function paintRefs(v, path, out) {
  if (typeof v === 'string') { out.push({ path, value: v }); return; }
  if (!isObj(v)) return;
  if (isPatternPaint(v)) {
    for (const k of ['color', 'bg']) if (typeof v.pattern[k] === 'string') out.push({ path: `${path}.pattern.${k}`, value: v.pattern[k] });
    return;
  }
  if (isGradientPaint(v)) {
    const stops = Array.isArray(v.gradient.stops) ? v.gradient.stops : [];
    stops.forEach((st, i) => {
      if (!isObj(st)) return;
      const val = typeof st.token === 'string' ? st.token : st.color;
      if (typeof val === 'string') out.push({ path: `${path}.gradient.stops.${i}`, value: val });
    });
    return;
  }
  const val = v.token !== undefined ? v.token : v.color !== undefined ? v.color : v.value;
  if (typeof val === 'string') out.push({ path, value: val });
}

/**
 * Краски и контуры узла (круг 37, SPEC §12.1): dead-color-ref — цвет, который не
 * разрешается (не #hex и не токен палитры) в заливке, цвете, обводке, состояниях,
 * контурах и стопах; у вектора — bad-path, vector-empty, path-heavy.
 */
function validatePaint(doc, node, add) {
  const refs = [];
  paintRefs(node.fill, 'fill', refs);
  paintRefs(node.color, 'color', refs);
  if (isObj(node.stroke) && !isGradientPaint(node.stroke)) {
    if (node.stroke.color !== undefined) paintRefs(node.stroke.color, 'stroke.color', refs);
    else paintRefs(node.stroke, 'stroke', refs);
  } else paintRefs(node.stroke, 'stroke', refs);
  if (isObj(node.states)) {
    for (const s of STATE_NAMES) {
      const p = node.states[s];
      if (!isObj(p)) continue;
      paintRefs(p.fill, `states.${s}.fill`, refs);
      paintRefs(p.color, `states.${s}.color`, refs);
      paintRefs(isObj(p.stroke) && p.stroke.color !== undefined ? p.stroke.color : p.stroke, `states.${s}.stroke`, refs);
    }
  }
  const name = () => displayName(doc, node);
  if (node.type === 'vector') {
    const paths = node.paths;
    if (!Array.isArray(paths)) add('bad-path', node.id, `«${name()}»: paths не массив — контуров нет`);
    else {
      let commands = 0;
      let visible = 0;
      const nodeStroke = isObj(node.stroke) ? (node.stroke.color !== undefined ? node.stroke.color : node.stroke) : node.stroke;
      paths.forEach((p, i) => {
        const err = vpathProblem(p, 'paths.' + i);
        if (err) { add('bad-path', node.id, `«${name()}»: ${err}`); return; }
        commands += pathCheck(p.d, p).count;
        paintRefs(p.fill, `paths.${i}.fill`, refs);
        paintRefs(p.stroke, `paths.${i}.stroke`, refs);
        const fill = resolvePaint(doc, p.fill !== undefined ? p.fill : node.fill);
        const stroke = resolvePaint(doc, p.stroke !== undefined ? p.stroke : nodeStroke);
        const sw = isNum(p.strokeWidth) ? p.strokeWidth : isObj(node.stroke) && isNum(node.stroke.width) ? node.stroke.width : 1;
        if ((fill || (stroke && sw > 0)) && p.opacity !== 0) visible++;
      });
      if (!paths.length) add('vector-empty', node.id, `«${name()}»: у вектора нет контуров`);
      else if (!visible) add('vector-empty', node.id, `«${name()}»: ни у одного контура нет видимой заливки или обводки`);
      if (commands > VECTOR_LIMITS.heavyCommands) {
        add('path-heavy', node.id, `«${name()}»: ${commands} команд пути — больше ${VECTOR_LIMITS.heavyCommands}, отрисовка и правка тяжелеют`);
      }
    }
  }
  const dead = refs.filter((r) => r.value && r.value !== 'none' && r.value !== 'transparent' && !resolveColor(doc, r.value));
  if (dead.length) {
    add('dead-color-ref', node.id, `«${name()}»: ${dead.slice(0, 4).map((r) => `${r.path} → «${cutText(r.value, 40)}» нет в палитре`).join('; ')}`
      + (dead.length > 4 ? ` и ещё ${dead.length - 4}` : ''));
  }
}

/**
 * Круг 48 (SPEC §15): тема не на доске не действует — сказать, а не молчать;
 * тема-мусор документа прежней версии (не по форме) — тоже не действует.
 */
function validateTheme(doc, node, add) {
  const name = displayName(doc, node);
  const bad = themeProblem(node.theme);
  if (bad) { add('theme-not-board', node.id, `«${name}»: тема не по форме (${bad}) — доска рисуется цветами документа`); return; }
  if (!isArtboard(doc, node)) add('theme-not-board', node.id, `«${name}»: тема действует только у доски (фрейма прямо на холсте) — здесь она не меняет ничего`);
}

function validate(doc, geo, opts) {
  const out = [];
  if (!doc || !doc.nodes || !geo || !geo.rects) return out;
  const m = makeMeasurer(opts || {});
  const spacing = (doc.tokens && Array.isArray(doc.tokens.spacing) ? doc.tokens.spacing : DEFAULT_TOKENS.spacing);
  const inScale = (v) => !isNum(v) || v === 0 || spacing.some((s) => Math.abs(s - v) < 0.01);
  const add = (code, nodeId, message) => out.push({ code, nodeId, message, severity: SEVERITY[code] || 'warn' });
  const ids = Object.keys(doc.nodes);
  // круг 48: цвета и шрифты узла — по теме его доски
  const at = themeScope(doc);

  for (const id of ids) {
    const node = doc.nodes[id];
    const rect = geo.rects[id];
    const tdoc = at(id);
    /* Круг 20 (SPEC §6.1): мёртвые ссылки на шкалу — до всего остального и для
       любого узла, включая страницу-библиотеку (у неё есть раскладка). Это
       свойство документа, а не геометрии: шкалу укоротили или файл принёс
       ссылку в никуда — решатель считает такой шаг нулём, человек видит
       сжатый макет и должен прочесть, почему. Одна строка на узел. */
    /* Круг 31: children у не-контейнера — не массив или непустой (документ
       прежней версии: create такого больше не пропускает). Удаление и отмена
       такой узел переживают (детей считают пустыми), но человеку и агенту
       стоит знать, что поле негодно. */
    if (node && !CONTAINER_TYPES.has(node.type) && node.children !== undefined
      && (!Array.isArray(node.children) || node.children.length)) {
      add('bad-children', id, `«${displayName(doc, node)}»: children ${Array.isArray(node.children) ? 'непустой, а дети бывают только у контейнера' : 'не массив'} — поле не читается`);
    }
    // круг 36: мёртвый шаг в подъёме состояния — dead-motion-ref (warn), см. validateMotion
    const dead = deadScaleRefs(doc, node).filter((d) => d.path.indexOf('states.') !== 0);
    validateMotion(tdoc, node, add);
    if (node && typeof node === 'object') validatePaint(tdoc, node, add);
    if (node && node.theme !== undefined) validateTheme(doc, node, add);
    if (dead.length) {
      add('dead-scale-ref', id, `«${displayName(doc, node)}»: ${dead.map((d) => `${d.path} → ${d.reason}`).join('; ')}`);
    }
    if (node.type === 'page') continue;
    if (!rect) {
      /* Круг 16, п.4: узел есть в документе, а геометрии у него нет — решатель
       * оборвал ветку (глубже MAX_DEPTH) и сказал об этом только в консоль, а
       * validate такие узлы пропускал целиком. Человек видел «узлов: 378» в
       * отчёте об импорте и 334 на холсте, и ни одно нарушение про это не
       * говорило. Говорим один раз на ветку — там, где родитель ещё размещён,
       * а ребёнок уже нет: иначе на каждую обрезанную цепочку сыпались бы
       * десятки одинаковых строк. Обычному пути это ничего не стоит: сюда
       * попадают только узлы без прямоугольника, а их в норме нет. */
      const up = node.parent ? ownNode(doc.nodes, node.parent) : null;
      if (!up || !geo.rects[up.id]) continue;              // не начало обрыва — о нём уже сказали
      const chain = ancestors(doc, id);
      const top = chain.length ? chain[chain.length - 1] : null;
      if (!top || top.id !== doc.root) continue;           // узел вообще не на этом холсте
      const lost = subtreeIds(doc, id).length;
      const depth = chain.length;
      add('no-geometry', id, `«${displayName(doc, node)}»${lost > 1 ? ` и его содержимое (всего ${lost} узлов)` : ''}`
        + ` не попал${lost > 1 ? 'и' : ''} на холст: `
        + (depth > MAX_DEPTH ? `вложенность ${depth} глубже предела ${MAX_DEPTH}` : 'решатель не дал геометрии'));
      continue;
    }

    if (rect.w <= 0.5 || rect.h <= 0.5) {
      add('zero-size', id, `«${displayName(doc, node)}»: нулевой размер (${r2(rect.w)}×${r2(rect.h)})`);
    }

    if (node.type === 'text') {
      const style = resolveTextStyle(tdoc, node);
      const mode = (node.size && node.size.w && node.size.w.mode) || 'hug';
      const lines = (geo.lines && geo.lines[id])
        || m.wrap(node.characters, style, textWrapWidth(mode, rect.w, m.natural(node.characters, style)));
      const needH = r2(lines.length * style.lineHeight);
      const widest = lines.reduce((s, l) => Math.max(s, m.width(l, style)), 0);
      if (needH > rect.h + 0.5) {
        add('overflow', id, `текст «${strOf(node.characters).slice(0, 24)}…» не помещается по высоте: нужно ${needH}, есть ${r2(rect.h)}`);
      } else if (widest > rect.w + 0.5) {
        add('overflow', id, `текст «${strOf(node.characters).slice(0, 24)}…» шире рамки: ${r2(widest)} > ${r2(rect.w)}`);
      }
      const fg = resolveColor(tdoc, node.color) || resolveColor(tdoc, 'text') || '#000000';
      const parent = node.parent ? ownNode(doc.nodes, node.parent) : null;
      const bg = nearestFill(tdoc, parent || node);
      const ratio = contrastRatio(fg, bg);
      const large = style.fontSize >= 24 || (style.fontSize >= 18.66 && style.fontWeight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        add('low-contrast', id, `контраст ${ratio.toFixed(2)}:1 при норме ${need}:1 (${fg} на ${bg})`);
      }
    }

    if (node.type === 'frame') {
      // форма хранения: ссылка на шаг по определению в шкале (inScale пропускает
      // нечисла), число проверяется на совпадение с шагом — как и раньше
      const L = normalizeLayout(node.layout);
      if (kidsOf(node).length === 0) {
        add('empty-frame', id, `фрейм «${node.name || id}» пуст`);
      }
      const bad = [];
      if (!inScale(L.gap)) bad.push('gap ' + L.gap);
      for (const k of PAD_KEYS) if (!inScale(L.padding[k])) bad.push('padding.' + k + ' ' + L.padding[k]);
      if (bad.length) add('off-scale', id, `вне шкалы отступов: ${bad.join(', ')}`);
      if (L.mode === 'none') {
        const kids = kidsOf(node).map((c) => ownNode(doc.nodes, c)).filter(Boolean);
        // круг 37: фигуры свободной рамки перекрываются намеренно — это иллюстрация
        const shape = (n) => n.type === 'vector' || n.type === 'rect' || n.type === 'ellipse';
        for (let i = 0; i < kids.length; i++) {
          if (shape(kids[i])) continue;
          for (let j = i + 1; j < kids.length; j++) {
            if (shape(kids[j])) continue;
            const a = geo.rects[kids[i].id];
            const b = geo.rects[kids[j].id];
            if (!a || !b) continue;
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ox > 0.5 && oy > 0.5) {
              add('overlap', kids[j].id, `«${kids[j].name || kids[j].id}» перекрывает «${kids[i].name || kids[i].id}» на ${r2(ox)}×${r2(oy)}`);
            }
          }
        }
      }
    }

    const parent = node.parent ? ownNode(doc.nodes, node.parent) : null;
    if (parent && parent.id !== doc.root) {
      const pr = geo.rects[parent.id];
      if (pr) {
        const dx = Math.max(pr.x - rect.x, (rect.x + rect.w) - (pr.x + pr.w));
        const dy = Math.max(pr.y - rect.y, (rect.y + rect.h) - (pr.y + pr.h));
        // круг 37: в свободной рамке с обрезкой выход за край — кадрирование, а не ошибка
        const cropped = parent.clip === true && isFreeFrame(parent);
        if ((dx > 0.5 || dy > 0.5) && cropped) {
          // ничего: деталь иллюстрации срезается рамкой намеренно
        } else if (dx > 0.5 || dy > 0.5) {
          add('out-of-parent', id, `«${node.name || id}» выходит за «${parent.name || parent.id}» на ${r2(Math.max(0, dx))}×${r2(Math.max(0, dy))}`);
        } else if (!node.override && CONTAINER_TYPES.has(parent.type)) {
          /* Круг 16, п.2: ребёнок ПОТОКА, который съел отступ контейнера, не выходил
           * за его бокс — и не давал ни одного нарушения: контейнер 100×100 с
           * padding {r:20,b:20} и ребёнок 90×40 внутри читались как «всё в порядке».
           * Считаем от ВНУТРЕННЕЙ области (бокс минус padding) и только для детей
           * потока: у отсоединённого узла override по SPEC §1.2 отсчитывается от
           * бокса родителя, и {x:0,y:0} в контейнере с отступом — законное место,
           * а не нарушение. Отдельный код, а не расширение out-of-parent: «выходит
           * за родителя» про такой узел было бы неправдой. */
          const pad = resolveLayout(doc, parent.layout).padding;
          const eats = [];
          if (pad.l && pr.x + pad.l - rect.x > 0.5) eats.push(`слева на ${r2(pr.x + pad.l - rect.x)}`);
          if (pad.t && pr.y + pad.t - rect.y > 0.5) eats.push(`сверху на ${r2(pr.y + pad.t - rect.y)}`);
          if (pad.r && (rect.x + rect.w) - (pr.x + pr.w - pad.r) > 0.5) {
            eats.push(`справа на ${r2((rect.x + rect.w) - (pr.x + pr.w - pad.r))}`);
          }
          if (pad.b && (rect.y + rect.h) - (pr.y + pr.h - pad.b) > 0.5) {
            eats.push(`снизу на ${r2((rect.y + rect.h) - (pr.y + pr.h - pad.b))}`);
          }
          if (eats.length) {
            add('padding-eaten', id, `«${displayName(doc, node)}» заходит на отступ «${displayName(doc, parent)}»: ${eats.join(', ')}`);
          }
        }
      }
    }
  }
  validateComponents(doc, add);
  out.sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity])
    || a.code.localeCompare(b.code) || a.nodeId.localeCompare(b.nodeId));
  return out;
}

/* ------------------------------------------------------------------ *
 * 9. Документ и стартовое содержимое
 * ------------------------------------------------------------------ */

function emptyDoc(name) {
  const rootId = uid('page');
  return {
    id: uid('doc'),
    version: 1,
    root: rootId,
    nodes: { [rootId]: { type: 'page', id: rootId, name: name || 'Страница', parent: null, children: [] } },
    // круг 36: новый документ несёт шкалы движения и теней явно (SPEC §11.1)
    tokens: { ...deepClone(DEFAULT_TOKENS), motion: { ...DEFAULT_MOTION }, shadow: { ...DEFAULT_SHADOW } },
    meta: { name: name || 'Без названия', createdAt: new Date().toISOString() }
  };
}

/* ------------------------------------------------------------------ *
 * 9a. Пример иллюстрации (круг 37, SPEC §12): небольшой персонаж из векторов —
 * для тестов, для пустого состояния оболочки и как образец «как устроена
 * иллюстрация»: свободная рамка с обрезкой, детали снизу вверх (тень, рога,
 * лапы, тело, животик, блик, глаза, рот…), у каждой — свой вектор ровно по
 * рамке контуров (fitVector), 2–3 тона на материал и один источник света
 * (сверху слева). Детали нарисованы в координатах холста 240×240.
 * ------------------------------------------------------------------ */

const lin = (a, b, angle) => ({ gradient: { kind: 'linear', angle: angle === undefined ? 180 : angle, stops: [{ at: 0, color: a }, { at: 1, color: b }] } });
/** Эллипс как путь из двух дуг. */
const ellD = (cx, cy, rx, ry) => `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
const MONSTER_PARTS = [
  { name: 'Тень', paths: [{ d: ellD(120, 216, 58, 8), fill: '#2b1d5c', opacity: 0.2 }] },
  { name: 'Рога', paths: [
    { name: 'Левый рог', d: 'M80 66C66 50 62 28 72 12C80 30 92 44 104 52Z', fill: lin('#ffe7a3', '#f2a33a'), stroke: '#b86b12', strokeWidth: 2, lineJoin: 'round' },
    { name: 'Правый рог', d: 'M160 66C174 50 178 28 168 12C160 30 148 44 136 52Z', fill: lin('#ffe7a3', '#f2a33a'), stroke: '#b86b12', strokeWidth: 2, lineJoin: 'round' }
  ] },
  { name: 'Ручки', paths: [
    { name: 'Левая', d: 'M52 124C30 126 20 148 30 158C38 166 52 158 58 142Z', fill: '#5d4dd6', stroke: '#33278c', strokeWidth: 3, lineJoin: 'round' },
    { name: 'Правая', d: 'M188 124C210 126 220 148 210 158C202 166 188 158 182 142Z', fill: '#5d4dd6', stroke: '#33278c', strokeWidth: 3, lineJoin: 'round' }
  ] },
  { name: 'Лапы', paths: [
    { name: 'Левая', d: 'M78 194C68 196 66 214 82 215L104 215C114 215 114 197 104 194Z', fill: lin('#5a4bd1', '#3d2fa3'), stroke: '#2a1f73', strokeWidth: 3, lineJoin: 'round' },
    { name: 'Правая', d: 'M136 194C126 197 126 215 136 215L158 215C174 214 172 196 162 194Z', fill: lin('#5a4bd1', '#3d2fa3'), stroke: '#2a1f73', strokeWidth: 3, lineJoin: 'round' }
  ] },
  { name: 'Тело', paths: [{
    d: 'M120 38C172 38 198 82 198 132C198 184 166 208 120 208C74 208 42 184 42 132C42 82 68 38 120 38Z',
    fill: { gradient: { kind: 'radial', cx: 0.38, cy: 0.3, r: 0.8, stops: [{ at: 0, color: '#ab9dff' }, { at: 0.55, color: '#7563ef' }, { at: 1, color: '#4c3cc0' }] } },
    stroke: '#33278c', strokeWidth: 3
  }] },
  { name: 'Животик', paths: [{ d: 'M120 110C150 110 168 132 168 160C168 188 146 200 120 200C94 200 72 188 72 160C72 132 90 110 120 110Z', fill: lin('#ddd6ff', '#b3a7ff'), opacity: 0.9 }] },
  { name: 'Блик тела', paths: [{ d: 'M78 74C88 56 106 48 124 48C106 56 94 70 88 88C82 88 76 82 78 74Z', fill: '#ffffff', opacity: 0.4 }] },
  { name: 'Румянец', paths: [{ d: ellD(68, 134, 11, 6.5) + ellD(172, 134, 11, 6.5), fill: '#ff8fb3', opacity: 0.6 }] },
  { name: 'Глаза', paths: [
    { name: 'Левый', d: ellD(98, 102, 17, 19), fill: { gradient: { kind: 'radial', cx: 0.4, cy: 0.35, r: 0.7, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#dcd8f5' }] } }, stroke: '#33278c', strokeWidth: 2.5 },
    { name: 'Правый', d: ellD(142, 102, 17, 19), fill: { gradient: { kind: 'radial', cx: 0.4, cy: 0.35, r: 0.7, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#dcd8f5' }] } }, stroke: '#33278c', strokeWidth: 2.5 }
  ] },
  { name: 'Зрачки', paths: [
    { name: 'Левый', d: ellD(102, 106, 8.5, 9.5), fill: '#1d1640' },
    { name: 'Правый', d: ellD(146, 106, 8.5, 9.5), fill: '#1d1640' }
  ] },
  { name: 'Блики глаз', paths: [{ d: ellD(105.5, 101, 3.2, 3.2) + ellD(149.5, 101, 3.2, 3.2), fill: '#ffffff' }] },
  { name: 'Рот', paths: [{ d: 'M100 140C108 152 132 152 140 140C134 162 106 162 100 140Z', fill: '#2a1f5c', stroke: '#2a1f5c', strokeWidth: 2, lineJoin: 'round' }] },
  { name: 'Язык', paths: [{ d: 'M111 153C116 149 124 149 129 153C125 158 115 158 111 153Z', fill: '#ff7aa8' }] },
  { name: 'Клыки', paths: [{ d: 'M107 146L111.5 154L116 147.6ZM124 147.6L128.5 154L133 146Z', fill: '#ffffff', stroke: '#ffffff', strokeWidth: 1, lineJoin: 'round' }] }
];

/**
 * Операции, которые кладут пример иллюстрации — «Монстрик» 240×240 — в контейнер
 * `parent` (круг 37). ops[0] — свободная рамка (clip, градиентный фон), дальше —
 * детали-векторы снизу вверх. id новые на каждый вызов. Документ не меняется:
 * оболочка применяет операции транзакцией.
 * @param {{parent:string, pos?:{x:number,y:number}, scale?:number, name?:string, index?:number}} opts
 * @returns {object[]}
 */
function sampleIllustration(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const parent = typeof o.parent === 'string' ? o.parent : null;
  const k = isNum(o.scale) ? clamp(o.scale, 0.1, 20) : 1;
  const side = r2(240 * k);
  const frame = {
    type: 'frame', name: typeof o.name === 'string' && o.name ? o.name : 'Иллюстрация · Монстрик', role: 'illustration',
    parent, children: [], layout: { mode: 'none' }, clip: true, radius: r2(28 * k),
    size: sizeSpec(side, side),
    fill: { gradient: { kind: 'radial', cx: 0.5, cy: 0.42, r: 0.75, stops: [{ at: 0, color: '#fff6ea' }, { at: 1, color: '#ffd6bd' }] } },
    pos: isObj(o.pos) && isNum(o.pos.x) && isNum(o.pos.y) ? { x: r2(o.pos.x), y: r2(o.pos.y) } : { x: 0, y: 0 }
  };
  const list = [ops.create(frame, isNum(o.index) ? o.index : undefined)];
  const fid = list[0].node.id;
  for (const part of MONSTER_PARTS) {
    const fit = fitVector(part.paths);
    if (!fit) continue;
    list.push(ops.create({
      type: 'vector', name: part.name, parent: fid,
      pos: { x: r2(fit.pos.x * k), y: r2(fit.pos.y * k) },
      size: sizeSpec(r2(fit.viewBox.w * k), r2(fit.viewBox.h * k)),
      viewBox: fit.viewBox,
      paths: deepClone(part.paths)
    }));
  }
  return list;
}

function buildDemo(doc) {
  const nodes = doc.nodes;
  const push = (n) => {
    nodes[n.id] = n;
    const p = ownNode(nodes, n.parent);
    if (p && p.children) p.children.push(n.id);
    return n;
  };
  /** frame(parent, name, {layout,w,h,fill,stroke,radius,pos,role,clip}) */
  const F = (parent, name, o = {}) => push({
    type: 'frame', id: uid('f'), name, parent, children: [],
    layout: normalizeLayout(o.layout || { mode: 'none' }),
    size: sizeSpec(o.w, o.h),
    ...(o.fill ? { fill: o.fill } : {}),
    ...(o.stroke ? { stroke: o.stroke } : {}),
    radius: o.radius || 0,
    ...(o.pos ? { pos: o.pos } : {}),
    ...(o.role ? { role: o.role } : {}),
    ...(o.clip ? { clip: true } : {})
  });
  /** text(parent, name, characters, {style,color,align,w,h,role}) */
  const T = (parent, name, characters, o = {}) => push({
    type: 'text', id: uid('t'), name, parent, characters,
    style: o.style || { token: 'body' },
    color: o.color || 'text',
    align: o.align || 'left',
    size: sizeSpec(o.w === undefined ? 'hug' : o.w, o.h === undefined ? 'hug' : o.h),
    ...(o.role ? { role: o.role } : {})
  });
  const E = (parent, name, o = {}) => push({
    type: 'ellipse', id: uid('e'), name, parent, size: sizeSpec(o.w, o.h),
    ...(o.fill ? { fill: o.fill } : {}), ...(o.stroke ? { stroke: o.stroke } : {}), radius: 999
  });
  /** instance(parent, мастер, пропсы, {name,size,pos}) — круг 19, п.9 */
  const I = (parent, of, props, o = {}) => push({
    type: 'instance', id: uid('i'), parent, of: of.id, props: { ...props },
    ...(o.name ? { name: o.name } : {}),
    ...(o.size ? { size: o.size } : {}),
    ...(o.pos ? { pos: o.pos } : {})
  });

  /* ---------- Артборд 1: мобильный экран «Маршрут дня» ---------- */
  const mob = F(doc.root, 'Маршрут дня', {
    pos: { x: 0, y: 0 }, w: 390, h: 844, fill: 'surface', radius: 24, clip: true, role: 'artboard',
    layout: { mode: 'column', gap: 20, padding: { t: 24, r: 20, b: 24, l: 20 }, align: 'stretch' }
  });

  const head = F(mob.id, 'Шапка', {
    w: 'fill', h: 'hug', role: 'header',
    layout: { mode: 'row', gap: 12, align: 'center', justify: 'between' }
  });
  const headText = F(head.id, 'Дата и заголовок', { w: 'hug', h: 'hug', layout: { mode: 'column', gap: 4 } });
  T(headText.id, 'Дата', 'вторник, 23 сентября', { style: { token: 'caption' }, color: 'muted' });
  T(headText.id, 'Заголовок экрана', 'Маршрут дня', { style: { token: 'title' }, role: 'title' });
  E(head.id, 'Аватар', { w: 40, h: 40, fill: 'surfaceAlt', stroke: { color: 'line', width: 1 } });

  const card = F(mob.id, 'Карточка встречи', {
    w: 'fill', h: 'hug', fill: 'accentSoft', radius: 16, role: 'card',
    layout: { mode: 'column', gap: 8, padding: { t: 16, r: 16, b: 16, l: 16 } }
  });
  const cardTop = F(card.id, 'Строка статуса', { w: 'fill', h: 'hug', layout: { mode: 'row', gap: 8, justify: 'between', align: 'center' } });
  T(cardTop.id, 'Метка', 'БЛИЖАЙШАЯ ВСТРЕЧА', { style: { token: 'caption', fontWeight: 600, letterSpacing: 0.6 }, color: 'accentInk' });
  T(cardTop.id, 'Обратный отсчёт', 'через 40 мин', { style: { token: 'mono' }, color: 'accentInk' });
  T(card.id, 'Название встречи', 'Планёрка по редактору макетов', { style: { token: 'heading' }, w: 'fill' });
  T(card.id, 'Время и место', '10:30 — 11:15 · переговорная «Север»', { style: { token: 'caption' }, color: 'muted', w: 'fill' });

  T(mob.id, 'Подзаголовок списка', 'Дальше сегодня', { style: { token: 'caption', fontWeight: 600 }, color: 'muted' });

  const list = F(mob.id, 'Список пунктов', {
    w: 'fill', h: 'hug', role: 'list',
    layout: { mode: 'column', gap: 8, align: 'stretch' }
  });
  const item = (time, title, place) => {
    const it = F(list.id, 'Пункт · ' + title, {
      w: 'fill', h: 'hug', fill: 'surfaceAlt', radius: 12, role: 'item',
      layout: { mode: 'row', gap: 12, align: 'center', padding: { t: 12, r: 12, b: 12, l: 12 } }
    });
    T(it.id, 'Время', time, { style: { token: 'mono' }, color: 'muted', w: 48 });
    const col = F(it.id, 'Текст пункта', { w: 'fill', h: 'hug', layout: { mode: 'column', gap: 2 } });
    T(col.id, 'Название пункта', title, { style: { token: 'body', fontWeight: 600 }, w: 'fill' });
    T(col.id, 'Место', place, { style: { token: 'caption' }, color: 'muted', w: 'fill' });
    return it;
  };
  item('12:00', 'Обед с командой', 'кафе «Пироговая», 3 этаж');
  item('15:30', 'Ревью макетов', 'созвон, ссылка в календаре');
  item('18:40', 'Тренировка', 'зал на Лесной, 40 минут');

  const btn = F(mob.id, 'Кнопка «Добавить пункт»', {
    w: 'fill', h: 52, fill: 'accent', radius: 16, role: 'button',
    layout: { mode: 'row', gap: 8, align: 'center', justify: 'center' }
  });
  T(btn.id, 'Подпись кнопки', 'Добавить пункт', { style: { token: 'body', fontWeight: 600 }, color: 'onAccent' });

  /* ---------- Артборд 2: десктопный блок «Сводка недели» ---------- */
  const desk = F(doc.root, 'Сводка недели', {
    pos: { x: 470, y: 0 }, w: 960, h: 560, fill: 'surface', radius: 20, role: 'artboard',
    layout: { mode: 'column', gap: 24, padding: { t: 32, r: 32, b: 32, l: 32 }, align: 'stretch' }
  });

  const dHead = F(desk.id, 'Шапка сводки', { w: 'fill', h: 'hug', layout: { mode: 'row', gap: 16, align: 'center', justify: 'between' } });
  const dHeadCol = F(dHead.id, 'Заголовок и период', { w: 'hug', h: 'hug', layout: { mode: 'column', gap: 4 } });
  T(dHeadCol.id, 'Заголовок сводки', 'Сводка недели', { style: { token: 'display' }, role: 'title' });
  T(dHeadCol.id, 'Период', '22–28 сентября · команда редактора', { style: { token: 'caption' }, color: 'muted' });
  T(dHead.id, 'Отметка обновления', 'обновлено 5 минут назад', { style: { token: 'mono' }, color: 'muted', align: 'right' });

  const metrics = F(desk.id, 'Показатели', { w: 'fill', h: 'hug', role: 'metric', layout: { mode: 'row', gap: 16, align: 'stretch' } });
  const metric = (label, value, delta, deltaColor) => {
    const m = F(metrics.id, 'Показатель · ' + label, {
      w: 'fill', h: 'hug', fill: 'surfaceAlt', radius: 16, role: 'metric',
      layout: { mode: 'column', gap: 6, padding: { t: 20, r: 20, b: 20, l: 20 } }
    });
    T(m.id, 'Подпись показателя', label, { style: { token: 'caption' }, color: 'muted', w: 'fill' });
    T(m.id, 'Значение показателя', value, { style: { token: 'display' }, w: 'fill' });
    T(m.id, 'Изменение', delta, { style: { token: 'mono' }, color: deltaColor, w: 'fill' });
  };
  metric('Задач закрыто', '48', '+12% к прошлой неделе', 'good');
  metric('Средний цикл', '2,4 дня', '−6 часов', 'good');
  metric('Правок от агента', '312', '79% принято сразу', 'muted');

  const table = F(desk.id, 'Таблица проектов', {
    w: 'fill', h: 'hug', radius: 16, clip: true, role: 'table',
    stroke: { color: 'line', width: 1 },
    layout: { mode: 'column', gap: 0, align: 'stretch' }
  });
  const row = (cells, opts = {}) => {
    const r = F(table.id, opts.head ? 'Заголовок таблицы' : 'Строка · ' + cells[0], {
      w: 'fill', h: 'hug', role: 'item',
      ...(opts.head ? { fill: 'surfaceAlt' } : {}),
      layout: { mode: 'row', gap: 16, align: 'center', padding: { t: 12, r: 16, b: 12, l: 16 } }
    });
    const st = opts.head
      ? { token: 'caption', fontWeight: 600 }
      : { token: 'body' };
    const color = opts.head ? 'muted' : 'text';
    T(r.id, 'Проект', cells[0], { style: st, color, w: 'fill' });
    T(r.id, 'Статус', cells[1], { style: st, color: opts.head ? 'muted' : 'muted', w: 140 });
    T(r.id, 'Владелец', cells[2], { style: st, color, w: 180 });
    T(r.id, 'Срок', cells[3], { style: opts.head ? st : { token: 'mono' }, color: 'muted', w: 90, align: 'right' });
    return r;
  };
  row(['Проект', 'Статус', 'Владелец', 'Срок'], { head: true });
  row(['Редактор макетов', 'в работе', 'Аня Ковалёва', '26 сен']);
  row(['Голосовой ввод', 'на ревью', 'Пётр Гущин', '27 сен']);
  row(['Экспорт в SVG', 'готово', 'Лиза Май', '24 сен']);
  row(['Библиотека токенов', 'в плане', 'Марк Орлов', '1 окт']);

  /* ---------- Библиотека компонентов (круг 19, п.9; SPEC §5.3) ----------
     Живая, а не пустая: без неё ни соседи, ни критики не увидят компоненты
     вживую. Библиотека — страница с role:'library' рядом с досками; досками
     её не считают ни isArtboard, ни artboards, ни экспорт «всё». Стоит правее
     обеих досок (см. libraryPlace), поэтому существующие доски не поехали. */
  const lib = push({
    type: 'page', id: uid('lib'), name: 'Библиотека', role: LIBRARY_ROLE,
    parent: doc.root, children: [], pos: libraryPlace(doc),
    layout: normalizeLayout({ mode: 'column', gap: 24, align: 'start' })
  });

  const btnM = F(lib.id, 'Кнопка', {
    w: 'hug', h: 'hug', fill: 'accent', radius: 16, role: 'button',
    layout: { mode: 'row', gap: 8, align: 'center', justify: 'center', padding: { t: 16, r: 20, b: 16, l: 20 } }
  });
  const btnMLabel = T(btnM.id, 'Подпись кнопки', 'Кнопка', { style: { token: 'body', fontWeight: 600 }, color: 'onAccent' });
  btnM.component = {
    name: 'Кнопка',
    props: [
      { name: 'текст', kind: 'text', target: btnMLabel.id, path: 'characters' },
      { name: 'вид', kind: 'enum', target: btnM.id, path: 'fill', values: ['accent', 'surface'] }
    ]
  };

  const tagM = F(lib.id, 'Метка', {
    w: 'hug', h: 'hug', fill: 'surfaceAlt', radius: 999, role: 'caption',
    layout: { mode: 'row', gap: 6, align: 'center', justify: 'center', padding: { t: 6, r: 12, b: 6, l: 12 } }
  });
  const tagMLabel = T(tagM.id, 'Текст метки', 'метка', { style: { token: 'caption', fontWeight: 600 }, color: 'muted' });
  tagM.component = {
    name: 'Метка',
    props: [
      { name: 'текст', kind: 'text', target: tagMLabel.id, path: 'characters' },
      { name: 'тон', kind: 'enum', target: tagM.id, path: 'fill', values: ['surfaceAlt', 'accentSoft'] }
    ]
  };

  const statM = F(lib.id, 'Карточка показателя', {
    w: 240, h: 'hug', fill: 'surfaceAlt', radius: 16, role: 'metric',
    layout: { mode: 'column', gap: 6, padding: { t: 20, r: 20, b: 20, l: 20 } }
  });
  const statCap = T(statM.id, 'Подпись показателя', 'Показатель', { style: { token: 'caption' }, color: 'muted', w: 'fill' });
  const statVal = T(statM.id, 'Значение показателя', '0', { style: { token: 'display' }, w: 'fill' });
  statM.component = {
    name: 'Карточка показателя',
    props: [
      { name: 'заголовок', kind: 'text', target: statCap.id, path: 'characters' },
      { name: 'значение', kind: 'text', target: statVal.id, path: 'characters' },
      { name: 'фон', kind: 'enum', target: statM.id, path: 'fill', values: ['surfaceAlt', 'accentSoft'] }
    ]
  };

  /* Экземпляры на доске: три метки и кнопка вида surface. Дописаны В КОНЕЦ
     мобильной доски (под ней было 296 px свободных), поэтому ничего из прежнего
     содержимого не сдвинулось. Правка мастера меняет их все разом. */
  const tags = F(mob.id, 'Ярлыки', {
    w: 'fill', h: 'hug', layout: { mode: 'row', gap: 8, align: 'center', wrap: true }
  });
  I(tags.id, tagM, { 'текст': 'сегодня' });
  I(tags.id, tagM, { 'текст': '3 встречи', 'тон': 'accentSoft' });
  I(tags.id, tagM, { 'текст': '2 задачи' });
  I(mob.id, btnM, { 'текст': 'Открыть день', 'вид': 'surface' });

  /* Круг 20 (SPEC §6.5): демо целиком на ссылках — в документе нет числа 16.
     Конструкторы выше пишут числа (так читается вёрстка), а здесь каждый
     отступ, зазор и скругление, совпадающий с шагом шкалы, становится ссылкой
     на него. Все значения демо лежат в шкалах по построению, поэтому чисел не
     остаётся (это закреплено тестом); геометрия не меняется байт в байт. */
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (n.layout) n.layout = layoutToRefs(doc, n.layout);
    if (n.radius !== undefined) n.radius = radiusToRefs(doc, n.radius);
  }

  return doc;
}

/**
 * Создаёт документ. Без аргументов — демо с двумя артбордами
 * («Маршрут дня» — мобильный экран, «Сводка недели» — десктопный блок).
 * @param {object|string} [seed] готовый документ (будет нормализован) либо {empty:true} / 'empty'
 * @returns {object} Doc
 */
/**
 * Приводит документ к дереву: разрывает рёбра, из-за которых он деревом не был
 * (ребёнок, чей `parent` указывает в другое место, ребро, замыкающее цикл),
 * и удаляет узлы, недостижимые из корня, вместе с их поддеревьями — такие
 * висят в `doc.nodes` мёртвым грузом: их не видно и они не проходят checkNode.
 * Делает это заметно, через logOnce.
 * @param {object} doc изменяется на месте
 */
function pruneBrokenEdges(doc) {
  const seen = new Set([doc.root]);
  // Обход итеративный и без предела глубины: рекурсия кладёт стек на длинной
  // цепочке, а прежняя страховка «глубже MAX_DEPTH — только помечаем живым»
  // оставляла хвост поддерева с нечищеными рёбрами: его узлы считались
  // недостижимыми и удалялись, а ребро у родителя оставалось — документ
  // перестал быть деревом, и импорт такого файла ругался на «узел назван
  // ребёнком, но не описан». Теперь каждое достижимое ребро проходит проверку.
  const stack = [doc.root];
  while (stack.length) {
    const id = stack.pop();
    const n = ownNode(doc.nodes, id);
    if (!n || !Array.isArray(n.children)) continue;
    const kept = [];
    for (const c of n.children) {
      const child = ownNode(doc.nodes, c);
      if (!child) {
        logOnce('prune:ghost:' + shown(c), `createDoc: ребёнок «${shown(c)}» узла «${id}» не найден — ребро отброшено`);
        continue;
      }
      if (child.parent !== id) {
        logOnce('prune:parent:' + c, `createDoc: у «${c}» parent «${shown(child.parent)}», а числится в «${id}» — ребро отброшено`);
        continue;
      }
      if (seen.has(c) || c === id) {
        logOnce('prune:cycle:' + c, `createDoc: ребро «${id}» → «${c}» замыкает цикл — отброшено`);
        continue;
      }
      kept.push(c);
      seen.add(c);
    }
    n.children = kept;
    // в обратном порядке: обход остаётся тем же, что у прежней рекурсии
    for (let i = kept.length - 1; i >= 0; i--) stack.push(kept[i]);
  }
  // всё, что не достижимо из корня, не рисуется и не проверяется — убираем совсем
  for (const id of Object.keys(doc.nodes)) {
    if (seen.has(id)) continue;
    const n = doc.nodes[id];
    logOnce('prune:orphan:' + id, `createDoc: узел «${id}» (parent «${shown(n && n.parent)}») не достижим из корня — удалён вместе с поддеревом`);
    delete doc.nodes[id];
  }
}

/** Размер оси, приведённый к схеме: негодный становится hug — узел видно и его можно поправить. */
function repairSizeSpec(spec) {
  if (spec && SIZE_MODES.has(spec.mode)) {
    if (spec.mode !== 'fixed') return { mode: spec.mode };
    if (isNum(spec.value) && spec.value >= 0 && spec.value <= MAX_SIZE) return { mode: 'fixed', value: spec.value };
    if (isNum(spec.value)) return { mode: 'fixed', value: clamp(spec.value, 0, MAX_SIZE) };
  }
  return { mode: 'hug' };
}

/**
 * Приводит узел к схеме на месте: негодные поля сбрасываются к безопасным
 * значениям (размер — hug, позиция — в границы, цвет и переопределение — прочь).
 * Чего нельзя починить (тип, id, родитель), тут не трогается: такой узел
 * выбрасывают вместе с поддеревом.
 * @param {object} n изменяется на месте
 * @returns {string[]} имена поправленных полей — для сообщения человеку
 */
function repairNode(n, doc) {
  const fixed = [];
  const mark = (name) => { if (!fixed.includes(name)) fixed.push(name); };
  if (n.name !== undefined && typeof n.name !== 'string') { delete n.name; mark('name'); }
  if (CONTAINER_TYPES.has(n.type)) {
    if (!Array.isArray(n.children)) { n.children = []; mark('children'); }
    else if (n.children.some((c) => typeof c !== 'string')) {
      n.children = n.children.filter((c) => typeof c === 'string');
      mark('children');
    }
  } else if (n.type !== 'instance' && n.children !== undefined
    && (!Array.isArray(n.children) || n.children.length)) {
    // круг 31: детей у не-контейнера нет — поле прочь (дети, если были, станут сиротами)
    delete n.children; mark('children');
  }
  /* Круг 19: компонент и экземпляр из чужого файла чиним, а не выбрасываем.
     Узел, не прошедший checkNode, createDoc удаляет вместе с поддеревом — терять
     целый мастер из-за одного пропса, целящего в никуда, несоразмерно. */
  if (n.component !== undefined && checkComponent(n, doc)) {
    const c = n.component;
    const name = c && typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null;
    if (!name) { delete n.component; mark('component'); }
    else {
      const props = (Array.isArray(c.props) ? c.props : []).filter((p) => !checkComponent(
        { ...n, component: { name, props: [p] } }, doc));
      n.component = { name, props };
      mark('component');
    }
  }
  if (n.type === 'instance') {
    if (typeof n.of !== 'string' || !n.of || n.of === n.id) { n.of = ''; mark('of'); }
    if (n.children !== undefined) { delete n.children; mark('children'); }
    if (n.size !== undefined && (!n.size || typeof n.size !== 'object' || Array.isArray(n.size))) {
      delete n.size; mark('size');
    } else if (n.size) {
      for (const ax of ['w', 'h']) {
        const a = n.size[ax];
        if (a === undefined) continue;
        const b = repairSizeSpec(a);
        if (!a || a.mode !== b.mode || a.value !== b.value) { n.size[ax] = b; mark('size.' + ax); }
      }
    }
    if (n.props !== undefined && (!n.props || typeof n.props !== 'object' || Array.isArray(n.props))) {
      delete n.props; mark('props');
    } else if (n.props && doc) {
      // пропс, которого мастер не объявлял, оставить нельзя: checkNode его отклоняет,
      // и узел вместе с ним уехал бы из документа целиком
      const known = propMap(doc.nodes ? ownNode(doc.nodes, n.of) : null);
      for (const key of Object.keys(n.props)) {
        const p = known.get(key);
        if (p && propValue(p, n.props[key]) !== undefined) continue;
        if (!known.size && !(doc.nodes && ownNode(doc.nodes, n.of))) continue;   // мастера нет — скажет validate
        delete n.props[key]; mark('props.' + key);
      }
    }
  }
  if (n.type !== 'page' && n.type !== 'instance') {
    const src = n.size && typeof n.size === 'object' ? n.size : {};
    const size = { w: repairSizeSpec(src.w), h: repairSizeSpec(src.h) };
    for (const ax of ['w', 'h']) {
      const a = src[ax];
      const b = size[ax];
      if (!a || a.mode !== b.mode || a.value !== b.value) mark('size.' + ax);
    }
    n.size = size;
  }
  if (n.type === 'frame') {
    n.layout = normalizeLayout(n.layout);
    /* Круг 20: ссылка не в ту шкалу ('radii.3' в зазоре) схему не проходит —
       вместо неё безопасный ноль, с пометкой. Ссылка на шаг, которого НЕТ,
       остаётся как есть: это документное свойство, о нём скажет валидатор
       (dead-scale-ref), а узел останется правимым. */
    if (checkScaleValue(n.layout.gap, 'spacing', 'layout.gap')) { n.layout.gap = 0; mark('layout.gap'); }
    for (const k of PAD_KEYS) {
      if (checkScaleValue(n.layout.padding[k], 'spacing', 'layout.padding')) { n.layout.padding[k] = 0; mark('layout.padding.' + k); }
    }
  }
  if (n.pos !== undefined) {
    const p = n.pos && typeof n.pos === 'object' ? n.pos : null;
    const next = nodePos(n);
    if (!p || p.x !== next.x || p.y !== next.y) { n.pos = next; mark('pos'); }
  }
  if (n.override !== undefined && n.override !== null) {
    const o = n.override;
    if (!o || typeof o !== 'object' || !isNum(o.x) || !isNum(o.y)) { delete n.override; mark('override'); }
    else {
      const next = { x: clamp(o.x, -MAX_SIZE, MAX_SIZE), y: clamp(o.y, -MAX_SIZE, MAX_SIZE) };
      if (isNum(o.w)) next.w = clamp(o.w, 0, MAX_SIZE);
      if (isNum(o.h)) next.h = clamp(o.h, 0, MAX_SIZE);
      if (next.x !== o.x || next.y !== o.y || next.w !== o.w || next.h !== o.h) mark('override');
      n.override = next;
    }
  }
  if (n.opacity !== undefined && (!isNum(n.opacity) || n.opacity < 0 || n.opacity > 1)) {
    delete n.opacity;   // прозрачность «из ниоткуда» — лучше её отсутствие
    mark('opacity');
  }
  // круг 20: число вне границ, мусор, ссылка не в ту шкалу — скругление снимается;
  // живая или мёртвая ссылка на radii остаётся (мёртвую покажет валидатор)
  if (n.radius !== undefined && checkRadiusValue(n.radius)) { delete n.radius; mark('radius'); }
  if (n.type === 'text') {
    if (typeof n.characters !== 'string') {
      // круг 29: число и булево — строкой, как раньше; объект — пусто (String() на нём бросает)
      const c = n.characters;
      n.characters = typeof c === 'number' || typeof c === 'boolean' ? String(c) : '';
      mark('characters');
    }
    if (n.style !== undefined && typeof n.style !== 'string' && (typeof n.style !== 'object' || !n.style)) {
      delete n.style; mark('style');
    }
    if (n.style && typeof n.style === 'object') {
      for (const k of ['fontSize', 'lineHeight']) {
        const v = n.style[k];
        if (v !== undefined && (!isNum(v) || v <= 0 || v > 1000)) { delete n.style[k]; mark('style.' + k); }
      }
      const w = n.style.fontWeight;
      if (w !== undefined && (!isNum(w) || w < 100 || w > 900)) { delete n.style.fontWeight; mark('style.fontWeight'); }
    }
    if (n.align !== undefined && !['left', 'center', 'right'].includes(n.align)) { delete n.align; mark('align'); }
  }
  // цвет: имя токена, строка или {token} — иначе честнее отсутствие цвета
  for (const k of ['fill', 'color']) {
    const v = n[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') continue;
    if (typeof v === 'object' && typeof v.token === 'string') continue;
    // круг 49: годная фактура заливки остаётся; негодная — снимается
    if (k === 'fill' && isPatternPaint(v) && !paintProblem(v, k)) continue;
    // круг 37: градиент чиним по стопам, а не снимаем целиком
    if (isGradientPaint(v)) {
      const g = repairGradient(v.gradient);
      if (g) {
        if (Object.keys(v).length !== 1 || gradientProblem(v.gradient, k)) { n[k] = { gradient: g }; mark(k); }
        continue;
      }
    }
    delete n[k]; mark(k);
  }
  if (n.type === 'vector') repairVector(n, mark);
  repairMotionFields(n, mark);
  repairShapes(n, mark);
  return fixed;
}

/**
 * Круг 37: градиент из чужого файла — годные стопы остаются, негодные поля уходят.
 * @returns {object|null} null — живых стопов нет
 */
function repairGradient(g) {
  if (!isObj(g)) return null;
  const out = { kind: GRADIENT_KIND_SET.has(g.kind) ? g.kind : 'linear' };
  if (isNum(g.angle) && g.angle >= 0 && g.angle <= 360) out.angle = g.angle;
  for (const k of ['cx', 'cy', 'r']) if (isNum(g[k]) && g[k] >= 0 && g[k] <= 1) out[k] = g[k];
  const stops = [];
  for (const st of Array.isArray(g.stops) ? g.stops : []) {
    if (stops.length >= VECTOR_LIMITS.maxStops) break;
    if (!isObj(st) || !isNum(st.at)) continue;
    const one = { at: clamp(st.at, 0, 1) };
    if (typeof st.token === 'string' && st.token) one.token = st.token;
    else if (typeof st.color === 'string' && st.color) one.color = st.color;
    else continue;
    if (isNum(st.opacity)) one.opacity = clamp(st.opacity, 0, 1);
    stops.push(one);
  }
  if (!stops.length) return null;
  out.stops = stops;
  return out;
}

/** Краска контура после починки: годная — как есть, градиент — по стопам, иначе undefined. */
function repairPaint(v, what) {
  if (!paintProblem(v, what)) return v;
  if (isGradientPaint(v)) { const g = repairGradient(v.gradient); if (g) return { gradient: g }; }
  return undefined;
}

/**
 * Круг 37: вектор из чужого файла. Негодный контур (путь не разбирается, не объект)
 * выбрасывается, сверх пределов — тоже; негодные поля годного контура снимаются по
 * одному. Негодный viewBox — по рамке оставшихся контуров, иначе 100×100.
 */
function repairVector(n, mark) {
  const src = Array.isArray(n.paths) ? n.paths : [];
  if (!Array.isArray(n.paths)) mark('paths');
  if (src.length > VECTOR_LIMITS.maxPaths) mark('paths');
  const kept = [];
  let total = 0;
  for (let i = 0; i < src.length && kept.length < VECTOR_LIMITS.maxPaths; i++) {
    const p = src[i];
    if (!isObj(p) || typeof p.d !== 'string' || pathCheck(p.d, p).err || total + p.d.length > VECTOR_LIMITS.maxTotalD) {
      mark('paths.' + i);
      continue;
    }
    if (vpathProblem(p, 'paths.' + i)) {
      const q = { d: p.d };
      for (const k of VPATH_KEYS) {
        if (k === 'd' || p[k] === undefined) continue;
        let v = p[k];
        if (k === 'fill' || k === 'stroke') v = repairPaint(v, k);
        if (v !== undefined && !vpathProblem({ d: p.d, [k]: v }, '')) q[k] = v;
      }
      kept.push(q);
      mark('paths.' + i);
    } else kept.push(p);
    total += p.d.length;
  }
  n.paths = kept;
  if (viewBoxProblem(n.viewBox)) {
    const b = pathBounds(kept);
    const vb = b ? { x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h) } : null;
    n.viewBox = vb && !viewBoxProblem(vb) ? vb : { w: 100, h: 100 };
    mark('viewBox');
  }
}

/**
 * Круг 36: состояния и движение из чужого файла чиним по полям, а не снимаем
 * целиком: негодное состояние или поле патча уходит, годные остаются. У
 * страницы состояний не бывает — поле снимается.
 */
function repairMotionFields(n, mark) {
  if (n.states !== undefined && fieldProblem(n, 'states')) {
    if (n.type === 'page' || !isObj(n.states)) { delete n.states; mark('states'); }
    else {
      for (const s of Object.keys(n.states)) {
        const p = n.states[s];
        if (!STATE_NAME_SET.has(s) || !isObj(p)) { delete n.states[s]; mark('states.' + s); continue; }
        for (const k of Object.keys(p)) {
          if (statePatchProblem({ [k]: p[k] }, 'states.' + s)) { delete p[k]; mark(`states.${s}.${k}`); }
        }
      }
    }
  }
  if (n.motion !== undefined && fieldProblem(n, 'motion')) {
    if (!isObj(n.motion)) { delete n.motion; mark('motion'); }
    else {
      for (const k of Object.keys(n.motion)) {
        if (motionProblem({ [k]: n.motion[k] })) { delete n.motion[k]; mark('motion.' + k); }
      }
    }
  }
}

/**
 * Круг 29: форма полей (fieldProblem) — то, что осталось после починки выше.
 * Негодный подключ обёртки (style.token-объект, stroke.width-строка) снимается,
 * соседние остаются; флаг приводится к булеву так, как его и читала отрисовка
 * (clip и locked — по истинности, visible — «не false» значит виден); всё
 * прочее негодное поле снимается целиком — узел остаётся и правится.
 */
function repairShapes(n, mark) {
  const dropKeys = (obj, keys, field) => {
    for (const k of keys) {
      if (obj[k] === undefined) continue;
      const probe = { [field]: { [k]: obj[k] } };
      if (fieldProblem(probe, field)) { delete obj[k]; mark(field + '.' + k); }
    }
  };
  if (isObj(n.style)) dropKeys(n.style, ['token', 'font', 'fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing'], 'style');
  if (isObj(n.stroke)) dropKeys(n.stroke, ['color', 'token', 'value', 'width'], 'stroke');
  for (const k of ['fill', 'color']) if (isObj(n[k])) dropKeys(n[k], ['token', 'color', 'value'], k);
  for (const k of ['clip', 'locked']) {
    if (n[k] !== undefined && typeof n[k] !== 'boolean') { n[k] = !!n[k]; mark(k); }
  }
  for (const k of Object.keys(n)) {
    if (!fieldProblem(n, k)) continue;
    // размер у не-экземпляра обязателен: его чинили выше; если всё ещё негоден — hug
    if (k === 'size' && n.type !== 'page' && n.type !== 'instance') n.size = sizeSpec('hug', 'hug');
    else if (k === 'characters' && n.type === 'text') n.characters = '';
    else if (k === 'of' && n.type === 'instance') n.of = '';
    else delete n[k];
    mark(k);
  }
}

/**
 * Что не так с корнем документа. Мало проверить его по схеме: `rect`, чей
 * `parent` указывает на себя, checkNode проходит (тип известен, parent —
 * строка, ссылка разрешается), и «корень → страница» не срабатывало. Дальше
 * solve спотыкался о `children: {mode:'fixed'}`, и человек видел сырой текст
 * исключения JS. Корнем может быть только контейнер без родителя со children-массивом.
 * @returns {string|null} причина или null, если корень годен
 */
function rootProblem(node, doc) {
  if (!node || typeof node !== 'object') return 'корня нет';
  if (!CONTAINER_TYPES.has(node.type)) return `корень типа «${shown(node.type)}» не контейнер`;
  if (node.parent !== null && node.parent !== undefined) return `у корня есть родитель «${shown(node.parent)}»`;
  if (!Array.isArray(node.children)) return 'children корня не массив';
  return checkNode(node, doc);
}

/**
 * Токены документа поверх умолчаний — ПО ГРУППАМ.
 *
 * Поверхностное слияние (`{...DEFAULT, ...doc.tokens}`) заменяло группу целиком:
 * файл с `tokens.colors = {accent:'#…'}` терял остальные двенадцать цветов,
 * resolveColor начинал отдавать null, и все заливки становились «нет». Внутрь
 * тип-токена не заходим: там частичное слияние вреднее — свой fontSize 34 с
 * доставшимся из умолчаний lineHeight 22 читается хуже, чем вычисленный.
 * @param {any} raw doc.tokens как пришли (могут быть мусором)
 * @returns {object}
 */
function mergeTokens(raw) {
  const base = deepClone(DEFAULT_TOKENS);
  const got = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const group = (name) => {
    const src = got[name];
    return src && typeof src === 'object' && !Array.isArray(src) ? { ...base[name], ...src } : base[name];
  };
  const scale = (name) => (Array.isArray(got[name]) && got[name].length ? got[name].slice() : base[name]);
  const out = { ...got, colors: group('colors'), type: group('type'), spacing: scale('spacing'), radii: scale('radii') };
  /* Круг 36: шкалы движения и теней необязательны (без них — умолчания ядра),
     поэтому их не достраиваем; негодные шаги снимаем, негодную группу — целиком. */
  for (const [name, steps, ok] of [['motion', MOTION_STEPS, motionStepOk], ['shadow', SHADOW_STEPS, shadowStepOk]]) {
    if (!hasOwnProp.call(got, name)) continue;
    const src = got[name];
    if (!isObj(src)) { delete out[name]; continue; }
    const clean = {};
    for (const k of Object.keys(src)) if (steps.indexOf(k) >= 0 && ok(src[k])) clean[k] = src[k];
    out[name] = clean;
  }
  return out;
}

/**
 * Круг 27 (I7): пустой документ — сразу в нынешнем формате. Миграция оболочки
 * (app.js, maybeMigrate) ищет две вещи: страницу-библиотеку (ensureLibraryOps) и
 * числа отступов/скруглений, равные шагу шкалы (ensureScaleRefsOps). У пустой
 * страницы чисел нет, библиотеку кладём здесь — новому проекту мигрировать нечего,
 * и тоста «Документ из прежней версии» нет. Узел библиотеки — тот же, что
 * заводит ensureLibraryOps (libraryTemplate): страница-ребёнок корня с ролью library.
 */
function withLibrary(doc) {
  const lib = libraryTemplate(doc);
  doc.nodes[lib.id] = lib;
  doc.nodes[doc.root].children.push(lib.id);
  return doc;
}

/** Предел узлов импортируемого документа по умолчанию (равен пределу Document service). */
const MAX_IMPORT_NODES = 20000;

/**
 * Круг 29 (J7): годится ли ЧУЖОЙ документ в новый проект — до createDoc.
 *
 * createDoc чинит и прощает: так открываются документы прежних версий (в том
 * числе глубже MAX_DEPTH — их можно поднимать и править, SPEC §9.13). Импорт —
 * другое дело: цепочка в 19 000 уровней или объект в style.token, принятые
 * один раз, живут в проекте вечно. Поэтому вход проверяется строго, а не
 * чинится: глубина каждого узла (у корня 0) не больше MAX_DEPTH, циклов нет
 * (ни по parent, ни ребром children на предка), узлов не больше предела,
 * каждый узел — по схеме checkNode (форма каждого поля; ссылки на родителей и
 * мастеров не сверяются — сирот и мёртвые ссылки createDoc уберёт или покажет
 * validate), токены — той формы, что принимает setToken.
 *
 * Не бросает. Документ не меняет.
 * @param {any} doc документ как пришёл (разобранный JSON)
 * @param {{maxNodes?:number}} [opts]
 * Круг 39: и раскрытие экземпляров не больше MAX_EXPANDED_NODES (`limit:'expand_nodes'`).
 * @returns {null|{code:'bad-doc', message:string, id?:string, limit?:'depth'|'nodes'|'expand_nodes', max?:number}}
 *   null — годен; иначе первая причина (сервер отвечает 400, оболочка — словами)
 */
function checkImportDoc(doc, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxNodes = isNum(o.maxNodes) && o.maxNodes > 0 ? Math.floor(o.maxNodes) : MAX_IMPORT_NODES;
  const bad = (message, extra) => ({ code: 'bad-doc', message, ...(extra || {}) });
  try {
    if (!isObj(doc)) return bad('документ должен быть объектом');
    if (!isObj(doc.nodes)) return bad('nodes должен быть объектом');
    if (!isNodeId(doc.root) || !ownNode(doc.nodes, doc.root)) return bad('корень должен быть среди узлов');
    const ids = Object.keys(doc.nodes);
    if (ids.length > maxNodes) return bad(`узлов больше ${maxNodes}`, { limit: 'nodes', max: maxNodes });

    const t = doc.tokens;
    if (t !== undefined && t !== null) {
      if (!isObj(t)) return bad('tokens должен быть объектом');
      for (const g of Object.keys(t)) {
        if (PROTO_KEYS.has(g)) return bad(`tokens: ключ «${g}» зарезервирован`);
        const err = tokenWriteProblem([g], t[g], t);
        if (err) return bad('tokens.' + err);
      }
    }

    for (const id of ids) {
      const n = doc.nodes[id];
      if (!isNodeId(id)) return bad(`id «${shown(id)}» зарезервирован`, { id });
      if (!isObj(n)) return bad(`узел «${id}» должен быть объектом`, { id });
      if (n.id !== id) return bad(`узел «${id}»: внутри записан id «${shown(n.id)}»`, { id });
      // форма полей — как пришли (до нормализации раскладки: объект в layout.mode
      // нормализация молча заменила бы на 'none')
      const shape = fieldsProblem(n);
      if (shape) return bad(`узел «${id}»: ${shape}`, { id });
      // остальная схема — после тех же умолчаний, что дописывает createDoc
      const probe = { ...n };
      if (probe.type === 'frame') probe.layout = normalizeLayout(probe.layout);
      if (probe.type !== 'page' && probe.type !== 'instance' && !probe.size) probe.size = sizeSpec('hug', 'hug');
      const err = id === doc.root ? rootProblem(probe, null) : checkNode(probe, null, true);
      if (err) return bad(`узел «${id}»: ${err}`, { id });
    }

    /* Глубина и циклы — по parent: у узла один родитель, значит подъём от него
       либо доходит до корня (глубина известна), либо до узла без живого
       родителя (сирота — createDoc его уберёт, глубины нет), либо замыкается. */
    const depth = new Map([[doc.root, 0]]);
    for (const id of ids) {
      if (depth.has(id)) continue;
      const path = [];
      const onPath = new Set();
      let cur = id;
      let d = null;
      for (;;) {
        if (depth.has(cur)) { d = depth.get(cur); break; }
        if (onPath.has(cur)) return bad(`цикл: «${cur}» оказывается собственным предком`, { id: cur });
        const n = ownNode(doc.nodes, cur);
        if (!n) break;
        onPath.add(cur);
        path.push(cur);
        if (!isNodeId(n.parent)) break;
        cur = n.parent;
      }
      for (let k = path.length - 1; k >= 0; k--) {
        d = d === null ? null : d + 1;
        depth.set(path[k], d);
        if (d !== null && d > MAX_DEPTH) {
          return bad(`вложенность глубже ${MAX_DEPTH} уровней (узел «${path[k]}»)`, { id: path[k], limit: 'depth', max: MAX_DEPTH });
        }
      }
    }
    // ребро children на себя или на предка — цикл, даже если parent ребёнка его не подтверждает
    for (const id of ids) {
      const kids = doc.nodes[id].children;
      if (!Array.isArray(kids) || !kids.length) continue;
      const up = new Set([id]);
      for (let p = doc.nodes[id].parent, guard = 0; isNodeId(p) && !up.has(p) && guard <= MAX_DEPTH + 1; guard++) {
        up.add(p);
        const pn = ownNode(doc.nodes, p);
        p = pn ? pn.parent : null;
      }
      for (const c of kids) {
        if (up.has(c)) return bad(`цикл: «${id}» называет ребёнком «${c}» — себя или своего предка`, { id });
      }
    }
    /* Круг 39 (N2): раскрытие экземпляров — линейный счёт по мастерам (expandCost).
       Счёт по сырому документу — оценка сверху для того, что откроет createDoc:
       тот только выбрасывает рёбра и узлы, а не добавляет. Файл в 37 КБ с
       цепочкой 9 мастеров по 4 экземпляра раскрывался в 204 тыс. узлов во
       вкладке каждого участника. */
    const over = expandProblem(doc);
    if (over) {
      return bad(over.message, { ...(over.nodeId ? { id: over.nodeId } : {}), limit: EXPAND_LIMIT, max: MAX_EXPANDED_NODES });
    }
    return null;
  } catch (e) {
    // вход вне любых ожиданий (геттеры, прокси) — это тоже «не годен», а не исключение
    logOnce('checkImportDoc:throw', 'checkImportDoc: исключение на входе', e);
    return bad('документ не читается');
  }
}

function createDoc(seed) {
  if (seed && typeof seed === 'object' && seed.nodes && seed.root && seed.nodes[seed.root]) {
    const doc = deepClone(seed);
    doc.id = doc.id || uid('doc');
    doc.version = isNum(doc.version) ? doc.version : 1;
    doc.tokens = mergeTokens(doc.tokens);
    doc.meta = { name: 'Импорт', createdAt: new Date().toISOString(), ...(doc.meta || {}) };
    const drop = [];
    for (const id of Object.keys(doc.nodes)) {
      const n = doc.nodes[id];
      if (!n || typeof n !== 'object') { drop.push(id); continue; }
      // children нечитаемой формы: у контейнера её починит repairNode, у прочих
      // типов это мусор, который иначе уедет в JSON и в выжимку для агента, а на
      // `for (const c of node.children)` даст «object is not iterable»
      if (n.children !== undefined && !Array.isArray(n.children) && !CONTAINER_TYPES.has(n.type)) {
        delete n.children;
        logOnce('createDoc:kids:' + id, `createDoc: у «${id}» children не массив — поле убрано`);
      }
      if (n.type === 'frame') n.layout = normalizeLayout(n.layout);
      if (n.type !== 'page' && n.type !== 'instance' && !n.size) n.size = sizeSpec('hug', 'hug');
      let err = checkNode(n, doc);
      if (!err) continue;
      // узел не по схеме нельзя просто оставить: solve даст NaN и вид залипнет
      const fixed = repairNode(n, doc);
      err = checkNode(n, doc);
      if (err) {
        // починить нечем (тип, id, родитель) — выбрасываем, как битое ребро
        if (id === doc.root) continue;   // корень разбираем отдельно, ниже
        drop.push(id);
        logOnce('createDoc:drop:' + err, `createDoc: узел «${id}» не по схеме (${err}) — удалён вместе с поддеревом`);
        continue;
      }
      logOnce('createDoc:fix:' + fixed.join(','), `createDoc: узел «${id}» не по схеме — поправлены поля: ${fixed.join(', ')}`);
    }
    for (const id of drop) delete doc.nodes[id];
    // корень удалить некуда: приводим его к странице, иначе документ нечем открыть
    const rootNode = doc.nodes[doc.root];
    const rootErr = rootProblem(rootNode, doc);
    if (rootErr) {
      if (!rootNode || typeof rootNode !== 'object') {
        logOnce('createDoc:noroot', 'createDoc: корня нет — начинаем с пустой страницы');
        return emptyDoc((doc.meta && doc.meta.name) || 'Импорт');
      }
      rootNode.type = 'page';
      rootNode.parent = null;
      rootNode.id = doc.root;
      if (!Array.isArray(rootNode.children)) rootNode.children = [];
      repairNode(rootNode, doc);   // children — только строки, остальное по схеме страницы
      const left = checkNode(rootNode, doc);
      if (left) {
        logOnce('createDoc:root', `createDoc: корень не по схеме (${left}) — начинаем с пустой страницы`);
        return emptyDoc((doc.meta && doc.meta.name) || 'Импорт');
      }
      logOnce('createDoc:rootfix', `createDoc: корень «${doc.root}» не по схеме (${rootErr}) — приведён к странице`);
    }
    pruneBrokenEdges(doc);
    return doc;
  }
  const empty = seed === 'empty' || (seed && typeof seed === 'object' && seed.empty);
  const doc = emptyDoc(empty ? 'Пустая страница' : 'Черновик');
  if (empty) return withLibrary(doc);
  doc.meta.name = 'Рабочая неделя';
  return buildDemo(doc);
}


/* ------------------------------------------------------------------ *
 * 10. Сцена: отрисовка в SVG + слой интерфейса
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAGE_STYLE_ID = 'imago-stage-style';
const STAGE_CSS = `
.imago-stage{position:relative;width:100%;height:100%;overflow:hidden;outline:none;
  background:var(--canvas-bg,#F7F6F3);touch-action:none;cursor:default;user-select:none}
/* Холст фокусируемый (tabindex=0). Акцентная рамка во весь экран спорит с рамкой
   выделения — вместо неё двойная нейтральная кромка: 2 px тона --muted поверх
   1 px светлой подложки. Такую видно на любом фоне, но за выделение её не примешь.
   Клик мышью оставляем с тонкой кромкой: рамка нужна тому, кто пришёл с клавиатуры. */
.imago-stage:focus{outline:none;box-shadow:inset 0 0 0 1px var(--line,#E2DED6)}
.imago-stage:focus-visible{outline:none;
  box-shadow:inset 0 0 0 2px var(--muted,#8A92A6),inset 0 0 0 4px var(--canvas-bg,#F7F6F3)}
.imago-stage.is-panning{cursor:grabbing}
.imago-stage.is-space{cursor:grab}
.imago-svg{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;
  font-family:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.imago-ui{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.imago-ov{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.imago-box{position:absolute;border:1px solid var(--accent,#FF6B3D);pointer-events:none;box-sizing:border-box}
.imago-box.is-hover{border-color:color-mix(in srgb,var(--accent,#FF6B3D) 55%,transparent);border-style:dashed}
.imago-box.is-detached{border-style:dashed}
/* Круг 19, п.5: примета экземпляра компонента — ДВОЙНАЯ рамка выделения (вторая
   линия внутрь, через светлый зазор). Цвет не меняем и второго бейджа не заводим:
   --agent занят активностью агента, а у кромки уже стоят бейдж размера и плашка
   «отсоединён», разведённые кругом 16. Две линии читаются как «это ссылка на
   компонент, а не сам узел» и не спорят ни с пунктиром «отсоединён», ни с
   бейджем — имя компонента уходит в тот же бейдж (см. Stage._paintUI). */
.imago-box.is-instance{box-shadow:inset 0 0 0 1px var(--canvas-bg,#F7F6F3),inset 0 0 0 2px var(--accent,#FF6B3D)}
/* Бейдж — мелкий текст (10px/500), значит норма контраста 4.5:1. Цвет текста берём
   парой к фону из токенов оболочки: #fff на акценте давал 2.83:1 в тёмной теме.
   Положение считает _badge(): под узлом бейдж накрывал соседнее содержимое. */
.imago-badge{position:absolute;padding:2px 6px;border-radius:6px;
  background:var(--accent,#FF6B3D);color:var(--accent-ink,#1A0B05);
  font:500 10px/1.3 'IBM Plex Mono',ui-monospace,monospace;
  white-space:nowrap;pointer-events:none}
/* «отсоединён»: --warn — средний тон, на нём в светлой теме не набрать 4.5:1 ни
   светлым, ни тёмным текстом, поэтому тёмная подложка и предупреждающий контур.
   Цвета фиксированные: бейдж лежит на белом артборде в обеих темах. */
.imago-badge.is-detached{background:#14161C;color:#F0B429;box-shadow:inset 0 0 0 1px #F0B429}
/* Бейдж прижат к кромке узла (BADGE_GAP = 0). Уголки со стороны кромки — прямые:
   так он читается как ярлык этого узла, а не как плашка, повисшая рядом. */
.imago-badge.at-left{border-top-right-radius:0;border-bottom-right-radius:0}
.imago-badge.at-right{border-top-left-radius:0;border-bottom-left-radius:0}
.imago-badge.at-above{border-bottom-left-radius:0;border-bottom-right-radius:0}
.imago-badge.at-below{border-top-left-radius:0;border-top-right-radius:0}
/* Ручка ресайза: зона захвата 16×16 (прозрачная), сама ручка — 9×9 на кромке.
   16, а не 9: по девяти пикселям мышь соскальзывает, а пальцем не попасть совсем.
   Зона сдвинута НАРУЖУ узла — внутрь она заходит только на HANDLE_IN (3 px).
   Пока она стояла по центру кромки (margin:-8px), вокруг выделения было восемь
   невидимых пятен, которые вгрызались в содержимое на 8 px: по мелкому тексту
   внутри выделенного фрейма нельзя было ни щёлкнуть, ни попасть двойным кликом.
   Положение зоны и точки внутри неё (--hx/--hy) считает Stage._handles(). */
/* z-index: элементы ручек живут между кадрами и лежат в слое раньше рамок и
   бейджей — без него бейдж перекрывал бы точку ручки. */
.imago-h{position:absolute;width:16px;height:16px;z-index:2;
  background:none;border:0;pointer-events:auto;box-sizing:border-box}
.imago-h::before{content:'';position:absolute;left:var(--hx,8px);top:var(--hy,8px);
  transform:translate(-50%,-50%);
  width:9px;height:9px;box-sizing:border-box;border:1px solid var(--accent,#FF6B3D);
  background:#fff;border-radius:2px}
.imago-h[data-handle="n"],.imago-h[data-handle="s"]{cursor:ns-resize}
.imago-h[data-handle="e"],.imago-h[data-handle="w"]{cursor:ew-resize}
.imago-h[data-handle="nw"],.imago-h[data-handle="se"]{cursor:nwse-resize}
.imago-h[data-handle="ne"],.imago-h[data-handle="sw"]{cursor:nesw-resize}
.imago-editor{position:absolute;pointer-events:auto;outline:2px solid var(--accent,#FF6B3D);
  border-radius:3px;background:#fff;white-space:pre-wrap;overflow-wrap:break-word;z-index:5;margin:0;padding:0}
/* Подсказка у редактора: что делают Enter и Esc. Тон нейтральный (не акцентный) —
   рядом висит акцентный бейдж размера, и два оранжевых ярлыка спорили бы.
   Контраст #F7F6F3 на #14161C — 15,7:1, с запасом для кегля 10.
   Ставится над верхней кромкой (см. _positionEditor): вниз редактор растёт. */
.imago-editor-hint{position:absolute;padding:2px 6px;border-radius:6px;
  background:#14161C;color:#F7F6F3;
  font:500 10px/1.3 'IBM Plex Sans',system-ui,-apple-system,sans-serif;
  white-space:nowrap;pointer-events:none;z-index:6}
/* Подпись артборда лежит на холсте (--canvas-bg), а не на панели, и кегль у неё 11 —
   значит норма контраста 4,5:1. Жёстко зашитый #8A92A6 давал в светлой теме 2,11:1.
   Тёмной теме хватает --muted (#8a92a6 на #0a0b0e = 6,32:1), светлой подставляем
   тон темнее (#4A505C на #d9d4cb = 5,49:1; на токене холста #F7F6F3 — 7,52:1).
   Оболочка может задать свой цвет через --imago-ab-label. */
.imago-ab-label{fill:var(--imago-ab-label,var(--muted,#8A92A6))}
:root[data-theme="light"] .imago-ab-label{fill:var(--imago-ab-label,#4A505C)}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]) .imago-ab-label{fill:var(--imago-ab-label,#4A505C)}
}
.imago-node{transform-box:fill-box}
/* Круг 36 (SPEC §11.3): режим «Просмотр» — выделения нет, курсор-рука над узлом,
   у которого есть состояния (наведение, нажатие, фокус проигрываются на холсте). */
.imago-stage.is-preview{cursor:default}
.imago-stage.is-preview.is-live{cursor:pointer}
.imago-pulse{animation:imago-pulse 900ms ease-out forwards}
@keyframes imago-pulse{0%{opacity:.95}70%{opacity:.5}100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.imago-pulse{animation:none;opacity:0}}
`;

function ensureStageStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STAGE_STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STAGE_STYLE_ID;
  st.textContent = STAGE_CSS;
  document.head.appendChild(st);
}

/**
 * Префикс id обрезки. Два экспортированных SVG, вставленных инлайном в один
 * документ, раньше перебивали обрезку друг другу: id шли с нуля на каждый вызов
 * toSVG. Префикс случайный и свой на каждый документ разметки.
 * @returns {string}
 */
let clipPrefixSeq = 0;
function newClipPrefix() {
  clipPrefixSeq = (clipPrefixSeq + 1) % 1000000;
  const rnd = Math.random().toString(36).slice(2, 8);
  return 'imago-clip-' + rnd + clipPrefixSeq.toString(36) + '-';
}

/** Атрибут поворота вокруг центра рамки (круг 37). */
function rotateAttr(deg, rect, dx, dy) {
  return `rotate(${fmtNum(deg, 3)} ${fmtNum(rect.x + dx + rect.w / 2, 2)} ${fmtNum(rect.y + dy + rect.h / 2, 2)})`;
}

/* ------------------------------------------------------------------ *
 * Круг 47 (SPEC §14.4): разметка SVG без браузера.
 *
 * Критику агента на сервере нужен снимок доски, а сцена строит SVG через DOM.
 * Вместо второй, «серверной» отрисовки (которая разошлась бы с экраном на
 * первой же правке) та же самая отрисовка Stage идёт в крошечный DOM в памяти:
 * элементы с атрибутами, детьми, текстом и style — ровно то, что трогает путь
 * toSVG. Подменяется только источник элементов (svgDom), и только на время
 * одного синхронного вызова renderSVG.
 * ------------------------------------------------------------------ */

// знаки, которых в XML нет вовсе (управляющие, одиночные суррогаты, U+FFFE/FFFF): resvg на них
// бросает, а <img> не грузит разметку — выкидываем при сериализации
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const escXml = (s) => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class MemText {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
  get outerHTML() { return escXml(this.data); }
}

class MemEl {
  constructor(name) {
    this.nodeType = 1;
    this.tagName = name;
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    const css = {};
    this.style = css;
  }
  setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
  // ссылка картинки — единственный атрибут с пространством имён на пути toSVG (xlink:href)
  setAttributeNS(ns, k, v) { this.attrs.set(ns === 'http://www.w3.org/1999/xlink' && !/:/.test(k) ? 'xlink:' + k : String(k), String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) {
    if (c && c.isFragment) { for (const x of c.childNodes.splice(0)) this.appendChild(x); return c; }
    if (c && c.parentNode) c.parentNode.removeChild(c);
    if (c) { c.parentNode = this; this.childNodes.push(c); }
    return c;
  }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    if (c && c.parentNode) c.parentNode.removeChild(c);
    const i = this.childNodes.indexOf(ref);
    c.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
    return c;
  }
  set textContent(t) { this.childNodes = [new MemText(t)]; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  get outerHTML() {
    let a = '';
    for (const [k, v] of this.attrs) a += ' ' + k + '="' + escXml(v) + '"';
    const css = Object.keys(this.style).filter((k) => this.style[k] !== '' && this.style[k] != null)
      .map((k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + this.style[k]).join(';');
    if (css) a += ' style="' + escXml(css) + '"';
    // <style> — текст как есть: в CSS нет ни «<», ни «&», которые надо прятать
    const inner = this.tagName === 'style'
      ? this.childNodes.map((c) => (c.nodeType === 3 ? String(c.data).replace(XML_BAD, '') : c.outerHTML)).join('')
      : this.childNodes.map((c) => c.outerHTML).join('');
    return '<' + this.tagName + a + (inner ? '>' + inner + '</' + this.tagName + '>' : '/>');
  }
}

const memDom = {
  createElementNS: (_ns, name) => new MemEl(name),
  createElement: (name) => new MemEl(name),
  createTextNode: (t) => new MemText(t),
  createDocumentFragment: () => Object.assign(new MemEl('#fragment'), { isFragment: true }),
};

/** Откуда берутся элементы разметки: страница или память (renderSVG). */
let svgDom = null;
const dom = () => svgDom || document;

function svgEl(name, attrs) {
  const el = dom().createElementNS(SVG_NS, name);
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  }
  return el;
}

function safeImageSrc(src) {
  if (typeof src !== 'string') return null;
  const v = src.trim();
  if (/^data:image\//i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

/** Внешний ли это адрес: такие живут в SVG, но в PNG сами не попадают. */
const isExternalSrc = (src) => typeof src === 'string' && /^https?:\/\//i.test(src);

/** Байты в base64: btoa есть и в браузере, и в Node; режем кусками ради стека. */
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/**
 * Внешняя картинка → data:-адрес.
 *
 * Зачем: снимок PNG сериализует сцену в SVG-blob и грузит его как <img>, а в
 * этом режиме браузер внешние ресурсы не подгружает — на месте картинки
 * оказывалась хромовская заглушка «битое изображение» во весь артборд, и это
 * выдавалось за успех. Поэтому адреса подменяются заранее.
 * @param {string} url
 * @returns {Promise<string>} data:image/... ; бросает, если не вышло
 */
async function toDataUrl(url) {
  if (typeof fetch !== 'function') throw new Error('fetch недоступен');
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res || !res.ok) throw new Error(`ответ ${res ? res.status : '—'}`);
  const blob = await res.blob();
  const type = (blob && blob.type) || '';
  if (type && !/^image\//i.test(type)) throw new Error(`это не картинка (${type})`);
  if (typeof FileReader === 'function') {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const v = String(fr.result || '');
        if (/^data:image\//i.test(v)) resolve(v);
        else reject(new Error('получился не data:image'));
      };
      fr.onerror = () => reject(fr.error || new Error('картинку не прочитать'));
      fr.readAsDataURL(blob);
    });
  }
  const buf = await blob.arrayBuffer();
  return 'data:' + (/^image\//i.test(type) ? type : 'image/png') + ';base64,' + bytesToBase64(new Uint8Array(buf));
}

/** Переведённые адреса: снимок одного и того же артборда не тянет картинки заново. */
const dataUrlCache = new Map();
const DATA_URL_CACHE_LIMIT = 24;

/**
 * Все внешние адреса разом. Отказ хотя бы по одному — отказ целиком: половина
 * картинок и заглушка вместо второй половины хуже честного «сохраните SVG».
 * @param {string[]} urls
 * @returns {Promise<Map<string,string>>}
 */
async function inlineImageSrcs(urls) {
  const map = new Map();
  const fresh = [];
  for (const url of urls) {
    const hit = dataUrlCache.get(url);
    if (hit) map.set(url, hit);
    else if (!fresh.includes(url)) fresh.push(url);
  }
  const got = await Promise.all(fresh.map((u) => toDataUrl(u)));
  // предел — не меньше, чем понадобилось этому снимку: на артборде с тремя
  // десятками картинок жёсткие 24 вытесняли их одну за другой на каждом экспорте
  const limit = Math.max(DATA_URL_CACHE_LIMIT, fresh.length * 2);
  fresh.forEach((u, i) => {
    cachePut(dataUrlCache, u, got[i], limit);
    map.set(u, got[i]);
  });
  return map;
}

/* ----------------------- гарнитуры для экспорта ----------------------- */

/**
 * Зачем это здесь. Экспорт ссылается на гарнитуру по имени и ничего с собой не
 * несёт. SVG внутри <img> (так снимается PNG) — изолированный документ: шрифты
 * страницы туда не попадают, и браузер считает текст системным. Замер в Chrome:
 * `600 18px "IBM Plex Sans"` — 283 px, тот же текст системным шрифтом — 343 px
 * (+21 %). Подпись, помещавшаяся в карточку на экране, вылезала за её кромку в
 * файле, и никто об этом не предупреждал. Лечится встраиванием начертаний:
 * @font-face с src:url(data:font/woff2;base64,…) прямо в разметке.
 */
const FONT_CSS_ORIGIN = 'https://fonts.googleapis.com/css2';
/** Семейства, которые незачем тянуть: их всё равно даёт система. */
const GENERIC_FONTS = new Set([
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji'
]);
/** Стили Google Fonts по адресу запроса — рядом с dataUrlCache и по той же логике. */
const fontCssCache = new Map();
/** Файлы начертаний: адрес woff2 → data:. */
const fontDataCache = new Map();
/**
 * Предел кеша — не число, а запас от размера самого запроса. С жёсткими 24 на
 * девяти гарнитурах (9 × 3 поднабора = 27 файлов) вытеснение начиналось прямо во
 * время загрузки: первые встроенные выпадали до того, как соберётся разметка, и
 * экспорт честно, но напрасно сообщал `partial`. Тройной запас держит в кеше и
 * текущий запрос, и предыдущий такой же, а на маленьких запросах кеш сам
 * усыхает до минимума (cachePut вытесняет, пока не влезет).
 */
const FONT_CACHE_MIN = 24;
const fontCacheLimit = (n) => Math.max(FONT_CACHE_MIN, Math.ceil(n) * 3);
/** Запросы «в полёте»: два экспорта подряд не тянут одно и то же дважды. */
const fontInFlight = new Map();

/**
 * Положить в кеш, вытеснив самое старое. Предел плавает (см. fontCacheLimit), и
 * вытесняем не больше одной записи за раз: иначе маленький запрос, пришедший
 * рядом с большим, разом выбросил бы то, что большой только что скачал. Кеш от
 * этого усыхает постепенно, а не рывком.
 */
function cachePut(map, key, value, limit) {
  if (map.has(key)) { map.set(key, value); return; }
  if (map.size >= Math.max(1, isNum(limit) ? limit : 1)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Адрес стилей Google Fonts для семейства и набора начертаний. */
function fontCssUrl(family, weights) {
  const ws = [...new Set(weights)].filter((w) => isNum(w)).sort((a, b) => a - b).join(';');
  return FONT_CSS_ORIGIN + '?family=' + encodeURIComponent(family).replace(/%20/g, '+')
    + (ws ? ':wght@' + ws : '') + '&display=swap';
}

/** Разбор `unicode-range` в список пар [от, до]. */
function parseUnicodeRange(text) {
  const out = [];
  for (const raw of String(text || '').split(',')) {
    const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(raw.trim());
    if (!m) continue;
    if (m[2]) { out.push([parseInt(m[1], 16), parseInt(m[2], 16)]); continue; }
    if (m[1].indexOf('?') >= 0) {
      out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)]);
      continue;
    }
    const v = parseInt(m[1], 16);
    out.push([v, v]);
  }
  return out;
}

/** Нужен ли этот поднабор: есть ли в тексте хоть один символ из его диапазона. */
function rangeHits(range, codes) {
  const pairs = parseUnicodeRange(range);
  if (!pairs.length) return true;   // без указания диапазона поднабор общий
  for (const c of codes) {
    for (const [a, b] of pairs) if (c >= a && c <= b) return true;
  }
  return false;
}

/** Разбор @font-face из стилей Google Fonts (нас интересует только woff2). */
function parseFontFaces(css) {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const pick = (name) => {
      const r = new RegExp(name + '\\s*:\\s*([^;]+)', 'i').exec(body);
      return r ? r[1].trim() : '';
    };
    const src = /url\(\s*['"]?([^)'"]+)['"]?\s*\)\s*format\(\s*['"]?woff2['"]?\s*\)/i.exec(body);
    if (!src) continue;
    const family = pick('font-family').replace(/^['"]|['"]$/g, '');
    if (!family) continue;
    out.push({
      family,
      weight: pick('font-weight') || '400',
      style: pick('font-style') || 'normal',
      stretch: pick('font-stretch'),
      range: pick('unicode-range'),
      url: src[1].trim()
    });
  }
  return out;
}

/** Правило @font-face со встроенным файлом. */
function faceRule(face, dataUrl) {
  return '@font-face{font-family:"' + face.family.replace(/["\\]/g, '') + '"'
    + ';font-style:' + face.style
    + ';font-weight:' + face.weight
    + (face.stretch ? ';font-stretch:' + face.stretch : '')
    + ';src:url(' + dataUrl + ') format("woff2")'
    + (face.range ? ';unicode-range:' + face.range : '')
    + ';}';
}

/** Текст по адресу (стили Google Fonts). */
async function fetchOnce(url, read) {
  let p = fontInFlight.get(url);
  if (!p) {
    p = (async () => {
      if (typeof fetch !== 'function') throw new Error('fetch недоступен');
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res || !res.ok) throw new Error(`ответ ${res ? res.status : '—'}`);
      return await read(res);
    })();
    fontInFlight.set(url, p);
    p.catch(() => {});   // необработанного отказа быть не должно
  }
  try { return await p; } finally { fontInFlight.delete(url); }
}

/**
 * Собрать @font-face из того, что уже в кеше. Синхронно — этим пользуется toSVG,
 * которому нельзя ждать сеть.
 * @param {Map<string,{weights:Set<number>,codes:Set<number>}>} needs
 * @returns {{css:string, done:string[], missing:string[]}}
 */
function fontCssFromCache(needs) {
  let css = '';
  const done = [];
  const missing = [];
  for (const [family, rec] of needs) {
    const sheet = fontCssCache.get(fontCssUrl(family, [...rec.weights]));
    if (!sheet) { missing.push(family); continue; }
    const faces = parseFontFaces(sheet).filter((f) => rangeHits(f.range, rec.codes));
    let whole = faces.length > 0;
    let part = '';
    for (const f of faces) {
      const data = fontDataCache.get(f.url);
      if (!data) { whole = false; continue; }
      part += faceRule(f, data);
    }
    css += part;
    (whole ? done : missing).push(family);
  }
  return { css, done, missing };
}

/**
 * Одно слово о том, что вышло со встраиванием: `embedded` — всё на месте,
 * `partial` — часть, `missing` — ничего. Оболочка по нему решает, предупреждать
 * ли, что файл может разойтись с экраном.
 * @param {{css:string, done:string[], missing:string[]}} res
 * @returns {string}
 */
function fontState(res) {
  if (!res || !res.missing || !res.missing.length) return 'embedded';
  return res.css ? 'partial' : 'missing';
}

/**
 * Дотянуть недостающие начертания и собрать разметку. Отказ по одному семейству
 * не рушит остальные: половина встроенных гарнитур лучше, чем ни одной, — а о
 * недостающих зовущий узнаёт из `missing`.
 * @param {Map<string,{weights:Set<number>,codes:Set<number>}>} needs
 * @returns {Promise<{css:string, done:string[], missing:string[]}>}
 */
async function loadFontCss(needs) {
  // сколько файлов уже потребовал этот запрос: предел кеша растёт вместе с ним,
  // поэтому вытеснить только что встроенное начертание он не может
  let wanted = 0;
  for (const [family, rec] of needs) {
    const url = fontCssUrl(family, [...rec.weights]);
    try {
      let sheet = fontCssCache.get(url);
      if (sheet === undefined) {
        sheet = await fetchOnce(url, (r) => r.text());
        cachePut(fontCssCache, url, sheet, fontCacheLimit(needs.size));
      }
      const faces = parseFontFaces(sheet).filter((f) => rangeHits(f.range, rec.codes));
      wanted += faces.length;
      const dataLimit = fontCacheLimit(wanted);
      await Promise.all(faces.map(async (f) => {
        if (fontDataCache.has(f.url)) return;
        try {
          const bytes = new Uint8Array(await fetchOnce(f.url, (r) => r.arrayBuffer()));
          if (!bytes.length) throw new Error('пустой файл начертания');
          cachePut(fontDataCache, f.url, 'data:font/woff2;base64,' + bytesToBase64(bytes), dataLimit);
        } catch (e) {
          logOnce('font:file:' + f.url, `начертание «${family}» не встроилось в экспорт`, e);
        }
      }));
    } catch (e) {
      logOnce('font:css:' + url, `стили гарнитуры «${family}» не получены — экспорт посчитает её системной`, e);
    }
  }
  return fontCssFromCache(needs);
}

function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { return false; }
}

/**
 * Пределы полотна для PNG. Chrome отказывается от canvas со стороной больше
 * 65535 px и площадью больше 2^28 px: 1200×46000 при 2× (2400×92000) уже за
 * стороной, и toBlob возвращает null. Замеры: 2400×60000 — 2,99 МБ,
 * 1200×46000 — 1,25 МБ. Пределы можно передать в screenshot({maxSide,maxArea}).
 */
const CANVAS_MAX_SIDE = 65535;
const CANVAS_MAX_AREA = 268435456;
/** Ниже этого масштаба снимок бессмысленен — лучше честный отказ. */
const SHOT_MIN_SCALE = 0.05;

/**
 * Наибольший масштаб не выше желаемого, при котором полотно ещё создаётся.
 * Порядок: как просили → 1× → плавно вниз. null — не влезает даже в минимуме.
 * @returns {number|null}
 */
function fitShotScale(w, h, want, maxSide, maxArea) {
  const fits = (s) => {
    const W = Math.max(1, Math.round(w * s));
    const H = Math.max(1, Math.round(h * s));
    return W <= maxSide && H <= maxSide && W * H <= maxArea;
  };
  if (fits(want)) return want;
  if (want > 1 && fits(1)) return 1;
  // предел по стороне и по площади сразу: дальше только уточняем вниз
  const bySide = Math.min(maxSide / w, maxSide / h);
  const byArea = Math.sqrt(maxArea / (w * h));
  let s = Math.floor(Math.min(want, bySide, byArea) * 100) / 100;
  for (let i = 0; i < 8 && s >= SHOT_MIN_SCALE; i++) {
    if (fits(s)) return s;
    s = Math.floor(s * 90) / 100;
  }
  return null;
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Зона захвата ручки на экране и то, насколько она заходит внутрь узла. */
const HANDLE_SIZE = 16;
const HANDLE_IN = 3;
/** Видимая точка ручки — 9×9 (см. .imago-h::before в STAGE_CSS). */
const HANDLE_DOT = 9;
/**
 * На сколько видимая точка отодвинута от кромки НАРУЖУ. Внутрь зона захвата
 * заходит только на HANDLE_IN (глубже она съедает клики по содержимому узла —
 * круг 9), а точка тянется внутрь на половину своего размера: её внутренняя
 * полоска в 1.5 px оставалась вне зоны и ловилась обычным хит-тестом, который у
 * угловых ручек попадал уже мимо узла — в артборд. Сдвигаем точку ровно
 * настолько, чтобы она целиком легла в зону: её внутренняя кромка совпадает с
 * внутренней кромкой зоны, а кромку узла она по-прежнему накрывает.
 */
const HANDLE_OUT = Math.max(0, HANDLE_DOT / 2 - HANDLE_IN);

/**
 * Какие ручки показывать у выделенного узла.
 *
 * Ряд из трёх ручек требует 3×16 px на экране. На узле высотой 10 px (текст при
 * зуме 55 %) три ручки с каждой стороны перекрывались на 11 px и сливались в
 * непрозрачный блок 26 px, который закрывал первый и последний символ —
 * «Дальше сегодня» читалось как «альше сегодня». Поэтому: тесно по оси — убираем
 * серединную ручку, совсем тесно — оставляем одну, у дальней кромки (туда узел
 * и растят). У текста ручка одна: его размер задают содержимое и контейнер, а
 * восемь ручек поверх строки — это только съеденные клики по самому тексту.
 * @param {object} node
 * @param {{w:number,h:number}} sr экранный прямоугольник узла
 * @returns {string[]}
 */
function handleNames(node, sr) {
  if (node && node.type === 'text') return ['se'];
  const slots = (extent, lo, hi) => {
    if (extent >= HANDLE_SIZE * 3) return [lo, '', hi];
    if (extent >= HANDLE_SIZE * 2) return [lo, hi];
    return [hi];
  };
  const rows = slots(sr.h, 'n', 's');
  const cols = slots(sr.w, 'w', 'e');
  const want = new Set();
  for (const r of rows) for (const c of cols) if (r || c) want.add(r + c);
  return HANDLES.filter((h) => want.has(h));
}
/** Высота бейджа на экране: 10px/1.3 + по 2px отбивки = 17. */
const BADGE_H = 17;
/**
 * Отбивка бейджа от кромки узла — ноль: он прирастает к рамке выделения.
 * С зазором в 4 px бейдж ресайза читался как отдельная плашка, повисшая рядом
 * на тёмном холсте (у прижатого к левому краю артборда — вообще вне макета), и
 * с узлом его связывала только близость. Прижатый к кромке, он делит с рамкой
 * одну линию, а прямые уголки с этой стороны (см. класс at-* в CSS) дочитывают
 * его как ярлык этого узла. Внутрь узла (последний вариант) бейдж по-прежнему
 * кладётся с отступом — там он лежит на содержимом, и кромку дублировать нечем.
 */
const BADGE_GAP = 0;
const BADGE_PAD = 4;
/**
 * Ширина бейджа: IBM Plex Mono 10px — ровно 6 px на знак (0,6 кегля), плюс
 * отбивки 6+6. Считаем точно, а не с запасом: по этой ширине бейдж прижимается
 * к левой кромке узла, и лишние 4 px запаса превращались в видимый зазор —
 * ради которого всё и затевалось.
 */
const badgeWidth = (text) => Math.round(String(text).length * 6) + 12;

/* Сравнения для точечного обновления сцены (Stage._patchSVG, круг 16, п.6).
   Решатель на каждый вызов делает НОВЫЕ прямоугольники и строки, поэтому
   сравнивать их приходится по значению; сами узлы applyOps пересоздаёт только
   там, где они изменились, — их достаточно сравнить по ссылке. */
/** @returns {boolean} */
function sameIdList(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** @returns {boolean} */
function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
/** @returns {boolean} */
function sameLines(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Куда положить бейдж. Он не должен накрывать содержимое макета, поэтому ищем
 * место ВНЕ узла, обходя края области просмотра:
 *  1) слева от узла, по его нижней кромке — там поле артборда или холст;
 *  2) справа от узла — когда узел прижат к левому краю (прошлый круг сдвинул
 *     бейдж влево, и у левого края он снова лёг на содержимое: закрывал
 *     «Купить» на кнопке и строку «10:30 — 11:15 · переговорная «Север»»);
 *  3) над верхней кромкой — когда по бокам места нет;
 *  4) под нижней кромкой — когда узел прижат к верхнему краю;
 *  5) и только если снаружи места не осталось — внутрь узла, к нижней кромке.
 * По горизонтали в вариантах 3–4 бейдж прижимается к области просмотра, чтобы
 * не уехать за экран.
 *
 * Над верхней кромкой артборда лежит его имя — та же полоса, тот же уголок: у
 * выделенного артборда «960 × 560» ложилось прямо на «Сводка недели». Занятую
 * подписью полосу передают в `label`; бейдж тогда встаёт правее подписи, а если
 * там уже нет места — уходит под нижнюю кромку.
 * @param {{x:number,y:number,w:number,h:number}} sr экранный прямоугольник узла
 * @param {string} text содержимое бейджа — по нему считается ширина
 * @param {number} [slot] этаж: 0 — нижний, 1 — на строку выше
 * @param {{w:number,h:number}} [view] размер области просмотра; без него считаем, что места хватает
 * @param {{w:number,y1:number,y2:number}} [label] полоса, занятая подписью артборда (см. Stage._labelBand)
 * @returns {{x:number, y:number, where:string}}
 */
function badgePlace(sr, text, slot, view, label) {
  const step = BADGE_H + 3;
  const floor = slot ? slot * step : 0;
  const bw = badgeWidth(text);
  const vw = view && isNum(view.w) ? view.w : Infinity;
  const vh = view && isNum(view.h) ? view.h : Infinity;
  const stacked = sr.y + sr.h - BADGE_H - floor;
  /* Круг 16, п.8: у кромки узла второй ярлык («отсоединён») уходит к ВЕРХНЕЙ
   * кромке, а не встаёт вплотную над первым. Две плашки подряд у одного угла
   * читались как одна двухэтажная надпись поверх содержимого — на перетаскивании
   * карточки размер и «отсоединён» сливались. Разводим их по разным кромкам
   * узла; на низком узле (двум ярлыкам не разойтись) остаётся прежний этаж. */
  const apart = slot > 0 && sr.h >= 2 * BADGE_H + 6;
  const y = apart ? sr.y : stacked;
  const left = sr.x - BADGE_GAP - bw;
  if (left >= 2) return { x: left, y, where: 'left' };
  const right = sr.x + sr.w + BADGE_GAP;
  if (right + bw <= vw - 2) return { x: right, y, where: 'right' };
  const alongX = clamp(sr.x, 2, Math.max(2, vw - bw - 2));
  const above = sr.y - BADGE_GAP - BADGE_H - floor;
  if (above >= 2) {
    // подпись артборда мешает только если бейдж встаёт с ней на одну строку:
    // второй этаж (slot) проходит выше неё и уступать никому не должен
    const busy = label && isNum(label.w) && label.w > 0
      && above + BADGE_H > label.y1 && above < label.y2 ? label.w + 6 : 0;
    const x = clamp(sr.x + busy, 2, Math.max(2, vw - bw - 2));
    // если вправо бейдж не влез и его прижало назад к подписи — идём под кромку
    if (!busy || x >= sr.x + busy - 0.01) return { x, y: above, where: 'above' };
  }
  const below = sr.y + sr.h + BADGE_GAP + floor;
  if (below + BADGE_H <= vh - 2) return { x: alongX, y: below, where: 'below' };
  // последний вариант — внутрь узла: там этажи по-прежнему считаются от нижней кромки
  return { x: sr.x + BADGE_PAD, y: stacked - BADGE_PAD, where: 'inside' };
}
/**
 * Подпись у инлайн-редактора. Esc бросает набранное без следа в истории, и
 * молчать об этом нельзя: два самых инстинктивных «готово» названы вслух.
 */
const EDIT_HINT = 'Enter — применить, Esc — отменить';
/** Ширина подсказки: IBM Plex Sans 10px — 0,56 кегля на знак, плюс отбивки 6+6. */
const editHintWidth = () => Math.round(EDIT_HINT.length * 5.6) + 14;

/** Подпись артборда: кегль на экране и ширина, ниже которой подпись только мешает. */
const AB_LABEL_SIZE = 11;
const AB_LABEL_MIN_W = 80;
/** Ширина знака IBM Plex Sans в среднем 0.56 кегля (замерено) — берём 0.6 с запасом. */
const AB_LABEL_CHAR = 0.6;
/**
 * Круг 32: узлов в одной правке, сверх которых сцена не подсвечивает и не анимирует каждый
 * (рамка подсветки на узел — слой композитора; 8000 таких — кадр на 9–11 с), а обводит
 * правку двумя общими рамками: удалённое и созданное с изменённым.
 */
const STAGE_PULSE_MAX = 200;

/**
 * Сцена: рисует документ в SVG и обрабатывает ввод.
 * Документ не меняет — все правки уходят наружу через opts.onCommit({ops,label}).
 */
class Stage {
  /**
   * @param {HTMLElement} host
   * @param {{onSelect?:Function,onCommit?:Function,onHover?:Function,onUndo?:Function,onRedo?:Function,onView?:Function,onError?:Function,onDragCancel?:Function}} [opts]
   *   onDragCancel({mode,id,reason}) — жест снят, потому что документ переехал под рукой.
   */
  constructor(host, opts = {}) {
    ensureStageStyles();
    this.opts = opts || {};
    this.host = host;
    this.doc = null;
    this.geo = { rects: {}, lines: {}, order: [] };
    this.state = { selection: [] };
    this.view = { zoom: 1, pan: { x: 0, y: 0 } };
    this.activeArtboard = null;

    this.el = document.createElement('div');
    this.el.className = 'imago-stage';
    this.el.tabIndex = 0;
    this.svg = svgEl('svg', { class: 'imago-svg', 'shape-rendering': 'geometricPrecision' });
    this.ui = document.createElement('div');
    this.ui.className = 'imago-ui';
    this.ov = svgEl('svg', { class: 'imago-ov' });
    this.ui.appendChild(this.ov);
    this.el.appendChild(this.svg);
    this.el.appendChild(this.ui);
    host.appendChild(this.el);

    this._nodeEls = new Map();
    this._prevRects = {};   // геометрия прошлого кадра — для FLIP, см. render()
    this._editing = null;
    this._drag = null;
    this._hover = null;
    this._space = false;
    this._guides = [];
    this._marquee = null;
    this._insertion = null;
    this._preview = null;      // на сцене висит пересчитанный черновик жеста
    this._previewFrame = null; // запланированный кадр предпросмотра
    this._handleEls = new Map(); // ручки ресайза: элементы живут между кадрами
    this._shifted = [];       // соседи, раздвинутые под место вставки
    this._pulses = [];
    this._touch = null;
    this._srcMap = null;       // подмена адресов картинок на время сборки SVG (см. toSVG)
    this._shotQueue = null;    // очередь снимков: screenshot() не идёт внахлёст сам с собой
    this._clipSeq = 0;
    this._clipPrefix = newClipPrefix();   // свой на сцену: две сцены на странице не столкнутся
    this._fontWarm = null;      // отложенная подтяжка начертаний для экспорта
    this._fontTried = null;     // набор, за которым уже ходили (и не дошли)
    this._timers = new Set();   // отложенные вызовы FLIP — снимаются в destroy()
    this._pulseTimer = null;
    this._dead = false;
    this._drawSeen = new Set();
    /* круг 36 (SPEC §11.3): состояния на холсте. _previewOn — режим «Просмотр»;
       _ix — что сейчас под рукой (наведение и нажатие — цепочки id от глубокого
       к корню, фокус — один id); _forced — состояния, показанные playState;
       _stList — id нарисованных узлов со states (пересчёт после отрисовки). */
    this._previewOn = false;
    this._ix = { hover: new Set(), press: new Set(), focus: null };
    this._forced = new Map();
    this._forcedTimers = new Map();
    this._stList = null;
    this._exportStates = null;

    this._vp = null;            // кеш размера вьюпорта, см. _viewport()
    this._vbBase = null;        // вид и размер вьюпорта, по которым записан viewBox (см. _keepsView)
    this._onResize = () => this._resized();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.el);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._onResize);
    }
    this._bindEvents();
  }

  /** Снять отложенный вызов и забыть его id. */
  _cancelLater(id) {
    if (id === null || id === undefined) return;
    clearTimeout(id);
    this._timers.delete(id);
  }

  /** Отложенный вызов с учётом destroy(): таймер помнится и снимается. */
  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._dead) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  /** Освободить слушатели, таймеры и DOM. */
  destroy() {
    this._dead = true;
    this._cancelPreview();
    if (this._ro) this._ro.disconnect();
    else if (typeof window !== 'undefined') window.removeEventListener('resize', this._onResize);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onWinKey, true);
      window.removeEventListener('keyup', this._onWinKeyUp, true);
      window.removeEventListener('blur', this._onWinBlur);
    }
    this._cancelLater(this._pulseTimer);
    this._pulseTimer = null;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this._pulses = [];
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  /* --------------------------- геометрия вида --------------------------- */

  /* Размер вьюпорта. Кешируем: чтение clientWidth заставляет браузер пересчитать
     раскладку всей страницы прямо сейчас, а _paintUI зовётся по нескольку раз на
     одно действие человека (выделение, наведение, ручки). На документе в 40 477
     узлов один такой пересчёт стоил ~250 мс, и клик по узлу платил их пять
     (круг 16, п.6). Кеш сбрасывает ResizeObserver — размер сцены меняет только он.
     Нулевой размер (сцена ещё не на экране) не кешируем: иначе он залипнет. */
  _viewport() {
    if (this._vp) return this._vp;
    const w = this.el ? this.el.clientWidth : 0;
    const h = this.el ? this.el.clientHeight : 0;
    if (!w || !h) return { w: w || 1, h: h || 1 };
    this._vp = { w, h };
    return this._vp;
  }

  get vw() { return this._viewport().w; }
  get vh() { return this._viewport().h; }

  /**
   * Круг 30: размер сцены сменился (ResizeObserver / resize окна).
   *
   * Появление колонки инспектора сужает сцену; прежде здесь всегда переписывался viewBox —
   * и Chrome перекладывал весь SVG-текст второй раз подряд (первый — вынужденно, на новой
   * ширине): на 10 000 узлах ещё 200–350 мс к первому выделению. Но при
   * `preserveAspectRatio="xMinYMin slice"` масштаб картинки — max(ширина / ширина viewBox,
   * высота / высота viewBox): сцена стала уже при той же высоте — масштаб и левый верхний
   * угол прежние, справа просто меньше видно. viewBox тогда не трогаем (см. _keepsView);
   * накладку (рамки, бейджи) перерисовываем, только если размер правда другой: бейджи
   * жмутся к краю вьюпорта.
   */
  _resized() {
    if (this._dead) return;
    const was = this._vp;
    this._vp = null;
    const now = this._viewport();
    if (this._keepsView(now)) {
      if (!was || was.w !== now.w || was.h !== now.h) this._paintUI();
      return;
    }
    this._applyView();
    this._paintUI();
  }

  /**
   * Записанный viewBox по-прежнему даёт ровно нынешний вид: зум и сдвиг те же, а вьюпорт
   * по одной оси тот же, по другой — не больше (масштаб slice = max отношений = 1).
   * @param {{w:number,h:number}} [vp] размер вьюпорта (по умолчанию — нынешний)
   */
  _keepsView(vp) {
    const b = this._vbBase;
    if (!b || !this._viewBox) return false;
    if (b.z !== this.view.zoom || b.px !== this.view.pan.x || b.py !== this.view.pan.y) return false;
    const v = vp || this._viewport();
    if (!(v.w > 0 && v.h > 0 && b.w > 0 && b.h > 0)) return false;
    return Math.abs(Math.max(v.w / b.w, v.h / b.h) - 1) < 1e-9;
  }

  /** Экранные координаты события в координаты документа. */
  toWorld(clientX, clientY) {
    const b = this.el.getBoundingClientRect();
    const z = this.view.zoom;
    return { x: (clientX - b.left - this.view.pan.x) / z, y: (clientY - b.top - this.view.pan.y) / z };
  }

  /** Координаты документа в координаты слоя интерфейса. */
  toScreen(x, y) {
    const z = this.view.zoom;
    return { x: x * z + this.view.pan.x, y: y * z + this.view.pan.y };
  }

  _applyView() {
    const z = this.view.zoom;
    const vx = -this.view.pan.x / z;
    const vy = -this.view.pan.y / z;
    // круг 30: сцена сузилась по одной оси при том же виде — записанный viewBox даёт ту же
    // картинку (см. _resized); переписав его, следующий рендер уронил бы раскладку всего SVG
    if (!this._keepsView()) {
      const box = `${r2(vx)} ${r2(vy)} ${r2(this.vw / z)} ${r2(this.vh / z)}`;
      // Круг 16, п.6: перезапись viewBox тем же значением всё равно роняет раскладку
      // всего SVG — на 12 198 узлах это 134 мс на КАЖДОМ кадре, даже когда ни вид,
      // ни сцена не менялись (рендер после правки, отмена, повторная отрисовка).
      if (this._viewBox !== box) {
        this._viewBox = box;
        this.svg.setAttribute('viewBox', box);
        this.svg.setAttribute('preserveAspectRatio', 'xMinYMin slice');
      }
      this._vbBase = { z, px: this.view.pan.x, py: this.view.pan.y, w: this.vw, h: this.vh };
    }
    if (this._gridGroup) this._renderGrid();
    this._updateLabels();
  }

  /**
   * Подписи артбордов: кегль держим постоянным на экране, а на мелком зуме подпись
   * прячем (на десятке артбордов они иначе сливаются в кашу) и обрезаем по ширине
   * самого артборда.
   */
  _updateLabels() {
    if (!this._labels || !this._labels.length) return;
    const z = this.view.zoom;
    for (const l of this._labels) {
      l.el.setAttribute('font-size', r2(AB_LABEL_SIZE / z));
      const screenW = l.w * z;
      if (screenW < AB_LABEL_MIN_W) { l.el.setAttribute('display', 'none'); continue; }
      l.el.removeAttribute('display');
      const max = Math.floor(screenW / (AB_LABEL_SIZE * AB_LABEL_CHAR));
      const text = l.text.length > max
        ? l.text.slice(0, Math.max(1, max - 1)).replace(/\s+$/, '') + '…'
        : l.text;
      if (l.node.nodeValue !== text) l.node.nodeValue = text;
    }
  }

  /** Установить зум к точке экрана (курсору). */
  zoomAt(clientX, clientY, factor) {
    const before = this.toWorld(clientX, clientY);
    const next = clamp(this.view.zoom * factor, 0.1, 6);
    if (Math.abs(next - this.view.zoom) < 1e-6) return;
    this.view.zoom = next;
    const b = this.el.getBoundingClientRect();
    this.view.pan.x = (clientX - b.left) - before.x * next;
    this.view.pan.y = (clientY - b.top) - before.y * next;
    this._applyView();
    this._paintUI();
    if (this.opts.onView) this.opts.onView({ zoom: this.view.zoom, pan: { ...this.view.pan } });
  }

  /** Зум относительно центра вьюпорта. */
  zoomBy(factor) {
    const b = this.el.getBoundingClientRect();
    this.zoomAt(b.left + this.vw / 2, b.top + this.vh / 2, factor);
  }

  /** Установить абсолютный зум, сохранив точку в центре вьюпорта. */
  setZoom(zoom) {
    const z = clamp(Number(zoom) || 1, 0.1, 6);
    this.zoomBy(z / this.view.zoom);
  }

  /**
   * Вписать узлы во вьюпорт (по умолчанию — все артборды).
   * @param {string[]} [ids]
   * @param {{padding?:number, inset?:{top?:number,right?:number,bottom?:number,left?:number}, maxZoom?:number}} [opts]
   *   padding — отступ от края свободной области (48);
   *   inset — поля, которые занимает оболочка (док снизу, панели по краям): они
   *   вычитаются из вьюпорта, и макет центрируется по остатку;
   *   maxZoom — потолок приближения (2), чтобы один мелкий узел не раздувался.
   */
  fitTo(ids, opts) {
    const list = (ids && ids.length ? ids : (this.doc ? artboards(this.doc).map((a) => a.id) : []))
      .map((id) => this.geo.rects[id]).filter(Boolean);
    if (!list.length) return;
    // границы одним проходом: списком может прийти весь документ (см. maxOf)
    const x0 = minOf(list, (r) => r.x, Infinity);
    const y0 = minOf(list, (r) => r.y, Infinity);
    const x1 = maxOf(list, (r) => r.x + r.w, -Infinity);
    const y1 = maxOf(list, (r) => r.y + r.h, -Infinity);
    const o = opts && typeof opts === 'object' ? opts : {};
    const pad = isNum(o.padding) ? Math.max(0, o.padding) : 48;
    const ins = o.inset && typeof o.inset === 'object' ? o.inset : {};
    const side = (v) => (isNum(v) ? Math.max(0, v) : 0);
    const top = side(ins.top);
    const right = side(ins.right);
    const bottom = side(ins.bottom);
    const left = side(ins.left);
    const maxZoom = isNum(o.maxZoom) ? clamp(o.maxZoom, 0.1, 6) : 2;
    // свободная область — вьюпорт без полей оболочки; отступ снимаем с обеих сторон
    const freeW = Math.max(1, this.vw - left - right);
    const freeH = Math.max(1, this.vh - top - bottom);
    const z = clamp(Math.min(
      Math.max(1, freeW - pad * 2) / Math.max(1, x1 - x0),
      Math.max(1, freeH - pad * 2) / Math.max(1, y1 - y0)
    ), 0.1, maxZoom);
    this.view.zoom = z;
    // центрируем по середине свободной области, а не всего холста
    this.view.pan.x = left + freeW / 2 - ((x0 + x1) / 2) * z;
    this.view.pan.y = top + freeH / 2 - ((y0 + y1) / 2) * z;
    this._applyView();
    this._paintUI();
    if (this.opts.onView) this.opts.onView({ zoom: this.view.zoom, pan: { ...this.view.pan } });
  }

  /**
   * Видимая область холста в экранных координатах окна — оболочке, чтобы обрезать
   * свои накладки (подсказки, ярлыки) по краю сцены: экранная точка узла равна
   * viewportRect().x/y плюс toScreen(x, y).
   * @returns {{x:number, y:number, w:number, h:number}}
   */
  viewportRect() {
    const b = this.el && this.el.getBoundingClientRect ? this.el.getBoundingClientRect() : null;
    const w = b && isNum(b.width) && b.width > 0 ? b.width : this.vw;
    const h = b && isNum(b.height) && b.height > 0 ? b.height : this.vh;
    return { x: r2(b ? b.left : 0), y: r2(b ? b.top : 0), w: r2(w), h: r2(h) };
  }

  /* ------------------------------ отрисовка ------------------------------ */

  /**
   * Полная перерисовка. Дёшево: один <svg>, группы по артбордам, текст — <text>/<tspan>.
   * @param {object} doc
   * @param {object} geo результат solve
   * @param {{selection?:string[],hover?:string,preview?:object,diff?:{created:string[],changed:string[],removed:string[]},zoom?:number,pan?:{x:number,y:number}}} [state]
   */
  render(doc, geo, state = {}) {
    try {
      const next = geo && geo.rects ? geo : { rects: {}, lines: {}, order: [] };
      // документ мог переехать посреди жеста и правки текста — сверяемся до отрисовки,
      // пока на руках ещё старая геометрия и живой призрак
      this._syncGesture(doc, next.rects);
      this.doc = doc;
      this.geo = next;
      this.state = { selection: [], ...state };
      if (isNum(state.zoom)) this.view.zoom = clamp(state.zoom, 0.1, 6);
      if (state.pan && isNum(state.pan.x)) this.view.pan = { x: state.pan.x, y: state.pan.y };
      const abs = artboards(doc);
      if (!this.activeArtboard || !doc.nodes[this.activeArtboard]) {
        this.activeArtboard = abs.length ? abs[0].id : null;
      }
      this._renderSVG();
      this._applyView();
      this._paintUI();
      this._flip(state.diff);
      this._syncStates();   // круг 36: просмотр и «Проиграть» переживают перерисовку
      // Круг 16, п.6: прежнюю геометрию держим ССЫЛКОЙ. solve на каждый вызов
      // отдаёт новые прямоугольники и никто их не правит на месте, так что копия
      // была лишней: на 40 477 узлах это 40 тысяч объектов на каждый кадр.
      this._prevRects = this.geo.rects || {};
      this._warmFonts();   // чтобы экспорт SVG (он синхронный) не остался без гарнитур
    } catch (e) {
      this._fail('render', e);
    }
  }

  /**
   * Узел для ОТРИСОВКИ по id. Круг 19, п.4: у экземпляра рисуется раскрытое
   * поддерево мастера, и его узлов в doc.nodes нет — они приходят в geo.expanded
   * (решатель раскрывает их один раз, см. expandDoc). Под id самого экземпляра
   * там лежит корень мастера с применёнными пропсами, поэтому карта раскрытия
   * идёт ПЕРВОЙ: сцена рисует компонент, а выделение и бейджи по-прежнему читают
   * настоящий узел из doc.nodes.
   * @param {string} id
   * @returns {object|undefined}
   */
  /**
   * Круг 48 (SPEC §15): документ для токенов узла — тема его доски поверх
   * документа. Разрешатель живёт, пока те же документ и геометрия (раскрытые
   * экземпляры берут доску по месту экземпляра).
   * @param {string} id
   * @returns {object}
   */
  _td(id) {
    const sc = this._themeScope;
    if (!sc || sc.doc !== this.doc || sc.geo !== this.geo) {
      this._themeScope = { doc: this.doc, geo: this.geo, at: themeScope(this.doc, (x) => this._rn(x)) };
    }
    return this._themeScope.at(id);
  }

  _rn(id) {
    // круг 29: только своё свойство и только по строке — id из чужого children
    // бывает объектом, и `nodes[{toString:1}]` бросает посреди отрисовки
    const ex = this.geo && this.geo.expanded;
    const syn = ex ? ownNode(ex, id) : undefined;
    if (syn) return syn;
    return this.doc && this.doc.nodes ? ownNode(this.doc.nodes, id) : undefined;
  }

  /**
   * Все узлы поддерева с учётом раскрытых экземпляров — для сборки экспорта
   * (какие гарнитуры и какие картинки нужны).
   * @param {string} id
   * @returns {object[]}
   */
  _subtreeNodes(id) {
    const out = [];
    const seen = new Set();
    const walk = (nid, d) => {
      if (d > MAX_DEPTH || seen.has(nid)) return;
      const n = this._rn(nid);
      if (!n) return;
      seen.add(nid);
      out.push(n);
      for (const c of kidsOf(n)) walk(c, d + 1);
    };
    walk(id, 0);
    return out;
  }

  /**
   * Дешёвая смена выделения: SVG не пересобираем, красим только слой интерфейса.
   * @param {string[]} ids
   * @returns {void}
   */
  setSelection(ids) {
    this.state = { ...this.state, selection: Array.isArray(ids) ? ids.slice() : [] };
    this._paintUI();
  }

  /**
   * Жест и правка текста против свежего документа. Жест считался от прямоугольника,
   * который человек видел в момент нажатия; если документ переехал под рукой
   * (транзакция агента, отмена, импорт), доводить жест нельзя — он закоммитит
   * координату от устаревшего rect0, и узел прыгнет. Отменяем жест целиком:
   * это заметно сразу и ничего не портит, тогда как тихий пересчёт rect0 довёл бы
   * до конца движение, которого человек уже не видел (цель, порядок в потоке и
   * соседи стали другими). Панорама и рамка выделения от геометрии узлов не
   * зависят — их не трогаем.
   * @param {object} doc новый документ
   * @param {Record<string,{x:number,y:number,w:number,h:number}>} rects новая геометрия
   */
  _syncGesture(doc, rects) {
    const ed = this._editing;
    if (ed && (!doc || !doc.nodes || !doc.nodes[ed.id])) {
      // правка текста переживала удаление своего узла: редактор висел поверх пустоты,
      // а _commitEdit потом упирался в «узел не найден»
      logOnce('stage:edit-gone', `Stage: узел «${ed.id}» исчез из документа — правка текста закрыта`);
      this._closeEditor();
    }
    const d = this._drag;
    if (!d || !d.id || !d.rect0 || d.mode === 'pan' || d.mode === 'marquee') return;
    const r = rects ? rects[d.id] : undefined;
    const same = r && Math.abs(r.x - d.rect0.x) < 0.01 && Math.abs(r.y - d.rect0.y) < 0.01
      && Math.abs(r.w - d.rect0.w) < 0.01 && Math.abs(r.h - d.rect0.h) < 0.01;
    if (same) return;
    this._cancelDrag(r ? 'геометрия узла изменилась' : 'узел исчез из документа');
  }

  /** Снять жест: призрак, направляющие и результат — чтобы pointerup ничего не коммитил. */
  _cancelDrag(reason) {
    const d = this._drag;
    if (!d) return;
    this._cancelPreview();
    this._preview = null;   // сцену всё равно перерисует render(), который нас позвал
    this._clearGhost();
    this._clearShift();
    this._drag = null;
    this._guides = [];
    this._insertion = null;
    this._marquee = null;
    if (this.el && this.el.classList) this.el.classList.remove('is-panning');
    logOnce('stage:drag-cancel', `Stage: жест «${d.mode}» отменён — ${reason}`);
    if (this.opts.onDragCancel) {
      try { this.opts.onDragCancel({ mode: d.mode, id: d.id, reason }); } catch (e) { this._fail('onDragCancel', e); }
    }
  }

  _fail(where, e) {
    const key = 'stage:' + where + ':' + (e && e.message ? e.message : e);
    logOnce(key, `Stage.${where}: ${e && e.message ? e.message : e}`, e);
    // наружу тоже один раз: повторяющаяся ошибка отрисовки иначе даёт пачку
    // одинаковых тостов на каждый кадр
    if (!this._failSeen) this._failSeen = new Set();
    if (this._failSeen.has(key)) return;
    if (this._failSeen.size >= 200) this._failSeen.clear();
    this._failSeen.add(key);
    if (this.opts.onError) {
      try { this.opts.onError({ where, error: e }); } catch (_) { /* уже залогировано */ }
    }
  }

  /**
   * Сцена в SVG.
   *
   * Круг 16, п.6: полная пересборка на каждый кадр стоила на 12 198 узлах 657 мс
   * (196 мс — сборка DOM, остальное — раскладка браузером 45 тысяч элементов), и
   * любая мелочь — сдвиг стрелкой, кадр перетаскивания — платила полную цену.
   * Поэтому сначала пробуем обновить точечно: заменить фигуры у тех узлов, чья
   * геометрия или содержимое изменились, и не трогать остальные (замер там же:
   * лист меняется за 1 мс). Точечный путь отказывает при любом сомнении —
   * сменились токены, список артбордов, состав детей, — и тогда собираем заново.
   */
  _renderSVG() {
    this._stList = null;   // круг 36: состав узлов со states мог смениться
    if (this._patchSVG()) return;
    const doc = this.doc;
    const frag = document.createDocumentFragment();
    this._nodeEls = new Map();
    this._drawn = new Map();
    this._abEls = new Map();
    this._labels = [];
    this._clipSeq = 0;
    const defs = svgEl('defs');
    frag.appendChild(defs);
    this._defs = defs;
    this._gridGroup = svgEl('g', { class: 'imago-grid' });
    frag.appendChild(this._gridGroup);
    this._drawSeen = new Set();
    const abIds = [];
    for (const ab of artboards(doc)) {
      const rect = this.geo.rects[ab.id];
      if (!rect) continue;
      abIds.push(ab.id);
      const g = svgEl('g', { class: 'imago-ab', 'data-id': ab.id });
      // подложка: артборд без разрешимой заливки иначе выглядит как чёрный экран
      const plate = resolveColor(this._td(ab.id), ab.fill);
      const plateEl = svgEl('rect', {
        class: 'imago-ab-plate', x: r2(rect.x), y: r2(rect.y),
        width: r2(rect.w), height: r2(rect.h), rx: resolveRadius(doc, ab.radius),
        fill: plate || '#ffffff',
        stroke: plate ? undefined : 'var(--line,#E2DED6)',
        'stroke-width': plate ? undefined : 1
      });
      g.appendChild(plateEl);
      // цвет подписи — из темы, через CSS: см. .imago-ab-label в STAGE_CSS
      const label = svgEl('text', {
        class: 'imago-ab-label', x: r2(rect.x), y: r2(rect.y - 6),
        'font-size': AB_LABEL_SIZE, 'font-weight': 500
      });
      // имя-заглушка одно на сцену и на оболочку — см. displayName()
      const shown = displayName(doc, ab);
      const labelText = document.createTextNode(shown);
      label.appendChild(labelText);
      // ширину артборда помним здесь: _updateLabels решает по ней, прятать ли подпись
      const rec = { el: label, node: labelText, text: shown, w: rect.w };
      this._labels.push(rec);
      g.appendChild(label);
      this._abEls.set(ab.id, { el: g, plate: plateEl, node: ab, rect, label: rec });
      this._drawNode(g, ab, 0, 0);
      frag.appendChild(g);
    }
    // узлы, лежащие прямо на холсте вне артбордов
    const root = doc.nodes[doc.root];
    const loose = [];
    for (const id of kidsOf(root)) {
      // круг 19: экземпляр прямо на холсте рисуется раскрытым поддеревом, а
      // страница-библиотека — своими мастерами (плашки и подписи доски у неё нет:
      // она не доска, см. isLibrary)
      const n = this._rn(id);
      if (n && n.type !== 'frame' && this.geo.rects[id]) {
        loose.push(id);
        this._drawNode(frag, n, 0, 0);
      }
    }
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.svg.appendChild(frag);
    // слепок сцены: по нему следующий кадр решит, можно ли обойтись точечным обновлением
    this._drawnState = { tokens: doc.tokens, abs: abIds, loose, themes: abIds.map((id) => boardTheme(doc.nodes[id])) };
    this._renderGrid();
  }

  /**
   * Точечное обновление сцены вместо пересборки. Возвращает false, если сцену
   * надо собрать заново (тогда вызывающий делает это сам). Сначала считаем план
   * (ничего не трогая), потом применяем: так отказ на полпути не оставляет
   * половину старой картинки.
   * @returns {boolean} true — сцена обновлена
   */
  _patchSVG() {
    const st = this._drawnState;
    const doc = this.doc;
    // srcMap — сборка снимка, она идёт мимо сцены и своего кеша не имеет
    if (!st || !this.svg || this._srcMap || !doc || !doc.nodes || !this._drawn) return false;
    if (doc.tokens !== st.tokens) return false;   // палитра и типографика красят всё
    const abs = artboards(doc).filter((a) => this.geo.rects[a.id]);
    if (!sameIdList(abs.map((a) => a.id), st.abs)) return false;
    // круг 48: тема доски красит всю доску — сменилась тема, собираем заново
    if (abs.some((a, i) => boardTheme(a) !== st.themes[i])) return false;
    const root = doc.nodes[doc.root];
    const loose = kidsOf(root).filter((id) => {
      const n = this._rn(id);
      return n && n.type !== 'frame' && this.geo.rects[id];
    });
    if (!sameIdList(loose, st.loose)) return false;

    const plan = { shapes: [], rebuild: [], remove: [] };
    for (const ab of abs) if (!this._planNode(ab.id, plan, 0)) return false;
    for (const id of loose) if (!this._planNode(id, plan, 0)) return false;

    try {
      let labels = false;
      for (const ab of abs) labels = this._patchArtboard(ab) || labels;
      /* Сначала ЗАБЫВАЕМ все ветки, которые пойдут под нож, и только потом рисуем
       * новые. Иначе перенос узла (move) съедал сам себя: у прежнего и у нового
       * родителя изменился состав детей, обоих пересобираем, и если новый шёл
       * первым — забывание старой ветки стирало уже СВЕЖУЮ запись переехавшего
       * узла и уносило из defs его обрезку (узел оставался на экране без неё). */
      const doomed = [];
      for (const id of plan.remove.concat(plan.rebuild)) {
        const c = this._drawn.get(id);
        if (!c) continue;
        const el = c.outer || c.el;   // круг 37: у повёрнутого узла снаружи обёртка поворота
        doomed.push({ id, el, parentEl: el.parentNode, drop: plan.rebuild.indexOf(id) < 0 });
        this._forgetSubtree(id);
      }
      for (const d of doomed) {
        if (!d.parentEl) continue;
        const fresh = d.drop ? null : this._redrawNode(d.id);
        if (fresh) d.parentEl.replaceChild(fresh, d.el);
        else d.parentEl.removeChild(d.el);
      }
      for (const id of plan.shapes) this._repaintShapes(id);
      if (labels) this._updateLabels();
      this._renderGrid();
      return true;
    } catch (e) {
      // на полпути — не беда: вызывающий тут же соберёт сцену заново
      this._fail('patchSVG', e);
      this._drawnState = null;
      return false;
    }
  }

  /**
   * План обновления поддерева: что перерисовать целиком, у чего заменить фигуры,
   * что убрать. Ничего не меняет.
   * @returns {boolean} false — точечным обновлением не обойтись
   */
  _planNode(id, plan, depth) {
    if (depth > MAX_DEPTH) return false;
    const c = this._drawn.get(id);
    // круг 19: планируем по РАСКРЫТОМУ узлу — иначе синтетический ребёнок
    // экземпляра читался бы как «узла нет» и ветку сносили бы на каждом кадре
    const node = this._rn(id);
    const rect = this.geo.rects[id];
    const drawNow = !!(node && rect && node.visible !== false);
    if (!c) return !drawNow;            // узел не рисовался: если пора рисовать — только полной сборкой
    if (!drawNow) { plan.remove.push(id); return true; }
    const kids = kidsOf(node);
    if (node !== c.node) {
      // состав детей или обрезка изменились — пересобираем ветку целиком
      const wantClip = !!(kids.length && node.clip);
      if (wantClip !== !!c.clip || !sameIdList(kids, c.kids)) { plan.rebuild.push(id); return true; }
      // круг 37: появилась или ушла обёртка поворота — ветку собираем заново
      if (!this._rotDeg(node) !== !c.rotDeg) { plan.rebuild.push(id); return true; }
    }
    const lines = this.geo.lines && this.geo.lines[id];
    if (node !== c.node || !sameRect(rect, c.rect) || !sameLines(lines, c.lines)) plan.shapes.push(id);
    for (const kid of kids) if (!this._planNode(kid, plan, depth + 1)) return false;
    return true;
  }

  /** Подложка и подпись артборда под свежую геометрию. @returns {boolean} подпись изменилась */
  _patchArtboard(ab) {
    const e = this._abEls.get(ab.id);
    const rect = this.geo.rects[ab.id];
    if (!e || !rect) return false;
    if (e.node === ab && sameRect(rect, e.rect)) return false;
    const plate = resolveColor(this._td(ab.id), ab.fill);
    const attr = (el, k, v) => {
      if (v === undefined || v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    };
    attr(e.plate, 'x', r2(rect.x));
    attr(e.plate, 'y', r2(rect.y));
    attr(e.plate, 'width', r2(rect.w));
    attr(e.plate, 'height', r2(rect.h));
    attr(e.plate, 'rx', resolveRadius(this.doc, ab.radius));
    attr(e.plate, 'fill', plate || '#ffffff');
    attr(e.plate, 'stroke', plate ? undefined : 'var(--line,#E2DED6)');
    attr(e.plate, 'stroke-width', plate ? undefined : 1);
    attr(e.label.el, 'x', r2(rect.x));
    attr(e.label.el, 'y', r2(rect.y - 6));
    e.label.text = displayName(this.doc, ab);
    e.label.w = rect.w;
    e.node = ab;
    e.rect = rect;
    return true;
  }

  /** Заменить собственные фигуры узла (дети остаются на месте). */
  _repaintShapes(id) {
    const c = this._drawn.get(id);
    const node = this._rn(id);
    const rect = this.geo.rects[id];
    if (!c || !node || !rect) return;
    const shapes = this._nodeShapes(node, rect, 0, 0);
    const anchor = c.shapes.length ? c.shapes[0] : c.el.firstChild;
    for (const el of shapes) c.el.insertBefore(el, anchor || null);
    for (const old of c.shapes) c.el.removeChild(old);
    c.shapes = shapes;
    const opacity = isNum(node.opacity) ? node.opacity : 1;
    if (opacity !== 1) c.el.setAttribute('opacity', opacity);
    else c.el.removeAttribute('opacity');
    this._baseShadow(c.el, node, shapes);
    c.stKey = null;   // фигуры новые — состояние (если есть) накладываем заново
    // круг 37: угол или центр поворота мог смениться (обёртка уже есть — см. _planNode)
    const rotDeg = this._rotDeg(node);
    if (rotDeg && c.outer && c.outer !== c.el) c.outer.setAttribute('transform', rotateAttr(rotDeg, rect, 0, 0));
    c.rotDeg = rotDeg;
    if (c.clip) {
      const radius = resolveRadius(this.doc, node.radius);
      c.clip.rect.setAttribute('x', r2(rect.x));
      c.clip.rect.setAttribute('y', r2(rect.y));
      c.clip.rect.setAttribute('width', r2(rect.w));
      c.clip.rect.setAttribute('height', r2(rect.h));
      c.clip.rect.setAttribute('rx', radius);
    }
    c.node = node;
    c.rect = rect;
    c.lines = this.geo.lines && this.geo.lines[id];
  }

  /**
   * Нарисовать ветку заново (слепок прежней уже забыт — см. фазы в _patchSVG).
   * Возвращает свежий элемент: на место старого его ставит вызывающий.
   * @returns {Element|null}
   */
  _redrawNode(id) {
    const node = this._rn(id);
    if (!node) return null;
    const seen = this._drawSeen;
    this._drawSeen = new Set();
    try {
      return this._drawNode(svgEl('g'), node, 0, 0) || null;
    } finally {
      this._drawSeen = seen;
    }
  }

  /** Забыть слепок ветки и убрать её обрезки из defs. */
  _forgetSubtree(id) {
    const c = this._drawn.get(id);
    if (!c) return;
    this._drawn.delete(id);
    this._nodeEls.delete(id);
    if (c.clip && c.clip.el && c.clip.el.parentNode) c.clip.el.parentNode.removeChild(c.clip.el);
    for (const kid of c.kids) this._forgetSubtree(kid);
  }

  _renderGrid() {
    const g = this._gridGroup;
    if (!g) return;
    while (g.firstChild) g.removeChild(g.firstChild);
    const z = this.view.zoom;
    if (z <= 1.5 || !this.doc) return;
    const spacing = (this.doc.tokens && this.doc.tokens.spacing) || DEFAULT_TOKENS.spacing;
    const step = spacing.filter((s) => s >= 4)[0] || 8;
    for (const ab of artboards(this.doc)) {
      const r = this.geo.rects[ab.id];
      if (!r) continue;
      const cols = Math.floor(r.w / step);
      const rows = Math.floor(r.h / step);
      if (cols + rows > 800) continue;
      const path = [];
      for (let i = 1; i <= cols; i++) path.push(`M${r2(r.x + i * step)} ${r2(r.y)}V${r2(r.y + r.h)}`);
      for (let i = 1; i <= rows; i++) path.push(`M${r2(r.x)} ${r2(r.y + i * step)}H${r2(r.x + r.w)}`);
      g.appendChild(svgEl('path', {
        d: path.join(''), stroke: '#0D0E12', 'stroke-opacity': clamp((z - 1.5) / 2, 0.02, 0.07),
        'stroke-width': r2(1 / z), fill: 'none'
      }));
    }
  }

  /**
   * Собственные фигуры узла (без детей): прямоугольник/эллипс/текст/картинка.
   * Вынесены из _drawNode отдельно, потому что точечное обновление сцены
   * (см. _patchSVG, круг 16, п.6) перерисовывает у неизменившегося узла ровно
   * их — и рисовать их обязан ТОТ ЖЕ код, что и полная сборка, иначе два пути
   * разойдутся незаметно.
   * @returns {Element[]} в порядке отрисовки
   */
  _nodeShapes(node, rect, dx, dy) {
    const doc = this._td(node.id);   // круг 48: цвета и шрифты — по теме доски
    const out = [];
    const defs = [];   // круг 37: градиенты этого узла — в его же <defs>
    const paint = (v) => this._paintRef(v, defs, doc);
    const x = r2(rect.x + dx);
    const y = r2(rect.y + dy);
    const fill = paint(node.fill);
    const stroke = node.stroke ? paint(isObj(node.stroke) && node.stroke.color !== undefined ? node.stroke.color : node.stroke) : null;
    const strokeW = node.stroke && isNum(node.stroke.width) ? node.stroke.width : 1;
    const radius = resolveRadius(doc, node.radius);

    /* Круг 36: у узла с состояниями фигура есть всегда, а пустая заливка —
       прозрачная, а не 'none': переход к заливке наведения плавный, и в
       экспортированном SVG наведение ловится по всей площади, а не по детям. */
    const live = hasStates(node);
    const noFill = live ? 'transparent' : 'none';
    if (node.type === 'vector') {
      out.push(this._vectorShape(node, rect, x, y, paint, fill, stroke));
    } else if (node.type === 'ellipse') {
      out.push(svgEl('ellipse', {
        cx: r2(x + rect.w / 2), cy: r2(y + rect.h / 2), rx: r2(rect.w / 2), ry: r2(rect.h / 2),
        fill: fill || noFill, stroke: stroke || undefined, 'stroke-width': stroke ? strokeW : undefined
      }));
    } else if (node.type === 'text') {
      const style = resolveTextStyle(doc, node);
      const lines = (this.geo.lines && this.geo.lines[node.id]) || [textOf(node.characters)];
      const anchor = node.align === 'center' ? 'middle' : node.align === 'right' ? 'end' : 'start';
      const tx = anchor === 'middle' ? r2(x + rect.w / 2) : anchor === 'end' ? r2(x + rect.w) : x;
      const t = svgEl('text', {
        x: tx, y: r2(y + (style.lineHeight - style.fontSize) / 2 + style.fontSize * 0.8),
        fill: paint(node.color) || '#14161C',
        'font-family': style.fontFamily, 'font-size': style.fontSize, 'font-weight': style.fontWeight,
        'text-anchor': anchor,
        'letter-spacing': style.letterSpacing ? style.letterSpacing : undefined,
        'xml:space': 'preserve'
      });
      lines.forEach((line, i) => {
        const ts = svgEl('tspan', { x: tx, dy: i === 0 ? 0 : r2(style.lineHeight) });
        ts.appendChild(dom().createTextNode(line));
        t.appendChild(ts);
      });
      out.push(t);
    } else if (node.type === 'image') {
      let src = safeImageSrc(node.src);
      // на время снимка внешние адреса подменены на data: — см. screenshot()
      if (src && this._srcMap && this._srcMap.has(src)) src = this._srcMap.get(src);
      // круг 47: снимок без сети (сервер) — внешняя картинка плашкой, а не прозрачной дырой
      if (src && this._noExternal && isExternalSrc(src)) { src = null; this._placeholders = (this._placeholders || 0) + 1; }
      if (fill || !src) {
        out.push(svgEl('rect', { x, y, width: r2(rect.w), height: r2(rect.h), rx: radius, fill: fill || '#E2DED6' }));
      }
      if (src) {
        const im = svgEl('image', {
          x, y, width: r2(rect.w), height: r2(rect.h), preserveAspectRatio: 'xMidYMid slice'
        });
        im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
        im.setAttribute('href', src);
        out.push(im);
      }
    } else if (fill || stroke || live) {
      // frame / rect / page
      out.push(svgEl('rect', {
        x, y, width: r2(rect.w), height: r2(rect.h), rx: radius,
        fill: fill || noFill, stroke: stroke || undefined, 'stroke-width': stroke ? strokeW : undefined
      }));
    }
    // главная фигура узла: на неё ложатся заливка/цвет/обводка состояний и тень
    if (out.length) out[0].setAttribute('class', 'imago-shape');
    if (defs.length) {
      const el = svgEl('defs');
      for (const d of defs) el.appendChild(d);
      out.push(el);
    }
    return out;
  }

  /**
   * Краска → значение атрибута fill/stroke (круг 37). Градиент заводит элемент
   * <linearGradient>/<radialGradient> в `defs` (список вызывающего — он кладёт их
   * в группу узла, и точечное обновление меняет их вместе с фигурами). id
   * уникален на сборку: префикс сцены/экспорта + общий счётчик с обрезками.
   * @returns {string|null}
   */
  _paintRef(v, defs, tdoc) {
    if (v === undefined || v === null) return null;
    const p = resolvePaint(tdoc || this.doc, v);
    if (!p) return null;
    if (p.type === 'color') return p.color;
    const id = String(this._clipPrefix || 'imago-clip-').replace(/^imago-clip-/, 'imago-paint-') + (this._clipSeq++);
    // круг 49 (SPEC §16): фактура — <pattern> плиткой в координатах холста
    if (p.type === 'pattern') {
      const pat = svgEl('pattern', {
        id, patternUnits: 'userSpaceOnUse', width: r2(p.size), height: r2(p.size),
        patternTransform: p.angle ? `rotate(${r2(p.angle)})` : undefined
      });
      if (p.bg) pat.appendChild(svgEl('rect', { x: 0, y: 0, width: r2(p.size), height: r2(p.size), fill: p.bg }));
      for (const sh of patternTile(p)) pat.appendChild(svgEl(sh.tag, sh.attrs));
      defs.push(pat);
      return `url(#${id})`;
    }
    let el;
    if (p.kind === 'radial') {
      el = svgEl('radialGradient', { id, cx: r2(p.cx), cy: r2(p.cy), r: r2(p.r) });
    } else {
      // угол — как в CSS linear-gradient: 0 — снизу вверх, 90 — слева направо, 180 — сверху вниз
      const a = (p.angle * Math.PI) / 180;
      const sx = Math.sin(a) / 2;
      const sy = Math.cos(a) / 2;
      el = svgEl('linearGradient', {
        id, x1: fmtNum(0.5 - sx, 4), y1: fmtNum(0.5 + sy, 4), x2: fmtNum(0.5 + sx, 4), y2: fmtNum(0.5 - sy, 4)
      });
    }
    for (const st of p.stops) {
      el.appendChild(svgEl('stop', {
        offset: r2(st.at), 'stop-color': st.color, 'stop-opacity': st.opacity < 1 ? r2(st.opacity) : undefined
      }));
    }
    defs.push(el);
    return `url(#${id})`;
  }

  /**
   * Фигура вектора (круг 37, SPEC §12): группа с преобразованием viewBox → рамка
   * узла (xMidYMid meet — пропорции сохраняются, по центру) и по <path> на
   * контур. Заливка и обводка узла стоят на группе и наследуются контурами без
   * своих — поэтому заливка состояния перекрашивает и их. Обрезки по viewBox нет.
   * @returns {Element}
   */
  _vectorShape(node, rect, x, y, paint, fill, stroke) {
    const vb = vbOf(node);
    const s = vb.w > 0 && vb.h > 0 ? Math.min(rect.w / vb.w, rect.h / vb.h) : 0;
    const tx = x + (rect.w - vb.w * s) / 2 - vb.x * s;
    const ty = y + (rect.h - vb.h * s) / 2 - vb.y * s;
    const nodeSW = isObj(node.stroke) && isNum(node.stroke.width) ? clamp(node.stroke.width, 0, 1000) : null;
    const g = svgEl('g', {
      transform: `matrix(${fmtNum(s, 6)} 0 0 ${fmtNum(s, 6)} ${fmtNum(tx, 3)} ${fmtNum(ty, 3)})`,
      fill: fill || 'none', stroke: stroke || undefined, 'stroke-width': stroke && nodeSW !== null ? nodeSW : undefined
    });
    if (!s) return g;
    for (const p of Array.isArray(node.paths) ? node.paths : []) {
      if (!isObj(p) || typeof p.d !== 'string' || pathCheck(p.d, p).err) continue;
      const pf = p.fill !== undefined ? (paint(p.fill) || 'none') : undefined;
      const ps = p.stroke !== undefined ? (paint(p.stroke) || 'none') : undefined;
      const hasStroke = ps !== undefined ? ps !== 'none' : !!stroke;
      const sw = isNum(p.strokeWidth) ? clamp(p.strokeWidth, 0, VECTOR_LIMITS.maxStrokeWidth) : undefined;
      g.appendChild(svgEl('path', {
        d: p.d, fill: pf, stroke: ps,
        'stroke-width': hasStroke ? sw : undefined,
        'fill-rule': FILL_RULES.has(p.fillRule) ? p.fillRule : undefined,
        'stroke-linecap': hasStroke && LINE_CAPS.has(p.lineCap) ? p.lineCap : undefined,
        'stroke-linejoin': hasStroke && LINE_JOINS.has(p.lineJoin) ? p.lineJoin : undefined,
        opacity: isNum(p.opacity) && p.opacity < 1 ? r2(clamp(p.opacity, 0, 1)) : undefined
      }));
    }
    return g;
  }

  /**
   * Базовая тень узла (круг 36, SPEC §11.1): CSS-фильтр drop-shadow на главной
   * фигуре (у узла без фигур — на группе). Рисуется всегда, в правке и экспорте.
   * @param {Element} g группа узла @param {object} node @param {Element[]} shapes
   */
  _baseShadow(g, node, shapes) {
    const f = resolveShadow(this.doc, node.shadow).filter;
    if (g.style) g.style.filter = '';
    const target = shapes[0] || g;
    if (target.style) target.style.filter = f === 'none' ? '' : f;
  }

  /** Поворот узла в градусах (круг 37); у доски на холсте не рисуется. */
  _rotDeg(node) {
    if (!node || !isNum(node.rotate) || node.type === 'page') return 0;
    const a = clamp(node.rotate, -ROTATE_LIMIT, ROTATE_LIMIT);
    if (a === 0 || a === 360 || a === -360) return 0;
    if (this.doc && isArtboard(this.doc, node)) return 0;
    return a;
  }

  /**
   * Сдвиг в мире → сдвиг в координатах группы узла (круг 37): внутри повёрнутых
   * обёрток (своей и предков) translate идёт по повёрнутым осям — поворачиваем
   * вектор назад на сумму углов. Без поворотов — тот же сдвиг.
   * @returns {{x:number,y:number}}
   */
  _localDelta(id, dx, dy) {
    let sum = 0;
    let cur = this._rn(id);
    for (let i = 0; cur && i <= MAX_DEPTH; i++) {
      sum += this._rotDeg(cur);
      cur = typeof cur.parent === 'string' ? this._rn(cur.parent) : null;
    }
    if (!sum) return { x: r2(dx), y: r2(dy) };
    const a = (-sum * Math.PI) / 180;
    return { x: r2(dx * Math.cos(a) - dy * Math.sin(a)), y: r2(dx * Math.sin(a) + dy * Math.cos(a)) };
  }

  /** Рисует узел и его детей. dx/dy — сдвиг системы координат (для toSVG). */
  _drawNode(parentEl, node, dx, dy, collect, depth) {
    const rect = this.geo.rects[node.id];
    if (!rect || node.visible === false) return;
    const d = depth || 0;
    if (!this._drawSeen) this._drawSeen = new Set();
    if (this._drawSeen.has(node.id)) {
      logOnce('draw:twice:' + node.id, `Stage: узел «${node.id}» встречен дважды — рисуем один раз`);
      return;
    }
    if (d > MAX_DEPTH) {
      logOnce('draw:deep', `Stage: глубже ${MAX_DEPTH} узлов — ветка «${node.id}» не рисуется`);
      return;
    }
    this._drawSeen.add(node.id);
    const doc = this.doc;
    const g = svgEl('g', { class: 'imago-node', 'data-id': node.id });
    const opacity = isNum(node.opacity) ? node.opacity : 1;
    if (opacity !== 1) g.setAttribute('opacity', opacity);
    const shapes = this._nodeShapes(node, rect, dx, dy);
    for (const el of shapes) g.appendChild(el);
    this._baseShadow(g, node, shapes);
    // круг 36: экспорт SVG — узлы с состояниями получают свой класс, по нему
    // toSVG пишет правила :hover / :active / :focus-visible (см. _exportStateCss)
    if (collect && this._exportStates && hasStates(node)) {
      // класс уникален на сборку (тот же случайный префикс, что у обрезок): превью
      // вариантов встают инлайном в одну страницу, и правила одной разметки не
      // должны цеплять узлы другой
      const cls = String(this._clipPrefix || 'imago-clip-').replace(/^imago-clip-/, 'im-') + 's' + this._exportStates.length;
      g.setAttribute('class', 'imago-node imago-anim ' + cls);
      if (isObj(node.states.focus)) g.setAttribute('tabindex', '0');
      this._exportStates.push({
        node, cls, hasShape: shapes.length > 0,
        cx: r2(rect.x + dx + rect.w / 2), cy: r2(rect.y + dy + rect.h / 2)
      });
    }

    const kids = kidsOf(node);
    let holder = g;
    let clip = null;
    if (kids.length) {
      if (node.clip) {
        const x = r2(rect.x + dx);
        const y = r2(rect.y + dy);
        const radius = resolveRadius(doc, node.radius);
        const cid = (this._clipPrefix || 'imago-clip-') + (this._clipSeq++);
        const cp = svgEl('clipPath', { id: cid });
        const cr = svgEl('rect', { x, y, width: r2(rect.w), height: r2(rect.h), rx: radius });
        cp.appendChild(cr);
        (this._defs || parentEl).appendChild(cp);
        holder = svgEl('g', { 'clip-path': `url(#${cid})` });
        clip = { el: cp, rect: cr };
        g.appendChild(holder);
      }
      for (const cid of kids) {
        const child = this._rn(cid);
        if (child) this._drawNode(holder, child, dx, dy, collect, d + 1);
      }
    }
    /* Круг 37 (SPEC §12.1): поворот — обёртка вокруг группы узла. На самой группе
       transform занят: FLIP пишет атрибут, состояния — CSS-свойство (оно перебило
       бы атрибут поворота). Центр — середина рамки узла. */
    const rotDeg = this._rotDeg(node);
    let outer = g;
    if (rotDeg) {
      outer = svgEl('g', { class: 'imago-rot', transform: rotateAttr(rotDeg, rect, dx, dy) });
      outer.appendChild(g);
    }
    parentEl.appendChild(outer);
    if (!collect) {
      this._nodeEls.set(node.id, g);
      // слепок для точечного обновления: по нему следующий кадр решает,
      // что перерисовывать, а что оставить как есть (круг 16, п.6)
      this._drawn.set(node.id, {
        node, rect, lines: this.geo.lines && this.geo.lines[node.id],
        kids: kids.slice(), el: g, outer, rotDeg, shapes, holder, clip
      });
    }
    return outer;
  }

  /**
   * Какие гарнитуры и какие символы нужны артборду. По этому списку в экспорт
   * встраиваются начертания: тянуть весь набор поднаборов Google Fonts на
   * каждый экспорт незачем — берём только те, чьи диапазоны действительно
   * встречаются в тексте.
   * @param {string} id
   * @returns {Map<string,{weights:Set<number>,codes:Set<number>}>}
   */
  _fontNeeds(id) {
    const out = new Map();
    const doc = this.doc;
    if (!doc || !doc.nodes || !this._rn(id)) return out;
    // круг 19: обход с учётом раскрытых экземпляров — иначе в экспорт не попали бы
    // начертания текстов, которые живут только в мастере
    for (const n of this._subtreeNodes(id)) {
      if (!n || n.type !== 'text' || n.visible === false) continue;
      const chars = textOf(n.characters);
      if (!chars) continue;
      const style = resolveTextStyle(this._td(n.id), n);
      const family = String(style.font || '').trim().replace(/^['"]|['"]$/g, '');
      // системные и мусорные имена не тянем: у первых нет файла, вторые сломают адрес
      if (!family || GENERIC_FONTS.has(family.toLowerCase())) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9 .'&+-]{0,48}$/.test(family)) continue;
      let rec = out.get(family);
      if (!rec) { rec = { weights: new Set(), codes: new Set() }; out.set(family, rec); }
      rec.weights.add(isNum(style.fontWeight) ? style.fontWeight : 400);
      for (const ch of chars) {
        const c = ch.codePointAt(0);
        if (c > 32) rec.codes.add(c);   // пробелы есть в любом поднаборе
      }
    }
    // текст из одних пробелов ни одного поднабора не требует — и жаловаться не на что
    for (const [family, rec] of [...out]) if (!rec.codes.size) out.delete(family);
    return out;
  }

  /**
   * Дотянуть и закешировать начертания артборда. Отдельный публичный вызов
   * нужен оболочке: `toSVG` синхронный и ждать сеть не может, а `screenshot`
   * зовёт это сам. Возвращает то же, что потом попадёт в `lastSVG.fonts`.
   * @param {string} [artboardId]
   * @returns {Promise<{state:string, families:string[], missing:string[]}>}
   */
  async prepareFonts(artboardId) {
    const id = artboardId || this.activeArtboard;
    const needs = this._fontNeeds(id);
    if (!needs.size) return { state: 'none', families: [], missing: [] };
    if (this.opts && this.opts.embedFonts === false) {
      return { state: 'off', families: [...needs.keys()], missing: [] };
    }
    let res;
    try { res = await loadFontCss(needs); }
    catch (e) {
      logOnce('fonts:prepare', 'начертания для экспорта не подготовились', e);
      res = { css: '', done: [], missing: [...needs.keys()] };
    }
    return { state: fontState(res), families: [...needs.keys()], missing: res.missing };
  }

  /**
   * Тихо дотянуть начертания активного артборда после отрисовки.
   *
   * Зачем: `toSVG()` синхронный и ждать сеть не может, а оболочка зовёт его
   * прямо по нажатию «Экспорт SVG». Файлы те же, что страница уже скачала под
   * свой <link> — почти всегда отдаются из кеша браузера. Повторно за тем же
   * набором не ходим: не вышло — значит не вышло, состояние видно в `lastSVG`.
   * Выключается `opts.embedFonts === false`.
   * @returns {void}
   */
  _warmFonts() {
    if (!this.opts || this.opts.embedFonts === false || typeof fetch !== 'function') return;
    if (!this._timers) return;    // сцена без своего хозяйства таймеров — ждать нечему
    if (this._fontWarm) return;   // уже запланировано
    this._fontWarm = this._later(() => {
      this._fontWarm = null;
      if (this._dead) return;
      // круг 16, п.6: документ и артборд те же — и набор гарнитур с символами тот же.
      // Обход поддерева с перебором ВСЕХ символов стоил 39 мс на 40 477 узлах, и он
      // случался после каждой отрисовки, хотя отвечал одно и то же.
      if (this._fontDoc === this.doc && this._fontAb === this.activeArtboard) return;
      this._fontDoc = this.doc;
      this._fontAb = this.activeArtboard;
      const needs = this._fontNeeds(this.activeArtboard);
      if (!needs.size) return;
      let miss;
      try { miss = fontCssFromCache(needs).missing; } catch (e) { return; }
      if (!miss.length) return;   // всё уже встроено
      let key = '';
      for (const [family, rec] of needs) {
        let h = 0;
        for (const c of rec.codes) h = (h * 31 + c) | 0;
        key += family + ':' + [...rec.weights].sort().join(',') + ':' + rec.codes.size + ':' + h + '|';
      }
      if (this._fontTried === key) return;   // за этим набором уже ходили
      this._fontTried = key;
      loadFontCss(needs).catch(() => {});
    }, 300);
  }

  /**
   * Самодостаточный SVG-документ одного артборда (в его собственных координатах).
   *
   * Встраивает начертания использованных гарнитур (@font-face + data:woff2) из
   * кеша: без них PNG и SVG считаются системным шрифтом и расходятся с экраном.
   * Кеш наполняет `prepareFonts()` — `screenshot()` делает это сам, оболочке
   * перед экспортом SVG стоит дождаться его же. Что получилось — в `lastSVG`.
   *
   * Разметка чужого документа (`docOverride`) шрифт с собой не несёт: так
   * рисуются превью вариантов, а они живут прямо на странице, где гарнитуры и
   * так есть — зато каждое начертание весит десятки килобайт. Понадобится
   * иначе — `toSVG(id, doc, geo, { fonts: true })`.
   * @param {string} [artboardId]
   * @param {object} [docOverride]
   * @param {object} [geoOverride]
   * @param {{fonts?:boolean, srcMap?:Map<string,string>}} [opts] srcMap — подмена
   *   внешних адресов картинок на data: ровно на эту сборку (см. screenshot)
   * @returns {string}
   */
  toSVG(artboardId, docOverride, geoOverride, opts = {}) {
    const docPrev = this.doc;
    const geoPrev = this.geo;
    const defsPrev = this._defs;
    const seqPrev = this._clipSeq;
    const prefixPrev = this._clipPrefix;
    const seenPrev = this._drawSeen;
    // подстановка картинок живёт ровно один синхронный вызов: в поле сцены она
    // цеплялась за состояние и два снимка разом перетирали её друг другу
    const mapPrev = this._srcMap;
    this._srcMap = opts && opts.srcMap instanceof Map ? opts.srcMap : null;
    if (docOverride && geoOverride && geoOverride.rects) {
      this.doc = docOverride;
      this.geo = geoOverride;
    }
    try {
      const id = artboardId || this.activeArtboard;
      // круг 19: экспорт доски включает экземпляры; экспорт самого экземпляра
      // (превью компонента) отдаёт раскрытое поддерево, а не пустую разметку
      const node = this._rn(id);
      const rect = node && this.geo.rects[id];
      this.lastSVG = null;   // нечего сказать, пока разметка не собралась
      if (!node || !rect) return '';
      const svg = svgEl('svg', {
        xmlns: SVG_NS, 'xmlns:xlink': 'http://www.w3.org/1999/xlink',
        width: r2(rect.w), height: r2(rect.h), viewBox: `0 0 ${r2(rect.w)} ${r2(rect.h)}`,
        'font-family': FALLBACK_FONT
      });
      this._clipPrefix = newClipPrefix();
      const defs = svgEl('defs');
      svg.appendChild(defs);
      this._drawSeen = new Set();
      this._defs = defs;
      this._clipSeq = 0;
      this._exportStates = [];
      // гарнитуры — первыми: разметка должна нести шрифт с собой
      const want = opts && opts.fonts !== undefined ? !!opts.fonts : !docOverride;
      const fonts = want ? this._fontStyle(id) : { el: null, state: 'skipped', families: [], missing: [] };
      if (fonts.el) defs.appendChild(fonts.el);
      this.lastSVG = { artboard: id, fonts: fonts.state, families: fonts.families, missing: fonts.missing };
      svg.appendChild(svgEl('rect', {
        x: 0, y: 0, width: r2(rect.w), height: r2(rect.h),
        fill: resolveColor(this._td(id), node.fill) || resolveColor(this._td(id), 'canvas') || '#ffffff'
      }));
      this._drawNode(svg, node, -rect.x, -rect.y, true);
      // круг 36 (SPEC §11.3): состояния — CSS в самом файле, он реагирует на мышь
      const css = this._exportStateCss(this._exportStates);
      if (css) {
        const st = svgEl('style', { type: 'text/css' });
        st.appendChild(dom().createTextNode(css));
        defs.appendChild(st);
      }
      const head = '<?xml version="1.0" encoding="UTF-8"?>\n';
      const body = typeof XMLSerializer !== 'undefined' && !svgDom
        ? new XMLSerializer().serializeToString(svg)
        : svg.outerHTML;
      return head + body;
    } catch (e) {
      this._fail('toSVG', e);
      return '';
    } finally {
      this.doc = docPrev;
      this.geo = geoPrev;
      this._srcMap = mapPrev;
      this._defs = defsPrev;
      this._clipSeq = seqPrev;
      this._clipPrefix = prefixPrev;
      this._drawSeen = seenPrev;
      this._exportStates = null;
    }
  }

  /**
   * Элемент <style> со встроенными начертаниями — из того, что уже в кеше.
   * @param {string} id
   * @returns {{el:Element|null, state:string, families:string[], missing:string[]}}
   */
  _fontStyle(id) {
    const needs = this._fontNeeds(id);
    const families = [...needs.keys()];
    if (!needs.size) return { el: null, state: 'none', families, missing: [] };
    if (this.opts && this.opts.embedFonts === false) return { el: null, state: 'off', families, missing: [] };
    let res;
    try { res = fontCssFromCache(needs); }
    catch (e) {
      logOnce('fonts:css', 'встроенные начертания не собрались', e);
      res = { css: '', done: [], missing: families };
    }
    let el = null;
    if (res.css) {
      try {
        el = svgEl('style', { type: 'text/css' });
        el.appendChild(dom().createTextNode(res.css));
      } catch (e) {
        // без <style> экспорт всё равно должен собраться — просто чужим шрифтом
        logOnce('fonts:style', 'элемент <style> для экспорта не создался', e);
        el = null;
        res = { css: '', done: [], missing: families };
      }
    }
    return { el, state: fontState(res), families, missing: res.missing };
  }

  /**
   * PNG активного артборда: сериализация SVG → Image → canvas.
   *
   * Масштаб понижается сам, если полотно не влезает в пределы браузера: сначала
   * до 1×, потом плавно. Если не выходит и так — обещание разрешается в `null`,
   * и об этом всегда сообщается через `_fail`/`opts.onError`. Пустой файл за
   * успех не выдаётся: раньше `toBlob` на артборде ~48 000 px возвращал null,
   * а оболочка рапортовала «Сохранено» с нулём байт.
   *
   * Внешние (http/https) картинки в этот режим не попадают: <img> с blob-адресом
   * чужие ресурсы не грузит. Поэтому перед снимком они переводятся в `data:`,
   * а если не вышло — снимок отклоняется (`null`), а не сохраняется с
   * заглушкой «битое изображение» во весь артборд. Подробности последнего
   * снимка — в `stage.lastShot` (`ok`, а при отказе ещё и `blocked`).
   *
   * Гарнитуры встраиваются в разметку (см. `prepareFonts`): без этого SVG в
   * <img> считает текст системным шрифтом и PNG расходится с экраном. Провал
   * встраивания снимок не отменяет — он виден в `lastShot.fonts`
   * (`embedded` | `partial` | `missing` | `none` | `off`) и `lastShot.fontsMissing`.
   *
   * Вызовы сериализуются: снимок держит отчёт `lastShot` и подстановку картинок,
   * и два снимка разных артбордов внахлёст перетирали их друг другу. Из
   * интерфейса так не сделать (экспорт идёт по одному), но публичный метод
   * обещает это честно: второй вызов дожидается первого, а `lastShot` после
   * своего `await` — всегда свой.
   * @param {{scale?:number, artboardId?:string, timeoutMs?:number, maxSide?:number, maxArea?:number}} [opts]
   * @returns {Promise<Blob|null>} PNG либо null, если снять не удалось
   */
  async screenshot(opts = {}) {
    const prev = this._shotQueue;
    let free;
    this._shotQueue = new Promise((r) => { free = r; });
    if (prev) { try { await prev; } catch (e) { /* чужой провал нас не касается */ } }
    try {
      return await this._shotOnce(opts || {});
    } finally {
      free();   // следующий в очереди пойдёт дальше — даже если у нас исключение
    }
  }

  /** Один снимок. Всё состояние — местное, наружу уходит только `lastShot`. */
  async _shotOnce(opts) {
    const want = isNum(opts.scale) ? clamp(opts.scale, SHOT_MIN_SCALE, 4) : 2;
    const id = opts.artboardId || this.activeArtboard;
    const rect = (this.geo.rects && this.geo.rects[id]) || { w: 8, h: 8 };
    // размер не зажимаем: масштаб подбирается пропорционально, иначе снимок сплющит
    const rw = isNum(rect.w) && rect.w > 0 ? rect.w : 8;
    const rh = isNum(rect.h) && rect.h > 0 ? rect.h : 8;
    const maxSide = isNum(opts.maxSide) && opts.maxSide > 0 ? opts.maxSide : CANVAS_MAX_SIDE;
    const maxArea = isNum(opts.maxArea) && opts.maxArea > 0 ? opts.maxArea : CANVAS_MAX_AREA;
    const scale = fitShotScale(rw, rh, want, maxSide, maxArea);
    // отчёт свой на вызов: раньше он лежал в поле сцены, и второй снимок
    // забирал себе строки первого (гарнитуры, ok, blocked)
    const shot = { requested: want, scale, w: 0, h: 0, ok: false };
    this.lastShot = shot;
    if (scale === null) {
      this._fail('screenshot:size', new Error(
        `артборд ${r2(rw)}×${r2(rh)} не влезает в полотно браузера даже в минимальном масштабе`
      ));
      return null;
    }
    const W = Math.max(1, Math.round(rw * scale));
    const H = Math.max(1, Math.round(rh * scale));
    shot.w = W;
    shot.h = H;
    if (scale < want) {
      logOnce('shot:scale:' + W + 'x' + H,
        `screenshot: масштаб понижен с ${want}× до ${scale}× — полотно ${W}×${H} иначе не создать`);
    }
    const finish = (canvas) => new Promise((resolve) => {
      if (!canvas.toBlob) {
        this._fail('screenshot:toBlob', new Error('canvas.toBlob недоступен'));
        resolve(null);
        return;
      }
      canvas.toBlob((b) => {
        if (b && b.size > 0) { shot.ok = true; resolve(b); return; }
        this._fail('screenshot:blob', new Error(
          `полотно ${canvas.width}×${canvas.height} не превратилось в PNG — снимок не сохранён`
        ));
        resolve(null);
      }, 'image/png');
    });
    // гарнитуры — в разметку: SVG внутри <img> шрифты страницы не видит и
    // считает текст системным (у IBM Plex Sans это +21 % к ширине строки).
    // Провал не отменяет снимок — но и молчать о нём нельзя: PNG тогда
    // расходится с экраном, и оболочке есть о чём предупредить.
    const fonts = await this.prepareFonts(id);
    shot.fonts = fonts.state;
    if (fonts.missing.length) shot.fontsMissing = fonts.missing.slice();
    if (fonts.state === 'missing') {
      this._fail('screenshot:fonts', new Error(
        `начертания (${fonts.missing.join(', ')}) в PNG не встроились — текст будет посчитан системным шрифтом`
      ));
    }
    // внешние картинки — в data:, иначе в PNG будет заглушка вместо них
    const external = this._externalImages(id);
    let srcMap = null;
    if (external.length) {
      try {
        srcMap = await inlineImageSrcs(external);
      } catch (e) {
        shot.blocked = 'external-images';
        this._fail('screenshot:external', new Error(
          `PNG не может включить внешние картинки (${(e && e.message) || e}) — сохраните SVG`
        ));
        return null;
      }
    }
    return new Promise((resolve) => {
      let url = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this._fail('screenshot:ctx', new Error('2d-контекст полотна недоступен'));
          resolve(null);
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        const source = this.toSVG(id, undefined, undefined, { srcMap });
        if (!source) {
          this._fail('screenshot:svg', new Error(`артборд «${id}» не собрался в SVG`));
          resolve(null);
          return;
        }
        const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = 'sync';
        let settled = false;
        let deadline = null;
        // картинка может не выдать ни onload, ни onerror — дальше дедлайна не ждём
        const done = () => {
          if (deadline !== null) { clearTimeout(deadline); deadline = null; }
          if (url) { URL.revokeObjectURL(url); url = null; }
        };
        const settle = (drawn) => {
          if (settled) return;
          settled = true;
          if (!drawn) { done(); resolve(null); return; }   // провал, а не белый лист
          let ok = true;
          try { ctx.drawImage(img, 0, 0, W, H); } catch (e) { this._fail('screenshot:draw', e); ok = false; }
          done();
          resolve(ok ? finish(canvas) : null);
        };
        const wait = isNum(opts.timeoutMs) ? clamp(opts.timeoutMs, 1, 120000) : 8000;
        deadline = setTimeout(() => {
          this._fail('screenshot:timeout', new Error(`картинка не загрузилась за ${wait} мс`));
          img.onload = null;
          img.onerror = null;
          img.src = '';
          settle(false);
        }, wait);
        if (deadline && typeof deadline.unref === 'function') deadline.unref();
        img.onload = () => settle(true);
        img.onerror = (e) => {
          this._fail('screenshot:image', e);
          settle(false);
        };
        img.src = url;
      } catch (e) {
        this._fail('screenshot', e);
        if (url) { try { URL.revokeObjectURL(url); } catch (_) { /* уже отпущено */ } }
        resolve(null);
      }
    });
  }

  /**
   * Внешние адреса картинок в поддереве артборда — те, что PNG сам не утащит.
   * @param {string} id
   * @returns {string[]}
   */
  _externalImages(id) {
    const doc = this.doc;
    if (!doc || !doc.nodes || !this._rn(id)) return [];
    const out = [];
    for (const n of this._subtreeNodes(id)) {
      if (!n || n.type !== 'image' || n.visible === false) continue;
      const src = safeImageSrc(n.src);
      if (isExternalSrc(src) && !out.includes(src)) out.push(src);
    }
    return out;
  }

  /* --------------------------- слой интерфейса --------------------------- */

  _screenRect(id, override) {
    const r = override || this.geo.rects[id];
    if (!r) return null;
    const z = this.view.zoom;
    const p = this.toScreen(r.x, r.y);
    return { x: p.x, y: p.y, w: r.w * z, h: r.h * z };
  }

  /**
   * Прямоугольник, обрезанный предками, которые режут содержимое (`clip`) —
   * теми же и по тому же правилу, что и отрисовка в SVG. Нужен рамкам слоя
   * интерфейса: раньше предпросмотр растущего узла уезжал за край артборда и
   * рисовался поверх соседнего, хотя сам узел был обрезан.
   * @returns {{x:number,y:number,w:number,h:number}|null} null — видимого не осталось
   */
  _clipRect(id, rect) {
    const doc = this.doc;
    if (!doc || !rect) return rect || null;
    let out = rect;
    for (const a of ancestors(doc, id)) {
      if (!a.clip) continue;
      const r = this.geo.rects[a.id];
      if (!r) continue;
      const x1 = Math.max(out.x, r.x);
      const y1 = Math.max(out.y, r.y);
      const x2 = Math.min(out.x + out.w, r.x + r.w);
      const y2 = Math.min(out.y + out.h, r.y + r.h);
      if (x2 <= x1 || y2 <= y1) return null;
      out = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    return out;
  }

  _box(cls, sr, extra) {
    const d = document.createElement('div');
    d.className = 'imago-box' + (cls ? ' ' + cls : '');
    d.style.left = r2(sr.x) + 'px';
    d.style.top = r2(sr.y) + 'px';
    d.style.width = r2(sr.w) + 'px';
    d.style.height = r2(sr.h) + 'px';
    if (extra) Object.assign(d.style, extra);
    this.ui.appendChild(d);
    return d;
  }

  /**
   * Бейдж у выделения. Раньше он висел под нижней кромкой и накрывал то, что
   * лежит ниже («390 × 844» поверх подписи соседнего блока). Теперь его кладёт
   * badgePlace: слева от узла, а если там край экрана — внутрь него.
   * @param {number} [slot] этаж, когда бейджей два
   * @param {{w:number,y1:number,y2:number}} [label] полоса подписи артборда (Stage._labelBand)
   */
  _badge(text, sr, cls, slot, label) {
    const b = document.createElement('div');
    b.textContent = text;
    // размер вьюпорта — из кеша (см. _viewport): прямое чтение clientWidth здесь
    // роняло раскладку всей страницы на каждый бейдж, а бейджи рисуются на каждый
    // кадр интерфейса (круг 16, п.6)
    const view = this.el && (this._vp || isNum(this.el.clientWidth)) ? { w: this.vw, h: this.vh } : null;
    const place = badgePlace(sr, text, slot, view, label);
    // класс места: с той стороны, которой бейдж касается кромки, уголки прямые
    b.className = 'imago-badge' + (cls ? ' ' + cls : '') + ' at-' + place.where;
    b.style.left = r2(place.x) + 'px';
    b.style.top = r2(place.y) + 'px';
    this.ui.appendChild(b);
    return b;
  }

  /**
   * Подпись экземпляра для бейджа: ромб и имя компонента. Мёртвая ссылка названа
   * словами — молчащий ромб выглядел бы как обычный экземпляр (валидатор тем же
   * временем даёт dead-instance).
   * @param {object} node узел-экземпляр из документа
   * @returns {string}
   */
  _instanceLabel(node) {
    const master = masterOf(this.doc, node);
    return '\u25C7 ' + (master ? componentName(master) : 'нет компонента');
  }

  /**
   * Полоса над верхней кромкой узла, занятая подписью артборда, — в экранных
   * координатах того же прямоугольника, что уйдёт в бейдж. `null`, когда над
   * кромкой свободно: узел не артборд или подпись спрятана мелким зумом.
   * Ширину считаем ровно так, как её рисует _updateLabels (обрезка по ширине
   * артборда), высоту — по кеглю: подпись сидит на 6 px над кромкой в координатах
   * документа, то есть на 6·zoom на экране.
   * @param {string} id @param {{x:number,y:number,w:number,h:number}} sr
   * @returns {{w:number,y1:number,y2:number}|null}
   */
  _labelBand(id, sr) {
    const doc = this.doc;
    if (!doc || !sr || !isArtboard(doc, id)) return null;
    const rect = this.geo.rects[id];
    if (!rect) return null;
    const z = this.view.zoom;
    const screenW = rect.w * z;
    if (screenW < AB_LABEL_MIN_W) return null;   // подпись не рисуется — полоса свободна
    const max = Math.floor(screenW / (AB_LABEL_SIZE * AB_LABEL_CHAR));
    const chars = Math.min(displayName(doc, id).length, Math.max(1, max));
    const base = sr.y - 6 * z;   // базовая линия подписи
    return {
      w: Math.ceil(chars * AB_LABEL_SIZE * AB_LABEL_CHAR),
      y1: base - AB_LABEL_SIZE,
      y2: base + 3
    };
  }

  _ovLine(x1, y1, x2, y2, attrs) {
    this.ov.appendChild(svgEl('line', {
      x1: r2(x1), y1: r2(y1), x2: r2(x2), y2: r2(y2),
      stroke: 'var(--accent,#FF6B3D)', 'stroke-width': 1, ...attrs
    }));
  }

  /**
   * Ручки ресайза узла: имя, зона захвата на экране и место видимой точки внутри
   * зоны. Зона сдвинута наружу узла (внутрь заходит на HANDLE_IN), а сама точка
   * стоит ровно на кромке — см. .imago-h в STAGE_CSS и handleNames().
   * @param {string} id
   * @param {{x:number,y:number,w:number,h:number}} [srIn] готовый экранный прямоугольник
   * @returns {{name:string,id:string,x:number,y:number,w:number,h:number,dx:number,dy:number}[]}
   */
  _handles(id, srIn) {
    const node = this.doc && this.doc.nodes ? this.doc.nodes[id] : null;
    const sr = srIn || this._screenRect(id);
    if (!node || !sr) return [];
    const out = [];
    for (const name of handleNames(node, sr)) {
      // 0 — кромка начала оси, 2 — кромка конца, 1 — середина
      const ax = name.includes('w') ? 0 : name.includes('e') ? 2 : 1;
      const ay = name.includes('n') ? 0 : name.includes('s') ? 2 : 1;
      const px = sr.x + (ax === 0 ? 0 : ax === 2 ? sr.w : sr.w / 2);
      const py = sr.y + (ay === 0 ? 0 : ay === 2 ? sr.h : sr.h / 2);
      // где стоит зона: у кромки начала она уходит влево (вверх), у кромки конца —
      // вправо (вниз), внутрь узла заходит на HANDLE_IN
      const zx = ax === 0 ? HANDLE_SIZE - HANDLE_IN : ax === 2 ? HANDLE_IN : HANDLE_SIZE / 2;
      const zy = ay === 0 ? HANDLE_SIZE - HANDLE_IN : ay === 2 ? HANDLE_IN : HANDLE_SIZE / 2;
      // а где внутри зоны — видимая точка: на кромке, отодвинутая наружу ровно
      // настолько, чтобы целиком поместиться в зону (см. HANDLE_OUT)
      const dx = ax === 0 ? zx - HANDLE_OUT : ax === 2 ? zx + HANDLE_OUT : zx;
      const dy = ay === 0 ? zy - HANDLE_OUT : ay === 2 ? zy + HANDLE_OUT : zy;
      out.push({ name, id, x: px - zx, y: py - zy, w: HANDLE_SIZE, h: HANDLE_SIZE, dx, dy });
    }
    return out;
  }

  /**
   * Разложить ручки по слою интерфейса. Элементы ПЕРЕИСПОЛЬЗУЮТСЯ: пока
   * _paintUI пересоздавал их на каждом кадре, браузер терял двойной клик —
   * цель второго нажатия была уже другим узлом DOM (а прежний снят со
   * страницы), и событие dblclick просто не отправлялось. Из-за этого правка
   * текста под ручкой не открывалась вообще.
   * @param {object[]} list результат _handles()
   */
  _layoutHandles(list) {
    if (!this._handleEls) this._handleEls = new Map();
    const seen = new Set();
    for (const h of list) {
      seen.add(h.name);
      let el = this._handleEls.get(h.name);
      if (!el || el.parentNode !== this.ui) {
        el = document.createElement('div');
        el.className = 'imago-h';
        el.dataset.handle = h.name;
        this._handleEls.set(h.name, el);
        this.ui.appendChild(el);
      }
      el.dataset.id = h.id;
      el.style.left = r2(h.x) + 'px';
      el.style.top = r2(h.y) + 'px';
      el.style.setProperty('--hx', r2(h.dx) + 'px');
      el.style.setProperty('--hy', r2(h.dy) + 'px');
    }
    for (const [name, el] of [...this._handleEls]) {
      if (seen.has(name)) continue;
      if (el.parentNode) el.parentNode.removeChild(el);
      this._handleEls.delete(name);
    }
  }

  /** Перерисовать слой интерфейса (выделение, наведение, направляющие, рамка выбора). */
  _paintUI() {
    if (!this.doc || this._dead) return;
    try {
      for (const child of Array.from(this.ui.children)) {
        if (child === this.ov) continue;
        if (this._editing && (child === this._editing.el || child === this._editing.hint)) continue;
        // ручки не пересобираем — см. _layoutHandles
        if (child.dataset && child.dataset.handle) continue;
        this.ui.removeChild(child);
      }
      while (this.ov.firstChild) this.ov.removeChild(this.ov.firstChild);
      this.ov.setAttribute('width', this.vw);
      this.ov.setAttribute('height', this.vh);

      // подсветка изменений агента (гаснет сама)
      for (const p of this._pulses) {
        const sr = this._screenRect(null, p.rect);
        if (!sr) continue;
        const el = svgEl('rect', {
          x: r2(sr.x - 2), y: r2(sr.y - 2), width: r2(sr.w + 4), height: r2(sr.h + 4),
          rx: 6, fill: 'none', stroke: 'var(--agent,#38D6B0)', 'stroke-width': 2, class: 'imago-pulse'
        });
        this.ov.appendChild(el);
      }

      // направляющие магнитов
      for (const g of this._guides) {
        const a = this.toScreen(g.x1, g.y1);
        const b = this.toScreen(g.x2, g.y2);
        this._ovLine(a.x, a.y, b.x, b.y, {
          stroke: g.kind === 'gap' ? 'var(--agent,#38D6B0)' : 'var(--accent,#FF6B3D)',
          'stroke-dasharray': '3 3', 'stroke-width': 1
        });
      }

      // Место вставки при смене порядка. Линия лежит поверх сцены, но тонкая
      // акцентная черта на карточке того же тона читалась плохо: даём светлую
      // подложку и засечки по концам — так видно, что это именно щель.
      if (this._insertion) {
        const a = this.toScreen(this._insertion.x1, this._insertion.y1);
        const b = this.toScreen(this._insertion.x2, this._insertion.y2);
        this._ovLine(a.x, a.y, b.x, b.y, {
          stroke: 'var(--canvas-bg,#F7F6F3)', 'stroke-width': 7,
          'stroke-linecap': 'round', 'stroke-opacity': 0.85
        });
        this._ovLine(a.x, a.y, b.x, b.y, { 'stroke-width': 3, 'stroke-linecap': 'round' });
        const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        const tick = 5;
        for (const p of [a, b]) {
          if (horiz) this._ovLine(p.x, p.y - tick, p.x, p.y + tick, { 'stroke-width': 3, 'stroke-linecap': 'round' });
          else this._ovLine(p.x - tick, p.y, p.x + tick, p.y, { 'stroke-width': 3, 'stroke-linecap': 'round' });
        }
      }

      // рамка выбора
      if (this._marquee) {
        const m = this._marquee;
        const a = this.toScreen(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2));
        const b = this.toScreen(Math.max(m.x1, m.x2), Math.max(m.y1, m.y2));
        this.ov.appendChild(svgEl('rect', {
          x: r2(a.x), y: r2(a.y), width: r2(b.x - a.x), height: r2(b.y - a.y),
          fill: 'var(--accent,#FF6B3D)', 'fill-opacity': 0.08,
          stroke: 'var(--accent,#FF6B3D)', 'stroke-width': 1
        }));
      }

      // круг 36: в просмотре выделения нет — ни рамок, ни ручек, ни бейджей
      const selection = this._previewOn ? [] : (this.state.selection || []).filter((id) => this.geo.rects[id]);
      if (!this._previewOn && this._hover && !selection.includes(this._hover)) {
        const sr = this._screenRect(this._hover);
        if (sr) this._box('is-hover', sr);
      }

      // предпросмотр ресайза: рамку режем артбордом ровно так же, как сам узел
      if (this._drag && this._drag.mode === 'resize' && this._drag.preview) {
        const p = this._drag.preview;
        const vis = this._clipRect(this._drag.id, p);
        const sr = this._screenRect(null, vis || p);
        if (vis) this._box('', sr);
        // размер на бейдже — настоящий, а стоит бейдж у видимой части
        this._badge(`${Math.round(p.w)} × ${Math.round(p.h)}`, sr, '', 0,
          this._labelBand(this._drag.id, sr));
      }

      // «ресайз» — только начавшийся жест (есть предпросмотр). Нажатие на ручку,
      // которое ещё не сдвинулось, сцену не перестраивает: голый клик по ручке
      // не должен ни мигать рамками, ни прятать ручки
      const resizing = !!(this._drag && this._drag.mode === 'resize' && this._drag.preview);
      // перетаскиваемый узел: рамка едет вместе с призраком. На своём прежнем
      // месте она врала — при перестановке туда уже переехал раздвинутый сосед,
      // и рамка выделения оказывалась вокруг чужой карточки
      const moving = this._drag && this._drag.mode === 'move' && this._drag.ghostRect ? this._drag : null;
      for (const id of selection) {
        const node = this.doc.nodes[id];
        // рамка выделения показывает НАСТОЯЩИЕ границы узла, даже если артборд
        // его режет: иначе ручки ресайза оказались бы не на своих кромках
        const sr = moving && moving.id === id
          ? this._screenRect(null, moving.ghostRect) : this._screenRect(id);
        if (!sr || !node) continue;
        // узел, который тянут за ручку, рисует предпросмотр: иначе поверх нового
        // размера остаётся рамка старого и непонятно, какой из них настоящий
        if (resizing && this._drag.id === id) continue;
        // круг 19, п.5: у экземпляра рамка двойная — видно, что это компонент
        const inst = node.type === 'instance';
        this._box((node.override ? 'is-detached' : '') + (inst ? ' is-instance' : ''), sr);
        if (resizing) continue;
        const rect = this.geo.rects[id];
        // полоса подписи артборда: бейджу нельзя ложиться на имя макета
        const band = this._labelBand(id, sr);
        const size = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
        // имя компонента — в ТОТ ЖЕ бейдж, а не третьей плашкой у той же кромки:
        // этажей у кромки два, и третий лёг бы на содержимое (см. badgePlace)
        this._badge(inst ? `${this._instanceLabel(node)} · ${size}` : size, sr, '', 0, band);
        // «отсоединён» встаёт этажом выше размера, по той же кромке
        if (node.override) this._badge('отсоединён', sr, 'is-detached', 1, band);
      }

      // ручки — у одиночного выделения
      const showHandles = selection.length === 1 && !this._editing
        && !(this._drag && (this._drag.mode === 'move' || resizing));
      this._layoutHandles(showHandles ? this._handles(selection[0]) : []);
      if (this._editing) this._positionEditor();
    } catch (e) {
      this._fail('paintUI', e);
    }
  }

  /**
   * FLIP-переезд изменённых узлов + подсветка цветом агента.
   *
   * Рендер без `diff` подсветку НЕ гасит: на ветке созданного узла оболочка
   * рисует сцену ещё раз (выделение, пересчёт вида), и сброс здесь убивал
   * подсветку через ~90 мс — на флагманском «построй мне экран» её просто не
   * успевали увидеть. Гасит только свой таймер; прямоугольники при этом
   * переносим на свежую геометрию, чтобы рамка не отставала от узла.
   */
  _flip(diff) {
    if (this._dead) return;
    const created = (diff && diff.created) || [];
    const changed = (diff && diff.changed) || [];
    const removed = (diff && diff.removed) || [];
    // рендер без изменений (в том числе с пустым diff) подсветку не трогает
    if (!created.length && !changed.length && !removed.length) { this._refreshPulses(); return; }
    this._pulses = [];
    const reduced = prefersReducedMotion();
    /* Круг 32: большая правка (отмена импорта на 8000 узлов, удаление большой доски) — не по
       рамке и анимации на каждый узел: тысячи анимированных прямоугольников — тысячи слоёв
       композитора, и один кадр стоял 9–11 с. Сверх STAGE_PULSE_MAX — одна рамка вокруг
       удалённого и одна вокруг созданного и изменённого, без переездов и проявлений. */
    if (created.length + changed.length + removed.length > STAGE_PULSE_MAX) {
      const union = (ids, rects) => {
        let box = null;
        for (const id of ids) {
          const r = rects[id];
          if (!r) continue;
          if (!box) { box = { x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h }; continue; }
          box.x = Math.min(box.x, r.x); box.y = Math.min(box.y, r.y);
          box.x2 = Math.max(box.x2, r.x + r.w); box.y2 = Math.max(box.y2, r.y + r.h);
        }
        return box ? { x: box.x, y: box.y, w: box.x2 - box.x, h: box.y2 - box.y } : null;
      };
      const gone = union(removed, this._prevRects || {});
      if (gone) this._pulses.push({ rect: gone });
      const fresh = union(created.concat(changed), (this.geo && this.geo.rects) || {});
      if (fresh) this._pulses.push({ rect: fresh });
      this._paintUI();
      this._cancelLater(this._pulseTimer);
      this._pulseTimer = this._later(() => { this._pulses = []; this._paintUI(); }, 950);
      return;
    }
    for (const id of removed) {
      const prev = this._prevRects[id];
      if (prev) this._pulses.push({ rect: prev });   // узла уже нет — id помнить незачем
    }
    for (const id of created.concat(changed)) {
      const next = this.geo.rects[id];
      if (next) this._pulses.push({ id, rect: { ...next } });
      const g = this._nodeEls.get(id);
      if (!g || reduced) continue;
      const prev = this._prevRects[id];
      if (prev && next) {
        const dx = r2(prev.x - next.x);
        const dy = r2(prev.y - next.y);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          g.style.transition = 'none';
          const lv = this._localDelta(id, dx, dy);
          g.setAttribute('transform', `translate(${lv.x} ${lv.y})`);
          const run = () => {
            if (this._dead) return;   // сцену уже сняли — кадр рисовать некуда
            g.style.transition = 'transform 220ms cubic-bezier(.2,.7,.2,1)';
            g.setAttribute('transform', 'translate(0 0)');
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(run));
          else run();
          this._later(() => { g.style.transition = ''; g.removeAttribute('transform'); }, 280);
        }
      } else if (!prev) {
        g.style.transition = 'none';
        g.style.opacity = '0';
        const run = () => {
          if (this._dead) return;
          g.style.transition = 'opacity 220ms ease-out';
          g.style.opacity = '1';
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(run));
        else run();
        this._later(() => { g.style.transition = ''; g.style.opacity = ''; }, 280);
      }
    }
    this._paintUI();
    this._cancelLater(this._pulseTimer);
    this._pulseTimer = this._later(() => { this._pulses = []; this._paintUI(); }, 950);
  }

  /**
   * Перенести живую подсветку на текущую геометрию. Зовётся из рендера без
   * `diff`: подсветка переживает лишний кадр, но рамка должна остаться на узле,
   * а не там, где он лежал до пересчёта.
   */
  _refreshPulses() {
    if (!this._pulses || !this._pulses.length) return;
    const rects = (this.geo && this.geo.rects) || {};
    this._pulses = this._pulses.map((p) => {
      const r = p.id ? rects[p.id] : null;
      return r ? { id: p.id, rect: { ...r } } : p;
    });
  }

  /* ------------------- состояния и просмотр (круг 36, SPEC §11.3) ------------------- */

  /**
   * Режим «Просмотр». Включён — выделения и правки на холсте нет, наведение,
   * нажатие и фокус на узлах со states проигрывают переходы (CSS transitions на
   * группах SVG); выключен — холст в базовом состоянии, ввод как прежде.
   * Панорама (пробел, средняя кнопка) и зум работают в обоих режимах.
   * @param {boolean} on
   * @returns {boolean} режим после вызова
   */
  setPreview(on) {
    const next = !!on;
    if (next === this._previewOn) return next;
    this._previewOn = next;
    this._ix = { hover: new Set(), press: new Set(), focus: null };
    if (next) {
      if (this._editing) this._commitEdit();
      if (this._drag && this._drag.mode !== 'pan') this._cancelDrag('включён просмотр');
      if (this._hover !== null) this._setHover(null);
    }
    if (this.el && this.el.classList) {
      this.el.classList.toggle('is-preview', next);
      this.el.classList.remove('is-live');
    }
    this._syncStates();
    this._paintUI();
    return next;
  }

  /** Включён ли режим «Просмотр». @returns {boolean} */
  get previewMode() { return !!this._previewOn; }

  /**
   * Принудительно показать состояние узла (кнопка «Проиграть» инспектора) или
   * снять его. Работает и в правке, и в просмотре; узлы с motion.follow 'parent'
   * под ним следуют за ним. `playState(null)` снимает все показанные состояния.
   * @param {string|null} nodeId
   * @param {'hover'|'press'|'focus'|null} state null — вернуть базу
   * @param {{holdMs?:number}} [opts] holdMs — снять само через столько мс
   * @returns {boolean} true — узел нарисован и у него есть такое состояние
   */
  playState(nodeId, state, opts) {
    if (nodeId === null || nodeId === undefined) {
      this._forced.clear();
      for (const t of this._forcedTimers.values()) this._cancelLater(t);
      this._forcedTimers.clear();
      this._syncStates();
      return false;
    }
    if (state && !STATE_NAME_SET.has(state)) return false;
    this._cancelLater(this._forcedTimers.get(nodeId));
    this._forcedTimers.delete(nodeId);
    if (state) this._forced.set(nodeId, state);
    else this._forced.delete(nodeId);
    const hold = opts && isNum(opts.holdMs) ? Math.max(0, opts.holdMs) : null;
    if (state && hold !== null) {
      this._forcedTimers.set(nodeId, this._later(() => {
        this._forcedTimers.delete(nodeId);
        if (this._forced.get(nodeId) !== state) return;
        this._forced.delete(nodeId);
        this._syncStates();
      }, hold));
    }
    this._syncStates();
    const c = this._drawn ? this._drawn.get(nodeId) : null;
    return !!(state && c && hasStates(c.node) && isObj(c.node.states[state]));
  }

  /** Ближайший предок узла (по дереву отрисовки) со states. @returns {object|null} */
  _leaderOf(node) {
    let cur = node && typeof node.parent === 'string' ? this._rn(node.parent) : null;
    for (let i = 0; cur && i <= MAX_DEPTH; i++) {
      if (cur.id === (this.doc && this.doc.root)) return null;
      if (hasStates(cur)) return cur;
      cur = typeof cur.parent === 'string' ? this._rn(cur.parent) : null;
    }
    return null;
  }

  /** Какие состояния узла сейчас действуют (в порядке наложения). @returns {string[]} */
  _activeStates(id, node, depth) {
    if (this._forced.has(id)) return [this._forced.get(id)];
    if (isObj(node.motion) && node.motion.follow === 'parent' && (depth || 0) < 64) {
      const leader = this._leaderOf(node);
      if (leader) return this._activeStates(leader.id, leader, (depth || 0) + 1);
    }
    if (!this._previewOn) return [];
    const ix = this._ix;
    const out = [];
    if (ix.hover.has(id)) out.push('hover');
    if (ix.focus === id) out.push('focus');
    if (ix.press.has(id)) out.push('press');
    return out;
  }

  /** Движение узла; ведомый (follow 'parent') без своих полей берёт их у ведущего. */
  _motionFor(node) {
    const own = resolveMotion(this.doc, node);
    if (own.follow !== 'parent') return own;
    const leader = this._leaderOf(node);
    if (!leader) return own;
    const lm = resolveMotion(this.doc, leader);
    const m = node.motion;
    return {
      ...own,
      durationMs: m.duration !== undefined ? own.durationMs : lm.durationMs,
      easing: m.easing !== undefined ? own.easing : lm.easing,
      easingName: m.easing !== undefined ? own.easingName : lm.easingName,
      delayMs: m.delay !== undefined ? own.delayMs : lm.delayMs
    };
  }

  /**
   * Наложить действующие состояния на нарисованные узлы. Пишет только то, что
   * изменилось (ключ на записи отрисовки), поэтому зовётся на каждое движение
   * мыши в просмотре и после каждой отрисовки. Слушателей не заводит.
   */
  _syncStates() {
    if (!this._drawn || this._dead || !this.doc) return;
    if (!this._stList) {
      this._stList = [];
      for (const [id, c] of this._drawn) if (c && hasStates(c.node)) this._stList.push(id);
    }
    if (!this._stList.length) return;
    const reduced = prefersReducedMotion();
    for (const id of this._stList) {
      const c = this._drawn.get(id);
      if (c) this._applyState(id, c, reduced);
    }
  }

  /** Вид одного узла в его действующем состоянии (база — пустые инлайн-стили). */
  _applyState(id, c, reduced) {
    const node = c.node;
    const g = c.el;
    if (!g || !g.style) return;
    const list = this._activeStates(id, node, 0);
    const r = resolveState(this._td(id), node, list);
    const mo = this._motionFor(node);
    const trG = reduced ? 'none' : transitionCss(mo, ['transform', 'opacity', 'filter']);
    const trS = reduced ? 'none' : transitionCss(mo, ['fill', 'stroke', 'stroke-width', 'filter']);
    const rect = c.rect || { x: 0, y: 0, w: 0, h: 0 };
    const key = list.join(',') + '|' + trG + '|' + rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h;
    // FLIP снимает переход с группы по окончании — сверяемся и с ним
    if (c.stKey === key && g.style.transition === trG) return;
    c.stKey = key;
    const sh = c.shapes && c.shapes[0] ? c.shapes[0] : null;
    g.style.transition = trG;
    g.style.transformBox = 'view-box';
    g.style.transformOrigin = `${r2(rect.x + rect.w / 2)}px ${r2(rect.y + rect.h / 2)}px`;
    g.style.transform = r.transform === 'none' ? '' : r.transform;
    g.style.opacity = r.changed.indexOf('opacity') >= 0 ? String(r.opacity) : '';
    const target = sh || g;
    if (sh && sh.style) {
      sh.style.transition = trS;
      if (node.type === 'text') {
        sh.style.fill = r.changed.indexOf('color') >= 0 ? (r.color || '') : '';
      } else {
        sh.style.fill = r.changed.indexOf('fill') >= 0 ? (r.fill || 'transparent') : '';
        const strokeOn = r.changed.indexOf('stroke') >= 0 || r.changed.indexOf('strokeWidth') >= 0;
        sh.style.stroke = strokeOn ? (r.stroke || 'none') : '';
        sh.style.strokeWidth = strokeOn ? String(r.strokeWidth) : '';
      }
    }
    if (target.style) target.style.filter = r.filter === 'none' ? (r.changed.indexOf('shadow') >= 0 ? 'none' : '') : r.filter;
  }

  /**
   * Цепочка узлов под точкой — от самого глубокого (включая раскрытое
   * содержимое экземпляра) до верха: так наведение ложится на узел и всех его
   * предков, как :hover в браузере. Замок в просмотре не мешает.
   * @returns {string[]}
   */
  _previewChain(world) {
    const doc = this.doc;
    if (!doc || !this.geo) return [];
    const inside = (r) => r && world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h;
    const order = this.geo.order || [];
    let top = null;
    for (let i = order.length - 1; i >= 0; i--) {
      const n = doc.nodes[order[i]];
      if (!n || n.visible === false) continue;
      if (inside(this.geo.rects[order[i]])) { top = n; break; }
    }
    if (!top) return [];
    const chain = [top.id];
    for (const a of ancestors(doc, top.id)) chain.push(a.id);
    // внутрь экземпляра: его содержимое — раскрытые узлы, в geo.order их нет
    let cur = this._rn(top.id);
    for (let guard = 0; cur && (cur.type === 'instance' || cur.synthetic) && guard <= MAX_DEPTH; guard++) {
      const kids = kidsOf(cur);
      let next = null;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = this._rn(kids[i]);
        if (k && k.visible !== false && inside(this.geo.rects[kids[i]])) { next = k; break; }
      }
      if (!next) break;
      chain.unshift(next.id);
      cur = next;
    }
    return chain;
  }

  /** Наведение в просмотре. */
  _previewMove(world) {
    const chain = this._previewChain(world);
    const prev = this._ix.hover;
    if (chain.length === prev.size && chain.every((id) => prev.has(id))) return;
    this._ix.hover = new Set(chain);
    const live = chain.some((id) => hasStates(this._rn(id)));
    if (this.el && this.el.classList) this.el.classList.toggle('is-live', live);
    this._syncStates();
  }

  /** Нажатие в просмотре: нажата вся цепочка; фокус — самый глубокий узел с focus. */
  _previewDown(world) {
    const chain = this._previewChain(world);
    this._ix.hover = new Set(chain);
    this._ix.press = new Set(chain);
    let focus = null;
    for (const id of chain) {
      const n = this._rn(id);
      if (n && hasStates(n) && isObj(n.states.focus)) { focus = id; break; }
    }
    this._ix.focus = focus;
    this._syncStates();
  }

  /** Указатель ушёл со сцены: наведения нет (нажатие держится до отпускания). */
  _previewLeave() {
    if (!this._ix.hover.size) return;
    this._ix.hover = new Set();
    if (this.el && this.el.classList) this.el.classList.remove('is-live');
    this._syncStates();
  }

  /**
   * Клавиши в просмотре: Tab / Shift+Tab — фокус по узлам с состоянием focus,
   * Esc — снять фокус. Пробел (панорама) и Ctrl/Cmd+Z идут обычным путём, прочее
   * (Delete, стрелки, дублирование) в просмотре не действует.
   * @returns {boolean} true — клавиша обработана здесь
   */
  _previewKey(e) {
    const meta = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && !meta) return false;
    if (meta && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) return false;
    if (e.key === 'Tab') {
      if (!this._stList) this._syncStates();
      const list = (this._stList || []).filter((id) => {
        const c = this._drawn.get(id);
        return c && isObj(c.node.states) && isObj(c.node.states.focus);
      });
      if (!list.length) return true;
      e.preventDefault();
      const at = list.indexOf(this._ix.focus);
      const step = e.shiftKey ? -1 : 1;
      this._ix.focus = list[(at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length)];
      this._syncStates();
      return true;
    }
    if (e.key === 'Escape' && this._ix.focus !== null) {
      if (typeof e.preventDefault === 'function') e.preventDefault();   // первый Esc снимает фокус, второй — выводит из просмотра
      this._ix.focus = null;
      this._syncStates();
    }
    return true;
  }

  /**
   * CSS состояний для экспорта SVG: на узел — переход и правила :hover,
   * :focus-visible (группа с tabindex), :active; ведомый (follow 'parent')
   * меняется по псевдоклассу ведущего. prefers-reduced-motion — без переходов.
   * @param {Array<{node:object, cls:string, hasShape:boolean, cx:number, cy:number}>} list
   * @returns {string}
   */
  _exportStateCss(list) {
    if (!list || !list.length) return '';
    const doc = this.doc;
    const clsOf = new Map(list.map((e) => [e.node.id, e.cls]));
    const rules = [];
    const PSEUDO = [['hover', ':hover'], ['focus', ':focus-visible'], ['press', ':active']];
    for (const e of list) {
      const node = e.node;
      const mo = this._motionFor(node);
      rules.push(`.${e.cls}{transform-box:view-box;transform-origin:${e.cx}px ${e.cy}px;`
        + `transition:${transitionCss(mo, ['transform', 'opacity', 'filter'])}}`);
      rules.push(`.${e.cls}>.imago-shape{transition:${transitionCss(mo, ['fill', 'stroke', 'stroke-width', 'filter'])}}`);
      let lead = null;
      if (isObj(node.motion) && node.motion.follow === 'parent') {
        const leader = this._leaderOf(node);
        if (leader && clsOf.has(leader.id)) lead = clsOf.get(leader.id);
      }
      for (const [s, pseudo] of PSEUDO) {
        if (!isObj(node.states[s])) continue;
        // нажатие мышью идёт поверх наведения — как и на холсте
        const r = resolveState(this._td(node.id), node, s === 'press' ? ['hover', 'press'] : [s]);
        if (!r.changed.length) continue;
        const sel = lead ? `.${lead}${pseudo} .${e.cls}` : `.${e.cls}${pseudo}`;
        const gp = [];
        const sp = [];
        if (r.transform !== 'none') gp.push(`transform:${r.transform}`);
        if (r.changed.indexOf('opacity') >= 0) gp.push(`opacity:${r.opacity}`);
        if (r.changed.indexOf('shadow') >= 0) (e.hasShape ? sp : gp).push(`filter:${r.filter}`);
        if (node.type === 'text') {
          if (r.changed.indexOf('color') >= 0 && r.color) sp.push(`fill:${r.color}`);
        } else {
          if (r.changed.indexOf('fill') >= 0) sp.push(`fill:${r.fill || 'transparent'}`);
          if (r.changed.indexOf('stroke') >= 0 || r.changed.indexOf('strokeWidth') >= 0) {
            sp.push(`stroke:${r.stroke || 'none'}`, `stroke-width:${r.strokeWidth}`);
          }
        }
        if (gp.length) rules.push(`${sel}{${gp.join(';')}}`);
        if (sp.length && e.hasShape) rules.push(`${sel}>.imago-shape{${sp.join(';')}}`);
      }
    }
    rules.push('@media (prefers-reduced-motion: reduce){.imago-anim,.imago-anim>.imago-shape{transition:none!important}}');
    return rules.join('\n');
  }

  /* ------------------------------ хит-тест ------------------------------ */

  /**
   * Самый верхний по отрисовке узел под точкой — то есть самый глубокий из
   * нарисованных там. Ни выделение, ни уровни артборда не учитываются: это
   * сырой ответ «что нарисовано под курсором».
   * @param {{x:number,y:number}} world
   * @returns {object|null}
   */
  _topUnder(world) {
    const doc = this.doc;
    if (!doc || !this.geo) return null;
    // Круг 16, п.6: идём с КОНЦА порядка отрисовки и выходим на первом попадании.
    // Верхний узел — последний подходящий в порядке, значит первый с конца: ответ
    // тот же, а на большом документе не перебирается весь список на каждое
    // движение мыши (40 477 узлов — 5 мс на проверку, и так на каждый кадр).
    const order = this.geo.order || [];
    for (let i = order.length - 1; i >= 0; i--) {
      const n = doc.nodes[order[i]];
      if (!n || n.visible === false || n.locked) continue;
      const r = this.geo.rects[order[i]];
      if (!r) continue;
      if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) {
        // круг 37: вектор ловится по контурам — сквозь «пустоту» рамки клик идёт к тому, что под ним
        if (n.type === 'vector' && !this._vectorHit(n, r, world)) continue;
        return n;
      }
    }
    return null;
  }

  /**
   * Попала ли точка в контуры вектора (круг 37). Нужен DOM с isPointInFill —
   * без него (и без нарисованной фигуры) отвечаем «да»: попадание по рамке, как раньше.
   * Поворот самого узла учитывается, поворот предков — нет (рамка их и так не знает).
   * @returns {boolean}
   */
  _vectorHit(n, r, world) {
    const c = this._drawn && this._drawn.get(n.id);
    const g = c && c.shapes && c.shapes[0];
    if (!g || !g.children || typeof DOMPoint !== 'function') return true;
    let px = world.x;
    let py = world.y;
    const rd = this._rotDeg(n);
    if (rd) {
      const a = (-rd * Math.PI) / 180;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const ux = px - cx;
      const uy = py - cy;
      px = cx + ux * Math.cos(a) - uy * Math.sin(a);
      py = cy + ux * Math.sin(a) + uy * Math.cos(a);
    }
    const vb = vbOf(n);
    const s = vb.w > 0 && vb.h > 0 ? Math.min(r.w / vb.w, r.h / vb.h) : 0;
    if (!s) return false;
    const tx = r.x + (r.w - vb.w * s) / 2 - vb.x * s;
    const ty = r.y + (r.h - vb.h * s) / 2 - vb.y * s;
    const pt = new DOMPoint((px - tx) / s, (py - ty) / s);
    const gFill = g.getAttribute('fill');
    const gStroke = g.getAttribute('stroke');
    try {
      for (const el of g.children) {
        if (typeof el.isPointInFill !== 'function') return true;
        const f = el.getAttribute('fill') || gFill;
        if (f && f !== 'none' && el.isPointInFill(pt)) return true;
        const st = el.getAttribute('stroke') || gStroke;
        if (st && st !== 'none' && el.isPointInStroke(pt)) return true;
      }
    } catch (e) {
      return true;
    }
    return false;
  }

  /**
   * Узел под курсором. deep — явное «углубись» (Alt, Cmd/Ctrl, двойной клик),
   * иначе верхний уровень внутри артборда.
   *
   * Отдельное правило: если точка внутри уже выделенного узла, возвращаем его,
   * а не ребёнка под курсором. Рамка с ручками обещает «двигаю вот это», и
   * раньше нажатие внутри неё молча переключалось на дочернюю подпись и тащило
   * её, вешая override. Углубление осталось, но по явному жесту — двойной клик
   * или Cmd/Ctrl-клик.
   *
   * Углубление ПОШАГОВОЕ: каждый такой жест опускается на один уровень от
   * текущего выделения. Раньше он прыгал сразу к самому глубокому узлу, и до
   * промежуточного фрейма («Пункт · …») мышью было не добраться — только через
   * рельс слоёв.
   */
  _hitTest(world, deep) {
    const doc = this.doc;
    if (!doc) return null;
    const hit = this._topUnder(world);
    if (!hit) return null;
    const chain = [hit, ...ancestors(doc, hit.id)];
    const abIdx = chain.findIndex((n) => isArtboard(doc, n));
    if (abIdx <= 0) return hit;            // сам артборд либо узел вне артбордов
    // путь от верхнего уровня артборда до узла под курсором
    const path = chain.slice(0, abIdx).reverse();
    const sel = this._selectionUnder(world);
    if (!deep) return sel || path[0];
    const at = sel ? path.findIndex((n) => n.id === sel.id) : -1;
    return path[Math.min(at + 1, path.length - 1)];
  }

  /**
   * Самый верхний по отрисовке выделенный узел под точкой. Артборды не считаем:
   * артборд накрывает всё своё содержимое, и клик внутри него должен по-прежнему
   * выбирать содержимое — иначе выделенный артборд запирает сцену.
   * @returns {object|null}
   */
  _selectionUnder(world) {
    const doc = this.doc;
    const ids = this.state && this.state.selection ? this.state.selection : [];
    if (!ids.length || !doc) return null;
    let best = null;
    let bestIdx = -1;
    for (const id of ids) {
      const n = doc.nodes[id];
      if (!n || n.visible === false || n.locked) continue;
      if (isArtboard(doc, n)) continue;
      const r = this.geo.rects[id];
      if (!r) continue;
      if (world.x < r.x || world.x > r.x + r.w || world.y < r.y || world.y > r.y + r.h) continue;
      const idx = this.geo.order.indexOf(id);
      if (idx >= bestIdx) { bestIdx = idx; best = n; }
    }
    return best;
  }

  /**
   * Кого берёт рамка выбора. Правило одно и читается вслух: узел, попавший в
   * рамку ЦЕЛИКОМ, берётся сам, и внутрь него мы не идём — иначе в выделении
   * оказались бы и предок, и его потомок. Узел, задетый рамкой лишь частью,
   * уступает тем своим детям, что попали целиком; если внутри не поймали
   * никого — берётся сам. Так рамкой выбирается и вложенный узел, а не только
   * прямой ребёнок артборда.
   *
   * Сами артборды в кандидаты не идут: рамку начинают на пустом холсте и ведут
   * поверх них, и артборд накрыл бы собой всё своё содержимое.
   * @param {{x1:number,y1:number,x2:number,y2:number}} box мир, нормализованный
   * @returns {string[]}
   */
  _marqueePick(box) {
    const doc = this.doc;
    if (!doc) return [];
    const hits = (r) => r.x < box.x2 && r.x + r.w > box.x1 && r.y < box.y2 && r.y + r.h > box.y1;
    const inside = (r) => r.x >= box.x1 && r.y >= box.y1 && r.x + r.w <= box.x2 && r.y + r.h <= box.y2;
    const out = [];
    const walk = (node, depth) => {
      if (depth > MAX_DEPTH) return;
      for (const cid of kidsOf(node)) {
        const child = ownNode(doc.nodes, cid);
        if (!child || child.visible === false || child.locked) continue;
        const r = this.geo.rects[cid];
        if (!r || !hits(r)) continue;
        if (inside(r)) { out.push(cid); continue; }
        const before = out.length;
        walk(child, depth + 1);
        if (out.length === before) out.push(cid);   // внутри пусто — берём сам узел
      }
    };
    for (const ab of artboards(doc)) walk(ab, 0);
    return out;
  }

  _setActiveArtboardFor(id) {
    const doc = this.doc;
    const chain = [doc.nodes[id], ...ancestors(doc, id)].filter(Boolean);
    const ab = chain.find((n) => isArtboard(doc, n));
    if (ab) this.activeArtboard = ab.id;
  }

  _emitSelect(ids) {
    this.state = { ...this.state, selection: ids.slice() };
    if (this.opts.onSelect) {
      try { this.opts.onSelect(ids.slice()); } catch (e) { this._fail('onSelect', e); }
    }
    this._paintUI();
  }

  _commit(list, label) {
    const clean = (list || []).filter(Boolean);
    if (!clean.length) return;
    if (!this.opts.onCommit) { logOnce('stage:nocommit', 'Stage: opts.onCommit не задан, правка потеряна'); return; }
    try { this.opts.onCommit({ ops: clean, label: label || 'Правка' }); } catch (e) { this._fail('onCommit', e); }
  }

  /* ------------------------------- магниты ------------------------------- */

  _gridStep() {
    const spacing = (this.doc && this.doc.tokens && this.doc.tokens.spacing) || DEFAULT_TOKENS.spacing;
    return spacing.filter((s) => s >= 4)[0] || 8;
  }

  /**
   * Магниты: края и центры соседей, зазоры между ними, шаг сетки.
   * @returns {{x:number,y:number,guides:Array}}
   */
  _snap(rect, node) {
    const doc = this.doc;
    const out = { x: rect.x, y: rect.y, guides: [] };
    const parent = ownNode(doc.nodes, node.parent);
    if (!parent) return out;
    const pr = this.geo.rects[parent.id];
    const thr = 6 / this.view.zoom;
    const sibs = (parent.children || [])
      .filter((id) => id !== node.id)
      .map((id) => this.geo.rects[id])
      .filter(Boolean);
    const L = resolveLayout(doc, parent.layout);
    const gapSet = new Set([L.gap].filter((g) => g > 0));
    const sortedX = sibs.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sortedX.length; i++) {
      const g = r2(sortedX[i].x - (sortedX[i - 1].x + sortedX[i - 1].w));
      if (g > 0) gapSet.add(g);
    }
    const gaps = [...gapSet];

    const build = (axis) => {
      const a = axis === 'x' ? 'x' : 'y';
      const s = axis === 'x' ? 'w' : 'h';
      const cands = [];
      for (const t of sibs) {
        cands.push({ v: t[a], ref: t }, { v: t[a] + t[s] / 2, ref: t }, { v: t[a] + t[s], ref: t });
        for (const g of gaps) {
          cands.push({ v: t[a] + t[s] + g, ref: t, kind: 'gap' });
          cands.push({ v: t[a] - g - rect[s], ref: t, kind: 'gap', anchorIndex: 0 });
        }
      }
      if (pr) {
        const padA = axis === 'x' ? L.padding.l : L.padding.t;
        const padB = axis === 'x' ? L.padding.r : L.padding.b;
        cands.push({ v: pr[a] + padA, ref: pr }, { v: pr[a] + pr[s] / 2, ref: pr }, { v: pr[a] + pr[s] - padB, ref: pr });
      }
      const anchors = [{ v: rect[a], off: 0 }, { v: rect[a] + rect[s] / 2, off: rect[s] / 2 }, { v: rect[a] + rect[s], off: rect[s] }];
      let best = null;
      for (let ai = 0; ai < anchors.length; ai++) {
        for (const c of cands) {
          if (c.kind === 'gap' && c.anchorIndex !== undefined && ai !== c.anchorIndex) continue;
          if (c.kind === 'gap' && c.anchorIndex === undefined && ai !== 0) continue;
          const d = Math.abs(c.v - anchors[ai].v);
          if (d <= thr && (!best || d < best.d)) best = { d, value: c.v - anchors[ai].off, line: c.v, ref: c.ref, kind: c.kind };
        }
      }
      if (!best) {
        const step = this._gridStep();
        const snapped = Math.round(rect[a] / step) * step;
        if (Math.abs(snapped - rect[a]) <= thr / 2) return { value: snapped, line: null };
        return null;
      }
      return best;
    };

    const bx = build('x');
    if (bx) {
      out.x = r2(bx.value);
      if (bx.line !== null && bx.line !== undefined) {
        const y1 = Math.min(rect.y, bx.ref ? bx.ref.y : rect.y) - 12;
        const y2 = Math.max(rect.y + rect.h, bx.ref ? bx.ref.y + bx.ref.h : rect.y + rect.h) + 12;
        out.guides.push({ x1: bx.line, y1, x2: bx.line, y2, kind: bx.kind });
      }
    }
    const by = build('y');
    if (by) {
      out.y = r2(by.value);
      if (by.line !== null && by.line !== undefined) {
        const x1 = Math.min(rect.x, by.ref ? by.ref.x : rect.x) - 12;
        const x2 = Math.max(rect.x + rect.w, by.ref ? by.ref.x + by.ref.w : rect.x + rect.w) + 12;
        out.guides.push({ x1, y1: by.line, x2, y2: by.line, kind: by.kind });
      }
    }
    return out;
  }

  /* -------------------------------- ввод -------------------------------- */

  _bindEvents() {
    const el = this.el;
    el.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    el.addEventListener('pointerleave', () => {
      if (this._previewOn) this._previewLeave();
      else if (!this._drag) this._setHover(null);
    });
    el.addEventListener('dblclick', (e) => this._onDblClick(e));
    el.addEventListener('touchstart', (e) => this._onTouch(e), { passive: false });
    el.addEventListener('touchmove', (e) => this._onTouch(e), { passive: false });
    el.addEventListener('touchend', () => { this._touch = null; });
    this._onWinKey = (e) => {
      const ae = typeof document !== 'undefined' ? document.activeElement : null;
      if (ae && ae !== document.body && !this.el.contains(ae)) return;
      this._onKey(e);
    };
    this._onWinKeyUp = (e) => {
      if (e.code === 'Space') this._releaseSpace();
    };
    // Пробел «залипал»: зажали его на холсте, ушли по Alt+Tab — keyup достался
    // уже другому окну, _space остался true, и холст навсегда оставался в режиме
    // панорамы (клики не выделяли, а таскали сцену). Уход фокуса из окна
    // равносилен отпусканию.
    this._onWinBlur = () => this._releaseSpace();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onWinKey, true);
      window.addEventListener('keyup', this._onWinKeyUp, true);
      window.addEventListener('blur', this._onWinBlur);
    }
  }

  /** Снять режим панорамы по пробелу. */
  _releaseSpace() {
    this._space = false;
    if (this.el && this.el.classList) this.el.classList.remove('is-space');
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else if (Math.abs(e.deltaX) > 0.5) {
      this.view.pan.x -= e.deltaX;
      this.view.pan.y -= e.deltaY;
      this._applyView();
      this._paintUI();
    } else {
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0022));
    }
  }

  _onTouch(e) {
    if (e.touches.length !== 2) { this._touch = null; return; }
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const cx = (a.clientX + b.clientX) / 2;
    const cy = (a.clientY + b.clientY) / 2;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!this._touch) { this._touch = { cx, cy, dist }; return; }
    this.view.pan.x += cx - this._touch.cx;
    this.view.pan.y += cy - this._touch.cy;
    this._applyView();
    if (this._touch.dist > 0 && Math.abs(dist - this._touch.dist) > 1) {
      this.zoomAt(cx, cy, dist / this._touch.dist);
    } else {
      this._paintUI();
    }
    this._touch = { cx, cy, dist };
  }

  _setHover(id) {
    if (this._hover === id) return;
    this._hover = id;
    if (this.opts.onHover) {
      try { this.opts.onHover(id); } catch (e) { this._fail('onHover', e); }
    }
    this._paintUI();
  }

  _onPointerDown(e) {
    if (e.button === 2) return;
    try {
      const handle = e.target && e.target.dataset ? e.target.dataset.handle : null;
      if (this._editing && e.target !== this._editing.el && !this._editing.el.contains(e.target)) {
        this._commitEdit();
      }
      if (!handle) this.el.focus({ preventScroll: true });
      // круг 36: в просмотре нажатие — состояние press (и фокус), не выделение
      if (this._previewOn && !(e.button === 1 || this._space)) {
        this._previewDown(this.toWorld(e.clientX, e.clientY));
        if (this.el.setPointerCapture) this.el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button === 1 || this._space) {
        this._drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, pan: { ...this.view.pan } };
        this.el.classList.add('is-panning');
      } else if (handle) {
        const id = e.target.dataset.id;
        const rect = this.geo.rects[id];
        if (!rect) return;
        // preview НЕ ставим при нажатии: он появляется в _updateResize, когда
        // жест реально сдвинулся. Иначе голый клик по ручке (а её зона выходит
        // за кромку узла — там обычно щёлкают по соседу) молча коммитил
        // fixed-размер: «fill → 350» у ребёнка артборда ломало раскладку, и
        // обнаруживалось это много позже.
        this._drag = { mode: 'resize', id, handle, start: this.toWorld(e.clientX, e.clientY), rect0: { ...rect } };
      } else {
        const w = this.toWorld(e.clientX, e.clientY);
        // Alt и Cmd/Ctrl — явное «углубись до узла под курсором»
        const hit = this._hitTest(w, e.altKey || e.metaKey || e.ctrlKey);
        if (!hit) {
          this._drag = { mode: 'marquee', start: w, base: e.shiftKey ? (this.state.selection || []).slice() : [] };
          this._marquee = { x1: w.x, y1: w.y, x2: w.x, y2: w.y };
          if (!e.shiftKey) this._emitSelect([]);
        } else {
          let sel = (this.state.selection || []).slice();
          if (e.shiftKey) {
            sel = sel.includes(hit.id) ? sel.filter((i) => i !== hit.id) : sel.concat(hit.id);
            this._emitSelect(sel);
          } else if (!sel.includes(hit.id)) {
            sel = [hit.id];
            this._emitSelect(sel);
          }
          this._setActiveArtboardFor(hit.id);
          if (!isArtboard(this.doc, hit)) {
            this._drag = { mode: 'maybe-move', id: hit.id, start: w, rect0: { ...this.geo.rects[hit.id] } };
          } else {
            this._drag = { mode: 'maybe-move', id: hit.id, start: w, rect0: { ...this.geo.rects[hit.id] }, artboard: true };
          }
        }
      }
      if (this.el.setPointerCapture) this.el.setPointerCapture(e.pointerId);
    } catch (err) {
      this._fail('pointerdown', err);
    }
  }

  _onPointerMove(e) {
    try {
      const w = this.toWorld(e.clientX, e.clientY);
      const d = this._drag;
      if (this._previewOn && (!d || d.mode !== 'pan')) { this._previewMove(w); return; }
      if (!d) {
        const hit = this._hitTest(w, e.altKey || e.metaKey || e.ctrlKey);
        this._setHover(hit ? hit.id : null);
        return;
      }
      if (d.mode === 'pan') {
        this.view.pan.x = d.pan.x + (e.clientX - d.sx);
        this.view.pan.y = d.pan.y + (e.clientY - d.sy);
        this._applyView();
        this._paintUI();
        return;
      }
      if (d.mode === 'marquee') {
        this._marquee = { x1: d.start.x, y1: d.start.y, x2: w.x, y2: w.y };
        this._paintUI();
        return;
      }
      if (d.mode === 'maybe-move') {
        if (Math.hypot(w.x - d.start.x, w.y - d.start.y) * this.view.zoom < 3) return;
        d.mode = 'move';
      }
      if (d.mode === 'move') this._updateMove(d, w, e);
      if (d.mode === 'resize') {
        // порог тот же, что у перетаскивания: пока рука не ушла на 3 экранных
        // пикселя, ресайза нет — ни предпросмотра, ни коммита
        if (!d.resized && Math.hypot(w.x - d.start.x, w.y - d.start.y) * this.view.zoom < 3) return;
        this._updateResize(d, w, e);
        this._schedulePreview();
      }
      this._paintUI();
    } catch (err) {
      this._fail('pointermove', err);
    }
  }

  /**
   * Потоковые соседи родителя: дети, которые участвуют в раскладке. Отсоединённые
   * (с `override`) и те, у кого нет прямоугольника, в потоке не стоят.
   *
   * Это ОТДЕЛЬНОЕ пространство индексов: в нём считается место вставки при
   * перестановке и рисуется маркер, а `ops.move` вставляет в полный `children`.
   * Каждый отсоединённый ребёнок левее цели сдвигает номер на один, поэтому
   * перевод одного в другое обязателен — им занят `_commitMove`.
   * @param {object} parent
   * @param {string|null} exceptId кого не считать соседом (обычно — перетаскиваемый)
   * @returns {string[]}
   */
  _flowSiblings(parent, exceptId) {
    const doc = this.doc;
    if (!parent || !doc) return [];
    return (parent.children || []).filter((id) => {
      if (id === exceptId) return false;
      const n = ownNode(doc.nodes, id);
      return n && !n.override && ownNode(this.geo.rects, id);
    });
  }

  _updateMove(d, w, e) {
    const doc = this.doc;
    const node = doc.nodes[d.id];
    if (!node) return;
    const dx = w.x - d.start.x;
    const dy = w.y - d.start.y;
    this._guides = [];
    this._insertion = null;
    this._clearShift();
    const parent = ownNode(doc.nodes, node.parent);
    const isRoot = !parent || parent.id === doc.root;
    const L = parent ? resolveLayout(doc, parent.layout) : DEFAULT_LAYOUT;
    const flow = !isRoot && (L.mode === 'row' || L.mode === 'column') && !node.override;
    const total = Math.hypot(dx, dy);
    const main = L.mode === 'row' ? dx : dy;
    if (flow && total > 0 && Math.abs(main) / total >= 0.7) {
      // смена порядка в потоке: индекс считается среди потоковых соседей,
      // перевод в полный children — в _commitMove (см. _flowSiblings)
      const axis = L.mode === 'row' ? 'x' : 'y';
      const ordered = this._flowSiblings(parent, d.id);
      const slots = this._flowSlots(d, parent, L, ordered);
      let index;
      let ghostMain = main;
      if (slots) {
        // место вставки — слот, к началу которого ближе ведущая кромка призрака
        const lead = d.rect0[axis] + main;
        index = 0;
        while (index + 1 < slots.length && lead >= (slots[index] + slots[index + 1]) / 2) index++;
        // и сам призрак держим внутри потока: дальше крайнего слота вставать
        // некуда, а уехавший туда призрак снова обгонял бы линию вставки
        ghostMain = clamp(lead, slots[0], slots[slots.length - 1]) - d.rect0[axis];
      } else {
        index = this._pointerIndex(ordered, L, w);
      }
      d.result = { kind: 'move', parent: parent.id, index };
      const at = ordered[Math.min(index, ordered.length - 1)];
      const ar = at ? this.geo.rects[at] : this.geo.rects[parent.id];
      const before = index < ordered.length;
      if (ar) {
        const pos = axis === 'x'
          ? (before ? ar.x - L.gap / 2 : ar.x + ar.w + L.gap / 2)
          : (before ? ar.y - L.gap / 2 : ar.y + ar.h + L.gap / 2);
        this._insertion = axis === 'x'
          ? { x1: pos, y1: ar.y, x2: pos, y2: ar.y + ar.h }
          : { x1: ar.x, y1: pos, x2: ar.x + ar.w, y2: pos };
      }
      this._ghost(d.id, axis === 'x' ? ghostMain : dx, axis === 'y' ? ghostMain : dy);
      this._shiftFlow(d, parent, L, ordered, index);
      return;
    }
    // свободный сдвиг: override (или pos в режиме none / на холсте)
    const target = { x: d.rect0.x + dx, y: d.rect0.y + dy, w: d.rect0.w, h: d.rect0.h };
    const snapped = isRoot ? { x: target.x, y: target.y, guides: [] } : this._snap(target, node);
    this._guides = snapped.guides;
    d.result = {
      // свободная рамка: сдвиг пишет pos ребёнка (SPEC §12.3); отсоединённый — свой override
      kind: isRoot ? 'pos-canvas' : (L.mode === 'none' && !node.override ? 'pos' : 'override'),
      x: snapped.x, y: snapped.y
    };
    this._ghost(d.id, snapped.x - d.rect0.x, snapped.y - d.rect0.y);
  }

  /**
   * Слоты потока — начала мест, куда может встать перетаскиваемый блок, в
   * координатах документа. `null` для раскладок, где слоты не лежат подряд.
   *
   * Зачем. Раньше место вставки считалось по КУРСОРУ — пересёк ли он середину
   * соседа. Курсор держит блок за ту точку, за которую взялись, и у высокого
   * блока отстаёт от его кромки на всю высоту: «Список пунктов» (214 px) уезжал
   * на 120 px мимо двух соседей, а линия вставки честно стояла на старом месте —
   * перестановка начиналась только с dy ≈ 160. Призрак обгонял линию, а на
   * отпускании блок молча возвращался: человек видел ровно противоположное тому,
   * что произойдёт.
   *
   * Слоты раскладываем БЕЗ перетаскиваемого блока: соседи, стоявшие за ним,
   * сдвигаются назад на его размер с зазором — ровно так же, как их двигает
   * предпросмотр (_shiftFlow), поэтому линия вставки и выбранный слот совпадают.
   *
   * Перенос строк и justify не start сюда не годятся: там слоты не идут подряд
   * и «ближайший» ничего не значит — для них остаётся правило по курсору
   * (соседей в таких раскладках мы и не раздвигаем, см. _shiftFlow).
   * @param {object} d жест @param {object} parent @param {object} L раскладка родителя
   * @param {string[]} ordered потоковые соседи без перетаскиваемого
   * @returns {number[]|null} начала слотов, по одному на каждое место вставки
   */
  _flowSlots(d, parent, L, ordered) {
    if (L.wrap || L.justify !== 'start') return null;
    const horiz = L.mode === 'row';
    const axis = horiz ? 'x' : 'y';
    const size = horiz ? 'w' : 'h';
    const rect = this.geo.rects[d.id] || d.rect0;
    const pr = this.geo.rects[parent.id];
    const cur = this._flowSiblings(parent, null).indexOf(d.id);
    const from = cur < 0 ? ordered.length : cur;   // блока в потоке нет — никто не съезжает
    const step = rect[size] + L.gap;
    const slots = [];
    for (let j = 0; j < ordered.length; j++) {
      const r = this.geo.rects[ordered[j]];
      if (!r) return null;
      slots.push(r[axis] - (j >= from ? step : 0));
    }
    // последний слот — за последним соседом; без соседей он же и единственный
    const last = ordered.length ? this.geo.rects[ordered[ordered.length - 1]] : null;
    slots.push(last
      ? slots[slots.length - 1] + last[size] + L.gap
      : (pr ? pr[axis] + (horiz ? L.padding.l : L.padding.t) : d.rect0[axis]));
    return slots;
  }

  /** Место вставки по курсору: для раскладок, где слоты не выкладываются подряд. */
  _pointerIndex(ordered, L, w) {
    const horiz = L.mode === 'row';
    const axis = horiz ? 'x' : 'y';
    const size = horiz ? 'w' : 'h';
    const pointer = horiz ? w.x : w.y;
    let i = 0;
    for (const id of ordered) {
      const r = this.geo.rects[id];
      if (r && pointer > r[axis] + r[size] / 2) i++;
    }
    return i;
  }

  _ghost(id, dx, dy) {
    const g = this._nodeEls.get(id);
    if (!g) return;
    const lv = this._localDelta(id, dx, dy);
    g.setAttribute('transform', `translate(${lv.x} ${lv.y})`);
    this._ghostEl = g;
    const r = this.geo.rects[id];
    if (r) this._drag.ghostRect = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  }

  _clearGhost() {
    if (this._ghostEl) { this._ghostEl.removeAttribute('transform'); this._ghostEl = null; }
  }

  /**
   * Раздвинуть поток под место вставки: соседи, которые при перестановке меняют
   * место, съезжают на размер перетаскиваемого узла вместе с зазором.
   *
   * Без этого предпросмотр врал: карточка плыла ПОВЕРХ соседа (сосед оставался
   * на y=336, а перетаскиваемое рисовалось на y=341 и накрывало его), и правду
   * говорила только тонкая линия вставки. Смещение считаем сами, а не решателем:
   * в потоке без переноса строк и с justify:start оно ровно ±(размер + зазор).
   * Там, где это не так (wrap, justify не start), соседей не двигаем — остаётся
   * линия вставки, она не соврёт.
   * @param {object} d жест
   * @param {object} parent родитель в потоке
   * @param {object} L нормализованная раскладка родителя
   * @param {string[]} ordered потоковые соседи без перетаскиваемого
   * @param {number} index место вставки в пространстве `ordered`
   */
  _shiftFlow(d, parent, L, ordered, index) {
    if (L.wrap || L.justify !== 'start') return;
    const rect = this.geo.rects[d.id];
    const pr = this.geo.rects[parent.id];
    if (!rect) return;
    const horiz = L.mode === 'row';
    const step = (horiz ? rect.w : rect.h) + L.gap;
    if (!(step > 0)) return;
    // место самого перетаскиваемого узла в полном потоке
    const cur = this._flowSiblings(parent, null).indexOf(d.id);
    if (cur < 0) return;
    // сосед уступает место (+шаг), если встаёт после вставки, и занимает
    // освободившееся (−шаг), если перетаскиваемый ушёл из-под него
    const shiftOf = (j) => ((index <= j && j < cur) ? step : (cur <= j && j < index) ? -step : 0);
    const moved = [];
    for (let j = 0; j < ordered.length; j++) {
      const by = shiftOf(j);
      if (!by) continue;
      const el = this._nodeEls.get(ordered[j]);
      if (!el) continue;
      el.setAttribute('transform', horiz ? `translate(${r2(by)} 0)` : `translate(0 ${r2(by)})`);
      moved.push(ordered[j]);
    }
    this._shifted = moved;
    // Линия вставки — по кромке РАЗДВИНУТОЙ щели: считанная по неподвинутому
    // соседу, она оказывалась под перетаскиваемой карточкой и читалась как
    // «карточка легла поверх соседа».
    const prev = index > 0 ? this.geo.rects[ordered[index - 1]] : null;
    let pos;
    if (prev) pos = (horiz ? prev.x + prev.w : prev.y + prev.h) + shiftOf(index - 1) + L.gap / 2;
    else if (pr) pos = horiz ? pr.x + L.padding.l : pr.y + L.padding.t;
    else return;
    // поперёк — по содержимому родителя: щель открылась во всю его ширину
    const c1 = pr ? (horiz ? pr.y + L.padding.t : pr.x + L.padding.l) : (horiz ? rect.y : rect.x);
    const c2 = pr ? (horiz ? pr.y + pr.h - L.padding.b : pr.x + pr.w - L.padding.r)
      : (horiz ? rect.y + rect.h : rect.x + rect.w);
    this._insertion = horiz
      ? { x1: pos, y1: c1, x2: pos, y2: c2 }
      : { x1: c1, y1: pos, x2: c2, y2: pos };
  }

  /** Вернуть раздвинутых соседей на свои места. */
  _clearShift() {
    if (!this._shifted || !this._shifted.length) return;
    for (const id of this._shifted) {
      const el = this._nodeEls.get(id);
      if (el) el.removeAttribute('transform');
    }
    this._shifted = [];
  }

  _updateResize(d, w, e) {
    const r0 = d.rect0;
    let ww = r0.w;
    let hh = r0.h;
    const dx = w.x - d.start.x;
    const dy = w.y - d.start.y;
    const h = d.handle;
    const alt = e.altKey;
    if (h.includes('e')) ww = r0.w + (alt ? dx * 2 : dx);
    if (h.includes('w')) ww = r0.w - (alt ? dx * 2 : dx);
    if (h.includes('s')) hh = r0.h + (alt ? dy * 2 : dy);
    if (h.includes('n')) hh = r0.h - (alt ? dy * 2 : dy);
    if (e.shiftKey && h.length === 2 && r0.h > 0) {
      const ratio = r0.w / r0.h;
      if (Math.abs(ww - r0.w) >= Math.abs(hh - r0.h)) hh = ww / ratio;
      else ww = hh * ratio;
    }
    // Размер — целые пиксели: дробный уезжал в size.value и потом мозолил глаз
    // в инспекторе («439.37 × 268.84») при целом числе на бейдже. Округляем сам
    // размер, а координату выводим из него, чтобы неподвижная кромка (или центр
    // при Alt) осталась точно на месте и узел не «плыл» на пиксель туда-сюда.
    const W = Math.max(1, Math.round(ww));
    const H = Math.max(1, Math.round(hh));
    let x = r0.x;
    let y = r0.y;
    if (alt) {
      if (h.includes('e') || h.includes('w')) x = r0.x + (r0.w - W) / 2;
      if (h.includes('n') || h.includes('s')) y = r0.y + (r0.h - H) / 2;
    } else {
      if (h.includes('w')) x = r0.x + r0.w - W;
      if (h.includes('n')) y = r0.y + r0.h - H;
    }
    d.preview = { x: r2(x), y: r2(y), w: W, h: H };
    d.resized = true;   // жест состоялся — теперь его есть что коммитить
  }

  _onPointerUp(e) {
    if (this._previewOn && this._ix.press.size) { this._ix.press = new Set(); this._syncStates(); }
    const d = this._drag;
    this._drag = null;
    this._cancelPreview();
    this.el.classList.remove('is-panning');
    this._guides = [];
    this._insertion = null;
    this._marquee = null;
    try {
      if (!d) { this._paintUI(); return; }
      if (d.mode === 'pan') {
        if (this.opts.onView) this.opts.onView({ zoom: this.view.zoom, pan: { ...this.view.pan } });
      } else if (d.mode === 'marquee' && isNum(e.clientX)) {
        const w = this.toWorld(e.clientX, e.clientY);
        const box = {
          x1: Math.min(d.start.x, w.x), y1: Math.min(d.start.y, w.y),
          x2: Math.max(d.start.x, w.x), y2: Math.max(d.start.y, w.y)
        };
        const merged = [...new Set((d.base || []).concat(this._marqueePick(box)))];
        if (merged.length || (d.base || []).length === 0) this._emitSelect(merged);
      } else if (d.mode === 'move' && d.result) {
        this._commitMove(d);
      } else if (d.mode === 'resize' && d.resized && d.preview) {
        this._dropPreview();   // коммит пойдёт от настоящего документа
        this._commitResize(d);
      } else if (d.mode === 'resize' && isNum(e.clientX)) {
        // нажатие на ручку, не ставшее жестом, доводим как обычный клик: зона
        // захвата выходит за кромку узла, и там может оказаться сосед. Но само
        // выделение при этом не теряем — см. _clickThrough(e, id)
        this._clickThrough(e, d.id);
      }
    } catch (err) {
      this._fail('pointerup', err);
    }
    this._dropPreview();   // если предпросмотр остался на сцене — возвращаем настоящий документ
    this._clearGhost();
    this._clearShift();
    this._paintUI();
  }

  /**
   * Довести нажатие как обычный клик по холсту. Зовётся, когда жест не состоялся:
   * нажали на ручку ресайза и отпустили, не сдвинувшись. Правило выбора — то же,
   * что в _onPointerDown, иначе клик по ручке и клик рядом с ней вели бы себя
   * по-разному.
   *
   * `keepId` — узел, за ручку которого держались. Зона захвата ручки выходит
   * наружу узла на 13 px (внутрь — только на HANDLE_IN), и видимая точка ручки
   * стоит ровно на кромке: три её четверти лежат ВНЕ узла. Пробрасывая клик
   * как есть, мы выделяли то, что там нашлось, — а находился почти всегда
   * предок (артборд) или пустой холст, и выделение уезжало с узла на «Маршрут
   * дня» либо снималось совсем. Поэтому пустое место и ПРЕДКА считаем промахом
   * по ручке и выделение сохраняем; настоящий сосед по-прежнему выделяется —
   * ради него проброс и сделан.
   * @param {PointerEvent} e
   * @param {string} [keepId]
   */
  _clickThrough(e, keepId) {
    // фокус холсту — как при обычном клике: нажатие на ручку его не забирало
    if (this.el && this.el.focus) this.el.focus({ preventScroll: true });
    const w = this.toWorld(e.clientX, e.clientY);
    const hit = this._hitTest(w, e.altKey || e.metaKey || e.ctrlKey);
    if (keepId && this._missedHandle(hit, keepId)) return;
    if (!hit) { if (!e.shiftKey) this._emitSelect([]); return; }
    const sel = (this.state.selection || []).slice();
    if (e.shiftKey) {
      this._emitSelect(sel.includes(hit.id) ? sel.filter((i) => i !== hit.id) : sel.concat(hit.id));
    } else if (!sel.includes(hit.id)) {
      this._emitSelect([hit.id]);
    }
    this._setActiveArtboardFor(hit.id);
  }

  /**
   * Промах по ручке: под курсором либо ничего, либо сам узел, либо его предок —
   * то есть ничего такого, за чем человек мог целиться, отпуская ручку.
   * @param {object|null} hit @param {string} id
   * @returns {boolean}
   */
  _missedHandle(hit, id) {
    if (!hit || hit.id === id) return true;
    for (const p of ancestors(this.doc, id)) if (p.id === hit.id) return true;
    return false;
  }

  _commitMove(d) {
    const doc = this.doc;
    const node = doc.nodes[d.id];
    if (!node) return;
    const res = d.result;
    const name = displayName(doc, node);
    if (res.kind === 'move') {
      const parentNode = doc.nodes[res.parent];
      if (!parentNode) return;
      // «порядок не изменился» сверяем в потоковом пространстве: в полном массиве
      // индекс сдвинут на каждого отсоединённого ребёнка левее цели, и сравнение
      // там то молча отменяло жест, то пропускало лишний
      const cur = this._flowSiblings(parentNode, null).indexOf(d.id);
      if (cur === res.index) { this._clearGhost(); return; }
      // перевод в полное пространство: ops.move вставляет в children без самого
      // узла — значит и место считаем в списке без него
      const ordered = this._flowSiblings(parentNode, d.id);
      const rest = (parentNode.children || []).filter((id) => id !== d.id);
      const at = res.index >= ordered.length ? rest.length : rest.indexOf(ordered[res.index]);
      this._commit([ops.move(d.id, res.parent, at < 0 ? rest.length : at)], `Переставить «${name}»`);
      return;
    }
    if (res.kind === 'pos-canvas') {
      this._commit([ops.set(d.id, 'pos', { x: r2(res.x), y: r2(res.y) })], `Сдвинуть «${name}»`);
      return;
    }
    const parent = ownNode(doc.nodes, node.parent);
    const pr = this.geo.rects[parent.id];
    if (!pr) return;
    if (res.kind === 'pos') {
      const L = resolveLayout(doc, parent.layout);
      this._commit([ops.set(d.id, 'pos', {
        x: r2(res.x - pr.x - L.padding.l), y: r2(res.y - pr.y - L.padding.t)
      })], `Сдвинуть «${name}»`);
    } else {
      const rect = this.geo.rects[d.id];
      this._commit([ops.set(d.id, 'override', {
        x: r2(res.x - pr.x), y: r2(res.y - pr.y), w: r2(rect.w), h: r2(rect.h)
      })], node.override ? `Сдвинуть «${name}»` : `Отсоединить «${name}»`);
    }
  }

  /**
   * Операции, которыми жест ресайза ложится в документ. Один код на предпросмотр
   * и на коммит — иначе живой предпросмотр показывал бы не то, что получится.
   * @returns {object[]}
   */
  _resizeOps(d) {
    const doc = this.doc;
    const node = doc && doc.nodes ? doc.nodes[d.id] : null;
    if (!node || !d.preview) return [];
    const p = d.preview;
    const list = [];
    if (node.override) {
      const parent = ownNode(doc.nodes, node.parent);
      const pr = (parent && this.geo.rects[parent.id]) || { x: 0, y: 0 };
      list.push(ops.set(d.id, 'override', { x: r2(p.x - pr.x), y: r2(p.y - pr.y), w: r2(p.w), h: r2(p.h) }));
    } else {
      // фиксируем только ту ось, за которую тянули. Раньше ставились обе, и жест
      // за одну кромку молча превращал `fill`/`hug` второй оси в `fixed`: на экране
      // в этот момент ничего не менялось, а макет ломался позже — при смене текста,
      // ширины артборда или отступов. `_updateResize` нетронутую ось и так не меняет,
      // так что писать её нечего. Углы (и Shift+угол) трогают обе — условия сойдутся сами.
      const h = (typeof d.handle === 'string' && d.handle) || 'nwse';   // ручка неизвестна — как раньше, обе оси
      if (h.includes('e') || h.includes('w')) list.push(ops.set(d.id, 'size.w', { mode: 'fixed', value: r2(p.w) }));
      if (h.includes('n') || h.includes('s')) list.push(ops.set(d.id, 'size.h', { mode: 'fixed', value: r2(p.h) }));
      const parent = ownNode(doc.nodes, node.parent);
      const moved = Math.abs(p.x - d.rect0.x) > 0.5 || Math.abs(p.y - d.rect0.y) > 0.5;
      if (moved && parent) {
        const pr = this.geo.rects[parent.id] || { x: 0, y: 0 };
        const L = resolveLayout(doc, parent.layout);
        if (parent.id === doc.root) list.push(ops.set(d.id, 'pos', { x: r2(p.x), y: r2(p.y) }));
        else if (L.mode === 'none') {
          list.push(ops.set(d.id, 'pos', { x: r2(p.x - pr.x - L.padding.l), y: r2(p.y - pr.y - L.padding.t) }));
        }
      }
    }
    return list;
  }

  _commitResize(d) {
    const node = this.doc.nodes[d.id];
    if (!node) return;
    const list = this._resizeOps(d);
    this._commit(list, `Размер «${displayName(this.doc, node)}»`);
  }

  /* --------------------- живой предпросмотр ресайза --------------------- */

  /** Опции решателя: если оболочка дала свой измеритель, считаем им же. */
  _solveOpts() {
    return typeof this.opts.measureText === 'function' ? { measureText: this.opts.measureText } : undefined;
  }

  /**
   * Пересчитать документ под текущий жест и перерисовать содержимое — один раз
   * за кадр. Решатель чистый, документ не меняется: применяем те же операции,
   * что уйдут в коммит, к копии и рисуем её. Так при растягивании фрейма
   * содержимое переливается сразу, а не после отпускания.
   */
  _schedulePreview() {
    if (this._dead || this._previewFrame) return;
    const run = () => { this._previewFrame = null; this._paintPreview(); };
    if (typeof requestAnimationFrame === 'function') this._previewFrame = requestAnimationFrame(run);
    else run();
  }

  /** Снять запланированный кадр предпросмотра. */
  _cancelPreview() {
    if (this._previewFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._previewFrame);
    this._previewFrame = null;
  }

  /** Вернуть на сцену настоящий документ, если на ней висит предпросмотр. */
  _dropPreview() {
    this._cancelPreview();
    if (!this._preview) return;
    this._preview = null;
    // _renderSVG собирает подписи артбордов заново, с кеглем в мировых единицах;
    // приводит их к экрану (и решает, прятать ли) только _applyView — без него
    // font-size скакал 20,09 → 11 → 20,09 на каждом жесте
    if (!this._dead && this.doc) { this._renderSVG(); this._applyView(); }
  }

  _paintPreview() {
    const d = this._drag;
    if (this._dead || !d || d.mode !== 'resize' || !this.doc) return;
    try {
      const list = this._resizeOps(d);
      if (!list.length) return;
      const res = applyOps(this.doc, list);
      if (!res || res.error || res.doc === this.doc) return;
      const geo = solve(res.doc, this._solveOpts());
      // подменяем сцене документ только на время отрисовки: жест считается от
      // настоящей геометрии, и _syncGesture не должен увидеть чужие числа
      const realDoc = this.doc;
      const realGeo = this.geo;
      this.doc = res.doc;
      this.geo = geo;
      try { this._renderSVG(); } finally { this.doc = realDoc; this.geo = realGeo; }
      this._applyView();   // подписи артбордов — в экранном кегле, см. _dropPreview
      this._preview = { id: d.id, version: res.doc.version };
    } catch (e) {
      this._preview = null;
      this._fail('preview', e);
    }
  }

  /* --------------------------- инлайн-правка текста --------------------------- */

  /**
   * Двойной клик. SPEC §1.5 обещает «двойной клик по тексту — инлайн-правка»,
   * поэтому сначала смотрим, текст ли под курсором самый глубокий узел: если да,
   * правку открываем сразу. Раньше двойной клик просто опускался на один уровень
   * за раз, и по замеру демо-документа с первого раза открывался один текст из
   * 49, а 36 — только с третьего. Пошаговое углубление осталось за Alt и
   * Cmd/Ctrl-кликом и за двойным кликом по нетекстовому узлу.
   */
  _onDblClick(e) {
    if (this._previewOn) return;   // круг 36: в просмотре правки текста нет
    const w = this.toWorld(e.clientX, e.clientY);
    const deep = this._topUnder(w);
    const hit = (deep && deep.type === 'text') ? deep : this._hitTest(w, true);
    if (!hit) return;
    this._emitSelect([hit.id]);
    this._setActiveArtboardFor(hit.id);
    if (hit.type === 'text') this._startEdit(hit);
  }

  _positionEditor() {
    const ed = this._editing;
    if (!ed) return;
    const sr = this._screenRect(ed.id);
    if (!sr) return;
    if (ed.hint) {
      // над верхней кромкой: редактор растёт вниз по мере набора и подсказку
      // под собой похоронил бы. Если сверху нет места — уводим под нижнюю.
      // Высота у подсказки та же, что у бейджа: 10px/1.3 плюс отбивки 2+2
      const hw = editHintWidth();
      const vw = this.el && (this._vp || isNum(this.el.clientWidth)) ? this.vw : Infinity;
      const above = sr.y - BADGE_H - 3;
      const y = above >= 2 ? above : sr.y + sr.h + 3;
      ed.hint.style.left = r2(clamp(sr.x, 2, Math.max(2, vw - hw - 2))) + 'px';
      ed.hint.style.top = r2(y) + 'px';
    }
    const node = this.doc.nodes[ed.id];
    const tdoc = this._td(ed.id);
    const style = resolveTextStyle(tdoc, node);
    const z = this.view.zoom;
    Object.assign(ed.el.style, {
      left: r2(sr.x) + 'px', top: r2(sr.y) + 'px',
      minWidth: r2(Math.max(24, sr.w)) + 'px', minHeight: r2(sr.h) + 'px',
      fontFamily: style.fontFamily,
      fontSize: r2(style.fontSize * z) + 'px',
      fontWeight: String(style.fontWeight),
      lineHeight: r2(style.lineHeight * z) + 'px',
      letterSpacing: r2((style.letterSpacing || 0) * z) + 'px',
      color: resolveColor(tdoc, node.color) || '#14161C',
      textAlign: node.align === 'center' ? 'center' : node.align === 'right' ? 'right' : 'left'
    });
  }

  /**
   * Открыть правку текста поверх узла.
   *
   * «Готово» — это Enter: он применяет правку (Shift+Enter переносит строку,
   * Ctrl/Cmd+Enter оставлен прошлым кругам). Esc отменяет и в историю не пишет —
   * поэтому об обеих клавишах сказано заранее, подписью у редактора: раньше
   * голый Enter не делал ничего, а Esc молча стирал набранное.
   *
   * Уход фокуса за пределы редактора — тоже «готово». Щёлкнув в командную
   * строку, человек оставлял на макете висящее поле ввода, а правка ждала
   * возврата на холст: коммит случался только по нажатию в самой сцене.
   */
  _startEdit(node) {
    if (this._editing) this._commitEdit();
    const el = document.createElement('div');
    el.className = 'imago-editor';
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.textContent = textOf(node.characters);
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // набор через IME: Enter подтверждает подсказку словаря, а не правку
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); this._cancelEdit(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._commitEdit(); }
    });
    el.addEventListener('focusout', (e) => {
      // редактор уже закрыт (или закрывается) — коммитить нечего
      if (!this._editing || this._editing.el !== el) return;
      const to = e && e.relatedTarget;
      if (to && (to === el || (el.contains && el.contains(to)))) return;   // фокус остался внутри
      this._commitEdit();
    });
    const hint = document.createElement('div');
    hint.className = 'imago-editor-hint';
    hint.textContent = EDIT_HINT;
    this.ui.appendChild(el);
    this.ui.appendChild(hint);
    this._editing = { id: node.id, el, hint, original: textOf(node.characters) };
    this._positionEditor();
    el.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* выделение не критично */ }
  }

  _closeEditor() {
    const ed = this._editing;
    this._editing = null;
    if (ed && ed.el.parentNode) ed.el.parentNode.removeChild(ed.el);
    if (ed && ed.hint && ed.hint.parentNode) ed.hint.parentNode.removeChild(ed.hint);
    this.el.focus({ preventScroll: true });
    return ed;
  }

  _cancelEdit() { this._closeEditor(); this._paintUI(); }

  _commitEdit() {
    const ed = this._editing;
    if (!ed) return;
    const raw = (ed.el.innerText || '').replace(/\r/g, '').replace(/\n+$/, '');
    // Неразрывные пробелы. contenteditable ставит их сам — но только там, где
    // обычный пробел схлопнулся бы: в конце строки и вторым подряд. Вот такие и
    // возвращаем в обычные: человек набирал именно пробел. А стоящий между
    // словами и цифрами оставляем как есть — там он осмысленный («1 240 ₽»),
    // и правка съедала его молча: потерю замечали потом, по переносу строки в
    // неудачном месте.
    const value = raw.replace(/\u00a0/g, (m, i, str) => {
      const prev = str[i - 1];
      const next = str[i + 1];
      const edge = prev === undefined || next === undefined || prev === '\n' || next === '\n';
      const twin = prev === ' ' || next === ' ' || prev === '\u00a0' || next === '\u00a0';
      return edge || twin ? ' ' : '\u00a0';
    });
    this._closeEditor();
    const node = this.doc && this.doc.nodes ? this.doc.nodes[ed.id] : null;
    if (!node) {
      // узел исчез между открытием редактора и коммитом: писать некуда
      logOnce('stage:edit-lost', `Stage: узел «${ed.id}» не найден — правка текста отброшена`);
      this._paintUI();
      return;
    }
    if (value !== ed.original) {
      this._commit([ops.set(ed.id, 'characters', value)], `Текст «${displayName(this.doc, node)}»`);
    }
    this._paintUI();
  }

  /* ------------------------------ клавиатура ------------------------------ */

  _onKey(e) {
    const t = e.target;
    const inEditor = this._editing && (t === this._editing.el || (this._editing.el.contains && this._editing.el.contains(t)));
    if (!inEditor && t && t.closest && t.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (inEditor) return; // редактор обрабатывает свои клавиши сам
    if (this._previewOn && this._previewKey(e)) return;   // круг 36
    const meta = e.ctrlKey || e.metaKey;
    const sel = (this.state.selection || []).filter((id) => this.doc && this.doc.nodes[id]);
    if (e.code === 'Space' && !meta) {
      this._space = true;
      this.el.classList.add('is-space');
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (this._editing) this._cancelEdit();
      else this._emitSelect([]);
      return;
    }
    if (meta && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) {
      e.preventDefault();
      const fn = e.shiftKey ? this.opts.onRedo : this.opts.onUndo;
      if (fn) { try { fn(); } catch (err) { this._fail('undo', err); } }
      else logOnce('stage:noundo', 'Stage: opts.onUndo/onRedo не заданы');
      return;
    }
    if (meta && (e.key === 'd' || e.code === 'KeyD')) { e.preventDefault(); this._duplicate(sel); return; }
    if (meta && (e.key === 'a' || e.code === 'KeyA')) {
      e.preventDefault();
      // тем же правилом, что и рамка: рамка «во весь мир». Так «выделить всё»
      // и рамка выбора всегда дают согласованное множество — без предков
      // вместе с потомками и без скрытых/запертых узлов
      this._emitSelect(this._marqueePick({ x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity }));
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
      e.preventDefault();
      const roots = sel.filter((id) => !ancestors(this.doc, id).some((a) => sel.includes(a.id)));
      this._commit(roots.map((id) => ops.remove(id)), roots.length > 1 ? 'Удалить узлы' : 'Удалить узел');
      this._emitSelect([]);
      return;
    }
    if (e.key === 'Enter' && sel.length === 1) {
      const node = this.doc.nodes[sel[0]];
      if (node && node.type === 'text') { e.preventDefault(); this._startEdit(node); return; }
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && sel.length) {
      e.preventDefault();
      const k = e.shiftKey ? 10 : 1;
      const dx = arrows[e.key][0] * k;
      const dy = arrows[e.key][1] * k;
      const list = [];
      // без spread: он здесь короткий (операция на узел), но это та же привычка,
      // которой мы уже роняли стек на большом выделении
      for (const id of sel) for (const op of this._nudgeOps(id, dx, dy)) list.push(op);
      this._commit(list, 'Сдвиг стрелками');
    }
  }

  _nudgeOps(id, dx, dy) {
    const doc = this.doc;
    const node = doc.nodes[id];
    if (!node) return [];
    const parent = ownNode(doc.nodes, node.parent);
    if (!parent || parent.id === doc.root) {
      const pos = nodePos(node);
      return [ops.set(id, 'pos', { x: r2(pos.x + dx), y: r2(pos.y + dy) })];
    }
    if (node.override) {
      const o = node.override;
      return [ops.set(id, 'override', { ...o, x: r2(o.x + dx), y: r2(o.y + dy) })];
    }
    const L = resolveLayout(doc, parent.layout);
    if (L.mode === 'none') {
      const pos = nodePos(node);
      return [ops.set(id, 'pos', { x: r2(pos.x + dx), y: r2(pos.y + dy) })];
    }
    const rect = this.geo.rects[id];
    const pr = this.geo.rects[parent.id];
    if (!rect || !pr) return [];
    return [ops.set(id, 'override', {
      x: r2(rect.x - pr.x + dx), y: r2(rect.y - pr.y + dy), w: r2(rect.w), h: r2(rect.h)
    })];
  }

  /**
   * ⌘/Ctrl+D на холсте. Круг 39 (N3): та же единственная реализация, что у
   * команды таблицы оболочки, — duplicateOps (ссылки пропсов, копия мастера,
   * «родитель + ребёнок», сдвиг в свободной рамке). Оболочка может перехватить
   * клавишу сама (opts.onDuplicate) — тогда подпись и слова итога её.
   */
  _duplicate(sel) {
    if (!sel.length) return;
    if (typeof this.opts.onDuplicate === 'function') {
      try { this.opts.onDuplicate(sel.slice()); } catch (err) { this._fail('duplicate', err); }
      return;
    }
    const r = duplicateOps(this.doc, sel);
    if (r.error || !r.ops.length) return;
    this._commit(r.ops, r.roots.length > 1 ? 'Дублировать слои' : 'Дублировать слой');
    if (r.ids.length) this._emitSelect(r.ids);
  }
}

/** Снимок для критика (круг 47): ширина до 768 px, высота до 1536 px — дальше верх доски. */
const SHOT_CRITIC_W = 768;
const SHOT_CRITIC_H = 1536;

/** Сцена без страницы: поля, которые читает путь toSVG, и ничего больше. */
function headlessStage(doc, geo, id, embedFonts) {
  const st = Object.create(Stage.prototype);
  return Object.assign(st, {
    opts: { embedFonts: !!embedFonts }, host: null, doc, geo, state: { selection: [] },
    view: { zoom: 1, pan: { x: 0, y: 0 } }, activeArtboard: id,
    _srcMap: null, _clipSeq: 0, _clipPrefix: newClipPrefix(), _drawSeen: new Set(),
    _timers: new Set(), _dead: false, _nodeEls: new Map(),
  });
}

/**
 * Круг 47 (SPEC §14.4): SVG доски без страницы — та же отрисовка, что у `Stage.toSVG`,
 * только элементы — в памяти (см. memDom). Синхронно и без сети. Гарнитуры по умолчанию
 * не встраиваются (рендер PNG на сервере подаёт файлы шрифтов сам, их имена — в
 * `families`); `fonts: true` встраивает то, что уже лежит в кеше экспорта.
 * @param {object} doc
 * @param {string} artboardId доска (или любой узел, у которого есть геометрия)
 * @param {{geo?:object, measureText?:Function, fonts?:boolean, srcMap?:Map, maxHeight?:number, externalImages?:'placeholder'}} [opts]
 *   maxHeight — верх доски (`cropped`); externalImages 'placeholder' — внешние картинки плашкой (`placeholders`)
 * @returns {{svg:string, width:number, height:number, fullHeight:number, cropped:boolean, families:string[], weights:object, placeholders:number}|null} null — рисовать нечего
 */
function renderSVG(doc, artboardId, opts = {}) {
  if (!doc || !doc.nodes || typeof artboardId !== 'string') return null;
  const geo = opts.geo && opts.geo.rects ? opts.geo
    : solve(doc, typeof opts.measureText === 'function' ? { measureText: opts.measureText } : undefined);
  const rect = geo.rects[artboardId];
  if (!rect) return null;
  const st = headlessStage(doc, geo, artboardId, !!opts.fonts);
  if (opts.externalImages === 'placeholder') st._noExternal = true;
  const prev = svgDom;
  svgDom = memDom;
  try {
    let svg = st.toSVG(artboardId, doc, geo, { fonts: !!opts.fonts, srcMap: opts.srcMap instanceof Map ? opts.srcMap : undefined });
    if (!svg) return null;
    let families = [];
    let weights = {};
    try {
      const needs = st._fontNeeds(artboardId);
      families = [...needs.keys()];
      for (const [f, rec] of needs) weights[f] = [...rec.weights].sort((a, b) => a - b);
    } catch { families = []; weights = {}; }
    // круг 47: высокая доска — верх до maxHeight (снимок 390×6000 иначе сжимался в полоску)
    let height = r2(rect.h);
    let cropped = false;
    if (isNum(opts.maxHeight) && opts.maxHeight > 0 && rect.h > opts.maxHeight) {
      height = r2(opts.maxHeight);
      cropped = true;
      const W = r2(rect.w);
      svg = svg.replace(/<svg ([^>]*?)height="[^"]*"([^>]*?)viewBox="0 0 [^ "]+ [^"]+"/, `<svg $1height="${height}"$2viewBox="0 0 ${W} ${height}"`);
    }
    return { svg, width: r2(rect.w), height, fullHeight: r2(rect.h), cropped, families, weights, placeholders: st._placeholders || 0 };
  } finally {
    svgDom = prev;
  }
}

/**
 * Круг 47 (SPEC §14.4): PNG доски в браузере — для критика агента, которому нужен снимок
 * ещё не применённой правки (черновика), а не того, что на холсте. Гарнитуры тянутся в кеш
 * экспорта и встраиваются; сторона снимка — не больше maxSide.
 * @param {object} doc @param {string} artboardId
 * @param {{geo?:object, maxSide?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{mime:string, data:string, width:number, height:number}|null>} data — base64 без префикса
 */
async function boardPNG(doc, artboardId, opts = {}) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const geo = opts.geo && opts.geo.rects ? opts.geo : solve(doc);
  const rect = geo.rects[artboardId];
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
  // круг 50: opts.fonts === false — шрифты из сети выключены: снимок без загрузки гарнитур
  const hs = headlessStage(doc, geo, artboardId, opts.fonts !== false);
  if (opts.fonts !== false) { try { await hs.prepareFonts(artboardId); } catch (e) { /* без гарнитур — системным */ } }
  // внешние картинки — в data: (SVG внутри <img> чужие адреса не грузит); не вышло — без них
  let srcMap;
  try { const ext = hs._externalImages(artboardId); if (ext.length) srcMap = await inlineImageSrcs(ext); } catch (e) { srcMap = undefined; }
  const maxW = isNum(opts.maxWidth) && opts.maxWidth > 0 ? opts.maxWidth : SHOT_CRITIC_W;
  const k = Math.min(1, maxW / rect.w);
  const maxH = (isNum(opts.maxHeight) && opts.maxHeight > 0 ? opts.maxHeight : SHOT_CRITIC_H) / k;
  const out = renderSVG(doc, artboardId, { geo, fonts: opts.fonts !== false, srcMap, maxHeight: maxH });
  if (!out) return null;
  const W = Math.max(1, Math.round(out.width * k));
  const H = Math.max(1, Math.round(out.height * k));
  const url = URL.createObjectURL(new Blob([out.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('снимок не загрузился')), isNum(opts.timeoutMs) ? opts.timeoutMs : 8000);
      img.onload = () => { clearTimeout(t); resolve(); };
      img.onerror = () => { clearTimeout(t); reject(new Error('снимок не разобрался')); };
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    return comma > 0 ? { mime: 'image/png', data: dataUrl.slice(comma + 1), width: W, height: H, cropped: out.cropped, shownHeight: out.height, fullHeight: out.fullHeight } : null;
  } catch (e) {
    logOnce('boardPNG', 'снимок доски для критика не получился', e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export {
  createDoc, applyOps, invertOps, solve, validate, Stage, ops,
  /* Круг 47 (SPEC §14.4): SVG доски без страницы — снимок для критика агента — */
  renderSVG, boardPNG, solveAfter, solveCarry, solveShapeCopies,
  /* Круг 31 (K1): большая отмена/правка — пачками в пределах транзакции — */
  splitOps, SPLIT_MAX_OPS, SPLIT_MAX_BYTES,
  /* Круг 22 (SPEC §8.3, §9.6): версия формата, слияние, надгробия, хэш документа — */
  ENGINE_VERSION, rebase, collectTombstones, hashDoc, uid,
  /* Круг 39 (N1): какие версии движка этот читает — */
  ENGINE_MIN_READ, engineReadable,
  /* Круг 43: отпечаток формата — тест держит правило «формат — только с ENGINE_VERSION» — */
  formatSignature, FORMAT_SIGNATURE, formatBehavior,
  /* Круг 25: строки для документа и журнала — обрезка по кодовым точкам, санитайзер;
     годность id узла (непустая строка, не ключ Object.prototype) — */
  cutText, cleanText, isNodeId,
  /* хвост журнала одним черновиком: applyOps + collectTombstones на каждую пачку — */
  applyBatches,
  /* Круг 27: надгробия v1/v2/«неизвестно» → {parents, seq}, прореживание по номеру
     удаления; чистка ключа (общая для сервера и реплики); предел вложенности — */
  normalizeTombstones, pruneTombstones, cleanKey, MAX_DEPTH,
  /* Круг 29: строгая проверка чужого документа перед импортом (J7) и предел узлов
     по умолчанию; форма поля узла — та же, что в checkNode (оболочке и мозгу) — */
  checkImportDoc, MAX_IMPORT_NODES, fieldProblem,
  resetMeasureCache, measureEpoch, onMeasureEpoch,
  hashGeometry, nodeById, ancestors, isArtboard, artboards, subtreeIds, cloneSubtree,
  resolveTarget, resolveColor, resolveTextStyle, contrastRatio, sizeSpec, normalizeLayout,
  /* Круг 48 (SPEC §15): тема доски */
  themeProblem, themedDoc, docAt, themeScope, boardOf, boardTheme, THEME_LIMITS, liftOps,
  placeholderName, displayName,
  /* Круг 39 (N3): дублирование — одна реализация на оболочку и холст — */
  duplicateOps, DUPLICATE_OFFSET,
  NODE_TYPES, DEFAULT_TOKENS,
  /* Круг 19 (SPEC §5): компоненты. Библиотека и миграция — */
  isLibrary, libraryId, libraryNode, ensureLibrary, ensureLibraryOps,
  /* словарь компонентов (мозгу и оболочке) — */
  components, componentSignature, instanceSummary, isMaster, masterOf, componentName,
  /* правки (возвращают ОПЕРАЦИИ, документ не меняют) — */
  canMakeComponent, makeComponentOps, instanceOps, detachInstanceOps,
  /* раскрытие и пределы — */
  expandInstance, expandDoc, MAX_INSTANCE_DEPTH, PROP_KINDS, LIBRARY_ROLE,
  /* Круг 39 (N2): стоимость раскрытия (линейно, без раскрытия) и её предел на документ — */
  expandCost, expandProblem, MAX_EXPANDED_NODES, DEGRADED_INSTANCE_NODES, EXPAND_LIMIT,
  /* Круг 20 (SPEC §6): шкалы как ссылки. Разрешение — ЕДИНСТВЕННЫЙ способ
     прочитать отступ или скругление числом (мозгу, оболочке, экспорту) — */
  resolveScale, resolveLayout, resolveRadius,
  /* ссылка как значение: разбор, проверка, сборка, поиск шага по числу — */
  parseScaleRef, isScaleRef, scaleRef, scaleIndexOf, scaleSteps, SCALE_NAMES,
  /* «то же самое» — правило формы поля, которое мозг зеркалит (§6.4) — */
  keepFieldForm,
  /* миграция (§6.5), перечень ссылок и правки шкалы со сдвигом (§6.1) — */
  ensureScaleRefs, ensureScaleRefsOps, scaleRefsIn, rewriteScaleRefsOps, insertScaleStep,
  /* Круг 36 (SPEC §11): микроанимации — умолчания ядра, разрешение ссылок и
     состояний в значения отрисовки (сцене, экспорту, мозгу, инспектору) — */
  DEFAULT_MOTION, DEFAULT_SHADOW, EASINGS, STATE_NAMES, STATE_KEYS, STATE_LIMITS, MOTION_SLOW_MS,
  resolveMotion, resolveState, resolveShadow, motionScale, parseShadow, hasStates, transitionCss,
  /* Круг 37 (SPEC §12): векторные иллюстрации — разбор и геометрия путей, краски
     с градиентами, сводка вектора, свободная рамка, пример иллюстрации — */
  parsePath, formatPath, pathBounds, fitVector, translatePath, resolvePaint, paintCss, paintProblem,
  vectorSummary, isFreeFrame, sampleIllustration, VECTOR_LIMITS, GRADIENT_KINDS,
  /* Круг 49 (SPEC §16): фактуры */
  PATTERN_KINDS, PATTERN_LIMITS, patternProblem, patternTile, isPatternPaint,
  /* Круг 39: кеш проверки путей с пределом по памяти — */
  pathCacheStats, PATH_CACHE_CHARS
};
