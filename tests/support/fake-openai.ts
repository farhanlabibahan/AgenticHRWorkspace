import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * A local stand-in for an OpenAI-compatible chat completions endpoint, with
 * the quirks the resume parser has to survive: Groq's strictness (a 400 for
 * any field it doesn't know, for streaming with a JSON schema, and a 413 when
 * prompt plus output budget exceed a free-tier limit), Ollama's error shape
 * and reasoning field, OpenRouter's reasoning_details.
 *
 * Replies are queued with enqueue(); with none queued, `respond` decides,
 * and by default the fake reads the resume between the markers and answers
 * with an "echo" profile built from it (echoProfile). No dependencies and no
 * path aliases, so a script can run it with node --experimental-strip-types.
 */

export type FakeProfile = 'groq' | 'generic' | 'openrouter' | 'ollama';

export type FakeReply = {
  status?: number;
  headers?: Record<string, string>;
  /** The raw body: an object is sent as JSON, a string as is. Overrides content. */
  body?: unknown;
  /** The completion's message.content: a string, or an object sent as JSON text. */
  content?: unknown;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; cached_tokens?: number };
  /** An OpenAI-style error body with this status (default 400). */
  error?: { message: string; type?: string; code?: string; param?: string; failed_generation?: string };
  delayMs?: number;
  /** Take the request and never answer. */
  hang?: boolean;
};

export type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
  /** The text between the resume markers of the user message. */
  resumeText: string | null;
  systemPrompt: string | null;
  userMessage: string | null;
};

export type FakeOpenAI = {
  /** Base URL, e.g. http://127.0.0.1:3842/v1 */
  url: string;
  requests: RecordedRequest[];
  enqueue: (...replies: FakeReply[]) => void;
  setRespond: (respond: ((req: RecordedRequest) => FakeReply | undefined) | null) => void;
  setProfile: (profile: FakeProfile) => void;
  reset: () => void;
  close: () => Promise<void>;
};

const GROQ_FIELDS = new Set([
  'model',
  'messages',
  'response_format',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'include_reasoning',
  'reasoning_format',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'seed',
  'stop',
  'service_tier',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'user',
]);

export function markedResume(user: string | null): string | null {
  if (!user) return null;
  const m = user.match(/<<<RESUME_([0-9a-f]+)>>>\n([\s\S]*)\n<<<END_RESUME_\1>>>/);
  return m ? m[2] : null;
}

/** A plausible profile read straight off the resume text: first line name, second headline, "City, Region" location. */
export function echoProfile(text: string | null) {
  const src = text ?? '';
  const lines = src
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const location = lines.slice(1, 5).find((l) => /^[^\d@:/]+, [^\d@:/]+$/.test(l)) ?? null;
  const skillsLine = lines.find((l) => /^skills:/i.test(l));
  const experience = lines
    .map((l) => l.match(/^(.+?), (.+?) [\u2014\u2013-] (.+?) to (.+)$/))
    .filter((m): m is RegExpMatchArray => !!m && !/university|college|school/i.test(m[2]))
    .map((m) => ({ title: m[1], company: m[2], location: null, start: m[3], end: m[4] }));
  const education = lines
    .map((l) => l.match(/^(.+?), (.*(?:University|College|School).*?),? (\d{4}) to (\d{4})$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ school: m[2], degree: m[1], field: null, start: m[3], end: m[4] }));
  return {
    name: lines[0] ?? null,
    headline: lines[1] && !lines[1].includes('@') && lines[1] !== location ? lines[1] : null,
    location,
    summary: null,
    emails: src.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [],
    phones: src.match(/\+?\d[\d ().-]{6,}\d/g)?.filter((p) => !/^\d{4}\s*-\s*\d{2,4}$/.test(p)) ?? [],
    links: src.match(/https?:\/\/[^\s)]+|(?<![\w/@.])(?:www\.)?(?:linkedin\.com|github\.com)\/[^\s)]+/g) ?? [],
    skills: skillsLine ? skillsLine.replace(/^skills:\s*/i, '').split(/,\s*/).filter(Boolean) : [],
    experience,
    education,
  };
}

function completion(body: Record<string, unknown> | null, reply: FakeReply, profile: FakeProfile, req: RecordedRequest) {
  const content =
    reply.content === undefined ? JSON.stringify(echoProfile(req.resumeText)) : typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content);
  const u = reply.usage ?? {};
  const completionTokens = u.completion_tokens ?? 420;
  const reasoningTokens = u.reasoning_tokens ?? 120;
  const message: Record<string, unknown> = { role: 'assistant', content };
  // What each server does with reasoning: none of it should ever be read.
  if (profile === 'ollama' || profile === 'generic') message.reasoning = 'Thinking about the resume. SECRET-REASONING';
  if (profile === 'openrouter') {
    message.reasoning = 'SECRET-REASONING';
    message.reasoning_details = [{ type: 'reasoning.text', text: 'SECRET-REASONING' }];
  }
  if (profile === 'groq' && body?.include_reasoning !== false) message.reasoning = 'SECRET-REASONING';
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? 'unknown',
    choices: [{ index: 0, message, logprobs: null, finish_reason: reply.finishReason ?? 'stop' }],
    usage: {
      prompt_tokens: u.prompt_tokens ?? 1800,
      completion_tokens: completionTokens,
      total_tokens: (u.prompt_tokens ?? 1800) + completionTokens,
      ...(profile === 'ollama' ? {} : { prompt_tokens_details: { cached_tokens: u.cached_tokens ?? 0 }, completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
    },
    ...(profile === 'groq' ? { x_groq: { id: `req_${Math.random().toString(36).slice(2, 12)}` } } : {}),
  };
}

function errorBody(err: NonNullable<FakeReply['error']>, profile: FakeProfile) {
  return {
    error: {
      message: err.message,
      type: err.type ?? 'invalid_request_error',
      ...(err.code !== undefined ? { code: err.code } : {}),
      ...(profile === 'ollama' ? { param: err.param ?? null, code: err.code ?? null } : err.param !== undefined ? { param: err.param } : {}),
      ...(err.failed_generation !== undefined ? { failed_generation: err.failed_generation } : {}),
    },
  };
}

/** Groq's own checks, before any queued reply. */
function groqRejects(body: Record<string, unknown> | null, tpmLimit: number | undefined): FakeReply | undefined {
  if (!body) return { status: 400, error: { message: 'Invalid JSON body' } };
  for (const key of Object.keys(body)) {
    if (!GROQ_FIELDS.has(key)) return { status: 400, error: { message: `property '${key}' is unsupported` } };
  }
  const format = body.response_format as { type?: string } | undefined;
  if (body.stream === true && format?.type === 'json_schema') {
    return { status: 400, error: { message: 'Structured Outputs do not support streaming.' } };
  }
  if (tpmLimit) {
    const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4) + Math.ceil(JSON.stringify(format ?? {}).length / 4);
    const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
    if (promptTokens + maxTokens > tpmLimit) {
      return {
        status: 413,
        error: {
          message: `Request too large for model \`${String(body.model)}\` on tokens per minute (TPM): Limit ${tpmLimit}, Requested ${promptTokens + maxTokens}.`,
          type: 'tokens',
          code: 'rate_limit_exceeded',
        },
      };
    }
  }
  return undefined;
}

export async function startFakeOpenAI(opts: {
  port: number;
  profile?: FakeProfile;
  /** Groq free tier: prompt + max_tokens above this is a 413. */
  tpmLimit?: number;
  respond?: (req: RecordedRequest) => FakeReply | undefined;
}): Promise<FakeOpenAI> {
  let profile: FakeProfile = opts.profile ?? 'groq';
  let respond = opts.respond ?? null;
  const queue: FakeReply[] = [];
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const hanging = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const messages = (Array.isArray(body?.messages) ? body.messages : []) as { role?: string; content?: string }[];
      const system = messages.find((m) => m.role === 'system')?.content ?? null;
      const user = messages.find((m) => m.role === 'user')?.content ?? null;
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body,
        resumeText: markedResume(user),
        systemPrompt: system,
        userMessage: user,
      };

      // Scenario control for manual runs: POST /__scenario {"profile"?, "replies"?: [...], "sticky"?: {...}}.
      if (req.url === '/__scenario') {
        const s = (body ?? {}) as { profile?: FakeProfile; replies?: FakeReply[]; sticky?: FakeReply | null; reset?: boolean };
        if (s.reset) {
          queue.length = 0;
          requests.length = 0;
          respond = opts.respond ?? null;
        }
        if (s.profile) profile = s.profile;
        if (s.replies) queue.push(...s.replies);
        if (s.sticky !== undefined) respond = s.sticky ? () => s.sticky! : (opts.respond ?? null);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, profile, queued: queue.length }));
        return;
      }
      if (req.url === '/__requests') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests.map((r) => ({ path: r.path, body: r.body }))));
        return;
      }

      requests.push(recorded);
      if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
        return;
      }

      const reply =
        (profile === 'groq' ? groqRejects(body, opts.tpmLimit) : undefined) ?? queue.shift() ?? respond?.(recorded) ?? ({} as FakeReply);
      if (reply.hang) {
        hanging.add(res);
        return;
      }
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;

      const status = reply.status ?? (reply.error ? 400 : 200);
      const headers: Record<string, string> = { 'content-type': 'application/json', ...reply.headers };
      let payload: string;
      if (reply.body !== undefined) payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      else if (reply.error) payload = JSON.stringify(errorBody(reply.error, profile));
      else if (status === 200) payload = JSON.stringify(completion(body, reply, profile, recorded));
      else payload = '';
      res.writeHead(status, headers).end(payload);
    });
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${opts.port}/v1`,
    requests,
    enqueue: (...replies) => queue.push(...replies),
    setRespond: (fn) => {
      respond = fn;
    },
    setProfile: (p) => {
      profile = p;
    },
    reset: () => {
      queue.length = 0;
      requests.length = 0;
      respond = opts.respond ?? null;
      profile = opts.profile ?? 'groq';
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
