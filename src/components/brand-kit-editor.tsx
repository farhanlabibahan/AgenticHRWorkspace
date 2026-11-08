'use client';

import { useState, useTransition } from 'react';
import { MapPin } from 'lucide-react';
import { saveBrandKitAction } from '@/app/org-actions';
import { ALL_BRAND_FONT_CLASSES, BRAND_FONT_FACES } from '@/app/brand-fonts';
import { inputClass, noAutofill, sectionLabel } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Chip, Segmented } from '@/components/ui/primitives';
import { Avatar } from '@/components/ui/orb';
import {
  BRAND_FONTS,
  brandColorWarning,
  brandVars,
  EMPTY_BRAND,
  isDefaultBrand,
  readBrand,
  TEXT_SIZES,
  type Brand,
  type TextSizeId,
} from '@/lib/brand';
import { cn } from '@/lib/utils';

/**
 * Settings → Brand: the font, text size, brand color and background of the
 * pages candidates see, with a preview drawn by the same CSS variables the
 * careers layout sets (lib/brand.ts), so what you see is what they get.
 */
export function BrandKitEditor({ initial, logoFileId, orgName }: { initial: Brand; logoFileId: string | null; orgName: string }) {
  const [brand, setBrand] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, start] = useTransition();
  const [justSaved, setJustSaved] = useState(false);
  const set = (patch: Partial<Brand>) => {
    setJustSaved(false);
    setBrand((b) => readBrand({ ...b, ...patch }));
  };
  const changed = JSON.stringify(brand) !== JSON.stringify(saved);
  const face = BRAND_FONT_FACES[brand.font ?? 'geist'];
  const warning = brandColorWarning(brand);

  const save = () =>
    start(async () => {
      await saveBrandKitAction(brand);
      setSaved(brand);
      setJustSaved(true);
    });

  return (
    <div className={cn('flex flex-col gap-6', ALL_BRAND_FONT_CLASSES)}>
      <div>
        <p className={`${sectionLabel} mb-2`}>Font</p>
        <div className="flex flex-wrap gap-2">
          {BRAND_FONTS.map((f) => (
            <Chip key={f.id} selected={(brand.font ?? 'geist') === f.id} onClick={() => set({ font: f.id })}>
              <span style={{ fontFamily: `var(${BRAND_FONT_FACES[f.id].cssVar})` }}>{f.label}</span>
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <p className={`${sectionLabel} mb-2`}>Text size</p>
        <Segmented<TextSizeId>
          size="sm"
          value={brand.textSize}
          onChange={(textSize) => set({ textSize })}
          items={TEXT_SIZES.map((t) => ({ value: t.id, label: t.label }))}
        />
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-6">
        <ColorField
          label="Brand color"
          hint="Buttons and highlights"
          value={brand.color}
          fallback="#0a0a0a"
          onChange={(color) => set({ color })}
        />
        <ColorField
          label="Background"
          hint="Text and cards follow it"
          value={brand.background}
          fallback="#f5f4f2"
          onChange={(background) => set({ background })}
        />
      </div>
      {warning ? <p className="-mt-3 text-sm text-caution">{warning}</p> : null}

      {/* The preview: the careers layout's own variables, on a small board */}
      <div>
        <p className={`${sectionLabel} mb-2`}>Preview</p>
        <div
          className={cn('rounded-card bg-canvas p-6 font-sans text-ink shadow-[inset_0_0_0_1px_var(--color-line)]', face.className)}
          style={brandVars(brand, face.cssVar) as React.CSSProperties}
        >
          {logoFileId ? (
            // eslint-disable-next-line @next/next/no-img-element -- org upload via the public logo route
            <img src={`/api/logo/${logoFileId}`} alt={orgName} className="h-8 w-auto max-w-[180px] object-contain object-left" />
          ) : (
            <div className="flex items-center gap-2.5">
              <Avatar name={orgName} size={28} />
              <span className="text-md font-medium">{orgName}</span>
            </div>
          )}
          <p className="mt-6 text-2xl">Open positions</p>
          <div className="mt-4 rounded-card bg-surface p-4">
            <p className="text-md font-medium">Senior Product Designer</p>
            <p className="mt-1 flex items-center gap-3 text-sm text-ink-2">
              <span className="flex items-center gap-1">
                <MapPin size={13} /> New York, NY
              </span>
              <span>Hybrid</span>
              <span>Full-time</span>
            </p>
            <div className="mt-4 flex gap-2">
              <span className={buttonClass({ variant: 'primary', size: 'sm' })}>Apply for this role</span>
              <span className={buttonClass({ variant: 'tonal', size: 'sm' })}>Share</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!changed || pending} onClick={save} className={buttonClass({ variant: 'primary' })}>
          {pending ? 'Saving…' : 'Save brand'}
        </button>
        {!isDefaultBrand(brand) ? (
          <button type="button" disabled={pending} onClick={() => set(EMPTY_BRAND)} className={buttonClass({ variant: 'ghost' })}>
            Use Orqestra’s look
          </button>
        ) : null}
        {justSaved && !changed ? <span className="text-sm text-ink-2">Saved</span> : null}
      </div>
    </div>
  );
}

/** A color: the native picker, the hex beside it, and a way back to the default. */
function ColorField({
  label,
  hint,
  value,
  fallback,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  fallback: string;
  onChange: (hex: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? '';
  return (
    <div>
      <p className={sectionLabel}>{label}</p>
      <p className="mb-2 text-xs text-ink-3">{hint}</p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label}: pick`}
          value={value ?? fallback}
          onChange={(e) => onChange(e.target.value)}
          className="size-9 cursor-pointer rounded-field border-0 bg-recessed p-1"
        />
        <input
          {...noAutofill}
          aria-label={`${label}: hex`}
          value={shown}
          placeholder="Default"
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v);
            if (/^#?[0-9a-f]{6}$/i.test(v)) onChange(v.startsWith('#') ? v : `#${v}`);
            if (!v) onChange(null);
          }}
          onBlur={() => setDraft(null)}
          className={`${inputClass} w-28 font-mono text-xs`}
        />
        {value ? (
          <button type="button" onClick={() => onChange(null)} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Default
          </button>
        ) : null}
      </div>
    </div>
  );
}
