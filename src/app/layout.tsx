import type { Metadata, Viewport } from 'next';
import { fragmentMono, geist } from './fonts';
import { FieldValidation } from '@/components/field-validation';
import './globals.css';

export const metadata: Metadata = {
  title: 'Orqestra',
  description:
    'Open source Applicant Tracking System — candidate pipeline, postings, interviews, offers, and analytics.',
};

// Mobile browser chrome matches the canvas token (docs/09 §2).
export const viewport: Viewport = { themeColor: '#0f3d34' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${fragmentMono.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body>
        {children}
        {/* our own "fill this in" note instead of the browser's bubble */}
        <FieldValidation />
      </body>
    </html>
  );
}
