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

import { describe, expect, it } from 'vitest';
import { makeFakeLlm } from './fakeLlm';
import { makeFixture } from './helpers';
import { setTransport } from '../lib/llm/client';
import { nextItem, startSession } from '../lib/pipeline/session';
import { submitMcResponse } from '../lib/pipeline/respond';
import { listSessionPlan } from '../lib/db/queries';

/** One model call. Real ones are 15-30s; scaled 100x so the suite stays fast. */
const CALL_MS = 200;
/** Time the learner spends on a question. 25s real — a realistic ratio, not a kind one. */
const ANSWER_MS = 250;

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
