'use client';

import { useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import { setContactTagsAction } from '@/app/(app)/actions';
import { badge, inputClass, noAutofill } from '@/components/form-controls';

export function TagEditor({ contactId, tags }: { contactId: string; tags: string[] }) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');

  const save = (next: string[]) => startTransition(() => setContactTagsAction(contactId, next));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span key={tag} className={`${badge} group gap-1`}>
          {tag}
          <button
            title={`Remove ${tag}`}
            aria-label={`Remove ${tag}`}
            disabled={pending}
            onClick={() => save(tags.filter((t) => t !== tag))}
            className="-mr-1 flex size-4 cursor-pointer items-center justify-center rounded-full text-ink-3 transition-colors hover:text-critical group-hover:text-ink-2"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) save([...tags, value.trim()]);
            setValue('');
            setAdding(false);
          }}
        >
          <input {...noAutofill}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => setAdding(false)}
            placeholder="tag"
            className={`${inputClass} h-6 w-28 px-2.5 text-xs lowercase`}
          />
        </form>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={pending}
          title="Add tag"
          aria-label="Add tag"
          className={`${badge} cursor-pointer transition-colors hover:bg-recessed hover:text-ink`}
        >
          <Plus size={12} /> tag
        </button>
      )}
    </div>
  );
}
