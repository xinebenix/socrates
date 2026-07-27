import { NextResponse } from 'next/server';
import { authConfig, mintSession, secretMatches, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { createUser, getUserByEmail } from '@/lib/db/queries';
import {
  hashPassword,
  looksLikeEmail,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
} from '@/lib/password';
import { logEvent } from '@/lib/ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FAILURE_DELAY_MS = 750;

/**
 * Creating an account.
 *
 * Gated on `GYM_PASSWORD`, which no longer logs anybody in and is now purely a
 * registration code. The reason is money rather than secrecy: a new account's first act
 * is usually to create a concept, and creating a concept is one large Opus call against
 * the deployment's single API key. `GYM_MONTHLY_BUDGET_USD` caps *speculative*
 * generation only — sessions deliberately keep running past it, because a tool that
 * refuses to work when you sit down to use it is a tool you stop opening — so an open
 * signup page has no brake on it at all.
 *
 * Fails closed: with no code configured, nobody can sign up. The alternative, treating
 * an unset variable as "anyone may", is the failure that costs money silently.
 */
export async function POST(req: Request) {
  const config = authConfig(process.env);

  if (!config.sessionSecret) {
    return NextResponse.json(
      { error: 'this deployment has no GYM_SESSION_SECRET set and cannot issue sessions' },
      { status: 503 }
    );
  }
  if (!config.signupCode) {
    return NextResponse.json(
      {
        error:
          'this deployment has no registration code set, so no new accounts can be created. ' +
          'Set GYM_PASSWORD to a code and share it with the people who should have an account.',
      },
      { status: 503 }
    );
  }

  let email = '';
  let password = '';
  let code = '';
  let displayName: string | null = null;
  try {
    const body = (await req.json()) as {
      email?: string;
      password?: string;
      code?: string;
      displayName?: string;
    };
    email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    password = typeof body.password === 'string' ? body.password : '';
    code = typeof body.code === 'string' ? body.code : '';
    displayName = typeof body.displayName === 'string' ? body.displayName.trim() || null : null;
  } catch {
    return NextResponse.json({ error: 'malformed request' }, { status: 400 });
  }

  if (!(await secretMatches(config.signupCode, code))) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    try {
      logEvent(getDb(), 'warn', 'signup.bad_code', {
        email,
        ip: req.headers.get('x-forwarded-for') ?? 'unknown',
      });
    } catch {
      /* ignore */
    }
    return NextResponse.json({ error: 'that registration code is not right' }, { status: 403 });
  }

  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: 'that does not look like an email address' }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `choose a password of at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const db = getDb();
  if (getUserByEmail(db, email)) {
    return NextResponse.json(
      { error: 'there is already an account with that email — sign in instead' },
      { status: 409 }
    );
  }

  const user = createUser(db, {
    email,
    passwordHash: await hashPassword(password),
    displayName,
  });

  const token = await mintSession(config.sessionSecret, user.id, Date.now());
  const res = NextResponse.json({ ok: true, email: user.email }, { status: 201 });
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
    logEvent(db, 'info', 'signup.ok', { userId: user.id, email: user.email });
  } catch {
    /* ignore */
  }
  return res;
}
