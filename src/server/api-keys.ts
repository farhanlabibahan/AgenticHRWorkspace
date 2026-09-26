import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';

/** Org-scoped API keys. Plaintext is shown once at creation; only the hash is stored. */

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(ctx: SessionContext, name: string) {
  const plaintext = `src_${randomBytes(24).toString('base64url')}`;
  const record = await db.apiKey.create({
    data: {
      orgId: ctx.orgId,
      name: name.trim() || 'API key',
      keyHash: hashKey(plaintext),
      prefix: plaintext.slice(0, 10),
    },
  });
  return { record, plaintext }; // plaintext leaves the server exactly once
}

export async function revokeApiKey(ctx: SessionContext, keyId: string) {
  const key = await db.apiKey.findFirst({ where: { id: keyId, orgId: ctx.orgId } });
  if (!key) throw new Error('Key not found');
  return db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
}

export type ApiContext = { orgId: string; apiKeyId: string };

/** Authenticate a public-API request. Returns null on any failure. */
export async function authenticateApiKey(request: Request): Promise<ApiContext | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer src_') && !header?.startsWith('Bearer oats_')) return null;
  const key = await db.apiKey.findUnique({
    where: { keyHash: hashKey(header.slice(7)) },
  });
  if (!key || key.revokedAt) return null;
  // fire-and-forget usage stamp
  db.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { orgId: key.orgId, apiKeyId: key.id };
}
