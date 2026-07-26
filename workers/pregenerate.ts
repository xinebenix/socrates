/**
 * Standalone pre-generation worker.
 *
 *   npm run worker
 *
 * For local development, where running it in its own terminal makes its output easy
 * to watch. In a single-container deploy the same loop runs inside the Next server
 * via instrumentation.ts instead — do not run both against one database.
 */

import { bufferTarget } from '../lib/pipeline/buffer';
import { tick, workerIntervalMs, workerStatus } from '../lib/pipeline/workerLoop';

async function main(): Promise<void> {
  const interval = workerIntervalMs();
  console.log(
    `[buffer] worker started — target ${bufferTarget()} ready items per plausibly-due cell, ` +
      `polling every ${Math.round(interval / 1000)}s`
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log('[buffer] stopping');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    await tick();
    const s = workerStatus();
    if (s.lastError) console.error(`[buffer] last error: ${s.lastError}`);
    await new Promise((r) => setTimeout(r, interval));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
