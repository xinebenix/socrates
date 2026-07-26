/**
 * Classical item analysis, aggregated at the cell level.
 *
 * Limitation 1 in the spec: single-user statistics are thin. Classical item analysis
 * assumes many test-takers; with one user and a handful of administrations, these
 * estimates are noisy. So: aggregate at the cell rather than the item, require
 * n >= 5 before displaying anything, and label everything advisory. The UI must not
 * present these as measurements.
 */

import type { Db } from '../db';

export const MIN_N_FOR_STATISTIC = 5;
/** Options never chosen across this many administrations are dead weight. */
export const DEAD_DISTRACTOR_MIN_ADMINISTRATIONS = 5;
/** A node whose validator rejects more than this share is probably badly drawn. */
export const REJECTION_RATE_ALARM = 0.3;

export interface CellStats {
  cellId: number;
  nodeId: number;
  nodeTitle: string;
  depth: number;
  n: number;
  itemCount: number;
  /** Proportion correct. Advisory; null below the n threshold. */
  difficulty: number | null;
  /**
   * Correlation between correctness and the model's belief at the moment the item was
   * served. A cell that discriminates is one the user gets right when the model
   * already thought they knew it. Advisory; null below the n threshold.
   */
  discrimination: number | null;
  flaggedItems: number;
  belowThreshold: boolean;
}

export function cellStats(db: Db, conceptId: number): CellStats[] {
  const cells = db
    .prepare(
      `SELECT c.id AS cell_id, c.node_id, c.depth, n.title AS node_title, n.order_index
         FROM cells c JOIN nodes n ON n.id = c.node_id
        WHERE n.concept_id = ? AND c.applicable = 1
        ORDER BY n.order_index, c.depth`
    )
    .all(conceptId) as {
    cell_id: number;
    node_id: number;
    depth: number;
    node_title: string;
    order_index: number;
  }[];

  return cells.map((c) => {
    const rows = db
      .prepare(`SELECT is_correct, p_mastery_before FROM responses WHERE cell_id = ?`)
      .all(c.cell_id) as { is_correct: number | null; p_mastery_before: number }[];

    const itemCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND retired = 0`)
        .get(c.cell_id) as { n: number }
    ).n;

    const flaggedItems = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM items
            WHERE cell_id = ? AND validator_json IS NOT NULL AND validator_json LIKE '%"flags":["%'`
        )
        .get(c.cell_id) as { n: number }
    ).n;

    const n = rows.length;
    const enough = n >= MIN_N_FOR_STATISTIC;

    return {
      cellId: c.cell_id,
      nodeId: c.node_id,
      nodeTitle: c.node_title,
      depth: c.depth,
      n,
      itemCount,
      difficulty: enough ? rows.filter((r) => r.is_correct === 1).length / n : null,
      discrimination: enough
        ? pearson(rows.map((r) => (r.is_correct === 1 ? 1 : 0)), rows.map((r) => r.p_mastery_before))
        : null,
      flaggedItems,
      belowThreshold: !enough,
    };
  });
}

export interface DeadDistractor {
  optionId: number;
  itemId: number;
  cellId: number;
  nodeTitle: string;
  depth: number;
  text: string;
  administrations: number;
}

/** Options with selected_count = 0 across >= 5 administrations of their item. */
export function deadDistractors(db: Db, conceptId: number): DeadDistractor[] {
  return db
    .prepare(
      `SELECT o.id AS optionId, o.item_id AS itemId, i.cell_id AS cellId,
              n.title AS nodeTitle, c.depth AS depth, o.text AS text,
              i.served_count AS administrations
         FROM options o
         JOIN items i ON i.id = o.item_id
         JOIN cells c ON c.id = i.cell_id
         JOIN nodes n ON n.id = c.node_id
        WHERE n.concept_id = ?
          AND o.is_correct = 0
          AND o.selected_count = 0
          AND i.served_count >= ?
          AND i.retired = 0
        ORDER BY i.served_count DESC, o.id`
    )
    .all(conceptId, DEAD_DISTRACTOR_MIN_ADMINISTRATIONS) as DeadDistractor[];
}

export interface NodeHealth {
  nodeId: number;
  nodeTitle: string;
  generated: number;
  rejected: number;
  rejectionRate: number;
  alarm: boolean;
}

/**
 * Limitation 2: the blueprint is the weak link. A high validator rejection rate on a
 * node, or failure clustering across several nodes at once, usually means one node
 * was never drawn properly rather than three separate gaps.
 */
export function nodeHealth(db: Db, conceptId: number): NodeHealth[] {
  const rows = db
    .prepare(
      `SELECT n.id AS nodeId, n.title AS nodeTitle,
              COUNT(i.id) AS generated,
              SUM(CASE WHEN i.validated = 0 THEN 1 ELSE 0 END) AS rejected
         FROM nodes n
         JOIN cells c ON c.node_id = n.id
         LEFT JOIN items i ON i.cell_id = c.id
        WHERE n.concept_id = ?
        GROUP BY n.id
        ORDER BY n.order_index`
    )
    .all(conceptId) as { nodeId: number; nodeTitle: string; generated: number; rejected: number }[];

  return rows.map((r) => {
    const generated = r.generated ?? 0;
    const rejected = r.rejected ?? 0;
    const rate = generated > 0 ? rejected / generated : 0;
    return { ...r, generated, rejected, rejectionRate: rate, alarm: rate > REJECTION_RATE_ALARM };
  });
}

/**
 * The "review your decomposition" prompt. Fires on a single badly-drawn node, or on
 * failure clustering across three or more nodes at once.
 */
export function blueprintAlarm(db: Db, conceptId: number): string | null {
  const health = nodeHealth(db, conceptId);
  const alarming = health.filter((h) => h.alarm && h.generated >= 3);
  if (alarming.length > 0) {
    return (
      `The validator is rejecting more than 30% of items generated for ` +
      `${alarming.map((h) => `"${h.nodeTitle}"`).join(', ')}. That usually means the node is ` +
      `drawn badly, not that the material is hard. Worth reviewing the decomposition.`
    );
  }

  const failing = db
    .prepare(
      `WITH recent AS (
         SELECT r.is_correct, c.node_id
           FROM responses r JOIN cells c ON c.id = r.cell_id JOIN nodes n ON n.id = c.node_id
          WHERE n.concept_id = ?
          ORDER BY r.answered_at DESC, r.id DESC LIMIT 20
       )
       SELECT node_id, COUNT(*) AS misses FROM recent WHERE is_correct = 0 GROUP BY node_id`
    )
    .all(conceptId) as { node_id: number; misses: number }[];

  if (failing.filter((f) => f.misses >= 2).length >= 3) {
    return (
      'Failures are clustering across three or more nodes at once. The likeliest ' +
      'explanation is not three separate gaps but one node that was never drawn — ' +
      'worth reviewing the blueprint before drilling further.'
    );
  }

  return null;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  // No variance in either series — correlation is undefined, not zero.
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}
