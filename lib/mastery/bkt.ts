/**
 * Student model — Bayesian knowledge tracing, one estimate per cell.
 *
 * The whole point of collecting confidence (invariant 1) is that it modulates the
 * guess and slip parameters. Four states matter and a raw score collapses them:
 * right-and-confident, right-and-guessing, wrong-and-unsure, wrong-and-confident.
 */

export type Confidence = 'guessing' | 'unsure' | 'confident';

export const CONFIDENCE_VALUES: readonly Confidence[] = ['guessing', 'unsure', 'confident'];

export function isConfidence(v: unknown): v is Confidence {
  return typeof v === 'string' && (CONFIDENCE_VALUES as readonly string[]).includes(v);
}

export const BKT = {
  /** Probability an unmastered cell becomes mastered from this attempt. */
  P_TRANSIT: 0.15,
  /** Base slip rate. */
  P_SLIP: 0.1,
  /** Prior mastery for a fresh cell. */
  P_L0: 0.15,
  /** Guess rate for free response — there is nothing to guess from. */
  P_GUESS_FREE: 0.05,
  P_MIN: 0.01,
  P_MAX: 0.99,
  /** A cell counts as mastered at this posterior... */
  MASTERY_THRESHOLD: 0.95,
  /** ...and not before this many responses. Both conditions. */
  MASTERY_MIN_RESPONSES: 3,
} as const;

/** Base guess rate for an n-option multiple choice item. */
export function baseGuessRate(numOptions: number): number {
  return numOptions > 0 ? 1 / numOptions : BKT.P_GUESS_FREE;
}

export interface BktParams {
  pGuess: number;
  pSlip: number;
}

/**
 * Confidence modulates guess and slip. When the answer is correct only the guess
 * rate moves; when it is wrong only the slip rate moves.
 */
export function adjustParams(correct: boolean, confidence: Confidence, baseGuess: number): BktParams {
  const pSlipBase = BKT.P_SLIP;

  if (correct) {
    switch (confidence) {
      // Unlikely to be a guess — strong evidence for mastery.
      case 'confident':
        return { pGuess: baseGuess * 0.4, pSlip: pSlipBase };
      case 'unsure':
        return { pGuess: baseGuess * 1.0, pSlip: pSlipBase };
      // Probably luck — weak evidence.
      case 'guessing':
        return { pGuess: Math.max(baseGuess, 0.6), pSlip: pSlipBase };
    }
  }

  switch (confidence) {
    // Not a slip; a real misconception — strong evidence against.
    case 'confident':
      return { pGuess: baseGuess, pSlip: pSlipBase * 0.3 };
    case 'unsure':
      return { pGuess: baseGuess, pSlip: pSlipBase * 1.0 };
    // May be a slip or a blank — weak evidence.
    case 'guessing':
      return { pGuess: baseGuess, pSlip: pSlipBase * 1.5 };
  }
}

export interface BktInput {
  pL: number;
  correct: boolean;
  confidence: Confidence;
  /** Number of MC options, or 0 for free response. */
  numOptions: number;
}

export function bktUpdate(input: BktInput): number {
  const { pL, correct, confidence, numOptions } = input;
  const base = baseGuessRate(numOptions);
  const { pGuess, pSlip } = adjustParams(correct, confidence, base);

  const posterior = correct
    ? (pL * (1 - pSlip)) / (pL * (1 - pSlip) + (1 - pL) * pGuess)
    : (pL * pSlip) / (pL * pSlip + (1 - pL) * (1 - pGuess));

  const next = posterior + (1 - posterior) * BKT.P_TRANSIT;
  return clampMastery(next);
}

export function clampMastery(p: number): number {
  if (!Number.isFinite(p)) return BKT.P_L0;
  return Math.min(BKT.P_MAX, Math.max(BKT.P_MIN, p));
}

/**
 * Both conditions. The count guard stops two lucky answers from certifying a cell.
 */
export function isMastered(pMastery: number, responseCount: number): boolean {
  return pMastery >= BKT.MASTERY_THRESHOLD && responseCount >= BKT.MASTERY_MIN_RESPONSES;
}
