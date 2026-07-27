import { getDb } from '@/lib/db';
import { listBenchmarkRuns, listFrozenItems } from '@/lib/db/queries';
import { benchmarkCoverage, startBenchmarkRun } from '@/lib/pipeline/benchmark';
import { fail, ok, readable, requireNum, requireUserId } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const conceptId = requireNum(new URL(req.url).searchParams.get('conceptId'), 'conceptId');
    const db = getDb();
    readable(db, userId, conceptId);

    return ok({
      frozen: listFrozenItems(db, conceptId).map((i) => ({
        id: i.id,
        stem: i.stem,
        nodeTitle: i.node_title,
        depth: i.depth,
        servedCount: i.served_count,
      })),
      coverage: benchmarkCoverage(db, conceptId),
      history: listBenchmarkRuns(db, userId, conceptId).map((r) => ({
        id: r.id,
        runAt: r.run_at,
        results: JSON.parse(r.results_json) as unknown,
      })),
    });
  } catch (err) {
    return fail(err);
  }
}

/** Start a benchmark run. Frozen items only, no feedback until the run completes. */
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json()) as { conceptId?: number };
    const conceptId = requireNum(body.conceptId, 'conceptId');
    const db = getDb();
    readable(db, userId, conceptId);
    const plan = startBenchmarkRun(db, userId, conceptId);
    return ok(plan, 201);
  } catch (err) {
    return fail(err);
  }
}
