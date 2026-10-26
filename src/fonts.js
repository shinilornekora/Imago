/**
 * Круг 47 (SPEC §14): подобранный набор шрифтов агента.
 *
 * Зачем свой набор, а не «любой шрифт Google Fonts». Модель знает сотни имён, но не знает,
 * у каких из них есть кириллица (у Bebas Neue, DM Sans, Space Grotesk, Work Sans её нет —
 * русский заголовок выйдет системным шрифтом), каких начертаний нет вовсе (Russo One — только
 * 400, и «700» — запрос с ошибкой), и какие пары работают вместе. Здесь только семейства с
 * кириллицей, с проверенными начертаниями, и пары «акцидентный + наборный» со словами
 * о характере: из них арт-директор выбирает, мозг сверяет выбор, оболочка подгружает
 * стили, а рендер критика на сервере тянет файлы.
 *
 * Модуль без зависимостей: его импортируют brain.js (браузер и сервер), app.js и
 * orchestrator (рендер PNG). Формат документа он не меняет: шрифт живёт в `style.font`
 * узла или в `tokens.type.<k>.font`, как и раньше.
 */

/** Шрифт документа по умолчанию — признак «шаблонного» экрана (§14.3). */
export const DEFAULT_FONT = 'IBM Plex Sans';

/**
 * Семейства. kind — вид (sans, serif, display, script, mono, slab); weights — начертания,
 * которые у семейства на Google Fonts есть (запрос css2 с другим весом — 400 Bad Request);
 * mood — характер словами для промпта.
 */
export const FONT_CATALOG = Object.freeze([
  // наборные (текст, интерфейс)
  { family: 'Manrope', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'геометричный, современный, чистый' },
  { family: 'Golos Text', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'спокойный, городской, читаемый' },
  { family: 'Onest', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'дружелюбный гротеск, продуктовый' },
  { family: 'Inter Tight', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'плотный, редакционный, строгий' },
  { family: 'Commissioner', kind: 'sans', weights: [300, 400, 500, 600, 700], mood: 'тихий, архитектурный' },
  { family: 'Jost', kind: 'sans', weights: [300, 400, 500, 600, 700], mood: 'футуристичная геометрия 20-х, ар-деко' },
  { family: 'Mulish', kind: 'sans', weights: [300, 400, 500, 600, 700], mood: 'мягкий, лёгкий, светлый' },
  { family: 'Nunito', kind: 'sans', weights: [400, 600, 700, 800], mood: 'округлый, детский, тёплый' },
  { family: 'Rubik', kind: 'sans', weights: [400, 500, 600, 700], mood: 'скруглённые углы, игривый' },
  { family: 'Exo 2', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'технический, спортивный' },
  { family: 'PT Sans', kind: 'sans', weights: [400, 700], mood: 'нейтральный, газетный, надёжный' },
  { family: 'Source Sans 3', kind: 'sans', weights: [400, 500, 600, 700], mood: 'книжный гротеск, ясный' },
  { family: 'Ubuntu', kind: 'sans', weights: [400, 500, 700], mood: 'гуманистический, мягкий техно' },
  { family: 'Sofia Sans', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'узковатый, динамичный' },
  { family: 'Alegreya Sans', kind: 'sans', weights: [400, 500, 700, 800], mood: 'рукотворный, тёплый гуманист' },
  { family: 'Raleway', kind: 'sans', weights: [400, 500, 600, 700], mood: 'элегантный, тонкий' },
  { family: 'Montserrat', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'широкий, плакатный, уверенный' },
  { family: 'Wix Madefor Text', kind: 'sans', weights: [400, 500, 600, 700, 800], mood: 'нейтральный продуктовый' },
  { family: 'IBM Plex Sans', kind: 'sans', weights: [400, 500, 600, 700], mood: 'инженерный, по умолчанию' },
  { family: 'Literata', kind: 'serif', weights: [400, 500, 600, 700], mood: 'книжная антиква, для чтения' },
  { family: 'PT Serif', kind: 'serif', weights: [400, 700], mood: 'классическая антиква, газетная' },
  { family: 'Lora', kind: 'serif', weights: [400, 500, 600, 700], mood: 'тёплая антиква, литературная' },
  { family: 'Bitter', kind: 'slab', weights: [400, 500, 600, 700, 800], mood: 'брусковый, крепкий, ремесленный' },
  // акцидентные (заголовки, крупные цифры)
  { family: 'Unbounded', kind: 'display', weights: [400, 500, 600, 700, 800], mood: 'широкий, смелый, молодёжный' },
  { family: 'Playfair Display', kind: 'serif', weights: [400, 500, 600, 700, 800], mood: 'контрастная антиква, журнальная' },
  { family: 'Cormorant Garamond', kind: 'serif', weights: [400, 500, 600, 700], mood: 'изысканная, тонкая, роскошь' },
  { family: 'Prata', kind: 'serif', weights: [400], mood: 'дидона, классика с характером' },
  { family: 'Yeseva One', kind: 'serif', weights: [400], mood: 'женственная, мягкая дидона' },
  { family: 'Forum', kind: 'serif', weights: [400], mood: 'античная, торжественная' },
  { family: 'Old Standard TT', kind: 'serif', weights: [400, 700], mood: 'старинная типографика, архив' },
  { family: 'Noto Serif Display', kind: 'serif', weights: [400, 500, 600, 700], mood: 'галерейная, высокий контраст' },
  { family: 'Tenor Sans', kind: 'display', weights: [400], mood: 'тихий минимализм, мода' },
  { family: 'Russo One', kind: 'display', weights: [400], mood: 'спорт, мощь, техника' },
  { family: 'Oswald', kind: 'display', weights: [400, 500, 600, 700], mood: 'сжатый, плакатный, новостной' },
  { family: 'Rubik Mono One', kind: 'display', weights: [400], mood: 'тяжёлый, игровой, гик' },
  { family: 'Dela Gothic One', kind: 'display', weights: [400], mood: 'брутальный, андеграунд' },
  { family: 'Climate Crisis', kind: 'display', weights: [400, 700], mood: 'жирный, протестный, экология' },
  { family: 'Tektur', kind: 'display', weights: [400, 500, 600, 700, 800], mood: 'кибер, sci-fi, электроника' },
  { family: 'Philosopher', kind: 'display', weights: [400, 700], mood: 'мягкий модерн, образование' },
  { family: 'Kelly Slab', kind: 'slab', weights: [400], mood: 'рустик, вывеска мастерской' },
  { family: 'Comfortaa', kind: 'display', weights: [400, 500, 600, 700], mood: 'круглый, дружелюбный, детский' },
  { family: 'Poiret One', kind: 'display', weights: [400], mood: 'ар-деко, тонкие линии, бар' },
  { family: 'Wix Madefor Display', kind: 'display', weights: [400, 500, 600, 700, 800], mood: 'чёткий продуктовый заголовок' },
  { family: 'Press Start 2P', kind: 'display', weights: [400], mood: 'пиксель, ретро-игры' },
  { family: 'Lobster', kind: 'script', weights: [400], mood: 'ретро-вывеска, кафе' },
  { family: 'Pacifico', kind: 'script', weights: [400], mood: 'пляж, лето, сёрф' },
  { family: 'Caveat', kind: 'script', weights: [400, 500, 600, 700], mood: 'рукописный, личный, заметки' },
  { family: 'Amatic SC', kind: 'script', weights: [400, 700], mood: 'нарисованный от руки, фермерский' },
  { family: 'Marck Script', kind: 'script', weights: [400], mood: 'каллиграфия, открытка' },
  // моноширинные
  { family: 'JetBrains Mono', kind: 'mono', weights: [400, 500, 600, 700, 800], mood: 'код, данные' },
  { family: 'Martian Mono', kind: 'mono', weights: [400, 500, 600, 700, 800], mood: 'широкий техно-моно' },
  { family: 'IBM Plex Mono', kind: 'mono', weights: [400, 500, 600, 700], mood: 'инженерный моно' },
]);

/**
 * Пары «заголовки + текст». Арт-директор выбирает пару (или две гарнитуры из каталога сам);
 * слова — чтобы выбор шёл от образа, а не от привычки.
 */
export const FONT_PAIRS = Object.freeze([
  { display: 'Unbounded', text: 'Manrope', mood: 'смело, технологично, молодо', fits: 'финтех, стартап, музыка, фестиваль' },
  { display: 'Playfair Display', text: 'Source Sans 3', mood: 'редакционно, элегантно', fits: 'журнал, мода, ресторан, лонгрид' },
  { display: 'Cormorant Garamond', text: 'Montserrat', mood: 'роскошь, тонкость', fits: 'ювелирка, отель, свадьба, парфюм' },
  { display: 'Prata', text: 'Golos Text', mood: 'классика с современностью', fits: 'кофейня, книжный, музей, чай' },
  { display: 'Yeseva One', text: 'Mulish', mood: 'мягко, женственно', fits: 'косметика, флористика, уход' },
  { display: 'Russo One', text: 'Exo 2', mood: 'драйв, мощь', fits: 'спорт, гейминг, автомобили' },
  { display: 'Oswald', text: 'PT Sans', mood: 'плакатно, сжато, громко', fits: 'новости, события, фитнес, афиша' },
  { display: 'Rubik Mono One', text: 'Rubik', mood: 'игриво, гик', fits: 'игры, комиксы, детские приложения' },
  { display: 'Tenor Sans', text: 'Commissioner', mood: 'тихий минимализм', fits: 'архитектура, студия, мебель, мода' },
  { display: 'Lora', text: 'Onest', mood: 'тепло, литературно', fits: 'образование, блог, книги, психология' },
  { display: 'Comfortaa', text: 'Nunito', mood: 'дружелюбно, кругло', fits: 'дети, питомцы, сладости, привычки' },
  { display: 'Caveat', text: 'Jost', mood: 'лично, от руки', fits: 'заметки, крафт, хобби, планер' },
  { display: 'Press Start 2P', text: 'JetBrains Mono', mood: 'пиксельное ретро', fits: 'ретро-игры, кликер, хакатон' },
  { display: 'Dela Gothic One', text: 'Inter Tight', mood: 'брутально, остро', fits: 'стритвир, клуб, андеграунд, арт' },
  { display: 'Forum', text: 'Literata', mood: 'торжественно, исторично', fits: 'винодельня, традиции, история' },
  { display: 'Climate Crisis', text: 'Sofia Sans', mood: 'протестно, актуально', fits: 'экология, активизм, манифест' },
  { display: 'Philosopher', text: 'Ubuntu', mood: 'мягкий модерн', fits: 'онлайн-курсы, наука, сообщество' },
  { display: 'Kelly Slab', text: 'Bitter', mood: 'рустик, ремесло', fits: 'пекарня, мастерская, пивоварня' },
  { display: 'Pacifico', text: 'Nunito', mood: 'лето, беззаботно', fits: 'пляж, мороженое, путешествия' },
  { display: 'Old Standard TT', text: 'PT Serif', mood: 'газетно, архивно', fits: 'история, архив, антиквариат' },
  { display: 'Martian Mono', text: 'Onest', mood: 'техно-нерд', fits: 'данные, разработчики, аналитика' },
  { display: 'Tektur', text: 'Sofia Sans', mood: 'кибер, будущее', fits: 'электроника, sci-fi, VR' },
  { display: 'Amatic SC', text: 'Alegreya Sans', mood: 'рукотворно, по-фермерски', fits: 'рынок, эко-продукты, сад' },
  { display: 'Poiret One', text: 'Jost', mood: 'ар-деко', fits: 'бар, театр, кабаре, джаз' },
  { display: 'Noto Serif Display', text: 'Commissioner', mood: 'галерейно, премиально', fits: 'галерея, аукцион, недвижимость' },
  { display: 'Wix Madefor Display', text: 'Wix Madefor Text', mood: 'ясный продукт', fits: 'SaaS, панель, сервис' },
  { display: 'Lobster', text: 'Raleway', mood: 'ретро-вывеска', fits: 'бургерная, диннер, барбершоп' },
]);

const BY_NAME = new Map(FONT_CATALOG.map((f) => [f.family.toLowerCase(), f]));

/** Запись каталога по имени семейства (регистр и лишние пробелы и кавычки не важны). */
export function catalogFont(name) {
  if (typeof name !== 'string') return null;
  const key = name.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return key ? BY_NAME.get(key) || null : null;
}

/** Ближайшее доступное начертание семейства к желаемому (для запроса css2 и рендера). */
export function nearestWeight(family, weight) {
  const f = catalogFont(family);
  const want = Number.isFinite(weight) ? weight : 400;
  if (!f) return want;
  let best = f.weights[0];
  for (const w of f.weights) if (Math.abs(w - want) < Math.abs(best - want)) best = w;
  return best;
}

/**
 * Адрес стилей Google Fonts на несколько семейств сразу. Только семейства каталога и только
 * их начертания: чужое имя или вес — это 400 у всего запроса, и не загрузился бы ни один.
 * @param {Iterable<string>} families
 * @returns {string} '' — грузить нечего
 */
export function fontStylesheetUrl(families) {
  const seen = new Set();
  const parts = [];
  for (const name of families || []) {
    const f = catalogFont(name);
    if (!f || seen.has(f.family)) continue;
    seen.add(f.family);
    parts.push('family=' + encodeURIComponent(f.family).replace(/%20/g, '+') + ':wght@' + f.weights.join(';'));
  }
  parts.sort();
  return parts.length ? 'https://fonts.googleapis.com/css2?' + parts.join('&') + '&display=swap' : '';
}

/** Гарнитуры документа: токены типографики, поправки `style.font` у текстов и шрифты тем досок. @returns {string[]} */
export function fontsInDoc(doc) {
  const out = new Set();
  const types = doc && doc.tokens && doc.tokens.type;
  if (types && typeof types === 'object') {
    for (const k of Object.keys(types)) {
      const e = types[k];
      if (e && typeof e === 'object' && typeof e.font === 'string' && e.font.trim()) out.add(e.font.trim());
    }
  }
  const nodes = doc && doc.nodes;
  if (nodes && typeof nodes === 'object') {
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      const st = n && n.style;
      if (st && typeof st === 'object' && typeof st.font === 'string' && st.font.trim()) out.add(st.font.trim());
      // круг 48 (SPEC §15): шрифты темы доски
      const tt = n && n.type === 'frame' && n.theme && typeof n.theme === 'object' ? n.theme.type : null;
      if (tt && typeof tt === 'object' && !Array.isArray(tt)) {
        for (const k of Object.keys(tt)) {
          const e = tt[k];
          if (e && typeof e === 'object' && typeof e.font === 'string' && e.font.trim()) out.add(e.font.trim());
        }
      }
    }
  }
  return [...out].sort();
}

/** Пары и семейства словами — блок промпта арт-директора. */
export function fontMenu() {
  // только настроение: тема пары («кофейня») подсказывала самый очевидный ход вместо образа
  const pairs = FONT_PAIRS.map((p) => `- ${p.display} + ${p.text} — ${p.mood}`);
  const kinds = { sans: 'гротески', serif: 'антиквы', slab: 'брусковые', display: 'акцидентные', script: 'рукописные', mono: 'моноширинные' };
  const groups = Object.keys(kinds).map((k) => `${kinds[k]}: ${FONT_CATALOG.filter((f) => f.kind === k).map((f) => f.family).join(', ')}`);
  return ['ПАРЫ ШРИФТОВ (заголовки + текст):', ...pairs, '', 'ВСЕ ДОСТУПНЫЕ СЕМЕЙСТВА (у всех есть кириллица):', ...groups].join('\n');
}
