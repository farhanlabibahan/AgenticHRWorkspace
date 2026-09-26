import { redirect } from 'next/navigation';
import { signIn } from '@/lib/auth';
import { demoEnabled, ensureDemoOrg } from '@/server/demo';

/**
 * The homepage's "Explore the live demo" link. The homepage is another app
 * (the marketing zone, served at this same address), so it can't call the
 * sign-in action directly; it links here instead. Signed-in visitors never
 * reach this (lib/auth.config.ts sends them to the dashboard), and with demo
 * mode off it's the sign-in page.
 */
export async function GET() {
  if (!demoEnabled()) redirect('/login');
  const { email, password } = await ensureDemoOrg();
  await signIn('credentials', { email, password, redirectTo: '/dashboard' });
}
