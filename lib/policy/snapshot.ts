import type { Db } from '../db';
import { consecutiveWrong, listCells } from '../db/queries';
import type { CellSnapshot } from './frontier';

/**
 * Load every cell of a concept in the shape the policy layer reasons about, for one
 * learner. The blueprint half is shared; every number on it is theirs.
 */
export function loadCellSnapshots(db: Db, userId: number, conceptId: number): CellSnapshot[] {
  return listCells(db, userId, conceptId).map((c) => ({
    cellId: c.id,
    nodeId: c.node_id,
    nodeOrder: c.node_order,
    depth: c.depth,
    applicable: c.applicable === 1,
    pMastery: c.p_mastery,
    responseCount: c.response_count,
    lastTestedAt: c.last_tested_at,
    nextDueAt: c.next_due_at,
    intervalDays: c.interval_days,
    consecutiveWrong: c.response_count > 0 ? consecutiveWrong(db, userId, c.id) : 0,
  }));
}
