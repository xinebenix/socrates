import Anthropic from '@anthropic-ai/sdk';
import { SchemaViolation, validateShape, wireSchema, type JsonSchema } from './schema';
import { providerFor } from './providers';
import { callDeepSeek } from './deepseek';

export const DEFAULT_MODEL = 'claude-opus-5';
export const MAX_SCHEMA_RETRIES = 3;

export interface StructuredCall {
  /** Used only in error messages and logs. */
  name: string;
  system: string;
  user: string;
  schema: JsonSchema;
  maxTokens?: number;
  /** low | medium | high | xhigh | max. Generation and grading want thoroughness. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Overrides GYM_MODEL for this call site. See modelFor(). */
  model?: string;
}

export interface StructuredResult<T> {
  data: T;
  /** The exact request body that was sent. Acceptance test 3 asserts on this. */
  request: Record<string, unknown>;
  attempts: number;
}

export function model(): string {
  return process.env.GYM_MODEL ?? DEFAULT_MODEL;
}

/**
 * Resolves to whatever GYM_MODEL says, so a strategy can express "the strong one
 * here" without hardcoding which model that is.
 */
export const STRONG = '@strong';

export interface ModelStrategy {
  blueprint: string;
  itemShallow: string;
  itemDeep: string;
  validateShallow: string;
  validateDeep: string;
  grade: string;
  summary: string;
}

/**
 * Named model assignments.
 *
 * The six slots exist because these are six different jobs. The blueprint is the
 * hardest reasoning in the system and everything downstream inherits its errors. The
 * validator is the quality gate. The grader is invariant 9. Writing a D1 recall item
 * against a finished blueprint is not in that class.
 *
 * A less obvious reason the slots are split: generator and validator on the same
 * model share blind spots. An item whose flaw is invisible to Opus is invisible to an
 * Opus validator too, so the pairing matters as much as the individual choices.
 *
 * Pick one with GYM_STRATEGY. Individual GYM_MODEL_* variables still win over it, so
 * a strategy is a starting point rather than a cage. See scripts/cost-model.ts for
 * what each costs.
 */
export const STRATEGIES: Record<string, ModelStrategy> = {
  /** Everything on the strong model. The original build, and the quality reference. */
  reference: {
    blueprint: STRONG,
    itemShallow: STRONG,
    itemDeep: STRONG,
    validateShallow: STRONG,
    validateDeep: STRONG,
    grade: STRONG,
    summary: 'Everything Opus. The quality bar, and the price of it.',
  },

  /** The default. Shallow item writing is the only thing moved off the strong model. */
  shipped: {
    blueprint: STRONG,
    itemShallow: 'claude-sonnet-5',
    itemDeep: STRONG,
    validateShallow: STRONG,
    validateDeep: STRONG,
    grade: STRONG,
    summary: 'D1-D3 items on Sonnet. Every gate still Opus.',
  },

  /**
   * Cheapest change I would make without hesitating. The validator runs on every
   * item and is the largest single line; Sonnet solving a D1-D3 multiple-choice item
   * is well within its range, and the deep items — where a missed flaw is expensive —
   * keep the strong gate.
   */
  'split-gate': {
    blueprint: STRONG,
    itemShallow: 'claude-sonnet-5',
    itemDeep: STRONG,
    validateShallow: 'claude-sonnet-5',
    validateDeep: STRONG,
    grade: STRONG,
    summary: 'Sonnet validates shallow items, Opus validates deep ones.',
  },

  /**
   * Sonnet gates everything. Note that at D1-D3 the generator and validator are then
   * the same model — the agreement check gets weaker exactly where it is cheapest to
   * be wrong, which is the trade being made.
   */
  'sonnet-gate': {
    blueprint: STRONG,
    itemShallow: 'claude-sonnet-5',
    itemDeep: STRONG,
    validateShallow: 'claude-sonnet-5',
    validateDeep: 'claude-sonnet-5',
    grade: STRONG,
    summary: 'Sonnet validates everything. Correlated blind spots at D1-D3.',
  },

  /** Haiku writes the shallow end. Watch the rejection rate on the item-health screen. */
  economy: {
    blueprint: STRONG,
    itemShallow: 'claude-haiku-4-5-20251001',
    itemDeep: 'claude-sonnet-5',
    validateShallow: 'claude-sonnet-5',
    validateDeep: 'claude-sonnet-5',
    grade: STRONG,
    summary: 'Haiku writes D1-D3, Sonnet writes D4-D6 and gates. Opus keeps blueprint and grading.',
  },

  /**
   * The floor. Opus draws the blueprint once and touches nothing else — including
   * the grader, which is invariant 9 and the one I would put back first.
   */
  floor: {
    blueprint: STRONG,
    itemShallow: 'claude-haiku-4-5-20251001',
    itemDeep: 'claude-sonnet-5',
    validateShallow: 'claude-sonnet-5',
    validateDeep: 'claude-sonnet-5',
    grade: 'claude-sonnet-5',
    summary: 'Opus draws the blueprint. Nothing else touches it, grader included.',
  },
};

export const DEFAULT_STRATEGY = 'shipped';

/* -------------------------------------------------------------------- pin */

/**
 * The lab pin: one model, every call site, decided at runtime.
 *
 * Everything else here is configuration — read from the environment, fixed for the
 * life of the process, and changed by a redeploy. That is the right shape for a
 * setting you have decided on and the wrong shape entirely for a comparison you are
 * in the middle of running. Trying a different model against a real concept means
 * flipping it, generating a few items, looking at them, and flipping it back.
 *
 * So the pin is stored in the database (see lib/lab.ts) rather than the environment:
 * it survives a restart, and the standalone worker — a separate process that never
 * sees the server's memory — picks it up on its next tick.
 *
 * It is read through an injected source for the same reason the usage sink is. This
 * module is used from scripts and tests that have no database, and it must not import
 * one. The server installs the source in instrumentation.ts, the worker in
 * workers/pregenerate.ts, and anything that installs nothing routes normally.
 *
 * Precedence: the pin beats the strategy, the depth rule and every GYM_MODEL_*
 * variable. A test switch that a stale environment variable could silently defeat
 * would be worse than no switch, because you would be reading the wrong model's work
 * and calling it DeepSeek's. Because it wins so completely, it is also reported —
 * /api/health, the lab screen, and a badge in the nav bar that only exists while the
 * pin is set.
 */
export type ModelPinSource = () => string | null;

/**
 * Injected state lives on globalThis, not in module scope.
 *
 * This is not a style choice, it is a Next constraint discovered the hard way. The
 * instrumentation hook and the route handlers are compiled into separate bundles, and
 * a module imported by both is instantiated once *per bundle*. Anything installed at
 * startup is therefore invisible to the route that later makes the call — and
 * invisible in the worst way, with no error and no missing import, just a variable
 * that is null in the copy doing the work. The same split is why /api/health reports
 * the in-process worker as stopped while it is demonstrably running.
 *
 * `Symbol.for` keys a registry that is per-process rather than per-bundle, which is
 * the scope both of these were always meant to have. The worker process and the tests
 * are unaffected — there is only one bundle there, and this behaves exactly as a
 * module-level variable did.
 */
const REGISTRY = Symbol.for('socrates.llm.injected');

interface Injected {
  usageSink: UsageSink | null;
  modelPinSource: ModelPinSource | null;
}

function injected(): Injected {
  const store = globalThis as unknown as Record<symbol, Injected | undefined>;
  return (store[REGISTRY] ??= { usageSink: null, modelPinSource: null });
}

export function setModelPinSource(source: ModelPinSource | null): void {
  injected().modelPinSource = source;
}

export function activePin(): string | null {
  const source = injected().modelPinSource;
  if (!source) return null;
  try {
    const pinned = source()?.trim();
    return pinned ? pinned : null;
  } catch {
    // A pin that cannot be read is not a reason to fail a generation. Route normally.
    return null;
  }
}

export function strategyName(): string {
  const raw = process.env.GYM_STRATEGY?.trim().toLowerCase();
  return raw && raw in STRATEGIES ? raw : DEFAULT_STRATEGY;
}

export function activeStrategy(): ModelStrategy {
  return STRATEGIES[strategyName()];
}

/**
 * The depth at and above which item writing and validation escalate.
 *
 * D1-D3 are recall, comprehension and application: given a well-drawn node and a
 * source excerpt, writing those is a constrained task. D4 and D5 are boundary and
 * discrimination — the whole point of them is that the distractors are nearly right,
 * which is exactly the judgment a smaller model is worst at. D6 is critique.
 */
export const STRONG_FROM_DEPTH = 4;

/** Item writing at the shallow depths under the default strategy. */
export const DEFAULT_ITEM_MODEL = STRATEGIES[DEFAULT_STRATEGY].itemShallow;

/**
 * Which model runs which call.
 *
 * Precedence: the lab pin beats everything, an explicit GYM_MODEL_<KIND> beats the
 * strategy, and the strategy beats GYM_MODEL. Depth chooses between a strategy's
 * shallow and deep slots, and is ignored once a kind has been named explicitly —
 * someone who says GYM_MODEL_ITEM=claude-opus-5 has said what they want at every depth.
 */
export function modelFor(
  kind: 'item' | 'blueprint' | 'validate' | 'grade',
  depth?: number
): string {
  const pinned = activePin();
  if (pinned) return pinned;

  const explicit = process.env[`GYM_MODEL_${kind.toUpperCase()}`]?.trim();
  if (explicit) return explicit;

  const s = activeStrategy();
  const deep = depth === undefined || depth >= STRONG_FROM_DEPTH;

  const slot =
    kind === 'item'
      ? deep
        ? s.itemDeep
        : s.itemShallow
      : kind === 'validate'
        ? deep
          ? s.validateDeep
          : s.validateShallow
        : kind === 'blueprint'
          ? s.blueprint
          : s.grade;

  return slot === STRONG ? model() : slot;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Reasoning effort per call site, overridable per call site.
 *
 * These are the latency dial, and they are not all worth the same. Item generation
 * happens constantly and is what the wait in a session is made of. The blueprint runs
 * once per concept but everything downstream inherits its errors. Validation is the
 * gate on item quality, and a weaker validator is *worse* for latency as well as
 * quality — it disagrees with sound items and triggers regeneration. Grading is
 * invariant 9, where charity is the failure mode.
 *
 * So the defaults spend where a mistake is expensive and economise where it is not.
 *
 *   GYM_EFFORT_ITEM       default medium
 *   GYM_EFFORT_BLUEPRINT  default high
 *   GYM_EFFORT_VALIDATE   default high
 *   GYM_EFFORT_GRADE      default high
 */
export function effortFor(
  kind: 'item' | 'blueprint' | 'validate' | 'grade',
  depth?: number
): Effort {
  const env = process.env[`GYM_EFFORT_${kind.toUpperCase()}`]?.trim().toLowerCase();
  if (env && (EFFORTS as string[]).includes(env)) return env as Effort;
  if (kind === 'item') return 'medium';
  // The validator's output is almost entirely reasoning, so effort is its cost.
  // Solving a D1-D3 item that already survived the shape checks does not need
  // extended thinking; catching a subtly-wrong D4-D5 key does. The deep gate keeps
  // it. GYM_EFFORT_VALIDATE overrides both ends at once.
  if (kind === 'validate' && depth !== undefined && depth < STRONG_FROM_DEPTH) return 'low';
  return 'high';
}

/**
 * The serialized request body, built without touching the network.
 *
 * Keeping this pure is what lets acceptance test 3 assert that the validator's
 * payload contains no answer key. A test that had to mock the SDK could be fooled
 * by a field added somewhere else in the call path.
 */
export function buildRequest(call: StructuredCall): Record<string, unknown> {
  return {
    // The pin is applied here as well as in modelFor(), so it reaches the wire whatever
    // route the call took to get here — including a call site that named no model.
    model: activePin() ?? call.model ?? model(),
    max_tokens: call.maxTokens ?? 16000,
    // The system prompt is byte-identical across every call to a given site, so it is
    // worth caching. This is a smaller win than it sounds — output tokens are ~90% of
    // the bill here — but it costs nothing and applies to every call.
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: call.user }],
    output_config: {
      effort: call.effort ?? 'high',
      format: { type: 'json_schema', schema: wireSchema(call.schema) },
    },
  };
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and fill it in.');
    }
    client = new Anthropic();
  }
  return client;
}

/** Tests inject a fake so the pipeline can be exercised without the network. */
export type Transport = (request: Record<string, unknown>) => Promise<string>;

let transport: Transport | null = null;

export function setTransport(t: Transport | null): void {
  transport = t;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

async function send(request: Record<string, unknown>): Promise<{ text: string; usage: Usage }> {
  if (transport) return { text: await transport(request), usage: NO_USAGE };

  // The one place that knows a request can go somewhere other than Anthropic. Every
  // layer above this holds the same canonical body whatever model it names; the
  // translation happens on the way out. See lib/llm/providers.ts.
  if (providerFor(String(request.model ?? '')) === 'deepseek') return callDeepSeek(request);

  // Streaming keeps a long generation from tripping the SDK's HTTP timeout.
  const stream = getClient().messages.stream(request as never);
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(
      `model declined the request (${message.stop_details?.category ?? 'unspecified'})`
    );
  }
  const text = message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new SchemaViolation(['response contained no text block']);
  }

  const u = message.usage;
  return {
    text: text.text,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      // Thinking tokens are billed as output, which is why effort is a cost dial and
      // not only a latency one.
      outputTokens: u?.output_tokens ?? 0,
      cachedTokens: u?.cache_read_input_tokens ?? 0,
    },
  };
}

/**
 * Where usage goes. The client cannot import the database directly — it is used from
 * scripts and tests that have none — so the recorder is injected at startup.
 */
export type UsageSink = (record: {
  name: string;
  model: string;
  usage: Usage;
  ms: number;
}) => void;

/**
 * Registered per process, not per bundle — see the note on the registry above. The
 * bug this fixes is quiet and expensive: every call made from a route handler, which
 * is blueprint generation, inline session fills and all grading, was billed by the
 * provider and recorded by nothing.
 */
export function setUsageSink(sink: UsageSink | null): void {
  injected().usageSink = sink;
}

/**
 * One structured call, retried on schema violation up to MAX_SCHEMA_RETRIES.
 * After that the generation is failed rather than a malformed item being served.
 */
export async function structured<T>(call: StructuredCall): Promise<StructuredResult<T>> {
  const request = buildRequest(call);
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SCHEMA_RETRIES; attempt++) {
    try {
      const startedAt = Date.now();
      const { text: raw, usage } = await send(request);

      // Recorded per attempt, not per call: a schema retry is a second billed call,
      // and hiding that would make the accounting flatter than the invoice.
      injected().usageSink?.({
        name: call.name,
        model: (request.model as string) ?? model(),
        usage,
        ms: Date.now() - startedAt,
      });

      const parsed = JSON.parse(raw) as unknown;
      const problems = validateShape(parsed, call.schema);
      if (problems.length > 0) throw new SchemaViolation(problems);
      return { data: parsed as T, request, attempts: attempt };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof SchemaViolation || err instanceof SyntaxError;
      if (!retryable) throw err;
      if (attempt === MAX_SCHEMA_RETRIES) break;
    }
  }

  throw new Error(
    `${call.name}: gave up after ${MAX_SCHEMA_RETRIES} attempts — ${String(
      lastError instanceof Error ? lastError.message : lastError
    )}`
  );
}
