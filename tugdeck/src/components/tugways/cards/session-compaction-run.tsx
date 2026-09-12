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
 * the modal hold the RUN puts on the card for its own length ([L31] — every
 * refused door speaks with the run's own voice; [B01] — the hold is the run's
 * rather than the panel's, so a folded run is held too), and a watcher that
 * settles the run off store snapshots with no timers ([P07]).
 *
 * Laws: [L02] store state reaches React through `useSyncExternalStore` (here,
 *       through the same stores' `subscribe`); [L07] live reads at call time.
 *
 * @module components/tugways/cards/session-compaction-run
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import type {
  CodeSessionSnapshot,
  CodeSessionStore,
} from "@/lib/code-session-store";
import {
  compactionProgressStore,
  isCompactingCard,
} from "@/lib/compaction-progress-store";
import { useIsCardFolded } from "@/lib/card-fold";
import { afterFoldCrossing } from "@/lib/fold-crossing";
import { isTugMotionEnabled } from "@/components/tugways/scale-timing";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";

import type { TugPaneBulletinApi } from "../tug-pane-bulletin";
import { MODAL_REST_LINE } from "./modal-rest-line";
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
  /**
   * Stand the current sheet on that same host down. The cover is raised and
   * lowered by the derivation below rather than once at dispatch ([B03]), so
   * the hook needs both of the host's doors, not just the opening one. It
   * carries `SHEET_SETTLED_DISMISS` itself, which is the one token the cover
   * accepts.
   */
  closeSheet: (result?: string) => void;
  /**
   * The card's root element, for finding the pane frame the fold crossing is
   * announced on. A ref rather than an element because the hook runs before
   * the card has mounted anything, and the frame is only ever read at the
   * moment a crossing is being waited on.
   */
  cardRootRef: { readonly current: HTMLElement | null };
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
  const {
    cardId,
    codeSessionStore,
    showSheet,
    closeSheet,
    cardRootRef,
    bulletinRef,
  } = host;

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
    // The run's cancel goes on the store with the run, because the sheet is
    // not the only surface that offers it: a folded card shows the run in its
    // Z2 row and offers Cancel there, and both presses must be the same
    // press — this closure, with its `canceled` latch and its correction
    // bulletin — rather than two hand-rolled interrupts.
    //
    // The card is HELD for the length of the run, and the hold goes on with
    // the run rather than with the cover ([B01]). Without it a `/usage` would
    // not open over the cover — it would replace it, and dismissing the usage
    // sheet would leave the card looking like the compaction had been
    // dismissed too, while it compacted on. Escape, ⌘., ⌘W, and the title
    // bar's controls are refused on the same terms, and every one of those
    // refusals speaks in the run's own voice ([L31]).
    //
    // Holding here rather than in the cover is what makes the FOLD sayable.
    // The cover is one face of the run and the Z2 row is the other; a hold
    // that belonged to the cover would lapse the moment the card folded, and
    // the fold could then only be admitted by a hole in the guard. Held by the
    // run, the fold is simply the one door this holder names ([B02]), and
    // every other door stays shut on both faces.
    compactionProgressStore.begin(cardId, onCancel, {
      reason: COMPACTION_REFUSAL_TEXT,
      // Through the store, because the run has two faces and the hold does not
      // know which is up ([B08]): the cover flashes its line beneath the bar,
      // the folded Z2 row swaps its title, and each registers itself while it
      // is mounted. One refusal, spoken wherever the user is looking.
      refuse: () => {
        compactionProgressStore.refuse(cardId);
      },
      admitsFold: true,
    });
    // NOTHING is raised here. The cover's presence is derived from the run and
    // the fold below ([B03]), so a run begun on a folded card raises no panel
    // ([B04]) and gets one the first time the card is open — which is the same
    // rule stated once instead of a raise here and a re-raise somewhere else.
  }, [cardId, codeSessionStore, bulletinRef]);

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

  // ── The cover is DERIVED from run × fold ([B03]) ───────────────────────────
  //
  // It used to be raised once, inside the dispatch, which made the panel a
  // thing that happened at a moment rather than a thing that is true while two
  // other things are. Two consequences followed from that and both are gone
  // here: a run begun on a folded card never got a cover at all, even after the
  // user opened the card, because the one raise had already been declined; and
  // there was no honest place for the fold to put the cover down, since the
  // only stand-down available was one that ends the run's panel for good.
  //
  // Stated as a derivation there are exactly three cases and no special ones.
  // Run in flight and card open: the cover is up. Card folded: it is not — the
  // folded card is its masthead and its Z2 row, and the row already carries the
  // run ([B04]). No run: nothing, and the cover the settling run leaves behind
  // is dismissed by the sheet's own watch on the store clearing.
  const running = useSyncExternalStore(
    compactionProgressStore.subscribe,
    useCallback(
      () => isCompactingCard(compactionProgressStore.getSnapshot(), cardId),
      [cardId],
    ),
  );
  const folded = useIsCardFolded(cardId);

  // Whether THIS hook has a cover up, so the derivation neither raises a second
  // one nor stands down a sheet it does not own. Set before the raise and
  // cleared by the raise's own promise, which resolves on every close path
  // there is — the fold's stand-down, the store clearing, a host unmount, and
  // the refusal `showSheet` answers with when it declines to raise at all.
  const coverUpRef = useRef(false);
  const raiseCover = useCallback((): void => {
    if (coverUpRef.current) return;
    coverUpRef.current = true;
    void showSheet({
      title: "Compacting",
      icon: "Archive",
      // The cover rests on the card's modal rest line and rises from it
      // ([B06]), which it did not before: the compaction was one of the two
      // exemptions the rest line carried, on the reasoning that a rise from Z2
      // reveals nothing because there is no transcript behind the cover. That
      // reasoning is retired by this arc rather than bent. The cover is no
      // longer a panel over a card with nothing behind it — it is one FACE of a
      // run whose other face is the Z2 row, so the line it rises from and
      // settles into is the line the other face stands on. What the motion
      // reveals is the handoff.
      bottomAnchorSelector: MODAL_REST_LINE,
      // Rises as the `rise` presentation does and LOWERS on dismiss, on the
      // imposer's own settle clock rather than the sheet's ([B05]). Both halves
      // matter and they are different events: the cover rises when the card is
      // open and the run is in flight, and it settles when the card folds —
      // and a fold is an imposer crossing, so a panel standing down on the
      // sheet's own duration would land at a different moment than the card's
      // edge and the row it is handing the run to.
      presentation: "settle",
      // The one surface small enough to BE the Z2 row ([B04]): on a folded card
      // no panel rises and the fold stands, and the row itself reads
      // "Compacting…" with its mark and its Cancel, drawn off
      // `compactionProgressStore` by the status row. The declaration is still
      // worth making even though the derivation below never calls this on a
      // folded card: it is what a raise racing a fold resolves to.
      //
      // A folded run gives up nothing but the panel: the hold is the run's
      // ([B01]), so a `/usage` during a folded compaction is refused there too
      // rather than unfolding the card and rising over it. The row says what
      // the card is doing, which is what the fold rule owes the reader.
      foldPresentation: "inhabit",
      // The cover keeps `exclusive` for its own keyboard exits — Escape, ⌘.,
      // and a stray `CANCEL_DIALOG` all get the run's answer rather than
      // closing the panel — but it takes no hold of its own. The run holds the
      // card, and one holder is what keeps "the one door" from being a property
      // of two objects that have to agree.
      exclusive: {
        reason: COMPACTION_REFUSAL_TEXT,
        onRefused: () => {
          compactionProgressStore.refuse(cardId);
        },
      },
      // Cancel is taken from the STORE rather than from a closure this raise
      // holds, because the cover is raised many times over one run and every
      // one of those presses must be the single closure the run filed — the one
      // with the `canceled` latch and the correction bulletin ([F05]). It is
      // the same press the folded row's Cancel performs.
      content: (close) => (
        <CompactionProgressSheet
          cardId={cardId}
          close={close}
          onCancel={() => {
            compactionProgressStore.requestCancel(cardId);
          }}
        />
      ),
    }).then(() => {
      coverUpRef.current = false;
    });
  }, [cardId, showSheet]);

  // The fold the derivation is reacting to, read one run behind, so an unfold
  // can be told from a card that was open all along. Only the unfold has a
  // crossing to wait for.
  const wasFoldedRef = useRef(folded);
  useEffect(() => {
    const wasFolded = wasFoldedRef.current;
    wasFoldedRef.current = folded;

    if (!running) return;
    if (folded) {
      // The fold walked past the hold, so the cover comes down here rather than
      // in the fold handler — the derivation is what knows there is a cover and
      // what will put it back. `closeSheet` carries `SHEET_SETTLED_DISMISS`,
      // which is the one token an exclusive sheet accepts; every other
      // dismissal still meets the refusal.
      if (coverUpRef.current) closeSheet();
      return;
    }
    // Card open. A card that was open already — the ordinary `/compact` — has
    // nothing to wait for, and neither does a reader with motion off, where the
    // layout snap IS the settle and the imposer arms no tween to end. The
    // predicate is the imposer's own for the reason the card's own fold effect
    // uses it: the two must agree about which folds are carried, and one
    // opinion drifting from the other is a cover that never arrives.
    if (!wasFolded || !isTugMotionEnabled()) {
      raiseCover();
      return;
    }
    // An UNFOLD. The panel waits for the crossing to end rather than for one
    // task ([B06]): `showSheet`'s existing one-task defer was sized for a fold
    // that had already committed, and a cover mounted anywhere inside the
    // crossing reads its anchor off a slot with no box and parks at the `rise`
    // resting offset for the rest of its life ([F08]). The crossing is minutes
    // of tween longer than a task, so the wait has to be the event.
    const frame =
      cardRootRef.current?.closest<HTMLElement>(".tug-pane") ?? null;
    if (frame === null) {
      raiseCover();
      return;
    }
    // The wait itself is `fold-crossing`'s, because the Z2 row's occupant
    // does the same wait on its way OUT and the two are one handoff: a copy
    // here that drifted from that one is a cover that never arrives beside a
    // row that never leaves. It answers the settle that carried no crossing
    // for this frame too, which is the case the event alone cannot.
    return afterFoldCrossing(frame, raiseCover);
  }, [running, folded, raiseCover, closeSheet, cardRootRef]);

  return beginCompactionRun;
}
