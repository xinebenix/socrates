PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS concepts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  source_text   TEXT,                -- pasted source material, may be long
  source_note   TEXT,                -- where it came from
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id            INTEGER PRIMARY KEY,
  concept_id    INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,       -- what mastery of this node means, 2-4 sentences
  order_index   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  origin        TEXT NOT NULL        -- 'generated' | 'user' | 'evidence'
);

CREATE TABLE IF NOT EXISTS cells (
  id                  INTEGER PRIMARY KEY,
  node_id             INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth               INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 6),
  applicable          INTEGER NOT NULL DEFAULT 1,  -- some nodes have no meaningful D4, say
  p_mastery           REAL NOT NULL DEFAULT 0.15,  -- BKT p_L
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
  label         TEXT NOT NULL,       -- short handle, e.g. "state ownership = social ownership"
  description   TEXT NOT NULL,       -- the belief stated in the first person, as a learner would hold it
  origin        TEXT NOT NULL,       -- 'generated' | 'user' | 'observed'
  times_selected INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY,
  cell_id        INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,      -- 'mc' | 'free'
  stem           TEXT NOT NULL,
  explanation    TEXT NOT NULL,      -- shown after answering; covers the correct answer
  rubric_json    TEXT,               -- free items only: array of criteria
  generated_at   TEXT NOT NULL,
  validated      INTEGER NOT NULL DEFAULT 0,
  validator_json TEXT,               -- full validator verdict, kept for auditing
  frozen         INTEGER NOT NULL DEFAULT 0,  -- benchmark item
  retired        INTEGER NOT NULL DEFAULT 0,
  served_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  id                INTEGER PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  text              TEXT NOT NULL,
  is_correct        INTEGER NOT NULL,
  misconception_id  INTEGER REFERENCES misconceptions(id),  -- NULL only for the correct option
  rationale         TEXT NOT NULL,   -- why this option is right or wrong; shown in feedback
  selected_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  kind        TEXT NOT NULL DEFAULT 'practice'  -- 'practice' | 'benchmark'
);

CREATE TABLE IF NOT EXISTS responses (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id            INTEGER NOT NULL REFERENCES items(id),
  cell_id            INTEGER NOT NULL REFERENCES cells(id),
  chosen_option_id   INTEGER REFERENCES options(id),   -- NULL for free response
  free_text          TEXT,
  is_correct         INTEGER,                           -- for free: score >= pass threshold
  score              REAL,                              -- free response 0..1
  grader_json        TEXT,                              -- per-criterion verdict
  confidence         TEXT NOT NULL,                     -- 'guessing' | 'unsure' | 'confident'
  latency_ms         INTEGER,
  p_mastery_before   REAL NOT NULL,                     -- snapshot, needed for item analysis
  p_mastery_after    REAL NOT NULL,
  answered_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id          INTEGER PRIMARY KEY,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  run_at      TEXT NOT NULL,
  results_json TEXT NOT NULL      -- per node, per depth: n, correct, score
);

-- Not in the data model proper: the ordered item list a session was assembled with.
-- A session is planned before it starts (section 7.3), so the plan has to live
-- somewhere between "start" and "next-item".
CREATE TABLE IF NOT EXISTS session_plan (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  cell_id     INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES items(id),
  slot_kind   TEXT NOT NULL,       -- 'remediation' | 'due' | 'frontier' | 'benchmark' | 'd6'
  served_at   TEXT,
  PRIMARY KEY (session_id, position)
);

CREATE INDEX IF NOT EXISTS idx_cells_due ON cells(next_due_at);
CREATE INDEX IF NOT EXISTS idx_responses_cell ON responses(cell_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_items_cell ON items(cell_id, frozen, retired);
CREATE INDEX IF NOT EXISTS idx_nodes_concept ON nodes(concept_id, order_index);
CREATE INDEX IF NOT EXISTS idx_options_item ON options(item_id, position);
CREATE INDEX IF NOT EXISTS idx_misconceptions_node ON misconceptions(node_id);
CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, answered_at);
