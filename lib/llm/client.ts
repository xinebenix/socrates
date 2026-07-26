import Anthropic from '@anthropic-ai/sdk';
import { SchemaViolation, validateShape, wireSchema, type JsonSchema } from './schema';

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
 * Precedence: an explicit GYM_MODEL_<KIND> beats the strategy, and the strategy beats
 * GYM_MODEL. Depth chooses between a strategy's shallow and deep slots, and is
 * ignored once a kind has been named explicitly — someone who says
 * GYM_MODEL_ITEM=claude-opus-5 has said what they want at every depth.
 */
export function modelFor(
  kind: 'item' | 'blueprint' | 'validate' | 'grade',
  depth?: number
): string {
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
export function effortFor(kind: 'item' | 'blueprint' | 'validate' | 'grade'): Effort {
  const env = process.env[`GYM_EFFORT_${kind.toUpperCase()}`]?.trim().toLowerCase();
  if (env && (EFFORTS as string[]).includes(env)) return env as Effort;
  return kind === 'item' ? 'medium' : 'high';
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
    model: call.model ?? model(),
    max_tokens: call.maxTokens ?? 16000,
    system: call.system,
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

let usageSink: UsageSink | null = null;

export function setUsageSink(sink: UsageSink | null): void {
  usageSink = sink;
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
      usageSink?.({
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
