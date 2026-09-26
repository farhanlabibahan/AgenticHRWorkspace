'use client';

import Link from 'next/link';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import type { StageType } from '@prisma/client';
import { Archive, ArrowRight, Mail, Phone, Search, Tag, X } from 'lucide-react';
import { SiteIcon } from '@/components/site-icon';
import {
  bulkArchiveAction,
  bulkMoveStageAction,
  bulkTagAction,
  revalidateListsAction,
} from '@/app/(app)/actions';
import { BULK_LIMIT } from '@/lib/bulk';
import { runOptimisticBulk } from '@/lib/optimistic';
import type { ListPage, PipelineRow as PipelineRowData, StageCounts } from '@/lib/list-types';
import { listPrefetchDisabled, pipelineRowCache } from '@/lib/list-client/caches';
import { inputFromKey, listHref, listKey, PIPELINE_KEYS } from '@/lib/list-client/list-key';
import { applyListOp, type ListOp } from '@/lib/list-client/list-ops';
import { useKeysetList } from '@/lib/list-client/use-keyset-list';
import { sameScope, usePipelineNav, type PipelineNavInput } from '@/components/pipeline-nav';
import { LoadMore } from '@/components/list/load-more';
import { useWindowedRows } from '@/components/list/virtual-rows';
import { StageSelect } from '@/components/stage-select';
import { Dropdown } from '@/components/dropdown';
import { inputClass, surface, noAutofill } from '@/components/form-controls';
import { Avatar, Orb } from '@/components/ui/orb';
import { Segmented } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { CandidateLink } from '@/components/candidate-link';

export type ListRow = PipelineRowData;
type ListStage = { id: string; name: string; type?: StageType };

const ENDPOINT = '/api/lists/pipeline';
/** How long typing has to pause before the list searches. */
const LIVE_SEARCH_MS = 300;
/** Row height in px. Fixed, so a long list can be windowed without measuring. */
export const ROW_H = 52;
/** The sticky header row's height (h-11). */
const HEAD_H = 44;
/** Stage tiles warmed in idle time after each render of the list. */
const IDLE_FILL = 6;
/** Pointer rest before a hovered link loads its rows (filters out passes). */
const INTENT_MS = 60;
/**
 * While someone is using the page, check the warmed tiles this often and
 * load again the ones past the row cache's 30 s — so the first click on a
 * tile is instant however long the list has been open. An idle tab (no
 * pointer, keys or scrolling) never polls.
 */
const REWARM_MS = 5_000;
/** After an edit clears the cache, wait this long before warming again. */
const AFTER_CLEAR_MS = 3_000;
/** A tile that counts no candidates: its first page is known without asking. */
const EMPTY_PAGE: ListPage<ListRow> = { rows: [], endCursor: null, hasMore: false };

const fmt = (n: number) => n.toLocaleString('en-US');
const EMPTY = new Set<string>();

/** "Senior Designer at Northbeam" → { role: 'Senior Designer', org: 'Northbeam' } */
function splitHeadline(headline: string | null): {
  role: string | null;
  org: string | null;
} {
  if (!headline) return { role: null, org: null };
  const i = headline.lastIndexOf(' at ');
  if (i === -1) return { role: headline, org: null };
  return { role: headline.slice(0, i), org: headline.slice(i + 4) };
}

/**
 * The pipeline (Recruiting-Assistant Candidates layout): role rail with
 * client/department eyebrows and an Active/Archived toggle, stage tabs,
 * search + sort, and a selectable table with bulk actions.
 *
 * Switching views never waits on the server to look switched: the tiles and
 * filters are optimistic (usePipelineNav), and if the target's first page
 * is in the row cache — hovered, focused, warmed in idle time, or fetched at
 * the click alongside the server render — its rows paint at once. Without
 * it the current rows dim until the server's render lands. Either way the
 * server's render of the new URL commits and becomes the truth.
 */
export function PipelineList({
  stages: stagesProp,
  counts,
  page,
  after,
  postingGroups,
  clients = [],
  archiveReasons,
  fallbackGroupLabel,
}: {
  stages: ListStage[];
  /** Candidates per stage across the whole filtered pipeline, not just loaded rows. */
  counts: StageCounts;
  /** First page, rendered on the server (the page after `after`, without JavaScript). */
  page: ListPage<ListRow>;
  /** The cursor the server rendered after ('' on the first page). */
  after: string;
  postingGroups: {
    label: string | null;
    postings: { id: string; title: string }[];
  }[];
  /** Client names, for the active-filter chips. */
  clients?: { id: string; name: string }[];
  archiveReasons: { id: string; name: string }[];
  /** Eyebrow for postings without a client/department (org-kind aware). */
  fallbackGroupLabel: string;
}) {
  const nav = usePipelineNav();
  const committed = nav.committed;
  const committedKey = nav.committedKey;
  const displayKey = nav.pending ? nav.key : committedKey;
  // Every server render sends new stage objects; keep one reference while
  // they're equal, so memoized rows don't all re-render when a switch commits.
  const stages = useStable(stagesProp);
  const [, startTransition] = useTransition();

  // Every row loaded for the committed list, page after page.
  const store = useKeysetList({ listKey: committedKey, first: page, endpoint: ENDPOINT });

  // While a switch is pending, the target's cached first page if there is
  // one — fresh, or stale for a few minutes: the server's render replaces it
  // within a round trip either way (re-rendering when a click-time fetch lands).
  useSyncExternalStore(pipelineRowCache.subscribe, pipelineRowCache.version, () => 0);
  const cached = displayKey !== committedKey ? pipelineRowCache.peek(displayKey) : undefined;
  const stale = displayKey !== committedKey && !cached;
  /** The filters the rows on screen belong to. */
  const shown: PipelineNavInput = cached ? nav.input : committed;
  const currentStage = shown.stage ?? '';
  const archived = shown.status === 'archived';

  // Tile counts depend on the scope, not the stage: a stage switch keeps
  // them; a scope switch uses the cached ones, or dims until the server's.
  const scopeCounts = sameScope(nav.input, committed) ? counts : (cached?.counts ?? null);
  const countsBase = scopeCounts ?? counts;

  // Optimistic layer over the rows and counts: moves and archives show at
  // once, then the action's re-rendered page replaces them.
  const hiredStageIds = useMemo(
    () => new Set(stages.filter((s) => s.type === 'HIRED').map((s) => s.id)),
    [stages],
  );
  const [view, applyOp] = useOptimistic(
    { rows: cached ? cached.rows : store.rows, counts: countsBase.counts, total: countsBase.total },
    (state, op: ListOp) => applyListOp(state, op, currentStage, archived, hiredStageIds),
  );
  const capped = countsBase.capped;
  const countFor = (stageId: string) => view.counts[stageId] ?? 0;
  /** How many match the list on screen; null when only a floor is known. */
  const matching = capped ? (currentStage ? null : view.total) : currentStage ? countFor(currentStage) : view.total;

  // Selection and the tag draft belong to the list on screen.
  const [selection, setSelection] = useState({ key: displayKey, ids: EMPTY });
  if (selection.key !== displayKey) setSelection({ key: displayKey, ids: EMPTY });
  const selected = selection.key === displayKey ? selection.ids : EMPTY;
  const [tagDraft, setTagDraft] = useState({ key: displayKey, value: '' });
  if (tagDraft.key !== displayKey) setTagDraft({ key: displayKey, value: '' });
  const tagValue = tagDraft.key === displayKey ? tagDraft.value : '';

  // The search box follows the URL's q (back/forward) but keeps focus. A q
  // the live search itself sent must not reset the box: by the time the
  // server's render lands, the person may have typed more.
  const committedQ = committed.q ?? '';
  const [sentQ, setSentQ] = useState<string | null>(null);
  const [qDraft, setQDraft] = useState({ from: committedQ, value: committedQ });
  if (qDraft.from !== committedQ) {
    setQDraft(committedQ === sentQ ? { from: committedQ, value: qDraft.value } : { from: committedQ, value: committedQ });
  }
  const [qHint, setQHint] = useState(false);

  // Handlers rows and the rail hold on to stay stable; they read this.
  const latest = useRef({ nav, committed, hiredStageIds });
  useEffect(() => {
    latest.current = { nav, committed, hiredStageIds };
  });

  // Live search: once typing pauses, search (2+ characters, or empty to
  // clear). One query per pause, not per key, and it replaces the history
  // entry. Enter still searches at once.
  useEffect(() => {
    const q = qDraft.value.trim();
    if (q.length === 1 || q === (latest.current.nav.input.q ?? '').trim()) return;
    const timer = setTimeout(() => {
      setSentQ(q);
      latest.current.nav.go({ q }, undefined, { replace: true });
    }, LIVE_SEARCH_MS);
    return () => clearTimeout(timer);
  }, [qDraft.value]);

  const scroller = useRef<HTMLDivElement>(null);
  // A new list starts at the top. Only touch scrollTop when it moved: setting
  // it forces a layout of the whole table inside the click's task.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (!scrolled.current || !scroller.current) return;
    scroller.current.scrollTop = 0;
    scrolled.current = false;
  }, [displayKey]);

  // ---- rows the user is likely to open next -------------------------------
  const intentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const warm = useCallback((key: string, withCounts: boolean) => {
    if (key === latest.current.nav.committedKey || pipelineRowCache.get(key)) return;
    void pipelineRowCache.prefetch(key, { counts: withCounts });
  }, []);
  const intent = useCallback(
    (key: string, withCounts: boolean) => ({
      onPointerEnter: () => {
        clearTimeout(intentTimer.current);
        intentTimer.current = setTimeout(() => warm(key, withCounts), INTENT_MS);
      },
      onPointerLeave: () => clearTimeout(intentTimer.current),
      onFocus: () => warm(key, withCounts),
      onTouchStart: () => warm(key, withCounts),
    }),
    [warm],
  );

  // The committed first page is itself a cache entry: back-and-forth is instant.
  useEffect(() => {
    if (!after) pipelineRowCache.put(committedKey, { ...page, counts });
  }, [after, committedKey, page, counts]);

  // In idle time, warm the other stage tiles of this scope, busiest first.
  // A tile that counts nobody gets its (empty) page without a request.
  const generation = pipelineRowCache.generation();
  const lastGeneration = useRef(generation);
  const warmAll = useRef<(() => void) | null>(null);
  useEffect(() => {
    warmAll.current = null;
    if (nav.pending || committed.q || listPrefetchDisabled()) return;
    const cleared = lastGeneration.current !== generation;
    lastGeneration.current = generation;
    const notBefore = cleared ? Date.now() + AFTER_CLEAR_MS : 0;
    const tiles = [{ id: '', n: counts.total }, ...stages.map((s) => ({ id: s.id, n: counts.counts[s.id] ?? 0 }))];
    const keyOf = (stage: string) => listKey({ ...committed, stage }, PIPELINE_KEYS);
    const empty = counts.capped ? [] : tiles.filter((t) => t.n === 0).map((t) => keyOf(t.id));
    const keys = tiles
      .filter((t) => counts.capped || t.n > 0)
      .sort((a, b) => b.n - a.n)
      .map((t) => keyOf(t.id))
      .filter((k) => k !== committedKey)
      .slice(0, IDLE_FILL);
    let cancelled = false;
    let running = false;
    const fill = async () => {
      if (running || cancelled || Date.now() < notBefore) return;
      running = true;
      try {
        for (const key of empty) if (key !== committedKey && !pipelineRowCache.get(key)) pipelineRowCache.put(key, EMPTY_PAGE);
        for (const key of keys) {
          if (cancelled || document.hidden || pipelineRowCache.backedOff()) return;
          if (!pipelineRowCache.get(key)) await pipelineRowCache.prefetch(key);
        }
      } finally {
        running = false;
      }
    };
    warmAll.current = () => void fill();
    let idle: number | undefined;
    const timer = setTimeout(
      () => {
        if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => void fill(), { timeout: 3_000 });
        else void fill();
      },
      cleared ? AFTER_CLEAR_MS : typeof requestIdleCallback === 'function' ? 0 : 1_500,
    );
    return () => {
      cancelled = true;
      warmAll.current = null;
      clearTimeout(timer);
      if (idle !== undefined) cancelIdleCallback(idle);
    };
  }, [committedKey, generation, nav.pending, counts, stages, committed]);

  // Keep them warm while the page is in use: entries go stale after 30 s,
  // and the first click on a tile should be instant however long the list
  // has been open. Loading again only what went stale, on activity, never
  // on a timer: a tab nobody touches sends nothing.
  useEffect(() => {
    let last = Date.now();
    const onActivity = () => {
      const now = Date.now();
      if (now - last < REWARM_MS) return;
      last = now;
      warmAll.current?.();
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    for (const type of events) document.addEventListener(type, onActivity, { passive: true, capture: true });
    return () => {
      for (const type of events) document.removeEventListener(type, onActivity, { capture: true });
    };
  }, []);

  // ---- selection and edits --------------------------------------------------
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
  const setSelected = (ids: Set<string>) => setSelection({ key: displayKey, ids });
  const clear = () => setSelected(EMPTY);
  // A failed bulk edit selects the rows that didn't save again, ready to retry.
  const reselect = (unsaved: string[]) => setSelected(new Set(unsaved));

  const moveRow = useCallback(
    (id: string, stageId: string) => applyOp({ type: 'move', ids: [id], stageId }),
    [applyOp],
  );
  // A saved edit reaches the rows paged in past the first page (the server's
  // re-render covers only the first), in the same commit.
  const { applyCommitted } = store;
  const commitOp = useCallback(
    (op: ListOp) => {
      const { committed: c, hiredStageIds: hired } = latest.current;
      applyCommitted(
        (rows) => applyListOp({ rows, counts: {}, total: 0 }, op, c.stage ?? '', c.status === 'archived', hired).rows,
      );
    },
    [applyCommitted],
  );
  const saveRow = useCallback(
    (id: string, stageId: string) => commitOp({ type: 'move', ids: [id], stageId }),
    [commitOp],
  );

  const candidates = (n: number) => `${fmt(n)} candidate${n === 1 ? '' : 's'}`;
  const ids = [...selected];
  const allVisibleSelected = useMemo(
    () => view.rows.length > 0 && view.rows.every((r) => selected.has(r.id)),
    [view.rows, selected],
  );

  // ---- paging -----------------------------------------------------------------
  // The list the rows on screen belong to: a new one mounts from the top, a
  // few rows per frame (useWindowedRows), and so does each appended page.
  const shownList = cached ? displayKey : committedKey;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const { slots, complete, scrollToIndex } = useWindowedRows({
    rows: view.rows,
    listKey: shownList,
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
    const of = matching === null ? '' : ` of ${fmt(matching)}${capped ? '+' : ''}`;
    setAnnouncement(`Loaded more candidates. Showing ${fmt(store.rows.length)}${of}.`);
    const want = focusAfterLoad.current;
    focusAfterLoad.current = null;
    const target = want && want.key === committedKey ? store.rows[want.index] : undefined;
    if (want && target) {
      focusRow.current = target.id;
      scrollToIndex(want.index);
    }
  }, [store.pages, store.rows, matching, capped, scrollToIndex, committedKey]);
  // Focus the requested row as soon as it's mounted.
  useLayoutEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    const link = scroller.current?.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(id)}"] a`);
    if (!link) return;
    focusRow.current = null;
    link.focus();
  });
  useEffect(() => {
    if (store.status === 'error') setAnnouncement("Couldn't load more candidates. Retry is available.");
  }, [store.status]);
  const announcedKey = useRef(committedKey);
  useEffect(() => {
    if (announcedKey.current === committedKey) return;
    announcedKey.current = committedKey;
    const name = stages.find((s) => s.id === committed.stage)?.name ?? 'All stages';
    const n = committed.stage ? counts.counts[committed.stage] : counts.total;
    setAnnouncement(counts.capped ? `${name}: ${fmt(counts.total)}+ candidates.` : `${name}: ${candidates(n ?? 0)}.`);
  }, [committedKey]); // eslint-disable-line react-hooks/exhaustive-deps -- announce once per commit

  const listHasMore = cached ? cached.hasMore : store.hasMore;
  const busy = stale || (!cached && store.status === 'loading');

  // ---- rail -------------------------------------------------------------------
  const railBase = listKey({ ...nav.input, posting: '', stage: '' }, PIPELINE_KEYS);
  const goPosting = useCallback(
    (postingId: string, e: React.MouseEvent) => latest.current.nav.go({ posting: postingId, stage: '' }, e),
    [],
  );

  // ---- what's filtering the list, each removable ------------------------------
  const postingTitle = (id: string) =>
    postingGroups.flatMap((g) => g.postings).find((p) => p.id === id)?.title ?? 'Role';
  const filters: { key: string; label: string; value: string; clear: PipelineNavInput }[] = [];
  const inputQ = (nav.input.q ?? '').trim();
  if (inputQ) filters.push({ key: 'q', label: 'Search', value: `“${inputQ}”`, clear: { q: '' } });
  if (nav.input.client) {
    const name = clients.find((c) => c.id === nav.input.client)?.name ?? 'Client';
    filters.push({ key: 'client', label: 'Client', value: name, clear: { client: '', posting: '' } });
  }
  if (nav.input.posting) {
    filters.push({ key: 'posting', label: 'Role', value: postingTitle(nav.input.posting), clear: { posting: '', stage: '' } });
  }
  if (nav.input.stage) {
    const name = stages.find((st) => st.id === nav.input.stage)?.name ?? 'Stage';
    filters.push({ key: 'stage', label: 'Stage', value: name, clear: { stage: '' } });
  }
  if (nav.input.status === 'archived') {
    filters.push({ key: 'status', label: 'Showing', value: 'Archived', clear: { status: '', stage: '' } });
  }
  function clearSearch() {
    setQDraft({ from: committedQ, value: '' });
    setQHint(false);
    setSentQ('');
    nav.go({ q: '' });
  }
  function clearAll() {
    setQDraft({ from: committedQ, value: '' });
    setQHint(false);
    setSentQ('');
    nav.go({ q: '', client: '', posting: '', stage: '', status: '' });
  }

  return (
    <div className="flex flex-1 gap-6 overflow-hidden px-6 pb-6">
      {/* Role rail — set apart by space, not a rule */}
      <aside className="hidden w-52 shrink-0 overflow-y-auto pt-2 md:block">
        <Segmented
          className="mb-4 w-full"
          size="sm"
          value={nav.input.status === 'archived' ? 'archived' : 'active'}
          items={[
            {
              value: 'active',
              label: 'Active',
              href: nav.hrefFor({ status: '', stage: '' }),
              onClick: (e) => nav.go({ status: '', stage: '' }, e),
              onIntent: () => warm(nav.keyFor({ status: '', stage: '' }), true),
            },
            {
              value: 'archived',
              label: 'Archived',
              href: nav.hrefFor({ status: 'archived', stage: '' }),
              onClick: (e) => nav.go({ status: 'archived', stage: '' }, e),
              onIntent: () => warm(nav.keyFor({ status: 'archived', stage: '' }), true),
            },
          ]}
        />
        <PipelineRail
          base={railBase}
          current={nav.input.posting ?? ''}
          groups={postingGroups}
          fallbackGroupLabel={fallbackGroupLabel}
          onGo={goPosting}
          intent={intent}
        />
      </aside>

      {/* The table is the only thing that scrolls: tiles, search and the bulk
          bar stay put however deep the list goes. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-2">
        {/* Stage tiles — the selected one fills with ink */}
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            { id: '', name: 'All stages', count: view.total },
            ...stages.map((s) => ({ ...s, count: countFor(s.id) })),
          ].map((s) => {
            const active = (nav.input.stage ?? '') === s.id;
            const key = nav.keyFor({ stage: s.id });
            const text = capped ? (s.id ? '—' : `${fmt(view.total)}+`) : fmt(s.count);
            return (
              <Link
                key={s.id || 'all'}
                href={listHref('/pipeline', key)}
                prefetch={false}
                onClick={(e) => nav.go({ stage: s.id }, e)}
                {...intent(key, false)}
                aria-current={active ? 'true' : undefined}
                aria-label={`${s.name}, ${capped && s.id ? 'count unavailable' : text}`}
                className={cn(
                  'selectable rounded-card px-4 py-2.5',
                  active ? 'is-selected' : 'bg-surface text-ink hover:bg-muted',
                )}
              >
                <span
                  className={cn(
                    'block text-lg font-medium tabular-nums transition-opacity duration-150',
                    !scopeCounts && 'opacity-40',
                  )}
                >
                  {text}
                </span>
                <span className="block text-2xs text-ink-2">{s.name}</span>
              </Link>
            );
          })}
        </div>

        {/* Search + sort, then what's filtering the list */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form
            method="get"
            action="/pipeline"
            role="search"
            className="flex w-full max-w-md flex-col gap-1"
            onSubmit={(e) => {
              const q = qDraft.value.trim();
              if (q.length === 1) {
                e.preventDefault();
                setQHint(true);
                return;
              }
              setQHint(false);
              setSentQ(q);
              nav.go({ q }, e);
            }}
          >
            {nav.input.posting ? <input type="hidden" name="posting" value={nav.input.posting} /> : null}
            {nav.input.client ? <input type="hidden" name="client" value={nav.input.client} /> : null}
            {nav.input.stage ? <input type="hidden" name="stage" value={nav.input.stage} /> : null}
            {nav.input.status ? <input type="hidden" name="status" value={nav.input.status} /> : null}
            {nav.input.sort ? <input type="hidden" name="sort" value={nav.input.sort} /> : null}
            <label className="relative w-full">
              <Search
                size={16}
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              />
              <input {...noAutofill}
                type="search"
                name="q"
                value={qDraft.value}
                onChange={(e) => {
                  setQDraft({ from: committedQ, value: e.target.value });
                  if (qHint) setQHint(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && qDraft.value) {
                    e.preventDefault();
                    clearSearch();
                  }
                }}
                placeholder="Search name, role, location…"
                aria-label="Search candidates"
                aria-describedby={qHint ? 'pipeline-q-hint' : undefined}
                className={`${inputClass} pl-9 [&::-webkit-search-cancel-button]:appearance-none ${qDraft.value ? 'pr-9' : ''}`}
              />
              {qDraft.value ? (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  className={buttonClass({
                    variant: 'ghost',
                    size: 'xs',
                    icon: true,
                    className: 'absolute right-1.5 top-1/2 -translate-y-1/2',
                  })}
                >
                  <X />
                </button>
              ) : null}
            </label>
            {qHint ? (
              <p id="pipeline-q-hint" className="px-1 text-xs text-ink-2">
                Type at least 2 characters.
              </p>
            ) : null}
          </form>
          <Dropdown
            label="Sort"
            value={nav.input.sort === 'name' ? 'name' : 'time'}
            options={[
              { value: 'time', label: 'Time in stage' },
              { value: 'name', label: 'Name' },
            ]}
            onSelect={(value) => nav.go({ sort: value === 'name' ? 'name' : '' })}
          />
        </div>

        {filters.length ? (
          <div className="mb-4 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {filters.map((f) => (
              <span
                key={f.key}
                className="inline-flex h-7 max-w-64 items-center gap-1 rounded-full bg-surface pl-3 pr-1 text-xs text-ink"
              >
                <span className="text-ink-2">{f.label}</span>
                <span className="truncate">{f.value}</span>
                <button
                  type="button"
                  onClick={() => (f.key === 'q' ? clearSearch() : nav.go(f.clear))}
                  aria-label={`Remove ${f.label.toLowerCase()} filter`}
                  className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors duration-[120ms] hover:bg-muted hover:text-ink"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {filters.length > 1 ? (
              <button type="button" onClick={clearAll} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
                Clear all
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mb-1" />
        )}

        {/* Bulk actions — a canvas toolbar, so the white Dropdown pills read */}
        {selected.size > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium tabular-nums text-ink-2">
              {fmt(selected.size)} selected{matching === null ? '' : ` of ${fmt(matching)}`}
            </span>
            <span className="flex items-center gap-1.5">
              <ArrowRight size={13} className="text-ink-2" />
              <Dropdown
                label="Move to stage"
                options={stages.map((s) => ({ value: s.id, label: s.name }))}
                onSelect={(stageId) => {
                  if (!stageId) return;
                  clear(); // urgent: outside the transition so the bar goes now
                  runOptimisticBulk({
                    startTransition,
                    items: ids,
                    size: BULK_LIMIT,
                    apply: (chunk) => applyOp({ type: 'move', ids: chunk, stageId }),
                    run: (chunk, final) => bulkMoveStageAction(chunk, stageId, final),
                    onChunkSaved: (chunk) => commitOp({ type: 'move', ids: chunk, stageId }),
                    refresh: revalidateListsAction,
                    copy: { failure: `Moving ${candidates(ids.length)}`, done: 'Moved', skipped: "couldn't be moved" },
                    onFailure: reselect,
                  });
                }}
              />
            </span>
            {/* Archived candidates can only be moved or tagged; re-archiving changes nothing. */}
            {!archived ? (
              <span className="flex items-center gap-1.5">
                <Archive size={13} className="text-ink-2" />
                <Dropdown
                  label="Archive as"
                  options={archiveReasons.map((r) => ({
                    value: r.id,
                    label: r.name,
                  }))}
                  onSelect={(reasonId) => {
                    if (!reasonId) return;
                    clear(); // urgent: outside the transition so the bar goes now
                    runOptimisticBulk({
                      startTransition,
                      items: ids,
                      size: BULK_LIMIT,
                      apply: (chunk) => applyOp({ type: 'remove', ids: chunk }),
                      run: (chunk, final) => bulkArchiveAction(chunk, reasonId, final),
                      onChunkSaved: (chunk) => commitOp({ type: 'remove', ids: chunk }),
                      refresh: revalidateListsAction,
                      copy: { failure: `Archiving ${candidates(ids.length)}`, done: 'Archived', skipped: "couldn't be archived" },
                      onFailure: reselect,
                    });
                  }}
                />
              </span>
            ) : null}
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const tag = tagValue.trim();
                if (!tag) return;
                const contactIds = view.rows.filter((r) => selected.has(r.id)).map((r) => r.contactId);
                // Tags aren't shown in this table, so there's nothing to show early;
                // the selection and the tag stay until the save is done.
                runOptimisticBulk({
                  startTransition,
                  items: contactIds,
                  size: BULK_LIMIT,
                  run: (chunk, final) => bulkTagAction(chunk, tag, final),
                  refresh: revalidateListsAction,
                  copy: { failure: 'Tagging', done: 'Tagged', skipped: "couldn't be tagged" },
                  onSuccess: () => {
                    setTagDraft({ key: displayKey, value: '' });
                    clear();
                  },
                });
              }}
            >
              <Tag size={13} className="text-ink-2" />
              <input {...noAutofill}
                value={tagValue}
                onChange={(e) => setTagDraft({ key: displayKey, value: e.target.value })}
                placeholder="Add tag…"
                aria-label="Tag selected candidates"
                className={`${inputClass} h-8 w-32`}
              />
            </form>
            <button
              onClick={clear}
              className={buttonClass({
                variant: 'ghost',
                size: 'sm',
                icon: true,
                className: 'ml-auto',
              })}
              title="Clear selection"
              aria-label="Clear selection"
            >
              <X />
            </button>
          </div>
        ) : null}

        {/* Table */}
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
              aria-label="Loading candidates"
              className="list-progress sticky top-0 z-20 -mb-0.5 h-0.5 w-full overflow-hidden"
            />
          ) : null}
          <table
            aria-rowcount={matching === null || capped ? -1 : matching + 1}
            aria-busy={busy || undefined}
            data-loaded-count={view.rows.length}
            className={cn(
              'w-full min-w-[900px] table-fixed border-separate border-spacing-0 text-sm transition-opacity duration-150 motion-reduce:transition-none',
              stale && 'opacity-60 delay-[120ms]',
            )}
          >
            <colgroup>
              <col className="w-12" />
              <col className="w-[22%]" />
              <col className="w-24" />
              <col className="w-[20%]" />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
              <col className="w-36" />
              <col className="w-20" />
            </colgroup>
            <thead>
              <tr aria-rowindex={1}>
                <th className={headCell}>
                  <Checkbox
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelected(allVisibleSelected ? EMPTY : new Set(view.rows.map((r) => r.id)))
                    }
                    aria-label={`Select all ${fmt(view.rows.length)} loaded`}
                  />
                </th>
                {[
                  'Full name',
                  'Profiles',
                  'Current role',
                  'Organization',
                  'Location',
                  'Stage',
                  'In stage',
                ].map((h) => (
                  <th key={h} className={`${headCell} text-left text-xs font-medium text-ink-2`}>
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
                    <td colSpan={8} className="p-0" />
                  </tr>
                ) : (
                  <PipelineRow
                    key={slot.row.id}
                    row={slot.row}
                    index={slot.index}
                    selected={selected.has(slot.row.id)}
                    archived={archived}
                    stages={stages}
                    onToggle={toggle}
                    onMove={moveRow}
                    onSaved={saveRow}
                  />
                ),
              )}
              {view.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-ink-2">
                    No candidates match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <LoadMore
            scrollerRef={scroller}
            hasMore={listHasMore}
            status={cached ? 'idle' : store.status}
            loaded={view.rows.length}
            total={matching}
            capped={capped}
            noun="candidates"
            href={
              !cached && store.endCursor
                ? `${listHref('/pipeline', committedKey)}${committedKey ? '&' : '?'}after=${encodeURIComponent(store.endCursor)}`
                : null
            }
            onLoad={onLoad}
            disabled={nav.pending || !complete}
          />
          {after ? (
            <p className="px-4 pb-4">
              <Link href={listHref('/pipeline', committedKey)} className="text-xs text-ink-2 underline">
                Back to start
              </Link>
            </p>
          ) : null}
        </div>
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>
    </div>
  );
}

/**
 * The posting rail. Memoized: a stage switch doesn't touch its 200 links,
 * whose hrefs only depend on the scope (`base`, without posting or stage).
 */
const PipelineRail = memo(function PipelineRail({
  base,
  current,
  groups,
  fallbackGroupLabel,
  onGo,
  intent,
}: {
  base: string;
  current: string;
  groups: { label: string | null; postings: { id: string; title: string }[] }[];
  fallbackGroupLabel: string;
  onGo: (postingId: string, e: React.MouseEvent) => void;
  intent: (key: string, withCounts: boolean) => Record<string, () => void>;
}) {
  const baseInput = inputFromKey(base, PIPELINE_KEYS);
  const keyFor = (posting: string) => listKey({ ...baseInput, posting }, PIPELINE_KEYS);
  return (
    <>
      <Link
        href={listHref('/pipeline', keyFor(''))}
        prefetch={false}
        onClick={(e) => onGo('', e)}
        {...intent(keyFor(''), true)}
        className={cn(
          'flex h-8 items-center rounded-full px-3 text-sm transition-colors duration-[120ms]',
          !current ? 'bg-surface text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
        )}
      >
        All candidates
      </Link>
      {groups.map((g) => (
        <div key={g.label ?? 'general'} className="mt-4">
          <p className="mb-1 px-3 text-xs font-medium text-ink-2">{g.label ?? fallbackGroupLabel}</p>
          {g.postings.map((p) => (
            <Link
              key={p.id}
              href={listHref('/pipeline', keyFor(p.id))}
              prefetch={false}
              onClick={(e) => onGo(p.id, e)}
              {...intent(keyFor(p.id), true)}
              aria-current={current === p.id ? 'true' : undefined}
              className={cn(
                'flex h-8 items-center gap-2 rounded-full px-3 text-sm transition-colors duration-[120ms]',
                current === p.id ? 'bg-surface text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
              )}
            >
              <Orb seed={p.id} size={10} />
              <span className="truncate">{p.title}</span>
            </Link>
          ))}
        </div>
      ))}
    </>
  );
});

const headCell =
  'sticky top-0 z-10 h-11 whitespace-nowrap bg-surface px-4 shadow-[inset_0_-1px_0_var(--color-line)]';
const cell = 'h-[52px] truncate border-b border-line px-4 py-0';

/** Same row data, even as a new object (a server render of rows already shown). */
function sameRow(a: ListRow, b: ListRow): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof ListRow)[]) if (a[k] !== b[k]) return false;
  return true;
}

/** `value` itself while it stays deep-equal to what came before (small, JSON-safe values). */
function useStable<T>(value: T): T {
  const [kept, setKept] = useState({ value, json: JSON.stringify(value) });
  if (kept.value === value) return value;
  const json = JSON.stringify(value);
  if (json === kept.json) return kept.value;
  setKept({ value, json });
  return value;
}

type RowProps = {
  row: ListRow;
  index: number;
  selected: boolean;
  archived: boolean;
  stages: ListStage[];
  onToggle: (id: string) => void;
  onMove: (id: string, stageId: string) => void;
  onSaved: (id: string, stageId: string) => void;
};

/**
 * One candidate. Memoized on its row's data (not object identity), the
 * selection and the stable handlers, so a checkbox toggle, an appended page
 * or a server render of the same rows doesn't re-render the rows around it.
 */
const PipelineRow = memo(
  PipelineRowView,
  (a: RowProps, b: RowProps) =>
    sameRow(a.row, b.row) &&
    a.index === b.index &&
    a.selected === b.selected &&
    a.archived === b.archived &&
    a.stages === b.stages &&
    a.onToggle === b.onToggle &&
    a.onMove === b.onMove &&
    a.onSaved === b.onSaved,
);

function PipelineRowView({
  row: r,
  index,
  selected,
  archived,
  stages,
  onToggle,
  onMove,
  onSaved,
}: RowProps) {
  const { role, org } = splitHeadline(r.headline);
  return (
    <tr
      data-row-id={r.id}
      aria-rowindex={index + 2}
      className="transition-colors duration-[120ms] hover:bg-muted/60"
    >
      <td className={cell}>
        <Checkbox checked={selected} onChange={() => onToggle(r.id)} aria-label={`Select ${r.name}`} />
      </td>
      <td className={cell}>
        <CandidateLink id={r.id} lazy className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.name} seed={r.contactId} size={28} />
          <span className="truncate font-medium hover:underline">{r.name}</span>
        </CandidateLink>
      </td>
      <td className={cell}>
        <span className="flex items-center gap-2 text-ink-2">
          {r.email ? (
            <a href={`mailto:${r.email}`} title={r.email} className="hover:text-ink">
              <Mail size={14} />
            </a>
          ) : null}
          {r.phone ? (
            <span title={r.phone}>
              <Phone size={14} />
            </span>
          ) : null}
          {r.link ? (
            <a
              href={r.link.startsWith('http') ? r.link : `https://${r.link}`}
              target="_blank"
              title={r.link}
              className="hover:text-ink"
            >
              <SiteIcon url={r.link} />
            </a>
          ) : null}
          {!r.email && !r.phone && !r.link ? '—' : null}
        </span>
      </td>
      <td className={`${cell} text-ink-2`}>{role ?? '—'}</td>
      <td className={`${cell} text-ink-2`}>{org ?? '—'}</td>
      <td className={`${cell} text-ink-2`}>{r.location ?? '—'}</td>
      <td className={cell}>
        {archived ? (
          <span className="text-xs text-ink-2">Archived</span>
        ) : (
          <StageSelect
            onSurface
            opportunityId={r.id}
            currentStageId={r.stageId}
            stages={stages}
            onMove={(stageId) => onMove(r.id, stageId)}
            onSaved={(stageId) => onSaved(r.id, stageId)}
          />
        )}
      </td>
      <td
        className={cn(
          cell,
          'text-xs tabular-nums',
          r.days > 14 ? 'text-critical' : r.days > 7 ? 'text-caution' : 'text-ink-2',
        )}
      >
        {r.daysInStage}
      </td>
    </tr>
  );
}
