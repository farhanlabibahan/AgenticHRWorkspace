import { headers } from 'next/headers';

/** This request's public origin (scheme and host), as the proxy saw it. */
export async function requestOrigin(): Promise<{ origin: string | null; https: boolean }> {
  const h = await headers();
  const first = (value: string | null) => value?.split(',')[0]?.trim() || null;
  const proto = first(h.get('x-forwarded-proto')) ?? 'http';
  const host = first(h.get('x-forwarded-host')) ?? first(h.get('host'));
  return { origin: host ? `${proto}://${host}` : null, https: proto === 'https' };
}
