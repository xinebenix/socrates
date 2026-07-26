/**
 * Source excerpt selection.
 *
 * Limitation 4 in the spec: the model's coverage is bounded by the source, and
 * free-generating from a topic name produces canonically-shaped items that test the
 * textbook version. Generation is always grounded in supplied text — this picks the
 * part of it that bears on a given node.
 *
 * Deliberately keyword-based rather than embedding-based: no extra service, no index
 * to keep in sync with an editable blueprint, and the failure mode (a slightly wrong
 * paragraph) is visible in the item rather than silent.
 */

import { tokenize } from './analysis/similarity';

export const DEFAULT_EXCERPT_CHARS = 6000;

export function splitParagraphs(source: string): string[] {
  return source
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Paragraphs from `source` most relevant to `query`, in original order, up to a
 * character budget. Original order matters: an excerpt reassembled by relevance
 * reads as non-sequitur and the model grounds itself worse on it.
 */
export function selectExcerpt(
  source: string | null | undefined,
  query: string,
  budget = DEFAULT_EXCERPT_CHARS
): string {
  const text = (source ?? '').trim();
  if (!text) return '';
  if (text.length <= budget) return text;

  const paragraphs = splitParagraphs(text);
  if (paragraphs.length <= 1) return text.slice(0, budget);

  const queryTerms = new Set(tokenize(query));

  const scored = paragraphs.map((p, index) => {
    const terms = tokenize(p);
    if (terms.length === 0) return { index, p, score: 0 };
    let hits = 0;
    const seen = new Set<string>();
    for (const t of terms) {
      if (queryTerms.has(t) && !seen.has(t)) {
        hits++;
        seen.add(t);
      }
    }
    // Normalize by length so a long paragraph does not win on volume alone.
    return { index, p, score: hits / Math.sqrt(terms.length) };
  });

  const ranked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen: typeof scored = [];
  let used = 0;
  for (const s of ranked) {
    if (used + s.p.length + 2 > budget) continue;
    chosen.push(s);
    used += s.p.length + 2;
    if (used >= budget) break;
  }

  if (chosen.length === 0) return text.slice(0, budget);

  return chosen
    .sort((a, b) => a.index - b.index)
    .map((s) => s.p)
    .join('\n\n');
}

/**
 * Concepts whose material is politically or ethically contested get extra prompt
 * constraints. Detected by keyword, and overridable by the user via source_note.
 */
const CONTESTED_MARKERS = [
  'socialism', 'capitalism', 'communism', 'marxis', 'abortion', 'immigration',
  'gun control', 'climate policy', 'affirmative action', 'israel', 'palestin',
  'taxation', 'welfare state', 'nationalism', 'feminism', 'race', 'religion',
  'euthanasia', 'drug policy', 'free speech', 'political',
];

export function looksContested(conceptName: string, sourceNote?: string | null): boolean {
  const hay = `${conceptName} ${sourceNote ?? ''}`.toLowerCase();
  if (hay.includes('[contested]')) return true;
  return CONTESTED_MARKERS.some((m) => hay.includes(m));
}
