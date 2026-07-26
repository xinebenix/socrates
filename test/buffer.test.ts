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
import { makeFixture } from './helpers';
import { setTransport } from '../lib/llm/client';
import {
  bufferConcurrency,
  bufferTarget,
  refillThreshold,
  topUpBuffer,
} from '../lib/pipeline/buffer';
import { generateItemsForCell, summarizeFailure } from '../lib/pipeline/generateItem';
import { MAX_ITEMS_PER_CALL } from '../lib/prompts/itemMc';
import { listCells } from '../lib/db/queries';

afterEach(() => {
  setTransport(null);
  delete process.env.GYM_BUFFER_CONCURRENCY;
  delete process.env.GYM_BUFFER_TARGET;
  delete process.env.GYM_BUFFER_REFILL_AT;
});

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
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await topUpBuffer(db, conceptId, {
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
    const { db, conceptId, nodeIds } = makeFixture(2);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    // Budget smaller than the target: the cell still goes in one call, because
    // clipping it would turn one cheap call into two expensive ones.
    await topUpBuffer(db, conceptId, {
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

describe('the low-water mark', () => {
  it('defaults to 40% of the target, and never reaches it', () => {
    // A cell of 10 refills once 6 have been used.
    expect(refillThreshold(10)).toBe(4);
    expect(refillThreshold(8)).toBe(4);
    expect(refillThreshold(3)).toBe(2);
    // A target of 1 can hold no slack: refill only when empty.
    expect(refillThreshold(1)).toBe(0);
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
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;
    const fill = () =>
      topUpBuffer(db, conceptId, {
        priorityCellIds: [cell.id],
        target: 10,
        maxGenerations: 10,
        concurrency: 1,
      });
    const genCalls = () => handle.calls.filter((c) => c.kind === 'item-mc').length;
    const serve = (n: number) =>
      db
        .prepare(
          `UPDATE items SET served_count = 1 WHERE id IN (
             SELECT id FROM items WHERE cell_id = ? AND served_count = 0 LIMIT ?)`
        )
        .run(cell.id, n);

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
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND served_count = 0`)
      .get(cell.id) as { n: number };
    expect(ready.n).toBe(10);
  });

  it('refills an empty cell regardless of the mark', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    process.env.GYM_BUFFER_REFILL_AT = '0';
    await topUpBuffer(db, conceptId, {
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
    const { db, conceptId, nodeIds } = makeFixture(1);
    // A validator that always disagrees with the key rejects everything.
    const { handler } = makeFakeLlm({ validatorPicks: 'wrong' });
    setTransport(handler);

    const cell = listCells(db, conceptId).find(
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
    const { db, conceptId } = makeFixture(6);
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

    const report = await topUpBuffer(db, conceptId, { maxGenerations: 6, concurrency: 3 });

    expect(report.generated).toBeGreaterThan(1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('is serial when told to be', async () => {
    const { db, conceptId } = makeFixture(4);
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

    await topUpBuffer(db, conceptId, { maxGenerations: 3, concurrency: 1 });
    expect(peak).toBe(1);
  });

  it('does not let one failing cell abort the rest of the batch', async () => {
    const { db, conceptId } = makeFixture(4);
    const { handler } = makeFakeLlm();

    let seen = 0;
    setTransport(async (req) => {
      seen++;
      if (seen === 1) throw new Error('transport exploded');
      return handler(req);
    });

    const report = await topUpBuffer(db, conceptId, { maxGenerations: 4, concurrency: 2 });

    expect(report.failed).toBeGreaterThan(0);
    expect(report.generated).toBeGreaterThan(0);
  });

  it('fills a priority cell before anything the default ordering would have picked', async () => {
    const { db, conceptId, nodeIds } = makeFixture(6);
    const { handler } = makeFakeLlm();
    setTransport(handler);

    // A cell from the last node — low in the default plausibly-due ordering.
    const target = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[5] && c.depth === 1
    )!;

    await topUpBuffer(db, conceptId, {
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
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const target = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await topUpBuffer(db, conceptId, {
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
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const target = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await topUpBuffer(db, conceptId, {
      priorityCellIds: [target.id],
      target: 2,
      maxGenerations: 2,
      concurrency: 1,
    });
    const firstRound = handle.calls.filter((c) => c.kind === 'item-mc').length;

    // Two are banked; asking for three should generate one, not three.
    await topUpBuffer(db, conceptId, {
      priorityCellIds: [target.id],
      target: 3,
      maxGenerations: 1,
      concurrency: 1,
    });

    const asked = handle.calls
      .filter((c) => c.kind === 'item-mc')
      .slice(firstRound)
      .map((c) => /<how_many>(\d+)<\/how_many>/.exec(String((c.request.messages as { content: string }[])[0].content))?.[1]);

    expect(asked).toEqual(['1']);
  });

  it('generates nothing when every cell already holds the target', async () => {
    const { db, conceptId } = makeFixture(3);
    const { handle, handler } = makeFakeLlm();
    setTransport(handler);

    const report = await topUpBuffer(db, conceptId, { maxGenerations: 4, target: 0 });

    expect(report.generated).toBe(0);
    expect(report.skipped).toBeGreaterThan(0);
    expect(handle.generations).toBe(0);
  });
});
