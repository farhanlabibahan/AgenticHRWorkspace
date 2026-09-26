import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * A page's own preview (its og:/twitter: tags and <title>), for a case
 * study's title and thumbnail. The URL comes from a recruiter or a resume, so
 * the fetch is guarded like any server-side request to a URL we don't
 * control: http(s) on the default ports only, every hop's host must resolve
 * only to public addresses, redirects are followed by hand (and checked
 * again), and the body is capped and time-boxed. The image itself is never
 * fetched here; the viewer's browser loads it.
 *
 * Residual risk: DNS can change between the check and the fetch (rebinding).
 * The request is a single GET that returns only parsed tags, never the body.
 */

export type LinkPreview = { title: string | null; description: string | null; image: string | null; siteName: string | null };

const EMPTY: LinkPreview = { title: null, description: null, image: null, siteName: null };
const MAX_BYTES = 512_000;
const MAX_HOPS = 4;
const TIMEOUT_MS = 4_000;

/** Whether an IP literal is a public, routable address. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return false;
    if (/^f[cd]/.test(s)) return false; // unique local
    if (/^fe[89ab]/.test(s)) return false; // link-local
    if (/^ff/.test(s)) return false; // multicast
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

/** Throws unless the URL is http(s) on a default port and its host resolves only to public addresses. */
async function assertFetchable(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
  if (url.username || url.password) throw new Error('credentials');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error('private address');
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
const decode = (s: string) =>
  s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) =>
      e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') && e !== '#39' ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, ' ')
    .trim();

/** The preview tags from a page's HTML, with the image resolved against the page's URL. */
export function parsePreview(html: string, base: URL): LinkPreview {
  const head = html.slice(0, html.search(/<\/head>/i) >= 0 ? html.search(/<\/head>/i) : MAX_BYTES);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    const value = content?.[1] ?? content?.[2];
    if (key && value && !meta.has(key)) meta.set(key, decode(value));
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v) ?? null;
  const rawImage = pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
  let image: string | null = null;
  if (rawImage) {
    try {
      const u = new URL(rawImage, base);
      if (u.protocol === 'https:' || u.protocol === 'http:') image = u.toString();
    } catch {
      image = null;
    }
  }
  const clip = (v: string | null, n: number) => (v ? v.slice(0, n) : null);
  return {
    title: clip(pick('og:title', 'twitter:title') ?? (titleTag ? decode(titleTag) : null), 160),
    description: clip(pick('og:description', 'twitter:description', 'description'), 300),
    image,
    siteName: clip(pick('og:site_name'), 80),
  };
}

/** The preview of a URL, or empty tags when it can't (or mustn't) be read. Never throws. */
export async function fetchLinkPreview(raw: string): Promise<LinkPreview> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return EMPTY;
  }
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      await assertFetchable(url);
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'SourceLinkPreview/1.0' },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!next) return EMPTY;
        url = new URL(next, url);
        continue;
      }
      if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) {
        await res.body?.cancel().catch(() => {});
        return EMPTY;
      }
      return parsePreview(await readCapped(res), url);
    }
  } catch {
    return EMPTY;
  }
  return EMPTY;
}
