import { describe, expect, it } from 'vitest';
import { CredentialsUnavailableError, openCredentials, sealCredentials } from '@/server/imports/crypto';
import {
  catalogWriter,
  defaultMapping,
  emptyCatalog,
  externalSlug,
  inferStageType,
  orderNewStages,
} from '@/server/imports/mapping';
import { htmlToText, toDate, cleanEmails } from '@/server/imports/text';

describe('credential sealing', () => {
  it('round-trips and never stores plaintext', () => {
    process.env.AUTH_SECRET ||= 'test-secret';
    const sealed = sealCredentials({ apiKey: 'sk_live_supersecret', subdomain: 'acme' });
    expect(sealed).not.toContain('supersecret');
    expect(openCredentials(sealed)).toEqual({ apiKey: 'sk_live_supersecret', subdomain: 'acme' });
  });

  it('rejects tampered or missing ciphertext', () => {
    const sealed = sealCredentials({ apiKey: 'x' });
    const parts = sealed.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
    expect(() => openCredentials(parts.join('.'))).toThrow(CredentialsUnavailableError);
    expect(() => openCredentials(null)).toThrow(CredentialsUnavailableError);
  });
});

describe('text helpers', () => {
  it('turns vendor HTML into readable text', () => {
    const html =
      '<h2>About</h2><p>We build&nbsp;tools &amp; things.</p><ul><li>TypeScript</li><li>Postgres</li></ul>' +
      '<p>Apply <a href="https://acme.test/jobs">here</a><br>Thanks</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('About\n\nWe build tools & things.\n\n• TypeScript\n• Postgres\n\nApply here (https://acme.test/jobs)\nThanks');
  });

  it('stays fast on hostile markup that would make a regex backtrack', () => {
    const hostile = [
      '<a href="x"'.repeat(20_000),
      '<a '.repeat(50_000),
      '<!--'.repeat(50_000),
      '<script>'.repeat(20_000),
      `<a href='${'"'.repeat(50_000)}`,
    ];
    for (const html of hostile) {
      const started = performance.now();
      htmlToText(html);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('keeps link targets, skips scripts and comments, and handles unquoted attributes', () => {
    expect(htmlToText('<p>See <a href=https://acme.test/x>the role</a><!-- hidden --></p><style>p{}</style>')).toBe(
      'See the role (https://acme.test/x)',
    );
    expect(htmlToText('<a href="mailto:jobs@acme.test">jobs@acme.test</a>')).toBe('jobs@acme.test');
    expect(htmlToText('1 < 2 and <b>bold</b>')).toBe('1 < 2 and bold');
  });

  it('parses epoch seconds, epoch ms, and ISO dates', () => {
    expect(toDate(1_700_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(toDate(1_700_000_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(toDate('2024-02-01T10:00:00Z')?.toISOString()).toBe('2024-02-01T10:00:00.000Z');
    expect(toDate('not a date')).toBeNull();
    expect(toDate(null)).toBeNull();
  });

  it('normalizes and dedupes emails', () => {
    expect(cleanEmails([' Jane@Acme.test', 'jane@acme.test', 'nope', null])).toEqual(['jane@acme.test']);
  });
});

describe('stage mapping', () => {
  it.each([
    ['Hired', 'HIRED'],
    ['Offer Extended', 'OFFER'],
    ['Reference Check', 'OFFER'],
    ['Hiring Manager Screen', 'SCREEN'],
    ['Onsite Interview', 'ONSITE'],
    ['Final Round', 'ONSITE'],
    ['New Lead', 'LEAD'],
    ['Application Review', 'APPLICANT'],
    ['Take-home exercise', 'SCREEN'],
  ])('infers %s → %s', (name, type) => {
    expect(inferStageType(name)).toBe(type);
  });

  it('groups per-job stages by name and averages their position', () => {
    const catalog = emptyCatalog();
    const w = catalogWriter(catalog);
    w.stage({ externalId: 'j1-s1', name: 'Phone Screen', position: 1 });
    w.stage({ externalId: 'j2-s1', name: 'phone  screen', position: 3 });
    w.stage({ externalId: 'j1-s1', name: 'Phone Screen', position: 1 }); // replayed step
    w.stage({ externalId: 'j1-s2', name: 'Offer', typeHint: 'OFFER', position: 4 });
    expect(catalog.stages).toHaveLength(2);
    expect(catalog.stages[0]).toMatchObject({ key: 'phone screen', externalIds: ['j1-s1', 'j2-s1'] });
    expect(catalog.stages[0].position).toBe(2); // replays don't count twice
  });

  it('defaults to a prior mapping, then a same-named stage, then creating one', () => {
    const catalog = emptyCatalog();
    const w = catalogWriter(catalog);
    w.stage({ externalId: 'a', name: 'Phone screen' });
    w.stage({ externalId: 'b', name: 'Tech Interview' });
    w.stage({ externalId: 'c', name: 'Culture Chat' });
    w.reason({ externalId: 'r1', name: 'Withdrew', kind: 'withdrawn' });
    w.reason({ externalId: 'r2', name: 'Not a fit', kind: 'rejection' });
    const m = defaultMapping(
      catalog,
      [{ id: 's-phone', name: 'Phone screen', type: 'SCREEN' }],
      [{ id: 'r-withdrew', name: 'withdrew' }],
      { stages: new Map([['c', 's-prior']]), reasons: new Map() },
    );
    expect(m.stages['phone screen']).toEqual({ stageId: 's-phone' });
    expect(m.stages['tech interview']).toEqual({ create: { name: 'Tech Interview', type: 'SCREEN' } });
    expect(m.stages['culture chat']).toEqual({ stageId: 's-prior' });
    expect(m.reasons['withdrew']).toEqual({ reasonId: 'r-withdrew' });
    expect(m.reasons['not a fit']).toEqual({ create: { name: 'Not a fit', countsAsRejection: true } });
  });

  it('suggests an existing stage or reason whose name differs only in punctuation, spacing, or accents', () => {
    const catalog = emptyCatalog();
    const w = catalogWriter(catalog);
    w.stage({ externalId: 'a', name: 'Onsite' });
    w.stage({ externalId: 'b', name: 'Phone-Screen' });
    w.reason({ externalId: 'r', name: 'Déclined offer', kind: 'withdrawn' });
    const m = defaultMapping(
      catalog,
      [
        { id: 's-onsite', name: 'On-site', type: 'ONSITE' },
        { id: 's-phone', name: 'Phone screen', type: 'SCREEN' },
      ],
      [{ id: 'r-declined', name: 'Declined Offer' }],
      { stages: new Map(), reasons: new Map() },
    );
    expect(m.stages['onsite']).toEqual({ stageId: 's-onsite' });
    expect(m.stages['phone-screen']).toEqual({ stageId: 's-phone' });
    expect(m.reasons['déclined offer']).toEqual({ reasonId: 'r-declined' });
  });

  it('orders new stages by pipeline type, then vendor position', () => {
    const ordered = orderNewStages([
      { name: 'Offer', type: 'OFFER' as const, position: 5 },
      { name: 'Tech', type: 'SCREEN' as const, position: 3 },
      { name: 'Recruiter', type: 'SCREEN' as const, position: 1 },
      { name: 'Sourced', type: 'LEAD' as const, position: null },
    ]);
    expect(ordered.map((s) => s.name)).toEqual(['Sourced', 'Recruiter', 'Tech', 'Offer']);
  });

  it('gives each vendor posting a stable, distinct slug', () => {
    expect(externalSlug('Senior Engineer', 'lever', 'abc')).toBe(externalSlug('Senior Engineer', 'lever', 'abc'));
    expect(externalSlug('Senior Engineer', 'lever', 'abc')).not.toBe(externalSlug('Senior Engineer', 'greenhouse', 'abc'));
    expect(externalSlug('Senior Engineer', 'lever', 'abc')).toMatch(/^senior-engineer-[0-9a-f]{6}$/);
  });
});
