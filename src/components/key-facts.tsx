import { surface } from '@/components/form-controls';
import { LocalTime } from '@/components/local-time';
import { SectionHeader } from '@/components/ui/primitives';
import type { KeyFact } from '@/lib/interview-insights';

/**
 * What the candidate said about themselves in interviews: why they're
 * looking, where they're based, relocation, work authorization and
 * availability. Each from the latest transcript that mentions it.
 */
export function KeyFactsSection({ facts }: { facts: KeyFact[] }) {
  if (!facts.length) return null;
  // One interview said it all: name it once, under the card.
  const single = facts.every((f) => f.source === facts[0].source && f.date === facts[0].date);
  const source = (f: KeyFact) => (
    <>
      {f.source} · <LocalTime date={f.date} options={{ month: 'short', day: 'numeric' }} />
    </>
  );
  return (
    <section>
      <SectionHeader title="Key facts" />
      <dl className={`${surface} divide-y divide-line`}>
        {facts.map((f) => (
          <div key={f.key} className="px-4 py-3">
            <dt className="text-xs text-ink-2">{f.label}</dt>
            <dd className="mt-0.5 text-sm text-ink">{f.value}</dd>
            {single ? null : <dd className="mt-1 text-xs text-ink-3">{source(f)}</dd>}
          </div>
        ))}
      </dl>
      <p className="mt-2 px-1 text-xs text-ink-3">
        {single ? <>As the candidate said it in {source(facts[0])}</> : 'As the candidate said it in interviews.'}
      </p>
    </section>
  );
}
