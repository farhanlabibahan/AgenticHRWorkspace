import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { isAdmin, requireSession } from '@/lib/session';
import { requestBaseUrl } from '@/lib/base-url';
import { PageHeader } from '@/components/page-header';
import { surface } from '@/components/form-controls';
import { DitherBar } from '@/components/ui/dither';
import { LocalTime } from '@/components/local-time';
import { NewsletterEditor } from '@/components/newsletter-editor';
import { RefreshWhileSending } from '@/components/newsletter-progress';
import { canSendNewsletters, countAudience, previewNewsletter } from '@/server/newsletters';

export const metadata = { title: 'Newsletter — Source' };

export default async function NewsletterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireSession();
  const newsletter =
    id === 'new' ? null : /^[0-9a-f-]{36}$/i.test(id) ? await db.newsletter.findFirst({ where: { id, orgId: ctx.orgId } }) : null;
  if (id !== 'new' && !newsletter) notFound();

  // Sent, or going out: what happened
  if (newsletter && newsletter.status !== 'DRAFT') {
    const counts = await db.newsletterRecipient.groupBy({ by: ['status'], where: { newsletterId: newsletter.id }, _count: true });
    const of = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
    const done = of('SENT') + of('FAILED') + of('SKIPPED');
    const sending = newsletter.status === 'SENDING';
    const html = await previewNewsletter(ctx, newsletter, await requestBaseUrl());
    return (
      <div className="t-reveal">
        <RefreshWhileSending sending={sending} />
        <PageHeader title={newsletter.subject} subtitle={sending ? 'Going out now' : 'Sent'} />
        <div className="mx-6 mt-4 flex max-w-3xl flex-col gap-6 pb-8">
          <div className={`${surface} p-5`}>
            <DitherBar value={done} max={Math.max(1, newsletter.recipientCount)} label={`${done} of ${newsletter.recipientCount} sent`} />
            <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              {[
                ['Candidates', newsletter.recipientCount],
                ['Delivered to', of('SENT')],
                ['Didn’t go', of('FAILED')],
                ['Unsubscribed since', of('SKIPPED')],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-xs text-ink-2">{label}</dt>
                  <dd className="mt-1 text-lg tabular-nums text-ink">{(value as number).toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-ink-2">
              {sending ? (
                'Sending in batches; this page updates as it goes.'
              ) : newsletter.sentAt ? (
                <>
                  Finished <LocalTime date={newsletter.sentAt.toISOString()} options={{ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }} />.
                </>
              ) : null}
            </p>
          </div>
          <div className="overflow-hidden rounded-card bg-surface shadow-[inset_0_0_0_1px_var(--color-line)]">
            <iframe title="The email" sandbox="" srcDoc={html} className="block h-[640px] w-full bg-white" />
          </div>
        </div>
      </div>
    );
  }

  const [postings, audience] = await Promise.all([
    db.posting.findMany({
      where: { orgId: ctx.orgId, state: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { id: true, title: true, location: true },
    }),
    countAudience(ctx.orgId),
  ]);

  return (
    <div className="t-reveal">
      <PageHeader title={newsletter ? 'Edit newsletter' : 'New newsletter'} subtitle="One email about your open roles, to every candidate" />
      <div className="mx-6 mt-4 pb-8">
        <NewsletterEditor
          initial={{ id: newsletter?.id ?? null, subject: newsletter?.subject ?? '', body: newsletter?.body ?? '', postingIds: newsletter?.postingIds ?? [] }}
          postings={postings}
          audience={audience}
          canSend={canSendNewsletters()}
          isAdmin={isAdmin(ctx)}
        />
      </div>
    </div>
  );
}
