'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { ChevronDown } from 'lucide-react';
import { moveStageAction } from '@/app/(app)/actions';
import { Dropdown, dropdownTriggerClass } from '@/components/dropdown';
import { runOptimistic } from '@/lib/optimistic';

/**
 * The stage picker. Until someone reaches for it, it is a plain button that
 * looks exactly like the menu's trigger: a long table would otherwise mount
 * one Radix menu per row. The real menu mounts on hover or focus, so it is
 * ready by the click. A press that reaches the stand-in first — every tap
 * (pointerenter and pointerdown arrive together), a click in the same
 * instant as the pointer, a scripted click — opens the menu as it mounts,
 * the way the real trigger opens on pointerdown; focus moves onto it.
 */
export function StageSelect({
  opportunityId,
  currentStageId,
  stages,
  onSurface = false,
  onMove,
  onSaved,
}: {
  opportunityId: string;
  currentStageId: string;
  stages: { id: string; name: string }[];
  /** Set when rendered inside a white surface (table rows) so the pill stays visible. */
  onSurface?: boolean;
  /**
   * Called inside the move's transition, so a parent list can apply its own
   * optimistic update (re-count tabs, drop the row from a filtered view).
   */
  onMove?: (stageId: string) => void;
  /** Called once the server has saved the move, inside the same transition. */
  onSaved?: (stageId: string) => void;
}) {
  const [, startTransition] = useTransition();
  // Shows the new stage the moment it's picked; the server confirms behind it.
  const [stageId, setStageId] = useOptimistic(currentStageId);
  const [armed, setArmed] = useState<null | 'pointer' | 'focus' | 'click'>(null);
  const current = stages.find((s) => s.id === stageId);
  const label = current?.name ?? 'Stage';

  if (!armed) {
    return (
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={`Stage: ${label}`}
        className={dropdownTriggerClass({ compact: true, onSurface })}
        onPointerEnter={() => setArmed('pointer')}
        onPointerDown={(e) => {
          // Same rule as the Radix trigger: primary button, no ctrl (macOS right click).
          if (e.button === 0 && !e.ctrlKey) setArmed('click');
        }}
        onFocus={() => setArmed('focus')}
        onClick={() => setArmed('click')}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-2" />
      </button>
    );
  }

  return (
    <Dropdown
      compact
      onSurface={onSurface}
      label={label}
      triggerLabel={`Stage: ${label}`}
      defaultOpen={armed === 'click'}
      autoFocus={armed !== 'pointer'}
      showSelectedInTrigger={false}
      value={stageId}
      options={stages.map((s) => ({ value: s.id, label: s.name }))}
      onSelect={(next) => {
        if (!next || next === stageId) return;
        const to = stages.find((s) => s.id === next)?.name ?? 'new stage';
        runOptimistic(
          startTransition,
          () => {
            setStageId(next);
            onMove?.(next);
          },
          () => moveStageAction(opportunityId, next),
          `Moving to ${to}`,
          onSaved ? () => onSaved(next) : undefined,
        );
      }}
    />
  );
}
