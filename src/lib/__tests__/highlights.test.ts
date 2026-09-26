import { describe, expect, it } from 'vitest';
import { mergeHighlights, readHighlights, resumeHighlights } from '@/lib/highlights';
import type { ProfileJob } from '@/lib/resume-profile';

const job = (company: string, title: string, start: string, end: string): ProfileJob => ({ company, title, location: null, start, end });
const NOW = new Date('2026-09-25T12:00:00Z');

describe('resumeHighlights', () => {
  it('names a single promotion and a long stay', () => {
    expect(
      resumeHighlights(
        [job('Relay', 'Staff', '2023-01', 'present'), job('Relay', 'Senior', '2021-02', '2022-12'), job('Parcelwise', 'Senior', '2018-03', '2021-01')],
        NOW,
      ),
    ).toEqual([
      { kind: 'growth', text: 'Promoted at Relay' },
      { kind: 'tenure', text: '5 years at Relay' },
    ]);
  });

  it('counts promotions at one company, or across several', () => {
    const one = resumeHighlights([job('A', 'Lead', '2024', 'present'), job('A', 'Senior', '2022', '2023'), job('A', 'Designer', '2021', '2021')], NOW);
    expect(one[0]).toEqual({ kind: 'growth', text: 'Promoted twice at A' });
    const many = resumeHighlights([job('A', 'Lead', '2024', 'present'), job('A', 'Senior', '2023', '2023'), job('B', 'Senior', '2021', '2022'), job('B', 'Mid', '2020', '2020')], NOW);
    expect(many[0]).toEqual({ kind: 'growth', text: 'Promoted twice' });
  });

  it('says nothing it can’t count', () => {
    expect(resumeHighlights([job('A', 'Designer', '2025-01', 'present')], NOW)).toEqual([]);
  });
});

describe('evaluation highlights', () => {
  it('reads kinds defensively and caps the list', () => {
    expect(readHighlights([{ kind: 'launch', text: ' 0 to 1  launches ' }, { kind: 'vibes', text: 'Great' }, { text: '' }, 1, { kind: 'scale', text: 'x' }, { kind: 'craft', text: 'y' }])).toEqual([
      { kind: 'launch', text: '0 to 1 launches' },
      { kind: 'other', text: 'Great' },
      { kind: 'scale', text: 'x' },
    ]);
  });

  it('puts the resume first and never repeats a promotion', () => {
    expect(
      mergeHighlights(
        [{ kind: 'growth', text: 'Promoted at Relay' }],
        [
          { kind: 'other', text: 'Promoted quickly' },
          { kind: 'scale', text: 'Scaled 10k to 2M users' },
        ],
      ).map((h) => h.text),
    ).toEqual(['Promoted at Relay', 'Scaled 10k to 2M users']);
  });
});
