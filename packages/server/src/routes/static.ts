/**
 * Раздача production-сборки клиента (SPA) с корня, если каталог существует.
 * /api/* и /zero/* никогда не попадают в SPA-fallback.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { sendApiError } from '../errors.js';

export async function registerStatic(app: FastifyInstance, clientDist: string): Promise<boolean> {
  const indexPath = path.join(clientDist, 'index.html');
  const available = existsSync(indexPath) && statSync(indexPath).isFile();

  if (available) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      index: ['index.html'],
      wildcard: true,
      // index.html — без кеша (Vite-ассеты хешированы и могут кешироваться долго).
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith('index.html')) reply.header('cache-control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const url = request.url;
    if (url.startsWith('/api/') || url === '/api' || url.startsWith('/zero')) {
      return sendApiError(reply, 404, { error: 'not_found', message: `route ${request.method} ${url} not found` });
    }
    if (available && request.method === 'GET') {
      // SPA fallback: любой не-API GET → index.html.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendApiError(reply, 404, { error: 'not_found', message: `route ${request.method} ${url} not found` });
  });

  return available;
}
