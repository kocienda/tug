/**
 * SessionLandingProgressRow — the landing arc's live narration, at the
 * transcript's live edge.
 *
 * A join says what it is doing while it does it: reconciling, checking, ready,
 * joining, and then a settled verdict. That sentence is transcript ink — it is
 * about the conversation's work, it arrives in time order, and it ends in a
 * durable receipt the transcript already carries. It used to live in the
 * composer's status row, which put an account of what the machine is doing
 * inside the place the user types, and the composer is not a place to read
 * from.
 *
 * So it renders in `SessionTranscriptHost`'s live-edge slot: after the last
 * row, inside the scroller, un-indexed. Messages still stream in *above* it
 * and it stays pinned beneath them, which is the whole reason the slot is
 * un-indexed rather than a row — it takes no row slot and perturbs no anchor
 * math.
 *
 * **Ink in motion, never ledgered.** Nothing here is written down. The
 * register is derived from live join state and vanishes when that state does;
 * what survives the join is the durable receipt the shell ledger carries, so a
 * replayed transcript renders exactly the receipts and no progress residue
 * ([D111] restore parity holds by construction).
 *
 * **The register outlives the mode on purpose.** The join mode exits the
 * moment the press fires, and the controller keeps a narration standing so the
 * beats and the settled sentence can finish. This row reads that same
 * derivation, so it inherits the lifetime unchanged: it mounts when the
 * register is non-null, pulses through the beats, rests on the verdict, and
 * unmounts when the derivation returns null. A *failed* join's sentence stands
 * until the next join replaces it — which is what makes it findable by
 * somebody who was not watching.
 *
 * Laws: [L02] the register arrives through `useSyncExternalStore` over the
 * controller; [L19]/[L20] this composes {@link DashJoinRegisterView} and adds
 * no rule reaching inside its chrome; [L13] the pulse is the register's own.
 *
 * @tug-pairings DashJoinRegisterView
 *
 * @module components/tugways/cards/session-landing-progress-row
 */

import "./session-landing-progress-row.css";

import React, { useSyncExternalStore } from "react";

import { DashJoinRegisterView } from "../dash-join-register";
import type { JoinModeController } from "@/lib/join-mode-controller";

export interface SessionLandingProgressRowProps {
  /**
   * The card's join mode controller — the one landing that narrates. Commit
   * mode reports a null register today, so a commit is silent here; when it
   * grows one, it mounts in this same row.
   */
  joinModeController: JoinModeController;
}

export function SessionLandingProgressRow({
  joinModeController,
}: SessionLandingProgressRowProps): React.ReactElement | null {
  const register = useSyncExternalStore(
    joinModeController.subscribe,
    () => joinModeController.getSnapshot().register,
  );
  if (register === null) return null;
  return (
    <div className="session-landing-progress-row" data-slot="session-landing-progress-row">
      <DashJoinRegisterView register={register} />
    </div>
  );
}
