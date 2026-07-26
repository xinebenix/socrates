import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { dbPath, getDb } from '@/lib/db';
import { authConfig, healthTokenMatches, SESSION_COOKIE, verifySession } from '@/lib/auth';
import { opsCounts, recentOps } from '@/lib/ops';
import { workerStatus } from '@/lib/pipeline/workerLoop';
import { model } from '@/lib/llm/client';
import { bufferTarget } from '@/lib/pipeline/buffer';
import { listConcepts } from '@/lib/db/queries';
import { now } from '@/lib/clock';

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
    (await verifySession(config.password, cookie ?? null, Date.now())) ||
    (await healthTokenMatches(config, req.headers.get('authorization'))) ||
    (!config.password && config.allowPublic);

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
      passwordConfigured: Boolean(config.password),
      allowPublic: config.allowPublic,
      healthTokenConfigured: Boolean(config.healthToken),
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

    report.concepts = listConcepts(db).map((c) => {
      const buffered = db
        .prepare(
          `SELECT COUNT(*) AS n FROM items i
             JOIN cells cl ON cl.id = i.cell_id
             JOIN nodes n ON n.id = cl.node_id
            WHERE n.concept_id = ? AND i.validated = 1 AND i.frozen = 0
              AND i.retired = 0 AND i.served_count = 0`
        )
        .get(c.id) as { n: number };
      return { id: c.id, name: c.name, bufferedItems: buffered.n };
    });

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
