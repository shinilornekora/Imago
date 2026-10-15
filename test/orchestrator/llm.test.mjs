/**
 * Модуль LLM Orchestrator: сборка адреса через URL, учётные данные из адреса — в заголовок,
 * redact, кеш здоровья, провайдер Anthropic (Messages API) поверх brain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseLlmUrl, endpoint, createLlm } from '../../server/orchestrator/llm/index.js';
import { SCHEMAS } from '../../src/brain.js';

test('адрес: суффикс к пути, query базы — после него, userinfo — вон', () => {
  const p = parseLlmUrl('https://u:secret-pass@llm.example.com:8443/proxy/v1/?api-version=2024-01&x=1');
  assert.equal(p.publicBase, 'https://llm.example.com:8443/proxy/v1');
  assert.equal(p.query, '?api-version=2024-01&x=1');
  assert.equal(p.auth, 'Basic ' + Buffer.from('u:secret-pass').toString('base64'));
  assert.equal(endpoint(p.publicBase, p.query, 'chat/completions').href,
    'https://llm.example.com:8443/proxy/v1/chat/completions?api-version=2024-01&x=1');
  assert.equal(endpoint('http://h:1234', '', '/models').href, 'http://h:1234/models');
  assert.equal(endpoint('http://h:1234/v1', '', 'models').href, 'http://h:1234/v1/models');

  const bearer = parseLlmUrl('http://tok-abcdef@127.0.0.1:1234/v1');
  assert.equal(bearer.auth, 'Bearer tok-abcdef');
  assert.equal(bearer.publicBase, 'http://127.0.0.1:1234/v1');
  assert.throws(() => parseLlmUrl('ftp://x'));
  assert.throws(() => parseLlmUrl('не адрес'));
});

test('redact вычищает ключ, пароль из адреса, query-секрет и любые userinfo', () => {
  const llm = createLlm({ baseUrl: 'http://me:pw-123456@h/v1?key=qsecret-1', apiKey: 'sk-abc-123456' });
  const s = llm.redact('sk-abc-123456 pw-123456 qsecret-1 http://other:zzz@host/ ' + Buffer.from('me:pw-123456').toString('base64'));
  assert.ok(!/sk-abc|pw-123456|qsecret|zzz|bWU6/.test(s), s);
  assert.equal(llm.describe().base, 'http://h/v1');
});

test('без адреса — unconfigured, провайдера нет; кривой адрес не роняет', async () => {
  const none = createLlm({});
  assert.equal(none.configured, false);
  assert.equal(none.provider, null);
  assert.deepEqual(await none.health(), { llm: 'unconfigured' });
  const bad = createLlm({ baseUrl: '::::' });
  assert.equal(bad.configured, false);
  assert.equal((await bad.health()).llm, 'unconfigured');
});

test('здоровье модели кешируется на 10 с; модель берётся из /models', async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen-local' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const llm = createLlm({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  assert.deepEqual(await llm.health(), { llm: 'up', model: 'qwen-local' });
  await llm.health();
  await llm.health();
  assert.equal(hits, 1);
  assert.equal(llm.model, 'qwen-local');
  llm.markDown();
  assert.equal((await llm.health()).llm, 'down');
  assert.equal((await llm.health({ fresh: true })).llm, 'up');
});

test('Anthropic: Messages API, x-api-key, JSON из текста ответа', async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-x' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      content: [{ type: 'text', text: '```json\n{"intent":"ask","title":"t","summary":"s","steps":[],"targets":[]}\n```' }],
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const llm = createLlm({ kind: 'anthropic', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'ant-key-1', model: 'claude-x' });
  assert.equal(llm.configured, true);
  assert.equal((await llm.health()).llm, 'up');
  const data = await llm.provider.complete([{ role: 'system', content: 'sys' }, { role: 'user', content: 'привет' }], SCHEMAS.plan, {});
  assert.equal(data.intent, 'ask');
  const post = seen.find((s) => s.url === '/v1/messages');
  assert.ok(post);
  assert.equal(post.headers['x-api-key'], 'ant-key-1');
  assert.equal(post.headers['anthropic-version'], '2023-06-01');
  assert.equal(post.body.model, 'claude-x');
  assert.equal(post.body.messages[0].role, 'user');
  assert.match(post.body.messages[0].content, /sys/);

  // без ключа Anthropic не считается подключённым
  assert.equal(createLlm({ kind: 'anthropic' }).configured, false);
});

test('globalizeIds: короткие id созданных узлов → core.uid, ссылки согласованы, чужие не тронуты', async () => {
  const { globalizeIds } = await import('../../server/orchestrator/pipeline.js');
  const ops = [
    { op: 'create', node: { id: 'f1', type: 'frame', parent: 'page_x', children: [], component: { name: 'К', props: [{ name: 'текст', target: 't2', path: 'characters' }] } }, index: 0 },
    { op: 'create', node: { id: 't2', type: 'text', parent: 'f1', characters: 'f1' } },
    { op: 'create', node: { id: 'i3', type: 'instance', parent: 'ab_1', of: 'f1', props: {} }, after: 't2' },
    { op: 'set', id: 'f1', path: 'name', value: 'f1' },
    { op: 'move', id: 'old_node', parent: 'f1', index: 0 },
    { op: 'set', id: 'zz', path: 'fill', value: 'accent' },
  ];
  const out = globalizeIds(ops);
  const [f, t, i] = out.map((o) => o.node && o.node.id);
  assert.match(f, /^f_[0-9a-z]{12,}$/);
  assert.match(t, /^t_/);
  assert.match(i, /^i_/);
  assert.equal(out[1].node.parent, f);
  assert.equal(out[1].node.characters, 'f1', 'текст не id — не трогаем');
  assert.equal(out[0].node.component.props[0].target, t);
  assert.equal(out[2].node.of, f);
  assert.equal(out[2].after, t);
  assert.equal(out[3].id, f);
  assert.equal(out[3].value, 'f1');
  assert.equal(out[4].parent, f);
  assert.equal(out[4].id, 'old_node');
  assert.equal(out[5].id, 'zz', 'узел не из этой пачки — как был');
  assert.equal(ops[0].node.id, 'f1', 'вход не мутирован');
});

test('круг 25: redact закрывает куски ключа от 8 знаков и base64 ключа в любом выравнивании', () => {
  const key = 'sk-proj-Q7f2LmZx9wPa3RtY8vKc0HsJ';
  const llm = createLlm({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: key });
  const cases = [
    `Incorrect API key provided: ${key.slice(0, 12)}**********${key.slice(-4)}.`,
    `ключ ${key.slice(5, 19)} в логе`,
    `Bearer ${key}`,
    'base64: ' + Buffer.from(key).toString('base64'),
    'basic: ' + Buffer.from('user:' + key).toString('base64'),
    'b64 части: ' + Buffer.from(key.slice(7, 30)).toString('base64'),
    'b64url: ' + Buffer.from('x' + key).toString('base64url'),
  ];
  for (const text of cases) {
    const out = llm.redact(text);
    assert.ok(out.includes('***'), 'закрыто: ' + out);
    // ни одного окна в 8 знаков от ключа или его base64 не осталось
    for (let i = 0; i + 8 <= key.length; i++) assert.ok(!out.includes(key.slice(i, i + 8)), out);
    const b64 = Buffer.from(key).toString('base64');
    for (let i = 0; i + 8 <= b64.length - 3; i++) assert.ok(!out.includes(b64.slice(i, i + 8)), out);
  }
  // обычный текст не трогается, короткие совпадения (< 8) — тоже
  const plain = 'Модель ответила 401: неверный ключ (sk-…). Проверьте LLM_API_KEY.';
  assert.equal(llm.redact(plain), plain);
  assert.equal(llm.redact('прочее sk-proj слово'), 'прочее sk-proj слово');
});
