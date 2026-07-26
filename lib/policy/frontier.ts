/**
 * Depth advancement (7.4) and D6 promotion (7.5).
 *
 * This is what stops the system over-drilling one corner while the map stays blank.
 * Pure functions over cell snapshots so the rules can be tested without a database.
 */

import { isMastered } from '../mastery/bkt';
import { MC_DEPTHS } from '../prompts/depth';

export interface CellSnapshot {
  cellId: number;
  nodeId: number;
  nodeOrder: number;
  depth: number;
  applicable: boolean;
  pMastery: number;
  responseCount: number;
  lastTestedAt: string | null;
  nextDueAt: string | null;
  intervalDays: number;
  /** Trailing incorrect responses, derived from the response log. */
  consecutiveWrong: number;
}

export const ADVANCE_THRESHOLD = 0.8;
export const NODE_FALLBACK_FAILURES = 3;

export function cellMastered(c: CellSnapshot): boolean {
  return isMastered(c.pMastery, c.responseCount);
}

/**
 * Fraction of applicable nodes mastered at this depth. A depth no node marks
 * applicable is vacuously satisfied, so the frontier does not stall on it.
 */
export function masteryRateAtDepth(cells: CellSnapshot[], depthLevel: number): number {
  const at = cells.filter((c) => c.depth === depthLevel && c.applicable);
  if (at.length === 0) return 1;
  return at.filter(cellMastered).length / at.length;
}

/**
 * The deepest MC level the concept may serve. Do not serve depth d+1 until at least
 * 80% of applicable nodes are mastered at depth d.
 */
export function frontierDepth(cells: CellSnapshot[]): number {
  let frontier = 1;
  for (const d of MC_DEPTHS) {
    if (d === 5) break;
    if (masteryRateAtDepth(cells, d) >= ADVANCE_THRESHOLD) frontier = d + 1;
    else break;
  }
  return frontier;
}

/**
 * Per-node cap. A node that fails at depth d three consecutive times drops back to
 * d-1 for that node only, regardless of the concept-wide frontier.
 */
export function nodeMaxDepth(cells: CellSnapshot[], nodeId: number, frontier: number): number {
  const fallback = nodeFallbackDepth(cells, nodeId);
  return fallback === null ? frontier : Math.min(frontier, fallback);
}

/**
 * The depth a node has been dropped back to, or null if it has not been dropped.
 *
 * The cell at this depth is served again even when it reads as mastered: three
 * consecutive failures one level up are evidence that the mastery below is not
 * real, which is the whole reason for the rule.
 */
export function nodeFallbackDepth(cells: CellSnapshot[], nodeId: number): number | null {
  let fallback: number | null = null;
  for (const c of cells) {
    if (c.nodeId !== nodeId) continue;
    if (c.depth > 5) continue;
    if (c.consecutiveWrong >= NODE_FALLBACK_FAILURES) {
      const dropped = Math.max(1, c.depth - 1);
      fallback = fallback === null ? dropped : Math.min(fallback, dropped);
    }
  }
  return fallback;
}

/**
 * A node becomes eligible for D6 when it is mastered at D1-D5, or at all applicable
 * levels among them.
 */
export function d6Eligible(cells: CellSnapshot[], nodeId: number): boolean {
  const d6 = cells.find((c) => c.nodeId === nodeId && c.depth === 6);
  if (!d6 || !d6.applicable) return false;

  const lower = cells.filter((c) => c.nodeId === nodeId && c.depth <= 5 && c.applicable);
  if (lower.length === 0) return false;
  return lower.every(cellMastered);
}

export function eligibleD6Cells(cells: CellSnapshot[]): CellSnapshot[] {
  const nodeIds = [...new Set(cells.map((c) => c.nodeId))];
  return nodeIds
    .filter((id) => d6Eligible(cells, id))
    .map((id) => cells.find((c) => c.nodeId === id && c.depth === 6)!)
    .filter(Boolean);
}

/** Overall coverage: mastered applicable cells over all applicable cells. */
export function coverage(cells: CellSnapshot[]): number {
  const applicable = cells.filter((c) => c.applicable);
  if (applicable.length === 0) return 0;
  return applicable.filter(cellMastered).length / applicable.length;
}
