import { createHmac, timingSafeEqual } from 'node:crypto';
import { BRAND_FONTS, palette, textOn, TEXT_SIZES, type Brand } from '@/lib/brand';
import { COMMITMENT_LABELS, WORKPLACE_LABELS } from '@/lib/job-board';

/**
 * A newsletter as an email: branded HTML (the organization's brand kit, as
 * far as email clients allow) and the plain-text part, plus the signed
 * unsubscribe link every copy carries. Pure: no database, no network.
 */

// ---------- unsubscribe tokens ----------

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET is required to sign unsubscribe links');
  return 'source-dev-unsubscribe';
}

const sign = (contactId: string) => createHmac('sha256', secret()).update(`unsubscribe:${contactId}`).digest('base64url').slice(0, 32);

/** A token that unsubscribes one contact, and nothing else: `<contactId>.<signature>`. */
export const unsubscribeToken = (contactId: string) => `${contactId}.${sign(contactId)}`;

/** The contact a token unsubscribes, or null when it's not one of ours. */
export function readUnsubscribeToken(token: string): string | null {
  const [contactId, sig] = token.split('.');
  if (!contactId || !sig || !/^[0-9a-f-]{36}$/i.test(contactId)) return null;
  const expected = Buffer.from(sign(contactId));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected) ? contactId : null;
}

// ---------- rendering ----------

export type NewsletterRole = {
  title: string;
  location: string | null;
  workplaceType: string;
  commitment: string;
  url: string;
};

export type NewsletterContent = {
  orgName: string;
  subject: string;
  /** Plain text: blank lines make paragraphs; bare https URLs become links. */
  body: string;
  roles: NewsletterRole[];
  boardUrl: string;
  unsubscribeUrl: string;
  logoUrl: string | null;
  brand: Brand;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const paragraphs = (body: string) =>
  body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** A paragraph as HTML: escaped, single newlines kept, https URLs linked. */
function paragraphHtml(p: string, link: string): string {
  return esc(p)
    .replace(/https:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}" style="color:${link};">${url}</a>`)
    .replace(/\n/g, '<br>');
}

const roleMeta = (r: NewsletterRole) =>
  [r.location, WORKPLACE_LABELS[r.workplaceType], COMMITMENT_LABELS[r.commitment]].filter(Boolean).join(' · ');

export function renderNewsletterText(c: NewsletterContent): string {
  const roles = c.roles.map((r) => `${r.title}\n${roleMeta(r)}\n${r.url}`).join('\n\n');
  return [
    paragraphs(c.body).join('\n\n'),
    roles ? `Open roles\n\n${roles}` : '',
    `All open roles: ${c.boardUrl}`,
    `—\nYou're getting this because you've been in touch with ${c.orgName} about a role.\nUnsubscribe: ${c.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function renderNewsletterHtml(c: NewsletterContent): string {
  const bg = c.brand.background ?? '#e6e6e6';
  const p = palette(bg);
  const accent = c.brand.color ?? p.ink;
  const onAccent = c.brand.color ? textOn(c.brand.color) : p.canvas;
  const font = BRAND_FONTS.find((f) => f.id === (c.brand.font ?? 'geist'))!.stack.replace(/"/g, "'");
  const scale = TEXT_SIZES.find((t) => t.id === c.brand.textSize)!.scale;
  const px = (n: number) => `${Math.round(n * scale)}px`;

  const header = c.logoUrl
    ? `<img src="${esc(c.logoUrl)}" alt="${esc(c.orgName)}" height="40" style="display:block;height:40px;width:auto;max-width:220px;border:0;">`
    : `<div style="font-size:${px(18)};font-weight:600;color:${p.ink};">${esc(c.orgName)}</div>`;

  const body = paragraphs(c.body)
    .map((para) => `<p style="margin:0 0 ${px(16)};font-size:${px(16)};line-height:1.55;color:${p.ink};">${paragraphHtml(para, accent)}</p>`)
    .join('');

  const roles = c.roles
    .map(
      (r) => `<tr><td style="padding:0 0 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${p.surface};border-radius:12px;">
    <tr><td style="padding:18px 20px;">
      <div style="font-size:${px(17)};font-weight:600;color:${p.ink};">${esc(r.title)}</div>
      <div style="margin-top:4px;font-size:${px(14)};color:${p.ink2};">${esc(roleMeta(r))}</div>
      <a href="${esc(r.url)}" style="display:inline-block;margin-top:14px;padding:9px 18px;border-radius:999px;background:${accent};color:${onAccent};font-size:${px(14)};font-weight:600;text-decoration:none;">View role</a>
    </td></tr>
  </table>
</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:${bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};font-family:${font};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:0 0 28px;">${header}</td></tr>
      <tr><td>${body}</td></tr>
      ${roles ? `<tr><td style="padding:12px 0 8px;font-size:${px(13)};font-weight:600;color:${p.ink2};">Open roles</td></tr>${roles}` : ''}
      <tr><td style="padding:8px 0 0;font-size:${px(15)};"><a href="${esc(c.boardUrl)}" style="color:${accent};">See every open role</a></td></tr>
      <tr><td style="padding:36px 0 0;font-size:${px(12)};line-height:1.5;color:${p.ink3};">
        You're getting this because you've been in touch with ${esc(c.orgName)} about a role.
        <a href="${esc(c.unsubscribeUrl)}" style="color:${p.ink3};">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
