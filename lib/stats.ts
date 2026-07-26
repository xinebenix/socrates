/**
 * Dashboard aggregates: the mastery grid, coverage, the misconception profile, a
 * retention series, and the 14-day due forecast.
 */

import type { Db } from './db';
import { addDays, daysBetween, now, parseIso } from './clock';
import { effectiveMastery, isDue, overdueness, retrievability } from './schedule/decay';
import { coverage, frontierDepth, cellMastered } from './policy/frontier';
import { loadCellSnapshots } from './policy/snapshot';
import { isMastered } from './mastery/bkt';
import {
  listBenchmarkRuns,
  listMisconceptionsForConcept,
  listNodes,
  listResponsesForConcept,
} from './db/queries';

export interface GridCell {
  cellId: number;
  depth: number;
  applicable: boolean;
  pMastery: number;
  effectiveMastery: number;
  retrievability: number;
  mastered: boolean;
  due: boolean;
  responseCount: number;
  lastTestedAt: string | null;
  nextDueAt: string | null;
  intervalDays: number;
}

export interface GridRow {
  nodeId: number;
  title: string;
  description: string;
  orderIndex: number;
  cells: GridCell[];
}

export interface MisconceptionProfileEntry {
  id: number;
  nodeId: number;
  nodeTitle: string;
  label: string;
  description: string;
  timesSelected: number;
  recentSelections: number;
  active: boolean;
}

export interface DueForecastDay {
  date: string;
  count: number;
}

export interface RetentionPoint {
  date: string;
  meanEffectiveMastery: number;
  responses: number;
}

export interface ConceptStats {
  conceptId: number;
  grid: GridRow[];
  coverage: number;
  frontier: number;
  dueCount: number;
  applicableCells: number;
  masteredCells: number;
  totalResponses: number;
  misconceptionProfile: MisconceptionProfileEntry[];
  dueForecast: DueForecastDay[];
  retention: RetentionPoint[];
  benchmarkHistory: { runAt: string; overall: number; byDepth: Record<string, number> }[];
  hasSource: boolean;
}

export function buildGrid(db: Db, conceptId: number): GridRow[] {
  const at = now();
  const nodes = listNodes(db, conceptId);
  const snapshots = loadCellSnapshots(db, conceptId);

  return nodes.map((n) => ({
    nodeId: n.id,
    title: n.title,
    description: n.description,
    orderIndex: n.order_index,
    cells: [1, 2, 3, 4, 5, 6].map((depth) => {
      const s = snapshots.find((c) => c.nodeId === n.id && c.depth === depth);
      if (!s) {
        return {
          cellId: -1,
          depth,
          applicable: false,
          pMastery: 0,
          effectiveMastery: 0,
          retrievability: 1,
          mastered: false,
          due: false,
          responseCount: 0,
          lastTestedAt: null,
          nextDueAt: null,
          intervalDays: 0,
        };
      }
      return {
        cellId: s.cellId,
        depth,
        applicable: s.applicable,
        pMastery: s.pMastery,
        effectiveMastery: effectiveMastery(s.pMastery, s.lastTestedAt, s.intervalDays, at),
        retrievability: retrievability(s.lastTestedAt, s.intervalDays, at),
        mastered: isMastered(s.pMastery, s.responseCount),
        due: isDue(s.nextDueAt, at),
        responseCount: s.responseCount,
        lastTestedAt: s.lastTestedAt,
        nextDueAt: s.nextDueAt,
        intervalDays: s.intervalDays,
      };
    }),
  }));
}

export function conceptStats(db: Db, conceptId: number): ConceptStats {
  const at = now();
  const snapshots = loadCellSnapshots(db, conceptId);
  const applicable = snapshots.filter((c) => c.applicable);
  const responses = listResponsesForConcept(db, conceptId);

  const source = db.prepare(`SELECT source_text FROM concepts WHERE id = ?`).get(conceptId) as
    | { source_text: string | null }
    | undefined;

  return {
    conceptId,
    grid: buildGrid(db, conceptId),
    coverage: coverage(snapshots),
    frontier: frontierDepth(snapshots),
    dueCount: applicable.filter((c) => isDue(c.nextDueAt, at)).length,
    applicableCells: applicable.length,
    masteredCells: applicable.filter(cellMastered).length,
    totalResponses: responses.length,
    misconceptionProfile: misconceptionProfile(db, conceptId),
    dueForecast: dueForecast(db, conceptId, 14),
    retention: retentionSeries(db, conceptId),
    benchmarkHistory: benchmarkHistory(db, conceptId),
    hasSource: Boolean(source?.source_text && source.source_text.trim().length > 0),
  };
}

export function misconceptionProfile(db: Db, conceptId: number): MisconceptionProfileEntry[] {
  const all = listMisconceptionsForConcept(db, conceptId);

  const recent = db
    .prepare(
      `WITH recent AS (
         SELECT r.chosen_option_id
           FROM responses r JOIN cells c ON c.id = r.cell_id JOIN nodes n ON n.id = c.node_id
          WHERE n.concept_id = ?
          ORDER BY r.answered_at DESC, r.id DESC LIMIT 20
       )
       SELECT o.misconception_id AS id, COUNT(*) AS hits
         FROM recent JOIN options o ON o.id = recent.chosen_option_id
        WHERE o.is_correct = 0 AND o.misconception_id IS NOT NULL
        GROUP BY o.misconception_id`
    )
    .all(conceptId) as { id: number; hits: number }[];

  const recentMap = new Map(recent.map((r) => [r.id, r.hits]));
  const nodeTitles = new Map(listNodes(db, conceptId).map((n) => [n.id, n.title]));

  return all
    .map((m) => {
      const hits = recentMap.get(m.id) ?? 0;
      return {
        id: m.id,
        nodeId: m.node_id,
        nodeTitle: nodeTitles.get(m.node_id) ?? '(unknown node)',
        label: m.label,
        description: m.description,
        timesSelected: m.times_selected,
        recentSelections: hits,
        active: hits >= 2,
      };
    })
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        b.recentSelections - a.recentSelections ||
        b.timesSelected - a.timesSelected
    );
}

export function dueForecast(db: Db, conceptId: number, days: number): DueForecastDay[] {
  const at = now();
  const snapshots = loadCellSnapshots(db, conceptId).filter((c) => c.applicable);

  const buckets: DueForecastDay[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(at, i);
    buckets.push({ date: day.toISOString().slice(0, 10), count: 0 });
  }

  for (const c of snapshots) {
    const due = parseIso(c.nextDueAt);
    if (!due) continue;
    // Everything already overdue lands on today.
    const offset = Math.max(0, Math.floor(daysBetween(at, due)));
    if (offset < days) buckets[offset].count++;
  }

  return buckets;
}

/**
 * Mean effective mastery over time. Reconstructed from the response log: each day
 * that saw activity gets a point, using the model's belief after each response and
 * the decay applied since.
 */
export function retentionSeries(db: Db, conceptId: number): RetentionPoint[] {
  const responses = listResponsesForConcept(db, conceptId);
  if (responses.length === 0) return [];

  const byDay = new Map<string, { sum: number; n: number }>();
  for (const r of responses) {
    const day = r.answered_at.slice(0, 10);
    const b = byDay.get(day) ?? { sum: 0, n: 0 };
    b.sum += r.p_mastery_after;
    b.n += 1;
    byDay.set(day, b);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => ({
      date,
      meanEffectiveMastery: b.sum / b.n,
      responses: b.n,
    }));
}

export function benchmarkHistory(db: Db, conceptId: number) {
  return listBenchmarkRuns(db, conceptId).map((run) => {
    let overall = 0;
    const byDepth: Record<string, number> = {};
    try {
      const parsed = JSON.parse(run.results_json) as {
        overall?: number;
        byDepth?: Record<string, { n: number; correct: number }>;
      };
      overall = parsed.overall ?? 0;
      for (const [d, v] of Object.entries(parsed.byDepth ?? {})) {
        byDepth[d] = v.n > 0 ? v.correct / v.n : 0;
      }
    } catch {
      /* a malformed historical run should not take the dashboard down */
    }
    return { runAt: run.run_at, overall, byDepth };
  });
}

/** Cells sorted by urgency — used by the worker to decide what to pre-generate. */
export function plausiblyDueCells(db: Db, conceptId: number, limit: number) {
  const at = now();
  const snapshots = loadCellSnapshots(db, conceptId).filter((c) => c.applicable && c.depth <= 5);
  const frontier = frontierDepth(snapshots);

  return snapshots
    .filter((c) => isDue(c.nextDueAt, at) || (!cellMastered(c) && c.depth <= frontier))
    .sort(
      (a, b) =>
        overdueness(b.nextDueAt, b.intervalDays, at) - overdueness(a.nextDueAt, a.intervalDays, at) ||
        a.depth - b.depth
    )
    .slice(0, limit);
}
