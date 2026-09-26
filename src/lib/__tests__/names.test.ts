import { describe, expect, it } from 'vitest';
import { cleanNames, MAX_NAME_LENGTH, MAX_NAMES, namesFromRows, splitNames } from '@/lib/names';

describe('splitNames', () => {
  it('takes one name as typed', () => {
    expect(splitNames('  Acme Corp ')).toEqual(['Acme Corp']);
  });

  it('splits a typed list on commas, keeping legal suffixes with their company', () => {
    expect(splitNames('Acme, Inc., Globex, Initech LLC, Umbrella, Ltd., Stark, S.A.')).toEqual([
      'Acme, Inc.',
      'Globex',
      'Initech LLC',
      'Umbrella, Ltd.',
      'Stark, S.A.',
    ]);
  });

  it('splits on semicolons when there are any, so commas inside names survive', () => {
    expect(splitNames('Smith, Jones & Partners; Acme; Globex')).toEqual(['Smith, Jones & Partners', 'Acme', 'Globex']);
  });

  it('takes a column pasted from a spreadsheet, header and blank rows dropped', () => {
    expect(splitNames('Company name\r\nAcme, Inc.\r\n\r\nGlobex\r\n')).toEqual(['Acme, Inc.', 'Globex']);
  });

  it('takes the name column of a pasted table, and every cell of a pasted row', () => {
    expect(splitNames('1\tAcme\tRowan\n2\tGlobex\tRowan')).toEqual(['Acme', 'Globex']);
    expect(splitNames('Acme\tGlobex\tInitech')).toEqual(['Acme', 'Globex', 'Initech']);
  });

  it('drops duplicates ignoring case, quotes, and cells with no letters', () => {
    expect(splitNames('"Acme", acme, ACME, 42, —, Zoë Studio')).toEqual(['Acme', 'Zoë Studio']);
  });
});

describe('namesFromRows', () => {
  it('uses the column under a recognised heading', () => {
    expect(namesFromRows([['#', 'Client name', 'Owner'], ['1', 'Acme', 'Rowan'], ['2', 'Globex', 'Rowan']])).toEqual([
      'Acme',
      'Globex',
    ]);
  });

  it('otherwise takes the first column with words in it', () => {
    expect(namesFromRows([['1', 'Acme'], ['2', 'Globex'], ['', '']])).toEqual(['Acme', 'Globex']);
  });
});

describe('cleanNames', () => {
  it('clips long names and caps the list', () => {
    expect(cleanNames(['x'.repeat(MAX_NAME_LENGTH + 50)])[0]).toHaveLength(MAX_NAME_LENGTH);
    expect(cleanNames(Array.from({ length: MAX_NAMES + 10 }, (_, i) => `Client ${i}`))).toHaveLength(MAX_NAMES);
  });
});
