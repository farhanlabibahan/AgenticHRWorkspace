'use server';

import { revalidatePath } from 'next/cache';
import { setNetworkConsent } from '@/server/portal';

export async function setNetworkConsentAction(token: string, granted: boolean) {
  await setNetworkConsent(token, granted);
  revalidatePath(`/portal/${token}`);
}
