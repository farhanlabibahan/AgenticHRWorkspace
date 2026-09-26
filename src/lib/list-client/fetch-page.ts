/** A list page request that didn't succeed; `status` 0 means the network failed. */
export class ListFetchError extends Error {
  constructor(readonly status: number) {
    super(`List request failed (${status || 'network'})`);
  }
}

/**
 * GET one page from a /api/lists route. A 401 means the session ended: for
 * something the user asked for, the browser goes to sign-in and comes back
 * here afterwards; background prefetches just fail quietly.
 */
export async function fetchListPage<T>(
  url: string,
  { signal, redirectOn401 = true }: { signal?: AbortSignal; redirectOn401?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ListFetchError(0);
  }
  if (res.status === 401 && redirectOn401) {
    const back = window.location.pathname + window.location.search;
    window.location.assign(`/login?callbackUrl=${encodeURIComponent(back)}`);
  }
  if (!res.ok) throw new ListFetchError(res.status);
  return (await res.json()) as T;
}
