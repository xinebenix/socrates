/**
 * Session assembly (7.3).
 *
 * A session is a list of items assembled *before* it starts, not chosen one at a
 * time. Fill in priority order — remediation, due review, frontier — then apply the
 * interleave constraint, then place the single D6 item last.
 */

import type { SlotKind } from '../db/types';
import { isDue, overdueness, effectiveMastery } from '../schedule/decay';
import { interleave } from './interleave';
import {
  cellMastered,
  eligibleD6Cells,
  frontierDepth,
  nodeFallbackDepth,
  nodeMaxDepth,
  type CellSnapshot,
} from './frontier';

export const DEFAULT_SESSION_LENGTH = 20;
export const MIN_SESSION_LENGTH = 10;
export const MAX_SESSION_LENGTH = 40;

export const REMEDIATION_SHARE = 0.2;
export const DUE_SHARE = 0.6;
/** D6 is expensive and slow: one per session, placed last. */
export const MAX_D6_PER_SESSION = 1;

export interface Slot {
  cellId: number;
  nodeId: number;
  depth: number;
  slotKind: SlotKind;
}

export interface AssembleInput {
  cells: CellSnapshot[];
  /** Nodes carrying at least one active misconception. */
  remediationNodeIds: Set<number>;
  targetLength: number;
  now: Date;
  /** Phase 1 runs frontier-only; spacing turns this on. */
  includeSpacing?: boolean;
}

export interface AssembleResult {
  slots: Slot[];
  warning: string | null;
  frontier: number;
}

export function clampSessionLength(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SESSION_LENGTH;
  return Math.min(MAX_SESSION_LENGTH, Math.max(MIN_SESSION_LENGTH, Math.round(n)));
}

export function assembleSession(input: AssembleInput): AssembleResult {
  const { cells, remediationNodeIds, now } = input;
  const includeSpacing = input.includeSpacing ?? true;
  const target = clampSessionLength(input.targetLength);

  const frontier = frontierDepth(cells);
  const capByNode = new Map<number, number>();
  for (const nodeId of new Set(cells.map((c) => c.nodeId))) {
    capByNode.set(nodeId, nodeMaxDepth(cells, nodeId, frontier));
  }

  const taken = new Set<number>();
  const picked: Slot[] = [];

  const push = (c: CellSnapshot, slotKind: SlotKind) => {
    if (taken.has(c.cellId)) return false;
    taken.add(c.cellId);
    picked.push({ cellId: c.cellId, nodeId: c.nodeId, depth: c.depth, slotKind });
    return true;
  };

  const mcCells = cells.filter((c) => c.applicable && c.depth <= 5);

  // 1. Remediation — up to 20%. Cells whose node has an active misconception. We want
  //    to see whether the belief is corrected, not just whether the node is passable.
  if (includeSpacing && remediationNodeIds.size > 0) {
    const quota = Math.floor(target * REMEDIATION_SHARE);
    const candidates = mcCells
      .filter((c) => remediationNodeIds.has(c.nodeId))
      .filter((c) => c.depth <= (capByNode.get(c.nodeId) ?? frontier))
      .sort(
        (a, b) =>
          Number(cellMastered(a)) - Number(cellMastered(b)) ||
          eff(a, now) - eff(b, now) ||
          a.depth - b.depth
      );
    for (const c of candidates) {
      if (picked.length >= quota) break;
      push(c, 'remediation');
    }
  }

  // 2. Due review — up to 60%, sorted by overdueness descending.
  if (includeSpacing) {
    const quota = Math.floor(target * (REMEDIATION_SHARE + DUE_SHARE));
    const candidates = mcCells
      .filter((c) => isDue(c.nextDueAt, now))
      .sort(
        (a, b) =>
          overdueness(b.nextDueAt, b.intervalDays, now) -
          overdueness(a.nextDueAt, a.intervalDays, now)
      );
    for (const c of candidates) {
      if (picked.length >= quota) break;
      push(c, 'due');
    }
  }

  // 3. Frontier — the remainder. Unstarted or unmastered cells at the current depth
  //    frontier, chosen breadth-first across nodes.
  //
  //    A cell may be picked more than once. Every administration generates a fresh
  //    item (invariant 6), so revisiting a cell is a second rep rather than the same
  //    question twice — and without it a fresh blueprint could only ever produce a
  //    session as long as it has nodes.
  const queues = frontierQueues(cells, mcCells, capByNode);
  const reps = new Map<number, number>();
  for (const cellId of taken) reps.set(cellId, 1);

  let guard = 0;
  while (picked.length < target && queues.length > 0 && guard++ < target * 8) {
    let placedAny = false;
    for (const q of queues) {
      if (picked.length >= target) break;
      // Within a node: fewest reps so far, then shallowest.
      const next = q.cells
        .slice()
        .sort(
          (a, b) => (reps.get(a.cellId) ?? 0) - (reps.get(b.cellId) ?? 0) || a.depth - b.depth
        )[0];
      if (!next) continue;
      reps.set(next.cellId, (reps.get(next.cellId) ?? 0) + 1);
      picked.push({
        cellId: next.cellId,
        nodeId: next.nodeId,
        depth: next.depth,
        slotKind: 'frontier',
      });
      taken.add(next.cellId);
      placedAny = true;
    }
    if (!placedAny) break;
  }

  const { ordered, warning } = interleave(picked);

  // D6 last, at most one. Placing it last supersedes the interleave ordering, so if
  // it would land next to another item from the same node the two preceding items
  // are swapped to restore the gap.
  const d6 = includeSpacing ? pickD6(cells, now) : null;
  if (!d6) return { slots: ordered.slice(0, target), warning, frontier };

  const head = ordered.slice(0, Math.max(0, target - MAX_D6_PER_SESSION));
  if (head.length >= 2 && head[head.length - 1].nodeId === d6.nodeId) {
    const last = head.length - 1;
    const swapWith = head.findIndex((s, i) => i < last - 1 && s.nodeId !== d6.nodeId);
    if (swapWith >= 0) {
      [head[last], head[swapWith]] = [head[swapWith], head[last]];
    }
  }

  return { slots: [...head, d6], warning, frontier };
}

function eff(c: CellSnapshot, now: Date): number {
  return effectiveMastery(c.pMastery, c.lastTestedAt, c.intervalDays, now);
}

/** One ascending queue of servable depths per node, in node order. */
function frontierQueues(
  allCells: CellSnapshot[],
  mcCells: CellSnapshot[],
  capByNode: Map<number, number>
): { nodeId: number; cells: CellSnapshot[] }[] {
  const byNode = new Map<number, CellSnapshot[]>();

  for (const c of mcCells) {
    if (c.depth > (capByNode.get(c.nodeId) ?? 1)) continue;
    // A node dropped back after three consecutive failures re-drills the level below
    // even though it reads as mastered — the failures above are the evidence that it
    // is not.
    const fallback = nodeFallbackDepth(allCells, c.nodeId);
    if (cellMastered(c) && c.depth !== fallback) continue;

    const list = byNode.get(c.nodeId);
    if (list) list.push(c);
    else byNode.set(c.nodeId, [c]);
  }

  return [...byNode.entries()]
    .map(([nodeId, cs]) => ({
      nodeId,
      nodeOrder: cs[0].nodeOrder,
      cells: cs.sort((a, b) => a.depth - b.depth),
    }))
    .sort((a, b) => a.nodeOrder - b.nodeOrder || a.nodeId - b.nodeId);
}

function pickD6(cells: CellSnapshot[], now: Date): Slot | null {
  const eligible = eligibleD6Cells(cells);
  if (eligible.length === 0) return null;

  // Prefer the one that is due, then the one least recently visited.
  eligible.sort((a, b) => {
    const dueDelta = Number(isDue(b.nextDueAt, now)) - Number(isDue(a.nextDueAt, now));
    if (dueDelta !== 0) return dueDelta;
    const at = a.lastTestedAt ? Date.parse(a.lastTestedAt) : 0;
    const bt = b.lastTestedAt ? Date.parse(b.lastTestedAt) : 0;
    return at - bt;
  });

  const c = eligible[0];
  return { cellId: c.cellId, nodeId: c.nodeId, depth: 6, slotKind: 'd6' };
}
