/** Инварианты сгенерированного документа (SPEC §1.1, §5). */
import { HEX_COLOR_RE } from '@stand/shared';
import { PAGE_H, PAGE_W, type DocumentFile } from './generate.js';

export interface InvariantsResult {
  ok: boolean;
  errors: string[];
}

export function checkInvariants(doc: DocumentFile): InvariantsResult {
  const errors: string[] = [];
  const p = doc.meta.params;
  const pageIds = new Set(doc.pages.map((x) => x.id));
  const byId = new Map(doc.shapes.map((s) => [s.id, s]));
  const perPage = new Map<string, number>();

  if (doc.pages.length !== p.pages) errors.push(`pages: ${doc.pages.length} != ${p.pages}`);
  const idx = doc.pages.map((x) => x.index).sort((a, b) => a - b);
  idx.forEach((v, i) => {
    if (v !== i + 1) errors.push(`page index sequence broken at ${i}: ${v}`);
  });
  const last = doc.pages.find((x) => x.index === p.pages);
  if (!last || last.name !== 'library') errors.push('last page must be named "library"');

  if (byId.size !== doc.shapes.length) errors.push('duplicate shape ids');
  const zPerPage = new Map<string, Set<number>>();
  for (const s of doc.shapes) {
    perPage.set(s.pageId, (perPage.get(s.pageId) ?? 0) + 1);
    if (!pageIds.has(s.pageId)) errors.push(`${s.id}: unknown page ${s.pageId}`);
    if (s.documentId !== doc.document.id) errors.push(`${s.id}: wrong documentId`);
    if (!HEX_COLOR_RE.test(s.fill)) errors.push(`${s.id}: bad fill ${s.fill}`);
    if (s.x < 0 || s.y < 0 || s.x + s.w > PAGE_W || s.y + s.h > PAGE_H) errors.push(`${s.id}: out of page bounds`);
    if (s.kind === 'text' ? s.text === null : s.text !== null) errors.push(`${s.id}: text/kind mismatch`);
    const zs = zPerPage.get(s.pageId) ?? new Set<number>();
    if (zs.has(s.z)) errors.push(`${s.id}: duplicate z ${s.z} on ${s.pageId}`);
    zs.add(s.z);
    zPerPage.set(s.pageId, zs);
    if (s.isSource) {
      if (s.sourceId !== null) errors.push(`${s.id}: source with sourceId`);
      if (s.pageId !== doc.meta.libraryPageId) errors.push(`${s.id}: source outside library page`);
    }
    if (s.sourceId !== null) {
      const src = byId.get(s.sourceId);
      if (!src || !src.isSource) errors.push(`${s.id}: sourceId ${s.sourceId} is not a source`);
      else if (!s.fillOverridden && s.fill !== src.fill) errors.push(`${s.id}: non-overridden instance fill != source fill`);
    }
  }
  for (const pg of doc.pages) {
    const n = perPage.get(pg.id) ?? 0;
    if (n !== p.shapesPerPage) errors.push(`page ${pg.index}: ${n} shapes != ${p.shapesPerPage}`);
  }

  // --- S1 -------------------------------------------------------------------------------------
  // Дефект B19: раньше «S1 лежит на s1Pages страницах» и «переопределено s1.overridden» сверялись
  // с собственными метаданными документа (`s1.pageIds.length`, `s1.overridden`), то есть с величиной,
  // посчитанной тем же генератором из тех же данных. Такая проверка самоподтверждающаяся: генератор,
  // разложивший экземпляры на другое число страниц, прошёл бы её.
  //
  // Теперь проверка двухслойная:
  //   (1) ДАННЫЕ против ОБЪЯВЛЕННОГО ИНВАРИАНТА — из `doc.meta.params` (`p.s1Instances`, `p.s1Pages`,
  //       `p.overrideShare`, `p.pages`), то есть из того, что заказано генератору, а не из того,
  //       что он о себе написал. Правила восстановлены по шапке `generate.ts` (строки 9–15) и
  //       НЕ импортируются из него — импорт вернул бы самоподтверждение;
  //   (2) МЕТАДАННЫЕ против ДАННЫХ — отдельными строками, чтобы расхождение meta/данные тоже ловилось.
  const s1 = doc.meta.s1;
  const inst = doc.shapes.filter((s) => s.sourceId === s1.id);
  if (inst.length !== p.s1Instances) errors.push(`S1 instances: ${inst.length} != p.s1Instances ${p.s1Instances}`);

  // (1a) число страниц S1: «поровну на s1Pages страницах», но страниц под экземпляры не больше,
  //      чем `pages - 1` (страница 1 не входит в набор, последняя — входит всегда).
  const expectedS1PageCount = p.pages <= 1 ? 1 : Math.min(p.s1Pages, p.pages - 1);
  const byPage = new Map<string, { total: number; overridden: number }>();
  for (const s of inst) {
    const e = byPage.get(s.pageId) ?? { total: 0, overridden: 0 };
    e.total += 1;
    if (s.fillOverridden) e.overridden += 1;
    byPage.set(s.pageId, e);
  }
  if (byPage.size !== expectedS1PageCount) {
    errors.push(
      `S1 pages: ${byPage.size} != expected ${expectedS1PageCount} (from p.s1Pages=${p.s1Pages}, p.pages=${p.pages})`,
    );
  }

  // (1b) «поровну»: p.s1Instances на expectedS1PageCount страниц даёт floor/ceil и разброс ≤ 1.
  if (byPage.size > 0) {
    const perPageLo = Math.floor(p.s1Instances / byPage.size);
    const perPageHi = Math.ceil(p.s1Instances / byPage.size);
    const bad = [...byPage.entries()].filter(([, v]) => v.total < perPageLo || v.total > perPageHi);
    for (const [pid, v] of bad) {
      errors.push(`S1 on ${pid}: ${v.total} instances, expected ${perPageLo}..${perPageHi} (p.s1Instances/${byPage.size})`);
    }
    const sum = [...byPage.values()].reduce((a, v) => a + v.total, 0);
    if (sum !== p.s1Instances) errors.push(`S1 instances by page sum ${sum} != p.s1Instances ${p.s1Instances}`);
  }

  // (1c) последняя (library) страница обязана нести экземпляры S1 — «поздний переход» §1.2 идёт туда.
  if (!byPage.has(doc.meta.libraryPageId) && p.pages >= 1) errors.push('S1 has no instances on the last page');

  // (1d) доля переопределений на каждой странице: round(count·overrideShare), зажатая в [1, count-1]
  //      при 0 < share < 1 и count ≥ 2 (иначе 0 при share=0 и count при share=1).
  const expectedOverridden = (count: number): number => {
    if (p.overrideShare <= 0) return 0;
    if (p.overrideShare >= 1) return count;
    if (count < 2) return 0;
    return Math.min(count - 1, Math.max(1, Math.round(count * p.overrideShare)));
  };
  let overridden = 0;
  for (const [pid, v] of byPage) {
    overridden += v.overridden;
    const exp = expectedOverridden(v.total);
    if (v.overridden !== exp) {
      errors.push(`S1 overridden on ${pid}: ${v.overridden} != ${exp} (p.overrideShare=${p.overrideShare}, ${v.total} instances)`);
    }
  }

  // (1e) на library-странице обязаны быть и переопределённый, и непереопределённый экземпляр S1 —
  //      это и есть проверяемое свойство §1.1 («общая заливка не трогает переопределения»).
  const lastInst = inst.filter((s) => s.pageId === doc.meta.libraryPageId);
  if (p.overrideShare > 0 && p.overrideShare < 1 && lastInst.length >= 2) {
    if (!lastInst.some((s) => s.fillOverridden)) errors.push('last page has no overridden S1 instance');
    if (!lastInst.some((s) => !s.fillOverridden)) errors.push('last page has no non-overridden S1 instance');
  }

  // (2) метаданные документа обязаны описывать те же данные (иначе паспорт документа врёт).
  const s1PageIds = new Set(byPage.keys());
  if (s1.pageIds.length !== s1PageIds.size || s1.pageIds.some((x) => !s1PageIds.has(x))) {
    errors.push(`meta.s1.pageIds [${s1.pageIds.join(',')}] != actual [${[...s1PageIds].sort().join(',')}]`);
  }
  if (s1.instances !== inst.length) errors.push(`meta.s1.instances ${s1.instances} != actual ${inst.length}`);
  if (overridden !== s1.overridden) errors.push(`S1 overridden: ${overridden} != meta ${s1.overridden}`);
  if (s1.notOverridden !== inst.length - overridden) {
    errors.push(`meta.s1.notOverridden ${s1.notOverridden} != actual ${inst.length - overridden}`);
  }
  const smp = s1.samples?.lastPage;
  if (smp) {
    const plain = byId.get(smp.plain);
    const over = byId.get(smp.overridden);
    if (!plain || plain.pageId !== smp.pageId || plain.sourceId !== s1.id || plain.fillOverridden) {
      errors.push(`meta.s1.samples.lastPage.plain "${smp.plain}" is not a non-overridden S1 instance on ${smp.pageId}`);
    }
    if (!over || over.pageId !== smp.pageId || over.sourceId !== s1.id || !over.fillOverridden) {
      errors.push(`meta.s1.samples.lastPage.overridden "${smp.overridden}" is not an overridden S1 instance on ${smp.pageId}`);
    }
  }

  // --- фигурные источники (доля и размещение изменённых экземпляров) ----------------------------
  // Как и у S1: данные сверяются с ОБЪЯВЛЕННЫМ инвариантом (`params.shapedSources`), а не с тем,
  // что генератор написал о себе в `meta.shaped`; метаданные проверяются отдельной строкой.
  const shapedSpecs = p.shapedSources ?? [];
  const shapedInfos = doc.meta.shaped ?? [];
  if (shapedSpecs.length !== shapedInfos.length) {
    errors.push(`meta.shaped: ${shapedInfos.length} entries != params.shapedSources ${shapedSpecs.length}`);
  }
  shapedSpecs.forEach((spec, j) => {
    const id = `${doc.document.id}-src-${p.sources + j + 1}`;
    const src = byId.get(id);
    if (!src || !src.isSource) {
      errors.push(`shaped "${spec.name}": source ${id} is missing or is not a source`);
      return;
    }
    const wantIdx = spec.pages === 'all' ? Array.from({ length: p.pages }, (_, i) => i + 1) : [...new Set(spec.pages)].sort((a, b) => a - b);
    const wantPageIds = new Set(wantIdx.map((i) => doc.pages.find((x) => x.index === i)?.id ?? `?p${i}`));
    const inst = doc.shapes.filter((s) => s.sourceId === id);
    if (inst.length !== wantIdx.length * spec.perPage) {
      errors.push(`shaped "${spec.name}": ${inst.length} instances != ${wantIdx.length}×${spec.perPage}`);
    }
    const perPageMap = new Map<string, { total: number; overridden: number }>();
    for (const s of inst) {
      const e = perPageMap.get(s.pageId) ?? { total: 0, overridden: 0 };
      e.total += 1;
      if (s.fillOverridden) e.overridden += 1;
      perPageMap.set(s.pageId, e);
    }
    for (const pid of perPageMap.keys()) if (!wantPageIds.has(pid)) errors.push(`shaped "${spec.name}": instances on unexpected page ${pid}`);
    for (const pid of wantPageIds) if (!perPageMap.has(pid)) errors.push(`shaped "${spec.name}": no instances on page ${pid}`);
    const share = spec.overrideShare ?? p.overrideShare;
    const expOver = share <= 0 ? 0 : share >= 1 ? spec.perPage : spec.perPage < 2 ? 0 : Math.min(spec.perPage - 1, Math.max(1, Math.round(spec.perPage * share)));
    let overriddenTotal = 0;
    for (const [pid, v] of perPageMap) {
      overriddenTotal += v.overridden;
      if (v.total !== spec.perPage) errors.push(`shaped "${spec.name}" on ${pid}: ${v.total} instances != perPage ${spec.perPage}`);
      if (v.overridden !== expOver) errors.push(`shaped "${spec.name}" on ${pid}: ${v.overridden} overridden != expected ${expOver} (share ${share})`);
    }
    const info = shapedInfos[j];
    if (!info) {
      errors.push(`shaped "${spec.name}": no meta.shaped entry`);
      return;
    }
    if (info.id !== id || info.name !== spec.name) errors.push(`meta.shaped[${j}]: ${info.name}/${info.id} != ${spec.name}/${id}`);
    if (info.instances !== inst.length) errors.push(`meta.shaped[${j}].instances ${info.instances} != actual ${inst.length}`);
    if (info.overridden !== overriddenTotal) errors.push(`meta.shaped[${j}].overridden ${info.overridden} != actual ${overriddenTotal}`);
    if (info.affectedShapes !== inst.length - overriddenTotal + 1) {
      errors.push(`meta.shaped[${j}].affectedShapes ${info.affectedShapes} != actual ${inst.length - overriddenTotal + 1}`);
    }
    const affectedPages = new Set([...perPageMap.keys(), doc.meta.libraryPageId]).size;
    if (info.affectedPages !== affectedPages) errors.push(`meta.shaped[${j}].affectedPages ${info.affectedPages} != actual ${affectedPages}`);
  });

  const sources = doc.shapes.filter((s) => s.isSource).length;
  const expectedSources = p.sources + shapedSpecs.length;
  if (sources !== expectedSources) errors.push(`sources: ${sources} != ${expectedSources}`);
  if (doc.meta.sourceCount !== sources) errors.push(`meta.sourceCount ${doc.meta.sourceCount} != actual ${sources}`);

  // Общее число экземпляров, объявленное метаданными, — против фактического.
  const actualInstances = doc.shapes.filter((s) => s.sourceId !== null).length;
  if (doc.meta.instanceCount !== actualInstances) {
    errors.push(`meta.instanceCount ${doc.meta.instanceCount} != actual ${actualInstances}`);
  }

  return { ok: errors.length === 0, errors };
}
