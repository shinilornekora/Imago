// @ts-check
/**
 * Сэмплер выделенного экземпляра Chromium (SPEC §7.3):
 *  - chromium_private_peak/end — сумма Private_Clean+Private_Dirty по ВСЕМ процессам
 *    экземпляра (главный pid `browser.process().pid` + потомки по ppid), опрос 250 мс;
 *    если pid не определился или процессы не читаются, сводка отдаёт `matched:false`,
 *    `unmatched_reason` и **null** вместо нулей (тихий 0 в CSV недопустим — критик B, п. 15);
 *  - JS heap — CDP `Runtime.getHeapUsage` (fallback `performance.memory`) по шагам сценария;
 *  - байты по CDP `Network.*` — перекрёстная проверка счётчиков шейпера.
 */

import { performance } from 'node:perf_hooks';
import { PARTIAL_COVERAGE } from './procs.mjs';
import { descendants, parentMap, readMemory, listPids, readCmdline, readStat } from './procfs.mjs';
import { probeMark, probeTouched } from './probe-windows.mjs';

const MIB = 1024 * 1024;

/**
 * PID главного процесса Chromium, запущенного Playwright'ом.
 * 1) в in-process режиме Node-клиента Playwright (1.56) серверный объект доступен через
 *    `browser._connection.toImpl(browser)` → `options.browserProcess.process.pid`;
 * 2) fallback: процесс-потомок текущего процесса, чей cmdline содержит `marker`
 *    (уникальный аргумент, переданный в `args` при запуске; Chromium игнорирует
 *    неизвестные ключи) либо просто «chrom» — берётся самый молодой.
 * @param {import('playwright').Browser} browser
 * @param {{marker?: string}} [opts]
 * @returns {number | null}
 */
export function browserPid(browser, opts = {}) {
  try {
    const b = /** @type {any} */ (browser);
    const impl = b._connection?.toImpl?.(b);
    const pid = impl?.options?.browserProcess?.process?.pid;
    if (typeof pid === 'number' && pid > 0) return pid;
  } catch {
    /* другой транспорт */
  }
  /** @type {{pid: number, start: number}[]} */
  const candidates = [];
  for (const pid of listPids()) {
    const st = readStat(pid);
    if (!st || st.ppid !== process.pid) continue;
    const cmd = readCmdline(pid);
    if (opts.marker ? cmd.includes(opts.marker) : /chrom/i.test(cmd)) candidates.push({ pid, start: st.startTimeTicks });
  }
  candidates.sort((a, b) => b.start - a.start);
  return candidates[0]?.pid ?? null;
}

/**
 * @typedef {object} ChromiumSample
 * @property {number} t
 * @property {number} processes
 * @property {number} privateMib
 * @property {number} rssMib
 * @property {true} [probe]   выборка пересеклась с окном измерительной пробы инструмента
 *                            (точный скан хранилища, выгрузка снимков) — sampling/probe-windows.mjs
 */

/**
 * @typedef {object} ChromiumSummary
 * @property {number | null} pid
 * @property {boolean} matched              pid найден И хотя бы один опрос увидел живые процессы экземпляра;
 *                                          при false все значения памяти — null (НЕ 0), см. `unmatched_reason`
 * @property {boolean} partial             процессы видны лишь в части опросов (< PARTIAL_COVERAGE):
 *                                          пик и конечная память заведомо занижены (дефект N6)
 * @property {number} coverage              matched_ticks / expected_ticks, 0..1
 * @property {string | null} unmatched_reason
 * @property {number} matched_ticks         число опросов, в которых нашёлся хотя бы один процесс
 * @property {number} expected_ticks        сколько всего было опросов
 * @property {number | null} private_peak_mib              СЫРОЙ пик (все выборки, включая окна проб инструмента)
 * @property {number | null} private_peak_excl_probe_mib   пик по выборкам ВНЕ окон проб инструмента
 * @property {number} probe_ticks                          сколько выборок пришлось на окна проб
 * @property {number} sampler_t0_ms                        абсолютное performance.now() старта сэмплера
 * @property {number | null} private_end_mib
 * @property {number | null} rss_peak_mib
 * @property {number} processes_peak
 * @property {boolean} mem_fallback_rss
 * @property {number} sample_count
 * @property {ChromiumSample[]} samples
 */

/**
 * @param {import('playwright').Browser} browser
 * @param {{intervalMs?: number, keepSamples?: boolean, marker?: string, probeWindows?: import('./probe-windows.mjs').ProbeWindows|null}} [opts]
 *        probeWindows — реестр окон измерительных проб оболочки (см. probe-windows.mjs). Выборки,
 *        пересёкшиеся с окном, помечаются `probe:true` и не входят в `private_peak_excl_probe_mib`:
 *        иначе пик Chromium содержит материализацию строк, сделанную САМИМ инструментом, и притом
 *        по-разному у разных адаптеров (скан у Z на 50×500 — ≈955 мс против ≈39 мс у H).
 */
export function startChromiumSampler(browser, opts = {}) {
  const intervalMs = opts.intervalMs ?? 250;
  const keepSamples = opts.keepSamples ?? true;
  const probeWindows = opts.probeWindows ?? null;
  const pid = browserPid(browser, { marker: opts.marker });
  const t0 = performance.now();
  let peak = 0;
  let peakExcl = NaN;
  let probeTicks = 0;
  let rssPeak = 0;
  let end = 0;
  let procPeak = 0;
  let fallback = false;
  let count = 0;
  let matchedTicks = 0;
  /** @type {ChromiumSample[]} */
  const samples = [];
  const tick = () => {
    if (pid === null) {
      count++;
      return; // pid не определился — НИЧЕГО не накапливаем: сводка отдаст matched:false и null, а не 0
    }
    // метка окна пробы — ДО чтения /proc (опрос всех процессов Chromium длится десятки мс)
    const mark = probeMark(probeWindows);
    const pids = descendants([pid], parentMap());
    let priv = 0;
    let rss = 0;
    let n = 0;
    for (const p of pids) {
      const m = readMemory(p);
      if (!m) continue;
      n++;
      priv += m.privateBytes;
      rss += m.rssBytes;
      if (m.fallback) fallback = true;
    }
    const privMib = priv / MIB;
    count++;
    if (n === 0) return; // процессы экземпляра не читаются (уже закрыт / нет доступа к /proc) — не записываем 0
    matchedTicks += 1;
    peak = Math.max(peak, privMib);
    const inProbe = probeTouched(probeWindows, mark);
    if (inProbe) probeTicks += 1;
    else peakExcl = Math.max(Number.isFinite(peakExcl) ? peakExcl : 0, privMib);
    rssPeak = Math.max(rssPeak, rss / MIB);
    procPeak = Math.max(procPeak, n);
    end = privMib;
    if (keepSamples) samples.push({ t: Math.round(performance.now() - t0), processes: n, privateMib: +privMib.toFixed(2), rssMib: +(rss / MIB).toFixed(2), ...(inProbe ? { probe: /** @type {true} */ (true) } : {}) });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  /** @returns {ChromiumSummary} */
  const summarize = () => {
    const matched = pid !== null && matchedTicks > 0;
    // полнота выборки — доля опросов, в которых процессы экземпляра были видны (дефект N6)
    const coverage = count > 0 ? matchedTicks / count : 0;
    const partial = matched && coverage < PARTIAL_COVERAGE;
    const reason =
      pid === null
        ? 'pid главного процесса Chromium не определён (browserPid → null)'
        : matchedTicks === 0
          ? `ни один опрос не увидел процессов экземпляра (pid ${pid})`
          : partial
            ? `процессы экземпляра видны лишь в ${matchedTicks} из ${count} опросов (${(coverage * 100).toFixed(0)} %): пик частной памяти заведомо занижен`
            : null;
    return {
      pid,
      matched,
      partial,
      coverage: +coverage.toFixed(4),
      unmatched_reason: reason,
      matched_ticks: matchedTicks,
      expected_ticks: count,
      private_peak_mib: matched ? +peak.toFixed(2) : null,
      private_peak_excl_probe_mib: matched && Number.isFinite(peakExcl) ? +peakExcl.toFixed(2) : null,
      probe_ticks: probeTicks,
      sampler_t0_ms: t0,
      private_end_mib: matched ? +end.toFixed(2) : null,
      rss_peak_mib: matched ? +rssPeak.toFixed(2) : null,
      processes_peak: procPeak,
      mem_fallback_rss: fallback,
      sample_count: count,
      samples,
    };
  };
  return {
    snapshot: () => summarize(),
    stop: () => {
      clearInterval(timer);
      // финальный опрос делаем до закрытия браузера — вызывающий код должен stop() до browser.close()
      tick();
      return summarize();
    },
  };
}

/**
 * Обёртка над CDP-сессией страницы: JS heap и сетевые счётчики.
 * @param {import('playwright').Page} page
 */
export async function attachCdp(page) {
  const cdp = await page.context().newCDPSession(page);
  let bytesIn = 0; // encodedDataLength завершённых HTTP-ответов
  let bytesOut = 0; // оценка: заголовки + тело запросов
  let wsIn = 0;
  let wsOut = 0;
  let requests = 0;
  // Чтения страниц документа по HTTP (GET /api/documents/<doc>/pages/<page>) — прямая мера
  // «сколько раз страница читалась заново» у H и Q (у Z страницы приходят синхронизацией и
  // сюда не попадают: там та же величина наблюдается по промахам окна кеша, см. acceptance.mjs).
  let pageReads = 0;
  let pageReadBytes = 0;
  /** @type {Map<string, string>} */
  const pageReadRequests = new Map(); // requestId → pageId
  /** @type {Map<string, number>} */
  const pageReadsByPage = new Map();
  /** @type {Map<string, number>} */
  const seen = new Map();
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => {
    requests++;
    const r = e.request;
    const m = /\/api\/documents\/[^/?#]+\/pages\/([^/?#]+)/.exec(String(r.url ?? ''));
    if (m && (r.method ?? 'GET').toUpperCase() === 'GET') {
      pageReads++;
      pageReadRequests.set(e.requestId, m[1]);
      pageReadsByPage.set(m[1], (pageReadsByPage.get(m[1]) ?? 0) + 1);
    }
    let est = `${r.method} ${r.url} HTTP/1.1\r\n`.length;
    for (const [k, v] of Object.entries(r.headers ?? {})) est += k.length + 2 + String(v).length + 2;
    est += 2;
    if (r.postData) est += Buffer.byteLength(r.postData);
    else if (typeof e.request.postDataEntries !== 'undefined') for (const pe of e.request.postDataEntries ?? []) est += pe.bytes ? Buffer.from(pe.bytes, 'base64').length : 0;
    bytesOut += est;
  });
  cdp.on('Network.loadingFinished', (e) => {
    if (seen.has(e.requestId)) return;
    seen.set(e.requestId, e.encodedDataLength);
    bytesIn += e.encodedDataLength ?? 0;
    if (pageReadRequests.has(e.requestId)) pageReadBytes += e.encodedDataLength ?? 0;
  });
  cdp.on('Network.webSocketFrameReceived', (e) => {
    wsIn += Buffer.byteLength(e.response?.payloadData ?? '') + 2;
  });
  cdp.on('Network.webSocketFrameSent', (e) => {
    wsOut += Buffer.byteLength(e.response?.payloadData ?? '') + 6;
  });

  /** @returns {Promise<{usedMib: number, totalMib: number, source: string}>} */
  const heap = async () => {
    try {
      const r = /** @type {{usedSize: number, totalSize: number}} */ (await cdp.send('Runtime.getHeapUsage'));
      return { usedMib: +(r.usedSize / MIB).toFixed(2), totalMib: +(r.totalSize / MIB).toFixed(2), source: 'cdp' };
    } catch {
      try {
        const m = await page.evaluate(() => {
          const pm = /** @type {any} */ (performance).memory;
          return pm ? { used: pm.usedJSHeapSize, total: pm.totalJSHeapSize } : null;
        });
        if (m) return { usedMib: +(m.used / MIB).toFixed(2), totalMib: +(m.total / MIB).toFixed(2), source: 'performance.memory' };
      } catch {
        /* страница закрыта */
      }
      return { usedMib: NaN, totalMib: NaN, source: 'unavailable' };
    }
  };

  return {
    cdp,
    heap,
    network: () => ({
      bytesIn,
      bytesOut,
      wsIn,
      wsOut,
      requests,
      pageReads,
      pageReadBytes,
      pageReadsByPage: Object.fromEntries(pageReadsByPage),
      pageReadsDistinct: pageReadsByPage.size,
    }),
    detach: async () => {
      try {
        await cdp.detach();
      } catch {
        /* уже закрыто */
      }
    },
  };
}
