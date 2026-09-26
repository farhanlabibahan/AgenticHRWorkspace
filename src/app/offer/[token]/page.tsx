import { notFound } from 'next/navigation';
import { PoweredBySource } from '@/components/powered-by';
import { getOfferByToken, renderOfferLetter } from '@/server/offers';
import { OfferSignForm } from '@/components/offer-sign-form';
import { sectionLabel, surface } from '@/components/form-controls';
import { Badge } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your offer — Source' };

/**
 * Public offer letter + e-signature page, reachable only via the offer's
 * unguessable token. Shows the rendered letter; the candidate signs by
 * typed name or declines. Withdrawn offers 404.
 */
export default async function OfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const offer = await getOfferByToken(token);
  if (!offer || offer.status === 'WITHDRAWN' || offer.status === 'DRAFT') notFound();

  const letter = renderOfferLetter(offer, offer.opportunity.contact.name, offer.org.name);
  const expired =
    offer.status === 'SENT' && offer.expiresAt && offer.expiresAt.getTime() < Date.now();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-6 py-14">
      <p className={sectionLabel}>{offer.org.name}</p>
      <h1 className="mt-2 text-2xl">Offer of employment — {offer.jobTitle}</h1>
      <p className="mt-3">
        <Badge
          onCanvas
          tone={
            offer.status === 'ACCEPTED'
              ? 'positive'
              : offer.status === 'DECLINED'
                ? 'critical'
                : expired
                  ? 'caution'
                  : 'info'
          }
        >
          {offer.status === 'ACCEPTED'
            ? `Signed${offer.signedAt ? ` ${offer.signedAt.toLocaleDateString()}` : ''}`
            : offer.status === 'DECLINED'
              ? 'Declined'
              : expired
                ? 'Expired'
                : 'Awaiting your signature'}
        </Badge>
      </p>

      <div className={`${surface} mt-8 whitespace-pre-wrap p-8 text-md text-ink`}>
        {letter}
        {offer.signedName && offer.signedAt ? (
          <div className="mt-8 border-t border-line pt-4">
            <p className={sectionLabel}>Signed</p>
            <p className="mt-1 text-xl italic">{offer.signedName}</p>
            <p className="mt-0.5 text-xs text-ink-2">
              {offer.signedAt.toLocaleString(undefined, {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-6">
        {offer.status === 'SENT' && !expired ? (
          <OfferSignForm token={token} candidateName={offer.opportunity.contact.name} />
        ) : offer.status === 'SENT' && expired ? (
          <div className={`${surface} p-6`}>
            <p className="text-sm text-ink-2">
              This offer&rsquo;s signature window has passed. Reply to the offer email and the
              team will refresh it.
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-12 flex flex-col items-start gap-2">
        <p className="text-xs text-ink-2">This page is private to the link holder.</p>
        <PoweredBySource />
      </div>
    </main>
  );
}
