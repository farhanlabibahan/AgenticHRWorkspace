import { notFound } from 'next/navigation';
import { PoweredBySource } from '@/components/powered-by';
import { db } from '@/lib/db';
import { Avatar } from '@/components/ui/orb';
import { ensureSampleBoard, isSampleSlug } from '@/server/sample-boards';
import { brandVars, readBrand, textOn } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { BRAND_FONT_FACES } from '@/app/brand-fonts';

/** Sample boards (server/sample-boards.ts) stay out of search results. */
export async function generateMetadata({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  return isSampleSlug(org) ? { robots: { index: false, follow: false } } : {};
}

export default async function CareersLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  if (isSampleSlug(orgSlug)) await ensureSampleBoard(orgSlug);
  const org = await db.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) notFound();

  // The brand kit (lib/brand.ts): its font, colors and text size, on
  // everything under this layout: the board, each posting and its form.
  const brand = readBrand(org.brand);
  const face = brand.font ? BRAND_FONT_FACES[brand.font] : null;
  const onDark = !!brand.background && textOn(brand.background) !== '#1d2419';

  return (
    <div
      className={cn('min-h-screen bg-canvas font-sans text-ink', face?.className)}
      style={brandVars(brand, face?.cssVar) as React.CSSProperties}
    >
      <header className="mx-auto flex max-w-3xl items-center gap-3 px-6 pb-4 pt-8">
        {org.logoFileId ? (
          // eslint-disable-next-line @next/next/no-img-element -- org upload via the public logo route
          <img src={`/api/logo/${org.logoFileId}`} alt={org.name} className="h-10 w-auto max-w-[220px] object-contain object-left" />
        ) : (
          <>
            <Avatar name={org.name} size={36} />
            <div>
              <p className="text-md font-medium text-ink">{org.name}</p>
              <p className="text-xs text-ink-2">Careers</p>
            </div>
          </>
        )}
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>
      {/* on a dark brand background, the lockup's light-on-dark version */}
      <footer className={cn('mx-auto max-w-3xl px-6 pb-8', onDark && 'dark')}>
        <PoweredBySource />
      </footer>
    </div>
  );
}
