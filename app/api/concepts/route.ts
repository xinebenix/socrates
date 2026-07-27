import { getDb } from '@/lib/db';
import { createConcept, listConcepts, listSharedLibrary } from '@/lib/db/queries';
import { loadCellSnapshots } from '@/lib/policy/snapshot';
import { coverage } from '@/lib/policy/frontier';
import { isDue } from '@/lib/schedule/decay';
import { now } from '@/lib/clock';
import { bad, fail, ok, requireUserId } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const userId = await requireUserId();
    const db = getDb();
    const at = now();

    const concepts = listConcepts(db, userId).map((c) => {
      const cells = loadCellSnapshots(db, userId, c.id).filter((x) => x.applicable);
      return {
        id: c.id,
        name: c.name,
        sourceNote: c.source_note,
        hasSource: Boolean(c.source_text && c.source_text.trim()),
        visibility: c.visibility,
        isOwner: c.owner_id === userId,
        createdAt: c.created_at,
        nodeCount: new Set(cells.map((x) => x.nodeId)).size,
        coverage: coverage(cells),
        dueCount: cells.filter((x) => isDue(x.nextDueAt, at)).length,
      };
    });

    // Shared concepts somebody else has already paid to build. Joining one is a row.
    const library = listSharedLibrary(db, userId).map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      bankSize: c.bank_size,
    }));

    return ok({ concepts, library });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json()) as {
      name?: string;
      sourceText?: string;
      sourceNote?: string;
    };

    const name = body.name?.trim();
    if (!name) return bad('name is required');

    const { concept, joined } = createConcept(getDb(), {
      userId,
      name,
      sourceText: body.sourceText ?? null,
      sourceNote: body.sourceNote ?? null,
    });

    const hasSource = Boolean(concept.source_text && concept.source_text.trim());

    return ok(
      {
        concept,
        // Joining is silent otherwise, and quietly attaching somebody to a blueprint a
        // stranger wrote is a surprising thing to do without saying so.
        joined,
        warning: hasSource
          ? null
          : // Limitation 4: an empty source is a degraded mode, and the UI says so.
            'No source text supplied. Generation will fall back to the canonical textbook ' +
            'version of this concept and will systematically miss whatever is idiosyncratic ' +
            'about your own understanding. This is also what makes the concept shareable: ' +
            'add your own source material and it becomes a private copy instead.',
      },
      joined ? 200 : 201
    );
  } catch (err) {
    return fail(err);
  }
}
