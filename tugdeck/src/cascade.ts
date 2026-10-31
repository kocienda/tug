/**
 * Cascade positioning: where a new free-floating stack lands on the canvas.
 */

/** Cascade step between consecutive new stacks (pixels) */
const CASCADE_STEP = 30;

/** Where the prime slot sits from the top-left of the room the cascade has (pixels) */
export const CASCADE_ORIGIN = 10;

/** What the deck's standing rails take of the canvas at each side (pixels) */
export interface CascadeInsets {
  left: number;
  right: number;
}

/**
 * The first open cascade slot for a stack of `stackSize`, given the
 * positions the deck's panes already sit at and the canvas's client size.
 * A zero canvas dimension (not yet laid out) reads as 800 × 600. `insets` is
 * what the deck's rails take of the canvas: they stand above every free pane,
 * so the cascade walks the room between them.
 */
export function nextCascadePosition(
  occupied: readonly { x: number; y: number }[],
  canvas: { width: number; height: number },
  stackSize: { width: number; height: number },
  insets: CascadeInsets = { left: 0, right: 0 },
): { x: number; y: number } {
  const canvasWidth = canvas.width || 800;
  const canvasHeight = canvas.height || 600;

  // Classic macOS cascade: there is a prime ("zero") slot near the
  // top-left and a sequence of slots stepping down-and-to-the-right
  // from it. A new card fills the FIRST open slot in that sequence —
  // it does not just keep stepping past freed positions — so closing
  // a card opens its slot for the next one. A slot counts as occupied
  // when an existing pane's top-left sits within CASCADE_SLOP of it,
  // so the match is fuzzy rather than pixel-exact.
  const CASCADE_SLOP = CASCADE_STEP / 2;

  const slotTaken = (x: number, y: number): boolean =>
    occupied.some((p) => Math.abs(p.x - x) < CASCADE_SLOP && Math.abs(p.y - y) < CASCADE_SLOP);

  for (let i = 0; ; i += 1) {
    const x = insets.left + CASCADE_ORIGIN + CASCADE_STEP * i;
    const y = CASCADE_ORIGIN + CASCADE_STEP * i;

    // Walked off the canvas before finding a gap: restart the cascade
    // at the prime slot (the next card sits atop the first one).
    if (x + stackSize.width > canvasWidth - insets.right || y + stackSize.height > canvasHeight) {
      return { x: insets.left + CASCADE_ORIGIN, y: CASCADE_ORIGIN };
    }

    if (!slotTaken(x, y)) {
      return { x, y };
    }
  }
}
