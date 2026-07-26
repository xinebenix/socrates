import type { Confidence } from '../mastery/bkt';

export interface SubmitState {
  kind: 'mc' | 'free';
  phase: 'answering' | 'feedback';
  selectedOptionId: number | null;
  freeText: string;
  confidence: Confidence | null;
  submitting: boolean;
}

/**
 * Invariant 1: the user selects one of {guessing, unsure, confident} before the
 * answer can be submitted. Not a nudge, not a default — a hard gate.
 *
 * Invariant 2: once the phase is 'feedback' the response is final, so nothing is
 * submittable from there either.
 */
export function canSubmit(s: SubmitState): boolean {
  if (s.phase !== 'answering') return false;
  if (s.submitting) return false;
  if (s.confidence === null) return false;
  if (s.kind === 'mc') return s.selectedOptionId !== null;
  return s.freeText.trim().length > 0;
}

export function submitHint(s: SubmitState): string {
  if (s.kind === 'mc' && s.selectedOptionId === null) {
    return 'Choose an option. Number keys work too.';
  }
  if (s.kind === 'free' && s.freeText.trim().length === 0) {
    return 'Write your answer.';
  }
  if (s.confidence === null) {
    return 'How sure are you? Answer that before you submit — it is half the signal.';
  }
  return 'Ready. Press Enter.';
}
