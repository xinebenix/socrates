import type { JsonSchema } from '../llm/schema';
import type { StructuredCall } from '../llm/client';
import type { RubricCriterion } from '../db/types';

export const FREE_PASS_THRESHOLD = 0.8;

export interface GradeFreeInput {
  stem: string;
  rubric: RubricCriterion[];
  answerText: string;
  contested?: boolean;
}

export const GRADER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria', 'missing', 'misconceptions_detected', 'score', 'verdict_summary'],
  properties: {
    criteria: {
      type: 'array',
      'x-minItems': 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'met', 'evidence_quote', 'comment'],
        properties: {
          id: { type: 'string' },
          met: { type: 'boolean' },
          evidence_quote: {
            type: ['string', 'null'] as unknown as string,
            description: 'Verbatim span from the answer. Null when the criterion is not met.',
          },
          comment: { type: 'string' },
        },
      },
    },
    missing: { type: 'array', items: { type: 'string' } },
    misconceptions_detected: { type: 'array', items: { type: 'string' } },
    score: { type: 'number', description: 'Fraction of criteria met, 0 to 1.' },
    verdict_summary: { type: 'string' },
  },
};

/**
 * Invariant 9: the free-response grader is uncharitable.
 *
 * Charitable grading converts a failed retrieval into a passed one and is the single
 * most destructive failure mode available to this system. Every constraint below is
 * load-bearing; do not soften them.
 */
const SYSTEM = `You are grading a written answer against a rubric. You are not a tutor and not an
encouraging one. Your single job is to determine what this answer *actually
demonstrates*, not what its author probably knows.

Rules, in order of importance:

1. Grade only what is literally written. Do not infer, reconstruct, complete, or
   charitably interpret. If a claim is gestured at but not stated, it is not met.
2. A criterion is met only if you can quote the specific span of the answer that
   meets it. If you cannot produce the quote, \`met\` is false. No exceptions. The
   quote must appear verbatim in the answer; do not paraphrase it into existence.
3. Vagueness is failure, not partial credit. "It's about who owns things" does not
   meet a criterion requiring the ownership distinction; it names the topic without
   making the distinction.
4. Correct terminology used without correct application does not meet a criterion.
   Name-dropping is not knowledge.
5. In \`missing\`, state precisely what was absent — not "could be more detailed" but
   the specific claim, distinction, or step that was not made.
6. In \`misconceptions_detected\`, list any wrong belief the answer positively reveals.
   This is distinct from omission and more important.

Return one entry in \`criteria\` for every rubric criterion, keyed by its id, in the
order given. \`score\` is the fraction of criteria met — met count divided by total
count — and nothing else. Do not adjust it upward for effort, length, or promise.

The learner is best served by an accurate account of where they actually are.
Inflating this grade removes the only thing this exercise produces.`;

const CONTESTED = `

Where the material is contested, grade the *quality of the reasoning and the accuracy
of the representation*, never agreement with any position. An answer arguing a side
you find unpersuasive, but doing so accurately and with the strongest form of the
argument, is a good answer.`;

export function buildGradeFreeCall(input: GradeFreeInput): StructuredCall {
  const rubric = input.rubric
    .map((c) => `- [${c.id}] ${c.criterion}\n  (why it matters: ${c.why_it_matters})`)
    .join('\n');

  return {
    name: 'grade-free',
    system: SYSTEM + (input.contested ? CONTESTED : ''),
    user:
      `<prompt_shown_to_learner>\n${input.stem}\n</prompt_shown_to_learner>\n\n` +
      `<rubric>\n${rubric}\n</rubric>\n\n` +
      `<learner_answer>\n${input.answerText}\n</learner_answer>`,
    schema: GRADER_SCHEMA,
    maxTokens: 8000,
    effort: 'high',
  };
}

/** The grader's own arithmetic is not trusted; the score is recomputed from `criteria`. */
export function scoreFromCriteria(criteria: { met: boolean }[]): number {
  if (criteria.length === 0) return 0;
  return criteria.filter((c) => c.met).length / criteria.length;
}
