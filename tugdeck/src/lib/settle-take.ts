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
