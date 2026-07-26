import { describe, expect, it } from 'vitest';
import { adjustParams, baseGuessRate, BKT, bktUpdate, isMastered } from '../lib/mastery/bkt';

/** The worked examples from section 6, as unit tests. */
describe('BKT worked examples', () => {
  it('fresh cell, 4-option MC, correct with high confidence → 0.6716', () => {
    const { pGuess, pSlip } = adjustParams(true, 'confident', baseGuessRate(4));
    expect(pGuess).toBeCloseTo(0.1, 10);
    expect(pSlip).toBeCloseTo(0.1, 10);

    // posterior = (0.15 × 0.90) / (0.15 × 0.90 + 0.85 × 0.10) = 0.135 / 0.220
    const posterior = (0.15 * 0.9) / (0.15 * 0.9 + 0.85 * 0.1);
    expect(posterior).toBeCloseTo(0.6136, 4);

    const next = bktUpdate({ pL: 0.15, correct: true, confidence: 'confident', numOptions: 4 });
    expect(next).toBeCloseTo(0.6716, 4);
  });

  it('fresh cell, 4-option MC, wrong with high confidence → 0.1560', () => {
    const { pGuess, pSlip } = adjustParams(false, 'confident', baseGuessRate(4));
    expect(pSlip).toBeCloseTo(0.03, 10);
    expect(pGuess).toBeCloseTo(0.25, 10);

    const posterior = (0.15 * 0.03) / (0.15 * 0.03 + 0.85 * 0.75);
    expect(posterior).toBeCloseTo(0.007, 4);

    const next = bktUpdate({ pL: 0.15, correct: false, confidence: 'confident', numOptions: 4 });
    expect(next).toBeCloseTo(0.156, 4);
  });

  it('the asymmetry does real work: confident-right climbs, confident-wrong pins to the floor', () => {
    const right = bktUpdate({ pL: 0.15, correct: true, confidence: 'confident', numOptions: 4 });
    const wrong = bktUpdate({ pL: 0.15, correct: false, confidence: 'confident', numOptions: 4 });
    expect(right).toBeGreaterThan(0.6);
    expect(wrong).toBeLessThan(0.16);
  });
});

describe('confidence modulation', () => {
  it('a correct answer marked guessing barely moves mastery', () => {
    const guessing = bktUpdate({ pL: 0.15, correct: true, confidence: 'guessing', numOptions: 4 });
    const confident = bktUpdate({ pL: 0.15, correct: true, confidence: 'confident', numOptions: 4 });
    const unsure = bktUpdate({ pL: 0.15, correct: true, confidence: 'unsure', numOptions: 4 });

    expect(guessing).toBeLessThan(unsure);
    expect(unsure).toBeLessThan(confident);
    // p_G = max(0.25, 0.60) = 0.60
    expect(adjustParams(true, 'guessing', 0.25).pGuess).toBe(0.6);
  });

  it('a wrong answer marked guessing is treated as a possible slip', () => {
    const guessing = bktUpdate({ pL: 0.5, correct: false, confidence: 'guessing', numOptions: 4 });
    const confident = bktUpdate({ pL: 0.5, correct: false, confidence: 'confident', numOptions: 4 });
    expect(guessing).toBeGreaterThan(confident);
    expect(adjustParams(false, 'guessing', 0.25).pSlip).toBeCloseTo(0.15, 10);
  });

  it('free response uses a 0.05 guess rate, not 1/n', () => {
    expect(baseGuessRate(0)).toBe(BKT.P_GUESS_FREE);
  });

  it('clamps to [0.01, 0.99]', () => {
    let p: number = 0.99;
    for (let i = 0; i < 40; i++) {
      p = bktUpdate({ pL: p, correct: true, confidence: 'confident', numOptions: 4 });
    }
    expect(p).toBeLessThanOrEqual(0.99);

    let q: number = 0.5;
    for (let i = 0; i < 40; i++) {
      q = bktUpdate({ pL: q, correct: false, confidence: 'confident', numOptions: 4 });
    }
    expect(q).toBeGreaterThanOrEqual(0.01);
  });
});

describe('mastery threshold', () => {
  it('requires both a high posterior and at least three responses', () => {
    expect(isMastered(0.97, 3)).toBe(true);
    expect(isMastered(0.97, 2)).toBe(false);
    expect(isMastered(0.94, 9)).toBe(false);
  });

  it('two lucky answers cannot certify a cell', () => {
    let p: number = BKT.P_L0;
    p = bktUpdate({ pL: p, correct: true, confidence: 'confident', numOptions: 4 });
    p = bktUpdate({ pL: p, correct: true, confidence: 'confident', numOptions: 4 });
    expect(isMastered(p, 2)).toBe(false);
  });
});
