'use client';

import { useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import { createCustomFieldAction, deleteCustomFieldAction } from '@/app/org-actions';
import { btnTonal, inputClass, badge, noAutofill } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';

export type FieldDef = { id: string; label: string; type: string; options: string[] };

export function CustomFieldsManager({ defs }: { defs: FieldDef[] }) {
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const [type, setType] = useState('TEXT');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {defs.length ? (
        <div className="flex flex-wrap gap-2">
          {defs.map((d) => (
            <span key={d.id} className={`${badge} pr-1.5`}>
              {d.label} · {d.type.toLowerCase()}
              <button
                title={`Remove ${d.label}`}
                aria-label={`Remove ${d.label}`}
                disabled={pending}
                onClick={() => {
                  if (!confirm(`Remove the "${d.label}" field? Existing values stay on candidates but stop being shown.`)) return;
                  startTransition(() => deleteCustomFieldAction(d.id));
                }}
                className="flex size-4 cursor-pointer items-center justify-center rounded-full text-ink-3 transition-colors duration-[120ms] hover:text-critical disabled:opacity-40"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await createCustomFieldAction(label, type, options);
            if (result.error) setError(result.error);
            else {
              setLabel('');
              setOptions('');
              setError(null);
            }
          });
        }}
      >
        <input {...noAutofill}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          placeholder="Field label (e.g. Notice period)"
          className={inputClass}
        />
        <FormSelect
          value={type}
          onChange={setType}
          className="sm:w-32"
          options={[
            { value: 'TEXT', label: 'Text' },
            { value: 'NUMBER', label: 'Number' },
            { value: 'DATE', label: 'Date' },
            { value: 'SELECT', label: 'Dropdown' },
          ]}
        />
        {type === 'SELECT' ? (
          <input {...noAutofill}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="Options, comma-separated"
            className={inputClass}
          />
        ) : null}
        <button type="submit" disabled={pending || !label.trim()} className={btnTonal}>
          <Plus /> Add field
        </button>
      </form>
      {error ? <p className="text-sm text-critical">{error}</p> : null}
    </div>
  );
}
