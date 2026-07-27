/**
 * The single-user database, opened by the multi-user build.
 *
 * This is the only migration in the app that cannot be undone: the seven student-model
 * columns come off `cells`, and the numbers in them exist afterwards only because this
 * code moved them first. A deployment that has been running for months is exactly one
 * restart away from this path, and the failure mode of getting it wrong is not an error
 * — it is a learning record that quietly reads as brand new.
 *
 * So the fixture below is the literal schema the previous build wrote, not a
 * reconstruction from the current one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, type Db } from '../lib/db';
import { getCellState, listConcepts, takeBufferedItem } from '../lib/db/queries';
import { verifyPassword } from '../lib/password';

/** The shape the single-user build created, verbatim in the parts that changed. */
const LEGACY_SQL = `
CREATE TABLE concepts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, source_text TEXT, source_note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY, concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, order_index INTEGER NOT NULL,
  created_at TEXT NOT NULL, origin TEXT NOT NULL
);
CREATE TABLE cells (
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 6), applicable INTEGER NOT NULL DEFAULT 1,
  p_mastery REAL NOT NULL DEFAULT 0.15, response_count INTEGER NOT NULL DEFAULT 0,
  consecutive_correct INTEGER NOT NULL DEFAULT 0, last_tested_at TEXT, next_due_at TEXT,
  interval_days REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5,
  UNIQUE (node_id, depth)
);
CREATE TABLE misconceptions (
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label TEXT NOT NULL, description TEXT NOT NULL, origin TEXT NOT NULL,
  times_selected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY, cell_id INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, stem TEXT NOT NULL, explanation TEXT NOT NULL, rubric_json TEXT,
  generated_at TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, validator_json TEXT,
  frozen INTEGER NOT NULL DEFAULT 0, retired INTEGER NOT NULL DEFAULT 0,
  served_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE options (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, text TEXT NOT NULL, is_correct INTEGER NOT NULL,
  misconception_id INTEGER REFERENCES misconceptions(id), rationale TEXT NOT NULL,
  selected_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL, ended_at TEXT, kind TEXT NOT NULL DEFAULT 'practice'
);
CREATE TABLE responses (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), cell_id INTEGER NOT NULL REFERENCES cells(id),
  chosen_option_id INTEGER REFERENCES options(id), free_text TEXT, is_correct INTEGER,
  score REAL, grader_json TEXT, confidence TEXT NOT NULL, latency_ms INTEGER,
  p_mastery_before REAL NOT NULL, p_mastery_after REAL NOT NULL, answered_at TEXT NOT NULL
);
CREATE TABLE benchmark_runs (
  id INTEGER PRIMARY KEY, concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  run_at TEXT NOT NULL, results_json TEXT NOT NULL
);
CREATE TABLE session_plan (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, cell_id INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id), slot_kind TEXT NOT NULL, served_at TEXT,
  PRIMARY KEY (session_id, position)
);
CREATE TABLE ops_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, detail TEXT
);
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, call_site TEXT NOT NULL,
  kind TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cells_due ON cells(next_due_at);
`;

const AT = '2026-01-01T00:00:00.000Z';

/**
 * Two concepts — one with pasted source material, one without — a cell with real
 * mastery on it, a selected misconception, and one item already served.
 */
function legacyDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(LEGACY_SQL);

  db.exec(`
    INSERT INTO concepts (id, name, source_text, source_note, created_at)
      VALUES (1, 'Socialism', 'pasted lecture notes', 'from the reader', '${AT}'),
             (2, '  LLM  ', NULL, NULL, '${AT}');
    INSERT INTO nodes (id, concept_id, title, description, order_index, created_at, origin)
      VALUES (1, 1, 'Ownership', 'what it means', 0, '${AT}', 'generated');
    INSERT INTO cells (id, node_id, depth, applicable, p_mastery, response_count,
                       consecutive_correct, last_tested_at, next_due_at, interval_days, ease)
      VALUES (1, 1, 1, 1, 0.87, 6, 3, '${AT}', '2026-02-01T00:00:00.000Z', 20.5, 2.65),
             (2, 1, 2, 1, 0.15, 0, 0, NULL, NULL, 0, 2.5);
    INSERT INTO misconceptions (id, node_id, label, description, origin, times_selected, created_at)
      VALUES (1, 1, 'state = social', 'I think government ownership is social ownership', 'generated', 3, '${AT}');
    INSERT INTO items (id, cell_id, kind, stem, explanation, generated_at, validated, served_count)
      VALUES (1, 1, 'mc', 'a served question', 'because', '${AT}', 1, 2),
             (2, 1, 'mc', 'an unserved question', 'because', '${AT}', 1, 0);
    INSERT INTO sessions (id, concept_id, started_at, kind) VALUES (1, 1, '${AT}', 'practice');
    INSERT INTO session_plan (session_id, position, cell_id, item_id, slot_kind, served_at)
      VALUES (1, 0, 1, 1, 'frontier', '${AT}');
    INSERT INTO responses (id, session_id, item_id, cell_id, confidence,
                           p_mastery_before, p_mastery_after, answered_at, is_correct)
      VALUES (1, 1, 1, 1, 'confident', 0.7, 0.87, '${AT}', 1);
    INSERT INTO benchmark_runs (id, concept_id, run_at, results_json)
      VALUES (1, 1, '${AT}', '{}');
  `);
  return db;
}

const previousPassword = process.env.GYM_PASSWORD;
afterEach(() => {
  if (previousPassword === undefined) delete process.env.GYM_PASSWORD;
  else process.env.GYM_PASSWORD = previousPassword;
  delete process.env.GYM_OWNER_EMAIL;
});

describe('migrating a single-user database', () => {
  it('refuses to start rather than orphaning the data behind a login nobody has', () => {
    delete process.env.GYM_PASSWORD;
    const db = legacyDb();
    // The alternative — inventing a password — migrates the record correctly and then
    // makes it unreachable. Refusing costs one restart.
    expect(() => migrate(db)).toThrow(/GYM_PASSWORD/);
    db.close();
  });

  it('hands everything to an owner account that logs in with the existing password', async () => {
    process.env.GYM_PASSWORD = 'the-password-they-already-have';
    process.env.GYM_OWNER_EMAIL = 'Owner@Example.Test';
    const db = legacyDb();
    migrate(db);

    const users = db.prepare(`SELECT * FROM users`).all() as {
      id: number;
      email: string;
      password_hash: string;
    }[];
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('owner@example.test'); // normalised
    expect(await verifyPassword(users[0].password_hash, 'the-password-they-already-have')).toBe(true);

    const owner = users[0].id;
    expect(listConcepts(db, owner).map((c) => c.name).sort()).toEqual(['  LLM  ', 'Socialism']);
    for (const table of ['sessions', 'responses', 'benchmark_runs']) {
      const orphans = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NULL`).get() as {
        n: number;
      };
      expect(orphans.n, `${table} has rows belonging to nobody`).toBe(0);
    }
    db.close();
  });

  it('moves the student model onto the owner and drops the columns', () => {
    process.env.GYM_PASSWORD = 'pw-that-is-long-enough';
    const db = legacyDb();
    migrate(db);
    const owner = (db.prepare(`SELECT id FROM users`).get() as { id: number }).id;

    const state = getCellState(db, owner, 1);
    expect(state.p_mastery).toBeCloseTo(0.87, 10);
    expect(state.response_count).toBe(6);
    expect(state.consecutive_correct).toBe(3);
    expect(state.next_due_at).toBe('2026-02-01T00:00:00.000Z');
    expect(state.interval_days).toBeCloseTo(20.5, 10);
    expect(state.ease).toBeCloseTo(2.65, 10);

    // The untouched cell had nothing worth moving, so it has no row — same as any
    // learner who has not answered anything on it.
    const rows = db.prepare(`SELECT cell_id FROM user_cell_state`).all() as { cell_id: number }[];
    expect(rows.map((r) => r.cell_id)).toEqual([1]);

    const cols = (db.pragma(`table_info('cells')`) as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('p_mastery');
    expect(cols).not.toContain('next_due_at');
    expect(
      (db.pragma(`table_info('misconceptions')`) as { name: string }[]).map((c) => c.name)
    ).not.toContain('times_selected');
    db.close();
  });

  it('carries the misconception profile and what has already been shown', () => {
    process.env.GYM_PASSWORD = 'pw-that-is-long-enough';
    const db = legacyDb();
    migrate(db);
    const owner = (db.prepare(`SELECT id FROM users`).get() as { id: number }).id;

    const belief = db
      .prepare(`SELECT times_selected FROM user_misconception_state WHERE user_id = ?`)
      .get(owner) as { times_selected: number };
    expect(belief.times_selected).toBe(3);

    // Item 1 has been served; it must not come back. Item 2 is still waiting.
    expect(takeBufferedItem(db, owner, 1, 'mc')?.id).toBe(2);
    db.close();
  });

  it('applies the sharing rule retroactively: source material means private', () => {
    process.env.GYM_PASSWORD = 'pw-that-is-long-enough';
    const db = legacyDb();
    migrate(db);

    const concepts = db.prepare(`SELECT id, visibility, name_key FROM concepts ORDER BY id`).all() as {
      id: number;
      visibility: string;
      name_key: string;
    }[];
    expect(concepts[0].visibility).toBe('private'); // Socialism, with pasted notes
    expect(concepts[1].visibility).toBe('shared'); // LLM, sourceless
    expect(concepts[1].name_key).toBe('llm'); // normalised, so a newcomer joins it
    db.close();
  });

  it('is a no-op the second time, and the third', () => {
    process.env.GYM_PASSWORD = 'pw-that-is-long-enough';
    const db = legacyDb();
    migrate(db);
    const before = db.prepare(`SELECT * FROM user_cell_state`).all();

    migrate(db);
    migrate(db);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT * FROM user_cell_state`).all()).toEqual(before);
    db.close();
  });

  it('keeps two sourceless concepts of the same name from colliding on the shared index', () => {
    process.env.GYM_PASSWORD = 'pw-that-is-long-enough';
    const db = legacyDb();
    db.prepare(`INSERT INTO concepts (id, name, created_at) VALUES (3, 'llm', '${AT}')`).run();

    // Only one of them can be the shared "llm"; the other stays private rather than
    // being merged into it or dropped. Nobody's history is worth a tidier index.
    expect(() => migrate(db)).not.toThrow();
    const shared = db
      .prepare(`SELECT COUNT(*) AS n FROM concepts WHERE visibility = 'shared' AND name_key = 'llm'`)
      .get() as { n: number };
    expect(shared.n).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM concepts`).get()).toEqual({ n: 3 });
    db.close();
  });

  it('needs no owner when there is nothing to migrate', () => {
    delete process.env.GYM_PASSWORD;
    const db = new Database(':memory:');
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 0 });
    db.close();
  });
});
