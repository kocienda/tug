/**
 * column-badge — what a pane's place badge reads, apart from how it draws.
 *
 * `TugColumnBadge` draws the glyph; the character it carries is also what the
 * pane-chrome projection publishes to a body's chrome, so it lives here,
 * where `lib/` can import it, and the component re-exports it.
 *
 * @module lib/column-badge
 */

/** Which kind of place the badge describes. */
export type TugColumnBadgeKind = "stack" | "split";

/**
 * The character the badge draws: a stack's member count, or a split band's
 * letter counting from A at the topmost band.
 */
export function columnBadgeCharacter(
  kind: TugColumnBadgeKind,
  count: number,
  index = 0,
): string {
  return kind === "stack" ? String(count) : String.fromCharCode(65 + index);
}
