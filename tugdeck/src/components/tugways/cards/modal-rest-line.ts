/**
 * modal-rest-line.ts — the one line a Session card's modal surfaces rest on.
 *
 * A modal surface on a Session card rests on the bottom edge of the view slot —
 * the top of the Z2 status bar, or the top of the find bar while the bar is open,
 * since the find bar is a flow sibling between the slot and Z2 — and grows *up*
 * toward the masthead. That is the direction the card's own content moves: a
 * Session card is a transcript, content arrives at the bottom, and a surface that
 * dropped from the pane title bar would grow against the grain of everything
 * behind it. One line for every surface, so no call site has to decide.
 *
 * A few surfaces are exempt, each for a reason of its own:
 *
 * - **The Changes shade** rests on the prompt-entry region instead, because it
 *   *is* the commit surface — the message editor below it belongs to the same
 *   gesture, so it covers Z2 and the beat deliberately.
 * - **Choose Session** keeps the top anchor. It stands where there is no
 *   transcript behind it — the cold-start picker, before a session exists — so
 *   a rise from Z2 would be a motion with nothing to reveal.
 *
 *   The **Compacting** cover stood beside it on that reasoning and no longer
 *   does. A compaction's cover is one FACE of a run whose other face is the
 *   folded card's Z2 row, so the line it rises from is the line the row it
 *   hands the run to stands on, and the motion reveals the handoff rather than
 *   a transcript ([B06] of the compaction-fold-door brief).
 * - **The attachment preview** keeps the top anchor for a reason about its
 *   sizing rather than its geometry: it is the only aspect-locked sheet, so its
 *   only cap is a width cap, and anchoring it makes that cap bind against a box
 *   whose definition belongs to the preview's own sizing contract.
 *
 * A host without a view slot (the settings session card body) matches nothing and
 * falls back to the sheet's default top anchor, which is the right answer there
 * and needs no exception of its own.
 *
 * The doctrine, with the reasoning behind each exemption and the resize-handle
 * mirror a bottom-anchored panel needs, is `tuglaws/modal-rest-line.md`.
 *
 * @module components/tugways/cards/modal-rest-line
 */

/** Selector for the element whose bottom edge a card's modal surfaces rest on. */
export const MODAL_REST_LINE = ".session-view-slot";
