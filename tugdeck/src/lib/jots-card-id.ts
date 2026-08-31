/**
 * jots-card-id.ts — the Jots card's registry id, on its own.
 *
 * The Jots pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph has to name this
 * constant. Importing it from `jots-card-registration.tsx` would drag the
 * card's whole component graph into those module graphs; a leaf module keeps
 * them pure — the same reasoning as `cards-card-id.ts`.
 *
 * @module lib/jots-card-id
 */

/** Registry componentId of the Jots card. */
export const JOTS_CARD_ID = "jots";
