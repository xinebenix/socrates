/**
 * Spacing — SM-2 family, applied per cell after every response.
 */

import { addDays, iso } from '../clock';

export const SCHEDULE = {
  EASE_MIN: 1.3,
  EASE_MAX: 3.0,
  EASE_STEP_UP: 0.05,
  EASE_STEP_DOWN: 0.2,
  EASE_DEFAULT: 2.5,
  INTERVAL_CAP_DAYS: 180,
} as const;

export interface ScheduleState {
  intervalDays: number;
  ease: number;
  consecutiveCorrect: number;
}

export interface ScheduleResult extends ScheduleState {
  nextDueAt: string;
}

/**
 * The update order matters and is asserted in the acceptance tests: the interval is
 * multiplied by the ease value *in effect before this response*, and only then is
 * ease incremented.
 */
export function scheduleUpdate(state: ScheduleState, correct: boolean, now: Date): ScheduleResult {
  let { intervalDays, ease, consecutiveCorrect } = state;

  if (correct) {
    if (intervalDays === 0) {
      intervalDays = 1;
    } else if (intervalDays === 1) {
      intervalDays = 3;
    } else {
      intervalDays = intervalDays * ease;
    }
    ease = Math.min(SCHEDULE.EASE_MAX, ease + SCHEDULE.EASE_STEP_UP);
    consecutiveCorrect += 1;
  } else {
    intervalDays = 1;
    ease = Math.max(SCHEDULE.EASE_MIN, ease - SCHEDULE.EASE_STEP_DOWN);
    consecutiveCorrect = 0;
  }

  intervalDays = Math.min(SCHEDULE.INTERVAL_CAP_DAYS, intervalDays);

  return {
    intervalDays,
    ease,
    consecutiveCorrect,
    nextDueAt: iso(addDays(now, intervalDays)),
  };
}
