import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatSpan,
  groupByCompany,
  readResumeView,
  yearsOfExperience,
  type ProfileJob,
} from '@/lib/resume-profile';

const job = (company: string, title: string, start: string | null, end: string | null): ProfileJob => ({
  company,
  title,
  location: null,
  start,
  end,
});
const NOW = new Date('2026-09-25T12:00:00Z');

describe('readResumeView', () => {
  it('is null for nothing, junk, or an empty profile', () => {
    expect(readResumeView(null)).toBeNull();
    expect(readResumeView('text')).toBeNull();
    expect(readResumeView({ summary: '  ', skills: [], experience: [], education: [] })).toBeNull();
  });

  it('keeps what it can read and drops the rest', () => {
    const view = readResumeView({
      summary: ' Builds things. ',
      skills: ['Figma', 'Figma', '', 7, 'React'],
      experience: [{ title: 'Designer', company: 'Acme', start: '2020-01', end: 'present' }, { title: null, company: null }, 'junk'],
      education: [{ school: 'Pratt', degree: 'BFA' }],
    });
    expect(view).toEqual({
      summary: 'Builds things.',
      skills: ['Figma', 'React'],
      experience: [{ title: 'Designer', company: 'Acme', location: null, start: '2020-01', end: 'present' }],
      education: [{ school: 'Pratt', degree: 'BFA', field: null, start: null, end: null }],
    });
  });
});

describe('dates', () => {
  it('formats spans', () => {
    expect(formatSpan('2019-04', 'present')).toBe('Apr 2019 – Present');
    expect(formatSpan('2017', '2019')).toBe('2017 – 2019');
    expect(formatSpan(null, '2019-06')).toBe('Jun 2019');
    expect(formatSpan(null, null)).toBeNull();
  });

  it('gives month precision only when both ends have months', () => {
    expect(formatDuration('2019-06', '2022-02', NOW)).toBe('2 yrs 9 mos');
    expect(formatDuration('2022-03', 'present', NOW)).toBe('4 yrs 7 mos');
    expect(formatDuration('2025-12', 'present', NOW)).toBe('10 mos');
    expect(formatDuration('2016', '2017', NOW)).toBe('2 yrs');
    expect(formatDuration('2017', '2017', NOW)).toBe('1 yr');
    expect(formatDuration('2020-05', '2019-01', NOW)).toBeNull();
    expect(formatDuration(null, 'present', NOW)).toBeNull();
  });

  it('counts overlapping jobs once toward years of experience', () => {
    const jobs = [job('A', 'x', '2020-01', 'present'), job('B', 'side project', '2021-01', '2022-12'), job('C', 'y', '2015-01', '2016-12')];
    // 2020-01..2026-09 is 81 months, plus 24: 105 months.
    expect(yearsOfExperience(jobs, NOW)).toBe(8);
    expect(yearsOfExperience([job('A', 'x', null, 'present')], NOW)).toBeNull();
  });
});

describe('groupByCompany', () => {
  it('folds consecutive roles at one company into a stint, like a promotion', () => {
    const stints = groupByCompany([
      job('Relay', 'Staff Engineer', '2023-01', 'present'),
      job('relay ', 'Senior Engineer', '2021-02', '2022-12'),
      job('Parcelwise', 'Senior Engineer', '2018-03', '2021-01'),
      job('Relay', 'Intern', '2015-06', '2015-08'),
    ]);
    expect(stints.map((s) => [s.company, s.roles.length, s.start, s.end])).toEqual([
      ['Relay', 2, '2021-02', 'present'],
      ['Parcelwise', 1, '2018-03', '2021-01'],
      // Not consecutive: a return to a company is its own stint.
      ['Relay', 1, '2015-06', '2015-08'],
    ]);
  });
});
