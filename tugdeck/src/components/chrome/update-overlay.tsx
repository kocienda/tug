/**
 * update-overlay.tsx — the update pill, and the popover it opens.
 *
 * The whole of Tug's update presentation. Sparkle's own windows are gone and
 * this is what replaced them: a small pill in the **upper right of the deck
 * canvas** that appears when there is something to say and is absent when
 * there is not, and a themed popover behind it carrying the version, the
 * release notes, progress, and whichever controls the current state allows.
 *
 * Mounted once at the deck level (in `DeckCanvas`, beside
 * {@link OpenQuicklyOverlay}) and portaled into `CanvasOverlayRoot`, so it
 * floats above every pane's `overflow: hidden` clip. The upper-right corner
 * has no other tenant; the pill may overlap a card parked there, and that is
 * the accepted trade — it exists only while there is something to say.
 *
 * ## Nothing here takes focus
 *
 * No transition opens the popover, moves the keyboard, or raises a window. An
 * update found by a scheduled check lights the pill and does nothing else,
 * which is the point of the whole arc: an update is important information and
 * not an emergency.
 *
 * The **one** exception is a check the user started. `userInitiated` rides the
 * snapshot for exactly this, and when such a check reaches its answer —
 * `available`, `upToDate`, or `error` — the popover opens, because the user
 * has just asked to be shown it and showing it is the answer. That is
 * Sparkle's `showUpdateInFocus` realized through the state the bridge already
 * carries rather than through a second, event-shaped channel; the host's own
 * driver holds `onFocusRequested` for the same moment, and the two agree
 * because they read the same fact.
 *
 * ## Progress is appearance
 *
 * The progress underline is a CSS custom property written onto the pill's DOM
 * node from a direct store subscription — never React state, and never a
 * render ([L06]). {@link useUpdateState} does not even carry `percent`: the
 * store keeps a second read surface whose reference survives a percent-only
 * change, so a download costs React nothing between the transition that starts
 * it and the one that ends it.
 *
 * Laws: [L02] the store is read through `useSyncExternalStore`, [L06] progress
 * and the pill's own tone go through CSS and the DOM, [L25] mounted at the
 * Deck level by `DeckCanvas`, not by any pane or card.
 *
 * @module components/chrome/update-overlay
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  TugPopover,
  TugPopoverContent,
  TugPopoverTrigger,
} from "@/components/tugways/tug-popover";
import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useDigest, turnInFlightForScope } from "@/lib/digest-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { sessionDisplayTitleForBinding } from "@/lib/session-identity";
import { relaunchWarningLine } from "@/lib/update-relaunch-warning";
import {
  updateStore,
  postUpdateAction,
  useUpdateState,
  type UpdateRenderSnapshot,
  type UpdateStage,
} from "@/lib/update-store";
import "./update-overlay.css";

/**
 * How long `upToDate` stands before it dismisses itself.
 *
 * "You are up to date" is an answer, not a notice: once it has been read
 * there is nothing left for it to do, and a pill that had to be dismissed by
 * hand would be one more thing the user has to clear. Every other terminal
 * state persists — an error is news, and an available update is a decision.
 */
const UP_TO_DATE_DISMISS_MS = 4_000;

/** The stages that put a pill on the canvas at all. */
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

/** The stages a user-initiated flow opens the popover on — its answer. */
const ANSWER_STAGES: ReadonlySet<UpdateStage> = new Set<UpdateStage>([
  "available",
  "upToDate",
  "error",
]);

/** lucide `arrow-down-to-line` — the pill's glyph while an update is offered. */
const DOWNLOAD_SVG = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="tugx-update-pill-glyph"
  >
    <path d="M12 17V3" />
    <path d="m6 11 6 6 6-6" />
    <path d="M19 21H5" />
  </svg>
);

/** What the pill reads, per stage. Short enough to sit in a corner. */
function pillLabel(state: UpdateRenderSnapshot): string {
  switch (state.stage) {
    case "checking":
      return "Checking…";
    case "available":
      return state.version === "" ? "Update available" : state.version;
    case "downloading":
    case "extracting":
      return state.version === "" ? "Downloading…" : state.version;
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

/** The popover's heading. Longer than the pill's, and a whole sentence. */
function popoverTitle(state: UpdateRenderSnapshot): string {
  switch (state.stage) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return state.version === ""
        ? "A Tug update is available"
        : `Tug ${state.version} is available`;
    case "downloading":
      return "Downloading the update…";
    case "extracting":
      return "Unpacking the update…";
    case "readyToInstall":
      return state.version === ""
        ? "The update is ready to install"
        : `Tug ${state.version} is ready to install`;
    case "installing":
      return "Installing the update…";
    case "upToDate":
      return "Tug is up to date";
    case "error":
      return "The update could not be completed";
    case "idle":
      return "";
  }
}

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
 * Write the download's progress onto `el` as a CSS custom property, from a
 * direct store subscription.
 *
 * The whole of [L06] for this component: the underline's width is appearance,
 * so it is a property on a DOM node rather than a number in a render. The
 * effect subscribes once and survives every percent the host publishes without
 * waking React.
 */
function useProgressProperty(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (el === null) return;
    const paint = (): void => {
      const percent = updateStore.getSnapshot().percent;
      if (percent === null) {
        el.style.removeProperty("--tugx-update-progress");
        el.removeAttribute("data-progress");
        return;
      }
      el.style.setProperty("--tugx-update-progress", `${percent}%`);
      el.setAttribute("data-progress", String(percent));
    };
    paint();
    return updateStore.subscribe(paint);
  }, [el]);
}

/** The controls the current stage allows, left to right. */
function PopoverControls({
  state,
  onAct,
}: {
  state: UpdateRenderSnapshot;
  onAct: (action: Parameters<typeof postUpdateAction>[0]) => void;
}): React.ReactElement | null {
  switch (state.stage) {
    case "checking":
      return (
        <div className="tugx-update-controls">
          <TugButton size="sm" emphasis="outlined" onClick={() => onAct("cancel")}>
            Cancel
          </TugButton>
        </div>
      );

    case "available":
      return (
        <div className="tugx-update-controls">
          <TugButton
            size="sm"
            emphasis="primary"
            role="accent"
            onClick={() => onAct("install")}
          >
            Install and Relaunch
          </TugButton>
          <TugButton size="sm" emphasis="outlined" onClick={() => onAct("later")}>
            Later
          </TugButton>
          <TugButton size="sm" emphasis="ghost" onClick={() => onAct("skip")}>
            Skip This Version
          </TugButton>
        </div>
      );

    case "downloading":
      return (
        <div className="tugx-update-controls">
          <TugButton size="sm" emphasis="outlined" onClick={() => onAct("cancel")}>
            Cancel
          </TugButton>
        </div>
      );

    // Extraction is past the point where cancelling means anything — Sparkle
    // hands back no cancellation for it, so offering one would be a button
    // that does nothing.
    case "extracting":
    case "installing":
      return null;

    case "readyToInstall":
      return (
        <div className="tugx-update-controls">
          <TugButton
            size="sm"
            emphasis="primary"
            role="accent"
            onClick={() => onAct("install")}
          >
            Install and Relaunch
          </TugButton>
          <TugButton size="sm" emphasis="outlined" onClick={() => onAct("later")}>
            Later
          </TugButton>
        </div>
      );

    case "upToDate":
      return null;

    case "error":
      return (
        <div className="tugx-update-controls">
          <TugButton
            size="sm"
            emphasis="primary"
            role="accent"
            onClick={() => onAct("retry")}
          >
            Retry
          </TugButton>
          <TugButton size="sm" emphasis="outlined" onClick={() => onAct("dismiss")}>
            Dismiss
          </TugButton>
        </div>
      );

    case "idle":
      return null;
  }
}

/** The pill and its popover, for a stage that has something to say. */
function UpdatePanel({ state }: { state: UpdateRenderSnapshot }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pillEl, setPillEl] = useState<HTMLButtonElement | null>(null);
  useProgressProperty(pillEl);

  const midTurnTitles = useMidTurnSessionTitles();
  const warning = relaunchWarningLine(midTurnTitles);

  // The one focus exception. A check the user started opens on its answer,
  // because being shown the answer is what they asked for. Tracked against
  // the stage so a later transition inside the same user-initiated flow —
  // `available` to `downloading` — does not re-open a popover they closed.
  const announced = useRef<UpdateStage | null>(null);
  useEffect(() => {
    if (!state.userInitiated || !ANSWER_STAGES.has(state.stage)) {
      if (!ANSWER_STAGES.has(state.stage)) announced.current = null;
      return;
    }
    if (announced.current === state.stage) return;
    announced.current = state.stage;
    setOpen(true);
  }, [state.userInitiated, state.stage]);

  // `upToDate` is an answer with nothing left to do once read, so it clears
  // itself — acknowledging to the host on the way out, which is what lets
  // Sparkle finish the session.
  useEffect(() => {
    if (state.stage !== "upToDate") return;
    const timer = window.setTimeout(() => {
      postUpdateAction("dismiss");
    }, UP_TO_DATE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [state.stage]);

  const act = useCallback(
    (action: Parameters<typeof postUpdateAction>[0]) => {
      // Install ends in a relaunch and dismiss ends the notice; either way
      // the popover has said everything it is going to.
      if (action !== "cancel") setOpen(false);
      postUpdateAction(action);
    },
    [],
  );

  const notes = state.releaseNotes;

  return (
    <div className="tugx-update-overlay">
      <TugPopover open={open} onOpenChange={setOpen}>
        <TugPopoverTrigger>
          <button
            ref={setPillEl}
            type="button"
            className="tugx-update-pill"
            data-stage={state.stage}
            data-testid="update-pill"
            aria-label={`${popoverTitle(state)} — open update details`}
          >
            {state.stage === "available" ? DOWNLOAD_SVG : null}
            <span className="tugx-update-pill-label">{pillLabel(state)}</span>
            <span className="tugx-update-pill-underline" aria-hidden="true" />
          </button>
        </TugPopoverTrigger>
        <TugPopoverContent side="bottom" align="end">
          {/* The body is its own element rather than the popover chrome:
              TugPopoverContent forwards a fixed prop list, so a `data-*`
              written on it never reaches the DOM. */}
          <div
            className="tugx-update-popover"
            data-testid="update-popover"
            data-stage={state.stage}
          >
            <h2 className="tugx-update-title">{popoverTitle(state)}</h2>

            {state.stage === "error" && state.message !== "" ? (
              <p className="tugx-update-message" data-testid="update-error-message">
                {state.message}
              </p>
            ) : null}

            {notes !== null && notes.trim() !== "" ? (
              <div className="tugx-update-notes" data-testid="update-release-notes">
                {/* Keyed on the text: TugMarkdownBlock's static mode is
                    mount-once, so notes arriving after the popover opened —
                    which is the ordinary case for linked notes — need a
                    remount to be seen. */}
                <TugMarkdownBlock key={notes} initialText={notes} />
              </div>
            ) : null}

            {state.stage === "downloading" || state.stage === "extracting" ? (
              <UpdateProgressBar />
            ) : null}

            {state.stage === "readyToInstall" ? (
              <p className="tugx-update-note">
                Later leaves the update to install the next time you quit Tug.
              </p>
            ) : null}

            {warning !== null &&
            (state.stage === "available" || state.stage === "readyToInstall") ? (
              <p className="tugx-update-warning" data-testid="update-mid-turn-warning">
                {warning}
              </p>
            ) : null}

            <PopoverControls state={state} onAct={act} />
          </div>
        </TugPopoverContent>
      </TugPopover>
    </div>
  );
}

/** The popover's progress bar — the same CSS property, on its own element. */
function UpdateProgressBar(): React.ReactElement {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useProgressProperty(el);
  return (
    <div
      ref={setEl}
      className="tugx-update-progress"
      data-testid="update-progress"
      role="progressbar"
      aria-label="Update progress"
    >
      <div className="tugx-update-progress-fill" aria-hidden="true" />
    </div>
  );
}

/**
 * Deck-global mount: renders the pill only while the host has something to
 * say, and nothing at all otherwise.
 */
export function UpdateOverlay(): React.ReactElement | null {
  const state = useUpdateState();
  const overlayRoot = useCanvasOverlay();
  if (!VISIBLE_STAGES.has(state.stage)) return null;
  return createPortal(<UpdatePanel state={state} />, overlayRoot);
}
