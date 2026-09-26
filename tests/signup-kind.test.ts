import { describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { db } from '@/lib/db';
import { signupHref } from '@/lib/signup-kind';
import { createWorkspace } from '@/server/workspace';

/** "Get started" on /agencies signs up a staffing agency; everywhere else, a company. */

describe('signupHref', () => {
  it('asks for an agency only from the agency page', () => {
    expect(signupHref(true)).toBe('/signup?kind=agency');
    expect(signupHref(false)).toBe('/signup');
  });
});

describe.skipIf(!hasDb)('createWorkspace kind', () => {
  it('creates an agency when asked, and a company by default', async () => {
    const stamp = Date.now();
    const agency = await createWorkspace({ orgName: 'Harbor Search', name: 'A', email: `agency-${stamp}@example.com`, passwordHash: null, kind: 'AGENCY' });
    const company = await createWorkspace({ orgName: 'Plain Co', name: 'B', email: `company-${stamp}@example.com`, passwordHash: null });
    expect((await db.organization.findUniqueOrThrow({ where: { id: agency.orgId } })).kind).toBe('AGENCY');
    expect((await db.organization.findUniqueOrThrow({ where: { id: company.orgId } })).kind).toBe('COMPANY');
  });
});
