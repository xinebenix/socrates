/**
 * The pre-generation buffer's throughput properties.
 *
 * Item generation is two sequential model calls, so the only way the buffer stays
 * ahead of a session is by filling several items at once. These pin the behaviours
 * that make that true — concurrency, resilience to one bad cell, and filling the
 * cells the session is about to want first. All three are invisible when the fake
 * model answers instantly, so without tests they would rot silently.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeLlm } from './fakeLlm';
import { makeFixture, serveItems } from './helpers';
import { setTransport } from '../lib/llm/client';
import {
  bufferConcurrency,
  bufferTarget,
  cellsGenerating,
  fillSessionNeed,
  planNeed,
  refillThreshold,
  topUpBuffer,
} from '../lib/pipeline/buffer';
import { nextItem, startSession } from '../lib/pipeline/session';
import { startBenchmarkRun } from '../lib/pipeline/benchmark';
import { generateItemsForCell, summarizeFailure } from '../lib/pipeline/generateItem';
import { MAX_ITEMS_PER_CALL } from '../lib/prompts/itemMc';
import { countReadyItems, listCells, listSessionPlan } from '../lib/db/queries';
import { assembleSession, clampSessionLength } from '../lib/policy/assemble';
import { loadCellSnapshots } from '../lib/policy/snapshot';
import { now } from '../lib/clock';

afterEach(() => {
  setTransport(null);
  delete process.env.GYM_BUFFER_CONCURRENCY;
  delete process.env.GYM_BUFFER_TARGET;
  delete process.env.GYM_BUFFER_REFILL_AT;
});

/**
 * Items of a cell this learner has not answered — the predicate the buffer now runs on.
 * `served_count = 0` used to mean the same thing and no longer does: an item served to
 * somebody else is still fresh for you.
 */
const unseenSql = `SELECT COUNT(*) AS n FROM items i
  WHERE i.cell_id = ? AND i.validated = 1 AND i.frozen = 0 AND i.retired = 0
    AND NOT EXISTS (SELECT 1 FROM user_item_seen s WHERE s.user_id = ? AND s.item_id = i.id)`;

describe('the set-size dial', () => {
  it('defaults to 3 and is raisable up to the per-call ceiling', () => {
    expect(bufferTarget()).toBe(3);

    process.env.GYM_BUFFER_TARGET = '8';
    expect(bufferTarget()).toBe(8);

    // Past the ceiling the later items in a set get less attention, and a truncated
    // response loses the whole thing.
    process.env.GYM_BUFFER_TARGET = '50';
    expect(bufferTarget()).toBe(MAX_ITEMS_PER_CALL);

    for (const bad of ['0', '-1', 'lots', '']) {
      process.env.GYM_BUFFER_TARGET = bad;
      expect(bufferTarget()).toBe(3);
    }
  });

  it('writes a raised target in a single call', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await topUpBuffer(db, [userId], conceptId, {
      priorityCellIds: [cell.id],
      target: 8,
      maxGenerations: 8,
      concurrency: 1,
    });

    expect(handle.calls.filter((c) => c.kind === 'item-mc')).toHaveLength(1);
    expect(handle.calls.filter((c) => c.kind === 'validate')).toHaveLength(8);

    const stored = db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND validated = 1`)
      .get(cell.id) as { n: number };
    expect(stored.n).toBe(8);
  });

  it('never splits one cell across two calls to fit a tick budget', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(2);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    // Budget smaller than the target: the cell still goes in one call, because
    // clipping it would turn one cheap call into two expensive ones.
    await topUpBuffer(db, [userId], conceptId, {
      priorityCellIds: [cell.id],
      target: 6,
      maxGenerations: 2,
      concurrency: 1,
    });

    const gens = handle.calls.filter((c) => c.kind === 'item-mc');
    expect(gens).toHaveLength(1);
    const asked = /<how_many>(\d+)<\/how_many>/.exec(
      String((gens[0].request.messages as { content: string }[])[0].content)
    )?.[1];
    expect(asked).toBe('6');
  });
});

describe('serving a session never builds depth', () => {
  it('warms exactly what the plan needs, counting cells that appear twice', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(3);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cells = listCells(db, userId, conceptId).filter((c) => c.depth === 1);
    const twice = cells.find((c) => c.node_id === nodeIds[0])!;
    const once = cells.find((c) => c.node_id === nodeIds[1])!;

    // A plan where one cell serves two slots.
    await fillSessionNeed(db, userId, conceptId, [twice.id, once.id, twice.id], { concurrency: 1 });

    const count = (cellId: number) =>
      (
        db
          .prepare(unseenSql)
          .get(cellId, userId) as { n: number }
      ).n;

    expect(count(twice.id)).toBe(2);
    expect(count(once.id)).toBe(1);

    // Two cells, so two generation calls — not one per item.
    expect(handle.calls.filter((c) => c.kind === 'item-mc')).toHaveLength(2);
  });

  it('warms a whole default-length plan, leaving no slot uncovered', async () => {
    // A fixed cap here used to leave 6-8 slots of a 20-item plan unwarmed, so the
    // session hit inline generation partway through — the same visible symptom as
    // the churn it was meant to fix, just later in the session.
    for (const nodeCount of [3, 8, 12]) {
      const { db, userId, conceptId } = makeFixture(nodeCount);
      const { handler } = makeFakeLlm();
      setTransport(handler);

      const { slots } = assembleSession({
        cells: loadCellSnapshots(db, userId, conceptId),
        remediationNodeIds: new Set(),
        targetLength: clampSessionLength(20),
        now: now(),
        includeSpacing: true,
      });
      const plan = slots.map((s) => s.cellId);
      expect(plan.length).toBe(20);

      await fillSessionNeed(db, userId, conceptId, plan);

      let uncovered = 0;
      for (const [cellId, n] of planNeed(plan)) {
        uncovered += Math.max(0, n - countReadyItems(db, userId, cellId));
      }
      expect(uncovered, `${nodeCount} nodes left ${uncovered} slots uncovered`).toBe(0);
    }
  });

  it('generates NOTHING when the remaining plan is already covered', async () => {
    // This is the regression the user reported: answering question 1 kicked off a
    // fresh generation. It happened because the warm pass filled each cell to 1
    // while the refill pass measured against GYM_BUFFER_TARGET, so every warmed
    // cell read as depleted the moment the session began.
    const { db, userId, conceptId, nodeIds } = makeFixture(3);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);
    process.env.GYM_BUFFER_TARGET = '10';

    const cells = listCells(db, userId, conceptId).filter((c) => c.depth === 1);
    const plan = [cells[0].id, cells[1].id, cells[2].id];

    await fillSessionNeed(db, userId, conceptId, plan, { concurrency: 1 });
    const afterWarm = handle.calls.filter((c) => c.kind === 'item-mc').length;
    expect(afterWarm).toBe(3);

    // Serve the first slot, then do what the answer path does: cover what remains.
    serveItems(db, userId, cells[0].id, 1);

    await fillSessionNeed(db, userId, conceptId, [cells[1].id, cells[2].id], { concurrency: 1 });

    expect(handle.calls.filter((c) => c.kind === 'item-mc').length).toBe(afterWarm);
  });

  it('counts a D6 cell\'s free-response items, so it is not rebuilt every time', async () => {
    // The bug this pins: the ready-count hardcoded kind='mc', and a D6 cell's items
    // are kind='free'. It therefore always counted as empty, so every top-up bought
    // another D6 item — one per answered question, forever.
    const { db, userId, conceptId, nodeIds } = makeFixture(2);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const d6 = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 6
    )!;

    await fillSessionNeed(db, userId, conceptId, [d6.id], { concurrency: 1 });
    const first = handle.calls.filter((c) => c.kind === 'item-free').length;
    expect(first).toBe(1);

    // Three more passes over a plan that still wants one D6 item, which is banked.
    for (let i = 0; i < 3; i++) {
      await fillSessionNeed(db, userId, conceptId, [d6.id], { concurrency: 1 });
    }

    expect(handle.calls.filter((c) => c.kind === 'item-free').length).toBe(first);
  });

  it('does not double-buy when the warm is still running as the first item is served', async () => {
    // warmSessionPlan is fire-and-forget, so the first served item routinely raced it.
    // Both passes saw the same cells as short and both generated them: a 10-slot plan
    // bought 20 items. cellsInFlight only covers batches, which are persisted;
    // synchronous fills needed their own in-process reservation.
    const { db, userId, conceptId } = makeFixture(6);
    const { handle, handler } = makeFakeLlm();

    // Latency is what opens the window; instant replies hide the race entirely.
    setTransport(async (req) => {
      await new Promise((r) => setTimeout(r, 40));
      return handler(req);
    });

    const started = startSession(db, userId, conceptId, { length: 10 });
    const plan = listSessionPlan(db, started.sessionId);
    expect(plan.length).toBe(10);

    // Ask for the first item while the warm is mid-flight, then let everything settle.
    await nextItem(db, started.sessionId);
    for (let quiet = 0; quiet < 12; quiet++) {
      const before = handle.calls.length;
      await new Promise((r) => setTimeout(r, 120));
      if (handle.calls.length === before) break;
    }

    const persisted = (
      db.prepare(`SELECT COUNT(*) AS n FROM items WHERE validated = 1`).get() as { n: number }
    ).n;

    // Ten slots need ten items. One extra is allowed: the inline path serves a waiting
    // user and must not block on someone else's in-flight generation, and that item is
    // banked rather than wasted. Twice the plan is the failure being guarded against.
    expect(persisted).toBeGreaterThanOrEqual(10);
    expect(persisted).toBeLessThanOrEqual(plan.length + 1);
    expect(cellsGenerating().size).toBe(0);
  });

  it('generates nothing at all during a benchmark run', async () => {
    // A benchmark plan pins every slot to a frozen, human-vetted item, and frozen
    // items are deliberately not counted as ready (invariant 10). The buffer therefore
    // read every benchmark slot as empty and generated a practice item for it — items
    // that run would never serve. Pure waste, on every benchmark.
    const { db, userId, conceptId, nodeIds } = makeFixture(3);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cells = listCells(db, userId, conceptId).filter((c) => c.depth <= 5);
    // Three frozen, vetted items — the benchmark set.
    for (const cell of cells.slice(0, 3)) {
      const info = db
        .prepare(
          `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated, frozen)
           VALUES (?, 'mc', ?, '', '2026-01-01T00:00:00.000Z', 1, 1)`
        )
        .run(cell.id, `frozen stem for cell ${cell.id}`);
      const itemId = Number(info.lastInsertRowid);
      for (let p = 1; p <= 4; p++) {
        db.prepare(
          `INSERT INTO options (item_id, position, text, is_correct, misconception_id, rationale)
           VALUES (?, ?, ?, ?, NULL, '')`
        ).run(itemId, p, `option ${p}`, p === 1 ? 1 : 0);
      }
    }

    const run = startBenchmarkRun(db, userId, conceptId);
    expect(run.itemCount).toBe(3);
    const before = handle.calls.length;

    // Serve the whole benchmark.
    for (let i = 0; i < run.itemCount; i++) {
      const res = await nextItem(db, run.sessionId);
      expect(res.item, `benchmark slot ${i + 1} should serve a frozen item`).not.toBeNull();
    }
    for (let quiet = 0; quiet < 8; quiet++) {
      const n = handle.calls.length;
      await new Promise((r) => setTimeout(r, 60));
      if (handle.calls.length === n) break;
    }

    expect(handle.calls.length - before).toBe(0);
  });

  it('covers a cell even when a batch for it is pending, because a batch is minutes away', async () => {
    // The inverse of what this test used to assert, and the reason question two kept
    // being slow. The worker puts the plausibly-due cells into a batch every tick, and
    // those are the cells a session plans — so treating a pending batch as coverage
    // left the warm doing nothing and every early item generated inline.
    //
    // A duplicate item costs cents and lands in the buffer for next time. A session
    // that makes the learner wait on every question costs the product.
    const { db, userId, conceptId, nodeIds } = makeFixture(2);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    db.prepare(
      `INSERT INTO gen_batches (provider_batch_id, phase, payload, created_at)
       VALUES ('b1', 'generate', ?, '2026-01-01T00:00:00.000Z')`
    ).run(
      JSON.stringify({
        cells: [{ customId: `cell-${cell.id}`, cellId: cell.id, want: 5, model: 'm', depth: 1 }],
      })
    );

    const report = await fillSessionNeed(db, userId, conceptId, [cell.id], { concurrency: 1 });

    expect(report.generated).toBe(1);
    expect(handle.calls.filter((c) => c.kind === 'item-mc')).toHaveLength(1);
  });

  it('skips a cell another synchronous pass is already writing', async () => {
    // A synchronous generation lands in seconds, and nextItem can await it — so this
    // one really is coverage, and generating again would buy the same items twice.
    const { db, userId, conceptId, nodeIds } = makeFixture(2);
    const { handle, handler } = makeFakeLlm();
    setTransport(async (req) => {
      await new Promise((r) => setTimeout(r, 25));
      return handler(req);
    });

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    // Two overlapping fills, the second started without awaiting the first.
    const [a, b] = await Promise.all([
      fillSessionNeed(db, userId, conceptId, [cell.id], { concurrency: 1 }),
      fillSessionNeed(db, userId, conceptId, [cell.id], { concurrency: 1 }),
    ]);

    expect(a.generated + b.generated).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(handle.calls.filter((c) => c.kind === 'item-mc')).toHaveLength(1);
  });
});

describe('the low-water mark', () => {
  it('always leaves a refill worth batching, at every target', () => {
    // A cell of 10 refills once 6 have been used, asking for 6 in one call.
    expect(refillThreshold(10)).toBe(4);
    expect(refillThreshold(8)).toBe(4);
    expect(refillThreshold(6)).toBe(3);

    // The rule that matters, and the one the first version got wrong: a refill must
    // never ask for fewer than two items. At a target of 3, plain 40% gives 2 — which
    // is target-1, so "at the mark" and "one below target" collapse into the same
    // condition and the hysteresis does nothing at all.
    expect(refillThreshold(3)).toBe(1);
    expect(refillThreshold(2)).toBe(0);
    // A target of 1 can hold no slack: refill only when empty.
    expect(refillThreshold(1)).toBe(0);

    for (const target of [1, 2, 3, 4, 5, 6, 8, 10]) {
      const asksFor = target - refillThreshold(target);
      expect(asksFor, `target ${target} would refill ${asksFor} at a time`).toBeGreaterThanOrEqual(
        Math.min(2, target)
      );
    }
  });

  it('does nothing on a cell still above the mark, at the shipped default target', async () => {
    // The regression the old test missed by only ever exercising target 10.
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;
    const gens = () => handle.calls.filter((c) => c.kind === 'item-mc').length;
    const fill = () =>
      topUpBuffer(db, [userId], conceptId, { priorityCellIds: [cell.id], concurrency: 1 });

    await fill();
    expect(gens()).toBe(1);

    // Serve one of three. Two remain, above the mark of 1 — no refill.
    serveItems(db, userId, cell.id, 1);
    await fill();
    expect(gens()).toBe(1);

    // Serve a second. One remains, at the mark — one refill, asking for two.
    serveItems(db, userId, cell.id, 1);
    await fill();
    expect(gens()).toBe(2);

    const asked = /<how_many>(\d+)<\/how_many>/.exec(
      String(
        (handle.calls.filter((c) => c.kind === 'item-mc')[1].request.messages as {
          content: string;
        }[])[0].content
      )
    )?.[1];
    expect(asked).toBe('2');
  });

  it('takes an absolute override, clamped below the target', () => {
    process.env.GYM_BUFFER_REFILL_AT = '2';
    expect(refillThreshold(10)).toBe(2);

    // 0 is meaningful: refill only when the cell runs dry.
    process.env.GYM_BUFFER_REFILL_AT = '0';
    expect(refillThreshold(10)).toBe(0);

    // A value at or above the target would mean "always short".
    process.env.GYM_BUFFER_REFILL_AT = '99';
    expect(refillThreshold(10)).toBe(9);
  });

  it('leaves a partly-drained cell alone, then refills it in one call', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;
    const fill = () =>
      topUpBuffer(db, [userId], conceptId, {
        priorityCellIds: [cell.id],
        target: 10,
        maxGenerations: 10,
        concurrency: 1,
      });
    const genCalls = () => handle.calls.filter((c) => c.kind === 'item-mc').length;
    const serve = (n: number) => serveItems(db, userId, cell.id, n);

    await fill();
    expect(genCalls()).toBe(1);

    // Five served leaves 5 remaining, above the mark of 4 — no call at all. This is
    // the regression that matters: without hysteresis each of these was a 1-item
    // call, paying the cell's reasoning cost five times over.
    serve(5);
    await fill();
    expect(genCalls()).toBe(1);

    // The sixth takes it to 4, at the mark: one call, back to the full target.
    serve(1);
    await fill();
    expect(genCalls()).toBe(2);

    const asked = /<how_many>(\d+)<\/how_many>/.exec(
      String(
        (handle.calls.filter((c) => c.kind === 'item-mc')[1].request.messages as {
          content: string;
        }[])[0].content
      )
    )?.[1];
    expect(asked).toBe('6');

    const ready = db
      .prepare(unseenSql)
      .get(cell.id, userId) as { n: number };
    expect(ready.n).toBe(10);
  });

  it('refills an empty cell regardless of the mark', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    process.env.GYM_BUFFER_REFILL_AT = '0';
    await topUpBuffer(db, [userId], conceptId, {
      priorityCellIds: [cell.id],
      target: 5,
      maxGenerations: 5,
      concurrency: 1,
    });
    expect(handle.calls.filter((c) => c.kind === 'item-mc')).toHaveLength(1);
  });
});

describe('failure reporting', () => {
  it('names the reasons rather than just the attempt count', () => {
    const msg = summarizeFailure(3, [
      { reasons: ['validator chose option 2, key is option 4'] },
      { reasons: ['validator chose option 1, key is option 3'] },
      { reasons: ['flag: ambiguous'] },
    ]);

    // Position numbers are collapsed, so the same complaint counts as one thing
    // seen twice — that distinguishes a badly drawn node from an unlucky run.
    expect(msg).toContain('x2');
    expect(msg).toContain('key is option N');
    expect(msg).toContain('flag: ambiguous');
    expect(msg).toContain('3 attempts');
  });

  it('says so plainly when nothing was recorded', () => {
    expect(summarizeFailure(3, [])).toMatch(/no recorded reason/);
  });

  it('surfaces through the outcome when every candidate is rejected', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    // A validator that always disagrees with the key rejects everything.
    const { handler } = makeFakeLlm({ validatorPicks: 'wrong' });
    setTransport(handler);

    const cell = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    const outcome = await generateItemsForCell(db, cell.id, 2);
    expect(outcome.items).toHaveLength(0);
    // The message a user actually sees must name the cause.
    expect(outcome.error).toMatch(/key is option N/);
    expect(outcome.error).not.toBe('generation failed after 3 attempts');
  });
});

describe('the concurrency dial', () => {
  it('defaults to 4, is configurable, and is clamped', () => {
    expect(bufferConcurrency()).toBe(4);

    process.env.GYM_BUFFER_CONCURRENCY = '8';
    expect(bufferConcurrency()).toBe(8);

    // Past the cap the account's rate limit is the bottleneck, not the event loop.
    process.env.GYM_BUFFER_CONCURRENCY = '500';
    expect(bufferConcurrency()).toBe(12);

    for (const bad of ['0', '-2', 'lots', '']) {
      process.env.GYM_BUFFER_CONCURRENCY = bad;
      expect(bufferConcurrency()).toBe(4);
    }
  });
});

describe('topUpBuffer', () => {
  it('keeps more than one generation in flight, up to the limit it was given', async () => {
    const { db, userId, conceptId } = makeFixture(6);
    const { handler } = makeFakeLlm();

    let inFlight = 0;
    let peak = 0;
    setTransport(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield, so a serial implementation cannot pass by finishing instantly.
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await handler(req);
      } finally {
        inFlight--;
      }
    });

    const report = await topUpBuffer(db, [userId], conceptId, { maxGenerations: 6, concurrency: 3 });

    expect(report.generated).toBeGreaterThan(1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('is serial when told to be', async () => {
    const { db, userId, conceptId } = makeFixture(4);
    const { handler } = makeFakeLlm();

    let inFlight = 0;
    let peak = 0;
    setTransport(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await handler(req);
      } finally {
        inFlight--;
      }
    });

    await topUpBuffer(db, [userId], conceptId, { maxGenerations: 3, concurrency: 1 });
    expect(peak).toBe(1);
  });

  it('does not let one failing cell abort the rest of the batch', async () => {
    const { db, userId, conceptId } = makeFixture(4);
    const { handler } = makeFakeLlm();

    let seen = 0;
    setTransport(async (req) => {
      seen++;
      if (seen === 1) throw new Error('transport exploded');
      return handler(req);
    });

    const report = await topUpBuffer(db, [userId], conceptId, { maxGenerations: 4, concurrency: 2 });

    expect(report.failed).toBeGreaterThan(0);
    expect(report.generated).toBeGreaterThan(0);
  });

  it('fills a priority cell before anything the default ordering would have picked', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(6);
    const { handler } = makeFakeLlm();
    setTransport(handler);

    // A cell from the last node — low in the default plausibly-due ordering.
    const target = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[5] && c.depth === 1
    )!;

    await topUpBuffer(db, [userId], conceptId, {
      maxGenerations: 2,
      concurrency: 1,
      priorityCellIds: [target.id],
    });

    const first = db.prepare(`SELECT cell_id FROM items ORDER BY id ASC LIMIT 1`).get() as
      | { cell_id: number }
      | undefined;

    expect(first?.cell_id).toBe(target.id);
  });

  it('fills a cell to its target in ONE generation call, not one per item', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const target = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await topUpBuffer(db, [userId], conceptId, {
      priorityCellIds: [target.id],
      target: 3,
      maxGenerations: 3,
      concurrency: 1,
    });

    const generations = handle.calls.filter((c) => c.kind === 'item-mc');
    const validations = handle.calls.filter((c) => c.kind === 'validate');

    // This is the whole economic argument: the reasoning about a cell is paid once
    // however many items come out of it. If this ever reads 3, the amortization is
    // gone and item cost has roughly doubled.
    expect(generations).toHaveLength(1);

    // Validation, by contrast, must NOT amortize — every item gets its own blind
    // solve, by a call that has seen no other item. That is invariant 3.
    expect(validations).toHaveLength(3);

    const stored = db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND validated = 1`)
      .get(target.id) as { n: number };
    expect(stored.n).toBe(3);
  });

  it('asks for exactly the shortfall, not the whole target', async () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const target = listCells(db, userId, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await topUpBuffer(db, [userId], conceptId, {
      priorityCellIds: [target.id],
      target: 2,
      maxGenerations: 2,
      concurrency: 1,
    });
    const firstRound = handle.calls.filter((c) => c.kind === 'item-mc').length;

    // Two are banked against a target of 4, whose mark is 2 — so the cell is at the
    // mark and refills by exactly its shortfall, two, not the whole target.
    await topUpBuffer(db, [userId], conceptId, {
      priorityCellIds: [target.id],
      target: 4,
      maxGenerations: 4,
      concurrency: 1,
    });

    const asked = handle.calls
      .filter((c) => c.kind === 'item-mc')
      .slice(firstRound)
      .map((c) => /<how_many>(\d+)<\/how_many>/.exec(String((c.request.messages as { content: string }[])[0].content))?.[1]);

    expect(asked).toEqual(['2']);
  });

  it('generates nothing when every cell already holds the target', async () => {
    const { db, userId, conceptId } = makeFixture(3);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const report = await topUpBuffer(db, [userId], conceptId, { maxGenerations: 4, target: 0 });

    expect(report.generated).toBe(0);
    expect(report.skipped).toBeGreaterThan(0);
    expect(handle.generations).toBe(0);
  });
});
