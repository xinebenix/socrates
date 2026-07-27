import type { Db } from '../lib/db';
import { newTestDb, setDb } from '../lib/db';
import {
  createConcept,
  createNode,
  createUser,
  DEFAULT_CELL_STATE,
  markItemServed,
} from '../lib/db/queries';
import { setClock, TestClock } from '../lib/clock';

export interface Fixture {
  db: Db;
  clock: TestClock;
  /** The learner every helper writes for. Multi-user tests make their own with `addUser`. */
  userId: number;
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

  const userId = addUser(db, 'learner@example.test');

  const { concept } = createConcept(db, {
    userId,
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

  return { db, clock, userId, conceptId: concept.id, nodeIds };
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

/**
 * An account. Tests that care about sharing need at least two.
 *
 * The hash is a literal rather than a real scrypt call: hashing is ~16 MB and tens of
 * milliseconds by design, and a suite that mints accounts in every fixture would pay for
 * that hundreds of times over to verify a password it never checks.
 */
export function addUser(db: Db, email: string): number {
  return createUser(db, { email, passwordHash: 'scrypt$test$not-a-real-hash' }).id;
}

/**
 * Serve the next unseen item of a cell to a learner, without running a session.
 *
 * Both halves matter: `served_count` is the cross-user administration count that item
 * analysis reads, and `user_item_seen` is what stops the item coming back to this
 * person. Tests that only bumped `served_count` were simulating the old, single-user
 * meaning of "served" — one where an item shown to anybody was spent for everybody.
 */
export function serveItems(db: Db, userId: number, cellId: number, count = 1): number[] {
  const ids = (
    db
      .prepare(
        `SELECT i.id FROM items i
          WHERE i.cell_id = ? AND i.validated = 1 AND i.frozen = 0 AND i.retired = 0
            AND NOT EXISTS (
              SELECT 1 FROM user_item_seen s WHERE s.user_id = ? AND s.item_id = i.id
            )
          ORDER BY i.generated_at, i.id
          LIMIT ?`
      )
      .all(cellId, userId, count) as { id: number }[]
  ).map((r) => r.id);
  for (const id of ids) markItemServed(db, userId, id);
  return ids;
}

/**
 * Force a cell to a given mastery state without going through the response path.
 *
 * Writes `user_cell_state`, which is where the student model lives now — and upserts,
 * because a learner who has not answered anything on the cell has no row to update.
 */
export function setCellState(
  db: Db,
  userId: number,
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

  const state = {
    p_mastery: patch.pMastery ?? DEFAULT_CELL_STATE.p_mastery,
    response_count: patch.responseCount ?? DEFAULT_CELL_STATE.response_count,
    consecutive_correct: patch.consecutiveCorrect ?? DEFAULT_CELL_STATE.consecutive_correct,
    last_tested_at: patch.lastTestedAt ?? DEFAULT_CELL_STATE.last_tested_at,
    next_due_at: patch.nextDueAt ?? DEFAULT_CELL_STATE.next_due_at,
    interval_days: patch.intervalDays ?? DEFAULT_CELL_STATE.interval_days,
    ease: patch.ease ?? DEFAULT_CELL_STATE.ease,
  };

  db.prepare(
    `INSERT INTO user_cell_state
       (user_id, cell_id, p_mastery, response_count, consecutive_correct,
        last_tested_at, next_due_at, interval_days, ease)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, cell_id) DO UPDATE SET
       p_mastery = excluded.p_mastery,
       response_count = excluded.response_count,
       consecutive_correct = excluded.consecutive_correct,
       last_tested_at = excluded.last_tested_at,
       next_due_at = excluded.next_due_at,
       interval_days = excluded.interval_days,
       ease = excluded.ease`
  ).run(
    userId,
    cell.id,
    state.p_mastery,
    state.response_count,
    state.consecutive_correct,
    state.last_tested_at,
    state.next_due_at,
    state.interval_days,
    state.ease
  );
  return cell.id;
}

export function masterCell(
  db: Db,
  userId: number,
  nodeId: number,
  depth: number,
  at = '2026-01-01T00:00:00.000Z'
) {
  return setCellState(db, userId, nodeId, depth, {
    pMastery: 0.97,
    responseCount: 4,
    lastTestedAt: at,
    nextDueAt: '2026-06-01T00:00:00.000Z',
    intervalDays: 20,
  });
}
