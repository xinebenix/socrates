import { getDb } from '@/lib/db';
import { getConcept } from '@/lib/db/queries';
import { startSession } from '@/lib/pipeline/session';
import { bad, fail, ok, requireNum } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { conceptId?: number; length?: number };
    const conceptId = requireNum(body.conceptId, 'conceptId');

    const db = getDb();
    if (!getConcept(db, conceptId)) return bad('concept not found', 404);

    // startSession warms the plan's own cells itself. A second, plan-blind top-up
    // here used to race it — two unsynchronised fills of the same cells at once.
    const started = startSession(db, conceptId, { length: body.length });

    return ok(started, 201);
  } catch (err) {
    return fail(err);
  }
}
