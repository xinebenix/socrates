/**
 * The ByteDance synthesis client: config gating, the wire format, and the cache.
 *
 * The wire assertions matter more than they look: the authorization header really is
 * `Bearer;<token>` with a semicolon, and success is application code 3000 in the JSON
 * body rather than the HTTP status — both are the kind of detail a refactor
 * "normalises" into a client that fails against the real endpoint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TTS_TEXT_CHARS,
  TTS_ENDPOINT,
  synthesize,
  ttsConfig,
  type TtsConfig,
} from '../lib/tts/bytedance';
import { resetProcessState } from '../lib/processState';

const VARS = [
  'GYM_TTS_APPID',
  'GYM_TTS_TOKEN',
  'GYM_TTS_CLUSTER',
  'GYM_TTS_VOICE_EN',
  'GYM_TTS_VOICE_ZH',
  'GYM_TTS_SPEED',
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  resetProcessState();
});

const config = (over: Partial<TtsConfig> = {}): TtsConfig => ({
  appid: 'app-1',
  token: 'tok-1',
  cluster: 'volcano_tts',
  voice: { en: 'BV503_streaming', zh: 'BV700_streaming' },
  speed: 1,
  ...over,
});

function okFetch(audio = 'hello audio') {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 3000, message: 'ok', data: Buffer.from(audio).toString('base64') }),
  })) as unknown as typeof fetch;
}

describe('ttsConfig', () => {
  it('is null without both credentials, so the feature stays invisible', () => {
    expect(ttsConfig({})).toBeNull();
    expect(ttsConfig({ GYM_TTS_APPID: 'a' })).toBeNull();
    expect(ttsConfig({ GYM_TTS_TOKEN: 't' })).toBeNull();
  });

  it('fills the defaults', () => {
    const c = ttsConfig({ GYM_TTS_APPID: 'a', GYM_TTS_TOKEN: 't' });
    expect(c).toEqual({
      appid: 'a',
      token: 't',
      cluster: 'volcano_tts',
      voice: { en: 'BV503_streaming', zh: 'BV700_streaming' },
      speed: 1,
    });
  });

  it('takes overrides, and refuses a speed outside 0.5-2 rather than shipping it', () => {
    const c = ttsConfig({
      GYM_TTS_APPID: 'a',
      GYM_TTS_TOKEN: 't',
      GYM_TTS_CLUSTER: 'volcano_tts_custom',
      GYM_TTS_VOICE_EN: 'BV001_streaming',
      GYM_TTS_SPEED: '1.3',
    });
    expect(c?.cluster).toBe('volcano_tts_custom');
    expect(c?.voice.en).toBe('BV001_streaming');
    expect(c?.speed).toBe(1.3);

    expect(ttsConfig({ GYM_TTS_APPID: 'a', GYM_TTS_TOKEN: 't', GYM_TTS_SPEED: '9' })?.speed).toBe(1);
    expect(ttsConfig({ GYM_TTS_APPID: 'a', GYM_TTS_TOKEN: 't', GYM_TTS_SPEED: 'fast' })?.speed).toBe(1);
  });
});

describe('synthesize', () => {
  it('speaks ByteDance on the wire: endpoint, semicolon bearer, cluster, voice, query', async () => {
    const fetchMock = okFetch();
    await synthesize(config(), { text: 'Question 1 of 20.', locale: 'en' }, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(TTS_ENDPOINT);
    expect(init.headers.authorization).toBe('Bearer;tok-1');

    const body = JSON.parse(init.body) as {
      app: { appid: string; token: string; cluster: string };
      audio: { voice_type: string; encoding: string; speed_ratio: number };
      request: { reqid: string; text: string; text_type: string; operation: string };
    };
    expect(body.app).toEqual({ appid: 'app-1', token: 'tok-1', cluster: 'volcano_tts' });
    expect(body.audio.voice_type).toBe('BV503_streaming');
    expect(body.audio.encoding).toBe('mp3');
    expect(body.request.text).toBe('Question 1 of 20.');
    expect(body.request.text_type).toBe('plain');
    expect(body.request.operation).toBe('query');
    expect(body.request.reqid.length).toBeGreaterThan(0);
  });

  it('picks the voice by locale', async () => {
    const fetchMock = okFetch();
    await synthesize(config(), { text: '第 1 题。', locale: 'zh' }, fetchMock);
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    expect((JSON.parse(init.body) as { audio: { voice_type: string } }).audio.voice_type).toBe(
      'BV700_streaming'
    );
  });

  it('decodes the base64 payload into audio bytes', async () => {
    const audio = await synthesize(config(), { text: 'hi', locale: 'en' }, okFetch('mp3 bytes'));
    expect(audio.toString()).toBe('mp3 bytes');
  });

  it('treats a non-3000 application code as failure whatever the HTTP status', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 4003, message: 'quota exceeded' }),
    })) as unknown as typeof fetch;
    await expect(synthesize(config(), { text: 'hi', locale: 'en' }, fetchMock)).rejects.toThrow(
      /4003.*quota exceeded/
    );
  });

  it('reports an HTTP failure as one', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(synthesize(config(), { text: 'hi', locale: 'en' }, fetchMock)).rejects.toThrow(
      /502/
    );
  });

  it('refuses empty and oversized text without touching the network', async () => {
    const fetchMock = okFetch();
    await expect(synthesize(config(), { text: '   ', locale: 'en' }, fetchMock)).rejects.toThrow();
    await expect(
      synthesize(config(), { text: 'x'.repeat(MAX_TTS_TEXT_CHARS + 1), locale: 'en' }, fetchMock)
    ).rejects.toThrow(/limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a repeated utterance from cache — the fixed prompts repeat every item', async () => {
    const fetchMock = okFetch();
    const first = await synthesize(config(), { text: 'Your answer?', locale: 'en' }, fetchMock);
    const second = await synthesize(config(), { text: 'Your answer?', locale: 'en' }, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.equals(first)).toBe(true);

    // A different utterance is a different waveform.
    await synthesize(config(), { text: 'Next question.', locale: 'en' }, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not serve one voice from another voice\'s cache', async () => {
    const fetchMock = okFetch();
    await synthesize(config(), { text: 'Your answer?', locale: 'en' }, fetchMock);
    await synthesize(config(), { text: 'Your answer?', locale: 'zh' }, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
