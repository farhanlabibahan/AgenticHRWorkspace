'use client';

import { useRef, useState, useTransition } from 'react';
import { FileSpreadsheet, Plus, X } from 'lucide-react';
import {
  addGroupsAction,
  importGroupsAction,
  removeGroupAction,
  removeGroupsAction,
  type GroupsResult,
} from '@/app/org-actions';
import { splitNames } from '@/lib/names';
import { btnTonal, inputClass, noAutofill } from '@/components/form-controls';

type Status = { text: string; undo: string[] | null } | { error: string } | null;

/**
 * Manages departments (companies) or client companies (agencies). Several at
 * once: comma-separated, a column pasted from a spreadsheet, or an uploaded
 * .csv/.xlsx.
 */
export function GroupManager({
  kind,
  items,
  placeholder,
}: {
  kind: 'department' | 'client';
  items: { id: string; name: string }[];
  placeholder: string;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const noun = (n: number) => (kind === 'client' ? (n === 1 ? 'client' : 'clients') : n === 1 ? 'department' : 'departments');

  function report(result: GroupsResult, from?: string) {
    if ('error' in result) return setStatus({ error: result.error });
    const { created, existing } = result;
    const parts: string[] = [];
    if (created.length) parts.push(`Added ${created.length} ${noun(created.length)}${from ? ` from ${from}` : ''}`);
    if (existing) parts.push(`${existing} ${existing === 1 ? 'was' : 'were'} already here`);
    // One is removed with its own ×; undo is for a batch.
    setStatus({ text: parts.join(' · '), undo: created.length > 1 ? created.map((c) => c.id) : null });
  }

  function add(names: string[]) {
    if (!names.length) return;
    startTransition(async () => {
      const result = await addGroupsAction(kind, names);
      report(result);
      if (!('error' in result)) setValue('');
    });
  }

  function upload(file: File) {
    const form = new FormData();
    form.set('file', file);
    startTransition(async () => report(await importGroupsAction(kind, form), file.name));
  }

  return (
    <div className="flex flex-col gap-3">
      {items.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <span
              key={item.id}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-muted pl-3 pr-1 text-sm"
            >
              {item.name}
              <button
                title={`Remove ${item.name}`}
                aria-label={`Remove ${item.name}`}
                disabled={pending}
                onClick={() => {
                  if (!confirm(`Remove ${item.name}? Postings keep working but lose this grouping.`)) return;
                  startTransition(() => removeGroupAction(kind, item.id));
                }}
                className="flex size-6 cursor-pointer items-center justify-center rounded-full text-ink-2 transition-colors duration-[120ms] hover:bg-recessed hover:text-ink disabled:opacity-40"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add(splitNames(value));
        }}
        className="flex items-center gap-2"
      >
        <input
          {...noAutofill}
          name="name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => {
            // A column or row copied from a spreadsheet: a one-line field would
            // run the names together, so add them straight away.
            const text = e.clipboardData.getData('text');
            if (!/[\n\t]/.test(text.trim())) return;
            e.preventDefault();
            add(splitNames(text));
          }}
          placeholder={placeholder}
          aria-describedby={`${kind}-groups-hint`}
          className={inputClass}
        />
        <button type="submit" disabled={pending} className={btnTonal}>
          <Plus /> Add
        </button>
        <button type="button" disabled={pending} onClick={() => fileInput.current?.click()} className={btnTonal}>
          <FileSpreadsheet /> Upload
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // the same file can be picked again
            if (file) upload(file);
          }}
        />
      </form>

      <p id={`${kind}-groups-hint`} role="status" className="text-xs text-ink-3">
        {status && 'error' in status ? (
          <span className="text-critical">{status.error}</span>
        ) : status ? (
          <>
            {status.text}
            {status.undo ? (
              <>
                {' · '}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const ids = status.undo!;
                    startTransition(async () => {
                      await removeGroupsAction(kind, ids);
                      setStatus({ text: `Removed ${ids.length} ${noun(ids.length)}`, undo: null });
                    });
                  }}
                  className="cursor-pointer font-medium text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-40"
                >
                  Undo
                </button>
              </>
            ) : null}
          </>
        ) : (
          `Add several at once: separate them with commas, paste a column from a spreadsheet, or upload a .csv or Excel file.`
        )}
      </p>
    </div>
  );
}
