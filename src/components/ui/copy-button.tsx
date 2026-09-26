'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { IconSwap, TextSwap } from '@/components/ui/motion';

/**
 * Copy to clipboard with confirmation: the copy icon swaps to a check
 * (transitions.dev "icon swap") and the label to "Copied", then both
 * return after a beat. `text` may be a function so callers can build
 * absolute URLs from window.location at click time.
 */
export function CopyButton({
  text,
  label = 'Copy',
  variant = 'ghost',
  size = 'xs',
  className,
}: {
  text: string | (() => string);
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(typeof text === 'function' ? text() : text).catch(() => {});
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
      className={buttonClass({ variant, size, className })}
    >
      <IconSwap on={copied} from={<Copy />} to={<Check />} />
      <TextSwap>{copied ? 'Copied' : label}</TextSwap>
    </button>
  );
}
