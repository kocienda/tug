/**
 * chrome-placement — how a card's view stands around its pane.
 *
 * Every card draws its pane's chrome in its own page: the title bar, the tab
 * bar, the grips and the frame's border, laid out inset by the
 * {@link CARD_APRON_PX} apron, and the host places and moves that view whole.
 * Its pane in the shell is a stand-in — the `.tug-pane` frame, laid out and
 * read as the arrangement's model, painting nothing ([D216]).
 *
 * @module lib/chrome-placement
 */

/**
 * How far a card's view reaches past its pane rect on every side: room for
 * the grips' overhang, the frame's shadow and a rail's shadow into its gutter
 * (`rail-shadow.css`'s 10 px reach), which a view sized to the pane rect would
 * clip. Matches `CardGeometry.apron` in the host. A press in the apron is the
 * card's only within `CardGeometry.gripReach` of an edge it grips.
 */
export const CARD_APRON_PX = 10;
