/**
 * arcs-card-id.ts — the Arcs card's registry id, on its own.
 *
 * The Arcs pane is identified by the card it hosts rather than by a stored
 * marker field, so code far from the card's React graph has to name this
 * constant. A leaf module keeps those module graphs pure — the same reasoning
 * as `jots-card-id.ts`.
 *
 * @module lib/arcs-card-id
 */

/**
 * Registry componentId of the Arcs card.
 *
 * The tugbank persistence key. It stays `"dashes"` on purpose — [D141] kept it
 * when the title first moved, and the work grammar's read-for-life rule keeps
 * it again: a spelling that reached a durable record stays one. A saved layout
 * names the card by this string, and renaming it would drop every user's rail
 * on first launch. See `tuglaws/work-grammar.md`.
 */
export const ARCS_CARD_ID = "dashes";
