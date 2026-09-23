/**
 * Тестовые хуки (SPEC §2.3), только при STAND_TEST_HOOKS=1. Не входят в измеряемый путь.
 *   POST   /api/test/delay {pathPattern, ms, count?, durationMs?, method?} — задержать ответы, чей URL
 *          соответствует регулярному выражению; действует `count` совпадений (по умолчанию 1) или `durationMs`.
 *          Задержка применяется в onSend — ответ вычислен ДО задержки («ответ старого чтения»).
 *   GET    /api/test/delay        — активные правила.
 *   DELETE /api/test/delay        — снять все правила.
 *   POST   /api/test/reset {docId} — восстановить заливки/переопределения/ревизию из снимка генератора.
 *   POST   /api/test/clear-operations {docId?} — очистить журнал операций (документа или весь).
 *
 * Аутентификация (§1.6). Хуки не требуют JWT — у них своя общая тайна: если задан
 * `STAND_TEST_HOOKS_SECRET` (`config.testHooksSecret`), КАЖДЫЙ запрос к `/api/test/*` обязан нести
 * заголовок `x-stand-test-secret` с этим значением, иначе 401 `unauthorized`. Пустой секрет
 * сохраняет прежнее поведение (открытые хуки) — допустимо только для привязки к 127.0.0.1.
 * Секрет генерируется при старте стенда в `results/logs/.test-secret` (`scripts/lib.sh`);
 * оболочка измерений и функциональные проверки читают его оттуда.
 */
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Sql } from '../db/sql.js';
import { resetDocument } from '../db/reset.js';
import { badRequest, notFound, unauthorized } from '../errors.js';

/** Сравнение секретов постоянного времени (разная длина → false без утечки длины сравнением). */
function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export const TEST_SECRET_HEADER = 'x-stand-test-secret';

interface DelayRule {
  id: number;
  pathPattern: string;
  regex: RegExp;
  method: string; // 'GET' | ... | '*'
  ms: number;
  remaining: number | null;
  expiresAt: number | null;
  hits: number;
}

interface DelayBody {
  pathPattern: string;
  ms: number;
  count?: number;
  durationMs?: number;
  method?: string;
}

const delayBodySchema = {
  type: 'object',
  required: ['pathPattern', 'ms'],
  additionalProperties: false,
  properties: {
    pathPattern: { type: 'string', minLength: 1, maxLength: 512 },
    ms: { type: 'integer', minimum: 0, maximum: 120_000 },
    count: { type: 'integer', minimum: 1, maximum: 100_000 },
    durationMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
    method: { type: 'string', minLength: 1, maxLength: 8 },
  },
} as const;

const resetBodySchema = {
  type: 'object',
  required: ['docId'],
  additionalProperties: false,
  properties: { docId: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const clearOpsBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { docId: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerTestRoutes(app: FastifyInstance, sql: Sql, testHooksSecret = ''): void {
  const rules: DelayRule[] = [];
  let nextId = 1;

  // Общая тайна хуков: проверяется до обработчика и до разбора тела, для ВСЕХ /api/test/*.
  if (testHooksSecret !== '') {
    app.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/test/')) return;
      const raw = request.headers[TEST_SECRET_HEADER];
      const got = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      if (!secretsEqual(got, testHooksSecret)) {
        request.log.warn({ url: request.url }, 'test hook: bad or missing x-stand-test-secret');
        throw unauthorized(`test hooks require a valid "${TEST_SECRET_HEADER}" header`);
      }
    });
  }

  const publicRule = (r: DelayRule) => ({
    id: r.id,
    pathPattern: r.pathPattern,
    method: r.method,
    ms: r.ms,
    remaining: r.remaining,
    expiresAt: r.expiresAt,
    hits: r.hits,
  });

  // Задержка в onSend: обработчик уже выполнен, ответ задерживается на выходе.
  app.addHook('onSend', async (request, _reply, payload) => {
    if (rules.length === 0 || request.url.startsWith('/api/test/')) return payload;
    const now = Date.now();
    let delayMs = 0;
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i]!;
      if (r.expiresAt !== null && r.expiresAt <= now) {
        rules.splice(i, 1);
        continue;
      }
      if (r.method !== '*' && r.method !== request.method) continue;
      if (!r.regex.test(request.url)) continue;
      r.hits++;
      delayMs = Math.max(delayMs, r.ms);
      if (r.remaining !== null) {
        r.remaining--;
        if (r.remaining <= 0) rules.splice(i, 1);
      }
    }
    if (delayMs > 0) {
      request.log.info({ url: request.url, delayMs }, 'test hook: delaying response');
      await sleep(delayMs);
    }
    return payload;
  });

  app.post<{ Body: DelayBody }>('/api/test/delay', { schema: { body: delayBodySchema } }, async (request) => {
    const b = request.body;
    let regex: RegExp;
    try {
      regex = new RegExp(b.pathPattern);
    } catch (err) {
      throw badRequest(`pathPattern is not a valid regular expression: ${(err as Error).message}`);
    }
    const hasDuration = b.durationMs !== undefined;
    const rule: DelayRule = {
      id: nextId++,
      pathPattern: b.pathPattern,
      regex,
      method: (b.method ?? 'GET').toUpperCase(),
      ms: b.ms,
      remaining: b.count !== undefined ? b.count : hasDuration ? null : 1,
      expiresAt: hasDuration ? Date.now() + b.durationMs! : null,
      hits: 0,
    };
    rules.push(rule);
    request.log.info({ rule: publicRule(rule) }, 'test hook: delay rule added');
    return publicRule(rule);
  });

  app.get('/api/test/delay', async () => rules.map(publicRule));

  app.delete('/api/test/delay', async () => {
    const n = rules.length;
    rules.length = 0;
    return { cleared: n };
  });

  app.post<{ Body: { docId: string } }>('/api/test/reset', { schema: { body: resetBodySchema } }, async (request) => {
    const result = await resetDocument(sql, request.body.docId);
    if (!result) throw notFound(`document "${request.body.docId}" not found`);
    request.log.info(result, 'test hook: document reset');
    return result;
  });

  app.post<{ Body: { docId?: string } }>(
    '/api/test/clear-operations',
    { schema: { body: clearOpsBodySchema } },
    async (request) => {
      const docId = request.body?.docId;
      const res = docId
        ? await sql`DELETE FROM operations WHERE document_id = ${docId}`
        : await sql`DELETE FROM operations`;
      return { deleted: res.count, docId: docId ?? null };
    },
  );
}
