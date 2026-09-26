import { describe, expect, it } from 'vitest';
import {
  cleanCriteria,
  computeMatchScore,
  MAX_CRITERIA,
  orderResults,
  readCriterionResults,
  scoreTone,
  snapScore,
} from '@/lib/match-criteria';

describe('cleanCriteria', () => {
  it('trims, dedupes case-insensitively, drops blanks, keeps ids', () => {
    const out = cleanCriteria([
      { id: 'c1', label: '  Design   systems ', must: true },
      { id: 'c2', label: 'design systems' },
      { label: '' },
      'junk',
      { id: 'bad id!', label: 'SaaS', must: 'yes' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'c1', label: 'Design systems', must: true });
    expect(out[1].label).toBe('SaaS');
    expect(out[1].must).toBe(false);
    expect(out[1].id).toMatch(/^[a-z0-9]+$/);
  });

  it('caps the list and each label', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `Criterion ${i} ${'x'.repeat(100)}` }));
    const out = cleanCriteria(many);
    expect(out).toHaveLength(MAX_CRITERIA);
    expect(out[0].label.length).toBe(80);
    expect(cleanCriteria(null)).toEqual([]);
  });
});

describe('scores', () => {
  it('snaps to the five steps', () => {
    expect([snapScore(0), snapScore(12), snapScore(13), snapScore(70), snapScore(140), snapScore(-5)]).toEqual([0, 0, 25, 75, 100, 0]);
    expect(snapScore('80')).toBeNull();
  });

  it('weights must-haves double and counts unknown as zero', () => {
    expect(
      computeMatchScore([
        { must: true, score: 100 },
        { must: true, score: 100 },
        { must: false, score: 50 },
        { must: false, score: 100 },
        { must: false, score: null },
        { must: false, score: 100 },
      ]),
    ).toBe(81); // 650 / 8
    expect(computeMatchScore([])).toBeNull();
  });

  it('tones by score', () => {
    expect([scoreTone(100), scoreTone(75), scoreTone(50), scoreTone(25), scoreTone(null)]).toEqual([
      'positive',
      'positive',
      'caution',
      'critical',
      'neutral',
    ]);
  });

  it('reads stored results defensively, must-haves first when ordered', () => {
    const read = readCriterionResults([
      { id: 'a', label: 'Nice', must: false, score: 60, evidence: 'x' },
      { id: 'b', label: 'Must', must: true, score: null, evidence: '' },
      { id: 'c', label: '' },
      7,
    ]);
    expect(read).toEqual([
      { id: 'a', label: 'Nice', must: false, score: 50, evidence: 'x' },
      { id: 'b', label: 'Must', must: true, score: null, evidence: '' },
    ]);
    expect(orderResults(read).map((r) => r.id)).toEqual(['b', 'a']);
  });
});
