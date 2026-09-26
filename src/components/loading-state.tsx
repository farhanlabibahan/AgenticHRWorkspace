/** Shared route-loading indicator with a message that says what's coming. */
export function LoadingState({ message }: { message: string }) {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-ink-2">
        <span className="size-1.5 animate-pulse rounded-full bg-ink-3" />
        {message}
      </div>
    </div>
  );
}
