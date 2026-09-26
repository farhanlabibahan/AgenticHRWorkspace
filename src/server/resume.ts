/**
 * Resume limits and contact-signal parsing. Text extraction itself lives in
 * src/server/text (extractText).
 */

export const MAX_RESUME_BYTES = 5 * 1024 * 1024; // 5 MB

const WEB_URL = /https?:\/\/[^\s)>\]]+/g;

// A run of digits and phone punctuation, not glued to a word on either side.
const PHONE_CANDIDATE = /(?<!\w)\+?\(?\d[\d ().-]{5,25}\d(?!\w)/g;
const YEAR = /^(?:19|20)\d\d$/;
// 1.500.000 or 1 200 000. Space-grouped with a three-digit lead (612 345 678)
// is how Spain, Poland and others write mobile numbers.
const THOUSANDS = /^(?:\d{1,3}(?:\.\d{3}){2,}|\d{1,2}(?: \d{3}){2,})$/;

/** 7–15 digits (E.164 allows 15), and not a date, a range of years, a big figure or an ID. */
export function isPhone(candidate: string): boolean {
  const groups = candidate.match(/\d+/g) ?? [];
  const digits = groups.join('').length;
  if (digits < 7 || digits > 15) return false;
  // "Student ID 20191234": digits alone are a phone only at full length, area code included.
  if (groups.length === 1 && !candidate.startsWith('+') && digits < 10) return false;
  if (THOUSANDS.test(candidate)) return false;
  const years = groups.filter((g) => YEAR.test(g)).length;
  // "2016 - 2021", "3.9 (2012 - 2016", "01.2016 - 03.2021"
  if (years >= 2) return false;
  // "2016-01-15", "15.01.2016"
  return !(years === 1 && groups.every((g) => YEAR.test(g) || g.length <= 2));
}

/** The same link written two ways ("https://Rowan.example.test/" and "https://rowan.example.test") has one key. */
const linkKey = (url: string) => url.replace(/^https?:\/\/[^/?#]*/i, (origin) => origin.toLowerCase()).replace(/(?<!\/)\/+$/, '');

/** Links deduped by linkKey, first form kept, at most `max`. */
export function uniqueLinks(urls: string[], max = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = linkKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length === max) break;
  }
  return out;
}

// Hosts where the path names a person: a profile behind a "LinkedIn" label is theirs.
const PROFILE_HOST =
  /^(?:(?:[\w-]+\.)?linkedin\.com\/(?:in|pub)\/|(?:github|gitlab|bitbucket|codeberg)\.(?:com|org)\/[\w.-]+|(?:behance\.net|dribbble\.com|x\.com|twitter\.com|kaggle\.com|huggingface\.co|codepen\.io|dev\.to)\/[\w.-]+|medium\.com\/@|stackoverflow\.com\/users\/|(?:wellfound\.com|angel\.co)\/u\/|orcid\.org\/|scholar\.google\.[\w.]+\/citations|researchgate\.net\/profile\/|[\w-]+\.(?:github\.io|medium\.com|substack\.com)(?:\/|$))/i;

/** A link whose path names a person (linkedin.com/in/…, github.com/…), not an employer or a school. */
export function isProfileLink(url: string): boolean {
  return PROFILE_HOST.test(url.replace(/^https?:\/\/(?:www\.)?/i, ''));
}

/**
 * Pull contact signals out of resume text (links, phones). `links` are the
 * document's own link targets (extractText). A URL the resume shows counts,
 * as does a target that is a profile ("LinkedIn" → linkedin.com/in/…); other
 * targets hide behind an employer's or a school's name ("Stripe", "MIT") and
 * aren't the candidate's, and duplicate detection matches on links. A URL in
 * the text comes first, so it is the form kept when a target repeats it. No
 * emails: a resume lists other people's (references, past managers), and an
 * address on a contact is who they are.
 */
export function extractSignals(
  text: string,
  links: string[] = [],
  { targetsInText = false }: { targetsInText?: boolean } = {},
): { links: string[]; phones: string[] } {
  const web = links.filter((l) => /^https?:\/\//i.test(l));
  // The Word, ODT, RTF and HTML readers write a hidden target into the text
  // as "Stripe (https://stripe.com/)"; that is not a URL the resume shows.
  // (A PDF's link targets stay out of its text.)
  let shown = text;
  if (targetsInText) for (const url of web) shown = shown.split(` (${url})`).join(' ');
  // "See https://rowan.example.test." ends a sentence, not the URL. The
  // lookbehinds here and in linkKey keep a long run of dots linear.
  const inText = (shown.match(WEB_URL) ?? []).map((u) => u.replace(/(?<![.,;:!?'"])[.,;:!?'"]+$/, ''));
  // Phone digits inside a URL (a DOI, a query string) aren't a phone.
  const phones = [...new Set((text.replace(WEB_URL, ' ').match(PHONE_CANDIDATE) ?? []).filter(isPhone))].slice(0, 3);
  return { links: uniqueLinks([...inText, ...web.filter(isProfileLink)]), phones };
}
