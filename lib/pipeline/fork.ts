/**
 * Taking a shared concept private.
 *
 * The sharing rule says source material makes a concept yours, and at creation time that
 * is a branch in `createConcept`. This is the same rule applied later: you joined the
 * shared "LLM", trained on it for a fortnight, and now you have the lecture notes you
 * actually want to be tested on. Editing the shared concept in place is not an option —
 * other people are training against it, and your notes would become theirs — so this
 * copies the map and leaves the original alone.
 *
 * What comes with you:
 *   the blueprint    nodes, their cells, their misconceptions — the decomposition is the
 *                    expensive part and it is still right
 *   your progress    every mastery estimate and schedule, remapped onto the new cells
 *
 * What does not:
 *   the item bank    the shared items were written against the canonical version of the
 *                    topic; a concept grounded in your own source should be tested from
 *                    it. Copying them would silently mix the two, and the item-health
 *                    screen would have no way to tell you which was which.
 *   your responses   they belong to the sessions that produced them, which belong to the
 *                    concept they were answered on. Moving them would rewrite history;
 *                    leaving them keeps both records honest.
 *
 * The mapping is by (node title, depth) rather than by id, because the copy has new ids
 * and titles are what the two blueprints actually share.
 */

import type { Db } from '../db';
import { iso, now } from '../clock';
import { conceptNameKey } from '../db/names';
import { getConcept, joinConcept, leaveConcept } from '../db/queries';
import type { ConceptRow, MisconceptionRow, NodeRow } from '../db/types';

export interface ForkResult {
  concept: ConceptRow;
  nodesCopied: number;
  cellStatesCarried: number;
}

export function forkConcept(
  db: Db,
  userId: number,
  conceptId: number,
  input: { sourceText?: string | null; sourceNote?: string | null; name?: string } = {}
): ForkResult {
  const origin = getConcept(db, conceptId);
  if (!origin) throw new Error(`concept ${conceptId} not found`);

  return db.transaction(() => {
    const name = (input.name ?? origin.name).trim();
    const created = db
      .prepare(
        `INSERT INTO concepts
           (name, name_key, owner_id, visibility, forked_from, source_text, source_note, created_at)
         VALUES (?, ?, ?, 'private', ?, ?, ?, ?)`
      )
      .run(
        name,
        conceptNameKey(name),
        userId,
        origin.id,
        input.sourceText ?? origin.source_text,
        input.sourceNote ?? origin.source_note,
        iso(now())
      );
    const newId = Number(created.lastInsertRowid);

    const nodes = db
      .prepare(`SELECT * FROM nodes WHERE concept_id = ? ORDER BY order_index, id`)
      .all(origin.id) as NodeRow[];

    const insertNode = db.prepare(
      `INSERT INTO nodes (concept_id, title, description, order_index, created_at, origin)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertCell = db.prepare(
      `INSERT INTO cells (node_id, depth, applicable) VALUES (?, ?, ?)`
    );
    const insertMisconception = db.prepare(
      `INSERT INTO misconceptions (node_id, label, description, origin, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    let cellStatesCarried = 0;
    for (const node of nodes) {
      const newNodeId = Number(
        insertNode.run(
          newId,
          node.title,
          node.description,
          node.order_index,
          iso(now()),
          node.origin
        ).lastInsertRowid
      );

      const cells = db
        .prepare(`SELECT id, depth, applicable FROM cells WHERE node_id = ? ORDER BY depth`)
        .all(node.id) as { id: number; depth: number; applicable: number }[];

      for (const cell of cells) {
        const newCellId = Number(insertCell.run(newNodeId, cell.depth, cell.applicable).lastInsertRowid);
        const moved = db
          .prepare(
            `INSERT INTO user_cell_state
               (user_id, cell_id, p_mastery, response_count, consecutive_correct,
                last_tested_at, next_due_at, interval_days, ease)
             SELECT user_id, ?, p_mastery, response_count, consecutive_correct,
                    last_tested_at, next_due_at, interval_days, ease
               FROM user_cell_state WHERE user_id = ? AND cell_id = ?`
          )
          .run(newCellId, userId, cell.id);
        cellStatesCarried += moved.changes;
      }

      const misconceptions = db
        .prepare(`SELECT * FROM misconceptions WHERE node_id = ? ORDER BY id`)
        .all(node.id) as MisconceptionRow[];
      for (const m of misconceptions) {
        insertMisconception.run(newNodeId, m.label, m.description, m.origin, iso(now()));
      }
    }

    joinConcept(db, userId, newId);
    // They have moved, not accumulated a duplicate. The shared concept is still there
    // for everyone else, and rejoining it later is one click.
    leaveConcept(db, userId, origin.id);

    return {
      concept: getConcept(db, newId)!,
      nodesCopied: nodes.length,
      cellStatesCarried,
    };
  })();
}
