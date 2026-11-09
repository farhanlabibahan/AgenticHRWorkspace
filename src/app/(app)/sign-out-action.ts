'use server';

import { signOut } from '@/lib/auth';

/** Sign the company user out. Module-level so it has its own action id. */
export async function signOutAction() {
  await signOut({ redirectTo: '/login' });
}
