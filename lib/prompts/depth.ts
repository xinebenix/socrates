/**
 * The depth ladder. Fixed and generic across all concepts.
 *
 * D1-D5 are multiple choice. D6 is free response only — recognition cannot assess
 * critique, and attempting to MC it produces items that look deep and test nothing.
 */

export interface Depth {
  level: number;
  name: string;
  short: string;
  definition: string;
  /** Appended to the item-generation prompt for this level. */
  instruction: string;
}

export const DEPTHS: Depth[] = [
  {
    level: 1,
    name: 'Recall',
    short: 'D1',
    definition: 'State the definition, components, or key claim from memory.',
    instruction:
      'D1 Recall: the stem must ask for a definition, a component, or a stated claim. ' +
      'Distractors should be adjacent definitions the learner may have substituted — not nonsense.',
  },
  {
    level: 2,
    name: 'Comprehension',
    short: 'D2',
    definition: 'Recognize a correct restatement; identify the parts and how they relate.',
    instruction:
      'D2 Comprehension: the stem must require recognizing a faithful restatement or identifying ' +
      'how the parts relate. Distractors should be restatements that drift in a specific, ' +
      'diagnosable way — a relation reversed, a part promoted to the whole.',
  },
  {
    level: 3,
    name: 'Application',
    short: 'D3',
    definition: 'Apply the concept to a case not seen before.',
    instruction:
      'D3 Application: the stem must present a concrete case that does not appear in the source ' +
      'and ask what follows. Distractors should be the conclusions a learner reaches by applying ' +
      'the concept slightly wrongly to that same case.',
  },
  {
    level: 4,
    name: 'Boundary',
    short: 'D4',
    definition: 'Identify where the concept stops holding, its edge conditions and exceptions.',
    instruction:
      'D4 Boundary: the stem must probe where the concept stops holding — an edge condition, an ' +
      'exception, a case just outside the definition. Distractors should be cases a learner who ' +
      'has not located the boundary would place on the wrong side of it.',
  },
  {
    level: 5,
    name: 'Discrimination',
    short: 'D5',
    definition: 'Distinguish it from its nearest confusable neighbors.',
    instruction:
      'D5 Discrimination: the stem must force a choice between this concept and its nearest ' +
      'neighbors. The distractors should be cases correctly described by the *neighboring* ' +
      'concept, so that only someone who can draw the boundary gets it right.',
  },
  {
    level: 6,
    name: 'Critique',
    short: 'D6',
    definition:
      'Steelman, find the flaw in a plausible misuse, state what would falsify it.',
    instruction:
      'D6 Critique: production, not recognition. See the free-response contract.',
  },
];

export function depth(level: number): Depth {
  const d = DEPTHS.find((x) => x.level === level);
  if (!d) throw new Error(`unknown depth level ${level}`);
  return d;
}

export const MC_DEPTHS = [1, 2, 3, 4, 5];
export const FREE_DEPTH = 6;

export function depthLadderText(): string {
  return DEPTHS.map((d) => `${d.short} — ${d.name}. ${d.definition}`).join('\n');
}
