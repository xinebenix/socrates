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
import { setModelPinSource, setUsageSink } from '../lib/llm/client';
import { budgetStatus, recordUsage, totalSpend } from '../lib/cost';
import { labPin } from '../lib/lab';
import { getDb } from '../lib/db';

async function main(): Promise<void> {
  const interval = workerIntervalMs();

  // This process does most of the spending, so it does its own accounting rather
  // than relying on the server's instrumentation hook, which it never runs. Same for
  // the lab pin: this is the process that writes most of the items, so a pin it could
  // not see would be a pin that barely did anything. Read per call, so flipping the
  // switch in the browser reaches the next generation rather than the next restart.
  setModelPinSource(() => labPin(getDb()));

  setUsageSink((record) => {
    try {
      recordUsage(getDb(), record);
    } catch {
      // Never fail a generation over bookkeeping.
    }
  });

  const budget = budgetStatus(getDb());
  if (budget.limitUsd !== null) {
    console.log(
      `[buffer] budget ${budget.spentThisMonthUsd.toFixed(2)} / ${budget.limitUsd.toFixed(2)} USD ` +
        `estimated this month`
    );
  }
  console.log(
    `[buffer] worker started — target ${bufferTarget()} ready items per plausibly-due cell, ` +
      `polling every ${Math.round(interval / 1000)}s`
  );

  // Said out loud at startup because the pin is the one setting that is not in this
  // process's environment, and everything it writes will carry it.
  const pin = labPin(getDb());
  if (pin) console.log(`[buffer] lab pin is set — every call site is routed to ${pin}`);

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
    const spent = totalSpend(getDb(), budgetStatus(getDb()).month + '-01');
    console.log(
      `[buffer] ${s.generated} generated, ${s.failed} failed · ` +
        `~$${spent.estimatedUsd.toFixed(2)} estimated this month over ${spent.calls} calls`
    );
    await new Promise((r) => setTimeout(r, interval));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
