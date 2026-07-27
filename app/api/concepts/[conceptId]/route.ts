import { getDb } from '@/lib/db';
import { deleteConcept, hasJoined, leaveConcept, updateConceptSource } from '@/lib/db/queries';
import { forkConcept } from '@/lib/pipeline/fork';
import { bad, editable, fail, ok, readable, requireNum, requireUserId } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ conceptId: string }> }) {
  try {
    const userId = await requireUserId();
    const { conceptId } = await ctx.params;
    const db = getDb();
    const id = requireNum(conceptId, 'conceptId');
    const concept = readable(db, userId, id);
    return ok({
      concept,
      isOwner: concept.owner_id === userId,
      joined: hasJoined(db, userId, id),
    });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Editing a concept's own text. Owner only, and source material is a special case.
 *
 * Adding source text to a *shared* concept would publish it: every member's items would
 * start being generated from one person's notes. So that path forks instead, which is
 * the same rule creation follows — supplying source material makes a concept yours.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ conceptId: string }> }) {
  try {
    const userId = await requireUserId();
    const { conceptId } = await ctx.params;
    const id = requireNum(conceptId, 'conceptId');
    const db = getDb();

    const body = (await req.json()) as {
      name?: string;
      sourceText?: string;
      sourceNote?: string;
      /** Explicit opt-in to taking a shared concept private. */
      fork?: boolean;
    };

    const addsSource = typeof body.sourceText === 'string' && body.sourceText.trim().length > 0;
    const existing = readable(db, userId, id);

    if (existing.visibility === 'shared' && addsSource) {
      if (!body.fork) {
        return bad(
          'this is a shared concept, so its items are written from the canonical version of ' +
            'the topic and everyone training on it sees them. Pass fork: true to take a private ' +
            'copy grounded in your own source material — your progress comes with you.',
          409
        );
      }
      const forked = forkConcept(db, userId, id, {
        sourceText: body.sourceText,
        sourceNote: body.sourceNote,
        name: body.name,
      });
      return ok({ forked: true, ...forked }, 201);
    }

    editable(db, userId, id);
    if (body.name?.trim()) {
      db.prepare(`UPDATE concepts SET name = ? WHERE id = ?`).run(body.name.trim(), id);
    }
    updateConceptSource(db, id, { sourceText: body.sourceText, sourceNote: body.sourceNote });

    return ok({ concept: readable(db, userId, id), forked: false });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Removing a concept from your shelf.
 *
 * For a private concept that is a delete. For a shared one it is a leave: the blueprint
 * and bank stay for everyone else, and deleting them because the person who happened to
 * create it moved on would take other people's mastery history with it. Only a shared
 * concept nobody else has joined is actually deleted.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ conceptId: string }> }) {
  try {
    const userId = await requireUserId();
    const { conceptId } = await ctx.params;
    const id = requireNum(conceptId, 'conceptId');
    const db = getDb();
    const concept = readable(db, userId, id);

    if (concept.visibility === 'shared') {
      const others = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM user_concepts WHERE concept_id = ? AND user_id <> ?`)
          .get(id, userId) as { n: number }
      ).n;

      if (others > 0 || concept.owner_id !== userId) {
        leaveConcept(db, userId, id);
        return ok({ deleted: false, left: true, remainingMembers: others });
      }
    } else {
      editable(db, userId, id);
    }

    deleteConcept(db, id);
    return ok({ deleted: true, left: false });
  } catch (err) {
    return fail(err);
  }
}
