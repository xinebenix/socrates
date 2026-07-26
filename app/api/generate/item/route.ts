import { getDb } from '@/lib/db';
import { generateItemForCell } from '@/lib/pipeline/generateItem';
import { topUpBuffer } from '@/lib/pipeline/buffer';
import { fail, num, ok, requireNum } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Internal. Called by the pre-generation worker and by the item-health screen. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      cellId?: number;
      conceptId?: number;
      maxGenerations?: number;
    };
    const db = getDb();

    if (body.cellId != null) {
      const outcome = await generateItemForCell(db, requireNum(body.cellId, 'cellId'));
      return ok({
        itemId: outcome.item?.id ?? null,
        attempts: outcome.attempts,
        rejections: outcome.rejections,
        error: outcome.error,
      });
    }

    const conceptId = requireNum(body.conceptId, 'conceptId');
    const report = await topUpBuffer(db, conceptId, {
      maxGenerations: num(body.maxGenerations) ?? 6,
    });
    return ok({ report });
  } catch (err) {
    return fail(err);
  }
}
