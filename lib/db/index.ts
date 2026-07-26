import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema';

export type Db = Database.Database;

let singleton: Db | null = null;

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

export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);

  // Additive migrations for databases created before a column existed. CREATE TABLE
  // IF NOT EXISTS does nothing for an existing table, so new columns need an ALTER.
  const usageCols = db.pragma(`table_info('llm_usage')`) as { name: string }[];
  if (!usageCols.some((c) => c.name === 'batch')) {
    db.exec(`ALTER TABLE llm_usage ADD COLUMN batch INTEGER NOT NULL DEFAULT 0`);
  }
}

/** The process-wide handle used by API routes and the worker. */
export function getDb(): Db {
  if (!singleton) {
    singleton = openDb(dbPath());
  }
  return singleton;
}

/** Tests point the singleton at an in-memory database. */
export function setDb(db: Db | null): void {
  singleton = db;
}

export function newTestDb(): Db {
  return openDb(':memory:');
}
