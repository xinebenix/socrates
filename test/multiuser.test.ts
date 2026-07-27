/**
 * More than one learner.
 *
 * Two properties, and they pull in opposite directions:
 *
 *   **Content is shared.** A blueprint is one large Opus call and a stocked concept is
 *   dozens more. The second person to ask for "LLM" should pay none of it.
 *
 *   **Progress is not.** Nothing one learner does may move another's mastery estimate,
 *   schedule, misconception profile, or the set of items they have left to see.
 *
 * The tests below are the seam between them. A regression here does not throw — it
 * quietly shows somebody else's numbers, or quietly buys a second copy of a blueprint
 * that already exists.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { addUser, makeFixture, serveItems, setCellState } from './helpers';
import { installFakeLlm } from './fakeLlm';

import { migrate, type Db } from '../lib/db';
import {
  activeCohorts,
  canEditConcept,
  canReadConcept,
  createConcept,
  DEFAULT_CELL_STATE,
  getCellState,
  hasSeenItem,
  listCells,
  listConcepts,
  listSharedLibrary,
  takeBufferedItem,
} from '../lib/db/queries';
import { conceptNameKey } from '../lib/db/names';
import { readyForCohort } from '../lib/pipeline/buffer';
import { generateMcItem } from '../lib/pipeline/generateItem';
import { forkConcept } from '../lib/pipeline/fork';
import { submitMcResponse } from '../lib/pipeline/respond';
import { startSession } from '../lib/pipeline/session';
import { BKT } from '../lib/mastery/bkt';
import { SCHEDULE } from '../lib/schedule/sm2';
import { hashPassword, verifyPassword } from '../lib/password';

function cellOf(db: Db, nodeId: number, depth: number): number {
  return (
    db.prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = ?`).get(nodeId, depth) as {
      id: number;
    }
  ).id;
}

describe('one concept, two learners', () => {
  it('the second person to ask for a topic joins the bank rather than building one', () => {
    const { db, userId: alice } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');

    const first = createConcept(db, { userId: alice, name: 'LLM' });
    expect(first.joined).toBe(false);
    expect(first.concept.visibility).toBe('shared');

    // Same topic, sloppier typing. The normalised name is what matches.
    const second = createConcept(db, { userId: bob, name: '  llm  ' });
    expect(second.joined).toBe(true);
    expect(second.concept.id).toBe(first.concept.id);

    // Both have it on their shelf; there is one concept behind both shelves.
    expect(listConcepts(db, alice).map((c) => c.id)).toContain(first.concept.id);
    expect(listConcepts(db, bob).map((c) => c.id)).toContain(first.concept.id);
  });

  it('supplying your own source material makes an independent concept instead', () => {
    const { db, userId: alice } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');

    const shared = createConcept(db, { userId: alice, name: 'LLM' });
    const mine = createConcept(db, {
      userId: bob,
      name: 'LLM',
      sourceText: 'my lecture notes, which are nobody else’s business',
    });

    expect(mine.joined).toBe(false);
    expect(mine.concept.id).not.toBe(shared.concept.id);
    expect(mine.concept.visibility).toBe('private');

    // And it is invisible: not on Alice's shelf, not in the library she can join.
    expect(listConcepts(db, alice).map((c) => c.id)).not.toContain(mine.concept.id);
    expect(listSharedLibrary(db, alice).map((c) => c.id)).not.toContain(mine.concept.id);
    expect(canReadConcept(mine.concept, alice)).toBe(false);
    expect(canReadConcept(mine.concept, bob)).toBe(true);
  });

  it('a shared concept is readable by everyone and editable only by its owner', () => {
    const { db, userId: alice } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');
    const { concept } = createConcept(db, { userId: alice, name: 'LLM' });

    expect(canReadConcept(concept, bob)).toBe(true);
    expect(canEditConcept(concept, bob)).toBe(false);
    expect(canEditConcept(concept, alice)).toBe(true);
  });

  it('normalises case and internal whitespace, and nothing else', () => {
    expect(conceptNameKey('  Large   Language  Models ')).toBe('large language models');
    expect(conceptNameKey('LLM')).toBe(conceptNameKey('llm'));
    // Deliberately not merged: an abbreviation is not the same request as the phrase.
    expect(conceptNameKey('LLM')).not.toBe(conceptNameKey('Large Language Models'));
  });
});

describe('the item bank is shared and consumed per learner', () => {
  it('an item one learner has answered is still fresh for another', async () => {
    const { db, userId: alice, nodeIds } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');
    installFakeLlm();

    const cellId = cellOf(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    expect(item).not.toBeNull();

    serveItems(db, alice, cellId, 1);

    // Spent for Alice, untouched for Bob. Under the old `served_count = 0` predicate
    // this item was spent for everybody, and Bob's session would have paid two model
    // calls to be asked something that already existed.
    expect(takeBufferedItem(db, alice, cellId, 'mc')).toBeUndefined();
    expect(takeBufferedItem(db, bob, cellId, 'mc')?.id).toBe(item!.id);

    expect(hasSeenItem(db, alice, item!.id)).toBe(true);
    expect(hasSeenItem(db, bob, item!.id)).toBe(false);
  });

  it('counts administrations across everybody, which is what item analysis needs', async () => {
    const { db, userId: alice, nodeIds } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');
    installFakeLlm();

    const cellId = cellOf(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    serveItems(db, alice, cellId, 1);
    serveItems(db, bob, cellId, 1);

    const row = db.prepare(`SELECT served_count FROM items WHERE id = ?`).get(item!.id) as {
      served_count: number;
    };
    expect(row.served_count).toBe(2);
  });

  it('stocks a cell for whoever is furthest through it, not per learner', async () => {
    const { db, userId: alice, nodeIds } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');
    installFakeLlm();

    const cellId = cellOf(db, nodeIds[0], 1);
    for (let i = 0; i < 3; i++) await generateMcItem(db, cellId);

    serveItems(db, alice, cellId, 2);

    // Alice has one left, Bob has three. The cohort is as stocked as its emptiest
    // member — taking the max instead would multiply the generation bill by the number
    // of people on the concept, which is the thing sharing exists to avoid.
    expect(readyForCohort(db, [alice], cellId)).toBe(1);
    expect(readyForCohort(db, [bob], cellId)).toBe(3);
    expect(readyForCohort(db, [alice, bob], cellId)).toBe(1);
  });
});

describe('progress is private', () => {
  it('answering does not move anyone else’s mastery or schedule', async () => {
    const { db, userId: alice, conceptId, nodeIds } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');
    installFakeLlm();

    const cellId = cellOf(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const options = db
      .prepare(`SELECT * FROM options WHERE item_id = ? ORDER BY position`)
      .all(item!.id) as { id: number; is_correct: number }[];

    const session = startSession(db, alice, conceptId, { length: 10 });
    submitMcResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      chosenOptionId: options.find((o) => o.is_correct === 1)!.id,
      confidence: 'confident',
      latencyMs: 900,
    });

    const aliceState = getCellState(db, alice, cellId);
    expect(aliceState.response_count).toBe(1);
    expect(aliceState.p_mastery).toBeGreaterThan(BKT.P_L0);
    expect(aliceState.next_due_at).not.toBeNull();

    // Bob has never answered anything, so he reads the defaults — and importantly has
    // no row at all, which is what keeps joining a hundred-cell blueprint free.
    expect(getCellState(db, bob, cellId)).toEqual(DEFAULT_CELL_STATE);
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM user_cell_state WHERE user_id = ?`)
      .get(bob) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('joining a concept writes no cell state', () => {
    const { db, userId: alice } = makeFixture(5);
    const bob = addUser(db, 'bob@example.test');
    const { concept } = createConcept(db, { userId: alice, name: 'Shared topic' });
    createConcept(db, { userId: bob, name: 'Shared topic' });

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM user_cell_state WHERE user_id = ?`)
      .get(bob) as { n: number };
    expect(rows.n).toBe(0);
    expect(listCells(db, bob, concept.id).every((c) => c.p_mastery === BKT.P_L0)).toBe(true);
  });

  it('reads one learner’s own numbers off a blueprint they share', () => {
    const { db, userId: alice, conceptId, nodeIds } = makeFixture(2);
    const bob = addUser(db, 'bob@example.test');

    setCellState(db, alice, nodeIds[0], 1, { pMastery: 0.9, responseCount: 5 });
    setCellState(db, bob, nodeIds[0], 1, { pMastery: 0.2, responseCount: 1 });

    const forAlice = listCells(db, alice, conceptId).find((c) => c.node_id === nodeIds[0] && c.depth === 1)!;
    const forBob = listCells(db, bob, conceptId).find((c) => c.node_id === nodeIds[0] && c.depth === 1)!;

    expect(forAlice.id).toBe(forBob.id); // one cell
    expect(forAlice.p_mastery).toBeCloseTo(0.9, 10);
    expect(forBob.p_mastery).toBeCloseTo(0.2, 10);
  });

  it('a session belongs to the account that started it', () => {
    const { db, userId: alice, conceptId } = makeFixture(1);
    const session = startSession(db, alice, conceptId, { length: 10 });
    const row = db.prepare(`SELECT user_id FROM sessions WHERE id = ?`).get(session.sessionId) as {
      user_id: number;
    };
    expect(row.user_id).toBe(alice);
  });
});

describe('taking a shared concept private', () => {
  it('copies the map, carries your progress, and leaves the original alone', () => {
    const { db, userId: alice, nodeIds } = makeFixture(2);
    const bob = addUser(db, 'bob@example.test');
    const { concept } = createConcept(db, { userId: alice, name: 'Shared' });

    // Give the shared concept a blueprint by reusing the fixture's, then have Bob join
    // and build up some history on it.
    db.prepare(`UPDATE nodes SET concept_id = ? WHERE id IN (${nodeIds.join(',')})`).run(concept.id);
    createConcept(db, { userId: bob, name: 'Shared' });
    setCellState(db, bob, nodeIds[0], 1, { pMastery: 0.82, responseCount: 4 });

    const forked = forkConcept(db, bob, concept.id, { sourceText: 'my own notes' });

    expect(forked.concept.visibility).toBe('private');
    expect(forked.concept.owner_id).toBe(bob);
    expect(forked.concept.forked_from).toBe(concept.id);
    expect(forked.nodesCopied).toBe(2);

    // The mastery came across, mapped by (node title, depth) onto the new cells.
    const copied = listCells(db, bob, forked.concept.id).find(
      (c) => c.node_title === 'Node 1' && c.depth === 1
    )!;
    expect(copied.p_mastery).toBeCloseTo(0.82, 10);
    expect(copied.response_count).toBe(4);

    // Alice still has hers, untouched, and Bob has moved off it.
    expect(listConcepts(db, alice).map((c) => c.id)).toContain(concept.id);
    expect(listConcepts(db, bob).map((c) => c.id)).not.toContain(concept.id);
    expect(listConcepts(db, bob).map((c) => c.id)).toContain(forked.concept.id);
  });
});

describe('the worker only generates ahead for accounts still turning up', () => {
  it('drops a concept whose learners have all gone quiet', () => {
    const { db, userId: alice } = makeFixture(1);
    const { concept } = createConcept(db, { userId: alice, name: 'Dormant' });

    expect(activeCohorts(db, 30).map((c) => c.conceptId)).toContain(concept.id);

    db.prepare(`UPDATE user_concepts SET last_active_at = ? WHERE user_id = ?`).run(
      '2025-01-01T00:00:00.000Z',
      alice
    );
    expect(activeCohorts(db, 30)).toHaveLength(0);
  });

  it('gathers everyone on a concept into one cohort, so one fill serves them all', () => {
    const { db, userId: alice } = makeFixture(1);
    const bob = addUser(db, 'bob@example.test');
    const { concept } = createConcept(db, { userId: alice, name: 'Popular' });
    createConcept(db, { userId: bob, name: 'Popular' });

    const cohort = activeCohorts(db, 30).find((c) => c.conceptId === concept.id)!;
    expect(cohort.userIds.sort()).toEqual([alice, bob].sort());
  });
});

describe('passwords', () => {
  it('round-trips, and rejects anything else', async () => {
    const hash = await hashPassword('a long enough passphrase');
    expect(await verifyPassword(hash, 'a long enough passphrase')).toBe(true);
    expect(await verifyPassword(hash, 'a long enough passphras')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('salts, so two accounts with the same password do not share a hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toBe(b);
  });

  it('reads a malformed stored hash as a failed login rather than throwing', async () => {
    for (const stored of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e', 'scrypt$x$y$z$$']) {
      expect(await verifyPassword(stored, 'anything')).toBe(false);
    }
  });
});

describe('the defaults a learner with no history reads', () => {
  it('match the column defaults in the schema', () => {
    // Two places state the prior: the SQL and DEFAULT_CELL_STATE. A drift between them
    // would move every fresh cell's mastery without failing anything else.
    const db = new Database(':memory:');
    migrate(db);
    const cols = db.pragma(`table_info('user_cell_state')`) as {
      name: string;
      dflt_value: string | null;
    }[];
    const dflt = (name: string) => Number(cols.find((c) => c.name === name)!.dflt_value);

    expect(dflt('p_mastery')).toBe(BKT.P_L0);
    expect(dflt('ease')).toBe(SCHEDULE.EASE_DEFAULT);
    expect(DEFAULT_CELL_STATE.p_mastery).toBe(BKT.P_L0);
    expect(DEFAULT_CELL_STATE.ease).toBe(SCHEDULE.EASE_DEFAULT);
    db.close();
  });

  it('keeps the student model off the cells table entirely', () => {
    const db = new Database(':memory:');
    migrate(db);
    const cols = (db.pragma(`table_info('cells')`) as { name: string }[]).map((c) => c.name);
    expect(cols.sort()).toEqual(['applicable', 'depth', 'id', 'node_id']);
    db.close();
  });
});
