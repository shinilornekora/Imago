/**
 * JEV (SPEC §7, §10.1, стрелки 4/5): «команда оболочки или работа для модели».
 *
 *   classify(text, ctx) → {kind:'shell', action, args}
 *                       | {kind:'variants', n, of}
 *                       | {kind:'model', needsModel, intent}
 *
 * Пока классификатора на эмбеддингах нет (§7), это заглушка на словаре — но словарь
 * теперь ОДИН с оболочкой (круг 24): `shellIntent` из src/shell.js, тот же, что узнаёт
 * реплики в браузере до сети; узкой копии здесь больше нет (test/shell.test.mjs сверяет,
 * что фраза значит одно и то же по обе стороны). В нём же — `recognizeAction` brain.
 *   • Документа клиента у JEV нет (команда оболочки не ждёт чтения, §10.5): формы, которым
 *     нужны имена слоёв и досок («выдели заголовок», «покажи сводку недели»), молчат и
 *     уходят модели; оболочка узнаёт их сама до сети. Если вызывающий передал `ctx.doc`,
 *     узнаются и они.
 *   • варианты — `recognizeVariants` из brain.js;
 *   • `needsModel:false` — реплики, на которые brain отвечает сам, без модели (пустая,
 *     двусмысленная отмена, «сделай компонент»): им не нужна проверка модели перед стартом.
 * Сверка — ЦЕЛОЙ реплики, как в оболочке: «повтори шапку три раза» уходит в модель.
 */

import {
  recognizeVariants, recognizeUndoDoubt, recognizeComponentIntent,
  classifyUtterance, hasWords,
} from '../../../src/brain.js';
import { shellIntent, shellEventOf, normSaid, numSaid } from '../../../src/shell.js';

/** Сколько вариантов просят словами: «покажи два варианта» → 2. */
function variantsCount(text) {
  const m = /(\d|один|одну|два|две|три|четыре|пять|шесть)\s+вариант/.exec(normSaid(text));
  const n = m ? numSaid(m[1]) : null;
  return n ? Math.max(1, Math.min(6, n)) : null;
}

/**
 * Команда оболочки по одной лишь фразе → событие `shell {action, args}` или null.
 * @param {string} text
 * @param {{doc?: object, board?: string}} [ctx]
 */
export function shellOf(text, ctx = {}) {
  const intent = shellIntent(text, { doc: ctx.doc || null, activeArtboardId: ctx.board || null });
  return intent ? shellEventOf(intent) : null;
}

/**
 * @param {string} text реплика человека
 * @param {{hasSelection?: boolean, mode?: 'run'|'variants', n?: number, doc?: object, board?: string}} [ctx]
 */
export function classify(text, ctx = {}) {
  if (ctx.mode !== 'variants') {
    const shell = shellOf(text, ctx);
    if (shell) return { kind: 'shell', ...shell };
  }
  const wantVariants = recognizeVariants(text);
  if (ctx.mode === 'variants' || wantVariants) {
    return {
      kind: 'variants',
      n: ctx.n || variantsCount(text) || 3,
      of: wantVariants ? wantVariants.variantsOf || '' : '',
    };
  }
  const local = !hasWords(text) || !!recognizeUndoDoubt(text) || !!recognizeComponentIntent(text);
  const guess = classifyUtterance(text, { hasSelection: !!ctx.hasSelection });
  return { kind: 'model', needsModel: !local, intent: guess.intent };
}

export default { classify };
