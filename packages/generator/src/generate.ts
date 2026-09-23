/**
 * Детерминированная генерация документа (SPEC §5).
 *
 * Решения (см. README):
 *  - Всего страниц ровно `pages`; индексы 1..N. Страницы 1..N-1 называются `Page k`,
 *    ПОСЛЕДНЯЯ страница (index = N) называется `library` и содержит ВСЕ источники.
 *    Так страница 1 — обычная, а приёмочный маршрут (…, 50) заканчивается на странице с библиотекой.
 *  - Каждая страница содержит ровно `shapesPerPage` фигур (источники и экземпляры входят в это число).
 *  - Источник S1 = `${docId}-src-1` имеет ровно `s1Instances` (по умолчанию 100) экземпляров,
 *    разложенных поровну на `s1Pages` (по умолчанию 10) страницах; набор страниц детерминирован,
 *    всегда включает последнюю страницу N и страницу 2 (при N ≥ 2). Для N=50, K=10:
 *    страницы 2,7,12,17,22,28,33,38,43,50. На КАЖДОЙ из этих страниц есть и переопределённые,
 *    и непереопределённые экземпляры S1 (доля `overrideShare`, но не менее 1 и не более perPage-1).
 *  - Остальные источники получают `instancesPerSource` экземпляров на случайных страницах 1..N,
 *    каждый переопределён с вероятностью `overrideShare`.
 *  - Идентификаторы: документ `docId`; страница `${docId}-p${index}`; источник `${docId}-src-${k}`;
 *    экземпляр `${docId}-inst-${k}-${m}`; обычная фигура `${docId}-p${index}-s${n}`.
 *  - z уникален в пределах страницы: 0..shapesPerPage-1 после детерминированного перемешивания.
 *  - ФИГУРНЫЕ ИСТОЧНИКИ (`shapedSources`, введены для серии `command-shape`): источники с ЗАДАННЫМ
 *    размещением экземпляров — «ровно `perPage` экземпляров на каждой из перечисленных страниц».
 *    Ими задаются доля изменённых объектов и их размещение (введение: «одна команда может
 *    затронуть множество фигур на одной странице либо по одной фигуре на многих страницах»).
 *    Нумеруются ПОСЛЕ обычных источников (`sources + 1 …`), а генерируются ПОСЛЕ экземпляров
 *    обычных источников: поэтому при одном seed страницы, экземпляры S1 и экземпляры источников
 *    2…sources совпадают с документом без `shapedSources` (различается только добивка обычными
 *    фигурами, которых становится меньше).
 */
import type { Shape, ShapeKind } from '@stand/shared';
import { Prng } from './prng.js';

export const GENERATOR_VERSION = '1.0.0';
export const FILE_FORMAT = 'stand-doc/1';

export const PAGE_W = 1920;
export const PAGE_H = 1080;

/**
 * Источник с ЗАДАННЫМ размещением экземпляров: ровно `perPage` экземпляров на каждой странице из
 * `pages`. Нужен, чтобы варьировать долю изменённых объектов и их размещение при неизменных
 * размерах документа (серия `command-shape`).
 */
export interface ShapedSourceParams {
  /** имя варианта (в метаданных и в конфигурации серии), например 'concentrated'. */
  name: string;
  /** страницы с экземплярами: 1-based индексы или 'all' (1…pages). */
  pages: number[] | 'all';
  /** сколько экземпляров на КАЖДОЙ из этих страниц. */
  perPage: number;
  /** доля переопределённых на странице; по умолчанию — `overrideShare` документа. */
  overrideShare?: number;
}

export interface GenParams {
  pages: number;
  shapesPerPage: number;
  sources: number;
  instancesPerSource: number;
  overrideShare: number;
  seed: number;
  owner: string;
  name: string;
  id: string;
  /** Число экземпляров S1 (SPEC: 100). */
  s1Instances: number;
  /** Число страниц, на которых лежат экземпляры S1 (SPEC: 10). */
  s1Pages: number;
  /** Источники с заданным размещением экземпляров (по умолчанию — нет). */
  shapedSources?: ShapedSourceParams[];
}

export interface PageRecord {
  id: string;
  documentId: string;
  index: number;
  name: string;
}

export interface DocumentRecord {
  id: string;
  ownerId: string;
  name: string;
  revision: number;
}

export interface S1Info {
  id: string;
  pageIds: string[];
  pageIndexes: number[];
  instances: number;
  overridden: number;
  notOverridden: number;
  /** id одного непереопределённого и одного переопределённого экземпляра на последней странице (для проверок). */
  samples: { lastPage: { pageId: string; plain: string; overridden: string } };
}

/** Фактическое размещение фигурного источника (и предсказание результата команды над ним). */
export interface ShapedSourceInfo {
  name: string;
  id: string;
  pageIndexes: number[];
  pageIds: string[];
  perPage: number;
  instances: number;
  overridden: number;
  notOverridden: number;
  /** сколько фигур изменит `setSourceFill` по этому источнику: источник + непереопределённые. */
  affectedShapes: number;
  /** сколько страниц он затронет: страницы экземпляров + страница библиотеки (там лежит источник). */
  affectedPages: number;
}

export interface DocumentFile {
  meta: {
    format: typeof FILE_FORMAT;
    generatorVersion: string;
    params: GenParams;
    pageCount: number;
    shapeCount: number;
    sourceCount: number;
    instanceCount: number;
    libraryPageId: string;
    s1: S1Info;
    /** фигурные источники (если заданы `params.shapedSources`). */
    shaped?: ShapedSourceInfo[];
  };
  document: DocumentRecord;
  pages: PageRecord[];
  shapes: Shape[];
}

const WORDS = [
  'Title', 'Button', 'Label', 'Header', 'Footer', 'Card', 'Hero', 'Nav', 'Price', 'Total',
  'Sign in', 'Sign up', 'Search', 'Submit', 'Cancel', 'OK', 'Next', 'Back', 'Home', 'About',
  'Contact', 'Profile', 'Settings', 'Save', 'Delete', 'Edit', 'Share', 'Export', 'Import', 'Help',
];

/** Страницы для экземпляров S1: всегда включают N; при N ≥ 2 — страницу 2; равномерно по 2..N. */
export function chooseS1Pages(pageCount: number, wanted: number): number[] {
  if (pageCount <= 1) return [1];
  const k = Math.max(1, Math.min(wanted, pageCount - 1));
  if (pageCount - 1 <= k) {
    const all: number[] = [];
    for (let i = 2; i <= pageCount; i++) all.push(i);
    return all;
  }
  const out: number[] = [];
  // k-1 страниц равномерно в [2, N-1] плюс N.
  for (let i = 0; i < k - 1; i++) {
    out.push(2 + Math.floor(((pageCount - 3) * i) / (k - 1)));
  }
  out.push(pageCount);
  return [...new Set(out)];
}

/** Поровну с остатком в начале: 100 на 9 страниц → 12,11,11,... */
function splitEvenly(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  let rest = total - base * parts;
  const out: number[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(base + (rest > 0 ? 1 : 0));
    if (rest > 0) rest--;
  }
  return out;
}

function overriddenCount(perPage: number, share: number): number {
  if (share <= 0) return 0;
  if (share >= 1) return perPage;
  if (perPage < 2) return 0;
  const n = Math.round(perPage * share);
  return Math.min(perPage - 1, Math.max(1, n));
}

interface Geometry {
  kind: ShapeKind;
  w: number;
  h: number;
  text: string | null;
}

function randomGeometry(rng: Prng): Geometry {
  const r = rng.next();
  const kind: ShapeKind = r < 0.3 ? 'text' : r < 0.75 ? 'rect' : 'ellipse';
  if (kind === 'text') {
    const words = rng.int(1, 3);
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(rng.pick(WORDS));
    const text = parts.join(' ');
    return { kind, w: Math.min(400, 24 + text.length * 9), h: rng.int(16, 40), text };
  }
  return { kind, w: rng.int(24, 400), h: rng.int(24, 300), text: null };
}

function place(rng: Prng, g: Geometry): { x: number; y: number } {
  return { x: rng.int(0, PAGE_W - g.w), y: rng.int(0, PAGE_H - g.h) };
}

function differentColor(rng: Prng, notThis: string): string {
  let c = rng.hexColor();
  while (c === notThis) c = rng.hexColor();
  return c;
}

export function normalizeParams(p: Partial<GenParams> & { name: string }): GenParams {
  const pages = p.pages ?? 5;
  return {
    pages,
    shapesPerPage: p.shapesPerPage ?? 100,
    sources: p.sources ?? 5,
    instancesPerSource: p.instancesPerSource ?? 10,
    overrideShare: p.overrideShare ?? 0.2,
    seed: p.seed ?? 1,
    owner: p.owner ?? 'u-alice',
    name: p.name,
    id: p.id ?? `doc-${p.name}`,
    s1Instances: p.s1Instances ?? 100,
    s1Pages: p.s1Pages ?? 10,
    ...(p.shapedSources ? { shapedSources: p.shapedSources } : {}),
  };
}

/** Страницы фигурного источника: 'all' → 1…pages; список — как задан (дедуплицирован, по возрастанию). */
export function shapedPageIndexes(spec: ShapedSourceParams, pageCount: number): number[] {
  const list = spec.pages === 'all' ? Array.from({ length: pageCount }, (_, i) => i + 1) : spec.pages;
  const out = [...new Set(list)].sort((a, b) => a - b);
  for (const i of out) {
    if (!Number.isInteger(i) || i < 1 || i > pageCount) throw new Error(`shapedSources["${spec.name}"]: page ${i} is outside 1..${pageCount}`);
  }
  if (out.length === 0) throw new Error(`shapedSources["${spec.name}"]: no pages`);
  if (!Number.isInteger(spec.perPage) || spec.perPage < 1) throw new Error(`shapedSources["${spec.name}"]: perPage must be >= 1`);
  return out;
}

export function generateDocument(input: Partial<GenParams> & { name: string }): DocumentFile {
  const p = normalizeParams(input);
  if (!Number.isInteger(p.pages) || p.pages < 1) throw new Error('pages must be >= 1');
  if (!Number.isInteger(p.shapesPerPage) || p.shapesPerPage < 1) throw new Error('shapesPerPage must be >= 1');
  if (!Number.isInteger(p.sources) || p.sources < 1) throw new Error('sources must be >= 1');
  if (p.overrideShare < 0 || p.overrideShare > 1) throw new Error('overrideShare must be in [0, 1]');

  const rng = new Prng(p.seed);
  const docId = p.id;
  const document: DocumentRecord = { id: docId, ownerId: p.owner, name: p.name, revision: 0 };

  const pages: PageRecord[] = [];
  for (let i = 1; i <= p.pages; i++) {
    pages.push({
      id: `${docId}-p${i}`,
      documentId: docId,
      index: i,
      name: i === p.pages ? 'library' : `Page ${i}`,
    });
  }
  const pageById = (index: number): PageRecord => pages[index - 1]!;
  const libraryPage = pageById(p.pages);

  // Фигуры по страницам (без z; z назначается после перемешивания).
  const perPage: Shape[][] = pages.map(() => []);
  const push = (pageIndex: number, s: Shape) => perPage[pageIndex - 1]!.push(s);

  const mkShape = (id: string, page: PageRecord, g: Geometry, fill: string, extra: Partial<Shape> = {}): Shape => {
    const { x, y } = place(rng, g);
    return {
      id,
      documentId: docId,
      pageId: page.id,
      kind: g.kind,
      x,
      y,
      w: g.w,
      h: g.h,
      z: 0,
      text: g.text,
      fill,
      isSource: false,
      sourceId: null,
      fillOverridden: false,
      ...extra,
    };
  };

  // 1. Источники — все на странице library.
  const sources: Array<{ shape: Shape; g: Geometry }> = [];
  for (let k = 1; k <= p.sources; k++) {
    const g = randomGeometry(rng);
    const s = mkShape(`${docId}-src-${k}`, libraryPage, g, rng.hexColor(), { isSource: true });
    sources.push({ shape: s, g });
    push(p.pages, s);
  }

  // 2. Экземпляры S1: ровно s1Instances на s1Pages страницах, поровну.
  const s1 = sources[0]!;
  const s1PageIdx = chooseS1Pages(p.pages, p.s1Pages);
  const s1Counts = splitEvenly(p.s1Instances, s1PageIdx.length);
  let s1Overridden = 0;
  let instSeq = 0;
  let lastPagePlain = '';
  let lastPageOverridden = '';
  s1PageIdx.forEach((pageIndex, i) => {
    const count = s1Counts[i]!;
    const nOver = overriddenCount(count, p.overrideShare);
    const page = pageById(pageIndex);
    for (let m = 0; m < count; m++) {
      const overridden = m < nOver;
      instSeq++;
      const id = `${docId}-inst-1-${instSeq}`;
      const fill = overridden ? differentColor(rng, s1.shape.fill) : s1.shape.fill;
      push(pageIndex, mkShape(id, page, s1.g, fill, { sourceId: s1.shape.id, fillOverridden: overridden }));
      if (overridden) s1Overridden++;
      if (pageIndex === p.pages) {
        if (overridden && !lastPageOverridden) lastPageOverridden = id;
        if (!overridden && !lastPagePlain) lastPagePlain = id;
      }
    }
  });

  // 3. Остальные источники: instancesPerSource экземпляров на случайных страницах.
  let instanceCount = p.s1Instances;
  for (let k = 2; k <= p.sources; k++) {
    const src = sources[k - 1]!;
    for (let m = 1; m <= p.instancesPerSource; m++) {
      const pageIndex = rng.int(1, p.pages);
      const page = pageById(pageIndex);
      const overridden = rng.next() < p.overrideShare;
      const fill = overridden ? differentColor(rng, src.shape.fill) : src.shape.fill;
      push(pageIndex, mkShape(`${docId}-inst-${k}-${m}`, page, src.g, fill, { sourceId: src.shape.id, fillOverridden: overridden }));
      instanceCount++;
    }
  }

  // 3b. Фигурные источники: ровно perPage экземпляров на каждой заданной странице.
  //     Номера продолжают обычные источники, поэтому id вида `${docId}-src-${sources+j}`.
  const shapedSpecs = p.shapedSources ?? [];
  const shaped: ShapedSourceInfo[] = [];
  shapedSpecs.forEach((spec, j) => {
    const k = p.sources + j + 1;
    const g = randomGeometry(rng);
    const srcShape = mkShape(`${docId}-src-${k}`, libraryPage, g, rng.hexColor(), { isSource: true });
    push(p.pages, srcShape);
    const idxs = shapedPageIndexes(spec, p.pages);
    const share = spec.overrideShare ?? p.overrideShare;
    const nOver = overriddenCount(spec.perPage, share);
    let seq = 0;
    let overridden = 0;
    for (const pageIndex of idxs) {
      const page = pageById(pageIndex);
      for (let m = 0; m < spec.perPage; m++) {
        const isOver = m < nOver;
        seq++;
        const fill = isOver ? differentColor(rng, srcShape.fill) : srcShape.fill;
        push(pageIndex, mkShape(`${docId}-inst-${k}-${seq}`, page, g, fill, { sourceId: srcShape.id, fillOverridden: isOver }));
        if (isOver) overridden++;
      }
    }
    const instances = idxs.length * spec.perPage;
    instanceCount += instances;
    const affectedPageSet = new Set([...idxs.map((i) => pageById(i).id), libraryPage.id]);
    shaped.push({
      name: spec.name,
      id: srcShape.id,
      pageIndexes: idxs,
      pageIds: idxs.map((i) => pageById(i).id),
      perPage: spec.perPage,
      instances,
      overridden,
      notOverridden: instances - overridden,
      // `setSourceFill` меняет сам источник и непереопределённые экземпляры (SPEC §1, §2.3)
      affectedShapes: instances - overridden + 1,
      affectedPages: affectedPageSet.size,
    });
  });

  // 4. Бюджет страниц и добивка обычными фигурами до shapesPerPage.
  for (let i = 1; i <= p.pages; i++) {
    const page = pageById(i);
    const list = perPage[i - 1]!;
    if (list.length > p.shapesPerPage) {
      throw new Error(
        `page ${i} (${page.name}) needs ${list.length} shapes for sources/instances, but shapesPerPage=${p.shapesPerPage}; ` +
          'reduce sources/instancesPerSource/s1Instances or raise shapesPerPage',
      );
    }
    let n = 0;
    while (list.length < p.shapesPerPage) {
      n++;
      const g = randomGeometry(rng);
      list.push(mkShape(`${docId}-p${i}-s${n}`, page, g, rng.hexColor()));
    }
    // Детерминированное перемешивание и уникальный z.
    rng.shuffle(list);
    list.forEach((s, z) => {
      s.z = z;
    });
  }

  const shapes = perPage.flat();
  const s1Info: S1Info = {
    id: s1.shape.id,
    pageIds: s1PageIdx.map((i) => pageById(i).id),
    pageIndexes: s1PageIdx,
    instances: p.s1Instances,
    overridden: s1Overridden,
    notOverridden: p.s1Instances - s1Overridden,
    samples: { lastPage: { pageId: libraryPage.id, plain: lastPagePlain, overridden: lastPageOverridden } },
  };

  return {
    meta: {
      format: FILE_FORMAT,
      generatorVersion: GENERATOR_VERSION,
      params: p,
      pageCount: pages.length,
      shapeCount: shapes.length,
      sourceCount: p.sources + shapedSpecs.length,
      instanceCount,
      libraryPageId: libraryPage.id,
      s1: s1Info,
      ...(shaped.length ? { shaped } : {}),
    },
    document,
    pages,
    shapes,
  };
}
