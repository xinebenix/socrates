/**
 * Next runs this once per server process, before handling any request.
 *
 * It is how the pre-generation buffer stays stocked on a single-container deploy,
 * where a separate worker service is not an option (see lib/pipeline/workerLoop.ts).
 * Set GYM_DISABLE_WORKER=1 to run the server without it — useful when driving the
 * worker by hand from a shell.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.GYM_DISABLE_WORKER === '1') return;

  const { startBufferWorker } = await import('./lib/pipeline/workerLoop');
  startBufferWorker();
}
