import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness only. Unauthenticated on purpose — Railway's health check has no cookie —
 * so it must reveal nothing: no versions, no configuration, no counts.
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
