/**
 * Authentication.
 *
 * The build spec describes a single-user tool running locally, where "no auth" is a
 * reasonable answer. That produced the version this replaces: one shared password and a
 * cookie signed with it, carrying no subject — a lock on a door rather than a login.
 *
 * With accounts the cookie has to say *who*, because progress is now a per-person record
 * and the whole point is that it follows you from your laptop to your phone. So:
 * `v2.<userId>.<expiry>.<hmac>`, signed with a server secret. The signature covers the
 * id as well as the expiry, so a cookie cannot be edited into somebody else's session.
 *
 * What the cookie deliberately does *not* prove is that the account still exists. Edge
 * middleware cannot open SQLite, so it verifies the signature and nothing more; every
 * route and server component resolves the user through `lib/session.ts`, which does read
 * the database. Middleware is the gate, not the identity.
 *
 * Implemented on Web Crypto so the same code runs in Edge middleware and in Node
 * route handlers. Password hashing is the one part that cannot — see `lib/password.ts`.
 */

export const SESSION_COOKIE = 'socrates_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Paths reachable without a session. Deliberately short. */
export const PUBLIC_PATHS = ['/login', '/signup', '/api/auth', '/api/health/live'];

export interface AuthConfig {
  /** Signs session cookies. Rotating it signs everybody out, and nothing worse. */
  sessionSecret: string | null;
  /**
   * Required once, to create an account. Not a login credential for anybody — the
   * variable that used to be the whole gate is now the brake on who may open one.
   */
  signupCode: string | null;
  healthToken: string | null;
}

export function authConfig(env: Record<string, string | undefined>): AuthConfig {
  const secret = (env.GYM_SESSION_SECRET ?? '').trim();
  const code = (env.GYM_PASSWORD ?? '').trim();
  return {
    sessionSecret: secret.length > 0 ? secret : null,
    signupCode: code.length > 0 ? code : null,
    healthToken: (env.GYM_HEALTH_TOKEN ?? '').trim() || null,
  };
}

export type GateDecision =
  | { action: 'allow' }
  | { action: 'redirect'; to: string }
  | { action: 'deny'; status: number; message: string };

/**
 * Fail closed.
 *
 * Without `GYM_SESSION_SECRET` there is no way to tell one account's cookie from a
 * forged one, so the app refuses to serve rather than coming up with authentication
 * that looks present and is not. A misconfigured deploy that stops working is a bad
 * afternoon; a misconfigured deploy that hands out other people's learning records is a
 * bad month.
 *
 * There is no `GYM_ALLOW_PUBLIC` any more. It meant "run with no access control", which
 * was coherent for a single-user tool and is not for one where every row belongs to
 * somebody: with no identity there is no record to attach the work to.
 */
export function gate(
  config: AuthConfig,
  pathname: string,
  hasValidSession: boolean
): GateDecision {
  if (isPublicPath(pathname)) return { action: 'allow' };

  if (!config.sessionSecret) {
    return {
      action: 'deny',
      status: 503,
      message:
        'Socrates is not configured. Set GYM_SESSION_SECRET to a long random string — ' +
        'it signs session cookies, and without it accounts cannot be told apart. ' +
        'Generate one: openssl rand -base64 48',
    };
  }

  if (hasValidSession) return { action: 'allow' };
  return { action: 'redirect', to: '/login' };
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/* ------------------------------------------------------------------- tokens */

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * `v2.<userId>.<expiresAtMs>.<hmac>` — the cookie carries no secret, only a signature
 * over the pair it asserts. Changing either half invalidates it.
 */
export async function mintSession(
  secret: string,
  userId: number,
  nowMs: number
): Promise<string> {
  const exp = nowMs + SESSION_TTL_MS;
  const body = `v2.${userId}.${exp}`;
  return `${body}.${await hmac(secret, body)}`;
}

export interface SessionClaims {
  userId: number;
  expiresAtMs: number;
}

/**
 * Returns the claims, or null.
 *
 * There is no way to read the subject without coming through here, which is the point:
 * a caller cannot get at the user id having forgotten to check the signature.
 */
export async function verifySession(
  secret: string | null,
  token: string | null | undefined,
  nowMs: number
): Promise<SessionClaims | null> {
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2') return null;

  const userId = Number(parts[1]);
  const exp = Number(parts[2]);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isFinite(exp) || exp <= nowMs) return null;

  const expected = await hmac(secret, `v2.${parts[1]}.${parts[2]}`);
  if (!timingSafeEqualHex(expected, parts[3])) return null;

  return { userId, expiresAtMs: exp };
}

/** Both inputs are fixed-length hex, so a length mismatch is already a rejection. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time comparison, via digests so unequal lengths do not leak. */
export async function secretMatches(expected: string, supplied: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(expected), sha256Hex(supplied)]);
  return timingSafeEqualHex(a, b);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The diagnostics endpoint accepts a bearer token as well as a browser session, so it
 * can be curled from a terminal or a CI job without a login round-trip.
 */
export async function healthTokenMatches(
  config: AuthConfig,
  authorizationHeader: string | null
): Promise<boolean> {
  if (!config.healthToken || !authorizationHeader) return false;
  const supplied = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
  if (!supplied) return false;
  return secretMatches(config.healthToken, supplied);
}

/** The health token unlocks diagnostics and nothing else. */
export const HEALTH_TOKEN_PATH = '/api/health';

/**
 * The single authorization decision, used by the middleware so that every route is
 * covered by one code path rather than each remembering to check.
 *
 * Two credentials, deliberately unequal: a session cookie reaches everything that
 * account owns, while the health token reaches only the diagnostics endpoint. That is
 * what makes it safe to paste into a terminal, a status page, or a CI job — it is
 * read-only, belongs to no account, and cannot start a session or touch a record.
 */
export async function isAuthorized(
  config: AuthConfig,
  pathname: string,
  cookieToken: string | null,
  authorizationHeader: string | null,
  nowMs: number
): Promise<boolean> {
  if (await verifySession(config.sessionSecret, cookieToken, nowMs)) return true;
  if (pathname === HEALTH_TOKEN_PATH && (await healthTokenMatches(config, authorizationHeader))) {
    return true;
  }
  return false;
}
