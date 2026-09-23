/** POST /api/auth/login (SPEC §2.1). */
import type { FastifyInstance } from 'fastify';
import { TOKEN_TTL_SECONDS, type LoginRequest, type LoginResponse } from '@stand/shared';
import type { Sql } from '../db/sql.js';
import { verifyPassword } from '../auth/password.js';
import { unauthorized } from '../errors.js';

const loginBodySchema = {
  type: 'object',
  required: ['login', 'password'],
  additionalProperties: false,
  properties: {
    login: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export function registerAuthRoutes(app: FastifyInstance, sql: Sql): void {
  app.post<{ Body: LoginRequest; Reply: LoginResponse }>(
    '/api/auth/login',
    { schema: { body: loginBodySchema } },
    async (request) => {
      const { login, password } = request.body;
      const rows = await sql<{ id: string; passwordHash: string }[]>`
        SELECT id, password_hash AS "passwordHash" FROM users WHERE login = ${login}
      `;
      const user = rows[0];
      if (!user || !verifyPassword(password, user.passwordHash)) {
        throw unauthorized('invalid login or password');
      }
      const token = app.signToken({ userId: user.id, login });
      return { token, userId: user.id, expiresIn: TOKEN_TTL_SECONDS };
    },
  );
}
