/**
 * A pointer gesture taking a frame from the settle — the one door a drag or a
 * resize uses at the moment it becomes one.
 *
 * A frame has one owner of its inline `transform` at a time ([L32]). While a
 * settle is carrying it, that owner is the settle's beat; once a drag passes
 * its threshold, it is the drag, which writes the transform every frame. A
 * drag begun on a frame the settle is still moving has to take the frame
 * rather than share it: left alone, the beat's effect sits over the drag's
 * transform until the beat ends, and the beat's landing then takes the
 * drag's transform off, so the pane rides the slide instead of the hand and
 * jumps when the slide lands.
 *
 * So the gesture asks, synchronously, before its first write. The engine
 * cancels whatever it is running on the frame at the pose on screen, hands
 * its holds back, ends its crossing and episode, and notes the frame as taken
 * so nothing that settle still has to do — a later beat's landing, its
 * completion — writes the frame again. `arm` already skips a pointer-owned
 * frame on every later commit.
 *
 * The answer is where the frame stood on screen relative to where the commit
 * put it, in viewport pixels. A drag that measures from the pointer's start
 * adds it, so the pane stays under the hand rather than jumping to the place
 * the slide was taking it. A frame no settle is carrying answers zero.
 *
 * An event rather than a call, dispatched on the frame and heard by the
 * canvas that hosts it, for the reason `settle-notice.ts` gives: the pane
 * has no handle on the engine, and the DOM is the one thing both hold.
 */

/** Dispatched on a pane frame; bubbles to the canvas whose settle carries it. */
export const SETTLE_TAKE_EVENT = "tug-settle-take";

/** Filled in by the engine: the frame's pose on screen less its committed place. */
export interface SettleTakeDetail {
  dx: number;
  dy: number;
}

/** Take `frame` from any settle carrying it, and say how far it stood from its committed place. */
export function takeFrameFromSettle(frame: HTMLElement): SettleTakeDetail {
  const detail: SettleTakeDetail = { dx: 0, dy: 0 };
  frame.dispatchEvent(
    new CustomEvent<SettleTakeDetail>(SETTLE_TAKE_EVENT, {
      detail,
      bubbles: true,
      cancelable: false,
    }),
  );
  return detail;
}

/**
 * Dispatched on the canvas: a hand touching the flow strip while the settle
 * is sliding it.
 *
 * The strip is not one frame but every imposed frame riding one slide, so the
 * frame-by-frame take above would leave the slide's landing — its marks, its
 * settle-end notice, its release — waiting on frames nobody owns any more.
 * This takes the whole slide at once: the engine holds every frame at the
 * pose on screen, lands the settle there as its own completion would, and
 * answers the strip offset that pose is, so the hand's gesture continues
 * from where the eye has the strip rather than from where the slide was
 * taking it.
 */
export const SETTLE_TAKE_FLOW_EVENT = "tug-settle-take-flow";

/** Filled in by the engine: the strip's live offset, or `null` when no flow
 *  slide was running. */
export interface SettleTakeFlowDetail {
  offset: number | null;
}

/** Take the flow strip from a running slide on `canvas`, and say where it stood. */
export function takeFlowFromSettle(canvas: HTMLElement): number | null {
  const detail: SettleTakeFlowDetail = { offset: null };
  canvas.dispatchEvent(
    new CustomEvent<SettleTakeFlowDetail>(SETTLE_TAKE_FLOW_EVENT, {
      detail,
      bubbles: false,
      cancelable: false,
    }),
  );
  return detail.offset;
}
