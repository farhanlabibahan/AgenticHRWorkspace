import { describe, expect, it } from 'vitest';
import { fetchLinkPreview, isPublicAddress, parsePreview } from '@/server/link-preview';
import { CaseStudyError, normalizeWorkUrl, titleFromUrl } from '@/server/case-studies';

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local, metadata and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '151.101.1.1', '2606:4700::6810:85e5', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    expect(isPublicAddress('not an ip')).toBe(false);
  });
});

describe('fetchLinkPreview', () => {
  it('never fetches a private or non-web address', async () => {
    const empty = { title: null, description: null, image: null, siteName: null };
    expect(await fetchLinkPreview('http://127.0.0.1/admin')).toEqual(empty);
    expect(await fetchLinkPreview('http://169.254.169.254/latest/meta-data')).toEqual(empty);
    expect(await fetchLinkPreview('http://[::1]:8080/')).toEqual(empty);
    expect(await fetchLinkPreview('file:///etc/passwd')).toEqual(empty);
    expect(await fetchLinkPreview('https://user:pass@example.com/')).toEqual(empty);
    expect(await fetchLinkPreview('not a url')).toEqual(empty);
  });
});

describe('parsePreview', () => {
  const base = new URL('https://jordan.design/work/pipeline');
  it('reads og tags first, resolves the image against the page, and decodes entities', () => {
    const html = `<html><head>
      <title>Ignored when og:title exists</title>
      <meta property="og:title" content="The pipeline, rebuilt &amp; tested">
      <meta content="Stage aging, in three rounds" property="og:description" />
      <meta property="og:image" content="/img/cover.png">
      <meta name="twitter:image" content="https://cdn.example/other.png">
      <meta property="og:site_name" content='Jordan Alvarez'>
    </head><body><meta property="og:title" content="not in the head"></body></html>`;
    expect(parsePreview(html, base)).toEqual({
      title: 'The pipeline, rebuilt & tested',
      description: 'Stage aging, in three rounds',
      image: 'https://jordan.design/img/cover.png',
      siteName: 'Jordan Alvarez',
    });
  });

  it('falls back to twitter tags and the <title>, and drops non-web images', () => {
    expect(
      parsePreview('<head><title> Case study &#8212; Tokens </title><meta name="twitter:image" content="javascript:alert(1)"></head>', base),
    ).toEqual({ title: 'Case study — Tokens', description: null, image: null, siteName: null });
  });
});

describe('case study links', () => {
  it('normalizes what people paste', () => {
    expect(normalizeWorkUrl(' jordan.design/work#top ')).toBe('https://jordan.design/work');
    expect(() => normalizeWorkUrl('ftp://files.example.com/x')).toThrow(CaseStudyError);
    expect(() => normalizeWorkUrl('localhost')).toThrow(CaseStudyError);
  });

  it('titles a page from its path when it has no title of its own', () => {
    expect(titleFromUrl('https://jordan.design/work/pipeline-redesign')).toBe('Pipeline redesign');
    expect(titleFromUrl('https://www.behance.net/')).toBe('behance.net');
    expect(titleFromUrl('https://dribbble.com/shots/12345')).toBe('dribbble.com');
  });
});
