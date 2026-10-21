/**
 * at0744-card-drag-is-one-view.test.ts — a card that draws its own chrome is
 * one view: dragged, its chrome and its content never part.
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
 * Two legs: a Session card with a transcript, pressed at its grab handle;
 * and a rail card, Jots, pressed on its bar and dragged loose of its rail.
 *
 * @visible
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/lib/chrome-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/CardGeometry.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";
import { pollFor } from "./body-grounding/_frames";
import { kindDeck, standUpKind } from "./body-grounding/_kind-bodies";
import { cardKind } from "./body-grounding/_kinds";
import { BODY_READY_MS, cardAtRest, sessionPaneDeck, spawnWithTranscript, viewOf } from "./one-view-fixture";
import { expectDragsAsOneView } from "./one-view-drag";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "at0744-a";
const RAIL = "at0744-rail";

describe.skipIf(!SHOULD_RUN)("at0744: a card is one view", () => {
  test(
    "dragged by its title bar, the card's chrome and content stand the chrome's height apart on every frame",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "at0744-drag", visible: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: sessionPaneDeck([A]), focusCardId: A });
        await spawnWithTranscript(app, stubDir, A);
        const placed = await pollFor(() => viewOf(app, A), (v) => v !== null, BODY_READY_MS);
        if (placed === null) {
          // card-dom: shell
          const placer = await app.evalJS<unknown>(`window.tugdeck.diag.getBodyPlacement()?.lastPosted ?? null`);
          note(`never placed visible; host bodies ${JSON.stringify(await app.bodies())}; placer posted ${JSON.stringify(placer)}`);
        }
        expect(placed, "the card's view is placed visible").not.toBeNull();
        const body = await cardAtRest(app, A);
        await expectDragsAsOneView(app, body, {
          card: A,
          press: ".tug-pane-title-bar .tug-pane-grab-handle",
          chromeRowPx: 10,
          reading: "bands",
          standIn: ".tug-pane",
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a rail card dragged loose by its bar is one view on every frame",
    async () => {
      const app = await launchTugApp({ testName: "at0744-rail", visible: true });
      try {
        const jots = cardKind("jots");
        await app.seedDeckState({ state: kindDeck(jots, RAIL), focusCardId: RAIL });
        const body = await standUpKind(app, jots, RAIL);
        await body.waitForCondition<boolean>(`document.querySelector('[data-content-painted]') !== null`, { timeoutMs: 5_000 });
        // A rail's bar and its content paint one surface, so the one piece is
        // read at the card's leading edge, on a row through the bar above its
        // stripes and one through the content.
        await expectDragsAsOneView(app, body, {
          card: RAIL,
          press: ".tug-pane-title-bar",
          chromeRowPx: 6,
          reading: "edges",
          standIn: `.tug-pane[data-pane-id="${RAIL}-pane"]`,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
