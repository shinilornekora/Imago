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

  function allText(turns) {
    if (typeof turns === 'string') return turns;
    return (Array.isArray(turns) ? turns : []).map((t) => String(t.content || '')).join('\n');
  }

  const answers = {
    plan(u) {
      const low = u.toLowerCase();
      let intent = 'create';
      if (/сколько|что за|почему|какой|\?/.test(low)) intent = 'ask';
      else if (/тёмн|темн|палитр|тему|цвета/.test(low)) intent = 'theme';
      else if (/крупнее|меньше|замени|убери|поменяй|сделай .* больше|отступ/.test(low)) intent = 'edit';
      // круг 36: микроанимации — правка состояний (SPEC §11.4)
      else if (/оживи|наведени|анимац/.test(low)) intent = 'edit';
      return {
        intent,
        title: 'Заглушка: ' + intent,
        summary: 'Детерминированный ответ тестовой заглушки.',
        steps: ['шаг один', 'шаг два'],
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
    answer() {
      return { answer: 'Это тестовая заглушка: настоящая модель тут не вызывается.', followups: [] };
    },
    unknown() { return {}; },
  };

  async function sampleFn(input, opts = {}) {
    const text = allText(input);
    const name = schemaNameOf(text);
    const data = (answers[name] || answers.unknown)(lastUser(input));
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
