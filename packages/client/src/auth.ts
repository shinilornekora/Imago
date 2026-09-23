/**
 * Токен доступа хранится ТОЛЬКО в памяти (переменная модуля) — SPEC §2.1.
 * Никогда не пишется в localStorage/sessionStorage/IndexedDB.
 */
let token: string | null = null;
let userId: string | null = null;

export function setToken(next: string, uid: string): void {
  token = next;
  userId = uid;
}

export function getToken(): string | null {
  return token;
}

export function getUserId(): string | null {
  return userId;
}

export function clearToken(): void {
  token = null;
  userId = null;
}
