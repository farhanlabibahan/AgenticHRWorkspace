import { redirect } from 'next/navigation';

/**
 * With a marketing site (MARKETING_ORIGIN, next.config.ts), `/` is its
 * homepage and this page never runs. Without one, a self-hosted install
 * opens on sign-in; signed-in visitors never get here (lib/auth.config.ts).
 */
export default function Page() {
  redirect('/login');
}
