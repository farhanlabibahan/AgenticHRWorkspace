'use client';

import { useState, useTransition } from 'react';
import { saveReportAction } from '@/app/(app)/actions';
import { inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export function SaveReportButton({ config }: { config: Record<string, string> }) {
  const [pending, startTransition] = useTransition();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);

  if (saved)
    return (
      <Badge onCanvas tone="positive">
        Saved
      </Badge>
    );

  return naming ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await saveReportAction(name, config);
          if (!result.error) setSaved(true);
        });
      }}
    >
      <input {...noAutofill}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => setNaming(false)}
        placeholder="Report name…"
        disabled={pending}
        className={cn(inputClass, 'h-8 w-40')}
      />
    </form>
  ) : (
    <button onClick={() => setNaming(true)} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
      Save report
    </button>
  );
}
