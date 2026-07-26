/**
 * Token accounting and cost estimation.
 *
 * A learning tool you avoid opening because you are not sure what it costs is worth
 * nothing, so the running cost has to be visible rather than inferred from a monthly
 * invoice. Two rules make the numbers trustworthy:
 *
 *   - **Tokens are exact.** They come from the API response and are recorded per
 *     call, including schema retries, which are separately billed.
 *   - **Money is an estimate**, computed from a price table that ships with the app
 *     and will drift. It is always labelled as such, and GYM_PRICES overrides it.
 *
 * When the two disagree, believe the tokens and fix the prices.
 */

import type { Db } from './db';
import { iso, now } from './clock';

export interface Price {
  /** USD per million tokens. */
  input: number;
  output: number;
  cachedInput: number;
}

/**
 * Published list prices as of writing. These WILL go stale — they are a default so
 * the number is not blank, not a source of truth. Check them against your own
 * billing page, and override with GYM_PRICES if they are wrong.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-sonnet-5': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-fable-5': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cachedInput: 0.1 },

  // Previous generation. Listed so that pinning an older model still produces a
  // costed line rather than a $0.00 one. Note that Opus has historically held the
  // same list price across generations — an older Opus buys latency and availability,
  // not a discount. Verify before planning around it.
  'claude-opus-4-1': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-opus-4-20250514': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-sonnet-4-5': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cachedInput: 0.08 },
};

/** Used when a model is not in the table, so an unknown model reads as unpriced. */
export const UNKNOWN_PRICE: Price = { input: 0, output: 0, cachedInput: 0 };

/**
 * GYM_PRICES is JSON: {"claude-opus-5":{"input":15,"output":75,"cachedInput":1.5}}
 * A malformed value falls back to the defaults rather than failing a request.
 */
export function prices(): Record<string, Price> {
  const raw = process.env.GYM_PRICES?.trim();
  if (!raw) return DEFAULT_PRICES;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<Price>>;
    const merged: Record<string, Price> = { ...DEFAULT_PRICES };
    for (const [model, p] of Object.entries(parsed)) {
      merged[model] = {
        input: Number(p.input) || 0,
        output: Number(p.output) || 0,
        cachedInput: Number(p.cachedInput) || 0,
      };
    }
    return merged;
  } catch {
    return DEFAULT_PRICES;
  }
}

export function priceFor(model: string): Price {
  return prices()[model] ?? UNKNOWN_PRICE;
}

/** The Message Batches API bills every token at half the synchronous rate. */
export const BATCH_DISCOUNT = 0.5;

export function estimateUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  batch = false
): number {
  const p = priceFor(model);
  // Cached reads are billed at the cache rate and are not also billed as fresh input.
  const freshInput = Math.max(0, inputTokens - cachedTokens);
  const usd =
    (freshInput * p.input + outputTokens * p.output + cachedTokens * p.cachedInput) / 1_000_000;
  return batch ? usd * BATCH_DISCOUNT : usd;
}

/** blueprint | item | validate | grade, derived from the call name. */
export function kindOf(callName: string): string {
  if (callName.startsWith('item-')) return 'item';
  if (callName.startsWith('validate')) return 'validate';
  if (callName.startsWith('grade')) return 'grade';
  if (callName.startsWith('blueprint')) return 'blueprint';
  return 'other';
}

export function recordUsage(
  db: Db,
  record: {
    name: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
    ms: number;
    /** True when the call went through the Batch API and is billed at half rate. */
    batch?: boolean;
  }
): void {
  const at = iso(now());
  db.prepare(
    `INSERT INTO llm_usage (at, day, call_site, kind, model, input_tokens, output_tokens, cached_tokens, ms, batch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    at,
    at.slice(0, 10),
    record.name,
    kindOf(record.name),
    record.model,
    record.usage.inputTokens,
    record.usage.outputTokens,
    record.usage.cachedTokens,
    Math.round(record.ms),
    record.batch ? 1 : 0
  );
}

export interface SpendRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

function rollUp(
  rows: {
    key: string;
    model: string;
    batch: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
  }[]
): SpendRow[] {
  const byKey = new Map<string, SpendRow>();
  for (const r of rows) {
    const existing = byKey.get(r.key) ?? {
      key: r.key,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
    };
    existing.calls += r.calls;
    existing.inputTokens += r.input_tokens;
    existing.outputTokens += r.output_tokens;
    // Priced per model and per billing mode before rolling up, because one key can
    // span several models and mix batch with synchronous calls.
    existing.estimatedUsd += estimateUsd(
      r.model,
      r.input_tokens,
      r.output_tokens,
      r.cached_tokens,
      r.batch === 1
    );
    byKey.set(r.key, existing);
  }
  return [...byKey.values()]
    .map((r) => ({ ...r, estimatedUsd: round4(r.estimatedUsd) }))
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd);
}

/** Spend since `sinceDay` (inclusive, YYYY-MM-DD), grouped by the given column. */
export function spendBy(
  db: Db,
  column: 'kind' | 'model' | 'day',
  sinceDay?: string
): SpendRow[] {
  const where = sinceDay ? `WHERE day >= ?` : '';
  const rows = db
    .prepare(
      `SELECT ${column} AS key, model, batch,
              COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM llm_usage ${where}
        GROUP BY ${column}, model, batch`
    )
    .all(...(sinceDay ? [sinceDay] : [])) as Parameters<typeof rollUp>[0];
  return rollUp(rows);
}

export function totalSpend(db: Db, sinceDay?: string): SpendRow {
  const rows = spendBy(db, 'kind', sinceDay);
  return rows.reduce(
    (acc, r) => ({
      key: 'total',
      calls: acc.calls + r.calls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      estimatedUsd: round4(acc.estimatedUsd + r.estimatedUsd),
    }),
    { key: 'total', calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }
  );
}

/**
 * Batch versus synchronous spend, so "is the discount actually landing" is a question
 * with an answer rather than an opinion. If batchCalls is 0 after a day of use, the
 * batch path is not running whatever the config claims.
 */
export function billingSplit(
  db: Db,
  sinceDay?: string
): { batchCalls: number; syncCalls: number; batchUsd: number; syncUsd: number; batchShare: number } {
  const where = sinceDay ? `WHERE day >= ?` : '';
  const rows = db
    .prepare(
      `SELECT model, batch,
              COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cached_tokens) AS cached_tokens
         FROM llm_usage ${where}
        GROUP BY model, batch`
    )
    .all(...(sinceDay ? [sinceDay] : [])) as {
    model: string;
    batch: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
  }[];

  let batchCalls = 0;
  let syncCalls = 0;
  let batchUsd = 0;
  let syncUsd = 0;

  for (const r of rows) {
    const usd = estimateUsd(r.model, r.input_tokens, r.output_tokens, r.cached_tokens, r.batch === 1);
    if (r.batch === 1) {
      batchCalls += r.calls;
      batchUsd += usd;
    } else {
      syncCalls += r.calls;
      syncUsd += usd;
    }
  }

  const total = batchCalls + syncCalls;
  return {
    batchCalls,
    syncCalls,
    batchUsd: round4(batchUsd),
    syncUsd: round4(syncUsd),
    batchShare: total > 0 ? Math.round((batchCalls / total) * 100) / 100 : 0,
  };
}

export interface SpendSnapshot {
  /** True when nothing has been spent yet — the caller renders nothing. */
  empty: boolean;
  month: string;
  todayUsd: number;
  monthUsd: number;
  monthCalls: number;
  budget: BudgetStatus;
  aheadOfUse: { unservedItems: number; estimatedUsd: number };
  byKind: SpendRow[];
  billing: ReturnType<typeof billingSplit>;
}

/**
 * Everything the spend overlay shows, in one pass.
 *
 * Gathered server-side and handed to the client component as plain data — the
 * database never gets near the browser, and the overlay needs no fetch of its own.
 */
export function spendSnapshot(db: Db): SpendSnapshot {
  const budget = budgetStatus(db);
  const monthStart = `${budget.month}-01`;
  const month = totalSpend(db, monthStart);
  const ahead = unservedItemSpend(db);

  return {
    empty: month.calls === 0,
    month: budget.month,
    todayUsd: totalSpend(db, dayKey()).estimatedUsd,
    monthUsd: month.estimatedUsd,
    monthCalls: month.calls,
    budget,
    aheadOfUse: { unservedItems: ahead.unservedItems, estimatedUsd: ahead.estimatedUsd },
    byKind: spendBy(db, 'kind', monthStart),
    billing: billingSplit(db, monthStart),
  };
}

export function dayKey(offsetDays = 0): string {
  const d = new Date(now().getTime() + offsetDays * 86_400_000);
  return iso(d).slice(0, 10);
}

/**
 * What was spent generating items that have not been served yet.
 *
 * This is the number that decides whether the buffer settings are right. Buffered
 * items are not waste — they get served eventually — but they are money spent ahead
 * of use, and a lookahead set too wide turns a training tool into a subscription to
 * questions you will not see for a month.
 */
export function unservedItemSpend(db: Db): {
  unservedItems: number;
  estimatedUsd: number;
  note: string;
} {
  const unserved = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
        WHERE served_count = 0 AND retired = 0 AND frozen = 0 AND validated = 1`
    )
    .get() as { n: number };

  const served = db
    .prepare(`SELECT COUNT(*) AS n FROM items WHERE served_count > 0`)
    .get() as { n: number };

  // Per-item cost is not attributed at generation time, so this apportions the
  // measured item+validate spend across every item written. Approximate on purpose.
  const itemSpend = spendBy(db, 'kind').filter((r) => r.key === 'item' || r.key === 'validate');
  const total = itemSpend.reduce((sum, r) => sum + r.estimatedUsd, 0);
  const allItems = unserved.n + served.n;

  return {
    unservedItems: unserved.n,
    estimatedUsd: allItems > 0 ? round4((total / allItems) * unserved.n) : 0,
    note: 'Money already spent on items not yet served. Not waste — they will be served — but it is spend running ahead of use. Lower GYM_BUFFER_TARGET to shrink it.',
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/* ------------------------------------------------------------------ budget */

export interface BudgetStatus {
  limitUsd: number | null;
  spentThisMonthUsd: number;
  remainingUsd: number | null;
  /** True once the month's estimated spend has passed the limit. */
  exceeded: boolean;
  month: string;
}

export function monthlyBudgetUsd(): number | null {
  const raw = Number(process.env.GYM_MONTHLY_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function budgetStatus(db: Db): BudgetStatus {
  const month = iso(now()).slice(0, 7);
  const spent = totalSpend(db, `${month}-01`).estimatedUsd;
  const limit = monthlyBudgetUsd();

  return {
    limitUsd: limit,
    spentThisMonthUsd: spent,
    remainingUsd: limit === null ? null : round4(Math.max(0, limit - spent)),
    exceeded: limit !== null && spent >= limit,
    month,
  };
}

/**
 * Whether the background worker should keep pre-generating.
 *
 * The cap deliberately applies to speculative work only. Sitting down to train and
 * being told you are out of budget is how a tool gets abandoned; quietly not
 * generating three items ahead for a cell you may reach next week is not. So a
 * session over budget still runs — it just generates inline, one item at a time,
 * which is slower and much cheaper.
 *
 * The estimate is also only as good as the price table, which is another reason not
 * to let it block the interactive path.
 */
export function speculativeGenerationAllowed(db: Db): boolean {
  return !budgetStatus(db).exceeded;
}
