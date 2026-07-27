/**
 * Next runs this once per server process, before handling any request.
 *
 * Three jobs. It installs the token-accounting sink, so every model call is recorded
 * wherever it was made from — a route, the worker, or a script. It connects the model
 * router to the lab pin, which lives in the database. And it starts the pre-generation
 * buffer, which is how the buffer stays stocked on a single-container deploy where a
 * separate worker service is not an option (see lib/pipeline/workerLoop.ts). Set
 * GYM_DISABLE_WORKER=1 to run without the worker.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const [{ setModelPinSource, setUsageSink }, { recordUsage }, { getDb }, { logEvent }, { labPin }] =
    await Promise.all([
      import('./lib/llm/client'),
      import('./lib/cost'),
      import('./lib/db'),
      import('./lib/ops'),
      import('./lib/lab'),
    ]);

  // The router cannot import the database — it runs in scripts and tests that have
  // none — so the pin is injected, exactly as the usage sink is. Without this the app
  // routes on configuration alone, which is the correct behaviour when there is no
  // database to read a pin from.
  setModelPinSource(() => labPin(getDb()));

  setUsageSink((record) => {
    try {
      recordUsage(getDb(), record);
    } catch (err) {
      // Accounting must never take down a generation that already succeeded.
      logEvent(null, 'warn', 'usage.record_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  if (process.env.GYM_DISABLE_WORKER === '1') return;

  const { startBufferWorker } = await import('./lib/pipeline/workerLoop');
  startBufferWorker();
}
