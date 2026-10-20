/**
 * chrome-placement — the facts of a card that draws its pane's chrome in its
 * own page, as every body card does.
 *
 * A card that carries its chrome is one view: its page draws the title bar,
 * the tab bar, the grips and the frame's border, laid out inset by the
 * {@link CARD_APRON_PX} apron, and the host places and moves that view whole.
 * Its pane in the shell is a stand-in: the same `.tug-pane` frame, laid out
 * and read as the arrangement's model, wearing {@link CHROME_IN_BODY_ATTRIBUTE}
 * and painting nothing.
 *
 * @module lib/chrome-placement
 */

/** On a shell pane frame whose active card draws the chrome in its own page: the frame is a stand-in. */
export const CHROME_IN_BODY_ATTRIBUTE = "data-chrome-in-body";

/**
 * How far a card's view reaches past its pane rect on every side: room for
 * the grips' overhang, the frame's shadow and a rail's shadow into its gutter
 * (`rail-shadow.css`'s 10 px reach), which a view sized to the pane rect would
 * clip. Matches `CardGeometry.apron` in the host. A press in the apron is the
 * card's only within `CardGeometry.gripReach` of an edge it grips.
 */
export const CARD_APRON_PX = 10;
