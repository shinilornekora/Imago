// @ts-check
/**
 * Пароли тестовых учёток стенда. Держатся ЗДЕСЬ (в измерительной оболочке), а не в клиенте:
 * production-сборка клиента их не содержит (`packages/client/src/config.ts`, §1.6), поэтому
 * `?autologin=<login>` дополняется паролем тем, кто открывает клиент (через контекст страницы,
 * а не через строку запроса — §N9).
 *
 * КОНФИГУРАЦИИ СЕРИЙ ПАРОЛЬ НЕ СОДЕРЖАТ (`packages/bench/series/*.json`, ключ `api`): он берётся
 * отсюда либо из среды (`STAND_ALICE_PASSWORD`, `STAND_BOB_PASSWORD`). Иначе он копировался бы в
 * `passport.json` вместе с `seriesConfig` — так и было до 2026-09-13 во всех одиннадцати паспортах
 * опубликованной программы (дефект «пароль в паспорте»). Паспорт вдобавок пропускает конфигурацию
 * через `redactSecrets()` — две независимые меры.
 */
export const TEST_PASSWORDS = /** @type {Record<string,string>} */ ({
  alice: process.env.STAND_ALICE_PASSWORD || 'alice-pass',
  bob: process.env.STAND_BOB_PASSWORD || 'bob-pass',
});

/** @param {string|null|undefined} login @returns {string|null} */
export function passwordFor(login) {
  return login ? (TEST_PASSWORDS[login] ?? null) : null;
}
