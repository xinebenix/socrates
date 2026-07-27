/**
 * The buffer worker, as a loop that can run either in-process or standalone.
 *
 * On Railway it has to be in-process. A volume attaches to exactly one service, and
 * two services cannot share the SQLite file — so the "second terminal running
 * npm run worker" model from local development has no equivalent there. Next's
 * instrumentation hook starts this once per server process instead.
 *
 * That in turn means the deployment must stay at one replica: two replicas would be
 * two writers against one volume, plus two workers racing to fill the same buffer.
 */

import { getDb } from '../db';
import { activeCohorts } from '../db/queries';
import { logEvent } from '../ops';
import { bufferTarget, dueShortfalls, topUpBuffer } from './buffer';
import { batchingEnabled } from '../llm/batch';
import { cellsInFlight, processBatches, submitGenerationBatch } from './batchFill';
import { budgetStatus, speculativeGenerationAllowed } from '../cost';
import { processState } from '../processState';

export interface WorkerStatus {
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTickMs: number | null;
  ticks: number;
  generated: number;
  failed: number;
  lastError: string | null;
}

interface WorkerRuntime {
  status: WorkerStatus;
  timer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  /** Logged once per crossing, not once per tick. */
  budgetWarned: boolean;
}

/**
 * Per process, not per module instance.
 *
 * The loop is started from `instrumentation.ts` and read by `/api/health`, and Next
 * bundles those separately — so module-level state here would be two objects, and the
 * health endpoint would report on a worker that is not the one running. See
 * `lib/processState.ts`.
 */
const runtime = processState<WorkerRuntime>('pipeline/workerLoop', () => ({
  status: {
    running: false,
    startedAt: null,
    lastTickAt: null,
    lastTickMs: null,
    ticks: 0,
    generated: 0,
    failed: 0,
    lastError: null,
  },
  timer: null,
  stopping: false,
  budgetWarned: false,
}));

const status = runtime.status;

export function workerStatus(): WorkerStatus {
  return { ...runtime.status };
}

export function workerIntervalMs(): number {
  const raw = Number(process.env.GYM_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 60_000;
}

/**
 * Items a tick will start per concept.
 *
 * Scaled to the buffer target rather than fixed, because a cell's whole shortfall
 * goes into one call now: at a target of 8, a fixed budget of 8 would spend the
 * entire tick on one cell and starve the rest of the concept. Four cells' worth is
 * the floor at any target.
 */
export function tickBudget(): number {
  return Math.max(8, bufferTarget() * 4);
}

/**
 * How long an account stays worth pre-generating for after its last session.
 *
 * With one user this question did not exist. With accounts it is the difference between
 * a bounded bill and an unbounded one: someone who signs up, joins four concepts and
 * never returns would otherwise have their cells stocked, and restocked, for as long as
 * the deployment lives. Thirty days is generous for a spaced-repetition tool whose
 * longest interval is 180 — a dormant account simply generates inline when it comes
 * back, at the cost of one wait.
 */
export function activeWindowDays(): number {
  const raw = Number(process.env.GYM_ACTIVE_USER_WINDOW_DAYS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 30;
}

export async function tick(maxGenerationsPerConcept = tickBudget()): Promise<void> {
  const started = Date.now();
  const db = getDb();

  // The budget stops speculative work, never a session in progress. Over budget the
  // app still trains, generating inline — slower, and only for items actually served.
  if (!speculativeGenerationAllowed(db)) {
    const budget = budgetStatus(db);
    if (!runtime.budgetWarned) {
      runtime.budgetWarned = true;
      logEvent(db, 'warn', 'budget.exceeded', {
        month: budget.month,
        limitUsd: budget.limitUsd,
        spentThisMonthUsd: budget.spentThisMonthUsd,
        effect: 'pre-generation paused; sessions still run, generating inline',
      });
    }
    status.ticks += 1;
    status.lastTickAt = new Date(started).toISOString();
    status.lastTickMs = Date.now() - started;
    return;
  }
  runtime.budgetWarned = false;

  // The worker's fills are speculative by definition, so they go through the Batch
  // API at half price when it is available. Results land a tick or two later, which
  // a buffer can afford; the session's own paths stay synchronous.
  if (batchingEnabled()) {
    try {
      const progress = await processBatches(db);
      status.generated += progress.itemsPersisted;
      status.failed += progress.failed;

      const inFlight = cellsInFlight(db);
      for (const cohort of activeCohorts(db, activeWindowDays())) {
        const shorts = dueShortfalls(db, cohort.userIds, cohort.conceptId, {
          maxGenerations: maxGenerationsPerConcept,
          exclude: inFlight,
        });
        if (shorts.length > 0) await submitGenerationBatch(db, shorts);
      }

      status.ticks += 1;
      status.lastTickAt = new Date(started).toISOString();
      status.lastTickMs = Date.now() - started;
      return;
    } catch (err) {
      // The discount is never worth an empty buffer: if the batch path fails, log
      // loudly and fall through to the synchronous fill for this tick.
      status.lastError = err instanceof Error ? err.message : String(err);
      logEvent(db, 'error', 'batch.tick_failed', { error: status.lastError });
    }
  }

  for (const cohort of activeCohorts(db, activeWindowDays())) {
    try {
      const report = await topUpBuffer(db, cohort.userIds, cohort.conceptId, {
        maxGenerations: maxGenerationsPerConcept,
      });
      status.generated += report.generated;
      status.failed += report.failed;

      if (report.generated > 0 || report.failed > 0) {
        logEvent(db, report.failed > 0 ? 'warn' : 'info', 'buffer.topup', {
          concept: cohort.name,
          conceptId: cohort.conceptId,
          learners: cohort.userIds.length,
          generated: report.generated,
          failed: report.failed,
          skipped: report.skipped,
        });
      }
    } catch (err) {
      status.failed += 1;
      status.lastError = err instanceof Error ? err.message : String(err);
      logEvent(db, 'error', 'buffer.tick_failed', {
        conceptId: cohort.conceptId,
        error: status.lastError,
      });
    }
  }

  status.ticks += 1;
  status.lastTickAt = new Date(started).toISOString();
  status.lastTickMs = Date.now() - started;
}

/** Idempotent: a second call is a no-op, so a hot reload cannot start two loops. */
export function startBufferWorker(): void {
  if (status.running) return;

  status.running = true;
  status.startedAt = new Date().toISOString();
  runtime.stopping = false;

  const interval = workerIntervalMs();
  logEvent(null, 'info', 'worker.started', { intervalMs: interval, target: bufferTarget() });

  const run = async () => {
    if (runtime.stopping) return;
    try {
      await tick();
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      logEvent(null, 'error', 'worker.tick_threw', { error: status.lastError });
    }
    if (!runtime.stopping) {
      runtime.timer = setTimeout(() => void run(), interval);
      // Do not hold the process open on this timer alone.
      if (typeof runtime.timer === 'object' && 'unref' in runtime.timer) runtime.timer.unref();
    }
  };

  // A short delay so the first tick does not compete with server startup.
  runtime.timer = setTimeout(() => void run(), 5_000);
  if (typeof runtime.timer === 'object' && 'unref' in runtime.timer) runtime.timer.unref();
}

export function stopBufferWorker(): void {
  runtime.stopping = true;
  status.running = false;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
}
