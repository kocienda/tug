/**
 * chrome-placement — which cards draw their pane's chrome in their own page.
 *
 * A card that carries its chrome is one view: its page draws the title bar,
 * the tab bar, the grips and the frame's border, laid out inset by the
 * {@link CARD_APRON_PX} apron, and the host places and moves that view whole.
 * Its pane in the shell is a stand-in: the same `.tug-pane` frame, laid out
 * and read as the arrangement's model, wearing {@link CHROME_IN_BODY_ATTRIBUTE}
 * and painting nothing.
 *
 * The set is transitional: the Session card, the rail kinds and the document
 * kinds carry their chrome, every other kind follows, and then the predicate
 * goes.
 *
 * @module lib/chrome-placement
 */

/** On a shell pane frame whose active card draws the chrome in its own page: the frame is a stand-in. */
export const CHROME_IN_BODY_ATTRIBUTE = "data-chrome-in-body";

/**
 * How far a card's view reaches past its pane rect on every side: room for
 * the grips' overhang and the frame's shadow, which a view sized to the pane
 * rect would clip. Matches `CardGeometry.apron` in the host.
 */
export const CARD_APRON_PX = 6;

/** The kinds whose cards draw their chrome in their own page. */
const CHROME_IN_BODY_KINDS: ReadonlySet<string> = new Set([
  "session",
  "layout",
  "cards",
  "jots",
  "dashes",
  "overview",
  "text",
  "file-view",
  "diff",
  "commit",
]);

/** Whether a card of `componentId` draws its pane's chrome in its own page. */
export function chromeInBody(componentId: string | null | undefined): boolean {
  return componentId != null && CHROME_IN_BODY_KINDS.has(componentId);
}
