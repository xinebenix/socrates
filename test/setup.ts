import { afterEach } from 'vitest';
import { resetClock } from '../lib/clock';
import { setModelPinSource, setTransport } from '../lib/llm/client';
import { setDb } from '../lib/db';

// jsdom-only matchers, loaded only in the files that run under jsdom.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

afterEach(() => {
  resetClock();
  setTransport(null);
  // The pin source is registered per process rather than per module, so a test that
  // installs one and forgets would reroute every model call in the file after it.
  setModelPinSource(null);
  setDb(null);
});
