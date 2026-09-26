import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { authConfig } from '@/lib/auth.config';
import {
  GOOGLE_CONTINUE_PROVIDER,
  authorizeGoogleContinue,
  googleAuthEnabled,
  googleSignInCallback,
} from '@/server/google-auth';
import { sessionOrgSelect, toSessionUser } from '@/server/session-user';

const providers: Provider[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    async authorize(credentials) {
      const email = String(credentials?.email ?? '')
        .toLowerCase()
        .trim();
      const password = String(credentials?.password ?? '');
      if (!email || !password) return null;

      // Users who only sign in with Google have no password to check.
      const user = await db.user.findFirst({
        where: { email, deactivatedAt: null, passwordHash: { not: null } },
        include: { org: { select: sessionOrgSelect } },
      });
      if (!user?.passwordHash) return null;

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return null;

      return toSessionUser(user);
    },
  }),
];

// "Continue with Google" exists only where the deployment has its own Google
// OAuth client (see README). Unset, the provider isn't registered at all.
if (googleAuthEnabled()) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      checks: ['pkce', 'state'],
      // Let people with several Google accounts pick the right one.
      authorization: { params: { prompt: 'select_account' } },
    }),
    // The step after Google when it takes one (pick a workspace, or name a
    // new one). Trusts only the sealed cookie set by the Google callback.
    Credentials({
      id: GOOGLE_CONTINUE_PROVIDER,
      name: 'Google',
      credentials: { userId: {} },
      authorize: (credentials) => authorizeGoogleContinue(credentials?.userId),
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      if (account?.provider === 'google') {
        return googleSignInCallback(user as unknown as Record<string, unknown>, profile);
      }
      return true;
    },
  },
});
