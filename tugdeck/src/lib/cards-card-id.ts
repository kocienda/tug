/**
 * cards-card-id.ts — the Cards card's registry id, on its own.
 *
 * The Cards pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph has to name this
 * constant. A leaf module keeps those module graphs pure — the same reasoning
 * as `jots-card-id.ts`.
 *
 * @module lib/cards-card-id
 */

/** Registry componentId of the Cards card. */
export const CARDS_CARD_ID = "cards";
