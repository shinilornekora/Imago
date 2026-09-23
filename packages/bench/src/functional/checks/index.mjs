// @ts-nocheck — сценарные скрипты Playwright над window.__stand (динамические структуры событий/снимков); JSDoc-типизация не ведётся
/** Порядок проверок = порядок строк таблицы 1 + безопасность + инварианты режимов. */
import open from './01-open.mjs';
import localFill from './02-local-fill.mjs';
import sourceFill from './03-source-fill.mjs';
import lateNav from './04-late-nav.mjs';
import staleRead from './05-stale-read.mjs';
import retry from './06-retry.mjs';
import security from './07-security.mjs';
import invariants from './08-invariants.mjs';

export const CHECKS = [open, localFill, sourceFill, lateNav, staleRead, retry, ...security, ...invariants];
