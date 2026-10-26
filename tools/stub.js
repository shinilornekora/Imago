/* Заглушка платформы для локального прогона: детерминированные ответы «модели». */
(function () {
  const calls = [];
  const log = (...a) => { try { console.log('[stub]', ...a); } catch (_) {} };

  function schemaNameOf(text) {
    const m = /Схема "([a-z]+)"/i.exec(text || '');
    return m ? m[1] : 'unknown';
  }

  function lastUser(turns) {
    if (typeof turns === 'string') return turns;
    const arr = Array.isArray(turns) ? turns : [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].role === 'user') return String(arr[i].content || '');
    return '';
  }

  /* Круг 37 (SPEC §12.2): «нарисуй …», «монстр», «печенька» — иллюстрация. Монстрика берём
     у ядра (core.sampleIllustration — та же картинка, что в его тестах), печеньку рисуем тут.
     Ядро грузится сразу: заглушка — классический скрипт, модуль — динамическим импортом. */
  const RE_ART = /нарису|монстр|печень|иллюстрац|маскот|персонаж|картинк/;
  const coreUrl = (() => { try { return new URL('../src/core.js', document.currentScript.src).href; } catch (_) { return './src/core.js'; } })();
  let corePromise = null;
  const loadCore = () => (corePromise = corePromise || import(coreUrl).catch((e) => { log('core', String(e && e.message)); return null; }));
  loadCore();

  /** Краска ядра → строка ответа модели (#hex | "none"); градиент — первый стоп. */
  function paintStr(p) {
    if (p === undefined) return undefined;
    if (p === null) return 'none';
    if (typeof p === 'string') return p;
    if (p.gradient) { const st = p.gradient.stops || []; return st.length ? (st[0].color || st[0].token) : undefined; }
    return p.color || p.token || p.value;
  }

  /** Монстрик ядра → спецификация иллюстрации (холст 1:1 с рамкой, детали снизу вверх). */
  function monsterFromCore(core) {
    if (!core || typeof core.sampleIllustration !== 'function') return null;
    let ops;
    try { ops = core.sampleIllustration({ parent: 'stub' }); } catch (_) { return null; }
    if (!Array.isArray(ops) || !ops.length) return null;
    const frame = ops[0].node;
    const w = frame.size && frame.size.w && frame.size.w.value || 240;
    const h = frame.size && frame.size.h && frame.size.h.value || 240;
    const parts = [];
    for (const o of ops.slice(1)) {
      const v = o.node;
      if (!v || v.type !== 'vector' || !Array.isArray(v.paths)) continue;
      const vb = v.viewBox || {};
      // детали ядра лежат 1:1 — viewBox в координатах холста; иначе пропускаем
      if (!v.pos || Math.abs((vb.x || 0) - v.pos.x) > 0.01 || Math.abs((vb.y || 0) - v.pos.y) > 0.01) continue;
      for (const p of v.paths) {
        const fill = p.fill !== undefined ? p.fill : v.fill;
        const part = { name: p.name || v.name, kind: 'path', d: p.d };
        if (v.paths.length > 1) part.group = v.name;
        if (fill && fill.gradient) part.gradient = fill.gradient;
        else if (fill !== undefined) part.fill = paintStr(fill);
        const stroke = p.stroke !== undefined ? p.stroke : (v.stroke && (v.stroke.color || v.stroke));
        if (stroke !== undefined) { part.stroke = paintStr(stroke); part.strokeWidth = p.strokeWidth != null ? p.strokeWidth : 2; }
        if (p.opacity != null) part.opacity = p.opacity;
        if (v.rotate) part.rotate = v.rotate;
        parts.push(part);
      }
    }
    if (!parts.length) return null;
    const bg = frame.fill && frame.fill.gradient ? (frame.fill.gradient.stops || [])[0] : null;
    return { name: 'Монстрик', canvas: { w, h }, background: bg ? bg.color : paintStr(frame.fill) || 'none', outline: { color: 'none', width: 0 }, parts };
  }

  /** Печенька: тесто с градиентом, тень, кромка, шоколадная крошка (одной группой), блик. */
  function cookie() {
    const chips = [[132, 120, 13], [196, 112, 11], [238, 150, 12], [150, 196, 12], [214, 206, 14], [178, 160, 9], [252, 236, 10], [118, 248, 9]];
    return {
      name: 'Печенька',
      canvas: { w: 400, h: 400 },
      background: 'none',
      palette: [{ name: 'тесто', color: '#E3A85F' }, { name: 'шоколад', color: '#5B3A29' }],
      parts: [
        { name: 'Тень', kind: 'ellipse', x: 92, y: 318, w: 236, h: 30, fill: '#2b1d10', opacity: 0.18 },
        { name: 'Печенька', kind: 'path', d: 'M200 64C268 60 330 104 338 176C346 250 300 318 222 330C148 342 74 300 62 224C50 146 120 68 200 64Z',
          gradient: { kind: 'radial', stops: [{ at: 0, color: '#F2C27F' }, { at: 1, color: '#C98A43' }] }, stroke: '#8A5523', strokeWidth: 4 },
        { name: 'Кромка', kind: 'path', d: 'M96 246C118 296 170 318 226 312C280 306 318 268 326 222C306 270 262 296 214 298C164 300 118 282 96 246Z', fill: '#B5772F', opacity: 0.7 },
        ...chips.map(([cx, cy, r], i) => ({ name: `Крошка ${i + 1}`, kind: 'path', d: `M${cx - r} ${cy}C${cx - r} ${cy - r * 0.9} ${cx + r * 0.9} ${cy - r} ${cx + r} ${cy - r * 0.2}C${cx + r} ${cy + r * 0.8} ${cx} ${cy + r} ${cx - r * 0.6} ${cy + r * 0.7}C${cx - r} ${cy + r * 0.5} ${cx - r} ${cy + r * 0.2} ${cx - r} ${cy}Z`, fill: '#5B3A29', group: 'Шоколадная крошка' })),
        { name: 'Блик', kind: 'path', d: 'M132 104C160 88 196 82 224 88C192 96 164 110 144 132C136 124 130 114 132 104Z', fill: '#FFF3DC', opacity: 0.75 },
      ],
    };
  }

  /** Запасной монстрик, если ядро ещё не умеет образец: силуэт, живот, глаза, рот. */
  function monsterFallback() {
    return {
      name: 'Монстрик', canvas: { w: 240, h: 240 }, background: '#FFE9D6',
      outline: { color: '#2B1D5C', width: 4 },
      parts: [
        { name: 'Тень', kind: 'ellipse', x: 62, y: 206, w: 116, h: 16, fill: '#2B1D5C', opacity: 0.2, stroke: 'none' },
        { name: 'Тело', kind: 'path', d: 'M120 36C170 36 200 78 200 130C200 182 166 210 120 210C74 210 40 182 40 130C40 78 70 36 120 36Z',
          gradient: { kind: 'linear', angle: 180, stops: [{ at: 0, color: '#8F7BFF' }, { at: 1, color: '#5B47D6' }] } },
        { name: 'Животик', kind: 'ellipse', x: 76, y: 112, w: 88, h: 84, fill: '#C9BFFF', stroke: 'none' },
        { name: 'Левый глаз', kind: 'ellipse', x: 82, y: 82, w: 36, h: 36, fill: '#FFFFFF', group: 'Глаза' },
        { name: 'Правый глаз', kind: 'ellipse', x: 122, y: 82, w: 36, h: 36, fill: '#FFFFFF', group: 'Глаза' },
        { name: 'Рот', kind: 'path', d: 'M100 142C108 156 132 156 140 142C132 148 108 148 100 142Z', fill: '#2B1D5C' },
      ],
    };
  }

  function allText(turns) {
    if (typeof turns === 'string') return turns;
    return (Array.isArray(turns) ? turns : []).map((t) => String(t.content || '')).join('\n');
  }

  const answers = {
    plan(u) {
      const low = u.toLowerCase();
      let intent = 'create';
      if (/сколько|что за|почему|какой|\?/.test(low)) intent = 'ask';
      // круг 37 (SPEC §12.2): нарисовать картинку — иллюстрация
      else if (RE_ART.test(low)) intent = 'illustration';
      else if (/тёмн|темн|палитр|тему|цвета/.test(low)) intent = 'theme';
      else if (/крупнее|меньше|замени|убери|поменяй|сделай .* больше|отступ/.test(low)) intent = 'edit';
      // круг 36: микроанимации — правка состояний (SPEC §11.4)
      else if (/оживи|наведени|анимац/.test(low)) intent = 'edit';
      // круг 37: перекраска выделенной детали (подсказка «перекрась в тёплые тона»)
      else if (/перекрас/.test(low)) intent = 'edit';
      return {
        intent,
        title: 'Заглушка: ' + intent,
        summary: 'Детерминированный ответ тестовой заглушки.',
        // круг 37: у рисунка — шаги иллюстратора (SPEC §12.2: снизу вверх)
        steps: intent === 'illustration' ? ['Силуэт и крупные формы', 'Тени, блики и мелочи'] : ['шаг один', 'шаг два'],
        targets: [],
      };
    },
    tree() {
      return {
        type: 'frame',
        name: 'Карточка оплаты',
        layout: { mode: 'column', gap: 16, padding: 24 },
        size: { w: 320, h: 'hug' },
        fill: 'surface',
        radius: 16,
        children: [
          { type: 'text', name: 'Заголовок', text: 'Оплата', style: 'title', color: 'text' },
          { type: 'text', name: 'Подпись', text: 'Карта •••• 4242', style: 'body', color: 'muted' },
          {
            type: 'frame', name: 'Кнопка', layout: { mode: 'row', gap: 8, padding: [12, 20], justify: 'center' },
            size: { w: 'fill', h: 'hug' }, fill: 'accent', radius: 12,
            children: [{ type: 'text', name: 'Надпись кнопки', text: 'Оплатить 1 240 ₽', style: 'body', color: 'onAccent' }],
          },
        ],
      };
    },
    patch(u) {
      /* Круг 36 (SPEC §11.4): «оживи кнопки» — подъём шагом шкалы, средняя тень и быстрое
         движение ссылками на шкалы, как просит раздел об агенте. Цель — кнопка демо. */
      if (/оживи|наведени|анимац/.test(String(u || '').toLowerCase())) {
        const target = 'Кнопка «Добавить пункт»';
        return {
          summary: 'Кнопка приподнимается при наведении',
          edits: [
            { op: 'set', target, path: 'states.hover', value: { lift: 'spacing.1', shadow: 'shadow.md' } },
            { op: 'set', target, path: 'motion', value: { duration: 'motion.fast', easing: 'standard' } },
          ],
        };
      }
      /* Круг 37 (SPEC §12.2): «перекрась …» — заливка выделенного слоя (у детали иллюстрации —
         её контуров): тёплые — персиковый, пастельные — лавандовый, иначе — мятный. */
      const low = String(u || '').toLowerCase();
      if (/перекрас/.test(low)) {
        const value = /т[её]пл/.test(low) ? '#F4A261' : /пастел/.test(low) ? '#C8B6FF' : '#3FBF8F';
        return { summary: 'Перекрасил выделенное', edits: [{ op: 'set', target: 'selection', path: 'fill', value }] };
      }
      return { summary: 'Заглушка правок', edits: [{ op: 'set', target: 'selection', path: 'layout.gap', value: '24' }] };
    },
    theme() {
      /* Круг 16: раньше заглушка темнила только «canvas» и «text», а «surface» оставляла белым —
         и получался светлый текст на белых карточках, то есть документ, который нельзя читать.
         Мозг теперь такую палитру чинит сам, но наладочная сборка не должна показывать человеку
         заведомо негодный ответ: разумная модель темнит и подложки, и линии, и подписи разом. */
      return {
        summary: 'Тёмная палитра',
        colors: [
          { name: 'canvas', value: '#0E1116' },
          { name: 'surface', value: '#171B22' },
          { name: 'surfaceAlt', value: '#1F242D' },
          { name: 'line', value: '#2C323D' },
          { name: 'text', value: '#F2F4F8' },
          { name: 'muted', value: '#9AA3B2' },
          { name: 'accentSoft', value: '#3A2119' },
          { name: 'accentInk', value: '#FF9E7A' },
          { name: 'onAccent', value: '#14161C' },
        ],
      };
    },
    /** Круг 37: иллюстрация — монстрик ядра или печенька (async: ядро может догружаться). */
    async illustration(u) {
      const low = String(u || '').toLowerCase();
      if (/печень/.test(low)) return cookie();
      const core = await loadCore();
      return monsterFromCore(core) || monsterFallback();
    },
    answer() {
      return { answer: 'Это тестовая заглушка: настоящая модель тут не вызывается.', followups: [] };
    },
    /* Круг 47 (SPEC §14.1): арт-директор — образ по слову в команде: кофе, спорт, ночь; иначе — сад. */
    direction(u) {
      const low = String(u || '').toLowerCase();
      if (/коф|чай|пекар|завтрак/.test(low)) {
        return {
          concept: 'Утренняя кофейня: крафтовый пакет, эмалированная кружка, мел на доске',
          mood: ['тепло', 'ремесленно'],
          materials: [{ name: 'крафт', hex: '#c9a77c' }, { name: 'эспрессо', hex: '#3b2418' }, { name: 'пенка', hex: '#f4ead8' }, { name: 'эмаль', hex: '#2f6f62' }],
          palette: { bg: '#f4ead8', surface: '#fffaf1', text: '#2b1a12', muted: '#6e5646', accent: '#2f6f62', accent2: '#c9a77c' },
          fonts: { display: 'Prata', text: 'Golos Text' },
          motifs: ['круглый штамп', 'крупные цены'], composition: 'асимметрия, заголовок слева', avoid: ['белые карточки в ряд'],
        };
      }
      if (/спорт|фитнес|бег|трениров/.test(low)) {
        return {
          concept: 'Ночная беговая дорожка: светоотражатель, мокрый асфальт, табло секундомера',
          mood: ['драйв', 'ночь'],
          materials: [{ name: 'асфальт', hex: '#15171c' }, { name: 'неон', hex: '#c6ff3d' }, { name: 'светоотражатель', hex: '#e9edf2' }],
          palette: { bg: '#15171c', surface: '#20242c', text: '#f2f4f7', muted: '#9aa3b2', accent: '#c6ff3d', accent2: '#ff4f6d' },
          fonts: { display: 'Russo One', text: 'Exo 2' },
          motifs: ['крупные цифры темпа', 'полосы разметки'], composition: 'крупный первый экран', avoid: ['пастель'],
        };
      }
      return {
        concept: 'Утренний сад: мокрая листва, глиняные горшки, лён',
        mood: ['свежо', 'спокойно'],
        materials: [{ name: 'лён', hex: '#efe9dd' }, { name: 'листва', hex: '#2e6b4a' }, { name: 'терракота', hex: '#c8643b' }],
        palette: { bg: '#efe9dd', surface: '#fbf8f2', text: '#1f2a22', muted: '#5f6b61', accent: '#2e6b4a', accent2: '#c8643b' },
        fonts: { display: 'Lora', text: 'Onest' },
        motifs: ['круги-пятна', 'лист иллюстрацией'], composition: 'лента с выносом', avoid: ['синий акцент'],
      };
    },
    /** Круг 47 (SPEC §14.3): критик заглушки доволен — доработки не будет. */
    critique() {
      return { score: 8, generic: false, verdict: 'ok', issues: [], fixes: [], praise: 'Образ читается' };
    },
    unknown() { return {}; },
  };

  async function sampleFn(input, opts = {}) {
    const text = allText(input);
    const name = schemaNameOf(text);
    const data = await (answers[name] || answers.unknown)(lastUser(input));
    calls.push({ schema: name, chars: text.length });
    log('sample', name);
    if (opts.onText) { try { opts.onText({ text: JSON.stringify(data), delta: '' }); } catch (_) {} }
    await new Promise((r) => setTimeout(r, 40));
    return { text: JSON.stringify(data), truncated: false };
  }
  sampleFn.json = async (input, opts) => JSON.parse((await sampleFn(input, opts)).text);
  sampleFn.limits = async () => ({ images: false });

  /* Круг 16: поддельная база держалась в памяти страницы, и dev.html терял документ на каждой
     перезагрузке — то есть ровно то поведение, ради проверки которого автосохранение и писалось,
     в наладочной сборке проверить было нельзя. Теперь зеркалим в localStorage: в памяти — Map
     (быстро и без разбора JSON на каждый get), на диске — по ключу на документ. Любая ошибка
     хранилища (приватное окно, запрет на данные сайта) роняет нас обратно в чистую память. */
  const LS_PREFIX = 'imago.stub.db/';
  const store = new Map();
  let lsOk = true;
  const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch { lsOk = false; return null; } };
  const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { lsOk = false; } };
  const lsDel = (k) => { try { window.localStorage.removeItem(k); } catch { lsOk = false; } };
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (!k || k.indexOf(LS_PREFIX) !== 0) continue;
      try { store.set(k.slice(LS_PREFIX.length), JSON.parse(window.localStorage.getItem(k))); } catch { /* битая запись — просто нет её */ }
    }
  } catch { lsOk = false; }
  if (store.size) log('db restore', `${store.size} док.`);
  const keep = (path, v) => {
    store.set(path, v);
    if (!lsOk) return;
    // Круг 16: не даём наладочной базе распухнуть до отказа записи — запись сама скажет об этом
    try { lsSet(LS_PREFIX + path, JSON.stringify(v)); } catch { /* несериализуемое значение живёт только в памяти */ }
  };
  const db = {
    doc(path) {
      return {
        async get() { return store.has(path) ? { data: store.get(path) } : null; },
        async set(v) { keep(path, v); },
        async update(v) { keep(path, { ...(store.get(path) || {}), ...v }); },
        async delete() { store.delete(path); lsDel(LS_PREFIX + path); },
        onSnapshot() { return () => {}; },
      };
    },
    collection() { return { async get() { return []; }, where() { return this; }, orderBy() { return this; }, limit() { return this; }, onSnapshot() { return () => {}; } }; },
  };
  // чтобы наладку можно было начать с чистого листа, не чистя хранилище руками
  window.__stubDbReset = () => {
    for (const path of Array.from(store.keys())) lsDel(LS_PREFIX + path);
    store.clear();
    log('db reset', 'пусто');
  };

  const downloads = { async save({ filename }) { log('download', filename); window.__stubDownloads = (window.__stubDownloads || []).concat(filename); return true; } };

  window.claude = {
    async use(name) {
      if (name === 'sample') return sampleFn;
      if (name === 'db') return db;
      if (name === 'downloads') return downloads;
      return null;
    },
  };
  window.__stubCalls = calls;
})();
