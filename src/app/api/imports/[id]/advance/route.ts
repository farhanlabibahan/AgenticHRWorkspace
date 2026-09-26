import { NextResponse } from 'next/server';
import { getAuthSession } from '@/lib/session';
import { getImportJob, importJobBelongsTo } from '@/server/imports/jobs';
import { PUMP_BUDGET_MS, runSlice } from '@/server/imports/runner';

export const maxDuration = 60;

/**
 * The job page calls this in a loop while an admin watches: each call runs
 * one bounded slice (if no other worker holds the job) and returns fresh
 * progress. Closing the tab is fine — the imports cron carries on.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // A fetch() loop can't follow a login redirect — answer 401 so the page stops pumping.
  const session = await getAuthSession();
  if (!session?.user?.id || !session.user.orgId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const ctx = {
    userId: session.user.id,
    orgId: session.user.orgId,
    accessRole: String(session.user.accessRole ?? 'TEAM_MEMBER'),
  };
  const { id } = await params;
  try {
    if (!(await importJobBelongsTo(ctx, id))) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const result = await runSlice(id, PUMP_BUDGET_MS);
  const job = await getImportJob(ctx, id);
  return NextResponse.json({ result, job });
}
