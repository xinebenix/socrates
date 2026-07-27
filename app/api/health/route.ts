import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { dbPath, getDb } from '@/lib/db';
import { authConfig, healthTokenMatches, SESSION_COOKIE, verifySession } from '@/lib/auth';
import { opsCounts, recentOps } from '@/lib/ops';
import { workerStatus } from '@/lib/pipeline/workerLoop';
import { STRONG_FROM_DEPTH, effortFor, model, modelFor, strategyName } from '@/lib/llm/client';
import { bufferConcurrency, bufferTarget, refillThreshold } from '@/lib/pipeline/buffer';
import { countUsers } from '@/lib/db/queries';
import { now } from '@/lib/clock';
import { batchingEnabled } from '@/lib/llm/batch';
import {
  billingSplit,
  budgetStatus,
  dayKey,
  spendBy,
  totalSpend,
  unservedItemSpend,
} from '@/lib/cost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything needed to diagnose a deployment from one authenticated GET.
 *
 * The design constraint: assume no shell, no log access, and log retention that has
 * already expired. Whatever is not in this response cannot be debugged remotely.
 *
 * Protected by the session cookie or a bearer GYM_HEALTH_TOKEN. Secrets are reported
 * as booleans and never as values.
 */
export async function GET(req: Request) {
  const config = authConfig(process.env);

  const cookie = req.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  const authorized =
    Boolean(await verifySession(config.sessionSecret, cookie ?? null, Date.now())) ||
    (await healthTokenMatches(config, req.headers.get('authorization')));

  if (!authorized) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const started = Date.now();
  const file = dbPath();
  const dir = path.dirname(path.resolve(file));

  const report: Record<string, unknown> = {
    ok: true,
    at: now().toISOString(),
    // Railway injects these; they are how I tell which commit is actually running.
    deployment: {
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? null,
      branch: process.env.RAILWAY_GIT_BRANCH ?? null,
      service: process.env.RAILWAY_SERVICE_NAME ?? null,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
      replica: process.env.RAILWAY_REPLICA_ID ?? null,
      region: process.env.RAILWAY_REPLICA_REGION ?? null,
    },
    runtime: {
      node: process.version,
      nodeEnv: process.env.NODE_ENV ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    config: {
      // Booleans, never values.
      anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      model: model(),
      sessionSecretConfigured: Boolean(config.sessionSecret),
      signupCodeConfigured: Boolean(config.signupCode),
      healthTokenConfigured: Boolean(config.healthToken),
      accounts: 0,
      bufferTarget: bufferTarget(),
      workerDisabled: process.env.GYM_DISABLE_WORKER === '1',
    },
    storage: storageReport(file, dir),
    worker: workerStatus(),
  };

  try {
    const db = getDb();

    report.database = {
      path: file,
      tables: tableCounts(db),
      integrity: (db.pragma('quick_check', { simple: true }) as string) ?? 'unknown',
      journalMode: db.pragma('journal_mode', { simple: true }) as string,
      pageCount: db.pragma('page_count', { simple: true }) as number,
    };

    (report.config as Record<string, unknown>).accounts = countUsers(db);

    // Every concept, not one account's — this is the operator's view. `bufferedItems`
    // is the bank as a whole rather than what any one learner has left unseen, which is
    // the number that answers "is the worker keeping up".
    report.concepts = (
      db.prepare(`SELECT id, name, visibility FROM concepts ORDER BY id`).all() as {
        id: number;
        name: string;
        visibility: string;
      }[]
    ).map((c) => {
      const buffered = db
        .prepare(
          `SELECT COUNT(*) AS n FROM items i
             JOIN cells cl ON cl.id = i.cell_id
             JOIN nodes n ON n.id = cl.node_id
            WHERE n.concept_id = ? AND i.validated = 1 AND i.frozen = 0 AND i.retired = 0`
        )
        .get(c.id) as { n: number };
      const learners = db
        .prepare(`SELECT COUNT(*) AS n FROM user_concepts WHERE concept_id = ?`)
        .get(c.id) as { n: number };
      return {
        id: c.id,
        name: c.name,
        visibility: c.visibility,
        learners: learners.n,
        bankSize: buffered.n,
      };
    });

    // Generation latency, so "it feels slow" can be checked rather than debated.
    report.latency = {
      strategy: strategyName(),
      models: {
        itemShallow: modelFor('item', 1),
        itemDeep: modelFor('item', STRONG_FROM_DEPTH),
        blueprint: modelFor('blueprint'),
        validateShallow: modelFor('validate', 1),
        validateDeep: modelFor('validate', STRONG_FROM_DEPTH),
        grade: modelFor('grade'),
      },
      effort: {
        item: effortFor('item'),
        blueprint: effortFor('blueprint'),
        validate: effortFor('validate'),
        grade: effortFor('grade'),
      },
      bufferConcurrency: bufferConcurrency(),
      // Set size and the point at which a cell refills. Together these decide how
      // much amortization the generation calls actually get.
      setSize: bufferTarget(),
      refillAt: refillThreshold(),
      item: timingSummary(db, 'generate.timing'),
      blueprint: timingSummary(db, 'blueprint.generated'),
    };

    // Tokens are exact; the money is an estimate off a price table that will drift.
    report.spend = {
      disclaimer:
        'Token counts come from the API and are exact. USD figures are estimated from ' +
        'a built-in price table that may be out of date — override it with GYM_PRICES ' +
        'and check against your Anthropic billing page.',
      budget: budgetStatus(db),
      today: totalSpend(db, dayKey()),
      last7Days: totalSpend(db, dayKey(-6)),
      allTime: totalSpend(db),
      byKind: spendBy(db, 'kind', dayKey(-29)),
      byModel: spendBy(db, 'model', dayKey(-29)),
      aheadOfUse: unservedItemSpend(db),
      // Proof, or the absence of it. batchShare near 0 after real use means the
      // speculative pipeline is not going through the Batch API at all.
      billing: billingSplit(db, dayKey(-29)),
    };

    // The half-price pipeline: open batches mean the worker is waiting on the
    // provider, not stuck. An old openest batch plus an empty buffer is the signal
    // worth acting on.
    report.batching = {
      enabled: batchingEnabled(),
      openBatches: (
        db.prepare(`SELECT COUNT(*) AS n FROM gen_batches WHERE completed_at IS NULL`).get() as {
          n: number;
        }
      ).n,
      oldestOpen:
        (
          db
            .prepare(
              `SELECT MIN(created_at) AS at FROM gen_batches WHERE completed_at IS NULL`
            )
            .get() as { at: string | null }
        ).at ?? null,
    };

    report.ops = {
      counts: opsCounts(db),
      recentErrors: recentOps(db, 15, 'error'),
      recent: recentOps(db, 25),
    };
  } catch (err) {
    report.ok = false;
    report.database = {
      path: file,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  report.tookMs = Date.now() - started;
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}

/**
 * Median and worst case over the durations recorded in ops_log for one event.
 *
 * The median is the honest number for "how long does this take" — a mean is dragged
 * around by the occasional three-attempt regeneration, which is a different problem
 * with a different fix.
 */
function timingSummary(
  db: ReturnType<typeof getDb>,
  event: string
): { n: number; medianMs: number | null; maxMs: number | null } {
  const rows = db
    .prepare(`SELECT detail FROM ops_log WHERE event = ? ORDER BY id DESC LIMIT 50`)
    .all(event) as { detail: string | null }[];

  const durations: number[] = [];
  for (const row of rows) {
    if (!row.detail) continue;
    try {
      const ms = (JSON.parse(row.detail) as { ms?: unknown }).ms;
      if (typeof ms === 'number' && Number.isFinite(ms)) durations.push(ms);
    } catch {
      // A malformed log line is not worth failing a health check over.
    }
  }

  if (durations.length === 0) return { n: 0, medianMs: null, maxMs: null };
  durations.sort((a, b) => a - b);
  return {
    n: durations.length,
    medianMs: durations[Math.floor(durations.length / 2)],
    maxMs: durations[durations.length - 1],
  };
}

/**
 * Whether the data directory is a real, writable, persistent mount.
 *
 * This is the single most likely thing to be wrong on a first Railway deploy: with no
 * volume attached, everything works until the first redeploy silently resets the
 * database to empty. Reporting the mount and a live write probe turns that from a
 * mystery into a line of JSON.
 */
function storageReport(file: string, dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    dbPath: file,
    dataDir: dir,
    volumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH ?? null,
    volumeName: process.env.RAILWAY_VOLUME_NAME ?? null,
  };

  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  out.dbOnVolume = mount ? path.resolve(file).startsWith(path.resolve(mount)) : null;

  // Warn loudly rather than quietly: an unmounted deploy loses everything on redeploy.
  if (process.env.RAILWAY_SERVICE_NAME && !mount) {
    out.warning =
      'No Railway volume is mounted. The database lives on the container filesystem and ' +
      'will be destroyed on the next deploy or restart.';
  } else if (mount && out.dbOnVolume === false) {
    out.warning =
      `A volume is mounted at ${mount} but GYM_DB points outside it (${file}). ` +
      'The database will not survive a redeploy.';
  }

  try {
    const stat = fs.statSync(dir);
    out.dataDirExists = stat.isDirectory();
  } catch {
    out.dataDirExists = false;
  }

  try {
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    out.writable = true;
  } catch (err) {
    out.writable = false;
    out.writeError = err instanceof Error ? err.message : String(err);
  }

  try {
    out.dbSizeBytes = fs.statSync(path.resolve(file)).size;
  } catch {
    out.dbSizeBytes = null;
  }

  return out;
}

function tableCounts(db: ReturnType<typeof getDb>): Record<string, number> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];

  const counts: Record<string, number> = {};
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number };
      counts[t.name] = row.n;
    } catch {
      counts[t.name] = -1;
    }
  }
  return counts;
}
