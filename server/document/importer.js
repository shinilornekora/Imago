/**
 * Подготовка нового проекта (`POST /api/projects`, круг 33): разбор тела, проверка и
 * приведение документа импорта — `cleanDeep`, `core.checkImportDoc`, `core.createDoc`, глубина
 * дерева, байты JSON. На документе в 20 тыс. узлов это ~0,6 с чистого счёта: прежде он шёл в
 * цикле событий, и 8 одновременных импортов держали запись соседних проектов секунды. Теперь
 * большое тело готовится в отдельном потоке (`import-worker.js`, пул на IMPORT_CONCURRENCY
 * потоков, очередь IMPORT_QUEUE), маленькое — здесь же, той же функцией.
 *
 * Ошибки — `{status, code, message, detail}` (DocError в главном потоке; из потока — простым
 * объектом, http.js превращает его в DocError).
 */

import { createHash } from 'node:crypto';
import * as core from '../../src/core.js';
import { createDoc } from '../../src/core.js';
import { DocError, badRequest, tooLarge } from './errors.js';
import { MAX_DOC_NODES, MAX_DOC_BYTES, MAX_VALUE_DEPTH, cleanMeta, cutText, cleanDeep, showValue } from './limits.js';
import { EXPAND_LIMIT, expandOver } from './expand.js';

const PROJECT_KINDS = new Set(['design', 'library']);
const MAX_PROJECT_NAME = 200;
/** create_id (L1, круг 33): 8–64 символа [A-Za-z0-9_-]. */
export const CREATE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Значение для jsonb: строки и ключи чистые (§9.10); глубже предела — 400. */
export function cleanBody(v, what) {
  try {
    return cleanDeep(v);
  } catch (e) {
    if (e && e.code === 'depth') throw badRequest(`${what}: вложенность глубже ${MAX_VALUE_DEPTH}`);
    throw e;
  }
}

/** Имя проекта — метаданные (круг 31): без управляющих и bidi-символов, не длиннее 200 кодовых точек. */
export const projectName = (v) => cutText(cleanMeta(String(v)), MAX_PROJECT_NAME);

/** Предел глубины дерева: из движка, если он его даёт, иначе — тот же, что в core (256). */
export const MAX_TREE_DEPTH = Number.isInteger(core.MAX_DEPTH) && core.MAX_DEPTH > 0 ? core.MAX_DEPTH : 256;

/**
 * Глубина дерева документа от корня по `children` (у корня 0) — без рекурсии; узел,
 * встреченный второй раз, не обходится снова (цикл). Больше `limit` — сразу выход.
 * @returns {number} наибольшая глубина (или limit + 1, если предел превышен)
 */
export function treeDepth(doc, limit) {
  const nodes = doc && doc.nodes ? doc.nodes : {};
  const own = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null);
  const seen = new Set();
  const stack = [doc.root, 0];
  let max = 0;
  while (stack.length) {
    const d = stack.pop();
    const id = stack.pop();
    if (seen.has(id)) continue;
    const n = own(id);
    if (!n) continue;
    seen.add(id);
    if (d > max) max = d;
    if (max > limit) return max;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c, d + 1);
  }
  return max;
}

/**
 * Ответ `core.checkImportDoc(d, {maxNodes})` (J7, круг 29) → `{message, limit?, max?}` или null.
 * Форму ответа движок выбирает сам: null/undefined/true/`{ok:true}` — годен; строка, `{error}`,
 * `{ok:false}`, `{code, message}` или исключение — нет. `limit`/`max` движка (`'depth'|'nodes'`)
 * переходят в `detail` ответа 400 (круг 30); без них — `limit: 'import'`.
 */
export function importDocError(d, maxNodes) {
  if (typeof core.checkImportDoc !== 'function') return null;
  let r;
  try {
    r = core.checkImportDoc(d, { maxNodes });
  } catch (e) {
    return { message: e && typeof e.message === 'string' ? e.message : 'документ не прошёл проверку' };
  }
  if (r === null || r === undefined || r === true) return null;
  if (typeof r === 'string') return r ? { message: r } : null;
  if (r === false) return { message: 'документ не прошёл проверку' };
  if (typeof r === 'object') {
    if (r.ok === true) return null;
    const err = r.error !== undefined ? r.error
      : r.ok === false ? (r.message || r.reason || true)
        : typeof r.code === 'string' ? (r.message || true) : null;
    if (err === null || err === undefined || err === false) return null;
    const out = { message: typeof err === 'string' ? err
      : err && typeof err === 'object' && typeof err.message === 'string' ? err.message : 'документ не прошёл проверку' };
    // предел раскрытия движок может назвать по-своему ('expand') — наружу один код (круг 39)
    if (typeof r.limit === 'string' && /^[a-z_]{1,32}$/.test(r.limit)) out.limit = /^expand/.test(r.limit) ? EXPAND_LIMIT : r.limit;
    if (Number.isFinite(r.max)) out.max = r.max;
    return out;
  }
  return null;
}

/**
 * create_id тела (L1): нет — undefined; не строка 8–64 символов [A-Za-z0-9_-] — 400.
 * @param {any} v
 * @returns {string|undefined}
 */
export function createIdOf(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !CREATE_ID_RE.test(v)) throw badRequest('create_id: строка 8–64 символов [A-Za-z0-9_-]', { detail: { param: 'create_id' } });
  return v;
}

/**
 * Тело `POST /api/projects` → всё, что нужно хранилищу. Документ — уже строкой JSON
 * (`docJson`): его байты считаются по ней же, и pg кладёт её в jsonb без второго
 * JSON.stringify в цикле событий.
 * @param {any} body разобранное тело
 * @param {{maxNodes?: number, maxDocBytes?: number, onWarn?: (msg: string) => void}} [o]
 * @returns {{name: string, kind: string, createId?: string, createHash?: string, docJson: string, docBytes: number}}
 */
export function prepareProject(body, { maxNodes = MAX_DOC_NODES, maxDocBytes = MAX_DOC_BYTES, onWarn = () => {} } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('тело должно быть объектом');
  // круг 29: имя — строка (число — тоже можно, как прежде); объект в String() — TypeError и 500
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string' && typeof body.name !== 'number') throw badRequest('name: строка');
  const name = body.name === undefined || body.name === null ? '' : projectName(body.name);
  const kind = body.kind === undefined || body.kind === null ? 'design' : body.kind;
  if (!PROJECT_KINDS.has(kind)) throw badRequest(`kind: design | library, а не «${showValue(kind)}»`);
  const createId = createIdOf(body.create_id);
  let doc;
  if (body.doc === undefined || body.doc === null) {
    // новый проект — пустая страница; демо-документ — только по просьбе (§9.10)
    doc = createDoc(body.demo === true ? undefined : 'empty');
  } else {
    const d = cleanBody(body.doc, 'doc');
    // минимальная проверка формы; остальное приводит createDoc(seed) — тот же путь, что импорт JSON на клиенте
    if (!d || typeof d !== 'object' || Array.isArray(d) || !d.nodes || typeof d.nodes !== 'object' || typeof d.root !== 'string' || !d.nodes[d.root]) {
      throw badRequest('doc: объект с nodes и root, корень должен быть среди узлов');
    }
    if (Object.keys(d.nodes).length > maxNodes) throw tooLarge(`doc: не больше ${maxNodes} узлов`, { detail: { limit: 'doc_nodes', max: maxNodes } });
    // J7 (круг 29): глубина и типы полей — проверка движка до приведения
    const why = importDocError(d, maxNodes);
    if (why) {
      throw badRequest(`doc: ${why.message}`, {
        detail: { limit: why.limit || 'import', ...(why.max !== undefined ? { max: why.max } : {}) }
      });
    }
    try {
      doc = createDoc(d);
    } catch (e) {
      // документ чужой: исключение движка на нём — негодный документ (400), а не сбой сервиса
      onWarn(`[document/http] createDoc не принял документ импорта: ${e && e.message}`);
      throw badRequest('doc: документ не разобран — проверьте типы полей узлов');
    }
    // своя проверка глубины — по приведённому дереву (движок прежней версии checkImportDoc не знает)
    if (treeDepth(doc, MAX_TREE_DEPTH) > MAX_TREE_DEPTH) {
      throw badRequest(`doc: вложенность глубже ${MAX_TREE_DEPTH} уровней`, { detail: { limit: 'depth', max: MAX_TREE_DEPTH } });
    }
    // круг 39 (N2): предел раскрытия экземпляров компонентов (движок: expandCost) — документ, чьё
    // раскрытие больше предела, не принимается сразу, а не роняет решатель у каждого открывшего
    const expand = expandOver(doc);
    if (expand) {
      throw badRequest(`doc: ${expand.message}`, {
        detail: { limit: EXPAND_LIMIT, ...(Number.isFinite(expand.max) ? { max: expand.max } : {}), ...(Number.isFinite(expand.cost) ? { cost: Math.round(expand.cost) } : {}) }
      });
    }
  }
  if (name) doc.meta = { ...(doc.meta || {}), name };
  const docJson = JSON.stringify(doc);
  const docBytes = Buffer.byteLength(docJson, 'utf8');
  if (docBytes > maxDocBytes) throw tooLarge('doc: больше предела документа', { detail: { limit: 'doc_bytes', max: maxDocBytes } });
  const out = { name, kind, docJson, docBytes };
  if (createId) {
    out.createId = createId;
    out.createHash = createHashOf(body);
  }
  return out;
}

/**
 * Отпечаток тела создания (круг 39, N4г): sha256 НОРМАЛИЗОВАННОГО тела — того, что определяет
 * создаваемый проект: имя (после чистки), вид (по умолчанию design), документ (как прислан — до
 * приведения: у пустого createDoc id случайные; ключи объектов — по порядку, перестановка ключей
 * в JSON отпечатка не меняет), demo. `create_id` и поля, которых сервис не читает, — не в счёт.
 * Повтор того же тела — тот же отпечаток (200 existing); другое имя, вид, документ, demo —
 * другой (409 conflict).
 * @param {object} body
 * @returns {string}
 */
export function createHashOf(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = b.name === undefined || b.name === null ? '' : projectName(b.name);
  const kind = b.kind === undefined || b.kind === null ? 'design' : String(b.kind);
  const norm = { v: 1, name, kind, demo: b.demo === true, doc: b.doc === undefined || b.doc === null ? null : b.doc };
  const h = createHash('sha256');
  canonicalJson(norm, (part) => h.update(part));
  return h.digest('hex');
}

/** Метка «готовый кусок текста» в стеке обхода canonicalJson (не значение документа). */
const RAW = Symbol('raw');

/**
 * JSON с ключами объектов по порядку — кусками в `out` (документ в мегабайты не собирается
 * второй строкой; обход без рекурсии — глубина документа не роняет стек).
 * @param {any} v
 * @param {(part: string) => void} out
 */
export function canonicalJson(v, out) {
  const stack = [v];
  while (stack.length) {
    const x = stack.pop();
    if (x && typeof x === 'object' && x[RAW] !== undefined) {
      out(x[RAW]);
      continue;
    }
    if (x === null || typeof x !== 'object') {
      const t = JSON.stringify(x);
      out(t === undefined ? 'null' : t);
      continue;
    }
    if (Array.isArray(x)) {
      out('[');
      stack.push({ [RAW]: ']' });
      for (let i = x.length - 1; i >= 0; i--) {
        stack.push(x[i]);
        if (i > 0) stack.push({ [RAW]: ',' });
      }
      continue;
    }
    out('{');
    const keys = Object.keys(x).filter((k) => x[k] !== undefined).sort();
    stack.push({ [RAW]: '}' });
    for (let i = keys.length - 1; i >= 0; i--) {
      stack.push(x[keys[i]]);
      stack.push({ [RAW]: (i > 0 ? ',' : '') + JSON.stringify(keys[i]) + ':' });
    }
  }
}

/** Ошибка из потока импорта → простой объект (structured clone теряет класс DocError). */
export function errorOut(e) {
  if (e instanceof DocError) return { status: e.status, code: e.code, message: e.message, retryable: e.retryable, detail: e.detail };
  return { status: 500, code: 'internal', message: String((e && e.message) || e).slice(0, 300) };
}
