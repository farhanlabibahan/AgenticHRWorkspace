import type { ResumeParserConfig } from './config';
import { buildMessages, halveText, RESUME_SCHEMA } from './prompt';

/**
 * One resume in, the model's JSON out, over POST {base}/chat/completions on
 * any OpenAI-compatible endpoint (Groq, DeepInfra, OpenRouter, Ollama, vLLM).
 * Plain fetch, no SDK. Never streams: Groq's structured outputs can't.
 *
 * At most three HTTP calls per resume. What earns another call:
 *   - 429, 498, 5xx or a network error: once, after retry-after (or the wait
 *     the message names, or about a second), unless that is over 10 s.
 *   - 413, or a 400 about the context length: once, with half the text.
 *   - json_validate_failed or finish_reason "length": the partial answer if
 *     it is valid, else once with a larger output budget.
 *   - a 400 that names reasoning_effort, or response_format / json_schema:
 *     the next call leaves that out (json_schema, then json_object, then
 *     nothing), and the process remembers it for this endpoint and model.
 * Everything else fails at once with a code. A timeout is not retried here;
 * the file's own attempts (run.ts) cover it later.
 *
 * Errors carry a code, the HTTP status, a wait and a request id: never the
 * provider's message, the resume, or the key. Only message.content is read;
 * reasoning is ignored and never kept.
 */

export const BASE_MAX_TOKENS = 3_000;
export const GROWN_MAX_TOKENS = 4_500;
const MAX_CALLS = 3;
const MAX_WAIT_MS = 10_000;

export type ResumeParseErrorCode =
  | 'provider_auth'
  | 'provider_not_found'
  /** The provider retired the model (Groq: model_decommissioned). */
  | 'provider_model_retired'
  /** Out of credit or over a spending quota (402, insufficient_quota). */
  | 'provider_quota'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_redirect'
  | 'provider_too_large'
  | 'provider_bad_request'
  | 'provider_timeout'
  | 'provider_bad_json'
  | 'provider_truncated'
  | 'provider_empty'
  /** The caller's deadline ran out: not the provider's fault. */
  | 'deadline';

export class ResumeParseError extends Error {
  readonly code: ResumeParseErrorCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  readonly usage: Usage;
  readonly calls: number;

  constructor(
    code: ResumeParseErrorCode,
    info: { status?: number | null; retryAfterMs?: number | null; requestId?: string | null; usage?: Usage; calls?: number } = {},
  ) {
    super(code);
    this.name = 'ResumeParseError';
    this.code = code;
    this.status = info.status ?? null;
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.requestId = info.requestId ?? null;
    this.usage = info.usage ?? emptyUsage();
    this.calls = info.calls ?? 0;
  }
}

export type Usage = { promptTokens: number; completionTokens: number; reasoningTokens: number; cachedTokens: number };
export type ResponseMode = 'json_schema' | 'json_object' | 'none';

export type CompleteResult = {
  raw: unknown;
  usage: Usage;
  requestId: string | null;
  /** HTTP calls made. */
  calls: number;
  ms: number;
  mode: ResponseMode;
  /** The answer came from a json_validate_failed error's partial output. */
  salvaged: boolean;
};

export type CompleteDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms after which nothing new starts and a call in flight is cut off ("deadline"). */
  deadline?: number;
};

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 });

type Caps = { mode: ResponseMode; reasoningEffort: boolean };
/** What an endpoint turned out not to accept, per base URL and model, for the life of the process. */
const capsCache = new Map<string, Caps>();

export function resetResumeParseCaps() {
  capsCache.clear();
}

const isGptOss = (model: string) => /gpt-oss/i.test(model);

/** error.code values meaning the account can't pay (OpenAI-style APIs, OpenRouter, DeepInfra). */
const QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'insufficient_balance', 'payment_required']);
// Not "billing": Groq's ordinary rate-limit messages link to its billing page.
const QUOTA_MESSAGE = /insufficient (?:credits?|balance|quota|funds)|out of credits?|payment required|exceeded your current quota/;
/** error.code values meaning the configured model no longer exists there. */
const RETIRED_CODES = new Set(['model_decommissioned', 'model_deprecated']);
/** A 400 that says the prompt doesn't fit the model's context window. */
const CONTEXT_MESSAGE = /context[_ ]length|context window|maximum context|reduce the length of the messages/;

function responseFormat(mode: ResponseMode) {
  if (mode === 'json_schema') {
    return { response_format: { type: 'json_schema', json_schema: { name: 'resume', strict: true, schema: RESUME_SCHEMA } } };
  }
  if (mode === 'json_object') return { response_format: { type: 'json_object' } };
  return {};
}

/** The request body. Each profile gets only the fields its host accepts: Groq rejects unknown ones. */
export function requestBody(cfg: Pick<ResumeParserConfig, 'model' | 'profile'>, text: string, opts: { maxTokens: number; caps: Caps }) {
  const { messages } = buildMessages(text, { jsonOnly: opts.caps.mode !== 'json_schema' });
  const gptOss = isGptOss(cfg.model);
  return {
    model: cfg.model,
    messages,
    ...responseFormat(opts.caps.mode),
    max_tokens: opts.maxTokens,
    stream: false,
    // gpt-oss is tuned for its default sampling; greedy decoding can loop in
    // its reasoning until the budget runs out. Other models: deterministic.
    ...(gptOss ? {} : { temperature: 0 }),
    ...(gptOss && opts.caps.reasoningEffort ? { reasoning_effort: 'low' } : {}),
    ...(cfg.profile === 'groq' ? { include_reasoning: false } : {}),
    ...(cfg.profile === 'openrouter' ? { provider: { require_parameters: true, data_collection: 'deny' } } : {}),
  };
}

/** The one place the key is used. */
function headers(cfg: ResumeParserConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

/** retry-after in seconds or as an HTTP date. */
function retryAfterHeader(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** "Please try again in 7.5s" / "in 2m59.56s" / "in 450ms". */
export function waitFromMessage(message: string): number | null {
  const m = message.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i);
  if (!m) return null;
  let ms = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
    const v = Number(n);
    ms += unit.toLowerCase() === 'ms' ? v : unit.toLowerCase() === 's' ? v * 1000 : unit.toLowerCase() === 'm' ? v * 60_000 : v * 3_600_000;
  }
  return Math.round(ms);
}

type ProviderError = { message: string; code: string; param: string; type: string; failedGeneration: string | null };

/** The fields of an OpenAI-style error body we branch on; never logged or stored. */
function providerError(body: unknown): ProviderError {
  const err = (body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : body) as Record<string, unknown> | string | null;
  if (typeof err === 'string') return { message: err, code: '', param: '', type: '', failedGeneration: null };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    message: str(err?.message),
    code: str(err?.code),
    param: str(err?.param),
    type: str(err?.type),
    failedGeneration: typeof err?.failed_generation === 'string' ? err.failed_generation : null,
  };
}

/** A JSON object from model output, tolerating a code fence or text around it (json_object / no-format modes). */
export function parseJsonObject(content: string, { lenient }: { lenient: boolean }): { ok: true; value: unknown } | { ok: false } {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    if (!lenient) return { ok: false };
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
  } catch {
    return { ok: false };
  }
}

const isPlainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

function addUsage(total: Usage, body: unknown) {
  const u = (body as { usage?: Record<string, unknown>; x_groq?: { usage?: Record<string, unknown> } } | null)?.usage ??
    (body as { x_groq?: { usage?: Record<string, unknown> } } | null)?.x_groq?.usage;
  if (!u || typeof u !== 'object') return;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  total.promptTokens += n(u.prompt_tokens);
  total.completionTokens += n(u.completion_tokens);
  total.reasoningTokens += n((u.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  total.cachedTokens += n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
}

function requestIdOf(body: unknown, res: Response): string | null {
  const b = body as { x_groq?: { id?: unknown }; id?: unknown } | null;
  const id = (typeof b?.x_groq?.id === 'string' && b.x_groq.id) || res.headers.get('x-request-id') || (typeof b?.id === 'string' && b.id) || null;
  // An id, not free text: keep it to what an id looks like.
  return id && /^[\w.:-]{1,128}$/.test(id) ? id : null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function completeResumeJson(cfg: ResumeParserConfig, input: string, deps: CompleteDeps = {}): Promise<CompleteResult> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = deps.deadline ?? Number.POSITIVE_INFINITY;
  const started = Date.now();
  const url = `${cfg.baseUrl}/chat/completions`;
  const capsKey = `${cfg.baseUrl}|${cfg.model}`;
  const caps: Caps = { ...(capsCache.get(capsKey) ?? { mode: 'json_schema', reasoningEffort: true }) };
  const usage = emptyUsage();

  let text = input;
  let maxTokens = BASE_MAX_TOKENS;
  let calls = 0;
  let waited = false;
  let shrunk = false;
  let grown = false;
  let requestId: string | null = null;

  const fail = (code: ResumeParseErrorCode, info: { status?: number; retryAfterMs?: number | null } = {}) =>
    new ResumeParseError(code, { ...info, requestId, usage, calls });
  const remember = () => capsCache.set(capsKey, { ...caps });
  const done = (raw: unknown, salvaged = false): CompleteResult => ({
    raw,
    usage,
    requestId,
    calls,
    ms: Date.now() - started,
    mode: caps.mode,
    salvaged,
  });

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw fail('deadline');
    calls++;
    const cutByDeadline = remaining < cfg.timeoutMs;
    const timeout = AbortSignal.timeout(Math.min(cfg.timeoutMs, remaining));
    const body = requestBody(cfg, text, { maxTokens, caps });

    let res: Response;
    let parsed: unknown = null;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify(body),
        // Never follow a redirect: the key goes only to the configured host.
        redirect: 'manual',
        signal: timeout,
      });
      const raw = await res.text();
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
    } catch {
      if (timeout.aborted) throw fail(cutByDeadline ? 'deadline' : 'provider_timeout');
      // Connection refused, reset, DNS: worth one more try.
      if (!waited && calls < MAX_CALLS) {
        waited = true;
        const wait = 800 + Math.floor(Math.random() * 800);
        if (Date.now() + wait < deadline - 1_000) {
          await sleep(wait);
          continue;
        }
      }
      throw fail('provider_unavailable');
    }

    const status = res.status;
    requestId = requestIdOf(parsed, res) ?? requestId;
    addUsage(usage, parsed);

    if (status >= 300 && status < 400) throw fail('provider_redirect', { status });

    if (status === 200) {
      const choice = (parsed as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null)?.choices?.[0];
      if (!parsed || !choice) throw fail('provider_bad_json', { status });
      const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
      if (choice.finish_reason === 'length') {
        // Reasoning used up the budget: one more try with room to answer.
        if (!grown && calls < MAX_CALLS) {
          grown = true;
          maxTokens = GROWN_MAX_TOKENS;
          continue;
        }
        throw fail('provider_truncated', { status });
      }
      const json = parseJsonObject(content, { lenient: caps.mode !== 'json_schema' });
      if (!json.ok) throw fail('provider_bad_json', { status });
      if (!isPlainObject(json.value)) throw fail('provider_empty', { status });
      return done(json.value);
    }

    const err = providerError(parsed);
    const errCode = err.code.toLowerCase();
    const about = `${err.param} ${err.message}`.toLowerCase();

    // Account and setup problems, whatever status they come with: no resume will get through until they're fixed.
    if (status === 402 || QUOTA_CODES.has(errCode) || QUOTA_MESSAGE.test(about)) throw fail('provider_quota', { status });
    if (RETIRED_CODES.has(errCode)) throw fail('provider_model_retired', { status });
    if (errCode === 'model_not_found') throw fail('provider_not_found', { status });

    if (status === 429 || status === 498 || (status >= 500 && status !== 501)) {
      const code = status === 429 ? 'provider_rate_limited' : 'provider_unavailable';
      const wait =
        retryAfterHeader(res.headers.get('retry-after'), Date.now()) ?? waitFromMessage(err.message) ?? 800 + Math.floor(Math.random() * 800);
      if (!waited && calls < MAX_CALLS && wait <= MAX_WAIT_MS && Date.now() + wait < deadline - 1_000) {
        waited = true;
        await sleep(wait);
        continue;
      }
      throw fail(code, { status, retryAfterMs: wait });
    }
    if (status === 401 || status === 403) throw fail('provider_auth', { status });
    if (status === 404) throw fail('provider_not_found', { status });
    if (status === 413 || (status === 400 && (errCode === 'context_length_exceeded' || CONTEXT_MESSAGE.test(about)))) {
      if (!shrunk && calls < MAX_CALLS) {
        shrunk = true;
        text = halveText(text);
        maxTokens = BASE_MAX_TOKENS;
        continue;
      }
      throw fail('provider_too_large', { status });
    }
    if (status === 400) {
      if (err.code === 'json_validate_failed') {
        if (err.failedGeneration) {
          const salvage = parseJsonObject(err.failedGeneration, { lenient: true });
          if (salvage.ok && isPlainObject(salvage.value)) return done(salvage.value, true);
        }
        if (!grown && calls < MAX_CALLS) {
          grown = true;
          maxTokens = GROWN_MAX_TOKENS;
          continue;
        }
        throw fail('provider_bad_json', { status });
      }
      const sentEffort = 'reasoning_effort' in body;
      if (sentEffort && /reasoning[_ ]effort/.test(about) && calls < MAX_CALLS) {
        caps.reasoningEffort = false;
        remember();
        continue;
      }
      if (caps.mode !== 'none' && /response_format|json_schema|json_object|structured output/.test(about) && calls < MAX_CALLS) {
        caps.mode = caps.mode === 'json_schema' ? 'json_object' : 'none';
        remember();
        continue;
      }
    }
    throw fail('provider_bad_request', { status });
  }
}
