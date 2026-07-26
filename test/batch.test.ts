/**
 * The Batch API pipeline.
 *
 * The claim being protected: a batch-generated item is indistinguishable from a
 * synchronous one — same builders, same shape and similarity gates, one blind
 * validation per item — and is billed at half rate. If the batch path ever skipped a
 * gate to save a call, the discount would be paid for in quality, which is the one
 * currency this app does not spend.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeLlm } from './fakeLlm';
import { makeFixture } from './helpers';
import { setBatchTransport, batchingEnabled, type BatchRequest } from '../lib/llm/batch';
import {
  cellsInFlight,
  processBatches,
  submitGenerationBatch,
} from '../lib/pipeline/batchFill';
import { computeShortfalls } from '../lib/pipeline/buffer';
import { listCells } from '../lib/db/queries';
import { spendBy } from '../lib/cost';

afterEach(() => {
  setBatchTransport(null);
  delete process.env.GYM_BATCH;
});

/**
 * A fake batch service driven by the same fake model that serves the synchronous
 * tests. submit() stores the requests; poll() answers them all at once — a batch
 * that completes on first poll.
 */
function installFakeBatch(handler: (r: Record<string, unknown>) => Promise<string>) {
  const submitted = new Map<string, BatchRequest[]>();
  let n = 0;
  const log: { id: string; requests: BatchRequest[] }[] = [];

  setBatchTransport({
    async submit(requests) {
      const id = `fake-batch-${++n}`;
      submitted.set(id, requests);
      log.push({ id, requests });
      return id;
    },
    async poll(batchId) {
      const requests = submitted.get(batchId);
      if (!requests) throw new Error(`unknown batch ${batchId}`);
      return Promise.all(
        requests.map(async (r) => ({
          customId: r.customId,
          ok: true,
          text: await handler(r.request),
          usage: { inputTokens: 1000, outputTokens: 2000, cachedTokens: 0 },
          error: null,
        }))
      );
    },
  });

  return log;
}

describe('the batch pipeline', () => {
  it('is on by default when a transport exists, and GYM_BATCH=0 turns it off', () => {
    const { handler } = makeFakeLlm();
    installFakeBatch(handler);
    expect(batchingEnabled()).toBe(true);
    process.env.GYM_BATCH = '0';
    expect(batchingEnabled()).toBe(false);
  });

  it('fills a cell end to end: one generation request, one validation per item, items persisted', async () => {
    const { db, conceptId, nodeIds } = makeFixture(2);
    const { handler } = makeFakeLlm();
    const log = installFakeBatch(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await submitGenerationBatch(db, [{ cellId: cell.id, want: 3 }]);
    expect(cellsInFlight(db).has(cell.id)).toBe(true);

    // Tick 1: generation results come back, validation batch goes out.
    let progress = await processBatches(db);
    expect(progress.validationsSubmitted).toBe(3);
    expect(progress.itemsPersisted).toBe(0);
    // The cell stays in flight while its items await validation.
    expect(cellsInFlight(db).has(cell.id)).toBe(true);

    // Tick 2: validation results come back, items land.
    progress = await processBatches(db);
    expect(progress.itemsPersisted).toBe(3);
    expect(cellsInFlight(db).size).toBe(0);

    const stored = db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND validated = 1 AND retired = 0`
      )
      .get(cell.id) as { n: number };
    expect(stored.n).toBe(3);

    // The economics: exactly one generation request went over the wire for the
    // three items, and exactly three validations — amortized writing, unamortized gate.
    expect(log[0].requests).toHaveLength(1);
    expect(log[1].requests).toHaveLength(3);
  });

  it('bills every batch call at half rate in the accounting', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handler } = makeFakeLlm();
    installFakeBatch(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await submitGenerationBatch(db, [{ cellId: cell.id, want: 2 }]);
    await processBatches(db);
    await processBatches(db);

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE batch = 1`)
      .get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    const sync = db
      .prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE batch = 0`)
      .get() as { n: number };
    expect(sync.n).toBe(0);

    // Same tokens, half the estimate: verify through the public rollup.
    const spend = spendBy(db, 'kind');
    const item = spend.find((r) => r.key === 'item')!;
    // 1000 in + 2000 out on sonnet (D1 default) = .003 + .03 = .033, halved = .0165
    expect(item.estimatedUsd).toBeCloseTo(0.0165, 4);
  });

  it('a failed entry is dropped and the shortfall becomes visible again', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    const { handler } = makeFakeLlm();
    const log = installFakeBatch(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await submitGenerationBatch(db, [{ cellId: cell.id, want: 2 }]);

    // Sabotage the poll: the generation entry errors.
    setBatchTransport({
      async submit(requests) {
        log.push({ id: 'unused', requests });
        return 'unused';
      },
      async poll() {
        return [
          {
            customId: `cell-${cell.id}`,
            ok: false,
            text: null,
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            error: 'expired',
          },
        ];
      },
    });

    const progress = await processBatches(db);
    expect(progress.itemsPersisted).toBe(0);
    expect(progress.failed).toBe(2);

    // Nothing persisted, nothing in flight — the next shortfall pass resubmits.
    expect(cellsInFlight(db).size).toBe(0);
    const { short } = computeShortfalls(db, [cell.id], { target: 2, maxGenerations: 8 });
    expect(short).toEqual([{ cellId: cell.id, want: 2 }]);
  });

  it('the shortfall pass skips cells already in flight', async () => {
    const { db, conceptId, nodeIds } = makeFixture(2);
    const { handler } = makeFakeLlm();
    installFakeBatch(handler);

    const cells = listCells(db, conceptId).filter((c) => c.depth === 1);
    const first = cells.find((c) => c.node_id === nodeIds[0])!;
    const second = cells.find((c) => c.node_id === nodeIds[1])!;

    await submitGenerationBatch(db, [{ cellId: first.id, want: 3 }]);

    const { short } = computeShortfalls(db, [first.id, second.id], {
      target: 3,
      maxGenerations: 8,
      exclude: cellsInFlight(db),
    });
    expect(short.map((s) => s.cellId)).toEqual([second.id]);
  });

  it('a validator rejection in a batch is logged, not served', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    // The fake validator picks a different option than the key.
    const { handler } = makeFakeLlm({ validatorPicks: 'wrong' });
    installFakeBatch(handler);

    const cell = listCells(db, conceptId).find(
      (c) => c.node_id === nodeIds[0] && c.depth === 1
    )!;

    await submitGenerationBatch(db, [{ cellId: cell.id, want: 2 }]);
    await processBatches(db);
    const progress = await processBatches(db);

    expect(progress.itemsPersisted).toBe(0);
    expect(progress.failed).toBe(2);

    const servable = db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND validated = 1 AND retired = 0`
      )
      .get(cell.id) as { n: number };
    expect(servable.n).toBe(0);

    // The rejection trail survives — it feeds the per-node rejection rate.
    const rejected = db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE cell_id = ? AND retired = 1`)
      .get(cell.id) as { n: number };
    expect(rejected.n).toBe(2);
  });
});
