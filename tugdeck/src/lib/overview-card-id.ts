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

/**
 * The route the Overview's prompt history is keyed under.
 *
 * Prompt history keys every row by `(session_id, route)`, and the Overview
 * borrows the machinery whole: its rows carry {@link OVERVIEW_CARD_ID} as a
 * synthetic session id — the ledger takes any string, and nothing on the
 * server requires the id to name a live session — and this route, which is
 * deliberately NOT the Code route `❯`. Two consequences, both wanted: an
 * Overview question is never recalled inside a session, and a query by route
 * finds the Overview corpus on its own.
 */
export const OVERVIEW_HISTORY_ROUTE = "overview";
