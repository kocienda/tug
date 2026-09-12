/**
 * compaction-progress-sheet.tsx — the pane-modal progress surface for
 * `/compact`.
 *
 * Native `/compact` compacts the conversation in place (same session, same
 * JSONL). It is an opaque run lasting minutes on a full context (measured:
 * 111 s and 159 s at 140k / 170k tokens) — nothing streams between dispatch and
 * the `compact_boundary`, so there is no honest determinate signal. This sheet
 * covers the card for the duration with an **indeterminate** "Compacting…"
 * indicator plus a Cancel button that interrupts the run (the turn interrupt,
 * the same path Stop / Escape take).
 *
 * The store drives the sheet, and Cancel is the **only** thing that cancels.
 * The store transitions (begin → succeed/cancel/fail → clear) decide what shows
 * and when it dismisses: the card raises the closing bulletin off the terminal
 * `outcome`, then `clear`s the store; this component watches for that and
 * dismisses the host sheet.
 *
 * The sheet is opened **exclusive**, and the RUN holds the card for its own
 * length ([B01]): another `showSheet` on this card is refused rather than
 * superseding it, Escape and Cmd-. do not dismiss, and the pane's title-bar
 * controls read disabled. Every one of those refusals reaches whichever of the
 * run's faces is mounted, through the flash each registers on
 * `compactionProgressStore` ([B08]); this one flashes the line beneath the mark
 * — one voice for the whole card, standing where the user is already looking
 * rather than on a surface behind the scrim.
 *
 * This surface is NOT the run, and its life is shorter: the cover's presence is
 * derived from the run and the card's fold ([B03]), so folding a compacting
 * card stands it down and opening the card again raises a fresh one, any number
 * of times over a single `/compact`. What it is, each time, is the run's open
 * face; the folded face is the Z2 row, which carries the same text and the same
 * Cancel. So nothing here may hold per-run state — the store does.
 *
 * What still dismisses this surface is the fold, the store clearing, and the
 * host unmounting (a cross-pane card move, a card remount on window restore).
 * The run outlives all three — the card's watcher is subscribed to the store,
 * not to this sheet — and nothing may read "the sheet went away" as "the user
 * canceled" (see the `compact` handler in `session-card.tsx` for what that
 * cost).
 *
 * Laws: [L02] store state via `useSyncExternalStore`; [L06] appearance via
 *       CSS / the TugProgressIndicator's own DOM attributes; [L20] composed
 *       children (indicator, button) keep their own tokens.
 *
 * @module components/tugways/cards/compaction-progress-sheet
 */

import React, { useEffect, useSyncExternalStore } from "react";

import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { compactionProgressStore } from "@/lib/compaction-progress-store";

import "./compaction-progress-sheet.css";

/** What every refused door on a compacting card says. */
export const COMPACTION_REFUSAL_TEXT = "Compacting — press Cancel to stop";

export interface CompactionProgressSheetProps {
  /**
   * The card whose run this sheet shows. The store holds one run per card —
   * several cards can be compacting at once — so the sheet reads its own key
   * and is untouched by another card's run settling.
   */
  cardId: string;
  /** Dismiss the host sheet (from `useTugSheet`'s content callback). */
  close: () => void;
  /**
   * User asked to stop — interrupt the compaction. Cancel maps to the turn
   * interrupt; [Q01] verifies Claude Code aborts it cleanly (session intact).
   */
  onCancel: () => void;
}

export function CompactionProgressSheet({
  cardId,
  close,
  onCancel,
}: CompactionProgressSheetProps): React.ReactElement | null {
  const getProgress = React.useCallback(
    () => compactionProgressStore.getFor(cardId),
    [cardId],
  );
  const progress = useSyncExternalStore(
    compactionProgressStore.subscribe,
    getProgress,
  );

  // The run owns the sheet's lifetime: once the store clears (the card has
  // raised the closing bulletin and reset), dismiss the host sheet. [L02]
  useEffect(() => {
    if (progress === null) close();
  }, [progress, close]);

  const cancelFocusGroup = React.useId();

  // The refusal flash. The root carries `data-refused` and the CSS runs a
  // one-shot fade on it ([L06] appearance through a DOM attribute, [L13]
  // declarative motion in CSS). Removing the attribute and reading `offsetWidth`
  // before re-adding it is what restarts the animation on a SECOND refused
  // press — without the forced reflow the browser coalesces the two writes and
  // the line never moves, which reads as the app ignoring the gesture, the
  // exact failure the flash exists to prevent.
  //
  // Registered on the STORE for as long as this sheet is mounted, rather than
  // filled into a ref the card holds ([B08]). The direction is the same — the
  // card sees the refused door first and speaks through whichever face is up —
  // but the run now has two faces and the folded one is drawn nowhere near
  // here, so the run's own store is the only place both can file.
  // `useLayoutEffect` so the flash is reachable before the browser paints the
  // sheet ([L03]), and the unregister is returned by the registration rather
  // than mirrored elsewhere ([L27]).
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    return compactionProgressStore.registerRefusalNudge(cardId, () => {
      const el = rootRef.current;
      if (el === null) return;
      el.removeAttribute("data-refused");
      void el.offsetWidth;
      el.setAttribute("data-refused", "");
    });
  }, [cardId]);

  // Cancel only while the run is in flight — once it settles there is nothing
  // left to interrupt (the sheet is about to dismiss).
  const cancelable = progress !== null && progress.outcome === null;
  // Seed Cancel as the sheet's live default (filled + double ring) so Return
  // triggers it — only while it is actually shown.
  useSeedKeyView(cancelable ? `${cancelFocusGroup}:0` : null);

  if (progress === null) return null;

  const settled = progress.outcome !== null;

  return (
    <div
      ref={rootRef}
      className="compaction-progress-sheet"
      data-slot="compaction-progress"
    >
      {/* The barber pole — the indeterminate bar. The run is opaque (nothing
          streams until the boundary), so there is no determinate fraction to
          honor and omitting `value` runs the variant's indeterminate motion.
          The sheet title ("Compacting") already names the operation. It is
          also the glyph the folded Z2 row carries, at the row's size, so a
          fold hands the run between its two faces without changing what the
          user is looking at. */}
      <TugProgressIndicator
        variant="bar"
        size={8}
        state={settled ? "completed" : "running"}
        className="compaction-progress-sheet-bar"
        aria-label="Compacting"
      />
      {cancelable ? (
        <div className="tug-sheet-actions">
          {/* The sheet's live default: seeded (see useSeedKeyView above) and
              opted into `persistentDefaultRing` so it wears the filled +
              double-ring default treatment the whole time it is shown, and
              Return triggers it. Cancel is the only action a running
              compaction offers. */}
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            onClick={onCancel}
            data-testid="compaction-cancel"
            focusGroup={cancelFocusGroup}
            focusOrder={0}
            persistentDefaultRing
          >
            Cancel
          </TugPushButton>
        </div>
      ) : null}
      {/* The refusal line, always rendered and at rest invisible — a message
          that mounts on refusal would move the sheet's other rows the moment it
          appeared. `role="status"` is what makes it reach a reader that cannot
          see the flash. */}
      <p
        className="compaction-progress-sheet-refusal"
        role="status"
        data-testid="compaction-refusal"
      >
        {COMPACTION_REFUSAL_TEXT}
      </p>
    </div>
  );
}
