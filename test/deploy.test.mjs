/**
 * Развёртывание (SPEC §8.1, §10): статическая проверка конфигов compose, nginx и
 * Dockerfile-ов простыми регулярками, а если в окружении есть nginx — `nginx -t` на
 * настоящем конфиге с подменой адресов апстримов и живая проверка маршрутов: SSE без
 * буферизации, /api/internal закрыт, JSON-ошибки за упавший апстрим.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const nginxConf = read('deploy/nginx.conf');
const compose = read('docker-compose.yml');

/* ---------------------------------- разбор ---------------------------------- */

/** Блок `location <spec> { … }`: скобки внутри строк в кавычках (JSON в return) не считаются. */
function locationBlock(conf, spec) {
  const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = new RegExp(`location\\s+${esc}\\s*\\{`).exec(conf);
  if (!m) return null;
  let depth = 1;
  let quote = '';
  for (let i = m.index + m[0].length; i < conf.length; i++) {
    const ch = conf[i];
    if (quote) { if (ch === quote && conf[i - 1] !== '\\') quote = ''; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '#') { const nl = conf.indexOf('\n', i); i = nl < 0 ? conf.length : nl; }
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return conf.slice(m.index + m[0].length, i);
  }
  return null;
}

/** Значение `set $name …;` в конфиге nginx. */
function setVar(conf, name) {
  const m = new RegExp(`set\\s+\\$${name}\\s+([^;]+);`).exec(conf);
  return m ? m[1].trim() : null;
}

/** Секунды из `proxy_read_timeout 900s;` и подобных. */
function seconds(v) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(v || '').trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[m[2] || 's'];
}

function directive(block, name) {
  const m = new RegExp(`(?:^|\\n)\\s*${name}\\s+([^;]+);`).exec(block || '');
  return m ? m[1].trim() : null;
}

/** JSON из `return <code> '<json>';`. */
function returnJson(block) {
  const m = /return\s+(\d{3})\s+'([^']*)';/.exec(block || '');
  if (!m) return null;
  return { status: Number(m[1]), body: JSON.parse(m[2].replace(/\\n/g, '\n')) };
}

/** Сервисы compose: имя → текст блока (два пробела отступа — уровень сервиса). */
function services(yaml) {
  const at = yaml.indexOf('\nservices:');
  assert.ok(at >= 0, 'в compose нет services:');
  const rest = yaml.slice(at + '\nservices:'.length);
  const end = rest.search(/\n\S/);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  const out = {};
  const re = /\n {2}([a-z][\w-]*):\s*\n/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ name: m[1], at: m.index + m[0].length });
  marks.forEach((x, i) => { out[x.name] = body.slice(x.at, i + 1 < marks.length ? marks[i + 1].at : body.length); });
  return out;
}

/** Подблок `key:` сервиса (по отступу четыре пробела). */
function sub(block, key) {
  const m = new RegExp(`\\n? {4}${key}:\\s*\\n((?: {6,}.*\\n?)+)`).exec(block || '');
  return m ? m[1] : '';
}

/* ------------------------------- статические ------------------------------- */

test('nginx: /agent/ → orchestrator:8090 без буферизации, с долгим таймаутом', () => {
  assert.equal(setVar(nginxConf, 'orchestrator_upstream'), 'http://orchestrator:8090');
  const b = locationBlock(nginxConf, '/agent/');
  assert.ok(b, 'нет location /agent/');
  assert.equal(directive(b, 'proxy_pass'), '$orchestrator_upstream');
  assert.equal(directive(b, 'proxy_buffering'), 'off');
  assert.ok(seconds(directive(b, 'proxy_read_timeout')) >= 300, 'proxy_read_timeout короче 5 минут');
  assert.match(b, /add_header\s+X-Accel-Buffering\s+no/);
  assert.equal(directive(b, 'proxy_http_version'), '1.1');
});

test('nginx: /api/ и /ws → document:8080, WebSocket с апгрейдом', () => {
  assert.equal(setVar(nginxConf, 'document_upstream'), 'http://document:8080');
  const api = locationBlock(nginxConf, '/api/');
  const ws = locationBlock(nginxConf, '/ws');
  assert.equal(directive(api, 'proxy_pass'), '$document_upstream');
  assert.equal(directive(ws, 'proxy_pass'), '$document_upstream');
  assert.match(ws, /proxy_set_header\s+Upgrade\s+\$http_upgrade/);
  assert.ok(seconds(directive(ws, 'proxy_read_timeout')) >= 600);
  // апстримы — переменными: nginx стартует и тогда, когда сервиса ещё нет в DNS
  assert.match(nginxConf, /resolver\s+127\.0\.0\.11/);
});

test('nginx: /api/internal/ снаружи закрыт — 403 JSON, раньше общего /api/', () => {
  const b = locationBlock(nginxConf, '^~ /api/internal/');
  assert.ok(b, 'нет location ^~ /api/internal/ (без ^~ его перебьёт регулярка или префикс)');
  const r = returnJson(b);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, true);
  assert.equal(r.body.retryable, false);
  assert.ok(!/proxy_pass/.test(b));
  // и токен снаружи не проходит в сервисы
  assert.match(locationBlock(nginxConf, '/api/'), /proxy_set_header\s+X-Internal-Token\s+""/);
});

test('nginx: записи на /api/ — client_body_timeout и limit_conn на адрес, сверх — 429 JSON busy (круг 27)', () => {
  const server = nginxConf.slice(nginxConf.indexOf('server {'));
  const timeout = seconds(directive(server.slice(0, server.indexOf('location')), 'client_body_timeout'));
  assert.ok(timeout > 0 && timeout <= 30, `client_body_timeout ${timeout} с — не дольше срока тела Document service (30 с)`);
  // ключ зоны — адрес только у записей: чтения (GET/HEAD) пустым ключом не считаются
  const zone = /limit_conn_zone\s+\$(\w+)\s+zone=(\w+):\d+m;/.exec(nginxConf);
  assert.ok(zone, 'нет limit_conn_zone');
  const map = new RegExp(`map\\s+\\$request_method\\s+\\$${zone[1]}\\s*\\{([^}]*)\\}`).exec(nginxConf);
  assert.ok(map, `ключ ${zone[1]} — не по методу запроса`);
  assert.match(map[1], /GET\s+"";/);
  assert.match(map[1], /HEAD\s+"";/);
  assert.match(map[1], /default\s+\$binary_remote_addr;/);
  const api = locationBlock(nginxConf, '/api/');
  const lim = new RegExp(`limit_conn\\s+${zone[2]}\\s+(\\d+);`).exec(api);
  assert.ok(lim, '/api/: нет limit_conn');
  assert.ok(Number(lim[1]) >= 8 && Number(lim[1]) <= 64, `предел ${lim[1]} — неразумный`);
  assert.equal(directive(api, 'limit_conn_status'), '429');
  const busy = /error_page\s+429\s*=\s*(@\w+)/.exec(api);
  assert.ok(busy, '/api/: 429 отдаст HTML');
  const named = locationBlock(nginxConf, busy[1]);
  const r = returnJson(named);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'busy');
  assert.equal(r.body.retryable, true);
  assert.match(named, /add_header\s+Retry-After\s+\d+\s+always/);
  // /ws предел записей не задевает (апгрейд — GET, и сокет долгий): у сокетов своя зона
  assert.doesNotMatch(locationBlock(nginxConf, '/ws'), new RegExp(`limit_conn\\s+${zone[2]}\\b`));
});

test('nginx: сокеты /ws — не больше 64 с адреса, сверх — 429 JSON busy (круг 29)', () => {
  const zone = /limit_conn_zone\s+\$binary_remote_addr\s+zone=(\w+):\d+m;/.exec(nginxConf);
  assert.ok(zone, 'нет зоны сокетов по адресу');
  const ws = locationBlock(nginxConf, '/ws');
  const lim = new RegExp(`limit_conn\\s+${zone[1]}\\s+(\\d+);`).exec(ws);
  assert.ok(lim, '/ws: нет limit_conn');
  assert.ok(Number(lim[1]) >= 16 && Number(lim[1]) <= 256, `предел ${lim[1]} — неразумный`);
  assert.equal(directive(ws, 'limit_conn_status'), '429');
  const busy = /error_page\s+429\s*=\s*(@\w+)/.exec(ws);
  assert.ok(busy, '/ws: 429 отдаст HTML');
  const r = returnJson(locationBlock(nginxConf, busy[1]));
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'busy');
  assert.equal(r.body.retryable, true);
  // зона /ws — не зона записей /api/: долгие сокеты не съедают предел записей
  const apiZone = /limit_conn\s+(\w+)\s+\d+;/.exec(locationBlock(nginxConf, '/api/'))[1];
  assert.notEqual(zone[1], apiZone);
});

test('nginx: ошибки 413/502/503/504 — единый JSON, апстрим назван и помечен заголовком', () => {
  assert.ok(!/proxy_intercept_errors\s+on/.test(nginxConf), 'свои ошибки сервисов nginx подменять не должен');
  assert.match(nginxConf, /error_page\s+413\s*=\s*@too_large/);
  const tl = returnJson(locationBlock(nginxConf, '@too_large'));
  assert.equal(tl.status, 413);
  assert.deepEqual(Object.keys(tl.body).sort(), ['code', 'error', 'message', 'retryable']);
  for (const [loc, up] of [['/api/', 'document'], ['/ws', 'document'], ['/agent/', 'orchestrator']]) {
    const b = locationBlock(nginxConf, loc);
    // error_page в location заменяет серверный целиком — 413 обязан быть и здесь
    const big = /error_page\s+413\s*=\s*(@[\w]+)/.exec(b);
    assert.ok(big, `${loc}: 413 отдаст HTML`);
    const bigBody = returnJson(locationBlock(nginxConf, big[1]));
    assert.equal(bigBody.status, 413, `${big[1]} отдаёт не 413`);
    assert.equal(bigBody.body.code, 'too_large');
    assert.equal(bigBody.body.retryable, false);
    for (const code of [502, 503, 504]) {
      const m = new RegExp(`error_page\\s+${code}\\s*=\\s*(@[\\w]+)`).exec(b);
      assert.ok(m, `${loc}: нет error_page ${code}`);
      const named = locationBlock(nginxConf, m[1]);
      const r = returnJson(named);
      assert.equal(r.status, code, `${m[1]} отдаёт не ${code}`);
      assert.equal(r.body.error, true);
      assert.equal(r.body.upstream, up);
      assert.equal(typeof r.body.code, 'string');
      assert.equal(typeof r.body.message, 'string');
      assert.equal(r.body.retryable, true);
      assert.match(named, /default_type\s+application\/json/);
      if (code !== 504) {
        assert.match(named, /add_header\s+X-Imago-Upstream\s+down\s+always/);
        assert.match(named, /add_header\s+Retry-After\s+\d+\s+always/);
      }
    }
  }
});

test('compose: сервисы, healthcheck у document, orchestrator, web; зависимости по здоровью', () => {
  const s = services(compose);
  for (const name of ['db', 'document', 'orchestrator', 'web']) assert.ok(s[name], `нет сервиса ${name}`);
  for (const name of ['document', 'orchestrator', 'web']) {
    const hc = sub(s[name], 'healthcheck');
    assert.match(hc, /test:\s*\[/, `${name}: нет healthcheck.test`);
    assert.match(hc, /"(node|wget)"/, `${name}: проверка не node/wget`);
  }
  assert.match(sub(s.document, 'healthcheck'), /127\.0\.0\.1:8080\/api\/health/);
  assert.match(sub(s.orchestrator, 'healthcheck'), /127\.0\.0\.1:8090\/agent\/health/);
  const dep = (name) => sub(s[name], 'depends_on');
  assert.match(dep('document'), /db:\s*\n\s+condition:\s*service_healthy/);
  assert.match(dep('orchestrator'), /document:\s*\n\s+condition:\s*service_healthy/);
  assert.match(dep('web'), /document:\s*\n\s+condition:\s*service_healthy/);
  // круг 27, п.9: редактор поднимается и без агента — web ждёт только запуска orchestrator
  assert.match(dep('web'), /orchestrator:\s*\n\s+condition:\s*service_started/);
  assert.doesNotMatch(dep('web'), /orchestrator:\s*\n\s+condition:\s*service_healthy/);
  assert.match(s.web, /\$\{IMAGO_PORT:-8123\}:80/);
  // круг 25: останов — с запасом на дописывание начатого; миграции на большой базе — не смерть
  for (const name of ['document', 'orchestrator']) {
    assert.match(s[name], /stop_grace_period:\s*15s/, `${name}: нет stop_grace_period 15s`);
  }
  const hc = sub(s.document, 'healthcheck');
  const startP = /start_period:\s*(\d+)s/.exec(hc);
  assert.ok(startP && Number(startP[1]) >= 600, 'document: start_period меньше 10 минут — долгая миграция уронит сервис');
  const retries = /retries:\s*(\d+)/.exec(hc);
  assert.ok(retries && Number(retries[1]) >= 10, 'document: мало повторов проверки');
});

test('nginx: тело команды агенту — не больше 1 МБ, как у самого Orchestrator', async () => {
  const b = locationBlock(nginxConf, '/agent/');
  assert.equal(directive(b, 'client_max_body_size'), '1m');
  const { MAX_BODY_BYTES } = await import('../server/orchestrator/limits.js');
  assert.equal(MAX_BODY_BYTES, 1024 * 1024, 'предел nginx и Orchestrator разошлись');
  // остальным — 4 МБ, как у Document service (SPEC §9.8): тело 4–8 МБ раньше проходило
  // nginx, сервис рвал соединение, и клиент видел 502 «сервис лежит» вместо 413 (круг 25)
  assert.equal(directive(nginxConf.slice(0, nginxConf.indexOf('location')), 'client_max_body_size'), '4m');
  assert.equal(directive(locationBlock(nginxConf, '/api/'), 'client_max_body_size'), '4m');
  const { MAX_BODY_BYTES: DOC_MAX } = await import('../server/document/limits.js').catch(() => ({}));
  if (Number.isFinite(DOC_MAX)) assert.equal(DOC_MAX, 4 * 1024 * 1024, 'предел nginx /api/ и Document service разошлись');
  const m = /error_page\s+413\s*=\s*(@[\w]+)/.exec(b);
  assert.match(returnJson(locationBlock(nginxConf, m[1])).body.message, /1 МБ/);
});

test('compose: document — DB_TIMEOUT_MS и SNAPSHOT_KEEP из окружения с умолчаниями', async () => {
  const env = sub(services(compose).document, 'environment');
  const lim = await import('../server/document/limits.js');
  for (const [name, def] of [['DB_TIMEOUT_MS', lim.DB_TIMEOUT_MS], ['SNAPSHOT_KEEP', lim.SNAPSHOT_KEEP], ['SNAPSHOT_EVERY', lim.SNAPSHOT_EVERY]]) {
    const m = new RegExp(`${name}:\\s*\\$\\{${name}:-(\\d+)\\}`).exec(env);
    assert.ok(m, `document: нет ${name} со значением по умолчанию`);
    assert.equal(Number(m[1]), def, `${name}: умолчание compose расходится с server/document/limits.js`);
  }
  assert.match(read('deploy/env.example'), /DB_TIMEOUT_MS/);
});

test('compose: все пределы сервисов — из окружения (.env) с умолчаниями кода (круг 29)', async () => {
  const docEnv = sub(services(compose).document, 'environment');
  const orchEnv = sub(services(compose).orchestrator, 'environment');
  const example = read('deploy/env.example');
  const { ENV_LIMITS } = await import('../server/document/index.js');
  for (const [name, [, def]] of Object.entries(ENV_LIMITS)) {
    const m = new RegExp(`\\b${name}:\\s*\\$\\{${name}:-(\\d+)\\}`).exec(docEnv);
    assert.ok(m, `document: нет ${name}: \${${name}:-…}`);
    assert.equal(Number(m[1]), def, `${name}: умолчание compose расходится с кодом`);
    assert.match(example, new RegExp(`^#?\\s*${name}=${def}\\s*$`, 'm'), `env.example: нет ${name}=${def}`);
  }
  const ol = await import('../server/orchestrator/limits.js');
  const orchDefs = {
    WORKER_MAX_MB: ol.WORKER_MAX_OLD_MB, WORKER_TIMEOUT_MS: ol.WORKER_TIMEOUT_MS, WORKER_JOBS: ol.WORKER_JOBS_MAX,
    POOL_QUEUE_MAX: ol.POOL_QUEUE_MAX, POOL_QUEUE_WAIT_MS: ol.POOL_QUEUE_WAIT_MS, QUEUE_MAX: ol.MAX_QUEUE_PER_PROJECT,
    LLM_TIMEOUT_MS: 120000, WORKERS: '',
  };
  // Orchestrator читает из окружения ровно эти (index.js) — compose передаёт каждый
  const orchSrc = read('server/orchestrator/index.js');
  for (const name of new Set([...orchSrc.matchAll(/env\.([A-Z][A-Z_]+)/g)].map((x) => x[1]))) {
    if (['PORT', 'HOST', 'DOCUMENT_URL', 'INTERNAL_TOKEN', 'LLM_KIND', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'].includes(name)) continue;
    assert.ok(name in orchDefs, `orchestrator читает ${name} — его нет в проверке compose`);
  }
  for (const [name, def] of Object.entries(orchDefs)) {
    const m = new RegExp(`\\b${name}:\\s*\\$\\{${name}:-(\\d*)\\}`).exec(orchEnv);
    assert.ok(m, `orchestrator: нет ${name}: \${${name}:-…}`);
    assert.equal(m[1], String(def), `${name}: умолчание compose расходится с кодом`);
    assert.match(example, new RegExp(`^#?\\s*${name}=${def}\\s*$`, 'm'), `env.example: нет ${name}`);
  }
});

test('.dockerignore и запуск процессов: node напрямую, без npm', () => {
  assert.ok(existsSync(join(root, '.dockerignore')), 'нет .dockerignore — в контекст сборки уходят node_modules и .git');
  const ignore = new Set(read('.dockerignore').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  for (const x of ['node_modules', '.git', 'dist', 'dev.html', '.env', 'test']) assert.ok(ignore.has(x), `.dockerignore: нет ${x}`);
  // то, что Dockerfile-ы копируют, исключать нельзя
  for (const x of ['src', 'server', 'tools', 'deploy', 'package.json', 'package-lock.json', 'index.html', 'app.js', 'styles.css']) {
    assert.ok(!ignore.has(x), `.dockerignore исключает ${x}, а его копирует Dockerfile`);
  }
  for (const f of ['deploy/Dockerfile.document', 'deploy/Dockerfile.orchestrator', 'deploy/Dockerfile.web']) {
    const d = read(f);
    // npm в роли PID 1 не передаёт SIGTERM процессу: остановка контейнера ждала бы 10 с и
    // обрывала запись транзакции на полуслове
    assert.ok(!/^(CMD|ENTRYPOINT)\b.*\bnpm\b/m.test(d), `${f}: процесс запускается через npm`);
    const cmd = /^CMD\s+(.+)$/m.exec(d);
    if (cmd && !/nginx/.test(d)) assert.match(cmd[1], /^\["node", "[^"]+\.js"\]$/, `${f}: CMD не в форме ["node", "…"]`);
  }
});

test('compose: окружение orchestrator — документ, модель на хосте, общий токен', () => {
  const s = services(compose);
  const env = sub(s.orchestrator, 'environment');
  assert.match(env, /DOCUMENT_URL:\s*http:\/\/document:8080/);
  assert.match(env, /PORT:\s*"8090"/);
  assert.match(env, /LLM_BASE_URL:\s*\$\{LLM_BASE_URL:-http:\/\/host\.docker\.internal:1234\/v1\}/);
  assert.match(env, /LLM_MODEL:\s*\$\{LLM_MODEL:-[^}]+\}/);
  assert.match(env, /LLM_API_KEY:\s*\$\{LLM_API_KEY:-\}/);
  assert.match(sub(s.orchestrator, 'extra_hosts'), /host\.docker\.internal:host-gateway/);
  // один и тот же токен у обоих; умолчание — заглушка, которую document не принимает
  const tok = /INTERNAL_TOKEN:\s*(\$\{INTERNAL_TOKEN:-([^}]*)\})/;
  const a = tok.exec(env);
  const b = tok.exec(sub(s.document, 'environment'));
  assert.ok(a && b, 'INTERNAL_TOKEN должен быть у document и orchestrator');
  assert.equal(a[1], b[1]);
  assert.equal(a[2], 'change-me');
  // к базе orchestrator не прикасается (§8.1)
  assert.ok(!/DATABASE_URL/.test(s.orchestrator));
});

test('Dockerfile.orchestrator: node:22-alpine, src и server/orchestrator, npm ci --omit=dev', () => {
  const d = read('deploy/Dockerfile.orchestrator');
  assert.match(d, /^FROM node:22-alpine/m);
  assert.match(d, /RUN npm ci --omit=dev/);
  assert.match(d, /^COPY src \.\/src$/m);
  assert.match(d, /^COPY server\/orchestrator \.\/server\/orchestrator$/m);
  assert.ok(!/^COPY server\/document/m.test(d));
  const cmd = /CMD \["node", "([^"]+)"\]/.exec(d);
  assert.ok(cmd);
  assert.ok(existsSync(join(root, cmd[1])), `${cmd[1]} нет в репозитории`);
  assert.match(d, /^EXPOSE 8090$/m);
  // всё, что orchestrator импортирует вне своего каталога, — только из src/ (оно в образе)
  const dir = join(root, 'server/orchestrator');
  if (existsSync(dir)) {
    const files = spawnSync('find', [dir, '-name', '*.js'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = join(dirname(f), m[1]);
        const ok = target.startsWith(join(root, 'src')) || target.startsWith(dir);
        assert.ok(ok, `${f.slice(root.length + 1)} импортирует ${m[1]} — этого нет в образе`);
      }
    }
  }
});

test('Dockerfile.web и сборка: все модули клиента попадают в dist', () => {
  const web = read('deploy/Dockerfile.web');
  assert.match(web, /COPY src \.\/src/);
  assert.match(web, /RUN node tools\/build\.mjs/);
  assert.match(web, /COPY deploy\/nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(web, /COPY --from=build \/app\/dist\/web \/usr\/share\/nginx\/html/);
  const build = read('tools/build.mjs');
  const listed = /const SRC_MODULES = \[([^\]]+)\]/.exec(build);
  assert.ok(listed, 'в build.mjs не найден список модулей src');
  // dist/web — с сервером за страницей, dist/local и dev.html — соло без сервера
  assert.match(build, /join\(web, 'index\.html'\), fullDoc\(\{ top: defaultsFor\(true\) \}\)/);
  assert.match(build, /join\(dist, 'index\.html'\), fullDoc\(\{ top: defaultsFor\(false\) \}\)/);
  const copied = new Set([...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  // всё, что app.js тянет из src/ (и что тянут они), должно быть скопировано
  const seen = new Set();
  const walk = (file) => {
    for (const m of read(file).matchAll(/(?:import|export)[^'"]*from\s+'(\.\/src\/[^']+|\.\/[^']+)'/g)) {
      const rel = file === 'app.js' ? m[1].replace(/^\.\//, '') : join(dirname(file), m[1]).replace(/^\.\//, '');
      if (!rel.startsWith('src/') || seen.has(rel)) continue;
      seen.add(rel);
      walk(rel);
    }
  };
  walk('app.js');
  assert.ok(seen.has('src/agent.js') && seen.has('src/shell.js'));
  for (const f of seen) assert.ok(copied.has(f.slice(4)), `${f} не копируется в dist/local`);
});

test('START.cmd и STOP.cmd: UTF-8, CRLF в каждой строке, compose с ожиданием здоровья', () => {
  for (const f of ['START.cmd', 'STOP.cmd']) {
    const raw = readFileSync(join(root, f));
    const text = raw.toString('utf8');
    assert.ok(!text.includes('�'), `${f}: не UTF-8`);
    const lines = text.split('\n');
    lines.pop();   // после последнего \n
    for (const [i, l] of lines.entries()) assert.ok(l.endsWith('\r'), `${f}:${i + 1} без CRLF`);
    assert.match(text, /chcp 65001/);
  }
  const start = read('START.cmd');
  assert.match(start, /docker compose up --build -d --wait/);
  assert.match(start, /\/agent\/health/);
});

/* ------------------------------ живой nginx ------------------------------ */

const NGINX = (() => {
  const r = spawnSync('sh', ['-c', 'command -v nginx'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
})();

/**
 * Свободный порт для nginx: случайный от ядра (listen 0), круг 26 — фиксированный
 * диапазон сталкивался у параллельных прогонов `npm test` (проверка «свободен» и запуск
 * nginx — не атомарны, а три прогона перебирали одни и те же 10 портов).
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function listen(handler) {
  const sockets = new Set();
  const srv = http.createServer(handler);
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: srv.address().port,
    server: srv,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  })));
}

/** Конфиг для прогона: адреса апстримов и порт подменены, временные пути — свои. */
function testConfig(dir, port, docPort, orchPort) {
  const site = nginxConf
    .replace(/listen\s+80;/, `listen 127.0.0.1:${port};`)
    .replace(/root\s+\/usr\/share\/nginx\/html;/, `root ${join(dir, 'html')};`)
    .replace('http://document:8080', `http://127.0.0.1:${docPort}`)
    .replace('http://orchestrator:8090', `http://127.0.0.1:${orchPort}`)
    // срок тела — 1 с вместо 30, чтобы проверить его в прогоне
    .replace(/client_body_timeout\s+\d+s;/, 'client_body_timeout 1s;');
  assert.notEqual(site, nginxConf);
  assert.match(site, /client_body_timeout 1s;/);
  writeFileSync(join(dir, 'site.conf'), site);
  const main = `
daemon off;
master_process off;
worker_processes 1;
pid ${join(dir, 'nginx.pid')};
error_log ${join(dir, 'error.log')} warn;
events { worker_connections 512; }
http {
  default_type application/octet-stream;
  types { text/html html; text/javascript js; text/css css; }
  access_log off;
  client_body_temp_path ${join(dir, 'tmp/body')};
  proxy_temp_path ${join(dir, 'tmp/proxy')};
  fastcgi_temp_path ${join(dir, 'tmp/fastcgi')};
  uwsgi_temp_path ${join(dir, 'tmp/uwsgi')};
  scgi_temp_path ${join(dir, 'tmp/scgi')};
  include ${join(dir, 'site.conf')};
}
`;
  writeFileSync(join(dir, 'nginx.conf'), main);
  return join(dir, 'nginx.conf');
}

test('nginx -t на настоящем конфиге и живые маршруты', { skip: NGINX ? false : 'nginx в окружении нет' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'imago-nginx-'));
  mkdirSync(join(dir, 'html'));
  mkdirSync(join(dir, 'tmp'));
  writeFileSync(join(dir, 'html', 'index.html'), '<!doctype html><title>Imago</title>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const seenDoc = [];
  const doc = await listen((req, res) => {
    seenDoc.push({ url: req.url, token: req.headers['x-internal-token'] });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, engine: 1 }));
    });
  });
  const orch = await listen((req, res) => {
    req.resume();
    req.on('end', async () => {
      if (req.url === '/agent/health') {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: true, code: 'llm_down', message: 'модель недоступна', retryable: true }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write('event: stage\ndata: {"key":"jev"}\n\n');
      await new Promise((r) => setTimeout(r, 700));
      res.write('event: result\ndata: {"tx_id":"t"}\n\nevent: done\ndata: {}\n\n');
      res.end();
    });
  });
  // сокет: апгрейд принимается (101) и держится, как у Hub
  doc.server.on('upgrade', (req, sock) => {
    seenDoc.push({ url: req.url, token: req.headers['x-internal-token'] });
    sock.on('error', () => {});
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  t.after(() => doc.close());
  let orchUp = true;
  t.after(() => (orchUp ? orch.close() : null));

  // порт мог занять кто-то между выбором и запуском nginx — тогда другой порт (до 3 раз)
  let port = 0;
  let proc = null;
  for (let attempt = 0; attempt < 3 && !proc; attempt++) {
    port = await freePort();
    const conf = testConfig(dir, port, doc.port, orch.port);
    const check = spawnSync(NGINX, ['-t', '-p', dir, '-c', conf, '-e', join(dir, 'error.log')], { encoding: 'utf8' });
    assert.equal(check.status, 0, `nginx -t: ${check.stderr}`);
    const p = spawn(NGINX, ['-p', dir, '-c', conf, '-e', join(dir, 'error.log')], { stdio: 'ignore' });
    let gone = false;
    p.once('exit', () => { gone = true; });
    let up = false;
    for (let i = 0; i < 100 && !gone && !up; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (up && !gone) proc = p;
    else { try { p.kill('SIGKILL'); } catch { /* уже нет */ } }
  }
  assert.ok(proc, 'nginx не поднялся');
  t.after(() => { try { proc.kill('SIGTERM'); } catch { /* уже нет */ } });
  const base = `http://127.0.0.1:${port}`;

  // статика
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Imago/);

  // /api/internal закрыт, до сервиса не доходит
  const internal = await fetch(base + '/api/internal/traces', { method: 'POST', body: '{}', headers: { 'x-internal-token': 'x' } });
  assert.equal(internal.status, 403);
  assert.equal((await internal.json()).error, true);
  assert.ok(!seenDoc.some((r) => r.url.startsWith('/api/internal')));

  // /api/ доходит, служебный токен снаружи срезан
  const api = await fetch(base + '/api/health', { headers: { 'x-internal-token': 'secret' } });
  assert.equal(api.status, 200);
  assert.equal(seenDoc.at(-1).token, undefined);

  // своя ошибка Orchestrator проходит как есть — с его кодом и Retry-After
  const own = await fetch(base + '/agent/health');
  assert.equal(own.status, 503);
  assert.equal(own.headers.get('retry-after'), '7');
  assert.equal(own.headers.get('x-imago-upstream'), null);
  assert.equal((await own.json()).code, 'llm_down');

  // SSE: первое событие приходит до конца потока — буферизации нет
  const t0 = Date.now();
  const sse = await fetch(base + '/agent/command', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get('x-accel-buffering'), 'no');
  const reader = sse.body.getReader();
  const first = await reader.read();
  const tFirst = Date.now() - t0;
  assert.match(new TextDecoder().decode(first.value), /event: stage/);
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  const tEnd = Date.now() - t0;
  assert.match(rest, /event: done/);
  assert.ok(tEnd - tFirst >= 350, `стадия пришла вместе с концом потока (${tFirst} мс из ${tEnd})`);

  // большое тело — 413 тем же JSON; 5 МБ — уже больше предела Document service (4 МБ):
  // это 413 от nginx, а не 502 от оборванного сервисом соединения (круг 25)
  for (const mb of [5, 9]) {
    const big = await fetch(base + '/api/projects/p/tx', { method: 'POST', body: 'x'.repeat(mb * 1024 * 1024), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413, `${mb} МБ`);
    assert.match(big.headers.get('content-type') || '', /application\/json/);
    const bigBody = await big.json();
    assert.equal(bigBody.code, 'too_large');
    assert.equal(bigBody.retryable, false);
  }
  assert.ok(!seenDoc.some((r) => r.url.endsWith('/tx')), 'тело больше 4 МБ дошло до Document service');
  // 3 МБ проходит до сервиса
  const mid = await fetch(base + '/api/projects/p/tx', { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024), headers: { 'content-type': 'application/json' } });
  assert.equal(mid.status, 200);
  // команда агенту больше 1 МБ — 413 у nginx, до Orchestrator не доходит
  const bigCmd = await fetch(base + '/agent/command', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024), headers: { 'content-type': 'application/json' } });
  assert.equal(bigCmd.status, 413);
  const bigCmdBody = await bigCmd.json();
  assert.equal(bigCmdBody.code, 'too_large');
  assert.equal(bigCmdBody.retryable, false);

  // круг 27: медленные тела записей. Капающее тело (байт раз в 200 мс) client_body_timeout не
  // ловит — его держит limit_conn: 32 таких с адреса, 33-я запись — 429 JSON busy, чтение — идёт.
  const limit = Number(/limit_conn\s+\w+\s+(\d+);/.exec(locationBlock(nginxConf, '/api/'))[1]);
  const slow = [];
  const drip = setInterval(() => { for (const x of slow) if (!x.destroyed) x.write(' '); }, 200);
  const rawPost = (path, len) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.reply = '';
    sock.on('data', (d) => { sock.reply += d.toString(); });
    sock.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${len}\r\n\r\n{`);
    return sock;
  };
  try {
    for (let i = 0; i < limit; i++) slow.push(rawPost('/api/projects/p/tx', 100000));
    await new Promise((r) => setTimeout(r, 600));
    const over = await fetch(base + '/api/projects/p/tx', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(over.status, 429, `запись сверх ${limit} медленных`);
    assert.equal(over.headers.get('retry-after'), '1');
    const overBody = await over.json();
    assert.equal(overBody.code, 'busy');
    assert.equal(overBody.retryable, true);
    const read = await fetch(base + '/api/health');
    assert.equal(read.status, 200, 'чтение предел записей не задевает');
    assert.ok(slow.every((x) => x.reply === ''), 'капающее тело оборвано раньше времени');
  } finally {
    clearInterval(drip);
    for (const x of slow) x.destroy();
  }
  // тело замолчало дольше client_body_timeout (в прогоне 1 с) — nginx закрывает запрос (408),
  // до сервиса оно не доходит; соединения капавших отпущены — запись снова проходит
  const stalled = rawPost('/api/projects/stalled/tx', 1000);
  const tStall = Date.now();
  await new Promise((resolve) => { stalled.on('close', resolve); setTimeout(resolve, 8000); });
  stalled.destroy();
  assert.ok(Date.now() - tStall < 7000, `молчащее тело держалось ${Date.now() - tStall} мс`);
  assert.ok(stalled.reply === '' || /^HTTP\/1\.1 408/.test(stalled.reply), stalled.reply.slice(0, 80));
  assert.ok(!seenDoc.some((r) => r.url.includes('stalled')), 'молчащее тело дошло до Document service');
  let again = null;
  for (let i = 0; i < 20; i++) {
    again = await fetch(base + '/api/projects/p/tx', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    if (again.status !== 429) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(again.status, 200, 'после медленных запись снова проходит');

  // круг 29: сокеты /ws — предел на адрес. 64 открыты и держатся, 65-й — 429 JSON busy;
  // закрыли один — следующий снова проходит
  const wsLimit = Number(/limit_conn\s+\w+\s+(\d+);/.exec(locationBlock(nginxConf, '/ws'))[1]);
  const rawWs = () => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.reply = '';
    sock.on('error', () => resolve(sock));
    sock.on('data', (d) => { sock.reply += d.toString(); if (/\r\n\r\n/.test(sock.reply)) resolve(sock); });
    sock.write('GET /ws?project=p HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    setTimeout(() => resolve(sock), 3000);
  });
  const socks = [];
  try {
    for (let i = 0; i < wsLimit; i++) socks.push(await rawWs());
    assert.ok(socks.every((x) => /^HTTP\/1\.1 101/.test(x.reply)), `не все ${wsLimit} сокетов открылись: ${socks.find((x) => !/^HTTP\/1\.1 101/.test(x.reply))?.reply.slice(0, 60)}`);
    const extra = await rawWs();
    socks.push(extra);
    assert.match(extra.reply, /^HTTP\/1\.1 429/, `сокет сверх ${wsLimit}: ${extra.reply.slice(0, 60)}`);
    assert.match(extra.reply, /"code":"busy"/);
    assert.match(extra.reply, /application\/json/i);
    // записи /api/ предел сокетов не задевает
    const w = await fetch(base + '/api/projects/p/tx', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(w.status, 200);
    socks[0].destroy();
    let next = null;
    for (let i = 0; i < 20; i++) {
      next = await rawWs();
      socks.push(next);
      if (/^HTTP\/1\.1 101/.test(next.reply)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(next.reply, /^HTTP\/1\.1 101/, 'после закрытия сокета новый снова проходит');
  } finally {
    for (const x of socks) x.destroy();
  }

  // апстрим лежит — JSON с upstream и X-Imago-Upstream: down
  await orch.close();
  orchUp = false;
  const down = await fetch(base + '/agent/command', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(down.status, 502);
  assert.equal(down.headers.get('x-imago-upstream'), 'down');
  assert.ok(down.headers.get('retry-after'));
  const body = await down.json();
  assert.deepEqual(
    { error: body.error, upstream: body.upstream, retryable: body.retryable, code: body.code },
    { error: true, upstream: 'orchestrator', retryable: true, code: 'upstream_down' },
  );
});

test('ЗАПУСК.md говорит то же, что код (круг 27, п.9)', async () => {
  const doc = read('ЗАПУСК.md');
  // пачка миграции 003 — как в коде
  const mig = read('server/document/storage/migrations/003_chain_backfill.mjs');
  const batch = Number(/const BATCH = (\d+)/.exec(mig)[1]);
  assert.match(doc, new RegExp(`пачками по ${batch} записей`));
  // без Docker агента на сервере нет: «агент недоступен», пока не включена модель браузера
  const solo = doc.slice(doc.indexOf('## Без Docker'));
  assert.doesNotMatch(solo, /агент тогда работает в браузере/);
  assert.match(solo, /агент недоступен/);
  assert.match(solo, /пока вы не включите модель/);
  // слова llm_down и shutting_down — те, что показывает оболочка
  const { agentErrorWords } = await import('../src/shell.js');
  const down = agentErrorWords({ code: 'llm_down' });
  assert.ok(doc.includes(`«${down.title}»`), 'llm_down: заголовок не тот, что в коде');
  assert.ok(doc.includes(`«${down.note}.»`) || doc.includes(`«${down.note}»`), 'llm_down: подпись не та, что в коде');
  const restart = agentErrorWords({ code: 'shutting_down' });
  assert.ok(doc.includes(`«${restart.title}»`), 'shutting_down: заголовок не тот, что в коде');
  // круг 29: пропавший проект — слова карточки и то, что работа переживает перезагрузку
  const { PROJECT_GONE_WORDS } = await import('../src/shell.js');
  assert.ok(doc.includes(`«${PROJECT_GONE_WORDS.title}»`));
  assert.ok(doc.includes(`«${PROJECT_GONE_WORDS.action}»`));
  assert.match(doc, /переживает\s+и перезагрузку страницы/);
  // J4: хранилище лежит — те же слова, что в строке состояния
  assert.match(doc, /«сервер не может сохранить — правки\s+ждут»/);
  assert.ok(read('app.js').includes('сервер не может сохранить — правки ждут'));
  // предел сокетов с адреса — тот же, что в nginx
  const ws = Number(/limit_conn\s+\w+\s+(\d+);/.exec(locationBlock(nginxConf, '/ws'))[1]);
  assert.match(doc, new RegExp(`${ws}\\s+сокетов`));
});
