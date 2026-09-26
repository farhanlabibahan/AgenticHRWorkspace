'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/session';
import {
  cancelImport,
  confirmImportMapping,
  startImport,
  testImportConnection,
} from '@/server/imports/jobs';
import type { MappingInput } from '@/server/imports/mapping';
import type { ImportOptions } from '@/server/imports/types';

/** Server actions for Settings → Import. Thin wrappers; rules live in src/server/imports/jobs.ts. */

export async function testImportConnectionAction(provider: string, credentials: Record<string, string>) {
  const ctx = await requireSession();
  return testImportConnection(ctx, provider, credentials);
}

export async function startImportAction(
  provider: string,
  credentials: Record<string, string>,
  options: Partial<ImportOptions>,
) {
  const ctx = await requireSession();
  const result = await startImport(ctx, provider, credentials, options);
  if (result.ok) revalidatePath('/settings/import');
  return result;
}

export async function confirmImportMappingAction(
  jobId: string,
  mapping: MappingInput,
): Promise<{ error?: string }> {
  const ctx = await requireSession();
  try {
    await confirmImportMapping(ctx, jobId, mapping);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the mapping' };
  }
  revalidatePath(`/settings/import/${jobId}`);
  revalidatePath('/settings');
  return {};
}

export async function cancelImportAction(jobId: string): Promise<{ error?: string }> {
  const ctx = await requireSession();
  try {
    if (!(await cancelImport(ctx, jobId))) return { error: 'This import already finished.' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not cancel' };
  }
  revalidatePath(`/settings/import/${jobId}`);
  revalidatePath('/settings/import');
  return {};
}
