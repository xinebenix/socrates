import { getDb } from '@/lib/db';
import { deleteConcept, getConcept } from '@/lib/db/queries';
import { bad, fail, ok, requireNum } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ conceptId: string }> }) {
  try {
    const { conceptId } = await ctx.params;
    const concept = getConcept(getDb(), requireNum(conceptId, 'conceptId'));
    if (!concept) return bad('concept not found', 404);
    return ok({ concept });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ conceptId: string }> }) {
  try {
    const { conceptId } = await ctx.params;
    const id = requireNum(conceptId, 'conceptId');
    const db = getDb();
    const existing = getConcept(db, id);
    if (!existing) return bad('concept not found', 404);

    const body = (await req.json()) as {
      name?: string;
      sourceText?: string;
      sourceNote?: string;
    };

    db.prepare(`UPDATE concepts SET name = ?, source_text = ?, source_note = ? WHERE id = ?`).run(
      body.name?.trim() || existing.name,
      body.sourceText ?? existing.source_text,
      body.sourceNote ?? existing.source_note,
      id
    );

    return ok({ concept: getConcept(db, id) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ conceptId: string }> }) {
  try {
    const { conceptId } = await ctx.params;
    deleteConcept(getDb(), requireNum(conceptId, 'conceptId'));
    return ok({ deleted: true });
  } catch (err) {
    return fail(err);
  }
}
