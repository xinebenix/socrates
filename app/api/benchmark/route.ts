import { getDb } from '@/lib/db';
import { listBenchmarkRuns, listFrozenItems } from '@/lib/db/queries';
import { benchmarkCoverage, startBenchmarkRun } from '@/lib/pipeline/benchmark';
import { fail, ok, requireNum } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const conceptId = requireNum(new URL(req.url).searchParams.get('conceptId'), 'conceptId');
    const db = getDb();

    return ok({
      frozen: listFrozenItems(db, conceptId).map((i) => ({
        id: i.id,
        stem: i.stem,
        nodeTitle: i.node_title,
        depth: i.depth,
        servedCount: i.served_count,
      })),
      coverage: benchmarkCoverage(db, conceptId),
      history: listBenchmarkRuns(db, conceptId).map((r) => ({
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
    const body = (await req.json()) as { conceptId?: number };
    const conceptId = requireNum(body.conceptId, 'conceptId');
    const plan = startBenchmarkRun(getDb(), conceptId);
    return ok(plan, 201);
  } catch (err) {
    return fail(err);
  }
}
