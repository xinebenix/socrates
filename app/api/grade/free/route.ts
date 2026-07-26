import { getDb } from '@/lib/db';
import { getItem } from '@/lib/db/queries';
import { gradeFree, parseRubric } from '@/lib/pipeline/respond';
import { FREE_PASS_THRESHOLD } from '@/lib/prompts/gradeFree';
import { bad, fail, ok, requireNum } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Grade a free-response answer without recording it. Used by the grader regression
 * fixtures and for inspecting the rubric; the session path goes through
 * /api/session/[id]/respond so the response is logged with the mastery update.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { itemId?: number; answerText?: string };
    const itemId = requireNum(body.itemId, 'itemId');
    if (typeof body.answerText !== 'string') return bad('answerText is required');

    const item = getItem(getDb(), itemId);
    if (!item) return bad('item not found', 404);
    if (item.kind !== 'free') return bad('item is not a free-response item');

    const rubric = parseRubric(item);
    const verdict = await gradeFree(item, rubric, body.answerText);

    return ok({
      verdict,
      rubric,
      passed: verdict.score >= FREE_PASS_THRESHOLD,
      threshold: FREE_PASS_THRESHOLD,
    });
  } catch (err) {
    return fail(err);
  }
}
