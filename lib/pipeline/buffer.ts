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
import { generateItemForCell } from './generateItem';

export function bufferTarget(): number {
  const raw = Number(process.env.GYM_BUFFER_TARGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
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
  const maxGenerations = opts.maxGenerations ?? 6;
  const report: TopUpReport = { generated: 0, failed: 0, skipped: 0 };

  const due = plausiblyDueCells(db, conceptId, lookaheadCells()).map((c) => c.cellId);
  const ordered = opts.priorityCellIds?.length
    ? [...new Set([...opts.priorityCellIds, ...due])]
    : due;

  // Choosing what is short is a synchronous pass that completes before any generation
  // starts, so the concurrent fills below cannot race each other's counts.
  const short: number[] = [];
  for (const cellId of ordered) {
    if (short.length >= maxGenerations) break;
    if (countBufferedItems(db, cellId, 'mc') >= target) {
      report.skipped++;
      continue;
    }
    short.push(cellId);
  }

  await pooled(
    short.map((cellId) => async () => {
      try {
        const outcome = await generateItemForCell(db, cellId);
        if (outcome.item) report.generated++;
        else report.failed++;
      } catch {
        report.failed++;
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
  void topUpBuffer(db, conceptId, { maxGenerations: 4, priorityCellIds }).catch(() => {});
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
    maxGenerations: Math.min(unique.length, 8),
  }).catch(() => {});
}
