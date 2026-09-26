'use client';

import { useRef, useState, useTransition, useActionState } from 'react';
import { Mail } from 'lucide-react';
import { cancelEmailAction, sendEmailAction, type FormState } from '@/app/(app)/actions';
import {
  Field,
  btnGhost,
  btnPrimary,
  inputClass,
  surface,
  textareaClass,
  noAutofill,
} from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { buttonClass } from '@/components/ui/button';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';
import { TextSwap } from '@/components/ui/motion';
import { LocalTime } from '@/components/local-time';

const EMAIL_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

type EmailItem = {
  id: string;
  subject: string;
  toEmail: string;
  status: 'SCHEDULED' | 'SENT' | 'FAILED' | 'CANCELED';
  scheduledAt: string | null;
  sentAt: string | null;
  automated: boolean;
};

const STATUS_TONES: Record<EmailItem['status'], Tone> = {
  SENT: 'positive',
  SCHEDULED: 'caution',
  FAILED: 'critical',
  CANCELED: 'neutral',
};

const STATUS_LABELS: Record<EmailItem['status'], string> = {
  SENT: 'Sent',
  SCHEDULED: 'Scheduled',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
};

export function EmailSection({
  opportunityId,
  toEmail,
  emails,
  templates,
}: {
  opportunityId: string;
  toEmail: string | null;
  emails: EmailItem[];
  templates: { id: string; name: string; subject: string; body: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    sendEmailAction,
    undefined,
  );
  const [, startTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const applyTemplate = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    if (subjectRef.current) subjectRef.current.value = template.subject;
    if (bodyRef.current) bodyRef.current.value = template.body;
  };

  return (
    <section>
      <SectionHeader
        title="Email"
        action={
          toEmail ? (
            <button onClick={() => setOpen((v) => !v)} className={btnGhost}>
              <Mail /> {open ? 'Cancel' : 'Compose'}
            </button>
          ) : null
        }
      />

      {open ? (
        <form action={formAction} className={`${surface} mb-3 flex flex-col gap-3 p-5`}>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="To">
              <input {...noAutofill} value={toEmail ?? ''} disabled className={inputClass} />
            </Field>
            <Field label="Template">
              <FormSelect
                name="templateId"
                onChange={applyTemplate}
                options={[
                  { value: '', label: 'Blank' },
                  ...templates.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            </Field>
          </div>
          <Field label="Subject">
            <input {...noAutofill} ref={subjectRef} name="subject" required className={inputClass} />
          </Field>
          <Field label="Body">
            <textarea {...noAutofill} ref={bodyRef} name="body" rows={6} required className={textareaClass} />
          </Field>
          <Field label="Schedule (optional — sends immediately if empty)">
            <input {...noAutofill} name="scheduledAt" type="datetime-local" className={inputClass} />
          </Field>
          <p className="text-xs text-ink-2">
            Tokens like {'{{first_name}}'}, {'{{job_title}}'}, {'{{company_name}}'} are filled in
            automatically.
          </p>
          {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className={btnPrimary}>
              <TextSwap>{pending ? 'Sending…' : 'Send'}</TextSwap>
            </button>
          </div>
        </form>
      ) : null}

      {emails.length ? (
        <div className={`${surface} divide-y divide-line`}>
          {emails.map((m) => (
            <div key={m.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{m.subject}</p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {m.automated ? 'Automation' : 'Manual'} · to {m.toEmail} ·{' '}
                    {m.status === 'SCHEDULED' && m.scheduledAt ? (
                      <>
                        sends <LocalTime date={m.scheduledAt} options={EMAIL_TIME} />
                      </>
                    ) : m.sentAt ? (
                      <LocalTime date={m.sentAt} options={EMAIL_TIME} />
                    ) : null}
                  </p>
                </div>
                <Badge tone={STATUS_TONES[m.status]}>{STATUS_LABELS[m.status]}</Badge>
              </div>
              {m.status === 'SCHEDULED' ? (
                <button
                  onClick={() => startTransition(() => cancelEmailAction(m.id, opportunityId))}
                  className={buttonClass({ variant: 'ghost', size: 'xs', className: '-ml-2.5 mt-2' })}
                >
                  Cancel send
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : !open ? (
        <p className="text-sm text-ink-2">
          {toEmail ? 'No emails yet.' : 'Add an email address to this contact to send email.'}
        </p>
      ) : null}
    </section>
  );
}
