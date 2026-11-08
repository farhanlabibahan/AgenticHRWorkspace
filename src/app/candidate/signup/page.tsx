import Link from 'next/link';
import { SourceLockup } from '@/components/powered-by';
import { CandidateAuthForm } from '@/components/candidate-auth-form';

export const metadata = { title: 'Create your candidate account · Orqestra' };

export default async function CandidateSignUp({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      <SourceLockup href="/" className="mb-8" />
      <div className="w-full max-w-sm rounded-dialog bg-surface p-8">
        <h1 className="text-xl font-medium">Create your account</h1>
        <p className="mb-6 mt-1 text-sm text-ink-2">
          One account for every company you apply to. Your applications and jobs all show up here.
        </p>
        <CandidateAuthForm mode="signup" next={next && next.startsWith('/') ? next : '/candidate'} />
        <p className="mt-6 text-sm text-ink-2">
          Already have one?{' '}
          <Link href="/candidate/signin" className="font-medium text-ink hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
