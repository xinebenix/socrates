import { getDb, type Db } from '@/lib/db';
import {
  createNode,
  deleteMisconception,
  deleteNode,
  ensureCells,
  getConcept,
  getNode,
  listMisconceptions,
  listNodes,
  setCellApplicable,
  updateMisconception,
  updateNode,
  upsertMisconception,
} from '@/lib/db/queries';
import { generateBlueprint } from '@/lib/pipeline/blueprint';
import { buildGrid } from '@/lib/stats';
import { blueprintAlarm, nodeHealth } from '@/lib/analysis/itemStats';
import { bad, editable, fail, ok, readable, requireNum, requireUserId } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const conceptId = requireNum(new URL(req.url).searchParams.get('conceptId'), 'conceptId');
    const db = getDb();
    const concept = readable(db, userId, conceptId);

    const nodes = listNodes(db, conceptId).map((n) => ({
      ...n,
      misconceptions: listMisconceptions(db, n.id),
    }));

    return ok({
      concept,
      nodes,
      grid: buildGrid(db, userId, conceptId),
      canEdit: concept.owner_id === userId,
      health: nodeHealth(db, conceptId),
      alarm: blueprintAlarm(db, conceptId),
    });
  } catch (err) {
    return fail(err);
  }
}

/** Generate (or regenerate and merge) the blueprint. */
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json()) as { conceptId?: number; hints?: string };
    const conceptId = requireNum(body.conceptId, 'conceptId');
    const db = getDb();
    // Regenerating merges into the existing blueprint, so on a shared concept it changes
    // the map everybody else is being tested against. Owner only.
    editable(db, userId, conceptId);
    const report = await generateBlueprint(db, conceptId, body.hints ?? null);
    return ok({ report });
  } catch (err) {
    return fail(err);
  }
}

type Op =
  | { op: 'update-node'; nodeId: number; title?: string; description?: string }
  | { op: 'add-node'; conceptId: number; title: string; description: string; applicableDepths?: number[] }
  | { op: 'delete-node'; nodeId: number }
  | { op: 'reorder-nodes'; nodeIds: number[] }
  | { op: 'set-applicable'; nodeId: number; depth: number; applicable: boolean }
  | { op: 'add-misconception'; nodeId: number; label: string; description: string }
  | { op: 'update-misconception'; id: number; label?: string; description?: string }
  | { op: 'delete-misconception'; id: number };

/**
 * Hand editing must be frictionless — this screen is the one the user should be
 * encouraged to change. Every op preserves cells, mastery, and response history
 * except `delete-node`, which is explicit.
 */
export async function PATCH(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json()) as { ops?: Op[] };
    const ops = body.ops ?? [];
    if (ops.length === 0) return bad('no ops supplied');

    const db = getDb();
    // Authorize before the transaction, and authorize every concept the batch touches.
    // Ops reach a concept by several routes — a node id, a misconception id, or the id
    // itself — so resolving them up front is what makes "the caller owns everything this
    // edits" checkable in one place rather than eight.
    for (const conceptId of conceptsTouched(db, ops)) editable(db, userId, conceptId);

    let conceptId: number | null = null;

    const tx = db.transaction(() => {
      for (const op of ops) {
        switch (op.op) {
          case 'update-node': {
            const node = getNode(db, op.nodeId);
            if (!node) throw new Error(`node ${op.nodeId} not found`);
            conceptId ??= node.concept_id;
            updateNode(db, op.nodeId, { title: op.title, description: op.description });
            break;
          }
          case 'add-node': {
            conceptId ??= op.conceptId;
            const order = listNodes(db, op.conceptId).length;
            createNode(db, {
              conceptId: op.conceptId,
              title: op.title,
              description: op.description,
              orderIndex: order,
              origin: 'user',
              applicableDepths: op.applicableDepths ?? [1, 2, 3, 4, 5, 6],
            });
            break;
          }
          case 'delete-node': {
            const node = getNode(db, op.nodeId);
            if (node) conceptId ??= node.concept_id;
            deleteNode(db, op.nodeId);
            break;
          }
          case 'reorder-nodes': {
            op.nodeIds.forEach((id, i) => {
              const node = getNode(db, id);
              if (!node) return;
              conceptId ??= node.concept_id;
              updateNode(db, id, { orderIndex: i });
            });
            break;
          }
          case 'set-applicable': {
            const node = getNode(db, op.nodeId);
            if (!node) throw new Error(`node ${op.nodeId} not found`);
            conceptId ??= node.concept_id;
            ensureCells(db, op.nodeId, []);
            const cell = db
              .prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = ?`)
              .get(op.nodeId, op.depth) as { id: number } | undefined;
            // ensureCells with [] would clear every flag, so restore from current state
            // and then apply just the one change the user asked for.
            const current = db
              .prepare(`SELECT depth, applicable FROM cells WHERE node_id = ?`)
              .all(op.nodeId) as { depth: number; applicable: number }[];
            const depths = current.filter((c) => c.applicable === 1).map((c) => c.depth);
            const next = new Set(depths);
            if (op.applicable) next.add(op.depth);
            else next.delete(op.depth);
            ensureCells(db, op.nodeId, [...next]);
            if (cell) setCellApplicable(db, cell.id, op.applicable);
            break;
          }
          case 'add-misconception': {
            const node = getNode(db, op.nodeId);
            if (!node) throw new Error(`node ${op.nodeId} not found`);
            conceptId ??= node.concept_id;
            upsertMisconception(db, {
              nodeId: op.nodeId,
              label: op.label,
              description: op.description,
              origin: 'user',
            });
            break;
          }
          case 'update-misconception':
            updateMisconception(db, op.id, { label: op.label, description: op.description });
            break;
          case 'delete-misconception':
            deleteMisconception(db, op.id);
            break;
          default:
            throw new Error(`unknown op`);
        }
      }
    });

    tx();

    if (conceptId == null) return ok({ updated: true });

    const nodes = listNodes(db, conceptId).map((n) => ({
      ...n,
      misconceptions: listMisconceptions(db, n.id),
    }));
    return ok({ updated: true, nodes, grid: buildGrid(db, userId, conceptId) });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Every concept a batch of ops would change.
 *
 * Ops name their target in three different ways, so this walks each back to the concept
 * it belongs to. An op whose target no longer exists contributes nothing — the op itself
 * will fail inside the transaction, which is where that error belongs.
 */
function conceptsTouched(db: Db, ops: Op[]): number[] {
  const ids = new Set<number>();
  const fromNode = (nodeId: number) => {
    const node = getNode(db, nodeId);
    if (node) ids.add(node.concept_id);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'add-node':
        ids.add(op.conceptId);
        break;
      case 'update-node':
      case 'delete-node':
      case 'set-applicable':
      case 'add-misconception':
        fromNode(op.nodeId);
        break;
      case 'reorder-nodes':
        op.nodeIds.forEach(fromNode);
        break;
      case 'update-misconception':
      case 'delete-misconception': {
        const row = db.prepare(`SELECT node_id FROM misconceptions WHERE id = ?`).get(op.id) as
          | { node_id: number }
          | undefined;
        if (row) fromNode(row.node_id);
        break;
      }
    }
  }
  return [...ids];
}
