'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { Reorder, useDragControls } from 'motion/react';
import { GripVertical, Plus, X } from 'lucide-react';
import type { StageType } from '@prisma/client';
import { createStageAction, deleteStageAction, renameStageAction, reorderStagesAction } from '@/app/org-actions';
import { btnTonal, fieldBareInput, fieldShellClass, inputClass, noAutofill } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { guessInterviewType, INTERVIEW_TYPES, STAGE_GROUPS, stageGroup, type StageGroup } from '@/lib/stage-types';

type Stage = { id: string; name: string; type: string };

const typeLabel = (type: string) => INTERVIEW_TYPES.find((t) => t.value === type)?.label ?? type.toLowerCase();

/**
 * The pipeline in three groups, like Lever's: leads (sourced), applicants
 * (inbound), then the interview process. Stages are dragged by their handle,
 * or moved with the arrow keys on it, within their group.
 */
export function StageManager({ stages }: { stages: Stage[] }) {
  const [items, setItems] = useState(stages);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // The server's order wins after every save or refresh.
  const signature = stages.map((s) => `${s.id}:${s.name}:${s.type}`).join('|');
  useEffect(() => setItems(stages), [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const inGroup = (group: StageGroup, list = items) => list.filter((s) => stageGroup(s.type as StageType) === group);

  /** Every stage, with one group's segment replaced by its new order. */
  function withGroup(group: StageGroup, next: Stage[]): Stage[] {
    let i = 0;
    return items.map((s) => (stageGroup(s.type as StageType) === group ? next[i++] : s));
  }

  function save(list: Stage[]) {
    startTransition(async () => {
      const result = await reorderStagesAction(list.map((s) => s.id));
      setError(result.error ?? null);
      if (result.error) setItems(stages);
    });
  }

  function move(group: StageGroup, id: string, by: -1 | 1) {
    const list = inGroup(group);
    const from = list.findIndex((s) => s.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= list.length) return;
    const next = [...list];
    [next[from], next[to]] = [next[to], next[from]];
    const all = withGroup(group, next);
    setItems(all);
    setAnnouncement(`${next[to].name} moved to position ${to + 1} of ${list.length}`);
    save(all);
  }

  return (
    <div className="flex flex-col gap-6">
      {STAGE_GROUPS.map((group) => {
        const list = inGroup(group.id);
        return (
          <section key={group.id} className="flex flex-col gap-2">
            <div>
              <h3 className="text-sm font-medium">{group.title}</h3>
              <p className="text-xs text-ink-2">{group.description}</p>
            </div>
            {list.length ? (
              <Reorder.Group
                axis="y"
                values={list}
                onReorder={(next: Stage[]) => setItems(withGroup(group.id, next))}
                className="flex flex-col gap-2"
              >
                {list.map((stage, i) => (
                  <StageRow
                    key={stage.id}
                    stage={stage}
                    position={i + 1}
                    showType={group.id === 'interview'}
                    pending={pending}
                    onDrop={() => save(items)}
                    onMove={(by) => move(group.id, stage.id, by)}
                    onError={setError}
                    onDelete={() => {
                      if (!confirm(`Delete the "${stage.name}" stage?`)) return;
                      startTransition(async () => {
                        const result = await deleteStageAction(stage.id);
                        setError(result?.error ?? null);
                      });
                    }}
                  />
                ))}
              </Reorder.Group>
            ) : (
              <p className="text-xs text-ink-3">No {group.title.toLowerCase()} stages yet.</p>
            )}
            <AddStage group={group.id} onError={setError} />
          </section>
        );
      })}

      {error ? <p className="text-sm text-critical">{error}</p> : null}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

function StageRow({
  stage,
  position,
  showType,
  pending,
  onDrop,
  onMove,
  onDelete,
  onError,
}: {
  stage: Stage;
  position: number;
  showType: boolean;
  pending: boolean;
  onDrop: () => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
  onError: (error: string | null) => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={stage}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="flex items-center gap-2 rounded-field bg-surface"
      title={showType ? `Counts as ${typeLabel(stage.type)}` : undefined}
      whileDrag={{ scale: 1.01, boxShadow: 'var(--shadow-float)' }}
    >
      <button
        type="button"
        aria-label={`Move ${stage.name}, position ${position}. Drag, or use the up and down arrow keys.`}
        title="Drag to reorder"
        onPointerDown={(e) => {
          e.preventDefault();
          controls.start(e);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          onMove(e.key === 'ArrowUp' ? -1 : 1);
        }}
        className="flex h-9 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-3 hover:text-ink active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
      <StageName stage={stage} onError={onError}>
        {/* Only when the name doesn't already say it: "Phone screen · Screen" is noise,
            "Present candidate to client · Interview" isn't. */}
        {showType && guessInterviewType(stage.name) !== stage.type ? (
          <span className="hidden shrink-0 text-xs text-ink-2 sm:block">Counts as {typeLabel(stage.type)}</span>
        ) : null}
        <button
          type="button"
          title="Delete stage"
          aria-label={`Delete ${stage.name}`}
          disabled={pending}
          onClick={onDelete}
          className="mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-3 transition-colors duration-[120ms] hover:bg-muted hover:text-ink disabled:opacity-40"
        >
          <X size={14} />
        </button>
      </StageName>
    </Reorder.Item>
  );
}

/**
 * A stage's name, saved when the field is left or Enter is pressed (Escape
 * puts the old name back). No save button: one that's always showing reads
 * like a "done" tick.
 */
function StageName({
  stage,
  onError,
  children,
}: {
  stage: Stage;
  onError: (error: string | null) => void;
  /** Controls inside the field, after the name. */
  children?: ReactNode;
}) {
  const [name, setName] = useState(stage.name);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | { error: string }>('idle');
  const [, startTransition] = useTransition();
  useEffect(() => setName(stage.name), [stage.name]);

  function commit() {
    const next = name.trim();
    if (!next) {
      setName(stage.name);
      onError('A stage needs a name.');
      return setState({ error: 'A stage needs a name.' });
    }
    if (next === stage.name) return;
    setState('saving');
    startTransition(async () => {
      const result = await renameStageAction(stage.id, next);
      onError(result.error ?? null);
      if (result.error) {
        setName(stage.name);
        return setState({ error: result.error });
      }
      setState('saved');
      setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    });
  }

  return (
    <div className={fieldShellClass}>
      <input
        {...noAutofill}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (state !== 'idle') setState('idle');
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setName(stage.name);
            setState('idle');
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
        }}
        className={fieldBareInput}
        aria-label={`${stage.name} stage name`}
        aria-invalid={typeof state === 'object' || undefined}
      />
      <span role="status" className="shrink-0 text-xs text-ink-3 empty:hidden">
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : null}
      </span>
      {children}
    </div>
  );
}

const PLACEHOLDER: Record<StageGroup, string> = {
  lead: 'New lead stage…',
  applicant: 'New applicant stage…',
  interview: 'New interview stage…',
};

function AddStage({ group, onError }: { group: StageGroup; onError: (error: string | null) => void }) {
  const [name, setName] = useState('');
  // Follows the name ("Client interview" → Interview) until someone picks one.
  const [type, setType] = useState<StageType>('SCREEN');
  const [picked, setPicked] = useState(false);
  const [pending, startTransition] = useTransition();
  const fixedType: StageType | null = group === 'lead' ? 'LEAD' : group === 'applicant' ? 'APPLICANT' : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await createStageAction(name, fixedType ?? type);
          onError(result.error ?? null);
          if (!result.error) {
            setName('');
            setPicked(false);
            setType('SCREEN');
          }
        });
      }}
      className="flex items-center gap-2 pl-8"
    >
      <input
        {...noAutofill}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (!picked) setType(guessInterviewType(e.target.value));
        }}
        placeholder={PLACEHOLDER[group]}
        aria-label={PLACEHOLDER[group].replace('…', '')}
        className={inputClass}
      />
      {fixedType ? null : (
        <label className="flex shrink-0 items-center gap-2 text-xs text-ink-2">
          Counts as
          <FormSelect
            value={type}
            onChange={(v) => {
              setType(v as StageType);
              setPicked(true);
            }}
            className="w-32"
            options={INTERVIEW_TYPES}
          />
        </label>
      )}
      <button type="submit" disabled={pending || !name.trim()} className={btnTonal}>
        <Plus /> Add
      </button>
    </form>
  );
}
