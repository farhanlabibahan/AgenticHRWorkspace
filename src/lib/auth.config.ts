import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-safe NextAuth config — no Prisma imports here, so the middleware
 * can run on the edge runtime. Providers are added in lib/auth.ts.
 */
export const authConfig = {
  // Errors (a cancelled or failed Google sign-in) land back on the sign-in
  // page, which explains them, instead of next-auth's built-in error page.
  pages: { signIn: '/login', error: '/login' },
  session: { strategy: 'jwt' },
  // Without AUTH_SECRET, fall back to an ephemeral per-instance secret:
  // public pages render and sessions stay unforgeable, they just don't
  // survive instance recycling. Set AUTH_SECRET for real deployments.
  secret: process.env.AUTH_SECRET ?? `ephemeral-${crypto.randomUUID()}`,
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const loggedIn = !!auth?.user;
      // The marketing site lives at the root — public. Signed-in visitors go
      // straight to the app from here, so the page itself stays static and
      // CDN-cacheable.
      // The self-hosted edition's page is public marketing too. With
      // MARKETING_ORIGIN set, next.config.ts hands both to the marketing app.
      // /demo signs a visitor in to the demo workspace (app/demo/route.ts).
      if (nextUrl.pathname === '/self-hosted') return true;
      // Demo sign-in endpoints always answer, so you can switch roles while signed in.
      if (nextUrl.pathname === '/demo' || nextUrl.pathname.startsWith('/demo/')) return true;
      // The help guide is public, so people can read it before signing in.
      if (nextUrl.pathname === '/help') return true;
      if (nextUrl.pathname === '/' || nextUrl.pathname === '/demo') {
        if (auth?.user?.orgId) return Response.redirect(new URL('/dashboard', nextUrl));
        return true;
      }
      // The list data routes are fetched by the page, not navigated to: a
      // redirect would hand the fetch the login page's HTML. Say 401 instead.
      if (!loggedIn && nextUrl.pathname.startsWith('/api/lists/')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const isAuthPage =
        nextUrl.pathname.startsWith('/login') || nextUrl.pathname.startsWith('/signup');
      if (isAuthPage) {
        if (loggedIn) return Response.redirect(new URL('/dashboard', nextUrl));
        return true;
      }
      return loggedIn;
    },
    jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.orgId = user.orgId;
        token.accessRole = user.accessRole;
        token.orgName = user.orgName;
        token.orgLogoFileId = user.orgLogoFileId;
        token.onboardedAt = user.onboardedAt;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
        session.user.orgId = token.orgId as string;
        session.user.accessRole = token.accessRole as string;
        session.user.orgName = token.orgName as string | undefined;
        session.user.orgLogoFileId = token.orgLogoFileId as string | null | undefined;
        session.user.onboardedAt = token.onboardedAt as string | null | undefined;
      }
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
