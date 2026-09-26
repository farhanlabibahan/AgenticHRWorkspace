import { randomInt } from 'crypto';
import { db } from '@/lib/db';
import { verifyShareToken, type SharePayload, type ShareScope } from '@/lib/share-token';

/**
 * Public share links: /share/<code>, where the code is the only thing in
 * the URL and the row holds what it points at. Before this, the whole
 * signed payload rode in the path (~200 characters); those links still
 * resolve until their 90 days run out.
 */

const DAY = 86_400_000;
const TTL_DAYS = 90;
/**
 * A live link is reused while it has at least this long left, so a
 * candidate keeps one link however many times someone presses the
 * button. Older ones get a fresh 90 days instead of expiring soon after
 * they're sent.
 */
const REUSE_MIN_DAYS = 30;

// No 0/O or 1/l/I: codes get read off screenshots and retyped.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
// 56^12 ≈ 2^70. The code is the whole credential, so it has to stay
// unguessable even with many live links.
const CODE_LENGTH = 12;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** The live link for this target, or a new one. The caller checks the target is in `orgId`. */
export async function getOrCreateShareLink(
  orgId: string,
  scope: ShareScope,
  targetId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const live = await db.shareLink.findFirst({
    where: { orgId, scope, targetId, expiresAt: { gt: new Date(Date.now() + REUSE_MIN_DAYS * DAY) } },
    orderBy: { expiresAt: 'desc' },
    select: { code: true, expiresAt: true },
  });
  if (live) return live;
  return db.shareLink.create({
    data: { code: newCode(), orgId, scope, targetId, expiresAt: new Date(Date.now() + TTL_DAYS * DAY) },
    select: { code: true, expiresAt: true },
  });
}

/** What a /share/<token> URL points at: a short code, or a legacy signed token. Null if dead. */
export async function resolveShare(token: string): Promise<SharePayload | null> {
  if (token.includes('.')) return verifyShareToken(token);
  if (!CODE_RE.test(token)) return null;
  const link = await db.shareLink.findUnique({ where: { code: token } });
  if (!link || link.expiresAt.getTime() < Date.now()) return null;
  if (link.scope !== 'posting' && link.scope !== 'client' && link.scope !== 'candidate') return null;
  return { orgId: link.orgId, scope: link.scope, id: link.targetId, exp: link.expiresAt.getTime() };
}
