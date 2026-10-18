/**
 * Process-wide registry for the canvas's `DropZoneHost`.
 *
 * Mirrors `lib/deck-store-registry.ts`'s last-registration-wins singleton so a
 * drag whose hand is not on the canvas — the Layout miniature's — can reach
 * the canvas's zones and commit without threading the host through props or
 * context. `DeckCanvas` registers its host in a layout effect and clears the
 * registration on unmount only if it is still the one registered.
 *
 * Intentionally nullable: a test that mounts no canvas sees `null`, and every
 * consumer must no-op cleanly on it.
 *
 * A page with no canvas — a card's body, where the Layout card's miniature
 * lives under per-card web views — registers a {@link MiniatureDropHost}
 * instead: the miniature's half of the seam, answered by the shell's canvas
 * over the bus (`miniature-relay.ts`). Its enumeration is asynchronous, the
 * one difference the miniature's gesture has to know about.
 *
 * @module lib/drop-zone-host-registry
 */

import type { DropZone, DropZoneHost, DropZoneSet } from "./drop-zones";

let dropZoneHostRef: DropZoneHost | null = null;
let miniatureHostRef: MiniatureDropHost | null = null;

/** Register the current canvas's drop-zone host; last-wins semantics. */
export function registerDropZoneHost(host: DropZoneHost | null): void {
  dropZoneHostRef = host;
}

/** Read the current canvas's drop-zone host, or `null` when none is mounted. */
export function getDropZoneHost(): DropZoneHost | null {
  return dropZoneHostRef;
}

/**
 * The verbs a drag on the Layout miniature uses — {@link DropZoneHost}'s
 * remote half. The canvas's own host is one; a body's relay is another, whose
 * `enumerateRemote` answers later (`null` when the shell could not answer)
 * and whose `commit` hands the zone over, the shell flashing a refusal itself.
 */
export interface MiniatureDropHost {
  enumerateRemote(draggedPaneId: string): DropZoneSet | Promise<DropZoneSet | null>;
  outline(zone: DropZone | null): void;
  carry(kind: "rail" | "card" | null): void;
  commit(zone: DropZone, draggedPaneId: string): boolean;
}

/** Register a page's remote miniature host (a body's relay); last-wins. */
export function registerMiniatureDropHost(host: MiniatureDropHost | null): void {
  miniatureHostRef = host;
}

/** The host a miniature drag uses: this page's canvas when it has one, else
 *  the relay to the shell's, else `null`. */
export function getMiniatureDropHost(): MiniatureDropHost | null {
  return dropZoneHostRef ?? miniatureHostRef;
}
