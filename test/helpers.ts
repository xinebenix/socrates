import type { Db } from '../lib/db';
import { newTestDb, setDb } from '../lib/db';
import { createConcept, createNode } from '../lib/db/queries';
import { setClock, TestClock } from '../lib/clock';

export interface Fixture {
  db: Db;
  clock: TestClock;
  conceptId: number;
  nodeIds: number[];
}

/**
 * A concept with `nodeCount` nodes, every depth applicable, on a frozen clock.
 * The clock is installed globally so every code path under test uses it.
 */
export function makeFixture(nodeCount = 5, depths = [1, 2, 3, 4, 5, 6]): Fixture {
  const clock = new TestClock('2026-01-01T00:00:00.000Z');
  setClock(clock);

  const db = newTestDb();
  setDb(db);

  const concept = createConcept(db, {
    name: 'Socialism',
    sourceText:
      'Social ownership is ownership of the means of production by society as a whole. ' +
      'It is distinct from state ownership, in which a government agency holds title. ' +
      'Market socialism retains price signals while socializing ownership.\n\n' +
      'Central planning allocates resources administratively rather than through prices. ' +
      'The calculation debate concerns whether such allocation can be efficient.',
    sourceNote: 'test fixture',
  });

  const nodeIds: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const node = createNode(db, {
      conceptId: concept.id,
      title: `Node ${i + 1}`,
      description: `What mastery of node ${i + 1} means.`,
      orderIndex: i,
      origin: 'generated',
      applicableDepths: depths,
    });
    nodeIds.push(node.id);
  }

  return { db, clock, conceptId: concept.id, nodeIds };
}

export function addMisconceptions(db: Db, nodeId: number, n = 4): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const info = db
      .prepare(
        `INSERT INTO misconceptions (node_id, label, description, origin, created_at)
         VALUES (?, ?, ?, 'generated', '2026-01-01T00:00:00.000Z')`
      )
      .run(nodeId, `belief-${nodeId}-${i}`, `I think thing ${i} about node ${nodeId}.`);
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

/** Force a cell to a given mastery state without going through the response path. */
export function setCellState(
  db: Db,
  nodeId: number,
  depth: number,
  patch: Partial<{
    pMastery: number;
    responseCount: number;
    lastTestedAt: string | null;
    nextDueAt: string | null;
    intervalDays: number;
    ease: number;
    consecutiveCorrect: number;
  }>
): number {
  const cell = db.prepare(`SELECT * FROM cells WHERE node_id = ? AND depth = ?`).get(nodeId, depth) as
    | { id: number }
    | undefined;
  if (!cell) throw new Error(`no cell for node ${nodeId} depth ${depth}`);

  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    pMastery: 'p_mastery',
    responseCount: 'response_count',
    lastTestedAt: 'last_tested_at',
    nextDueAt: 'next_due_at',
    intervalDays: 'interval_days',
    ease: 'ease',
    consecutiveCorrect: 'consecutive_correct',
  };
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${map[k]} = ?`);
    vals.push(v);
  }
  if (cols.length > 0) {
    db.prepare(`UPDATE cells SET ${cols.join(', ')} WHERE id = ?`).run(...vals, cell.id);
  }
  return cell.id;
}

export function masterCell(db: Db, nodeId: number, depth: number, at = '2026-01-01T00:00:00.000Z') {
  return setCellState(db, nodeId, depth, {
    pMastery: 0.97,
    responseCount: 4,
    lastTestedAt: at,
    nextDueAt: '2026-06-01T00:00:00.000Z',
    intervalDays: 20,
  });
}
