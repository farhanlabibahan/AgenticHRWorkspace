'use client';

import Link from 'next/link';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import { Users } from 'lucide-react';
import {
  addContactsToPoolAction,
  removeContactsFromPoolAction,
  revalidateListsAction,
} from '@/app/(app)/actions';
import { POOL_BULK_LIMIT } from '@/lib/bulk';
import { runOptimisticBulk } from '@/lib/optimistic';
import type { BoundedCount, ContactRow, ListPage } from '@/lib/list-types';
import { contactRowCache } from '@/lib/list-client/caches';
import { listHref } from '@/lib/list-client/list-key';
import { useKeysetList } from '@/lib/list-client/use-keyset-list';
import { useContactsNav, useLanded } from '@/components/contacts-nav';
import { LoadMore } from '@/components/list/load-more';
import { useWindowedRows } from '@/components/list/virtual-rows';
import { EmptyState } from '@/components/empty-state';
import { FormSelect } from '@/components/form-select';
import { badge, surface } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Avatar } from '@/components/ui/orb';
import { Badge } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/checkbox';
import { CandidateLink } from '@/components/candidate-link';
import { cn } from '@/lib/utils';

export type { ContactRow };

const ENDPOINT = '/api/lists/contacts';
const ROW_H = 52;
const HEAD_H = 44;
const EMPTY = new Set<string>();
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Contacts table with selection + pool bulk actions. Filtering happens
 * server-side (?q= &tag= &pool=); this component owns the loaded pages, the
 * checkboxes and the add/remove-to-pool bar. Like the pipeline, a switch to
 * another pool, tag or search shows the target's cached first page at once
 * or dims the current rows until the server's render lands.
 */
export function ContactsTable({
  page,
  after,
  total,
  staticPools,
  currentPoolId,
  currentPoolStatic,
}: {
  /** First page, rendered on the server. */
  page: ListPage<ContactRow>;
  /** The cursor the server rendered after ('' on the first page). */
  after: string;
  /** How many match, arriving after the rows. */
  total: Promise<BoundedCount | null>;
  staticPools: { id: string; name: string }[];
  currentPoolId: string | null;
  currentPoolStatic: boolean;
}) {
  const nav = useContactsNav();
  const committedKey = nav.committedKey;
  const displayKey = nav.pending ? nav.key : committedKey;
  const [, startTransition] = useTransition();
  const [targetPool, setTargetPool] = useState('');
  // The total belongs to one list: after a switch, none until the new one lands.
  const count = useLanded(total, committedKey);

  const store = useKeysetList({ listKey: committedKey, first: page, endpoint: ENDPOINT });
  useSyncExternalStore(contactRowCache.subscribe, contactRowCache.version, () => 0);
  const cached = displayKey !== committedKey ? contactRowCache.peek(displayKey) : undefined;
  const stale = displayKey !== committedKey && !cached;
  const shownFilter = cached ? nav.input : nav.committed;

  // The committed first page is itself a cache entry: back-and-forth is instant.
  useEffect(() => {
    if (!after) contactRowCache.put(committedKey, page);
  }, [after, committedKey, page]);

  // Removing people from the pool you're viewing takes them off the list now.
  const [visible, hideRows] = useOptimistic(cached ? cached.rows : store.rows, (rows, ids: string[]) =>
    rows.filter((r) => !ids.includes(r.id)),
  );

  const [selection, setSelection] = useState({ key: displayKey, ids: EMPTY });
  if (selection.key !== displayKey) setSelection({ key: displayKey, ids: EMPTY });
  const selected = selection.key === displayKey ? selection.ids : EMPTY;
  const setSelected = (ids: Set<string>) => setSelection({ key: displayKey, ids });
  // Stable, so toggling one checkbox re-renders one row.
  const toggle = useCallback(
    (id: string) =>
      setSelection((prev) => {
        const ids = new Set(prev.ids);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        return { key: prev.key, ids };
      }),
    [],
  );
  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const ids = [...selected];

  const scroller = useRef<HTMLDivElement>(null);
  // A new list starts at the top. Only touch scrollTop when it moved: setting
  // it forces a layout of the whole table inside the click's task.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (!scrolled.current || !scroller.current) return;
    scroller.current.scrollTop = 0;
    scrolled.current = false;
  }, [displayKey]);

  const people = (n: number) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;
  // On failure the unsaved people are selected again, ready to retry.
  const reselect = (unsaved: string[]) => setSelected(new Set(unsaved));
  const { applyCommitted } = store;
  const addToPool = (poolId: string) => {
    setSelected(EMPTY);
    // Adding doesn't change this list, so there's nothing to show early.
    runOptimisticBulk({
      startTransition,
      items: ids,
      size: POOL_BULK_LIMIT,
      run: (chunk, final) => addContactsToPoolAction(poolId, chunk, final),
      refresh: revalidateListsAction,
      copy: { failure: `Adding ${people(ids.length)} to the pool`, done: 'Added', skipped: "couldn't be added" },
      onFailure: reselect,
    });
  };
  const removeFromPool = (poolId: string) => {
    setSelected(EMPTY);
    runOptimisticBulk({
      startTransition,
      items: ids,
      size: POOL_BULK_LIMIT,
      apply: hideRows,
      run: (chunk, final) => removeContactsFromPoolAction(poolId, chunk, final),
      onChunkSaved: (chunk) => applyCommitted((rows) => rows.filter((r) => !chunk.includes(r.id))),
      refresh: revalidateListsAction,
      copy: { failure: `Removing ${people(ids.length)} from the pool`, done: 'Removed', skipped: "couldn't be removed" },
      onFailure: reselect,
    });
  };

  // Tag badges in rows filter by that tag; stable so rows stay memoized.
  const navRef = useRef(nav);
  useEffect(() => {
    navRef.current = nav;
  });
  const goTag = useCallback(
    (tag: string, e: React.MouseEvent) => navRef.current.go({ tag, pool: '', q: '' }, e),
    [],
  );

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const { slots, complete, scrollToIndex } = useWindowedRows({
    rows: visible,
    // The list these rows belong to: a new one mounts a few rows per frame.
    listKey: cached ? displayKey : committedKey,
    scrollerRef: scroller,
    rowHeight: ROW_H,
    headerHeight: HEAD_H,
    focusedId,
  });
  const [announcement, setAnnouncement] = useState('');
  // A deliberate Load more moves focus to the first new row — of the list it
  // was pressed on, never one switched to while it loaded.
  const focusAfterLoad = useRef<{ key: string; index: number } | null>(null);
  const focusRow = useRef<string | null>(null);
  const { loadMore } = store;
  const onLoad = useCallback(
    (reason: 'auto' | 'user') => {
      // An automatic load racing a deliberate one must not cancel its focus.
      if (reason === 'user') focusAfterLoad.current = { key: committedKey, index: store.rows.length };
      void loadMore();
    },
    [loadMore, store.rows.length, committedKey],
  );
  useEffect(() => {
    focusAfterLoad.current = null;
    focusRow.current = null;
  }, [committedKey]);
  const seenPages = useRef(store.pages);
  useEffect(() => {
    const added = store.pages > seenPages.current;
    seenPages.current = store.pages;
    if (!added) return;
    const of = count ? ` of ${fmt(count.count)}${count.capped ? '+' : ''}` : '';
    setAnnouncement(`Loaded more contacts. Showing ${fmt(store.rows.length)}${of}.`);
    const want = focusAfterLoad.current;
    focusAfterLoad.current = null;
    const target = want && want.key === committedKey ? store.rows[want.index] : undefined;
    if (want && target) {
      focusRow.current = target.id;
      scrollToIndex(want.index);
    }
  }, [store.pages, store.rows, count, scrollToIndex, committedKey]);
  // Focus the requested row as soon as it's mounted.
  useLayoutEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    const row = scroller.current?.querySelector(`tr[data-row-id="${CSS.escape(id)}"]`);
    const target = row?.querySelector<HTMLElement>('a') ?? row?.querySelector<HTMLElement>('input');
    if (!target) return;
    focusRow.current = null;
    target.focus();
  });
  useEffect(() => {
    if (store.status === 'error') setAnnouncement("Couldn't load more contacts. Retry is available.");
  }, [store.status]);

  if (visible.length === 0 && !stale) {
    const filtered = Boolean(shownFilter.pool || shownFilter.q || shownFilter.tag);
    return (
      <EmptyState
        icon={Users}
        title={filtered ? 'No contacts match' : 'No contacts yet'}
        description={
          filtered
            ? 'Adjust the search, or add people to this pool from All contacts.'
            : 'Add a candidate manually, or share your careers page to start collecting applications.'
        }
      />
    );
  }

  // A total only describes the committed list.
  const shownTotal = !cached && !stale && count ? count : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {ids.length ? (
        <div className={`${surface} flex flex-wrap items-center gap-3 px-4 py-2.5`}>
          <span className="text-xs font-medium tabular-nums text-ink-2">
            {fmt(ids.length)} selected{shownTotal ? ` of ${fmt(shownTotal.count)}${shownTotal.capped ? '+' : ''}` : ''}
          </span>
          {staticPools.length ? (
            <span className="flex items-center gap-2">
              <span className="w-44">
                <FormSelect
                  placeholder="Add to pool…"
                  value={targetPool}
                  onChange={setTargetPool}
                  options={staticPools.map((p) => ({ value: p.id, label: p.name }))}
                />
              </span>
              <button
                disabled={!targetPool}
                onClick={() => addToPool(targetPool)}
                className={buttonClass({ variant: 'tonal', size: 'sm' })}
              >
                Add
              </button>
            </span>
          ) : (
            <span className="text-xs text-ink-2">Create a pool to add people to it.</span>
          )}
          {currentPoolId && currentPoolStatic && !cached ? (
            <button
              onClick={() => removeFromPool(currentPoolId)}
              className={buttonClass({ variant: 'ghost', size: 'sm', className: 'hover:text-critical' })}
            >
              Remove from this pool
            </button>
          ) : null}
        </div>
      ) : null}

      {/* The table is the only thing that scrolls; search and the pool bar stay put. */}
      <div
        ref={scroller}
        onScroll={(e) => {
          scrolled.current = e.currentTarget.scrollTop > 0;
        }}
        className={`${surface} relative min-h-0 flex-1 overflow-auto`}
      >
        {stale ? (
          <div
            role="progressbar"
            aria-label="Loading contacts"
            className="list-progress sticky top-0 z-20 -mb-0.5 h-0.5 w-full overflow-hidden"
          />
        ) : null}
        <table
          aria-rowcount={shownTotal && !shownTotal.capped ? shownTotal.count + 1 : -1}
          aria-busy={stale || (!cached && store.status === 'loading') || undefined}
          data-loaded-count={visible.length}
          className={cn(
            'w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-sm transition-opacity duration-150 motion-reduce:transition-none',
            stale && 'opacity-60 delay-[120ms]',
          )}
        >
          <colgroup>
            <col className="w-12" />
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col className="w-[16%]" />
            <col className="w-[16%]" />
            <col className="w-32" />
          </colgroup>
          <thead>
            <tr className="text-left" aria-rowindex={1}>
              <th className={headCell}>
                <Checkbox
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? EMPTY : new Set(visible.map((r) => r.id)))}
                  aria-label={`Select all ${fmt(visible.length)} loaded`}
                />
              </th>
              {['Name', 'Email', 'Tags', 'Latest opportunity', 'Stage'].map((h) => (
                <th key={h} className={`${headCell} text-xs font-medium text-ink-2`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            onFocus={(e) => {
              const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-row-id]');
              if (tr?.dataset.rowId) setFocusedId(tr.dataset.rowId);
            }}
          >
            {slots.map((slot) =>
              slot.kind === 'gap' ? (
                <tr key={slot.key} aria-hidden="true" style={{ height: slot.height }}>
                  <td colSpan={6} className="p-0" />
                </tr>
              ) : (
                <ContactRowView
                  key={slot.row.id}
                  row={slot.row}
                  index={slot.index}
                  selected={selected.has(slot.row.id)}
                  onToggle={toggle}
                  onTag={goTag}
                />
              ),
            )}
          </tbody>
        </table>
        <LoadMore
          scrollerRef={scroller}
          hasMore={cached ? cached.hasMore : store.hasMore}
          status={cached ? 'idle' : store.status}
          loaded={visible.length}
          total={shownTotal ? shownTotal.count : null}
          capped={shownTotal?.capped}
          noun="contacts"
          href={
            !cached && store.endCursor
              ? `${listHref('/contacts', committedKey)}${committedKey ? '&' : '?'}after=${encodeURIComponent(store.endCursor)}`
              : null
          }
          onLoad={onLoad}
          disabled={nav.pending || !complete}
        />
        {after ? (
          <p className="px-4 pb-4">
            <Link href={listHref('/contacts', committedKey)} className="text-xs text-ink-2 underline">
              Back to start
            </Link>
          </p>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

const headCell =
  'sticky top-0 z-10 h-11 whitespace-nowrap bg-surface px-4 shadow-[inset_0_-1px_0_var(--color-line)]';
const cell = 'h-[52px] truncate border-b border-line px-4 py-0';

type RowProps = {
  row: ContactRow;
  index: number;
  selected: boolean;
  onToggle: (id: string) => void;
  onTag: (tag: string, e: React.MouseEvent) => void;
};

/** Same contact data, even as a new object (a server render of rows already shown). */
function sameContact(a: ContactRow, b: ContactRow): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof ContactRow)[]) {
    if (k === 'tags' ? a.tags.join('\u0000') !== b.tags.join('\u0000') : a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * One contact, memoized on its data so a checkbox toggle, an appended page
 * or a server render of the same rows re-renders only what changed.
 */
const ContactRowView = memo(
  ContactRowCells,
  (a: RowProps, b: RowProps) =>
    sameContact(a.row, b.row) &&
    a.index === b.index &&
    a.selected === b.selected &&
    a.onToggle === b.onToggle &&
    a.onTag === b.onTag,
);

function ContactRowCells({ row: c, index, selected, onToggle, onTag }: RowProps) {
  return (
    <tr data-row-id={c.id} aria-rowindex={index + 2} className="transition-colors duration-[120ms] hover:bg-muted/60">
      <td className={cell}>
        <Checkbox checked={selected} onChange={() => onToggle(c.id)} aria-label={`Select ${c.name}`} />
      </td>
      <td className={cell}>
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={c.name} seed={c.id} size={28} />
          <span className="min-w-0 truncate">
            {c.latestOppId ? (
              <CandidateLink id={c.latestOppId} lazy className="font-medium hover:underline">
                {c.name}
              </CandidateLink>
            ) : (
              <span className="font-medium">{c.name}</span>
            )}
            {c.headline ? <span className="ml-2 text-xs text-ink-2">{c.headline}</span> : null}
          </span>
        </span>
      </td>
      <td className={`${cell} text-ink-2`}>{c.email ?? '—'}</td>
      <td className={cell}>
        {c.tags.length ? (
          <span className="flex gap-1 overflow-hidden">
            {c.tags.slice(0, 3).map((t) => (
              <Link
                key={t}
                href={listHref('/contacts', `tag=${encodeURIComponent(t)}`)}
                prefetch={false}
                onClick={(e) => onTag(t, e)}
                className={`${badge} shrink-0 hover:text-ink`}
              >
                {t}
              </Link>
            ))}
            {c.tags.length > 3 ? (
              <span className="self-center text-xs tabular-nums text-ink-2">+{c.tags.length - 3}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-ink-2">—</span>
        )}
      </td>
      <td className={`${cell} text-ink-2`}>{c.latestPosting ?? (c.latestOppId ? 'General' : '—')}</td>
      <td className={cell}>
        {c.latestStage ? <Badge tone={c.archived ? 'critical' : undefined}>{c.latestStage}</Badge> : '—'}
      </td>
    </tr>
  );
}
