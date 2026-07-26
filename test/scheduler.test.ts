import { describe, expect, it } from 'vitest';
import { SCHEDULE, scheduleUpdate, type ScheduleState } from '../lib/schedule/sm2';
import { daysBetween } from '../lib/clock';

const T0 = new Date('2026-01-01T00:00:00.000Z');

describe('SM-2 interval growth', () => {
  /**
   * From section 11: four consecutive correct answers from a fresh cell at ease 2.5
   * give 1 → 3 → 7.8 → 20.67, with ease progressing 2.55 → 2.60 → 2.65 → 2.70.
   *
   * The third interval is 3 × 2.60, not 3 × 2.5 — the ease in effect on the third
   * response is already 2.60, because ease increments after each response.
   */
  it('produces 1 → 3 → 7.8 → 20.67 with ease 2.55 → 2.60 → 2.65 → 2.70', () => {
    let state: ScheduleState = {
      intervalDays: 0,
      ease: SCHEDULE.EASE_DEFAULT,
      consecutiveCorrect: 0,
    };

    state = scheduleUpdate(state, true, T0);
    expect(state.intervalDays).toBeCloseTo(1, 10);
    expect(state.ease).toBeCloseTo(2.55, 10);

    state = scheduleUpdate(state, true, T0);
    expect(state.intervalDays).toBeCloseTo(3, 10);
    expect(state.ease).toBeCloseTo(2.6, 10);

    state = scheduleUpdate(state, true, T0);
    expect(state.intervalDays).toBeCloseTo(7.8, 10);
    expect(state.ease).toBeCloseTo(2.65, 10);

    state = scheduleUpdate(state, true, T0);
    expect(state.intervalDays).toBeCloseTo(20.67, 10);
    expect(state.ease).toBeCloseTo(2.7, 10);

    expect(state.consecutiveCorrect).toBe(4);
  });

  it('applies the interval using the ease in effect before the response', () => {
    // Third response only. Interval 3, ease already 2.60 from two prior successes.
    const state = scheduleUpdate({ intervalDays: 3, ease: 2.6, consecutiveCorrect: 2 }, true, T0);
    expect(state.intervalDays).toBeCloseTo(7.8, 10);
    // Explicitly not 3 × 2.5 and not 3 × 2.65.
    expect(state.intervalDays).not.toBeCloseTo(7.5, 3);
    expect(state.intervalDays).not.toBeCloseTo(7.95, 3);
  });
});

describe('SM-2 failure and bounds', () => {
  it('a wrong answer resets the interval to 1 and drops ease by 0.20', () => {
    const state = scheduleUpdate({ intervalDays: 40, ease: 2.7, consecutiveCorrect: 5 }, false, T0);
    expect(state.intervalDays).toBe(1);
    expect(state.ease).toBeCloseTo(2.5, 10);
    expect(state.consecutiveCorrect).toBe(0);
  });

  it('ease is bounded to [1.3, 3.0]', () => {
    let s: ScheduleState = { intervalDays: 1, ease: 1.35, consecutiveCorrect: 0 };
    for (let i = 0; i < 5; i++) s = scheduleUpdate(s, false, T0);
    expect(s.ease).toBe(SCHEDULE.EASE_MIN);

    let t: ScheduleState = { intervalDays: 1, ease: 2.95, consecutiveCorrect: 0 };
    for (let i = 0; i < 10; i++) t = scheduleUpdate(t, true, T0);
    expect(t.ease).toBe(SCHEDULE.EASE_MAX);
  });

  it('caps the interval at 180 days', () => {
    let s: ScheduleState = { intervalDays: 120, ease: 3.0, consecutiveCorrect: 9 };
    s = scheduleUpdate(s, true, T0);
    expect(s.intervalDays).toBe(SCHEDULE.INTERVAL_CAP_DAYS);
  });

  it('next_due_at is now plus the new interval', () => {
    const r = scheduleUpdate({ intervalDays: 3, ease: 2.6, consecutiveCorrect: 2 }, true, T0);
    expect(daysBetween(T0, new Date(r.nextDueAt))).toBeCloseTo(7.8, 6);
  });
});
