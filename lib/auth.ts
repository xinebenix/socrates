/**
 * Authentication.
 *
 * The build spec describes a single-user tool running locally, where "no auth" is a
 * reasonable answer. Putting it on a public URL changes that: anyone who finds the
 * link can spend the owner's Anthropic credits — a blueprint generation is one large
 * Opus call — and read and edit their entire learning record.
 *
 * So: one shared password, a signed HttpOnly cookie, enforced in middleware across
 * every page and API route. Not a login system; a lock on a door that would otherwise
 * be open.
 *
 * Implemented on Web Crypto so the same code runs in Edge middleware and in Node
 * route handlers.
 */

export const SESSION_COOKIE = 'socrates_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Paths reachable without a session. Deliberately short. */
export const PUBLIC_PATHS = ['/login', '/api/auth', '/api/health/live'];

export interface AuthConfig {
  password: string | null;
  /** Set only when the operator has explicitly chosen to run without a gate. */
  allowPublic: boolean;
  healthToken: string | null;
}

export function authConfig(env: Record<string, string | undefined>): AuthConfig {
  const password = (env.GYM_PASSWORD ?? '').trim();
  return {
    password: password.length > 0 ? password : null,
    allowPublic: env.GYM_ALLOW_PUBLIC === '1',
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
 * With no GYM_PASSWORD and no explicit GYM_ALLOW_PUBLIC=1, the app refuses to serve
 * rather than coming up wide open. A misconfigured deploy that stops working is a
 * bad afternoon; a misconfigured deploy that silently exposes an API key is a bad
 * month.
 */
export function gate(
  config: AuthConfig,
  pathname: string,
  hasValidSession: boolean
): GateDecision {
  if (isPublicPath(pathname)) return { action: 'allow' };

  if (!config.password) {
    if (config.allowPublic) return { action: 'allow' };
    return {
      action: 'deny',
      status: 503,
      message:
        'Socrates is not configured. Set GYM_PASSWORD to protect this deployment, or set ' +
        'GYM_ALLOW_PUBLIC=1 if you intend to run it with no access control.',
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

/** `v1.<expiresAtMs>.<hmac>` — the cookie carries no secret, only a signature over its own expiry. */
export async function mintSession(password: string, nowMs: number): Promise<string> {
  const exp = nowMs + SESSION_TTL_MS;
  const body = `v1.${exp}`;
  return `${body}.${await hmac(password, body)}`;
}

export async function verifySession(
  password: string | null,
  token: string | null | undefined,
  nowMs: number
): Promise<boolean> {
  if (!password || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;

  const expected = await hmac(password, `v1.${parts[1]}`);
  return timingSafeEqualHex(expected, parts[2]);
}

/** Both inputs are fixed-length hex, so a length mismatch is already a rejection. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time password comparison, via digests so unequal lengths do not leak. */
export async function passwordMatches(expected: string, supplied: string): Promise<boolean> {
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
  return passwordMatches(config.healthToken, supplied);
}

/** The health token unlocks diagnostics and nothing else. */
export const HEALTH_TOKEN_PATH = '/api/health';

/**
 * The single authorization decision, used by the middleware so that every route is
 * covered by one code path rather than each remembering to check.
 *
 * Two credentials, deliberately unequal: a session cookie reaches everything, while
 * the health token reaches only the diagnostics endpoint. That is what makes it safe
 * to paste into a terminal, a status page, or a CI job — it is read-only and cannot
 * start a session, spend tokens, or touch the record.
 */
export async function isAuthorized(
  config: AuthConfig,
  pathname: string,
  cookieToken: string | null,
  authorizationHeader: string | null,
  nowMs: number
): Promise<boolean> {
  if (await verifySession(config.password, cookieToken, nowMs)) return true;
  if (pathname === HEALTH_TOKEN_PATH && (await healthTokenMatches(config, authorizationHeader))) {
    return true;
  }
  return false;
}
