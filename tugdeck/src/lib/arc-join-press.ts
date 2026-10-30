/**
 * arc-join-press.ts — the Join verb on an arc row, sent down the composer's
 * own path.
 *
 * A row's Join is the same `changeset_join` the composer's `/arc-join` sends,
 * through the same {@link ChangesetVerbStore.join} — never a second path
 * ([B05]). A row has no composer, so the press acts for the arc's **bound
 * session**: the round trip is recorded under that card's entry key, which is
 * the slot its join face and its composer already read, so a refusal or a
 * landing shows exactly where it would have had the join been typed there.
 * The message is the arc's own maintained draft, as the join face would land.
 *
 * Whether Join is offered at all — unbound, its card closed, no message — is
 * {@link arcVerbs}'s to say, through the composer's own join gate, and a
 * refused press never reaches here. What the server alone can judge comes
 * back on the bound card's join state, as it does for a typed join.
 *
 * **A press this module refuses speaks** ([L31]): no verb store, or a join
 * already in flight on the bound card, is posted on the `voice` card's pane
 * bulletin through {@link arcPressStore} — the voice the row's transport
 * refusals already use — with the composer's own sentence where it has one.
 * And a press that went out is bounded: the verb store ends an unanswered
 * join at the press horizon, so the subscription below always releases.
 *
 * @module lib/arc-join-press
 */

import { arcPressStore } from "@/lib/arc-press-store";
import { getChangesetVerbStore } from "@/lib/changeset-verb-store";
import { getChangesetJoinStore } from "@/lib/changeset-join-store";
import { CHANGES_SERVICE_DISCONNECTED } from "@/lib/landing-mode";

/** The sentence a second press speaks while the first is still out. */
export const JOIN_ALREADY_IN_FLIGHT = "A join is already in flight for this arc";

/** What one row's Join press sends. */
export interface ArcJoinPress {
  /** The workspace key the arc's project is addressed by ([L29]). */
  workspaceKey: string;
  /** The arc's display name. */
  arc: string;
  /** The live session holding the arc — the card the join acts for. */
  boundSession: string;
  /** The arc's maintained draft message. */
  message: string;
  /**
   * The card a refusal speaks on — the followed card on the Arcs surface.
   * Defaults to the bound session, which is the card the join acts for.
   */
  voice?: string | null;
}

/** The client-local entry key a session's Changes controller records under. */
export function sessionEntryKey(tugSessionId: string): string {
  return `session:${tugSessionId}`;
}

/**
 * Send the join. Returns false when nothing was sent — no verb store, or a
 * join already in flight on the bound card, where a second press would be a
 * second act — and the refusal has been spoken on the press's voice.
 */
export function pressArcJoin(press: ArcJoinPress): boolean {
  const voice = press.voice === undefined ? press.boundSession : press.voice;
  const verbStore = getChangesetVerbStore();
  if (verbStore === null) {
    arcPressStore.refuse(voice, press.arc, "join", CHANGES_SERVICE_DISCONNECTED);
    return false;
  }
  const entryKey = sessionEntryKey(press.boundSession);
  if (verbStore.joinState(entryKey).phase === "pending") {
    arcPressStore.refuse(voice, press.arc, "join", JOIN_ALREADY_IN_FLIGHT);
    return false;
  }
  // The press is the first beat, exactly as the composer's is: it gives the
  // register something true to say while the server decides, and it is the
  // one write that retires the previous run's settled word.
  getChangesetJoinStore()?.beginLand(press.workspaceKey, press.arc);
  verbStore.join(entryKey, press.workspaceKey, press.arc, {
    preview: false,
    message: press.message,
    sessionId: press.boundSession,
  });
  // On a landing, clear the arc's overlay cell as the composer does, so a
  // reused arc name never inherits a stale one.
  const unsubscribe = verbStore.subscribe(() => {
    const phase = verbStore.joinState(entryKey).phase;
    if (phase === "pending") return;
    unsubscribe();
    if (phase === "done") {
      getChangesetJoinStore()?.clear(press.workspaceKey, press.arc);
    }
  });
  return true;
}
