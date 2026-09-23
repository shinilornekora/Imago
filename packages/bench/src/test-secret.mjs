// @ts-check
/**
 * Общая тайна тестовых хуков API (`x-stand-test-secret`, SPEC §2.3, §1.6).
 *
 * Источник (в порядке приоритета): переменная среды `STAND_TEST_HOOKS_SECRET` (её ставит
 * `scripts/lib.sh`) → файл `results/logs/.test-secret`, который тот же `lib.sh` создаёт при первом
 * старте стенда (режим 600, в `.gitignore`). Пустая строка = сервер запущен без секрета
 * (`config.testHooksSecret === ''`), и заголовок не нужен — тогда его просто не отправляем.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} [rootDir]  корень стенда (там, где `results/`)
 * @returns {string}          секрет или '' (хуки без секрета)
 */
export function readTestHooksSecret(rootDir) {
  const fromEnv = process.env.STAND_TEST_HOOKS_SECRET;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.trim();
  const file = process.env.STAND_TEST_SECRET_FILE || (rootDir ? path.join(rootDir, 'results', 'logs', '.test-secret') : null);
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Заголовки для запроса к `/api/test/*` (пустой объект, если секрета нет).
 * @param {string} [rootDir]
 * @returns {Record<string, string>}
 */
export function testHookHeaders(rootDir) {
  const s = readTestHooksSecret(rootDir);
  return s ? { 'x-stand-test-secret': s } : {};
}
