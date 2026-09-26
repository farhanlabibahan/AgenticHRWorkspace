/**
 * Page title block (docs/09 §3): 20/28 at 500, sentence-case subtitle in ink-2.
 * `actions` sits top-right, sharing the md control height with everything else.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-8">
      <div className="min-w-0">
        <h1 className="text-xl font-medium text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
