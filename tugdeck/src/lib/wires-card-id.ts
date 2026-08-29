/**
 * wires-card-id.ts — the Wires card's registry id, on its own.
 *
 * A leaf module for the same reason `jots-card-id.ts` is one: the toggle and
 * the action dispatcher need to name this card, and importing it from the
 * registration module would drag the card's whole component graph into theirs.
 *
 * @module lib/wires-card-id
 */

/** Registry componentId of the Wires card. */
export const WIRES_CARD_ID = "wires";
