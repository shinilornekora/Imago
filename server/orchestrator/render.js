/**
 * Снимок доски для критика агента (SPEC §14.4): SVG — та же отрисовка, что у редактора
 * (`core.renderSVG`, без страницы), PNG — `@resvg/resvg-js` (необязательная зависимость),
 * шрифты — TTF с Google Fonts (css2 без браузерного User-Agent отдаёт truetype).
 *
 * Живёт в воркере DSLV: brain зовёт `render({doc, geo, artboardId, signal})` между вызовами
 * модели (воркер на это время сообщает пулу «жду сеть», как при вызове модели). Ширина снимка —
 * до 768 px, высота — до 1536 px (дальше верх доски, `cropped`). Всё, что может не выйти, даёт
 * `null`, и критик судит по выжимке:
 *   • resvg не установлен (сборка без необязательных зависимостей);
 *   • не пришло хоть одно семейство доски — снимок нарисовал бы его чужим шрифтом; неудача
 *     помнится 10 минут (закрытая сеть не держит каждую команду), общий срок снимка — 12 с;
 *   • SVG не собрался или resvg его не принял.
 * Node `fetch` не ходит через HTTPS_PROXY: за прокси снимков не будет — критик по выжимке.
 * Эмодзи из текста убираются: цветного эмодзи-шрифта нет, и resvg отбрасывал бы весь кусок
 * текста с ним («15 🍪» терял и «15»).
 *
 * Ходит только на fonts.googleapis.com и fonts.gstatic.com, только за семействами каталога
 * (src/fonts.js) и только в начертаниях, которые там есть. Кеш — в памяти воркера, по
 * семейству, не больше FONT_CACHE_FAMILIES семейств (старые вытесняются).
 */

import { renderSVG } from '../../src/core.js';
import { catalogFont, DEFAULT_FONT } from '../../src/fonts.js';
import { RENDER_FONT_TIMEOUT_MS, FONT_CACHE_FAMILIES, RENDER_FONT_MAX_BYTES, RENDER_DEADLINE_MS, RENDER_FONT_FAIL_TTL_MS } from './limits.js';

const CSS_ORIGIN = 'https://fonts.googleapis.com/css2';
const FILE_ORIGIN = 'https://fonts.gstatic.com/';
/**
 * Эмодзи-картинки: знаки с эмодзи-видом по умолчанию, вариант-селектор, склейка и колпачок.
 * ©, ®, ™, стрелки и ☀ (Extended_Pictographic, но текстового вида) остаются — шрифты их рисуют.
 */
export const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F}|[\u{FE0F}\u{200D}\u{20E3}]/gu;
/** Снимок для критика: ширина до 768 px, высота до 1536 px (дальше — верх доски). */
const SHOT_W = 768;
const SHOT_H = 1536;

let resvgModule;   // undefined — не пробовали; null — нет

/** resvg-js, если установлен. */
async function loadResvg() {
  if (resvgModule === undefined) {
    try { resvgModule = await import('@resvg/resvg-js'); } catch { resvgModule = null; }
  }
  return resvgModule;
}

/** Тело ответа с потолком: заголовок длины и сам поток — не больше max байт. */
async function readCapped(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error(`файл ${len} байт — больше ${max}`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error(`файл больше ${max} байт`);
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > max) { try { await reader.cancel(); } catch { /* закрыт */ } throw new Error(`файл больше ${max} байт`); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/**
 * @param {{fetch?: typeof fetch, timeoutMs?: number, deadlineMs?: number, failTtlMs?: number,
 *   log?: {warn: Function}, resvg?: object|null, now?: () => number}} [opts]
 *   resvg — подмена модуля (тесты: null — «не установлен»)
 * @returns {(args: {doc: object, geo?: object, artboardId: string, signal?: AbortSignal}) =>
 *   Promise<{mime: string, data: string, width: number, height: number, cropped: boolean, fullHeight: number, approxText: true}|null>}
 */
export function createRenderer(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : RENDER_FONT_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs > 0 ? opts.deadlineMs : RENDER_DEADLINE_MS;
  const failTtl = opts.failTtlMs > 0 ? opts.failTtlMs : RENDER_FONT_FAIL_TTL_MS;
  const log = opts.log || { warn: (m) => console.warn(m) };
  const now = opts.now || (() => Date.now());
  /** семейство → Promise<Buffer[]> */
  const fonts = new Map();
  /** семейство → до какого мига не пробовать снова (сеть закрыта — не ждём срок на каждой команде) */
  const failed = new Map();
  let warnedAt = -Infinity;

  async function get(url, read, signal) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // без переходов: адрес проверен, а переадресация увела бы запрос куда угодно
      const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'error' });
      if (!res || !res.ok) throw new Error(`ответ ${res ? res.status : '—'}`);
      return await read(res);
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function family(name, signal) {
    const f = catalogFont(name);
    if (!f) return Promise.resolve([]);
    if ((failed.get(f.family) || 0) > now()) return Promise.resolve([]);
    let p = fonts.get(f.family);
    if (p) { fonts.delete(f.family); fonts.set(f.family, p); return p; }   // свежесть для вытеснения
    p = (async () => {
      try {
        const url = `${CSS_ORIGIN}?family=${encodeURIComponent(f.family).replace(/%20/g, '+')}:wght@${f.weights.join(';')}`;
        const css = (await get(url, (r) => readCapped(r, 256 * 1024), signal)).toString('utf8');
        const files = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+\.ttf)\)/g)].map((m) => m[1]);
        const out = [];
        for (const file of files) {
          if (!file.startsWith(FILE_ORIGIN)) continue;
          const buf = await get(file, (r) => readCapped(r, RENDER_FONT_MAX_BYTES), signal);
          if (buf.length) out.push(buf);
        }
        if (!out.length) throw new Error('в стилях нет файлов');
        return out;
      } catch (e) {
        fonts.delete(f.family);
        if (signal && signal.aborted) return [];          // отменили команду — сеть не виновата
        failed.set(f.family, now() + failTtl);
        // одна строка на причину не чаще раза в минуту (как советы администратору, круг 26)
        if (now() - warnedAt > 60000) {
          warnedAt = now();
          log.warn(`[orchestrator/render] шрифт «${f.family}» не получен (${e && e.message ? e.message : e}) — критик посмотрит описание доски; снова попробую через ${Math.round(failTtl / 60000)} мин`);
        }
        return [];
      }
    })();
    fonts.set(f.family, p);
    while (fonts.size > FONT_CACHE_FAMILIES) fonts.delete(fonts.keys().next().value);
    return p;
  }

  async function shot({ doc, geo, artboardId, signal }) {
    const mod = opts.resvg !== undefined ? opts.resvg : await loadResvg();
    if (!mod || typeof mod.Resvg !== 'function') return null;
    const rect = geo && geo.rects ? geo.rects[artboardId] : null;
    const k = rect && rect.w > 0 ? Math.min(1, SHOT_W / rect.w) : 1;
    const out = renderSVG(doc, artboardId, { geo, maxHeight: SHOT_H / k });
    if (!out || !out.svg) return null;
    const need = out.families;
    const lists = await Promise.all([...new Set([...need, DEFAULT_FONT])].map((n) => family(n, signal)));
    // семейство доски не пришло — снимок нарисовал бы его чужим шрифтом и обманул критика
    const byName = new Map([...new Set([...need, DEFAULT_FONT])].map((n, i) => [n, lists[i]]));
    if (need.some((n) => catalogFont(n) && !byName.get(n).length)) return null;
    if (need.length && !lists.flat().length) return null;
    const width = Math.max(1, Math.round(out.width * k));
    try {
      const png = new mod.Resvg(out.svg.replace(EMOJI_RE, ''), {
        fitTo: { mode: 'width', value: width },
        background: '#ffffff',
        font: { fontBuffers: lists.flat(), loadSystemFonts: false, defaultFontFamily: DEFAULT_FONT },
      }).render().asPng();
      return {
        mime: 'image/png', data: Buffer.from(png).toString('base64'),
        width, height: Math.max(1, Math.round(out.height * k)), cropped: out.cropped, fullHeight: out.fullHeight,
        // ширины строк на сервере — приближённые (canvas нет): переносы могут не совпасть с экраном
        approxText: true,
      };
    } catch (e) {
      log.warn(`[orchestrator/render] снимок не собрался: ${e && e.message ? e.message : e}`);
      return null;
    }
  }

  /** Общий срок снимка: сеть не держит команду дольше deadlineMs. */
  return async function render(args = {}) {
    let timer = null;
    const ctl = new AbortController();
    const outer = args.signal;
    const onAbort = () => ctl.abort();
    if (outer) { if (outer.aborted) return null; outer.addEventListener('abort', onAbort, { once: true }); }
    try {
      return await Promise.race([
        shot({ ...args, signal: ctl.signal }),
        new Promise((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve(null); }, deadlineMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  };
}
