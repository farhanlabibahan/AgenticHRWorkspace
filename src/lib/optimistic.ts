import type { TransitionStartFunction } from 'react';
import { unstable_rethrow } from 'next/navigation';
import { toast } from '@/components/toaster';
import type { BulkResult } from '@/lib/bulk';

/**
 * Told whenever an optimistic edit settles, saved or not. Client caches of
 * server data (the lists' row cache) listen and drop what they hold, since
 * it may no longer match.
 */
export const mutationBus = (() => {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit() {
      for (const fn of listeners) fn();
    },
  };
})();

/**
 * A failed save: log it and tell the user. Next's own signals (a redirect,
 * e.g. to /login when the session has ended, or notFound) are rethrown first
 * so the router still handles them instead of the user seeing a false
 * "didn't save".
 */
export function reportFailure(error: unknown, message: string) {
  unstable_rethrow(error);
  console.error(error);
  toast(message, 'error');
}

/**
 * Optimistic edit: show the result now, save in the background.
 *
 * `apply` runs first, inside the transition, and should only call
 * useOptimistic setters — they hold until the action's response (which
 * carries the re-rendered page, since every action here revalidates) commits.
 * If the action throws, the transition ends with the real data unchanged, so
 * the optimistic state falls away on its own; the user gets a toast instead
 * of an error screen.
 *
 * `onCommitted` runs once the save succeeded, as part of the same transition,
 * so state the server render doesn't cover (rows a list paged in past its
 * first page) takes the change in the same commit the optimistic layer drops.
 */
export function runOptimistic(
  startTransition: TransitionStartFunction,
  apply: () => void,
  action: () => Promise<unknown>,
  failure: string,
  onCommitted?: () => void,
) {
  startTransition(async () => {
    apply();
    try {
      await action();
    } catch (error) {
      reportFailure(error, `${failure} didn't save and was undone. Try again.`);
      return;
    } finally {
      mutationBus.emit();
    }
    if (onCommitted) startTransition(onCommitted);
  });
}

export type BulkCopy = {
  /** "Moving 4 candidates" — used when nothing saved. */
  failure: string;
  /** Past tense for a count: "Moved". */
  done: string;
  /** For items the server skipped: "couldn't be moved". */
  skipped: string;
};

/**
 * A bulk edit sent in chunks (each server call stays inside a function's
 * time limit), all in one transition.
 *
 * Each chunk's optimistic change is applied just before that chunk is sent,
 * so the screen never shows more than has been sent. The actions return how
 * many items they skipped (ids that no longer exist, a stage move the server
 * refused). The toast says what actually happened: "Moved 2 of 4. The other
 * 2 didn't save." when a later chunk fails, "Moved 3 of 4. The other 1
 * couldn't be moved." when the server skipped some. `onFailure` gets the
 * items that were never saved, e.g. to reselect them for a retry.
 *
 * `run` is told whether its chunk is the last (`final`): only the last one
 * needs to revalidate and send back a re-rendered page, so a 500-row move
 * renders the page once, not five times. If a later chunk fails, the chunks
 * already saved never got that render, so `refresh` (a revalidating
 * action) runs once instead. `onChunkSaved` runs in the transition after
 * each saved chunk, like runOptimistic's onCommitted.
 */
export function runOptimisticBulk<T>({
  startTransition,
  items,
  size,
  apply,
  run,
  copy,
  onFailure,
  onSuccess,
  onChunkSaved,
  refresh,
}: {
  startTransition: TransitionStartFunction;
  items: T[];
  size: number;
  apply?: (chunk: T[]) => void;
  run: (chunk: T[], final: boolean) => Promise<BulkResult | void>;
  copy: BulkCopy;
  onFailure?: (unsaved: T[]) => void;
  onSuccess?: () => void;
  onChunkSaved?: (chunk: T[]) => void;
  refresh?: () => Promise<unknown>;
}) {
  const total = items.length;
  startTransition(async () => {
    let saved = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < total; i += size) {
        const chunk = items.slice(i, i + size);
        if (apply) {
          // After the first await this callback is no longer inside the
          // transition, so later chunks join it through startTransition.
          if (i === 0) apply(chunk);
          else startTransition(() => apply(chunk));
        }
        try {
          const result = await run(chunk, i + size >= total);
          const s = Math.min(chunk.length, result?.skipped ?? 0);
          skipped += s;
          saved += chunk.length - s;
          if (onChunkSaved) startTransition(() => onChunkSaved(chunk));
        } catch (error) {
          reportFailure(
            error,
            saved === 0 && skipped === 0
              ? `${copy.failure} didn't save${apply ? ' and was undone' : ''}. Try again.`
              : `${copy.done} ${saved} of ${total}. The other ${total - saved} didn't save. Try again.`,
          );
          onFailure?.(items.slice(i));
          if (i > 0 && refresh) await refresh().catch(() => {});
          return;
        }
      }
    } finally {
      mutationBus.emit();
    }
    if (skipped > 0) {
      toast(`${copy.done} ${saved} of ${total}. The other ${skipped} ${copy.skipped}.`, 'error');
    }
    onSuccess?.();
  });
}
