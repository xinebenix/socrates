/**
 * Pre-generation worker.
 *
 * Keeps a buffer of validated, unserved items ready for every cell that is plausibly
 * due soon, so the session runner never blocks on two sequential LLM calls.
 *
 *   npm run worker
 *
 * The session runner also tops the buffer up in the background after every item it
 * serves, so this process is a belt-and-braces measure for long idle periods rather
 * than a hard requirement.
 */

import { getDb } from '../lib/db';
import { listConcepts } from '../lib/db/queries';
import { bufferTarget, topUpBuffer } from '../lib/pipeline/buffer';

const INTERVAL_MS = Number(process.env.GYM_WORKER_INTERVAL_MS ?? 60_000);

async function tick(): Promise<void> {
  const db = getDb();
  const concepts = listConcepts(db);

  for (const concept of concepts) {
    try {
      const report = await topUpBuffer(db, concept.id, { maxGenerations: 4 });
      if (report.generated > 0 || report.failed > 0) {
        console.log(
          `[buffer] ${concept.name}: +${report.generated} generated, ` +
            `${report.failed} failed, ${report.skipped} already stocked`
        );
      }
    } catch (err) {
      console.error(`[buffer] ${concept.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `[buffer] worker started — target ${bufferTarget()} ready items per plausibly-due cell, ` +
      `polling every ${Math.round(INTERVAL_MS / 1000)}s`
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
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
