/**
 * Operational logging.
 *
 * Two sinks, deliberately. `console` output is what `railway logs` shows and is the
 * fastest thing to read while a deploy is in front of you. The `ops_log` table is
 * what survives log retention, restarts, and not having a token — it is readable
 * through /api/health, so a failure three days ago is still diagnosable from a
 * single authenticated GET.
 *
 * JSON lines rather than prose, because the useful operation on a log is grep.
 */

import type { Db } from './db';
import { iso, now } from './clock';

export type OpsLevel = 'info' | 'warn' | 'error';

/** Rows kept in ops_log. Old rows are trimmed on write. */
const RETAIN = 500;
const TRIM_EVERY = 25;

let writesSinceTrim = 0;

export function logEvent(
  db: Db | null,
  level: OpsLevel,
  event: string,
  detail?: Record<string, unknown>
): void {
  const at = iso(now());
  const payload = detail ? safeJson(detail) : null;

  const line = JSON.stringify({ at, level, event, ...(detail ?? {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (!db) return;
  try {
    db.prepare(`INSERT INTO ops_log (at, level, event, detail) VALUES (?, ?, ?, ?)`).run(
      at,
      level,
      event,
      payload
    );
    if (++writesSinceTrim >= TRIM_EVERY) {
      writesSinceTrim = 0;
      db.prepare(
        `DELETE FROM ops_log WHERE id NOT IN (SELECT id FROM ops_log ORDER BY id DESC LIMIT ?)`
      ).run(RETAIN);
    }
  } catch {
    // A logging failure must never propagate into the request it was describing.
  }
}

export interface OpsRow {
  id: number;
  at: string;
  level: OpsLevel;
  event: string;
  detail: unknown;
}

export function recentOps(db: Db, limit = 50, level?: OpsLevel): OpsRow[] {
  const rows = level
    ? (db
        .prepare(`SELECT * FROM ops_log WHERE level = ? ORDER BY id DESC LIMIT ?`)
        .all(level, limit) as { id: number; at: string; level: OpsLevel; detail: string | null; event: string }[])
    : (db
        .prepare(`SELECT * FROM ops_log ORDER BY id DESC LIMIT ?`)
        .all(limit) as { id: number; at: string; level: OpsLevel; detail: string | null; event: string }[]);

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    level: r.level,
    event: r.event,
    detail: r.detail ? tryParse(r.detail) : null,
  }));
}

export function opsCounts(db: Db): Record<OpsLevel, number> {
  const rows = db
    .prepare(`SELECT level, COUNT(*) AS n FROM ops_log GROUP BY level`)
    .all() as { level: OpsLevel; n: number }[];
  const out: Record<OpsLevel, number> = { info: 0, warn: 0, error: 0 };
  for (const r of rows) out[r.level] = r.n;
  return out;
}

/**
 * Never let a secret reach the log. Values are truncated and anything whose key looks
 * like a credential is replaced outright, because the most common way a key leaks is
 * an error object carrying the request that contained it.
 */
const SECRET_KEY = /(key|token|secret|password|authorization|cookie)/i;

function safeJson(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail, (k, v) => {
      if (SECRET_KEY.test(k)) return '[redacted]';
      if (typeof v === 'string' && v.length > 600) return `${v.slice(0, 600)}…[${v.length} chars]`;
      return v;
    });
  } catch {
    return '"[unserializable]"';
  }
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
