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
 */

import type { Db } from '../db';
import { countBufferedItems } from '../db/queries';
import { plausiblyDueCells } from '../stats';
import { generateItemForCell } from './generateItem';

export function bufferTarget(): number {
  const raw = Number(process.env.GYM_BUFFER_TARGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

/** How many cells ahead of the session runner the worker looks. */
const LOOKAHEAD_CELLS = 24;

export interface TopUpReport {
  generated: number;
  failed: number;
  skipped: number;
}

export async function topUpBuffer(
  db: Db,
  conceptId: number,
  opts: { maxGenerations?: number; target?: number } = {}
): Promise<TopUpReport> {
  const target = opts.target ?? bufferTarget();
  const maxGenerations = opts.maxGenerations ?? 6;
  const report: TopUpReport = { generated: 0, failed: 0, skipped: 0 };

  const cells = plausiblyDueCells(db, conceptId, LOOKAHEAD_CELLS);

  for (const cell of cells) {
    if (report.generated + report.failed >= maxGenerations) break;
    const have = countBufferedItems(db, cell.cellId, 'mc');
    if (have >= target) {
      report.skipped++;
      continue;
    }
    try {
      const outcome = await generateItemForCell(db, cell.cellId);
      if (outcome.item) report.generated++;
      else report.failed++;
    } catch {
      report.failed++;
    }
  }

  return report;
}

/**
 * Fire-and-forget top-up, called after an item is served so the buffer refills while
 * the user is reading. Failures are swallowed on purpose — a generation error must
 * never take down the answer path.
 */
export function topUpInBackground(db: Db, conceptId: number): void {
  void topUpBuffer(db, conceptId, { maxGenerations: 2 }).catch(() => {});
}
