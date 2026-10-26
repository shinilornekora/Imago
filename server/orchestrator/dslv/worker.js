/**
 * Воркер DSLV: прогон brain (план → патч → операции на копии стейта → раскладка →
 * validate → починка) вне главного потока. runCommand монолитен — раскладка и проверка
 * идут внутри него между вызовами модели, поэтому в воркере живёт весь прогон.
 *
 * Модель отсюда НЕ зовётся напрямую: провайдер воркера — посредник, каждый вызов
 * уходит сообщением в главный поток (там ключ, сеть, кеш здоровья и общий AbortSignal
 * команды) и возвращается ответом. Так ключ не покидает главный поток, упавший воркер
 * не оставляет висящих соединений, а счётное время воркера можно мерить без ожидания модели.
 *
 * Сообщения:  главный → воркер: {type:'run', id, job} · {type:'abort', id} · {type:'llm-reply', callId, ok, data|error, usage}
 *             воркер → главный: {type:'stage', id, rec} · {type:'llm', id, callId, messages, schema, opts} · {type:'done', id, result} · {type:'ready'}
 */

import { parentPort, workerData } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import * as core from '../../../src/core.js';
import { runCommand, runVariants, BrainError, SCHEMAS, raceAbort, INTERNAL_MESSAGE, expandOverflow } from '../../../src/brain.js';
import { createRenderer } from '../render.js';

const testHooks = !!(workerData && workerData.testHooks);
// проверка: медленный старт воркера (загрузка модулей под нагрузкой) — круг 29
if (testHooks && workerData.startDelayMs > 0) {
  const until = Date.now() + workerData.startDelayMs;
  while (Date.now() < until) { /* «грузимся» */ }
}
const jobs = new Map();      // id → AbortController
const calls = new Map();     // callId → {resolve, reject}
let callSeq = 0;
/** Круг 47 (SPEC §14.4): снимки досок для критика — один рендер (и кеш шрифтов) на воркер. */
let renderer = null;
const renderBoard = (args) => (renderer || (renderer = createRenderer()))(args);

/** Часть реплики для передачи в главный поток: текст или картинка (§14.3), ничего лишнего. */
const partOf = (p) => (p && p.type === 'image'
  ? { type: 'image', mime: String(p.mime || ''), data: String(p.data || '') }
  : { type: 'text', text: String((p && p.text) || '') });

function proxyProvider(id, vision) {
  return {
    name: 'orchestrator', kind: 'proxy',
    // круг 47: видит ли модель картинки — как знает главный поток (brain помечает false сам)
    vision,
    async ready() { return true; },
    complete(messages, schema, opts = {}) {
      const callId = `${id}:${++callSeq}`;
      const name = schema && schema.name && SCHEMAS[schema.name] === schema ? schema.name : null;
      const p = new Promise((resolve, reject) => {
        calls.set(callId, { resolve, reject });
        parentPort.postMessage({
          type: 'llm', id, callId,
          messages: (Array.isArray(messages) ? messages : []).map((m) => ({
            role: m.role,
            content: Array.isArray(m.content) ? m.content.map(partOf) : String(m.content == null ? '' : m.content),
          })),
          schema: name ? { ref: name } : schema,
          opts: pick(opts, ['temperature', 'maxTokens', 'modelTier']),
        });
      }).then((reply) => {
        for (const u of reply.usage || []) {
          if (typeof opts.onUsage === 'function') { try { opts.onUsage(u); } catch { /* ignore */ } }
        }
        return reply.data;
      });
      // «Стоп» срабатывает сразу, даже пока главный поток ждёт модель
      return raceAbort(p, opts.signal, 0);
    },
  };
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * Круг 39 (N2): последняя черта DSLV — правка, после которой раскрытие экземпляров выходит за
 * предел ядра, не уходит на запись, каким бы путём brain её ни собрал (ответ модели проходит
 * эту проверку ещё в круге починки, `materialize`; здесь — местные пути без модели: «сделай
 * компонентом», отсоединение…). Документ после правки — превью brain, иначе applyOps.
 */
function guardExpand(doc, res) {
  if (!res || typeof res !== 'object' || res.error || !Array.isArray(res.ops) || !res.ops.length) return res;
  let after = res.preview && res.preview.doc;
  if (!after) {
    try {
      const r = core.applyOps(doc, res.ops);
      after = r && !r.error ? r.doc : null;
    } catch { after = null; }
  }
  const over = expandOverflow(core, doc, after);
  if (!over) return res;
  return {
    ops: [], warnings: res.warnings || [],
    error: { kind: 'model', code: 'not_applied', message: `${over.message.charAt(0).toUpperCase()}${over.message.slice(1)}. Правка не записана` },
  };
}

/** Результат brain → то, что нужно главному потоку (без превью-документа и геометрии). */
function slim(res) {
  if (!res || typeof res !== 'object') return res;
  const { preview: _p, stages: _s, ...rest } = res;
  return rest;
}

async function run(id, job) {
  const ctl = new AbortController();
  jobs.set(id, ctl);
  try {
    if (testHooks && job.test === 'oom') {
      const hog = [];
      for (;;) hog.push(new Array(1e6).fill(Math.random()));
    }
    if (testHooks && job.test === 'env') {
      // круг 25: что воркер видит в окружении (только имена) — проверка, что секретов нет
      // (BrainError: текст доходит до клиента как есть; исключение кода стало бы internal — круг 31)
      throw new BrainError('model', 'env ' + Object.keys(process.env).sort().join(','));
    }
    if (testHooks && job.test === 'throw') {
      // круг 31 (K3): исключение кода (не модели) — проверка, что это internal, а не llm_failed
      const n = null;
      return n.children.length;
    }
    if (testHooks && job.test === 'heap') {
      // круг 31: потолок кучи, с которым воркер на самом деле запущен (resourceLimits)
      const limit = getHeapStatistics().heap_size_limit;
      parentPort.postMessage({ type: 'done', id, result: { ops: [], warnings: [], test: { heapLimitMb: limit / (1024 * 1024) } } });
      return;
    }
    if (testHooks && job.test === 'spin') {
      for (;;) { /* бесконечный счёт: проверка таймаута */ }
    }
    // круг 29: счёт заданной длины (busyMs), до и/или после вызова модели (llm: true);
    // spinAfterLlm — после ответа модели воркер зависает (часы счёта обязаны снова идти)
    if (testHooks && job.test && typeof job.test === 'object') {
      const t = job.test;
      const busy = (ms) => { const until = Date.now() + (ms || 0); while (Date.now() < until) { /* считаем */ } };
      busy(t.busyMs);
      let answer = null;
      if (t.llm) answer = await proxyProvider(id).complete([{ role: 'user', content: String(t.prompt || 'проба') }], null, { signal: ctl.signal });
      if (t.spinAfterLlm) for (;;) { /* завис после ответа модели */ }
      busy(t.afterMs);
      parentPort.postMessage({ type: 'done', id, result: { ops: [], warnings: [], test: { answer } } });
      return;
    }
    const onStage = (rec) => {
      if (!rec || rec.partial !== undefined) return;
      parentPort.postMessage({
        type: 'stage', id,
        rec: { stage: rec.stage, label: rec.label, ...(rec.detail ? { detail: core.cutText(rec.detail, 500) } : {}), ...(rec.variant != null ? { variant: rec.variant } : {}) },
      });
    };
    // круг 47 (SPEC §14): арт-направление и критик — по настройке сервиса (job.art)
    const art = job.art && typeof job.art === 'object' ? job.art : {};
    const common = {
      doc: job.doc, selection: job.selection || [], utterance: job.utterance,
      provider: proxyProvider(id, art.vision), signal: ctl.signal, engine: core, onStage,
      direction: art.direction !== false, critic: art.critic !== false,
      render: art.critic === false ? null
        // проверка: снимок без resvg и сети — готовый PNG (круг 47)
        : testHooks && typeof art.fakeShot === 'string' ? async () => ({ mime: 'image/png', data: art.fakeShot, width: 8, height: 8 })
          : art.render !== false ? renderBoard : null,
      activeArtboardId: job.activeArtboardId || null, history: job.history || null,
      library: job.library || null,
      selectionBy: job.selectionBy || 'human',
    };
    let result;
    if (job.mode === 'variants') {
      const list = await runVariants({ ...common, n: job.n || 3 });
      result = { variants: (list || []).map((v) => slim(guardExpand(job.doc, v))) };
    } else {
      result = slim(guardExpand(job.doc, await runCommand(common)));
    }
    parentPort.postMessage({ type: 'done', id, result });
  } catch (e) {
    /* Круг 31 (K3): исключение кода (не BrainError) — не «сбой модели»: kind 'internal',
       стек — полем для журнала главного потока (наружу не уходит). Раньше любое исключение
       выдавалось за ответ модели — llm_failed, «повторите», и без стека в логе. */
    const info = e instanceof BrainError
      ? { kind: e.kind, message: e.message, ...(e.code ? { code: e.code } : {}), ...(e.retryable === false ? { retryable: false } : {}) }
      : { kind: 'internal', code: 'internal', message: INTERNAL_MESSAGE, retryable: false, stack: core.cutText(String((e && (e.stack || e.message)) || e), 4000) };
    try {
      parentPort.postMessage({ type: 'done', id, result: { ops: [], error: info, warnings: [] } });
    } catch {
      // результат не передался (структура не клонируется) — хотя бы честная ошибка, а не 60 с ожидания
      parentPort.postMessage({ type: 'done', id, result: { ops: [], error: { kind: 'internal', code: 'internal', message: INTERNAL_MESSAGE, retryable: false }, warnings: [] } });
    }
  } finally {
    jobs.delete(id);
  }
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'run') { run(msg.id, msg.job); return; }
  if (msg.type === 'abort') { const c = jobs.get(msg.id); if (c) c.abort(); return; }
  if (msg.type === 'llm-reply') {
    const w = calls.get(msg.callId);
    if (!w) return;
    calls.delete(msg.callId);
    if (msg.ok) w.resolve({ data: msg.data, usage: msg.usage });
    else w.reject(new BrainError(msg.error.kind || 'model', msg.error.message || 'Сбой модели', msg.error.code ? { code: msg.error.code } : undefined));
  }
});

parentPort.postMessage({ type: 'ready' });
