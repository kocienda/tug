/**
 * The shell's answer to "what does this drag indicate?", sent to the overlay
 * to draw ([B08]).
 *
 * Three producers each own their part of it: the canvas's drop-zone host the
 * zone outline, the host-carried gesture the snap guides and the band a
 * ⌘-freed card would merge onto, and a tab dragged past its own bar in a
 * card's page the band and the ghost. Each patches only its own fields, in
 * viewport points, and the whole answer goes as `overlay.indication`, which
 * the overlay draws above every card (`overlay/overlay-indication.ts`).
 * Nothing in it is a moving card's rect: a zone and a band are places, which
 * stand still while the card in hand moves over them, and the ghost is drawn
 * at the pointer.
 *
 * @module lib/drag-indication
 */

import { NO_INDICATION, overlayIndication, type OverlayIndication } from "../bus/declarations/overlay";
import { deepEqual } from "./deep-equal";

let current: OverlayIndication = NO_INDICATION;

/** Change the parts of the indication `patch` names; the rest stand. */
export function indicate(patch: Partial<OverlayIndication>): void {
  const next = { ...current, ...patch };
  if (deepEqual(next, current)) return;
  current = next;
  overlayIndication.set(next);
}

/** What the shell is indicating now. */
export function currentIndication(): OverlayIndication {
  return current;
}
