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
 * @module lib/arc-join-press
 */

import { getChangesetVerbStore } from "@/lib/changeset-verb-store";
import { getChangesetJoinStore } from "@/lib/changeset-join-store";

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
  /** A resolved candidate commit from the ladder, when one still verifies. */
  candidate?: string | undefined;
}

/** The client-local entry key a session's Changes controller records under. */
export function sessionEntryKey(tugSessionId: string): string {
  return `session:${tugSessionId}`;
}

/**
 * Send the join. Returns false when nothing was sent: no verb store, or a join
 * already in flight on the bound card — a second press would be a second act.
 */
export function pressArcJoin(press: ArcJoinPress): boolean {
  const verbStore = getChangesetVerbStore();
  if (verbStore === null) return false;
  const entryKey = sessionEntryKey(press.boundSession);
  if (verbStore.joinState(entryKey).phase === "pending") return false;
  // The press is the first beat, exactly as the composer's is: it gives the
  // register something true to say while the server decides, and it is the
  // one write that retires the previous run's settled word.
  getChangesetJoinStore()?.beginLand(press.workspaceKey, press.arc);
  verbStore.join(entryKey, press.workspaceKey, press.arc, {
    preview: false,
    message: press.message,
    sessionId: press.boundSession,
    ...(press.candidate !== undefined && press.candidate !== ""
      ? { candidate: press.candidate }
      : {}),
  });
  // On a landing, clear the ladder's candidate as the composer does, so a
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
