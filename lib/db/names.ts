/**
 * Concept name normalisation.
 *
 * Its own module because both the query layer and the migration need it, and importing
 * one from the other would close a cycle through `lib/db/index.ts`.
 *
 * This is the key two people's concepts are matched on, so it decides when someone joins
 * an existing bank rather than paying to build a second one. Deliberately conservative:
 * case, surrounding space and internal runs of whitespace are noise, everything else is
 * signal. No stemming, no synonym table, no fuzzy distance — "LLM" and "Large Language
 * Models" stay separate concepts, because silently merging them would hand somebody a
 * blueprint they did not ask for and cannot easily tell apart from one they did.
 */
export function conceptNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
