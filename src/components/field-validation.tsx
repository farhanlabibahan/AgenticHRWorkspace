'use client';

import { useEffect, useState } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Replaces the browser's validation bubble ("Please fill out this field.",
 * with its orange icon) with our own, on every page. Native validation
 * still runs: `required`, `type="email"` and friends still stop a form
 * from submitting. We only take over how the problem is shown. The field
 * gets a critical stroke (`aria-invalid`), and a small note sits under it
 * until the person types, or it times out.
 *
 * Mounted once in the root layout; listens for `invalid` in the capture
 * phase, since the event doesn't bubble.
 */

const HIDE_MS = 4000;

function messageFor(el: Field) {
  const v = el.validity;
  if (v.valueMissing) {
    return el instanceof HTMLSelectElement ? 'Choose an option' : 'This can’t be empty';
  }
  if (v.typeMismatch && el.type === 'email') return 'Enter an email address, like name@company.com';
  if (v.typeMismatch && el.type === 'url') return 'Enter a full link, starting with https://';
  if (v.tooShort && 'minLength' in el) return `Use at least ${el.minLength} characters`;
  if (v.rangeUnderflow && 'min' in el) return `Enter ${el.min} or more`;
  if (v.rangeOverflow && 'max' in el) return `Enter ${el.max} or less`;
  if (v.patternMismatch && el.title) return el.title;
  return el.validationMessage;
}

export function FieldValidation() {
  const [note, setNote] = useState<{ el: Field; text: string; x: number; y: number; w: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Field | null = null;
    let shownAt = 0;

    const clear = () => {
      clearTimeout(timer);
      current?.removeAttribute('aria-invalid');
      current = null;
      setNote(null);
    };

    const onInvalid = (e: Event) => {
      const el = e.target as Field;
      if (!(el instanceof HTMLElement) || !('validity' in el)) return;
      // no native bubble, and no native hover tooltip on the invalid field
      e.preventDefault();
      if (!el.hasAttribute('title')) el.setAttribute('title', '');
      el.setAttribute('aria-invalid', 'true');
      // a submit fires `invalid` for every bad field; point at the first one
      const form = el.form;
      const first = form ? (form.querySelector(':invalid') as Field | null) : el;
      if (first && first !== el) return;
      clearTimeout(timer);
      if (current && current !== el) current.removeAttribute('aria-invalid');
      current = el;
      shownAt = Date.now();
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        setNote({ el, text: messageFor(el), x: r.left, y: r.bottom + 6, w: r.width });
      });
      timer = setTimeout(clear, HIDE_MS);
    };

    const onEdit = (e: Event) => {
      const el = e.target as Field;
      if (el.getAttribute?.('aria-invalid') !== 'true') return;
      el.removeAttribute('aria-invalid');
      if (el === current) clear();
    };

    document.addEventListener('invalid', onInvalid, true);
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
    // the note is placed once; scrolling away hides it (but not the scroll
    // we just caused bringing the field into view)
    const onScroll = () => {
      if (Date.now() - shownAt > 400) clear();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', clear);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('invalid', onInvalid, true);
      document.removeEventListener('input', onEdit, true);
      document.removeEventListener('change', onEdit, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', clear);
    };
  }, []);

  if (!note) return null;
  return (
    <div
      role="alert"
      className="field-note pointer-events-none fixed z-[500] flex max-w-xs items-center gap-2 rounded-field bg-surface px-3 py-2 text-xs text-ink shadow-float"
      style={{ left: note.x, top: note.y, minWidth: Math.min(note.w, 180) }}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-critical" />
      {note.text}
    </div>
  );
}
