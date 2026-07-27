import { getDb } from '@/lib/db';
import { isConfidence, type Confidence } from '@/lib/mastery/bkt';
import {
  submitDontKnowResponse,
  submitFreeResponse,
  submitMcResponse,
} from '@/lib/pipeline/respond';
import { finalizeBenchmarkRun, isBenchmarkComplete } from '@/lib/pipeline/benchmark';
import { sessionProgress } from '@/lib/pipeline/session';
import { bad, fail, ok, ownedSession, requireNum, requireUserId } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Invariant 1: confidence is captured before submission and is mandatory. The server
 * refuses a submission without it — a client-side guard alone is a guard that can be
 * bypassed.
 *
 * Invariant 2: this endpoint only ever inserts. There is no route anywhere in the app
 * that mutates a stored response.
 */
export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const userId = await requireUserId();
    const { sessionId: raw } = await ctx.params;
    const sessionId = requireNum(raw, 'sessionId');

    const db = getDb();
    // Ownership, not just existence. Session ids are sequential integers, so without
    // this any signed-in account could answer into somebody else's record — and
    // invariant 2 means those responses could never be taken back out.
    const session = ownedSession(db, userId, sessionId);
    if (session.ended_at) return bad('session has already ended', 409);

    const body = (await req.json()) as {
      itemId?: number;
      chosenOptionId?: number;
      freeText?: string;
      confidence?: string;
      latencyMs?: number;
      dontKnow?: boolean;
    };

    const itemId = requireNum(body.itemId, 'itemId');
    const latencyMs = Number.isFinite(body.latencyMs) ? Number(body.latencyMs) : null;

    // "I don't know" — the learner declines the item and asks for the answer. Not a
    // bypass of invariant 1: the server sets the confidence itself, at its floor, and
    // records a wrong answer. Declining is a statement about what the learner knows,
    // and it is stored as one before anything is revealed.
    const declined = body.dontKnow === true;

    if (!declined && !isConfidence(body.confidence)) {
      return bad('confidence is required and must be one of: guessing, unsure, confident');
    }

    const isFree = typeof body.freeText === 'string';

    const feedback = declined
      ? submitDontKnowResponse(db, { sessionId, itemId, latencyMs })
      : isFree
        ? await submitFreeResponse(db, {
            sessionId,
            itemId,
            answerText: body.freeText as string,
            confidence: body.confidence as Confidence,
            latencyMs,
          })
        : submitMcResponse(db, {
            sessionId,
            itemId,
            chosenOptionId: requireNum(body.chosenOptionId, 'chosenOptionId'),
            confidence: body.confidence as Confidence,
            latencyMs,
          });

    const progress = sessionProgress(db, sessionId);

    // A benchmark run shows no feedback until the whole run is complete.
    if (session.kind === 'benchmark') {
      const complete = isBenchmarkComplete(db, sessionId);
      const finalized = complete
        ? finalizeBenchmarkRun(db, sessionId, session.concept_id)
        : null;
      return ok({
        deferred: true,
        complete,
        progress,
        results: finalized?.results ?? null,
      });
    }

    return ok({ deferred: false, declined, feedback, progress });
  } catch (err) {
    return fail(err);
  }
}
