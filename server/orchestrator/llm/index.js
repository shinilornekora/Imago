/**
 * LLM (SPEC §10.1, стрелки 8/9): клиент к модели.
 *
 *   LLM_KIND      openai (по умолчанию; LM Studio, vLLM, Ollama, OpenRouter…) | anthropic
 *   LLM_BASE_URL  адрес API: http://host:1234/v1 — для openai; https://api.anthropic.com — для anthropic
 *   LLM_MODEL     имя модели (openai: без него берётся первая из /models)
 *   LLM_API_KEY   ключ; для openai — `Authorization: Bearer`, для anthropic — `x-api-key`
 *
 * Адрес собирается через `URL`: суффикс (`chat/completions`, `models`, `v1/messages`)
 * дописывается к ПУТИ, query базы сохраняется после него. Учётные данные в адресе
 * (`https://user:pass@host/v1`) из адреса убираются и уходят заголовком `Authorization`
 * (`Basic`, если есть пароль; `Bearer <user>` — если только имя). Ключ и userinfo никогда
 * не попадают в ответы, ошибки, трассы и логи: всё, что выходит наружу, проходит `redact`.
 *
 * Провайдер — `makeProvider` из brain.js (тот же, что работал в браузере: повторы,
 * бюджет, разбор JSON). Для openai ему отдаётся адрес без учётных данных и query и
 * обёртка fetch, которая собирает настоящий адрес и ставит заголовок. Для anthropic —
 * провайдер вида `claude` с самописной способностью `sample.json` поверх Messages API.
 */

import {
  makeProvider, parseModelJson, BrainError, MODEL_REJECTED, cutText,
  MODEL_BODY_MAX_BYTES, readBodyCapped, parseBodyJson, badResponse, modelDataProblem, cleanModelId,
} from '../../../src/brain.js';
import { LLM_HEALTH_CACHE_MS, LLM_HEALTH_TIMEOUT_MS } from '../limits.js';

/** Разобрать адрес модели: публичная часть, query, заголовок авторизации, секреты для redact. */
export function parseLlmUrl(raw) {
  const u = new URL(String(raw));
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('LLM_BASE_URL: нужен http(s)');
  const secrets = [];
  let auth = null;
  if (u.username || u.password) {
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    if (pass) {
      auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      secrets.push(pass, u.password, auth.slice(6));
      if (user) secrets.push(`${user}:${pass}`, `${u.username}:${u.password}`);
    } else {
      auth = `Bearer ${user}`;
      secrets.push(user, u.username);
    }
  }
  // query тоже может нести ключ (?api-key=…, ?key=…): наружу — только имена параметров
  for (const [, v] of u.searchParams) if (v && v.length >= 6) secrets.push(v);
  u.username = '';
  u.password = '';
  const query = u.search;
  u.search = '';
  u.hash = '';
  const publicBase = u.href.replace(/\/+$/, '');
  return { publicBase, query, auth, secrets };
}

/** Длина куска секрета, который redact узнаёт в тексте (SPEC §10.1: ключ не уходит наружу). */
export const SECRET_GRAM = 8;

/**
 * Все куски длиной SECRET_GRAM из секретов и из их base64/base64url — во всех трёх
 * выравниваниях (base64 куска ключа совпадает с куском base64 ключа, сдвинутого на
 * 0, 1 или 2 байта). Секрет короче SECRET_GRAM узнаётся только целиком.
 * @param {string[]} secrets
 * @returns {Set<string>}
 */
export function secretGrams(secrets) {
  const out = new Set();
  const add = (str) => {
    for (let i = 0; i + SECRET_GRAM <= str.length; i++) out.add(str.slice(i, i + SECRET_GRAM));
  };
  for (const sec of secrets || []) {
    if (typeof sec !== 'string' || sec.length < SECRET_GRAM) continue;
    add(sec);
    const bytes = Buffer.from(sec, 'utf8');
    for (let k = 0; k < 3 && k < bytes.length; k++) {
      const b64 = bytes.subarray(k).toString('base64').replace(/=+$/, '');
      // хвост base64 зависит от того, что идёт за секретом, — последние 3 знака не берём
      const body = b64.slice(0, Math.max(0, b64.length - 3));
      add(body);
      add(body.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return out;
}

/**
 * Каждое окно из SECRET_GRAM знаков, совпавшее с куском секрета, закрывается; соседние
 * и перекрытые окна сливаются в одну замену `***`.
 * @param {string} s @param {Set<string>} grams
 * @returns {string}
 */
export function maskGrams(s, grams) {
  if (!grams || !grams.size || s.length < SECRET_GRAM) return s;
  let out = '';
  let from = 0;      // начало ещё не выведенного
  let end = -1;      // конец текущей закрываемой области
  let start = -1;
  for (let i = 0; i + SECRET_GRAM <= s.length; i++) {
    if (!grams.has(s.slice(i, i + SECRET_GRAM))) continue;
    if (start >= 0 && i <= end) {
      end = i + SECRET_GRAM;
    } else {
      if (start >= 0) { out += s.slice(from, start) + '***'; from = end; }
      start = i;
      end = i + SECRET_GRAM;
    }
  }
  if (start < 0) return s;
  out += s.slice(from, start) + '***';
  return out + s.slice(end);
}

/** База + суффикс пути (+ query базы) — всегда через URL, а не склейкой строк. */
export function endpoint(publicBase, query, suffix) {
  const u = new URL(publicBase);
  u.pathname = u.pathname.replace(/\/+$/, '') + '/' + String(suffix).replace(/^\/+/, '');
  u.search = query || '';
  return u;
}

/**
 * @param {{kind?: string, baseUrl?: string, model?: string, apiKey?: string, fetch?: typeof fetch, timeout?: number, log?: object}} cfg
 */
export function createLlm(cfg = {}) {
  const fetchImpl = cfg.fetch || ((...a) => globalThis.fetch(...a));
  const kind = String(cfg.kind || 'openai').toLowerCase();
  const raw = cfg.baseUrl ? String(cfg.baseUrl).trim() : '';
  const apiKey = cfg.apiKey ? String(cfg.apiKey) : '';
  let configured = false;
  let parsed = null;
  let invalid = '';
  const secrets = [];
  if (apiKey) secrets.push(apiKey);

  if (raw || kind === 'anthropic') {
    try {
      parsed = parseLlmUrl(raw || 'https://api.anthropic.com');
      secrets.push(...parsed.secrets);
      configured = kind !== 'anthropic' || !!apiKey || !!parsed.auth;
    } catch (e) {
      invalid = 'LLM_BASE_URL не разобрался как адрес';
    }
  }
  if (kind !== 'openai' && kind !== 'anthropic' && kind !== 'lmstudio') {
    configured = false;
    invalid = `LLM_KIND=${kind}: поддерживаются openai и anthropic`;
  }
  // самые длинные первыми: иначе замена короткой части оставит хвост длинной
  const secretList = [...new Set(secrets.filter((s) => s && s.length >= 4))].sort((a, b) => b.length - a.length);
  const grams = secretGrams(secretList);

  /** Вычистить секреты из любой строки, уходящей наружу. */
  function redact(text) {
    let s = String(text == null ? '' : text);
    for (const sec of secretList) s = s.split(sec).join('***');
    // круг 25: и куски ключа от 8 знаков (сервер модели цитирует ключ обрезанным:
    // «Incorrect API key provided: sk-abc…xyz»), и его base64 (Basic-заголовок в эхе)
    s = maskGrams(s, grams);
    // на всякий случай — любые userinfo в адресах
    s = s.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@');
    return s;
  }

  const authHeaders = () => {
    if (kind === 'anthropic') {
      const key = apiKey || (parsed && parsed.auth && parsed.auth.startsWith('Bearer ') ? parsed.auth.slice(7) : '');
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    }
    if (apiKey) return { Authorization: `Bearer ${apiKey}` };
    if (parsed && parsed.auth) return { Authorization: parsed.auth };
    return {};
  };

  /** fetch для провайдера brain: адрес без секретов → настоящий адрес + заголовок. */
  const providerFetch = (url, init = {}) => {
    const s = String(url);
    const suffix = s.startsWith(parsed.publicBase) ? s.slice(parsed.publicBase.length) : new URL(s).pathname;
    const real = endpoint(parsed.publicBase, parsed.query, suffix);
    return fetchImpl(real, { ...init, headers: { ...(init.headers || {}), ...authHeaders() } });
  };

  let model = cfg.model || '';
  let provider = null;
  // круг 31: потолок тела ответа модели (LLM_MAX_BODY_BYTES), сверх — llm_bad_response
  const maxBodyBytes = cfg.maxBodyBytes > 0 ? cfg.maxBodyBytes : MODEL_BODY_MAX_BYTES;
  if (configured && kind === 'anthropic') {
    provider = makeProvider({
      kind: 'claude', name: 'Anthropic', timeout: cfg.timeout,
      // круг 47: Messages API принимает картинки (LLM_VISION=0 — не слать)
      vision: cfg.vision !== false,
      sample: { json: (turns, o) => anthropicJson(turns, o) },
    });
  } else if (configured) {
    provider = makeProvider({
      kind: 'openai', name: 'OpenAI-совместимая модель', baseUrl: parsed.publicBase,
      model: model || undefined, fetch: providerFetch, timeout: cfg.timeout, maxBodyBytes,
      // круг 47: видит ли модель картинки — только по LLM_VISION=1: текстовые модели LM Studio/Ollama
      // картинку чаще молча выбрасывают, чем отвергают, и «узнать по отказу» нельзя
      vision: cfg.vision === true,
    });
  }

  async function anthropicJson(turns, o = {}) {
    const base = new URL(parsed.publicBase);
    const suffix = /\/v1$/.test(base.pathname.replace(/\/+$/, '')) ? 'messages' : 'v1/messages';
    let res;
    try {
      res = await fetchImpl(endpoint(parsed.publicBase, parsed.query, suffix), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-5', max_tokens: 4096, messages: turns }),
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal && o.signal.aborted) throw new BrainError('cancelled', 'Команда отменена');
      throw new BrainError('network', 'Нет связи с моделью');
    }
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) throw new BrainError('network', `Сервер модели ответил ${res.status}`, { retryable: true });
      // круг 29 (J5): человеку — нейтральные слова, тело отказа — полем detail (в лог)
      const text = await readBodyCapped(res, 64 * 1024).catch(() => '');
      throw new BrainError('model', MODEL_REJECTED, { status: res.status, detail: cutText(text, 300) });
    }
    // круг 31: тело — потоком с потолком; не JSON — llm_bad_response (не «нет связи»)
    const body = parseBodyJson(await readBodyCapped(res, maxBodyBytes));
    const text = body && Array.isArray(body.content)
      ? body.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('')
      : '';
    const data = parseModelJson(text);
    const bad = modelDataProblem(data);
    if (bad) throw badResponse(`Ответ модели не той формы (${bad}) — попробуйте ещё раз`);
    return data;
  }

  /** Проверка здоровья с кешем: GET {base}/models. */
  let healthCache = null;
  async function health({ fresh = false } = {}) {
    if (!configured) return { llm: 'unconfigured', ...(invalid ? { reason: invalid } : {}) };
    if (!fresh && healthCache && Date.now() - healthCache.at < LLM_HEALTH_CACHE_MS) return healthCache.value;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LLM_HEALTH_TIMEOUT_MS);
    let value;
    try {
      const suffix = kind === 'anthropic'
        ? (/\/v1$/.test(new URL(parsed.publicBase).pathname.replace(/\/+$/, '')) ? 'models' : 'v1/models')
        : 'models';
      const res = await fetchImpl(endpoint(parsed.publicBase, parsed.query, suffix), {
        method: 'GET', headers: authHeaders(), signal: ctl.signal,
      });
      const body = await readBodyCapped(res, 1024 * 1024).then((t) => JSON.parse(t)).catch(() => null);
      if (res.ok) {
        // круг 33: id из /models — строкой, без управляющих знаков, не длиннее MODEL_ID_MAX;
        // негодный не берётся (раньше — String(first) как есть, хоть 1 МБ, хоть «[object Object]»)
        const first = cleanModelId(body && Array.isArray(body.data) && body.data[0] ? body.data[0].id : null);
        if (!model && first) {
          model = first;
          if (provider && 'model' in provider && !provider.model) provider.model = model;
        }
        value = { llm: 'up', ...(model ? { model } : {}) };
      } else {
        value = { llm: 'down', ...(model ? { model } : {}) };
      }
    } catch {
      value = { llm: 'down', ...(model ? { model } : {}) };
    } finally {
      clearTimeout(timer);
    }
    healthCache = { at: Date.now(), value };
    return value;
  }

  return {
    kind,
    get configured() { return configured; },
    get model() { return model; },
    provider,
    health,
    redact,
    /** Для логов и трасс: куда ходим, без секретов. */
    describe: () => (configured ? { kind, base: parsed.publicBase, ...(model ? { model } : {}) } : { kind, base: null }),
    /** Сбросить кеш здоровья (после ошибки связи в прогоне). */
    markDown() { healthCache = { at: Date.now(), value: { llm: 'down', ...(model ? { model } : {}) } }; },
  };
}
