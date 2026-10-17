/**
 * brain.js — «мозг» Imago Studio: провайдеры моделей, схемы, промпты, конвейер команд.
 *
 * Модуль ничего не знает о DOM и ничего не мутирует: движок (документ, операции,
 * решатель, валидаторы) живёт в ./core.js и подключается лениво, чтобы brain.js
 * можно было загрузить и протестировать до того, как core.js готов, а также
 * подменить движок в тестах: runCommand({..., engine}).
 *
 * Контракт SPEC 1.6 (расширен по итогам ревью):
 *   makeProvider(cfg) -> {name, kind, ready(), complete(messages, schema, opts)}
 *   runCommand({doc, selection, utterance, provider, onStage, signal,
 *               engine?, persona?, plan?, history?, geo?, activeArtboardId?, selectionBy?})
 *     -> {ops, preview:{doc,geo}, plan, answer?, clarify?, cannot?, warnings, usage, stages} | {error:{kind,message}}
 *   runVariants({doc, selection, utterance, provider, n, onStage, signal,
 *                engine?, history?, geo?, activeArtboardId?, selectionBy?})
 *     -> [{key, label, description, ops, preview, plan, warnings, error?}]
 *   SCHEMAS = {plan, tree, patch, theme, answer}
 *   Круг 24: у runCommand и runVariants есть library — внешний словарь компонентов
 *   (DUIL, SPEC §10.6): [{doc, name?, id?}]; имена документа главнее, использованные
 *   мастера переносятся в библиотеку документа (libraryAdded). id новых узлов — core.uid.
 *
 * Новое в контракте:
 *   history           — [{utterance, summary}], до 5 последних обменов (старые первыми);
 *   geo               — уже посчитанная геометрия текущего документа (solve(doc)), чтобы не считать заново;
 *   activeArtboardId  — активная доска оболочки: область по умолчанию, когда нет выделения;
 *   clarify           — строка-переспрос, когда команда не опознана (ops при этом пуст);
 *   action            — 'undo' | 'redo' | 'variants': это делает оболочка, модель не звалась;
 *   variantsOf        — команда, к которой просят варианты ('' — к предыдущей);
 *   variantsSubject   — круг 7: предмет просьбы словами («два варианта ШАПКИ» → «Шапка»),
 *                       если он назван и найден в документе; оболочка вправе его игнорировать;
 *   geometryUnchanged — круг 7: [{id, path}] правок, которые легли в документ, но НИЧЕГО не
 *                       сдвинули на экране (раскладка это значение не использует). Человеку об
 *                       этом уже сказано предупреждением; поле — чтобы оболочка могла помечать
 *                       такие строки в отчёте, а не рапортовать их как сделанную работу.
 *                       Круг 9: сюда попадает ТОЛЬКО доказуемо невидимое — выключка текста
 *                       шириной по содержимому и пути, чьё действие целиком видно в геометрии.
 *   cannot            — круг 9, п.4: строка по-русски, «в этой модели документа так нельзя»
 *                       (поворот, градиент, ссылка, анимация появления; круг 36: тень и
 *                       микроанимации состояний уже ЕСТЬ, SPEC §11). Это ОТВЕТ агента, как
 *                       clarify: error нет, ops пуст, preview — прежний документ. Приходит
 *                       из plan.intent="refuse" либо из поля cannot патча/дерева. Если часть
 *                       просьбы выполнима, ops непусты, а cannot стоит рядом с ними.
 *   Круг 11 — что изменилось для оболочки:
 *     • action:'variants' теперь приходит на гораздо большее число живых фраз: при ЯВНОМ
 *       разделителе («три варианта: сделай шапку аккуратнее») хвост уходит в variantsOf как есть,
 *       без сверки со словарём глаголов, поэтому variantsOf может быть и не глагольным
 *       («как лучше расположить показатели»). Ложных срабатываний это не добавляет: без
 *       разделителя проверка хвоста осталась прежней;
 *     • clarify приходит ещё и без обращения к модели — на двусмысленной отмене («убери
 *       последнее»: это и откат, и удаление слоя). usage.calls при этом 0, как у action;
 *       локально это видно через recognizeUndoDoubt(utterance) -> string|null;
 *     • geometryUnchanged перестал ограничиваться путями раскладки: туда попадают и доказуемо
 *       пустые правки («radius» у эллипса, «fill» у узла нулевого размера, «color» у пустого
 *       текста) — правило прежнее: только доказуемое, без догадок;
 *     • на ПРОВАЛЬНОМ прогоне (есть error) служебного «Починка не помогла — оставил первый
 *       вариант» в warnings больше нет: оставлять было нечего;
 *     • у intent:'theme' в warnings приходит «Оформление документа общее…»: токены меняют ВСЕ
 *       артборды, и человек должен это знать. themeToOps принимает необязательный scope.
 *   selectionBy       — круг 9, п.5: 'human' (по умолчанию) | 'agent'. Оболочка после правки
 *                       сама выделяет задетое (selectTouched) — такое выделение не граница,
 *                       назначенная человеком, и «правка ушла туда» о нём не говорится.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 0. Движок
 * ──────────────────────────────────────────────────────────────────────────── */

/** Требуемые экспорты core.js. */
export const ENGINE_MEMBERS = [
  'createDoc', 'applyOps', 'invertOps', 'solve', 'validate',
  'ops', 'resolveTarget', 'isArtboard', 'cloneSubtree',
];

let _enginePromise = null;

/** Ленивый импорт движка: статический import сделал бы модуль незагружаемым без core.js. */
export function loadEngine() {
  if (!_enginePromise) _enginePromise = import('./core.js');
  return _enginePromise;
}

async function useEngine(engine) {
  let mod = engine;
  if (!mod) {
    try {
      mod = await loadEngine();
    } catch (e) {
      throw ERR('model', 'Движок ./core.js не загрузился: ' + (e && e.message ? e.message : e));
    }
  }
  const missing = ENGINE_MEMBERS.filter((k) => mod[k] == null);
  if (missing.length) throw ERR('model', `Движок неполон, не хватает: ${missing.join(', ')}`);
  return mod;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Ошибки
 * ──────────────────────────────────────────────────────────────────────────── */

/** kind: 'model' | 'network' | 'schema' | 'cancelled'. */
export class BrainError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'BrainError';
    this.kind = kind;
    if (extra) Object.assign(this, extra);
  }
}

const ERR = (kind, message, extra) => new BrainError(kind, message, extra);

/** Сервер модели отверг запрос (4xx): что сказать человеку (подробности — в `detail`). */
export const MODEL_REJECTED = 'Модель не приняла запрос — попробуйте ещё раз или скажите команду иначе';

/* ── Круг 31 (K3): ответ модели — с потолком размера и глубины ─────────────────────────────
 * Тело ответа читалось целиком (`res.json()`): 400 МБ от сломанного сервера модели — 2 ГБ
 * памяти процесса. Невалидное или слишком глубокое тело бросало SyntaxError/RangeError,
 * а те классифицировались как «нет связи» — и включали глобальное «модель недоступна» для
 * всех команд. Теперь: тело — потоком до потолка, сверх — `llm_bad_response`; не JSON и не
 * той формы — тоже `llm_bad_response` (модель жива, повтор может помочь). */

/** Потолок тела ответа модели, байт (настраивается: cfg.maxBodyBytes / LLM_MAX_BODY_BYTES). */
export const MODEL_BODY_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Потолок вложенности данных модели. Дерево макета — не глубже MAX_TREE_DEPTH узлов (каждый
 * узел — два уровня JSON: объект и массив детей), так что 100 — с большим запасом; глубже —
 * мусор, который к тому же роняет стек у structuredClone и рекурсивных обходов.
 */
export const MODEL_DATA_MAX_DEPTH = 100;
/** Потолок числа значений в данных модели (объекты, массивы, примитивы). */
export const MODEL_DATA_MAX_VALUES = 500000;

/** Ошибка «ответ модели негоден» (круг 31): код llm_bad_response, повторяемо. */
export function badResponse(message) {
  return new BrainError('model', message || 'Ответ модели не удалось разобрать', { code: 'llm_bad_response', retryable: true });
}

/**
 * Проверка формы данных модели без рекурсии: глубина и число значений. null — годится,
 * иначе — что не так (для журнала).
 * @param {any} v
 * @param {{maxDepth?: number, maxValues?: number}} [o]
 * @returns {string|null}
 */
export function modelDataProblem(v, o = {}) {
  const maxDepth = o.maxDepth || MODEL_DATA_MAX_DEPTH;
  const maxValues = o.maxValues || MODEL_DATA_MAX_VALUES;
  if (!v || typeof v !== 'object') return null;
  const stack = [[v, 1]];
  let count = 0;
  while (stack.length) {
    const [x, d] = stack.pop();
    if (++count > maxValues) return `больше ${maxValues} значений`;
    if (d > maxDepth) return `вложенность глубже ${maxDepth}`;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        const c = x[i];
        if (c && typeof c === 'object') stack.push([c, d + 1]);
        else if (++count > maxValues) return `больше ${maxValues} значений`;
      }
    } else {
      for (const k in x) {
        if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
        const c = x[k];
        if (c && typeof c === 'object') stack.push([c, d + 1]);
        else if (++count > maxValues) return `больше ${maxValues} значений`;
      }
    }
  }
  return null;
}

/**
 * Тело ответа текстом, но не больше `maxBytes`: читается потоком, сверх потолка чтение
 * обрывается (соединение закрывается) и бросается `llm_bad_response`.
 * @param {Response} res
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readBodyCapped(res, maxBytes = MODEL_BODY_MAX_BYTES) {
  const tooBig = () => badResponse(`Ответ модели больше ${Math.round(maxBytes / (1024 * 1024) * 10) / 10} МБ — команда не выполнена, попробуйте ещё раз`);
  const declared = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* ignore */ }
    throw tooBig();
  }
  const body = res && res.body;
  if (!body || typeof body.getReader !== 'function') {
    // подделки fetch без потока: размер — после чтения (настоящий fetch всегда с потоком);
    // у совсем простых подделок есть только json()
    const text = res && typeof res.text === 'function' ? await res.text()
      : res && typeof res.json === 'function' ? JSON.stringify(await res.json()) : '';
    if (utf8Length(text) > maxBytes) throw tooBig();
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let got = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value ? value.byteLength : 0;
    if (got > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Байты строки в UTF-8 (без Buffer: brain живёт и в браузере). */
function utf8Length(s) {
  return new TextEncoder().encode(String(s)).length;
}

/**
 * JSON тела ответа модели: не разобрался — `llm_bad_response` (а не «нет связи»).
 * @param {string} text
 */
export function parseBodyJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw badResponse('Ответ сервера модели не разобрался как JSON — попробуйте ещё раз');
  }
}

/**
 * Текст ответа из choices[0]: строка — как есть; массив частей (`[{type:'text', text}]`) —
 * склейка их строк; иное — `llm_bad_response`.
 * @param {any} json
 * @returns {string}
 */
export function completionText(json) {
  const c = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!c || typeof c !== 'object') return '';
  return contentText(c.message && typeof c.message === 'object' ? c.message.content : c.text);
}

/**
 * Круг 33: поле `content` ответа модели (целиком или куском потока) → текст. Строка — как
 * есть; массив частей — склейка их строк; null/undefined — пусто; иное (объект, число…) —
 * `llm_bad_response` сразу, без повтора «по схеме»: модель прислала не текст, и второй
 * запрос того же сервера ответит так же.
 * @param {any} v
 * @returns {string}
 */
export function contentText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    let out = '';
    for (const part of v) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object' && typeof part.text === 'string') out += part.text;
      else throw badResponse('Ответ модели не той формы — попробуйте ещё раз');
    }
    return out;
  }
  throw badResponse('Ответ модели не той формы — попробуйте ещё раз');
}

/** Круг 33: потолок длины id модели из `/models` (длиннее — мусор, id не берётся). */
export const MODEL_ID_MAX = 200;

/**
 * Круг 33: id модели из ответа `/models` — только строка (или конечное число) без
 * управляющих и форматных знаков (U+0000, RTL-переключатели…) и половин суррогатных пар,
 * не длиннее MODEL_ID_MAX. Негодный — '' (модель не выбирается, остаётся заданная).
 * @param {any} v
 * @returns {string}
 */
export function cleanModelId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim();
  if (!s || s.length > MODEL_ID_MAX) return '';
  return s;
}

/** Ошибка → всегда понятный человеку объект {kind, message}. */
export function toErrorInfo(e) {
  if (e instanceof BrainError) {
    const info = { kind: e.kind, message: e.message };
    if (e.code) info.code = e.code;
    if (e.text) info.text = e.text;
    // круг 29: служебные подробности (тело отказа модели) — не для экрана, для журнала
    if (e.detail) info.detail = String(e.detail);
    // круг 16, п.8: «повторять нечего» — признак для оболочки, чтобы не звать «Повторить»
    if (e.retryable === false) info.retryable = false;
    // круг 31: какой совет дать к not_applied (оболочке)
    if (e.hint) info.hint = e.hint;
    return info;
  }
  if (isInternalError(e)) {
    /* Круг 31 (K3): исключение самого кода (TypeError на документе, переполнение стека…) —
     * не «сбой модели»: повтор даст то же, а человеку нужен не совет «скажите иначе», а
     * администратор. Наружу — общая фраза; стек — полем `stack` для журнала сервера. */
    return {
      kind: 'internal', code: 'internal', message: INTERNAL_MESSAGE, retryable: false,
      stack: cutText(String((e && (e.stack || e.message)) || e), 4000),
    };
  }
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    const mapped = fromClaudeError(e);
    return { kind: mapped.kind, message: mapped.message, code: mapped.code };
  }
  const msg = e && e.message ? e.message : String(e);
  if (/abort/i.test(msg)) return { kind: 'cancelled', message: 'Команда отменена' };
  return { kind: 'model', message: msg };
}

/** Круг 31 (K3): что сказать человеку о внутренней ошибке агента. */
export const INTERNAL_MESSAGE = 'Внутренняя ошибка агента';

/**
 * Круг 31 (K3): исключение кода, а не ответ модели или сети. Встроенные виды ошибок JS и
 * системные коды Node (`ERR_…`) у модели не рождаются: модель и сеть приходят к brain
 * BrainError-ом (провайдеры) или объектом с кодом способности sample.
 * @param {any} e
 * @returns {boolean}
 */
export function isInternalError(e) {
  if (!e || typeof e !== 'object' || e instanceof BrainError) return false;
  if (e.name === 'AbortError') return false;
  if (typeof e.code === 'string' && /^ERR_/.test(e.code)) return true;
  return e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError
    || e instanceof EvalError || e instanceof URIError;
}

/** Коды sample-способности → наши виды ошибок (см. sample.d.ts, SampleErrorCode). */
const CLAUDE_ERROR_KIND = {
  cancelled: 'cancelled',
  invalid_json: 'schema',
  invalid_request: 'schema',
  transform_error: 'schema',
  prompt_too_large: 'schema',
  rate_limited: 'network',
  session_expired: 'network',
  upstream_error: 'network',
  queue_overflow: 'network',
  not_granted: 'model',
  sampling_disabled: 'model',
  not_declared: 'model',
  capability_disabled: 'model',
  capability_removed: 'model',
  images_unavailable: 'model',
  tools_unavailable: 'model',
  image_rejected: 'model',
  refused: 'model',
  empty_completion: 'model',
};

const CLAUDE_ERROR_TEXT = {
  cancelled: 'Команда отменена',
  not_granted: 'Вы не разрешили этому артефакту обращаться к Claude. Разрешите доступ и повторите команду.',
  sampling_disabled: 'Claude недоступен для этого аккаунта или организации.',
  not_declared: 'Артефакт больше не объявляет способность sample.',
  capability_disabled: 'Способность Claude отключена в этом окне.',
  capability_removed: 'Приложение просмотра слишком старое: у него нет sample.json.',
  rate_limited: 'Слишком много обращений к модели. Подождите немного и повторите.',
  session_expired: 'Сессия истекла — войдите в Claude заново.',
  refused: 'Claude отказался выполнять этот запрос. Переформулируйте команду.',
  empty_completion: 'Модель не ответила. Попробуйте сформулировать короче.',
  invalid_json: 'Модель вернула не JSON. Попробуйте ещё раз или упростите команду.',
  prompt_too_large: 'Запрос слишком большой: выделите меньшую область макета.',
  upstream_error: 'Сбой связи с моделью. Попробуйте ещё раз.',
};

/**
 * Круг 9, п.3: умолчанием был код `upstream_error`, то есть «Сбой связи с моделью». Любая
 * ошибка БЕЗ кода — не-JSON от локального сервера, брошенный SyntaxError, «500 на
 * /v1/chat/completions» — читалась человеком как обрыв связи, хотя связь была в порядке
 * и починка требовалась совсем другая. Теперь код не выдумывается: без кода это ошибка
 * модели с её собственным текстом, а SyntaxError диагностируется как «вернула не JSON»
 * (единственный вывод, который из него действительно следует).
 */
function fromClaudeError(e) {
  if (e instanceof BrainError) return e;
  const code = e && typeof e.code === 'string' && e.code ? e.code : '';
  if (code) {
    return ERR(CLAUDE_ERROR_KIND[code] || 'model',
      CLAUDE_ERROR_TEXT[code] || (e && e.message) || 'Сбой модели',
      { code, text: e && e.text });
  }
  const isSyntax = e instanceof SyntaxError || (e && e.name === 'SyntaxError');
  if (isSyntax) {
    return ERR('schema', CLAUDE_ERROR_TEXT.invalid_json, { text: e && e.message });
  }
  const raw = String((e && e.message) || '').trim();
  // русскую фразу провайдера показываем как есть, техническую — с русской рамкой
  const message = !raw ? 'Модель не смогла ответить, а причины не назвала. Попробуйте ещё раз.'
    : /[Ѐ-ӿ]/.test(raw) ? raw
      : `Ошибка модели: ${raw}`;
  return ERR('model', message, { text: e && e.text });
}

/**
 * Круг 16, п.6: служебная запись — ОТЧЁТ, а не совет. «Починка не удалась: Сбой связи с
 * моделью. Попробуйте ещё раз.» смешивала две роли: совет «попробуйте ещё раз» адресован
 * человеку, а служебная запись человеку и не адресована — она уходит в serviceNotes, под
 * «Подробности». Оставляем в ней только факт; совет остаётся там, где он к месту, — в
 * сообщении об ошибке, которое человек и читает.
 *
 * Список начал закрытый: гадать, где совет, а где факт, нельзя — можно потерять причину.
 */
const RE_ADVICE = /^(попроб|повтор|подожд|скаж|переформул|выдел|разреш|войд|провер|упрост|назов|нажм|обнов)/i;

/** Сообщение без адресованных человеку советов. Если факта не осталось — первая фраза. */
export function factOnly(message) {
  const text = String(message == null ? '' : message).trim();
  if (!text) return text;
  const parts = text.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((x) => !RE_ADVICE.test(x.replace(/^[«"(\s]+/, '')));
  return (kept.length ? kept.join(' ') : parts[0]).trim();
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw ERR('cancelled', 'Команда отменена');
}

/**
 * Длительность для человека (п.12). Math.round(ms/1000) при небольшом дедлайне давал
 * «Модель не ответила за 0 с» — фраза, из которой человек ничего не понимает.
 */
export function fmtDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 950) return `${Math.max(1, Math.round(n))} мс`;
  const s = n / 1000;
  return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)} с`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Разбор ответа модели: <think>, ```-ограждения, первый сбалансированный объект
 * ──────────────────────────────────────────────────────────────────────────── */

/** Вырезает рассуждения и ограждения, возвращает текст первого JSON-значения или null. */
export function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  s = s.replace(/<think>[\s\S]*$/i, ' ');            // незакрытый блок рассуждений
  s = s.replace(/<\/?(think|thinking|reasoning)>/gi, ' ');
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  else s = s.replace(/```+\s*(?:json)?/gi, ' ');
  return firstBalanced(s);
}

function firstBalanced(s) {
  const start = (() => {
    const a = s.indexOf('{'), b = s.indexOf('[');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  })();
  if (start < 0) return null;
  const stack = [];
  let inStr = false, esc = false, lastClose = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (!stack.length || stack.pop() !== c) return null;
      lastClose = i;
      if (!stack.length) return s.slice(start, i + 1);
    }
  }
  // Генерация оборвалась: сначала кусок до последней закрывающей скобки, потом — с дозакрытием.
  if (lastClose > start) {
    const cut = s.slice(start, lastClose + 1);
    if (tryParse(cut) !== undefined) return cut;
  }
  let tail = s.slice(start).replace(/,\s*$/, '');
  if (inStr) tail += '"';
  tail = tail.replace(/,\s*(?:"[^"]*"\s*:?\s*)?$/, '');
  while (stack.length) tail += stack.pop();
  return tryParse(tail) !== undefined ? tail : null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Терпимый разбор ответа модели в объект. Бросает BrainError('schema'). */
export function parseModelJson(raw) {
  const direct = tryParse(typeof raw === 'string' ? raw.trim() : '');
  if (direct !== undefined && direct !== null) return direct;
  const slice = extractJson(raw);
  const parsed = slice == null ? undefined : tryParse(slice);
  if (parsed === undefined || parsed === null) {
    throw ERR('schema', 'В ответе модели нет JSON', { text: typeof raw === 'string' ? cutText(raw, 2000) : '' });
  }
  return parsed;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Схемы
 *
 * Схема одна на два получателя, но живёт в двух представлениях:
 *   • .schema — JSON Schema, уходит в LM Studio как response_format.json_schema (strict);
 *   • .hint + .example — текстовое описание формы, уходит в промпт Claude,
 *     потому что sample.json НЕ принимает схему (см. sample.d.ts): формат задаётся словами.
 *
 * Решения по совместимости с локальными грамматиками (llama.cpp json-schema-to-grammar,
 * на котором стоит структурированный вывод LM Studio):
 *   1. Никаких $ref и рекурсии: дерево развёрнуто в 6 вложенных уровней руками
 *      (ровно предел DSL). Рекурсивную схему конвертер грамматик не компилирует.
 *   2. anyOf только из скаляров и только на одном уровне (size: число | "hug" | "fill",
 *      padding: число | массив). Вложенные объединения конвертер раздувает до
 *      неработающей грамматики; downgradeSchema() схлопывает их, если схема придёт извне.
 *   3. additionalProperties:false НЕ ставим нигде. Получатель JSON-схемы у нас один —
 *      локальный сервер, а его конвертер и так порождает закрытые объекты: ключей вне
 *      properties модель физически не сгенерирует. Зато без этого ключа мы вправе
 *      держать почти все поля необязательными (strict-режим OpenAI требует, чтобы при
 *      additionalProperties:false КАЖДОЕ свойство было в required, — для DSL с горой
 *      необязательных полей это означало бы поток null-ей). Проверить на живом
 *      LM Studio в этой среде было нечем: решение сделано по семантике конвертера.
 *   4. Точка в регулярных выражениях записана как [.] — экранирование \. ломает тот же
 *      конвертер (та же мина, что и в исходном layout-agent).
 *   5. Значение точечной правки (edits[].value) — всегда СТРОКА («24», «fill», «#101418»,
 *      «{"mode":"fixed","value":24}»). Поле «любого типа» в грамматику не переводится;
 *      разбор строки берёт на себя coerceValue().
 * ──────────────────────────────────────────────────────────────────────────── */

export const MAX_TREE_DEPTH = 6;
export const MAX_CHILDREN = 24;
/** Общий предел на число узлов в одном разборе (п.19): глубина 6 и ширина 24 по отдельности
 *  дают дерево в тысячи узлов и такой же поток предупреждений. */
export const MAX_TREE_NODES = 400;

/**
 * Предел длины текста узла (круг 5, п.7). `name` резался до 80 знаков, а `characters` — нет,
 * и одна строка из ответа модели становилась миной: замер на демо — 300 000 знаков при
 * size.w:"hug" дают прямоугольник шириной 2 340 000 px (макет уезжает за холст, экспорт в PNG
 * отказывает), 2 000 000 знаков — solve 1.05 с на каждый кадр перетаскивания. 5 000 знаков —
 * это ~2 страницы текста: больше в макет осмысленно не кладут, а меньше резало бы статьи.
 */
export const MAX_CHARS = 5000;

/* Круг 25: строки, уходящие в документ, журнал и трассы. `s.slice(0, n)` режет по
   UTF-16-единицам и разрывает суррогатную пару (эмодзи в имени: «🚀 Запуск…» →
   одиночный суррогат) — Postgres не принимает такую строку в jsonb, и запись правки
   агента падала целиком. Те же правила, что `core.cutText`/`core.cleanText` (тест
   сверяет): brain грузится и без движка, поэтому копия своя. */

/** Не длиннее `n` кодовых точек; не строка — к строке (null/undefined → ''). */
export function cutText(s, n) {
  const str = typeof s === 'string' ? s : s === null || s === undefined ? '' : String(s);
  const max = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : Infinity;
  if (str.length <= max) return str;
  let i = 0;
  let count = 0;
  while (i < str.length && count < max) {
    const c = str.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    i += pair ? 2 : 1;
    count++;
  }
  return str.slice(0, i);
}

/** Последние `n` кодовых точек — хвост, тоже без разрыва пары. */
function cutTail(s, n) {
  const str = typeof s === 'string' ? s : String(s == null ? '' : s);
  const max = Math.max(0, Math.floor(n) || 0);
  if (str.length <= max) return str;
  let i = str.length;
  let count = 0;
  while (i > 0 && count < max) {
    const c = str.charCodeAt(i - 1);
    const pair = c >= 0xdc00 && c <= 0xdfff && i - 2 >= 0 && (str.charCodeAt(i - 2) & 0xfc00) === 0xd800;
    i -= pair ? 2 : 1;
    count++;
  }
  return str.slice(i);
}

const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Без `\u0000`, одиночные суррогаты → U+FFFD. Не строка — как есть. */
export function cleanText(s) {
  if (typeof s !== 'string') return s;
  let out = s.indexOf('\u0000') >= 0 ? s.replace(/\u0000/g, '') : s;
  if (typeof out.isWellFormed === 'function') {
    if (!out.isWellFormed()) out = out.toWellFormed();
  } else {
    out = out.replace(LONE_SURROGATE_RE, '\uFFFD');
  }
  return out;
}

/** cleanText вглубь простых данных; ничего не поменялось — тот же объект (без копий). */
function cleanDeep(v, depth = 0) {
  if (typeof v === 'string') return cleanText(v);
  if (!v || typeof v !== 'object' || depth > 64) return v;
  if (Array.isArray(v)) {
    let out = null;
    for (let i = 0; i < v.length; i++) {
      const c = cleanDeep(v[i], depth + 1);
      if (c !== v[i]) { if (!out) out = v.slice(); out[i] = c; }
    }
    return out || v;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  let out = null;
  for (const k of Object.keys(v)) {
    const c = cleanDeep(v[k], depth + 1);
    if (c !== v[k]) { if (!out) out = { ...v }; out[k] = c; }
  }
  return out || v;
}

/**
 * Результат прогона, который можно записать: строки операций, заголовок, итог,
 * предупреждения — без `\u0000` и одиночных суррогатов (что бы ни прислала модель).
 * Превью (документ и геометрия для показа) не трогается: оно не пишется.
 */
function cleanResult(res) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return res;
  let out = null;
  for (const k of Object.keys(res)) {
    if (k === 'preview' || k === 'geo' || k === 'doc') continue;
    const c = cleanDeep(res[k]);
    if (c !== res[k]) { if (!out) out = { ...res }; out[k] = c; }
  }
  return out || res;
}

/** Текст из ответа модели → текст, который можно положить в документ. */
function clampChars(raw, note, what) {
  const s = String(raw == null ? '' : raw);
  if (s.length <= MAX_CHARS) return s;
  if (note) note(`${what || 'Текст'}: ${s.length} знаков — обрезал до ${MAX_CHARS}, столько в макет не поместится`);
  return cutText(s, MAX_CHARS);
}

/** Счётчик узлов на весь разбор: предупреждает один раз, дальше молча отбрасывает. */
function makeNodeBudget(note) {
  const state = {
    left: MAX_TREE_NODES,
    warned: false,
    take() {
      if (state.left <= 0) {
        if (!state.warned) {
          state.warned = true;
          if (note) note(`Модель вернула больше ${MAX_TREE_NODES} слоёв — оставлены первые ${MAX_TREE_NODES}, остальное отброшено`);
        }
        return false;
      }
      state.left--;
      return true;
    },
  };
  return state;
}

const NODE_TYPES = ['frame', 'text', 'rect', 'ellipse', 'image'];
const LAYOUT_MODES = ['none', 'row', 'column'];
const ALIGNS = ['start', 'center', 'end', 'stretch'];
const JUSTIFIES = ['start', 'center', 'end', 'between'];
// core.js принимает у текста left|center|right (у layout.align — start|center|end|stretch),
// поэтому синонимы из DSL модели приводим к значениям движка.
const TEXT_ALIGNS = ['left', 'center', 'right'];
// Приведение выключки к значениям движка живёт в ENUMS.align ниже: оно единственное и говорящее.

/**
 * Круг 7, п.1: значение вне перечисления больше НЕ подменяется молча первым элементом списка.
 * Модель (особенно локальная) регулярно отвечает словами CSS: «space-between», «flex-start»,
 * «grid», «justify». Раньше `layout.justify: "space-between"` становился «start» без единого
 * слова — аватар в шапке прилипал к дате, а в предупреждениях было пусто; `layout.mode: "grid"`
 * превращал строку показателей в колонку, и человек видел только следствие («вылез за рамки»).
 *
 * Теперь у каждого поля-перечисления ДВА явных списка:
 *   syn   — очевидные синонимы (о подстановке говорим словами: «space-between» → «between»);
 *   hints — знакомые, но неподдерживаемые значения: правка пропускается, и человеку объясняют,
 *           чем её заменить.
 * Всё остальное — тоже пропуск с объяснением, как для неизвестного пути.
 */
const ENUMS = {
  'layout.mode': {
    values: LAYOUT_MODES,
    what: 'направление раскладки',
    syn: {
      row: 'row', horizontal: 'row', 'flex-row': 'row', hbox: 'row', inline: 'row',
      'в строку': 'row', строка: 'row', строкой: 'row', горизонтально: 'row',
      column: 'column', col: 'column', vertical: 'column', 'flex-column': 'column', vbox: 'column',
      stack: 'column', 'в колонку': 'column', колонка: 'column', колонкой: 'column', вертикально: 'column',
      none: 'none', absolute: 'none', static: 'none', free: 'none', manual: 'none', block: 'none', нет: 'none',
    },
    hints: {
      grid: 'сетки в раскладке нет: сетка собирается строкой с переносом — поток «строка» плюс перенос',
      flex: 'это не направление: нужно «строка» или «столбец»',
      wrap: 'перенос строк — это отдельное свойство «перенос»',
      'inline-flex': 'нужно «строка» или «столбец»',
    },
  },
  'layout.align': {
    values: ALIGNS,
    what: 'выравнивание содержимого поперёк раскладки',
    syn: {
      start: 'start', 'flex-start': 'start', begin: 'start', top: 'start', left: 'start', начало: 'start',
      center: 'center', centre: 'center', middle: 'center', 'по центру': 'center', центр: 'center',
      end: 'end', 'flex-end': 'end', bottom: 'end', right: 'end', конец: 'end',
      stretch: 'stretch', fill: 'stretch', grow: 'stretch', 'во всю ширину': 'stretch',
    },
    hints: {
      baseline: 'выравнивания по базовой линии нет; ближайшее — «по центру»',
      'space-between': 'разнести по краям — это «распределение: с промежутками», а не выравнивание',
      'space-around': 'разнести по краям — это «распределение: с промежутками», а не выравнивание',
    },
  },
  'layout.justify': {
    values: JUSTIFIES,
    what: 'распределение содержимого вдоль раскладки',
    syn: {
      start: 'start', 'flex-start': 'start', left: 'start', top: 'start', begin: 'start', начало: 'start',
      center: 'center', centre: 'center', middle: 'center', 'по центру': 'center', центр: 'center',
      end: 'end', 'flex-end': 'end', right: 'end', bottom: 'end', конец: 'end',
      between: 'between', 'space-between': 'between', spacebetween: 'between',
      'по краям': 'between', 'по бокам': 'between',
    },
    hints: {
      'space-around': 'такого распределения нет; по краям — это «с промежутками», иначе задайте зазор',
      'space-evenly': 'такого распределения нет; по краям — это «с промежутками», иначе задайте зазор',
      stretch: 'растянуть содержимое — это «выравнивание: растянуть»',
    },
  },
  align: {
    values: TEXT_ALIGNS,
    what: 'выключка текста',
    syn: {
      left: 'left', start: 'left', 'flex-start': 'left', 'по левому краю': 'left', слева: 'left',
      center: 'center', centre: 'center', middle: 'center', 'по центру': 'center', центр: 'center',
      right: 'right', end: 'right', 'flex-end': 'right', 'по правому краю': 'right', справа: 'right',
    },
    hints: {
      justify: 'выключки по ширине у текста нет: есть «влево», «по центру» и «вправо»',
      'space-between': 'это не про текст: выберите «влево», «по центру» или «вправо»',
      stretch: 'это не про текст: выберите «влево», «по центру» или «вправо»',
    },
  },
};

/**
 * Значение поля-перечисления: своё, синоним (о подстановке говорим словами) или пропуск
 * с объяснением. fallback задаётся там, где пропустить нельзя (новый узел): тогда вместо
 * «правка пропущена» человеку говорят, что осталось.
 */
function pickEnum(raw, field, { warn, what, fallback } = {}) {
  const spec = ENUMS[field];
  const note = warn || (() => {});
  const who = what || `Правка «${ruPath(field)}»`;
  if (!spec) return raw;
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const s = String(raw == null ? '' : raw).trim().toLowerCase()
    .replace(/[_]+/g, '-').replace(/\s+/g, ' ').replace(/ё/g, 'е');
  if (!s) {
    note(`${who}: значение не задано — ${fallback ? `оставил «${ruEnum(field, fallback)}»` : 'правка пропущена'}`);
    return fallback;
  }
  if (spec.values.includes(s)) return s;
  const syn = spec.syn[s] || spec.syn[s.replace(/-/g, '')] || null;
  if (syn) {
    /* Текст синонима СОЗНАТЕЛЬНО без имени узла: у «start» → «left» нет последствий для
     * конкретного слоя, это переименование того же смысла, и одинаковая строка на двадцать
     * текстов свернётся в одну (warn дедуплицирует). Имя узла важно там, где правка не прошла. */
    note(`«${shown}» — значение из CSS, а не из этого редактора: понял как «${ruEnum(field, syn)}» (${spec.what})`);
    return syn;
  }
  const hint = spec.hints && spec.hints[s];
  note(`${who}: «${shown}» — не одно из ${spec.values.map((x) => ruEnum(field, x)).join(', ')};`
    + ` ${fallback ? `оставил «${ruEnum(field, fallback)}»` : 'правка пропущена'}.`
    + (hint ? ` ${hint}` : ''));
  return fallback;
}

/** Путь токена: colors.<имя> | type.<стиль>[.поле] | spacing | radii. Точка как [.] — см. п.4. */
export const TOKEN_PATH_RE =
  /^(colors[.][A-Za-z0-9_-]+|type[.][A-Za-z0-9_-]+([.](fontSize|fontWeight|lineHeight|letterSpacing|font))?|spacing|radii|motion[.](fast|base|slow)|shadow[.](sm|md|lg))$/;

const sizeSpecSchema = () => ({
  anyOf: [
    { type: 'number' },
    { type: 'string', enum: ['hug', 'fill'] },
  ],
});

/**
 * Круг 20 (SPEC §6.1): отступ и скругление — число ИЛИ ссылка на шаг шкалы ("spacing.6").
 * Строка в схеме нужна не «на всякий случай»: строгая грамматика провайдера иначе не даст
 * модели ответить ссылкой, и всё правило §6.6 останется на бумаге.
 */
const scaleValueSchema = () => ({
  anyOf: [
    { type: 'number' },
    { type: 'string' },
  ],
});

const paddingSchema = () => ({
  anyOf: [
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: scaleValueSchema(), maxItems: 4 },
  ],
});

const colorSchema = () => ({ type: 'string' }); // имя токена документа или #rrggbb

/**
 * Круг 36 (SPEC §11): состояния и движение в дереве. Значения — строки или числа: ссылки на
 * шкалы («spacing.1», «motion.fast», «shadow.md») — строки, масштаб и прозрачность — числа.
 * Перечисления у тени и кривой даны явно: строгой грамматике провайдера так проще не промахнуться.
 */
const SHADOW_ENUM = ['none', 'shadow.sm', 'shadow.md', 'shadow.lg'];
const numOrStr = () => ({ anyOf: [{ type: 'number' }, { type: 'string' }] });
function statePatchSchema() {
  return {
    type: 'object',
    properties: {
      fill: colorSchema(), color: colorSchema(), stroke: colorSchema(),
      opacity: { type: 'number' }, scale: { type: 'number' },
      lift: numOrStr(),
      shadow: { type: 'string', enum: SHADOW_ENUM },
    },
  };
}
function statesSchema() {
  return { type: 'object', properties: { hover: statePatchSchema(), press: statePatchSchema(), focus: statePatchSchema() } };
}
function motionSchema() {
  return {
    type: 'object',
    properties: {
      duration: numOrStr(),
      easing: { type: 'string', enum: ['standard', 'emphasized', 'decelerate', 'accelerate', 'linear', 'spring'] },
      delay: { type: 'number' },
      follow: { type: 'string', enum: ['self', 'parent'] },
    },
  };
}

function layoutSchema() {
  return {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: LAYOUT_MODES },
      gap: scaleValueSchema(),
      padding: paddingSchema(),
      align: { type: 'string', enum: ALIGNS },
      justify: { type: 'string', enum: JUSTIFIES },
      wrap: { type: 'boolean' },
    },
    required: ['mode'],
  };
}

/** Дерево развёрнуто по уровням: рекурсия заменена вложенностью (см. п.1). */
function treeNodeSchema(depth = MAX_TREE_DEPTH, maxChildren = MAX_CHILDREN) {
  const node = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: NODE_TYPES.concat(['instance']) },
      name: { type: 'string' },
      layout: layoutSchema(),
      size: { type: 'object', properties: { w: sizeSpecSchema(), h: sizeSpecSchema() } },
      fill: colorSchema(),
      stroke: colorSchema(),
      color: colorSchema(),
      radius: scaleValueSchema(),
      text: { type: 'string' },
      style: { type: 'string' },
      align: { type: 'string', enum: ['left', 'center', 'right'] },
      src: { type: 'string' },
      // круг 36 (SPEC §11): тень, прозрачность, состояния и движение
      shadow: { type: 'string', enum: SHADOW_ENUM },
      opacity: { type: 'number' },
      states: statesSchema(),
      motion: motionSchema(),
      /**
       * Круг 19, п.2 (SPEC §5.5): экземпляр компонента — не новая ФОРМА правки, а новый ТИП
       * УЗЛА в том же дереве. Поэтому он сразу доступен и генерации целого экрана, и правке
       * {op:"create", node}, и вся машинерия «куда класть» работает без единой поправки.
       * props — массив, а не словарь: словарь с произвольными ключами в JSON-схеме не
       * выражается (та же причина, что у SCHEMAS.theme).
       */
      of: { type: 'string' },
      props: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, value: { type: 'string' } },
          required: ['name', 'value'],
        },
      },
    },
    required: ['type'],
  };
  if (depth > 1) {
    node.properties.children = {
      type: 'array',
      maxItems: maxChildren,
      items: treeNodeSchema(depth - 1, maxChildren),
    };
  }
  return node;
}

const TREE_HINT = `{
  type: "frame" | "text" | "rect" | "ellipse" | "image" | "instance",
  of?: string,                         // ТОЛЬКО для type:"instance": ИМЯ компонента из библиотеки
  props?: [{name: string, value: string}],  // ТОЛЬКО для type:"instance": объявленные свойства компонента
  name?: string,                       // короткое русское имя слоя
  layout?: { mode: "none"|"row"|"column", gap?: "spacing.<шаг>" | number, padding?: "spacing.<шаг>" | number | [v,h] | [t,r,b,l],
             align?: "start"|"center"|"end"|"stretch", justify?: "start"|"center"|"end"|"between", wrap?: boolean },
                                       // gap и padding — ССЫЛКОЙ на шаг шкалы отступов ("spacing.6"); число — только мимо шкалы
  size?: { w: number|"hug"|"fill", h: number|"hug"|"fill" },
  fill?: string,                       // имя токена цвета или #rrggbb
  stroke?: string, color?: string, radius?: "radii.<шаг>" | number,   // скругление — ссылкой на шаг шкалы скруглений
  text?: string,                       // только для type:"text"
  style?: string,                      // имя типографического токена, только для type:"text"
  align?: "left"|"center"|"right",   // выключка текста
  src?: string,                        // только для type:"image"
  shadow?: "shadow.sm"|"shadow.md"|"shadow.lg"|"none", opacity?: number,   // тень и прозрачность в покое
  states?: { hover?: State, press?: State, focus?: State },   // микроанимации: вид при наведении/нажатии/фокусе
                                       // State = { fill?, color?, stroke?, opacity?: 0..1, scale?: 0.8..1.2,
                                       //           lift?: "spacing.<шаг>" | px, shadow?: "shadow.md"|… }
  motion?: { duration?: "motion.fast"|"motion.base"|"motion.slow", easing?: "standard"|"emphasized"|"decelerate"|"accelerate"|"linear"|"spring",
             delay?: number, follow?: "self"|"parent" },
  children?: Node[]                    // только для type:"frame"
}`;

const TREE_EXAMPLE = {
  type: 'frame',
  name: 'Экран заказа',
  layout: { mode: 'column', gap: 'spacing.6', padding: ['spacing.8', 'spacing.7'], align: 'stretch', justify: 'start', wrap: false },
  size: { w: 390, h: 'hug' },
  fill: 'canvas',
  children: [
    { type: 'text', name: 'Заголовок', text: 'Ваш заказ готов', style: 'display', size: { w: 'fill', h: 'hug' } },
    { type: 'text', name: 'Подпись', text: 'Курьер заберёт его через 12 минут', style: 'body', color: 'muted', size: { w: 'fill', h: 'hug' } },
  ],
};

export const SCHEMAS = {
  /** Что агент собирается сделать. */
  plan: {
    name: 'plan',
    schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['create', 'edit', 'theme', 'ask', 'clarify', 'refuse'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        // круг 11, п.10: шаги не «для отчёта» — buildUserTurn кладёт их в реплику ВТОРОЙ стадии
        // («Шаги: 1) … 2) …»), и генератор дерева/патча решает задачу по уже принятому плану,
        // а не придумывает его заново. Для вариантов это ещё и то, чем они отличаются друг
        // от друга: у каждого свой план, и следующий вариант видит решения предыдущих.
        steps: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        targets: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        clarify: { type: 'string' },
        // круг 18: переспрос без вариантов заставлял человека переписывать команду заново
        clarifyOptions: { type: 'array', items: { type: 'string' } },
        // круг 9, п.4: «в этой модели документа так нельзя» — это ответ, а не авария
        cannot: { type: 'string' },
      },
      required: ['intent', 'title', 'summary', 'steps'],
    },
    hint: `{ intent: "create"|"edit"|"theme"|"ask"|"clarify"|"refuse", title: string (название работы, БЕЗ прошедшего времени), summary: string, steps: string[] (1-5), targets: string[], clarify?: string (русский переспрос, если intent="clarify"), clarifyOptions?: string[] (РОВНО 3 готовые команды-ответа, если intent="clarify"), cannot?: string (почему просьба невыполнима, если intent="refuse") }`,
    example: {
      intent: 'edit',
      title: 'Крупный заголовок карточки',
      summary: 'Поменяю типографический токен заголовка и отступ под ним.',
      steps: ['Найти заголовок в выделенной карточке', 'Поставить стиль h1', 'Увеличить gap до 16'],
      targets: ['Заголовок'],
    },
  },

  /**
   * Компактное дерево макета. Корню разрешено вместо узла вернуть отказ (круг 9, п.4):
   * «нарисуй анимацию загрузки» в этой модели документа не выразить, и честное «нельзя»
   * полезнее статичной подделки под анимацию.
   */
  tree: {
    name: 'tree',
    schema: (() => {
      const root = treeNodeSchema(MAX_TREE_DEPTH, MAX_CHILDREN);
      root.properties.cannot = { type: 'string' };
      return root;                                 // required: ['type'] не ослабляем: отказ читается по cannot
    })(),
    hint: `${TREE_HINT}
Либо, если построить просимое в этой модели документа нельзя: { cannot: "<почему, по-русски>" }`,
    example: TREE_EXAMPLE,
  },

  /** Список точечных правок. */
  patch: {
    name: 'patch',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        // круг 9, п.4: «поверни на 15°», «сделай градиент» — в модели документа этого НЕТ. Раньше
        // модели оставалось либо выдумать поле (и получить «Ни одну правку не удалось применить»),
        // либо вернуть пустой edits (и получить «Модель не вернула ни одной правки») — в обоих
        // случаях человек видел аварию вместо главного: просить бесполезно.
        cannot: { type: 'string' },
        edits: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              /* круг 19, п.2: master / detach / component — про КОМПОНЕНТЫ, и это отдельные
               * операции, а не set по имени: у мастера «Кнопка» и у слоя «Кнопка «Добавить пункт»»
               * одно и то же слово в имени, поэтому «поправить одну кнопку» было бы неотличимо
               * от «поправить все» (обоснование — в componentRules). */
              op: { type: 'string', enum: ['set', 'remove', 'create', 'move', 'duplicate', 'nudge', 'master', 'detach', 'component'] },
              target: { type: 'string' },
              path: { type: 'string' },
              value: { type: 'string' },
              node: treeNodeSchema(4, 12),
              parent: { type: 'string' },
              index: { type: 'integer' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              // op:"component": как назвать новый компонент
              name: { type: 'string' },
            },
            required: ['op', 'target'],
          },
        },
      },
      required: ['edits'],
    },
    hint: `{ summary?: string,
  cannot?: string,       // просьбу нельзя выполнить в этой модели документа — объясни по-русски,
                         // почему именно, и оставь edits пустым. НЕ выдумывай поле ради вида.
  edits: [{
  op: "set" | "remove" | "create" | "move" | "duplicate" | "nudge" | "master" | "detach" | "component",
                         // master/detach/component — только если выше есть блок «БИБЛИОТЕКА ПРОДУКТА»:
                         // master — правка САМОГО компонента (сразу во всех его экземплярах),
                         // detach — отсоединить экземпляр, component — сделать узел компонентом.
  target: string,        // id узла ("#f12"), точное имя слоя ("Кнопка оформить") или "selection";
                         // для op:"master" — ИМЯ компонента из библиотеки ("Кнопка")
  path?: string,         // для set: "characters" | "style" | "fill" | "size.w" | "layout.gap" | "layout.padding" | "radius" | "align" ...
                         // микроанимации: "states.hover" | "states.hover.lift" | "states.press.scale" | "motion.duration" | "shadow" ...
                         // у экземпляра компонента — только "props.<имя свойства>"
  value?: string,        // ВСЕГДА строка: "spacing.6", "radii.4", "fill", "hug", "#101418", "accent", "Купить",
                         // "motion.fast", "shadow.md", "0.97", "{\"lift\":\"spacing.1\",\"shadow\":\"shadow.md\"}".
                         // зазор, отступы, скругление — ссылкой на шаг шкалы ("spacing.6"); число — только мимо шкалы
                         // value:"none" (или вовсе без value) = СНЯТЬ свойство: «без заливки»,
                         // «убери скругление». Снимаются fill, stroke, color, radius, opacity,
                         // src, clip, style, align, layout.*, override — но не characters и не size.
  node?: Node,           // для create: поддерево в том же DSL, что и схема tree
  parent?: string,       // для create (ОБЯЗАТЕЛЬНО) и для move/duplicate: узел-контейнер
  index?: number,        // позиция среди детей
  dx?: number, dy?: number, // только для nudge: сдвиг в пикселях от текущего места
  name?: string          // только для op:"component": как назвать новый компонент
}] }`,
    example: {
      summary: 'Крупнее заголовок и плотнее отступ',
      edits: [
        { op: 'set', target: 'Заголовок', path: 'style', value: 'title' },
        { op: 'set', target: 'selection', path: 'layout.gap', value: 'spacing.5' },
      ],
    },
  },

  /** Изменения токенов документа. Записи — массивы {name, value}: словарь с произвольными
   *  ключами в JSON-схеме не выражается, а грамматике нужен закрытый набор ключей. */
  theme: {
    name: 'theme',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        colors: {
          type: 'array',
          maxItems: 24,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
        type: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              fontSize: { type: 'number' },
              fontWeight: { type: 'number' },
              lineHeight: { type: 'number' },
              letterSpacing: { type: 'number' },
              font: { type: 'string' },
            },
            required: ['name'],
          },
        },
        /* Круг 20 (SPEC §6.1): узлы ссылаются на шаги по номеру, поэтому тема обязана вернуть
         * массив ТОЙ ЖЕ длины. Прежний предел 12 был короче демо-шкалы (13 шагов): модель
         * физически не могла соблюсти правило, и каждая тема укорачивала бы шкалу. */
        spacing: { type: 'array', items: { type: 'number' }, maxItems: 24 },
        radii: { type: 'array', items: { type: 'number' }, maxItems: 16 },
        /* Круг 36 (SPEC §11): ступени скорости анимаций (мс) и тени (CSS-тень строкой). */
        motion: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: { name: { type: 'string', enum: ['fast', 'base', 'slow'] }, value: { type: 'number' } },
            required: ['name', 'value'],
          },
        },
        shadow: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: { name: { type: 'string', enum: ['sm', 'md', 'lg'] }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
      },
    },
    hint: `{ summary?: string,
  colors?: [{name: string, value: "#rrggbb"}],
  type?: [{name: string, fontSize?: number, fontWeight?: number, lineHeight?: number, letterSpacing?: number, font?: string}],
  spacing?: number[], radii?: number[],   // шкалы — массивы ТОЙ ЖЕ длины, что сейчас: узлы ссылаются на шаги по номеру
  motion?: [{name: "fast"|"base"|"slow", value: number /* мс */}],
  shadow?: [{name: "sm"|"md"|"lg", value: string /* "dx dy blur цвет": "0 4px 12px rgba(0,0,0,.14)" */}] }`,
    example: {
      summary: 'Тёмная палитра',
      colors: [{ name: 'canvas', value: '#0D0E12' }, { name: 'text', value: '#E8EAF0' }],
    },
  },

  /** Текстовый ответ на вопрос о макете. */
  answer: {
    name: 'answer',
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        followups: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      },
      required: ['answer'],
    },
    hint: `{ answer: string (русский текст, 1-6 предложений), followups?: string[] }`,
    example: { answer: 'В карточке три текстовых слоя и одна кнопка; ширина карточки фиксирована — 320.' },
  },
};

function normalizeSchemaEntry(schema) {
  if (!schema) return null;
  if (schema.schema) return { name: schema.name || 'result', schema: schema.schema, hint: schema.hint, example: schema.example };
  return { name: schema.name || 'result', schema, hint: undefined, example: undefined };
}

/**
 * Понижение произвольной JSON-схемы до «плоской» формы для локальных грамматик:
 * разворачивает $ref (с ограничением глубины), схлопывает вложенные oneOf/anyOf,
 * выбрасывает ключевые слова, которые конвертер не понимает или раздувают грамматику.
 */
export function downgradeSchema(schema, opts = {}) {
  const maxDepth = opts.maxDepth == null ? MAX_TREE_DEPTH : Math.max(1, Math.min(12, opts.maxDepth));
  const defs = { ...(schema && schema.$defs), ...(schema && schema.definitions) };
  const DROP = new Set([
    '$schema', '$id', '$comment', '$defs', 'definitions', 'title', 'description',
    'default', 'examples', 'additionalProperties', 'patternProperties', 'unevaluatedProperties',
    'if', 'then', 'else', 'not', 'const', 'format', 'minimum', 'maximum',
    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
    'minProperties', 'maxProperties', 'uniqueItems', 'minItems',
  ]);

  const walk = (node, depth, unionDepth) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n) => walk(n, depth, unionDepth));

    if (typeof node.$ref === 'string') {
      const key = node.$ref.replace(/^#\/(?:\$defs|definitions)\//, '');
      const target = defs[key];
      if (!target || depth >= maxDepth) return { type: 'object' };
      return walk(target, depth + 1, unionDepth);
    }

    const union = node.oneOf || node.anyOf;
    if (union && Array.isArray(union)) {
      // Объединения любой вложенности сплющиваются в один уровень ветвей-скаляров:
      // грамматика локального сервера не тянет oneOf внутри oneOf.
      const flatten = (n) => {
        const u = n && (n.oneOf || n.anyOf);
        if (!Array.isArray(u)) return [walk(n, depth, 0)];
        const out = [];
        for (const b of u) out.push(...flatten(b));
        return out;
      };
      const flat = flatten(node);
      const rest = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'oneOf' || k === 'anyOf' || DROP.has(k)) continue;
        rest[k] = walk(v, depth, unionDepth);
      }
      return { ...rest, anyOf: flat };
    }

    if (Array.isArray(node.allOf)) {
      let merged = {};
      for (const part of node.allOf) merged = mergeShallow(merged, walk(part, depth, unionDepth));
      for (const [k, v] of Object.entries(node)) {
        if (k === 'allOf' || DROP.has(k)) continue;
        merged[k] = walk(v, depth, unionDepth);
      }
      return merged;
    }

    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROP.has(k)) continue;
      if (k === 'properties') {
        out.properties = {};
        for (const [pk, pv] of Object.entries(v || {})) out.properties[pk] = walk(pv, depth + 1, 0);
      } else if (k === 'items') {
        out.items = walk(v, depth + 1, 0);
      } else if (k === 'enum' || k === 'required') {
        out[k] = Array.isArray(v) ? v.slice() : v;
      } else {
        out[k] = walk(v, depth, unionDepth);
      }
    }
    return out;
  };

  return walk(schema, 0, 0);
}

function mergeShallow(a, b) {
  const out = { ...a, ...b };
  if (a.properties || b.properties) out.properties = { ...(a.properties || {}), ...(b.properties || {}) };
  if (a.required || b.required) out.required = [...new Set([...(a.required || []), ...(b.required || [])])];
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Провайдеры
 * ──────────────────────────────────────────────────────────────────────────── */

export function makeProvider(cfg = {}) {
  const kind = cfg.kind || 'claude';
  if (kind === 'claude') return makeClaudeProvider(cfg);
  if (kind === 'lmstudio' || kind === 'openai') return makeOpenAiProvider(cfg);
  throw ERR('model', `Неизвестный вид провайдера: ${kind}`);
}

/* — Claude (артефакт) — */

function makeClaudeProvider(cfg) {
  let samplePromise = null;

  async function getSample() {
    if (cfg.sample) return cfg.sample;
    const host = cfg.claude || (typeof globalThis !== 'undefined' ? globalThis.claude : null);
    if (!host || typeof host.use !== 'function') return null;
    if (!samplePromise) samplePromise = Promise.resolve(host.use('sample')).catch(() => null);
    return samplePromise;
  }

  return {
    name: cfg.name || 'Claude',
    kind: 'claude',

    async ready() {
      return !!(await getSample());
    },

    async complete(messages, schema, opts = {}) {
      const sample = await getSample();
      if (!sample || typeof sample.json !== 'function') {
        throw ERR('model', 'Claude недоступен в этом окне: способность sample не выдана. Откройте артефакт в Claude или переключитесь на локальную модель.');
      }
      const entry = normalizeSchemaEntry(schema);
      const turns = clampTurns(messagesToTurns(messages, entry));
      const t0 = now();
      // Дедлайн, как у OpenAI-провайдера: зависший вызов не держит приложение в «агент думает».
      const timeout = opts.timeout == null ? (cfg.timeout == null ? 120000 : cfg.timeout) : opts.timeout;
      const guard = withTimeout(opts.signal, timeout);
      try {
        const call = sample.json(turns, {
          signal: guard.signal,
          modelTier: opts.modelTier || 'default',
          cache: opts.cache === undefined ? false : opts.cache,
          onText: opts.onText ? (u) => { try { opts.onText(u.text, u.delta); } catch { /* ignore */ } } : undefined,
        });
        // sample.json может не слушать signal — гоним промис с отменой и дедлайном сами.
        const data = await raceAbort(call, opts.signal, timeout, `Модель не ответила за ${fmtDuration(timeout)}`);
        if (!data || typeof data !== 'object') throw ERR('schema', 'Модель вернула не объект');
        // круг 31: глубина и размер — до JSON.stringify ниже и до обходов brain
        const bad = modelDataProblem(data);
        if (bad) throw badResponse(`Ответ модели не той формы (${bad}) — попробуйте ещё раз`);
        if (opts.onUsage) {
          opts.onUsage({
            calls: 1, ms: now() - t0,
            promptChars: turns.reduce((s, t) => s + t.content.length, 0),
            completionChars: JSON.stringify(data).length,
          });
        }
        return data;
      } catch (e) {
        if (guard.timedOut) throw ERR('network', `Модель не ответила за ${fmtDuration(timeout)}`);
        throw fromClaudeError(e);
      } finally {
        guard.done();
      }
    },
  };
}

/**
 * Гонка промиса модели с отменой и дедлайном (п.15): провайдер может не слушать signal,
 * поэтому «Отменить» обязано срабатывать здесь, а не только между шагами конвейера.
 */
export function raceAbort(promise, signal, ms, timeoutMessage) {
  if (!signal && !ms) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
    };
    const settle = (fn) => (v) => { if (!settled) { settled = true; cleanup(); fn(v); } };
    const onAbort = () => settle(reject)(ERR('cancelled', 'Команда отменена'));
    if (signal) {
      if (signal.aborted) { settled = true; reject(ERR('cancelled', 'Команда отменена')); return; }
      if (signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    }
    if (ms) {
      // таймер НЕ unref: он обязан сработать, даже если больше в процессе ничего не ждёт
      timer = setTimeout(() => settle(reject)(ERR('network', timeoutMessage || `Модель не ответила за ${fmtDuration(ms)}`)), ms);
    }
    Promise.resolve(promise).then(settle(resolve), settle(reject));
  });
}

/**
 * messages (с ролью 'system') → турны sample: системной роли там нет, инструкции идут
 * ведущим user-турном; список обязан начинаться и заканчиваться на user. Схема уходит
 * словами — sample.json схему не принимает.
 */
function messagesToTurns(messages, entry) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = list.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).filter(Boolean);
  if (entry && (entry.hint || entry.schema)) sys.push(formatSchemaInstruction(entry));
  const turns = [];
  if (sys.length) turns.push({ role: 'user', content: sys.join('\n\n') });
  for (const m of list) {
    if (!m || m.role === 'system') continue;
    const content = String(m.content == null ? '' : m.content);
    if (!content.trim()) continue;
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  if (!turns.length) throw ERR('schema', 'Пустой запрос к модели');
  if (turns[0].role !== 'user') turns.unshift({ role: 'user', content: 'Контекст ниже.' });
  if (turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: 'Верни итоговый JSON по схеме.' });
  return turns;
}

export function formatSchemaInstruction(entry) {
  const e = normalizeSchemaEntry(entry);
  if (!e) return '';
  const shape = e.hint || JSON.stringify(e.schema);
  let out = `ФОРМАТ ОТВЕТА\nОтветь ОДНИМ JSON-объектом и ничем больше: без пояснений, без markdown-ограждений, без рассуждений.\nСхема "${e.name}":\n${shape}`;
  if (e.example) out += `\nПример правильного ответа:\n${JSON.stringify(e.example)}`;
  return out;
}

/** 64 KiB — жёсткий предел sample; режем самый длинный турн по середине. */
function clampTurns(turns, maxChars = 60000) {
  let total = turns.reduce((s, t) => s + t.content.length, 0);
  while (total > maxChars) {
    let idx = 0;
    for (let i = 1; i < turns.length; i++) if (turns[i].content.length > turns[idx].content.length) idx = i;
    const c = turns[idx].content;
    const keep = Math.max(500, Math.floor(c.length - (total - maxChars) - 40));
    if (keep >= c.length) break;
    turns[idx] = { ...turns[idx], content: cutText(c, Math.floor(keep * 0.7)) + '\n…[вырезано]…\n' + cutTail(c, Math.floor(keep * 0.3)) };
    const next = turns.reduce((s, t) => s + t.content.length, 0);
    if (next >= total) break;
    total = next;
  }
  return turns;
}

/* — LM Studio / OpenAI-совместимый — */

function makeOpenAiProvider(cfg) {
  const baseUrl = String(cfg.baseUrl || 'http://localhost:1234/v1').replace(/\/+$/, '');
  const fetchImpl = cfg.fetch || ((...a) => globalThis.fetch(...a));
  // п.16: бюджет одной команды. Раньше было до 3 сетевых × 4 JSON-попыток × 180 с —
  // человек ждал молча десятки минут. Теперь предел виден и конечен.
  const timeout = cfg.timeout == null ? 120000 : cfg.timeout;               // на один запрос
  const budget = cfg.budget == null ? 150000 : cfg.budget;                  // на весь complete()
  const netRetries = cfg.networkRetries == null ? 1 : cfg.networkRetries;   // до 1 сетевого повтора
  const jsonRetries = cfg.jsonRetries == null ? 1 : cfg.jsonRetries;        // до 1 повтора по JSON
  const maxRequests = cfg.maxRequests == null ? 3 : cfg.maxRequests;        // всего запросов на команду
  const backoff = cfg.retryDelay == null ? 500 : cfg.retryDelay;
  // круг 31: потолок тела ответа модели
  const maxBodyBytes = cfg.maxBodyBytes > 0 ? cfg.maxBodyBytes : MODEL_BODY_MAX_BYTES;
  let model = cfg.model || null;

  const headers = () => ({
    'Content-Type': 'application/json',
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    ...(cfg.headers || {}),
  });

  async function ready() {
    const guard = withTimeout(null, cfg.readyTimeout == null ? 4000 : cfg.readyTimeout);
    try {
      const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', headers: headers(), signal: guard.signal });
      if (!res || !res.ok) return false;
      const body = await readBodyCapped(res, maxBodyBytes).then((t) => JSON.parse(t)).catch(() => null);
      // круг 33: id — строкой, чищенный и с пределом длины
      const first = cleanModelId(body && Array.isArray(body.data) && body.data[0] ? body.data[0].id : null);
      if (!model && first) model = first;
      return true;
    } catch {
      return false;
    } finally {
      guard.done();
    }
  }

  async function complete(messages, schema, opts = {}) {
    const entry = normalizeSchemaEntry(schema);
    let convo = (Array.isArray(messages) ? messages : []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: String(m.content == null ? '' : m.content),
    }));
    if (entry && entry.hint) {
      convo = convo.concat([]); // не трогаем массив вызывающего
      convo.splice(0, 0, { role: 'system', content: formatSchemaInstruction(entry) });
    }

    let lastErr = null;
    const budgetState = { requests: 0, startedAt: now() };
    const notify = (text, extra) => {
      if (typeof opts.onRetry !== 'function') return;
      try { opts.onRetry({ text, ...extra }); } catch { /* интерфейс не должен ронять запрос */ }
    };
    for (let jsonAttempt = 0; jsonAttempt <= jsonRetries; jsonAttempt++) {
      checkAbort(opts.signal);
      if (jsonAttempt > 0) {
        notify(`Ответ не по схеме, повтор ${jsonAttempt} из ${jsonRetries}`, { attempt: jsonAttempt, total: jsonRetries, reason: 'schema' });
      }
      const body = {
        model: model || cfg.model || 'local-model',
        messages: convo,
        temperature: opts.temperature == null ? (cfg.temperature == null ? 0.2 : cfg.temperature) : opts.temperature,
        max_tokens: opts.maxTokens == null ? (cfg.maxTokens == null ? 4096 : cfg.maxTokens) : opts.maxTokens,
        stream: !!opts.onText,
      };
      if (entry && entry.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: entry.name, schema: downgradeSchema(entry.schema), strict: true },
        };
      }

      let raw;
      try {
        raw = await requestWithRetries(body, opts, budgetState, notify);
      } catch (e) {
        throw e;                                   // сеть/отмена — наружу, тут не чиним
      }
      if (opts.onUsage && raw.usage) {
        opts.onUsage({
          calls: 1, ms: raw.ms,
          promptTokens: raw.usage.prompt_tokens || 0,
          completionTokens: raw.usage.completion_tokens || 0,
          promptChars: convo.reduce((s, m) => s + m.content.length, 0),
          completionChars: (raw.text || '').length,
        });
      } else if (opts.onUsage) {
        opts.onUsage({ calls: 1, ms: raw.ms, promptChars: convo.reduce((s, m) => s + m.content.length, 0), completionChars: (raw.text || '').length });
      }

      let data;
      try {
        data = parseModelJson(raw.text);
        if (!data || typeof data !== 'object') throw ERR('schema', 'Модель вернула не объект');
      } catch (e) {
        lastErr = e;
        convo = convo.concat([
          { role: 'assistant', content: cutText(raw.text || '', 2000) },
          { role: 'user', content: 'Ответ не разобрался как JSON. Верни ТОЛЬКО валидный JSON-объект по схеме: без пояснений, без ограждений ```, без <think>.' },
        ]);
        continue;
      }
      // круг 31: глубина и размер — до того, как данные пойдут в обходы brain и в воркер
      const bad = modelDataProblem(data);
      if (bad) throw badResponse(`Ответ модели не той формы (${bad}) — попробуйте ещё раз`);
      return data;
    }
    throw lastErr || ERR('schema', 'Модель не вернула валидный JSON');
  }

  async function requestWithRetries(body, opts, budgetState, notify) {
    let lastErr = null;
    for (let attempt = 0; attempt <= netRetries; attempt++) {
      checkAbort(opts.signal);
      if (budgetState.requests >= maxRequests) {
        throw lastErr || ERR('network', `Модель не ответила за ${maxRequests} попыт(ки/ок) — попробуйте ещё раз или упростите команду`);
      }
      if (now() - budgetState.startedAt > budget) {
        throw lastErr || ERR('network', `Модель не уложилась в ${fmtDuration(budget)} — команда прервана`);
      }
      if (attempt > 0) notify(`Модель не ответила, повтор ${attempt} из ${netRetries}`, { attempt, total: netRetries, reason: 'network' });
      budgetState.requests++;
      const guard = withTimeout(opts.signal, timeout);
      const t0 = now();
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
          signal: guard.signal,
        });
        if (!res.ok) {
          // круг 31: тело отказа — тоже с потолком (нужны первые 300 знаков)
          const text = await readBodyCapped(res, 64 * 1024).catch(() => '');
          if (res.status === 429 || res.status >= 500) throw ERR('network', `Сервер модели ответил ${res.status}`, { retryable: true });
          /* Круг 29 (J5): тело отказа («{"error":…}») — служебное: человеку нейтральные слова,
           * а само тело и статус — полями `status`/`detail` (Orchestrator пишет их в лог). */
          throw ERR('model', MODEL_REJECTED, { status: res.status, detail: cutText(text, 300) });
        }
        // круг 31: сервер, который не умеет поток, отвечает обычным JSON — читаем его как JSON
        const ctype = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
        if (body.stream && !/application\/json/i.test(ctype)) {
          const out = await readSseStream(res, opts.onText, maxBodyBytes);
          return { text: out.text, usage: out.usage, ms: now() - t0 };
        }
        // круг 31: тело — потоком с потолком; не JSON и не той формы — llm_bad_response, не «сеть»
        const json = parseBodyJson(await readBodyCapped(res, maxBodyBytes));
        const text = completionText(json);
        if (opts.onText && text) { try { opts.onText(text, text); } catch { /* ignore */ } }
        const usage = json && json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage) ? json.usage : null;
        return { text, usage, ms: now() - t0 };
      } catch (e) {
        guard.done();
        if (opts.signal && opts.signal.aborted) throw ERR('cancelled', 'Команда отменена');
        if (guard.timedOut) {
          lastErr = ERR('network', `Модель не ответила за ${fmtDuration(timeout)}`);
        } else if (e instanceof BrainError && e.kind === 'model') {
          throw e;                                  // 4xx — повтор не поможет
        } else if (e instanceof BrainError && e.kind === 'cancelled') {
          throw e;
        } else {
          lastErr = e instanceof BrainError ? e : ERR('network', `Нет связи с моделью (${baseUrl}): ${e && e.message ? e.message : e}`);
        }
        if (attempt < netRetries && backoff) await sleep(backoff * Math.pow(2, attempt), opts.signal);
        continue;
      } finally {
        guard.done();
      }
    }
    throw lastErr || ERR('network', 'Нет связи с моделью');
  }

  return {
    name: cfg.name || 'LM Studio',
    kind: 'lmstudio',
    get model() { return model; },
    set model(v) { model = v; },
    ready,
    complete,
  };
}

async function readSseStream(res, onText, maxBytes = MODEL_BODY_MAX_BYTES) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await readBodyCapped(res, maxBytes);
    if (onText && text) { try { onText(text, text); } catch { /* ignore */ } }
    return { text, usage: null };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', usage = null, got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // круг 31: поток — с тем же потолком, что тело целиком
    got += value ? value.byteLength : 0;
    if (got > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw badResponse(`Ответ модели больше ${Math.round(maxBytes / (1024 * 1024) * 10) / 10} МБ — команда не выполнена, попробуйте ещё раз`);
    }
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const chunk = tryParse(payload);
      if (!chunk) continue;
      if (chunk.usage) usage = chunk.usage;
      const c0 = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      // круг 33: кусок не строкой (объект, число) — llm_bad_response, а не «нет JSON» с повтором
      let delta = '';
      try {
        delta = c0 && typeof c0 === 'object' && c0.delta && typeof c0.delta === 'object' ? contentText(c0.delta.content) : '';
      } catch (e) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw e;
      }
      if (delta) {
        text += delta;
        if (onText) { try { onText(text, delta); } catch { /* ignore */ } }
      }
    }
  }
  return { text, usage };
}

function withTimeout(outer, ms) {
  const ctl = new AbortController();
  const state = { signal: ctl.signal, timedOut: false, done: () => {} };
  let timer = null;
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else if (outer.addEventListener) outer.addEventListener('abort', onAbort, { once: true });
  }
  if (ms) timer = setTimeout(() => { state.timedOut = true; ctl.abort(); }, ms);
  state.done = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (outer && outer.removeEventListener) outer.removeEventListener('abort', onAbort);
  };
  return state;
}

/**
 * Пауза между повторами. Круг 5, п.12: слушатель «abort» снимается и при успешном
 * разрешении — иначе на каждую паузу у долгоживущего сигнала оставался мёртвый
 * обработчик с замыканием на таймер (несколько повторов × несколько команд за сессию).
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(ERR('cancelled', 'Команда отменена')); return; }
    const off = () => { if (onAbort && signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort); };
    const t = setTimeout(() => { off(); resolve(); }, ms);
    let onAbort = null;
    if (signal && signal.addEventListener) {
      onAbort = () => { clearTimeout(t); off(); reject(ERR('cancelled', 'Команда отменена')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Промпты (секция «prompts.js» внутри модуля)
 * ──────────────────────────────────────────────────────────────────────────── */

const DSL_RULES = `ПРАВИЛА МОДЕЛИ ДОКУМЕНТА (DSL)
1. Координат НЕТ. Положение задаётся только потоком: layout.mode = "column" (сверху вниз) или "row" (слева направо). Режим "none" — крайний случай, не используй его.
2. Размер каждой оси: число (фиксированные px), "hug" (по содержимому) или "fill" (занять остаток вдоль главной оси / растянуться поперёк). По умолчанию текст — w:"fill", h:"hug".
3. layout = {mode, gap, padding, align, justify, wrap}. padding — число, [v,h] или [t,r,b,l]. align: start|center|end|stretch (поперёк), justify: start|center|end|between (вдоль).
4. Цвета (fill, stroke, color) — ИМЯ ТОКЕНА документа из списка выше или #rrggbb. Выдуманное имя токена будет отброшено. Предпочитай токены; голый #rrggbb — только если нужного токена нет.
5. Типографика текста — style: имя типографического токена ИЗ СПИСКА ВЫШЕ. Не пиши fontSize числом в узле.
6. gap, padding и radius — ССЫЛКОЙ на шаг шкалы документа ("spacing.6", "radii.4", см. раздел ШКАЛЫ), числом — только если нужно значение мимо шкалы.
7. Типы узлов: frame (контейнер, только у него есть children), text, rect, ellipse, image.
8. Глубина дерева ≤ ${MAX_TREE_DEPTH}, детей у узла ≤ ${MAX_CHILDREN}. Не плоди обёртки ради обёрток.
9. Координаты (pos, override) задавать нельзя ни в дереве, ни правкой: место узла считает раскладка,
   а ручные сдвиги пользователя сохраняются сами. Чтобы что-то подвинуть, есть отдельная правка
   op:"nudge" со смещением dx/dy В ПИКСЕЛЯХ от текущего места (dx<0 — влево, dy<0 — вверх).
10. name — короткое осмысленное имя по-русски: «Шапка», «Карточка тарифа», «Кнопка оформить». Имена полей и значения-перечисления — английские, как в схеме.
11. ЧЕГО В ЭТОЙ МОДЕЛИ НЕТ ВООБЩЕ: поворота (rotation, angle), градиента, размытия, ссылки и
    обработчика нажатия (куда ведёт кнопка), видимости (visible, hidden), блокировки, z-порядка, маски,
    автослоёв поверх друг друга, а из анимаций — появления и исчезновения, бесконечных (циклических)
    анимаций, загрузчиков и переходов между экранами. Если просят это — НЕ выдумывай поле и не подменяй
    просьбу похожим («вместо градиента сделаю заливку»): верни cannot с объяснением по-русски, одним-двумя
    предложениями — чего именно в редакторе нет и что вместо этого можно попросить. Отказ — это
    нормальный ответ; выдуманное поле будет отброшено, и человек останется без ответа.
12. ЧТО ЕСТЬ (круг 36): тень слоя (shadow: "shadow.sm" | "shadow.md" | "shadow.lg" | "none"), прозрачность
    (opacity 0…1) и МИКРОАНИМАЦИИ — состояния слоя states.hover / states.press / states.focus (наведение,
    нажатие, фокус: заливка, цвет текста, обводка, прозрачность, масштаб, подъём, тень) и motion — скорость
    и характер перехода между ними. «Оживи кнопки», «добавь микроанимации», «при наведении карточка
    приподнимается» — выполнимые просьбы, на них НЕ отказывают.`;

const CONTENT_RULES = `СОДЕРЖИМОЕ
- Текст, числа, названия, которые дал пользователь, переноси ДОСЛОВНО. Ничего не выдумывай на месте заданного и не «улучшай» формулировки.
- Там, где содержимое не задано, напиши осмысленный русский текст по теме запроса: настоящие заголовки, подписи, суммы, даты, имена разделов.
- «Lorem ipsum», «Текст», «Заголовок», «Описание описание», «...» и прочие заглушки запрещены.
- Не добавляй разделов, о которых не просили, если они не требуются по смыслу задачи.`;

const JSON_RULE = 'Ответ — строго один JSON-объект по схеме. Никаких пояснений до или после, никаких ограждений ```, никаких рассуждений.';

function header(ctx, role) {
  const lines = [`Ты — движок макетов Imago Studio. ${role}`, ''];
  lines.push('ТОКЕНЫ ДОКУМЕНТА');
  lines.push(ctx.tokens);
  lines.push('');
  // Круг 19, п.1 (SPEC §5.9): библиотека — отдельным блоком ПЕРЕД документом. Это словарь
  // сборки, и стоять он обязан раньше макета: сначала «чем собирать», потом «что уже собрано».
  if (ctx.library) {
    lines.push(ctx.library);
    lines.push('');
  }
  lines.push(`ТЕКУЩИЙ ДОКУМЕНТ ЦЕЛИКОМ — все доски. Область работы: ${ctx.scopeLabel}`);
  lines.push(DIGEST_LEGEND);
  // Круг 20 (SPEC §6.6): как читать «gap=spacing.6(16)» — только если шкалы в документе есть
  if (ctx.scales) lines.push(SCALE_LEGEND);
  if (ctx.motion) lines.push(MOTION_LEGEND);
  lines.push(ctx.digest);
  if (ctx.checks) {
    // Круг 3, п.5: валидатор звался только ПОСЛЕ применения, и на «проверь макет, что не так?»
    // модель считала контраст по хексам из выжимки, хотя приложение уже всё посчитало.
    lines.push('');
    lines.push('ЗАМЕЧАНИЯ ПРОВЕРКИ (до правки) — это посчитало приложение, считай их фактами и не пересчитывай сам:');
    lines.push(ctx.checks);
  }
  if (ctx.history) {
    lines.push('');
    lines.push('ПРЕДЫДУЩИЕ КОМАНДЫ (старые сверху) — на них могут ссылаться «а теперь…», «ещё чуть-чуть», «так же во втором экране»');
    lines.push(ctx.history);
  }
  return lines.join('\n');
}

export const PROMPTS = {
  planner(ctx) {
    return [
      header(ctx, 'Твоя роль сейчас — планировщик: коротко решить, что именно делать.'),
      '',
      `ВИДЫ ЗАДАЧ
- create — нужно построить новое САМОСТОЯТЕЛЬНОЕ: экран, доска, крупный блок целиком.
- edit — нужно поправить то, что уже есть. Сюда же относится «добавь X в Y»: если новое надо
  ВЛОЖИТЬ в существующий узел («добавь в список пункт», «добавь в шапку кнопку», «добавь под
  заголовком плашку»), это edit с правкой {op:"create", parent:"<узел из выжимки>"} — так новое
  попадёт именно туда, куда просили, а не в конец экрана.
- theme — нужно поменять оформление документа: цвета, типографику, шкалы (токены). Токены ОБЩИЕ ДЛЯ
  ВСЕГО документа: это меняет разом ВСЕ доски, а не тот, что назван в «РАБОТАЕМ С:». Если просят
  оформление ОДНОГО экрана («сделай только этот экран тёмным»), theme не годится: это либо edit
  (fill и color у узлов этого экрана), либо refuse — реши по существу просьбы.
- ask — у пользователя вопрос о макете, менять ничего не надо.
- clarify — команда не опознаётся как осмысленная правка макета: недослышанная или оборванная фраза
  («ну это самое», «сделай», «а», «короче»), просьба не про макет, или непонятно, к чему её отнести.
  Тогда положи в clarify короткий русский переспрос: чего именно не хватает («Что именно поменять — заголовок, кнопку?»),
  а в clarifyOptions — РОВНО ТРИ готовых ответа. Требования к ним жёсткие, иначе они бесполезны:
  • каждый — ЗАКОНЧЕННАЯ команда, которую можно выполнить как есть («сделай заголовок экрана крупнее»),
    а не обрывок («заголовок») и не вопрос. Человек выберет один и не будет ничего дописывать;
  • имена слоёв бери ИЗ ВЫЖИМКИ документа, дословно. Не выдумывай слоёв, которых в ней нет;
  • три РАЗНЫХ толкования сказанного, а не три оттенка одного: если непонятно, о каком слое речь, —
    три разных слоя; если непонятно, что с ним делать, — три разных правки;
  • до 60 знаков, без кавычек по краям, строчными, как человек сказал бы вслух.
  Лучше переспросить, чем угадать и построить лишнее: команда пришла голосом и могла недослышаться.
- refuse — команда ПОНЯТНА, но в этой модели документа невыполнима: просят поворот, градиент,
  размытие, ссылку, видимость, z-порядок, анимацию появления, бесконечную анимацию, загрузчик или переход
  между экранами — ничего такого у узлов нет. Тогда положи в cannot одно-два русских предложения: чего
  именно в редакторе нет и что можно попросить вместо этого (например, состояния наведения и нажатия).
  Это не clarify (переспрашивать нечего) и не повод угадывать похожую правку.
  ТЕНЬ, СОСТОЯНИЯ (наведение, нажатие, фокус) и МИКРОАНИМАЦИИ между ними В РЕДАКТОРЕ ЕСТЬ — это edit, не refuse.`,
      '',
      `${motionRules('plan')}\n`,
      ctx.comps && ctx.comps.length ? `${componentRules(ctx.comps, 'plan')}\n` : '',
      ctx.scales ? `${scaleRules(ctx.scales, 'plan')}\n` : '',
      `Локальный классификатор предполагает: ${ctx.guess}. Согласись, если он прав, иначе поставь свой intent.`,
      /**
       * Круг 16, п.5: НЕ прошедшее время. Эту строку лента стадий показывает, ПОКА агент
       * работает: человек читал «Увеличил заголовок карточки», когда ничего ещё не изменилось,
       * — агент отчитывался о правке до того, как её сделал. Итоговое сообщение от этого не
       * страдает: главную строку результата оболочка составляет по самим правкам (что и на что
       * поменялось), а заголовок плана идёт рядом и служит названием шага в истории — там
       * название работы читается так же естественно, как отчёт.
       */
      'title — НАЗВАНИЕ РАБОТЫ, до 60 знаков, БЕЗ прошедшего времени: эту строку человек читает,'
      + ' пока правка ещё идёт. Отглагольное существительное или назывная фраза'
      + ' («Крупный заголовок карточки», «Тёмная палитра», «Кнопка оплаты в подвале»).'
      + ' Не пиши «Увеличил…», «Собрал…», «Поставил…»: в этот момент ничего ещё не сделано.',
      'summary — одно предложение о сути изменения.',
      'steps — 1-5 коротких шагов, по делу.',
      'targets — имена или id узлов, которых коснёшься (для create можно оставить пустым).',
      '',
      /**
       * Круг 13, п.8: один план на несколько вариантов. Тогда он обязан назвать ЦЕЛЬ и цели
       * правки, но НЕ фиксировать значения: иначе три варианта сведутся к одному и тому же.
       */
      ctx.variantsAhead
        ? `ЭТОТ ПЛАН — ОБЩИЙ ДЛЯ ${ctx.variantsAhead} РАЗНЫХ ВАРИАНТОВ ОДНОЙ КОМАНДЫ.\n`
          + 'Назови, ЧТО делать и каких узлов это касается, но НЕ называй конкретных значений'
          + ' (чисел, токенов, цветов): их выберет каждый вариант по-своему. steps — про действия,'
          + ' а не про числа.'
        : '',
      // характер варианта нужен и планировщику, иначе у всех вариантов выходит один и тот же план (п.12)
      ctx.personaHint ? `ХАРАКТЕР — ТВОЙ И ТОЛЬКО ТВОЙ\n${ctx.personaHint}` : '',
      ctx.variantHint ? ctx.variantHint : '',
      ctx.personaHint || ctx.variantHint ? 'План должен отражать этот характер: решай задачу по-своему, а не повторяй соседний вариант.\n' : '',
      JSON_RULE,
    ].filter(Boolean).join('\n');
  },

  tree(ctx) {
    return [
      header(ctx, 'Твоя роль сейчас — генератор макета: вернуть дерево узлов.'),
      '',
      DSL_RULES,
      '',
      ctx.scales ? `${scaleRules(ctx.scales, 'tree')}\n` : '',
      ctx.comps && ctx.comps.length ? `${componentRules(ctx.comps, 'tree')}\n` : '',
      CONTENT_RULES,
      '',
      `${motionRules('tree')}\n`,
      ctx.personaHint ? `ХАРАКТЕР — ТВОЙ И ТОЛЬКО ТВОЙ\n${ctx.personaHint}\n` : '',
      ctx.variantHint ? `${ctx.variantHint}\n` : '',
      `КУДА ВСТАВЛЯЕМ\n${ctx.placement}`,
      'Выжимка выше — весь документ. Держи единый язык с уже существующими экранами: те же токены,'
      + ' те же шкалы отступов и радиусов, похожие имена слоёв. Не копируй чужой экран целиком, если об этом не просили.',
      '',
      'Корень ответа — один узел (обычно frame). Верни ВСЁ поддерево целиком.',
      JSON_RULE,
    ].filter(Boolean).join('\n');
  },

  patch(ctx) {
    return [
      header(ctx, 'Твоя роль сейчас — редактор: вернуть минимальный список точечных правок.'),
      '',
      DSL_RULES,
      '',
      ctx.scales ? `${scaleRules(ctx.scales, 'patch')}\n` : '',
      CONTENT_RULES,
      '',
      ctx.personaHint ? `ХАРАКТЕР — ТВОЙ И ТОЛЬКО ТВОЙ\n${ctx.personaHint}\n` : '',
      ctx.variantHint ? `${ctx.variantHint}\n` : '',
      // Круг 5, п.10: «куда класть» считает приложение (describePlacement) и на него же
      // опирается материализация, когда модель не назвала parent, — а модель этого не видела.
      ctx.placement ? `КУДА КЛАДЁМ НОВОЕ, ЕСЛИ ПРАВКА ЕГО СОЗДАЁТ (это посчитало приложение)\n${ctx.placement}\n` : '',
      ctx.comps && ctx.comps.length ? `${componentRules(ctx.comps, 'patch')}\n` : '',
      `ПРАВИЛА ПРАВОК
- Меняй только то, о чём просят. Ничего не переписывай «заодно».
- Правь ТОЛЬКО область работы (строка «РАБОТАЕМ С:» в выжимке). Остальные доски — источник образцов:
  по ним сверяй оформление и с них копируй («как в сводке недели», «повтори шапку со второго экрана»,
  «по ширине таблицы» — ширину бери из посчитанного «→ 896×128» нужного узла), но сами их не меняй,
  пока не попросили. Если просят «во всех экранах» — сделай отдельную правку на каждую доску.
- target — id из выжимки выше (вида #f3), точное имя слоя или "selection" (ВСЕ выделенные узлы: правка повторится для каждого).
- Цель ищется сначала внутри выделенной области, потом по всему документу. Имя из выжимки надёжнее описания.
- path — ТОЛЬКО эти корни: characters, style, align, color, fill, stroke, radius, size.w, size.h,
  layout.mode, layout.gap, layout.padding, layout.align, layout.justify, layout.wrap, name, opacity, src, clip,
  shadow, states (states.hover / states.press / states.focus и их поля), motion (motion.duration, motion.easing,
  motion.delay, motion.follow).
  Ничего другого не существует: visible, locked, hidden, onclick, z, rotation, pos и подобное будет отброшено.
- СНЯТЬ свойство («убери фон», «без заливки», «сними обводку», «убери скругление», «сделай
  непрозрачным») — это value:"none": {op:"set", target:"Карточка", path:"fill", value:"none"}.
  Так же понимаются "", "нет", "прозрачный", "убрать" и правка вовсе без поля value. Снимаются:
  fill, stroke, color, radius, opacity, src, clip, style, align, layout (и layout.*), override
  (override снять — значит вернуть узел в поток раскладки после ручного перетаскивания), states (и
  states.*), motion (и motion.*), shadow. Исключение: у тени value:"none" — это «без тени» (в состоянии
  наведения — убрать тень покоя), а снять тень — правка без value.
  НЕ снимаются characters, name и size: у текста всегда есть содержимое, у узла всегда есть
  размер. «Убери текст» — это characters:"" (пустая строка) или удаление самого слоя;
  «убери ширину» — это size.w "hug" (по содержимому) или "fill" (во всю ширину).
- У КАЖДОГО поля свой тип узла, и путь не по типу цели — потерянная правка:
  characters, style, align, color — ТОЛЬКО у type:"text";
  fill, stroke, radius — только у frame, rect, ellipse, image; layout.* и clip — только у frame.
  Кнопка здесь — это ФРЕЙМ с текстовым слоем внутри: «сделать надпись жирнее/крупнее/другой» —
  это правка ТЕКСТА внутри кнопки (в выжимке он вложен строкой ниже), а не самой кнопки.
  Фрейму меняют fill, radius, размеры и layout; тексту — characters, style, color, align.
- Сдвинуть узел: {op:"nudge", target:"Аватар", dx:-10, dy:0} — смещение в ПИКСЕЛЯХ от текущего
  места: dx<0 влево, dx>0 вправо, dy<0 вверх, dy>0 вниз. Абсолютные координаты из выжимки
  («@330,30») присваивать нельзя — их считает раскладка.
- Нельзя менять id, type, parent, children — для перемещения есть op:"move", для добавления op:"create".
- value всегда СТРОКА: "24", "fill", "hug", "#101418", "accent", "Купить за 1 490 ₽".
- Цвет: имя токена документа, #rrggbb или обиходное название («зелёный», «тёмно-синий», "green").
- Для op:"create" положи поддерево в node и ОБЯЗАТЕЛЬНО укажи parent — узел, ВНУТРЬ которого кладём
  (id или имя слоя из выжимки), и index, если важен порядок. «Добавь в список пункт на 20:00» —
  это parent:"Список пунктов"; «добавь под заголовком плашку» — parent того же уровня, что заголовок,
  и index сразу после него. Без parent новое ляжет в область работы целиком, и человек найдёт его не там.
- Если создаёшь узел с ИМЕНЕМ, которое в документе уже занято, дай ему другое имя: remove и
  move ищут существующий узел, а не только что созданный, и «создал кнопку с тем же именем,
  удали кнопку» удалит СТАРУЮ. Ссылаться вперёд на новый узел (parent у create и move) можно.
- В ОДНОМ патче можно создать контейнер и тут же перенести в него существующие узлы:
  сначала {op:"create", node:{type:"frame", name:"Карточка"}, parent:"selection"},
  затем {op:"move", target:"selection", parent:"Карточка", index:0} — ссылаться на новый узел можно по его name.
- Чтобы размножить существующее, НЕ пересказывай его поддерево: {op:"duplicate", target:"Карточка встречи"}
  (можно указать parent и index) — копия делается движком со всем оформлением.
- Размеры из выжимки («→ 350×52») — посчитанные. «На 20 пикселей шире» = size.w в "370", а не "+20".
- Если просят то, чего в модели документа НЕТ (поворот, градиент, размытие, ссылка, видимость,
  z-порядок, анимация появления, бесконечная анимация, переход между экранами), не выдумывай поле и не
  подменяй просьбу похожим: верни {cannot: "<почему>"} с пустым edits. Одно-два предложения по-русски:
  чего в редакторе нет и что можно попросить вместо. Тень, состояния и микроанимации — ЕСТЬ (ниже).
  Частично выполнимую просьбу делай наполовину: выполнимые правки — в edits, невыполнимую часть — в cannot.`,
      '',
      motionRules('patch'),
      '',
      JSON_RULE,
    ].filter(Boolean).join('\n');
  },

  theme(ctx) {
    return [
      header(ctx, 'Твоя роль сейчас — тематизатор: поменять токены документа, не трогая структуру.'),
      '',
      `ПРАВИЛА ОФОРМЛЕНИЯ
- ТОКЕНЫ ОБЩИЕ ДЛЯ ВСЕГО ДОКУМЕНТА. Они не принадлежат доске: поменяв colors.bg, ты перекрасишь
  ВСЕ экраны сразу, включая те, что в строке «РАБОТАЕМ С:» не названы. Отдельная доска оформлением
  не перекрасить — этого в модели документа нет.
- Поэтому «сделай ТОЛЬКО этот экран тёмным», «перекрась вот эту карточку, остальное не трогай» — это
  НЕ задача тематизатора. Верни {cannot: "<почему, по-русски>"}: скажи, что оформление документа общее
  и так перекрасятся все доски, и предложи, что можно вместо — поменять fill и color у узлов
  нужного экрана (это обычная правка) или перекрасить весь документ.
- Меняй только токены. Структуру, тексты и размеры узлов не трогай.
- Цвета — строго #rrggbb. Сохраняй имена существующих токенов; новые заводи только если без них никак.
- Держи контраст: текст на фоне не меньше 4.5:1, подписи (muted) — не меньше 3:1.
- Типографика — единая шкала: соседние размеры отличаются заметно.
- fontSize и lineHeight — в пикселях, ровно как в выжимке токенов выше (body 15/400/22 —
  это кегль 15 px, насыщенность 400, интерлиньяж 22 px). Интерлиньяж держи примерно в
  1.2-1.6 кегля и пиши числом пикселей, а не множителем.
- spacing и radii — возрастающие ряды; не ломай существующий ритм без нужды.
- motion — ступени скорости анимаций в мс (fast < base < slow; микроанимации — до 600 мс):
  «сделай все анимации медленнее» в оформлении — увеличь все три ступени. shadow — ступени тени sm < md < lg
  (значение — «сдвиг-x сдвиг-y размытие цвет», например "0 4px 12px rgba(16,20,24,.12)").`,
      ctx.scales ? `\n${scaleRules(ctx.scales, 'theme')}` : '',
      '',
      JSON_RULE,
    ].join('\n');
  },

  answer(ctx) {
    return [
      header(ctx, 'Твоя роль сейчас — собеседник: ответить на вопрос о макете, ничего не меняя.'),
      '',
      `ПРАВИЛА ОТВЕТА
- Отвечай по выжимке документа выше, не домысливай того, чего в ней нет.
- Если данных не хватает — так и скажи и укажи, что выделить.
- Коротко, по-русски, без markdown-разметки. 1-6 предложений.
- Не предлагай операций — это ответ, а не правка.`,
      '',
      JSON_RULE,
    ].join('\n');
  },

  /** Обратная связь для единственной попытки починки. */
  repair(problems, previous, entry) {
    return [
      'Предыдущий ответ применить не удалось. Нарушения:',
      problems.map((p, i) => `${i + 1}. ${p}`).join('\n'),
      '',
      'Исправь ИМЕННО эти нарушения и верни полный JSON по той же схеме заново. Не меняй то, что было верно.',
      // круг 9, п.4: если поле было выдумано, вторая попытка должна уметь сказать «нельзя»,
      // а не выдумывать второе такое же — иначе человек получает аварию вместо ответа
      'Если просимого в модели документа нет вообще (поворот, градиент, размытие, ссылка, видимость,'
      + ' z-порядок, анимация появления, бесконечная анимация, переход между экранами), не подбирай другое поле:'
      + ' верни {cannot: "<почему, по-русски>"} с пустым edits. Тень, состояния (states.hover/press/focus) и'
      + ' движение (motion) в модели ЕСТЬ — для микроанимаций используй их, а не отказ.',
      entry && entry.hint ? `Схема "${entry.name}":\n${entry.hint}` : '',
      JSON_RULE,
    ].filter(Boolean).join('\n');
  },
};

/**
 * Характеры вариантов (п.12). Оси вариации — не только плотность:
 *   композиция (в колонку / в строку / сеткой), типографика (крупный заголовок / ровный ритм),
 *   выразительность (сдержанно / акцентно). У каждого свой hint для генерации дерева,
 *   свой patchHint для точечных правок и своя температура, иначе три варианта совпадают побайтово.
 */
export const PERSONAS = [
  {
    key: 'strict',
    label: 'Строгий',
    description: 'Выверенная сетка, ровный ритм, минимум украшений.',
    axes: { composition: 'колонка', typography: 'ровный ритм', expression: 'сдержанно' },
    hint: [
      'Строгий. Композиция: одна колонка, строгая вертикаль, никаких вложенных обёрток ради вида.',
      'Типографика: ровный ритм, соседние уровни отличаются на один шаг шкалы, заголовок не крупнее необходимого.',
      'Выразительность: сдержанно — один акцентный цвет на весь блок, радиусы малые, разделители тонкие.',
      'Отступы из середины шкалы.',
    ].join('\n'),
    patchHint: [
      'Строгий: правь ровно то, о чём просят, выбирай значения из шкал документа, держи одинаковые отступы у соседей.',
      'Предпочитай выравнивание и ритм ярким приёмам; акцентный цвет не добавляй без просьбы.',
    ].join('\n'),
    temperature: 0.15,
    defaults: { gap: 16, padding: 24, radius: 8 },
  },
  {
    key: 'airy',
    label: 'Просторный',
    description: 'Много воздуха, крупный заголовок, спокойный ритм.',
    axes: { composition: 'колонка с крупным заголовком', typography: 'крупный заголовок', expression: 'мягко' },
    hint: [
      'Просторный. Композиция: колонка, крупный вводный блок сверху, содержимое сгруппировано в 2-3 смысловые части.',
      'Типографика: заголовок берёт верхний токен шкалы и заметно крупнее остального, подписи — приглушённым цветом.',
      'Выразительность: мягко — большие радиусы, широкие поля, воздух между блоками вместо линий-разделителей.',
      'Отступы и gap из верхней части шкалы.',
    ].join('\n'),
    patchHint: [
      'Просторный: где просят «крупнее/просторнее» — бери верхний токен шкалы, добавляй воздух (gap, padding) вокруг правки.',
      'Смягчай: радиусы больше, границы заменяй фоном и отступом.',
    ].join('\n'),
    temperature: 0.6,
    defaults: { gap: 24, padding: 40, radius: 16 },
  },
  {
    key: 'dense',
    label: 'Плотный',
    description: 'Компактно и акцентно: больше содержимого на экране.',
    axes: { composition: 'строка/сетка', typography: 'компактно', expression: 'акцентно' },
    hint: [
      'Плотный. Композиция: где уместно — строка (layout.mode "row") или сетка из строк по 2-3 элемента, wrap разрешён.',
      'Типографика: компактные строки, разница между уровнями небольшая, вместо крупного заголовка — плотная шапка.',
      'Выразительность: акцентно — заливки и контрастные плашки вместо воздуха, акцентный цвет работает как разделитель.',
      'Отступы из нижней части шкалы, радиусы минимальные.',
    ].join('\n'),
    patchHint: [
      'Плотный: ужимай — gap и padding из нижней части шкалы, где можно, разворачивай колонку в строку (layout.mode "row").',
      'Акцент ставь заливкой и контрастом, а не размером.',
    ].join('\n'),
    temperature: 1,
    defaults: { gap: 8, padding: 12, radius: 4 },
  },
];

/**
 * Инструкция «сделай иначе, чем соседние варианты».
 *
 * Круг 7, п.9: раньше сюда попадали МЕТКИ характеров предыдущих вариантов («Просторный: …»)
 * и ложились рядом с собственной строкой промпта «ХАРАКТЕР ЭТОГО ВАРИАНТА / Плотный …» — на этом
 * спотыкался и критик, и живая модель: непонятно, чей характер задание. Теперь формулировки
 * разведены: свой характер называется «ТВОЙ ХАРАКТЕР», чужие решения перечисляются БЕЗ меток
 * характеров и прямо помечены как не-задание.
 */
export function variantInstruction(persona, index, count, previous = [], others = []) {
  const lines = [`ТВОЙ ВАРИАНТ — ${index}-Й ИЗ ${count}. Твои оси: композиция — ${persona.axes.composition};`
    + ` типографика — ${persona.axes.typography}; выразительность — ${persona.axes.expression}.`];
  /**
   * Круг 13, п.8: оси СОСЕДЕЙ известны заранее — они заданы списком PERSONAS, а не добыты
   * прошлыми вызовами модели. Раньше «сделай иначе, чем предыдущие» заставляло считать варианты
   * СТРОГО последовательно (три варианта = шесть вызовов подряд, на LM Studio это минуты).
   * Разведённые заранее оси дают то же различие без всякого ожидания.
   */
  if (others.length) {
    lines.push('ОСИ СОСЕДНИХ ВАРИАНТОВ (их считают отдельно; это не твоё задание — не повторяй их):');
    others.forEach((o) => lines.push(`  вариант ${o.index}: композиция — ${o.axes.composition};`
      + ` типографика — ${o.axes.typography}; выразительность — ${o.axes.expression}`));
    lines.push('Держись СВОИХ осей: человек увидит все варианты рядом, и одинаковые ему не нужны.');
  }
  if (previous.length) {
    lines.push('ЧТО УЖЕ ПОКАЗАНО ЧЕЛОВЕКУ В СОСЕДНИХ ВАРИАНТАХ (это чужие решения, а не твоё задание):');
    previous.forEach((p, i) => lines.push(`  вариант ${i + 1} уже решил так — ${p}`));
    lines.push('Сделай ИНАЧЕ: другое решение по композиции или по типографике, а не те же значения с другим отступом.');
    lines.push('Своё задание бери только из раздела «ХАРАКТЕР» и из команды человека.');
  }
  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. Классификация
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ВАЖНО: \b в JS определена через \w = [A-Za-z0-9_], поэтому перед кириллицей она
 * не работает (/\bсоздай/ не совпадает с «создай ...»). Границы слова строим сами
 * через \p{L}\p{N} с флагом u.
 */
const WB = '(?:^|[^\\p{L}\\p{N}])';
const WE = '(?![\\p{L}\\p{N}])';
const rx = (src, whole) => new RegExp(WB + '(?:' + src + ')' + (whole ? WE : ''), 'iu');

const RE = {
  ask: [
    /^\s*(что|чем|как|какая|какие|какой|каков|почему|зачем|где|сколько|когда|кто|объясни|расскажи|опиши|перечисли|проверь|посмотри|есть ли|можно ли|стоит ли)(?![\p{L}\p{N}])/iu,
    /\?\s*$/,
  ],
  theme: [
    rx('т[её]мн\\p{L}*\\s+тем'), rx('светл\\p{L}*\\s+тем'), rx('тем[ау]', true),
    rx('палитр'), rx('цветов\\p{L}*\\s+схем'), rx('токен'), rx('бренд'),
    rx('оформлени'), rx('стилистик'), rx('контраст'), rx('шрифт'), rx('типографик'),
    // круг 20 (SPEC §6): «сделай шкалу отступов просторнее» — правка ТОКЕНОВ, а не узла
    rx('шкал\\p{L}*\\s+(отступ|скруглен|радиус)'),
    // круг 36 (SPEC §11): «сделай шкалу движения медленнее» — ступени motion.* в токенах
    rx('шкал\\p{L}*\\s+(движени|скорост|анимаци|тен)'),
  ],
  create: [
    rx('созда(й|ть|йте)'), rx('св[её]рстай'), rx('собери'), rx('построй'),
    rx('нарисуй'), rx('сгенерируй'), rx('придумай'), rx('напиши\\s+(экран|страниц|лендинг)'),
    rx('нов(ый|ую|ое|ая)\\s+(экран|артборд|доск|макет|страниц|блок|секци|карточк|компонент)'),
    rx('свёрстать|сверстать'),
  ],
  edit: [
    rx('измени'), rx('поправ'), rx('исправ'), rx('замени'), rx('поменя'), rx('перенеси'),
    rx('увелич'), rx('уменьш'), rx('растян'), rx('сожм'), rx('удали'), rx('убер[иё]'),
    rx('переимен'), rx('выровня'), rx('сдвин'), rx('передвин'), rx('перекрас'),
    // круг 9, п.6: «покрась статусы серым» глаголом не считалось, и причина классификации
    // выходила неправдой («глаголов нет, но назван слой…») — при живом глаголе в реплике
    rx('покрас'), rx('закрас'), rx('раскрас'), rx('затемн'), rx('осветл'),
    rx('дублир'), rx('продублир'), rx('скопир'), rx('копи[юя]', true), rx('оберн'), rx('сгруппир'),
    rx('сделай\\s+\\S+\\s+(крупнее|больше|меньше|мельче|шире|уже|выше|ниже|жирнее|тоньше|светлее|темнее|плотнее|просторнее|воздушнее|компактнее)'),
    /* Круг 5, п.9: сравнительная степень сама по себе — всегда правка. «Сделай подписи мельче»,
     * «поуже», «воздушнее» раньше не попадали в словарь и без выделения классифицировались как
     * create: выручал только план модели, а на локальной модели — не всегда. Приставка «по-»
     * («покрупнее», «потоньше») берётся тем же выражением. «уже», «выше», «ниже» в голом виде
     * СОЗНАТЕЛЬНО не берём: это ещё и наречия места и времени («уже сделал», «выше заголовка»). */
    rx('(по)?(крупнее|больше|меньше|мельче|шире|жирнее|тоньше|плотнее|просторнее|воздушнее|компактнее|светлее|темнее|прозрачнее)', true),
    rx('(поуже|пониже|повыше|потуже)', true),
    rx('в\\s+(одну|две|три)\\s+(колонк|строк)'),
  ],
};

/**
 * Круг 3, п.3: «добавь» больше не значит безусловный create. «Добавь в список пункт» —
 * это вложение в существующий узел, то есть правка (edit с op:"create" и parent),
 * а create остаётся за самостоятельным новым: экраном, артбордом, отдельным блоком.
 */
const RE_ADD = [rx('добав(ь|ить|ьте|им|ляй)', true), rx('вставь|вставить|вставьте', true), rx('(положи|помести|впиши|допиши|воткни)', true)];
/** Место вставки названо словами — значит, кладём внутрь уже существующего. */
const RE_ADD_PLACE = rx('(в|во|внутрь|внутри|под|над|после|перед|рядом|возле|около|сверху|снизу|вниз|наверх|слева|справа|между|в\\s+начал|в\\s+конец)');

const anyMatch = (list, s) => list.some((r) => r.test(s));

/**
 * Слова-пустышки и глаголы, которые без дополнения ничего не значат.
 * Нужны, чтобы недослышанная голосом фраза («ну это самое», «сделай») ушла в clarify,
 * а не материализовалась новым артбордом (п.11).
 */
const FILLER_WORDS = new Set([
  'ну', 'это', 'эт', 'самое', 'вот', 'так', 'там', 'тут', 'как', 'бы', 'типа', 'короче', 'значит',
  'да', 'нет', 'ага', 'угу', 'эээ', 'ээ', 'ммм', 'мм', 'хм', 'ой', 'слушай', 'смотри', 'эй',
  'пожалуйста', 'плиз', 'давай', 'давайте', 'мне', 'мы', 'я', 'ты', 'же', 'ка', 'бля', 'блин',
]);

const BARE_VERBS = new Set([
  'сделай', 'сделайте', 'поменяй', 'измени', 'исправь', 'поправь', 'добавь', 'создай', 'убери',
  'удали', 'замени', 'поставь', 'подправь', 'переделай', 'сделать', 'добавить', 'убрать', 'изменить',
]);

/** Есть ли в реплике хоть одно слово: «», «   », «...», «???» словами не считаются. */
export function hasWords(utterance) {
  return /[\p{L}\p{N}]/u.test(String(utterance == null ? '' : utterance));
}

/** Есть ли в реплике хоть что-то, к чему можно отнести правку макета. */
export function looksMeaningless(utterance) {
  const s = String(utterance == null ? '' : utterance).trim();
  if (!s) return true;
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return true;
  const meaningful = words.filter((w) => !FILLER_WORDS.has(w) && !BARE_VERBS.has(w) && w.length >= 3);
  return meaningful.length === 0;
}

/* — Действия оболочки: отмена и возврат без обращения к модели — */

/** Мусор на краях реплики, который не меняет смысла: «отмени, пожалуйста» = «отмени». */
const ACTION_EDGE_NOISE = new Set([
  'ну', 'а', 'э', 'эй', 'слушай', 'смотри', 'пожалуйста', 'плиз', 'давай', 'давайте', 'ка', 'же',
  'это', 'эт', 'всё', 'все', 'там', 'тут', 'вот', 'так', 'быстро', 'срочно', 'нет', 'блин',
]);

/**
 * Отмена: только явные формулировки целиком. «Поменяй обратно цвет» здесь НЕ ловится и уходит
 * в модель — это правка, а не откат.
 */
const UNDO_PHRASES = new Set([
  'отмени', 'отмена', 'отменить', 'отмени последнее', 'отмени последнюю правку', 'отмени правку',
  'отмени изменения', 'отмени последнее изменение', 'отмени последние изменения', 'отмени что сделал',
  'откати', 'откатить', 'откат', 'откати назад', 'откати последнее', 'откати правку', 'откатись',
  'назад', 'шаг назад', 'на шаг назад', 'вернись назад', 'верни назад',
  'верни как было', 'верни как раньше', 'верни как до этого',
  'сделай как было', 'сделай как раньше', 'пусть будет как было', 'как было', 'как было раньше',
  'не так', 'не то', 'не туда', 'не это', 'не надо', 'не нужно было',
  'undo', 'ctrl z', 'ctrl+z', 'отмени это действие',
]);

/**
 * Возврат отменённого. «Вернуть» — то же слово, что на кнопке отмены в интерфейсе.
 * Круг 24: «верни обратно» — тоже ПОВТОР, как в оболочке (app.js shellIntent, RE_REDO_BARE):
 * после отмены оболочка сама предлагает кнопку «Вернуть обратно», и эти же слова голосом
 * обязаны делать то же, что кнопка. Раньше brain читал их как отмену, а оболочка — как
 * повтор: одна реплика давала разное в браузере и на сервере агента (JEV).
 * «Верни назад» и «верни как было» остаются отменой.
 */
const REDO_PHRASES = new Set([
  'вернуть', 'верни обратно', 'верни отмененное', 'верни отменённое', 'верни отмену', 'отмени отмену',
  'повтори отмененное', 'повтори отменённое', 'повтори отмену', 'повтори правку', 'повтори последнюю правку',
  'сделай снова', 'сделай заново', 'верни правку', 'верни то что отменил', 'верни что отменил',
  'вперед', 'вперёд', 'шаг вперед', 'шаг вперёд', 'redo', 'ctrl shift z', 'ctrl+shift+z',
]);

/**
 * Явная отмена одной формулой: глагол отката, необязательное «последнюю/предыдущую» и
 * необязательное существительное правки. «Отмени скидку в подписи» сюда НЕ попадает.
 */
const RE_UNDO_CMD = /^(отмени|отменить|отмена|откати|откатить|откатись|откат)(\s+(последн|предыдущ|прошл)\p{L}*)?(\s+(правк\p{L}*|изменени\p{L}*|действие|шаг|команд\p{L}*|операци\p{L}*|это))?$/u;

/**
 * Круг 11, п.6: «убери последнюю правку», «сотри изменения», «удали то что сделал» — та же
 * отмена живыми словами. Существительное здесь ОБЯЗАТЕЛЬНО: именно оно отделяет откат от
 * удаления слоя. «Убери последнее» под это выражение не подходит и уходит в переспрос ниже.
 */
const RE_UNDO_ERASE = /^(убери|убрать|сотри|стереть|удали|удалить)(\s+(последн|предыдущ|прошл)\p{L}*)?\s+(правк\p{L}*|изменени\p{L}*|(то\s+)?что\s+(ты\s+)?(сделал|наделал|напортил)\p{L}*)$/u;

/**
 * Круг 11, п.6: двусмысленная отмена. «Убери последнее», «сотри последнее» — это ровно
 * пополам «отмени последнюю правку» и «удали последний элемент списка». Угадать нельзя ни в
 * одну сторону: молчаливый откат выбрасывает работу человека, молчаливое удаление сносит слой.
 * Модели это тоже не поручишь — отката у неё нет вовсе, она может только удалить узел, то есть
 * гарантированно выберет одно из двух толкований. Поэтому — честный переспрос одной строкой.
 */
const RE_UNDO_DOUBT = /^(убери|убрать|сотри|стереть|удали|удалить)\s+(последн(ее|юю|ий|ее)|предыдущ(ее|ую|ий)|прошл(ое|ую|ый))$/u;

/**
 * Переспрос для двусмысленной отмены — или null, если реплика однозначна.
 * @returns {string|null} русский вопрос для человека
 */
export function recognizeUndoDoubt(utterance) {
  if (recognizeAction(utterance)) return null;
  for (const core of actionCores(utterance)) {
    if (core && core.length <= 40 && RE_UNDO_DOUBT.test(core)) {
      return 'Не понял: отменить последнюю правку или удалить последний элемент?'
        + ' Скажите «отмени» — откачу правку, или назовите, что именно удалить.';
    }
  }
  return null;
}

/**
 * Реплика → варианты её «ядра»: как сказано и без вежливости/затычек по краям.
 * Обе формы важны: «отмени, пожалуйста» надо очистить, а «не так» очисткой ломается
 * («так» — слово-затычка), поэтому сверяем и исходную форму тоже.
 */
function actionCores(utterance) {
  const flat = String(utterance == null ? '' : utterance)
    .toLowerCase().replace(/ё/g, 'е')
    .replace(/[.,!?;:…"«»()\[\]\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = flat.split(' ').filter(Boolean);
  if (!words.length) return [];
  // сколько затычек можно снять с каждого края: «всё не так» → снимать «всё» надо, «так» нельзя,
  // поэтому проверяем ВСЕ комбинации обрезки, а не одну
  let lead = 0;
  while (lead < words.length - 1 && ACTION_EDGE_NOISE.has(words[lead])) lead++;
  let trail = 0;
  while (trail < words.length - 1 - lead && ACTION_EDGE_NOISE.has(words[words.length - 1 - trail])) trail++;
  const out = [];
  for (let i = 0; i <= lead; i++) {
    for (let j = 0; j <= trail; j++) {
      const core = words.slice(i, words.length - j).join(' ');
      if (core && !out.includes(core)) out.push(core);
    }
  }
  return out;
}

/**
 * Локально распознанное намерение, которое выполняет ОБОЛОЧКА, а не модель (круг 3, новое в контракте).
 * «Отмени», «верни как было», «назад», «не так» должны откатывать последнюю транзакцию мгновенно:
 * промпт раньше прямо обещал модели, что «верни как было» поддержано, механизма не было, и модель
 * начинала угадывать и правила наугад.
 *
 * Сознательно консервативно: сверяется ЦЕЛАЯ реплика по закрытому списку. «Поменяй обратно цвет»,
 * «верни заголовок на место», «отмени скидку в тексте» здесь не ловятся и уходят в планировщик.
 * @returns {'undo'|'redo'|null}
 */
export function recognizeAction(utterance) {
  for (const core of actionCores(utterance)) {
    if (!core || core.length > 40) continue;
    if (REDO_PHRASES.has(core)) return 'redo';
    if (UNDO_PHRASES.has(core) || RE_UNDO_CMD.test(core) || RE_UNDO_ERASE.test(core)) return 'undo';
  }
  return null;
}

/* — Третье локальное действие оболочки: варианты (круг 5, п.3) — */

/** Числительные, которые встречаются перед словом «вариант»: «три варианта», «2 варианта». */
const V_NUM = '(?:\\d{1,2}|дв(?:а|е)|три|четыре|пять|несколько|пару)';
/** Вежливая голова просьбы. «Добавь», «напиши», «поменяй» сюда НЕ входят — это содержательные команды. */
const V_ASK = '(?:покажи(?:те)?|показать|дай(?:те)?|давай(?:те)?|предложи(?:те)?|сделай(?:те)?|попробуй(?:те)?|хочу|можно|нужн[оы]|надо)';
/** «Ещё», «другие», «иные» — слова, которые просят повторить с иным исходом. */
const V_MORE = '(?:ещ[ёе]|друг(?:ой|ие|их)|ин(?:ой|ые|ых)|разны[ех]|альтернативн\\p{L}*)';
/**
 * Круг 15, п.1: «альтернативы» — то же слово, что «варианты», и живая речь выбирает его
 * наравне. Отдельным словарём оно не нужно: падежи те же, а прилагательное
 * «альтернативный» уже живёт в V_MORE и с существительным не путается (после «альтернатив»
 * там обязательна «н»).
 */
const V_WORD = '(?:вариант(?:ы|а|ов|е)?|альтернатив(?:ы|а|ов|е|у|ам|ами|ой)?)';
/**
 * Хвост, который ничего не добавляет: «варианты этого же», «варианты тут».
 * Круг 7, п.10: сюда же вежливые хвосты — «покажи пару вариантов, пожалуйста».
 */
const V_TAIL = '(?:[\\s,]+(?:этого|это|того|же|тут|здесь|сюда|макета|экрана|правки|команды|этой|той'
  + '|пожалуйста|плиз|можно|давай|давайте|посмотреть|глянуть|на\\s+выбор))*';
const V_HEAD = `^\\s*(?:[аи]\\s+|ну\\s+)?(?:${V_ASK}\\s+)?(?:мне\\s+)?(?:${V_MORE}\\s+)?(?:${V_NUM}\\s+)?(?:${V_MORE}\\s+)?${V_WORD}`;
/**
 * Круг 11, п.7: то же слово другими словами — «покажи другие решения», «дай ещё версии».
 * Эти слова многозначнее «варианта», поэтому берутся ТОЛЬКО с числом или со словом
 * «другие/ещё/иные»: «покажи решения» само по себе — не просьба о версиях правки.
 */
const V_WORD_ALT = '(?:решени(?:я|е|й|ем|ями)|верси(?:и|я|й|ю|ями)|иде(?:и|я|й|ями|ю)|подход(?:ы|а|ов))';
const V_QUALIFIED = `(?:(?:${V_MORE})\\s+(?:${V_NUM}\\s+)?|(?:${V_NUM})\\s+(?:${V_MORE}\\s+)?)`;
const V_HEAD_ALT = `^\\s*(?:[аи]\\s+|ну\\s+)?(?:${V_ASK}\\s+)?(?:мне\\s+)?${V_QUALIFIED}${V_WORD_ALT}`;
/** Вся реплика — просьба о вариантах: «покажи три варианта», «ещё варианты». */
const RE_VARIANTS_WHOLE = new RegExp(V_HEAD + V_TAIL + '\\s*[.!?…]*\\s*$', 'iu');
/** …и то же самое синонимами: «покажи другие решения», «дай ещё версии». */
const RE_VARIANTS_WHOLE_ALT = new RegExp(V_HEAD_ALT + V_TAIL + '\\s*[.!?…]*\\s*$', 'iu');
/** Просьба о вариантах и следом команда: «три варианта: сделай шапку компактнее». */
const RE_VARIANTS_LEAD = new RegExp(V_HEAD + '\\s*(?:[:,—–-]+\\s*)?(.+)$', 'iu');
/**
 * Круг 11, п.1: голова просьбы, которая ОДНОЗНАЧНО читается как просьба, — с числом
 * («три варианта»), со словом «другие/ещё», с вежливым глаголом («покажи вариант») или во
 * множественном числе («варианты: …»). Голого «вариант» мало: «вариант с подпиской — основной»
 * просьбой не является.
 */
const V_WORD_MANY = '(?:вариант(?:ы|ов)|альтернатив(?:ы|ов|ам|ами))';
const V_HEAD_LEAD = `^\\s*(?:[аи]\\s+|ну\\s+)?(?:`
  + `(?:${V_ASK}\\s+)?(?:мне\\s+)?(?:${V_MORE}\\s+)?(?:${V_NUM}\\s+)?(?:${V_MORE}\\s+)?${V_WORD_MANY}`
  + `|(?:${V_ASK})\\s+(?:мне\\s+)?(?:${V_MORE}\\s+)?(?:${V_NUM}\\s+)?(?:${V_MORE}\\s+)?${V_WORD}`
  + `|(?:${V_ASK}\\s+)?(?:мне\\s+)?${V_QUALIFIED}${V_WORD}`
  + `)`;
/**
 * …и та же просьба с ЯВНЫМ разделителем. Круг 11, п.1: разделитель и есть признак того, что
 * дальше команда, — словарю глаголов тут делать нечего. Дефис берём только отдельным словом
 * («два варианта - сделай…»), иначе «три варианта-разворота» распалось бы надвое.
 */
const V_SEP = '(?:\\s*[:—–]+\\s*|\\s*,\\s*|\\s+-+\\s+)';
const RE_VARIANTS_LEAD_SEP = new RegExp(V_HEAD_LEAD + V_SEP + '(.+)$', 'iu');
/**
 * Круг 7, п.10: голова просьбы с ОБЯЗАТЕЛЬНЫМ числом («два варианта…», «покажи пару вариантов…»).
 * Число — единственное, что надёжно отличает просьбу о вариантах ПРАВКИ от содержательной
 * команды в том же падеже: «покажи варианты оплаты» — это про оплату, а «два варианта шапки» —
 * про две версии шапки.
 */
const V_HEAD_COUNTED = `^\\s*(?:[аи]\\s+|ну\\s+)?(?:${V_ASK}\\s+)?(?:мне\\s+)?(?:${V_MORE}\\s+)?(?:${V_NUM})\\s+(?:${V_MORE}\\s+)?${V_WORD}`;
const V_SUBJ_WORD = '[\\p{L}\\p{N}«»\'"·-]+';
const V_SUBJ_TAIL = '\\s+((?:' + V_SUBJ_WORD + ')(?:\\s+' + V_SUBJ_WORD + '){0,2})' + V_TAIL + '\\s*[.!?…]*\\s*$';
/** «два варианта шапки», «покажи пару вариантов этой карточки» — предмет в родительном падеже. */
const RE_VARIANTS_SUBJECT = new RegExp(V_HEAD_COUNTED + V_SUBJ_TAIL, 'iu');
/**
 * Круг 13, п.7: та же просьба БЕЗ числа — «варианты шапки», «покажи варианты кнопки».
 * Живая речь так и звучит, а прежде эти две реплики уходили в модель обычной командой: человек
 * просил варианты и не получал их ни разу.
 *
 * Отличить от содержательной команды («покажи варианты оплаты») числом уже нельзя, поэтому
 * страхуют два условия сразу: голова просьбы однозначная (V_HEAD_LEAD — множественное
 * «варианты» либо вежливый глагол перед «вариант»), и предмет — слой, который в документе
 * ЕСТЬ. Без документа этот разбор не работает вовсе: угадывать нечем.
 */
const RE_VARIANTS_SUBJECT_BARE = new RegExp(V_HEAD_LEAD + V_SUBJ_TAIL, 'iu');
/**
 * Круг 15, п.1: то же синонимами — «предложи три идеи для кнопки», «дай пару версий шапки».
 * Голова та же, что у RE_VARIANTS_WHOLE_ALT (число или «другие» обязательны), поэтому предмет
 * тут не размывает смысл: «покажи решения оплаты» под неё не подходит вовсе.
 */
const RE_VARIANTS_SUBJECT_ALT = new RegExp(V_HEAD_ALT + V_SUBJ_TAIL, 'iu');
/** Хвост команды начинается с глагола — значит, это команда, а не предмет в родительном падеже. */
const V_TAIL_VERBS = '(?:сделай(?:те)?|поменяй|измени|исправь|поправь|добав(?:ь|ьте)|созда(?:й|йте)|собери'
  + '|св[её]рстай|сверстай|построй|нарисуй|убер(?:и|ите)|удали|замени|поставь|подправь|переделай|растян(?:и|уть)'
  + '|сожми|увеличь|уменьши|перекрась|выровняй|сдвинь|передвинь|перенеси|продублируй|дублируй|скопируй|оберни'
  + '|сгруппируй|напиши|впиши|допиши|положи|помести|вставь|разложи|разверни|сверни)';
const RE_TAIL_VERB = new RegExp('^' + V_TAIL_VERBS + '(?![\\p{L}\\p{N}])', 'iu');
/**
 * Круг 15, п.1: тот же словарь, но в ЛЮБОМ месте предмета. Раньше команду в хвосте отсекал
 * общий looksLikeCommand, а в его словаре есть существительные («оформление» — слово темы),
 * и живая просьба «покажи варианты ОФОРМЛЕНИЯ кнопки» читалась командой: панель вариантов не
 * появлялась, а молча применялась одна правка. Глагол — признак команды надёжнее: «варианты
 * шапки СДЕЛАЙ компактнее» предметом не считается, «варианты оформления кнопки» — считается.
 */
const RE_SUBJ_VERB = new RegExp('(?:^|[\\s,:—–-])' + V_TAIL_VERBS + '(?![\\p{L}\\p{N}])', 'iu');
/**
 * Круг 15, п.2: предлог МЕСТА в предмете. «Три варианта оплаты в карточку» — это просьба
 * добавить в карточку три способа оплаты, а прежний разбор брал предметом «оплаты в карточку»
 * и по слову «карточку» находил существующий слой: человек просил содержимое, а получал
 * три версии карточки. У предмета вариантов места быть не может — он и есть место.
 */
const RE_SUBJ_PLACE = new RegExp('(?:^|\\s)(?:в|во|на|внутрь|внутри|под|над|после|перед|рядом'
  + '|возле|около|сверху|снизу|слева|справа|между|из|к|ко)(?![\\p{L}\\p{N}])', 'iu');
/**
 * Круг 7, п.10: «а по-другому можно», «а можно как-то иначе» — та же просьба с вежливым хвостом.
 * Закрытый словарь и привязка к началу И концу реплики: «иначе кнопка не видна» сюда не попадает.
 */
const V_OTHER_CORE = '(?:по[-\\s]?другому|по[-\\s]?иному|по[-\\s]?разному|иначе|на\\s+другой\\s+лад'
  + '|друг(?:ой|им)\\s+способом|разными\\s+способами)';
const V_OTHER_TAIL = '(?:[\\s,]+(?:можно|можешь|получится|выйдет|выйдут|давай|давайте|пожалуйста|плиз|попробуй|попробуем'
  + '|покажи|сделай|это|же|тут|здесь|сюда|вариант|варианты|версию))*';
const RE_VARIANTS_OTHER = new RegExp('^\\s*(?:[аи]\\s+|ну\\s+)?(?:' + V_ASK + '\\s+)?(?:мне\\s+)?'
  + '(?:как[-\\s]?то\\s+)?(?:это\\s+)?' + V_OTHER_CORE + V_OTHER_TAIL + '\\s*[?!.…]*\\s*$', 'iu');

/**
 * «А если иначе» — та же просьба другими словами. Сверяется целой репликой по закрытому
 * списку (как отмена), потому что «иначе» внутри фразы значит совсем другое:
 * «иначе кнопка не видна» — это не просьба о вариантах.
 */
const VARIANTS_PHRASES = new Set([
  'а если иначе', 'если иначе', 'а можно иначе', 'можно иначе', 'а как иначе', 'как иначе',
  'иначе', 'сделай иначе', 'попробуй иначе', 'может иначе', 'а может иначе', 'давай иначе',
  'а что если иначе', 'что если иначе', 'хочу иначе', 'покажи иначе',
  'по другому', 'а по другому', 'сделай по другому', 'попробуй по другому', 'можно по другому',
  'давай по другому', 'хочу по другому', 'покажи по другому', 'а если по другому',
  'если по другому', 'может по другому', 'а может по другому', 'что если по другому',
  'дай выбор', 'предложи выбор', 'на выбор', 'покажи на выбор',
  // круг 11, п.7: «а как ещё можно» — та же просьба, только вопросом
  'а как еще можно', 'как еще можно', 'а как еще можно сделать', 'как еще можно сделать',
  'а как еще', 'как еще', 'еще как можно', 'а еще как можно', 'а как по другому',
  // круг 15, п.1: та же просьба вопросом — «какие есть варианты?»
  'какие есть варианты', 'какие варианты', 'какие варианты есть', 'какие тут варианты',
  'какие есть альтернативы', 'какие альтернативы', 'какие еще варианты', 'какие еще есть варианты',
  'что еще можно', 'а что еще можно',
]);

/** Есть ли в хвосте команда, а не родительный падеж («…варианты ОПЛАТЫ»). */
function looksLikeCommand(s) {
  return anyMatch(RE.edit, s) || anyMatch(RE.create, s) || anyMatch(RE_ADD, s) || anyMatch(RE.theme, s);
}

/**
 * Круг 15, пп.1–2: годится ли фраза в ПРЕДМЕТ вариантов. Два запрета, и оба по фактам самой
 * фразы, а не по словарю тем:
 *   • глагол-команда где угодно («варианты шапки сделай компактнее») — это команда;
 *   • предлог места («… оплаты В КАРТОЧКУ») — предмет вариантов местом не уточняют, а вот
 *     содержательная команда — сплошь.
 * Что фраза и правда называет слой, решает потом mentionsExistingLayer: без слоя в документе
 * предметом она не становится вовсе.
 */
function subjectOk(phrase) {
  const s = String(phrase == null ? '' : phrase).trim();
  if (!s) return false;
  return !RE_SUBJ_VERB.test(s) && !RE_SUBJ_PLACE.test(s);
}

/**
 * Просьба показать варианты — третье действие, которое делает ОБОЛОЧКА, а не модель
 * (круг 5, п.3). Раньше «покажи три варианта» уходило в модель обычной командой и в лучшем
 * случае возвращалось переспросом: единственный творческий инструмент приложения был
 * недоступен человеку, который работает голосом.
 *
 * Консервативно, как с отменой: «добавь вариант оплаты картой», «в этом варианте поменяй цвет»,
 * «сколько вариантов?» здесь не ловятся. Хвост забираем в variantsOf только если он сам похож
 * на команду («три варианта: сделай шапку компактнее»); «покажи варианты оплаты» — не про
 * варианты правки, и такая реплика уходит в модель.
 *
 * @returns {{variantsOf: string}|null} variantsOf — команда, к которой просят варианты;
 *   пустая строка означает «варианты к предыдущей команде» (её оболочка берёт из истории).
 */
export function recognizeVariants(utterance, { doc = null } = {}) {
  const raw = String(utterance == null ? '' : utterance).trim();
  if (!raw || raw.length > 300) return null;
  if (recognizeAction(raw)) return null;            // «отмени» остаётся отменой
  for (const core of actionCores(raw)) {
    if (VARIANTS_PHRASES.has(core)) return { variantsOf: '' };
  }
  if (RE_VARIANTS_OTHER.test(raw)) return { variantsOf: '' };
  if (RE_VARIANTS_WHOLE.test(raw)) return { variantsOf: '' };
  if (RE_VARIANTS_WHOLE_ALT.test(raw)) return { variantsOf: '' };
  /**
   * «Три варианта: сделай шапку аккуратнее» — дальше команда.
   *
   * Круг 11, п.1: раньше хвост ещё и сверялся со словарём глаголов (looksLikeCommand), а в нём
   * закрытый список сравнительных степеней: «компактнее» есть, «аккуратнее», «интереснее»,
   * «живее», «читабельнее» — нет. Из десяти живых формулировок не ловилось восемь, фраза уходила
   * обычной командой, и вместо трёх решений молча применялась одна правка — слова «варианты»
   * человек не видел нигде. При ЯВНОМ разделителе словарь больше не спрашиваем: двоеточие или
   * тире и есть признак того, что дальше команда. Без разделителя проверка остаётся — иначе
   * «два варианта оплаты добавь в карточку» отдало бы обрубок «оплаты добавь в карточку».
   */
  const leadSep = RE_VARIANTS_LEAD_SEP.exec(raw);
  if (leadSep) {
    const tail = String(leadSep[1] || '').trim().replace(/^[:,—–-]+\s*/, '').trim();
    // «три варианта: ну это самое» — команды в хвосте нет, значит, просят варианты предыдущей
    if (tail) return { variantsOf: looksMeaningless(tail) ? '' : cutText(tail, 200) };
  }
  const lead = RE_VARIANTS_LEAD.exec(raw);
  if (lead) {
    const tail = String(lead[1] || '').trim().replace(/^[:,—–-]+\s*/, '').trim();
    if (tail && looksLikeCommand(tail) && RE_TAIL_VERB.test(tail)) return { variantsOf: cutText(tail, 200) };
  }
  /* «два варианта шапки» — предмет в родительном падеже, а не команда. Такую просьбу берём
   * только с числом и только когда предмет — слой, который в документе ЕСТЬ: иначе «покажи два
   * варианта оплаты» отобрало бы у человека содержательную команду. Без документа (вызов из
   * тестов и из оболочки до загрузки макета) достаточно числа. */
  const subj = RE_VARIANTS_SUBJECT.exec(raw);
  if (subj) {
    const phrase = String(subj[1] || '').trim();
    if (subjectOk(phrase)) {
      const named = doc ? mentionsExistingLayer(doc, phrase) : null;
      if (named) return { variantsOf: '', subject: named.name };
      if (!doc && !looksLikeCommand(phrase)) return { variantsOf: '', subject: phrase };
    }
  }
  /* Круг 13, п.7: «варианты шапки», «покажи варианты кнопки» — без числа, но с названным слоем.
   * Круг 15, п.1: и та же просьба синонимами — «предложи три идеи для кнопки». */
  if (doc) {
    for (const re of [RE_VARIANTS_SUBJECT_BARE, RE_VARIANTS_SUBJECT_ALT]) {
      const m = re.exec(raw);
      if (!m) continue;
      const phrase = String(m[1] || '').trim();
      if (!subjectOk(phrase)) continue;
      const named = mentionsExistingLayer(doc, phrase);
      if (named) return { variantsOf: '', subject: named.name };
    }
  }
  return null;
}

/**
 * Локальная классификация по глаголам и наличию выделения.
 * Возвращает {intent, confidence 0..1, reason}. План модели может её поправить.
 */
/* — Четвёртое и пятое локальные действия: компонент из узла и отсоединение (круг 19, п.4-5) —
 *
 * Почему локально, а не «обычной командой через модель». «Сделай из этого компонент» и
 * «отсоедини этот экземпляр» — это механика, а не замысел: что делать, ясно из самой фразы, а
 * ЧТО делать это с чем — из выделения. Единственное, что мог бы придумать за нас планировщик, —
 * имя компонента и набор свойств; но и то и другое уже лежит в документе именами слоёв, которые
 * дал человек. Поэтому команда стоит 0 вызовов модели вместо 2 (на локальной сборке это
 * секунды ожидания) и не может «промахнуться» — а предложенные имя и свойства говорятся вслух,
 * и переназвать их одной фразой дешевле, чем ждать круг планирования.
 *
 * Сознательно консервативно, как и откат: фраза сверяется ЦЕЛИКОМ, а если цели не нашлось —
 * либо честный переспрос (когда просьба однозначна), либо реплика уходит в модель (когда она
 * могла значить и что-то другое). Подметание на десятках просьб и ловушек — в отчёте круга.
 */

/** Слова, которые в имени компонента не встречаются: с ними это не имя, а продолжение команды. */
const RE_NOT_NAME = new RegExp('(крупн|больш|меньш|мельч|шир|уж|выш|ниж|жирн|тонь|светл|темн|т[её]мн'
  + '|плотн|простор|воздушн|компактн|иначе|друг|поменя|измен|сделай|удали|убер|поставь|добав)', 'iu');

/** Имя компонента из реплики: одно-три слова без служебных хвостов. '' — имени нет. */
function nameFromWords(raw) {
  const t = String(raw == null ? '' : raw).trim().replace(/^[«"']+|[»"'.,!?]+$/g, '').trim();
  if (!t) return '';
  const words = t.split(/\s+/);
  if (words.length > 3 || RE_NOT_NAME.test(t)) return '';
  return cutText(t, 60);
}

/** Указание на выделенное словами: «это», «этого», «его». */
const THIS_WORDS = new Set([
  'это', 'этот', 'эту', 'этого', 'этом', 'этим', 'его', 'её', 'ее', 'их', 'том', 'тот', 'то',
  'вот это', 'вот этот', 'выделенное', 'выделение', 'выделенный',
]);

const RE_MAKE_FROM = /^(?:сделай(?:те)?|сделать|собери|собрать|оформи|оформить|заведи|создай|создать)\s+из\s+(.+?)\s+компонент\p{L}*(?:\s+(.+))?$/u;
const RE_MAKE_BARE = /^(?:сделай(?:те)?|сделать|собери|собрать|оформи|оформить|заведи|создай|создать)\s+компонент\p{L}*(?:\s+из\s+(.+?))?$/u;
const RE_MAKE_INTO = /^(?:преврати|превратить|переведи|перенеси|вынеси|вынести|заверни)\s+(.+?)\s+в\s+компонент\p{L}*(?:\s+(.+))?$/u;
const RE_MAKE_LIB = /^(?:добав(?:ь|ьте|ить)|положи(?:те)?|помести|занеси|закинь|отправь|сохрани|сохранить|перенеси|вынеси|вынести)\s+(.+?)\s+в\s+библиотек\p{L}*$/u;
const RE_MAKE_NAMED = /^(?:назови|назвать|назовите|обзови|переименуй)\s+(.+?)\s+компонентом(?:\s+(.+))?$/u;
const RE_MAKE_IS = /^(?:сделай(?:те)?|сделать|пусть|оформи(?:те)?|оформить|заведи|сохрани|сохранить|объяви|объявить)\s+(.+?)\s+(?:будет\s+)?компонентом(?:\s+(.+))?$/u;

const RE_DETACH_HARD = /^(?:отсоедин\p{L}*|отвяж\p{L}*|отцеп\p{L}*|отлеп\p{L}*|разорви\s+связь)(?:\s+(.+))?$/u;
const RE_DETACH_SOFT = /^(?:сделай(?:те)?|преврати)\s+(.+?)\s+(?:в\s+)?(?:обычн\p{L}*|обыкновенн\p{L}*|независим\p{L}*|самостоятельн\p{L}*|отдельн\p{L}*|прост(?:ым|ой|ое))$/u;
/** «Отсоединить от раскладки» — это НЕ компоненты, а ручной сдвиг: у него своя правка. */
const RE_LAYOUT_WORD = /(раскладк|поток|сетк|привязк\p{L}*\s+к\s+сетк)/iu;

/**
 * Слова про «то самое» выкидываем: «этот экземпляр» — это выделенное, а не слой с таким именем.
 * @returns {string|null} что названо словами, или null — «выделенное»
 */
function cleanWhat(raw) {
  const words = String(raw == null ? '' : raw).trim().split(/\s+/).filter(Boolean)
    .filter((w) => !THIS_WORDS.has(w) && !/^(?:экземпляр\p{L}*|копи\p{L}*|штук\p{L}*|шту)$/u.test(w));
  const out = words.join(' ').trim();
  return out || null;
}

/** Имя компонента в том виде, в каком его сказал человек: разбор идёт по строчным. */
function originalCase(utterance, lowered) {
  const low = String(lowered == null ? '' : lowered);
  if (!low) return '';
  const src = String(utterance == null ? '' : utterance);
  const at = src.toLowerCase().replace(/ё/g, 'е').indexOf(low);
  if (at >= 0) return src.slice(at, at + low.length);
  return low.charAt(0).toUpperCase() + low.slice(1);
}

/**
 * Локально распознанная просьба про компоненты (круг 19, п.4-5).
 * @returns {{kind:'make'|'detach', what:string|null, name:string, soft:boolean}|null}
 */
export function recognizeComponentIntent(utterance) {
  for (const core of actionCores(utterance)) {
    if (!core || core.length > 90) continue;
    if (RE_LAYOUT_WORD.test(core)) continue;
    const mk = (what, name, soft = false) => ({
      kind: 'make',
      what: cleanWhat(what),
      name: originalCase(utterance, nameFromWords(name)),
      soft,
    });
    let m = RE_MAKE_FROM.exec(core);
    if (m && (!m[2] || nameFromWords(m[2]))) return mk(m[1], m[2]);
    m = RE_MAKE_BARE.exec(core);
    if (m) return mk(m[1], '');
    m = RE_MAKE_INTO.exec(core);
    if (m && (!m[2] || nameFromWords(m[2]))) return mk(m[1], m[2]);
    m = RE_MAKE_LIB.exec(core);
    if (m) return mk(m[1], '');
    m = RE_MAKE_NAMED.exec(core);
    if (m && m[2] && nameFromWords(m[2])) return mk(m[1], m[2]);
    m = RE_MAKE_IS.exec(core);
    // «сделай это компонентом» — про выделенное; «сделай карточку компонентом Плитка» — про карточку
    if (m && (!m[2] || nameFromWords(m[2]))) return mk(m[1], m[2]);
    m = RE_DETACH_HARD.exec(core);
    if (m) return { kind: 'detach', what: cleanWhat(m[1]), name: '', soft: false };
    m = RE_DETACH_SOFT.exec(core);
    if (m) return { kind: 'detach', what: cleanWhat(m[1]), name: '', soft: true };
  }
  return null;
}

export function classifyUtterance(utterance, { hasSelection = false, doc = null, prefer = null } = {}) {
  const s = String(utterance || '').trim();
  if (!s) return { intent: 'clarify', confidence: 0.9, reason: 'пустая команда' };
  if (looksMeaningless(s)) {
    return { intent: 'clarify', confidence: 0.85, reason: 'в реплике нет ни объекта правки, ни темы — похоже на недослышанную фразу' };
  }

  const isAsk = anyMatch(RE.ask, s);
  const isTheme = anyMatch(RE.theme, s);
  const isAdd = anyMatch(RE_ADD, s);
  // «добавь новый экран» — всё-таки create; «добавь в шапку кнопку» — правка
  const addsScreen = RE_NEW_ARTBOARD.test(s) || RE_ARTBOARD_WORD.test(s) || RE_WHOLE_SCREEN.test(s);
  const addsInto = isAdd && !addsScreen && RE_ADD_PLACE.test(s);
  /* Круг 36 (SPEC §11): «добавь микроанимации», «оживи кнопки», «при наведении карточка
   * приподнимается» — правка существующих слоёв (states/motion), а не новый блок: «добавь»
   * здесь не создаёт слоёв. Новый экран, названный прямо, остаётся созданием. */
  const micro = !addsScreen && looksMicroAnimation(s);
  const isCreate = !micro && (anyMatch(RE.create, s) || (isAdd && !addsInto));
  const isEdit = micro || anyMatch(RE.edit, s) || addsInto;

  if (isAsk && !isCreate && !isEdit && !isTheme) return { intent: 'ask', confidence: 0.9, reason: 'вопросительная форма' };
  if (isAsk && !isCreate && !isEdit) return { intent: 'ask', confidence: 0.6, reason: 'вопрос об оформлении' };
  if (isTheme && !isCreate) return { intent: 'theme', confidence: isEdit ? 0.7 : 0.85, reason: 'слова про оформление и токены' };
  if (isCreate && !isEdit) return { intent: 'create', confidence: hasSelection ? 0.75 : 0.9, reason: 'глагол создания' };
  if (micro && !isCreate) return { intent: 'edit', confidence: hasSelection ? 0.9 : 0.7, reason: 'микроанимации — состояния и движение существующих слоёв' };
  if (isEdit && !isCreate) return { intent: 'edit', confidence: hasSelection ? 0.9 : 0.6, reason: 'глагол изменения' };
  if (isCreate && isEdit) {
    return hasSelection
      ? { intent: 'edit', confidence: 0.55, reason: 'есть и создание, и правка — при выделении считаем правкой' }
      : { intent: 'create', confidence: 0.6, reason: 'есть и создание, и правка — без выделения считаем созданием' };
  }
  if (hasSelection) return { intent: 'edit', confidence: 0.4, reason: 'глаголов нет, но есть выделение' };
  /**
   * Круг 7, п.4: раньше здесь безоговорочно стоял create, и промпт планировщика подсказывал
   * модели именно создание. Из 30 проверенных команд так промахнулись четыре — и все четыре
   * были правками («сделай у кнопки радиус восемь», «сделай фон карточки как у кнопки»,
   * «повтори шапку со второго экрана здесь», «сделай таблицу по ширине как показатели»).
   * Сильная модель это переигрывала, а локальная (LM Studio) — та самая сборка с голосом — нет.
   *
   * Теперь: назван существующий слой → это правка; ничего не опознали → честное «не определено»
   * (unsure), и планировщику вместо подсказки уходит «реши сам».
   */
  /**
   * Круг 9, п.6: причина показывается человеку («Разбираю запрос: edit — …»), поэтому назвать
   * слой можно только при уверенном совпадении. При слабом реплику всё равно считаем правкой
   * (о существующем содержимом говорят чаще, чем строят новое), но имени не выдумываем.
   */
  const named = doc ? mentionsExistingLayer(doc, s, { prefer: prefer instanceof Set ? prefer : undefined }) : null;
  if (named && named.strength === 'strong') {
    return {
      intent: 'edit', confidence: 0.45, unsure: true,
      reason: `глаголов нет, но назван существующий слой «${named.name}» — похоже на правку`,
    };
  }
  if (named) {
    return {
      intent: 'edit', confidence: 0.35, unsure: true,
      reason: 'глаголов нет, но речь про то, что в макете уже есть — похоже на правку',
    };
  }
  return {
    intent: 'create', confidence: 0.25, unsure: true,
    reason: 'глаголов нет, выделения нет и знакомых слоёв в команде не названо — намерение не определено',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. Контекст документа для промптов
 * ──────────────────────────────────────────────────────────────────────────── */

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v.filter(Boolean) : [v]);

/**
 * Узел документа по id. Круг 30: только строковый id и только своё свойство словаря —
 * документ, отравленный до исправления ядра (объект в `of`, `parent`, `children`), иначе
 * бросал TypeError прямо в ключе (`nodes[{toString:1}]`), а `nodes.constructor` давал функцию.
 */
function nodeOf(doc, id) {
  if (!doc || !doc.nodes || typeof id !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(doc.nodes, id)) return undefined;
  const n = doc.nodes[id];
  return n && typeof n === 'object' ? n : undefined;
}

/* Круг 30: поля чужого документа — без приведения. Документ, записанный до того, как ядро
   стало проверять форму каждого поля (§9.14), может нести объект в `name`, `characters`,
   `radius`, `of`, токенах; шаблон строки и String() на `{toString: 1}` бросают TypeError —
   выжимка, описание правки и проверки падали бы целиком. */
/** Строковое поле: не строка — пусто. */
const strOf = (v) => (typeof v === 'string' ? v : '');
/** Значение для строки: строка, конечное число и булево — как есть; прочее — «?». */
const wordOf = (v) => (typeof v === 'string' ? v
  : (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? String(v) : '?');
/** Число из поля: число — как есть, строка — разбором, прочее — NaN (без valueOf чужого объекта). */
const numOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
/** Дети узла: только массив (круг 31 — во всех обходах brain, не только в описаниях). */
const kidsOf = (n) => (n && Array.isArray(n.children) ? n.children : []);

/**
 * Круг 18: переспрос без готовых ответов заставлял человека переписывать команду целиком.
 * Здесь — ответы для ДВУХ переспросов, которые задаёт сама оболочка, без модели. Варианты
 * собираются из настоящих имён слоёв документа: подставить выдуманное имя значит предложить
 * команду, которая гарантированно не выполнится.
 */
function namedChildren(doc, rootId, limit = 24) {
  const out = [];
  const walk = (id, depth) => {
    if (out.length >= limit || depth > 4) return;
    const n = nodeOf(doc, id);
    if (!n) return;
    for (const kid of (Array.isArray(n.children) ? n.children : [])) {
      const k = nodeOf(doc, kid);
      if (!k) continue;
      /* Круг 19: имена из библиотеки сюда не годятся. Отсюда берутся ГОТОВЫЕ КОМАНДЫ человеку
       * («сделай «Кнопка» просторнее»), а поиск цели по имени в библиотеку не заходит — команда
       * с именем мастера попала бы в одноимённый слой на доске или никуда. */
      if (inLibrary(doc, null, kid)) continue;
      const name = String(k.name || '').trim();
      if (name) out.push({ id: kid, name, type: k.type });
      walk(kid, depth + 1);
    }
  };
  walk(rootId, 0);
  return out;
}

/** Куда смотреть за именами: активная доска, а если его нет — весь документ. */
function scopeRoot(engine, doc, activeArtboardId) {
  if (activeArtboardId && nodeOf(doc, activeArtboardId)) return activeArtboardId;
  const root = doc && doc.root;
  const kids = kidsOf(nodeOf(doc, root));
  for (const id of kids) if (isArtboardLocal(engine, doc, id)) return id;
  return root;
}

/**
 * Круг 18: текст переспроса. Раньше при intent="clarify" без поля clarify подставлялся
 * plan.summary — а это ОПИСАНИЕ работы, не вопрос. На экране выходила карточка «Выберите
 * готовый ответ», озаглавленная фразой, которая ни о чём не спрашивает (поймано на снимке).
 * Summary берём, только если он и правда спрашивает; иначе — своя заготовка.
 */
function clarifyQuestion(plan) {
  const own = String((plan && plan.clarify) || '').trim();
  if (own) return own;
  const summary = String((plan && plan.summary) || '').trim();
  if (summary.endsWith('?')) return summary;
  return 'Не разобрал команду. Что именно поменять — и где: заголовок, кнопка, карточка?';
}

/**
 * Снять ОДНУ внешнюю пару кавычек — и только если кавычки в остатке сходятся. Снимать их
 * подряд регуляркой нельзя: у ответа «убери «Аватар»» отрывалась закрывающая кавычка ИМЕНИ,
 * и команда уходила с покалеченным именем слоя (круг 18, поймано на прогоне).
 */
function unwrapQuotes(v) {
  let t = v;
  for (let i = 0; i < 2; i += 1) {
    const m = /^[«"'`]([\s\S]*)[»"'`]$/.exec(t);
    if (!m) break;
    const inner = m[1];
    if ((inner.match(/«/g) || []).length !== (inner.match(/»/g) || []).length) break;
    t = inner.trim();
  }
  return t;
}

/**
 * Круг 18: три готовых ответа к переспросу. Берём то, что дала модель (она видела реплику и
 * выжимку, её варианты точнее), но НЕ доверяем вслепую: имя слоя, которого в документе нет,
 * дало бы команду, заведомо обречённую на «слой не найден». Чего не хватило — дополняем
 * своими, собранными из настоящих имён.
 */
function clarifyChoices(plan, engine, doc, activeArtboardId) {
  const fromModel = Array.isArray(plan && plan.clarifyOptions) ? plan.clarifyOptions : [];
  const known = new Set(namedChildren(doc, scopeRoot(engine, doc, activeArtboardId), 200)
    .map((n) => n.name.toLowerCase()));
  const quoted = /[«"']([^«»"']{2,60})[»"']/g;
  const ok = fromModel.filter((o) => {
    quoted.lastIndex = 0;
    let m; let good = true;
    while ((m = quoted.exec(o))) if (!known.has(m[1].trim().toLowerCase())) good = false;
    return good;
  });
  const out = ok.slice(0, 3);
  if (out.length >= 3) return out;
  const seen = new Set(out.map((o) => o.toLowerCase()));
  for (const extra of starterOptions(engine, doc, activeArtboardId)) {
    if (out.length >= 3) break;
    if (seen.has(extra.toLowerCase())) continue;
    seen.add(extra.toLowerCase());
    out.push(extra);
  }
  return out;
}

/** Три готовых команды на «я не расслышал»: разные слои и разные по смыслу правки. */
function starterOptions(engine, doc, activeArtboardId) {
  const here = namedChildren(doc, scopeRoot(engine, doc, activeArtboardId));
  const text = here.find((n) => n.type === 'text');
  const frame = here.find((n) => n.type === 'frame');
  const other = here.find((n) => n !== text && n !== frame);
  const out = [];
  if (text) out.push(`сделай «${text.name}» крупнее`);
  if (frame) out.push(`сделай «${frame.name}» просторнее`);
  if (other) out.push(`убери «${other.name}»`);
  // документ пуст или слои без имён — предлагаем то, что выполнимо всегда
  if (!out.length) return ['собери экран оплаты', 'добавь заголовок и кнопку', 'сделай тёмную тему'];
  while (out.length < 3) out.push(out.length === 1 ? 'сделай тёмную тему' : 'добавь ещё один экран');
  return out.slice(0, 3);
}

/** Два толкования «убери последнее» — каждое готовой командой, плюс третье про выбор руками. */
function undoDoubtOptions(engine, doc, activeArtboardId) {
  const here = namedChildren(doc, scopeRoot(engine, doc, activeArtboardId));
  const last = here.length ? here[here.length - 1] : null;
  const out = ['отмени последнюю правку'];
  if (last) out.push(`удали «${last.name}»`);
  out.push('покажи историю правок');
  return out.slice(0, 3);
}

function isArtboardLocal(engine, doc, id) {
  if (engine && typeof engine.isArtboard === 'function') {
    try { return !!engine.isArtboard(doc, id); } catch { /* ниже */ }
  }
  const n = nodeOf(doc, id);
  return !!n && n.parent === doc.root;
}

/** Ближайший контейнер (фрейм или страница), в который можно вложить новый узел. */
function containerFor(doc, id) {
  let cur = nodeOf(doc, id);
  let guard = 0;
  while (cur && guard++ < 256) {
    if (cur.type === 'frame' || cur.type === 'page') return cur.id;
    cur = cur.parent ? nodeOf(doc, cur.parent) : null;
  }
  return doc.root;
}

/** Цепочка предков узла, от него самого к корню. */
function chainUp(doc, id) {
  const out = [];
  let cur = nodeOf(doc, id);
  let guard = 0;
  while (cur && guard++ < 512) {
    out.push(cur.id);
    cur = cur.parent ? nodeOf(doc, cur.parent) : null;
  }
  return out;
}

/** Общий контейнер нескольких узлов: «оберни эти три» должно создать обёртку РЯДОМ с ними. */
function commonContainer(doc, ids) {
  const chains = ids.map((id) => chainUp(doc, id));
  if (!chains.length) return doc.root;
  const first = chains[0];
  for (const candidate of first) {
    if (chains.every((c) => c.includes(candidate))) {
      const n = nodeOf(doc, candidate);
      if (n && (n.type === 'frame' || n.type === 'page')) return candidate;
      return containerFor(doc, n && n.parent);
    }
  }
  return doc.root;
}

/**
 * Область команды. Две РАЗНЫЕ вещи (п.1):
 *   ids         — что именно править: сами выделенные узлы;
 *   containerId — куда вставлять новое: ближайший фрейм-контейнер.
 * Раньше обе роли играл containerId, и «сделай заголовок крупнее» ставило стиль
 * на фрейм-родитель: валидатор молчал, геометрия не менялась, эффекта не было.
 *
 * Активный артборд приходит явным полем options.activeArtboardId (п.5);
 * doc.meta.activeArtboard остаётся запасным источником.
 *
 * Круг 9, п.5: options.selectionBy = 'agent' | 'human' (по умолчанию 'human') — КТО выделил.
 * Оболочка после правки сама выделяет всё, что агент задел (selectTouched), и такое выделение
 * не значит «человек просит работать здесь»: оно значит «вот что я только что сделал».
 * Область работы из него получается прежняя, но предупреждать о выходе за её границы нельзя.
 */
export function resolveScope(doc, selection, engine, options = {}) {
  const raw = asArray(selection).filter((id) => nodeOf(doc, id));
  const by = options && options.selectionBy === 'agent' ? 'agent' : 'human';
  /**
   * Круг 13, п.3: потомки уже выделенных узлов — не отдельные цели. Оболочка после правки
   * выделяет и фрейм, и его текст (selectTouched), и такое выделение давало задвоенных
   * кандидатов, задвоенные операции и ложное «подходит узлов — 2 (X, X)».
   * Что отброшено, называем полем nested: оболочке есть о чём сказать, если понадобится.
   */
  const { kept: sel, nested } = dropNested(doc, raw);
  const nest = nested.length ? { nested } : {};
  if (sel.length === 1) {
    const only = nodeOf(doc, sel[0]);
    // один выделенный фрейм — вкладываем внутрь него, иначе рядом, в его контейнер
    const containerId = only.type === 'frame' ? sel[0] : containerFor(doc, only.parent || sel[0]);
    return { ids: sel, containerId: containerId || doc.root, kind: 'selection', selectionBy: by, ...nest };
  }
  if (sel.length) {
    // несколько выделенных — общий контейнер: обёртка встаёт рядом с ними, а не внутрь одного из них
    return { ids: sel, containerId: commonContainer(doc, sel) || doc.root, kind: 'selection', selectionBy: by, ...nest };
  }
  const explicit = options && options.activeArtboardId;
  const fromMeta = doc.meta && doc.meta.activeArtboard;
  const rootKids = kidsOf(nodeOf(doc, doc.root));
  const artboard = (explicit && nodeOf(doc, explicit)) ? explicit
    : (fromMeta && nodeOf(doc, fromMeta)) ? fromMeta
      : rootKids[0];
  if (artboard) return { ids: [artboard], containerId: artboard, kind: 'artboard' };
  return { ids: [doc.root], containerId: doc.root, kind: 'document' };
}

const SCOPE_LABELS = { selection: 'выделенная область', artboard: 'активная доска', document: 'весь документ' };

/** Компактная выжимка токенов документа. */
export function describeTokens(doc) {
  const t = (doc && doc.tokens) || {};
  const out = [];
  const group = (g) => (g && typeof g === 'object' && !Array.isArray(g) ? Object.entries(g) : []);
  const colors = group(t.colors);
  out.push(colors.length ? 'colors: ' + colors.map(([k, v]) => `${k}=${wordOf(v)}`).join(', ') : 'colors: (нет)');
  const types = group(t.type);
  // Круг 5, п.11: интерлиньяж не показывался вовсе, а промпт темы требовал «1.1-1.6» —
  // модель правила вслепую и в чужих единицах, хотя документ хранит пиксели (18, 22, 30).
  const num = (v) => (v == null ? '?' : wordOf(v));
  out.push(types.length
    ? 'type (имя(кегль px/насыщенность/интерлиньяж px)): '
      + types.map(([k, v]) => `${k}(${num(v && v.fontSize)}/${num(v && v.fontWeight)}/${num(v && v.lineHeight)})`).join(', ')
    : 'type: (нет)');
  /* Круг 20 (SPEC §6.6): шкалы печатаются с НОМЕРАМИ шагов — «0=0 1=2 2=4 … 12=64» — один раз,
   * здесь. Узлы ссылаются на шаги по номеру, и модель должна отвечать ссылкой «spacing.6»;
   * без номеров ей пришлось бы считать позицию в списке самой, а это верный способ промахнуться
   * на единицу. Значение рядом — чтобы рассуждать о пикселях там, где человек говорит о них. */
  const scaled = scaleLines(doc, null);
  const has = (k) => Array.isArray(t[k]) && t[k].length;
  if (!has('spacing')) out.push('spacing: (нет)');
  if (!has('radii')) out.push('radii: (нет)');
  out.push(...scaled);
  // круг 36 (SPEC §11): ступени скорости анимации и тени — модель отвечает ссылками на них
  out.push(...motionTokenLines(doc));
  return out.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6a. Компоненты: библиотека как СЛОВАРЬ агента (круг 19, SPEC §5)
 *
 * Смысл круга — не переиспользование, а СУЖЕНИЕ СЛОВАРЯ: модель выбирает из
 * компонентов продукта вместо того, чтобы сочинять кнопку с нуля. Отсюда всё
 * остальное в этом файле:
 *   • библиотека идёт отдельным блоком ПЕРЕД документом (§5.9) — это словарь,
 *     а не часть макета: её узлы в выжимке не печатаются вовсе;
 *   • экземпляр — ОДНА строка, без внутренностей (в документе их и нет);
 *   • компонент адресуется ТОЛЬКО по имени, отдельным каналом. Ядро нарочно
 *     убрало библиотеку из resolveTarget, иначе мастер «Кнопка» перебивал бы
 *     кнопку на доске; здесь то же правило повторено для поиска по именам,
 *     который мозг ведёт сам (см. refCandidates).
 *
 * Функции ядра для компонентов НЕ входят в ENGINE_MEMBERS сознательно: движок
 * без них (и документ без библиотеки) остаётся законным, и мозг просто работает
 * как до круга 19. Поэтому каждый вызов — через проверку «а умеет ли движок».
 * ──────────────────────────────────────────────────────────────────────────── */

/** Роль страницы-библиотеки (SPEC §5.3) — контракт документа, а не имя функции. */
const LIBRARY_ROLE = 'library';

/** Библиотека документа: сначала спрашиваем ядро, иначе — по контракту §5.3. */
function libraryIdOf(doc, engine) {
  if (engine && typeof engine.libraryNode === 'function') {
    try {
      const n = engine.libraryNode(doc);
      if (n && n.id && nodeOf(doc, n.id)) return n.id;
    } catch { /* движок без компонентов — ищем сами */ }
  }
  const root = nodeOf(doc, doc && doc.root);
  for (const id of kidsOf(root)) {
    const n = nodeOf(doc, id);
    if (n && n.type === 'page' && n.role === LIBRARY_ROLE) return id;
  }
  return null;
}

/** Кеш «библиотека этого документа»: за одну команду он спрашивается десятки раз. */
const libCache = new WeakMap();

/**
 * Все узлы библиотеки (сама страница и мастера с их поддеревьями).
 * Пустое множество — библиотеки нет, и весь код ниже становится пустой веткой.
 * @returns {Set<string>}
 */
function libraryIds(doc, engine) {
  if (!doc || !doc.nodes) return new Set();
  const hit = libCache.get(doc);
  if (hit) return hit;
  const out = new Set();
  const libId = libraryIdOf(doc, engine);
  if (libId) {
    const walk = (id, depth) => {
      if (out.has(id) || depth > MAX_TREE_DEPTH * 4) return;
      out.add(id);
      for (const k of kidsOf(nodeOf(doc, id))) walk(k, depth + 1);
    };
    walk(libId, 0);
  }
  libCache.set(doc, out);
  return out;
}

/** Лежит ли узел в библиотеке (сам мастер, его внутренность или страница библиотеки). */
function inLibrary(doc, engine, id) {
  const set = libraryIds(doc, engine);
  return set.size ? set.has(id) : false;
}

/** Список компонентов документа — словарь агента (SPEC §5.4: реестра нет, считается на лету). */
function componentList(engine, doc) {
  if (!engine || typeof engine.components !== 'function') return [];
  try {
    const list = engine.components(doc);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/** Подпись компонента: `Кнопка(текст, вид: accent|surface)` (§5.9). Без ядра — сами. */
function signatureOf(engine, info) {
  if (engine && typeof engine.componentSignature === 'function') {
    try {
      const s = engine.componentSignature(info);
      if (s) return s;
    } catch { /* соберём сами */ }
  }
  const parts = ((info && info.props) || []).map((p) => (p.kind === 'enum' && Array.isArray(p.values) && p.values.length
    ? `${p.name}: ${p.values.join('|')}` : p.name));
  return `${(info && info.name) || 'Компонент'}${parts.length ? '(' + parts.join(', ') + ')' : '()'}`;
}

/** Экземпляр одной строкой: `Кнопка "Оплатить" вид=accent` (§5.9). */
function instanceWords(doc, engine, node) {
  if (engine && typeof engine.instanceSummary === 'function') {
    try {
      const s = engine.instanceSummary(doc, node.id);
      if (s) return s;
    } catch { /* соберём сами */ }
  }
  const master = nodeOf(doc, node.of);
  const comp = master && master.component;
  const name = (comp && typeof comp.name === 'string' && comp.name.trim()) || 'Компонент';
  const bits = [];
  for (const p of (comp && Array.isArray(comp.props) ? comp.props : [])) {
    if (!p || typeof p.name !== 'string' || !p.name) continue;
    const props = node.props && typeof node.props === 'object' ? node.props : null;
    const raw = props && Object.prototype.hasOwnProperty.call(props, p.name) ? props[p.name] : undefined;
    if (raw === undefined) continue;
    if (p.kind === 'text') bits.push(`"${wordOf(raw)}"`);
    else bits.push(`${p.name}=${refWord(raw)}`);
  }
  return bits.length ? `${name} ${bits.join(' ')}` : name;
}

/** Имена компонентов через запятую — для человеческих фраз «есть Кнопка, Метка». */
function componentNames(list) {
  return asArray(list).map((c) => c && c.name).filter(Boolean).join(', ');
}

/**
 * Компонент по имени, как его назвала модель или человек. Совпадение — по имени без
 * учёта регистра и кавычек; при нескольких частичных совпадениях возвращаем их все,
 * чтобы вызывающий переспросил, а не угадывал.
 * @returns {{info:object|null, ambiguous:Array}}
 */
function findComponent(list, raw) {
  const all = asArray(list);
  const needle = String(raw == null ? '' : raw).trim().replace(/^[«"'#]+|[»"'.,!?]+$/g, '').toLowerCase();
  if (!needle || !all.length) return { info: null, ambiguous: [] };
  const exact = all.filter((c) => String(c.name || '').toLowerCase() === needle);
  if (exact.length) return { info: exact[0], ambiguous: [] };
  // «кнопку», «кнопки» — тот же компонент: сверяем по основе слова, как в остальном мозге
  const stem = (s) => String(s || '').toLowerCase().split(/\s+/).map(stemRu).join(' ');
  const byStem = all.filter((c) => stem(c.name) === stem(needle));
  if (byStem.length === 1) return { info: byStem[0], ambiguous: [] };
  /* Сокращение имени компонента принимаем («карточка» → «Карточка показателя»), а вот
   * ОБРАТНОЕ — нет: «Кнопка «Добавить пункт»» начинается с «Кнопка», но это имя СЛОЯ на доске.
   * Принять его за компонент значило бы превратить «поправь эту кнопку» в «поправь все кнопки»
   * — ровно ту подмену, из-за которой ядро убрало библиотеку из поиска по именам. Лучше
   * отказать словами и дать модели назвать компонент точно. */
  const part = all.filter((c) => {
    const n = String(c.name || '').toLowerCase();
    return n.startsWith(needle) || n.includes(needle);
  });
  if (part.length === 1) return { info: part[0], ambiguous: [] };
  return { info: null, ambiguous: part.length ? part : [] };
}

/**
 * Блок «БИБЛИОТЕКА» перед выжимкой документа (§5.9) — тот самый словарь.
 * Пустая строка, если библиотеки нет: обещать модели компоненты, которых нет,
 * значит получить ссылку на выдуманный компонент.
 * @param {object} doc
 * @param {object} engine движок (может не умать компонентов — тогда блока нет)
 * @param {{selected?:Iterable<string>}} [opts] выделенные узлы: если человек выбрал мастера,
 *   в словаре это надо пометить — иначе «сделай крупнее» непонятно к чему отнести
 * @returns {string}
 */
export function describeLibrary(doc, engine, opts = {}) {
  const list = componentList(engine, doc);
  if (!list.length) return '';
  const chosen = new Set(asArray([...(opts.selected || [])]));
  const lines = [`БИБЛИОТЕКА ПРОДУКТА — СЛОВАРЬ СБОРКИ, компонентов: ${list.length}.`];
  for (const info of list) {
    const mine = chosen.has(info.id) || (info.props || []).some((p) => chosen.has(p.target));
    const used = info.instances === 0 ? 'на досках ещё нет'
      : `на досках экземпляров: ${info.instances}`;
    lines.push(`  ${signatureOf(engine, info)} — ${used}${mine ? `  ${MARK_SELECTED}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Что за компоненты выделил человек (узлы внутри библиотеки → компоненты и число экземпляров).
 * @returns {{names:string[], instances:number}}
 */
function libraryWorkInfo(doc, engine, ids) {
  const names = [];
  let instances = 0;
  for (const info of componentList(engine, doc)) {
    const mine = asArray(ids).some((id) => id === info.id || chainUp(doc, id).includes(info.id));
    if (!mine) continue;
    names.push(info.name);
    instances += Number(info.instances) || 0;
  }
  return { names, instances };
}

/**
 * Правила компонентов для промпта (круг 19, п.2). Выдаются ТОЛЬКО когда библиотека есть:
 * пообещать модели компоненты в документе без библиотеки — это заказать ссылку на выдуманный
 * компонент, а мы её потом отклоним и потратим круг починки.
 *
 * Почему именно такая схема ответа (обоснование выбора):
 *   • поставить экземпляр — НЕ новая форма правки, а новый ТИП УЗЛА в том же дереве
 *     ({type:"instance", of, props}). Так экземпляры сразу доступны и в генерации целого
 *     экрана (schema tree), и в точечной правке (op:"create" с node) — одной ценой вместо двух,
 *     и вся машинерия «куда класть» (placement, wideTarget, parent по имени) работает как была;
 *   • свойство экземпляра — обычный set по пути "props.<имя>": от этого бесплатно достаются
 *     «уже так» (nothingToChange), снятие значения, дедупликация правок и человеческие строки
 *     про пропущенную правку;
 *   • правка КОМПОНЕНТА — отдельная операция op:"master", а не set по имени. Иначе «сделай
 *     кнопку крупнее» неотличимо от «сделай кнопку на доске крупнее»: у мастера «Кнопка» и
 *     у слоя «Кнопка «Добавить пункт»» одно и то же слово в имени. Ядро ровно поэтому убрало
 *     библиотеку из resolveTarget; отдельная операция — то же решение на нашем уровне, и она
 *     заставляет модель ВЫБРАТЬ, а не промахнуться молча.
 * @param {Array} list components(doc)
 * @param {'tree'|'patch'|'plan'} role
 * @returns {string}
 */
function componentRules(list, role) {
  if (!asArray(list).length) return '';
  const names = componentNames(list);
  const head = `КОМПОНЕНТЫ (блок «БИБЛИОТЕКА ПРОДУКТА» выше — это словарь сборки)
- Если в библиотеке есть подходящий компонент, собирай ИЗ НЕГО, а не из фреймов с текстом:
  так экран получается из системы продукта, а не похожим на неё. Компоненты: ${names}.
- Экземпляр — это узел {type:"instance", of:"<ИМЯ компонента из библиотеки>", props:[{name:"<имя свойства>", value:"<значение>"}]}.
  Детей у него НЕТ и быть не может: содержимое экземпляра — сам компонент.
- Имя компонента бери из библиотеки ДОСЛОВНО. Выдуманное имя будет отброшено, как выдуманный слой.
- Свойства — только объявленные в подписи компонента; значения через двоеточие («вид: accent|surface») — закрытый список.
- Внутренности экземпляра не адресуются: в документе их нет, в выжимке их нет, по имени их не найти.`;
  if (role === 'tree') {
    return `${head}
- Размер экземпляра задавать не нужно: он берёт его у компонента. Задай, только если просили другой.`;
  }
  if (role === 'plan') {
    return `КОМПОНЕНТЫ
- В документе есть библиотека компонентов: ${names}. Новое собирается ИЗ НИХ, если подходящее есть.
- «Сделай все кнопки крупнее», «поправь компонент» — это intent "edit" (правка компонента), а не "theme" и не "create".
- Правка компонента задевает все его экземпляры сразу: так и напиши в summary, если задача про компонент.`;
  }
  return `${head}
- Поменять свойство у ОДНОГО экземпляра: {op:"set", target:"<id экземпляра из выжимки>", path:"props.<имя свойства>", value:"<значение>"}.
- Поставить новый экземпляр: {op:"create", parent:"<куда>", node:{type:"instance", of:"<имя компонента>", props:[…]}}.
- Поменять САМ компонент — сразу во всех экземплярах: {op:"master", target:"<имя компонента>", path:"radius", value:"24"}.
  Это та же правка, что set, но по компоненту: пути и значения те же. Так делается «сделай ВСЕ кнопки крупнее»,
  «поправь компонент», «у всех меток другой фон». Для одной кнопки на доске op:"master" НЕ годится: там обычный set.
- Отсоединить экземпляр (нужно, только если просят поправить именно ЭТУ копию не через свойства):
  {op:"detach", target:"<id экземпляра>"} — он станет обычным поддеревом и перестанет следовать компоненту.
- Сделать компонентом существующий узел: {op:"component", target:"<узел>", name:"<как назвать>"}.
- Не выдумывай пути внутрь экземпляра: "characters" у экземпляра нет, есть его свойство (например "props.текст").`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6b. Шкалы как ссылки (круг 20, SPEC §6)
 *
 * В документе больше нет числа 16: зазор — это 'spacing.6', ссылка на шаг шкалы, и смена
 * значения шага переверстывает всё, что на него ссылается. Для мозга из этого следует:
 *   • МОДЕЛЬ должна видеть и ссылку, и число (выжимка: gap=spacing.6(16)), а шкалы — с
 *     номерами шагов один раз в шапке; отвечать она должна ссылкой, «плотнее» — это шаг
 *     вниз, а не минус четыре пикселя (§6.6);
 *   • ЗНАЧЕНИЕ от модели проверяется тут же: ссылка — на ту ли шкалу и жив ли шаг; число,
 *     точно равное шагу, становится ссылкой само (§6.6); число мимо шкалы — см. scaleValue;
 *   • «ТО ЖЕ САМОЕ» решает ядро (keepFieldForm), а мозг его зеркалит (sameAsNow, §6.4):
 *     число, равное значению текущей ссылки, — пустая правка; ссылка поверх числа — нет;
 *   • ЧЕЛОВЕК шкалу знать не обязан (§6.7): в его строках — «зазор 16 px (шаг шкалы)»,
 *     «шкала отступов», без spacing и radii.
 *
 * Функции ядра (resolveScale, scaleSteps, scaleIndexOf, scaleRefsIn) идут через движок,
 * когда он их умеет: §6.3 требует одной точки разрешения ссылки в число. Заглушка движка
 * в тестах их не знает — тогда работает зеркало на tokens документа; форма ссылки —
 * копия core.SCALE_REF_RE, это контракт §6.1, а не догадка.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Форма ссылки (копия core.SCALE_REF_RE, §6.1): имя шкалы, точка, номер шага без ведущих нулей. */
const SCALE_REF_RE = /^(spacing|radii)\.(0|[1-9]\d*)$/;

/** Имена шкал для человека — копия core.SCALE_NAMES (§6.7) с падежами для фраз. */
const SCALE_RU = {
  spacing: { nom: 'шкала отступов', gen: 'шкалы отступов', loc: 'шкале отступов', acc: 'шкалу отступов' },
  radii: { nom: 'шкала скруглений', gen: 'шкалы скруглений', loc: 'шкале скруглений', acc: 'шкалу скруглений' },
};

/** Какая шкала у какого пути (§6.2): зазор и поля — отступы, скругление — скругления; остальное — null. */
function scaleOfPath(path) {
  const p = String(path == null ? '' : path);
  if (p === 'layout.gap' || p === 'layout.padding' || /^layout\.padding\.[trbl]$/.test(p)) return 'spacing';
  if (p === 'radius' || /^radius\.\d+$/.test(p)) return 'radii';
  return null;
}

/**
 * Разбор ссылки на шаг. Принимает и то, чем модель ссылку ОБЫЧНО портит: регистр
 * («Spacing.6»), скобки и пробелы («spacing[6]», «spacing 6»), эхо выжимки («spacing.6(16)»).
 * Число в скобках — подсказка из выжимки, а не значение: ссылка сильнее.
 * @returns {{scale:string, index:number, ref:string}|null}
 */
function parseRef(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  let m = SCALE_REF_RE.exec(s);
  if (!m) m = /^(spacing|radii)\s*[.\-_\[ ]\s*(\d+)\]?\s*(?:\(\s*-?\d+(?:[.,]\d+)?\s*(?:px)?\s*\))?$/.exec(s);
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isFinite(index)) return null;
  return { scale: m[1], index, ref: `${m[1]}.${index}` };
}

/** Шаги шкалы документа: через движок (он знает умолчания), иначе — из tokens. */
function stepsOf(doc, scale, engine) {
  if (engine && typeof engine.scaleSteps === 'function') {
    try {
      const got = engine.scaleSteps(doc, scale);
      if (Array.isArray(got)) return got;
    } catch { /* зеркало ниже */ }
  }
  const own = doc && doc.tokens && doc.tokens[scale];
  return Array.isArray(own) ? own : [];
}

/**
 * Ссылка или число → число (та же семантика, что у core.resolveScale): число как есть,
 * живая ссылка — значением шага, всё остальное — undefined.
 */
function scaleNum(doc, v, scale, engine) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (engine && typeof engine.resolveScale === 'function') {
    try { return engine.resolveScale(doc, v, scale); } catch { /* зеркало ниже */ }
  }
  const ref = parseRef(v);
  if (!ref || (scale && ref.scale !== scale)) return undefined;
  const step = stepsOf(doc, ref.scale, engine)[ref.index];
  return typeof step === 'number' && Number.isFinite(step) ? step : undefined;
}

/** Номер шага, ТОЧНО равного числу, или -1 (копия смысла core.scaleIndexOf). */
function stepIndexOf(doc, scale, n, engine) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return -1;
  if (engine && typeof engine.scaleIndexOf === 'function') {
    try { return engine.scaleIndexOf(doc, scale, n); } catch { /* зеркало ниже */ }
  }
  return stepsOf(doc, scale, engine).indexOf(n);
}

/** Соседние шаги вокруг числа: ближайший снизу и сверху (null — шкала кончилась). */
function nearestSteps(steps, n) {
  let below = null, above = null;
  steps.forEach((v, i) => {
    if (typeof v !== 'number') return;
    if (v <= n && (!below || v > below.v)) below = { i, v };
    if (v >= n && (!above || v < above.v)) above = { i, v };
  });
  return { below, above };
}

/** Все ссылки документа на шкалу: через движок, иначе — обход полей §6.2 своими руками. */
function refsInDoc(doc, scale, engine) {
  if (engine && typeof engine.scaleRefsIn === 'function') {
    try {
      const got = engine.scaleRefsIn(doc, scale);
      if (Array.isArray(got)) return got;
    } catch { /* зеркало ниже */ }
  }
  const out = [];
  for (const id of Object.keys((doc && doc.nodes) || {})) {
    for (const r of nodeRefsOf(nodeOf(doc, id))) if (r.scale === scale) out.push({ id, ...r });
  }
  return out;
}

/** Ссылки в полях одного узла — перечень §6.2 (копия смысла core.nodeScaleRefs). */
function nodeRefsOf(node) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  const take = (path, v, scale) => { const ref = parseRef(v); if (ref) out.push({ path, ref: ref.ref, index: ref.index, scale, want: scale }); };
  const l = node.layout;
  if (l && typeof l === 'object') {
    take('layout.gap', l.gap, 'spacing');
    const p = l.padding;
    if (p && typeof p === 'object' && !Array.isArray(p)) for (const k of ['t', 'r', 'b', 'l']) take(`layout.padding.${k}`, p[k], 'spacing');
  }
  if (Array.isArray(node.radius)) node.radius.forEach((v, i) => take(`radius.${i}`, v, 'radii'));
  else take('radius', node.radius, 'radii');
  return out;
}

/** Мёртвые ссылки узла: шаг, которого нет, или ссылка не в ту шкалу. */
function deadRefsOf(doc, node, engine) {
  return nodeRefsOf(node).filter((r) => scaleNum(doc, r.ref, r.want, engine) === undefined);
}

/**
 * Значение отступа или скругления В ВЫЖИМКЕ (§6.6): «spacing.6(16)» — ссылка и число, чтобы
 * модель могла и рассуждать о пикселях, и отвечать ссылкой; число мимо шкалы — с пометкой;
 * число, равное шагу, — голым числом (мозг всё равно превратит его в ссылку при записи).
 */
function scaleWord(doc, v, scale, engine) {
  if (v == null) return '0';
  if (typeof v === 'number') {
    if (!stepsOf(doc, scale, engine).length || stepIndexOf(doc, scale, v, engine) >= 0) return String(v);
    return `${v}(мимо шкалы)`;
  }
  const ref = parseRef(v);
  if (!ref) return wordOf(v);
  const n = scaleNum(doc, ref.ref, scale, engine);
  return n === undefined ? `${ref.ref}(нет такого шага)` : `${ref.ref}(${n})`;
}

/**
 * Значение отступа или скругления СЛОВАМИ ЧЕЛОВЕКА (§6.7): «16 px (шаг шкалы)», «24 px (мимо
 * шкалы)». Ни spacing, ни radii здесь быть не должно — человек шкалу знать не обязан.
 */
function scaleValueWords(doc, v, scale, engine) {
  if (typeof v === 'number') {
    const steps = stepsOf(doc, scale, engine);
    return `${v} px${steps.length && stepIndexOf(doc, scale, v, engine) < 0 ? ' (мимо шкалы)' : ''}`;
  }
  const ref = parseRef(v);
  if (!ref) return `«${String(v)}»`;
  const n = scaleNum(doc, ref.ref, scale, engine);
  return n === undefined ? `шаг ${SCALE_RU[scale].gen}, которого нет` : `${n} px (шаг шкалы)`;
}

/**
 * Значение отступа или скругления ИЗ ОТВЕТА МОДЕЛИ → то, что ляжет в документ (§6.6).
 *
 *   • ссылка → проверяем шкалу и живость шага (scaleSteps) и пропускаем КАК ЕСТЬ;
 *   • число, точно равное шагу, → ссылка на этот шаг: продукт живёт на шкале, а число
 *     «16» и «spacing.6» при равном значении — одно и то же намерение;
 *   • число МИМО шкалы: если это число назвал сам человек (оно есть в его реплике) —
 *     оставляем числом и говорим об этом; если число придумала модель — берём ближайший
 *     шаг шкалы и тоже говорим. Почему так, а не «всегда как есть» и не «всегда к шагу»:
 *     человек, сказавший «зазор 24», должен получить 24 — иначе агент подменяет просьбу;
 *     а модель, приславшая 24 на «просторнее» (16 + 8 пикселей вместо шага вверх), нарушила
 *     правило промпта, и пропустить это число значит впустить в документ значение мимо
 *     системы, ради которой всё и делается. Равное расстояние до двух шагов — не решаем за
 *     человека: оставляем число и называем оба шага. Ноль — «без отступа», а не число мимо
 *     шкалы: к ближайшему шагу не тянется и не обсуждается.
 * @param {*} raw значение от модели (строка, число, объект {value})
 * @param {'spacing'|'radii'} scale шкала этого поля
 * @param {object} doc
 * @param {Function} note куда говорить словами
 * @param {string} what как назвать поле в строке для человека («Правка «зазор»»)
 * @param {{engine?:object, said?:string, quiet?:boolean}} [opts] quiet — значение наше
 *   (умолчание характера), а не модели: без разговоров, число мимо шкалы остаётся числом
 * @returns {number|string|undefined} undefined — значение не годится (о причине сказано)
 */
function scaleValue(raw, scale, doc, note, what, opts = {}) {
  const say = opts.quiet ? () => {} : (note || (() => {}));
  const engine = opts.engine || null;
  const names = SCALE_RU[scale] || SCALE_RU.spacing;
  const steps = stepsOf(doc, scale, engine);
  const bare = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.value !== undefined ? raw.value : raw;
  const ref = parseRef(bare);
  if (ref) {
    if (ref.scale !== scale) {
      say(`${what}: «${String(bare).trim()}» — это ссылка на ${SCALE_RU[ref.scale].acc}, а здесь нужна ${names.nom};`
        + ' правка пропущена');
      return undefined;
    }
    if (!steps.length) {
      say(`${what}: в документе нет ${names.gen}, ссылаться не на что — скажите число; правка пропущена`);
      return undefined;
    }
    if (typeof steps[ref.index] !== 'number') {
      say(`${what}: шага номер ${ref.index} в ${names.loc} нет — в ней ${steps.length}`
        + ` ${plural(steps.length, 'шаг', 'шага', 'шагов')} (номера 0…${steps.length - 1}); правка пропущена`);
      return undefined;
    }
    return ref.ref;
  }
  const n = clampPx(bare, opts.quiet ? null : note, what);
  if (n == null) return undefined;
  if (!steps.length) return n;
  const exact = stepIndexOf(doc, scale, n, engine);
  if (exact >= 0) return `${scale}.${exact}`;
  // ноль — это «без отступа», а не число мимо шкалы: к ближайшему шагу его не тянем и не обсуждаем
  if (n === 0) return 0;
  const { below, above } = nearestSteps(steps, n);
  if (opts.quiet) return n;
  const near = [below && below.v, above && above.v].filter((x) => x != null);
  const nearWords = near.length === 2 ? `ближайшие шаги ${near[0]} и ${near[1]}` : near.length ? `ближайший шаг ${near[0]}` : 'шагов рядом нет';
  const named = saidNumber(opts.said, n);
  const tie = below && above && (n - below.v) === (above.v - n);
  if (named || tie || !near.length) {
    say(`${what}: ${n} — мимо ${names.gen} (${nearWords}). Оставил ${n}${named ? ', как просили' : ''}`
      + (tie ? '; скажите, к какому шагу привести' : ''));
    return n;
  }
  const pick = !below ? above : !above ? below : (n - below.v) < (above.v - n) ? below : above;
  say(`${what}: ${n} — мимо ${names.gen}, взял ближайший шаг ${pick.v}. Скажите «ровно ${n}», если нужно именно это число`);
  return `${scale}.${pick.i}`;
}

/** Назвал ли человек это число сам: «зазор 24», «отступ 12,5». */
function saidNumber(said, n) {
  const s = String(said == null ? '' : said);
  if (!s) return false;
  const nums = s.match(/\d+(?:[.,]\d+)?/g) || [];
  return nums.some((x) => Number(x.replace(',', '.')) === n);
}

/** С прописной: «шкала отступов» → «Шкала отступов» — для начала предложения. */
const cap = (s) => { const t = String(s == null ? '' : s); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Склонение по числу: plural(3, 'шаг', 'шага', 'шагов') → 'шага'. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Наше собственное число (умолчание характера) → ссылка, если оно ровно на шаге; иначе число. */
function onScale(doc, n, scale, engine) {
  const i = stepIndexOf(doc, scale, n, engine);
  return i >= 0 ? `${scale}.${i}` : n;
}

/** Отступы {t,r,b,l} нашими числами → ссылки там, где число ровно на шаге. */
function paddingOnScale(doc, pad, engine) {
  const out = {};
  for (const k of ['t', 'r', 'b', 'l']) out[k] = onScale(doc, pad[k], 'spacing', engine);
  return out;
}

/**
 * Шкалы для промпта (§6.6): один раз, в шапке, с номерами шагов —
 * «spacing: 0=0 1=2 2=4 … 12=64». Пусто, если шкал в документе нет.
 */
function scaleLines(doc, engine) {
  const out = [];
  for (const scale of ['spacing', 'radii']) {
    const steps = stepsOf(doc, scale, engine);
    if (!steps.length) continue;
    out.push(`${scale} (номер шага=значение px): ${steps.map((v, i) => `${i}=${wordOf(v)}`).join(' ')}`);
  }
  return out;
}

/**
 * Правила шкал для промпта (§6.6). Уходят ТОЛЬКО когда шкалы в документе есть: обещать
 * модели ссылки на шаги, которых нет, значит получить ссылку в никуда.
 * @param {{spacing:number[], radii:number[]}} scales шаги шкал документа
 * @param {'tree'|'patch'|'plan'|'theme'} role
 */
function scaleRules(scales, role) {
  if (!scales || (!scales.spacing.length && !scales.radii.length)) return '';
  const ex = (scale, i) => {
    const steps = scales[scale];
    if (!steps.length) return null;
    const at = Math.min(i, steps.length - 1);
    return `"${scale}.${at}" (сейчас ${steps[at]} px)`;
  };
  const gapEx = ex('spacing', 6);
  const radEx = ex('radii', 4);
  const upDown = scales.spacing.length > 7
    ? ` (spacing.6 → spacing.5 — плотнее, spacing.6 → spacing.7 — просторнее)` : '';
  if (role === 'plan') {
    return `ШКАЛЫ ОТСТУПОВ И СКРУГЛЕНИЙ
- «Сделай шкалу отступов (скруглений) просторнее/плотнее» — это theme: меняются значения шагов ШКАЛЫ, разом на всех досках.
- «Сделай карточку плотнее/просторнее» — это edit: у её отступов берётся шаг шкалы ниже/выше.`;
  }
  if (role === 'theme') {
    const lens = ['spacing', 'radii'].filter((s) => scales[s].length).map((s) => `${s} — ${scales[s].length}`).join(', ');
    return `ШКАЛЫ ОТСТУПОВ И СКРУГЛЕНИЙ
- Узлы ссылаются на шаги шкал ПО НОМЕРУ («spacing.6» — шестой шаг), поэтому меняй ЗНАЧЕНИЯ шагов, а не
  их число: верни массив ТОЙ ЖЕ ДЛИНЫ (шагов сейчас: ${lens}), возрастающий. Шкала короче сломает
  ссылки — такая правка будет отброшена; длиннее — добавит шаги, на которые пока никто не ссылается.
- «Сделай шкалу отступов просторнее/плотнее» — умножь или ужми значения шагов (например, ×1,25 или ×0,8),
  сохранив порядок и число шагов. Узлы менять не нужно и нельзя: они переверстаются сами.`;
  }
  const lines = [
    'ШКАЛЫ ОТСТУПОВ И СКРУГЛЕНИЙ (шаги и их значения — в «ТОКЕНЫ ДОКУМЕНТА» выше)',
    `- gap, padding и radius задавай ССЫЛКОЙ на шаг шкалы: ${[gapEx && `gap ${gapEx}`, radEx && `radius ${radEx}`].filter(Boolean).join(', ')}.`
    + ' В выжимке так и написано: gap=spacing.6(16) — ссылка и её значение в px.',
    `- «Плотнее», «компактнее», «теснее», «ближе» — шаг ВНИЗ по шкале; «просторнее», «воздушнее», «свободнее»,`
    + ` «больше воздуха» — шаг ВВЕРХ${upDown}. Не прибавляй и не отнимай пиксели. Если сейчас там число мимо`
    + ' шкалы (в выжимке помечено), возьми ближайший шаг в нужную сторону.',
    '- Число вместо ссылки — только если нужно именно значение мимо шкалы (человек назвал число, которого в'
    + ' шкале нет). Число, равное шагу, приложение само превратит в ссылку; число мимо шкалы дойдёт до человека'
    + ' с предупреждением, а число, которого человек не называл, будет приведено к ближайшему шагу.',
    '- padding: одна ссылка на все стороны ("spacing.6"), [верт, гориз] или [верх, право, низ, лево].'
    + ' В выжимке pad=A/B — это [верт, гориз], pad=A — со всех сторон; нулевые поля не печатаются.',
  ];
  if (role === 'tree') {
    lines.push('- Шаги подбирай по роли: мелкие зазоры внутри строки — нижние шаги, между блоками — средние,'
      + ' поля экрана — верхние. Один и тот же шаг у одинаковых по смыслу отступов.');
  }
  return lines.join('\n');
}

/** Шкалы документа для контекста промпта (или null, если их нет). */
function scalesOf(doc, engine) {
  const spacing = stepsOf(doc, 'spacing', engine).filter((v) => typeof v === 'number');
  const radii = stepsOf(doc, 'radii', engine).filter((v) => typeof v === 'number');
  return spacing.length || radii.length ? { spacing, radii } : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6c. Микроанимации: состояния и движение (круг 36, SPEC §11)
 *
 * До этого круга модель честно отвечала «в редакторе нет анимаций»: так ей велели правила
 * промпта (DSL_RULES п.11, планировщик, правила правок, починка), и мозг отбрасывал путь
 * `states`/`shadow` как выдуманный. Теперь в документе есть состояния узла (наведение,
 * нажатие, фокус) — только визуальная надстройка, раскладку не трогает, — и движение между
 * ними. Здесь всё, что мозгу нужно о них знать: пути, значения, слова для человека.
 *
 * Длительность — ССЫЛКОЙ на ступень шкалы движения («motion.fast»), как отступы — ссылкой
 * на шаг (§6.6): число, равное ступени, становится ссылкой; число, которого человек не
 * называл, — ближайшей ступенью; названное человеком — остаётся числом.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Состояния узла (§11.1) — порядок важен: так их перечисляют выжимка и описание правки. */
export const STATE_NAMES = ['hover', 'press', 'focus'];
/** Поля состояния: только визуальное (раскладку состояние не меняет). */
export const STATE_FIELDS = ['fill', 'color', 'stroke', 'opacity', 'scale', 'lift', 'shadow'];
/** Поля движения. */
export const MOTION_FIELDS = ['duration', 'easing', 'delay', 'follow'];
/** Кривые движения (§11.1). */
export const EASINGS = ['standard', 'emphasized', 'decelerate', 'accelerate', 'linear', 'spring'];
/** Ступени шкалы движения и тени — в порядке возрастания. */
export const MOTION_STEPS = ['fast', 'base', 'slow'];
export const SHADOW_STEPS = ['sm', 'md', 'lg'];
/** Умолчания ядра (§11.1): документ без tokens.motion работает на них. */
export const MOTION_DEFAULTS = { fast: 120, base: 200, slow: 320 };
/** Микроанимация дольше этого — вязкая (валидатор: motion-slow, §11.2). */
export const MICRO_MAX_MS = 600;
const MOTION_MAX_MS = 2000;
const DELAY_MAX_MS = 1000;
const LIFT_MAX = 24;
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.2;

const MOTION_REF_RE = /^motion\.(fast|base|slow)$/;
const SHADOW_REF_RE = /^shadow\.(sm|md|lg)$/;

/** Состояния словами (как вкладки инспектора §11.3). */
export const STATE_RU = {
  hover: { nom: 'наведение', at: 'при наведении', cap: 'Наведение' },
  press: { nom: 'нажатие', at: 'при нажатии', cap: 'Нажатие' },
  focus: { nom: 'фокус', at: 'в фокусе', cap: 'Фокус' },
};
const STATE_FIELD_RU = {
  fill: 'заливка', color: 'цвет текста', stroke: 'обводка', opacity: 'непрозрачность',
  scale: 'масштаб', lift: 'подъём', shadow: 'тень',
};
const STATE_FIELD_RU_GEN = {
  fill: 'заливки', color: 'цвета текста', stroke: 'обводки', opacity: 'непрозрачности',
  scale: 'масштаба', lift: 'подъёма', shadow: 'тени',
};
const MOTION_FIELD_RU = { duration: 'скорость анимации', easing: 'характер движения', delay: 'задержка анимации', follow: 'анимация вместе с родителем' };
const MOTION_FIELD_RU_GEN = { duration: 'скорости анимации', easing: 'характера движения', delay: 'задержки анимации', follow: 'следования за родителем' };
export const SHADOW_RU = { none: 'без тени', 'shadow.sm': 'лёгкая', 'shadow.md': 'средняя', 'shadow.lg': 'сильная' };
export const EASING_RU = {
  standard: 'обычное', emphasized: 'выразительное', decelerate: 'с замедлением в конце',
  accelerate: 'с разгоном', linear: 'равномерное', spring: 'пружинистое',
};
const MOTION_STEP_RU = { fast: 'быстро', base: 'обычно', slow: 'медленно' };

/** Синонимы имён состояний: так их называют CSS и дизайнерские инструменты. */
const STATE_ALIASES = {
  hover: 'hover', hovered: 'hover', ':hover': 'hover', onhover: 'hover', mouseover: 'hover', over: 'hover',
  наведение: 'hover', ховер: 'hover',
  press: 'press', pressed: 'press', active: 'press', ':active': 'press', down: 'press', tap: 'press',
  onpress: 'press', click: 'press', нажатие: 'press',
  focus: 'focus', focused: 'focus', ':focus': 'focus', 'focus-visible': 'focus', ':focus-visible': 'focus', фокус: 'focus',
};
/** Синонимы полей состояния. */
const STATE_FIELD_ALIASES = {
  fill: 'fill', background: 'fill', bg: 'fill', backgroundcolor: 'fill', 'background-color': 'fill',
  color: 'color', textcolor: 'color', 'text-color': 'color', foreground: 'color',
  stroke: 'stroke', border: 'stroke', bordercolor: 'stroke', outline: 'stroke',
  opacity: 'opacity', alpha: 'opacity',
  scale: 'scale', zoom: 'scale', 'transform.scale': 'scale',
  lift: 'lift', translatey: 'lift', y: 'lift', raise: 'lift', elevate: 'lift', offset: 'lift', rise: 'lift',
  shadow: 'shadow', boxshadow: 'shadow', 'box-shadow': 'shadow', elevation: 'shadow', dropshadow: 'shadow',
};
/** Синонимы полей движения. */
const MOTION_FIELD_ALIASES = {
  duration: 'duration', time: 'duration', speed: 'duration', transitionduration: 'duration', ms: 'duration',
  easing: 'easing', ease: 'easing', curve: 'easing', timing: 'easing', timingfunction: 'easing',
  'timing-function': 'easing', transitiontimingfunction: 'easing',
  delay: 'delay', transitiondelay: 'delay',
  follow: 'follow', follows: 'follow', trigger: 'follow',
};
/** Головы путей, которыми модель зовёт состояния и движение по-вебовски. */
const MOTION_HEAD_ALIASES = {
  transition: 'motion', animation: 'motion', animate: 'motion', anim: 'motion', motion: 'motion',
  state: 'states', states: 'states', interactions: 'states', interaction: 'states',
  boxshadow: 'shadow', 'box-shadow': 'shadow', elevation: 'shadow', dropshadow: 'shadow', shadow: 'shadow',
  duration: 'motion.duration', transitionduration: 'motion.duration',
  easing: 'motion.easing', timingfunction: 'motion.easing', transitiontimingfunction: 'motion.easing',
  delay: 'motion.delay', transitiondelay: 'motion.delay',
};

/**
 * Путь состояний/движения от модели → путь документа: «hover.lift» → «states.hover.lift»,
 * «states.active.background» → «states.press.fill», «transition.duration» → «motion.duration»,
 * «boxShadow» → «shadow». Чужой путь возвращается как есть. Длительность внутри состояния
 * («states.hover.duration») — это движение узла: у состояния своей длительности нет.
 */
export function normalizeMotionPath(path) {
  const p = String(path == null ? '' : path).trim();
  if (!p) return p;
  const parts = p.split('.');
  const low = (s) => String(s).toLowerCase();
  let head = low(parts[0]);
  if (STATE_ALIASES[head] && parts.length <= 2) return ['states', STATE_ALIASES[head], ...parts.slice(1)].map((s, i) => (i === 2 ? (STATE_FIELD_ALIASES[low(s)] || s) : s)).join('.');
  if (MOTION_HEAD_ALIASES[head] === undefined) return p;
  head = MOTION_HEAD_ALIASES[head];
  if (head === 'shadow') return parts.length === 1 ? 'shadow' : p;
  if (head.indexOf('motion.') === 0) return parts.length === 1 ? head : p;
  if (head === 'motion') {
    if (parts.length === 1) return 'motion';
    const f = MOTION_FIELD_ALIASES[low(parts[1])];
    return f && parts.length === 2 ? `motion.${f}` : ['motion', ...parts.slice(1)].join('.');
  }
  // states
  if (parts.length === 1) return 'states';
  const st = STATE_ALIASES[low(parts[1])] || parts[1];
  if (parts.length === 2) return `states.${st}`;
  const rest = parts.slice(2).join('.');
  const lowRest = low(rest);
  if (MOTION_FIELD_ALIASES[lowRest] && !STATE_FIELD_ALIASES[lowRest]) return `motion.${MOTION_FIELD_ALIASES[lowRest]}`;
  const f = STATE_FIELD_ALIASES[lowRest] || STATE_FIELD_ALIASES[low(parts[2])] || parts[2];
  return parts.length === 3 || STATE_FIELD_ALIASES[lowRest] ? `states.${st}.${f}` : `states.${st}.${parts.slice(2).join('.')}`;
}

/**
 * Разбор пути состояний/движения. null — путь не про них.
 * {kind:'states'} | {kind:'state', state} | {kind:'stateField', state, field}
 * | {kind:'motion'} | {kind:'motionField', field} | {kind:'shadow'} | {bad: 'почему по-русски'}
 */
export function motionPathInfo(path) {
  const p = String(path == null ? '' : path);
  const parts = p.split('.');
  const head = parts[0];
  if (head === 'shadow') return parts.length === 1 ? { kind: 'shadow' } : { bad: 'тень задаётся одним значением — ступенью «мягкая», «средняя» или «сильная»' };
  if (head === 'states') {
    if (parts.length === 1) return { kind: 'states' };
    const state = parts[1];
    if (!STATE_NAMES.includes(state)) {
      return { bad: `состояния «${state}» нет — есть наведение, нажатие и фокус` };
    }
    if (parts.length === 2) return { kind: 'state', state };
    const field = parts[2];
    if (parts.length > 3 || !STATE_FIELDS.includes(field)) {
      return { bad: `в состоянии «${STATE_RU[state].nom}» нет поля «${parts.slice(2).join('.')}» — есть заливка,`
        + ' цвет текста, обводка, прозрачность, масштаб, подъём и тень; размеры и отступы состояние не меняет' };
    }
    return { kind: 'stateField', state, field };
  }
  if (head === 'motion') {
    if (parts.length === 1) return { kind: 'motion' };
    const field = parts[1];
    if (parts.length > 2 || !MOTION_FIELDS.includes(field)) {
      return { bad: `у движения нет поля «${parts.slice(1).join('.')}» — есть скорость, характер движения, задержка и следование за родителем` };
    }
    return { kind: 'motionField', field };
  }
  return null;
}

/** Путь про состояния, движение или тень? */
export function isMotionPath(path) {
  const head = String(path == null ? '' : path).split('.')[0];
  return head === 'states' || head === 'motion' || head === 'shadow';
}

/** Все пути состояний и движения — для белого списка «снять» (CLEARABLE_PATHS). */
function motionClearablePaths() {
  const out = ['states', 'motion', 'shadow'];
  for (const st of STATE_NAMES) {
    out.push(`states.${st}`);
    for (const f of STATE_FIELDS) out.push(`states.${st}.${f}`);
  }
  for (const f of MOTION_FIELDS) out.push(`motion.${f}`);
  return out;
}

/** Путь словами человека (именительный) — или null, если путь не про состояния. */
function motionPathRu(path, gen = false) {
  const info = motionPathInfo(path);
  if (!info || info.bad) return null;
  if (info.kind === 'shadow') return gen ? 'тени' : 'тень';
  if (info.kind === 'states') return gen ? 'состояний' : 'состояния';
  if (info.kind === 'state') return gen ? `состояния «${STATE_RU[info.state].nom}»` : STATE_RU[info.state].nom;
  if (info.kind === 'stateField') return `${(gen ? STATE_FIELD_RU_GEN : STATE_FIELD_RU)[info.field]} ${STATE_RU[info.state].at}`;
  if (info.kind === 'motion') return gen ? 'анимации' : 'анимация';
  if (info.kind === 'motionField') return (gen ? MOTION_FIELD_RU_GEN : MOTION_FIELD_RU)[info.field];
  return null;
}

/** Ступени шкалы движения документа (умолчания ядра — где своих нет). */
export function motionSteps(doc) {
  const own = doc && doc.tokens && doc.tokens.motion;
  const out = {};
  for (const k of MOTION_STEPS) {
    const v = own && typeof own === 'object' ? own[k] : undefined;
    out[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : MOTION_DEFAULTS[k];
  }
  return out;
}

/** Длительность → мс: число как есть, ссылка — значением ступени (мёртвая — undefined). */
export function motionMs(doc, v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const m = MOTION_REF_RE.exec(String(v == null ? '' : v).trim());
  if (!m) return undefined;
  return motionSteps(doc)[m[1]];
}

/** Длительность узла с учётом умолчания (motion.duration не задана → ступень «base»). */
function nodeMotionMs(doc, node) {
  const d = node && node.motion && typeof node.motion === 'object' ? node.motion.duration : undefined;
  const ms = d === undefined ? motionSteps(doc).base : motionMs(doc, d);
  return ms === undefined ? motionSteps(doc).base : ms;
}

/** Длительность в миллисекундах из того, как её пишут: 200, «200ms», «0.2s», «0,2 с», «200 мс». */
function parseMs(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ');
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(ms|мс|миллисекунд\p{L}*|s|с|сек\p{L}*|секунд\p{L}*)?$/u.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || '';
  return /^(s|с|сек)/u.test(unit) ? Math.round(n * 1000) : n;
}

/** Слово-ступень → ссылка: «быстро», «fast», «motion.fast» → 'motion.fast'. */
function motionRefOf(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/ё/g, 'е');
  const m = /^motion\s*[.\-_ ]\s*(fast|base|slow)(?:\s*\(\s*\d+\s*(?:ms|мс)?\s*\))?$/.exec(s);
  if (m) return `motion.${m[1]}`;
  if (/^(fast|quick|short|быстр\p{L}*|коротк\p{L}*|шустр\p{L}*)$/u.test(s)) return 'motion.fast';
  if (/^(base|normal|default|medium|regular|standard|обычн\p{L}*|средн\p{L}*|нормальн\p{L}*)$/u.test(s)) return 'motion.base';
  if (/^(slow|long|медлен\p{L}*|долг\p{L}*|неспешн\p{L}*|плавн\p{L}*)$/u.test(s)) return 'motion.slow';
  return null;
}

/** Слово-тень → ссылка: «средняя», «md», «shadow.md» → 'shadow.md'; «нет» → 'none'. */
function shadowRefOf(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/ё/g, 'е');
  if (!s) return null;
  const m = /^shadow\s*[.\-_ ]\s*(sm|md|lg|xs|xl|small|medium|large)$/.exec(s);
  const key = m ? m[1] : s;
  if (/^(none|no|нет|без\s+тени|0|off|flat|плоск\p{L}*)$/u.test(key)) return 'none';
  if (/^(sm|xs|s|small|soft|light|subtle|мягк\p{L}*|легк\p{L}*|слаб\p{L}*|маленьк\p{L}*|тонк\p{L}*|небольш\p{L}*)$/u.test(key)) return 'shadow.sm';
  if (/^(md|m|medium|base|normal|default|средн\p{L}*|обычн\p{L}*|нормальн\p{L}*)$/u.test(key)) return 'shadow.md';
  if (/^(lg|xl|l|large|strong|deep|heavy|сильн\p{L}*|глубок\p{L}*|больш\p{L}*|крупн\p{L}*|густ\p{L}*)$/u.test(key)) return 'shadow.lg';
  return null;
}

/**
 * Описание тени для шкалы теней: «dx dy blur цвет» (px можно писать или нет; цвет — #hex или
 * rgb()/rgba()) или 'none'. Через движок (core.parseShadow), иначе — зеркало его правила:
 * отвергнутое ядром значение уронило бы всю тему одной транзакцией.
 */
function shadowDescOk(v, engine) {
  if (engine && typeof engine.parseShadow === 'function') {
    try { return engine.parseShadow(v) !== null; } catch { /* зеркало ниже */ }
  }
  if (typeof v !== 'string' || v.length > 120) return false;
  const s = v.trim();
  if (s === 'none') return true;
  const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(s);
  if (!m) return false;
  const len = /^-?(\d+(\.\d+)?|\.\d+)(px)?$/;
  if (![m[1], m[2], m[3]].every((x) => len.test(x))) return false;
  const [dx, dy, blur] = [m[1], m[2], m[3]].map((x) => parseFloat(x));
  if (Math.abs(dx) > 200 || Math.abs(dy) > 200 || blur < 0 || blur > 200) return false;
  return /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+|1\.0+)\s*)?\))$/.test(m[4].trim());
}

/** Кривая движения: своё имя или очевидный синоним (о подстановке говорим). */
function easingOf(raw, note, what) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/ё/g, 'е');
  if (EASINGS.includes(s)) return s;
  const syn = /^(ease|ease-in-out|in-out|smooth|standard-curve|cubic-bezier.*|плавн\p{L}*|обычн\p{L}*)$/u.test(s) ? 'standard'
    : /^(ease-out|out|decel\p{L}*|замедл\p{L}*|тормож\p{L}*)$/u.test(s) ? 'decelerate'
      : /^(ease-in|in|accel\p{L}*|ускор\p{L}*|разгон\p{L}*)$/u.test(s) ? 'accelerate'
        : /^(linear|линейн\p{L}*|равномерн\p{L}*)$/u.test(s) ? 'linear'
          : /^(spring|bounce|bouncy|elastic|пружин\p{L}*|упруг\p{L}*)$/u.test(s) ? 'spring'
            : /^(emphasi[sz]ed?|expressive|выразит\p{L}*|акцентн\p{L}*)$/u.test(s) ? 'emphasized' : null;
  if (syn) {
    if (note) note(`«${String(raw)}» — так кривую движения зовут в CSS: понял как «${EASING_RU[syn]}»`);
    return syn;
  }
  if (note) {
    note(`${what}: кривой движения «${String(raw)}» нет — есть ${EASINGS.map((e) => `«${EASING_RU[e]}»`).join(', ')};`
      + ' правка пропущена');
  }
  return undefined;
}

/** Прозрачность: 0…1, «60%» и «60» — это 0.6 (общая для узла и состояния). */
function opacityValue(v, note, what) {
  const pct = typeof v === 'string' && /^-?\d+(?:[.,]\d+)?\s*%$/.test(v.trim());
  const n = pct ? Number(v.trim().replace('%', '').replace(',', '.').trim()) / 100 : Number(typeof v === 'string' ? v.replace(',', '.') : v);
  if (!Number.isFinite(n)) { note(`${what}: «${v}» — не число: правка пропущена`); return undefined; }
  if (n >= 0 && n <= 1) return n;
  if (n > 1 && n <= 100) {
    const got = Math.round(n) / 100;
    note(`${what}: ${n} понял как ${Math.round(n)}% — поставил ${got}`);
    return got;
  }
  note(`${what}: ${n} — прозрачность задаётся числом от 0 до 1: правка пропущена`);
  return undefined;
}

/** Масштаб в состоянии: 0.8…1.2; «97%» и «97» — это 0.97. */
function scaleFactor(v, note, what) {
  const s = typeof v === 'string' ? v.trim().replace(',', '.') : v;
  const pct = typeof s === 'string' && /%$/.test(s);
  let n = Number(typeof s === 'string' ? s.replace(/%$/, '').replace(/^x|x$/i, '').trim() : s);
  if (!Number.isFinite(n)) { note(`${what}: «${v}» — не число: правка пропущена`); return undefined; }
  if (pct || (n > 2 && n <= 200)) n = Math.round(n) / 100;
  if (n < SCALE_MIN || n > SCALE_MAX) {
    const got = Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
    note(`${what}: ${n} — для микроанимации слишком сильно (масштаб от ${SCALE_MIN} до ${SCALE_MAX}), поставил ${got}`);
    return got;
  }
  return Math.round(n * 1000) / 1000;
}

/**
 * Подъём: шаг шкалы отступов («spacing.1») или px от −24 до 24. Число вверх — по правилу шкал
 * (§6.6, scaleValue): на шаге — ссылка, мимо шкалы и не названо человеком — ближайший шаг.
 * Вниз (отрицательное) шкалы нет — остаётся числом.
 */
function liftValue(raw, doc, note, what, opts = {}) {
  const bare = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.value !== undefined ? raw.value : raw;
  const ref = parseRef(bare);
  if (ref) {
    const got = scaleValue(ref.ref, 'spacing', doc, note, what, opts);
    if (got === undefined) return undefined;
    const px = scaleNum(doc, got, 'spacing', opts.engine);
    if (px !== undefined && px > LIFT_MAX) {
      const steps = stepsOf(doc, 'spacing', opts.engine);
      let best = -1;
      steps.forEach((v, i) => { if (typeof v === 'number' && v <= LIFT_MAX && (best < 0 || v > steps[best])) best = i; });
      if (best < 0) { note(`${what}: подъём больше ${LIFT_MAX} px — для микроанимации слишком сильно; правка пропущена`); return undefined; }
      note(`${what}: подъём ${px} px — для микроанимации слишком сильно, взял ${steps[best]} px`);
      return `spacing.${best}`;
    }
    return got;
  }
  const px = parsePx(bare);
  if (!px) { note(`${what}: «${typeof bare === 'object' ? JSON.stringify(bare) : bare}» — не число пикселей: правка пропущена`); return undefined; }
  let n = Math.round(px.n * 100) / 100;
  if (Math.abs(n) > LIFT_MAX) {
    const got = n > 0 ? LIFT_MAX : -LIFT_MAX;
    note(`${what}: ${n} px — для микроанимации слишком сильно (сдвиг от −${LIFT_MAX} до ${LIFT_MAX} px), поставил ${got}`);
    n = got;
  }
  if (n < 0) return n;
  return scaleValue(n, 'spacing', doc, note, what, opts);
}

/**
 * Длительность: ссылка на ступень или мс 0…2000. Число на ступени → ссылка; число, названное
 * человеком, — числом; придуманное моделью — ближайшей ступенью (как шаги шкал, §6.6).
 */
function durationValue(raw, doc, note, what, opts = {}) {
  const bare = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.value !== undefined ? raw.value : raw;
  const ref = typeof bare === 'string' ? motionRefOf(bare) : null;
  if (ref) return ref;
  let n = parseMs(bare);
  if (n == null) {
    note(`${what}: «${typeof bare === 'object' ? JSON.stringify(bare) : bare}» — не длительность:`
      + ' скажите «быстро», «обычно», «медленно» или число миллисекунд; правка пропущена');
    return undefined;
  }
  if (n < 0 || n > MOTION_MAX_MS) {
    const got = n < 0 ? 0 : MOTION_MAX_MS;
    note(`${what}: ${n} мс — длительность бывает от 0 до ${MOTION_MAX_MS} мс, поставил ${got}`);
    n = got;
  }
  const steps = motionSteps(doc);
  const exact = MOTION_STEPS.find((k) => steps[k] === n);
  if (exact) return `motion.${exact}`;
  if (n === 0 || opts.quiet) return n;
  const said = String(opts.said == null ? '' : opts.said);
  const named = saidNumber(said, n) || saidNumber(said, n / 1000);
  if (named || n > MICRO_MAX_MS) {
    // больше 600 мс — уже не микроанимация; если так вышло, пусть будет видно числом (предупредим ниже)
    return n;
  }
  const near = MOTION_STEPS.reduce((best, k) => (Math.abs(steps[k] - n) < Math.abs(steps[best] - n) ? k : best), 'fast');
  note(`${what}: ${n} мс — мимо шкалы движения, взял ближайшую ступень «${MOTION_STEP_RU[near]}» (${steps[near]} мс).`
    + ` Скажите «ровно ${n} мс», если нужно именно это число`);
  return `motion.${near}`;
}

/** Задержка: мс 0…1000. */
function delayValue(raw, note, what) {
  let n = parseMs(raw);
  if (n == null) { note(`${what}: «${raw}» — не число миллисекунд: правка пропущена`); return undefined; }
  if (n < 0 || n > DELAY_MAX_MS) {
    const got = n < 0 ? 0 : DELAY_MAX_MS;
    note(`${what}: ${n} мс — задержка бывает от 0 до ${DELAY_MAX_MS} мс, поставил ${got}`);
    n = got;
  }
  return n;
}

/** Следование: 'self' | 'parent'. */
function followValue(raw, note, what) {
  if (raw === true) return 'parent';
  if (raw === false) return 'self';
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (/^(parent|group|ancestor|родител\p{L}*|предок|вместе.*|группа)$/u.test(s)) return 'parent';
  if (/^(self|own|сам\p{L}*|свое|своё)$/u.test(s)) return 'self';
  note(`${what}: «${raw}» — нужно «сам» или «вместе с родителем»; правка пропущена`);
  return undefined;
}

/** Тень: ступень или 'none'. */
function shadowValue(raw, note, what) {
  const bare = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.value !== undefined ? raw.value : raw;
  if (bare && typeof bare === 'object') {
    note(`${what}: тень задаётся ступенью — «мягкая», «средняя» или «сильная», а не размерами; правка пропущена`);
    return undefined;
  }
  const got = shadowRefOf(bare);
  if (got) return got;
  note(`${what}: тени «${bare}» нет — есть «мягкая», «средняя», «сильная» и «без тени»; правка пропущена`);
  return undefined;
}

/** Поле состояния → значение документа (или undefined с объяснением). */
function stateFieldValue(field, raw, doc, note, what, opts = {}) {
  if (field === 'fill' || field === 'color' || field === 'stroke') return normColor(raw, doc, note, what);
  if (field === 'opacity') return opacityValue(raw, note, what);
  if (field === 'scale') return scaleFactor(raw, note, what);
  if (field === 'lift') return liftValue(raw, doc, note, what, opts);
  if (field === 'shadow') return shadowValue(raw, note, what);
  return undefined;
}

/** Поле движения → значение документа. */
function motionFieldValue(field, raw, doc, note, what, opts = {}) {
  if (field === 'duration') return durationValue(raw, doc, note, what, opts);
  if (field === 'easing') return easingOf(raw, note, what);
  if (field === 'delay') return delayValue(raw, note, what);
  if (field === 'follow') return followValue(raw, note, what);
  return undefined;
}

/** Объект из строки-JSON или как есть. */
function objOf(v) {
  if (typeof v === 'string' && /^\s*\{/.test(v)) { const p = tryParse(v.trim()); if (p !== undefined) return p; }
  return v;
}

/** Состояние целиком: {fill?, color?, …}. Незнакомые поля отбрасываются со словами. */
function statePatchValue(raw, state, doc, note, opts = {}) {
  const v = objOf(raw);
  const who = `${STATE_RU[state].cap}`;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    note(`${who}: состояние задаётся набором полей (заливка, цвет текста, тень, подъём, масштаб…), а пришло «${String(raw)}»; правка пропущена`);
    return undefined;
  }
  const out = {};
  for (const [k0, val] of Object.entries(v)) {
    if (UNSAFE_KEYS.has(k0)) continue;
    const key = STATE_FIELD_ALIASES[String(k0).toLowerCase()] || k0;
    if (!STATE_FIELDS.includes(key)) {
      if (MOTION_FIELD_ALIASES[String(k0).toLowerCase()]) {
        note(`${who}: «${k0}» — это про движение слоя, а не про состояние: скорость задаётся одна на все состояния`);
      } else {
        note(`${who}: поля «${k0}» у состояния нет — состояние меняет только вид (заливку, цвет текста, обводку,`
          + ' прозрачность, масштаб, подъём, тень), а не размеры и раскладку; поле пропущено');
      }
      continue;
    }
    if (val == null || (typeof val === 'string' && !val.trim())) continue;
    const got = stateFieldValue(key, val, doc, note, `${who}, ${STATE_FIELD_RU[key]}`, opts);
    if (got !== undefined) out[key] = got;
  }
  if (!Object.keys(out).length) {
    note(`${who}: ни одного годного поля — правка пропущена`);
    return undefined;
  }
  return out;
}

/** Все состояния: {hover?, press?, focus?}. */
function statesValue(raw, doc, note, opts = {}) {
  const v = objOf(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    note(`Состояния задаются как {наведение, нажатие, фокус}, а пришло «${String(raw)}»; правка пропущена`);
    return undefined;
  }
  const out = {};
  for (const [k0, val] of Object.entries(v)) {
    if (UNSAFE_KEYS.has(k0)) continue;
    const st = STATE_ALIASES[String(k0).toLowerCase()];
    if (!st) { note(`Состояния «${k0}» нет — есть наведение, нажатие и фокус; пропущено`); continue; }
    if (val == null) continue;
    const got = statePatchValue(val, st, doc, note, opts);
    if (got) out[st] = got;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Движение целиком: {duration?, easing?, delay?, follow?}. Строка-ступень — это длительность. */
function motionValue(raw, doc, note, opts = {}) {
  let v = objOf(raw);
  if (typeof v === 'string' || typeof v === 'number') v = { duration: v };
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    note(`Движение задаётся скоростью и характером, а пришло «${String(raw)}»; правка пропущена`);
    return undefined;
  }
  const out = {};
  for (const [k0, val] of Object.entries(v)) {
    if (UNSAFE_KEYS.has(k0)) continue;
    const key = MOTION_FIELD_ALIASES[String(k0).toLowerCase()] || k0;
    if (!MOTION_FIELDS.includes(key)) { note(`У движения нет поля «${k0}» — пропущено`); continue; }
    if (val == null || (typeof val === 'string' && !val.trim())) continue;
    const got = motionFieldValue(key, val, doc, note, `Анимация, ${MOTION_FIELD_RU[key]}`, opts);
    if (got !== undefined) out[key] = got;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Значение правки по пути состояний/движения/тени (вызывается из coerceValue).
 * @returns {*} значение | undefined (пропуск, причина сказана)
 */
function motionCoerce(raw, path, doc, note, opts = {}) {
  const info = motionPathInfo(path);
  if (!info) return raw;
  if (info.bad) { note(`Правка «${path}»: ${info.bad}; правка пропущена`); return undefined; }
  const what = `Правка «${motionPathRu(path) || path}»`;
  if (info.kind === 'shadow') return shadowValue(raw, note, what);
  if (info.kind === 'states') return statesValue(raw, doc, note, opts);
  if (info.kind === 'state') return statePatchValue(raw, info.state, doc, note, opts);
  if (info.kind === 'stateField') return stateFieldValue(info.field, raw, doc, note, what, opts);
  if (info.kind === 'motion') return motionValue(raw, doc, note, opts);
  if (info.kind === 'motionField') return motionFieldValue(info.field, raw, doc, note, what, opts);
  return undefined;
}

/** Кому принадлежит поле состояния (как у одноимённого поля узла, §11.1). */
const STATE_FIELD_OWNERS = {
  fill: ['frame', 'rect', 'ellipse', 'image', 'instance'],
  stroke: ['frame', 'rect', 'ellipse', 'image', 'instance'],
  color: ['text'],
};

/**
 * Сверка пути состояний с типом цели (зовётся из adjustSetPath).
 *   • у страницы состояний и тени нет (§11.1, state-on-page) — пропуск со словами;
 *   • «цвет текста при наведении» у кнопки-фрейма → у её единственного текста, и этот
 *     текст следует за кнопкой (motion.follow = 'parent'): наводят на кнопку, а не на букву;
 *   • заливка/обводка при наведении у текста — пропуск с подсказкой про цвет текста.
 * @returns {{id, path, follow?:boolean}|null}
 */
function adjustMotionPath(doc, id, path, note) {
  const node = nodeOf(doc, id);
  if (!node) return { id, path };
  const who = nameOrId(doc, id);
  if (node.type === 'page' || id === doc.root) {
    note(`${who} — страница: у страницы нет ${motionPathRu(path, true) || 'состояний'} — правка пропущена. Назовите слой на ней`);
    return null;
  }
  const info = motionPathInfo(path);
  if (!info || info.kind !== 'stateField') return { id, path };
  const owners = STATE_FIELD_OWNERS[info.field];
  if (!owners || owners.includes(node.type)) return { id, path };
  if (info.field === 'color' && node.type !== 'text') {
    const kids = textDescendants(doc, id);
    if (kids.length === 1) {
      const kid = nodeOf(doc, kids[0]);
      note(`${who} — ${node.type === 'instance' ? 'экземпляр' : 'фрейм'}, ${motionPathRu(path, true)} у него нет:`
        + ` правка ушла в его текст «${(kid && kid.name) || kids[0]}», и он меняется вместе с ${who}`);
      return { id: kids[0], path, follow: true };
    }
    note(kids.length
      ? `Внутри ${who} текстовых слоёв — ${kids.length}, непонятно, какому задать «${motionPathRu(path)}»: правка пропущена, назовите слой`
      : `Внутри ${who} нет текста — «${motionPathRu(path)}» задать некому; правка пропущена`);
    return null;
  }
  if (node.type === 'text') {
    note(`У текста ${who} нет ${motionPathRu(path, true)} — правка пропущена. У текста при наведении меняется цвет текста`);
    return null;
  }
  note(`У ${RU_TYPE[node.type] || node.type} ${who} нет ${motionPathRu(path, true)} — правка пропущена`);
  return null;
}

/**
 * Состояние целиком у кнопки-фрейма с «цветом текста» внутри: цвет уходит её тексту
 * (states.<st>.color + follow:'parent'), остальное остаётся фрейму. Возвращает
 * {value, more:[{id, path, value}]}. Для прочих случаев — {value, more:[]}.
 */
function spreadStateColor(doc, id, path, value, note) {
  const node = nodeOf(doc, id);
  const info = motionPathInfo(path);
  if (!node || node.type === 'text' || !info || !value || typeof value !== 'object') return { value, more: [] };
  const take = (st, patch) => (patch && typeof patch === 'object' && patch.color !== undefined ? { st, color: patch.color } : null);
  const found = info.kind === 'state' ? [take(info.state, value)]
    : info.kind === 'states' ? STATE_NAMES.map((st) => take(st, value[st])) : [];
  const hits = found.filter(Boolean);
  if (!hits.length) return { value, more: [] };
  const kids = textDescendants(doc, id);
  const who = nameOrId(doc, id);
  const strip = (patch) => { const { color: _c, ...rest } = patch; return rest; };
  let rest;
  if (info.kind === 'state') rest = strip(value);
  else { rest = {}; for (const st of Object.keys(value)) { const r = strip(value[st]); if (Object.keys(r).length) rest[st] = r; } }
  if (kids.length !== 1) {
    note(kids.length
      ? `Внутри ${who} текстовых слоёв — ${kids.length}: цвет текста ${STATE_RU[hits[0].st].at} непонятно кому — эта часть пропущена, назовите слой`
      : `Внутри ${who} нет текста — цвет текста ${STATE_RU[hits[0].st].at} задать некому; эта часть пропущена`);
    return { value: Object.keys(rest).length ? rest : undefined, more: [] };
  }
  const kid = nodeOf(doc, kids[0]);
  note(`${who}: цвет текста ${STATE_RU[hits[0].st].at} ушёл в его текст «${(kid && kid.name) || kids[0]}», и он меняется вместе с ${who}`);
  return {
    value: Object.keys(rest).length ? rest : undefined,
    more: hits.map((h) => ({ id: kids[0], path: `states.${h.st}.color`, value: h.color, follow: true })),
  };
}

/** Длительность словами: «120 мс», «обычно (200 мс)». */
function durationWords(doc, v) {
  const ms = motionMs(doc, v);
  if (ms === undefined) return typeof v === 'string' && /^motion\./.test(v) ? 'ступень шкалы движения, которой нет' : `«${wordOf(v)}»`;
  return `${Math.round(ms)} мс`;
}

/** Подъём словами: «подъём 2 px», «опускание 2 px». */
function liftWords(doc, v, engine) {
  const n = scaleNum(doc, v, 'spacing', engine);
  if (n === undefined) return 'подъём на шаг шкалы, которого нет';
  return n < 0 ? `сдвиг вниз ${Math.abs(Math.round(n))} px` : `подъём ${Math.round(n * 10) / 10} px`;
}

/** Одно поле состояния словами — для описания правки: «тень средняя», «масштаб 97 %». */
function stateFieldWords(field, v, doc, engine) {
  if (field === 'lift') return liftWords(doc, v, engine);
  if (field === 'shadow') return v === 'none' ? 'без тени' : `тень ${SHADOW_RU[v] || wordOf(v)}`;
  if (field === 'scale') return `масштаб ${Math.round(Number(v) * 100)} %`;
  if (field === 'opacity') return `прозрачность ${Math.round(Number(v) * 100)} %`;
  const ref = colorRef(v);
  const color = ref ? (ref[0] === '#' ? ref : `«${ruToken('colors', ref)}»`) : `«${wordOf(v)}»`;
  return `${STATE_FIELD_RU[field]} ${color}`;
}

/** Состояние целиком словами: «подъём 2 px, тень средняя». */
function statePatchWords(patch, doc, engine) {
  if (!patch || typeof patch !== 'object') return '';
  return STATE_FIELDS.filter((f) => patch[f] !== undefined).map((f) => stateFieldWords(f, patch[f], doc, engine)).join(', ');
}

/** Движение словами: «120 мс», «200 мс, пружинистое». */
function motionWords(m, doc) {
  if (!m || typeof m !== 'object') return '';
  const bits = [];
  if (m.duration !== undefined) bits.push(durationWords(doc, m.duration));
  if (m.easing !== undefined) bits.push(EASING_RU[m.easing] || wordOf(m.easing));
  if (m.delay !== undefined) bits.push(`задержка ${Math.round(Number(m.delay) || 0)} мс`);
  if (m.follow === 'parent') bits.push('вместе с родителем');
  return bits.join(', ');
}

/** Значение по пути состояний/движения словами (для valueWords) — или null. */
function motionValueWords(v, path, doc, engine) {
  const info = motionPathInfo(path);
  if (!info || info.bad) return null;
  if (info.kind === 'shadow') return `«${SHADOW_RU[v] || wordOf(v)}»`;
  if (info.kind === 'stateField') {
    if (info.field === 'lift') { const n = scaleNum(doc, v, 'spacing', engine); return n === undefined ? '«?»' : `${n} px`; }
    if (info.field === 'shadow') return `«${SHADOW_RU[v] || wordOf(v)}»`;
    if (info.field === 'scale' || info.field === 'opacity') return `${Math.round(Number(v) * 100)} %`;
    const ref = colorRef(v);
    return ref ? (ref[0] === '#' ? ref : `«${ruToken('colors', ref)}»`) : `«${wordOf(v)}»`;
  }
  if (info.kind === 'state') return `«${statePatchWords(v, doc, engine) || 'пусто'}»`;
  if (info.kind === 'states') {
    const parts = STATE_NAMES.filter((st) => v && v[st]).map((st) => `${STATE_RU[st].nom}: ${statePatchWords(v[st], doc, engine)}`);
    return `«${parts.join('; ') || 'пусто'}»`;
  }
  if (info.kind === 'motion') return `«${motionWords(v, doc) || 'пусто'}»`;
  if (info.field === 'duration') return durationWords(doc, v);
  if (info.field === 'easing') return `«${EASING_RU[v] || wordOf(v)}»`;
  if (info.field === 'delay') return `${Math.round(Number(v) || 0)} мс`;
  if (info.field === 'follow') return v === 'parent' ? '«вместе с родителем»' : '«сам по себе»';
  return null;
}

/** Ссылка в выжимке: «spacing.1(2)», «motion.fast(120)». */
function motionDigestValue(field, v, doc, engine) {
  if (field === 'lift') return typeof v === 'number' ? String(v) : scaleWord(doc, v, 'spacing', engine);
  if (field === 'duration') {
    if (typeof v === 'number') return `${v}ms`;
    const ms = motionMs(doc, v);
    return ms === undefined ? `${wordOf(v)}(нет такой ступени)` : `${v}(${ms}ms)`;
  }
  if (field === 'fill' || field === 'color' || field === 'stroke') return refWord(v);
  return wordOf(v);
}

/**
 * Состояния и движение узла в выжимке — коротко, в той же записи, какой модель отвечает:
 * «hover{lift=spacing.1(2) shadow=shadow.md} press{scale=0.97} motion{duration=motion.fast(120ms)}».
 * Пустая строка, если у узла их нет.
 */
function motionDigest(doc, n, engine) {
  if (!n || typeof n !== 'object') return '';
  const bits = [];
  if (n.shadow !== undefined && n.shadow !== null) bits.push(`shadow=${wordOf(n.shadow)}`);
  if (typeof n.opacity === 'number' && n.opacity !== 1) bits.push(`opacity=${n.opacity}`);
  const states = n.states && typeof n.states === 'object' ? n.states : null;
  if (states) {
    for (const st of STATE_NAMES) {
      const p = states[st];
      if (!p || typeof p !== 'object') continue;
      const fields = STATE_FIELDS.filter((f) => p[f] !== undefined).map((f) => `${f}=${motionDigestValue(f, p[f], doc, engine)}`);
      if (fields.length) bits.push(`${st}{${fields.join(' ')}}`);
    }
  }
  const m = n.motion && typeof n.motion === 'object' ? n.motion : null;
  if (m) {
    const fields = MOTION_FIELDS.filter((f) => m[f] !== undefined).map((f) => `${f}=${motionDigestValue(f, m[f], doc, engine)}`);
    if (fields.length) bits.push(`motion{${fields.join(' ')}}`);
  }
  return bits.join(' ');
}

/** Есть ли у узла состояния или движение (то, что снимает «убери анимации»). */
export function hasMotion(n) {
  if (!n || typeof n !== 'object') return false;
  const states = n.states && typeof n.states === 'object' ? Object.keys(n.states).length : 0;
  const motion = n.motion && typeof n.motion === 'object' ? Object.keys(n.motion).length : 0;
  return states > 0 || motion > 0 || n.states !== undefined || n.motion !== undefined;
}

/** Строка шкал движения и тени для «ТОКЕНЫ ДОКУМЕНТА» (§11.1, умолчания ядра — если своих нет). */
function motionTokenLines(doc) {
  const t = (doc && doc.tokens) || {};
  const steps = motionSteps(doc);
  const ownMotion = t.motion && typeof t.motion === 'object';
  const ownShadow = t.shadow && typeof t.shadow === 'object';
  return [
    `motion (ступени скорости анимации, мс${ownMotion ? '' : ', умолчания'}): ${MOTION_STEPS.map((k) => `motion.${k}=${steps[k]}`).join(' ')}`,
    `shadow (ступени тени${ownShadow ? '' : ', умолчания'}): ${SHADOW_STEPS.map((k) => `shadow.${k}`).join(' ')} (и none — без тени)`,
  ];
}

/** Правила микроанимаций для промптов (§11.4). */
function motionRules(role) {
  if (role === 'plan') {
    return `СОСТОЯНИЯ И МИКРОАНИМАЦИИ (это ЕСТЬ в редакторе)
- «Оживи кнопки», «добавь микроанимации», «при наведении карточка приподнимается», «кнопка темнеет
  при нажатии», «убери анимации», «сделай анимации медленнее» — это edit: у слоёв меняются states
  (наведение/нажатие/фокус) и motion (скорость и характер перехода). Это не refuse.
- «Сделай шкалу движения медленнее во всём документе» — theme (токены motion.fast/base/slow).
- Нет и сейчас: анимации появления и исчезновения, бесконечных (циклических) анимаций, загрузчиков,
  переходов между экранами, прокрутки и параллакса — на такое refuse с объяснением, что есть только
  состояния наведения, нажатия и фокуса.`;
  }
  const lines = [
    'СОСТОЯНИЯ И МИКРОАНИМАЦИИ (это ЕСТЬ в редакторе — не отказывай)',
    '- У любого слоя, кроме страницы, есть states.hover (наведение), states.press (нажатие), states.focus (фокус).'
    + ' Состояние меняет ТОЛЬКО вид: fill, color (только у текста), stroke, opacity (0…1), scale (0.8…1.2),'
    + ' lift (подъём вверх: ссылка на шаг шкалы отступов "spacing.1"/"spacing.2" или px −24…24),'
    + ' shadow ("shadow.sm" | "shadow.md" | "shadow.lg" | "none"). Размеры, отступы и раскладку состояние не меняет.',
    '- motion — как слой переходит между состояниями: duration — ССЫЛКОЙ на ступень "motion.fast" | "motion.base" |'
    + ' "motion.slow" (значения в мс — в «ТОКЕНЫ ДОКУМЕНТА»), число мс — только если человек назвал его сам;'
    + ` easing: ${EASINGS.map((e) => `"${e}"`).join(' | ')}; delay — мс 0…1000;`
    + ' follow: "parent" — слой меняется вместе с ближайшим предком, у которого есть states (заголовок карточки при наведении на карточку).',
    `- Микроанимация короткая: fast или base. Длиннее ${MICRO_MAX_MS} мс — уже вязко, так не делай без прямой просьбы.`,
    '- Базовые поля слоя для этого: shadow (тень в покое, та же ступень) и opacity.',
  ];
  if (role === 'patch') {
    lines.push(
      '- Правка: {op:"set", target:"Кнопка оплаты", path:"states.hover.lift", value:"spacing.1"} — по одному полю,'
      + ' или целиком: path:"states.hover", value:"{\\"lift\\":\\"spacing.2\\",\\"shadow\\":\\"shadow.md\\"}";'
      + ' path:"motion.duration", value:"motion.fast".',
      '- Типовые просьбы:'
      + '\n  «оживи кнопки», «добавь микроанимации» → наведение: lift "spacing.1" или "spacing.2", shadow "shadow.md";'
      + ' нажатие: scale "0.97", shadow "shadow.sm"; motion.duration "motion.fast", easing "standard";'
      + '\n  «при наведении карточка приподнимается» → states.hover.lift "spacing.2" и states.hover.shadow "shadow.md" у карточки, motion.duration "motion.base";'
      + '\n  «кнопка темнеет при нажатии» → states.press.fill — более тёмный цвет (токен вроде accentInk или #rrggbb);'
      + '\n  «текст кнопки светлеет при наведении» → states.hover.color у ТЕКСТА кнопки и его motion.follow "parent";'
      + '\n  «сделай анимации медленнее» → motion.duration на ступень выше (fast → base → slow), «быстрее» — ниже;'
      + '\n  «убери анимации» → {op:"set", path:"states", value:"none"} и {op:"set", path:"motion", value:"none"};'
      + ' «убери подъём при наведении» → path:"states.hover.lift", value:"none".',
      '- «Для всех кнопок», «у каждой карточки» — отдельная правка на каждый слой, либо target — общее имя'
      + ' или роль (кнопка, карточка): приложение раздаст правку всем однотипным слоям.',
    );
  }
  if (role === 'tree') {
    lines.push('- В дереве у узла можно указать states и motion той же формы: кнопкам — наведение и нажатие, если'
      + ' просят «живой» интерфейс; без просьбы не добавляй.');
  }
  return lines.join('\n');
}

/** «Убери анимации», «сними все микроанимации», «отключи эффекты наведения» — локально, без модели. */
const RE_MOTION_CLEAR = new RegExp(
  '^(?:пожалуйста\\s+)?(?:убери(?:те)?|убрать|сними(?:те)?|снять|удали(?:те)?|удалить|выключи(?:те)?|выключить|отключи(?:те)?|отключить|сотри|стереть)'
  + '\\s+(?:(?:все|всё|вообще)\\s+)?(?:(?:эти|любые|лишние)\\s+)?'
  + '(?:(?:микро)?анимаци\\p{L}*|(?:микро)?-анимаци\\p{L}*|состояни\\p{L}*(?:\\s+(?:наведения|нажатия|фокуса))?|эффект\\p{L}*\\s+(?:наведения|нажатия)|ховер\\p{L}*|hover\\p{L}*|переход\\p{L}*\\s+состояний)'
  + '(?:\\s+(везде|во\\s+вс[её]м\\s+документе|по\\s+всему\\s+документу|на\\s+всех\\s+(?:экранах|досках)|(?:на|в)\\s+(?:этом|текущем)\\s+(?:экране|доске|макете)|здесь|тут|у\\s+выделенн\\p{L}*))?'
  + '\\s*[.!]*$', 'iu');

/**
 * «Убери анимации» распознаётся без модели (как «сделай компонентом», круг 19): что делать —
 * сказано в самой фразе, с чем — показано выделением или активной доской. «везде» — весь документ.
 * @returns {{where:'scope'|'document'}|null}
 */
export function recognizeMotionClear(utterance) {
  const s = String(utterance == null ? '' : utterance).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const m = RE_MOTION_CLEAR.exec(s);
  if (!m) return null;
  const tail = m[1] || '';
  return { where: /везде|вс[её]м|всех/.test(tail) ? 'document' : 'scope' };
}

/**
 * Просьба про микроанимации (для классификатора и для защиты от устаревшего отказа модели):
 * «оживи кнопки», «добавь микроанимации», «при наведении карточка приподнимается»,
 * «кнопка темнеет при нажатии», «сделай анимации медленнее».
 */
const RE_MICRO_ASK = rx('(микро-?анимаци|анимаци|наведени|навед(у|ешь|ёшь)|ховер|hover|нажати|при\\s+клике|оживи|ожив(ить|ляй)|приподнима(ется|лась|лся|ются|ть\\s+при)|подним(ается|алась|ался|аются)|приподнят|состояни\\p{L}*\\s+(кнопк|карточ|наведен|нажати)|отклик\\p{L}*\\s+на\\s+(навед|нажат|клик)|фокус\\p{L}*\\s+(кнопк|пол)|transition|переход\\p{L}*\\s+(цвета|состояни|при))');
/** Чего и сейчас нет (§11): появление, циклы, загрузчики, переходы между экранами, скролл. */
const RE_MOTION_UNSUPPORTED = rx('(появлени|исчезновени|въезжа|выезжа|бесконечн|циклическ|зациклен|loop|загрузк\\p{L}*|спиннер|лоадер|loader|крутит|вращени|вращает|пульсир|мигает|мигани|переход\\p{L}*\\s+(между|на\\s+друг|к\\s+друг)\\s*(экран|доск|страниц)?|между\\s+экранами|параллакс|прокрутк|скролл|scroll|lottie|гифк|видео)');

/** Просьба о микроанимации, которую модель документа умеет (§11). */
export function looksMicroAnimation(utterance) {
  const s = String(utterance == null ? '' : utterance);
  return RE_MICRO_ASK.test(s) && !RE_MOTION_UNSUPPORTED.test(s);
}

/** Отказ модели — устаревший «в редакторе нет анимаций / состояний / тени»? */
function staleMotionRefusal(text) {
  return /анимац|наведени|ховер|hover|состояни|переход|тен[иья]|shadow|transition|нажати/iu.test(String(text == null ? '' : text));
}

const sizeWord = (spec) => {
  if (!spec || typeof spec !== 'object') return '?';
  if (spec.mode === 'fixed') return wordOf(spec.value);
  return strOf(spec.mode) || '?';
};

/** Бюджет выжимки: 20 000 знаков при 60 000 знаков бюджета всего запроса (п.3). */
export const DIGEST_LIMIT = 20000;

/** Пометки области работы на строках выжимки (круг 2, п.1). */
const MARK_SELECTED = '◀ ВЫДЕЛЕНО';
const MARK_ACTIVE = '◀ АКТИВНЫЙ АРТБОРД';
const MARK_BOTH = '◀ АКТИВНЫЙ АРТБОРД, РАБОТАЕМ ЗДЕСЬ';
/** Место под строку «… ещё N узл(ов) скрыто», если сворачивать уже нечего. */
const TAIL_RESERVE = 80;

/** Пояснение формата строки выжимки для модели (п.2 и круг 2, п.1). */
export const DIGEST_LEGEND = [
  'Ниже — ВЕСЬ документ: все доски и все их узлы (вложенность передана отступом).',
  'Формат строки: #id тип "имя" [раскладка] [w=/h= — ЗАДАННЫЕ спеки размера] → ширина×высота @x,y',
  '«→ 350×52 @20,742» — ПОСЧИТАННЫЙ решателем прямоугольник: это результат раскладки, а не то, что нужно задавать.',
  'x,y здесь — АБСОЛЮТНЫЕ координаты холста (общие для всех досок), а НЕ смещение внутри родителя.',
  'Задать их правкой нельзя. Чтобы подвинуть узел, используй op:"nudge" со смещением dx/dy от текущего места.',
  'Опирайся на этот прямоугольник, когда просят «на 20 пикселей шире», «почему тесно», «выровняй по правому краю».',
  // круг 11, п.8: пометка override в строках была, а в легенде — нет; агент не понимал, что узел
  // отцеплен от раскладки и что ручной сдвиг человека надо уважать
  'Пометка «override» на строке означает, что человек ВРУЧНУЮ сдвинул этот узел с места, которое'
  + ' посчитала раскладка, и документ этот сдвиг хранит. Сдвиг сделан человеком: не отменяй его без'
  + ' просьбы и не «выравнивай обратно». Правь у такого узла что угодно другое, а подвинуть его можно'
  + ' только op:"nudge" — смещением ОТ нынешнего места.',
  `Пометки области работы: «${MARK_SELECTED}» — выделенный человеком узел, «${MARK_ACTIVE}» — экран, который человек сейчас видит.`,
  'Последняя строка «РАБОТАЕМ С:» говорит, куда вносить правку по умолчанию. Остальные доски даны для справки:',
  'по ним можно СРАВНИВАТЬ и с них можно КОПИРОВАТЬ («как в сводке недели», «шапка со второго экрана»), но менять их без просьбы нельзя.',
].join('\n');

/**
 * Круг 20 (SPEC §6.6): как читать отступы и скругления в строках выжимки. Отдельной строкой,
 * а не внутри DIGEST_LEGEND: она уходит только документам со шкалами.
 */
export const SCALE_LEGEND = 'Отступы и скругления: «gap=spacing.6(16)» — ссылка на шаг шкалы отступов и её значение в px;'
  + ' «r=radii.4(16)» — то же для шкалы скруглений; «pad=A/B» — поля [верт, гориз], «pad=A» — со всех сторон,'
  + ' нулевые поля не печатаются. Голое число с пометкой «(мимо шкалы)» задано числом, не шагом.'
  + ' Новые значения задавай ссылкой на шаг — шкалы с номерами шагов даны в «ТОКЕНЫ ДОКУМЕНТА».';

/** Круг 36 (SPEC §11): как читать состояния и движение в строках выжимки. */
export const MOTION_LEGEND = 'Состояния: «hover{lift=spacing.1(2) shadow=shadow.md}» — как слой выглядит при наведении'
  + ' (press — при нажатии, focus — в фокусе), поля — только вид; «motion{duration=motion.fast(120ms)}» —'
  + ' скорость и характер перехода; «shadow=…» и «opacity=…» без скобок — тень и прозрачность в покое.';

/** Геометрия бывает {rects,…} (core.solve) или плоской картой id → прямоугольник. */
function rectsOf(geo) {
  if (!geo || typeof geo !== 'object') return null;
  if (geo.rects && typeof geo.rects === 'object') return geo.rects;
  const first = Object.values(geo)[0];
  return first && typeof first === 'object' && 'w' in first ? geo : null;
}

const rnd = (v) => Math.round(numOf(v) || 0);

/** Подпись «такой же узел»: тип, имя без цифр, стиль, раскладка и форма детей. */
function repeatSignature(doc, id, depth = 0) {
  const n = nodeOf(doc, id);
  if (!n) return '';
  /* Круг 19: у экземпляра «такой же» — это ТОТ ЖЕ компонент и ТЕ ЖЕ свойства. Имя и дети
   * у экземпляров пустые, и по общему правилу три разные метки схлопывались бы в «ещё 2
   * таких же» вместе со своими текстами — то есть содержимое досок пропадало бы из выжимки. */
  if (n.type === 'instance') return `instance|${strOf(n.of)}|${JSON.stringify(n.props || {})}`;
  const name = strOf(n.name).replace(/\d+/g, '#').trim().toLowerCase();
  const bits = [strOf(n.type), name, typeof n.style === 'string' ? n.style : '', n.layout ? strOf(n.layout.mode) : '', kidsOf(n).length];
  if (depth < 2) bits.push(kidsOf(n).map((k) => repeatSignature(doc, k, depth + 1)).join('~'));
  return bits.join('|');
}

/** Значение вида {token:'body'} печатаем как body — в таком же виде его и ждут обратно. */
function refWord(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const t = v.token || v.name || v.color || v.value;
    if (typeof t === 'string') return t;
  }
  return JSON.stringify(v);
}

/** Одна строка выжимки по узлу. */
function digestLine(doc, id, depth, rects, engine) {
  const n = nodeOf(doc, id);
  const pad = '  '.repeat(depth);
  /**
   * Круг 19, п.1 (SPEC §5.9): экземпляр — ОДНА строка, без внутренностей. Их и нет в
   * документе: содержимое экземпляра раскрывает решатель, а doc.nodes хранит ссылку на
   * мастер и объявленные свойства. Это и есть главное усыхание выжимки — и заодно
   * честность: адресовать внутренности экземпляра модель не может, так что печатать их
   * значило бы предлагать цели, которых нет.
   */
  if (n.type === 'instance') {
    const one = [`${pad}#${id} экземпляр ${instanceWords(doc, engine, n)}`];
    // оси размера необязательны по отдельности (§5.5): незаданную экземпляр берёт у мастера
    if (n.size && n.size.w) one.push(`w=${sizeWord(n.size.w)}`);
    if (n.size && n.size.h) one.push(`h=${sizeWord(n.size.h)}`);
    { const mo = motionDigest(doc, n, engine); if (mo) one.push(mo); }
    if (n.override) one.push('override');
    const own = rects && rects[id];
    if (own && Number.isFinite(Number(own.w))) one.push(`→ ${rnd(own.w)}×${rnd(own.h)} @${rnd(own.x)},${rnd(own.y)}`);
    return one.join(' ');
  }
  const bits = [`${pad}#${id} ${strOf(n.type) || '?'}`];
  if (strOf(n.name)) bits.push(`"${n.name}"`);
  if (n.type === 'frame' && n.layout) {
    /**
     * Круг 20 (SPEC §6.6): отступы печатаются и ссылкой, и числом — «gap=spacing.6(16)». Поля —
     * в краткой записи, которую модель уже знает по DSL: одно значение, если все стороны равны,
     * [верт, гориз], если равны попарно, иначе все четыре; нулевые поля не печатаются вовсе
     * (это умолчание раскладки). Так ссылки с их номерами не раздувают выжимку: замер на демо —
     * 9 214 знаков числами в круге 19, 9 575 с ссылками здесь (+3,9 %).
     */
    const sw = (v) => scaleWord(doc, v == null ? 0 : v, 'spacing', engine);
    bits.push(n.layout.mode === 'none' ? 'free' : `${strOf(n.layout.mode) || '?'} gap=${sw(n.layout.gap)}`);
    const p = n.layout.padding;
    if (p && typeof p === 'object') {
      const px = (v) => scaleNum(doc, v == null ? 0 : v, 'spacing', engine);
      const sides = ['t', 'r', 'b', 'l'].map((k) => p[k]);
      const zero = sides.every((v) => px(v) === 0);
      if (!zero) {
        const same = (a, b) => a === b || (a == null && b == null);
        if (sides.every((v) => same(v, sides[0]))) bits.push(`pad=${sw(sides[0])}`);
        else if (same(p.t, p.b) && same(p.r, p.l)) bits.push(`pad=${sw(p.t)}/${sw(p.r)}`);
        else bits.push(`pad=${sides.map(sw).join('/')}`);
      }
    }
    if (n.layout.align && n.layout.align !== 'start') bits.push(`align=${wordOf(n.layout.align)}`);
    if (n.layout.justify && n.layout.justify !== 'start') bits.push(`justify=${wordOf(n.layout.justify)}`);
    if (n.layout.wrap) bits.push('wrap');
  }
  if (n.size) bits.push(`w=${sizeWord(n.size.w)} h=${sizeWord(n.size.h)}`);
  if (n.type === 'text') {
    const chars = (typeof n.characters === 'number' ? wordOf(n.characters) : strOf(n.characters)).replace(/\s+/g, ' ').trim();
    bits.push(`text="${chars.length > 60 ? cutText(chars, 57) + '…' : chars}"`);
    if (n.style) bits.push(`style=${refWord(n.style)}`);
    if (n.align && n.align !== 'left') bits.push(`align=${wordOf(n.align)}`);
    if (n.color) bits.push(`color=${refWord(n.color)}`);
  }
  if (n.fill) bits.push(`fill=${refWord(n.fill)}`);
  if (n.stroke) bits.push(`stroke=${refWord(n.stroke)}`);
  /* Круг 20: скругление — «r=radii.4(16)»; нулевое (числом или ссылкой на нулевой шаг) не
   * печатается, как и раньше не печатался ноль. Мёртвая ссылка печатается с пометкой. */
  if (n.radius != null && n.radius !== 0 && !Array.isArray(n.radius)) {
    const rv = scaleNum(doc, n.radius, 'radii', engine);
    if (rv !== 0) bits.push(`r=${scaleWord(doc, n.radius, 'radii', engine)}`);
  }
  /* Круг 36 (SPEC §11): состояния и движение — коротко и ссылками, как модель их и пишет:
   * «hover{lift=spacing.1(2) shadow=shadow.md} motion{duration=motion.fast(120ms)}». */
  { const mo = motionDigest(doc, n, engine); if (mo) bits.push(mo); }
  if (n.override) bits.push('override');
  const rect = rects && rects[id];
  if (rect && Number.isFinite(Number(rect.w))) {
    bits.push(`→ ${rnd(rect.w)}×${rnd(rect.h)} @${rnd(rect.x)},${rnd(rect.y)}`);
  } else if (n.pos && isArtboardLocal(engine, doc, id)) {
    bits.push(`@${rnd(n.pos.x)},${rnd(n.pos.y)}`);
  }
  return bits.join(' ');
}

/** Артборд, внутри которого лежит узел (прямой ребёнок корня). */
function artboardOf(doc, id) {
  let cur = nodeOf(doc, id) ? id : null;
  while (cur) {
    const n = nodeOf(doc, cur);
    if (!n || n.parent == null) return null;
    if (n.parent === doc.root) return cur;
    cur = n.parent;
  }
  return null;
}

/**
 * Строка «РАБОТАЕМ С: …» — куда вносить правку по умолчанию (круг 2, п.1).
 * brief — краткая форма для крошечного бюджета: без пояснений, только адрес области.
 */
function workAreaLine(doc, work, activeArtboard, kind, brief = false, lib = null) {
  const nameOf = (id) => {
    const n = nodeOf(doc, id);
    return `#${id} «${(n && strOf(n.name)) || id}»`;
  };
  /**
   * Круг 19, п.6: человек выделил МАСТЕРА в библиотеке — значит, речь о компоненте целиком,
   * и «сделай крупнее» тут означает «во всех экземплярах». Сказать это модели обязательно:
   * иначе она видит выделение, которого нет ни в одной строке выжимки (узлы библиотеки в
   * выжимку не идут), и начинает искать похожий узел на досках.
   */
  if (lib && lib.names && lib.names.length) {
    const who = lib.names.map((x) => `«${x}»`).join(', ');
    if (brief) return `РАБОТАЕМ С: компонент ${who} из библиотеки.`;
    const tail = lib.instances
      ? ` Правка компонента меняет ВСЕ его экземпляры на досках, их ${lib.instances}.`
      : ' Экземпляров на досках у него пока нет.';
    return `РАБОТАЕМ С: компонент ${who} из библиотеки — человек выделил его, а не узел на доске.${tail}`
      + ' Правь компонент правкой op:"master" с его ИМЕНЕМ в target; доски при этом не трогай.';
  }
  const where = activeArtboard ? ` Экран на виду: ${nameOf(activeArtboard)}.` : '';
  if (!work.length || (work.length === 1 && work[0] === doc.root) || kind === 'document') {
    if (brief) return 'РАБОТАЕМ С: весь документ.';
    return 'РАБОТАЕМ С: весь документ — ничего не выделено и активного экрана нет.'
      + ' Прежде чем что-то менять, убедись, что понятно, какой именно узел имел в виду человек.';
  }
  if (kind === 'artboard' || (work.length === 1 && work[0] === activeArtboard)) {
    if (brief) return `РАБОТАЕМ С: доска ${nameOf(work[0])}.`;
    return `РАБОТАЕМ С: доска ${nameOf(work[0])} целиком — ничего не выделено.`
      + ' Правку без явного указания места вноси ВНУТРЬ него; другие доски не трогай.';
  }
  const list = work.slice(0, brief ? 3 : 8).map(nameOf).join(', ');
  const tail = work.length > (brief ? 3 : 8) ? ` и ещё ${work.length - (brief ? 3 : 8)}` : '';
  if (brief) return `РАБОТАЕМ С: ${list}${tail}.`;
  return `РАБОТАЕМ С: выделено узлов — ${work.length}: ${list}${tail}.${where}`
    + ' Правку без явного указания места вноси в них (target:"selection"); другие доски не трогай.';
}

/**
 * Структура ВСЕГО документа: id, имя, тип, текст, ЗАДАННЫЕ спеки и ПОСЧИТАННЫЙ прямоугольник (п.2).
 * Раньше описывалась только область (один артборд или один выделенный узел), и команды
 * «как в сводке недели», «шапка со второго экрана», «по ширине таблицы» были невозможны:
 * этих имён в запросе просто не было (круг 2, п.1). Теперь модель видит документ целиком,
 * а область работы размечена: пометка на строках выделенного и строка «РАБОТАЕМ С:».
 *
 * `scopeIds` — область работы (что подсветить и показать подробно), а не граница выжимки.
 * Порядок сворачивания при нехватке места: сначала поддеревья, ДАЛЬНИЕ от области работы,
 * затем однотипные повторы («ещё 6 таких же»), и только в крайнем случае обрезается хвост (п.3).
 */
export function describeDoc(doc, scopeIds, opts = {}) {
  const { limit = DIGEST_LIMIT, engine, geo, minRepeat = 3, keepRepeats = 2, scopeKind = null } = opts;
  if (!doc || !doc.nodes) return '(документ пуст)';
  const work = asArray(scopeIds).filter((id) => nodeOf(doc, id));
  // выжимка всегда от корня документа; область работы только подсвечивается
  const roots = nodeOf(doc, doc.root) ? [doc.root] : work;
  if (!roots.length) return '(область пуста)';
  const rects = rectsOf(geo) || rectsOf(engine ? safeSolve(engine, doc) : null);

  /**
   * Круг 19, п.1 (SPEC §5.9): узлы БИБЛИОТЕКИ в выжимку документа не идут вовсе. Библиотека —
   * словарь, а не часть макета: она печатается отдельным блоком ПЕРЕД документом
   * (describeLibrary), компонент адресуется по имени, и внутренности мастера модель ни назвать,
   * ни поправить точечной правкой не может (ядро убрало библиотеку из resolveTarget). Печатать
   * их значило бы предлагать цели, которых нет, — и тратить на это половину выжимки.
   */
  const libSet = libraryIds(doc, engine);
  const hidLib = (id) => libSet.has(id);
  const libWork = work.filter(hidLib);
  const boardWork = work.filter((id) => !hidLib(id));
  const libInfo = libWork.length ? libraryWorkInfo(doc, engine, libWork) : null;

  const workSet = new Set(boardWork);
  const activeArtboard = artboardOf(doc, boardWork[0]);
  let footer = workAreaLine(doc, boardWork, activeArtboard, scopeKind, false, libInfo);
  // при крошечном бюджете пояснения в строке «РАБОТАЕМ С:» съели бы всю выжимку
  if (limit - footer.length - 1 - TAIL_RESERVE < 400) footer = workAreaLine(doc, boardWork, activeArtboard, scopeKind, true, libInfo);
  // из бюджета сразу вычтены строка «РАБОТАЕМ С:» и место под итоговое «… ещё N скрыто»,
  // иначе выжимка вылезала за предел на длину этих строк
  const budget = Math.max(40, limit - footer.length - 1 - TAIL_RESERVE);

  /* Три степени важности узла.
   * pinned — строка есть в выжимке при любом размере документа: корень, САМИ артборды
   *   (без их имён «повтори шапку со второго экрана» не сформулировать), путь до области
   *   работы и сами выделенные узлы;
   * near   — область работы с потомками, предки и несколько соседей по каждому уровню пути;
   * далёкое (не near) — сворачиваем первым и агрессивнее всего. */
  const pinned = new Set(roots);
  for (const a of kidsOf(nodeOf(doc, doc.root))) {
    if (nodeOf(doc, a) && !hidLib(a)) pinned.add(a);
  }
  const near = new Set(pinned);
  const addSubtree = (id) => {
    const n = nodeOf(doc, id);
    if (!n) return;
    near.add(id);
    for (const k of kidsOf(n)) addSubtree(k);
  };
  const NEAR_SIBLINGS = 6;
  for (const id of boardWork) {
    pinned.add(id);
    addSubtree(id);
    for (const up of chainUp(doc, id)) {
      pinned.add(up);
      near.add(up);
      const parent = nodeOf(doc, (nodeOf(doc, up) || {}).parent);
      const kids = kidsOf(parent);
      const at = kids.indexOf(up);
      if (at < 0) continue;
      for (let i = Math.max(0, at - NEAR_SIBLINGS); i <= Math.min(kids.length - 1, at + NEAR_SIBLINGS); i++) near.add(kids[i]);
    }
  }

  // 1. дерево строк с посчитанной стоимостью поддерева
  const mark = (id) => {
    const sel = workSet.has(id) && id !== doc.root;
    const act = id === activeArtboard;
    if (sel && act) return ` ${MARK_BOTH}`;
    if (sel) return ` ${MARK_SELECTED}`;
    if (act) return ` ${MARK_ACTIVE}`;
    return '';
  };
  const index = new Map();
  const build = (id, depth) => {
    const text = digestLine(doc, id, depth, rects, engine) + mark(id);
    const entry = { id, depth, text, children: [], collapsed: null, cost: text.length + 1, far: !near.has(id) };
    index.set(id, entry);
    for (const kid of kidsOf(nodeOf(doc, id))) {
      if (!nodeOf(doc, kid) || hidLib(kid)) continue;
      const child = build(kid, depth + 1);
      entry.children.push(child);
      entry.cost += child.cost;
    }
    return entry;
  };
  const tops = roots.map((id) => build(id, 0));
  const markHidden = (entry) => { entry.hidden = true; entry.children.forEach(markHidden); };
  const overlaps = (entry, from, to) => (entry.collapsed || []).some((r) => from < r.to && r.from < to);

  /* Обязательные строки: корень, сами доски и выделенные узлы. Место под них бронируется,
   * иначе документ с тысячей уровней вложенности успевал израсходовать бюджет предками
   * раньше, чем доходил до второго артборда. */
  const forced = new Set([...roots, ...workSet]);
  for (const a of kidsOf(nodeOf(doc, doc.root))) { if (!hidLib(a)) forced.add(a); }

  /** Точный размер выжимки при текущем сворачивании: считаем, а не накапливаем. */
  const measure = () => {
    let sum = 0;
    const walk = (e) => {
      sum += e.text.length + 1;
      const ranges = e.collapsed || [];
      e.children.forEach((child, i) => {
        const range = ranges.find((r) => i >= r.from && i < r.to);
        if (range) { if (i === range.from) sum += range.note.length + 1; return; }
        walk(child);
      });
    };
    tops.forEach(walk);
    return sum;
  };
  let total = measure();
  /** Свернуть диапазон детей в одну строку-заметку. */
  const collapseRange = (parent, from, to, note) => {
    parent.collapsed = (parent.collapsed || []).concat([{ from, to, note }]);
    parent.children.slice(from, to).forEach(markHidden);
    total = measure();
  };
  /**
   * Свернуть ХВОСТ диапазона — ровно столько, сколько нужно, чтобы влезть в бюджет.
   * Без этого один жадный срез съедал половину документа при нехватке пары сотен знаков:
   * выжимка выходила в 6 тыс. знаков при бюджете 20 тыс.
   */
  const collapseTail = (parent, from, to, makeNote) => {
    if (parent.hidden || overlaps(parent, from, to) || to <= from) return false;
    const kids = parent.children;
    const need = total - budget;
    let at = to, acc = 0, note = '';
    while (at > from) {
      acc += kids[at - 1].cost;
      at--;
      note = makeNote(at, to);
      if (acc - note.length - 1 >= need) break;
    }
    if (at >= to || acc <= note.length) return false;     // свернуть дороже, чем оставить
    collapseRange(parent, at, to, note);
    return true;
  };

  /**
   * Подряд идущих сворачиваемых детей заменяем одной строкой, оставляя первых `keepN`
   * для имён. `eligible` решает, что вообще можно свернуть; `deepFirst` — с какого конца
   * начинать: дальнее выгоднее рубить сверху (один срез экономит максимум), а область
   * работы — снизу, чтобы подробности терялись с листьев.
   */
  const runsOf = (eligible, keepN, deepFirst) => {
    const runs = [];
    const walk = (entry) => {
      const kids = entry.children;
      const ok = (e) => !e.hidden && !pinned.has(e.id) && eligible(e);
      let i = 0;
      while (i < kids.length) {
        if (!ok(kids[i])) { walk(kids[i]); i++; continue; }
        let j = i;
        while (j < kids.length && ok(kids[j])) j++;
        if (j - i > keepN && !overlaps(entry, i + keepN, j)) {
          const group = kids.slice(i + keepN, j);
          runs.push({ parent: entry, from: i + keepN, to: j, depth: entry.depth, saves: group.reduce((sum, e) => sum + e.cost, 0) });
        }
        for (let k = i; k < Math.min(i + keepN, j); k++) walk(kids[k]);
        i = j;
      }
    };
    for (const t of tops) walk(t);
    runs.sort((a, b) => (deepFirst ? b.depth - a.depth : a.depth - b.depth) || (b.saves - a.saves));
    return runs;
  };
  const runNote = (parent, from, to, why) => {
    const hidden = parent.children.slice(from, to);
    const names = hidden.map((e) => nodeOf(doc, e.id).name || e.id);
    const inner = hidden.reduce((sum, e) => sum + e.cost, 0);
    const pad = '  '.repeat(parent.depth + 1);
    /**
     * Круг 15, п.8: обещания «спроси подробности» тут больше нет — операции «разверни поддерево»
     * в конвейере не существует, и добавлять её незачем: это был бы лишний круг к модели (на
     * локальной сборке — секунды на каждой команде), да и спросить модели некуда — схема ответа
     * не предусматривает вопроса, а отказ («cannot») читается человеком как «так нельзя».
     * Вместо обещания — правда о том, что со свёрнутыми узлами МОЖНО сделать: цель ищется по
     * ИМЕНИ во всём документе, а не только по строкам выжимки, так что свёрнутый узел вполне
     * адресуем — его надо назвать.
     */
    return `${pad}… ещё ${hidden.length} узл(ов) свёрнуто ${why}, около ${inner} знаков `
      + `(«${names[0]}» … «${names[names.length - 1]}»). Их можно назвать по имени: цель ищется `
      + 'по всему документу, а не только по этим строкам.';
  };
  const applyRuns = (eligible, keeps, deepFirst, why) => {
    for (const keepN of keeps) {
      if (total <= budget) return;
      for (const run of runsOf(eligible, keepN, deepFirst)) {
        if (total <= budget) return;
        collapseTail(run.parent, run.from, run.to, (from, to) => runNote(run.parent, from, to, why));
      }
    }
  };

  // 2. дальние от области работы поддеревья — первыми и сверху вниз (круг 2, п.1).
  //    Порог 2: у каждого дальнего родителя остаются первые два ребёнка, чтобы «шапка
  //    со второго экрана» осталась называемой даже в очень большом документе.
  applyRuns((e) => e.far, [2], false, '— далеко от области работы');

  // 3. однотипные повторы («ещё 6 таких же»): дальние прежде близких
  const candidates = [];
  const scan = (entry) => {
    const kids = entry.children;
    let i = 0;
    while (i < kids.length) {
      const sig = repeatSignature(doc, kids[i].id);
      let j = i + 1;
      while (j < kids.length && repeatSignature(doc, kids[j].id) === sig) j++;
      if (j - i >= minRepeat && j - i > keepRepeats) {
        const group = kids.slice(i + keepRepeats, j);
        candidates.push({
          parent: entry, from: i + keepRepeats, to: j, depth: entry.depth,
          far: group.every((e) => e.far),
          saves: group.reduce((s, e) => s + e.cost, 0), count: group.length,
        });
      }
      for (let k = i; k < j; k++) scan(kids[k]);
      i = j;
    }
  };
  for (const t of tops) scan(t);
  candidates.sort((a, b) => (Number(b.far) - Number(a.far)) || (b.depth - a.depth) || (b.saves - a.saves));
  const collapsedNote = (parent, from, to) => {
    const hidden = parent.children.slice(from, to);
    const names = hidden.map((e) => nodeOf(doc, e.id).name || e.id);
    const pad = '  '.repeat(parent.depth + 1);
    return `${pad}… ещё ${hidden.length} таких же узлов свёрнуто («${names[0]}» … «${names[names.length - 1]}»)`;
  };
  for (const c of candidates) {
    if (total <= budget) break;
    if (c.parent.children.slice(c.from, c.to).some((e) => e.hidden)) continue;
    collapseTail(c.parent, c.from, c.to, (from, to) => collapsedNote(c.parent, from, to));
  }

  // 4. крайний случай — сама область работы: сворачиваем с листьев, имена артбордов целы
  applyRuns(() => true, [6, 2], true, '(не хватило места)');
  // 5. совсем крайний: дальнее до нуля, потом всё до нуля
  applyRuns((e) => e.far, [0], false, '— далеко от области работы');
  applyRuns(() => true, [0], true, '(не хватило места)');

  // 6. отрисовка. Корень, артборды и сами выделенные узлы печатаются даже после того, как
  //    место кончилось (без них модель не поймёт, где что лежит), но предел не нарушают:
  //    иначе документ с тысячей уровней вложенности разносил бюджет запроса.
  const lines = [];
  const room = budget;                               // хвостовая строка и footer уже вычтены из budget
  // место под ещё не напечатанные обязательные строки держим свободным: иначе документ
  // с тысячей уровней вложенности расходовал бюджет предками раньше второго артборда
  const pending = new Map();
  for (const id of forced) if (index.has(id)) pending.set(id, index.get(id).text.length + 1);
  let reserved = [...pending.values()].reduce((a, b) => a + b, 0);
  let used = 0, stop = false, hiddenTail = 0;
  const push = (line, forceId) => {
    if (forceId != null && pending.has(forceId)) { reserved -= pending.get(forceId); pending.delete(forceId); }
    const force = forceId != null;
    if (stop && !force) { hiddenTail++; return; }
    if (used + line.length + 1 + (force ? 0 : reserved) > room) { if (!force) stop = true; hiddenTail++; return; }
    lines.push(line);
    used += line.length + 1;
  };
  const render = (entry) => {
    push(entry.text, forced.has(entry.id) ? entry.id : null);
    const ranges = entry.collapsed || [];
    entry.children.forEach((child, i) => {
      const range = ranges.find((r) => i >= r.from && i < r.to);
      if (range) {
        if (i === range.from) push(range.note);
        return;
      }
      render(child);
    });
  };
  for (const t of tops) render(t);
  if (hiddenTail) {
    const tail = `… ещё ${hiddenTail} узл(ов) скрыто (не хватило места в выжимке)`;
    if (used + tail.length + footer.length + 2 <= limit) lines.push(tail);
  }
  if (!lines.length) return '(область пуста)';
  lines.push(footer);
  return lines.join('\n');
}

/** Последние обмены с человеком — чтобы «а теперь синее» и «ещё чуть-чуть» работали (п.10).
 *  Откат («верни как было») здесь не участвует: его распознаёт recognizeAction и делает оболочка. */
export function describeHistory(history, max = 5) {
  const list = asArray(history).filter((h) => h && (h.utterance || h.summary)).slice(-max);
  if (!list.length) return '';
  return list
    .map((h, i) => `${i + 1}. «${cutText(String(h.utterance || '').trim(), 160)}» → ${cutText(String(h.summary || 'сделано').trim(), 200)}`)
    .join('\n');
}

/** Для каких намерений замечания проверки в шапке уместны (круг 3, п.5). */
const CHECKS_INTENTS = new Set(['ask', 'edit', 'theme']);

function buildContext({ doc, scope, engine, guess, persona, placement, geo, history, intent, variantHint, checks, variantsAhead = 0 }) {
  // Для правок характер варианта должен влиять и на патч, а не только на генерацию дерева (п.12).
  const personaHint = persona
    ? (intent && intent !== 'create' && persona.patchHint ? persona.patchHint : persona.hint)
    : '';
  const comps = componentList(engine, doc);
  return {
    tokens: describeTokens(doc),
    /* Круг 19, п.1 (SPEC §5.9): СЛОВАРЬ идёт перед документом. Не «ещё одна доска в выжимке»,
     * а отдельный блок: из него модель выбирает, чем собирать, и его узлов в выжимке нет. */
    comps,
    // круг 20 (SPEC §6.6): шкалы документа — правила про ссылки на шаги уходят, только когда они есть
    scales: scalesOf(doc, engine),
    library: describeLibrary(doc, engine, { selected: scope.ids }),
    // выжимка — весь документ; scope.ids задаёт лишь подсветку области работы (круг 2, п.1)
    digest: describeDoc(doc, scope.ids, { engine, geo, scopeKind: scope.kind }),
    scopeLabel: SCOPE_LABELS[scope.kind] || 'документ',
    // круг 7, п.4: при неуверенной догадке не подсказываем модели намерение — пусть решает сама
    guess: !guess ? 'нет'
      : guess.unsure ? `намерение не определено (${guess.reason}) — реши сам, что нужно: правка существующего, новый блок или переспрос`
        : `${guess.intent} (${guess.reason})`,
    personaHint,
    placement: placement || '',
    history: describeHistory(history),
    variantHint: variantHint || '',
    // круг 13, п.8: этот план — общий для нескольких вариантов, и он не должен решать за них
    variantsAhead: Number(variantsAhead) > 1 ? Number(variantsAhead) : 0,
    // «собери новый экран» замечаниями по старому макету только собьёт с толку
    checks: intent && !CHECKS_INTENTS.has(intent) ? '' : (checks || ''),
    // круг 36: как читать «hover{…} motion{…}» — только если в документе это есть
    motion: Object.keys((doc && doc.nodes) || {}).some((id) => hasMotion(nodeOf(doc, id))),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 8. Материализация: дерево и патч → операции core.ops
 * ──────────────────────────────────────────────────────────────────────────── */

const OP_ARGS = {
  create: ['node', 'index'],
  remove: ['id'],
  set: ['id', 'path', 'value'],
  move: ['id', 'parent', 'index'],
  setToken: ['path', 'value'],
};

/**
 * Сигнатура конструкторов core.ops контрактом не зафиксирована (в SPEC они записаны как
 * create{node,index?}). Поэтому пробуем позиционный вызов, сверяем результат с полезной
 * нагрузкой и, если не сошлось, повторяем объектной формой; на крайний случай собираем
 * операцию сами. Так brain.js переживает обе реализации core.ops.
 */
function mkOp(engine, name, payload) {
  const f = engine && engine.ops && engine.ops[name];
  if (typeof f !== 'function') return { op: name, ...payload };
  const tries = [() => f(...OP_ARGS[name].map((k) => payload[k])), () => f({ ...payload })];
  for (const attempt of tries) {
    let out = null;
    try { out = attempt(); } catch { out = null; }
    if (opMatches(out, name, payload)) return out;
  }
  return { op: name, ...payload };
}

function opMatches(out, name, payload) {
  if (!out || typeof out !== 'object') return false;
  if (out.op !== undefined && out.op !== name) return false;
  for (const k of OP_ARGS[name]) {
    if (payload[k] === undefined) continue;
    if (JSON.stringify(out[k]) !== JSON.stringify(payload[k])) return false;
  }
  return true;
}

/**
 * Глобально уникальный id без движка — та же форма, что у core.uid (SPEC §8.3): префикс,
 * «_», 12 случайных символов base36 и счётчик процесса. Нужен, только если подменённый
 * движок (тесты) не умеет uid.
 */
let localUidCounter = 0;
function localUid(prefix = 'n') {
  const abc = '0123456789abcdefghijklmnopqrstuvwxyz';
  localUidCounter += 1;
  let rnd = '';
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(12);
    c.getRandomValues(bytes);
    for (let i = 0; i < 12; i++) rnd += abc[bytes[i] % 36];
  } else {
    for (let i = 0; i < 12; i++) rnd += abc[Math.floor(Math.random() * 36)];
  }
  return `${prefix}_${rnd}${localUidCounter.toString(36)}`;
}

/**
 * Фабрика id новых узлов (круг 24, SPEC §10.6): id ГЛОБАЛЬНО уникальны — через `core.uid`
 * движка. Раньше здесь выдавались короткие `f1`, `t2`, уникальные лишь в документе: в
 * общем журнале (§8.3) такой id после чужого удаления мог вернуться к жизни и столкнуться с
 * отменой этого удаления, и Orchestrator переименовывал их перед записью (globalizeIds).
 * id, предложенный моделью (`id` в дереве), больше не берётся как есть — он лишь псевдоним
 * (`aliases`: как модель назвала → какой id выдан), по нему патч находит созданное.
 */
function makeIdFactory(doc, extraTaken = [], engine = null) {
  const taken = new Set(Object.keys((doc && doc.nodes) || {}));
  for (const id of extraTaken) taken.add(id);
  const prefix = { frame: 'f', text: 't', rect: 'r', ellipse: 'e', image: 'i', instance: 'i' };
  const gen = engine && typeof engine.uid === 'function' ? engine.uid : localUid;
  const aliases = new Map();
  const mint = (type) => {
    const p = prefix[type] || 'n';
    for (let i = 0; i < 100; i++) {
      const id = String(gen(p));
      if (id && !taken.has(id)) { taken.add(id); return id; }
    }
    // движок вернул занятое сто раз подряд — значит, его uid не случаен; страхуемся своим
    for (;;) {
      const id = localUid(p);
      if (!taken.has(id)) { taken.add(id); return id; }
    }
  };
  /** id от модели — только псевдоним: узел получает свежий глобальный id. */
  const adopt = (raw, type) => {
    const id = mint(type);
    const clean = String(raw == null ? '' : raw).trim().slice(0, 80);
    if (clean && !aliases.has(clean)) aliases.set(clean, id);
    return id;
  };
  return { mint, adopt, taken, aliases };
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Предел размеров и отступов у движка (core.MAX_SIZE). Зажимать надо ЗДЕСЬ, покомпонентно (п.7):
 * иначе один плохой ответ модели (padding: -12, size.w: 500000) не просто терял узел, а ронял
 * всю команду техническим «операция 0 (create): layout.padding.t вне диапазона». Для локальной
 * модели на LM Studio такой ответ — обычное дело, и человек не должен из-за него терять правку.
 */
export const MAX_PX = 100000;

/**
 * Круг 9, п.2: ЕДИНЫЙ разбор числа с единицами. Раньше их было два и они расходились:
 * sizeValue снимал «px» через rawNumber, а clampPx звал Number() — и «370px» в size.w
 * становилось 370, тогда как «8px» в radius и layout.gap превращалось в НОЛЬ («не число,
 * взял 0»), а «24px» в layout.padding — в пропущенную правку. Модель присылает единицы
 * постоянно (её этому учил весь веб), и ноль в скруглении — это видимая порча макета
 * под видом выполненной команды.
 *
 * Пиксельные единицы снимаются один к одному, относительные пересчитываются в пиксели
 * (rem/em — 16 px, как в браузере по умолчанию) и об этом говорится словами.
 * @returns {{n:number, unit:string, scaled:boolean}|null} null — числа в значении нет
 */
const PX_UNITS = /^(px|пкс|пикс(?:ел(?:ь|я|ей|ов))?|pt|dp|dip|point|поинт)$/;
const REM_UNITS = /^(rem|em|эм)$/;
export function parsePx(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v, unit: '', scaled: false } : null;
  if (v && typeof v === 'object') return parsePx(v.value);
  let s = String(v == null ? '' : v).trim().toLowerCase().replace(/ /g, ' ');
  if (!s) return null;
  // «2,5» и «12,5px» — десятичная запятая: так диктует голос и так пишут локальные модели
  /* Круг 11, п.5: запятая снималась ДО разбора и только у ГОЛОГО числа, поэтому «12,5px»
   * не совпадало с выражением вовсе и правка молча пропадала. Теперь запятая — часть числовой
   * группы, а точкой она становится уже после разбора. */
  const m = /^(-?\d+(?:[.,]\d+)?)\s*([a-zа-яё]*)$/u.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (!unit || PX_UNITS.test(unit)) return { n, unit, scaled: false };
  if (REM_UNITS.test(unit)) return { n: n * 16, unit, scaled: true };
  return null;                                     // vh, vw, %, «восемь» — это не пиксели
}

/**
 * Число → 0..MAX_PX. «-12» и «500000» превращаются в допустимое значение и об этом говорят.
 * Круг 9, п.2: значение, в котором числа НЕТ, больше не становится нулём — возвращается
 * undefined, и вызывающий пропускает правку с объяснением (как это давно делает normPadding).
 * @returns {number|undefined}
 */
/**
 * Почему значение не годится в пиксели — словами, которые можно показать человеку.
 *
 * Круг 13, п.6: тут стоял JSON.stringify, а JSON.stringify(Infinity) === 'null' — и человек
 * читал «Правка radius: «null» — не число пикселей». То же самое было у NaN и undefined:
 * служебное имя вместо объяснения.
 */
function notPxWhy(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'это вообще не число';
    return v > 0 ? 'это «бесконечность», а не размер' : 'это «минус бесконечность», а не размер';
  }
  if (v === undefined || v === null || v === '') return 'значение не передано';
  if (typeof v === 'boolean') return `«${v ? 'да' : 'нет'}» — это не число`;
  if (typeof v === 'object') {
    let j = null;
    try { j = JSON.stringify(v); } catch { j = null; }
    return `${j ? `«${j}»` : 'такое значение'} — это не число`;
  }
  return `«${String(v)}» — не число пикселей`;
}

export const clampPx = (v, note, what) => {
  const say = (m) => { if (note) note(`${what || 'Значение'}: ${m}`); };
  const got = parsePx(v);
  if (!got) {
    say(`${notPxWhy(v)}: правка пропущена, скажите значение числом`);
    return undefined;
  }
  const n = got.n;
  if (got.scaled) say(`«${v}» понял как ${Math.round(n)} px`);
  if (n < 0) { say(`${n} — отрицательного размера не бывает, взял 0`); return 0; }
  if (n > MAX_PX) { say(`${Math.round(n)} px больше холста — зажал до ${MAX_PX}`); return MAX_PX; }
  return n;
};

/**
 * п.11: src из ответа модели фильтруется НА ВХОДЕ. Экспортный SVG чистит core.safeImageSrc,
 * но в документе (и в экспортируемом JSON) значение оставалось как есть — вместе с
 * «javascript:…» или «data:text/html;…». Пропускаем только картинки.
 */
/**
 * Опасное в SVG (круг 5, п.12). В <img> скрипты из SVG браузер не выполняет, но значение
 * попадает в документ, в экспортируемый JSON и в SVG-экспорт, а оттуда — в чужие руки и в
 * инструменты, которые открывают SVG как документ. Модели незачем присылать инлайновый SVG
 * со скриптом: сам формат оставляем (иконки из ответа — законный случай), а скрипты,
 * обработчики событий, foreignObject и внешние ссылки отбрасываем.
 */
const SVG_DANGER = /<\s*script|<\s*foreignobject|<\s*use[^>]*\shref\s*=\s*["']?(?:https?:)?\/\/|\son[a-z]+\s*=|javascript:|&#x?6a/i;

/** Полезная часть data:-адреса, раскодированная настолько, насколько получилось. */
function dataPayload(v) {
  const comma = v.indexOf(',');
  if (comma < 0) return v;
  const head = v.slice(0, comma);
  const body = v.slice(comma + 1);
  if (/;base64/i.test(head)) {
    try {
      if (typeof atob === 'function') return atob(body.replace(/\s+/g, ''));
    } catch { /* не base64 — смотрим как есть */ }
    try {
      // eslint-disable-next-line no-undef
      if (typeof Buffer !== 'undefined') return Buffer.from(body, 'base64').toString('utf8');
    } catch { /* нечем раскодировать */ }
    return body;
  }
  try { return decodeURIComponent(body); } catch { return body; }
}

export function safeSrc(raw, warn, what) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return undefined;
  const ok = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml)[;,]/i.test(v) || /^https:\/\//i.test(v) || /^http:\/\//i.test(v);
  if (!ok) {
    if (warn) warn(`${what || 'Картинка'}: адрес «${cutText(v, 40)}${v.length > 40 ? '…' : ''}» не похож на картинку — пропущен`);
    return undefined;
  }
  if (/^data:image\/svg\+xml/i.test(v) && SVG_DANGER.test(dataPayload(v))) {
    if (warn) warn(`${what || 'Картинка'}: в присланном SVG есть скрипт, обработчик события или внешняя ссылка — картинка пропущена`);
    return undefined;
  }
  if (v.length > 120000) {
    if (warn) warn(`${what || 'Картинка'}: адрес длиной ${v.length} знаков слишком велик для документа — пропущен`);
    return undefined;
  }
  return v;
}

/**
 * Обиходные названия цветов (п.7). Без них «перекрась кнопку в зелёный» теряло
 * единственную правку и давало фатальное «Ни одну правку не удалось применить».
 */
export const COLOR_WORDS = {
  'чёрный': '#111111', 'черный': '#111111', black: '#111111',
  'белый': '#ffffff', white: '#ffffff',
  'серый': '#8a8f98', gray: '#8a8f98', grey: '#8a8f98',
  'красный': '#e5484d', red: '#e5484d',
  'оранжевый': '#f76b15', orange: '#f76b15',
  'жёлтый': '#f5c518', 'желтый': '#f5c518', yellow: '#f5c518',
  'зелёный': '#30a46c', 'зеленый': '#30a46c', green: '#30a46c',
  'бирюзовый': '#12a594', teal: '#12a594', turquoise: '#12a594',
  'голубой': '#3ba7e0', cyan: '#3ba7e0', lightblue: '#3ba7e0',
  'синий': '#2a6fdb', blue: '#2a6fdb',
  'фиолетовый': '#8e4ec6', purple: '#8e4ec6', violet: '#8e4ec6',
  'розовый': '#e93d82', pink: '#e93d82', magenta: '#e93d82',
  'коричневый': '#8b5e3c', brown: '#8b5e3c',
  'бежевый': '#e8ddcb', beige: '#e8ddcb',
  'прозрачный': null, transparent: null,
};

const COLOR_LIGHTEN = /^(светло|свет|бледно|light|pale)[\s-]*/u;
const COLOR_DARKEN = /^(т[её]мно|т[её]мный|тёмн|dark|deep)[\s-]*/u;

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function shadeHex(hex, k) {
  const n = hex.slice(1);
  const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  const out = rgb.map((c) => (k > 0 ? c + (255 - c) * k : c * (1 + k)));
  return '#' + out.map((c) => clamp255(c).toString(16).padStart(2, '0')).join('');
}

/** Обиходное название → #rrggbb (с учётом «светло-»/«тёмно-»). null — цвета нет. */
export function colorFromWord(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/ё/g, 'ё');
  if (!s) return null;
  let shade = 0;
  const lighten = s.match(COLOR_LIGHTEN);
  const darken = s.match(COLOR_DARKEN);
  if (lighten) { shade = 0.45; s = s.slice(lighten[0].length); }
  else if (darken) { shade = -0.4; s = s.slice(darken[0].length); }
  s = s.replace(/[\s-]+/g, '');
  if (!Object.prototype.hasOwnProperty.call(COLOR_WORDS, s)) return null;
  const base = COLOR_WORDS[s];
  if (!base) return null;
  return shade ? shadeHex(base, shade) : base;
}

function normColor(raw, doc, warn, what) {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'object') {
    const v = raw.color || raw.token || raw.value;
    return v ? normColor(v, doc, warn, what) : undefined;
  }
  const s = String(raw).trim();
  if (HEX_RE.test(s)) return (s.length === 4 ? '#' + s.slice(1).split('').map((c) => c + c).join('') : s).toLowerCase();
  const colors = (doc && doc.tokens && doc.tokens.colors) || {};
  if (Object.prototype.hasOwnProperty.call(colors, s)) return s;
  const lower = Object.keys(colors).find((k) => k.toLowerCase() === s.toLowerCase());
  if (lower) return lower;
  const word = colorFromWord(s);
  if (word) {
    // если в документе уже есть токен ровно такого цвета — лучше сослаться на него
    const sameToken = Object.keys(colors).find((k) => String(colors[k]).toLowerCase() === word);
    if (sameToken) return sameToken;
    warn(`${what}: «${s}» понят как ${word} — в токенах документа такого цвета нет`);
    return word;
  }
  warn(`${what}: неизвестный цвет «${s}» — пропущен`);
  return undefined;
}

/**
 * Круг 27: имена стилей, которых в документе нет, но смысл которых ясен — «h1», «display»,
 * «hero», «caption», «small», «mono»… Модель пишет так по привычке к вебу; раньше всё
 * незнакомое молча превращалось в «текст» (body), и «сделай заголовок крупнее» с ответом
 * `h1` ставило заголовку ОБЫЧНЫЙ текст: заголовок уменьшался, а агент рапортовал успех.
 * rank — место среди заголовочных стилей документа по кеглю (0 — крупнейший).
 */
const TYPE_ALIASES = [
  [/^(h0|h1|display\w*|hero|headline\w*|jumbo|huge|giant|x{1,3}l|[2-9]xl|large|big|bigger|title1|heading1|крупн\p{L}*|огромн\p{L}*|больш\p{L}*)$/iu, { rank: 0 }],
  [/^(h2|title\w*|heading2|header|заголов\p{L}*)$/iu, { rank: 1 }],
  [/^(h[3-6]|heading\w*|subheading|subtitle|subhead|section\w*|lead|подзаголов\p{L}*)$/iu, { rank: 2 }],
  [/^(body\w*|text|p|paragraph|regular|normal|default|base|md|medium|основн\p{L}*|текст|обычн\p{L}*)$/iu, { kind: 'body' }],
  [/^(caption\w*|small|smaller|sm|xs|tiny|footnote|note|label|meta|hint|overline|micro|fine|подпис\p{L}*|мелк\p{L}*|сноск\p{L}*)$/iu, { kind: 'small' }],
  [/^(mono\w*|code|monospace|моноширин\p{L}*)$/iu, { kind: 'mono' }],
];

/** Кегль токена типографики (или undefined). */
function typeSize(types, name) {
  const t = types && types[name];
  const n = t && typeof t === 'object' ? Number(t.fontSize) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const isMonoType = (types, name) => /mono|code/i.test(name) || /mono/i.test(String((types[name] && types[name].font) || ''));

/** Обычный текст документа: по имени, иначе — первый токен. */
function bodyTypeName(names) {
  return ['body', 'text', 'base', 'p', 'default', 'regular'].find((k) => names.includes(k)) || names[0];
}

/**
 * Незнакомое имя стиля → ближайший по смыслу токен документа (или null). Заголовочные
 * ранги берутся среди стилей КРУПНЕЕ обычного текста, по убыванию кегля: «h1» — крупнейший
 * в документе, «h2» — следующий; в документе без заголовков — крупнейший из всех.
 */
function typeAlias(types, raw) {
  const names = Object.keys(types || {});
  if (!names.length) return null;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // русское слово инспектора («крупный», «подпись») — это и есть токен
  const ru = Object.keys(TYPE_TOKEN_RU).find((k) => names.includes(k) && TYPE_TOKEN_RU[k] === s.toLowerCase());
  if (ru) return ru;
  const plain = names.filter((k) => !isMonoType(types, k));
  const bySize = (list) => list
    .filter((k) => typeSize(types, k) !== undefined)
    .sort((a, b) => typeSize(types, b) - typeSize(types, a));
  // «24px», «24» — кегль: ближайший по размеру стиль
  const px = /^\d+(?:[.,]\d+)?\s*(px|пт|pt)?$/i.test(s) ? Number(s.replace(',', '.').replace(/[^\d.]/g, '')) : NaN;
  if (Number.isFinite(px) && px > 0) {
    const sized = bySize(plain.length ? plain : names);
    if (!sized.length) return null;
    return sized.reduce((best, k) => (Math.abs(typeSize(types, k) - px) < Math.abs(typeSize(types, best) - px) ? k : best), sized[0]);
  }
  const key = s.replace(/[\s_-]+/g, '');
  const hit = TYPE_ALIASES.find(([re]) => re.test(key));
  if (!hit) return null;
  const want = hit[1];
  const body = bodyTypeName(plain.length ? plain : names);
  if (want.kind === 'body') return body || null;
  if (want.kind === 'mono') return names.find((k) => isMonoType(types, k)) || null;
  const sized = bySize(plain);
  if (!sized.length) return null;
  if (want.kind === 'small') return sized[sized.length - 1];
  const bodySize = typeSize(types, body);
  const heads = bodySize === undefined ? sized : sized.filter((k) => typeSize(types, k) > bodySize);
  const list = heads.length ? heads : [sized[0]];
  return list[Math.min(want.rank, list.length - 1)];
}

/**
 * Стиль текста из ответа модели → токен документа.
 * @param {{mode?: 'create'|'edit', cur?: any}} [opts] mode 'edit' — правка существующего узла
 *   (круг 27): незнакомый и непереводимый стиль НЕ подменяется обычным текстом — правка
 *   пропускается с объяснением (undefined), стиль узла остаётся прежним. В создании узла
 *   (mode 'create') подстановка обычного текста осталась: узлу нужен хоть какой-то стиль.
 */
function normStyle(raw, doc, warn, what, opts = {}) {
  const types = (doc && doc.tokens && doc.tokens.type) || {};
  const names = Object.keys(types);
  const edit = opts.mode === 'edit';
  if (raw && typeof raw === 'object') {
    // {token:"h1", fontWeight:700}: токен — по тем же правилам, свои поправки остаются
    if (raw.token === undefined || raw.token === null || raw.token === '') return raw;
    const token = normStyle(String(raw.token), doc, warn, what, opts);
    if (token === undefined) return undefined;
    return token === raw.token ? raw : { ...raw, token };
  }
  const s = String(raw == null ? '' : raw).trim();
  if (s && Object.prototype.hasOwnProperty.call(types, s)) return s;
  const ci = names.find((k) => k.toLowerCase() === s.toLowerCase());
  if (ci) return ci;
  const alias = typeAlias(types, s);
  if (alias) {
    // в правке об этом стоит сказать: человек увидит в истории «крупный», а не «h1»
    if (edit) warn(`${what}: стиля «${s}» в документе нет — понял как «${ruToken('type', alias)}»`);
    return alias;
  }
  if (edit) {
    if (!names.length) { if (s) warn(`${what}: в документе нет стилей текста — правка пропущена`); return undefined; }
    const cur = opts.cur;
    const curToken = cur && typeof cur === 'object' ? cur.token : cur;
    warn(`${what}: стиля «${s || '—'}» в документе нет, и по смыслу он ни на один не похож — правка пропущена`
      + (curToken ? `, стиль остался «${ruToken('type', curToken)}»` : '')
      + `. Есть: ${names.slice(0, 8).map((k) => `«${ruToken('type', k)}»`).join(', ')}`);
    return undefined;
  }
  const fallback = bodyTypeName(names);
  if (!fallback) return s || undefined;
  // круг 16, п.9: имя токена человек читает словом — «текст», а не «body»
  if (s) warn(`${what}: стиля «${s}» в документе нет — поставил «${ruToken('type', fallback)}»`);
  return fallback;
}

/**
 * Фиксированный размер 0 (или отрицательный) — это всегда невидимый слой, а не замысел:
 * такой ответ модели превращаем в «по содержимому» (hug), а не в мину на макете (круг 3, п.2/п.7).
 */
const fixedOrHug = (v) => {
  const n = clampPx(v);
  if (n == null) return undefined;                 // «mode:"fixed", value:"широкая"» — это не размер
  return n <= 0 ? { mode: 'hug' } : { mode: 'fixed', value: n };
};

function normSizeSpec(raw) {
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return fixedOrHug(raw);
  if (typeof raw === 'object') {
    if (raw.mode === 'fixed') return fixedOrHug(raw.value);
    if (raw.mode === 'hug' || raw.mode === 'fill') return { mode: raw.mode };
    return undefined;
  }
  const s = String(raw).trim().toLowerCase();
  if (s === 'hug' || s === 'auto' || s === 'content') return { mode: 'hug' };
  if (s === 'fill' || s === 'stretch' || s === 'grow' || s === '100%') return { mode: 'fill' };
  return parsePx(s) ? fixedOrHug(s) : undefined;   // «370px», «24 пикселя», «1rem» — это размер
}

/**
 * Отступы из ответа модели → {t,r,b,l}. Круг 20 (SPEC §6): каждая сторона идёт через scaleValue,
 * то есть может быть и ссылкой на шаг («spacing.6»), и числом; одинаковые замечания по четырём
 * сторонам схлопываются в одно — иначе «24 мимо шкалы» читалось бы четыре раза.
 * @param {{doc?:object, engine?:object, said?:string, quiet?:boolean}} [opts]
 */
function normPadding(raw, note, what, opts = {}) {
  // каждая сторона зажимается отдельно: «padding: -12» и «padding: [0, 500000]» больше не
  // роняют всю команду через checkNode, а становятся допустимыми 0 и 100000 (п.7).
  // Круг 7, п.1: о каждом таком зажиме говорим словами, если есть кому.
  // Круг 9, п.2: сторона, в которой числа НЕТ, отменяет всю правку отступов (а не становится
  // нулём): «padding: "как у карточки"» — это непонятая команда, а не «поля по нулям».
  let bad = false;
  const seen = new Set();
  const once = (m) => { if (seen.has(m)) return; seen.add(m); if (note) note(m); };
  const doc = opts.doc || null;
  const px = (v) => {
    const n = doc && stepsOf(doc, 'spacing', opts.engine).length
      ? scaleValue(v, 'spacing', doc, once, what || 'Отступ', { engine: opts.engine, said: opts.said, quiet: opts.quiet })
      : clampPx(v, once, what || 'Отступ');
    if (n == null) bad = true;
    return n;
  };
  const done = (v) => (bad ? undefined : v);
  if (raw == null) return undefined;
  if (typeof raw === 'number' || (typeof raw === 'string' && (parsePx(raw) || parseRef(raw)))) {
    const v = px(raw);
    return done({ t: v, r: v, b: v, l: v });
  }
  if (Array.isArray(raw)) {
    const n = raw.map((v) => px(v));
    if (n.length === 1) return done({ t: n[0], r: n[0], b: n[0], l: n[0] });
    if (n.length === 2) return done({ t: n[0], r: n[1], b: n[0], l: n[1] });
    if (n.length === 3) return done({ t: n[0], r: n[1], b: n[2], l: n[1] });
    if (n.length >= 4) return done({ t: n[0], r: n[1], b: n[2], l: n[3] });
    return undefined;
  }
  if (typeof raw === 'object') {
    const g = (k, alt) => px(raw[k] != null ? raw[k] : raw[alt]);
    return done({ t: g('t', 'top'), r: g('r', 'right'), b: g('b', 'bottom'), l: g('l', 'left') });
  }
  if (note) note(`${what || 'Отступ'}: «${raw}» — не отступ (нужно число или [верх, бок]); правка пропущена`);
  return undefined;
}

/**
 * Круг 19, п.3: значение СВОЙСТВА экземпляра проверяется по его виду (`kind`) и, для
 * перечисления, по объявленному списку `values`. Это ровно то место, где отсекаются
 * выдуманные значения, — то же самое, где отсекаются выдуманные токены цвета.
 * @returns {*} undefined — значение не годится (о причине уже сказано словами)
 */
function propValueFor(prop, raw, doc, note, who) {
  const kind = prop && prop.kind;
  const bare = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.value != null ? raw.value : raw) : raw;
  const str = bare == null ? '' : String(bare).trim();
  if (kind === 'text') {
    if (bare == null) { note(`${who}: свойство «${prop.name}» — текст, а значения нет: пропущено`); return undefined; }
    return clampChars(String(bare), note, `${who}, свойство «${prop.name}»`);
  }
  if (kind === 'number') {
    const got = parsePx(bare);
    if (!got) { note(`${who}: «${str}» — не число, свойство «${prop.name}» пропущено`); return undefined; }
    return clampPx(got.n, note, `${who}, свойство «${prop.name}»`);
  }
  if (kind === 'bool') {
    if (typeof bare === 'boolean') return bare;
    const word = BOOL_WORDS[str.toLowerCase()];
    if (word === undefined) { note(`${who}: «${str}» — не «да» и не «нет», свойство «${prop.name}» пропущено`); return undefined; }
    return word;
  }
  if (kind === 'color') {
    const color = normColor(bare, doc, note, `${who}, свойство «${prop.name}»`);
    return color === undefined ? undefined : color;
  }
  if (kind === 'enum') {
    const values = Array.isArray(prop.values) ? prop.values : [];
    const hit = values.find((v) => v === str) || values.find((v) => String(v).toLowerCase() === str.toLowerCase());
    if (!hit) {
      note(`${who}: у свойства «${prop.name}» значения только ${values.map((v) => `«${ruToken('colors', v)}»`).join(', ')}`
        + `${str ? `, а «${str}» среди них нет` : ', а значения не было'} — свойство пропущено`);
      return undefined;
    }
    return hit;
  }
  note(`${who}: свойство «${(prop && prop.name) || '?'}» неизвестного вида — пропущено`);
  return undefined;
}

/**
 * Свойства экземпляра: что прислала модель → что объявил компонент (§5.5).
 * Принимаем и массив [{name,value}] (так в схеме), и словарь {имя: значение} — модели
 * присылают то и то, а отбрасывать понятный ответ из-за формы было бы недоразумением.
 * @returns {object} готовое поле props для узла-экземпляра
 */
function instanceProps(raw, info, doc, note, who) {
  const declared = (info && info.props) || [];
  const out = {};
  if (raw == null) return out;
  const pairs = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const nm = [item.name, item.prop, item.key].find((v) => typeof v === 'string' && v.trim());
      if (nm) pairs.push([nm.trim(), item.value !== undefined ? item.value : item.val]);
    }
  } else if (typeof raw === 'object') {
    for (const k of Object.keys(raw)) pairs.push([k, raw[k]]);
  }
  for (const [nm, value] of pairs) {
    const low = nm.toLowerCase();
    const prop = declared.find((p) => p.name === nm)
      || declared.find((p) => String(p.name).toLowerCase() === low)
      || declared.find((p) => stemRu(String(p.name).toLowerCase()) === stemRu(low));
    if (!prop) {
      note(`${who}: у компонента «${info.name}» нет свойства «${nm}»`
        + `${declared.length ? ` — есть ${declared.map((p) => `«${p.name}»`).join(', ')}` : ' (свойств он не объявлял вовсе)'}`
        + '. Свойство пропущено');
      continue;
    }
    const val = propValueFor(prop, value, doc, note, who);
    if (val !== undefined) out[prop.name] = val;
  }
  return out;
}

/**
 * Синонимы типов узлов. Это ЯВНАЯ таблица (круг 7, п.1), и предупреждения здесь сознательно нет:
 * «карточка» в этой модели и есть фрейм, человек получает ровно то, что просил, а строка
 * «card → frame» на каждый узел сгенерированного экрана была бы шумом, а не честностью.
 */
/** Как модель зовёт экземпляр компонента. «component» тоже сюда: узел-компонент на доске — это он. */
const INSTANCE_TYPES = new Set(['instance', 'экземпляр', 'component', 'компонент', 'инстанс']);

const NODE_TYPE_ALIASES = {
  container: 'frame', box: 'frame', group: 'frame', stack: 'frame', row: 'frame', column: 'frame',
  section: 'frame', card: 'frame', button: 'frame', list: 'frame', div: 'frame',
  label: 'text', heading: 'text', title: 'text', paragraph: 'text', string: 'text',
  rectangle: 'rect', square: 'rect', divider: 'rect', line: 'rect',
  circle: 'ellipse', oval: 'ellipse', avatar: 'ellipse',
  img: 'image', picture: 'image', photo: 'image', icon: 'image',
};

/**
 * Дерево модели → спецификации узлов. Невалидные узлы отбрасываются с предупреждением,
 * валидные соседи сохраняются.
 */
export function normalizeTree(raw, { doc, warn, persona, depth = 1, budget, engine = null, said = '' } = {}) {
  const P = (persona && persona.defaults) || { gap: 16, padding: 24, radius: 8 };
  const note = warn || (() => {});
  const bud = budget || makeNodeBudget(note);
  /* Круг 20 (SPEC §6.6): зазор, поля и скругление от модели идут через scaleValue — ссылка
   * проверяется, число на шаге становится ссылкой, число мимо шкалы решается по правилу
   * scaleValue. Наши собственные умолчания (характер варианта) — тоже на шкалу, но молча:
   * это не ответ модели, предупреждать человеку не о чём. */
  const scaleOpts = { engine, said };
  const onScaleQuiet = (n, scale) => (doc ? onScale(doc, n, scale, engine) : n);
  /**
   * Круг 13, п.1: у СОЗДАВАЕМОГО узла «снять цвет» и «не задавать цвет» — одно и то же, поэтому
   * fill:"none" (и «прозрачный», «нет», «без заливки») значит «без заливки», а не «неизвестный
   * цвет». Имя токена документа сильнее: если в палитре завели цвет «none», ставим его.
   */
  const treeColor = (raw, what) => {
    const str = typeof raw === 'string' ? raw.trim() : '';
    const colors = (doc && doc.tokens && doc.tokens.colors) || {};
    if (str && !Object.prototype.hasOwnProperty.call(colors, str) && looksCleared(str, 'fill')) return undefined;
    return normColor(raw, doc, note, what);
  };
  /**
   * Круг 7, п.1: размер, который не удалось прочитать («wide», «100vh», «-20»), молча
   * становился «fill»/«120». Значение по умолчанию оставляем (узел нужен человеку целиком),
   * но о подстановке говорим словами.
   */
  const sizeOr = (given, fallback, what) => {
    const got = normSizeSpec(given);
    if (got) return got;
    if (given != null && given !== '') note(`${what}: «${given}» не размер — оставил ${sizeWord(fallback)}`);
    return fallback;
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    note('Слой не является объектом — отброшен');
    return null;
  }
  if (!bud.take()) return null;                  // общий предел на число узлов (п.19)

  let type = String(raw.type == null ? '' : raw.type).trim().toLowerCase();
  /**
   * Круг 19, п.2 (SPEC §5.5): ЭКЗЕМПЛЯР КОМПОНЕНТА — свой тип узла со своей формой. Ни детей,
   * ни заливки, ни стиля у него нет: содержимое экземпляра — сам компонент. Поэтому ветка
   * стоит тут, до общих правил для frame/text, и выходит из функции сразу.
   *
   * Тут же отсекается ВЫДУМАННЫЙ компонент — ровно там, где отсекается выдуманный тип узла и
   * выдуманный токен цвета, и такой же строкой для человека: чего нет и что есть взамен.
   */
  if (INSTANCE_TYPES.has(type) || (!type && typeof raw.of === 'string' && raw.of.trim())) {
    const list = componentList(engine, doc);
    const called = [raw.of, raw.component, raw.master, raw.name].find((v) => typeof v === 'string' && v.trim()) || '';
    const who = `Экземпляр${called ? ` «${cutText(String(called).trim(), 40)}»` : ''}`;
    if (!list.length) {
      note(`${who}: библиотеки компонентов в документе нет, ставить экземпляр не из чего — слой отброшен.`
        + ' Соберите его обычными слоями или сначала сделайте компонент');
      return null;
    }
    const { info, ambiguous } = findComponent(list, called);
    if (!info) {
      note(ambiguous.length
        ? `${who}: под это имя подходит несколько компонентов — ${componentNames(ambiguous)}.`
          + ' Слой отброшен: назовите компонент точно'
        : `${who}: такого компонента в библиотеке нет — есть ${componentNames(list)}. Слой отброшен`);
      return null;
    }
    const spec = {
      type: 'instance',
      name: typeof raw.name === 'string' && raw.name.trim() && raw.name.trim() !== info.name
        ? cutText(raw.name.trim(), 80) : undefined,
      of: info.id,
      compName: info.name,
      props: instanceProps(raw.props !== undefined ? raw.props : raw.values, info, doc, note, who),
    };
    // §5.5: оси размера необязательны ПО ОТДЕЛЬНОСТИ — незаданную экземпляр берёт у компонента,
    // поэтому пустой size не пишем вовсе: иначе кнопка потеряла бы свой размер
    const w = normSizeSpec(raw.size && raw.size.w);
    const h = normSizeSpec(raw.size && raw.size.h);
    if (w || h) spec.size = { ...(w ? { w } : {}), ...(h ? { h } : {}) };
    if (Array.isArray(raw.children) && raw.children.length) {
      note(`${who}: у экземпляра компонента детей не бывает — его содержимое задаёт сам компонент.`
        + ` Вложенные слои (${raw.children.length}) пропущены`);
    }
    treeMotion(spec, raw, doc, note, who, { engine, said });
    if (typeof raw.id === 'string' && raw.id.trim()) spec.$id = raw.id.trim();
    return spec;
  }
  if (!NODE_TYPES.includes(type)) {
    if (type && NODE_TYPE_ALIASES[type]) {
      type = NODE_TYPE_ALIASES[type];
    } else if (!type) {
      // тип не назван — выводим из содержимого
      if (Array.isArray(raw.children)) type = 'frame';
      else if (typeof raw.text === 'string' || typeof raw.characters === 'string') type = 'text';
    }
  }
  if (!NODE_TYPES.includes(type)) {
    note(`Слой с типом «${raw.type}» неизвестен — отброшен`);
    return null;
  }

  const name = typeof raw.name === 'string' && raw.name.trim() ? cutText(raw.name.trim(), 80) : undefined;
  const spec = { type, name };

  if (type === 'text') {
    const chars = [raw.text, raw.characters, raw.content, raw.value].find((v) => typeof v === 'string' && v.trim());
    if (!chars) {
      if (!name) { note('Текстовый слой без содержимого — отброшен'); return null; }
      note(`Текст «${name}» пришёл без содержимого — подставлено имя слоя`);
    }
    spec.characters = clampChars(chars || name, note, `Текст «${name || 'без имени'}»`);
    if (/lorem\s+ipsum|dolor\s+sit\s+amet/i.test(spec.characters)) {
      note(`Текст «${cutText(spec.characters, 30)}…» похож на заглушку Lorem ipsum`);
    }
    spec.style = normStyle(raw.style, doc, note, `Текст «${name || cutText(spec.characters, 20)}»`);
    // круг 7, п.1: выключка вне перечисления («justify», «space-between») больше не молчит
    spec.align = raw.align == null || raw.align === ''
      ? 'left'
      : (pickEnum(raw.align, 'align', { warn: note, what: `Текст «${name || cutText(spec.characters, 20)}», выключка`, fallback: 'left' }) || 'left');
    const color = treeColor(raw.color != null ? raw.color : raw.fill, `Текст «${name || ''}»`);
    if (color) spec.color = color;
    spec.size = {
      w: sizeOr(raw.size && raw.size.w, { mode: 'fill' }, `Текст «${name || ''}», ширина`),
      h: sizeOr(raw.size && raw.size.h, { mode: 'hug' }, `Текст «${name || ''}», высота`),
    };
  } else {
    const fill = treeColor(raw.fill, `Слой «${name || type}»`);
    if (fill) spec.fill = fill;
    const stroke = treeColor(raw.stroke, `Обводка «${name || type}»`);
    if (stroke) spec.stroke = stroke;
    // круг 9, п.2: «radius: "8px"» — обычный ответ модели, и раньше он давал «непонятно — оставил 0»
    // круг 20: «radius: "radii.4"» — ссылка на шаг шкалы скруглений, принимается как есть
    const radius = parsePx(raw.radius);
    const radiusRef = parseRef(raw.radius);
    const defRadius = onScaleQuiet(type === 'frame' ? 0 : P.radius, 'radii');
    if (raw.radius != null && raw.radius !== '' && !radiusRef && !(radius && radius.n >= 0)) {
      note(`Слой «${name || type}»: скругление «${raw.radius}» непонятно — оставил ${scaleValueWords(doc, defRadius, 'radii', engine)}`);
    }
    const radiusPx = radiusRef || (radius && radius.n >= 0)
      ? scaleValue(raw.radius, 'radii', doc, note, `Слой «${name || type}», скругление`, scaleOpts) : null;
    spec.radius = radiusPx == null ? defRadius : radiusPx;
    if (type === 'image' && raw.src != null) {
      const src = safeSrc(raw.src, note, `Картинка «${name || 'без имени'}»`);
      if (src) spec.src = src;
    }

    if (type === 'frame') {
      const l = raw.layout && typeof raw.layout === 'object' ? raw.layout : {};
      const who = `Слой «${name || type}», раскладка`;
      // круг 7, п.1: раньше «mode: "grid"» молча становился колонкой, «align: "flex-start"» —
      // «stretch». Теперь синоним подставляется со словами, а непонятное значение — с объяснением.
      const enumOr = (field, value, fallback) => (value == null || value === ''
        ? fallback
        : (pickEnum(value, field, { warn: note, what: `${who} (${field.replace('layout.', '')})`, fallback }) || fallback));
      spec.layout = {
        mode: enumOr('layout.mode', l.mode, 'column'),
        // круг 9, п.2: «gap: "8px"» раньше молча падало на умолчание — единицы теперь снимаются
        // круг 20: «gap: "spacing.6"» — ссылка на шаг, число на шаге само становится ссылкой
        gap: (l.gap == null || l.gap === '' ? null : scaleValue(l.gap, 'spacing', doc, note, `${who} (зазор)`, scaleOpts))
          ?? onScaleQuiet(P.gap, 'spacing'),
        padding: normPadding(l.padding, note, `${who} (поля)`, { doc, engine, said })
          || (doc ? paddingOnScale(doc, { t: P.padding, r: P.padding, b: P.padding, l: P.padding }, engine)
            : { t: P.padding, r: P.padding, b: P.padding, l: P.padding }),
        align: enumOr('layout.align', l.align, 'stretch'),
        justify: enumOr('layout.justify', l.justify, 'start'),
        wrap: !!l.wrap,
      };
      spec.size = {
        w: sizeOr(raw.size && raw.size.w, { mode: 'fill' }, `Слой «${name || type}», ширина`),
        h: sizeOr(raw.size && raw.size.h, { mode: 'hug' }, `Слой «${name || type}», высота`),
      };
    } else {
      spec.size = {
        w: sizeOr(raw.size && raw.size.w, { mode: 'fill' }, `Слой «${name || type}», ширина`),
        h: sizeOr(raw.size && raw.size.h, { mode: 'fixed', value: 120 }, `Слой «${name || type}», высота`),
      };
    }
  }

  // круг 36 (SPEC §11): тень, прозрачность, состояния и движение нового слоя
  treeMotion(spec, raw, doc, note, `Слой «${name || type}»`, { engine, said });
  if (typeof raw.id === 'string' && raw.id.trim()) spec.$id = raw.id.trim();

  if (type === 'frame') {
    let kids = Array.isArray(raw.children) ? raw.children : [];
    if (depth >= MAX_TREE_DEPTH && kids.length) {
      note(`Глубина дерева больше ${MAX_TREE_DEPTH} — вложенность слоя «${name || type}» обрезана`);
      kids = [];
    }
    if (kids.length > MAX_CHILDREN) {
      note(`У слоя «${name || type}» ${kids.length} детей — оставлено ${MAX_CHILDREN}`);
      kids = kids.slice(0, MAX_CHILDREN);
    }
    spec.children = [];
    for (const kid of kids) {
      const norm = normalizeTree(kid, { doc, warn: note, persona, depth: depth + 1, budget: bud, engine, said });
      if (norm) spec.children.push(norm);
    }
    treeStateColor(spec, note, name || type);
  }

  return spec;
}

/** Круг 36: тень, прозрачность, состояния и движение из дерева модели → в спецификацию слоя. */
function treeMotion(spec, raw, doc, note, who, opts) {
  if (raw.shadow != null && raw.shadow !== '') {
    const v = shadowValue(raw.shadow, note, `${who}, тень`);
    if (v !== undefined) spec.shadow = v;
  }
  if (raw.opacity != null && raw.opacity !== '') {
    const v = opacityValue(raw.opacity, note, `${who}, прозрачность`);
    if (v !== undefined && v !== 1) spec.opacity = v;
  }
  if (raw.states != null && typeof raw.states === 'object') {
    const v = statesValue(raw.states, doc, note, opts);
    if (v) {
      for (const st of Object.keys(v)) {
        const p = v[st];
        if (spec.type === 'text') {
          for (const f of ['fill', 'stroke']) {
            if (p[f] !== undefined) { note(`${who}: у текста нет ${STATE_FIELD_RU_GEN[f]} ${STATE_RU[st].at} — пропущено, у текста меняется цвет текста`); delete p[f]; }
          }
        } else if (spec.type !== 'frame' && p.color !== undefined) {
          note(`${who}: цвета текста ${STATE_RU[st].at} у этого слоя нет — пропущено`);
          delete p.color;
        }
        if (!Object.keys(p).length) delete v[st];
      }
      if (Object.keys(v).length) spec.states = v;
    }
  }
  if (raw.motion != null && raw.motion !== '') {
    const v = motionValue(raw.motion, doc, note, opts);
    if (v) spec.motion = v;
  }
}

/** Круг 36: «цвет текста при наведении» у нового фрейма-кнопки уходит её единственному тексту. */
function treeStateColor(spec, note, who) {
  if (!spec.states) return;
  const hits = STATE_NAMES.filter((st) => spec.states[st] && spec.states[st].color !== undefined);
  if (!hits.length) return;
  const texts = [];
  const walk = (k) => { if (k.type === 'text') texts.push(k); for (const c of k.children || []) walk(c); };
  for (const c of spec.children || []) walk(c);
  for (const st of hits) {
    const color = spec.states[st].color;
    delete spec.states[st].color;
    if (!Object.keys(spec.states[st]).length) delete spec.states[st];
    if (texts.length !== 1) {
      note(`Слой «${who}»: цвет текста ${STATE_RU[st].at} — ${texts.length ? 'текстов внутри несколько' : 'текста внутри нет'}, пропущено`);
      continue;
    }
    const t = texts[0];
    t.states = { ...(t.states || {}), [st]: { ...((t.states && t.states[st]) || {}), color } };
    t.motion = { ...(t.motion || {}), follow: 'parent' };
  }
  if (!Object.keys(spec.states).length) delete spec.states;
}

function specToNodes(spec, parentId, ids, out) {
  const id = spec.$id ? ids.adopt(spec.$id, spec.type) : ids.mint(spec.type);
  const node = { type: spec.type, id, name: spec.name || defaultName(spec), parent: parentId };
  if (spec.type === 'frame') {
    node.children = [];
    node.layout = spec.layout;
    node.size = spec.size;
    node.radius = spec.radius || 0;
    if (spec.fill) node.fill = spec.fill;
    if (spec.stroke) node.stroke = spec.stroke;
  } else if (spec.type === 'text') {
    node.characters = spec.characters;
    node.style = spec.style;
    node.align = spec.align;
    node.size = spec.size;
    if (spec.color) node.color = spec.color;
  } else if (spec.type === 'instance') {
    // круг 19 (§5.5): у экземпляра только ссылка на компонент, свойства и (необязательно) размер
    node.of = spec.of;
    node.props = spec.props || {};
    if (spec.size) node.size = spec.size;
  } else {
    node.size = spec.size;
    node.radius = spec.radius || 0;
    if (spec.fill) node.fill = spec.fill;
    if (spec.stroke) node.stroke = spec.stroke;
    if (spec.src) node.src = spec.src;
  }
  // круг 36 (SPEC §11): у любого слоя, кроме страницы
  if (spec.shadow !== undefined) node.shadow = spec.shadow;
  if (spec.opacity !== undefined) node.opacity = spec.opacity;
  if (spec.states) node.states = spec.states;
  if (spec.motion) node.motion = spec.motion;
  out.push(node);
  // Дети создаются собственными операциями: узел рождается с пустым children,
  // а порядок задаётся порядком операций (родитель раньше детей). Так create не
  // ссылается вперёд на ещё не существующие узлы.
  if (spec.children) for (const kid of spec.children) specToNodes(kid, id, ids, out);
  return id;
}

function defaultName(spec) {
  if (spec.type === 'text') return cutText(spec.characters || 'Текст', 24);
  // экземпляр без своего имени зовётся как компонент: в списке слоёв так его и узнают
  if (spec.type === 'instance') return cutText(spec.compName || 'Экземпляр', 24);
  return { frame: 'Фрейм', rect: 'Прямоугольник', ellipse: 'Эллипс', image: 'Картинка' }[spec.type] || 'Слой';
}

function nextArtboardPos(doc) {
  const root = nodeOf(doc, doc.root);
  let right = null, top = 0;
  for (const id of kidsOf(root)) {
    const n = nodeOf(doc, id);
    if (!n) continue;
    const x = (n.pos && Number(n.pos.x)) || 0;
    const w = n.size && n.size.w && n.size.w.mode === 'fixed' ? Number(n.size.w.value) || 400 : 400;
    right = right == null ? x + w : Math.max(right, x + w);
    top = Math.min(top, (n.pos && Number(n.pos.y)) || 0);
  }
  return { x: right == null ? 0 : right + 80, y: top };
}

/**
 * Просит ли новый узел ВСЮ ширину родителя. Ширина, которую модель не задала, в normalizeTree
 * становится «fill» — значит, и здесь «не задана» = во всю ширину (круг 7, п.3).
 */
function wantsFullWidth(rawSize) {
  const w = rawSize ? rawSize.w : undefined;
  if (w === undefined || w === null || w === '') return true;
  const spec = normSizeSpec(w);
  return !!spec && spec.mode === 'fill';
}

/**
 * Круг 7, п.3: «уровень выше» применяем ТОЛЬКО когда новый узел действительно во всю ширину —
 * иконка рядом с заголовком должна остаться в обёртке, а плашка с погодой — нет.
 */
function wideTarget(doc, placement, fullWidth, note) {
  if (!placement || !placement.wide || !fullWidth) return null;
  if (!nodeOf(doc, placement.wide.parentId)) return null;
  if (note) note(`Место вставки: ${placement.wide.why}`);
  return placement.wide;
}

/** Дерево → массив операций core.ops (родитель раньше детей). */
export function treeToOps({ doc, tree, parentId, index, engine, warn, persona, asArtboard, artboardSize, said = '' }) {
  const note = warn || (() => {});
  let spec = normalizeTree(tree, { doc, warn: note, persona, budget: makeNodeBudget(note), engine, said });
  if (!spec) throw ERR('schema', 'Модель не вернула ни одного пригодного слоя');

  if (asArtboard && spec.type !== 'frame') {
    note('Корень дерева не фрейм — завернул в доску');
    // круг 20: наша обёртка — тоже на шкале документа, если её числа ровно на шагах
    spec = {
      type: 'frame', name: spec.name || 'Артборд',
      layout: {
        mode: 'column', gap: onScale(doc, (persona && persona.defaults.gap) || 16, 'spacing', engine),
        padding: paddingOnScale(doc, { t: 24, r: 24, b: 24, l: 24 }, engine), align: 'stretch', justify: 'start', wrap: false,
      },
      size: { w: { mode: 'fixed', value: 390 }, h: { mode: 'hug' } },
      radius: onScale(doc, 0, 'radii', engine), children: [spec],
    };
  }

  const ids = makeIdFactory(doc, [], engine);
  const nodes = [];
  const rootId = specToNodes(spec, parentId, ids, nodes);

  if (asArtboard) {
    const rootNode = nodes.find((n) => n.id === rootId);
    if (rootNode.size.w.mode !== 'fixed') rootNode.size.w = { mode: 'fixed', value: (artboardSize && artboardSize.w) || 390 };
    if (artboardSize && artboardSize.h) rootNode.size.h = { mode: 'fixed', value: artboardSize.h };
    rootNode.pos = nextArtboardPos(doc);
  }

  const ops = nodes.map((node, i) => mkOp(engine, 'create', i === 0 && index != null ? { node, index } : { node }));
  return { ops, rootId, nodeIds: nodes.map((n) => n.id) };
}

/* — разрешение целей — */

const SELF_REFS = new Set(['selection', 'выделение', 'выделенное', 'self', 'this', 'it', 'текущий', 'сам', '@selection']);

/** Ссылка на «то, что выделено»? */
export function isSelfRef(ref) {
  const raw = String(ref == null ? '' : ref).trim().toLowerCase();
  return SELF_REFS.has(raw) || SELF_REFS.has(raw.replace(/^[#@]/, ''));
}

const lowerName = (n) => String((n && n.name) || '').trim().toLowerCase();
const lowerChars = (n) => String((n && n.characters) || '').trim().toLowerCase();

/**
 * Разрешение цели (п.6). Порядок важен:
 *   0. узлы, созданные ЭТИМ ЖЕ патчем (п.9) — «оберни в карточку» ссылается на ещё не существующий
 *      узел; для remove и move.target порядок обратный (opts.existingFirst, круг 5, п.2):
 *      существующий узел важнее одноимённого свежего, иначе «замени кнопку на две» удаляет
 *      только что созданную кнопку, а старая остаётся на экране;
 *   1. явный id;
 *   2. точное имя/текст ВНУТРИ области;
 *   3. частичное имя/текст внутри области;
 *   4. глобально (engine.resolveTarget, затем свой поиск) — с предупреждением о выходе за область.
 * Раньше глобальный поиск шёл вторым, и при выделенной карточке «заголовок» отдавал заголовок экрана.
 *
 * opts.container = true — нужен контейнер (куда вставлять), тогда «selection» = scope.containerId.
 */
const nameOrId = (doc, id) => {
  const n = nodeOf(doc, id);
  if (n && strOf(n.name)) return `«${n.name}»`;
  /* Круг 19: у экземпляра своего имени обычно нет — он зовётся по компоненту (так же, как в
   * списке слоёв оболочки). Показывать вместо этого внутренний id («#i_f651jz») человеку
   * нельзя: это наше слово, а не его. Кавычки те же, что у слоя, — строка встаёт в любую
   * фразу, где уже стоит имя слоя. */
  if (n && n.type === 'instance') {
    const master = nodeOf(doc, n.of);
    const comp = master && master.component;
    const named = comp && typeof comp.name === 'string' ? comp.name.trim() : '';
    return `«${named || 'Экземпляр'}»`;
  }
  return `#${id}`;
};

/**
 * Имена для перечисления: если они повторяются («Время», «Время», «Время»), добавляем родителя —
 * иначе человек не понимает, о каких именно узлах речь.
 */
function listNames(doc, ids) {
  const plain = ids.map((id) => nameOrId(doc, id));
  const unique = new Set(plain).size === plain.length;
  if (unique) return plain;
  return ids.map((id) => {
    const parent = nodeOf(doc, (nodeOf(doc, id) || {}).parent);
    return parent && parent.name ? `${nameOrId(doc, id)} в «${parent.name}»` : nameOrId(doc, id);
  });
}

/**
 * Круг 3, п.10: раньше выходило «Цель «Показатель · Задач закрыто» найдена вне активной
 * области — правка ушла в «Показатель · Задач закрыто»»: одно и то же дважды и ни слова
 * о том, на каком экране. Теперь называем экран.
 */
function outsideNote(doc, scope, id, purpose) {
  const where = scope && scope.kind === 'selection' ? 'вне выделения' : 'вне активной области';
  const who = nameOrId(doc, id);
  // Круг 5, п.4: при копировании и переносе «правка ушла туда» — прямая ложь: на «повтори шапку
  // со второго экрана» копия ложится СЮДА, в активный экран, а там был только источник.
  const source = purpose === 'source';
  /**
   * Круг 9, п.5: «правка ушла туда» звучало почти на каждой второй команде подряд и было
   * неправдой. Оболочка после правки выделяет то, что агент задел, resolveScope считает это
   * областью работы, и следующая команда получала «Слой X найден вне выделения — правка ушла
   * туда», хотя правка легла точно туда, куда просили; заодно предупреждение занимало один из
   * двух видимых слотов и вытесняло важное. Агентское выделение — не граница, назначенная
   * человеком, и нарушать её нечем. «Источник взят оттуда» остаётся: это не про границы
   * области, а про то, откуда взялось содержимое, — человеку это правда нужно знать.
   */
  if (!source && scope && scope.kind === 'selection' && scope.selectionBy === 'agent') return '';
  const tail = source ? 'источник взят оттуда' : 'правка ушла туда';
  const ab = artboardOf(doc, id);
  if (ab === id) return `Экран ${who} найден ${where} — ${source ? 'источник взят оттуда' : 'правка ушла в него'}`;
  const abNode = ab ? nodeOf(doc, ab) : null;
  if (abNode) return `Слой ${who} найден ${where} — на экране «${abNode.name || ab}»; ${tail}`;
  return `Слой ${who} найден ${where} — ${tail}`;
}

/** Имя есть и у свежесозданного узла, и у существующего (круг 5, п.2). */
function collisionNote(doc, raw, chosen) {
  return `Имя «${raw}» есть и у только что созданного слоя, и у существующего ${nameOrId(doc, chosen)}`
    + ' — беру существующий; чтобы работать с новым, назовите его иначе';
}

/**
 * «Колонка» — одно и то же имя у нескольких узлов, стоящих на одном и том же месте внутри
 * повторяющихся элементов одного списка: «Время» в каждом пункте, «Статус» в каждой строке
 * таблицы, «Подпись показателя» в каждой карточке. Именно так устроен демо-документ:
 * 38 из 62 именованных узлов носят имя, общее с соседями.
 *
 * Признак строгий: у всех кандидатов одинаковая глубина относительно общего предка, ветви под
 * ним РАЗНЫЕ (иначе это два узла в одном элементе, а не колонка), на каждом уровне совпадают
 * типы, а имена совпадают на всех уровнях, кроме самого элемента списка — его имя как раз и
 * несёт название пункта («Пункт · Обед с командой» против «Пункт · Тренировка»).
 */
/**
 * Предел колонки: длиннее — считаем, что имя адресовано неточно, и правим один узел с подсказкой.
 * Ровно столько детей у одного узла разбирает normalizeTree (MAX_CHILDREN): список, который
 * агент способен построить сам, в этот предел укладывается.
 */
export const MAX_AUTO_GROUP = MAX_CHILDREN;

/** Путь от ребёнка stopId вниз к id, или null, если stopId не предок id. */
function chainDown(doc, id, stopId) {
  const out = [];
  let cur = id;
  let guard = 0;
  while (cur && cur !== stopId && guard++ < 128) { out.push(cur); cur = (nodeOf(doc, cur) || {}).parent; }
  if (cur !== stopId) return null;
  return out.reverse();
}

/** Ближайший общий предок — именно узел, а не контейнер (commonContainer поднимается до фрейма). */
function lowestCommonAncestor(doc, ids) {
  const chains = ids.map((id) => chainUp(doc, id));
  if (!chains.length) return null;
  for (const cand of chains[0]) if (chains.every((c) => c.includes(cand))) return cand;
  return null;
}

/**
 * Круг 15, п.7: ДОКАЗУЕМО однотипные соседи узла — элементы одного списка.
 *
 * Нужно групповой правке. «Сделай ВСЕ пункты белыми» — формулировка групповая (looksGroupWide),
 * но модель часто называет точное имя ОДНОГО пункта («Пункт · Обед с командой»), и поиск по
 * имени честно находит один узел: правился один, а человеку об этом не говорили ни слова.
 * looksUniformColumn тут не помогает: у прямых соседей она требует совпадения ИМЁН, а элементы
 * списка названы по содержимому.
 *
 * Поэтому сверяем то, что доказуемо: тип, режим раскладки, число детей, подписи детей
 * (repeatSignature) — и ПЕРВОЕ слово имени. Последнее и отделяет список от случайного соседства:
 * «Дата» и «Заголовок экрана» — два текста рядом с одинаковой формой, но разного рода, и
 * «сделай все заголовки крупнее» не должно задевать дату.
 *
 * @returns {string[]} соседи вместе с самим узлом (в порядке документа), либо [] — повторов нет
 */
function siblingRepeats(doc, id) {
  const node = nodeOf(doc, id);
  const parent = node && node.parent ? nodeOf(doc, node.parent) : null;
  if (!node || !parent) return [];
  const kids = kidsOf(parent).filter((k) => nodeOf(doc, k));
  if (kids.length < 2 || kids.length > MAX_AUTO_GROUP) return [];
  const headWord = (nid) => {
    const n = nodeOf(doc, nid);
    const w = (String((n && n.name) || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])[0] || '';
    return stemRu(w);
  };
  const shape = (nid) => {
    const n = nodeOf(doc, nid);
    return [n.type, (n.layout && n.layout.mode) || '', kidsOf(n).length, headWord(nid),
      kidsOf(n).map((k) => repeatSignature(doc, k, 1)).join('~')].join('|');
  };
  const mine = shape(id);
  const same = kids.filter((k) => shape(k) === mine);
  return same.length >= 2 ? same : [];
}

export function looksUniformColumn(doc, ids) {
  const list = asArray(ids).filter((id) => nodeOf(doc, id));
  if (list.length < 2 || list.length > MAX_AUTO_GROUP || new Set(list).size !== list.length) return false;
  const common = lowestCommonAncestor(doc, list);
  if (!common) return false;
  const chains = list.map((id) => chainDown(doc, id, common));
  if (chains.some((c) => !c || !c.length)) return false;
  const len = chains[0].length;
  if (chains.some((c) => c.length !== len)) return false;
  if (new Set(chains.map((c) => c[0])).size !== list.length) return false;
  for (let lvl = 0; lvl < len; lvl++) {
    const nodes = chains.map((c) => nodeOf(doc, c[lvl]));
    if (nodes.some((n) => !n)) return false;
    if (nodes.some((n) => n.type !== nodes[0].type)) return false;
    // имя элемента списка несёт его название и совпадать не обязано, всё остальное — обязано;
    // но если кандидаты и есть прямые соседи (len === 1), их имена должны совпадать
    if ((lvl > 0 || len === 1) && nodes.some((n) => lowerName(n) !== lowerName(nodes[0]))) return false;
  }
  return true;
}

/**
 * ВСЕ узлы, подходящие под ссылку, в порядке документа, вместе с тем, КАК они найдены.
 * Порядок тот же, что был у одиночного поиска (п.6): созданные этим патчем → id →
 * точное имя/текст в области → частичное в области → тип в области → точное по документу →
 * частичное по документу → роль через engine.resolveTarget. При opts.existingFirst созданные
 * этим патчем уходят в самый конец, а совпадение имени помечается флагом collision (круг 5, п.2).
 *
 * Круг 3, п.4: раньше поиск обрывался на ПЕРВОМ совпадении, и «во всех карточках
 * показателей…» правило ровно один узел — и не первый, а тот, у кого имя короче
 * (так выбирает core.resolveTarget), без слова о том, что кандидатов было три.
 */
export function refCandidates(engine, doc, ref, scope, opts = {}) {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) return { ids: [], how: 'none', inScope: true };
  const bare = raw.replace(/^[#@]/, '');
  const needle = bare.toLowerCase();
  const created = opts.created;
  /**
   * Круг 5, п.2: карта созданного проверялась ПЕРВОЙ для любой операции, и на «замени кнопку
   * на две, одна из них та же» модель создавала «Кнопка «Добавить пункт»» и просила удалить
   * «Кнопка «Добавить пункт»» — удалялась только что созданная, старая оставалась на экране,
   * а человек читал «удалил «»». Для remove и move.target (opts.existingFirst) сначала ищем
   * существующие узлы; для ссылок вперёд (create.parent, move.parent) порядок прежний.
   */
  const fresh = created && created.size ? (created.get(needle) || null) : null;
  const withFresh = (res) => (fresh && res.ids.length && res.how !== 'created' ? { ...res, collision: true } : res);
  if (fresh && !opts.existingFirst) return { ids: [fresh], how: 'created', inScope: true };
  if (nodeOf(doc, bare)) return withFresh({ ids: [bare], how: 'id', inScope: true });

  const scopeIds = collectSubtree(doc, (scope && scope.ids) || []);
  const inScope = new Set(scopeIds);
  /**
   * Круг 19 (SPEC §5.3): поиск по ИМЕНИ в библиотеку не заходит. Ядро нарочно убрало её из
   * resolveTarget: мастер «Кнопка» перебивал бы «Кнопку «Добавить пункт»» на доске, и точечная
   * правка молча меняла бы все экземпляры. Здесь то же правило для нашего поиска по именам —
   * иначе запрет ядра ничего не стоил бы: имена мы ищем сами.
   *
   * Исключение одно: узлы, которые ЧЕЛОВЕК ВЫДЕЛИЛ (они и есть scopeIds). Он показал пальцем на
   * мастера — значит, речь о нём, и молчания тут нет: про правку компонента скажет patchToOps.
   */
  const all = Object.keys(doc.nodes || {}).filter((id) => !inLibrary(doc, engine, id) || inScope.has(id));
  const take = (ids, pred) => ids.filter((id) => { const n = nodeOf(doc, id); return n && pred(n); });

  /**
   * Круг 3, п.4: среди частичных совпадений имена, НАЧИНАЮЩИЕСЯ с запроса, вытесняют случайные
   * вхождения: под «Пункт» человек имеет в виду «Пункт · Обед с командой», а не «Список пунктов»
   * и не «Название пункта». Порядок внутри — документа, чтобы результат был предсказуем.
   */
  const preferPrefix = (ids) => {
    const head = ids.filter((id) => {
      const n = nodeOf(doc, id);
      return lowerName(n).startsWith(needle) || lowerChars(n).startsWith(needle);
    });
    return head.length ? head : ids;
  };

  const steps = [
    ['exact', scopeIds, (n) => lowerName(n) === needle, true],
    ['exact', scopeIds, (n) => lowerChars(n) === needle, true],
    ['partial', scopeIds, (n) => lowerName(n).includes(needle), true],
    ['partial', scopeIds, (n) => lowerChars(n).includes(needle), true],
    ['type', scopeIds, NODE_TYPES.includes(needle) ? (n) => n.type === needle : null, true],
    ['exact', all, (n) => lowerName(n) === needle, false],
    ['exact', all, (n) => lowerChars(n) === needle, false],
    ['partial', all, (n) => lowerName(n).includes(needle), false],
    ['partial', all, (n) => lowerChars(n).includes(needle), false],
  ];
  for (const [how, ids, pred, within] of steps) {
    if (!pred) continue;
    const hit = how === 'partial' ? preferPrefix(take(ids, pred)) : take(ids, pred);
    if (hit.length) return withFresh({ ids: hit, how, inScope: within || hit.every((id) => inScope.has(id)) });
  }
  /**
   * Круг 19: у экземпляра своего имени обычно нет — и в списке слоёв оболочки, и в выжимке он
   * зовётся по КОМПОНЕНТУ («экземпляр Кнопка "Открыть день"»). Поэтому имя компонента годится и
   * как имя цели — но ПОСЛЕДНИМ шагом, после всех имён слоёв: иначе экземпляры перебивали бы
   * одноимённые слои на досках («Метка» — это и текст в карточке, и три ярлыка). Без этого шага
   * безымянный экземпляр адресуется только идентификатором или словом «selection».
   */
  const byComp = take(all, (n) => {
    if (n.type !== 'instance') return false;
    const master = nodeOf(doc, n.of);
    const cn = master && master.component && master.component.name;
    if (!cn) return false;
    const low = String(cn).toLowerCase();
    return low === needle || stemRu(low) === stemRu(needle);
  });
  if (byComp.length) {
    return withFresh({ ids: byComp, how: 'partial', inScope: byComp.every((id) => inScope.has(id)) });
  }

  // последний шанс — роли движка («кнопка», «шапка»): их таблица шире нашего поиска по именам
  if (engine && typeof engine.resolveTarget === 'function') {
    try {
      const got = engine.resolveTarget(doc, raw);           // при неоднозначности core вернёт null
      const id = typeof got === 'string' ? got : got && got.id;
      // круг 19: и по роли в библиотеку не заходим — см. выше про мастера «Кнопка»
      if (id && nodeOf(doc, id) && (!inLibrary(doc, engine, id) || inScope.has(id))) {
        return withFresh({ ids: [id], how: 'role', inScope: inScope.has(id) });
      }
    } catch { /* роли нет — значит, не нашли */ }
  }
  // существующего нет — тогда годится и созданный этим же патчем
  if (fresh) return { ids: [fresh], how: 'created', inScope: true };
  return { ids: [], how: 'none', inScope: true };
}

/**
 * Разрешение ОДНОЙ цели (п.6). При нескольких кандидатах — по точному ИЛИ частичному имени —
 * берём первый в порядке документа и прямо об этом говорим: раньше при точном совпадении
 * правился один узел из пяти совершенно молча (круг 5, п.1).
 *
 * opts.container = true — нужен контейнер (куда вставлять), тогда «selection» = scope.containerId.
 */
/** Способы поиска, при которых кандидатов может быть несколько и человеку надо об этом сказать. */
const AMBIGUOUS_HOW = new Set(['exact', 'partial', 'type']);

/**
 * Слова, которыми человек назвал ВМЕЩАЮЩИЙ слой: только то, что стоит после «в», «во»,
 * «внутри», «у». Брать всю реплику нельзя: на подметании «что тут за макет?» случайно
 * совпадало с «Пункт · Ревью макетов» и сужало цель без всякого основания — слово «макет»
 * там не про вмещающий слой. Предлог — тот самый признак, что человек указывает МЕСТО.
 */
const RE_HOST_PHRASE = /(?:^|[^\p{L}\p{N}])(?:в|во|внутри|внутрь|у)\s+((?:[\p{L}\p{N}«»'"·-]+)(?:\s+[\p{L}\p{N}«»'"·-]+){0,2})/giu;

function hostWords(utterance) {
  const out = new Set();
  const text = String(utterance == null ? '' : utterance).toLowerCase();
  RE_HOST_PHRASE.lastIndex = 0;
  let m = RE_HOST_PHRASE.exec(text);
  while (m) {
    for (const w of (m[1].match(/[\p{L}\p{N}]+/gu) || [])) {
      if (INS_STOP.has(w)) continue;
      const st = stemRu(w);
      if (st.length >= 3) out.add(st);
    }
    m = RE_HOST_PHRASE.exec(text);
  }
  return out;
}

/**
 * Круг 16, п.7: человек назвал ВМЕЩАЮЩИЙ узел словами — «в пункте про обед сделай время
 * серым», — а модель вернула цель «Время» без уточнения. Под «Время» подходят три узла, и
 * оформление честно ложилось на все три: названный человеком пункт в разрешении цели не
 * участвовал вовсе.
 *
 * Сужаем СТРОГО по фактам и ничего не выдумываем. У каждого кандидата смотрим имена его
 * предков и считаем, сколько слов из этих имён человек произнёс. Слова, которые нашлись у
 * ВСЕХ кандидатов, отбрасываем: «в таблице сделай сроки серыми» — «таблица» общий предок всех
 * сроков и не различает ничего, значит правим все, как раньше. Сужаем только если РОВНО У
 * ОДНОГО кандидата различающих слов больше, чем у остальных.
 *
 * Поэтому «в пунктах сделай время серым» (слово «пункт» есть у всех трёх) по-прежнему правит
 * все три, а «в пункте про обед» — только один: разницу делает слово «обед».
 * @returns {string|null} id единственного кандидата, либо null — сужать не за что
 */
function narrowBySpokenHost(doc, ids, utterance) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length < 2) return null;
  const said = hostWords(utterance);
  if (!said.size) return null;
  const hits = list.map((id) => {
    const words = new Set();
    let cur = nodeOf(doc, id);
    let guard = 0;
    while (cur && cur.parent && guard++ < 64) {
      cur = nodeOf(doc, cur.parent);
      if (!cur || cur.type === 'page') break;
      for (const w of String(cur.name || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
        const st = stemRu(w);
        if (st.length >= 3 && said.has(st)) words.add(st);
      }
    }
    return words;
  });
  const common = new Set([...hits[0]].filter((w) => hits.every((h) => h.has(w))));
  const own = hits.map((h) => [...h].filter((w) => !common.has(w)).length);
  const best = Math.max(...own);
  if (!best || own.filter((n) => n === best).length !== 1) return null;
  return list[own.indexOf(best)];
}

/**
 * Круг 11, п.2: способы поиска, которым можно доверить РОЛЬ КОНТЕЙНЕРА, когда модель не назвала
 * parent. Точное имя, id, роль движка и только что созданный узел названы осознанно; «частично
 * совпало с чем-то из документа» — нет.
 */
const TRUSTED_PARENT_HOW = new Set(['id', 'exact', 'role', 'created']);

export function resolveRef(engine, doc, ref, scope, warn, opts = {}) {
  const raw = String(ref == null ? '' : ref).trim();
  if (!raw) return null;
  if (isSelfRef(raw)) {
    if (opts.container) return (scope && scope.containerId) || doc.root;
    return (scope && scope.ids && scope.ids[0]) || (scope && scope.containerId) || doc.root;
  }
  const got = refCandidates(engine, doc, ref, scope, opts);
  if (!got.ids.length) {
    if (warn) warn(`Слой «${raw}» не найден — правка пропущена`);
    return null;
  }
  /* Круг 16, п.7: человек назвал вмещающий слой словами — сузим до него, если это факт. */
  let chosen = got.ids[0];
  let narrowed = null;
  if (opts.said && !opts.group && got.ids.length > 1 && AMBIGUOUS_HOW.has(got.how)) {
    narrowed = narrowBySpokenHost(doc, got.ids, opts.said);
    if (narrowed) chosen = narrowed;
  }
  if (warn && got.collision) warn(collisionNote(doc, raw, chosen));
  /**
   * Круг 5, п.1: предупреждение выдавалось только при частичном совпадении и совпадении по типу,
   * а при ТОЧНОМ — нет. В демо-документе имя «Время» носят три узла, «Статус» — пять: обычные
   * фразы дизайнера про колонку правили один узел из трёх-пяти молча, и человек читал
   * правдоподобное «Выключка правая в «Время»», не зная, что два других остались.
   */
  if (warn && got.ids.length > 1 && AMBIGUOUS_HOW.has(got.how)) {
    /**
     * Круг 7, п.6: перечисление уточнялось родителем, а ВЫБРАННЫЙ назывался коротко —
     * «подходит 3 («Текст пункта» в «Пункт · Обед»…); правлю «Текст пункта»»: непонятно, какой
     * из трёх. Называем выбранного ровно так же, как перечисляем остальных.
     */
    const labels = listNames(doc, got.ids);
    const names = labels.slice(0, 4).join(', ');
    const more = got.ids.length > 4 ? ` и ещё ${got.ids.length - 4}` : '';
    const pick = labels[got.ids.indexOf(chosen)] || nameOrId(doc, chosen);
    const what = opts.container
      ? `кладу в ${pick}`
      : narrowed
        ? `правлю ${pick} — его вы и назвали в команде`
        : `правлю ${pick}. Скажите «во всех…», чтобы поправить сразу все`;
    warn(`Под «${raw}» подходит слоёв — ${got.ids.length} (${names}${more}); ${what}.`);
  }
  if (warn && !got.inScope) { const out = outsideNote(doc, scope, chosen, opts.purpose); if (out) warn(out); }
  return chosen;
}

/**
 * Цели правки (п.1): «selection» разворачивается во ВСЕ выделенные узлы,
 * а не в их общий контейнер — иначе «сделай заголовок крупнее» правит фрейм.
 *
 * opts.group = true (круг 3, п.4) — формулировка групповая («во всех карточках…»,
 * «каждому пункту…»): тогда частичное совпадение применяется КО ВСЕМ подходящим узлам.
 */
export function resolveRefs(engine, doc, ref, scope, warn, opts = {}) {
  if (isSelfRef(ref)) {
    const ids = asArray(scope && scope.ids).filter((id) => nodeOf(doc, id));
    if (ids.length) return ids;
    const one = (scope && scope.containerId) || doc.root;
    return nodeOf(doc, one) ? [one] : [];
  }
  if (opts.group) {
    const got = refCandidates(engine, doc, ref, scope, opts);
    if (!got.ids.length) {
      if (warn) warn(`Слой «${String(ref).trim()}» не найден — правка пропущена`);
      return [];
    }
    /**
     * Круг 15, п.7: человек сказал «ВСЕ», а под ссылку подошёл ровно один узел — потому что
     * модель назвала точное имя одного элемента списка. Раскрываем на доказуемо однотипных
     * соседей и говорим об этом словами. Только для оформления (opts.uniform): содержимое и
     * имена оптом не переписываем — текст в каждом элементе свой.
     */
    if (opts.uniform && got.ids.length === 1) {
      const family = siblingRepeats(doc, got.ids[0]);
      if (family.length > 1) {
        if (warn) {
          const names = listNames(doc, family.slice(0, 5)).join(', ');
          const tail = family.length > 5 ? ` и ещё ${family.length - 5}` : '';
          warn(`Под «${String(ref).trim()}» нашёлся один слой, а просили про все: рядом такие же —`
            + ` правлю все ${family.length} (${names}${tail}). Нужен один — назовите его или выделите`);
          if (!got.inScope) { const out = outsideNote(doc, scope, family[0], opts.purpose); if (out) warn(out); }
        }
        return family;
      }
    }
    if (warn && got.collision) warn(collisionNote(doc, String(ref).trim(), got.ids[0]));
    if (warn && got.ids.length > 1) {
      const names = listNames(doc, got.ids.slice(0, 5)).join(', ');
      const tail = got.ids.length > 5 ? ` и ещё ${got.ids.length - 5}` : '';
      warn(`Под «${String(ref).trim()}» подходит слоёв — ${got.ids.length}: правлю все (${names}${tail})`);
    }
    if (warn && !got.inScope) { const out = outsideNote(doc, scope, got.ids[0], opts.purpose); if (out) warn(out); }
    return got.ids;
  }
  /**
   * Круг 5, п.1: правка ОФОРМЛЕНИЯ по точному имени колонки групповая по умолчанию.
   * «Сделай статусы серыми», «выровняй время по правому краю», «срок покажи жирнее» —
   * человек говорит о колонке целиком, и починить один узел из пяти значит соврать ему
   * правдоподобным отчётом. Содержимое (characters) и имя слоя оптом НЕ меняем: текст в
   * колонке у каждого свой. Выход из групповой правки — выделить нужный узел: область
   * сужается, и кандидат остаётся один.
   */
  if (opts.autoGroup) {
    const got = refCandidates(engine, doc, ref, scope, opts);
    if (got.how === 'exact' && got.ids.length > 1 && looksUniformColumn(doc, got.ids)) {
      /* Круг 16, п.7: «в пункте про обед сделай время серым» — цель названа человеком точнее,
       * чем моделью. Групповую правку колонки сужаем до одного узла, но только когда слово,
       * различающее его от соседей, и правда прозвучало. */
      const one = opts.said && !opts.group ? narrowBySpokenHost(doc, got.ids, opts.said) : null;
      if (one) {
        if (warn) {
          warn(`Под «${String(ref).trim()}» подходит слоёв — ${got.ids.length},`
            + ` но в команде назван вмещающий слой — правлю только ${nameOrId(doc, one)}.`
            + ' Нужны все — скажите «во всех…»');
          if (!got.inScope) { const out = outsideNote(doc, scope, one, opts.purpose); if (out) warn(out); }
        }
        return [one];
      }
      if (warn) {
        if (got.collision) warn(collisionNote(doc, String(ref).trim(), got.ids[0]));
        const names = listNames(doc, got.ids.slice(0, 5)).join(', ');
        const tail = got.ids.length > 5 ? ` и ещё ${got.ids.length - 5}` : '';
        warn(`Под «${String(ref).trim()}» подходит слоёв — ${got.ids.length}, и это одна колонка одного списка`
          + ` (${names}${tail}): оформление поправил у всех. Нужен один — выделите его и повторите`);
        if (!got.inScope) { const out = outsideNote(doc, scope, got.ids[0], opts.purpose); if (out) warn(out); }
      }
      return got.ids;
    }
  }
  const one = resolveRef(engine, doc, ref, scope, warn, opts);
  return one ? [one] : [];
}

/** Признак групповой формулировки: только явные квантификаторы, без угадывания по числу. */
const RE_GROUP_WIDE = [
  rx('вс(е|ех|ем|еми|ю|я|ё)', true), rx('кажд(ый|ую|ом|ой|ого|ые|ым|ому)'),
  rx('об(а|е|оих|еих)', true), rx('везде', true), rx('одинаков'), rx('подряд', true),
  rx('оптом', true), rx('поголовно', true), rx('без\\s+исключени'),
];

/**
 * Круг 3, п.4: как отличить групповую правку от одиночной. Только по явным словам-квантификаторам
 * («во всех карточках», «каждому пункту», «везде»). Числа и множественное число слов не считаем:
 * «поправь карточки» может означать и «ту, о которой мы говорили», и переспросить дешевле,
 * чем молча переписать полдокумента.
 */
export function looksGroupWide(utterance) {
  const s = String(utterance == null ? '' : utterance);
  return RE_GROUP_WIDE.some((r) => r.test(s));
}

/**
 * Все узлы поддеревьев, БЕЗ повторов (круг 13, п.3).
 *
 * Раньше повторы были: оболочка после правки выделяет всё, что агент задел (selectTouched), и
 * в выделении оказывались и фрейм, и его текст. collectSubtree проходил каждый корень отдельно,
 * текст попадал в список дважды — и человек на следующей команде читал «Под «Подпись кнопки»
 * подходит узлов — 2 («Подпись кнопки» в «Кнопка…», «Подпись кнопки» в «Кнопка…»); правлю
 * «Подпись кнопки»… Скажите «во всех…», чтобы поправить сразу все»: один и тот же узел дважды
 * и приглашение к действию, которое ничего не даст.
 */
function collectSubtree(doc, roots) {
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    const n = nodeOf(doc, id);
    if (!n) return;
    seen.add(id);
    out.push(id);
    for (const k of kidsOf(n)) walk(k);
  };
  for (const r of asArray(roots)) walk(r);
  return out;
}

/**
 * Круг 13, п.3: узлы, у которых в списке есть предок, выбрасываем. Выделить фрейм И его текст
 * — это то же самое, что выделить фрейм: поддерево у них общее, а как ДВЕ цели они дают
 * дублирующиеся операции (для nudge — два одинаковых override, для duplicate — лишнюю копию
 * ребёнка внутри копии родителя).
 */
function dropNested(doc, ids) {
  const uniq = [...new Set(asArray(ids))];
  if (uniq.length < 2) return { kept: uniq, nested: [] };
  const empty = new Map();
  const kept = [];
  const nested = [];
  for (const id of uniq) {
    if (uniq.some((other) => other !== id && isInside(doc, empty, id, other))) nested.push(id);
    else kept.push(id);
  }
  return { kept, nested };
}

const PATH_ALIASES = {
  text: 'characters', content: 'characters', label: 'characters', title: 'characters',
  w: 'size.w', width: 'size.w', h: 'size.h', height: 'size.h',
  gap: 'layout.gap', padding: 'layout.padding', mode: 'layout.mode',
  justify: 'layout.justify', wrap: 'layout.wrap', direction: 'layout.mode',
  bg: 'fill', background: 'fill', backgroundColor: 'fill', fontStyle: 'style', typography: 'style',
  cornerRadius: 'radius', borderRadius: 'radius', textColor: 'color',
};

const PROTECTED_PATHS = new Set(['id', 'type', 'parent', 'children', '__proto__', 'prototype', 'constructor']);
/** Ключи, которыми ломают прототип: в ИМЕНИ токена они недопустимы, а «id»/«type» — вполне. */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Белый список головных сегментов пути (п.8) — по модели узла core.js и SPEC §1.2.
 * Раньше проходил ЛЮБОЙ путь: модель могла поставить visible=false (узел исчезал из
 * решателя и отрисовки, а инспектор такого поля не показывает), locked=true, onclick="alert(1)".
 *
 * Круг 3, п.6: «pos» и «override» закрыты. Они задаются ОТНОСИТЕЛЬНО родителя, а выжимка
 * печатает абсолютные координаты холста, поэтому «сдвинь аватар на 10 влево» через set
 * уезжало в произвольную точку. Относительный сдвиг теперь выражается op:"nudge".
 */
export const ALLOWED_PATH_HEADS = new Set([
  'characters', 'style', 'align', 'color', 'fill', 'stroke', 'radius',
  'size', 'layout', 'name', 'opacity', 'src', 'clip',
  // круг 36 (SPEC §11): состояния (наведение, нажатие, фокус), движение между ними и тень
  'states', 'motion', 'shadow',
  // круг 19, п.3 (SPEC §5.5): «props.<имя>» — ОБЪЯВЛЕННОЕ свойство экземпляра компонента.
  // Единственный законный путь внутрь экземпляра: всё остальное у него задаёт компонент.
  'props',
]);

/** Пути, которыми модель пытается двигать узлы руками: у них есть честная замена. */
const MOVE_PATHS = new Set(['pos', 'override', 'x', 'y', 'left', 'top', 'position', 'offset']);

/**
 * Поля, которые в колонке одноимённых узлов ЕДИНЫ по смыслу: оформление, выключка, размеры.
 * «Сделай статусы серыми» — про все пять статусов. А characters, name и src — это содержимое,
 * у каждого элемента списка своё, и оптом его переписывать нельзя (круг 5, п.1).
 */
const UNIFORM_PATHS = new Set(['style', 'align', 'color', 'fill', 'stroke', 'radius', 'size', 'layout', 'opacity', 'clip',
  // круг 36: «оживи кнопки» — про все кнопки колонки так же, как «сделай кнопки темнее»
  'states', 'motion', 'shadow']);

/** Русские названия типов в родительном падеже: «поля нет у эллипса «Аватар»». */
const RU_TYPE = {
  frame: 'фрейма', text: 'текста', rect: 'прямоугольника',
  ellipse: 'эллипса', image: 'картинки', page: 'страницы',
  // круг 19: у экземпляра компонента свой разговор (см. adjustSetPath), но в общих строках
  // он тоже должен зваться по-русски
  instance: 'экземпляра компонента',
};

/** Поля, которые есть ТОЛЬКО у текста. */
const TEXT_ONLY_PATHS = new Set(['characters', 'style', 'align', 'color']);

/**
 * Кому принадлежит поле (круг 3, п.1). Раньше путь проверялся одним общим списком, без
 * оглядки на тип цели: «set style» на фрейме и «set fill» на тексте применялись, версия
 * документа росла, геометрия не менялась, предупреждений не было — человеку говорили
 * «Готово». А кнопка в этой модели — ФРЕЙМ с текстом внутри, поэтому модель адресует
 * фрейму текстовые свойства постоянно, и это не её ошибка, а наш недосмотр.
 * size, name и opacity есть у любого узла — их здесь нет.
 */
const PATH_OWNERS = {
  characters: ['text'], style: ['text'], align: ['text'], color: ['text'],
  fill: ['frame', 'rect', 'ellipse', 'image'],
  stroke: ['frame', 'rect', 'ellipse', 'image'],
  radius: ['frame', 'rect', 'ellipse', 'image'],
  layout: ['frame'],
  clip: ['frame'],
  src: ['image'],
};

/** Все текстовые потомки узла (без самого узла), в порядке документа. */
export function textDescendants(doc, id) {
  const out = [];
  const walk = (nid) => {
    const n = nodeOf(doc, nid);
    if (!n) return;
    if (n.type === 'text') out.push(nid);
    for (const k of kidsOf(n)) walk(k);
  };
  const root = nodeOf(doc, id);
  for (const k of kidsOf(root)) walk(k);
  return out;
}

/**
 * Сверка пути с типом цели (круг 3, п.1). Возвращает {id, path} — возможно, другие, —
 * либо null, если правку надо пропустить (с уже выданным предупреждением).
 *   • текстовый путь на фрейме → единственный текстовый потомок (для кнопки это ровно
 *     то, что человек имел в виду); нет текста или их несколько — пропуск с объяснением;
 *   • «align» на фрейме без единственного текста → layout.align (выравнивание содержимого);
 *   • fill/stroke/radius на тексте → пропуск, но с подсказкой про «color».
 */
export function adjustSetPath(doc, id, path, warn) {
  const note = warn || (() => {});
  const node = nodeOf(doc, id);
  if (!node) return { id, path };                  // узел создан этим же патчем — сверять нечем
  // круг 36 (SPEC §11): состояния и движение — своя сверка (страница, цвет текста у кнопки)
  if (isMotionPath(path)) return adjustMotionPath(doc, id, String(path), note);
  const head = String(path).split('.')[0];
  const owners = PATH_OWNERS[head];
  const who = nameOrId(doc, id);
  if (!owners || owners.includes(node.type)) return { id, path };

  /**
   * Круг 19, п.2 (SPEC §5.5): у ЭКЗЕМПЛЯРА своих внутренностей нет — их задаёт компонент, и в
   * документе их нет вовсе. Но у него есть ОБЪЯВЛЕННЫЕ свойства, и часть из них ведёт ровно на
   * тот путь, который просит модель: «текст» → characters, «вид» → fill. Если такое свойство
   * ровно одно, правку уводим в него — это то же самое, что уже делается для кнопки-фрейма
   * («сделай надпись другой» → её текст), и это именно то, о чём просил человек.
   *
   * Если подходящего свойства нет — отказ СЛОВАМИ, с перечнем того, что менять можно. Молча
   * записать экземпляру поле, которого он не показывает, значит соврать «готово»: решатель
   * берёт содержимое у мастера и такое поле не посмотрит.
   */
  if (node.type === 'instance') {
    const master = nodeOf(doc, node.of);
    const comp = master && master.component;
    const named = (comp && typeof comp.name === 'string' && comp.name.trim()) || 'компонента';
    const declared = (comp && Array.isArray(comp.props) ? comp.props : []).filter((x) => x && typeof x.name === 'string');
    const fit = declared.filter((x) => String(x.path) === String(path));
    if (fit.length === 1) {
      note(`${who} — экземпляр компонента «${named}», своего ${ruPathGen(path)} у него нет:`
        + ` правка ушла в его свойство «${fit[0].name}»`);
      return { id, path: `props.${fit[0].name}` };
    }
    note(`${who} — экземпляр компонента «${named}»: внутренности экземпляра не правятся, их задаёт сам компонент.`
      + (declared.length
        ? ` У экземпляра можно менять свойства: ${declared.map((x) => `«${x.name}»`).join(', ')}.`
        : ' Свойств компонент не объявлял вовсе.')
      + ' Правка пропущена — поменяйте свойство, поправьте компонент целиком или отсоедините экземпляр');
    return null;
  }

  if (TEXT_ONLY_PATHS.has(head) && (node.type === 'frame' || node.type === 'page')) {
    const kids = textDescendants(doc, id);
    const kind = node.type === 'page' ? 'страница' : 'фрейм';
    if (kids.length === 1) {
      const kid = nodeOf(doc, kids[0]);
      note(`${who} — ${kind}, ${ruPathGen(path)} у него нет: правка ушла в его единственный текст «${(kid && kid.name) || kids[0]}»`);
      return { id: kids[0], path };
    }
    if (head === 'align') {
      note(`${who} — ${kind}: «выключку» понял как выравнивание содержимого`);
      return { id, path: 'layout.align' };
    }
    if (!kids.length) {
      note(`Внутри ${who} нет текста — правка «${ruPath(path)}» пропущена: назовите слой, который надо поменять`);
      return null;
    }
    note(`Внутри ${who} текстовых слоёв — ${kids.length}, непонятно, какому задать «${ruPath(path)}»: правка пропущена, назовите слой по имени`);
    return null;
  }
  if (node.type === 'text' && (head === 'fill' || head === 'stroke' || head === 'radius')) {
    const hint = head === 'fill' ? ' Цвет самих букв — это «цвет текста», фон — заливка родителя.' : '';
    note(`У текста ${who} нет ${ruPathGen(head)} — правка пропущена.${hint}`);
    return null;
  }
  note(`У ${RU_TYPE[node.type] || node.type} ${who} нет ${ruPathGen(path)} — правка пропущена`);
  return null;
}

export function normalizePath(path) {
  let p = String(path == null ? '' : path).trim().replace(/^\./, '');
  if (!p) return '';
  if (PATH_ALIASES[p]) return PATH_ALIASES[p];
  p = p.replace(/^node\./, '');
  if (PATH_ALIASES[p]) return PATH_ALIASES[p];
  // круг 36: «hover.lift», «transition.duration», «boxShadow» → пути §11
  return normalizeMotionPath(p);
}

/**
 * Круг 7, п.8: число «на порядки больше» того, во что узел вложен, — это не «очень широко»,
 * а мусор в ответе модели. Замер: size.w:999999999 зажималось до 100000, и макет уезжал на
 * 99 702 px вправо — человек видел пустой холст и предупреждение «вылез за рамки».
 * Предел разумного для одного узла: 20 000 px (вдвое шире самого широкого реального макета).
 */
const ABSURD_PX = 20000;
/** Во сколько раз узел может быть больше родителя, прежде чем это перестанет быть замыслом. */
const ABSURD_FACTOR = 20;

/**
 * Число из ответа модели, как оно было до всякого приведения (null — числа нет).
 * Круг 9, п.2: единицы снимает общий parsePx — тот же, что и в clampPx, иначе «8px» в одном
 * пути значит 8, а в другом ноль.
 */
function rawNumber(v) {
  const got = parsePx(v);
  return got ? got.n : null;
}

/** Размер ближайшего родителя по оси: сначала посчитанный, потом фиксированный из документа. */
function parentExtent(doc, id, axis, geo) {
  const rects = rectsOf(geo);
  let cur = (nodeOf(doc, id) || {}).parent;
  let guard = 0;
  while (cur && guard++ < 64) {
    if (rects && rects[cur] && Number(rects[cur][axis]) > 0) return Number(rects[cur][axis]);
    const n = nodeOf(doc, cur);
    const spec = n && n.size && n.size[axis];
    if (spec && spec.mode === 'fixed' && Number(spec.value) > 0) return Number(spec.value);
    cur = n ? n.parent : null;
  }
  return null;
}

/**
 * Круг 15, п.10: сколько места ВНУТРИ родителя — с поправкой на его отступы.
 *
 * Валидатор core сверяет прямоугольник ребёнка с БОКСОМ родителя, а не с его внутренней
 * областью: «сделай кнопку на 20 пикселей шире» (350 → 370) внутри артборда 390 с padding 20
 * съедает правый отступ целиком, и out-of-parent не срабатывает — узел ведь остался в боксе.
 * Предупредить об этом можно на своей стороне: и отступы, и посчитанные ширины уже на руках.
 *
 * Родителя, который обнимает содержимое (hug), не считаем: он просто вырастет.
 * @returns {{inner:number, box:number, pad:number, parentId:string}|null}
 */
function parentInner(doc, id, axis, geo) {
  const node = nodeOf(doc, id);
  const pid = node ? node.parent : null;
  const parent = pid ? nodeOf(doc, pid) : null;
  if (!parent || parent.type !== 'frame') return null;
  const own = parent.size && parent.size[axis];
  if (own && own.mode === 'hug') return null;       // родитель растянется сам
  const pad = ((parent.layout && parent.layout.padding) || null);
  // круг 20 (SPEC §6.3): отступы — ссылки на шаги шкалы; Number('spacing.7') дал бы NaN и «без отступов»
  const side = (k) => { const n = scaleNum(doc, pad[k] == null ? 0 : pad[k], 'spacing', null); return Number.isFinite(n) ? n : 0; };
  const eaten = !pad ? 0 : axis === 'w' ? side('l') + side('r') : side('t') + side('b');
  if (!(eaten > 0)) return null;                    // без отступов и предупреждать не о чем
  const rects = rectsOf(geo);
  let box = rects && rects[pid] && Number(rects[pid][axis]) > 0 ? Number(rects[pid][axis]) : null;
  if (box == null && own && own.mode === 'fixed' && Number(own.value) > 0) box = Number(own.value);
  if (box == null) return null;
  return { inner: Math.max(0, box - eaten), box, pad: eaten, parentId: pid };
}

/**
 * Значение size.w / size.h: «hug», «fill», число — или пропуск с объяснением.
 * ctx = {id, geo} — цель правки и посчитанная геометрия: по ним видно, во что узел вложен.
 */
function sizeValue(raw, path, doc, note, ctx) {
  const spec = normSizeSpec(raw);
  const n = rawNumber(raw);
  if (!spec) {
    note(`Правка «${ruPath(path)}»: «${typeof raw === 'string' ? raw : JSON.stringify(raw)}» — не размер:`
      + ' нужно число пикселей, «по содержимому» или «во всё место»; правка пропущена');
    return undefined;
  }
  // число разбираем ДО normSizeSpec: ноль он уже превратил в hug, а сказать об этом надо
  if (n == null) return spec;
  const axis = path === 'size.h' ? 'h' : 'w';
  const side = axis === 'w' ? 'ширина' : 'высота';
  if (n <= 0) {
    note(`Правка «${side}»: ${n} — это невидимый слой, понял как «по содержимому»`);
    return { mode: 'hug' };
  }
  if (n > ABSURD_PX) {
    note(`Правка «${side}»: ${Math.round(n)} px — таких макетов не бывает (разумный предел ${ABSURD_PX});`
      + ' правка пропущена, скажите нужный размер');
    return undefined;
  }
  const parent = ctx ? parentExtent(doc, ctx.id, axis, ctx.geo) : null;
  if (parent && n > parent * ABSURD_FACTOR) {
    const pname = nameOrId(doc, (nodeOf(doc, ctx.id) || {}).parent || '');
    note(`Правка «${side}»: ${Math.round(n)} px при родителе ${pname} в ${Math.round(parent)} px —`
      + ' это в разы больше макета; правка пропущена, скажите нужный размер');
    return undefined;
  }
  /* Круг 15, п.10: размер влез в бокс родителя, но съел его отступы. Валидатор core этого не
   * видит (он сверяет бокс, а не внутреннюю область), так что говорим сами — и применяем:
   * человек мог этого и хотеть, а решать за него нельзя. */
  const room = ctx ? parentInner(doc, ctx.id, axis, ctx.geo) : null;
  if (room && n > room.inner + 0.5) {
    const what = axis === 'w' ? 'боковые' : 'вертикальные';
    note(`Правка «${side}»: ${Math.round(n)} px — внутри ${nameOrId(doc, room.parentId)} свободно`
      + ` ${Math.round(room.inner)} px (${Math.round(room.box)} минус отступы ${Math.round(room.pad)}):`
      + ` слой съест ${what} отступы контейнера. Поправку сделал — скажите ${Math.round(room.inner)},`
      + ' если отступы надо сохранить');
  }
  return spec;
}

const BOOL_WORDS = {
  true: true, '1': true, yes: true, on: true, да: true, вкл: true, включить: true, включи: true,
  false: false, '0': false, no: false, off: false, нет: false, выкл: false, выключить: false, выключи: false,
};

/**
 * Круг 13, п.1: ЗНАЧЕНИЕ-ПРОСЬБА «сними это свойство».
 *
 * В инспекторе есть кнопка «Без заливки»: она зовёт setProp(id, 'fill', undefined), то есть
 * core.applyOps(doc, [{op:'set', id, path:'fill'}]) — без поля value, — и заливка снимается.
 * У агента этого не было НИ В КАКОМ виде: coerceValue → normColor возвращал undefined на «»,
 * «none», «нет», «прозрачный», «transparent», «null», «0», «убрать», правка выбрасывалась,
 * а на единственной правке patchToOps бросал фатальное «Ни одну правку не удалось применить».
 * Человек читал красное сообщение с кнопкой «Повторить», которая никогда не срабатывала, а
 * модель на починке честно сообщала «снять заливку в этой модели нельзя» — и это была ЛОЖЬ:
 * руками это делается одной кнопкой.
 *
 * Поэтому «пусто» — не мусор, а полноценное значение: UNSET. patchToOps превращает его в
 * set БЕЗ value, и дальше работает тот же путь, что у кнопки инспектора.
 */
export const UNSET = Symbol('снять свойство');

/**
 * Слова, которыми просят снять свойство. Закрытый список: догадываться тут нельзя —
 * «серый» и «none» должны расходиться, а не сливаться в «что-то непонятное».
 */
const CLEAR_WORDS = new Set([
  '', 'none', 'no', 'нет', 'нету', 'null', 'nil', 'undefined', 'empty', 'unset', 'clear', 'remove',
  'default', 'по умолчанию', 'никакой', 'никакого', 'никакая', 'отсутствует', 'без',
  'прозрачный', 'прозрачная', 'прозрачное', 'прозрачно', 'transparent',
  'убрать', 'убери', 'уберите', 'снять', 'сними', 'снимите', 'сбросить', 'сброс', 'сбрось',
]);

/** «без заливки», «без обводки», «без скругления» — то же самое, но с предметом. */
const CLEAR_PHRASE = /^без\s+(заливк\p{L}*|фона|обводк\p{L}*|рамк\p{L}*|границ\p{L}*|цвета|скруглени\p{L}*|радиуса|углов|прозрачности|картинк\p{L}*|стиля|выключки|раскладки|отступов|зазора)$/u;

/**
 * Свойства, которые движок умеет СНИМАТЬ: у core.checkNode они необязательные. Часть из них
 * снимается и руками — «Без заливки», «Без цвета», «Вернуть в поток» (override) в инспекторе, —
 * а остальные ровно так же необязательны в модели документа, и повод различать их пропадает.
 * Здесь же видно, чего в списке НЕТ: characters, name и size. У текста characters обязателен,
 * у узла обязателен size, снять их нельзя ни руками, ни агентом; пустая строка для текста —
 * это значение (пустой текст), а «hug»/«fill» для размера — честная замена «убери ширину».
 */
export const CLEARABLE_PATHS = new Set([
  'fill', 'stroke', 'color', 'radius', 'opacity', 'src', 'clip', 'style', 'align', 'override',
  'layout', 'layout.mode', 'layout.gap', 'layout.padding', 'layout.align', 'layout.justify', 'layout.wrap',
  // круг 36 (SPEC §11): «убери анимации» — снять states и motion целиком или по полю, тень — тоже
  ...motionClearablePaths(),
]);

/** Пути, где «0» — не число, а «ничего»: цвета и адрес картинки числом не задаются. */
const CLEAR_BY_ZERO = new Set(['fill', 'stroke', 'color', 'src', 'style']);

/**
 * Пути, которые снять НЕЛЬЗЯ, и подсказка вместо отказа.
 *
 * characters и name сюда сознательно НЕ входят, хотя снять их тоже нельзя: у текста «нет»,
 * «none» и «убрать» — это законное СОДЕРЖИМОЕ («напиши в статусе «нет»»), и толковать его
 * как просьбу снять свойство значило бы отнять у человека обычную команду. Пустая строка
 * там — это пустой текст, тоже значение. Про «убери текст» отвечает ветка remove.
 */
const NOT_CLEARABLE_HINT = {
  size: 'размер снять нельзя — скажите «по содержимому» или «во всё место»',
  'size.w': 'ширину снять нельзя — скажите «по содержимому» или «во всю ширину»',
  'size.h': 'высоту снять нельзя — скажите «по содержимому» или «во всю высоту»',
};

/** Поля-содержимое: у них любое слово — это текст, а не просьба что-то снять. */
const STRING_CONTENT_PATHS = new Set(['characters', 'name']);

/**
 * Подсказки для {op:"remove", path:"…"} (круг 13, п.2): там «убери текст» и «убери ширину» —
 * живые просьбы, и ответ «такого поля нет» был бы отпиской. У каждой есть честная замена.
 */
const REMOVE_PATH_HINT = {
  ...NOT_CLEARABLE_HINT,
  characters: 'текст слоя снять нельзя — скажите, что в нём написать («напиши пусто»),'
    + ' или попросите удалить сам слой',
  name: 'имя слоя снять нельзя — скажите новое имя',
};

/**
 * Просят ли этим значением СНЯТЬ свойство. Возвращает true/false; о том, снимается ли
 * конкретный путь, решает вызывающий (CLEARABLE_PATHS).
 */
export function looksCleared(raw, path) {
  if (raw === null) return true;
  /* Поля value в правке нет вовсе — это ровно то, что делает кнопка инспектора «Без заливки»
   * (core.ops.set(id, path) без третьего аргумента), и так же это описано в промпте. */
  if (raw === undefined) return true;
  if (typeof raw === 'number') return false;       // 0 в radius — это ноль, а не «снять»
  if (typeof raw === 'boolean') return false;
  if (typeof raw === 'object') return false;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^«|»$/g, '');
  if (s === '0') return CLEAR_BY_ZERO.has(String(path || ''));
  if (CLEAR_WORDS.has(s)) return true;
  return CLEAR_PHRASE.test(s);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7a. Человеческие названия полей, токенов и значений (круг 16, п.9)
 *
 * Критик выписал строки, которые человек читает с сырыми латинскими словами:
 * ««Шапка»: «fill» и так нет», ««Дата»: «color» уже «muted»», «Поля «src» у эллипса
 * «Аватар» нет», «поверх токена стояли свои «жирность», letterSpacing». Внутреннее имя
 * поля и внутреннее имя токена — это НАШ словарь, а не его: в предупреждении их быть
 * не должно.
 *
 * Слова взяты из оболочки (app.js: PROP_NAMES, SWATCH_NAMES, TYPE_LABELS, ALIGN/JUSTIFY/
 * SIZE_LABELS) один к одному: если инспектор зовёт поле «Зазор», предупреждение агента
 * обязано звать его так же — иначе человек не свяжет одно с другим. Словари
 * экспортированы, чтобы оболочке было на что опереться и слова не разъехались.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Путь свойства узла → слово инспектора (именительный, со строчной буквы). */
export const PATH_RU = {
  characters: 'текст', name: 'имя', align: 'выключка', color: 'цвет текста',
  fill: 'заливка', stroke: 'обводка', radius: 'скругление', opacity: 'прозрачность',
  src: 'источник', clip: 'обрезка', style: 'стиль текста',
  size: 'размер', 'size.w': 'ширина', 'size.h': 'высота',
  layout: 'раскладка', 'layout.gap': 'зазор', 'layout.padding': 'отступ',
  'layout.mode': 'поток', 'layout.align': 'выравнивание',
  'layout.justify': 'распределение', 'layout.wrap': 'перенос',
  'style.token': 'стиль текста', 'style.fontSize': 'кегль', 'style.fontWeight': 'жирность',
  'style.lineHeight': 'интерлиньяж', 'style.letterSpacing': 'трекинг', 'style.font': 'гарнитура',
  'stroke.color': 'цвет обводки', 'stroke.width': 'толщина обводки',
  override: 'положение', pos: 'положение',
  // хвосты путей: в правках модели приходит и «gap», и «padding.t», и «w», и «fontWeight»
  gap: 'зазор', padding: 'отступ', mode: 'поток', justify: 'распределение', wrap: 'перенос',
  w: 'ширина', h: 'высота', fontSize: 'кегль', fontWeight: 'жирность',
  lineHeight: 'интерлиньяж', letterSpacing: 'трекинг', font: 'гарнитура', token: 'стиль текста',
  // круг 36 (SPEC §11); вложенные пути состояний переводит motionPathRu
  states: 'состояния', motion: 'анимация', shadow: 'тень',
};

/** Тот же словарь в родительном падеже: «и так нет заливки», «нет адреса картинки». */
const PATH_RU_GEN = {
  characters: 'текста', name: 'имени', align: 'выключки', color: 'цвета текста',
  fill: 'заливки', stroke: 'обводки', radius: 'скругления', opacity: 'прозрачности',
  src: 'источника', clip: 'обрезки', style: 'стиля текста',
  size: 'размера', 'size.w': 'ширины', 'size.h': 'высоты',
  layout: 'раскладки', 'layout.gap': 'зазора', 'layout.padding': 'отступа',
  'layout.mode': 'потока', 'layout.align': 'выравнивания',
  'layout.justify': 'распределения', 'layout.wrap': 'переноса',
  'style.token': 'стиля текста', 'style.fontSize': 'кегля', 'style.fontWeight': 'жирности',
  'style.lineHeight': 'интерлиньяжа', 'style.letterSpacing': 'трекинга', 'style.font': 'гарнитуры',
  'stroke.color': 'цвета обводки', 'stroke.width': 'толщины обводки',
  override: 'положения', pos: 'положения',
  gap: 'зазора', padding: 'отступа', mode: 'потока', justify: 'распределения', wrap: 'переноса',
  w: 'ширины', h: 'высоты', fontSize: 'кегля', fontWeight: 'жирности',
  lineHeight: 'интерлиньяжа', letterSpacing: 'трекинга', font: 'гарнитуры', token: 'стиля текста',
  states: 'состояний', motion: 'анимации', shadow: 'тени',
};

/** Сторона отступа словами: «padding.t» — это «отступ сверху». */
const SIDE_RU = { t: 'сверху', r: 'справа', b: 'снизу', l: 'слева' };

function lookupPath(table, path) {
  const p = String(path == null ? '' : path).trim().replace(/^\.+|\.+$/g, '');
  if (!p) return null;
  const parts = p.split('.');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && SIDE_RU[last]) {
    const head = lookupPath(table, parts.slice(0, -1).join('.'));
    return head ? `${head} ${SIDE_RU[last]}` : null;
  }
  if (table[p]) return table[p];
  const two = parts.slice(0, 2).join('.');
  if (table[two]) return table[two];
  if (table[parts[0]]) return table[parts[0]];
  if (table[last]) return table[last];
  return null;
}

/**
 * Путь свойства словами человека. Незнакомое поле возвращается КАК ЕСТЬ — и это правильно:
 * незнакомые пути приходят только от модели («rotation», «boxShadow»), это её слово, а не
 * наше, и в ответе «такого поля у узла нет» его и надо показать.
 */
export function ruPath(path) {
  const p = String(path == null ? '' : path);
  /* Круг 19: свойство экземпляра зовётся тем именем, которое объявил компонент, — оно
   * русское и пришло из документа, переводить его не из чего и незачем. */
  if (/^props(\.|$)/.test(p)) {
    const nm = p.slice('props.'.length).trim();
    return nm ? `свойство «${nm}»` : 'свойство компонента';
  }
  // круг 36: «подъём при наведении», «скорость анимации»
  const motion = motionPathRu(p);
  if (motion) return motion;
  return lookupPath(PATH_RU, path) || p || 'свойство';
}
/** То же в родительном падеже — для «и так нет …». */
export function ruPathGen(path) {
  const p = String(path == null ? '' : path);
  if (/^props(\.|$)/.test(p)) {
    const nm = p.slice('props.'.length).trim();
    return nm ? `свойства «${nm}»` : 'свойства компонента';
  }
  const motion = motionPathRu(p, true);
  if (motion) return motion;
  return lookupPath(PATH_RU_GEN, path) || `«${p}»`;
}

/** Цветовые токены документа словами (те же, что в палитре оболочки). */
export const COLOR_TOKEN_RU = {
  canvas: 'холст', surface: 'карточка', surfaceAlt: 'подложка', line: 'линия',
  text: 'текст', muted: 'приглушённый', onAccent: 'на акценте',
  accent: 'акцент', accentSoft: 'акцент мягкий', accentInk: 'акцент тёмный',
  agent: 'агент', good: 'успех', warn: 'внимание',
};

/** Типографические токены документа словами (те же, что в инспекторе). */
export const TYPE_TOKEN_RU = {
  display: 'крупный', title: 'заголовок', heading: 'подзаголовок', body: 'текст',
  caption: 'подпись', mono: 'моноширинный', monoLg: 'моноширинный крупный',
};

/**
 * Имя токена словами. Токен, придуманный моделью («brandBlue»), человеческого названия
 * не имеет — показываем как есть: выдумывать перевод внутреннего имени нельзя.
 */
export function ruToken(kind, name) {
  const key = String(name == null ? '' : name);
  const table = kind === 'type' ? TYPE_TOKEN_RU : COLOR_TOKEN_RU;
  return table[key] || key;
}

/** Значения-перечисления словами (как подписаны кнопки инспектора). */
const ENUM_RU = {
  'layout.mode': { none: 'свободно', row: 'строка', column: 'столбец' },
  'layout.align': { start: 'по началу', center: 'по центру', end: 'по концу', stretch: 'растянуть' },
  'layout.justify': { start: 'в начало', center: 'по центру', end: 'в конец', between: 'с промежутками' },
  // выключка текста: слова кнопок инспектора («левая», «центр», «правая»)
  align: { left: 'левая', center: 'по центру', right: 'правая' },
};

/** Значение перечисления словами человека (незнакомое — как есть, врать не будем). */
export function ruEnum(field, value) {
  const table = ENUM_RU[String(field == null ? '' : field)];
  const key = String(value == null ? '' : value);
  return (table && table[key]) || key;
}

/** Значение для человека: «по содержимому», «350 px», «приглушённый», «16 px (шаг шкалы)». */
function valueWords(v, path, doc = null, engine = null) {
  if (v === UNSET || v === undefined || v === null) return '«не задано»';
  const p = String(path == null ? '' : path);
  if (typeof v === 'boolean') return v ? '«да»' : '«нет»';
  // круг 36: «подъём 2 px», «тень «средняя»», «120 мс» — без motion.fast и shadow.md
  if (isMotionPath(p)) { const w = motionValueWords(v, p, doc, engine); if (w) return w; }
  /* Круг 20 (SPEC §6.7): ссылка на шаг человеку показывается ЧИСЛОМ с пометкой «шаг шкалы» —
   * слов spacing и radii в его строках нет. Отступы — одним числом, если стороны равны. */
  const scale = scaleOfPath(p);
  if (scale && (typeof v === 'number' || typeof v === 'string')) return scaleValueWords(doc, v, scale, engine);
  if (scale === 'spacing' && v && typeof v === 'object' && !Array.isArray(v)) {
    const sides = ['t', 'r', 'b', 'l'].map((k) => v[k]);
    const nums = sides.map((x) => scaleNum(doc, x == null ? 0 : x, 'spacing', engine));
    const refs = sides.filter((x) => parseRef(x)).length;
    const tail = refs === 4 ? ' (шаги шкалы)' : refs ? ' (частью по шкале)' : '';
    const shown = nums.map((n) => (n === undefined ? '?' : Math.round(n)));
    return (shown.every((n) => n === shown[0]) ? `${shown[0]} px` : `${shown.join('/')} px`) + tail;
  }
  const en = ENUM_RU[p];
  if (en && typeof v === 'string' && en[v]) return `«${en[v]}»`;
  // токен вместо внутреннего имени: «style» уже «крупный», а не «display» (круг 16, п.9)
  if (p === 'style' || p === 'style.token') {
    const token = typeof v === 'object' ? (v && v.token) : v;
    if (token && typeof token === 'string') return `«${ruToken('type', token)}»`;
  }
  if (p === 'fill' || p === 'color' || p === 'stroke' || p === 'stroke.color') {
    const ref = colorRef(v);
    if (ref) return ref[0] === '#' ? ref : `«${ruToken('colors', ref)}»`;
  }
  if (v && typeof v === 'object' && v.mode) {
    if (v.mode === 'fixed') return `${Math.round(numOf(v.value) || 0)} px`;
    if (v.mode === 'hug') return '«по содержимому»';
    if (v.mode === 'fill') return '«во всю ширину»';
    return sizeWord(v);
  }
  if (v && typeof v === 'object' && (p === 'layout.padding' || p === 'padding')) {
    const s = ['t', 'r', 'b', 'l'].map((k) => Math.round(numOf(v[k]) || 0));
    return s.every((n) => n === s[0]) ? `${s[0]} px` : `${s.join('/')} px`;
  }
  if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch { return '«?»'; } }
  return `«${wordOf(v)}»`;
}

/** Строковое значение модели → значение нужного узлу типа. ctx = {id, geo} — для проверки размеров. */
export function coerceValue(raw, path, doc, warn, ctx = null) {
  const p = String(path || '');
  const note = warn || (() => {});
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[[{]/.test(s)) { const parsed = tryParse(s); if (parsed !== undefined) v = parsed; }
    else if (/^-?\d+(\.\d+)?$/.test(s)) v = Number(s);
    else if (s === 'true') v = true;
    else if (s === 'false') v = false;
    else if (s === 'null') v = null;
    else v = s;
  }
  /* Круг 13, п.1: «снять свойство» решается ДО разбора по типам — иначе «прозрачный» уходит
   * в normColor и возвращается «неизвестным цветом», а «» в clampPx и возвращается «не числом». */
  /**
   * Токен документа важнее слова-«пусто»: если в палитре завели цвет с именем «default» или
   * «no», просьба поставить его не должна превратиться в снятие заливки.
   */
  const tokenNamed = typeof raw === 'string' && raw.trim() && (() => {
    const key = raw.trim();
    const box = (p === 'fill' || p === 'stroke' || p === 'color')
      ? ((doc && doc.tokens && doc.tokens.colors) || null)
      : p === 'style' ? ((doc && doc.tokens && doc.tokens.type) || null) : null;
    return !!box && Object.prototype.hasOwnProperty.call(box, key);
  })();
  /* Круг 36: у тени «none» — значение («без тени» в состоянии поверх тени в покое), а не «снять»:
   * снять тень состояния значит вернуть тень покоя, и это другая картинка. */
  if ((p === 'shadow' || /^states\.[a-z]+\.shadow$/.test(p)) && typeof raw === 'string' && /^\s*(none|без тени)\s*$/i.test(raw)) return 'none';
  if (!tokenNamed && !STRING_CONTENT_PATHS.has(p) && looksCleared(raw, p)) {
    if (CLEARABLE_PATHS.has(p)) {
      /* Значение могли и просто забыть. Снять свойство — правка видимая и отменяемая, но сказать
       * об этом надо: иначе «поставь заливку» без цвета молча СНИМЕТ заливку. */
      if (raw === undefined) note(`Правка «${ruPath(p)}»: значения в ней не было — понял так, что это свойство надо снять`);
      return UNSET;
    }
    const hint = NOT_CLEARABLE_HINT[p];
    if (hint) { note(`Правка «${ruPath(p)}»: ${hint}; правка пропущена`); return undefined; }
    // остальные пути (например, несуществующие) разбираем как раньше
  }
  if (p === 'size.w' || p === 'size.h') return sizeValue(v, p, doc, note, ctx);
  // круг 36 (SPEC §11): состояния, движение, тень — ссылки на шкалы движения/тени/отступов
  if (isMotionPath(p)) return motionCoerce(v, p, doc, note, { engine: ctx && ctx.engine, said: ctx && ctx.said });
  if (p === 'size') {
    const w = v && v.w !== undefined ? sizeValue(v.w, 'size.w', doc, note, ctx) : undefined;
    const h = v && v.h !== undefined ? sizeValue(v.h, 'size.h', doc, note, ctx) : undefined;
    return w || h ? { ...(w ? { w } : {}), ...(h ? { h } : {}) } : undefined;
  }
  /* Круг 20 (SPEC §6.6): зазор, поля и скругление живут на шкале. Ссылка от модели проверяется
   * (та ли шкала, жив ли шаг) и идёт как есть; число на шаге становится ссылкой; число мимо
   * шкалы — по правилу scaleValue (см. там же, почему). clampPx строку-ссылку не понимает —
   * поэтому сюда, до него. */
  const scaleOpts = { engine: ctx && ctx.engine, said: ctx && ctx.said };
  /**
   * Число от модели, РАВНОЕ числу, которое уже стоит в узле, остаётся числом (§6.4): «сделай
   * скругление 12», когда там и так число 12, — пустая правка, а не «перевод поля на шкалу».
   * Перевести число в ссылку модель может явно — прислав ссылку. Ссылку от модели это правило
   * не трогает: ссылка поверх равного числа — настоящая правка по §6.4.
   */
  const curAt = ctx && ctx.id ? currentValue(nodeOf(doc, ctx.id), p) : undefined;
  const keepNumber = (cur, rawSide, got, scale) => {
    if (typeof cur !== 'number' || typeof got !== 'string' || parseRef(rawSide)) return got;
    return scaleNum(doc, got, scale, scaleOpts.engine) === cur ? cur : got;
  };
  const rawSides = (r) => {
    const box = paddingShorthandMirror(typeof r === 'string' && /^[[{]/.test(r.trim()) ? (tryParse(r.trim()) ?? r) : r);
    return box || { t: r, r, b: r, l: r };
  };
  if (p === 'layout.padding') {
    const got = normPadding(v, note, 'Правка «отступ»', { doc, ...scaleOpts });
    if (!got || !curAt || typeof curAt !== 'object') return got;
    const rs = rawSides(raw);
    const out = {};
    for (const k of ['t', 'r', 'b', 'l']) out[k] = keepNumber(curAt[k], rs[k], got[k], 'spacing');
    return out;
  }
  if (/^layout\.padding\.[trbl]$/.test(p)) {
    return keepNumber(curAt, raw, scaleValue(v, 'spacing', doc, note, `Правка «${ruPath(p)}»`, scaleOpts), 'spacing');
  }
  if (p === 'layout.gap' || p === 'radius') {
    const scale = scaleOfPath(p);
    return keepNumber(curAt, raw, scaleValue(v, scale, doc, note, `Правка «${ruPath(p)}»`, scaleOpts), scale);
  }
  if (p === 'layout' && v && typeof v === 'object' && !Array.isArray(v)) {
    // раскладка целиком: зазор и поля внутри неё — по тому же правилу, остальное как есть
    const out = { ...v };
    const curL = curAt && typeof curAt === 'object' ? curAt : {};
    if (v.gap !== undefined) {
      const gap = scaleValue(v.gap, 'spacing', doc, note, 'Правка «зазор»', scaleOpts);
      if (gap === undefined) return undefined;
      out.gap = keepNumber(curL.gap, v.gap, gap, 'spacing');
    }
    if (v.padding !== undefined) {
      const padding = normPadding(v.padding, note, 'Правка «отступ»', { doc, ...scaleOpts });
      if (padding === undefined) return undefined;
      const curP = curL.padding && typeof curL.padding === 'object' ? curL.padding : {};
      const rs = rawSides(v.padding);
      out.padding = {};
      for (const k of ['t', 'r', 'b', 'l']) out.padding[k] = keepNumber(curP[k], rs[k], padding[k], 'spacing');
    }
    return out;
  }
  if (p === 'layout.wrap' || p === 'clip') {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const key = String(v == null ? '' : v).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BOOL_WORDS, key)) return BOOL_WORDS[key];
    note(`Правка «${ruPath(p)}»: «${key}» — это не «да» и не «нет»: правка пропущена`);
    return undefined;
  }
  if (p === 'layout.mode' || p === 'layout.align' || p === 'layout.justify' || p === 'align') {
    return pickEnum(v, p, { warn: note, what: `Правка «${ruPath(p)}»` });
  }
  if (p === 'fill' || p === 'color' || p === 'stroke') return normColor(v, doc, note, `Правка «${ruPath(p)}»`);
  if (p === 'style' || p === 'style.token') {
    // круг 27: правка существующего узла — незнакомый стиль не подменяется обычным текстом
    const node = ctx && ctx.id ? nodeOf(doc, ctx.id) : null;
    const cur = node ? node.style : undefined;
    const got = normStyle(v, doc, note, 'Правка «стиль текста»', { mode: 'edit', cur: p === 'style.token' && cur && typeof cur === 'object' ? cur.token : cur });
    if (p === 'style.token' && got && typeof got === 'object') return got.token;
    return got;
  }
  if (p === 'characters') {
    // круг 13, п.1: текст снять нельзя, но «пусто» — законное содержимое; о молчаливом
    // опустошении слоя предупреждаем, иначе забытое значение читается как выполненная правка
    if (raw === undefined) note('Правка «текст»: текста в правке не было — поставил пустую строку');
    return clampChars(raw == null ? '' : typeof raw === 'string' ? raw : v, warn, 'Правка «текст»');
  }
  if (p === 'src') return safeSrc(v, note, 'Картинка');
  if (p === 'opacity') {
    // круг 9, п.2: «60%» — самая частая форма ответа модели, и она не должна теряться
    const pct = typeof v === 'string' && /^-?\d+(?:[.,]\d+)?\s*%$/.test(v.trim());
    const n = pct ? Number(v.trim().replace('%', '').replace(',', '.').trim()) / 100 : Number(v);
    if (!Number.isFinite(n)) { note(`Правка «прозрачность»: «${v}» — не число: правка пропущена`); return undefined; }
    if (n >= 0 && n <= 1) return n;
    if (n > 1 && n <= 100) {
      const got = Math.round(n) / 100;
      note(`Правка «прозрачность»: ${n} понял как ${Math.round(n)}% — поставил ${got}`);
      return got;
    }
    note(`Правка «прозрачность»: ${n} — прозрачность задаётся числом от 0 до 1: правка пропущена`);
    return undefined;
  }
  return v;
}

/** Значение, которое стоит на этом пути у узла (или undefined). */
function currentValue(node, path) {
  let cur = node;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Круг 7, п.7: правка, совпавшая с текущим значением, читалась как сделанная работа —
 * `set Дата.color="muted"` при уже «muted» давало человеку «Цвет текста muted в «Дата»».
 * Операцию оставляем (иначе единственная такая правка стала бы красной ошибкой «ни одну правку
 * не удалось применить», а «у вас уже так» — это не авария), но говорим об этом словами.
 * Сравнение бережное: core хранит style как {token:"caption"}, а модель присылает имя токена.
 */
/** '#FFF' и '#ffffff' — один цвет; нужно только для показа значения человеку. */
function hexNorm(s) {
  const t = String(s).trim();
  if (/^#[0-9a-fA-F]{3}$/.test(t)) return '#' + t.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(t)) return t.slice(0, 7).toLowerCase();
  return t;
}

/**
 * Ссылка на цвет из любой формы: 'accent', {token:'accent'}, {color:'accent'}, {value:'#fff'} —
 * core.resolveColor читает их как одно и то же, в таком же порядке предпочтения. Нужна, чтобы
 * НАЗВАТЬ значение человеку словом; для ответа «поменялось или нет» есть wrapperKeeps ниже.
 */
function colorRef(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const pick = v.token !== undefined ? v.token : v.color !== undefined ? v.color : v.value;
    // круг 30: объект в token/color (документ до проверки формы) — не цвет, а не TypeError
    return pick == null || pick === '' || (typeof pick !== 'string' && typeof pick !== 'number') ? null : hexNorm(String(pick));
  }
  return v === '' || (typeof v !== 'string' && typeof v !== 'number') ? null : hexNorm(String(v));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Поля-обёртки: зеркало core.keepFieldForm (круг 16, п.1)
 *
 * Круг 16, поправка по замечанию координатора. Первая версия этой проверки исходила из
 * ДОГАДКИ о том, как ядро запишет строку поверх объекта: будто 'caption' поверх
 * {token:'caption', fontWeight:600} снимает надстройки. Ядро выбрало другое — путь без
 * потери данных: при СОВПАДАЮЩЕМ имени токена поле остаётся байт в байт вместе со всеми
 * надстройками, и снимаются они только когда строка несёт ДРУГОЙ токен. Из-за расхождения
 * человек читал «поверх стиля стояли свои жирность, трекинг — они снимаются», хотя они
 * оставались, а «менять нечего» не вставало, и оболочка предлагала бесполезный «Повторить».
 *
 * Поэтому здесь не модель поведения, а его ЗЕРКАЛО: те же WRAPPED_FIELDS, тот же
 * wrappedName, тот же bareWrapper, тот же порядок правил, что в core.js. Инвариант,
 * закреплённый тестом на НАСТОЯЩЕМ applyOps: wrapperKeeps === «поле осталось байт в байт».
 * Если ядро когда-нибудь поменяет правило, упадёт тест, а не выйдет ложная строка человеку.
 * ──────────────────────────────────────────────────────────────────────────── */

const sameJSON = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

/** Поля-обёртки и ключи имени внутри них — копия core.js WRAPPED_FIELDS. */
const WRAPPED_FIELDS = {
  style: ['token'],
  fill: ['token', 'color', 'value'],
  color: ['token', 'color', 'value'],
  stroke: ['color', 'token', 'value'],
};

/** Имя токена внутри поля-обёртки (или сама строка) — копия core.js wrappedName. */
function wrappedName(v, keys) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  for (const k of keys) if (typeof v[k] === 'string') return v[k];
  return undefined;
}

/** Объект без ничего сверх обёртки: {token:'x'} — да, {token:'x',fontSize:20} — нет. */
function bareWrapper(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === 1 && keys.indexOf(own[0]) >= 0;
}

/**
 * Останется ли поле-обёртка БАЙТ В БАЙТ, если записать в него next.
 * Порядок правил — как в core.keepFieldForm:
 *   • имена токенов разные (или у текущего значения имени нет) → запись проходит как есть;
 *   • строка поверх объекта с тем же именем → остаётся объект (надстройки целы);
 *   • голая обёртка {token:'x'} поверх строки 'x' → остаётся строка;
 *   • иначе — записывается next, и «то же» только при полном совпадении.
 */
function wrapperKeeps(field, cur, next) {
  const keys = WRAPPED_FIELDS[field];
  if (!keys || next === undefined) return false;
  const a = wrappedName(cur, keys);
  if (a === undefined || a !== wrappedName(next, keys)) return false;
  if (typeof next === 'string' && cur && typeof cur === 'object') return true;
  if (typeof cur === 'string' && bareWrapper(next, keys)) return true;
  return sameJSON(cur, next);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Поля на шкале: зеркало core.keepFieldForm для круга 20 (SPEC §6.4)
 *
 * Правило ядра НЕсимметрично, и зеркало повторяет его буквально:
 *   • число, РАВНОЕ значению текущей ссылки (set gap=16 при 'spacing.6' = 16) — «то же»:
 *     поле остаётся ссылкой байт в байт;
 *   • ссылка поверх числа (set gap='spacing.6' при 16) — НЕ «то же»: число становится ссылкой,
 *     смысл меняется при той же картинке;
 *   • ссылка поверх ссылки — буквально: 'spacing.6' поверх 'spacing.6' то же, поверх 'spacing.5' нет,
 *     даже если шаги равны по значению.
 * Для целого layout и целого padding — по полям, а затем сверка с тем, что ядро запишет после
 * своей нормализации (normalizeLayout): недостающая сторона становится нулём, недостающий режим —
 * «none». Инвариант «sameAsNow === поле осталось байт в байт» закреплён тестом на настоящем
 * applyOps (круг 16, расширен здесь на все эти формы).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Копии перечислений ядра — для нормализации целого layout. */
const MIRROR_LAYOUT_MODES = new Set(['none', 'row', 'column']);
const MIRROR_ALIGNS = new Set(['start', 'center', 'end', 'stretch']);
const MIRROR_JUSTIFIES = new Set(['start', 'center', 'end', 'between']);
const MIRROR_MAX_SIZE = 100000;

/** Что ядро запишет по правилу keepScaleForm: число, равное значению текущей ссылки, → ссылка. */
function keepScaleMirror(doc, cur, value, scale, engine) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const ref = parseRef(cur);
  if (!ref || ref.scale !== scale || ref.ref !== cur) return value;
  return scaleNum(doc, cur, scale, engine) === value ? cur : value;
}

/** Копия core.spacingField: ссылка остаётся, число зажимается в 0..MAX_SIZE, мусор → 0. */
function spacingFieldMirror(v) {
  if (typeof v === 'string' && SCALE_REF_RE.test(v)) return v;
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > MIRROR_MAX_SIZE ? MIRROR_MAX_SIZE : v;
}

/** Копия core.paddingShorthand: краткая запись → {t,r,b,l} без приведения значений. */
function paddingShorthandMirror(p) {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  if (isNum(p) || (typeof p === 'string' && SCALE_REF_RE.test(p))) return { t: p, r: p, b: p, l: p };
  if (Array.isArray(p)) {
    if (p.length === 2) return { t: p[0], r: p[1], b: p[0], l: p[1] };
    if (p.length === 4) return { t: p[0], r: p[1], b: p[2], l: p[3] };
    if (p.length === 1) return { t: p[0], r: p[0], b: p[0], l: p[0] };
    return null;
  }
  if (p && typeof p === 'object') return { t: p.t, r: p.r, b: p.b, l: p.l };
  return null;
}

/** Копия core.normalizeLayout — порядок ключей тот же, это важно для сверки байт в байт. */
function normalizeLayoutMirror(l) {
  const src = l && typeof l === 'object' ? l : {};
  const padding = paddingShorthandMirror(src.padding) || { t: 0, r: 0, b: 0, l: 0 };
  for (const k of ['t', 'r', 'b', 'l']) padding[k] = spacingFieldMirror(padding[k]);
  return {
    mode: MIRROR_LAYOUT_MODES.has(src.mode) ? src.mode : 'none',
    gap: spacingFieldMirror(src.gap),
    padding,
    align: MIRROR_ALIGNS.has(src.align) ? src.align : 'start',
    justify: MIRROR_JUSTIFIES.has(src.justify) ? src.justify : 'start',
    wrap: !!src.wrap,
  };
}

/** Одно поле на шкале (gap, padding.t, radius): останется ли байт в байт. */
function scaleKeeps(doc, cur, next, scale, engine) {
  if (next === undefined) return false;
  return keepScaleMirror(doc, cur, next, scale, engine) === cur;
}

/** Скругление, в том числе покорнерный массив (поэлементно при равной длине). */
function radiusKeeps(doc, cur, next, engine) {
  if (Array.isArray(next)) {
    if (!Array.isArray(cur) || cur.length !== next.length) return false;
    return next.every((v, i) => keepScaleMirror(doc, cur[i], v, 'radii', engine) === cur[i]);
  }
  return scaleKeeps(doc, cur, next, 'radii', engine);
}

/** Целые поля отступов: то, что ядро запишет и затем нормализует, против того, что лежит. */
function paddingKeeps(doc, cur, next, engine) {
  const box = paddingShorthandMirror(next);
  if (!box || !cur || typeof cur !== 'object') return sameJSON(cur, next);
  const kept = {};
  for (const k of ['t', 'r', 'b', 'l']) if (box[k] !== undefined) kept[k] = keepScaleMirror(doc, cur[k], box[k], 'spacing', engine);
  // после set ядро прогоняет layout через normalizeLayout: сторона без значения становится нулём
  const norm = normalizeLayoutMirror({ padding: kept }).padding;
  return sameJSON(norm, cur);
}

/** Целый layout: gap и padding по правилу шкал, остальное как есть, затем нормализация ядра. */
function layoutKeeps(doc, cur, next, engine) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return sameJSON(cur, next);
  if (!cur || typeof cur !== 'object') return false;
  const out = { ...next };
  if (next.gap !== undefined) out.gap = keepScaleMirror(doc, cur.gap, next.gap, 'spacing', engine);
  if (next.padding !== undefined) {
    const box = paddingShorthandMirror(next.padding);
    if (box) {
      const curPad = cur.padding && typeof cur.padding === 'object' ? cur.padding : {};
      const kept = {};
      for (const k of ['t', 'r', 'b', 'l']) if (box[k] !== undefined) kept[k] = keepScaleMirror(doc, curPad[k], box[k], 'spacing', engine);
      out.padding = kept;
    }
  }
  return sameJSON(normalizeLayoutMirror(out), cur);
}

/**
 * Круг 16, п.1: сравнение стало СМЫСЛОВЫМ и ПО ПОЛЮ. «Сделай заголовок сводки крупным» при
 * уже стоящем style {token:"display"} даёт от модели set style="display" — то же значение в
 * другой форме, и раньше это считалось изменением документа: человек читал главную строку
 * «Стиль текста display → крупный» и рядом приписку «эта правка ничего не меняет».
 *
 * Для полей-обёрток (style, fill, color, stroke) ответ даёт wrapperKeeps — зеркало ядра, а не
 * догадка о нём. Для вложенных путей (stroke.color, style.fontSize) ядро пишет значение прямо,
 * поэтому «то же» там значит буквальное совпадение — этим занимается общий хвост.
 *
 * Отдельно — значения ПО УМОЛЧАНИЮ: core рисует отсутствующую прозрачность как 1, а
 * отсутствующую обрезку как «нет». set opacity=1 у узла без прозрачности документ меняет,
 * а экран — нет; это тот же заведомо пустой случай.
 */
export function sameAsNow(cur, next, path, doc = null, engine = null) {
  const p = String(path == null ? '' : path);
  if (WRAPPED_FIELDS[p]) return wrapperKeeps(p, cur, next);
  if (p === 'opacity' && cur === undefined) return Number(next) === 1;
  if (p === 'clip' && cur === undefined) return next === false;
  /* Круг 20 (SPEC §6.4): поля на шкале — зеркало core.keepFieldForm (см. scaleKeeps ниже). */
  if (p === 'layout.gap' || /^layout\.padding\.[trbl]$/.test(p)) return scaleKeeps(doc, cur, next, 'spacing', engine);
  if (p === 'radius') return radiusKeeps(doc, cur, next, engine);
  if (p === 'layout.padding') return paddingKeeps(doc, cur, next, engine);
  if (p === 'layout') return layoutKeeps(doc, cur, next, engine);
  if (cur === next) return true;
  if (cur == null || next == null) return false;
  if (typeof cur === 'object' && typeof next !== 'object') {
    if (typeof cur.token === 'string') return cur.token === String(next);
    if (typeof cur.color === 'string') return cur.color === String(next);
    return false;
  }
  if (typeof cur === 'object' && typeof next === 'object') return sameJSON(cur, next);
  return String(cur) === String(next);
}

/**
 * Круг 15, п.6: доказуемо пустой патч. Если ВСЕ операции — set, совпавший с текущим состоянием
 * («поставь скругление 12», когда оно уже 12; «убери фон у шапки», когда фона и не было), —
 * документ не может измениться ни при каком движке. Просить модель «выбрать другие цели» тут
 * бессмысленно: цели она выбрала верно, менять просто нечего, — а на LM Studio это лишний вызов
 * в несколько секунд на каждой такой команде.
 * @returns {Array<{id:string,path:string,cleared:boolean}>|null} совпавшие правки, либо null —
 *   в патче есть что-то ещё (создание, удаление, сдвиг или настоящее изменение значения)
 */
function allSetsIdle(doc, ops, engine = null) {
  const list = asArray(ops);
  if (!list.length) return null;
  const same = [];
  for (const o of list) {
    if (!o || o.op !== 'set' || !o.id) return null;
    const node = nodeOf(doc, o.id);
    if (!node) return null;                        // узел создан этим же патчем — судить не о чем
    const cur = currentValue(node, String(o.path));
    const cleared = !Object.prototype.hasOwnProperty.call(o, 'value');
    if (cleared ? cur !== undefined : !sameAsNow(cur, o.value, String(o.path), doc, engine)) return null;
    same.push({ id: o.id, path: String(o.path), cleared });
  }
  return same;
}

/** Лежит ли candidate внутри node — с учётом узлов, созданных этим же патчем (защита от цикла). */
function isInside(doc, createdParents, candidate, node) {
  let cur = candidate;
  let guard = 0;
  while (cur && guard++ < 512) {
    if (cur === node) return true;
    cur = createdParents.has(cur) ? createdParents.get(cur) : (nodeOf(doc, cur) || {}).parent;
  }
  return false;
}

/** Имя узла → id, созданный этим же патчем: чтобы move нашёл только что созданный контейнер (п.9). */
function registerCreated(created, key, id) {
  const k = String(key == null ? '' : key).trim().toLowerCase();
  if (!k || created.has(k)) return;
  created.set(k, id);
}

/** Копия поддерева движком (п.18): дешевле и точнее, чем пересказ дерева моделью. */
function cloneForDuplicate(engine, doc, id, ids, note) {
  if (!engine || typeof engine.cloneSubtree !== 'function') {
    note('Движок не умеет дублировать поддерево — правка пропущена');
    return null;
  }
  let got = null;
  try { got = engine.cloneSubtree(doc, id); } catch (e) { got = null; }
  const list = got && Array.isArray(got.nodes) ? got.nodes : null;
  if (!list || !list.length) {
    note(`Не удалось скопировать поддерево «${(nodeOf(doc, id) || {}).name || id}» — правка пропущена`);
    return null;
  }
  // id от движка могут столкнуться с уже занятыми в этом патче — переименовываем.
  const map = new Map();
  for (const n of list) {
    const fresh = ids.taken.has(n.id) ? ids.mint(n.type) : (ids.taken.add(n.id), n.id);
    map.set(n.id, fresh);
  }
  const nodes = list.map((n) => ({
    ...n,
    id: map.get(n.id),
    parent: map.get(n.parent) || n.parent,
    // дети приходят своими операциями: core.applyOps требует, чтобы перечисленные дети уже существовали
    ...(n.children ? { children: [] } : {}),
  }));
  return { rootId: map.get(got.rootId != null ? got.rootId : list[0].id), nodes };
}

/**
 * Имя копии (круг 5, п.8). Копия сохраняла имя источника, и после «продублируй пункт про
 * тренировку» в документе становилось два «Пункт · Тренировка», а после «повтори карточку
 * встречи» — две «Карточки встречи» на разных экранах. Дальше по этому имени уже не адресуешь:
 * это прямо усугубляло п.1. Занятость проверяем по ВСЕМУ документу, а не только среди соседей:
 * адресация по имени в промптах и в resolveRef тоже сквозная.
 */
function copyName(doc, base, usedLower) {
  const raw = String(base == null ? '' : base).trim();
  if (!raw) return raw;
  const taken = new Set();
  for (const id of Object.keys(doc.nodes || {})) {
    const nm = String((doc.nodes[id] || {}).name || '').trim().toLowerCase();
    if (nm) taken.add(nm);
  }
  for (const k of (usedLower || [])) taken.add(String(k));
  if (!taken.has(raw.toLowerCase())) return raw;
  const stripped = raw.replace(/\s*\(копия(?:\s+\d+)?\)\s*$/iu, '').trim() || raw;
  let cand = `${stripped} (копия)`;
  for (let i = 2; taken.has(cand.toLowerCase()) && i < 100; i++) cand = `${stripped} (копия ${i})`;
  return cutText(cand, 80);
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Куда сдвинули — по-русски, для предупреждения человеку. */
function nudgeWords(dx, dy) {
  const out = [];
  if (dx) out.push(`на ${Math.abs(dx)} px ${dx < 0 ? 'влево' : 'вправо'}`);
  if (dy) out.push(`на ${Math.abs(dy)} px ${dy < 0 ? 'вверх' : 'вниз'}`);
  return out.join(' и ');
}

/**
 * Относительный сдвиг (круг 3, п.6). Раньше сдвиг был сломан по системе координат:
 * выжимка печатает АБСОЛЮТНЫЕ координаты холста («@330,30»), а override задаётся
 * ОТНОСИТЕЛЬНО родителя — и «сдвинь аватар на 10 пикселей влево» двигало его вправо
 * и вниз, вынося за шапку. Теперь модель просит сдвиг, а смещение считаем мы — от
 * текущего прямоугольника, ровно как сдвиг стрелками в core.Stage._nudgeOps.
 */
function nudgeOps({ doc, engine, geo, id, dx, dy, note }) {
  const node = nodeOf(doc, id);
  if (!node) return [];
  const who = `«${node.name || id}»`;
  const parent = node.parent ? nodeOf(doc, node.parent) : null;
  const byPos = () => {
    const pos = node.pos || { x: 0, y: 0 };
    return [mkOp(engine, 'set', { id, path: 'pos', value: { x: r2(Number(pos.x) + dx), y: r2(Number(pos.y) + dy) } })];
  };
  if (!parent || parent.id === doc.root) {
    note(`Экран ${who} сдвинут ${nudgeWords(dx, dy)} по холсту`);
    return byPos();
  }
  if (node.override && Number.isFinite(Number(node.override.x)) && Number.isFinite(Number(node.override.y))) {
    const o = node.override;
    note(`${who} сдвинут ${nudgeWords(dx, dy)}`);
    return [mkOp(engine, 'set', { id, path: 'override', value: { ...o, x: r2(Number(o.x) + dx), y: r2(Number(o.y) + dy) } })];
  }
  const mode = parent.layout && parent.layout.mode;
  if (!mode || mode === 'none') {
    note(`${who} сдвинут ${nudgeWords(dx, dy)}`);
    return byPos();
  }
  const rects = rectsOf(geo) || rectsOf(safeSolve(engine, doc));
  const rect = rects && rects[id];
  const pr = rects && rects[parent.id];
  if (!rect || !pr) {
    note(`Не знаю, где сейчас ${who} на холсте — сдвиг пропущен; подвиньте слой стрелками или мышью`);
    return [];
  }
  note(`${who} сдвинут ${nudgeWords(dx, dy)} — слой отсоединён от раскладки родителя, как при перетаскивании мышью`);
  return [mkOp(engine, 'set', {
    id,
    path: 'override',
    value: { x: r2(rect.x - pr.x + dx), y: r2(rect.y - pr.y + dy), w: r2(rect.w), h: r2(rect.h) },
  })];
}

/**
 * Список точечных правок → операции.
 * placement — куда кладём новое, когда модель не назвала parent (круг 3, п.3);
 * geo — посчитанная геометрия, нужна для op:"nudge" (круг 3, п.6);
 * group — формулировка групповая, частичное совпадение применяется ко всем (круг 3, п.4).
 */
/** Компонент, на который ссылается экземпляр (или null, если ссылка мёртвая). */
function componentOfInstance(doc, engine, node) {
  if (!node || node.type !== 'instance') return null;
  return componentList(engine, doc).find((c) => c.id === node.of) || null;
}

/** Значение свойства словами человека: «акцент», «да», «„Оплатить“». */
function propWords(prop, value) {
  if (prop && prop.kind === 'bool') return value ? 'да' : 'нет';
  if (prop && prop.kind === 'text') return `«${String(value)}»`;
  if (prop && (prop.kind === 'enum' || prop.kind === 'color')) return `«${ruToken('colors', value)}»`;
  return `«${String(value)}»`;
}

/**
 * Круг 19, п.3: одна правка СВОЙСТВА экземпляра. Сюда приходят оба пути — и явный
 * path:"props.<имя>", и правка внутренности экземпляра, уведённая adjustSetPath
 * («поменяй текст у этой кнопки» → её свойство «текст»).
 *
 * Отсекается здесь же, где отсекаются выдуманные слои: необъявленное свойство и негодное
 * значение — с человеческой строкой, что есть взамен.
 * @returns {object|null} операция set или null
 */
function instancePropOp({ doc, engine, id, path, raw, note, setSeen }) {
  const node = nodeOf(doc, id);
  const asked = String(path).slice('props.'.length).trim();
  if (!node) return null;
  if (node.type !== 'instance') {
    note(`${nameOrId(doc, id)} — не экземпляр компонента, свойств компонента у него нет:`
      + ' правка пропущена. Назовите поле слоя — текст, заливку, размер');
    return null;
  }
  if (!asked || asked.indexOf('.') >= 0) {
    note(`${nameOrId(doc, id)}: свойство компонента называется одним именем, а «${asked}» на него не похоже`
      + ' — правка пропущена');
    return null;
  }
  const info = componentOfInstance(doc, engine, node);
  if (!info) {
    note(`${nameOrId(doc, id)}: компонента, на который ссылается этот экземпляр, в библиотеке нет`
      + ' — менять у него нечего, правка пропущена');
    return null;
  }
  const declared = info.props || [];
  const low = asked.toLowerCase();
  const prop = declared.find((x) => x.name === asked)
    || declared.find((x) => String(x.name).toLowerCase() === low)
    || declared.find((x) => stemRu(String(x.name).toLowerCase()) === stemRu(low));
  if (!prop) {
    note(`У компонента «${info.name}» нет свойства «${asked}»`
      + `${declared.length ? ` — есть ${declared.map((x) => `«${x.name}»`).join(', ')}` : ' (свойств он не объявлял)'}`
      + '. Правка пропущена');
    return null;
  }
  const aimed = `props.${prop.name}`;
  const who = `Экземпляр «${info.name}»`;
  // «убери надпись» у свойства значит «не задавать его»: тогда экземпляр берёт значение
  // у компонента. У текстового свойства пустая строка — законное значение, а не «снять».
  const clearing = prop.kind !== 'text' && looksCleared(raw, aimed);
  let value;
  if (!clearing) {
    value = propValueFor(prop, raw, doc, note, who);
    if (value === undefined) return null;
  }
  const key = `${id}|${aimed}|${clearing ? '∅' : JSON.stringify(value)}`;
  if (setSeen.has(key)) return null;
  setSeen.add(key);
  const cur = node.props ? node.props[prop.name] : undefined;
  if (clearing && cur === undefined) {
    note(`У ${nameOrId(doc, id)} свойство «${prop.name}» и так не задано — оно берётся у компонента,`
      + ' эта правка ничего не меняет');
  } else if (!clearing && sameAsNow(cur, value, aimed)) {
    note(`${nameOrId(doc, id)}: свойство «${prop.name}» уже ${propWords(prop, value)}`
      + ' — эта правка ничего не меняет');
  }
  return mkOp(engine, 'set', clearing ? { id, path: aimed } : { id, path: aimed, value });
}

/** Ключи прототипа: имя свойства из них ядро не примет (как и путь set через них). */
const PROTO_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype).concat(['__proto__']));

/**
 * Круг 19, п.4: какие свойства объявить у НОВОГО компонента. Предлагает их приложение, а не
 * модель, и вот почему: имя компонента и имена свойств уже лежат в документе — это имена
 * слоёв, которые дал им человек (или та же модель, когда собирала экран). Лишний вызов модели
 * за тем же самым стоил бы на локальной сборке секунды ожидания и мог бы вернуть выдуманные
 * цели. Что предложено — говорится вслух, и переназвать это одной фразой дешевле, чем ждать.
 * @returns {Array} props по схеме SPEC §5.4
 */
function proposeProps(doc, id) {
  const MAX_PROPS = 4;
  const texts = textDescendants(doc, id).slice(0, MAX_PROPS);
  const used = new Set();
  const out = [];
  for (const tid of texts) {
    const node = nodeOf(doc, tid);
    /* Круг 34: имя свойства — один сегмент пути `props.<имя>` у экземпляра; точка дробила
       бы путь, и ядро такое имя не примет (checkComponent). Точки — пробелами; ключ
       прототипа («constructor») — тоже не имя. */
    let name = String((node && node.name) || '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (texts.length === 1) name = 'текст';
    if (!name || PROTO_NAMES.has(name)) name = `текст ${out.length + 1}`;
    while (used.has(name)) name = `${name} ${out.length + 1}`;
    used.add(name);
    out.push({ name, kind: 'text', target: tid, path: 'characters' });
  }
  return out;
}

/**
 * Круг 19, п.4: операции «сделать этот узел компонентом». Отказ — словами ядра
 * (canMakeComponent), а не общим «не получилось»: причина у него уже человеческая.
 * @returns {{ops:Array, info:{name:string, props:Array}|null}}
 */
function componentFromNode({ engine, doc, id, name, note }) {
  const none = { ops: [], info: null };
  const node = nodeOf(doc, id);
  /**
   * Круг 19, п.4: узел УЖЕ компонент (или его экземпляр). Тогда та же просьба значит другое —
   * «назови компонент иначе», и это законная правка одного поля. Отказ «это уже компонент» тут
   * был бы отпиской: человек сказал имя, и сделать с ним что-то осмысленное можно.
   */
  const master = node && node.type === 'instance' ? nodeOf(doc, node.of)
    : (node && node.component && inLibrary(doc, engine, id) ? node : null);
  if (master && master.component) {
    const fresh = cutText(String(name == null ? '' : name).trim().replace(/^[«"']+|[»"'.,!?]+$/g, ''), 60);
    const was = String(master.component.name || '').trim();
    if (!fresh) {
      note(`${nameOrId(doc, id)} — это уже компонент «${was}», второй раз в библиотеку он не попадёт.`
        + ' Скажите новое имя, если надо переназвать');
      return none;
    }
    if (fresh === was) {
      note(`Компонент и так называется «${was}» — менять нечего`);
      return none;
    }
    return {
      ops: [mkOp(engine, 'set', { id: master.id, path: 'component', value: { ...master.component, name: fresh } })],
      info: { name: fresh, props: master.component.props || [], renamed: was },
    };
  }
  if (!engine || typeof engine.makeComponentOps !== 'function') {
    note('Этот движок компонентов не умеет — просьбу выполнить нечем');
    return none;
  }
  const can = typeof engine.canMakeComponent === 'function' ? engine.canMakeComponent(doc, id) : { ok: true };
  if (!can || !can.ok) {
    note(`${nameOrId(doc, id)} компонентом сделать нельзя: ${(can && can.reason) || 'так нельзя'}`);
    return none;
  }
  const clean = cutText(String(name == null ? '' : name).trim().replace(/^[«"']+|[»"'.,!?]+$/g, ''), 60);
  const props = proposeProps(doc, id);
  let list = [];
  try {
    list = engine.makeComponentOps(doc, id, { ...(clean ? { name: clean } : {}), props }) || [];
  } catch (e) {
    note(`${nameOrId(doc, id)}: компонент собрать не удалось — ${factOnly(e && e.message ? e.message : e)}`);
    return none;
  }
  if (!list.length) {
    note(`${nameOrId(doc, id)} компонентом сделать нельзя`);
    return none;
  }
  const given = clean || String((nodeOf(doc, id) || {}).name || 'Компонент');
  /* Круг 19, п.4: имена компонентов — это словарь модели и человека, и два одинаковых имени
   * в нём делают второй компонент неадресуемым: «поставь кнопку» попадёт в первый. Молчать
   * об этом нельзя — переназвать дешевле сразу. */
  if (componentList(engine, doc).some((c) => String(c.name).toLowerCase() === given.toLowerCase())) {
    note(`В библиотеке уже есть компонент «${given}» — теперь их два с одним именем, и по имени`
      + ' их не различить. Скажите новое имя: «назови это компонентом …»');
  }
  return { ops: list, info: { name: given, props } };
}

/** Круг 19, п.5: операции «отсоединить экземпляр» — настоящая копия поддерева на его месте. */
function detachOpsFor({ engine, doc, id, note, budget }) {
  if (!engine || typeof engine.detachInstanceOps !== 'function') {
    note('Этот движок отсоединять экземпляры не умеет — правка пропущена');
    return [];
  }
  let list = [];
  try { list = engine.detachInstanceOps(doc, id) || []; } catch { list = []; }
  if (!list.length) {
    note(`${nameOrId(doc, id)}: отсоединять нечего — компонента, на который он ссылается, в библиотеке нет`);
    return [];
  }
  const made = list.filter((o) => o && o.op === 'create').length;
  if (budget && made > budget.left) {
    note(`${nameOrId(doc, id)}: копия компонента не помещается в предел ${MAX_TREE_NODES} слоёв — правка пропущена`);
    return [];
  }
  if (budget) budget.left -= made;
  return list;
}

export function patchToOps({ doc, patch, scope, engine, warn, persona, placement = null, geo = null, group = false, said: utterance = '' }) {
  // считаем выданные объяснения: если причина уже названа («неизвестный цвет «буряковый»»),
  // общее «значение непригодно» только зашумит экран
  let notes = 0;
  const said = [];                                 // причины отказов: их же кладём в фатальную ошибку
  const note = (m) => { notes++; said.push(m); if (warn) warn(m); };
  const edits = patch && Array.isArray(patch.edits) ? patch.edits : [];
  if (!edits.length) throw ERR('schema', 'Модель не вернула ни одной правки');
  /**
   * Круг 19, п.6: op:"master" — это ТА ЖЕ правка set, но по КОМПОНЕНТУ. Переписываем её в set
   * по мастеру здесь, до общего цикла, и дальше она идёт общей дорогой: путь сверяется с типом
   * цели, значение проверяется, «уже так» и дедупликация работают. Своя половинчатая копия
   * ветки set была бы вторым местом, где всё это надо помнить.
   *
   * Цель подставляем ИДЕНТИФИКАТОРОМ (#id мастера), а не именем: по имени искать нельзя —
   * поиск по именам в библиотеку не заходит (и не должен: мастер «Кнопка» перебивал бы кнопку
   * на доске). Отдельная операция для этого и нужна: она, а не похожесть имён, говорит, что
   * человек просил изменить компонент целиком.
   */
  const comps = componentList(engine, doc);
  const work = [];
  for (const raw of edits) {
    if (!raw || typeof raw !== 'object' || String(raw.op || '').toLowerCase() !== 'master') { work.push(raw); continue; }
    if (!comps.length) {
      note('Библиотеки компонентов в документе нет — правку компонента выполнить нечем, она пропущена');
      continue;
    }
    const called = [raw.target, raw.name, raw.of, raw.component].find((v) => typeof v === 'string' && v.trim()) || '';
    const { info, ambiguous } = findComponent(comps, called);
    if (!info) {
      note(ambiguous.length
        ? `Под «${String(called).trim()}» подходит несколько компонентов — ${componentNames(ambiguous)}.`
          + ' Правка пропущена: назовите компонент точно'
        : `Компонента «${String(called).trim() || '—'}» в библиотеке нет — есть ${componentNames(comps)}.`
          + ' Правка пропущена');
      continue;
    }
    work.push({ ...raw, op: 'set', target: `#${info.id}` });
  }
  const ops = [];
  const ids = makeIdFactory(doc, [], engine);
  const created = new Map();                       // «имя из этого патча» → новый id (п.9)
  const createdParents = new Map();                // новый id → его родитель (узлов ещё нет в doc)
  /**
   * Куда вставлять следующий move В ЭТОГО родителя (круг 2, п.2). Раньше индекс считался
   * как `index + i` внутри ОДНОЙ правки, и три отдельных move без index получали index 0 —
   * порядок в новой группе выходил перевёрнутым. Счётчик живёт на всём патче и на каждого
   * родителя свой: у нового контейнера он начинается с 0, у существующего — с числа его детей.
   */
  const moveCursor = new Map();
  const moveAt = (parentId, explicit) => {
    if (!moveCursor.has(parentId)) {
      const node = nodeOf(doc, parentId);
      moveCursor.set(parentId, node ? (kidsOf(node).length) : 0);
    }
    const at = explicit == null ? moveCursor.get(parentId) : explicit;
    moveCursor.set(parentId, Math.max(moveCursor.get(parentId), at) + 1);
    return at;
  };
  const budget = makeNodeBudget(note);             // общий предел на число узлов (п.19)
  // круг 16, п.7: реплика человека нужна разрешению цели — он мог назвать вмещающий слой
  const refOpts = { created, said: utterance };
  const setSeen = new Set();                       // одинаковые set не дублируем
  /** Круг 36: текст, получивший «цвет при наведении» вместо кнопки, следует за ней (motion.follow). */
  const pushFollow = (list) => {
    for (const fid of list) {
      const n = nodeOf(doc, fid);
      if (n && n.motion && typeof n.motion === 'object' && n.motion.follow === 'parent') continue;
      const k = `${fid}|motion.follow|"parent"`;
      if (setSeen.has(k)) continue;
      setSeen.add(k);
      ops.push(mkOp(engine, 'set', { id: fid, path: 'motion.follow', value: 'parent' }));
    }
  };

  for (const edit of work) {
    if (!edit || typeof edit !== 'object') { note('Правка не объект — пропущена'); continue; }
    const op = String(edit.op || '').toLowerCase();

    if (op === 'set') {
      const path = normalizePath(edit.path);
      if (!path) { note('Правка set без пути — пропущена'); continue; }
      const head = path.split('.')[0];
      if (PROTECTED_PATHS.has(head)) { note(`Служебное поле «${path}» менять нельзя — правка пропущена`); continue; }
      /**
       * Круг 13, п.1: СНЯТЬ override — единственная осмысленная правка этого пути, и руками она
       * есть («вернуть в поток раскладки»). Задать его числами по-прежнему нельзя: выжимка печатает
       * абсолютные координаты холста, а override отсчитывается от родителя.
       */
      const clearsPath = looksCleared(edit.value, path);
      if (MOVE_PATHS.has(head) && !(head === 'override' && clearsPath)) {
        note('Задать положение напрямую нельзя: место слоя считает раскладка.'
          + ' Скажите, на сколько и куда сдвинуть, — это отдельная правка; эта пропущена');
        continue;
      }
      if (!ALLOWED_PATH_HEADS.has(head) && !(head === 'override' && clearsPath)) {
        note(`Поля «${path}» у слоёв этого редактора нет — правка пропущена`);
        continue;
      }
      const targets = resolveRefs(engine, doc, edit.target, scope, note, {
        ...refOpts, group, uniform: UNIFORM_PATHS.has(head), autoGroup: !group && UNIFORM_PATHS.has(head),
      });
      if (!targets.length) continue;
      for (const id of targets) {
        // путь сверяется с ТИПОМ цели: текстовое свойство на фрейме уходит в его текст,
        // заливка на тексте отбрасывается с объяснением (круг 3, п.1)
        const aimed = adjustSetPath(doc, id, path, note);
        if (!aimed) continue;
        /* Круг 19, п.3: свойство экземпляра. Сюда приходят и явный path:"props.<имя>", и
         * правка внутренности экземпляра, уведённая adjustSetPath в объявленное свойство. */
        if (String(aimed.path).indexOf('props.') === 0 || String(aimed.path) === 'props') {
          const got = instancePropOp({ doc, engine, id: aimed.id, path: aimed.path, raw: edit.value, note, setSeen });
          if (got) ops.push(got);
          continue;
        }
        const before = notes;
        // ctx: цель и посчитанная геометрия — по ним видно, во что узел вложен (круг 7, п.8)
        // круг 20: движок и реплика человека нужны шкалам — проверить ссылку и понять, кто назвал число
        const value = coerceValue(edit.value, aimed.path, doc, note, { id: aimed.id, geo, engine, said: utterance });
        if (value === undefined) {
          if (notes === before) {
            note(edit.value === undefined
              ? `Правка «${ruPath(aimed.path)}»: значение не указано — правка пропущена`
              : `Правка «${ruPath(aimed.path)}»: значение «${edit.value}» непригодно — правка пропущена`);
          }
          continue;
        }
        /* Круг 36: «цвет текста при наведении» у кнопки-фрейма уходит её тексту — и текст следует
         * за кнопкой (motion.follow = parent), иначе он менялся бы, только когда мышь на буквах. */
        let setValue = value;
        const followIds = aimed.follow ? [aimed.id] : [];
        if (value !== UNSET && isMotionPath(aimed.path)) {
          const spread = spreadStateColor(doc, aimed.id, aimed.path, value, note);
          for (const more of spread.more) {
            const k = `${more.id}|${more.path}|${JSON.stringify(more.value)}`;
            if (setSeen.has(k)) continue;
            setSeen.add(k);
            ops.push(mkOp(engine, 'set', { id: more.id, path: more.path, value: more.value }));
            if (more.follow) followIds.push(more.id);
          }
          if (spread.value === undefined) { pushFollow(followIds); continue; }
          setValue = spread.value;
        }
        const clearing = setValue === UNSET;            // круг 13, п.1: set БЕЗ value — «снять свойство»
        const key = `${aimed.id}|${aimed.path}|${clearing ? '∅' : JSON.stringify(setValue)}`;
        if (setSeen.has(key)) continue;              // групповая правка могла свести две цели к одной
        setSeen.add(key);
        const target = nodeOf(doc, aimed.id);
        const cur = target ? currentValue(target, aimed.path) : undefined;
        /**
         * Круг 15, п.9: style строкой МОЛЧА стирал надстройки. В демо-документе у «Метки»
         * стоит style: {token:"caption", fontWeight:600, letterSpacing:0.4} — то есть токен
         * плюс личные поправки; set style:"body" заменяет объект строкой, и fontWeight с
         * letterSpacing исчезают бесследно. Правка законная (так же работает инспектор), но
         * молчать о ней нельзя: человек просил сменить стиль, а не снять насечку.
         *
         * Круг 16, поправка: говорим об этом ТОЛЬКО когда надстройки и правда снимаются, то
         * есть когда строка несёт ДРУГОЙ токен. При совпадающем токене ядро оставляет поле
         * байт в байт (core.keepFieldForm), и прежняя строка «они снимаются» была ложью.
         */
        if (target && !clearing && aimed.path === 'style' && typeof value === 'string'
          && cur && typeof cur === 'object' && !wrapperKeeps('style', cur, value)) {
          const extra = Object.keys(cur).filter((k) => k !== 'token' && cur[k] !== undefined);
          if (extra.length) {
            note(`${nameOrId(doc, aimed.id)}: у этого текста поверх стиля стояли свои`
              + ` ${extra.map(ruPath).join(', ')} — со стилем ${valueWords(value, 'style')} они снимаются.`
              + ' Скажите, если их надо вернуть');
          }
        }
        if (target && clearing && cur === undefined) {
          note(`У ${nameOrId(doc, aimed.id)} и так нет ${ruPathGen(aimed.path)} — эта правка ничего не меняет`);
        } else if (target && !clearing && sameAsNow(cur, setValue, aimed.path, doc, engine)) {
          note(`${nameOrId(doc, aimed.id)}: ${ruPath(aimed.path)} уже ${valueWords(setValue, aimed.path, doc, engine)}`
            + ' — эта правка ничего не меняет');
        }
        ops.push(mkOp(engine, 'set', clearing
          ? { id: aimed.id, path: aimed.path }
          : { id: aimed.id, path: aimed.path, value: setValue }));
        pushFollow(followIds);
      }
    } else if (op === 'nudge') {
      const targets = resolveRefs(engine, doc, edit.target, scope, note, { ...refOpts, group });
      if (!targets.length) continue;
      // круг 9, п.2: «dx: "-10px"» — такое же число, как -10; молча ронять его в ноль нельзя
      const px = (v) => { const g = v == null || v === '' ? null : parsePx(v); return g ? Math.round(g.n) : null; };
      const dx = px(edit.dx);
      const dy = px(edit.dy);
      if (dx === null && edit.dx != null && edit.dx !== '') { note(`Сдвиг dx «${edit.dx}» — не число пикселей: правка пропущена`); continue; }
      if (dy === null && edit.dy != null && edit.dy !== '') { note(`Сдвиг dy «${edit.dy}» — не число пикселей: правка пропущена`); continue; }
      if (!dx && !dy) { note('Сдвиг на ноль пикселей — правка пропущена'); continue; }
      if (Math.abs(dx || 0) > MAX_PX || Math.abs(dy || 0) > MAX_PX) { note('Сдвиг больше холста — правка пропущена'); continue; }
      for (const id of targets) {
        if (id === doc.root) { note('Страницу сдвинуть нельзя — правка пропущена'); continue; }
        ops.push(...nudgeOps({ doc, engine, geo, id, dx: dx || 0, dy: dy || 0, note }));
      }
    } else if (op === 'remove') {
      /**
       * Круг 13, п.2: схема разрешает path у ЛЮБОЙ операции, и на «убери фон у карточки» модель
       * присылает {op:"remove", target:"Карточка встречи", path:"fill"}. Ветка читала только
       * target — и удаляла ВСЮ карточку с шестью узлами внутри. Заголовок при этом честно говорил
       * «Удалил…», отмена работала, но разрушительное толкование безобидной просьбы — это худший
       * из возможных ответов. Путь у remove значит «сними это поле», а не «снеси узел».
       */
      const rmPath = normalizePath(edit.path);
      if (rmPath) {
        const rmHead = rmPath.split('.')[0];
        const canClear = CLEARABLE_PATHS.has(rmPath)
          && !PROTECTED_PATHS.has(rmHead)
          && (ALLOWED_PATH_HEADS.has(rmHead) || rmHead === 'override');
        if (!canClear) {
          const hint = REMOVE_PATH_HINT[rmPath];
          note(hint
            ? `Правка «${ruPath(rmPath)}»: ${hint}; правка пропущена`
            : `Убрать ${ruPathGen(rmPath)} у слоя нельзя: это поле либо обязательное, либо его у слоёв нет.`
              + ' Правка пропущена — скажите, какое значение поставить вместо');
          continue;
        }
        const targets = resolveRefs(engine, doc, edit.target, scope, note, {
          ...refOpts, existingFirst: true, group, uniform: UNIFORM_PATHS.has(rmHead),
          autoGroup: !group && UNIFORM_PATHS.has(rmHead),
        });
        if (!targets.length) continue;
        for (const id of targets) {
          const aimed = adjustSetPath(doc, id, rmPath, note);
          if (!aimed) continue;
          const key = `${aimed.id}|${aimed.path}|∅`;
          if (setSeen.has(key)) continue;
          setSeen.add(key);
          const target = nodeOf(doc, aimed.id);
          if (target && currentValue(target, aimed.path) === undefined) {
            note(`У ${nameOrId(doc, aimed.id)} и так нет ${ruPathGen(aimed.path)} — эта правка ничего не меняет`);
          }
          ops.push(mkOp(engine, 'set', { id: aimed.id, path: aimed.path }));
        }
        continue;
      }
      // существующий узел важнее созданного этим же патчем (круг 5, п.2)
      const targets = resolveRefs(engine, doc, edit.target, scope, note, { ...refOpts, existingFirst: true });
      for (const id of targets) {
        if (id === doc.root) { note('Корень документа удалить нельзя — правка пропущена'); continue; }
        ops.push(mkOp(engine, 'remove', { id }));
      }
    } else if (op === 'create') {
      // Куда вставлять (круг 3, п.3). Раньше контейнер задавался только выделением или
      // активным артбордом, и «добавь в список пункт на 20:00» падало то в список, то в
      // конец экрана. Порядок: parent из правки → контейнер, НАЗВАННЫЙ в самой команде
      // (placement.insert) → target из правки → область по умолчанию.
      let parentId = edit.parent != null
        ? resolveRef(engine, doc, edit.parent, scope, note, { ...refOpts, container: true })
        : null;
      if (!parentId && placement && placement.insert && nodeOf(doc, placement.parentId)) {
        parentId = placement.parentId;
      }
      /**
       * Круг 11, п.2: схема требует target у КАЖДОЙ операции, и модель часто кладёт туда имя
       * СОЗДАВАЕМОГО узла: «добавь в самый низ экрана подпись «версия 1.2»» → {op:"create",
       * target:"подпись"}. «Подпись» частично совпадает с «Подпись кнопки», и новый узел молча
       * уезжал ВНУТРЬ кнопки. Поэтому target годится в контейнеры, только если он и правда
       * контейнер и найден надёжно (по id, точному имени, роли — или единственным совпадением).
       * Иначе доверяем месту, которое посчитало приложение, и говорим об этом вслух.
       */
      if (!parentId && edit.parent == null && edit.target != null) {
        const got = refCandidates(engine, doc, edit.target, scope, { ...refOpts, container: true });
        const aim = got.ids[0] || null;
        const aimNode = aim ? nodeOf(doc, aim) : null;
        const isBox = !!aimNode && (aimNode.type === 'frame' || aimNode.type === 'page');
        const solid = TRUSTED_PARENT_HOW.has(got.how) || got.ids.length === 1;
        const fallback = placement && placement.parentId && nodeOf(doc, placement.parentId)
          ? placement.parentId : null;
        if (aim && isBox && solid) {
          // тот же поиск ещё раз, но со словами: про совпадение имён и про «нашлось вне области»
          // человеку надо сказать ровно так же, как раньше
          parentId = resolveRef(engine, doc, edit.target, scope, note, { ...refOpts, container: true });
        } else if (aim && fallback && aim !== fallback) {
          const why = isBox
            ? `под «${String(edit.target).trim()}» подходит несколько слоёв`
            : `«${String(edit.target).trim()}» — не контейнер, это внутри ${RU_TYPE[aimNode.type] || 'слоя'} ${nameOrId(doc, aim)}`;
          note(`${why}, а куда класть новое, сказано не было: кладу в ${nameOrId(doc, fallback)}.`
            + ' Скажите, внутрь чего нужно, если место другое');
          parentId = fallback;
        } else if (aim && isBox) {
          parentId = aim;
        }
      }
      if (!parentId && placement && placement.parentId && nodeOf(doc, placement.parentId)) {
        parentId = placement.parentId;
        note(`Не понял, куда добавить — кладу в ${nameOrId(doc, parentId)}`);
      }
      if (!parentId) { note('Некуда вставить новый слой — правка пропущена'); continue; }
      const parentNode = nodeOf(doc, parentId);
      if (parentNode && parentNode.type !== 'frame' && parentNode.type !== 'page') {
        parentId = containerFor(doc, parentNode.parent);
      }
      if (!parentId) { note('Некуда вставить новый слой — правка пропущена'); continue; }
      const spec = normalizeTree(edit.node, { doc, warn: note, persona, budget, engine });
      if (!spec) continue;
      let at = edit.index != null ? Number(edit.index)
        : (placement && placement.insert && placement.parentId === parentId && placement.index != null ? placement.index : null);
      // круг 7, п.3: «добавь под заголовком плашку» — плашка во всю ширину идёт уровнем выше
      if (placement && placement.insert && placement.parentId === parentId && edit.index == null) {
        const wide = wideTarget(doc, placement, wantsFullWidth(edit.node && edit.node.size), note);
        if (wide) { parentId = wide.parentId; at = wide.index; }
      }
      const nodes = [];
      specToNodes(spec, parentId, ids, nodes);
      nodes.forEach((node, i) => {
        ops.push(mkOp(engine, 'create', i === 0 && at != null ? { node, index: at } : { node }));
        registerCreated(created, node.name, node.id);
        createdParents.set(node.id, node.parent);
      });
      if (nodes.length) {
        registerCreated(created, spec.name, nodes[0].id);
        registerCreated(created, spec.$id, nodes[0].id);
        // id, которые модель дала узлам дерева, — псевдонимы выданных глобальных id (makeIdFactory)
        for (const [raw, fresh] of ids.aliases) registerCreated(created, raw, fresh);
        if (!isSelfRef(edit.target)) registerCreated(created, edit.target, nodes[0].id);
      }
    } else if (op === 'move') {
      // что переносим — существующий узел (круг 5, п.2), а КУДА — можно и во вновь созданное
      const targets = resolveRefs(engine, doc, edit.target, scope, note, { ...refOpts, existingFirst: true, purpose: 'source' });
      if (!targets.length) continue;
      const parentId = resolveRef(engine, doc, edit.parent, scope, note, { ...refOpts, container: true });
      if (!parentId) { note('Правка move без родителя — пропущена'); continue; }
      // индекс из правки — только если он реально указан; иначе дописываем в конец по порядку
      const explicit = edit.index == null || !Number.isFinite(Number(edit.index)) ? null : Number(edit.index);
      targets.forEach((id, i) => {
        if (id === parentId || isInside(doc, createdParents, parentId, id)) {
          note(`«${(nodeOf(doc, id) || {}).name || id}» нельзя переместить внутрь себя — правка пропущена`);
          return;
        }
        ops.push(mkOp(engine, 'move', { id, parent: parentId, index: moveAt(parentId, explicit == null ? null : explicit + i) }));
      });
    } else if (op === 'duplicate') {
      const targets = resolveRefs(engine, doc, edit.target, scope, note, { ...refOpts, purpose: 'source' });
      for (const id of targets) {
        const src = nodeOf(doc, id);
        if (!src || id === doc.root) { note('Дублировать нечего — правка пропущена'); continue; }
        let parentId = edit.parent != null
          ? resolveRef(engine, doc, edit.parent, scope, note, { ...refOpts, container: true })
          : src.parent;
        if (!parentId || !nodeOf(doc, parentId)) parentId = containerFor(doc, src.parent);
        const copy = cloneForDuplicate(engine, doc, id, ids, note);
        if (!copy) continue;
        if (copy.nodes.length > budget.left) {
          note(`Копия «${src.name || id}» не помещается в предел ${MAX_TREE_NODES} слоёв — правка пропущена`);
          continue;
        }
        budget.left -= copy.nodes.length;
        const siblings = kidsOf(nodeOf(doc, parentId));
        const at = edit.index != null ? Number(edit.index) : (siblings.indexOf(id) >= 0 ? siblings.indexOf(id) + 1 : siblings.length);
        copy.nodes.forEach((node, i) => {
          if (i === 0) {
            const root = { ...node, parent: parentId };
            const fresh = copyName(doc, root.name, created.keys());
            if (fresh && fresh !== root.name) {
              note(`Копия названа «${fresh}»: имя «${root.name}» в документе уже занято`);
              root.name = fresh;
            }
            if (parentId === doc.root) root.pos = nextArtboardPos(doc);   // копия артборда встаёт рядом
            else delete root.pos;
            ops.push(mkOp(engine, 'create', { node: root, index: at }));
            registerCreated(created, root.name, root.id);
            registerCreated(created, `копия ${src.name || ''}`, root.id);
          } else {
            ops.push(mkOp(engine, 'create', { node }));
          }
        });
      }
    } else if (op === 'detach') {
      /* Круг 19, п.5 (SPEC §5.7): отсоединить — значит поставить на место экземпляра настоящую
       * копию поддерева компонента. Операции даёт ядро одной отменяемой транзакцией. */
      const targets = resolveRefs(engine, doc, edit.target, scope, note, { ...refOpts, existingFirst: true });
      if (!targets.length) continue;
      for (const id of targets) {
        const node = nodeOf(doc, id);
        if (!node) continue;
        if (node.type !== 'instance') {
          note(`${nameOrId(doc, id)} — не экземпляр компонента, отсоединять нечего: правка пропущена`);
          continue;
        }
        ops.push(...detachOpsFor({ engine, doc, id, note, budget }));
      }
    } else if (op === 'component') {
      // круг 19, п.4: сделать компонентом существующий узел
      const id = resolveRef(engine, doc, edit.target, scope, note, { ...refOpts, existingFirst: true });
      if (!id) continue;
      const made = componentFromNode({ engine, doc, id, name: edit.name, note });
      if (!made.ops.length) continue;
      ops.push(...made.ops);
      if (made.info.renamed) {
        note(`Компонент «${made.info.renamed}» теперь называется «${made.info.name}»`
          + ' — новое имя видно у всех его экземпляров');
        continue;
      }
      note(`Компонент «${made.info.name}» добавлен в библиотеку, на доске остался его экземпляр.`
        + (made.info.props.length
          ? ` Менять у экземпляров можно ${made.info.props.map((x) => `«${x.name}»`).join(', ')}`
            + ' — скажите, если нужны другие свойства'
          : ' Свойств у него пока нет — скажите, что у экземпляров надо будет менять'));
    } else {
      note(`Неизвестная операция «${edit.op}» — пропущена`);
    }
  }

  /**
   * Круг 19, п.6: ЧЕСТНОСТЬ. Правка мастера меняет все его экземпляры разом, и человек обязан
   * это прочитать: главную строку результата оболочка собирает по операциям («Скругление 16 → 24
   * в «Кнопка»»), и по ней правка компонента выглядит правкой одного слоя.
   *
   * Считаем по САМИМ ОПЕРАЦИЯМ, а не по виду правки: в библиотеку можно попасть и через
   * op:"master", и прямым id мастера, и выделением мастера на холсте — во всех случаях сказать
   * надо одно и то же.
   */
  const touched = new Map();
  const mine = new Map();                          // мастер → сколько операций его задели
  for (const o of ops) {
    const where = o && (o.id || (o.node && o.node.parent));
    if (!where || !inLibrary(doc, engine, where)) continue;
    // про сам компонент (имя, набор свойств) говорит своя строка — «правка всех экземпляров»
    // рядом с ней была бы вторым сообщением об одном и том же
    if (o.op === 'set' && String(o.path) === 'component') continue;
    for (const info of comps) {
      if (where !== info.id && !chainUp(doc, where).includes(info.id)) continue;
      touched.set(info.id, info);
      mine.set(info.id, (mine.get(info.id) || 0) + 1);
    }
  }
  /**
   * Круг 19, п.7: и вторая половина той же честности. Экземпляр ПЕРЕКРЫВАЕТ то, что задано его
   * свойством: если правка компонента попала ровно в тот узел и путь, которые объявлены
   * свойством, у экземпляров со своим значением не изменится ничего. Замер на демо: «пусть все
   * кнопки говорят „Дальше“» правит текст внутри мастера, а единственный экземпляр говорит
   * «Открыть день» — и «меняет все экземпляры» было бы неправдой ровно там, где человек
   * проверит её глазами.
   */
  const shadowed = new Map();                      // мастер → сколько операций перекрыто целиком
  const shadowSaid = [];
  for (const o of ops) {
    if (!o || o.op !== 'set' || !o.id) continue;
    for (const info of comps) {
      const prop = (info.props || []).find((x) => x.target === o.id && String(x.path) === String(o.path));
      if (!prop) continue;
      const all = instancesOf(doc, info.id);
      const over = all.filter((id) => ((nodeOf(doc, id) || {}).props || {})[prop.name] !== undefined);
      if (!over.length) continue;
      if (over.length === all.length) {
        shadowed.set(info.id, (shadowed.get(info.id) || 0) + 1);
        shadowSaid.push(`Правка компонента «${info.name}» на досках ничего не изменит:`
          + ` у ${all.length === 1 ? 'единственного экземпляра' : `всех ${all.length} экземпляров`}`
          + ` свойство «${prop.name}» задано своим значением, и оно сильнее. Поменяйте это свойство`
          + ' у экземпляров или снимите его, чтобы значение бралось у компонента');
      } else {
        shadowSaid.push(`Правка компонента «${info.name}»: у ${over.length} из ${all.length} экземпляров`
          + ` свойство «${prop.name}» задано своим значением — у них ${ruPath(o.path)} останется прежним`);
      }
    }
  }
  for (const info of touched.values()) {
    // если ВСЁ, что правили у компонента, перекрыто свойствами экземпляров, «меняет все
    // экземпляры» было бы ложью: об этом скажет строка ниже, и она точнее
    if ((shadowed.get(info.id) || 0) >= (mine.get(info.id) || 0)) continue;
    note(info.instances
      ? `Это правка компонента «${info.name}», а не одного слоя: она разом меняет все его экземпляры`
        + ` на досках — их ${info.instances}`
      : `Это правка компонента «${info.name}» в библиотеке. Экземпляров на досках у него пока нет,`
        + ' так что на самих досках ничего не изменилось');
  }
  for (const m of shadowSaid) note(m);

  /**
   * Круг 13, п.5: «убери шапку и заголовок» — модель присылает remove «Шапка» и remove
   * «Заголовок экрана», который лежит ВНУТРИ шапки. Первую операцию core применял, на второй
   * узла уже не было, и вся транзакция падала техническим «операция 1 (remove): remove: узел
   * «t_7fn1m» не найден (not-found)». Спасал только раунд починки — лишний вызов модели и
   * лотерея на слабой локальной сборке. Ещё хуже обратный порядок: инверсия воссоздала бы
   * потомка дважды, и отмена упала бы на дубликате id.
   *
   * Поэтому remove внутри другого удаляемого поддерева (и повтор того же узла) отбрасываем
   * ЗДЕСЬ, обычным предупреждением: удаление родителя и так уносит потомков.
   */
  const removed = new Set();
  const doubles = [];
  let ops2 = [];
  for (const o of ops) {
    if (!o || o.op !== 'remove' || !o.id) { ops2.push(o); continue; }
    if (removed.has(o.id)) { doubles.push(o.id); continue; }
    removed.add(o.id);
    ops2.push(o);
  }
  if (removed.size > 1) {
    const roots = [...removed];
    const inner = new Map();
    for (const id of roots) {
      const host = roots.find((other) => other !== id && isInside(doc, createdParents, id, other));
      if (host) inner.set(id, host);
    }
    if (inner.size) {
      for (const [id, host] of inner) {
        note(`${nameOrId(doc, id)} лежит внутри ${nameOrId(doc, host)}: это поддерево удаляется`
          + ' целиком, так что отдельная правка пропущена — она бы не нашла слоя');
      }
      ops2 = ops2.filter((o) => !(o && o.op === 'remove' && inner.has(o.id)));
    }
  }
  if (doubles.length) note(`${nameOrId(doc, doubles[0])} просили удалить дважды — удаляю один раз`);
  ops.length = 0;
  ops.push(...ops2);

  /* Круг 7, п.1: если все правки отклонены, причина обязана быть В САМОЙ ошибке — иначе человек
   * читает голое «ни одну правку не удалось применить», а модель на починке не знает, что чинить. */
  if (!ops.length) {
    const why = failureReasons(said).join(' ');
    const hint = failureHint(said);
    /**
     * Круг 16, п.8: «отмени скидку» → «Слой «Скидка» не найден», и оболочка предлагала
     * «Повторить». Повтор тут заведомо даст то же: цель не нашлась не потому, что модель
     * ошиблась формой ответа, а потому, что ТАКОГО СЛОЯ В ДОКУМЕНТЕ НЕТ, — никакой повтор
     * его не создаст. Проверяем фактом, а не по тексту предупреждения: ни у одной правки
     * цель не находится в документе. Поле уходит в error.retryable = false.
     */
    const targeted = edits.filter((e) => {
      const ref = e && (e.target != null ? e.target : e.id);
      return ref != null && String(ref).trim() !== '' && !isSelfRef(String(ref));
    });
    const allMissing = targeted.length === edits.length && targeted.length > 0
      && targeted.every((e) => {
        const ref = String(e.target != null ? e.target : e.id);
        try { return refCandidates(engine, doc, ref, scope, { created }).ids.length === 0; } catch { return false; }
      });
    /* Круг 29 (J5): своим кодом `not_applied` — это не сбой модели: ответ разобран, но к
     * документу не приложился. Текст — сама причина (оболочка говорит «Не получилось применить
     * правку: …»), а служебная шапка — только когда причины нет. */
    throw ERR('schema', why || 'Ни одну правку не удалось применить к документу',
      { code: 'not_applied', ...(allMissing ? { retryable: false } : {}), ...(hint ? { hint } : {}) });
  }
  return ops;
}

/**
 * Круг 29 (J5): причины отказа, когда не применилось НИЧЕГО. Заметки об адресации писались
 * для случая, когда правка легла: «правлю «Заголовок и период». Скажите «во всех…»», «правка
 * ушла туда», «оформление поправил у всех». Рядом с «ни одну правку не удалось применить» это
 * противоречие: человек читал, что правлю, и тут же — что не правил. Оставляем факт (какие
 * узлы подошли и какой пробовали), убираем обещание. Не больше двух строк, причина — первой.
 * @param {string[]} said
 * @returns {string[]}
 */
function orderedReasons(said) {
  const all = [];
  for (const raw of Array.isArray(said) ? said : []) {
    let m = String(raw == null ? '' : raw).trim();
    if (!m) continue;
    m = m
      .replace(/;\s*(?:правлю|кладу в)\s+(.+?)(?:\s+—\s+его вы и назвали в команде)?(?:\.\s*Скажите «во всех…», чтобы поправить сразу все)?\.?$/u,
        (_, pick) => `; пробовал ${pick}`)
      .replace(/,\s*но в команде назван вмещающий слой\s+—\s+правлю только\s+(.+?)\.\s*Нужны все\s+—\s+скажите «во всех…»$/u,
        (_, pick) => `; пробовал только ${pick} — его назвали в команде`)
      .replace(/:\s*правлю все\s*(\(.*\))$/u, (_, list) => ` ${list}`)
      .replace(/(\(.*\)):\s*оформление поправил у всех\.\s*Нужен один\s+—\s+выделите его и повторите$/u, (_, list) => list)
      .replace(/(?:;|\s+—)\s+правка ушла (?:туда|в него)$/u, '')
      .replace(/\.$/u, '');
    if (!all.includes(m)) all.push(m);
  }
  // сама причина отказа (ранг 0: «правка пропущена», «не найден») — первой: оболочка
  // показывает начало текста, и причина не должна уйти за обрез
  const cause = all.filter((m) => warningRank(m) === 0);
  const rest = all.filter((m) => warningRank(m) !== 0);
  return cause.concat(rest).slice(0, 2);
}

/**
 * Круг 29 (J5), круг 31: причины отказа, когда не применилось НИЧЕГО, — коротко. Оболочка
 * пишет «Не получилось применить правку: <причина>» и на 390 px обрезает длинное, поэтому:
 *   • «— правка пропущена» не повторяем: заголовок уже говорит, что правка не легла;
 *   • совет «назовите слой по имени» — не здесь: его даёт оболочка (по `hint: 'name_layer'`,
 *     см. failureHint), иначе человек читал совет дважды;
 *   • «подходит узлов — N» — без перечня имён и без «пробовал X», если X уже назван в причине.
 * @param {string[]} said
 * @returns {string[]}
 */
export function failureReasons(said) {
  const list = orderedReasons(said);
  const out = [];
  for (const raw of list) {
    let m = raw
      .replace(/\s+—\s+правка «([^»]*)» пропущена:\s*назовите слой, который надо поменять$/u, ' — «$1» задать некому')
      .replace(/\s*[:—,]\s*правка пропущена(?:,\s*назовите слой по имени)?(?=\.|$)/u, '')
      .replace(/^(Под «[^»]*» подходит (?:слоёв|узлов) — \d+)\s*\((?:«[^»]*»|[^()«])*\)/u, '$1');
    if (out.length) {
      // «пробовал «X»» — лишнее, если X уже назван в причине
      m = m.replace(/;\s*пробовал (?:только )?(.+?)(?: — его назвали в команде)?$/u,
        (all, pick) => (out.some((c) => c.includes(pick)) ? '' : all));
    }
    m = m.trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out.map((m) => (/[.!?]$/u.test(m) ? m : `${m}.`));
}

/**
 * Круг 31: совет оболочке к `not_applied` — 'name_layer' («назовите слой так, как он подписан…»),
 * только когда причина в ВЫБОРЕ слоя: слой не найден, подошло несколько, непонятно, какому
 * тексту внутри. Причина в поле или значении («у текста нет раскладки») — совета нет: имя
 * слоя тут ни при чём.
 * @param {string[]} said
 * @returns {'name_layer'|null}
 */
export function failureHint(said) {
  const first = orderedReasons(said)[0] || '';
  return /не найден|непонятно, какому|подходит (?:слоёв|узлов)|назовите слой|нет текста/u.test(first) ? 'name_layer' : null;
}

/**
 * Изменения токенов → операции setToken.
 *
 * Круг 11, п.3: токены ОБЩИЕ для всего документа, а в шапке промпта стоит «РАБОТАЕМ С: <экран>,
 * другие доски не трогай» — и на «сделай только этот экран тёмным, сводку не трогай» тёмной
 * становилась и сводка, причём молча. Отдельная доска оформлением перекрасить нельзя вовсе;
 * раз так, человек обязан узнать, что изменилось всё.
 */
export function themeToOps({ doc, theme, engine, warn, scope = null }) {
  const note = warn || (() => {});
  const ops = [];
  /**
   * Круг 5, п.6: проверялся только TOKEN_PATH_RE, а `[A-Za-z0-9_-]+` покрывает «__proto__» и
   * «constructor» — такой ответ модели давал protected-path от applyOps и убивал ВСЮ транзакцию,
   * хотя исправная правка соседнего токена была готова. Отбрасываем имя, как имя с пробелом.
   */
  /**
   * Круг 15, п.4: что именно поменялось. Предупреждение про общий документ всегда кончалось
   * словами «Перекрасить один экран отдельно так нельзя… менять заливку и цвет его узлов» —
   * даже когда правка была чисто типографической («поменяй шрифт на Georgia»), и совет тогда
   * был не про то. Считаем виды затронутых токенов и говорим по факту.
   */
  const touched = new Set();
  const push = (path, value) => {
    const bad = String(path).split('.').find((seg) => UNSAFE_KEYS.has(seg));
    if (bad) { note(`Имя токена «${bad}» служебное — правка пропущена`); return; }
    if (!TOKEN_PATH_RE.test(path)) { note(`Путь токена «${path}» недопустим — пропущен`); return; }
    const head = String(path).split('.')[0];
    touched.add(head === 'colors' ? 'colors' : head === 'type' ? 'type' : head === 'spacing' ? 'spacing' : head === 'radii' ? 'radii'
      : head === 'motion' || head === 'shadow' ? head : 'other');
    ops.push(mkOp(engine, 'setToken', { path, value }));
  };

  for (const c of asArray(theme && theme.colors)) {
    if (!c || !c.name) continue;
    const value = String(c.value || '').trim();
    if (!HEX_RE.test(value)) { note(`Цвет «${ruToken('colors', c.name)}»: «${c.value}» — это не цвет вида #rrggbb, правка пропущена`); continue; }
    push(`colors.${c.name}`, (value.length === 4 ? '#' + value.slice(1).split('').map((x) => x + x).join('') : value).toLowerCase());
  }

  for (const t of asArray(theme && theme.type)) {
    if (!t || !t.name) continue;
    const prev = (doc.tokens && doc.tokens.type && doc.tokens.type[t.name]) || {};
    const next = { ...prev };
    let touched = false;
    for (const k of ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']) {
      // круг 9, п.2: «fontSize: "15px"» — тот же случай, что radius «8px»: число есть, единица лишняя
      if (t[k] == null || t[k] === '') continue;
      const got = parsePx(t[k]);
      if (!got) { note(`Стиль «${ruToken('type', t.name)}», ${ruPath(k)}: «${t[k]}» — не число: пропущено`); continue; }
      next[k] = got.n;
      touched = true;
    }
    if (typeof t.font === 'string' && t.font.trim()) { next.font = t.font.trim(); touched = true; }
    if (touched) push(`type.${t.name}`, next);
  }

  // asArray здесь нельзя: он выбрасывает falsy, а 0 — законное значение шкалы
  const scale = (list) => (Array.isArray(list) ? list : []).map((x) => (parsePx(x) || {}).n)
    .filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  /**
   * Круг 20 (SPEC §6.1): узлы ссылаются на шаги шкалы ПО НОМЕРУ, и шкала короче самой дальней
   * ссылки убила бы эти ссылки (dead-scale-ref, отступы в ноль) — молча, под видом «тёмной темы».
   *
   * Решение — сохранять НОМЕРА шагов, а не переписывать ссылки. Почему не rewriteScaleRefsOps:
   * переписывание ссылок «по ближайшему значению» — это догадка о том, какой старый шаг стал
   * каким новым, и десятки операций по узлам в транзакции, которая обещала поменять только
   * оформление. Смена значений шагов — ровно та «самая частая правка», ради которой индексы и
   * выбраны (§6.1): она не трогает ни одного узла, и всё переверстывается само.
   * Поэтому: массив длиннее — годится (новые шаги добавляются в хвост, старые номера целы);
   * короче, но не короче самой дальней ссылки — годится; короче ссылок — отброшен со словами.
   * И человеку говорится правда о том, что изменилось: значения шагов, а не узлы.
   */
  const scaleOps = (name, list) => {
    if (!Array.isArray(list) || !list.length) return;
    const v = scale(list);
    if (!v.length) return;
    const names = SCALE_RU[name];
    const cur = stepsOf(doc, name, engine);
    const refs = refsInDoc(doc, name, engine);
    const farthest = refs.reduce((m, r) => Math.max(m, Number(r.index) || 0), -1);
    if (v.length <= farthest) {
      note(`${cap(names.nom)}: модель прислала ${v.length} ${plural(v.length, 'шаг', 'шага', 'шагов')} вместо ${cur.length},`
        + ` а на шаги вплоть до ${farthest}-го ссылаются слои (${refs.length} ${plural(refs.length, 'значение', 'значения', 'значений')}).`
        + ' Укоротить шкалу значило бы сломать эти ссылки, поэтому правка шкалы пропущена — скажите значения'
        + ` всех ${cur.length} шагов`);
      return;
    }
    push(name, v);
    if (!refs.length) return;
    const changed = [];
    cur.forEach((old, i) => { if (i < v.length && v[i] !== old) changed.push(`${old} → ${v[i]}`); });
    const grew = v.length - cur.length;
    const sample = changed.slice(0, 3).join(', ') + (changed.length > 3 ? ` и ещё ${changed.length - 3}` : '');
    note(`${cap(names.nom)}: ${changed.length
      ? `изменены значения ${changed.length} ${plural(changed.length, 'шага', 'шагов', 'шагов')} из ${cur.length} (${sample})`
      : 'значения шагов остались прежними'}`
      + (grew > 0 ? `, добавлено шагов в конец: ${grew}` : grew < 0 ? `, шагов стало ${v.length} вместо ${cur.length}` : '')
      + `. Слои не правились: на шаги этой шкалы ссылаются ${refs.length} ${plural(refs.length, 'значение', 'значения', 'значений')}`
      + ' отступов, и они переверстались сами');
  };
  scaleOps('spacing', theme && theme.spacing);
  scaleOps('radii', theme && theme.radii);

  /* Круг 36 (SPEC §11): ступени скорости анимаций и тени. Порядок ступеней обязан сохраниться
   * (fast ≤ base ≤ slow): узлы ссылаются на ИМЯ ступени, и «быстро» медленнее «обычно» — ложь. */
  const motionIn = asArray(theme && theme.motion).filter((m) => m && MOTION_STEPS.includes(String(m.name)));
  if (motionIn.length) {
    const next = { ...motionSteps(doc) };
    const got = {};
    for (const m of motionIn) {
      const ms = parseMs(m.value);
      if (ms == null || ms < 0 || ms > MOTION_MAX_MS) {
        note(`Скорость анимаций «${MOTION_STEP_RU[m.name]}»: «${m.value}» — не длительность от 0 до ${MOTION_MAX_MS} мс, пропущено`);
        continue;
      }
      next[m.name] = Math.round(ms);
      got[m.name] = Math.round(ms);
    }
    if (!(next.fast <= next.base && next.base <= next.slow)) {
      note('Скорость анимаций: ступени перепутаны (быстро должно быть не дольше, чем обычно, а обычно — не дольше,'
        + ` чем медленно): ${next.fast}/${next.base}/${next.slow} мс — правка пропущена`);
    } else {
      for (const k of MOTION_STEPS) if (got[k] !== undefined) { touched.add('motion'); push(`motion.${k}`, got[k]); }
      const slow = MOTION_STEPS.filter((k) => got[k] !== undefined && got[k] > MICRO_MAX_MS);
      if (slow.length) {
        note(`Скорость анимаций: ступень «${MOTION_STEP_RU[slow[0]]}» — ${got[slow[0]]} мс, больше ${MICRO_MAX_MS} мс:`
          + ' для микроанимаций это вязко. Скажите «быстрее», если так не задумано');
      }
    }
  }
  for (const sh of asArray(theme && theme.shadow)) {
    if (!sh || !SHADOW_STEPS.includes(String(sh.name))) continue;
    const value = String(sh.value == null ? '' : sh.value).trim().replace(/\s+/g, ' ');
    if (!shadowDescOk(value, engine)) {
      note(`Тень «${SHADOW_RU[`shadow.${sh.name}`]}»: «${cutText(value, 40)}» — не похоже на тень`
        + ' (нужно «сдвиг-x сдвиг-y размытие цвет», например «0 4px 12px rgba(0,0,0,.14)»), пропущено');
      continue;
    }
    touched.add('shadow');
    push(`shadow.${sh.name}`, value);
  }

  if (!ops.length) throw ERR('schema', 'Модель не предложила ни одного корректного изменения токенов');

  /* Круг 11, п.3: сказать вслух, что правка легла на ВЕСЬ документ. Говорим только когда
   * артбордов больше одного: на единственном экране это не новость, а шум. */
  const boards = kidsOf(nodeOf(doc, doc.root)).filter((id) => nodeOf(doc, id));
  if (boards.length > 1) {
    const here = scope ? artboardOf(doc, (scope.ids && scope.ids[0]) || scope.containerId) : null;
    const others = boards.filter((id) => id !== here).map((id) => nameOrId(doc, id));
    const list = others.slice(0, 3).join(', ') + (others.length > 3 ? ` и ещё ${others.length - 3}` : '');
    const WHAT = { colors: 'цвета', type: 'шрифты и кегли', spacing: 'шкала отступов', radii: 'шкала скруглений', motion: 'скорость анимаций', shadow: 'тени', other: 'оформление' };
    const what = [...touched].map((k) => WHAT[k] || WHAT.other);
    const HOW = {
      colors: 'Перекрасить один экран отдельно так нельзя: для этого надо менять заливку и цвет его слоёв',
      type: 'Поменять шрифт или кегль на одном экране отдельно так нельзя: для этого надо задать стиль его текстам',
      spacing: 'Своя шкала у одного экрана невозможна: отступы и зазоры надо задавать его слоям поимённо',
      radii: 'Своя шкала у одного экрана невозможна: скругления надо задавать его слоям поимённо',
      motion: 'Своя скорость у одного экрана невозможна: скорость анимации надо задавать его слоям поимённо',
      shadow: 'Свои тени у одного экрана невозможны: тень надо задавать его слоям поимённо',
      other: 'Отдельно для одного экрана так нельзя: значения надо задавать его слоям поимённо',
    };
    // совет — по тому, что и правда поменялось; если поменялось разное, ведёт самое заметное
    const lead = ['colors', 'type', 'spacing', 'radii', 'motion', 'shadow', 'other'].find((k) => touched.has(k)) || 'other';
    /* Порядок слов такой, чтобы фраза была согласована при ЛЮБОМ наборе видов: «цвета»,
     * «шрифты и кегли» и «шкала отступов» стоят в скобках, а не подлежащим. */
    note('Оформление документа общее: поменялось то, что принадлежит документу, а не экрану'
      + ` (${what.join(', ')}), — значит, поменялись ВСЕ доски${list ? `, в том числе ${list}` : ''}.`
      + ` ${HOW[lead]}`);
  }
  return ops;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 9. Конвейер
 * ──────────────────────────────────────────────────────────────────────────── */

const MAX_VALIDATOR_WARNINGS = 8;

/**
 * Круг 5, п.5: оболочка показывает первые два предупреждения, а копились они в порядке
 * появления — и служебное «Починка не помогла — оставил первый вариант» вытесняло с экрана
 * «правка ушла на другой экран» и «подходит узлов — 3».
 *
 * Круг 9, п.9: одного «важного» ранга оказалось мало — на одной команде набиралось четыре-пять
 * предупреждений ранга 0, и какое из них увидит человек, решал случайный порядок появления.
 * Теперь «важное» разделено: сначала то, что меняет ПОНИМАНИЕ РЕЗУЛЬТАТА (правка пропущена,
 * ничего не изменилось, на экране не видно), потом адресация (в какой узел и на какой экран
 * легло), потом всё остальное.
 *   0 — результат не такой, как человек думает: правка пропущена, слой не найден, ничего не
 *       изменилось, в документе есть — на экране нет;
 *   1 — адресация: нашлось вне области, правка ушла туда, подходит несколько узлов, правлю все,
 *       кладу уровнем выше;
 *   2 — прочие замечания о содержимом правки (подстановки, «уже так», синонимы);
 *   3 — качество макета (контраст, вылез за рамки) — это про макет, а не про команду;
 *   4 — служебное про работу модели.
 * Внутри группы порядок сохраняется (сортировка устойчивая).
 */
const WARN_RANKS = [
  [4, /^(Починка|Первый ответ модели)/u],
  [3, /^Проверка макета:/u],
  [0, new RegExp([
    'пропущен', 'не найден', 'отброшен', 'обрез', 'ни на что не повлияла', 'не изменилось',
    'на экране — нет', 'неизвестн\\p{L}* цвет', 'не #rrggbb', 'служебн', 'недопустим',
    // круг 19, п.6: «это правка компонента, а не одного слоя» человек обязан прочитать первым:
    // главная строка результата собирается по операциям и выглядит правкой одного узла
    'правка компонента', 'добавлен в библиотеку',
    'нет типографического токена', 'не одно из', 'ничего не мен',
    // круг 16, п.3: цвета в документе не те, что вернула модель — это про результат, а не придирка
    'в палитре от модели',
  ].join('|'), 'iu')],
  [1, new RegExp([
    'найден\\p{L}* вне', 'правка ушла', 'источник взят', 'подходит (?:слоёв|узлов)', 'правлю все',
    'кладу в', 'кладу уровнем выше', 'место вставки', 'существующ', 'названа',
    // круг 11, п.3: «поменялись все артборды» — это про то, КУДА легла правка, и человек
    // обязан увидеть это раньше замечаний о контрасте
    'оформление документа общее',
  ].join('|'), 'iu')],
  [2, new RegExp([
    'понял как', 'понят как', 'оставил «', 'уже ', 'нельзя', 'вместо', 'зажал',
    // круг 20: число мимо шкалы — оставлено или приведено к шагу; что поменялось в шкале
    'мимо шкалы', 'ближайший шаг', 'переверстались сами',
  ].join('|'), 'iu')],
];

/** Важность предупреждения: 0 — самое важное человеку, 4 — служебное. */
export function warningRank(text) {
  const s = String(text == null ? '' : text);
  for (const [rank, re] of WARN_RANKS) if (re.test(s)) return rank;
  return 2;                                        // неопознанное — «прочее о содержимом правки»
}

/** Предупреждения по важности, устойчиво: оболочке достаточно взять первые два. */
export function sortWarnings(list) {
  return asArray(list)
    .map((w, i) => ({ w, i, r: warningRank(w) }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((e) => e.w);
}

/** Дедлайн одного обращения к модели (п.15, п.16): «Отменить» и «не отвечает» должны работать. */
export const CALL_TIMEOUT_MS = 120000;

const STAGE_LABELS = {
  classify: 'Разбираю запрос',
  plan: 'Планирую',
  generate: 'Генерирую',
  // круг 31: «Собираю операции — Перевожу ответ в операции» человеку ничего не говорило
  materialize: 'Прикладываю к макету',
  validate: 'Проверяю',
  repair: 'Чиню',
  retry: 'Повторяю запрос',
  clarify: 'Переспрашиваю',
  // круг 9, п.4: не авария, а ответ: просимого в модели документа нет
  cannot: 'Так в этом редакторе нельзя',
  variant: 'Готовлю вариант',
  done: 'Готово',
  error: 'Не вышло',
};

/**
 * Нарушение → строка для человека (п.17): имя слоя вместо технического id,
 * контраст — по-русски, а не «low-contrast #t3».
 */
/**
 * Круг 29: ядро пишет выход за рамки «на 40×0»; оболочка переводила это в «на 40 px по ширине»
 * только в предупреждениях, а в стадии «Чиню» человек читал «40×0». Переводим у источника —
 * одни слова и в ленте, и в итоге.
 */
export function overflowWords(text) {
  return String(text == null ? '' : text).replace(/на\s+(\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)/gu, (all, a, b) => {
    const w = Number(String(a).replace(',', '.'));
    const h = Number(String(b).replace(',', '.'));
    const bits = [];
    if (w >= 0.5) bits.push(`${Math.round(w)} px по ширине`);
    if (h >= 0.5) bits.push(`${Math.round(h)} px по высоте`);
    return bits.length ? `на ${bits.join(' и ')}` : 'на доли пикселя';
  });
}

function formatViolation(v, doc) {
  if (v == null) return 'неизвестное нарушение';
  if (typeof v === 'string') return v;
  const where = v.nodeId || v.id || v.node || v.target;
  const node = doc && where ? nodeOf(doc, where) : null;
  const name = node && node.name ? String(node.name) : '';
  // круг 19: у экземпляра своего имени обычно нет — он зовётся по компоненту, а не «#i_2g7a8l»
  const who = node ? nameOrId(doc, where) : (where ? `#${where}` : '');
  let text = String(v.message || v.text || v.code || v.rule || JSON.stringify(v)).trim();
  // core пишет имя слоя в начале сообщения; второй раз его печатать не надо (круг 3, п.10)
  const lead = `«${name}»`;
  if (name && text.startsWith(lead)) text = text.slice(lead.length).replace(/^\s*:?\s*/, '');
  // у экземпляра имя в документе пустое, а ядро пишет в начало имя компонента — тот же повтор
  if (!name && who && text.startsWith(who)) text = text.slice(who.length).replace(/^\s*:?\s*/, '');
  if (v.code === 'low-contrast') {
    const ratio = /(\d+[.,]\d+):1/.exec(text);
    const need = /норме\s*(\d+(?:[.,]\d+)?):1/.exec(text);
    const tail = ratio && need ? `контраст ${ratio[1]}:1 при норме ${need[1]}:1` : text;
    return `Плохо читается текст ${who || ''}: ${tail}`.replace('  ', ' ').trim();
  }
  /**
   * Круг 19, п.7 (SPEC §5.8): новые коды — человеческими словами. Сообщения ядра тут не годятся
   * дословно: в них есть внутренний id мастера («компонента «f_28e1k6» в документе нет») и слово
   * «пропс». Ни того, ни другого человек знать не должен — он видит имена компонентов и свойств.
   */
  if (v.code === 'dead-instance') {
    return `${who || 'Экземпляр'} ссылается на компонент, которого в библиотеке нет:`
      + ' показать его нечем. Удалите этот экземпляр или соберите компонент заново';
  }
  if (v.code === 'unknown-prop') {
    /* Ядро присылает ОДНО нарушение на каждое лишнее свойство, и его имя стоит в сообщении
     * последним в кавычках. Берём именно его, а не весь список лишних: иначе одна и та же
     * строка печаталась бы по разу на каждое свойство. Если разобрать не удалось — считаем
     * список по документу сами. */
    const master = node ? nodeOf(doc, node.of) : null;
    const comp = master && master.component;
    const named = (comp && comp.name) || 'компонент';
    const one = /«([^»]+)»\s*$/.exec(text);
    if (one) {
      return `${who || 'У экземпляра'}: свойства «${one[1]}» компонент «${named}» не объявлял`
        + ' — оно не применяется';
    }
    const known = new Set((comp && Array.isArray(comp.props) ? comp.props : []).map((x) => x && x.name));
    const extra = Object.keys((node && node.props) || {}).filter((k) => !known.has(k));
    return `${who || 'У экземпляра'}: ${extra.length > 1 ? 'свойств' : 'свойства'}`
      + ` ${extra.map((k) => `«${k}»`).join(', ') || '—'} компонент «${named}» не объявлял`
      + ` — ${extra.length > 1 ? 'они не применяются' : 'оно не применяется'}`;
  }
  if (v.code === 'component-cycle') {
    return `Так нельзя: ${text} — такой компонент ни посчитать, ни показать.`
      + ' Уберите его экземпляр из его же содержимого';
  }
  if (v.code === 'instance-too-deep') return `Экземпляры вложены слишком глубоко: ${text}`;
  if (v.code === 'zero-size') return `Слой ${who} не виден: ${text}`;
  if (v.code === 'out-of-parent') return `Слой ${who} вылез за рамки: ${overflowWords(text)}`;
  if (v.code === 'empty-frame') return `Фрейм ${who} пуст — внутри ничего нет`;
  /**
   * Круг 20 (SPEC §6.7): человек шкалу знать не обязан — ни spacing, ни radii, ни gap в его строках.
   * Ядро пишет «layout.gap → шага «spacing.99» нет — в шкале отступов 13 шагов (0..12)»; мёртвые
   * ссылки считаем по самому узлу (документу они принадлежат, а не тексту), и называем поля
   * словами инспектора: «зазор», «отступ сверху».
   */
  if (v.code === 'dead-scale-ref') {
    const dead = node ? deadRefsOf(doc, node, null) : [];
    if (dead.length) {
      const byScale = new Map();
      for (const d of dead) { if (!byScale.has(d.want)) byScale.set(d.want, []); byScale.get(d.want).push(d); }
      const parts = [...byScale.entries()].map(([scale, list]) => {
        const steps = stepsOf(doc, scale, null);
        const fields = list.map((d) => ruPath(d.path)).join(', ');
        const many = list.length > 1;
        return `${fields} ссыла${many ? 'ются' : 'ется'} на шаг ${SCALE_RU[scale].gen}, которого нет`
          + (steps.length ? ` (в шкале ${steps.length} ${plural(steps.length, 'шаг', 'шага', 'шагов')}, номера 0…${steps.length - 1})` : ' (шкала пуста)')
          + ` — ${many ? 'считаются нулями' : 'считается нулём'}`;
      });
      return `${who ? `${cap(who)}: ` : ''}${parts.join('; ')}. Задайте значение заново или добавьте шаг в шкалу`;
    }
    return `${who ? `${who}: ` : ''}ссылка на шаг шкалы, которого нет — считается нулём. Задайте значение заново или добавьте шаг в шкалу`;
  }
  /* Круг 36 (SPEC §11.2): коды состояний и движения — словами, без motion.fast и states.hover. */
  if (v.code === 'motion-slow') {
    // число — из сообщения ядра (оно посчитано с раскрытием экземпляра), иначе — по узлу
    const said = /(\d+(?:[.,]\d+)?)\s*мс/.exec(text);
    const ms = said ? Number(said[1].replace(',', '.')) : node ? nodeMotionMs(doc, node) : null;
    return `${who || 'Слой'}: микроанимация длится ${ms != null ? `${Math.round(ms)} мс` : 'долго'} — дольше ${MICRO_MAX_MS} мс,`
      + ' отклик будет казаться вязким';
  }
  if (v.code === 'dead-motion-ref') {
    return `${who || 'Слой'}: ссылка на ступень скорости или тени, которой нет в оформлении — взято значение по умолчанию`;
  }
  if (v.code === 'state-no-effect') {
    const st = STATE_NAMES.find((x) => new RegExp(`(^|[^a-z])${x}([^a-z]|$)`).test(text));
    return `${who || 'Слой'}: ${st ? `${STATE_RU[st].nom} ничем не отличается` : 'состояние ничем не отличается'} от вида в покое`;
  }
  if (v.code === 'press-without-hover') {
    return `${who || 'Слой'}: есть нажатие, но нет наведения — мышь над ним ничего не меняет, пока не нажмут`;
  }
  if (v.code === 'state-on-page') return 'У страницы состояний не бывает — наведение и нажатие задаются слоям на ней';
  if (v.code === 'off-scale') {
    // ядро: «вне шкалы отступов: gap 24, padding.t 10» → «зазор 24, отступ сверху 10»
    const fields = [];
    const re = /\b(gap|padding\.[trbl]|padding|radius)\s+(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(text))) fields.push(`${ruPath(m[1] === 'gap' ? 'layout.gap' : m[1] === 'radius' ? 'radius' : `layout.${m[1]}`)} ${m[2]}`);
    if (fields.length) return `${who || 'Слой'}: мимо шкалы отступов — ${fields.join(', ')}`;
    // круг 36: длительность и подъём состояния числом мимо шкалы — их словами, не «отступы»
    if (/длительност|подъ[её]м/.test(text)) {
      const said = text.replace(/\((hover|press|focus)\)/g, (_, st) => `(${STATE_RU[st].at})`);
      return `${who || 'Слой'}: ${said}`;
    }
    return `Отступы ${who} мимо шкалы документа: ${text.replace(/\bgap\b/g, 'зазор').replace(/\bpadding\.([trbl])\b/g, (_, k) => `отступ ${SIDE_RU[k]}`)}`;
  }
  return who ? `${who}: ${text}` : text;
}

/** Заголовки видов нарушений для сводки «и ещё N таких же». */
const VIOLATION_KIND = {
  overflow: 'не помещается содержимое',
  'out-of-parent': 'слои вылезают за родителя',
  'zero-size': 'невидимые (нулевые) слои',
  overlap: 'наложения',
  'low-contrast': 'плохо читается текст',
  'off-scale': 'отступы мимо шкалы',
  'empty-frame': 'пустые фреймы',
  // круг 20 (SPEC §6.1)
  'dead-scale-ref': 'ссылки на шаги шкалы, которых нет',
  // круг 19, п.7 (SPEC §5.8)
  'dead-instance': 'экземпляры без компонента',
  'unknown-prop': 'свойства, которых компонент не объявлял',
  'component-cycle': 'компонент внутри самого себя',
  'instance-too-deep': 'слишком глубокая вложенность экземпляров',
  // круг 32: children не массив или непустой у не-контейнера (документ до круга 31, SPEC §9.15)
  'bad-children': 'слои с негодным списком детей',
  // круг 36 (SPEC §11.2)
  'motion-slow': 'слишком медленные микроанимации',
  'dead-motion-ref': 'ссылки на ступени скорости или тени, которых нет',
  'state-no-effect': 'состояния, не отличающиеся от покоя',
  'press-without-hover': 'нажатие без наведения',
  'state-on-page': 'состояния у страницы',
};

/**
 * Круг 3, п.5: замечания валидатора ДО правки — человеческими словами, для шапки контекста.
 * Раньше validate() звался только ПОСЛЕ применения, и на вопрос «проверь макет, что не так?»
 * модель рассуждала по хексам из выжимки, хотя приложение уже знало про низкий контраст,
 * выход за родителя, нулевые размеры и отступы вне шкалы.
 * @param {Array} list готовый результат validate (чтобы не считать дважды)
 */
export function describeViolations(list, doc, max = 10) {
  const all = Array.isArray(list) ? list : [];
  if (!all.length) return '';
  // группируем по виду, сохраняя порядок валидатора (он отсортирован по важности), и печатаем
  // по кругу: иначе десяток «выходит за родителя» вытеснит единственное «текст не читается»
  const groups = new Map();
  for (const v of all) {
    const code = (v && v.code) || 'other';
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(v);
  }
  const lines = [];
  const shown = new Map();
  const PER_CODE = 3;
  for (let round = 0; round < PER_CODE && lines.length < max; round++) {
    for (const [code, items] of groups) {
      if (lines.length >= max || round >= items.length) continue;
      lines.push('- ' + formatViolation(items[round], doc));
      shown.set(code, (shown.get(code) || 0) + 1);
    }
  }
  const skipped = all.length - lines.length;
  if (skipped > 0) {
    const kinds = [...groups.entries()].filter(([code, items]) => items.length > (shown.get(code) || 0))
      .map(([code, items]) => `${VIOLATION_KIND[code] || code} — всего ${items.length}`).join('; ');
    lines.push(`- и ещё ${skipped} замечани(е/й) того же рода${kinds ? ` (${kinds})` : ''}`);
  }
  return lines.join('\n');
}

function safeSolve(engine, doc) {
  try {
    return typeof engine.solve === 'function' ? engine.solve(doc) : null;
  } catch {
    return null;
  }
}

function safeValidate(engine, doc, geo) {
  try {
    const out = typeof engine.validate === 'function' ? engine.validate(doc, geo) : [];
    return Array.isArray(out) ? out : [];
  } catch (e) {
    return [{ message: `валидатор упал: ${e && e.message ? e.message : e}` }];
  }
}

/** Все экземпляры компонента в документе, в порядке документа. */
function instancesOf(doc, masterId) {
  return Object.keys((doc && doc.nodes) || {})
    .filter((id) => doc.nodes[id] && doc.nodes[id].type === 'instance' && doc.nodes[id].of === masterId);
}

/**
 * Круг 19, п.4-5: «сделай из этого компонент» и «отсоедини экземпляр» БЕЗ обращения к модели.
 * Возвращает готовый результат прогона либо null — «пусть решает модель» (так поступаем с
 * мягкими формулировками, которые могли значить и что-то другое: «сделай его обычным»).
 *
 * Отказ здесь — это `cannot` (честный ответ), а не ошибка с кнопкой «Повторить»: повтор той же
 * фразы над тем же документом заведомо даст то же самое.
 */
/**
 * Круг 36 (SPEC §11): «убери анимации» без модели. Снимает states и motion у слоёв области
 * (выделение с потомками, иначе активная доска; «везде» — весь документ). Компоненты библиотеки
 * не трогаются: это правка компонента, о ней говорится отдельно.
 */
function motionClearIntent({ engine, doc, scope, where, utterance, geo, emit }) {
  const warnings = [];
  const note = (m) => { if (m && !warnings.includes(m)) warnings.push(m); };
  const preview = { doc, geo: geo || safeSolve(engine, doc) };
  const planOf = (title, summary) => ({ intent: 'edit', title, summary, steps: [title], targets: [] });
  const everywhere = where === 'document';
  const area = everywhere ? collectSubtree(doc, [doc.root]) : collectSubtree(doc, asArray(scope && scope.ids));
  const lib = area.filter((id) => inLibrary(doc, engine, id) && hasMotion(nodeOf(doc, id)));
  const ids = area.filter((id) => id !== doc.root && !inLibrary(doc, engine, id) && hasMotion(nodeOf(doc, id)));
  emit('classify', `снять анимации — распознано локально, без модели (слоёв с анимацией: ${ids.length})`);
  if (lib.length) {
    note(`У ${lib.length} ${plural(lib.length, 'слоя', 'слоёв', 'слоёв')} в библиотеке компонентов анимации остались:`
      + ' это правка самого компонента — скажите «убери анимации у компонента …»');
  }
  if (!ids.length) {
    const elsewhere = everywhere ? 0 : Object.keys(doc.nodes || {})
      .filter((id) => !inLibrary(doc, engine, id) && hasMotion(nodeOf(doc, id))).length;
    const where_ = scope && scope.kind === 'selection' ? 'В выделенном' : scope && scope.kind === 'artboard' ? 'На этой доске' : 'В документе';
    const why = `${where_} анимаций нет — снимать нечего.`
      + (elsewhere ? ` На других досках они есть у ${elsewhere} ${plural(elsewhere, 'слоя', 'слоёв', 'слоёв')}: скажите «убери анимации везде»` : '');
    note(why);
    emit('validate', 'Менять нечего');
    emit('done', 'Менять нечего');
    return { ops: [], preview, plan: planOf('Анимаций нет', why), local: 'motion-clear', nothingChanged: true, nothingToChange: true, warnings };
  }
  const ops = [];
  for (const id of ids) {
    const n = nodeOf(doc, id);
    if (n.states !== undefined) ops.push(mkOp(engine, 'set', { id, path: 'states' }));
    if (n.motion !== undefined) ops.push(mkOp(engine, 'set', { id, path: 'motion' }));
  }
  let applied;
  try { applied = engine.applyOps(doc, ops); } catch (e) { applied = { error: e && e.message ? e.message : String(e) }; }
  if (!applied || applied.error || !applied.doc) {
    const err = applied && applied.error;
    const why = `Снять анимации не вышло: ${typeof err === 'string' ? err : (err && err.message) || 'операции не применились'}`;
    emit('cannot', why);
    emit('done', 'Так нельзя');
    return { ops: [], preview, plan: planOf('Снятие анимаций', why), cannot: why, warnings };
  }
  const names = listNames(doc, ids.slice(0, 3)).join(', ') + (ids.length > 3 ? ` и ещё ${ids.length - 3}` : '');
  const title = ids.length === 1 ? `Без анимации: ${names}` : `Без анимаций: ${ids.length} ${plural(ids.length, 'слой', 'слоя', 'слоёв')}`;
  const summary = `Снял состояния наведения, нажатия и фокуса и движение: ${names}.`;
  const plan = planOf(title, summary);
  emit('materialize', summary, { title });
  emit('validate', 'Нарушений нет');
  emit('done', summary, { title });
  let changeSummary = '';
  try { changeSummary = describeChange(ops, doc, applied.doc, engine); } catch { changeSummary = ''; }
  return {
    ops, preview: { doc: applied.doc, geo: safeSolve(engine, applied.doc) }, plan, local: 'motion-clear',
    ...(changeSummary ? { changeSummary } : {}),
    warnings,
  };
}

function componentIntent({ engine, doc, scope, utterance, ask, geo, emit }) {
  const warnings = [];
  const note = (m) => { if (m && !warnings.includes(m)) warnings.push(m); };
  const comps = componentList(engine, doc);
  const preview = { doc, geo: geo || safeSolve(engine, doc) };
  const planOf = (title, summary) => ({ intent: 'edit', title, summary, steps: [title], targets: [] });
  const done = (data, local, plan) => {
    const baseline = baselineViolations(safeValidate(engine, doc, preview.geo));
    const got = materialize({
      engine, doc, data, intent: 'edit', scope, placement: null, persona: null,
      baseline, geo: preview.geo, group: false, said: utterance,
    });
    if (got.fatal || !got.ops.length) {
      /* Причина уже названа словами внутри patchToOps и лежит в его предупреждениях. Берём
       * ИМЕННО её, а не текст фатальной ошибки: «Ни одну правку не удалось применить» — это
       * служебная шапка про наш конвейер, а человек спрашивал про компонент. */
      const said = (got.warnings || []).filter(Boolean);
      const why = said[0] || got.problems[0] || 'Эту просьбу выполнить не удалось';
      emit('cannot', why);
      emit('done', 'Так нельзя');
      return { ops: [], preview, plan, cannot: why, warnings: warnings.concat(said.slice(1)) };
    }
    emit('materialize', plan.summary, { title: plan.title });
    emit('validate', got.problems.length ? `Осталось замечаний: ${got.problems.length}` : 'Нарушений нет');
    for (const p of got.problems.slice(0, MAX_VALIDATOR_WARNINGS)) note(`Проверка макета: ${p}`);
    emit('done', plan.summary, { title: plan.title });
    return {
      ops: got.ops, preview: got.preview, plan, local,
      ...(got.nothingChanged ? { nothingChanged: true } : {}),
      ...(got.nothingToChange ? { nothingToChange: true } : {}),
      warnings: warnings.concat(got.warnings || []),
    };
  };
  const asking = (question, options) => {
    emit('clarify', question, { options });
    emit('done', 'Жду уточнения');
    return { ops: [], preview, plan: planOf('Уточняю', question), clarify: question, clarifyOptions: options, warnings };
  };
  const nope = (why, title) => {
    emit('cannot', why);
    emit('done', 'Так нельзя');
    return { ops: [], preview, plan: planOf(title, why), cannot: why, warnings };
  };
  /** Названные словами узлы: сначала слой, потом — не назван ли так сам компонент. */
  const named = (words) => {
    const got = refCandidates(engine, doc, words, scope, {});
    return got.ids.filter((id) => nodeOf(doc, id));
  };
  const selected = scope.kind === 'selection' ? asArray(scope.ids).filter((id) => nodeOf(doc, id)) : [];
  /** Три готовые команды-ответа: слои, из которых компонент сделать МОЖНО. */
  const makeOptions = () => {
    const root = scope.containerId && nodeOf(doc, scope.containerId) ? scope.containerId : doc.root;
    const can = (id) => {
      if (typeof engine.canMakeComponent !== 'function') return true;
      try { return !!engine.canMakeComponent(doc, id).ok; } catch { return false; }
    };
    const out = [];
    for (const kid of kidsOf(nodeOf(doc, root))) {
      const n = nodeOf(doc, kid);
      if (!n || !n.name || n.type !== 'frame' || !can(kid)) continue;
      out.push(`сделай из «${n.name}» компонент`);
      if (out.length === 3) break;
    }
    return out;
  };

  if (ask.kind === 'detach') {
    let ids = [];
    if (ask.what) {
      const comp = findComponent(comps, ask.what);
      if (comp.info) ids = instancesOf(doc, comp.info.id);
      if (!ids.length) ids = named(ask.what).filter((id) => nodeOf(doc, id).type === 'instance');
      if (!ids.length) {
        const hit = named(ask.what)[0];
        if (ask.soft) return null;
        if (hit) {
          return nope(`${nameOrId(doc, hit)} — не экземпляр компонента, отсоединять там нечего.`
            + ' Отсоединяют экземпляр: он показан в документе одной строкой и следует за компонентом'
            + ' из библиотеки.', 'Отсоединять нечего');
        }
      }
    } else {
      ids = selected.filter((id) => nodeOf(doc, id).type === 'instance');
    }
    if (!ids.length) {
      if (ask.soft) return null;                     // формулировка мягкая — пусть решает модель
      const any = Object.keys(doc.nodes).some((id) => doc.nodes[id].type === 'instance');
      if (!any) {
        return nope('В документе нет ни одного экземпляра компонента — отсоединять нечего.'
          + ' Экземпляры появляются, когда собираешь из библиотеки.', 'Отсоединять нечего');
      }
      return asking('Не понял, что отсоединить: выделите экземпляр компонента или назовите компонент.',
        comps.filter((c) => c.instances).slice(0, 3).map((c) => `отсоедини экземпляры «${c.name}»`));
    }
    emit('classify', `отсоединение — распознано локально, без модели (экземпляров: ${ids.length})`);
    const plan = planOf(ids.length > 1 ? `Отсоединяю экземпляры: ${ids.length}` : 'Отсоединяю экземпляр',
      'Экземпляр стал обычным поддеревом: за компонентом он больше не следует. Это делает редактор, модель тут не нужна.');
    return done({ edits: ids.map((id) => ({ op: 'detach', target: `#${id}` })) }, 'detach', plan);
  }

  // ask.kind === 'make'
  let ids = ask.what ? named(ask.what) : selected;
  if (ask.what && !ids.length) {
    const comp = findComponent(comps, ask.what);
    if (comp.info) {
      return nope(`«${comp.info.name}» — уже компонент библиотеки, второй раз добавлять его некуда.`
        + (ask.name ? ` Чтобы переназвать, скажите «назови этот компонент ${ask.name}», выделив его экземпляр.` : ''),
        'Это уже компонент');
    }
  }
  if (ids.length > 1) {
    const names = listNames(doc, ids.slice(0, 3)).join(', ');
    return asking(`Компонент делается из одного слоя, а выделено ${ids.length}: ${names}${ids.length > 3 ? ' и ещё' : ''}.`
      + ' Скажите, из какого именно, — или сначала оберните их в один фрейм.',
      ids.slice(0, 3).map((id) => `сделай из «${(nodeOf(doc, id) || {}).name || id}» компонент`));
  }
  if (!ids.length) {
    return asking('Не понял, из чего делать компонент: выделите слой или назовите его.', makeOptions());
  }
  const id = ids[0];
  const node = nodeOf(doc, id);
  const isComp = node.type === 'instance' || (node.component && inLibrary(doc, engine, id));
  if (!isComp && typeof engine.canMakeComponent === 'function') {
    let can = { ok: false, reason: 'так нельзя' };
    try { can = engine.canMakeComponent(doc, id); } catch { /* причину скажем общей */ }
    if (!can.ok) {
      return nope(`${nameOrId(doc, id)} компонентом сделать нельзя: ${can.reason}.`
        + ' Компонент делается из обычного слоя на доске — например из карточки или кнопки.',
        'Компонентом это не станет');
    }
  }
  if (isComp && !ask.name) {
    const master = node.type === 'instance' ? nodeOf(doc, node.of) : node;
    const was = (master && master.component && master.component.name) || 'компонент';
    return nope(`${nameOrId(doc, id)} и так из библиотеки: это компонент «${was}», второй раз добавлять его некуда.`
      + ` Скажите новое имя («назови это компонентом …»), если надо переназвать, или отсоедините экземпляр,`
      + ' чтобы он перестал следовать компоненту.', 'Это уже компонент');
  }
  emit('classify', `компонент — распознано локально, без модели${ask.name ? `, имя сказано: «${ask.name}»` : ''}`);
  const plan = planOf(isComp ? `Компонент «${ask.name}» вместо прежнего имени`
    : `Компонент${ask.name ? ` «${ask.name}»` : ''} из ${nameOrId(doc, id)}`,
    isComp
      ? 'Имя компонента меняется разом во всех его экземплярах. Это делает редактор, модель тут не нужна.'
      : 'Слой переезжает в библиотеку, на доске остаётся его экземпляр. Это делает редактор, модель тут не нужна.');
  return done({ edits: [{ op: 'component', target: `#${id}`, ...(ask.name ? { name: ask.name } : {}) }] },
    isComp ? 'componentRename' : 'component', plan);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Внешняя библиотека (круг 24, SPEC §10.6): словарь компонентов от DUIL
 * ──────────────────────────────────────────────────────────────────────────── */

/** Пределы переноса внешних мастеров: узлов в одном мастере и всего. */
const EXT_MASTER_NODES = 400;
const EXT_TOTAL_NODES = 4000;

const compKey = (name) => String(name == null ? '' : name).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Есть ли что брать: `library` — непустой массив документов-библиотек. */
function hasExternalLibrary(library) {
  return asArray(library).some((e) => e && e.doc && e.doc.nodes && e.doc.root);
}

/**
 * Документ-библиотека → его минимальная выжимка для передачи: корень, страница библиотеки и
 * мастера с поддеревьями (остальные доски словарю не нужны). DUIL зовёт это перед тем, как
 * отдать словарь в прогон (и в воркер), чтобы не возить по потокам целые проекты.
 * @param {object} doc
 * @param {object} engine
 * @returns {object|null} документ или null, если библиотеки в нём нет
 */
export function libraryDocOf(doc, engine) {
  if (!doc || !doc.nodes || !doc.root) return null;
  const libId = libraryIdOf(doc, engine);
  if (!libId) return null;
  const keep = libraryIds(doc, engine);
  const nodes = {};
  for (const id of keep) if (doc.nodes[id]) nodes[id] = doc.nodes[id];
  const root = doc.nodes[doc.root];
  nodes[doc.root] = { ...root, children: [libId] };
  return { ...doc, nodes };
}

/**
 * Внешний словарь → «документ плюс»: стейт, в библиотеку которого временно положены мастера
 * внешних компонентов (свежие глобальные id), чтобы весь конвейер — выжимка, сборка
 * экземпляров, проверка — работал с ними как со своими. Имена документа главнее: внешний
 * компонент с тем же именем (без учёта регистра) не берётся; среди внешних — первый по
 * порядку библиотек. Компонент, внутри которого экземпляр мастера, которого не перенести,
 * не берётся вовсе.
 * @param {object} doc
 * @param {Array<{doc: object, name?: string, id?: string}>} library
 * @param {object} engine
 * @returns {null | {doc: object, libId: string, libOps: object[], masters: Array<{rootId, name, source, ops, ids: Set<string>, deps: Set<string>}>}}
 */
export function externalLibraryPlan(doc, library, engine) {
  if (!hasExternalLibrary(library) || !engine || typeof engine.applyOps !== 'function') return null;
  const own = componentList(engine, doc);
  const ownByKey = new Map(own.map((c) => [compKey(c.name), c.id]));
  const seen = new Set(ownByKey.keys());

  /* кандидаты по порядку библиотек */
  const cands = [];
  for (const entry of asArray(library)) {
    const lib = entry && entry.doc;
    if (!lib || !lib.nodes || !lib.root) continue;
    for (const info of componentList(engine, lib)) {
      const key = compKey(info && info.name);
      if (!key || seen.has(key) || !lib.nodes[info.id]) continue;
      seen.add(key);
      cands.push({ name: info.name, key, source: String(entry.name || entry.id || ''), lib, rootId: info.id });
    }
  }
  if (!cands.length) return null;

  /* поддеревья и свежие id: ключ — библиотека + её id (у двух библиотек id могут совпасть) */
  const fresh = new Map();            // lib → Map(old → new)
  const freshOf = (lib) => { let m = fresh.get(lib); if (!m) { m = new Map(); fresh.set(lib, m); } return m; };
  const prefixOf = (t) => ({ frame: 'f', text: 't', rect: 'r', ellipse: 'e', image: 'i', instance: 'i' }[t] || 'n');
  const gen = typeof engine.uid === 'function' ? engine.uid : localUid;
  let total = 0;
  for (const c of cands) {
    const order = [];
    const walk = (id, depth) => {
      const n = c.lib.nodes[id];
      if (!n || order.length > EXT_MASTER_NODES || depth > MAX_TREE_DEPTH * 4 || order.includes(id)) return;
      order.push(id);
      for (const k of kidsOf(n)) walk(k, depth + 1);
    };
    walk(c.rootId, 0);
    if (order.length > EXT_MASTER_NODES || total + order.length > EXT_TOTAL_NODES) { c.skip = true; continue; }
    total += order.length;
    c.order = order;
    const m = freshOf(c.lib);
    for (const id of order) m.set(id, String(gen(prefixOf(c.lib.nodes[id].type))));
  }

  /* вложенные экземпляры: свой перенесённый мастер, иначе мастер документа с тем же именем */
  const byLibRoot = new Map();        // lib → Map(rootId → cand)
  for (const c of cands) {
    if (c.skip) continue;
    let m = byLibRoot.get(c.lib);
    if (!m) { m = new Map(); byLibRoot.set(c.lib, m); }
    m.set(c.rootId, c);
  }
  const nameOfMaster = (lib, id) => {
    const n = lib.nodes[id];
    return n && n.component && typeof n.component.name === 'string' ? n.component.name : null;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of cands) {
      if (c.skip) continue;
      c.deps = new Set();
      c.ofMap = new Map();
      for (const id of c.order) {
        const n = c.lib.nodes[id];
        if (!n || n.type !== 'instance' || typeof n.of !== 'string') continue;
        const dep = (byLibRoot.get(c.lib) || new Map()).get(n.of);
        if (dep && !dep.skip) { c.deps.add(dep.rootId); c.ofMap.set(n.of, freshOf(c.lib).get(n.of)); continue; }
        const ownId = ownByKey.get(compKey(nameOfMaster(c.lib, n.of)));
        if (ownId) { c.ofMap.set(n.of, ownId); continue; }
        c.skip = true;
        changed = true;
        break;
      }
    }
  }
  const take = cands.filter((c) => !c.skip);
  if (!take.length) return null;

  /* библиотека документа: есть — кладём в неё, нет — заводим (её создание — тоже кандидат в префикс) */
  let libId = libraryIdOf(doc, engine);
  let libOps = [];
  if (!libId) {
    if (typeof engine.ensureLibraryOps !== 'function') return null;
    libOps = asArray(engine.ensureLibraryOps(doc));
    const made = libOps[0] && libOps[0].node;
    if (!made || !made.id) return null;
    libId = made.id;
  }

  const masters = take.map((c) => {
    const m = freshOf(c.lib);
    let component = null;
    const ops = c.order.map((oldId, i) => {
      const src = c.lib.nodes[oldId];
      const node = JSON.parse(JSON.stringify(src));
      node.id = m.get(oldId);
      node.parent = i === 0 ? libId : m.get(src.parent);
      if (Array.isArray(node.children)) node.children = [];   // дети встают в родителя своими операциями
      if (i === 0) { delete node.pos; delete node.override; }
      if (node.type === 'instance' && c.ofMap.has(node.of)) node.of = c.ofMap.get(node.of);
      if (node.component && typeof node.component === 'object') {
        const comp = {
          ...node.component,
          ...(Array.isArray(node.component.props)
            ? { props: node.component.props.map((p) => (p && typeof p === 'object' && m.has(p.target) ? { ...p, target: m.get(p.target) } : p)) }
            : {}),
        };
        // цели пропсов — узлы внутри мастера: их ещё нет, поэтому `component` ставится последним
        if (i === 0) { component = comp; delete node.component; } else node.component = comp;
      }
      return mkOp(engine, 'create', { node });
    });
    if (component) ops.push(mkOp(engine, 'set', { id: m.get(c.rootId), path: 'component', value: component }));
    return {
      rootId: m.get(c.rootId), name: c.name, source: c.source, ops,
      ids: new Set(c.order.map((id) => m.get(id))),
      deps: new Set([...(c.deps || [])].map((id) => m.get(id))),
    };
  });

  let res;
  try { res = engine.applyOps(doc, [...libOps, ...masters.flatMap((x) => x.ops)]); } catch { res = null; }
  if (!res || res.error || !res.doc) return null;
  return { doc: res.doc, libId, libOps, masters };
}

/** Все id, на которые ссылается операция (узел, родитель, сосед, мастер, цели пропсов). */
function opRefs(op) {
  const out = [];
  if (!op || typeof op !== 'object') return out;
  for (const k of ['id', 'parent', 'after']) if (typeof op[k] === 'string') out.push(op[k]);
  const n = op.node;
  if (n && typeof n === 'object') {
    for (const k of ['id', 'parent', 'of']) if (typeof n[k] === 'string') out.push(n[k]);
    if (n.component && Array.isArray(n.component.props)) for (const p of n.component.props) if (p && typeof p.target === 'string') out.push(p.target);
  }
  if (op.op === 'set' && op.path === 'of' && typeof op.value === 'string') out.push(op.value);
  if (op.op === 'set' && op.path === 'component' && op.value && Array.isArray(op.value.props)) {
    for (const p of op.value.props) if (p && typeof p.target === 'string') out.push(p.target);
  }
  return out;
}

/**
 * Операции, построенные над «документом плюс», → операции над настоящим документом:
 * спереди — перенос тех внешних мастеров, на которые правка ссылается (и тех, что в них
 * вложены), и, если надо, создание страницы библиотеки. Неиспользованные не переносятся.
 * @returns {{ops: object[], added: Array<{name, source}>}}
 */
function materializeExternal(plan, ops) {
  const refs = new Set(ops.flatMap(opRefs));
  const byRoot = new Map(plan.masters.map((m) => [m.rootId, m]));
  const used = new Set();
  const stack = plan.masters.filter((m) => [...m.ids].some((id) => refs.has(id))).map((m) => m.rootId);
  while (stack.length) {
    const id = stack.pop();
    if (used.has(id)) continue;
    used.add(id);
    for (const d of (byRoot.get(id) || { deps: [] }).deps) stack.push(d);
  }
  const take = plan.masters.filter((m) => used.has(m.rootId));
  const needLib = plan.libOps.length && (take.length || refs.has(plan.libId));
  return {
    ops: [...(needLib ? plan.libOps : []), ...take.flatMap((m) => m.ops), ...ops],
    added: take.map((m) => ({ name: m.name, source: m.source })),
  };
}

/** Превью над настоящим документом (геометрия — заново: «плюс» рисовал лишние мастера). */
function previewOf(engine, doc) {
  let geo = null;
  try { geo = typeof engine.solve === 'function' ? engine.solve(doc) : null; } catch { geo = null; }
  return { doc, geo };
}

/**
 * Результат прогона над «документом плюс» → результат над настоящим документом. Операции —
 * с переносом использованных мастеров; превью — настоящий документ после них. Если перенос
 * не лёг (так не бывает, но движок строгий) — пробуем перенести все мастера; не легло и
 * так — ошибка, а не тихо битая правка.
 */
function finishExternal(res, doc, plan, engine) {
  if (!res || typeof res !== 'object') return res;
  const ops = Array.isArray(res.ops) ? res.ops : [];
  if (!ops.length) {
    return res.preview ? { ...res, preview: previewOf(engine, doc) } : res;
  }
  let out = materializeExternal(plan, ops);
  let applied = engine.applyOps(doc, out.ops);
  if (applied.error) {
    out = { ops: [...plan.libOps, ...plan.masters.flatMap((m) => m.ops), ...ops], added: plan.masters.map((m) => ({ name: m.name, source: m.source })) };
    applied = engine.applyOps(doc, out.ops);
  }
  if (applied.error) {
    const why = applied.error.message || String(applied.error);
    return {
      ...res, ops: [], preview: previewOf(engine, doc),
      error: { kind: 'model', message: `Не удалось перенести компоненты внешней библиотеки в документ: ${why}` },
    };
  }
  return {
    ...res,
    ops: out.ops,
    preview: res.preview ? previewOf(engine, applied.doc) : res.preview,
    ...(out.added.length ? { libraryAdded: out.added } : {}),
  };
}

/**
 * Прогон с внешним словарём: «документ плюс» → прогон → перенос использованного. Без
 * словаря (или если из него нечего взять) — обычный прогон, без единой лишней операции.
 */
async function withExternalLibrary(options, run, finish) {
  if (!hasExternalLibrary(options.library)) return run({ ...options, library: null });
  let engine;
  try { engine = await useEngine(options.engine); } catch { return run({ ...options, library: null }); }
  let plan = null;
  try { plan = externalLibraryPlan(options.doc, options.library, engine); } catch { plan = null; }
  if (!plan) return run({ ...options, library: null });
  // геометрия «плюса» другая (страница библиотеки) — пусть конвейер посчитает её сам
  const res = await run({ ...options, doc: plan.doc, geo: null, engine, library: null });
  return finish(res, options.doc, plan, engine);
}

/**
 * Одна команда пользователя (SPEC §1.6). Новое в круге 24: `library` — внешний словарь
 * компонентов (DUIL, §10.6): `[{doc, name?, id?}]`, документы-библиотеки (или их выжимки
 * `libraryDocOf`). Он дополняет библиотеку документа (имена документа главнее); мастер,
 * на который правка сослалась, переносится в библиотеку документа теми же операциями
 * (`libraryAdded: [{name, source}]` — что перенесено).
 */
export async function runCommand(options = {}) {
  // круг 25: строки результата — пригодные к записи (см. cleanResult)
  return cleanResult(await withExternalLibrary(options, runCommandCore, finishExternal));
}

/** Варианты (SPEC §1.6) — с тем же внешним словарём, что runCommand: перенос — у каждого свой. */
export async function runVariants(options = {}) {
  const list = await withExternalLibrary(options, runVariantsCore, (got, doc, plan, engine) => asArray(got).map((v) => {
    const fixed = finishExternal(v, doc, plan, engine);
    if (fixed !== v && fixed.preview && fixed.preview.doc) {
      fixed.fingerprint = shortHash(visibleFingerprint(fixed.preview.doc));
    }
    return fixed;
  }));
  return Array.isArray(list) ? list.map(cleanResult) : list;
}

/**
 * Одна команда пользователя: classify → plan → generate → materialize → validate →
 * (repair ≤ 1) → done. Входной doc не мутируется. Вход — runCommand (внешний словарь — там).
 */
async function runCommandCore(options = {}) {
  const {
    doc, selection, utterance, provider, onStage, signal,
    engine: engineOpt, persona = null, plan: presetPlan = null, modelTier,
    // новое в контракте: активная доска, память о разговоре, готовая геометрия, вариант
    activeArtboardId = null, history = null, geo: geoIn = null,
    // круг 9, п.5: кто выделил — человек или сам агент (оболочка выделяет задетое после правки)
    selectionBy = 'human',
    variantHint = '', temperature, callTimeout = CALL_TIMEOUT_MS, stagePrefix = '', stageExtra = null,
    // круг 7: внутри runVariants локальное распознавание «покажи варианты» выключено —
    // иначе прогон варианта снова вернул бы action:'variants' и модель не звалась бы ни разу
    insideVariants = false,
    /**
     * Круг 13, п.8: остановиться сразу после плана и вернуть его. Нужно runVariants: план
     * считается ОДИН раз на все варианты (а не по разу на каждый), и здесь же сразу видно,
     * что дальше вариантов вообще не нужно — переспрос, отказ или откат.
     */
    planOnly = false,
    /** Сколько вариантов пойдёт по этому плану: планировщику полезно знать (см. planner). */
    variantsAhead = 0,
  } = options;

  const stages = [];
  const warnings = [];
  /**
   * Круг 15, п.5: служебная бухгалтерия («первый ответ пришлось чинить», «починка не помогла»)
   * жила в warnings — то есть в ленте предупреждений ЧЕЛОВЕКА, где ей делать нечего: она не о
   * макете и не о команде, а о внутренней работе агента. Оболочка отфильтровывала её строку по
   * регулярке; теперь это отдельное поле serviceNotes, и фильтровать ничего не нужно.
   */
  const service = [];
  const usage = { calls: 0, ms: 0, promptChars: 0, completionChars: 0, promptTokens: 0, completionTokens: 0 };
  let engine = engineOpt || null;
  let plan = presetPlan;
  let answer;

  const warn = (m) => { if (m && !warnings.includes(m)) warnings.push(m); };
  const serviceNote = (m) => { if (m && !service.includes(m)) service.push(m); };
  /**
   * Стадия для интерфейса. Раньше extra.detail перетирал второй аргумент, и заголовок плана
   * терялся (п.14). Теперь label — заголовок (с номером варианта, если он есть), detail — подробность,
   * и ни то, ни другое из extra не затирается.
   */
  /**
   * Круг 3, п.8: поток модели НЕ копится в stages. Замер: ответ в 2820 знаков, отдаваемый по
   * одному символу, давал 2926 записей и 3.98 МБ строк (+3.3 МБ кучи за одну команду), а на
   * ответе в 20 КБ это ~50 МБ — при трёх вариантах втрое больше. В ленту интерфейса отдаём
   * (не чаще, чем раз в 80 мс), в историю стадий — нет.
   */
  let lastPartialAt = 0;
  const emitPartial = (stage, detail, text) => {
    if (typeof onStage !== 'function') return;
    const t = Date.now();
    if (t - lastPartialAt < 80) return;
    lastPartialAt = t;
    const base = STAGE_LABELS[stage] || stage;
    try {
      onStage({
        ...(stageExtra || {}),
        stage,
        label: stagePrefix ? `${stagePrefix}${base}` : base,
        text: base,
        ...(detail ? { detail: String(detail) } : {}),
        partial: text,
      });
    } catch { /* интерфейс не должен ронять конвейер */ }
  };

  const emit = (stage, detail, extra = {}) => {
    const base = STAGE_LABELS[stage] || stage;
    const title = extra.title ? `${base}: ${extra.title}` : base;
    const rec = {
      ...extra,
      ...(stageExtra || {}),
      stage,
      label: stagePrefix ? `${stagePrefix}${title}` : title,
      text: title,
      ...(detail ? { detail: String(detail) } : {}),
    };
    stages.push({ ...rec, at: Date.now() });
    if (typeof onStage === 'function') { try { onStage(rec); } catch { /* интерфейс не должен ронять конвейер */ } }
  };

  const fail = (e) => {
    const error = toErrorInfo(e);
    emit('error', error.message);
    let preview = null;
    if (engine && doc) preview = { doc, geo: geoIn || safeSolve(engine, doc) };
    /* Круг 11, п.9: прогон не состоялся — никакого «оставил первый вариант» не осталось.
     * В интерфейсе это отфильтровано, но в ответе API шумело и сбивало с толку.
     * Круг 15, п.5: служебные строки теперь и не попадают в warnings — фильтр остаётся
     * страховкой на случай предупреждения, пришедшего снаружи (например, из плана варианта). */
    const clean = warnings.filter((w) => !/^Починка (не помогла|не удалась)|^Первый ответ модели/.test(String(w)));
    return {
      ops: [], error, preview, plan, answer, warnings: sortWarnings(clean), usage, stages,
      ...(service.length ? { serviceNotes: service.slice() } : {}),
    };
  };

  try {
    if (!doc || !doc.nodes) throw ERR('model', 'Документ не передан');
    engine = await useEngine(engineOpt);
    checkAbort(signal);

    /* — 0. Нечего разбирать: переспрос, а не ошибка (круг 2, п.3) —
     * Команда приходит голосом, и распознавание регулярно отдаёт «», пробелы, «...» или
     * щелчок микрофона. Раньше это был красный «Пустая команда»; правильно — вежливо переспросить.
     * Реплики со словами («ммм», «ну это самое») по-прежнему идут в планировщик: он формулирует
     * переспрос точнее, чем общая заготовка. */
    if (!hasWords(utterance)) {
      const question = String(utterance == null ? '' : utterance).trim()
        ? 'Не разобрал команду — в ней нет ни одного слова. Что поменять: например «сделай заголовок крупнее»?'
        : 'Не услышал команду. Скажите, что поменять: например «сделай заголовок крупнее».';
      const startOpts = starterOptions(engine, doc, activeArtboardId);
      emit('classify', 'clarify — в реплике нет ни одного слова');
      emit('clarify', question, { options: startOpts });
      emit('done', 'Жду уточнения');
      return {
        ops: [], preview: { doc, geo: geoIn || safeSolve(engine, doc) }, plan,
        clarify: question, clarifyOptions: startOpts,
        warnings: sortWarnings(warnings), usage, stages,
      };
    }
    /* — 0a. Отмена и возврат: это делает оболочка, модель тут не нужна (новое в контракте) —
     * Голосом «отмени», «верни как было», «назад», «не так» обязаны откатывать последнюю
     * транзакцию мгновенно. Раньше такая реплика улетала в планировщик, и модель начинала
     * угадывать, что же «вернуть», — правила наугад. Распознаём ДО обращения к модели. */
    const action = recognizeAction(utterance);
    if (action) {
      const title = action === 'undo' ? 'Отменяю последнюю правку' : 'Возвращаю отменённую правку';
      const actionPlan = {
        intent: action,
        title,
        summary: action === 'undo'
          ? 'Откат делает редактор: модель для этого не нужна.'
          : 'Возврат делает редактор: модель для этого не нужна.',
        steps: [title],
        targets: [],
      };
      emit('classify', `${action} — распознано локально, без модели`);
      emit('done', actionPlan.summary, { title });
      return {
        ops: [], action, plan: actionPlan,
        preview: { doc, geo: geoIn || safeSolve(engine, doc) },
        warnings: sortWarnings(warnings), usage, stages,
      };
    }

    /* — 0a'. Двусмысленная отмена: переспрашиваем, а не угадываем (круг 11, п.6) —
     * «Убери последнее» — это и «отмени последнюю правку», и «удали последний элемент».
     * Модель из этих двух толкований может выбрать только второе (отката у неё нет), так что
     * отправлять реплику дальше — значит гарантированно угадать. Спрашиваем. */
    const doubt = recognizeUndoDoubt(utterance);
    if (doubt) {
      const doubtOpts = undoDoubtOptions(engine, doc, activeArtboardId);
      emit('classify', 'clarify — «убрать последнее» значит и откат, и удаление');
      emit('clarify', doubt, { options: doubtOpts });
      emit('done', 'Жду уточнения');
      return {
        ops: [], preview: { doc, geo: geoIn || safeSolve(engine, doc) }, plan,
        clarify: doubt, clarifyOptions: doubtOpts,
        warnings: sortWarnings(warnings), usage, stages,
      };
    }

    /* — 0b. Варианты: тоже действие оболочки (круг 5, п.3) —
     * «Покажи три варианта», «а если иначе», «по-другому» уходили в модель обычной командой и
     * возвращались переспросом: единственный творческий инструмент приложения был недоступен
     * человеку, который наблюдает за макетом и отдаёт команды голосом. Распознаём локально и
     * отдаём оболочке новым полем action:'variants' — она сама зовёт runVariants. */
    const wantVariants = insideVariants ? null : recognizeVariants(utterance, { doc });
    if (wantVariants) {
      const of = wantVariants.variantsOf;
      const title = of ? cutText(`Показываю варианты: ${of}`, 120) : 'Показываю варианты';
      const variantsPlan = {
        intent: 'variants',
        title,
        summary: of
          ? `Считаю варианты для команды «${of}» — это делает редактор отдельным прогоном.`
          : 'Считаю варианты для предыдущей команды — это делает редактор отдельным прогоном.',
        steps: [title],
        targets: [],
      };
      emit('classify', `variants — распознано локально, без модели${of ? `: «${of}»` : ' (к предыдущей команде)'}`);
      emit('done', variantsPlan.summary, { title });
      return {
        ops: [], action: 'variants', variantsOf: of,
        // круг 7, п.10: «два варианта шапки» — предмет назван словами, оболочка может его показать
        ...(wantVariants.subject ? { variantsSubject: wantVariants.subject } : {}),
        plan: variantsPlan,
        preview: { doc, geo: geoIn || safeSolve(engine, doc) },
        warnings: sortWarnings(warnings), usage, stages,
      };
    }

    /* — 0c. Компоненты словами: сделать компонент, переназвать его, отсоединить экземпляр
     * (круг 19, п.4-5) — тоже дело оболочки и ядра, модель тут не нужна ни для чего: что делать,
     * сказано в самой фразе, а с чем — показано выделением. Стоит 0 вызовов вместо 2.
     * Стоит ДО проверки провайдера сознательно: эти команды должны работать и без модели. */
    const wantComponent = insideVariants ? null : recognizeComponentIntent(utterance);
    if (wantComponent) {
      const localScope = resolveScope(doc, selection, engine, { activeArtboardId, selectionBy });
      const got = componentIntent({
        engine, doc, scope: localScope, utterance, ask: wantComponent,
        geo: geoIn || safeSolve(engine, doc), emit,
      });
      // null — формулировка мягкая и могла значить другое: пусть решает модель
      if (got) {
        for (const w of got.warnings || []) warn(w);
        const { warnings: _drop, ...rest } = got;
        return { ...rest, warnings: sortWarnings(warnings), usage, stages };
      }
    }

    /* — 0d. «Убери анимации» (круг 36, SPEC §11) — тоже без модели: что делать, сказано во фразе,
     * а где — выделением, активной доской или словом «везде». Снимаются states и motion целиком. */
    const wantMotionClear = insideVariants ? null : recognizeMotionClear(utterance);
    if (wantMotionClear) {
      const localScope = resolveScope(doc, selection, engine, { activeArtboardId, selectionBy });
      const got = motionClearIntent({
        engine, doc, scope: localScope, where: wantMotionClear.where, utterance,
        geo: geoIn || safeSolve(engine, doc), emit,
      });
      for (const w of got.warnings || []) warn(w);
      const { warnings: _drop, ...rest } = got;
      return { ...rest, warnings: sortWarnings(warnings), usage, stages };
    }

    if (!provider || typeof provider.complete !== 'function') throw ERR('model', 'Провайдер модели не настроен');

    const ask = async (schemaEntry, messages, o = {}) => {
      checkAbort(signal);
      const t0 = now();
      usage.calls++;
      try {
        const call = provider.complete(messages, schemaEntry, {
          signal,
          modelTier: o.modelTier || modelTier || 'default',
          temperature: o.temperature === undefined ? temperature : o.temperature,
          maxTokens: o.maxTokens,
          timeout: callTimeout,
          onText: o.stage ? (text) => emitPartial(o.stage, o.detail, text) : undefined,
          onRetry: (info) => emit('retry', (info && info.text) || 'Повторяю запрос к модели', { title: (info && info.text) || '' }),
          onUsage: (u) => {
            usage.promptChars += u.promptChars || 0;
            usage.completionChars += u.completionChars || 0;
            usage.promptTokens += u.promptTokens || 0;
            usage.completionTokens += u.completionTokens || 0;
          },
        });
        // Провайдер может не слушать signal: гоним его промис с отменой и общим дедлайном (п.15).
        const data = await raceAbort(call, signal, callTimeout, `Модель не ответила за ${fmtDuration(callTimeout)}`);
        usage.ms += now() - t0;
        if (!data || typeof data !== 'object') throw ERR('schema', 'Модель вернула не объект');
        return data;
      } catch (e) {
        usage.ms += now() - t0;
        throw e instanceof BrainError ? e : fromClaudeError(e);
      }
    };

    /* — 1. Классификация — */
    /* Круг 27: выделение, которое поставил сам агент (оболочка выделяет созданное), для
     * «собери экран …» — не место работы: второй экран иначе ложился внутрь первого. */
    const agentSelIgnored = selectionBy === 'agent' && asArray(selection).length > 0 && asksNewScreen(utterance);
    const scope = resolveScope(doc, agentSelIgnored ? [] : selection, engine, { activeArtboardId, selectionBy });
    const hasSelection = scope.kind === 'selection';
    // круг 9, п.6: узлы области работы выигрывают у одноимённых с чужого артборда
    const guess = classifyUtterance(utterance, { hasSelection, doc, prefer: new Set(collectSubtree(doc, scope.ids)) });
    const geoNow = geoIn || safeSolve(engine, doc);
    // валидатор зовётся ОДИН раз: из него и замечания для промпта (круг 3, п.5),
    // и множество «это было до нас» — чтобы старые нарушения не вменялись агенту
    const baseList = safeValidate(engine, doc, geoNow);
    const checks = describeViolations(baseList, doc);
    const group = looksGroupWide(utterance);       // «во всех карточках…» (круг 3, п.4)
    emit('classify', `${guess.intent} — ${guess.reason}`);
    checkAbort(signal);

    const ctxBase = { doc, scope, engine, guess, persona, geo: geoNow, history, variantHint, checks, variantsAhead };

    /* — 2. План — */
    let intent = guess.intent;
    if (!plan) {
      const ctx = buildContext({ ...ctxBase, intent: guess.intent });
      plan = await ask(SCHEMAS.plan, [
        { role: 'system', content: PROMPTS.planner(ctx) },
        { role: 'user', content: String(utterance) },
      ], { stage: 'plan', modelTier: 'quick', temperature: variantHint ? (temperature == null ? 0.4 : temperature) : 0 });
      plan = normalizePlan(plan, guess);
    }
    intent = arbitrateIntent(plan, guess, warn);
    /* Круг 36 (SPEC §11.4): отказ «в редакторе нет анимаций» снят. Модель (особенно локальная,
     * обученная на старых ответах) ещё может его выдать на «оживи кнопки» — тогда это не ответ,
     * а устаревшее знание: состояния и движение в документе есть. Ведём как правку. */
    if (intent === 'refuse' && looksMicroAnimation(utterance) && staleMotionRefusal(plan && (plan.cannot || plan.summary))) {
      serviceNote('Модель отказала в микроанимации по старой памяти — веду как правку состояний');
      intent = 'edit';
      if (plan) { delete plan.cannot; plan.title = plan.title || 'Микроанимации'; }
    }
    if (plan) plan.intent = intent;
    // Круг 11: шаги плана уходят и в стадию — оболочка показывает их живьём, пока агент работает
    emit('plan', plan ? plan.summary : '', {
      title: plan ? plan.title : intent,
      steps: (plan && Array.isArray(plan.steps) ? plan.steps : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6),
      plan: plan || null,
    });
    checkAbort(signal);

    /* — 2'. Круг 13, п.8: план готов, и это всё, о чём просили (общий план вариантов) — */
    if (planOnly) {
      const question = intent === 'clarify' ? clarifyQuestion(plan) : null;
      const because = intent === 'refuse' ? cannotText(plan && plan.cannot) : null;
      const qOpts = question ? clarifyChoices(plan, engine, doc, activeArtboardId) : [];
      if (question) emit('clarify', question, { options: qOpts });
      if (because) emit('cannot', because);
      return {
        ops: [], planOnly: true, intent, plan, preview: { doc, geo: geoNow },
        ...(question ? { clarify: question } : {}),
        ...(qOpts.length ? { clarifyOptions: qOpts } : {}),
        ...(because ? { cannot: because } : {}),
        warnings: sortWarnings(warnings), usage, stages,
      };
    }

    /* — 2a. Не понял (п.11): переспрашиваем, ничего не трогая — */
    if (intent === 'clarify') {
      const question = clarifyQuestion(plan);
      const choices = clarifyChoices(plan, engine, doc, activeArtboardId);
      emit('clarify', question, { options: choices });
      emit('done', 'Жду уточнения');
      return {
        ops: [], preview: { doc, geo: geoNow }, plan,
        clarify: question, ...(choices.length ? { clarifyOptions: choices } : {}),
        warnings: sortWarnings(warnings), usage, stages,
      };
    }

    /* — 2b. Нельзя (круг 9, п.4): просьба понятна, но в модели документа её не выразить —
     * «поверни аватар на 15 градусов» раньше кончалось красным блоком «Модель не вернула ни
     * одной правки» и кнопкой «Повторить», которая снова не срабатывала, — и ни в одном из
     * сообщений не было главного: поворота в этом редакторе нет, просить бесполезно. */
    if (intent === 'refuse') {
      const because = cannotText(plan && plan.cannot);
      emit('cannot', because);
      emit('done', 'Так нельзя');
      return { ops: [], preview: { doc, geo: geoNow }, plan, cannot: because, warnings: sortWarnings(warnings), usage, stages };
    }

    /* — 3-5. Генерация → материализация → проверка (с одной попыткой починки) — */
    if (intent === 'ask') {
      const ctx = buildContext({ ...ctxBase, intent });
      emit('generate', 'Отвечаю на вопрос');
      const data = await ask(SCHEMAS.answer, [
        { role: 'system', content: PROMPTS.answer(ctx) },
        { role: 'user', content: String(utterance) },
      ], { stage: 'generate', modelTier: 'quick' });
      answer = String(data.answer || '').trim() || 'Не удалось ответить по этому макету.';
      const followups = Array.isArray(data.followups)
        ? data.followups.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 3)
        : [];
      emit('validate', 'Ответ не меняет документ');
      emit('done', 'Готово');
      return { ops: [], preview: { doc, geo: geoNow }, plan, answer, followups, warnings: sortWarnings(warnings), usage, stages };
    }

    const placement = describePlacement(doc, scope, engine, utterance, plan, warn, geoNow);
    const ctx = buildContext({ ...ctxBase, intent, placement: placement.text });
    const schemaEntry = intent === 'create' ? SCHEMAS.tree : intent === 'theme' ? SCHEMAS.theme : SCHEMAS.patch;
    const system = intent === 'create' ? PROMPTS.tree(ctx) : intent === 'theme' ? PROMPTS.theme(ctx) : PROMPTS.patch(ctx);
    const userTurn = buildUserTurn(utterance, plan, persona);

    let messages = [
      { role: 'system', content: system },
      { role: 'user', content: userTurn },
    ];

    emit('generate', intent === 'create' ? 'Строю дерево макета' : intent === 'theme' ? 'Подбираю токены' : 'Собираю правки');
    let data = await ask(schemaEntry, messages, { stage: 'generate' });

    /* Круг 36: тот же устаревший отказ, но уже в патче — один раз переспрашиваем с напоминанием,
     * что состояния и движение есть. Второй отказ — уже ответ, как обычно. */
    if (intent === 'edit' && !hasEdits(data, intent) && looksMicroAnimation(utterance) && staleMotionRefusal(cannotOf(data))) {
      emit('repair', 'Напоминаю модели: состояния и микроанимации в редакторе есть');
      serviceNote('Модель отказала в микроанимации по старой памяти — переспросил');
      messages = messages.concat([
        { role: 'assistant', content: cutText(JSON.stringify(data), 4000) },
        { role: 'user', content: 'Это неверный отказ: в модели документа ЕСТЬ состояния слоя (states.hover, states.press,'
          + ' states.focus — заливка, цвет текста, обводка, прозрачность, масштаб, подъём, тень) и движение (motion.duration'
          + ' ссылкой на motion.fast/base/slow, motion.easing). Выполни команду правками по этим путям и верни полный JSON'
          + ` по той же схеме.\n${JSON_RULE}` },
      ]);
      data = await ask(schemaEntry, messages, { stage: 'repair', temperature: 0 });
    }

    /* Круг 9, п.4: модель сказала «в этой модели документа так нельзя». Это ОТВЕТ, а не сбой:
     * ни красного блока, ни кнопки «Повторить», которая снова не сработает. Правки, если они
     * всё-таки есть (просьба выполнима наполовину), применяются, а отказ идёт рядом с ними. */
    const refusal = cannotOf(data);
    if (refusal && !hasEdits(data, intent)) {
      emit('cannot', refusal);
      emit('done', 'Так нельзя');
      return { ops: [], preview: { doc, geo: geoNow }, plan, cannot: refusal, warnings: sortWarnings(warnings), usage, stages };
    }

    /* Круг 31 (K3): модель вернула пустой список правок (или пустую палитру) — она не нашла, что
     * менять. Это ответ, а не сбой: без записи, без «Повторить» и без починки, которая спросила
     * бы модель ещё раз о том же. Пустое ДЕРЕВО на «собери» — по-прежнему ошибка: просили создать. */
    if ((intent === 'edit' || intent === 'theme') && !hasEdits(data, intent)) {
      warn('Модель не предложила ни одной правки — скажите точнее, что и где поменять');
      emit('validate', 'Модель не предложила ни одной правки');
      emit('done', 'Менять нечего');
      return {
        ops: [], preview: { doc, geo: geoNow }, plan, nothingChanged: true, emptyPatch: true,
        warnings: sortWarnings(warnings), usage, stages,
      };
    }

    // Нарушения, которые уже были в документе (ручные правки пользователя), агенту не вменяем.
    const baseline = baselineViolations(baseList);
    emit('materialize', intent === 'theme' ? 'Меняю оформление документа' : intent === 'create' ? 'Ставлю новые слои на место' : 'Нахожу слои, которые надо поменять');
    let attempt = materialize({ engine, doc, data, intent, scope, placement, persona, baseline, geo: geoNow, group, said: utterance });
    let repaired = false;
    let keptFirst = false;                         // круг 11, п.9: починка не помогла, но прогон выжил
    // круг 16, п.8: все попытки уткнулись в цели, которых в документе нет — повторять нечего
    let retryPointless = !!(attempt.fatal && attempt.fatal.retryable === false);

    /* Круг 15, п.5: нарушение — прямое следствие просьбы человека, и чинить тут нечего. */
    const asked = !attempt.fatal && !attempt.nothingChanged
      && askedForViolations(utterance, attempt.violations.filter(isBlocking), attempt.ops, doc);
    if (asked) emit('validate', 'Замечание — следствие того, о чём просили: чинить нечего');

    if (!asked && (attempt.fatal || attempt.blocking.length)) {
      const problems = attempt.blocking.length ? attempt.blocking : attempt.problems;
      /**
       * Круг 13, п.4: в стадию отдаём ТОЛЬКО человеческие замечания. В blocking сознательно
       * лежит текст, написанный для МОДЕЛИ («Выбери другие цели (по id из выжимки) или другие
       * поля»), и он уходил прямо в ленту: на стадии «Чиню» человек читал команду, адресованную
       * не ему. problems — те же нарушения словами для человека; когда их нет (правка легла
       * «в пустоту», нарушений ноль), берём человеческую заготовку.
       */
      const forHuman = attempt.problems.length ? attempt.problems
        : [attempt.nothingChanged
          ? 'Правка ничего не изменила в макете — прошу модель поправить цели'
          : 'Ответ модели применить не удалось — прошу поправить'];
      emit('repair', forHuman[0], { detail: forHuman.slice(0, 5).join('; ') });
      checkAbort(signal);
      messages = messages.concat([
        { role: 'assistant', content: cutText(JSON.stringify(data), 8000) },
        { role: 'user', content: PROMPTS.repair(problems.slice(0, 8), data, schemaEntry) },
      ]);
      try {
        const fixed = await ask(schemaEntry, messages, { stage: 'repair', temperature: 0 });
        /* Круг 9, п.4: починка — законное место для отказа. «Поверни аватар» первым ответом даёт
         * выдуманное поле rotation, все правки отклоняются; вторая попытка обязана иметь право
         * сказать «поворота у узлов нет», а не выдумывать второе такое же поле. */
        const late = cannotOf(fixed);
        if (late && !hasEdits(fixed, intent)) {
          emit('cannot', late);
          emit('done', 'Так нельзя');
          return { ops: [], preview: { doc, geo: geoNow }, plan, cannot: late, warnings: sortWarnings(warnings), usage, stages };
        }
        emit('materialize', 'Прикладываю исправленный ответ');
        const second = materialize({ engine, doc, data: fixed, intent, scope, placement, persona, baseline, geo: geoNow, group, said: utterance });
        repaired = true;
        retryPointless = retryPointless && !!(second.fatal && second.fatal.retryable === false);
        if (betterAttempt(second, attempt)) {
          data = fixed;
          attempt = second;
        } else {
          /* Круг 11, п.9: сказать это можно только если первый вариант и правда остался в деле.
           * Раньше предупреждение ставилось здесь же, и когда вторая попытка тоже не собиралась,
           * прогон падал с ошибкой — а в warnings при ошибке лежало бодрое «оставил первый
           * вариант», которого никакого не осталось. Откладываем до того, как станет ясно. */
          keptFirst = true;
        }
      } catch (e) {
        if (e instanceof BrainError && e.kind === 'cancelled') throw e;
        // круг 16, п.6: в служебной записи — только факт, без совета человеку
        serviceNote(`Починка не удалась: ${factOnly(e && e.message ? e.message : e)}`);
      }
    }

    // круг 29: экран собран новой доской — «собираю внутри выделенного» стало неправдой
    if (attempt.movedToBoard && placement.insideNote) {
      const i = warnings.indexOf(placement.insideNote);
      if (i >= 0) warnings.splice(i, 1);
    }
    for (const w of attempt.warnings) warn(w);
    /**
     * Круг 16, п.8: «повторять нечего» вправе сказать только прогон, у которого ВСЕ попытки
     * уткнулись в отсутствующие цели. Если починка упала по другой причине, повтор может и
     * помочь — тогда признак снимаем, и оболочка предложит «Повторить», как раньше.
     */
    if (attempt.fatal && attempt.fatal.retryable === false && !retryPointless) attempt.fatal.retryable = undefined;
    if (attempt.fatal) throw attempt.fatal;
    if (keptFirst) serviceNote('Починка не помогла — оставил первый вариант');

    /**
     * Круг 16, п.3: последняя черта. Арифметику мы уже применили (materialize), модель уже
     * получила свой круг починки — и если после всего этого текст сливается с фоном в ЧЕТВЕРТИ
     * документа и больше, это не «замечание валидатора», а негодная палитра: документ, который
     * нельзя прочесть, хуже, чем документ без тёмной темы. Такое оформление НЕ применяем.
     *
     * Порог взят по замерам на демо-документе (49 текстовых слоёв): негодные палитры дают
     * 35–100% нечитаемого текста (белое по белому — 35%, текст = фон — 45%, все цвета
     * одинаковые — 100%), а разумная тёмная с недокрашенной плашкой — 8%. Четверть отделяет
     * одно от другого с запасом в обе стороны, и пара плохо читаемых подписей темы не отменяет.
     */
    if (intent === 'theme' && !attempt.fatal) {
      const unreadable = asArray(attempt.violations).filter((v) => v && v.code === 'low-contrast').length;
      const texts = Object.keys(doc.nodes || {}).filter((id) => {
        const n = doc.nodes[id];
        return n && n.type === 'text' && String(n.characters == null ? '' : n.characters).trim();
      }).length;
      if (texts && unreadable / texts >= UNREADABLE_SHARE) {
        const because = `Палитра, которую подобрала модель, нечитаема: текст сливается с фоном`
          + ` в ${unreadable} слоях из ${texts}. Я подобрал читаемые цвета сам и попросил модель`
          + ' исправиться — не помогло, поэтому оформление НЕ применил: документ остался прежним.'
          + ' Назовите цвета сами («фон #101418, текст #e8eaf0») или попросите другую тему.';
        emit('cannot', because);
        emit('done', 'Палитру не применил');
        return {
          ops: [], preview: { doc, geo: geoNow }, plan, cannot: because,
          warnings: sortWarnings(warnings), usage, stages,
          ...(service.length ? { serviceNotes: service.slice() } : {}),
        };
      }
    }

    emit('validate', attempt.nothingChanged ? 'Правка ничего не изменила'
      : attempt.problems.length ? `Осталось замечаний: ${attempt.problems.length}` : 'Нарушений нет');
    for (const p of attempt.problems.slice(0, MAX_VALIDATOR_WARNINGS)) warn(`Проверка макета: ${p}`);
    if (attempt.problems.length > MAX_VALIDATOR_WARNINGS) {
      warn(`Проверка макета: и ещё ${attempt.problems.length - MAX_VALIDATOR_WARNINGS} замечани(е/й) того же рода`);
    }
    if (repaired && !attempt.blocking.length) serviceNote('Первый ответ модели пришлось чинить');

    /* Круг 27: итог против просьбы («крупнее», а стало мельче; «новой доской», а легло внутрь)
     * — замечание, а не успех; и подпись записи — что сделано, а не пересказ модели. */
    const afterDoc = attempt.preview && attempt.preview.doc;
    if (!attempt.nothingChanged) {
      for (const w of checkOutcome({ doc, after: afterDoc, ops: attempt.ops, utterance, placement: attempt.placement || placement })) warn(w);
    }
    let changeSummary = '';
    try { changeSummary = describeChange(attempt.ops, doc, afterDoc, engine); } catch { changeSummary = ''; }

    emit('done', plan ? plan.summary : '', { title: plan ? plan.title : '' });
    return {
      ops: attempt.ops, preview: attempt.preview, plan, answer,
      ...(changeSummary ? { changeSummary } : {}),
      // круг 7, п.5: правки, которые на экране не видны, — отдельным полем, а не только словами
      ...(attempt.geometryUnchanged ? { geometryUnchanged: attempt.geometryUnchanged } : {}),
      /**
       * Круг 16, п.1: сам ФАКТ «на экране ничего не поменялось» теперь уезжает полем, а не
       * только вычисляется оболочкой по отпечатку документа. Отпечаток расходится, когда
       * значение то же, но в другой ФОРМЕ (style "display" против {token:"display"}), — и
       * оболочка принимала пустую правку за сделанную работу: главная строка утверждала
       * переход, а приписка рядом говорила обратное. Поле не зависит от того, приводит ли
       * ядро форму значения обратно к объектной.
       */
      ...(attempt.nothingChanged ? { nothingChanged: true } : {}),
      /* Круг 15, п.6: «менять нечего» отличается от «правка легла не туда»: все значения уже
       * такие, какие просили. Оболочке это нужно, чтобы не предлагать «Повторить» — повтор
       * заведомо даст тот же результат. */
      ...(attempt.nothingToChange ? { nothingToChange: true } : {}),
      // круг 9, п.4: часть просьбы выполнена, часть невыполнима — говорим и о том, и о другом
      ...(refusal ? { cannot: refusal } : {}),
      // круг 15, п.5: служебная бухгалтерия агента — отдельным полем, не в ленте человека
      ...(service.length ? { serviceNotes: service.slice() } : {}),
      warnings: sortWarnings(warnings), usage, stages,
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Круг 9, п.4: текст отказа для человека. Пустой или служебный отказ («cannot: "no"») — всё
 * равно отказ: подставляем осмысленную русскую фразу, иначе оболочке нечего показать.
 */
function cannotText(raw) {
  const s = cutText(String(raw == null ? '' : raw).trim().replace(/\s+/g, ' '), 400);
  if (s.length >= 12) return s;
  return 'Этого в редакторе нет: модель документа так не умеет. Скажите, что сделать вместо этого.';
}

/** Отказ из ответа модели (патч, дерево или тема) — или '' , если его нет. */
function cannotOf(data) {
  const raw = data && typeof data === 'object' ? data.cannot : null;
  const s = String(raw == null ? '' : raw).trim();
  return s ? cannotText(s) : '';
}

/** Есть ли в ответе хоть что-то выполнимое: отказ с правками — это «сделал наполовину». */
function hasEdits(data, intent) {
  if (!data || typeof data !== 'object') return false;
  if (intent === 'edit') return Array.isArray(data.edits) && data.edits.length > 0;
  if (intent === 'create') return typeof data.type === 'string' && data.type.trim() !== '';
  if (intent === 'theme') {
    return ['colors', 'type', 'spacing', 'radii'].some((k) => Array.isArray(data[k]) && data[k].length > 0);
  }
  return false;
}

/** Лучшая попытка: сначала без фатальной ошибки, затем с меньшим числом нарушений. */
function betterAttempt(next, prev) {
  if (next.fatal && !prev.fatal) return false;
  if (!next.fatal && prev.fatal) return true;
  if (next.blocking.length !== prev.blocking.length) return next.blocking.length < prev.blocking.length;
  return next.problems.length < prev.problems.length;
}

function normalizePlan(raw, guess) {
  const intents = ['create', 'edit', 'theme', 'ask', 'clarify', 'refuse'];
  const plan = {
    intent: intents.includes(String(raw && raw.intent)) ? String(raw.intent) : guess.intent,
    title: cutText(String((raw && raw.title) || '').trim(), 120) || 'Правка макета',
    summary: cutText(String((raw && raw.summary) || '').trim(), 400),
    steps: asArray(raw && raw.steps).map((s) => String(s).trim()).filter(Boolean).slice(0, 6),
    targets: asArray(raw && raw.targets).map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
  };
  const clarify = cutText(String((raw && raw.clarify) || '').trim(), 300);
  if (clarify) plan.clarify = clarify;
  /* Круг 18: три готовых ответа к переспросу. Чистим жёстко — человек их НАЖИМАЕТ, и то, что
     нажалось, уходит командой как есть: обрывок или вопрос вместо команды стоил бы ему прогона. */
  const opts = asArray(raw && raw.clarifyOptions)
    .map((o) => unwrapQuotes(String(o == null ? '' : o).trim()))
    .filter((o) => o && o.length <= 80 && !o.endsWith('?'));
  const seenOpt = new Set();
  const uniq = opts.filter((o) => {
    const k = o.toLowerCase();
    if (seenOpt.has(k)) return false;
    seenOpt.add(k); return true;
  }).slice(0, 3);
  if (uniq.length) plan.clarifyOptions = uniq;
  // круг 9, п.4: отказ несёт объяснение; модель иногда кладёт его в summary — принимаем и так
  const cannot = cutText(String((raw && raw.cannot) || '').trim(), 400);
  if (cannot) plan.cannot = cannot;
  else if (plan.intent === 'refuse') plan.cannot = plan.summary || plan.title;
  if (!plan.steps.length) plan.steps = [plan.summary || plan.title];
  return plan;
}

/**
 * Кто главный в споре «план модели против локального классификатора» (п.4).
 * По умолчанию — модель: она видела документ и выжимку, а классификатор знает только глаголы.
 * Локальный разбор перебивает план РОВНО в двух очевидных случаях:
 *   1) реплика прямо вопросительная («сколько карточек?») — менять макет по вопросу нельзя;
 *   2) реплика бессмысленная («ну это самое», «сделай») — вместо нового артборда переспрашиваем.
 * Раньше любая уверенность ≥0.8 перебивала план, и «добавь снизу панель» уезжало в отдельный артборд.
 */
function arbitrateIntent(plan, guess, warn) {
  const planned = plan && plan.intent ? plan.intent : null;
  if (!planned) return guess.intent;
  if (planned === guess.intent) return planned;

  /**
   * Круг 9, п.4: отказ локальный разбор не перебивает. «Поверни аватар на 15 градусов» —
   * для классификатора обычный глагол правки, и он всегда «уверен»; но выполнимость команды
   * решается по модели документа, а её видела только модель.
   */
  if (planned === 'refuse') return 'refuse';
  if (guess.intent === 'clarify' && guess.confidence >= 0.8 && planned !== 'ask') {
    warn(`Команда «${guess.reason}» — вместо «${planned}» переспрашиваю`);
    return 'clarify';
  }
  if (guess.intent === 'ask' && guess.confidence >= 0.9 && planned !== 'clarify') {
    warn(`Похоже на вопрос, а план предложил «${planned}» — отвечаю, ничего не меняя`);
    return 'ask';
  }
  return planned;                                  // во всём остальном слушаем модель
}

function buildUserTurn(utterance, plan, persona) {
  // Память о разговоре уже вставлена в шапку промпта (header → ПРЕДЫДУЩИЕ КОМАНДЫ),
  // здесь её не повторяем, чтобы не тратить бюджет дважды.
  const parts = [`Команда пользователя: ${String(utterance).trim()}`];
  if (plan) {
    parts.push('');
    parts.push(`План: ${plan.title}. ${plan.summary}`);
    if (plan.steps && plan.steps.length) parts.push('Шаги: ' + plan.steps.map((s, i) => `${i + 1}) ${s}`).join(' '));
    if (plan.targets && plan.targets.length) parts.push('Цели: ' + plan.targets.join(', '));
  }
  if (persona) parts.push(`Характер результата: ${persona.label} — ${persona.description}`);
  return parts.join('\n');
}

/**
 * Явная просьба о новом экране: «новый экран», «ещё один экран», «отдельный артборд».
 * Круг 27: и в косвенных падежах — «новой доской», «отдельной доской», «на новом экране»,
 * «ещё одним экраном», «на другом макете»: раньше узнавались только именительный и винительный,
 * и «собери экран тарифов новой доской» ложилось внутрь текущего экрана.
 */
const RE_NEW_ARTBOARD = rx('(нов(ый|ую|ое|ая|ой|ом|ым|ого|ому|ые|ых|ыми)|ещ[её]\\s+од(ин|ну|ной|ним|ном|ного|ному)'
  + '|отдельн(ый|ую|ое|ая|ой|ом|ым|ого|ому|ые|ых|ыми)|втор(ой|ую|ая|ом|ым|ого|ому)|друг(ой|ую|ая|ом|им|ого|ому))'
  + '\\s+(\\p{L}+\\s+)?(экран|артборд|доск|макет|страниц)');
/**
 * Круг 27: «здесь», «в этом экране», «внутри выделенного» — место названо как ТЕКУЩЕЕ: такая
 * команда к выделению и относится, кто бы его ни поставил.
 */
const RE_HERE_PLACE = rx('(здесь|сюда|тут|внутр\\p{L}*|(в|во|на)\\s+(эт(ом|ой|от|у|и)|текущ\\p{L}*|выделенн\\p{L}*|выбранн\\p{L}*))');

/**
 * Круг 27: просьба собрать НОВЫЙ экран («собери экран тарифов», «создай доску», «новый
 * экран»), к которой выделение, поставленное агентом, отношения не имеет. Оболочка после
 * правки выделяет созданный экран (selectionBy:'agent'), и второй «собери экран …» ложился
 * ВНУТРЬ первого: агент принимал своё же выделение за указание человека.
 */
export function asksNewScreen(utterance) {
  const s = String(utterance == null ? '' : utterance);
  if (!s.trim()) return false;
  if (RE_NEW_ARTBOARD.test(s)) return true;
  return RE_WHOLE_SCREEN.test(s) && !RE_HERE_PLACE.test(s);
}
const RE_ARTBOARD_WORD = rx('(артборд|доск[аиуеой])', true);
/** Просьба собрать экран целиком: «собери экран оформления», «свёрстай лендинг». */
const RE_WHOLE_SCREEN = rx('(собери|создай|создать|св[её]рстай|сверстай|построй|нарисуй|сгенерируй)\\s+(\\p{L}+\\s+){0,2}?(экран|лендинг|страниц|артборд|доск|макет)');

/* — «добавь X в Y»: контейнер, названный в самой команде (круг 3, п.3) — */

/** Глаголы добавления: без них про вставку речи нет. */
const RE_ADD_VERB = rx('(добав(ь|ить|ьте|им|ляй)|вставь|вставить|вставьте|положи|помести|впиши|допиши|заведи|прикрепи|подставь|воткни|засунь)');
/** Вставка в начало / в конец. */
const RE_AT_START = rx('(в\\s+начал|в\\s+самом\\s+верху|сверху|наверх|первым|первой|перед\\s+вс(ем|еми))');
const RE_AT_END = rx('(в\\s+конец|в\\s+конце|в\\s+самом\\s+низу|снизу|внизу|последним|последней|после\\s+вс(его|ех))');

const INS_WORD = '[\\p{L}\\p{N}«»\'"·-]+';
/** «<предлог> одно-три слова» — кандидат на имя контейнера. */
const prepPhrase = (prep) => new RegExp(
  '(?:^|[^\\p{L}\\p{N}])(?:' + prep + ')\\s+((?:' + INS_WORD + ')(?:\\s+' + INS_WORD + '){0,2})', 'iu');

const RE_IN = prepPhrase('в|во|внутрь|внутри');
const RE_AFTER = prepPhrase('под|после|ниже|за');
const RE_BEFORE = prepPhrase('над|перед|выше');
const RE_NEXT_TO = prepPhrase('рядом\\s+с|рядом\\s+со|возле|около|справа\\s+от|слева\\s+от');

/**
 * Грубое отсечение русского окончания: «в списке» должно находить «Список пунктов»,
 * «в шапку» — «Шапка». Полноценной морфологии здесь не нужно: сравниваем по началу слова.
 */
export function stemRu(word) {
  const w = String(word == null ? '' : word).toLowerCase().replace(/ё/g, 'е');
  if (w.length <= 4) return w;
  return w.replace(/(иями|ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ам|ям|ов|ев|ей|ый|ий|ой|ая|яя|ое|ее|ую|юю|ые|ие|а|я|о|е|у|ю|ы|и|ь|й)$/u, '');
}

/**
 * Похожи ли слова с точностью до окончания. Отсечения окончания мало: в русском бывает
 * беглая гласная («заголовок» → «заголовком»), поэтому у длинных слов сверяем ещё и начало.
 */
const wordsAlike = (a, b) => a === b || a.startsWith(b) || b.startsWith(a)
  || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

/** Слова, которые именем слоя быть не могут. */
const INS_STOP = new Set([
  'это', 'этот', 'эту', 'том', 'той', 'тот', 'самом', 'самый', 'него', 'нее', 'ней', 'нем',
  'низу', 'верху', 'низ', 'верх', 'конец', 'конце', 'начало', 'начале', 'там', 'тут', 'ещё', 'еще',
  'один', 'одну', 'одно', 'новый', 'новую', 'новое', 'нового', 'пожалуйста', 'все', 'всех',
]);

/**
 * Фраза → узел документа по словам имени. Возвращает {id, hits, score} или null.
 * prefer — узлы, которые человек сейчас видит и правит: они выигрывают у одноимённых с другого экрана.
 */
function matchNodeByWords(doc, phrase, prefer, sameArtboard, needFrame, frameBonus = true) {
  const words = (String(phrase || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => !INS_STOP.has(w));
  const qs = words.map(stemRu).filter((w) => w.length >= 3);
  if (!qs.length) return null;
  let best = null;
  for (const id of Object.keys(doc.nodes || {})) {
    const n = doc.nodes[id];
    if (!n || n.type === 'page') continue;
    // круг 19: место вставки в библиотеке не ищем — новое кладут на доску, а не в словарь
    if (inLibrary(doc, null, id)) continue;
    if (needFrame && n.type !== 'frame') continue;
    const ns = (String(n.name || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(stemRu);
    if (!ns.length) continue;
    let hits = 0;
    for (const q of qs) if (ns.some((w) => w.length >= 3 && wordsAlike(w, q))) hits++;
    if (hits < qs.length) continue;                // фраза должна опознаться целиком
    // за каждое ЛИШНЕЕ слово в имени — штраф: «Заголовок экрана» ближе к «под заголовком»,
    // чем контейнер «Дата и заголовок», внутри которого он лежит
    const score = hits * 100 + (prefer.has(id) ? 60 : sameArtboard.has(id) ? 30 : 0)
      + (frameBonus && n.type === 'frame' ? 20 : 0) - Math.min(18, 6 * Math.max(0, ns.length - hits));
    if (!best || score > best.score) best = { id, hits, score };
  }
  return best;
}

/** Лучший узел по фразе: пробуем одно слово, два, три — берём самое уверенное совпадение. */
function bestNodeForPhrase(doc, phrase, prefer, sameArtboard, needFrame, frameBonus = true) {
  const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  let best = null;
  for (let len = 1; len <= Math.min(3, words.length); len++) {
    const got = matchNodeByWords(doc, words.slice(0, len).join(' '), prefer, sameArtboard, needFrame, frameBonus);
    if (got && (!best || got.score > best.score)) best = got;
  }
  return best;
}

/**
 * Круг 7, п.4: назван ли в реплике слой, который в документе уже есть. Нужно локальному
 * классификатору: реплика без глагола, но про существующий слой — это правка, а не новый блок.
 *
 * Круг 9, п.6: порог был слишком низким, а результат при этом ПОКАЗЫВАЛСЯ человеку.
 * «Переключись на второй экран» давало «назван существующий слой «Заголовок экрана»» —
 * совпало слово «экран»; «в таблице покрась статус…» давало «Строка статуса» с другого
 * артборда, хотя в документе есть слой ровно с именем «Статус». Три поправки:
 *   • совпадение по ЦЕЛОМУ слову (равенство основ), а не по началу из четырёх букв;
 *   • слова-указатели на сам редактор («экран», «макет», «слой», «страница») сами слоя не
 *     называют: без хотя бы одного содержательного совпадения матча нет вовсе;
 *   • перебираем ВСЕ узлы и берём лучший: имя, названное целиком, выигрывает у имени,
 *     от которого угадали одно слово; узлы активной области (opts.prefer) — у чужих.
 * Слабое совпадение (одно слово из многословного имени) остаётся сигналом «это правка»,
 * но НЕ показывается человеку: угаданное имя хуже отсутствия объяснения.
 *
 * @param {object} doc документ
 * @param {string} utterance реплика
 * @param {{prefer?:Set<string>}} [opts] prefer — id узлов области работы
 * @returns {{name:string, id:string, strength:'strong'|'weak'}|null}
 */
/** Слова, которые называют сам редактор, а не слой в нём. */
const CHROME_WORDS = new Set([
  'экран', 'артборд', 'доска', 'доски', 'макет', 'слой', 'узел', 'страниц', 'документ', 'холст', 'полотн',
  'проект', 'файл', 'кадр', 'фрейм', 'элемент', 'блок',
]);

export function mentionsExistingLayer(doc, utterance, opts = {}) {
  if (!doc || !doc.nodes) return null;
  const prefer = opts && opts.prefer instanceof Set ? opts.prefer : new Set();
  const words = (String(utterance == null ? '' : utterance).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => !INS_STOP.has(w) && !FILLER_WORDS.has(w) && !BARE_VERBS.has(w));
  const qs = Array.from(new Set(words.map(stemRu).filter((w) => w.length >= 4)));
  if (!qs.length) return null;
  const meaningful = new Set(qs.filter((q) => !CHROME_WORDS.has(q)));
  if (!meaningful.size) return null;                // в реплике только слова про сам редактор
  let best = null;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n || n.type === 'page') continue;
    // круг 19: «слой с таким именем в документе есть» — про доски, а не про библиотеку:
    // мастер «Кнопка» иначе превращал бы любое «добавь кнопку» в правку существующего слоя
    if (inLibrary(doc, null, id)) continue;
    const ns = (String(n.name || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .map(stemRu).filter((w) => w.length >= 4);
    if (!ns.length) continue;
    const hit = ns.filter((w) => qs.includes(w));   // целое слово, а не общее начало
    if (!hit.length || !hit.some((w) => meaningful.has(w))) continue;
    const whole = hit.length >= ns.length;          // имя слоя названо целиком
    const strength = whole || hit.length >= 2 ? 'strong' : 'weak';
    // главное слово имени («Кнопка «Добавить пункт»» → «кнопка») опознаёт слой лучше,
    // чем уточняющее («Подпись кнопки»): на «у кнопки радиус» речь о самой кнопке
    const headWord = hit.includes(ns[0]) ? 30 : 0;
    const score = (whole ? 400 : 0) + hit.length * 100 + headWord
      + (prefer.has(id) ? 50 : 0) - Math.min(40, 10 * (ns.length - hit.length));
    if (!best || score > best.score) best = { name: n.name || id, id, strength, score };
  }
  if (!best) return null;
  return { name: best.name, id: best.id, strength: best.strength };
}

/**
 * Круг 7, п.3: «добавь под заголовком плашку с погодой» кладёт результат в служебную обёртку.
 * Якорь ищется по имени, а родителем становится его НЕПОСРЕДСТВЕННЫЙ родитель — на демо это
 * колонка «Дата и заголовок» шириной 153 px внутри экрана в 390 px, и плашка «во всю ширину»
 * выходила прямоугольником 153×34 в углу шапки. Тот уровень, который человек видит, — выше.
 *
 * Поднимаемся, пока текущий кандидат не годится для блока ВО ВСЮ ШИРИНУ:
 *   • это hug-обёртка заметно уже артборда (ширины уже посчитаны — берём их из geo);
 *   • или это строка (mode "row"): «под» и «над» в строке смысла не имеют.
 * Останавливаемся на артборде. Для «рядом с» не поднимаемся вовсе: там просили соседа.
 *
 * @returns {{parentId:string, index:number, why:string}|null} — применяется ТОЛЬКО если новый
 *   узел действительно просит w:"fill" (решается в материализации).
 */
function widerLevel(doc, parent, anchorId, at, shift, geo) {
  const rects = rectsOf(geo);
  const ab = artboardOf(doc, anchorId);
  const abNode = ab ? nodeOf(doc, ab) : null;
  const abW = (rects && rects[ab] && Number(rects[ab].w))
    || (abNode && abNode.size && abNode.size.w && abNode.size.w.mode === 'fixed' ? Number(abNode.size.w.value) : null);
  const narrow = (n) => {
    const spec = n.size && n.size.w;
    if (!spec || spec.mode !== 'hug') return false;
    const w = rects && rects[n.id] ? Number(rects[n.id].w) : null;
    return w == null || !abW ? true : w < abW * 0.7;
  };
  const rowish = (n) => !!(n.layout && n.layout.mode === 'row');
  const anchorName = (nodeOf(doc, anchorId) || {}).name || anchorId;
  let cur = parent;
  let index = at + shift;
  const passed = [];
  let guard = 0;
  while (guard++ < MAX_TREE_DEPTH + 2) {
    if (cur.id === ab || cur.type === 'page') break;
    if (!(narrow(cur) || rowish(cur))) break;
    const up = nodeOf(doc, cur.parent);
    if (!up || up.type === 'page') break;
    const pos = kidsOf(up).indexOf(cur.id);
    if (pos < 0) break;
    passed.push(`«${cur.name || cur.id}»`);
    index = pos + shift;
    cur = up;
  }
  if (!passed.length || cur === parent) return null;
  return {
    parentId: cur.id,
    index,
    why: passed.length > 1
      ? `«${anchorName}» лежит в обёртках ${passed.join(' → ')}, а они для блока во всю ширину не годятся:`
        + ` кладу уровнем выше, в «${cur.name || cur.id}»`
      : `«${anchorName}» лежит в обёртке ${passed[0]}, которая уже экрана:`
        + ` блок во всю ширину кладу уровнем выше, в «${cur.name || cur.id}»`,
  };
}

/**
 * Круг 3, п.3: контейнер, названный ПРЯМО В КОМАНДЕ. Раньше место вставки задавалось только
 * выделением или активным артбордом, поэтому «добавь в список пункт на 20:00» падало то в
 * список, то в конец экрана — в зависимости от того, какое намерение выбрал планировщик.
 * Голосом выделить контейнер нельзя, значит, место должно решаться словами команды.
 *
 * @returns {{parentId:string, index:number|null, why:string, ref:string, wide?:object}|null}
 */
export function findInsertTarget(doc, utterance, scope, engine, geo = null) {
  const s = String(utterance == null ? '' : utterance);
  if (!doc || !doc.nodes || !RE_ADD_VERB.test(s)) return null;

  const prefer = new Set(collectSubtree(doc, (scope && scope.ids) || []));
  const ab = artboardOf(doc, (scope && scope.ids && scope.ids[0]) || '');
  const sameArtboard = new Set(ab ? collectSubtree(doc, [ab]) : []);
  const posOf = (id) => {
    const n = nodeOf(doc, id);
    const parent = n && n.parent ? nodeOf(doc, n.parent) : null;
    const kids = kidsOf(parent);
    return { parent, at: kids.indexOf(id) };
  };
  const byRole = (phrase) => {
    if (!engine || typeof engine.resolveTarget !== 'function') return null;
    try {
      const got = engine.resolveTarget(doc, String(phrase).trim());
      const id = typeof got === 'string' ? got : got && got.id;
      const n = id ? nodeOf(doc, id) : null;
      return n && n.type === 'frame' ? { id, hits: 1, score: 1 } : null;
    } catch { return null; }
  };

  /**
   * 1. «под заголовком», «после шапки», «над кнопкой» — рядом с названным узлом, на его уровне.
   *
   * Круг 9, п.7: раньше в why подставлялся СЫРОЙ обрывок реплики — «в команде сказано «после
   * заголовком плашку»», «в команде сказано «в пункта тренировка иконку»». Эта строка идёт и в
   * промпт, и человеку на экран, и по-русски она не звучит: падеж чужой, а в обрывок попадают
   * слова уже не про место. Пересказываем НАЙДЕННОЕ своими словами и в именительном падеже.
   */
  for (const [re, shift, word, vertical] of [[RE_AFTER, 1, 'после слоя', true], [RE_BEFORE, 0, 'перед слоем', true], [RE_NEXT_TO, 1, 'рядом со слоем', false]]) {
    const m = re.exec(s);
    if (!m) continue;
    // якорь («под заголовком») — это обычно конкретный элемент, а не контейнер: бонус фрейму не даём
    const hit = bestNodeForPhrase(doc, m[1], prefer, sameArtboard, false, false);
    if (!hit) continue;
    const { parent, at } = posOf(hit.id);
    if (!parent || at < 0) continue;
    const anchor = nodeOf(doc, hit.id);
    // круг 7, п.3: для блока во всю ширину служебная обёртка якоря — не тот уровень
    const wide = vertical ? widerLevel(doc, parent, hit.id, at, shift, geo) : null;
    return {
      parentId: parent.id, index: at + shift, ref: m[1],
      why: `вставляю ${word} «${(anchor && anchor.name) || hit.id}», внутрь «${parent.name || parent.id}»`,
      ...(wide ? { wide } : {}),
    };
  }

  // 2. «в список», «в шапку», «внутрь карточки» — внутрь названного ФРЕЙМА
  const mIn = RE_IN.exec(s);
  if (mIn) {
    const hit = bestNodeForPhrase(doc, mIn[1], prefer, sameArtboard, true) || byRole(mIn[1]);
    if (hit) {
      const node = nodeOf(doc, hit.id);
      const index = RE_AT_START.test(s) ? 0 : null;
      return {
        parentId: hit.id, index, ref: mIn[1],
        why: `вставляю внутрь слоя «${(node && node.name) || hit.id}»`
          + (index === 0 ? ', первым элементом' : ''),
      };
    }
  }

  // 3. «снизу экрана», «сверху» — контейнер тот же, меняется только позиция
  if (RE_AT_START.test(s)) {
    const container = scope && scope.containerId && nodeOf(doc, scope.containerId);
    if (container && container.type === 'frame') {
      return {
        parentId: container.id, index: 0, ref: '',
        why: `вставляю первым элементом в «${container.name || container.id}»: в команде сказано «сверху»`,
      };
    }
  }
  if (RE_AT_END.test(s)) {
    const container = scope && scope.containerId && nodeOf(doc, scope.containerId);
    if (container && container.type === 'frame') {
      return {
        parentId: container.id, index: null, ref: '',
        why: `дописываю последним элементом в «${container.name || container.id}»: в команде сказано «снизу»`,
      };
    }
  }
  return null;
}

/**
 * Куда кладём созданное (п.4, п.5). Новый артборд — только по явной просьбе
 * («новый экран», «ещё один экран», «отдельный артборд») или когда просят собрать
 * экран целиком и ничего не выделено. Иначе — в контейнер, названный в самой команде
 * (круг 3, п.3), а если он не назван — в активная доска/выделенный фрейм:
 * «добавь снизу панель с тремя кнопками» обязано попасть в текущий экран, а не в сторону.
 */
function describePlacement(doc, scope, engine, utterance, plan, warn, geo = null) {
  const note = warn || (() => {});
  const spoken = String(utterance || '');
  /**
   * Круг 7, п.2: РЕШАЕТ ЧЕЛОВЕК. Раньше без выделения (а в голосовом режиме его нет всегда)
   * RE_NEW_ARTBOARD проверялся ещё и по plan.title/plan.summary — и «добавь блок отзывов из трёх
   * карточек» при плане «Создал новый экран отзывов» уезжало третьим артбордом на холст, тогда
   * как тот же ответ с планом «Добавил блок отзывов» ложился внутрь экрана. Формулировка модели
   * теперь только слабый довод: она не отменяет команду, но человеку об этом говорят словами.
   */
  const planText = [plan && plan.title ? String(plan.title) : '', plan && plan.summary ? String(plan.summary) : ''].join(' ');
  let insideNote = '';
  const saidNew = RE_NEW_ARTBOARD.test(spoken) || RE_ARTBOARD_WORD.test(spoken);
  const saidWhole = RE_WHOLE_SCREEN.test(spoken);
  const planOnlyNew = !saidNew && !saidWhole && scope.kind !== 'selection'
    && (RE_NEW_ARTBOARD.test(planText) || RE_WHOLE_SCREEN.test(planText));
  const explicit = saidNew;
  // круг 27: выделение агента («вот что я сделал») просьбу собрать экран не перебивает
  const wholeScreen = saidWhole && (scope.kind !== 'selection' || scope.selectionBy === 'agent') && !RE_HERE_PLACE.test(spoken);
  const insert = explicit || wholeScreen ? null : findInsertTarget(doc, spoken, scope, engine, geo);
  const container = scope.containerId && nodeOf(doc, scope.containerId);
  const asArtboard = explicit || wholeScreen || (!insert && (!container || container.type === 'page'));
  if (planOnlyNew && !asArtboard) {
    note(`План модели говорит про новый экран («${cutText((plan && plan.title) || '', 60)}»),`
      + ` а в команде экран не назван — кладу внутрь текущего ${nameOrId(doc, insert ? insert.parentId : scope.containerId)}.`
      + ' Нужна отдельная доска — скажите «новая доска»');
  } else if (saidWhole && !asArtboard && scope.kind === 'selection') {
    /* Круг 27: «собери экран …» при выделении человека собирается ВНУТРИ выделенного — так он
     * решил выделением; но сказать об этом надо: по словам команды ждут отдельный экран. */
    insideNote = `Собираю внутри выделенного ${nameOrId(doc, insert ? insert.parentId : scope.containerId)}: выделение ваше.`
      + ' Нужен отдельный экран — снимите выделение или скажите «новой доской»';
    note(insideNote);
  }
  /* Круг 29: выделен мелкий узел (ряд чипов, ярлык), а не доска. Экран в него может заведомо
   * не влезть — это видно, только когда дерево уже построено; materialize проверяет и, если
   * экран вылезает за выделенное, собирает его новой доской (screenInSelection). */
  const screenInSelection = !!insideNote && !insert && !!container && container.type !== 'page'
    && artboardOf(doc, container.id) !== container.id;

  if (insert) {
    const node = nodeOf(doc, insert.parentId);
    const where = insert.index === 0 ? ' Вставка первым элементом.'
      : insert.index != null ? ` Вставка на позицию ${insert.index} среди детей.` : ' Дописывается последним.';
    const wide = insert.wide ? nodeOf(doc, insert.wide.parentId) : null;
    return {
      asArtboard: false, insert: true, parentId: insert.parentId, index: insert.index,
      ...(insert.wide ? { wide: insert.wide } : {}),
      text: `Место названо в самой команде: ${insert.why}.`
        + ` Результат кладётся ВНУТРЬ #${insert.parentId} «${(node && node.name) || ''}»`
        + ` (раскладка: ${node && node.layout ? node.layout.mode : 'нет'}, ширина ${node && node.size && node.size.w ? sizeWord(node.size.w) : '?'}).${where}`
        + (wide ? ` Если твой корень шириной "fill" (во всю ширину), он ляжет уровнем выше — в #${insert.wide.parentId} «${wide.name || ''}»,`
          + ` потому что «${(node && node.name) || ''}» для блока во всю ширину слишком узок; хочешь остаться здесь — задай размер по содержимому.` : '')
        + ' Корень ответа — ОДИН узел, который туда вложится: не повторяй доску и не задавай позицию.'
        + ' Если правишь патчем — это {op:"create", parent:"' + ((node && node.name) || insert.parentId) + '"}.',
    };
  }

  if (!asArtboard) {
    const where = scope.kind === 'selection' ? 'выделенного фрейма' : 'активной доски';
    return {
      asArtboard: false,
      insert: false,
      index: null,
      parentId: scope.containerId,
      ...(screenInSelection ? { screenInSelection: true, insideNote } : {}),
      text: `Результат добавляется ВНУТРЬ ${where} #${scope.containerId} «${container.name || ''}» `
        + `(его раскладка: ${container.layout ? container.layout.mode : 'нет'}, ширина ${container.size && container.size.w ? sizeWord(container.size.w) : '?'}). `
        + 'Корень ответа — ОДИН узел, который туда вложится: не повторяй доску и не задавай ему позицию. '
        + 'Новый экран здесь не нужен — человек просил добавить к тому, что уже на экране.',
    };
  }
  return {
    asArtboard: true,
    insert: false,
    index: null,
    parentId: doc.root,
    text: 'Результат становится НОВОЙ доской на холсте (об этом попросили явно). '
      + 'Корень ответа — frame с фиксированной шириной (мобильный экран 390, десктопный блок 1200) и высотой "hug".',
  };
}

/**
 * Круг 29: «собери экран» при выделенном мелком узле (ряд чипов «Ярлыки», ярлык). Раньше экран
 * шириной 390 ложился в ряд шириной 350 и записывался с заведомым «вылез за рамки на 40 px»,
 * а модель получала круг починки, который этого не исправит. Пробуем положить дерево в
 * выделенное; если корень вылезает за него (нарушение out-of-parent у корня, которого не было
 * до правки), — собираем новой доской и говорим почему. null — влезает, оставляем как решил человек.
 */
function screenOutgrows({ engine, doc, data, placement, persona, said, baseline }) {
  let built;
  try {
    built = treeToOps({ doc, tree: data, engine, warn: () => {}, persona, said, parentId: placement.parentId, asArtboard: false });
  } catch { return null; }
  const top = asArray(built && built.ops).find((o) => o && o.op === 'create' && o.node && o.node.parent === placement.parentId);
  if (!top) return null;
  let applied;
  try { applied = engine.applyOps(doc, built.ops); } catch { return null; }
  if (!applied || applied.error || !applied.doc) return null;
  const geo = safeSolve(engine, applied.doc);
  const base = baseline || new Set();
  const out = safeValidate(engine, applied.doc, geo)
    .find((v) => v && v.code === 'out-of-parent' && (v.nodeId || v.id) === top.node.id && !base.has(violationKey(v)));
  if (!out) return null;
  const rect = (id) => (geo && geo.rects && geo.rects[id]) || null;
  const own = rect(top.node.id);
  const host = rect(placement.parentId);
  const sizes = own && host ? ` (${Math.round(own.w)} px против ${Math.round(host.w)} px)` : '';
  const name = (data && data.name) || top.node.name || 'Экран';
  return {
    placement: { asArtboard: true, insert: false, index: null, parentId: doc.root, text: placement.text },
    note: `«${cutText(String(name), 60)}» не влезает в выделенный ${nameOrId(doc, placement.parentId)}${sizes} —`
      + ' собрал его новой доской. Нужен внутри — выделите доску или фрейм пошире',
  };
}

/** Короткий устойчивый хэш строки: слепок для сравнения, а не для хранения. */
function shortHash(text) {
  const s = String(text == null ? '' : text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36);
}

/** Слепок видимого состояния: узлы и токены, без служебной версии документа. */
function visibleFingerprint(doc) {
  if (!doc) return '';
  try { return JSON.stringify({ root: doc.root, nodes: doc.nodes, tokens: doc.tokens }); } catch { return ''; }
}

/** Слепок геометрии: своим hashGeometry, если движок его даёт, иначе прямоугольниками. */
function geoFingerprint(engine, geo) {
  if (!geo) return '';
  try {
    if (engine && typeof engine.hashGeometry === 'function') return String(engine.hashGeometry(geo));
    const r = rectsOf(geo);
    return r ? JSON.stringify(r) : '';
  } catch { return ''; }
}

/**
 * Пути, чьё действие ЦЕЛИКОМ видно в прямоугольниках решателя: если хэш геометрии не
 * изменился, значит, эта правка и правда ничего не сдвинула (круг 7, п.5).
 *
 * Круг 9, п.1: «align» отсюда УБРАН. Выключка текста прямоугольник узла не меняет — core
 * превращает её в text-anchor, и строка уезжает ВНУТРИ своего бокса (на демо «Владелец»
 * шириной 180: x 1096 → 1276, весь столбец переехал на 180 px). Хэш геометрии об этом
 * ничего не знает, и приложение уверенно сообщало человеку, что «в документе поменялось,
 * а на экране — нет»: правильная работа объявлялась пустой, и человек её отменял.
 * Про выключку теперь отвечает textAlignIdle — по фактам, а не по хэшу.
 */
const GEOMETRY_PATHS = new Set([
  'layout.mode', 'layout.gap', 'layout.padding', 'layout.align', 'layout.justify', 'layout.wrap',
  'size', 'size.w', 'size.h',
]);

/**
 * Круг 9, п.1: видна ли выключка текста. Единственный случай, когда её ТОЧНО не видно, —
 * ширина бокса равна ширине строки: при «hug» бокс обнимает содержимое, и двигать строку
 * внутри него некуда. Многострочный hug — уже другое дело: у коротких строк место есть,
 * и они сдвинутся. Ширина «fill» и фиксированная ширина дают строке запас всегда.
 * @returns {string|null} причина невидимости словами, либо null — правку видно
 */
function textAlignIdle(doc, node, geo) {
  if (!node || node.type !== 'text') return null;
  const w = node.size && node.size.w;
  if (!w || w.mode !== 'hug') return null;
  const lines = geo && geo.lines ? geo.lines[node.id] : null;
  if (Array.isArray(lines) && lines.length > 1) return null;   // короткие строки поедут
  const parent = nodeOf(doc, node.parent);
  const pl = (parent && parent.layout) || null;
  return 'ширина этого текста — по содержимому, и выключке некуда двигать строку:'
    + ' поставьте ширину «во всю ширину»'
    + (pl && pl.mode && pl.mode !== 'none' ? ` или задайте распределение у «${parent.name || parent.id}»` : '');
}

/**
 * Круг 11, п.4: правки, которые ДОКАЗУЕМО ничего не рисуют. Совпадение хэшей геометрии их не
 * ловит (прямоугольник и не должен был поменяться), и «сделай аватар квадратным» → set radius
 * 999→0 у эллипса попадало в отчёт строкой «Скругление 999 → 0 у «Аватар»», тогда как core
 * рисует эллипс вообще без radius и на экране не менялось ничего.
 *
 * Список закрытый и только про то, что проверяется фактами: форма узла, его посчитанный размер
 * и наличие текста. Выдумывать причины нельзя — промолчать честнее, чем соврать.
 * @returns {string|null} причина словами, либо null — про этот случай мы ничего не знаем
 */
function pointlessEdit(doc, node, path, geo) {
  if (!node) return null;
  const chars = node.type === 'text' ? String(node.characters == null ? '' : node.characters) : null;
  const emptyText = chars !== null && !chars.trim();
  if (emptyText && (path === 'color' || path === 'style' || path === 'align')) {
    return 'в этом слое нет текста — цвету и шрифту нечего красить, пока он пустой';
  }
  if (path === 'radius' && node.type === 'ellipse') {
    return 'это эллипс, у него нет углов: скругление к нему не применяется совсем'
      + ' — чтобы получить прямые углы, нужен прямоугольник (другой тип слоя), а его правкой не сменить';
  }
  const rect = (rectsOf(geo) || {})[node.id] || null;
  const flat = rect && (Math.round(Number(rect.w)) === 0 || Math.round(Number(rect.h)) === 0);
  if (flat && (path === 'fill' || path === 'stroke' || path === 'radius' || path === 'opacity' || path === 'src')) {
    return `размер этого слоя — ${rnd(rect.w)}×${rnd(rect.h)}: рисовать нечего, пока у него нет ширины или высоты`;
  }
  return null;
}

/**
 * Круг 36: слои, чья микроанимация после этих операций длится дольше MICRO_MAX_MS. О них
 * говорится одной строкой; возвращаются их id (а '*' — если медленной стала сама ступень
 * шкалы движения: тогда её слои перечислять бессмысленно, сказано в themeToOps).
 */
function slowMotionNotes(before, after, ops, warn) {
  const ids = new Set();
  if (!after) return ids;
  const list = asArray(ops);
  if (list.some((o) => o && o.op === 'setToken' && /^motion\./.test(String(o.path)) && Number(o.value) > MICRO_MAX_MS)) ids.add('*');
  const touched = [...new Set(list.filter((o) => o && o.op === 'set' && o.id && /^(states|motion)(\.|$)/.test(String(o.path)))
    .map((o) => o.id))];
  const slow = [];
  for (const id of touched) {
    const n = nodeOf(after, id);
    if (!n || !n.states || typeof n.states !== 'object' || !STATE_NAMES.some((st) => n.states[st])) continue;
    const ms = nodeMotionMs(after, n);
    if (ms > MICRO_MAX_MS) { slow.push({ id, ms }); ids.add(id); }
  }
  if (slow.length && warn) {
    const first = slow[0];
    warn(`${nameOrId(after, first.id)}: микроанимация длится ${Math.round(first.ms)} мс — дольше ${MICRO_MAX_MS} мс,`
      + ` отклик будет казаться вязким${slow.length > 1 ? ` (и ещё у ${slow.length - 1} ${plural(slow.length - 1, 'слоя', 'слоёв', 'слоёв')})` : ''}.`
      + ' Скажите «быстрее», если так не задумано');
  }
  return ids;
}

/**
 * Круг 7, п.5: почему правка легла в документ, а на экране ничего не сдвинулось. Раньше это
 * состояние было невидимым: «Зазор 12 → 8 в «Шапка»» при justify="between" — зазор раскладка
 * не использует, геометрия до и после совпадает, предупреждений ноль, и человек ищет разницу
 * глазами. Возвращаем причину словами, если можем её назвать.
 */
function layoutIgnores(doc, node, path, geo = null) {
  if (!node) return null;
  const l = node.layout || null;
  const kids = kidsOf(node).length;
  const parent = nodeOf(doc, node.parent);
  const pl = (parent && parent.layout) || null;
  if (path === 'align') return textAlignIdle(doc, node, geo);
  if (path.indexOf('layout.') === 0) {
    if (!l || !l.mode || l.mode === 'none') return 'у этого слоя нет раскладки (поток «свободно») — её значения ни на что не влияют';
    if (kids < 2 && (path === 'layout.gap' || path === 'layout.mode' || path === 'layout.justify')) {
      return `внутри ${kids ? 'всего один элемент' : 'ничего нет'} — раскладке нечего расставлять`;
    }
    if (path === 'layout.gap' && l.justify === 'between') {
      return 'свободное место в нём распределяется по краям (распределение «с промежутками»), и зазор между детьми на вид не меняет ничего';
    }
    if (path === 'layout.wrap') {
      return l.mode === 'row'
        ? 'перенос сработает только когда содержимое перестанет влезать в строку — сейчас оно влезает'
        : 'перенос строк работает только при потоке «строка»';
    }
    /**
     * Круг 15, п.3: «сделай список в две колонки» (mode "row" + wrap) на списке, у детей
     * которого ширина "fill". Геометрия и правда не меняется, но причина совсем другая:
     * растянутый ребёнок занимает в строке ВСЮ строку, следом идёт перенос — и строка выходит
     * той же колонкой. Раньше в этом месте подставлялась общая заготовка «раскладка этого узла
     * такое значение не использует», то есть неправда: mode раскладка использует, мешают дети.
     */
    if (path === 'layout.mode' && l.mode === 'row' && l.wrap) {
      const fills = kidsOf(node).filter((k) => {
        const kid = nodeOf(doc, k);
        const w = kid && kid.size && kid.size.w;
        return !!w && w.mode === 'fill';
      });
      if (fills.length >= 2 && fills.length === kids) {
        return `внутри ${kids} ${plural(kids, 'слоя', 'слоёв', 'слоёв')} с шириной «во всю ширину» — каждый растягивается во всю строку,`
          + ' а следом идёт перенос, и строка выглядит той же колонкой.'
          + ' Чтобы получились колонки, задайте детям ширину по содержимому или числом';
      }
    }
  }
  /**
   * Круг 9, п.8: формулировка была ложной — «своя ширина узла не применяется». core растягивает
   * ребёнка только когда его собственная спека «fill» или «hug» (core.js: crossFill =
   * crossSpec.mode === 'fill' || (align === 'stretch' && crossSpec.mode === 'hug')), а
   * ФИКСИРОВАННУЮ ширину уважает. Значит, про stretch можно говорить ровно в том случае,
   * когда поставили «hug» или «fill»; для фиксированного числа причина в чём-то другом,
   * и выдумывать её нельзя — сработает общая формулировка.
   */
  const crossStretch = (axis) => {
    const spec = node.size && node.size[axis];
    const mode = spec && spec.mode;
    if (mode !== 'hug' && mode !== 'fill') return null;
    const side = axis === 'w' ? 'ширине' : 'высоте';
    const own = axis === 'w' ? 'ширина' : 'высота';
    const acc = axis === 'w' ? 'ширину' : 'высоту';
    return `родитель «${parent.name || parent.id}» растягивает детей по ${side} (выравнивание «растянуть»),`
      + ` и ${own} «${mode === 'hug' ? 'по содержимому' : 'во всё место'}» у него превращается в ${acc} родителя.`
      + ' Нужен свой размер — задайте его числом';
  };
  if (path === 'size.w' && pl && pl.mode === 'column' && pl.align === 'stretch') return crossStretch('w');
  if (path === 'size.h' && pl && pl.mode === 'row' && pl.align === 'stretch') return crossStretch('h');
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 9a. Негодная палитра: чиним сами (круг 16, п.3)
 *
 * На «сделай тёмную тему» модель может вернуть text #f2f4f8 при surface #ffffff — белое по
 * белому. Приложение это честно замечало («контраст 1.10:1 при норме 3:1»), но палитру
 * ПРИМЕНЯЛО, и человек получал документ, который нельзя прочесть, с зелёной галочкой над
 * ним. Это не «замечание валидатора»: это негодный ответ модели.
 *
 * Почему чиним сами, а не круглом починки. Вся палитра документа у нас на руках, контраст
 * считается арифметикой, и подбор читаемого цвета текста — детерминированная задача: лишний
 * вызов модели тут ничего не добавляет (а критик видел, как он честно НЕ помогает), зато
 * стоит секунды на локальной сборке. Правило «человек сам попросил этот цвет» (п.2) здесь
 * не работает и не должно: «сделай тёмную тему» цвета не называет.
 *
 * Что именно правим: только ТОКЕНЫ, которыми покрашен текст, и только светлоту — оттенок
 * остаётся моделиным. Фоны не трогаем: это замысел темы, а читаемость достигается текстом.
 * Норму берём строгую (4,5:1) для любого текста: она заведомо перекрывает и 3:1 для крупного,
 * а лазить в разрешение типографики ради послабления незачем.
 * ──────────────────────────────────────────────────────────────────────────── */

/** '#rrggbb' → [r,g,b]; всё прочее — null. */
function hexRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

const channelLum = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

/** Контраст WCAG 2.1 между двумя '#rrggbb'. Та же арифметика, что в core.contrastRatio. */
function contrastOf(a, b) {
  const ra = hexRgb(a);
  const rb = hexRgb(b);
  if (!ra || !rb) return 21;
  const la = 0.2126 * channelLum(ra[0]) + 0.7152 * channelLum(ra[1]) + 0.0722 * channelLum(ra[2]);
  const lb = 0.2126 * channelLum(rb[0]) + 0.7152 * channelLum(rb[1]) + 0.0722 * channelLum(rb[2]);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Значение цвета → '#rrggbb' по палитре документа (как core.resolveColor). */
function hexOf(doc, value) {
  const ref = colorRef(value);
  if (!ref) return null;
  const colors = (doc && doc.tokens && doc.tokens.colors) || {};
  const raw = Object.prototype.hasOwnProperty.call(colors, ref) ? String(colors[ref]) : ref;
  const h = hexNorm(raw);
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

/** Фон под узлом: первая заливка вверх по предкам, иначе холст (как core.nearestFill). */
function bgHexOf(doc, node) {
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 512) {
    const hex = hexOf(doc, cur.fill);
    if (hex) return hex;
    cur = cur.parent ? nodeOf(doc, cur.parent) : null;
  }
  return hexOf(doc, (doc.tokens && doc.tokens.colors && doc.tokens.colors.canvas) || '#ffffff');
}

const CONTRAST_NORM = 4.5;

/**
 * Доля нечитаемого текста, после которой палитра считается негодной и не применяется вовсе
 * (круг 16, п.3). Порог — по замерам на демо-документе, см. место применения в runCommand.
 */
const UNREADABLE_SHARE = 0.25;

/**
 * Читаемый цвет того же оттенка: меняем только светлоту, шагами по 5%, и в обе стороны —
 * на сером фоне #777 белое даёт 4.48:1 (норму не берёт), а чёрное 4.69:1 берёт.
 * @returns {string|null} новый '#rrggbb', либо null — и так читается или лучше не стало
 */
function readableHex(base, backgrounds) {
  const worst = (hex) => backgrounds.reduce((m, bg) => Math.min(m, contrastOf(hex, bg)), 21);
  if (worst(base) >= CONTRAST_NORM) return null;
  let best = { hex: null, got: worst(base) };
  for (let i = 1; i <= 20; i++) {
    for (const k of [i / 20, -i / 20]) {
      const cand = shadeHex(base, k);
      const got = worst(cand);
      if (got >= CONTRAST_NORM) return cand;
      if (got > best.got) best = { hex: cand, got };
    }
  }
  return best.hex;
}

/**
 * Палитра, в которой текст не читается → операции setToken, которые это исправляют.
 *
 * Два прохода, оба — арифметика по фактам документа:
 *   A. ЦВЕТА ТЕКСТА. Для каждого токена, которым покрашен неразборчивый текст, подбираем
 *      светлоту, работающую на ВСЕХ фонах, где этот токен встречается. Если такого цвета нет
 *      вовсе (модель поменяла часть палитры и оставила и светлые, и тёмные фоны), целимся в
 *      ГЛАВНЫЙ фон — тот, на котором этого текста больше всего.
 *   B. ФОНЫ. То, что осталось нечитаемым после A, добираем со стороны фона: у фонового токена,
 *      которым не покрашен ни один текст, подбираем светлоту под тексты, лежащие на нём.
 *      Именно так лечится половинная тема — тёмная «карточка» при светлой «подложке».
 * Токен, который служит И цветом текста, И заливкой, не трогаем ни там, ни там: меняя его,
 * мы двигали бы обе стороны контраста сразу.
 * @returns {{ops:Array, fixed:Array<{token:string,from:string,to:string}>, stuck:string[]}}
 */
function repairPalette(doc, engine, touched = new Set()) {
  const original = (doc && doc.tokens && doc.tokens.colors) || {};
  const colors = { ...original };                  // рабочая копия палитры
  const has = (ref) => Object.prototype.hasOwnProperty.call(colors, ref);
  const refHex = (ref) => {
    const h = hexNorm(has(ref) ? String(colors[ref]) : String(ref));
    return /^#[0-9a-f]{6}$/.test(h) ? h : null;
  };
  /** Ссылка на фон под узлом: имя токена или прямой код — первая заливка вверх по предкам. */
  const bgRefOf = (node) => {
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 512) {
      const ref = colorRef(cur.fill);
      if (ref && refHex(ref)) return ref;
      cur = cur.parent ? nodeOf(doc, cur.parent) : null;
    }
    return has('canvas') ? 'canvas' : '#ffffff';
  };

  const items = [];
  for (const id of Object.keys(doc.nodes || {})) {
    const n = doc.nodes[id];
    if (!n || n.type !== 'text') continue;
    // пустому слою нечего читать — его контраст и валидатор поводом не считает
    if (!String(n.characters == null ? '' : n.characters).trim()) continue;
    const fg = colorRef(n.color) || 'text';
    const bg = bgRefOf(n.parent ? nodeOf(doc, n.parent) : n);
    if (!refHex(fg) || !refHex(bg)) continue;
    items.push({ name: n.name || id, fg, bg });
  }
  if (!items.length) return { ops: [], fixed: [], stuck: [] };
  const textRefs = new Set(items.map((it) => it.fg));
  const bgRefs = new Set(items.map((it) => it.bg));
  const bad = () => items.filter((it) => contrastOf(refHex(it.fg), refHex(it.bg)) < CONTRAST_NORM);
  const stuck = new Set();

  /* — Проход A: цвета текста — */
  for (const ref of new Set(bad().map((it) => it.fg))) {
    if (!has(ref) || bgRefs.has(ref)) { stuck.add(ref); continue; }
    const mine = items.filter((it) => it.fg === ref);
    const all = [...new Set(mine.map((it) => refHex(it.bg)))];
    let cand = readableHex(refHex(ref), all);
    if (cand && all.some((bg) => contrastOf(cand, bg) < CONTRAST_NORM)) {
      // на всех фонах сразу не выходит: целимся в тот, где этого текста больше всего
      const count = new Map();
      for (const it of mine) { const h = refHex(it.bg); count.set(h, (count.get(h) || 0) + 1); }
      const main = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      /* null здесь значит «на главном фоне и так читается»: тогда сам цвет текста НЕ трогаем
       * (иначе хорошая тёмная палитра портилась ради двух подписей на светлой плашке) —
       * такие места лечит проход B со стороны фона. */
      cand = readableHex(refHex(ref), [main]);
    }
    if (cand) colors[ref] = cand; else stuck.add(ref);
  }

  /* — Проход B: фоны, на которых текст всё ещё не читается — */
  for (const ref of new Set(bad().map((it) => it.bg))) {
    /* Фон, который модель поставила ИМЕННО ЭТОЙ командой, не двигаем: человек просил тёмную
     * тему — вернуть фон в светлый значило бы отменить просьбу. Здесь лечатся ЗАБЫТЫЕ моделью
     * фоны: тёмная «карточка» при оставшейся светлой «подложке». */
    if (!has(ref) || textRefs.has(ref) || touched.has(ref)) { stuck.add(ref); continue; }
    const fgs = [...new Set(items.filter((it) => it.bg === ref).map((it) => refHex(it.fg)))];
    const cand = readableHex(refHex(ref), fgs);
    if (cand) colors[ref] = cand; else stuck.add(ref);
  }

  const ops = [];
  const fixed = [];
  for (const token of Object.keys(colors)) {
    const from = hexNorm(String(original[token] == null ? '' : original[token]));
    const to = hexNorm(String(colors[token]));
    if (!to || to === from) continue;
    ops.push(mkOp(engine, 'setToken', { path: `colors.${token}`, value: to }));
    fixed.push({ token, from, to });
  }
  const left = bad().map((it) => `«${it.name}»`);
  return { ops, fixed, stuck: [...new Set([...[...stuck].map((r) => `цвет «${ruToken('colors', r)}»`), ...left])] };
}

function materialize({ engine, doc, data, intent, scope, placement, persona, baseline, geo: baseGeo = null, group = false, said = '' }) {
  const warnings = [];
  const warn = (m) => { if (m && !warnings.includes(m)) warnings.push(m); };
  const out = { ops: [], preview: null, problems: [], blocking: [], violations: [], warnings, fatal: null };

  try {
    if (intent === 'create') {
      // круг 29: экран, который заведомо не влезает в выделенный мелкий узел, — новой доской
      if (placement.screenInSelection) {
        const moved = screenOutgrows({ engine, doc, data, placement, persona, said, baseline });
        if (moved) {
          placement = moved.placement;
          out.movedToBoard = true;
          warn(moved.note);
        }
      }
      out.placement = placement;
      // круг 7, п.3: блок во всю ширину не кладём в узкую обёртку якоря — поднимаемся уровнем выше
      const wide = placement.insert
        ? wideTarget(doc, placement, wantsFullWidth(data && data.size), warn)
        : null;
      const built = treeToOps({
        doc, tree: data, engine, warn, persona, said,
        parentId: wide ? wide.parentId : placement.parentId,
        // место названо в самой команде («добавь в список пункт») — вставляем именно туда (круг 3, п.3)
        index: wide ? wide.index : (placement.insert && placement.index != null ? placement.index : undefined),
        asArtboard: placement.asArtboard,
      });
      out.ops = built.ops;
    } else if (intent === 'theme') {
      out.ops = themeToOps({ doc, theme: data, engine, warn, scope });
    } else {
      out.ops = patchToOps({ doc, patch: data, scope, engine, warn, persona, placement, geo: baseGeo, group, said });
    }
  } catch (e) {
    out.fatal = e instanceof BrainError ? e : ERR('schema', e && e.message ? e.message : String(e));
    out.problems.push(out.fatal.message);
    out.blocking.push(out.fatal.message);
    return out;
  }

  let applied;
  try {
    applied = engine.applyOps(doc, out.ops);
  } catch (e) {
    applied = { doc: null, error: e && e.message ? e.message : String(e) };
  }
  if (!applied || applied.error || !applied.doc) {
    // core после правок отдаёт error объектом {code, message}, раньше была строка — принимаем обе формы
    const err = applied && applied.error;
    const msg = !err ? 'операции не применились'
      : typeof err === 'string' ? err
        : [err.message, err.code ? `(${err.code})` : ''].filter(Boolean).join(' ') || JSON.stringify(err);
    out.fatal = ERR('model', `Операции не применились: ${msg}`);
    out.problems.push(`Операции не применились: ${msg}`);
    out.blocking.push(`Операции не применились: ${msg}`);
    return out;
  }

  let geo = safeSolve(engine, applied.doc);
  const base = baseline || new Set();
  let fresh = safeValidate(engine, applied.doc, geo).filter((v) => !base.has(violationKey(v)));

  /**
   * Круг 16, п.3: палитра, в которой текст не читается, — негодный ответ модели, а не
   * замечание к макету. Чиним арифметикой, здесь же, без ещё одного вызова: цвета токенов
   * известны целиком. Только для оформления (setToken): в точечной правке человек красит
   * узел сам, и там за него решать нельзя (п.2).
   */
  if (intent === 'theme' && fresh.some((v) => v && v.code === 'low-contrast')) {
    const touched = new Set(out.ops
      .filter((o) => o && o.op === 'setToken' && /^colors\./.test(String(o.path)))
      .map((o) => String(o.path).slice('colors.'.length)));
    const cure = repairPalette(applied.doc, engine, touched);
    if (cure.ops.length) {
      let second = null;
      try { second = engine.applyOps(applied.doc, cure.ops); } catch { second = null; }
      if (second && !second.error && second.doc) {
        const geo2 = safeSolve(engine, second.doc);
        const fresh2 = safeValidate(engine, second.doc, geo2).filter((v) => !base.has(violationKey(v)));
        const wasBad = fresh.filter((v) => v && v.code === 'low-contrast').length;
        const nowBad = fresh2.filter((v) => v && v.code === 'low-contrast').length;
        /* Берём починку только если она убрала ВСЁ. Половинчатая палитра — это палитра,
         * которую не задумывал никто: и не модель, и не мы. Если арифметика не справилась,
         * ответ модели остаётся как есть и дальше работает обычный круг починки — у модели
         * есть чем чинить (вся палитра), а человек получает внятное предупреждение. */
        if (nowBad === 0 && wasBad > 0) {
          applied = second;
          geo = geo2;
          fresh = fresh2;
          out.ops = out.ops.concat(cure.ops);
          const named = cure.fixed
            .map((f) => `«${ruToken('colors', f.token)}» ${f.from} → ${f.to}`).join(', ');
          warn('В палитре от модели текст не читался на своём фоне — подобрал читаемые цвета сам:'
            + ` ${named}. Оттенок оставил как в ответе модели, поменял только светлоту;`
            + ' скажите другие цвета, если нужен другой вид');
        }
      }
    }
  }

  /* Круг 36 (SPEC §11.2): микроанимация дольше 600 мс — вязкая. Говорим об этом сами, словами про
   * слой и его скорость (и на движке без этого кода валидатора); дубль валидатора тогда не нужен. */
  const slowIds = slowMotionNotes(doc, applied.doc, out.ops, warn);
  if (slowIds.size) fresh = fresh.filter((v) => !(v && v.code === 'motion-slow' && (slowIds.has(v.nodeId || v.id) || slowIds.has('*'))));

  out.preview = { doc: applied.doc, geo };
  out.violations = fresh;
  out.problems = fresh.map((v) => formatViolation(v, applied.doc));
  out.blocking = fresh.filter(isBlocking).map((v) => formatViolation(v, applied.doc));

  /* Круг 3, п.1: правки могли примениться «в пустоту» — версия документа вырастет, а на экране
   * не изменится ничего. Раньше в таком случае человеку говорили «Готово». Теперь это факт:
   * модель получает один шанс исправиться, а человек — внятное предупреждение. */
  const docSame = visibleFingerprint(applied.doc) === visibleFingerprint(doc);
  const geoSame = geoFingerprint(engine, geo) === geoFingerprint(engine, baseGeo || safeSolve(engine, doc));
  /**
   * Круг 15, п.6: отличаем «правка не туда легла» от «менять нечего». Во втором случае все
   * операции — set, совпавший с текущим состоянием: документ не мог измениться, и починка
   * ничего не исправит. Раньше оба случая шли одним путём, и заведомо пустая правка стоила
   * человеку лишнего обращения к модели.
   *
   * Круг 16, п.1: считаем это ДО отпечатка документа — и решаем по нему тоже. «Сделай
   * заголовок сводки крупным» при уже стоящем {token:"display"} даёт set style="display":
   * значение то же, но ФОРМА другая, и сырой отпечаток документа честно расходится. Раньше
   * из-за этого сюда не доходили вовсе: человек получал «Готово» и главную строку «Стиль
   * текста display → крупный» рядом с припиской «эта правка ничего не меняет». Совпадение
   * геометрии остаётся обязательным: оно и есть доказательство, что на экране ничего не
   * сдвинулось, — а без доказательства объявлять правку пустой нельзя.
   */
  const idleSets = allSetsIdle(doc, out.ops, engine);
  if ((docSame || idleSets) && geoSame) {
    out.nothingChanged = true;
    if (idleSets) {
      out.nothingToChange = true;
      /* Что именно совпало, про КАЖДУЮ цель уже сказал patchToOps («…«fill» и так нет»,
       * «…«radius» уже «12»») — здесь только вывод, иначе человек читает одно и то же дважды. */
      warn(`Правка ни на что не повлияла: менять нечего — всё названное в макете уже так`
        + `${idleSets.length > 1 ? ` (все ${idleSets.length} правки)` : ''}.`
        + ' Скажите другое значение или другой слой');
    } else {
      warn('Правка ни на что не повлияла: в макете ничего не изменилось — скажите точнее, что и где поправить');
      // текст для МОДЕЛИ живёт только в blocking: из problems он попал бы человеку на экран
      // строкой «Проверка макета: выбери другие цели по id из выжимки», а это не его дело
      out.blocking.push('Операции применились, но документ не изменился: значения совпали с текущими'
        + ' или поля не подходят этим целям. Выбери другие цели (по id из выжимки) или другие поля.');
    }
  } else if (geoSame) {
    /* Круг 7, п.5: документ изменился, а геометрия — нет. Обе геометрии уже на руках, так что
     * молчать об этом нельзя: человеку сказали «Зазор 12 → 8 в «Шапка»», и он ищет разницу глазами. */
    /* Правку, совпавшую с текущим значением, объясняет своё предупреждение («уже «between»») —
     * сюда берём только те, где значение ДЕЙСТВИТЕЛЬНО поменялось: именно они и сбивают с толку.
     *
     * Круг 9, п.1: одного совпадения хэшей мало. Он считается по ПРЯМОУГОЛЬНИКАМ, а выключка
     * текста двигает строку внутри её бокса и в хэш не попадает. Поэтому «невидимо» объявляем
     * только там, где приложение может это доказать: путь целиком виден в геометрии (GEOMETRY_PATHS)
     * либо про него есть конкретная причина от textAlignIdle. Иначе молчим: сказать человеку
     * «прошло впустую» про сделанную работу — хуже, чем не сказать ничего. */
    /**
     * Круг 15, п.3: причина — или ДОКАЗАННАЯ, или никакая. Раньше на любом пути из
     * GEOMETRY_PATHS, для которого layoutIgnores ничего не нашла, подставлялась заготовка
     * «раскладка этого узла такое значение не использует» — и на «сделай список в две колонки»
     * приложение выдавало догадку за факт, называя неверный механизм. Возвращаем {why},
     * где why может быть null: сам ФАКТ («на экране не сдвинулось») мы видим по геометрии и
     * говорим о нём, а механизма без доказательства не называем.
     * null вместо объекта значит «про этот путь мы вообще ничего не знаем» — тогда молчим.
     */
    const idleFact = (o) => {
      const path = String(o.path);
      const node = nodeOf(applied.doc, o.id);
      // круг 11, п.4: заведомые пустышки (radius у эллипса, заливка у узла нулевого размера,
      // цвет у пустого текста) геометрию и не двигали — их ловим по фактам, а не по хэшу
      const dud = pointlessEdit(applied.doc, node, path, geo);
      if (dud) return { why: dud };
      if (GEOMETRY_PATHS.has(path)) return { why: layoutIgnores(applied.doc, node, path, geo) || null };
      if (path === 'align') {
        const t = textAlignIdle(applied.doc, node, geo);
        return t ? { why: t } : null;
      }
      return null;
    };
    const idle = out.ops.filter((o) => o && o.op === 'set'
      && !sameAsNow(currentValue(nodeOf(doc, o.id), String(o.path)), o.value, String(o.path), doc, engine)
      && idleFact(o));
    if (idle.length) {
      out.geometryUnchanged = idle.map((o) => ({ id: o.id, path: String(o.path) }));
      const first = idle[0];
      const why = (idleFact(first) || {}).why;
      const rest = idle.length - 1;
      const more = rest > 0
        ? ` Так же прошл${rest === 1 ? 'а' : 'и'} впустую ещё ${rest} правк${rest === 1 ? 'а' : rest < 5 ? 'и' : 'ок'}.`
        : '';
      warn(`В документе поменялось, а на экране — нет: ${nameOrId(applied.doc, first.id)}, ${ruPath(first.path)} —`
        + ` ${why || 'на экране это ничего не сдвинуло, а почему — сказать точно не могу'}.${more}`
        + ' Скажите иначе, что именно должно сдвинуться');
    }
  }
  return out;
}

/* ── Круг 27: итог против просьбы и описание сделанного ─────────────────────── */

/** «крупнее», «больше», «увеличь» / «мельче», «меньше», «уменьши». */
const RE_ASK_BIGGER = rx('((по)?крупнее|крупн(ым|ой|ее|ый|ая|ого)|увелич\\p{L}*|(по)?больше)', true);
const RE_ASK_SMALLER = rx('((по)?мельче|мелк(им|ой|ий|ая|ого)|уменьш\\p{L}*|(по)?меньше)', true);
const STYLE_SIZE_PATHS = new Set(['style', 'style.token', 'style.fontSize']);

/** Кегль текста: свой fontSize поверх стиля, иначе — кегль токена (по умолчанию — обычного текста). */
function textSizeOf(doc, node) {
  if (!node || node.type !== 'text') return undefined;
  const types = (doc && doc.tokens && doc.tokens.type) || {};
  const st = node.style;
  if (st && typeof st === 'object') {
    const own = Number(st.fontSize);
    if (Number.isFinite(own) && own > 0) return own;
    return typeSize(types, st.token || bodyTypeName(Object.keys(types)));
  }
  return typeSize(types, typeof st === 'string' && st ? st : bodyTypeName(Object.keys(types)));
}

/**
 * Итог правки против того, о чём просили (круг 27). Возвращает предупреждения с префиксом
 * «Проверка макета:» — оболочка показывает такое сообщение как замечание, а не как успех.
 *   • «сделай заголовок крупнее», а стиль поставлен мельче или тот же — так и говорим;
 *   • просили новую доску (размещение — новый экран), а созданное легло внутрь слоя.
 */
export function checkOutcome({ doc, after, ops, utterance = '', placement = null }) {
  const out = [];
  const list = asArray(ops);
  const said = String(utterance || '');
  const bigger = RE_ASK_BIGGER.test(said) && !RE_ASK_SMALLER.test(said);
  const smaller = RE_ASK_SMALLER.test(said) && !RE_ASK_BIGGER.test(said);
  if ((bigger || smaller) && after) {
    const seen = new Set();
    const rows = [];
    for (const op of list) {
      if (!op || op.op !== 'set' || !STYLE_SIZE_PATHS.has(String(op.path)) || seen.has(op.id)) continue;
      const was = nodeOf(doc, op.id);
      const now = nodeOf(after, op.id);
      if (!was || !now || was.type !== 'text') continue;
      seen.add(op.id);
      const a = textSizeOf(doc, was);
      const b = textSizeOf(after, now);
      if (a === undefined || b === undefined) continue;
      rows.push({ id: op.id, a, b });
    }
    const good = rows.filter((r) => (bigger ? r.b > r.a : r.b < r.a));
    const wrong = rows.filter((r) => (bigger ? r.b < r.a : r.b > r.a));
    const same = rows.filter((r) => r.b === r.a);
    const word = bigger ? 'крупнее' : 'мельче';
    if (wrong.length) {
      const r = wrong[0];
      out.push(`Проверка макета: просили ${word}, а ${nameOrId(after, r.id)} стал ${bigger ? 'мельче' : 'крупнее'}:`
        + ` ${Math.round(r.a)} → ${Math.round(r.b)} px${wrong.length > 1 ? ` (и ещё ${wrong.length - 1})` : ''}.`
        + ' Отмените правку или назовите стиль сами');
    } else if (rows.length && !good.length && same.length) {
      const r = same[0];
      out.push(`Проверка макета: просили ${word}, а размер ${nameOrId(after, r.id)} не изменился (${Math.round(r.a)} px).`
        + ' Назовите стиль или кегль сами');
    }
  }
  /* Круг 36: «сделай анимации медленнее/быстрее» — скорость по факту против просьбы. */
  const RE_SLOWER = /(?:^|[^\p{L}])(?:по)?(?:медленнее|неспешнее|плавнее|дольше)(?![\p{L}])/iu;
  const RE_FASTER = /(?:^|[^\p{L}])(?:по)?(?:быстрее|шустрее|резче|короче)(?![\p{L}])/iu;
  const aboutMotion = /анимац|наведени|нажати|переход|ховер|hover|скорост/iu.test(said);
  const slower = aboutMotion && RE_SLOWER.test(said) && !RE_FASTER.test(said);
  const faster = aboutMotion && RE_FASTER.test(said) && !RE_SLOWER.test(said);
  if ((slower || faster) && after) {
    const ids = [...new Set(list.filter((o) => o && o.op === 'set' && o.id && /^motion(\.|$)/.test(String(o.path))).map((o) => o.id))];
    const rows = ids.map((id) => ({ id, a: nodeMotionMs(doc, nodeOf(doc, id)), b: nodeMotionMs(after, nodeOf(after, id)) }))
      .filter((r) => nodeOf(after, r.id));
    const wrong = rows.filter((r) => (slower ? r.b < r.a : r.b > r.a));
    const same = rows.filter((r) => r.b === r.a);
    const word = slower ? 'медленнее' : 'быстрее';
    if (wrong.length) {
      const r = wrong[0];
      out.push(`Проверка макета: просили ${word}, а анимация ${nameOrId(after, r.id)} стала ${slower ? 'быстрее' : 'медленнее'}:`
        + ` ${Math.round(r.a)} → ${Math.round(r.b)} мс. Отмените правку или назовите скорость сами`);
    } else if (rows.length && same.length === rows.length) {
      const r = same[0];
      out.push(`Проверка макета: просили ${word}, а скорость анимации ${nameOrId(after, r.id)} не изменилась (${Math.round(r.a)} мс).`
        + ' Назовите скорость сами: «быстро», «обычно» или «медленно»');
    }
  }
  if (placement && placement.asArtboard && doc) {
    const born = new Set(list.filter((o) => o && o.op === 'create' && o.node && o.node.id).map((o) => o.node.id));
    const tops = list.filter((o) => o && o.op === 'create' && o.node && !born.has(o.node.parent));
    const inside = tops.find((o) => {
      const parent = nodeOf(doc, o.node.parent);
      return parent && parent.type !== 'page' && o.node.parent !== doc.root;
    });
    if (inside) {
      out.push(`Проверка макета: просили отдельную доску, а «${inside.node.name || 'новый слой'}» лёг внутрь`
        + ` ${nameOrId(doc, inside.node.parent)}. Отмените правку и скажите «собери … новой доской»`);
    }
  }
  return out;
}

/** Имя узла для описания: из документа до правки или из самой операции создания. */
function changeName(doc, born, id) {
  const n = nodeOf(doc, id) || born.get(id);
  if (!n) return 'слой';
  if (strOf(n.name)) return `«${cutText(n.name, 60)}»`;
  return nameOrId(doc, id);
}

/**
 * Круг 27: что сделано — словами по операциям, для подписи записи в истории (tx.title).
 * Раньше туда шёл заголовок плана модели («Ставлю стиль h1.») — пересказ намерения, а не
 * сделанного, и с внутренними именами. Здесь — те же слова, что в инспекторе:
 * «Стиль текста «Заголовок экрана»: «заголовок» → «крупный»», «Добавил «Экран тарифов» новой доской».
 */
export function describeChange(ops, doc, after = null, engine = null) {
  const list = asArray(ops).filter((o) => o && typeof o === 'object');
  if (!list.length || !doc) return '';
  const creates = list.filter((o) => o.op === 'create' && o.node && o.node.id);
  const born = new Map(creates.map((o) => [o.node.id, o.node]));
  const phrases = [];
  const tops = creates.filter((o) => !born.has(o.node.parent));
  if (tops.length) {
    const parentId = tops[0].node.parent;
    const parent = nodeOf(doc, parentId);
    const onCanvas = !parent || parent.type === 'page' || parentId === doc.root;
    const where = onCanvas ? (tops[0].node.type === 'frame' ? ' новой доской' : '') : ` в ${changeName(doc, born, parentId)}`;
    phrases.push(tops.length === 1
      ? `добавил ${changeName(doc, born, tops[0].node.id)}${where}`
      : `добавил ${tops.length} ${plural(tops.length, 'слой', 'слоя', 'слоёв')}${where}`);
  }
  const removes = list.filter((o) => o.op === 'remove' && o.id && !born.has(o.id));
  if (removes.length === 1) phrases.push(`удалил ${changeName(doc, born, removes[0].id)}`);
  else if (removes.length) phrases.push(`удалил ${removes.length} ${plural(removes.length, 'слой', 'слоя', 'слоёв')}`);
  const moves = list.filter((o) => o.op === 'move' && o.id && !born.has(o.id));
  if (moves.length === 1) {
    const to = moves[0].parent && moves[0].parent !== (nodeOf(doc, moves[0].id) || {}).parent ? ` в ${changeName(doc, born, moves[0].parent)}` : '';
    phrases.push(`перенёс ${changeName(doc, born, moves[0].id)}${to}`);
  } else if (moves.length) {
    phrases.push(`перенёс ${moves.length} ${plural(moves.length, 'слой', 'слоя', 'слоёв')}`);
  }
  // круг 36 (SPEC §11): состояния и движение — по слою одной фразой, «Наведение «X»: подъём 2 px, тень средняя, 120 мс»
  phrases.push(...motionChangePhrases(list.filter((o) => o.op === 'set' && o.id && !born.has(o.id)
    && /^(states|motion)(\.|$)/.test(String(o.path || ''))), doc, after, engine, born));
  // одинаковая правка у нескольких слоёв — одной строкой
  const groups = new Map();
  for (const op of list) {
    if (op.op !== 'set' || !op.id || born.has(op.id)) continue;
    const path = String(op.path || '');
    if (/^(states|motion)(\.|$)/.test(path)) continue;
    const node = nodeOf(doc, op.id);
    const cleared = !Object.prototype.hasOwnProperty.call(op, 'value') || op.value === undefined;
    let to;
    try { to = cleared ? '«не задано»' : valueWords(op.value, path, after || doc, engine); } catch { to = ''; }
    const key = `${path}|${to}`;
    const g = groups.get(key) || { path, to, ids: [], from: new Set() };
    g.ids.push(op.id);
    try { g.from.add(valueWords(node ? currentValue(node, path) : undefined, path, doc, engine)); } catch { /* без «было» */ }
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const what = ruPath(g.path);
    const from = g.from.size === 1 ? strOf([...g.from][0]) : '';
    const change = from && from !== g.to ? `${from} → ${g.to}` : g.to;
    phrases.push(g.ids.length === 1
      ? `${what} ${changeName(doc, born, g.ids[0])}: ${change}`
      : `${what} у ${g.ids.length} ${plural(g.ids.length, 'слоя', 'слоёв', 'слоёв')}: ${change}`);
  }
  const tokens = list.filter((o) => o.op === 'setToken');
  if (tokens.length) {
    const kinds = new Set(tokens.map((o) => String(o.path || '').split('.')[0]));
    const word = kinds.size === 1 && kinds.has('colors') ? 'палитра'
      : kinds.size === 1 && kinds.has('type') ? 'типографика'
        : kinds.size === 1 && (kinds.has('spacing') || kinds.has('radii')) ? (kinds.has('spacing') ? 'шкала отступов' : 'шкала скруглений')
          : kinds.size === 1 && kinds.has('motion') ? 'скорость анимаций'
            : kinds.size === 1 && kinds.has('shadow') ? 'тени'
              : 'оформление документа';
    phrases.push(`${word}: ${tokens.length} ${plural(tokens.length, 'правка', 'правки', 'правок')}`);
  }
  if (!phrases.length) return '';
  const rest = phrases.length - 2;
  const text = rest > 0
    ? `${phrases.slice(0, 2).join('; ')} и ещё ${rest} ${plural(rest, 'правка', 'правки', 'правок')}`
    : phrases.join('; ');
  return cutText(text.charAt(0).toUpperCase() + text.slice(1), 200);
}

/**
 * Круг 36 (SPEC §11.4): правки состояний и движения словами — по слою, а не по пути:
 * «наведение «Кнопка оплаты»: подъём 2 px, тень средняя, 120 мс», «нажатие у 3 слоёв: масштаб 97 %»,
 * «скорость анимации «Карточка»: 120 → 200 мс», «анимации «Кнопка»: сняты». Одинаковое у разных
 * слоёв — одной фразой, как и прочие правки.
 */
function motionChangePhrases(ops, doc, after, engine, born) {
  if (!ops.length) return [];
  const per = new Map();
  const rec = (id) => {
    if (!per.has(id)) per.set(id, { states: {}, clearedStates: false, clearedState: new Set(), motion: false, clearedMotion: false });
    return per.get(id);
  };
  const has = (o) => Object.prototype.hasOwnProperty.call(o, 'value') && o.value !== undefined;
  for (const o of ops) {
    const info = motionPathInfo(String(o.path));
    if (!info || info.bad) continue;
    const r = rec(o.id);
    if (info.kind === 'states') {
      if (!has(o)) { r.clearedStates = true; continue; }
      for (const st of STATE_NAMES) if (o.value && o.value[st]) r.states[st] = { ...(r.states[st] || {}), ...o.value[st] };
    } else if (info.kind === 'state') {
      if (!has(o)) { r.clearedState.add(info.state); continue; }
      r.states[info.state] = { ...(r.states[info.state] || {}), ...(o.value || {}) };
    } else if (info.kind === 'stateField') {
      const box = r.states[info.state] || (r.states[info.state] = {});
      box[info.field] = has(o) ? o.value : UNSET;
    } else if (info.kind === 'motion' || info.kind === 'motionField') {
      if (!has(o) && info.kind === 'motion') r.clearedMotion = true;
      else r.motion = true;
    }
  }
  const out = [];
  const groups = new Map();
  const add = (label, content, id) => {
    const key = `${label}|${content}`;
    const g = groups.get(key) || { label, content, ids: [] };
    if (!g.ids.includes(id)) g.ids.push(id);
    groups.set(key, g);
  };
  const final = after || doc;
  for (const [id, r] of per) {
    const nodeBefore = nodeOf(doc, id);
    const nodeAfter = nodeOf(final, id) || nodeBefore;
    if (r.clearedStates && !Object.keys(r.states).length) {
      add('анимации', r.clearedMotion || !hasMotion(nodeAfter) ? 'сняты' : 'состояния сняты', id);
      continue;
    }
    let msShown = false;
    const ms = () => {
      if (msShown) return '';
      msShown = true;
      const m = nodeAfter && nodeAfter.motion && typeof nodeAfter.motion === 'object' ? nodeAfter.motion : {};
      const bits = [durationWords(final, m.duration === undefined ? 'motion.base' : m.duration)];
      if (r.motion && m.easing !== undefined && m.easing !== 'standard') bits.push(EASING_RU[m.easing] || wordOf(m.easing));
      if (r.motion && m.follow === 'parent') bits.push('вместе с родителем');
      return bits.join(', ');
    };
    for (const st of STATE_NAMES) {
      if (r.clearedState.has(st) && !r.states[st]) { add(STATE_RU[st].nom, 'снято', id); continue; }
      const patch = r.states[st];
      if (!patch) continue;
      const parts = STATE_FIELDS.filter((f) => patch[f] !== undefined)
        .map((f) => (patch[f] === UNSET ? `без ${STATE_FIELD_RU_GEN[f]}` : stateFieldWords(f, patch[f], final, engine)));
      const tail = ms();
      add(STATE_RU[st].nom, [...parts, tail].filter(Boolean).join(', '), id);
    }
    if (!msShown && (r.motion || r.clearedMotion)) {
      const was = nodeMotionMs(doc, nodeBefore);
      const now = nodeMotionMs(final, nodeAfter);
      const m = nodeAfter && nodeAfter.motion && typeof nodeAfter.motion === 'object' ? nodeAfter.motion : {};
      if (was !== now) add('скорость анимации', `${Math.round(was)} → ${Math.round(now)} мс`, id);
      else if (r.clearedMotion) add('движение', 'по умолчанию', id);
      else add('анимация', motionWords(m, final) || `${Math.round(now)} мс`, id);
    }
  }
  for (const g of groups.values()) {
    out.push(g.ids.length === 1
      ? `${g.label} ${changeName(doc, born, g.ids[0])}: ${g.content}`
      : `${g.label} у ${g.ids.length} ${plural(g.ids.length, 'слоя', 'слоёв', 'слоёв')}: ${g.content}`);
  }
  return out;
}

/** Ключ нарушения: чтобы не вменять агенту то, что было в документе до него. */
function violationKey(v) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return String(v);
  return `${v.code || ''}|${v.nodeId || v.id || ''}|${v.message || ''}`;
}

/**
 * Что считать поводом для починки. Замечание уровня «warn»/«info» — не повод,
 * НО низкий контраст повод (п.17): тёмная тема с контрастом 1.10:1 при норме 3:1 —
 * это нечитаемый макет, а не придирка. Если починить не вышло, результат всё равно
 * применяется, а человек получает внятное предупреждение с именем слоя.
 */
function isBlocking(v) {
  if (typeof v !== 'object' || !v) return true;
  // Круг 3, п.2: нулевой размер — это НЕВИДИМЫЙ макет (карточки 440×0), а не придирка.
  // Как и низкий контраст, он обязан запускать попытку починки; если не помогло —
  // результат применяется, но человек получает предупреждение с именем слоя.
  if (v.code === 'low-contrast' || v.code === 'zero-size') return true;
  if (!v.severity) return true;
  return v.severity !== 'warn' && v.severity !== 'info';
}

/** Слова, которыми просят именно ЦВЕТ. Закрытый словарь: гадать тут нельзя. */
const RE_COLOR_ASK = [
  rx('перекрас'), rx('покрас'), rx('закрас'), rx('раскрас'), rx('цвет'), rx('заливк'),
  rx('затемн'), rx('осветл'), rx('фон', true), rx('#[0-9a-f]{3,8}'),
  // «сделай кнопку темнее» — тоже просьба о цвете, и низкий контраст после неё — следствие
  rx('(по)?(темнее|светлее|ярче|бледнее|контрастнее)', true),
];

/**
 * Основы названий цветов: «зелёной», «зелёную», «зелёным» — это всё «зелёный», а COLOR_WORDS
 * знает только словарную форму. Строится один раз: словарь цветов не меняется.
 */
const COLOR_STEMS = new Set(Object.keys(COLOR_WORDS).filter((k) => COLOR_WORDS[k]).map((k) => stemRu(k)));

/** Назвал ли человек цвет — словом в любом падеже, шестнадцатеричным кодом или именем токена. */
/**
 * Круг 16, п.2: русские слова, которыми человек называет ЦВЕТОВОЙ ТОКЕН этого документа.
 * «Все пункты сделай акцентными» — прямая просьба о цвете: «акцент» в этом документе и есть
 * имя цвета (colors.accent). Раньше mentionsColor знала только словарные названия цветов
 * («зелёный») и ЛАТИНСКИЕ имена токенов, поэтому «акцентными» не подходило ни туда, ни сюда —
 * и агент шёл в лишний круг починки на КАЖДОЙ такой команде: 3 вызова модели вместо 2 и
 * служебное «Починка не помогла».
 *
 * Словарь закрытый и НАРОЧНО узкий: сюда попадают только слова, которые по-русски значат
 * именно цвет. Русские имена остальных токенов — «карточка» (surface), «линия» (line),
 * «текст» (text), «холст» (canvas), «успех» (good) — словами о цвете НЕ являются, и
 * «сделай карточку компактнее» поблажку «человек сам просил этот цвет» получать не должно.
 */
const TOKEN_COLOR_STEMS = {
  accent: ['акцент'], accentSoft: ['акцент'], accentInk: ['акцент'], onAccent: ['акцент'],
  muted: ['приглушен', 'блекл', 'тускл'],
};

/** Назвал ли человек цвет — словом в любом падеже, шестнадцатеричным кодом или именем токена. */
function mentionsColor(utterance, doc) {
  const raw = String(utterance == null ? '' : utterance);
  if (anyMatch(RE_COLOR_ASK, raw)) return true;
  const words = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const colors = (doc && doc.tokens && doc.tokens.colors) || {};
  if (words.some((w) => COLOR_STEMS.has(stemRu(w))
    || Object.prototype.hasOwnProperty.call(colors, w))) return true;
  /* Токен должен и правда быть в палитре ЭТОГО документа: иначе модель не могла им покрасить. */
  const stems = words.map(stemRu).filter((w) => w.length >= 4);
  if (!stems.length) return false;
  return Object.keys(TOKEN_COLOR_STEMS).some((token) =>
    Object.prototype.hasOwnProperty.call(colors, token)
    && TOKEN_COLOR_STEMS[token].some((base) => stems.some((w) => wordsAlike(w, base))));
}

/**
 * Круг 15, п.5: нарушение — ПРЯМОЕ следствие того, о чём просил человек.
 *
 * «Сделай кнопку зелёной» → белая подпись на зелёном даёт контраст 2.1:1, валидатор честно
 * это называет, и агент шёл в починку: лишний вызов модели на КАЖДОЙ цветовой команде (на
 * LM Studio — лишние секунды), а чинить нечего. Либо модель послушается человека и оставит
 * зелёный (нарушение остаётся, в ленту падает служебное «Починка не помогла»), либо ослушается
 * и перекрасит кнопку в другой цвет — это хуже: человек просил зелёную.
 *
 * Как отличаем следствие от промаха. Три условия сразу, все по фактам, без угадывания:
 *   • ВСЕ вменяемые агенту блокирующие нарушения — про контраст (остальные коды к просьбе о
 *     цвете не относятся и чинить их по-прежнему надо);
 *   • человек в этой самой реплике назвал цвет («зелёной», «перекрась», «#2ecc71», имя токена);
 *   • каждое нарушение сидит на узле, цвет которого правила ИМЕННО ЭТА команда — сам узел или
 *     его текстовый потомок (контраст валидатор относит к тексту, а заливку человек просит у
 *     кнопки-фрейма).
 * Оформление (setToken) сюда не попадает: там у модели есть чем чинить — вся палитра.
 */
function askedForViolations(utterance, violations, ops, doc) {
  const list = asArray(violations);
  if (!list.length) return false;
  if (!list.every((v) => v && typeof v === 'object' && v.code === 'low-contrast')) return false;
  if (!mentionsColor(utterance, doc)) return false;
  const painted = new Set();
  const values = new Set();
  for (const o of asArray(ops)) {
    if (!o || o.op !== 'set' || !o.id) continue;
    const p = String(o.path);
    if (p !== 'fill' && p !== 'color' && p !== 'stroke') continue;
    painted.add(o.id);
    values.add(colorRef(o.value) || String(o.value));
    for (const t of textDescendants(doc, o.id)) painted.add(t);
  }
  if (!painted.size) return false;
  /**
   * Круг 16, п.2: четвёртое условие — модель не покрасила БОЛЬШЕ разных цветов, чем человек
   * назвал. «Сделай пункты акцентными», а модель заодно по своей инициативе сделала подпись
   * кнопки почти белой: один из двух цветов человек не просил, и низкий контраст на нём —
   * промах модели, а не следствие просьбы. Считаем именно РАЗНЫЕ значения: пять пунктов
   * одним «accent» — это один цвет, и это то, о чём просили.
   *
   * Просьба о цвете БЕЗ названного цвета («сделай кнопку темнее», «перекрась») даёт ноль
   * названных цветов — тогда допускаем один: модель сама выбирает оттенок, это её работа.
   */
  const allowed = Math.max(1, namedColorCount(utterance, doc));
  if (values.size > allowed) return false;
  return list.every((v) => painted.has(v.nodeId || v.id));
}

/**
 * Сколько РАЗНЫХ цветов человек назвал в реплике: «сделай кнопку зелёной» — один,
 * «кнопку зелёной, а подпись белой» — два, «сделай кнопку темнее» — ноль (цвет не назван).
 */
function namedColorCount(utterance, doc) {
  const words = String(utterance == null ? '' : utterance).toLowerCase().match(/[\p{L}\p{N}#]+/gu) || [];
  const colors = (doc && doc.tokens && doc.tokens.colors) || {};
  const out = new Set();
  for (const w of words) {
    if (/^#[0-9a-f]{3,8}$/.test(w)) { out.add(hexNorm(w)); continue; }
    if (Object.prototype.hasOwnProperty.call(colors, w)) { out.add(w); continue; }
    const stem = stemRu(w);
    const dict = Object.keys(COLOR_WORDS).find((k) => COLOR_WORDS[k] && stemRu(k) === stem);
    if (dict) { out.add(COLOR_WORDS[dict]); continue; }
    const token = Object.keys(TOKEN_COLOR_STEMS).find((t) =>
      Object.prototype.hasOwnProperty.call(colors, t)
      && TOKEN_COLOR_STEMS[t].some((base) => wordsAlike(stem, base)));
    if (token) out.add(token);
  }
  return out.size;
}

/** Ключи нарушений, которые были в документе ДО команды: их агенту не вменяем. */
function baselineViolations(list) {
  const set = new Set();
  for (const v of (Array.isArray(list) ? list : [])) set.add(violationKey(v));
  return set;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 10. Варианты
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * n вариантов одной команды (п.12, п.13).
 *
 * Варианты отличаются осями вариации (композиция, типографика, выразительность), температурой
 * (0.15 / 0.6 / 1) и умолчаниями персоны — и для дерева, и для патча.
 *
 * Круг 13, п.8: СКОЛЬКО ЭТО СТОИТ. Раньше каждый вариант считал СВОЙ план и ждал предыдущего
 * («сделай иначе, чем варианты выше»), то есть три варианта = шесть вызовов модели ПОДРЯД.
 * На LM Studio (та самая сборка с голосом) это минуты ожидания, за которые человек успевает
 * отменить команду. Две поправки, обе без потери различия вариантов:
 *   • план считается ОДИН раз на все варианты и прямо просит не фиксировать значения — их
 *     выбирает каждый вариант сам (1 вызов вместо n);
 *   • генерации идут ПАРАЛЛЕЛЬНО, а «сделай иначе, чем предыдущие» заменено на заранее
 *     разведённые оси: оси соседей известны из PERSONAS до всякого вызова модели.
 * Итого 1 + n вызовов и ровно два последовательных обращения вместо 2n.
 * Общий план ещё и отвечает сразу за всех, когда вариантов не нужно вовсе (переспрос, отказ).
 */
async function runVariantsCore(options = {}) {
  const {
    doc, selection, utterance, provider, n = 3, onStage, signal,
    engine: engineOpt, personas = PERSONAS, activeArtboardId = null, history = null, geo = null, modelTier,
    selectionBy = 'human',
    // круг 13, п.8: можно вернуться к плану на каждый вариант — но это вдвое больше вызовов
    sharedPlan = true,
  } = options;
  const count = Math.max(1, Math.min(6, Number(n) || 3));
  /* Если сюда прилетела сама просьба о вариантах («три варианта: сделай шапку компактнее»),
   * гоняем модель по КОМАНДЕ, а не по просьбе: иначе каждый вариант получит план про варианты. */
  const wantVariants = recognizeVariants(utterance, { doc });
  const task = wantVariants && wantVariants.variantsOf ? wantVariants.variantsOf : utterance;

  /* Отмена вариантами не бывает: «верни как было» — это одно действие оболочки, а не три
   * разных макета. Иначе три варианта ушли бы в модель за одним и тем же откатом. */
  const action = recognizeAction(utterance);
  if (action) {
    const title = action === 'undo' ? 'Отменяю последнюю правку' : 'Возвращаю отменённую правку';
    return [{
      key: action, label: title, description: 'Это делает редактор, без модели.',
      ops: [], action, preview: null,
      plan: { intent: action, title, summary: 'Откат не требует вариантов.', steps: [title], targets: [] },
      warnings: [], usage: { calls: 0, ms: 0 }, stages: [],
    }];
  }

  /**
   * Круг 19, п.4-5: у «сделай из этого компонент» и «отсоедини экземпляр» вариантов не бывает —
   * это одно механическое действие, и три его копии были бы одинаковы. Гоним ОДИН прогон: он
   * распознает просьбу локально и не позовёт модель ни разу (иначе внутри вариантов локальные
   * намерения выключены, и три варианта ушли бы в модель за тем, что мы и так умеем сами).
   */
  if (recognizeComponentIntent(task)) {
    const one = await runCommand({
      doc, selection, utterance: task, provider, signal, engine: engineOpt,
      activeArtboardId, history, geo, modelTier, selectionBy, onStage,
    });
    return [{
      key: one.local || 'component', label: (one.plan && one.plan.title) || 'Компонент',
      description: (one.plan && one.plan.summary) || 'Это делает редактор, без модели.',
      ops: one.ops || [], preview: one.preview, plan: one.plan,
      ...(one.local ? { local: one.local } : {}),
      ...(one.clarify ? { clarify: one.clarify } : {}),
      ...(one.clarifyOptions ? { clarifyOptions: one.clarifyOptions } : {}),
      ...(one.cannot ? { cannot: one.cannot } : {}),
      ...(one.error ? { error: one.error } : {}),
      warnings: one.warnings || [], usage: one.usage, stages: one.stages || [],
    }];
  }

  const picked = Array.from({ length: count }, (_, i) => personas[i % personas.length]);

  /* — Общий план: один вызов вместо n (круг 13, п.8) — */
  let shared = null;
  let head = null;
  if (sharedPlan && count > 1) {
    head = await runCommand({
      doc, selection, utterance: task, provider, signal, engine: engineOpt,
      insideVariants: true, planOnly: true, variantsAhead: count,
      activeArtboardId, history, geo, modelTier, selectionBy,
      temperature: 0,
      // стадии общего плана помечены как общие: у них нет номера варианта, потому что их нет
      stagePrefix: `План для всех ${count} вариантов · `,
      stageExtra: { variantCount: count, variantShared: true },
      onStage,
    });
    /**
     * Переспрос, отказ и сбой — ответ один на всех: три одинаковых «не разобрал команду»
     * человеку не нужны, а ещё 2n−1 вызовов модели ради них — тем более. Оболочка эти поля
     * уже разбирает (clarify / cannot / error), и одноэлементного списка ей достаточно.
     */
    if (head.error || head.clarify || head.cannot || head.action) {
      return [{
        key: 'plan', label: (head.plan && head.plan.title) || 'Разбор команды',
        description: (head.plan && head.plan.summary) || '',
        ops: [], preview: head.preview, plan: head.plan,
        ...(head.clarify ? { clarify: head.clarify } : {}),
        ...(head.clarifyOptions ? { clarifyOptions: head.clarifyOptions } : {}),
        ...(head.cannot ? { cannot: head.cannot } : {}),
        ...(head.action ? { action: head.action } : {}),
        ...(head.error ? { error: head.error } : {}),
        warnings: head.warnings || [], usage: head.usage, stages: head.stages || [],
      }];
    }
    shared = head.plan;
    /* Вопрос о макете вариантов не имеет: ответ один. Раньше на него уходило 6 вызовов, теперь 2. */
    if (head.intent === 'ask') picked.length = 1;
  }

  /* — Генерации: параллельно, с заранее разведёнными осями — */
  const total = picked.length;                     // для вопроса вариант остаётся один
  const axesOf = (i) => ({ index: i + 1, axes: picked[i].axes });
  const results = await Promise.all(picked.map((persona, i) => {
    const index = i + 1;
    const prefix = total > 1 ? `Вариант ${index} из ${total} · ` : '';
    const stageExtra = { variant: persona.key, variantIndex: index, variantCount: total };
    if (typeof onStage === 'function') {
      try {
        onStage({
          stage: 'variant', label: `${prefix}${persona.label}`, text: `${prefix}${persona.label}`,
          detail: persona.description, ...stageExtra,
        });
      } catch { /* интерфейс не должен ронять конвейер */ }
    }
    const others = picked.map((_, j) => j).filter((j) => j !== i).map(axesOf);
    return runCommand({
      doc, selection, utterance: task, provider, signal, engine: engineOpt,
      insideVariants: true,
      // общий план приходит готовым: стадия «Планирую» модель уже не зовёт
      ...(shared ? { plan: { ...shared, steps: [...(shared.steps || [])], targets: [...(shared.targets || [])] } } : {}),
      persona, activeArtboardId, history, geo, modelTier, selectionBy,
      temperature: persona.temperature,
      variantHint: total > 1 ? variantInstruction(persona, index, total, [], others) : '',
      stagePrefix: prefix,
      stageExtra,
      onStage: onStage ? (s) => onStage({ ...s, ...stageExtra }) : undefined,
    });
  }));

  // расход общего плана приписываем первому варианту: иначе он исчезает из отчёта о стоимости
  if (head && head.usage && results[0] && results[0].usage) {
    for (const k of Object.keys(head.usage)) {
      if (typeof head.usage[k] === 'number') results[0].usage[k] = (results[0].usage[k] || 0) + head.usage[k];
    }
    results[0].stages = [...(head.stages || []), ...(results[0].stages || [])];
  }

  return results.map((res, i) => ({
    key: picked[i].key,
    label: picked[i].label,
    description: picked[i].description,
    ops: res.ops,
    /**
     * Круг 16, п.4: чем варианты ОТЛИЧАЮТСЯ. Оболочка сводила их по хэшу геометрии, и три
     * варианта, разошедшиеся скруглением, заливкой, обводкой или прозрачностью, схлопывались
     * в один («Ещё 2 решения совпали с показанными») — хотя документы у них разные. Слепок
     * считается по видимому состоянию ДОКУМЕНТА, а не по прямоугольникам, поэтому различает и
     * то, что геометрию не двигает. Замер на четырёх командах: операции различались 3/3 во всех
     * четырёх, документы — 3/3, геометрия — 3/3 в трёх и 1/3 на «поиграй со скруглением».
     */
    fingerprint: res.preview && res.preview.doc ? shortHash(visibleFingerprint(res.preview.doc)) : null,
    preview: res.preview,
    plan: res.plan,
    // круг 27: что сделано — словами, для подписи записи в истории
    ...(res.changeSummary ? { changeSummary: res.changeSummary } : {}),
    answer: res.answer,
    clarify: res.clarify,
    // круг 18: готовые ответы доходят и до варианта — иначе переспрос там снова стал бы тупиком
    ...(res.clarifyOptions ? { clarifyOptions: res.clarifyOptions } : {}),
    // круг 9, п.4: отказ доходит и до варианта — иначе вариант выглядел бы пустым без объяснения
    ...(res.cannot ? { cannot: res.cannot } : {}),
    warnings: res.warnings,
    usage: res.usage,
    stages: res.stages,
    ...(res.action ? { action: res.action } : {}),
    ...(res.error ? { error: res.error } : {}),
  }));
}

export default {
  makeProvider, runCommand, runVariants, libraryDocOf, externalLibraryPlan, SCHEMAS, PROMPTS, PERSONAS,
  classifyUtterance, describeDoc, describeTokens, describeHistory, extractJson, downgradeSchema,
  resolveScope, resolveRef, resolveRefs, refCandidates, colorFromWord, loadEngine, BrainError,
  // круг 3: локальные действия оболочки, групповые правки, адресация по типу узла, проверки
  recognizeAction, looksGroupWide, findInsertTarget, adjustSetPath, describeViolations,
  textDescendants, stemRu, safeSrc, clampPx, fmtDuration,
  // круг 11: двусмысленная отмена — переспрос, а не догадка
  recognizeUndoDoubt,
  // круг 5: варианты голосом, колонки одноимённых слоёв, порядок предупреждений
  recognizeVariants, looksUniformColumn, sortWarnings, warningRank, MAX_CHARS,
  // круг 7: честная подстановка значений и догадка о намерении по названным слоям
  coerceValue, normalizeTree, mentionsExistingLayer, variantInstruction,
  // круг 9: единый разбор чисел с единицами («8px», «1rem», «2,5»)
  parsePx, MAX_PX,
  // круг 13: «снять свойство» — такое же значение, как любое другое
  UNSET, looksCleared, CLEARABLE_PATHS,
  // круг 16: человеческие названия полей, токенов и значений — общий словарь с оболочкой
  PATH_RU, COLOR_TOKEN_RU, TYPE_TOKEN_RU, ruPath, ruPathGen, ruToken, ruEnum, factOnly,
  // круг 16, п.1: «поле останется байт в байт?» — зеркало core.keepFieldForm, под тестом
  sameAsNow,
};
