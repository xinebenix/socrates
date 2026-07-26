import { getDb } from '@/lib/db';
import { getSession } from '@/lib/db/queries';
import { nextItem, sessionProgress } from '@/lib/pipeline/session';
import { bad, fail, ok, requireNum } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId: raw } = await ctx.params;
    const sessionId = requireNum(raw, 'sessionId');

    const db = getDb();
    const session = getSession(db, sessionId);
    if (!session) return bad('session not found', 404);

    const { item, dropped, lastError } = await nextItem(db, sessionId);

    return ok({
      item,
      done: item === null,
      kind: session.kind,
      progress: sessionProgress(db, sessionId),
      // A dropped slot is not an error the session should die on, but it is not
      // silence either — the user is told the plan got shorter and why.
      warning:
        dropped > 0
          ? `${dropped} planned item${dropped === 1 ? '' : 's'} could not be generated and ` +
            `${dropped === 1 ? 'was' : 'were'} skipped.${lastError ? ` Last reason: ${lastError}` : ''}`
          : lastError,
    });
  } catch (err) {
    return fail(err);
  }
}
