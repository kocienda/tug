/**
 * card-drag-is-one-view-fixture.ts — the shared constants the
 * at0744-card-drag-is-one-view-* files drag a card through.
 *
 * A card that draws its own chrome is one view: dragged, its chrome and its
 * content never part.
 *
 * The card's page draws its title bar, its masthead and its content in one
 * layer tree, and the host carries that view under the hand. So the reading
 * is an invariant of the composite, judged by colour (`one-view-drag.ts`):
 * on every captured frame of the drag, the title bar's top (found by the
 * chrome's colour) and the content's top (found by the content surface's
 * colour) stand exactly the chrome's height apart, to within one device
 * pixel. Two renderers drawing the two halves would show that distance
 * stretch and shrink as one lagged the other; one view cannot.
 *
 * Two legs, a file each: a Session card with a transcript, pressed at its grab
 * handle; and a rail card, Jots, pressed on its bar and dragged loose of its
 * rail.
 *
 * @module tests/app-test/card-drag-is-one-view-fixture
 */

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;

export const A = "at0744-a";
export const RAIL = "at0744-rail";
