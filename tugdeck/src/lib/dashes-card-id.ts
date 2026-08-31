/**
 * dashes-card-id.ts — the Dashes card's registry id, on its own.
 *
 * The Dashes pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph has to name this
 * constant. A leaf module keeps those module graphs pure — the same reasoning
 * as `jots-card-id.ts`.
 *
 * @module lib/dashes-card-id
 */

/** Registry componentId of the Dashes card. */
export const DASHES_CARD_ID = "dashes";
