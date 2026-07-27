/**
 * The DeepSeek transport.
 *
 * DeepSeek serves an OpenAI-shaped chat-completions API, which is a different shape
 * from the one every call site in this app builds. Rather than teach the call sites
 * about providers, this module takes the canonical request `buildRequest()` produces
 * and translates it on the way out. One request object, one place that knows about
 * wire formats, and nothing upstream has to care where a call is going.
 *
 * Four things do not survive the translation intact, and each is a deliberate choice:
 *
 *   - **The JSON schema.** DeepSeek's dependable structured-output mode is
 *     `json_object`, which guarantees syntactically valid JSON and nothing about its
 *     shape. So the schema goes into the system prompt as an instruction, and the
 *     shape is enforced where it already was: `validateShape()` in the caller, which
 *     retries up to MAX_SCHEMA_RETRIES and then fails the generation rather than
 *     serving a malformed item. That local check was never decorative — it is what
 *     makes a provider without strict schemas usable at all.
 *
 *   - **Effort.** DeepSeek's thinking mode has two levels, not five: low and medium
 *     are mapped to `high` server-side, and `xhigh` to `max`. The mapping is done here
 *     as well so the request states what will actually happen. The consequence is
 *     worth knowing before reading a bill: the item hot path runs at `medium` on
 *     Anthropic and effectively `high` here.
 *
 *   - **Cache control.** Anthropic caches what you mark; DeepSeek caches prefixes
 *     automatically and reports the hit in `prompt_cache_hit_tokens`. The marker is
 *     dropped and the accounting reads the hit count instead.
 *
 *   - **The token ceiling.** `max_tokens` on this API covers reasoning as well as the
 *     answer, so a 16k ceiling at high effort can be spent thinking and truncate the
 *     JSON — which loses a whole generation set, not one item. The ceiling gets
 *     reasoning headroom added to it here.
 */

import { SchemaViolation, type JsonSchema } from './schema';
import type { Effort, Usage } from './client';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek's flagship. The SOTA model, and what the lab switch pins by default. */
export const DEEPSEEK_SOTA = 'deepseek-v4-pro';
/** The cheap end of the same family, for when the question is price rather than ceiling. */
export const DEEPSEEK_FAST = 'deepseek-v4-flash';

/**
 * Extra output budget for reasoning tokens, added to whatever the call site asked for.
 *
 * Thinking tokens are billed and counted as completion tokens, so they eat the same
 * ceiling the answer needs. The failure this prevents is silent and expensive: the
 * model reasons for 16k tokens, gets cut off mid-JSON, and the caller sees a syntax
 * error it will pay to retry twice more.
 */
export const REASONING_HEADROOM = 32_000;
export const MAX_OUTPUT_TOKENS = 64_000;

/** A single call may take a while at max effort; this only catches a hung connection. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Transient failures are the provider's, not the request's. Retried with backoff. */
const NETWORK_RETRIES = 2;

export function baseUrl(): string {
  return (process.env.GYM_DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_BASE_URL).replace(/\/+$/, '');
}

/**
 * Five levels down to two.
 *
 * Mapping up rather than down is the safe direction: this app spends effort where a
 * mistake is expensive, so a validator asked for `low` getting `high` costs money,
 * while the reverse would cost item quality.
 */
export function deepseekEffort(effort: Effort | undefined): 'high' | 'max' {
  return effort === 'xhigh' || effort === 'max' ? 'max' : 'high';
}

/**
 * The schema, as an instruction.
 *
 * `json_object` mode also requires the word "json" to appear in the prompt — the API
 * rejects the request otherwise — so this paragraph is load-bearing twice over.
 */
export function schemaDirective(schema: JsonSchema): string {
  return [
    'Reply with a single json object and nothing else: no prose before or after it, no',
    'markdown fence. It must conform to this JSON Schema:',
    '',
    JSON.stringify(schema),
    '',
    'Every key listed in "required" must be present, every "enum" value must come from',
    'the listed set, and no key the schema does not name may be added.',
  ].join('\n');
}

/** The system prompt as one string — DeepSeek takes a message, not a block list. */
export function flattenSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block) => (block && typeof block === 'object' ? (block as { text?: string }).text : ''))
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
}

interface CanonicalRequest {
  model?: unknown;
  max_tokens?: unknown;
  system?: unknown;
  messages?: unknown;
  output_config?: {
    effort?: Effort;
    format?: { type?: string; schema?: JsonSchema };
  };
}

/**
 * Canonical request in, DeepSeek chat-completions body out.
 *
 * Pure, so the translation can be asserted on without a network — including the
 * property that matters most: the validator's payload still carries no answer key
 * after being rewritten for a different provider.
 */
export function toDeepSeekBody(request: Record<string, unknown>): Record<string, unknown> {
  const req = request as CanonicalRequest;

  const schema = req.output_config?.format?.schema;
  const system = flattenSystem(req.system);
  const systemContent = schema ? `${system}\n\n${schemaDirective(schema)}` : system;

  const messages: { role: string; content: string }[] = [];
  if (systemContent.trim()) messages.push({ role: 'system', content: systemContent });
  for (const m of (req.messages as { role?: string; content?: unknown }[] | undefined) ?? []) {
    messages.push({ role: m.role ?? 'user', content: contentToText(m.content) });
  }

  const asked = typeof req.max_tokens === 'number' ? req.max_tokens : 16_000;

  return {
    model: String(req.model ?? DEEPSEEK_SOTA),
    messages,
    max_tokens: Math.min(MAX_OUTPUT_TOKENS, asked + REASONING_HEADROOM),
    response_format: { type: 'json_object' },
    reasoning_effort: deepseekEffort(req.output_config?.effort),
    thinking: { type: 'enabled' },
    stream: true,
    // Without this a streamed response carries no usage block at all, and every call
    // would be recorded as free. Silent zero-cost accounting is worse than no readout.
    stream_options: { include_usage: true },
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((block) =>
      block && typeof block === 'object' ? ((block as { text?: string }).text ?? '') : String(block)
    )
    .join('\n');
}

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

/**
 * `prompt_tokens` already includes the cached prefix, exactly as Anthropic's
 * `input_tokens` does not — but `estimateUsd()` subtracts the cached count from the
 * input count before pricing either, so both providers arrive at the same convention.
 */
export function toUsage(usage: DeepSeekUsage | null | undefined): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    // Reasoning tokens are billed as completion tokens, which is why effort is a cost
    // dial here and not only a latency one.
    outputTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_cache_hit_tokens ?? 0,
  };
}

/**
 * One call, streamed.
 *
 * Streamed for the same reason the Anthropic path is: a long generation must not sit
 * behind a silent connection while an idle-timeout somewhere in the stack decides it
 * has died.
 */
export async function callDeepSeek(
  request: Record<string, unknown>
): Promise<{ text: string; usage: Usage }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. A DeepSeek model is routed but there is no credential ' +
        'for it — set the key, or clear the model pin on /lab.'
    );
  }

  const body = toDeepSeekBody(request);
  let lastError: unknown;

  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      const error = new Error(`deepseek ${response.status}: ${detail || response.statusText}`);
      // 4xx other than rate limiting is the request's own fault; retrying it just
      // spends the same wrong call three times.
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
      continue;
    }

    return readStream(response);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Server-sent events into one string.
 *
 * A truncated response is reported as a schema violation rather than a hard failure,
 * because that is what it behaves like: the caller's retry loop is exactly the right
 * response, and the alternative is a raw JSON syntax error that says nothing about
 * why.
 */
async function readStream(response: Response): Promise<{ text: string; usage: Usage }> {
  if (!response.body) throw new SchemaViolation(['deepseek response had no body']);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let text = '';
  let usage: DeepSeekUsage | null = null;
  let finishReason: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; the last fragment stays buffered.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk: {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: DeepSeekUsage | null;
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          // A malformed frame is not worth failing an otherwise good response over.
          continue;
        }

        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) text += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        // The usage block arrives in the final chunk, after the choices are empty.
        if (chunk.usage) usage = chunk.usage;
      }
    }
  }

  if (finishReason === 'length') {
    throw new SchemaViolation([
      'response was truncated at max_tokens — the model spent its output budget on reasoning',
    ]);
  }
  if (!text.trim()) {
    throw new SchemaViolation(['deepseek returned an empty message']);
  }

  return { text: stripFence(text), usage: toUsage(usage) };
}

/**
 * `json_object` mode returns bare JSON, but a fenced block is the one deviation seen
 * often enough to be worth absorbing rather than paying a retry for.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
