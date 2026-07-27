import { getDb } from '@/lib/db';
import { conceptStats } from '@/lib/stats';
import { blueprintAlarm, cellStats, deadDistractors, nodeHealth } from '@/lib/analysis/itemStats';
import { fail, ok, readable, requireNum, requireUserId } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const conceptId = requireNum(url.searchParams.get('conceptId'), 'conceptId');
    const includeItemHealth = url.searchParams.get('itemHealth') === '1';

    const db = getDb();
    const concept = readable(db, userId, conceptId);

    const stats = conceptStats(db, userId, conceptId);

    return ok({
      concept: { id: concept.id, name: concept.name, sourceNote: concept.source_note },
      stats,
      alarm: blueprintAlarm(db, conceptId),
      itemHealth: includeItemHealth
        ? {
            cells: cellStats(db, conceptId),
            deadDistractors: deadDistractors(db, conceptId),
            nodes: nodeHealth(db, conceptId),
            // Limitation 1, weakened but not gone. Classical item analysis assumes
            // many test-takers, and a shared bank finally has some — these counts are
            // administrations across everybody, not just you. They are still thin
            // until a cell has actually been seen by several people.
            advisory:
              'Item statistics are aggregated across everyone training on this concept, ' +
              'not just you. Classical item analysis assumes many test-takers, so these ' +
              'estimates are noisy until a cell has had a number of administrations. They ' +
              'are aggregated at the cell level, hidden below n = 5, and advisory only.',
          }
        : null,
    });
  } catch (err) {
    return fail(err);
  }
}
