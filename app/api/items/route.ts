import { getDb } from '@/lib/db';
import { getItem, listOptions, setItemFrozen, setItemRetired } from '@/lib/db/queries';
import { generateItemForCell } from '@/lib/pipeline/generateItem';
import { bad, fail, ok, requireNum } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cellId = requireNum(url.searchParams.get('cellId'), 'cellId');
    const db = getDb();

    const items = db
      .prepare(`SELECT * FROM items WHERE cell_id = ? ORDER BY generated_at DESC, id DESC`)
      .all(cellId) as { id: number }[];

    return ok({
      items: items.map((i) => {
        const item = getItem(db, i.id)!;
        return {
          ...item,
          validator: item.validator_json ? (JSON.parse(item.validator_json) as unknown) : null,
          options: listOptions(db, item.id),
        };
      }),
    });
  } catch (err) {
    return fail(err);
  }
}

type Action =
  | { action: 'retire'; itemId: number }
  | { action: 'unretire'; itemId: number }
  | { action: 'promote'; itemId: number }
  | { action: 'demote'; itemId: number }
  | { action: 'regenerate'; cellId: number };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Action;
    const db = getDb();

    switch (body.action) {
      case 'retire':
        setItemRetired(db, requireNum(body.itemId, 'itemId'), true);
        return ok({ retired: true });

      case 'unretire':
        setItemRetired(db, requireNum(body.itemId, 'itemId'), false);
        return ok({ retired: false });

      case 'promote': {
        // Invariant 10: promoting to the benchmark set takes the item out of practice
        // for good. A frozen item is never returned by the practice assembler.
        const itemId = requireNum(body.itemId, 'itemId');
        const item = getItem(db, itemId);
        if (!item) return bad('item not found', 404);
        if (item.validated !== 1) return bad('only validated items can join the benchmark set');
        setItemFrozen(db, itemId, true);
        return ok({ frozen: true });
      }

      case 'demote':
        setItemFrozen(db, requireNum(body.itemId, 'itemId'), false);
        return ok({ frozen: false });

      case 'regenerate': {
        const outcome = await generateItemForCell(db, requireNum(body.cellId, 'cellId'));
        return ok({
          itemId: outcome.item?.id ?? null,
          error: outcome.error,
          rejections: outcome.rejections,
        });
      }

      default:
        return bad('unknown action');
    }
  } catch (err) {
    return fail(err);
  }
}
