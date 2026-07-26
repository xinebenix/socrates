/**
 * Session lifecycle: plan the whole session up front, then serve one item at a time
 * from the pre-generation buffer.
 */

import type { Db } from '../db';
import { now } from '../clock';
import { assembleSession, clampSessionLength, DEFAULT_SESSION_LENGTH } from '../policy/assemble';
import { loadCellSnapshots } from '../policy/snapshot';
import { activeMisconceptions } from '../db/queries';
import type { ItemRow, OptionRow, RubricCriterion, SessionKind } from '../db/types';
import {
  attachItemToSlot,
  createSession,
  dropSlot,
  getCell,
  getItem,
  getNode,
  listOptions,
  listSessionPlan,
  markItemServed,
  nextUnservedSlot,
  takeBufferedItem,
  writeSessionPlan,
} from '../db/queries';
import { generateItemForCell } from './generateItem';
import { parseRubric } from './respond';
import { generationInFlight, topUpInBackground, warmSessionPlan } from './buffer';

export interface StartSessionOptions {
  length?: number;
  kind?: SessionKind;
  /** Phase 1 ran frontier-only; leave on unless you are reproducing that. */
  includeSpacing?: boolean;
}

export interface StartedSession {
  sessionId: number;
  planned: number;
  warning: string | null;
  frontier: number;
}

export function startSession(
  db: Db,
  conceptId: number,
  opts: StartSessionOptions = {}
): StartedSession {
  const cells = loadCellSnapshots(db, conceptId);
  if (cells.length === 0) {
    throw new Error('this concept has no blueprint yet — generate one first');
  }

  const remediationNodeIds = new Set(activeMisconceptions(db, conceptId).map((m) => m.node_id));

  const { slots, warning, frontier } = assembleSession({
    cells,
    remediationNodeIds,
    targetLength: clampSessionLength(opts.length ?? DEFAULT_SESSION_LENGTH),
    now: now(),
    includeSpacing: opts.includeSpacing ?? true,
  });

  if (slots.length === 0) {
    throw new Error('nothing to serve: every applicable cell is mastered and nothing is due');
  }

  const session = createSession(db, conceptId, opts.kind ?? 'practice');
  writeSessionPlan(
    db,
    session.id,
    slots.map((s) => ({ cellId: s.cellId, slotKind: s.slotKind }))
  );

  // The plan is known now, so start filling its cells immediately rather than letting
  // the first few items be generated inline while the user waits on them.
  warmSessionPlan(
    db,
    conceptId,
    slots.map((s) => s.cellId)
  );

  return { sessionId: session.id, planned: slots.length, warning, frontier };
}

export interface ServedMcItem {
  kind: 'mc';
  itemId: number;
  cellId: number;
  stem: string;
  options: { id: number; position: number; text: string }[];
  nodeTitle: string;
  depth: number;
  position: number;
  total: number;
}

export interface ServedFreeItem {
  kind: 'free';
  itemId: number;
  cellId: number;
  stem: string;
  rubricCount: number;
  nodeTitle: string;
  depth: number;
  position: number;
  total: number;
}

export type ServedItem = ServedMcItem | ServedFreeItem;

/** How many items this request will generate inline before giving up for now. */
const MAX_INLINE_GENERATIONS = 3;

/**
 * How long to wait for a generation already running for the cell we need.
 *
 * Long enough to cover a generate-plus-validate round on a slow model, short enough
 * that a wedged call still falls through to generating our own rather than hanging
 * the request.
 */
export const WAIT_FOR_INFLIGHT_MS = 75_000;

export interface NextItemResult {
  item: ServedItem | null;
  /** Slots abandoned because their item could not be generated. */
  dropped: number;
  /** Why the last drop happened. Surfaced to the user rather than swallowed. */
  lastError: string | null;
}

/**
 * The next item, taken from the buffer when one is ready and generated inline only
 * when it is not.
 *
 * A slot whose generation fails is dropped and the session moves on — a broken cell
 * must not take down the rest of the session. The reason is carried back rather than
 * swallowed, so "no more items" and "generation is failing" are distinguishable.
 */
export async function nextItem(db: Db, sessionId: number): Promise<NextItemResult> {
  const plan = listSessionPlan(db, sessionId);
  const total = plan.length;

  let dropped = 0;
  let lastError: string | null = null;
  let inlineGenerations = 0;

  for (;;) {
    const slot = nextUnservedSlot(db, sessionId);
    if (!slot) return { item: null, dropped, lastError };

    const cell = getCell(db, slot.cell_id);
    if (!cell) {
      dropSlot(db, sessionId, slot.position);
      dropped++;
      continue;
    }

    const kind = cell.depth === 6 ? 'free' : 'mc';

    // A benchmark plan pins its items at plan time; practice takes from the buffer.
    let item: ItemRow | undefined =
      slot.item_id != null ? getItem(db, slot.item_id) : takeBufferedItem(db, cell.id, kind);

    // Someone may already be writing this exact cell — the session-start warm, or the
    // refill from the previous answer. Waiting for that costs the same as generating
    // and buys the items once instead of twice. Bounded, so a stuck generation cannot
    // hold the request open.
    if (!item) {
      const inflight = generationInFlight(cell.id);
      if (inflight) {
        await Promise.race([
          inflight,
          new Promise<void>((r) => setTimeout(r, WAIT_FOR_INFLIGHT_MS)),
        ]);
        item = takeBufferedItem(db, cell.id, kind);
      }
    }

    if (!item) {
      if (inlineGenerations >= MAX_INLINE_GENERATIONS) {
        return {
          item: null,
          dropped,
          lastError:
            lastError ??
            'the pre-generation buffer is empty for the remaining cells. Leave the worker ' +
              'running (npm run worker) and try again in a moment.',
        };
      }

      inlineGenerations++;
      try {
        const outcome = await generateItemForCell(db, cell.id);
        if (!outcome.item) throw new Error(outcome.error ?? 'generation produced no item');
        item = outcome.item;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        dropSlot(db, sessionId, slot.position);
        dropped++;
        continue;
      }
    }

    attachItemToSlot(db, sessionId, slot.position, item.id);
    markItemServed(db, item.id);

    const node = getNode(db, cell.node_id);
    // Cover the slots still ahead in this session, and nothing beyond them. Once the
    // plan was warmed at session start this finds nothing short and generates nothing
    // — which is the point. Building depth toward GYM_BUFFER_TARGET is the worker's
    // job, done in batches at half price, not something an answered question triggers.
    // The repeats in `plan` are meaningful: a cell serving two slots needs two items.
    if (node) {
      topUpInBackground(
        db,
        node.concept_id,
        plan.filter((p) => p.position > slot.position).map((p) => p.cell_id)
      );
    }

    const shared = {
      itemId: item.id,
      cellId: cell.id,
      stem: item.stem,
      nodeTitle: node?.title ?? '(unknown node)',
      depth: cell.depth,
      position: plan.findIndex((p) => p.position === slot.position) + 1,
      total,
    };

    if (kind === 'free') {
      return {
        item: { ...shared, kind: 'free', rubricCount: parseRubric(item).length },
        dropped,
        lastError,
      };
    }

    // The answer key is deliberately absent from what goes over the wire before
    // submission — is_correct, rationale, and misconception tag stay server-side.
    return {
      item: {
        ...shared,
        kind: 'mc',
        options: listOptions(db, item.id).map((o) => ({
          id: o.id,
          position: o.position,
          text: o.text,
        })),
      },
      dropped,
      lastError,
    };
  }
}

export interface SessionProgress {
  total: number;
  served: number;
  answered: number;
}

export function sessionProgress(db: Db, sessionId: number): SessionProgress {
  const plan = listSessionPlan(db, sessionId);
  const answered = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM responses WHERE session_id = ?`)
      .get(sessionId) as { n: number }
  ).n;
  return {
    total: plan.length,
    served: plan.filter((p) => p.served_at != null).length,
    answered,
  };
}

/** Server-side view of an item, used by the respond route to build feedback. */
export function loadItemForFeedback(
  db: Db,
  itemId: number
): { item: ItemRow; options: OptionRow[]; rubric: RubricCriterion[] } | null {
  const item = getItem(db, itemId);
  if (!item) return null;
  return { item, options: listOptions(db, itemId), rubric: parseRubric(item) };
}
