import { NextResponse, type NextRequest } from 'next/server';
import { authConfig, gate, isAuthorized, SESSION_COOKIE } from './lib/auth';

/**
 * One gate in front of everything. Doing this in middleware rather than per-route
 * means a route added later is protected by default rather than by remembering.
 */
export async function middleware(req: NextRequest) {
  const config = authConfig(process.env);
  const { pathname } = req.nextUrl;

  const authorized = await isAuthorized(
    config,
    pathname,
    req.cookies.get(SESSION_COOKIE)?.value ?? null,
    req.headers.get('authorization'),
    Date.now()
  );

  const decision = gate(config, pathname, authorized);
  if (decision.action === 'allow') return NextResponse.next();

  if (decision.action === 'deny') {
    return NextResponse.json({ error: decision.message }, { status: decision.status });
  }

  // An unauthenticated API call gets a 401, not an HTML login page — a fetch that
  // silently receives a redirect to /login is a confusing thing to debug.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = decision.to;
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
