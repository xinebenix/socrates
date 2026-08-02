/**
 * What the hands-free mode says, composed as text.
 *
 * Pure functions from an item (or its feedback) to an ordered list of spoken chunks,
 * so the composition is testable without a browser and the controller component stays
 * a thin machine. Chunks are sized for the TTS endpoint and for pipelining: the first
 * chunk of a stem can be playing while the rest is still being synthesized.
 *
 * Everything spoken comes out of the dictionary, so the Chinese interface speaks
 * Chinese. The one linguistic structure kept here rather than in a string table is how
 * a list of option marks is joined ("Alpha, Beta, or Gamma" / "A、B 或 C") — that is
 * grammar, not copy.
 */

import { fill, type Dict } from '../i18n/dict';
import type { Locale } from '../i18n/locale';

/**
 * How the option marks are *pronounced*, per locale.
 *
 * The English interface prints Α/Β/Γ/Δ; a TTS engine shown a bare Greek capital
 * guesses, and the recognizer on the other end hears English words. "Alpha" is both
 * what the engine should say and what the driver will say back. Chinese prints and
 * says A/B/C/D — see OPTION_MARKS in ItemCard.
 */
export const SPOKEN_MARKS: Record<Locale, readonly string[]> = {
  en: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
  zh: ['A', 'B', 'C', 'D', 'E', 'F'],
};

/**
 * Well under the endpoint's MAX_TTS_TEXT_CHARS, and short enough that synthesis of
 * one chunk (a second or two) overlaps playback of the previous one.
 */
export const MAX_SPOKEN_CHUNK = 280;

export function spokenMark(locale: Locale, index: number): string {
  const marks = SPOKEN_MARKS[locale] ?? SPOKEN_MARKS.en;
  return marks[index] ?? String(index + 1);
}

/** "Alpha, Beta, Gamma, or Delta" / "A、B、C 或 D". */
export function joinMarks(locale: Locale, marks: readonly string[]): string {
  if (marks.length === 0) return '';
  if (marks.length === 1) return marks[0];
  const head = marks.slice(0, -1);
  const last = marks[marks.length - 1];
  return locale === 'zh' ? `${head.join('、')} 或 ${last}` : `${head.join(', ')}, or ${last}`;
}

/** The slices of the item and feedback shapes that speaking needs. Structural, so the
 * session components can pass their own types straight through without lib depending
 * on components. */
export interface SpokenItem {
  kind: 'mc' | 'free';
  stem: string;
  position: number;
  total: number;
  options: { text: string }[];
}

export interface SpokenMcFeedback {
  kind: 'mc';
  correct: boolean;
  declined?: boolean;
  explanation: string;
  options: { text: string; isCorrect?: boolean }[];
}

export interface SpokenFreeFeedback {
  kind: 'free';
  correct: boolean;
  declined?: boolean;
  score: number;
  threshold: number;
  criteria: { met: boolean }[];
  verdictSummary: string;
}

export type SpokenFeedback = SpokenMcFeedback | SpokenFreeFeedback;

/**
 * Split text into chunks of at most `max` characters, on sentence boundaries where
 * possible, then clause boundaries, then spaces. Never returns an empty chunk.
 */
export function chunk(text: string, max = MAX_SPOKEN_CHUNK): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [clean];
  const out: string[] = [];
  let current = '';

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const pieces = sentence.length > max ? hardSplit(sentence, max) : [sentence];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > max) {
        out.push(current);
        current = piece;
      } else {
        current = current ? `${current} ${piece}` : piece;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/** A single sentence longer than the cap: cut at clauses, then spaces, then anywhere —
 * Chinese has no spaces, so the last resort is real. */
function hardSplit(sentence: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = sentence.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('；'),
      window.lastIndexOf(';'),
      window.lastIndexOf('：'),
      window.lastIndexOf(':')
    );
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut < max * 0.4) cut = max - 1;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** The question as read: counter, stem, then each option with its spoken mark. */
export function itemScript(item: SpokenItem, t: Dict, locale: Locale): string[] {
  const parts = chunk(
    `${fill(t.session.handsFreeSpokenQuestion, {
      position: item.position,
      total: item.total,
    })} ${item.stem}`
  );
  if (item.kind === 'mc') {
    for (let i = 0; i < item.options.length; i++) {
      parts.push(
        ...chunk(
          fill(t.session.handsFreeSpokenOption, {
            mark: spokenMark(locale, i),
            text: item.options[i].text,
          })
        )
      );
    }
  }
  return parts;
}

/** What to say when it is the learner's turn to answer. */
export function answerPrompt(item: SpokenItem, t: Dict, locale: Locale): string {
  if (item.kind === 'free') return t.session.handsFreeSpokenFreePrompt;
  const marks = item.options.map((_, i) => spokenMark(locale, i));
  return fill(t.session.handsFreeSpokenAnswerPrompt, { marks: joinMarks(locale, marks) });
}

/**
 * Confidence is asked for out loud *before* anything is submitted — invariant 1 does
 * not bend for the road. `selectedIndex` is null for a free-response answer.
 */
export function confidencePrompt(
  selectedIndex: number | null,
  t: Dict,
  locale: Locale
): string {
  if (selectedIndex === null) return t.session.handsFreeSpokenFreeChosen;
  return fill(t.session.handsFreeSpokenChosen, { mark: spokenMark(locale, selectedIndex) });
}

/**
 * The verdict as read: the head ("Just so." / "Not this time."), the correct option
 * when the learner missed it, then the explanation. Free responses get the grader's
 * verdict summary and the criteria count.
 */
export function feedbackScript(feedback: SpokenFeedback, t: Dict, locale: Locale): string[] {
  const head = feedback.declined
    ? t.session.feedbackHeadDontKnow
    : feedback.correct
      ? t.session.feedbackHeadCorrect
      : t.session.feedbackHeadWrong;

  if (feedback.kind === 'mc') {
    const parts = [head];
    if (!feedback.correct) {
      const i = feedback.options.findIndex((o) => o.isCorrect);
      if (i >= 0) {
        parts.push(
          ...chunk(
            fill(t.session.handsFreeSpokenAnswerWas, {
              mark: spokenMark(locale, i),
              text: feedback.options[i].text,
            })
          )
        );
      }
    }
    parts.push(...chunk(feedback.explanation));
    return parts;
  }

  const parts = [head];
  if (feedback.declined) {
    parts.push(...chunk(t.session.dontKnowFreeSummary));
  } else {
    parts.push(...chunk(feedback.verdictSummary));
    // The on-screen summary uses a separator glyph; spoken, it becomes a pause.
    parts.push(
      ...chunk(
        fill(t.session.criteriaMetSummary, {
          met: feedback.criteria.filter((c) => c.met).length,
          criteria: feedback.criteria.length,
          score: Math.round(feedback.score * 100),
          threshold: Math.round(feedback.threshold * 100),
        }).replace(/\s*·\s*/g, ', ')
      )
    );
  }
  return parts;
}
