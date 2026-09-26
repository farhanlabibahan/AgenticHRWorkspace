import Link from 'next/link';
import { btnSecondary } from '@/components/form-controls';

export default function NotFound() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3">
      <p className="text-xs font-medium tabular-nums text-ink-2">404</p>
      <h1 className="text-xl font-medium text-ink">Nothing here</h1>
      <p className="text-sm text-ink-2">
        The record may have been merged, archived elsewhere, or the link is stale.
      </p>
      <Link href="/pipeline" className={`${btnSecondary} mt-2`}>
        Back to pipeline
      </Link>
    </div>
  );
}
