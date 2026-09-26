import { describe, expect, it } from 'vitest';
import { MAX_LINKS, MAX_TEXT_CHARS, normalizeLinks, normalizeText } from '@/server/text/normalize';

describe('normalizeText', () => {
  it('composes to NFC', () => {
    expect(normalizeText('re\u0301sume\u0301')).toBe('r\u00e9sum\u00e9');
  });

  it('turns CRLF, CR, form feed, vertical tab and Unicode separators into LF', () => {
    expect(normalizeText('a\r\nb\rc\fd\ve\u2028f\u2029g')).toBe('a\nb\nc\nd\ne\nf\ng');
  });

  it('strips C0 controls and DEL but keeps newlines and tabs', () => {
    expect(normalizeText('a\u0000b\u0007c\u001bd\u007fe\tf\ng')).toBe('abcde\tf\ng');
  });

  it('drops unpaired surrogates and keeps pairs', () => {
    expect(normalizeText('x\ud800y\udc00z \ud83d\ude00')).toBe('xyz \ud83d\ude00');
  });

  it('spells out ligatures', () => {
    expect(normalizeText('\ufb01nance o\ufb03ce \ufb00 \ufb02 \ufb04 \ufb05 \ufb06')).toBe('finance office ff fl ffl st st');
  });

  it('turns NBSP and typographic spaces into plain spaces', () => {
    expect(normalizeText('a\u00a0b\u2009c\u202fd\u3000e\u2002f')).toBe('a b c d e f');
  });

  it('drops zero-width spaces and soft hyphens', () => {
    expect(normalizeText('a\u200bb\u2060c\ufeffd Soft\u00adware')).toBe('abcd Software');
  });

  it('keeps the zero-width joiner and non-joiner, which spell emoji and Persian or Indic words', () => {
    for (const text of ['👩\u200d💻 · 👨\u200d👩\u200d👧', 'نرم\u200cافزار · می\u200cخواهم', 'क्\u200dष']) expect(normalizeText(text)).toBe(text);
  });

  it('turns icon-font glyphs into spaces', () => {
    expect(normalizeText('\ueb1c rowan.testperson@example.test\nCall\ueb19+1 555 010 4477 \uf028\n\u{f0000}LinkedIn')).toBe(
      'rowan.testperson@example.test\nCall +1 555 010 4477\nLinkedIn',
    );
  });

  it('drops spaces at the start of a line but keeps tabs', () => {
    expect(normalizeText('Rowan\n   Staff engineer\n\tSkills')).toBe('Rowan\nStaff engineer\n\tSkills');
  });

  it('trims spaces and tabs at line ends and collapses runs of spaces, keeping tabs inside lines', () => {
    expect(normalizeText('Rowan  Q.   Testperson \t \nSkills:\t\tTypeScript')).toBe('Rowan Q. Testperson\nSkills:\t\tTypeScript');
  });

  it('collapses three or more newlines to one blank line, blank-looking lines included', () => {
    expect(normalizeText('a\n\n\n\nb\n \n\t\n\nc\n\nd')).toBe('a\n\nb\n\nc\n\nd');
  });

  it('trims the result', () => {
    expect(normalizeText(' \n\t Rowan \n\n ')).toBe('Rowan');
  });

  it('caps the length without splitting a surrogate pair', () => {
    expect(normalizeText('a'.repeat(MAX_TEXT_CHARS * 2))).toHaveLength(MAX_TEXT_CHARS);
    const straddling = 'a'.repeat(MAX_TEXT_CHARS - 1) + '\ud83d\ude00b';
    const capped = normalizeText(straddling)!;
    expect(capped).toHaveLength(MAX_TEXT_CHARS - 1);
    expect(capped.isWellFormed()).toBe(true);
  });

  it('takes linear time on a long run of tabs with no newline after it', () => {
    const started = performance.now();
    const tabs = 'a' + '\t'.repeat(50_000) + 'b';
    expect(normalizeText(tabs)).toBe(tabs);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('returns null when nothing readable is left', () => {
    expect(normalizeText('')).toBeNull();
    expect(normalizeText(' \n\t\r\n ')).toBeNull();
    expect(normalizeText('\u0000\u200b\ufeff\u00a0\f')).toBeNull();
  });
});

describe('normalizeLinks', () => {
  it('keeps web and mailto links, deduped and trimmed', () => {
    expect(
      normalizeLinks([
        ' https://linkedin.example.test/in/rowan ',
        'https://linkedin.example.test/in/rowan',
        'HTTP://rowan.example.test',
        'mailto:rowan.testperson@example.test',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'ftp://files.example.test',
        '/relative/path',
        'https://bad.example.test/a b',
        'https://bad.example.test/\u0000',
        'https://bad.example.test/\ud800',
        `https://long.example.test/${'x'.repeat(3000)}`,
      ]),
    ).toEqual(['https://linkedin.example.test/in/rowan', 'HTTP://rowan.example.test', 'mailto:rowan.testperson@example.test']);
  });

  it('keeps at most MAX_LINKS', () => {
    const links = Array.from({ length: 25 }, (_, i) => `https://example.test/${i}`);
    expect(normalizeLinks(links)).toEqual(links.slice(0, MAX_LINKS));
  });
});
