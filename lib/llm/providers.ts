/**
 * Which API a model id belongs to.
 *
 * The app was built against one provider, and most of it still assumes one: the
 * prompts, the schemas, the effort dial and the batch pipeline were all designed
 * around Anthropic's Messages API. Adding a second provider is therefore a question
 * of where the seam goes, and the answer is: as late as possible.
 *
 * `buildRequest()` keeps producing one canonical, Anthropic-shaped body for every
 * call regardless of destination. Translation happens at the transport boundary, in
 * `lib/llm/deepseek.ts`, on the way out. That keeps the request that acceptance test 3
 * inspects — the one that must never contain an answer key — a single object with a
 * single shape, and it means a provider can never quietly change what a call site
 * asked for.
 *
 * Routing is by model id prefix rather than by a separate provider setting. A model id
 * already names its provider unambiguously, and a second variable that can disagree
 * with the first is a bug waiting for a Friday.
 */

export type Provider = 'anthropic' | 'deepseek';

export const PROVIDERS: Provider[] = ['anthropic', 'deepseek'];

export function providerFor(model: string): Provider {
  return model.startsWith('deepseek') ? 'deepseek' : 'anthropic';
}

/** The environment variable holding the credential for a provider. */
export const API_KEY_VAR: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function hasKeyFor(provider: Provider): boolean {
  return Boolean(process.env[API_KEY_VAR[provider]]);
}

/**
 * Whether a model can go through the half-price speculative pipeline.
 *
 * The Batch API is Anthropic's; DeepSeek publishes no batch tier at all, and its
 * discount comes from automatic context caching instead. So a DeepSeek-routed call has
 * nowhere to be batched to, and the worker runs it synchronously — see
 * `batchingEnabled()`. This is a capability question, not a preference: submitting a
 * DeepSeek model id to Anthropic's batch endpoint fails the whole batch.
 */
export function supportsBatch(model: string): boolean {
  return providerFor(model) === 'anthropic';
}

/** Human-facing provider name, for the health report and the lab screen. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
};
