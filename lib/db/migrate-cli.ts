import { getDb } from './index';

const db = getDb();
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
  .all() as { name: string }[];

console.log(`migrated ${process.env.GYM_DB ?? './data/gym.db'}`);
console.log(tables.map((t) => `  ${t.name}`).join('\n'));
