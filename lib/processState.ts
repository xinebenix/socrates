/**
 * State that must be one thing per process, not one thing per module instance.
 *
 * Next compiles `instrumentation.ts` into a different bundle from the route handlers,
 * so a module imported by both exists **twice** in the same Node process, with two
 * separate sets of module-level variables. Anything held in a `let` or a `const Map` at
 * module scope is therefore not shared between the in-process worker and the code
 * serving requests, even though they are unambiguously the same process.
 *
 * That broke three things quietly, and only one of them was visible:
 *
 *   - `/api/health` reported `worker.running: false` on a deployment whose worker was
 *     running perfectly well. The worker set the flag on its copy; the route read the
 *     other one. Cosmetic, but it is the field the deploy guide tells you to check.
 *
 *   - `cellLock`'s registry of in-flight generations was two registries, so a batch the
 *     worker had already submitted for a cell was invisible to a session warm on the
 *     request path, which then bought the same items again synchronously — at full
 *     price, to replace something already in flight at half. That one costs money.
 *
 *   - `getDb`'s connection singleton was two connections to the same file. WAL and
 *     `busy_timeout` make that survivable rather than dangerous, but it is still two.
 *
 * `globalThis` is the one object both bundles agree on. Keys are namespaced because
 * `globalThis` is shared with everything else in the runtime.
 */

interface Host {
  __socratesProcessState__?: Map<string, unknown>;
}

function registry(): Map<string, unknown> {
  const host = globalThis as typeof globalThis & Host;
  host.__socratesProcessState__ ??= new Map<string, unknown>();
  return host.__socratesProcessState__;
}

/**
 * The value for `key`, created on first use by whichever module instance asks first
 * and returned unchanged to every instance after it.
 *
 * `create` must be cheap and must not assume it runs exactly once per import — it runs
 * once per process, which is the point.
 */
export function processState<T>(key: string, create: () => T): T {
  const store = registry();
  if (!store.has(key)) store.set(key, create());
  return store.get(key) as T;
}

/** Tests only: drop everything, so a case can observe a cold process. */
export function resetProcessState(): void {
  registry().clear();
}
