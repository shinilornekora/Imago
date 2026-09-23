// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/**
 * HTTP-помощники: вход, чтение, команды, тестовые хуки API (SPEC §2, packages/server/README.md).
 * Возвращают {status, body} — статус проверяют сами проверки (403/401 и т. п. — ожидаемые исходы).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHookHeaders } from '../../test-secret.mjs';
import { TEST_PASSWORDS as PASSWORDS } from '../../test-users.mjs';
import { waitForReplica } from '../../series/run.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
/** Заголовок `x-stand-test-secret` для /api/test/* (пусто, если сервер запущен без секрета). */
const TEST_HOOK_HEADERS = testHookHeaders(REPO_ROOT);

export class Api {
  /** @param {string} base */
  constructor(base) {
    this.base = base.replace(/\/$/, '');
  }

  /**
   * @param {string} method @param {string} path
   * @param {{token?: string, body?: unknown}} [opts]
   * @returns {Promise<{status:number, body:any, headers: Headers}>}
   */
  async call(method, path, opts = {}) {
    /** @type {Record<string,string>} */
    const headers = { accept: 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    // тестовые хуки живут за общей тайной (§1.6), а не за JWT
    if (path.startsWith('/api/test/')) Object.assign(headers, TEST_HOOK_HEADERS);
    let body;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** @param {'alice'|'bob'} user */
  async login(user) {
    const r = await this.call('POST', '/api/auth/login', { body: { login: user, password: PASSWORDS[user] } });
    if (r.status !== 200) throw new Error(`login ${user} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return /** @type {{token:string,userId:string,expiresIn:number}} */ (r.body);
  }

  health() {
    return this.call('GET', '/api/health');
  }

  /** @param {string} token @param {string} docId */
  getDocument(token, docId) {
    return this.call('GET', `/api/documents/${encodeURIComponent(docId)}`, { token });
  }

  /** @param {string} token */
  listDocuments(token) {
    return this.call('GET', '/api/documents', { token });
  }

  /** @param {string} token @param {string} docId @param {string} pageId */
  getPage(token, docId, pageId) {
    return this.call('GET', `/api/documents/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}`, { token });
  }

  /** @param {string} token @param {string} docId @param {object} cmd */
  postCommand(token, docId, cmd) {
    return this.call('POST', `/api/documents/${encodeURIComponent(docId)}/commands`, { token, body: cmd });
  }

  /** @param {string} token @param {string} opId */
  getOperation(token, opId) {
    return this.call('GET', `/api/operations/${encodeURIComponent(opId)}`, { token });
  }

  // ---------------------------------------------------------------- тестовые хуки (STAND_TEST_HOOKS=1)

  /** @param {string} docId */
  async reset(docId) {
    const r = await this.call('POST', '/api/test/reset', { body: { docId } });
    if (r.status !== 200) throw new Error(`test/reset ${docId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /** @param {string} [docId] */
  async clearOperations(docId) {
    const r = await this.call('POST', '/api/test/clear-operations', { body: docId ? { docId } : {} });
    if (r.status !== 200) throw new Error(`test/clear-operations: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /**
   * Задержка ответов, чей URL совпал с регулярным выражением (onSend: обработчик уже выполнен).
   * @param {{pathPattern:string, ms:number, count?:number, durationMs?:number, method?:string}} rule
   */
  async delay(rule) {
    const r = await this.call('POST', '/api/test/delay', { body: rule });
    if (r.status !== 200) throw new Error(`test/delay: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  async delayRules() {
    const r = await this.call('GET', '/api/test/delay');
    return /** @type {any[]} */ (r.body ?? []);
  }

  async clearDelays() {
    const r = await this.call('DELETE', '/api/test/delay');
    if (r.status !== 200) throw new Error(`DELETE test/delay: ${r.status}`);
    return r.body;
  }

  /**
   * Полный сброс состояния перед проверкой: правила задержек, документ (заливки, ревизия, операции).
   * После сброса ждём подтверждения слота логической репликации: иначе реплика zero-cache ещё какое-то
   * время отдаёт клиенту Z прежнюю (большую) ревизию документа, и первая команда проверки уходит с
   * заведомо неверной expectedRevision. Ожидание общее для всех адаптеров (у H/Q оно ничего не меняет),
   * никогда не роняет проверку и отключается переменной STAND_SKIP_REPLICA_WAIT=1.
   */
  async resetAll(docId) {
    await this.clearDelays();
    const r = await this.reset(docId);
    await this.clearOperations(docId);
    this.lastReplicaWait = await waitForReplica();
    return r;
  }
}
