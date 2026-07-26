/**
 * Token accounting.
 *
 * A cost meter that quietly under-reports is worse than no meter, because it gets
 * believed. The properties that matter: retries are counted (they are separately
 * billed), cached reads are not double-charged, an unknown model reads as unpriced
 * rather than free-looking, and the budget stops speculative work without ever
 * blocking a session.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICES,
  budgetStatus,
  estimateUsd,
  kindOf,
  prices,
  recordUsage,
  spendBy,
  speculativeGenerationAllowed,
  totalSpend,
} from '../lib/cost';
import { makeFixture } from './helpers';

afterEach(() => {
  delete process.env.GYM_PRICES;
  delete process.env.GYM_MONTHLY_BUDGET_USD;
});

function usage(input: number, output: number, cached = 0) {
  return { inputTokens: input, outputTokens: output, cachedTokens: cached };
}

describe('pricing', () => {
  it('charges input and output at their own rates', () => {
    // 1M input + 1M output on Opus at 15/75.
    expect(estimateUsd('claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(90, 6);
    expect(estimateUsd('claude-sonnet-5', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
  });

  it('does not bill a cached read twice', () => {
    const p = DEFAULT_PRICES['claude-opus-5'];
    // 1M input of which 1M was cached: cache rate only, not cache + fresh.
    const cached = estimateUsd('claude-opus-5', 1_000_000, 0, 1_000_000);
    expect(cached).toBeCloseTo(p.cachedInput, 6);
    expect(cached).toBeLessThan(estimateUsd('claude-opus-5', 1_000_000, 0));
  });

  it('treats an unknown model as unpriced rather than as free', () => {
    // Zero, but the model still appears in the breakdown, so a $0.00 line next to a
    // large token count is legible as "I do not have a price for this".
    expect(estimateUsd('some-future-model', 1_000_000, 1_000_000)).toBe(0);
  });

  it('takes an override and survives a malformed one', () => {
    process.env.GYM_PRICES = JSON.stringify({
      'claude-opus-5': { input: 1, output: 2, cachedInput: 0 },
    });
    expect(estimateUsd('claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(3, 6);
    // Models not mentioned keep their defaults.
    expect(prices()['claude-sonnet-5']).toEqual(DEFAULT_PRICES['claude-sonnet-5']);

    process.env.GYM_PRICES = 'not json{';
    expect(prices()).toEqual(DEFAULT_PRICES);
  });
});

describe('call-site attribution', () => {
  it('maps call names onto the four kinds', () => {
    expect(kindOf('item-mc-d3')).toBe('item');
    expect(kindOf('item-free-d6')).toBe('item');
    expect(kindOf('validate')).toBe('validate');
    expect(kindOf('grade-free')).toBe('grade');
    expect(kindOf('blueprint')).toBe('blueprint');
    expect(kindOf('something-else')).toBe('other');
  });

  it('rolls up per model before summing, so a mixed kind is priced correctly', () => {
    const { db } = makeFixture(1);

    // One item written by Sonnet, its validation done by Opus. Same 'kind' bucket?
    // No — different kinds, but both are per-item spend and priced per model.
    recordUsage(db, { name: 'item-mc-d1', model: 'claude-sonnet-5', usage: usage(1_000_000, 0), ms: 10 });
    recordUsage(db, { name: 'validate', model: 'claude-opus-5', usage: usage(1_000_000, 0), ms: 10 });

    const byKind = spendBy(db, 'kind');
    const item = byKind.find((r) => r.key === 'item')!;
    const validate = byKind.find((r) => r.key === 'validate')!;

    expect(item.estimatedUsd).toBeCloseTo(3, 6);
    expect(validate.estimatedUsd).toBeCloseTo(15, 6);
    expect(totalSpend(db).estimatedUsd).toBeCloseTo(18, 6);
  });

  it('counts every call, including schema retries', () => {
    const { db } = makeFixture(1);
    for (let i = 0; i < 3; i++) {
      recordUsage(db, { name: 'item-mc-d1', model: 'claude-sonnet-5', usage: usage(1000, 500), ms: 5 });
    }
    expect(totalSpend(db).calls).toBe(3);
  });

  it('reports zero rather than throwing when nothing has been spent', () => {
    const { db } = makeFixture(1);
    const total = totalSpend(db);
    expect(total.calls).toBe(0);
    expect(total.estimatedUsd).toBe(0);
    expect(spendBy(db, 'model')).toEqual([]);
  });
});

describe('the budget', () => {
  it('is absent unless configured', () => {
    const { db } = makeFixture(1);
    const status = budgetStatus(db);
    expect(status.limitUsd).toBeNull();
    expect(status.exceeded).toBe(false);
    expect(speculativeGenerationAllowed(db)).toBe(true);
  });

  it('trips once the month s estimate reaches the limit', () => {
    const { db } = makeFixture(1);
    process.env.GYM_MONTHLY_BUDGET_USD = '10';

    recordUsage(db, { name: 'blueprint', model: 'claude-opus-5', usage: usage(0, 100_000), ms: 10 });
    expect(budgetStatus(db).spentThisMonthUsd).toBeCloseTo(7.5, 4);
    expect(speculativeGenerationAllowed(db)).toBe(true);

    recordUsage(db, { name: 'blueprint', model: 'claude-opus-5', usage: usage(0, 100_000), ms: 10 });
    expect(budgetStatus(db).exceeded).toBe(true);
    expect(speculativeGenerationAllowed(db)).toBe(false);
    expect(budgetStatus(db).remainingUsd).toBe(0);
  });

  it('ignores a nonsensical limit rather than locking the app', () => {
    const { db } = makeFixture(1);
    for (const bad of ['0', '-5', 'lots', '']) {
      process.env.GYM_MONTHLY_BUDGET_USD = bad;
      expect(budgetStatus(db).limitUsd).toBeNull();
      expect(speculativeGenerationAllowed(db)).toBe(true);
    }
  });
});
