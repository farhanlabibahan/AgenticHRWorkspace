'use client';

import { useState, useActionState, useTransition } from 'react';
import { FileSignature } from 'lucide-react';
import {
  createOfferAction,
  sendOfferAction,
  setOfferStatusAction,
  type FormState,
} from '@/app/(app)/actions';
import {
  Field,
  btnGhost,
  btnPrimary,
  inputClass,
  surface,
  textareaClass,
  noAutofill,
} from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';
import { TextSwap } from '@/components/ui/motion';
import { CopyButton } from '@/components/ui/copy-button';
import { LocalTime } from '@/components/local-time';

const DEFAULT_LETTER = `Dear {{candidate_name}},

We are delighted to offer you the position of {{job_title}} at {{company_name}}.

Your compensation will be {{salary}}{{equity_clause}}. Your anticipated start date is {{start_date}}.

This offer{{expiry_clause}} is contingent on any background or reference checks we have discussed, and this letter does not constitute a contract of employment for any specific period.

We would be thrilled to have you on the team. To accept, review this letter and sign below.

Warmly,
{{company_name}}`;

const STATUS_TONES: Record<string, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'caution',
  SENT: 'info',
  ACCEPTED: 'positive',
  DECLINED: 'critical',
  WITHDRAWN: 'critical',
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  SENT: 'Sent',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
};

const NEXT_ACTIONS: Record<string, { label: string; status: 'SENT' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'DRAFT' }[]> = {
  DRAFT: [{ label: 'Withdraw', status: 'WITHDRAWN' }],
  PENDING_APPROVAL: [{ label: 'Withdraw', status: 'WITHDRAWN' }],
  SENT: [
    { label: 'Accepted', status: 'ACCEPTED' },
    { label: 'Declined', status: 'DECLINED' },
    { label: 'Withdraw', status: 'WITHDRAWN' },
  ],
  ACCEPTED: [],
  DECLINED: [],
  WITHDRAWN: [],
};

export type OfferItem = {
  id: string;
  status: string;
  jobTitle: string;
  salaryAmount: number | null;
  salaryCurrency: string;
  equity: string | null;
  startDate: string | null;
  notes: string | null;
  createdAt: string;
  offerUrl: string | null;
  signedName: string | null;
  signedAt: string | null;
};

export function OfferSection({
  opportunityId,
  archived,
  offers,
  canApprove = false,
  approvalRequired = false,
}: {
  opportunityId: string;
  archived: boolean;
  offers: OfferItem[];
  canApprove?: boolean;
  approvalRequired?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createOfferAction,
    undefined,
  );
  const [statusPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section>
      <SectionHeader
        title="Offers"
        action={
          !archived ? (
            <button onClick={() => setOpen((v) => !v)} className={btnGhost}>
              <FileSignature /> {open ? 'Cancel' : 'Create offer'}
            </button>
          ) : null
        }
      />

      {open ? (
        <form action={formAction} className={`${surface} mb-3 flex flex-col gap-3 p-5`}>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <Field label="Job title">
            <input {...noAutofill} name="jobTitle" required placeholder="Senior Product Designer" className={inputClass} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Base salary">
              <input {...noAutofill} name="salaryAmount" type="number" min="0" placeholder="150000" className={inputClass} />
            </Field>
            <Field label="Currency">
              <input {...noAutofill} name="salaryCurrency" placeholder="USD" defaultValue="USD" className={inputClass} />
            </Field>
            <Field label="Start date">
              <input {...noAutofill} name="startDate" type="date" className={inputClass} />
            </Field>
          </div>
          <Field label="Equity (optional)">
            <input {...noAutofill} name="equity" placeholder="0.05%" className={inputClass} />
          </Field>
          <Field label="Notes (optional)">
            <textarea {...noAutofill} name="notes" rows={2} className={textareaClass} />
          </Field>
          <Field label="Offer letter">
            <textarea {...noAutofill}
              name="letterBody"
              rows={8}
              defaultValue={DEFAULT_LETTER}
              className={textareaClass}
            />
          </Field>
          <p className="text-xs text-ink-2">
            Tokens fill from the terms above when the candidate opens their link:{' '}
            {'{{candidate_name}} {{job_title}} {{company_name}} {{salary}} {{equity_clause}} {{start_date}} {{expiry_clause}}'}
          </p>
          {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className={btnPrimary}>
              <TextSwap>{pending ? 'Creating…' : 'Create draft offer'}</TextSwap>
            </button>
          </div>
        </form>
      ) : null}

      {error ? <p className="mb-2 text-sm text-critical">{error}</p> : null}
      {notice ? <p className="mb-2 text-sm text-ink-2">{notice}</p> : null}

      {offers.length ? (
        <div className={`${surface} divide-y divide-line`}>
          {offers.map((o) => (
            <div key={o.id} className="px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={STATUS_TONES[o.status]}>
                  {STATUS_LABELS[o.status] ?? o.status.toLowerCase()}
                </Badge>
                <span className="text-xs text-ink-2">
                  <LocalTime date={o.createdAt} options={{ year: 'numeric', month: 'numeric', day: 'numeric' }} />
                </span>
              </div>
              <p className="mt-2 text-sm font-medium">{o.jobTitle}</p>
              <p className="mt-0.5 text-sm text-ink-2">
                {o.salaryAmount || o.equity || o.startDate ? (
                  [
                    // en-US on both sides: a browser locale here would differ from the server's render
                    o.salaryAmount ? `${o.salaryCurrency} ${o.salaryAmount.toLocaleString('en-US')}` : null,
                    o.equity ? `${o.equity} equity` : null,
                    o.startDate ? (
                      <>
                        starts <LocalTime date={o.startDate} options={{ month: 'short', day: 'numeric' }} />
                      </>
                    ) : null,
                  ]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i}>
                        {i ? ' · ' : ''}
                        {part}
                      </span>
                    ))
                ) : (
                  'No terms recorded'
                )}
              </p>
              {o.notes ? <p className="mt-1.5 whitespace-pre-wrap text-sm">{o.notes}</p> : null}
              {o.signedName ? (
                <p className="mt-1.5 text-sm text-ink-2">
                  Signed <span className="italic">{o.signedName}</span>
                  {o.signedAt ? (
                    <>
                      {' · '}
                      <LocalTime date={o.signedAt} />
                    </>
                  ) : null}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-1">
                {(o.status === 'DRAFT' || o.status === 'SENT') && o.offerUrl ? (
                  <button
                    disabled={statusPending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await sendOfferAction(o.id, opportunityId);
                        setError(result.error ?? null);
                        setNotice(
                          result.pendingApproval
                            ? 'Sent for approval — an admin will review before the candidate sees it.'
                            : null,
                        );
                      })
                    }
                    className={buttonClass({ variant: 'tonal', size: 'xs' })}
                  >
                    {o.status === 'DRAFT'
                      ? approvalRequired && !canApprove
                        ? 'Request approval'
                        : 'Send to candidate'
                      : 'Resend link'}
                  </button>
                ) : null}
                {o.status === 'PENDING_APPROVAL' && canApprove ? (
                  <>
                    <button
                      disabled={statusPending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await sendOfferAction(o.id, opportunityId);
                          setError(result.error ?? null);
                          setNotice(null);
                        })
                      }
                      className={buttonClass({ variant: 'tonal', size: 'xs' })}
                    >
                      Approve & send
                    </button>
                    <button
                      disabled={statusPending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await setOfferStatusAction(o.id, opportunityId, 'DRAFT');
                          setError(result.error ?? null);
                        })
                      }
                      className={buttonClass({ variant: 'ghost', size: 'xs' })}
                    >
                      Reject
                    </button>
                  </>
                ) : null}
                {o.offerUrl && o.status !== 'DRAFT' && o.status !== 'PENDING_APPROVAL' ? (
                  <CopyButton text={() => `${window.location.origin}${o.offerUrl}`} label="Copy offer link" />
                ) : null}
                {(NEXT_ACTIONS[o.status] ?? []).map((a) => (
                  <button
                    key={a.status}
                    disabled={statusPending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await setOfferStatusAction(o.id, opportunityId, a.status);
                        setError(result.error ?? null);
                      })
                    }
                    className={buttonClass({ variant: 'ghost', size: 'xs' })}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : !open ? (
        <p className="text-sm text-ink-2">No offers yet.</p>
      ) : null}
    </section>
  );
}