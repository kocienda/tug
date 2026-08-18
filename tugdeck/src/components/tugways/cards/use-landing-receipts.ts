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

export function useLandingReceipts(
  codeSessionStore: CodeSessionStore,
  changesController: ChangesRouteController,
): void {
  useEffect(() => {
    const verbStore = getChangesetVerbStore();
    if (verbStore === null) return;
    const commitKey = changesController.entryKey;
    let prevCommit: CommitPhase = verbStore.commitState(commitKey).phase;
    let prevJoin: JoinPhase = verbStore.joinState(commitKey).phase;
    let prevDiscard: DiscardPhase = verbStore.discardState(commitKey).phase;

    /** Append one landing's summary as a shell-exchange row ([D111]). */
    const append = (command: string, output: string): void => {
      const now = Date.now();
      codeSessionStore.ingestShellExchange({
        phase: "complete",
        exchangeId: `landing-${now}-${Math.random().toString(36).slice(2, 8)}`,
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
        append("/commit", commit.summary);
      }
      prevCommit = commit.phase;

      // Join: the same edge, on the dash lane's landing. A preview settles in
      // `preview` and never here, so only a real land leaves ink.
      const joined = verbStore.joinState(commitKey);
      if (joined.phase === "done" && prevJoin !== "done" && joined.summary !== null) {
        append("/dash-join", joined.summary);
      }
      prevJoin = joined.phase;

      // Discard: a discard is a landing too — it is the other way a dash stops
      // existing, and the receipt is the only record of what it took.
      const discarded = verbStore.discardState(commitKey);
      if (discarded.phase === "done" && prevDiscard !== "done" && discarded.summary !== null) {
        append("/dash-discard", discarded.summary);
      }
      prevDiscard = discarded.phase;
    };

    return verbStore.subscribe(onChange);
  }, [codeSessionStore, changesController]);
}
