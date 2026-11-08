import { redirect } from 'next/navigation';
import { signIn } from '@/lib/auth';
import { demoEnabled, ensureDemoAccount, type DemoRole } from '@/server/demo-accounts';

/**
 * Demo sign-in endpoints (GET): /demo/manager and /demo/employee. They rotate
 * the account's password and go through the normal credentials flow, so this
 * is not an auth bypass. With DEMO_MODE off they send you to the sign-in page.
 */
export async function demoSignIn(role: DemoRole): Promise<never> {
  if (!demoEnabled()) redirect('/login');
  const { email, password } = await ensureDemoAccount(role);
  await signIn('credentials', { email, password, redirectTo: '/dashboard' });
  throw new Error('unreachable');
}
