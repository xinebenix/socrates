/**
 * The DeepSeek transport.
 *
 * Everything above the transport builds one canonical, Anthropic-shaped request
 * whatever model it names, and this module rewrites it on the way out. That seam is
 * where a second provider can quietly change what a call site asked for, so these
 * tests are mostly about what must survive the rewrite intact — above all the property
 * acceptance test 3 protects: the validator's payload carries no answer key, and it
 * still carries none after being translated for a different API.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callDeepSeek,
  deepseekEffort,
  flattenSystem,
  stripFence,
  toDeepSeekBody,
  toUsage,
  MAX_OUTPUT_TOKENS,
  REASONING_HEADROOM,
} from '../lib/llm/deepseek';
import { buildRequest, type StructuredCall } from '../lib/llm/client';
import { providerFor, supportsBatch } from '../lib/llm/providers';
import { buildMcItemCall } from '../lib/prompts/itemMc';
import { buildValidationCall } from '../lib/prompts/validate';
import { SchemaViolation } from '../lib/llm/schema';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GYM_DEEPSEEK_BASE_URL;
  vi.restoreAllMocks();
});

const CALL: StructuredCall = {
  name: 'test',
  system: 'You write examination items.',
  user: 'Write one about tokenization.',
  schema: {
    type: 'object',
    properties: { stem: { type: 'string' } },
    required: ['stem'],
  },
};

describe('provider routing', () => {
  it('reads the provider off the model id', () => {
    expect(providerFor('deepseek-v4-pro')).toBe('deepseek');
    expect(providerFor('deepseek-v4-flash')).toBe('deepseek');
    expect(providerFor('claude-opus-5')).toBe('anthropic');
    // Nothing is a second source of truth: an unrecognised id is Anthropic's, which
    // is where an unrecognised id has always gone.
    expect(providerFor('some-future-model')).toBe('anthropic');
  });

  it('reports that only Anthropic models can be batched', () => {
    expect(supportsBatch('claude-opus-5')).toBe(true);
    // DeepSeek publishes no batch tier at all. Submitting one to Anthropic's batch
    // endpoint would fail every request in the same batch, not just this one.
    expect(supportsBatch('deepseek-v4-pro')).toBe(false);
  });
});

describe('translating the canonical request', () => {
  it('flattens the system blocks and drops the cache marker', () => {
    const body = toDeepSeekBody(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }));
    const messages = body.messages as { role: string; content: string }[];

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('You write examination items.');
    expect(messages[1]).toEqual({ role: 'user', content: 'Write one about tokenization.' });
    // Anthropic caches what you mark; DeepSeek caches prefixes on its own. A marker
    // that survived here would be an unknown field on the request.
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(JSON.stringify(body)).not.toContain('output_config');
  });

  it('carries the schema into the prompt, since json_object enforces no shape', () => {
    const body = toDeepSeekBody(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }));
    const system = (body.messages as { content: string }[])[0].content;

    expect(system).toContain('"required"');
    expect(system).toContain('stem');
    expect(body.response_format).toEqual({ type: 'json_object' });
    // json_object mode is rejected outright unless the prompt contains the word.
    expect(system.toLowerCase()).toContain('json');
  });

  it('maps five effort levels onto the two that exist', () => {
    // Mapping up, never down: this app spends effort where a mistake is expensive.
    expect(deepseekEffort('low')).toBe('high');
    expect(deepseekEffort('medium')).toBe('high');
    expect(deepseekEffort('high')).toBe('high');
    expect(deepseekEffort('xhigh')).toBe('max');
    expect(deepseekEffort('max')).toBe('max');
    expect(deepseekEffort(undefined)).toBe('high');

    const body = toDeepSeekBody(
      buildRequest({ ...CALL, model: 'deepseek-v4-pro', effort: 'xhigh' })
    );
    expect(body.reasoning_effort).toBe('max');
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('adds reasoning headroom to the token ceiling', () => {
    // Thinking tokens are completion tokens here, so they eat the answer's budget. A
    // ceiling spent on reasoning truncates the JSON and loses a whole generation set.
    const body = toDeepSeekBody(
      buildRequest({ ...CALL, model: 'deepseek-v4-pro', maxTokens: 16000 })
    );
    expect(body.max_tokens).toBe(16000 + REASONING_HEADROOM);

    const huge = toDeepSeekBody(
      buildRequest({ ...CALL, model: 'deepseek-v4-pro', maxTokens: 200_000 })
    );
    expect(huge.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('streams, and asks for the usage block that streaming otherwise omits', () => {
    const body = toDeepSeekBody(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }));
    expect(body.stream).toBe(true);
    // Without this every call is recorded as free, which is worse than no readout.
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('still sends the validator no answer key', () => {
    // Invariant 3, restated on the other side of the translation. The blind solve is
    // what makes a cheaper generator safe, and it is only blind if this holds.
    const request = buildRequest(
      buildValidationCall({
        stem: 'Which of these is a subword unit?',
        optionTexts: ['alpha', 'beta', 'gamma', 'delta'],
        nodeDescription: 'What the vocabulary layer does.',
        sourceExcerpt: 'Tokens are subword units.',
      })
    );
    const wire = JSON.stringify(toDeepSeekBody({ ...request, model: 'deepseek-v4-pro' }));

    expect(wire).not.toMatch(/is_correct/);
    expect(wire).not.toMatch(/answer[_ ]key/i);
    expect(wire).not.toMatch(/"correct"\s*:/);
  });

  it('keeps the depth split visible in the model and nowhere else', () => {
    const shallow = buildRequest(
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
    const body = toDeepSeekBody({ ...shallow, model: 'deepseek-v4-flash' });
    expect(body.model).toBe('deepseek-v4-flash');
  });

  it('flattens a plain string system prompt too', () => {
    expect(flattenSystem('just a string')).toBe('just a string');
    expect(flattenSystem([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\n\nb');
    expect(flattenSystem(undefined)).toBe('');
  });
});

describe('reading the response', () => {
  it('maps usage onto the shape the accounting expects', () => {
    expect(
      toUsage({ prompt_tokens: 900, completion_tokens: 4000, prompt_cache_hit_tokens: 700 })
    ).toEqual({ inputTokens: 900, outputTokens: 4000, cachedTokens: 700 });

    // A response with no usage block reads as zero rather than throwing: losing the
    // accounting for one call must never lose the call.
    expect(toUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });

  it('absorbs a markdown fence rather than paying a retry for it', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});

/** An SSE body of the shape DeepSeek streams back. */
function sseResponse(chunks: unknown[], init: ResponseInit = {}): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(body), { status: 200, ...init });
}

describe('the call itself', () => {
  it('posts to the chat-completions endpoint and assembles the stream', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      sseResponse([
        { choices: [{ delta: { content: '{"stem":' } }] },
        { choices: [{ delta: { content: '"why?"}' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 900, prompt_cache_hit_tokens: 64 },
        },
      ])
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callDeepSeek(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }));

    expect(result.text).toBe('{"stem":"why?"}');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 900, cachedTokens: 64 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string).model).toBe('deepseek-v4-pro');
  });

  it('honours a base URL override, trailing slash and all', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.GYM_DEEPSEEK_BASE_URL = 'https://gateway.example.com/v1/';
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      sseResponse([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }])
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callDeepSeek(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }));
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v1/chat/completions');
  });

  it('reports a truncated response as a schema violation, so the caller retries it', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    globalThis.fetch = (async () =>
      sseResponse([
        { choices: [{ delta: { content: '{"stem":' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ])) as unknown as typeof fetch;

    await expect(callDeepSeek(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }))).rejects.toThrow(
      SchemaViolation
    );
  });

  it('says which credential is missing, and where to turn the pin off', async () => {
    await expect(callDeepSeek(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }))).rejects.toThrow(
      /DEEPSEEK_API_KEY/
    );
  });

  it('does not retry a request the provider has rejected on its merits', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const fetchMock = vi.fn(
      async () => new Response('{"error":{"message":"bad model"}}', { status: 400 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callDeepSeek(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }))).rejects.toThrow(
      /deepseek 400/
    );
    // Spending the same wrong call three times helps nobody.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit, which is the provider\'s state and not the request\'s', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429 });
      return sseResponse([
        { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] },
      ]);
    }) as unknown as typeof fetch;

    const result = await callDeepSeek(buildRequest({ ...CALL, model: 'deepseek-v4-pro' }));
    expect(result.text).toBe('{"ok":true}');
    expect(calls).toBe(2);
  }, 10_000);
});
