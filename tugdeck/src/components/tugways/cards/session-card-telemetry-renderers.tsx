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
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { TugArcGauge } from "@/components/tugways/tug-arc-gauge";
import {
  FocusManagerContext,
  type FocusPolicy,
} from "@/components/tugways/focus-manager";
import { CardIdContext } from "@/lib/card-id-context";
import { TugPlacard } from "@/components/tugways/tug-placard";
import { TugStatusCell } from "@/components/tugways/tug-status-cell";
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
  DashPopoverContent,
  JobsPopoverContent,
  StateChangeLogPopoverContent,
  TasksPopoverContent,
  TimePopoverContent,
  type ScrollToRowHandler,
} from "./session-card-telemetry-popovers";
import { dashGlanceFraction } from "@/components/tugways/dash-meta-line";
import { DashStageMark } from "@/components/tugways/dash-stage-mark";
import { useDashForSession } from "@/lib/dash-session-index";
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
  dashCellPose,
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
  | "dash"
  | "jobs"
  | "btw";

/**
 * The cell a placard anchors under, when that is not the cell its own key
 * names.
 *
 * `dash` is the one entry: the DASH reading is the TASKS cell wearing a
 * different label, so it keeps `data-priority="tasks"` — the width table and
 * the anchor query are both keyed on that attribute, and moving it would cost
 * the cell its measured box as well as its anchor.
 */
const PLACARD_ANCHOR_PRIORITY: Partial<Record<PlacardKind, string>> = {
  dash: "tasks",
};

/** Placard header title per surface — the placard header carries these now
 *  that the composed `TugPopupList` frames render headerless. */
const PLACARD_TITLES: Record<PlacardKind, string> = {
  state: "State",
  time: "Time",
  context: "Context",
  tasks: "Tasks",
  // The dash's own name rides inside the body: these are static strings, and
  // the placard header is the surface's legend rather than its subject.
  dash: "Dash",
  jobs: "Jobs",
  btw: "/btw",
};

/**
 * Imperative handle for {@link SessionTelemetryStatusRow}. Lets the session card open a
 * status-row placard programmatically — the surfaces the `/context` and
 * `/tasks` slash commands map to (they show the same breakdown a click on the
 * cell shows, no separate sheet). Threaded down through `useSessionPlacementSlots`
 * to the row's Z2 instance; a null ref (the row isn't the current Z2 datum)
 * makes these no-ops.
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
 * "Active", not "Idle".
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
  } | null>(null);
  // Mirror the open key so the toggle can read it without a stale closure.
  const placardKeyRef = useRef<PlacardKind | null>(null);
  placardKeyRef.current = placard?.key ?? null;

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
  const measureAnchorCenter = useCallback((key: PlacardKind): number => {
    const row = rowRef.current;
    if (row === null) return 0;
    const statusBar = row.closest<HTMLElement>(
      '[data-slot="session-card-status-bar"]',
    );
    if (statusBar === null) return 0;
    if (key === "btw") return statusBar.clientWidth;
    const priority = PLACARD_ANCHOR_PRIORITY[key] ?? key;
    const cell = row.querySelector<HTMLElement>(
      `[data-slot="tug-status-cell"][data-priority="${priority}"]`,
    );
    if (cell === null) return 0;
    const cellRect = cell.getBoundingClientRect();
    const barRect = statusBar.getBoundingClientRect();
    return cellRect.left + cellRect.width / 2 - (barRect.left + statusBar.clientLeft);
  }, []);

  const showPlacard = useCallback(
    (key: PlacardKind): void => {
      setPlacard({ key, anchorCenter: measureAnchorCenter(key) });
    },
    [measureAnchorCenter],
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
  const cardId = useContext(CardIdContext);
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

  // ── The DASH reading ──────────────────────────────────────────────────
  // While the bound session is driving a dash, the fourth cell reads DASH
  // instead of TASKS: the dash is what the session IS doing, and during a plan
  // run the checklist the TASKS reading showed *is* the dash's step list, so
  // nothing is lost by promoting the dash to the label. The cell keeps its box
  // and its `data-priority`, so the row's geometry is untouched.
  const dashFact = useDashForSession(snap.tugSessionId);
  // The same call, in the same argument order, the masthead's identity row
  // already makes — so Z1 and Z2 cannot disagree about the numerals. Null for
  // a dash that declared no counters, which reads as the stage glyph alone.
  const dashGlance =
    dashFact !== null
      ? dashGlanceFraction(
          dashFact.runPosition,
          dashFact.runLength,
          dashFact.stepCurrent,
          dashFact.stepTotal,
        )
      : null;
  // The cell shows no name at all; the label carries the whole identity, so a
  // screen reader hears which dash the glyph and the fraction belong to.
  const dashCellLabel =
    dashFact === null
      ? ""
      : dashGlance === null
        ? `dash ${dashFact.name}`
        : `dash ${dashFact.name}, step ${dashGlance.current} of ${dashGlance.total}`;
  // The placard's one exit: this card's own Changes shade, where every decision
  // about a dash already lives ([D152]). The content scope, not the bare card
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
  const windowTokens =
    isInflight && live !== null ? turnWindowTokens(live) : lastCommittedWindow;
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
  // an inert em-dash for the duration (and the row's
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
  // The DASH reading's flanking dots take the dash's stage, under the
  // same idle demotion the TASKS pose uses.
  const dashIndicatorState: TugProgressIndicatorState = dashCellPose(
    dashFact === null ? null : dashFact.stage,
    isIdle,
  );

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
  const dashPopover =
    dashFact === null ? null : (
      <DashPopoverContent
        fact={dashFact}
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
              : placard.key === "dash"
                ? dashPopover
                : placard.key === "jobs"
                ? jobsPopover
                : sideQuestionStore !== undefined
                  ? <SideQuestionBody store={sideQuestionStore} annotation={annotation} pendingContextStore={pendingContextStore} />
                  : null;

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
      data-replay-inert={replayInert ? "true" : undefined}
    >
      {/* One card-scoped placard over whichever Z2 surface is open — auto-
          dismiss, fixed under its trigger cell, one at a time ([P05]/[P06]).
          Its offsetParent is the (position:relative) `.session-card-status-bar`,
          so it floats just above Z2 over the transcript's tail. */}
      {placard !== null && (
        <TugPlacard
          open
          onClose={closePlacard}
          dismiss="auto"
          triggerSelector="[data-placard-trigger]"
          anchorCenter={placard.anchorCenter}
          className="session-telemetry-status-placard"
          title={PLACARD_TITLES[placard.key]}
          aria-label={PLACARD_TITLES[placard.key]}
        >
          {placardBody}
        </TugPlacard>
      )}
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
        label={dashFact === null ? "TASKS" : "DASH"}
        onActivate={() => togglePlacard(dashFact === null ? "tasks" : "dash")}
        valueEmpty={dashFact === null && !hasTasks}
        focusGroup={focusGroup}
        focusOrder={cellOrder(3)}
        focusPolicy={focusPolicy}
      >
        {replayInert ? (
          <span className="session-telemetry-status-value">—</span>
        ) : dashFact !== null ? (
          // The dash's stage and its run fraction, inside the box TASKS already
          // held: `data-priority` is unchanged, so the measured width table and
          // the placard's anchor query both keep working, and the row's
          // geometry does not move when a session picks a dash up.
          //
          // **No name.** The cell is ~110px, and a name is the one fact here
          // that can be arbitrarily long — so it ate the box and elided, which
          // spent every pixel on the thing the reader already knows (they
          // picked the dash) and pushed out the two that change while they
          // watch. Nothing in the cell can be truncated now, because nothing in
          // it would still be true truncated. The name is on the cell's own
          // `DASH` label as a reading, in the accessible label in full, and on
          // the placard one click away.
          //
          // The two flanking dots are the cell's own, not TASKS's: the
          // DASH reading is a composite (a glyph beside a fraction), so
          // it cannot ride a single indicator's `label` the way TASKS
          // and JOBS do. They are siblings around it instead, the way
          // STATE's are, pinned to the same 2px inset — so a session
          // picking a dash up changes what the cell says, not how it
          // looks.
          <span className="session-telemetry-status-dash-row">
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              state={dashIndicatorState}
              aria-hidden
            />
            <span
              className="session-telemetry-status-value session-telemetry-status-value-dash"
              data-slot="session-telemetry-dash-value"
              aria-label={dashCellLabel}
            >
              {dashFact.stage !== null && (
                <DashStageMark stage={dashFact.stage} />
              )}
              {dashGlance !== null && (
                <span className="session-telemetry-status-dash-fraction">
                  {`${dashGlance.current}/${dashGlance.total}`}
                </span>
              )}
            </span>
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              state={dashIndicatorState}
              aria-hidden
            />
          </span>
        ) : (
          <TugProgressIndicator
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
