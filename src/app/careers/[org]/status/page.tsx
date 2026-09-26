import Link from 'next/link';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { StatusRequestForm } from '@/components/status-request-form';

export const metadata = { title: 'Application status' };

export default async function StatusRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ sent?: string }>;
}) {
  const { org: orgSlug } = await params;
  const { sent } = await searchParams;

  return (
    <div className="mx-auto max-w-md">
      <Link
        href={`/careers/${orgSlug}`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 transition-colors duration-[120ms] hover:text-ink"
      >
        <ArrowLeft size={14} /> All positions
      </Link>

      <div className="rounded-card bg-surface p-8">
        {sent ? (
          <div className="flex flex-col items-center py-4 text-center">
            <MailCheck size={26} className="text-positive" />
            <h1 className="mt-4 text-xl font-medium">Check your inbox</h1>
            <p className="mt-1 text-sm text-ink-2">
              If we have applications for that email address, a secure status link is on its way.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-medium">Application status</h1>
            <p className="mb-6 mt-1 text-sm text-ink-2">
              Enter the email you applied with and we&apos;ll send you a secure link to view your
              status and manage your preferences.
            </p>
            <StatusRequestForm orgSlug={orgSlug} />
          </>
        )}
      </div>
    </div>
  );
}
