import type { Db } from '../db';
import { consecutiveWrong, listCells } from '../db/queries';
import type { CellSnapshot } from './frontier';

/** Load every cell of a concept in the shape the policy layer reasons about. */
export function loadCellSnapshots(db: Db, conceptId: number): CellSnapshot[] {
  return listCells(db, conceptId).map((c) => ({
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
    consecutiveWrong: c.response_count > 0 ? consecutiveWrong(db, c.id) : 0,
  }));
}
