/**
 * Снимок доски для критика агента (SPEC §14.4): SVG — та же отрисовка, что у редактора
 * (`core.renderSVG`, без страницы), PNG — `@resvg/resvg-js` (необязательная зависимость),
 * шрифты — TTF с Google Fonts (css2 без браузерного User-Agent отдаёт truetype).
 *
 * Живёт в воркере DSLV: brain зовёт `render({doc, geo, artboardId, maxSide})` между вызовами
 * модели. Всё, что может не выйти, даёт `null`, и критик судит по выжимке:
 *   • resvg не установлен (сборка без необязательных зависимостей);
 *   • на доске есть текст, а ни одного файла шрифта получить не удалось — без шрифтов
 *     resvg текст не рисует вовсе, и критик увидел бы пустые плашки;
 *   • SVG не собрался.
 * Эмодзи из текста убираются: цветного эмодзи-шрифта нет, и resvg отбрасывал бы весь кусок
 * текста с ним («15 🍪» терял и «15»).
 *
 * Ходит только на fonts.googleapis.com и fonts.gstatic.com, только за семействами каталога
 * (src/fonts.js) и только в начертаниях, которые там есть. Кеш — в памяти воркера, по
 * семейству, не больше FONT_CACHE_FAMILIES семейств (старые вытесняются).
 */

import { renderSVG } from '../../src/core.js';
import { catalogFont, DEFAULT_FONT } from '../../src/fonts.js';
import { RENDER_FONT_TIMEOUT_MS, FONT_CACHE_FAMILIES, RENDER_FONT_MAX_BYTES } from './limits.js';

const CSS_ORIGIN = 'https://fonts.googleapis.com/css2';
const FILE_ORIGIN = 'https://fonts.gstatic.com/';
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

let resvgModule;   // undefined — не пробовали; null — нет

/** resvg-js, если установлен. */
async function loadResvg() {
  if (resvgModule === undefined) {
    try { resvgModule = await import('@resvg/resvg-js'); } catch { resvgModule = null; }
  }
  return resvgModule;
}

/**
 * @param {{fetch?: typeof fetch, timeoutMs?: number, log?: {warn: Function}, resvg?: object|null}} [opts]
 *   resvg — подмена модуля (тесты: null — «не установлен»)
 * @returns {(args: {doc: object, geo?: object, artboardId: string, maxSide?: number}) => Promise<{mime: string, data: string, width: number, height: number}|null>}
 */
export function createRenderer(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : RENDER_FONT_TIMEOUT_MS;
  const log = opts.log || { warn: () => {} };
  /** семейство → Promise<Buffer[]> (пустой массив — не вышло; повтор — после вытеснения) */
  const fonts = new Map();
  let warned = false;

  async function get(url, read) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res || !res.ok) throw new Error(`ответ ${res ? res.status : '—'}`);
      return await read(res);
    } finally {
      clearTimeout(t);
    }
  }

  function family(name) {
    const f = catalogFont(name);
    if (!f) return Promise.resolve([]);
    let p = fonts.get(f.family);
    if (p) { fonts.delete(f.family); fonts.set(f.family, p); return p; }   // свежесть для вытеснения
    p = (async () => {
      try {
        const url = `${CSS_ORIGIN}?family=${encodeURIComponent(f.family).replace(/%20/g, '+')}:wght@${f.weights.join(';')}`;
        const css = await get(url, (r) => r.text());
        const files = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+\.ttf)\)/g)].map((m) => m[1]);
        const out = [];
        for (const file of files) {
          if (!file.startsWith(FILE_ORIGIN)) continue;
          const buf = Buffer.from(await get(file, (r) => r.arrayBuffer()));
          if (buf.length && buf.length <= RENDER_FONT_MAX_BYTES) out.push(buf);
        }
        return out;
      } catch (e) {
        if (!warned) { warned = true; log.warn(`[orchestrator/render] шрифт «${f.family}» не получен: ${e && e.message ? e.message : e} — критик посмотрит выжимку`); }
        fonts.delete(f.family);   // не вышло — в следующий раз попробуем снова
        return [];
      }
    })();
    fonts.set(f.family, p);
    while (fonts.size > FONT_CACHE_FAMILIES) fonts.delete(fonts.keys().next().value);
    return p;
  }

  return async function render({ doc, geo, artboardId, maxSide = 1024 } = {}) {
    const mod = opts.resvg !== undefined ? opts.resvg : await loadResvg();
    if (!mod || typeof mod.Resvg !== 'function') return null;
    const out = renderSVG(doc, artboardId, { geo });
    if (!out || !out.svg) return null;
    const names = out.families.length ? out.families : [];
    const lists = await Promise.all([...new Set([...names, DEFAULT_FONT])].map(family));
    const buffers = lists.flat();
    if (names.length && !buffers.length) return null;      // текст есть, а нарисовать его нечем
    const k = Math.min(1, maxSide / Math.max(out.width, out.height, 1));
    const width = Math.max(1, Math.round(out.width * k));
    const svg = out.svg.replace(EMOJI, '');
    const png = new mod.Resvg(svg, {
      fitTo: { mode: 'width', value: width },
      background: '#ffffff',
      font: { fontBuffers: buffers, loadSystemFonts: false, defaultFontFamily: DEFAULT_FONT },
    }).render().asPng();
    return { mime: 'image/png', data: Buffer.from(png).toString('base64'), width, height: Math.max(1, Math.round(out.height * k)) };
  };
}
