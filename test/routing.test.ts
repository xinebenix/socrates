/**
 * Which model and which effort each call site gets.
 *
 * This is a cost and latency policy expressed in code, and it is the kind of thing
 * that gets "simplified" into one global setting by someone who does not know why the
 * asymmetry is there. The asymmetry is the point: writing a D1 recall item against a
 * finished blueprint is not the same work as drawing the blueprint or gating an item.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ITEM_MODEL,
  STRONG_FROM_DEPTH,
  buildRequest,
  effortFor,
  modelFor,
} from '../lib/llm/client';
import { buildMcItemCall } from '../lib/prompts/itemMc';
import { buildValidationCall } from '../lib/prompts/validate';

const VARS = [
  'GYM_MODEL',
  'GYM_MODEL_ITEM',
  'GYM_MODEL_BLUEPRINT',
  'GYM_MODEL_VALIDATE',
  'GYM_MODEL_GRADE',
  'GYM_EFFORT_ITEM',
  'GYM_EFFORT_VALIDATE',
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

describe('model routing', () => {
  it('sends the shallow depths to the smaller model and the deep ones to the strong one', () => {
    for (const depth of [1, 2, 3]) {
      expect(modelFor('item', depth)).toBe(DEFAULT_ITEM_MODEL);
    }
    // D4 boundary and D5 discrimination live or die on nearly-right distractors,
    // which is exactly the judgment worth paying for.
    for (const depth of [STRONG_FROM_DEPTH, 5, 6]) {
      expect(modelFor('item', depth)).toBe('claude-opus-5');
    }
  });

  it('keeps the blueprint, the validator and the grader on the strong model', () => {
    expect(modelFor('blueprint')).toBe('claude-opus-5');
    expect(modelFor('validate')).toBe('claude-opus-5');
    expect(modelFor('grade')).toBe('claude-opus-5');
  });

  it('lets GYM_MODEL move everything that has not been named individually', () => {
    process.env.GYM_MODEL = 'claude-fable-5';
    expect(modelFor('blueprint')).toBe('claude-fable-5');
    expect(modelFor('validate')).toBe('claude-fable-5');
    // The depth rule is a property of the default, so it still applies underneath.
    expect(modelFor('item', 1)).toBe(DEFAULT_ITEM_MODEL);
    expect(modelFor('item', 5)).toBe('claude-fable-5');
  });

  it('an explicit item model overrides the depth rule at every depth', () => {
    process.env.GYM_MODEL_ITEM = 'claude-haiku-4-5-20251001';
    for (const depth of [1, 3, 4, 5, 6]) {
      expect(modelFor('item', depth)).toBe('claude-haiku-4-5-20251001');
    }
  });

  it('per-call-site variables beat the global one', () => {
    process.env.GYM_MODEL = 'claude-sonnet-5';
    process.env.GYM_MODEL_BLUEPRINT = 'claude-opus-5';
    expect(modelFor('blueprint')).toBe('claude-opus-5');
    expect(modelFor('grade')).toBe('claude-sonnet-5');
  });

  it('reaches the wire, not just the helper', () => {
    const shallow = buildRequest(
      buildMcItemCall({
        nodeTitle: 'Tokenization',
        nodeDescription: 'What the vocabulary layer does.',
        depthLevel: 1,
        sourceExcerpt: 'Tokens are subword units.',
        misconceptions: [],
        recentStems: [],
        activeMisconceptionLabels: [],
        deadDistractorNote: null,
      })
    );
    expect(shallow.model).toBe(DEFAULT_ITEM_MODEL);

    const deep = buildRequest(
      buildMcItemCall({
        nodeTitle: 'Tokenization',
        nodeDescription: 'What the vocabulary layer does.',
        depthLevel: 5,
        sourceExcerpt: 'Tokens are subword units.',
        misconceptions: [],
        recentStems: [],
        activeMisconceptionLabels: [],
        deadDistractorNote: null,
      })
    );
    expect(deep.model).toBe('claude-opus-5');

    // The gate does not get downgraded along with the thing it is gating.
    const gate = buildRequest(
      buildValidationCall({
        stem: 'Which of these is a subword unit?',
        optionTexts: ['a', 'b', 'c', 'd'],
        nodeDescription: 'What the vocabulary layer does.',
        sourceExcerpt: 'Tokens are subword units.',
      })
    );
    expect(gate.model).toBe('claude-opus-5');
  });
});

describe('effort routing', () => {
  it('economises on the hot path and not on the gates', () => {
    expect(effortFor('item')).toBe('medium');
    expect(effortFor('blueprint')).toBe('high');
    expect(effortFor('validate')).toBe('high');
    expect(effortFor('grade')).toBe('high');
  });

  it('accepts a valid override and ignores nonsense', () => {
    process.env.GYM_EFFORT_ITEM = 'xhigh';
    expect(effortFor('item')).toBe('xhigh');

    process.env.GYM_EFFORT_ITEM = 'HIGH';
    expect(effortFor('item')).toBe('high');

    for (const bad of ['turbo', '3', '']) {
      process.env.GYM_EFFORT_ITEM = bad;
      expect(effortFor('item')).toBe('medium');
    }
  });
});
