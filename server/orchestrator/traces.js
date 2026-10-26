/**
 * Трассы (SPEC §10.4): шаги, длительности, число вызовов модели, токены — без ключей
 * и без промптов. Отправка — `POST {DOCUMENT_URL}/api/internal/traces` с заголовком
 * `X-Internal-Token`; не дошло (нет эндпойнта, 403, сеть) — команда этого не замечает,
 * в лог одна строка (одинаковая причина подряд — один раз). Последние N трасс держатся
 * в памяти — для отладки и тестов.
 */

import { TRACE_RING } from './limits.js';
import { cutText, cleanText } from '../../src/core.js';

/** Палитра и шрифты для трассы: только роли с #rrggbb и имена семейств. */
function cleanArt(a, s) {
  const palette = {};
  const p = a.palette && typeof a.palette === 'object' ? a.palette : {};
  for (const k of ['bg', 'surface', 'text', 'muted', 'accent', 'accent2', 'onAccent']) {
    if (typeof p[k] === 'string' && /^#[0-9a-f]{6}$/i.test(p[k])) palette[k] = p[k].toLowerCase();
  }
  const f = a.fonts && typeof a.fonts === 'object' ? a.fonts : {};
  return {
    ...(typeof a.tx_id === 'string' ? { tx_id: s(a.tx_id, 128) } : {}),
    palette,
    fonts: { display: s(f.display || '', 60) || '', text: s(f.text || '', 60) || '' },
  };
}

/**
 * @param {{doc: ReturnType<import('./docclient.js').createDocClient>, token?: string, path?: string, redact?: (s:string)=>string, log?: object}} o
 */
export function createTraces({ doc: net, token = '', path = '/api/internal/traces', redact = (s) => s, log = console }) {
  const ring = [];
  let lastProblem = '';
  const pending = new Set();

  const note = (why) => {
    if (why === lastProblem) return;
    lastProblem = why;
    log.warn(`[orchestrator/traces] трасса не записана: ${why}`);
  };

  /** Трасса — только разрешённые поля, строки через redact. */
  function clean(t) {
    // круг 25: по кодовым точкам и без \u0000/одиночных суррогатов — трасса пишется в jsonb
    const s = (v, max = 300) => (v == null ? undefined : cleanText(cutText(redact(String(v)), max)));
    return {
      command_id: s(t.command_id, 128),
      project: s(t.project, 128),
      mode: t.mode,
      kind: t.kind,
      status: t.status,
      ...(t.code ? { code: s(t.code, 64) } : {}),
      ...(t.message ? { message: s(t.message, 300) } : {}),
      started_at: t.started_at,
      ms: t.ms,
      steps: (t.steps || []).map((x) => ({ key: x.key, ms: x.ms })),
      model_calls: t.model_calls || 0,
      model_ms: t.model_ms || 0,
      prompt_tokens: t.prompt_tokens || 0,
      completion_tokens: t.completion_tokens || 0,
      ...(t.tx_id ? { tx_id: t.tx_id, seq: t.seq, ops: t.ops, dropped: t.dropped } : {}),
      ...(t.variants != null ? { variants: t.variants } : {}),
      ...(t.libraries != null ? { libraries: t.libraries } : {}),
      ...(t.library_components != null ? { library_components: t.library_components } : {}),
      // круг 39: полное чтение ждало семафора агента (очередь чтений)
      ...(t.read_queued ? { read_queued: true } : {}),
      engine: t.engine,
      ...(t.model ? { model: s(t.model, 120) } : {}),
      ...(t.llm_kind ? { llm_kind: t.llm_kind } : {}),
      // круг 47 (SPEC §14.5): палитра образа (роль → #rrggbb) и шрифты записанной правки; итог самопроверки
      ...(t.art && typeof t.art === 'object' ? { art: cleanArt(t.art, s) } : {}),
      ...(t.critique && typeof t.critique === 'object' ? { critique: {
        seen: t.critique.seen === 'image' ? 'image' : 'signals',
        score: Number.isFinite(t.critique.score) ? t.critique.score : null,
        revised: !!t.critique.revised,
        // круг 52: второй взгляд на доработку
        ...(Number.isFinite(t.critique.after_score) ? { after_score: t.critique.after_score } : {}),
        ...(['better', 'worse', 'unchecked'].includes(t.critique.recheck) ? { recheck: t.critique.recheck } : {}),
      } } : {}),
    };
  }

  function record(raw) {
    const t = clean(raw);
    ring.push(t);
    while (ring.length > TRACE_RING) ring.shift();
    if (!token) {
      note('INTERNAL_TOKEN не задан');
      return t;
    }
    const p = net.post(path, t, { headers: { 'X-Internal-Token': token }, timeout: 3000 })
      .then((r) => {
        if (r.status === 200 || r.status === 201 || r.status === 204) { lastProblem = ''; return; }
        note(r.status === 404 ? 'в Document service нет /api/internal/traces (404)' : `Document service ответил ${r.status}`);
      })
      .catch((e) => note(e && e.detail && e.detail.cause ? e.detail.cause : 'нет связи'))
      .finally(() => pending.delete(p));
    pending.add(p);
    return t;
  }

  return {
    record,
    recent: () => ring.slice(),
    /** Дождаться отправки (останов, тесты). */
    flush: () => Promise.allSettled([...pending]),
  };
}
