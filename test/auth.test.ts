/**
 * The access gate.
 *
 * The spec assumes a tool running on localhost. Deploying it to a public URL is a
 * change of threat model, and these are the properties that change has to preserve.
 */

import { describe, expect, it } from 'vitest';
import {
  authConfig,
  gate,
  isAuthorized,
  isPublicPath,
  mintSession,
  passwordMatches,
  timingSafeEqualHex,
  verifySession,
  SESSION_TTL_MS,
} from '../lib/auth';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

describe('configuration', () => {
  it('treats blank and whitespace passwords as absent', () => {
    expect(authConfig({}).password).toBeNull();
    expect(authConfig({ GYM_PASSWORD: '' }).password).toBeNull();
    expect(authConfig({ GYM_PASSWORD: '   ' }).password).toBeNull();
    expect(authConfig({ GYM_PASSWORD: ' hunter2 ' }).password).toBe('hunter2');
  });

  it('requires the exact opt-out value to allow public access', () => {
    expect(authConfig({ GYM_ALLOW_PUBLIC: '1' }).allowPublic).toBe(true);
    for (const v of ['true', 'yes', '0', '', 'TRUE']) {
      expect(authConfig({ GYM_ALLOW_PUBLIC: v }).allowPublic).toBe(false);
    }
  });
});

describe('the gate fails closed', () => {
  it('refuses to serve when no password is set and public access was not chosen', () => {
    const decision = gate(authConfig({}), '/concepts', false);
    expect(decision.action).toBe('deny');
    if (decision.action === 'deny') {
      expect(decision.status).toBe(503);
      expect(decision.message).toMatch(/GYM_PASSWORD/);
    }
  });

  it('serves openly only when that was chosen explicitly', () => {
    expect(gate(authConfig({ GYM_ALLOW_PUBLIC: '1' }), '/concepts', false).action).toBe('allow');
  });

  it('redirects an unauthenticated visitor to the login page', () => {
    const decision = gate(authConfig({ GYM_PASSWORD: 'pw' }), '/dashboard/1', false);
    expect(decision).toEqual({ action: 'redirect', to: '/login' });
  });

  it('lets a valid session through', () => {
    expect(gate(authConfig({ GYM_PASSWORD: 'pw' }), '/dashboard/1', true).action).toBe('allow');
  });

  it('keeps the public surface to the login page, the auth route and liveness', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth')).toBe(true);
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
  it('round-trips a freshly minted token', async () => {
    const token = await mintSession('correct horse', NOW);
    expect(await verifySession('correct horse', token, NOW)).toBe(true);
  });

  it('rejects a token signed with a different password', async () => {
    const token = await mintSession('correct horse', NOW);
    expect(await verifySession('battery staple', token, NOW)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await mintSession('pw', NOW);
    expect(await verifySession('pw', token, NOW + SESSION_TTL_MS + 1)).toBe(false);
  });

  it('rejects a token whose expiry has been edited', async () => {
    const token = await mintSession('pw', NOW);
    const [, , sig] = token.split('.');
    const forged = `v1.${NOW + SESSION_TTL_MS * 10}.${sig}`;
    expect(await verifySession('pw', forged, NOW)).toBe(false);
  });

  it('rejects malformed, empty and missing tokens', async () => {
    for (const t of [null, undefined, '', 'garbage', 'v1.123', 'v2.123.abc', '..']) {
      expect(await verifySession('pw', t as string | null, NOW)).toBe(false);
    }
  });

  it('carries no secret in the cookie value', async () => {
    const token = await mintSession('sup3r-s3cret', NOW);
    expect(token).not.toContain('sup3r-s3cret');
  });

  it('cannot be verified at all when no password is configured', async () => {
    const token = await mintSession('pw', NOW);
    expect(await verifySession(null, token, NOW)).toBe(false);
  });
});

describe('password comparison', () => {
  it('accepts only an exact match', async () => {
    expect(await passwordMatches('hunter2', 'hunter2')).toBe(true);
    expect(await passwordMatches('hunter2', 'hunter3')).toBe(false);
    expect(await passwordMatches('hunter2', 'hunter')).toBe(false);
    expect(await passwordMatches('hunter2', 'hunter22')).toBe(false);
    expect(await passwordMatches('hunter2', '')).toBe(false);
  });

  it('compares digests, so a length difference is not a shortcut', async () => {
    expect(await passwordMatches('a', 'a'.repeat(500))).toBe(false);
  });

  it('the hex comparison is length-guarded and difference-accumulating', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});

describe('the health token is scoped to diagnostics only', () => {
  const config = authConfig({ GYM_PASSWORD: 'pw', GYM_HEALTH_TOKEN: 'tok' });
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
    const noTok = authConfig({ GYM_PASSWORD: 'pw' });
    expect(await isAuthorized(noTok, '/api/health', null, bearer, NOW)).toBe(false);
  });

  it('a session cookie still reaches everything', async () => {
    const token = await mintSession('pw', NOW);
    expect(await isAuthorized(config, '/api/concepts', token, null, NOW)).toBe(true);
    expect(await isAuthorized(config, '/api/health', token, null, NOW)).toBe(true);
  });
});
