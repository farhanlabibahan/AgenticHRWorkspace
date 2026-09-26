import { SourceLockup } from '@/components/powered-by';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      {/* The logo, back to the homepage */}
      <SourceLockup href="/" className="mb-8" />
      <div className="w-full max-w-sm rounded-dialog bg-surface p-8">{children}</div>
    </div>
  );
}
