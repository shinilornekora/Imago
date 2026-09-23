// @ts-check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startNetshaper } from '@stand/netshaper';
import { startFakeServer } from './fakes/fake-server.mjs';
import { runAcceptanceScenario } from '../src/scenario/acceptance.mjs';
import { attachCdp } from '../src/sampling/chromium.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

/** @type {Awaited<ReturnType<typeof startFakeServer>>} */
let fake;
/** @type {Awaited<ReturnType<typeof startNetshaper>>} */
let shaper;
/** @type {import('playwright').Browser} */
let browser;

before(async () => {
  fake = await startFakeServer();
  shaper = await startNetshaper({ listen: 0, routes: `/api=127.0.0.1:${fake.port},/zero=127.0.0.1:${fake.port},/=127.0.0.1:${fake.port}`, delayMs: 25, bandwidthMbit: 20, statsPort: null });
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-extensions'] });
});

after(async () => {
  await browser?.close();
  await shaper?.close();
  await fake?.close();
});

/** @param {Record<string,string>} extraQuery @param {Partial<import('../src/scenario/acceptance.mjs').ScenarioOptions>} [over] */
async function run(extraQuery, over = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await attachCdp(page);
  try {
    const rec = await runAcceptanceScenario(page, {
      baseUrl: `http://127.0.0.1:${shaper.listenPort}`,
      adapter: 'H',
      mode: 'P',
      cache: 1,
      doc: 'doc-fake',
      sourceId: 'S1',
      fill: '#ff8800',
      autologin: 'alice',
      pauseMs: 100,
      stepTimeoutMs: 2500,
      extraQuery,
      probes: { heap: cdp.heap },
      ...over,
    });
    return { rec, network: cdp.network() };
  } finally {
    await cdp.detach();
    await context.close();
  }
}

test('measures programmed delays within ±20 ms and records steps/snapshots', async () => {
  const navMs = [100, 200, 150, 300, 120, 180, 90, 210, 160, 250];
  const { rec, network } = await run({ readyMs: '400', navMs: navMs.join(','), ackMs: '80', drawnMs: '140' });
  assert.equal(rec.outcome, 'ok', rec.errorMessage ?? '');
  // t_first_ready — от navigationStart: readyMs + загрузка страницы через шейпер (RTT 50 мс + разбор), но не более +400 мс
  assert.ok(rec.t_first_ready >= 400 && rec.t_first_ready <= 400 + 400, `t_first_ready=${rec.t_first_ready}`);
  assert.equal(rec.t_nav.length, 10);
  for (let i = 0; i < 10; i++) {
    const d = rec.t_nav[i] - navMs[i];
    assert.ok(d >= -2 && d <= 20, `t_nav[${i + 1}]=${rec.t_nav[i].toFixed(1)} expected ≈ ${navMs[i]} (Δ=${d.toFixed(1)})`);
  }
  assert.ok(Math.abs(rec.t_cmd_ack - 80) <= 20, `t_cmd_ack=${rec.t_cmd_ack}`);
  assert.ok(Math.abs(rec.t_cmd_drawn - 140) <= 25, `t_cmd_drawn=${rec.t_cmd_drawn}`);
  assert.equal(rec.t_nav_new.length, 6);
  assert.equal(rec.t_nav_return.length, 4);
  assert.deepEqual(rec.steps.map((s) => s.page_index), [1, 2, 3, 1, 4, 2, 5, 1, 6, 3, 50]);
  assert.deepEqual(rec.steps.map((s) => s.is_return), [false, false, false, true, false, true, false, true, false, true, false]);
  // retained в P/cache=1: активная + 1
  for (const s of rec.steps.slice(2)) assert.equal(s.retained_pages, 2);
  assert.equal(rec.steps[0].retained_pages, 1);
  assert.equal(rec.retained_pages_max, 2);
  assert.equal(rec.retained_shapes_max, 1000);
  assert.equal(rec.loaded_pages_end, 2);
  assert.ok(rec.steps.every((s) => s.js_heap_mb !== null && s.js_heap_mb > 0), 'heap probe per step');
  assert.ok(rec.js_heap_peak_mib > 0 && rec.js_heap_end_mib > 0);
  assert.equal(rec.command.result.affectedShapes, 100);
  assert.equal(rec.command.opId, rec.events.find((e) => e.type === 'command-sent')?.detail?.opId);
  // снимок страницы 50 содержит изменённые экземпляры и нетронутое переопределение
  const p50 = rec.snapshots['50'].snapshot;
  assert.equal(rec.snapshots['50'].pageId, 'p50');
  assert.equal(p50.shapes.find((s) => s.id === 'p50-inst-a').fill, '#ff8800');
  assert.equal(p50.shapes.find((s) => s.id === 'p50-inst-ovr').fill, '#00ff00');
  // страницы, вытесненные из окна, дают null
  assert.equal(rec.snapshots['4'].snapshot, null);
  assert.equal(rec.snapshots['3'].snapshot !== null, true);
  assert.equal(rec.budgets.firstReady, true);
  assert.equal(rec.budgets.navAll, true);
  assert.equal(rec.budgets.cmdDrawn, true);
  assert.equal(rec.budgets.scenario, true);
  assert.ok(rec.t_scenario > 10 * 100 && rec.t_scenario < 30_000);
  assert.ok(network.bytesIn > 10 * 4096, `cdp bytesIn=${network.bytesIn}`);
  assert.ok(network.requests >= 12);
  assert.equal(typeof rec.client_storage_bytes, 'number');
  assert.equal(rec.transfer.bytesIn > 0, true);
  console.log(`  first_ready=${rec.t_first_ready.toFixed(0)} nav=[${rec.t_nav.map((x) => x.toFixed(0)).join(',')}] ack=${rec.t_cmd_ack.toFixed(0)} drawn=${rec.t_cmd_drawn.toFixed(0)} scenario=${rec.t_scenario.toFixed(0)} wall=${rec.wall_ms}`);
});

test('works without waitFor (journal polling) and without data-page-id (index matching)', async () => {
  const { rec } = await run({ noWaitFor: '1', noPageId: '1', navMs: '120' });
  assert.equal(rec.outcome, 'ok', rec.errorMessage ?? '');
  for (const t of rec.t_nav) assert.ok(t >= 118 && t <= 120 + 45, `t_nav=${t} (polling adds ≤ 25 ms)`);
  assert.equal(rec.snapshots['50'].pageId, 'p50', 'pageId learned from page-ready detail');
});

test('hang on a navigation → outcome timeout with stage nav_3, no throw, partial data kept', async () => {
  const { rec } = await run({ hangAt: 'nav_3' }, { stepTimeoutMs: 600 });
  assert.equal(rec.outcome, 'timeout');
  assert.equal(rec.errorStage, 'nav_3');
  assert.match(rec.errorMessage, /timeout/);
  assert.equal(rec.t_nav.length, 2);
  assert.ok(rec.events.length > 0, 'journal captured');
  assert.equal(Number.isNaN(rec.t_cmd_ack), true);
  assert.ok(rec.wall_ms > 600);
});

test('hang on command-drawn → stage cmd_drawn; ack still measured', async () => {
  const { rec } = await run({ hangAt: 'cmd_drawn' }, { stepTimeoutMs: 600 });
  assert.equal(rec.outcome, 'timeout');
  assert.equal(rec.errorStage, 'cmd_drawn');
  assert.ok(Math.abs(rec.t_cmd_ack - 80) <= 20);
  assert.equal(rec.t_nav.length, 5);
});

test('hang on first ready → stage first_ready', async () => {
  const { rec } = await run({ hangAt: 'first_ready' }, { stepTimeoutMs: 500 });
  assert.equal(rec.outcome, 'timeout');
  assert.equal(rec.errorStage, 'first_ready');
});

test('unreachable page → stage open, outcome error', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const rec = await runAcceptanceScenario(page, { baseUrl: 'http://127.0.0.1:1', adapter: 'H', mode: 'F', cache: 1, doc: 'x', sourceId: 'S1', fill: '#000000', stepTimeoutMs: 1000 });
    assert.equal(rec.outcome, 'error');
    assert.equal(rec.errorStage, 'open');
  } finally {
    await context.close();
  }
});
