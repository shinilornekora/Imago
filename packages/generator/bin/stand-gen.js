#!/usr/bin/env node
// Тонкая обёртка: запускает CLI генератора через tsx (без сборки).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const r = spawnSync(process.execPath, ['--import', 'tsx', cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
