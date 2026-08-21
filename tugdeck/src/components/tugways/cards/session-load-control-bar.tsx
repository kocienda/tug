/**
 * session-load-control-bar — the dev transcript's Z0 surface, split into two
 * pieces so the resting strip is part of the scrolling content while the
 * in-flight progress stays a non-shifting overlay:
 *
 *   - {@link SessionTranscriptTopRow} — the Z0 row, mounted as the list's
 *     `leadingContent` on a RESUMED session only (a `new` session has no load
 *     window to report, so the host mounts no strip at all — see
 *     `session-card-transcript.tsx`). It is the transcript's first scrolling row:
 *     off-screen when scrolled down, the first thing reached at the top, and
 *     the topmost row as older turns prepend below it. Resting content only —
 *     "Turns displayed X of Y" + a "Load N more" / "All loaded" status,
 *     flush right — so it never changes height and the transcript never hops.
 *     With nothing to "reveal", the keyboard scroll-to-top (Opt-Shift-Up)
 *     just lands on it. The bar is about the LOAD WINDOW and nothing else:
 *     it once opened with "Session created <datetime>", which is session
 *     telemetry rather than load state and now reads once in the masthead's
 *     telemetry placard.
 *   - {@link SessionLoadOverlay} — the determinate progress band + modal (inert +
 *     scrimmed) region, shown only while a cold restore or load-previous is
 *     in flight (plus the {@link PROGRESS_DWELL_MS} dwell tail). An ABSOLUTE
 *     overlay over the transcript area, never a layout sibling, so locking
 *     the region while loading never shifts the content. Works during a cold
 *     restore, when the top row's list is not yet mounted.
 *
 * **Zone discipline ([L24]).** The overlay's visibility is pure appearance,
 * so it lives in the DOM (`data-visible`), driven by a layout effect that
 * observes the store directly and runs the dwell tail — never React state
 * ([L06]/[L22]). Only the `modal` flag (region inert + scrim) enters React,
 * since `usePaneInert` is a React seam. The top row self-subscribes for its
 * data ([L02]).
 *
 * Paging is a single fixed step (25) — no "All", and no Cancel (a page, and
 * the restore, are quick enough that there's nothing slow to abort).
 *
 * @module components/tugways/cards/session-load-control-bar
 */

import "./session-load-control-bar.css";

import React from "react";

import { TugControlBar } from "@/components/tugways/tug-control-bar";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  type CodeSessionStore,
  type CodeSessionSnapshot,
} from "@/lib/code-session-store";
import type { ShellSessionStore } from "@/lib/shell-session-store";
import { deriveColdRestoreActive } from "./session-card-restore-gate";
import {
  countClaudeTurns,
  deriveControlBarState,
  deriveLoadStatus,
  type ControlBarLoadKind,
} from "./session-load-control-bar-state";

/** Default numeric "load previous" step in turns, capped to the turns that remain. */
const LOAD_PREVIOUS_STEP = 25;

/** How long the progress bar lingers, at full, after a load lands before the
 *  bar transitions to the "load more" prompt (or hides) — so the determinate
 *  bar visibly reaches the end. */
const PROGRESS_DWELL_MS = 1000;

/** A load is in flight: a load-previous, or a cold restore. Pure read over the
 *  store snapshot. The restore arm is `deriveColdRestoreActive` alone — that
 *  predicate already gates the `replaying` phase on `sessionMode === "resume"`,
 *  so a fresh *new* session's brief JSONL-missing replaying round-trip never
 *  raises this surface. (A bare `phase === "replaying"` clause here would
 *  un-gate it and flash the bar on every New session.) */
function readLoadActive(snap: CodeSessionSnapshot): boolean {
  return snap.loadingPrevious || deriveColdRestoreActive(snap);
}

export interface SessionLoadControlBarProps {
  codeSessionStore: CodeSessionStore;
  /** The scrollable transcript region the bar inerts + scrims when modal. */
  regionEl: HTMLElement | null;
}

/**
 * The Z0 row — the transcript's first scrolling row on a resumed session.
 * Mounted as the list's `leadingContent`, so it scrolls with the content (off-screen
 * when scrolled down, the first thing reached at the top) and stays the
 * topmost row as older turns prepend below it. Resting content only — the
 * in-flight progress is the {@link SessionLoadOverlay}'s job — so it never
 * changes height and the transcript never hops.
 */
export function SessionTranscriptTopRow({
  codeSessionStore,
  shellSessionStore,
}: {
  codeSessionStore: CodeSessionStore;
  shellSessionStore?: ShellSessionStore;
}): React.ReactElement {
  const onLoad = React.useCallback(
    (amount: number) => {
      codeSessionStore.loadPrevious(amount);
    },
    [codeSessionStore],
  );
  // The Compaction Summary is NOT hoisted here — it renders inline at the
  // compaction point (right above the compaction quiet line) so it stays with
  // the compaction that produced it. See the `system_note` "compact" branch in
  // `session-card-transcript.tsx`.
  return (
    <div className="session-transcript-top-row" data-slot="session-transcript-top-row">
      <ControlBarMetadata codeSessionStore={codeSessionStore} onLoad={onLoad} />
      {shellSessionStore !== undefined ? (
        <InkRestoreGapNotice shellSessionStore={shellSessionStore} />
      ) : null}
    </div>
  );
}

/**
 * The ink-restore gap notice ([P07], [feedback_never_fail_silently]).
 *
 * A `/commit` receipt and a `/match` run live only in their ledgers — no
 * replay can reconstruct them — so when a restore comes back holding fewer
 * rows than the ledger reports, the transcript is *missing* something rather
 * than merely short. Before this, that difference was invisible: the card
 * rendered a clean, shorter transcript and said nothing, which is how the
 * same loss got reported three times before anyone could name it.
 *
 * Renders only in the gap case. The restore keeps retrying on its own, so
 * this is a statement of fact with a way to hurry it, not an error to clear.
 */
function InkRestoreGapNotice({
  shellSessionStore,
}: {
  shellSessionStore: ShellSessionStore;
}): React.ReactElement | null {
  const restore = React.useSyncExternalStore(
    shellSessionStore.subscribe,
    () => shellSessionStore.getSnapshot().restore,
  );
  // Silent until an answer has landed AND that answer was short: before the
  // first answer "0 of ?" would accuse a healthy session mid-restore.
  if (!restore.answered || restore.complete) return null;
  const missing = Math.max(0, restore.ledgerTotal - restore.applied);
  if (missing === 0) return null;
  return (
    <div
      className="session-load-control-bar-ink-gap"
      data-slot="session-transcript-ink-gap"
      data-missing={missing}
    >
      <TugLabel emphasis="proposal" className="session-load-control-bar-label">
        {`${missing.toLocaleString()} shell ${missing === 1 ? "row" : "rows"} not restored yet`}
      </TugLabel>
      <span className="session-load-control-bar-meta-sep" aria-hidden="true">
        ·
      </span>
      <TugPushButton
        size="sm"
        emphasis="outlined"
        role="action"
        onClick={() => shellSessionStore.refreshRestore()}
      >
        Retry
      </TugPushButton>
    </div>
  );
}

/**
 * The load overlay — a determinate progress band + a modal (inert +
 * scrimmed) region, shown only while a cold restore or a load-previous is in
 * flight (plus the dwell tail that holds the full bar a beat past the final
 * tick). It is an ABSOLUTE overlay over the transcript area, not a layout
 * sibling, so it never shifts the content: the region locks beneath it and
 * the band paints above the scrim. Works during a cold restore too, when the
 * list (and the {@link SessionTranscriptTopRow}) is not yet mounted — there is
 * simply no region to scrim, and the band shows over the empty area.
 *
 * Zone discipline ([L24]): the band's visibility lives in the DOM
 * (`data-visible`), driven by a layout effect that observes the store
 * directly and runs the dwell tail — never React state ([L06]/[L22]). Only
 * the `modal` flag (region inert + scrim) enters React, since `usePaneInert`
 * is a React seam.
 */
export function SessionLoadOverlay({
  codeSessionStore,
  regionEl,
}: SessionLoadControlBarProps): React.ReactElement {
  const barRef = React.useRef<HTMLDivElement | null>(null);

  // Appearance ref ([L06]): the post-load dwell lives here, never React
  // state — so a dwell tick mutates the DOM without a re-render.
  const tailActiveRef = React.useRef(false);
  const tailTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLoadActiveRef = React.useRef(false);

  // `loadActive` drives the `modal` prop (region inert + scrim while a load
  // is actually in flight — not during the dwell tail). It enters React via
  // `useSyncExternalStore` ([L02]); the re-render is rare and cheap.
  const loadActive = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => readLoadActive(codeSessionStore.getSnapshot()),
  );

  // Mirror the band's visibility onto the DOM ([L06]/[L22]): visible while a
  // load is in flight OR within the dwell tail; hidden otherwise. The band's
  // single content is the progress row (`data-mode="loading"`).
  const updateBar = React.useCallback(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const snap = codeSessionStore.getSnapshot();
    const state = deriveControlBarState({
      loadingDisplay: readLoadActive(snap) || tailActiveRef.current,
    });
    bar.dataset.visible = String(state.kind === "loading");
    bar.dataset.mode = "loading";
  }, [codeSessionStore]);

  // Observe the store directly ([L22]). Runs the dwell tail: hold the full
  // progress for `PROGRESS_DWELL_MS` after a load lands, then hide the band.
  React.useLayoutEffect(() => {
    const onChange = (): void => {
      const snap = codeSessionStore.getSnapshot();
      const active = readLoadActive(snap);
      if (active) {
        if (tailTimerRef.current !== null) {
          clearTimeout(tailTimerRef.current);
          tailTimerRef.current = null;
        }
        tailActiveRef.current = false;
      } else if (prevLoadActiveRef.current) {
        // A load just landed → hold the full progress for the dwell, then
        // hide the overlay.
        tailActiveRef.current = true;
        if (tailTimerRef.current !== null) clearTimeout(tailTimerRef.current);
        tailTimerRef.current = setTimeout(() => {
          tailTimerRef.current = null;
          tailActiveRef.current = false;
          updateBar();
        }, PROGRESS_DWELL_MS);
      }
      prevLoadActiveRef.current = active;
      updateBar();
    };
    const unsubscribe = codeSessionStore.subscribe(onChange);
    onChange();
    return () => {
      unsubscribe();
      if (tailTimerRef.current !== null) clearTimeout(tailTimerRef.current);
    };
  }, [codeSessionStore, updateBar]);

  return (
    <div className="session-load-overlay" data-slot="session-load-overlay">
      <TugControlBar ref={barRef} modal={loadActive} regionEl={regionEl}>
        <ControlBarLoading codeSessionStore={codeSessionStore} />
      </TugControlBar>
    </div>
  );
}

/** Loading state — determinate progress, no Cancel. Both loads count
 *  **messages**: a cold restore loads the most recent recency window out of
 *  the session total; a load-previous pages in a fixed step (50). The bar
 *  fills toward the window and is driven to full once the load finishes, so it
 *  always reaches the end. (Cancel was removed — paged loads are a quick fixed
 *  50, so there's nothing slow to abort; the restore likewise just runs.) */
function ControlBarLoading({
  codeSessionStore,
}: {
  codeSessionStore: CodeSessionStore;
}): React.ReactElement {
  // Turns committed so far in the loaded transcript window — the cold-restore
  // progress numerator. One transcript entry is one committed turn (the
  // canonical unit, `tuglaws/turn-metric.md`), so the count is just the
  // window's entry count — matching the turns-sized denominator.
  const turnsLoaded = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().transcript.length,
  );
  // Whether the cold restore is still streaming (vs. finished — the bar is
  // held through its dwell and must show the completed pose then).
  const restoreActive = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => {
      const s = codeSessionStore.getSnapshot();
      return !s.loadingPrevious && deriveColdRestoreActive(s);
    },
  );
  // The window this resume requested — the restore progress denominator
  // (default N, or deeper for a faithful restore to an above-window anchor).
  const restoreWindow = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().restoreWindowTurns,
  );
  const loadingPrevious = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().loadingPrevious,
  );
  const loaded = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().loadingPreviousLoaded,
  );
  const target = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().loadingPreviousTarget,
  );

  // Sticky load kind: which load this progress represents. Set while a load
  // is in flight; retained through the dwell tail (both flags false) so the
  // label/format stay correct after the load lands. Self-determined so the
  // slot needs no prop and can stay mounted.
  const loadKindRef = React.useRef<ControlBarLoadKind>("restore");
  if (loadingPrevious) loadKindRef.current = "previous";
  else if (restoreActive) loadKindRef.current = "restore";
  const loadKind = loadKindRef.current;

  // Is the represented load still in flight? When false we're in the dwell
  // tail: the bar holds at full.
  const active = loadKind === "restore" ? restoreActive : loadingPrevious;

  // `loadingPreviousTarget` resets to 0 once the load completes; remember the
  // last real target so the tail keeps showing "N of N messages" instead of
  // dropping the readout (which would relayout the row).
  const lastTargetRef = React.useRef(0);
  if (loadingPrevious && target > 0) lastTargetRef.current = target;

  let label: string;
  let value: number;
  let max: number;
  let formatValue: (value: number, max: number) => string;
  if (loadKind === "restore") {
    // The window is the resume request's size in turns: the default N, or
    // deeper for a faithful restore to a saved anchor above it ([P06]).
    label = `Restoring the most recent ${restoreWindow} turns…`;
    ({ value, max } = restoreBarValueMax(turnsLoaded, restoreWindow, active));
    formatValue = formatWindowValue;
  } else {
    const effTarget = active ? target : lastTargetRef.current;
    label = "Loading earlier turns…";
    max = effTarget > 0 ? effTarget : 1;
    value = active ? Math.min(loaded, effTarget) : max;
    formatValue = formatLoadPreviousValue;
  }
  const showValue = max > 1;

  return (
    <div className="session-load-control-bar-loading">
      <TugProgressIndicator
        variant="bar"
        size={8}
        role="action"
        state="running"
        label={label}
        labelEmphasis="proposal"
        glyphPosition="right"
        value={value}
        max={max}
        {...(showValue ? { showValue: true, formatValue } : {})}
        className="session-load-control-bar-bar"
        aria-label={label}
      />
    </div>
  );
}

/**
 * Restore progress bar value/max in **turns** (the canonical unit). While the
 * load streams, the bar fills `turnsLoaded` toward the requested window. Once
 * it lands, the readout settles to the turns actually committed (a session
 * shorter than the window shows "3 of 3 turns", never a phantom "25 of 25").
 * Pure over counts so the selection is unit-testable without the component.
 */
export function restoreBarValueMax(
  turnsLoaded: number,
  restoreWindowTurns: number,
  active: boolean,
): { value: number; max: number } {
  if (active) {
    const max = restoreWindowTurns;
    return { value: Math.min(turnsLoaded, max), max };
  }
  const max = Math.max(1, Math.min(turnsLoaded, restoreWindowTurns));
  return { value: max, max };
}

/** `formatValue` for the cold-restore window readout — "3 of 25 turns". */
function formatWindowValue(value: number, max: number): string {
  return `${value.toLocaleString()} of ${max.toLocaleString()} turns`;
}

/** `formatValue` for the load-previous determinate readout. */
function formatLoadPreviousValue(value: number, max: number): string {
  return `${value.toLocaleString()} of ${max.toLocaleString()} turns`;
}

/**
 * Metadata state — the strip's resting content: "Turns displayed: X of Y" + a
 * fixed-step "Load N more" action, "All loaded" when nothing remains, or "No
 * turns" on a fresh zero-turn session. All self-subscribed ([L02]) so the slot
 * needs only the store and the load callback, and stays mounted across mode
 * swaps.
 *
 * **The bar is about the load window, and only that.** It used to open with
 * "Session created: <datetime>" on the left. That is session telemetry, not
 * load state, and it now reads once in the masthead's telemetry placard
 * alongside the branch, the state, the turn count, and the citation — where
 * the compacted-vs-created verb comes off the same `compactionSeed` this
 * component used to read. What is left here is what the bar can act on.
 */
function ControlBarMetadata({
  codeSessionStore,
  onLoad,
}: {
  codeSessionStore: CodeSessionStore;
  onLoad: (amount: number) => void;
}): React.ReactElement {
  // Claude turns, not rows: shell exchanges ride the same transcript as
  // `#s` non-context ink ([D111]), while the `of Y` denominator is the
  // segmentation engine's Claude-turn count.
  const claudeTurnsDisplayed = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => countClaudeTurns(codeSessionStore.getSnapshot().transcript),
  );
  const replayWindow = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().replayWindow,
  );
  const focusGroup = React.useId();

  const status = deriveLoadStatus({
    claudeTurnsDisplayed,
    firstLoadedTurnIndex: replayWindow?.firstLoadedTurnIndex ?? null,
    totalTurns: replayWindow?.totalTurns ?? null,
    step: LOAD_PREVIOUS_STEP,
  });

  return (
    <div className="session-load-control-bar-metadata">
      {/* The left end used to carry "Session created: <datetime>". That fact
          moved to the masthead's telemetry placard, which is where session
          telemetry lives now — the bar keeps only what is about the LOAD
          WINDOW, which is the one thing it can act on. `space-between` puts
          the remaining end flush right on its own. */}
      <div className="session-load-control-bar-meta-right">
        {status.total === 0 ? (
          // A fresh session with no committed turns yet. The bar says NOTHING:
          // the "0 of 0 · All loaded" math would read as a stuck empty page
          // rather than a new session, and the `No turns` label that used to
          // stand in its place is now the first words of the masthead's own
          // activity line, two tiers above and unmissable. Saying it twice on
          // one card made a new session look like it had a status problem.
          // The bar is about the LOAD WINDOW; a session with nothing loaded
          // has no window to speak of.
          null
        ) : (
          <>
            <TugLabel emphasis="proposal" className="session-load-control-bar-label">
              {`Turns displayed: ${status.displayed.toLocaleString()} of ${status.total.toLocaleString()}`}
            </TugLabel>
            <span className="session-load-control-bar-meta-sep" aria-hidden="true">
              ·
            </span>
            {status.hasOlder ? (
              <>
                <TugLabel
                  emphasis="proposal"
                  className="session-load-control-bar-actions-label"
                >
                  Load
                </TugLabel>
                <TugPushButton
                  size="sm"
                  emphasis="outlined"
                  role="action"
                  focusGroup={focusGroup}
                  focusOrder={0}
                  onClick={() => onLoad(status.loadStep)}
                >
                  {status.loadStep}
                </TugPushButton>
                <TugLabel
                  emphasis="proposal"
                  className="session-load-control-bar-actions-label"
                >
                  more
                </TugLabel>
              </>
            ) : (
              <TugLabel
                emphasis="proposal"
                className="session-load-control-bar-actions-label"
              >
                All loaded
              </TugLabel>
            )}
          </>
        )}
      </div>
    </div>
  );
}
