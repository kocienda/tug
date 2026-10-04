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
 * **A push narrates here too.** A push is a round trip to a remote that can
 * take seconds, and its receipt only lands when the remote answers. While the
 * card's push is pending this row carries a `pushing <branch>` line on the
 * same `BlockHeader` chrome, pulsing in flight; it unmounts the moment the
 * push settles, when the receipt (or the refusal bulletin) takes over.
 *
 * Laws: [L02] the register and the push state arrive through
 * `useSyncExternalStore` over their stores; [L19]/[L20] this composes
 * {@link ArcJoinRegisterView} and `BlockHeader` and adds no rule reaching
 * inside their chrome; [L13] the pulse is the header's own.
 *
 * @tug-pairings ArcJoinRegisterView
 *
 * @module components/tugways/cards/session-landing-progress-row
 */

import "./session-landing-progress-row.css";

import React from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { ArcJoinRegisterView } from "../arc-join-register";
import { BlockHeader } from "../blocks/block-header";
import type { JoinModeController } from "@/lib/join-mode-controller";
import { useChangesetPush } from "@/lib/changeset-verb-store";
import { useChangesetAll } from "@/lib/changeset-all-store";

export interface SessionLandingProgressRowProps {
  /**
   * The card's join mode controller — the one landing that narrates. Commit
   * mode reports a null register today, so a commit is silent here; when it
   * grows one, it mounts in this same row.
   */
  joinModeController: JoinModeController;
  /** The card's changes entry key — whose push state this row narrates. */
  pushEntryKey: string;
  /** The card's workspace key — where the pushed branch's name is read. */
  pushWorkspaceKey: string;
}

export function SessionLandingProgressRow({
  joinModeController,
  pushEntryKey,
  pushWorkspaceKey,
}: SessionLandingProgressRowProps): React.ReactElement | null {
  const register = useSyncExternalStore(
    joinModeController.subscribe,
    () => joinModeController.getSnapshot().register,
  );
  const push = useChangesetPush(pushEntryKey);
  const aggregate = useChangesetAll();
  const pushing = push.phase === "pending";
  if (register === null && !pushing) return null;
  const branch = aggregate.projects.find(
    (p) => p.workspace_key === pushWorkspaceKey,
  )?.branch;
  return (
    <div className="session-landing-progress-row" data-slot="session-landing-progress-row">
      {register !== null ? <ArcJoinRegisterView register={register} /> : null}
      {pushing ? (
        <div className="session-push-register" data-slot="session-push-register">
          <BlockHeader
            phase="in_flight"
            target={branch !== undefined ? `Pushing ${branch}` : "Pushing"}
            summary={{ kind: "text", text: "pushing" }}
          />
        </div>
      ) : null}
    </div>
  );
}
