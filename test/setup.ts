import { afterEach } from 'vitest';
import { resetClock } from '../lib/clock';
import { setTransport } from '../lib/llm/client';
import { setDb } from '../lib/db';

// jsdom-only matchers, loaded only in the files that run under jsdom.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

afterEach(() => {
  resetClock();
  setTransport(null);
  setDb(null);
});
