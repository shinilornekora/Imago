/**
 * Предел раскрытия экземпляров компонентов (SPEC §5.6, круг 39, N2).
 *
 * Документ в несколько КБ (9 мастеров, в каждом по W экземпляров следующего) раскрывается в
 * W⁸ узлов: решатель и отрисовка у каждого открывшего проект — десятки секунд и гигабайты, вкладка
 * падает. Глубина 8 этого не держит, число узлов документа — тоже (раскрытые узлы в doc.nodes не
 * лежат). Движок считает стоимость раскрытия без раскрытия — `core.expandCost(doc)` — и знает
 * предел `core.MAX_EXPANDED_NODES`; сервис:
 *   - импорт (`POST /api/projects` с документом) сверх предела — 400 `detail.limit:'expand_nodes'`;
 *   - транзакция, после которой стоимость больше предела и больше, чем была, — её операции (кроме
 *     `remove`) в `dropped` с `reason:'invalid'`, `limit:'expand_nodes'` (как `doc_nodes`).
 * Движок прежней версии (без expandCost) — предела нет, как раньше; движок с одной
 * `expandProblem(doc)` — по ней. Исключение движка на чужом документе — «не знаю» (не отказ).
 */

import * as core from '../../src/core.js';

/** Код предела в `detail.limit` и `dropped[].limit`. */
export const EXPAND_LIMIT = 'expand_nodes';

/** Предел движка или null (движок его не знает). */
export function expandMax() {
  return Number.isFinite(core.MAX_EXPANDED_NODES) && core.MAX_EXPANDED_NODES > 0 ? core.MAX_EXPANDED_NODES : null;
}

/** Ответ expandProblem/expandBudgetProblem → {cost?, max?, message} | null. */
function problemOf(r) {
  if (r === null || r === undefined || r === false || r === true) return null;
  if (typeof r === 'string') return r ? { message: r } : null;
  if (typeof r !== 'object' || r.ok === true) return null;
  const message = typeof r.message === 'string' && r.message ? r.message
    : typeof r.error === 'string' && r.error ? r.error
      : r.error && typeof r.error.message === 'string' ? r.error.message : '';
  const out = { message };
  if (Number.isFinite(r.cost) || r.cost === Infinity) out.cost = r.cost;
  if (Number.isFinite(r.max)) out.max = r.max;
  return out;
}

/**
 * Стоимость раскрытия документа (число узлов) или null — движок не умеет / не смог.
 * Без expandCost — по expandProblem: годен — 0 (в пределе), нет — его `cost` или Infinity.
 * @param {object} doc
 * @returns {number|null}
 */
export function expandCostOf(doc) {
  if (typeof core.expandCost === 'function') {
    try {
      const c = core.expandCost(doc);
      return typeof c === 'number' && c >= 0 ? c : null;
    } catch (_) {
      return null;
    }
  }
  const fn = typeof core.expandProblem === 'function' ? core.expandProblem
    : typeof core.expandBudgetProblem === 'function' ? core.expandBudgetProblem : null;
  if (!fn) return null;
  try {
    const p = problemOf(fn(doc));
    if (!p) return 0;
    return p.cost !== undefined ? p.cost : Infinity;
  } catch (_) {
    return null;
  }
}

/**
 * Документ раскрывается больше предела? → `{cost, max, message}` или null.
 * @param {object} doc
 */
export function expandOver(doc) {
  const max = expandMax();
  if (typeof core.expandCost === 'function' && max !== null) {
    const cost = expandCostOf(doc);
    if (cost === null || cost <= max) return null;
    // слова — движка, если он их даёт
    let message = '';
    if (typeof core.expandProblem === 'function') {
      try {
        const p = problemOf(core.expandProblem(doc));
        if (p && p.message) message = p.message;
      } catch (_) { /* слова — свои */ }
    }
    return { cost, max, message: message || overMessage(cost, max) };
  }
  const fn = typeof core.expandProblem === 'function' ? core.expandProblem
    : typeof core.expandBudgetProblem === 'function' ? core.expandBudgetProblem : null;
  if (!fn) return null;
  let p;
  try {
    p = problemOf(fn(doc));
  } catch (_) {
    return null;
  }
  if (!p) return null;
  const m = p.max !== undefined ? p.max : max;
  const cost = p.cost !== undefined ? p.cost : Infinity;
  return { cost, max: m, message: p.message || overMessage(cost, m) };
}

function overMessage(cost, max) {
  const n = Number.isFinite(cost) ? Math.round(cost).toLocaleString('ru-RU') : 'слишком много';
  return `экземпляры компонентов раскрываются в ${n} узлов — больше предела ${max === null || max === undefined ? '' : max.toLocaleString('ru-RU')}`.trim();
}

/** Поля, правка которых может увеличить раскрытие (прочее — нет: setToken, имя, заливка…). */
const GROW_PATH = /^(of|props|component|role)(\.|$)/;

/**
 * Могут ли операции увеличить раскрытие: create и move — да (узел в мастере множится на число
 * его раскрытий), set — только of/props/component/role; remove и setToken — нет.
 * @param {object[]} ops
 */
export function mayGrowExpand(ops) {
  for (const op of ops || []) {
    if (!op) continue;
    if (op.op === 'create' || op.op === 'move') return true;
    if (op.op === 'set' && typeof op.path === 'string' && GROW_PATH.test(op.path)) return true;
  }
  return false;
}

/**
 * Транзакция раздувает раскрытие сверх предела: после — больше предела и больше, чем до
 * (документ, уже бывший сверх предела, править и уменьшать можно). → `{cost, max, message}` | null.
 * @param {object} before документ до
 * @param {object} after документ после
 */
export function expandGrowthOver(before, after) {
  const over = expandOver(after);
  if (!over) return null;
  const was = expandCostOf(before);
  if (was !== null && was >= over.cost) return null;
  return over;
}
