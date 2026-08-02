import { NextResponse } from 'next/server';
import { isLocale } from '@/lib/i18n/locale';
import { MAX_TTS_TEXT_CHARS, synthesize, ttsConfig } from '@/lib/tts/bytedance';
import { bad, fail, requireUserId, str } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Text in, MP3 out. The hands-free controller calls this once per spoken chunk.
 *
 * Signed in only — middleware gates it like every route, and the identity check here is
 * what stops the deployment's TTS quota being a free synthesis endpoint for anyone who
 * finds the URL. The ByteDance credentials never leave the server.
 */
export async function POST(req: Request) {
  try {
    await requireUserId();

    const config = ttsConfig(process.env);
    if (!config) {
      return bad('speech synthesis is not configured on this deployment', 503);
    }

    const body = (await req.json()) as { text?: unknown; locale?: unknown };
    const text = str(body.text)?.trim();
    if (!text) return bad('text is required');
    if (text.length > MAX_TTS_TEXT_CHARS) {
      return bad(`text is ${text.length} chars, the limit is ${MAX_TTS_TEXT_CHARS}`);
    }
    const locale = isLocale(body.locale) ? body.locale : 'en';

    const audio = await synthesize(config, { text, locale });

    return new NextResponse(new Uint8Array(audio), {
      headers: {
        'content-type': 'audio/mpeg',
        // Identical text within a session repeats (the "repeat" command, the fixed
        // prompts); the server keeps its own cache, so this only spares the wire.
        'cache-control': 'private, max-age=300',
      },
    });
  } catch (err) {
    return fail(err);
  }
}
