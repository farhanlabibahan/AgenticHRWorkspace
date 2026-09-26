'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { useContactsNav } from '@/components/contacts-nav';
import { badge, inputClass, noAutofill } from '@/components/form-controls';

/** Contacts search: a soft navigation with JavaScript, a plain GET form without. */
export function ContactsSearch() {
  const nav = useContactsNav();
  const committedQ = nav.committed.q ?? '';
  // Follows the URL's q (back/forward) without remounting, so focus stays.
  const [draft, setDraft] = useState({ from: committedQ, value: committedQ });
  if (draft.from !== committedQ) setDraft({ from: committedQ, value: committedQ });
  const [hint, setHint] = useState(false);

  return (
    <form
      method="get"
      action="/contacts"
      className="mb-4 flex max-w-md flex-col gap-1"
      onSubmit={(e) => {
        const q = draft.value.trim();
        if (q.length === 1) {
          e.preventDefault();
          setHint(true);
          return;
        }
        setHint(false);
        nav.go({ q }, e);
      }}
    >
      <span className="flex items-center gap-2">
        {nav.input.pool ? <input type="hidden" name="pool" value={nav.input.pool} /> : null}
        {nav.input.tag ? <input type="hidden" name="tag" value={nav.input.tag} /> : null}
        <label className="relative w-full">
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input {...noAutofill}
            type="search"
            name="q"
            value={draft.value}
            onChange={(e) => {
              setDraft({ from: committedQ, value: e.target.value });
              if (hint) setHint(false);
            }}
            placeholder="Search name or headline…"
            aria-label="Search contacts"
            aria-describedby={hint ? 'contacts-q-hint' : undefined}
            className={`${inputClass} pl-9`}
          />
        </label>
        {nav.input.tag ? (
          <Link
            href={nav.hrefFor({ tag: '' })}
            prefetch={false}
            onClick={(e) => nav.go({ tag: '' }, e)}
            className={`${badge} shrink-0 bg-surface text-ink hover:bg-muted`}
          >
            tag: {nav.input.tag} ×
          </Link>
        ) : null}
      </span>
      {hint ? (
        <p id="contacts-q-hint" className="px-1 text-xs text-ink-2">
          Type at least 2 characters.
        </p>
      ) : null}
    </form>
  );
}
