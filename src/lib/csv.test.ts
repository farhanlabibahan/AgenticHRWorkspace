import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/csv';

describe('parseCsv', () => {
  it('splits plain rows and cells', () => {
    expect(parseCsv('name,email\nAda,ada@x.com\n')).toEqual([
      ['name', 'email'],
      ['Ada', 'ada@x.com'],
    ]);
  });

  it('keeps commas, quotes, and newlines inside quoted cells', () => {
    const csv = 'name,headline\n"Lovelace, Ada","Says ""hi""\nthen leaves"\n';
    expect(parseCsv(csv)).toEqual([
      ['name', 'headline'],
      ['Lovelace, Ada', 'Says "hi"\nthen leaves'],
    ]);
  });

  it('handles CRLF line endings and a missing trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('drops fully empty lines but keeps empty cells', () => {
    expect(parseCsv('a,b,c\n\n1,,3\n\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });
});
