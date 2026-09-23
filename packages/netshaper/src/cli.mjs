// @ts-check
/**
 * CLI: netshaper --listen 8080 --routes '/api=127.0.0.1:3000,/zero=127.0.0.1:4848,/=127.0.0.1:3000'
 *                --delay-ms 25 --bandwidth-mbit 20 --stats-port 8081
 */

import { parseArgs } from 'node:util';
import { startNetshaper } from './index.mjs';

const HELP = `netshaper — TCP/HTTP шейпер и маршрутизатор стенда (SPEC §7.1)

  --listen <port>          клиентский порт (по умолчанию 8080)
  --host <addr>            адрес прослушивания (127.0.0.1)
  --routes <spec>          '/api=127.0.0.1:3000,/zero=127.0.0.1:4848,/=127.0.0.1:3000'
                           суффикс ';strip' у upstream убирает префикс из пути
  --delay-ms <ms>          односторонняя задержка (25 → RTT 50)
  --bandwidth-mbit <mbit>  полоса в каждую сторону (20); 0 — без ограничения
  --bucket-ms <ms>         ёмкость token bucket в мс передачи (20 → ≈50 КБ при 20 Мбит/с)
  --segment-bytes <n>      максимальный сегмент пейсинга (4096)
  --handshake-rtt          эмулировать TCP-рукопожатие: RTT до первых байтов каждого нового
                           соединения (ВКЛЮЧЕНО по умолчанию, SPEC §7.1)
  --no-handshake-rtt       выключить эмуляцию рукопожатия (соединения бесплатны — смещение в
                           пользу адаптеров, открывающих больше соединений)
  --stats-port <port>      служебный порт статистики (8081); 'none' — не поднимать
  --quiet                  не печатать сводку
  --help
`;

/** @param {string[]} argv */
export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      listen: { type: 'string', default: '8080' },
      host: { type: 'string', default: '127.0.0.1' },
      routes: { type: 'string', default: '/api=127.0.0.1:3000,/zero=127.0.0.1:4848,/=127.0.0.1:3000' },
      'delay-ms': { type: 'string', default: '25' },
      'bandwidth-mbit': { type: 'string', default: '20' },
      'bucket-ms': { type: 'string', default: '20' },
      'segment-bytes': { type: 'string', default: '4096' },
      'handshake-rtt': { type: 'boolean', default: true },
      'no-handshake-rtt': { type: 'boolean', default: false },
      'stats-port': { type: 'string', default: '8081' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return {
    help: values.help,
    quiet: values.quiet,
    listen: Number(values.listen),
    host: values.host,
    routes: /** @type {string} */ (values.routes),
    delayMs: Number(values['delay-ms']),
    bandwidthMbit: Number(values['bandwidth-mbit']),
    bucketMs: Number(values['bucket-ms']),
    segmentBytes: Number(values['segment-bytes']),
    handshakeRtt: values['no-handshake-rtt'] ? false : values['handshake-rtt'],
    statsPort: values['stats-port'] === 'none' ? null : Number(values['stats-port']),
  };
}

/** @param {string[]} argv */
export async function main(argv) {
  const cfg = parseCli(argv);
  if (cfg.help) {
    process.stdout.write(HELP);
    return;
  }
  const sh = await startNetshaper({
    ...cfg,
    log: cfg.quiet ? undefined : (m) => process.stderr.write(`[netshaper] ${m}\n`),
  });
  if (!cfg.quiet) {
    process.stderr.write(
      `[netshaper] listening on ${cfg.host}:${sh.listenPort}; delay ${cfg.delayMs} ms/way, ` +
        `${cfg.bandwidthMbit || '∞'} Mbit/s/way, bucket ${cfg.bucketMs} ms` +
        (cfg.handshakeRtt ? `, handshake RTT ${2 * cfg.delayMs} ms per new connection` : ', NO handshake RTT') +
        `; stats ${sh.statsPort === null ? 'disabled' : `http://127.0.0.1:${sh.statsPort}/stats`}\n`,
    );
    for (const r of sh.proxy.routes) process.stderr.write(`[netshaper]   ${r.prefix.padEnd(8)} → ${r.host}:${r.port}${r.strip ? ' (strip)' : ''}\n`);
  }
  const shutdown = () => {
    sh.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
