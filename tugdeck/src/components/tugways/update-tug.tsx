/**
 * UpdateTug — the app-modal update wizard, and a sibling of ConfigureTug.
 *
 * One wizard, three steps: Check, Download, Install and relaunch ([B08]). It
 * borrows TugAlert's app-modal chrome the same way ConfigureTug does (a Radix
 * AlertDialog portalled into the canvas overlay, `tug-alert-overlay` /
 * `tug-alert-content` at z-index 99990/99991, which actually blocks the deck)
 * and hangs a `TugStepRow` checklist in it. Siblings, never merged ([B01]):
 * setup can be *required* and blocks until it is done, and an update is always
 * optional and always pausable — which is the whole of why ConfigureTug's
 * request store needs an `onDemand` flag and this one does not.
 *
 * # Two doors, and both only raise it
 *
 * `revealCount` rides the update snapshot, bumped by the Tug-menu item and by
 * Sparkle's own `showUpdateInFocus`, and it crosses as a monotonic count rather
 * than a callback so a deck reload that replays the same snapshot re-reads a
 * number this component has already acted on ([B06]). `update-tug-request-store`
 * is the other, and it is deck-local: the pill's click answers nothing across
 * the bridge, so it needs no action and no snapshot field ([B01]).
 *
 * Neither door *decides* anything. Raising the wizard is not a step of the
 * update, and a scheduled check that finds something raises nothing at all — it
 * lights the pill and waits ([B03]).
 *
 * # Closing is pause, not dismissal
 *
 * The Close button and Escape take the wizard off the screen and do nothing
 * else: Sparkle is answered nothing, no held closure is consumed, no host state
 * moves, and a download that was running keeps running. Reopening lands on
 * whatever stage the flow has reached in the meantime, because the wizard holds
 * no flow state of its own — it is a reading of the host's snapshot ([B04]).
 *
 * The two stages that end the flow are the exception, and they are an exception
 * about Sparkle rather than about the wizard: `upToDate` and `error` are notices
 * Sparkle will not finish its session without an acknowledgement for, so the
 * button on those stages says Done / Dismiss and posts one. Escape does exactly
 * what the button does, on every stage, so there is never a way out that leaves
 * the host waiting on a reply the user thinks they sent.
 *
 * # The interrupt gate sits on the install CTA
 *
 * Not on opening the wizard ([B07]). Looking at the update, checking for one and
 * downloading one end no turns, so there is nothing to confirm on the way in —
 * unlike ConfigureTug, whose steps re-run the install and can't share the app
 * with live work. Exactly one press in the whole flow ends turns: *Install and
 * Relaunch*, which quits the app. That press runs the same count-and-confirm
 * `ConfigureTugRequest` runs, in its own words, interrupts every card whose
 * `canInterrupt` is true, and only then answers Sparkle ([F09]) — the order
 * matters, because the reply is what starts the quit.
 *
 * # [L33], and why an app-modal is allowed to wait here at all
 *
 * The law's second clause is that no app-wide modal may depend on anything
 * outside the deck, and every wait in this wizard depends on Sparkle, the host
 * and the network. It complies the way ConfigureTug complies: by bounding every
 * wait, naming the terminal state, and letting go of the app when it cannot make
 * its claim ([B04]). {@link WAIT_DEADLINE_MS} is that bound. A wait that passes
 * its deadline with nothing having moved becomes a named failed step with Retry
 * on it, and Close is on the panel at every moment of the flow — so the
 * reviewer's test ("if the thing you are waiting on never answers, what does the
 * user see, and what can they do?") answers *a failed row, and Close or Retry*.
 *
 * The granularity clause is what makes this different from the restore gate the
 * long form rejected a softened modal for: that gate staged one card's wait over
 * every card. An app update is not one card's wait — there is no narrower thing
 * that is waiting — so app-wide is its granularity.
 *
 * # Laws
 *
 * [L02] — the host's snapshot enters through `useUpdateState`, and the request
 * nonce and the open flag through `useUpdateTugRequest` / `useUpdateTugOpen`;
 * all three are `useSyncExternalStore`.
 * [L06] — download progress is written onto its own span from a direct store
 * subscription and never renders. See {@link ProgressDetail}.
 * [L19] — `.tsx`/`.css` pair, `data-slot`.
 * [L33] — every wait is bounded; see above.
 *
 * @module components/tugways/update-tug
 */

import "./tug-alert.css";
import "./update-tug.css";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { ArrowDownToLine, CircleCheck, TriangleAlert } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { cardServicesStore } from "@/lib/card-services-store";
import { useDeckManager } from "@/deck-manager-context";
import { relaunchWarningLine } from "@/lib/update-relaunch-warning";
import {
  postUpdateAction,
  updateStore,
  useUpdateState,
  type UpdateAction,
  type UpdateRenderSnapshot,
  type UpdateStage,
} from "@/lib/update-store";
import {
  setUpdateTugOpen,
  useUpdateTugOpen,
  useUpdateTugRequest,
} from "@/lib/update-tug-request-store";
import { TugPushButton } from "./tug-push-button";
import { useTugAlert } from "./tug-alert";
import { TugStepRow, type TugStepRowStatus } from "./tug-step-row";

/**
 * How long each waiting stage may sit with nothing moving before it is called
 * stalled ([L33]).
 *
 * These are horizons, not Sparkle's own timeouts — Sparkle has those and they
 * are better than these at deciding a download has failed. What these bound is
 * the *modal*: the case where Sparkle says nothing at all, which no timeout of
 * its own can report because reporting is the thing that stopped. A stage
 * missing from this table is one that is not waiting on anything.
 *
 * The clock is generous, and deliberately: a slow network moving a percent a
 * minute is working, and a wizard that called it failed would be wrong far more
 * often than it was right. `downloading` resets its clock on every percent that
 * moves, so its deadline measures silence rather than duration.
 */
const WAIT_DEADLINE_MS: Partial<Record<UpdateStage, number>> = {
  checking: 60_000,
  downloading: 120_000,
  extracting: 120_000,
  installing: 180_000,
};

/** The three rows, in the order they are walked. */
type RowKey = "check" | "download" | "relaunch";

/**
 * Which row a stage is standing on, or `null` for the two stages that are an
 * answer rather than a position.
 *
 * `available` belongs to the download row rather than the check row: the check
 * is over, and what the update is waiting on is the user pressing Download.
 */
function rowForStage(stage: UpdateStage): RowKey | null {
  switch (stage) {
    case "idle":
    case "checking":
      return "check";
    case "available":
    case "downloading":
    case "extracting":
      return "download";
    case "readyToInstall":
    case "installing":
      return "relaunch";
    case "upToDate":
    case "error":
      return null;
  }
}

/**
 * The row a terminal stage settles on ([B08]).
 *
 * `upToDate` and `error` are states of whichever row was waiting rather than
 * notices of their own, and the snapshot does not say which row that was — it
 * carries the stage the flow is in now, and the one it came from is gone. So the
 * last non-terminal row is remembered here.
 *
 * Written during render rather than from an effect on purpose: the value is
 * needed by the same render that sees the terminal stage, and an effect would
 * paint one frame with the wrong row highlighted. It is a pure function of the
 * stages this component has already rendered, so re-running the render body with
 * the same stage writes the same value.
 */
function useWaitingRow(stage: UpdateStage): RowKey {
  const remembered = useRef<RowKey>("check");
  const row = rowForStage(stage);
  if (row !== null) remembered.current = row;
  return remembered.current;
}

/**
 * Whether the current wait has passed its horizon with nothing having moved.
 *
 * The clock is armed per stage and re-armed on every percent that changes,
 * which is why it subscribes to the store directly rather than depending on a
 * rendered value: percent is elided from the render snapshot ([L06]), so a
 * download that is making progress would otherwise look exactly like one that
 * had stopped.
 *
 * `rearm` is the Retry button's nonce — a retry that posts an action the host
 * does not move on must still put the clock back, or the failed row would come
 * straight back without the wait having been given another chance.
 */
function useStalled(stage: UpdateStage, rearm: number): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    const deadline = WAIT_DEADLINE_MS[stage];
    if (deadline === undefined) return;
    let timer = 0;
    const arm = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setStalled(true), deadline);
    };
    arm();
    let lastPercent = updateStore.getSnapshot().percent;
    const unsubscribe = updateStore.subscribe(() => {
      const percent = updateStore.getSnapshot().percent;
      if (percent === lastPercent) return;
      lastPercent = percent;
      arm();
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [stage, rearm]);
  return stalled;
}

/**
 * The download row's detail line while bytes are arriving, written onto its own
 * span from a direct store subscription.
 *
 * The whole of [L06] for this component, and the same span the inline surface
 * used: the percent moves about once a second through a download, and routing it
 * through a render would re-render the panel and its three rows for a word.
 */
function ProgressDetail(): ReactElement {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (el === null) return;
    const paint = (): void => {
      const percent = updateStore.getSnapshot().percent;
      // `null` is not zero: a total nobody has reported yet is "starting", and
      // a bar sitting at 0% would be saying something false.
      el.textContent = percent === null ? "Starting…" : `${percent}% downloaded`;
      if (percent === null) el.removeAttribute("data-progress");
      else el.setAttribute("data-progress", String(percent));
    };
    paint();
    return updateStore.subscribe(paint);
  }, [el]);
  return <span ref={setEl} data-testid="update-tug-progress" />;
}

/** One row, before its CTA is composed. */
interface RowModel {
  key: RowKey;
  label: string;
  status: TugStepRowStatus;
  detail?: ReactNode;
  cta?: {
    label: string;
    action: UpdateAction;
    /**
     * Whether this press has to stop live turns first ([B07]). It rides the CTA
     * rather than being read off the action, because `install` is also the
     * download's action and downloading ends no turns.
     */
    gated?: boolean;
  };
}

/** The panel's title, which tracks the stage the way the menu item's does. */
function title(state: UpdateRenderSnapshot): string {
  switch (state.stage) {
    case "idle":
    case "checking":
      return "Check for Updates";
    case "upToDate":
      return "Tug Is Up to Date";
    case "error":
      return "Update Failed";
    default:
      return state.version === ""
        ? "Update Tug"
        : `Update to Tug ${state.version}`;
  }
}

function StageIcon({ stage }: { stage: UpdateStage }): ReactElement {
  switch (stage) {
    case "upToDate":
      return <CircleCheck />;
    case "error":
      return <TriangleAlert />;
    default:
      return <ArrowDownToLine />;
  }
}

/**
 * The three rows for the stage in hand.
 *
 * Unpacking is the download row's detail phase rather than a fourth row ([B08]):
 * the user named three things, and "Verifying the signature…" is a sentence
 * about the download rather than a step they can do anything about.
 */
function rows(
  state: UpdateRenderSnapshot,
  waitingRow: RowKey,
  stalled: boolean,
): RowModel[] {
  const stage = state.stage;

  // Three plain steps, in one register, and none of them carries the version.
  // The panel's title already says which update this is, and a label that
  // changed length as the version changed was the one row that reflowed.
  const check: RowModel = { key: "check", label: "Check for an update", status: "pending" };
  const download: RowModel = { key: "download", label: "Download the update", status: "pending" };
  const relaunch: RowModel = {
    key: "relaunch",
    label: "Install and relaunch",
    status: "pending",
  };

  switch (stage) {
    case "idle":
      check.status = "active";
      check.detail = "Look for a newer version of Tug.";
      check.cta = { label: "Check Now", action: "check" };
      break;
    case "checking":
      check.status = "busy";
      check.detail = "Looking for a newer version…";
      if (state.cancellable) check.cta = { label: "Cancel", action: "cancel" };
      break;
    case "available":
      check.status = "done";
      check.detail = state.version === "" ? "An update is available." : `Tug ${state.version} is available.`;
      download.status = "active";
      // Said here because it is the one thing the user cannot tell by looking:
      // downloading costs nothing, and only the last step ends any work ([B07]).
      download.detail = "Downloading won't interrupt your work.";
      download.cta = { label: "Download", action: "install" };
      break;
    case "downloading":
      check.status = "done";
      download.status = "busy";
      download.detail = <ProgressDetail />;
      if (state.cancellable) download.cta = { label: "Cancel", action: "cancel" };
      break;
    case "extracting":
      check.status = "done";
      download.status = "busy";
      download.detail = "Verifying the signature…";
      break;
    case "readyToInstall":
      check.status = "done";
      download.status = "done";
      download.detail = "Downloaded and verified.";
      relaunch.status = "active";
      relaunch.detail =
        "Tug quits and reopens on the new version. Work in flight stops with it.";
      relaunch.cta = { label: "Install and Relaunch", action: "install", gated: true };
      break;
    case "installing":
      check.status = "done";
      download.status = "done";
      download.detail = "Downloaded and verified.";
      relaunch.status = "busy";
      relaunch.detail = "Installing. Tug reopens in a moment…";
      break;
    case "upToDate":
      check.status = "done";
      // Not "Tug is up to date": that is the title, one line above, and a panel
      // that says its one sentence twice reads as a stutter rather than as an
      // answer.
      check.detail = "No newer version has been released.";
      break;
    case "error":
      break;
  }

  const all = [check, download, relaunch];

  // `error` lands on the row that was waiting, because the snapshot says a
  // failure happened and not which step it happened in ([B08]). Putting the red
  // dot anywhere else would be asserting something nobody said.
  if (stage === "error") {
    for (const row of all) {
      if (row.key === waitingRow) break;
      row.status = "done";
    }
    const failed = all.find((row) => row.key === waitingRow);
    if (failed) {
      failed.status = "error";
      failed.detail =
        state.message === "" ? "Tug could not finish the update." : state.message;
      failed.cta = { label: "Retry", action: "retry" };
    }
  }

  // A wait that passed its horizon is a failed step with a way out ([L33]). It
  // overwrites whatever the stage had to say, because what the stage has to say
  // is that it is still working, and the point of the horizon is that nobody
  // should have to keep believing that.
  if (stalled) {
    const waiting = all.find((row) => row.key === waitingRow);
    if (waiting) {
      waiting.status = "error";
      waiting.detail = "Tug has heard nothing back for a while.";
      waiting.cta = { label: "Retry", action: "retry" };
    }
  }

  return all;
}

/**
 * The panel's one bottom button.
 *
 * Close is pause and posts nothing. The two terminal stages are the exception,
 * and about Sparkle rather than about the wizard: it holds a notice open until
 * it is acknowledged, so those stages send one.
 */
function closeAction(stage: UpdateStage): { label: string; action: UpdateAction | null } {
  switch (stage) {
    case "upToDate":
      return { label: "Done", action: "dismiss" };
    case "error":
      return { label: "Dismiss", action: "dismiss" };
    default:
      return { label: "Close", action: null };
  }
}

export function UpdateTug(): ReactElement {
  const state = useUpdateState();
  const overlayRoot = useCanvasOverlay();
  const requestNonce = useUpdateTugRequest();
  const deck = useDeckManager();
  const showAlert = useTugAlert();
  // Open/closed lives in the request store rather than here, because the pill
  // reads it: it shows only while an update is live and this wizard is closed
  // ([B02]), and the two have no parent between them. This component is still
  // the only writer.
  const open = useUpdateTugOpen();
  const [retryNonce, setRetryNonce] = useState(0);

  const waitingRow = useWaitingRow(state.stage);
  const stalled = useStalled(state.stage, retryNonce);

  // The host's door. A count rather than a callback, so the replay that follows
  // a deck reload re-reads a number this ref has already seen and nothing
  // happens; a number it has not seen is a raise, acted on exactly once ([B06]).
  const revealed = useRef(state.revealCount);
  useEffect(() => {
    if (revealed.current === state.revealCount) return;
    revealed.current = state.revealCount;
    setUpdateTugOpen(true);
  }, [state.revealCount]);

  // The deck's door — the pill ([B01]). Same shape, and the initial value is
  // read rather than zeroed so a wizard mounted after a click does not open on
  // a request that was answered before it existed.
  const requested = useRef(requestNonce);
  useEffect(() => {
    if (requested.current === requestNonce) return;
    requested.current = requestNonce;
    setUpdateTugOpen(true);
  }, [requestNonce]);

  // Nothing to be open about. `idle` is the host saying the flow is over — the
  // user dismissed it, or it finished — and a panel left standing on it would be
  // a wizard about no update.
  //
  // Except when the flow is on its way *through* `idle` rather than ending in
  // it. Retry and Check Now are both answered by acknowledging the old notice,
  // publishing `dismissed` — an `idle` snapshot the deck really does receive —
  // and only then starting the check that lands on `checking`. Read literally,
  // the rule above closes the wizard in answer to the one press that asked for
  // the opposite: the user presses Retry on a failed update and the whole
  // surface vanishes, with no pill for `checking` to bring it back.
  //
  // So a press that expects a new check suppresses exactly one `idle`, and the
  // first stage that is not `idle` clears the expectation. Nothing else is
  // needed as a floor: a check that never starts leaves the wizard standing on
  // its Check row with Check Now on it, which is the state the user can act
  // from.
  const expectingCheck = useRef(false);
  useEffect(() => {
    if (state.stage !== "idle") {
      expectingCheck.current = false;
      return;
    }
    if (expectingCheck.current) {
      expectingCheck.current = false;
      return;
    }
    setUpdateTugOpen(false);
  }, [state.stage]);

  const close = useCallback(() => {
    const { action } = closeAction(updateStore.getSnapshot().stage);
    if (action !== null) postUpdateAction(action);
    setUpdateTugOpen(false);
  }, []);

  const act = useCallback((action: UpdateAction) => {
    // Retry re-arms the horizon as well as posting: a host that does not move on
    // the action would otherwise hand back the failed row immediately, and the
    // user would have been given a button rather than another chance.
    if (action === "retry") setRetryNonce((n) => n + 1);
    // Both of these ask the host for a new check, and the host's route to one
    // passes through `idle`. See the effect above.
    if (action === "retry" || action === "check") expectingCheck.current = true;
    postUpdateAction(action);
  }, []);

  /**
   * The one press in the flow that ends turns ([B07]): install and relaunch
   * quits the app, so every live turn stops with it whether or not anybody says
   * so. Count first, confirm in the update's own words, interrupt each card, and
   * only then answer Sparkle — the reply is what starts the quit, so a reply
   * sent before the interrupts would race the very work it is stopping ([F09]).
   *
   * The confirm is the TugAlert singleton, opened over this wizard rather than
   * in place of it: the panel behind it is the context for the question, and
   * Radix stacks the two layers with the newer one holding focus.
   *
   * It names the sessions rather than counting them, up to the point where a
   * list becomes a wall — {@link relaunchWarningLine} is where that fold lives,
   * and it is the one thing Sparkle's own relaunch dialog could never say,
   * since only the deck knows which cards have a turn in flight.
   */
  const installWithGate = useCallback(() => {
    // `canInterrupt` is the store's own answer to "is there a turn to stop" —
    // the same read the logout and setup gates take.
    const running: Array<() => void> = [];
    const titles: string[] = [];
    for (const card of deck.getSnapshot().cards) {
      const services = cardServicesStore.getServices(card.id);
      if (services?.codeSessionStore.getSnapshot().canInterrupt) {
        running.push(() => services.codeSessionStore.interrupt("update-tug"));
        titles.push(card.title);
      }
    }

    if (running.length === 0) {
      postUpdateAction("install");
      return;
    }

    void (async () => {
      // `running` is non-empty here, so the line is never null: the null case
      // is "nothing is mid-turn", and that took the branch above.
      const warning = relaunchWarningLine(titles) ?? "";
      const confirmed = await showAlert({
        title: "Stop Work and Relaunch?",
        message: `${warning} Tug quits and reopens on the new version.`,
        confirmLabel: "Stop and Relaunch",
        cancelLabel: "Cancel",
        confirmRole: "danger",
      });
      if (!confirmed) return;
      // Guarded: a card whose session went away between the count and the
      // confirm must not strand the install.
      for (const interrupt of running) {
        try {
          interrupt();
        } catch {
          // Session already gone — the install proceeds.
        }
      }
      postUpdateAction("install");
    })();
  }, [deck, showAlert]);

  const model = rows(state, waitingRow, stalled);
  const exit = closeAction(state.stage);

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal container={overlayRoot}>
        <AlertDialog.Overlay className="tug-alert-overlay" />
        <AlertDialog.Content
          className="tug-alert-content update-tug"
          data-slot="update-tug"
          data-testid="update-tug"
          data-stage={state.stage}
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            // Escape is the same act as the bottom button, on every stage — so
            // there is no way out that leaves Sparkle waiting on a reply the
            // user believes they sent.
            e.preventDefault();
            close();
          }}
        >
          {/* In-jail key sink ([P13]): AlertDialog.Content's FocusScope is
              always trapped, so the engine's park must land inside it or every
              park while the wizard is up is answered by a Radix refocus. */}
          <div
            data-tug-key-sink=""
            tabIndex={-1}
            className="tug-key-sink"
            aria-label="Keyboard"
          />
          <div className="tug-alert-body" data-icon-role={state.stage === "error" ? "danger" : "action"}>
            <div className="tug-alert-icon" aria-hidden="true">
              <StageIcon stage={state.stage} />
            </div>
            <div className="tug-alert-text">
              <AlertDialog.Title className="tug-alert-title">
                {title(state)}
              </AlertDialog.Title>
            </div>
          </div>

          <ol className="update-tug-steps">
            {model.map((row) => (
              <TugStepRow
                key={row.key}
                className="update-tug-step"
                stepKey={row.key}
                status={row.status}
                label={row.label}
                detail={row.detail}
                action={
                  row.cta ? (
                    <TugPushButton
                      size="sm"
                      emphasis={row.status === "error" ? "outlined" : "filled"}
                      role={row.status === "error" ? "danger" : "action"}
                      disabled={row.status === "busy" && row.cta.action !== "cancel"}
                      data-testid={`update-tug-action-${row.cta.action}`}
                      onClick={() => {
                        if (!row.cta) return;
                        if (row.cta.gated) installWithGate();
                        else act(row.cta.action);
                      }}
                    >
                      {row.cta.label}
                    </TugPushButton>
                  ) : row.status === "done" ? (
                    <CircleCheck className="update-tug-step-check" size={28} aria-hidden="true" />
                  ) : null
                }
              />
            ))}
          </ol>

          <div className="tug-alert-actions">
            <TugPushButton
              size="sm"
              emphasis="primary"
              role="action"
              data-testid="update-tug-close"
              onClick={close}
            >
              {exit.label}
            </TugPushButton>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
