import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export function ok<T>(data: T, init?: number): NextResponse {
  return NextResponse.json(data as object, { status: init ?? 200 });
}

export function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function fail(err: unknown, status = 500): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api]', message);
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
