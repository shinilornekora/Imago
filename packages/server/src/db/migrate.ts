/**
 * Идемпотентная миграция: применяет schema.sql и сеет тестовых пользователей (SPEC §2.1, §3).
 * Запуск: `npm run migrate -w packages/server` или `scripts/migrate.sh`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_USERS } from '@stand/shared';
import { createSql, type Sql } from './sql.js';
import { hashPassword } from '../auth/password.js';
import { loadConfig } from '../config.js';

export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(here, 'schema.sql');
  const schema = await readFile(schemaPath, 'utf8');
  // Несколько выражений без параметров — простой протокол, одной командой.
  await sql.unsafe(schema);
  log(`schema applied from ${schemaPath}`);

  for (const u of TEST_USERS) {
    // Детерминированная соль, чтобы повторная миграция не переписывала хеш.
    const salt = Buffer.from(`stand-salt-${u.id}`.padEnd(16, '0').slice(0, 16));
    const hash = hashPassword(u.password, salt);
    await sql`
      INSERT INTO users (id, login, password_hash)
      VALUES (${u.id}, ${u.login}, ${hash})
      ON CONFLICT (id) DO UPDATE SET login = EXCLUDED.login, password_hash = EXCLUDED.password_hash
    `;
    log(`user ${u.login} (${u.id}) seeded`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cfg = loadConfig();
  const sql = createSql(cfg.dbUrl, { max: 1, applicationName: 'stand-migrate' });
  migrate(sql, (m) => console.log(`[migrate] ${m}`))
    .then(async () => {
      await sql.end();
      console.log('[migrate] done');
    })
    .catch(async (err) => {
      console.error('[migrate] failed:', err);
      await sql.end();
      process.exit(1);
    });
}
