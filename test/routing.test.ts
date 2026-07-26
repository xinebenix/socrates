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
  STRATEGIES,
  STRONG_FROM_DEPTH,
  buildRequest,
  effortFor,
  modelFor,
  strategyName,
} from '../lib/llm/client';
import { buildMcItemCall } from '../lib/prompts/itemMc';
import { buildValidationCall } from '../lib/prompts/validate';

const VARS = [
  'GYM_STRATEGY',
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

describe('depth reaches the validator router but not the validator', () => {
  const base = {
    stem: 'Which of these is a subword unit?',
    optionTexts: ['alpha', 'beta', 'gamma', 'delta'],
    nodeDescription: 'What the vocabulary layer does.',
    sourceExcerpt: 'Tokens are subword units.',
  };

  it('routes on depth', () => {
    process.env.GYM_STRATEGY = 'split-gate';
    expect(buildRequest(buildValidationCall({ ...base, depth: 2 })).model).toBe('claude-sonnet-5');
    expect(buildRequest(buildValidationCall({ ...base, depth: 5 })).model).toBe('claude-opus-5');
  });

  it('sends a byte-identical payload regardless of depth', () => {
    // Telling the validator "this is a discrimination item" primes it to expect close
    // options. The value of a blind check is that it arrives with no expectations, so
    // depth must change the routing and nothing else.
    const shallow = buildValidationCall({ ...base, depth: 1 });
    const deep = buildValidationCall({ ...base, depth: 6 });
    const none = buildValidationCall(base);

    expect(deep.user).toBe(shallow.user);
    expect(deep.system).toBe(shallow.system);
    expect(none.user).toBe(shallow.user);

    for (const call of [shallow, deep]) {
      expect(call.user).not.toMatch(/depth/i);
      expect(call.user).not.toMatch(/\bD[1-6]\b/);
      expect(call.system).not.toMatch(/discriminat|boundary|critique/i);
    }
  });
});

describe('named strategies', () => {
  it('defaults to shipped, and ignores an unknown name rather than failing', () => {
    expect(strategyName()).toBe('shipped');
    process.env.GYM_STRATEGY = 'not-a-strategy';
    expect(strategyName()).toBe('shipped');
    process.env.GYM_STRATEGY = 'ECONOMY';
    expect(strategyName()).toBe('economy');
  });

  it('reference puts everything back on the strong model', () => {
    process.env.GYM_STRATEGY = 'reference';
    for (const depth of [1, 5]) {
      expect(modelFor('item', depth)).toBe('claude-opus-5');
      expect(modelFor('validate', depth)).toBe('claude-opus-5');
    }
    expect(modelFor('blueprint')).toBe('claude-opus-5');
    expect(modelFor('grade')).toBe('claude-opus-5');
  });

  it('split-gate validates shallow with Sonnet and deep with Opus', () => {
    process.env.GYM_STRATEGY = 'split-gate';
    expect(modelFor('validate', 1)).toBe('claude-sonnet-5');
    expect(modelFor('validate', 3)).toBe('claude-sonnet-5');
    expect(modelFor('validate', 4)).toBe('claude-opus-5');
    expect(modelFor('validate', 6)).toBe('claude-opus-5');
  });

  it('economy keeps the blueprint and the grader on the strong model', () => {
    process.env.GYM_STRATEGY = 'economy';
    expect(modelFor('item', 1)).toBe('claude-haiku-4-5-20251001');
    expect(modelFor('item', 5)).toBe('claude-sonnet-5');
    expect(modelFor('blueprint')).toBe('claude-opus-5');
    expect(modelFor('grade')).toBe('claude-opus-5');
  });

  it('floor gives up the grader, which is the one invariant-9 risk', () => {
    process.env.GYM_STRATEGY = 'floor';
    expect(modelFor('grade')).toBe('claude-sonnet-5');
    // The blueprint is the one thing even the floor keeps.
    expect(modelFor('blueprint')).toBe('claude-opus-5');
  });

  it('every strategy keeps the blueprint on the strong model', () => {
    for (const name of Object.keys(STRATEGIES)) {
      process.env.GYM_STRATEGY = name;
      expect(modelFor('blueprint'), `${name} must not downgrade the blueprint`).toBe(
        'claude-opus-5'
      );
    }
  });

  it('GYM_MODEL redefines what a strategy means by "strong"', () => {
    process.env.GYM_STRATEGY = 'split-gate';
    process.env.GYM_MODEL = 'claude-opus-4-1';
    expect(modelFor('blueprint')).toBe('claude-opus-4-1');
    expect(modelFor('validate', 5)).toBe('claude-opus-4-1');
    // Slots naming a literal model are unaffected.
    expect(modelFor('validate', 1)).toBe('claude-sonnet-5');
  });

  it('an explicit per-kind variable beats the strategy', () => {
    process.env.GYM_STRATEGY = 'floor';
    process.env.GYM_MODEL_GRADE = 'claude-opus-5';
    expect(modelFor('grade')).toBe('claude-opus-5');
    expect(modelFor('item', 1)).toBe('claude-haiku-4-5-20251001');
  });
});

describe('effort routing', () => {
  it('economises on the hot path and not on the gates', () => {
    expect(effortFor('item')).toBe('medium');
    expect(effortFor('blueprint')).toBe('high');
    expect(effortFor('validate')).toBe('high');
    expect(effortFor('grade')).toBe('high');
  });

  it('validates shallow items at low effort and deep ones at high', () => {
    expect(effortFor('validate', 1)).toBe('low');
    expect(effortFor('validate', 3)).toBe('low');
    expect(effortFor('validate', 4)).toBe('high');
    expect(effortFor('validate')).toBe('high');
    // The override moves both ends at once.
    process.env.GYM_EFFORT_VALIDATE = 'high';
    expect(effortFor('validate', 1)).toBe('high');
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
