/**
 * `SessionHistoryView` — the History view-route's transcript-slot view
 * ([P01]/[P10]). On the `↺` route this replaces the transcript with the
 * card's own project git log rendered as a {@link TugHistoryList} — one
 * compact commit row per commit.
 *
 * Data rides the shared `gitLogStore()` (`GIT_LOG` feed) — the card knows
 * its own `projectDir` from the binding, so the Cards card-follow indirection is
 * gone. The store is an app-level singleton keyed by one requested root, so
 * `requestLog` fires only while THIS card's History view is the active slot
 * (`active`), and the render gates on `requestedRoot === projectDir` — two
 * cards viewing history of different projects at once is a known
 * single-store limitation, not a correctness hazard (each re-requests when
 * it regains focus). `GIT_HEAD` auto-refreshes the store after a commit.
 *
 * ## Paging
 *
 * History is read a page at a time and grows downward, the way a feed does.
 * Two things ask for the next page, both through the store's idempotent
 * `loadMore`:
 *
 *  - An `IntersectionObserver` watching a sentinel at the foot of the list,
 *    rooted on the scroller with a margin so the page is already in flight by
 *    the time the reader arrives at the bottom.
 *  - A top-up pass after every payload change, for the two cases an
 *    intersection cannot report: a page that did not fill the shade (so the
 *    sentinel never left the viewport and never re-fires), and a live filter
 *    whose matches are thin — there, the walk keeps going until the filter has
 *    enough rows to show or history runs out, so a match forty commits back is
 *    found rather than hidden behind a scroll the reader has no reason to make.
 *
 * Pages APPEND, so the scroller's content only ever grows at the bottom: every
 * row already on screen keeps its offset and the reader's place does not move.
 * That is also why the store holds the current payload through a refresh — the
 * one thing that would jump the list is having it emptied and rebuilt.
 *
 * ## Filtering
 *
 * The `TugFilterField` in the header strip trims the list to the commits whose
 * hash, message, details, or changed paths match ({@link commitFilterFields});
 * diffs are deliberately not searched. The query is this view's own React
 * state — the field and the list are in one component, so the module-store
 * adapter the Cards card sections need does not apply here.
 *
 * Beside it, a `TugOptionGroup` AIMS the filter: Hash / Message / Detail /
 * Files, all on by default, each independently switchable
 * ({@link useCommitFilterScope} holds the reader's standing choice deck-wide).
 * A word common in file paths otherwise swamps the one commit whose subject
 * says it — narrowing is how a filter stays a way of finding one commit rather
 * than a way of listing many.
 *
 * Laws: [L02] the log store enters React through `useSyncExternalStore`;
 * [L06] no appearance state in React; [L28] the store is the source of both
 * the log and its retry policy — this view subscribes and asks once per root,
 * and never re-derives "request again" from a phase the store publishes.
 *
 * @module components/tugways/cards/session-history/session-history-view
 */

import "./session-history-view.css";

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type React from "react";
import { History as HistoryIcon } from "lucide-react";

import {
  TugHistoryList,
  commitFilterFields,
} from "@/components/tugways/tug-history-list";
import { TugNonRepoNotice } from "@/components/tugways/tug-non-repo-notice";
import {
  TugNoGitNotice,
  shouldShowNoGitNotice,
} from "@/components/tugways/tug-no-git-notice";
import { useHostTools } from "@/lib/host-tools-store";
import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import type { TugFilterFieldDelegate } from "@/components/tugways/tug-filter-field";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugOptionGroup } from "@/components/tugways/tug-option-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { useCommitMetaFields } from "@/lib/commit-meta-fields";
import { useCommitFilterScope } from "@/lib/commit-filter-scope";
import {
  useFocusManager,
  useSeedKeyView,
} from "@/components/tugways/use-focusable";
import { CardIdContext } from "@/lib/card-id-context";
import { filterAndRank } from "@/lib/text-match";
import {
  gitLogStore,
  type GitLogStoreSnapshot,
} from "@/lib/git-log-store";

const EMPTY_SNAPSHOT: GitLogStoreSnapshot = {
  phase: "idle",
  requestId: null,
  requestedRoot: null,
  payload: null,
  loadingMore: false,
  error: null,
};

/**
 * How close to the foot of the scroller the next page starts loading. Wide
 * enough that a page is already in flight before the reader reaches the end.
 */
const PREFETCH_MARGIN_PX = 500;

/**
 * How many matching rows a live filter walks history for before it stops
 * paging on its own. Comfortably more than the shade shows at any height, so
 * the reader gets a full screen of matches and the scroll gesture takes over
 * from there.
 */
const FILTERED_ROW_TARGET = 25;

/**
 * How deep a filter's own paging will go looking for those matches.
 *
 * Without a bound, a term matching nothing would walk the entire repository one
 * page at a time — thousands of commits and a `git log` fork for each — for a
 * query the reader may still be halfway through typing. This caps the automatic
 * walk; the reader's scroll still pages past it without limit, and the foot
 * SAYS how far the search reached rather than quietly stopping.
 */
const FILTER_AUTO_PAGE_DEPTH = 400;

/** Read the shared Git History store reactively ([L02]). */
function useGitLogSnapshot(): GitLogStoreSnapshot {
  const store = gitLogStore();
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
}

export interface SessionHistoryViewProps {
  /** Repo-relative project directory the card is bound to. */
  projectDir: string | null;
  /** True while the `↺` route is the active slot — gates the singleton request. */
  active: boolean;
  /** Hide the Shade — the header's close affordance ([P05]). */
  onClose?: () => void;
}

export function SessionHistoryView({
  projectDir,
  active,
  onClose,
}: SessionHistoryViewProps): React.ReactElement {
  const snapshot = useGitLogSnapshot();
  // Whether this machine carries a git at all ([L02]). There is no history
  // without one, and no way to make one from here.
  const hostTools = useHostTools();

  // Which metadata the rows carry — the reader's standing choice, persisted
  // deck-wide through tugbank ([D07]). `TugOptionGroup` emits `setValue` with
  // the new set through the responder chain ([L11]); nothing about it is
  // per-card, so the shade reads and writes the one deck default.
  const { fields: metaFields, setFields } = useCommitMetaFields();
  const metaSenderId = useId();

  // Where the filter looks — the reader's other standing choice, persisted the
  // same way and read by the same responder form. Both groups dispatch
  // `setValue` with a `string[]`; the sender id is what tells them apart.
  const { scope: filterScope, setScope } = useCommitFilterScope();
  const scopeSenderId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    setValueStringArray: {
      [metaSenderId]: setFields,
      [scopeSenderId]: setScope,
    },
  });

  // Focus language ([P14]): the shade's one Tab stop is Done, and Done is the
  // shade's seeded key view.
  //
  // The commit list is deliberately NOT a stop. A stop has to be worth landing
  // on — some act belongs to it — and the list is a transcript-like reading
  // surface with no act of its own. Worse, while it held the key view the shade
  // painted TWO rings at once: the list's keyboard-focus ring and, because the
  // key view was a non-button, Done's persistent default ring beneath it. One
  // keyboard, one mark. With Done holding the key view its own ring IS the
  // Return promise, and the deck shows exactly one.
  //
  // What it should mean to Tab into a scrolling reading surface is a real
  // question and an open one; until it has an answer, the list is out.
  const focusGroup = useId();
  const DONE_ORDER = 1;
  // The filter field registers BEHIND Done at order -1 with a `skip` policy,
  // exactly as the Cards card section bands do: click-reachable and
  // ArrowDown-escapable, but out of the Tab walk and never the seeded key
  // view — Done stays the shade's opening destination, so Return still
  // means Done.
  const FILTER_ORDER = -1;
  const focusGated = active && onClose !== undefined;
  useSeedKeyView(focusGated ? `${focusGroup}:${DONE_ORDER}` : null);

  // The scroller node, for the intersection root and the top-up measurement.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const setScrollerRef = useCallback((el: HTMLDivElement | null): void => {
    scrollerRef.current = el;
  }, []);

  // ── Filtering ────────────────────────────────────────────────────────────
  const [filterQuery, setFilterQuery] = useState("");
  const focusManager = useFocusManager();
  const cardId = useContext(CardIdContext);
  const filterDelegate = useMemo<TugFilterFieldDelegate>(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      // ArrowDown leaves the field for the shade's one stop — Done, in the
      // footer below. The list is not a stop, so there is nothing between them.
      filterFieldDidRequestAdvance: () => {
        if (cardId === null) return;
        focusManager?.place(
          cardId,
          { kind: "focus-key", focusKey: `${focusGroup}:${DONE_ORDER}` },
          { modality: "keyboard" },
        );
      },
    }),
    [cardId, focusGroup, focusManager],
  );

  // Request only while this card's History view is the active slot (the store
  // is a singleton keyed by one root). Idempotent via the store's
  // requested-key guard; `GIT_HEAD` auto-refreshes the store after a commit.
  // Re-request when the singleton's root has drifted away from ours (another
  // card requested its project while we were away).
  //
  // Keyed on the root ALONE — never on `phase` ([L28]). The store is the source
  // of both the data and the retry policy; an effect that re-requested on a
  // phase the store publishes synchronously would drive the source from the
  // source's own output and spin. Recovery is the activation pass below.
  useEffect(() => {
    if (!active || projectDir === null) return;
    if (snapshot.requestedRoot === projectDir) return;
    gitLogStore()?.requestLog(projectDir);
  }, [active, projectDir, snapshot.requestedRoot]);

  // Two snapshots for our root are stale rather than wrong, and neither moves
  // on its own: a cached `no_repo` (the dir may have been `git init`'d out of
  // band — an unborn HEAD moves no HEAD, so no GIT_HEAD signal shakes it
  // loose), and an `error` (the send found no connection, which may since have
  // come back). `requestLog` no-ops on the same root, so revalidate explicitly
  // — once per activation, the ref gating it so neither a genuinely non-repo
  // dir nor a still-dead connection can spin.
  const revalidated = useRef(false);
  useEffect(() => {
    if (!active) {
      revalidated.current = false;
      return;
    }
    if (revalidated.current || projectDir === null) return;
    if (snapshot.requestedRoot !== projectDir) return;
    const stale =
      snapshot.phase === "error" ||
      (snapshot.phase === "ready" && snapshot.payload?.no_repo === true);
    if (!stale) return;
    revalidated.current = true;
    gitLogStore()?.refresh();
  }, [active, projectDir, snapshot]);

  // ── Paging ───────────────────────────────────────────────────────────────

  // While the singleton is showing another card's project, treat it as loading
  // for us until our request lands.
  const payload =
    snapshot.requestedRoot === projectDir ? snapshot.payload : null;
  const commits = payload?.commits;
  const filtered = useMemo(
    () =>
      commits === undefined
        ? []
        : filterAndRank(commits, filterQuery, (commit) =>
            commitFilterFields(commit, filterScope),
          ),
    [commits, filterQuery, filterScope],
  );

  // The sentinel enters React state rather than a ref so the observer effect
  // re-runs the moment it mounts (it exists only once the list has content).
  // A node handle is not appearance ([L06] is untouched).
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

  // The scroll driver: the next page starts loading a screen-ish before the
  // reader reaches the foot. `loadMore` is a no-op unless there is more to
  // fetch and nothing in flight, so the observer may fire freely.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!active || root === null || sentinel === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          gitLogStore()?.loadMore();
        }
      },
      { root, rootMargin: `${PREFETCH_MARGIN_PX}px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [active, sentinel]);

  // The top-up pass, for the two cases an intersection cannot report. An
  // observer only fires on a CHANGE in intersection, so a page that lands
  // while the sentinel is already visible — because the shade is taller than
  // the content, or because the filter dropped nearly all of it — raises no
  // event and the walk would stall short.
  //
  // This does not re-derive a request from a phase ([L28]): each pass consumes
  // `has_more`, which only ever turns off, and every page strictly advances
  // the offset, so the walk terminates at the root commit. A `loadMore` the
  // store declines changes nothing, which is precisely what stops the effect
  // from re-entering.
  useEffect(() => {
    if (!active || payload === null) return;
    if (!payload.has_more || snapshot.loadingMore) return;
    const root = scrollerRef.current;
    if (root === null) return;
    const wantsMore =
      filterQuery === ""
        ? root.scrollHeight - root.scrollTop - root.clientHeight <
          PREFETCH_MARGIN_PX
        : filtered.length < FILTERED_ROW_TARGET &&
          payload.commits.length < FILTER_AUTO_PAGE_DEPTH;
    if (wantsMore) gitLogStore()?.loadMore();
  }, [active, payload, snapshot.loadingMore, filterQuery, filtered.length]);

  // The automatic walk stopped short of history's end — say so, with the depth
  // it reached. A cap the reader cannot see reads as "that's all there is".
  const searchCapped =
    filterQuery !== "" &&
    payload !== null &&
    payload.has_more &&
    !snapshot.loadingMore &&
    payload.commits.length >= FILTER_AUTO_PAGE_DEPTH;

  // Only a repo with commits gets a filter — but once it has one, keep it
  // through an empty result set, so a query that matches nothing still has a
  // field to clear.
  const filterable =
    payload !== null && !payload.no_repo && payload.commits.length > 0;

  // The view fills the sheet's shade body ([P17]): the header strip pinned
  // above, the scrolling view below. The shade panel (geometry, scrim,
  // grabber, modality, Escape close) is `TugSheetContent
  // presentation="shade"` — mounted by the Session card around this view.
  const shell = (children: React.ReactNode): React.ReactElement => (
    <ResponderScope>
      <div className="tug-sheet-shade-header">
        <BlockStrip
          altitude="section"
          className="tool-call-header"
          dataTestid="session-history-header"
          leading={
            <span className="tool-call-header-leading tug-line-box" aria-hidden="true">
              <HistoryIcon size={14} />
            </span>
          }
          name="History"
          // The filter holds the header's trailing edge, where the Cards card
          // sections carry theirs — pinned above the scroller, so the control
          // that trims the list never scrolls away from it. Mounted only for a
          // repo with commits: there is nothing to trim otherwise, and a field
          // over "No commits" would be an affordance that does nothing. It
          // survives that gate once shown, so filtering to zero can never
          // strand the field that is the only way back.
          actions={
            filterable ? (
              <>
                <TugFilterField
                  delegate={filterDelegate}
                  placeholder="Filter commit history"
                  aria-label="Filter commit history"
                  data-testid="session-history-filter"
                  focusGroup={focusGroup}
                  focusOrder={FILTER_ORDER}
                  focusPolicy="skip"
                />
                {/* Where the field looks. Beside the field, not in the footer
                    with the row-metadata toggles: this one changes what the
                    list CONTAINS, so it belongs to the control it modifies and
                    within a glance of the query being typed. Focus-refusing
                    (every `TugOptionGroup` item is), so aiming mid-query never
                    takes the caret out of the field. */}
                <TugOptionGroup
                  value={filterScope as string[]}
                  senderId={scopeSenderId}
                  size="xs"
                  emphasis="default"
                  aria-label="Filter targets"
                  data-testid="session-history-filter-scope"
                  items={[
                    { value: "hash", label: "Hash", title: "Match the commit hash" },
                    { value: "message", label: "Message", title: "Match the commit subject and message body" },
                    { value: "detail", label: "Detail", title: "Match the author, committer, and date" },
                    { value: "files", label: "Files", title: "Match the paths the commit changed" },
                  ]}
                />
              </>
            ) : undefined
          }
        />
      </div>
      <div
        ref={setScrollerRef}
        className="session-history-view"
        data-slot="session-history-view"
      >
        {children}
      </div>
      {/* Plain-sheet footer ([P17]): History takes over neither the composer's
          Z5 nor a commit mode, so it carries its own dismissal — a Done button
          in the lower right, which is both the shade's seeded key view and its
          sole Tab stop (Escape / Cmd-. still close it too). The actions row
          follows the sheet-gallery spec (`.tug-sheet-actions`: right-aligned,
          sheet spacing). */}
      {onClose !== undefined ? (
        <div
          className="session-history-view-footer tug-sheet-actions"
          ref={responderRef as (el: HTMLDivElement | null) => void}
        >
          {/* The metadata toggles hold the footer's leading edge, opposite
              Done: what each row states about its commit is a reading choice,
              so it sits with the list it governs rather than in Settings. */}
          <TugOptionGroup
            value={metaFields as string[]}
            senderId={metaSenderId}
            size="xs"
            emphasis="default"
            aria-label="Commit row metadata"
            data-testid="session-history-meta-options"
            items={[
              { value: "author", label: "Author" },
              { value: "date", label: "Date" },
              { value: "time", label: "Time" },
            ]}
          />
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            onClick={onClose}
            data-testid="session-history-done"
            focusGroup={focusGroup}
            focusOrder={DONE_ORDER}
            persistentDefaultRing
          >
            Done
          </TugPushButton>
        </div>
      ) : null}
    </ResponderScope>
  );

  if (projectDir === null) {
    return shell(
      <div className="session-history-empty">No project bound to this session.</div>,
    );
  }

  // No git means no history to read and no `git init` that could produce one,
  // so this reading precedes the non-repo offer here exactly as it does in the
  // Changes shade — the two shades say the same thing on the same machine.
  if (shouldShowNoGitNotice(hostTools)) {
    return shell(<TugNoGitNotice />);
  }
  if (payload?.no_repo) {
    return shell(<TugNonRepoNotice projectDir={projectDir} />);
  }
  if (snapshot.requestedRoot === projectDir && snapshot.phase === "error") {
    return shell(
      <div className="session-history-empty">
        {snapshot.error ?? "Failed to load history."}
      </div>,
    );
  }
  if (payload === null) {
    return shell(<div className="session-history-empty">Loading history…</div>);
  }
  if (payload.commits.length === 0) {
    return shell(<div className="session-history-empty">No commits</div>);
  }
  if (filtered.length === 0) {
    // Every commit loaded was walked and none matched. What that MEANS depends
    // on where the walk stands — still running, stopped at its own depth, or
    // finished at the root commit — so say which rather than a bare "none".
    return shell(
      <div className="session-history-empty" data-testid="session-history-no-matches">
        {filterScope.length === 0
          ? // Nothing is being read at all — a real state the reader chose, and
            // the one no-match message that has an answer worth naming.
            `Nothing can match “${filterQuery}” — every filter target is off.`
          : searchCapped
            ? `No commits match “${filterQuery}” in the newest ${payload.commits.length}. Scroll to search further back.`
          : payload.has_more
            ? "Searching further back…"
            : `No commits match “${filterQuery}”.`}
      </div>,
    );
  }

  return shell(
    <div className="session-history-view-body">
      <TugHistoryList
        commits={filtered}
        projectDir={projectDir}
        metaFields={metaFields}
        filterQuery={filterQuery}
        filterScope={filterScope}
      />
      {/* The foot of the walk. The sentinel is what the observer watches, so
          it must sit inside the scroller and below the last row; the note
          beside it is the only thing that says a page is on its way. */}
      <div className="session-history-view-foot" ref={setSentinel}>
        {snapshot.loadingMore ? (
          <span data-testid="session-history-loading-more">Loading more…</span>
        ) : searchCapped ? (
          // The automatic search stopped at its own depth, not at history's
          // end. Saying how far it reached is the difference between "that's
          // every match" and "that's every match SO FAR".
          <span data-testid="session-history-search-capped">
            Searched the newest {payload.commits.length} commits — scroll to
            search further back.
          </span>
        ) : null}
      </div>
    </div>,
  );
}
