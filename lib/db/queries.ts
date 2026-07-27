import type { Db } from './index';
import type {
  BenchmarkRunRow,
  CellRow,
  CellState,
  CellWithNode,
  ConceptRow,
  ItemRow,
  MisconceptionRow,
  MisconceptionWithState,
  NodeOrigin,
  NodeRow,
  OptionRow,
  ResponseRow,
  SessionKind,
  SessionPlanRow,
  SessionRow,
  UserRow,
} from './types';
import { iso, now } from '../clock';
import { BKT } from '../mastery/bkt';
import { SCHEDULE } from '../schedule/sm2';
import { conceptNameKey } from './names';
import type { SlotKind } from './types';

/**
 * The state a learner who has never answered anything on a cell reads.
 *
 * `user_cell_state` rows are written on the first response, not on joining a concept,
 * so most cells most of the time are this object. It must agree with the column
 * defaults in `schema.ts`; `test/units.test.ts` asserts that it does.
 */
export const DEFAULT_CELL_STATE: CellState = {
  p_mastery: BKT.P_L0,
  response_count: 0,
  consecutive_correct: 0,
  last_tested_at: null,
  next_due_at: null,
  interval_days: 0,
  ease: SCHEDULE.EASE_DEFAULT,
};

/* --------------------------------------------------------------------- users */

export function createUser(
  db: Db,
  input: { email: string; passwordHash: string; displayName?: string | null }
): UserRow {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(input.email, input.passwordHash, input.displayName ?? null, iso(now()));
  return getUser(db, Number(info.lastInsertRowid))!;
}

export function getUser(db: Db, id: number): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function getUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined;
}

export function countUsers(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
}

export function touchUser(db: Db, id: number): void {
  db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(iso(now()), id);
}

/* ------------------------------------------------------------------ concepts */

export interface CreatedConcept {
  concept: ConceptRow;
  /** True when this joined an existing shared bank instead of creating one. */
  joined: boolean;
}

/**
 * Create a concept, or join the shared one that already answers to this name.
 *
 * The branch is the whole sharing rule: supplying source material makes a concept
 * yours — an independent blueprint and an independent item bank, invisible to anyone
 * else — while asking for a bare topic gets you the shared one if it exists, blueprint
 * and item bank included, with your own progress starting at zero.
 *
 * Joining is the cheap path by an enormous margin. A blueprint is one large Opus call
 * and a stocked concept is dozens more; joining is one row.
 */
export function createConcept(
  db: Db,
  input: {
    userId: number;
    name: string;
    sourceText?: string | null;
    sourceNote?: string | null;
  }
): CreatedConcept {
  const name = input.name.trim();
  const key = conceptNameKey(name);
  const sourced = Boolean(input.sourceText && input.sourceText.trim());

  if (!sourced) {
    const existing = findSharedConcept(db, key);
    if (existing) {
      joinConcept(db, input.userId, existing.id);
      return { concept: existing, joined: true };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO concepts (name, name_key, owner_id, visibility, source_text, source_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      key,
      input.userId,
      sourced ? 'private' : 'shared',
      input.sourceText ?? null,
      input.sourceNote ?? null,
      iso(now())
    );
  const concept = getConcept(db, Number(info.lastInsertRowid))!;
  joinConcept(db, input.userId, concept.id);
  return { concept, joined: false };
}

export function findSharedConcept(db: Db, nameKey: string): ConceptRow | undefined {
  return db
    .prepare(`SELECT * FROM concepts WHERE visibility = 'shared' AND name_key = ?`)
    .get(nameKey) as ConceptRow | undefined;
}

export function getConcept(db: Db, id: number): ConceptRow | undefined {
  return db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(id) as ConceptRow | undefined;
}

export function joinConcept(db: Db, userId: number, conceptId: number): void {
  const at = iso(now());
  db.prepare(
    `INSERT INTO user_concepts (user_id, concept_id, joined_at, last_active_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, concept_id) DO UPDATE SET last_active_at = excluded.last_active_at`
  ).run(userId, conceptId, at, at);
}

export function leaveConcept(db: Db, userId: number, conceptId: number): void {
  db.prepare(`DELETE FROM user_concepts WHERE user_id = ? AND concept_id = ?`).run(
    userId,
    conceptId
  );
}

export function hasJoined(db: Db, userId: number, conceptId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM user_concepts WHERE user_id = ? AND concept_id = ?`).get(userId, conceptId) !==
    undefined
  );
}

/** The concepts on a learner's own shelf: what they made, plus what they joined. */
export function listConcepts(db: Db, userId: number): ConceptRow[] {
  return db
    .prepare(
      `SELECT c.* FROM concepts c
         JOIN user_concepts uc ON uc.concept_id = c.id AND uc.user_id = ?
        ORDER BY c.created_at DESC`
    )
    .all(userId) as ConceptRow[];
}

/** Shared concepts this learner has not joined — the library they can pick up for free. */
export function listSharedLibrary(db: Db, userId: number): (ConceptRow & { bank_size: number })[] {
  return db
    .prepare(
      `SELECT c.*, (
                SELECT COUNT(*) FROM items i
                  JOIN cells ce ON ce.id = i.cell_id
                  JOIN nodes n2 ON n2.id = ce.node_id
                 WHERE n2.concept_id = c.id AND i.validated = 1 AND i.retired = 0 AND i.frozen = 0
              ) AS bank_size
         FROM concepts c
        WHERE c.visibility = 'shared'
          AND NOT EXISTS (SELECT 1 FROM user_concepts uc WHERE uc.concept_id = c.id AND uc.user_id = ?)
        ORDER BY c.created_at DESC`
    )
    .all(userId) as (ConceptRow & { bank_size: number })[];
}

export interface Cohort {
  conceptId: number;
  name: string;
  /** The learners the worker is generating ahead for. Never empty. */
  userIds: number[];
}

/**
 * Concepts with somebody still training on them, and who.
 *
 * This is the bound on speculative spend that `GYM_LOOKAHEAD_CELLS` stopped being once
 * there was more than one account. That dial caps cells per concept; it says nothing
 * about how many concepts, and every abandoned account leaves its joined concepts behind
 * to be pre-generated for forever. Dormancy is measured on `user_concepts.last_active_at`,
 * which starting a session refreshes.
 */
export function activeCohorts(db: Db, windowDays: number): Cohort[] {
  const since = iso(new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000));
  const rows = db
    .prepare(
      `SELECT uc.concept_id AS conceptId, uc.user_id AS userId, c.name AS name
         FROM user_concepts uc
         JOIN concepts c ON c.id = uc.concept_id
        WHERE uc.last_active_at >= ?
        ORDER BY uc.concept_id, uc.user_id`
    )
    .all(since) as { conceptId: number; userId: number; name: string }[];

  const byConcept = new Map<number, Cohort>();
  for (const r of rows) {
    const existing = byConcept.get(r.conceptId);
    if (existing) existing.userIds.push(r.userId);
    else byConcept.set(r.conceptId, { conceptId: r.conceptId, name: r.name, userIds: [r.userId] });
  }
  return [...byConcept.values()];
}

/**
 * Who may see a concept at all. A shared concept is readable by everyone — that is what
 * makes the bank a bank — and a private one only by its owner.
 */
export function canReadConcept(concept: ConceptRow, userId: number): boolean {
  return concept.visibility === 'shared' || concept.owner_id === userId;
}

/**
 * Who may change the content — the blueprint, the item bank, the concept itself.
 *
 * Only the owner, and on a shared concept that is the point: other people are training
 * against these nodes and this bank, and their mastery history is indexed by cells that
 * an edit can retire. Everyone else forks (see `forkConcept`), which is also how someone
 * takes a shared concept private in order to ground it in their own source material.
 */
export function canEditConcept(concept: ConceptRow, userId: number): boolean {
  return concept.owner_id === userId;
}

export function deleteConcept(db: Db, id: number): void {
  db.prepare(`DELETE FROM concepts WHERE id = ?`).run(id);
}

export function updateConceptSource(
  db: Db,
  id: number,
  patch: { sourceText?: string | null; sourceNote?: string | null }
): void {
  const existing = getConcept(db, id);
  if (!existing) return;
  db.prepare(`UPDATE concepts SET source_text = ?, source_note = ? WHERE id = ?`).run(
    patch.sourceText === undefined ? existing.source_text : patch.sourceText,
    patch.sourceNote === undefined ? existing.source_note : patch.sourceNote,
    id
  );
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
  const insert = db.prepare(`INSERT OR IGNORE INTO cells (node_id, depth, applicable) VALUES (?, ?, ?)`);
  const setApplicable = db.prepare(`UPDATE cells SET applicable = ? WHERE node_id = ? AND depth = ?`);
  const tx = db.transaction(() => {
    for (let d = 1; d <= 6; d++) {
      const applicable = applicableDepths.includes(d) ? 1 : 0;
      insert.run(nodeId, d, applicable);
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

/**
 * The `user_cell_state` columns, COALESCEd to the defaults — a LEFT JOIN with no row on
 * the right reads exactly as a learner who has not been here yet.
 *
 * This is why joining a shared concept costs one row and not one per cell: a hundred-cell
 * blueprint materialises nothing until the learner actually answers something.
 */
const CELL_STATE_COLUMNS = `
  COALESCE(s.p_mastery, ${BKT.P_L0}) AS p_mastery,
  COALESCE(s.response_count, 0) AS response_count,
  COALESCE(s.consecutive_correct, 0) AS consecutive_correct,
  s.last_tested_at AS last_tested_at,
  s.next_due_at AS next_due_at,
  COALESCE(s.interval_days, 0) AS interval_days,
  COALESCE(s.ease, ${SCHEDULE.EASE_DEFAULT}) AS ease`;

export function listCells(db: Db, userId: number, conceptId: number): CellWithNode[] {
  return db
    .prepare(
      `SELECT c.*, n.title AS node_title, n.order_index AS node_order, n.concept_id AS concept_id,
              ${CELL_STATE_COLUMNS}
         FROM cells c
         JOIN nodes n ON n.id = c.node_id
         LEFT JOIN user_cell_state s ON s.cell_id = c.id AND s.user_id = ?
        WHERE n.concept_id = ?
        ORDER BY n.order_index, n.id, c.depth`
    )
    .all(userId, conceptId) as CellWithNode[];
}

export function getCellState(db: Db, userId: number, cellId: number): CellState {
  const row = db
    .prepare(
      `SELECT ${CELL_STATE_COLUMNS} FROM cells c
         LEFT JOIN user_cell_state s ON s.cell_id = c.id AND s.user_id = ?
        WHERE c.id = ?`
    )
    .get(userId, cellId) as CellState | undefined;
  return row ?? { ...DEFAULT_CELL_STATE };
}

export function setCellApplicable(db: Db, cellId: number, applicable: boolean): void {
  db.prepare(`UPDATE cells SET applicable = ? WHERE id = ?`).run(applicable ? 1 : 0, cellId);
}

/**
 * Upsert rather than update: the row does not exist until the first response, so the
 * insert branch is the common one and the response count starts from the default.
 */
export function updateCellAfterResponse(
  db: Db,
  userId: number,
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
    `INSERT INTO user_cell_state
       (user_id, cell_id, p_mastery, response_count, consecutive_correct,
        last_tested_at, next_due_at, interval_days, ease)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, cell_id) DO UPDATE SET
       p_mastery = excluded.p_mastery,
       response_count = user_cell_state.response_count + 1,
       consecutive_correct = excluded.consecutive_correct,
       last_tested_at = excluded.last_tested_at,
       next_due_at = excluded.next_due_at,
       interval_days = excluded.interval_days,
       ease = excluded.ease`
  ).run(
    userId,
    cellId,
    patch.pMastery,
    patch.consecutiveCorrect,
    patch.lastTestedAt,
    patch.nextDueAt,
    patch.intervalDays,
    patch.ease
  );
}

/**
 * Trailing incorrect responses for a cell, for this learner. Section 7.4's fallback rule
 * needs this and the state row only stores consecutive *correct*, so it is derived from
 * the log — which is now scoped by user, or one person's bad run would demote a node for
 * everyone sharing the concept.
 */
export function consecutiveWrong(db: Db, userId: number, cellId: number): number {
  const rows = db
    .prepare(
      `SELECT is_correct FROM responses
        WHERE user_id = ? AND cell_id = ?
        ORDER BY answered_at DESC, id DESC LIMIT 10`
    )
    .all(userId, cellId) as { is_correct: number | null }[];
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
    .prepare(`SELECT * FROM misconceptions WHERE node_id = ? ORDER BY id`)
    .all(nodeId) as MisconceptionRow[];
}

export function listMisconceptionsForConcept(db: Db, conceptId: number): MisconceptionRow[] {
  return db
    .prepare(
      `SELECT m.* FROM misconceptions m JOIN nodes n ON n.id = m.node_id
        WHERE n.concept_id = ? ORDER BY m.id`
    )
    .all(conceptId) as MisconceptionRow[];
}

/** The misconception profile: shared beliefs, one learner's selection counts. */
export function listMisconceptionsWithState(
  db: Db,
  userId: number,
  conceptId: number
): MisconceptionWithState[] {
  return db
    .prepare(
      `SELECT m.*, COALESCE(ums.times_selected, 0) AS times_selected
         FROM misconceptions m
         JOIN nodes n ON n.id = m.node_id
         LEFT JOIN user_misconception_state ums
                ON ums.misconception_id = m.id AND ums.user_id = ?
        WHERE n.concept_id = ?
        ORDER BY times_selected DESC, m.id`
    )
    .all(userId, conceptId) as MisconceptionWithState[];
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

export function incrementMisconceptionSelected(db: Db, userId: number, id: number): void {
  db.prepare(
    `INSERT INTO user_misconception_state (user_id, misconception_id, times_selected)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, misconception_id)
       DO UPDATE SET times_selected = user_misconception_state.times_selected + 1`
  ).run(userId, id);
}

/**
 * A misconception this learner selected >= 2 times within their last 20 responses on
 * that concept is active and triggers targeted remediation.
 *
 * Scoped by user for the same reason the whole student model is: "you believe this wrong
 * thing" is a claim about a person, and remediating one learner's confusion in everyone
 * else's session would be worse than not remediating at all.
 */
export function activeMisconceptions(
  db: Db,
  userId: number,
  conceptId: number
): MisconceptionRow[] {
  return db
    .prepare(
      `WITH recent AS (
         SELECT r.chosen_option_id
           FROM responses r
           JOIN cells c ON c.id = r.cell_id
           JOIN nodes n ON n.id = c.node_id
          WHERE n.concept_id = ? AND r.user_id = ?
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
    .all(conceptId, userId) as MisconceptionRow[];
}

/**
 * The same question asked of everybody at once, for the generator.
 *
 * Writing an item is shared work that lands in a shared bank, so which beliefs are live
 * has to be a property of the concept rather than of whoever happened to trigger the
 * fill — otherwise the same cell produces different items depending on who was warming
 * it, and the bank stops being one thing.
 */
export function activeMisconceptionsAnyUser(db: Db, conceptId: number): MisconceptionRow[] {
  return db
    .prepare(
      `WITH recent AS (
         SELECT r.chosen_option_id
           FROM responses r
           JOIN cells c ON c.id = r.cell_id
           JOIN nodes n ON n.id = c.node_id
          WHERE n.concept_id = ?
          ORDER BY r.answered_at DESC, r.id DESC
          LIMIT 50
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
 * Unseen-by-this-learner, which is what makes the item bank a bank.
 *
 * This predicate used to be `served_count = 0`: an item was written by two model calls,
 * shown once, and never returned to by anybody. Now it is "not in this learner's
 * `user_item_seen`", so the same item can be the first question of someone's first
 * session years after it was written, while never coming back to the person who has
 * already answered it. Invariant 6 was always a statement about one learner's
 * experience, and per-user scoping is what it means with more than one.
 *
 * Invariant 10 is unchanged and still enforced here: benchmark items never enter
 * practice, and the `frozen = 0` predicate is in the query itself, not applied by a
 * caller who might forget.
 */
const UNSEEN = `NOT EXISTS (
  SELECT 1 FROM user_item_seen uis WHERE uis.user_id = ? AND uis.item_id = i.id
)`;

export function takeBufferedItem(
  db: Db,
  userId: number,
  cellId: number,
  kind: 'mc' | 'free'
): ItemRow | undefined {
  return db
    .prepare(
      `SELECT i.* FROM items i
        WHERE i.cell_id = ? AND i.kind = ? AND i.validated = 1 AND i.frozen = 0 AND i.retired = 0
          AND ${UNSEEN}
        ORDER BY i.generated_at ASC, i.id ASC
        LIMIT 1`
    )
    .get(cellId, kind, userId) as ItemRow | undefined;
}

export function countBufferedItems(
  db: Db,
  userId: number,
  cellId: number,
  kind: 'mc' | 'free'
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i
        WHERE i.cell_id = ? AND i.kind = ? AND i.validated = 1 AND i.frozen = 0 AND i.retired = 0
          AND ${UNSEEN}`
    )
    .get(cellId, kind, userId) as { n: number };
  return row.n;
}

/**
 * Ready items for a cell, with the kind derived from the cell's own depth.
 *
 * Callers used to pass 'mc' literally, which silently reported 0 for every D6 cell —
 * their items are kind 'free'. A cell that always counts as empty is regenerated on
 * every top-up forever, so this quietly bought a fresh D6 item after every answered
 * question. The CASE mirrors what nextItem asks takeBufferedItem for, so the two can
 * never disagree about which items count.
 */
export function countReadyItems(db: Db, userId: number, cellId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i
         JOIN cells c ON c.id = i.cell_id
        WHERE i.cell_id = ? AND i.validated = 1 AND i.frozen = 0 AND i.retired = 0
          AND i.kind = CASE WHEN c.depth = 6 THEN 'free' ELSE 'mc' END
          AND ${UNSEEN}`
    )
    .get(cellId, userId) as { n: number };
  return row.n;
}

/**
 * Two counters, deliberately not the same one. `user_item_seen` is what this learner may
 * not be shown again; `served_count` is how many administrations the item has had across
 * everybody, which is the number classical item analysis wants and which a single-user
 * build could never accumulate.
 */
export function markItemServed(db: Db, userId: number, itemId: number): void {
  db.transaction(() => {
    db.prepare(`UPDATE items SET served_count = served_count + 1 WHERE id = ?`).run(itemId);
    db.prepare(
      `INSERT OR IGNORE INTO user_item_seen (user_id, item_id, served_at) VALUES (?, ?, ?)`
    ).run(userId, itemId, iso(now()));
  })();
}

export function hasSeenItem(db: Db, userId: number, itemId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM user_item_seen WHERE user_id = ? AND item_id = ?`).get(userId, itemId) !==
    undefined
  );
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

export function createSession(
  db: Db,
  userId: number,
  conceptId: number,
  kind: SessionKind
): SessionRow {
  const info = db
    .prepare(`INSERT INTO sessions (user_id, concept_id, started_at, kind) VALUES (?, ?, ?, ?)`)
    .run(userId, conceptId, iso(now()), kind);
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
         (user_id, session_id, item_id, cell_id, chosen_option_id, free_text, is_correct, score,
          grader_json, confidence, latency_ms, p_mastery_before, p_mastery_after, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.user_id,
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

export function listResponsesForConcept(
  db: Db,
  userId: number,
  conceptId: number
): ResponseRow[] {
  return db
    .prepare(
      `SELECT r.* FROM responses r
         JOIN cells c ON c.id = r.cell_id
         JOIN nodes n ON n.id = c.node_id
        WHERE n.concept_id = ? AND r.user_id = ? ORDER BY r.answered_at, r.id`
    )
    .all(conceptId, userId) as ResponseRow[];
}

export function incrementOptionSelected(db: Db, optionId: number): void {
  db.prepare(`UPDATE options SET selected_count = selected_count + 1 WHERE id = ?`).run(optionId);
}

/* ---------------------------------------------------------------- benchmarks */

export function insertBenchmarkRun(
  db: Db,
  userId: number,
  conceptId: number,
  results: unknown
): BenchmarkRunRow {
  const info = db
    .prepare(
      `INSERT INTO benchmark_runs (user_id, concept_id, run_at, results_json) VALUES (?, ?, ?, ?)`
    )
    .run(userId, conceptId, iso(now()), JSON.stringify(results));
  return db.prepare(`SELECT * FROM benchmark_runs WHERE id = ?`).get(Number(info.lastInsertRowid)) as
    | BenchmarkRunRow;
}

export function listBenchmarkRuns(db: Db, userId: number, conceptId: number): BenchmarkRunRow[] {
  return db
    .prepare(`SELECT * FROM benchmark_runs WHERE concept_id = ? AND user_id = ? ORDER BY run_at`)
    .all(conceptId, userId) as BenchmarkRunRow[];
}
