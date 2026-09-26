import { describe, expect, it } from 'vitest';
import { extractSignals } from '@/server/resume';

const phones = (text: string) => extractSignals(text).phones;

describe('extractSignals', () => {
  it('finds phone numbers in common formats', () => {
    for (const phone of ['+44 20 7946 0958', '(415) 555-0100', '415.555.0100', '+1-415-555-0100', '020 7946 0958']) {
      expect(phones(`Rowan Q. Testperson · ${phone} · rowan@example.test`), phone).toEqual([phone]);
    }
  });

  it('does not take year ranges or dates for phone numbers', () => {
    for (const text of [
      'Fictional Widgets Inc. 2016 - 2021',
      'GPA 3.9 (2012 - 2016)',
      'Imaginary Analytics 2019–2023',
      'Engineer, 2019-2023',
      '01.2016 - 03.2021',
      'Started 2016-01-15',
      'Started 15.01.2016',
    ]) {
      expect(phones(text), text).toEqual([]);
    }
  });

  it('wants 7 to 15 digits', () => {
    expect(phones('Room 555-01')).toEqual([]);
    expect(phones('555-0100 x')).toEqual(['555-0100']);
    expect(phones('ID 1234 5678 9012 3456')).toEqual([]);
  });

  it('does not take figures, IDs or digits inside a URL for phone numbers', () => {
    for (const text of [
      'Grew revenue to 1.500.000 EUR',
      'Managed a budget of 1 200 000 €',
      'Served 12 000 000 monthly users',
      'Ran the 192.168.100.200 lab network',
      'Student ID 20191234',
      'Publication: https://doi.org/10.5555/jcd.2024.1000',
    ]) {
      expect(phones(text), text).toEqual([]);
    }
  });

  it('still finds international and local formats', () => {
    for (const phone of ['+33 1 55 55 01 02', '07700 900123', '+49 (0)30 1234 5678', '(03) 9876 5432', '+7 495 555-01-77', '612 345 678', '+4155550100', '4155550100']) {
      expect(phones(`Phone: ${phone}`), phone).toEqual([phone]);
    }
  });

  it('keeps phones next to a year range', () => {
    expect(phones('2016 - 2021 · Phone: +1 415 555 0100')).toEqual(['+1 415 555 0100']);
  });

  it('merges the document’s own link targets that are profiles', () => {
    const signals = extractSignals('Rowan Q. Testperson\nPortfolio: https://rowan.example.test\nLinkedIn\nSenior Engineer, Stripe', [
      'https://www.linkedin.com/in/rowan',
      'https://rowan.example.test',
      'https://stripe.com/',
      'mailto:Rowan.Testperson@Example.test?subject=Hello',
    ]);
    expect(signals.links).toEqual(['https://rowan.example.test', 'https://www.linkedin.com/in/rowan']);
  });

  it('tells a target written into the text by a Word-family reader from a URL the resume shows', () => {
    const text = 'Senior Engineer, Stripe (https://stripe.com/)\nWebsite (https://rowan.example.test)\nhttps://jamie.example.test';
    const links = ['https://stripe.com/', 'https://rowan.example.test'];
    // Word, ODT, RTF, HTML: both parentheses are hidden targets, only the bare URL is shown.
    expect(extractSignals(text, links, { targetsInText: true }).links).toEqual(['https://jamie.example.test']);
    // A PDF's targets stay out of its text, so a URL in parentheses there is one the resume shows.
    expect(extractSignals(text, links).links).toEqual(['https://stripe.com/', 'https://rowan.example.test', 'https://jamie.example.test']);
  });

  it.each([
    ['https://www.linkedin.com/in/rowan', true],
    ['https://uk.linkedin.com/in/rowan', true],
    ['https://github.com/rowan', true],
    ['https://rowan.github.io/', true],
    ['https://medium.com/@rowan', true],
    ['https://orcid.org/0000-0002-1825-0097', true],
    ['https://github.com/', false],
    ['https://www.linkedin.com/company/stripe', false],
    ['https://stripe.com/', false],
    ['https://www.mit.edu/', false],
  ])('counts %s as a profile: %s', (url, profile) => {
    expect(extractSignals('', [url]).links).toEqual(profile ? [url] : []);
  });

  it('keeps one form of a link written with and without a trailing slash, or in another case', () => {
    const signals = extractSignals('Portfolio: https://rowan.example.test. Code: https://GitHub.com/rowan', [
      'https://rowan.example.test/',
      'https://github.com/rowan/',
      'https://github.com/Rowan',
    ]);
    expect(signals.links).toEqual(['https://rowan.example.test', 'https://GitHub.com/rowan', 'https://github.com/Rowan']);
  });

  it('takes linear time on long runs of dots and slashes in a URL', () => {
    const started = performance.now();
    expect(extractSignals(`https://x${'.'.repeat(50_000)}a https://y${'/'.repeat(50_000)}b`).links).toHaveLength(2);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('caps links at 10 and phones at 3', () => {
    const links = Array.from({ length: 15 }, (_, i) => `https://github.com/rowan-${i}`);
    const signals = extractSignals(Array.from({ length: 5 }, (_, i) => `+1 415 555 010${i}`).join('\n'), links);
    expect(signals.links).toEqual(links.slice(0, 10));
    expect(signals.phones).toEqual(['+1 415 555 0100', '+1 415 555 0101', '+1 415 555 0102']);
  });
});
