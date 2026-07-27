import { getDb } from '@/lib/db';
import { endSession, listResponsesForSession } from '@/lib/db/queries';
import { sessionProgress } from '@/lib/pipeline/session';
import { fail, ok, ownedSession, requireNum, requireUserId } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const userId = await requireUserId();
    const { sessionId: raw } = await ctx.params;
    const sessionId = requireNum(raw, 'sessionId');

    const db = getDb();
    const session = ownedSession(db, userId, sessionId);

    endSession(db, sessionId);

    const responses = listResponsesForSession(db, sessionId);
    const correct = responses.filter((r) => r.is_correct === 1).length;

    return ok({
      ended: true,
      conceptId: session.concept_id,
      progress: sessionProgress(db, sessionId),
      answered: responses.length,
      correct,
      // Deliberately no streak, no celebration. The target behavior is accurate
      // self-assessment; reward signals attached to correctness push toward
      // avoiding hard cells.
      byConfidence: {
        confidentRight: responses.filter((r) => r.confidence === 'confident' && r.is_correct === 1)
          .length,
        confidentWrong: responses.filter((r) => r.confidence === 'confident' && r.is_correct === 0)
          .length,
        guessingRight: responses.filter((r) => r.confidence === 'guessing' && r.is_correct === 1)
          .length,
        unsureWrong: responses.filter((r) => r.confidence === 'unsure' && r.is_correct === 0).length,
      },
    });
  } catch (err) {
    return fail(err);
  }
}
