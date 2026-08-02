/**
 * From a recognizer transcript to a typed command.
 *
 * Phase-scoped on purpose: during dictation almost everything the driver says is
 * *content*, and only a handful of phrases are commands; while paused, only "resume"
 * means anything, so a passenger conversation cannot answer a question. The parser is
 * pure and locale-aware — it is the counterpart of SPOKEN_MARKS in script.ts, hearing
 * back the same vocabulary the speaker used.
 *
 * Matching is deliberately conservative for short tokens. "Alpha" can be trusted
 * anywhere in an utterance; a bare "a" appears inside every English sentence, so
 * single letters are accepted only when the utterance is essentially just the answer
 * ("b", "option b", "its b"). The safe failure mode is to say nothing and be asked
 * again, not to record an answer the driver did not give.
 */

import type { Confidence } from '../mastery/bkt';
import type { Locale } from '../i18n/locale';

export type VoiceCommand =
  | { type: 'select'; index: number }
  | { type: 'confidence'; value: Confidence }
  | { type: 'repeat' }
  | { type: 'next' }
  | { type: 'dontKnow' }
  | { type: 'done' }
  | { type: 'pause' }
  | { type: 'resume' };

/** What the controller is listening for. Mirrors its state machine. */
export type ListenPhase = 'answer' | 'confidence' | 'feedback' | 'dictation' | 'paused';

export interface CommandContext {
  locale: Locale;
  phase: ListenPhase;
  optionCount: number;
}

/** Lowercase, punctuation to spaces, whitespace collapsed. "I don't know." → "i dont know". */
function normalize(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The phrase's tokens appear contiguously in the utterance's tokens. Word-boundary
 * aware, unlike substring search — "done" must not fire inside "abandoned". */
function hasPhrase(tokens: string[], phrase: string): boolean {
  const p = phrase.split(' ');
  outer: for (let i = 0; i + p.length <= tokens.length; i++) {
    for (let j = 0; j < p.length; j++) {
      if (tokens[i + j] !== p[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Chinese arrives unspaced, so phrases match by substring on the unspaced form. */
function hasAny(t: string, tokens: string[], phrases: readonly string[], locale: Locale): boolean {
  const compact = locale === 'zh' ? t.replace(/ /g, '') : t;
  return phrases.some((p) =>
    locale === 'zh' ? compact.includes(p) : hasPhrase(tokens, p)
  );
}

const PHRASES = {
  en: {
    repeat: ['repeat', 'say again', 'say that again', 'again', 'one more time', 'read it again'],
    next: ['next', 'next question', 'continue', 'go on', 'keep going', 'onwards', 'skip'],
    dontKnow: ['i dont know', 'dont know', 'i do not know', 'no idea', 'pass', 'give up', 'skip'],
    done: ['im done', 'i am done', 'done', 'finished', 'thats it', 'submit'],
    pause: ['pause', 'hold on', 'wait', 'hang on'],
    resume: ['resume', 'continue', 'go on', 'carry on', 'unpause'],
    guessing: ['guessing', 'guess', 'a guess', 'guessed', 'total guess', 'no clue'],
    unsure: ['unsure', 'not sure', 'not certain', 'not confident', 'maybe'],
    confident: ['confident', 'certain', 'sure', 'positive', 'definitely'],
  },
  zh: {
    repeat: ['再读一遍', '再说一遍', '重复', '重读', '再来一遍', '重新读'],
    next: ['下一题', '下一个', '继续', '好了', '跳过'],
    dontKnow: ['不知道', '不会', '没思路', '跳过', '放弃'],
    done: ['说完了', '答完了', '完了', '提交', '就这样'],
    pause: ['暂停', '等一下', '等等', '停一下'],
    resume: ['继续', '恢复', '接着来'],
    guessing: ['猜测', '猜的', '瞎猜', '靠猜', '纯猜'],
    unsure: ['不确定', '不太确定', '拿不准', '不好说'],
    confident: ['确定', '肯定', '有把握', '确信'],
  },
} as const;

const WORD_MARKS = {
  en: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
  zh: [] as string[],
} as const;

const ORDINALS = {
  en: ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'],
  zh: ['第一', '第二', '第三', '第四', '第五', '第六'],
} as const;

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];
const ZH_NUMERALS = ['一', '二', '三', '四', '五', '六'];

/** Which option an utterance picks, or null. */
function selectIndex(t: string, tokens: string[], ctx: CommandContext): number | null {
  const n = Math.min(ctx.optionCount, LETTERS.length);

  if (ctx.locale === 'zh') {
    const compact = t.replace(/ /g, '');
    for (let i = 0; i < n; i++) {
      // "第三个" / "选第三个" — the ordinal is distinctive on its own.
      if (compact.includes(ORDINALS.zh[i])) return i;
      // A bare letter, or one aimed with 选/选项 ("选b", "选项b").
      if (
        compact === LETTERS[i] ||
        compact.includes(`选${LETTERS[i]}`) ||
        compact.includes(`选项${LETTERS[i]}`)
      ) {
        return i;
      }
      // A bare numeral ("三") is an answer only when it is the whole utterance —
      // numerals appear inside ordinary speech far too often to trust mid-sentence.
      if (compact === ZH_NUMERALS[i] || compact === String(i + 1)) return i;
    }
    return null;
  }

  for (let i = 0; i < n; i++) {
    // "Alpha" and "the second one" are distinctive anywhere in the utterance.
    if (hasPhrase(tokens, WORD_MARKS.en[i])) return i;
    if (hasPhrase(tokens, ORDINALS.en[i])) return i;
    // "option b" is aimed; a bare letter or digit only in a short utterance.
    if (hasPhrase(tokens, `option ${LETTERS[i]}`)) return i;
    if (tokens.length <= 3 && (tokens.includes(LETTERS[i]) || tokens.includes(String(i + 1)))) {
      return i;
    }
  }
  return null;
}

function confidenceOf(t: string, tokens: string[], locale: Locale): Confidence | null {
  const p = PHRASES[locale];
  // "not sure" and "不确定" contain their own antonyms; the negated forms go first.
  if (hasAny(t, tokens, p.unsure, locale)) return 'unsure';
  if (hasAny(t, tokens, p.guessing, locale)) return 'guessing';
  if (hasAny(t, tokens, p.confident, locale)) return 'confident';
  return null;
}

export function parseCommand(transcript: string, ctx: CommandContext): VoiceCommand | null {
  const t = normalize(transcript);
  if (!t) return null;
  const tokens = t.split(' ');
  const p = PHRASES[ctx.locale];
  const any = (phrases: readonly string[]) => hasAny(t, tokens, phrases, ctx.locale);

  switch (ctx.phase) {
    case 'paused':
      return any(p.resume) ? { type: 'resume' } : null;

    case 'dictation': {
      // Content unless it is unmistakably a command. The loose phase lists would be
      // reckless here — "pass", "done" and "wait" all occur inside ordinary answers,
      // and giving up records a wrong response at floor confidence. So dictation has
      // its own stricter vocabulary: multi-word phrases, or a bare word only when it
      // is the entire utterance (which is how a recognizer delivers a lone "Done.").
      const strict = ctx.locale === 'zh'
        ? { dontKnow: ['我放弃', '放弃作答', '跳过这题', '跳过此题'],
            done: ['说完了', '答完了', '就这样', '提交'],
            doneExact: ['完了'],
            pause: ['暂停', '停一下'] }
        : { dontKnow: ['i give up', 'skip this question', 'skip this one'],
            done: ['im done', 'i am done', 'thats it', 'submit'],
            doneExact: ['done', 'finished'],
            pause: ['pause', 'hold on'] };
      if (any(strict.dontKnow)) return { type: 'dontKnow' };
      if (any(strict.done) || strict.doneExact.includes(t)) return { type: 'done' };
      if (any(strict.pause)) return { type: 'pause' };
      return null;
    }

    case 'answer':
    case 'confidence': {
      if (any(p.pause)) return { type: 'pause' };
      if (any(p.repeat)) return { type: 'repeat' };
      if (any(p.dontKnow)) return { type: 'dontKnow' };
      if (ctx.phase === 'confidence') {
        const c = confidenceOf(t, tokens, ctx.locale);
        if (c) return { type: 'confidence', value: c };
      }
      const index = selectIndex(t, tokens, ctx);
      if (index !== null) return { type: 'select', index };
      // Confidence words during the answer phase happen — someone answers "b,
      // confident" in one breath and the recognizer splits it — so accept them.
      if (ctx.phase === 'answer') {
        const c = confidenceOf(t, tokens, ctx.locale);
        if (c) return { type: 'confidence', value: c };
      }
      return null;
    }

    case 'feedback': {
      if (any(p.pause)) return { type: 'pause' };
      if (any(p.repeat)) return { type: 'repeat' };
      if (any(p.next)) return { type: 'next' };
      return null;
    }
  }
}
