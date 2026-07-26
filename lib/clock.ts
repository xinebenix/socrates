/**
 * Injectable clock.
 *
 * Invariant 8 requires scheduling state to persist across sessions and mastery to
 * decay with time. Acceptance test 8 advances the clock 30 days, which cannot be
 * written if the code reaches for `Date.now()` directly. Every piece of time
 * arithmetic in this codebase goes through here.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that only moves when you move it. */
export class TestClock implements Clock {
  private t: number;

  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  set(d: Date | string | number): void {
    this.t = new Date(d).getTime();
  }

  advanceMs(ms: number): void {
    this.t += ms;
  }

  advanceDays(days: number): void {
    this.t += days * MS_PER_DAY;
  }
}

let current: Clock = systemClock;

export function getClock(): Clock {
  return current;
}

export function setClock(c: Clock): void {
  current = c;
}

export function resetClock(): void {
  current = systemClock;
}

/** Convenience: current time from the ambient clock. */
export function now(): Date {
  return current.now();
}

export const MS_PER_DAY = 86_400_000;

export function iso(d: Date): string {
  return d.toISOString();
}

export function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

/** Signed day count from `a` to `b`. */
export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MS_PER_DAY;
}
