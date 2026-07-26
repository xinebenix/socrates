/**
 * What the learner actually waits for.
 *
 * The reported symptom, three times over: answer the first question, then sit through
 * a generation before the second one appears. Each round had a different cause, and
 * the last of them was invisible to every other test in this suite because they all
 * use an instant fake model. With no latency there is no window for the session-start
 * warm and the answer path to overlap, so the overlap bug cannot happen.
 *
 * So this file injects latency deliberately, and asserts on the three numbers that
 * describe the experience: how often the learner waits, how many items were bought to
 * serve the plan, and how many calls that took.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeLlm } from './fakeLlm';
import { makeFixture } from './helpers';
import { setTransport } from '../lib/llm/client';
import { nextItem, startSession } from '../lib/pipeline/session';
import { submitMcResponse } from '../lib/pipeline/respond';
import { listSessionPlan } from '../lib/db/queries';
import { setBatchTransport } from '../lib/llm/batch';
import { submitGenerationBatch } from '../lib/pipeline/batchFill';
import { dueShortfalls } from '../lib/pipeline/buffer';
import { resetCellLocks } from '../lib/pipeline/cellLock';

/** One model call. Real ones are 15-30s; scaled 100x so the suite stays fast. */
const CALL_MS = 200;
/** Time the learner spends on a question. 25s real — a realistic ratio, not a kind one. */
const ANSWER_MS = 250;

afterEach(() => {
  setTransport(null);
  setBatchTransport(null);
  resetCellLocks();
});

/**
 * The steady state on a live deployment, and the one the first version of this file
 * failed to model: the worker submits a Batch API request for the plausibly-due cells
 * every tick, and those are exactly the cells a session plans. So there is almost
 * always an open batch covering the plan.
 *
 * fillSessionNeed used to treat a pending batch as covering the cell. Batches take
 * minutes and are allowed 26 hours, so that left the warm generating nothing and every
 * early item produced inline while the learner watched — four of the first four.
 */
describe('a session started while a worker batch is pending', () => {
  it('still covers its own plan', async () => {
    const { db, conceptId } = makeFixture(8);
    const { handler } = makeFakeLlm();
    setTransport(async (req) => {
      await new Promise((r) => setTimeout(r, CALL_MS));
      return handler(req);
    });

    // A batch that never returns — indistinguishable, from the session's point of
    // view, from one that will land in ten minutes.
    setBatchTransport({
      async submit() {
        return 'pending-forever';
      },
      async poll() {
        return null;
      },
    });

    await submitGenerationBatch(db, dueShortfalls(db, conceptId, { maxGenerations: 40 }));

    const started = startSession(db, conceptId, { length: 20 });
    let waits = 0;
    for (let n = 1; n <= 4; n++) {
      const t0 = Date.now();
      await nextItem(db, started.sessionId);
      if (Date.now() - t0 > CALL_MS) waits++;
      await new Promise((r) => setTimeout(r, ANSWER_MS));
    }

    // One is the floor: nothing is banked, so the first question must be written.
    expect(waits, `learner waited ${waits} times with a batch pending`).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe('a cold session', () => {
  it('makes the learner wait once, and buys each item exactly once', async () => {
    const { db, conceptId } = makeFixture(8);
    const { handle, handler } = makeFakeLlm();
    setTransport(async (req) => {
      await new Promise((r) => setTimeout(r, CALL_MS));
      return handler(req);
    });

    const started = startSession(db, conceptId, { length: 20 });
    const plan = listSessionPlan(db, started.sessionId);
    const distinctCells = new Set(plan.map((p) => p.cell_id)).size;
    expect(plan.length).toBe(20);

    let waits = 0;
    for (let n = 1; n <= plan.length; n++) {
      const t0 = Date.now();
      const res = await nextItem(db, started.sessionId);
      if (Date.now() - t0 > CALL_MS) waits++;

      if (res.item?.kind === 'mc') {
        submitMcResponse(db, {
          sessionId: started.sessionId,
          itemId: res.item.itemId,
          chosenOptionId: res.item.options[0].id,
          confidence: 'confident',
          latencyMs: ANSWER_MS,
        });
      }
      await new Promise((r) => setTimeout(r, ANSWER_MS));
    }

    const persisted = (
      db.prepare(`SELECT COUNT(*) AS n FROM items WHERE validated = 1`).get() as { n: number }
    ).n;
    const generationCalls = handle.calls.filter((c) => c.kind.startsWith('item')).length;

    // One wait is the floor on a concept with nothing banked: the very first question
    // has to be written before it can be shown. Two means the answer path duplicated
    // work the warm already had in flight — the bug this pins.
    expect(waits, `learner waited ${waits} times`).toBeLessThanOrEqual(1);

    // No duplicates. A 20-slot plan needs 20 items; buying 21+ means two passes
    // generated the same cell.
    expect(persisted).toBe(plan.length);

    // One generation call per distinct cell — the amortization is intact. One call per
    // item would be ~20 and four times the cost.
    expect(generationCalls).toBeLessThanOrEqual(distinctCells + 1);
  }, 60_000);
});
