'use client';

import { useState, useTransition } from 'react';
import {
  archiveOpportunityAction,
  batchEvaluateAction,
  moveStageAction,
} from '@/app/(app)/actions';
import { btnPrimary } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { useRemoveRow } from '@/components/removable-row';
import { runOptimistic } from '@/lib/optimistic';
import { TextSwap, ThinkingStates } from '@/components/ui/motion';
import { Bot } from '@/components/ui/bot';

/** "Review all with AI" — evaluates the visible queue in one click. */
export function BatchEvaluateButton({ postingId }: { postingId?: string }) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  return (
    <span className="flex items-center gap-3">
      {pending ? (
        <span className="text-xs">
          <ThinkingStates lines={['Reading applications…', 'Scoring against each role…', 'Ranking the queue…']} />
        </span>
      ) : status ? (
        <span className="text-xs text-ink-2">
          <TextSwap>{status}</TextSwap>
        </span>
      ) : null}
      <Bot state={pending ? 'working' : 'idle'} size={32} />
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await batchEvaluateAction(postingId);
            setStatus(
              res.error
                ? res.error
                : res.remaining > 0
                  ? `Evaluated ${res.evaluated} — ${res.remaining} left, run again`
                  : res.evaluated
                    ? `Evaluated ${res.evaluated}`
                    : 'Queue is fully evaluated',
            );
          })
        }
        className={btnPrimary}
      >
        <TextSwap>{pending ? 'Reviewing…' : 'Review all with AI'}</TextSwap>
      </button>
    </span>
  );
}

/** Advance / archive quick actions on a queue row. */
export function ReviewRowActions({
  opportunityId,
  nextStageId,
  nextStageName,
  rejectReasonId,
  advanceLeavesQueue = true,
}: {
  opportunityId: string;
  nextStageId: string | null;
  nextStageName: string | null;
  rejectReasonId: string | null;
  /** False when the next stage is itself a review stage, so the row stays. */
  advanceLeavesQueue?: boolean;
}) {
  const [, startTransition] = useTransition();
  const removeRow = useRemoveRow();
  // Hide the row now when the action takes the candidate out of the queue.
  // The buttons stay enabled while it saves: Next runs actions one at a time.
  const act = (fn: () => Promise<unknown>, failure: string, leavesQueue: boolean) =>
    runOptimistic(startTransition, () => (leavesQueue ? removeRow?.() : undefined), fn, failure);

  return (
    <span className="flex shrink-0 items-center gap-1">
      {nextStageId ? (
        <button
          onClick={() => act(() => moveStageAction(opportunityId, nextStageId), 'Advancing the candidate', advanceLeavesQueue)}
          className={buttonClass({ variant: 'tonal', size: 'xs' })}
          title={nextStageName ? `Move to ${nextStageName}` : undefined}
        >
          Advance
        </button>
      ) : null}
      {rejectReasonId ? (
        <button
          onClick={() => act(() => archiveOpportunityAction(opportunityId, rejectReasonId), 'Archiving the candidate', true)}
          className={buttonClass({ variant: 'ghost', size: 'xs' })}
        >
          Archive
        </button>
      ) : null}
    </span>
  );
}
