/**
 * Imago Studio — длинные задачи: сценарий из многих экранов одной командой (круг 110, SPEC §25).
 *
 * «Сделай полный воркфлоу игрового сценария» — агент не собирает один экран, а раскладывает
 * сценарий целиком, как флоу в Figma: план сценария (экраны и переходы) → каждый экран своей
 * доской → доски по колонкам шагов → стрелки переходов. Здесь — чистые части без модели и без
 * DOM: распознавание просьбы, схема и промпт плана, разбор ответа, бриф экрана, раскладка
 * досок и переходы. Сам прогон (вызовы модели, сборка экранов) — `runFlowCore` в brain.js.
 *
 * Переход хранится полем доски `flow: [{to, label?, from?}]` (простые данные, формат движка
 * их уже принимает — ENGINE_VERSION не меняется): `to` — id доски, куда ведёт переход,
 * `label` — что делает человек («Нажал «Играть»»), `from` — id слоя на этой доске, с которого
 * переход начинается (кнопка). Стрелки рисует сцена (core.js, `boardFlow`).
 */

/** Пределы сценария: экранов, переходов, длина строк, зазоры раскладки (px холста). */
export const FLOW_LIMITS = Object.freeze({
  minScreens: 2,
  maxScreens: 12,
  maxLinks: 40,
  name: 60,
  purpose: 400,
  label: 60,
  gapX: 320,
  gapY: 200,
  /** отступ сценария от уже лежащих на холсте досок */
  offset: 400,
});

/** Размер экрана по умолчанию — телефон. */
export const FLOW_DEVICE = Object.freeze({ w: 390, h: 844 });

const NB = '(?<![\\p{L}\\p{N}])';
const rxu = (src) => new RegExp(src, 'iu');

/** Глагол построения: без него «покажи сценарий» — не просьба собрать. */
const RE_BUILD = rxu(`${NB}(сделай|сделать|собери|собрать|построй|построить|создай|создать|нарисуй|нарисовать|спроектируй|спроектировать|придумай|разверни|развернуть|набросай|сверстай|св[её]рстай|продумай|распиши|подготовь|сгенерируй|design|build|make|create)`);
/** Сам сценарий: воркфлоу, флоу, сценарий, путь пользователя, прототип, развёртка. */
const RE_FLOW_NOUN = rxu(`${NB}(воркфло[уy]|в[её]ркфло[уy]|workflow|флоу|flow|юзер[- ]?флоу|user[- ]?flow|сценари[йяюеи]|пут[ьи]\\s+(пользователя|игрока|клиента|покупателя)|customer\\s+journey|cjm|прототип|разв[её]ртк[уаи])`);
/** «из шести экранов», «5 экранов» — тоже сценарий, если экранов три и больше. */
const NUM_WORDS = {
  три: 3, четыр: 4, пят: 5, шест: 6, сем: 7, восем: 8, девят: 9, десят: 10, одиннадцат: 11, двенадцат: 12,
};
const RE_SCREENS_COUNT = rxu(`${NB}(\\d{1,2}|три|четыр\\p{L}*|пят\\p{L}*|шест\\p{L}*|сем\\p{L}*|восем\\p{L}*|девят\\p{L}*|десят\\p{L}*|одиннадцат\\p{L}*|двенадцат\\p{L}*)\\s+(экран|страниц|окон|шаг)`);
/** Вопрос, а не просьба: «что такое флоу?», «как устроен сценарий?» */
const RE_QUESTION = rxu(`^\\s*(что|как|почему|зачем|какой|какие|сколько|где|можно\\s+ли)${'(?![\\p{L}])'}`);

function countOf(word) {
  const w = String(word || '').toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  for (const [stem, n] of Object.entries(NUM_WORDS)) if (w.startsWith(stem)) return n;
  return 0;
}

/**
 * Просьба о сценарии из многих экранов? → null | {screens?: число экранов, если названо}.
 * Без глагола построения — нет («покажи сценарий»); вопрос — нет; «N экранов» — только N ≥ 3.
 */
export function recognizeFlow(utterance) {
  const s = String(utterance == null ? '' : utterance).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 2000) return null;
  if (RE_QUESTION.test(s) || /\?\s*$/.test(s)) return null;
  if (!RE_BUILD.test(s)) return null;
  const m = RE_SCREENS_COUNT.exec(s);
  const n = m ? countOf(m[1]) : 0;
  if (RE_FLOW_NOUN.test(s)) return n >= FLOW_LIMITS.minScreens ? { screens: Math.min(n, FLOW_LIMITS.maxScreens) } : {};
  if (n >= 3) return { screens: Math.min(n, FLOW_LIMITS.maxScreens) };
  return null;
}

/** Схема плана сценария (для провайдера и заглушки — имя "flow"). */
export const SCHEMA_FLOW = Object.freeze({
  name: 'flow',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      device: { type: 'string', enum: ['mobile', 'tablet', 'desktop'] },
      screens: {
        type: 'array', minItems: 2, maxItems: FLOW_LIMITS.maxScreens,
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, name: { type: 'string' }, purpose: { type: 'string' } },
          required: ['key', 'name', 'purpose'],
        },
      },
      links: {
        type: 'array', maxItems: FLOW_LIMITS.maxLinks,
        items: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' }, trigger: { type: 'string' } },
          required: ['from', 'to', 'trigger'],
        },
      },
      cannot: { type: 'string' },
    },
    required: ['title', 'screens', 'links'],
  },
  hint: '{ title: string, summary?: string, device?: "mobile"|"tablet"|"desktop", '
    + 'screens: [{ key: string (латиницей, уникальный), name: string (имя экрана по-русски), purpose: string (что на экране и зачем, 1-3 предложения) }], '
    + 'links: [{ from: key, to: key, trigger: string (что делает человек: «Нажал «Играть»») }], cannot?: string }',
  example: {
    title: 'Игра: от запуска до награды',
    summary: 'Заставка, меню, выбор уровня, игра, пауза, победа и поражение',
    device: 'mobile',
    screens: [
      { key: 'splash', name: 'Заставка', purpose: 'Логотип игры и полоса загрузки.' },
      { key: 'menu', name: 'Главное меню', purpose: 'Кнопки «Играть», «Настройки», счёт монет.' },
      { key: 'level', name: 'Выбор уровня', purpose: 'Сетка уровней со звёздами, закрытые — с замком.' },
    ],
    links: [
      { from: 'splash', to: 'menu', trigger: 'Загрузка закончилась' },
      { from: 'menu', to: 'level', trigger: 'Нажал «Играть»' },
      { from: 'level', to: 'menu', trigger: 'Нажал «Назад»' },
    ],
  },
});

/**
 * Промпт плана сценария. ctx: {screens?: сколько просили, existing: имена уже лежащих досок,
 * history?: строка памяти разговора}.
 */
export function flowPrompt(ctx = {}) {
  const want = ctx.screens ? `Человек назвал число экранов — ${ctx.screens}: столько и сделай.`
    : `Экранов столько, сколько нужно сценарию целиком (обычно 5–${FLOW_LIMITS.maxScreens}), но не больше ${FLOW_LIMITS.maxScreens}.`;
  return [
    'Ты — продуктовый дизайнер. Человек просит не один экран, а СЦЕНАРИЙ целиком — флоу, как в Figma:',
    'все экраны пути пользователя и переходы между ними. Составь план сценария.',
    '',
    'ПРАВИЛА',
    `- ${want}`,
    '- Первый экран в списке — вход в сценарий (с него начинается путь). Дальше — в порядке пути.',
    '- Покрой сценарий ПОЛНОСТЬЮ: основной путь, ветки (ошибка, пусто, отказ, повтор, пауза), возвраты назад.',
    '- У каждого экрана — короткое имя по-русски (2–3 слова) и purpose: что на нём лежит (блоки, кнопки,',
    '  данные) и зачем он; кнопки и действия, ведущие на другие экраны, назови в purpose словами из trigger.',
    '- links — переходы: from и to — key экранов из screens, trigger — что делает человек или что',
    '  случается («Нажал «Играть»», «Время вышло»). Из каждого экрана, кроме конечных, хотя бы один переход;',
    '  в каждый экран, кроме первого, — хотя бы один.',
    '- device — устройство сценария: mobile (по умолчанию), tablet или desktop.',
    '- Если просьба вовсе не про экраны интерфейса — верни cannot с объяснением и пустые screens/links.',
    ctx.existing ? `\nНа холсте уже есть доски: ${ctx.existing}. Новые экраны не должны их повторять.` : '',
    ctx.history ? `\nРАЗГОВОР ДО ЭТОГО\n${ctx.history}` : '',
  ].filter((x) => x !== '').join('\n');
}

const str = (v, max) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};
const keyOf = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Размер экрана по устройству плана. */
export function flowDevice(device) {
  if (device === 'desktop') return { w: 1440, h: 900 };
  if (device === 'tablet') return { w: 834, h: 1194 };
  return { ...FLOW_DEVICE };
}

/**
 * Ответ модели → план сценария или null (экранов меньше двух). Ключи — уникальные; переходы на
 * незнакомые ключи, в себя и повторы — выброшены; заметки о выброшенном — в notes.
 * @param {object} raw
 * @param {{screens?: number}} [o] — сколько просил человек (лишние экраны срезаются)
 */
export function normalizeFlow(raw, o = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const notes = [];
  const max = Math.min(FLOW_LIMITS.maxScreens, o.screens > 0 ? o.screens : FLOW_LIMITS.maxScreens);
  const screens = [];
  const seen = new Set();
  const names = new Set();
  for (const s of Array.isArray(raw.screens) ? raw.screens : []) {
    if (!s || typeof s !== 'object') continue;
    const name = str(s.name, FLOW_LIMITS.name);
    if (!name) continue;
    let key = keyOf(s.key) || keyOf(name) || `s${screens.length + 1}`;
    while (seen.has(key)) key = `${key}-2`;
    if (names.has(name.toLowerCase())) { notes.push(`экран «${name}» повторялся — оставил один`); continue; }
    if (screens.length >= max) { notes.push(`экранов больше ${max} — «${name}» и дальше не собираю`); break; }
    seen.add(key);
    names.add(name.toLowerCase());
    // ключ модели — для переходов; держим и исходный, и приведённый
    screens.push({ key, raw: String(s.key == null ? '' : s.key).trim(), name, purpose: str(s.purpose, FLOW_LIMITS.purpose) || name });
  }
  if (screens.length < FLOW_LIMITS.minScreens) return null;
  const byKey = new Map();
  for (const s of screens) {
    byKey.set(s.key, s);
    // повторённый ключ модели — за первым экраном с ним
    if (s.raw && !byKey.has(s.raw)) byKey.set(s.raw, s);
    if (!byKey.has(s.name.toLowerCase())) byKey.set(s.name.toLowerCase(), s);
  }
  const find = (k) => byKey.get(String(k == null ? '' : k).trim()) || byKey.get(keyOf(k)) || byKey.get(String(k || '').trim().toLowerCase()) || null;
  const links = [];
  const pairs = new Set();
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!l || typeof l !== 'object') continue;
    const a = find(l.from);
    const b = find(l.to);
    if (!a || !b) { if (l.from || l.to) notes.push(`переход «${str(l.from, 30)} → ${str(l.to, 30)}» ведёт на экран не из плана — пропущен`); continue; }
    if (a === b) continue;
    const label = str(l.trigger || l.label, FLOW_LIMITS.label);
    const sig = `${a.key}>${b.key}>${label.toLowerCase()}`;
    if (pairs.has(sig)) continue;
    if (links.length >= FLOW_LIMITS.maxLinks) { notes.push(`переходов больше ${FLOW_LIMITS.maxLinks} — лишние пропущены`); break; }
    pairs.add(sig);
    links.push({ from: a.key, to: b.key, label });
  }
  for (const s of screens) delete s.raw;
  const device = raw.device === 'desktop' || raw.device === 'tablet' ? raw.device : 'mobile';
  return {
    title: str(raw.title, 80) || `Сценарий из ${screens.length} экранов`,
    summary: str(raw.summary, 300),
    device,
    size: flowDevice(device),
    screens,
    links,
    notes,
  };
}

/** Переход словами брифа: «Нажал «Играть»» → кнопка «Играть»; событие без кавычек — как есть. */
function actionWords(label, target) {
  const q = /[«"„“]([^»"”“]+)[»"”“]/u.exec(label || '');
  if (q) return `кнопка «${q[1].trim()}»`;
  return label ? `событие «${label}»` : `кнопка «${target}»`;
}

/**
 * Команда для одного экрана сценария — её выполняет обычный конвейер «собери экран»: новая доска,
 * имя экрана, что на нём, кнопки переходов (их надписи = trigger, чтобы стрелку было от чего вести).
 */
export function screenBrief(flow, screen, index) {
  const names = new Map(flow.screens.map((s) => [s.key, s.name]));
  const out = flow.links.filter((l) => l.from === screen.key);
  const into = flow.links.filter((l) => l.to === screen.key);
  const lines = [
    `Собери новым экраном «${screen.name}» (экран ${index + 1} из ${flow.screens.length} сценария «${flow.title}»): ${screen.purpose}`,
    `Корневой фрейм — экран ${flow.size.w}×${flow.size.h} px с именем «${screen.name}».`,
  ];
  if (out.length) {
    lines.push(`Переходы с экрана (кнопки подпиши этими словами): ${out.map((l) => `${actionWords(l.label, names.get(l.to))} → ${names.get(l.to)}`).join('; ')}.`);
  }
  if (into.length) lines.push(`Сюда приходят из: ${[...new Set(into.map((l) => names.get(l.from)))].join(', ')}.`);
  lines.push('Все экраны сценария — в одном стиле: тот же образ, палитра, шрифты и шапка.');
  return lines.join('\n');
}

/**
 * Колонка каждого экрана — шаг пути от первого (поиск в ширину по переходам). Экраны, до
 * которых переходов нет, — отдельной колонкой за последней. → Map key → номер колонки.
 */
export function flowColumns(flow) {
  const col = new Map();
  if (!flow || !flow.screens.length) return col;
  const out = new Map(flow.screens.map((s) => [s.key, []]));
  for (const l of flow.links) if (out.has(l.from)) out.get(l.from).push(l.to);
  const start = flow.screens[0].key;
  col.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const k = queue.shift();
    for (const t of out.get(k) || []) {
      if (col.has(t)) continue;
      col.set(t, col.get(k) + 1);
      queue.push(t);
    }
  }
  const last = col.size ? Math.max(...col.values()) : 0;
  for (const s of flow.screens) if (!col.has(s.key)) col.set(s.key, last + 1);
  return col;
}

/**
 * Раскладка досок сценария: колонки шагов слева направо, внутри колонки — сверху вниз в порядке
 * плана. boards: [{key, w, h}] (размер собранной доски), origin {x, y} — левый верх сценария.
 * → Map key → {x, y}.
 */
export function layoutFlow(flow, boards, origin = { x: 0, y: 0 }) {
  const cols = flowColumns(flow);
  const size = new Map(boards.map((b) => [b.key, b]));
  const groups = [];
  for (const s of flow.screens) {
    if (!size.has(s.key)) continue;
    const c = cols.get(s.key) || 0;
    (groups[c] = groups[c] || []).push(s.key);
  }
  const pos = new Map();
  let x = Math.round(origin.x || 0);
  for (const g of groups) {
    if (!g || !g.length) continue;
    let y = Math.round(origin.y || 0);
    let wide = 0;
    for (const k of g) {
      const b = size.get(k);
      pos.set(k, { x, y });
      y += Math.round(Math.max(1, b.h || FLOW_DEVICE.h)) + FLOW_LIMITS.gapY;
      wide = Math.max(wide, Math.round(b.w || FLOW_DEVICE.w));
    }
    x += wide + FLOW_LIMITS.gapX;
  }
  return pos;
}

const STEM = (w) => {
  const s = String(w || '').toLowerCase().replace(/ё/g, 'е');
  return s.length > 5 ? s.slice(0, s.length - 2) : s.length > 3 ? s.slice(0, s.length - 1) : s;
};
const wordsOf = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [];
const SKIP_WORDS = new Set(['нажал', 'нажала', 'нажать', 'нажми', 'тап', 'тапнул', 'выбрал', 'выбрать', 'на', 'в', 'и', 'по', 'кнопк', 'кнопка', 'кнопку']);

/**
 * Слой доски, с которого начинается переход: текст с теми же словами, что trigger («Нажал
 * «Играть»» → надпись «Играть»), — а от него ближайший фрейм-предок внутри доски (кнопка).
 * Сначала слова в кавычках, потом все значимые слова. Не нашёлся — null (стрелка от края доски).
 */
export function triggerNode(doc, boardId, label) {
  if (!doc || !doc.nodes || !doc.nodes[boardId] || !label) return null;
  const quoted = /[«"„“]([^»"”“]+)[»"”“]/u.exec(label);
  const want = wordsOf(quoted ? quoted[1] : label).filter((w) => !SKIP_WORDS.has(w) && w.length > 1).map(STEM);
  if (!want.length) return null;
  let best = null;
  const stack = [boardId];
  while (stack.length) {
    const id = stack.pop();
    const n = doc.nodes[id];
    if (!n) continue;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    if (n.type !== 'text' || id === boardId) continue;
    const have = wordsOf(n.characters).map(STEM);
    if (!have.length || have.length > 8) continue;
    const hit = want.filter((w) => have.some((h) => h.startsWith(w) || w.startsWith(h))).length;
    if (!hit) continue;
    const score = hit / want.length - have.length * 0.01;
    if (!best || score > best.score) best = { id, score };
  }
  if (!best || best.score < 0.5) return null;
  // кнопка — ближайший фрейм-предок текста, но не сама доска
  let at = best.id;
  const parent = doc.nodes[at] && doc.nodes[at].parent;
  if (parent && parent !== boardId && doc.nodes[parent] && doc.nodes[parent].type === 'frame') at = parent;
  return at;
}

/** Итог сценария словами: «Сценарий «…»: 7 экранов, 9 переходов». */
export function flowSummary(title, screens, links) {
  const n = (k, one, few, many) => {
    const m10 = k % 10;
    const m100 = k % 100;
    return `${k} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
  };
  return `Сценарий «${title}»: ${n(screens, 'экран', 'экрана', 'экранов')}, ${n(links, 'переход', 'перехода', 'переходов')}`;
}
