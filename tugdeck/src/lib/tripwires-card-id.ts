/**
 * tripwires-card-id.ts — the Tripwires card's registry id, on its own.
 *
 * The Tripwires pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph has to name this
 * constant. A leaf module keeps those module graphs pure — the same reasoning
 * as `jots-card-id.ts`.
 *
 * @module lib/tripwires-card-id
 */

/** Registry componentId of the Tripwires card. */
export const TRIPWIRES_CARD_ID = "tripwires";
