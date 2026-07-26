import type { Db } from './index';
import type {
  BenchmarkRunRow,
  CellRow,
  CellWithNode,
  ConceptRow,
  ItemRow,
  MisconceptionRow,
  NodeOrigin,
  NodeRow,
  OptionRow,
  ResponseRow,
  SessionKind,
  SessionPlanRow,
  SessionRow,
  SlotKind,
} from './types';
import { iso, now } from '../clock';
import { BKT } from '../mastery/bkt';
import { SCHEDULE } from '../schedule/sm2';

/* ------------------------------------------------------------------ concepts */

export function createConcept(
  db: Db,
  input: { name: string; sourceText?: string | null; sourceNote?: string | null }
): ConceptRow {
  const stmt = db.prepare(
    `INSERT INTO concepts (name, source_text, source_note, created_at) VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(
    input.name,
    input.sourceText ?? null,
    input.sourceNote ?? null,
    iso(now())
  );
  return getConcept(db, Number(info.lastInsertRowid))!;
}

export function getConcept(db: Db, id: number): ConceptRow | undefined {
  return db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(id) as ConceptRow | undefined;
}

export function listConcepts(db: Db): ConceptRow[] {
  return db.prepare(`SELECT * FROM concepts ORDER BY created_at DESC`).all() as ConceptRow[];
}

export function deleteConcept(db: Db, id: number): void {
  db.prepare(`DELETE FROM concepts WHERE id = ?`).run(id);
}

/* --------------------------------------------------------------------- nodes */

export function listNodes(db: Db, conceptId: number): NodeRow[] {
  return db
    .prepare(`SELECT * FROM nodes WHERE concept_id = ? ORDER BY order_index, id`)
    .all(conceptId) as NodeRow[];
}

export function getNode(db: Db, id: number): NodeRow | undefined {
  return db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined;
}

export function findNodeByTitle(db: Db, conceptId: number, title: string): NodeRow | undefined {
  return db
    .prepare(`SELECT * FROM nodes WHERE concept_id = ? AND lower(trim(title)) = lower(trim(?))`)
    .get(conceptId, title) as NodeRow | undefined;
}

export function createNode(
  db: Db,
  input: {
    conceptId: number;
    title: string;
    description: string;
    orderIndex: number;
    origin: NodeOrigin;
    applicableDepths?: number[];
  }
): NodeRow {
  const info = db
    .prepare(
      `INSERT INTO nodes (concept_id, title, description, order_index, created_at, origin)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.conceptId, input.title, input.description, input.orderIndex, iso(now()), input.origin);
  const nodeId = Number(info.lastInsertRowid);
  ensureCells(db, nodeId, input.applicableDepths ?? [1, 2, 3, 4, 5, 6]);
  return getNode(db, nodeId)!;
}

/**
 * Invariant 11: editing a node preserves its cells, mastery, and response history.
 * This only ever touches the two text columns.
 */
export function updateNode(
  db: Db,
  nodeId: number,
  patch: { title?: string; description?: string; orderIndex?: number }
): NodeRow | undefined {
  const existing = getNode(db, nodeId);
  if (!existing) return undefined;
  db.prepare(`UPDATE nodes SET title = ?, description = ?, order_index = ? WHERE id = ?`).run(
    patch.title ?? existing.title,
    patch.description ?? existing.description,
    patch.orderIndex ?? existing.order_index,
    nodeId
  );
  return getNode(db, nodeId);
}

export function deleteNode(db: Db, nodeId: number): void {
  db.prepare(`DELETE FROM nodes WHERE id = ?`).run(nodeId);
}

/* --------------------------------------------------------------------- cells */

/** Create any missing (node, depth) cells and set the applicable flag. */
export function ensureCells(db: Db, nodeId: number, applicableDepths: number[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO cells (node_id, depth, applicable, p_mastery, ease)
     VALUES (?, ?, ?, ?, ?)`
  );
  const setApplicable = db.prepare(`UPDATE cells SET applicable = ? WHERE node_id = ? AND depth = ?`);
  const tx = db.transaction(() => {
    for (let d = 1; d <= 6; d++) {
      const applicable = applicableDepths.includes(d) ? 1 : 0;
      insert.run(nodeId, d, applicable, BKT.P_L0, SCHEDULE.EASE_DEFAULT);
      setApplicable.run(applicable, nodeId, d);
    }
  });
  tx();
}

export function getCell(db: Db, id: number): CellRow | undefined {
  return db.prepare(`SELECT * FROM cells WHERE id = ?`).get(id) as CellRow | undefined;
}

export function getCellByNodeDepth(db: Db, nodeId: number, depth: number): CellRow | undefined {
  return db.prepare(`SELECT * FROM cells WHERE node_id = ? AND depth = ?`).get(nodeId, depth) as
    | CellRow
    | undefined;
}

export function listCells(db: Db, conceptId: number): CellWithNode[] {
  return db
    .prepare(
      `SELECT c.*, n.title AS node_title, n.order_index AS node_order, n.concept_id AS concept_id
         FROM cells c JOIN nodes n ON n.id = c.node_id
        WHERE n.concept_id = ?
        ORDER BY n.order_index, n.id, c.depth`
    )
    .all(conceptId) as CellWithNode[];
}

export function setCellApplicable(db: Db, cellId: number, applicable: boolean): void {
  db.prepare(`UPDATE cells SET applicable = ? WHERE id = ?`).run(applicable ? 1 : 0, cellId);
}

export function updateCellAfterResponse(
  db: Db,
  cellId: number,
  patch: {
    pMastery: number;
    intervalDays: number;
    ease: number;
    consecutiveCorrect: number;
    lastTestedAt: string;
    nextDueAt: string;
  }
): void {
  db.prepare(
    `UPDATE cells
        SET p_mastery = ?, response_count = response_count + 1, consecutive_correct = ?,
            last_tested_at = ?, next_due_at = ?, interval_days = ?, ease = ?
      WHERE id = ?`
  ).run(
    patch.pMastery,
    patch.consecutiveCorrect,
    patch.lastTestedAt,
    patch.nextDueAt,
    patch.intervalDays,
    patch.ease,
    cellId
  );
}

/**
 * Trailing incorrect responses for a cell. Section 7.4's fallback rule needs this and
 * the cells table only stores consecutive *correct*, so it is derived from the log.
 */
export function consecutiveWrong(db: Db, cellId: number): number {
  const rows = db
    .prepare(
      `SELECT is_correct FROM responses WHERE cell_id = ? ORDER BY answered_at DESC, id DESC LIMIT 10`
    )
    .all(cellId) as { is_correct: number | null }[];
  let n = 0;
  for (const r of rows) {
    if (r.is_correct === 0) n++;
    else break;
  }
  return n;
}

/* ----------------------------------------------------------- misconceptions */

export function listMisconceptions(db: Db, nodeId: number): MisconceptionRow[] {
  return db
    .prepare(`SELECT * FROM misconceptions WHERE node_id = ? ORDER BY times_selected DESC, id`)
    .all(nodeId) as MisconceptionRow[];
}

export function listMisconceptionsForConcept(db: Db, conceptId: number): MisconceptionRow[] {
  return db
    .prepare(
      `SELECT m.* FROM misconceptions m JOIN nodes n ON n.id = m.node_id
        WHERE n.concept_id = ? ORDER BY m.times_selected DESC, m.id`
    )
    .all(conceptId) as MisconceptionRow[];
}

export function findMisconceptionByLabel(
  db: Db,
  nodeId: number,
  label: string
): MisconceptionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM misconceptions WHERE node_id = ? AND lower(trim(label)) = lower(trim(?))`
    )
    .get(nodeId, label) as MisconceptionRow | undefined;
}

export function createMisconception(
  db: Db,
  input: {
    nodeId: number;
    label: string;
    description: string;
    origin: MisconceptionRow['origin'];
  }
): MisconceptionRow {
  const info = db
    .prepare(
      `INSERT INTO misconceptions (node_id, label, description, origin, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.nodeId, input.label, input.description, input.origin, iso(now()));
  return db.prepare(`SELECT * FROM misconceptions WHERE id = ?`).get(Number(info.lastInsertRowid)) as
    | MisconceptionRow;
}

/**
 * Invariant 4: a distractor's misconception_id is never null, so a label the
 * generator invented must exist as a row before the item is persisted.
 */
export function upsertMisconception(
  db: Db,
  input: {
    nodeId: number;
    label: string;
    description: string;
    origin: MisconceptionRow['origin'];
  }
): MisconceptionRow {
  return findMisconceptionByLabel(db, input.nodeId, input.label) ?? createMisconception(db, input);
}

export function updateMisconception(
  db: Db,
  id: number,
  patch: { label?: string; description?: string }
): void {
  const existing = db.prepare(`SELECT * FROM misconceptions WHERE id = ?`).get(id) as
    | MisconceptionRow
    | undefined;
  if (!existing) return;
  db.prepare(`UPDATE misconceptions SET label = ?, description = ? WHERE id = ?`).run(
    patch.label ?? existing.label,
    patch.description ?? existing.description,
    id
  );
}

export function deleteMisconception(db: Db, id: number): void {
  db.prepare(`UPDATE options SET misconception_id = NULL WHERE misconception_id = ?`).run(id);
  db.prepare(`DELETE FROM misconceptions WHERE id = ?`).run(id);
}

export function incrementMisconceptionSelected(db: Db, id: number): void {
  db.prepare(`UPDATE misconceptions SET times_selected = times_selected + 1 WHERE id = ?`).run(id);
}

/**
 * A misconception selected >= 2 times within the last 20 responses on that concept is
 * active and triggers targeted remediation.
 */
export function activeMisconceptions(db: Db, conceptId: number): MisconceptionRow[] {
  return db
    .prepare(
      `WITH recent AS (
         SELECT r.chosen_option_id
           FROM responses r
           JOIN cells c ON c.id = r.cell_id
           JOIN nodes n ON n.id = c.node_id
          WHERE n.concept_id = ?
          ORDER BY r.answered_at DESC, r.id DESC
          LIMIT 20
       )
       SELECT m.*, COUNT(*) AS hits
         FROM recent
         JOIN options o ON o.id = recent.chosen_option_id
         JOIN misconceptions m ON m.id = o.misconception_id
        WHERE o.is_correct = 0
        GROUP BY m.id
       HAVING COUNT(*) >= 2
        ORDER BY hits DESC, m.id`
    )
    .all(conceptId) as MisconceptionRow[];
}

/* --------------------------------------------------------------------- items */

export function getItem(db: Db, id: number): ItemRow | undefined {
  return db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
}

export function listOptions(db: Db, itemId: number): OptionRow[] {
  return db
    .prepare(`SELECT * FROM options WHERE item_id = ? ORDER BY position`)
    .all(itemId) as OptionRow[];
}

export function listItemsForCell(db: Db, cellId: number): ItemRow[] {
  return db
    .prepare(`SELECT * FROM items WHERE cell_id = ? ORDER BY generated_at DESC, id DESC`)
    .all(cellId) as ItemRow[];
}

/**
 * Invariant 6: items are never reused verbatim, so the generator is shown the recent
 * stems for the cell and asked to vary the surface form.
 */
export function recentStems(db: Db, cellId: number, limit: number): string[] {
  return (
    db
      .prepare(`SELECT stem FROM items WHERE cell_id = ? ORDER BY generated_at DESC, id DESC LIMIT ?`)
      .all(cellId, limit) as { stem: string }[]
  ).map((r) => r.stem);
}

/**
 * Invariant 10: benchmark items never enter practice. The `frozen = 0` predicate is
 * in the query itself, not applied by a caller who might forget.
 */
export function takeBufferedItem(db: Db, cellId: number, kind: 'mc' | 'free'): ItemRow | undefined {
  return db
    .prepare(
      `SELECT * FROM items
        WHERE cell_id = ? AND kind = ? AND validated = 1 AND frozen = 0 AND retired = 0
          AND served_count = 0
        ORDER BY generated_at ASC, id ASC
        LIMIT 1`
    )
    .get(cellId, kind) as ItemRow | undefined;
}

export function countBufferedItems(db: Db, cellId: number, kind: 'mc' | 'free'): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
        WHERE cell_id = ? AND kind = ? AND validated = 1 AND frozen = 0 AND retired = 0
          AND served_count = 0`
    )
    .get(cellId, kind) as { n: number };
  return row.n;
}

export function markItemServed(db: Db, itemId: number): void {
  db.prepare(`UPDATE items SET served_count = served_count + 1 WHERE id = ?`).run(itemId);
}

export function setItemFrozen(db: Db, itemId: number, frozen: boolean): void {
  db.prepare(`UPDATE items SET frozen = ? WHERE id = ?`).run(frozen ? 1 : 0, itemId);
}

export function setItemRetired(db: Db, itemId: number, retired: boolean): void {
  db.prepare(`UPDATE items SET retired = ? WHERE id = ?`).run(retired ? 1 : 0, itemId);
}

export function listFrozenItems(db: Db, conceptId: number): (ItemRow & { node_id: number; depth: number; node_title: string })[] {
  return db
    .prepare(
      `SELECT i.*, c.node_id AS node_id, c.depth AS depth, n.title AS node_title
         FROM items i
         JOIN cells c ON c.id = i.cell_id
         JOIN nodes n ON n.id = c.node_id
        WHERE n.concept_id = ? AND i.frozen = 1 AND i.retired = 0
        ORDER BY n.order_index, c.depth, i.id`
    )
    .all(conceptId) as (ItemRow & { node_id: number; depth: number; node_title: string })[];
}

/* ------------------------------------------------------------------ sessions */

export function createSession(db: Db, conceptId: number, kind: SessionKind): SessionRow {
  const info = db
    .prepare(`INSERT INTO sessions (concept_id, started_at, kind) VALUES (?, ?, ?)`)
    .run(conceptId, iso(now()), kind);
  return getSession(db, Number(info.lastInsertRowid))!;
}

export function getSession(db: Db, id: number): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function endSession(db: Db, id: number): void {
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(iso(now()), id);
}

export function writeSessionPlan(
  db: Db,
  sessionId: number,
  slots: { cellId: number; slotKind: SlotKind }[]
): void {
  const stmt = db.prepare(
    `INSERT INTO session_plan (session_id, position, cell_id, slot_kind) VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    slots.forEach((s, i) => stmt.run(sessionId, i, s.cellId, s.slotKind));
  });
  tx();
}

export function listSessionPlan(db: Db, sessionId: number): SessionPlanRow[] {
  return db
    .prepare(`SELECT * FROM session_plan WHERE session_id = ? ORDER BY position`)
    .all(sessionId) as SessionPlanRow[];
}

export function nextUnservedSlot(db: Db, sessionId: number): SessionPlanRow | undefined {
  return db
    .prepare(
      `SELECT * FROM session_plan WHERE session_id = ? AND served_at IS NULL ORDER BY position LIMIT 1`
    )
    .get(sessionId) as SessionPlanRow | undefined;
}

export function attachItemToSlot(
  db: Db,
  sessionId: number,
  position: number,
  itemId: number
): void {
  db.prepare(
    `UPDATE session_plan SET item_id = ?, served_at = ? WHERE session_id = ? AND position = ?`
  ).run(itemId, iso(now()), sessionId, position);
}

export function dropSlot(db: Db, sessionId: number, position: number): void {
  db.prepare(`DELETE FROM session_plan WHERE session_id = ? AND position = ?`).run(
    sessionId,
    position
  );
}

/* ----------------------------------------------------------------- responses */

export function insertResponse(
  db: Db,
  row: Omit<ResponseRow, 'id' | 'answered_at'> & { answered_at?: string }
): ResponseRow {
  const info = db
    .prepare(
      `INSERT INTO responses
         (session_id, item_id, cell_id, chosen_option_id, free_text, is_correct, score,
          grader_json, confidence, latency_ms, p_mastery_before, p_mastery_after, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.session_id,
      row.item_id,
      row.cell_id,
      row.chosen_option_id,
      row.free_text,
      row.is_correct,
      row.score,
      row.grader_json,
      row.confidence,
      row.latency_ms,
      row.p_mastery_before,
      row.p_mastery_after,
      row.answered_at ?? iso(now())
    );
  return db.prepare(`SELECT * FROM responses WHERE id = ?`).get(Number(info.lastInsertRowid)) as
    | ResponseRow;
}

export function listResponsesForSession(db: Db, sessionId: number): ResponseRow[] {
  return db
    .prepare(`SELECT * FROM responses WHERE session_id = ? ORDER BY answered_at, id`)
    .all(sessionId) as ResponseRow[];
}

export function listResponsesForConcept(db: Db, conceptId: number): ResponseRow[] {
  return db
    .prepare(
      `SELECT r.* FROM responses r
         JOIN cells c ON c.id = r.cell_id
         JOIN nodes n ON n.id = c.node_id
        WHERE n.concept_id = ? ORDER BY r.answered_at, r.id`
    )
    .all(conceptId) as ResponseRow[];
}

export function incrementOptionSelected(db: Db, optionId: number): void {
  db.prepare(`UPDATE options SET selected_count = selected_count + 1 WHERE id = ?`).run(optionId);
}

/* ---------------------------------------------------------------- benchmarks */

export function insertBenchmarkRun(
  db: Db,
  conceptId: number,
  results: unknown
): BenchmarkRunRow {
  const info = db
    .prepare(`INSERT INTO benchmark_runs (concept_id, run_at, results_json) VALUES (?, ?, ?)`)
    .run(conceptId, iso(now()), JSON.stringify(results));
  return db.prepare(`SELECT * FROM benchmark_runs WHERE id = ?`).get(Number(info.lastInsertRowid)) as
    | BenchmarkRunRow;
}

export function listBenchmarkRuns(db: Db, conceptId: number): BenchmarkRunRow[] {
  return db
    .prepare(`SELECT * FROM benchmark_runs WHERE concept_id = ? ORDER BY run_at`)
    .all(conceptId) as BenchmarkRunRow[];
}
