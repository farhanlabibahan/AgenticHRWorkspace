'use client';

import { useOptimistic, useRef, useState, useTransition, type ReactNode } from 'react';
import { Check, FileText, Mail, MapPin, Pencil, Phone, Plus, X } from 'lucide-react';
import { updateContactDetailsAction } from '@/app/(app)/actions';
import { inputClass, noAutofill, surface } from '@/components/form-controls';
import { SiteIcon } from '@/components/site-icon';
import { buttonClass } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

type Details = { emails: string[]; phones: string[]; location: string | null; links: string[] };
type Kind = 'emails' | 'phones' | 'location' | 'links';

/** Which value is being edited: a kind and its index, or a new one (index = length). */
type Editing = { kind: Kind; index: number } | null;

const LABEL: Record<Kind, string> = { emails: 'email', phones: 'phone', location: 'location', links: 'link' };
const PLACEHOLDER: Record<Kind, string> = {
  emails: 'name@example.com',
  phones: '+1 555 010 0000',
  location: 'City, region',
  links: 'linkedin.com/in/…, portfolio, GitHub',
};

const valuesOf = (d: Details, kind: Kind): string[] => (kind === 'location' ? (d.location ? [d.location] : []) : d[kind]);

function withValue(d: Details, kind: Kind, index: number, value: string): Details {
  if (kind === 'location') return { ...d, location: value.trim() || null };
  const next = [...d[kind]];
  if (value.trim()) next[index] = value.trim();
  else next.splice(index, 1);
  return { ...d, [kind]: next };
}

const icon = (kind: Kind, value: string): ReactNode =>
  kind === 'emails' ? (
    <Mail size={14} className="shrink-0 text-ink-2" />
  ) : kind === 'phones' ? (
    <Phone size={14} className="shrink-0 text-ink-2" />
  ) : kind === 'location' ? (
    <MapPin size={14} className="shrink-0 text-ink-2" />
  ) : (
    <SiteIcon url={value} />
  );

const hrefOf = (kind: Kind, value: string): string | null =>
  kind === 'emails'
    ? `mailto:${value}`
    : kind === 'phones'
      ? `tel:${value.replace(/[^\d+]/g, '')}`
      : kind === 'links'
        ? value.startsWith('http')
          ? value
          : `https://${value}`
        : null;

const row = 'flex min-h-11 items-center gap-2.5 px-4 text-sm';

/**
 * The person's contact details, each editable in place: a pencil on the
 * row, Enter to save, Escape to cancel, empty to remove. Kinds with nothing
 * yet offer an "Add" row. The change shows at once and settles when the
 * server confirms; a rejected value comes back with the reason.
 */
export function ContactCard({
  opportunityId,
  contactId,
  details,
  resume,
}: {
  opportunityId: string;
  contactId: string;
  details: Details;
  resume: { href: string; note: string | null } | null;
}) {
  const [optimistic, apply] = useOptimistic(details, (_: Details, next: Details) => next);
  const [editing, setEditing] = useState<Editing>(null);
  // A rejected value stays in its field with the reason, not reverted.
  const [error, setError] = useState<{ kind: Kind; message: string; draft: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save(kind: Kind, index: number, value: string) {
    setEditing(null);
    const current = valuesOf(optimistic, kind)[index] ?? '';
    if (value.trim() === current) return;
    const next = withValue(optimistic, kind, index, value);
    startTransition(async () => {
      apply(next);
      const patch = kind === 'location' ? { location: next.location } : { [kind]: next[kind] };
      const result = await updateContactDetailsAction(opportunityId, contactId, patch);
      if (result.error) {
        setError({ kind, message: result.error, draft: value });
        setEditing({ kind, index });
      } else setError(null);
    });
  }

  function cancel() {
    setEditing(null);
    setError(null);
  }

  const kinds: Kind[] = ['emails', 'phones', 'location', 'links'];
  const empty = kinds.every((k) => !valuesOf(optimistic, k).length) && !resume;

  return (
    <section>
      <SectionHeader title="Contact" />
      <div className={cn(surface, 'divide-y divide-line overflow-hidden', pending && 'cursor-progress')}>
        {kinds.flatMap((kind) => {
          const values = valuesOf(optimistic, kind);
          const rows = values.map((value, index) =>
            editing?.kind === kind && editing.index === index ? (
              <EditRow
                key={`${kind}${index}`}
                kind={kind}
                initial={error?.kind === kind ? error.draft : value}
                error={error?.kind === kind ? error.message : null}
                onSave={(v) => save(kind, index, v)}
                onCancel={cancel}
              />
            ) : (
              <ValueRow
                key={`${kind}${index}`}
                kind={kind}
                value={value}
                onEdit={() => {
                  setError(null);
                  setEditing({ kind, index });
                }}
              />
            ),
          );
          if (editing?.kind === kind && editing.index >= values.length) {
            rows.push(
              <EditRow
                key={`${kind}-new`}
                kind={kind}
                initial={error?.kind === kind ? error.draft : ''}
                error={error?.kind === kind ? error.message : null}
                onSave={(v) => save(kind, values.length, v)}
                onCancel={cancel}
              />,
            );
          }
          return rows;
        })}

        {resume ? (
          <>
            <a href={resume.href} target="_blank" className={cn(row, 'transition-colors duration-[120ms] hover:bg-muted/60')}>
              <FileText size={14} className="shrink-0 text-ink-2" />
              <span className="truncate">Resume</span>
            </a>
            {resume.note ? <p className="px-4 py-3 text-xs text-ink-3">{resume.note}</p> : null}
          </>
        ) : null}

        {empty && !editing ? <p className="px-4 py-3 text-sm text-ink-2">No contact details yet.</p> : null}

        {/* What's missing, one quiet row to add each; links can always take another */}
        <div className="flex flex-wrap gap-1 px-2.5 py-2">
          {kinds
            .filter((k) => (k === 'links' ? true : !valuesOf(optimistic, k).length))
            .filter((k) => !(editing?.kind === k && editing.index >= valuesOf(optimistic, k).length))
            .map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setError(null);
                  setEditing({ kind: k, index: valuesOf(optimistic, k).length });
                }}
                className={buttonClass({ variant: 'ghost', size: 'xs' })}
              >
                <Plus /> {k === 'links' && optimistic.links.length ? 'Add another link' : `Add ${LABEL[k]}`}
              </button>
            ))}
        </div>
      </div>
    </section>
  );
}

function ValueRow({ kind, value, onEdit }: { kind: Kind; value: string; onEdit: () => void }) {
  const href = hrefOf(kind, value);
  const text = kind === 'links' ? value.replace(/^https?:\/\//, '') : value;
  return (
    <div className="group relative flex items-center">
      {href ? (
        <a
          href={href}
          target={kind === 'links' ? '_blank' : undefined}
          rel={kind === 'links' ? 'noopener noreferrer' : undefined}
          className={cn(row, 'min-w-0 flex-1 pr-11 transition-colors duration-[120ms] hover:bg-muted/60')}
        >
          {icon(kind, value)}
          <span className="truncate">{text}</span>
        </a>
      ) : (
        <div className={cn(row, 'min-w-0 flex-1 pr-11')}>
          {icon(kind, value)}
          <span className="truncate">{text}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${LABEL[kind]} ${text}`}
        className={buttonClass({
          variant: 'ghost',
          size: 'xs',
          icon: true,
          // Hover-revealed where there's hover; always there on touch.
          className: 'absolute right-2.5 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100',
        })}
      >
        <Pencil />
      </button>
    </div>
  );
}

function EditRow({
  kind,
  initial,
  error,
  onSave,
  onCancel,
}: {
  kind: Kind;
  initial: string;
  error: string | null;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form
      className="flex flex-col gap-1.5 px-2.5 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(ref.current?.value ?? '');
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          {...noAutofill}
          ref={ref}
          autoFocus
          defaultValue={initial}
          aria-label={initial ? `Edit ${LABEL[kind]}` : `Add ${LABEL[kind]}`}
          aria-invalid={error ? true : undefined}
          placeholder={PLACEHOLDER[kind]}
          inputMode={kind === 'emails' ? 'email' : kind === 'phones' ? 'tel' : kind === 'links' ? 'url' : 'text'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          className={cn(inputClass, 'h-8 min-w-0 flex-1 text-sm')}
        />
        <button type="submit" aria-label="Save" className={buttonClass({ variant: 'tonal', size: 'sm', icon: true })}>
          <Check />
        </button>
        <button type="button" aria-label="Cancel" onClick={onCancel} className={buttonClass({ variant: 'ghost', size: 'sm', icon: true })}>
          <X />
        </button>
      </div>
      {error ? <p className="px-1 text-xs text-critical">{error}</p> : initial ? (
        <p className="px-1 text-xs text-ink-3">Clear it and save to remove this {LABEL[kind]}.</p>
      ) : null}
    </form>
  );
}
