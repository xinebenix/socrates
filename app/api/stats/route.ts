import { getDb } from '@/lib/db';
import { getConcept } from '@/lib/db/queries';
import { conceptStats } from '@/lib/stats';
import { blueprintAlarm, cellStats, deadDistractors, nodeHealth } from '@/lib/analysis/itemStats';
import { bad, fail, ok, requireNum } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const conceptId = requireNum(url.searchParams.get('conceptId'), 'conceptId');
    const includeItemHealth = url.searchParams.get('itemHealth') === '1';

    const db = getDb();
    const concept = getConcept(db, conceptId);
    if (!concept) return bad('concept not found', 404);

    const stats = conceptStats(db, conceptId);

    return ok({
      concept: { id: concept.id, name: concept.name, sourceNote: concept.source_note },
      stats,
      alarm: blueprintAlarm(db, conceptId),
      itemHealth: includeItemHealth
        ? {
            cells: cellStats(db, conceptId),
            deadDistractors: deadDistractors(db, conceptId),
            nodes: nodeHealth(db, conceptId),
            // Limitation 1: with one user these estimates are noisy. Say so.
            advisory:
              'Single-user statistics are thin. Classical item analysis assumes many ' +
              'test-takers; with one user and a handful of administrations per cell these ' +
              'estimates are noisy. They are aggregated at the cell level, hidden below ' +
              'n = 5, and advisory only.',
          }
        : null,
    });
  } catch (err) {
    return fail(err);
  }
}
