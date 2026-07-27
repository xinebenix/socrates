import { processState } from '../processState';
/**
 * Which cells are being generated right now, in this process.
 *
 * Two writers can want the same cell: the fire-and-forget session warm, the refill
 * after an answer, the worker's batch submitter. Nothing in the database marks a
 * synchronous generation as in progress — items appear only when they are persisted,
 * a minute or more later — so without this registry each writer read the same stale
 * zero and bought the same items again.
 *
 * A module-level registry is the right scope: the SQLite volume pins the deployment
 * to one replica with the worker in-process, so every writer is this process. It lives
 * in its own file because both buffer.ts and batchFill.ts need it and they already
 * import from each other in one direction.
 */

interface Entry {
  promise: Promise<void>;
  done: () => void;
  /** Reference count: a cell can be held by a batch submit and a fill at once. */
  holders: number;
}

const generating = processState('pipeline/cellLock', () => new Map<number, Entry>());

/** Reserved before any await, so a concurrent pass cannot pick the same cell. */
export function reserve(cellIds: Iterable<number>): void {
  for (const id of cellIds) {
    const existing = generating.get(id);
    if (existing) {
      existing.holders++;
      continue;
    }
    let done!: () => void;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    generating.set(id, { promise, done, holders: 1 });
  }
}

export function release(cellId: number): void {
  const entry = generating.get(cellId);
  if (!entry) return;
  entry.holders--;
  if (entry.holders > 0) return;
  generating.delete(cellId);
  entry.done();
}

/** Reserve a group and get one function that releases all of it. */
export function holdCells(cellIds: number[]): () => void {
  reserve(cellIds);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of cellIds) release(id);
  };
}

export function isGenerating(cellId: number): boolean {
  return generating.has(cellId);
}

export function cellsGenerating(): ReadonlySet<number> {
  return new Set(generating.keys());
}

/**
 * Resolves when the generation already running for this cell finishes, or null if
 * none is.
 *
 * The session runner uses this instead of starting its own generation for a cell
 * someone is already writing. Both paths take the same time; the difference is that
 * one of them buys a second copy of the same items.
 */
export function generationInFlight(cellId: number): Promise<void> | null {
  return generating.get(cellId)?.promise ?? null;
}

/** Tests only: drop all reservations so one case cannot leak into the next. */
export function resetCellLocks(): void {
  for (const entry of generating.values()) entry.done();
  generating.clear();
}
