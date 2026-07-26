import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

const SCHEMA_PATH = path.join(process.cwd(), 'lib', 'db', 'schema.sql');

let singleton: Db | null = null;

export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
}

/** The process-wide handle used by API routes and the worker. */
export function getDb(): Db {
  if (!singleton) {
    singleton = openDb(process.env.GYM_DB ?? './data/gym.db');
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
