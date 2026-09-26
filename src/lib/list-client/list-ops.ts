import type { PipelineRow } from '@/lib/list-types';

export type ListState = { rows: PipelineRow[]; counts: Record<string, number>; total: number };
export type ListOp = { type: 'move'; ids: string[]; stageId: string } | { type: 'remove'; ids: string[] };

/**
 * What the pipeline looks like after an edit, before the server confirms it.
 * The tab counts are per stage for whichever list is showing (Active, or
 * Archived), so both are re-counted the same way.
 *
 * - A move re-counts the stage tabs and drops rows that no longer match the
 *   current tab. In the Archived view, a move to a hired stage makes the
 *   candidate HIRED, which takes them out of that view altogether.
 * - An archive drops the rows from the Active view. In the Archived view the
 *   server only re-archives them, so nothing changes (the bar doesn't offer
 *   it there).
 *
 * Idempotent: a row already in the target stage (or already gone) is left
 * alone, so applying an op to rows that already carry it changes nothing.
 */
export function applyListOp(
  state: ListState,
  op: ListOp,
  currentStage: string,
  archived: boolean,
  hiredStageIds: Set<string>,
): ListState {
  if (op.type === 'remove' && archived) return state;
  const ids = new Set(op.ids);
  const counts = { ...state.counts };
  let total = state.total;
  const drop = (stageId: string) => {
    counts[stageId] = Math.max(0, (counts[stageId] ?? 0) - 1);
    total = Math.max(0, total - 1);
  };
  const rows: PipelineRow[] = [];
  for (const row of state.rows) {
    if (!ids.has(row.id)) {
      rows.push(row);
      continue;
    }
    if (op.type === 'remove') {
      drop(row.stageId);
      continue;
    }
    if (row.stageId === op.stageId) {
      rows.push(row);
      continue;
    }
    if (archived && hiredStageIds.has(op.stageId)) {
      drop(row.stageId); // hired: no longer archived
      continue;
    }
    counts[row.stageId] = Math.max(0, (counts[row.stageId] ?? 0) - 1);
    counts[op.stageId] = (counts[op.stageId] ?? 0) + 1;
    if (currentStage && op.stageId !== currentStage) continue; // left this tab
    rows.push({ ...row, stageId: op.stageId, days: 0, daysInStage: 'today' });
  }
  return { rows, counts, total };
}
