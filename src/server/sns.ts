import { createVerify } from 'node:crypto';

/**
 * Amazon SNS messages, verified. Amazon SES reports bounces and complaints
 * through an SNS topic that posts to /api/email/ses. Anyone can post to
 * that URL, and anyone can create an SNS topic, so a message counts only
 * when both of these hold:
 * - its signature verifies against a certificate served from an
 *   `sns.<region>.amazonaws.com` host;
 * - it comes from the topic this server is configured for.
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

export type SnsMessage = {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
};

/** An https URL on an SNS host, the only place a certificate or a subscription confirmation may come from. */
export function isSnsUrl(raw: string | undefined, pem = false): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname) &&
      !url.port &&
      (!pem || url.pathname.endsWith('.pem'))
    );
  } catch {
    return false;
  }
}

/** The exact text SNS signed, by message type. */
export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${(m as Record<string, unknown>)[k] ?? ''}\n`).join('');
}

const certs = new Map<string, string>();

async function signingCert(url: string, fetchCert: (url: string) => Promise<string>): Promise<string> {
  const cached = certs.get(url);
  if (cached) return cached;
  const pem = await fetchCert(url);
  if (!pem.includes('-----BEGIN')) throw new Error('not a certificate');
  certs.set(url, pem);
  return pem;
}

const defaultFetchCert = async (url: string) => {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`certificate ${res.status}`);
  return res.text();
};

/** The message, if it's genuinely from SNS; null otherwise. Never throws. */
export async function verifySnsMessage(raw: unknown, fetchCert = defaultFetchCert): Promise<SnsMessage | null> {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as SnsMessage;
  if (!['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(m.Type)) return null;
  if (typeof m.Signature !== 'string' || typeof m.Message !== 'string' || typeof m.TopicArn !== 'string') return null;
  if (!isSnsUrl(m.SigningCertURL, true)) return null;
  try {
    const cert = await signingCert(m.SigningCertURL, fetchCert);
    const verifier = createVerify(m.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
    verifier.update(stringToSign(m), 'utf8');
    return verifier.verify(cert, m.Signature, 'base64') ? m : null;
  } catch {
    return null;
  }
}

export type SesOutcome = { kind: 'bounce' | 'complaint'; addresses: string[] } | null;

/**
 * What an SES notification means for our list: a permanent bounce or a
 * complaint takes the address off. Transient bounces (a full mailbox) and
 * deliveries mean nothing here. Handles both SES notifications
 * (`notificationType`) and configuration-set events (`eventType`).
 */
export function readSesNotification(message: string): SesOutcome {
  let n: Record<string, unknown>;
  try {
    n = JSON.parse(message);
  } catch {
    return null;
  }
  const type = n.notificationType ?? n.eventType;
  const emails = (list: unknown) =>
    Array.isArray(list) ? list.map((r) => (r as { emailAddress?: unknown })?.emailAddress).filter((e): e is string => typeof e === 'string') : [];
  if (type === 'Bounce') {
    const bounce = n.bounce as { bounceType?: string; bouncedRecipients?: unknown } | undefined;
    return bounce?.bounceType === 'Permanent' ? { kind: 'bounce', addresses: emails(bounce.bouncedRecipients) } : null;
  }
  if (type === 'Complaint') {
    const complaint = n.complaint as { complainedRecipients?: unknown } | undefined;
    return { kind: 'complaint', addresses: emails(complaint?.complainedRecipients) };
  }
  return null;
}
