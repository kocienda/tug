/**
 * use-miniature-window-drag.ts — sliding the flow window by its frame.
 *
 * When the flow strip is longer than its band, the Layout miniature draws the
 * band as a bracket over the whole strip. The places overlay stands a grip on
 * that bracket's frame, and a drag that starts on it slides the deck's band
 * continuously: the hand's travel across the field is converted to strip
 * pixels (`windowDragOffset`), previewed every frame it changes, and committed
 * once at release. That is the numbered strip's scrub, made continuous rather
 * than slot by slot, and it uses the scrub's two writes for the same reason:
 * per-frame flow appearance has no command to be ([L06]).
 *
 * **The commit lands as a cut.** The deck is already drawn where the hand
 * left it, so the settle must not tween it a second time.
 *
 * **Transitions stay off until the re-pinned bracket has painted.** While
 * dragging, the figure carries `data-window-drag`, which turns off the
 * bracket's and the grip's transitions so they track the hand. The commit
 * re-renders both at the new committed offset with a zero net slide; if their
 * transitions were back on when that render's styles resolve, `left` and
 * `transform` would each tween and only cancel by luck. The re-render does not
 * follow the commit at once: the store tells its `subscribe` listeners one
 * painted frame later ([D204]), and React renders from that notification. So
 * the hook listens for the commit's notification, then lets one frame resolve
 * the re-pinned bracket with transitions still off, and clears the stamp in
 * the frame after — two deferred frames from a notification, not a poll.
 *
 * Laws: [L03] nothing registers outside a layout effect; [L06] the drag's
 * appearance is DOM attributes and the gauge channel; [L07] the gesture is a
 * ref.
 *
 * @module components/layout/use-miniature-window-drag
 */

import type React from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

import { windowDragOffset } from "@/components/layout/miniature-gestures";
import { deckFlowStrip } from "@/deck-store-selectors";
import { getDeckView } from "@/lib/deck-store-registry";
import type { DeckView } from "@/card-deck";

/** A stamp waiting on the commit's notification to come off. */
interface PendingUnstamp {
  figure: HTMLElement;
  frame: number | null;
  unsubscribe: (() => void) | null;
  /** Clears the stamp when no commit came back (a declined one). */
  deadline: ReturnType<typeof setTimeout> | null;
}

/** How long a stamp waits on a commit that has not moved the snapshot. */
export const COMMIT_ANSWER_MS = 1000;

/**
 * Commit `offset` as a cut with `figure` stamped `data-window-drag`, and take
 * the stamp off two frames after the notification that CARRIES the commit
 * (see the module comment) — not after the first notification of any kind:
 * in a card's body the deck is the shell's, the commit comes back with the
 * shell's next context, and other notifications land in between, so a stamp
 * cleared on the first of them is off before the bracket re-pins and the
 * re-pin tweens against the slide it replaces. Subscribed before the commit,
 * so it cannot miss it.
 *
 * A commit that has not moved the snapshot by the time the call returns is
 * declined (it clamped to where the deck already stood, and notifies nobody)
 * or on its way back from the shell; a deadline takes the stamp off if no
 * commit comes, and nothing moves meanwhile either way. `done` hears the
 * record once the stamp is off by either path.
 */
export function commitUnderStamp(
  store: Pick<DeckView, "getSnapshot" | "subscribe" | "setFlowOffset">,
  figure: HTMLElement,
  offset: number,
  done: (pending: PendingUnstamp) => void,
): PendingUnstamp {
  const before = store.getSnapshot().flowOffset;
  const pending: PendingUnstamp = { figure, frame: null, unsubscribe: null, deadline: null };
  pending.unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().flowOffset === before) return;
    pending.unsubscribe?.();
    pending.unsubscribe = null;
    if (pending.deadline !== null) clearTimeout(pending.deadline);
    pending.deadline = null;
    pending.frame = requestAnimationFrame(() => {
      pending.frame = requestAnimationFrame(() => {
        pending.frame = null;
        figure.removeAttribute("data-window-drag");
        done(pending);
      });
    });
  });
  store.setFlowOffset(offset, "cut");
  if (pending.unsubscribe !== null && store.getSnapshot().flowOffset === before) {
    pending.deadline = setTimeout(() => {
      pending.deadline = null;
      pending.unsubscribe?.();
      pending.unsubscribe = null;
      figure.removeAttribute("data-window-drag");
      done(pending);
    }, COMMIT_ANSWER_MS);
  }
  return pending;
}

interface WindowGesture {
  pointerId: number;
  edge: HTMLElement;
  grip: HTMLElement | null;
  figure: HTMLElement | null;
  startX: number;
  startOffset: number;
  fieldWidthPx: number;
  bandPx: number;
  stripWidthPx: number;
  flowScale: number;
  /** The last offset previewed. */
  offset: number;
  detach: () => void;
}

export function useMiniatureWindowDrag(): {
  onWindowPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
} {
  const gesture = useRef<WindowGesture | null>(null);
  const unstamp = useRef<PendingUnstamp | null>(null);

  /** Clear the figure's stamp now, cancelling a pending deferred clear. */
  const clearStamp = useCallback((): void => {
    const pending = unstamp.current;
    if (pending === null) return;
    unstamp.current = null;
    pending.unsubscribe?.();
    if (pending.frame !== null) cancelAnimationFrame(pending.frame);
    if (pending.deadline !== null) clearTimeout(pending.deadline);
    pending.figure.removeAttribute("data-window-drag");
  }, []);

  /** End the drag: commit if it moved, release, and clear the stamps.
   *  Idempotent — the gesture ref is cleared first. */
  const finish = useCallback(
    (deferUnstamp: boolean): void => {
      const current = gesture.current;
      if (current === null) return;
      gesture.current = null;
      current.detach();
      if (current.edge.hasPointerCapture(current.pointerId)) {
        current.edge.releasePointerCapture(current.pointerId);
      }
      current.grip?.removeAttribute("data-dragging");
      const store = getDeckView();
      const moved = current.offset !== current.startOffset && store !== null;
      const figure = current.figure;
      clearStamp();
      if (figure !== null && deferUnstamp && moved) {
        unstamp.current = commitUnderStamp(store, figure, current.offset, (done) => {
          if (unstamp.current === done) unstamp.current = null;
        });
      } else {
        figure?.removeAttribute("data-window-drag");
        if (moved) store.setFlowOffset(current.offset, "cut");
      }
    },
    [clearStamp],
  );

  // A card closed mid-drag commits what the hand reached and leaves no stamp.
  useLayoutEffect(
    () => () => {
      finish(false);
      clearStamp();
    },
    [finish, clearStamp],
  );

  const onWindowPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return;
      const store = getDeckView();
      if (store === null) return;
      const strip = deckFlowStrip(store.getSnapshot());
      const bandPx = store.getBandWidth();
      if (strip === null || bandPx === null || bandPx <= 0) return;
      if (strip.width <= bandPx) return;
      finish(false);
      clearStamp();
      event.preventDefault();

      const edge = event.currentTarget;
      const field = edge.closest<HTMLElement>(".layout-places-field");
      const grip = edge.closest<HTMLElement>(".layout-places-window");
      const figure = edge.closest<HTMLElement>(".layouts-figure");
      const startOffset = store.getSnapshot().flowOffset ?? 0;
      const pointerId = event.pointerId;

      const onMove = (e: PointerEvent): void => {
        const current = gesture.current;
        if (current === null || e.pointerId !== current.pointerId) return;
        const next = windowDragOffset({
          startOffset: current.startOffset,
          dxPx: e.clientX - current.startX,
          fieldWidthPx: current.fieldWidthPx,
          bandPx: current.bandPx,
          stripWidthPx: current.stripWidthPx,
          flowScale: current.flowScale,
        });
        if (next === current.offset) return;
        current.offset = next;
        getDeckView()?.previewFlowOffset(next);
      };
      const onEnd = (e: PointerEvent): void => {
        const current = gesture.current;
        if (current === null || e.pointerId !== current.pointerId) return;
        finish(true);
      };
      edge.addEventListener("pointermove", onMove);
      edge.addEventListener("pointerup", onEnd);
      edge.addEventListener("pointercancel", onEnd);
      edge.addEventListener("lostpointercapture", onEnd);

      gesture.current = {
        pointerId,
        edge,
        grip,
        figure,
        startX: event.clientX,
        startOffset,
        // The field's own width, in the same client pixels the pointer
        // moves in — whatever scale the card is drawn at.
        fieldWidthPx: field?.getBoundingClientRect().width ?? 0,
        bandPx,
        stripWidthPx: strip.width,
        // The window is the band's share of the strip: the geometry's
        // `flow.scale` for an overflowing strip.
        flowScale: bandPx / strip.width,
        offset: startOffset,
        detach: () => {
          edge.removeEventListener("pointermove", onMove);
          edge.removeEventListener("pointerup", onEnd);
          edge.removeEventListener("pointercancel", onEnd);
          edge.removeEventListener("lostpointercapture", onEnd);
        },
      };
      grip?.setAttribute("data-dragging", "");
      figure?.setAttribute("data-window-drag", "");
      edge.setPointerCapture(pointerId);
    },
    [finish, clearStamp],
  );

  return { onWindowPointerDown };
}
