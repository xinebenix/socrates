/**
 * Who is asking.
 *
 * Node-side identity resolution, used by every route handler and server component. It
 * deliberately does not trust anything middleware computed: middleware runs on the Edge
 * runtime, cannot open the database, and can only tell you that a signature was valid —
 * not that the account behind it still exists. Resolving here means one code path reads
 * the cookie, verifies it, and looks the row up, and there is no header a request could
 * forge its way past.
 */

import { cookies } from 'next/headers';
import { authConfig, SESSION_COOKIE, verifySession } from './auth';
import { getDb } from './db';
import { getUser, touchUser } from './db/queries';
import type { UserRow } from './db/types';

/** The signed-in account, or null. Null means "log in", never "assume the owner". */
export async function currentUser(): Promise<UserRow | null> {
  const config = authConfig(process.env);
  if (!config.sessionSecret) return null;

  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const claims = await verifySession(config.sessionSecret, token, Date.now());
  if (!claims) return null;

  // A cookie for a deleted account verifies fine — the signature is still good — so the
  // row lookup is what actually ends that session.
  const user = getUser(getDb(), claims.userId);
  if (!user) return null;

  return user;
}

/**
 * The same, for callers that have nothing sensible to do without an account.
 *
 * Routes should prefer returning 401 explicitly; this exists for server components,
 * where middleware has already redirected anyone unauthenticated and reaching this
 * throw means the gate was bypassed.
 */
export async function requireUser(): Promise<UserRow> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user;
}

/** Last-seen bookkeeping, cheap enough to do on login and not worth doing per request. */
export function markSeen(userId: number): void {
  try {
    touchUser(getDb(), userId);
  } catch {
    /* last_seen_at is diagnostics, never worth failing a request over */
  }
}
