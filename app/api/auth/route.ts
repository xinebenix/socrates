import { NextResponse } from 'next/server';
import { authConfig, mintSession, passwordMatches, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { logEvent } from '@/lib/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A crude brake on guessing. Single user, so a fixed delay costs nothing real. */
const FAILURE_DELAY_MS = 750;

export async function POST(req: Request) {
  const config = authConfig(process.env);

  if (!config.password) {
    return NextResponse.json(
      { error: 'no password is configured on this deployment' },
      { status: 503 }
    );
  }

  let supplied = '';
  try {
    const body = (await req.json()) as { password?: string };
    supplied = typeof body.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'malformed request' }, { status: 400 });
  }

  if (!(await passwordMatches(config.password, supplied))) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    try {
      logEvent(getDb(), 'warn', 'auth.failed', {
        ip: req.headers.get('x-forwarded-for') ?? 'unknown',
      });
    } catch {
      /* a database that is not up yet must not turn a 401 into a 500 */
    }
    return NextResponse.json({ error: 'incorrect password' }, { status: 401 });
  }

  const token = await mintSession(config.password, Date.now());
  const res = NextResponse.json({ ok: true });

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
    logEvent(getDb(), 'info', 'auth.ok');
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
