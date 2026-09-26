'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import {
  deleteNewsletterAction,
  previewNewsletterAction,
  saveNewsletterAction,
  sendTestNewsletterAction,
  startNewsletterAction,
} from '@/app/(app)/newsletters/actions';
import { inputClass, noAutofill, sectionLabel, textareaClass } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Chip } from '@/components/ui/primitives';

type Posting = { id: string; title: string; location: string | null };

/**
 * Compose a newsletter: subject, message, the roles to feature, and a live
 * preview of the email itself (rendered on the server, with the brand kit).
 * Sending to everyone takes a second click that says how many people.
 */
export function NewsletterEditor({
  initial,
  postings,
  audience,
  canSend,
  isAdmin,
}: {
  initial: { id: string | null; subject: string; body: string; postingIds: string[] };
  postings: Posting[];
  audience: number;
  /** False when this server can't deliver email: nothing would leave it. */
  canSend: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [id, setId] = useState(initial.id);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [postingIds, setPostingIds] = useState(initial.postingIds);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [html, setHtml] = useState('');
  const input = { subject, body, postingIds };
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
    setNote(null);
    setConfirming(false);
  };

  // The preview follows the text, half a second behind
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const res = await previewNewsletterAction({ subject, body, postingIds });
      if (res.ok && mine === seq.current) setHtml(res.html);
    }, 500);
    return () => clearTimeout(t);
  }, [subject, body, postingIds]);

  /** Save when there's something to save; the id afterwards. */
  const save = async (): Promise<string | null> => {
    if (id && !dirty) return id;
    const res = await saveNewsletterAction(id, input);
    if (!res.ok) {
      setNote({ tone: 'error', text: res.error });
      return null;
    }
    setDirty(false);
    if (!id) {
      setId(res.id);
      window.history.replaceState(null, '', `/newsletters/${res.id}`);
    }
    return res.id;
  };

  const togglePosting = (pid: string) => edit(setPostingIds)(postingIds.includes(pid) ? postingIds.filter((p) => p !== pid) : [...postingIds, pid]);

  const run = (task: () => Promise<void>) => start(task);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <label className="flex flex-col gap-2">
          <span className={sectionLabel}>Subject</span>
          <input {...noAutofill} value={subject} onChange={(e) => edit(setSubject)(e.target.value)} placeholder="New roles at Northwind this month" className={inputClass} />
        </label>
        <label className="flex flex-col gap-2">
          <span className={sectionLabel}>Message</span>
          <textarea
            value={body}
            onChange={(e) => edit(setBody)(e.target.value)}
            rows={10}
            placeholder={'Hi {{first_name}},\n\nWe’re hiring again, and thought of you. Here’s what’s open right now.'}
            className={textareaClass}
          />
          <span className="text-xs text-ink-3">
            A blank line starts a new paragraph, and links work as they are. <code className="font-mono">{'{{first_name}}'}</code> becomes each reader’s first name.
          </span>
        </label>
        <div className="flex flex-col gap-2">
          <span className={sectionLabel}>Roles to feature</span>
          {postings.length ? (
            <div className="flex flex-wrap gap-2">
              {postings.map((p) => (
                <Chip key={p.id} selected={postingIds.includes(p.id)} onClick={() => togglePosting(p.id)}>
                  {postingIds.includes(p.id) ? <Check size={13} /> : null}
                  {p.title}
                  {p.location ? <span className="text-ink-3">· {p.location}</span> : null}
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-2">No roles are published right now. The email still links to your job board.</p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-6">
          {!canSend ? (
            <p className="text-sm text-caution">Email delivery isn’t set up on this server yet, so newsletters can be written but not sent.</p>
          ) : !isAdmin ? (
            <p className="text-sm text-ink-2">Only admins can send to every candidate. Save it, and an admin can send it.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={pending || (!dirty && !!id)} onClick={() => run(async () => void (await save()))} className={buttonClass({ variant: 'secondary' })}>
              {id && !dirty ? 'Saved' : 'Save draft'}
            </button>
            <button
              type="button"
              disabled={pending || !canSend}
              onClick={() =>
                run(async () => {
                  const saved = await save();
                  if (!saved) return;
                  const res = await sendTestNewsletterAction(saved);
                  setNote(res.ok ? { tone: 'ok', text: `A test copy is on its way to ${res.sentTo}.` } : { tone: 'error', text: res.error });
                })
              }
              className={buttonClass({ variant: 'tonal' })}
            >
              Send me a test
            </button>
            {confirming ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const saved = await save();
                      if (!saved) return;
                      const res = await startNewsletterAction(saved);
                      if (!res.ok) return setNote({ tone: 'error', text: res.error });
                      router.push(`/newsletters/${saved}`);
                      router.refresh();
                    })
                  }
                  className={buttonClass({ variant: 'primary' })}
                >
                  {pending ? 'Sending…' : `Yes, send to ${audience.toLocaleString()}`}
                </button>
                <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={buttonClass({ variant: 'ghost' })}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending || !canSend || !isAdmin || !audience || !subject.trim() || !body.trim()}
                onClick={() => setConfirming(true)}
                className={buttonClass({ variant: 'primary' })}
              >
                Send to {audience.toLocaleString()} {audience === 1 ? 'candidate' : 'candidates'}
              </button>
            )}
          </div>
          {confirming ? <p className="text-sm text-ink-2">It goes out at once and can’t be unsent.</p> : null}
          {note ? <p className={note.tone === 'error' ? 'text-sm text-critical' : 'text-sm text-ink-2'}>{note.text}</p> : null}
          {id ? (
            <form action={deleteNewsletterAction.bind(null, id)}>
              <button type="submit" className="text-xs text-ink-3 underline underline-offset-2 hover:text-ink-2">
                Delete draft
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="min-w-0">
        <p className={`${sectionLabel} mb-2`}>Preview</p>
        <div className="overflow-hidden rounded-card bg-surface shadow-[inset_0_0_0_1px_var(--color-line)] lg:sticky lg:top-6">
          <div className="border-b border-line px-4 py-3 text-sm">
            <span className="text-ink-3">Subject</span> <span className="text-ink">{subject.replace(/\{\{\s*first_name\s*\}\}/g, 'Alex') || '—'}</span>
          </div>
          {/* the email's own HTML, sandboxed: no scripts, no navigation */}
          <iframe title="Email preview" sandbox="" srcDoc={html} className="block h-[640px] w-full bg-white" />
        </div>
      </div>
    </div>
  );
}
