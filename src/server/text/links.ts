/**
 * Hyperlinks in documents. The target is kept twice: inline after the display
 * text ("LinkedIn (https://…)"), so text search and the stored resume text
 * show it, and in AdapterOutput.links for the signal extractor.
 */

/**
 * What to append after a hyperlink's display text so its target survives into
 * plain text. Nothing when the display text already shows the target.
 */
export function linkSuffix(display: string, url: string | null | undefined): string {
  if (!url) return '';
  const u = url.trim();
  const shown = display.toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1]?.toLowerCase();
  if (scheme === 'mailto' || scheme === 'tel') {
    let v = u.slice(scheme.length + 1).split('?')[0].replace(/^\/\//, '');
    try {
      v = decodeURIComponent(v);
    } catch {
      // Malformed escapes: show the target as written.
    }
    v = v.trim();
    if (!v || shown.includes(v.toLowerCase())) return '';
    return ` (${v})`;
  }
  if (scheme !== 'http' && scheme !== 'https') return ''; // anchors, file:, javascript:, …
  if (shown.includes(u.toLowerCase().replace(/\/$/, ''))) return '';
  return ` (${u})`;
}

// Past these the display text is not compared: a real link shows a few words,
// and joining everything inside each of 20,000 nested links is quadratic.
const MAX_DISPLAY_PIECES = 32;
const MAX_DISPLAY_CHARS = 2_000;

/**
 * A link's display text: what was written to `buf` since `start`, when the
 * link opened. Empty when there is no target to compare it with, or when it
 * is too long to be worth comparing (linkSuffix then just appends the target).
 */
export function linkDisplay(buf: string[], start: number, url: string | null | undefined): string {
  if (!url || buf.length - start > MAX_DISPLAY_PIECES) return '';
  let chars = 0;
  for (let i = start; i < buf.length; i++) chars += buf[i].length;
  return chars <= MAX_DISPLAY_CHARS ? buf.slice(start).join('') : '';
}

/** Add a hyperlink target to `links` when it is a web or email link. */
export function collectLink(links: Set<string>, url: string | null | undefined): void {
  const u = url?.trim();
  if (u && /^(https?:\/\/|mailto:)\S/i.test(u)) links.add(u);
}

/** URL of a Word field instruction like ` HYPERLINK "https://x" \o "tip" ` (null for \l anchors and other fields). */
export function hyperlinkFromInstr(instr: string): string | null {
  const tokens = instr.trim().match(/"[^"]*"|\S+/g);
  if (!tokens || tokens[0].toUpperCase() !== 'HYPERLINK') return null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('\\')) {
      const sw = t.slice(1).toLowerCase();
      if (sw === 'l') return null; // a bookmark inside the document
      if (sw === 'o' || sw === 't' || sw === 'm') i++; // switches that take an argument
      continue;
    }
    return t.replace(/^"|"$/g, '').replace(/\\\\/g, '\\');
  }
  return null;
}
