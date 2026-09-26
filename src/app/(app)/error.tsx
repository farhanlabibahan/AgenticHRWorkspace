'use client';

import { btnSecondary } from '@/components/form-controls';

/**
 * Friendly catch-all for the app shell. Server actions in production hide
 * error details behind a digest, so speak human here and offer a retry.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message =
    error.message && error.message.length < 120 && !error.message.includes('digest')
      ? error.message
      : 'Something went sideways on our end. Your data is safe — this was a display or permissions hiccup.';
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-xs font-medium text-ink-2">That didn&apos;t work</p>
      <h1 className="max-w-prose text-xl font-medium text-ink">{message}</h1>
      <p className="max-w-sm text-sm text-ink-2">
        Try again — if it keeps happening, the audit log in Settings will show what did and
        didn&apos;t go through.
      </p>
      <button type="button" onClick={reset} className={`${btnSecondary} mt-2`}>
        Try again
      </button>
    </div>
  );
}
