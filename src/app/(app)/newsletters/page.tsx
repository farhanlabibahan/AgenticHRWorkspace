import Link from 'next/link';
import { Newspaper, Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { btnPrimary, surface } from '@/components/form-controls';
import { Badge, StatusDot } from '@/components/ui/primitives';
import { LocalTime } from '@/components/local-time';
import { countAudience } from '@/server/newsletters';

export const metadata = { title: 'Newsletters — Orqestra' };

const SUBTITLE = 'One email about your open roles, to every candidate';

export default async function NewslettersPage() {
  const ctx = await requireSession();
  const [newsletters, audience] = await Promise.all([
    db.newsletter.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, subject: true, status: true, recipientCount: true, sentCount: true, failedCount: true, sentAt: true, updatedAt: true },
    }),
    countAudience(ctx.orgId),
  ]);

  return (
    <div className="t-reveal">
      <PageHeader
        title="Newsletters"
        subtitle={SUBTITLE}
        actions={
          <Link href="/newsletters/new" className={btnPrimary}>
            <Plus /> New newsletter
          </Link>
        }
      />
      <div className="mx-6 mt-4 flex max-w-3xl flex-col gap-4 pb-8">
        <p className="text-sm text-ink-2">
          {audience.toLocaleString()} {audience === 1 ? 'candidate' : 'candidates'} can get your next one. People who unsubscribed, whose address bounced or
          who were anonymized are left out.
        </p>
        {newsletters.length ? (
          <div className={`${surface} divide-y divide-line`}>
            {newsletters.map((n) => (
              <Link
                key={n.id}
                href={`/newsletters/${n.id}`}
                className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-[120ms] hover:bg-muted"
              >
                <span className="min-w-0 truncate text-ink">{n.subject}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-ink-2">
                  {n.status === 'DRAFT' ? (
                    <Badge>Draft</Badge>
                  ) : n.status === 'SENDING' ? (
                    <>
                      <StatusDot tone="caution" /> Sending · {n.sentCount.toLocaleString()} of {n.recipientCount.toLocaleString()}
                    </>
                  ) : (
                    <>
                      <StatusDot tone="positive" /> Sent to {n.sentCount.toLocaleString()}
                      {n.sentAt ? (
                        <>
                          {' · '}
                          <LocalTime date={n.sentAt.toISOString()} options={{ month: 'short', day: 'numeric' }} />
                        </>
                      ) : null}
                    </>
                  )}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Newspaper}
            title="No newsletters yet"
            description="Tell your candidates about new roles: write a short note, pick the roles to feature, and send it to everyone at once."
          />
        )}
      </div>
    </div>
  );
}
