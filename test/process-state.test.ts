/**
 * State that must survive Next bundling a module twice.
 *
 * `instrumentation.ts` is compiled into a different bundle from the route handlers, so
 * anything held at module scope exists once per bundle rather than once per process.
 * The in-process worker sets a flag on its copy; `/api/health` reads the other one and
 * reports a worker that is not running on a deployment where it is.
 *
 * Vitest cannot reproduce Next's bundling, but it can reproduce the mechanism:
 * `vi.resetModules()` forces a fresh module instance with fresh module-level variables,
 * which is exactly the condition these tests are about. Anything that survives that has
 * survived the real thing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processState, resetProcessState } from '../lib/processState';

beforeEach(() => {
  resetProcessState();
  vi.resetModules();
});

describe('processState', () => {
  it('hands every caller the same object', () => {
    const first = processState('t/shared', () => ({ n: 0 }));
    first.n = 7;
    expect(processState('t/shared', () => ({ n: 0 })).n).toBe(7);
  });

  it('runs the factory once, not once per caller', () => {
    let built = 0;
    const make = () => {
      built++;
      return { built };
    };
    processState('t/once', make);
    processState('t/once', make);
    processState('t/once', make);
    expect(built).toBe(1);
  });

  it('keeps keys apart', () => {
    processState('t/a', () => ({ v: 'a' })).v = 'changed';
    expect(processState('t/b', () => ({ v: 'b' })).v).toBe('b');
  });

  it('survives a module instance being thrown away and re-imported', async () => {
    const a = await import('../lib/processState');
    a.processState('t/reimport', () => ({ hits: 0 })).hits = 3;

    vi.resetModules();
    const b = await import('../lib/processState');
    expect(b.processState('t/reimport', () => ({ hits: 0 })).hits).toBe(3);
  });
});

describe('the worker reports itself to a second module instance', () => {
  it('is the regression: started here, read over there', async () => {
    // What instrumentation.ts does.
    const starter = await import('../lib/pipeline/workerLoop');
    starter.startBufferWorker();
    expect(starter.workerStatus().running).toBe(true);

    // What /api/health does, from a bundle Next compiled separately.
    vi.resetModules();
    const reader = await import('../lib/pipeline/workerLoop');
    expect(reader.workerStatus().running).toBe(true);
    expect(reader.workerStatus().startedAt).not.toBeNull();

    reader.stopBufferWorker();
    expect(starter.workerStatus().running).toBe(false);
  });
});

describe('the cell lock spans both module instances', () => {
  it('is the one that costs money when it does not', async () => {
    const worker = await import('../lib/pipeline/cellLock');
    worker.reserve([41]);
    expect(worker.isGenerating(41)).toBe(true);

    // The session warm, on the request path. Seeing this cell as free is what makes it
    // buy items the worker already has in flight — at full price, to duplicate
    // something already bought at half.
    vi.resetModules();
    const requestPath = await import('../lib/pipeline/cellLock');
    expect(requestPath.isGenerating(41)).toBe(true);

    requestPath.release(41);
    expect(worker.isGenerating(41)).toBe(false);
  });
});

describe('the database handle is one connection', () => {
  it('does not open a second one for the other bundle', async () => {
    const { newTestDb, setDb, getDb } = await import('../lib/db');
    const db = newTestDb();
    setDb(db);

    vi.resetModules();
    const other = await import('../lib/db');
    expect(other.getDb()).toBe(db);
    expect(getDb()).toBe(db);

    other.setDb(null);
    db.close();
  });
});
