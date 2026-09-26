import { takeCronLease } from '@/server/cron';
import { completeResumeJson, ResumeParseError, type CompleteDeps, type ResponseMode, type Usage } from './client';
import { resumeParserConfig, type ResumeParserState } from './config';
import { sanitizeResumeText } from './prompt';
import { validateParsedResume, type ResumeProfile } from './validate';

/**
 * Parses a made-up resume through the configured provider, touching no
 * candidate data: the check to run right after adding a key
 * (GET /api/cron/resume-parse?selftest=1, which needs CRON_SECRET). It makes
 * a real, paid call, so one runs at a time (a lease), and the answer doesn't
 * say where the provider is.
 */

export const SELFTEST_RESUME = `Rowan Q. Testperson
Staff Platform Engineer
Lisbon, Portugal
rowan.testperson@example.test · +351 912 345 678 · https://github.com/rowan-testperson

Summary
Platform engineer who builds internal developer tooling and keeps build pipelines fast.

Experience
Staff Platform Engineer, Example Logistics — Jan 2021 to present
Senior Software Engineer, Sample Payments — 2017-03 to 2020-12

Education
BSc Computer Science, University of Examples, 2013 to 2017

Skills: Go, TypeScript, PostgreSQL, Kubernetes, Terraform`;

export type ResumeParseSelfTest = {
  state: 'on' | 'off' | 'misconfigured';
  ok: boolean;
  code?: string;
  /** Another self-test is running. */
  busy?: true;
  provider?: string;
  model?: string;
  mode?: ResponseMode;
  calls?: number;
  usage?: Usage;
  ms?: number;
  /** Fields the model filled, and the profile it returned for the made-up resume. */
  fields?: string[];
  profile?: ResumeProfile;
};

export async function runResumeParseSelfTest(
  opts: { config?: ResumeParserState; deps?: CompleteDeps } = {},
): Promise<ResumeParseSelfTest> {
  const cfg = opts.config ?? resumeParserConfig();
  if (cfg.state !== 'on') return { state: cfg.state, ok: false, code: cfg.state === 'misconfigured' ? cfg.reason : 'off' };
  const base = { state: cfg.state, provider: cfg.providerLabel, model: cfg.model };
  const text = sanitizeResumeText(SELFTEST_RESUME, cfg.maxChars);
  const deadline = Date.now() + Math.min(cfg.timeoutMs * 3, 200_000);
  const release = await takeCronLease('resume-parse:selftest', new Date(deadline + 10_000));
  if (!release) return { ...base, ok: false, code: 'busy', busy: true };
  try {
    const result = await completeResumeJson(cfg, text, { deadline, ...opts.deps });
    const { profile, empty } = validateParsedResume(result.raw, text);
    const fields = Object.entries(profile)
      .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== null))
      .map(([k]) => k);
    return { ...base, ok: !empty, ...(empty ? { code: 'empty' } : {}), mode: result.mode, calls: result.calls, usage: result.usage, ms: result.ms, fields, profile };
  } catch (err) {
    if (err instanceof ResumeParseError) return { ...base, ok: false, code: err.code, calls: err.calls, usage: err.usage };
    return { ...base, ok: false, code: 'error' };
  } finally {
    await release();
  }
}
