import type { JsonSchema } from '../llm/schema';
import { effortFor, modelFor, type StructuredCall } from '../llm/client';
import { depthLadderText } from './depth';

export interface BlueprintInput {
  conceptName: string;
  sourceText: string;
  hints?: string | null;
  /** Contested or politically loaded concepts get an extra section of constraints. */
  contested?: boolean;
}

export interface BlueprintNodeOut {
  title: string;
  description: string;
  applicable_depths: number[];
  misconceptions: { label: string; description: string }[];
}

export interface BlueprintOut {
  nodes: BlueprintNodeOut[];
  gaps: string[];
}

export const BLUEPRINT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes', 'gaps'],
  properties: {
    nodes: {
      type: 'array',
      'x-minItems': 4,
      'x-maxItems': 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'applicable_depths', 'misconceptions'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          applicable_depths: {
            type: 'array',
            'x-minItems': 1,
            items: { type: 'integer', enum: [1, 2, 3, 4, 5, 6] },
          },
          misconceptions: {
            type: 'array',
            'x-minItems': 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'description'],
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
    },
    gaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Places the source is silent where a node would otherwise belong.',
    },
  },
};

const SYSTEM = `You are decomposing a concept into a knowledge blueprint for a testing system.

Produce 6-12 nodes covering the concept's breadth. Nodes must be *disjoint* — a fact
should belong to exactly one node — and *collectively exhaustive* over the source
material.

Ground every node in the supplied source. Do not add nodes from general knowledge
that the source does not support; if the source has a gap, say so in the \`gaps\` field
rather than silently filling it.

For each node also list 3-6 misconceptions: specific wrong beliefs a learner
plausibly holds about *this node*. State each in the first person, as the learner
would hold it ("Socialism just means the government provides services"), not as a
description of an error. These become the distractor bank, so vagueness here degrades
every downstream item. Prefer misconceptions that are *nearly right* — a true claim
misapplied, a correct distinction drawn in the wrong place, a neighboring concept
substituted — over crude errors nobody holds.

The \`label\` is a short handle (a few words). The \`description\` is the belief itself,
first person, one or two sentences.

For each node, state which of D1-D6 are meaningfully applicable in \`applicable_depths\`.
Not every node supports a boundary or discrimination question. The ladder is:

${depthLadderText()}`;

const CONTESTED = `

This concept is contested. The blueprint must be usable by someone on any side of the
dispute. Nodes should cover the positions and the strongest arguments in each
direction. A "misconception" is an error about what a position *claims* or what the
evidence *shows* — never a disagreement with a position. Do not encode a political
conclusion as a fact.`;

export function buildBlueprintCall(input: BlueprintInput): StructuredCall {
  const source = input.sourceText.trim();
  const sourceBlock = source
    ? `<source>\n${source}\n</source>`
    : `<source>\n(No source material was supplied. This is a degraded mode: ground the ` +
      `decomposition in widely agreed treatments of the concept, and list in \`gaps\` every ` +
      `place where a source would have been needed to draw the node properly.)\n</source>`;

  const hints = input.hints?.trim()
    ? `\n\n<user_hints>\n${input.hints.trim()}\n</user_hints>`
    : '';

  return {
    name: 'blueprint',
    system: SYSTEM + (input.contested ? CONTESTED : ''),
    user: `Concept: ${input.conceptName}\n\n${sourceBlock}${hints}`,
    schema: BLUEPRINT_SCHEMA,
    maxTokens: 32000,
    effort: effortFor('blueprint'),
    model: modelFor('blueprint'),
  };
}
