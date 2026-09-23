/**
 * update-tug-rows — the wizard's four rows, as a function of what is true.
 *
 * `UpdateTug` used to compute these inline, which was fine while the only
 * input was the host's snapshot: a pure function of one argument that happens
 * to live in a component file is still testable by reading it. It stopped
 * being fine when the *Stop work in flight* row arrived, because that row is a
 * reading of the deck rather than of Sparkle, and the interesting cases are
 * exactly the crossings — every stage with turns live and with none. Mounting
 * a modal to check one of them is not a test anybody writes twice.
 *
 * So the derivation moved here and the component became a render over it, the
 * shape `ConfigureTug`'s `derive*` helpers already have ([B07]). The rule for
 * what belongs in this file is the one that makes it worth having: everything
 * here is a function of its arguments, and every argument is something a test
 * can state.
 *
 * `ProgressDetail` came along because it is the one row detail that is a
 * component rather than a string, and leaving it behind would have meant the
 * derivation returning a placeholder for the component to substitute — a
 * second place to be wrong about which row is downloading.
 *
 * @module components/tugways/update-tug-rows
 */

import {
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useState,
} from "react";

import { relaunchWarningLine } from "@/lib/update-relaunch-warning";
import type { LiveTurnsSnapshot } from "@/lib/live-turns-store";
import {
  updateStore,
  type UpdateAction,
  type UpdateRenderSnapshot,
  type UpdateStage,
} from "@/lib/update-store";
import type { TugStepRowStatus } from "./tug-step-row";

/** The four rows, in the order they are walked ([B02]). */
export type RowKey = "check" | "download" | "stop-work" | "relaunch";

/**
 * The one press in the wizard that is answered by the deck rather than by the
 * host. It travels where a {@link UpdateAction} travels because it is the same
 * kind of thing from a row's point of view — a label and a press — and giving
 * it its own field would mean every reader checking two.
 *
 * It is spelled the same as the row's own {@link RowKey} because it is the
 * same thing twice: this row is its press, and one spelling in the DOM is what
 * `data-step` and `data-testid` both end up carrying.
 */
export const STOP_WORK = "stop-work";

/** One row, before its CTA is composed. */
export interface RowModel {
  key: RowKey;
  label: string;
  status: TugStepRowStatus;
  detail?: ReactNode;
  cta?: {
    label: string;
    action: UpdateAction | typeof STOP_WORK;
  };
}

/**
 * Which row a stage is standing on, or `null` for the two stages that are an
 * answer rather than a position.
 *
 * `available` belongs to the download row rather than the check row: the check
 * is over, and what the update is waiting on is the user pressing Download.
 *
 * No stage returns `stop-work`, and that is the point of the row: the host has
 * no idea whether any work is in flight, so there is no stage of Sparkle's that
 * could be standing there. The row is derived from the deck at every moment
 * ([B03]), and what this function answers is only where a *host* failure lands.
 */
export function rowForStage(stage: UpdateStage): RowKey | null {
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
 * The download row's detail line while bytes are arriving, written onto its own
 * span from a direct store subscription.
 *
 * The whole of [L06] for this component, and the same span the inline surface
 * used: the percent moves about once a second through a download, and routing it
 * through a render would re-render the panel and its rows for a word.
 */
export function ProgressDetail(): ReactElement {
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

/**
 * The four rows for the moment in hand.
 *
 * Unpacking is the download row's detail phase rather than a row ([B02]): the
 * user named four things, and "Verifying the signature…" is a sentence about
 * the download rather than a step they can do anything about.
 *
 * @param state       the host's update snapshot — Sparkle's half of the answer.
 * @param liveTurns   the deck's half: how many cards have a turn in flight, and
 *                    their titles.
 * @param waitingRow  which row a host failure lands on; see {@link rowForStage}.
 * @param stalled     whether the current wait has passed its horizon ([L33]).
 * @param interrupting whether a Stop Work press is still running its bounded
 *                    wait. Not derivable from `liveTurns` — a press whose
 *                    sessions have not acknowledged yet leaves the count
 *                    exactly where it was, which is the case the busy state is
 *                    for.
 */
export function deriveUpdateRows(
  state: UpdateRenderSnapshot,
  liveTurns: LiveTurnsSnapshot,
  waitingRow: RowKey,
  stalled: boolean,
  interrupting: boolean,
): RowModel[] {
  const stage = state.stage;

  // Plain steps, in one register, and none of them carries the version. The
  // panel's title already says which update this is, and a label that changed
  // length as the version changed was the one row that reflowed.
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
      // downloading costs nothing, and stopping work is its own step ([B03]).
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

  // The host's rows, and only those, take the failure sweeps. The Stop-work row
  // is spliced in afterwards because it is the deck's answer and the deck is
  // never wrong about it — a sweep that marked it `done` on the way past would
  // be claiming, on Sparkle's authority, something only the deck can know.
  const hostRows = [check, download, relaunch];

  // `error` lands on the row that was waiting, because the snapshot says a
  // failure happened and not which step it happened in ([B08]). Putting the red
  // dot anywhere else would be asserting something nobody said.
  if (stage === "error") {
    for (const row of hostRows) {
      if (row.key === waitingRow) break;
      row.status = "done";
    }
    const failed = hostRows.find((row) => row.key === waitingRow);
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
    const waiting = hostRows.find((row) => row.key === waitingRow);
    if (waiting) {
      waiting.status = "error";
      waiting.detail = "Tug has heard nothing back for a while.";
      waiting.cta = { label: "Retry", action: "retry" };
    }
  }

  const stopWork = deriveStopWorkRow(stage, liveTurns, interrupting);

  // The install row opens only once the Stop-work row is done ([B04]). Pending
  // rather than disabled: a dead primary button with no explanation is a dead
  // button by another name, and a grey row whose turn has not come is a shape
  // this panel already uses three times.
  if (stage === "readyToInstall" && stopWork.status === "done") {
    relaunch.status = "active";
    relaunch.detail = "Tug quits and reopens on the new version.";
    relaunch.cta = { label: "Install and Relaunch", action: "install" };
  }

  return [check, download, stopWork, relaunch];
}

/**
 * The *Stop work in flight* row — derived from the deck, never latched ([B03]).
 *
 * It remembers no press. A user who stops their turns in the cards themselves
 * sees it settle with nothing pressed here; a turn started after a Stop Work
 * press flips it back to active and takes the install button away again. That
 * second property is the guarantee the whole row exists for, and it is a
 * property of deriving rather than of any check performed at the press: the
 * install is never offered while a turn exists, so it can never end one.
 */
function deriveStopWorkRow(
  stage: UpdateStage,
  liveTurns: LiveTurnsSnapshot,
  interrupting: boolean,
): RowModel {
  const row: RowModel = {
    key: "stop-work",
    label: "Stop work in flight",
    status: "pending",
  };

  // Before the download has landed there is nothing to stop *for*. Downloading
  // ends no turns, so a row that went active during it would be asking the user
  // to give something up for a step that costs nothing.
  if (stage !== "readyToInstall" && stage !== "installing") return row;

  if (interrupting) {
    row.status = "busy";
    row.detail = "Stopping work in flight…";
    row.cta = { label: "Stop Work", action: STOP_WORK };
    return row;
  }

  const warning = relaunchWarningLine(liveTurns.titles);
  if (warning === null) {
    row.status = "done";
    row.detail = "Nothing is running.";
    return row;
  }

  row.status = "active";
  row.detail = warning;
  row.cta = { label: "Stop Work", action: STOP_WORK };
  return row;
}
