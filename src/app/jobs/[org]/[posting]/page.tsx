import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, MapPin } from 'lucide-react';
import { db } from '@/lib/db';
import { SourceLockup } from '@/components/powered-by';
import { currentCandidate } from '@/server/candidate-accounts';
import { ApplyWithAccount } from '@/components/apply-with-account';
import { surface } from '@/components/form-controls';
import { Badge } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function JobDetail({ params }: { params: Promise<{ org: string; posting: string }> }) {
  const { org: orgSlug, posting: postingSlug } = await params;
  const posting = await db.posting.findFirst({
    where: { state: 'PUBLISHED', slug: postingSlug, org: { slug: orgSlug } },
    include: { org: { select: { name: true } } },
  });
  if (!posting) notFound();
  const me = await currentCandidate();
  const alreadyApplied = me
    ? await db.opportunity.findFirst({
        where: { postingId: posting.id, contact: { candidateAccountId: me.id } },
        select: { id: true },
      })
    : null;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <SourceLockup href="/" />
        <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
          <ArrowLeft size={14} /> All jobs
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-24">
        <section className="pb-6 pt-4">
          <p className="text-sm text-ink-2">{posting.org.name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em]">{posting.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {posting.location ? (
              <span className="inline-flex items-center gap-1 text-sm text-ink-2"><MapPin size={14} />{posting.location}</span>
            ) : null}
            <Badge>{posting.workplaceType.replace('_', '-').toLowerCase()}</Badge>
            <Badge>{posting.commitment.replace('_', '-').toLowerCase()}</Badge>
          </div>
        </section>

        <section className={`${surface} mb-6 p-6`}>
          <h2 className="text-md font-medium">About the role</h2>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-2">{descriptionText(posting.content)}</p>
        </section>

        <section className={`${surface} p-6`}>
          {alreadyApplied ? (
            <p className="text-sm text-ink-2">
              You have applied to this role. Track it in <Link href="/candidate" className="font-medium text-ink underline">My jobs</Link>.
            </p>
          ) : (
            <ApplyWithAccount orgSlug={orgSlug} postingSlug={postingSlug} signedIn={!!me} name={me?.name} email={me?.email} />
          )}
        </section>
      </main>
    </div>
  );
}

/** Plain text from the posting's rich-text blocks, for the public page. */
function descriptionText(content: unknown): string {
  // Plain description from the posting form, stored as { description }.
  if (content && typeof content === 'object' && typeof (content as { description?: unknown }).description === 'string') {
    const d = ((content as { description: string }).description).trim();
    if (d) return d;
  }
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(content);
  return out.join('\n').trim() || 'See the company’s posting for details.';
}
