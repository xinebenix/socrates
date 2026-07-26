/**
 * The pre-generation buffer.
 *
 * Item generation plus validation is two sequential LLM calls and will feel slow
 * inside a session. This keeps at least GYM_BUFFER_TARGET validated, unserved items
 * ready for every cell that is plausibly due soon. The session runner serves from
 * the buffer and only blocks on generation if the buffer is empty.
 *
 * A gym with a ten-second pause between reps will not get used, so this is a Phase 1
 * requirement rather than an optimization.
 *
 * The two calls per item are sequential by necessity — the validator cannot solve an
 * item that has not been written yet. Different items carry no such dependency, so
 * they fill concurrently: while one item is being validated the next is being
 * written. Serially this loop produced roughly one item a minute, which is slower
 * than a session consumes them, so the buffer never got ahead of the runner.
 */

import type { Db } from '../db';
import { countBufferedItems } from '../db/queries';
import { plausiblyDueCells } from '../stats';
import { MAX_ITEMS_PER_CALL } from '../prompts/itemMc';
import { generateItemsForCell } from './generateItem';

/**
 * Validated, unserved items kept ready per plausibly-due cell — and, because a cell's
 * whole shortfall goes into one call, also the size of a generation set.
 *
 * Raising this is the one dial that makes items *cheaper* per item as it goes up: the
 * reasoning about the cell is divided across more of them. What it costs is money
 * committed earlier (see GYM_LOOKAHEAD_CELLS) and a longer wait for the first fill.
 * Capped at MAX_ITEMS_PER_CALL, past which set quality starts to slip.
 */
export function bufferTarget(): number {
  const raw = Number(process.env.GYM_BUFFER_TARGET);
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.min(Math.floor(raw), MAX_ITEMS_PER_CALL);
}

/**
 * How many items are written at once.
 *
 * Bounded because the real ceiling is the Anthropic account's rate limit rather than
 * the local event loop. Overshooting converts a latency problem into a 429 problem,
 * which is slower still.
 */
export function bufferConcurrency(): number {
  const raw = Number(process.env.GYM_BUFFER_CONCURRENCY);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 12);
  return 4;
}

/**
 * The remaining-item count at or below which a cell is refilled — and refilled all
 * the way back to the target, in one call.
 *
 * Without this, "short" meant `have < target`, so serving a single item from a
 * ten-deep cell triggered a call for exactly one item. That is the most expensive
 * shape a generation can take: the reasoning about the cell gets paid in full and
 * amortized across nothing. Sets made the first fill cheap and left every refill
 * afterwards at the old price.
 *
 * So the buffer has hysteresis. It drains to the low-water mark, then refills in one
 * call. Deeper buffer, fewer calls, cheaper items — the same trade as any batch.
 *
 * The default is 40% of the target, so a cell of 10 refills once 6 have been used.
 * There is no risk of running dry in the gap: invariant 7 forbids two consecutive
 * items from the same node, so a single cell drains at most every other item, and
 * the remaining 4 cover far more of the session than a refill takes.
 *
 * GYM_BUFFER_REFILL_AT sets it as an absolute count. 0 means refill only when the
 * cell is empty — maximum amortization, no slack.
 */
export function refillThreshold(target = bufferTarget()): number {
  const raw = Number(process.env.GYM_BUFFER_REFILL_AT);
  const chosen =
    Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : Math.max(1, Math.ceil(target * 0.4));
  // Never at or above the target: a cell holding its full target is not short.
  return Math.min(chosen, Math.max(0, target - 1));
}

/**
 * How many cells ahead of the session runner the worker looks.
 *
 * This is the cost dial nobody thinks to look at. At 24 cells and a target of 3, the
 * worker commits to 72 items per concept — 144 model calls — to serve the 20 a
 * session actually uses. Those items are not wasted, they are served eventually, but
 * it is a month of spending brought forward into today, which is the wrong trade for
 * a tool you are still deciding whether to keep using.
 *
 * Twelve is roughly one session's breadth. Raise it if you train several times a day.
 */
export function lookaheadCells(): number {
  const raw = Number(process.env.GYM_LOOKAHEAD_CELLS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 60);
  return 12;
}

export interface TopUpReport {
  generated: number;
  failed: number;
  skipped: number;
}

/**
 * Which of these cells are short of the target, and by how much. Shared by the
 * synchronous fill and the batch pipeline so the two can never disagree about what
 * "short" means.
 */
export function computeShortfalls(
  db: Db,
  orderedCellIds: number[],
  opts: {
    target: number;
    maxGenerations: number;
    exclude?: Set<number>;
    /** Refill only once a cell has drained to this many items. See refillThreshold. */
    refillAt?: number;
  }
): { short: { cellId: number; want: number }[]; skipped: number } {
  const short: { cellId: number; want: number }[] = [];
  const refillAt = opts.refillAt ?? refillThreshold(opts.target);
  let skipped = 0;
  let budgeted = 0;

  for (const cellId of orderedCellIds) {
    if (budgeted >= opts.maxGenerations) break;
    if (opts.exclude?.has(cellId)) continue;
    const have = countBufferedItems(db, cellId, 'mc');

    // Hysteresis: a partly-drained cell is left alone until it reaches the low-water
    // mark, then refilled to the target in a single call. Topping up by one after
    // every served item would pay the cell's reasoning cost per item and undo the
    // whole point of generating sets.
    if (have > refillAt) {
      skipped++;
      continue;
    }

    const want = opts.target - have;
    if (want <= 0) {
      skipped++;
      continue;
    }

    // A cell's shortfall is never clipped to fit the remaining tick budget. Clipping
    // would split one cheap call into two expensive ones across two ticks and lose
    // the amortization the set generation exists for — the budget is a ceiling on
    // how much a tick starts, not a scalpel on individual cells.
    short.push({ cellId, want });
    budgeted += want;
  }

  return { short, skipped };
}

/** The worker's view: every plausibly-due cell that is short, minus what is in flight. */
export function dueShortfalls(
  db: Db,
  conceptId: number,
  opts: { maxGenerations: number; exclude?: Set<number> }
): { cellId: number; want: number }[] {
  const due = plausiblyDueCells(db, conceptId, lookaheadCells()).map((c) => c.cellId);
  return computeShortfalls(db, due, {
    target: bufferTarget(),
    maxGenerations: opts.maxGenerations,
    exclude: opts.exclude,
    refillAt: refillThreshold(),
  }).short;
}

/**
 * Run tasks with a fixed number in flight. Each task records its own outcome, so one
 * failure cannot abort the rest of the batch.
 */
async function pooled(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) await tasks[cursor++]();
  });
  await Promise.all(lanes);
}

export async function topUpBuffer(
  db: Db,
  conceptId: number,
  opts: {
    maxGenerations?: number;
    target?: number;
    concurrency?: number;
    /** Filled first. The session runner is about to want exactly these. */
    priorityCellIds?: number[];
  } = {}
): Promise<TopUpReport> {
  const target = opts.target ?? bufferTarget();
  // Two cells' worth by default, so a raised target does not turn every top-up into
  // a single-cell fill.
  const maxGenerations = opts.maxGenerations ?? Math.max(6, target * 2);
  const report: TopUpReport = { generated: 0, failed: 0, skipped: 0 };

  const due = plausiblyDueCells(db, conceptId, lookaheadCells()).map((c) => c.cellId);
  const ordered = opts.priorityCellIds?.length
    ? [...new Set([...opts.priorityCellIds, ...due])]
    : due;

  // Choosing what is short is a synchronous pass that completes before any generation
  // starts, so the concurrent fills below cannot race each other's counts.
  //
  // A cell's whole shortfall goes into ONE call. The reasoning a generation does before
  // writing an item is about the cell, not the item, so filling a cell three-deep in
  // one call costs far less than three calls — see generateMcItems.
  const { short, skipped } = computeShortfalls(db, ordered, { target, maxGenerations });
  report.skipped += skipped;

  await pooled(
    short.map(({ cellId, want }) => async () => {
      try {
        const outcome = await generateItemsForCell(db, cellId, want);
        report.generated += outcome.items.length;
        if (outcome.items.length < want) report.failed += want - outcome.items.length;
      } catch {
        report.failed += want;
      }
    }),
    opts.concurrency ?? bufferConcurrency()
  );

  return report;
}

/**
 * Fire-and-forget top-up, called after an item is served so the buffer refills while
 * the user is reading. Failures are swallowed on purpose — a generation error must
 * never take down the answer path.
 */
export function topUpInBackground(db: Db, conceptId: number, priorityCellIds?: number[]): void {
  void topUpBuffer(db, conceptId, {
    maxGenerations: Math.max(4, bufferTarget()),
    priorityCellIds,
  }).catch(() => {});
}

/**
 * Called the moment a session is planned, before the first item is asked for.
 *
 * Without it the opening items of every session are generated inline while the user
 * waits: the worker's next tick could be a minute away, and it would not have known
 * to prefer these cells anyway.
 */
export function warmSessionPlan(db: Db, conceptId: number, cellIds: number[]): void {
  const unique = [...new Set(cellIds)];
  void topUpBuffer(db, conceptId, {
    priorityCellIds: unique,
    // One item for each planned cell is what this session actually needs; the worker
    // deepens them afterwards. Filling to the full target here would delay the first
    // item to buy items for a session that has not started.
    target: 1,
    maxGenerations: Math.min(unique.length, 10),
  }).catch(() => {});
}
