'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setRequirePostingApprovalAction } from '@/app/org-actions';
import { Switch } from '@/components/switch';
import { TextSwap } from '@/components/ui/motion';

export function PostingApprovalToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={enabled}
        disabled={pending}
        label="Require posting approval"
        onChange={(next) =>
          startTransition(async () => {
            await setRequirePostingApprovalAction(next);
            router.refresh();
          })
        }
      />
      <span className="text-xs text-ink-2">
        <TextSwap>{pending ? 'Saving…' : enabled ? 'Approval required' : 'Anyone can publish'}</TextSwap>
      </span>
    </div>
  );
}
