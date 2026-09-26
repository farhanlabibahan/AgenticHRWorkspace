import { db } from '@/lib/db';
import { Badge, StatusDot } from '@/components/ui/primitives';
import {
  describeResumeParser,
  orgExcluded,
  resumeParseSummary,
  type ResumeParserDescription,
  type ResumeParseSummary,
} from '@/server/resume-parse';

/**
 * Settings → Integrations → Resume parsing: whether it's on, who reads the
 * resumes, what it did in the last 30 days, and what to fix. Every message
 * is fixed copy chosen by an error code; provider text is never shown.
 */

const DOCS = 'https://github.com/adamperlis/Source/blob/main/docs/resume-parsing.md';

const MISCONFIGURED: Record<NonNullable<ResumeParserDescription['reason']>, (d: ResumeParserDescription) => string> = {
  model_required: () => 'RESUME_PARSER_BASE_URL is set, but no model is. Set RESUME_PARSER_MODEL, for example gpt-oss:20b on Ollama.',
  bad_base_url: () => "RESUME_PARSER_BASE_URL isn't a valid http or https URL.",
  key_required: (d) => `${d.providerLabel ?? d.host ?? 'This provider'} needs an API key. Set RESUME_PARSER_API_KEY.`,
};

function hints(d: ResumeParserDescription, s: ResumeParseSummary): string[] {
  const provider = d.providerLabel ?? 'The provider';
  const out: string[] = [];
  switch (s.pauseCode) {
    case 'provider_auth':
      out.push(`${provider} rejected the API key.`);
      break;
    case 'provider_not_found':
      out.push(`${provider} doesn't recognize the model ${d.model}.`);
      break;
    case 'provider_model_retired':
      out.push(`${provider} has retired the model ${d.model}. Set RESUME_PARSER_MODEL to a current one.`);
      break;
    case 'provider_quota':
      out.push(`${provider} says the account is out of credit or over its quota. Waiting resumes are parsed once that's sorted out.`);
      break;
    case 'provider_rate_limited':
      out.push(`${provider} is limiting requests. Waiting resumes are parsed as the limit resets.`);
      break;
    case 'provider_unavailable':
      out.push(`${provider} isn't answering. Waiting resumes are parsed once it's back.`);
      break;
    case 'provider_timeout':
      out.push(`${provider} isn't answering in time. Waiting resumes are parsed once it's back. For a model on your own server, raise RESUME_PARSER_TIMEOUT_MS.`);
      break;
    case 'provider_bad_request':
      out.push(`${provider} is turning down requests for the model ${d.model}. Waiting resumes are tried again; see the troubleshooting table.`);
      break;
    case 'provider_redirect':
      out.push(`${provider} answered with a redirect instead of a result. Check RESUME_PARSER_BASE_URL.`);
      break;
  }
  switch (s.lastFileError) {
    case 'provider_too_large':
      out.push("Resumes are too long for your plan's per-request limit. Lower RESUME_PARSER_MAX_CHARS.");
      break;
    case 'provider_timeout':
      out.push('The model took too long to answer. For a model on your own server, raise RESUME_PARSER_TIMEOUT_MS.');
      break;
    case null:
      break;
    default:
      out.push("The model's answer for some resumes couldn't be used. Each one is tried up to 3 times.");
  }
  if (d.dailyLimit === 0) out.push('Parsing is paused: RESUME_PARSER_DAILY_LIMIT is 0.');
  else if (s.usedToday >= d.dailyLimit && s.waiting > 0) {
    out.push(`Today's limit of ${d.dailyLimit.toLocaleString()} resumes is reached. The rest are parsed tomorrow (UTC).`);
  }
  return out;
}

function stats(s: ResumeParseSummary): string {
  const parts = [
    [s.last30.OK, 'read'],
    [s.last30.EMPTY, 'with nothing usable'],
    [s.last30.FAILED, 'failed'],
    [s.last30.SKIPPED, 'skipped'],
    [s.waiting, 'waiting'],
  ]
    .filter(([n]) => Number(n) > 0)
    .map(([n, label]) => `${Number(n).toLocaleString()} ${label}`);
  return parts.length ? `Last 30 days: ${parts.join(' · ')}` : 'No resumes read yet.';
}

function Status({ tone, label }: { tone: 'positive' | 'neutral' | 'caution'; label: string }) {
  return <Badge tone={tone}>{label}</Badge>;
}

export async function ResumeParsingStatus({ orgId }: { orgId: string }) {
  const d = describeResumeParser();

  if (d.state === 'off') {
    return (
      <div className="flex flex-col items-start gap-3">
        <Status tone="neutral" label="Off" />
        <p className="max-w-prose text-sm text-ink-2">
          Fill in candidate profiles from new applicants&apos; resumes. It turns on when this server has a model key:
          OpenAI&apos;s gpt-oss-20b on Groq by default, or any OpenAI-compatible endpoint, including a model on your own
          server.
        </p>
        <a href={DOCS} target="_blank" rel="noreferrer" className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
          Set up resume parsing
        </a>
      </div>
    );
  }

  if (d.state === 'misconfigured') {
    return (
      <div className="flex flex-col items-start gap-3">
        <Status tone="caution" label="Not running" />
        <p className="max-w-prose text-sm text-ink">{d.reason ? MISCONFIGURED[d.reason](d) : null}</p>
        <a href={DOCS} target="_blank" rel="noreferrer" className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
          How to set up resume parsing
        </a>
      </div>
    );
  }

  const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (org && orgExcluded(org)) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Status tone="neutral" label="Off for this workspace" />
        <p className="max-w-prose text-sm text-ink-2">
          Resume parsing is turned off for this workspace. New applicants&apos; resumes aren&apos;t sent anywhere.
        </p>
      </div>
    );
  }

  const summary = await resumeParseSummary(orgId);
  const title = d.thirdParty ? `${d.providerLabel} · ${d.model}` : `Your own server (${d.host}) · ${d.model}`;
  const destination = d.thirdParty
    ? `To do this, the text of each resume is sent to ${d.providerLabel}.`
    : `Resume text is sent to ${d.host} on your own network; nothing goes to a third party unless that server forwards it.`;
  const problems = hints(d, summary);

  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Status tone={problems.length ? 'caution' : 'positive'} label="On" />
        <p className="text-sm font-medium text-ink">{title}</p>
      </div>
      <p className="max-w-prose text-sm text-ink-2">
        Each new applicant&apos;s resume fills in an empty headline and location, and phone numbers and profile links when
        the application had none. Nothing anyone typed is changed, and imported resumes aren&apos;t read. {destination}
      </p>
      <p className="text-xs tabular-nums text-ink-2">{stats(summary)}</p>
      {problems.length ? (
        <ul className="flex flex-col gap-1.5">
          {problems.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm text-ink">
              <StatusDot tone="caution" className="mt-[7px]" />
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <a href={DOCS} target="_blank" rel="noreferrer" className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
        How resume parsing works
      </a>
    </div>
  );
}
