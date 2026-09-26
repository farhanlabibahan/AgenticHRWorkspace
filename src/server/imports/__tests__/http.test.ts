import { describe, expect, it } from 'vitest';
import {
  createHttpClient,
  ImportAuthError,
  ImportHttpError,
  isPrivateAddress,
  retryAfterMs,
  YieldError,
} from '@/server/imports/http';

type Call = { url: string; headers: Record<string, string>; method: string };

function fakeFetch(routes: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: { ...(init.headers as Record<string, string>) }, method: init.method ?? 'GET' });
    return routes(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  let t = 1_000_000;
  const slept: number[] = [];
  const http = createHttpClient({
    auth: { hosts: ['api.vendor.test'], headers: { authorization: 'Basic c2VjcmV0Og==' }, query: { apikey: 'SECRET' } },
    minIntervalMs: 0,
    fetchImpl,
    // Made-up test hosts resolve to a public address unless a test says otherwise.
    resolveHost: async () => ['93.184.216.34'],
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    ...extra,
  });
  return { http, slept, advance: (ms: number) => (t += ms), now: () => t };
}

describe('import http client', () => {
  it('sends credentials only to the vendor API host, never to a redirect target', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.host === 'api.vendor.test') {
        return new Response(null, { status: 302, headers: { location: 'https://bucket.s3.amazonaws.com/resume.pdf?sig=abc' } });
      }
      return new Response(Buffer.from('%PDF-1.4'), {
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Jane Doe.pdf"' },
      });
    });
    const { http } = client(impl);
    const file = await http.bytes('https://api.vendor.test/v1/resumes/1/download');

    expect(file.filename).toBe('Jane Doe.pdf');
    expect(file.data.toString()).toBe('%PDF-1.4');
    expect(calls[0].headers.authorization).toBeDefined();
    expect(calls[0].url).toContain('apikey=SECRET');
    expect(calls[1].url.startsWith('https://bucket.s3.amazonaws.com/')).toBe(true);
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(calls[1].url).not.toContain('SECRET');
  });

  it('honors Retry-After on 429 and then succeeds', async () => {
    let n = 0;
    const { impl } = fakeFetch(() => (n++ === 0 ? json({}, { status: 429, headers: { 'retry-after': '2' } }) : json({ ok: true })));
    const { http, slept } = client(impl);
    await expect(http.json('https://api.vendor.test/v1/things')).resolves.toEqual({ ok: true });
    expect(slept).toContain(2000);
  });

  it('yields instead of sleeping past the slice deadline, remembering when to resume', async () => {
    const { impl } = fakeFetch(() => json({}, { status: 429, headers: { 'retry-after': '120' } }));
    const { http } = client(impl, { deadline: 1_000_000 + 10_000 });
    const err = (await http.json('https://api.vendor.test/v1/things').catch((e: unknown) => e)) as YieldError;
    expect(err).toBeInstanceOf(YieldError);
    expect(err.resumeAt).toBe(1_000_000 + 120_000);
  });

  it('fails a server error whose retries would outlast the slice, instead of yielding forever', async () => {
    const { impl, calls } = fakeFetch(() => new Response('down', { status: 502 }));
    const { http } = client(impl, { deadline: 1_000_000 + 5_000 });
    const err = (await http.json('https://api.vendor.test/v1/things').catch((e: unknown) => e)) as ImportHttpError;
    expect(err).toBeInstanceOf(ImportHttpError);
    expect(err.status).toBe(502);
    expect(calls.length).toBeLessThan(5); // 1 s + 2 s fit; the 4 s wait doesn't
  });

  it('maps 401 to an auth error that names the endpoint but not the key', async () => {
    const { impl } = fakeFetch(() => json({ message: 'bad key' }, { status: 401 }));
    const { http } = client(impl);
    const err = (await http.json('https://api.vendor.test/v1/users', { limit: 1 }).catch((e: unknown) => e)) as ImportAuthError;
    expect(err).toBeInstanceOf(ImportAuthError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('api.vendor.test/v1/users');
    expect(err.message).not.toContain('SECRET');
    expect(err.message).not.toContain('limit');
  });

  it('retries 5xx with backoff and gives up with a sanitized error', async () => {
    const { impl, calls } = fakeFetch(() => new Response('upstream down', { status: 503 }));
    const { http } = client(impl, { maxRetries: 2 });
    const err = (await http.json('https://api.vendor.test/v1/x?token=abc').catch((e: unknown) => e)) as ImportHttpError;
    expect(err).toBeInstanceOf(ImportHttpError);
    expect(err.status).toBe(503);
    expect(calls).toHaveLength(3);
    expect(err.message).not.toContain('token');
  });

  it('refuses downloads over the size cap', async () => {
    const { impl } = fakeFetch(() => new Response(Buffer.alloc(2048), { headers: { 'content-length': '2048' } }));
    const { http } = client(impl);
    const err = (await http.bytes('https://files.vendor.test/big.pdf', { maxBytes: 1024 }).catch((e: unknown) => e)) as ImportHttpError;
    expect(err).toBeInstanceOf(ImportHttpError);
    expect(err.status).toBe(413);
  });

  it('spaces requests by the vendor rate limit', async () => {
    const { impl } = fakeFetch(() => json({}));
    const { http, slept } = client(impl, { minIntervalMs: 100 });
    await http.json('https://api.vendor.test/a');
    await http.json('https://api.vendor.test/b');
    await http.json('https://api.vendor.test/c');
    expect(slept.filter((ms) => ms === 100)).toHaveLength(2);
  });

  it('mints a token once, refreshes it after a 401, and keeps it off other hosts', async () => {
    let minted = 0;
    let apiCalls = 0;
    const { impl, calls } = fakeFetch((url) => {
      if (url.host === 'auth.vendor.test') return json({ access_token: `tok-${++minted}`, expires_in: 3600 });
      if (url.host === 'api.vendor.test') {
        apiCalls++;
        return apiCalls === 2 ? json({}, { status: 401 }) : json({ n: apiCalls });
      }
      return new Response('file');
    });
    let cached: string | null = null;
    const http = createHttpClient({
      auth: {
        hosts: ['api.vendor.test'],
        getHeaders: async (c, { refresh }) => {
          if (!cached || refresh) {
            const res = await c.request<{ access_token: string }>({
              url: 'https://auth.vendor.test/token',
              method: 'POST',
              body: { grant_type: 'client_credentials' },
              headers: { authorization: 'Basic Y2xpZW50OnNlY3JldA==' },
            });
            cached = res.data.access_token;
          }
          return { authorization: `Bearer ${cached}` };
        },
      },
      minIntervalMs: 0,
      fetchImpl: impl,
      resolveHost: async () => ['93.184.216.34'],
      sleep: async () => undefined,
    });

    await http.json('https://api.vendor.test/a');
    await http.json('https://api.vendor.test/b'); // 401 → refresh → retry
    await http.bytes('https://cdn.vendor.test/resume.pdf');

    expect(minted).toBe(2);
    const api = calls.filter((c) => c.url.includes('api.vendor.test'));
    expect(api.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2']);
    expect(calls.find((c) => c.url.includes('cdn.vendor.test'))!.headers.authorization).toBeUndefined();
  });

  it('refuses to download from private networks, even via a redirect', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.host === 'api.vendor.test'
        ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
        : new Response('secret'),
    );
    const resolveHost = async (host: string) => (host === 'internal.corp.test' ? ['10.0.0.5'] : ['93.184.216.34']);
    const { http } = client(impl, { resolveHost });

    for (const url of [
      'https://api.vendor.test/v1/resumes/1/download', // redirects to the metadata service
      'http://127.0.0.1:5432/',
      'http://[::1]/',
      'https://internal.corp.test/resume.pdf',
      'http://localhost:3000/api/files/x',
      'file:///etc/passwd',
    ]) {
      const err = (await http.bytes(url).catch((e: unknown) => e)) as ImportHttpError;
      expect(err, url).toBeInstanceOf(ImportHttpError);
      expect(err.status, url).toBe(400);
    }
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.vendor.test']);
    await expect(http.bytes('https://cdn.public.test/resume.pdf')).resolves.toMatchObject({ data: expect.any(Buffer) });
  });

  it('recognizes private addresses in every IPv4 and IPv6 spelling', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:a9fe:a9fe]', '0:0:0:0:0:ffff:7f00:0001',
      '::127.0.0.1', '64:ff9b::a9fe:a9fe', 'fd00::1', 'fe80::1%en0', 'ff02::1', 'not-an-ip',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:84e5', '::ffff:93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses hosts that do not resolve, and IPv4-mapped IPv6 literals', async () => {
    const { impl, calls } = fakeFetch(() => new Response('x'));
    const { http } = client(impl, { resolveHost: async () => [] });
    for (const url of ['https://nowhere.invalid/r.pdf', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/']) {
      const err = (await http.bytes(url).catch((e: unknown) => e)) as ImportHttpError;
      expect(err, url).toBeInstanceOf(ImportHttpError);
    }
    expect(calls).toHaveLength(0);
  });

  it('never sends credentials over plain http', async () => {
    const { impl, calls } = fakeFetch(() => json({}));
    const { http } = client(impl);
    const err = (await http.json('http://api.vendor.test/v1/users').catch((e: unknown) => e)) as ImportHttpError;
    expect(err).toBeInstanceOf(ImportHttpError);
    expect(calls).toHaveLength(0);
  });

  it("drops the caller's headers when a redirect leaves the host", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.host === 'auth.vendor.test'
        ? new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/token' } })
        : json({ access_token: 't' }),
    );
    const { http } = client(impl);
    await http.request({
      url: 'https://auth.vendor.test/token',
      method: 'POST',
      body: {},
      headers: { authorization: 'Basic Y2xpZW50OnNlY3JldA==' },
    });
    expect(calls[0].headers.authorization).toBe('Basic Y2xpZW50OnNlY3JldA==');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('skipAuth sends a request to the vendor host without credentials', async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true }));
    const { http } = client(impl);
    await http.request({ url: 'https://api.vendor.test/public/careers', skipAuth: true });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].url).not.toContain('SECRET');
  });

  it('stops reading a body that grows past the cap, even without Content-Length', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(512));
        if (pulled > 100) controller.close();
      },
    });
    const { impl } = fakeFetch(() => new Response(stream));
    const { http } = client(impl);
    const err = (await http.bytes('https://files.vendor.test/big.pdf', { maxBytes: 2048 }).catch((e: unknown) => e)) as ImportHttpError;
    expect(err).toBeInstanceOf(ImportHttpError);
    expect(err.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('parses Retry-After dates and epoch reset headers', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' }), now)).toBe(5000);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 3) }), now)).toBe(3000);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': '4' }), now)).toBe(4000);
    expect(retryAfterMs(new Headers(), now)).toBeNull();
  });
});
