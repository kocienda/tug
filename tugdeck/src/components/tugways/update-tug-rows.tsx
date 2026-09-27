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
import {
  newRateEstimator,
  transferDetailLine,
  type RateEstimator,
} from "@/lib/transfer-rate";
import type { LiveTurnsSnapshot } from "@/lib/live-turns-store";
import {
  updateStore,
  type UpdateAction,
  type UpdateRenderSnapshot,
  type UpdateStage,
} from "@/lib/update-store";
import type { TugStepRowStatus } from "./tug-step-row";
import { TugProgressIndicator } from "./tug-progress-indicator";

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
  /**
   * The row's stacking control slot, under the detail line. No row of this
   * wizard uses it: a slot that stacks costs the row a line, and every row
   * here keeps one height through the whole flow ([B01]). It stays on the
   * model because it is `TugStepRow`'s slot rather than this file's, and a
   * future row of prose-plus-control would want it.
   */
  body?: ReactNode;
  /**
   * The strip along the bottom of the plinth — a progress bar on every row
   * that has a fraction to report ([B04]). It is where the bar goes rather than
   * {@link body} because chrome on the plinth costs no height, and a bar that
   * cost one moved every row under it. A stage with no fraction gets no strip:
   * the row's dot already breathes on `busy`, and a barber pole at the edge is
   * that same sentence said louder.
   */
  edge?: ReactNode;
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
    case "paused":
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
 *
 * It says bytes, rate and time remaining rather than a bare percent ([B06]), and
 * what stopping would cost as its closing clause ([B05]) — a consequence the
 * panel says nowhere else, folded into this line rather than given one of its
 * own so the row stays the same two lines as every other row.
 * The percent is the one thing the bar beside it already draws; what the number
 * cannot say — how fast, how much longer — is what a person watching a slow
 * download is actually deciding on. Rate and ETA are measured here, from the
 * pairs the store hands over, and join the line only once they exist: a line
 * that appeared complete with a made-up rate in it would be worse than one that
 * grows.
 *
 * `data-progress` stays on the span. It is what `at0612` reads, and a percent
 * is still the cheapest thing for a test to assert on.
 */
export function ProgressDetail(): ReactElement {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (el === null) return;
    // The estimator lives in the closure rather than in a ref: it is reset by
    // the row unmounting, which is exactly when a new transfer starts.
    let rate: RateEstimator = newRateEstimator();
    const paint = (): void => {
      const { percent, receivedBytes, expectedBytes, cancellable } =
        updateStore.getSnapshot();
      rate = rate.sample(receivedBytes, performance.now());
      el.textContent = transferDetailLine(
        receivedBytes,
        expectedBytes,
        rate.bytesPerSecond,
        // Sparkle's download cannot be resumed where it left off — the spike
        // settled that — so *Stop for Now* throws away everything that has
        // arrived. A button that did so quietly would be the kind a user
        // presses once and never trusts again. The line names the bytes just
        // before this clause, so the clause says "it" rather than the number a
        // second time.
        //
        // Only where the press exists. `cancellable` is the host's word for
        // "there is a closure to call", and it is what gates the button; a
        // warning about a button that is not there would be describing a press
        // the user cannot make, and it would spend the room the ETA wants.
        !cancellable
          ? undefined
          : receivedBytes > 0
            ? "stopping discards it"
            : "stopping starts it over",
      );
      // `null` is not zero: a total nobody has reported yet is "starting", and
      // a bar sitting at 0% would be saying something false.
      if (percent === null) el.removeAttribute("data-progress");
      else el.setAttribute("data-progress", String(percent));
      // The measured rate, in bytes per second, beside the sentence that
      // spells it out. `data-progress` is the percent a test can assert on;
      // this is the same courtesy for the half of the line the host does not
      // send, and the only way a test can tell "no rate yet" from "a rate
      // that formatted to nothing".
      if (rate.bytesPerSecond === null) el.removeAttribute("data-rate");
      else el.setAttribute("data-rate", String(Math.round(rate.bytesPerSecond)));
    };
    paint();
    return updateStore.subscribe(paint);
  }, [el]);
  return <span ref={setEl} data-testid="update-tug-progress" />;
}

/**
 * The download row's bar, painted rather than rendered ([B05], [B07]).
 *
 * Mounts one `TugProgressIndicator variant="bar"` and writes its value onto
 * the root element from the same store subscription the detail line uses:
 * the custom property for the fill, `data-painted` for the determinate /
 * barber-pole switch, and `aria-valuenow` for anyone reading the row rather
 * than looking at it. No `value` prop — the two paths are exclusive.
 *
 * Determinate the moment a total is known, and the barber pole until then,
 * which is the same rule the detail line's `Starting…` follows. Extraction
 * reports a percent with no byte total, so it draws from `percent` directly
 * and the line beside it says what it is doing in words.
 */
export function TransferBar(): ReactElement {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (el === null) return;
    const paint = (): void => {
      const { percent, receivedBytes, expectedBytes } = updateStore.getSnapshot();
      const fraction =
        expectedBytes > 0
          ? Math.min(1, receivedBytes / expectedBytes)
          : percent === null
            ? null
            : percent / 100;
      if (fraction === null) {
        el.style.removeProperty("--tugx-progress-indicator-value");
        el.removeAttribute("data-painted");
        el.removeAttribute("aria-valuenow");
        return;
      }
      el.style.setProperty("--tugx-progress-indicator-value", String(fraction));
      el.setAttribute("data-painted", "");
      el.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    };
    paint();
    return updateStore.subscribe(paint);
  }, [el]);
  return (
    <TugProgressIndicator
      ref={setEl}
      variant="bar"
      state="running"
      size={6}
      aria-label="Download progress"
      data-testid="update-tug-bar"
    />
  );
}

/**
 * The check row's detail line, prefixed with the version the user is running.
 *
 * One sentence pattern across every stage the row has something to say in:
 * *what you have*, then *what that means for you*. The version is the fact the
 * panel could not otherwise give them — the title says which flow they are in,
 * never which Tug is on disk.
 *
 * Outside Tug.app there is no running version to name, so the second half
 * stands alone rather than being introduced by a blank.
 */
function youHave(state: UpdateRenderSnapshot, rest: string): string {
  if (state.currentVersion === "") return rest;
  return `You have Tug v${state.currentVersion}. ${rest}`;
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
      check.detail = youHave(state, "Look for a newer version.");
      check.cta = { label: "Check Now", action: "check" };
      break;
    case "checking":
      check.status = "busy";
      check.detail = "Looking for a newer version…";
      // No bar. Sparkle reports no progress for a check and there is none to
      // report — it is one request — so the only honest claim a bar could make
      // here is "not stopped", which is exactly what the row's dot already says
      // by breathing on `busy`. Watching a real check settled it: a barber pole
      // at the plinth's edge was the loudest thing in the panel, saying the dot's
      // sentence louder and looking like a determinate bar that had not been told
      // its value. The edge strip is for a fraction; where there is no fraction,
      // the dot carries it alone.
      if (state.cancellable) check.cta = { label: "Cancel", action: "cancel" };
      break;
    case "available":
      check.status = "done";
      check.detail =
        state.version === ""
          ? youHave(state, "An update is available.")
          : youHave(state, `Tug v${state.version} is available.`);
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
      download.edge = <TransferBar />;
      // *Stop for Now* rather than *Cancel*, and never *Pause*: the press
      // ends this download and keeps the update in hand, which is neither of
      // the other two words. What it costs is the closing clause of the detail
      // line above it.
      if (state.cancellable) download.cta = { label: "Stop for Now", action: "pause" };
      break;
    case "paused":
      check.status = "done";
      download.status = "paused";
      download.detail =
        // Short enough to say in one line at the panel's width: the row is the
        // same height as its neighbours, and a sentence that wrapped would make
        // it say its line in two while they say theirs in one.
        "Stopped. Nothing was kept — Resume starts over.";
      download.cta = { label: "Resume", action: "resume" };
      break;
    case "extracting":
      check.status = "done";
      download.status = "busy";
      download.detail = "Verifying the signature…";
      // Extraction reports a percent with no byte total, so the same painted
      // bar draws it — determinate, and from `percent` rather than from bytes.
      download.edge = <TransferBar />;
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
      // No bar, for the reason the check row has none: nothing here reports a
      // fraction, and the dot already says the work is running.
      break;
    case "upToDate":
      check.status = "done";
      // Not "Tug is up to date": that is the title, one line above, and a panel
      // that says its one sentence twice reads as a stutter rather than as an
      // answer. The version is the thing this line adds that the title cannot.
      check.detail =
        state.currentVersion === ""
          ? "No newer version has been released."
          : `You have the latest version, Tug v${state.currentVersion}.`;
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
      // A bar still running under a red dot would be claiming the work goes
      // on. It does not: the row is waiting on a press.
      failed.body = undefined;
      failed.edge = undefined;
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
      waiting.body = undefined;
      waiting.edge = undefined;
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
