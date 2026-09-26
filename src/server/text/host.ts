import { Worker } from 'node:worker_threads';
import type { JobOutput } from './extract.worker';
import type { TextFormat } from './types';

/**
 * Runs extraction in a worker thread so a hostile or huge document can be
 * stopped. pdf.js parses synchronously: in-process, a 200 ms timeout fired
 * only after a 1.6 s parse had finished, and a 1 MB PDF that inflates to
 * 1 GiB held the event loop for 13 s at 1 GB RSS. Here a timer or an RSS
 * watchdog terminates the worker instead, and the next job gets a fresh one.
 *
 * One worker per bundler runtime, one job at a time, first in first out. Next
 * loads route handlers and pages in separate runtimes, so one `next start`
 * process runs two: the careers page never queues behind the crons. A job's timeout runs
 * from when it is queued, so an application's 5 s cap holds whatever the
 * backfill or an import queued first, and past `maxWaiting` queued jobs a new
 * one is turned away at once (FAILED; the resume-text cron retries it). The
 * worker starts on the first job, is unref'd so it never keeps a process
 * alive, and exits after a minute idle. When a thread can't be started (new
 * Worker throws), jobs run in-process until `retrySpawnMs` has passed; with
 * TEXT_EXTRACT_WORKER=0 they always do. In-process, the timeout only catches
 * async hangs.
 */

export type JobResult =
  | ({ ok: true } & JobOutput)
  | { ok: false; kind: 'error' | 'timeout' | 'memory' | 'crash'; name: string; message: string };

export type HostOptions = {
  /** Starts the worker; tests pass a stub. Throwing runs jobs in-process for `retrySpawnMs`. */
  spawn?: () => Worker;
  inProcess?: (format: TextFormat, data: Uint8Array) => Promise<JobOutput>;
  /** How far process RSS may grow past its level at dispatch before the worker is killed. */
  rssHeadroomBytes?: number;
  idleMs?: number;
  /** Jobs that may wait behind the running one. */
  maxWaiting?: number;
  retrySpawnMs?: number;
};

export type Host = {
  run(format: TextFormat, data: Uint8Array, timeoutMs: number): Promise<JobResult>;
  mode(): 'thread' | 'in-process';
};

type Job = {
  id: number;
  format: TextFormat;
  data: Uint8Array;
  resolve: (result: JobResult) => void;
  /** Armed when the job is queued. */
  timer: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setInterval>;
};

type Reply = { id: number } & ({ ok: true } & JobOutput | { ok: false; name: string; message: string });

const HEAP_LIMIT_MB = 256;
const WATCHDOG_MS = 50;

/**
 * Turbopack bundles the worker only from this exact shape: a `new URL` with a
 * literal path, and options written inline. Passed as a variable, the options
 * make it ship the raw .ts file as an asset, which Node can't run. It also
 * wraps workerData and drops it unless it is an object.
 */
function startWorker(): Worker {
  return new Worker(new URL('./extract.worker.ts', import.meta.url), {
    workerData: { textExtract: true },
    resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
  });
}

function timedOut(timeoutMs: number): JobResult {
  return { ok: false, kind: 'timeout', name: 'TimeoutError', message: `No result after ${timeoutMs} ms` };
}

function failure(err: unknown): JobResult {
  const e = err instanceof Error ? err : new Error(String(err));
  return { ok: false, kind: 'error', name: e.name, message: e.message };
}

export function createHost({
  spawn = startWorker,
  inProcess = async (format, data) => (await import('./extract.worker')).runAdapter(format, data),
  rssHeadroomBytes = 512 * 1024 * 1024,
  idleMs = 60_000,
  // Waiting jobs hold only a reference to the caller's bytes, and each one's
  // timeout already runs, so this only sheds a flood: a burst of 15
  // applications at a cap of 8 turned away jobs that would have finished in 2 s.
  maxWaiting = 64,
  retrySpawnMs = 60_000,
}: HostOptions = {}): Host {
  let worker: Worker | null = null;
  let current: Job | null = null;
  const queue: Job[] = [];
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let spawnFailedAt = -Infinity;
  let loggedDisabled = false;

  const disabled = () => process.env.TEXT_EXTRACT_WORKER === '0';
  // A failed spawn (thread limit, low memory) may be passing: try again later.
  const threadsDown = () => performance.now() - spawnFailedAt < retrySpawnMs;

  /** Settles with a JobResult, never rejects. */
  function runHere(format: TextFormat, data: Uint8Array): Promise<JobResult> {
    return Promise.resolve()
      .then(() => inProcess(format, data))
      .then((out): JobResult => ({ ok: true, ...out }), failure);
  }

  async function runInProcess(format: TextFormat, data: Uint8Array, timeoutMs: number): Promise<JobResult> {
    if (disabled() && !loggedDisabled) {
      loggedDisabled = true;
      console.info('[text-extract] TEXT_EXTRACT_WORKER=0: extracting in-process');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<JobResult>((resolve) => {
      timer = setTimeout(() => resolve(timedOut(timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([runHere(format, data), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stop() {
    const w = worker;
    worker = null;
    w?.terminate().catch(() => {});
  }

  function finish(result: JobResult) {
    const job = current!;
    clearTimeout(job.timer);
    clearInterval(job.watchdog);
    current = null;
    job.resolve(result);
    if (queue.length) dispatch();
    else if (worker) {
      idleTimer = setTimeout(stop, idleMs);
      idleTimer.unref();
    }
  }

  function kill(result: JobResult) {
    stop();
    finish(result);
  }

  /** A job's time is up, whether it is running or still waiting. */
  function expire(job: Job, timeoutMs: number) {
    if (job === current) return kill(timedOut(timeoutMs));
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    job.resolve(timedOut(timeoutMs));
  }

  function start(): Worker {
    const w = spawn();
    w.unref();
    w.on('message', (msg: Reply) => {
      if (w !== worker || msg.id !== current?.id) return;
      finish(
        msg.ok
          ? { ok: true, text: msg.text, links: msg.links, pages: msg.pages }
          : { ok: false, kind: 'error', name: msg.name, message: msg.message },
      );
    });
    // An uncaught error or the heap limit ends the worker: 'error', then 'exit'.
    w.on('error', (err: Error & { code?: string }) => {
      if (w !== worker) return;
      worker = null;
      if (!current) return;
      finish(
        err.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? { ok: false, kind: 'memory', name: 'MemoryLimitError', message: `The worker ran out of heap (${HEAP_LIMIT_MB} MB)` }
          : { ok: false, kind: 'crash', name: 'WorkerCrashError', message: `${err.name}: ${err.message}` },
      );
    });
    w.on('exit', (code) => {
      if (w !== worker) return;
      worker = null;
      if (current) finish({ ok: false, kind: 'crash', name: 'WorkerCrashError', message: `The worker exited with code ${code}` });
    });
    worker = w;
    return w;
  }

  function dispatch() {
    if (current || !queue.length) return;
    clearTimeout(idleTimer);
    let w: Worker;
    try {
      w = worker ?? start();
    } catch (err) {
      spawnFailedAt = performance.now();
      console.warn('[text-extract] worker unavailable, extracting in-process:', err instanceof Error ? err.message : err);
      // Each job's own timer still bounds it.
      for (const job of queue.splice(0)) {
        void runHere(job.format, job.data).then((result) => {
          clearTimeout(job.timer);
          job.resolve(result);
        });
      }
      return;
    }
    const job = (current = queue.shift()!);
    const baseline = process.memoryUsage.rss();
    job.watchdog = setInterval(() => {
      if (process.memoryUsage.rss() - baseline <= rssHeadroomBytes) return;
      const mb = Math.round(rssHeadroomBytes / 2 ** 20);
      kill({ ok: false, kind: 'memory', name: 'MemoryLimitError', message: `Memory grew by more than ${mb} MB` });
    }, WATCHDOG_MS);
    job.watchdog.unref();
    // Transfer a copy: the caller's buffer stays usable, and nothing is cloned twice.
    const copy = new Uint8Array(job.data);
    w.postMessage({ id: job.id, format: job.format, data: copy }, [copy.buffer]);
  }

  return {
    run(format, data, timeoutMs) {
      if (disabled() || threadsDown()) return runInProcess(format, data, timeoutMs);
      if (queue.length >= maxWaiting) {
        return Promise.resolve({ ok: false, kind: 'timeout', name: 'BusyError', message: `${queue.length} extractions already waiting` });
      }
      return new Promise((resolve) => {
        const job: Job = { id: nextId++, format, data, resolve, timer: setTimeout(() => expire(job, timeoutMs), timeoutMs) };
        queue.push(job);
        dispatch();
      });
    },
    mode: () => (disabled() || threadsDown() ? 'in-process' : 'thread'),
  };
}

export const host = createHost();
