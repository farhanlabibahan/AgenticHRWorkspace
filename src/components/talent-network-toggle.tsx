'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setTalentNetworkAction } from '@/app/org-actions';
import { Switch } from '@/components/switch';
import { TextSwap } from '@/components/ui/motion';

export function TalentNetworkToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={enabled}
        disabled={pending}
        label="Talent network opt-in"
        onChange={(next) =>
          startTransition(async () => {
            await setTalentNetworkAction(next);
            router.refresh();
          })
        }
      />
      <span className="text-xs text-ink-2">
        <TextSwap>{pending ? 'Saving…' : enabled ? 'Opt-in enabled' : 'Disabled'}</TextSwap>
      </span>
    </div>
  );
}
