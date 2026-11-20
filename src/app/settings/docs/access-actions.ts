'use server';

import { redirect } from 'next/navigation';
import { clearDocsAdminAccess, grantDocsAdminAccess, matchesDocsPassword } from '@/lib/docs-admin';

export async function unlockDocsAction(formData: FormData) {
  const password = String(formData.get('password') ?? '');
  if (!matchesDocsPassword(password)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    redirect('/settings/docs?error=invalid');
  }
  await grantDocsAdminAccess();
  redirect('/settings/docs');
}

export async function lockDocsAction() {
  await clearDocsAdminAccess();
  redirect('/settings/docs');
}
