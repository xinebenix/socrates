import type { JsonSchema } from '../llm/schema';
import { effortFor, modelFor, type StructuredCall } from '../llm/client';
import { depth } from './depth';

export interface McItemInput {
  nodeTitle: string;
  nodeDescription: string;
  depthLevel: number;
  sourceExcerpt: string;
  misconceptions: { label: string; description: string }[];
  /** Stems of the last 5 items served for this cell. */
  recentStems: string[];
  /** Misconceptions currently active for this node — remediation puts them back on screen. */
  activeMisconceptionLabels: string[];
  /** Set when a prior attempt produced a dead distractor we are asking to be replaced. */
  deadDistractorNote?: string | null;
}

export interface McOptionOut {
  text: string;
  is_correct: boolean;
  misconception_label: string | null;
  rationale: string;
}

export interface McItemOut {
  stem: string;
  options: McOptionOut[];
  explanation: string;
}

export const MC_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stem', 'options', 'explanation'],
  properties: {
    stem: { type: 'string' },
    options: {
      type: 'array',
      'x-minItems': 4,
      'x-maxItems': 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'is_correct', 'misconception_label', 'rationale'],
        properties: {
          text: { type: 'string' },
          is_correct: { type: 'boolean' },
          misconception_label: {
            type: ['string', 'null'] as unknown as string,
            description:
              'The misconception this distractor is drawn from. Null only for the correct option.',
          },
          rationale: { type: 'string' },
        },
      },
    },
    explanation: { type: 'string' },
  },
};

const SYSTEM = `Write one multiple-choice item testing the given node at the given depth. Exactly 4
options, exactly one correct.

Every incorrect option must be tagged to one of the supplied misconceptions and must
be the answer a learner holding *that specific belief* would choose. Do not invent
generically wrong answers. If you cannot build 3 distractors from the supplied
misconceptions, propose a new one explicitly in \`misconception_label\` — use a short
handle that does not appear in the supplied list, and make the rationale state the
belief plainly so it can be reviewed.

Distractors must be plausible enough to be chosen by someone who nearly understands
this. An option that is obviously wrong is dead weight: it silently converts a
4-option item into a 3-option item and inflates the guess rate. Test each distractor
by asking "what would someone have to believe to pick this?" If the answer is
"nothing coherent", replace it.

The item must not be answerable without domain knowledge. Specifically: all options
similar in length and grammatical form; no absolute qualifiers ("always", "never")
that mark an option as wrong on style alone; no option that restates the stem; no
"all of the above".

Do not reproduce or lightly paraphrase any of the recent stems supplied. Vary the
surface form — case-based, comparative, negative-stem, applied — while testing the
same underlying cell.

\`rationale\` for each option: for the correct one, why it is correct; for each
distractor, the specific belief it reflects and precisely where that belief goes
wrong. These are shown to the learner and carry most of the instructional value.

\`explanation\` covers the correct answer and the idea behind it in two to four
sentences. It is shown after answering, alongside the per-option rationales.

Set \`misconception_label\` to null on the correct option and only on the correct option.`;

export function buildMcItemCall(input: McItemInput): StructuredCall {
  const d = depth(input.depthLevel);

  const bank = input.misconceptions.length
    ? input.misconceptions.map((m) => `- ${m.label}: ${m.description}`).join('\n')
    : '(empty — you will have to propose all three, and flag them)';

  const recent = input.recentStems.length
    ? input.recentStems.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(none yet)';

  const active = input.activeMisconceptionLabels.length
    ? `\n\n<active_misconceptions>\nThe learner has recently selected these beliefs more than once. At least one\ndistractor must put one of them back in the option set, so we can see whether it is\nactually corrected rather than merely avoided:\n${input.activeMisconceptionLabels
        .map((l) => `- ${l}`)
        .join('\n')}\n</active_misconceptions>`
    : '';

  const deadNote = input.deadDistractorNote
    ? `\n\n<revision_note>\nA previous attempt at this item was flagged by a blind reviewer: ${input.deadDistractorNote}\nReplace the implausible option with one a learner could actually be drawn to.\n</revision_note>`
    : '';

  return {
    name: `item-mc-${d.short}`,
    system: `${SYSTEM}\n\n${d.instruction}`,
    user:
      `<node>\n<title>${input.nodeTitle}</title>\n<description>${input.nodeDescription}</description>\n</node>\n\n` +
      `<depth>${d.short} — ${d.name}: ${d.definition}</depth>\n\n` +
      `<source_excerpt>\n${input.sourceExcerpt || '(no source material available for this node)'}\n</source_excerpt>\n\n` +
      `<misconception_bank>\n${bank}\n</misconception_bank>\n\n` +
      `<recent_stems>\n${recent}\n</recent_stems>` +
      active +
      deadNote,
    schema: MC_ITEM_SCHEMA,
    maxTokens: 8000,
    effort: effortFor('item'),
    model: modelFor('item', input.depthLevel),
  };
}
