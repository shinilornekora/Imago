/**
 * Версия формата движка экземпляра (SPEC §8.3, круг 39).
 *
 * Формат документа менялся (круг 36 — состояния и движение, круг 37 — векторы, свободная
 * рамка, градиенты, поворот), и прежний экземпляр, встретив в журнале запись, которую его
 * движок не применяет, раньше её пропускал — и через 50 правок писал снимок со своей
 * «дырявой» головы: чужой слой пропадал у всех. Теперь:
 *   - клиент или агент с версией ≠ версии экземпляра — 426 (validateTx);
 *   - запись журнала или снимок с версией БОЛЬШЕ версии экземпляра (или меньше той, что он
 *     ещё читает, `ENGINE_MIN_READ`) — проект на этом экземпляре «устарел»: чтение и запись
 *     проекта — 503 `{code:'unavailable', detail:{cause:'engine'}}`, голова не держится и
 *     снимков не пишет, в лог — одна строка;
 *   - голова, где не применилась запись НЕИЗВЕСТНОЙ или СВОЕЙ версии, снимков не пишет (dslts.js;
 *     круг 41: «наследная» запись пропускается всеми одинаково — снимкам не мешает; круг 45:
 *     наследная — только движка строго НИЖЕ своего, отказ своей версии — признак смены формата
 *     без подъёма версии);
 *   - база сама не принимает снимок движка старше записей журнала под ним (миграция 014).
 *
 * Версия экземпляра — `core.ENGINE_VERSION`; тестам и стендам смешанных версий её можно
 * ПОНИЗИТЬ (опция `engine` или переменная окружения `IMAGO_ENGINE`) — «экземпляр прежней
 * версии» на том же коде. Выше версии движка — нельзя: экземпляр принял бы и записал снимком
 * формат, которого его движок не знает.
 */

import * as core from '../../src/core.js';
import { DocError } from './errors.js';

/** Версия формата движка этого кода. */
export const CODE_ENGINE = Number.isInteger(core.ENGINE_VERSION) && core.ENGINE_VERSION > 0 ? core.ENGINE_VERSION : 1;
/** Самая старая версия формата, которую движок ещё читает (движок без экспорта — 1). */
export const ENGINE_MIN_READ = Number.isInteger(core.ENGINE_MIN_READ) && core.ENGINE_MIN_READ > 0 ? Math.min(core.ENGINE_MIN_READ, CODE_ENGINE) : 1;
/** Через сколько «устаревший» проект проверяется заново (до того — 503 сразу, без чтения базы). */
export const OUTDATED_RECHECK_MS = 10000;
/** Повторить запрос к «устаревшему» проекту — через столько секунд. */
export const ENGINE_RETRY_S = 30;

/**
 * Версия экземпляра: опция, иначе окружение `IMAGO_ENGINE`, иначе версия движка. Негодное
 * значение (не целое, меньше ENGINE_MIN_READ, больше версии движка) — предупреждение и версия движка.
 * @param {any} opt
 * @param {Record<string, string|undefined>} [env]
 * @param {{warn: Function}} [log]
 * @returns {number}
 */
export function resolveEngine(opt, env = process.env, log = console) {
  const raw = opt !== undefined && opt !== null ? opt : env && env.IMAGO_ENGINE !== undefined && env.IMAGO_ENGINE !== '' ? env.IMAGO_ENGINE : undefined;
  if (raw === undefined) return CODE_ENGINE;
  const v = typeof raw === 'number' ? raw : /^\d{1,6}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
  if (!Number.isInteger(v) || v < ENGINE_MIN_READ || v > CODE_ENGINE) {
    log.warn(`[document] версия движка экземпляра «${String(raw).slice(0, 20)}» не годится (целое от ${ENGINE_MIN_READ} до ${CODE_ENGINE}) — работаю с ${CODE_ENGINE}`);
    return CODE_ENGINE;
  }
  return v;
}

/**
 * Записанное движком `found` этот экземпляр (версии `engine`) не прочтёт: новее его или старше
 * того, что движок ещё читает. Неизвестная версия (не целое — хранилище прежней версии) — читается.
 * @param {any} found
 * @param {number} engine
 */
export function engineUnreadable(found, engine) {
  return Number.isInteger(found) && (found > engine || found < ENGINE_MIN_READ);
}

/**
 * 503 «проект записан другой версией движка» — чтение и запись проекта на этом экземпляре
 * невозможны, пока его не обновят (или откатят базу).
 * @param {number} found версия записи/снимка
 * @param {number} engine версия экземпляра
 */
export function engineError(found, engine) {
  const newer = found > engine;
  return new DocError(503, 'unavailable', newer
    ? `проект записан более новой версией редактора (движок ${found}), а этот сервер работает с ${engine} — сервер нужно обновить`
    : `проект записан версией движка ${found}, которую этот сервер уже не читает (читает от ${ENGINE_MIN_READ})`, {
    retryable: true, retryAfter: ENGINE_RETRY_S, detail: { cause: 'engine', engine, found }
  });
}
