'use server';

import { revalidatePath } from 'next/cache';
import { storeFile } from '@/server/storage';
import { redirect } from 'next/navigation';
import { Prisma, type OrgKind, type StageType } from '@prisma/client';
import { isDefaultBrand, readBrand } from '@/lib/brand';
import { db } from '@/lib/db';
import { requireSession, revalidateOrgNav } from '@/lib/session';
import { writeOrgNavCookie } from '@/lib/org-nav-cookie';
import {
  addGroups,
  completeOnboarding,
  removeClientCompany,
  removeDepartment,
  removeGroups,
  setOrgKind,
  type GroupKind,
} from '@/server/org';
import { cleanNames, namesFromRows } from '@/lib/names';
import { providerMeta } from '@/lib/import-providers';
import { readSpreadsheet } from '@/server/spreadsheet';
import { createStage, deleteStage, renameStage, setStageOrder } from '@/server/stages';
import {
  createTemplate,
  deleteTemplate,
  updateEmailAutomation,
  updateTemplate,
} from '@/server/email';
import { createApiKey, revokeApiKey } from '@/server/api-keys';
import { inviteUser, setUserActive, setUserRole } from '@/server/team';
import type { AccessRole } from '@prisma/client';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  setWebhookActive,
} from '@/server/webhooks';

const PATHS = ['/onboarding', '/settings', '/pipeline', '/postings'];
const STAGE_TYPES = ['LEAD', 'APPLICANT', 'SCREEN', 'ONSITE', 'OFFER', 'HIRED'] as const;

function refresh() {
  for (const p of PATHS) revalidatePath(p);
}

// Org configuration (pipeline shape, groups, templates, automation, org
// settings) is admin-only — team members and interviewers work candidates,
// they don't reshape the org.
async function requireAdmin() {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN')
    throw new Error('Admins only');
  return ctx;
}

export async function setOrgKindAction(kind: OrgKind) {
  const ctx = await requireAdmin();
  if (kind !== 'COMPANY' && kind !== 'AGENCY') return;
  await setOrgKind(ctx, kind);
  refresh();
}

/**
 * Finish (or skip) onboarding. A workspace coming from another ATS lands on
 * that provider's import form, where its stages come across next.
 */
export async function completeOnboardingAction(formData?: FormData) {
  const ctx = await requireAdmin();
  const org = await completeOnboarding(ctx);
  revalidateOrgNav(ctx.orgId);
  await writeOrgNavCookie({
    name: org.name,
    logoFileId: org.logoFileId,
    onboardedAt: org.onboardedAt,
  });
  const provider = providerMeta(String(formData?.get('provider') ?? ''));
  redirect(provider ? `/settings/import?provider=${provider.id}` : '/pipeline');
}

export type GroupsResult = { created: { id: string; name: string }[]; existing: number } | { error: string };

const MAX_SHEET_BYTES = 5 * 1024 * 1024;

function groupKind(kind: unknown): GroupKind {
  if (kind !== 'client' && kind !== 'department') throw new Error('Unknown group kind');
  return kind;
}

/** Departments or client companies typed or pasted into the form: one or many. */
export async function addGroupsAction(kind: GroupKind, names: string[]): Promise<GroupsResult> {
  const ctx = await requireAdmin();
  const clean = cleanNames(Array.isArray(names) ? names.map(String) : []);
  if (!clean.length) return { error: 'Type a name first.' };
  const result = await addGroups(ctx, groupKind(kind), clean);
  refresh();
  return result;
}

/** A spreadsheet of them: the first sheet's names column (see namesFromRows). */
export async function importGroupsAction(kind: GroupKind, formData: FormData): Promise<GroupsResult> {
  const ctx = await requireAdmin();
  const file = formData.get('file');
  if (!(file instanceof File) || !file.size) return { error: 'Choose a file to upload.' };
  if (file.size > MAX_SHEET_BYTES) return { error: 'That file is over 5 MB.' };
  let rows: string[][] | null = null;
  try {
    rows = readSpreadsheet(new Uint8Array(await file.arrayBuffer()));
  } catch {
    // A damaged or password-protected workbook reads as unreadable.
  }
  if (!rows) return { error: 'That file couldn’t be read. Upload a .csv or an Excel (.xlsx) file.' };
  const names = namesFromRows(rows);
  if (!names.length) return { error: 'No names found. Put them in the first column, or under a “Company” heading.' };
  const result = await addGroups(ctx, groupKind(kind), names);
  refresh();
  return result;
}

/** Undo for a bulk add. */
export async function removeGroupsAction(kind: GroupKind, ids: string[]) {
  const ctx = await requireAdmin();
  await removeGroups(ctx, groupKind(kind), Array.isArray(ids) ? ids.map(String) : []);
  refresh();
}

export async function removeGroupAction(kind: 'department' | 'client', id: string) {
  const ctx = await requireAdmin();
  if (kind === 'client') await removeClientCompany(ctx, id);
  else await removeDepartment(ctx, id);
  refresh();
}

export async function createStageAction(name: string, type: string): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { error: 'Type a name for the stage.' };
  if (!STAGE_TYPES.includes(type as never)) return { error: 'Pick what the stage counts as.' };
  try {
    await createStage(ctx, trimmed, type as StageType);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not add the stage' };
  }
  refresh();
  return {};
}

export async function renameStageAction(stageId: string, name: string): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { error: 'A stage needs a name.' };
  try {
    await renameStage(ctx, stageId, trimmed);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not rename the stage' };
  }
  refresh();
  return {};
}

/** The whole pipeline in its new order, after a drag in the stage editor. */
export async function reorderStagesAction(ids: string[]): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  try {
    await setStageOrder(ctx, Array.isArray(ids) ? ids.map(String) : []);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not reorder the stages' };
  }
  refresh();
  return {};
}

const ROLE_VALUES = ['ADMIN', 'TEAM_MEMBER', 'LIMITED_TEAM_MEMBER', 'INTERVIEWER'] as const;
const FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SELECT'] as const;

export async function createCustomFieldAction(
  label: string,
  type: string,
  optionsRaw: string,
): Promise<{ error?: string }> {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN')
    return { error: 'Admins only.' };
  const clean = label.trim();
  if (!clean) return { error: 'Label is required.' };
  if (!FIELD_TYPES.includes(type as never)) return { error: 'Invalid type.' };
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!key) return { error: 'Label must contain letters or numbers.' };
  const options =
    type === 'SELECT'
      ? optionsRaw.split(',').map((o) => o.trim()).filter(Boolean).slice(0, 20)
      : [];
  if (type === 'SELECT' && options.length < 2)
    return { error: 'Dropdowns need at least two options.' };
  try {
    await db.customFieldDef.create({
      data: {
        orgId: ctx.orgId,
        key,
        label: clean,
        type: type as (typeof FIELD_TYPES)[number],
        options,
      },
    });
  } catch {
    return { error: 'A field with this name already exists.' };
  }
  revalidatePath('/settings');
  return {};
}

export async function deleteCustomFieldAction(defId: string) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') return;
  await db.customFieldDef.deleteMany({ where: { id: defId, orgId: ctx.orgId } });
  revalidatePath('/settings');
}

export async function setCollectEeoAction(enabled: boolean) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') return;
  await db.organization.update({ where: { id: ctx.orgId }, data: { collectEeo: enabled } });
  // No revalidatePath here: callers router.refresh() after the action
  // resolves. revalidatePath inside the action trips a Next 15 regression
  // (vercel/next.js#82289) that aborts the response stream and leaves
  // useTransition pending forever.
}

export async function inviteUserAction(
  name: string,
  email: string,
  role: string,
): Promise<{ tempPassword?: string; error?: string }> {
  const ctx = await requireSession();
  if (!ROLE_VALUES.includes(role as never)) return { error: 'Invalid role' };
  try {
    const { tempPassword } = await inviteUser(ctx, {
      name,
      email,
      accessRole: role as AccessRole,
    });
    revalidatePath('/settings');
    return { tempPassword };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Failed' };
  }
}

export async function setUserRoleAction(userId: string, role: string) {
  const ctx = await requireSession();
  if (!ROLE_VALUES.includes(role as never)) return;
  await setUserRole(ctx, userId, role as AccessRole);
  revalidatePath('/settings');
}

export async function setUserActiveAction(userId: string, active: boolean) {
  const ctx = await requireSession();
  await setUserActive(ctx, userId, active);
  revalidatePath('/settings');
}

export async function saveRetentionAction(formData: FormData) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') return;
  const raw = String(formData.get('retentionMonths') ?? '').trim();
  const months = raw ? Number.parseInt(raw, 10) : null;
  await db.organization.update({
    where: { id: ctx.orgId },
    data: { retentionMonths: months && Number.isFinite(months) && months > 0 ? months : null },
  });
  revalidatePath('/settings');
}

export async function setFeedbackVisibilityAction(enabled: boolean) {
  const ctx = await requireAdmin();
  await db.organization.update({
    where: { id: ctx.orgId },
    data: { hideFeedbackUntilSubmitted: enabled },
  });
  // Callers router.refresh() — see setCollectEeoAction for why.
}

export async function setTalentNetworkAction(enabled: boolean) {
  const ctx = await requireAdmin();
  await db.organization.update({
    where: { id: ctx.orgId },
    data: { talentNetworkEnabled: enabled },
  });
  // Callers router.refresh() — see setCollectEeoAction for why.
}

export async function saveTemplateAction(formData: FormData) {
  const ctx = await requireAdmin();
  const templateId = String(formData.get('templateId') ?? '');
  const input = {
    name: String(formData.get('name') ?? '').trim(),
    subject: String(formData.get('subject') ?? '').trim(),
    body: String(formData.get('body') ?? '').trim(),
  };
  if (!input.name || !input.subject || !input.body) return;
  if (templateId) await updateTemplate(ctx, templateId, input);
  else await createTemplate(ctx, input);
  revalidatePath('/settings');
}

export async function deleteTemplateAction(templateId: string) {
  const ctx = await requireAdmin();
  await deleteTemplate(ctx, templateId);
  revalidatePath('/settings');
}

export async function saveAutomationAction(formData: FormData) {
  const ctx = await requireAdmin();
  const delay = Number.parseInt(String(formData.get('autoRejectDelayHours') ?? '48'), 10);
  await updateEmailAutomation(ctx, {
    autoConfirmTemplateId: String(formData.get('autoConfirmTemplateId') ?? '') || null,
    autoRejectTemplateId: String(formData.get('autoRejectTemplateId') ?? '') || null,
    autoInterviewTemplateId: String(formData.get('autoInterviewTemplateId') ?? '') || null,
    autoRejectDelayHours: Number.isFinite(delay) ? delay : 48,
  });
  revalidatePath('/settings');
}

export async function createApiKeyAction(name: string): Promise<{ plaintext?: string; error?: string }> {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN')
    return { error: 'Admins only.' };
  const { plaintext } = await createApiKey(ctx, name);
  revalidatePath('/settings');
  return { plaintext };
}

export async function revokeApiKeyAction(keyId: string) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') return;
  await revokeApiKey(ctx, keyId);
  revalidatePath('/settings');
}

export async function createWebhookAction(
  url: string,
  typesRaw: string,
): Promise<{ secret?: string; error?: string }> {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN')
    return { error: 'Admins only.' };
  const eventTypes = typesRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  try {
    const { secret } = await createWebhookEndpoint(ctx, url, eventTypes);
    revalidatePath('/settings');
    return { secret };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Failed' };
  }
}

export async function setWebhookActiveAction(endpointId: string, active: boolean) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') return;
  await setWebhookActive(ctx, endpointId, active);
  revalidatePath('/settings');
}

export async function deleteWebhookAction(endpointId: string) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') return;
  await deleteWebhookEndpoint(ctx, endpointId);
  revalidatePath('/settings');
}

export async function deleteStageAction(stageId: string): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  try {
    await deleteStage(ctx, stageId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not delete stage' };
  }
  refresh();
  return {};
}

const LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const LOGO_MAX_BYTES = 1_000_000;

async function storeLogo(orgId: string, file: File) {
  if (!LOGO_MIMES.has(file.type)) throw new Error('Logo must be a PNG, JPEG, SVG, or WebP.');
  if (file.size > LOGO_MAX_BYTES) throw new Error('Logo must be under 1 MB.');
  return storeFile({
    orgId,
    filename: file.name || 'logo',
    mime: file.type,
    data: Buffer.from(await file.arrayBuffer()),
  });
}

export async function uploadOrgLogoAction(formData: FormData) {
  const ctx = await requireAdmin();
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) return;
  const stored = await storeLogo(ctx.orgId, file);
  const org = await db.organization.update({
    where: { id: ctx.orgId },
    data: { logoFileId: stored.id },
    select: { name: true, logoFileId: true, onboardedAt: true },
  });
  revalidateOrgNav(ctx.orgId);
  await writeOrgNavCookie(org);
  revalidatePath('/settings');
}

export async function removeOrgLogoAction() {
  const ctx = await requireAdmin();
  const org = await db.organization.update({
    where: { id: ctx.orgId },
    data: { logoFileId: null },
    select: { name: true, logoFileId: true, onboardedAt: true },
  });
  revalidateOrgNav(ctx.orgId);
  await writeOrgNavCookie(org);
  revalidatePath('/settings');
}

/** The brand kit (lib/brand.ts): saved as given, less anything it doesn't recognize. */
export async function saveBrandKitAction(input: unknown) {
  const ctx = await requireAdmin();
  const brand = readBrand(input);
  const org = await db.organization.update({
    where: { id: ctx.orgId },
    data: { brand: isDefaultBrand(brand) ? Prisma.DbNull : brand },
    select: { slug: true },
  });
  revalidatePath('/settings');
  revalidatePath(`/careers/${org.slug}`, 'layout');
}

export async function uploadPostingLogoAction(postingId: string, formData: FormData) {
  const ctx = await requireSession();
  const posting = await db.posting.findFirst({ where: { id: postingId, orgId: ctx.orgId } });
  if (!posting) throw new Error('Posting not found.');
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) return;
  const stored = await storeLogo(ctx.orgId, file);
  await db.posting.update({ where: { id: posting.id }, data: { logoFileId: stored.id } });
  revalidatePath(`/postings/${posting.id}`);
}

export async function removePostingLogoAction(postingId: string) {
  const ctx = await requireSession();
  const posting = await db.posting.findFirst({ where: { id: postingId, orgId: ctx.orgId } });
  if (!posting) throw new Error('Posting not found.');
  await db.posting.update({ where: { id: posting.id }, data: { logoFileId: null } });
  revalidatePath(`/postings/${posting.id}`);
}

export async function setRequirePostingApprovalAction(enabled: boolean) {
  const ctx = await requireAdmin();
  await db.organization.update({
    where: { id: ctx.orgId },
    data: { requirePostingApproval: enabled },
  });
}

export async function setRequireOfferApprovalAction(enabled: boolean) {
  const ctx = await requireAdmin();
  await db.organization.update({
    where: { id: ctx.orgId },
    data: { requireOfferApproval: enabled },
  });
}

export async function setAutoScheduleOnInterviewStagesAction(enabled: boolean) {
  const ctx = await requireAdmin();
  await db.organization.update({
    where: { id: ctx.orgId },
    data: { autoScheduleOnInterviewStages: enabled },
  });
}

export async function createReportScheduleAction(formData: FormData) {
  const ctx = await requireAdmin();
  const cadence = String(formData.get('cadence') ?? 'WEEKLY') === 'DAILY' ? 'DAILY' : 'WEEKLY';
  const recipients = String(formData.get('recipients') ?? '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, 20);
  if (!recipients.length) return;
  await db.reportSchedule.create({
    data: { orgId: ctx.orgId, cadence, recipients, createdById: ctx.userId },
  });
  revalidatePath('/reports');
}

export async function deleteReportScheduleAction(scheduleId: string) {
  const ctx = await requireAdmin();
  await db.reportSchedule.deleteMany({ where: { id: scheduleId, orgId: ctx.orgId } });
  revalidatePath('/reports');
}

export async function addScorecardQuestionAction(formData: FormData) {
  const ctx = await requireAdmin();
  const label = String(formData.get('label') ?? '').trim().slice(0, 200);
  const kind = String(formData.get('kind') ?? 'RATING') === 'TEXT' ? 'TEXT' : 'RATING';
  if (!label) return;
  const last = await db.scorecardQuestion.findFirst({
    where: { orgId: ctx.orgId },
    orderBy: { order: 'desc' },
  });
  await db.scorecardQuestion.create({
    data: { orgId: ctx.orgId, label, kind, order: (last?.order ?? -1) + 1 },
  });
  revalidatePath('/settings');
}

export async function archiveScorecardQuestionAction(questionId: string) {
  const ctx = await requireAdmin();
  await db.scorecardQuestion.updateMany({
    where: { id: questionId, orgId: ctx.orgId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  revalidatePath('/settings');
}
