import type {
  ApiError,
  CommandRequest,
  CommandResult,
  DocumentListItem,
  DocumentMeta,
  LoginRequest,
  LoginResponse,
  OperationStatus,
  PageResponse,
} from '@stand/shared';
import { API_PREFIX } from '@stand/shared';
import { getToken } from './auth';

/** Ошибка с определённым HTTP‑статусом (сервер ответил). */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: ApiError['error'];
  readonly currentRevision: number | undefined;
  constructor(status: number, body: Partial<ApiError> | null, fallback: string) {
    super(body?.message ?? fallback);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = body?.error ?? (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'op_conflict' : status >= 500 ? 'internal' : 'bad_request');
    this.currentRevision = body?.currentRevision;
  }
}

/** Ошибка сети / неопределённый результат (ответ не получен). */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export function isApiError(e: unknown, code?: ApiError['error']): e is ApiHttpError {
  return e instanceof ApiHttpError && (code === undefined || e.code === code);
}

/** Ошибка, после которой повторять запрос бессмысленно (сервер дал окончательный ответ). */
export function isDefinitiveError(e: unknown): boolean {
  return e instanceof ApiHttpError && e.status < 500;
}

/**
 * Учёт объёма обмена на клиенте: РАСПАКОВАННЫЕ тела запросов/ответов в БАЙТАХ (UTF-8), без
 * заголовков и без транспортного сжатия. Это не трафик: сравнивать с шейпером и CDP нельзя
 * (см. packages/analysis/COLUMNS.md, `client_transfer_bytes_in/out`).
 */
export const transfer = { bytesIn: 0, bytesOut: 0, requests: 0 };

const textEncoder = new TextEncoder();
/** Длина строки в байтах UTF-8 (а не в кодовых единицах UTF-16, как `String.length`). */
function utf8Bytes(s: string): number {
  return textEncoder.encode(s).length;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** не добавлять Authorization (login) */
  anonymous?: boolean;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (!opts.anonymous && token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
    transfer.bytesOut += utf8Bytes(body);
  }
  transfer.requests += 1;
  let res: Response;
  try {
    res = await fetch(API_PREFIX + path, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: opts.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new NetworkError(`network error: ${opts.method ?? 'GET'} ${path}`, e);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (isAbortError(e)) throw e;
    // тело оборвано — результат неопределён
    throw new NetworkError(`response body error: ${opts.method ?? 'GET'} ${path}`, e);
  }
  // всегда считаем распакованное тело в байтах UTF-8: content-length — размер СЖАТОГО тела,
  // смешивать их в одной колонке нельзя
  transfer.bytesIn += utf8Bytes(text);
  if (!res.ok) {
    let parsed: Partial<ApiError> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Partial<ApiError>) : null;
    } catch {
      parsed = null;
    }
    throw new ApiHttpError(res.status, parsed, `${res.status} ${res.statusText}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new NetworkError(`malformed JSON: ${opts.method ?? 'GET'} ${path}`, e);
  }
}

export function login(req: LoginRequest): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/auth/login', { method: 'POST', body: req, anonymous: true });
}

export function listDocuments(signal?: AbortSignal): Promise<DocumentListItem[]> {
  return apiRequest<DocumentListItem[]>('/documents', { signal });
}

export function getDocument(docId: string, signal?: AbortSignal): Promise<DocumentMeta> {
  return apiRequest<DocumentMeta>(`/documents/${encodeURIComponent(docId)}`, { signal });
}

export function getPage(docId: string, pageId: string, signal?: AbortSignal): Promise<PageResponse> {
  return apiRequest<PageResponse>(
    `/documents/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}`,
    { signal },
  );
}

export function postCommand(docId: string, cmd: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
  return apiRequest<CommandResult>(`/documents/${encodeURIComponent(docId)}/commands`, {
    method: 'POST',
    body: cmd,
    signal,
  });
}

export function getOperation(opId: string, signal?: AbortSignal): Promise<OperationStatus> {
  return apiRequest<OperationStatus>(`/operations/${encodeURIComponent(opId)}`, { signal });
}
