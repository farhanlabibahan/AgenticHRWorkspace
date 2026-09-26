import { Worker, type WorkerOptions } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHost, type HostOptions } from '@/server/text/host';

const STUB = new URL('./stub-worker.mjs', import.meta.url);
const bytes = (s: string) => new TextEncoder().encode(s);

/** A host on the stub worker; `spawn` records every worker it starts. */
function stubHost(options: HostOptions = {}, workerOptions: WorkerOptions = {}) {
  const spawn = vi.fn(() => new Worker(STUB, workerOptions));
  return { host: createHost({ spawn, idleMs: 200, ...options }), spawn };
}

describe('extraction host (worker thread)', () => {
  beforeEach(() => {
    delete process.env.TEXT_EXTRACT_WORKER; // tests/setup.ts turns the worker off for other suites
  });
  afterEach(() => {
    process.env.TEXT_EXTRACT_WORKER = '0';
    vi.restoreAllMocks();
  });

  it('runs a job in the worker and leaves the caller’s buffer intact', async () => {
    const { host, spawn } = stubHost();
    const data = bytes('Rowan Q. Testperson');
    expect(await host.run('txt', data, 5_000)).toEqual({ ok: true, text: 'Rowan Q. Testperson', links: [], pages: 1 });
    expect(new TextDecoder().decode(data)).toBe('Rowan Q. Testperson');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(host.mode()).toBe('thread');
  });

  it('runs queued jobs one at a time, in order, on one worker', async () => {
    const { host, spawn } = stubHost();
    const results = await Promise.all(['one', 'two', 'three'].map((s) => host.run('txt', bytes(s), 5_000)));
    expect(results.map((r) => (r.ok ? r.text : r.kind))).toEqual(['one', 'two', 'three']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('passes adapter errors through by name', async () => {
    const { host } = stubHost();
    expect(await host.run('txt', bytes('encrypted'), 5_000)).toEqual({
      ok: false,
      kind: 'error',
      name: 'EncryptedDocumentError',
      message: 'The document is password-protected',
    });
  });

  it('kills a hung job on the timeout while the main event loop keeps ticking', async () => {
    const { host } = stubHost();
    await host.run('txt', bytes('warm up'), 5_000);
    let ticks = 0;
    let last = performance.now();
    let maxGap = 0;
    const interval = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 10);
    const started = performance.now();
    // Loose bounds, for a loaded CI machine: a blocked loop would tick about
    // once, with a gap as long as the whole timeout.
    const result = await host.run('txt', bytes('hang'), 1_000);
    clearInterval(interval);
    expect(result).toMatchObject({ ok: false, kind: 'timeout', name: 'TimeoutError' });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect(maxGap).toBeLessThan(500);
  });

  it('times a job from when it was queued, not from when the worker takes it', async () => {
    const { host } = stubHost();
    const started = performance.now();
    const hung = host.run('txt', bytes('hang'), 2_000);
    // An application's short cap holds even behind a long job.
    expect(await host.run('txt', bytes('waiting'), 300)).toMatchObject({ ok: false, kind: 'timeout', name: 'TimeoutError' });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(await hung).toMatchObject({ kind: 'timeout' });
    expect(await host.run('txt', bytes('after'), 5_000)).toMatchObject({ ok: true, text: 'after' });
  });

  it('turns a job away at once when too many are waiting', async () => {
    const { host } = stubHost({ maxWaiting: 2 });
    const queued = [host.run('txt', bytes('hang'), 300), host.run('txt', bytes('one'), 5_000), host.run('txt', bytes('two'), 5_000)];
    const started = performance.now();
    expect(await host.run('txt', bytes('three'), 5_000)).toMatchObject({ ok: false, kind: 'timeout', name: 'BusyError' });
    expect(performance.now() - started).toBeLessThan(100);
    expect((await Promise.all(queued)).map((r) => (r.ok ? r.text : r.kind))).toEqual(['timeout', 'one', 'two']);
  });

  it('starts a fresh worker for the next job after a kill', async () => {
    const { host, spawn } = stubHost();
    expect(await host.run('txt', bytes('hang'), 200)).toMatchObject({ kind: 'timeout' });
    const killed = spawn.mock.results[0].value as Worker;
    expect(await host.run('txt', bytes('after'), 5_000)).toMatchObject({ ok: true, text: 'after' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(killed.threadId).toBe(-1);
  });

  it('kills a job that grows process memory past the headroom', async () => {
    const { host, spawn } = stubHost({ rssHeadroomBytes: 64 * 1024 * 1024 });
    const result = await host.run('txt', bytes('rss'), 10_000);
    expect(result).toMatchObject({ ok: false, kind: 'memory', name: 'MemoryLimitError' });
    expect(await host.run('txt', bytes('after'), 5_000)).toMatchObject({ ok: true, text: 'after' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reports a worker that hits its heap limit', async () => {
    const { host } = stubHost({}, { resourceLimits: { maxOldGenerationSizeMb: 16 } });
    const result = await host.run('txt', bytes('heap'), 20_000);
    expect(result).toMatchObject({ ok: false, kind: 'memory', name: 'MemoryLimitError' });
    expect(!result.ok && result.message).toContain('ran out of heap');
  });

  it('reports a worker that exits or throws mid-job, then recovers', async () => {
    const { host, spawn } = stubHost();
    expect(await host.run('txt', bytes('exit'), 5_000)).toMatchObject({
      ok: false,
      kind: 'crash',
      message: 'The worker exited with code 3',
    });
    const thrown = await host.run('txt', bytes('throw'), 5_000);
    expect(thrown).toMatchObject({ ok: false, kind: 'crash', name: 'WorkerCrashError' });
    expect(!thrown.ok && thrown.message).toContain('stub worker blew up');
    expect(await host.run('txt', bytes('after'), 5_000)).toMatchObject({ ok: true, text: 'after' });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('shuts the worker down when idle and starts another on demand', async () => {
    const { host, spawn } = stubHost({ idleMs: 50 });
    await host.run('txt', bytes('first'), 5_000);
    const first = spawn.mock.results[0].value as Worker;
    await vi.waitFor(() => expect(first.threadId).toBe(-1));
    expect(await host.run('txt', bytes('second'), 5_000)).toMatchObject({ ok: true, text: 'second' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('extraction host (in-process fallback)', () => {
  afterEach(() => {
    process.env.TEXT_EXTRACT_WORKER = '0';
    vi.restoreAllMocks();
  });

  it('falls back when a worker can’t be created, and logs it once', async () => {
    delete process.env.TEXT_EXTRACT_WORKER;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = vi.fn((): Worker => {
      throw new Error('worker_threads unavailable');
    });
    const inProcess = vi.fn(async () => ({ text: 'in-process text', links: [] }));
    const host = createHost({ spawn, inProcess });
    expect(await host.run('txt', bytes('a'), 5_000)).toEqual({ ok: true, text: 'in-process text', links: [] });
    expect(await host.run('txt', bytes('b'), 5_000)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(inProcess).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(host.mode()).toBe('in-process');
  });

  it('tries a thread again once the retry delay has passed', async () => {
    delete process.env.TEXT_EXTRACT_WORKER;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const spawn = vi.fn((): Worker => {
      if (calls++ === 0) throw new Error('Worker initialization failure');
      return new Worker(STUB);
    });
    const host = createHost({ spawn, inProcess: async () => ({ text: 'in-process text', links: [] }), retrySpawnMs: 100 });
    expect(await host.run('txt', bytes('a'), 5_000)).toMatchObject({ ok: true, text: 'in-process text' });
    expect(host.mode()).toBe('in-process');
    await new Promise((r) => setTimeout(r, 150));
    expect(host.mode()).toBe('thread');
    expect(await host.run('txt', bytes('threaded'), 5_000)).toMatchObject({ ok: true, text: 'threaded' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('runs in-process without starting a worker when TEXT_EXTRACT_WORKER=0', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spawn = vi.fn(() => new Worker(STUB));
    const host = createHost({ spawn, inProcess: async () => ({ text: 'x', links: [] }) });
    await host.run('txt', bytes('a'), 5_000);
    await host.run('txt', bytes('b'), 5_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(host.mode()).toBe('in-process');
  });

  it('maps in-process errors and async hangs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const failing = createHost({
      inProcess: async () => {
        throw Object.assign(new Error('zip entry inflates past the limit'), { name: 'DocumentLimitError' });
      },
    });
    expect(await failing.run('docx', bytes('a'), 5_000)).toEqual({
      ok: false,
      kind: 'error',
      name: 'DocumentLimitError',
      message: 'zip entry inflates past the limit',
    });
    const hanging = createHost({ inProcess: () => new Promise(() => {}) });
    expect(await hanging.run('pdf', bytes('a'), 50)).toMatchObject({ ok: false, kind: 'timeout' });
  });
});
