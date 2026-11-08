import Link from 'next/link';
import { SourceLockup } from '@/components/powered-by';
import { CandidateAuthForm } from '@/components/candidate-auth-form';

export const metadata = { title: 'Candidate sign in · Orqestra' };

export default async function CandidateSignIn({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      <SourceLockup href="/" className="mb-8" />
      <div className="w-full max-w-sm rounded-dialog bg-surface p-8">
        <h1 className="text-xl font-medium">Candidate sign in</h1>
        <p className="mb-6 mt-1 text-sm text-ink-2">See your applications, interviews and jobs.</p>
        <CandidateAuthForm mode="signin" next={next && next.startsWith('/') ? next : '/candidate'} />
        <p className="mt-6 text-sm text-ink-2">
          New here?{' '}
          <Link href="/candidate/signup" className="font-medium text-ink hover:underline">Create an account</Link>
        </p>
        <p className="mt-2 text-xs text-ink-2">Hiring for a company? <Link href="/login" className="underline">Company sign-in</Link></p>
      </div>
    </div>
  );
}
