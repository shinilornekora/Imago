/**
 * DUIL (SPEC §10.1, стрелки 6/7): срез библиотек — проекты вида `library` (через тот же
 * DSLR-клиент, с тем же кешем по head_seq) → внешний словарь компонентов для прогона brain
 * (`runCommand({library})`, §10.6): выжимки документов-библиотек (`libraryDocOf` — корень,
 * страница библиотеки, мастера), по порядку списка проектов. brain сам дополняет ими
 * библиотеку документа (имена документа главнее) и переносит использованные мастера.
 *
 * Шаг не роковой: библиотека недоступна — команда идёт дальше со словарём из самого
 * документа (мастера, материализованные в нём, brain видит и так, §5.3), а в трассе и
 * предупреждениях остаётся строка.
 */

import * as core from '../../../src/core.js';
import { describeLibrary, libraryDocOf } from '../../../src/brain.js';
import { MAX_LIBRARIES, PROJECT_LIST_TTL_MS, PROJECT_LIST_STALE_MS } from '../limits.js';

/**
 * Круг 25: раньше каждая команда (раз в 5 с) читала ВЕСЬ `GET /api/projects` — на
 * сервисе с тысячами проектов это мегабайты на команду, — и каждый раз заново считала
 * словарь и выжимку каждой библиотеки. Теперь:
 *   • список библиотек живёт `PROJECT_LIST_TTL_MS` (60 с), одно чтение на всех
 *     (параллельные команды ждут то же); не прочитался — берётся прежний, пока он не
 *     старше `PROJECT_LIST_STALE_MS`; запрос — с `?kind=library&limit=` (сервис, который
 *     фильтр знает, отдаст только библиотеки, новые первыми; прочий — всё, фильтруем сами);
 *   • свежесть самих библиотек — по их журналу через DSLR (дочитывание хвоста,
 *     дёшево), словарь и выжимка пересчитываются только при новом head_seq.
 * @param {{dslr: ReturnType<import('../dslr/index.js').createDslrClient>, log?: object, listTtlMs?: number}} o
 */
export function createDuil({ dslr, log = console, listTtlMs = PROJECT_LIST_TTL_MS }) {
  let listed = null;      // {at, projects}
  let listing = null;     // идущее чтение списка (одно на всех)
  const derived = new Map();   // id → {seq, text, components, slim}
  const stats = { lists: 0, derived: 0 };

  async function libraries(signal) {
    if (listed && Date.now() - listed.at < listTtlMs) return listed.projects;
    if (!listing) {
      listing = (async () => {
        try {
          // круг 26: сервис режет список на страницы (по умолчанию 200) — берём ровно
          // столько, сколько пойдёт в прогон (плюс сам проект команды, его исключаем)
          const all = await dslr.list({ query: `kind=library&limit=${MAX_LIBRARIES + 1}` });
          stats.lists++;
          const projects = all.filter((p) => p && p.kind === 'library');
          listed = { at: Date.now(), projects };
          // выжимки библиотек, которых больше нет, — вон
          const keep = new Set(projects.map((p) => p.id));
          for (const id of derived.keys()) if (!keep.has(id)) derived.delete(id);
          return projects;
        } finally {
          listing = null;
        }
      })();
    }
    try {
      return await abortable(listing, signal);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (listed && Date.now() - listed.at < PROJECT_LIST_STALE_MS) {
        log.warn(`[orchestrator/duil] список проектов: ${e.message} — беру прежний`);
        return listed.projects;
      }
      throw e;
    }
  }

  /** Словарь и выжимка библиотеки на её голове (пересчёт — только при новом seq). */
  function derive(id, st) {
    const hit = derived.get(id);
    if (hit && hit.seq === st.seq) return hit;
    const text = describeLibrary(st.doc, core) || '';
    const components = text ? Math.max(0, text.split('\n').length - 1) : 0;
    const slim = components ? libraryDocOf(st.doc, core) : null;
    const entry = { seq: st.seq, text, components, slim };
    derived.set(id, entry);
    stats.derived++;
    return entry;
  }

  /**
   * @param {{exclude?: string, signal?: AbortSignal}} [o]
   * @returns {Promise<{libraries: {id, name, head_seq, components: number}[], docs: {id, name, doc}[], text: string, warnings: string[]}>}
   *   `docs` — словарь в прогон (`library` у runCommand/runVariants); `text` — он же словами (трасса, отладка)
   */
  async function slice({ exclude, signal } = {}) {
    const out = { libraries: [], docs: [], text: '', warnings: [] };
    let list;
    try {
      list = await libraries(signal);
    } catch (e) {
      out.warnings.push('Библиотеки не прочитались — работаю со словарём из самого документа');
      log.warn(`[orchestrator/duil] список проектов: ${e.message}`);
      return out;
    }
    const texts = [];
    for (const p of list.filter((x) => x.id !== exclude).slice(0, MAX_LIBRARIES)) {
      try {
        const st = await dslr.read(p.id, { signal });
        const d = derive(p.id, st);
        out.libraries.push({ id: p.id, name: p.name || '', head_seq: st.seq, components: d.components });
        if (d.text) texts.push(`[${p.name || p.id}]\n${d.text}`);
        if (d.slim) out.docs.push({ id: p.id, name: p.name || '', doc: d.slim });
      } catch (e) {
        if (e && e.code === 'not_found') { listed = null; derived.delete(p.id); }
        out.warnings.push(`Библиотека «${p.name || p.id}» не прочиталась`);
        log.warn(`[orchestrator/duil] библиотека ${p.id}: ${e.message}`);
      }
    }
    out.text = texts.join('\n\n');
    return out;
  }

  return { slice, stats, /** тестам: забыть список */ invalidate: () => { listed = null; } };
}

/** Ждать общего промиса, но уйти по своему сигналу (чтение списка не прерывается — оно общее). */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('остановлено'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('остановлено'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
