import { getDb } from '@/lib/db';
import { getSession } from '@/lib/db/queries';
import { isConfidence } from '@/lib/mastery/bkt';
import { submitFreeResponse, submitMcResponse } from '@/lib/pipeline/respond';
import { finalizeBenchmarkRun, isBenchmarkComplete } from '@/lib/pipeline/benchmark';
import { sessionProgress } from '@/lib/pipeline/session';
import { bad, fail, ok, requireNum } from '../../../_shared';

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
    const { sessionId: raw } = await ctx.params;
    const sessionId = requireNum(raw, 'sessionId');

    const db = getDb();
    const session = getSession(db, sessionId);
    if (!session) return bad('session not found', 404);
    if (session.ended_at) return bad('session has already ended', 409);

    const body = (await req.json()) as {
      itemId?: number;
      chosenOptionId?: number;
      freeText?: string;
      confidence?: string;
      latencyMs?: number;
    };

    const itemId = requireNum(body.itemId, 'itemId');

    if (!isConfidence(body.confidence)) {
      return bad('confidence is required and must be one of: guessing, unsure, confident');
    }

    const latencyMs = Number.isFinite(body.latencyMs) ? Number(body.latencyMs) : null;
    const isFree = typeof body.freeText === 'string';

    const feedback = isFree
      ? await submitFreeResponse(db, {
          sessionId,
          itemId,
          answerText: body.freeText as string,
          confidence: body.confidence,
          latencyMs,
        })
      : submitMcResponse(db, {
          sessionId,
          itemId,
          chosenOptionId: requireNum(body.chosenOptionId, 'chosenOptionId'),
          confidence: body.confidence,
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

    return ok({ deferred: false, feedback, progress });
  } catch (err) {
    return fail(err);
  }
}
