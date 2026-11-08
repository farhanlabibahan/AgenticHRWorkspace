'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, isAdmin } from '@/lib/session';
import { checkIn, checkOut, decideLeave, requestLeave, HrError } from '@/server/hr';
import { runAgent } from '@/server/hr-agents';
import type { AgentKey } from '@prisma/client';

export type HrState = { error?: string; ok?: string } | undefined;

function fail(err: unknown): HrState {
  return { error: err instanceof HrError || err instanceof Error ? err.message : 'Something went wrong.' };
}

function revalidateHr() {
  revalidatePath('/attendance');
  revalidatePath('/leave');
  revalidatePath('/agents');
  revalidatePath('/dashboard');
}

export async function checkInAction(): Promise<HrState> {
  const ctx = await requireSession();
  try {
    await checkIn(ctx);
  } catch (err) {
    return fail(err);
  }
  revalidateHr();
  return { ok: 'Checked in.' };
}

export async function checkOutAction(): Promise<HrState> {
  const ctx = await requireSession();
  try {
    await checkOut(ctx);
  } catch (err) {
    return fail(err);
  }
  revalidateHr();
  return { ok: 'Checked out.' };
}

export async function requestLeaveAction(_prev: HrState, formData: FormData): Promise<HrState> {
  const ctx = await requireSession();
  const leaveTypeId = String(formData.get('leaveTypeId') ?? '');
  const startDate = String(formData.get('startDate') ?? '');
  const endDate = String(formData.get('endDate') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!leaveTypeId) return { error: 'Choose a leave type.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { error: 'Enter both dates.' };
  }
  try {
    await requestLeave(ctx, { leaveTypeId, startDate, endDate, reason });
  } catch (err) {
    return fail(err);
  }
  revalidateHr();
  return { ok: 'Request sent to an admin.' };
}

export async function decideLeaveAction(formData: FormData): Promise<HrState> {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) return { error: 'Only admins can decide leave.' };
  const id = String(formData.get('id') ?? '');
  const decision = formData.get('decision') === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  try {
    await decideLeave(ctx, id, decision, String(formData.get('note') ?? ''));
  } catch (err) {
    return fail(err);
  }
  revalidateHr();
  return { ok: decision === 'APPROVED' ? 'Leave approved.' : 'Leave rejected.' };
}

const AGENT_KEYS: AgentKey[] = ['ATTENDANCE', 'LEAVE', 'BRIEFING'];

export async function runAgentAction(formData: FormData): Promise<HrState> {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) return { error: 'Only admins can run agents.' };
  const agent = String(formData.get('agent') ?? '') as AgentKey;
  if (!AGENT_KEYS.includes(agent)) return { error: 'Unknown agent.' };
  const run = await runAgent(ctx, agent, 'manual');
  revalidatePath('/agents');
  return run.status === 'FAILED'
    ? { error: `${agent.toLowerCase()} agent failed after ${run.attempts} attempts: ${run.error}` }
    : { ok: run.summary };
}
