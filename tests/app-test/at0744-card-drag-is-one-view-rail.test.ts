/**
 * at0744-card-drag-is-one-view-rail.test.ts — a rail card dragged loose by its
 * bar is one view on every frame.
 *
 * One of the at0744-card-drag-is-one-view split, a test to a file so each
 * launch fits its own budget. Why a card is one view, and the shared
 * constants, are `card-drag-is-one-view-fixture.ts`.
 *
 * @visible
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/lib/chrome-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/CardGeometry.swift
 * @family at0744-card-drag-is-one-view
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { kindDeck, standUpKind } from "./body-grounding/_kind-bodies";
import { cardKind } from "./body-grounding/_kinds";
import { expectDragsAsOneView } from "./one-view-drag";
import { SHOULD_RUN, TEST_TIMEOUT_MS, RAIL } from "./card-drag-is-one-view-fixture";

describe.skipIf(!SHOULD_RUN)("at0744: a card is one view", () => {
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
