import type { DefaultSession } from 'next-auth';
import type { AccessRole } from '@prisma/client';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      orgId: string;
      accessRole: AccessRole | string;
      orgName?: string;
      orgLogoFileId?: string | null;
      onboardedAt?: string | null;
    } & DefaultSession['user'];
  }

  interface User {
    orgId?: string;
    accessRole?: AccessRole | string;
    orgName?: string;
    orgLogoFileId?: string | null;
    onboardedAt?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
    orgId?: string;
    accessRole?: string;
    orgName?: string;
    orgLogoFileId?: string | null;
    onboardedAt?: string | null;
  }
}
