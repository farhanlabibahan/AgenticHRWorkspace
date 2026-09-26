'use client';

import { useState, useTransition } from 'react';
import { Plus, Webhook, X } from 'lucide-react';
import {
  createWebhookAction,
  deleteWebhookAction,
  setWebhookActiveAction,
} from '@/app/org-actions';
import { btnTonal, inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/primitives';

type EndpointItem = {
  id: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  delivered: number;
  failed: number;
};

export function WebhooksManager({ endpoints }: { endpoints: EndpointItem[] }) {
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState('');
  const [types, setTypes] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {newSecret ? (
        <div className="rounded-field bg-positive/10 p-3">
          <p className="text-sm font-medium text-positive">
            Signing secret — copy now, shown once. Verify X-Source-Signature with it.
          </p>
          <code className="mt-1.5 block select-all break-all rounded-field bg-surface px-2 py-1.5 font-mono text-xs">
            {newSecret}
          </code>
        </div>
      ) : null}

      {endpoints.length ? (
        <div className="flex flex-col divide-y divide-line">
          {endpoints.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
              <div className="flex min-w-0 items-center gap-3">
                <Webhook size={16} className="shrink-0 text-ink-2" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{e.url}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-2 tabular-nums">
                    {e.eventTypes.length ? (
                      <span className="font-mono">{e.eventTypes.join(', ')}</span>
                    ) : (
                      'all events'
                    )}{' '}
                    · {e.delivered} delivered
                    {e.failed ? <span className="text-critical"> · {e.failed} failing</span> : ''}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  disabled={pending}
                  onClick={() => startTransition(() => setWebhookActiveAction(e.id, !e.active))}
                  className={buttonClass({ variant: 'tonal', size: 'xs' })}
                >
                  <StatusDot tone={e.active ? 'positive' : 'neutral'} />
                  {e.active ? 'Active' : 'Paused'}
                </button>
                <button
                  title="Delete endpoint"
                  aria-label="Delete endpoint"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm('Delete this webhook endpoint? Deliveries stop immediately.')) return;
                    startTransition(() => deleteWebhookAction(e.id));
                  }}
                  className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'hover:text-critical' })}
                >
                  <X />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input {...noAutofill}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/webhooks/source"
          className={inputClass}
        />
        <input {...noAutofill}
          value={types}
          onChange={(e) => setTypes(e.target.value)}
          placeholder="Event filter (optional): application.received, opportunity.hired"
          className={inputClass}
        />
        <button
          disabled={pending || !url.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await createWebhookAction(url.trim(), types.trim());
              if (result.secret) {
                setNewSecret(result.secret);
                setUrl('');
                setTypes('');
                setError(null);
              } else setError(result.error ?? 'Failed');
            })
          }
          className={btnTonal}
        >
          <Plus /> Add
        </button>
      </div>
      {error ? <p className="text-sm text-critical">{error}</p> : null}
    </div>
  );
}
