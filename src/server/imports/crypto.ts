import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import type { Credentials } from '@/server/imports/types';

/**
 * Vendor API keys live on an ImportJob only while it runs (the job resumes
 * across many requests), sealed with AES-256-GCM, and are wiped the moment
 * the job succeeds, fails, or is canceled. The key is derived from
 * IMPORT_ENCRYPTION_KEY, falling back to AUTH_SECRET, so no new env var is
 * required. Rotating the secret mid-import just fails that job with a
 * "re-enter your key" message.
 *
 * Meeting notetaker connections (src/server/notetakers) keep their API key or
 * OAuth tokens sealed the same way, under a key of their own (SealPurpose).
 */

const VERSION = 'v1';

/**
 * What a sealed value is for. Each purpose derives its own key from the same
 * secret, so a value sealed for one can't be opened as another.
 */
export type SealPurpose = 'import-credentials' | 'notetaker-credentials' | 'notetaker-pick';

function key(purpose: SealPurpose): Buffer {
  const secret = process.env.IMPORT_ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!secret) throw new Error('Set AUTH_SECRET (or IMPORT_ENCRYPTION_KEY) to store credentials');
  return Buffer.from(hkdfSync('sha256', secret, 'source-ats', purpose, 32));
}

/** AES-256-GCM seal of any JSON value. */
export function sealJson(value: unknown, purpose: SealPurpose): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

/** Opens what sealJson sealed, or null when it can't be read (another secret, tampered, not a seal). */
export function openJson<T>(sealed: string | null | undefined, purpose: SealPurpose): T | null {
  if (!sealed) return null;
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function sealCredentials(credentials: Credentials): string {
  return sealJson(credentials, 'import-credentials');
}

export class CredentialsUnavailableError extends Error {
  constructor() {
    super('The stored API key can no longer be read — start a new import and re-enter it');
    this.name = 'CredentialsUnavailableError';
  }
}

export function openCredentials(sealed: string | null): Credentials {
  const credentials = openJson<Credentials>(sealed, 'import-credentials');
  if (!credentials) throw new CredentialsUnavailableError();
  return credentials;
}
