/**
 * Круг 53 (SPEC §20): цвета картинок документа для арт-директора. Модель без зрения картинок не
 * видит, а модель со зрением их не получает (арт-директору снимок не шлётся), поэтому цвета
 * считает приложение — по пикселям, детерминированно — и отдаёт строкой в промпт.
 *
 * Здесь только чистые функции: какие картинки брать (imageSources), как из пикселей получить
 * несколько цветов с долями (paletteFromPixels) и как сказать это модели (imageColorsLine).
 * Пиксели добывает тот, у кого есть чем: оболочка — canvas, сервер — resvg (render.js).
 */

/** Сколько картинок смотреть за команду и сколько цветов брать с картинки. */
export const SWATCH_LIMITS = { images: 4, colors: 5, minShare: 0.02, side: 48, maxSrc: 6 * 1024 * 1024 };

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/**
 * Несколько главных цветов картинки. Пиксели — RGBA подряд (Uint8Array, Uint8ClampedArray, Buffer).
 * Корзины по 4 бита на канал, затем жадное слияние близких корзин (от самых частых): цвет
 * кластера — среднее его пикселей, доля — от непрозрачных пикселей. Прозрачные (альфа < 128) не
 * считаются. Почти одинаковые цвета сливаются, мелочь меньше minShare отбрасывается.
 * @param {ArrayLike<number>} data @param {number} w @param {number} h
 * @param {{count?: number, minShare?: number}} [opts]
 * @returns {{hex: string, share: number}[]} по убыванию доли; доля округлена до сотых
 */
export function paletteFromPixels(data, w, h, opts = {}) {
  const count = opts.count > 0 ? opts.count : SWATCH_LIMITS.colors;
  const minShare = opts.minShare >= 0 ? opts.minShare : SWATCH_LIMITS.minShare;
  const n = Math.min(Math.floor(Number(w) || 0) * Math.floor(Number(h) || 0), data ? Math.floor(data.length / 4) : 0);
  if (!(n > 0)) return [];
  const buckets = new Map();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let k = buckets.get(key);
    if (!k) { k = { r: 0, g: 0, b: 0, n: 0, key }; buckets.set(key, k); }
    k.r += r; k.g += g; k.b += b; k.n++;
    total++;
  }
  if (!total) return [];
  // от частых к редким; при равенстве — по ключу корзины, чтобы порядок не зависел от обхода
  const list = [...buckets.values()].sort((a, b) => b.n - a.n || a.key - b.key);
  const clusters = [];
  for (const k of list) {
    const c = [k.r / k.n, k.g / k.n, k.b / k.n];
    let best = null;
    let bestD = Infinity;
    for (const cl of clusters) {
      const d = dist(c, [cl.r / cl.n, cl.g / cl.n, cl.b / cl.n]);
      if (d < bestD) { bestD = d; best = cl; }
    }
    if (best && bestD < 48) { best.r += k.r; best.g += k.g; best.b += k.b; best.n += k.n; } else clusters.push({ r: k.r, g: k.g, b: k.b, n: k.n });
  }
  return clusters
    .sort((a, b) => b.n - a.n)
    .map((cl) => ({ hex: `#${hex2(cl.r / cl.n)}${hex2(cl.g / cl.n)}${hex2(cl.b / cl.n)}`, share: Math.round((cl.n / total) * 100) / 100 }))
    .filter((x) => x.share >= minShare)
    .slice(0, count);
}

/** Расстояние в RGB с весами восприятия («redmean»): зелёный различаем тоньше синего. */
function dist(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

const own = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Картинки, чьи цвета стоит показать арт-директору: в выделении (с потомками), а без выделения —
 * во всём документе. Только видимые, только со src; одна и та же картинка — один раз. Самые
 * крупные (по заданному размеру) — первыми, не больше SWATCH_LIMITS.images.
 * @param {object} doc @param {string[]} [selection]
 * @returns {{id: string, name: string, src: string}[]}
 */
export function imageSources(doc, selection) {
  const nodes = doc && doc.nodes && typeof doc.nodes === 'object' ? doc.nodes : null;
  if (!nodes) return [];
  const roots = (Array.isArray(selection) ? selection : []).filter((id) => typeof id === 'string' && own(nodes, id));
  const seen = new Set();
  const out = [];
  const visit = (id, depth) => {
    if (depth > 64 || seen.has(id) || !own(nodes, id)) return;
    seen.add(id);
    const n = nodes[id];
    if (!n || typeof n !== 'object' || n.visible === false) return;
    if (n.type === 'image' && typeof n.src === 'string' && n.src) out.push(n);
    for (const k of Array.isArray(n.children) ? n.children : []) visit(k, depth + 1);
  };
  if (roots.length) for (const id of roots) visit(id, 0);
  else if (typeof doc.root === 'string') visit(doc.root, 0);
  const area = (n) => {
    const s = n.size || {};
    const v = (x) => (x && typeof x === 'object' && Number.isFinite(x.value) ? x.value : 100);
    return v(s.w) * v(s.h);
  };
  const bySrc = new Set();
  return out
    .map((n, i) => ({ n, i, a: area(n) }))
    .sort((x, y) => y.a - x.a || x.i - y.i)
    .filter(({ n }) => (bySrc.has(n.src) ? false : (bySrc.add(n.src), true)))
    .slice(0, SWATCH_LIMITS.images)
    .map(({ n }) => ({ id: n.id, name: typeof n.name === 'string' ? n.name : '', src: n.src }));
}

/**
 * Строка для промпта арт-директора: «Фото зала: #3b2418 41%, #c9a77c 22%; …». Имена — данные
 * документа: без управляющих символов, кавычек и разделителей строк, до 40 знаков.
 * @param {{name?: string, colors: {hex: string, share: number}[]}[]} list
 */
export function imageColorsLine(list) {
  const rows = [];
  for (const item of Array.isArray(list) ? list : []) {
    const colors = (item && Array.isArray(item.colors) ? item.colors : [])
      .filter((c) => c && /^#[0-9a-f]{6}$/i.test(c.hex) && Number.isFinite(c.share) && c.share > 0)
      .slice(0, SWATCH_LIMITS.colors);
    if (!colors.length) continue;
    const name = cleanName(item.name) || 'картинка';
    rows.push(`- «${name}»: ${colors.map((c) => `${c.hex.toLowerCase()} ${Math.round(c.share * 100)}%`).join(', ')}`);
  }
  return rows.join('\n');
}

function cleanName(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f\u2028\u2029«»"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Наибольшая площадь картинки, которую сервер декодирует ради цветов (4096×4096). */
export const SWATCH_MAX_PIXELS = 4096 * 4096;

/**
 * Размер картинки по заголовку файла — до декодирования: маленький файл может объявить
 * 30000×30000 и съесть гигабайты при распаковке. PNG, GIF, JPEG (SOF), WebP (VP8, VP8L, VP8X).
 * @param {Uint8Array} b байты файла
 * @returns {{w: number, h: number}|null} null — формат не узнан или заголовок битый
 */
export function encodedSize(b) {
  if (!b || b.length < 16) return null;
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const ok = (w, h) => (w > 0 && h > 0 ? { w, h } : null);
  // PNG: подпись, затем IHDR
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return b.length >= 24 ? ok(u32be(16), u32be(20)) : null;
  // GIF87a/89a
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok(u16le(6), u16le(8));
  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X' && b.length >= 30) return ok(u24le(24) + 1, u24le(27) + 1);
    if (kind === 'VP8L' && b.length >= 25) {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (kind === 'VP8 ' && b.length >= 30) return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    return null;
  }
  // JPEG: маркеры до SOF0..SOF15 (кроме DHT C4, JPG C8, DAC CC)
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}
