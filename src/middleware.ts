import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';

// Edge middleware — uses the Prisma-free config (JWT check only).
export default NextAuth(authConfig).auth;

export const config = {
  // Everything requires auth except NextAuth routes, static assets,
  // and public surfaces (careers pages + public API, which ship later).
  // The icons, the manifest and the brand kit (public/brand) are public too:
  // a browser asks for them on the sign-in and careers pages, logged out.
  // oauth/ is Orqestra's OAuth client metadata, which authorization servers
  // fetch without a session (src/app/oauth/mcp-client.json). /agencies,
  // /talent-network, /extension (its old address, which redirects there) and
  // /site-assets belong to the marketing app (next.config.ts rewrites).
  // unsubscribe is a newsletter reader's own page; api/email/ takes the
  // email provider's bounce notifications (checked by signature).
  matcher: [
    '/((?!api/auth|api/cron|api/v1|api/careers|api/logo|careers|portal|share|schedule|offer|unsubscribe|api/unsubscribe|api/email/|agencies|talent-network|extension|site-assets|oauth/|_next/static|_next/image|fonts|brand/|favicon.ico|apple-icon.png|manifest.webmanifest|help).*)',
  ],
};
