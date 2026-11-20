'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { DOC_KEYS, type DocsContent, type DocsMember } from '@/lib/docs-site';
import { saveDocsAction } from './actions';

const labels: Record<keyof DocsContent, string> = {
  headline: 'Headline', elevatorPitch: 'Elevator pitch', summary: 'Public summary',
  problem: 'Problem', solution: 'Solution', market: 'Market', businessModel: 'Business model',
  traction: 'Traction and proof', roadmap: 'Roadmap', ask: 'The ask',
  architecture: 'Architecture', dataFlow: 'Data flow', stack: 'Technology stack',
};

function toLocal(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function resizeImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.78);
}

export function DocsEditor({ initial }: {
  initial: { enabled: boolean; startsAt: string | null; endsAt: string | null; content: DocsContent; team: DocsMember[] };
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [startsAt, setStartsAt] = useState(toLocal(initial.startsAt));
  const [endsAt, setEndsAt] = useState(toLocal(initial.endsAt));
  const [content, setContent] = useState(initial.content);
  const [team, setTeam] = useState(initial.team);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const publicUrl = '/docs';

  function save() {
    setMessage('');
    startTransition(async () => {
      try {
        await saveDocsAction({ enabled, startsAt: startsAt ? new Date(startsAt).toISOString() : '',
          endsAt: endsAt ? new Date(endsAt).toISOString() : '', content, team });
        setMessage('Saved. The public page now uses these settings and content.');
      } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save.'); }
    });
  }

  return <div className="mx-auto max-w-5xl space-y-8 px-5 py-10 text-ink sm:px-8">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm text-ink-2">Settings / Public documentation</p><h1 className="mt-2 text-3xl font-semibold">Docs publishing</h1><p className="mt-2 text-ink-2">Edit the pitch, technical guide, team, and public availability.</p></div>
      <Link className="rounded-xl border border-line px-4 py-2 text-sm" href={publicUrl} target="_blank">Open public page ↗</Link>
    </div>
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Access and schedule</h2>
      <label className="mt-4 flex items-center gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Public visibility ON</label>
      <p className="mt-2 text-sm text-ink-2">When OFF, visitors see “Not Available”. The optional time window also applies to public visitors.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Available from <input className="mt-1 block w-full rounded-lg border border-line p-2" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label>
        <label className="text-sm">Available until <input className="mt-1 block w-full rounded-lg border border-line p-2" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label>
      </div>
      <p className="mt-3 text-xs text-ink-2">Times use your browser’s local timezone. Leave either field empty for an open-ended window.</p>
    </section>
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm"><h2 className="text-lg font-semibold">Pitch deck and technical content</h2><p className="mt-1 text-sm text-ink-2">Every section below is editable. Live activity numbers are queried from the application when visitors open the page.</p>
      <div className="mt-5 grid gap-5">{DOC_KEYS.map((key) => <label key={key} className="text-sm font-medium">{labels[key]}<textarea className="mt-1 block min-h-24 w-full rounded-lg border border-line p-3 font-normal" value={content[key]} onChange={(e) => setContent({ ...content, [key]: e.target.value })} /></label>)}</div>
    </section>
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Team showcase</h2><button type="button" className="rounded-lg border border-line px-3 py-2 text-sm" onClick={() => setTeam([...team, { id: crypto.randomUUID(), name: '', role: '', email: '', image: '' }])}>Add member</button></div>
      <div className="mt-5 space-y-4">{team.map((member, index) => <div key={member.id} className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-[100px_1fr_1fr]">
        <div className="row-span-2"><div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-gray-100 text-xs text-ink-2">{member.image ? <img className="h-full w-full object-cover" src={member.image} alt="" /> : 'Photo'}</div><label className="mt-2 block cursor-pointer text-xs underline">Upload<input className="sr-only" type="file" accept="image/*" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { const image = await resizeImage(file); setTeam((current) => current.map((m, i) => i === index ? { ...m, image } : m)); } catch { setMessage('Could not process image.'); } }} /></label></div>
        {(['name', 'role', 'email'] as const).map((field) => <label key={field} className="text-xs capitalize">{field}<input className="mt-1 block w-full rounded-lg border border-line p-2 text-sm" type={field === 'email' ? 'email' : 'text'} value={member[field]} onChange={(e) => setTeam((current) => current.map((m, i) => i === index ? { ...m, [field]: e.target.value } : m))} /></label>)}
        <button type="button" className="self-end text-left text-xs text-red-700 underline" onClick={() => setTeam(team.filter((_, i) => i !== index))}>Remove member</button>
      </div>)}</div>
    </section>
    <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-line bg-white p-4 shadow-lg"><span className="text-sm text-ink-2" role="status">{message}</span><button type="button" disabled={pending} onClick={save} className="rounded-lg bg-emerald-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Save documentation'}</button></div>
  </div>;
}
