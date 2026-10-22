/**
 * _row-02.ts — what the pieces of row 2 share: a card drags as one piece:
 * masthead, frame and content move together under the pointer, and land
 * together.
 *
 * The bar's second row ([B02] row 2). Every card draws its own chrome and is
 * one view the host carries, so a drag is read as the chrome and content
 * standing the chrome's height apart on every frame (`one-view-drag.ts`):
 * pressed by the surface its chrome offers — a content card's grab handle, a
 * rail's whole title bar — carried, held and released, every composited frame
 * judged by surface colour, never ink share ([B05]). The Session card's drag
 * is `at0744-card-drag-is-one-view`; every other kind's is
 * `row-02-drag-kinds`, one launch.
 */

import { launchTugApp } from "../_harness";
import { kindDeck, standUpKind } from "./_kind-bodies";
import type { CardKind } from "./_kinds";
import { expectDragsAsOneView } from "../one-view-drag";

const TEST_NAME = "body-grounding-row-02-drag";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/** Where the title bar is read: below the top corners' radius, above the masthead's text. */
const MASTHEAD_ROW_PX = 14;

/** Launch with a body of `kind` stood up, and drag it by the surface its chrome offers. */
export async function dragKind(kind: CardKind): Promise<void> {
  const card = `row02-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}` });
  try {
    // The card draws its own chrome and travels over bare canvas, which its
    // reading tells it apart from.
    await app.seedDeckState({ state: kindDeck(kind, card), focusCardId: card });
    const body = await standUpKind(app, kind, card);
    await body.waitForCondition<boolean>(`document.querySelector('[data-content-painted]') !== null`, { timeoutMs: 5_000 });
    await expectDragsAsOneView(app, body, {
      card,
      press: kind.rail ? ".tug-pane-title-bar" : ".tug-pane-title-bar .tug-pane-grab-handle",
      chromeRowPx: kind.rail ? 6 : MASTHEAD_ROW_PX,
      reading: kind.rail ? "edges" : "bands",
      standIn: `.tug-pane[data-pane-id="${card}-pane"]`,
    });
  } finally {
    await app.close();
  }
}
