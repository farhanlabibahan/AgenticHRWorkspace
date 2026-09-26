import type { ReactNode } from 'react';
import { DrawerContent } from '@/components/drawer-host';

// Intercepted in-app navigation to a candidate: the profile renders into the
// app-wide drawer (DrawerHost in the app layout). The layout sits above [id],
// so switching between a candidate's applications swaps what's in the drawer
// instead of remounting it.
export default function CandidateModalLayout({ children }: { children: ReactNode }) {
  return <DrawerContent>{children}</DrawerContent>;
}
