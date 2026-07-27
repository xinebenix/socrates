/**
 * The Message Batches transport.
 *
 * The Batch API bills every token at half the synchronous rate, in exchange for
 * results arriving asynchronously — usually within minutes, guaranteed within a day.
 * The pre-generation buffer is asynchronous *by definition*: nothing about filling a
 * buffer needs an answer now, so this is a 50% discount on the bulk of the app's
 * spend that costs no latency anyone can feel.
 *
 * The session's own paths — inline generation, warm-at-start, grading — stay
 * synchronous. A user waiting on an item must never be waiting on a batch.
 */

import Anthropic from '@anthropic-ai/sdk';
import { STRONG_FROM_DEPTH, modelFor, type Usage } from './client';
import { supportsBatch } from './providers';

export interface BatchRequest {
  customId: string;
  /** The exact body buildRequest() produces — same schema, same effort, same model. */
  request: Record<string, unknown>;
}

export interface BatchResultEntry {
  customId: string;
  ok: boolean;
  /** The text block of a succeeded result. */
  text: string | null;
  usage: Usage;
  error: string | null;
}

export interface BatchTransport {
  /** Returns the provider's batch id. */
  submit(requests: BatchRequest[]): Promise<string>;
  /** Null while the batch is still processing; entries once it has ended. */
  poll(batchId: string): Promise<BatchResultEntry[] | null>;
}

let injected: BatchTransport | null = null;

/** Tests inject a fake, exactly as setTransport does for the synchronous path. */
export function setBatchTransport(t: BatchTransport | null): void {
  injected = t;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

const real: BatchTransport = {
  async submit(requests) {
    const batch = await getClient().messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.customId,
        params: r.request as never,
      })),
    });
    return batch.id;
  },

  async poll(batchId) {
    const batch = await getClient().messages.batches.retrieve(batchId);
    if (batch.processing_status !== 'ended') return null;

    const entries: BatchResultEntry[] = [];
    const decoder = await getClient().messages.batches.results(batchId);
    for await (const entry of decoder) {
      if (entry.result.type === 'succeeded') {
        const message = entry.result.message;
        const text = message.content.find((b: { type: string }) => b.type === 'text');
        entries.push({
          customId: entry.custom_id,
          ok: Boolean(text && text.type === 'text'),
          text: text && text.type === 'text' ? text.text : null,
          usage: {
            inputTokens: message.usage?.input_tokens ?? 0,
            outputTokens: message.usage?.output_tokens ?? 0,
            cachedTokens: message.usage?.cache_read_input_tokens ?? 0,
          },
          error: text ? null : 'response contained no text block',
        });
      } else {
        // errored | canceled | expired — the shortfall stays visible to the next
        // tick, which resubmits. No retry machinery needed here.
        entries.push({
          customId: entry.custom_id,
          ok: false,
          text: null,
          usage: NO_USAGE,
          error: entry.result.type,
        });
      }
    }
    return entries;
  },
};

export function getBatchTransport(): BatchTransport {
  return injected ?? real;
}

/**
 * The models the speculative pipeline would submit: generation and validation, at both
 * ends of the depth split.
 */
function batchPathModels(): string[] {
  return [
    modelFor('item', 1),
    modelFor('item', STRONG_FROM_DEPTH),
    modelFor('validate', 1),
    modelFor('validate', STRONG_FROM_DEPTH),
  ];
}

/**
 * On unless explicitly turned off. GYM_BATCH=0 restores the fully synchronous
 * worker, at double the price — useful only when diagnosing the batch path itself.
 *
 * It also turns itself off while any part of the speculative path is routed off
 * Anthropic. The Batch API is Anthropic's, and a batch is submitted whole: one
 * DeepSeek model id in the request list fails every request in it, including the ones
 * that would have worked. Losing the discount is the correct trade — the worker falls
 * through to the synchronous fill on the next tick and the buffer keeps filling, which
 * is what a model comparison needs it to do.
 */
export function batchingEnabled(): boolean {
  if (process.env.GYM_BATCH === '0') return false;
  if (!batchPathModels().every(supportsBatch)) return false;
  return injected !== null || Boolean(process.env.ANTHROPIC_API_KEY);
}
