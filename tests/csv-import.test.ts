import { beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { db } from '@/lib/db';
import { importContactRows, importContactsCsv } from '@/server/contacts';
import type { SessionContext } from '@/lib/session';

const HEADER = ['Name', 'Email', 'Phone', 'Headline', 'Location', 'Tags'];

describe.skipIf(!hasDb)('CSV contact import', () => {
  let ctx: SessionContext;

  beforeAll(async () => {
    const { org, admin } = await createOrg();
    ctx = { orgId: org.id, userId: admin.id, accessRole: 'SUPER_ADMIN' };
    await db.contact.create({ data: { orgId: org.id, name: 'Existing', emails: ['taken@x.com'] } });
  });

  it('creates contacts, skips known and repeated emails, and reports nameless rows by file line', async () => {
    const rows = [
      ['Ada', 'ADA@x.com', '555', 'Engineer, "Platform"', 'Austin, TX', 'a; b'],
      ['Dupe of existing', 'Taken@X.com', '', '', '', ''],
      ['Ada again', 'ada@x.com', '', '', '', ''], // same email later in the file
      ['', 'nobody@x.com', '', '', '', ''],
      ['', '', '', '', '', ''], // blank line: no error
      ['No email', '', '', '', '', ''],
    ];
    const result = await importContactRows(ctx, HEADER, rows, 2);
    expect(result).toEqual({ created: 2, skipped: 2, errors: ['Row 5: missing name.'] });

    const ada = await db.contact.findFirstOrThrow({ where: { orgId: ctx.orgId, name: 'Ada' } });
    expect(ada).toMatchObject({
      emails: ['ada@x.com'],
      phones: ['555'],
      headline: 'Engineer, "Platform"',
      location: 'Austin, TX',
      tags: ['a', 'b'],
    });
    const events = await db.event.count({
      where: { orgId: ctx.orgId, verb: 'contact.created', payload: { path: ['via'], equals: 'csv_import' } },
    });
    expect(events).toBe(2);
  });

  it('dedupes across batches: a later batch sees emails an earlier batch created', async () => {
    const first = await importContactRows(ctx, ['name', 'email'], [['Grace', 'grace@x.com']], 2);
    const second = await importContactRows(ctx, ['name', 'email'], [['Grace dup', 'GRACE@x.com']], 3);
    expect([first.created, second.skipped]).toEqual([1, 1]);
  });

  it('rejects a file without a name column and imports nothing', async () => {
    const before = await db.contact.count({ where: { orgId: ctx.orgId } });
    const result = await importContactsCsv(ctx, 'email\nsomeone@x.com\n');
    expect(result.errors).toEqual(['Missing required "name" column.']);
    expect(await db.contact.count({ where: { orgId: ctx.orgId } })).toBe(before);
  });

  it('imports a whole file in batches through importContactsCsv', async () => {
    const lines = ['name,email', ...Array.from({ length: 2_500 }, (_, i) => `Bulk ${i},bulk${i}@x.com`)];
    const result = await importContactsCsv(ctx, lines.join('\n'));
    expect(result).toEqual({ created: 2_500, skipped: 0, errors: [] });
  });
});
