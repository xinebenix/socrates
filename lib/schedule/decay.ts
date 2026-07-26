/**
 * Decay — applied at read time, never written back.
 *
 * `p_mastery` in the database is the latent estimate. What the UI shows and what
 * selection uses is that estimate discounted by how long it has been sitting.
 */

import { daysBetween, parseIso } from '../clock';

const LN2 = Math.LN2;

/**
 * Probability of successful recall right now. Halves at one interval.
 * A cell that has never been tested has nothing to decay — R = 1.
 */
export function retrievability(
  lastTestedAt: string | null,
  intervalDays: number,
  now: Date
): number {
  const last = parseIso(lastTestedAt);
  if (!last) return 1;
  const days = Math.max(0, daysBetween(last, now));
  const denom = Math.max(intervalDays, 1);
  return Math.exp(-LN2 * (days / denom));
}

export function effectiveMastery(
  pMastery: number,
  lastTestedAt: string | null,
  intervalDays: number,
  now: Date
): number {
  return pMastery * retrievability(lastTestedAt, intervalDays, now);
}

export function isDue(nextDueAt: string | null, now: Date): boolean {
  const due = parseIso(nextDueAt);
  if (!due) return false;
  return now.getTime() >= due.getTime();
}

/**
 * How far past due, in units of the cell's own interval. Used for sorting the
 * due queue — a cell with a 1-day interval three days late is more urgent than a
 * cell with a 90-day interval three days late.
 */
export function overdueness(nextDueAt: string | null, intervalDays: number, now: Date): number {
  const due = parseIso(nextDueAt);
  if (!due) return 0;
  const lateDays = daysBetween(due, now);
  return lateDays / Math.max(intervalDays, 1);
}
