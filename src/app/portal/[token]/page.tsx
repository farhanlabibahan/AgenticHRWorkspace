import { getPortalData } from '@/server/portal';
import { PoweredBySource } from '@/components/powered-by';
import { NetworkConsentToggle } from '@/components/network-consent-toggle';
import { sectionLabel } from '@/components/form-controls';
import { Avatar } from '@/components/ui/orb';
import { Badge, type Tone } from '@/components/ui/primitives';

export const metadata = { title: 'Your applications' };

const STATUS_TONES: Record<string, Tone> = {
  Hired: 'positive',
  'Not selected': 'critical',
  Closed: 'neutral',
  Interviewing: 'info',
  'Offer stage': 'caution',
  'In review': 'info',
};

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await getPortalData(token);

  if (!data) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-medium">This link has expired</h1>
        <p className="mt-2 text-sm text-ink-2">
          Status links are valid for 14 days. Request a fresh one from the careers page you applied
          on.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-8 flex items-center gap-3">
        <Avatar name={data.org.name} size={36} />
        <div>
          <p className="text-md font-medium text-ink">{data.org.name}</p>
          <p className="text-xs text-ink-2">Application status for {data.contact.name}</p>
        </div>
      </div>

      <section>
        <h2 className={`mb-3 ${sectionLabel}`}>Your applications</h2>
        {data.applications.length > 0 ? (
          <div className="divide-y divide-line overflow-hidden rounded-card bg-surface">
            {data.applications.map((app) => (
              <div key={app.id} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{app.postingTitle}</p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {app.company} · applied{' '}
                    {app.appliedAt.toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <Badge tone={STATUS_TONES[app.status] ?? 'neutral'}>{app.status}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-2">No applications found.</p>
        )}
      </section>

      {data.networkEnabled || data.networkOptIn ? (
        <section className="mt-8">
          <h2 className={`mb-3 ${sectionLabel}`}>Your preferences</h2>
          <NetworkConsentToggle token={token} optedIn={data.networkOptIn} />
        </section>
      ) : null}

      <PoweredBySource className="mt-12" />
    </div>
  );
}
