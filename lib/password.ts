/**
 * Password hashing.
 *
 * Node-only, deliberately: this is the one part of authentication that cannot run in
 * Edge middleware, and it does not need to. Middleware verifies a signature (Web
 * Crypto, `lib/auth.ts`); only the login and signup routes ever see a password, and
 * both are `runtime = 'nodejs'`.
 *
 * scrypt from `node:crypto` rather than a dependency. It is memory-hard, it ships with
 * the runtime, and adding argon2 would mean a native build on a platform where the
 * better-sqlite3 gyp fallback is already the fragile part of the deploy.
 */

import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

/** ~16 MB of memory per hash at N=16384, r=8 — under Node's 32 MB scrypt default. */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;

/** `scrypt$N$r$p$saltHex$hashHex` — self-describing, so the parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Never throws on a malformed stored hash — it returns false, so a corrupted row reads
 * as a failed login rather than a 500 that distinguishes it from a wrong password.
 */
export async function verifyPassword(stored: string, supplied: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
    salt = Buffer.from(saltHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  try {
    const actual = await scrypt(supplied, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Synchronous variant, for the migration — which runs inside a `db.transaction` and so
 * cannot await. Everything on the request path uses the async form.
 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SCRYPT.saltBytes);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Trimmed and lowercased, so `Ben@Example.com ` and `ben@example.com` are one account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Enough of a check to catch a typo'd field, not an attempt to validate deliverability. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export const MIN_PASSWORD_LENGTH = 10;
