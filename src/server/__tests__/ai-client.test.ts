import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiConfigured, aiProvider, AiUnavailableError, runAiTask } from '@/server/ai-client';

const TOKEN = 'svc_test_token_never_shown_0000';

type Call = { url: string; init: RequestInit };

/** A fake provider service: queued responses, every request kept. */
function fakeService(responses: (() => Response)[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new TypeError('fetch failed');
      return next();
    }),
  );
  return calls;
}

const on = () => {
  process.env.AI_SERVICE_URL = 'https://ai.example.com/';
  process.env.AI_SERVICE_TOKEN = TOKEN;
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ['AI_SERVICE_URL', 'AI_SERVICE_TOKEN', 'AI_PROVIDER']) delete process.env[name];
});

describe('aiProvider', () => {
  it('is off without both the service and its token, and a model key alone does nothing', () => {
    expect(aiProvider({})).toBeNull();
    expect(aiProvider({ AI_SERVICE_URL: 'https://ai.example.com' })).toBeNull();
    expect(aiProvider({ AI_API_KEY: 'gsk_x', GROQ_API_KEY: 'gsk_y' })).toBeNull();
    expect(aiProvider({ AI_SERVICE_URL: 'ftp://ai.example.com', AI_SERVICE_TOKEN: TOKEN })).toBeNull();
    expect(aiConfigured({})).toBe(false);
  });

  it('never shows the token when logged or serialized', () => {
    const p = aiProvider({ AI_SERVICE_URL: 'https://ai.example.com/', AI_SERVICE_TOKEN: TOKEN });
    expect(p).toMatchObject({ kind: 'service', url: 'https://ai.example.com' });
    expect(JSON.stringify(p)).not.toContain(TOKEN);
    expect(Object.keys(p!)).not.toContain('token');
  });

  it('has a mock mode for development and tests', () => {
    expect(aiProvider({ AI_PROVIDER: 'mock' })).toEqual({ kind: 'mock' });
  });
});

describe('runAiTask', () => {
  it('posts the task to the service, with the token only in the header', async () => {
    on();
    const calls = fakeService([() => Response.json({ model: 'm', answer: 'Maya [1]' })]);
    const out = await runAiTask('answer', { question: 'who?', excerpts: [{ n: 1, contactName: 'Maya', kind: 'note', title: 'Note', text: 'x' }] });
    expect(out).toEqual({ model: 'm', answer: 'Maya [1]' });
    expect(calls[0].url).toBe('https://ai.example.com/v1/answer');
    expect(calls[0].init.redirect).toBe('manual');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(calls[0].init.body)).not.toContain(TOKEN);
    expect(JSON.parse(String(calls[0].init.body)).question).toBe('who?');
  });

  it("turns the service's errors into fixed copy, keeping only a safe code", async () => {
    on();
    fakeService([() => Response.json({ error: { code: 'unauthorized', message: 'bad token abc' } }, { status: 401 })]);
    const error = await runAiTask('answer', { question: 'q', excerpts: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error).toMatchObject({ reason: 'unauthorized', status: 401, message: "AI couldn't answer just now. Try again in a moment." });

    fakeService([() => new Response('<html>bad gateway</html>', { status: 502 })]);
    await expect(runAiTask('draft-criteria', { role: { title: 't', location: null, content: {} } })).rejects.toMatchObject({ reason: 'http_502' });

    fakeService([]);
    await expect(runAiTask('draft-criteria', { role: { title: 't', location: null, content: {} } })).rejects.toMatchObject({ reason: 'network' });
  });

  it('refuses without a provider', async () => {
    await expect(runAiTask('answer', { question: 'q', excerpts: [] })).rejects.toMatchObject({ reason: 'not_configured' });
  });

  it('answers every task offline in mock mode', async () => {
    process.env.AI_PROVIDER = 'mock';
    const evaluation = await runAiTask('evaluate', {
      role: { title: 'Designer', location: null, content: {} },
      criteria: [{ id: 'c1', label: 'Design systems work', must: true }],
      candidate: {
        name: 'Maya',
        headline: null,
        location: null,
        links: [],
        stage: 'Screen',
        applicationNote: null,
        resumeText: 'Led design systems at Figment',
        scorecards: [{ rating: 4, summary: 'Great' }],
        transcripts: [],
      },
    });
    expect(evaluation.model).toBe('mock');
    expect(evaluation.evaluation.recommendation).toBe(3);
    expect(evaluation.evaluation.criteria).toEqual([{ id: 'c1', score: 75, evidence: 'The resume mentions design, systems.' }]);
    expect((await runAiTask('draft-criteria', { role: { title: 'Designer', location: null, content: {} } })).criteria[0].must).toBe(true);
    expect((await runAiTask('interview-insights', { transcript: 'Interviewer: Why us?\nMaya: The team.' })).qa).toEqual([
      { question: 'Why us?', answer: ['The team.'] },
    ]);
  });
});
