/**
 * The shell's half of a body's escaping surface: it hears each body card's
 * `card.surface`, measures where the card rests, and relays the two to the
 * overlay as the card's `overlay.surfaces` entry (`overlay-surfaces.ts`,
 * whose book withholds the entry while the card moves). The overlay draws it
 * (`overlay/overlay-surface-drawer.ts`); the shell draws nothing over a card
 * ([B08]).
 *
 * Dismissal stays where the presses are. A press in the drawn copy, or
 * beside it in the overlay, reaches the overlay, which says so; a press in a
 * card's own page outside its hidden panel is the body's to see, as it always
 * was. What the shell sees is the rest: a press on the canvas, Escape while
 * the shell holds the keyboard, and the keyboard leaving a card for another —
 * each closes the surface the card raised, as a press outside an in-document
 * placard would have.
 *
 * @module lib/surface-relay
 */

import type { CardSurface } from "../bus/declarations/card";
import type { OverlayRect, OverlaySurfaceEntry } from "../bus/declarations/overlay";
import { isCancelChordEvent } from "./keymap-source";
import type { OverlaySurfaceBook } from "./overlay-surfaces";

/** Where a card rests, as an entry's geometry: its content box, its pane, its visible canvas. */
export type RestGeometry = Pick<OverlaySurfaceEntry, "body" | "pane" | "bound">;

export interface SurfaceRelayOptions {
  /** The book the entries are published through. */
  book: OverlaySurfaceBook;
  /** Where `cardId` stands now, or null when it shows nowhere. */
  measure(cardId: string): RestGeometry | null;
  /** Tell `cardId`'s body its surface was dismissed. */
  dismiss(cardId: string): void;
}

export interface SurfaceRelay {
  /** `cardId`'s body raised `surface`, changed it, or (`null`) took it down. */
  set(cardId: string, surface: CardSurface | null): void;
  /** Re-measure every raised surface's card: the deck moved under them. */
  placeAll(): void;
  /** Dismiss every raised surface but `cardId`'s: the keyboard went to that card. */
  dismissAllBut(cardId: string | null): void;
  /** Dismiss `cardId`'s surface: the overlay said a press or Escape there let it go. */
  dismissed(cardId: string): void;
  /** Forget `cardId`: its body is gone. */
  remove(cardId: string): void;
  dispose(): void;
}

/** A DOM rect as an entry's rect. */
export function overlayRectOf(rect: DOMRect): OverlayRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function createSurfaceRelay(options: SurfaceRelayOptions): SurfaceRelay {
  const { book } = options;
  const raised = new Map<string, CardSurface>();
  let listening = false;

  const entryOf = (cardId: string): OverlaySurfaceEntry | null => {
    const surface = raised.get(cardId);
    const where = surface === undefined ? null : options.measure(cardId);
    return surface === undefined || where === null ? null : { surface, ...where };
  };
  const publish = (cardId: string): void => book.publish(cardId, entryOf(cardId));

  const drop = (cardId: string): void => {
    if (!raised.delete(cardId)) return;
    book.publish(cardId, null);
    if (raised.size === 0) unlisten();
  };
  const dismissAll = (): void => {
    for (const cardId of [...raised.keys()]) {
      drop(cardId);
      options.dismiss(cardId);
    }
  };

  const onPointerDown = (): void => dismissAll();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" || isCancelChordEvent(event)) dismissAll();
  };
  const onResize = (): void => relay.placeAll();
  const listen = (): void => {
    if (listening) return;
    listening = true;
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
  };
  const unlisten = (): void => {
    if (!listening) return;
    listening = false;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
  };

  book.setRefresher(entryOf);

  const relay: SurfaceRelay = {
    set(cardId, surface) {
      if (surface === null) {
        drop(cardId);
        return;
      }
      raised.set(cardId, surface);
      listen();
      publish(cardId);
    },
    placeAll() {
      for (const cardId of raised.keys()) publish(cardId);
    },
    dismissAllBut(cardId) {
      for (const raisedId of [...raised.keys()]) {
        if (raisedId === cardId) continue;
        drop(raisedId);
        options.dismiss(raisedId);
      }
    },
    dismissed(cardId) {
      if (!raised.has(cardId)) return;
      drop(cardId);
      options.dismiss(cardId);
    },
    remove(cardId) {
      drop(cardId);
    },
    dispose() {
      for (const cardId of [...raised.keys()]) drop(cardId);
      unlisten();
      book.setRefresher(null);
    },
  };
  return relay;
}
