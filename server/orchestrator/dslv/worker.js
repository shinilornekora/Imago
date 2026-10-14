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
import * as core from '../../../src/core.js';
import { runCommand, runVariants, BrainError, SCHEMAS, raceAbort } from '../../../src/brain.js';

const testHooks = !!(workerData && workerData.testHooks);
const jobs = new Map();      // id → AbortController
const calls = new Map();     // callId → {resolve, reject}
let callSeq = 0;

function proxyProvider(id) {
  return {
    name: 'orchestrator', kind: 'proxy',
    async ready() { return true; },
    complete(messages, schema, opts = {}) {
      const callId = `${id}:${++callSeq}`;
      const name = schema && schema.name && SCHEMAS[schema.name] === schema ? schema.name : null;
      const p = new Promise((resolve, reject) => {
        calls.set(callId, { resolve, reject });
        parentPort.postMessage({
          type: 'llm', id, callId,
          messages: (Array.isArray(messages) ? messages : []).map((m) => ({ role: m.role, content: String(m.content == null ? '' : m.content) })),
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
    if (testHooks && job.test === 'spin') {
      for (;;) { /* бесконечный счёт: проверка таймаута */ }
    }
    const onStage = (rec) => {
      if (!rec || rec.partial !== undefined) return;
      parentPort.postMessage({
        type: 'stage', id,
        rec: { stage: rec.stage, label: rec.label, ...(rec.detail ? { detail: String(rec.detail).slice(0, 500) } : {}), ...(rec.variant != null ? { variant: rec.variant } : {}) },
      });
    };
    const common = {
      doc: job.doc, selection: job.selection || [], utterance: job.utterance,
      provider: proxyProvider(id), signal: ctl.signal, engine: core, onStage,
      activeArtboardId: job.activeArtboardId || null, history: job.history || null,
      library: job.library || null,
      selectionBy: job.selectionBy || 'human',
    };
    let result;
    if (job.mode === 'variants') {
      const list = await runVariants({ ...common, n: job.n || 3 });
      result = { variants: (list || []).map(slim) };
    } else {
      result = slim(await runCommand(common));
    }
    parentPort.postMessage({ type: 'done', id, result });
  } catch (e) {
    const info = e instanceof BrainError ? { kind: e.kind, message: e.message } : { kind: 'model', message: e && e.message ? e.message : String(e) };
    parentPort.postMessage({ type: 'done', id, result: { ops: [], error: info, warnings: [] } });
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
