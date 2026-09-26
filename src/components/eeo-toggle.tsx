'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setCollectEeoAction } from '@/app/org-actions';
import { Switch } from '@/components/switch';
import { TextSwap } from '@/components/ui/motion';

export function EeoToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={enabled}
        disabled={pending}
        label="Collect EEO self-identification"
        onChange={(next) =>
          startTransition(async () => {
            await setCollectEeoAction(next);
            router.refresh();
          })
        }
      />
      <span className="text-xs text-ink-2">
        <TextSwap>{pending ? 'Saving…' : enabled ? 'Collecting' : 'Off'}</TextSwap>
      </span>
    </div>
  );
}
