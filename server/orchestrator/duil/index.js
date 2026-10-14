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
import { MAX_LIBRARIES, PROJECT_LIST_TTL_MS } from '../limits.js';

/**
 * @param {{dslr: ReturnType<import('../dslr/index.js').createDslrClient>, log?: object}} o
 */
export function createDuil({ dslr, log = console }) {
  let listed = null;   // {at, projects}

  async function libraries(signal) {
    if (listed && Date.now() - listed.at < PROJECT_LIST_TTL_MS) return listed.projects;
    const all = await dslr.list({ signal });
    const projects = all.filter((p) => p && p.kind === 'library');
    listed = { at: Date.now(), projects };
    return projects;
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
        const text = describeLibrary(st.doc, core) || '';
        const components = text ? Math.max(0, text.split('\n').length - 1) : 0;
        out.libraries.push({ id: p.id, name: p.name || '', head_seq: st.seq, components });
        if (text) texts.push(`[${p.name || p.id}]\n${text}`);
        const slim = components ? libraryDocOf(st.doc, core) : null;
        if (slim) out.docs.push({ id: p.id, name: p.name || '', doc: slim });
      } catch (e) {
        out.warnings.push(`Библиотека «${p.name || p.id}» не прочиталась`);
        log.warn(`[orchestrator/duil] библиотека ${p.id}: ${e.message}`);
      }
    }
    out.text = texts.join('\n\n');
    return out;
  }

  return { slice };
}
