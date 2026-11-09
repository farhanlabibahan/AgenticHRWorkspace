import { redirect } from 'next/navigation';
import { signOutAction } from './sign-out-action';
import { getAuthSession, getOrgNav } from '@/lib/session';
import { readOrgNavCookie } from '@/lib/org-nav-cookie';
import { Sidebar } from '@/components/sidebar';
import { Toaster } from '@/components/toaster';
import { PersistOrgNav } from '@/components/persist-org-nav';
import { DrawerHost } from '@/components/drawer-host';
import { aiConfigured } from '@/server/ai-client';

export default async function AppLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  const session = await getAuthSession();
  if (!session?.user?.id || !session.user.orgId) redirect('/login');

  const fromJwt =
    session.user.orgName != null
      ? {
          name: session.user.orgName,
          logoFileId: session.user.orgLogoFileId ?? null,
          onboardedAt: session.user.onboardedAt ? new Date(session.user.onboardedAt) : null,
        }
      : null;
  const fromCookie = fromJwt ? null : await readOrgNavCookie();
  let fetched = fromJwt || fromCookie ? null : await getOrgNav(session.user.orgId);
  // The token and the cookie are written at sign-in: "not onboarded" there
  // may be out of date (setup finished since, and the onboarding page, which
  // reads the database, would send you straight back here). Ask the org row,
  // which "Finish setup" revalidates, before sending anyone to onboarding.
  if (!(fromJwt ?? fromCookie ?? fetched)?.onboardedAt) fetched ??= await getOrgNav(session.user.orgId);
  const org = fetched ?? fromJwt ?? fromCookie;
  if (org && !org.onboardedAt) redirect('/onboarding');

  return (
    // DrawerHost holds the candidate drawer for every page, so it can open on
    // the click and slide out on any exit (see drawer-host.tsx).
    <DrawerHost>
    <div className="flex min-h-screen">
      <Sidebar
        user={{ name: session.user.name ?? '', email: session.user.email ?? '' }}
        org={{ name: org?.name ?? 'Workspace', logoFileId: org?.logoFileId ?? null }}
        signOutAction={signOutAction}
        aiEnabled={aiConfigured()}
      />
      {fetched ? (
        <PersistOrgNav
          name={fetched.name}
          logoFileId={fetched.logoFileId}
          onboardedAt={fetched.onboardedAt ? fetched.onboardedAt.toISOString() : null}
        />
      ) : null}
      <main className="min-w-0 flex-1 pb-28 md:pb-0">{children}</main>
      <Toaster />
      {modal}
    </div>
    </DrawerHost>
  );
}
