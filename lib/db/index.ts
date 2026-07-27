import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { hashPasswordSync, normalizeEmail } from '../password';
import { conceptNameKey } from './names';
import { processState } from '../processState';
import { INDEXES_SQL, SCHEMA_SQL } from './schema';

export type Db = Database.Database;

/**
 * One connection per process.
 *
 * A `let` here was two connections: the in-process worker and the request handlers get
 * separate module instances under Next's bundling, so each opened its own. WAL and
 * `busy_timeout` made that survivable rather than visible, which is the worst way for a
 * thing like this to be wrong. See `lib/processState.ts`.
 */
const handle = processState<{ db: Db | null }>('db/index', () => ({ db: null }));

export function dbPath(): string {
  return process.env.GYM_DB ?? './data/gym.db';
}

export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  // WAL needs a writable directory, not just a writable file. On a container with a
  // read-only mount this is where you find out, which is the point.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Three passes, and the order is load bearing:
 *
 *   1. tables       — `CREATE TABLE IF NOT EXISTS`, a no-op for anything that exists
 *   2. columns      — additive `ALTER`s, because (1) does nothing to an existing table
 *   3. multi-user   — backfill, then lift the student model off `cells`
 *   4. indexes      — last, because `idx_concepts_shared_name` is over columns that
 *                     only exist after (2), and unique over values only settled by (3)
 */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);

  // Additive migrations for databases created before a column existed. CREATE TABLE
  // IF NOT EXISTS does nothing for an existing table, so new columns need an ALTER.
  addColumn(db, 'llm_usage', 'batch', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'llm_usage', 'user_id', 'INTEGER');

  // The multi-user columns. All nullable, including the ones the fresh schema would
  // rather have as NOT NULL: `ALTER TABLE ... ADD COLUMN` cannot add a NOT NULL foreign
  // key to a table that already has rows, and a schema that differs between a fresh
  // database and a migrated one is a worse problem than a constraint enforced in code.
  addColumn(db, 'concepts', 'name_key', `TEXT NOT NULL DEFAULT ''`);
  addColumn(db, 'concepts', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  addColumn(db, 'concepts', 'visibility', `TEXT NOT NULL DEFAULT 'shared'`);
  addColumn(db, 'concepts', 'forked_from', 'INTEGER REFERENCES concepts(id) ON DELETE SET NULL');
  addColumn(db, 'sessions', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  addColumn(db, 'responses', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  addColumn(db, 'benchmark_runs', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');

  toMultiUser(db);

  db.exec(INDEXES_SQL);
}

function addColumn(db: Db, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.pragma(`table_info('${table}')`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/* ------------------------------------------------------- the one-way migration */

/**
 * Single-user database → multi-user database.
 *
 * The destructive half is the last step: the seven student-model columns come off
 * `cells`. Leaving them would leave a read path that still compiles, still returns a
 * number, and returns the wrong person's. `docs/DEPLOY.md` says to copy the file first,
 * and it means it.
 *
 * Idempotent, and cheap to re-enter: every step is a no-op once it has run.
 */
function toMultiUser(db: Db): void {
  const liftPending = hasColumn(db, 'cells', 'p_mastery');
  const unowned = count(db, `SELECT COUNT(*) AS n FROM concepts WHERE owner_id IS NULL`);
  if (!liftPending && unowned === 0) return;

  const legacyOwnerId = unowned > 0 ? ensureLegacyOwner(db) : null;

  db.transaction(() => {
    if (legacyOwnerId !== null) adoptLegacyRows(db, legacyOwnerId);
    if (liftPending) liftStudentModel(db, legacyOwnerId);
  })();
}

/**
 * The account that inherits everything the single-user build recorded.
 *
 * It logs in with `GYM_PASSWORD` — the credential the operator already has — which is
 * why a database with data but no `GYM_PASSWORD` set is a hard stop rather than a
 * generated password nobody knows. Refusing to start is recoverable in one restart;
 * migrating the data behind an unusable login is not.
 */
function ensureLegacyOwner(db: Db): number {
  const existing = db.prepare(`SELECT id FROM users ORDER BY id LIMIT 1`).get() as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const password = (process.env.GYM_PASSWORD ?? '').trim();
  if (!password) {
    throw new Error(
      'This database has concepts recorded by the single-user build, and multi-user ' +
        'Socrates needs an account to attach them to. Set GYM_PASSWORD to the password ' +
        'that account should use and start again — it becomes the login for the owner ' +
        'account, and afterwards it is only the registration code for new signups. Set ' +
        'GYM_OWNER_EMAIL too if you want something other than owner@localhost. Back the ' +
        'database up before you do: this migration cannot be reversed.'
    );
  }

  const email = normalizeEmail(process.env.GYM_OWNER_EMAIL || 'owner@localhost');
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(email, hashPasswordSync(password), 'Owner', at);
  return Number(info.lastInsertRowid);
}

/** Everything that existed before there were accounts belongs to the first one. */
function adoptLegacyRows(db: Db, ownerId: number): void {
  db.prepare(`UPDATE concepts SET owner_id = ? WHERE owner_id IS NULL`).run(ownerId);
  db.prepare(`UPDATE sessions SET user_id = ? WHERE user_id IS NULL`).run(ownerId);
  db.prepare(`UPDATE responses SET user_id = ? WHERE user_id IS NULL`).run(ownerId);
  db.prepare(`UPDATE benchmark_runs SET user_id = ? WHERE user_id IS NULL`).run(ownerId);

  // Apply the sharing rule retroactively: source text is what makes a concept private,
  // so a concept that has none is one this build would have made shared.
  const concepts = db.prepare(`SELECT id, name, source_text FROM concepts`).all() as {
    id: number;
    name: string;
    source_text: string | null;
  }[];

  const update = db.prepare(`UPDATE concepts SET name_key = ?, visibility = ? WHERE id = ?`);
  const claimed = new Set<string>();
  for (const c of concepts) {
    const key = conceptNameKey(c.name);
    const sourced = Boolean(c.source_text && c.source_text.trim());
    // Two sourceless concepts with the same name cannot both be shared — the unique
    // index created after this would reject the second. Keep the first, and leave the
    // rest private to the owner rather than dropping or merging anybody's history.
    const shared = !sourced && !claimed.has(key);
    if (shared) claimed.add(key);
    update.run(key, shared ? 'shared' : 'private', c.id);
  }

  const at = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO user_concepts (user_id, concept_id, joined_at, last_active_at)
     SELECT ?, id, COALESCE(created_at, ?), ? FROM concepts`
  ).run(ownerId, at, at);
}

/**
 * Move the student model off `cells` and onto `user_cell_state`, then drop the columns.
 *
 * `ALTER TABLE ... DROP COLUMN` refuses on an indexed column, so `idx_cells_due` goes
 * first — it is replaced by `idx_user_cell_state_due`, which is the same lookup one key
 * wider.
 */
function liftStudentModel(db: Db, ownerId: number | null): void {
  if (ownerId !== null) {
    db.prepare(
      `INSERT OR IGNORE INTO user_cell_state
         (user_id, cell_id, p_mastery, response_count, consecutive_correct,
          last_tested_at, next_due_at, interval_days, ease)
       SELECT ?, id, p_mastery, response_count, consecutive_correct,
              last_tested_at, next_due_at, interval_days, ease
         FROM cells
        WHERE response_count > 0 OR last_tested_at IS NOT NULL OR next_due_at IS NOT NULL`
    ).run(ownerId);

    if (hasColumn(db, 'misconceptions', 'times_selected')) {
      db.prepare(
        `INSERT OR IGNORE INTO user_misconception_state (user_id, misconception_id, times_selected)
         SELECT ?, id, times_selected FROM misconceptions WHERE times_selected > 0`
      ).run(ownerId);
    }

    // What the owner has already been shown must never come back. `session_plan` is the
    // authoritative record of an administration — an item can be served and then
    // abandoned without a response behind it — with `items.served_count` as the backstop
    // for anything older than that table.
    db.prepare(
      `INSERT OR IGNORE INTO user_item_seen (user_id, item_id, served_at)
       SELECT ?, item_id, served_at FROM session_plan
        WHERE item_id IS NOT NULL AND served_at IS NOT NULL`
    ).run(ownerId);
    db.prepare(
      `INSERT OR IGNORE INTO user_item_seen (user_id, item_id, served_at)
       SELECT ?, id, generated_at FROM items WHERE served_count > 0`
    ).run(ownerId);
  }

  db.exec(`DROP INDEX IF EXISTS idx_cells_due`);
  for (const col of [
    'p_mastery',
    'response_count',
    'consecutive_correct',
    'last_tested_at',
    'next_due_at',
    'interval_days',
    'ease',
  ]) {
    if (hasColumn(db, 'cells', col)) db.exec(`ALTER TABLE cells DROP COLUMN ${col}`);
  }
  if (hasColumn(db, 'misconceptions', 'times_selected')) {
    db.exec(`ALTER TABLE misconceptions DROP COLUMN times_selected`);
  }
}

/* ------------------------------------------------------------------- handles */

/** The process-wide handle used by API routes and the worker. */
export function getDb(): Db {
  if (!handle.db) {
    handle.db = openDb(dbPath());
  }
  return handle.db;
}

/** Tests point the singleton at an in-memory database. */
export function setDb(db: Db | null): void {
  handle.db = db;
}

export function newTestDb(): Db {
  return openDb(':memory:');
}
