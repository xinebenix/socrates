import { getDb } from '@/lib/db';
import { joinConcept } from '@/lib/db/queries';
import { startSession } from '@/lib/pipeline/session';
import { fail, ok, readable, requireNum, requireUserId } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json()) as { conceptId?: number; length?: number };
    const conceptId = requireNum(body.conceptId, 'conceptId');

    const db = getDb();
    readable(db, userId, conceptId);
    // Starting a session is the activity signal the worker prunes on — it is what keeps
    // a concept in `activeCohorts` and so worth generating ahead for.
    joinConcept(db, userId, conceptId);

    // startSession warms the plan's own cells itself. A second, plan-blind top-up
    // here used to race it — two unsynchronised fills of the same cells at once.
    const started = startSession(db, userId, conceptId, { length: body.length });

    return ok(started, 201);
  } catch (err) {
    return fail(err);
  }
}
