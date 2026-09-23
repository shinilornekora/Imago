/**
 * JWT HS256 (SPEC §2.1): 15 минут, секрет из среды, `sub` = userId.
 * Тот же токен клиент передаёт Zero; push/query-обработчики проверяют его через `verifyToken`.
 */
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TOKEN_TTL_SECONDS } from '@stand/shared';

export interface TokenPayload {
  sub: string;
  login: string;
}

export interface AuthUser {
  userId: string;
  login: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload & { iat: number; exp: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Проверка «сырого» токена (для Zero push/query, где нет заголовка Authorization в привычном виде). */
    verifyToken: (token: string) => AuthUser;
    signToken: (user: AuthUser) => string;
  }
  interface FastifyRequest {
    authUser: AuthUser;
  }
}

export async function registerJwt(app: FastifyInstance, secret: string): Promise<void> {
  await app.register(fastifyJwt, {
    secret,
    sign: { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS },
    verify: { algorithms: ['HS256'] },
  });

  app.decorateRequest('authUser', null as unknown as AuthUser);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    // Бросает FST_JWT_* → 401 в общем обработчике ошибок.
    const payload = await request.jwtVerify<TokenPayload & { iat: number; exp: number }>();
    request.authUser = { userId: payload.sub, login: payload.login };
  });

  app.decorate('verifyToken', (token: string): AuthUser => {
    const payload = app.jwt.verify<TokenPayload>(token);
    return { userId: payload.sub, login: payload.login };
  });

  app.decorate('signToken', (user: AuthUser): string => {
    return app.jwt.sign({ sub: user.userId, login: user.login });
  });
}
