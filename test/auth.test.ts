/**
 * The access gate.
 *
 * The spec assumes a tool running on localhost. Deploying it to a public URL is a
 * change of threat model, and accounts are a second one: the cookie now names a person,
 * and everything downstream trusts that name. These are the properties both changes have
 * to preserve.
 */

import { describe, expect, it } from 'vitest';
import {
  authConfig,
  gate,
  isAuthorized,
  isPublicPath,
  mintSession,
  secretMatches,
  timingSafeEqualHex,
  verifySession,
  SESSION_TTL_MS,
} from '../lib/auth';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

describe('configuration', () => {
  it('treats blank and whitespace secrets as absent', () => {
    expect(authConfig({}).sessionSecret).toBeNull();
    expect(authConfig({ GYM_SESSION_SECRET: '' }).sessionSecret).toBeNull();
    expect(authConfig({ GYM_SESSION_SECRET: '   ' }).sessionSecret).toBeNull();
    expect(authConfig({ GYM_SESSION_SECRET: ' s3cret ' }).sessionSecret).toBe('s3cret');
  });

  it('reads GYM_PASSWORD as the registration code, not a login credential', () => {
    expect(authConfig({}).signupCode).toBeNull();
    expect(authConfig({ GYM_PASSWORD: '  ' }).signupCode).toBeNull();
    expect(authConfig({ GYM_PASSWORD: ' let-me-in ' }).signupCode).toBe('let-me-in');
  });
});

describe('the gate fails closed', () => {
  it('refuses to serve when no session secret is set', () => {
    const decision = gate(authConfig({}), '/concepts', false);
    expect(decision.action).toBe('deny');
    if (decision.action === 'deny') {
      expect(decision.status).toBe(503);
      expect(decision.message).toMatch(/GYM_SESSION_SECRET/);
    }
  });

  it('has no way to be opened to the public', () => {
    // GYM_ALLOW_PUBLIC is gone. With accounts there is no coherent "no identity" mode:
    // every row belongs to somebody, so an anonymous visitor has no record to train on.
    const decision = gate(authConfig({ GYM_ALLOW_PUBLIC: '1' }), '/concepts', false);
    expect(decision.action).toBe('deny');
  });

  it('redirects an unauthenticated visitor to the login page', () => {
    const decision = gate(authConfig({ GYM_SESSION_SECRET: 'k' }), '/dashboard/1', false);
    expect(decision).toEqual({ action: 'redirect', to: '/login' });
  });

  it('lets a valid session through', () => {
    expect(gate(authConfig({ GYM_SESSION_SECRET: 'k' }), '/dashboard/1', true).action).toBe('allow');
  });

  it('keeps the public surface to sign-in, sign-up, the auth routes and liveness', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/signup')).toBe(true);
    expect(isPublicPath('/api/auth')).toBe(true);
    expect(isPublicPath('/api/auth/signup')).toBe(true);
    expect(isPublicPath('/api/health/live')).toBe(true);

    // Everything that touches data or spends tokens stays behind the gate.
    for (const p of [
      '/',
      '/concepts',
      '/api/concepts',
      '/api/session',
      '/api/blueprint',
      '/api/generate/item',
      '/api/grade/free',
      '/api/health',
      '/api/stats',
      '/api/items',
      '/api/benchmark',
    ]) {
      expect(isPublicPath(p), `${p} must not be public`).toBe(false);
    }
  });

  it('a public prefix does not open a sibling path', () => {
    expect(isPublicPath('/logins')).toBe(false);
    expect(isPublicPath('/api/authorize')).toBe(false);
    expect(isPublicPath('/api/health')).toBe(false);
  });
});

describe('session tokens', () => {
  it('round-trips a freshly minted token and names the account', async () => {
    const token = await mintSession('correct horse', 7, NOW);
    expect(await verifySession('correct horse', token, NOW)).toEqual({
      userId: 7,
      expiresAtMs: NOW + SESSION_TTL_MS,
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintSession('correct horse', 1, NOW);
    expect(await verifySession('battery staple', token, NOW)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await mintSession('k', 1, NOW);
    expect(await verifySession('k', token, NOW + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('rejects a token whose expiry has been edited', async () => {
    const token = await mintSession('k', 1, NOW);
    const [, , , sig] = token.split('.');
    const forged = `v2.1.${NOW + SESSION_TTL_MS * 10}.${sig}`;
    expect(await verifySession('k', forged, NOW)).toBeNull();
  });

  it('rejects a token edited into another account', async () => {
    // The whole reason the signature covers the id. Without this, changing one digit of
    // your own cookie would hand you somebody else's entire learning record.
    const token = await mintSession('k', 1, NOW);
    const [, , exp, sig] = token.split('.');
    expect(await verifySession('k', `v2.2.${exp}.${sig}`, NOW)).toBeNull();
  });

  it('rejects malformed, empty and missing tokens', async () => {
    for (const t of [
      null,
      undefined,
      '',
      'garbage',
      'v2.1.123',
      'v1.123.abc',
      'v2.abc.123.def',
      'v2.0.123.def',
      'v2.-1.123.def',
      '...',
    ]) {
      expect(await verifySession('k', t as string | null, NOW)).toBeNull();
    }
  });

  it('carries no secret in the cookie value', async () => {
    const token = await mintSession('sup3r-s3cret', 1, NOW);
    expect(token).not.toContain('sup3r-s3cret');
  });

  it('cannot be verified at all when no secret is configured', async () => {
    const token = await mintSession('k', 1, NOW);
    expect(await verifySession(null, token, NOW)).toBeNull();
  });
});

describe('secret comparison', () => {
  it('accepts only an exact match', async () => {
    expect(await secretMatches('hunter2', 'hunter2')).toBe(true);
    expect(await secretMatches('hunter2', 'hunter3')).toBe(false);
    expect(await secretMatches('hunter2', 'hunter')).toBe(false);
    expect(await secretMatches('hunter2', 'hunter22')).toBe(false);
    expect(await secretMatches('hunter2', '')).toBe(false);
  });

  it('compares digests, so a length difference is not a shortcut', async () => {
    expect(await secretMatches('a', 'a'.repeat(500))).toBe(false);
  });

  it('the hex comparison is length-guarded and difference-accumulating', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});

describe('the health token is scoped to diagnostics only', () => {
  const config = authConfig({ GYM_SESSION_SECRET: 'k', GYM_HEALTH_TOKEN: 'tok' });
  const bearer = 'Bearer tok';

  it('unlocks /api/health', async () => {
    expect(await isAuthorized(config, '/api/health', null, bearer, NOW)).toBe(true);
  });

  it('unlocks nothing else — not pages, not data, not generation', async () => {
    for (const p of [
      '/concepts',
      '/api/concepts',
      '/api/session',
      '/api/generate/item',
      '/api/blueprint',
      '/api/stats',
      '/api/health/sub',
    ]) {
      expect(await isAuthorized(config, p, null, bearer, NOW), `${p} must stay locked`).toBe(false);
    }
  });

  it('rejects a wrong or absent bearer token', async () => {
    expect(await isAuthorized(config, '/api/health', null, 'Bearer nope', NOW)).toBe(false);
    expect(await isAuthorized(config, '/api/health', null, null, NOW)).toBe(false);
  });

  it('is inert when no health token is configured', async () => {
    const noTok = authConfig({ GYM_SESSION_SECRET: 'k' });
    expect(await isAuthorized(noTok, '/api/health', null, bearer, NOW)).toBe(false);
  });

  it('a session cookie still reaches everything', async () => {
    const token = await mintSession('k', 1, NOW);
    expect(await isAuthorized(config, '/api/concepts', token, null, NOW)).toBe(true);
    expect(await isAuthorized(config, '/api/health', token, null, NOW)).toBe(true);
  });
});
