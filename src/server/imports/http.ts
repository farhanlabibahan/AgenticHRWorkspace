/**
 * The one HTTP client every provider adapter uses.
 *
 * - Auth headers (and auth query params) are attached ONLY for the vendor's
 *   API hosts. Resume downloads often redirect to pre-signed S3/GCS URLs;
 *   those must never receive the customer's API key.
 * - Requests are spaced by the vendor's published rate limit, 429s honor
 *   Retry-After, and 5xx/network errors retry with backoff.
 * - When a wait would outlast the current slice, it throws YieldError so the
 *   runner checkpoints and resumes later instead of burning the time budget.
 * - Error messages carry method + host + path, never the query string
 *   (JazzHR-style APIs put the key there) and never headers.
 */

import { lookup as lookupCb, type LookupAddress } from 'dns';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Agent } from 'undici';

/**
 * 401/403 from the vendor API. 401 = the credentials are wrong; 403 usually
 * means the key lacks a permission for this endpoint — adapters may catch it
 * on optional data (offers, scorecards) and warn instead of failing.
 */
export class ImportAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly where: string,
  ) {
    super(
      status === 401
        ? `The provider rejected these credentials (${where})`
        : `This key doesn't have permission for ${where}`,
    );
    this.name = 'ImportAuthError';
  }
}

export class ImportHttpError extends Error {
  constructor(
    readonly status: number,
    readonly where: string,
    detail?: string,
  ) {
    super(`${where} → HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'ImportHttpError';
  }
}

/**
 * Not a failure — the slice ran out of time mid-wait; resume from the last
 * cursor. `resumeAt` is when the refused wait would have ended (a vendor's
 * Retry-After), so the runner can hold the job until then.
 */
export class YieldError extends Error {
  constructor(readonly resumeAt: number | null = null) {
    super('Slice budget exhausted while waiting on the provider');
    this.name = 'YieldError';
  }
}

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

export type HttpRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, QueryValue>;
  /** Objects are sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Send without the vendor's credentials even to an auth host (token endpoints, public pages). */
  skipAuth?: boolean;
};

export type HttpResponse<T> = { status: number; headers: Headers; data: T };

export type HttpClient = {
  /** JSON request. 401/403 → ImportAuthError, other non-2xx → ImportHttpError. */
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
  json<T = unknown>(url: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T = unknown>(url: string, body: unknown): Promise<T>;
  /** Binary download (resumes). Auth only if the host is a vendor API host. */
  bytes(url: string, opts?: { headers?: Record<string, string>; maxBytes?: number; skipAuth?: boolean }): Promise<{
    data: Buffer;
    contentType: string | null;
    filename: string | null;
  }>;
};

/**
 * How a vendor authenticates. Static keys use `headers`/`query`. Token-based
 * vendors (OAuth client credentials) supply `getHeaders`, which mints or
 * caches a token; after a 401 it's called once with `refresh: true` and the
 * request is retried. Everything here applies only to `hosts`.
 */
export type AuthConfig = {
  hosts: string[];
  headers?: Record<string, string>;
  query?: Record<string, string>;
  getHeaders?: (http: HttpClient, opts: { refresh: boolean }) => Promise<Record<string, string>>;
};

export type HttpClientOptions = {
  auth: AuthConfig;
  minIntervalMs: number;
  /** Epoch ms after which waits should yield instead of sleeping. */
  deadline?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolveHost?: (host: string) => Promise<string[]>;
};

function isPrivateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Expand any textual IPv6 form (compressed, dotted tail, zone id) to 8 hextets. */
function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const parts = [...head, ...Array(Math.max(0, fill)).fill('0'), ...rest];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

/**
 * Loopback, private, link-local (cloud metadata), CGNAT, multicast,
 * documentation, and other non-public ranges — including IPv4 addresses
 * smuggled inside IPv6 (mapped, compatible, NAT64) in any textual form.
 * Anything unparseable counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) return isPrivateV4(bare);
  const h = parseV6(bare);
  if (!h) return true;
  const embedded = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    if (h[5] === 0 && h[6] === 0) return true; // ::, ::1 and the rest of ::/112
    return isPrivateV4(embedded); // ::ffff:a.b.c.d, ::a.b.c.d
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embedded); // NAT64
  return (
    (h[0] & 0xfe00) === 0xfc00 || // unique local
    (h[0] & 0xffc0) === 0xfe80 || // link-local
    (h[0] & 0xff00) === 0xff00 || // multicast
    (h[0] === 0x2001 && h[1] === 0x0db8) // documentation
  );
}

async function defaultResolve(host: string): Promise<string[]> {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

/**
 * Re-checks the address at connect time, so a hostname that resolved to a
 * public IP during the pre-check can't rebind to a private one for the
 * actual connection. Used as the dispatcher for every non-vendor request.
 */
let guardedAgent: Agent | null = null;
function publicOnlyAgent(): Agent {
  guardedAgent ??= new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, '', 4);
          const list = addresses as unknown as LookupAddress[];
          if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
            return callback(new Error('refusing to connect to a private network address'), '', 4);
          }
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
          } else {
            callback(null, list[0].address, list[0].family);
          }
        });
      },
    },
  });
  return guardedAgent;
}

export const MAX_JSON_BYTES = 50 * 1024 * 1024;

export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

export function buildUrl(url: string, query?: Record<string, QueryValue>): URL {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
    else u.searchParams.set(k, String(v));
  }
  return u;
}

/** Safe-to-log description of a request: method, host, path. No query, no headers. */
export function describe(method: string, url: URL): string {
  return `${method} ${url.host}${url.pathname}`;
}

function hostMatches(host: string, allowed: string[]): boolean {
  return allowed.some((a) => host === a || (a.startsWith('.') && host.endsWith(a)));
}

/** Parse Retry-After (seconds or HTTP date) or common reset headers into ms. */
export function retryAfterMs(headers: Headers, now: number): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  for (const name of ['x-ratelimit-reset', 'x-rate-limit-reset', 'ratelimit-reset']) {
    const v = headers.get(name);
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    // Epoch seconds vs. seconds-until-reset
    return n > 1e9 ? Math.max(0, n * 1000 - now) : Math.max(0, n * 1000);
  }
  return null;
}

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 5;
  let nextSlot = 0;

  const fits = (ms: number) => !opts.deadline || now() + ms <= opts.deadline;

  async function wait(ms: number) {
    if (ms <= 0) return;
    if (opts.deadline && now() + ms > opts.deadline) throw new YieldError(now() + ms);
    await sleep(ms);
  }

  async function assertPublic(method: string, url: URL) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ImportHttpError(400, describe(method, url), 'only http(s) requests are allowed');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new ImportHttpError(400, describe(method, url), 'refusing to fetch a private network address');
    }
    const addresses = isIP(host) ? [host] : await (opts.resolveHost ?? defaultResolve)(host);
    if (!addresses.length) {
      throw new ImportHttpError(0, describe(method, url), 'could not resolve host');
    }
    if (addresses.some(isPrivateAddress)) {
      throw new ImportHttpError(400, describe(method, url), 'refusing to fetch a private network address');
    }
  }

  /** Read a body but stop — and cancel the stream — the moment it passes `max`. */
  async function readLimited(res: Response, max: number, where: string): Promise<Buffer> {
    const tooBig = () => new ImportHttpError(413, where, `response larger than ${Math.round(max / 1e6)} MB`);
    if (Number(res.headers.get('content-length') ?? '0') > max) {
      await res.body?.cancel().catch(() => undefined);
      throw tooBig();
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async function throttle() {
    const t = now();
    const start = Math.max(t, nextSlot);
    nextSlot = start + opts.minIntervalMs;
    await wait(start - t);
  }

  async function send(
    method: string,
    url: URL,
    init: { headers: Record<string, string>; body?: string; skipAuth?: boolean },
    expectBinary: boolean,
    redirects = 0,
  ): Promise<Response> {
    const authed = !init.skipAuth && hostMatches(url.host, opts.auth.hosts);
    const where = describe(method, url);
    if (authed && url.protocol !== 'https:') {
      throw new ImportHttpError(400, where, 'credentials are only sent over https');
    }
    // URLs outside the vendor's API come from payload data (resume links,
    // redirects). Never let one point the server at its own network.
    if (!authed) await assertPublic(method, url);
    if (authed) for (const [k, v] of Object.entries(opts.auth.query ?? {})) url.searchParams.set(k, v);
    const baseHeaders: Record<string, string> = {
      ...(expectBinary ? {} : { accept: 'application/json' }),
      ...init.headers,
      ...(authed ? (opts.auth.headers ?? {}) : {}),
    };
    const dynamic = authed ? opts.auth.getHeaders : undefined;
    let headers = dynamic ? { ...baseHeaders, ...(await dynamic(client, { refresh: false })) } : baseHeaders;
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      await throttle();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: init.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          // Undici option (Node's fetch): connect-time address check for non-vendor hosts.
          ...(!authed && !opts.fetchImpl ? { dispatcher: publicOnlyAgent() } : {}),
        } as RequestInit);
      } catch (err) {
        const backoff = Math.min(30_000, 1000 * 2 ** attempt);
        if (attempt >= maxRetries || !fits(backoff)) {
          throw new ImportHttpError(0, where, err instanceof Error ? err.name : 'network error');
        }
        await wait(backoff);
        continue;
      }

      // Follow redirects ourselves so auth never rides along to another host.
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => undefined);
        if (redirects >= 5) throw new ImportHttpError(res.status, where, 'too many redirects');
        const next = new URL(res.headers.get('location')!, url);
        // Caller headers (e.g. a token request's client-secret) never follow to another host.
        const sameHost = next.host === url.host && next.protocol === url.protocol;
        return send(
          method === 'POST' ? 'GET' : method,
          next,
          { headers: sameHost ? init.headers : {}, skipAuth: init.skipAuth },
          expectBinary,
          redirects + 1,
        );
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 401 && dynamic && !refreshed) {
          // Expired token: mint a fresh one and retry once.
          refreshed = true;
          headers = { ...baseHeaders, ...(await dynamic(client, { refresh: true })) };
          attempt--;
          continue;
        }
        if (authed) throw new ImportAuthError(res.status as 401 | 403, where);
        throw new ImportHttpError(res.status, where);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxRetries) throw new ImportHttpError(res.status, where);
        const hinted = res.status === 429 ? retryAfterMs(res.headers, now()) : null;
        const backoff = hinted ?? Math.min(30_000, 1000 * 2 ** attempt);
        await res.body?.cancel().catch(() => undefined);
        // A 429 is the vendor asking us to wait: yield and come back then. A
        // server error whose retries won't fit in this slice fails now, and the
        // runner's slice backoff takes over — yielding would restart the
        // retries from zero every slice and never give up.
        if (res.status >= 500 && !fits(backoff)) throw new ImportHttpError(res.status, where);
        await wait(backoff);
        continue;
      }
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        } catch {
          /* ignore */
        }
        throw new ImportHttpError(res.status, where, detail || undefined);
      }
      return res;
    }
  }

  const client: HttpClient = {
    async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
      const method = req.method ?? 'GET';
      const url = buildUrl(req.url, req.query);
      const hasBody = req.body !== undefined;
      const res = await send(
        method,
        url,
        {
          headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...req.headers },
          body: hasBody ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined,
          skipAuth: req.skipAuth,
        },
        false,
      );
      const text = (await readLimited(res, MAX_JSON_BYTES, describe(method, url))).toString('utf8');
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new ImportHttpError(res.status, describe(method, url), 'response was not JSON');
        }
      }
      return { status: res.status, headers: res.headers, data: data as T };
    },
    async json<T>(url: string, query?: Record<string, QueryValue>) {
      return (await client.request<T>({ url, query })).data;
    },
    async post<T>(url: string, body: unknown) {
      return (await client.request<T>({ url, method: 'POST', body })).data;
    },
    async bytes(url: string, o = {}) {
      const target = new URL(url);
      const res = await send('GET', target, { headers: o.headers ?? {}, skipAuth: o.skipAuth }, true);
      const data = await readLimited(res, o.maxBytes ?? MAX_DOWNLOAD_BYTES, describe('GET', target));
      return {
        data,
        contentType: res.headers.get('content-type'),
        filename: filenameFrom(res.headers.get('content-disposition')),
      };
    },
  };
  return client;
}
