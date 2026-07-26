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
import { bufferConcurrency, topUpBuffer } from '../lib/pipeline/buffer';
import { listCells } from '../lib/db/queries';

afterEach(() => {
  setTransport(null);
  delete process.env.GYM_BUFFER_CONCURRENCY;
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
