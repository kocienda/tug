/**
 * session-card-telemetry-renderers.tsx — small, focused React components
 * that render one datum each from the session card's per-turn and
 * session-cumulative telemetry surface.
 *
 * Each renderer is **placement-agnostic**: it takes the data it needs
 * (a store, a `TurnEntry`, etc.) and renders a deterministic display
 * fragment. The same renderer is suitable for the status-bar /
 * prompt-entry-top / prompt-entry-footer (session-scoped renderers)
 * or the per-turn trailing slot (per-turn renderers); the experiment
 * harness decides which datum lands in which zone.
 *
 * Conformance:
 *  - [L02] Session-scoped renderers subscribe to `CodeSessionStore` via
 *    `useSyncExternalStore`. Live-clock-dependent renderers also
 *    subscribe to a shared per-second tick so the displayed clock
 *    moves between store updates (the tick is a tiny external store
 *    backed by `setInterval`; the renderer's `getSnapshot` reads
 *    `Date.now()` derivatively).
 *  - [L06] Renderers produce only text + primitives (TugLinearGauge for
 *    the window-utilization datum). No React state for visible-only
 *    appearance.
 *  - [L19] Each renderer is a self-contained React function component.
 *  - [L20] No new token slots authored — renderers consume the host's
 *    layout box plus existing component-tier primitives.
 *
 * @module components/tugways/cards/session-card-telemetry-renderers
 */

import "./session-card-telemetry-renderers.css";

import React, {
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Archive, MessageCircleQuestion, ShieldAlert } from "lucide-react";

import { TugArcGauge } from "@/components/tugways/tug-arc-gauge";
import { createPortal } from "react-dom";
import { TugPaneFrameContext } from "@/components/chrome/tug-pane";
import { raisePaneAbovePeers } from "@/components/tugways/pane-raise";
import { getDeckStore } from "@/lib/deck-store-registry";
import {
  compactionProgressStore,
  useIsCompactingCard,
} from "@/lib/compaction-progress-store";
import { unfoldCardForBiddenSurface } from "@/lib/card-fold";
import { afterFoldCrossing } from "@/lib/fold-crossing";
import { isTugMotionEnabled } from "@/components/tugways/scale-timing";
import { COMPACTION_REFUSAL_TEXT } from "@/components/tugways/cards/compaction-progress-sheet";
import { cardFoldedOf } from "@/deck-store-selectors";
import {
  FocusManagerContext,
  type FocusPolicy,
} from "@/components/tugways/focus-manager";
import { CardIdContext } from "@/lib/card-id-context";
import { TugPlacard } from "@/components/tugways/tug-placard";
import { TugStatusCell } from "@/components/tugways/tug-status-cell";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { SideQuestionBody } from "@/components/tugways/cards/side-question-overlay";
import { useAnnotationContext } from "@/components/tugways/cards/transcript-host-helpers";
import {
  TugProgressIndicator,
  type TugProgressIndicatorState,
} from "@/components/tugways/tug-progress-indicator";
import {
  sessionSessionPhaseKey,
  sessionSessionPhaseVisual,
  SESSION_PHASE_LABELS,
  type SessionPhaseInput,
} from "@/lib/code-session-store/session-phase-visual";
import { useSessionJoinReady } from "@/lib/code-session-store/use-session-phase";
import { ARC_JOIN_READY_CELL_WORD } from "@/lib/arc-join-register";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { TurnEntry } from "@/lib/code-session-store/types";
import {
  computeRichContextBreakdown,
  deriveJobExtendedActiveMs,
  deriveSessionTotals,
  deriveTimeCellMs,
  turnHasTiming,
} from "@/lib/code-session-store/telemetry";
import {
  deriveContextWindows,
  turnWindowTokens,
} from "@/lib/code-session-store/end-state";
import { useLifecycleTick } from "@/lib/code-session-store/hooks/use-lifecycle-tick";
import { deriveColdRestoreActive } from "@/components/tugways/cards/session-card-restore-gate";
import { resolveModelContextMax } from "@/lib/model-context-max";
import { knownModelRows } from "@/lib/model-label";
import { readModelCatalog } from "@/lib/model-catalog";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import type { SideQuestionStore } from "@/lib/side-question-store";
import type { PendingContextStore } from "@/lib/pending-context-store";
import { useSessionStateChanges } from "@/lib/session-state-changes-store";

import {
  ContextPopoverContent,
  ArcPopoverContent,
  JobsPopoverContent,
  StateChangeLogPopoverContent,
  TasksPopoverContent,
  TimePopoverContent,
  type ScrollToRowHandler,
} from "./session-card-telemetry-popovers";
import { arcGlanceFraction } from "@/lib/arc-meta-facts";
import { arcMarkFraction } from "@/components/tugways/arc-lifecycle-mark";
import { arcCellWord } from "@/components/tugways/tug-arc-track";
import { useArcForSession } from "@/lib/arc-session-index";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { useTaskListState } from "@/lib/code-session-store/hooks/use-task-list-state";
import { useJobsState } from "@/lib/code-session-store/hooks/use-jobs-state";
import {
  countJobs,
  countRunningJobs,
  jobsOwnedByTurn,
} from "@/lib/code-session-store/select-jobs";
import { goalIsActive } from "@/lib/code-session-store/select-goal";
import {
  cellDisplayCount,
  composeJobsCellSummary,
  arcCellNumerals,
  arcCellPose,
  formatCellCount,
  formatTaskFraction,
  jobsCellActiveCount,
  jobsCellDisplayPose,
  jobsRecentlyDone,
  nextLingerExpiryMs,
  tasksCellPose,
  tasksRecentlyDone,
  WORK_LINGER_MS,
} from "@/lib/code-session-store/select-work";
import {
  composeTaskSummary,
  countTasks,
} from "@/components/tugways/body-kinds/todo-list-block";

// ---------------------------------------------------------------------------
// Pure-logic formatters (exported for tests)
// ---------------------------------------------------------------------------

/** Format a token count as `12.3k` or `1.05M`. Tiny counts render exact. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Same magnitudes as `formatTokens` but with **uppercase** suffixes —
 * `K` (kilo), `M` (mega), `G` (giga). Instrument-shorthand convention
 * adopted for the Z2 status row in #step-20-4.
 *
 * Signed: a negative count renders with a leading U+2212 minus sign
 * (`-208.3K`). The per-turn token figure is a signed window delta — a
 * `/compact` turn shrinks the window — and the cell shows that
 * honestly rather than clamping a real shrink to `0`.
 */
export function formatTokensCaps(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 0) return `−${formatTokensCaps(-n)}`;
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}G`;
}

/**
 * A **ceiling** in the same uppercase shorthand — `200K`, `1M`, `128K`.
 *
 * Deliberately not {@link formatTokensCaps}. That one formats a *measurement*,
 * where a tenth is information: `11.5K` of context used is a different reading
 * from `11.4K`. A context window is a *round number the model was shipped with*,
 * so its decimals are always zeros — `200.0K`, `1.00M` — and they cost four
 * characters of a status row that has none to spare while communicating nothing.
 * Any real fraction is kept (a `1.5M` cap would render as `1.5M`); it is only
 * the trailing zeros that go.
 */
export function formatTokenCap(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const trim = (value: number): string =>
    value.toFixed(1).replace(/\.0$/, "");
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}G`;
}

/** Format milliseconds as `1.2s` / `34s` / `2m 03s` / `1h 04m`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) {
    const tenths = Math.floor((ms % 1_000) / 100);
    return totalSec < 10 ? `${totalSec}.${tenths}s` : `${totalSec}s`;
  }
  if (totalSec < 3_600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  const h = Math.floor(totalSec / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/**
 * Always-hours time format — `Hh Mm SSs` shape at every magnitude.
 * `0h 0m 12s` even when below an hour; `4h 30m 00s` for a marathon
 * session. Always includes the seconds component. Used by the time
 * popover's per-turn rows, where the uniform `Hh Mm SSs` shape keeps
 * the stacked figures column-aligned.
 */
export function formatTimeAlwaysHours(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0h 0m 00s";
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(totalSec / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s.toString().padStart(2, "0")}s`;
}

/**
 * Conditional-hours time format — `Mm SSs` for any span under an
 * hour, `Hh MMm SSs` once a single span crosses the hour mark. The
 * status row's TIME cell uses this so the common case (turns lasting
 * seconds or a few minutes) reads without a vestigial leading `0h`;
 * an hour-plus turn still surfaces its hours component. Always
 * includes a zero-padded seconds component; once past an hour the
 * minutes component is zero-padded too, so the hour-plus display holds
 * a stable width as the minutes tick.
 */
export function formatTimeMinutesSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0m 00s";
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  const s = (totalSec % 60).toString().padStart(2, "0");
  const m = Math.floor((totalSec % 3_600) / 60);
  if (totalSec < 3_600) return `${m}m ${s}s`;
  const h = Math.floor(totalSec / 3_600);
  return `${h}h ${m.toString().padStart(2, "0")}m ${s}s`;
}

/** Format a USD cost as `$0.0123` (4 decimals when small, 2 when ≥ $1). */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$0";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Live-tick external store — one shared interval, all session-clock
// renderers subscribe via `useSyncExternalStore` per [L02].
// ---------------------------------------------------------------------------

/**
 * Module-scoped 1Hz tick. Lazy-started on first subscribe; stopped
 * when the last subscriber unsubscribes. The "snapshot" is the last
 * tick wall-clock ms; renderers read it (or `Date.now()` directly,
 * which is fine because `useSyncExternalStore` only re-renders when
 * the snapshot reference changes — and the snapshot changes once per
 * tick).
 */
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickValue = 0;

function startTick(): void {
  if (tickTimer !== null) return;
  tickValue = Date.now();
  tickTimer = setInterval(() => {
    tickValue = Date.now();
    for (const fn of tickListeners) fn();
  }, 1_000);
}

function stopTickIfIdle(): void {
  if (tickListeners.size === 0 && tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  startTick();
  return () => {
    tickListeners.delete(listener);
    stopTickIfIdle();
  };
}

function getTick(): number {
  return tickValue;
}

/**
 * Hook returning the current 1Hz tick value. Renderers that need a
 * live clock subscribe; the underlying interval starts on first
 * subscription and stops when nothing subscribes.
 *
 * Exported for the Jobs popover's per-row elapsed readout — the leaf
 * `JobElapsedValue` component mounts only while the popover is open,
 * so an idle session with running jobs pays no tick until the user
 * actually looks.
 */
export function useLiveTick(): number {
  return useSyncExternalStore(subscribeTick, getTick, getTick);
}

// ---------------------------------------------------------------------------
// Session-scoped renderers
// ---------------------------------------------------------------------------

export interface SessionTelemetryProps {
  codeSessionStore: CodeSessionStore;
  sessionMetadataStore?: SessionMetadataStore;
}

/**
 * Props for {@link SessionTelemetryStatusRow} — the session telemetry
 * props plus the optional transcript-scroll handler the Time / Tokens
 * popovers thread onto their per-turn `#u{turn}` / `#a{turn}` addresses.
 */
export interface SessionTelemetryStatusRowProps extends SessionTelemetryProps {
  /**
   * Scrolls the transcript to a transcript row when the user clicks
   * its `#u{turn}` / `#a{turn}` address in the Time / Tokens popover. The
   * session card supplies it (it owns the transcript's imperative handle);
   * omitted in the gallery / fixtures, where the addresses render as
   * inert text.
   */
  onScrollToRow?: ScrollToRowHandler;
  /**
   * Author the row's cells into a focus group ([P10] revised) — when set,
   * **each cell is its own leaf cycle stop** (Tab moves cell-to-cell,
   * no arrow-roving), like the Z4B chips. Supplied by the session card's
   * cycle scope; omitted in the gallery / fixtures, where the cells are
   * not Tab stops.
   */
  focusGroup?: string;
  /**
   * Order of the FIRST cell (STATE) within {@link focusGroup}; the cells
   * take consecutive orders left→right (STATE, TIME, CONTEXT, TASKS,
   * JOBS = base + 0…4).
   */
  focusOrderBase?: number;
  /** Walk policy when registered (`accept` default; `skip` = a11y-only). */
  focusPolicy?: FocusPolicy;
  /**
   * Side-question store behind the `/btw` placard. There is no BTW cell — the
   * placard is reached by asking (`/btw`, via `openSideQuestions`), not by
   * clicking the strip — so this store feeds the placard body alone. Omitted in
   * the gallery / fixtures, where the placard has nothing to show.
   */
  sideQuestionStore?: SideQuestionStore;
  /**
   * Staged-context queue for the `/btw` overlay's Add-to-context action. When
   * set, each answered side question shows a toggle to stage it (or un-stage
   * it) for the next `❯` submission; omitted in the gallery / fixtures.
   */
  pendingContextStore?: PendingContextStore;
}

/**
 * Which Z2 detail surface the shared {@link TugPlacard} shows. Each key
 * matches a status cell's `data-priority`, so the host can find the cell to
 * anchor the placard under it.
 */
export type PlacardKind =
  | "state"
  | "time"
  | "context"
  | "tasks"
  | "arc"
  | "jobs"
  | "btw";

/**
 * The cell a placard anchors under, when that is not the cell its own key
 * names.
 *
 * `arc` is the one entry: the ARC reading is the TASKS cell wearing a
 * different label, so it keeps `data-priority="tasks"` — the width table and
 * the anchor query are both keyed on that attribute, and moving it would cost
 * the cell its measured box as well as its anchor.
 */
const PLACARD_ANCHOR_PRIORITY: Partial<Record<PlacardKind, string>> = {
  arc: "tasks",
};

/** Placard header title per surface — the placard header carries these now
 *  that the composed `TugPopupList` frames render headerless. */
const PLACARD_TITLES: Record<PlacardKind, string> = {
  state: "State",
  time: "Time",
  context: "Context",
  tasks: "Tasks",
  // The arc's own name rides inside the body: these are static strings, and
  // the placard header is the surface's legend rather than its subject.
  arc: "Arc",
  jobs: "Jobs",
  btw: "/btw",
};

/**
 * Imperative handle for {@link SessionTelemetryStatusRow}. Lets the session card open a
 * status-row placard programmatically — the surfaces the `/context` and
 * `/tasks` slash commands map to (they show the same breakdown a click on the
 * cell shows, no separate sheet). The session card passes the ref straight to
 * the row it renders into Z2; a null ref (an owner supplying its own
 * `statusBarContent` instead) makes these no-ops.
 */
export interface SessionTelemetryStatusRowHandle {
  /** Open the CONTEXT placard (the `/context`-style breakdown). */
  openContext(): void;
  /** Open the TASKS placard (the numbered checklist) — the `/tasks`
   *  surface. */
  openTasks(): void;
  /** Open the JOBS placard (goal / running / scheduled / finished) —
   *  the `/bashes` surface. */
  openJobs(): void;
  /** Open the `/btw` placard (the side-question body). */
  openSideQuestions(): void;
}

/**
 * The context-window denominator for the session's model: the session's
 * resolved `system_metadata.model` sized against claude's own capability rows
 * (the live `initialize` list when a session is up, else the persisted
 * catalog — [model-context-max.ts] reads the window out of the row's wording).
 *
 * Both gauges that divide by a window run this one hook, so the CONTEXT cell
 * and the utilization strip cannot disagree. Nothing known yet → the 200k
 * unknown default, same as any unrecognized model.
 *
 * Law [L02]: the metadata snapshot enters React through `useSyncExternalStore`.
 */
function useModelContextMax(store: SessionMetadataStore | undefined): number {
  const snapshot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (store === undefined) return () => {};
        return store.subscribe(listener);
      },
      [store],
    ),
    useCallback(() => store?.getSnapshot() ?? null, [store]),
  );
  const model = snapshot?.model ?? null;
  const models = snapshot?.models;
  return useMemo(
    () =>
      resolveModelContextMax(
        model,
        knownModelRows(models ?? [], readModelCatalog()),
      ),
    [model, models],
  );
}

/**
 * Window-utilization gauge — the context-window occupancy after the
 * most-recent committed turn (`window(latest)` from the transcript
 * window-walk: the last turn's last-iteration `input + output +
 * cache-read + cache-creation`) divided by the static context-window
 * max for the active model.
 *
 * Uses TugLinearGauge in `compact` density so the strip fits inside
 * a status-bar or prompt-entry footer without dominating layout.
 */
export const SessionTelemetryWindowUtilization: React.FC<SessionTelemetryProps> = ({
  codeSessionStore,
  sessionMetadataStore,
}) => {
  const snap = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  const max = useModelContextMax(sessionMetadataStore);
  // Resident context after the latest committed turn — the transcript
  // window-walk (carry-forward over any zero-usage turn). `0` for a
  // fresh session before `sessionInitTokens` is captured.
  const windows = deriveContextWindows(
    snap.transcript.map((t) => t.cost),
    snap.sessionInitTokens ?? 0,
    snap.transcript.map((t) => t.compactionPostTotal ?? null),
  );
  const contextTokens =
    windows.length > 0
      ? windows[windows.length - 1].window
      : snap.sessionInitTokens ?? 0;
  const maxText = formatTokens(max);
  // Render value as `current / max` so the denominator is visible
  // beneath the arc's proportional sweep. The "tokens" label rides
  // the gauge's separate label slot (which TugArcGauge renders in a
  // flex column below the value at compact density). Cascade-scoped
  // CSS (see session-card.css under `.session-card-status-bar`) drops the
  // primitive's default ALL-CAPS / mono treatment for this surface.
  const formatRatio = useCallback(
    (v: number) => `${formatTokens(v)} / ${maxText}`,
    [maxText],
  );
  return (
    <TugArcGauge
      className="session-telemetry-window-utilization"
      data-slot="session-telemetry-window-utilization"
      value={contextTokens}
      min={0}
      max={max}
      density="compact"
      formatValue={formatRatio}
      thresholds={{ caution: 0.75, danger: 0.9 }}
    />
  );
};

/**
 * Cumulative session input + cache-read + cache-creation + output
 * tokens. Sum across every committed turn — the lifetime tokens cost
 * of the session so far.
 */
export const SessionTelemetryCumulativeTokens: React.FC<SessionTelemetryProps> = ({
  codeSessionStore,
}) => {
  const snap = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  const totals = deriveSessionTotals(snap.transcript);
  const total =
    totals.totalInputTokens +
    totals.totalCacheReadTokens +
    totals.totalCacheCreationTokens +
    totals.totalOutputTokens;
  return (
    <span
      className="session-telemetry-text"
      data-slot="session-telemetry-cumulative-tokens"
    >
      {formatTokens(total)} tokens
    </span>
  );
};

/**
 * Cumulative session Claude-active time across every committed turn.
 * In-flight turns are NOT added — the precise live-segment computation
 * (subtracting awaiting-approval + transport-downtime windows) requires
 * the internal reducer state and lives outside this placement-agnostic
 * renderer. Subscribes to a 1Hz tick so any side-channel that flips
 * the committed sum mid-second still surfaces promptly.
 */
export const SessionTelemetryCumulativeActiveMs: React.FC<SessionTelemetryProps> = ({
  codeSessionStore,
}) => {
  const snap = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  // Subscribe to the live tick so the display refreshes even when no
  // store dispatch has fired. The tick value itself is unused — the
  // store snapshot is the source of truth for the committed total.
  useLiveTick();
  const committed = deriveSessionTotals(snap.transcript).totalActiveMs;
  return (
    <span
      className="session-telemetry-text"
      data-slot="session-telemetry-cumulative-active-ms"
    >
      {formatDurationMs(committed)}
    </span>
  );
};

/**
 * Phase / "Claude is thinking" indicator — surfaces the session's
 * coarse-grained `phase` enum. Useful in Z4 (prompt-entry footer)
 * during the HMR study to compare against ambient-light placements.
 */
export const SessionTelemetryPhase: React.FC<SessionTelemetryProps> = ({
  codeSessionStore,
}) => {
  const phase = useSyncExternalStore(
    codeSessionStore.subscribe,
    useCallback(
      () => codeSessionStore.getSnapshot().phase,
      [codeSessionStore],
    ),
  );
  return (
    <span className="session-telemetry-text" data-slot="session-telemetry-phase">
      {phase}
    </span>
  );
};

/**
 * An unbidden arrival a folded card answers in its Z2 row ([B03]) — one of the
 * two inline dialogs the transcript carries, which a folded card is not
 * showing.
 */
export type FoldArrival = "question" | "permission";

/**
 * What stands in the Z2 row in place of the five telemetry cells on a folded
 * card. `"compaction"` is the [B04] `inhabit` tier — a surface that gave up its
 * sheet to live in the row — and the two arrivals are the `defer` tier's
 * notice, which offers **Unfold** rather than presenting anything itself.
 */
export type FoldOccupant = "compaction" | FoldArrival;

/** What an arrival's notice reads. Pure; exported so a test can pin it. */
export function foldArrivalTitle(arrival: FoldArrival): string {
  return arrival === "question"
    ? "A question is waiting"
    : "Permission is waiting";
}

/**
 * Which face of the run the Z2 row is wearing, written on the row as
 * `data-face` ([B05]):
 *
 *   - `showing`  — the card is folded and the row IS the run's face.
 *   - `leaving`  — an unfold is in flight with motion on; the row fades over
 *                  the crossing. With motion off the row stays `showing`
 *                  until the cover has drawn, and then goes `behind`.
 *   - `behind`   — the card is open and the cover is the face; the occupant
 *                  stands in the tree, hidden, waiting for the next fold.
 *
 * The compaction occupant is mounted for the run's whole length whichever
 * face is up, and every transition between the three is an attribute change
 * on one live element rather than a mount or an unmount. That is the whole
 * point: the old shape derived the occupant from the fold flag and held a
 * `departing` flag in state set from an effect, so the unfold's first
 * committed render had NO occupant — the instruments painted for a frame, the
 * occupant unmounted, and a beat later it mounted again wearing the departure
 * with its arrival animation re-armed underneath ([F04]). An attribute
 * written in a layout effect lands before that first paint, on the element
 * that never left.
 *
 * Why the row travels: Z2 is `position: sticky; bottom: 0` for the crossing's
 * length, so the row the user is watching rides DOWN with the frame and is in
 * view the whole way, and the run's other face is not up yet either — the
 * cover waits for the same crossing to end. `leaving` is what keeps the run
 * on screen through that.
 *
 * Motion off and reduced motion never leave — there is no crossing to ride,
 * and the layout snap IS the settle — which is the predicate the card's own
 * fold effect and the cover's raise both use, for the reason all three must
 * agree about which folds are carried.
 *
 * Written on the ROW rather than the occupant because the row is what hides
 * the instruments, and the two have to move together: the cells stand down
 * while a folded face is showing or leaving and come back the moment the
 * face is `behind`, in the same attribute write. [L06]: appearance through the
 * DOM, never React state.
 */
export type CompactionFace = "showing" | "leaving" | "behind";

function useCompactionFace(
  rowRef: React.RefObject<HTMLDivElement | null>,
  compacting: boolean,
  foldedShowing: boolean,
  paneFrameEl: HTMLElement | null,
): void {
  // The fold read one run behind, so an unfold can be told from a card that
  // was open all along. Only the unfold has a crossing to ride.
  const wasFoldedRef = useRef(foldedShowing);
  useLayoutEffect(() => {
    const wasFolded = wasFoldedRef.current;
    wasFoldedRef.current = foldedShowing;
    const row = rowRef.current;
    if (row === null) return;
    if (!compacting) {
      row.removeAttribute("data-face");
      return;
    }
    if (foldedShowing) {
      row.setAttribute("data-face", "showing");
      return;
    }
    // Every path that is not "a compacting card just unfolded" goes straight
    // BEHIND rather than merely declining to leave. A `leaving` left standing
    // would keep the instruments hidden under a cover that is already up.
    if (!wasFolded || paneFrameEl === null) {
      row.setAttribute("data-face", "behind");
      return;
    }
    // An UNFOLD. With motion on the row `leaves`: it fades over the closing
    // portion of the crossing on a window that outlasts the end event by the
    // cover's rise. With motion off there is no crossing and nothing to fade
    // — the departure would be instant and the row invisible — so the face
    // stays `showing` instead: the row is simply the run's face until the
    // cover is.
    const motion = isTugMotionEnabled();
    const heldFace = motion ? "leaving" : "showing";
    if (motion) row.setAttribute("data-face", "leaving");
    // `behind` waits for the departure to FINISH and then one more frame, not
    // for the crossing to end: the row's fade is timed to run past the end
    // event by the cover's rise ([B06]), so the two faces overlap for a beat,
    // and a `behind` written at the end event would cut the row off the moment
    // the cover began. The extra frame is for the cover itself — it is raised
    // at the end event and mounts in a later commit, so a `behind` on the
    // event's own frame gave the instruments one frame under no cover, which
    // is [F04]'s flash on a different clock. The crossing's end is still the
    // gate (it is when the cover is raised; with no crossing the probe fires on
    // the next frame), and the animations are read off the live element then.
    let cancelled = false;
    let settleFrame: number | null = null;
    const stopWaiting = afterFoldCrossing(paneFrameEl, () => {
      const occupant = row.querySelector<HTMLElement>(
        '[data-slot="session-telemetry-status-occupant"]',
      );
      const running = occupant?.getAnimations() ?? [];
      void Promise.allSettled(running.map((a) => a.finished)).then(() => {
        if (cancelled) return;
        settleFrame = window.requestAnimationFrame(() => {
          settleFrame = null;
          if (cancelled) return;
          if (row.getAttribute("data-face") !== heldFace) return;
          row.setAttribute("data-face", "behind");
        });
      });
    });
    return () => {
      cancelled = true;
      stopWaiting();
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
    };
  }, [rowRef, foldedShowing, compacting, paneFrameEl]);
}

/**
 * The focus group the folded row's Cancel registers in, and the `group:order`
 * key that addresses it. A constant rather than a `useId` because the session
 * card's fold reclaim has to name it: while a run is in flight on a folded
 * card, Return means Cancel ([B02]), and the card lands its Return-home here
 * instead of on the fold control. Focus keys are scoped to the card's own
 * focus context, so one name serves every card.
 */
export const COMPACTION_CANCEL_FOCUS_GROUP = "session-compaction-cancel";
export const COMPACTION_CANCEL_FOCUS_KEY = `${COMPACTION_CANCEL_FOCUS_GROUP}:0`;

/**
 * The compaction occupant — a folded card's Z2 row while a `/compact` runs.
 *
 * **It is the cover sheet, on one line.** The same four things the
 * `CompactionProgressSheet` shows, in the same order the eye reads them there
 * and wearing the same clothes: the sheet header's `Archive` icon and
 * "Compacting" title at the header's own size and weight, the sheet's 8px
 * barber pole stretched across the middle, and the sheet's own filled primary
 * Cancel on the trailing edge. Nothing here is a smaller or different
 * rendering of any of them — a fold hands the run between its two faces
 * without changing what the user is looking at.
 *
 * Cancel is the run's own cancel, taken off the store rather than rebuilt here:
 * while the card is folded this row IS the run's surface, so without it the one
 * way to stop a compaction would be to unfold first.
 *
 * Its own component, rather than markup inline in the row, because it has a
 * lifetime: the REFUSAL flash is registered for exactly as long as this face is
 * mounted ([B08]). A compacting card refuses every door but the fold, and while
 * the card is folded there is no cover to flash the refusal on — so the row
 * takes the same voice, swapping its title to {@link COMPACTION_REFUSAL_TEXT}
 * for the flash's length. Same attribute, same forced-reflow restart, same CSS
 * shape as the cover's line ([L06]): removing `data-refused` and reading
 * `offsetWidth` before re-adding it is what restarts the animation on a SECOND
 * refused press, which without the reflow the browser coalesces away — and a
 * gesture that draws nothing reads as the app ignoring it, the exact failure
 * the flash exists to prevent.
 */
function CompactionOccupant({
  cardId,
  showing,
}: {
  cardId: string | null;
  /** Whether the row is the run's showing face — the card is folded. */
  showing: boolean;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    // Only the SHOWING face files for the refusal flash: the occupant is
    // mounted behind the cover too ([B05]), and a face nobody can see must not
    // answer for the cover's refusal.
    if (cardId === null || !showing) return;
    return compactionProgressStore.registerRefusalNudge(cardId, () => {
      const el = rootRef.current;
      if (el === null) return;
      el.removeAttribute("data-refused");
      void el.offsetWidth;
      el.setAttribute("data-refused", "");
    });
  }, [cardId, showing]);
  // The row's Cancel is the run's live default while the row is the run's
  // showing face — seeded onto the key view exactly as the cover's Cancel is
  // ([B02]). The filled fill and the double ring both key on the focus
  // manager's projection, which stamps them only when the key view is not
  // some other button; a fold is performed by clicking a button, so without
  // this seed the fold control holds the key view when the row appears and
  // the row's Cancel is refused the ring ([F02]). Seeding makes the same
  // claim the sheet makes: Return on a compacting card means Cancel. Not
  // while the row is leaving — a face on its way out is nobody's default.
  //
  // The seed is one-shot and a child's, so on the fold that brings this row
  // up it runs BEFORE the card's own fold effect reclaims the keyboard. That
  // reclaim is why the key is a stable constant rather than a `useId`: the
  // card reads {@link COMPACTION_CANCEL_FOCUS_KEY} and lands Return here
  // rather than on the fold control while a run is in flight, so the two
  // agree about where a folded compacting card's Return lives.
  //
  // And the seed alone is a position, not a paint. The ring paints only while
  // keyboard-focus mode is engaged, and what engages it for the cover is that
  // the cover is a TRAPPED focus mode — a surface appearing, in the engine's
  // derivation. The row is the same surface on one line, so it pushes the
  // same trap for as long as it is the run's showing face: Tab is scoped to
  // Cancel as it is under the cover, the ring paints without the user
  // asking, and Escape flashes the run's refusal exactly as the cover's
  // Escape does — a compaction has no keyboard exit on either face. Neither
  // the trap nor the seed stands while the row is leaving or behind the
  // cover: a face on its way out is nobody's default, and behind the cover
  // the cover's own trap and seed are the ones in force.
  const { FocusModeScope } = useFocusTrap({
    active: showing,
    onEscapeDismiss: () => {
      if (cardId !== null) compactionProgressStore.refuse(cardId);
    },
  });
  // Seeded on every rising edge of `showing`, not once. `useSeedKeyView` is
  // one-shot per mount, which was the whole of it while the occupant mounted
  // per fold; now that it stands for the run's length ([B05]) a one-shot seed
  // would claim the key view on the FIRST fold of a run and on none of the
  // folds after it, and the cover — which does still mount per raise — would
  // go on re-seeding its own. The card's fold reclaim covers the same ground
  // for a first-responder card; this covers a card folding in the background,
  // whose reclaim stands down by design.
  const focusManager = useContext(FocusManagerContext);
  useLayoutEffect(() => {
    if (!showing || focusManager === null) return;
    focusManager.place(
      cardId,
      { kind: "focus-key", focusKey: COMPACTION_CANCEL_FOCUS_KEY },
      { modality: "keyboard" },
    );
  }, [showing, focusManager, cardId]);
  return (
    <div
      ref={rootRef}
      className="session-telemetry-status-occupant"
      data-slot="session-telemetry-status-occupant"
      data-occupant="compaction"
      role="status"
    >
      {/* The mark, the title and the bar as ONE group, centred in the row's
          full width by the CSS grid ([B03]); Cancel rides the trailing edge
          on its own. The wrapper is what gives the three a width to centre. */}
      <span
        className="session-telemetry-occupant-group"
        data-slot="session-telemetry-occupant-group"
      >
        {/* The sheet header's icon: the same `Archive` the cover is raised
            with, in a box the CSS sizes to the header's own icon column. */}
        <span className="session-telemetry-occupant-icon" aria-hidden>
          <Archive size="100%" />
        </span>
        {/* The running title: the sheet's own title, and the only reading
            this seat measures. Its refusal counterpart is a sibling of the
            GROUP rather than a child of this seat — see the sibling below. */}
        <span className="session-telemetry-occupant-title" data-title-swap>
          <span data-occupant-title="running">Compacting</span>
        </span>
        {/* The sheet's barber pole, at the sheet's 8px, in the sheet's own
            colour: no role, so `running` resolves to `action` — the theme's
            key blue — exactly as the sheet's does. An `inherit` here painted
            the bar in the row's prose colour, which nobody chose ([B01]). The
            CSS gives it a fixed width so the group has a width to centre
            ([B03], [B04]). */}
        <span className="session-telemetry-occupant-bar" aria-hidden>
          <TugProgressIndicator
            variant="bar"
            size={8}
            state="running"
            aria-hidden
          />
        </span>
      </span>
      {/* The refusal reading, laid across the row rather than seated beside
          the title. Both readings are mounted and CSS chooses between them off
          `data-refused` — a swap through React state would be an appearance
          change through the wrong channel ([L06]) and would make the flash a
          re-render rather than an animation.

          It sits OUTSIDE the group because it is half again as wide as the
          run's own reading, and a seat measuring both made the group the
          refusal's width at rest: the bar left the mark and the title it
          belongs with and came to rest against Cancel, which is the one
          reading of this row that is wrong ([B03]). Absolute, it measures
          nothing, so neither reading moves the other. */}
      <span
        className="session-telemetry-occupant-refusal"
        data-occupant-title="refused"
      >
        {COMPACTION_REFUSAL_TEXT}
      </span>
      {/* The sheet's Cancel, exactly: `sm`, filled primary, wearing the
          persistent default ring the sheet's does, inside the row's own
          trapped mode so it is the one stop the walk has while the run is
          folded. */}
      <FocusModeScope>
        <TugPushButton
          className="session-telemetry-occupant-action"
          emphasis="primary"
          role="action"
          size="sm"
          focusGroup={COMPACTION_CANCEL_FOCUS_GROUP}
          focusOrder={0}
          persistentDefaultRing
          onClick={() => {
            if (cardId !== null) compactionProgressStore.requestCancel(cardId);
          }}
        >
          Cancel
        </TugPushButton>
      </FocusModeScope>
    </div>
  );
}

/**
 * Combined session status row — production Z2 surface promoted from
 * the workshop gallery. Layout:
 *
 *     STATE   TIME   CONTEXT   TASKS   JOBS
 *
 * Measurements sit left, work sits right, and the two work cells are
 * neighbors so the split reads as one story. Five cell anchors, each
 * opening a popover on click:
 *
 *   - **STATE** → `StateChangeLogPopoverContent` driven by
 *     `useSessionStateChanges(snap.tugSessionId)` against the
 *     persisted SQLite ledger.
 *   - **TIME** → `TimePopoverContent` — per-turn `activeMs` log +
 *     count/total/avg footer + live in-flight footer row when a
 *     turn is in flight.
 *   - **CONTEXT** → `ContextPopoverContent` — rich `/context`-style
 *     breakdown when a `lastContextBreakdown` frame is present, the
 *     5-segment `cost_update`-derived fallback otherwise. Its
 *     `messages` segment is where the session's conversation total
 *     reads.
 *   - **TASKS** → `TasksPopoverContent` — the numbered checklist.
 *   - **JOBS** → `JobsPopoverContent` — goal, running, scheduled and
 *     finished rows with their management actions.
 *
 * TIME cell text is the live in-flight clock when a turn is in
 * flight (`isLivePhase(phase)` true) and the last committed turn's
 * `activeMs` after commit. `deriveTimeCellMs` pauses on yellow axes
 * (awaiting-approval / transport-downtime / interrupt-in-flight)
 * via the snapshot's union-pause bookkeeping, freezes at
 * `turn_complete`, and re-engages on the next submit.
 * `useLifecycleTick` provides the 1Hz heartbeat — it ticks only
 * while in flight and reports `0` otherwise (the helper's fallback
 * path uses the static value in that case).
 *
 * The STATE cell mirrors the other three: an endcap-rule legend
 * above a value. The value is the human-readable phase title from
 * `SESSION_PHASE_LABELS`: "Idle", "Running tools", "Awaiting first
 * response". Flanking the value, pinned to either end of the value
 * area, are two label-less `TugProgressIndicator` pulsing-dot glyphs
 * — their dot + pulsing ring read
 * `phase × transportState × interruptInFlight × running jobs`
 * (resolved via `sessionSessionPhaseKey` +
 * `sessionSessionPhaseVisual`) and give the cell the live motion a
 * static figure cannot. Running jobs are an input because a turn can
 * commit while the agents it launched keep working: that session reads
 * "Running", not "Idle". A standing join offer is an input for the
 * mirror-image reason: a session whose arc has finished reads "Ready",
 * green and pulsing, until the user lands or discards it.
 *
 * The two work cells divide along the checklist / everything-else
 * seam, each keeping its own source's semantics (`select-work.ts`).
 * TASKS is the [D100] todo list alone, reading `done/total` and
 * holding that decision's idle demotion. JOBS is the [D102]
 * background-jobs ledger (`useJobsState`) plus the `/goal`, counting
 * running rows, scheduled rows and one active goal; it never
 * idle-demotes, because a background job genuinely runs between turns.
 * Cumulative TOTAL TIME is not a separate cell; the sum surfaces in the
 * TIME popover's summary footer (one click reveals the per-turn rows +
 * the cumulative total).
 *
 * **Mount-identity ([L26]):** the five-cell flex row and every cell
 * are unconditionally mounted across phase / transport / interrupt
 * transitions. Only the popovers' open/closed state and the cell
 * values change; the STATE indicators reconcile tone in place.
 */
export const SessionTelemetryStatusRow = React.forwardRef<
  SessionTelemetryStatusRowHandle,
  SessionTelemetryStatusRowProps
>(function SessionTelemetryStatusRow(
  { codeSessionStore, sessionMetadataStore, onScrollToRow, focusGroup, focusOrderBase, focusPolicy, sideQuestionStore, pendingContextStore },
  ref,
) {
  // The Z2 detail surfaces render as ONE card-scoped TugPlacard, toggled open
  // on the activating cell — so only one is ever open ([P05]). `placard` names
  // the open surface plus the horizontal offset it opens at (measured under the
  // triggering cell, [P06]). `rowRef` locates the cells + the placard's
  // positioned container.
  const rowRef = useRef<HTMLDivElement>(null);
  const [placard, setPlacard] = useState<{
    key: PlacardKind;
    anchorCenter: number;
    /**
     * Folded only: the Z2 row's bottom edge in the pane frame's coordinates —
     * the line the placard hangs from ([B06]). `null` in the open form, whose
     * vertical placement is the stylesheet's `bottom: 100%`.
     */
    foldedTop: number | null;
  } | null>(null);
  // Mirror the open key so the toggle can read it without a stale closure.
  const placardKeyRef = useRef<PlacardKind | null>(null);
  placardKeyRef.current = placard?.key ?? null;

  // Whether this card wears the FOLDED form of the placard ([B01]): the pane
  // is folded AND this card is the tab on show. Deck state, so it enters React
  // through `useSyncExternalStore` ([L02]), read off the process-wide registry
  // rather than `useDeckManager()` — a Session card renders in the gallery and
  // in tests that bootstrap no DeckManager, and the honest answer there is
  // not-folded rather than a crash.
  //
  // The active-tab half is load-bearing rather than belt-and-braces. A folded
  // placard portals to the pane frame, which puts it OUTSIDE the `display:
  // none` a background card is hidden with — the one property `TugPlacard` was
  // built for ("hides with its card") and the one this form would otherwise
  // give away.
  const cardId = useContext(CardIdContext);
  const paneFrameEl = useContext(TugPaneFrameContext);
  const subscribeToDeck = useCallback((onStoreChange: () => void) => {
    const store = getDeckStore();
    if (store === null) return () => {};
    return store.subscribe(onStoreChange);
  }, []);
  const foldedShowing = useSyncExternalStore(subscribeToDeck, () => {
    const store = getDeckStore();
    // No card identity (the gallery, a fixture) is the same honest answer as
    // no deck: this card is not a folded pane's showing tab.
    if (store === null || cardId === null) return false;
    const state = store.getSnapshot();
    return (
      cardFoldedOf(state, cardId) &&
      state.panes.some((pane) => pane.activeCardId === cardId)
    );
  });
  const foldedForm = foldedShowing && paneFrameEl !== null;

  // What stands in the Z2 row INSTEAD of the five telemetry cells, on a folded
  // card ([B03]/[B04]). The folded frame's height is the wall tier's, so the
  // card cannot grow a row for this; a card with something to say has one thing
  // to say, and the cells come back the moment it clears.
  //
  // Today the one occupant is the compaction cover, which declares `inhabit`
  // on its `showSheet` and therefore raises no panel while folded — the row IS
  // the surface. It is derived from `compactionProgressStore`, which the run
  // already keeps, so nothing new holds this state.
  //
  // The other two are the unbidden ARRIVALS ([B03]): a question and a
  // permission request, both of which are inline dialogs the transcript
  // carries — and a folded card has no transcript on show, so an arrival that
  // said nothing here would be an arrival the user never learns about. Neither
  // is a sheet, so neither passes through `showSheet`'s `defer` tier; both are
  // read straight off the pending state `CodeSessionStore` already holds,
  // which is the same state the two dialogs render from. The notice therefore
  // stands for exactly as long as the dialog does and clears with it — there is
  // no dismissal of its own to get out of step with ([L02]).
  const compacting = useIsCompactingCard(cardId ?? undefined);
  const arrival = useSyncExternalStore(
    codeSessionStore.subscribe,
    useCallback((): FoldArrival | null => {
      const snapshot = codeSessionStore.getSnapshot();
      if (snapshot.pendingQuestion !== null) return "question";
      if (snapshot.pendingApproval !== null) return "permission";
      return null;
    }, [codeSessionStore]),
  );
  // A compaction HOLDS the card — nothing else can arrive under it — so it
  // wins the row without the two having to be ordered against each other.
  //
  // And it holds the row for the run's whole length, folded or not ([B05]):
  // the occupant is in the tree from the run's first frame to its last, and
  // WHICH face is up — the row, or the cover it stands behind — is
  // `data-face` on the row, written by `useCompactionFace` below rather than
  // derived here. So an unfold changes an attribute on a live element; it
  // never unmounts the run's face and mounts it again ([F04]). An arrival is
  // different: a notice the card was already folded for, on nobody's clock,
  // so it is simply present while the card is folded.
  const occupant: FoldOccupant | null = compacting
    ? "compaction"
    : foldedShowing
      ? arrival
      : null;
  useCompactionFace(rowRef, compacting, foldedShowing, paneFrameEl);

  // Command-span enhancement for the `/btw` answer markdown — the same known-
  // command gate the main transcript passes to its `TugMarkdownBlock`.
  const annotation = useAnnotationContext(sessionMetadataStore);

  // On-trigger anchoring: the x the placard centers itself on, in the
  // coordinates of its positioned container — the `.session-card-status-bar`
  // padding box (the placard's offsetParent; the row itself is unpositioned,
  // [P06]). `clientLeft` is the container's left border width, so
  // `barRect.left + clientLeft` is the padding-box edge the placard's `left` is
  // measured from.
  //
  // Two anchors, because two kinds of surface open here. A cell placard is a
  // detail view OF that cell and centers under it. The `/btw` placard is not:
  // BTW has no cell any more, and `/btw` is a conversation the user had with
  // the session rather than a reading off the strip — so it opens from the
  // strip's own trailing edge, right-aligned to the card. `TugPlacard` centers
  // on the x it is given and clamps in-card, so a right-edge anchor is stated
  // as the strip's own right edge; the clamp does the rest.
  //
  // Folded, the container is the PANE FRAME the placard portals into rather
  // than the strip ([B07]), so both numbers are measured in the frame's
  // padding box — and the second number exists at all: the line the panel
  // hangs from is the Z2 row's own bottom edge, which only the frame's
  // coordinates can state.
  const measurePlacement = useCallback(
    (key: PlacardKind): { anchorCenter: number; foldedTop: number | null } => {
      const nowhere = { anchorCenter: 0, foldedTop: null };
      const row = rowRef.current;
      if (row === null) return nowhere;
      const statusBar = row.closest<HTMLElement>(
        '[data-slot="session-card-status-bar"]',
      );
      if (statusBar === null) return nowhere;
      const container = foldedForm ? (paneFrameEl as HTMLElement) : statusBar;
      const containerRect = container.getBoundingClientRect();
      const originX = containerRect.left + container.clientLeft;
      const barRect = statusBar.getBoundingClientRect();
      let anchorCenter: number;
      if (key === "btw") {
        anchorCenter =
          container === statusBar ? statusBar.clientWidth : barRect.right - originX;
      } else {
        const priority = PLACARD_ANCHOR_PRIORITY[key] ?? key;
        const cell = row.querySelector<HTMLElement>(
          `[data-slot="tug-status-cell"][data-priority="${priority}"]`,
        );
        if (cell === null) return nowhere;
        const cellRect = cell.getBoundingClientRect();
        anchorCenter = cellRect.left + cellRect.width / 2 - originX;
      }
      const foldedTop = foldedForm
        ? barRect.bottom - (containerRect.top + container.clientTop)
        : null;
      return { anchorCenter, foldedTop };
    },
    [foldedForm, paneFrameEl],
  );

  const showPlacard = useCallback(
    (key: PlacardKind): void => {
      setPlacard({ key, ...measurePlacement(key) });
    },
    [measurePlacement],
  );
  // Cell activation toggles: re-clicking the open cell closes it ([P05]).
  const togglePlacard = useCallback(
    (key: PlacardKind): void => {
      if (placardKeyRef.current === key) setPlacard(null);
      else showPlacard(key);
    },
    [showPlacard],
  );
  const closePlacard = useCallback(() => setPlacard(null), []);

  // A fold closes the open placard rather than re-measuring under it. The line
  // it hangs from and the container it lives in both change with the form, and
  // a placard the user opened on one card shape is not a reading they asked to
  // keep on the other.
  const lastFoldRef = useRef(foldedForm);
  useEffect(() => {
    if (lastFoldRef.current === foldedForm) return;
    lastFoldRef.current = foldedForm;
    setPlacard(null);
  }, [foldedForm]);

  // And while a FOLDED placard is up, its frame paints above every peer — the
  // same one attribute, rule and ref-count a sheet takes ([B07]), so a sheet
  // and a placard sharing a frame release it in either order. A layout effect
  // so the lift lands in the same frame the panel first paints in.
  useLayoutEffect(() => {
    if (placard === null || !foldedForm || paneFrameEl === null) return;
    return raisePaneAbovePeers(paneFrameEl);
  }, [placard, foldedForm, paneFrameEl]);

  // [P10] Escape ownership while a Z2 placard is open. The placard is
  // non-modal, focus-refusing chrome (it never pushes a focus mode of its
  // own), so a placard opened FROM A CYCLE STOP would otherwise leave the
  // cycle mode on top — and the cycle's `escapeExits` would eat Escape,
  // exiting the whole cycle instead of just closing the placard. Pushing an
  // Escape-owning mode while the placard is open makes the placard the top
  // mode: Escape (and Space) run `onEscapeDismiss`/`spaceDismisses` → close
  // the placard, and popping restores the ring to the triggering cell. The
  // cycle scope stays on the stack throughout, so the card reads as still
  // cycling ([P10]: a cell popover is not a cycle exit). No focus is moved on
  // push (the cell keeps the ring), matching the placard's chrome nature.
  const focusManager = useContext(FocusManagerContext);
  const focusCtx = useMemo(
    () => (focusManager === null ? null : focusManager.contextFor(cardId)),
    [focusManager, cardId],
  );
  const placardFocusScopeId = useId();
  useEffect(() => {
    if (focusCtx === null || placard === null) return;
    focusCtx.pushFocusMode(placardFocusScopeId, {
      trapped: true,
      onEscapeDismiss: closePlacard,
      spaceDismisses: true,
    });
    return () => focusCtx.popFocusMode(placardFocusScopeId);
  }, [focusCtx, placard, placardFocusScopeId, closePlacard]);

  useImperativeHandle(
    ref,
    () => ({
      openContext: () => showPlacard("context"),
      openTasks: () => showPlacard("tasks"),
      openJobs: () => showPlacard("jobs"),
      openSideQuestions: () => showPlacard("btw"),
    }),
    [showPlacard],
  );

  // Cycle stops ([P10] revised): each cell is its own leaf stop (Tab
  // cell-to-cell, no arrow-roving), like the Z4B chips. The cells take
  // consecutive orders left→right from `focusOrderBase`; passing an
  // undefined group leaves them off the walk entirely (`TugStatusCell`
  // registers only when a `focusGroup` is supplied). `cellOrder` keeps
  // the per-cell order in one place so the DOM order and the walk order
  // can't drift.
  const cellOrder = (offset: number): number | undefined =>
    focusOrderBase === undefined ? undefined : focusOrderBase + offset;

  const snap = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  // Whether a join offer stands for the arc this card is mated to — read
  // through the one derivation `useSessionPhase` folds in, so the STATE cell
  // and the masthead dot cannot disagree about one arc.
  const joinReady = useSessionJoinReady(snap.tugSessionId);
  // Live intra-turn usage rides the streaming document's per-path
  // observers ([L02]) — a `streaming_usage` frame ticks only this row,
  // never the whole-store snapshot (and so never the transcript list).
  const liveTurnUsage = useSyncExternalStore(
    codeSessionStore.observeLiveTurnUsage,
    codeSessionStore.getLiveTurnUsage,
  );
  const contextMax = useModelContextMax(sessionMetadataStore);
  // Jobs ledger — read early because the TIME cell folds background
  // work into its clock (a request whose agent still runs between
  // turns keeps counting) as well as feeding the JOBS cell below.
  const jobsLedger = useJobsState(codeSessionStore);

  const lastTurn =
    snap.transcript.length > 0
      ? snap.transcript[snap.transcript.length - 1]
      : null;
  // Background jobs launched by the last committed turn — the work
  // that keeps the request "in progress" after the turn commits.
  const lastTurnJobs =
    lastTurn !== null ? jobsOwnedByTurn(lastTurn.messages, jobsLedger) : [];
  const lastTurnJobsRunning = lastTurnJobs.some((j) => j.status === "running");
  // Live 1Hz heartbeat — ticks while phase is non-terminal, AND while
  // the last turn's background work is still running (the TIME cell
  // keeps counting between turns then). `tickAt` is the helper's
  // input, not a render-affecting value itself; `deriveTimeCellMs`
  // folds it into its union-pause math.
  const tickAt = useLifecycleTick(snap.phase, undefined, lastTurnJobsRunning);
  // Subscribe to the persisted state-change log so the indicator's
  // popover surfaces the live row stream. Returns the idle snapshot
  // when no card has bound to a session id, so the subscription is
  // cheap even before the popover opens.
  const stateChangeSnap = useSessionStateChanges(snap.tugSessionId);

  // ── The ARC reading ──────────────────────────────────────────────────
  // While the bound session is driving an arc, the fourth cell reads ARC
  // instead of TASKS: the arc is what the session IS doing, and during a plan
  // run the checklist the TASKS reading showed *is* the arc's step list, so
  // nothing is lost by promoting the arc to the label. The cell keeps its box
  // and its `data-priority`, so the row's geometry is untouched.
  const arcFact = useArcForSession(snap.tugSessionId);
  // The same call, in the same argument order, the masthead's identity row
  // already makes — so Z1 and Z2 cannot disagree about the numerals. Null for
  // an arc that declared no counters, which reads as the stage glyph alone.
  const arcGlance =
    arcFact !== null
      ? arcGlanceFraction(
          arcFact.runPosition,
          arcFact.runLength,
          arcFact.stepCurrent,
          arcFact.stepTotal,
        )
      : null;
  // The pair this cell may actually show: the implement stage's reading and
  // no other stage's ([B03]) — the declared selection first, and the plan's
  // own pair when none was declared, both through `arcCellNumerals`' gate.
  // The label below and the value further down read this one pair rather
  // than each deriving its own, so the sentence a screen reader hears never
  // counts steps the cell is not showing, nor stays silent about ones it is.
  const arcModel = arcFact?.track ?? null;
  const arcFraction =
    arcModel === null
      ? null
      : arcCellNumerals(
          arcFact?.arc ?? null,
          arcGlance ?? arcMarkFraction(arcModel),
        );
  // The cell shows no name at all; the label carries the whole identity, so a
  // screen reader hears which arc the glyph and the fraction belong to.
  // The tint the cell paints for an arc is invisible to a screen reader, so
  // the arc is spelled out here in full — a stopped one first, because that is
  // the reading nobody should have to open the placard to discover.
  const arcRunLabel =
    arcFact?.arc == null
      ? ""
      : arcFact.arc.stopped !== undefined
        ? `, stopped in ${arcFact.arc.stopped_stage ?? arcFact.arc.stage ?? "an unnamed stage"}: ${arcFact.arc.stopped}`
        : arcFact.arc.stage !== undefined && arcFact.arc.done !== true
          ? `, in ${arcFact.arc.stage}`
          : "";
  // A screen reader hears the cell's own reading, so a ready arc says so here
  // too — otherwise the one state that is asking for the user is the one state
  // the label does not name.
  const arcReadyLabel = joinReady ? ", ready to join" : "";
  const arcCellLabel =
    arcFact === null
      ? ""
      : arcFraction === null
        ? `arc ${arcFact.name}${arcReadyLabel}${arcRunLabel}`
        : `arc ${arcFact.name}, step ${arcFraction.current} of ${arcFraction.total}${arcReadyLabel}${arcRunLabel}`;
  // The placard's one exit: this card's own Changes shade, where every decision
  // about an arc already lives ([D152]). The content scope, not the bare card
  // id — `sendToTarget` walks upward from its target and the session card's
  // handlers live one scope beneath `card-host`.
  const chain = useResponderChain();
  const revealChanges = useCallback(() => {
    const target = `${cardId}-card-content`;
    if (chain === null || !chain.hasResponder(target)) return;
    chain.sendToTarget(target, {
      action: TUG_ACTIONS.REVEAL_CHANGES,
      phase: "discrete",
    });
  }, [chain, cardId]);

  // TIME cell: live in-flight clock when a turn is in flight; after
  // commit, the last turn's activeMs extended across its background
  // work — climbing while a launched agent still runs, frozen at the
  // request's true total once it finishes.
  const lastCommittedActiveMs =
    lastTurn !== null
      ? deriveJobExtendedActiveMs({
          turnActiveMs: lastTurn.activeMs,
          turnEndedAt: lastTurn.endedAt,
          jobs: lastTurnJobs,
          nowMs: tickAt,
        })
      : 0;
  const perTurnActiveMs = deriveTimeCellMs(snap, tickAt, lastCommittedActiveMs);
  // Per-turn TIME is durable-only (overlaid from `turn_telemetry`, [P03]); a
  // turn restored without a row carries the zero-placeholder. Show the honest
  // `—` then, never a fabricated `0:00`. A live in-flight clock is always real.
  const lastTurnHasTiming = lastTurn !== null && turnHasTiming(lastTurn);
  // CONTEXT cell — feed-derived. While a turn is in flight the cell
  // reads the latest `streaming_usage` frame (the streaming document's
  // live-usage path) so it climbs mid-turn the way TIME does; once the
  // turn commits — and between turns — it reads the transcript
  // window-walk.
  //
  // The reading is the resident context total, unified with the popover
  // through `computeRichContextBreakdown`: `breakdown.totalUsed` is
  // `window` by construction. Before turn 1 (no `sessionInit`, no
  // window) the breakdown's bootstrap is tugcode's static estimate,
  // so the cell shows a session-init figure the moment the session
  // opens — never blank.
  const sessionInit = snap.sessionInitTokens;
  const windows = deriveContextWindows(
    snap.transcript.map((t) => t.cost),
    sessionInit ?? 0,
    snap.transcript.map((t) => t.compactionPostTotal ?? null),
  );
  const lastCommittedWindow =
    windows.length > 0 ? windows[windows.length - 1].window : null;
  const isInflight = snap.activeTurn !== null;
  const live = liveTurnUsage;
  // Resident window: the live in-flight frame, else the last committed
  // turn's window, else `null` (no turns yet — fresh session).
  //
  // A live frame reading 0 is not a reading at all — no `streaming_usage` has
  // landed for this turn yet, and a `/compact` turn streams nothing for
  // minutes — so the committed window stands until the live one says
  // something. Without this the cell blanked to a fresh-session figure (and,
  // with the breakdown's own latch fallback, to `0`) the moment a compaction
  // opened its turn.
  const liveWindow = live !== null ? turnWindowTokens(live) : 0;
  const windowTokens =
    isInflight && liveWindow > 0 ? liveWindow : lastCommittedWindow;
  // One breakdown computation feeds BOTH the CONTEXT cell (its
  // `totalUsed`) and the Context popover (its `segments`) — the two
  // surfaces cannot disagree.
  const contextBreakdown = computeRichContextBreakdown({
    staticBreakdown: snap.lastContextBreakdown,
    sessionInitTokens: sessionInit,
    windowTokens,
    contextMax,
  });
  const contextTotal = contextBreakdown?.totalUsed ?? windowTokens ?? 0;

  // Color-coded context numerator. The `/` and denominator stay
  // muted so the live numerator reads first. Threshold class is
  // applied to the wrapping span; the CSS rule paints the
  // numerator's color via descendant selector.
  const ratio = contextMax > 0 ? contextTotal / contextMax : 0;
  const contextThreshold: "normal" | "caution" | "danger" =
    ratio >= 0.9 ? "danger" : ratio >= 0.75 ? "caution" : "normal";

  // Replay-window inerting: while a resume replay is reconstructing
  // history, every value-oriented cell would otherwise flip wildly as
  // replayed turns fold through the telemetry derivations — readings
  // of HISTORY, not of anything happening now. The value cells render
  // an inert em-arc for the duration (and the row's
  // `data-replay-inert` attribute dims them + drops pointer events via
  // CSS, [L06]); only STATE stays live, reading "Restoring".
  const replayInert =
    snap.phase === "replaying" || deriveColdRestoreActive(snap);
  const inertValue = (text: string): string => (replayInert ? "—" : text);

  const indicatorState: SessionPhaseInput = {
    phase: snap.phase,
    transportState: snap.transportState,
    interruptInFlight: snap.interruptInFlight,
    // A committed turn can leave agents running behind it; without this
    // the cell would read "Idle" over live work.
    runningJobCount: countRunningJobs(jobsLedger),
    // Every dialog that holds the user's answer reads Awaiting. The
    // permission and question dialogs get there through `phase`, which
    // the reducer sets; an `/api/ask` dialog belongs to no turn, so it
    // reaches the cell on its own axis instead.
    pendingAsk: snap.pendingAsk !== null,
    // A finished arc with a standing join offer reads Ready — the cell's one
    // green, and the only word that says the work is done rather than that no
    // turn happens to be in flight.
    joinReady,
  };
  const statePhaseKey = sessionSessionPhaseKey(indicatorState);
  // STATE cell value — the human-readable phase title. The two
  // flanking indicators take the same phase key and derive their
  // own role + state via sessionSessionPhaseVisual.
  const stateLabelText = SESSION_PHASE_LABELS[statePhaseKey];

  // TASKS cell — the numbered checklist alone ([D100]'s derived
  // turn-scoped fold, keeping its idle demotion: a half-done list does
  // not glow over an idle session). The label is the `done/total`
  // fraction, which is the reading a plan-following session tracks.
  //
  // JOBS cell — everything else the session has outstanding ([D102]'s
  // session-lifetime ledger plus the `/goal`): running jobs, scheduled
  // rows, and one active goal. Never idle-demoted — a job genuinely
  // runs between turns.
  //
  // Both cells linger their recently-finished work for WORK_LINGER_MS
  // rather than snapping to "None" the instant the last item finishes,
  // and each lingers only its own half. `nowMs` is read at render;
  // while idle-and-lingering a single bounded timeout (below)
  // recomputes once at the earliest expiry across the two — no ticker.
  const taskListState = useTaskListState(codeSessionStore);
  const taskCounts = countTasks(taskListState.tasks);
  const hasTasks = taskCounts.total > 0;
  const isIdle = snap.phase === "idle";
  const allTasksComplete =
    hasTasks && taskCounts.completed === taskCounts.total;
  const goal = snap.goal;
  const jobCounts = countJobs(jobsLedger);
  const nowMs = Date.now();

  const tasksRecent = tasksRecentlyDone(
    taskListState.tasks,
    nowMs,
    WORK_LINGER_MS,
  );
  const tasksLabelText = formatTaskFraction(taskCounts);
  const tasksIndicatorState: TugProgressIndicatorState = tasksCellPose(
    { hasTasks, allTasksComplete, isIdle },
    tasksRecent > 0,
  );
  const tasksSummary = composeTaskSummary(taskCounts);
  // The ARC reading's flanking dots: a stopped arc paints danger, a
  // wheel-driven one runs across turn ends, and only a hand-run arc takes
  // the TASKS idle demotion. The pose function owns all four.
  const arcIndicatorState: TugProgressIndicatorState = arcCellPose(
    { stage: arcFact?.stage ?? null, wheel: arcFact?.arc ?? null },
    isIdle,
  );
  // **Numbers only while steps are being walked.** The declared selection
  // first — the pair somebody asked for — and the plan's own pair when none
  // was declared, but only through `arcCellNumerals`' gate: the wheel's stage
  // is `implement` (or nothing drives the arc) and a step is in hand. A
  // reviewed-but-unstarted plan says `Review` or `Implement` rather than
  // `0/10`, and an arc under audit says `Audit` rather than `3/3` — a zero
  // numerator counts work that has not started, and a full one counts work
  // the seated stage is no longer doing ([B03]).
  //
  // The word is the lifecycle PHASE, the same vocabulary the track's cells
  // and the line use — one derivation, read here rather than re-spelled
  // ([B08]). Not the git stage: an arc devising or reviewing a plan has no
  // stage at all, which is how this cell came to show a fallback glyph for the
  // whole first half of an arc's life. A direct arc that wrote a task list has
  // a fraction while it walks it, and the phase word once it stops walking.
  const arcReading =
    arcModel === null
      ? ""
      : // While a join offer stands the cell reads the REGISTER's word rather
        // than the lifecycle's ([B08]). `Finished` is true and useless here —
        // it is what the arc did, and what the reader needs is what the arc
        // wants, which is them. The condition is the one `joinReady` the dot
        // beside it reads, so the cell and the dot cannot disagree.
        joinReady
        ? ARC_JOIN_READY_CELL_WORD
        : arcFraction !== null
          ? `${arcFraction.current}/${arcFraction.total}`
          : arcCellWord(arcModel);

  const jobsRecent = jobsRecentlyDone(jobsLedger, nowMs, WORK_LINGER_MS);
  const jobsActiveCount = jobsCellActiveCount(jobCounts, goal);
  const jobsDisplayCount = cellDisplayCount(jobsActiveCount, jobsRecent);
  const jobsLabelText = formatCellCount(jobsDisplayCount);
  const jobsIndicatorState: TugProgressIndicatorState = jobsCellDisplayPose(
    jobsLedger,
    jobsRecent > 0,
  );
  const jobsSummary = composeJobsCellSummary(jobCounts, goal);
  // A settled cell needs one nudge to leave its lingered reading:
  // TASKS to drop its green dot once a finished list ages out, JOBS to
  // fall back to "None". Active work needs none — the row already
  // re-renders on its own (the live TIME clock). One timeout serves
  // both, scheduled at the earliest expiry across them; when it fires,
  // a recompute drops that item and reschedules for the next.
  const tasksLingering = allTasksComplete && tasksRecent > 0;
  const jobsLingering = jobsActiveCount === 0 && jobsRecent > 0;
  const [, setLingerTick] = useState(0);
  useEffect(() => {
    if (!tasksLingering && !jobsLingering) return;
    const expiry = nextLingerExpiryMs(
      taskListState.tasks,
      jobsLedger,
      Date.now(),
      WORK_LINGER_MS,
    );
    if (expiry === null) return;
    const id = setTimeout(
      () => setLingerTick((n) => n + 1),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(id);
  }, [tasksLingering, jobsLingering, taskListState.tasks, jobsLedger]);
  // Popover actions — fire-and-forget control-style callbacks onto the
  // store's named methods (stop/cancel/stop-loop/clear-goal ride the
  // wire; clear is deck-local).
  const stopJob = useCallback(
    (jobId: string) => codeSessionStore.stopJob(jobId),
    [codeSessionStore],
  );
  const clearJobs = useCallback(
    () => codeSessionStore.clearJobs(),
    [codeSessionStore],
  );
  const cancelScheduledWork = useCallback(
    (jobId: string) => codeSessionStore.cancelScheduledWork(jobId),
    [codeSessionStore],
  );
  const stopLoop = useCallback(
    (jobId: string) => codeSessionStore.stopLoop(jobId),
    [codeSessionStore],
  );
  const clearGoal = useCallback(
    () => codeSessionStore.clearGoal(),
    [codeSessionStore],
  );

  // Per-anchor popover content. Each popover receives only the
  // inputs it needs — no shared context object — so future popover
  // changes touch one factory call instead of a coupling layer.
  // `isInflight` (computed above with the cell values) gates both
  // per-area popovers' in-flight footer.
  // Canonical turn-number base: the loaded window's `firstLoadedTurnIndex`,
  // so the popovers' per-turn `#u{turn}` / `#a{turn}` addresses match the
  // transcript's paged numbering (0 for a full / non-windowed load).
  const turnNumberBase = snap.replayWindow?.firstLoadedTurnIndex ?? 0;
  const timePopover = (
    <TimePopoverContent
      transcript={snap.transcript}
      turnNumberBase={turnNumberBase}
      inflight={
        isInflight ? { currentTurnActiveMs: perTurnActiveMs } : null
      }
      onScrollToRow={onScrollToRow}
    />
  );
  const contextPopover = (
    <ContextPopoverContent
      breakdown={contextBreakdown}
      threshold={contextThreshold}
    />
  );
  const statePopover = (
    <StateChangeLogPopoverContent rows={stateChangeSnap.rows} />
  );
  const tasksPopover = (
    <TasksPopoverContent state={taskListState} idle={isIdle} />
  );
  const arcPopover =
    arcFact === null ? null : (
      <ArcPopoverContent
        fact={arcFact}
        tasks={taskListState.tasks}
        idle={isIdle}
        onShowInChanges={revealChanges}
      />
    );
  const jobsPopover = (
    <JobsPopoverContent
      goal={goal}
      canClearGoal={isIdle && goalIsActive(goal)}
      onClearGoal={clearGoal}
      jobs={jobsLedger}
      transcript={snap.transcript}
      turnNumberBase={turnNumberBase}
      onScrollToRow={onScrollToRow}
      onStopJob={stopJob}
      onCancelScheduledWork={cancelScheduledWork}
      onStopLoop={stopLoop}
      onClearJobs={clearJobs}
    />
  );

  // The one open placard's body — the same content element the cell used to
  // pass as its popover, now shown headerless inside the shared placard. BTW
  // shows the side-question body (its own store, unrelated to the code
  // session) and is only reachable when a store is present.
  const placardBody =
    placard === null
      ? null
      : placard.key === "state"
        ? statePopover
        : placard.key === "time"
          ? timePopover
          : placard.key === "context"
            ? contextPopover
            : placard.key === "tasks"
              ? tasksPopover
              : placard.key === "arc"
                ? arcPopover
                : placard.key === "jobs"
                ? jobsPopover
                : sideQuestionStore !== undefined
                  ? <SideQuestionBody store={sideQuestionStore} annotation={annotation} pendingContextStore={pendingContextStore} />
                  : null;

  // The placard element itself, before it is placed. Folded it is portaled to
  // the pane frame and hangs downward off the Z2 row; open it renders in place
  // above the strip. One element either way — the form is two props and a
  // portal, not two placards.
  //
  // The anchor line is memoised because the placard's placement effect takes
  // this object as an input: a fresh one per render would tear down and
  // rebuild its `ResizeObserver` every time a telemetry value ticked.
  const foldedPlacardStyle = useMemo(
    () =>
      placard?.foldedTop == null
        ? undefined
        : ({
            "--tugx-folded-placard-top": `${placard.foldedTop}px`,
          } as React.CSSProperties),
    [placard?.foldedTop],
  );
  const placardEl =
    placard === null ? null : (
      <TugPlacard
        open
        onClose={closePlacard}
        dismiss="auto"
        triggerSelector="[data-placard-trigger]"
        anchorCenter={placard.anchorCenter}
        growth={foldedForm ? "down" : "up"}
        // The visible canvas is what caps a downward panel, not the window top
        // the upward guard measures to ([B06]).
        bottomBoundEl={foldedForm ? (paneFrameEl?.parentElement ?? null) : null}
        className="session-telemetry-status-placard"
        style={foldedPlacardStyle}
        title={PLACARD_TITLES[placard.key]}
        aria-label={PLACARD_TITLES[placard.key]}
      >
        {placardBody}
      </TugPlacard>
    );

  // Flat 5-cell flex row — STATE + TIME + CONTEXT + TASKS + JOBS as
  // direct siblings. The row's `justify-content: center` (declared in
  // CSS) packs the cells as one group with a fixed inter-item `gap`;
  // the leftover width splits into equal flexing margins on the row's
  // far left and right. Every cell is a fixed-width box so the group's
  // width is constant and the cells never shift.
  return (
    <div
      ref={rowRef}
      className="session-telemetry-status-row"
      data-slot="session-telemetry-status-row"
      // The fourth cell's reading. It widens for a word, and JOBS gives back
      // exactly what it takes, so the row's total is the same 80ch either way
      // and every `@container` rung below keeps its measured value.
      data-arc={arcFact !== null ? "true" : undefined}
      data-replay-inert={replayInert ? "true" : undefined}
      // The occupant hides the cells through CSS rather than unmounting them:
      // the five-cell row is unconditionally mounted ([L26]), and a fold is no
      // more a reason to break that than a phase transition is. [L06]. For the
      // compaction the hiding also reads `data-face` (written imperatively by
      // `useCompactionFace`): the cells stand while the run's face is
      // `behind` the cover, and stand down while it is showing or leaving.
      data-occupant={occupant ?? undefined}
    >
      {/* The one thing a folded card has to say, in place of its instruments
          ([B03]). The inline dialogs' own one-row vocabulary — a mark, a
          title at the dialog's own size and weight, an action on the trailing
          edge — so the row and the header-only dialog the transcript carries
          read as one family seen in two places.

          Cancel is the run's own cancel, taken off the store rather than
          rebuilt here: while the card is folded this row IS the run's surface
          (the cover declares `inhabit` and raises no panel), so without it the
          one way to stop a compaction would be to unfold first. */}
      {occupant === "compaction" ? (
        <CompactionOccupant cardId={cardId} showing={foldedShowing} />
      ) : null}
      {/* The deferred arrival's notice ([B03]/[B05]) — the inline-dialog
          vocabulary at row scale: the dialog's own mark, its own tone, a
          title, and **Unfold** on the trailing edge. The press opens the card
          and nothing else: the dialog is already mounted in the transcript,
          so unfolding IS presenting it, and the deck's pointerdown path
          already fronts the pane. The notice never dismisses itself — it
          stands until the dialog it speaks for is answered. */}
      {occupant === "question" || occupant === "permission" ? (
        <div
          className="session-telemetry-status-occupant"
          data-slot="session-telemetry-status-occupant"
          data-occupant={occupant}
          role="status"
        >
          <span
            className="session-telemetry-occupant-mark"
            data-icon-role={occupant === "permission" ? "caution" : "info"}
            aria-hidden
          >
            {occupant === "permission" ? (
              <ShieldAlert size={16} />
            ) : (
              <MessageCircleQuestion size={16} />
            )}
          </span>
          <span className="session-telemetry-occupant-title">
            {foldArrivalTitle(occupant)}
          </span>
          <TugPushButton
            className="session-telemetry-occupant-action"
            emphasis="outlined"
            role="action"
            size="xs"
            onClick={() => {
              if (cardId !== null) unfoldCardForBiddenSurface(cardId);
            }}
          >
            Unfold
          </TugPushButton>
        </div>
      ) : null}
      {/* One card-scoped placard over whichever Z2 surface is open — auto-
          dismiss, fixed under its trigger cell, one at a time ([P05]/[P06]).
          Open, its offsetParent is the (position:relative)
          `.session-card-status-bar`, so it floats just above Z2 over the
          transcript's tail. Folded, there is no transcript and the chrome
          clips, so it goes to the pane frame instead — which clips nothing —
          and hangs down over the wall ([B07]). */}
      {foldedForm && placardEl !== null
        ? createPortal(placardEl, paneFrameEl as HTMLElement)
        : placardEl}
      <TugStatusCell
        priority="state"
        label="STATE"
        onActivate={() => togglePlacard("state")}
        focusGroup={focusGroup}
        focusOrder={cellOrder(0)}
        focusPolicy={focusPolicy}
      >
        <TugProgressIndicator
          variant="pulsing-dot"
          size={12}
          phase={statePhaseKey}
          phaseVisual={sessionSessionPhaseVisual}
          aria-hidden
        />
        <span className="session-telemetry-status-value">{stateLabelText}</span>
        <TugProgressIndicator
          variant="pulsing-dot"
          size={12}
          phase={statePhaseKey}
          phaseVisual={sessionSessionPhaseVisual}
          aria-hidden
        />
      </TugStatusCell>
      <TugStatusCell
        priority="time"
        label="TIME"
        onActivate={() => togglePlacard("time")}
        focusGroup={focusGroup}
        focusOrder={cellOrder(1)}
        focusPolicy={focusPolicy}
      >
        <span className="session-telemetry-status-value">
          {inertValue(
            isInflight || lastTurnHasTiming
              ? formatTimeMinutesSeconds(perTurnActiveMs)
              : "—",
          )}
        </span>
      </TugStatusCell>
      <TugStatusCell
        priority="context"
        label="CONTEXT"
        onActivate={() => togglePlacard("context")}
        focusGroup={focusGroup}
        focusOrder={cellOrder(2)}
        focusPolicy={focusPolicy}
      >
        <span
          className="session-telemetry-status-value session-telemetry-status-value-context"
          data-context-threshold={contextThreshold}
        >
          <span className="session-telemetry-status-context-numerator">
            {inertValue(formatTokensCaps(contextTotal))}
          </span>
          <span className="session-telemetry-status-context-denominator">
            {`/ ${formatTokenCap(contextMax)}`}
          </span>
        </span>
      </TugStatusCell>
      <TugStatusCell
        priority="tasks"
        label={arcFact === null ? "TASKS" : "ARC"}
        onActivate={() => togglePlacard(arcFact === null ? "tasks" : "arc")}
        valueEmpty={arcFact === null && !hasTasks}
        focusGroup={focusGroup}
        focusOrder={cellOrder(3)}
        focusPolicy={focusPolicy}
      >
        {replayInert ? (
          <span className="session-telemetry-status-value">—</span>
        ) : arcFact !== null ? (
          // The arc's reading, in the box TASKS holds when no arc is up:
          // `data-priority` is unchanged, so the placard's anchor query keeps
          // working. The box itself widens for the word — see `data-arc` on
          // the row, where JOBS gives back exactly what this cell takes.
          //
          // **No name.** The cell is ~110px, and a name is the one fact here
          // that can be arbitrarily long — so it ate the box and elided, which
          // spent every pixel on the thing the reader already knows (they
          // picked the arc) and pushed out the two that change while they
          // watch. Nothing in the cell can be truncated now, because nothing in
          // it would still be true truncated. The name is on the cell's own
          // `ARC` label as a reading, in the accessible label in full, and on
          // the placard one click away.
          //
          // **The fraction, or the phase's word.** The whole track lived here
          // for a while and it was the wrong box for it: a five-cell strip
          // squeezed under 78px draws ticks a pixel wide, which is a graphic
          // that cannot be read at the size it is drawn. So the cell says the
          // one thing that changes while somebody watches — the position in
          // the run — and before any step is declared it says where in the
          // lifecycle the arc is, in a word. The strip is on the surfaces
          // whose subject IS the arc: the Arcs card, the shade, and this cell's
          // own placard, one press away.
          //
          // **Authored exactly as STATE is.** Three siblings inside the value
          // wrap — a dot, the reading, a dot — not one indicator carrying a
          // `label`. That is the difference between the two shapes in this
          // row: TASKS and JOBS put their glyphs and their count inside one
          // indicator that stretches to the cell; STATE pins two glyphs to the
          // wrap's edges with `space-between` and centres a WORD between them.
          // The arc reading is a word, so it is STATE's shape, from STATE's
          // markup, under rules that say so.
          //
          // A stopped arc turns both dots danger and holds them still.
          //
          // **Keyed, and the TASKS branch below is keyed too.** An UNKEYED
          // top-level fragment is unwrapped by React, so this branch's
          // children reconcile positionally against the branch that was here
          // before — and slot 0 of the TASKS branch is a `pulsing-dot` too.
          // React kept it: the left dot arrived already breathing, on a clock
          // it started whenever the card mounted, while the right dot mounted
          // fresh and started its own. Two dots of one reading, permanently a
          // fraction of a cycle apart. The loops phase-lock by SHARING A START
          // TIME (`tug-progress-pulsing-dot.tsx`), and the only way this pair
          // gets one is by mounting in the same commit — which distinct keys
          // on the two branches are what guarantee.
          <React.Fragment key="arc">
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              state={arcIndicatorState}
              aria-hidden
            />
            <span
              className="session-telemetry-status-value"
              data-slot="session-telemetry-arc-value"
              aria-label={arcCellLabel}
            >
              {arcReading}
            </span>
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              state={arcIndicatorState}
              aria-hidden
            />
          </React.Fragment>
        ) : (
          <TugProgressIndicator
            key="tasks"
            variant="pulsing-dot"
            glyphPosition="both"
            size={12}
            state={tasksIndicatorState}
            label={tasksLabelText}
            labelAlign="center"
            // Width-stabilize ghosts: under `labelAlign="center"` every
            // entry renders hidden and the label box sizes to the
            // widest, so a fraction needs a fraction-shaped reservation
            // or it shifts as digits accrue.
            phaseLabels={{
              none: "None",
              max: "00/00",
            }}
            aria-label={tasksSummary}
          />
        )}
      </TugStatusCell>
      <TugStatusCell
        priority="jobs"
        label="JOBS"
        onActivate={() => togglePlacard("jobs")}
        valueEmpty={jobsDisplayCount === 0}
        focusGroup={focusGroup}
        focusOrder={cellOrder(4)}
        focusPolicy={focusPolicy}
      >
        {replayInert ? (
          <span className="session-telemetry-status-value">—</span>
        ) : (
          <TugProgressIndicator
            variant="pulsing-dot"
            glyphPosition="both"
            size={12}
            state={jobsIndicatorState}
            label={jobsLabelText}
            labelAlign="center"
            phaseLabels={{
              none: "None",
              max: "00",
            }}
            aria-label={jobsSummary}
          />
        )}
      </TugStatusCell>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Per-turn renderers (Z1)
// ---------------------------------------------------------------------------

export interface SessionTurnTelemetryProps {
  turn: TurnEntry;
}

/** Per-turn Claude-active duration (committed turns only). */
export const SessionTelemetryPerTurnDuration: React.FC<SessionTurnTelemetryProps> = ({
  turn,
}) => (
  <span
    className="session-telemetry-text"
    data-slot="session-telemetry-per-turn-duration"
  >
    {turnHasTiming(turn) ? formatDurationMs(turn.activeMs) : "—"}
  </span>
);

/** Per-turn cost in USD (committed turns only). */
export const SessionTelemetryPerTurnCost: React.FC<SessionTurnTelemetryProps> = ({
  turn,
}) => (
  <span
    className="session-telemetry-text"
    data-slot="session-telemetry-per-turn-cost"
  >
    {formatUsd(turn.cost.totalCostUsd)}
  </span>
);

/** Per-turn time-to-first-token (committed turns only). */
export const SessionTelemetryPerTurnTtft: React.FC<SessionTurnTelemetryProps> = ({
  turn,
}) => (
  <span
    className="session-telemetry-text"
    data-slot="session-telemetry-per-turn-ttft"
  >
    {turn.ttftMs !== null ? formatDurationMs(turn.ttftMs) : "—"}
  </span>
);
