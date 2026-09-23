/**
 * update-overlay.tsx — the update surface: one thing with two sizes.
 *
 * The whole of Tug's update presentation, in the **upper right of the deck
 * canvas**. Collapsed it is a `TugBadge` in the theme accent; expanded it is a
 * `TugInlineDialog` carrying the version, the release notes, a ConfigureTug
 * step list, and whichever decision the current stage holds. It is not a
 * trigger and a popover — it is one surface, and the only two things that
 * change its size are the collapse control in the dialog's header and a click
 * on the badge, each the other's inverse.
 *
 * Mounted once at the deck level (in `DeckCanvas`, beside
 * {@link OpenQuicklyOverlay}) and portaled into `CanvasOverlayRoot`, so it
 * floats above every pane's `overflow: hidden` clip. The upper-right corner
 * has no other tenant; the surface may overlap a card parked there, and that is
 * the accepted trade — it exists only while there is something to say.
 *
 * ## The size is the user's
 *
 * Arrival decides the first size and nothing else ever decides it again. A
 * **scheduled** check that finds something arrives collapsed: the badge lights
 * and nothing moves, which is the point of the whole arc — an update is
 * important information and not an emergency. A check the **user started**
 * arrives expanded on its answer (`available`, `upToDate`, `error`), because
 * being shown the answer is what they asked for; `userInitiated` rides the
 * snapshot for exactly that, and it is tracked per stage so a later transition
 * inside the same flow does not re-expand a surface the user collapsed.
 *
 * After that: no stage transition, no timer, no focus event, and no button
 * press changes the size. Pressing *Download* leaves the dialog open on the
 * downloading stage; collapsing it leaves a badge that waits until a convenient
 * moment. Deferral is the gesture this shape exists to make first-class.
 *
 * ## Progress is words, not a bar
 *
 * There is no progress bar anywhere — the wizard standard is one pulsing dot
 * per row and a detail line saying what is happening, and a bar was tried and
 * rejected. Progress is therefore *text*, and it is still appearance [L06]:
 * {@link ProgressDetail} writes its own `textContent` from a direct store
 * subscription, so a download moves the words without a React render.
 * {@link useUpdateState} does not carry `percent` at all — the store keeps a
 * second read surface whose reference survives a percent-only change.
 *
 * The one thing the design asked for and the bridge cannot give is Sparkle's
 * byte counts ("43 MB of 70 MB"). The snapshot carries a percent and nothing
 * else, and adding a field to the bridge is out of scope here, so the detail
 * line says the percent and a phrase where there is no percent yet.
 *
 * Laws: [L02] the store is read through `useSyncExternalStore`, [L06] progress
 * goes through the DOM rather than a render, [L25] mounted at the Deck level by
 * `DeckCanvas`, not by any pane or card.
 *
 * @module components/chrome/update-overlay
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ChevronsDownUp,
  CircleCheck,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { TugBadge, type TugBadgeRole } from "@/components/tugways/tug-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import {
  TugInlineDialog,
  type TugInlineDialogIconRole,
} from "@/components/tugways/tug-inline-dialog";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TugStepRow,
  type TugStepRowStatus,
} from "@/components/tugways/tug-step-row";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useDigest, turnInFlightForScope } from "@/lib/digest-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { sessionDisplayTitleForBinding } from "@/lib/session-identity";
import {
  MAX_NAMED_SESSIONS,
  relaunchWarningLine,
} from "@/lib/update-relaunch-warning";
import {
  updateStore,
  postUpdateAction,
  useUpdateState,
  type UpdateAction,
  type UpdateRenderSnapshot,
  type UpdateStage,
} from "@/lib/update-store";
import "./update-overlay.css";

/**
 * How long `upToDate` stands before it dismisses itself.
 *
 * "You are up to date" is an answer, not a notice: once it has been read
 * there is nothing left for it to do, and a surface that had to be dismissed
 * by hand would be one more thing the user has to clear. Every other terminal
 * state persists — an error is news, and an available update is a decision.
 *
 * The timer removes the whole surface; it never changes its size.
 */
const UP_TO_DATE_DISMISS_MS = 4_000;

/** The stages that put the surface on the canvas at all. */
const VISIBLE_STAGES: ReadonlySet<UpdateStage> = new Set<UpdateStage>([
  "checking",
  "available",
  "downloading",
  "extracting",
  "readyToInstall",
  "installing",
  "upToDate",
  "error",
]);

/** The stages a user-initiated flow arrives expanded on — its answer. */
const ANSWER_STAGES: ReadonlySet<UpdateStage> = new Set<UpdateStage>([
  "available",
  "upToDate",
  "error",
]);

// ---------------------------------------------------------------------------
// The stage table — what each stage looks like, said once
// ---------------------------------------------------------------------------

/** What the badge reads, per stage. Short enough to sit in a corner. */
function badgeLabel(state: UpdateRenderSnapshot): string {
  switch (state.stage) {
    case "checking":
      return "Checking…";
    case "available":
      return state.version === "" ? "Update available" : state.version;
    case "downloading":
      return state.version === ""
        ? "Downloading…"
        : `Downloading ${state.version}…`;
    case "extracting":
      return "Unpacking…";
    case "readyToInstall":
      return "Ready to install";
    case "installing":
      return "Installing…";
    case "upToDate":
      return "Up to date";
    case "error":
      return "Update failed";
    case "idle":
      return "";
  }
}

/**
 * The badge's colour role. Accent for the two stages that hold a decision —
 * the answer to "the pill should be the theme accent colour" — and `inherit`
 * for the transient ones, which are reports rather than decisions.
 */
function badgeRole(stage: UpdateStage): TugBadgeRole {
  switch (stage) {
    case "available":
    case "readyToInstall":
      return "accent";
    case "error":
      return "danger";
    case "upToDate":
      return "success";
    default:
      return "inherit";
  }
}

/** The badge's glyph: a stage's shape, before its words are read. */
function badgeGlyph(stage: UpdateStage): React.ReactNode {
  switch (stage) {
    case "available":
      return <ArrowDownToLine aria-hidden />;
    case "readyToInstall":
      // Not the down-arrow again. The two accent stages are the two that hold
      // a decision, and "ready to install" is the one the user asked to show
      // itself; a glyph it shares with `available` says nothing.
      return <RefreshCw aria-hidden />;
    case "upToDate":
      return <CircleCheck aria-hidden />;
    case "checking":
    case "downloading":
    case "extracting":
    case "installing":
      return (
        <TugProgressIndicator
          variant="spinner"
          size={14}
          role="inherit"
          state="running"
          aria-hidden
        />
      );
    case "error":
    case "idle":
      return null;
  }
}

/** The dialog's heading. A whole sentence, unlike the badge's. */
function dialogTitle(state: UpdateRenderSnapshot): string {
  const version = state.version === "" ? "" : ` ${state.version}`;
  switch (state.stage) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return version === ""
        ? "A Tug update is available"
        : `Tug${version} is available`;
    case "downloading":
      return `Downloading Tug${version}`;
    case "extracting":
      return `Unpacking Tug${version}`;
    case "readyToInstall":
      return version === ""
        ? "The update is ready to install"
        : `Tug${version} is ready to install`;
    case "installing":
      return `Installing Tug${version}`;
    case "upToDate":
      return "Tug is up to date";
    case "error":
      return "The update could not be completed";
    case "idle":
      return "";
  }
}

/** The line under the title: what is happening, and what it costs. */
function dialogDescription(stage: UpdateStage): string {
  switch (stage) {
    case "checking":
      return "Tug is asking whether there is a newer version.";
    case "available":
      return "The update downloads in the background; Tug relaunches only when you say so.";
    case "downloading":
    case "extracting":
      return "Keep working — nothing changes until you choose to relaunch.";
    case "readyToInstall":
      return "Relaunch now, or leave it: the update installs itself the next time you quit Tug.";
    case "installing":
      return "Tug is finishing its sessions and will relaunch on its own.";
    case "upToDate":
      return "This is the newest version. Tug checks again on its own.";
    case "error":
      return "Nothing was changed.";
    case "idle":
      return "";
  }
}

/** The dialog's icon tone. */
function dialogIconRole(stage: UpdateStage): TugInlineDialogIconRole {
  switch (stage) {
    case "readyToInstall":
    case "upToDate":
      return "success";
    case "error":
      return "danger";
    default:
      return "info";
  }
}

/** The dialog's icon, following its tone. */
function dialogIcon(stage: UpdateStage): React.ReactNode {
  switch (stage) {
    case "readyToInstall":
    case "upToDate":
      return <CircleCheck />;
    case "error":
      return <TriangleAlert />;
    default:
      return <ArrowDownToLine />;
  }
}

/** One button in the bottom row. */
interface Decision {
  label: string;
  action: UpdateAction;
  primary?: boolean;
}

/**
 * The bottom row's right-hand group: the quiet one first, the primary last —
 * the alert-dialog shape this app uses everywhere.
 */
function decisions(stage: UpdateStage): Decision[] {
  switch (stage) {
    case "checking":
      return [{ label: "Cancel", action: "cancel" }];
    case "available":
      return [
        { label: "Later", action: "later" },
        { label: "Download", action: "install", primary: true },
      ];
    case "downloading":
      return [{ label: "Cancel", action: "cancel" }];
    // Extraction and installation are past the point where cancelling means
    // anything — Sparkle hands back no cancellation for either, so offering
    // one would be a button that does nothing.
    case "extracting":
    case "installing":
      return [];
    case "readyToInstall":
      return [
        { label: "Later", action: "later" },
        { label: "Install and Relaunch", action: "install", primary: true },
      ];
    case "upToDate":
      return [{ label: "OK", action: "dismiss", primary: true }];
    case "error":
      return [
        { label: "Dismiss", action: "dismiss" },
        { label: "Retry", action: "retry", primary: true },
      ];
    case "idle":
      return [];
  }
}

/**
 * The bottom row's left-hand action — the rare one, held apart from the
 * decision so it is never pressed by reflex.
 */
function rareDecision(stage: UpdateStage): Decision | null {
  return stage === "available"
    ? { label: "Skip This Version", action: "skip" }
    : null;
}

// ---------------------------------------------------------------------------
// The step list
// ---------------------------------------------------------------------------

/** A row of the step list, before its detail is resolved. */
interface StepModel {
  key: string;
  label: string;
  status: TugStepRowStatus;
  /** `true` on the one row whose detail is the live download percent. */
  live?: boolean;
  detail?: string;
}

/**
 * The three jobs an update is, and where the current stage has got to.
 *
 * `checking`, `upToDate` and `error` get no list at all. The first two have no
 * flow to show; `error` has lost one — the snapshot says a failure happened
 * and carries no word about *which* step it happened in, and a list that put
 * the red dot on the download row would be asserting something nobody said.
 * The message and the decision carry the error instead.
 */
function steps(
  state: UpdateRenderSnapshot,
  relaunchDetail: string | undefined,
): StepModel[] {
  const download = `Download Tug${state.version === "" ? "" : ` ${state.version}`}`;
  switch (state.stage) {
    case "available":
      return [
        { key: "download", label: download, status: "active" },
        { key: "unpack", label: "Unpack the update", status: "pending" },
        {
          key: "relaunch",
          label: "Install and relaunch",
          status: "pending",
          detail: relaunchDetail,
        },
      ];
    case "downloading":
      return [
        { key: "download", label: download, status: "busy", live: true },
        { key: "unpack", label: "Unpack the update", status: "pending" },
        { key: "relaunch", label: "Install and relaunch", status: "pending" },
      ];
    case "extracting":
      return [
        { key: "download", label: download, status: "done" },
        {
          key: "unpack",
          label: "Unpack the update",
          status: "busy",
          detail: "Verifying the signature…",
        },
        { key: "relaunch", label: "Install and relaunch", status: "pending" },
      ];
    case "readyToInstall":
      return [
        { key: "download", label: download, status: "done" },
        { key: "unpack", label: "Unpack the update", status: "done", detail: "Verified" },
        {
          key: "relaunch",
          label: "Install and relaunch",
          status: "active",
          detail: relaunchDetail,
        },
      ];
    case "installing":
      return [
        { key: "download", label: download, status: "done" },
        { key: "unpack", label: "Unpack the update", status: "done", detail: "Verified" },
        {
          key: "relaunch",
          label: "Install and relaunch",
          status: "busy",
          detail: relaunchDetail ?? "Relaunching…",
        },
      ];
    case "checking":
    case "upToDate":
    case "error":
    case "idle":
      return [];
  }
}

/**
 * The download row's detail line, written onto its own span from a direct
 * store subscription.
 *
 * The whole of [L06] for this component. The percent the host publishes moves
 * about once a second through a download; routing it through a render would
 * re-render the dialog, the step list and the markdown block for a word. So
 * the span subscribes once and writes its own text, and React never hears
 * about it.
 */
function ProgressDetail(): React.ReactElement {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (el === null) return;
    const paint = (): void => {
      const percent = updateStore.getSnapshot().percent;
      // `null` is not zero. A total nobody has reported yet is "starting",
      // not "0%" — the same distinction the bar used to draw by not drawing.
      el.textContent = percent === null ? "Starting…" : `${percent}% downloaded`;
      if (percent === null) el.removeAttribute("data-progress");
      else el.setAttribute("data-progress", String(percent));
    };
    paint();
    return updateStore.subscribe(paint);
  }, [el]);
  return <span ref={setEl} data-testid="update-progress-detail" />;
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/**
 * The titles of every open session with a turn in flight.
 *
 * Reads the card bindings and the digest together, because neither answers on
 * its own: the bindings say which sessions the deck is holding, and the digest
 * says which of those is mid-sentence. A session nobody has a card open on is
 * not the deck's to speak for.
 */
function useMidTurnSessionTitles(): string[] {
  const digest = useDigest();
  const [bindings, setBindings] = useState(() =>
    cardSessionBindingStore.getSnapshot(),
  );
  useEffect(
    () => cardSessionBindingStore.subscribe(() => {
      setBindings(cardSessionBindingStore.getSnapshot());
    }),
    [],
  );

  const titles: string[] = [];
  for (const binding of bindings.values()) {
    const sessionId = binding.tugSessionId;
    if (sessionId === "") continue;
    if (
      !turnInFlightForScope(digest.lines, sessionId, digest.cleared.get(sessionId))
    ) {
      continue;
    }
    titles.push(sessionDisplayTitleForBinding(binding));
  }
  return titles;
}

/**
 * The *Install and relaunch* row's detail: which sessions a relaunch would cut
 * off, named rather than warned about.
 *
 * Deliberately not {@link relaunchWarningLine}. The caution line above the
 * bottom row says what a relaunch *costs*; the step's detail says *who* — and
 * printing the one sentence in both places would be the dialog saying the same
 * thing twice in two type sizes. Past {@link MAX_NAMED_SESSIONS} it counts
 * instead of naming, the same wall the warning keeps away from.
 */
function midTurnStepDetail(titles: readonly string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const named = titles.filter((title) => title.trim() !== "");
  const count =
    titles.length === 1
      ? "1 session is mid-turn"
      : `${titles.length} sessions are mid-turn`;
  // An untitled session cannot be named, so a list that is missing one is a
  // list that would lie about being complete: count them all instead.
  if (named.length !== titles.length || named.length > MAX_NAMED_SESSIONS) {
    return `${count}.`;
  }
  return `${count}: ${named.join(", ")}.`;
}

/** The bottom row: the rare action alone on the left, the decision on the right. */
function DecisionRow({
  state,
  onAct,
}: {
  state: UpdateRenderSnapshot;
  onAct: (action: UpdateAction) => void;
}): React.ReactElement | null {
  const right = decisions(state.stage);
  const left = rareDecision(state.stage);
  if (left === null && right.length === 0) return null;
  const button = (d: Decision): React.ReactElement => (
    <TugPushButton
      key={d.label}
      size="sm"
      emphasis={d.primary === true ? "filled" : "outlined"}
      role={d.primary === true ? "accent" : "action"}
      data-testid={`update-action-${d.action}`}
      onClick={() => onAct(d.action)}
    >
      {d.label}
    </TugPushButton>
  );
  return (
    <div className="tugx-update-decisions">
      <div className="tugx-update-decisions-left">
        {left === null ? null : button(left)}
      </div>
      <div className="tugx-update-decisions-right">{right.map(button)}</div>
    </div>
  );
}

/** The expanded form: the dialog, in the corner it occupies. */
function UpdateDialog({
  state,
  warning,
  relaunchDetail,
  onAct,
  onCollapse,
}: {
  state: UpdateRenderSnapshot;
  warning: string | null;
  /** The *Install and relaunch* row's detail line, when there is one. */
  relaunchDetail: string | undefined;
  onAct: (action: UpdateAction) => void;
  onCollapse: () => void;
}): React.ReactElement {
  const notes = state.releaseNotes;
  const showNotes =
    state.stage === "available" && notes !== null && notes.trim() !== "";
  const showWarning =
    warning !== null &&
    (state.stage === "available" || state.stage === "readyToInstall");
  const rows = steps(state, relaunchDetail);

  return (
    <div
      className="tugx-update-panel"
      data-testid="update-dialog"
      data-stage={state.stage}
    >
      <TugInlineDialog
        icon={dialogIcon(state.stage)}
        iconRole={dialogIconRole(state.stage)}
        title={dialogTitle(state)}
        description={dialogDescription(state.stage)}
        actions={
          <TugIconButton
            icon={<ChevronsDownUp size={16} aria-hidden />}
            aria-label="Collapse the update to a badge"
            title="Collapse"
            data-testid="update-collapse"
            onClick={onCollapse}
          />
        }
      >
        {state.stage === "error" && state.message !== "" ? (
          <p className="tugx-update-message" data-testid="update-error-message">
            {state.message}
          </p>
        ) : null}

        {showNotes ? (
          <div className="tugx-update-notes" data-testid="update-release-notes">
            {/* Keyed on the text: TugMarkdownBlock's static mode is
                mount-once, so notes arriving after the dialog was up — which
                is the ordinary case for linked notes — need a remount to be
                seen. */}
            <TugMarkdownBlock key={notes} initialText={notes} />
          </div>
        ) : null}

        {rows.length > 0 ? (
          <ol className="tugx-update-steps" data-testid="update-steps">
            {rows.map((row) => (
              <TugStepRow
                key={row.key}
                stepKey={row.key}
                status={row.status}
                label={row.label}
                detail={row.live === true ? <ProgressDetail /> : row.detail}
              />
            ))}
          </ol>
        ) : null}

        {showWarning ? (
          <p className="tugx-update-warning" data-testid="update-mid-turn-warning">
            {warning}
          </p>
        ) : null}

        <DecisionRow state={state} onAct={onAct} />
      </TugInlineDialog>
    </div>
  );
}

/** The collapsed form: the badge, which expands on click. */
function UpdateBadge({
  state,
  onExpand,
}: {
  state: UpdateRenderSnapshot;
  onExpand: () => void;
}): React.ReactElement {
  const role = badgeRole(state.stage);
  return (
    <button
      type="button"
      className="tugx-update-badge-button"
      data-testid="update-badge"
      data-stage={state.stage}
      aria-label={`${dialogTitle(state)} — expand`}
      onClick={onExpand}
    >
      <TugBadge
        emphasis={role === "inherit" ? "outlined" : "filled"}
        role={role}
        size="lg"
        icon={badgeGlyph(state.stage)}
      >
        {badgeLabel(state)}
      </TugBadge>
    </button>
  );
}

/** The surface, at whichever of its two sizes the user last left it. */
function UpdatePanel({ state }: { state: UpdateRenderSnapshot }): React.ReactElement {
  // Arrival size follows who asked. A flow that begins user-initiated on its
  // answer stage is expanded from its first frame; everything else lights the
  // badge and waits.
  const [expanded, setExpanded] = useState(
    () => state.userInitiated && ANSWER_STAGES.has(state.stage),
  );

  const midTurnTitles = useMidTurnSessionTitles();
  const warning = relaunchWarningLine(midTurnTitles);
  const relaunchDetail = midTurnStepDetail(midTurnTitles);

  // The one thing other than a click that sets the size, and it happens once
  // per answer: a check the user started reaching its answer inside a flow
  // that was already mounted (`checking` → `available`). Tracked against the
  // stage so a later transition in the same flow — `available` to
  // `downloading` — does not re-expand a surface they collapsed.
  const announced = useRef<UpdateStage | null>(
    state.userInitiated && ANSWER_STAGES.has(state.stage) ? state.stage : null,
  );
  useEffect(() => {
    if (!state.userInitiated || !ANSWER_STAGES.has(state.stage)) {
      if (!ANSWER_STAGES.has(state.stage)) announced.current = null;
      return;
    }
    if (announced.current === state.stage) return;
    announced.current = state.stage;
    setExpanded(true);
  }, [state.userInitiated, state.stage]);

  // `upToDate` is an answer with nothing left to do once read, so it clears
  // itself — acknowledging to the host on the way out, which is what lets
  // Sparkle finish the session. It removes the surface; it never resizes it.
  useEffect(() => {
    if (state.stage !== "upToDate") return;
    const timer = window.setTimeout(() => {
      postUpdateAction("dismiss");
    }, UP_TO_DATE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [state.stage]);

  // A decision posts its action and nothing else. It does not collapse the
  // surface: pressing Download leaves the dialog open on the stage that
  // follows, and the stages that end the flow take the whole surface with
  // them when the host says `idle`.
  const act = useCallback((action: UpdateAction) => {
    postUpdateAction(action);
  }, []);

  return (
    <div className="tugx-update-overlay" data-expanded={expanded ? "true" : "false"}>
      {expanded ? (
        <UpdateDialog
          state={state}
          warning={warning}
          relaunchDetail={relaunchDetail}
          onAct={act}
          onCollapse={() => setExpanded(false)}
        />
      ) : (
        <UpdateBadge state={state} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}

/**
 * Deck-global mount: renders the surface only while the host has something to
 * say, and nothing at all otherwise.
 */
export function UpdateOverlay(): React.ReactElement | null {
  const state = useUpdateState();
  const overlayRoot = useCanvasOverlay();
  if (!VISIBLE_STAGES.has(state.stage)) return null;
  return createPortal(<UpdatePanel state={state} />, overlayRoot);
}
