'use client';

import { useRef, useTransition } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { TextSwap } from '@/components/ui/motion';

/**
 * Logo picker used for the organization mark (Settings) and per-posting
 * client logos (agency roles). Uploads on file pick; served publicly via
 * /api/logo/[id] so careers pages can show it.
 */
export function LogoUpload({
  logoFileId,
  upload,
  remove,
  label = 'Logo',
}: {
  logoFileId: string | null;
  upload: (formData: FormData) => Promise<void>;
  remove: () => Promise<void>;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-3">
      {logoFileId ? (
        // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, served by our public logo route
        <img
          src={`/api/logo/${logoFileId}`}
          alt={label}
          className="size-10 rounded-field bg-muted object-contain p-1"
        />
      ) : (
        <span className="flex size-10 items-center justify-center rounded-field bg-recessed text-ink-3">
          <ImagePlus size={16} />
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const fd = new FormData();
          fd.set('logo', file);
          startTransition(async () => {
            await upload(fd);
            if (inputRef.current) inputRef.current.value = '';
          });
        }}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        className={buttonClass({ variant: 'tonal', size: 'sm' })}
      >
        <TextSwap>{pending ? 'Uploading…' : logoFileId ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}</TextSwap>
      </button>
      {logoFileId ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => remove())}
          className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'hover:text-critical' })}
          title={`Remove ${label.toLowerCase()}`}
          aria-label={`Remove ${label.toLowerCase()}`}
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
