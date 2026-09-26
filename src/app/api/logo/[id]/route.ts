import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { fileResponseHeaders, openStoredFile, StoredFileMissingError } from '@/server/storage';

/**
 * Public logo serving. Only files currently referenced as an organization
 * or posting logo are reachable here — everything else stays behind the
 * org-scoped /api/files route. Logos appear on public careers pages, so
 * this route takes no session.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [org, posting] = await Promise.all([
    db.organization.findFirst({ where: { logoFileId: id }, select: { id: true } }),
    db.posting.findFirst({ where: { logoFileId: id }, select: { id: true } }),
  ]);
  if (!org && !posting) return new NextResponse('Not found', { status: 404 });

  const file = await db.storedFile.findUnique({ where: { id } });
  if (!file) return new NextResponse('Not found', { status: 404 });

  let body: ReadableStream<Uint8Array>;
  try {
    body = await openStoredFile(file.key);
  } catch (err) {
    if (err instanceof StoredFileMissingError) return new NextResponse('Not found', { status: 404 });
    throw err;
  }
  // Logos may be SVG; the sandbox CSP keeps a scripted SVG inert if opened directly.
  return new NextResponse(body, {
    headers: { ...fileResponseHeaders(file, 'public, max-age=3600', { allowSvg: true }), 'Content-Length': String(file.size) },
  });
}
