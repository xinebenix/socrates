/**
 * ByteDance (Volcengine) speech synthesis, server-side only.
 *
 * This exists for the hands-free session mode: the browser never sees the TTS
 * credentials, it POSTs text to /api/tts and gets MP3 bytes back. One HTTP call per
 * utterance against the openspeech endpoint; success is application code 3000 with the
 * audio base64-encoded in `data`.
 *
 * The whole feature is optional. Without GYM_TTS_APPID and GYM_TTS_TOKEN the config is
 * null, the API route answers 503, and the session screen never shows the toggle.
 */

import { randomUUID } from 'node:crypto';
import { processState } from '../processState';
import type { Locale } from '../i18n/locale';

export const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';

/**
 * The ceiling on one utterance. The classic openspeech clusters cap request text at
 * roughly a kilobyte; the client chunks scripts well below this, so hitting it means a
 * caller is not chunking, and refusing loudly beats a truncated read nobody notices
 * while driving.
 */
export const MAX_TTS_TEXT_CHARS = 600;

/**
 * Any voice enabled on the Volcengine app works here — these are only defaults.
 * BV700 (灿灿) reads mixed Chinese and English, which matters because stems quote
 * source material and source material does not stay in one language.
 */
const DEFAULT_VOICE: Record<Locale, string> = {
  en: 'BV503_streaming',
  zh: 'BV700_streaming',
};

export interface TtsConfig {
  appid: string;
  token: string;
  cluster: string;
  voice: Record<Locale, string>;
  /** speed_ratio, clamped to [0.5, 2]. Out-of-range values fall back to 1. */
  speed: number;
}

export function ttsConfig(env: Record<string, string | undefined> = process.env): TtsConfig | null {
  const appid = env.GYM_TTS_APPID;
  const token = env.GYM_TTS_TOKEN;
  if (!appid || !token) return null;

  const speed = Number(env.GYM_TTS_SPEED);
  return {
    appid,
    token,
    cluster: env.GYM_TTS_CLUSTER || 'volcano_tts',
    voice: {
      en: env.GYM_TTS_VOICE_EN || DEFAULT_VOICE.en,
      zh: env.GYM_TTS_VOICE_ZH || DEFAULT_VOICE.zh,
    },
    speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1,
  };
}

/**
 * Synthesized audio, keyed by exactly what determines the waveform.
 *
 * The cache earns its keep on the fixed prompts — "how sure are you", the option marks,
 * "the answer was" — which repeat verbatim on every item of every session and would
 * otherwise be paid for every time. Item stems are one-shot by design (invariant 6:
 * items are never reused to one learner), so they wash out of a bounded cache exactly
 * as they should. Held via processState: the route handlers and the worker bundle are
 * two module instances in one process, and a per-module map would be two caches.
 */
const CACHE_CAP = 128;

function cache(): Map<string, Buffer> {
  return processState('tts.cache', () => new Map<string, Buffer>());
}

interface WireResponse {
  code?: number;
  message?: string;
  data?: string;
}

/**
 * One utterance to MP3 bytes.
 *
 * The authorization header really is `Bearer;<token>` with a semicolon — that is
 * ByteDance's documented format, not a typo. The token also rides in the body's app
 * block; the endpoint wants both.
 */
export async function synthesize(
  config: TtsConfig,
  { text, locale }: { text: string; locale: Locale },
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('tts: nothing to say');
  if (trimmed.length > MAX_TTS_TEXT_CHARS) {
    throw new Error(`tts: text is ${trimmed.length} chars, the limit is ${MAX_TTS_TEXT_CHARS}`);
  }

  const voice = config.voice[locale] ?? config.voice.en;
  const key = `${voice}|${config.speed}|${trimmed}`;
  const store = cache();
  const hit = store.get(key);
  if (hit) {
    // Refresh recency so the fixed prompts survive a session's worth of stems.
    store.delete(key);
    store.set(key, hit);
    return hit;
  }

  const res = await fetchImpl(TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer;${config.token}`,
    },
    body: JSON.stringify({
      app: { appid: config.appid, token: config.token, cluster: config.cluster },
      user: { uid: 'socrates' },
      audio: { voice_type: voice, encoding: 'mp3', speed_ratio: config.speed },
      request: { reqid: randomUUID(), text: trimmed, text_type: 'plain', operation: 'query' },
    }),
  });

  if (!res.ok) {
    throw new Error(`tts: endpoint answered HTTP ${res.status}`);
  }

  const body = (await res.json()) as WireResponse;
  if (body.code !== 3000 || !body.data) {
    throw new Error(`tts: synthesis failed (${body.code ?? 'no code'}: ${body.message ?? 'no message'})`);
  }

  const audio = Buffer.from(body.data, 'base64');
  store.set(key, audio);
  while (store.size > CACHE_CAP) {
    const oldest = store.keys().next().value as string;
    store.delete(oldest);
  }
  return audio;
}
