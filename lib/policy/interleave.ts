/**
 * Invariant 7: never two consecutive items from the same node.
 *
 * Blocked practice feels productive and underperforms interleaving. The constraint
 * is a minimum gap of 2 in the served sequence, plus no node more than twice in any
 * window of 5.
 */

export const WINDOW = 5;
export const MAX_PER_WINDOW = 2;

export interface Interleavable {
  nodeId: number;
}

export interface InterleaveResult<T> {
  ordered: T[];
  /** Set when the blueprint is too small to satisfy the constraint. */
  warning: string | null;
}

/**
 * Greedy, largest-remaining-first. That ordering is what makes the no-adjacent
 * constraint satisfiable whenever it is satisfiable at all: the node with the most
 * items left is the one most at risk of being forced into an adjacency later.
 */
export function interleave<T extends Interleavable>(items: T[]): InterleaveResult<T> {
  const remaining = new Map<number, T[]>();
  for (const item of items) {
    const list = remaining.get(item.nodeId);
    if (list) list.push(item);
    else remaining.set(item.nodeId, [item]);
  }

  const ordered: T[] = [];
  const placedNodes: number[] = [];
  let relaxations = 0;

  while (ordered.length < items.length) {
    const prev = placedNodes.length > 0 ? placedNodes[placedNodes.length - 1] : null;
    const window = placedNodes.slice(-(WINDOW - 1));

    const candidates = [...remaining.entries()].filter(([, list]) => list.length > 0);
    const left = items.length - ordered.length;

    const strict = candidates.filter(
      ([nodeId]) => nodeId !== prev && countIn(window, nodeId) < MAX_PER_WINDOW
    );
    const loose = candidates.filter(([nodeId]) => nodeId !== prev);

    // A node holding at least half of what is left must go now, or it will be forced
    // into an adjacency later. The minimum gap of 2 is invariant 7 proper; the
    // window rule is the secondary constraint, so adjacency wins when they conflict.
    const forced = loose.find(([, list]) => list.length >= Math.ceil(left / 2));

    let pool: typeof candidates;
    if (forced) {
      pool = [forced];
      if (!strict.some(([id]) => id === forced[0])) relaxations++;
    } else if (strict.length > 0) {
      pool = strict;
    } else if (loose.length > 0) {
      pool = loose;
      relaxations++;
    } else {
      pool = candidates;
      relaxations++;
    }

    // Largest remaining first; node id as a deterministic tie-break.
    pool.sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    const [nodeId, list] = pool[0];
    ordered.push(list.shift()!);
    placedNodes.push(nodeId);
    if (list.length === 0) remaining.delete(nodeId);
  }

  return {
    ordered,
    warning:
      relaxations > 0
        ? `interleave constraint relaxed ${relaxations} time(s): the blueprint has too few nodes ` +
          `for ${items.length} items. Minimum gap maximized instead.`
        : null,
  };
}

function countIn(window: number[], nodeId: number): number {
  let n = 0;
  for (const x of window) if (x === nodeId) n++;
  return n;
}

/** Used by the acceptance test and by the runtime warning path. */
export function checkInterleave(nodeIds: number[]): {
  adjacentViolations: number;
  windowViolations: number;
} {
  let adjacentViolations = 0;
  for (let i = 1; i < nodeIds.length; i++) {
    if (nodeIds[i] === nodeIds[i - 1]) adjacentViolations++;
  }

  let windowViolations = 0;
  for (let i = 0; i + WINDOW <= nodeIds.length; i++) {
    const w = nodeIds.slice(i, i + WINDOW);
    const counts = new Map<number, number>();
    for (const n of w) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const c of counts.values()) if (c > MAX_PER_WINDOW) windowViolations++;
  }

  return { adjacentViolations, windowViolations };
}
