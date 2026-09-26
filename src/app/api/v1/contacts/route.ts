import { db } from '@/lib/db';
import { paginated, parsePagination, withApiAuth } from '@/lib/api';

export async function GET(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const { limit, cursor } = parsePagination(request.url);
    const contacts = await db.contact.findMany({
      where: { orgId: ctx.orgId, isAnonymized: false },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return paginated(
      contacts.map((c) => ({
        id: c.id,
        name: c.name,
        headline: c.headline,
        location: c.location,
        emails: c.emails,
        phones: c.phones,
        links: c.links,
        tags: c.tags,
        has_resume: !!c.resumeFileId,
        created_at: c.createdAt.toISOString(),
      })),
      limit,
    );
  });
}
