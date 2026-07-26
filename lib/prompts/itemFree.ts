import type { JsonSchema } from '../llm/schema';
import { effortFor, modelFor, type StructuredCall } from '../llm/client';

export interface FreeItemInput {
  nodeTitle: string;
  nodeDescription: string;
  sourceExcerpt: string;
  misconceptions: { label: string; description: string }[];
  /** Stems of the last 3 D6 items for this node. */
  recentStems: string[];
  contested?: boolean;
}

export interface FreeItemOut {
  stem: string;
  rubric: { id: string; criterion: string; why_it_matters: string }[];
}

export const FREE_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stem', 'rubric'],
  properties: {
    stem: { type: 'string' },
    rubric: {
      type: 'array',
      'x-minItems': 4,
      'x-maxItems': 7,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'criterion', 'why_it_matters'],
        properties: {
          id: { type: 'string', description: 'Short stable handle, e.g. "c1".' },
          criterion: { type: 'string' },
          why_it_matters: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `Write one free-response prompt testing this node at D6 (critique). It must demand
production, not recognition. Use one of these forms: steelman a position and then
state its strongest objection; identify the flaw in a supplied plausible-but-wrong
argument; state what observation would falsify the claim; explain why a specific real
case is or is not an instance, given a definition the learner must supply themselves.

Then write 4-7 rubric criteria. Each must be independently checkable against the
text of an answer — a grader must be able to point at a span and say met or not met.
"Shows deep understanding" is not a criterion. "States that social ownership and state
ownership are distinct, and gives at least one case separating them" is.

At least one criterion must require the learner to state something the misconception
list shows they might get wrong.

Do not reuse or lightly paraphrase any recent stem supplied.`;

const CONTESTED = `

Where the material is contested, criteria must be satisfiable from more than one
position. Never write a criterion that can only be met by agreeing with a particular
side.`;

export function buildFreeItemCall(input: FreeItemInput): StructuredCall {
  const bank = input.misconceptions.length
    ? input.misconceptions.map((m) => `- ${m.label}: ${m.description}`).join('\n')
    : '(empty)';
  const recent = input.recentStems.length
    ? input.recentStems.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(none yet)';

  return {
    name: 'item-free-D6',
    system: SYSTEM + (input.contested ? CONTESTED : ''),
    user:
      `<node>\n<title>${input.nodeTitle}</title>\n<description>${input.nodeDescription}</description>\n</node>\n\n` +
      `<source_excerpt>\n${input.sourceExcerpt || '(no source material available for this node)'}\n</source_excerpt>\n\n` +
      `<misconception_bank>\n${bank}\n</misconception_bank>\n\n` +
      `<recent_stems>\n${recent}\n</recent_stems>`,
    schema: FREE_ITEM_SCHEMA,
    maxTokens: 8000,
    effort: effortFor('item'),
    // D6 is critique — always the strong model.
    model: modelFor('item', 6),
  };
}
