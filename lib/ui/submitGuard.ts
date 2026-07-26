import type { Confidence } from '../mastery/bkt';
import type { Dict } from '../i18n/dict';

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

/**
 * Which hint to show, as a dictionary key rather than a sentence — the hint sits in the
 * answer surface, so returning English from here left one untranslated line under the
 * submit button in the Chinese interface.
 */
export function submitHintKey(s: SubmitState): keyof Dict['session'] {
  if (s.kind === 'mc' && s.selectedOptionId === null) return 'submitHintChooseOption';
  if (s.kind === 'free' && s.freeText.trim().length === 0) return 'submitHintWriteAnswer';
  if (s.confidence === null) return 'submitHintConfidence';
  return 'submitHintReady';
}
