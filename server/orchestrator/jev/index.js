/**
 * JEV (SPEC §7, §10.1, стрелки 4/5): «команда оболочки или работа для модели».
 *
 *   classify(text, ctx) → {kind:'shell', action, args}
 *                       | {kind:'variants', n, of}
 *                       | {kind:'model', needsModel, intent}
 *
 * Пока классификатора на эмбеддингах нет (§7), это заглушка на нынешнем словаре:
 *   • отмена/повтор — `recognizeAction` из brain.js (тот же список, что видит конвейер);
 *   • варианты — `recognizeVariants` из brain.js;
 *   • стоп, отмена N раз, вписать/масштаб, снять выделение, шторки — узкий перенос
 *     `shellIntent` из app.js (только формы, которым не нужен документ). Формы, которым
 *     нужен документ клиента («покажи второй экран», «выдели заголовок»), остаются в
 *     оболочке: она узнаёт их до сети, сюда они не доходят;
 *   • `needsModel:false` — реплики, на которые brain отвечает сам, без модели (пустая,
 *     двусмысленная отмена, «сделай компонент»): им не нужна проверка модели перед стартом.
 * Сверка — ЦЕЛОЙ реплики, как в оболочке: «повтори шапку три раза» уходит в модель.
 */

import {
  recognizeAction, recognizeVariants, recognizeUndoDoubt, recognizeComponentIntent,
  classifyUtterance, hasWords,
} from '../../../src/brain.js';

const RUS_END = '[а-яё]*';
const N_WORDS = '\\d{1,2}|один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять';
const TAIL_N = `(?:\\s+(?:последн${RUS_END}|предыдущ${RUS_END}|прошл${RUS_END}))?(?:\\s+на)?`
  + `\\s+(${N_WORDS})`
  + `(?:\\s*(?:раз${RUS_END}|шаг${RUS_END}|правк${RUS_END}|изменени${RUS_END}))?`
  + '(?:\\s+назад)?$';
const RE_UNDO_N = new RegExp(`^(?:отмени|отмена|отменить|откати|откатить|верни|вернуть)${TAIL_N}`);
const RE_REDO_N = new RegExp(`^(?:верни обратно|повтори|повторить|вперёд|вперед)${TAIL_N}`);
const RE_UNDO_BARE = /^(отмена|отмени|отменить|отмени это|отмени правку|отмени последнее|верни как было|верни как раньше|верни назад|назад|не так)$/;
const RE_REDO_BARE = /^(верни обратно|повтори правку|вперёд|вперед)$/;
const RE_STOP = /^(стоп|стой|хватит|прекрати|прекратить|остановись|остановить|остановите|отставить|отмени работу)$/;
const NUM = {
  один: 1, одну: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
};

function norm(text) {
  return String(text || '').toLowerCase()
    .replace(/[.,!?;:…"«»()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function num(word) {
  const w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (/^\d{1,2}$/.test(w)) return Number(w);
  return NUM[w] == null ? null : NUM[w];
}

/** Действия оболочки по одной лишь фразе (документ не нужен). */
function shellOf(text) {
  const t = norm(text);
  if (!t || t.length > 140) return null;
  if (RE_STOP.test(t)) return { action: 'stop', args: {} };

  // формы оболочки (app.js) первыми: «верни обратно» там — повтор, а не отмена
  if (RE_UNDO_BARE.test(t)) return { action: 'undo', args: { times: 1 } };
  if (RE_REDO_BARE.test(t)) return { action: 'redo', args: { times: 1 } };
  const undoRedo = recognizeAction(text);
  if (undoRedo) return { action: undoRedo, args: { times: 1 } };
  let m = RE_REDO_N.exec(t);
  if (m && num(m[1])) return { action: 'redo', args: { times: Math.max(1, Math.min(20, num(m[1]))) } };
  m = RE_UNDO_N.exec(t);
  if (m && num(m[1])) return { action: 'undo', args: { times: Math.max(1, Math.min(20, num(m[1]))) } };

  if (/^(вписать|впиши|вмести|вместить|вписать в окно|вписать на экран)$/.test(t)) return { action: 'fit', args: {} };
  if (/^(вписать всё|вписать все|впиши всё|впиши все|покажи всё|покажи все|покажи весь макет|покажи целиком|целиком|общий вид|обзор)$/.test(t)) {
    return { action: 'fit', args: { all: true } };
  }
  if (/^(приблизь|приблизить|ближе|увеличь масштаб|увеличить масштаб|крупнее масштаб)$/.test(t)) return { action: 'zoom', args: { by: 1.25 } };
  if (/^(отдали|отдалить|дальше|уменьши масштаб|уменьшить масштаб|мельче масштаб)$/.test(t)) return { action: 'zoom', args: { by: 0.8 } };
  if (/^(?:масштаб\s+)?(сто процентов|100 процентов|100%|сбрось масштаб|сбросить масштаб|реальный размер|настоящий размер|один к одному)$/.test(t)) {
    return { action: 'zoom', args: { to: 1 } };
  }
  const zm = /^(?:масштаб|зум)\s+(\d{2,3})\s*(?:процент[а-яё]*|%)?$/.exec(t);
  if (zm) return { action: 'zoom', args: { to: Math.max(0.1, Math.min(6, Number(zm[1]) / 100)) } };

  if (/^(сними выделение|снять выделение|убери выделение|ничего не выделяй)$/.test(t)) return { action: 'select', args: { ids: [] } };
  if (/^(история|историю|история правок|покажи историю|покажи историю правок|открой историю|открой историю правок)$/.test(t)) {
    return { action: 'sheet', args: { what: 'history', tab: 'edits' } };
  }
  if (/^(настройки|открой настройки|покажи настройки|настройки агента)$/.test(t)) return { action: 'sheet', args: { what: 'settings' } };
  return null;
}

/** Сколько вариантов просят словами: «покажи два варианта» → 2. */
function variantsCount(text) {
  const m = /(\d|один|одну|два|две|три|четыре|пять|шесть)\s+вариант/.exec(norm(text));
  const n = m ? num(m[1]) : null;
  return n ? Math.max(1, Math.min(6, n)) : null;
}

/**
 * @param {string} text реплика человека
 * @param {{hasSelection?: boolean, mode?: 'run'|'variants', n?: number}} [ctx]
 */
export function classify(text, ctx = {}) {
  if (ctx.mode !== 'variants') {
    const shell = shellOf(text);
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
