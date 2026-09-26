import { describe, expect, it } from 'vitest';
import { boardSearch, EMPTY_FILTERS, facetOptions, filterPostings, knownFilters, readBoardFilters, type BoardPosting } from '@/lib/job-board';

const P = (id: string, title: string, group: string, location: string | null, workplaceType: string, commitment: string): BoardPosting => ({
  id,
  slug: id,
  title,
  group,
  location,
  workplaceType,
  commitment,
});
const BOARD = [
  P('a', 'Senior Product Designer', 'Design', 'New York, NY', 'HYBRID', 'FULL_TIME'),
  P('b', 'Brand Designer', 'Design', 'Remote — US', 'REMOTE', 'CONTRACT'),
  P('c', 'Founding Engineer', 'Engineering', 'San Francisco, CA', 'ONSITE', 'FULL_TIME'),
  P('d', 'Staff Engineer, Platform', 'Engineering', 'Remote — US', 'REMOTE', 'FULL_TIME'),
  P('e', 'Data Engineer', 'Data', 'Zürich', 'HYBRID', 'FULL_TIME'),
];
const ids = (ps: BoardPosting[]) => ps.map((p) => p.id).join('');

describe('job board search', () => {
  it('matches every word, across title, team, location and kind of work, ignoring case and accents', () => {
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, q: 'designer' }))).toBe('ab');
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, q: 'engineer remote' }))).toBe('d');
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, q: 'contract' }))).toBe('b');
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, q: 'ZURICH' }))).toBe('e');
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, q: '   ' }))).toBe('abcde');
  });

  it('combines filters with the search', () => {
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, workplace: 'remote', type: 'full-time' }))).toBe('d');
    expect(ids(filterPostings(BOARD, { ...EMPTY_FILTERS, group: 'Design', q: 'senior' }))).toBe('a');
  });

  it('counts each facet against the other filters, and skips a facet with one value', () => {
    const f = { ...EMPTY_FILTERS, workplace: 'remote' };
    expect(facetOptions(BOARD, f, 'group')).toEqual([
      { value: 'Data', label: 'Data', count: 0 },
      { value: 'Design', label: 'Design', count: 1 },
      { value: 'Engineering', label: 'Engineering', count: 1 },
    ]);
    // the facet's own filter doesn't narrow its own counts
    expect(facetOptions(BOARD, f, 'workplace').map((o) => `${o.label}:${o.count}`)).toEqual(['Hybrid:2', 'On-site:1', 'Remote:2']);
    expect(facetOptions(BOARD.slice(0, 1), EMPTY_FILTERS, 'group')).toEqual([]);
  });

  it('round-trips through the URL, leaving empty filters out', () => {
    const f = { ...EMPTY_FILTERS, q: ' staff ', group: 'Engineering', workplace: 'remote' };
    const search = boardSearch(f, 'team');
    expect(search).toBe('?q=staff&team=Engineering&workplace=remote');
    expect(readBoardFilters(Object.fromEntries(new URLSearchParams(search)), 'team')).toEqual({ ...f, q: 'staff' });
    expect(boardSearch(EMPTY_FILTERS, 'client')).toBe('');
    expect(readBoardFilters({ client: ['Harbor', 'x'] }, 'client').group).toBe('Harbor');
  });

  it("drops a link's filter values the board doesn't have", () => {
    expect(knownFilters(BOARD, { ...EMPTY_FILTERS, q: 'x', group: 'Sales', workplace: 'remote', type: 'seasonal' })).toEqual({
      ...EMPTY_FILTERS,
      q: 'x',
      workplace: 'remote',
    });
  });
});
