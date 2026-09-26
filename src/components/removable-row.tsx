'use client';

import { createContext, useContext, useOptimistic } from 'react';

const RemoveRow = createContext<(() => void) | null>(null);

/**
 * A server-rendered list row that its own controls can hide optimistically:
 * an action that takes the row out of the list (advance, archive) calls
 * useRemoveRow()() inside its transition. The row comes back if the action
 * fails; on success the re-rendered list no longer has it.
 */
export function RemovableRow({ className, children }: { className?: string; children: React.ReactNode }) {
  const [removed, setRemoved] = useOptimistic(false);
  if (removed) return null;
  return (
    <RemoveRow.Provider value={() => setRemoved(true)}>
      <div className={className}>{children}</div>
    </RemoveRow.Provider>
  );
}

export function useRemoveRow() {
  return useContext(RemoveRow);
}
