/**
 * session-compaction-run.tsx — the `/compact` run on a session card, whoever
 * sent the command.
 *
 * A `/compact` reaches a session two ways. The user types it, and the card's
 * local command handler dispatches the submission itself. Or the **wheel**
 * sends it — an arc compacting a seated stage between its own prompts — and it
 * arrives as a `tug_notice` tugcast has already put on the wire, opening its
 * turn inside `codeSessionStore` without passing the composer or the command
 * handler at all.
 *
 * The run is the same run either way: the same opaque minutes with nothing
 * streaming, the same two honest ways out (it finishes, or the user cancels
 * it), and therefore the same claim on the card. So the run lives here, once,
 * and each sender brings its own submission or none:
 *
 *  - {@link useCompactionRun} returns `beginCompactionRun` for the typed path,
 *    which calls it and then sends the `/compact` substrate.
 *  - The same hook watches for a wheel-sent `/compact` and opens the run off
 *    the turn itself. Until it did, an arc compacting mid-stage left the card
 *    looking like an ordinary busy turn — no sheet, no hold, every door open,
 *    and nothing on screen saying what the minutes ahead belonged to.
 *
 * What "the run" is made of: the pane-modal {@link CompactionProgressSheet},
 * the exclusive hold that sheet puts on the card ([L31] — every refused door
 * speaks with the run's own voice), and a watcher that settles the run off
 * store snapshots with no timers ([P07]).
 *
 * Laws: [L02] store state reaches React through `useSyncExternalStore` (here,
 *       through the same stores' `subscribe`); [L07] live reads at call time.
 *
 * @module components/tugways/cards/session-compaction-run
 */

import React, { useCallback, useEffect } from "react";

import type {
  CodeSessionSnapshot,
  CodeSessionStore,
} from "@/lib/code-session-store";
import { compactionProgressStore } from "@/lib/compaction-progress-store";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";

import type { TugPaneBulletinApi } from "../tug-pane-bulletin";
import {
  COMPACTION_REFUSAL_TEXT,
  CompactionProgressSheet,
} from "./compaction-progress-sheet";

/** The in-flight turn, as the snapshot carries it. */
type ActiveTurn = NonNullable<CodeSessionSnapshot["activeTurn"]>;

/**
 * True when the in-flight turn carries a compaction divider — a `system_note`
 * whose `source` is `"compact"`. The run watcher uses it as the belt-and-
 * suspenders "compaction landed" signal for a summary-less (fail-closed)
 * compaction, alongside the primary `compactionSeed` reference check.
 */
function activeTurnHasCompactNote(activeTurn: ActiveTurn): boolean {
  return activeTurn.messages.some(
    (m) => m.kind === "system_note" && m.source === "compact",
  );
}

/**
 * True when the in-flight turn is a `/compact` the **wheel** sent, rather than
 * one the user typed.
 *
 * Read off the leading command atom rather than the text: the notice handler
 * mints that atom from the prompt tugcast handed it, so the atom is what the
 * wheel's transcript row already stands on, and this predicate stands on the
 * same thing instead of re-parsing a slash command.
 */
function activeTurnIsWheelCompact(activeTurn: ActiveTurn): boolean {
  if (activeTurn.origin !== "wheel") return false;
  const first = activeTurn.messages.find((m) => m.kind === "user_message");
  if (first === undefined || first.kind !== "user_message") return false;
  const leading = first.attachments[0];
  return (
    leading !== undefined &&
    leading.type === "command" &&
    leading.value === "compact"
  );
}

export interface CompactionRunHost {
  /** The card the run covers. The store holds one run per card. */
  cardId: string;
  /** This card's session store — the run is watched and settled off it. */
  codeSessionStore: CodeSessionStore;
  /**
   * The card's sheet host, which must be the one every sheet on this card
   * shares: the run's sheet is opened `exclusive`, and exclusivity is only
   * meaningful against the host a second sheet would otherwise replace.
   */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
  /** The card's pane bulletin, read live at the moment there is something to say. */
  bulletinRef: { readonly current: TugPaneBulletinApi | null };
}

/**
 * Wire this card's `/compact` run, and return the function that opens one.
 *
 * The returned `beginCompactionRun` does NOT dispatch anything — the typed
 * path sends its own submission after calling it, and the wheel's was already
 * sent by tugcast. A run already open is left alone, which is what keeps the
 * typed path (which begins the run before its turn exists) from opening a
 * second one when the watcher below sees that turn arrive.
 */
export function useCompactionRun(host: CompactionRunHost): () => void {
  const { cardId, codeSessionStore, showSheet, bulletinRef } = host;

  const beginCompactionRun = useCallback((): void => {
    if (compactionProgressStore.getFor(cardId) !== null) return;
    const snap0 = codeSessionStore.getSnapshot();
    const openTurn = snap0.activeTurn;

    // Baseline for detecting compaction ink: a `compact_summary` mints a new
    // `compactionSeed` object, so a reference change since dispatch proves a
    // compaction landed. A boundary note on the in-flight turn is the belt-
    // and-suspenders signal for a summary-less (fail-closed) compaction.
    const seedAtDispatch = snap0.compactionSeed;
    // Seeded from the live snapshot rather than `false`, because the run does
    // not always start before its turn: the wheel's `/compact` is dispatched by
    // tugcast and observed here after the turn has opened. A compaction turn
    // streams nothing, so the store may not notify again until that turn ends
    // — and a watcher that had not seen it open would read the settle as "not
    // mine yet" and leave the sheet standing forever.
    let sawActive = openTurn !== null;
    let sawInk = openTurn !== null && activeTurnHasCompactNote(openTurn);
    let interrupted = false;
    let canceled = false;

    const onCancel = (): void => {
      if (canceled) return;
      canceled = true;
      // Interrupt the compaction turn — Claude Code's own supported abort
      // path ([Q01]); the session stays intact. The watcher unsubscribes at
      // the active → null transition; the store is already settled here.
      codeSessionStore.interrupt();
      compactionProgressStore.cancel(cardId);
    };

    const unsubscribe = codeSessionStore.subscribe(() => {
      const snap = codeSessionStore.getSnapshot();
      const active = snap.activeTurn;
      // Compaction ink: the summary re-marked `compactionSeed`, or a compact
      // divider attached to the in-flight turn.
      if (snap.compactionSeed !== seedAtDispatch) sawInk = true;
      if (active !== null && activeTurnHasCompactNote(active)) sawInk = true;
      if (active !== null) {
        // Latched during the interrupt round-trip (the turn is still
        // in-flight); acted on at the active → null transition below.
        if (snap.interruptInFlight) interrupted = true;
        sawActive = true;
        return;
      }
      if (!sawActive) return; // turn hasn't opened yet
      unsubscribe();
      if (canceled) {
        // The Cancel button settles the store (and dismisses the sheet) at
        // the gesture, but Claude Code does not reliably abort a compaction
        // mid-run — it can finish anyway, and the interrupt no longer pulls
        // the turn down locally to hide that. The "canceled" bulletin has
        // already fired by now, so correct the record when the ink lands.
        if (sawInk) {
          bulletinRef.current?.caution(
            "Compaction finished before it could be canceled",
          );
        }
        return;
      }
      if (sawInk) {
        compactionProgressStore.succeed(cardId);
        return;
      }
      if (interrupted) {
        // Interrupted by Escape / Stop (not the Cancel button): settle
        // canceled, session intact.
        compactionProgressStore.cancel(cardId);
        return;
      }
      // Turn settled with no compaction — refused (too-short session) or
      // errored. Surface the reason; the refusal text is already in the turn.
      compactionProgressStore.fail(
        cardId,
        snap.lastError?.message ?? "Compaction didn't run — session left intact",
      );
    });

    // Open the run and present the modal sheet.
    //
    // The sheet's LIFETIME is not the run's lifetime. Cancel is the Cancel
    // button and nothing else: `showSheet`'s promise resolves on every close
    // path, including ones the user never performed — Escape / Cmd-., and the
    // host's documented unmount-while-open (a cross-pane card move, a card
    // remount on window restore). Inferring Cancel from that resolution
    // canceled compactions nobody canceled, and the cancel is not benign: a
    // compaction turn streams nothing, so `interrupt()` always takes the CASE A
    // pull-down, which drops the in-flight turn's scratch — the `/compact` row
    // vanishes from the transcript while Claude Code compacts on to completion
    // and writes the boundary to the JSONL. The compaction is then real on disk
    // and absent from the card until a reload replays it.
    //
    // So the run outlives the sheet. The watcher above is subscribed to the
    // store, not to the sheet, and settles the run wherever it ends: the
    // divider and summary land in place, and the closing bulletin fires,
    // whether or not the sheet is still up. A dismissed sheet leaves the card
    // showing an ordinary in-flight turn, which Stop / Escape can interrupt if
    // that is what the user actually wants.
    compactionProgressStore.begin(cardId);
    // The sheet is EXCLUSIVE, so the card is held for the length of the run:
    // this host is the one every sheet on the card shares, and without the
    // hold a `/usage` would not open over this sheet — it would replace it,
    // and dismissing the usage sheet would leave the card looking like the
    // compaction had been dismissed too, while it compacted on. Escape, ⌘.,
    // ⌘W, and the title bar's controls are refused on the same terms. Every
    // one of those refusals flashes the sheet's own line, because the run is
    // what is refusing and the sheet is where the user is looking ([L31]).
    const nudgeRef: React.MutableRefObject<(() => void) | null> = {
      current: null,
    };
    void showSheet({
      title: "Compacting",
      icon: "Archive",
      exclusive: {
        reason: COMPACTION_REFUSAL_TEXT,
        onRefused: () => nudgeRef.current?.(),
      },
      content: (close) => (
        <CompactionProgressSheet
          cardId={cardId}
          close={close}
          onCancel={onCancel}
          nudgeRef={nudgeRef}
        />
      ),
    });
  }, [cardId, codeSessionStore, showSheet, bulletinRef]);

  // The wheel's `/compact` never passes the command handler, so the turn is
  // what is watched — one place to look, and the predicate reads the same
  // command atom the wheel's own transcript row does.
  useEffect(() => {
    const check = (): void => {
      const active = codeSessionStore.getSnapshot().activeTurn;
      if (active === null || !activeTurnIsWheelCompact(active)) return;
      beginCompactionRun();
    };
    check();
    return codeSessionStore.subscribe(check);
  }, [codeSessionStore, beginCompactionRun]);

  return beginCompactionRun;
}
