#!/usr/bin/env node
// @ts-check
/**
 * Одиночный прогон приёмочного сценария (отладка без серии):
 *   node src/scenario/cli.mjs --base http://127.0.0.1:8080 --adapter H --mode P --cache 1 \
 *        --doc <docId> --source <sourceId> --fill '#ff8800' [--out run.json] [--headed] [--pause-ms 1000]
 * Печатает сводку; полный результат — в --out.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { runAcceptanceScenario } from './acceptance.mjs';
import { attachCdp, startChromiumSampler } from '../sampling/chromium.mjs';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:8080' },
    adapter: { type: 'string', default: 'H' },
    mode: { type: 'string', default: 'P' },
    cache: { type: 'string', default: '1' },
    doc: { type: 'string' },
    source: { type: 'string' },
    fill: { type: 'string', default: '#ff8800' },
    autologin: { type: 'string', default: 'alice' },
    out: { type: 'string' },
    headed: { type: 'boolean', default: false },
    'pause-ms': { type: 'string', default: '1000' },
    'step-timeout-ms': { type: 'string', default: '20000' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});
if (values.help || !values.doc || !values.source) {
  process.stdout.write('usage: node src/scenario/cli.mjs --doc <id> --source <sourceId> [--base URL] [--adapter H|Q|Z] [--mode F|P] [--cache N] [--fill #rrggbb] [--out file.json] [--headed]\n');
  process.exit(values.help ? 0 : 2);
}
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const browser = await chromium.launch({ headless: !values.headed, channel: 'chromium', args: ['--disable-extensions'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const cdp = await attachCdp(page);
const sampler = startChromiumSampler(browser);
const rec = await runAcceptanceScenario(page, {
  baseUrl: /** @type {string} */ (values.base),
  adapter: /** @type {string} */ (values.adapter),
  mode: /** @type {string} */ (values.mode),
  cache: Number(values.cache),
  doc: values.doc,
  sourceId: values.source,
  fill: /** @type {string} */ (values.fill),
  autologin: values.autologin,
  pauseMs: Number(values['pause-ms']),
  stepTimeoutMs: Number(values['step-timeout-ms']),
  probes: { heap: cdp.heap },
  log: (m) => process.stderr.write(m + '\n'),
});
const chromiumMem = sampler.stop();
const network = cdp.network();
await cdp.detach();
await context.close();
await browser.close();
const out = { ...rec, cdp: network, chromium: chromiumMem };
if (values.out) fs.writeFileSync(values.out, JSON.stringify(out, null, 2) + '\n');
process.stdout.write(
  JSON.stringify(
    {
      outcome: rec.outcome,
      errorStage: rec.errorStage,
      t_first_ready: rec.t_first_ready,
      t_nav: rec.t_nav.map((/** @type {number} */ x) => Math.round(x)),
      t_cmd_ack: rec.t_cmd_ack,
      t_cmd_drawn: rec.t_cmd_drawn,
      t_scenario: rec.t_scenario,
      js_heap_peak_mib: rec.js_heap_peak_mib,
      chromium_private_peak_mib: chromiumMem.private_peak_mib,
      cdp_bytes_in: network.bytesIn,
      retained_end: rec.retained_end,
    },
    null,
    2,
  ) + '\n',
);
