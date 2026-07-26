/**
 * The schema, inlined.
 *
 * This used to be read from `lib/db/schema.sql` at runtime via `process.cwd()`. That
 * works when the whole repo is on disk next to the server, and breaks silently the
 * first time anyone builds a standalone output or a multi-stage container — the
 * process starts fine and then fails on the first query. Inlining removes the class
 * of failure entirely, which matters more once this is running somewhere you cannot
 * put a breakpoint in.
 */

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS concepts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  source_text   TEXT,
  source_note   TEXT,
  created_at    TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS cells (
  id                  INTEGER PRIMARY KEY,
  node_id             INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth               INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 6),
  applicable          INTEGER NOT NULL DEFAULT 1,
  p_mastery           REAL NOT NULL DEFAULT 0.15,
  response_count      INTEGER NOT NULL DEFAULT 0,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  last_tested_at      TEXT,
  next_due_at         TEXT,
  interval_days       REAL NOT NULL DEFAULT 0,
  ease                REAL NOT NULL DEFAULT 2.5,
  UNIQUE (node_id, depth)
);

CREATE TABLE IF NOT EXISTS misconceptions (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  description   TEXT NOT NULL,
  origin        TEXT NOT NULL,
  times_selected INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
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
  served_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  id                INTEGER PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  text              TEXT NOT NULL,
  is_correct        INTEGER NOT NULL,
  misconception_id  INTEGER REFERENCES misconceptions(id),
  rationale         TEXT NOT NULL,
  selected_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  kind        TEXT NOT NULL DEFAULT 'practice'
);

CREATE TABLE IF NOT EXISTS responses (
  id                 INTEGER PRIMARY KEY,
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
  ms             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_day ON llm_usage(day);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at DESC);

CREATE INDEX IF NOT EXISTS idx_cells_due ON cells(next_due_at);
CREATE INDEX IF NOT EXISTS idx_responses_cell ON responses(cell_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_items_cell ON items(cell_id, frozen, retired);
CREATE INDEX IF NOT EXISTS idx_nodes_concept ON nodes(concept_id, order_index);
CREATE INDEX IF NOT EXISTS idx_options_item ON options(item_id, position);
CREATE INDEX IF NOT EXISTS idx_misconceptions_node ON misconceptions(node_id);
CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_ops_log_at ON ops_log(at DESC);
`;
