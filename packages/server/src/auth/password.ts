/**
 * Хеширование паролей: scrypt из node:crypto (без внешних зависимостей).
 * Формат: scrypt$<saltHex>$<hashHex>
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;
const PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = scryptSync(password, salt, expected.length, PARAMS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
