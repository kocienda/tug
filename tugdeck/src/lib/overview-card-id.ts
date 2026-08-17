/**
 * overview-card-id.ts — the Overview card's registry id, on its own.
 *
 * The Overview pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph (the ⌃⌘G handler in
 * `deck-canvas`) has to name this constant. Importing it from
 * `overview-card-registration.tsx` would drag the card's whole component graph
 * into those module graphs; a leaf module keeps them pure — the same reasoning
 * as `jots-card-id.ts`.
 *
 * @module lib/overview-card-id
 */

/** Registry componentId of the Overview card. */
export const OVERVIEW_CARD_ID = "overview";
