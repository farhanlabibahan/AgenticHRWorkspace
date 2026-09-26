/**
 * Where to send someone after they sign in, from an untrusted `callbackUrl`
 * (the middleware sets it to the page that bounced them to /login). Only a
 * path on this site survives: a relative path, or an absolute URL on
 * `origin`. Anything else (another host, `//host`, `/\host`, `javascript:`,
 * control characters) falls back.
 */
export function safeRedirectPath(
  raw: unknown,
  { origin, fallback = '/dashboard' }: { origin?: string | null; fallback?: string } = {},
): string {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return fallback;
  // Browsers drop tabs and newlines and read "\" as "/" in URLs, which turns
  // "/\evil.com" or "/\t/evil.com" into a protocol-relative "//evil.com".
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;

  let target: URL;
  try {
    if (raw.startsWith('/')) {
      if (raw.startsWith('//')) return fallback;
      target = new URL(raw, 'http://relative.invalid');
      if (target.host !== 'relative.invalid') return fallback;
    } else {
      if (!origin) return fallback;
      target = new URL(raw);
      if (target.origin !== new URL(origin).origin) return fallback;
    }
  } catch {
    return fallback;
  }
  const path = `${target.pathname}${target.search}${target.hash}`;
  return path.startsWith('/') && !path.startsWith('//') ? path : fallback;
}
