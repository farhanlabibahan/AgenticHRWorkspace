'use client';

import { createContext, useContext, useOptimistic, useTransition, type ReactNode } from 'react';
import type { PostingState } from '@prisma/client';
import { setPostingStateAction } from '@/app/(app)/actions';
import { buttonClass } from '@/components/ui/button';
import { Badge, StatusDot, type Tone } from '@/components/ui/primitives';
import { runOptimistic } from '@/lib/optimistic';
import { POSTING_STATE_BADGES } from '@/lib/posting-states';

// Row actions: the forward step is a tonal xs pill, everything else ghost.
const forwardClass = buttonClass({ variant: 'tonal', size: 'xs' });
const quietClass = buttonClass({ variant: 'ghost', size: 'xs' });

type Scope = {
  state: PostingState;
  set: (next: PostingState) => void;
  gated: boolean;
  isAdmin: boolean;
};
const PostingStateContext = createContext<Scope | null>(null);

function useScope() {
  const scope = useContext(PostingStateContext);
  if (!scope) throw new Error('Render inside <PostingStateScope>');
  return scope;
}

/**
 * One posting's state, shared by its badge and its menu so both switch
 * together the moment a change is picked; the server confirms behind them.
 * Wrap the whole row (it renders no element of its own).
 */
export function PostingStateScope({
  postingId,
  state: serverState,
  isAdmin = true,
  requireApproval = false,
  children,
}: {
  postingId: string;
  state: PostingState;
  isAdmin?: boolean;
  requireApproval?: boolean;
  children: ReactNode;
}) {
  const [, startTransition] = useTransition();
  // With approvals on, a member's publish becomes a request (server enforces).
  const gated = requireApproval && !isAdmin;
  const [state, setState] = useOptimistic(serverState);

  const set = (next: PostingState) =>
    runOptimistic(
      startTransition,
      () => setState(gated && next === 'PUBLISHED' ? 'PENDING_APPROVAL' : next),
      () => setPostingStateAction(postingId, next),
      'Updating the posting',
    );

  return (
    <PostingStateContext.Provider value={{ state, set, gated, isAdmin }}>
      {children}
    </PostingStateContext.Provider>
  );
}

export function PostingStateBadge() {
  const { state } = useScope();
  const badge = POSTING_STATE_BADGES[state] ?? { label: state, tone: 'neutral' as Tone };
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

/**
 * The row's next steps. Buttons stay enabled while a change saves: the new
 * state is already on screen, and Next runs server actions one at a time.
 */
export function PostingStateMenu() {
  const { state, set, gated, isAdmin } = useScope();

  return (
    <span className="flex items-center justify-end gap-2">
      {state === 'PENDING_APPROVAL' ? (
        isAdmin ? (
          <>
            <button onClick={() => set('PUBLISHED')} className={forwardClass}>
              Approve &amp; publish
            </button>
            <button onClick={() => set('DRAFT')} className={quietClass}>
              Reject
            </button>
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-ink-2">
            <StatusDot tone="caution" />
            Awaiting approval
          </span>
        )
      ) : null}
      {state !== 'PUBLISHED' && state !== 'CLOSED' && state !== 'PENDING_APPROVAL' && (
        <button onClick={() => set('PUBLISHED')} className={forwardClass}>
          {gated ? 'Request approval' : 'Publish'}
        </button>
      )}
      {state === 'PUBLISHED' && (
        <button onClick={() => set('CLOSED')} className={quietClass}>
          Close
        </button>
      )}
      {state === 'CLOSED' && (
        <button onClick={() => set('PUBLISHED')} className={quietClass}>
          {gated ? 'Request reopen' : 'Reopen'}
        </button>
      )}
    </span>
  );
}
