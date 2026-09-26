'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Switch } from '@/components/switch';
import { TextSwap } from '@/components/ui/motion';

export function SettingsSwitch({
  enabled,
  label,
  onCaption,
  offCaption,
  onToggle,
}: {
  enabled: boolean;
  label: string;
  onCaption: string;
  offCaption: string;
  onToggle: (next: boolean) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={enabled}
        disabled={pending}
        label={label}
        onChange={(next) =>
          startTransition(async () => {
            await onToggle(next);
            router.refresh();
          })
        }
      />
      <span className="text-xs text-ink-2">
        <TextSwap>{pending ? 'Saving…' : enabled ? onCaption : offCaption}</TextSwap>
      </span>
    </div>
  );
}
