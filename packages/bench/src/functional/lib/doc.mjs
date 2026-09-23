// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * Факты о документе из экспорта генератора (data/<name>.json): страницы, наборы id фигур по страницам,
 * источники и распределение их экземпляров. Всё, что нужно проверкам, выбирается отсюда, а не «зашивается».
 */
import { readFileSync } from 'node:fs';

/**
 * @typedef {{id:string, documentId:string, pageId:string, kind:string, fill:string, isSource:boolean,
 *   sourceId:string|null, fillOverridden:boolean, z:number}} Shape
 * @typedef {{id:string, pageId:string, fill:string, instances: Shape[], plainPages: string[], pages: string[]}} SourceInfo
 */

/** @param {string} file */
export function loadDoc(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const docId = String(raw.document.id);
  const ownerId = String(raw.document.ownerId);
  /** @type {{id:string,index:number,name:string}[]} */
  const pages = [...raw.pages].sort((a, b) => a.index - b.index);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const pageByIndex = new Map(pages.map((p) => [p.index, p]));
  /** @type {Map<string, Shape[]>} */
  const shapesByPage = new Map(pages.map((p) => [p.id, []]));
  /** @type {Map<string, Shape>} */
  const shapeById = new Map();
  for (const s of raw.shapes) {
    shapeById.set(s.id, s);
    const arr = shapesByPage.get(s.pageId);
    if (!arr) throw new Error(`shape ${s.id} references unknown page ${s.pageId}`);
    arr.push(s);
  }
  /** @type {Map<string, SourceInfo>} */
  const sources = new Map();
  for (const s of raw.shapes) {
    if (s.isSource) sources.set(s.id, { id: s.id, pageId: s.pageId, fill: s.fill, instances: [], plainPages: [], pages: [] });
  }
  for (const s of raw.shapes) {
    if (s.sourceId) {
      const src = sources.get(s.sourceId);
      if (!src) throw new Error(`instance ${s.id} references unknown source ${s.sourceId}`);
      src.instances.push(s);
    }
  }
  for (const src of sources.values()) {
    const byIndex = (a, b) => (pageById.get(a)?.index ?? 0) - (pageById.get(b)?.index ?? 0);
    src.pages = [...new Set(src.instances.map((i) => i.pageId))].sort(byIndex);
    src.plainPages = [...new Set(src.instances.filter((i) => !i.fillOverridden).map((i) => i.pageId))].sort(byIndex);
  }
  return {
    file,
    raw,
    docId,
    ownerId,
    revision: Number(raw.document.revision ?? 0),
    pages,
    pageById,
    pageByIndex,
    shapesByPage,
    shapeById,
    sources,
    libraryPageId: raw.meta?.libraryPageId ?? null,
    /** @param {number} index */
    pid(index) {
      const p = pageByIndex.get(index);
      if (!p) throw new Error(`no page with index ${index}`);
      return p.id;
    },
    /** @param {string} pageId */
    idsOf(pageId) {
      return (shapesByPage.get(pageId) ?? []).map((s) => s.id).sort();
    },
    /** @param {string} pageId */
    countOf(pageId) {
      return (shapesByPage.get(pageId) ?? []).length;
    },
    /**
     * Источник с непереопределёнными экземплярами не менее чем на `minPlainPages` страницах;
     * предпочтение — источнику с наибольшим числом экземпляров (аналог S* приёмочного документа).
     * @param {{minPlainPages?: number, exclude?: string[]}} [opts]
     */
    pickSource(opts = {}) {
      const min = opts.minPlainPages ?? 3;
      const ex = new Set(opts.exclude ?? []);
      const cands = [...sources.values()].filter((s) => !ex.has(s.id) && s.plainPages.length >= min);
      cands.sort((a, b) => b.instances.length - a.instances.length || a.id.localeCompare(b.id));
      const c = cands[0];
      if (!c) throw new Error(`no source with plain instances on >= ${min} pages`);
      return c;
    },
    /**
     * Непереопределённые экземпляры источника на странице.
     * @param {string} sourceId @param {string} pageId
     */
    plainInstancesOn(sourceId, pageId) {
      const src = sources.get(sourceId);
      if (!src) throw new Error(`unknown source ${sourceId}`);
      return src.instances.filter((i) => i.pageId === pageId && !i.fillOverridden);
    },
    /** @param {string} sourceId @param {string} pageId */
    overriddenInstancesOn(sourceId, pageId) {
      const src = sources.get(sourceId);
      if (!src) throw new Error(`unknown source ${sourceId}`);
      return src.instances.filter((i) => i.pageId === pageId && i.fillOverridden);
    },
    /**
     * Ожидаемые `affectedPages` для setSourceFill: страницы источника и его непереопределённых экземпляров.
     * @param {string} sourceId
     */
    affectedPagesOf(sourceId) {
      const src = sources.get(sourceId);
      if (!src) throw new Error(`unknown source ${sourceId}`);
      return [...new Set([src.pageId, ...src.plainPages])].sort();
    },
    /**
     * Обычная фигура (не источник и не экземпляр) на странице.
     * @param {string} pageId
     */
    plainShapeOn(pageId) {
      const s = (shapesByPage.get(pageId) ?? []).find((x) => !x.isSource && !x.sourceId);
      if (!s) throw new Error(`no plain shape on ${pageId}`);
      return s;
    },
  };
}

/** Цвет, гарантированно не совпадающий ни с одной исходной заливкой документа. */
export function freshColor(doc, seed = 0) {
  const used = new Set(doc.raw.shapes.map((s) => s.fill));
  const palette = ['#00aa00', '#0000aa', '#aa00aa', '#ff8800', '#112233', '#445566', '#778899', '#aabb00', '#00bbaa', '#bb0044', '#123456', '#654321'];
  for (let i = 0; i < palette.length; i += 1) {
    const c = palette[(seed + i) % palette.length];
    if (!used.has(c)) return c;
  }
  for (let n = 0x100000 + seed * 7919; ; n += 7919) {
    const c = `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
    if (!used.has(c)) return c;
  }
}
