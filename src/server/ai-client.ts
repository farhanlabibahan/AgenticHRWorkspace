import { qaFromDialogue } from '@/lib/interview-insights';

/**
 * Orqestra's AI provider protocol: the client side. The open-source core has
 * no prompts and calls no model. Its AI features (candidate evaluations,
 * role criteria, Ask AI and interview insights) send
 * the material to a provider service as JSON and store what comes back.
 * Orqestra runs one; anyone can run their own against the same protocol
 * (docs/ai-protocol.md).
 *
 *   AI_SERVICE_URL    the provider, e.g. https://ai.example.com (turns AI on)
 *   AI_SERVICE_TOKEN  sent as `Authorization: Bearer …`
 *   AI_PROVIDER=mock  a deterministic offline provider, for dev and tests
 *
 * Configured on the server and never mentioned in the app: people see the
 * features when AI is on and nothing when it's off. The token is a
 * non-enumerable property, so logging the provider never shows it, and it
 * goes nowhere but the Authorization header of a request to AI_SERVICE_URL.
 * Provider errors are logged as a status and a code; users see fixed copy.
 */

type Env = Record<string, string | undefined>;

export type AiProvider =
  | { kind: 'mock' }
  | { kind: 'service'; url: string; readonly token: string };

export function aiProvider(env: Env = process.env): AiProvider | null {
  const read = (name: string) => env[name]?.trim() || undefined;
  if (read('AI_PROVIDER') === 'mock') return { kind: 'mock' };
  const raw = read('AI_SERVICE_URL');
  const token = read('AI_SERVICE_TOKEN');
  if (!raw || !token) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const provider = { kind: 'service' as const, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
  return Object.defineProperty(provider, 'token', { value: token, enumerable: false }) as AiProvider;
}

export function aiConfigured(env: Env = process.env): boolean {
  return aiProvider(env) !== null;
}

/** Thrown whenever the provider can't answer; the message is what the user reads. */
export class AiUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | null = null,
  ) {
    super("AI couldn't answer just now. Try again in a moment.");
    this.name = 'AiUnavailableError';
  }
}

/** One log line for a failed call: the reason and status, never the material, the answer or the token. */
export function logAiFailure(feature: string, error: unknown) {
  if (error instanceof AiUnavailableError) console.error(`[ai] ${feature} failed: ${error.reason}${error.status ? ` (${error.status})` : ''}`);
  else console.error(`[ai] ${feature} failed`, error);
}

// ---------- The protocol (docs/ai-protocol.md) ----------

export type AiRole = { title: string; location: string | null; content: unknown };

export type EvaluationResult = {
  recommendation: number; // 1-4, same scale as scorecards
  summary: string;
  strengths: string[];
  concerns: string[];
  questions: string[]; // suggested interview questions
  /** One per role criterion, by id; empty when the role has none. */
  criteria: { id: string; score: number; evidence: string }[];
  /** Up to three career signals; kinds in src/lib/highlights.ts. */
  highlights: { kind: string; text: string }[];
};

/** Every task: what the core sends, and what the provider answers. Answers always carry the model that wrote them. */
export type AiTasks = {
  /** The handful of things to screen every candidate for, drafted from the posting. */
  'draft-criteria': {
    input: { role: AiRole };
    output: { model: string; criteria: { label: string; must: boolean }[] };
  };
  /** An advisory read of one candidate for one role, never a decision. */
  evaluate: {
    input: {
      role: AiRole | null;
      criteria: { id: string; label: string; must: boolean }[];
      candidate: {
        name: string;
        headline: string | null;
        location: string | null;
        links: string[];
        stage: string;
        applicationNote: string | null;
        resumeText: string | null;
        scorecards: { rating: number; summary: string }[];
        transcripts: { title: string; content: string }[];
      };
    };
    output: { model: string; evaluation: EvaluationResult };
  };
  /** An answer to a question, from the excerpts the core found, citing them by number. */
  answer: {
    input: {
      question: string;
      excerpts: { n: number; contactName: string; kind: 'transcript' | 'resume' | 'note'; title: string; text: string }[];
    };
    output: { model: string; answer: string };
  };
  /** The questions asked in one interview with the candidate's answers, and facts they stated. */
  'interview-insights': {
    input: { transcript: string };
    output: { model: string; qa: unknown; facts: unknown };
  };
};

export type AiTask = keyof AiTasks;

/** How long the core waits for each task: the provider may retry the model once or twice. */
const TIMEOUT_MS: Record<AiTask, number> = {
  'draft-criteria': 60_000,
  evaluate: 150_000,
  answer: 90_000,
  'interview-insights': 180_000,
};

/** Run one task on the configured provider. Throws AiUnavailableError, never the provider's own words. */
export async function runAiTask<T extends AiTask>(task: T, input: AiTasks[T]['input']): Promise<AiTasks[T]['output']> {
  const provider = aiProvider();
  if (!provider) throw new AiUnavailableError('not_configured');
  if (provider.kind === 'mock') return mockTask(task, input);

  let res: Response;
  try {
    res = await fetch(`${provider.url}/v1/${task}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${provider.token}` },
      body: JSON.stringify(input),
      // Never follow a redirect: the token goes only to the configured host.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS[task]),
    });
  } catch (error) {
    throw new AiUnavailableError(error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  if (res.status !== 200 || !body || typeof body !== 'object') {
    const code = body?.error?.code;
    throw new AiUnavailableError(typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : `http_${res.status}`, res.status);
  }
  return body as AiTasks[T]['output'];
}

// ---------- The mock provider ----------

/**
 * Deterministic answers without a model, so tests get stable output and
 * development works offline. Evaluations grade on how much signal the
 * profile has, and criteria score by the words the resume shares with them.
 */
function mockTask<T extends AiTask>(task: T, raw: AiTasks[T]['input']): AiTasks[T]['output'] {
  const model = 'mock';
  switch (task) {
    case 'draft-criteria': {
      const { role } = raw as AiTasks['draft-criteria']['input'];
      return {
        model,
        criteria: [
          { label: `Relevant ${role.title} experience`, must: true },
          { label: 'Clear written communication', must: false },
        ],
      } as AiTasks[T]['output'];
    }
    case 'evaluate': {
      const { role, criteria, candidate } = raw as AiTasks['evaluate']['input'];
      const resume = (candidate.resumeText ?? '').toLowerCase();
      const scored = criteria.map((c) => {
        const words = c.label.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const hits = words.filter((w) => resume.includes(w));
        return {
          id: c.id,
          score: words.length ? Math.round((hits.length / words.length) * 4) * 25 : 0,
          evidence: hits.length ? `The resume mentions ${hits.join(', ')}.` : '',
        };
      });
      const strengths: string[] = [];
      const concerns: string[] = [];
      if (candidate.resumeText) strengths.push('Resume on file with extracted text to search against.');
      else concerns.push('No resume on file — evaluation is based on profile fields only.');
      const ratings = candidate.scorecards.map((s) => s.rating);
      if (ratings.length) {
        const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        (avg >= 3 ? strengths : concerns).push(`Interview feedback averages ${avg.toFixed(1)} of 4 across ${ratings.length} scorecard(s).`);
      } else {
        concerns.push('No interview feedback submitted yet.');
      }
      return {
        model,
        evaluation: {
          recommendation: strengths.length >= concerns.length ? 3 : 2,
          summary: `Mock evaluation of ${candidate.name}${role ? ` for ${role.title}` : ''}: ${strengths.length} strength(s) and ${concerns.length} concern(s) found in the profile.`,
          strengths,
          concerns,
          questions: ['Walk me through your most relevant recent project.'],
          criteria: scored,
          highlights: [],
        },
      } as AiTasks[T]['output'];
    }
    case 'answer': {
      const { excerpts } = raw as AiTasks['answer']['input'];
      const names = [...new Set(excerpts.map((e) => e.contactName))];
      return {
        model,
        answer: `Mock corpus answer: found ${excerpts.length} relevant excerpt(s) across ${names.length} candidate(s) — ${names.join(', ')}.`,
      } as AiTasks[T]['output'];
    }
    case 'interview-insights': {
      const { transcript } = raw as AiTasks['interview-insights']['input'];
      return { model, qa: qaFromDialogue(transcript), facts: {} } as AiTasks[T]['output'];
    }
  }
  throw new AiUnavailableError('unknown_task');
}
