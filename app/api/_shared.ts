import { NextResponse } from 'next/server';
import { getDb, type Db } from '@/lib/db';
import { canEditConcept, canReadConcept, getConcept, getSession } from '@/lib/db/queries';
import type { ConceptRow, SessionRow } from '@/lib/db/types';
import { currentUser } from '@/lib/session';
import { logEvent } from '@/lib/ops';

export const runtime = 'nodejs';

export function ok<T>(data: T, init?: number): NextResponse {
  return NextResponse.json(data as object, { status: init ?? 200 });
}

export function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * A refusal with an HTTP status attached, so authorization can be enforced where the
 * row is loaded rather than by every caller remembering to check afterwards. `fail`
 * unwraps it, so the routes' existing try/catch is the whole plumbing.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** The signed-in account. Middleware has already gated; this is the identity. */
export async function requireUserId(): Promise<number> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, 'not authenticated');
  return user.id;
}

/**
 * A concept this account may see: any shared one, or their own private one.
 *
 * 404 rather than 403 for a private concept belonging to somebody else — "exists but is
 * not yours" is more than a stranger needs to know about what other people are studying.
 */
export function readable(db: Db, userId: number, conceptId: number): ConceptRow {
  const concept = getConcept(db, conceptId);
  if (!concept || !canReadConcept(concept, userId)) throw new HttpError(404, 'concept not found');
  return concept;
}

/**
 * A concept this account may change — the owner, and nobody else.
 *
 * On a shared concept this is the load-bearing check: other people are training against
 * these nodes and this bank, and their mastery history is indexed by cells an edit can
 * retire. The 403 says to fork instead, which is the supported way to make a shared
 * concept your own.
 */
export function editable(db: Db, userId: number, conceptId: number): ConceptRow {
  const concept = readable(db, userId, conceptId);
  if (!canEditConcept(concept, userId)) {
    throw new HttpError(
      403,
      'this is a shared concept and you are not its owner. Make your own copy of it to ' +
        'change the blueprint or ground it in your own source material — your progress ' +
        'comes with you.'
    );
  }
  return concept;
}

/** A session this account owns. Without this, any account could answer any session. */
export function ownedSession(db: Db, userId: number, sessionId: number): SessionRow {
  const session = getSession(db, sessionId);
  if (!session) throw new HttpError(404, 'session not found');
  if (session.user_id !== userId) throw new HttpError(403, 'that session belongs to someone else');
  return session;
}

export function fail(err: unknown, status = 500): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  // Written to ops_log as well as the console, so a failure is still diagnosable
  // after log retention has expired or from a session with no log access.
  try {
    logEvent(getDb(), 'error', 'api.error', {
      message,
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 4).join('\n') : undefined,
    });
  } catch {
    console.error('[api]', message);
  }
  return NextResponse.json({ error: message }, { status });
}

export function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function requireNum(v: unknown, name: string): number {
  const n = num(v);
  if (n === null) throw new Error(`${name} must be a number`);
  return n;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
