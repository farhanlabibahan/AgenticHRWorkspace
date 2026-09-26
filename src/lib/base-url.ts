import { headers } from 'next/headers';

/** Public origin for candidate-facing links (offers, scheduling, portal). */
export function appBaseUrl(): string {
  if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, '');
  // A production deployment's own URL sits behind Vercel's sign-in; its
  // production domain is what candidates can open.
  if (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

/** Prefer the incoming request host so local/preview deploys get the right links. */
export async function requestBaseUrl(): Promise<string> {
  try {
    const h = await headers();
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host) return `${proto}://${host}`;
  } catch {
    // headers() throws outside a request (cron, scripts)
  }
  return appBaseUrl();
}
