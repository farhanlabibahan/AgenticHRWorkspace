import { useRef, useState } from 'react';
import { DialRoot, type TransitionConfig } from 'dialkit';
import 'dialkit/styles.css';

/**
 * Shared plumbing for the Playground stories: tune a component or the tokens
 * with DialKit (github.com/joshpuckett/dialkit), then "Copy for Claude"
 * puts a Source-specific prompt on the clipboard — which file to change,
 * only the values that moved, and the rule to follow (docs/09).
 *
 * DialKit's own Copy button still works too, but its instruction targets
 * the story's useDialKit call; ours targets the real component or tokens.
 */

/** The floating panel. Storybook's deploy is a production build, so opt in. */
export function Dials() {
  return <DialRoot productionEnabled theme="light" position="top-right" />;
}

/** Keep the latest values reachable from DialKit's onAction callback. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Only the entries that moved from their defaults. */
export function changed<T extends Record<string, unknown>>(values: T, defaults: T) {
  return (Object.keys(values) as (keyof T)[]).filter(
    (k) => JSON.stringify(values[k]) !== JSON.stringify(defaults[k]),
  );
}

/** A DialKit easing/spring value as CSS, or a note the model can act on. */
export function transitionCss(t: TransitionConfig) {
  if (t.type === 'easing') {
    return {
      duration: `${Math.round(t.duration * 1000)}ms`,
      ease: `cubic-bezier(${t.ease.map((n) => +n.toFixed(3)).join(', ')})`,
    };
  }
  return {
    duration: `${Math.round((t.visualDuration ?? 0.3) * 1000)}ms`,
    ease: `/* spring, bounce ${t.bounce ?? 0} — approximate with linear() or a cubic-bezier */`,
  };
}

/** Clipboard write with a fallback for iframes that deny the async API. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    el.remove();
  }
}

/** A quiet "Copied" confirmation under the demo. */
export function useCopied() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = () => {
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };
  const note = (
    <p aria-live="polite" className="h-5 text-xs text-ink-2">
      {copied ? 'Copied — paste it into Claude.' : ''}
    </p>
  );
  return { flash, note };
}

/** Wrap a prompt with the house rules every Source change follows. */
export function prompt(task: string, body: string) {
  return `${task}

Follow docs/09-design-system.md (the Source design system) and keep the change consistent with the rest of the system.

${body}`;
}
