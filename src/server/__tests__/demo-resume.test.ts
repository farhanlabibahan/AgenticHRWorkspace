import { describe, expect, it } from 'vitest';
import { resumePdf } from '@/server/demo-resume';
import { extractText } from '@/server/text';

describe('resumePdf', () => {
  it('makes a PDF our own resume reader can read, dashes and all', async () => {
    const pdf = resumePdf(
      'Maya Chen',
      'maya.chen@example.com  ·  Brooklyn, NY',
      'Figment — Senior Product Designer, Mar 2022–now. Led the (onboarding) redesign.\n\nBFA, Pratt Institute.',
    );
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const result = await extractText({ data: new Uint8Array(pdf), source: 'import' });
    expect(result.status).toBe('OK');
    expect(result.text).toContain('Maya Chen');
    expect(result.text).toContain('Figment — Senior Product Designer, Mar 2022–now');
    expect(result.text).toContain('(onboarding)');
  });
});
