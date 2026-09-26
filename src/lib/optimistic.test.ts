import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import type { TransitionStartFunction } from 'react';

vi.mock('@/components/toaster', () => ({ toast: vi.fn() }));
const { toast } = await import('@/components/toaster');
const { mutationBus, reportFailure, runOptimistic, runOptimisticBulk } = await import('@/lib/optimistic');

/** Runs the transition callback right away and keeps its promise to await. */
function fakeTransition() {
  const pending: Promise<unknown>[] = [];
  const start = ((fn: () => unknown) => {
    const r = fn();
    if (r instanceof Promise) pending.push(r);
  }) as unknown as TransitionStartFunction;
  return { start, settle: () => Promise.all(pending) };
}

function redirectError(): unknown {
  try {
    redirect('/login');
  } catch (error) {
    return error;
  }
}

const copy = { failure: 'Moving 4 candidates', done: 'Moved', skipped: "couldn't be moved" };
const range = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);

describe('optimistic failures', () => {
  beforeEach(() => {
    vi.mocked(toast).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rethrows Next's redirect instead of reporting it as a failed save", () => {
    const error = redirectError();
    expect(() => reportFailure(error, 'x')).toThrow(error as Error);
    expect(toast).not.toHaveBeenCalled();
  });

  it('reports an ordinary error with a toast', () => {
    expect(() => reportFailure(new Error('boom'), "Moving didn't save.")).not.toThrow();
    expect(toast).toHaveBeenCalledWith("Moving didn't save.", 'error');
  });

  it('says how many saved when a later chunk fails, and hands back the rest', async () => {
    const t = fakeTransition();
    const applied: string[][] = [];
    const onFailure = vi.fn();
    let calls = 0;
    runOptimisticBulk({
      startTransition: t.start,
      items: range(250),
      size: 100,
      apply: (chunk) => applied.push(chunk),
      run: async () => {
        if (++calls === 2) throw new Error('boom');
        return { skipped: 0 };
      },
      copy,
      onFailure,
    });
    await t.settle();
    // Each chunk is shown just before it is sent; the third never was.
    expect(applied.map((c) => c.length)).toEqual([100, 100]);
    expect(toast).toHaveBeenCalledWith("Moved 100 of 250. The other 150 didn't save. Try again.", 'error');
    expect(onFailure).toHaveBeenCalledWith(range(250).slice(100));
  });

  it('keeps the plain message when nothing saved', async () => {
    const t = fakeTransition();
    runOptimisticBulk({
      startTransition: t.start,
      items: range(4),
      size: 100,
      apply: () => {},
      run: async () => {
        throw new Error('boom');
      },
      copy,
    });
    await t.settle();
    expect(toast).toHaveBeenCalledWith("Moving 4 candidates didn't save and was undone. Try again.", 'error');
  });

  it('reports ids the server skipped', async () => {
    const t = fakeTransition();
    const onSuccess = vi.fn();
    runOptimisticBulk({
      startTransition: t.start,
      items: range(4),
      size: 100,
      run: async () => ({ skipped: 1 }),
      copy,
      onSuccess,
    });
    await t.settle();
    expect(toast).toHaveBeenCalledWith("Moved 3 of 4. The other 1 couldn't be moved.", 'error');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('lets a redirect from the action through to the router', async () => {
    const t = fakeTransition();
    const error = redirectError();
    runOptimisticBulk({
      startTransition: t.start,
      items: range(2),
      size: 100,
      run: async () => {
        throw error;
      },
      copy,
    });
    await expect(t.settle()).rejects.toBe(error);
    expect(toast).not.toHaveBeenCalled();
  });

  it('tells only the last chunk it is final, and reports each saved chunk', async () => {
    const t = fakeTransition();
    const finals: boolean[] = [];
    const saved: number[] = [];
    runOptimisticBulk({
      startTransition: t.start,
      items: range(250),
      size: 100,
      run: async (_chunk, final) => void finals.push(final),
      onChunkSaved: (chunk) => saved.push(chunk.length),
      copy,
    });
    await t.settle();
    expect(finals).toEqual([false, false, true]);
    expect(saved).toEqual([100, 100, 50]);
  });

  it('refreshes once when a later chunk fails, since earlier ones never re-rendered', async () => {
    const t = fakeTransition();
    const refresh = vi.fn(async () => {});
    let calls = 0;
    runOptimisticBulk({
      startTransition: t.start,
      items: range(250),
      size: 100,
      run: async () => {
        if (++calls === 3) throw new Error('boom');
      },
      copy,
      refresh,
    });
    await t.settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Nothing saved: the transition's end undoes everything, no refresh needed.
    const t2 = fakeTransition();
    runOptimisticBulk({
      startTransition: t2.start,
      items: range(5),
      size: 100,
      run: async () => {
        throw new Error('boom');
      },
      copy,
      refresh,
    });
    await t2.settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('announces every settled edit on the mutation bus', async () => {
    const heard = vi.fn();
    const off = mutationBus.subscribe(heard);
    const t = fakeTransition();
    runOptimistic(t.start, () => {}, async () => {}, 'Moving');
    runOptimistic(t.start, () => {}, async () => {
      throw new Error('boom');
    }, 'Moving');
    runOptimisticBulk({ startTransition: t.start, items: range(3), size: 2, run: async () => {}, copy });
    await t.settle();
    expect(heard).toHaveBeenCalledTimes(3);
    off();
  });
});

