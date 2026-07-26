/**
 * Compare model-assignment strategies by cost.
 *
 *   npx tsx scripts/cost-model.ts                 # published token assumptions
 *   GYM_DB=./data/gym.db npx tsx scripts/cost-model.ts --measured
 *
 * Two things this is careful about.
 *
 * **It prefers your data.** With --measured it reads median token counts per call
 * site out of llm_usage instead of the assumptions below. The assumptions are a
 * starting point for someone with no history yet; after a day of real use they are
 * the wrong input and the script says so.
 *
 * **It separates what is known from what is guessed.** Prices come from lib/cost.ts
 * and will drift. Token counts are either measured (exact) or assumed (labelled).
 * Nothing here is a quote — it is arithmetic you can re-run when the inputs change.
 */

import { DEFAULT_PRICES, estimateUsd, priceFor } from '../lib/cost';
import { STRATEGIES, STRONG, type ModelStrategy } from '../lib/llm/client';

/* ------------------------------------------------------- token assumptions */

interface CallProfile {
  input: number;
  /** Includes reasoning tokens, which are billed at the output rate. */
  output: number;
}

/**
 * Rough shapes for a mid-sized concept with pasted source text. Reasoning tokens
 * dominate output on the high-effort calls, which is why effort is a cost dial.
 */
const ASSUMED: Record<string, CallProfile> = {
  blueprint: { input: 10_000, output: 12_000 },
  itemShallow: { input: 2_500, output: 3_000 },
  itemDeep: { input: 2_500, output: 4_500 },
  validate: { input: 1_200, output: 2_500 },
  grade: { input: 2_000, output: 2_500 },
};

/* ----------------------------------------------------------- usage profile */

/**
 * One month of moderate use. Change these to match your own habit — they are the
 * multiplier on everything below.
 */
const MONTH = {
  concepts: 2,
  blueprintsPerConcept: 1.5, // one draw plus the occasional regenerate-and-merge
  sessions: 20,
  itemsPerSession: 20,
  /** Share of served items at D1-D3 rather than D4-D6. Early on this is nearly all. */
  shallowShare: 0.75,
  /** D6 free-response items, which additionally incur a grading call. */
  gradedPerSession: 1,
  /**
   * Items generated per item served. The buffer writes ahead, and validator
   * rejections cost a full extra generate+validate pair.
   *   1.0  = perfectly matched buffer, no rejections
   *   1.4  = the shipped defaults with a normal rejection rate
   */
  generationMultiplier: 1.4,
};

/* ------------------------------------------------------------- strategies */

const OPUS5 = 'claude-opus-5';
const OPUS41 = 'claude-opus-4-1';
const SONNET5 = 'claude-sonnet-5';
const SONNET45 = 'claude-sonnet-4-5';

interface Strategy extends ModelStrategy {
  name: string;
  /** Whether GYM_STRATEGY can select it, or it needs GYM_MODEL_* variables. */
  selector: string;
  /** Where quality is genuinely at risk, in the author's judgement. */
  risk: string;
}

/** Resolve the STRONG sentinel against a nominated strong model. */
function resolve(s: ModelStrategy, strong: string): Omit<Strategy, 'name' | 'selector' | 'risk'> {
  const r = (v: string) => (v === STRONG ? strong : v);
  return {
    blueprint: r(s.blueprint),
    itemShallow: r(s.itemShallow),
    itemDeep: r(s.itemDeep),
    validateShallow: r(s.validateShallow),
    validateDeep: r(s.validateDeep),
    grade: r(s.grade),
    summary: s.summary,
  };
}

const RISKS: Record<string, string> = {
  reference: 'None. This is the baseline everything else is measured against.',
  shipped: 'Shallow items get blander. The gate catches broken, not boring.',
  'split-gate': 'Best cost per unit of regret, in my judgement. Deep items keep the strong gate.',
  'sonnet-gate': 'At D1-D3 the generator and validator become the same model — correlated blind spots.',
  economy: 'D1-D3 distractors get noticeably less sharp. Watch the rejection rate per node.',
  floor: 'Invariant 9 is at stake: a charitable grader turns a failed retrieval into a passed one.',
};

/**
 * The six selectable strategies, plus two that answer the "what about an older Opus"
 * question directly. The older-Opus variants are expressed as GYM_MODEL_* overrides
 * because they are a substitution on top of a strategy rather than a strategy.
 */
const TABLE: Strategy[] = [
  ...Object.entries(STRATEGIES).map(([name, s]) => ({
    name,
    selector: `GYM_STRATEGY=${name}`,
    risk: RISKS[name] ?? '',
    ...resolve(s, OPUS5),
  })),
  {
    name: 'older-gates',
    selector: `GYM_STRATEGY=shipped GYM_MODEL_VALIDATE=${OPUS41} GYM_MODEL_GRADE=${OPUS41}`,
    risk: 'Little quality risk — both are bounded tasks. Little cost benefit either; see the warning below.',
    ...resolve(STRATEGIES.shipped, OPUS5),
    validateShallow: OPUS41,
    validateDeep: OPUS41,
    grade: OPUS41,
    summary: 'Previous-generation frontier judgment on the two gate tasks.',
  },
  {
    name: 'older-everywhere',
    selector: `GYM_MODEL=${OPUS41} GYM_MODEL_ITEM=${SONNET45}`,
    risk: 'A weaker blueprint is the one error that compounds into every item ever generated.',
    blueprint: OPUS41,
    itemShallow: SONNET45,
    itemDeep: SONNET45,
    validateShallow: OPUS41,
    validateDeep: OPUS41,
    grade: OPUS41,
    summary: 'Previous generation throughout.',
  },
];

/* ------------------------------------------------------------- arithmetic */

function callCost(model: string, profile: CallProfile): number {
  return estimateUsd(model, profile.input, profile.output);
}

interface Costed {
  strategy: Strategy;
  perItemShallow: number;
  perItemDeep: number;
  perSession: number;
  perMonth: number;
  blueprintEach: number;
}

function cost(s: Strategy, profiles: Record<string, CallProfile>): Costed {
  const perItemShallow =
    callCost(s.itemShallow, profiles.itemShallow) + callCost(s.validateShallow, profiles.validate);
  const perItemDeep =
    callCost(s.itemDeep, profiles.itemDeep) + callCost(s.validateDeep, profiles.validate);

  const shallowPerSession = MONTH.itemsPerSession * MONTH.shallowShare;
  const deepPerSession = MONTH.itemsPerSession * (1 - MONTH.shallowShare);

  const served = shallowPerSession * perItemShallow + deepPerSession * perItemDeep;
  const grading = MONTH.gradedPerSession * callCost(s.grade, profiles.grade);
  const perSession = served * MONTH.generationMultiplier + grading;

  const blueprintEach = callCost(s.blueprint, profiles.blueprint);
  const perMonth =
    perSession * MONTH.sessions + blueprintEach * MONTH.concepts * MONTH.blueprintsPerConcept;

  return { strategy: s, perItemShallow, perItemDeep, perSession, perMonth, blueprintEach };
}

/* ------------------------------------------------------------------ output */

function usd(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

/** Trim the vendor prefix so the assignment lines stay readable. */
function short(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

async function measuredProfiles(): Promise<Record<string, CallProfile> | null> {
  const { getDb } = await import('../lib/db');
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT kind, call_site, input_tokens, output_tokens FROM llm_usage
        ORDER BY id DESC LIMIT 2000`
    )
    .all() as { kind: string; call_site: string; input_tokens: number; output_tokens: number }[];

  if (rows.length < 10) return null;

  const buckets: Record<string, { input: number[]; output: number[] }> = {};
  const put = (key: string, r: { input_tokens: number; output_tokens: number }) => {
    buckets[key] ??= { input: [], output: [] };
    buckets[key].input.push(r.input_tokens);
    buckets[key].output.push(r.output_tokens);
  };

  for (const r of rows) {
    if (r.kind === 'item') {
      // item-mc-d1 ... item-mc-d5, item-free-d6
      const depth = Number(r.call_site.match(/d(\d)/)?.[1] ?? 0);
      put(depth >= 4 ? 'itemDeep' : 'itemShallow', r);
    } else if (r.kind in ASSUMED || r.kind === 'validate' || r.kind === 'grade') {
      put(r.kind, r);
    }
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  const out: Record<string, CallProfile> = { ...ASSUMED };
  for (const [key, b] of Object.entries(buckets)) {
    if (b.input.length >= 3) out[key] = { input: median(b.input), output: median(b.output) };
  }
  return out;
}

async function main(): Promise<void> {
  const useMeasured = process.argv.includes('--measured');
  let profiles = ASSUMED;
  let source = 'ASSUMED token counts — no measurements used';

  if (useMeasured) {
    const m = await measuredProfiles();
    if (m) {
      profiles = m;
      source = 'MEASURED median token counts from llm_usage';
    } else {
      source = 'ASSUMED — not enough rows in llm_usage yet (need 10+ calls)';
    }
  }

  const costed = TABLE.map((s) => cost(s, profiles));
  const reference = costed[0].perMonth;

  console.log('');
  console.log('  Socrates — model strategy cost comparison');
  console.log('  ' + '='.repeat(96));
  console.log(`  Tokens:  ${source}`);
  console.log('  Prices:  lib/cost.ts DEFAULT_PRICES, USD per million tokens. ESTIMATES — verify.');
  console.log(
    `  Usage:   ${MONTH.sessions} sessions/mo x ${MONTH.itemsPerSession} items, ` +
      `${Math.round(MONTH.shallowShare * 100)}% shallow, x${MONTH.generationMultiplier} generated per served, ` +
      `${MONTH.concepts} concepts`
  );
  console.log('');

  console.log('  Token profile per call:');
  for (const [k, p] of Object.entries(profiles)) {
    console.log(
      `    ${pad(k, 14)} in ${padLeft(p.input.toLocaleString(), 8)}   out ${padLeft(p.output.toLocaleString(), 8)}`
    );
  }
  console.log('');

  console.log(
    '  ' +
      pad('Strategy', 17) +
      padLeft('item D1-3', 11) +
      padLeft('item D4-6', 11) +
      padLeft('/session', 11) +
      padLeft('/month', 11) +
      padLeft('vs ref', 9)
  );
  console.log('  ' + '-'.repeat(96));

  for (const c of costed) {
    const saving = reference > 0 ? (1 - c.perMonth / reference) * 100 : 0;
    console.log(
      '  ' +
        pad(c.strategy.name, 17) +
        padLeft(usd(c.perItemShallow), 11) +
        padLeft(usd(c.perItemDeep), 11) +
        padLeft(usd(c.perSession), 11) +
        padLeft(usd(c.perMonth), 11) +
        padLeft(saving < 0.05 ? '—' : `-${saving.toFixed(0)}%`, 9)
    );
  }

  console.log('');
  console.log('  Notes');
  console.log('  ' + '-'.repeat(96));
  for (const c of costed) {
    console.log(`    ${c.strategy.name}`);
    console.log(`      ${c.strategy.summary}`);
    console.log(`      risk: ${c.strategy.risk}`);
    console.log(`      set:  ${c.strategy.selector}`);
    console.log(
      `      items ${short(c.strategy.itemShallow)} / ${short(c.strategy.itemDeep)}   ` +
        `gate ${short(c.strategy.validateShallow)} / ${short(c.strategy.validateDeep)}   ` +
        `blueprint ${short(c.strategy.blueprint)}   grade ${short(c.strategy.grade)}`
    );
    console.log('');
  }

  const opus5 = priceFor(OPUS5);
  const opus41 = priceFor(OPUS41);
  if (opus5.input === opus41.input && opus5.output === opus41.output) {
    console.log('  ' + '!'.repeat(96));
    console.log('  Opus 4.1 and Opus 5 carry the SAME price in this table, so "older Opus" saves');
    console.log('  nothing on cost. It may still be worth pinning for latency or availability, but');
    console.log('  if the goal is spend, a current Sonnet is 5x cheaper than either. Verify both');
    console.log('  prices against your billing page before planning around this.');
    console.log('  ' + '!'.repeat(96));
    console.log('');
  }

  console.log('  Price table used:');
  for (const [m, p] of Object.entries(DEFAULT_PRICES)) {
    console.log(`    ${pad(m, 30)} in $${padLeft(String(p.input), 6)}/M   out $${padLeft(String(p.output), 6)}/M`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
