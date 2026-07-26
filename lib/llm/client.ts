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
    model: model(),
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

async function send(request: Record<string, unknown>): Promise<string> {
  if (transport) return transport(request);

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
  return text.text;
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
      const raw = await send(request);
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
