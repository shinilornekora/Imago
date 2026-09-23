// @ts-check
/**
 * Программный интерфейс шейпера (используется тестами и измерительной оболочкой).
 *
 * @example
 *   const sh = await startNetshaper({ listen: 8080, routes: '/api=127.0.0.1:3000,/=127.0.0.1:3000',
 *                                     delayMs: 25, bandwidthMbit: 20, statsPort: 8081 });
 *   sh.stats(); sh.reset(); sh.configure({ delayMs: 75 }); await sh.close();
 */

import { ShapingProxy, parseRoutes, matchRoute } from './proxy.mjs';
import { startStatsServer } from './stats-server.mjs';
import { Link } from './link.mjs';
import { ShapedSocket } from './shaped-socket.mjs';

export { ShapingProxy, parseRoutes, matchRoute, startStatsServer, Link, ShapedSocket };

/**
 * @typedef {import('./proxy.mjs').ProxyOptions & { statsPort?: number | null, statsHost?: string }} NetshaperOptions
 */

/**
 * @param {NetshaperOptions} opts
 */
export async function startNetshaper(opts) {
  const proxy = new ShapingProxy(opts);
  const listenPort = await proxy.listen();
  /** @type {Awaited<ReturnType<typeof startStatsServer>> | null} */
  let stats = null;
  if (opts.statsPort !== null && opts.statsPort !== undefined) {
    try {
      stats = await startStatsServer(proxy, { port: opts.statsPort, host: opts.statsHost });
    } catch (err) {
      await proxy.close();
      throw err;
    }
  }
  return {
    proxy,
    listenPort,
    statsPort: stats?.port ?? null,
    stats: () => proxy.stats(),
    reset: () => proxy.reset(),
    /** @param {{delayMs?: number, bandwidthMbit?: number, bucketMs?: number}} cfg */
    configure: (cfg) => proxy.configure(cfg),
    close: async () => {
      await stats?.close();
      await proxy.close();
    },
  };
}
