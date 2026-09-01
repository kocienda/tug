/**
 * use-landing-receipts — the commit landing as transcript ink ([P07]).
 *
 * One subscription over the app-level changeset verb store per Session card:
 * when a `changeset_commit` round-trip for this card's entry resolves, append
 * the server-formatted summary (S02) as a `/commit` row through the
 * shell-exchange ink mechanism ([D111] — the row records what the user did,
 * never what Claude knows; it is not session context). The server has already
 * persisted the same row to the shell ledger, so this live append is the
 * initiating client's copy; other decks pick it up on their next restore, and
 * the row survives reload + cold boot from the ledger.
 *
 * The summary string is the single source ([P07]): this hook ingests it
 * verbatim, and the receipt blocks parse the identical string live and on
 * restore, so the two rows are byte-identical.
 *
 * Join and discard ride the same mechanism ([P06]). Each has one terminal edge
 * to hang a row off — join's `done`, discard's `done` — and each appends only
 * when the server actually sent a summary, so a landing this card merely
 * watched leaves no ink here.
 *
 * A dash arc's ending rides it too ([P12]), and is the one row here nobody
 * asked for: the other three settle a round-trip this card started, while an
 * arc finishes on a server tick with the user reading something else. So its
 * edge is not a phase but the ledger row's identity appearing, and it is
 * seeded at mount — a card that opens *after* an arc ended already replayed
 * that row from the ledger, and must not paint a second copy of it.
 *
 * Laws: [L22] store→store wiring observes the verb store's own subscription
 * directly (no useSyncExternalStore → useEffect round-trip).
 *
 * @module components/tugways/cards/use-landing-receipts
 */

import { useEffect } from "react";

import {
  getChangesetVerbStore,
  type CommitPhase,
  type JoinPhase,
  type DiscardPhase,
} from "@/lib/changeset-verb-store";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";

/**
 * The exchange id a landing's live row is painted under — the whole of the
 * one-landing-one-turn decision, in one place so it can be proven.
 *
 * With a `receiptId` it is the shell ledger's own row identity, spelled the
 * way `applyRestoredShellExchanges` spells it. `buildShellTurnEntry` derives a
 * turn's `turnKey` from the exchange id, so the live copy of a landing and the
 * copy a later restore replays are the same turn: `upsertInkTurn` settles it
 * in place instead of seating a second receipt for one landing. Restored rows
 * keep the identity they have always had — the live append moved onto theirs,
 * so nothing already in a transcript re-keys ([L26]).
 *
 * Without one — no session id, no ledger, a ledger error, an older tugcast —
 * the server persisted nothing, so there is no ledger row for the id to name
 * and no restore that could ever collide. The row falls back to a local
 * identity, unique per call so two such landings stay two rows.
 */
export function landingExchangeId(receiptId: number | null): string {
  if (receiptId !== null) return `restored-${receiptId}`;
  return `landing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useLandingReceipts(
  codeSessionStore: CodeSessionStore,
  changesController: ChangesRouteController,
): void {
  useEffect(() => {
    const verbStore = getChangesetVerbStore();
    if (verbStore === null) return;
    const commitKey = changesController.entryKey;
    // Read once, from inside the effect: a store's tug session id is fixed for
    // its whole life, so this is identity rather than state and needs no
    // subscription of its own ([L02] governs what React *renders* from).
    const tugSessionId = codeSessionStore.getSnapshot().tugSessionId;
    let prevCommit: CommitPhase = verbStore.commitState(commitKey).phase;
    let prevJoin: JoinPhase = verbStore.joinState(commitKey).phase;
    let prevDiscard: DiscardPhase = verbStore.discardState(commitKey).phase;
    // The arc receipt has no phase to watch — it either exists for this
    // session or it does not — so the edge is the row identity changing.
    // Seeded with whatever is already there so a card mounting after an arc
    // ended does not re-append a row its restore has already replayed.
    let prevArcReceipt: number | null =
      verbStore.arcReceipt(tugSessionId)?.receiptId ?? null;
    // The run's quiet lines ride the same mechanism and are unsolicited on the
    // same terms, but arrive as a sequence rather than a single value. Seeded
    // with whatever the store already holds so a card mounting mid-run appends
    // only what arrives from here — the earlier rows are its restore's.
    const seeded = verbStore.dashNotes(tugSessionId);
    let prevNoteSeq: number = seeded.length === 0 ? 0 : seeded[seeded.length - 1].seq;

    /**
     * Append one landing's summary as a shell-exchange row ([D111]), under the
     * identity {@link landingExchangeId} derives — which is what keeps one
     * landing to one transcript turn across the live and restore paths.
     */
    const append = (command: string, output: string, receiptId: number | null): void => {
      const now = Date.now();
      codeSessionStore.ingestShellExchange({
        phase: "complete",
        exchangeId: landingExchangeId(receiptId),
        command,
        output,
        exitCode: 0,
        cwd: changesController.projectDir,
        cwdAfter: null,
        startedAtMs: now,
        settledAtMs: now,
      });
    };

    const onChange = (): void => {
      // Commit: pending → done appends the server summary once. No fiction —
      // if the server sent no summary, nothing is appended.
      const commit = verbStore.commitState(commitKey);
      if (commit.phase === "done" && prevCommit !== "done" && commit.summary !== null) {
        append("/commit", commit.summary, commit.receiptId);
      }
      prevCommit = commit.phase;

      // Join: the same edge, on the dash lane's landing. A preview settles in
      // `preview` and never here, so only a real land leaves ink.
      const joined = verbStore.joinState(commitKey);
      if (joined.phase === "done" && prevJoin !== "done" && joined.summary !== null) {
        append("/dash-join", joined.summary, joined.receiptId);
      }
      prevJoin = joined.phase;

      // Discard: a discard is a landing too — it is the other way a dash stops
      // existing, and the receipt is the only record of what it took.
      const discarded = verbStore.discardState(commitKey);
      if (discarded.phase === "done" && prevDiscard !== "done" && discarded.summary !== null) {
        append("/dash-discard", discarded.summary, discarded.receiptId);
      }
      prevDiscard = discarded.phase;

      // The arc's ending ([P12]): one receipt row, and no `/dash-join` chip —
      // the join offer is the shade's to raise ([D147], [D152]).
      const arc = verbStore.arcReceipt(tugSessionId);
      if (arc !== null && arc.receiptId !== prevArcReceipt) {
        append("/dash-arc", arc.summary, arc.receiptId);
      }
      prevArcReceipt = arc?.receiptId ?? prevArcReceipt;

      // Every manipulation of a dash's step list, announced by the verb that
      // made it (W8). The user watches a run from the card, and before these
      // the only sign of progression was a stuck indicator.
      for (const dashNote of verbStore.dashNotes(tugSessionId)) {
        if (dashNote.seq <= prevNoteSeq) continue;
        append(dashNote.command, dashNote.note, dashNote.receiptId);
        prevNoteSeq = dashNote.seq;
      }
    };

    return verbStore.subscribe(onChange);
  }, [codeSessionStore, changesController]);
}
