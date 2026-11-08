import { NextResponse } from 'next/server';
import { requestOrigin } from '@/server/request-origin';
import { clientMetadataFor, CLIENT_METADATA_PATH } from '@/server/notetakers/oauth';

/**
 * Orqestra's OAuth client ID metadata document (CIMD): authorization servers
 * that support it (Metaview, Granola) fetch this URL and treat it as our
 * client registration, so there's nothing to register. Public by design:
 * the client_id is this document's own URL.
 */
export async function GET(request: Request) {
  const { origin: forwarded } = await requestOrigin();
  const origin = forwarded ?? new URL(request.url).origin;
  return NextResponse.json(
    { client_id: `${origin}${CLIENT_METADATA_PATH}`, ...clientMetadataFor(origin) },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
