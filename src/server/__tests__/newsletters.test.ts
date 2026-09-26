import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMPTY_BRAND } from '@/lib/brand';
import {
  readUnsubscribeToken,
  renderNewsletterHtml,
  renderNewsletterText,
  unsubscribeToken,
  type NewsletterContent,
} from '@/server/newsletter-email';
import { isSnsUrl, readSesNotification, stringToSign, verifySnsMessage, type SnsMessage } from '@/server/sns';

const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

const CONTENT: NewsletterContent = {
  orgName: 'Northwind <Talent>',
  subject: 'New roles this month',
  body: 'Hi there,\n\nWe are hiring again: see https://northwind.example/why.\nLine two.\n\n<script>alert(1)</script>',
  roles: [{ title: 'Staff Engineer', location: 'Remote — US', workplaceType: 'REMOTE', commitment: 'FULL_TIME', url: 'https://app.example/careers/nw/staff' }],
  boardUrl: 'https://app.example/careers/nw',
  unsubscribeUrl: 'https://app.example/unsubscribe/tok',
  logoUrl: null,
  brand: { ...EMPTY_BRAND, color: '#1d4ed8', background: '#0b1220', font: 'lora' },
};

describe('unsubscribe tokens', () => {
  it('round-trips, and a changed id or signature is refused', () => {
    const token = unsubscribeToken(ID);
    expect(readUnsubscribeToken(token)).toBe(ID);
    const other = '2b4e28ba-2fa1-11d2-883f-0016d3cca427';
    expect(readUnsubscribeToken(`${other}.${token.split('.')[1]}`)).toBeNull();
    expect(readUnsubscribeToken(`${ID}.AAAA`)).toBeNull();
    expect(readUnsubscribeToken('not-a-token')).toBeNull();
  });
});

describe('rendering', () => {
  it('escapes everything the organization typed, and links https URLs', () => {
    const html = renderNewsletterHtml(CONTENT);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Northwind &lt;Talent&gt;');
    expect(html).toContain('<a href="https://northwind.example/why" style="color:#1d4ed8;">https://northwind.example/why</a>.');
    expect(html).toContain('Line two.');
  });

  it('wears the brand kit: background, button colors and font', () => {
    const html = renderNewsletterHtml(CONTENT);
    expect(html).toContain('background:#0b1220');
    expect(html).toContain('background:#1d4ed8;color:#ffffff');
    expect(html).toContain("font-family:Lora, Georgia, 'Times New Roman', serif");
  });

  it('carries the roles and the unsubscribe link in both parts', () => {
    const html = renderNewsletterHtml(CONTENT);
    const text = renderNewsletterText(CONTENT);
    for (const part of [html, text]) {
      expect(part).toContain('https://app.example/careers/nw/staff');
      expect(part).toContain('https://app.example/unsubscribe/tok');
    }
    expect(text).toContain('Staff Engineer\nRemote — US · Remote · Full-time');
    // plain text is never rendered as HTML: it keeps what was typed
    expect(text).toContain("been in touch with Northwind <Talent>");
  });
});

describe('SNS messages', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const CERT = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';
  const signed = (m: Omit<SnsMessage, 'Signature'>): SnsMessage => {
    const s = createSign('RSA-SHA256');
    s.update(stringToSign(m as SnsMessage));
    return { ...m, Signature: s.sign(privateKey, 'base64') } as SnsMessage;
  };
  const note = (message: object) =>
    signed({
      Type: 'Notification',
      MessageId: 'm1',
      TopicArn: 'arn:aws:sns:us-east-1:123:ses',
      Message: JSON.stringify(message),
      Timestamp: '2026-09-26T00:00:00Z',
      SignatureVersion: '2',
      SigningCertURL: CERT,
    });

  it('accepts only messages signed with a certificate from an SNS host', async () => {
    const m = note({ notificationType: 'Bounce' });
    const fetchCert = async () => pem;
    expect(await verifySnsMessage(m, fetchCert)).not.toBeNull();
    expect(await verifySnsMessage({ ...m, Message: '{"notificationType":"Complaint"}' }, fetchCert)).toBeNull();
    expect(await verifySnsMessage({ ...m, SigningCertURL: 'https://evil.example/cert.pem' }, fetchCert)).toBeNull();
    expect(isSnsUrl('https://sns.us-east-1.amazonaws.com.evil.example/x.pem', true)).toBe(false);
    expect(isSnsUrl('http://sns.us-east-1.amazonaws.com/x.pem', true)).toBe(false);
  });

  it('suppresses permanent bounces and complaints, nothing else', () => {
    const bounce = (bounceType: string) =>
      readSesNotification(JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType, bouncedRecipients: [{ emailAddress: 'gone@example.com' }] } }));
    expect(bounce('Permanent')).toEqual({ kind: 'bounce', addresses: ['gone@example.com'] });
    expect(bounce('Transient')).toBeNull();
    expect(readSesNotification(JSON.stringify({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'no@example.com' }] } }))).toEqual({
      kind: 'complaint',
      addresses: ['no@example.com'],
    });
    expect(readSesNotification(JSON.stringify({ notificationType: 'Delivery' }))).toBeNull();
    expect(readSesNotification('not json')).toBeNull();
  });
});
