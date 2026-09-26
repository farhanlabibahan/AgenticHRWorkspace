'use client';

import { useState, useTransition } from 'react';
import { KeyRound, Plus, X } from 'lucide-react';
import { createApiKeyAction, revokeApiKeyAction } from '@/app/org-actions';
import { btnTonal, inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';

type KeyItem = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
};

export function ApiKeysManager({ keys }: { keys: KeyItem[] }) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {newKey ? (
        <div className="rounded-field bg-positive/10 p-3">
          <p className="text-sm font-medium text-positive">Copy your key now — it won't be shown again.</p>
          <code className="mt-1.5 block select-all break-all rounded-field bg-surface px-2 py-1.5 font-mono text-xs">
            {newKey}
          </code>
        </div>
      ) : null}

      {keys.length ? (
        <div className="flex flex-col divide-y divide-line">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
              <div className="flex min-w-0 items-center gap-3">
                <KeyRound size={16} className="shrink-0 text-ink-2" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {k.name}
                    <span className="ml-2 font-mono text-xs font-normal text-ink-2">
                      {k.prefix}…
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-2 tabular-nums">
                    Created {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt
                      ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : ' · never used'}
                  </p>
                </div>
              </div>
              {k.revoked ? (
                <Badge tone="critical">Revoked</Badge>
              ) : (
                <button
                  title="Revoke key"
                  aria-label="Revoke key"
                  disabled={pending}
                  onClick={() => startTransition(() => revokeApiKeyAction(k.id))}
                  className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'hover:text-critical' })}
                >
                  <X />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input {...noAutofill}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. Zapier)"
          className={inputClass}
        />
        <button
          disabled={pending || !name.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await createApiKeyAction(name.trim());
              if (result.plaintext) {
                setNewKey(result.plaintext);
                setName('');
                setError(null);
              } else setError(result.error ?? 'Failed');
            })
          }
          className={btnTonal}
        >
          <Plus /> Create key
        </button>
      </div>
      {error ? <p className="text-sm text-critical">{error}</p> : null}
    </div>
  );
}
