/**
 * layout-card-id.ts — the Layout card's registry id, on its own.
 *
 * The Layout pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph has to name this
 * constant. A leaf module keeps those module graphs pure — the same reasoning
 * as `jots-card-id.ts`.
 *
 * @module lib/layout-card-id
 */

/** Registry componentId of the Layout card. */
export const LAYOUT_CARD_ID = "layout";
