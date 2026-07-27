import { NextResponse } from 'next/server';
import { authConfig, mintSession, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getUserByEmail, touchUser } from '@/lib/db/queries';
import { normalizeEmail, verifyPassword } from '@/lib/password';
import { logEvent } from '@/lib/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A crude brake on guessing, and now also on enumeration: it runs on every failure,
 * whether the email exists or not, so the two are not distinguishable by timing.
 */
const FAILURE_DELAY_MS = 750;

export async function POST(req: Request) {
  const config = authConfig(process.env);

  if (!config.sessionSecret) {
    return NextResponse.json(
      { error: 'this deployment has no GYM_SESSION_SECRET set and cannot issue sessions' },
      { status: 503 }
    );
  }

  let email = '';
  let password = '';
  try {
    const body = (await req.json()) as { email?: string; password?: string };
    email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'malformed request' }, { status: 400 });
  }

  const user = email ? getUserByEmail(getDb(), email) : undefined;
  const ok = user ? await verifyPassword(user.password_hash, password) : false;

  if (!user || !ok) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    try {
      logEvent(getDb(), 'warn', 'auth.failed', {
        email,
        ip: req.headers.get('x-forwarded-for') ?? 'unknown',
      });
    } catch {
      /* a database that is not up yet must not turn a 401 into a 500 */
    }
    // One message for both cases. "No such account" tells an attacker which addresses
    // are worth guessing passwords for.
    return NextResponse.json({ error: 'incorrect email or password' }, { status: 401 });
  }

  const token = await mintSession(config.sessionSecret, user.id, Date.now());
  const res = NextResponse.json({ ok: true, email: user.email });

  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  try {
    touchUser(getDb(), user.id);
    logEvent(getDb(), 'info', 'auth.ok', { userId: user.id });
  } catch {
    /* ignore */
  }
  return res;
}

/** Sign out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: '', path: '/', maxAge: 0 });
  return res;
}
