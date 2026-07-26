/**
 * Stem similarity — the guard behind invariant 6.
 *
 * Passing the recent stems into the generation prompt asks for variety; this
 * measures whether we got it. A stem scoring above the threshold against anything
 * recent is thrown away and regenerated, so "never reused verbatim" is enforced by
 * the pipeline rather than hoped for from the model.
 */

export const SIMILARITY_THRESHOLD = 0.9;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'which',
  'with', 'would', 'this', 'these', 'those', 'not',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Bigrams over the content tokens — catches reordering that a bag of words misses. */
function bigrams(tokens: string[]): string[] {
  if (tokens.length < 2) return tokens;
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function dice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let overlap = 0;
  for (const y of b) {
    const c = counts.get(y) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(y, c - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

/**
 * 1.0 for identical strings, 0.0 for no shared content. Blends unigram and bigram
 * overlap so that a shuffled sentence does not read as novel.
 */
export function similarity(a: string, b: string): number {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return 1;

  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return na === nb ? 1 : 0;

  const uni = dice(ta, tb);
  const bi = dice(bigrams(ta), bigrams(tb));
  return 0.5 * uni + 0.5 * bi;
}

export function maxSimilarity(candidate: string, previous: string[]): number {
  return previous.reduce((max, p) => Math.max(max, similarity(candidate, p)), 0);
}

export function tooSimilar(
  candidate: string,
  previous: string[],
  threshold = SIMILARITY_THRESHOLD
): boolean {
  return maxSimilarity(candidate, previous) > threshold;
}
