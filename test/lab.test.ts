/**
 * The lab switch.
 *
 * A switch that overrides every routing decision in the app has to be right about
 * three things or it is worse than useless: it must actually win, it must be
 * impossible to leave the app in a state where spend cannot be estimated, and it must
 * be reversible without a restart. Those are what these pin down.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  isPinnable,
  itemsByModel,
  labPin,
  labStatus,
  pinnableModels,
  setLabPin,
  unpricedPinnableModels,
  writeSetting,
  LAB_PIN_KEY,
} from '../lib/lab';
import {
  buildRequest,
  modelFor,
  setModelPinSource,
  activePin,
  STRONG_FROM_DEPTH,
} from '../lib/llm/client';
import { batchingEnabled, setBatchTransport } from '../lib/llm/batch';
import { buildMcItemCall } from '../lib/prompts/itemMc';
import { estimateUsd, priceFor, spendBy } from '../lib/cost';
import { generateItemsForCell } from '../lib/pipeline/generateItem';
import { installFakeLlm } from './fakeLlm';
import { makeFixture } from './helpers';
import { newTestDb } from '../lib/db';
import { listCells } from '../lib/db/queries';

afterEach(() => {
  setModelPinSource(null);
  setBatchTransport(null);
  delete process.env.GYM_STRATEGY;
  delete process.env.GYM_MODEL;
  delete process.env.GYM_MODEL_ITEM;
  delete process.env.GYM_MODEL_GRADE;
  delete process.env.ANTHROPIC_API_KEY;
});

/** Installs the pin source the server and the worker install at startup. */
function pinFrom(db: ReturnType<typeof newTestDb>) {
  setModelPinSource(() => labPin(db));
}

describe('the pin', () => {
  it('is off until something sets it', () => {
    const db = newTestDb();
    pinFrom(db);
    expect(labPin(db)).toBeNull();
    expect(activePin()).toBeNull();
    expect(modelFor('blueprint')).toBe('claude-opus-5');
  });

  it('moves every call site at once, including the blueprint', () => {
    const db = newTestDb();
    pinFrom(db);
    setLabPin(db, 'deepseek-v4-pro');

    // Every named strategy protects the blueprint. The pin deliberately does not: a
    // comparison that left one call site behind would produce a number about nothing.
    expect(modelFor('blueprint')).toBe('deepseek-v4-pro');
    expect(modelFor('grade')).toBe('deepseek-v4-pro');
    for (const depth of [1, 3, STRONG_FROM_DEPTH, 6]) {
      expect(modelFor('item', depth)).toBe('deepseek-v4-pro');
      expect(modelFor('validate', depth)).toBe('deepseek-v4-pro');
    }
  });

  it('beats the strategy and the per-call-site variables', () => {
    const db = newTestDb();
    pinFrom(db);
    process.env.GYM_STRATEGY = 'economy';
    process.env.GYM_MODEL = 'claude-sonnet-5';
    process.env.GYM_MODEL_ITEM = 'claude-haiku-4-5-20251001';
    process.env.GYM_MODEL_GRADE = 'claude-opus-5';

    setLabPin(db, 'deepseek-v4-pro');
    expect(modelFor('item', 1)).toBe('deepseek-v4-pro');
    expect(modelFor('grade')).toBe('deepseek-v4-pro');

    // ...and stops beating them the moment it is cleared. No restart, no redeploy.
    setLabPin(db, null);
    expect(modelFor('item', 1)).toBe('claude-haiku-4-5-20251001');
    expect(modelFor('grade')).toBe('claude-opus-5');
  });

  it('reaches the wire, not just the router', () => {
    const db = newTestDb();
    pinFrom(db);
    setLabPin(db, 'deepseek-v4-pro');

    const request = buildRequest(
      buildMcItemCall({
        nodeTitle: 'Tokenization',
        nodeDescription: 'What the vocabulary layer does.',
        depthLevel: 1,
        sourceExcerpt: 'Tokens are subword units.',
        misconceptions: [],
        recentStems: [],
        activeMisconceptionLabels: [],
        deadDistractorNote: null,
      })
    );
    expect(request.model).toBe('deepseek-v4-pro');
  });

  it('survives the process that set it, because it lives in the database', () => {
    const db = newTestDb();
    setLabPin(db, 'deepseek-v4-flash');

    // A second reader — the standalone worker is exactly this — sees it with no
    // shared memory of any kind.
    setModelPinSource(() => labPin(db));
    expect(modelFor('item', 1)).toBe('deepseek-v4-flash');
  });

  it('routes normally when nothing has installed a source', () => {
    // Scripts and tests have no database. They must still be able to build a request.
    setModelPinSource(null);
    expect(activePin()).toBeNull();
    expect(modelFor('blueprint')).toBe('claude-opus-5');
  });

  it('does not let a failing read take a generation down with it', () => {
    setModelPinSource(() => {
      throw new Error('database is gone');
    });
    expect(activePin()).toBeNull();
    expect(modelFor('blueprint')).toBe('claude-opus-5');
  });
});

describe('what the switch will accept', () => {
  it('refuses a model that is not on the list', () => {
    const db = newTestDb();
    expect(isPinnable('deepseek-v4-pro')).toBe(true);
    expect(isPinnable('gpt-9')).toBe(false);
    expect(() => setLabPin(db, 'gpt-9')).toThrow(/not one of the models/);
    expect(labPin(db)).toBeNull();
  });

  it('ignores a stored value that has since left the list', () => {
    const db = newTestDb();
    // However it got there — an older build, a hand-edited row — an unpriced model
    // must not end up routing live traffic.
    writeSetting(db, LAB_PIN_KEY, 'claude-opus-3-retired');
    expect(labPin(db)).toBeNull();
  });

  it('can only offer models the price table knows', () => {
    // The guarantee behind the allowlist: while the switch is on, the spend readout
    // still means something. An unpriced model estimates $0.00 and says nothing.
    expect(unpricedPinnableModels()).toEqual([]);
    for (const m of pinnableModels()) {
      expect(priceFor(m.id).output, `${m.id} has no output price`).toBeGreaterThan(0);
    }
  });

  it('reports whether the credential for each model is actually present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const models = pinnableModels();
    const deepseek = models.find((m) => m.id === 'deepseek-v4-pro')!;
    const anthropic = models.find((m) => m.id === 'claude-opus-5')!;

    expect(anthropic.ready).toBe(true);
    // Pinning a model whose key is missing is a five-minute mystery. The screen says
    // so before the click rather than after the first failed generation.
    expect(deepseek.ready).toBe(false);
    expect(deepseek.keyVar).toBe('DEEPSEEK_API_KEY');
  });
});

describe('the pin and the batch discount', () => {
  it('turns batching off while the speculative path is routed off Anthropic', () => {
    const db = newTestDb();
    pinFrom(db);
    process.env.ANTHROPIC_API_KEY = 'sk-test';

    expect(batchingEnabled()).toBe(true);

    // A batch is submitted whole: one DeepSeek model id in the request list fails
    // every request in it. Losing the discount is the cheaper half of that trade.
    setLabPin(db, 'deepseek-v4-pro');
    expect(batchingEnabled()).toBe(false);

    setLabPin(db, null);
    expect(batchingEnabled()).toBe(true);
  });

  it('turns it off for an environment variable pointing off Anthropic too', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.GYM_MODEL_ITEM = 'deepseek-v4-flash';
    expect(batchingEnabled()).toBe(false);
  });
});

describe('attribution', () => {
  it('records which model wrote each item, and groups the bank by it', async () => {
    const { db, nodeIds } = makeFixture(1);
    pinFrom(db);
    installFakeLlm();

    const cells = listCells(db, nodeIds[0]);
    const shallow = cells.find((c) => c.depth === 1)!;
    await generateItemsForCell(db, shallow.id, 1);

    setLabPin(db, 'deepseek-v4-pro');
    const other = cells.find((c) => c.depth === 2)!;
    await generateItemsForCell(db, other.id, 1);

    const byModel = Object.fromEntries(itemsByModel(db).map((r) => [r.model, r.items]));
    // The shipped strategy writes D1-D3 on Sonnet; the pinned call went to DeepSeek.
    expect(byModel['claude-sonnet-5']).toBe(1);
    expect(byModel['deepseek-v4-pro']).toBe(1);
  });

  it('prices a DeepSeek call from the shipped table', () => {
    const db = newTestDb();
    // A typical generation: mostly output, which is where the difference lives.
    const deepseek = estimateUsd('deepseek-v4-pro', 4_000, 8_000, 0);
    const opus = estimateUsd('claude-opus-5', 4_000, 8_000, 0);

    expect(deepseek).toBeGreaterThan(0);
    expect(deepseek).toBeLessThan(opus / 50);
    expect(spendBy(db, 'model')).toEqual([]);
  });
});

describe('status', () => {
  it('shows what is routed where, pin included', () => {
    const db = newTestDb();
    pinFrom(db);
    setLabPin(db, 'deepseek-v4-pro');

    const status = labStatus(db);
    expect(status.pin).toBe('deepseek-v4-pro');
    expect(status.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.values(status.routing).every((m) => m === 'deepseek-v4-pro')).toBe(true);

    setLabPin(db, null);
    const off = labStatus(db);
    expect(off.pin).toBeNull();
    expect(off.since).toBeNull();
    expect(off.routing.blueprint).toBe('claude-opus-5');
    expect(off.routing.itemShallow).toBe('claude-sonnet-5');
  });
});
