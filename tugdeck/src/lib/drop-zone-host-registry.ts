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
 */

import type { DropZoneHost } from "./drop-zones";

let dropZoneHostRef: DropZoneHost | null = null;

/** Register the current canvas's drop-zone host; last-wins semantics. */
export function registerDropZoneHost(host: DropZoneHost | null): void {
  dropZoneHostRef = host;
}

/** Read the current canvas's drop-zone host, or `null` when none is mounted. */
export function getDropZoneHost(): DropZoneHost | null {
  return dropZoneHostRef;
}
