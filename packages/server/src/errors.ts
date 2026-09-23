/**
 * Единый формат ошибок API: `{error, message, currentRevision?}` (shared ApiError).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError } from '@stand/shared';
import { DomainError, DOMAIN_ERROR_STATUS } from './domain/index.js';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ApiError['error'];
  constructor(code: ApiError['error'], message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = DOMAIN_ERROR_STATUS[code];
  }
}

export const notFound = (message: string) => new HttpError('not_found', message);
export const forbidden = (message: string) => new HttpError('forbidden', message);
export const unauthorized = (message: string) => new HttpError('unauthorized', message);
export const badRequest = (message: string) => new HttpError('bad_request', message);

export function sendApiError(reply: FastifyReply, status: number, body: ApiError): FastifyReply {
  return reply.status(status).type('application/json; charset=utf-8').send(body);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof DomainError) {
      return sendApiError(reply, err.statusCode, err.toApiError());
    }
    if (err instanceof HttpError) {
      return sendApiError(reply, err.statusCode, { error: err.code, message: err.message });
    }
    const fe = err as FastifyError;
    // Ошибки валидации JSON-схем (тело/параметры/query) → 400 bad_request.
    if (fe.validation) {
      return sendApiError(reply, 400, { error: 'bad_request', message: fe.message });
    }
    if (typeof fe.code === 'string' && fe.code.startsWith('FST_JWT_')) {
      return sendApiError(reply, 401, { error: 'unauthorized', message: fe.message });
    }
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return sendApiError(reply, 400, { error: 'bad_request', message: fe.message });
    }
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      return sendApiError(reply, fe.statusCode, { error: 'bad_request', message: fe.message });
    }
    request.log.error({ err }, 'unhandled error');
    return sendApiError(reply, 500, { error: 'internal', message: 'internal server error' });
  });
}
