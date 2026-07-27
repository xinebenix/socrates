/**
 * Benchmark runs.
 *
 * Invariant 10: benchmark items never enter practice. If every item is freshly
 * generated, improvement and item drift are indistinguishable — a frozen held-out
 * set is the only real measurement. Practice on generated items; measure on frozen
 * ones.
 *
 * Benchmark sessions show no feedback until the whole run is complete.
 */

import type { Db } from '../db';
import { iso, now } from '../clock';
import { interleave } from '../policy/interleave';
import {
  createSession,
  endSession,
  getCell,
  getSession,
  insertBenchmarkRun,
  listFrozenItems,
  listResponsesForSession,
  listSessionPlan,
} from '../db/queries';

export interface BenchmarkPlan {
  sessionId: number;
  itemCount: number;
  warning: string | null;
}

export function startBenchmarkRun(db: Db, userId: number, conceptId: number): BenchmarkPlan {
  const frozen = listFrozenItems(db, conceptId);
  if (frozen.length === 0) {
    throw new Error(
      'no frozen items yet — promote validated items to the benchmark set from the item-health screen first'
    );
  }

  const { ordered, warning } = interleave(
    frozen.map((i) => ({ nodeId: i.node_id, itemId: i.id, cellId: i.cell_id }))
  );

  const session = createSession(db, userId, conceptId, 'benchmark');

  const stmt = db.prepare(
    `INSERT INTO session_plan (session_id, position, cell_id, item_id, slot_kind)
     VALUES (?, ?, ?, ?, 'benchmark')`
  );
  const tx = db.transaction(() => {
    ordered.forEach((o, i) => stmt.run(session.id, i, o.cellId, o.itemId));
  });
  tx();

  return { sessionId: session.id, itemCount: ordered.length, warning };
}

export interface BenchmarkResults {
  overall: number;
  n: number;
  correct: number;
  byDepth: Record<string, { n: number; correct: number; score: number }>;
  byNode: Record<
    string,
    { nodeId: number; title: string; n: number; correct: number; score: number }
  >;
  runAt: string;
}

/**
 * Close the run and write the per-node, per-depth result. Called once every planned
 * item has an answer — this is the point at which feedback becomes visible.
 */
export function finalizeBenchmarkRun(db: Db, sessionId: number, conceptId: number) {
  const responses = listResponsesForSession(db, sessionId);

  const byDepth: BenchmarkResults['byDepth'] = {};
  const byNode: BenchmarkResults['byNode'] = {};
  let correct = 0;

  for (const r of responses) {
    const cell = getCell(db, r.cell_id);
    if (!cell) continue;
    const node = db.prepare(`SELECT id, title FROM nodes WHERE id = ?`).get(cell.node_id) as
      | { id: number; title: string }
      | undefined;

    const isCorrect = r.is_correct === 1;
    if (isCorrect) correct++;

    const dKey = `D${cell.depth}`;
    const d = byDepth[dKey] ?? { n: 0, correct: 0, score: 0 };
    d.n += 1;
    if (isCorrect) d.correct += 1;
    d.score = d.n > 0 ? d.correct / d.n : 0;
    byDepth[dKey] = d;

    if (node) {
      const nKey = String(node.id);
      const entry = byNode[nKey] ?? { nodeId: node.id, title: node.title, n: 0, correct: 0, score: 0 };
      entry.n += 1;
      if (isCorrect) entry.correct += 1;
      entry.score = entry.n > 0 ? entry.correct / entry.n : 0;
      byNode[nKey] = entry;
    }
  }

  const results: BenchmarkResults = {
    overall: responses.length > 0 ? correct / responses.length : 0,
    n: responses.length,
    correct,
    byDepth,
    byNode,
    runAt: iso(now()),
  };

  endSession(db, sessionId);
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const run = insertBenchmarkRun(db, session.user_id, conceptId, results);
  return { run, results };
}

export function isBenchmarkComplete(db: Db, sessionId: number): boolean {
  const plan = listSessionPlan(db, sessionId);
  const answered = listResponsesForSession(db, sessionId).length;
  return plan.length > 0 && answered >= plan.length;
}

/**
 * Per-node coverage of the frozen set — how much of the map the benchmark actually
 * measures. A benchmark that only covers three nodes is not measuring the concept.
 */
export function benchmarkCoverage(db: Db, conceptId: number) {
  const frozen = listFrozenItems(db, conceptId);
  const nodes = db
    .prepare(`SELECT id, title FROM nodes WHERE concept_id = ? ORDER BY order_index`)
    .all(conceptId) as { id: number; title: string }[];

  return nodes.map((n) => {
    const items = frozen.filter((f) => f.node_id === n.id);
    const depths = [...new Set(items.map((i) => i.depth))].sort((a, b) => a - b);
    return { nodeId: n.id, title: n.title, itemCount: items.length, depths };
  });
}
