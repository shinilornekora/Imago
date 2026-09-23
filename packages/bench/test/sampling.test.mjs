// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProcSampler } from '../src/sampling/procs.mjs';
import { startChromiumSampler, attachCdp, browserPid } from '../src/sampling/chromium.mjs';
import { descendants, findPidsByCmdline, parentMap, readMemory, readStat, dirSizeBytes, clockTicks } from '../src/sampling/procfs.mjs';
import { createProbeWindows, probeMark, probeTouched } from '../src/sampling/probe-windows.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test('procfs primitives: stat, memory, parent map, descendants, cmdline search', () => {
  const st = readStat(process.pid);
  assert.ok(st && st.pid === process.pid && st.ppid > 0 && st.comm.length > 0);
  const mem = readMemory(process.pid);
  assert.ok(mem && mem.privateBytes > 1024 * 1024 && mem.rssBytes >= mem.privateBytes * 0.5, JSON.stringify(mem));
  assert.equal(mem.fallback, false, 'smaps_rollup should be readable for own process');
  const parents = parentMap();
  assert.equal(parents.get(process.pid), st.ppid);
  const d = descendants([process.pid], parents);
  assert.ok(d.has(process.pid));
  assert.ok(clockTicks() > 0);
  // поиск себя по cmdline исключён (excludePids содержит process.pid)
  assert.ok(!findPidsByCmdline(['sampling\\.test\\.mjs']).includes(process.pid));
});

test('proc sampler: CPU time and private memory of a child process tree (with grandchildren)', async () => {
  // родитель запускает внука, который жжёт CPU и держит ~64 МиБ
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', \`
      const buf = Buffer.alloc(64 * 1024 * 1024, 1); // private память
      const end = Date.now() + 1200; let x = 0;
      while (Date.now() < end) { x += Math.sqrt(x + 1); }
      process.stdout.write(String(buf.length));
      setTimeout(() => {}, 300);
    \`], { stdio: 'inherit' });
    child.on('exit', () => process.exit(0));
  `;
  const tag = `stand-bench-marker-${process.pid}`;
  const proc = spawn(process.execPath, ['-e', script, tag], { stdio: 'ignore' });
  await sleep(150);
  // потомки самой оболочки по умолчанию исключены (защита от учёта Chromium как «сервера»)
  const guarded = startProcSampler({ groups: [{ name: 'api', patterns: [tag] }], intervalMs: 100 });
  await sleep(120);
  assert.deepEqual(guarded.stop().api.pids, [], 'own children are excluded unless allowSelfTree');
  const sampler = startProcSampler({ groups: [{ name: 'api', patterns: [tag], allowSelfTree: true }, { name: 'pg', patterns: ['definitely-no-such-process-zzz'] }], intervalMs: 100 });
  await new Promise((r) => proc.on('exit', r));
  const summary = sampler.stop();
  const api = summary.api;
  console.log(`  api: cpu_ms=${api.cpu_ms} mem_peak=${api.mem_peak_mib} MiB integral=${api.mem_integral_mib_s} MiB·s samples=${api.sample_count} pids=${api.pids.length}`);
  assert.ok(api.pids.length >= 2, 'parent + grandchild discovered via ppid');
  assert.ok(api.cpu_ms >= 800 && api.cpu_ms <= 2500, `cpu_ms=${api.cpu_ms}`);
  assert.ok(api.mem_peak_mib >= 64 && api.mem_peak_mib < 400, `mem_peak_mib=${api.mem_peak_mib}`);
  assert.ok(api.mem_integral_mib_s > 30, `integral=${api.mem_integral_mib_s}`);
  assert.ok(api.sample_count >= 8);
  assert.equal(api.mem_fallback_rss, false);
  assert.ok(api.samples.length === api.sample_count && api.samples.every((s) => typeof s.t === 'number'));
  const pg = summary.pg;
  assert.equal(pg.cpu_ms, 0);
  assert.equal(pg.mem_peak_mib, 0);
  assert.deepEqual(pg.pids, []);
});

test('proc sampler: directory size tracking (zero replica)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dir-'));
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1000));
  const sampler = startProcSampler({ groups: [{ name: 'zero', pids: [process.pid], includeChildren: false, allowSelfTree: true, dir }], intervalMs: 50 });
  await sleep(120);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(5000));
  await sleep(150);
  const s = sampler.stop().zero;
  assert.equal(s.disk_start_bytes, 1000);
  assert.equal(s.disk_end_bytes, 6000);
  assert.equal(s.disk_peak_bytes, 6000);
  assert.equal(dirSizeBytes(path.join(dir, 'nope')), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chromium sampler: sums private memory over all browser processes; CDP heap works', async () => {
  const marker = `--stand-run=test-${process.pid}`;
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-extensions', marker] });
  try {
    const viaImpl = browserPid(browser);
    const viaProc = browserPid(/** @type {any} */ ({}), { marker });
    console.log(`  pid via impl=${viaImpl} via /proc marker=${viaProc}`);
    assert.ok(viaImpl && viaImpl > 0);
    assert.equal(viaProc, viaImpl, 'fallback /proc scan finds the same main process');
    const sampler = startChromiumSampler(browser, { intervalMs: 100 });
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await attachCdp(page);
    await page.setContent('<html><body><script>window.big = new Array(2e6).fill({a:1});</script>ok</body></html>');
    const heap = await cdp.heap();
    await sleep(350);
    const s = sampler.stop();
    console.log(`  chromium pid=${s.pid} processes_peak=${s.processes_peak} private_peak=${s.private_peak_mib} MiB end=${s.private_end_mib} MiB heap=${heap.usedMib} MiB (${heap.source})`);
    assert.ok(s.pid && s.pid > 0);
    assert.ok(s.processes_peak >= 3, 'browser + renderer + gpu/utility processes');
    assert.ok(s.private_peak_mib > 50 && s.private_peak_mib < 3000, `private_peak=${s.private_peak_mib}`);
    assert.ok(s.private_end_mib > 0 && s.private_end_mib <= s.private_peak_mib);
    assert.ok(s.sample_count >= 3);
    assert.equal(heap.source, 'cdp');
    assert.ok(heap.usedMib > 1 && heap.usedMib < 2000, `heap=${heap.usedMib}`);
    await cdp.detach();
    await context.close();
  } finally {
    await browser.close();
  }
});

test('окна проб: реестр считает окна, вложенность схлопывается, «сквозная» выборка помечается', async () => {
  const pw = createProbeWindows();
  assert.equal(pw.active(), false);
  pw.begin('exact-retained');
  pw.begin('vnutri'); // вложенное окно не открывает второго
  assert.equal(pw.active(), true);
  pw.end();
  assert.equal(pw.active(), true, 'внешнее окно ещё открыто');
  await sleep(20);
  pw.end();
  assert.equal(pw.active(), false);
  const sum = pw.summary();
  assert.equal(sum.count, 1, 'вложенные окна схлопнуты в одно');
  assert.ok(sum.total_ms >= 15, JSON.stringify(sum));
  assert.equal(sum.windows[0].label, 'exact-retained');
  // выборка, начатая ДО окна и закончившаяся ПОСЛЕ него, обязана считаться попавшей в пробу
  const mark = probeMark(pw);
  pw.begin('exact-retained');
  pw.end();
  assert.equal(probeTouched(pw, mark), true, 'окно открылось и закрылось внутри опроса');
  assert.equal(probeTouched(pw, probeMark(pw)), false);
  assert.equal(probeTouched(null, null), false, 'без реестра сэмплер работает как раньше');
});

test('сэмплер /proc: выборки внутри окна пробы помечены и не входят в пик без пробы', async () => {
  const pw = createProbeWindows();
  const sampler = startProcSampler({ groups: [{ name: 'self', pids: [process.pid], allowSelfTree: true, includeChildren: false }], intervalMs: 20, probeWindows: pw });
  await sleep(80);
  pw.begin('exact-retained');
  // аллокация внутри окна — то, что инструмент делает сам (точный скан хранилища)
  const ballast = Array.from({ length: 400_000 }, (_, i) => ({ i, s: 'x'.repeat(8) }));
  await sleep(120);
  assert.equal(ballast.length, 400_000);
  pw.end();
  await sleep(80);
  const g = sampler.stop().self;
  assert.ok(g.probe_ticks > 0, 'ни одна выборка не попала в окно пробы');
  assert.ok(g.samples.some((x) => x.probe === true), 'выборки внутри окна не помечены');
  assert.ok(g.samples.some((x) => x.probe === undefined), 'нет выборок вне окна');
  const maxExcl = Math.max(...g.samples.filter((x) => x.probe === undefined).map((x) => x.privateMib));
  assert.equal(g.mem_peak_excl_probe_mib, +maxExcl.toFixed(2), 'пик без пробы = максимум по непомеченным выборкам');
  assert.ok(g.mem_peak_excl_probe_mib <= g.mem_peak_mib);
  assert.ok(typeof g.sampler_t0_ms === 'number');
});
