import type { JsonSchema } from '../llm/schema';
import { effortFor, modelFor, type StructuredCall } from '../llm/client';
import type { ValidatorVerdict } from '../db/types';

/**
 * Invariant 3: the validator does not see the intended answer key.
 *
 * This is a separate LLM call that independently solves the item. Agreement between
 * generator and validator is the gate for serving it. A validator shown the key will
 * rationalize a broken item.
 *
 * `ValidationInput` deliberately has no field for the keyed answer, the per-option
 * reasoning, or the post-answer text. Acceptance test 3 asserts on the serialized
 * request body — those strings must not appear anywhere in it, including in the
 * system prompt and the schema.
 */
export interface ValidationInput {
  stem: string;
  /** The 4 option texts, in randomized order. */
  optionTexts: string[];
  nodeDescription: string;
  sourceExcerpt: string;
}

export const VALIDATOR_FLAGS = [
  'ambiguous',
  'no_correct_answer',
  'dead_distractor',
  'surface_cue',
  'unsupported',
  'duplicate_options',
] as const;

export type ValidatorFlag = (typeof VALIDATOR_FLAGS)[number];

/** A dead_distractor alone does not block; these do. */
export const BLOCKING_FLAGS: ValidatorFlag[] = [
  'ambiguous',
  'no_correct_answer',
  'surface_cue',
  'unsupported',
];

export const VALIDATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['best_option', 'defensible_options', 'flags', 'notes'],
  properties: {
    best_option: {
      type: 'integer',
      enum: [1, 2, 3, 4],
      description: 'The 1-based position of the option you would choose.',
    },
    defensible_options: {
      type: 'array',
      'x-minItems': 1,
      items: { type: 'integer', enum: [1, 2, 3, 4] },
    },
    flags: {
      type: 'array',
      items: { type: 'string', enum: [...VALIDATOR_FLAGS] },
    },
    notes: { type: 'string' },
  },
};

const SYSTEM = `Answer this multiple-choice item as an expert on the supplied material. Then audit it.

You have not been told which option the item's author intended. Solve it yourself.

Report \`best_option\` — the 1-based position of the option you would choose — and
\`defensible_options\`, every option for which a competent person could construct a
serious defense. If exactly one option is defensible, \`defensible_options\` should
contain only that one.

Flag any of the following that apply:
- ambiguous — more than one defensible answer
- no_correct_answer — none of the four is defensible
- dead_distractor — an option so implausible it can be eliminated without knowing the
  topic. Name which position in \`notes\`.
- surface_cue — the answer is inferable from length, grammar, specificity, or phrasing
  alone
- unsupported — the option you chose is not supported by the source material
- duplicate_options — two options say the same thing

Put your reasoning, and any position numbers a flag refers to, in \`notes\`.`;

export function buildValidationCall(input: ValidationInput): StructuredCall {
  const options = input.optionTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');

  return {
    name: 'validate-mc',
    system: SYSTEM,
    user:
      `<node_description>\n${input.nodeDescription}\n</node_description>\n\n` +
      `<source_excerpt>\n${input.sourceExcerpt || '(no source material available for this node)'}\n</source_excerpt>\n\n` +
      `<item>\n<stem>${input.stem}</stem>\n<options>\n${options}\n</options>\n</item>`,
    schema: VALIDATION_SCHEMA,
    maxTokens: 4000,
    effort: effortFor('validate'),
    model: modelFor('validate'),
  };
}

export interface GateResult {
  pass: boolean;
  /** Set when the only problem is a dead distractor: worth one regeneration attempt. */
  regenerateOption: boolean;
  reasons: string[];
}

/**
 * Serve the item only if the validator picked the keyed answer, found exactly one
 * defensible option, and raised no blocking flag.
 */
export function gate(verdict: ValidatorVerdict, keyedPosition: number): GateResult {
  const reasons: string[] = [];

  if (verdict.best_option !== keyedPosition) {
    reasons.push(
      `validator chose option ${verdict.best_option}, key is option ${keyedPosition}`
    );
  }
  if (verdict.defensible_options.length !== 1) {
    reasons.push(`${verdict.defensible_options.length} defensible options`);
  }

  const blocking = verdict.flags.filter((f) => (BLOCKING_FLAGS as string[]).includes(f));
  for (const f of blocking) reasons.push(`flag: ${f}`);

  const deadOnly = reasons.length === 0 && verdict.flags.includes('dead_distractor');

  return {
    pass: reasons.length === 0 && !deadOnly,
    regenerateOption: deadOnly,
    reasons,
  };
}
