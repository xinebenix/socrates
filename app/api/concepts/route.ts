import { getDb } from '@/lib/db';
import { createConcept, listConcepts } from '@/lib/db/queries';
import { loadCellSnapshots } from '@/lib/policy/snapshot';
import { coverage } from '@/lib/policy/frontier';
import { isDue } from '@/lib/schedule/decay';
import { now } from '@/lib/clock';
import { bad, fail, ok } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = getDb();
    const at = now();

    const concepts = listConcepts(db).map((c) => {
      const cells = loadCellSnapshots(db, c.id).filter((x) => x.applicable);
      return {
        id: c.id,
        name: c.name,
        sourceNote: c.source_note,
        hasSource: Boolean(c.source_text && c.source_text.trim()),
        createdAt: c.created_at,
        nodeCount: new Set(cells.map((x) => x.nodeId)).size,
        coverage: coverage(cells),
        dueCount: cells.filter((x) => isDue(x.nextDueAt, at)).length,
      };
    });

    return ok({ concepts });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: string;
      sourceText?: string;
      sourceNote?: string;
    };

    const name = body.name?.trim();
    if (!name) return bad('name is required');

    const concept = createConcept(getDb(), {
      name,
      sourceText: body.sourceText ?? null,
      sourceNote: body.sourceNote ?? null,
    });

    return ok(
      {
        concept,
        // Limitation 4: an empty source is a degraded mode, and the UI says so.
        warning:
          concept.source_text && concept.source_text.trim()
            ? null
            : 'No source text supplied. Generation will fall back to the canonical textbook ' +
              'version of this concept and will systematically miss whatever is idiosyncratic ' +
              'about your own understanding. Paste source material and regenerate when you can.',
      },
      201
    );
  } catch (err) {
    return fail(err);
  }
}
