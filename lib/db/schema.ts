/**
 * The schema, inlined.
 *
 * This used to be read from `lib/db/schema.sql` at runtime via `process.cwd()`. That
 * works when the whole repo is on disk next to the server, and breaks silently the
 * first time anyone builds a standalone output or a multi-stage container — the
 * process starts fine and then fails on the first query. Inlining removes the class
 * of failure entirely, which matters more once this is running somewhere you cannot
 * put a breakpoint in.
 *
 * Tables and indexes are separate constants on purpose. `migrate()` runs the tables,
 * then the additive `ALTER`s that bring an older database up to shape, and only then
 * the indexes — because one of the indexes is over columns that an older `concepts`
 * table does not have until those `ALTER`s have run.
 *
 * ---------------------------------------------------------------------------
 * The line this schema draws: **content is shared, progress is not.**
 *
 *   content   concepts · nodes · cells · misconceptions · items · options
 *   progress  user_cell_state · user_item_seen · user_misconception_state ·
 *             sessions · responses · session_plan · benchmark_runs
 *
 * The two used to be the same row. `cells` carried the (node, depth) pair *and* the
 * mastery estimate and SM-2 schedule for it, which is coherent for exactly one
 * learner and incoherent for two. Everything a second person would overwrite now
 * lives in a `user_*` table keyed by (user_id, …), and the content tables are free to
 * be shared — which is what makes one blueprint and one item bank serve everybody.
 */

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,   -- stored normalised: trimmed and lowercased
  password_hash TEXT NOT NULL,          -- scrypt, see lib/password.ts
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- A concept is either shared or private, and which one it is follows from whether the
-- creator supplied their own source material. Sourceless concepts generate against the
-- canonical, textbook version of a topic — items that are the same for everyone, and so
-- worth writing once — and are keyed by name so a second person asking for the same
-- topic joins the existing bank. Supplying source text makes the concept idiosyncratic
-- to that person, so it is theirs alone. That is also what keeps pasted material
-- private: there is no path by which a sourced concept becomes shared.
CREATE TABLE IF NOT EXISTS concepts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL DEFAULT '',    -- normalised name; unique among shared concepts
  owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  visibility    TEXT NOT NULL DEFAULT 'shared',   -- 'shared' | 'private'
  forked_from   INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
  source_text   TEXT,
  source_note   TEXT,
  created_at    TEXT NOT NULL
);

-- Membership. A user's concept list is what they created plus what they joined, and the
-- worker reads this to know which cells are worth generating ahead for — without it,
-- pre-generation has no way to tell a live account from one that stopped coming.
CREATE TABLE IF NOT EXISTS user_concepts (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id     INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  joined_at      TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  PRIMARY KEY (user_id, concept_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  id            INTEGER PRIMARY KEY,
  concept_id    INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  order_index   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  origin        TEXT NOT NULL
);

-- Content only. The mastery estimate and the schedule that used to live here are in
-- user_cell_state, one row per learner who has actually answered something.
CREATE TABLE IF NOT EXISTS cells (
  id                  INTEGER PRIMARY KEY,
  node_id             INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth               INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 6),
  applicable          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (node_id, depth)
);

-- The student model. Absent means untouched: a learner new to a shared concept has no
-- rows here and reads the defaults below, which is why joining a concept with a hundred
-- cells writes nothing. The first response creates the row.
--
-- The defaults must equal BKT.P_L0 and SCHEDULE.EASE_DEFAULT. A test asserts it, because
-- a silent drift here would move every fresh cell's prior without failing anything.
CREATE TABLE IF NOT EXISTS user_cell_state (
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cell_id             INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  p_mastery           REAL NOT NULL DEFAULT 0.15,
  response_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  last_tested_at      TEXT,
  next_due_at         TEXT,
  interval_days       REAL NOT NULL DEFAULT 0,
  ease                REAL NOT NULL DEFAULT 2.5,
  PRIMARY KEY (user_id, cell_id)
);

-- Invariant 6, per learner. An item is served at most once to any one person and freely
-- to everybody else; this table is the record of the first half. It replaces
-- items.served_count as the buffer predicate — that column survives, but only as a
-- cross-user administration count for item statistics.
CREATE TABLE IF NOT EXISTS user_item_seen (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  served_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS misconceptions (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  description   TEXT NOT NULL,
  origin        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- The misconception profile is a per-learner claim — "you believe this wrong thing" —
-- so it cannot sit on the shared misconception row. Remediation slots are selected from
-- this table.
CREATE TABLE IF NOT EXISTS user_misconception_state (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  misconception_id INTEGER NOT NULL REFERENCES misconceptions(id) ON DELETE CASCADE,
  times_selected   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, misconception_id)
);

CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY,
  cell_id        INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  stem           TEXT NOT NULL,
  explanation    TEXT NOT NULL,
  rubric_json    TEXT,
  generated_at   TEXT NOT NULL,
  validated      INTEGER NOT NULL DEFAULT 0,
  validator_json TEXT,
  frozen         INTEGER NOT NULL DEFAULT 0,
  retired        INTEGER NOT NULL DEFAULT 0,
  served_count   INTEGER NOT NULL DEFAULT 0   -- administrations across all learners
);

CREATE TABLE IF NOT EXISTS options (
  id                INTEGER PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  text              TEXT NOT NULL,
  is_correct        INTEGER NOT NULL,
  misconception_id  INTEGER REFERENCES misconceptions(id),
  rationale         TEXT NOT NULL,
  selected_count    INTEGER NOT NULL DEFAULT 0   -- across all learners; feeds item analysis
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  kind        TEXT NOT NULL DEFAULT 'practice'
);

CREATE TABLE IF NOT EXISTS responses (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id            INTEGER NOT NULL REFERENCES items(id),
  cell_id            INTEGER NOT NULL REFERENCES cells(id),
  chosen_option_id   INTEGER REFERENCES options(id),
  free_text          TEXT,
  is_correct         INTEGER,
  score              REAL,
  grader_json        TEXT,
  confidence         TEXT NOT NULL,
  latency_ms         INTEGER,
  p_mastery_before   REAL NOT NULL,
  p_mastery_after    REAL NOT NULL,
  answered_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  run_at      TEXT NOT NULL,
  results_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_plan (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  cell_id     INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES items(id),
  slot_kind   TEXT NOT NULL,
  served_at   TEXT,
  PRIMARY KEY (session_id, position)
);

-- Operational breadcrumbs. Not part of the domain model: this exists so a failure in
-- a container I cannot attach to is still diagnosable after the fact, without
-- depending on log retention. Capped; see lib/ops.ts.
CREATE TABLE IF NOT EXISTS ops_log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  level   TEXT NOT NULL,
  event   TEXT NOT NULL,
  detail  TEXT
);

-- Token accounting. Every model call lands here, because a tool whose running cost
-- is invisible is a tool you stop using — and the interesting number is never the
-- total, it is which call site is spending it and whether the item was ever served.
CREATE TABLE IF NOT EXISTS llm_usage (
  id             INTEGER PRIMARY KEY,
  at             TEXT NOT NULL,
  day            TEXT NOT NULL,          -- YYYY-MM-DD, for cheap bucketing
  call_site      TEXT NOT NULL,          -- blueprint | item-mc-d3 | validate | grade
  kind           TEXT NOT NULL,          -- blueprint | item | validate | grade
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  ms             INTEGER NOT NULL DEFAULT 0,
  batch          INTEGER NOT NULL DEFAULT 0,  -- 1 = went through the Batch API, billed at half
  user_id        INTEGER                     -- null = speculative or shared, attributable to nobody
);

-- In-flight Message Batches for the speculative pipeline. Persisted so a batch
-- survives a restart or redeploy: the provider keeps working while we are down, and
-- the next worker tick picks the results up by id.
CREATE TABLE IF NOT EXISTS gen_batches (
  id                 INTEGER PRIMARY KEY,
  provider_batch_id  TEXT NOT NULL,
  phase              TEXT NOT NULL,       -- 'generate' | 'validate'
  payload            TEXT NOT NULL,       -- JSON context needed to resume on retrieval
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);
`;

/**
 * Applied after the additive ALTERs, because `idx_concepts_shared_name` is over columns
 * that a database created by the single-user build does not have yet.
 *
 * That index is the whole join-an-existing-bank mechanism: it makes "one shared concept
 * per normalised name" a database constraint rather than a convention that a race
 * between two signups could break. Private concepts are excluded, so any number of
 * people may keep their own "LLM" grounded in their own source material.
 */
export const INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_concepts_shared_name
  ON concepts(name_key) WHERE visibility = 'shared';
CREATE INDEX IF NOT EXISTS idx_concepts_owner ON concepts(owner_id);

CREATE INDEX IF NOT EXISTS idx_gen_batches_open ON gen_batches(phase) WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_llm_usage_day ON llm_usage(day);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at DESC);

CREATE INDEX IF NOT EXISTS idx_user_cell_state_due ON user_cell_state(user_id, next_due_at);
CREATE INDEX IF NOT EXISTS idx_user_concepts_concept ON user_concepts(concept_id);
CREATE INDEX IF NOT EXISTS idx_user_item_seen_item ON user_item_seen(item_id);

CREATE INDEX IF NOT EXISTS idx_responses_cell ON responses(cell_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_responses_user_cell ON responses(user_id, cell_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, concept_id);

CREATE INDEX IF NOT EXISTS idx_items_cell ON items(cell_id, frozen, retired);
CREATE INDEX IF NOT EXISTS idx_nodes_concept ON nodes(concept_id, order_index);
CREATE INDEX IF NOT EXISTS idx_options_item ON options(item_id, position);
CREATE INDEX IF NOT EXISTS idx_misconceptions_node ON misconceptions(node_id);
CREATE INDEX IF NOT EXISTS idx_ops_log_at ON ops_log(at DESC);
`;
